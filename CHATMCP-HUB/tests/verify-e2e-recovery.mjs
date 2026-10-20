// End-to-end scenario 4: the Hub is killed in the middle of a task, and what the next start does about it.
//
// The Hub is killed with SIGKILL (TerminateProcess on Windows): no handler runs and no file is flushed, as in a crash or a
// power cut. The next Hub starts on the same state folder. Two situations, because they must end differently:
//
//   A. The kill comes while a shell command is RUNNING. Nobody knows whether it finished or what it changed, so the task is
//      "uncertain", it is not resumed by itself even though the person switched auto-resume on, the command is NOT run again,
//      and when the person chooses to continue, the model is told that the operation is unverified and not to replay it.
//   B. The kill comes while an edit is WAITING FOR APPROVAL. The edit never started, so the task is only "paused", and with
//      auto-resume on the Hub picks it up once, with a prompt that tells the model to look at the real state of the files,
//      consumes the switch, and never executes the edit that was waiting.
//
// The command that is "running" is a script that appends a line to runs.txt when it starts and then lingers for a while, so
// the number of lines in runs.txt says how many times the Hub started it, whatever anybody claims.
// CLAIM: no-replay-after-kill
import fs from 'node:fs';
import path from 'node:path';
import { eventually, runScenario } from './e2e/harness.mjs';
import { continueTask, connectModel, pendingApprovals, setMode, sleep, startTask, taskSummary, waitForState } from './e2e/hub-process.mjs';
import { BUGGY_CALC, exists, makeCalcProject, read } from './e2e/fixtures.mjs';
import { call, say, sequence, shaOf, toolText } from './e2e/scenarios.mjs';

const AUTO_PROMPT_START = 'Hub đã khởi động lại sau gián đoạn';
const SLOW_SCRIPT = "require('node:fs').appendFileSync('runs.txt', 'start\\n');\nsetTimeout(() => {}, 25000);\n";

/** Anything the crashed Hub left running must not outlive the test (a command it started is not a child it can clean up). */
function reapOrphans(hub) {
  if (process.platform === 'win32') return;
  try { process.kill(-hub.pid, 'SIGKILL'); } catch { /* nothing left */ }
}

