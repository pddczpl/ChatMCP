// The assembled public server as a real process: `node hub.mjs` with CHATMCP_PUBLIC=1, driven over HTTP the way the page drives it.
//
// verify-public-http.mjs checks the front door with hand-built parts inside one process, and verify-workspaces.mjs checks the workspace
// service on its own. This suite starts the real program, so it checks that the pieces are wired together the way the container wires
// them - the gate in front of the routes, the owner's session and CSRF token, the workspace routes, the execution mode, the files and
// tools of a workspace, and what leaves the process (state, logs, errors) - and that no secret is among it.
//
//   Part A (every platform): a Hub with no way to run commands (CHATMCP_EXEC_MODE=no-shell), from the health probe to log-out.
//   Part B (root on Linux):  the real supervisor, which switches accounts: the Hub runs as its own user, commands run as the agent
//                            through the broker, and what the agent can reach is tried from inside a terminal command.
//                            Without root, Part B is reported as not applicable (the PASS line says so) - never silently passed.
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listProcessesOfUid, reapAgentProcesses } from '../lib/exec-broker.mjs';
import { cleanEnvironment, freePort, HUB_ROOT, waitFor } from './e2e/hub-process.mjs';
import { findPrograms, realAccountsAvailable } from './fixtures/real-accounts.mjs';

const run = promisify(execFile);
let checks = 0;
const notes = [];
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const notApplicable = (label) => { notes.push(label); console.log(`  skip - ${label}`); };
const SUPERVISOR = path.join(HUB_ROOT, 'docker', 'supervisor.mjs');
const OWNER_TOKEN = randomBytes(33).toString('base64url'); // 44 characters, the shape of Render's generateValue
const GITHUB_TOKEN = `github_pat_${randomBytes(30).toString('base64url')}`; // not a real token: only here to be looked for everywhere
const SECRETS = [OWNER_TOKEN, GITHUB_TOKEN];

const processes = [];
const temporary = [];
process.once('exit', () => {
  for (const proc of processes) proc.killTree();
  for (const directory of temporary) { try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ } }
});
setTimeout(() => { console.error('FAIL: the public end-to-end suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

// ---------------------------------------------------------------------------------------------------------------- processes
class Proc {
  constructor(child, logFile) {
    this.child = child;
    this.logFile = logFile;
    this.exitInfo = null;
    this.exited = new Promise((resolve) => child.once('exit', (code, signal) => { this.exitInfo = { code, signal }; resolve(this.exitInfo); }));
    processes.push(this);
  }

  get running() { return this.exitInfo === null; }
  get pid() { return this.child.pid; }
  log() { try { return readFileSync(this.logFile, 'utf8'); } catch { return ''; } }

  killTree() {
    if (!this.running) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-this.pid, 'SIGKILL'); } catch { try { process.kill(this.pid, 'SIGKILL'); } catch { /* gone */ } } }
  }

  /** SIGTERM first, as the platform does when it stops a service; by force if that does not end it soon. */
  async stop({ graceMs = 20_000 } = {}) {
    if (!this.running) return this.exitInfo;
    try { process.kill(this.pid, 'SIGTERM'); } catch { /* gone */ }
    let timer;
    const outcome = await Promise.race([this.exited, new Promise((resolve) => { timer = setTimeout(() => resolve(null), graceMs); })]);
    clearTimeout(timer); // a timer left running would keep this process alive for the whole grace period after the suite is done
    if (outcome) return outcome;
    this.killTree();
    return { ...(await this.exited), forced: true };
  }
}

function launch(file, args, { env, cwd, logFile }) {
  const log = openSync(logFile, 'a');
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', log, log], detached: process.platform !== 'win32', windowsHide: true });
  closeSync(log);
  return new Proc(child, logFile);
}

// ---------------------------------------------------------------------------------------------------------------- HTTP, as a browser would
function request(port, { method = 'GET', pathname = '/', headers = {}, body, host = `127.0.0.1:${port}`, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const sent = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    if (host !== null) sent.host = host;
    let payload = body;
    if (body !== undefined && typeof body !== 'string') { payload = JSON.stringify(body); sent['content-type'] = 'application/json'; }
    if (payload !== undefined) sent['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: sent, setHost: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = binary ? '' : buffer.toString('utf8');
        let json = null;
        if (!binary && /json/.test(res.headers['content-type'] ?? '')) { try { json = JSON.parse(text); } catch { /* left null */ } }
        resolve({ status: res.statusCode, headers: res.headers, text, json, buffer });
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`${method} ${pathname} timed out`)));
    req.end(payload);
  });
}

class Visitor {
  /** `headers` go on every request (what a proxy in front of the Hub adds); `host` and `origin` are what the browser would send. */
  constructor(port, { host = `127.0.0.1:${port}`, origin = `http://127.0.0.1:${port}`, headers = {} } = {}) {
    this.port = port; this.host = host; this.origin = origin; this.headers = headers; this.cookie = null; this.csrf = null;
  }

  request(options) { return request(this.port, { host: this.host, ...options, headers: { ...this.headers, ...options.headers } }); }
  get(pathname, options = {}) { return this.request({ pathname, ...options, headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...options.headers } }); }
  post(pathname, body = {}, headers = {}) {
    return this.request({
      method: 'POST', pathname, body,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), origin: this.origin, 'x-chatmcp-request': 'local-dashboard', ...(this.csrf ? { 'x-chatmcp-csrf': this.csrf } : {}), ...headers },
    });
  }

  async login(token = OWNER_TOKEN, headers = {}) {
    const response = await this.request({ method: 'POST', pathname: '/api/auth/login', headers: { origin: this.origin, ...headers }, body: { token } });
    if (response.status === 200) {
      this.cookie = String(response.headers['set-cookie']).split(';')[0];
      const state = await this.get('/api/state');
      assert.equal(state.status, 200, state.text);
      this.csrf = state.json.csrfToken;
    }
    return response;
  }

  async state() { const response = await this.get('/api/state'); assert.equal(response.status, 200, response.text); return response.json; }
}

async function healthy(port, proc) {
  return waitFor(async () => {
    if (!proc.running) throw Object.assign(new Error(`the server exited early (${JSON.stringify(proc.exitInfo)}):\n${proc.log().slice(-2500)}`), { fatal: true });
    const response = await request(port, { pathname: '/healthz' }).catch(() => null);
    return response?.status === 200 ? response : null;
  }, { timeoutMs: 60_000, intervalMs: 150, label: 'GET /healthz to answer 200' });
}

