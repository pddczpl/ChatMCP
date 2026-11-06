// DatGold as an Agent Client Protocol (ACP) agent: an editor (Zed, JetBrains, Neovim, Emacs, VS Code through a community extension) starts this program, speaks JSON-RPC to it on stdin
// and stdout, and drives the Hub through it. Protocol version 1. docs/ACP.md says what it does and what it does not.
//
//   initialize       the version is negotiated (this agent speaks 1), it says who it is and what it can do; nothing is advertised that is not done and tested
//   session/new      the project folder is put in the Hub's list of workspaces (never selected: the selected one is the desktop app's) and the session gets an id
//   session/prompt   the content of the prompt becomes the text the Hub gets (lib/acp/content.mjs); the first prompt starts a task in the folder of the session, the next ones continue it;
//                    the turn ends when the Hub says the task is at rest, with the stop reason of the table in lib/acp/stop-reason.mjs
//   session/cancel   stops the task; the prompt of that session answers `cancelled` whatever the task did in the race
//
// The Hub decides what the agent may do (the permission mode, the protected files, the workspace boundary): this program adds no authority. It is a local client of the Hub with the same
// trust as the launcher (lib/acp/hub-client.mjs). stdout is the protocol and nothing else: the one function that writes to it masks every message first (lib/acp/mask.mjs), and main() points
// every other write to stdout at stderr.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { VERSION } from '../manager.mjs';
import { mapPromptContent } from './content.mjs';
import { HubError, connectToHub, describeHubFailure, parseCliArguments } from './hub-client.mjs';
import { createMasker } from './mask.mjs';
import { ERROR_CODES, RpcError, createRpcPeer } from './rpc.mjs';
import { RESTING_STATES, outcomeOf } from './stop-reason.mjs';
import { parseCancel, parseInitialize, parseNewSession, parsePrompt } from './validate.mjs';

export const PROTOCOL_VERSION = 1;
/** What this agent can do, and no more. Every entry is covered by a test (tests/verify-acp-*.mjs). */
export const AGENT_CAPABILITIES = Object.freeze({
  loadSession: false,
  promptCapabilities: Object.freeze({ image: false, audio: false, embeddedContext: true }),
  mcpCapabilities: Object.freeze({ http: false, sse: false }),
  sessionCapabilities: Object.freeze({}),
});
const MAX_SESSIONS = 256;
const SHUTDOWN_CANCEL_MS = 5000;
const SETTLE_POLL_MS = 50; // the Hub turns a task "completed" a moment before it lets go of the workspace: the look after that moment is not a whole poll interval away

/**
 * @param {object} options
 * @param {ReturnType<typeof createRpcPeer>} options.peer
 * @param {() => Promise<object>} options.connectHub  finds or starts the Hub (lib/acp/hub-client.mjs connectToHub); asked again after a failure
 * @param {ReturnType<typeof createMasker>} options.masker
 * @param {(line: string) => void} options.log  stderr
 * @param {string} [options.version]
 * @param {number} [options.pollMs]  how often the Hub is asked about the task of a running turn
 * @param {number} [options.lostContactMs]  how long a Hub that does not answer is waited for before the turn fails
 */
