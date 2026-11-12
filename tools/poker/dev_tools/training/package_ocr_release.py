#!/usr/bin/env python3
"""Package hash-pinned OCR inputs and explicitly audited qualification evidence.

Packaging never qualifies a model. An unqualified stage needs --candidate and
retains that status inside the archive; production needs the final acceptance
record and its independently collected evidence.
"""

import sys as _storage_sys
from pathlib import Path as _StoragePath
_storage_sys.path.insert(0, str(_StoragePath(__file__).resolve().parents[1]))
from lib.storage_paths import training_dir, data_dir

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

RUNTIME_MODULES = frozenset((
    'collector_frame_policy.py', 'latest_frame_worker.py', 'ocr_output.py',
    'portable_ocr.py', 'production_decision.py', 'production_reader.py',
    'realtime_collector.py', 'schemas.py', 'seat_admission.py',
))
EVIDENCE_ROLES = ('fresh_accuracy', 'native_latency', 'gui_receipt')
ENVIRONMENT_FILES = ('requirements-runtime.lock.txt', 'runtime-environment.json')
LAUNCHER = '''#!/bin/sh
# Launch this exact extracted OCR bundle with explicitly qualified executables.
set -eu
if [ "$#" -lt 2 ]; then
    printf 'Usage: %s ABSOLUTE_PYTHON ABSOLUTE_APP [APP_ARGUMENTS...]\\n' "$0" >&2
    exit 64
fi
qualified_python=$1
qualified_app=$2
shift 2
case "$qualified_python" in
    /*) ;;
    *) printf 'Python executable must be an absolute path.\\n' >&2; exit 64 ;;
esac
case "$qualified_app" in
    /*) ;;
    *) printf 'App executable must be an absolute path.\\n' >&2; exit 64 ;;
esac
if [ ! -f "$qualified_python" ] || [ ! -x "$qualified_python" ]; then
    printf 'Python executable is missing or not executable.\\n' >&2
    exit 64
fi
if [ ! -f "$qualified_app" ] || [ ! -x "$qualified_app" ]; then
    printf 'App executable is missing or not executable.\\n' >&2
    exit 64
fi
case "$0" in
    */*) launcher_dir=${0%/*} ;;
    *) launcher_dir=. ;;
esac
case "$launcher_dir" in
    /*) ;;
    *) launcher_dir=./$launcher_dir ;;
esac
bundle_root=$(CDPATH= cd -P "$launcher_dir" && pwd)
if [ ! -f "$bundle_root/runtime/runtime.json" ] || [ ! -f "$bundle_root/dev_tools/training/ocr_service.py" ]; then
    printf 'Launch this script from an intact extracted poker-ocr bundle.\\n' >&2
    exit 64
fi
POKER_OCR_RELEASE=$bundle_root/runtime
POKER_OCR_SERVICE=$bundle_root/dev_tools/training/ocr_service.py
POKER_OCR_PYTHON=$qualified_python
export POKER_OCR_RELEASE POKER_OCR_SERVICE POKER_OCR_PYTHON
exec "$qualified_app" "$@"
'''
LAUNCH_INSTRUCTIONS = '''# Local OCR runtime

Read PACKAGE-STATUS.json before use. A CANDIDATE archive is a review artifact,
not a production-qualified release. This archive contains neither the native
desktop app nor a Python environment. Use the separately verified optimized app
binary and the Python environment recorded by the qualification evidence.

Use the included executable launcher with two explicit absolute paths. It selects
this bundle's runtime and service, avoiding the app's source-checkout defaults:

```sh
./launch-ocr.sh "/absolute/path/to/qualified-venv/bin/python" "/absolute/path/to/qualified/tauri-app"
```

The launcher works from any working directory when invoked by its absolute or
relative file path. It exports absolute POKER_OCR_RELEASE, POKER_OCR_SERVICE and
POKER_OCR_PYTHON values and forwards any remaining arguments to the app unchanged.
For example, append `--help` after the app path to pass that argument to the app.

The native app and release must have matching capture configuration. Models,
code, contract and configuration are checked at startup; a mismatch fails closed.
Use the qualified runtime environment and lock file when supplied. Their presence
does not itself prove CUDA placement on another machine: repeat the recorded
operator-placement, fallback and native capture checks there.

SHA256SUMS.json binds every payload file except itself. The archive's .sha256
sidecar binds the complete compressed artifact. Packaging verifies extraction,
imports the service from the extracted path and checks its frozen inputs without
creating a model session. It does not substitute for live GPU or GUI acceptance.
'''


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def relative_file(root, name):
    """Accept regular, contained POSIX paths only, including their parents."""
    if not isinstance(name, str) or '\\' in name:
        raise ValueError('Evidence path must be a relative POSIX file path')
    relative = PurePosixPath(name)
    if relative.is_absolute() or not relative.parts or any(p in ('.', '..') for p in relative.parts):
        raise ValueError('Evidence path escapes its release')
    if str(relative) != name:
        raise ValueError('Evidence path is not canonical')
    root = Path(root).resolve()
    path = root.joinpath(*relative.parts)
    if any(parent.is_symlink() for parent in [path, *path.parents] if parent != root and root in parent.parents):
        raise ValueError('Symlink inputs cannot enter an OCR package')
    if not path.is_file() or not path.resolve().is_relative_to(root):
        raise ValueError('Missing or uncontained package input: ' + name)
    return path


