"""Packaging checks exercise input drift, qualification gates and extraction."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

from package_ocr_release import RUNTIME_MODULES, load_inputs, package_release, sha256, verify_archive


class PackageFixture:
    def __init__(self, root):
        self.source = Path(root) / 'source'
        self.release = Path(root) / 'release'
        for name in RUNTIME_MODULES:
            text = '# Fixture runtime module\n'
            if name == 'realtime_collector.py':
                text = ('def verify_frozen_runtime(*args):\n'
                        '    assert args[-2:] == ("gpu:0", 1.0)\n')
            self.write(self.source / 'dev_tools/training' / name, text)
        self.write(self.source / 'dev_tools/training/ocr_service.py', '# No model initialization during import\n')
        self.write(self.source / 'dev_tools/lib/database.py', '# Fingerprinted code, never a source database\n')
        self.write(self.source / 'dev_tools/lib/ocr_contract.py', '# Fixture validation implementation\n')
        self.write(self.source / 'dev_tools/ocr_contract.json', {'version': 1})
        self.write(self.source / 'PaddleOCR-LICENSE', 'Fixture license\n')
        self.write(self.release / 'runtime.json', {'general_model': 'models/general', 'name_model': 'models/names',
                                                'regions': 'regions.json', 'colors': 'colors.json'})
        self.write(self.release / 'regions.json', {'screen_width': 1920, 'screen_height': 1080})
        self.write(self.release / 'colors.json', {'nameplate': '#192a35'})
        for role in ('general', 'names'):
            self.write(self.release / f'models/{role}/model.onnx', f'{role} fixture model\n')
            self.write(self.release / f'models/{role}/characters.json', ['A', ' '])
        regions = json.loads((self.release / 'regions.json').read_text())
        colors = json.loads((self.release / 'colors.json').read_text())
        self.freeze = {
            'implementation_sha256': {name: sha256(self.source / 'dev_tools/training' / name) for name in RUNTIME_MODULES},
            'collector_validator_sha256': sha256(self.source / 'dev_tools/lib/database.py'),
            'collector_contract_implementation_sha256': sha256(self.source / 'dev_tools/lib/ocr_contract.py'),
            'validation_contract': {'version': 1, 'sha256': sha256(self.source / 'dev_tools/ocr_contract.json')},
            'configuration_fingerprint': hashlib.sha256(json.dumps([regions, colors], sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'weights': {role: sha256(self.release / f'models/{role}/model.onnx') for role in ('general', 'names')},
            'characters_sha256': {role: sha256(self.release / f'models/{role}/characters.json') for role in ('general', 'names')},
            'policy': {'views': [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]],
                       'temporal_observations': 2, 'maximum_temporal_gap_seconds': 1.5,
                       'name_confidence_threshold': None, 'automatic_glyph_repair': False,
                       'maximum_result_age_seconds': 1.0},
        }
        self.write(self.release / 'freeze.json', self.freeze)
        self.status = {'production_qualified': False, 'remaining_gates': ['fresh native and GUI'],
                       'freeze_sha256': sha256(self.release / 'freeze.json')}
        self.refresh()

    @staticmethod
    def write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2) + '\n' if isinstance(value, (dict, list)) else value)

    def refresh(self):
        self.write(self.release / 'acceptance-status.json', self.status)
        files = [p for p in self.release.rglob('*') if p.is_file() and p.name != 'evidence-manifest.json']
        self.manifest = {'sha256': {p.relative_to(self.release).as_posix(): sha256(p) for p in files}}
        self.write(self.release / 'evidence-manifest.json', self.manifest)

    def qualify(self):
        self.status.update(production_qualified=True, remaining_gates=[],
                           ocr_service_sha256=sha256(self.source / 'dev_tools/training/ocr_service.py'),
                           evidence_references={key: key + '.json' for key in ('fresh_accuracy', 'native_latency', 'gui_receipt')})
        for name in self.status['evidence_references'].values():
            self.write(self.release / name, {'scope': 'Synthetic packaging test, no optical claim'})
        self.write(self.release / 'requirements-runtime.lock.txt', 'fixture==1\n')
        self.write(self.release / 'runtime-environment.json', {'scope': 'synthetic packaging fixture'})
        self.refresh()


class PackageReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = PackageFixture(self.temp.name)

    def test_candidate_keeps_unqualified_status_and_all_audited_files(self):
        f = self.fixture
        self.write_extra(f)
        result = package_release(f.source, f.release, paddle_license=f.source / 'PaddleOCR-LICENSE', candidate=True)
        self.assertEqual(result['package_status'], 'CANDIDATE')
        self.assertFalse(result['production_qualified'])
        self.assertEqual(result['service_import_and_freeze_check'], 'passed')
        self.assertFalse(result['model_session_created'])
        with tarfile.open(result['archive']) as archive:
            status = json.load(archive.extractfile('poker-ocr/PACKAGE-STATUS.json'))
            self.assertFalse(status['source_acceptance_status']['production_qualified'])
            self.assertEqual(set(status['missing_audited_environment_files']), {'requirements-runtime.lock.txt', 'runtime-environment.json'})
            manifest = json.load(archive.extractfile('poker-ocr/SHA256SUMS.json'))
            for name in RUNTIME_MODULES:
                self.assertIn('dev_tools/training/' + name, manifest)
            self.assertIn('runtime/review/truth-seal.json', manifest)
            self.assertIn('dev_tools/training/ocr_service.py', manifest)
            self.assertIn('README.md', manifest)
            self.assertIn('launch-ocr.sh', manifest)
        self.assertEqual(sha256(result['archive']), result['sha256'])
        self.assertEqual(verify_archive(result['archive'])['files_verified'], result['files_verified'])

    @staticmethod
    def write_extra(f):
        f.write(f.release / 'review/truth-seal.json', {'scope': 'synthetic blind review seal'})
        f.refresh()

    def test_unqualified_production_rejected_without_writing_archive(self):
        f = self.fixture
        with self.assertRaisesRegex(ValueError, 'qualification is incomplete'):
            package_release(f.source, f.release, paddle_license=f.source / 'PaddleOCR-LICENSE')
        self.assertFalse((f.release / 'poker-ocr-runtime.tar.gz').exists())

    def test_production_requires_each_audited_evidence_role(self):
        f = self.fixture
        f.qualify()
        del f.status['evidence_references']['gui_receipt']
        f.refresh()
        with self.assertRaisesRegex(ValueError, 'gui_receipt'):
            load_inputs(f.source, f.release, f.release / 'evidence-manifest.json', False)

    def test_qualified_synthetic_fixture_packages_with_extracted_import_smoke(self):
        f = self.fixture
        f.qualify()
        result = package_release(f.source, f.release, paddle_license=f.source / 'PaddleOCR-LICENSE')
        self.assertEqual(result['package_status'], 'PRODUCTION_QUALIFIED')
        self.assertTrue(result['extraction_integrity_passed'])
        self.assertEqual(result['service_import_and_freeze_check'], 'passed')
        self.assertTrue(result['ocr_service_qualification_bound'])

    def test_production_requires_bound_transport_and_current_environment(self):
        f = self.fixture
        f.qualify()
        del f.status['ocr_service_sha256']
        f.refresh()
        with self.assertRaisesRegex(ValueError, 'transport source'):
            load_inputs(f.source, f.release, f.release / 'evidence-manifest.json', False)
        f.qualify()
        f.manifest['sha256'].pop('runtime-environment.json')
        f.write(f.release / 'evidence-manifest.json', f.manifest)
        with self.assertRaisesRegex(ValueError, 'runtime environment'):
            load_inputs(f.source, f.release, f.release / 'evidence-manifest.json', False)

    def test_source_model_contract_and_evidence_drift_rejected(self):
        for name in ('source/dev_tools/training/seat_admission.py', 'release/models/names/model.onnx',
                     'source/dev_tools/ocr_contract.json', 'release/colors.json', 'release/acceptance-status.json'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                f = PackageFixture(temp)
                p = Path(temp) / name
                p.write_text(p.read_text() + ' ')
                with self.assertRaises(ValueError):
                    load_inputs(f.source, f.release, f.release / 'evidence-manifest.json', True)

    def test_unsupported_freshness_policy_and_wrong_status_freeze_binding_rejected(self):
        f = self.fixture
        f.freeze['policy']['maximum_result_age_seconds'] = 2.0
        f.write(f.release / 'freeze.json', f.freeze)
        f.status['freeze_sha256'] = sha256(f.release / 'freeze.json')
        f.refresh()
        with self.assertRaisesRegex(ValueError, 'decision policy'):
            load_inputs(f.source, f.release, f.release / 'evidence-manifest.json', True)
        f.freeze['policy']['maximum_result_age_seconds'] = 1.0
        f.write(f.release / 'freeze.json', f.freeze)
        f.refresh()
        with self.assertRaisesRegex(ValueError, 'freeze binding'):
            load_inputs(f.source, f.release, f.release / 'evidence-manifest.json', True)

    def test_manifest_escape_and_symlink_are_rejected(self):
        f = self.fixture
        f.manifest['sha256']['../outside'] = '0' * 64
        f.write(f.release / 'evidence-manifest.json', f.manifest)
        with self.assertRaisesRegex(ValueError, 'escapes'):
            load_inputs(f.source, f.release, f.release / 'evidence-manifest.json', True)
        f.refresh()
        (f.release / 'link').symlink_to(f.release / 'colors.json')
        f.manifest['sha256']['link'] = sha256(f.release / 'colors.json')
        f.write(f.release / 'evidence-manifest.json', f.manifest)
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            load_inputs(f.source, f.release, f.release / 'evidence-manifest.json', True)

    def test_existing_archive_is_preserved(self):
        f = self.fixture
        output = f.release / 'poker-ocr-candidate.tar.gz'
        output.write_bytes(b'prior artifact')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            package_release(f.source, f.release, paddle_license=f.source / 'PaddleOCR-LICENSE', candidate=True)
        self.assertEqual(output.read_bytes(), b'prior artifact')

    def test_import_failure_does_not_publish_archive(self):
        f = self.fixture
        f.write(f.source / 'dev_tools/training/ocr_service.py', 'raise RuntimeError("broken extracted service")\n')
        with self.assertRaisesRegex(ValueError, 'import/freeze smoke failed'):
            package_release(f.source, f.release, paddle_license=f.source / 'PaddleOCR-LICENSE', candidate=True)
        self.assertFalse((f.release / 'poker-ocr-candidate.tar.gz').exists())

    def test_moving_evidence_during_packaging_fails_before_delivery(self):
        f = self.fixture
        real_verify = verify_archive
        def moving_verify(*args, **kwargs):
            result = real_verify(*args, **kwargs)
            self.write_extra(f)
            return result
        with mock.patch('package_ocr_release.verify_archive', side_effect=moving_verify):
            with self.assertRaisesRegex(ValueError, 'changed while packaging'):
                package_release(f.source, f.release, paddle_license=f.source / 'PaddleOCR-LICENSE', candidate=True)
        self.assertFalse((f.release / 'poker-ocr-candidate.tar.gz').exists())

    def test_archive_links_are_rejected_before_extraction(self):
        path = Path(self.temp.name) / 'unsafe.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            member = tarfile.TarInfo('poker-ocr/escape')
            member.type = tarfile.SYMTYPE
            member.linkname = '/tmp/elsewhere'
            archive.addfile(member)
        with self.assertRaisesRegex(ValueError, 'Unsafe member'):
            verify_archive(path)

    def extracted_candidate(self):
        f = self.fixture
        result = package_release(f.source, f.release, paddle_license=f.source / 'PaddleOCR-LICENSE', candidate=True)
        extracted = Path(self.temp.name) / 'extracted bundle with spaces'
        extracted.mkdir()
        with tarfile.open(result['archive']) as archive:
            archive.extractall(extracted, filter='data')
        return extracted / 'poker-ocr'

    def test_launcher_uses_its_bundle_and_preserves_arguments_and_environment(self):
        bundle = self.extracted_candidate()
        executable = Path(self.temp.name) / 'native app with spaces'
        executable.write_text('#!' + sys.executable + '\n'
            'import json, os, sys\n'
            'print(json.dumps({"argv":sys.argv[1:], "release":os.environ["POKER_OCR_RELEASE"], '
            '"service":os.environ["POKER_OCR_SERVICE"], "python":os.environ["POKER_OCR_PYTHON"], '
            '"sentinel":os.environ["OCR_LAUNCH_TEST_SENTINEL"]}))\n')
        executable.chmod(0o755)
        launcher = bundle / 'launch-ocr.sh'
        self.assertTrue(os.access(launcher, os.X_OK))
        arguments = ['--label', 'two words', '', 'literal $(do not execute)', '*.png', '--']
        environment = dict(os.environ, POKER_OCR_RELEASE='/wrong/release',
                           POKER_OCR_SERVICE='/wrong/service', POKER_OCR_PYTHON='/wrong/python',
                           OCR_LAUNCH_TEST_SENTINEL='keep inherited environment')
        result = subprocess.run([str(launcher), sys.executable, str(executable), *arguments],
                                cwd=self.temp.name, env=environment, capture_output=True, text=True, check=True)
        output = json.loads(result.stdout)
        self.assertEqual(output, {'argv': arguments, 'release': str(bundle / 'runtime'),
                                 'service': str(bundle / 'dev_tools/training/ocr_service.py'),
                                 'python': sys.executable, 'sentinel': 'keep inherited environment'})

    def test_launcher_rejects_missing_relative_or_nonexecutable_paths(self):
        bundle = self.extracted_candidate()
        launcher = bundle / 'launch-ocr.sh'
        nonexecutable = Path(self.temp.name) / 'not executable'
        nonexecutable.write_text('not an executable')
        for arguments in ([], [sys.executable], ['python', sys.executable],
                          [sys.executable, 'relative-app'], [sys.executable, str(nonexecutable)]):
            with self.subTest(arguments=arguments):
                result = subprocess.run([str(launcher), *arguments], cwd=self.temp.name,
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 64)
                self.assertTrue(result.stderr)


if __name__ == '__main__':
    unittest.main()
