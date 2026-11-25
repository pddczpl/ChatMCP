// Hostile plan mode, part 1 of 4: the Hub process dies (P9 ac-12, docs/PLAN-MODE.md "Hostile scenarios"). A real Hub process, killed with SIGKILL (TerminateProcess
// on Windows: no handler runs, no file is flushed), and the next one on the same data folder. The evidence is the bytes of the workspace (every file, .git
// included), Git, the gate's permission history and pending requests, the marks of started programs and what the next Hub loaded; never the model's text.
//
//  A. killed while the plan approval is open: nothing executes on restart, the approval is gone, the task is paused and held read-only, its old request
//     and its old card answer nothing; a plan file that says "approved" lifts nothing; a continue is a plan-mode run again.
//  B. killed DURING the decision (the request half sent, sent and not answered, just answered, just recorded, a request for changes just answered), under a gate
//     in Autonomous: the state after restart is one of the documented ones and the next write is refused or asked, never run.
//  C. killed right after an approval, before the first write: the approval and its execution choice are there, nothing has run, the next run asks.
//  D. killed before the first model answer, and while a second chat waits for its worktree: both come back held.
//  E. resume: continue with planMode absent, true, false and garbage; the automatic resume; a transcript resume, a checkpoint resume and damaged journals; a new
//     plan on an approved task; a stop: the policy is kept in all of them.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { runScenario } from './e2e/harness.mjs';
import { connectModel, waitFor } from './e2e/hub-process.mjs';
import { call, calls, say } from './e2e/scenarios.mjs';
import {
  PLAN_TEXT, answer, childHistory, decide, differences, fingerprint, hashEveryFile, historyOf, hold, makeRepo, markers, pendingOf, permissions, planFile, planOf, processesNaming, resume, routed, sameProcess, scriptedModel,
  start, taskFiles, tryContinue, tryMode, tryStart, waitAsk, waitPlan, waitRest,
} from './e2e/plan-mode-rig.mjs';

const ATTACK = (name, marks) => calls(['write_file', { path: `${name}.txt`, content: 'x' }], ['edit_file', { path: 'src/app.js', old_string: '42', new_string: '43' }], ['run_command', { command: marks.command(name), description: 'x' }], ['delete_path', { path: 'README.md' }]);
const ATTACK_ROWS = ['local.write_file', 'local.edit_file', 'local.run_command', 'local.delete_path'].map((toolName) => [toolName, 'policy']);

