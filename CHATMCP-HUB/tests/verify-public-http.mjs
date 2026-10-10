// Public mode over real HTTP: what a visitor on the Internet can and cannot do before and after logging in.
//
// The Hub is started in-process with the real createHubServer and the real public gate; only the clock of the login sessions is fake.
// Requests are made with node:http so that Host, X-Forwarded-* and Origin can be forged the way an attacker would forge them.
// A second part starts `node hub.mjs` with unsafe environments and checks that the Hub refuses to start (and says nothing secret).
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHubServer, POST_ROUTES } from '../hub.mjs';
import { VERSION } from '../lib/manager.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { PermissionGate } from '../lib/permissions.mjs';
import { StudioTerminal } from '../lib/studio-terminal.mjs';
import { CodeIntelligence } from '../lib/studio-intelligence.mjs';
import { previewStatus } from '../lib/studio-preview.mjs';
import { resolvePublicConfig } from '../lib/public-config.mjs';
import { OwnerAuth } from '../lib/auth.mjs';
import { createPublicGate, PUBLIC_POST_ROUTES } from '../lib/public-gate.mjs';

const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };
let currentSection = '';
async function section(title, body) { currentSection = title; const before = checks; const started = Date.now(); await body(); console.log(`  ok  ${title} (${checks - before} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`); }

const OWNER_TOKEN = 'Kq7vX2mZpL9wTn4RfYb8HcJd3SgUe6Aa5NxVo1Mi';
const HOST = 'hub.example.test';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-public-http-'));
const repo = path.join(temp, 'repo');
await fs.mkdir(repo);
await fs.writeFile(path.join(repo, 'a.txt'), 'hello\n');

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

function request(port, { method = 'GET', pathname = '/', headers = {}, body, host = HOST, proto = 'https', raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const sent = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)); // undefined means "leave this header out"
    if (host !== null) sent.host = host;
    if (proto) sent['x-forwarded-proto'] = proto;
    let payload = body;
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) { payload = JSON.stringify(body); sent['content-type'] ??= 'application/json'; }
    if (payload !== undefined) sent['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: sent, setHost: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (!raw && /json/.test(res.headers['content-type'] ?? '')) { try { json = JSON.parse(text); } catch { /* left null */ } }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request timed out')));
    req.end(payload);
  });
}

// ------------------------------------------------------------------------------------------------ servers under test
const port = await freePort();
const config = resolvePublicConfig({
  CHATMCP_PUBLIC: '1', CHATMCP_OWNER_TOKEN: OWNER_TOKEN, CHATMCP_ALLOWED_HOSTS: HOST, CHATMCP_TRUSTED_PROXY_HOPS: '1',
  CHATMCP_LOGIN_MAX_FAILURES_PER_IP: '3', CHATMCP_LOGIN_MAX_FAILURES_GLOBAL: '8', CHATMCP_LOGIN_FAILURE_DELAY_MS: '0',
  CHATMCP_WORKSPACES_ROOT: path.join(temp, 'workspaces'), CHATMCP_EXEC_MODE: 'no-shell', CHATMCP_SESSION_IDLE_SECONDS: '600', CHATMCP_SESSION_MAX_SECONDS: '3600',
}, { port });
let clock = 1_800_000_000_000;
const auth = new OwnerAuth({ token: config.ownerToken, cookie: config.cookie, session: config.session, login: config.login, trustedProxyHops: config.trustedProxyHops, now: () => clock });
let initialized = true;
const gate = createPublicGate({ config, auth, bundleRoot: hubRoot, isInitialized: () => initialized });

const makeManager = (dir) => {
  const manager = { workspace: repo, secrets: [], log: () => {}, backend: 'local', catalog: { ready: false, tools: [], counts: {} },
    state: () => ({ version: VERSION, backend: 'local', workspace: { path: repo }, services: { local: { state: 'ready' } } }),
    selectWorkspace: async () => {}, browse: async () => ({ path: null }), openVsCode: async () => ({ ok: true }) };
  manager.studio = new StudioWorkspace({ manager, directory: path.join(dir, 'studio') });
  manager.permissions = new PermissionGate({ manager, workspace: manager.studio, directory: path.join(dir, 'policy') });
  manager.terminal = new StudioTerminal({ workspace: manager.studio });
  manager.intelligence = new CodeIntelligence({ workspace: manager.studio, directory: path.join(dir, 'index') });
  manager.preview = previewStatus;
  return manager;
};
const calls = [];
const fakeWorkspaces = {
  summary: () => ({ max: 3, count: 0, pushEnabled: false }),
  list: async () => ({ workspaces: [] }),
  exportArchive: async (res) => { res.writeHead(200, { 'Content-Type': 'application/gzip' }); res.end('x'); },
  clone: async (payload) => { calls.push(['clone', payload]); return { name: 'demo', path: path.join(temp, 'workspaces', 'demo') }; },
  create: async (payload) => { calls.push(['create', payload]); return { name: 'demo', path: path.join(temp, 'workspaces', 'demo') }; },
  remove: async (payload) => { calls.push(['remove', payload]); return { removed: payload.name }; },
  push: async (payload) => { calls.push(['push', payload]); return { branch: 'chatmcp/x' }; },
};
const agent = { state: () => ({ activeTaskId: null, active: null, tasks: [] }) };
const manager = makeManager(path.join(temp, 'public'));
const server = createHubServer(manager, { port, agent, bundleRoot: hubRoot, publicGate: gate, workspaces: fakeWorkspaces, execMode: 'no-shell', isInitialized: () => initialized });
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

