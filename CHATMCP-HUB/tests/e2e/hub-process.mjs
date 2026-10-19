// Runs the real Hub (hub.mjs) as a child process for the end-to-end tests and talks to it over HTTP, the way the page does.
//
// Nothing here is mocked. The Hub starts with the local backend, its own state folder and a scrubbed environment (no
// credential from the machine reaches it, and Git ignores the machine's own configuration), and the test then configures it
// the way a person would through the UI: pick a folder, connect a model, choose a permission mode, send a request.
//
// A Hub can be stopped politely (`stop()`), or killed on the spot (`kill()`, SIGKILL / TerminateProcess) to see what the
// next start finds on disk. That is how the session-recovery test simulates a crash.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSession } from '../../lib/hub-session.mjs';

export const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREDENTIAL_LIKE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^OPENAI_|^ANTHROPIC_|^GEMINI_|^GOOGLE_|^OPENROUTER_|^DEEPSEEK_|^GROQ_|^MISTRAL_|^CHATMCP_|PROXY)/i;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns something truthy; the last error or value goes into the failure message. */
export async function waitFor(check, { timeoutMs = 20_000, intervalMs = 100, label = 'the condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      if (error?.fatal) throw error; // the thing waited for can no longer happen (the Hub exited): do not wait out the timeout
      last = error;
    }
    if (Date.now() >= deadline) {
      const shown = last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300);
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label} (last: ${shown})`);
    }
    await sleep(intervalMs);
  }
}

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * The caller's environment minus anything that looks like a credential or a proxy, with HOME pointing at the scratch folder.
 * Git is told to ignore the machine's own configuration so every run behaves the same.
 */
export function cleanEnvironment(home, extra = {}) {
  const env = {};
  // GIT_* is dropped as a whole: a machine that sets GIT_CONFIG_COUNT (or an author, or a directory) must not change what a test sees.
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !CREDENTIAL_LIKE.test(name) && !/^GIT_/i.test(name)) env[name] = value;
  const gitConfig = path.join(home, 'empty.gitconfig');
  if (!fs.existsSync(gitConfig)) fs.writeFileSync(gitConfig, '');
  Object.assign(env, {
    HOME: home, USERPROFILE: home, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', CHATMCP_NO_OPEN: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: '0',
  });
  return Object.assign(env, extra);
}

export class HubProcess {
  constructor({ child, port, logFile, stateDir, secret }) {
    this.child = child;
    this.port = port;
    this.logFile = logFile;
    this.stateDir = stateDir;
    this.secret = secret;
    this.csrf = null;
    this.exitInfo = null;
    this.exited = new Promise((resolve) => child.once('exit', (code, signal) => { this.exitInfo = { code, signal }; resolve(this.exitInfo); }));
  }

  get origin() { return `http://127.0.0.1:${this.port}`; }
  get pid() { return this.child.pid; }
  get running() { return this.exitInfo === null; }
  logText() { try { return fs.readFileSync(this.logFile, 'utf8'); } catch { return ''; } }

  /** The per-launch bearer every API call (reads included) must carry. */
  get authorization() { return `Bearer ${this.secret}`; }
  get authHeaders() { return { authorization: this.authorization }; }
  /** The session file the Hub published for local clients (null while there is none). */
  session() { return readSession(this.stateDir); }

  async csrfToken() {
    if (!this.csrf) this.csrf = (await (await fetch(`${this.origin}/api/state`, { headers: this.authHeaders })).json()).csrfToken;
    return this.csrf;
  }

  /**
   * One HTTP call. Every call carries the bearer (`auth: false` sends none, to test the refusal); POSTs also carry the
   * headers the Hub demands of the page (Origin, request marker, CSRF token).
   */
  async request(method, route, body, { csrf = true, headers = {}, auth = true } = {}) {
    const init = { method, headers: { ...(auth ? this.authHeaders : {}), ...headers } };
    if (method !== 'GET') {
      Object.assign(init.headers, { 'content-type': 'application/json', origin: this.origin, 'x-chatmcp-request': 'local-dashboard' });
      if (csrf) init.headers['x-chatmcp-csrf'] = await this.csrfToken();
      init.body = JSON.stringify(body ?? {});
    }
    const response = await fetch(this.origin + route, init);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON (a report, an error page) */ }
    return { status: response.status, ok: response.ok, json, text };
  }

  async get(route) { return this.request('GET', route); }

  /** POST that must succeed; the failure message carries the Hub's own explanation. */
  async post(route, body = {}) {
    const response = await this.request('POST', route, body);
    if (!response.ok) throw new Error(`POST ${route} -> ${response.status}: ${(response.json?.error ?? response.text).toString().slice(0, 300)}`);
    return response.json;
  }

  async state() { return (await this.get('/api/state')).json; }
  async task(id) { return (await this.get(`/api/tasks/${id}`)).json; }

  /** A request with a Host header of the caller's choosing (fetch will not let a script set one). */
  rawRequest({ method = 'GET', route = '/api/health', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: this.port, method, path: route, headers }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.setTimeout(10_000, () => request.destroy(new Error('timeout')));
      if (body !== null) request.write(body);
      request.end();
    });
  }

  /** A crash: no shutdown handler runs, no file is flushed. Children the Hub started are left to fend for themselves. */
  async kill() {
    if (this.running) { try { process.kill(this.pid, 'SIGKILL'); } catch { /* already gone */ } }
    await this.exited;
  }

  /** Stops the Hub and everything it started (the end of a test, whether it passed or not). */
  killTree() {
    if (!this.running) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-this.pid, 'SIGKILL'); } catch { try { process.kill(this.pid, 'SIGKILL'); } catch { /* gone */ } } }
  }

  /** Politely, through the shutdown route; if that does not end the process soon, by force. */
  async stop({ graceMs = 8000 } = {}) {
    if (!this.running) return this.exitInfo;
    try { await this.request('POST', '/api/hub/shutdown', {}); } catch { /* it may already be closing */ }
    const outcome = await Promise.race([this.exited, sleep(graceMs).then(() => null)]);
    if (outcome) return outcome;
    this.killTree();
    return this.exited;
  }
}

