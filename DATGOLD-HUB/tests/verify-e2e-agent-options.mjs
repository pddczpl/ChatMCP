// End-to-end scenario: the owner's agent options, through a real Hub process and a scripted model server.
//
// Settings can show the two options and change them (POST /api/agent/options): the percent of its budget from which the history is compacted (50 to 95, 80 when none is chosen) and whether the
// Hub itself matches the checks it ran (off unless the owner turns it on). This suite looks at the Hub the page talks to: the route is behind the same layers as the others (bearer, Origin, marker,
// CSRF) and takes nothing but the two options, checked as a whole; a choice is kept in the Hub's data folder and found again after a restart; a task started afterwards records what applied;
// the choice of a task that is going does not rewrite it; a file the Hub cannot read does not stop it and the owner can choose again. That the compaction itself starts at the chosen percent,
// request by request, is pinned with the real AgentRunner in verify-smart-context-compaction.mjs; that the page shows and saves the options, and what the Hub accepts, is in ui/e2e/agent-options.spec.mjs.
//
// The scripted model proves what the Hub does. It does not prove that any real model behaves better after a compaction (docs/TESTING-WITH-REAL-MODELS.md).
// CLAIM: agent-options
import fs from 'node:fs';
import path from 'node:path';
import { runScenario } from './e2e/harness.mjs';
import { connectModel, pendingApprovals, setMode, startTask, waitFor, waitForState } from './e2e/hub-process.mjs';
import { gitInit, makeCalcProject } from './e2e/fixtures.mjs';
import { call, say } from './e2e/scenarios.mjs';

const ROUTE = '/api/agent/options';
const FILE = 'agent-options.json';