def require_hash(path, expected, description):
    if not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected) or sha256(path) != expected:
        raise ValueError('Hash mismatch: ' + description)


def load_inputs(source, release, evidence_manifest, candidate):
    """Check pinned code/models/configuration before copying any release file."""
    source, release = Path(source).resolve(), Path(release).resolve()
    frozen_path = relative_file(release, 'freeze.json')
    frozen = json.loads(frozen_path.read_text())
    implementations = frozen.get('implementation_sha256', {})
    if set(implementations) != RUNTIME_MODULES:
        raise ValueError('The complete nine-module runtime fingerprint is required')
    for name, digest in implementations.items():
        require_hash(relative_file(source, 'dev_tools/training/' + name), digest, name)
    contract_path = relative_file(source, 'dev_tools/ocr_contract.json')
    contract = json.loads(contract_path.read_text())
    if frozen.get('validation_contract') != {'version': contract['version'], 'sha256': sha256(contract_path)}:
        raise ValueError('Validation contract differs from the release freeze')
    require_hash(relative_file(source, 'dev_tools/lib/ocr_contract.py'),
                 frozen.get('collector_contract_implementation_sha256'), 'collector contract implementation')
    require_hash(relative_file(source, 'dev_tools/lib/database.py'),
                 frozen.get('collector_validator_sha256'), 'collector validator fingerprint')
    policy = frozen.get('policy', {})
    required_policy = {'views': [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]],
                       'temporal_observations': 2, 'maximum_temporal_gap_seconds': 1.5,
                       'name_confidence_threshold': None, 'automatic_glyph_repair': False,
                       'maximum_result_age_seconds': 1.0}
    if any(key not in policy or policy[key] != value for key, value in required_policy.items()):
        raise ValueError('Unsupported or incomplete production decision policy')
    runtime = json.loads(relative_file(release, 'runtime.json').read_text())
    if runtime != {'general_model': 'models/general', 'name_model': 'models/names',
                   'regions': 'regions.json', 'colors': 'colors.json'}:
        raise ValueError('Runtime paths must use the portable package layout')
    regions = json.loads(relative_file(release, 'regions.json').read_text())
    colors = json.loads(relative_file(release, 'colors.json').read_text())
    fingerprint = hashlib.sha256(json.dumps([regions, colors], sort_keys=True,
                                allow_nan=False, separators=(',', ':')).encode()).hexdigest()
    if fingerprint != frozen.get('configuration_fingerprint'):
        raise ValueError('Capture configuration differs from the release freeze')
    for role in ('general', 'names'):
        require_hash(relative_file(release, f'models/{role}/model.onnx'),
                     frozen.get('weights', {}).get(role), role + ' model')
        require_hash(relative_file(release, f'models/{role}/characters.json'),
                     frozen.get('characters_sha256', {}).get(role), role + ' dictionary')
    evidence_path = Path(evidence_manifest).resolve()
    evidence = json.loads(evidence_path.read_text())
    entries = evidence.get('sha256')
    if not isinstance(entries, dict) or not entries:
        raise ValueError('An explicit nonempty audited evidence manifest is required')
    if 'audited-evidence-manifest.json' in entries:
        raise ValueError('Audited evidence uses a reserved package filename')
    for name, digest in entries.items():
        require_hash(relative_file(release, name), digest, 'audited evidence ' + name)
    for name in ('freeze.json', 'runtime.json', 'regions.json', 'colors.json', 'acceptance-status.json'):
        if name not in entries:
            raise ValueError('Required audited input missing: ' + name)
    status = json.loads(relative_file(release, 'acceptance-status.json').read_text())
    require_hash(frozen_path, status.get('freeze_sha256'), 'acceptance freeze binding')
    service = relative_file(source, 'dev_tools/training/ocr_service.py')
    service_hash = sha256(service)
    if status.get('ocr_service_sha256') is not None:
        require_hash(service, status['ocr_service_sha256'], 'qualified OCR transport')
    missing_environment = [name for name in ENVIRONMENT_FILES if name not in entries]
    if not candidate:
        if status.get('production_qualified') is not True or status.get('remaining_gates') != []:
            raise ValueError('Production qualification is incomplete; use --candidate for a review bundle')
        if status.get('ocr_service_sha256') != service_hash:
            raise ValueError('Production qualification must bind the OCR transport source')
        references = status.get('evidence_references', {})
        for role in EVIDENCE_ROLES:
            name = references.get(role)
            if not isinstance(name, str) or name not in entries:
                raise ValueError('Missing audited production evidence role: ' + role)
        if missing_environment:
            raise ValueError('Missing audited runtime environment: ' + ', '.join(missing_environment))
    return frozen, entries, evidence_path, {
        'package_status': 'CANDIDATE' if candidate else 'PRODUCTION_QUALIFIED',
        'production_qualified': not candidate,
        'source_acceptance_status': status,
        'freeze_sha256': sha256(frozen_path),
        'ocr_service_sha256': service_hash,
        'ocr_service_qualification_bound': status.get('ocr_service_sha256') == service_hash,
        'missing_audited_environment_files': missing_environment,
        'scope': 'Pinned local OCR runtime and audited evidence; no native app binary or Python environment is bundled.',
    }


