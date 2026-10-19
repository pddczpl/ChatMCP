// Read Only must be read only: a corpus of bypass attempts, run through the REAL classifier, LocalTools and PermissionGate.
//
// v3.9.0 decided "read" by program name and then looked for a handful of bad flags. GNU sed's e/w/r commands, `sort -o`,
// `sort --compress-program`, `uniq IN OUT`, `file -C`, `rg --pre`, `find -fprint0`, `tree -o`, `less +!cmd`, `date -s` ... all ran
// in Read Only. Nothing in the older tests exercised those flags with real files and a real gate.
//
// 1. corpus integrity (>= 30 attacks, >= 30 benign commands)
// 2. classifier: no attack is read/edit/verify (so none is auto-allowed in Autonomous either); every benign command is read.
//    Attacks that need the file system (a wildcard that expands to secrets.json, to a junction out of the project) look like one
//    ordinary file to the text classifier by nature: they are marked needsFileSystem and caught by the real-path layer in step 3
// 3. gate: every attack is refused in Read Only without a prompt, and still needs a decision in Review and Autonomous;
//    >= 95% of the benign commands run unasked in Read Only (bash and PowerShell styles)
// 4. end to end: in Read Only the attacks leave NO marker/outside file behind; with the same commands approved in Review the files
//    DO appear (positive control, so "no file" means something); GNU sed --sandbox refuses the e command by itself
// 5. the sed script grammar and the option parser on their own
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { delay } from '../lib/runtime.mjs';
import { analyzeCommand } from '../lib/command-analysis.mjs';
import { checkSedScript, sedFileTargets } from '../lib/sed-script.mjs';
import { analyzeReadProgram } from '../lib/read-programs.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { PermissionGate } from '../lib/permissions.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the read-only corpus suite exceeded its own time budget'); process.exit(2); }, 240_000).unref();

const corpus = JSON.parse(await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'readonly-bypass-corpus.json'), 'utf8'));
const MODES = ['readonly', 'review', 'autonomous'];