await runScenario({
  name: 'agent-options',
  summary: 'the owner\'s agent options: the route and its layers, what it refuses, the file and a restart, the task that records what applied, a task that is going, a file that cannot be read',
  budgetMs: 240_000,
}, async (t) => {
  const project = path.join(t.scratch, 'app');
  makeCalcProject(project);
  gitInit(project, t.scratch);

  const mock = await t.mock({
    scenario: 'answer',
    scenarios: {
      answer() { return say('Done.'); },
      // Asks for a command, which Review puts to the person; stops when it is refused.
      held(ctx) { return ctx.turn === 0 ? call('run_command', { command: 'echo hold > hold.txt', description: 'wait for the person' }) : say('Stopped: the command was not allowed.'); },
    },
  });
  const finish = async (hub, prompt) => { const task = await startTask(hub, prompt); return waitForState(hub, task.id, ['completed', 'failed', 'uncertain']); };
  const options = async (hub) => (await hub.state()).agentOptions;
  const connect = async (hub) => { await connectModel(hub, mock); await setMode(hub, 'review'); };
  const saved = (hub) => { try { return JSON.parse(fs.readFileSync(path.join(hub.stateDir, FILE), 'utf8')); } catch { return null; } };
  const view = (value) => [value?.autoCompactPercent, value?.autoCompactSaved, value?.autoAcceptChecks];

  // ---- the Hub as it starts -------------------------------------------------------------------------------------------------------------------------
  const hub = await t.hub({ project });
  await connect(hub);
  const initial = await options(hub);
  t.equal(view(initial), [80, null, false], '/api/state: 80% and nothing saved, the Hub accepts no check');
  t.equal([initial.defaultCompactPercent, initial.minCompactPercent, initial.maxCompactPercent], [80, 50, 95], 'and says the default and the limits the page needs');
  t.check((await hub.get('/api/capabilities')).json.postRoutes.includes(ROUTE), 'the route is among the POST routes the Hub declares');
  t.check(saved(hub) === null, 'no file is written until the owner chooses');
  const defaults = await finish(hub, 'Please explain the layout of this project.');
  t.equal(view((await hub.task(defaults.id)).agentOptions), [80, null, false], 'a task started with nothing chosen records the defaults');

  // ---- the layers in front of the route ------------------------------------------------------------------------------------------------------------
  const csrf = await hub.csrfToken();
  const page = { origin: hub.origin, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': csrf, 'content-type': 'application/json', ...hub.authHeaders };
  const post = (headers, body) => hub.rawRequest({ method: 'POST', route: ROUTE, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const without = (name) => Object.fromEntries(Object.entries(page).filter(([key]) => key !== name));
  const body = { autoAcceptChecks: true };
  t.equal((await post(without('authorization'), body)).status, 401, 'no bearer: 401');
  t.equal((await post(without('x-chatmcp-csrf'), body)).status, 403, 'a bearer but no CSRF token: 403');
  t.equal((await post({ ...page, 'x-chatmcp-csrf': 'f'.repeat(64) }, body)).status, 403, 'a wrong CSRF token: 403');
  t.equal((await post(without('x-chatmcp-request'), body)).status, 403, 'no page marker: 403');
  t.equal((await post(without('origin'), body)).status, 403, 'no Origin: 403');
  t.equal((await post({ ...page, origin: 'http://evil.example' }, body)).status, 403, 'another origin: 403');
  t.equal((await post({ ...page, 'content-type': 'text/plain' }, body)).status, 415, 'not JSON: 415');
  t.equal((await post(page, '{ not json')).status, 400, 'a body that is not JSON: 400');
  for (const [label, patch] of [
    ['an empty object', {}], ['an array', [{ autoAcceptChecks: true }]], ['a string', 'true'], ['another key', { enabled: true }],
    ['49', { autoCompactPercent: 49 }], ['96', { autoCompactPercent: 96 }], ['0', { autoCompactPercent: 0 }], ['80.5', { autoCompactPercent: 80.5 }], ['"80"', { autoCompactPercent: '80' }], ['true', { autoCompactPercent: true }],
    ['"true"', { autoAcceptChecks: 'true' }], ['1', { autoAcceptChecks: 1 }], ['null', { autoAcceptChecks: null }],
    ['a good half and a bad half', { autoCompactPercent: 60, autoAcceptChecks: 'yes' }], ['a good half and an unknown key', { autoCompactPercent: 60, extra: 1 }],
  ]) {
    const answer = await post(page, patch);
    t.check(answer.status === 400, `${label}: 400`, `${answer.status} ${answer.text.slice(0, 120)}`);
    const said = (() => { try { return JSON.parse(answer.text); } catch { return null; } })();
    t.check(typeof said?.error === 'string' && said.error.length > 0, `${label}: the answer says why`, answer.text.slice(0, 120));
  }
  t.equal([view(await options(hub)), saved(hub)], [[80, null, false], null], 'none of those changed anything or wrote a file');

  // ---- choosing ---------------------------------------------------------------------------------------------------------------------------------------
  const first = await hub.request('POST', ROUTE, { autoCompactPercent: 65 });
  t.check(first.status === 200, 'autoCompactPercent:65 is accepted', `${first.status} ${first.text.slice(0, 160)}`);
  t.equal(view(first.json?.agentOptions), [65, 65, false], 'and answers with the state that now applies');
  t.check(typeof first.json?.csrfToken === 'string' && first.json?.error === undefined, 'with the CSRF token of the page like the other config routes, and no error key (the page treats one as a failure)');
  t.equal(saved(hub), { version: 1, autoCompactPercent: 65 }, 'the file holds the version and the choice');
  t.equal(view(await options(hub)), [65, 65, false], '/api/state agrees');
  const second = await hub.request('POST', ROUTE, { autoAcceptChecks: true });
  t.equal([second.status, view(second.json?.agentOptions)], [200, [65, 65, true]], 'the other option is accepted and keeps the first');
  t.equal(saved(hub), { version: 1, autoCompactPercent: 65, autoAcceptChecks: true }, 'and the file holds both');

  const chosen = await finish(hub, 'Please explain the layout of this project again.');
  t.equal(view((await hub.task(chosen.id)).agentOptions), [65, 65, true], 'a task started afterwards records the options that applied');

  // ---- a change while a run is going ---------------------------------------------------------------------------------------------------------------
  // The route does not refuse because a task runs; the task keeps the record of what applied when it began, and the next one records the new options.
  mock.setScenario('held');
  const running = await startTask(hub, 'Please run the build.');
  const request = await waitFor(async () => (await pendingApprovals(hub)).find((entry) => entry.taskId === running.id), { label: 'the command to be put to the person' });
  t.equal(view((await hub.task(running.id)).agentOptions), [65, 65, true], 'the run began with the options of the owner');
  const during = await hub.request('POST', ROUTE, { autoCompactPercent: null, autoAcceptChecks: false });
  t.check(during.status === 200 && view(during.json?.agentOptions).join() === '80,,false', 'a task is waiting for an approval and the route still accepts the change (null goes back to the default)', `${during.status} ${during.text.slice(0, 160)}`);
  t.equal(saved(hub), { version: 1, autoAcceptChecks: false }, 'the file no longer holds a percent');
  await hub.post('/api/studio/permissions/decide', { id: request.id, approved: false });
  const stopped = await waitForState(hub, running.id, ['completed', 'failed', 'uncertain']);
  t.equal(stopped.state, 'completed', 'the person said no and the task ended completed (it says it stopped)');
  t.equal(view((await hub.task(running.id)).agentOptions), [65, 65, true], 'the task that was going keeps the record of the options it began with');
  t.check(!fs.existsSync(path.join(project, 'hold.txt')), 'and the command did not run');
  mock.setScenario('answer');
  t.equal(view((await hub.task((await finish(hub, 'One more question.')).id)).agentOptions), [80, null, false], 'the next task records the new options');

  // ---- a restart ---------------------------------------------------------------------------------------------------------------------------------------
  await hub.request('POST', ROUTE, { autoCompactPercent: 90, autoAcceptChecks: true });
  const stateDir = hub.stateDir;
  await hub.stop();
  const again = await t.hub({ project, stateDir });
  await connect(again);
  t.equal(view(await options(again)), [90, 90, true], 'a Hub started on the same data folder finds both choices');
  t.equal(view((await again.task((await finish(again, 'First task after the restart.')).id)).agentOptions), [90, 90, true], 'and the first task after a restart already follows them');
  t.equal((await again.request('POST', ROUTE, { autoCompactPercent: 90 })).status, 200, 'choosing what is already chosen is accepted (it is not an error)');
  t.equal(saved(again), { version: 1, autoCompactPercent: 90, autoAcceptChecks: true }, 'and the file is as before');
  await again.stop();

  // ---- a file the Hub cannot read ---------------------------------------------------------------------------------------------------------------------
  const brokenDir = path.join(t.scratch, 'state-broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, FILE), '{ not json at all');
  const broken = await t.hub({ project, stateDir: brokenDir });
  await connect(broken);
  t.equal(view(await options(broken)), [80, null, false], 'a damaged file does not stop the Hub: the defaults apply');
  t.check(/Không đọc được agent-options\.json/.test(broken.logText()), 'and the Hub log says that the file could not be read');
  t.check(!broken.logText().includes('not json at all'), 'without quoting it');
  const repaired = await broken.request('POST', ROUTE, { autoCompactPercent: 70 });
  t.equal([repaired.status, view(repaired.json?.agentOptions)], [200, [70, 70, false]], 'the owner can choose again');
  t.equal(saved(broken), { version: 1, autoCompactPercent: 70 }, 'and the file is valid afterwards');
  t.equal(view((await broken.task((await finish(broken, 'After the repair.')).id)).agentOptions), [70, 70, false], 'and it is obeyed');
});
