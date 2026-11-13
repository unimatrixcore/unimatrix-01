"""Scoped, frozen-teacher retention alongside genuine blank-aware CTC targets."""
import copy
import hashlib
import json
from pathlib import Path

import numpy as np
import paddle
import paddle.nn.functional as F
import yaml


def eligible_manifest_labels(manifest):
    """Only original baseline TRAIN positives may supply teacher supervision.

    Canonical named replacements, generated repetitions, blanks and all held-out
    rows deliberately stay outside this set, even if they have baseline aliases.
    """
    manifest = Path(manifest).resolve()
    eligible = {}
    for line in manifest.read_text().splitlines():
        row = json.loads(line)
        if not (row.get('origin') == 'baseline' and row.get('split') == 'train'
                and row.get('optimize') is True and row.get('label')):
            continue
        image = Path(row['image_path'])
        image = (manifest.parent / image).resolve() if not image.is_absolute() else image.resolve()
        if image in eligible and eligible[image] != row['label']:
            raise ValueError('Conflicting eligible labels for one training image')
        eligible[image] = row['label']
    return eligible


class CollectorRetentionMask:
    """Append membership before label encoding; evaluation explicitly disables it."""
    def __init__(self, retention_eligible_manifest, enabled=True, **kwargs):
        self.enabled = enabled
        self.eligible = eligible_manifest_labels(retention_eligible_manifest) if enabled else {}

    def __call__(self, data):
        expected = self.eligible.get(Path(data['img_path']).resolve())
        data['retention_mask'] = np.array(
            int(self.enabled and expected is not None and expected == data['label']), dtype=np.int64)
        return data


def validate_retention_geometry(student, teacher):
    """Fail before building either graph if frozen feature geometry can differ."""
    for key, default in [('collector_pool_width', 1), ('collector_name_high_resolution', False),
                         ('use_space_char', False), ('max_text_length', 25)]:
        if student['Global'].get(key, default) != teacher['Global'].get(key, default):
            raise ValueError(f'Teacher/student {key} mismatch')
    if student['Global'].get('collector_pool_width', 1) != 1:
        raise ValueError('Retention wrapper currently installs width pooling 1 only')
    architectures = [copy.deepcopy(config['Architecture']) for config in (student, teacher)]
    for architecture in architectures:
        architecture['Head'].pop('out_channels', None)
    if architectures[0] != architectures[1]:
        raise ValueError('Teacher/student architecture mismatch')
    for config in (student, teacher):
        shapes = [op['RecResizeImg']['image_shape'] for op in config['Train']['dataset']['transforms']
                  if 'RecResizeImg' in op]
        if len(shapes) != 1:
            raise ValueError('Expected one recorded recognition resize geometry')
        if config is student:
            student_shape = shapes[0]
        elif shapes[0] != student_shape:
            raise ValueError('Teacher/student resize geometry mismatch')
    dictionaries = [Path(config['Global']['character_dict_path']).read_bytes() for config in (student, teacher)]
    if dictionaries[0] != dictionaries[1]:
        raise ValueError('Teacher/student dictionary mismatch')
    return {'dictionary_sha256': hashlib.sha256(dictionaries[0]).hexdigest(),
            'image_shape': student_shape,
            'name_high_resolution': bool(student['Global'].get('collector_name_high_resolution', False)),
            'pool_width': 1}


def teacher_correct_rows(probabilities, labels, lengths):
    """CTC greedy IDs must exactly equal encoded TRAIN targets, with no repairs."""
    paths = probabilities.argmax(axis=-1).numpy()
    targets, lengths = labels.numpy(), lengths.numpy()
    correct = []
    for path, target, length in zip(paths, targets, lengths):
        decoded = [int(token) for index, token in enumerate(path)
                   if token != 0 and (index == 0 or token != path[index - 1])]
        correct.append(decoded == target[:int(length)].tolist())
    return paddle.to_tensor(correct, dtype='float32', place=probabilities.place)


def scoped_retention_kl(student_logits, teacher_probabilities, correct):
    """Only student logits receive gradients; empty approved sets stay finite."""
    target = paddle.clip(teacher_probabilities.detach().astype('float32'), min=1e-7, max=1)
    target = target / target.sum(axis=-1, keepdim=True)
    per_row = F.kl_div(F.log_softmax(student_logits.astype('float32'), axis=-1),
                      target, reduction='none').sum(axis=-1).mean(axis=-1)
    return (per_row * correct).sum() / paddle.clip(correct.sum(), min=1)