await runScenario({
  name: 'recovery',
  summary: 'kill -9 during a running command (uncertain, never replayed, not auto-resumed) and during an approval (paused, resumed once, edit never run)',
  budgetMs: 150_000,
}, async (t) => {
  const project = path.join(t.scratch, 'proj');
  makeCalcProject(project);
  fs.writeFileSync(path.join(project, 'slow.js'), SLOW_SCRIPT);
  const stateDir = path.join(t.scratch, 'state');
  const runs = () => (exists(project, 'runs.txt') ? read(project, 'runs.txt').split('\n').filter(Boolean) : []);

  const askedAfterRestart = [];
  const mock = await t.mock({
    scenario: 'slow',
    scenarios: {
      slow: sequence([call('run_command', { command: 'node slow.js', timeout_seconds: 60, description: 'Chạy tác vụ chậm' })], { final: 'slow.js đã chạy xong.' }),
      // After the crash: look at the real state, then report honestly.
      'after-crash': (ctx) => {
        if (ctx.turn === 0) { askedAfterRestart.push(ctx.users.join('\n---\n')); return call('read_file', { path: 'runs.txt' }); }
        const starts = (toolText(ctx.last).match(/start/g) ?? []).length;
        return say(`runs.txt có ${starts} dòng "start". Tôi không biết slow.js đã chạy xong chưa nên KHÔNG chạy lại nó.`);
      },
      'edit-only': sequence([
        call('read_file', { path: 'calc.js' }),
        (ctx) => call('edit_file', { path: 'calc.js', old_string: 'return a - b;', new_string: 'return a + b;', expected_sha256: shaOf(ctx.last) }),
      ], { final: 'Đã sửa calc.js.' }),
      'after-restart-read': (ctx) => {
        if (ctx.turn === 0) { askedAfterRestart.push(ctx.users.join('\n---\n')); return call('read_file', { path: 'calc.js' }); }
        return say('Tôi đã đọc lại calc.js: nó vẫn như cũ, thao tác sửa trước đó chưa từng được chạy. Chưa sửa gì.');
      },
    },
  });

  // ---- A. killed while a command is running -------------------------------------------------------------------------------
  const hub1 = await t.hub({ project, stateDir, logName: 'hub-1.log' });
  await connectModel(hub1, mock);
  await setMode(hub1, 'review');
  const started = await startTask(hub1, 'Chạy slow.js để xem nó mất bao lâu.');
  const request = await eventually(async () => (await pendingApprovals(hub1)).find((item) => item.taskId === started.id), { label: 'the approval for node slow.js' });
  await hub1.post('/api/studio/permissions/decide', { id: request.id, approved: true });
  await eventually(() => runs().length === 1, { timeoutMs: 15_000, label: 'slow.js to start' });
  await hub1.post('/api/tasks/auto-resume', { id: started.id, enabled: true });
  const running = await hub1.task(started.id);
  t.check(['running', 'verifying'].includes(running.state) && running.pendingCall?.phase === 'executing' && running.pendingCall?.toolName === 'local.run_command', 'before the crash: the task is running and records that the command is executing', JSON.stringify({ s: running.state, p: running.pendingCall }));
  t.equal(running.autoResume, true, 'before the crash: auto-resume is on');

  await hub1.kill();
  reapOrphans(hub1);
  t.check(hub1.exitInfo?.signal === 'SIGKILL' || process.platform === 'win32', 'the Hub was killed without any chance to clean up', JSON.stringify(hub1.exitInfo));
  t.equal(runs().length, 1, 'slow.js had been started exactly once');

  mock.setScenario('after-crash');
  const hub2 = await t.hub({ project, stateDir, logName: 'hub-2.log' });
  const found = await hub2.task(started.id);
  t.equal([found.status, found.errorCode], ['paused', 'process_interrupted'], 'after the restart the task is there, paused, with the reason process_interrupted');
  t.equal(found.state, 'uncertain', 'and its state is "uncertain": a command was running and nobody knows what it did');
  t.check(found.unverifiedCount >= 1 || (found.unverifiedOperations ?? []).length >= 1 || Boolean(found.pendingCall), 'the unverified command is recorded, not forgotten', JSON.stringify({ n: found.unverifiedCount, u: found.unverifiedOperations, p: found.pendingCall }));
  t.equal(found.autoResume, true, 'auto-resume is still on (nothing has consumed it)');

  // The scheduler looks every 12 seconds. Wait through two looks: it must not touch an uncertain task.
  await sleep(26_000);
  t.equal(mock.state.requests.length, 0, 'the Hub did not resume the uncertain task by itself: the model server received no request');
  t.equal(runs().length, 1, 'the command was not run again');
  const waiting = await taskSummary(hub2, started.id);
  t.check(waiting?.state === 'uncertain' && waiting?.autoResume === true, 'the task is still uncertain, still waiting for the person', JSON.stringify({ s: waiting?.state, a: waiting?.autoResume }));

  // The person decides to go on. The Hub tells the model what is and is not known; the model checks the real state.
  const resumed = await continueTask(hub2, started.id, 'Tiếp tục từ chỗ bị gián đoạn.');
  const done = await waitForState(hub2, started.id, ['completed', 'failed', 'uncertain', 'paused'], { timeoutMs: 40_000 });
  t.equal(resumed.id, started.id, 'continuing keeps the same conversation (same task id)');
  t.equal(done.state, 'completed', 'the continued task completes');
  t.check(/Do NOT replay/i.test(askedAfterRestart[0] ?? '') && /slow\.js/.test(askedAfterRestart[0] ?? ''), 'the model was told the earlier operation is unverified, named it, and told not to replay it', (askedAfterRestart[0] ?? '').slice(0, 200));
  t.equal(runs().length, 1, 'still only one start of slow.js: nothing replayed it');
  t.check(/KHÔNG chạy lại/.test(done.finalText ?? ''), 'the final answer reports the real state of runs.txt and says it did not run the command again', done.finalText);

  // ---- B. killed while an edit waits for approval -------------------------------------------------------------------------
  mock.setScenario('edit-only');
  const second = await startTask(hub2, 'Sửa add() trong calc.js.');
  const waitingEdit = await eventually(async () => (await pendingApprovals(hub2)).find((item) => item.taskId === second.id), { label: 'the approval for the edit' });
  t.equal(waitingEdit.toolName, 'local.edit_file', 'the edit is waiting for the person');
  await hub2.post('/api/tasks/auto-resume', { id: second.id, enabled: true });
  await hub2.kill();
  reapOrphans(hub2);
  t.equal(read(project, 'calc.js'), BUGGY_CALC, 'the edit that was waiting has not been made');

  mock.setScenario('after-restart-read');
  askedAfterRestart.length = 0;
  const hub3 = await t.hub({ project, stateDir, logName: 'hub-3.log' });
  const paused = await hub3.task(second.id);
  t.equal([paused.status, paused.state, paused.errorCode], ['paused', 'paused', 'process_interrupted'], 'after the restart the task is paused (not uncertain): the edit never started');
  t.check(!paused.pendingCall && paused.unverifiedCount === 0, 'nothing is left unverified', JSON.stringify({ p: paused.pendingCall, n: paused.unverifiedCount }));
  t.equal(paused.autoResume, true, 'auto-resume is on');
  t.equal((await pendingApprovals(hub3)).length, 0, 'the approval that was waiting is gone: nobody can approve it by accident');

  const finished = await eventually(async () => {
    const summary = await taskSummary(hub3, second.id);
    return summary && summary.state === 'completed' ? summary : null;
  }, { timeoutMs: 45_000, intervalMs: 500, label: 'the Hub to resume the paused task by itself' });
  t.equal(finished.state, 'completed', 'with auto-resume on, the Hub resumed the paused task by itself and it completed');
  const automatic = mock.state.requests.filter((item) => item.turn === 0 && item.promptStart.startsWith(AUTO_PROMPT_START));
  t.equal(automatic.length, 1, 'it did so exactly once, with the standard "check the real state first" prompt');
  t.check(/không replay|không lặp lại|kiểm tra/i.test(askedAfterRestart[0] ?? ''), 'and that prompt tells the model to re-check files and not to repeat earlier operations', (askedAfterRestart[0] ?? '').slice(0, 300));
  t.equal((await hub3.task(second.id)).autoResume, false, 'the auto-resume switch was consumed');
  t.equal(read(project, 'calc.js'), BUGGY_CALC, 'the edit that was waiting when the Hub died was never executed');
  const events = (await hub3.task(second.id)).events.map((event) => `${event.type}:${event.toolName ?? ''}`);
  t.check(!events.includes('tool_result:local.edit_file'), 'the transcript has no result for the edit');

  await sleep(14_000);
  t.equal(mock.state.requests.filter((item) => item.turn === 0 && item.promptStart.startsWith(AUTO_PROMPT_START)).length, 1, 'a later look of the scheduler did not resume it a second time');
  t.equal(runs().length, 1, 'and slow.js still ran exactly once in the whole test');
});
