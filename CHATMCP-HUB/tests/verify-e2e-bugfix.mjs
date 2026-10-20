// End-to-end scenario 2: fix a bug in an existing project and prove it with the project's own test.
//
// A real Hub (hub.mjs, local backend) and a scripted model that follows the loop every coding agent has to manage: read the
// file, make the smallest edit, run the test. The person is in Review mode. What the suite looks at is not what the model
// says but what is true afterwards: the file on disk, a test run made by this suite itself, the approvals that were asked, the
// checkpoint and the diff the person can review, and the restore that undoes the change only if the file is still as reviewed.
//
// The scripted model proves the Hub, its tools and its permission gate work together. It does not prove that any real model
// plans well (docs/TESTING-WITH-REAL-MODELS.md says how to try one).
// CLAIM: checkpoints
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runScenario, sha256 } from './e2e/harness.mjs';
import { answerApprovals, connectModel, setMode, startTask, waitForState } from './e2e/hub-process.mjs';
import { BUGGY_CALC, FIXED_CALC, WRONG_EXPECTATION_TEST, gitInit, git, makeCalcProject, read } from './e2e/fixtures.mjs';

const projectTest = (cwd) => {
  const result = spawnSync(process.execPath, ['test.js'], { cwd, encoding: 'utf8', windowsHide: true });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
};

