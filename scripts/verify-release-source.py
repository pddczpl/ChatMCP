"""Verify generated release UI against the payload before restoring tracked output.

Vite's web/dist is tracked for source-checkout startup, but a fresh build may
replace its chunk names. That is output, not permission to change runtime source.
Only verified UI output and the existing README checksum are restored. Everything
else, including staged edits, still has to pass the original clean-source gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import zipfile

UI = 'CHATMCP-HUB/web/dist'


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
              'generatedUiPrefix': UI, 'uiFiles': files, 'changedPaths': changed}
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
