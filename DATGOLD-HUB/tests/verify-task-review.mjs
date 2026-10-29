// The Hub side of per-hunk review (plan tasks ux-4): what a task changed, as full texts, and the one thing that may be undone without asking
// for a checkpoint (a file the task created).
//
// Nothing here is mocked. A real HubManager with its real StudioWorkspace, LocalTools, PermissionGate and Git runs the tool calls of a "task"
// through the same guard the agent loop uses (HubManager#guardCalls: gate, hooks, checkpoint, tool), so a checkpoint is made by the code that
// makes it in production, with the task id and the paths the tool is about to touch. Then StudioWorkspace.taskReview() and rejectCreated()
// answer from what is on disk. A real Hub process answers the same questions over HTTP at the end.
//
// Expectations are written out by hand from the fixture bytes below, never derived by the code under test.
// CLAIM: checkpoints
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks += 1; };
const equal = (actual, expected, label) => { assert.deepStrictEqual(actual, expected, label); checks += 1; };
const sha = (data) => createHash('sha256').update(data).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_CHAR = String.fromCharCode(0xfeff);

// ------------------------------------------------------------------ the fixture project (every byte is written here)
const FILES = {
  'src/app.py': Buffer.from('def add(a, b):\n    return a - b\n'),
  'README.md': Buffer.from('# Demo\n'),
  'notes.txt': Buffer.from('remember the milk\n'),
  'data.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]),
  'crlf.txt': Buffer.from('alpha\r\nbeta\r\ngamma\r\n'),
  'bom.txt': Buffer.concat([BOM, Buffer.from('bom first line\nsecond\n')]),
  'counter.txt': Buffer.from('0\n'),
  'big.txt': Buffer.from(`${'x'.repeat(400000)}\nEND\n`),
  '.env': Buffer.from('API_KEY=not-a-real-key-0123456789\n'),
  'tools/mutate.js': Buffer.from([
    "const fs = require('fs');",
    'const [, , file, text] = process.argv;',
    'fs.writeFileSync(file, text);',
    '',
  ].join('\n')),
  'tools/rewrite-app.js': Buffer.from("require('fs').writeFileSync('src/app.py', 'rewritten by a command\\n');\n"),
  'tools/rewrite-readme.js': Buffer.from("require('fs').writeFileSync('README.md', '# rewritten\\n');\n"),
  'tools/noop.js': Buffer.from('// does nothing\n'),
  'tools/append-win.js': Buffer.from("require('fs').appendFileSync('win.txt', 'three\\r\\n');\n"),
  'tools/make-bytes.js': Buffer.from([
    "const fs = require('fs');",
    "fs.writeFileSync('made.bin', Buffer.from([0, 1, 2, 3]));",
    "fs.writeFileSync('made.txt', 'made by a command\\n');",
    "fs.writeFileSync('.env', 'API_KEY=changed-by-a-command-0123456789\\n');",
    "fs.writeFileSync('notes.txt', 'changed by a command\\n');",
    '',
  ].join('\n')),
};