def verify_archive(archive_path, *, smoke_python=None):
    """Extract the staged archive and verify every regular file before delivery."""
    with tempfile.TemporaryDirectory(prefix='ocr-package-smoke-') as temp:
        with tarfile.open(archive_path, 'r:gz') as archive:
            for member in archive.getmembers():
                name = PurePosixPath(member.name)
                if (name.is_absolute() or '..' in name.parts or not name.parts
                        or name.parts[0] != 'poker-ocr' or not (member.isfile() or member.isdir())):
                    raise ValueError('Unsafe member in OCR archive')
            archive.extractall(temp, filter='data')
        root = Path(temp) / 'poker-ocr'
        checksums = json.loads((root / 'SHA256SUMS.json').read_text())
        files = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
        if files != set(checksums) | {'SHA256SUMS.json'}:
            raise ValueError('Archive inventory differs from its integrity manifest')
        for name, digest in checksums.items():
            require_hash(relative_file(root, name), digest, 'archive ' + name)
        smoke = {'service_import_and_freeze_check': 'not_requested'}
        if smoke_python is not None:
            script = '''import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root / 'dev_tools/training'))
import ocr_service
from realtime_collector import verify_frozen_runtime
runtime = root / 'runtime'
regions = json.loads((runtime / 'regions.json').read_text())
colors = json.loads((runtime / 'colors.json').read_text())
verify_frozen_runtime(runtime / 'freeze.json', runtime / 'models/general', runtime / 'models/names', regions, colors, 'gpu:0', 1.0)
print(json.dumps({'service_import_and_freeze_check': 'passed', 'model_session_created': False}))
'''
            result = subprocess.run([str(smoke_python), '-I', '-c', script, str(root)],
                                    cwd=temp, capture_output=True, text=True, timeout=60)
            if result.returncode:
                raise ValueError('Extracted service import/freeze smoke failed: ' + result.stderr[-4000:])
            smoke = json.loads(result.stdout)
            if smoke != {'service_import_and_freeze_check': 'passed', 'model_session_created': False}:
                raise ValueError('Unexpected extracted service smoke result')
        return {'files_verified': len(checksums), 'extraction_integrity_passed': True, **smoke}


