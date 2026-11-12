// The ACP agent's way to the Hub: an HTTP client that is one more local client of the Hub, like the Node launcher (lib/launch.mjs) and the desktop shell, with the same trust.
//
// How it authenticates (docs/HUB-AUTH.md, "Clients"): the secret of the Hub is in run/hub-session.json of its state folder, a folder only the current user can read. It is presented only to
// the process that owns the listening socket of the port AND is the one the file names (assertSessionListener): a health answer proves nothing, any program that bound the port can send one.
// A POST also carries the Origin, the request marker and the CSRF token (from /api/state) that the Hub asks of the page, exactly as attachToRunningHub does for its one POST. Nothing here
// asks the Hub for anything new, and nothing weakens a rule of it.
//
// Two ways to have a Hub:
//   attached  a Hub is running on the port (the desktop app's, as a rule). It is never stopped by this code, and the only tasks it cancels are those the agent started.
//   owned     none is, and the agent may start one (the default; --no-start forbids it). It is started as a CHILD (lib/launch.mjs launchOwned) that shuts down when the agent ends,
//             however the agent ends, and the agent stops it first when it ends politely. Never on a port that something else answers.
//
// Which routes it may call is a list, in the code (ROUTES): the ones it needs, and none of the rest. The two it must never call, even by mistake, are named in FORBIDDEN_ROUTES: the one that
// switches the workspace of the desktop app and the one that changes the permission mode. The shutdown of the Hub is a route of an owned Hub and of no other.
import { parseArguments } from '../../hub.mjs';
import { assertSessionListener, bearerHeaders, hubRequiresBearer, mutationHeaders, readSession, sessionFile } from '../hub-session.mjs';
import { health as probeHealth, launchOwned } from '../launch.mjs';
import { portOpen, stopOwned } from '../runtime.mjs';
import { ERROR_CODES } from './rpc.mjs';

const APP_ID = 'chatmcp-local-hub';
const TASK_ROUTE = /^\/api\/tasks\/[0-9a-f-]{36}$/;

export const ROUTES = Object.freeze([
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/state' },
  { method: 'GET', path: '/api/tasks/:id' },
  { method: 'POST', path: '/api/workspaces/add' },
  { method: 'POST', path: '/api/tasks/start' },
  { method: 'POST', path: '/api/tasks/continue' },
  { method: 'POST', path: '/api/tasks/cancel' },
  { method: 'POST', path: '/api/studio/permissions/decide' }, // the answer of the editor to an approval request of its own task (the mode itself, /api/studio/permissions/config, is forbidden below)
]);
const OWNED_ROUTES = Object.freeze([{ method: 'POST', path: '/api/hub/shutdown' }]);

/** Never called, by any code path, for any Hub (the tests call each with the strongest permission and require a refusal). */
export const FORBIDDEN_ROUTES = Object.freeze([
  '/api/workspace/select', // switches the workspace of the desktop app, which is global to the Hub
  '/api/studio/permissions/config', // changes the permission mode: Review, Autonomous, Full Access
  '/api/ai/config', '/api/ai/clear-key', '/api/ai/profiles/upsert', '/api/ai/profiles/delete', '/api/ai/profiles/default',
  '/api/tasks/delete', '/api/tasks/auto-resume', '/api/tasks/accept-criterion',
  '/api/studio/file/save', '/api/studio/restore', '/api/studio/restore-checkpoint', '/api/studio/review/reject-created', '/api/studio/accept', '/api/studio/checkpoint',
  '/api/workspaces/remove', '/api/workspaces/activate', '/api/services/stop', '/api/session/ticket', '/api/session/redeem', '/api/update/download', '/api/update/check',
]);

/** Whether this agent may call `method route` on a Hub. `owned`: the Hub is one the agent started. */
export function routeAllowed(method, route, { owned = false } = {}) {
  if (typeof method !== 'string' || typeof route !== 'string') return false;
  if (FORBIDDEN_ROUTES.includes(route)) return false;
  const matches = (entry) => entry.method === method && (entry.path === '/api/tasks/:id' ? TASK_ROUTE.test(route) : entry.path === route);
  return ROUTES.some(matches) || (owned === true && OWNED_ROUTES.some(matches));
}

/** A failed call to the Hub: its status, its code and its own words. */
export class HubError extends Error {
  constructor({ status = null, code = null, hubMessage = '', message } = {}) {
    super(message ?? `HTTP ${status}${hubMessage ? `: ${hubMessage}` : ''}`);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
    this.hubMessage = hubMessage;
  }
}

