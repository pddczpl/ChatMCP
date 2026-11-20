// The owner's routes for external MCP servers (P2 slice D, plan task ext-14; docs/MCP-CLIENT.md "The screen and its routes"), through a real Hub
// process, the scripted model server and the stdio fixtures tests/fixtures/mcp-seam-server.mjs and mcp-malicious-server.mjs. What must hold:
//
//   1. GET /api/mcp/servers and the nine POST routes sit behind the same layers as every other route: no bearer is 401; a POST without the page's
//      Origin, marker or CSRF token is 403. Each POST route is declared in /api/capabilities.
//   2. upsert -> list round-trip. A secret typed into env or a header (marked secret, or named like a credential) is stored protected and comes back
//      only as {secret: true}: the GET answer, /api/state, the launch record, mcp-servers.json, the rest of the Hub's data folder and its log never
//      hold its text. {keep: true} keeps the stored secret. A bad server or an unknown key is refused (400) and changes nothing.
//   3. A stdio server is not started before its launch record is approved; the approval names the fingerprint shown (expectedFingerprint), a record
//      that changed since (another argument) is 409 mcp_launch_changed, {fingerprint} alone is refused.
//   4. Its lists are pinned only with the fingerprint shown: a wrong one is 409; a server whose tools changed after the owner looked is needs_review
//      with the diff, and approving what was shown before is 409 mcp_fingerprint_mismatch.
//   5. POST /api/mcp/server/tool-policy changes what the permission gate decides for a real task: a denied tool is refused and never reaches the
//      server, an allowed one runs once, and denying it afterwards refuses it from the next call on.
//   6. While a task is active every route that changes the servers or their approvals answers 409 mcp_task_active; the reads still answer.
//   7. A server that cannot be reached is reported (ok: false, its error, retryAt) by the test route; reload reads the file again and reports a file
//      that breaks a rule; delete removes a server.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findNeedles, runScenario } from './e2e/harness.mjs';
import { HUB_ROOT, connectModel, pendingApprovals, setMode, startTask, waitFor, waitForState } from './e2e/hub-process.mjs';
import { gitInit, makeCalcProject } from './e2e/fixtures.mjs';
import { call, say, toolText, wasRefused } from './e2e/scenarios.mjs';
import { runtimeRoot } from './support/mcp-tools.mjs';

const SEAM = path.join(HUB_ROOT, 'tests', 'fixtures', 'mcp-seam-server.mjs');
const DRIFT = path.join(HUB_ROOT, 'tests', 'fixtures', 'mcp-malicious-server.mjs');
const LIST = '/api/mcp/servers';
const ROUTE = Object.freeze({
  upsert: '/api/mcp/server/upsert', delete: '/api/mcp/server/delete', test: '/api/mcp/server/test',
  launchRecord: '/api/mcp/server/launch-record', approveLaunch: '/api/mcp/server/approve-launch',
  toolReview: '/api/mcp/server/tool-review', approveTools: '/api/mcp/server/approve-tools',
  toolPolicy: '/api/mcp/server/tool-policy', reload: '/api/mcp/reload',
});
const HEX64 = /^[0-9a-f]{64}$/;
const mcpCall = (name, args = {}) => call('mcp_call', { name, arguments_json: JSON.stringify(args) });