await runScenario({
  name: 'bugfix',
  summary: 'Review mode approvals, edit + test evidence, checkpoint/diff/restore, a denied edit, Read Only, a failing test is not evidence',
}, async (t) => {
  const project = path.join(t.scratch, 'calc-app');
  makeCalcProject(project);
  gitInit(project, t.scratch);
  const mock = await t.mock({ scenario: 'repair-add' });
  const hub = await t.hub({ project });

  const model = await connectModel(hub, mock);
  t.check(model?.ok !== false && model?.toolCalling !== false, 'the scripted model passes the tool-calling check', JSON.stringify(model)?.slice(0, 200));
  await setMode(hub, 'review');
  t.equal((await hub.state()).studio.permissions.mode, 'review', 'Review mode is active');

  // ---- A. the person approves the edit and the test run ------------------------------------------------------------------
  const before = projectTest(project);
  t.check(before.code !== 0, 'the bug is real: the project test fails before the agent touches anything', `exit ${before.code}`);

  const started = await startTask(hub, 'Hàm add() trả về sai kết quả. Hãy sửa và chạy test để chứng minh.');
  const first = await answerApprovals(hub, started.id, () => true);
  const taskA = first.task;
  t.equal(first.answered.map((request) => request.toolName), ['local.edit_file', 'local.run_command'], 'Review mode asked exactly twice, for the edit and for the test run (reading was not asked)');
  t.check(first.answered[0]?.preview?.includes('return a + b;') && first.answered[0]?.summary?.includes('calc.js'), 'the edit approval showed what would be written', first.answered[0]?.summary);
  t.equal(taskA.state, 'completed', 'the task ends completed');
  t.equal(read(project, 'calc.js'), FIXED_CALC, 'calc.js on disk holds the fix');
  const after = projectTest(project);
  t.check(after.code === 0 && after.output.includes('add() ok'), 'the project test, run independently by this suite, passes', `exit ${after.code}`);
  t.equal(git(project, t.scratch, ['status', '--porcelain']).stdout, 'M calc.js', 'Git sees exactly one changed file');

  const fullA = await hub.task(taskA.id);
  t.equal(fullA.unverifiedCount, 0, 'no operation is left unverified');
  t.check(fullA.usage?.inputTokens > 0 && fullA.usage?.outputTokens > 0, 'token usage was recorded', JSON.stringify(fullA.usage));
  const order = fullA.events.filter((event) => event.type === 'tool_result').map((event) => event.toolName);
  t.equal(order, ['local.read_file', 'local.edit_file', 'local.run_command'], 'the transcript shows read, edit, then test, in that order');
  const report = await hub.get(`/api/tasks/${taskA.id}/report`);
  t.check(report.status === 200 && report.text.includes(taskA.id), 'the exported report is available');

  const workflowA = (await hub.get(`/api/studio/workflow?taskId=${taskA.id}`)).json;
  t.check(workflowA.editsObserved === 1 && workflowA.checksObserved === 1 && workflowA.verified === true, 'the workflow records one edit and one passing check as verification', JSON.stringify({ e: workflowA.editsObserved, c: workflowA.checksObserved, v: workflowA.verified }));

  // ---- B. review and undo ------------------------------------------------------------------------------------------------
  const checkpoints = (await hub.get('/api/studio/checkpoints')).json;
  const checkpoint = checkpoints.find((item) => /local\.edit_file/.test(item.label) && item.label.includes(taskA.id));
  t.must(Boolean(checkpoint), 'a checkpoint was taken before the edit', checkpoints.map((item) => item.label).join(' | '));
  const review = (await hub.get(`/api/studio/review?checkpointId=${checkpoint.id}`)).json;
  const change = review.changes.find((item) => item.path === 'calc.js');
  t.check(change?.status === 'modified' && /-\s+return a - b;/.test(change.diff) && /\+\s+return a \+ b;/.test(change.diff), 'the review shows the change as a diff of calc.js', change?.diff?.slice(0, 120));

  const staleRestore = await hub.request('POST', '/api/studio/restore', { checkpointId: checkpoint.id, file: 'calc.js', expectedSha: 'a'.repeat(64) });
  t.check(staleRestore.status === 409 && staleRestore.json?.code === 'stale_review', 'restoring against a revision the person did not review is refused', `${staleRestore.status} ${staleRestore.json?.code}`);
  t.equal(read(project, 'calc.js'), FIXED_CALC, 'the refused restore left the file alone');
  const restored = await hub.request('POST', '/api/studio/restore', { checkpointId: checkpoint.id, file: 'calc.js', expectedSha: sha256(fs.readFileSync(path.join(project, 'calc.js'))) });
  t.check(restored.status === 200 && restored.json?.ok === true, 'restoring the reviewed revision works', `${restored.status}`);
  t.equal(read(project, 'calc.js'), BUGGY_CALC, 'the file is back to what it was before the agent');
  t.check(projectTest(project).code !== 0, 'and the project test fails again, so the restore really changed behaviour');
  t.check(restored.json?.undoBackup && fs.existsSync(restored.json.undoBackup), 'the version that was replaced is kept as an undo backup');

  // ---- C. the person denies the edit -------------------------------------------------------------------------------------
  const denied = await startTask(hub, 'Sửa lại hàm add() giúp tôi.');
  const second = await answerApprovals(hub, denied.id, () => false);
  t.equal(second.answered.map((request) => `${request.toolName}:${request.approved}`), ['local.edit_file:false'], 'only the edit was asked, and it was refused');
  t.equal(read(project, 'calc.js'), BUGGY_CALC, 'a refused edit changes nothing on disk');
  t.check(/không được cho phép|chưa sửa/i.test(second.task.finalText ?? ''), 'the task says honestly that nothing was changed', second.task.finalText);
  const workflowC = (await hub.get(`/api/studio/workflow?taskId=${denied.id}`)).json;
  t.check(workflowC.editsObserved === 0 && workflowC.verified === false, 'the workflow records no edit and no verification', JSON.stringify({ e: workflowC.editsObserved, v: workflowC.verified }));

  // ---- D. Read Only: nothing that writes is even offered for approval ----------------------------------------------------
  await setMode(hub, 'readonly');
  const readOnly = await startTask(hub, 'Sửa add() nhé.');
  const third = await answerApprovals(hub, readOnly.id, () => true);
  t.equal(third.answered.length, 0, 'Read Only asks nothing: a write is refused outright, not offered');
  t.equal(read(project, 'calc.js'), BUGGY_CALC, 'Read Only leaves the file untouched');
  t.check(/không được cho phép|chưa sửa/i.test(third.task.finalText ?? ''), 'and the task reports that it could not edit', third.task.finalText);

  // ---- E. a failing check is not evidence --------------------------------------------------------------------------------
  const failing = path.join(t.scratch, 'calc-failing');
  makeCalcProject(failing, { test: WRONG_EXPECTATION_TEST });
  gitInit(failing, t.scratch);
  await hub.post('/api/workspace/select', { path: failing });
  await setMode(hub, 'review');
  const doomed = await startTask(hub, 'Sửa add() rồi chạy test.');
  const fourth = await answerApprovals(hub, doomed.id, () => true);
  t.equal(read(failing, 'calc.js'), FIXED_CALC, 'the edit was made (the model does not know the test is wrong)');
  t.check(projectTest(failing).code !== 0, 'while the project test still fails when this suite runs it');
  t.check(/thất bại/.test(fourth.task.finalText ?? ''), 'the task does not claim success', fourth.task.finalText);
  const workflowE = (await hub.get(`/api/studio/workflow?taskId=${doomed.id}`)).json;
  t.check(workflowE.editsObserved === 1 && workflowE.verified === false, 'the workflow counts the edit but does not count a failing run as verification', JSON.stringify({ e: workflowE.editsObserved, c: workflowE.checksObserved, v: workflowE.verified }));
  await waitForState(hub, doomed.id, ['completed', 'failed', 'uncertain']);
  t.check(mock.state.requests.every((request) => request.hasAuthorization === false), 'no credential was sent to the model server (it needs none)');
});
