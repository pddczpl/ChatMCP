// What a person (or a client of the Hub that is not the page: an editor over ACP) is told about a tool call, and the review of the whole task, on a REAL Hub with a scripted model
// (plan tasks ux-3, ux-4 and ux-5, the Hub side).
//
//   A. The events of a tool call carry their own id (callId), a bounded input (path, command: never the text of a file) and, on the result of a call that changed files, the
//      checkpoint made for THAT call (checkpointId). One model turn makes three calls, two of them to the same tool: they pair by callId, and a checkpoint is not a sticky field
//      that every later event inherits.
//   B. A task file written before these fields existed still loads, and loading adds nothing to it.
//   C. The review of the task over HTTP: the same checkpoints, a request cannot forge one, a created file is moved to the undo folder only for the sha that was reviewed.
//   D. While a task runs nothing is saved from the editor or rejected; when it has stopped both are.
// CLAIM: checkpoints
import fs from 'node:fs';
import path from 'node:path';
import { eventually, runScenario, sha256 } from './e2e/harness.mjs';
import { answerApprovals, connectModel, pendingApprovals, setMode, startTask, waitForState } from './e2e/hub-process.mjs';
import { BUGGY_CALC, exists, gitInit, makeCalcProject, read } from './e2e/fixtures.mjs';
import { call, calls, say, sequence } from './e2e/scenarios.mjs';
import { publicToolInput } from '../lib/tool-event-input.mjs';

const SECRET_BODY = 'PRIVATE-FILE-BODY-0123456789';

