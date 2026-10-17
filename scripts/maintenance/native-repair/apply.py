"""Apply reviewed source patches and report the exact test tree. Temporary."""
import base64
import gzip
import hashlib
import os
from pathlib import Path
import subprocess

folder = Path(__file__).resolve().parent
proof = Path(os.environ['RUNNER_TEMP']) / 'native-repair-evidence'
proof.mkdir(parents=True, exist_ok=True)
parts = ''.join((folder / f'part{i}.b64').read_text().strip() for i in range(1, 7))
for name, encoded, expected in [
    ('reviewed', parts, 'fed573acbf6b0a085b217692e3197a55536f9e8e62e1a1368d8d28363ec1c7bf'),
    ('overlay', (folder / 'overlay.b64').read_text().strip(), '36e1854ddb8de00fffdc6016fe1912fe61e0b728da79477e7fd8e16d468f2ee8'),
]:
    patch = gzip.decompress(base64.b64decode(encoded, validate=True))
    if hashlib.sha256(patch).hexdigest() != expected:
        raise RuntimeError('Patch transport mismatch: ' + name)
    file = proof / (name + '.patch')
    file.write_bytes(patch)
    subprocess.run(['git', 'apply', '--check', '--index', str(file)], check=True)
    subprocess.run(['git', 'apply', '--index', str(file)], check=True)
# Follow-up diffs are visible reviewed text, with git index preimage guards.
for file in sorted(folder.glob('fix[0-9][0-9].patch')):
    subprocess.run(['git', 'apply', '--check', '--index', str(file)], check=True)
    subprocess.run(['git', 'apply', '--index', str(file)], check=True)
subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
tree = subprocess.check_output(['git', 'write-tree'], text=True).strip()
(proof / 'source-tree.txt').write_text(tree + '\n')
if os.environ.get('GITHUB_OUTPUT'):
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        output.write('source_tree=' + tree + '\n')
print('Exact reviewed source tree: ' + tree)
