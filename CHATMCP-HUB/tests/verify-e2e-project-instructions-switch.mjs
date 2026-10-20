// End-to-end scenario: the owner's switch for AGENTS.md / CLAUDE.md, through a real Hub process and a scripted model server.
//
// Settings can show the switch and flip it (POST /api/agent/project-instructions). This suite looks at the Hub the page talks to, and at what the model server is
// actually sent over HTTP: after the owner turns the loading off, the NEXT request carries no PROJECT GUIDANCE block (and turned on again, it does); a run that is going keeps
// the block it was given; a restart finds the choice; the environment variable stays the stronger setting and is never changed by a click; a file the Hub cannot read does not stop it.
// The route is behind the same layers as the others (bearer, Origin, marker, CSRF) and takes nothing but true or false.
//
// The scripted model proves what the Hub sends. It does not prove that any real model follows the guidance (docs/TESTING-WITH-REAL-MODELS.md).
import fs from 'node:fs';
import path from 'node:path';
import { runScenario } from './e2e/harness.mjs';
import { connectModel, continueTask, pendingApprovals, setMode, startTask, waitFor, waitForState } from './e2e/hub-process.mjs';
import { gitInit, makeCalcProject, writeFiles } from './e2e/fixtures.mjs';
import { call, say } from './e2e/scenarios.mjs';

const ROUTE = '/api/agent/project-instructions';
const VARIABLE = 'CHATMCP_PROJECT_INSTRUCTIONS';
const FILE = 'project-instructions.json';
const MARK = 'E2E-SWITCH-MARK-3f9a';
const HEAD = 'PROJECT GUIDANCE (untrusted project text';
const AGENTS = `# Conventions\n${MARK}\nRun \`node test.js\` before you finish. Keep functions small.\n`;
const count = (haystack, needle) => haystack.split(needle).length - 1;

