"""Checks the built release files against RELEASE-MANIFEST.json before anything is published.

The release workflow (.github/workflows/release.yml) runs this twice: in the `verify` job, which also runs in a dry run, and again in
the `publish` job right before the tag and the release are made, on the files downloaded from the same workflow run. It checks that
the manifest names this commit, this version and this Companion version; that it lists exactly the expected asset names (so an
old-named copy such as ChatMCP-Browser-Companion.zip cannot slip in); and that every file has the size and the SHA-256 the manifest
records and that its .sha256 file names the same digest.

Usage: python scripts/verify-release-assets.py --dist dist --commit SHA --version X.Y.Z --companion-version X.Y.Z
           --asset DatGoldSetup.exe --asset DatGold-Browser-Companion.zip
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

MANIFEST = 'RELEASE-MANIFEST.json'


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def verify(dist, commit, version, companion_version, asset_names):
    """Returns the list of problems; an empty list means the files may be published."""
    dist = Path(dist)
    problems = []
    try:
        manifest = json.loads((dist / MANIFEST).read_text(encoding='utf-8-sig'))
    except FileNotFoundError:
        return [f'{MANIFEST} is missing from {dist}']
    except (OSError, ValueError) as error:
        return [f'{MANIFEST} cannot be read: {error}']
    if not isinstance(manifest, dict):
        return [f'{MANIFEST} is not a JSON object']
    for key, expected in (('commit', commit), ('version', version), ('companionVersion', companion_version)):
        if manifest.get(key) != expected:
            problems.append(f'{MANIFEST}: {key} is {manifest.get(key)!r}, expected {expected!r}')
    records = manifest.get('assets')
    if not isinstance(records, list) or not all(isinstance(record, dict) for record in records):
        return problems + [f'{MANIFEST}: assets is not a list of objects']
    listed = [record.get('name') for record in records]
    if sorted(map(str, listed)) != sorted(asset_names) or len(set(listed)) != len(listed):
        problems.append(f'{MANIFEST}: asset names are {listed}, expected exactly {sorted(asset_names)}')
    for record in records:
        name = record.get('name')
        if name not in asset_names:
            continue
        file = dist / name
        if not file.is_file():
            problems.append(f'{name} is missing from {dist}')
            continue
        size = file.stat().st_size
        if size != record.get('bytes'):
            problems.append(f'{name}: {size} bytes, the manifest records {record.get("bytes")!r} bytes')
        actual = sha256_of(file)
        if actual != record.get('sha256'):
            problems.append(f'{name}: sha256 is {actual}, the manifest records {record.get("sha256")!r}')
        checksum = dist / (name + '.sha256')
        try:
            words = checksum.read_text(encoding='utf-8-sig').split()
        except FileNotFoundError:
            problems.append(f'{checksum.name} is missing from {dist}')
            continue
        if not words or words[0].lower() != actual:
            problems.append(f'{checksum.name} names {words[0] if words else "nothing"}, the file is {actual}')
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--dist', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--companion-version', required=True)
    parser.add_argument('--asset', action='append', required=True, dest='assets')
    args = parser.parse_args(argv)
    problems = verify(args.dist, args.commit, args.version, args.companion_version, args.assets)
    for problem in problems:
        print(f'verify-release-assets: {problem}', file=sys.stderr)
    if problems:
        return 1
    print(f'verify-release-assets: {len(args.assets)} assets match {MANIFEST} for v{args.version} at {args.commit}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
