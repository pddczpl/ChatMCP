"""Real Git/filesystem regressions for the post-build clean-source gate."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('release_source', Path(__file__).parents[1] / 'verify-release-source.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ReleaseSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.ui = self.root / gate.UI
        self.ui.mkdir(parents=True)
        (self.ui / 'index.html').write_bytes(b'<script src="old.js"></script>\n')
        (self.ui / 'old.js').write_bytes(b'old')
        (self.root / 'README.md').write_bytes(b'Installer: ' + b'a' * 64 + b'\nOther text.\n')
        (self.root / 'runtime.js').write_bytes(b'original runtime\n')
        for args in [('init', '--quiet'), ('config', 'user.name', 'test'), ('config', 'user.email', 'test@example.invalid'),
                     ('config', 'core.autocrlf', 'false'), ('add', '.'), ('commit', '-m', 'fixture')]:
            gate.git(self.root, *args)
        self.head = gate.git(self.root, 'rev-parse', 'HEAD').decode().strip()
        (self.ui / 'old.js').unlink()
        (self.ui / 'index.html').write_bytes(b'<script src="fresh.js"></script>\n')
        (self.ui / 'fresh.js').write_bytes(b'fresh UI build\n')
        (self.root / 'installer').mkdir()
        (self.root / 'dist').mkdir()
        exe = self.root / 'dist/DatGoldSetup.exe'
        exe.write_bytes(b'test-only fake exe; never executed')
        self.checksum = gate.digest(exe.read_bytes())
        self.manifest = {'commit': self.head, 'assets': [{'name': exe.name, 'bytes': exe.stat().st_size, 'sha256': self.checksum}]}
        (self.root / 'dist/RELEASE-MANIFEST.json').write_text(json.dumps(self.manifest))
        self.package()

    def package(self, extra=None, backslash=False):
        with zipfile.ZipFile(self.root / 'installer/payload.zip', 'w') as z:
            for file in self.ui.iterdir():
                name = gate.UI + '/' + file.name
                z.writestr(name.replace('/', '\\') if backslash else name, file.read_bytes())
            if extra:
                z.writestr(*extra)

    def run_gate(self):
        return gate.verify(self.root, self.root / 'evidence', self.head)

    def test_reproduce_tracked_vite_diff_then_validate_and_restore(self):
        before = subprocess.run(['git', '-C', str(self.root), 'diff', '--exit-code'], capture_output=True)
        self.assertEqual(before.returncode, 1, 'Original release gate must reproduce the failure')
        exe = (self.root / 'dist/DatGoldSetup.exe').read_bytes()
        report = self.run_gate()
        self.assertEqual(report['result'], 'PASS')
        self.assertEqual({f['path'] for f in report['uiFiles']}, {'index.html', 'fresh.js'})
        self.assertEqual(gate.git(self.root, 'diff', '--exit-code'), b'')
        self.assertEqual((self.root / 'dist/DatGoldSetup.exe').read_bytes(), exe)

    def test_readme_checksum_only_is_recorded(self):
        p = self.root / 'README.md'
        p.write_bytes(p.read_bytes().replace(b'a' * 64, self.checksum.encode()))
        self.run_gate()
        self.assertIn(b'a' * 64, p.read_bytes())
        self.assertIn(self.checksum.encode(), (self.root / 'evidence/generated-readme-checksum.patch').read_bytes())

    def test_readme_unrelated_change_rejected(self):
        p = self.root / 'README.md'
        p.write_bytes(p.read_bytes() + b'unexpected edit')
        with self.assertRaisesRegex(ValueError, 'README'):
            self.run_gate()
        self.assertTrue(p.read_bytes().endswith(b'unexpected edit'))

    def test_runtime_source_change_not_restored(self):
        (self.root / 'runtime.js').write_bytes(b'bad change')
        with self.assertRaisesRegex(ValueError, 'tracked source'):
            self.run_gate()
        self.assertEqual((self.root / 'runtime.js').read_bytes(), b'bad change')

    def test_staged_change_rejected(self):
        gate.git(self.root, 'add', '-u')
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_gate()

    def test_payload_content_mismatch_rejected(self):
        (self.ui / 'fresh.js').write_bytes(b'different UI!!\n')
        with self.assertRaises(ValueError):
            self.run_gate()

    def test_payload_extra_file_rejected(self):
        self.package((gate.UI + '/stale.js', b'stale'))
        with self.assertRaises(ValueError):
            self.run_gate()

    def test_payload_missing_file_rejected(self):
        with zipfile.ZipFile(self.root / 'installer/payload.zip', 'w') as z:
            z.writestr(gate.UI + '/index.html', (self.ui / 'index.html').read_bytes())
        with self.assertRaises(ValueError):
            self.run_gate()

    def test_windows_archive_separators_supported(self):
        self.package(backslash=True)
        self.assertEqual(self.run_gate()['result'], 'PASS')

    def test_normalized_duplicate_rejected(self):
        self.package(((gate.UI + '/fresh.js').replace('/', '\\'), b'fresh UI build\n'))
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.run_gate()

    def test_traversal_rejected(self):
        self.package(('outside/../escape', b'bad'))
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            self.run_gate()

    def test_installer_hash_mismatch_rejected(self):
        (self.root / 'dist/DatGoldSetup.exe').write_bytes(b'different')
        with self.assertRaisesRegex(ValueError, 'Installer'):
            self.run_gate()

    def test_wrong_commit_rejected(self):
        with self.assertRaisesRegex(ValueError, 'exact release commit'):
            gate.verify(self.root, self.root / 'evidence', '0' * 40)

    def test_exact_single_metadata_change(self):
        original = b'SHA ' + b'a' * 64 + b'\n'
        self.assertTrue(gate.metadata_update(original, original.replace(b'\n', b'\r\n'), self.checksum))
        self.assertFalse(gate.metadata_update(original, original.replace(b'a'*64, b'c'*64), self.checksum))
        self.assertFalse(gate.metadata_update(original*2, (original*2).replace(b'a'*64, self.checksum.encode()), self.checksum))


if __name__ == '__main__':
    unittest.main()
