// The hand-over after an update: the installer writes a small result file (--result, format 1) and the Hub that runs next tells the page "Updated to x.y.z", or why the update did not go through
// (lib/update-applied.mjs). The installer of ANY later version may have written it, so the file is a contract across versions: this suite holds the Hub to the literal texts of
// tests/fixtures/update-result-vectors.json, which the native tests hold the installer to as well (scripts/tests/native-lifecycle/ContractTests.cs).
//
// What the module promises:
//   * the file is read ONCE, at start, and consumed (deleted) whatever it holds: a later start never announces it again, and a damaged one does not linger;
//   * what it says counts only for the version that runs: "updated" only in the version it updated to, "did not go through" only in a version older than the one it tried;
//   * the reason is a code of a closed list (the same twelve the installer writes); a code it does not know is shown as a failure to install, and no text of the file is ever shown;
//   * the file is read as data: at most 4 KiB, a regular file (a link is not followed), strict shape, consistent (ok, state and rolledBack must agree);
//   * the status is memory: reading it asks nothing of the disk or the network;
//   * behind the marker of an update that stopped halfway the file is left alone (read by nobody, removed by nobody) until the installation is repaired.
// CLAIM: update-note-waits-for-the-repair
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppliedNote, PENDING_MARKER, REASONS, RESULT_FILE, STATES } from '../lib/update-applied.mjs';

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
    const lines = [];
    const note = createAppliedNote({ directory, currentVersion: '3.11.0', log: (line) => lines.push(line) });
    await note.load();
    assert.equal(note.status(), null);
    assert.deepEqual(lines, [], 'it is not even tried: nothing is logged');
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

  {
    // load() replaces the note: a start that finds no file leaves no note, whatever an earlier load found
    const directory = freshDirectory();
    fs.writeFileSync(path.join(directory, RESULT_FILE), vectors.written[0].text);
    const note = createAppliedNote({ directory, currentVersion: '3.11.0' });
    await note.load();
    assert.ok(note.status());
    await note.load();
    assert.equal(note.status(), null, 'a load that finds no file leaves no note');
    ok('a load replaces the note, it does not add to it');
  }
  {
    // a file that cannot be read: nothing throws, the file is taken away anyway, and there is no note
    const directory = freshDirectory();
    fs.writeFileSync(path.join(directory, RESULT_FILE), vectors.written[0].text);
    const faulty = { ...fs, promises: new Proxy(fs.promises, { get: (target, property) => (property === 'readFile' ? async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } : target[property]) }) };
    const note = createAppliedNote({ directory, currentVersion: '3.11.0', fsApi: faulty });
    await note.load();
    assert.equal(note.status(), null);
    assert.equal(fs.existsSync(path.join(directory, RESULT_FILE)), false, 'and the file that could not be read is removed anyway');
    ok('a file that cannot be read does not stop the start and is not left to be announced later');
  }
  {
    for (const directory of [undefined, '', 5, null, {}]) assert.throws(() => createAppliedNote({ directory, currentVersion: '3.11.0' }), TypeError, `a note needs the data folder of the Hub (${String(directory)})`);
    assert.throws(() => createAppliedNote(), TypeError, 'and the arguments');
    ok('a note without the data folder of the Hub is not made');
  }
  // ---- an installation that is not whole: the marker of an update that stopped halfway (.chatmcp-update-pending.json, in the folder the Hub lives in) keeps the result file where it is.
  // The launcher starts no Hub behind that marker, but a Hub started by hand does; it must not read (and so consume) the note of an update that has not been repaired, and the Hub that starts after
  // the repair finds it. The marker is "there" for anything on the disk with that name, and when the disk cannot say.
  {
    assert.equal(PENDING_MARKER, '.chatmcp-update-pending.json', 'the marker is named as the installer names it');
    const installer = path.resolve(HUB, '..', 'installer', 'InstallTransaction.cs');
    if (fs.existsSync(installer)) assert.equal(/internal const string PendingName = "([^"]+)";/.exec(fs.readFileSync(installer, 'utf8'))?.[1], PENDING_MARKER, 'and it is the one the installer writes (InstallTransaction.PendingName)');
    const newer = vectors.written[0].text;
    const fresh = () => { const directory = freshDirectory(); const installation = freshDirectory(); fs.writeFileSync(path.join(directory, RESULT_FILE), newer); return { directory, installation, file: path.join(directory, RESULT_FILE), marker: path.join(installation, PENDING_MARKER) }; };
    {
      const { directory, installation, file, marker } = fresh();
      fs.writeFileSync(marker, '{"version":1,"backupDirectory":"x"}');
      const lines = [];
      const note = createAppliedNote({ directory, currentVersion: '3.11.0', installDirectory: installation, log: (line) => lines.push(line) });
      await note.load();
      assert.equal(note.status(), null, 'behind the marker there is no note');
      assert.equal(fs.readFileSync(file, 'utf8'), newer, 'and the result file is exactly where and what it was: not read into the note, not removed');
      assert.ok(lines.length === 1 && !lines[0].includes(directory) && !lines[0].includes(installation), 'one line is logged, and it holds no path');
      fs.rmSync(marker);
      const after = createAppliedNote({ directory, currentVersion: '3.11.0', installDirectory: installation });
      await after.load();
      assert.ok(after.status() && after.status().version === JSON.parse(newer).version, 'the Hub that starts after the repair (no marker) reads it and tells the page');
      assert.equal(fs.existsSync(file), false, 'and consumes it');
      ok('behind the marker the result file is left alone, and the next start after the repair reads it');
    }
    {
      // the same instance, the marker gone between two loads
      const { directory, installation, file, marker } = fresh();
      fs.writeFileSync(marker, '{}');
      const note = createAppliedNote({ directory, currentVersion: '3.11.0', installDirectory: installation });
      await note.load();
      assert.equal(note.status(), null);
      fs.rmSync(marker);
      await note.load();
      assert.ok(note.status(), 'a load that finds no marker reads the file');
      assert.equal(fs.existsSync(file), false);
      ok('a load looks at the marker every time');
    }
    {
      // anything with that name counts, and the disk saying nothing useful counts as there
      const { directory, installation, file, marker } = fresh();
      fs.mkdirSync(marker);
      const note = createAppliedNote({ directory, currentVersion: '3.11.0', installDirectory: installation });
      await note.load();
      assert.equal(note.status(), null);
      assert.equal(fs.existsSync(file), true, 'a folder with the name of the marker keeps the file as well');
      fs.rmdirSync(marker);
      const faulty = (code) => ({ ...fs, promises: new Proxy(fs.promises, { get: (target, property) => (property === 'lstat' ? async (checked) => { if (String(checked).endsWith(PENDING_MARKER)) throw Object.assign(new Error('x'), { code }); return target.lstat(checked); } : target[property]) }) });
      for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP']) {
        const unsure = createAppliedNote({ directory, currentVersion: '3.11.0', installDirectory: installation, fsApi: faulty(code) });
        await unsure.load();
        assert.equal(unsure.status(), null, `a disk that answers ${code} when asked about the marker: the file is left alone`);
        assert.equal(fs.existsSync(file), true);
      }
      for (const code of ['ENOENT', 'ENOTDIR']) {
        const clear = createAppliedNote({ directory, currentVersion: '3.11.0', installDirectory: installation, fsApi: faulty(code) });
        await clear.load();
        assert.ok(clear.status(), `${code} is "no marker": the file is read`);
        fs.writeFileSync(file, newer);
      }
      ok('a folder or a disk that cannot say counts as the marker; no file and no folder (ENOENT, ENOTDIR) do not');
    }
    {
      // it is not even looked at: nothing is read and nothing is removed while the marker is there
      const { directory, installation, marker } = fresh();
      fs.writeFileSync(marker, '{}');
      const calls = [];
      const spy = { ...fs, promises: new Proxy(fs.promises, { get: (target, property) => (['readFile', 'unlink', 'rm', 'rename', 'writeFile'].includes(property) ? async () => { calls.push(property); throw new Error('must not be called'); } : target[property]) }) };
      const note = createAppliedNote({ directory, currentVersion: '3.11.0', installDirectory: installation, fsApi: spy });
      await note.load();
      assert.deepEqual(calls, [], 'no read, no removal, no write');
      ok('behind the marker the result file is not read, removed or written');
    }
    {
      // no folder of the installation given: no guard (a note made in a test, or by a caller that does not know), and a folder that is not a path is a mistake
      const { directory, file } = fresh();
      const note = createAppliedNote({ directory, currentVersion: '3.11.0' });
      await note.load();
      assert.ok(note.status() && !fs.existsSync(file), 'without the folder of the installation the file is read as before');
      for (const installDirectory of ['', 5, null, {}, []]) assert.throws(() => createAppliedNote({ directory, currentVersion: '3.11.0', installDirectory }), TypeError, `the folder of the installation must be a path (${JSON.stringify(installDirectory)})`);
      ok('the folder of the installation is optional, and a value that is not a path is refused');
    }
    {
      // a marker in the DATA folder, or next to the Hub's other files, is not the marker of the installation
      const { directory, installation, file } = fresh();
      fs.writeFileSync(path.join(directory, PENDING_MARKER), '{}');
      const note = createAppliedNote({ directory, currentVersion: '3.11.0', installDirectory: installation });
      await note.load();
      assert.ok(note.status() && !fs.existsSync(file), 'only the installation folder is looked in');
      ok('a file of that name in the data folder does not hold the note back');
    }
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