const loopbackPort = await freePort();
const loopbackManager = makeManager(path.join(temp, 'loopback'));
const loopback = createHubServer(loopbackManager, { port: loopbackPort, agent, bundleRoot: hubRoot });
await new Promise((resolve) => loopback.listen(loopbackPort, '127.0.0.1', resolve));

const forwarded = (n) => ({ 'x-forwarded-for': `10.0.0.${n}` });
const bad = (token, n = 1, extra = {}) => request(port, { method: 'POST', pathname: '/api/auth/login', headers: { origin: `https://${HOST}`, ...forwarded(n), ...extra }, body: { token } });
async function login(n = 200) {
  const response = await request(port, { method: 'POST', pathname: '/api/auth/login', headers: { origin: `https://${HOST}`, ...forwarded(n) }, body: { token: OWNER_TOKEN } });
  assert.equal(response.status, 200, `login should work: ${response.text}`);
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const state = await request(port, { pathname: '/api/state', headers: { cookie } });
  assert.equal(state.status, 200);
  return { cookie, csrf: state.json.csrfToken, response };
}
const authed = (session, extra = {}) => ({ cookie: session.cookie, ...extra });
const post = (session, pathname, body = {}, headers = {}) => request(port, { method: 'POST', pathname, body, headers: { cookie: session.cookie, origin: `https://${HOST}`, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': session.csrf, ...headers } });

try {
  // ------------------------------------------------------------------------------------------------ health probe
  await section('/healthz answers the platform probe and nothing else', async () => {
    for (const host of [HOST, 'evil.test', 'localhost:1']) {
      const response = await request(port, { pathname: '/healthz', host, proto: null });
      equal([response.status, response.json], [200, { ok: true }], `healthz with Host ${host} and no X-Forwarded-Proto`);
    }
    const head = await request(port, { method: 'HEAD', pathname: '/healthz', host: 'evil.test', proto: null });
    equal([head.status, head.text], [200, ''], 'HEAD has no body');
    const wrong = await request(port, { method: 'POST', pathname: '/healthz', host: HOST, body: {} });
    equal([wrong.status, wrong.headers.allow], [405, 'GET, HEAD'], 'only GET/HEAD');
    initialized = false;
    const starting = await request(port, { pathname: '/healthz', host: HOST });
    equal([starting.status, starting.json], [503, { ok: false }], 'not ready while the Hub is still loading');
    initialized = true;
    const body = (await request(port, { pathname: '/healthz' })).text;
    check(!/version|workspace|token|hub/i.test(body.replace('"ok"', '')), 'the probe reveals nothing about the Hub');
    const loopbackProbe = await request(loopbackPort, { pathname: '/healthz', host: `127.0.0.1:${loopbackPort}`, proto: null });
    equal(loopbackProbe.status, 404, 'a loopback Hub has no /healthz (its behaviour is unchanged)');
  });

  await section('Host header attacks are refused before anything else', async () => {
    for (const host of ['evil.test', `${HOST}.evil.test`, `evil.test/${HOST}`, `${HOST}:8443`, 'hub.example.test@evil.test', '', 'HUB.EXAMPLE.TEST.evil.test', '127.0.0.1', `localhost:${port}`]) {
      for (const pathname of ['/', '/api/state', '/api/auth/login']) {
        const response = await request(port, { pathname, host, headers: { origin: `https://${HOST}` } });
        equal([response.status, response.json?.code], [403, 'host_denied'], `Host "${host}" on ${pathname}`);
      }
    }
    const none = await request(port, { pathname: '/api/state', host: null });
    check([400, 403].includes(none.status), `no Host header at all is refused (Node's own parser answers ${none.status})`);
    for (const host of [HOST, 'HUB.EXAMPLE.TEST', `${HOST}:443`, `${HOST}.`]) {
      const response = await request(port, { pathname: '/api/state', host });
      equal(response.status, 401, `the real host name (${host}) reaches the login gate`);
    }
  });

  await section('plain HTTP is refused, even when the proxy header is forged in front', async () => {
    for (const proto of [null, 'http', 'ws', 'https, http', 'httpss', '']) {
      const response = await request(port, { pathname: '/', proto });
      equal([response.status, response.json?.code], [400, 'https_required'], `X-Forwarded-Proto "${proto}"`);
    }
    for (const proto of ['https', 'HTTPS', 'http, https']) {
      const response = await request(port, { pathname: '/', proto });
      equal(response.status, 200, `X-Forwarded-Proto "${proto}" is accepted (the last value is the proxy's)`);
    }
  });

  await section('Origin must be this site, and only this site', async () => {
    for (const origin of ['https://evil.test', 'null', `http://${HOST}`, `https://${HOST}.evil.test`, `https://${HOST}:8443`, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', `https://evil.test/${HOST}`]) {
      for (const [method, pathname] of [['GET', '/api/state'], ['POST', '/api/auth/login'], ['POST', '/api/studio/checkpoint']]) {
        const response = await request(port, { method, pathname, headers: { origin }, body: method === 'POST' ? { token: OWNER_TOKEN } : undefined });
        equal([response.status, response.json?.code], [403, 'origin_denied'], `${method} ${pathname} with Origin ${origin}`);
      }
    }
    const noOrigin = await request(port, { method: 'POST', pathname: '/api/auth/login', body: { token: OWNER_TOKEN } });
    equal([noOrigin.status, noOrigin.json?.code], [403, 'origin_denied'], 'a login without Origin is refused');
    const preflight = await request(port, { method: 'OPTIONS', pathname: '/api/state', headers: { origin: `https://${HOST}`, 'access-control-request-method': 'GET' } });
    equal(preflight.status, 405, 'no CORS preflight is ever answered');
    check(!preflight.headers['access-control-allow-origin'], 'no CORS headers');
  });

  // ------------------------------------------------------------------------------------------------ default deny
  await section('without a login every route is closed (default deny)', async () => {
    const open = new Set(['/', '/index.html', '/login', '/login.js', '/login.css']);
    const gets = [
      '/api/state', '/api/health', '/api/capabilities', '/api/catalog', '/api/ai/models', '/api/ai/presets', '/api/studio/tree', '/api/studio/file?file=a.txt',
      '/api/studio/search?query=hello', '/api/studio/git/status', '/api/studio/git/diff', '/api/studio/terminal', '/api/studio/terminal/events',
      '/api/studio/intelligence/status', '/api/studio/preview?port=3000', '/api/studio/sandbox', '/api/extension-state', '/api/instructions',
      '/api/tasks/11111111-1111-4111-8111-111111111111', '/api/tasks/11111111-1111-4111-8111-111111111111/report', '/api/workspace/list', '/api/workspace/export?name=demo',
      '/legacy', '/legacy.html', '/app.js', '/style.css', '/studio.js', '/studio.css', '/react-app.js', '/react.css', '/ui-logic.js', '/onboarding.js',
      '/vendor/react.production.min.js', '/chat-route.js', '/auth/chatgpt/callback', '/robots.txt', '/does-not-exist', '/api/does-not-exist', '/api/auth/chatgpt/start',
      '/api/state/', '/%2e%2e/api/state', '/api/../api/state', '/./api/state', '//api/state', '/api//state', '/API/STATE', '/api/state?x=1', '/api/state%00', '/api/state;x',
      '/web/index.html', '/lib/auth.mjs', '/hub.mjs', '/package.json', '/../package.json',
    ];
    for (const pathname of gets) {
      for (const method of ['GET', 'HEAD']) {
        const response = await request(port, { method, pathname });
        if (open.has(pathname.split('?')[0])) continue;
        check(response.status === 401 && (method === 'HEAD' || response.json?.code === 'login_required'), `${method} ${pathname} -> ${response.status}`);
      }
    }
    const posts = [...new Set([...POST_ROUTES, ...PUBLIC_POST_ROUTES, '/api/studio/permissions/decide', '/api/nope'])].filter((route) => route !== '/api/auth/login');
    for (const pathname of posts) {
      const response = await request(port, { method: 'POST', pathname, headers: { origin: `https://${HOST}`, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': 'a'.repeat(64) }, body: { id: 'x', approved: true } });
      check(response.status === 401 && response.json?.code === 'login_required', `POST ${pathname} -> ${response.status}`);
    }
    for (const method of ['PUT', 'DELETE', 'PATCH', 'TRACE', 'PROPFIND']) {
      const response = await request(port, { method, pathname: '/api/state', body: method === 'PUT' || method === 'PATCH' ? {} : undefined });
      check(response.status === 401, `${method} /api/state -> ${response.status}`);
    }
    const loginPage = await request(port, { pathname: '/' });
    check(loginPage.status === 200 && /<form id="login"/.test(loginPage.text) && /login\.js/.test(loginPage.text), '/ is the login page');
    check(!/react-app|csrfToken|api\/state/.test(loginPage.text), 'the login page carries no part of the app');
    for (const asset of ['/login.js', '/login.css', '/login']) check((await request(port, { pathname: asset })).status === 200, `${asset} is public`);
    const info = await request(port, { pathname: '/api/auth/session' });
    equal([info.status, info.json], [200, { authenticated: false }], 'the session probe says "not logged in" instead of failing');
  });

  await section('cookies that are forged, malformed or from nowhere do not open the gate', async () => {
    const name = config.cookie.name;
    const values = ['', 'x', 'a'.repeat(43), 'A'.repeat(43), `${'a'.repeat(42)}!`, 'a'.repeat(44), "'; DROP TABLE", '../../etc/passwd', `${'a'.repeat(43)}; ${name}=${'b'.repeat(43)}`];
    for (const value of values) {
      const response = await request(port, { pathname: '/api/state', headers: { cookie: `${name}=${value}` } });
      equal(response.status, 401, `cookie value ${JSON.stringify(value).slice(0, 40)}`);
    }
    const other = await request(port, { pathname: '/api/state', headers: { cookie: `chatmcp_session=${'a'.repeat(43)}; other=1` } });
    equal(other.status, 401, 'a cookie with another name');
    const bearer = await request(port, { pathname: '/api/state', headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    equal(bearer.status, 401, 'the owner token is not accepted as a Bearer header');
    const query = await request(port, { pathname: `/api/state?token=${OWNER_TOKEN}` });
    equal(query.status, 401, 'nor in the query string');
  });

  // ------------------------------------------------------------------------------------------------ login
  await section('login: wrong tokens, throttling, spoofed X-Forwarded-For', async () => {
    let address = 60;
    for (const [attempt, token] of [['empty', ''], ['short', 'x'], ['near miss', `${OWNER_TOKEN.slice(0, -1)}X`], ['number', 12345], ['null', null], ['array', [OWNER_TOKEN]], ['object', { toString: 'x' }], ['long', 'z'.repeat(5000)]]) {
      const response = await bad(token, address++);
      check([401, 413].includes(response.status), `${attempt} -> ${response.status}`);
    }
    clock += 16 * 60_000; // the failures above must not count against the checks below
    // Per-address throttle: 3 failures per address, counted on the entry the proxy (one hop) appended, not on what the client wrote.
    const spoof = (leftmost) => ({ 'x-forwarded-for': `${leftmost}, 10.9.9.9` });
    equal((await bad('wrong-1', 0, spoof('1.1.1.1'))).status, 401);
    equal((await bad('wrong-2', 0, spoof('2.2.2.2'))).status, 401);
    equal((await bad('wrong-3', 0, spoof('3.3.3.3'))).status, 401);
    const blocked = await bad('wrong-4', 0, spoof('4.4.4.4'));
    equal([blocked.status, blocked.json?.code], [429, 'too_many_attempts'], 'rotating the forged left part of X-Forwarded-For does not reset the limit');
    check(Number(blocked.headers['retry-after']) > 0, 'Retry-After is given');
    const rightButBlocked = await request(port, { method: 'POST', pathname: '/api/auth/login', headers: { origin: `https://${HOST}`, ...spoof('5.5.5.5') }, body: { token: OWNER_TOKEN } });
    equal(rightButBlocked.status, 429, 'while blocked, even the right token is not looked at');
    check(!rightButBlocked.headers['set-cookie'], 'and no cookie is handed out');
    clock += 16 * 60_000;
    const afterWindow = await request(port, { method: 'POST', pathname: '/api/auth/login', headers: { origin: `https://${HOST}`, ...spoof('6.6.6.6') }, body: { token: OWNER_TOKEN } });
    equal(afterWindow.status, 200, 'the block ends with its window');
  });

  await section('login: a global limit holds even when every request claims a new address', async () => {
    clock += 16 * 60_000;
    const statuses = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await bad(`wrong-${i}`, 100 + i)).status);
    check(statuses.slice(0, 8).every((status) => status === 401), 'the first failures are ordinary 401s');
    check(statuses.slice(8).every((status) => status === 429), `after 8 failures nobody can log in: ${statuses.join(',')}`);
    const right = await request(port, { method: 'POST', pathname: '/api/auth/login', headers: { origin: `https://${HOST}`, ...forwarded(250) }, body: { token: OWNER_TOKEN } });
    equal(right.status, 429, 'including the owner from a new address (the price of not trusting forgeable headers)');
    clock += 16 * 60_000;
    equal((await request(port, { method: 'POST', pathname: '/api/auth/login', headers: { origin: `https://${HOST}`, ...forwarded(251) }, body: { token: OWNER_TOKEN } })).status, 200, 'and it ends with the window');
  });

  await section('login: body handling', async () => {
    const send = (extra) => request(port, { method: 'POST', pathname: '/api/auth/login', headers: { origin: `https://${HOST}`, ...forwarded(77), ...extra.headers }, body: extra.body });
    equal((await send({ headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token: OWNER_TOKEN }) })).status, 415, 'must be JSON');
    equal((await send({ headers: { 'content-type': 'application/json' }, body: '{not json' })).status, 400, 'invalid JSON');
    equal((await send({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(6000) }) })).status, 413, 'body size is capped');
    equal((await send({ headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'no token');
    const trailing = await request(port, { method: 'POST', pathname: '/api/auth/login/', headers: { origin: `https://${HOST}`, ...forwarded(78) }, body: { token: 'nope' } });
    equal(trailing.status, 401, 'a trailing slash reaches the same route');
  });

  // ------------------------------------------------------------------------------------------------ a logged-in owner
  let owner;
  await section('a successful login: cookie flags, per-session CSRF, the app is served', async () => {
    clock += 16 * 60_000;
    owner = await login(10);
    const header = String(owner.response.headers['set-cookie']);
    check(header.startsWith(`${config.cookie.name}=`) && config.cookie.name.startsWith('__Host-'), 'the cookie has the __Host- prefix');
    for (const part of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure']) check(header.includes(part), `cookie flag ${part}`);
    check(!/Domain=/i.test(header), 'no Domain attribute (host-only cookie)');
    check(/Max-Age=\d+/.test(header), 'it expires');
    const sessionId = header.split(';')[0].split('=')[1];
    check(!owner.response.text.includes(sessionId) && !owner.response.text.includes(owner.csrf), 'neither the session id nor the CSRF token is in the login response body');
    check(/^[A-Za-z0-9_-]{43}$/.test(owner.csrf), 'the CSRF token is 256 random bits');
    const second = await login(11);
    check(second.csrf !== owner.csrf && second.cookie !== owner.cookie, 'every session has its own cookie and CSRF token');

    const state = await request(port, { pathname: '/api/state', headers: authed(owner) });
    check(state.json.publicMode?.enabled === true && state.json.publicMode.execMode === 'no-shell' && state.json.publicMode.ephemeralStorage === true, 'state tells the UI that this is public mode');
    check(JSON.stringify(state.json).indexOf(OWNER_TOKEN) === -1, 'the owner token is nowhere in the state');
    const app = await request(port, { pathname: '/', headers: authed(owner) });
    check(app.status === 200 && /react-app\.js/.test(app.text), '/ is the app once logged in');
    equal((await request(port, { pathname: '/login', headers: authed(owner) })).status, 302, '/login goes back to the app');
    const info = await request(port, { pathname: '/api/auth/session', headers: authed(owner) });
    check(info.json.authenticated === true && typeof info.json.expiresAt === 'string', 'session info');
    for (const asset of ['/react-app.js', '/react.css', '/ui-logic.js', '/onboarding.js', '/vendor/react.production.min.js', '/vendor/react-dom.production.min.js']) {
      equal((await request(port, { pathname: asset, headers: authed(owner) })).status, 200, `${asset} is served`);
    }
    for (const asset of ['/legacy', '/legacy.html', '/app.js', '/style.css', '/studio.js', '/studio.css', '/package.json', '/hub.mjs', '/lib/auth.mjs']) {
      equal((await request(port, { pathname: asset, headers: authed(owner) })).status, 404, `${asset} is not served on a public host`);
    }
    const headers = app.headers;
    check(/max-age=\d+/.test(headers['strict-transport-security']), 'HSTS');
    equal(headers['cross-origin-opener-policy'], 'same-origin');
    equal(headers['cross-origin-resource-policy'], 'same-origin');
    equal(headers['x-frame-options'], 'DENY');
    equal(headers['cache-control'], 'no-store');
    equal(headers['x-content-type-options'], 'nosniff');
    check(/frame-src 'none'/.test(headers['content-security-policy']) && !/127\.0\.0\.1|localhost/.test(headers['content-security-policy']), 'CSP allows no frames and no localhost');
    check(/script-src 'self'/.test(headers['content-security-policy']) && !/unsafe-inline|unsafe-eval/.test(headers['content-security-policy']), 'CSP allows only own scripts');
    const loginAsset = await request(port, { pathname: '/login' });
    check(/frame-src 'none'/.test(loginAsset.headers['content-security-policy']), 'the login page has the same policy');
  });

  await section('state-changing requests need the session\'s own CSRF token, the marker header and the right Origin', async () => {
    const other = await login(12);
    const target = '/api/studio/permissions/config';
    const body = { mode: 'review' };
    const good = await post(owner, target, body);
    equal(good.status, 200, 'all correct');
    check(good.json.csrfToken === owner.csrf, 'the response repeats this session\'s token, not a global one');
    const cases = [
      ['no CSRF header', { 'x-chatmcp-csrf': undefined }],
      ['empty CSRF', { 'x-chatmcp-csrf': '' }],
      ['another session\'s CSRF token', { 'x-chatmcp-csrf': other.csrf }],
      ['truncated token', { 'x-chatmcp-csrf': owner.csrf.slice(0, -1) }],
      ['token plus junk', { 'x-chatmcp-csrf': `${owner.csrf}x` }],
      ['no marker header', { 'x-chatmcp-request': undefined }],
      ['wrong marker header', { 'x-chatmcp-request': 'other' }],
    ];
    for (const [name, headers] of cases) {
      const response = await post(owner, target, body, headers);
      equal([response.status, response.json?.code], [403, 'csrf'], name);
    }
    const noOrigin = await post(owner, target, body, { origin: undefined });
    equal([noOrigin.status, noOrigin.json?.code], [403, 'csrf'], 'no Origin on a state change');
    const foreign = await post(owner, target, body, { origin: 'https://evil.test' });
    equal([foreign.status, foreign.json?.code], [403, 'origin_denied'], 'foreign Origin');
    const mixed = await request(port, { method: 'POST', pathname: target, body, headers: { cookie: owner.cookie, origin: `https://${HOST}`, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': other.csrf } });
    equal(mixed.status, 403, 'session A cookie with session B token');
    const loopbackToken = (await request(loopbackPort, { pathname: '/api/state', host: `127.0.0.1:${loopbackPort}`, proto: null })).json.csrfToken;
    const crossMode = await post(owner, target, body, { 'x-chatmcp-csrf': loopbackToken });
    equal(crossMode.status, 403, 'a loopback token is worthless here');
    const ui = await post(owner, target, body, { 'x-chatmcp-ui-build': 'old-build' });
    equal([ui.status, ui.json?.code], [409, 'ui_backend_version_mismatch'], 'UI version handshake still applies');
  });

  await section('features that make no sense on a public host answer 403 even to the owner', async () => {
    const disabledPosts = ['/api/workspace/browse', '/api/vscode/open', '/api/hub/shutdown', '/api/browser/pair-code', '/api/browser/unpair', '/api/auth/chatgpt/start', '/api/studio/terminal/input', '/api/studio/terminal/resize', '/api/studio/intelligence/lsp/start', '/api/browser/clients/poll', '/api/browser/clients/pair'];
    for (const pathname of disabledPosts) {
      const response = await post(owner, pathname, { id: 'x', text: 'x' });
      equal([response.status, response.json?.code], [403, 'public_mode_disabled'], pathname);
    }
    for (const pathname of ['/api/studio/terminal/events', '/api/studio/preview?port=3000', '/api/studio/sandbox', '/api/studio/intelligence/lsp?file=a.py', '/api/extension-state', '/api/instructions', '/chat-route.js', '/auth/chatgpt/callback']) {
      const response = await request(port, { pathname, headers: authed(owner) });
      equal([response.status, response.json?.code], [403, 'public_mode_disabled'], `GET ${pathname}`);
    }
    for (const executionPolicy of ['full-access', 'sandbox-only']) {
      const response = await post(owner, '/api/studio/permissions/config', { executionPolicy, confirmation: 'FULL ACCESS' });
      equal([response.status, response.json?.code], [403, 'public_mode_disabled'], `execution policy ${executionPolicy}`);
    }
    equal((await post(owner, '/api/studio/permissions/config', { executionPolicy: 'host-review', mode: 'readonly' })).status, 200, 'host-review is the one allowed policy');
    for (const payload of [{ command: 'echo hi', interactive: true }, { command: 'echo hi', sandbox: true }]) {
      const response = await post(owner, '/api/studio/terminal/start', payload);
      equal([response.status, response.json?.code], [403, 'public_mode_disabled'], `terminal ${JSON.stringify(payload)}`);
    }
    for (const pathname of ['/api/studio/terminal/start', '/api/studio/verify/run']) {
      const response = await post(owner, pathname, { command: 'echo hi' });
      equal([response.status, response.json?.code], [403, 'exec_unavailable'], `${pathname} while commands are switched off (no-shell)`);
    }
    equal((await request(port, { pathname: '/api/health', headers: authed(owner) })).status, 200, 'the Hub survived all of that');
    const caps = (await request(port, { pathname: '/api/capabilities', headers: authed(owner) })).json.postRoutes;
    check(!caps.includes('/api/hub/shutdown') && !caps.includes('/api/workspace/browse') && caps.includes('/api/workspace/clone') && caps.includes('/api/auth/logout'), 'the advertised routes are the public ones');
  });

  await section('workspace routes: owner only, CSRF protected, and absent from a loopback Hub', async () => {
    equal((await post(owner, '/api/workspace/clone', { url: 'octo/demo' }, { 'x-chatmcp-csrf': 'wrong' })).status, 403, 'clone needs the CSRF token');
    equal(calls.length, 0, 'the service was not reached');
    const cloned = await post(owner, '/api/workspace/clone', { url: 'octo/demo' });
    equal(cloned.status, 200, 'clone');
    equal(calls[0], ['clone', { url: 'octo/demo' }], 'the payload reaches the service unchanged');
    check(cloned.json.cloned?.name === 'demo', 'the result is returned');
    equal((await post(owner, '/api/workspace/create', { name: 'x' })).status, 200, 'create');
    equal((await post(owner, '/api/workspace/delete', { name: 'demo' })).status, 200, 'delete');
    equal((await post(owner, '/api/workspace/push', { name: 'demo' })).status, 200, 'push');
    equal((await request(port, { pathname: '/api/workspace/list', headers: authed(owner) })).json, { workspaces: [] }, 'list');
    equal((await request(port, { pathname: '/api/workspace/export?name=demo', headers: authed(owner) })).status, 200, 'export');
    const loopbackHeaders = { origin: `http://127.0.0.1:${loopbackPort}`, 'x-chatmcp-request': 'local-dashboard' };
    const loopbackState = (await request(loopbackPort, { pathname: '/api/state', host: `127.0.0.1:${loopbackPort}`, proto: null })).json;
    for (const pathname of ['/api/workspace/clone', '/api/workspace/create', '/api/workspace/delete', '/api/workspace/push']) {
      const response = await request(loopbackPort, { method: 'POST', pathname, host: `127.0.0.1:${loopbackPort}`, proto: null, headers: { ...loopbackHeaders, 'x-chatmcp-csrf': loopbackState.csrfToken }, body: {} });
      equal([response.status, response.json?.code], [404, 'unknown_action'], `loopback ${pathname}`);
    }
  });

  await section('logout and session lifetime', async () => {
    const mine = await login(20);
    equal((await request(port, { method: 'POST', pathname: '/api/auth/logout', headers: { cookie: mine.cookie, origin: `https://${HOST}`, 'x-chatmcp-request': 'local-dashboard' }, body: {} })).status, 403, 'logout needs the CSRF token (no forced logout from another site)');
    equal((await request(port, { pathname: '/api/state', headers: authed(mine) })).status, 200, 'and the failed attempt did not end the session');
    const out = await post(mine, '/api/auth/logout', {});
    equal(out.status, 200, 'logout');
    check(/Max-Age=0/.test(String(out.headers['set-cookie'])), 'the cookie is cleared');
    equal((await request(port, { pathname: '/api/state', headers: authed(mine) })).status, 401, 'the old cookie no longer works');
    equal((await post(mine, '/api/studio/permissions/config', { mode: 'review' })).status, 401, 'nor does its CSRF token');

    const idle = await login(21);
    clock += config.session.idleMs - 1000;
    equal((await request(port, { pathname: '/api/state', headers: authed(idle) })).status, 200, 'just inside the idle limit (and the request counts as activity)');
    clock += config.session.idleMs - 1000;
    equal((await request(port, { pathname: '/api/state', headers: authed(idle) })).status, 200, 'activity keeps a session alive');
    clock += config.session.idleMs + 1000;
    equal((await request(port, { pathname: '/api/state', headers: authed(idle) })).status, 401, 'but not past the idle limit');

    const absolute = await login(22);
    for (let minutes = 0; minutes < 55; minutes += 5) { clock += 5 * 60_000; await request(port, { pathname: '/api/state', headers: authed(absolute) }); }
    equal((await request(port, { pathname: '/api/state', headers: authed(absolute) })).status, 200, 'busy sessions live until the absolute limit');
    clock += 10 * 60_000;
    equal((await request(port, { pathname: '/api/state', headers: authed(absolute) })).status, 401, 'then they end however active they were');
  });

  await section('a loopback Hub (no public mode) behaves exactly as before', async () => {
    const host = `127.0.0.1:${loopbackPort}`;
    const state = await request(loopbackPort, { pathname: '/api/state', host, proto: null });
    check(state.status === 200 && /^[0-9a-f]{64}$/.test(state.json.csrfToken) && !('publicMode' in state.json), 'global CSRF token, no public-mode block');
    equal((await request(loopbackPort, { pathname: '/api/state', host: 'evil.test', proto: null })).status, 403, 'Host is still checked');
    equal((await request(loopbackPort, { pathname: '/api/state', host, proto: null, headers: { origin: 'https://evil.test' } })).status, 403, 'Origin is still checked');
    equal((await request(loopbackPort, { pathname: '/', host, proto: null })).status, 200, 'the app needs no login');
    const csp = (await request(loopbackPort, { pathname: '/', host, proto: null })).headers['content-security-policy'];
    check(/frame-src http:\/\/127\.0\.0\.1:\*/.test(csp), 'the localhost preview frames stay allowed');
    check(!('strict-transport-security' in (await request(loopbackPort, { pathname: '/', host, proto: null })).headers), 'no HSTS over plain loopback HTTP');
    equal((await request(loopbackPort, { pathname: '/legacy', host, proto: null })).status, 200, 'the legacy page is still served locally');
    const caps = (await request(loopbackPort, { pathname: '/api/capabilities', host, proto: null })).json.postRoutes;
    equal(caps, [...POST_ROUTES], 'advertised routes unchanged');
  });
} finally {
  auth.close();
  server.closeAllConnections();
  loopback.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => loopback.close(resolve));
  manager.intelligence.close();
  loopbackManager.intelligence.close();
  await manager.terminal.close();
  await loopbackManager.terminal.close();
}

// ---------------------------------------------------------------------------------------------------- the Hub refuses to start
await section('the Hub refuses to start when public mode would be open or weak', async () => {
  const baseEnv = { PATH: process.env.PATH ?? '', HOME: temp, USERPROFILE: temp, SystemRoot: process.env.SystemRoot ?? '', TEMP: temp, TMP: temp, CHATMCP_STATE_DIR: path.join(temp, 'refusal-state'), CHATMCP_NO_OPEN: '1' };
  const attempt = (env, args = []) => spawnSync(process.execPath, [path.join(hubRoot, 'hub.mjs'), ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 20000 });
  const good = { CHATMCP_PUBLIC: '1', CHATMCP_OWNER_TOKEN: OWNER_TOKEN, CHATMCP_ALLOWED_HOSTS: HOST, CHATMCP_WORKSPACES_ROOT: path.join(temp, 'refusal-ws'), PORT: String(await freePort()) };
  const refusals = [
    ['no token', { ...good, CHATMCP_OWNER_TOKEN: '' }, /CHATMCP_OWNER_TOKEN/],
    ['short token', { ...good, CHATMCP_OWNER_TOKEN: 'short-but-not-empty' }, /ít nhất 32/],
    ['repetitive token', { ...good, CHATMCP_OWNER_TOKEN: 'a'.repeat(40) }, /khác nhau/],
    ['token with a space', { ...good, CHATMCP_OWNER_TOKEN: `${OWNER_TOKEN} x` }, /khoảng trắng/],
    ['no host name', { ...good, CHATMCP_ALLOWED_HOSTS: '' }, /tên host công khai/],
    ['bad host name', { ...good, CHATMCP_ALLOWED_HOSTS: 'a b/c' }, /Tên host không hợp lệ/],
    ['unclear flag', { ...good, CHATMCP_ALLOW_INSECURE_HTTP: 'maybe' }, /CHATMCP_ALLOW_INSECURE_HTTP/],
    ['same-user commands without confirmation', { ...good, CHATMCP_EXEC_MODE: 'same-user' }, /UNSAFE_SAME_USER_EXEC/],
    ['broker without a socket', { ...good, CHATMCP_EXEC_MODE: 'broker' }, /CHATMCP_EXEC_BROKER/],
    ['unknown exec mode', { ...good, CHATMCP_EXEC_MODE: 'yolo' }, /CHATMCP_EXEC_MODE/],
    ['GitHub token that looks wrong', { ...good, GITHUB_TOKEN: 'has spaces and is far too odd' }, /GITHUB_TOKEN/],
    ['public mode with the MCP backend', { ...good, CHATMCP_BACKEND: 'mcp' }, /--repo-root|backend/],
  ];
  for (const [name, env, pattern] of refusals) {
    const run = attempt(env);
    check(run.status !== 0 && run.status !== null, `${name}: exit code ${run.status}`);
    check(pattern.test(`${run.stderr}${run.stdout}`), `${name}: says why (${(run.stderr + run.stdout).split('\n')[0].slice(0, 110)})`);
    check(!`${run.stderr}${run.stdout}`.includes(OWNER_TOKEN), `${name}: the token is not echoed`);
  }
  // Binding outside loopback without public mode is refused as well, whatever else is set.
  const exposed = attempt({ CHATMCP_OWNER_TOKEN: OWNER_TOKEN }, ['--host', '0.0.0.0', '--port', String(await freePort())]);
  check(exposed.status !== 0 && /CHATMCP_PUBLIC=1/.test(exposed.stderr), `--host 0.0.0.0 without CHATMCP_PUBLIC: exit ${exposed.status}`);
  const exposedEnv = attempt({ CHATMCP_HOST: '10.0.0.5' });
  check(exposedEnv.status !== 0 && /CHATMCP_PUBLIC=1/.test(exposedEnv.stderr), 'CHATMCP_HOST=10.0.0.5 without CHATMCP_PUBLIC');
  await fs.access(path.join(temp, 'refusal-state')).then(() => assert.fail('a refused Hub must not create its state directory'), () => { checks += 1; });
});

await fs.rm(temp, { recursive: true, force: true });
console.log(`PASS: ${checks} public-mode HTTP checks (health probe, Host/HTTPS/Origin, default deny, login throttling, sessions, CSRF, disabled routes, refusal to start)`);