/**
 * Starts a Hub with the local backend. `scratch` holds its log and the empty Git config; `stateDir` is where it keeps its data
 * (reuse the same one to model a restart). Resolves when /api/health says the Hub finished initialising.
 */
export async function startHub({ scratch, stateDir = path.join(scratch, 'state'), project = null, port = 0, logName = 'hub.log', env = {}, timeoutMs = 45_000, secret = randomBytes(32).toString('hex') } = {}) {
  if (!scratch) throw new TypeError('startHub needs a scratch folder');
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const chosenPort = port || await freePort();
  const logFile = path.join(scratch, logName);
  const log = fs.openSync(logFile, 'a');
  const argv = [path.join(HUB_ROOT, 'hub.mjs'), '--backend', 'local', '--port', String(chosenPort), '--state-dir', stateDir, '--no-open', ...(project ? ['--project', project] : [])];
  const child = spawn(process.execPath, argv, {
    cwd: HUB_ROOT, env: cleanEnvironment(scratch, { CHATMCP_HUB_SECRET: secret, ...env }), stdio: ['ignore', log, log], detached: process.platform !== 'win32', windowsHide: true,
  });
  fs.closeSync(log);
  const hub = new HubProcess({ child, port: chosenPort, logFile, stateDir, secret });
  try {
    await waitFor(async () => {
      if (!hub.running) throw Object.assign(new Error(`the Hub exited early (code ${hub.exitInfo.code}, signal ${hub.exitInfo.signal}):\n${hub.logText().slice(-1500)}`), { fatal: true });
      const health = await fetch(`${hub.origin}/api/health`).then((response) => response.json());
      return health.initialized === true ? health : null;
    }, { timeoutMs, intervalMs: 150, label: 'the Hub to answer /api/health' });
    // The published session must match the secret this Hub was given, and be there before "initialized" (what a client reads).
    const published = await hub.session();
    if (!published || published.secret !== hub.secret || published.port !== hub.port || published.pid !== hub.pid)
      throw new Error('the Hub did not publish the expected run/hub-session.json');
    // /api/health turns "initialized" before the Hub has finished starting the tools for the workspace (that goes on in the
    // background, and a task started in that gap is refused with 409). A person cannot click that fast; a script can, so wait for
    // what the page waits for: the tool catalogue is ready and nothing is busy.
    if (project) {
      await waitFor(async () => {
        if (!hub.running) throw Object.assign(new Error(`the Hub exited early (code ${hub.exitInfo.code}, signal ${hub.exitInfo.signal}):\n${hub.logText().slice(-1500)}`), { fatal: true });
        const state = await fetch(`${hub.origin}/api/state`, { headers: hub.authHeaders }).then((response) => response.json());
        return state.catalogReady === true && state.busy !== true ? state : null;
      }, { timeoutMs, intervalMs: 100, label: 'the workspace tools to be ready' });
    }
  } catch (error) {
    hub.killTree();
    throw error;
  }
  return hub;
}

