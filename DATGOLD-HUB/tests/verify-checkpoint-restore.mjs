// Rolling back, by the step, the file and the task (plan task ux-8): the Hub side. What a step left, a restore of some of the files of a checkpoint, a restore that can itself
// be undone, and the conflicts that are listed instead of overwritten.
//
// Nothing here is mocked. A real HubManager with its real StudioWorkspace, LocalTools, PermissionGate and Git runs the tool calls of a "task" through the same guard the agent
// loop uses (gate, hooks, checkpoint, tool), so the checkpoints and what is noted after each call are made by the code that makes them in production. The restores are then asked of
// StudioWorkspace, and every expectation is written out by hand from the bytes of the fixture below, never derived by the code under test.
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
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));

// ------------------------------------------------------------------ the fixture project (every byte is written here)
const A0 = Buffer.from('alpha one\nalpha two\n');
const B0 = Buffer.from('bravo\n');
const CRLF0 = Buffer.from('one\r\ntwo\r\nthree\r\n');
const BOMTXT0 = Buffer.concat([BOM, Buffer.from('bom line\nsecond\n')]);
const BIN0 = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x00, 0x10]);
const C0 = Buffer.from('charlie\n');
const FILES = {
  'a.txt': A0,
  'b.txt': B0,
  'crlf.txt': CRLF0,
  'bom.txt': BOMTXT0,
  'bin.dat': BIN0,
  'docs/c.txt': C0,
  'tools/noop.js': Buffer.from('// does nothing\n'),
  'notes.md': Buffer.from('# notes\nfirst\n'),
  'tools/rewrite-notes.js': Buffer.from("require('fs').writeFileSync('notes.md', 'rewritten by a command\\n');\n"),
  'tools/rewrite-bin.js': Buffer.from("require('fs').writeFileSync('bin.dat', Buffer.from([9, 9, 9, 0]));\n"),
  'tools/make-bytes.js': Buffer.from([
    "const fs = require('fs');",
    "fs.writeFileSync('made.bin', Buffer.from([0, 1, 2, 3]));",
    "fs.writeFileSync('made.txt', 'made by a command\\n');",
    '',
  ].join('\n')),
};

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-checkpoint-restore-'));
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
  git(workspace, ['config', 'core.autocrlf', 'false']);
  git(workspace, ['add', '-A', '-f']);
  git(workspace, ['commit', '-q', '-m', 'initial']);
  const manager = new HubManager({ dataDirectory: path.join(root, name, 'data'), bundleRoot, log: () => {} });
  assembleStudio(manager, { bundleRoot });
  await manager.permissions.load();
  await manager.load();
  await manager.selectWorkspace(workspace);
  manager.permissions.configure({ mode: 'autonomous' });
  managers.push(manager);
  const handled = new Set();
  const timer = setInterval(() => {
    for (const request of manager.permissions.state().pending) {
      if (handled.has(request.id)) continue;
      handled.add(request.id);
      try { manager.permissions.decide(request.id, true); } catch { /* already decided */ }
    }
  }, 10);
  approvers.push(timer);
  const at = (relative) => path.join(workspace, relative);
  return { manager, studio: manager.studio, workspace, at, disk: (relative) => fs.readFile(at(relative)).catch(() => null) };
}

