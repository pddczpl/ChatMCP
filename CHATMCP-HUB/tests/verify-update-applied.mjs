// The hand-over after an update: the installer writes a small result file (--result, format 1) and the Hub that runs next tells the page "Updated to x.y.z", or why the update did not go through
// (lib/update-applied.mjs). The installer of ANY later version may have written it, so the file is a contract across versions: this suite holds the Hub to the literal texts of
// tests/fixtures/update-result-vectors.json, which the native tests hold the installer to as well (scripts/tests/native-lifecycle/ContractTests.cs).
//
// What the module promises:
//   * the file is read ONCE, at start, and consumed (deleted) whatever it holds: a later start never announces it again, and a damaged one does not linger;
//   * what it says counts only for the version that runs: "updated" only in the version it updated to, "did not go through" only in a version older than the one it tried;
//   * the reason is a code of a closed list (the same twelve the installer writes); a code it does not know is shown as a failure to install, and no text of the file is ever shown;
//   * the file is read as data: at most 4 KiB, a regular file (a link is not followed), strict shape, consistent (ok, state and rolledBack must agree);
//   * the status is memory: reading it asks nothing of the disk or the network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppliedNote, REASONS, RESULT_FILE, STATES } from '../lib/update-applied.mjs';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vectors = JSON.parse(fs.readFileSync(path.join(HUB, 'tests', 'fixtures', 'update-result-vectors.json'), 'utf8'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-applied-'));
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
let counter = 0;
const freshDirectory = () => { const directory = path.join(scratch, `case-${counter += 1}`); fs.mkdirSync(directory); return directory; };
const shown = (note) => (note ? { ok: note.ok, version: note.version, previous: note.previous, state: note.state, reason: note.reason, rolledBack: note.rolledBack } : null);