// ----------------------------------------------------------------------------------------------------------------------
// What a person does in the UI, as calls
// ----------------------------------------------------------------------------------------------------------------------

/** Connects the Hub to a model server and runs the tool-calling check ("Lưu & kiểm tra"). Returns the check's result. */
export async function connectModel(hub, mock, { model = 'mock-coder', contextWindowTokens = undefined } = {}) {
  // Large-output fixtures may declare the mock model's actual context capacity.
  // Do not disable production compaction: preserve separate tests of bounded,
  // conservative fallback behavior for unconfigured real providers.
  await hub.post('/api/ai/config', {
    preset: 'ollama', apiBaseUrl: mock.url, model,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  });
  return hub.post('/api/ai/test', {});
}

export const setMode = (hub, mode) => hub.post('/api/studio/permissions/config', { mode });

export async function startTask(hub, prompt, options = {}) {
  return (await hub.post('/api/tasks/start', { prompt, ...options })).task;
}

export async function continueTask(hub, id, prompt) {
  return (await hub.post('/api/tasks/continue', { id, prompt })).task;
}

/** The task as the list in /api/state shows it. */
export async function taskSummary(hub, id) {
  return (await hub.state()).agent.tasks.find((task) => task.id === id) ?? null;
}

const ACTIVE = ['created', 'queued', 'planning', 'running', 'waiting_approval', 'verifying'];
/**
 * A task is settled when its state is a resting one AND the Hub has let go of it (`activeTaskId`). The state turns to
 * `completed` a moment before the workspace lock is released, and a new request in that gap is refused with 409.
 */
export function settledTask(state, id) {
  const task = state.agent.tasks.find((item) => item.id === id);
  return task && !ACTIVE.includes(task.state) && state.agent.activeTaskId !== id ? task : null;
}

export async function pendingApprovals(hub) {
  return (await hub.state()).studio.permissions.pending;
}

/** Waits until the task reaches one of `states` (canonical states: completed, paused, uncertain, waiting_approval...). */
export async function waitForState(hub, id, states, { timeoutMs = 30_000 } = {}) {
  const wanted = Array.isArray(states) ? states : [states];
  return waitFor(async () => {
    const state = await hub.state();
    const task = state.agent.tasks.find((item) => item.id === id);
    if (!task || !wanted.includes(task.state)) return null;
    return ACTIVE.includes(task.state) || state.agent.activeTaskId !== id ? task : null;
  }, { timeoutMs, label: `task ${id.slice(0, 8)} to reach ${wanted.join(' or ')}` });
}

/**
 * Answers every approval request the task raises until it reaches a resting state. `decide(request)` returns true to allow.
 * Returns the requests that were answered, in order, each with its decision.
 */
export async function answerApprovals(hub, id, decide, { timeoutMs = 60_000 } = {}) {
  const answered = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await hub.state();
    const pending = state.studio.permissions.pending.filter((request) => request.taskId === id);
    if (pending.length) {
      for (const request of pending) {
        const approved = Boolean(await decide(request));
        await hub.post('/api/studio/permissions/decide', { id: request.id, approved });
        answered.push({ ...request, approved });
      }
    } else {
      const task = settledTask(state, id);
      if (task) return { task, answered };
    }
    const task = state.agent.tasks.find((item) => item.id === id);
    if (Date.now() > deadline) throw new Error(`task ${id.slice(0, 8)} did not settle within ${timeoutMs} ms (state ${task?.state}); answered ${answered.length} request(s)`);
    await sleep(120);
  }
}
