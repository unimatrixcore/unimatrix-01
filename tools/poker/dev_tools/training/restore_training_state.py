"""Restore counters and best metrics from an explicitly selected local checkpoint."""
from copy import deepcopy
from functools import wraps
import importlib
from pathlib import Path
import pickle


def install_resume_state(path, loader_module=None):
    path = Path(path).resolve()
    if path.suffix != '.states':
        raise ValueError('Resume metadata must be a checkpoint .states file')
    with path.open('rb') as stream:
        state = pickle.load(stream, encoding='latin1')
    if not isinstance(state, dict) or not isinstance(state.get('best_model_dict'), dict):
        raise ValueError('Resume metadata must contain the recorded best model metrics')
    for name in ('epoch', 'global_step'):
        value = state.get(name)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f'Resume metadata has an invalid {name}')
    metrics = deepcopy(state['best_model_dict'])
    checkpoint = path.with_suffix('')
    if loader_module is None:
        loader_module = importlib.import_module('ppocr.utils.save_load')
    original = loader_module.load_model.__dict__.get('_collector_resume_original', loader_module.load_model)

    @wraps(original)
    def load_model(config, *args, **kwargs):
        requested = config['Global'].get('checkpoints')
        if not requested:
            return original(config, *args, **kwargs)
        requested = Path(requested)
        if requested.suffix == '.pdparams':
            requested = requested.with_suffix('')
        if requested.resolve() != checkpoint:
            raise ValueError('The requested weights do not match the explicit resume metadata')
        result = original(config, *args, **kwargs)
        if not isinstance(result, dict):
            raise ValueError('The checkpoint loader did not return training metadata')
        restored = {**result, **deepcopy(metrics), 'global_step': state['global_step'],
                    'start_epoch': state['epoch'] + 1}
        print(f"RESUME STATE: epoch={restored['start_epoch']} global_step={restored['global_step']} best_acc={restored.get('acc')}", flush=True)
        return restored

    load_model._collector_resume_original = original
    loader_module.load_model = load_model
    return {'checkpoint': str(checkpoint), 'global_step': state['global_step'],
            'start_epoch': state['epoch'] + 1}