await runScenario({
  name: 'plan-mode-hub',
  summary: 'kill -9 around the plan approval, the documented state after every restart, and the policy kept by every way to resume',
  budgetMs: 170_000,
}, async (t) => {
  const marks = markers(t.scratch);
  const project = makeRepo(t.scratch, 'project');
  const stateDir = path.join(t.scratch, 'state');
  const model = scriptedModel();
  const mock = await t.mock({ scenario: 'script', scenarios: { script: model.scenario } });
  const processes = [];
  let generation = 0;
  let hub = null;
  async function boot() {
    generation += 1;
    hub = await t.hub({ project, stateDir, logName: `hub-${generation}.log` });
    t.must(hub.port !== 3007, `Hub ${generation} is not the owner's port`);
    return hub;
  }
  await boot();
  processes.push(...await processesNaming(path.basename(t.scratch)));
  await connectModel(hub, mock);
  let before = fingerprint(project, t.scratch);
  const unchanged = (label) => { t.equal(differences(before, fingerprint(project, t.scratch)), [], `${label}: every file and Git are as they were`); t.equal(marks.seen(), [], `${label}: no program was started`); };
  const rows = async (id) => (await historyOf(hub, id)).map((row) => [row.toolName, row.decision]);
  /** What the next Hub says about a task: its state, and whether it is held. */
  const held = async (id) => { const task = await hub.task(id); return { state: task.state, errorCode: task.errorCode, planMode: task.planMode, planApproval: task.planApproval, planOnly: task.planOnly }; };
  const HELD = { state: 'paused', errorCode: 'process_interrupted', planMode: true, planApproval: null, planOnly: true };
  /** A run of a held task in which the model tries to write, command and delete: every call is refused by the policy and nothing is asked. */
  async function attackRefused(id, name, label, body = {}) {
    const known = (await permissions(hub)).recent.length;
    model.script(name, [ATTACK(name, marks), say('Tried.')]);
    await resume(hub, id, `[[${name}]] Go on.`, body);
    const rest = await waitRest(hub, id);
    t.equal((await permissions(hub)).recent.slice(known).filter((row) => row.taskId === id).map((row) => [row.toolName, row.decision]), ATTACK_ROWS, `${label}: the write, the edit, the command and the deletion are refused by the plan policy, unasked`);
    t.equal([rest.planOnly, await pendingOf(hub, id)], [true, []], `${label}: the task is still held and nothing waits`);
    t.equal(model.asked(name)[0].tools.includes('exit_plan_mode'), true, `${label}: the run is a plan-mode run (it is offered exit_plan_mode)`);
    unchanged(label);
    return rest;
  }

  // ---------------------------------------------------------------------------------------------------------------- A. the approval is open
  t.equal((await tryMode(hub, { mode: 'full-access', confirmation: 'FULL ACCESS' })).status, 200, 'the gate is in Full Access, the widest setting there is');
  model.script('a', [call('exit_plan_mode', { plan: PLAN_TEXT }), ATTACK('a', marks)]);
  const a = await start(hub, '[[a]] Plan it.', { planMode: true });
  const cardA = await waitPlan(hub, a.id);
  t.equal((await hub.task(a.id)).state, 'waiting_approval', 'A: the task waits for the plan');
  const requestsBefore = mock.state.requests.length;
  await hub.kill();
  // As if the Hub had died between recording the approval in the plan file and in the task: the plan file alone says "approved".
  const planPath = planFile(hub, a.id);
  const planned = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  fs.writeFileSync(planPath, JSON.stringify({ ...planned, approvedAt: new Date().toISOString(), approvedRevision: planned.revision }, null, 2));
  await boot();
  t.equal(await held(a.id), HELD, 'A: after the restart the task is paused, in plan mode, with no approval, and held (a plan file that says approved lifts nothing)');
  t.equal([await pendingOf(hub, a.id), (await permissions(hub)).fullAccess], [[], true], 'A: the approval is gone, and Full Access, which outlived the restart, changes nothing');
  t.equal((await hub.task(a.id)).autoResume ?? false, false, 'A: nothing resumes it by itself');
  t.equal(mock.state.requests.length, requestsBefore, 'A: the model was not asked again');
  t.equal(await rows(a.id), [], 'A: the permission history has no row about the request that was lost: nobody answered it');
  t.equal([(await decide(hub, { taskId: a.id, revision: cardA.detail.revision, decision: 'approve' })).status, (await answer(hub, { id: cardA.id, approved: true })).status], [404, 404], 'A: the card of the dead Hub answers nothing (404)');
  t.equal((await planOf(hub, a.id)).revision, cardA.detail.revision, 'A: the plan itself is there');
  unchanged('A');
  await attackRefused(a.id, 'a2', 'A, continued');
  // ---- and a plan approved now is approved: the hold is a hold, not a dead end
  model.script('a3', [call('exit_plan_mode', { plan: `${PLAN_TEXT}\n4. Again.` }), call('write_file', { path: 'approved-a.txt', content: 'ok' })]);
  await resume(hub, a.id, '[[a3]] Propose it again.');
  const cardA3 = await waitPlan(hub, a.id);
  t.check(cardA3.id !== cardA.id && cardA3.detail.revision > cardA.detail.revision, 'A: the new proposal is a new request about a later revision');
  t.equal((await decide(hub, { taskId: a.id, revision: cardA.detail.revision, decision: 'approve' })).status, 409, 'A: the revision the dead Hub showed is refused');
  t.equal((await decide(hub, { taskId: a.id, revision: cardA3.detail.revision, decision: 'approve', execution: 'review' })).status, 200, 'A: the owner approves the current one, for Review');
  const askA = await waitAsk(hub, a.id);
  t.equal(askA.toolName, 'local.write_file', 'A: after the approval the write is asked, under a gate in Full Access');
  unchanged('A, approved for Review');
  await answer(hub, { id: askA.id, approved: false });
  await waitRest(hub, a.id);

  // ---------------------------------------------------------------------------------------------------------------- B. the decision is under way
  t.equal((await tryMode(hub, { mode: 'autonomous', leaveFullAccess: true })).status, 200, 'the gate is in Autonomous: a write of a task nobody holds would run unasked');
  /** A plan waits; `act` is done with the Hub and its decision, and then the Hub is killed. */
  async function killAround(name, act) {
    model.script(name, [call('exit_plan_mode', { plan: `${PLAN_TEXT}\n# ${name}` }), ATTACK(name, marks)]);
    const task = await start(hub, `[[${name}]] Plan it.`, { planMode: true });
    const card = await waitPlan(hub, task.id);
    const body = { taskId: task.id, revision: card.detail.revision, decision: 'approve', execution: 'review' };
    await act(task, body);
    await hub.kill();
    await boot();
    return task.id;
  }
  /** Writes `text` of a request of the page to the Hub's socket; resolves once the operating system has taken it. */
  async function sendRaw(route, body, { half = false } = {}) {
    const text = JSON.stringify(body);
    const headers = { ...hub.authHeaders, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), origin: hub.origin, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': await hub.csrfToken() };
    if (half) {
      const socket = net.connect(hub.port, '127.0.0.1');
      socket.on('error', () => {});
      const head = `POST ${route} HTTP/1.1\r\nhost: 127.0.0.1:${hub.port}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`;
      await new Promise((resolve) => { socket.write(head + text.slice(0, Math.floor(text.length / 2)), resolve); });
      t.own(() => socket.destroy());
      return;
    }
    await new Promise((resolve) => {
      const request = http.request({ host: '127.0.0.1', port: hub.port, method: 'POST', path: route, headers });
      request.on('error', () => resolve());
      request.end(text, resolve);
    });
  }
  const DOCUMENTED = ['null', 'approved'];
  /** Held with no approval, or approved for Review: nothing has run either way, and the next run of the attack is refused or asked, never carried out. */
  async function documented(id, name, label, allowed = DOCUMENTED) {
    const task = await hub.task(id);
    const status = task.planApproval?.status ?? 'null';
    t.check(task.state === 'paused' && task.errorCode === 'process_interrupted' && allowed.includes(status), `${label}: paused after the restart, its approval is one of: ${allowed.join(', ')}`, JSON.stringify({ state: task.state, approval: task.planApproval }));
    t.equal(task.planOnly, status !== 'approved', `${label}: held exactly when no approval is recorded`);
    t.equal(await pendingOf(hub, id), [], `${label}: nothing waits`);
    unchanged(label);
    if (status !== 'approved') { await attackRefused(id, `${name}-again`, `${label}, continued`); return status; }
    t.equal([task.planApproval.execution, task.planApproval.editedByUser], ['review', false], `${label}: the recorded approval carries the choice that was sent`);
    model.script(`${name}-again`, [call('write_file', { path: `${name}.txt`, content: 'x' }), say('Asked.')]);
    await resume(hub, id, `[[${name}-again]] Go on.`);
    const asked = await waitAsk(hub, id);
    t.equal(asked.toolName, 'local.write_file', `${label}, continued: Review was chosen, so the write is asked although the gate is in Autonomous`);
    await answer(hub, { id: asked.id, approved: false });
    await waitRest(hub, id);
    unchanged(`${label}, continued`);
    return status;
  }
  const half = await killAround('b-half', async (task, body) => {
    await sendRaw('/api/studio/plan/decide', body, { half: true });
    t.equal((await pendingOf(hub, task.id)).length, 1, 'B, half of the decision sent: the request still waits');
  });
  await documented(half, 'b-half', 'B, half of the decision sent', ['null']);
  const unanswered = await killAround('b-sent', (task, body) => sendRaw('/api/studio/plan/decide', body));
  t.note(`B, sent and not answered: the restart found "${await documented(unanswered, 'b-sent', 'B, the decision sent and not answered')}"`);
  const answered = await killAround('b-answered', async (task, body) => { const response = await decide(hub, body); t.equal(response.status, 200, 'B: the decision was answered'); });
  t.note(`B, just answered: the restart found "${await documented(answered, 'b-answered', 'B, the decision just answered')}"`);
  const denied = await killAround('b-denied', async (task, body) => { const response = await decide(hub, { taskId: body.taskId, revision: body.revision, decision: 'request_changes', feedback: 'Not like this.' }); t.equal(response.status, 200, 'B: changes were requested'); });
  await documented(denied, 'b-denied', 'B, changes just requested', ['null', 'denied']);

  // ---------------------------------------------------------------------------------------------------------------- C. approved, before the first write
  const forever = hold();
  model.script('c', [call('exit_plan_mode', { plan: PLAN_TEXT }), () => forever.promise]);
  const c = await start(hub, '[[c]] Plan it.', { planMode: true });
  const cardC = await waitPlan(hub, c.id);
  t.equal((await decide(hub, { taskId: c.id, revision: cardC.detail.revision, decision: 'approve', execution: 'review' })).status, 200, 'C: approved for Review under a gate in Autonomous');
  await waitFor(() => model.requests('c') === 2, { timeoutMs: 20_000, intervalMs: 25, label: 'the model to be asked after the approval' });
  // beside it, a chat in a worktree of its own whose plan waits when the Hub dies
  model.script('c2', [call('exit_plan_mode', { plan: 'Plan of the chat beside.' })]);
  const beside = await start(hub, '[[c2]] Plan beside it.', { planMode: true });
  const cardBeside = await waitPlan(hub, beside.id);
  const { worktree } = await hub.task(beside.id);
  const worktreeBefore = hashEveryFile(worktree);
  const withWorktree = fingerprint(project, t.scratch);
  t.equal(differences(before, withWorktree).filter((line) => !/^(?:created|changed) \.git\/(?:worktrees|refs\/heads\/chatmcp|logs\/refs\/heads\/chatmcp|refs\/heads\/|logs\/refs\/heads\/)|^git refs: /.test(line)), [], 'C: the Hub made a worktree and a branch for it, and nothing else in the project');
  before = withWorktree;
  await hub.kill();
  forever.release(say('Too late.'));
  await boot();
  t.equal([await held(beside.id), await pendingOf(hub, beside.id)], [HELD, []], 'C: the chat beside it is paused, held and its request gone');
  t.equal([(await decide(hub, { taskId: beside.id, revision: cardBeside.detail.revision, decision: 'approve' })).status, (await tryContinue(hub, beside.id, 'Go.', { planMode: false })).json?.code], [404, 'plan_mode_pending'], 'C: its old card answers nothing, and planMode false does not take it out');
  model.script('c2-again', [routed(ATTACK('c2', marks)), say('Tried.')]);
  await resume(hub, beside.id, '[[c2-again]] Go on.');
  await waitRest(hub, beside.id);
  await waitFor(() => { try { return childHistory(hub, beside.id)?.length >= 4; } catch { return false; } }, { timeoutMs: 10_000, intervalMs: 50, label: 'the history of its gate to be written' });
  t.equal(childHistory(hub, beside.id), ATTACK_ROWS, 'C: continued, it is refused on the gate the new Hub made for it');
  t.equal([JSON.stringify([...hashEveryFile(worktree)]) === JSON.stringify([...worktreeBefore]), marks.seen()], [true, []], 'C: nothing changed in its worktree, and no program was started');
  t.equal(await documented(c.id, 'c', 'C, approved and not begun', ['approved']), 'approved', 'C: an approval the model was told of is never lost');
  t.equal((await planOf(hub, c.id)).approvedRevision, cardC.detail.revision, 'C: and the plan file names the approved revision');

  // ---------------------------------------------------------------------------------------------------------------- D. before the first answer; a second chat that waits for its worktree
  t.equal((await tryMode(hub, { mode: 'review' })).status, 200, 'the gate is in Review');
  const early = hold();
  model.script('d', [() => early.promise]);
  const d = await start(hub, '[[d]] Plan it.', { planMode: true });
  await waitFor(() => model.requests('d') === 1, { timeoutMs: 20_000, intervalMs: 25, label: 'the first model request' });
  model.script('d2', [ATTACK('d2', marks), say('Tried.')]);
  const second = await start(hub, '[[d2]] Plan beside it.', { planMode: true });
  const worktreeAsk = await waitAsk(hub, second.id);
  t.equal([worktreeAsk.toolName, (await hub.task(second.id)).planOnly], ['local.worktrees_create', true], 'D: a second chat in plan mode waits for its worktree, held');
  await hub.kill();
  early.release(say('Too late.'));
  await boot();
  t.equal(await held(d.id), HELD, 'D: killed before the first answer of the model: paused and held');
  const secondAfter = await hub.task(second.id);
  t.equal([secondAfter.state, secondAfter.planMode, secondAfter.planOnly, secondAfter.planApproval], ['paused', true, true, null], 'D: the chat that never ran is paused and still in plan mode');
  t.equal([(await tryContinue(hub, second.id, '[[d2]] Go.', { planMode: false })).json?.code, (await hub.task(second.id)).planOnly], ['plan_mode_pending', true], 'D: planMode false does not take it out');
  unchanged('D');

  // ---------------------------------------------------------------------------------------------------------------- E. every way to resume
  // what a follow-up may say
  for (const [value, code, status] of [[false, 'plan_mode_pending', 409], ['true', 'invalid_plan_mode', 400], ['false', 'invalid_plan_mode', 400], [1, 'invalid_plan_mode', 400], [0, 'invalid_plan_mode', 400], [{}, 'invalid_plan_mode', 400], [[], 'invalid_plan_mode', 400], ['', 'invalid_plan_mode', 400]]) {
    const response = await tryContinue(hub, d.id, 'Leave plan mode.', { planMode: value });
    t.equal([response.status, response.json?.code], [status, code], `E: a follow-up with planMode ${JSON.stringify(value)} is ${status} ${code}`);
    const fresh = await tryStart(hub, 'New.', { planMode: value === false ? 'no' : value });
    t.equal([fresh.status, fresh.json?.code], [400, 'invalid_plan_mode'], `E: a start with planMode ${JSON.stringify(value === false ? 'no' : value)} is refused`);
  }
  t.equal(await held(d.id), HELD, 'E: none of them touched the task');
  for (const id of [d.id.toUpperCase(), ` ${d.id}`, `${d.id}/`, '__proto__']) t.equal((await tryContinue(hub, id, 'Go.', { planMode: false })).status, 404, `E: ${JSON.stringify(id).slice(0, 24)} is no conversation`);
  // a run that goes on outside plan mode takes no planMode: true; the Browser Companion takes no plan mode at all, and not a held chat
  const busy = hold();
  model.script('e-busy', [() => busy.promise]);
  const running = await start(hub, '[[e-busy]] Work.');
  const entering = await tryContinue(hub, running.id, 'Plan instead.', { planMode: true });
  t.equal([entering.status, entering.json?.code], [409, 'plan_mode_running'], 'E: a run outside plan mode cannot be put into it by a message');
  busy.release(say('Done.'));
  await waitRest(hub, running.id);
  await hub.post('/api/agent/mode', { mode: 'chatgpt-web' });
  const web = [await tryContinue(hub, d.id, 'Go on there.'), await tryContinue(hub, d.id, 'Go on there.', { planMode: false }), await tryStart(hub, 'Plan there.', { planMode: true })];
  t.equal(web.map((response) => [response.status, response.json?.code]), Array(3).fill([400, 'plan_mode_unsupported']), 'E: the Browser Companion takes neither a held chat nor a plan-mode start');
  await hub.post('/api/agent/mode', { mode: 'api' });
  t.equal(await held(d.id), HELD, 'E: and the task is as it was');
  // the owner's other fields do not lift it either: a field the Hub does not know is nothing
  await attackRefused(d.id, 'e-null', 'E, continued with planMode null and made-up fields', { planMode: null, planOnly: false, planApproval: { status: 'approved', revision: 1, execution: 'autonomous' }, taskPolicy: { mode: 'autonomous' }, execution: 'autonomous', approved: true });
  await attackRefused(d.id, 'e-true', 'E, continued with planMode true', { planMode: true });
  t.equal((await hub.task(d.id)).resumeMode, 'transcript', 'E: the runs above resumed from the transcript');

  // a stop while the plan waits
  model.script('e-stop', [call('exit_plan_mode', { plan: PLAN_TEXT })]);
  await resume(hub, d.id, '[[e-stop]] Propose.');
  const cardStop = await waitPlan(hub, d.id);
  await hub.post('/api/tasks/cancel', { id: d.id });
  await waitRest(hub, d.id);
  t.equal([(await decide(hub, { taskId: d.id, revision: cardStop.detail.revision, decision: 'approve' })).status, (await answer(hub, { id: cardStop.id, approved: true })).status, (await hub.task(d.id)).planOnly], [404, 404, true], 'E: a stop takes the request away (404) and the task stays held');
  t.equal((await rows(d.id)).at(-1), ['chatmcp.exit_plan_mode', 'cancelled'], 'E: the history says the request was cancelled');

  // the automatic resume, and a journal that is damaged while no Hub runs
  t.equal((await tryMode(hub, { mode: 'autonomous' })).status, 200, 'the gate is in Autonomous');
  model.script('e-auto', [call('exit_plan_mode', { plan: PLAN_TEXT }), ATTACK('e-auto', marks), say('Tried.')]);
  const auto = await start(hub, '[[e-auto]] Plan it.', { planMode: true });
  await waitPlan(hub, auto.id);
  await hub.post('/api/tasks/auto-resume', { id: auto.id, enabled: true });
  await hub.kill();
  // D's journal: a line in the middle is cut in half, which the loader must not read past.
  const files = taskFiles(hub, d.id);
  const lines = fs.readFileSync(files.transcript, 'utf8').split('\n');
  const middle = lines.findIndex((line, index) => index > lines.length / 3 && line.includes('"type":"history"'));
  lines[middle] = lines[middle].slice(0, Math.floor(lines[middle].length / 2));
  fs.writeFileSync(files.transcript, lines.join('\n'));
  await boot();
  t.equal((await hub.task(auto.id)).planOnly, true, 'E: the task to resume is held before anything resumes it');
  await waitFor(async () => model.requests('e-auto') >= 2, { timeoutMs: 40_000, intervalMs: 100, label: 'the Hub to resume the task by itself' });
  await waitRest(hub, auto.id);
  t.equal([await rows(auto.id), (await hub.task(auto.id)).planOnly, (await hub.task(auto.id)).autoResume], [ATTACK_ROWS, true, false], 'E: the automatic resume is a plan-mode run: what the model tries under a gate in Autonomous is refused, and the switch is used up');
  t.equal(model.asked('e-auto')[1].tools.includes('exit_plan_mode'), true, 'E: it is offered exit_plan_mode');
  unchanged('E, resumed by the Hub');
  await attackRefused(d.id, 'e-damaged', 'E, a damaged journal');
  t.equal((await hub.task(d.id)).resumeMode, 'checkpoint', 'E: that run resumed from the checkpoint, and the policy held');

  // a new plan on an approved task, and a Hub that restarts in between
  t.equal((await hub.task(c.id)).planApproval?.status, 'approved', 'E: the task of C is approved');
  model.script('e-new', [call('write_file', { path: 'e-new.txt', content: 'x' }), call('exit_plan_mode', { plan: 'A second plan.' }), say('No.')]);
  await resume(hub, c.id, '[[e-new]] Plan the next part.', { planMode: true });
  const cardNew = await waitPlan(hub, c.id);
  t.equal([(await rows(c.id)).at(-1), (await hub.task(c.id)).planApproval, (await hub.task(c.id)).planOnly], [['local.write_file', 'policy'], null, true], 'E: planMode true on an approved task starts over: the old approval and its choice are gone and a write is refused');
  t.equal((await answer(hub, { id: cardNew.id, approved: false, feedback: 'Later.' })).status, 200, 'E: the new plan is denied');
  await waitRest(hub, c.id);
  // D's journal is taken away altogether; C's task file is cut short (a task the Hub cannot read is a task it does not run).
  await hub.kill();
  fs.rmSync(files.transcript);
  const broken = taskFiles(hub, half);
  const brokenText = fs.readFileSync(broken.json, 'utf8');
  fs.writeFileSync(broken.json, brokenText.slice(0, Math.floor(brokenText.length / 2)));
  await boot();
  t.equal([(await hub.task(c.id)).planApproval?.status, (await hub.task(c.id)).planOnly], ['denied', true], 'E: after a restart the second plan is denied and the task held, the first approval is not back');
  await attackRefused(c.id, 'e-after', 'E, a denied second plan, after a restart');
  await attackRefused(d.id, 'e-gone', 'E, no journal at all');
  t.equal([(await hub.get(`/api/tasks/${half}`)).status, (await tryContinue(hub, half, 'Go.')).status], [404, 404], 'E: a task whose file is cut short is not loaded, and cannot be continued');
  t.equal((await planOf(hub, a.id)).approvedRevision, cardA3.detail.revision, 'E: the plan of A kept the revision the owner approved');

  // ---------------------------------------------------------------------------------------------------------------- nothing is left running
  processes.push(...await processesNaming(path.basename(t.scratch)));
  await hub.stop();
  const left = await waitFor(async () => { const rest = await processesNaming(path.basename(t.scratch)); return rest.length === 0 ? [] : null; }, { timeoutMs: 20_000, intervalMs: 400, label: 'every process of this suite to end' });
  t.equal(left.filter((row) => processes.some((other) => sameProcess(row, other))), [], `every process of the ${generation} Hubs has ended (by pid and creation time)`);
});