function git(cwd, args, { autocrlf = 'false' } = {}) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.autocrlf=${autocrlf}`, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-task-review-'));
const root = await fs.realpath(temp);
const approvers = [];
const managers = [];

async function createWorld(name) {
  const workspace = path.join(root, name, 'project');
  for (const [file, bytes] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), bytes);
  }
  git(workspace, ['init', '-q']);
  git(workspace, ['config', 'core.autocrlf', 'false']); // the machine's own setting must not decide what "the last commit" looks like here
  git(workspace, ['add', '-A', '-f']); // .env is tracked on purpose: a tracked secret must still never come back through a review
  git(workspace, ['commit', '-q', '-m', 'initial']);
  const manager = new HubManager({ dataDirectory: path.join(root, name, 'data'), bundleRoot, log: () => {} });
  assembleStudio(manager, { bundleRoot });
  await manager.permissions.load();
  await manager.load();
  await manager.selectWorkspace(workspace);
  manager.permissions.configure({ mode: 'autonomous' });
  managers.push(manager);
  // Whatever asks (a command, a deletion) is answered yes; the point of the suite is what happens after the answer.
  const handled = new Set();
  const timer = setInterval(() => {
    for (const request of manager.permissions.state().pending) {
      if (handled.has(request.id)) continue;
      handled.add(request.id);
      try { manager.permissions.decide(request.id, true); } catch { /* already decided */ }
    }
  }, 10);
  approvers.push(timer);
  return { manager, studio: manager.studio, workspace };
}

/** Puts the project back as committed (a section changes files; the next one starts from the fixture again). Checkpoints of earlier tasks stay: they belong to other task ids. */
function reset(world) {
  git(world.workspace, ['checkout', '-q', 'HEAD', '--', '.']);
  git(world.workspace, ['clean', '-fdq']);
}

/** Runs the calls of one task through the guard, the way the agent loop does, and returns the results in order. */
async function runTask(world, taskId, calls) {
  world.manager.acquireTask(taskId);
  const session = await world.manager.createAgentSession();
  const results = [];
  try {
    for (const [name, args] of calls) {
      const result = await session.callTool(name, args, {});
      results.push(result);
    }
  } finally {
    await session.close();
    world.manager.releaseTask(taskId);
  }
  return results;
}
const failures = (results) => results.filter((result) => result.isError).map((result) => result.content?.[0]?.text);
const fileOf = (review, relative) => review.files.find((entry) => entry.path === relative);
const metaOf = async (studio, id) => JSON.parse(await fs.readFile(path.join(studio.directory, 'checkpoints', id, 'meta.json'), 'utf8'));
const metasOf = async (studio, taskId) => {
  const metas = [];
  for (const dir of await fs.readdir(path.join(studio.directory, 'checkpoints'))) {
    const meta = JSON.parse(await fs.readFile(path.join(studio.directory, 'checkpoints', dir, 'meta.json'), 'utf8'));
    if (meta.taskId === taskId) metas.push(meta);
  }
  return metas.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
};
async function section(title, body) {
  const before = checks;
  const started = Date.now();
  await body();
  console.log(`  ok  ${title} (${checks - before} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

try {
  const world = await createWorld('main');
  const { manager, studio, workspace } = world;
  const on = (relative) => path.join(workspace, relative);
  const disk = (relative) => fs.readFile(on(relative));

  // ------------------------------------------------------------------ what a checkpoint records
  await section('a checkpoint records the task, and the files a tool is about to create', async () => {
    const taskId = randomUUID();
    const results = await runTask(world, taskId, [
      ['local.edit_file', { path: 'src/app.py', old_string: 'a - b', new_string: 'a + b' }],
      ['local.write_file', { path: 'src/new.py', content: 'print("new")\n' }],
      ['local.files_write_batch', { files: [{ path: 'batch-one.txt', content: 'one\n' }, { path: 'README.md', content: '# Demo, changed\n', overwrite: true }] }],
      ['local.move_path', { source: 'notes.txt', destination: 'docs/notes-moved.txt' }],
    ]);
    equal(failures(results), [], 'all four calls ran');
    const metas = await metasOf(studio, taskId);
    equal(metas.length, 4, 'one checkpoint for each call that changes files');
    equal(metas.map((meta) => meta.targeted), [true, true, true, true], 'each is a checkpoint of exactly the files the call names');
    equal([metas[0].files.map((f) => f.path), metas[0].absent], [['src/app.py'], []], 'an edit saves the file and creates nothing');
    equal(metas[0].files[0].sha256, sha(FILES['src/app.py']), 'with the sha of the bytes it had');
    equal([metas[1].files, metas[1].absent], [[], ['src/new.py']], 'a new file has nothing to save, and is on record as one the call is about to create');
    equal([metas[2].files.map((f) => f.path), metas[2].absent], [['README.md'], ['batch-one.txt']], 'a batch separates the file it replaces from the one it creates');
    equal([metas[3].files.map((f) => f.path), metas[3].absent], [['notes.txt'], ['docs/notes-moved.txt']], 'a move saves the source and records the destination');
    check(new Set(metas.map((meta) => meta.seq)).size === 4 && metas.every((meta, i) => i === 0 || meta.seq > metas[i - 1].seq), 'the checkpoints of one process are numbered in the order they were made (the clock has millisecond resolution)');
    equal((await studio.checkpoints()).map((row) => row.taskId), [taskId, taskId, taskId, taskId], 'the list of checkpoints says which task made each');
  });

  // ------------------------------------------------------------------ the review of a task
  await section('edit, create, delete and binary files, as full texts', async () => {
    reset(world);
    const taskId = randomUUID();
    const results = await runTask(world, taskId, [
      ['local.edit_file', { path: 'src/app.py', old_string: 'a - b', new_string: 'a * b' }],
      ['local.write_file', { path: 'src/helpers.py', content: 'def helper():\n    return 1\n' }],
      ['local.delete_path', { path: 'README.md' }],
      ['local.move_path', { source: 'data.bin', destination: 'moved.bin' }],
    ]);
    equal(failures(results), [], 'the task ran');
    const review = await studio.taskReview({ taskId });
    equal(review.taskId, taskId, 'the review is of this task');
    equal(review.files.map((entry) => entry.path), ['README.md', 'data.bin', 'moved.bin', 'src/app.py', 'src/helpers.py'], 'five files, in path order');
    const edited = fileOf(review, 'src/app.py');
    equal([edited.status, edited.change, edited.partial, edited.accepted, edited.baselineSource, edited.rejectable], ['modified', 'modified', false, false, 'checkpoint', false], 'an edited file is modified, exact, not accepted, and cannot be rejected as created');
    equal([edited.baselineText, edited.currentText], ['def add(a, b):\n    return a - b\n', 'def add(a, b):\n    return a * b\n'], 'both texts are in full');
    equal([edited.baselineSha, edited.currentSha], [sha(FILES['src/app.py']), sha(Buffer.from('def add(a, b):\n    return a * b\n'))], 'and both shas are those of the bytes');
    const created = fileOf(review, 'src/helpers.py');
    equal([created.status, created.baselineText, created.baselineSha, created.currentText, created.rejectable, created.partial], ['created', null, null, 'def helper():\n    return 1\n', true, false], 'a new file has no baseline and may be rejected');
    const deleted = fileOf(review, 'README.md');
    equal([deleted.status, deleted.baselineText, deleted.currentText, deleted.currentSha, deleted.baselineSha, deleted.rejectable], ['deleted', '# Demo\n', null, null, sha(FILES['README.md']), false], 'a deleted file keeps its baseline and cannot be rejected');
    const gone = fileOf(review, 'data.bin');
    equal([gone.status, gone.change, gone.baselineText, gone.currentText, gone.baselineSha, gone.textUnavailable], ['binary', 'deleted', null, null, sha(FILES['data.bin']), 'binary'], 'a binary file that was moved away is binary and deleted, with its sha and no text');
    const arrived = fileOf(review, 'moved.bin');
    equal([arrived.status, arrived.change, arrived.currentSha, arrived.rejectable], ['binary', 'created', sha(FILES['data.bin']), true], 'and where it arrived it is a binary file that was created, which may be rejected');
    equal([review.checkpoints.total, review.checkpoints.targeted, review.checkpoints.broad], [4, 4, 0], 'the review says how many checkpoints it is made of');
    equal(review.files.every((entry) => entry.checkpointId && typeof entry.accepted === 'boolean'), true, 'every file says which checkpoint is its baseline');
  });

  await section('line endings and a BOM are the file\'s: the texts go back to the exact bytes', async () => {
    reset(world);
    const taskId = randomUUID();
    await runTask(world, taskId, [
      ['local.edit_file', { path: 'crlf.txt', old_string: 'beta', new_string: 'BETA' }],
      ['local.edit_file', { path: 'bom.txt', old_string: 'second', new_string: 'SECOND' }],
    ]);
    const review = await studio.taskReview({ taskId });
    const crlf = fileOf(review, 'crlf.txt');
    equal([crlf.baselineText, crlf.currentText], ['alpha\r\nbeta\r\ngamma\r\n', 'alpha\r\nBETA\r\ngamma\r\n'], 'CRLF stays CRLF in both texts');
    check(Buffer.compare(Buffer.from(crlf.baselineText), FILES['crlf.txt']) === 0 && sha(Buffer.from(crlf.currentText)) === crlf.currentSha && Buffer.compare(Buffer.from(crlf.currentText), await disk('crlf.txt')) === 0, 'and Buffer.from(text) is the file, byte for byte');
    const bom = fileOf(review, 'bom.txt');
    equal([bom.baselineText.charCodeAt(0), bom.currentText.charCodeAt(0)], [0xfeff, 0xfeff], 'the BOM is the first character of both texts');
    equal([bom.baselineText.slice(1), bom.currentText.slice(1)], ['bom first line\nsecond\n', 'bom first line\nSECOND\n'], 'and nothing else is added or taken');
    check(Buffer.compare(Buffer.from(bom.baselineText), FILES['bom.txt']) === 0 && Buffer.compare(Buffer.from(bom.currentText), await disk('bom.txt')) === 0, 'so the texts rebuild the bytes of the file, BOM included');
    check(BOM_CHAR === bom.currentText[0] && (await disk('bom.txt')).subarray(3, 6).compare(BOM) !== 0, 'with one BOM and not two');
  });

  // ------------------------------------------------------------------ which paths a call is about to touch
  await section('touchedPaths: what exists today; with includeAbsent also what the call is about to create', async () => {
    reset(world);
    const touched = (name, args, options) => manager.localTools.touchedPaths(name, args, options);
    const more = { includeAbsent: true };
    equal(await touched('write_file', { path: 'brand-new.txt' }), [], 'by default a file that does not exist is not listed (the contract of the checkpoint that skips it)');
    equal(await touched('write_file', { path: 'brand-new.txt' }, more), ['brand-new.txt'], 'with includeAbsent it is');
    equal(await touched('write_file', { path: 'notes.txt' }, more), ['notes.txt'], 'a file that exists is listed once');
    equal(await touched('edit_file', { path: 'nope.txt', old_string: 'a', new_string: 'b' }, more), [], 'edit_file cannot create a file');
    equal(await touched('delete_path', { path: 'nope.txt' }, more), [], 'nor can delete_path');
    equal(await touched('write_file', { path: '.env.local' }, more), [], 'a protected name is not listed, even to be created');
    equal(await touched('write_file', { path: '../outside.txt' }, more), [], 'a path outside the workspace is not listed');
    equal(await touched('files_write_batch', { files: [{ path: 'a-new.txt', content: '' }, { path: 'README.md', content: '' }] }, more), ['README.md', 'a-new.txt'], 'a batch: the files that exist, then the ones it creates');
    equal(await touched('move_path', { source: 'notes.txt', destination: 'moved/notes.txt' }, more), ['notes.txt', 'moved/notes.txt'], 'a move: the source, and where it goes');
    equal(await touched('move_path', { source: 'notes.txt', destination: 'moved/notes.txt' }), ['notes.txt'], 'by default only the source');
    const folder = await touched('move_path', { source: 'tools', destination: 'scripts' }, more);
    const tools = (await fs.readdir(on('tools'))).sort();
    equal(folder.filter((entry) => entry.startsWith('tools/')).map((entry) => entry.slice(6)).sort(), tools, 'moving a folder: every file in it');
    equal(folder.filter((entry) => entry.startsWith('scripts')).sort(), ['scripts', ...tools.map((name) => `scripts/${name}`)].sort(), 'and where each one will appear');
  });

  // ------------------------------------------------------------------ rejecting what a task created
  await section('a file the task created can be moved to the undo folder; nothing else can', async () => {
    reset(world);
    const taskId = randomUUID();
    await runTask(world, taskId, [
      ['local.write_file', { path: 'src/created.py', content: 'x = 1\n' }],
      ['local.write_file', { path: 'README.md', content: '# Replaced\n', overwrite: true }],
      ['local.write_file', { path: 'src/other.py', content: 'y = 2\n' }],
    ]);
    const createdSha = sha(Buffer.from('x = 1\n'));
    const refuse = async (payload, status, code, label) => {
      await assert.rejects(() => studio.rejectCreated(payload), (error) => error.statusCode === status && error.code === code, label);
      checks += 1;
    };
    await refuse({ taskId, file: 'src/created.py' }, 409, 'revision_required', 'no sha: refused');
    await refuse({ taskId, file: 'src/created.py', expectedSha: '0'.repeat(64) }, 409, 'stale_review', 'a sha that is not the file\'s: refused');
    await refuse({ taskId, file: 'README.md', expectedSha: sha(Buffer.from('# Replaced\n')) }, 409, 'not_rejectable', 'a file the task replaced was there before: it is not rejected');
    await refuse({ taskId: randomUUID(), file: 'src/created.py', expectedSha: createdSha }, 409, 'stale_review', 'a task that did not create it cannot reject it');
    await refuse({ taskId, file: 'notes.txt', expectedSha: sha(FILES['notes.txt']) }, 409, 'stale_review', 'a file the task never touched is not in its review');
    check((await disk('src/created.py')).equals(Buffer.from('x = 1\n')) && (await disk('README.md')).equals(Buffer.from('# Replaced\n')), 'every refusal left the files where they were');
    // The person edits the file after the review: the reviewed bytes are no longer what is on disk.
    await fs.writeFile(on('src/other.py'), 'y = 2\n# edited by the person\n');
    await refuse({ taskId, file: 'src/other.py', expectedSha: sha(Buffer.from('y = 2\n')) }, 409, 'stale_review', 'a file changed after the review is refused');
    check((await disk('src/other.py')).equals(Buffer.from('y = 2\n# edited by the person\n')), 'and the edit is still there');
    const done = await studio.rejectCreated({ taskId, file: 'src/created.py', expectedSha: createdSha });
    equal([done.ok, done.path, done.sha256], [true, 'src/created.py', createdSha], 'the reviewed file is rejected');
    await assert.rejects(() => fs.access(on('src/created.py'))); checks += 1;
    check((await fs.readFile(done.undoBackup)).equals(Buffer.from('x = 1\n')), 'its bytes are in the undo folder, intact');
    const undoMeta = JSON.parse(await fs.readFile(path.join(studio.directory, 'undo', done.undoId, 'meta.json'), 'utf8'));
    equal([undoMeta.kind, undoMeta.taskId, undoMeta.files], ['reject_created', taskId, [{ path: 'src/created.py', sha256: createdSha, bytes: 6 }]], 'with a record of what it was and who made it');
    check((await fs.readdir(path.join(workspace, 'src'))).every((name) => !name.includes('.rejecting')), 'no half-moved file is left in the workspace');
    const after = await studio.taskReview({ taskId });
    equal(after.files.map((entry) => entry.path), ['README.md', 'src/other.py'], 'it is gone from the review');
    await refuse({ taskId, file: 'src/created.py', expectedSha: createdSha }, 409, 'stale_review', 'and cannot be rejected twice');
  });

  await section('a task that never changed a file has no review, and says why', async () => {
    const taskId = randomUUID();
    await runTask(world, taskId, [['local.read_file', { path: 'README.md' }], ['local.list_directory', { path: '.' }]]);
    const review = await studio.taskReview({ taskId });
    equal([review.files, review.checkpoints.total, review.limitations.map((note) => note.code)], [[], 0, ['no_checkpoints']], 'an empty list comes with the reason that nothing is on record');
    await assert.rejects(() => studio.taskReview({ taskId: 'not-a-task' }), (error) => error.statusCode === 400 && error.code === 'bad_task_id'); checks += 1;
    await assert.rejects(() => studio.taskReview({}), (error) => error.code === 'bad_task_id'); checks += 1;
  });

  // ------------------------------------------------------------------ what a command leaves
  await section('a command: its snapshot is partial, Git fills in what the snapshot cannot hold, and secrets never come back', async () => {
    reset(world);
    // The person had changed these before the task started: they are not the task's.
    await fs.writeFile(on('counter.txt'), '41\n');
    await sleep(30);
    const taskId = randomUUID();
    const results = await runTask(world, taskId, [
      ['local.run_command', { command: 'node tools/make-bytes.js', description: 'a command that writes several files' }],
      ['local.run_command', { command: 'node tools/rewrite-app.js', description: 'rewrites app.py' }],
    ]);
    equal(failures(results), [], 'the commands ran');
    const review = await studio.taskReview({ taskId });
    equal([review.checkpoints.total, review.checkpoints.targeted, review.checkpoints.broad], [1, 0, 1], 'one snapshot of the whole workspace (the second command reused it: nothing it holds had changed), no checkpoint of one file');
    const app = fileOf(review, 'src/app.py');
    equal([app.status, app.partial, app.baselineSource, app.baselineText, app.currentText, app.rejectable], ['modified', true, 'checkpoint', 'def add(a, b):\n    return a - b\n', 'rewritten by a command\n', false], 'a source file that was in the snapshot has its exact baseline, marked partial');
    const notes = fileOf(review, 'notes.txt');
    equal([notes.status, notes.partial, notes.baselineSource, notes.baselineText, notes.currentText, notes.rejectable], ['modified', true, 'git_head', 'remember the milk\n', 'changed by a command\n', false], 'a .txt file is not in the snapshot: its baseline is the last commit, marked partial');
    const madeText = fileOf(review, 'made.txt');
    equal([madeText.status, madeText.baselineText, madeText.baselineSha, madeText.currentText, madeText.partial, madeText.rejectable], ['created', null, null, 'made by a command\n', true, false], 'a new file Git sees is created, partial, and NOT rejectable (nothing recorded that it was absent)');
    const madeBinary = fileOf(review, 'made.bin');
    equal([madeBinary.status, madeBinary.change, madeBinary.currentSha, madeBinary.rejectable], ['binary', 'created', sha(Buffer.from([0, 1, 2, 3])), false], 'a new binary file likewise');
    equal(fileOf(review, 'counter.txt'), undefined, 'a file the person had changed before the task is not the task\'s');
    equal(review.files.some((entry) => entry.path === '.env'), false, 'a tracked secret that a command changed is not listed');
    check(!JSON.stringify(review).includes('not-a-real-key') && !JSON.stringify(review).includes('changed-by-a-command'), 'and neither its old nor its new content is in the answer');
    check(review.omitted.protected >= 1, 'the answer says that something protected was left out');
    await assert.rejects(() => studio.rejectCreated({ taskId, file: 'made.txt', expectedSha: sha(Buffer.from('made by a command\n')) }), (error) => error.code === 'stale_review' || error.code === 'not_rejectable'); checks += 1;
    check((await disk('made.txt')).length > 0, 'a file found only through Git is never moved away');
  });

  await section('a file edited by name before a command has the exact baseline; the snapshot is only the baseline of what no checkpoint named', async () => {
    reset(world);
    const taskId = randomUUID();
    await runTask(world, taskId, [
      ['local.edit_file', { path: 'src/app.py', old_string: 'a - b', new_string: 'a + b' }],
      ['local.run_command', { command: 'node tools/rewrite-app.js', description: 'rewrites app.py' }],
      ['local.run_command', { command: 'node tools/rewrite-readme.js', description: 'rewrites README.md' }],
    ]);
    const review = await studio.taskReview({ taskId });
    const app = fileOf(review, 'src/app.py');
    equal([app.partial, app.baselineText, app.currentText], [false, 'def add(a, b):\n    return a - b\n', 'rewritten by a command\n'], 'the edit came first: its checkpoint is the baseline, exact');
    const readme = fileOf(review, 'README.md');
    equal([readme.partial, readme.baselineText, readme.currentText], [true, '# Demo\n', '# rewritten\n'], 'the readme was only in a snapshot: partial');
  });

  await section('two tasks never share a snapshot, even when nothing changed between them', async () => {
    reset(world);
    const first = randomUUID();
    const second = randomUUID();
    await runTask(world, first, [['local.run_command', { command: 'node tools/noop.js', description: 'does nothing' }]]);
    await runTask(world, second, [['local.run_command', { command: 'node tools/noop.js', description: 'does nothing' }]]);
    const [a, b] = [await studio.taskReview({ taskId: first }), await studio.taskReview({ taskId: second })];
    equal([a.checkpoints.broad, b.checkpoints.broad], [1, 1], 'each has a snapshot of its own');
    await runTask(world, second, [['local.run_command', { command: 'node tools/noop.js', description: 'does nothing again' }]]);
    equal((await studio.taskReview({ taskId: second })).checkpoints.broad, 1, 'but one task asking twice with nothing changed reuses its own');
  });

  // ------------------------------------------------------------------ a long task
  await section('more than 100 checkpoints in one task: the baseline is still the first', async () => {
    reset(world);
    const taskId = randomUUID();
    const calls = [];
    for (let i = 0; i < 105; i += 1) calls.push(['local.edit_file', { path: 'counter.txt', old_string: `${i}\n`, new_string: `${i + 1}\n` }]);
    const results = await runTask(world, taskId, calls);
    equal(failures(results), [], '105 edits ran');
    const listed = await studio.checkpoints({ limit: 1000 });
    equal(listed.length, 100, 'the list of checkpoints stops at 100 whatever is asked');
    const everyOfTheTask = await metasOf(studio, taskId);
    equal(everyOfTheTask.length, 105, 'while the task made 105');
    check(!listed.some((row) => row.id === everyOfTheTask[0].id), 'the first one is not in that list');
    const review = await studio.taskReview({ taskId });
    equal(review.checkpoints.total, 105, 'the review is made of all of them');
    const counter = fileOf(review, 'counter.txt');
    equal([counter.baselineText, counter.currentText, counter.checkpointId], ['0\n', '105\n', everyOfTheTask[0].id], 'and its baseline is the file as the first edit found it');
    equal(review.files.length, 1, 'one file, however many times it was edited');
  });

  await section('two checkpoints of the same millisecond: the one made first is the baseline', async () => {
    reset(world);
    const frozen = new (studio.constructor)({ manager, directory: path.join(root, 'frozen-state'), now: () => '2026-01-01T00:00:00.000Z' });
    const taskId = randomUUID();
    for (const text of ['one\n', 'two\n', 'three\n']) {
      await fs.writeFile(on('tick.txt'), text);
      await frozen.checkpoint({ label: 'tick', taskId, files: ['tick.txt'] });
    }
    await fs.writeFile(on('tick.txt'), 'four\n');
    const review = await frozen.taskReview({ taskId });
    equal([review.checkpoints.total, fileOf(review, 'tick.txt').baselineText, fileOf(review, 'tick.txt').currentText], [3, 'one\n', 'four\n'], 'three checkpoints with the same timestamp: the first, by its number');
    equal((await frozen.checkpoints()).map((row) => row.seq), [3, 2, 1], 'and the list shows the last first');
  });

  await section('a file too large for a checkpoint falls back to the last commit, marked partial', async () => {
    reset(world);
    await fs.writeFile(on('grow.txt'), 'small\n');
    git(workspace, ['add', '--', 'grow.txt']); git(workspace, ['commit', '-q', '-m', 'grow']);
    await fs.writeFile(on('grow.txt'), Buffer.alloc(9 * 1024 * 1024, 0x61)); // over the 8 MiB a checkpoint takes of one file
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [['local.delete_path', { path: 'grow.txt' }]])), [], 'the task ran');
    equal((await metasOf(studio, taskId))[0].skipped, [{ path: 'grow.txt', reason: 'too_large' }], 'the checkpoint says it could not take the file');
    const grown = fileOf(await studio.taskReview({ taskId }), 'grow.txt');
    equal([grown.status, grown.baselineSource, grown.partial, grown.baselineText, grown.baselineSha, grown.currentSha], ['deleted', 'git_head', true, 'small\n', sha(Buffer.from('small\n')), null], 'the baseline is the last commit (not what the task found: hence partial)');
  });

  await section('the last commit is read the way the working tree has it (line-ending conversion applied)', async () => {
    reset(world);
    git(workspace, ['config', 'core.autocrlf', 'true']); // what the Hub's own Git calls read from the repository
    try {
      await fs.writeFile(on('win.txt'), 'one\ntwo\n');
      git(workspace, ['add', '--', 'win.txt'], { autocrlf: 'true' }); git(workspace, ['commit', '-q', '-m', 'win'], { autocrlf: 'true' });
      await fs.rm(on('win.txt'));
      git(workspace, ['checkout', '--', 'win.txt'], { autocrlf: 'true' });
      equal((await disk('win.txt')).toString(), 'one\r\ntwo\r\n', 'the working tree has CRLF, the commit has LF');
      const taskId = randomUUID();
      equal(failures(await runTask(world, taskId, [['local.run_command', { command: 'node tools/append-win.js', description: 'appends a line' }]])), [], 'the task ran');
      const win = fileOf(await studio.taskReview({ taskId }), 'win.txt');
      equal([win.baselineSource, win.baselineText, win.currentText], ['git_head', 'one\r\ntwo\r\n', 'one\r\ntwo\r\nthree\r\n'], 'the baseline is CRLF too, so only the added line differs');
    } finally { git(workspace, ['config', 'core.autocrlf', 'false']); }
  });

  // ------------------------------------------------------------------ the same file under another name
  await section('a file is one file whatever the spelling of its name', async () => {
    reset(world);
    if (process.platform === 'win32') {
      const taskId = randomUUID();
      await runTask(world, taskId, [
        ['local.edit_file', { path: 'SRC/APP.PY', old_string: 'a - b', new_string: 'a + b' }],
        ['local.edit_file', { path: 'src/app.py', old_string: 'a + b', new_string: 'a * b' }],
      ]);
      const metas = await metasOf(studio, taskId);
      // The first edit asked for SRC/APP.PY; the checkpoint names the file as it was on disk then. The edit replaced the file under the name it was given, so on a Windows
      // volume the second checkpoint finds it as src/APP.PY: another spelling of the same file, which the review must not count twice.
      equal(metas[0].files.map((f) => f.path), ['src/app.py'], 'the first checkpoint names the file as it is on disk, not as it was typed');
      equal(metas[1].files.map((f) => f.path.toLowerCase()), ['src/app.py'], 'the second names the same file');
      const review = await studio.taskReview({ taskId });
      equal(review.files.map((entry) => entry.path.toLowerCase()), ['src/app.py'], 'one entry');
      equal([fileOf(review, 'src/app.py').baselineText, fileOf(review, 'src/app.py').currentText], ['def add(a, b):\n    return a - b\n', 'def add(a, b):\n    return a * b\n'], 'from the first spelling\'s baseline to the last edit');
      // 8.3 short names, where the volume has them
      await fs.mkdir(on('a folder with spaces'), { recursive: true });
      await fs.writeFile(on('a folder with spaces/A Long File Name.txt'), 'short\n');
      git(workspace, ['add', '--', 'a folder with spaces']); git(workspace, ['commit', '-q', '-m', 'long names']);
      // cmd.exe strips the outer quotes with /s, and windowsVerbatimArguments keeps Node from escaping the inner ones; without them the answer is a garbled path.
      const asked = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${on('a folder with spaces/A Long File Name.txt')}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true });
      const short = asked.status === 0 ? asked.stdout.trim() : '';
      if (short && /~\d/.test(path.basename(short))) {
        const aliased = randomUUID();
        await runTask(world, aliased, [['local.edit_file', { path: short, old_string: 'short', new_string: 'LONG' }]]);
        const aliasMeta = (await metasOf(studio, aliased))[0];
        equal(aliasMeta.files.map((f) => f.path), ['a folder with spaces/A Long File Name.txt'], 'a Windows 8.3 short name is stored as the long name');
        equal((await studio.taskReview({ taskId: aliased })).files.map((entry) => entry.path), ['a folder with spaces/A Long File Name.txt'], 'and reviewed under it');
      } else console.log('  note - 8.3 short names are not enabled on this volume: that part was not run');
    } else {
      // Case-sensitive file systems have no second spelling of a name; the dedupe by name is the same code, covered by the two edits below.
      const taskId = randomUUID();
      await runTask(world, taskId, [
        ['local.edit_file', { path: 'src/app.py', old_string: 'a - b', new_string: 'a + b' }],
        ['local.edit_file', { path: './src//app.py', old_string: 'a + b', new_string: 'a * b' }],
      ]);
      const review = await studio.taskReview({ taskId });
      equal(review.files.map((entry) => entry.path), ['src/app.py'], 'two spellings of one path are one entry');
    }
  });

  // ------------------------------------------------------------------ what cannot be shown as text
  await section('a file too large to show, and one that is not UTF-8, keep their shas and give no text', async () => {
    reset(world);
    await fs.writeFile(on('latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café" in Windows-1252
    git(workspace, ['add', '--', 'latin.txt']); git(workspace, ['commit', '-q', '-m', 'latin']);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [
      ['local.edit_file', { path: 'big.txt', old_string: 'END', new_string: 'FIN' }],
      ['local.delete_path', { path: 'latin.txt' }],
    ])), [], 'the task ran');
    const review = await studio.taskReview({ taskId });
    const big = fileOf(review, 'big.txt');
    const bigAfter = Buffer.from(FILES['big.txt'].toString().replace('END', 'FIN'));
    equal([big.status, big.textUnavailable, big.baselineText, big.currentText, big.baselineSha, big.currentSha], ['modified', 'too_large', null, null, sha(FILES['big.txt']), sha(bigAfter)], 'over 300 KB: no text, but the shas of both sides');
    const latin = fileOf(review, 'latin.txt');
    equal([latin.status, latin.change, latin.textUnavailable, latin.baselineText, latin.baselineSha], ['binary', 'deleted', 'not_utf8', null, sha(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))], 'Windows-1252 is not shown as text with U+FFFD in it');
  });

  await section('what the person accepted stays accepted only while the file is the one accepted', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [
      ['local.edit_file', { path: 'src/app.py', old_string: 'a - b', new_string: 'a + b' }],
      ['local.write_file', { path: 'src/fresh.py', content: 'z = 3\n' }],
    ])), [], 'the task ran');
    const before = await studio.taskReview({ taskId });
    equal(before.files.map((entry) => entry.accepted), [false, false], 'nothing is accepted at first');
    for (const entry of before.files) await studio.accept({ checkpointId: entry.checkpointId, file: entry.path, expectedSha: entry.currentSha });
    const accepted = await studio.taskReview({ taskId });
    equal(accepted.files.map((entry) => entry.accepted), [true, true], 'an edited file and a created one can both be accepted');
    await fs.writeFile(on('src/app.py'), 'def add(a, b):\n    return a ** b\n');
    const changed = await studio.taskReview({ taskId });
    equal([fileOf(changed, 'src/app.py').accepted, fileOf(changed, 'src/fresh.py').accepted], [false, true], 'a file that changed since is no longer accepted');
  });

  console.log(`PASS: ${checks} task review checks`);
} finally {
  for (const timer of approvers) clearInterval(timer);
  for (const manager of managers) await manager.shutdown().catch(() => {});
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
