// Source lint for the "escaped newline swallowed by a comment" defect class.
//
// A physical source line that contains the two characters backslash + n followed by indentation and a // comment is almost always a
// block of code that was pasted with literal escape sequences: everything after the first // is a comment, so the statements that
// follow silently do not exist. v3.9.0 lost every installed skill this way (lib/agent.mjs, context.skillContext).
//
// The gate scans lib/**/*.mjs and hub.mjs. A negative control writes a file that contains the pattern into a temporary folder and
// requires the scanner to flag it, so the scanner cannot rot into a check that matches nothing.
//
// A second class: a Windows PowerShell child that a test or a script starts from node with the module path of the PowerShell 7 that started node (the
// release workflows run in pwsh) cannot find Get-FileHash and five more commands; the first publish run of v3.10.0 failed that way. Every file under tests/
// and scripts/ that names powershell.exe must use tests/support/powershell-environment.mjs, and the helper must do what it says on a real Windows PowerShell.
// The Hub is no different: a Hub that was started from a pwsh session passes the same module path to its children, so every file in lib/ and hub.mjs that names
// powershell.exe must use lib/powershell-environment.mjs (tests/support exports the same function).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { powerShellChildEnvironment } from '../lib/powershell-environment.mjs';
import { powerShell7ModuleStandIn, windowsPowerShellPath } from './support/powershell-environment.mjs';

const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// literal backslash, the letter n, at least one space or tab, then a // comment opener
const SWALLOWED_NEWLINE = new RegExp(String.raw`\\n[ \t]+//`);

async function* walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') yield* walk(full); }
    else if (entry.name.endsWith('.mjs')) yield full;
  }
}