// ------------------------------------------------------------------ 1. corpus integrity
{
  assert.ok(corpus.attacks.length >= 30, `need >= 30 attack vectors, have ${corpus.attacks.length}`);
  assert.ok(corpus.benign.length >= 30, `need >= 30 benign commands, have ${corpus.benign.length}`);
  const ids = corpus.attacks.map((attack) => attack.id);
  assert.equal(new Set(ids).size, ids.length, 'attack ids are unique');
  const required = [
    "sed '1e echo X > marker' a.txt", "sed '1r notes.txt' a.txt", "sed 's/a/b/w out-sed.txt' a.txt", 'sort -o out-sort.txt a.txt', 'sort --output=out-sort2.txt a.txt',
    'sort --compress-program=sh a.txt', 'uniq a.txt out-uniq.txt', 'file -C -m magic-x',
  ];
  for (const command of required) assert.ok(corpus.attacks.some((attack) => attack.command === command), `the corpus must contain: ${command}`);
  assert.ok(corpus.attacks.some((attack) => /^sed -n 'w \{OUTSIDE\}/.test(attack.command)), 'the corpus must contain a sed w to a path outside the workspace');
  ok(`corpus has ${corpus.attacks.length} attack vectors and ${corpus.benign.length} benign commands`);
}

const attackEntries = corpus.attacks.flatMap((attack) => (attack.shells ?? ['bash']).map((shell) => ({ ...attack, shell })));
const benignEntries = corpus.benign.flatMap((item) => (item.shells ?? ['bash']).map((shell) => ({ ...item, shell })));
const substitute = (text, { outside, work }) => text.replaceAll('{OUTSIDE}', outside.replaceAll('\\', '/')).replaceAll('{WORK}', work.replaceAll('\\', '/'));
const placeholders = { outside: path.join(os.tmpdir(), 'chatmcp-outside-demo'), work: path.join(os.tmpdir(), 'chatmcp-work-demo') };

// ------------------------------------------------------------------ 2. classifier
{
  const read = [];
  for (const attack of attackEntries) {
    if (attack.needsFileSystem) continue;
    const analysis = analyzeCommand(substitute(attack.command, placeholders), { shell: attack.shell });
    if (!['exec', 'dangerous'].includes(analysis.kind)) read.push(`[${attack.shell}] ${attack.id}: ${attack.command.replace(/\n/g, '\\n')} -> ${analysis.kind}`);
  }
  assert.deepEqual(read, [], `${read.length} attack vector(s) classified read/edit/verify (those run without a prompt in Read Only or Autonomous):\n${read.join('\n')}`);
  const textual = attackEntries.filter((attack) => !attack.needsFileSystem);
  ok(`0 of ${new Set(textual.map((attack) => attack.id)).size} text-level attack vectors (${textual.length} shell-style checks) classify as read, edit or verify; ${attackEntries.length - textual.length} wildcard/junction vectors are judged against the real file system`);

  const blocked = [];
  for (const item of benignEntries) {
    const analysis = analyzeCommand(substitute(item.command, placeholders), { shell: item.shell });
    if (analysis.kind !== 'read') blocked.push(`[${item.shell}] ${item.command} -> ${analysis.kind}: ${analysis.reasons.join(' | ')}`);
  }
  assert.deepEqual(blocked, [], `benign commands that stopped being read:\n${blocked.join('\n')}`);
  ok(`all ${benignEntries.length} benign shell-style checks still classify as read`);
}

// ------------------------------------------------------------------ real workspace + gate
async function makeWorld(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `chatmcp-corpus-${label}-`));
  const work = path.join(root, 'work');
  const outside = path.join(root, 'outside');
  const state = path.join(root, 'state');
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(state, { recursive: true });
  for (const [name, content] of Object.entries(corpus.workspaceFiles)) {
    await fs.mkdir(path.dirname(path.join(work, name)), { recursive: true });
    await fs.writeFile(path.join(work, name), content);
  }
  for (const [name, content] of Object.entries(corpus.outsideFiles ?? {})) await fs.writeFile(path.join(outside, name), content);
  let junctions = true;
  for (const junction of corpus.junctions ?? []) {
    try { await fs.symlink(outside, path.join(work, junction.name), process.platform === 'win32' ? 'junction' : 'dir'); } catch { junctions = false; }
  }
  const manager = { workspace: work, secrets: [] };
  const studio = new StudioWorkspace({ manager, directory: path.join(state, 'studio') });
  const localTools = new LocalTools({ workspace: studio, stateDirectory: state });
  const gate = new PermissionGate({ manager, workspace: studio, timeout: 60_000 });
  gate.attachLocalTools(localTools);
  return { root, work, outside, gate, localTools, junctions, paths: { outside, work } };
}

/** authorize() and report: allowed unasked ('allow'), asked ('prompt', answered with `approve`), or refused ('policy' / 'blocked' / 'deny'). */
async function outcome(gate, name, args, { approve = false } = {}) {
  const run = gate.authorize({ name, args, definition: {}, taskId: 'corpus' });
  let settled = null;
  run.then((value) => { settled = { value }; }, (thrown) => { settled = { thrown }; });
  for (let i = 0; i < 400 && !settled && gate.state().pending.length === 0; i += 1) await delay(5);
  if (settled?.thrown) return { kind: 'throw', error: settled.thrown };
  if (settled) {
    const last = gate.state().recent.at(-1);
    const refused = !settled.value.allowed;
    const kind = !refused ? 'allow' : last && last.toolName === name && ['blocked', 'policy'].includes(last.decision) ? last.decision : 'deny';
    return { kind, result: settled.value };
  }
  const pending = gate.state().pending;
  assert.equal(pending.length, 1, 'exactly one approval request');
  gate.decide(pending[0].id, approve);
  return { kind: 'prompt', result: await run, request: pending[0] };
}
const runArgs = (command, shell) => ({ command, shell, timeout_seconds: 30 });