await runScenario({
  name: 'mcp-http',
  summary: 'the MCP routes and their layers, secrets that never come back, launch and tool approvals by fingerprint, the policy at the gate, 409 while a task runs, reload and delete',
  budgetMs: 240_000,
}, async (t) => {
  const runtime = runtimeRoot();
  if (!runtime) t.skip('not installed: the MCP client SDK (run: npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/mcp-runtime)');
  const project = path.join(t.scratch, 'app');
  makeCalcProject(project);
  gitInit(project, t.scratch);
  const counts = path.join(t.scratch, 'seam-calls.txt');
  const calls = () => (fs.existsSync(counts) ? fs.readFileSync(counts, 'utf8').split('\n').filter(Boolean) : []);
  const results = [];
  const mock = await t.mock({
    scenario: 'answer',
    scenarios: {
      answer() { return say('Done.'); },
      // A denied tool first, then an allowed one; what came back is kept for the checks.
      gate(ctx) {
        if (ctx.turn > 0) results.push(toolText(ctx.results[ctx.turn - 1]));
        if (ctx.turn === 0) return mcpCall('seam.forbidden');
        if (ctx.turn === 1) return mcpCall('seam.echo', { text: 'one' });
        return say('Done.');
      },
      // A command that Review puts to the person: the task waits, active, until it is answered.
      held(ctx) { return ctx.turn === 0 ? call('run_command', { command: 'echo hold > hold.txt', description: 'wait for the person' }) : say('Stopped.'); },
    },
  });
  const hub = await t.hub({ project, env: { CHATMCP_MCP_RUNTIME_DIR: runtime } });
  await connectModel(hub, mock);
  const SECRETS = { env: `sk-envtok-${randomBytes(12).toString('hex')}`, marked: `marked-${randomBytes(12).toString('hex')}`, header: `hdr-${randomBytes(12).toString('hex')}` };
  const leaks = (text) => Object.entries(SECRETS).filter(([, value]) => String(text).includes(value)).map(([name]) => name);
  const list = async () => (await hub.get(LIST)).json;
  const server = async (id) => (await list())?.servers?.find((entry) => entry.id === id) ?? null;
  const post = (route, body) => hub.request('POST', route, body);
  const file = path.join(hub.stateDir, 'mcp-servers.json');
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8'));

  // ---- 1. the layers ------------------------------------------------------------------------------------------------------------------------------
  const first = await hub.get(LIST);
  t.check(first.status === 200 && first.json?.runtime?.state === 'ready' && Array.isArray(first.json?.servers) && first.json.servers.length === 0, 'GET /api/mcp/servers: the runtime is ready and no server is configured', `${first.status} ${first.text.slice(0, 200)}`);
  t.equal((await hub.request('GET', LIST, null, { auth: false })).status, 401, 'GET without the bearer: 401');
  const declared = (await hub.get('/api/capabilities')).json.postRoutes;
  t.check(Object.values(ROUTE).every((route) => declared.includes(route)), 'the nine POST routes are declared in /api/capabilities');
  const csrf = await hub.csrfToken();
  const page = { origin: hub.origin, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': csrf, 'content-type': 'application/json', ...hub.authHeaders };
  const without = (name) => Object.fromEntries(Object.entries(page).filter(([key]) => key !== name));
  for (const route of Object.values(ROUTE)) {
    const body = JSON.stringify({ id: 'probe' });
    const statuses = [
      (await hub.rawRequest({ method: 'POST', route, headers: without('authorization'), body })).status,
      (await hub.rawRequest({ method: 'POST', route, headers: without('x-chatmcp-csrf'), body })).status,
      (await hub.rawRequest({ method: 'POST', route, headers: { ...page, 'x-chatmcp-csrf': 'f'.repeat(64) }, body })).status,
      (await hub.rawRequest({ method: 'POST', route, headers: without('origin'), body })).status,
      (await hub.rawRequest({ method: 'POST', route, headers: { ...page, origin: 'http://evil.example' }, body })).status,
    ];
    t.equal(statuses, [401, 403, 403, 403, 403], `${route}: no bearer 401; no CSRF, a wrong CSRF, no Origin, another Origin 403`);
  }
  t.check(!fs.existsSync(file), 'none of those wrote mcp-servers.json');

  // ---- 2. upsert, list, secrets ----------------------------------------------------------------------------------------------------------------------
  const seamInput = (args = [SEAM, '--count-file', counts]) => ({
    transport: 'stdio', command: process.execPath, args,
    env: { PLAIN_NAME: 'visible-value', API_TOKEN: { value: SECRETS.env, secret: false }, OTHER_VALUE: { value: SECRETS.marked, secret: true } },
  });
  const created = await post(ROUTE.upsert, { id: 'seam', server: seamInput() });
  t.check(created.status === 200 && created.json?.server?.id === 'seam' && created.json?.created === true, 'upsert seam (stdio): 200, created', `${created.status} ${created.text.slice(0, 200)}`);
  t.equal(created.json?.server?.env, { PLAIN_NAME: { value: 'visible-value', secret: false }, API_TOKEN: { secret: true }, OTHER_VALUE: { secret: true } }, 'the answer shows a plain value and says only "set" for the two secrets (one named like a credential, one marked)');
  const web = await post(ROUTE.upsert, { id: 'web', server: { transport: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: { value: `Bearer ${SECRETS.header}` }, 'X-Plain': 'hello' } } });
  t.check(web.status === 200 && web.json?.server?.transport === 'http', 'upsert web (http): 200', `${web.status} ${web.text.slice(0, 200)}`);
  t.equal(web.json?.server?.headers, { Authorization: { secret: true }, 'X-Plain': { value: 'hello', secret: false } }, 'an Authorization header is stored as a secret even when the page did not mark it');
  const listed = await list();
  t.equal(listed.servers.map((entry) => [entry.id, entry.transport, entry.enabled]), [['seam', 'stdio', true], ['web', 'http', true]], 'GET lists both, in order, enabled');
  const seamView = listed.servers[0];
  t.equal([seamView.command, seamView.args, Object.keys(seamView.env)], [process.execPath, [SEAM, '--count-file', counts], ['PLAIN_NAME', 'API_TOKEN', 'OTHER_VALUE']], 'GET round-trips the command, the args and the env names');
  t.equal([seamView.status?.state, seamView.status?.launch?.required, seamView.status?.launch?.approved], ['idle', true, false], 'a new stdio server is idle and its launch is not approved');
  t.equal(leaks((await hub.get(LIST)).text), [], 'GET /api/mcp/servers holds no secret text');
  t.equal(leaks(JSON.stringify(await hub.state())), [], '/api/state holds no secret text');
  t.equal(leaks(fs.readFileSync(file, 'utf8')), [], 'mcp-servers.json holds no secret text');
  const blob = stored().servers.seam.env.API_TOKEN.secret;
  t.check(typeof blob === 'string' && blob.length > 0, 'mcp-servers.json holds the protected form of the secret');
  const kept = await post(ROUTE.upsert, { id: 'seam', server: { ...seamInput(), env: { PLAIN_NAME: 'visible-value', API_TOKEN: { keep: true }, OTHER_VALUE: { keep: true } } } });
  t.check(kept.status === 200 && kept.json?.created === false && stored().servers.seam.env.API_TOKEN.secret === blob, '{keep: true} keeps the stored secret (the same protected blob), and the answer says it was not created');
  for (const [label, body, code] of [
    ['the legacy SSE transport', { id: 'old', server: { transport: 'sse', url: 'https://example.com/sse' } }, 'mcp_transport_unsupported'],
    ['a reserved id', { id: 'hub', server: { transport: 'stdio', command: 'node' } }, 'mcp_config_invalid'],
    ['an id with capitals', { id: 'Bad', server: { transport: 'stdio', command: 'node' } }, 'mcp_request_invalid'],
    ['an unknown setting of the server', { id: 'odd', server: { transport: 'stdio', command: 'node', shell: true } }, 'mcp_config_invalid'],
    ['an unknown key of the request', { id: 'odd', server: { transport: 'stdio', command: 'node' }, extra: 1 }, 'mcp_request_invalid'],
    ['no server', { id: 'odd' }, 'mcp_request_invalid'],
    ['a secret to keep that is not stored', { id: 'odd', server: { transport: 'stdio', command: 'node', env: { X_TOKEN: { keep: true } } } }, 'mcp_config_invalid'],
    ['a credential in plain text from the file form', { id: 'odd', server: { transport: 'http', url: 'http://user:pw@127.0.0.1:9/mcp' } }, 'mcp_config_invalid'],
  ]) {
    const answer = await post(ROUTE.upsert, body);
    t.check(answer.status === 400 && answer.json?.code === code, `upsert refuses ${label}: 400 ${code}`, `${answer.status} ${answer.text.slice(0, 160)}`);
  }
  t.equal((await list()).servers.map((entry) => entry.id), ['seam', 'web'], 'none of those changed the list');

  // ---- 3. the launch record ----------------------------------------------------------------------------------------------------------------------
  const record = await post(ROUTE.launchRecord, { id: 'seam' });
  t.check(record.status === 200 && record.json?.required === true && record.json?.approved === false && HEX64.test(record.json?.fingerprint ?? ''), 'launch-record: required, not approved, a fingerprint', `${record.status} ${record.text.slice(0, 200)}`);
  t.equal([record.json?.record?.args, record.json?.record?.envKeys], [[SEAM, '--count-file', counts], ['API_TOKEN', 'OTHER_VALUE', 'PLAIN_NAME']], 'the record shows the args and the env NAMES, sorted');
  t.check(HEX64.test(record.json?.record?.sha256 ?? '') && typeof record.json?.record?.executable === 'string' && record.json.record.executable.length > 0, 'and the executable the Hub will start with its sha256');
  t.equal(leaks(record.text), [], 'the launch record holds no secret text');
  const early = await post(ROUTE.test, { id: 'seam' });
  t.check(early.status === 200 && early.json?.ok === false && early.json?.error?.code === 'mcp_launch_not_approved', 'test before the launch is approved: ok false, mcp_launch_not_approved', `${early.status} ${early.text.slice(0, 200)}`);
  t.check(!fs.existsSync(counts) && (await server('seam')).status.state === 'needs_launch_approval', 'nothing was started; the server needs its launch approved');
  const keyOnly = await post(ROUTE.approveLaunch, { id: 'seam', fingerprint: record.json.fingerprint });
  t.check(keyOnly.status === 400, '{fingerprint} instead of expectedFingerprint: 400', `${keyOnly.status} ${keyOnly.text.slice(0, 160)}`);
  const missing = await post(ROUTE.approveLaunch, { id: 'seam' });
  t.check(missing.status === 400 && missing.json?.code === 'mcp_fingerprint_required', 'no fingerprint: 400 mcp_fingerprint_required', `${missing.status} ${missing.text.slice(0, 160)}`);
  // The owner looked at the record; then the server is changed (another argument) before the click.
  t.equal((await post(ROUTE.upsert, { id: 'seam', server: { ...seamInput([SEAM, '--count-file', counts, '--tools', '2']), env: { PLAIN_NAME: 'visible-value', API_TOKEN: { keep: true }, OTHER_VALUE: { keep: true } } } })).status, 200, 'the server gets another argument');
  const stale = await post(ROUTE.approveLaunch, { id: 'seam', expectedFingerprint: record.json.fingerprint });
  t.check(stale.status === 409 && stale.json?.code === 'mcp_launch_changed', 'approving the record shown before the change: 409 mcp_launch_changed', `${stale.status} ${stale.text.slice(0, 160)}`);
  t.check((await server('seam')).status.launch.approved === false, 'and nothing was approved');
  const current = await post(ROUTE.launchRecord, { id: 'seam' });
  t.check(current.json?.fingerprint !== record.json.fingerprint && current.json?.record?.args?.includes('--tools'), 'the record now shows the new argument under another fingerprint');
  const approved = await post(ROUTE.approveLaunch, { id: 'seam', expectedFingerprint: current.json.fingerprint });
  t.check(approved.status === 200 && approved.json?.ok === true && approved.json?.fingerprint === current.json.fingerprint, 'approving the record shown: 200 with its fingerprint', `${approved.status} ${approved.text.slice(0, 160)}`);
  t.check((await server('seam')).status.launch.approved === true, 'GET says the launch is approved');

  // ---- 4. the lists ----------------------------------------------------------------------------------------------------------------------------------
  const tested = await post(ROUTE.test, { id: 'seam' });
  t.check(tested.status === 200 && tested.json?.ok === true && tested.json?.status?.state === 'needs_review' && tested.json?.status?.tools === 10, 'test: connected, 10 tools, needs_review (nothing pinned yet)', `${tested.status} ${tested.text.slice(0, 240)}`);
  const review = await post(ROUTE.toolReview, { id: 'seam' });
  t.check(review.status === 200 && review.json?.state === 'unpinned' && HEX64.test(review.json?.fingerprint ?? '') && review.json?.tools?.length === 10, 'tool-review: unpinned, a fingerprint and the 10 tools', `${review.status} ${review.text.slice(0, 200)}`);
  const unpinned = await server('seam');
  t.check(unpinned.status.state === 'needs_review' && unpinned.status.review?.state === 'unpinned' && unpinned.tools.length === 10, 'GET shows the 10 tools to review and says the server needs review (its tools are not offered)');
  const wrong = await post(ROUTE.approveTools, { id: 'seam', expectedFingerprint: '0'.repeat(64) });
  t.check(wrong.status === 409 && wrong.json?.code === 'mcp_fingerprint_mismatch', 'approve-tools with another fingerprint: 409 mcp_fingerprint_mismatch', `${wrong.status} ${wrong.text.slice(0, 160)}`);
  const pinned = await post(ROUTE.approveTools, { id: 'seam', expectedFingerprint: review.json.fingerprint });
  t.check(pinned.status === 200 && pinned.json?.ok === true, 'approve-tools with the fingerprint shown: 200', `${pinned.status} ${pinned.text.slice(0, 160)}`);
  const seamPinned = await server('seam');
  t.check(seamPinned.status.state === 'connected' && seamPinned.status.review.state === 'pinned', 'GET: connected and pinned');
  t.equal(seamPinned.tools.map((tool) => tool.name).slice(0, 4), ['echo', 'create_issue', 'wipe_cache', 'forbidden'], 'GET lists the tools of the server');
  t.check(seamPinned.tools.every((tool) => tool.rule === null && tool.policy === 'ask'), 'with no rule set every tool is asked');
  t.check(seamPinned.tools.find((tool) => tool.name === 'wipe_cache')?.annotations?.destructiveHint === true, 'and the annotations the server gave (wipe_cache is destructive)');

  // A server whose tools change after the owner looked at them.
  const drift = await post(ROUTE.upsert, { id: 'drift', server: { transport: 'stdio', command: process.execPath, args: [DRIFT, '--change-after', '1'] } });
  t.equal(drift.status, 200, 'upsert drift');
  t.equal((await post(ROUTE.approveLaunch, { id: 'drift', expectedFingerprint: (await post(ROUTE.launchRecord, { id: 'drift' })).json.fingerprint })).status, 200, 'its launch is approved');
  t.check((await post(ROUTE.test, { id: 'drift' })).json?.ok === true, 'test drift: connected');
  const shown = (await post(ROUTE.toolReview, { id: 'drift' })).json;
  t.equal((await post(ROUTE.approveTools, { id: 'drift', expectedFingerprint: shown.fingerprint })).status, 200, 'its first lists are pinned');
  const again = await post(ROUTE.test, { id: 'drift' });
  t.check(again.json?.ok === true && again.json?.status?.state === 'needs_review', 'a second test lists again: the description changed, needs_review', again.text.slice(0, 240));
  const changed = (await post(ROUTE.toolReview, { id: 'drift' })).json;
  t.equal([changed.state, changed.diff?.changed?.map((entry) => [entry.kind, entry.name, entry.fields])], ['needs_review', [['tool', 'tool_1', ['description']]]], 'tool-review shows the diff: tool_1, its description');
  const late = await post(ROUTE.approveTools, { id: 'drift', expectedFingerprint: shown.fingerprint });
  t.check(late.status === 409 && late.json?.code === 'mcp_fingerprint_mismatch', 'approving the lists shown before the change: 409 mcp_fingerprint_mismatch', `${late.status} ${late.text.slice(0, 160)}`);
  t.equal((await post(ROUTE.approveTools, { id: 'drift', expectedFingerprint: changed.fingerprint })).status, 200, 'approving what is shown now: 200');
  t.equal((await post(ROUTE.delete, { id: 'drift' })).json?.deleted, true, 'drift is deleted');
  t.check(!(await list()).servers.some((entry) => entry.id === 'drift'), 'and is no longer listed');

  // ---- 5. the policy at the gate -------------------------------------------------------------------------------------------------------------------
  for (const [label, body] of [
    ['a word that is not ask, allow or deny', { id: 'seam', tools: { echo: 'yes' } }],
    ['a default that is not a word', { id: 'seam', default: 1 }],
    ['an unknown key', { id: 'seam', tools: { echo: 'allow' }, extra: true }],
    ['neither default nor tools', { id: 'seam' }],
    ['tools that are not an object', { id: 'seam', tools: ['echo'] }],
  ]) {
    const answer = await post(ROUTE.toolPolicy, body);
    t.check(answer.status === 400, `tool-policy refuses ${label}: 400`, `${answer.status} ${answer.text.slice(0, 160)}`);
  }
  t.equal((await post(ROUTE.toolPolicy, { id: 'nobody', tools: { echo: 'allow' } })).status, 404, 'tool-policy of a server that is not configured: 404');
  const policy = await post(ROUTE.toolPolicy, { id: 'seam', tools: { forbidden: 'deny', echo: 'allow' } });
  t.check(policy.status === 200 && policy.json?.server?.policy?.tools?.forbidden === 'deny' && policy.json.server.policy.tools.echo === 'allow', 'tool-policy: forbidden deny, echo allow', `${policy.status} ${policy.text.slice(0, 200)}`);
  t.equal(stored().servers.seam.policy, { tools: { forbidden: 'deny', echo: 'allow' } }, 'mcp-servers.json holds the policy');
  t.check(stored().servers.seam.env.API_TOKEN.secret === blob, 'and still the same protected secret');
  const seamPolicy = await server('seam');
  t.equal(['echo', 'forbidden', 'create_issue'].map((name) => { const tool = seamPolicy.tools.find((entry) => entry.name === name); return [tool?.rule, tool?.policy]; }), [['allow', 'allow'], ['deny', 'deny'], [null, 'ask']], 'GET shows the rule and the word that applies');
  t.check(seamPolicy.status.state === 'connected', 'a policy change keeps the connection');
  await setMode(hub, 'autonomous');
  mock.setScenario('gate');
  const runGate = async () => { results.length = 0; const task = await startTask(hub, 'Use the seam tools.'); return waitForState(hub, task.id, ['completed', 'failed', 'uncertain']); };
  await runGate();
  t.check(results.length === 2 && wasRefused(results[0]) && !wasRefused(results[1]) && /echo: one/.test(results[1]), 'a task: seam.forbidden (deny) is refused, seam.echo (allow) runs', JSON.stringify(results).slice(0, 300));
  t.equal(calls(), ['echo'], 'only echo reached the server, once');
  t.equal((await post(ROUTE.toolPolicy, { id: 'seam', tools: { echo: 'deny' } })).status, 200, 'echo is set to deny');
  await runGate();
  t.check(results.length === 2 && wasRefused(results[0]) && wasRefused(results[1]), 'the next task: both are refused', JSON.stringify(results).slice(0, 300));
  t.equal(calls(), ['echo'], 'and echo did not reach the server again');
  const cleared = await post(ROUTE.toolPolicy, { id: 'seam', default: 'deny', tools: { echo: null, forbidden: null } });
  t.equal([cleared.status, cleared.json?.server?.policy], [200, { default: 'deny', tools: {} }], 'null clears a rule; a default can be set');
  t.equal((await post(ROUTE.toolPolicy, { id: 'seam', default: null })).json?.server?.policy, { tools: {} }, 'and null clears the default');

  // ---- 6. while a task is active -------------------------------------------------------------------------------------------------------------------
  await setMode(hub, 'review');
  mock.setScenario('held');
  const running = await startTask(hub, 'Please run the build.');
  const request = await waitFor(async () => (await pendingApprovals(hub)).find((entry) => entry.taskId === running.id), { label: 'the command to be put to the person' });
  const writes = [
    [ROUTE.upsert, { id: 'later', server: { transport: 'stdio', command: 'node' } }], [ROUTE.delete, { id: 'web' }], [ROUTE.test, { id: 'seam' }],
    [ROUTE.approveLaunch, { id: 'seam', expectedFingerprint: current.json.fingerprint }], [ROUTE.approveTools, { id: 'seam', expectedFingerprint: review.json.fingerprint }],
    [ROUTE.toolPolicy, { id: 'seam', tools: { echo: 'allow' } }], [ROUTE.reload, {}],
  ];
  for (const [route, body] of writes) {
    const answer = await post(route, body);
    t.check(answer.status === 409 && answer.json?.code === 'mcp_task_active', `${route} while a task is active: 409 mcp_task_active`, `${answer.status} ${answer.text.slice(0, 160)}`);
  }
  t.check((await post(ROUTE.launchRecord, { id: 'seam' })).status === 200 && (await post(ROUTE.toolReview, { id: 'seam' })).status === 200 && (await hub.get(LIST)).status === 200, 'the reads still answer: GET, launch-record, tool-review');
  t.equal([(await list()).servers.map((entry) => entry.id), stored().servers.seam.policy], [['seam', 'web'], { tools: {} }], 'nothing was changed');
  await hub.post('/api/studio/permissions/decide', { id: request.id, approved: false });
  await waitForState(hub, running.id, ['completed', 'failed', 'uncertain']);
  mock.setScenario('answer');

  // ---- 7. an unreachable server, reload, delete -----------------------------------------------------------------------------------------------------
  const down = await post(ROUTE.test, { id: 'web' });
  t.check(down.status === 200 && down.json?.ok === false && /^mcp_/.test(down.json?.error?.code ?? '') && down.json?.status?.state === 'failed', 'test of a server nobody listens for: ok false, an mcp_ code, failed', `${down.status} ${down.text.slice(0, 240)}`);
  const webView = await server('web');
  t.check(typeof webView.status.retryAt === 'string' && webView.status.lastError?.code === down.json.error.code, 'GET shows the error and when the preflight tries again (retryAt)');
  t.equal(leaks(down.text), [], 'the error holds no secret text (the Authorization header)');
  const before = fs.readFileSync(file, 'utf8');
  const edited = JSON.parse(before);
  edited.servers.hand = { transport: 'stdio', command: 'node', args: ['--version'] };
  fs.writeFileSync(file, JSON.stringify(edited, null, 2));
  const reloaded = await post(ROUTE.reload, {});
  t.check(reloaded.status === 200 && reloaded.json?.servers?.map((entry) => entry.id).join() === 'seam,web,hand', 'reload reads a file edited by hand', `${reloaded.status} ${reloaded.text.slice(0, 200)}`);
  t.equal((await server('seam')).status.state, 'idle', 'reload closes the open connections (they reopen at the next task or test)');
  fs.writeFileSync(file, JSON.stringify({ version: 2, servers: {} }));
  const broken = await post(ROUTE.reload, {});
  t.check(broken.status === 400 && broken.json?.code === 'mcp_config_invalid', 'a file that breaks a rule: 400 mcp_config_invalid', `${broken.status} ${broken.text.slice(0, 160)}`);
  const afterBroken = await list();
  t.check(afterBroken.configError?.code === 'mcp_config_invalid' && afterBroken.servers.map((entry) => entry.id).join() === 'seam,web,hand', 'GET says the file was not read and keeps the list read before');
  fs.writeFileSync(file, before);
  t.check((await post(ROUTE.reload, {})).status === 200 && (await list()).configError === null, 'the file put back: reload answers 200 and the error is gone');
  t.equal((await post(ROUTE.delete, { id: 'nobody' })).status, 404, 'delete of a server that is not configured: 404');
  t.equal((await post(ROUTE.delete, { id: '../x' })).status, 400, 'delete of an id that is not one: 400');
  const gone = await post(ROUTE.delete, { id: 'web' });
  t.check(gone.status === 200 && gone.json?.deleted === true && !(await list()).servers.some((entry) => entry.id === 'web'), 'delete web: 200, no longer listed');
  t.check(!Object.hasOwn(stored().servers, 'web'), 'and no longer in mcp-servers.json');

  // ---- what the Hub kept -----------------------------------------------------------------------------------------------------------------------------
  const found = findNeedles(hub.stateDir, Object.values(SECRETS));
  t.check(found.scanned > 0 && found.hits.length === 0, `no secret text in the ${found.scanned} files of the Hub's data folder`, JSON.stringify(found.hits).slice(0, 200));
  t.equal(leaks(hub.logText()), [], 'nor in the Hub log');
});