try {
  assert.equal(RESULT_FILE, 'update-result.json', 'the file is next to the Hub\'s other data and is named as the shell says');
  assert.deepEqual([...STATES], ['installed', 'unchanged', 'rolled_back', 'needs_recovery']);
  assert.equal(REASONS.length, 12);
  ok('the file name, the four states and the twelve reasons');

  // ---- the vectors
  assert.ok(vectors.read.length >= 40, 'the list of cases is a long one');
  for (const item of vectors.read) {
    const directory = freshDirectory();
    const file = path.join(directory, RESULT_FILE);
    fs.writeFileSync(file, item.text);
    const lines = [];
    const note = createAppliedNote({ directory, currentVersion: item.running, log: (line) => lines.push(line) });
    await note.load();
    assert.deepEqual(shown(note.status()), item.expect, `${item.name} (running ${item.running})`);
    assert.equal(fs.existsSync(file), false, `${item.name}: the file is consumed whatever it held`);
    ok(`read: ${item.name}`);
  }

  // ---- what the installer writes is what the Hub reads
  for (const item of vectors.written) {
    const parsed = JSON.parse(item.text);
    const running = parsed.ok ? parsed.version : (parsed.previous ?? '3.10.2');
    const directory = freshDirectory();
    fs.writeFileSync(path.join(directory, RESULT_FILE), item.text);
    const note = createAppliedNote({ directory, currentVersion: running });
    await note.load();
    assert.deepEqual(shown(note.status()), { ok: parsed.ok, version: parsed.version, previous: parsed.previous, state: parsed.state, reason: parsed.reason, rolledBack: parsed.rolledBack }, item.name);
    ok(`written by the installer, read by the Hub: ${item.name}`);
  }

  // ---- once, and only once
  {
    const directory = freshDirectory();
    fs.writeFileSync(path.join(directory, RESULT_FILE), vectors.written[0].text);
    const first = createAppliedNote({ directory, currentVersion: '3.11.0' });
    await first.load();
    assert.ok(first.status());
    const second = createAppliedNote({ directory, currentVersion: '3.11.0' });
    await second.load();
    assert.equal(second.status(), null, 'a second start does not find it again');
    first.dismiss();
    assert.equal(first.status(), null, 'dismissing clears it');
    await first.load();
    assert.equal(first.status(), null, 'and it does not come back');
    const copy = createAppliedNote({ directory, currentVersion: '3.11.0' });
    fs.writeFileSync(path.join(directory, RESULT_FILE), vectors.written[0].text);
    await copy.load();
    const before = copy.status(); before.version = '9.9.9';
    assert.equal(copy.status().version, '3.11.0', 'the status is a copy: nobody can change the note by changing what they were given');
    ok('read once, consumed, dismissed, and the status is a copy');
  }

  // ---- the file as a thing on a disk
  {
    const directory = freshDirectory();
    const note = createAppliedNote({ directory: path.join(directory, 'no-such-folder'), currentVersion: '3.11.0' });
    await note.load();
    assert.equal(note.status(), null, 'no folder: nothing, and no error');
    const empty = createAppliedNote({ directory, currentVersion: '3.11.0' });
    await empty.load();
    assert.equal(empty.status(), null, 'no file: nothing, and no error');
    ok('no file and no folder are no news');
  }
  {
    const directory = freshDirectory();
    fs.mkdirSync(path.join(directory, RESULT_FILE));
    fs.writeFileSync(path.join(directory, RESULT_FILE, 'inside.txt'), 'x');
    const note = createAppliedNote({ directory, currentVersion: '3.11.0' });
    await note.load();
    assert.equal(note.status(), null);
    assert.ok(fs.existsSync(path.join(directory, RESULT_FILE, 'inside.txt')), 'a folder with the name of the file is left alone');
    ok('a folder where the file should be is not entered and not removed');
  }
  {
    const directory = freshDirectory();
    const target = path.join(directory, 'elsewhere.json');
    fs.writeFileSync(target, vectors.written[0].text);
    let linked = true;
    try { fs.symlinkSync(target, path.join(directory, RESULT_FILE), 'file'); } catch { linked = false; }
    if (linked) {
      const note = createAppliedNote({ directory, currentVersion: '3.11.0' });
      await note.load();
      assert.equal(note.status(), null, 'a link is not followed');
      assert.equal(fs.readFileSync(target, 'utf8'), vectors.written[0].text, 'what it pointed at is untouched');
      assert.equal(fs.existsSync(path.join(directory, RESULT_FILE)), false, 'the link itself is removed');
      ok('a link where the file should be is not followed and is removed');
    } else ok('(a link cannot be made here without a privilege: checked on the runner)');
  }
  {
    // a disk that will not let the file go: the note is still told this time (the file said so), and nothing throws
    const directory = freshDirectory();
    fs.writeFileSync(path.join(directory, RESULT_FILE), vectors.written[0].text);
    const lines = [];
    const faulty = { ...fs, promises: new Proxy(fs.promises, { get: (target, property) => (property === 'unlink' ? async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } : target[property]) }) };
    const note = createAppliedNote({ directory, currentVersion: '3.11.0', log: (line) => lines.push(line), fsApi: faulty });
    await note.load();
    assert.ok(note.status(), 'the note is shown although the file could not be removed');
    assert.ok(lines.length >= 1 && !lines.join(' ').includes(directory), 'and the log says so without the path');
    ok('a file that cannot be removed does not stop the note, and the log holds no path');
  }

  // ---- what the module is not, and that its twelve reasons are the installer's
  {
    const source = fs.readFileSync(path.join(HUB, 'lib', 'update-applied.mjs'), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1]).sort();
    assert.deepEqual(imports, ['./update-check.mjs', 'node:fs', 'node:path'], 'it imports the file system, path and the version rules and nothing else');
    assert.ok(!/process\.env|Date\.now|new Date|setTimeout|setInterval|fetch\(|child_process|spawn|exec\(/.test(source.replace(/\/\/.*$/gm, '')), 'no environment variable, no clock, no timer, no request, no program');
    ok('the module asks no network, starts no program, reads no clock and no environment variable');
  }
  {
    const shell = path.resolve(HUB, '..', 'native-shared', 'HubLifecycle.cs');
    if (fs.existsSync(shell)) {
      const text = fs.readFileSync(shell, 'utf8');
      const block = /internal static readonly IReadOnlySet<string> Known = new HashSet<string>\(StringComparer\.Ordinal\)\s*\{([^}]*)\}/.exec(text);
      assert.ok(block, 'the installer\'s list of reasons is in native-shared/HubLifecycle.cs');
      const codes = [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]).sort();
      assert.deepEqual(codes, [...REASONS].sort(), 'the Hub knows exactly the reasons the installer can write');
      ok('the twelve reasons are the installer\'s (StepCode.Known)');
    } else ok('(native-shared/ is not next to the Hub in this bundle: the reasons are compared in the repository)');
  }
  console.log(`PASS: ${checks} checks - the result file of an update is read once, as data, and means something only in the version it is about`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