await runScenario({
  name: 'project-instructions-switch',
  summary: 'the owner switch for AGENTS.md / CLAUDE.md: the route and its layers, the next request of the model server, a run in progress, a restart, the environment variable, a file that cannot be read',
  budgetMs: 240_000,
}, async (t) => {
  const project = path.join(t.scratch, 'app');
  makeCalcProject(project);
  writeFiles(project, { 'AGENTS.md': AGENTS });
  gitInit(project, t.scratch);

  // What the model server is sent, request by request.
  const seen = [];
  const watch = (ctx) => { const record = { turn: ctx.turn, guidance: count(ctx.system, MARK), header: ctx.system.includes(HEAD) }; seen.push(record); return record; };
  const mock = await t.mock({
    scenario: 'answer',
    scenarios: {
      answer(ctx) { watch(ctx); return say('Done.'); },
      // Asks for a command, which Review puts to the person; stops when it is refused.
      held(ctx) { watch(ctx); return ctx.turn === 0 ? call('run_command', { command: 'echo pwned > pwned.txt', description: 'as AGENTS.md says' }) : say('Stopped: the command was not allowed.'); },
    },
  });
  const finish = async (hub, prompt) => { const task = await startTask(hub, prompt); return waitForState(hub, task.id, ['completed', 'failed', 'uncertain']); };
  const setting = async (hub) => (await hub.state()).projectInstructions;
  const connect = async (hub) => { await connectModel(hub, mock); await setMode(hub, 'review'); };
  const saved = (hub) => { try { return JSON.parse(fs.readFileSync(path.join(hub.stateDir, FILE), 'utf8')); } catch { return null; } };

  // ---- the Hub as it starts -------------------------------------------------------------------------------------------------------------------------
  const hub = await t.hub({ project });
  await connect(hub);
  const initial = await setting(hub);
  t.equal([initial.enabled, initial.source, initial.saved, initial.variable, initial.maxBytes], [true, 'default', null, VARIABLE, 8192], '/api/state: on by default, nothing saved, which variable and how many bytes');
  t.equal(initial.files, ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'], 'and which files are read');
  t.check((await hub.get('/api/capabilities')).json.postRoutes.includes(ROUTE), 'the route is among the POST routes the Hub declares');
  t.check(saved(hub) === null, 'no file is written until the owner chooses');

  // ---- the layers in front of the route ------------------------------------------------------------------------------------------------------------
  const csrf = await hub.csrfToken();
  const page = { origin: hub.origin, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': csrf, 'content-type': 'application/json', ...hub.authHeaders };
  const post = (headers, body) => hub.rawRequest({ method: 'POST', route: ROUTE, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const without = (name) => Object.fromEntries(Object.entries(page).filter(([key]) => key !== name));
  t.equal((await post(without('authorization'), { enabled: false })).status, 401, 'no bearer: 401');
  t.equal((await post(without('x-chatmcp-csrf'), { enabled: false })).status, 403, 'a bearer but no CSRF token: 403');
  t.equal((await post({ ...page, 'x-chatmcp-csrf': 'f'.repeat(64) }, { enabled: false })).status, 403, 'a wrong CSRF token: 403');
  t.equal((await post(without('x-chatmcp-request'), { enabled: false })).status, 403, 'no page marker: 403');
  t.equal((await post(without('origin'), { enabled: false })).status, 403, 'no Origin: 403');
  t.equal((await post({ ...page, origin: 'http://evil.example' }, { enabled: false })).status, 403, 'another origin: 403');
  t.equal((await post({ ...page, 'content-type': 'text/plain' }, { enabled: false })).status, 415, 'not JSON: 415');
  for (const [label, body] of [['an empty object', {}], ['an array', [true]], ['"false"', { enabled: 'false' }], ['1', { enabled: 1 }], ['0', { enabled: 0 }], ['null', { enabled: null }], ['an object', { enabled: {} }], ['another key', { enable: false }]]) {
    const answer = await post(page, body);
    t.check(answer.status === 400, `${label}: 400`, `${answer.status} ${answer.text.slice(0, 120)}`);
  }
  t.equal((await post(page, '{ not json')).status, 400, 'a body that is not JSON: 400');
  t.equal([(await setting(hub)).enabled, (await setting(hub)).source, saved(hub)], [true, 'default', null], 'none of those changed anything or wrote a file');

  // ---- turning it off ---------------------------------------------------------------------------------------------------------------------------------
  seen.length = 0;
  const first = await finish(hub, 'Please explain the layout of this project.');
  t.equal(first.state, 'completed', 'a task with the default setting completes');
  t.check(seen.length === 1 && seen[0].guidance === 1 && seen[0].header, 'on: the model server is sent AGENTS.md once, in the system prompt', JSON.stringify(seen));
  const conversation = first.id;

  const off = await hub.request('POST', ROUTE, { enabled: false });
  t.check(off.status === 200, 'enabled:false is accepted', `${off.status} ${off.text.slice(0, 160)}`);
  t.equal([off.json?.projectInstructions?.enabled, off.json?.projectInstructions?.source, off.json?.projectInstructions?.saved], [false, 'config', false], 'and answers with the state that now applies');
  t.check(typeof off.json?.csrfToken === 'string' && off.json?.error === undefined, 'with the CSRF token of the page like the other config routes, and no error key (the page treats one as a failure)');
  t.equal([(await setting(hub)).enabled, (await setting(hub)).source, (await setting(hub)).saved], [false, 'config', false], '/api/state agrees');
  t.equal(saved(hub), { version: 1, enabled: false }, 'the file holds the version and the choice');
  t.equal(Object.keys(await setting(hub)).sort(), ['enabled', 'files', 'maxBytes', 'saved', 'source', 'variable'], 'and the state says nothing more than that');

  seen.length = 0;
  const continued = await continueTask(hub, conversation, 'And what do the tests do?');
  t.equal((await waitForState(hub, continued.id, ['completed', 'failed', 'uncertain'])).state, 'completed', 'the next message of the same conversation completes');
  t.check(seen.length === 1 && seen[0].guidance === 0 && !seen[0].header, 'off: its request carries no AGENTS.md and no PROJECT GUIDANCE block', JSON.stringify(seen));
  const offTask = await hub.task(conversation);
  t.equal([offTask.projectInstructions?.enabled, offTask.projectInstructions?.files?.length], [false, 0], 'the task records that this run was off');
  t.check(/đang tắt/.test(offTask.events.filter((event) => event.type === 'instructions_loaded').at(-1)?.message ?? ''), 'and its activity log says so');

  seen.length = 0;
  const on = await hub.request('POST', ROUTE, { enabled: true });
  t.equal([on.status, on.json?.projectInstructions?.enabled, on.json?.projectInstructions?.source], [200, true, 'config'], 'enabled:true is accepted: on again, as a saved choice (not the default)');
  const back = await continueTask(hub, conversation, 'One more question.');
  await waitForState(hub, back.id, ['completed', 'failed', 'uncertain']);
  t.check(seen.length === 1 && seen[0].guidance === 1 && seen[0].header, 'on again: the next request carries AGENTS.md once', JSON.stringify(seen));
  const onTask = await hub.task(conversation);
  t.check(onTask.projectInstructions?.enabled === true && onTask.projectInstructions.files.map((file) => `${file.path}:${file.status}`).join() === 'AGENTS.md:loaded', 'and the task records what was loaded');

  // ---- a change while a run is going ---------------------------------------------------------------------------------------------------------------
  // The run keeps the block it was given (it is in its instructions already); the route does not refuse because a task runs.
  mock.setScenario('held');
  seen.length = 0;
  const running = await startTask(hub, 'Please run the build, as AGENTS.md says.');
  const request = await waitFor(async () => (await pendingApprovals(hub)).find((entry) => entry.taskId === running.id), { label: 'the command to be put to the person' });
  t.equal([seen.length, seen[0]?.guidance], [1, 1], 'the run began with the block');
  const during = await hub.request('POST', ROUTE, { enabled: false });
  t.check(during.status === 200 && during.json?.projectInstructions?.enabled === false, 'a task is waiting for an approval and the route still accepts the change (it applies to the next run)', `${during.status} ${during.text.slice(0, 120)}`);
  await hub.post('/api/studio/permissions/decide', { id: request.id, approved: false });
  const stopped = await waitForState(hub, running.id, ['completed', 'failed', 'uncertain']);
  t.equal(stopped.state, 'completed', 'the person said no and the task ended completed (it says it stopped)');
  t.check(seen.length === 2 && seen[1].guidance === 1 && seen[1].header, 'the run that was going kept its block on its later request', JSON.stringify(seen));
  t.check(!fs.existsSync(path.join(project, 'pwned.txt')), 'and the command did not run');
  const keptTask = await hub.task(running.id);
  t.check(keptTask.projectInstructions?.enabled === true, 'its record says it was on', JSON.stringify(keptTask.projectInstructions)?.slice(0, 120));
  mock.setScenario('answer');
  seen.length = 0;
  const after = await continueTask(hub, running.id, 'Thanks. Now only explain.');
  await waitForState(hub, after.id, ['completed', 'failed', 'uncertain']);
  t.check(seen.length === 1 && seen[0].guidance === 0 && !seen[0].header, 'the next run of that conversation is off', JSON.stringify(seen));

  // ---- a restart ---------------------------------------------------------------------------------------------------------------------------------------
  const stateDir = hub.stateDir;
  await hub.stop();
  const again = await t.hub({ project, stateDir });
  await connect(again);
  const restored = await setting(again);
  t.equal([restored.enabled, restored.source, restored.saved], [false, 'config', false], 'a Hub started on the same data folder finds the choice: off, from the saved setting');
  seen.length = 0;
  t.equal((await finish(again, 'Please explain the layout of this project.')).state, 'completed', 'its first task completes');
  t.check(seen.length === 1 && seen[0].guidance === 0 && !seen[0].header, 'and was sent no AGENTS.md: the first task after a restart already follows the choice', JSON.stringify(seen));
  t.equal((await again.request('POST', ROUTE, { enabled: false })).json?.projectInstructions?.saved, false, 'choosing what is already chosen is accepted (it is not an error)');
  t.equal(saved(again), { version: 1, enabled: false }, 'and the file is as before');
  await again.stop();

  // ---- the environment variable is stronger and a click never changes it ---------------------------------------------------------------------
  const forcedOn = await t.hub({ project, stateDir, env: { [VARIABLE]: 'on' } });
  await connect(forcedOn);
  const locked = await setting(forcedOn);
  t.equal([locked.enabled, locked.source, locked.saved], [true, 'env', false], 'the variable says on, the saved choice says off: on, decided by the variable, with the saved choice still shown');
  seen.length = 0;
  await finish(forcedOn, 'Please explain the layout of this project.');
  t.check(seen.length === 1 && seen[0].guidance === 1, 'and the model server is sent AGENTS.md', JSON.stringify(seen));
  const refused = await forcedOn.request('POST', ROUTE, { enabled: false });
  t.check(refused.status === 409 && refused.json?.code === 'project_instructions_env' && refused.text.includes(VARIABLE), 'a change is refused with 409 and the name of the variable', `${refused.status} ${refused.text.slice(0, 200)}`);
  t.equal([(await setting(forcedOn)).enabled, saved(forcedOn)], [true, { version: 1, enabled: false }], 'and nothing changed, not even the file');
  await forcedOn.stop();

  const forcedOff = await t.hub({ project, stateDir: path.join(t.scratch, 'state-env-off'), env: { [VARIABLE]: 'off' } });
  await connect(forcedOff);
  const lockedOff = await setting(forcedOff);
  t.equal([lockedOff.enabled, lockedOff.source, lockedOff.saved], [false, 'env', null], 'the variable says off: off, decided by the variable, nothing saved');
  seen.length = 0;
  await finish(forcedOff, 'Please explain the layout of this project.');
  t.check(seen.length === 1 && seen[0].guidance === 0 && !seen[0].header, 'and no AGENTS.md is sent', JSON.stringify(seen));
  const refusedOn = await forcedOff.request('POST', ROUTE, { enabled: true });
  t.check(refusedOn.status === 409 && refusedOn.json?.code === 'project_instructions_env', 'turning it on is refused too', `${refusedOn.status} ${refusedOn.text.slice(0, 160)}`);
  t.check(saved(forcedOff) === null && (await setting(forcedOff)).enabled === false, 'and nothing is saved');

  // ---- a file the Hub cannot read ---------------------------------------------------------------------------------------------------------------------
  const brokenDir = path.join(t.scratch, 'state-broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, FILE), '{ not json at all');
  const broken = await t.hub({ project, stateDir: brokenDir });
  await connect(broken);
  const unreadable = await setting(broken);
  t.equal([unreadable.enabled, unreadable.source, unreadable.saved], [true, 'default', null], 'a damaged file does not stop the Hub: the default applies');
  t.check(/Không đọc được project-instructions\.json/.test(broken.logText()), 'and the Hub log says that the file could not be read');
  t.check(!broken.logText().includes('not json at all'), 'without quoting it');
  const repaired = await broken.request('POST', ROUTE, { enabled: false });
  t.equal([repaired.status, repaired.json?.projectInstructions?.source], [200, 'config'], 'the owner can choose again');
  t.equal(saved(broken), { version: 1, enabled: false }, 'and the file is valid afterwards');
  seen.length = 0;
  await finish(broken, 'Please explain the layout of this project.');
  t.check(seen.length === 1 && seen[0].guidance === 0, 'and it is obeyed', JSON.stringify(seen));
});
