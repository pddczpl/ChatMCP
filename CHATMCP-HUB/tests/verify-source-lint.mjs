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
    if (!await fs.stat(root).catch(() => null)) { console.log(`  --  ${path.relative(repoRoot, root)} was not found next to CHATMCP-HUB: not scanned`); continue; }
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

console.log(`PASS: ${checks} source lint checks`);
