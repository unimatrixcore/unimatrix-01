"""Supervise isolated OCR candidates across the desktop and SSH training host."""
import argparse
import hashlib
import io
import pickle
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

TOOLS = Path(__file__).resolve().parent
REMOTE_HOST = 'unimatrix-01'
GPU_PROBE = '''import json,paddle,subprocess
paddle.set_device('gpu:0')
value=paddle.ones([1]).numpy().tolist()
record={'paddle':paddle.__version__,'device':paddle.get_device(),'result':value,'gpu':paddle.device.cuda.get_device_name(0)}
try:
 values=subprocess.check_output(['nvidia-smi','--query-gpu=memory.total,memory.used,utilization.gpu','--format=csv,noheader,nounits'],text=True,timeout=5).splitlines()[0].split(',')
 record.update(memory_total_mb=int(values[0]),memory_used_mb=int(values[1]),utilization=int(values[2]))
except (OSError,ValueError,subprocess.SubprocessError): pass
print(json.dumps(record))
'''
PROGRESS_PREFIX = 'POKER_TRAINING_PROGRESS '


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def retain_analysis_report(run):
    for directory, keep in ((run / 'bundle', {'audit.json', 'quarantined.jsonl'}),
                            (run / 'collections', {'summary.json', 'exact_pixel_conflicts.jsonl'})):
        if not directory.is_dir():
            continue
        for path in directory.iterdir():
            if path.name in keep:
                continue
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()


def ssh_args():
    args = ['ssh']
    config = Path.home() / '.ssh/config'
    if config.is_file():
        args += ['-F', str(config)]
    return args + ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                   '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3']


def remote_command(args):
    return ssh_args() + [REMOTE_HOST, shlex.join([str(arg) for arg in args])]


