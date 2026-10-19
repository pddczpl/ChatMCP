// End-to-end scenario 5: what keeps one person's data away from another's, and from the rest of the machine's network.
//
// ChatMCP Hub is a SINGLE-USER application: no accounts, one workspace at a time, one state folder per Hub. So "user A and user B
// cannot see each other" is checked in the only form that is true of this build: two Hubs side by side, each with its own state
// folder, workspace and model, started by two different people on one machine or by one person for two projects. What the
// suite proves:
//   1. The door. Only a caller holding the per-launch bearer secret, through a page the Hub itself served, can talk to it:
//      no or a wrong secret, a foreign Host, a foreign Origin (also for a CORS preflight), a missing or wrong CSRF token, or a
//      non-JSON body is refused and changes nothing. Every layer is tested WITH a valid bearer, so removing an inner check
//      (the mutation list in tests/mutation/isolation.json) is still noticed. The Hub listens on loopback only.
//   2. Two Hubs. Nothing of A (task, transcript, checkpoint, workspace path, file contents) is visible through B's API, in B's
//      state folder or in what B's model is sent; B's agent cannot reach A's workspace by path, by search, by link or by shell;
//      and a second Hub cannot be started on A's state folder.
//   3. Credentials. A saved API key is encrypted on disk, never returned by an API, never logged, sent only to the endpoint it was
//      saved for, and gone from disk when the Hub stops using it.
// What it cannot prove, and says so: isolation between users INSIDE one Hub. There is no such feature (see the BLOCKED line).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { findNeedles, runScenario } from './e2e/harness.mjs';
import { answerApprovals, connectModel, setMode, startTask, waitForState } from './e2e/hub-process.mjs';
import { exists, makeCalcProject, read, slashes } from './e2e/fixtures.mjs';
import { call, sequence, shaOf } from './e2e/scenarios.mjs';

const NEEDLE_A = 'private-notes-of-user-A-7c1e9b52d048';
const FAKE_KEY = 'sk-isolation-KEY-4d2f8a6e1b9c3057';
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const containsText = (text, needle) => text.includes(needle) || text.includes(JSON.stringify(needle).slice(1, -1));

const rawStatus = async (hub, options) => {
  const response = await hub.rawRequest(options);
  return { status: response.status, headers: response.headers ?? {}, text: response.text };
};