def package_release(source, release, *, evidence_manifest=None, output=None, candidate=False, smoke_python=sys.executable, paddle_license=None):
    source, release = Path(source).resolve(), Path(release).resolve()
    evidence_manifest = evidence_manifest or release / 'evidence-manifest.json'
    frozen, entries, evidence_path, status = load_inputs(source, release, evidence_manifest, candidate)
    if not candidate and smoke_python is None:
        raise ValueError('Production packages require the extracted service smoke check')
    evidence_hash = sha256(evidence_path)
    destination = Path(output or release / ('poker-ocr-candidate.tar.gz' if candidate else 'poker-ocr-runtime.tar.gz')).resolve()
    checksum_path = destination.with_suffix(destination.suffix + '.sha256')
    if destination.exists() or checksum_path.exists():
        raise ValueError('Package output already exists; choose a new --output path')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ocr-package-', dir=destination.parent) as temp:
        package = Path(temp) / 'poker-ocr'
        for name in sorted(frozen['implementation_sha256']) + ['ocr_service.py']:
            target = package / 'dev_tools/training' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(relative_file(source, 'dev_tools/training/' + name), target)
        for name in ('lib/database.py', 'lib/ocr_contract.py', 'ocr_contract.json'):
            target = package / 'dev_tools' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(relative_file(source, 'dev_tools/' + name), target)
        runtime = package / 'runtime'
        runtime.mkdir()
        copied = set(entries) | {'freeze.json', 'runtime.json', 'regions.json', 'colors.json'}
        copied.update(f'models/{role}/{name}' for role in ('general', 'names')
                      for name in ('model.onnx', 'characters.json'))
        for name in sorted(copied):
            target = runtime / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(relative_file(release, name), target)
        shutil.copyfile(evidence_path, runtime / 'audited-evidence-manifest.json')
        shutil.copyfile(Path(paddle_license) if paddle_license else training_dir() / 'desktop-training/paddle-training-source/LICENSE',
                        package / 'PaddleOCR-LICENSE')
        (package / 'PACKAGE-STATUS.json').write_text(json.dumps(status, indent=2) + '\n')
        (package / 'README.md').write_text(LAUNCH_INSTRUCTIONS)
        launcher = package / 'launch-ocr.sh'
        launcher.write_text(LAUNCHER)
        launcher.chmod(0o755)
        for name, digest in entries.items():
            require_hash(runtime / name, digest, 'copied evidence ' + name)
        require_hash(runtime / 'audited-evidence-manifest.json', evidence_hash, 'copied audited manifest')
        for role in ('general', 'names'):
            require_hash(runtime / f'models/{role}/model.onnx', frozen['weights'][role], 'copied ' + role + ' model')
            require_hash(runtime / f'models/{role}/characters.json', frozen['characters_sha256'][role], 'copied ' + role + ' dictionary')
        for name, digest in {
            'dev_tools/lib/database.py': frozen['collector_validator_sha256'],
            'dev_tools/lib/ocr_contract.py': frozen['collector_contract_implementation_sha256'],
            'dev_tools/ocr_contract.json': frozen['validation_contract']['sha256'],
            'dev_tools/training/ocr_service.py': status['ocr_service_sha256'],
        }.items():
            require_hash(package / name, digest, 'copied ' + name)
        manifest = {p.relative_to(package).as_posix(): sha256(p)
                    for p in sorted(package.rglob('*')) if p.is_file()}
        (package / 'SHA256SUMS.json').write_text(json.dumps(manifest, indent=2) + '\n')
        staged_archive = Path(temp) / 'bundle.tar.gz'
        with tarfile.open(staged_archive, 'w:gz') as archive:
            archive.add(package, arcname='poker-ocr', recursive=True)
        smoke = verify_archive(staged_archive, smoke_python=smoke_python)
        # Recheck executing inputs after copying, catching a concurrent change
        # rather than shipping a package from a moving qualification target.
        after = load_inputs(source, release, evidence_manifest, candidate)
        if (after[0], after[1], after[3]) != (frozen, entries, status) or sha256(evidence_path) != evidence_hash:
            raise ValueError('Release inputs changed while packaging')
        for name in frozen['implementation_sha256']:
            require_hash(package / 'dev_tools/training' / name, frozen['implementation_sha256'][name], name)
        # The staging directory is on the output filesystem. An exclusive hard
        # link prevents overwriting an artifact created during verification.
        os.link(staged_archive, destination)
    digest = sha256(destination)
    with checksum_path.open('x') as checksum:
        checksum.write(digest + '  ' + destination.name + '\n')
    return {'archive': str(destination), 'sha256': digest, **smoke, **status}


def main():
    source = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, default=training_dir() / 'release-candidate')
    parser.add_argument('--paddle-license', type=Path, help='PaddleOCR LICENSE (defaults to XDG training source)')
    parser.add_argument('--evidence-manifest', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--candidate', action='store_true', help='Package an explicitly unqualified review candidate')
    parser.add_argument('--smoke-python', type=Path, default=Path(sys.executable), help='Qualified interpreter for extracted service import/freeze check; no model session is created')
    args = parser.parse_args()
    result = package_release(source, args.release, evidence_manifest=args.evidence_manifest,
                             output=args.output, candidate=args.candidate, smoke_python=args.smoke_python, paddle_license=args.paddle_license)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