def command(args, log, *, timeout=None):
    with log.open('ab') as output:
        result = subprocess.run([str(arg) for arg in args], stdin=subprocess.DEVNULL,
                                stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        tail = log.read_bytes()[-6000:].decode(errors='replace')
        raise RuntimeError(f'{Path(str(args[0])).name} failed ({result.returncode}): {tail}')


def probe_remote(log):
    # Ask the remote user's home and environment; no local home path crosses SSH.
    script = '''import json, pathlib, subprocess
h=pathlib.Path.home()
roots=[h/'.local/share/poker/ocr-training',h/'unimatrix-01/node_modules/.cache/poker-ocr-training']
for root in roots:
 for name in ('desktop-train-gpu','paddle-gpu-venv'):
  python=root/name/'bin/python'
  sources=[root/'desktop-training/paddle-training-source',root/'paddle-training-source']
  source=next((p for p in sources if (p/'tools/train.py').is_file()),None)
  if python.is_file() and source:
   result=subprocess.run([str(python),'-c',PROBE],capture_output=True,text=True,timeout=60)
   if result.returncode: raise RuntimeError(result.stderr[-4000:])
   print(json.dumps({'root':str(root),'python':str(python),'source':str(source),'gpu':json.loads(result.stdout.splitlines()[-1])}))
   raise SystemExit(0)
raise RuntimeError('Restore the existing Paddle GPU environment and training source on unimatrix-01')
'''.replace('PROBE', repr(GPU_PROBE))
    result = subprocess.run(remote_command(['python3', '-c', script]), capture_output=True,
                            text=True, timeout=90)
    log.write_text(result.stderr)
    if result.returncode:
        raise RuntimeError('Cannot use unimatrix-01 GPU. Check SSH access and its Paddle environment: ' + result.stderr[-4000:])
    record = json.loads(result.stdout.splitlines()[-1])
    for key in ('root', 'python', 'source'):
        if not Path(record[key]).is_absolute() or '\n' in record[key]:
            raise ValueError('Remote setup returned an invalid path')
    return record


def probe_devices(root):
    root = Path(root)
    devices = []
    python = root / 'desktop-train-gpu/bin/python'
    try:
        result = subprocess.run([str(python), '-c', GPU_PROBE], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError(result.stderr[-2000:])
        local = json.loads(result.stdout.splitlines()[-1])
        devices.append({'host': 'local', 'ready': True, **local})
    except Exception as error:
        devices.append({'host': 'local', 'ready': False, 'gpu': None, 'error': str(error)[-2000:]})
    try:
        remote = probe_remote(root / 'gpu-probe.log')
        devices.append({'host': REMOTE_HOST, 'ready': True, **remote['gpu']})
    except Exception as error:
        devices.append({'host': REMOTE_HOST, 'ready': False, 'gpu': None, 'error': str(error)[-2000:]})
    record = {'checked_at': int(time.time() * 1000), 'devices': devices}
    atomic_json(root / 'gpu-status.json', record)
    return record


def tail(path, limit=32768):
    try:
        with Path(path).open('rb') as stream:
            stream.seek(0, 2)
            stream.seek(max(0, stream.tell() - limit))
            return stream.read(limit).decode(errors='replace')
    except FileNotFoundError:
        return ''


def training_progress(log, role, host, started):
    value = {'role': role, 'host': host, 'state': 'initializing',
             'elapsed_seconds': max(0, time.time() - started), 'updated_at': int(time.time() * 1000)}
    records = list(re.finditer(r'epoch: \[(\d+)/(\d+)\], global_step: (\d+),.*?loss: ([0-9.eE+\-]+)', log))
    if records:
        epoch, epochs, step, loss = records[-1].groups()
        if math.isfinite(float(loss)):
            value.update(state='training', epoch=int(epoch), epochs=int(epochs), step=int(step), loss=float(loss))
    etas = re.findall(r'eta: (\d+):(\d+):(\d+)', log)
    if etas:
        hours, minutes, seconds = map(int, etas[-1])
        value['eta_seconds'] = hours * 3600 + minutes * 60 + seconds
    return value


def read_progress(log, previous, offset=0):
    if offset:
        with Path(log).open('rb') as stream:
            stream.seek(0, 2)
            stream.seek(max(offset, stream.tell() - 32768))
            content = stream.read().decode(errors='replace')
    else:
        content = tail(log)
    for line in reversed(content.splitlines()):
        if line.startswith(PROGRESS_PREFIX):
            try:
                value = json.loads(line[len(PROGRESS_PREFIX):])
                if value.get('role') in ('general', 'names'):
                    return value
            except (ValueError, TypeError):
                pass
    return previous


def training_failure(run):
    for role in ('general', 'names'):
        lines = tail(Path(run) / 'bundle' / role / 'training.log').splitlines()
        errors = [line for line in lines if re.match(r'^\w*(?:Error|Exception):', line)]
        if errors:
            return f'{role.title()} training failed: {errors[-1][-1200:]}'
    return 'Training failed; inspect the retained model logs'


def relocate_bundle(bundle, original):
    """Rewrite generated recipe paths without changing image bytes or provenance."""
    import yaml
    bundle = Path(bundle).resolve()
    def relocate(value):
        if isinstance(value, str) and (value == original or value.startswith(original + '/')):
            return str(bundle) + value[len(original):]
        if isinstance(value, list):
            return [relocate(item) for item in value]
        if isinstance(value, dict):
            return {key: relocate(item) for key, item in value.items()}
        return value
    paths = [bundle / role / 'train.yml' for role in ('general', 'names')]
    paths += sorted((bundle / 'stages').glob('*/train.yml'))
    for path in paths:
        if not path.is_file():
            continue
        config = yaml.safe_load(path.read_text())
        path.write_text(yaml.safe_dump(relocate(config), sort_keys=False))
        for split in ('train', 'val', 'test'):
            labels = path.parent / (split + '.txt')
            if not labels.is_file():
                continue
            lines = []
            for line in labels.read_text().splitlines():
                image, label = line.split('\t', 1)
                lines.append(relocate(image) + '\t' + label + '\n')
            labels.write_text(''.join(lines))
    manifest = bundle / 'curriculum.json'
    if manifest.is_file():
        atomic_json(manifest, relocate(json.loads(manifest.read_text())))


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _portable(value, bundle):
    prefix = str(Path(bundle).resolve())
    if isinstance(value, str):
        return value.replace(prefix + '/', '<BUNDLE>/') if value != prefix else '<BUNDLE>'
    if isinstance(value, dict):
        return {key: _portable(item, bundle) for key, item in value.items()}
    if isinstance(value, list):
        return [_portable(item, bundle) for item in value]
    return value


def stage_directory(bundle, stage):
    directory = Path(stage['directory']).resolve()
    if not directory.is_relative_to(Path(bundle).resolve()) or directory.is_symlink():
        raise ValueError('Curriculum stage escapes its frozen bundle')
    return directory


def stage_signature(bundle, stage):
    import yaml
    directory = stage_directory(bundle, stage)
    config = yaml.safe_load((directory / 'train.yml').read_text())
    inputs = {'stage': {key: value for key, value in stage.items() if key != 'signature'},
              'config': config, 'lists': {split: (directory / (split + '.txt')).read_text()
                                        for split in ('train', 'val')}}
    return hashlib.sha256(json.dumps(_portable(inputs, bundle), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def curriculum_record(bundle):
    path = Path(bundle) / 'curriculum.json'
    value = json.loads(path.read_text())
    stages = value.get('stages')
    if value.get('schema_version') != 1 or not isinstance(stages, list) or not stages:
        raise ValueError('Unsupported training curriculum')
    ids = [stage.get('id') for stage in stages]
    if ids not in (['base', 'general', 'names-base', 'names'], ['base', 'general']):
        raise ValueError('Training curriculum has an unexpected dependency graph')
    expected = {'base': (None, 'general'), 'general': ('base', 'general'),
                'names-base': ('base', 'names'), 'names': ('names-base', 'names')}
    for stage in stages:
        if (stage.get('depends_on'), stage.get('role')) != expected[stage['id']]:
            raise ValueError('Training curriculum mixes model dependencies')
        stage_directory(bundle, stage)
    return value


def curriculum_sha(bundle, curriculum):
    return hashlib.sha256(json.dumps(_portable(curriculum, bundle), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def seal_curriculum(bundle):
    bundle = Path(bundle)
    curriculum = curriculum_record(bundle)
    if any(stage.get('signature') for stage in curriculum['stages']):
        validate_curriculum(bundle)
        return curriculum
    if any((stage_directory(bundle, stage) / 'training-status.json').exists() for stage in curriculum['stages']):
        raise ValueError('An executed curriculum cannot be sealed retroactively')
    for stage in curriculum['stages']:
        stage['signature'] = stage_signature(bundle, stage)
    atomic_json(bundle / 'curriculum.json', curriculum)
    audit = json.loads((bundle / 'audit.json').read_text())
    audit['curriculum_sha256'] = curriculum_sha(bundle, curriculum)
    atomic_json(bundle / 'audit.json', audit)
    return curriculum


def validate_curriculum(bundle):
    curriculum = curriculum_record(bundle)
    audit = json.loads((Path(bundle) / 'audit.json').read_text())
    if audit.get('training_ready') is not True or audit.get('curriculum_sha256') != curriculum_sha(bundle, curriculum):
        raise ValueError('Training curriculum differs from its frozen data audit')
    for stage in curriculum['stages']:
        if stage.get('signature') != stage_signature(bundle, stage):
            raise ValueError('Training stage recipe or labels changed')
    return curriculum


def completed_stage(bundle, stage):
    directory = stage_directory(bundle, stage)
    path = directory / 'training-status.json'
    if not path.is_file():
        return False
    status = json.loads(path.read_text())
    if status.get('state') != 'completed':
        return False
    if (status.get('stage_signature') != stage['signature']
            or status.get('audit_sha256') != file_sha(Path(bundle) / 'audit.json')
            or status.get('selected_checkpoint_sha256') != file_sha(directory / 'checkpoints/best_accuracy.pdparams')
            or status.get('checkpoint_sha256') != file_sha(stage['checkpoint_source'])):
        raise ValueError('A completed curriculum stage or its dependency changed')
    return True


def execute_stage(bundle, stage_id, source, resume=False):
    import yaml
    bundle = Path(bundle).resolve()
    curriculum = validate_curriculum(bundle)
    stages = {stage['id']: stage for stage in curriculum['stages']}
    stage = stages[stage_id]
    directory = stage_directory(bundle, stage)
    config = yaml.safe_load((directory / 'train.yml').read_text())
    audit = json.loads((bundle / 'audit.json').read_text())
    initial = Path(stage['checkpoint_source']).resolve()
    if not initial.is_relative_to(bundle) or initial.is_symlink():
        raise ValueError('Stage initialization must be a frozen checkpoint in this version')
    if stage['depends_on']:
        parent = stages[stage['depends_on']]
        if initial != stage_directory(bundle, parent) / 'checkpoints/best_accuracy.pdparams' or not completed_stage(bundle, parent):
            raise ValueError('Stage dependency has not completed with verified weights')
    elif not initial.is_file() or file_sha(initial) != audit['general']['starting_checkpoint_sha256']:
        raise ValueError('Shared base must start from the original audited initialization')
    if (config['Global'].get('use_gpu') is not True or config['Global'].get('distributed') is not False
            or config['Global']['epoch_num'] != stage['epochs']
            or config['Optimizer']['lr']['learning_rate'] != stage['learning_rate']
            or Path(config['Global']['pretrained_model']).resolve() != initial
            or Path(config['Global']['save_model_dir']).resolve() != directory / 'checkpoints'
            or bool(config['Global'].get('collector_name_high_resolution')) != (stage['role'] == 'names')
            or config['Loss']['name'] != 'CollectorBlankCTCLoss'
            or config['Metric'].get('ignore_space') is not False):
        raise ValueError('Stage recipe violates its audited model or optimization policy')
    counts, lists, blanks = {}, {}, {}
    for split, section, expected_count in [('train', 'Train', stage['train_count']), ('val', 'Eval', stage['validation_count'])]:
        labels = config[section]['dataset']['label_file_list']
        if labels != [str(directory / (split + '.txt'))] or config[section]['loader']['shuffle'] is not (split == 'train'):
            raise ValueError('Stage must use its fixed audited lists and shuffle only training')
        lines = Path(labels[0]).read_text().splitlines()
        if len(lines) != expected_count:
            raise ValueError('Stage sample count differs from its curriculum')
        negative = 0
        for line in lines:
            image, label = line.split('\t', 1)
            path = Path(image).resolve()
            if not path.is_relative_to(bundle / 'images') or not path.is_file() or path.is_symlink() or file_sha(path) != path.stem:
                raise ValueError('Stage image changed or escaped its frozen content-addressed store')
            negative += not label
        counts[split], lists[split], blanks[split] = len(lines), file_sha(labels[0]), negative
    if stage['role'] == 'names' and not blanks['train']:
        raise ValueError('Name stages require verified blank controls')
    if completed_stage(bundle, stage):
        return
    checkpoint = None
    status_path = directory / 'training-status.json'
    if resume:
        from checkpoint_resume import select_checkpoint
        prior = json.loads(status_path.read_text()) if status_path.is_file() else None
        if prior and (prior.get('stage_signature') != stage['signature'] or prior.get('checkpoint_sha256') != file_sha(initial)):
            raise ValueError('An interrupted stage has different inputs or dependency weights')
        checkpoint = select_checkpoint(bundle, str(directory.relative_to(bundle)), stage['epochs'])
    args = [sys.executable, str(TOOLS / 'run_negative_ocr.py'), '--source', str(source), '--mode', 'train']
    if stage['role'] == 'names':
        args.append('--name-high-resolution')
    args += ['-c', str(directory / 'train.yml')]
    if checkpoint:
        args += ['--resume-state', checkpoint['prefix'] + '.states', '-o', 'Global.checkpoints=' + checkpoint['prefix']]
    status = {'role': stage['role'], 'stage': stage_id, 'stage_signature': stage['signature'],
              'audit_sha256': file_sha(bundle / 'audit.json'), 'config_sha256': file_sha(directory / 'train.yml'),
              'checkpoint_sha256': file_sha(initial), 'counts': counts, 'lists_sha256': lists,
              'blank_counts': blanks, 'resume': checkpoint, 'command': args, 'runtime_model_replaced': False,
              'implementation_sha256': {name: file_sha(TOOLS / name) for name in
                  ('run_negative_ocr.py', 'compact_ocr_policy.py', 'negative_ctc_policy.py', 'name_resolution_policy.py', 'checkpoint_resume.py')
                  if (TOOLS / name).is_file()},
              'state': 'running', 'started_at': time.time(), 'supervisor_pid': os.getpid()}
    if status_path.is_file():
        history = directory / 'attempts'
        history.mkdir(exist_ok=True)
        shutil.copyfile(status_path, history / (str(time.time_ns()) + '.json'))
    atomic_json(status_path, status)
    with (directory / 'training.log').open('ab') as log:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
    selected = directory / 'checkpoints/best_accuracy.pdparams'
    status.update(state='completed' if result.returncode == 0 and selected.is_file() else 'failed',
                  exit_code=result.returncode, finished_at=time.time(),
                  selected_checkpoint_sha256=file_sha(selected) if selected.is_file() else None)
    atomic_json(status_path, status)
    if status['state'] != 'completed':
        raise RuntimeError(f'Curriculum stage {stage_id} failed ({result.returncode})')

def terminate_group(process):
    previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            process.wait()
            return
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        # A leader's exit does not prove its data-loader/GPU descendants exited.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def role_job(role, bundle, source, original=None, remote=False, resume=False, stage=None):
    bundle = Path(bundle).resolve()
    if original:
        relocate_bundle(bundle, original)
    recipe_metadata = {}
    directory = bundle / role
    if stage:
        descriptor = next(value for value in validate_curriculum(bundle)['stages'] if value['id'] == stage)
        if descriptor['role'] != role:
            raise ValueError('Stage role differs from its worker')
        directory = stage_directory(bundle, descriptor)
        recipe_metadata['stage_id'] = stage
    config_path = directory / 'train.yml'
    if config_path.is_file():
        import yaml
        config = yaml.safe_load(config_path.read_text())
        rows = sum(len(Path(path).read_text().splitlines()) for path in config['Train']['dataset']['label_file_list'])
        batch = config['Train']['loader']['batch_size_per_card']
        recipe_metadata.update(epochs=config['Global']['epoch_num'], steps_per_epoch=math.ceil(rows / batch))
    disconnected = threading.Event()
    if remote:
        def watch_connection():
            if not os.read(sys.stdin.fileno(), 1):
                disconnected.set()
        threading.Thread(target=watch_connection, daemon=True).start()
    args = ([sys.executable, str(TOOLS / 'lab_training_job.py'), '--execute-stage', stage, '--bundle', str(bundle), '--source', str(source)]
            if stage else [sys.executable, str(TOOLS / 'run_named_training.py'), '--bundle', str(bundle), '--role', role, '--source', str(source)])
    if resume:
        args.append('--resume')
    log_path = directory / 'training.log'
    log_offset = log_path.stat().st_size if log_path.is_file() else 0
    def current_log():
        if not log_path.is_file():
            return ''
        with log_path.open('rb') as stream:
            stream.seek(0, 2)
            stream.seek(max(log_offset, stream.tell() - 32768))
            return stream.read().decode(errors='replace')
    def stop(signum, frame):
        raise InterruptedError('Training worker stopped')
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGHUP, stop)
    started = time.time()
    progress = training_progress('', role, REMOTE_HOST if remote else 'local', started)
    progress.update(recipe_metadata, waiting_reason='Initializing model and data loader')
    atomic_json(directory / 'progress.json', progress)
    print(PROGRESS_PREFIX + json.dumps(progress), flush=True)
    process = subprocess.Popen(args, start_new_session=True)
    latest_progress = 0
    try:
        while process.poll() is None:
            if disconnected.wait(.5):
                raise InterruptedError('SSH connection closed; stopping remote training')
            if time.monotonic() - latest_progress >= 2:
                progress = training_progress(current_log(), role,
                                             REMOTE_HOST if remote else 'local', started)
                progress.update(recipe_metadata)
                if progress['state'] == 'initializing':
                    progress['waiting_reason'] = 'Initializing model and data loader'
                atomic_json(directory / 'progress.json', progress)
                print(PROGRESS_PREFIX + json.dumps(progress), flush=True)
                latest_progress = time.monotonic()
        if process.returncode:
            raise RuntimeError(f'{role} training failed ({process.returncode})')
        progress = training_progress(current_log(), role,
                                     REMOTE_HOST if remote else 'local', started)
        progress.update(recipe_metadata)
        progress['state'] = 'completed'
        atomic_json(directory / 'progress.json', progress)
        print(PROGRESS_PREFIX + json.dumps(progress), flush=True)
    except BaseException as error:
        progress = training_progress(current_log(), role,
                                     REMOTE_HOST if remote else 'local', started)
        progress.update(recipe_metadata)
        progress['state'] = 'interrupted' if isinstance(error, InterruptedError) else 'failed'
        atomic_json(directory / 'progress.json', progress)
        print(PROGRESS_PREFIX + json.dumps(progress), flush=True)
        raise
    finally:
        terminate_group(process)


def sync_to_remote(local, remote, log):
    command(['rsync', '-a', '--protect-args', '-e', shlex.join(ssh_args()),
             str(local) + '/', REMOTE_HOST + ':' + str(remote) + '/'], log, timeout=600)


def _curriculum_label(workers):
    labels = {'base': 'Shared OCR base', 'general': 'General refinement',
              'names-base': 'Name specialization', 'names': 'Name refinement'}
    running = []
    for worker in workers:
        if worker.get('state') in ('completed', 'inherited', 'waiting'):
            continue
        text = labels.get(worker.get('stage_id'), worker['role'].title())
        if worker.get('epoch') and worker.get('epochs'):
            text += f" {worker['epoch']}/{worker['epochs']}"
        running.append(text)
    return ' · '.join(running) or 'Model stages complete'


def stage_worker(stage, previous, state='initializing', reason='Initializing model and data loader'):
    value = {key: previous[key] for key in ('host', 'gpu') if key in previous}
    value.update(role=stage['role'], stage_id=stage['id'], epochs=stage['epochs'], state=state)
    if reason:
        value['waiting_reason'] = reason
    return value


def merge_worker_progress(previous, value):
    if value.get('stage_id') != previous.get('stage_id'):
        previous = {key: previous[key] for key in ('role', 'host', 'gpu') if key in previous}
    else:
        previous = {key: item for key, item in previous.items() if key != 'waiting_reason'}
    return {**previous, **value}


def _run_stage_workers(jobs, workers, run, update):
    processes = []
    logs = []
    try:
        for job in jobs:
            owner_path = run / 'stage-owners.json'
            owners = json.loads(owner_path.read_text()) if owner_path.is_file() else {}
            for identity in job['stages']:
                owners[identity] = {'host': REMOTE_HOST if job['remote'] else 'local'}
            atomic_json(owner_path, owners)
            job = {**job, 'offset': job['log'].stat().st_size if job['log'].is_file() else 0}
            stream = job['log'].open('ab')
            logs.append(stream)
            process = subprocess.Popen([str(arg) for arg in job['args']],
                                       stdin=subprocess.PIPE if job['remote'] else subprocess.DEVNULL,
                                       stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            processes.append((process, job))
        while True:
            failed = any(process.poll() not in (None, 0) for process, _ in processes)
            for process, job in processes:
                index = 0 if job['role'] == 'general' else 1
                value = read_progress(job['log'], workers[index], job['offset'])
                if value.get('stage_id') in job['stages']:
                    workers[index] = merge_worker_progress(workers[index], value)
            atomic_json(run / 'workers.json', workers)
            update(status='training', stage=_curriculum_label(workers), workers=workers)
            if failed:
                raise RuntimeError('A curriculum stage failed; inspect the retained stage training logs')
            if all(process.poll() is not None for process, _ in processes):
                return
            time.sleep(1)
    finally:
        for process, job in processes:
            if process.stdin:
                process.stdin.close()
            if process.poll() is None:
                if not job['remote']:
                    process.terminate()
                try:
                    process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        for stream in logs:
            stream.close()


def _fetch_remote_stages(bundle, target, stages, run):
    for stage in stages:
        relative = stage_directory(bundle, stage).relative_to(bundle)
        with (run / 'transfer.log').open('ab') as log:
            exists = subprocess.run(remote_command(['test', '-d', target / relative]),
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, timeout=30)
        if exists.returncode == 1:
            continue
        if exists.returncode:
            raise RuntimeError('Cannot inspect saved remote curriculum stages')
        command(['rsync', '-a', '--protect-args', '-e', shlex.join(ssh_args()),
                 '--include=*/', '--include=checkpoints/***', '--include=training-status.json',
                 '--include=training.log', '--include=progress.json', '--exclude=*',
                 REMOTE_HOST + ':' + str(target / relative) + '/', str(stage_directory(bundle, stage)) + '/'],
                run / 'transfer.log', timeout=600)


def completed_worker(bundle, stage, fallback):
    fallback = stage_worker(stage, fallback, 'completed', reason=None)
    path = stage_directory(bundle, stage) / 'progress.json'
    if path.is_file():
        progress = json.loads(path.read_text())
        if (progress.get('role') == stage['role'] and progress.get('stage_id') == stage['id']
                and progress.get('state') == 'completed'):
            return {**fallback, **progress}
    return {**fallback, 'state': 'completed'}


def train_curriculum(prepared, remote, run, update):
    bundle = Path(prepared['bundle']).resolve()
    curriculum = validate_curriculum(bundle) if prepared.get('resuming') else seal_curriculum(bundle)
    stages = {stage['id']: stage for stage in curriculum['stages']}
    workers = [stage_worker(stages['base'], {'host': 'local'}),
               stage_worker(stages['names-base'], {'host': REMOTE_HOST}, 'waiting',
                            'Waiting for shared base model') if 'names-base' in stages else
               {'role': 'names', 'host': 'inherited', 'state': 'inherited'}]
    if prepared.get('local_gpu'):
        workers[0]['gpu'] = prepared['local_gpu'].get('gpu')
    if remote:
        workers[1]['gpu'] = remote['gpu'].get('gpu')
    def local_job(identity):
        role = stages[identity]['role']
        args = [prepared['python'], TOOLS / 'lab_training_job.py', '--role', role, '--stage', identity,
                '--bundle', bundle, '--source', prepared['source']]
        if prepared.get('resuming'):
            args.append('--resume')
        return {'args': args, 'role': role, 'stages': [identity], 'remote': False, 'log': run / (role + '.log')}
    update(status='training', stage='Shared OCR base', workers=workers)
    if not completed_stage(bundle, stages['base']):
        _run_stage_workers([local_job('base')], workers, run, update)
    if not completed_stage(bundle, stages['base']):
        raise ValueError('The shared original-pretrained base did not finish')
    workers[0] = stage_worker(stages['general'], workers[0])
    jobs = []
    if not completed_stage(bundle, stages['general']):
        jobs.append(local_job('general'))
    else:
        workers[0] = completed_worker(bundle, stages['general'], workers[0])
    names = [stages[identity] for identity in ('names-base', 'names') if identity in stages]
    remote_pending = any(not completed_stage(bundle, stage) for stage in names)
    local_names_resume = (prepared.get('resuming') and remote_pending and 'names-base' in stages
                          and completed_stage(bundle, stages['general'])
                          and completed_stage(bundle, stages['names-base'])
                          and not completed_stage(bundle, stages['names']))
    target = None
    if local_names_resume:
        jobs.append(local_job('names'))
        workers[1] = stage_worker(stages['names'], {
            'host': 'local', 'gpu': prepared.get('local_gpu', {}).get('gpu')})
    elif remote_pending:
        if not remote:
            raise ValueError('The name curriculum requires the verified unimatrix-01 GPU')
        target_root = Path(remote['root']) / 'lab-runs' / run.name
        target = target_root / 'bundle'
        if workers[0]['state'] != 'completed':
            workers[0].update(state='waiting', waiting_reason='Waiting for checkpoint transfer to unimatrix-01')
        pending_stage = next(stage for stage in names if not completed_stage(bundle, stage))
        workers[1] = stage_worker(pending_stage, workers[1], 'waiting',
                                  'Transferring training data and shared checkpoint to unimatrix-01')
        update(stage='Transferring shared checkpoint to unimatrix-01', workers=workers)
        command(remote_command(['mkdir', '-p', target, target_root / 'tools']), run / 'ssh.log', timeout=30)
        command(['rsync', '-a', '--protect-args', '-e', shlex.join(ssh_args()),
                 '--include=/stages/base/checkpoints/', '--include=/stages/base/checkpoints/best_accuracy.pdparams',
                 '--exclude=/stages/base/checkpoints/***', '--exclude=/general/checkpoints/***',
                 str(bundle) + '/', REMOTE_HOST + ':' + str(target) + '/'], run / 'transfer.log', timeout=600)
        workers[1]['waiting_reason'] = 'Transferring training tools to unimatrix-01'
        update(stage='Transferring training tools to unimatrix-01', workers=workers)
        sync_to_remote(TOOLS.parent.parent, target_root / 'tools', run / 'transfer.log')
        args = [remote['python'], target_root / 'tools/dev_tools/training/lab_training_job.py',
                '--stage-chain', 'names-base', 'names', '--bundle', target, '--source', remote['source'],
                '--original-bundle', bundle, '--remote']
        if prepared.get('resuming'):
            args.append('--resume')
        jobs.append({'args': remote_command(args), 'role': 'names', 'stages': ['names-base', 'names'],
                     'remote': True, 'log': run / 'names.log'})
        workers[1].update(state='initializing', waiting_reason='Initializing model and data loader')
    elif names:
        workers[1] = completed_worker(bundle, stages['names'], workers[1])
    if workers[0]['state'] == 'waiting':
        workers[0].update(state='initializing', waiting_reason='Initializing model and data loader')
    update(stage='Resuming name refinement locally' if local_names_resume else 'General refinement · name specialization', workers=workers)
    try:
        if jobs:
            _run_stage_workers(jobs, workers, run, update)
    finally:
        if target is not None:
            failed = sys.exc_info()[0] is not None
            try:
                _fetch_remote_stages(bundle, target, names, run)
            except Exception:
                if not failed:
                    raise
    for stage in curriculum['stages']:
        if not completed_stage(bundle, stage):
            raise ValueError(f"Curriculum stage {stage['id']} did not finish with verified weights")
    update(stage='All training stages complete', workers=workers)


def resume_curriculum(prepared, run, update):
    from checkpoint_resume import validate_bundle
    bundle = Path(prepared['bundle']).resolve()
    if bundle != run / 'bundle':
        raise ValueError('Recovery bundle does not belong to this version')
    validate_bundle(bundle)
    curriculum = validate_curriculum(bundle)
    names = [stage for stage in curriculum['stages'] if stage['role'] == 'names']
    remote = json.loads((run / 'hosts.json').read_text()) if names else None
    pending = [stage for stage in names if not completed_stage(bundle, stage)]
    owners_path = run / 'stage-owners.json'
    owners = json.loads(owners_path.read_text()) if owners_path.is_file() else {}
    workers_path = run / 'workers.json'
    workers = json.loads(workers_path.read_text()) if workers_path.is_file() else json.loads((run / 'run.json').read_text()).get('workers', [])
    previous = next((worker for worker in workers if worker.get('role') == 'names'), {})
    if any(previous.get('stage_id') == stage['id'] and previous.get('host')
           and owners.get(stage['id'], {}).get('host') not in (None, previous['host']) for stage in pending):
        raise ValueError('The Names attempt host records disagree; start a new training version')
    hosts = {owners.get(stage['id'], {}).get('host') for stage in pending}
    hosts.discard(None)
    if not hosts and previous.get('host'):
        hosts.add(previous['host'])
    unstarted = (owners_path.is_file() and not hosts
                 and not any(any((stage_directory(bundle, stage) / 'checkpoints').glob('*')) for stage in pending))
    if pending and not unstarted and (len(hosts) != 1 or not hosts <= {'local', REMOTE_HOST}):
        raise ValueError('The interrupted Names worker host is unknown; start a new training version')
    if pending and hosts == {'local'} and any(stage['id'] != 'names' for stage in pending):
        raise ValueError('Only the final Names refinement can recover from a local attempt')
    if pending and hosts == {REMOTE_HOST} and (owners or previous.get('state') != 'waiting'):
        target = Path(remote['root']) / 'lab-runs' / run.name / 'bundle'
        _fetch_remote_stages(bundle, target, pending, run)
    prepared['resuming'] = True
    train_curriculum(prepared, remote, run, update)

def train_pair(prepared, remote, run, update):
    bundle = Path(prepared['bundle'])
    if (bundle / 'curriculum.json').is_file():
        return train_curriculum(prepared, remote, run, update)
    if 'names' not in prepared.get('roles', ['general', 'names']):
        remote = None
    workers = [{'role': 'general', 'host': 'local', 'state': 'initializing'},
               {'role': 'names', 'host': REMOTE_HOST if remote else 'inherited',
                'state': 'initializing' if remote else 'inherited'}]
    completed = prepared.get('completed_roles', [])
    for index, worker in enumerate(workers):
        if worker['role'] in completed:
            previous = next((item for item in prepared.get('previous_workers', []) if item['role'] == worker['role']), {})
            workers[index] = {**worker, **previous, 'state': 'completed'}
    devices = json.loads((run.parent.parent / 'gpu-status.json').read_text()).get('devices', []) if (run.parent.parent / 'gpu-status.json').is_file() else []
    for worker in workers:
        device = next((device for device in devices if device['host'] == worker['host']), None)
        if device:
            worker['gpu'] = device.get('gpu')
        if worker['host'] == 'local' and prepared.get('local_gpu'):
            worker['gpu'] = prepared['local_gpu']['gpu']
        if worker['host'] == REMOTE_HOST and remote:
            worker['gpu'] = remote['gpu'].get('gpu')
    update(status='training', stage='Training models', workers=workers)
    if not remote:
        if 'general' in completed:
            return
        with (run / 'general.log').open('ab') as log:
            arguments = [prepared['python'], str(TOOLS / 'lab_training_job.py'), '--role', 'general',
                         '--bundle', str(bundle), '--source', prepared['source']]
            if prepared.get('resuming'):
                arguments.append('--resume')
            process = subprocess.Popen(arguments,
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
            try:
                while process.poll() is None:
                    workers[0] = {**workers[0], **read_progress(run / 'general.log', workers[0])}
                    atomic_json(run / 'workers.json', workers)
                    update(workers=workers)
                    time.sleep(2)
                workers[0] = {**workers[0], **read_progress(run / 'general.log', workers[0])}
                update(workers=workers)
                if process.returncode:
                    raise RuntimeError(training_failure(run))
                return
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=12)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    target = Path(remote['root']) / 'lab-runs' / run.name
    command(remote_command(['mkdir', '-p', str(target / 'bundle'), str(target / 'tools')]),
            run / 'ssh.log', timeout=30)
    sync_to_remote(bundle, target / 'bundle', run / 'transfer.log')
    sync_to_remote(TOOLS.parent.parent, target / 'tools', run / 'transfer.log')
    remote_script = target / 'tools/dev_tools/training/lab_training_job.py'
    remote_arguments = [remote['python'], remote_script, '--role', 'names',
                        '--bundle', target / 'bundle', '--source', remote['source'],
                        '--original-bundle', bundle, '--remote']
    local_args = [prepared['python'], str(TOOLS / 'lab_training_job.py'), '--role', 'general',
                  '--bundle', str(bundle), '--source', prepared['source']]
    if prepared.get('resuming'):
        remote_arguments.append('--resume')
        local_args.append('--resume')
    remote_args = remote_command(remote_arguments)
    update(status='training', stage='Training general OCR locally · player names on unimatrix-01',
           hosts={'general': 'local', 'names': REMOTE_HOST}, workers=workers)
    with (run / 'general.log').open('ab') as local_log, (run / 'names.log').open('ab') as remote_log:
        processes = []
        failed = False
        last_progress = 0
        try:
            processes.append(subprocess.Popen(remote_args, stdin=subprocess.PIPE, stdout=remote_log,
                                              stderr=subprocess.STDOUT, start_new_session=True))
            if 'general' not in completed:
                processes.append(subprocess.Popen(local_args, stdin=subprocess.DEVNULL, stdout=local_log, stderr=subprocess.STDOUT))
            while any(process.poll() is None for process in processes):
                if any(process.poll() not in (None, 0) for process in processes):
                    raise RuntimeError(training_failure(run))
                if time.monotonic() - last_progress >= 2:
                    for index, role in enumerate(('general', 'names')):
                        workers[index] = {**workers[index], **read_progress(run / (role + '.log'), workers[index])}
                    atomic_json(run / 'workers.json', workers)
                    update(workers=workers)
                    last_progress = time.monotonic()
                time.sleep(.5)
            if any(process.returncode for process in processes):
                raise RuntimeError(training_failure(run))
            for index, role in enumerate(('general', 'names')):
                workers[index] = {**workers[index], **read_progress(run / (role + '.log'), workers[index])}
            atomic_json(run / 'workers.json', workers)
            update(workers=workers)
        except BaseException:
            failed = True
            raise
        finally:
            for process in processes:
                if process.stdin:
                    process.stdin.close()
                if process.poll() is None:
                    if not process.stdin:
                        process.terminate()
                    try:
                        process.wait(timeout=12)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
            if failed:
                try:
                    command(['rsync', '-a', '--protect-args', '-e', shlex.join(ssh_args()),
                             REMOTE_HOST + ':' + str(target / 'bundle/names/training.log'),
                             str(bundle / 'names/training.log')], run / 'transfer.log', timeout=20)
                except Exception:
                    pass
    command(['rsync', '-a', '--protect-args', '-e', shlex.join(ssh_args()),
             REMOTE_HOST + ':' + str(target / 'bundle/names/checkpoints') + '/',
             str(bundle / 'names/checkpoints') + '/'], run / 'transfer.log', timeout=600)
    command(['rsync', '-a', '--protect-args', '-e', shlex.join(ssh_args()),
             REMOTE_HOST + ':' + str(target / 'bundle/names/training-status.json'),
             str(bundle / 'names/training-status.json')], run / 'transfer.log', timeout=60)
    command(['rsync', '-a', '--protect-args', '-e', shlex.join(ssh_args()),
             REMOTE_HOST + ':' + str(target / 'bundle/names/training.log'),
             str(bundle / 'names/training.log')], run / 'transfer.log', timeout=60)
    for role in ('general', 'names'):
        status = json.loads((bundle / role / 'training-status.json').read_text())
        checkpoint = bundle / role / 'checkpoints/best_accuracy.pdparams'
        if status.get('state') != 'completed' or hashlib.sha256(checkpoint.read_bytes()).hexdigest() != status.get('selected_checkpoint_sha256'):
            raise RuntimeError(f'{role} checkpoint failed its completed-job hash check')


class _CheckpointMetrics(pickle.Unpickler):
    def find_class(self, module, name):
        raise ValueError('Checkpoint metrics must contain plain scalar data')


def selection_candidate(bundle, stage):
    import yaml
    directory = stage_directory(bundle, stage)
    if not completed_stage(bundle, stage):
        raise ValueError('Cross-phase selection requires completed verified stages')
    config = yaml.safe_load((directory / 'train.yml').read_text())
    if config['Metric'].get('main_indicator') != 'acc':
        raise ValueError('Cross-phase selection requires exact-match accuracy as its primary metric')
    labels = config['Eval']['dataset']['label_file_list']
    if labels != [str(directory / 'val.txt')]:
        raise ValueError('Selection validation list differs from its frozen stage')
    raw = (directory / 'checkpoints/best_accuracy.states').read_bytes()
    if len(raw) > 1_048_576:
        raise ValueError('Selected checkpoint metrics exceed their size bound')
    state = _CheckpointMetrics(io.BytesIO(raw)).load()
    metric = state.get('best_model_dict', {}) if isinstance(state, dict) else {}
    accuracy, epoch = metric.get('acc'), metric.get('best_epoch')
    if (isinstance(accuracy, bool) or not isinstance(accuracy, (int, float)) or not math.isfinite(accuracy)
            or not 0 <= accuracy <= 1 or type(epoch) is not int or not 1 <= epoch <= stage['epochs']
            or state.get('epoch') != epoch or metric.get('is_float16') not in (True, False)):
        raise ValueError('Selected checkpoint validation metrics or epoch are invalid')
    if (directory / 'training.log').stat().st_size > 33_554_432:
        raise ValueError('Training selection log exceeds its size bound')
    log = (directory / 'training.log').read_bytes()
    metrics = re.findall(r'best metric, acc: ([0-9.eE+\-]+)[^\n\r]*?best_epoch: (\d+)', log.decode(errors='replace'))
    if not metrics or int(metrics[-1][1]) != epoch or not math.isclose(float(metrics[-1][0]), accuracy, rel_tol=0, abs_tol=1e-12):
        raise ValueError('Checkpoint validation metric disagrees with its completed training log')
    policy = {'architecture': config['Architecture'], 'metric': config['Metric'], 'role': stage['role'],
              'normalization': config['Eval']['dataset']['transforms'], 'loader': config['Eval']['loader'],
              'dictionary_sha256': file_sha(config['Global']['character_dict_path']),
              'global': {key: config['Global'].get(key) for key in
                         ('infer_mode', 'use_space_char', 'max_text_length', 'collector_name_high_resolution')},
              'is_float16': metric['is_float16']}
    return {'phase': stage['id'], 'checkpoint': str((directory / 'checkpoints/best_accuracy.pdparams').relative_to(bundle)),
            'checkpoint_sha256': file_sha(directory / 'checkpoints/best_accuracy.pdparams'),
            'validation_accuracy': accuracy, 'best_epoch': epoch, 'validation_samples': stage['validation_count'],
            'validation_list_sha256': file_sha(directory / 'val.txt'),
            'evaluation_policy_sha256': hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'checkpoint_states_sha256': hashlib.sha256(raw).hexdigest(),
            'training_log_sha256': hashlib.sha256(log).hexdigest(),
            'training_receipt_sha256': file_sha(directory / 'training-status.json')}


def select_models(bundle):
    bundle = Path(bundle).resolve()
    if not (bundle / 'curriculum.json').is_file():
        return {}
    stages = {stage['id']: stage for stage in validate_curriculum(bundle)['stages']}
    selections = {}
    for role, phases in [('general', ['base', 'general']), ('names', ['names-base', 'names'])]:
        if phases[-1] not in stages:
            continue
        candidates = [selection_candidate(bundle, stages[phase]) for phase in phases]
        if len({(value['validation_list_sha256'], value['evaluation_policy_sha256'], value['validation_samples']) for value in candidates}) != 1:
            raise ValueError('Cross-phase validation lists, normalization, architecture, role or metrics differ')
        selected = max(enumerate(candidates), key=lambda item: (item[1]['validation_accuracy'], item[0]))[1]
        destination = bundle / role / 'selected.pdparams'
        temporary = destination.with_name('selected-' + uuid.uuid4().hex + '.tmp')
        shutil.copyfile(bundle / selected['checkpoint'], temporary)
        if file_sha(temporary) != selected['checkpoint_sha256']:
            temporary.unlink()
            raise ValueError('Selected export checkpoint changed while it was copied')
        temporary.replace(destination)
        receipt = {'role': role, 'selection': 'highest frozen validation exact-match accuracy',
                   'tie_break': 'later phase', 'selected_phase': selected['phase'],
                   'selected_checkpoint_sha256': selected['checkpoint_sha256'],
                   'validation_list_sha256': selected['validation_list_sha256'],
                   'evaluation_policy_sha256': selected['evaluation_policy_sha256'], 'candidates': candidates}
        atomic_json(bundle / role / 'model-selection.json', receipt)
        selections[role] = receipt
    return selections


def export_checkpoint(bundle, role):
    bundle = Path(bundle).resolve()
    if not (bundle / 'curriculum.json').is_file():
        return bundle / role / 'checkpoints/best_accuracy.pdparams'
    receipt = json.loads((bundle / role / 'model-selection.json').read_text())
    selected = bundle / role / 'selected.pdparams'
    if receipt.get('role') != role or file_sha(selected) != receipt.get('selected_checkpoint_sha256'):
        raise ValueError('Selected export weights differ from the validation selection receipt')
    stages = {stage['id']: stage for stage in validate_curriculum(bundle)['stages']}
    phase = receipt.get('selected_phase')
    if phase not in (['base', 'general'] if role == 'general' else ['names-base', 'names']):
        raise ValueError('Selected model phase does not belong to its role')
    current = selection_candidate(bundle, stages[phase])
    recorded = next((value for value in receipt.get('candidates', []) if value.get('phase') == phase), None)
    if current != recorded or current['checkpoint_sha256'] != file_sha(selected):
        raise ValueError('The selected source checkpoint or validation evidence changed')
    return selected

def export_models(prepared, run):
    import yaml
    bundle = Path(prepared['bundle'])
    python = prepared['python']
    for role in ('general', 'names'):
        directory = bundle / role
        if role not in prepared.get('roles', ['general', 'names']):
            shutil.copytree(prepared['baseline_names_model'], directory / 'portable')
            continue
        native = directory / 'export'
        portable = directory / 'portable'
        portable.mkdir()
        args = [python, TOOLS / 'run_portable_export.py', '--source', prepared['source'], '--mode', 'export']
        if role == 'names':
            args.append('--name-high-resolution')
        args += ['-c', directory / 'train.yml', '-o',
                 'Global.pretrained_model=' + str(export_checkpoint(bundle, role)),
                 'Global.save_inference_dir=' + str(native)]
        command(args, run / 'export.log', timeout=600)
        command([python, Path(python).parent / 'paddle2onnx', '--model_dir', native,
                 '--model_filename', 'inference.json', '--params_filename', 'inference.pdiparams',
                 '--save_file', portable / 'model.onnx', '--opset_version', '17',
                 '--optimize_tool', 'None'], run / 'export.log', timeout=600)
        characters = ['blank'] + yaml.safe_load((native / 'inference.yml').read_text())['PostProcess']['character_dict'] + [' ']
        if len(characters) != 70:
            raise ValueError('Exported OCR dictionary does not match the frozen 70-class contract')
        (portable / 'characters.json').write_text(json.dumps(characters))
        command([python, TOOLS / 'lab_training_job.py', '--verify-export', directory,
                 '--bundle', bundle], run / 'export-parity.log', timeout=600)


def verify_export(directory, bundle):
    import cv2
    import numpy as np
    import paddle.inference as inference
    from portable_ocr import PortableModel, decode_ctc, normalize_crop
    directory, bundle = Path(directory), Path(bundle)
    native = directory / 'export'
    config = inference.Config(str(native / 'inference.json'), str(native / 'inference.pdiparams'))
    config.disable_gpu()
    config.disable_glog_info()
    config.set_cpu_math_library_num_threads(2)
    config.switch_ir_optim(False)
    predictor = inference.create_predictor(config)
    model = PortableModel(directory / 'portable', device='cpu')
    def check(array, image=None):
        handle = predictor.get_input_handle(predictor.get_input_names()[0])
        handle.reshape(array.shape)
        handle.copy_from_cpu(array)
        predictor.run()
        expected = predictor.get_output_handle(predictor.get_output_names()[0]).copy_to_cpu()
        actual = model.session.run(None, {model.input_name: array})[0]
        if expected.shape != actual.shape or np.max(np.abs(expected - actual)) > .001:
            raise ValueError('Paddle/ONNX probability parity failed')
        if decode_ctc(expected, model.characters)[0] != decode_ctc(actual, model.characters)[0]:
            raise ValueError('Paddle/ONNX decoded-output parity failed')
        return float(np.max(np.abs(expected - actual)))
    errors = [check(np.random.default_rng(width).uniform(-1, 1, (1, 3, 48, width)).astype(np.float32))
              for width in (320, 384, 640)]
    counts = {}
    for line in (directory / 'manifest.jsonl').read_text().splitlines():
        row = json.loads(line)
        key = (row['category'], bool(row['label']))
        if counts.get(key, 0) >= 12:
            continue
        image = cv2.imread(str(bundle / row['image_path']))
        if image is None:
            raise ValueError('Export verification crop is missing')
        errors.append(check(normalize_crop(image)))
        counts[key] = counts.get(key, 0) + 1
    atomic_json(directory / 'export-parity.json', {'samples': sum(counts.values()),
                'maximum_probability_error': max(errors), 'decoded_mismatches': 0})


def edit_distance(left, right):
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def paired_benchmark_rows(candidate, baseline):
    roots = {'candidate': Path(candidate), 'baseline': Path(baseline)}
    protocols = {side: json.loads((root / 'protocol.json').read_text()) for side, root in roots.items()}
    protocol = protocols['candidate']
    conditions = protocol.get('conditions')
    supported = ('identity', 'brightness_minus30', 'jpeg80', 'scale60')
    if (not isinstance(conditions, list) or not conditions or 'identity' not in conditions
            or any(not isinstance(value, str) or value not in supported for value in conditions)
            or len(set(conditions)) != len(conditions)):
        raise ValueError('Benchmark protocol must contain unique supported conditions including identity')
    manifest_hash = protocol.get('manifest_sha256')
    if not isinstance(manifest_hash, str) or not re.fullmatch('[a-f0-9]{64}', manifest_hash):
        raise ValueError('Benchmark manifest SHA256 is invalid')
    prior_protocol = protocols['baseline']
    if (prior_protocol.get('manifest_sha256') != manifest_hash
            or prior_protocol.get('conditions') != conditions
            or prior_protocol.get('validation_contract') != protocol.get('validation_contract')):
        raise ValueError('Paired benchmarks require the same frozen manifest, conditions and validation contract')
    fields = ('label', 'category', 'split', 'scope', 'file_sha256', 'pixel_sha256', 'model_role')
    rows = {}
    for side, root in roots.items():
        rows[side] = {}
        for condition in conditions:
            values = [json.loads(line) for line in (root / condition / 'predictions.jsonl').read_text().splitlines() if line.strip()]
            identities = [row.get('sample_id') for row in values]
            if (not values or any(not isinstance(identity, str) or not identity for identity in identities)
                    or len(set(identities)) != len(values)):
                raise ValueError(f'{side} {condition} benchmark requires unique nonempty sample identities')
            if protocols[side].get('samples') != len(values):
                raise ValueError(f'{side} {condition} benchmark sample count differs from its protocol')
            for row in values:
                if (row.get('condition') != condition or row.get('split') != 'test'
                        or not isinstance(row.get('label'), str)
                        or not isinstance(row.get('category'), str)
                        or row.get('scope') not in ('real_observation', 'synthetic_control')
                        or row.get('model_role') != ('names' if row['category'] == 'name' else 'general')
                        or any(not isinstance(row.get(key), str) or not re.fullmatch('[a-f0-9]{64}', row[key])
                               for key in ('file_sha256', 'pixel_sha256'))):
                    raise ValueError(f'{side} {condition} benchmark has invalid ground truth, role or condition metadata')
                expected = not bool(row.get('error')) and row.get('raw_prediction') == row['label']
                if not isinstance(row.get('raw_exact'), bool) or row['raw_exact'] != expected:
                    raise ValueError(f'{side} {condition} raw_exact differs from its case-sensitive prediction truth')
                if row.get('error'):
                    raise ValueError(f'{side} {condition} benchmark has processing errors; the candidate cannot be completed')
                latency = row.get('inference_ms')
                if (not isinstance(row.get('raw_prediction'), str) or isinstance(latency, bool)
                        or not isinstance(latency, (int, float)) or not math.isfinite(latency) or latency < 0):
                    raise ValueError(f'{side} {condition} benchmark prediction or latency is invalid')
            rows[side][condition] = {row['sample_id']: row for row in values}
    reference = rows['candidate']['identity']
    paired = {}
    for condition in conditions:
        current, prior = rows['candidate'][condition], rows['baseline'][condition]
        if set(current) != set(reference) or set(prior) != set(reference):
            raise ValueError('Paired benchmark sample identities differ across models or conditions')
        pairs = []
        for identity, expected in reference.items():
            before, after = prior[identity], current[identity]
            if any(before.get(field) != expected.get(field) or after.get(field) != expected.get(field) for field in fields):
                raise ValueError('Paired benchmark labels, categories, provenance, pixels or roles differ')
            pairs.append((before, after))
        paired[condition] = pairs
    return paired


def benchmark_summary(candidate, baseline):
    pairs = paired_benchmark_rows(candidate, baseline)['identity']
    current = [after for _, after in pairs]
    latencies = sorted(row['inference_ms'] for row in current)
    return {'samples': len(pairs), 'exact_match': sum(after['raw_exact'] for _, after in pairs) / len(pairs),
            'baseline_exact_match': sum(before['raw_exact'] for before, _ in pairs) / len(pairs),
            'cer': sum(edit_distance(row['label'], row['raw_prediction']) for row in current) / max(1, sum(len(row['label']) for row in current)),
            'p50_ms': latencies[math.ceil((len(latencies) - 1) * .5)],
            'p95_ms': latencies[math.ceil((len(latencies) - 1) * .95)],
            'regressions': sum(before['raw_exact'] and not after['raw_exact'] for before, after in pairs),
            'improved': sum(not before['raw_exact'] and after['raw_exact'] for before, after in pairs),
            'processing_errors': 0}


def benchmark_details(candidate, baseline):
    paired = paired_benchmark_rows(candidate, baseline)
    if set(paired) != {'identity', 'brightness_minus30', 'jpeg80', 'scale60'}:
        raise ValueError('The training comparison requires all supported stress conditions')
    results = []
    for condition, condition_pairs in paired.items():
        for role in ('general', 'names'):
            pairs = [(before, after) for before, after in condition_pairs if after['model_role'] == role]
            categories = ['all'] + sorted({after['category'] for _, after in pairs})
            for category in categories:
                group = [(before, after) for before, after in pairs if category == 'all' or after['category'] == category]
                if not group:
                    continue
                latency = sorted(after['inference_ms'] for _, after in group)
                record = {'role': role, 'condition': condition, 'category': category, 'samples': len(group),
                          'exact_match': sum(after['raw_exact'] for _, after in group) / len(group),
                          'baseline_exact_match': sum(before['raw_exact'] for before, _ in group) / len(group),
                          'cer': sum(edit_distance(after['label'], after['raw_prediction'])
                                     for _, after in group) / max(1, sum(len(after['label']) for _, after in group)),
                          'regressions': sum(before['raw_exact'] and not after['raw_exact'] for before, after in group),
                          'improved': sum(not before['raw_exact'] and after['raw_exact'] for before, after in group),
                          'processing_errors': 0,
                          'p95_ms': latency[math.ceil((len(latency) - 1) * .95)]}
                results.append(record)
    return results


def benchmark(prepared, run):
    bundle = Path(prepared['bundle'])
    rows = [json.loads(line) for line in (bundle / 'test.jsonl').read_text().splitlines()]
    if not rows or any(row['split'] != 'test' for row in rows):
        raise ValueError('A nonempty frozen test split is required for comparison')
    for name, general, names in (
        ('baseline', prepared['baseline_general_model'], prepared['baseline_names_model']),
        ('candidate', bundle / 'general/portable', bundle / 'names/portable'),
    ):
        command([prepared['inference_python'], TOOLS / 'benchmark_named_models.py',
                 '--bundle', bundle, '--manifest', bundle / 'test.jsonl',
                 '--general-model-dir', general, '--name-model-dir', names,
                 '--device', 'gpu:0', '--conditions', 'identity', 'brightness_minus30', 'jpeg80', 'scale60',
                 '--output', run / 'benchmarks' / name], run / 'benchmark.log', timeout=7200)
    summary = benchmark_summary(run / 'benchmarks/candidate', run / 'benchmarks/baseline')
    summary['results'] = benchmark_details(run / 'benchmarks/candidate', run / 'benchmarks/baseline')
    atomic_json(run / 'benchmark.json', summary)
    return summary


def resume_training(run, prepared, update):
    if (Path(prepared['bundle']) / 'curriculum.json').is_file():
        return resume_curriculum(prepared, run, update)
    from checkpoint_resume import completed_role, validate_bundle
    bundle = Path(prepared['bundle']).resolve()
    if bundle != run / 'bundle':
        raise ValueError('Recovery bundle does not belong to this version')
    validate_bundle(bundle)
    original_roles = list(prepared['roles'])
    remote = json.loads((run / 'hosts.json').read_text())
    if 'names' in original_roles and not completed_role(bundle, 'names'):
        update(stage='Recovering the saved player-name job')
        target = Path(remote['root']) / 'lab-runs' / run.name / 'bundle/names'
        for name in ('training-status.json', 'training.log'):
            command(['rsync', '-a', '--protect-args', '-e', shlex.join(ssh_args()),
                     REMOTE_HOST + ':' + str(target / name), str(bundle / 'names' / name)],
                    run / 'transfer.log', timeout=60)
        command(['rsync', '-a', '--protect-args', '-e', shlex.join(ssh_args()),
                 REMOTE_HOST + ':' + str(target / 'checkpoints') + '/',
                 str(bundle / 'names/checkpoints') + '/'], run / 'transfer.log', timeout=600)
    completed = [role for role in original_roles if completed_role(bundle, role)]
    prepared['completed_roles'] = completed
    prepared['resuming'] = True
    prepared['previous_workers'] = json.loads((run / 'run.json').read_text()).get('workers', [])
    if 'names' in completed:
        prepared['roles'] = ['general']
        remote = None
    update(stage='Resuming unfinished model jobs')
    try:
        if set(completed) != set(original_roles):
            train_pair(prepared, remote, run, update)
    finally:
        prepared['roles'] = original_roles
    for role in original_roles:
        if not completed_role(bundle, role):
            raise ValueError(f'The recovered {role} job has not completed')


def finalize_version(prepared, run, update, baseline_pins, frozen_tools, request):
    selections = select_models(prepared['bundle'])
    update(status='benchmarking', stage='Exporting and checking model parity')
    export_models(prepared, run)
    update(stage='Benchmarking against active models on frozen test crops')
    result = benchmark(prepared, run)
    artifacts = {}
    for role in ('general', 'names'):
        directory = Path(prepared['bundle']) / role
        artifacts[role] = {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
                           for name in ('checkpoints/best_accuracy.pdparams', 'selected.pdparams', 'model-selection.json', 'portable/model.onnx', 'portable/characters.json')
                           if (directory / name).is_file()}
    implementation = {str(path.relative_to(frozen_tools)): hashlib.sha256(path.read_bytes()).hexdigest()
                      for path in frozen_tools.rglob('*') if path.is_file() and '__pycache__' not in path.parts}
    audit_raw = (Path(prepared['bundle']) / 'audit.json').read_bytes()
    audit = json.loads(audit_raw)
    stage_lineage = None
    curriculum_path = Path(prepared['bundle']) / 'curriculum.json'
    if curriculum_path.is_file():
        curriculum = validate_curriculum(prepared['bundle'])
        stage_lineage = {'manifest_sha256': file_sha(curriculum_path),
                         'portable_sha256': curriculum_sha(prepared['bundle'], curriculum), 'stages': []}
        for stage in curriculum['stages']:
            directory = stage_directory(prepared['bundle'], stage)
            if not completed_stage(prepared['bundle'], stage):
                raise ValueError('An incomplete curriculum cannot become a finished model version')
            status = json.loads((directory / 'training-status.json').read_text())
            stage_lineage['stages'].append({'id': stage['id'], 'role': stage['role'],
                'depends_on': stage['depends_on'], 'stage_signature': stage['signature'],
                'receipt_sha256': file_sha(directory / 'training-status.json'),
                'starting_checkpoint_sha256': status['checkpoint_sha256'],
                'selected_checkpoint_sha256': status['selected_checkpoint_sha256'],
                'config_sha256': status['config_sha256'], 'lists_sha256': status['lists_sha256'],
                'implementation_sha256': status.get('implementation_sha256', {})})
    atomic_json(run / 'version.json', {'id': request['id'], 'artifacts': artifacts,
                'curriculum': stage_lineage, 'model_selection': selections,
                'implementation': implementation, 'baseline_artifacts': baseline_pins,
                'audit_sha256': hashlib.sha256(audit_raw).hexdigest(),
                'starting_lineage': audit.get('starting_lineage', {}),
                'roles': prepared.get('roles', ['general', 'names']),
                'attempt_id': request.get('attempt_id'),
                'dataset_sha256': hashlib.sha256((Path(prepared['bundle']) / 'manifest.jsonl').read_bytes()).hexdigest(),
                'test_sha256': hashlib.sha256((Path(prepared['bundle']) / 'test.jsonl').read_bytes()).hexdigest(),
                'benchmark': result, 'runtime_model_replaced': False,
                'acceptance': 'Development heldout comparison; independent physical acceptance is required before promotion'})
    update(status='completed', stage='Benchmark complete', benchmark=result, error=None,
           finished_at=int(time.time() * 1000))


def validated_baseline_pins(prepared, run):
    from checkpoint_resume import digest
    pins = prepared.get('baseline_pins')
    if not isinstance(pins, dict) or set(pins) != {'general', 'names'}:
        raise ValueError('Original baseline pins are unavailable for this legacy run; start a new training version')
    for role in ('general', 'names'):
        expected = pins[role]
        if (not isinstance(expected, dict) or set(expected) != {'model.onnx', 'characters.json'}
                or any(not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value) for value in expected.values())):
            raise ValueError('Original baseline pins are invalid; start a new training version')
        directory = Path(prepared['baseline_' + role + '_model'])
        if directory.resolve() != run.resolve() / 'baseline' / role or directory.is_symlink():
            raise ValueError('The frozen baseline does not belong to this version')
        for name, recorded in expected.items():
            path = directory / name
            if path.is_symlink() or not path.is_file() or digest(path) != recorded:
                raise ValueError('The frozen baseline changed; this run cannot be resumed')
    return pins


def supervise(request):
    global TOOLS
    run = Path(request['run_dir']).resolve()
    path = run / 'run.json'
    state = json.loads(path.read_text())
    def update(**fields):
        state.update(fields, updated_at=int(time.time() * 1000))
        atomic_json(path, state)
    stopping = False
    def stop(signum, frame):
        nonlocal stopping
        if not stopping:
            stopping = True
            raise InterruptedError('Training stopped')
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    os.environ.update(OMP_NUM_THREADS='4', OPENBLAS_NUM_THREADS='4',
                      PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK='True')
    try:
        update(pid=os.getpid(), status='preparing',
               stage='Verifying collections' if request.get('mode') == 'analyze' else 'Checking the local GPU')
        resuming = request.get('mode') == 'resume'
        attempt = request.get('attempt_id') or uuid.uuid4().hex
        if not re.fullmatch('[a-f0-9]{32}', attempt):
            raise ValueError('Invalid recovery attempt identity')
        attempt_root = run / 'attempts' / attempt
        frozen_tools = attempt_root / 'tools' if resuming else run / 'tools'
        frozen_tools.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(TOOLS.parent.parent, frozen_tools, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        TOOLS = frozen_tools / 'dev_tools/training'
        sys.path.insert(0, str(TOOLS))
        from lab_training_data import analyze, discover, prepare, prepared_analysis
        if resuming:
            prepared = json.loads((run / 'prepared.json').read_text())
            pins = validated_baseline_pins(prepared, run)
            update(stage='Checking the local GPU before recovery', error=None)
            command([prepared['python'], '-c', GPU_PROBE], run / 'local-gpu.log', timeout=60)
            prepared['local_gpu'] = json.loads(tail(run / 'local-gpu.log').splitlines()[-1])
            resume_training(run, prepared, update)
            for candidate_path in [run / 'benchmarks', run / 'benchmark.json', run / 'version.json'] + [Path(prepared['bundle']) / role / name
                         for role in ('general', 'names') for name in ('export', 'portable', 'export-parity.json', 'selected.pdparams', 'model-selection.json')]:
                if candidate_path.exists():
                    destination = attempt_root / 'previous-finalization' / candidate_path.relative_to(run)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(candidate_path), str(destination))
            validated_baseline_pins(prepared, run)
            finalize_version(prepared, run, update, pins, frozen_tools, request)
            return
        if request.get('mode') == 'analyze':
            update(stage='Verifying collections')
            analysis = analyze(request)
            atomic_json(run / 'readiness.json', analysis)
            retain_analysis_report(run)
            update(status='completed', stage='Ready' if analysis['ready'] else 'Needs attention',
                   analysis=analysis, finished_at=int(time.time() * 1000))
            return
        resources = discover(request['training_root'])
        command([resources['python'], '-c', GPU_PROBE], run / 'local-gpu.log', timeout=60)
        # CUDA operator placement is checked again by the benchmark, beyond this allocation probe.
        baseline_pins = {
            role: {name: hashlib.sha256((Path(resources['baseline_' + role + '_model']) / name).read_bytes()).hexdigest()
                   for name in ('model.onnx', 'characters.json')}
            for role in ('general', 'names')
        }
        update(stage='Verifying and consolidating collections')
        prepared = prepare(request)
        prepared['local_gpu'] = json.loads(tail(run / 'local-gpu.log').splitlines()[-1])
        analysis = prepared_analysis(request, prepared)
        atomic_json(run / 'readiness.json', analysis)
        prepared['summary']['exclusions'] = analysis.get('exclusions', [])
        update(analysis=analysis)
        for role in ('general', 'names'):
            destination = run / 'baseline' / role
            shutil.copytree(prepared['baseline_' + role + '_model'], destination)
            if any(hashlib.sha256((destination / name).read_bytes()).hexdigest() != expected
                   for name, expected in baseline_pins[role].items()):
                raise ValueError('Active models changed during preparation; start a new training run')
            prepared['baseline_' + role + '_model'] = str(destination)
        prepared['baseline_pins'] = baseline_pins
        atomic_json(run / 'prepared.json', prepared)
        atomic_json(run / 'stage-owners.json', {})
        update(summary=prepared['summary'])
        remote = None
        if 'names' in prepared.get('roles', ['general', 'names']):
            update(stage='Checking unimatrix-01 GPU')
            remote = probe_remote(run / 'remote-gpu.log')
        atomic_json(run / 'hosts.json', remote or {'names': 'inherited'})
        train_pair(prepared, remote, run, update)
        finalize_version(prepared, run, update, baseline_pins, frozen_tools, request)
    except BaseException as error:
        interrupted = isinstance(error, (KeyboardInterrupt, InterruptedError)) or (run / 'cancel-requested').exists()
        update(status='interrupted' if interrupted else 'failed', stage='Stopped' if interrupted else 'Failed',
               failed_stage=state.get('status'),
               error=str(error)[-8000:], stopped_by_user=(run / 'cancel-requested').exists(),
               finished_at=int(time.time() * 1000),
               workers=[{**worker, 'state': 'interrupted' if interrupted else 'failed'}
                        if worker['state'] in ('training', 'initializing') else worker for worker in state.get('workers', [])])
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path)
    parser.add_argument('--role', choices=('general', 'names'))
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--original-bundle')
    parser.add_argument('--remote', action='store_true')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--stage', choices=('base', 'general', 'names-base', 'names'))
    parser.add_argument('--execute-stage', choices=('base', 'general', 'names-base', 'names'))
    parser.add_argument('--stage-chain', nargs='+', choices=('base', 'general', 'names-base', 'names'))
    parser.add_argument('--verify-export', type=Path)
    parser.add_argument('--probe', type=Path)
    args = parser.parse_args()
    if args.probe:
        probe_devices(args.probe)
    elif args.execute_stage:
        execute_stage(args.bundle, args.execute_stage, args.source, args.resume)
    elif args.stage_chain:
        if args.original_bundle:
            relocate_bundle(args.bundle, args.original_bundle)
        for identity in args.stage_chain:
            descriptor = next(value for value in validate_curriculum(args.bundle)['stages'] if value['id'] == identity)
            role_job(descriptor['role'], args.bundle, args.source, remote=args.remote, resume=args.resume, stage=identity)
    elif args.role:
        role_job(args.role, args.bundle, args.source, args.original_bundle, args.remote, args.resume, args.stage)
    elif args.verify_export:
        verify_export(args.verify_export, args.bundle)
    elif args.request:
        supervise(json.loads(args.request.read_text()))
    else:
        parser.error('--request or --role is required')


if __name__ == '__main__':
    main()