await runScenario({
  name: 'isolation',
  summary: 'foreign Host/Origin/CSRF refused, loopback only, two Hubs cannot see each other, one state folder per Hub, saved API keys encrypted and sent only where they belong; multi-user isolation BLOCKED',
  budgetMs: 150_000,
}, async (t) => {
  // =========================================================================================================================
  // 2. Two Hubs (set up first because part 1 uses Hub A as well)
  // =========================================================================================================================
  const projectA = path.join(t.scratch, 'user-a', 'project-a');
  const stateA = path.join(t.scratch, 'user-a', 'state');
  const projectB = path.join(t.scratch, 'user-b', 'project-b');
  const stateB = path.join(t.scratch, 'user-b', 'state');
  makeCalcProject(projectA);
  fs.writeFileSync(path.join(projectA, 'notes.txt'), `${NEEDLE_A}\n`);
  makeCalcProject(projectB);
  const linkMade = (() => {
    try { fs.symlinkSync(projectA, path.join(projectB, 'link-to-a'), process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return false;
      throw error;
    }
  })();

  const modelA = await t.mock({
    scenario: 'work-a',
    scenarios: {
      'work-a': sequence([
        call('read_file', { path: 'notes.txt' }),
        call('read_file', { path: 'calc.js' }),
        (ctx) => call('edit_file', { path: 'calc.js', old_string: 'return a - b;', new_string: 'return a + b;', expected_sha256: shaOf(ctx.last) }),
        call('run_command', { command: 'node test.js' }),
      ], { final: 'Đã sửa calc.js.' }),
    },
  });
  const hubA = await t.hub({ project: projectA, stateDir: stateA, logName: 'hub-a.log' });
  await connectModel(hubA, modelA, { model: 'mock-coder' });
  await setMode(hubA, 'review');
  const promptA = 'Việc riêng của người dùng A: sửa add() và đọc notes.txt.';
  const taskA = await startTask(hubA, promptA);
  await answerApprovals(hubA, taskA.id, () => true);
  const checkpointsA = (await hubA.get('/api/studio/checkpoints')).json.map((item) => item.id);
  t.check(checkpointsA.length >= 1, 'A has a task, a transcript that holds A\'s private note, and checkpoints of its own');
  const snapshotA = { files: fs.readdirSync(projectA).sort().join(','), notes: read(projectA, 'notes.txt'), tasks: (await hubA.state()).agent.tasks.length };
  // Where A's Hub keeps A's conversation: a real file that B's agent will be sent after.
  const storeHits = findNeedles(stateA, [promptA]).hits;
  t.check(storeHits.length >= 1, 'A\'s own state folder holds A\'s conversation (so the attempts on it below aim at something real)', JSON.stringify(storeHits));
  const storeOfA = path.join(stateA, storeHits[0]?.file ?? 'hub-state.json');

  const attacks = [
    { label: 'read A\'s file by absolute path', tool: 'read_file', args: { path: path.join(projectA, 'notes.txt') }, expect: /outside_workspace/ },
    { label: 'list A\'s folder', tool: 'list_directory', args: { path: projectA }, expect: /outside_workspace/ },
    { label: 'list ../project-a', tool: 'list_directory', args: { path: '../../user-a/project-a' }, expect: /outside_workspace/ },
    { label: 'search in A\'s folder', tool: 'search_files', args: { pattern: 'private', path: projectA }, expect: /outside_workspace/ },
    { label: 'write into A\'s folder', tool: 'write_file', args: { path: path.join(projectA, 'pwned.txt'), content: 'x' }, expect: 'asks' },
    { label: 'cat A\'s file (shell)', tool: 'run_command', args: { command: `cat ${slashes(path.join(projectA, 'notes.txt'))}` }, expect: 'asks' },
    { label: 'read A\'s conversation store in A\'s state folder', tool: 'read_file', args: { path: storeOfA }, expect: /outside_workspace/ },
    { label: 'cat A\'s conversation store (shell)', tool: 'run_command', args: { command: `cat ${slashes(storeOfA)}` }, expect: 'asks' },
    { label: 'ls .. (shell)', tool: 'run_command', args: { command: 'ls ../..' }, expect: 'asks' },
    ...(linkMade ? [{ label: 'read through a link that points into A', tool: 'read_file', args: { path: 'link-to-a/notes.txt' }, expect: /symlink_escape/ }] : []),
  ];
  const resultsB = [];
  const askedB = new Map();
  let currentB = -1;
  const modelB = await t.mock({
    scenario: 'attack-a',
    scenarios: {
      'attack-a': sequence(attacks.map((attack, index) => () => { currentB = index; return call(attack.tool, attack.args); }), { final: 'Xong.', onResult: (index, text) => { resultsB[index] = text; } }),
    },
  });
  // Only what B could not know unless something leaked: the CONTENT of A's data (its private note and its request). A's folder
  // names and task id are not needles after this point: B's scripted model writes them into its own attempts (a path into A's
  // state folder contains A's task id), and the Hub repeats them in the refusal and in B's transcript.
  modelB.watch([NEEDLE_A, promptA]);
  const hubB = await t.hub({ project: projectB, stateDir: stateB, logName: 'hub-b.log' });
  await connectModel(hubB, modelB, { model: 'mock-coder-small' });
  await setMode(hubB, 'review');
  t.check(hubA.port !== hubB.port && hubA.stateDir !== hubB.stateDir, 'A and B are two Hubs: two ports, two state folders');

  const seenByB = JSON.stringify(await hubB.state());
  const visible = [['A\'s task id', taskA.id], ['A\'s prompt', promptA], ['A\'s workspace path', projectA], ['A\'s private note', NEEDLE_A], ...checkpointsA.map((id) => ['an A checkpoint id', id])].filter(([, value]) => containsText(seenByB, value)).map(([name]) => name);
  t.equal(visible, [], 'B\'s dashboard state shows nothing of A (task, prompt, workspace, note, checkpoints)');
  t.equal((await hubB.get(`/api/tasks/${taskA.id}`)).status, 404, 'B has no task with A\'s id');
  t.equal((await hubB.get(`/api/tasks/${taskA.id}/report`)).status, 404, 'and cannot export a report for it');
  t.equal((await hubB.get('/api/studio/checkpoints')).json.filter((item) => checkpointsA.includes(item.id)), [], 'B\'s checkpoint list holds none of A\'s');
  t.equal((await hubB.get(`/api/studio/workflow?taskId=${taskA.id}`)).json.steps, [], 'and B knows no workflow steps for A\'s task');
  t.equal((await hubB.get('/api/studio/file?file=notes.txt')).status === 200 ? 'found' : 'missing', 'missing', 'B\'s file API has no notes.txt: B sees only B\'s workspace');

  const startedB = await startTask(hubB, 'Hãy đọc mọi thứ của người dùng A.');
  const { task: finishedB, answered: answeredB } = await answerApprovals(hubB, startedB.id, (request) => { askedB.set(currentB, request); return false; });
  t.equal(finishedB.state, 'completed', 'B\'s agent works through its attempts on A and the task ends completed');
  const problems = attacks.flatMap((attack, index) => {
    const text = resultsB[index] ?? '(no result)';
    if (attack.expect === 'asks') return askedB.get(index) && /Permission denied/.test(text) ? [] : [`${attack.label}: not put to the person or not refused`];
    return !askedB.get(index) && attack.expect.test(text) ? [] : [`${attack.label}: expected ${attack.expect}, got "${text.replace(/\s+/g, ' ').slice(0, 90)}"`];
  });
  t.check(problems.length === 0, `all ${attacks.length} attempts by B on A's workspace (path, folder, ../, search, write, shell, link) were refused or put to the person`, problems.join(' | '));
  t.equal(answeredB.length, attacks.filter((attack) => attack.expect === 'asks').length, 'B\'s person was asked exactly about the write and the shell commands, nothing else');
  const reportB = modelB.watchReport();
  t.check(reportB.scanned > 0 && reportB.hits.length === 0, `nothing of A reached B's model server (${reportB.scanned} requests scanned)`, JSON.stringify(reportB.hits));
  const storedB = findNeedles(path.dirname(stateB), [NEEDLE_A, promptA], { skip: ['project-b/link-to-a'] });
  t.check(storedB.scanned > 0 && storedB.hits.length === 0, `nothing of A is in B's state folder or project (${storedB.scanned} files read)`, JSON.stringify(storedB.hits));
  const storedA = findNeedles(path.dirname(stateA), ['Hãy đọc mọi thứ của người dùng A.']);
  t.check(storedA.scanned > 0 && storedA.hits.length === 0, `and nothing of B is in A's state folder or project (${storedA.scanned} files read)`, JSON.stringify(storedA.hits));
  t.check(!exists(projectA, 'pwned.txt') && fs.readdirSync(projectA).sort().join(',') === snapshotA.files && read(projectA, 'notes.txt') === snapshotA.notes, 'A\'s project is exactly as it was');
  t.equal((await hubA.state()).agent.tasks.length, snapshotA.tasks, 'and A\'s Hub has the same tasks as before');

  let second = null;
  try { second = await t.hub({ project: projectA, stateDir: stateA, logName: 'hub-a2.log' }); } catch (error) { second = error; }
  t.check(second instanceof Error && /đang giữ cấu hình này/.test(second.message), 'a second Hub cannot be started on A\'s state folder: it refuses and names the running one', second instanceof Error ? second.message.slice(0, 160) : 'it started');
  t.equal((await hubA.get('/api/health')).json?.initialized, true, 'and A\'s Hub is unaffected');

  // =========================================================================================================================
  // 1. The door (Hub A)
  // =========================================================================================================================
  const modeBefore = (await hubA.state()).studio.permissions.mode;
  const refusals = [
    ['a page served from another host (Host: evil.example)', { headers: { Host: 'evil.example' } }],
    ['the wrong port in the Host header', { headers: { Host: '127.0.0.1:1' } }],
    ['a GET from a foreign Origin', { headers: { Origin: 'http://evil.example' } }],
    ['a CORS preflight from a foreign Origin', { method: 'OPTIONS', route: '/api/studio/permissions/config', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } }],
    ['a GET from the origin of a browser extension (only the legacy pairing routes are open to extensions)', { headers: { Origin: EXTENSION_ORIGIN } }],
  ];
  for (const [label, options] of refusals) {
    // A valid secret does not make a foreign Host or Origin acceptable: the inner layers stay in force.
    const response = await rawStatus(hubA, { route: '/api/state', ...options, headers: { ...hubA.authHeaders, ...options.headers } });
    t.check(response.status === 403 && !('access-control-allow-origin' in response.headers) && !response.text.includes('csrfToken'), `refused (403, no CORS grant, no token leaked): ${label}`, `${response.status}`);
  }
  const accepted = await rawStatus(hubA, { route: '/api/state', headers: { ...hubA.authHeaders, Host: `localhost:${hubA.port}` } });
  t.check(accepted.status === 200, 'control: the same GET with Host localhost:<port> is answered');
  // The outer layer: a caller without the secret gets nothing from any API route, however well it imitates the page.
  const ownOrigin = { origin: hubA.origin, 'x-chatmcp-request': 'local-dashboard' };
  const unauthenticated = [
    ['no Authorization header', {}],
    ["the page's own Origin and marker but no secret", ownOrigin],
    ['a wrong secret', { authorization: `Bearer ${'0'.repeat(64)}` }],
    ['the right secret in the wrong scheme', { authorization: `Basic ${hubA.secret}` }],
    ['a secret of the wrong length', { authorization: `Bearer ${hubA.secret.slice(1)}` }],
  ];
  for (const [label, headers] of unauthenticated) {
    const response = await rawStatus(hubA, { route: '/api/state', headers });
    t.check(response.status === 401 && !response.text.includes('csrfToken') && !response.text.includes(hubA.secret), `refused (401, no token leaked): ${label}`, `${response.status}`);
  }
  const queryAttempt = await rawStatus(hubA, { route: `/api/state?access_token=${hubA.secret}&token=${hubA.secret}` });
  t.equal(queryAttempt.status, 401, 'the secret is not accepted in a query string (it would end up in logs and history)');

  const token = await hubA.csrfToken();
  const body = JSON.stringify({ mode: 'autonomous' });
  const json = { 'content-type': 'application/json' };
  const forged = [
    ['a POST with the page Origin, marker and CSRF token but no bearer', { ...json, origin: hubA.origin, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': token }, 401, false],
    ['a POST without Origin', { ...json, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': token }, 403],
    ['a POST from a foreign Origin', { ...json, origin: 'http://evil.example', 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': token }, 403],
    ['a POST from a browser-extension origin, even with a valid token', { ...json, origin: EXTENSION_ORIGIN, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': token }, 403],
    ['a POST without the dashboard marker header', { ...json, origin: hubA.origin, 'x-chatmcp-csrf': token }, 403],
    ['a POST without the CSRF token', { ...json, origin: hubA.origin, 'x-chatmcp-request': 'local-dashboard' }, 403],
    ['a POST with a wrong CSRF token', { ...json, origin: hubA.origin, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': 'f'.repeat(token.length) }, 403],
    ['a POST whose body is not declared JSON (a form or text/plain "simple request")', { 'content-type': 'text/plain', origin: hubA.origin, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': token }, 415],
  ];
  for (const [label, headers, wanted, withBearer = true] of forged) {
    const response = await rawStatus(hubA, { method: 'POST', route: '/api/studio/permissions/config', headers: withBearer ? { ...hubA.authHeaders, ...headers } : headers, body });
    t.equal(response.status, wanted, `refused: ${label}`);
  }
  t.equal((await hubA.state()).studio.permissions.mode, modeBefore, `none of those changed anything: the permission mode is still ${modeBefore}`);
  const valid = await hubA.request('POST', '/api/studio/permissions/config', { mode: 'readonly' });
  t.check(valid.ok && (await hubA.state()).studio.permissions.mode === 'readonly', 'control: the same POST with the page\'s own headers and token works');
  await setMode(hubA, modeBefore);

  const page = await rawStatus(hubA, { route: '/' });
  const policy = String(page.headers['content-security-policy'] ?? '');
  t.check(/frame-ancestors 'none'/.test(policy) && /object-src 'none'/.test(policy) && /base-uri 'none'/.test(policy) && !/unsafe-inline|unsafe-eval/.test(policy) && /script-src 'self'/.test(policy), 'the page is served with a strict CSP (no inline script or eval, not frameable, no plugins)', policy.slice(0, 200));
  t.check(page.headers['x-content-type-options'] === 'nosniff' && page.headers['referrer-policy'] === 'no-referrer' && page.headers['cache-control'] === 'no-store', 'and with nosniff, no-referrer and no-store');
  const traversal = await rawStatus(hubA, { route: '/api/studio/file?file=../../../../etc/hosts', headers: hubA.authHeaders });
  t.check(traversal.status === 403 && /outside_workspace/.test(traversal.text), 'the file API refuses a path that leaves the workspace');
  const addresses = Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address);
  if (addresses.length) {
    const outcome = await new Promise((resolve) => {
      const request = http.get({ host: addresses[0], port: hubA.port, path: '/api/health', timeout: 4000 }, (response) => { response.resume(); resolve(`answered ${response.statusCode}`); });
      request.on('error', (error) => resolve(error.code ?? error.message));
      request.on('timeout', () => { request.destroy(); resolve('timeout'); });
    });
    t.check(['ECONNREFUSED', 'timeout', 'EHOSTUNREACH', 'ENETUNREACH'].includes(outcome), 'the Hub does not listen on the machine\'s network address: loopback only', `connecting to ${addresses[0]} gave ${outcome}`);
  } else t.note('this machine has no non-loopback IPv4 address; the loopback-only check was skipped');

  // =========================================================================================================================
  // 3. Credentials
  // =========================================================================================================================
  const stateC = path.join(t.scratch, 'user-c', 'state');
  const projectC = path.join(t.scratch, 'user-c', 'project-c');
  makeCalcProject(projectC);
  const endpointOne = await t.mock({ scenario: 'explore' });
  const endpointTwo = await t.mock({ scenario: 'explore' });
  const hubC = await t.hub({ project: projectC, stateDir: stateC, logName: 'hub-c.log' });
  const configured = await hubC.post('/api/ai/config', { preset: 'custom-openai', apiBaseUrl: endpointOne.url, model: 'mock-coder', apiKey: FAKE_KEY, remember: true });
  t.equal(configured.ai.keySource, 'saved', 'the key is saved');
  t.check(['windows-dpapi', 'aes-gcm'].includes(configured.ai.secretStorage?.kind) && configured.ai.secretStorage?.persistent === true, `in an encrypted store (${configured.ai.secretStorage?.kind}: Windows DPAPI, or AES-256-GCM elsewhere)`, JSON.stringify(configured.ai.secretStorage));
  const checked = await hubC.post('/api/ai/test', {});
  t.check(checked.ok !== false && endpointOne.state.requests.length > 0 && endpointOne.state.requests.every((entry) => entry.hasAuthorization), 'and it is sent to the endpoint it was saved for', JSON.stringify({ n: endpointOne.state.requests.length }));
  const places = [['the /api/ai/config response', JSON.stringify(configured)], ['the /api/ai/test response', JSON.stringify(checked)], ['the dashboard state', JSON.stringify(await hubC.state())], ['the presets list', (await hubC.get('/api/ai/presets')).text], ['the Hub log', hubC.logText()]].filter(([, text]) => containsText(text, FAKE_KEY)).map(([name]) => name);
  t.equal(places, [], 'the key appears in no API response and not in the Hub log');
  const onDisk = findNeedles(stateC, [FAKE_KEY]);
  const keyFiles = [];
  (function walk(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) walk(full); else if (/key|secret/i.test(entry.name)) keyFiles.push(full); } })(stateC);
  t.check(onDisk.scanned > 0 && onDisk.hits.length === 0 && keyFiles.length >= 1, `the key is not in any file of the state folder in plain text (${onDisk.scanned} files read); it is stored encrypted`, JSON.stringify(onDisk.hits));
  if (process.platform !== 'win32') {
    const loose = keyFiles.filter((file) => (fs.statSync(file).mode & 0o077) !== 0);
    t.equal(loose, [], 'and the files that hold it are readable by their owner only (mode 600)');
  }
  const taskC = await startTask(hubC, 'Dự án này có gì?');
  await waitForState(hubC, taskC.id, ['completed', 'failed']);
  const transcriptC = JSON.stringify(await hubC.task(taskC.id)) + (await hubC.get(`/api/tasks/${taskC.id}/report`)).text;
  t.check(!containsText(transcriptC, FAKE_KEY), 'it is not in a task transcript or report either');

  await hubC.stop();
  const hubC2 = await t.hub({ project: projectC, stateDir: stateC, logName: 'hub-c2.log' });
  endpointOne.state.requests.length = 0;
  t.equal((await hubC2.state()).ai.keySource, 'saved', 'after a restart the saved key is found again');
  await hubC2.post('/api/ai/test', {});
  t.check(endpointOne.state.requests.length > 0 && endpointOne.state.requests.every((entry) => entry.hasAuthorization), 'and still used for the same endpoint');

  const moved = await hubC2.post('/api/ai/config', { preset: 'custom-openai', apiBaseUrl: endpointTwo.url, model: 'mock-coder' });
  t.equal(moved.ai.keySource, 'none', 'pointing the Hub at a different endpoint does not carry the key along');
  await hubC2.post('/api/ai/test', {});
  t.check(endpointTwo.state.requests.length > 0 && endpointTwo.state.requests.every((entry) => !entry.hasAuthorization), 'the other endpoint received requests without any Authorization header', JSON.stringify(endpointTwo.state.requests.map((entry) => entry.hasAuthorization)));
  const leftover = [];
  (function walk(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) walk(full); else if (/gateway-key/i.test(entry.name)) leftover.push(entry.name); } })(stateC);
  t.equal(leftover, [], 'and the saved key was removed from disk, because the Hub no longer uses it');

  await hubC2.post('/api/ai/config', { preset: 'custom-openai', apiBaseUrl: endpointTwo.url, model: 'mock-coder', apiKey: FAKE_KEY, remember: true });
  const cleared = await hubC2.post('/api/ai/clear-key', {});
  t.equal(cleared.ai.keySource, 'none', 'clearing the key works');
  t.equal(fs.readdirSync(path.join(stateC, 'gateway')).filter((name) => /gateway-key/i.test(name)), [], 'and leaves no key file behind');

  t.blocked('isolation between user A and user B inside ONE deployment', 'ChatMCP Hub is a single-user application: it has no accounts, no per-user workspace or process isolation and no microVM. Run one Hub per person, bound to loopback. Cloud Harness is not an isolation boundary either. A shared or multi-tenant service stays blocked until it has real VM/microVM isolation with evidence (docs/SECURITY.md).');
});