def install_positive_retention(checkpoint, config_path, weight, student_config=None,
                               eligible_manifest=None):
    import ppocr.losses as losses
    from negative_ctc_policy import CollectorBlankCTCLoss
    import ppocr.modeling.architectures as architectures
    import ppocr.data.imaug as imaug
    from ppocr.postprocess import build_post_process

    if weight < 0 or not np.isfinite(weight):
        raise ValueError('Retention weight must be finite and nonnegative')
    config = yaml.safe_load(Path(config_path).read_text())
    geometry = validate_retention_geometry(student_config or config, config)
    imaug.CollectorRetentionMask = CollectorRetentionMask
    build_model, original = architectures.build_model, losses.build_loss
    shared = {'eligible_rows_seen': 0, 'teacher_correct_rows_seen': 0, 'batches': 0,
              'scoped': eligible_manifest is not None, 'geometry': geometry,
              'teacher_checkpoint_sha256': hashlib.sha256(Path(checkpoint).read_bytes()).hexdigest()}
    if eligible_manifest:
        eligible_manifest = Path(eligible_manifest).resolve()
        shared['eligible_manifest_sha256'] = hashlib.sha256(eligible_manifest.read_bytes()).hexdigest()
        # The CLI manifest must be exactly the one bound to the train transform.
        transforms = (student_config or config)['Train']['dataset']['transforms']
        masks = [op['CollectorRetentionMask'] for op in transforms if 'CollectorRetentionMask' in op]
        if len(masks) != 1 or not masks[0].get('enabled', True) or Path(masks[0]['retention_eligible_manifest']).resolve() != eligible_manifest:
            raise ValueError('Training transform must bind the CLI retention manifest')
        keys = [op['KeepKeys']['keep_keys'] for op in transforms if 'KeepKeys' in op]
        if keys != [['image', 'label', 'length', 'retention_mask']]:
            raise ValueError('Scoped retention requires mask at batch index 3')
        eval_transforms = (student_config or config)['Eval']['dataset']['transforms']
        eval_masks = [op['CollectorRetentionMask'] for op in eval_transforms if 'CollectorRetentionMask' in op]
        if len(eval_masks) != 1 or eval_masks[0].get('enabled') is not False:
            raise ValueError('Evaluation must disable retention eligibility')

    def capture_student(architecture):
        model = build_model(architecture)
        if 'student' not in shared:
            shared['student'] = model
            def capture(layer, inputs, output):
                shared['features'] = output.detach()
            model.backbone.register_forward_post_hook(capture)
        return model
    architectures.build_model = capture_student

    class CollectorRetentionCTCLoss(paddle.nn.Layer):
        def __init__(self):
            super().__init__()
            self.ctc, self.weight = CollectorBlankCTCLoss(), weight
            architecture = copy.deepcopy(config['Architecture'])
            decoder = build_post_process(copy.deepcopy(config['PostProcess']), config['Global'])
            architecture['Head']['out_channels'] = len(decoder.character)
            self.teacher = build_model(architecture)
            state = paddle.load(str(checkpoint))
            if set(state) != set(self.teacher.state_dict()):
                raise ValueError('Teacher checkpoint parameter keys differ')
            self.teacher.set_state_dict(state)
            for parameter in self.teacher.parameters():
                parameter.stop_gradient = True
            self.teacher.eval()
            self.checked_backbone = False

        def forward(self, predicts, batch):
            if isinstance(predicts, (list, tuple)):
                predicts = predicts[-1]
            ctc = self.ctc(predicts, batch)['loss']
            if not self.checked_backbone:
                student_model = shared['student']
                student, teacher = student_model.backbone.state_dict(), self.teacher.backbone.state_dict()
                if set(student) != set(teacher) or not all(np.array_equal(student[key].numpy(), teacher[key].numpy()) for key in student):
                    raise ValueError('Shared frozen backbone differs from retention teacher')
                if not all(parameter.stop_gradient for parameter in student_model.backbone.parameters()):
                    raise ValueError('Student shared backbone must be frozen')
                self.checked_backbone = True
                shared['backbone_identical_and_frozen'] = True
            eligible = batch[2] > 0
            if eligible_manifest:
                eligible = eligible & (batch[3] > 0)
            indices = paddle.nonzero(eligible).flatten()
            retention = predicts.astype('float32').sum() * 0
            correct_count = 0
            if indices.shape[0]:
                with paddle.no_grad(), paddle.amp.auto_cast(enable=False):
                    self.teacher.eval()
                    features = paddle.index_select(shared['features'], indices, axis=0).astype('float32')
                    if not features.stop_gradient:
                        raise ValueError('Teacher features must be detached')
                    teacher = self.teacher.head(self.teacher.neck(features)).astype('float32')
                    correct = teacher_correct_rows(teacher, paddle.index_select(batch[1], indices),
                                                   paddle.index_select(batch[2], indices))
                correct_count = int(correct.sum().item())
                retention = scoped_retention_kl(paddle.index_select(predicts, indices), teacher, correct)
            shared['eligible_rows_seen'] += int(indices.shape[0])
            shared['teacher_correct_rows_seen'] += correct_count
            shared['batches'] += 1
            total = ctc + self.weight * retention
            if not bool(paddle.isfinite(total).item()):
                raise ValueError('Nonfinite native/retention loss')
            if shared['batches'] == 1:
                print('SCOPED RETENTION first batch:', json.dumps({key: value for key, value in shared.items()
                      if key not in ('student', 'features')}), flush=True)
            return {'loss': total, 'ctc_loss': ctc, 'positive_retention_loss': retention,
                    'retention_eligible_count': paddle.to_tensor(float(indices.shape[0])),
                    'retention_correct_count': paddle.to_tensor(float(correct_count))}

    def build(loss_config):
        if loss_config['name'] == 'CollectorRetentionCTCLoss':
            return CollectorRetentionCTCLoss()
        return original(loss_config)
    losses.build_loss = build
    return shared
