"""Validate checkpoint triplets and frozen inputs before continuing a job."""
import hashlib
import json
from pathlib import Path
import pickle


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def select_checkpoint(bundle, role, epochs):
    directory = Path(bundle) / role / 'checkpoints'
    candidates = [directory / 'latest'] + [path.with_suffix('') for path in directory.glob('iter_epoch_*.states')]
    valid = []
    for prefix in candidates:
        paths = {suffix: Path(str(prefix) + suffix) for suffix in ('.pdparams', '.pdopt', '.states')}
        if not all(path.is_file() and not path.is_symlink() for path in paths.values()):
            continue
        if paths['.states'].stat().st_size > 1_048_576:
            raise ValueError('Checkpoint state exceeds its size bound')
        state = pickle.loads(paths['.states'].read_bytes())
        epoch, step = state.get('epoch'), state.get('global_step')
        if type(epoch) is not int or type(step) is not int or not 0 <= epoch <= epochs or step < 0:
            raise ValueError('Checkpoint epoch or step is invalid')
        valid.append({'prefix': str(prefix), 'epoch': epoch, 'global_step': step,
                      'sha256': {suffix: digest(path) for suffix, path in paths.items()}})
    if not valid:
        if any(directory.glob('*.states')) or (directory / 'latest.pdparams').exists():
            raise ValueError('No complete model, optimizer, and epoch checkpoint can be resumed')
        return None
    return max(valid, key=lambda value: (value['epoch'], value['global_step'], value['prefix'].endswith('latest')))


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
