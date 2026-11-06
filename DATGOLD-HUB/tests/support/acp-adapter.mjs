// Starts the ACP agent (lib/acp/agent.mjs, or any command that speaks the same protocol, such as windows/chatmcp-acp.cmd) as an editor does, and talks to it.
//
//   startAdapter     the official SDK (2.x `client()`) is the client; every byte the agent writes to stdout is also captured, so that a suite can check it line by line against the schema of the
//                    protocol (tests/support/acp-schema.mjs), and can tell that nothing but protocol was written.
//   startRawAdapter  no SDK: the suite writes the bytes (garbage, a huge line, a request out of order) and reads what comes back.
//
// Every adapter is started the way the tests start a Hub: an explicit random port (never 3007), a state folder of its own, `--no-start` unless the suite wants the agent to start a Hub, and a
// scrubbed environment (tests/e2e/hub-process.mjs cleanEnvironment), so that nothing of the machine, and no CHATMCP_STATE_DIR, can send it to somebody's real Hub.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { HUB_ROOT, cleanEnvironment, sleep } from '../e2e/hub-process.mjs';

export const AGENT_ENTRY = path.join(HUB_ROOT, 'lib', 'acp', 'agent.mjs');

function launch({ scratch, command, args, env, cwd, verbatim = false }) {
  const child = spawn(command, args, {
    cwd: cwd ?? HUB_ROOT, env: cleanEnvironment(scratch, env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  const stdout = [];
  const stderr = [];
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  return { child, stdout, stderr, exited };
}

/** Ends a process and what it started (an editor ends the process tree of an agent). */
export function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** Ends only this process, not what it started: what an editor that kills just the agent does. */
export function killOnly(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 10_000 });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

export const adapterArguments = ({ hub, extra = [], start = false }) => [AGENT_ENTRY, '--port', String(hub.port), '--state-dir', hub.stateDir, ...(start ? [] : ['--no-start']), ...extra];

/** The lines on a buffer list as parsed JSON, and the text of the lines that are not JSON. */
function parseLines(chunks) {
  const text = Buffer.concat(chunks).toString('utf8');
  const messages = [];
  const strays = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { messages.push(JSON.parse(line)); } catch { strays.push(line.slice(0, 200)); }
  }
  return { messages, strays, text };
}

/** An adapter with the official SDK as its client. */
export async function startAdapter({ tools, validator, scratch, hub, extra = [], start = false, env = {}, command = process.execPath, args = null, verbatim = false, handlers = {} }) {
  const { client, methods, ndJsonStream } = tools.sdk;
  const run = launch({ scratch, command, args: args ?? adapterArguments({ hub, extra, start }), env, verbatim });
  const { child, stdout, stderr, exited } = run;
  const clientBytes = [];
  const tee = new PassThrough();
  child.stdout.on('data', (chunk) => { stdout.push(chunk); tee.write(chunk); });
  child.stdout.on('end', () => tee.end());
  const toAgent = new WritableStream({
    write(chunk) { clientBytes.push(Buffer.from(chunk)); return new Promise((resolve, reject) => child.stdin.write(chunk, (error) => (error ? reject(error) : resolve()))); },
    close() { child.stdin.end(); },
    abort() { child.stdin.destroy(); },
  });
  const stream = ndJsonStream(toAgent, Readable.toWeb(tee));

  const updates = [];
  const permissionRequests = [];
  const app = client({ name: 'datgold-acp-test-client', version: '0.0.0' });
  // A handler of the 2.x client gets a context ({params, signal, agent, requestId}), not the params.
  app.onNotification(methods.client.session.update, ({ params }) => { updates.push(params); handlers.update?.(params); });
  app.onRequest(methods.client.session.requestPermission, async ({ params }) => {
    permissionRequests.push(params);
    if (!handlers.permission) throw new Error('this test client does not answer permission requests');
    return handlers.permission(params);
  });
  let context;
  let closeConnection;
  const connectionClosed = new Promise((resolve) => { closeConnection = resolve; });
  const ready = new Promise((resolve, reject) => {
    app.connectWith(stream, async (ctx) => { context = ctx; resolve(ctx); await connectionClosed; }).catch(reject);
  });
  await ready;

  const requestMethods = () => {
    const map = new Map();
    for (const line of Buffer.concat(clientBytes).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const message = JSON.parse(line); if (message.method && 'id' in message) map.set(message.id, message.method); } catch { /* the suite wrote it; not JSON only if it meant to */ }
    }
    return map;
  };
  const adapter = {
    child, pid: child.pid, exited, updates, permissionRequests,
    /** A request; the answer is `{result}` or `{error: {code, message, data}}`, whatever the SDK throws. */
    async call(method, params, options) {
      try { return { result: await context.request(method, params, options) }; } catch (error) { return { error: { code: error.code, message: error.message, data: error.data } }; }
    },
    notify: (method, params) => context.notify(method, params),
    stdoutText: () => Buffer.concat(stdout).toString('utf8'),
    stderrText: () => Buffer.concat(stderr).toString('utf8'),
    /** Every message the agent wrote, parsed; `strays` are lines that are not JSON (there must be none). */
    wire: () => parseLines(stdout),
    /** What the schema says is wrong with what the agent wrote. Empty = every line is a valid message of the protocol. */
    problems() {
      const { messages, strays } = parseLines(stdout);
      const map = requestMethods();
      const found = strays.map((line) => `not a message: ${JSON.stringify(line)}`);
      messages.forEach((message, index) => { for (const problem of validator.validateAgentMessage(message, map)) found.push(`#${index} ${JSON.stringify(message).slice(0, 160)}: ${problem}`); });
      return found;
    },
    /** Waits until the client library has handed over every session/update that the agent wrote (it dispatches notifications a moment after it reads them). */
    async drained(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const wrote = parseLines(stdout).messages.filter((message) => message.method === 'session/update').length;
        if (updates.length >= wrote) return updates.length;
        if (Date.now() > deadline) throw new Error(`the client library handed over ${updates.length} of the ${wrote} session/update messages the agent wrote`);
        await sleep(20);
      }
    },
    writeRaw: (text) => new Promise((resolve) => child.stdin.write(text, () => resolve())),
    /** Closes the connection the way an editor does (stdin ends) and waits for the exit. */
    async end({ graceMs = 12_000 } = {}) {
      closeConnection();
      child.stdin.end(); // an editor that is done closes the pipe itself; the library may not do it before the connection is wound up

      const outcome = await Promise.race([exited, sleep(graceMs).then(() => null)]);
      if (!outcome) { killTree(child.pid); return Promise.race([exited, sleep(5000).then(() => null)]); }
      return outcome;
    },
    kill: () => killTree(child.pid),
    killOnly: () => killOnly(child.pid),
  };
  return adapter;
}

/** An adapter without a client library: the suite writes bytes and reads lines. */
export function startRawAdapter({ scratch, hub, extra = [], start = false, env = {}, command = process.execPath, args = null, cwd, verbatim = false }) {
  const { child, stdout, stderr, exited } = launch({ scratch, command, args: args ?? adapterArguments({ hub, extra, start }), env, cwd, verbatim });
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  return {
    child, pid: child.pid, exited,
    stdoutText: () => Buffer.concat(stdout).toString('utf8'),
    stderrText: () => Buffer.concat(stderr).toString('utf8'),
    wire: () => parseLines(stdout),
    write: (data) => new Promise((resolve) => { child.stdin.write(data, () => resolve()); }),
    end: () => child.stdin.end(),
    /** The first message that satisfies `match`, waiting for it. */
    async waitFor(match, { timeoutMs = 15_000, label = 'a message' } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = parseLines(stdout).messages.find(match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; stdout so far: ${Buffer.concat(stdout).toString('utf8').slice(0, 600)}`);
        await sleep(25);
      }
    },
    kill: () => killTree(child.pid),
  };
}