const unavailable = (message) => Object.assign(new Error(message), { code: 'hub_unavailable' });

/**
 * The sentence for a failure of the Hub, in English, with the Hub's own words after it (they are often Vietnamese), and the JSON-RPC code the editor gets.
 * @param {{status?: number|null, code?: string|null, message?: string, hubMessage?: string}} failure
 * @returns {{code: number, message: string}}
 */
export function describeHubFailure(failure) {
  const { status = null, code = null } = failure ?? {};
  const said = String(failure?.hubMessage ?? failure?.message ?? '').trim();
  const tail = said ? ` (${said})` : '';
  const internal = (message) => ({ code: ERROR_CODES.INTERNAL, message });
  switch (code) {
    case 'provider_not_ready':
      return { code: ERROR_CODES.AUTH_REQUIRED, message: `DatGold has no model connected. Open DatGold, connect a model in Settings, then send the message again.${tail}` };
    case 'task_running': return internal(`DatGold is already running another task. Wait for it or stop it in DatGold, then try again.${tail}`);
    case 'hub_busy': return internal(`DatGold is busy with another operation. Try again in a moment.${tail}`);
    case 'unregistered_workspace': return internal(`DatGold does not know this workspace folder.${tail}`);
    case 'workspace_limit': return internal(`DatGold cannot take another workspace folder.${tail}`);
    case 'git_required': return internal(`This needs a Git repository with at least one commit (a second task in the same folder runs in its own Git worktree).${tail}`);
    case 'shutting_down': return internal(`DatGold is shutting down.${tail}`);
    case 'hub_auth_required': return internal(`The Hub no longer accepts the session of this agent (it was probably restarted). The next request connects to it again.${tail}`);
    default: break;
  }
  if (status === 413) return { code: ERROR_CODES.INVALID_PARAMS, message: `The message is too large for DatGold.${tail}` };
  if (status === null) return internal(`Could not reach the DatGold Hub${tail}`);
  return internal(`DatGold refused the request (HTTP ${status})${tail}`);
}

/**
 * The command line of the agent: --port (the Hub's own range), --state-dir, --no-start. An unknown word, a missing value and a repeated option are refused with a sentence.
 * The values are checked by the Hub's own parser, so the agent and the Hub cannot disagree on what a port or a folder is.
 */
export function parseCliArguments(argv, env = process.env) {
  const values = {};
  let start = true;
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === '--no-start') { if (!start) throw new Error('--no-start was given twice'); start = false; continue; }
    if (word !== '--port' && word !== '--state-dir') throw new Error(`Unknown argument ${JSON.stringify(String(word).slice(0, 60))}. Options: --port <number>, --state-dir <folder>, --no-start`);
    if (word in values) throw new Error(`${word} was given twice`);
    if (argv[i + 1] === undefined) throw new Error(`${word} needs a value`);
    values[word] = argv[(i += 1)];
  }
  const hubArguments = [];
  if ('--port' in values) hubArguments.push('--port', values['--port']);
  if ('--state-dir' in values) hubArguments.push('--state-dir', values['--state-dir']);
  let parsed;
  try { parsed = parseArguments(hubArguments, env); } catch (error) { throw new Error(`${error.message} (--port is a number from 1024 to 65535 except 3006)`); }
  return { port: parsed.port, stateDir: parsed.stateDir, start };
}

/** What `promise` settles with, or `fallback` after `ms`; the timer does not outlive the wait. */
function within(promise, ms, fallback = null) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback); })]).finally(() => clearTimeout(timer));
}

class HubConnection {
  #secret;
  #csrf = null;
  #child;
  #exited;
  #log;
  #timeoutMs;
  #stopping = null;
  #killOnExit = null;