const world = await makeWorld('gate');
try {
  // ---------------------------------------------------------------- 3. the real gate, three modes
  const surprises = [];
  for (const mode of MODES) {
    world.gate.configure({ mode });
    for (const attack of attackEntries) {
      if (attack.id === 'glob-through-junction' && !world.junctions) continue;
      const command = substitute(attack.command, world.paths);
      const result = await outcome(world.gate, 'local.run_command', runArgs(command, attack.shell), { approve: false });
      const acceptable = mode === 'readonly' ? ['policy', 'blocked'] : ['prompt', 'policy', 'blocked'];
      if (!acceptable.includes(result.kind)) surprises.push(`${mode} [${attack.shell}] ${attack.id}: ${result.kind}`);
    }
  }
  assert.deepEqual(surprises, [], `attack vectors that were not refused / not asked:\n${surprises.join('\n')}`);
  ok(`every attack vector is refused in Read Only without a prompt and needs a decision in Review and Autonomous (${attackEntries.length} x ${MODES.length} gate decisions)`);

  world.gate.configure({ mode: 'readonly' });
  const refusedBenign = [];
  let allowedBenign = 0;
  for (const item of benignEntries) {
    const result = await outcome(world.gate, 'local.run_command', runArgs(substitute(item.command, world.paths), item.shell), { approve: false });
    if (result.kind === 'allow') allowedBenign += 1; else refusedBenign.push(`[${item.shell}] ${item.command} -> ${result.kind}`);
  }
  const rate = allowedBenign / benignEntries.length;
  assert.ok(rate >= 0.95, `only ${(rate * 100).toFixed(1)}% of benign commands run in Read Only:\n${refusedBenign.join('\n')}`);
  ok(`${allowedBenign} of ${benignEntries.length} benign commands (${corpus.benign.length} distinct) run unasked in Read Only through the real gate: ${(rate * 100).toFixed(1)}%`);
  const bashOnly = benignEntries.filter((item) => item.shell === 'bash');
  assert.equal(bashOnly.length - refusedBenign.filter((line) => line.startsWith('[bash]')).length, bashOnly.length, 'every bash-style benign command runs');
} finally {
  await fs.rm(world.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

// ------------------------------------------------------------------ 4. end to end: refusal leaves nothing behind, the control proves it could have
async function shellHasGnuSed(local) {
  const probe = await local.call('run_command', { command: 'sed --version | head -1', shell: 'bash', timeout_seconds: 20 });
  return !probe.isError && /GNU sed/.test(probe.content?.[0]?.text ?? '');
}
const withEffect = attackEntries.filter((attack) => attack.shell === 'bash' && attack.effect);
const effectPath = (attack, paths) => path.resolve(paths.work, substitute(attack.effect, paths));

const readOnlyWorld = await makeWorld('readonly');
const controlWorld = await makeWorld('control');
try {
  const gnu = await shellHasGnuSed(readOnlyWorld.localTools);
  readOnlyWorld.gate.configure({ mode: 'readonly' });
  // The exact flow of the host: authorize first, execute only if allowed. Executing is what v3.9.0 did for these commands.
  let executed = 0;
  for (const attack of withEffect) {
    const args = runArgs(substitute(attack.command, readOnlyWorld.paths), 'bash');
    const decision = await outcome(readOnlyWorld.gate, 'local.run_command', args);
    assert.ok(['policy', 'blocked'].includes(decision.kind), `${attack.id}: Read Only must refuse (got ${decision.kind})`);
    if (decision.kind === 'allow') { await readOnlyWorld.localTools.call('run_command', args); executed += 1; }
  }
  assert.equal(executed, 0);
  for (const attack of withEffect) {
    await assert.rejects(fs.access(effectPath(attack, readOnlyWorld.paths)), `${attack.id}: Read Only must not create ${attack.effect}`);
  }
  assert.deepEqual((await fs.readdir(readOnlyWorld.outside)).sort(), Object.keys(corpus.outsideFiles ?? {}).sort(), 'nothing but the fixture may appear outside the workspace');
  assert.equal(await fs.readFile(path.join(readOnlyWorld.work, 'a.txt'), 'utf8'), corpus.workspaceFiles['a.txt'], 'a.txt is untouched');
  assert.equal(await fs.readFile(path.join(readOnlyWorld.work, '.env'), 'utf8'), corpus.workspaceFiles['.env']);
  ok(`Read Only through the gate: ${withEffect.length} attack commands refused, no marker file and nothing outside the workspace was created`);

  if (!gnu) {
    console.log('  skip - GNU sed is not the sed of this machine\'s bash: the positive control (the commands really create files) was not run');
  } else {
    // positive control: the same commands, approved in Review, DO create their files
    controlWorld.gate.configure({ mode: 'review' });
    const created = [];
    const missing = [];
    for (const attack of withEffect) {
      // a command that edits in place (sed -i) must not corrupt the next vector's input
      await fs.writeFile(path.join(controlWorld.work, 'a.txt'), corpus.workspaceFiles['a.txt']);
      const args = runArgs(substitute(attack.command, controlWorld.paths), 'bash');
      const decision = await outcome(controlWorld.gate, 'local.run_command', args, { approve: true });
      assert.equal(decision.kind, 'prompt', `${attack.id}: Review must ask`);
      assert.equal(decision.result.allowed, true);
      await controlWorld.localTools.call('run_command', args);
      const exists = await fs.access(effectPath(attack, controlWorld.paths)).then(() => true, () => false);
      (exists ? created : missing).push(attack.id);
    }
    // the wildcard vectors really print the protected / outside content when they are allowed to run
    const leaking = attackEntries.filter((attack) => attack.shell === 'bash' && attack.leaks && (attack.id !== 'glob-through-junction' || controlWorld.junctions));
    const skippedPrograms = [];
    for (const attack of leaking) {
      if (attack.requires) {
        const probe = await controlWorld.localTools.call('run_command', { command: `command -v ${attack.requires}`, shell: 'bash', timeout_seconds: 20 });
        if (probe.isError) { skippedPrograms.push(`${attack.id} (${attack.requires} not installed)`); continue; }
      }
      const args = runArgs(substitute(attack.command, controlWorld.paths), 'bash');
      const decision = await outcome(controlWorld.gate, 'local.run_command', args, { approve: true });
      assert.equal(decision.kind, 'prompt', `${attack.id}: Review must ask`);
      const result = await controlWorld.localTools.call('run_command', args);
      assert.ok(result.content[0].text.includes(attack.leaks), `positive control: ${attack.id} must print ${attack.leaks} when approved:
${result.content[0].text}`);
    }
    if (skippedPrograms.length) console.log(`  note - positive control not run for: ${skippedPrograms.join(', ')}`);
    // Read Only: the same commands are refused and print nothing (checked above through the gate); the text classifier alone cannot see them
    for (const attack of attackEntries.filter((entry) => entry.needsFileSystem && entry.shell === 'bash')) {
      assert.equal(analyzeCommand(substitute(attack.command, controlWorld.paths), { shell: 'bash' }).kind, 'read', `${attack.id}: documents that only the real-path layer catches this`);
    }
    const mustExist = ['sed-e-command', 'sed-w-outside', 'sed-s-w-flag', 'sort-o', 'sort-output-long', 'uniq-in-out', 'file-compile-magic', 'sort-glob-option-injection', 'find-fprint0'];
    for (const id of mustExist) assert.ok(created.includes(id), `positive control: ${id} must create its file when approved (created: ${created.join(', ')}; missing: ${missing.join(', ')})`);
    ok(`positive control: approved in Review the same commands DO create their files (${created.length} of ${withEffect.length}: ${created.slice(0, 6).join(', ')}, ...)`);

    // GNU sed's own sandbox refuses the e command, which is why --sandbox is accepted for any script
    const sandbox = analyzeCommand("sed --sandbox '1e echo X > marker-sandbox' a.txt", { shell: 'bash' });
    assert.equal(sandbox.kind, 'read');
    const sandboxWorld = readOnlyWorld;
    const args = runArgs("sed --sandbox '1e echo X > marker-sandbox' a.txt", 'bash');
    const decision = await outcome(sandboxWorld.gate, 'local.run_command', args);
    assert.equal(decision.kind, 'allow', 'sed --sandbox is read: Read Only runs it');
    const result = await sandboxWorld.localTools.call('run_command', args);
    assert.equal(result.isError, true, 'GNU sed --sandbox must reject the e command');
    assert.match(result.content[0].text, /sandbox/i);
    await assert.rejects(fs.access(path.join(sandboxWorld.work, 'marker-sandbox')), 'and it must not have run the command');
    ok('GNU sed --sandbox on this machine refuses the e command by itself: no marker, non-zero exit');
  }
} finally {
  await fs.rm(readOnlyWorld.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  await fs.rm(controlWorld.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

// ------------------------------------------------------------------ 5. the grammar and the parser on their own
{
  const safe = [
    'p', '1p', '1,3p', '$p', '/x/p', '/x/,/y/p', '2,/y/p', '5q', '5q3', 'Q', '3d', '=', '1!d', '$!d', '0~2p', '2~3d', '1,+2p', '/a/,~4p', '/a/Ip',
    's/a/b/', 's/a/b/g', 's/a/b/gp', 's/a/b/3', 's/a/b/I', 's|/usr|/opt|', 's#a#b#g', 's,a,b,', 's/a\\/b/c/', 's/[0-9]*/N/g', 's/a/b/;s/c/d/', 'p;p', '1d;$d',
    '/a/ s/b/c/', '\\,x,p', 's/\\n/ /g', 's/a/\\n/', ' 1p ', 'p\np',
  ];
  for (const script of safe) assert.equal(checkSedScript(script).ok, true, `sed script should be accepted: ${JSON.stringify(script)} (${checkSedScript(script).reason})`);
  const unsafe = [
    'e', '1e id', 'e id', 's/a/b/e', 's/a/b/ge', 's/a/b/w f', 's/a/b/gw f', 'w f', '1w f', 'W f', 'r f', '1r f', 'R f', 'F', 'a text', 'i text', 'c text', 'y/a/b/',
    '{p}', 'p;{', 'b', 't', 'l', 'n', 'N', 'D', 'P', 'h', 'H', 'g', 'G', 'x', 'z', '#comment', 's/a/b/;e id', 's/a/b/\ne id', 'p;e id', '1,3e id',
    's/[/]/x/', 's/a/b\\\nc/', 's/a/b', 's/a', 's', 'sxaxbx', 's;a;b;', 's/a/b/ w f', '/x/', '1', '1,', '1,3', '!', 'p p', 'p}', '1~p',
    's/a/b/\\ne id', '/[/]/p', '\\xp',
  ];
  for (const script of unsafe) assert.equal(checkSedScript(script).ok, false, `sed script should be refused: ${JSON.stringify(script)}`);
  ok(`sed grammar: ${safe.length} safe scripts accepted, ${unsafe.length} unsafe/ambiguous scripts refused`);

  const targets = sedFileTargets('1r .env\n$w out.txt\ns/a/b/gw other.txt');
  assert.deepEqual(targets.map((entry) => `${entry.op}:${entry.target}`), ['read:.env', 'write:out.txt', 'write:other.txt']);
  ok('sed r/R/w/W targets are extracted for the protected-path check');

  const kind = (command, shell = 'bash') => analyzeCommand(command, { shell }).kind;
  assert.equal(kind("sed '1r .env' a.txt"), 'exec', 'sed r of a protected file is not read');
  assert.equal(analyzeCommand("sed '1w .env' a.txt").kind, 'dangerous', 'sed w onto a protected file is dangerous');
  assert.equal(analyzeCommand("sed -i '1w .env' a.txt").kind, 'dangerous');
  assert.equal(kind("sed -n -e p .env"), 'exec', 'with -e every operand is a file; .env is protected');
  assert.equal(kind("sed -n '/x/p' f"), 'read', 'a script that looks like an absolute path is data, not a path');
  assert.equal(kind('grep "/api/" f'), 'read');
  assert.equal(kind("sed -i 's/a/b/' f"), 'edit', 'a plain in-place edit stays an edit');
  assert.equal(kind("sed --sandbox -i 's/a/b/' f"), 'edit', '--sandbox does not turn -i into a read');
  assert.equal(kind("sed -ni 's/a/b/p' f"), 'edit', '-ni is in-place');
  assert.equal(kind("sed -ie 's/a/b/' f"), 'edit', '-ie is in-place with suffix "e", not a script');
  assert.equal(kind('sed --sandbox -f s.sed f'), 'read', 'a script file is safe under --sandbox');
  assert.equal(kind('sed -f s.sed f'), 'exec');
  assert.equal(kind("sed -n -- 'p' f"), 'read');
  assert.equal(kind("sed -e p -- --sandbox"), 'read', 'a file named --sandbox after -- is an operand');
  assert.equal(kind("sed -e '1e id' -- --sandbox"), 'exec', 'a file named --sandbox must not switch the sandbox on');
  assert.equal(kind("sed -f --sandbox a"), 'exec', '--sandbox as the value of -f is not the sandbox option');
  assert.equal(kind('sort -o f a'), 'exec');
  assert.equal(kind('sort -- -o'), 'read', 'after -- the word -o is a file name');
  assert.equal(kind('sort -n -r a b'), 'read');
  assert.equal(kind('uniq -c a'), 'read');
  assert.equal(kind('uniq -f 1 a'), 'read');
  assert.equal(kind('uniq a b'), 'exec');
  assert.equal(kind('jq -n env'), 'exec');
  assert.equal(kind("jq '.env' data.json"), 'read', 'a field called env is not the env builtin');
  assert.equal(kind('jq . --slurpfile x ../s data.json'), 'exec');
  assert.equal(kind('wc --files0-from=.env'), 'exec');
  assert.equal(kind('file -b a'), 'read');
  assert.equal(kind('file -C -m x'), 'exec');
  assert.equal(kind('git grep -n TODO'), 'read');
  assert.equal(kind('git grep -Ocalc TODO'), 'exec');
  assert.equal(kind('git log --stat --format=%H'), 'read', 'ordinary long options are not mistaken for abbreviations of unsafe ones');
  assert.equal(kind('Sort-Object -Descending', 'powershell'), 'exec', 'unknown PowerShell cmdlets are still unclassified');
  assert.equal(kind('sort -r a.txt', 'powershell'), 'exec', 'PowerShell sort is its own cmdlet and keeps the old, stricter rules');
  assert.equal(analyzeReadProgram('echo', ['x']), null, 'programs without an allowlist are left to the old rules');
  ok('classifier details: protected targets, -ie, --sandbox positions, stdin/-- handling, jq field vs builtin, git abbreviations, PowerShell aliases');

  const files = analyzeCommand("sed -n -e p -e '2p' a.txt b.txt").segments[0].files;
  assert.deepEqual(files, ['a.txt', 'b.txt'], 'segments carry the real file operands');
  assert.deepEqual(analyzeCommand('grep -e x -f pats.txt a.txt').segments[0].files, ['pats.txt', 'a.txt']);
  assert.deepEqual(analyzeCommand('jq --rawfile x r.txt . d.json').segments[0].files, ['r.txt', 'd.json']);
  ok('segments expose the real file operands for the real-path check');
}

console.log(`PASS: ${checks} read-only corpus checks`);
process.exit(0);
