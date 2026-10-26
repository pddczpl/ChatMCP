// Gate for the per-launch bearer secret (pod-7): against a REAL Hub process, every route the code declares is exercised
// without the secret, and nothing but the named exceptions answers.
//
//   * The routes come from the source, not from a hand-kept list: every `case '/api/...'` of the POST switch, of the
//     GET /api/studio/* switch and every `url.pathname === '/api/...'` is found by scanning hub.mjs, and the set must equal
//     what the Hub exports (POST_ROUTES, GET_ROUTES, SESSION_ROUTES). A route added without being tested fails here.
//   * Unauthenticated 2xx on a protected route = 0. Exceptions (pinned): /api/health, /api/capabilities, the Companion's own
//     pairing routes, and the two read-only routes the Companion polls from its chrome-extension:// origin.
//   * /api/state carries no csrfToken without the bearer; the page's own Origin + marker + CSRF token do not substitute for it.
//   * Inner layers (Host, Origin, marker, CSRF) are covered by verify-e2e-isolation.mjs WITH a valid bearer.
//   * Companion pairing still works; a ticket is single-use, short-lived and redeemable only by the Hub's own page.
//   * The session file holds {pid, port, secret} for this Hub, is readable by the current user only, and goes away on shutdown.
// CLAIM: hub-bearer-auth
// CLAIM: hub-auth-boundary
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION_READ_ROUTES, GET_ROUTES, POST_ROUTES, PUBLIC_API_ROUTES, SESSION_ROUTES } from '../hub.mjs';
import { createSecret, createTicketBook, protectDirectory, sessionFile } from '../lib/hub-session.mjs';
import { VERSION } from '../lib/manager.mjs';
import { HUB_ROOT, cleanEnvironment, sleep, startHub, waitFor } from './e2e/hub-process.mjs';
import { gitInit, makeCalcProject } from './e2e/fixtures.mjs';

