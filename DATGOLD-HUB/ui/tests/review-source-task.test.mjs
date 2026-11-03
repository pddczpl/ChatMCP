import test from 'node:test';
import assert from 'node:assert/strict';
import { taskCheckpointSource } from '../src/lib/review-source-task.ts';

// The source of review that the tab uses: the files a conversation changed, read from the Hub's task-review, and the three things a person can do with them. The api is a recorder.

const TASK = '0b9a3f3e-1d5c-4c1a-9d40-6b8f2a7c1e55';
const sha = (letter) => letter.repeat(64);
const FILE = { path: 'src/a.js', status: 'modified', change: 'modified', baselineText: 'one\n', currentText: 'two\n', baselineSha: sha('a'), currentSha: sha('b'), partial: false, accepted: false, rejectable: false, baselineSource: 'checkpoint', checkpointId: 'cp1' };

function recorder(answers = {}) {
  const calls = [];
  const api = {
    async getTaskReview(taskId) { calls.push(['getTaskReview', taskId]); return answers.review ?? { taskId, checkpoints: { total: 2, targeted: 1, broad: 1 }, files: [FILE], truncated: false, omitted: { protected: 3 }, limitations: [{ code: 'git_unavailable', message: 'x' }] }; },
    async saveFile(file, content, expectedSha) { calls.push(['saveFile', file, content, expectedSha]); return answers.save ?? { ok: true, sha256: sha('c') }; },
    async acceptFile(checkpointId, file, expectedSha) { calls.push(['acceptFile', checkpointId, file, expectedSha]); return { ok: true }; },
    async rejectCreated(taskId, file, expectedSha) { calls.push(['rejectCreated', taskId, file, expectedSha]); return { ok: true }; },
  };
  return { api, calls };
}

test('it is the source of a conversation\'s checkpoints', () => {
  const { api } = recorder();
  assert.equal(taskCheckpointSource(TASK, api).kind, 'task-checkpoint');
});

test('loading asks the Hub for the review of that conversation and hands the answer on as it is', async () => {
  const { api, calls } = recorder();
  const snapshot = await taskCheckpointSource(TASK, api).load();
  assert.deepEqual(calls, [['getTaskReview', TASK]]);
  assert.deepEqual(snapshot, { taskId: TASK, checkpoints: { total: 2, targeted: 1, broad: 1 }, files: [FILE], truncated: false, omitted: { protected: 3 }, limitations: [{ code: 'git_unavailable', message: 'x' }] });
});

test('an answer with parts missing is filled in so that the tab never has to guess', async () => {
  const { api } = recorder({ review: { taskId: TASK } });
  const snapshot = await taskCheckpointSource(TASK, api).load();
  assert.deepEqual([snapshot.taskId, snapshot.checkpoints, snapshot.files, snapshot.truncated, snapshot.omitted, snapshot.limitations], [TASK, undefined, [], false, { protected: 0 }, []]);
  const { api: odd } = recorder({ review: { taskId: TASK, files: 'x', limitations: null, omitted: {}, truncated: 1 } });
  const filled = await taskCheckpointSource(TASK, odd).load();
  assert.deepEqual([filled.files, filled.limitations, filled.omitted, filled.truncated], [[], [], { protected: 0 }, true]);
});

test('saving writes the whole text of the file, guarded by the sha that was reviewed, and answers the sha now on disk', async () => {
  const { api, calls } = recorder();
  const answer = await taskCheckpointSource(TASK, api).saveText('src/a.js', 'one\n', sha('b'));
  assert.deepEqual(calls, [['saveFile', 'src/a.js', 'one\n', sha('b')]]);
  assert.deepEqual(answer, { sha256: sha('c') });
});

test('an answer to a save that names no sha gives an empty one, which carries no marks', async () => {
  const { api } = recorder({ save: { ok: true } });
  assert.deepEqual(await taskCheckpointSource(TASK, api).saveText('a.js', 'x', sha('b')), { sha256: '' });
});

test('an error of the Hub reaches the caller as it came, with its status and code', async () => {
  const { api } = recorder();
  const stale = Object.assign(new Error('x'), { status: 409, code: 'stale_revision' });
  api.saveFile = async () => { throw stale; };
  await assert.rejects(taskCheckpointSource(TASK, api).saveText('a.js', 'x', sha('b')), (error) => error === stale);
});

test('accepting asks the Hub to record that sha for that file in that checkpoint', async () => {
  const { api, calls } = recorder();
  await taskCheckpointSource(TASK, api).accept(FILE);
  assert.deepEqual(calls, [['acceptFile', 'cp1', 'src/a.js', sha('b')]]);
});

test('moving a new file away names the conversation, the file and the sha that was reviewed', async () => {
  const { api, calls } = recorder();
  await taskCheckpointSource(TASK, api).rejectCreated({ ...FILE, change: 'created' });
  assert.deepEqual(calls, [['rejectCreated', TASK, 'src/a.js', sha('b')]]);
});

test('accepting or moving a file that has no sha asks the Hub nothing', async () => {
  const { api, calls } = recorder();
  const source = taskCheckpointSource(TASK, api);
  await assert.rejects(source.accept({ ...FILE, currentSha: null }));
  await assert.rejects(source.accept({ ...FILE, checkpointId: '' }));
  await assert.rejects(source.rejectCreated({ ...FILE, currentSha: null }));
  assert.deepEqual(calls, []);
});

test('an answer that does not name its conversation is the review of the conversation that was asked for', async () => {
  const { api } = recorder({ review: { files: [] } });
  assert.equal((await taskCheckpointSource(TASK, api).load()).taskId, TASK);
});
