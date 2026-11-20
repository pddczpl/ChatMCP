// The release input resolver and the asset check, run from the Hub suites so that the CI matrix (Linux and Windows) runs them on every
// pull request that touches code.
//
// scripts/Resolve-ReleaseInputs.ps1 derives every value of a release for .github/workflows/release.yml, and scripts/verify-release-assets.py
// checks the built files before anything is published (docs/RELEASING.md). Their regression is the Python file
// scripts/tests/test_release_inputs.py (fixture trees: one wrong file at a time must be refused with a message that names it; the good tree
// must print the expected values). This suite runs that file and fails when a test fails or is skipped, so a machine without PowerShell
// cannot report a pass: under --no-skip a skip is a failure.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');
const TESTS = path.join(REPO, 'scripts', 'tests');
if (!existsSync(path.join(TESTS, 'test_release_inputs.py'))) {
  console.log('CHATMCP_TEST_SKIP: scripts/tests/test_release_inputs.py was not found next to DATGOLD-HUB (the release scripts need the whole repository)');
  process.exit(0);
}

const python = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', TESTS, '-p', 'test_release_inputs.py', '-v'], {
  cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 170_000, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
});
if (result.error?.code === 'ENOENT') {
  console.log(`CHATMCP_TEST_SKIP: ${python} is not installed`);
  process.exit(0);
}
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);
const ran = Number(/^Ran (\d+) tests? in /m.exec(output)?.[1] ?? 0);
const skipped = Number(/skipped=(\d+)/.exec(output)?.[1] ?? 0);
if (result.status !== 0 || ran === 0) {
  console.log(`FAIL: scripts/tests/test_release_inputs.py exited with ${result.status ?? result.signal} after ${ran} tests`);
  process.exit(1);
}
if (skipped > 0) {
  console.log(`CHATMCP_TEST_SKIP: ${skipped} of ${ran} release input tests were skipped (no PowerShell on this machine)`);
  process.exit(0);
}
console.log(`PASS: ${ran} release input and asset checks (scripts/tests/test_release_inputs.py)`);