await runScenario({
  name: 'review',
  summary: 'callId / input / checkpointId on tool events, an old task file, the task review over HTTP, no save or reject while a task runs',
  budgetMs: 170_000,
}, async (t) => {
  // ---- the bounded input, as a function ------------------------------------------------------------------------------------------
  t.equal(publicToolInput({ path: 'a/b.txt', content: SECRET_BODY, overwrite: true }), { path: 'a/b.txt' }, 'a write is announced by its path, never by the text it writes');
  t.equal(publicToolInput({ command: 'node test.js', description: 'a sentence', cwd: 'sub', timeout_seconds: 5 }), { command: 'node test.js' }, 'a command by the command');
  t.equal(publicToolInput({ files: [{ path: 'a', content: SECRET_BODY }, { path: 'b', content: SECRET_BODY }] }), { paths: ['a', 'b'] }, 'a batch by its paths');
  t.equal(publicToolInput({ source: 'a', destination: 'b' }), { source: 'a', destination: 'b' }, 'a move by both ends');
  t.equal(publicToolInput({ file: 'x.py', line: 3, apply: true }), { path: 'x.py' }, 'the tools that name their file `file` are announced by path too');
  t.equal(publicToolInput({ path: 5, command: ['x'], files: 'no', source: {} }), {}, 'only strings are taken');
  t.equal(publicToolInput(null), {}, 'no arguments, no input');
  t.equal(publicToolInput([1, 2]), {}, 'arguments that are not an object, no input');
  const longCommand = publicToolInput({ command: 'x'.repeat(2000) });
  t.equal([longCommand.command.length, longCommand.truncated], [500, true], 'a long command is cut at 500 characters and says so');
  const longPath = publicToolInput({ path: 'p'.repeat(1000) });
  t.equal([longPath.path.length, longPath.truncated], [300, true], 'a long path is cut at 300 and says so');
  const manyFiles = publicToolInput({ files: Array.from({ length: 50 }, (_, i) => ({ path: `f${i}` })) });
  t.equal([manyFiles.paths.length, manyFiles.truncated], [20, true], 'a batch of 50 lists 20 paths and says so');
  t.equal(JSON.stringify(publicToolInput({ path: 'ok', content: SECRET_BODY, edits: [{ old_string: SECRET_BODY }] })).includes(SECRET_BODY), false, 'nothing else of the arguments is copied');

  // ---- the Hub -----------------------------------------------------------------------------------------------------------------------
  const project = path.join(t.scratch, 'proj');
  makeCalcProject(project);
  fs.writeFileSync(path.join(project, 'ok.js'), "console.log('ok');\n");
  gitInit(project, t.scratch);
  const stateDir = path.join(t.scratch, 'state');
  const mock = await t.mock({
    scenario: 'turn',
    scenarios: {
      // ONE model turn with three calls, two to the same tool and a read between them; then a command; then the answer. (`turn` counts the results the model has seen: three after the first turn.)
      turn: (ctx) => {
        if (ctx.turn === 0) return calls(['write_file', { path: 'out/a.txt', content: 'A\n' }], ['read_file', { path: 'out/a.txt' }], ['write_file', { path: 'out/b.txt', content: 'B\n' }]);
        if (ctx.turn === 3) return call('run_command', { command: 'node ok.js', description: 'runs a script that succeeds' });
        return say('Xong.');
      },
      // A write that waits for the person to decide.
      waits: sequence([call('write_file', { path: 'wait.txt', content: 'W\n' })], { final: 'Đã xong.' }),
    },
  });
  const hub = await t.hub({ project, stateDir, logName: 'hub-1.log' });
  await connectModel(hub, mock);
  await setMode(hub, 'autonomous');

  // ---- A. the events of a tool call ----------------------------------------------------------------------------------------------
  const started = await startTask(hub, 'Tạo hai file out/a.txt và out/b.txt, đọc lại a.txt, rồi in phiên bản node.');
  const settled = await answerApprovals(hub, started.id, () => true);
  t.equal(settled.task.state, 'completed', 'the task completes');
  const task = await hub.task(started.id);
  const starts = task.events.filter((event) => event.type === 'tool_start');
  const ends = task.events.filter((event) => event.type === 'tool_result' || event.type === 'tool_error');
  t.equal(starts.map((event) => event.toolName), ['local.write_file', 'local.read_file', 'local.write_file', 'local.run_command'], 'four calls were announced, in order');
  t.check(starts.every((event) => typeof event.callId === 'string' && event.callId.length > 0) && new Set(starts.map((event) => event.callId)).size === 4, 'each start has a callId of its own', JSON.stringify(starts.map((event) => event.callId)));
  const pairs = starts.map((start) => ({ start, ends: ends.filter((end) => end.callId === start.callId) }));
  t.check(pairs.every((pair) => pair.ends.length === 1 && pair.ends[0].toolName === pair.start.toolName && pair.ends[0].type === 'tool_result'), 'every start has exactly one result with the same callId, of the same tool');
  t.equal(ends.length, 4, 'and there is no result without a start');
  t.equal(pairs.map((pair) => pair.start.input), [{ path: 'out/a.txt' }, { path: 'out/a.txt' }, { path: 'out/b.txt' }, { command: 'node ok.js' }], 'the input is the path or the command, nothing else');
  t.equal(pairs.map((pair) => pair.ends[0].input), pairs.map((pair) => pair.start.input), 'and the result repeats it, so that it can be read without its start (the log keeps the last events only)');
  const [writeA, readA, writeB, command] = pairs.map((pair) => pair.ends[0]);
  t.check(typeof writeA.checkpointId === 'string' && typeof writeB.checkpointId === 'string' && writeA.checkpointId !== writeB.checkpointId, 'the two writes, one tool in one turn, each have a checkpoint of their own', `${writeA.checkpointId} ${writeB.checkpointId}`);
  t.check(!('checkpointId' in readA), 'the read between them has none: the checkpoint of the write before it is not inherited');
  t.check(typeof command.checkpointId === 'string' && command.checkpointId !== writeB.checkpointId, 'a command has the snapshot made for it');
  t.check(starts.every((event) => !('checkpointId' in event)), 'a start does not have one: it is made after the start is announced');
  t.check(starts.every((event) => event.status === 'running' && event.message.startsWith(`Đang gọi ${event.toolName}.`)) && ends.every((event) => event.status === 'completed'), 'the status and the message of the events are as they were');
  const metaOf = (id) => JSON.parse(fs.readFileSync(path.join(stateDir, 'studio', 'checkpoints', id, 'meta.json'), 'utf8'));
  t.equal([metaOf(writeA.checkpointId).taskId, metaOf(writeA.checkpointId).absent, metaOf(writeA.checkpointId).files], [started.id, ['out/a.txt'], []], 'the checkpoint of the first write is the one that recorded out/a.txt as absent, for this task');
  t.equal([metaOf(writeB.checkpointId).absent, metaOf(writeB.checkpointId).targeted, metaOf(command.checkpointId).targeted], [['out/b.txt'], true, false], 'the second write\'s is its own, and the command\'s is a snapshot of the workspace');
  const stored = JSON.parse(fs.readFileSync(path.join(stateDir, 'api-tasks', started.id, 'task.json'), 'utf8'));
  t.equal(stored.events.filter((event) => event.type === 'tool_result').map((event) => event.checkpointId), [writeA.checkpointId, undefined, writeB.checkpointId, command.checkpointId], 'task.json keeps them');
  const transcript = fs.readFileSync(path.join(stateDir, 'api-tasks', started.id, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  t.check(transcript.some((line) => line.type === 'tool_start' && line.callId === starts[0].callId && line.detail?.call_id === starts[0].callId), 'and so does the transcript, next to the call_id it has always had');
  t.check(transcript.filter((line) => line.type === 'tool_result_full').length === 4, 'the full results are in the transcript as before');

  // ---- C. the review over HTTP ---------------------------------------------------------------------------------------------------
  const review = (await hub.get(`/api/studio/task-review?taskId=${started.id}`)).json;
  t.equal(review.files.map((entry) => entry.path), ['out/a.txt', 'out/b.txt'], 'the review lists the two files the task created');
  t.equal(review.files.map((entry) => [entry.status, entry.baselineText, entry.currentText, entry.currentSha, entry.rejectable]), [
    ['created', null, 'A\n', sha256('A\n'), true], ['created', null, 'B\n', sha256('B\n'), true]], 'as created, with their text and sha');
  t.equal(review.files.map((entry) => entry.checkpointId), [writeA.checkpointId, writeB.checkpointId], 'and the baseline of each is the checkpoint that its tool_result announced');
  t.equal([review.checkpoints.total, review.checkpoints.targeted, review.checkpoints.broad], [3, 2, 1], 'made of the three checkpoints of the task');
  const bad = await hub.request('GET', '/api/studio/task-review?taskId=nope');
  t.equal([bad.status, bad.json?.code], [400, 'bad_task_id'], 'a task id that is not one is refused');
  const unknown = (await hub.get(`/api/studio/task-review?taskId=${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`)).json;
  t.equal([unknown.files, unknown.limitations.map((note) => note.code)], [[], ['no_checkpoints']], 'a task the Hub has nothing on says so, instead of an empty list that reads as "no changes"');
  const forged = await hub.request('POST', '/api/studio/checkpoint', { label: 'forged', taskId: started.id, files: ['out/a.txt'], absent: ['nothing'] });
  t.equal([forged.status, forged.json?.taskId, forged.json?.targeted], [200, null, false], 'a request cannot make a checkpoint that belongs to a task or names its files');
  t.equal((await hub.get(`/api/studio/task-review?taskId=${started.id}`)).json.checkpoints.total, 3, 'so the review of the task is the same');
  const wrong = await hub.request('POST', '/api/studio/review/reject-created', { taskId: started.id, file: 'out/a.txt', expectedSha: 'f'.repeat(64) });
  t.equal([wrong.status, wrong.json?.code], [409, 'stale_review'], 'a created file is not rejected for a sha that was not reviewed');
  await hub.post('/api/studio/permissions/config', { executionPolicy: 'sandbox-only' });
  const sandboxed = await hub.request('POST', '/api/studio/review/reject-created', { taskId: started.id, file: 'out/a.txt', expectedSha: sha256('A\n') });
  t.equal([sandboxed.status, exists(project, 'out/a.txt')], [403, true], 'and not at all under sandbox-only, where the Hub does not write to the host');
  await hub.post('/api/studio/permissions/config', { executionPolicy: 'host-review' });
  const rejected = await hub.request('POST', '/api/studio/review/reject-created', { taskId: started.id, file: 'out/a.txt', expectedSha: sha256('A\n') });
  t.equal([rejected.status, rejected.json?.ok, exists(project, 'out/a.txt')], [200, true, false], 'for the sha that was reviewed it is moved out of the workspace');
  t.check(rejected.json?.undoBackup && fs.readFileSync(rejected.json.undoBackup, 'utf8') === 'A\n', 'to the undo folder, intact');
  t.equal((await hub.get(`/api/studio/task-review?taskId=${started.id}`)).json.files.map((entry) => entry.path), ['out/b.txt'], 'and the review no longer lists it');

  // ---- D. while a task runs -------------------------------------------------------------------------------------------------------
  await setMode(hub, 'review');
  mock.setScenario('waits');
  const waiting = await startTask(hub, 'Tạo wait.txt.');
  const request = await eventually(async () => (await pendingApprovals(hub)).find((item) => item.taskId === waiting.id), { label: 'the approval of the write' });
  const calc = await hub.get('/api/studio/file?file=calc.js');
  const saveWhileBusy = await hub.request('POST', '/api/studio/file/save', { file: 'calc.js', content: BUGGY_CALC.replace('a - b', 'a + b'), expectedSha: calc.json.sha256 });
  t.equal([saveWhileBusy.status, read(project, 'calc.js')], [409, BUGGY_CALC], 'a save from the editor is refused while a task is waiting for the person, and writes nothing');
  const rejectWhileBusy = await hub.request('POST', '/api/studio/review/reject-created', { taskId: started.id, file: 'out/b.txt', expectedSha: sha256('B\n') });
  t.equal([rejectWhileBusy.status, rejectWhileBusy.json?.code, exists(project, 'out/b.txt')], [409, 'task_in_progress', true], 'so is the rejection of a created file');
  await hub.post('/api/studio/permissions/decide', { id: request.id, approved: false });
  await waitForState(hub, waiting.id, ['completed']);
  const saved = await hub.request('POST', '/api/studio/file/save', { file: 'calc.js', content: BUGGY_CALC.replace('a - b', 'a + b'), expectedSha: calc.json.sha256 });
  t.equal([saved.status, saved.json?.sha256, read(project, 'calc.js')], [200, sha256(BUGGY_CALC.replace('a - b', 'a + b')), BUGGY_CALC.replace('a - b', 'a + b')], 'once the task has stopped the same save is made, and the answer carries the sha of the new file');
  const noTextFor = await hub.get(`/api/studio/task-review?taskId=${waiting.id}`);
  t.equal([noTextFor.json.files, noTextFor.json.checkpoints.total], [[], 0], 'the refused write made no checkpoint, so that task has nothing to review');
  // The person saved calc.js after the first task had stopped; Git sees it as changed since that task\'s snapshot of the workspace, but the task had ended by then.
  t.equal((await hub.get(`/api/studio/task-review?taskId=${started.id}`)).json.files.map((entry) => entry.path), ['out/b.txt'], 'what the person wrote after a task stopped is not in the review of that task');

  // ---- B. a task file from before these fields --------------------------------------------------------------------------------------
  await hub.stop();
  const taskFile = path.join(stateDir, 'api-tasks', started.id, 'task.json');
  const old = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  const strip = ({ callId, input, checkpointId, ...rest }) => rest;
  old.events = old.events.map(strip);
  // The Hub that wrote it died with a call in flight: the record of that call is the old one, without a checkpoint.
  old.status = 'running';
  old.finishedAt = null;
  old.pendingCall = { callId: 'call_old', toolName: 'local.write_file', startedAt: old.startedAt, outcome: 'pending_or_unknown', phase: 'executing' };
  fs.writeFileSync(taskFile, `${JSON.stringify(old, null, 2)}\n`);
  const hub2 = await t.hub({ project, stateDir, logName: 'hub-2.log' });
  const loaded = await hub2.task(started.id);
  t.check(loaded && loaded.status === 'paused' && loaded.errorCode === 'process_interrupted', 'the old task file loads, as an interrupted task', JSON.stringify({ s: loaded?.status, c: loaded?.errorCode }));
  // The Hub adds its own note that the task was interrupted; what was written is untouched (loading adds no callId, input or checkpointId to it).
  const kept = loaded.events.slice(0, old.events.length);
  const firstDifference = kept.findIndex((event, index) => JSON.stringify(event) !== JSON.stringify(old.events[index]));
  t.check(kept.length === old.events.length && firstDifference === -1, 'with its events exactly as they were written', `first difference at ${firstDifference}: ${JSON.stringify(kept[firstDifference])?.slice(0, 200)} vs ${JSON.stringify(old.events[firstDifference])?.slice(0, 200)}`);
  t.equal(loaded.events.slice(old.events.length).map((event) => [event.type, 'callId' in event, 'input' in event, 'checkpointId' in event]), [['paused', false, false, false]], 'and the one event the load adds is the Hub\'s note that it was interrupted');
  t.equal([loaded.pendingCall?.callId, loaded.pendingCall?.toolName, 'checkpointId' in (loaded.pendingCall ?? {})], ['call_old', 'local.write_file', false], 'and the record of the call that was in flight, as it was');
  t.check((await hub2.get(`/api/studio/task-review?taskId=${started.id}`)).json.files.some((entry) => entry.path === 'out/b.txt'), 'its review still answers from the checkpoints on disk');
});