/** Every file below `directory` that mentions one of the secrets (text search; the folders hold only text and small binary files). */
function filesMentioning(directory, secrets) {
  const hits = [];
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      let data;
      try { data = readFileSync(full); } catch { continue; }
      if (data.length > 64 * 1024 * 1024) continue;
      const text = data.toString('latin1');
      if (secrets.some((secret) => text.includes(secret))) hits.push(full);
    }
  };
  walk(directory);
  return hits;
}

async function archiveEntries(buffer, directory) {
  const archive = path.join(directory, `export-${randomBytes(4).toString('hex')}.tar.gz`);
  await fs.writeFile(archive, buffer);
  const listing = (await run('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 })).stdout.split(/\r?\n/).map((line) => line.replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean);
  await fs.rm(archive, { force: true });
  return listing;
}

// ================================================================================================================================
// Part A - a Hub that cannot run commands
// ================================================================================================================================
{
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-e2e-public-'));
  temporary.push(scratch);
  const port = await freePort();
  const workspaces = path.join(scratch, 'ws');
  const stateDir = path.join(scratch, 'state');
  await fs.mkdir(stateDir, { recursive: true });
  const env = cleanEnvironment(scratch, {
    CHATMCP_PUBLIC: '1', CHATMCP_OWNER_TOKEN: OWNER_TOKEN, CHATMCP_ALLOWED_HOSTS: `127.0.0.1:${port}`, CHATMCP_ALLOW_INSECURE_HTTP: '1', CHATMCP_HOST: '127.0.0.1',
    CHATMCP_WORKSPACES_ROOT: workspaces, CHATMCP_MAX_WORKSPACES: '2', CHATMCP_EXEC_MODE: 'no-shell', CHATMCP_LOGIN_FAILURE_DELAY_MS: '0', CHATMCP_LOGIN_MAX_FAILURES_PER_IP: '8', GITHUB_TOKEN,
  });
  const hub = launch(process.execPath, [path.join(HUB_ROOT, 'hub.mjs'), '--backend', 'local', '--port', String(port), '--state-dir', stateDir, '--no-open'], { env, cwd: HUB_ROOT, logFile: path.join(scratch, 'hub.log') });
  await healthy(port, hub);
  const anon = new Visitor(port);
  const owner = new Visitor(port);

  {
    const probe = await anon.get('/healthz');
    assert.deepEqual([probe.status, probe.json], [200, { ok: true }]);
    assert.equal((await anon.get('/healthz', { host: 'probe.internal' })).status, 200, 'the platform\'s probe has no Host the Hub knows');
    const head = await anon.request({ method: 'HEAD', pathname: '/healthz' });
    assert.deepEqual([head.status, head.text], [200, '']);
    assert.equal((await anon.request({ method: 'POST', pathname: '/healthz' })).status, 405);
    ok('GET /healthz answers 200 {"ok":true} to anyone, whatever the Host; HEAD works, POST is 405');
  }

  {
    const page = await anon.get('/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'] ?? '', /text\/html/);
    assert.ok(!/csrfToken|react-app|api\/state/.test(page.text), 'a stranger gets the login page, not the app');
    for (const pathname of ['/api/state', '/api/health', '/api/workspace/list', '/api/workspace/export?name=x', '/api/studio/terminal', '/api/ai/presets', '/api/tasks/1', '/api/nope', '/chat-route.js', '/react-app.js']) {
      const response = await anon.get(pathname);
      assert.deepEqual([response.status, response.json?.code], [401, 'login_required'], `GET ${pathname} without a session`);
    }
    for (const pathname of ['/api/workspace/create', '/api/workspace/clone', '/api/workspace/delete', '/api/tasks/start', '/api/studio/terminal/start', '/api/hub/shutdown', '/api/nope']) {
      const response = await anon.post(pathname, { name: 'x', url: 'a/b', command: 'id' });
      assert.deepEqual([response.status, response.json?.code], [401, 'login_required'], `POST ${pathname} without a session`);
    }
    const strangerHost = await anon.get('/', { host: 'evil.example' });
    assert.deepEqual([strangerHost.status, strangerHost.json?.code], [403, 'host_denied']);
    const emptyHost = await anon.get('/api/state', { host: null }).catch((error) => ({ status: 0, error }));
    assert.ok([0, 400, 403].includes(emptyHost.status), 'no Host header at all is refused');
    ok('a stranger gets the login page and 401 login_required on every other route and method; a Host the Hub does not know is 403 host_denied');
  }

  {
    const wrongOrigin = await anon.request({ method: 'POST', pathname: '/api/auth/login', headers: { origin: 'http://evil.example' }, body: { token: OWNER_TOKEN } });
    assert.deepEqual([wrongOrigin.status, wrongOrigin.json?.code], [403, 'origin_denied']);
    assert.ok(!wrongOrigin.headers['set-cookie'], 'a login from another origin gets no cookie even with the right token');
    const noOrigin = await anon.request({ method: 'POST', pathname: '/api/auth/login', body: { token: OWNER_TOKEN } });
    assert.deepEqual([noOrigin.status, noOrigin.json?.code], [403, 'origin_denied']);
    const wrong = await anon.login('not-the-token-not-the-token-not-the-token');
    assert.deepEqual([wrong.status, wrong.json?.code], [401, 'bad_token']);
    assert.ok(!wrong.headers['set-cookie']);
    for (const bad of ['', ' ', OWNER_TOKEN.slice(0, -1), `${OWNER_TOKEN}x`, OWNER_TOKEN.toLowerCase() === OWNER_TOKEN ? OWNER_TOKEN.toUpperCase() : OWNER_TOKEN.toLowerCase()]) {
      assert.equal((await anon.login(bad)).status, 401, `the token must match exactly (${JSON.stringify(bad.slice(0, 6))}...)`);
    }
    const good = await owner.login();
    assert.equal(good.status, 200);
    const header = String(good.headers['set-cookie']);
    assert.match(header, /^chatmcp_session=[A-Za-z0-9_-]{43}; /, 'plain-HTTP test mode: the session cookie has no __Host- prefix');
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
    assert.match(header, /Path=\//);
    assert.ok(!header.includes(OWNER_TOKEN), 'the cookie is a random session id, not the token');
    assert.match(owner.csrf, /^[A-Za-z0-9_-]{43}$/);
    const state = await owner.state();
    assert.equal(state.publicMode.enabled, true);
    assert.equal(state.publicMode.execMode, 'no-shell');
    assert.equal(state.publicMode.workspaces.max, 2);
    assert.equal(state.publicMode.ephemeralStorage, true);
    for (const disabled of ['shutdown', 'full-access', 'docker-sandbox', 'interactive-terminal', 'native-folder-picker']) assert.ok(state.publicMode.disabled.includes(disabled), `${disabled} is listed as disabled`);
    assert.ok(!JSON.stringify(state).includes(OWNER_TOKEN) && !JSON.stringify(state).includes(GITHUB_TOKEN), 'the state the page receives holds no secret');
    ok('login: a wrong Origin or token is refused without a cookie, the right token gives an HttpOnly SameSite=Strict session and a per-session CSRF token, and the state the page gets is secret-free');
  }

  {
    const body = { name: 'blocked' };
    const noCsrf = await owner.post('/api/workspace/create', body, { 'x-chatmcp-csrf': undefined });
    assert.deepEqual([noCsrf.status, noCsrf.json?.code], [403, 'csrf']);
    const wrongCsrf = await owner.post('/api/workspace/create', body, { 'x-chatmcp-csrf': 'a'.repeat(43) });
    assert.deepEqual([wrongCsrf.status, wrongCsrf.json?.code], [403, 'csrf']);
    const noMarker = await owner.post('/api/workspace/create', body, { 'x-chatmcp-request': undefined });
    assert.deepEqual([noMarker.status, noMarker.json?.code], [403, 'csrf']);
    const otherOrigin = await owner.post('/api/workspace/create', body, { origin: 'http://evil.example' });
    assert.deepEqual([otherOrigin.status, otherOrigin.json?.code], [403, 'origin_denied']);
    const noOrigin = await owner.post('/api/workspace/create', body, { origin: undefined });
    assert.equal(noOrigin.status, 403);
    assert.equal((await owner.get('/api/workspace/list')).json.count, 0, 'none of the refused requests created anything');
    ok('a state-changing request needs the session\'s CSRF token, the page\'s marker header and an allowed Origin; each one missing is a 403 and creates nothing');
  }

  const demoPath = path.join(workspaces, 'demo');
  {
    const created = await owner.post('/api/workspace/create', { name: 'demo' });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.json.created.name, 'demo');
    assert.equal(created.json.workspace.path, (await fs.realpath(demoPath)), 'creating a workspace selects it');
    assert.equal((await fs.readFile(path.join(demoPath, '.git', 'HEAD'), 'utf8')).trim(), 'ref: refs/heads/main');
    const gitConfig = await fs.readFile(path.join(demoPath, '.git', 'config'), 'utf8');
    assert.match(gitConfig, /email = agent@chatmcp\.invalid/);
    assert.ok(!gitConfig.includes(GITHUB_TOKEN), 'no token in .git/config');
    assert.ok((await fs.readdir(workspaces)).includes('.chatmcp-workspaces'), 'the root carries the marker');
    const list = (await owner.get('/api/workspace/list')).json;
    assert.deepEqual(list.items.map((item) => [item.name, item.kind, item.current, item.exists]), [['demo', 'empty', true, true]]);
    assert.equal(list.pushEnabled, true, 'a GitHub token is configured, so push is offered');
    assert.deepEqual(list.gitHosts, ['github.com']);
    assert.equal((await owner.post('/api/workspace/create', { name: 'second' })).status, 200);
    const third = await owner.post('/api/workspace/create', { name: 'third' });
    assert.deepEqual([third.status, third.json?.code], [409, 'workspace_limit'], 'the limit of workspaces holds');
    for (const bad of ['', '../escape', 'UPPER', 'a b', '.hidden', '-x', 'x'.repeat(61), 'a/b', 'nul\u0000']) {
      const response = await owner.post('/api/workspace/delete', { name: bad });
      assert.ok([400, 404].includes(response.status), `delete ${JSON.stringify(bad)}: ${response.status}`);
    }
    assert.deepEqual((await fs.readdir(workspaces)).sort(), ['.chatmcp-workspaces', '.exchange', 'demo', 'second']);
    ok('create: a workspace is a Git repository on main in the registered root, becomes the selected workspace, shows in the list, and the limit of two holds');
  }

  {
    const before = JSON.stringify((await owner.get('/api/workspace/list')).json.items.map((item) => item.name));
    const sentinel = path.join(scratch, 'pwned');
    const hostile = [
      'file:///etc/passwd', 'ssh://git@github.com/a/b', 'git://github.com/a/b', 'http://github.com/a/b', 'https://evil.example/a/b', 'https://github.com:8443/a/b',
      'https://github.com/a/b?x=1', 'https://github.com/a/b#frag', 'https://user:pw@github.com/a/b', 'https://github.com/../../etc', 'https://github.com/a/b/c', 'a/b/c',
      `ext::sh -c "touch ${sentinel}"`, '-oProxyCommand=x', '--upload-pack=touch x', 'https://github.com/a/b\r\nHost: evil', '/etc/passwd', '..', '', 'a b', 'https://github.com/a/%2e%2e',
    ];
    for (const url of hostile) {
      const response = await owner.post('/api/workspace/clone', { url });
      assert.ok([400, 403].includes(response.status), `clone ${JSON.stringify(url)} -> ${response.status} ${response.text.slice(0, 120)}`);
      assert.ok(['bad_url', 'host_not_allowed'].includes(response.json?.code), `clone ${JSON.stringify(url)} -> ${response.json?.code}`);
      assert.ok(!SECRETS.some((secret) => response.text.includes(secret)), 'the error leaks no secret');
    }
    for (const payload of [{ url: 'octocat/Hello-World', branch: '--evil' }, { url: 'octocat/Hello-World', branch: 'a..b' }, { url: 'octocat/Hello-World', depth: 0 }, { url: 'octocat/Hello-World', depth: 1e9 }, { url: 'octocat/Hello-World', depth: 'x' }]) {
      const response = await owner.post('/api/workspace/clone', payload);
      assert.deepEqual([response.status, ['bad_branch', 'bad_depth'].includes(response.json?.code)], [400, true], JSON.stringify(payload));
    }
    await assert.rejects(fs.lstat(sentinel), 'nothing a clone address says was ever run');
    assert.equal(JSON.stringify((await owner.get('/api/workspace/list')).json.items.map((item) => item.name)), before, 'and no workspace appeared');
    const pushed = await owner.post('/api/workspace/push', { name: 'demo', force: true });
    assert.deepEqual([pushed.status, pushed.json?.code], [400, 'force_refused'], 'the Hub never force-pushes');
    const nothing = await owner.post('/api/workspace/push', { name: 'demo' });
    assert.equal(nothing.json?.code, 'push_unsupported', 'an empty workspace has no repository to push to');
    ok(`clone: ${hostile.length} hostile addresses, bad branches and depths are refused with a specific code, run nothing, leak nothing and create nothing; push refuses force and workspaces without an origin`);
  }

  {
    for (const [method, pathname] of [['GET', '/api/studio/sandbox'], ['GET', '/api/studio/terminal/events'], ['GET', '/api/studio/preview'], ['POST', '/api/studio/terminal/input'], ['POST', '/api/studio/terminal/resize'],
      ['POST', '/api/workspace/browse'], ['POST', '/api/vscode/open'], ['POST', '/api/hub/shutdown'], ['GET', '/api/browser/status'], ['POST', '/api/browser/anything'], ['POST', '/api/studio/intelligence/lsp/start']]) {
      const response = method === 'GET' ? await owner.get(pathname) : await owner.post(pathname, {});
      assert.deepEqual([response.status, response.json?.code], [403, 'public_mode_disabled'], `${method} ${pathname} even with a session`);
    }
    assert.equal((await anon.get('/healthz')).status, 200, 'and the Hub is still running after the shutdown request');
    const policy = await owner.post('/api/studio/permissions/config', { executionPolicy: 'full-access' });
    assert.deepEqual([policy.status, policy.json?.code], [403, 'public_mode_disabled'], 'Full Access cannot be switched on');
    const interactive = await owner.post('/api/studio/terminal/start', { command: 'id', interactive: true });
    assert.deepEqual([interactive.status, interactive.json?.code], [403, 'public_mode_disabled']);
    const sandbox = await owner.post('/api/studio/terminal/start', { command: 'id', sandbox: true });
    assert.deepEqual([sandbox.status, sandbox.json?.code], [403, 'public_mode_disabled']);
    const terminal = await owner.post('/api/studio/terminal/start', { command: 'id' });
    assert.deepEqual([terminal.status, terminal.json?.code], [403, 'exec_unavailable'], 'no way to separate accounts: commands are off');
    const verify = await owner.post('/api/studio/verify/run', { command: 'id' });
    assert.deepEqual([verify.status, verify.json?.code], [403, 'exec_unavailable']);
    ok('routes that make no sense on the Internet (sandbox, SSE terminal, browser companion, VS Code, shutdown, folder picker) are 403 even for the owner; Full Access and interactive terminals cannot be switched on; with no-shell, commands are off');
  }

  {
    await fs.mkdir(path.join(workspaces, 'unregistered')); // a real folder in the right place that the Hub did not make
    const lookalike = path.join(scratch, 'elsewhere', 'second'); // the name of a workspace, in another place
    await fs.mkdir(lookalike, { recursive: true });
    for (const outside of ['/', os.tmpdir(), scratch, stateDir, path.join(workspaces, '..'), path.join(workspaces, '.exchange'), path.join(workspaces, 'unregistered'), path.join(workspaces, 'not-created'), lookalike, path.join(workspaces, 'second', '..', '..', 'elsewhere', 'second')]) {
      const response = await owner.post('/api/workspace/select', { path: outside });
      assert.deepEqual([response.status, response.json?.code], [403, 'workspace_not_allowed'], `select ${outside}`);
    }
    await fs.symlink(os.tmpdir(), path.join(workspaces, 'link-to-tmp'), 'dir').catch(() => null);
    assert.equal((await owner.post('/api/workspace/select', { path: path.join(workspaces, 'link-to-tmp') })).status, 403, 'a link to somewhere else is not a workspace');
    await fs.rm(path.join(workspaces, 'link-to-tmp'), { force: true });
    const chosen = await owner.post('/api/workspace/select', { path: path.join(workspaces, 'second') });
    assert.equal(chosen.status, 200, chosen.text);
    assert.equal(chosen.json.workspace.path, await fs.realpath(path.join(workspaces, 'second')));
    assert.equal((await owner.post('/api/workspace/select', { path: demoPath })).status, 200);
    ok('select: only a workspace the Hub made can be chosen - not /, the temp folder, the state folder, the root, the exchange folder, a folder the Hub did not make, a folder that does not exist, a copy of a workspace\'s name elsewhere or a link');
  }

  {
    await fs.writeFile(path.join(demoPath, 'hello.txt'), 'hello\n');
    await fs.mkdir(path.join(demoPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(demoPath, 'src', 'main.py'), 'print(1)\n');
    await fs.writeFile(path.join(demoPath, '.env'), 'API_KEY=hunter2hunter2\n');
    await fs.writeFile(path.join(demoPath, 'deploy.pem'), '-----BEGIN PRIVATE KEY-----\n');
    await fs.mkdir(path.join(demoPath, 'node_modules', 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(demoPath, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n');
    const exported = await owner.get('/api/workspace/export?name=demo', { binary: true });
    assert.equal(exported.status, 200);
    assert.equal(exported.headers['content-type'], 'application/gzip');
    assert.match(exported.headers['content-disposition'], /attachment; filename="demo\.tar\.gz"/);
    const entries = await archiveEntries(exported.buffer, scratch);
    for (const wanted of ['hello.txt', 'src/main.py']) assert.ok(entries.includes(wanted), `${wanted} must be exported: ${entries.join(',')}`);
    for (const entry of entries) assert.ok(!/(^|\/)(\.git|node_modules)(\/|$)|(^|\/)\.env|\.pem$/.test(entry), `${entry} must not be exported`);
    for (const name of ['nope', '../ws/demo', '', 'demo/../second']) {
      const response = await owner.get(`/api/workspace/export?name=${encodeURIComponent(name)}`);
      assert.deepEqual([response.status, response.json?.code], [404, 'workspace_unknown'], `export ${JSON.stringify(name)}`);
    }
    const anonymous = await anon.get('/api/workspace/export?name=demo');
    assert.deepEqual([anonymous.status, anonymous.json?.code], [401, 'login_required']);
    ok('export: a .tar.gz of the working tree without .git, node_modules, .env and key files; unknown or traversing names are 404; a stranger gets 401');
  }

  {
    const removed = await owner.post('/api/workspace/delete', { name: 'demo' });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.json.removed.wasCurrent, true);
    assert.equal(removed.json.workspace.path, null, 'the selected workspace is unselected');
    await assert.rejects(fs.lstat(demoPath));
    const again = await owner.post('/api/workspace/delete', { name: 'demo' });
    assert.deepEqual([again.status, again.json?.code], [404, 'workspace_unknown']);
    assert.deepEqual((await owner.get('/api/workspace/list')).json.items.map((item) => item.name), ['second']);
    ok('delete: the selected workspace is removed from disk and the registry and unselected; deleting it twice is 404');
  }

  {
    const out = await owner.post('/api/auth/logout', {});
    assert.equal(out.status, 200);
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
    const after = await owner.get('/api/state');
    assert.deepEqual([after.status, after.json?.code], [401, 'login_required'], 'the old cookie no longer works');
    const second = new Visitor(port);
    assert.equal((await second.login()).status, 200, 'logging in again works');
    assert.notEqual(second.cookie, owner.cookie);
    ok('logout ends the session on the server (the old cookie is dead) and a new login works');
  }

  {
    // A good login clears the address's failures, so the count starts from nothing here: eight wrong tokens are answered 401 (the limit is eight).
    const keeper = new Visitor(port);
    assert.equal((await keeper.login()).status, 200, 'this session was made before the throttle');
    const refusals = [];
    for (let attempt = 0; attempt < 8; attempt += 1) refusals.push((await anon.login(`wrong-${attempt}-wrong-${attempt}-wrong-${attempt}-xx`)).status);
    assert.deepEqual(refusals, Array(8).fill(401), 'every one of the eight is a plain wrong token');
    const blocked = await anon.login();
    assert.deepEqual([blocked.status, blocked.json?.code], [429, 'too_many_attempts'], 'once the limit is reached even the right token is refused');
    assert.ok(Number(blocked.headers['retry-after']) >= 1 && Number(blocked.headers['retry-after']) <= 900, `Retry-After ${blocked.headers['retry-after']}`);
    assert.ok(!blocked.headers['set-cookie'], 'and no session is handed out');
    assert.equal((await keeper.get('/api/state')).status, 200, 'a session that exists is not affected by the throttle');
    assert.equal((await anon.get('/healthz')).status, 200, 'nor is the health probe');
    ok('login throttle: after the eighth wrong token from one address even the right token gets 429 too_many_attempts with Retry-After and no cookie, while existing sessions and the health probe keep working');
  }

  {
    const stopped = await hub.stop({ graceMs: 20_000 });
    assert.ok(!stopped.forced, `the Hub should end on SIGTERM by itself: ${JSON.stringify(stopped)}`);
    const log = hub.log();
    assert.ok(log.length > 0);
    const leaks = filesMentioning(scratch, SECRETS);
    assert.deepEqual(leaks, [], `a secret was found in: ${leaks.join(', ')}`);
    assert.ok(!log.includes('hunter2hunter2'), 'nor is a file of the workspace in the log');
    ok('the owner token and the GitHub token are nowhere on disk (state folder, workspaces, registry, log); the Hub ends on SIGTERM');
  }
}

// ================================================================================================================================
// Part A2 - the same server behind the platform's TLS proxy, configured the way Render configures it (render.yaml)
// ================================================================================================================================
{
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-e2e-render-'));
  temporary.push(scratch);
  const port = await freePort();
  const publicName = 'chatmcp-test.onrender.com';
  const stateDir = path.join(scratch, 'state');
  await fs.mkdir(stateDir, { recursive: true });
  // RENDER and RENDER_EXTERNAL_HOSTNAME are what the platform sets; CHATMCP_HOST keeps this test off the network (the default is 0.0.0.0).
  const env = cleanEnvironment(scratch, {
    CHATMCP_PUBLIC: '1', CHATMCP_OWNER_TOKEN: OWNER_TOKEN, RENDER: 'true', RENDER_EXTERNAL_HOSTNAME: publicName, PORT: String(port), CHATMCP_HOST: '127.0.0.1',
    CHATMCP_WORKSPACES_ROOT: path.join(scratch, 'ws'), CHATMCP_EXEC_MODE: 'no-shell', CHATMCP_LOGIN_FAILURE_DELAY_MS: '0',
  });
  const hub = launch(process.execPath, [path.join(HUB_ROOT, 'hub.mjs'), '--backend', 'local', '--state-dir', stateDir, '--no-open'], { env, cwd: HUB_ROOT, logFile: path.join(scratch, 'hub.log') });
  await healthy(port, hub);
  const origin = `https://${publicName}`;
  const behindProxy = (client, extra = {}) => new Visitor(port, { host: publicName, origin, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': `${client}, 10.0.0.1`, ...extra } });
  const direct = new Visitor(port, { host: publicName, origin }); // no proxy header at all

  {
    const probe = await request(port, { pathname: '/healthz', host: '10.0.0.5:10000' });
    assert.deepEqual([probe.status, probe.json], [200, { ok: true }], 'the platform\'s probe comes to the container\'s own address, with no forwarded protocol');
    for (const proto of [undefined, 'http', 'https, http', 'ftp', '', 'httpss']) {
      const response = await direct.get('/', { headers: proto === undefined ? {} : { 'x-forwarded-proto': proto } });
      assert.deepEqual([response.status, response.json?.code], [400, 'https_required'], `x-forwarded-proto ${JSON.stringify(proto)}`);
    }
    for (const proto of ['https', 'HTTPS', ' https ', 'http, https']) {
      const response = await direct.get('/', { headers: { 'x-forwarded-proto': proto } });
      assert.equal(response.status, 200, `x-forwarded-proto ${JSON.stringify(proto)}: the last value, written by the proxy closest to the Hub, is the one that counts`);
    }
    ok('HTTPS is required: no header, http, ftp, an empty or misspelled value, or "https, http" (a client\'s own "https" in front of the proxy\'s "http") are 400 https_required; https in any case, or "http, https", is accepted');
  }

  {
    const secure = behindProxy('203.0.113.9');
    for (const host of ['evil.example', `${publicName}.evil.example`, `${publicName}:8443`, 'chatmcp-test', `evil.example/${publicName}`]) {
      const response = await secure.get('/', { host });
      assert.deepEqual([response.status, response.json?.code], [403, 'host_denied'], `Host ${host}`);
    }
    for (const host of [publicName, `${publicName}:443`, publicName.toUpperCase(), `${publicName}.`]) {
      const response = await secure.get('/', { host });
      assert.equal(response.status, 200, `Host ${host}`);
    }
    const page = await secure.get('/');
    const header = (name) => page.headers[name];
    assert.equal(header('strict-transport-security'), 'max-age=31536000');
    assert.equal(header('x-frame-options'), 'DENY');
    assert.equal(header('x-content-type-options'), 'nosniff');
    assert.equal(header('cache-control'), 'no-store');
    assert.equal(header('referrer-policy'), 'no-referrer');
    assert.equal(header('cross-origin-opener-policy'), 'same-origin');
    assert.equal(header('cross-origin-resource-policy'), 'same-origin');
    assert.equal(header('x-robots-tag'), 'noindex, nofollow');
    assert.match(header('content-security-policy'), /^default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; .*frame-ancestors 'none'; .*frame-src 'none'$/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(header('content-security-policy')));
    ok('only RENDER_EXTERNAL_HOSTNAME is a valid Host (":443" and a trailing dot or capitals are the same name, anything else is 403 host_denied); every response carries HSTS, no-store, nosniff, frame, opener and robots headers and a CSP without unsafe-inline');
  }

  const owner = behindProxy('203.0.113.9');
  {
    for (const wrong of ['http://' + publicName, 'https://evil.example', `https://${publicName}.evil.example`, 'null']) {
      const response = await behindProxy('203.0.113.20').request({ method: 'POST', pathname: '/api/auth/login', headers: { origin: wrong }, body: { token: OWNER_TOKEN } });
      assert.deepEqual([response.status, response.json?.code], [403, 'origin_denied'], `Origin ${wrong}`);
      assert.ok(!response.headers['set-cookie']);
    }
    const sameWithPort = await behindProxy('203.0.113.21').request({ method: 'POST', pathname: '/api/auth/login', headers: { origin: `https://${publicName}:443` }, body: { token: OWNER_TOKEN } });
    assert.equal(sameWithPort.status, 200, 'the default HTTPS port is the same origin');
    const good = await owner.login();
    assert.equal(good.status, 200);
    assert.match(String(good.headers['set-cookie']), /^__Host-chatmcp_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/, 'a __Host- cookie: Secure, Path=/, no Domain');
    assert.ok(!/domain=/i.test(String(good.headers['set-cookie'])));
    const downgraded = await owner.post('/api/workspace/create', { name: 'x' }, { origin: 'http://' + publicName });
    assert.deepEqual([downgraded.status, downgraded.json?.code], [403, 'origin_denied'], 'with a valid session and CSRF token, a request from the http:// origin is still refused');
    ok('behind HTTPS the only Origin that logs in is https://<the host> (not http://, not another host, not "null"); the cookie is __Host-chatmcp_session with Secure, HttpOnly, SameSite=Strict, Path=/ and no Domain');
  }

  {
    const addressOf = async (forwardedFor) => (await owner.get('/api/auth/session', { headers: forwardedFor === undefined ? { 'x-forwarded-for': undefined } : { 'x-forwarded-for': forwardedFor } })).json;
    const behind = await addressOf('6.6.6.6, 203.0.113.9, 10.0.0.1');
    assert.deepEqual([behind.authenticated, behind.clientAddress, behind.proxyHops], [true, '203.0.113.9', 2], 'two proxies are trusted on Render: the address two places from the right, whatever the client wrote before it');
    assert.equal((await addressOf('203.0.113.9')).clientAddress, '127.0.0.1', 'a chain shorter than the trusted hops is not believed: the TCP peer is used');
    assert.equal((await addressOf('not-an-address, 10.0.0.1')).clientAddress, '127.0.0.1', 'and an entry that is not an address is not believed either');
    assert.equal((await addressOf(undefined)).clientAddress, '127.0.0.1');
    assert.equal((await addressOf('2001:db8:1:2:3:4:5:6, 10.0.0.1')).clientAddress, '2001:0db8:0001:0002::/64', 'an IPv6 client is throttled as its whole /64');
    ok('the client address is read from X-Forwarded-For the way the configured hops say (default 2 on Render), never from what the client put at the left, and IPv6 clients count as their /64');
  }

  {
    // An attacker who changes the left of X-Forwarded-For on every attempt must not get a fresh allowance each time.
    const attacker = (i) => behindProxy('203.0.113.50', { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.50, 10.0.0.1` });
    const statuses = [];
    for (let i = 1; i <= 5; i += 1) statuses.push((await attacker(i).login('wrong-token-wrong-token-wrong-token-')).status);
    assert.deepEqual(statuses, Array(5).fill(401));
    const blocked = await attacker(99).login();
    assert.deepEqual([blocked.status, blocked.json?.code], [429, 'too_many_attempts'], 'the sixth attempt is refused even with the right token');
    const bystander = behindProxy('203.0.113.51');
    assert.equal((await bystander.login()).status, 200, 'another client address is not affected');
    ok('login throttle behind the proxy: five wrong tokens from one client address (rotating the forged left part of X-Forwarded-For) block that address, not others');
  }

  {
    const stopped = await hub.stop({ graceMs: 20_000 });
    assert.ok(!stopped.forced, `the Hub should end on SIGTERM by itself: ${JSON.stringify(stopped)}`);
    assert.deepEqual(filesMentioning(scratch, SECRETS), []);
    ok('the Hub ends on SIGTERM (what the platform sends) and the owner token is nowhere on disk');
  }
}

// ================================================================================================================================
// Part B - the real supervisor: the Hub as its own user, commands as the agent
// ================================================================================================================================
const real = await realAccountsAvailable();
if (!real.ok) {
  notApplicable(`Part B (the supervisor with real accounts): ${real.reason}`);
} else {
  const { tools, ids, tempRoot } = real;
  const { found: P } = await findPrograms(['sh', 'sleep', 'setsid', 'git', 'test']);
  const reason = await (async () => {
    if (!P.git || !P.sh || !P.test) return 'git, sh or test is missing';
    for (const [who, uid] of [['hub', ids.hub], ['agent', ids.agent]]) {
      const readable = spawnSync(tools.setpriv, [`--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', '--', P.test, '-r', path.join(HUB_ROOT, 'hub.mjs')]);
      if (readable.status !== 0) return `the ${who} account cannot read ${HUB_ROOT} (every folder above it must be traversable by others)`;
      const node = spawnSync(tools.setpriv, [`--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', '--', process.execPath, '--version']);
      if (node.status !== 0) return `the ${who} account cannot run ${process.execPath}`;
    }
    return null;
  })();
  if (reason) {
    notApplicable(`Part B (the supervisor with real accounts): ${reason}`);
  } else {
    const base = await fs.realpath(await fs.mkdtemp(path.join(tempRoot, 'chatmcp-e2e-sv-')));
    temporary.push(base);
    await fs.chmod(base, 0o755);
    const port = await freePort();
    const dataRoot = path.join(base, 'data');
    const socket = path.join(base, 'run', 'broker.sock');
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin', HOME: base, CHATMCP_NO_OPEN: '1',
      CHATMCP_HUB_USER: 'chatmcp-test-hub', CHATMCP_AGENT_USER: 'chatmcp-test-agent', CHATMCP_WS_GROUP: 'chatmcp-test-ws',
      CHATMCP_HUB_UID: String(ids.hub), CHATMCP_HUB_GID: String(ids.hub), CHATMCP_AGENT_UID: String(ids.agent), CHATMCP_AGENT_GID: String(ids.agent), CHATMCP_WS_GID: String(ids.ws),
      CHATMCP_DATA_ROOT: dataRoot, CHATMCP_EXEC_BROKER: socket, CHATMCP_AGENT_HOME: path.join(base, 'agent-home'), CHATMCP_NO_HOOKS_DIR: path.join(base, 'no-hooks'),
      CHATMCP_PUBLIC: '1', CHATMCP_OWNER_TOKEN: OWNER_TOKEN, CHATMCP_ALLOWED_HOSTS: `127.0.0.1:${port}`, CHATMCP_ALLOW_INSECURE_HTTP: '1', CHATMCP_HOST: '127.0.0.1', PORT: String(port),
      CHATMCP_MAX_WORKSPACES: '3', CHATMCP_LOGIN_FAILURE_DELAY_MS: '0', CHATMCP_COMMAND_MAX_SECONDS: '60', GITHUB_TOKEN,
    };
    const supervisor = launch(process.execPath, [SUPERVISOR], { env, cwd: base, logFile: path.join(base, 'supervisor.log') });
    try {
      await healthy(port, supervisor);
      const owner = new Visitor(port);
      assert.equal((await owner.login()).status, 200);

      const hubProcess = await (async () => {
        for (const name of readdirSync('/proc')) {
          if (!/^[1-9]\d*$/.test(name)) continue;
          let cmdline;
          let status;
          try { cmdline = readFileSync(`/proc/${name}/cmdline`, 'latin1').split('\0'); status = readFileSync(`/proc/${name}/status`, 'utf8'); } catch { continue; }
          if (cmdline.some((word) => word.endsWith(`${path.sep}hub.mjs`)) && /^Uid:\s+(\d+)/m.exec(status)?.[1] === String(ids.hub)) return { pid: Number(name), status };
        }
        return null;
      })();
      assert.ok(hubProcess, 'the Hub process is running as the hub account');

      {
        const state = await owner.state();
        assert.equal(state.publicMode.execMode, 'broker', `the supervisor proved the separation, so commands are on:\n${supervisor.log().slice(-1500)}`);
        // The second proof is made 0.8 s after the Hub starts, against the Hub's own process; it is in the log by the time the first command ran.
        await waitFor(() => supervisor.log().includes('Kiểm tra lần hai với tiến trình server thật') || null, { timeoutMs: 15_000, intervalMs: 100, label: 'the supervisor\'s second proof against the running server' });
        const log = supervisor.log();
        assert.ok(!/DỪNG|CẢNH BÁO/.test(log), `the supervisor reported a problem:\n${log.slice(-1500)}`);
        assert.match(log, /Đã chứng minh tách quyền trên máy này \(12 kiểm tra đạt\)/, 'the first proof: all twelve checks');
        assert.ok(log.includes(`uid ${ids.agent}`), 'and says which account the agent\'s commands run as');
        assert.equal(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(hubProcess.status).slice(1).join(','), Array(4).fill(ids.hub).join(','), 'the Hub\'s four uids are the hub account\'s');
        assert.match(/^CapEff:\s*(\S+)/m.exec(hubProcess.status)[1], /^0+$/, 'the Hub holds no capability');
        assert.equal(/^NoNewPrivs:\s*(\d)/m.exec(hubProcess.status)[1], '1');
        const socketStat = await fs.lstat(socket);
        assert.deepEqual([socketStat.uid, socketStat.gid, socketStat.mode & 0o777], [0, ids.hub, 0o660]);
        ok('the supervisor started the Hub as the hub account (no capability, no_new_privs), proved the separation twice, and the page reports execMode "broker"');
      }

      /** Runs a command through the terminal route, as the page does, and waits for it to end. */
      const terminal = async (command) => {
        const started = await owner.post('/api/studio/terminal/start', { command, timeoutMinutes: 1 });
        assert.equal(started.status, 200, started.text);
        const session = await waitFor(async () => {
          const list = (await owner.get('/api/studio/terminal')).json;
          const mine = list.find((item) => item.id === started.json.id);
          return mine && mine.status !== 'running' ? mine : null;
        }, { timeoutMs: 40_000, intervalMs: 100, label: `the command ${JSON.stringify(command.slice(0, 40))} to end` });
        return { status: session.status, exitCode: session.exitCode, text: session.logs.map((entry) => entry.message).join('') };
      };

      const created = await owner.post('/api/workspace/create', { name: 'proj' });
      assert.equal(created.status, 200, created.text);
      const projPath = path.join(dataRoot, 'workspaces', 'proj');

      {
        const result = await terminal('id -u; id -G; umask; pwd; sed -n "s/^CapEff:[[:space:]]*//p;s/^NoNewPrivs:[[:space:]]*//p" /proc/self/status');
        assert.equal(result.exitCode, 0, result.text);
        const lines = result.text.trim().split('\n');
        assert.equal(lines[0], String(ids.agent), 'the command runs as the agent\'s uid');
        assert.deepEqual(lines[1].split(/\s+/).map(Number).sort(), [ids.agent, ids.ws].sort(), 'with the agent\'s group and the shared group only');
        assert.equal(lines[2], '0002');
        assert.equal(lines[3], await fs.realpath(projPath), 'in the selected workspace');
        assert.match(lines[4], /^0+$/);
        assert.equal(lines[5], '1');
        ok('a terminal command runs as the agent: its uid and groups, umask 002, in the workspace, no capability, no_new_privs');
      }

      {
        const environ = `/proc/${hubProcess.pid}/environ`;
        const result = await terminal([
          `if cat ${environ} >/dev/null 2>&1; then echo ENVIRON=readable; else echo ENVIRON=denied; fi`,
          `if kill -0 ${hubProcess.pid} 2>/dev/null; then echo SIGNAL=allowed; else echo SIGNAL=denied; fi`,
          `if ls ${path.join(dataRoot, 'state')} >/dev/null 2>&1; then echo STATE=listable; else echo STATE=denied; fi`,
          `if ls ${path.join(dataRoot, 'home')} >/dev/null 2>&1; then echo HUBHOME=listable; else echo HUBHOME=denied; fi`,
          `if [ -w ${socket} ]; then echo SOCKET=writable; else echo SOCKET=denied; fi`,
          `if (: > ${path.join(dataRoot, 'workspaces')}/x) 2>/dev/null; then echo WORKSPACES=writable; else echo WORKSPACES=readonly; fi`,
          `if (: > ${path.join(base, 'no-hooks')}/pre-commit) 2>/dev/null; then echo HOOKS=writable; else echo HOOKS=readonly; fi`,
          'echo ENVNAMES=$(env | cut -d= -f1 | sort | tr "\\n" " ")',
          'echo LONGVALUES=$(env | grep -c -E "=([A-Za-z0-9_-]{40,}|github_pat_.*)$" || true)',
        ].join('\n'));
        const seen = Object.fromEntries(result.text.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));
        assert.deepEqual(
          { ENVIRON: seen.ENVIRON, SIGNAL: seen.SIGNAL, STATE: seen.STATE, HUBHOME: seen.HUBHOME, SOCKET: seen.SOCKET, WORKSPACES: seen.WORKSPACES, HOOKS: seen.HOOKS, LONGVALUES: seen.LONGVALUES },
          { ENVIRON: 'denied', SIGNAL: 'denied', STATE: 'denied', HUBHOME: 'denied', SOCKET: 'denied', WORKSPACES: 'readonly', HOOKS: 'readonly', LONGVALUES: '0' },
          result.text,
        );
        const names = seen.ENVNAMES.split(/\s+/).filter(Boolean);
        const suspicious = names.filter((name) => /TOKEN|SECRET|PASSWORD|OWNER|GITHUB|API_?KEY/i.test(name) || (name.startsWith('CHATMCP_') && name !== 'CHATMCP_WORKSPACE'));
        assert.deepEqual(suspicious, [], `variables the agent should not see: ${names.join(' ')}`);
        ok('from inside a terminal command: the Hub\'s environment, process, state and home are out of reach, the broker socket cannot be opened, the workspaces folder and hooks folder are read-only, and the environment holds no token, no key and no Hub setting');
      }

      {
        const result = await terminal('printf "hello\\n" > a.txt && mkdir -p src && echo "print(1)" > src/m.py && git add -A && git commit -q -m first && git log --oneline | wc -l && git config user.email');
        assert.equal(result.exitCode, 0, result.text);
        assert.deepEqual(result.text.trim().split('\n').map((line) => line.trim()), ['1', 'agent@chatmcp.invalid']);
        const stat = await fs.lstat(path.join(projPath, 'a.txt'));
        assert.deepEqual([stat.uid, stat.gid, stat.mode & 0o777], [ids.agent, ids.ws, 0o664], 'files the agent makes belong to the agent and the shared group, and the Hub can write them');
        const exported = await owner.get('/api/workspace/export?name=proj', { binary: true });
        assert.equal(exported.status, 200);
        const entries = await archiveEntries(exported.buffer, base);
        assert.ok(entries.includes('a.txt') && entries.includes('src/m.py'), entries.join(','));
        assert.ok(!entries.some((entry) => /(^|\/)\.git(\/|$)/.test(entry)));
        ok('the agent edits and commits in the workspace with Git; the files are the agent\'s with the shared group (mode 664), and the Hub exports them (tar run as the agent) without .git');
      }

      {
        // The agent turns a hook on in its own repository (a repository-level core.hooksPath beats the account's empty hooks folder). That is
        // the agent's right on its own account - and the proof that the hook is live. The Hub never runs Git inside a workspace after it made
        // it (a push is built from a bundle the agent makes, in a scratch repository of the Hub's), so none of its operations can fire it.
        const hook = path.join(projPath, 'hook-ran');
        const planted = await terminal(`mkdir -p .git/hooks && printf '#!/bin/sh\\nid -u > "$PWD/hook-ran"\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && git config core.hooksPath .git/hooks && echo b > b.txt && git add b.txt && git commit -q -m second && cat hook-ran`);
        assert.equal(planted.exitCode, 0, planted.text);
        assert.equal(planted.text.trim(), String(ids.agent), 'positive control: the hook ran, as the agent');
        const made = await fs.lstat(hook);
        assert.equal(made.uid, ids.agent);
        await fs.rm(hook);
        const before = await owner.state();
        assert.equal((await owner.get('/api/workspace/list')).status, 200);
        assert.equal((await owner.post('/api/workspace/select', { path: projPath })).status, 200);
        const exported = await owner.get('/api/workspace/export?name=proj', { binary: true });
        assert.equal(exported.status, 200);
        const pushed = await owner.post('/api/workspace/push', { name: 'proj' });
        assert.deepEqual([pushed.status, pushed.json?.code], [409, 'push_unsupported']);
        assert.equal((await owner.state()).workspace.path, before.workspace.path);
        await assert.rejects(fs.lstat(hook), 'listing, selecting, exporting and the push check did not run the hook');
        ok('a hook the agent turns on in its own repository runs as the agent (positive control), and none of the Hub\'s operations on the workspace - list, select, export, push check - runs it');
      }

      {
        const left = await terminal(`(${P.sleep} 300 &) ; ${P.setsid ? `(${P.setsid} ${P.sleep} 300 &)` : ':'} ; echo left-behind`);
        assert.equal(left.exitCode, 0, left.text);
        await waitFor(async () => (await listProcessesOfUid(ids.agent)).length === 0, { timeoutMs: 8000, intervalMs: 100, label: 'the broker to stop what the command left behind' });
        const hostile = await terminal('mkdir -p d/e/h && echo x > d/e/h/i && echo y > d/g && chmod 000 d/e/h d/e && chmod 500 d && echo built');
        assert.equal(hostile.exitCode, 0, hostile.text);
        const removed = await owner.post('/api/workspace/delete', { name: 'proj' });
        assert.equal(removed.status, 200, `a tree the agent made without permissions must not make the workspace undeletable: ${removed.text}`);
        await assert.rejects(fs.lstat(projPath));
        assert.deepEqual((await owner.get('/api/workspace/list')).json.items, []);
        ok('what a command leaves running is stopped when it ends, and a workspace holding a tree with mode 000/500 is still deleted through the page');
      }

      {
        const gone = await supervisor.stop({ graceMs: 25_000 });
        assert.ok(!gone.forced, `the supervisor should end on SIGTERM by itself: ${JSON.stringify(gone)}`);
        assert.deepEqual(await listProcessesOfUid(ids.agent), [], 'no process of the agent is left');
        assert.deepEqual(await listProcessesOfUid(ids.hub), [], 'nor of the hub');
        await assert.rejects(fs.lstat(socket), 'the broker socket is gone');
        const leaks = filesMentioning(base, SECRETS);
        assert.deepEqual(leaks, [], `a secret was found in: ${leaks.join(', ')}`);
        ok('SIGTERM stops the Hub and the broker, kills every process of the hub and agent accounts, removes the socket - and neither token is on disk anywhere');
      }
    } finally {
      supervisor.killTree();
      await reapAgentProcesses(ids.agent).catch(() => {});
      await reapAgentProcesses(ids.hub).catch(() => {});
    }
  }
}

console.log(`PASS (${checks} checks${notes.length ? `; ${notes.length} not applicable here: ${notes.join('; ')}` : ''})`);
