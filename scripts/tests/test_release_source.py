"""Real Git/filesystem regressions for the post-build clean-source gate."""
import base64
import hashlib
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

# Two public keys made for these tests (EC P-256, SPKI in base64); their private halves were thrown away when they were made. They stand in for the release key, which does not exist yet.
KEY_A = {'kid': 'e11e758c', 'use': 'release', 'spki': 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEflNjYxuvc7+NKyC5QcqIyOsd7auboQ8MjHVt+YV6j0vM+JTIpqtiTEpuZ28R6nzHnC/TJCA1mLW+OW2PuWTCiA=='}
KEY_B = {'kid': '8a068044', 'use': 'release', 'spki': 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEGudFon9H4Q2MQt9+v+lLT7qPIVv5Bs3/h0oJQSSWRUe+WD5bk4FQuFn4QhqIHK6ZbAnQTMMXJK+7fhA+eO1zUQ=='}
PLACEHOLDER = {'kid': '00000000', 'use': 'placeholder', 'spki': None}


def key_file(*entries, **overrides):
    document = {'version': 1, 'algorithm': 'ES256', 'keys': list(entries)}
    document.update(overrides)
    return json.dumps(document, indent=2) + '\n'


def entry_for(der: bytes, use='release'):
    return {'kid': hashlib.sha256(der).hexdigest()[:8], 'use': use, 'spki': base64.b64encode(der).decode()}


class ReleaseSourceTests(unittest.TestCase):
    def setUp(self):
        self.build(key_file(KEY_A, KEY_B))

    def build(self, keys_text):
        """A fixture repository whose release commit holds this text as the key file."""
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.ui = self.root / gate.UI
        self.ui.mkdir(parents=True)
        (self.ui / 'index.html').write_bytes(b'<script src="old.js"></script>\n')
        (self.ui / 'old.js').write_bytes(b'old')
        (self.root / 'README.md').write_bytes(b'Installer: ' + b'a' * 64 + b'\nOther text.\n')
        (self.root / 'runtime.js').write_bytes(b'original runtime\n')
        if keys_text is not None:
            (self.root / gate.KEYS).parent.mkdir(parents=True, exist_ok=True)
            (self.root / gate.KEYS).write_bytes(keys_text.encode('utf-8'))
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

    # ---- the key file of the release commit (CHATMCP-HUB/lib/release-keys.json): the updater of a release verifies the next one with these keys, so a release that ships a placeholder or a test key
    # would be an updater that can never update anything. The Hub's own suites accept the placeholder (normal CI stays green); this gate, which runs on the release commit, does not.
    def refused_keys(self, text, pattern):
        self.build(text)
        with self.assertRaisesRegex(ValueError, pattern):
            self.run_gate()

    def test_release_keys_are_recorded(self):
        report = self.run_gate()
        self.assertEqual(report['releaseKeys'], [{'kid': KEY_A['kid'], 'use': 'release'}, {'kid': KEY_B['kid'], 'use': 'release'}], 'the evidence names the keys the release ships with')
        self.assertEqual(report['result'], 'PASS')

    def test_one_key_is_enough_and_a_bom_is_tolerated(self):
        self.build('﻿' + key_file(KEY_A))
        self.assertEqual(self.run_gate()['releaseKeys'], [{'kid': KEY_A['kid'], 'use': 'release'}])

    def test_placeholder_rejected(self):
        self.refused_keys(key_file(PLACEHOLDER), 'placeholder')

    def test_placeholder_next_to_a_real_key_rejected(self):
        self.refused_keys(key_file(KEY_A, PLACEHOLDER), 'placeholder')

    def test_test_key_rejected(self):
        self.refused_keys(key_file(KEY_A, {**KEY_B, 'use': 'test'}), 'test')

    def test_any_other_use_rejected(self):
        for use in ('Release', 'signing', '', None):
            with self.subTest(use=use):
                self.refused_keys(key_file({**KEY_A, 'use': use}), 'use')

    def test_missing_key_file_rejected(self):
        self.build(None)
        with self.assertRaisesRegex(ValueError, 'key file'):
            self.run_gate()

    def test_damaged_key_file_rejected(self):
        # what the Hub's own reader (Node's JSON.parse and a strict `version !== 1`) refuses is refused here too: a gate that passes a file with which the shipped Hub trusts no key defeats its purpose
        node_refuses = (key_file(KEY_A).replace('"version": 1', '"version": true'), key_file(KEY_A).replace('"version": 1', '"version": "1"'),
                        key_file(KEY_A).replace('"algorithm": "ES256"', '"algorithm": "ES256", "note": NaN'), key_file(KEY_A).replace('"algorithm": "ES256"', '"algorithm": "ES256", "note": Infinity'),
                        key_file(KEY_A).replace('"algorithm": "ES256"', '"algorithm": "ES256", "note": -Infinity'))
        for text in ('{ nope', '', '[]', 'null', key_file(KEY_A, version=2), key_file(KEY_A, algorithm='RS256'), json.dumps({'version': 1, 'algorithm': 'ES256', 'keys': 'x'}), key_file(), *node_refuses):
            with self.subTest(text=text[:30]):
                self.refused_keys(text, 'key file')

    def test_too_many_keys_rejected(self):
        self.refused_keys(key_file(KEY_A, KEY_B, KEY_A, KEY_B, KEY_A), 'at most')  # the room is four; the count is looked at before the keys are

    def test_entry_that_is_not_an_object_rejected(self):
        self.refused_keys(key_file(KEY_A, 5), 'key file')

    def test_kid_that_is_not_the_one_of_the_key_rejected(self):
        for kid in ('12345678', KEY_A['kid'].upper(), ''):  # KEY_A's id has letters in it, so its upper-case spelling is another string
            with self.subTest(kid=kid):
                self.refused_keys(key_file({**KEY_A, 'kid': kid}), 'kid')

    def test_duplicate_key_rejected(self):
        self.refused_keys(key_file(KEY_A, KEY_A), 'twice|duplicate')

    def test_key_that_is_not_canonical_base64_rejected(self):
        for spki in ('not base64!', KEY_A['spki'].rstrip('='), KEY_A['spki'][:40] + '\n' + KEY_A['spki'][40:], '', None, 5):
            with self.subTest(spki=spki):
                self.refused_keys(key_file({**KEY_A, 'spki': spki}), 'base64|spki')

    def test_key_that_is_not_a_p256_public_key_rejected(self):
        der = base64.b64decode(KEY_A['spki'])
        compressed = bytes.fromhex('3039301306072a8648ce3d020106082a8648ce3d030107032200') + bytes([2 + (der[-1] & 1)]) + der[27:59]
        another_curve = der[:22] + bytes([0x22]) + der[23:]  # the last byte of the curve's identifier (07, prime256v1) changed
        off_curve = der[:-1] + bytes([der[-1] ^ 1])  # a point that is not on the curve (the y coordinate changed)
        cases = {'a byte too many': der + b'\x00', 'a byte too few': der[:-1], 'a compressed point': compressed, 'another curve': another_curve, 'a point off the curve': off_curve,
                 'random bytes': bytes([7]) * 91, 'a header of something else': b'\x30' + der[1:5] + b'\x00' + der[6:]}
        for label, bad in cases.items():
            with self.subTest(label):
                self.refused_keys(key_file(entry_for(bad)), 'P-256|SPKI|curve')

    def test_working_copy_of_the_key_file_does_not_count(self):
        self.build(key_file(PLACEHOLDER))
        (self.root / gate.KEYS).write_text(key_file(KEY_A), encoding='utf-8')  # a real key in the working tree only: the release commit still holds the placeholder
        with self.assertRaises(ValueError):
            self.run_gate()

    def test_p256_arithmetic_of_the_gate(self):
        der = base64.b64decode(KEY_A['spki'])
        self.assertTrue(gate.p256_point_on_curve(int.from_bytes(der[27:59], 'big'), int.from_bytes(der[59:91], 'big')))
        self.assertFalse(gate.p256_point_on_curve(int.from_bytes(der[27:59], 'big'), int.from_bytes(der[59:91], 'big') ^ 1))
        self.assertFalse(gate.p256_point_on_curve(0, 0))
        self.assertFalse(gate.p256_point_on_curve(gate.P256_P + 1, 1), 'coordinates are below the prime')


if __name__ == '__main__':
    unittest.main()
