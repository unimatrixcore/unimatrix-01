"""Validate checkpoint triplets and frozen inputs before continuing a job."""
import hashlib
import importlib
import inspect
import json
from pathlib import Path
from functools import wraps


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


SUFFIXES = ('.pdparams', '.pdopt', '.states')


def publish_checkpoint(prefix, state):
    prefix = Path(prefix)
    epoch, step = state.get('epoch'), state.get('global_step')
    if type(epoch) is not int or type(step) is not int or epoch < 0 or step < 0:
        raise ValueError('Completed checkpoint epoch or step is invalid')
    paths = {suffix: Path(str(prefix) + suffix) for suffix in SUFFIXES}
    if not all(path.is_file() and not path.is_symlink() for path in paths.values()):
        raise ValueError('Completed checkpoint is missing its model, optimizer, or state')
    receipt = {'version': 1, 'epoch': epoch, 'global_step': step,
               'sha256': {suffix: digest(path) for suffix, path in paths.items()}}
    path = Path(str(prefix) + '.resume.json')
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(receipt) + '\n')
    temporary.replace(path)


def install_checkpoint_receipts(loader_module=None):
    if loader_module is None:
        loader_module = importlib.import_module('ppocr.utils.save_load')
    original = getattr(loader_module.save_model, '_collector_save_original', loader_module.save_model)
    signature = inspect.signature(original)

    @wraps(original)
    def save_model(*args, **kwargs):
        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        prefix = Path(bound.arguments['model_path']) / bound.arguments['prefix']
        # Invalidate the previous save before the upstream sequential writes begin.
        Path(str(prefix) + '.resume.json').unlink(missing_ok=True)
        result = original(*args, **kwargs)
        publish_checkpoint(prefix, bound.arguments.get('kwargs', {}))
        return result

    save_model._collector_save_original = original
    loader_module.save_model = save_model


def select_checkpoint(bundle, role, epochs):
    root = Path(bundle).resolve()
    directory = root / role / 'checkpoints'
    if directory.is_symlink() or not directory.resolve().is_relative_to(root):
        raise ValueError('Checkpoint directory escapes its frozen bundle')
    candidates = [directory / 'latest'] + [path.with_suffix('') for path in directory.glob('iter_epoch_*.states')]
    valid = []
    failures = []
    for prefix in candidates:
        try:
            paths = {suffix: Path(str(prefix) + suffix) for suffix in SUFFIXES}
            if not all(path.is_file() and not path.is_symlink() for path in paths.values()):
                raise ValueError('incomplete checkpoint triplet')
            if paths['.states'].stat().st_size > 1_048_576:
                raise ValueError('checkpoint state exceeds its size bound')
            path = Path(str(prefix) + '.resume.json')
            if not path.is_file() or path.is_symlink() or path.stat().st_size > 16_384:
                raise ValueError('missing or invalid completed-save receipt; legacy checkpoints cannot prove triplet integrity')
            receipt = json.loads(path.read_text())
            epoch, step = receipt.get('epoch'), receipt.get('global_step')
            if receipt.get('version') != 1 or type(epoch) is not int or type(step) is not int or not 0 <= epoch <= epochs or step < 0:
                raise ValueError('checkpoint receipt epoch or step is invalid')
            hashes = {suffix: digest(value) for suffix, value in paths.items()}
            if hashes != receipt.get('sha256'):
                raise ValueError('checkpoint triplet differs from its completed-save receipt')
            valid.append({'prefix': str(prefix), 'epoch': epoch, 'global_step': step,
                          'sha256': hashes, 'receipt_sha256': digest(path)})
        except (OSError, ValueError, TypeError, AttributeError) as error:
            failures.append({'checkpoint': prefix.name, 'reason': str(error)})
    if not valid:
        if any(directory.glob('*.states')) or (directory / 'latest.pdparams').exists():
            raise ValueError('No complete model, optimizer, and epoch checkpoint can be resumed: ' + json.dumps(failures))
        return None
    selected = max(valid, key=lambda value: (value['epoch'], value['global_step'], value['prefix'].endswith('latest')))
    selected['rejected_candidates'] = failures
    return selected


def completed_role(bundle, role):
    directory = Path(bundle) / role
    path = directory / 'training-status.json'
    if not path.is_file():
        return False
    status = json.loads(path.read_text())
    if status.get('state') != 'completed':
        return False
    checkpoint = directory / 'checkpoints/best_accuracy.pdparams'
    if not checkpoint.is_file() or digest(checkpoint) != status.get('selected_checkpoint_sha256'):
        raise ValueError(f'The completed {role} checkpoint changed')
    if status.get('audit_sha256') != digest(Path(bundle) / 'audit.json'):
        raise ValueError(f'The completed {role} job belongs to a different data audit')
    return True


def validate_bundle(bundle):
    bundle = Path(bundle).resolve()
    audit = json.loads((bundle / 'audit.json').read_text())
    for name, key in [('manifest.jsonl', 'manifest_sha256'), ('dictionary.txt', 'dictionary_sha256')]:
        if digest(bundle / name) != audit.get(key):
            raise ValueError(f'The frozen {name} changed; this run cannot be resumed')
    for line in (bundle / 'manifest.jsonl').read_text().splitlines():
        row = json.loads(line)
        path = (bundle / row['image_path']).resolve()
        if not path.is_relative_to(bundle / 'images') or digest(path) != row['file_sha256']:
            raise ValueError('A frozen training or held-out image changed')
    return audit