export function createAcpAgent({ peer, connectHub, masker, log: sink, version = VERSION, pollMs = 500, lostContactMs = 30_000 }) {
  let connector = connectHub;
  const state = { initialized: false, supportsNotices: false, client: null, hubPromise: null, shutdown: null };
  const sessions = new Map();
  let sessionsBeingMade = 0;
  const log = (line) => sink(masker.text(line));

  // ---- the one way out ------------------------------------------------------------------------------------------------------------------------------
  // A message to the editor leaves here and nowhere else, and its decoded value is masked on the way. Results and errors are masked where the handlers are wrapped (guard).
  const outbound = {
    notify(method, params) { peer.notify(method, masker.value(params)); },
  };
  const fail = (code, message, data) => new RpcError(code, masker.text(message), data === undefined ? undefined : masker.value(data));
  const asRpcError = (error) => {
    if (error instanceof RpcError) return fail(error.code, error.message, error.data);
    if (error instanceof HubError || typeof error?.status === 'number') { const described = describeHubFailure(error); return fail(described.code, described.message); }
    if (error?.code === 'hub_unavailable') return fail(ERROR_CODES.INTERNAL, error.message);
    return error; // anything else is a defect: the peer answers Internal error and logs it
  };
  const guard = (handler) => async (params, context) => {
    try { return masker.value(await handler(params, context)); } catch (error) { throw asRpcError(error); }
  };
  /** Information for the person: a notice when the client said it can show one, otherwise an ordinary message (the protocol forbids a notice to a client that did not advertise them). */
  const tell = (sessionId, { severity, title, description }) => {
    if (state.supportsNotices) outbound.notify('session/update', { sessionId, update: { sessionUpdate: 'notice', severity, title, description } });
    else outbound.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${title}\n\n${description}` } } });
  };

  // ---- the Hub --------------------------------------------------------------------------------------------------------------------------------------
  const getHub = () => {
    state.hubPromise ??= Promise.resolve().then(() => connector()).catch((error) => { state.hubPromise = null; throw error; });
    return state.hubPromise;
  };

  // ---- requests -------------------------------------------------------------------------------------------------------------------------------------
  const requireInitialized = (handler) => async (params, context) => {
    if (!state.initialized) throw fail(ERROR_CODES.INVALID_REQUEST, 'Call initialize first: it must be the first request on the connection.');
    if (state.shutdown) throw fail(ERROR_CODES.CANCELLED, 'The agent is shutting down.');
    return handler(params, context);
  };

  async function initialize(params) {
    if (state.initialized) throw fail(ERROR_CODES.INVALID_REQUEST, 'initialize was already called on this connection.');
    const parsed = parseInitialize(params);
    state.initialized = true;
    state.supportsNotices = parsed.supportsNotices;
    state.client = parsed.clientInfo;
    log(`initialize from ${parsed.clientInfo?.name ?? 'an unnamed client'} ${parsed.clientInfo?.version ?? ''} (protocol ${parsed.protocolVersion}; this agent speaks ${PROTOCOL_VERSION})`);
    // Find (or start) the Hub now, so that the first prompt need not wait for it. A failure is tried again by session/new, which says why.
    void getHub().catch((error) => log(`the Hub is not available yet: ${error.message}`));
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: structuredClone(AGENT_CAPABILITIES),
      authMethods: [],
      agentInfo: { name: 'datgold', title: 'DatGold', version },
    };
  }

  async function newSession(params) {
    const { cwd } = parseNewSession(params);
    let stat;
    try { stat = await fs.stat(cwd); } catch { throw fail(ERROR_CODES.INVALID_PARAMS, `The folder does not exist: ${cwd}`); }
    if (!stat.isDirectory()) throw fail(ERROR_CODES.INVALID_PARAMS, `The path is not a folder: ${cwd}`);
    // The limit counts the sessions that are still being made too: requests that arrive in one chunk of the pipe all get here before the first of them has its session.
    if (sessions.size + sessionsBeingMade >= MAX_SESSIONS) throw fail(ERROR_CODES.INVALID_REQUEST, `Too many sessions on this connection (${MAX_SESSIONS}).`);
    sessionsBeingMade += 1;
    try {
      const hub = await getHub();
      const workspace = await hub.ensureWorkspace(cwd);
      const id = randomUUID();
      sessions.set(id, { id, cwd, workspacePath: workspace.path, taskId: null, turn: null });
      return { sessionId: id };
    } finally { sessionsBeingMade -= 1; }
  }

  /** Asks the Hub to stop the task of a turn, once. */
  function cancelHubTask(turn) {
    if (turn.cancelPromise || !turn.taskId) return turn.cancelPromise ?? Promise.resolve();
    turn.cancelPromise = Promise.resolve().then(() => turn.hub.cancelTask(turn.taskId)).catch((error) => log(`could not stop the task ${turn.taskId}: ${error?.message ?? error}`));
    return turn.cancelPromise;
  }

  /**
   * Waits until the Hub says the task is at rest AND has let go of the workspace; returns the task as the Hub last published it. The Hub is asked every `pollMs` (it has no stream of events that works,
   * see lib/acp/hub-client.mjs); a task that is at rest but still held is a moment, and is looked at again after `SETTLE_POLL_MS`. A cancel, a closed connection and the end of the Hub wake the wait at once.
   */
  async function waitForRest(turn, signal) {
    const { hub } = turn;
    let lastAnswer = Date.now();
    let hubGone = null;
    void hub.closed?.then((how) => { hubGone = how ?? {}; turn.wake?.(); });
    const nap = (ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      turn.wake = () => { clearTimeout(timer); resolve(); };
    });
    for (;;) {
      if (signal.aborted) throw fail(ERROR_CODES.CANCELLED, 'The connection to the editor closed.');
      if (hubGone) throw fail(ERROR_CODES.INTERNAL, `The DatGold Hub stopped while the task was running (exit code ${hubGone.code ?? 'none'}${hubGone.signal ? `, signal ${hubGone.signal}` : ''}).`);
      let napMs = pollMs;
      try {
        const task = await hub.getTask(turn.taskId);
        if (!task) throw fail(ERROR_CODES.INTERNAL, 'The Hub no longer has this task.');
        if (RESTING_STATES.includes(task.state)) {
          if (!(await hub.isActive(turn.taskId))) return task;
          napMs = Math.min(pollMs, SETTLE_POLL_MS);
        }
        lastAnswer = Date.now();
      } catch (error) {
        if (error instanceof RpcError) throw error;
        if (Date.now() - lastAnswer > lostContactMs) throw fail(ERROR_CODES.INTERNAL, `Lost contact with the DatGold Hub: ${error?.message ?? error}`);
      }
      await nap(napMs);
    }
  }

  async function prompt(params, context) {
    const { sessionId, prompt: blocks } = parsePrompt(params);
    const session = sessions.get(sessionId);
    if (!session) throw fail(ERROR_CODES.NOT_FOUND, `Unknown session ${JSON.stringify(sessionId)}.`);
    if (session.turn) throw fail(ERROR_CODES.INVALID_REQUEST, 'A turn is already running in this session: wait for it to end, or cancel it.');
    const { prompt: text, notes } = mapPromptContent(blocks, { cwd: session.cwd, promptCapabilities: AGENT_CAPABILITIES.promptCapabilities });
    // The turn is taken HERE, before the first await: requests that arrive in one chunk of the pipe are served one after the other with nothing in between, so a second prompt of this session must find
    // the turn (and be refused), and a cancel right behind its prompt must find it too.
    // The task of the TURN is known when the Hub has answered the start or the continue, and not before: for a later prompt the task of the session is the run that has ended, and a cancel sent for it
    // would be spent on nothing (a cancel is sent once). Until then a cancel only marks the turn; the line after the answer stops the run that exists.
    const turn = { hub: null, taskId: null, cancelRequested: false, cancelPromise: null, wake: null };
    session.turn = turn;
    const onAbort = () => { void cancelHubTask(turn); turn.wake?.(); };
    context.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const hub = await getHub();
      turn.hub = hub;
      if (notes.length) tell(sessionId, { severity: 'info', title: 'Some of what you attached was not sent to the model', description: notes.join('\n') });
      const task = session.taskId === null ? await hub.startTask({ prompt: text, workspacePath: session.workspacePath }) : await hub.continueTask({ id: session.taskId, prompt: text });
      session.taskId = task.id;
      turn.taskId = task.id;
      if (turn.cancelRequested || context.signal.aborted) await cancelHubTask(turn); // the client cancelled before the Hub had answered the start: the task is stopped the moment its id is known
      const finished = await waitForRest(turn, context.signal);
      const outcome = outcomeOf(finished, { cancelRequested: turn.cancelRequested });
      if (outcome.error) throw fail(outcome.error.code, outcome.error.message);
      if (typeof finished.finalText === 'string' && finished.finalText.trim()) outbound.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: finished.finalText } } });
      if (outcome.notice) tell(sessionId, outcome.notice);
      return { stopReason: outcome.stopReason };
    } finally {
      context.signal.removeEventListener('abort', onAbort);
      session.turn = null;
    }
  }

  function cancel(params) {
    if (!state.initialized) { log('ignored session/cancel before initialize'); return; }
    let sessionId;
    try { ({ sessionId } = parseCancel(params)); } catch (error) { log(`ignored session/cancel: ${error.message}`); return; }
    const session = sessions.get(sessionId);
    if (!session) { log(`ignored session/cancel for an unknown session ${JSON.stringify(sessionId)}`); return; }
    const { turn } = session;
    if (!turn) return;
    turn.cancelRequested = true;
    void cancelHubTask(turn); // no task id yet (the Hub has not answered the start): the prompt stops it as soon as it has one
    turn.wake?.();
  }

  return {
    log,
    /** Takes the place of the way to the Hub (the tests use it). */
    replaceConnector(next) { connector = next; state.hubPromise = null; },
    attach() {
      peer.handle('initialize', guard(initialize));
      peer.handle('session/new', guard(requireInitialized(newSession)));
      peer.handle('session/prompt', guard(requireInitialized(prompt)));
      peer.onNotification('session/cancel', cancel);
    },
    /**
     * The end of the connection: the tasks the agent started are stopped, a Hub the agent started is stopped, a Hub it only attached to is left alone. Once; later calls wait for the first.
     */
    shutdown() {
      state.shutdown ??= (async () => {
        // A turn that is still waiting for the Hub to make its task is marked, so that the task is stopped the moment it exists (the pipe may not have closed: this can be a signal).
        const stopping = [...sessions.values()].filter((session) => session.turn).map((session) => { session.turn.cancelRequested = true; return cancelHubTask(session.turn); });
        await Promise.race([Promise.allSettled(stopping), new Promise((resolve) => { setTimeout(resolve, SHUTDOWN_CANCEL_MS).unref(); })]);
        const hub = state.hubPromise ? await state.hubPromise.catch(() => null) : null;
        if (!hub) return;
        if (hub.owned) await hub.stop();
      })();
      return state.shutdown;
    },
  };
}

// ---- the program ------------------------------------------------------------------------------------------------------------------------------------
/**
 * The entry of `node lib/acp/agent.mjs [--port N] [--state-dir DIR] [--no-start]` (and of windows/chatmcp-acp.cmd).
 * stdin and stdout are the protocol. From the moment this runs, anything else that writes to stdout (a library that prints) is sent to stderr instead, so that it cannot be taken for a message.
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  let timing;
  try {
    options = parseCliArguments(argv, env);
    // Two settings of the wait for the Hub, for a slow machine or a test: how often the task is asked about and how long a Hub that does not answer is waited for.
    const integer = (name, fallback, min, max) => {
      if (env[name] === undefined || env[name] === '') return fallback;
      const value = Number(env[name]);
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max} (milliseconds)`);
      return value;
    };
    timing = { pollMs: integer('CHATMCP_ACP_POLL_MS', 500, 20, 60_000), lostContactMs: integer('CHATMCP_ACP_LOST_CONTACT_MS', 30_000, 500, 600_000) };
  } catch (error) { process.stderr.write(`datgold-acp: ${error.message}\n`); process.exitCode = 2; return; }

  const protocolWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
  const output = { write: (text, callback) => protocolWrite(text, 'utf8', callback), on: (event, listener) => process.stdout.on(event, listener) };

  const credentials = { connection: null };
  const masker = createMasker({ secrets: () => credentials.connection?.secrets ?? [] });
  const stderr = (line) => { try { process.stderr.write(`[datgold-acp] ${masker.text(line)}\n`); } catch { /* stderr is gone: nothing else can be done with the line */ } };
  const peer = createRpcPeer({ input: process.stdin, output, log: stderr });
  const agent = createAcpAgent({
    peer, masker, log: stderr, ...timing,
    connectHub: async () => { const connection = await connectToHub({ ...options, log: stderr }); credentials.connection = connection; return connection; },
  });
  agent.attach();

  let ending = false;
  const end = async (why, code = 0) => {
    if (ending) return;
    ending = true;
    stderr(`ending: ${why}`);
    try { await agent.shutdown(); } catch (error) { stderr(`shutdown failed: ${error?.message ?? error}`); }
    await peer.close(why);
    await peer.flush();
    process.exitCode = code;
    setTimeout(() => process.exit(code), 3000).unref(); // whatever is still holding the event loop does not hold the process
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.once(signal, () => { void end(`signal ${signal}`); });
  process.on('uncaughtException', (error) => { stderr(`uncaught exception: ${error?.stack ?? error}`); void end('uncaught exception', 1); });
  process.on('unhandledRejection', (reason) => { stderr(`unhandled rejection: ${reason?.stack ?? reason}`); });

  peer.start();
  stderr(`DatGold ACP agent ${VERSION} ready (node ${process.version} at ${process.execPath}; Hub on port ${options.port}${options.start ? '' : ', not to be started'})`);
  await peer.closed;
  await end('the editor closed the connection');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`datgold-acp: ${error?.stack ?? error}\n`); process.exitCode = 1; });
}
