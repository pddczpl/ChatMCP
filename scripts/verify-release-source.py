"""Verify generated release UI against the payload before restoring tracked output.

Vite's web/dist is tracked for source-checkout startup, but a fresh build may
replace its chunk names. That is output, not permission to change runtime source.
Only verified UI output and the existing README checksum are restored. Everything
else, including staged edits, still has to pass the original clean-source gate.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import zipfile

UI = 'CHATMCP-HUB/web/dist'
# The keys that sign RELEASE-MANIFEST.json (lib/release-signature.mjs). A release of the updater verifies the next release with the keys it ships, so a release whose key file still holds a
# placeholder, or a test key, is an updater that can never update anything: this gate, which runs on the release commit, refuses it. The Hub's own suites accept the placeholder, so normal CI stays green.
KEYS = 'CHATMCP-HUB/lib/release-keys.json'
MAX_KEYS = 4
# SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING } up to the 0x00 of the BIT STRING; then 0x04 and the 64 bytes of an uncompressed point: 91 bytes in all.
SPKI_HEADER = bytes.fromhex('3059301306072a8648ce3d020106082a8648ce3d030107034200')
SPKI_BYTES = 91
# secp256r1: y^2 = x^3 - 3x + b over the integers modulo P256_P
P256_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
P256_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(['git', '-C', str(root), *args])


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def no_link(path: Path) -> None:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('Linked release input is not allowed: ' + str(path))


def metadata_update(original: bytes, actual: bytes, checksum: str) -> bool:
    before, after = (data.replace(b'\r\n', b'\n') for data in (original, actual))
    if before == after:
        return True
    if not re.fullmatch(r'[0-9a-f]{64}', checksum):
        return False
    for match in re.finditer(rb'(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])', before):
        if before[:match.start()] + checksum.encode('ascii') + before[match.end():] == after:
            return True
    return False


def verify_ui(root: Path) -> list[dict]:
    ui = root / UI
    for parent in (root, root / 'CHATMCP-HUB', ui.parent, ui):
        no_link(parent)
    actual: dict[str, dict] = {}
    for folder, directories, files in os.walk(ui, followlinks=False):
        for name in directories + files:
            no_link(Path(folder) / name)
        for name in files:
            file = Path(folder) / name
            relative = file.relative_to(ui).as_posix()
            if ':' in relative or '\\' in relative or not file.is_file():
                raise ValueError('Unsafe UI file: ' + relative)
            data = file.read_bytes()
            actual[relative] = {'path': relative, 'bytes': len(data), 'sha256': digest(data)}
    if 'index.html' not in actual or not any(name.endswith('.js') for name in actual):
        raise ValueError('Fresh UI output is incomplete')
    folded = [name.casefold() for name in actual]
    if len(set(folded)) != len(folded):
        raise ValueError('Case-colliding UI files')
    payload = root / 'installer/payload.zip'
    no_link(payload.parent)
    no_link(payload)
    packaged: dict[str, dict] = {}
    with zipfile.ZipFile(payload) as archive:
        seen: set[str] = set()
        for entry in archive.infolist():
            name = entry.filename.replace('\\', '/')
            parts = name.rstrip('/').split('/')
            if not name or name.startswith('/') or ':' in name or any(p in ('', '.', '..') for p in parts):
                raise ValueError('Unsafe payload entry')
            if name.casefold() in seen:
                raise ValueError('Duplicate normalized payload entry')
            seen.add(name.casefold())
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('Linked payload entry')
            if not name.startswith(UI + '/') or entry.is_dir() or name.endswith('/'):
                continue
            relative = name[len(UI) + 1:]
            if relative not in actual or entry.file_size != actual[relative]['bytes']:
                raise ValueError('Payload UI file set/size differs: ' + relative)
            with archive.open(entry) as stream:
                checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
            packaged[relative] = {'path': relative, 'bytes': entry.file_size, 'sha256': checksum}
    if packaged != actual:
        raise ValueError('Fresh UI and installer payload hashes/file set differ')
    return [actual[name] for name in sorted(actual)]


def p256_point_on_curve(x: int, y: int) -> bool:
    """Whether (x, y) is a point of P-256: both coordinates below the prime, and on the curve."""
    if not (0 <= x < P256_P and 0 <= y < P256_P):
        return False
    return (y * y - (x * x * x - 3 * x + P256_B)) % P256_P == 0


def canonical_base64(value) -> bytes | None:
    """The bytes of canonical base64 (no white space, padding as written, no spare bits set); None for anything else."""
    if not isinstance(value, str) or not value or len(value) % 4:
        return None
    try:
        raw = base64.b64decode(value, validate=True)
    except ValueError:
        return None
    return raw if base64.b64encode(raw).decode('ascii') == value else None


def reject_json_constant(name: str):
    """Python's json accepts NaN and Infinity, which Node's JSON.parse (the Hub's reader of this file) refuses: the gate refuses them too."""
    raise ValueError(f'{name} is not JSON')


def verify_release_keys(root: Path, head: str) -> list[dict]:
    """The key file as the release commit holds it must list real release keys, and only those: at least one, at most MAX_KEYS, each an uncompressed P-256 point on the curve in its
    canonical SPKI form whose kid is the first 8 hex characters of the SHA-256 of the SPKI. A placeholder or a test key anywhere in it fails. Returns the keys for the evidence."""
    try:
        text = git(root, 'show', f'{head}:{KEYS}').decode('utf-8-sig')
    except subprocess.CalledProcessError:
        raise ValueError(f'The release commit has no key file ({KEYS}): the updater of this release could not verify the next one.') from None
    try:
        document = json.loads(text, parse_constant=reject_json_constant)
    except ValueError:
        raise ValueError(f'The key file ({KEYS}) is not JSON.') from None
    # `true == 1` in Python and not in the Hub's reader (`document.version !== 1`): a bool is not the version
    if not isinstance(document, dict) or type(document.get('version')) is not int or document.get('version') != 1:
        raise ValueError(f'The key file ({KEYS}) must be a JSON object with "version": 1.')
    if document.get('algorithm', 'ES256') != 'ES256':
        raise ValueError(f'The key file ({KEYS}) names an algorithm other than ES256.')
    entries = document.get('keys')
    if not isinstance(entries, list) or not entries:
        raise ValueError(f'The key file ({KEYS}) lists no keys: a release needs at least one.')
    if len(entries) > MAX_KEYS:
        raise ValueError(f'The key file ({KEYS}) lists {len(entries)} keys; at most {MAX_KEYS}.')
    found: list[dict] = []
    seen: set[str] = set()
    for index, entry in enumerate(entries, start=1):
        where = f'entry {index} of the key file'
        if not isinstance(entry, dict):
            raise ValueError(f'The {where} is not an object.')
        use = entry.get('use')
        if use == 'placeholder':
            raise ValueError(f'The key file still holds a placeholder ({where}): make the release key with scripts/new-release-key.mjs and put its entry there before releasing.')
        if use == 'test':
            raise ValueError(f'The key file holds a test key ({where}): a release ships release keys only.')
        if use != 'release':
            raise ValueError(f'The {where} has use {use!r}; only "release" is a key (use).')
        der = canonical_base64(entry.get('spki'))
        if der is None:
            raise ValueError(f'The {where} has a spki that is not canonical base64.')
        if len(der) != SPKI_BYTES or der[:len(SPKI_HEADER)] != SPKI_HEADER or der[len(SPKI_HEADER)] != 4:
            raise ValueError(f'The {where} is not an uncompressed EC P-256 public key in SPKI form ({SPKI_BYTES} bytes, the P-256 curve).')
        x = int.from_bytes(der[27:59], 'big')
        y = int.from_bytes(der[59:91], 'big')
        if not p256_point_on_curve(x, y):
            raise ValueError(f'The {where} is not a point of the P-256 curve.')
        kid = hashlib.sha256(der).hexdigest()[:8]
        if entry.get('kid') != kid:
            raise ValueError(f'The {where} has a kid that is not the first 8 hex characters of the SHA-256 of its key ({kid}).')
        if kid in seen:
            raise ValueError(f'The key file lists the key {kid} twice (duplicate).')
        seen.add(kid)
        found.append({'kid': kid, 'use': 'release'})
    return found


def verify(root: Path, evidence: Path, expected_commit: str) -> dict:
    root = root.resolve(strict=True)
    head = git(root, 'rev-parse', 'HEAD').decode().strip()
    if head != expected_commit:
        raise ValueError('Checkout is not the exact release commit')
    # Do not hide staged source/output changes or unrelated build mutations.
    git(root, 'diff', '--cached', '--exit-code')
    changed = [p for p in git(root, 'diff', '--name-only', '-z').decode('utf-8').split('\0') if p]
    if any(p != 'README.md' and not p.startswith(UI + '/') for p in changed):
        raise ValueError('Build changed tracked source outside README checksum/UI output')
    release_keys = verify_release_keys(root, head)
    manifest = json.loads((root / 'dist/RELEASE-MANIFEST.json').read_text(encoding='utf-8-sig'))
    if manifest['commit'] != head:
        raise ValueError('Release manifest commit mismatch')
    installer = root / 'dist/DatGoldSetup.exe'
    no_link(installer)
    with installer.open('rb') as stream:
        checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
    asset = next(a for a in manifest['assets'] if a['name'] == installer.name)
    if asset['sha256'] != checksum or asset['bytes'] != installer.stat().st_size:
        raise ValueError('Installer no longer matches release manifest')
    original = git(root, 'show', 'HEAD:README.md')
    no_link(root / 'README.md')
    if not metadata_update(original, (root / 'README.md').read_bytes(), checksum):
        raise ValueError('Unexpected README edit')
    files = verify_ui(root)
    report = {'result': 'PASS', 'commit': head, 'installerSha256': checksum,
              'generatedUiPrefix': UI, 'uiFiles': files, 'changedPaths': changed, 'releaseKeys': release_keys}
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / 'generated-ui.patch').write_bytes(git(root, 'diff', '--binary', '--', UI))
    (evidence / 'generated-readme-checksum.patch').write_bytes(git(root, 'diff', '--', 'README.md'))
    (evidence / 'source-provenance.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    # Packaging and actual EXE tests already completed against the FRESH UI.
    # Restore only its tracked checkout snapshot, never the tested EXE/payload.
    if git(root, 'ls-files', '-z', '--', UI):
        git(root, 'restore', '--source=HEAD', '--worktree', '--', UI)
    if 'README.md' in changed:
        git(root, 'restore', '--source=HEAD', '--worktree', '--', 'README.md')
    git(root, 'diff', '--exit-code')
    git(root, 'diff', '--cached', '--exit-code')
    print(f'PASS exact-commit source gate; {len(files)} fresh UI files match installer payload; no other source changes.')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    verify(args.root, args.evidence, args.commit)