/** Puts the project back as committed; checkpoints of earlier tasks stay, they belong to other task ids. */
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
    for (const [name, args] of calls) results.push(await session.callTool(name, args, {}));
  } finally {
    await session.close();
    world.manager.releaseTask(taskId);
  }
  return results;
}
const failures = (results) => results.filter((result) => result.isError).map((result) => result.content?.[0]?.text);
const metasOf = async (studio, taskId) => {
  const metas = [];
  for (const dir of await fs.readdir(path.join(studio.directory, 'checkpoints'))) {
    const meta = JSON.parse(await fs.readFile(path.join(studio.directory, 'checkpoints', dir, 'meta.json'), 'utf8'));
    if (meta.taskId === taskId) metas.push(meta);
  }
  return metas.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
};
const countCheckpoints = async (studio) => (await fs.readdir(path.join(studio.directory, 'checkpoints'))).length;
async function section(title, body) {
  const before = checks;
  const started = Date.now();
  await body();
  console.log(`  ok  ${title} (${checks - before} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
async function raises(promise, code, label) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  check(caught !== null, `${label}: it throws`);
  equal(caught?.code, code, `${label}: with the code ${code}`);
  return caught;
}
const changed = (answer) => answer.restored.map((entry) => [entry.path, entry.action]);

try {
  const world = await createWorld('main');
  const { manager, studio, at, disk } = world;
  const expectedNow = async (...paths) => Object.fromEntries(await Promise.all(paths.map(async (relative) => [relative, (await disk(relative)) ? sha(await disk(relative)) : null])));

  // ------------------------------------------------------------------ what a step leaves
  await section('a step notes what it left: the sha of each file after the call, not for a snapshot taken before a command', async () => {
    const taskId = randomUUID();
    const A1 = Buffer.from('alpha ONE\nalpha two\n');
    equal(failures(await runTask(world, taskId, [
      ['local.edit_file', { path: 'a.txt', old_string: 'alpha one', new_string: 'alpha ONE' }],
      ['local.write_file', { path: 'new1.txt', content: 'first\n' }],
      ['local.delete_path', { path: 'docs/c.txt' }],
      ['local.run_command', { command: 'node tools/noop.js', description: 'a command' }],
    ])), [], 'the task ran');
    const metas = await metasOf(studio, taskId);
    equal(metas.map((meta) => meta.targeted), [true, true, true, false], 'three steps with a checkpoint of their own files, and a snapshot before the command');
    const [edit, create, remove, command] = await Promise.all(metas.map((meta) => studio.previewCheckpoint({ checkpointId: meta.id })));
    equal(pick(edit.files[0], ['path', 'kind', 'action', 'baselineSha', 'currentSha', 'afterSha', 'changedSinceStep']),
      { path: 'a.txt', kind: 'copy', action: 'overwrite', baselineSha: sha(A0), currentSha: sha(A1), afterSha: sha(A1), changedSinceStep: false }, 'an edit: the file is what the step left');
    equal(pick(create.files[0], ['path', 'kind', 'action', 'baselineSha', 'currentSha', 'afterSha', 'changedSinceStep']),
      { path: 'new1.txt', kind: 'absent', action: 'remove', baselineSha: null, currentSha: sha('first\n'), afterSha: sha('first\n'), changedSinceStep: false }, 'a file the step created: the checkpoint says it was absent, and going back means removing it');
    equal(pick(remove.files[0], ['path', 'kind', 'action', 'currentSha', 'afterSha', 'changedSinceStep']),
      { path: 'docs/c.txt', kind: 'copy', action: 'recreate', currentSha: null, afterSha: null, changedSinceStep: false }, 'a file the step deleted: it was left missing, and going back brings it back');
    equal([edit.totalFiles, edit.modifiedFilesCount, edit.files[0].status, edit.files[0].willOverwriteNewer], [1, 1, 'modified', true], 'the preview counts the files, says which differ, and that going back overwrites what is there');
    equal([create.files[0].status, create.files[0].willOverwriteNewer, remove.files[0].status, remove.files[0].willOverwriteNewer], ['modified', true, 'deleted_on_disk', false], 'a file that must go is "modified" and would be overwritten; a file that is missing is "deleted_on_disk" and nothing is overwritten');
    check(command.files.length > 0 && command.files.every((file) => file.afterSha === undefined && file.changedSinceStep === null), 'a snapshot taken before a command says nothing about what the command left');
    equal([edit.targeted, command.targeted], [true, false], 'and the preview says which kind of checkpoint it is, so that a snapshot can be called incomplete');
    equal([edit.partial, edit.limitations.length, edit.taskId, edit.checkpointId], [true, 1, null, metas[0].id], 'it carries what the checkpoint says about itself (partial is always true: a checkpoint never claims to be complete) and which checkpoint it is');
    equal(await studio.recordAfterState(metas[3].id), null, 'a snapshot is refused when it is asked for directly too');
    equal(await fs.stat(path.join(studio.directory, 'checkpoints', metas[3].id, 'after.json')).then(() => true, () => false), false, 'and no note is written for it');
    // the file is changed behind the step
    await fs.writeFile(at('a.txt'), 'alpha ONE\nalpha two, edited later\n');
    const later = await studio.previewCheckpoint({ checkpointId: metas[0].id });
    equal([later.files[0].afterSha, later.files[0].changedSinceStep, later.files[0].currentSha], [sha(A1), true, sha('alpha ONE\nalpha two, edited later\n')], 'a later change shows: the file is no longer what the step left');
  });

  await section('what a step noted is kept beside the checkpoint; the checkpoint itself is written once and never changes', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [['local.edit_file', { path: 'b.txt', old_string: 'bravo', new_string: 'BRAVO' }]])), [], 'the task ran');
    const [meta] = await metasOf(studio, taskId);
    const metaPath = path.join(studio.directory, 'checkpoints', meta.id, 'meta.json');
    const bytesBefore = await fs.readFile(metaPath);
    await studio.recordAfterState(meta.id);
    await studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: await expectedNow('b.txt') });
    equal(await fs.readFile(metaPath), bytesBefore, 'meta.json is byte for byte what the checkpoint wrote');
    equal(await studio.recordAfterState(randomUUID()).catch((error) => error.code), 'checkpoint_missing', 'noting a checkpoint that does not exist is refused, never invented');
    const notePath = path.join(studio.directory, 'checkpoints', meta.id, 'after.json');
    const note = JSON.parse(await fs.readFile(notePath, 'utf8'));
    equal(note.files, { 'b.txt': sha('BRAVO\n') }, 'the note holds the sha of the file as the step left it, and a restore does not rewrite it');
    await fs.writeFile(notePath, JSON.stringify({ ...note, checkpointId: randomUUID() }));
    equal((await studio.previewCheckpoint({ checkpointId: meta.id })).files[0].afterSha, undefined, 'a note that belongs to another checkpoint is not believed');
  });

  await section('a call that throws after changing a file still notes what it left; a note that cannot be made never fails the call', async () => {
    reset(world);
    const taskId = randomUUID();
    const original = manager.localTools.call;
    manager.localTools.call = async () => { await fs.writeFile(at('a.txt'), 'half written\n'); throw new Error('boom'); };
    manager.acquireTask(taskId);
    let session;
    try {
      session = await manager.createAgentSession();
      await assert.rejects(session.callTool('local.edit_file', { path: 'a.txt', old_string: 'alpha one', new_string: 'alpha ONE' }, {}), /boom/);
      checks += 1;
    } finally {
      manager.localTools.call = original;
    }
    studio.recordAfterState = async () => { throw new Error('cannot note'); };
    try {
      const results = [await session.callTool('local.edit_file', { path: 'b.txt', old_string: 'bravo', new_string: 'BRAVO' }, {})];
      equal(failures(results), [], 'the call goes through although its note failed');
      equal(await disk('b.txt'), Buffer.from('BRAVO\n'), 'and did its work');
    } finally {
      delete studio.recordAfterState;
      await session.close();
      manager.releaseTask(taskId);
    }
    const [thrown] = await metasOf(studio, taskId);
    equal((await studio.previewCheckpoint({ checkpointId: thrown.id })).files[0].afterSha, sha('half written\n'), 'the file is noted as the throwing call left it');
  });

  // ------------------------------------------------------------------ some of the files of a checkpoint
  let batch;
  await section('a subset of a checkpoint is restored, and only that', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [['local.files_write_batch', { files: [
      { path: 'a.txt', content: 'alpha 1\n', overwrite: true },
      { path: 'b.txt', content: 'bravo 1\n', overwrite: true },
      { path: 'n.txt', content: `${String.fromCharCode(0xfeff)}new\r\nfile\r\n` },
    ] }]])), [], 'a batch that replaces two files and creates one ran');
    const [A1, B1, N1] = [await disk('a.txt'), await disk('b.txt'), await disk('n.txt')];
    equal([A1, B1], [Buffer.from('alpha 1\n'), Buffer.from('bravo 1\n')], 'the batch wrote what it was told');
    check(N1.subarray(0, 3).equals(BOM) && N1.includes('\r\n'), 'and the file it created begins with a BOM and has CRLF line endings');
    const [meta] = await metasOf(studio, taskId);
    equal([meta.files.map((file) => file.path), meta.absent], [['a.txt', 'b.txt'], ['n.txt']], 'its checkpoint holds the two files it replaced and records the one it created');
    batch = { taskId, id: meta.id, A1, B1, N1 };
    const before = await countCheckpoints(studio);
    const answer = await studio.restoreCheckpoint({ checkpointId: meta.id, files: ['a.txt'], expectedShas: { 'a.txt': sha(A1) } });
    equal(pick(answer, ['ok', 'restoredCount', 'filesModified', 'files', 'unchanged', 'conflicts']), { ok: true, restoredCount: 1, filesModified: 1, files: ['a.txt'], unchanged: [], conflicts: [] }, 'one file asked for, one file done');
    equal(answer.restored, [{ path: 'a.txt', action: 'overwrite', sha256: sha(A0) }], 'the answer says what was done and the sha the file has now');
    equal([await disk('a.txt'), await disk('b.txt'), await disk('n.txt')], [A0, B1, N1], 'a.txt is back; b.txt and n.txt are as the step left them, byte for byte');
    equal(await countCheckpoints(studio), before + 1, 'and one undo backup was made');
    check(typeof answer.undoCheckpointId === 'string' && answer.undoCheckpointId !== meta.id, 'it is named in the answer');
    const row = (await studio.checkpoints()).find((entry) => entry.id === answer.undoCheckpointId);
    equal(row && pick(row, ['fileCount', 'absentCount', 'taskId', 'kind', 'of', 'targeted']), { fileCount: 1, absentCount: 0, taskId: null, kind: 'undo', of: meta.id, targeted: true }, 'the undo backup is a real checkpoint of the list: it holds the one file that changed, belongs to no task, and says that it is an undo backup, and of which checkpoint');
    check(row.label.includes(meta.id), 'its label names the checkpoint');
    batch.undoId = answer.undoCheckpointId;
  });

  await section('a request that names what the checkpoint does not hold, or nothing, or without the shas, changes nothing', async () => {
    const before = [await disk('a.txt'), await disk('b.txt'), await disk('n.txt')];
    const count = await countCheckpoints(studio);
    const unknown = await raises(studio.restoreCheckpoint({ checkpointId: batch.id, files: ['b.txt', 'zzz.txt'], expectedShas: await expectedNow('b.txt') }), 'not_in_checkpoint', 'a path the checkpoint does not hold');
    check(unknown.message.includes('zzz.txt') && !unknown.message.includes('b.txt'), 'the message names the path that is not there');
    equal(unknown.statusCode, 409, 'it is a conflict');
    equal((await raises(studio.restoreCheckpoint({ checkpointId: batch.id, files: [], expectedShas: {} }), 'empty_selection', 'an empty list of files')).statusCode, 400, 'a bad request');
    await raises(studio.restoreCheckpoint({ checkpointId: batch.id, files: 'b.txt', expectedShas: await expectedNow('b.txt') }), 'bad_files', 'files that is not a list');
    await raises(studio.restoreCheckpoint({ checkpointId: batch.id, files: [42], expectedShas: {} }), 'bad_files', 'files that holds something that is not a path');
    equal((await raises(studio.restoreCheckpoint({ checkpointId: batch.id }), 'missing_expected_shas', 'no expected shas at all')).statusCode, 400, 'a bad request');
    await raises(studio.restoreCheckpoint({ checkpointId: batch.id, files: ['b.txt', 'n.txt'], expectedShas: await expectedNow('b.txt') }), 'missing_expected_shas', 'a file without its sha');
    await raises(studio.restoreCheckpoint({ checkpointId: batch.id, files: ['b.txt'], expectedShas: { 'b.txt': 'not a sha' } }), 'bad_expected_sha', 'a sha that is not one');
    await raises(studio.restoreCheckpoint({ checkpointId: batch.id, files: ['../outside.txt'], expectedShas: {} }), 'outside_workspace', 'a path outside the workspace');
    equal([await disk('a.txt'), await disk('b.txt'), await disk('n.txt')], before, 'no file changed');
    equal(await countCheckpoints(studio), count, 'and no undo backup was made');
    await raises(studio.restoreCheckpoint({ checkpointId: batch.id, taskId: batch.taskId, expectedShas: {} }), 'bad_source', 'both a checkpoint and a task');
    await raises(studio.restoreCheckpoint({ expectedShas: {} }), 'bad_checkpoint_id', 'neither');
  });

  await section('a file the step created is removed by going back, and the removal can be undone, byte for byte', async () => {
    const count = await countCheckpoints(studio);
    const answer = await studio.restoreCheckpoint({ checkpointId: batch.id, files: ['n.txt'], expectedShas: { 'n.txt': sha(batch.N1) } });
    equal([answer.restoredCount, changed(answer)], [1, [['n.txt', 'remove']]], 'one file removed');
    equal(answer.restored[0].sha256, null, 'it has no sha now');
    equal([await disk('n.txt'), await disk('a.txt'), await disk('b.txt')], [null, A0, batch.B1], 'it is gone; the others are as they were');
    equal(await countCheckpoints(studio), count + 1, 'nothing is deleted without an undo backup');
    const undo = await studio.previewCheckpoint({ checkpointId: answer.undoCheckpointId });
    equal(undo.files.map((file) => [file.path, file.kind, file.action]), [['n.txt', 'copy', 'recreate']], 'the backup holds the file as a copy; going back to it recreates the file');
    const undone = await studio.restoreCheckpoint({ checkpointId: answer.undoCheckpointId, expectedShas: { 'n.txt': null } });
    equal(changed(undone), [['n.txt', 'recreate']], 'undoing the restore recreates it');
    equal(await disk('n.txt'), batch.N1, 'with the very bytes it had (a BOM, CRLF line endings)');
  });

  await section('undoing a restore puts every file back, the ones that were replaced and the ones that were removed', async () => {
    const all = await studio.restoreCheckpoint({ checkpointId: batch.id, expectedShas: await expectedNow('a.txt', 'b.txt', 'n.txt') });
    equal([changed(all), all.unchanged], [[['b.txt', 'overwrite'], ['n.txt', 'remove']], ['a.txt']], 'the whole checkpoint: the file already back is not touched and is listed as unchanged');
    equal([await disk('a.txt'), await disk('b.txt'), await disk('n.txt')], [A0, B0, null], 'every file is as before the step');
    const undone = await studio.restoreCheckpoint({ checkpointId: all.undoCheckpointId, expectedShas: { 'b.txt': sha(B0), 'n.txt': null } });
    equal(changed(undone), [['b.txt', 'overwrite'], ['n.txt', 'recreate']], 'undoing it replays both');
    equal([await disk('a.txt'), await disk('b.txt'), await disk('n.txt')], [A0, batch.B1, batch.N1], 'and the files are as the step left them');
    const again = await studio.restoreCheckpoint({ checkpointId: undone.undoCheckpointId, expectedShas: { 'b.txt': sha(batch.B1), 'n.txt': sha(batch.N1) } });
    equal(changed(again), [['b.txt', 'overwrite'], ['n.txt', 'remove']], 'and an undo of the undo works too');
  });

  await section('line endings, a BOM and a binary file come back exactly', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [
      ['local.edit_file', { path: 'crlf.txt', old_string: 'two', new_string: 'TWO' }],
      ['local.edit_file', { path: 'bom.txt', old_string: 'bom line', new_string: 'BOM LINE' }],
      ['local.delete_path', { path: 'bin.dat' }],
    ])), [], 'the task ran');
    const edited = { crlf: await disk('crlf.txt'), bom: await disk('bom.txt') };
    check(!edited.crlf.equals(CRLF0) && !edited.bom.equals(BOMTXT0) && (await disk('bin.dat')) === null, 'the files changed');
    const metas = await metasOf(studio, taskId);
    for (const meta of metas) {
      const file = meta.files[0].path;
      const answer = await studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: await expectedNow(file) });
      equal(answer.restoredCount, 1, `${file} restored`);
    }
    equal([await disk('crlf.txt'), await disk('bom.txt'), await disk('bin.dat')], [CRLF0, BOMTXT0, BIN0], 'all three are the bytes they were');
  });

  // ------------------------------------------------------------------ later edits are conflicts, and are listed
  let conflictCase;
  await section('a file changed after the step is a conflict: by default nothing is done, and the message names it', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [['local.files_write_batch', { files: [
      { path: 'a.txt', content: 'alpha 1\n', overwrite: true },
      { path: 'b.txt', content: 'bravo 1\n', overwrite: true },
    ] }]])), [], 'the task ran');
    const [meta] = await metasOf(studio, taskId);
    conflictCase = { id: meta.id };
    const left = await expectedNow('a.txt', 'b.txt');
    await fs.writeFile(at('b.txt'), 'bravo, and then somebody typed this\n');
    const count = await countCheckpoints(studio);
    const error = await raises(studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: left }), 'stale_state', 'b.txt changed after the step');
    check(error.message.includes('b.txt') && !error.message.includes('a.txt'), 'the message names the file that changed, and only that one');
    equal(error.statusCode, 409, 'it is a conflict');
    equal([await disk('a.txt'), await disk('b.txt'), await countCheckpoints(studio)], [Buffer.from('alpha 1\n'), Buffer.from('bravo, and then somebody typed this\n'), count], 'a.txt was not touched either, and no backup was made');
  });

  await section('skip: the conflict is left as it is and listed, the rest is restored', async () => {
    const meta = conflictCase;
    const left = { 'a.txt': sha('alpha 1\n'), 'b.txt': sha('bravo 1\n') };
    const answer = await studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: left, onConflict: 'skip' });
    equal(pick(answer, ['restoredCount', 'files', 'unchanged']), { restoredCount: 1, files: ['a.txt'], unchanged: [] }, 'a.txt is done');
    equal(answer.conflicts, [{ path: 'b.txt', expectedSha: sha('bravo 1\n'), currentSha: sha('bravo, and then somebody typed this\n') }], 'b.txt is listed with the sha that was expected and the sha it has');
    equal([await disk('a.txt'), await disk('b.txt')], [A0, Buffer.from('bravo, and then somebody typed this\n')], 'b.txt keeps what was typed in it');
    const backup = await studio.previewCheckpoint({ checkpointId: answer.undoCheckpointId });
    equal(backup.files.map((file) => file.path), ['a.txt'], 'the undo backup holds only what was restored');
    const none = await studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: { 'a.txt': sha('alpha 1\n'), 'b.txt': sha('bravo 1\n') }, onConflict: 'skip' });
    equal([none.restoredCount, none.files, none.undoCheckpointId, none.unchanged, none.conflicts.map((entry) => entry.path)], [0, [], null, ['a.txt'], ['b.txt']], 'asked again: a.txt is already back, b.txt is still a conflict; nothing is done and no backup is made');
  });

  await section('a file that is already what the checkpoint holds is not a conflict, and a missing file expects null', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [['local.delete_path', { path: 'b.txt' }]])), [], 'a step deleted b.txt');
    const [meta] = await metasOf(studio, taskId);
    const wrong = await raises(studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: { 'b.txt': sha('something else') } }), 'stale_state', 'the file is missing and something else was expected');
    check(wrong.message.includes('b.txt'), 'the message names it');
    const done = await studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: { 'b.txt': null } });
    equal(changed(done), [['b.txt', 'recreate']], 'a missing file is expected as null, and comes back');
    equal(await disk('b.txt'), B0, 'as it was');
    const again = await studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: { 'b.txt': sha('whatever') } });
    equal([again.restoredCount, again.unchanged, again.undoCheckpointId], [0, ['b.txt'], null], 'asked again the file is already right, so whatever was expected, nothing happens');
  });

  // ------------------------------------------------------------------ the baseline of a task, in one go
  await section('every file of a task goes back to the baseline of the task in one restore, and one undo puts them all back', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [
      ['local.edit_file', { path: 'a.txt', old_string: 'alpha one', new_string: 'alpha ONE' }],
      ['local.files_write_batch', { files: [{ path: 'b.txt', content: 'bravo 1\n', overwrite: true }, { path: 'made1.txt', content: 'made\n' }] }],
      ['local.delete_path', { path: 'docs/c.txt' }],
      ['local.edit_file', { path: 'a.txt', old_string: 'alpha two', new_string: 'alpha TWO' }],
    ])), [], 'the task ran: a.txt edited twice, b.txt replaced, made1.txt created, docs/c.txt deleted');
    const post = { 'a.txt': await disk('a.txt'), 'b.txt': await disk('b.txt'), 'made1.txt': await disk('made1.txt'), 'docs/c.txt': await disk('docs/c.txt') };
    equal(post['a.txt'], Buffer.from('alpha ONE\nalpha TWO\n'), 'a.txt has both edits');
    const review = await studio.taskReview({ taskId });
    equal(review.files.map((file) => file.path).sort(), ['a.txt', 'b.txt', 'docs/c.txt', 'made1.txt'], 'the review knows the four files');
    const expected = await expectedNow('a.txt', 'b.txt', 'made1.txt', 'docs/c.txt');
    const preview = await studio.restoreCheckpoint({ taskId, dryRun: true });
    equal(preview.files.map((file) => [file.path, file.action]).sort(), [['a.txt', 'overwrite'], ['b.txt', 'overwrite'], ['docs/c.txt', 'recreate'], ['made1.txt', 'remove']], 'the preview says what each file would do');
    equal(await disk('a.txt'), post['a.txt'], 'and a preview changes nothing');
    const count = await countCheckpoints(studio);
    const answer = await studio.restoreCheckpoint({ taskId, expectedShas: expected });
    equal(answer.restoredCount, 4, 'four files restored');
    equal([await disk('a.txt'), await disk('b.txt'), await disk('made1.txt'), await disk('docs/c.txt')], [A0, B0, null, C0], 'a.txt is the first checkpoint\'s copy, not the second\'s; the created file is gone; the deleted one is back');
    equal(await countCheckpoints(studio), count + 1, 'one undo backup for all four');
    const taskBackup = (await studio.checkpoints()).find((row) => row.id === answer.undoCheckpointId);
    equal([taskBackup.kind, taskBackup.of, taskBackup.label.includes(taskId)], ['undo', taskId, true], 'it says it is the backup of this task\'s restore');
    const undone = await studio.restoreCheckpoint({ checkpointId: answer.undoCheckpointId, expectedShas: Object.fromEntries(answer.restored.map((entry) => [entry.path, entry.sha256])) });
    equal(undone.restoredCount, 4, 'one undo');
    equal([await disk('a.txt'), await disk('b.txt'), await disk('made1.txt'), await disk('docs/c.txt')], [post['a.txt'], post['b.txt'], post['made1.txt'], null], 'puts back what the task had left');
    equal((await studio.taskReview({ taskId })).checkpoints.total, 4, 'and the checkpoints of the task are still its four: a backup belongs to no task');
  });

  await section('some files of a task; a file the checkpoints cannot bring back is listed, not forgotten', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [
      ['local.edit_file', { path: 'a.txt', old_string: 'alpha one', new_string: 'alpha ONE' }],
      ['local.edit_file', { path: 'b.txt', old_string: 'bravo', new_string: 'BRAVO' }],
      ['local.run_command', { command: 'node tools/make-bytes.js', description: 'a command that makes two files' }],
      ['local.run_command', { command: 'node tools/rewrite-bin.js', description: 'a command that rewrites a binary file' }],
    ])), [], 'the task ran');
    const some = await studio.restoreCheckpoint({ taskId, files: ['b.txt'], expectedShas: await expectedNow('b.txt') });
    equal([some.files, await disk('a.txt'), await disk('b.txt')], [['b.txt'], Buffer.from('alpha ONE\nalpha two\n'), B0], 'only b.txt went back');
    const preview = await studio.restoreCheckpoint({ taskId, dryRun: true });
    equal(preview.unsupported, [
      { path: 'bin.dat', reason: 'baseline_from_git' },
      { path: 'made.bin', reason: 'created_not_recorded' },
      { path: 'made.txt', reason: 'created_not_recorded' },
    ], 'the files a command made or rewrote have no copy to go back to: they are named, each with the reason');
    equal([preview.targeted, preview.partial], [false, true], 'and the preview says the baseline is a partial one, since a command ran');
    await raises(studio.restoreCheckpoint({ taskId, files: ['made.bin'], expectedShas: await expectedNow('made.bin') }), 'not_in_checkpoint', 'asking for one of them');
    equal(await disk('made.bin'), Buffer.from([0, 1, 2, 3]), 'it is left alone');
  });

  await section('a file whose copy is damaged, or that no checkpoint could keep, is named and left alone while the others are restored', async () => {
    reset(world);
    await fs.writeFile(at('huge.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x79));
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [
      ['local.edit_file', { path: 'a.txt', old_string: 'alpha one', new_string: 'alpha ONE' }],
      ['local.edit_file', { path: 'b.txt', old_string: 'bravo', new_string: 'BRAVO' }],
      ['local.delete_path', { path: 'huge.txt' }],
    ])), [], 'the task ran: two edits, and a file too large for a checkpoint was deleted');
    const [first] = await metasOf(studio, taskId);
    await fs.writeFile(path.join(studio.directory, 'checkpoints', first.id, 'files', 'a.txt'), 'someone replaced this copy\n');
    const preview = await studio.restoreCheckpoint({ taskId, dryRun: true });
    equal(preview.unsupported, [{ path: 'a.txt', reason: 'checkpoint_corrupt' }, { path: 'huge.txt', reason: 'baseline_unavailable' }], 'the damaged copy and the file that no checkpoint holds are named, each with its reason');
    equal(preview.files.map((file) => file.path), ['b.txt'], 'and the preview offers the file that can come back');
    equal([preview.targeted, preview.partial], [true, true], 'no command ran, so the baseline is exact, but it is partial because some files cannot come back');
    const done = await studio.restoreCheckpoint({ taskId, expectedShas: await expectedNow('b.txt') });
    equal([done.files, await disk('b.txt'), await disk('a.txt')], [['b.txt'], B0, Buffer.from('alpha ONE\nalpha two\n')], 'b.txt came back; a.txt, whose copy is not to be trusted, was not touched');
  });

  await section('a checkpoint of the task that cannot be read is said so, and the files that can be restored still are', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [
      ['local.edit_file', { path: 'a.txt', old_string: 'alpha one', new_string: 'alpha ONE' }],
      ['local.edit_file', { path: 'b.txt', old_string: 'bravo', new_string: 'BRAVO' }],
    ])), [], 'the task ran');
    const [first] = await metasOf(studio, taskId);
    const directory = path.join(studio.directory, 'checkpoints', first.id);
    await fs.writeFile(path.join(directory, 'meta.json'), '{ not json');
    try {
      const preview = await studio.restoreCheckpoint({ taskId, dryRun: true });
      equal(preview.files.map((file) => file.path), ['b.txt'], 'only the file whose checkpoint can be read is offered');
      equal(preview.limitations.length, 1, 'and the preview says that a checkpoint could not be read');
      check(preview.limitations[0].includes('1 checkpoint'), 'with the number of them');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------------ the rules that stay
  await section('nothing is restored, and nothing previewed, while an agent is running', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [['local.edit_file', { path: 'a.txt', old_string: 'alpha one', new_string: 'alpha ONE' }]])), [], 'the task ran');
    const [meta] = await metasOf(studio, taskId);
    const left = await expectedNow('a.txt');
    const running = randomUUID();
    manager.acquireTask(running);
    try {
      const error = await raises(studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: left }), 'task_in_progress', 'while a task runs');
      equal(error.statusCode, 409, 'a conflict');
      await raises(studio.restoreCheckpoint({ checkpointId: meta.id, dryRun: true }), 'task_in_progress', 'a preview too');
      await raises(studio.restoreCheckpoint({ taskId, expectedShas: left }), 'task_in_progress', 'and the baseline of a task');
    } finally {
      manager.releaseTask(running);
    }
    equal(await disk('a.txt'), Buffer.from('alpha ONE\nalpha two\n'), 'the file was not touched');
  });

  await section('a request that is malformed, spelled another way, or made twice at once', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [['local.edit_file', { path: 'b.txt', old_string: 'bravo', new_string: 'BRAVO' }]])), [], 'the task ran');
    const [meta] = await metasOf(studio, taskId);
    const left = await expectedNow('b.txt');
    equal((await raises(studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: left, onConflict: 'overwrite' }), 'bad_on_conflict', 'a way of handling conflicts nobody defined')).statusCode, 400, 'a bad request');
    equal(await disk('b.txt'), Buffer.from('BRAVO\n'), 'nothing was done');
    await raises(studio.restoreCheckpoint({ taskId: 'not-an-id', expectedShas: left }), 'bad_task_id', 'a task id that is not one');
    const settled = await Promise.allSettled([
      studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: left }),
      studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: left }),
    ]);
    equal(settled.map((entry) => entry.status), ['fulfilled', 'rejected'], 'two restores at once: the first goes, the second is turned away');
    equal(settled[1].reason.code, 'restore_busy', 'with its own code');
    equal(await disk('b.txt'), B0, 'and the file is restored once');
    const spelled = await studio.restoreCheckpoint({ checkpointId: meta.id, files: ['./b.txt'], expectedShas: { 'b.txt': sha(B0) } });
    equal([spelled.restoredCount, spelled.unchanged], [0, ['b.txt']], 'a path spelled ./b.txt is b.txt (and it is already back)');
    const next = await studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: { 'b.txt': sha(B0) } });
    equal(next.restoredCount, 0, 'the lock is released after a restore: a later one is not turned away');
  });

  // ------------------------------------------------------------------ a checkpoint is not trusted either
  /** A checkpoint made by hand, as a hostile or damaged state folder could hold. */
  async function forge({ files = [], absent = [], copies = {}, workspace = null }) {
    const id = randomUUID();
    const directory = path.join(studio.directory, 'checkpoints', id);
    for (const [relative, bytes] of Object.entries(copies)) {
      await fs.mkdir(path.dirname(path.join(directory, 'files', relative)), { recursive: true });
      await fs.writeFile(path.join(directory, 'files', relative), bytes);
    }
    await fs.mkdir(path.join(directory, 'files'), { recursive: true });
    const meta = { id, at: new Date().toISOString(), seq: 999999, label: 'forged', workspace: workspace ?? await fs.realpath(world.workspace), taskId: null, files, absent, partial: true, targeted: true, skipped: [], limitations: [], totalBytes: 0 };
    await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify(meta));
    return id;
  }
  const entry = (relative, bytes) => ({ path: relative, sha256: sha(bytes), bytes: bytes.length });

  await section('a checkpoint that names a protected file, a folder, a link or a path outside is refused as a whole', async () => {
    reset(world);
    const secret = Buffer.from('TOKEN=not-a-real-secret\n');
    const protectedId = await forge({ files: [entry('b.txt', Buffer.from('forged b\n')), entry('.env', secret)], copies: { 'b.txt': Buffer.from('forged b\n'), '.env': secret } });
    const error = await raises(studio.restoreCheckpoint({ checkpointId: protectedId, expectedShas: { 'b.txt': sha(B0), '.env': null } }), 'path_escape', 'a protected file');
    equal(error.statusCode, 403, 'forbidden');
    equal([await disk('b.txt'), await disk('.env')], [B0, null], 'the other file was not touched either, and the secret was not written');
    const outsideId = await forge({ files: [entry('../escaped.txt', secret)], copies: { 'escaped.txt': secret } });
    await raises(studio.restoreCheckpoint({ checkpointId: outsideId, expectedShas: { '../escaped.txt': null } }), 'outside_workspace', 'a path outside the workspace');
    await fs.mkdir(at('folder.txt'));
    const folderId = await forge({ files: [entry('folder.txt', Buffer.from('x\n'))], copies: { 'folder.txt': Buffer.from('x\n') } });
    await raises(studio.restoreCheckpoint({ checkpointId: folderId, expectedShas: { 'folder.txt': null } }), 'file_type', 'a folder where a file should go');
    const rootId = await forge({ files: [entry('.', Buffer.from('x\n'))] });
    await raises(studio.restoreCheckpoint({ checkpointId: rootId, expectedShas: { '.': null } }), 'path_escape', 'the workspace folder itself as a file');
    equal((await raises(studio.restoreCheckpoint({ checkpointId: await forge({}), expectedShas: {} }), 'empty_checkpoint', 'a checkpoint that holds nothing')).statusCode, 400, 'a bad request');
    const foreign = await forge({ files: [entry('b.txt', Buffer.from('forged b\n'))], copies: { 'b.txt': Buffer.from('forged b\n') }, workspace: path.join(root, 'another-workspace') });
    equal((await raises(studio.restoreCheckpoint({ checkpointId: foreign, expectedShas: { 'b.txt': sha(B0) } }), 'checkpoint_missing', 'a checkpoint of another workspace')).statusCode, 404, 'is not found');
    await raises(studio.previewCheckpoint({ checkpointId: foreign }), 'checkpoint_missing', 'a preview of it');
    await raises(studio.recordAfterState(foreign), 'checkpoint_missing', 'noting it');
    equal(await disk('b.txt'), B0, 'b.txt was not touched');
    let linked = true;
    try { await fs.symlink(at('a.txt'), at('link.txt')); } catch { linked = false; } // links need a privilege on Windows
    if (linked) {
      const linkId = await forge({ files: [entry('link.txt', Buffer.from('x\n'))], copies: { 'link.txt': Buffer.from('x\n') } });
      await raises(studio.restoreCheckpoint({ checkpointId: linkId, expectedShas: { 'link.txt': sha(A0) } }), 'symlink_escape', 'a link');
      equal(await disk('a.txt'), A0, 'the file behind the link is untouched');
    }
  });

  await section('a copy that does not match its sha stops the restore before anything is written', async () => {
    reset(world);
    const id = await forge({ files: [entry('a.txt', Buffer.from('forged a\n')), entry('b.txt', Buffer.from('forged b\n'))], copies: { 'a.txt': Buffer.from('forged a\n'), 'b.txt': Buffer.from('somebody replaced this copy\n') } });
    const count = await countCheckpoints(studio);
    const error = await raises(studio.restoreCheckpoint({ checkpointId: id, expectedShas: await expectedNow('a.txt', 'b.txt') }), 'checkpoint_corrupt', 'a damaged copy');
    check(error.message.includes('b.txt'), 'the message names it');
    equal([await disk('a.txt'), await disk('b.txt'), await countCheckpoints(studio)], [A0, B0, count], 'the good copy was not written, and no backup was made');
  });

  // ------------------------------------------------------------------ the backup, and what a failed write leaves
  /** A file system for a restore, the real one except that the first call of `name` that `match`es does something else. */
  function faulty(name, match, replacement) {
    let hit = false;
    const io = { readFile: fs.readFile, writeFile: fs.writeFile, rename: fs.rename, unlink: fs.unlink, mkdir: fs.mkdir };
    const real = io[name];
    io[name] = async (...args) => {
      if (!hit && match(args)) { hit = true; return replacement(real, ...args); }
      return real(...args);
    };
    return io;
  }
  const touching = (file) => (args) => args.some((argument) => String(argument).replaceAll('\\', '/').endsWith(`/${file}`));

  async function editedBatch(files) {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [['local.files_write_batch', { files: files.map(([file, content]) => ({ path: file, content, overwrite: true })) }]])), [], 'the task ran');
    return (await metasOf(studio, taskId))[0];
  }

  await section('a restore that cannot save what it is about to change is refused whole, and leaves no backup behind', async () => {
    const meta = await editedBatch([['a.txt', 'alpha 1\n']]);
    const left = await expectedNow('a.txt');
    const count = await countCheckpoints(studio);
    // the file is changed after it was read and before it is saved
    const original = studio.checkpoint;
    studio.checkpoint = async (request) => { await fs.writeFile(at('a.txt'), 'changed in between\n'); return original.call(studio, request); };
    try {
      const error = await raises(studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: left }), 'undo_backup_incomplete', 'a file that changes before it is saved');
      equal(error.statusCode, 500, 'a server error');
    } finally { delete studio.checkpoint; }
    equal([await disk('a.txt'), await countCheckpoints(studio)], [Buffer.from('changed in between\n'), count], 'the file is as it was changed, and the half-made backup is gone');
    // a file too large to save
    await fs.writeFile(at('a.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x78));
    const big = await raises(studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: await expectedNow('a.txt') }), 'undo_backup_incomplete', 'a file too large to save first');
    check(big.message.includes('a.txt'), 'the message names it');
    equal([(await disk('a.txt')).length, await countCheckpoints(studio)], [8 * 1024 * 1024 + 1, count], 'it was not overwritten, and no backup is left');
    // a file that appears where a deleted one should come back
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [['local.delete_path', { path: 'b.txt' }]])), [], 'a step deleted b.txt');
    const [deleted] = await metasOf(studio, taskId);
    const before = await countCheckpoints(studio);
    studio.checkpoint = async (request) => { await fs.writeFile(at('b.txt'), 'appeared in between\n'); return original.call(studio, request); };
    try {
      await raises(studio.restoreCheckpoint({ checkpointId: deleted.id, expectedShas: { 'b.txt': null } }), 'undo_backup_incomplete', 'a file that appears before it is saved');
    } finally { delete studio.checkpoint; }
    equal([await disk('b.txt'), await countCheckpoints(studio)], [Buffer.from('appeared in between\n'), before], 'the file that appeared is not overwritten, and no backup is left');
  });

  await section('a file that changes after it is saved: nothing is written over it, the others are put back, the backup goes', async () => {
    const meta = await editedBatch([['a.txt', 'alpha 1\n'], ['b.txt', 'bravo 1\n']]);
    const left = await expectedNow('a.txt', 'b.txt');
    const count = await countCheckpoints(studio);
    const original = studio.checkpoint;
    studio.checkpoint = async (request) => { const made = await original.call(studio, request); await fs.writeFile(at('b.txt'), 'changed after the backup\n'); return made; };
    try {
      const error = await raises(studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: left }), 'stale_state', 'b.txt changes after the backup');
      equal(error.rolledBack, ['a.txt'], 'a.txt had been restored and is put back');
    } finally { delete studio.checkpoint; }
    equal([await disk('a.txt'), await disk('b.txt'), await countCheckpoints(studio)], [Buffer.from('alpha 1\n'), Buffer.from('changed after the backup\n'), count], 'a.txt is as the step left it, b.txt as it was changed, and the backup is gone');
  });

  await section('a write that fails: everything is put back and the backup goes; if something cannot be put back the backup stays, named in the error', async () => {
    const meta = await editedBatch([['a.txt', 'alpha 1\n'], ['b.txt', 'bravo 1\n']]);
    const left = await expectedNow('a.txt', 'b.txt');
    const count = await countCheckpoints(studio);
    studio.restoreIo = faulty('rename', touching('b.txt'), async () => { throw Object.assign(new Error('disk said no'), { code: 'EPERM' }); });
    try {
      const error = await raises(studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: left }), 'restore_failed_rolled_back', 'the second write fails');
      equal(error.rolledBack, ['a.txt'], 'the first file was put back');
    } finally { studio.restoreIo = undefined; }
    equal([await disk('a.txt'), await disk('b.txt'), await countCheckpoints(studio)], [Buffer.from('alpha 1\n'), Buffer.from('bravo 1\n'), count], 'both files are as the step left them, and the backup is gone');
    studio.restoreIo = faulty('rename', touching('b.txt'), async () => { await fs.writeFile(at('a.txt'), 'edited while we were busy\n'); throw Object.assign(new Error('disk said no'), { code: 'EPERM' }); });
    let partial;
    try {
      partial = await raises(studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: left }), 'restore_partial_failure', 'a file is edited while the restore fails');
    } finally { studio.restoreIo = undefined; }
    equal(partial.failedRollback.map((item) => item.path), ['a.txt'], 'the file that could not be put back is named');
    const backup = (await studio.checkpoints()).find((row) => row.id === partial.undoCheckpointId);
    check(Boolean(backup) && backup.kind === 'undo', 'and the backup that holds the files as they were is kept, and named in the error');
    equal(await disk('a.txt'), Buffer.from('edited while we were busy\n'), 'what was typed meanwhile is not overwritten');
    // a file that is not what was written when it is read back
    await fs.writeFile(at('a.txt'), 'alpha 1\n');
    studio.restoreIo = faulty('rename', touching('a.txt'), async (real, from, to) => { await real(from, to); await fs.writeFile(to, 'corrupted after the rename'); });
    let spoiled;
    try {
      spoiled = await raises(studio.restoreCheckpoint({ checkpointId: meta.id, expectedShas: left }), 'restore_verify_failed', 'a file that is not what was written');
    } finally { studio.restoreIo = undefined; }
    equal([spoiled.rolledBack, spoiled.failedRollback.map((item) => item.path)], [['b.txt'], ['a.txt']], 'what could be put back was, and the file that is neither is named');
    check((await studio.checkpoints()).some((row) => row.id === spoiled.undoCheckpointId), 'and the backup is kept, named in the error');
  });

  // ------------------------------------------------------------------ a snapshot before a command
  await section('a snapshot taken before a command restores like any checkpoint, and says it is not complete', async () => {
    reset(world);
    const taskId = randomUUID();
    equal(failures(await runTask(world, taskId, [['local.run_command', { command: 'node tools/rewrite-notes.js', description: 'a command that rewrites notes.md' }]])), [], 'the task ran');
    equal(await disk('notes.md'), Buffer.from('rewritten by a command\n'), 'the command rewrote notes.md');
    const [snapshot] = await metasOf(studio, taskId);
    check(snapshot.targeted === false && snapshot.files.length > 1, 'the checkpoint is a snapshot of many files, not of the one the command changed');
    const answer = await studio.restoreCheckpoint({ checkpointId: snapshot.id, files: ['notes.md'], expectedShas: await expectedNow('notes.md') });
    equal([answer.files, answer.targeted, answer.warnings.length], [['notes.md'], false, 1], 'one file is restored, and the answer says that the snapshot is not complete');
    equal(await disk('notes.md'), Buffer.from('# notes\nfirst\n'), 'notes.md is what it was before the command');
    const exact = await editedBatch([['b.txt', 'bravo 1\n']]);
    const targeted = await studio.restoreCheckpoint({ checkpointId: exact.id, expectedShas: await expectedNow('b.txt') });
    equal([targeted.targeted, targeted.warnings], [true, []], 'a checkpoint of exactly the files of a call has nothing to warn about');
  });

  console.log(`PASS: ${checks} checkpoint restore checks`);
} finally {
  for (const timer of approvers) clearInterval(timer);
  for (const manager of managers) await manager.shutdown().catch(() => {});
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