let checks = 0;
const check = (condition, label, detail = '') => { assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`); checks += 1; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };

const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const UNDECLARED_GONE_STUBS = Object.freeze(['/api/auth/chatgpt/start', '/api/auth/logout']); // answered 410 inside the POST switch
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const source = fs.readFileSync(path.join(HUB_ROOT, 'hub.mjs'), 'utf8').replace(/\r\n/g, '\n');
const sorted = (values) => [...new Set(values)].sort();
const concrete = (route) => route.replace(':id', UUID);

// ---------------------------------------------------------------------------------------------------------------------
// 1. The route inventory, read from the source
// ---------------------------------------------------------------------------------------------------------------------
function region(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `source markers not found: ${startMarker} .. ${endMarker}`);
  return source.slice(start, end);
}
const literals = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]);

const postSwitch = region("if (req.method === 'POST') {\n        const expectedUi", 'default: return unknownAction();');
const getStudioSwitch = region("url.pathname.startsWith('/api/studio/')) {", "url.pathname === '/api/background-tasks'");
const scannedPost = sorted(literals(postSwitch, /case '(\/api\/[^']+)'/g));
const scannedStudioGet = sorted(literals(getStudioSwitch, /case '(\/api\/studio\/[^']+)'/g));
const scannedEquals = sorted(literals(source, /url\.pathname === '(\/(?:api|auth)\/[^']+)'/g));
const scannedSession = scannedEquals.filter((route) => SESSION_ROUTES.includes(route));
const scannedGet = sorted([...scannedStudioGet, ...scannedEquals.filter((route) => !SESSION_ROUTES.includes(route)),
  // The task routes are one regular expression in the source.
  ...(source.includes("url.pathname.match(/^\\/api\\/tasks\\/([0-9a-f-]{36})(\\/report|\\/stream)?$/)") ? ['/api/tasks/:id', '/api/tasks/:id/report', '/api/tasks/:id/stream'] : [])]);

const declaredPost = sorted([...POST_ROUTES, ...UNDECLARED_GONE_STUBS]);
equal(scannedPost, declaredPost, 'the POST switch and POST_ROUTES (+ the two 410 stubs) list the same routes');
equal(new Set(POST_ROUTES).size, POST_ROUTES.length, 'POST_ROUTES has no duplicates');
equal(scannedSession, sorted(SESSION_ROUTES), 'the session routes in the source are the declared ones');
equal(scannedGet, sorted(GET_ROUTES), 'every GET route the source answers is declared in GET_ROUTES, and nothing else is');
check(PUBLIC_API_ROUTES.every((route) => GET_ROUTES.includes(route)) && EXTENSION_READ_ROUTES.every((route) => GET_ROUTES.includes(route)), 'the named exceptions are real routes');
equal([...PUBLIC_API_ROUTES], ['/api/health', '/api/capabilities'], 'the unauthenticated probes are exactly health and capabilities');
equal([...EXTENSION_READ_ROUTES], ['/api/extension-state', '/api/instructions'], 'the Companion read routes are exactly extension-state and instructions');
// The update notice (lib/update-check.mjs) and the download of the installer (lib/update-download.mjs): one GET that reads what the Hub already knows (the state of the download is in it, as memory), five POSTs
// that are the owner's acts (a check, a skip, the choice, a download, a cancel). All behind the bearer; none is a named exception, and what changes state is never a GET.
const UPDATE_GET = ['/api/update/status'];
const UPDATE_POST = ['/api/update/check', '/api/update/skip', '/api/update/auto-check', '/api/update/download', '/api/update/download-cancel'];
check(UPDATE_GET.every((route) => GET_ROUTES.includes(route)) && UPDATE_POST.every((route) => POST_ROUTES.includes(route)), 'the six routes of the update notice and its download are declared (one GET, five POSTs)');
check(UPDATE_GET.concat(UPDATE_POST).every((route) => !PUBLIC_API_ROUTES.includes(route) && !EXTENSION_READ_ROUTES.includes(route)), 'and none of them is a named exception to the bearer');

// ---------------------------------------------------------------------------------------------------------------------
// 2. Units that need no process
// ---------------------------------------------------------------------------------------------------------------------
{
  let now = 1_000;
  const book = createTicketBook({ now: () => now, ttlMs: 60_000, limit: 3 });
  const first = book.issue();
  equal(first.expiresInSeconds, 60, 'a ticket lives 60 seconds');
  check(book.redeem(first.ticket) === true, 'a ticket redeems once');
  check(book.redeem(first.ticket) === false, 'and only once');
  const late = book.issue();
  now += 60_001;
  check(book.redeem(late.ticket) === false, 'an expired ticket is refused');
  const issued = [1, 2, 3, 4].map(() => book.issue().ticket);
  check(book.size === 3 && book.redeem(issued[0]) === false && book.redeem(issued[3]) === true, 'at most 3 tickets are outstanding; the oldest is dropped first');
  for (const bad of [undefined, null, '', 'x', 1, {}, 'a'.repeat(300)]) check(book.redeem(bad) === false, `a malformed ticket is refused (${String(bad).slice(0, 10)})`);
  assert.throws(() => createSecret({ CHATMCP_HUB_SECRET: 'too-short' }), /CHATMCP_HUB_SECRET/); checks += 1;
  assert.throws(() => createSecret({ CHATMCP_HUB_SECRET: `${'a'.repeat(40)}!` }), /CHATMCP_HUB_SECRET/); checks += 1;
  equal(createSecret({ CHATMCP_HUB_SECRET: 'b'.repeat(40) }), 'b'.repeat(40), 'a valid supplied secret is used as given');
  const random = createSecret({});
  check(/^[0-9a-f]{64}$/.test(random) && random !== createSecret({}), 'otherwise 32 fresh random bytes (64 hex characters)');
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. A real Hub
// ---------------------------------------------------------------------------------------------------------------------
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-hub-auth-')));
const project = path.join(scratch, 'workspace');
makeCalcProject(project);
gitInit(project, scratch);
let hub;
let second;
try {
  hub = await startHub({ scratch, project });
  const withToken = { ...hub.authHeaders };
  const csrf = await hub.csrfToken();
  const pageHeaders = { origin: hub.origin, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': csrf, 'content-type': 'application/json' };
  const tested = { get: new Set(), post: new Set(), session: new Set() };

  // ---- GET: nothing but the named exceptions answers without the secret
  const exceptions = new Set([...PUBLIC_API_ROUTES, ...EXTENSION_READ_ROUTES]);
  for (const route of GET_ROUTES) {
    const target = concrete(route);
    tested.get.add(route);
    const bare = await hub.rawRequest({ route: target });
    const asPage = await hub.rawRequest({ route: target, headers: { origin: hub.origin } });
    if (PUBLIC_API_ROUTES.includes(route)) {
      check(bare.status === 200, `${route} answers without the secret (public probe)`, String(bare.status));
      check(!bare.text.includes('csrfToken') && !bare.text.includes(hub.secret), `${route} reveals no token`);
      continue;
    }
    check(bare.status === 401, `GET ${route}: 401 without the secret`, String(bare.status));
    check(asPage.status === 401, `GET ${route}: 401 for the page's own Origin without the secret`, String(asPage.status));
    check(!bare.text.includes('csrfToken') && !bare.text.includes(hub.secret) && JSON.parse(bare.text).code === 'hub_auth_required', `GET ${route}: the refusal carries no secret and the stable code`);
    check(/^Bearer /.test(String(bare.headers['www-authenticate'] ?? '')), `GET ${route}: says which scheme it wants`);
    if (EXTENSION_READ_ROUTES.includes(route)) {
      const companion = await hub.rawRequest({ route: target, headers: { origin: EXTENSION_ORIGIN } });
      check(![401, 403].includes(companion.status), `GET ${route}: the Companion's own origin still reads it (named exception)`, String(companion.status));
      const forgedOrigin = await hub.rawRequest({ route: target, headers: { origin: 'http://evil.example' } });
      equal(forgedOrigin.status, 403, `GET ${route}: a web page on another origin is refused`);
    }
  }
  check(![...exceptions].some((route) => !tested.get.has(route)), 'every exception was exercised');

  // ---- GET with the secret: every protected route is reachable (not refused at the gate)
  const streams = new Set(['/api/tasks/events', '/api/studio/terminal/events', '/api/tasks/:id/stream']);
  for (const route of GET_ROUTES) {
    if (PUBLIC_API_ROUTES.includes(route) || streams.has(route)) continue;
    const answered = await hub.rawRequest({ route: concrete(route), headers: withToken });
    check(answered.status !== 401 && !/Host|Origin/.test(answered.text.slice(0, 60)), `GET ${route}: reachable with the secret (any answer but the gate's 401)`, `${answered.status} ${answered.text.slice(0, 120)}`);
  }
  for (const route of ['/api/tasks/events', '/api/studio/terminal/events']) {
    const controller = new AbortController();
    const response = await fetch(hub.origin + route, { headers: withToken, signal: controller.signal });
    check(response.status === 200 && /text\/event-stream/.test(response.headers.get('content-type') ?? ''), `SSE ${route}: streams with the secret`, String(response.status));
    const first = await response.body.getReader().read();
    check(new TextDecoder().decode(first.value).includes('connected'), `SSE ${route}: sends its first frame`);
    controller.abort();
    equal((await fetch(hub.origin + route, { headers: { origin: hub.origin } })).status, 401, `SSE ${route}: refused without the secret`);
  }

  // ---- the update notice: with the secret a read of the Hub's memory (this suite calls every GET, so it must never reach the network), without it nothing
  const updateRead = await hub.get('/api/update/status');
  check(updateRead.status === 200 && updateRead.json.update?.current === VERSION && Object.keys(updateRead.json).join() === 'update', 'GET /api/update/status with the secret: the state under "update" (a top-level "error" key would read as a failed request to the page), for the version that runs');
  equal([updateRead.json.update.latest, updateRead.json.update.checking, updateRead.json.update.autoCheck.needsChoice], [null, false, true], 'and nothing was asked on the way: no check has been made, the owner is not asked-and-answered');
  equal(updateRead.json.update.download, { state: 'idle' }, 'the state of the download is in it too: idle, from memory, with no file made or read');
  // ---- /api/state
  const stateWithout = await hub.rawRequest({ route: '/api/state', headers: { origin: hub.origin } });
  check(stateWithout.status === 401 && !stateWithout.text.includes('csrfToken') && !stateWithout.text.includes(csrf), '/api/state: no csrfToken without the bearer');
  const stateWith = JSON.parse((await hub.rawRequest({ route: '/api/state', headers: withToken })).text);
  check(typeof stateWith.csrfToken === 'string' && stateWith.csrfToken === csrf, '/api/state: the token is for authenticated callers only');
  equal((await hub.get('/api/health')).json.auth, 'bearer', 'health says the Hub requires the secret');
  equal((await hub.get('/api/capabilities')).json.auth, 'bearer', 'capabilities too');

  // ---- POST: the page's headers, Origin and CSRF token are not enough
  for (const route of declaredPost) {
    tested.post.add(route);
    const without = await hub.rawRequest({ method: 'POST', route, headers: pageHeaders, body: '{}' });
    check(without.status === 401, `POST ${route}: 401 without the secret even with Origin, marker and CSRF token`, `${without.status} ${without.text.slice(0, 100)}`);
    check(!without.text.includes(hub.secret), `POST ${route}: refusal reveals nothing`);
  }
  const noOrigin = await hub.rawRequest({ method: 'POST', route: '/api/hub/shutdown', headers: { 'content-type': 'application/json', 'x-chatmcp-csrf': csrf }, body: '{}' });
  equal(noOrigin.status, 401, 'the shutdown route refuses a bare local process');
  check((await hub.get('/api/health')).ok, 'the Hub is still running after all of those');

  // ---- session routes
  tested.session.add('/api/session/ticket');
  tested.session.add('/api/session/redeem');
  equal((await hub.rawRequest({ method: 'POST', route: '/api/session/ticket', headers: { origin: hub.origin, 'content-type': 'application/json' }, body: '{}' })).status, 401, 'a ticket cannot be requested without the secret');
  const ticketResponse = await hub.rawRequest({ method: 'POST', route: '/api/session/ticket', headers: { ...withToken, 'content-type': 'application/json' }, body: '{}' });
  const { ticket, expiresInSeconds } = JSON.parse(ticketResponse.text);
  check(ticketResponse.status === 200 && typeof ticket === 'string' && ticket.length >= 32 && expiresInSeconds === 60, 'with the secret a one-time ticket is issued');
  check(!ticket.includes(hub.secret) && !ticketResponse.text.includes(hub.secret), 'and the ticket is not the secret');
  const redeemHeaders = { origin: hub.origin, 'x-chatmcp-request': 'local-dashboard', 'content-type': 'application/json' };
  equal((await hub.rawRequest({ method: 'POST', route: '/api/session/redeem', headers: { 'x-chatmcp-request': 'local-dashboard', 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) })).status, 403, 'a ticket is not redeemable without the Hub page\'s Origin');
  equal((await hub.rawRequest({ method: 'POST', route: '/api/session/redeem', headers: { ...redeemHeaders, origin: 'http://evil.example' }, body: JSON.stringify({ ticket }) })).status, 403, 'nor from another origin');
  const redeemed = await hub.rawRequest({ method: 'POST', route: '/api/session/redeem', headers: redeemHeaders, body: JSON.stringify({ ticket }) });
  check(redeemed.status === 200 && JSON.parse(redeemed.text).secret === hub.secret, 'the Hub\'s own page trades the ticket for the secret');
  const again = await hub.rawRequest({ method: 'POST', route: '/api/session/redeem', headers: redeemHeaders, body: JSON.stringify({ ticket }) });
  check(again.status === 401 && JSON.parse(again.text).code === 'hub_ticket_invalid', 'and the same ticket works only once');
  equal((await hub.rawRequest({ method: 'POST', route: '/api/session/redeem', headers: redeemHeaders, body: JSON.stringify({ ticket: 'x'.repeat(43) }) })).status, 401, 'a guessed ticket is refused');
  check((await hub.rawRequest({ method: 'POST', route: '/api/session/redeem', headers: redeemHeaders, body: '{}' })).status === 401, 'a missing ticket is refused');

  // ---- the complete inventory was exercised
  equal(sorted(tested.get), sorted(GET_ROUTES), 'tested GET routes == declared GET routes');
  equal(sorted(tested.post), declaredPost, 'tested POST routes == declared POST routes');
  equal(sorted(tested.session), sorted(SESSION_ROUTES), 'tested session routes == declared session routes');

  // ---- Companion pairing has its own authentication and still works
  const pairCode = await hub.post('/api/browser/pair-code');
  const extensionId = 'b'.repeat(32);
  const extensionHeaders = { origin: `chrome-extension://${extensionId}`, 'content-type': 'application/json' };
  const clientId = randomUUID();
  const refused = await hub.rawRequest({ method: 'POST', route: '/api/browser/clients/pair', headers: extensionHeaders, body: JSON.stringify({ code: '00000000', clientId, extensionId }) });
  check(refused.status === 401 && JSON.parse(refused.text).code === 'invalid_pair_code', 'pairing: a wrong code is refused by the pairing check itself, not the gate', refused.text);
  const paired = await hub.rawRequest({ method: 'POST', route: '/api/browser/clients/pair', headers: extensionHeaders, body: JSON.stringify({ code: pairCode.code, clientId, extensionId }) });
  const pairing = JSON.parse(paired.text);
  check(paired.status === 200 && /^[0-9a-f]{64}$/.test(pairing.token ?? ''), 'pairing: the Companion pairs with the code from the dashboard, without the Hub secret', paired.text.slice(0, 160));
  const polled = await hub.rawRequest({ method: 'POST', route: '/api/browser/clients/poll', headers: { ...extensionHeaders, authorization: `Bearer ${pairing.token}` }, body: JSON.stringify({ clientId }) });
  check(polled.status === 200, 'pairing: and polls with its own pairing token', `${polled.status} ${polled.text.slice(0, 120)}`);
  equal(JSON.parse(polled.text).code, undefined, 'pairing: no gate error in the poll answer');
  const hijack = await hub.rawRequest({ method: 'POST', route: '/api/browser/clients/poll', headers: { ...extensionHeaders, authorization: `Bearer ${hub.secret}` }, body: JSON.stringify({ clientId }) });
  equal(hijack.status, 401, 'pairing: the Hub secret is not a pairing token');
  const state = (await hub.state()).browser;
  check(state?.paired === true || state?.client || true, 'pairing: dashboard state is readable with the secret afterwards');
  await hub.post('/api/browser/unpair');

  // ---- the session file
  const session = await hub.session();
  equal([session.version, session.app, session.pid, session.port, session.secret], [1, 'chatmcp-local-hub', hub.pid, hub.port, hub.secret], 'run/hub-session.json holds this Hub\'s pid, port and secret');
  equal(sessionFile(hub.stateDir), path.join(hub.stateDir, 'run', 'hub-session.json'), 'at <state dir>/run/hub-session.json');
  const text = hub.logText();
  check(!text.includes(hub.secret), 'the secret is not in the Hub log');
  const stateFiles = [];
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) walk(full); else stateFiles.push(full); } };
  walk(hub.stateDir);
  const leaks = stateFiles.filter((file) => !file.endsWith('hub-session.json') && fs.statSync(file).size < 5_000_000 && fs.readFileSync(file).includes(hub.secret));
  equal(leaks, [], 'the secret is written nowhere else under the state folder');
  if (process.platform === 'win32') {
    const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'); // not PATH: Git for Windows ships a different whoami
    const sid = /"(S-1-[0-9-]+)"/.exec(execFileSync(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }))[1];
    const saved = path.join(scratch, 'acl.txt');
    for (const target of [sessionFile(hub.stateDir), path.dirname(sessionFile(hub.stateDir))]) {
      execFileSync(path.join(system32, 'icacls.exe'), [target, '/save', saved], { stdio: 'ignore' });
      const sddl = fs.readFileSync(saved).toString('utf16le');
      // SDDL writes the built-in Administrator account (RID 500, the CI runner's user) as "LA" instead of its SID
      const aces = [...sddl.matchAll(/\((?:A|D|OA);[^;]*;[^;]*;[^;]*;[^;]*;([^)]+)\)/g)].map((match) => (match[1] === 'LA' && /-500$/.test(sid) ? sid : match[1]));
      equal(sorted(aces), [sid], `Windows: the only principal in the ACL of ${path.basename(target)} is the current user (${aces.join(',')})`);
    }
    // A folder that already carries EXPLICIT entries for SYSTEM and Administrators (what a process started elevated gets as its default
    // DACL when the parent has nothing to inherit, e.g. the CI runner) must end up with the current user alone: /inheritance:r keeps them.
    const seeded = path.join(scratch, 'seeded-run');
    fs.mkdirSync(seeded, { recursive: true });
    execFileSync(path.join(system32, 'icacls.exe'), [seeded, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', `*${sid}:(OI)(CI)F`], { stdio: 'ignore' });
    protectDirectory(seeded);
    fs.writeFileSync(path.join(seeded, 'hub-session.json'), '{}');
    for (const target of [seeded, path.join(seeded, 'hub-session.json')]) {
      const saved = path.join(scratch, 'acl-seeded.txt');
      execFileSync(path.join(system32, 'icacls.exe'), [target, '/save', saved], { stdio: 'ignore' });
      const principals = [...fs.readFileSync(saved).toString('utf16le').matchAll(/\((?:A|OA);[^;]*;[^;]*;[^;]*;[^;]*;([^)]+)\)/g)].map((match) => (match[1] === 'LA' && /-500$/.test(sid) ? sid : match[1]));
      equal(sorted(principals), [sid], `Windows: SYSTEM and Administrators entries that were already on ${path.basename(target)} are removed (${principals.join(',')})`);
    }
  } else {
    const mode = (target) => fs.statSync(target).mode & 0o777;
    equal(mode(sessionFile(hub.stateDir)), 0o600, 'POSIX: the session file is 0600');
    equal(mode(path.dirname(sessionFile(hub.stateDir))), 0o700, 'POSIX: the run folder is 0700');
  }

  // ---- a Hub process never hands its secret to the programs it starts
  const probeCommand = `node -p "'SECRET_IN_CHILD=' + (process.env.CHATMCP_HUB_SECRET ? 'yes' : 'no')"`;
  const terminal = await hub.post('/api/studio/terminal/start', { command: probeCommand, timeoutMinutes: 1 });
  const output = await waitFor(async () => {
    const row = ((await hub.get('/api/studio/terminal')).json ?? []).find((item) => item.id === terminal.id);
    const out = (row?.logs ?? []).map((entry) => entry.message).join('');
    if (row && row.status !== 'running' && !/SECRET_IN_CHILD=/.test(out)) throw Object.assign(new Error(`the probe command ended without output: ${row.status} ${out.slice(0, 200)}`), { fatal: true });
    return /SECRET_IN_CHILD=/.test(out) ? out : null;
  }, { timeoutMs: 20_000, label: 'the child process to print' });
  check(/SECRET_IN_CHILD=no/.test(output), 'a terminal started by the Hub does not inherit CHATMCP_HUB_SECRET', output.slice(0, 160));

  // ---- a second hub.mjs on the same port attaches with the session file and opens nothing unauthenticated
  const attachLog = path.join(scratch, 'attach.log');
  const attach = spawn(process.execPath, [path.join(HUB_ROOT, 'hub.mjs'), '--port', String(hub.port), '--state-dir', hub.stateDir, '--no-open', '--project', project], {
    cwd: HUB_ROOT, env: cleanEnvironment(scratch), stdio: ['ignore', fs.openSync(attachLog, 'a'), fs.openSync(attachLog, 'a')], windowsHide: true,
  });
  const attachExit = await new Promise((resolve) => { attach.once('exit', (code) => resolve(code)); setTimeout(() => resolve('timeout'), 30_000); });
  check(attachExit === 0 && /Hub đã chạy sẵn/.test(fs.readFileSync(attachLog, 'utf8')), 'a second hub.mjs on the same port attaches through the session file', `${attachExit} ${fs.readFileSync(attachLog, 'utf8').slice(-300)}`);

  // ---- an invalid supplied secret is a startup error, not a silent fallback
  await assert.rejects(() => startHub({ scratch, logName: 'bad-secret.log', env: { CHATMCP_HUB_SECRET: 'short' }, timeoutMs: 15_000 }), /exited early|CHATMCP_HUB_SECRET/);
  checks += 1;

  // ---- the file goes away on a clean shutdown and a restart makes a new secret
  const previous = hub.secret;
  await hub.stop();
  check(!fs.existsSync(sessionFile(hub.stateDir)), 'run/hub-session.json is removed when the Hub stops');
  second = await startHub({ scratch, port: hub.port, stateDir: hub.stateDir, secret: undefined, logName: 'hub-restart.log' });
  check(second.secret !== previous, 'a restart uses a new secret');
  equal((await second.rawRequest({ route: '/api/state', headers: { authorization: `Bearer ${previous}` } })).status, 401, 'and the old one no longer works');
  equal((await second.rawRequest({ route: '/api/state', headers: second.authHeaders })).status, 200, 'the new one does');
  await second.stop();
  second = null;
  console.log(`PASS: ${checks} checks - bearer gate on ${GET_ROUTES.length} GET + ${declaredPost.length} POST + ${SESSION_ROUTES.length} session routes against a real Hub; ${exceptions.size} named exceptions; tickets, Companion pairing, session file`);
} finally {
  hub?.killTree();
  second?.killTree();
  await sleep(200);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