export async function scan(files) {
  const matches = [];
  for (const file of files) {
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (SWALLOWED_NEWLINE.test(line)) matches.push({ file, line: index + 1, text: line.trim().slice(0, 120) });
    });
  }
  return matches;
}

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const files = [path.join(hubRoot, 'hub.mjs')];
for await (const file of walk(path.join(hubRoot, 'lib'))) files.push(file);
const found = await scan(files);
for (const match of found) console.log(`  not ok - ${path.relative(hubRoot, match.file)}:${match.line} ${match.text}`);
assert.equal(found.length, 0, `${found.length} source line(s) contain a literal backslash-n followed by spaces and "//"`);
ok(`no swallowed-newline lines in ${files.length} source files`);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-lint-control-'));
try {
  const seeded = path.join(temp, 'seeded.mjs');
  await fs.writeFile(seeded, 'const a = 1;\n        // note' + String.fromCharCode(92) + 'n        // swallowed\n        const b = 2;\n');
  const control = await scan([seeded]);
  assert.equal(control.length, 1, 'the scanner must flag the seeded violation');
  assert.equal(control[0].line, 2);
  const clean = path.join(temp, 'clean.mjs');
  await fs.writeFile(clean, "const text = 'a' + String.fromCharCode(10);\n// a normal comment\nconst url = 'http://example.test/a\\n';\n");
  assert.equal((await scan([clean])).length, 0, 'ordinary escapes and comments must not be flagged');
  ok('negative control: a seeded backslash-n-then-comment line is flagged, ordinary code is not');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A PowerShell child of a test or a script gets the module path of the machine, not the one of the PowerShell 7 that started node
// ---------------------------------------------------------------------------------------------------------------------------------
const STARTS_POWERSHELL = /powershell\.exe/i;
const USES_THE_HELPER = /\bpowerShellChildEnvironment\s*\(/; // a call: an import that nothing calls leaves the child with the environment as it was

/** Of `files`, those that name powershell.exe (`named`) and, among them, those that never use powerShellChildEnvironment (`missing`). */
export async function powerShellStarters(files) {
  const named = [];
  for (const file of files) if (STARTS_POWERSHELL.test(await fs.readFile(file, 'utf8'))) named.push(file);
  const missing = [];
  for (const file of named) if (!USES_THE_HELPER.test(await fs.readFile(file, 'utf8'))) missing.push(file);
  return { named, missing };
}

{
  const repoRoot = path.resolve(hubRoot, '..');
  // These two name powershell.exe only as the command of a request that the Windows Sandbox driver, its supervisor or the sandbox CLI runs in the guest: no PowerShell is
  // a child of node there. (real-blackbox-acceptance.mjs, in the same folder, does start one on the host, and uses the helper.)
  const guestCommands = ['smoke.mjs', 'real-guest.mjs'].map((name) => path.join(hubRoot, 'tests', 'windows-sandbox', name));
  const candidates = [];
  for (const root of [path.join(hubRoot, 'tests'), path.join(repoRoot, 'scripts')]) {
    if (!await fs.stat(root).catch(() => null)) { console.log(`  --  ${path.relative(repoRoot, root)} was not found next to DATGOLD-HUB: not scanned`); continue; }
    for await (const file of walk(root)) if (!guestCommands.includes(file)) candidates.push(file);
  }
  const { named, missing } = await powerShellStarters(candidates);
  for (const file of missing) console.log(`  not ok - ${path.relative(repoRoot, file)} names powershell.exe and does not call powerShellChildEnvironment (tests/support/powershell-environment.mjs)`);
  assert.deepEqual(missing.map((file) => path.relative(repoRoot, file)), [], 'a PowerShell child started from node must get env: powerShellChildEnvironment(...), or it inherits the module path of the PowerShell 7 that started node');
  ok(`all ${named.length} test and script files that name powershell.exe give their PowerShell child the environment of powerShellChildEnvironment (${candidates.length} files scanned)`);

  // the Hub's own code (lib/ and hub.mjs, read above): the same rule and the same helper, which lives in lib/powershell-environment.mjs
  {
    const product = await powerShellStarters(files);
    for (const file of product.missing) console.log(`  not ok - ${path.relative(repoRoot, file)} names powershell.exe and does not call powerShellChildEnvironment (lib/powershell-environment.mjs)`);
    assert.deepEqual(product.missing.map((file) => path.relative(repoRoot, file)), [], 'a PowerShell child that the Hub starts must get env: powerShellChildEnvironment(...), or a Hub that was started from a pwsh session hands the module path of PowerShell 7 to Windows PowerShell');
    ok(`all ${product.named.length} Hub files that name powershell.exe give their PowerShell child the environment of powerShellChildEnvironment (${files.length} files scanned)`);
  }

  const control = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-lint-ps-control-'));
  try {
    const seeded = path.join(control, 'seeded.mjs');
    await fs.writeFile(seeded, "import { spawnSync } from 'node:child_process';\nspawnSync('powershell.exe', ['-File', 'x.ps1'], { encoding: 'utf8' });\n");
    const guarded = path.join(control, 'guarded.mjs');
    await fs.writeFile(guarded, "import { spawnSync } from 'node:child_process';\nimport { powerShellChildEnvironment } from './support/powershell-environment.mjs';\nspawnSync('powershell.exe', ['-File', 'x.ps1'], { env: powerShellChildEnvironment() });\n");
    const unrelated = path.join(control, 'unrelated.mjs');
    await fs.writeFile(unrelated, "const shell = 'bash';\n");
    // the import alone is not the helper: a file that imports it and starts PowerShell with the environment as it is (the call was taken out) must be flagged too
    const importOnly = path.join(control, 'import-only.mjs');
    await fs.writeFile(importOnly, "import { spawnSync } from 'node:child_process';\nimport { powerShellChildEnvironment } from './support/powershell-environment.mjs';\nspawnSync('powershell.exe', ['-File', 'x.ps1'], { encoding: 'utf8' });\n");
    const result = await powerShellStarters([seeded, guarded, unrelated, importOnly]);
    assert.deepEqual(result.missing.map((file) => path.basename(file)), ['seeded.mjs', 'import-only.mjs'], 'the scanner must flag the seeded PowerShell child that has no helper, and the one that only imports it');
    assert.deepEqual(result.named.map((file) => path.basename(file)), ['seeded.mjs', 'guarded.mjs', 'import-only.mjs'], 'and must count the one that has it, and not the file that never starts PowerShell');
    ok('negative control: a seeded powershell.exe child without the helper, or with an import that nothing calls, is flagged; one with the call and a file without PowerShell are not');
  } finally {
    await fs.rm(control, { recursive: true, force: true });
  }

  // what the helper hands on: the environment it is given, without PSModulePath in any letter case
  const given = { PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', psmodulepath: 'lower case', Path: 'C:\\Windows', KEEP: 'kept', GONE: undefined };
  assert.deepEqual(powerShellChildEnvironment({ EXTRA: 'added' }, given), { Path: 'C:\\Windows', KEEP: 'kept', EXTRA: 'added' }, 'PSModulePath goes in any letter case; the rest stays; the extra is added');
  assert.equal(given.PSModulePath, 'C:\\Program Files\\PowerShell\\7\\Modules', 'the environment it was given is not changed');
  assert.deepEqual(Object.keys(powerShellChildEnvironment()).filter((name) => name.toLowerCase() === 'psmodulepath'), [], 'by default it starts from this process');
  ok('powerShellChildEnvironment drops PSModulePath in any letter case, keeps everything else, adds the extra and leaves its argument alone');

  // the trap itself, on the real Windows PowerShell: a stand-in for the module folder of PowerShell 7 hides Get-FileHash; the helper's environment does not
  const powershell = windowsPowerShellPath();
  if (process.platform !== 'win32' || !await fs.stat(powershell).catch(() => null)) {
    console.log('  --  Windows PowerShell is not here: the check against a real powershell.exe was not run');
  } else {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-lint-ps-modules-'));
    try {
      const modules = await powerShell7ModuleStandIn(folder, powershell);
      const probe = path.join(folder, 'probe.ps1');
      const lookup = "try { 'FOUND ' + (Get-FileHash -LiteralPath $env:ComSpec -Algorithm SHA256).Hash.Length } catch { 'MISSING' }";
      await fs.writeFile(probe, `${lookup}\r\n`);
      const poisoned = { ...process.env, PSModulePath: `${modules};${process.env.PSModulePath ?? ''}` };
      // two ways of being given code: a script file whose first command is Get-FileHash, and the encoded command the Hub's own shell runner uses, with a compiled cmdlet before it
      const invocations = {
        '-File, Get-FileHash first': ['-File', probe],
        '-EncodedCommand, ConvertFrom-Json first': ['-EncodedCommand', Buffer.from(`('{"a":1}' | ConvertFrom-Json).a | Out-Null; ${lookup}`, 'utf16le').toString('base64')],
      };
      const answer = (args, environment) => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
      for (const [label, args] of Object.entries(invocations)) {
        // the control child gets the poisoned environment as it is, on purpose; the other one gets what the helper makes of it
        const raw = answer(args, poisoned);
        assert.equal(raw.stdout.trim(), 'MISSING', `the control (${label}): with the module folder of PowerShell 7 first in PSModulePath, Windows PowerShell must lose Get-FileHash (or this check no longer reproduces the trap): ${raw.stdout}${raw.stderr}`);
        const guarded = answer(args, powerShellChildEnvironment({}, poisoned));
        assert.equal(guarded.stdout.trim(), 'FOUND 64', `with the environment of powerShellChildEnvironment the same child (${label}) finds Get-FileHash: ${guarded.stdout}${guarded.stderr}`);
      }
      ok('Windows PowerShell loses Get-FileHash behind the module folder of PowerShell 7 (as a script file, and as the encoded command of the Hub, after a compiled cmdlet), and finds it with the environment of powerShellChildEnvironment');
    } finally {
      await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The "Repository hygiene" step of CI, run offline: no tracked file outside the test and doc folders may hold a private-key header or a bearer token
// ---------------------------------------------------------------------------------------------------------------------------------
// .github/workflows/ci.yml greps the tracked files for those two shapes and fails the pull request on a match. The scan is textual: it takes a line that only DESCRIBES a header
// (the key tool tests for the header of an encrypted key with a regular expression written out in full) for a header, and PR #68 failed there after every suite here had passed.
// The same pattern and the same exclusions run here, so that a local run finds it before a push does; a second check fails if ci.yml and this file drift apart.
const HYGIENE_PATTERN = 'Authorization"?[:=] *"?Bearer [A-Za-z0-9._~+/=-]{24,}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----';
const HYGIENE_EXCLUDED = ['scripts/tests', 'DATGOLD-HUB/tests', 'docs', '.github'];

/** `path:line` of each tracked line under `cwd` that the hygiene pattern matches (git grep, as CI runs it; the text of the line is not kept: it may be a credential); null where git or a work tree is missing. */
export function hygieneMatches(cwd) {
  const run = spawnSync('git', ['grep', '-I', '-n', '-E', HYGIENE_PATTERN, '--', '.', ...HYGIENE_EXCLUDED.map((folder) => `:(exclude)${folder}`)], { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (run.error || (run.status !== 0 && run.status !== 1)) return null; // 0 = matches, 1 = none, anything else = git could not look
  return run.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split(':').slice(0, 2).join(':'));
}

{
  const repoRoot = path.resolve(hubRoot, '..');
  const workflow = await fs.readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8').catch(() => null);
  if (workflow === null) {
    console.log('  --  .github/workflows/ci.yml was not found next to DATGOLD-HUB: the hygiene pattern was not compared with it');
  } else {
    assert.ok(workflow.includes(`git grep -I -n -E '${HYGIENE_PATTERN}'`), 'the pattern of the "Repository hygiene" step in ci.yml is not the one tests/verify-source-lint.mjs runs: change both');
    for (const folder of HYGIENE_EXCLUDED) assert.ok(workflow.includes(`':(exclude)${folder}'`), `ci.yml no longer excludes ${folder} from the credential scan, or tests/verify-source-lint.mjs excludes one more than it: change both`);
    ok('the credential pattern and the excluded folders are the ones of the "Repository hygiene" step in ci.yml');
  }

  const found = hygieneMatches(repoRoot);
  if (found === null) {
    console.log('  --  git or a Git work tree is not here: the credential scan of the "Repository hygiene" step was not run');
  } else {
    for (const place of found) console.log(`  not ok - ${place} looks like a private-key header or a bearer token to the "Repository hygiene" step of CI (write a regular expression that describes the header, such as -{5}BEGIN ..., not the header itself)`);
    assert.deepEqual(found, [], 'a tracked file outside the test and doc folders has a line that CI "Repository hygiene" takes for a credential');
    ok(`no tracked file outside ${HYGIENE_EXCLUDED.join(', ')} has a line that looks like a private-key header or a bearer token (${repoRoot})`);
  }

  // negative control, in a throwaway repository: the scan flags both shapes outside the excluded folders, and flags neither inside them nor a regular expression that describes the header
  const control = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-lint-hygiene-'));
  try {
    const git = (args) => spawnSync('git', args, { cwd: control, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const files = {
      'lib/encrypted-header.mjs': 'const encrypted = /-----BEGIN ENCRYPTED PRIVATE KEY-----/;\n', // the defect of PR #68
      'lib/plain-header.mjs': "const pem = '-----BEGIN PRIVATE KEY-----';\n",
      'lib/bearer.mjs': "const header = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789';\n",
      'lib/described.mjs': 'const encrypted = /-{5}BEGIN ENCRYPTED PRIVATE KEY-{5}/;\n', // the repair: describes the header, is not one
      'lib/short-bearer.mjs': "const header = 'Authorization: Bearer short';\n",
      'DATGOLD-HUB/tests/fixture.mjs': "const pem = '-----BEGIN PRIVATE KEY-----';\n",
      'scripts/tests/fixture.py': "pem = '-----BEGIN PRIVATE KEY-----'\n",
      'docs/example.md': '-----BEGIN PRIVATE KEY-----\n',
      '.github/workflows/example.yml': "run: echo '-----BEGIN PRIVATE KEY-----'\n",
    };
    if (git(['init', '-q']).status !== 0) {
      console.log('  --  git could not make a repository here: the negative control of the credential scan was not run');
    } else {
      for (const [name, text] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(control, name)), { recursive: true });
        await fs.writeFile(path.join(control, name), text);
      }
      assert.equal(git(['add', '-A']).status, 0, 'the seeded files can be staged');
      const seeded = hygieneMatches(control);
      assert.deepEqual(seeded, ['lib/bearer.mjs:1', 'lib/encrypted-header.mjs:1', 'lib/plain-header.mjs:1'], 'the scan must flag the two private-key headers and the bearer token, and nothing else: not the described header, not a short token, not the excluded folders');
      ok('negative control: a seeded private-key header (plain and encrypted) and a seeded bearer token are flagged; a regular expression that describes the header, a short token and the excluded folders are not');
    }
  } finally {
    await fs.rm(control, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

console.log(`PASS: ${checks} source lint checks`);