  constructor({ origin, secret, child = null, exited = null, log = () => {}, timeoutMs = 20_000 }) {
    this.origin = origin;
    this.#secret = secret;
    this.#child = child;
    this.#exited = exited;
    this.#log = log;
    this.#timeoutMs = timeoutMs;
    this.owned = child !== null;
    if (child) {
      // The last resort when this process ends in a way that skips the polite stop (an uncaught exception): a Hub that this process started must not outlive it.
      this.#killOnExit = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
      process.once('exit', this.#killOnExit);
      void exited.then(() => process.removeListener('exit', this.#killOnExit));
    }
  }

  /** The credentials this connection holds, for the masking of everything that leaves the agent. */
  get secrets() { return [this.#secret, this.#csrf].filter(Boolean); }
  /** Resolves, with how it ended, when a Hub that the agent started ends. Never for an attached Hub (its life is not ours to watch). */
  get closed() { return this.#exited ?? new Promise(() => {}); }

  /** The CSRF token of the Hub: one value for the life of a Hub process, read once from /api/state. */
  async #csrfToken() {
    if (!this.#csrf) this.#csrf = (await this.#send('GET', '/api/state')).csrfToken ?? null;
    return this.#csrf;
  }

  async #send(method, route, body, { signal } = {}) {
    if (!routeAllowed(method, route, { owned: this.owned })) throw new HubError({ code: 'route_not_allowed', message: `${method} ${route} is not a route this agent may call` });
    const headers = method === 'GET' ? bearerHeaders(this.#secret) : mutationHeaders(this.origin, this.#secret, await this.#csrfToken());
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    let response;
    try {
      response = await fetch(this.origin + route, { method, headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) });
    } catch (error) {
      throw new HubError({ message: `${error?.cause?.code ?? error?.name ?? 'fetch failed'}: ${error?.message ?? ''}`.trim() });
    }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (response.ok) return json ?? {};
    throw new HubError({ status: response.status, code: json?.code ?? null, hubMessage: typeof json?.error === 'string' ? json.error : text.slice(0, 300) });
  }

  /** Reads /api/state with the secret: proves the Hub accepts it, and learns the CSRF token. */
  async verify() {
    const state = await this.#send('GET', '/api/state');
    this.#csrf = state.csrfToken ?? null;
    return state;
  }

  /** Puts the folder in the Hub's list of workspaces (the list the desktop app shows) WITHOUT selecting it. Idempotent. Returns the folder as the Hub keeps it. */
  async ensureWorkspace(cwd) {
    const answer = await this.#send('POST', '/api/workspaces/add', { path: cwd });
    return { path: answer.workspace?.path ?? cwd };
  }
  async startTask({ prompt, workspacePath }) { return (await this.#send('POST', '/api/tasks/start', { prompt, workspacePath })).task; }
  async continueTask({ id, prompt }) { return (await this.#send('POST', '/api/tasks/continue', { id, prompt })).task; }
  async cancelTask(id) { return (await this.#send('POST', '/api/tasks/cancel', { id })).task ?? null; }
  async getTask(id) {
    try { return await this.#send('GET', `/api/tasks/${id}`); } catch (error) { if (error instanceof HubError && error.status === 404) return null; throw error; }
  }
  /** Whether the Hub still holds the workspace for this task (it turns "completed" a moment before it lets go). */
  async isActive(id) {
    const state = await this.#send('GET', '/api/state');
    const active = state.agent?.activeTaskIds ?? (state.agent?.activeTaskId ? [state.agent.activeTaskId] : []);
    return active.includes(id);
  }

  /** The approval requests the Hub holds for one task (the list its dashboard shows), as it publishes them: the change it worked out is in `detail.preview` (docs/APPROVAL-PREVIEW.md). */
  async pendingApprovals(taskId) {
    const state = await this.#send('GET', '/api/state');
    const list = state.studio?.permissions?.pending;
    return Array.isArray(list) ? list.filter((request) => request !== null && typeof request === 'object' && request.taskId === taskId) : [];
  }
  /** Answers one request. False when the Hub no longer has it (answered in the desktop app, expired, or dropped with a task that was stopped). */
  async decide(id, approved) {
    try { await this.#send('POST', '/api/studio/permissions/decide', { id, approved: approved === true }); return true; }
    catch (error) { if (error instanceof HubError && error.status === 404) return false; throw error; }
  }

  // There is no stream of the Hub's events here on purpose: GET /api/tasks/events sends nothing in this build (the object the Hub keeps for it has no `subscribe`), so the task is polled.

  /**
   * Stops a Hub that the agent started, politely (the shutdown route, then the end of its stdin), and by force when it has not exited in 10 s. A Hub that was only attached to is never stopped:
   * this returns false and sends nothing (and the route list would refuse it).
   */
  stop() {
    if (!this.owned) return Promise.resolve(false);
    this.#stopping ??= (async () => {
      try { await this.#send('POST', '/api/hub/shutdown', {}, { signal: AbortSignal.timeout(3000) }); } catch (error) { this.#log(`the shutdown request failed (${error?.message ?? error}); closing the pipe of the Hub instead`); }
      try { this.#child.stdin.end(); } catch { /* the pipe is gone already */ }
      if (!(await within(this.#exited, 10_000))) {
        this.#log('the Hub did not exit in 10 s; stopping its process tree');
        await stopOwned(this.#child).catch((error) => this.#log(`could not stop the Hub: ${error?.message ?? error}`));
        await within(this.#exited, 5000);
      }
      return true;
    })();
    return this.#stopping;
  }
}

/**
 * Finds the Hub, or starts one. Rejects with an error whose `code` is `hub_unavailable` and whose message says what to do, for: a port that something else answers or holds, no Hub and no permission to
 * start one, a Hub of an older version (it has no secret to authenticate to, and is never reused), a session file that is missing, stale or not the listener's, and a Hub that does not start.
 * @param {{port: number, stateDir: string, start?: boolean, log?: (line: string) => void, env?: object, timeoutMs?: number, hubEntry?: string}} options
 *   `hubEntry` is for the tests only: the program to start in place of the Hub (a script that behaves badly on purpose). The agent's command line and its settings cannot reach it.
 * @returns {Promise<HubConnection>}
 */
export async function connectToHub({ port, stateDir, start = true, log = () => {}, env = process.env, timeoutMs = 30_000, hubEntry }) {
  const origin = `http://127.0.0.1:${port}`;
  let running = await probeHealth(origin);
  let owned = null;
  if (running) {
    if (running.app !== APP_ID) throw unavailable(`Port ${port} is used by another program (it answers, but not as a DatGold Hub). The agent does not stop it: choose another port with --port.`);
    const deadline = Date.now() + timeoutMs;
    while (!running?.initialized) {
      if (Date.now() >= deadline) throw unavailable(`The Hub on port ${port} did not finish loading within ${timeoutMs / 1000} s.`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      running = await probeHealth(origin);
      if (!running) throw unavailable(`The Hub on port ${port} stopped answering while it was loading.`);
    }
    if (!hubRequiresBearer(running)) throw unavailable(`The Hub on port ${port} is version ${running.version ?? 'unknown'}, which has no session secret (an old version). Stop it (STOP-CHATMCP-HUB.cmd) and start a current one; the agent does not use it.`);
  } else {
    if (await portOpen(port)) throw unavailable(`Port ${port} is used by another program. The agent does not stop it: choose another port with --port.`);
    if (!start) throw unavailable(`No DatGold Hub is running on port ${port}, and --no-start was given. Start DatGold, or drop --no-start.`);
    try { owned = await launchOwned(['--backend', 'local', '--port', String(port), '--state-dir', stateDir, '--no-open'], { env, timeoutMs, ...(hubEntry ? { hubEntry } : {}) }); }
    catch (error) { throw unavailable(`Could not start a DatGold Hub on port ${port}: ${error.message}`); }
    log(`started a Hub (pid ${owned.pid}) on port ${port}; it stops when this agent ends`);
  }
  try {
    const session = await readSession(stateDir);
    if (!session || session.port !== port) throw unavailable(`The Hub on port ${port} did not publish a session in ${sessionFile(stateDir)} (is --state-dir the folder that Hub uses?). The agent will not talk to a Hub it cannot authenticate to.`);
    if (owned && session.pid !== owned.pid) throw unavailable(`The session file names process ${session.pid}, not the Hub the agent started (process ${owned.pid}).`);
    try { await assertSessionListener(session, { file: sessionFile(stateDir) }); }
    catch (error) { throw unavailable(`Not sending the Hub's secret: ${error.message}`); }
    const connection = new HubConnection({ origin, secret: session.secret, child: owned?.child ?? null, exited: owned?.exited ?? null, log });
    try { await connection.verify(); }
    catch (error) {
      if (error instanceof HubError && error.status === 401) throw unavailable(`The Hub on port ${port} rejected the saved session (it was restarted, or the file is stale). Start the agent again.`);
      throw unavailable(`The Hub on port ${port} did not accept the first request: ${error.message}`);
    }
    return connection;
  } catch (error) {
    if (owned) await stopOwned(owned.child).catch(() => {}); // never leave a Hub the agent started behind a failure
    throw error;
  }
}
