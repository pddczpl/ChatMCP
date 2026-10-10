// Command broker: the only way the Hub starts a program under the unprivileged "agent" account.
//
// Why it exists. In public mode the Hub process holds secrets (the owner token, the model key, a GitHub token). A command the agent
// runs must not be able to read them, and must not be able to talk to the Hub as its owner (which would let it approve its own
// commands). Anything running under the same operating-system account can read /proc/<hub>/environ, so the agent's commands run
// under another account. Only root can switch accounts and the Hub must not be root, so a small root process (the supervisor,
// docker/supervisor.mjs) runs the server half of this module and the Hub talks to it through a Unix socket that only the Hub's
// account can open. The Hub-side half looks like child_process.spawn(), so ShellRunner, GitRunner and StudioTerminal do not need
// to know that a broker exists.
//
// What the server guarantees, in order of importance:
//   1. It never runs anything as root. Every program is started through prlimit and setpriv, which switch to the agent account
//      (user, group, supplementary groups), drop every capability from the bounding and inheritable sets and set no_new_privs, and
//      the environment is rebuilt with `env -i` so that nothing the Hub sent can influence the root-owned helper programs.
//   2. One command at a time, and after each command every process of the agent account is killed ("reaped"): nothing the agent
//      started can still be running while the Hub works on the files it may have changed. That is what makes it safe for the Hub
//      to follow paths inside the workspace (a process that could swap a directory for a symlink between the Hub's check and use
//      does not exist at that moment). If a process cannot be killed the broker refuses further commands instead of carrying on.
//   3. A command lives no longer than the Hub's connection: a closed socket kills the running command and drops the queued ones.
//   4. Everything is bounded: arguments, environment, output bytes, run time, queue length, the working directories allowed.
//
// The wire protocol is newline-delimited JSON. Output travels as base64 so that bytes survive unchanged.
//   Hub -> broker  {t:'hello'} | {t:'run', id, file, args, cwd, env, timeoutMs, maxOutputBytes} | {t:'signal', id, signal}
//   broker -> Hub  {t:'hello', ok, v, agent} | {t:'started', id, pid} | {t:'data', id, fd, b64} | {t:'exit', id, code, signal, reason, reaped}
//                  | {t:'error', id, code, message}
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_LIMITS = Object.freeze({
  maxQueue: 8,
  maxRunMs: 900_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxOutputBytesHard: 1024 * 1024 * 1024,
  nproc: 512,
  nofile: 4096,
  fsizeBytes: 1024 * 1024 * 1024,
  dataBytes: 0, // RLIMIT_DATA per process (heap and private writable mappings); 0 = no limit
  lingerMs: 1500,
  killGraceMs: 3000,
  reapTimeoutMs: 5000,
});

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const FILE_PATTERN = /^\/[A-Za-z0-9_@%+.,:/-]{1,400}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestError = (code, message) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------------------------------------------------------- process helpers
/** pids of every live (non-zombie) process that has `uid` as its real, effective, saved or filesystem user id. */
export async function listProcessesOfUid(uid, { procRoot = '/proc' } = {}) {
  const found = [];
  let names;
  try { names = await fs.readdir(procRoot); } catch { return found; }
  for (const name of names) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    let status;
    try { status = await fs.readFile(path.join(procRoot, name, 'status'), 'utf8'); } catch { continue; } // the process ended meanwhile
    if (/^State:\s+[ZX]/m.test(status)) continue; // already dead; its parent or init will collect it
    const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (match && [match[1], match[2], match[3], match[4]].some((value) => Number(value) === uid)) found.push(Number(name));
  }
  return found;
}

/**
 * Kills every process of the agent account, repeating until none is left (a process that is being killed can still fork), and
 * returns how many it had to kill. Throws when something survives `timeoutMs`. Refuses uid 0 and the broker's own uid.
 */
export async function reapAgentProcesses(uid, { timeoutMs = DEFAULT_LIMITS.reapTimeoutMs, procRoot = '/proc' } = {}) {
  if (!Number.isInteger(uid) || uid <= 0 || uid === process.getuid?.()) throw new RangeError('reap: refusing to kill the processes of this uid');
  const killed = new Set();
  const until = Date.now() + timeoutMs;
  for (;;) {
    const pids = await listProcessesOfUid(uid, { procRoot });
    if (pids.length === 0) return killed.size;
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); killed.add(pid); } catch { /* gone already */ }
    }
    if (Date.now() > until) throw new Error(`reap: ${pids.length} process(es) of uid ${uid} survived SIGKILL`);
    await sleep(15);
  }
}

async function firstExisting(names, directories = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
  for (const directory of directories) {
    const candidate = path.join(directory, names);
    try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

/** Locates the helper programs of the real launcher; null for each one that is missing. */
export async function locateLauncherTools() {
  return { prlimit: await firstExisting('prlimit'), setpriv: await firstExisting('setpriv'), env: await firstExisting('env') };
}

/**
 * Starts `file` as the agent account. `tools` comes from locateLauncherTools(). The returned object is a ChildProcess whose pid is
 * the program's own pid (prlimit, setpriv and env replace themselves), and which leads a process group of its own.
 */
export function launchAsAgent({ file, args, cwd, env, agent, limits, tools }) {
  if (!tools?.prlimit || !tools.setpriv || !tools.env) throw requestError('launcher_missing', 'prlimit, setpriv and env are required to run commands as another user.');
  const argv = [
    `--nproc=${limits.nproc}`, `--nofile=${limits.nofile}`, `--fsize=${limits.fsizeBytes}`, '--core=0',
    ...(limits.dataBytes > 0 ? [`--data=${limits.dataBytes}`] : []),
    '--', tools.setpriv,
    `--reuid=${agent.uid}`, `--regid=${agent.gid}`, `--groups=${agent.groups.join(',')}`,
    '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--pdeathsig=KILL',
    // "--" right after -i ends the options of env; the NAME=VALUE words that follow are assignments, and `file` (an absolute path,
    // which the request check guarantees contains no "=") is the first word that is not one.
    '--', tools.env, '-i', '--', ...Object.entries(env).map(([name, value]) => `${name}=${value}`), file, ...args,
  ];
  // The helpers themselves (still root until setpriv has switched) see nothing but a fixed PATH.
  return spawn(tools.prlimit, argv, { cwd, env: { PATH: SAFE_PATH }, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
}

function killGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
}

// ---------------------------------------------------------------------------------------------------------------- request checks
async function checkRequest(message, { agent, cwdRoots, limits }) {
  if (typeof message.file !== 'string' || !FILE_PATTERN.test(message.file) || message.file.split('/').includes('..')) throw requestError('bad_request', 'file must be an absolute path without "..", "=" or spaces.');
  try { await fs.access(message.file, fs.constants.X_OK); } catch { throw requestError('ENOENT', `Program not found or not executable: ${message.file}`); }
  if (!Array.isArray(message.args) || message.args.length > 2000) throw requestError('bad_request', 'args must be an array of at most 2000 strings.');
  let total = 0;
  for (const arg of message.args) {
    if (typeof arg !== 'string' || arg.includes('\0')) throw requestError('bad_request', 'every argument must be a string without NUL.');
    const size = Buffer.byteLength(arg);
    total += size + 1;
    if (size > 120_000) throw requestError('E2BIG', 'An argument is too long (limit 120000 bytes).');
  }
  if (total > 900_000) throw requestError('E2BIG', 'Arguments are too long in total (limit 900000 bytes).');
  const input = message.env ?? {};
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).length > 200) throw requestError('bad_request', 'env must be an object of at most 200 entries.');
  const env = {};
  let envBytes = 0;
  for (const [name, value] of Object.entries(input)) {
    if (!ENV_NAME.test(name) || typeof value !== 'string' || value.includes('\0') || value.length > 16_384) throw requestError('bad_request', `env entry ${JSON.stringify(name.slice(0, 40))} is not acceptable.`);
    envBytes += name.length + value.length + 2;
    env[name] = value;
  }
  if (envBytes > 131_072) throw requestError('E2BIG', 'The environment is too large (limit 131072 bytes).');
  // The identity variables describe the account the program really runs under, whatever the caller said.
  Object.assign(env, { HOME: agent.home, USER: agent.name, LOGNAME: agent.name });
  env.PATH ??= SAFE_PATH;
  if (typeof message.cwd !== 'string' || !path.isAbsolute(message.cwd) || message.cwd.includes('\0')) throw requestError('bad_request', 'cwd must be an absolute path.');
  let cwd;
  try { cwd = await fs.realpath(message.cwd); } catch { throw requestError('ENOENT', 'The working directory does not exist.'); }
  if (!cwdRoots.some((root) => cwd === root || cwd.startsWith(root + path.sep))) throw requestError('cwd_denied', 'The working directory is outside the areas commands may run in.');
  const timeoutMs = Math.max(1000, Math.min(limits.maxRunMs, Number(message.timeoutMs) || limits.maxRunMs));
  const maxOutputBytes = Math.max(1024, Math.min(limits.maxOutputBytesHard, Number(message.maxOutputBytes) || limits.maxOutputBytes));
  return { file: message.file, args: message.args, cwd, env, timeoutMs, maxOutputBytes };
}

// ---------------------------------------------------------------------------------------------------------------- server
/**
 * @param {object} options
 * @param {string} options.socketPath
 * @param {{uid: number, gid: number, groups: number[], name: string, home: string}} options.agent
 * @param {string[]} options.cwdRoots     directories (real paths) a command may use as its working directory, or anything below them
 * @param {{uid: number, gid: number}} [options.socketOwner]  chown'ed onto the socket (root:hub in the container)
 * @param {number} [options.socketMode]
 * @param {number} [options.umask]        applied to the broker process; programs inherit it (002 = group-writable files)
 * @param {Function} [options.launch]     replaceable for tests: ({file,args,cwd,env,agent,limits}) => ChildProcess
 * @param {Function} [options.reap]       replaceable for tests: (uid) => Promise<number>
 */
export async function startBrokerServer({
  socketPath, agent, cwdRoots, socketOwner = null, socketMode = 0o660, umask = null, limits: limitOverrides = {},
  launch = null, reap = null, log = () => {},
} = {}) {
  if (!path.isAbsolute(socketPath ?? '')) throw new TypeError('socketPath must be absolute');
  if (!agent || !Number.isInteger(agent.uid) || agent.uid <= 0 || !Number.isInteger(agent.gid) || !Array.isArray(agent.groups) || !agent.name || !agent.home) throw new TypeError('agent needs uid > 0, gid, groups, name and home');
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const roots = [];
  for (const root of cwdRoots ?? []) roots.push(await fs.realpath(root));
  if (roots.length === 0) throw new TypeError('cwdRoots must name at least one directory');
  const tools = launch ? null : await locateLauncherTools();
  const start = launch ?? ((spec) => launchAsAgent({ ...spec, tools }));
  const reapAll = reap ?? ((uid) => reapAgentProcesses(uid, { timeoutMs: limits.reapTimeoutMs }));
  const previousUmask = umask === null ? null : process.umask(umask);

  const queue = [];
  const connections = new Set();
  let active = null;
  let pumping = false;
  let closed = false;
  let stuck = null; // set when processes of the agent account survived a reap: no more commands until a reap succeeds

  const send = (connection, message) => {
    if (connection.closed || connection.socket.destroyed) return false;
    return connection.socket.write(`${JSON.stringify(message)}\n`);
  };

  async function execute(run) {
    const { connection, id } = run;
    let child;
    try {
      child = start({ file: run.spec.file, args: run.spec.args, cwd: run.spec.cwd, env: run.spec.env, agent, limits });
    } catch (error) {
      send(connection, { t: 'error', id, code: error.code ?? 'spawn_failed', message: String(error.message).slice(0, 500) });
      return;
    }
    run.child = child;
    run.bytes = 0;
    run.reason = null;
    run.exited = false;
    if (child.pid) send(connection, { t: 'started', id, pid: child.pid });

    const pipes = [child.stdout, child.stderr].filter(Boolean);
    let timer = null;
    let hardTimer = null;
    const outcome = await new Promise((resolve) => {
      let finished = false;
      let exitInfo = null;
      let lingerTimer = null;
      const finish = (info) => {
        if (finished) return;
        finished = true;
        clearTimeout(lingerTimer);
        resolve(info);
      };
      const destroyPipes = () => { for (const pipe of pipes) pipe.destroy(); };
      run.stop = (reason, signal = 'SIGKILL') => {
        run.reason ??= reason;
        killGroup(child, signal);
        hardTimer ??= setTimeout(() => { destroyPipes(); finish({ code: null, signal: 'SIGKILL', lingering: false }); }, limits.killGraceMs);
      };
      const forward = (fd) => (chunk) => {
        run.bytes += chunk.length;
        if (run.bytes > run.spec.maxOutputBytes) { run.stop('output-limit'); return; }
        if (!send(connection, { t: 'data', id, fd, b64: chunk.toString('base64') })) {
          if (connection.closed) return;
          for (const pipe of pipes) pipe.pause();
          connection.socket.once('drain', () => { for (const pipe of pipes) pipe.resume(); });
        }
      };
      child.stdout?.on('data', forward(1));
      child.stderr?.on('data', forward(2));
      for (const pipe of pipes) pipe.on('error', () => {});
      child.once('error', (error) => finish({ error }));
      // A background process that inherited the pipes would keep "close" from firing: wait a moment for the pipes to drain, no longer.
      child.once('exit', (code, signal) => {
        run.exited = true;
        exitInfo = { code, signal };
        lingerTimer = setTimeout(() => { destroyPipes(); finish({ ...exitInfo, lingering: true }); }, limits.lingerMs);
      });
      child.once('close', (code, signal) => finish({ ...(exitInfo ?? { code, signal }), lingering: false }));
      timer = setTimeout(() => run.stop('timeout'), run.spec.timeoutMs);
      if (run.cancelled) run.stop(run.cancelled);
    });
    clearTimeout(timer);
    clearTimeout(hardTimer);
    run.child = null;

    let reaped = 0;
    try {
      reaped = await reapAll(agent.uid);
      stuck = null;
    } catch (error) {
      stuck = String(error.message);
      log(`Không dọn sạch được tiến trình của agent: ${stuck}`);
    }
    if (outcome.error) {
      send(connection, { t: 'error', id, code: outcome.error.code ?? 'spawn_failed', message: String(outcome.error.message).slice(0, 500) });
    } else {
      send(connection, { t: 'exit', id, code: outcome.code ?? null, signal: outcome.signal ?? null, reason: run.reason, lingering: Boolean(outcome.lingering), reaped, stuck: Boolean(stuck) });
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (!closed && queue.length > 0) {
        const run = queue.shift();
        if (run.cancelled) {
          if (run.cancelled === 'cancelled' || run.cancelled === 'shutdown') send(run.connection, { t: 'exit', id: run.id, code: null, signal: null, reason: run.cancelled, lingering: false, reaped: 0, stuck: false });
          run.connection.runs.delete(run.id);
          continue;
        }
        if (stuck) {
          try { await reapAll(agent.uid); stuck = null; } catch (error) { stuck = String(error.message); }
        }
        if (stuck) {
          send(run.connection, { t: 'error', id: run.id, code: 'agent_processes_stuck', message: 'Processes of the agent account could not be stopped; commands are refused until they are.' });
          run.connection.runs.delete(run.id);
          continue;
        }
        active = run;
        try { await execute(run); } catch (error) { log(`Lỗi môi giới lệnh: ${error.message}`); send(run.connection, { t: 'error', id: run.id, code: 'broker_error', message: 'Internal broker error.' }); }
        active = null;
        run.connection.runs.delete(run.id);
      }
    } finally { pumping = false; }
  }

  async function handle(connection, message) {
    if (message === null || typeof message !== 'object') return;
    if (message.t === 'hello') {
      send(connection, { t: 'hello', ok: true, v: PROTOCOL_VERSION, agent: { uid: agent.uid, gid: agent.gid, name: agent.name, home: agent.home }, limits: { maxQueue: limits.maxQueue, maxRunMs: limits.maxRunMs } });
      return;
    }
    const id = message.id;
    if (!Number.isSafeInteger(id) || id <= 0) { send(connection, { t: 'error', id: null, code: 'bad_request', message: 'Missing request id.' }); return; }
    if (message.t === 'run') {
      if (connection.runs.has(id)) { send(connection, { t: 'error', id, code: 'bad_request', message: 'Duplicate request id.' }); return; }
      if (closed) { send(connection, { t: 'error', id, code: 'closed', message: 'The broker is shutting down.' }); return; }
      if (queue.length >= limits.maxQueue) { send(connection, { t: 'error', id, code: 'busy', message: 'Too many commands are waiting.' }); return; }
      const run = { connection, id, spec: null, child: null, cancelled: null, stop: null };
      connection.runs.set(id, run);
      try {
        run.spec = await checkRequest(message, { agent, cwdRoots: roots, limits });
      } catch (error) {
        connection.runs.delete(id);
        send(connection, { t: 'error', id, code: error.code ?? 'bad_request', message: String(error.message).slice(0, 500) });
        return;
      }
      if (connection.closed) { connection.runs.delete(id); return; }
      queue.push(run);
      void pump();
      return;
    }
    if (message.t === 'signal') {
      const run = connection.runs.get(id);
      if (!run) return;
      const signal = SIGNALS.has(message.signal) ? message.signal : 'SIGTERM';
      if (run.child) {
        run.stop?.('signal', signal);
      } else if (!run.cancelled && queue.includes(run)) {
        run.cancelled = 'cancelled';
        queue.splice(queue.indexOf(run), 1);
        connection.runs.delete(id);
        send(connection, { t: 'exit', id, code: null, signal, reason: 'cancelled', lingering: false, reaped: 0, stuck: false });
      } else if (!run.cancelled) {
        run.cancelled = 'cancelled'; // validated but not queued yet, or about to start
      }
    }
  }

  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    const connection = { socket, runs: new Map(), closed: false };
    connections.add(connection);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (text) => {
      buffer += text;
      if (buffer.length > MAX_LINE_BYTES) { socket.destroy(); return; }
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let message = null;
        try { message = JSON.parse(line); } catch { send(connection, { t: 'error', id: null, code: 'bad_request', message: 'Not JSON.' }); continue; }
        void handle(connection, message).catch((error) => { log(`Lỗi xử lý yêu cầu: ${error.message}`); });
      }
    });
    const gone = () => {
      if (connection.closed) return;
      connection.closed = true;
      connections.delete(connection);
      for (const run of connection.runs.values()) {
        if (run.child) run.stop?.('disconnect');
        else { run.cancelled = 'disconnect'; const at = queue.indexOf(run); if (at >= 0) queue.splice(at, 1); }
      }
      connection.runs.clear();
    };
    socket.on('close', gone);
    socket.on('error', gone);
  });

  // A leftover socket file from a previous run is removed; anything else at that path is a mistake worth stopping for.
  try {
    const existing = await fs.lstat(socketPath);
    if (!existing.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
    await fs.unlink(socketPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
  if (socketOwner) await fs.chown(socketPath, socketOwner.uid, socketOwner.gid);
  await fs.chmod(socketPath, socketMode);

  return {
    socketPath,
    agent,
    stats: () => ({ queued: queue.length, running: Boolean(active), connections: connections.size, stuck }),
    async close() {
      if (closed) return;
      closed = true;
      for (const connection of connections) {
        for (const run of connection.runs.values()) { if (run.child) run.stop?.('shutdown'); else run.cancelled = 'shutdown'; }
        connection.socket.destroy();
      }
      queue.length = 0;
      await new Promise((resolve) => server.close(resolve));
      const until = Date.now() + limits.killGraceMs + 1000;
      while (active && Date.now() < until) await sleep(20);
      try { await reapAll(agent.uid); } catch (error) { log(`Không dọn sạch được tiến trình của agent khi đóng: ${error.message}`); }
      await fs.unlink(socketPath).catch(() => {});
      if (previousUmask !== null) process.umask(previousUmask);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------- client
class BrokerChild extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.id = 0;
    this.stdin = null;
    this.stdout = new PassThrough({ highWaterMark: 1024 * 1024 });
    this.stderr = new PassThrough({ highWaterMark: 1024 * 1024 });
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.brokered = true; // callers must not signal -pid themselves: the processes belong to another account
    this.finished = false;
  }

  kill(signal = 'SIGTERM') {
    if (this.finished) return false;
    this.killed = true;
    this.client.signal(this.id, typeof signal === 'string' ? signal : 'SIGTERM');
    // Whoever asked for the kill may have stopped reading. The output of a command that is being killed is discarded when nobody
    // listens, so a full buffer cannot keep the shared connection paused (see #dispatch).
    this.stdout.resume();
    this.stderr.resume();
    return true;
  }

  killTree() { return this.kill('SIGKILL'); }

  /** Called by the client when the run is over. */
  settle(code, signal) {
    if (this.finished) return;
    this.finished = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.client.resumeReading();
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    setImmediate(() => this.emit('close', code, signal));
  }
}

export class BrokerClient {
  constructor({ socketPath, connectTimeoutMs = 3000 } = {}) {
    if (!path.isAbsolute(socketPath ?? '')) throw new TypeError('socketPath must be absolute');
    this.socketPath = socketPath;
    this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null;
    this.connecting = null;
    this.children = new Map();
    this.nextId = 1;
    this.helloWaiters = [];
  }

  async #connect() {
    if (this.socket && !this.socket.destroyed) return;
    this.connecting ??= new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(requestError('EBROKERDOWN', 'Timed out connecting to the command broker.')); }, this.connectTimeoutMs);
      socket.setEncoding('utf8');
      socket.once('error', (error) => { clearTimeout(timer); reject(requestError('EBROKERDOWN', `Cannot reach the command broker: ${error.code ?? error.message}`)); });
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        let buffer = '';
        socket.on('data', (text) => {
          buffer += text;
          if (buffer.length > MAX_LINE_BYTES * 2) { socket.destroy(); return; }
          for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            if (!line) continue;
            let message = null;
            try { message = JSON.parse(line); } catch { continue; }
            this.#dispatch(message);
          }
        });
        socket.on('error', () => {});
        socket.on('close', () => this.#lost(socket));
        this.socket = socket;
        resolve();
      });
    }).finally(() => { this.connecting = null; });
    await this.connecting;
  }

  #lost(socket) {
    if (this.socket === socket) this.socket = null;
    for (const [id, child] of [...this.children]) {
      this.children.delete(id);
      child.emit('error', requestError('EBROKERLOST', 'The connection to the command broker was lost.'));
      child.settle(null, null);
    }
    for (const waiter of this.helloWaiters.splice(0)) waiter.reject(requestError('EBROKERLOST', 'The connection to the command broker was lost.'));
  }

  #dispatch(message) {
    if (message.t === 'hello') { for (const waiter of this.helloWaiters.splice(0)) waiter.resolve(message); return; }
    const child = this.children.get(message.id);
    if (!child) return;
    if (message.t === 'started') { child.pid = message.pid; child.emit('spawn'); return; }
    if (message.t === 'data') {
      const stream = message.fd === 2 ? child.stderr : child.stdout;
      const room = stream.write(Buffer.from(String(message.b64 ?? ''), 'base64'));
      if (!room && !child.finished) {
        // The reader is slower than the command (a download over a slow link). Stop reading the socket until it catches up: the
        // kernel buffer fills, the broker's write blocks and the broker pauses the command's pipes. Nothing is dropped, nothing piles up.
        const socket = this.socket;
        socket?.pause();
        stream.once('drain', () => { if (socket && !socket.destroyed) socket.resume(); });
      }
      return;
    }
    if (message.t === 'exit') {
      this.children.delete(message.id);
      child.reason = message.reason ?? null;
      child.reaped = message.reaped ?? 0;
      child.settle(message.code ?? null, message.signal ?? null);
      return;
    }
    if (message.t === 'error') {
      this.children.delete(message.id);
      child.emit('error', requestError(message.code ?? 'EBROKER', String(message.message ?? 'broker error')));
      child.settle(null, null);
    }
  }

  #write(message) {
    if (!this.socket || this.socket.destroyed) throw requestError('EBROKERLOST', 'Not connected to the command broker.');
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  /** Handshake; resolves with the broker's description of itself or rejects. */
  async hello({ timeoutMs = 3000 } = {}) {
    await this.#connect();
    const answer = new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.helloWaiters.push(waiter);
      setTimeout(() => { const at = this.helloWaiters.indexOf(waiter); if (at >= 0) { this.helloWaiters.splice(at, 1); reject(requestError('EBROKERDOWN', 'The command broker did not answer.')); } }, timeoutMs).unref?.();
    });
    this.#write({ t: 'hello', v: PROTOCOL_VERSION });
    const message = await answer;
    if (!message.ok || message.v !== PROTOCOL_VERSION) throw requestError('EBROKERDOWN', 'The command broker speaks another protocol version.');
    return message;
  }

  /** Same shape as child_process.spawn() for what the runners use: cwd, env and (as `timeout`) a time limit. */
  spawn(file, args = [], options = {}) {
    const child = new BrokerChild(this);
    child.id = this.nextId++;
    this.children.set(child.id, child);
    const env = {};
    for (const [name, value] of Object.entries(options.env ?? {})) if (value !== undefined && value !== null) env[name] = String(value);
    this.#connect().then(() => {
      if (child.finished) return;
      this.#write({
        t: 'run', id: child.id, file, args: args.map(String), cwd: options.cwd, env,
        timeoutMs: options.timeout, maxOutputBytes: options.maxOutputBytes,
      });
    }).catch((error) => {
      this.children.delete(child.id);
      child.emit('error', error);
      child.settle(null, null);
    });
    return child;
  }

  signal(id, signal) {
    try { this.#write({ t: 'signal', id, signal }); } catch { /* the loss handler settles the child */ }
  }

  /** Called when a run is over: reading the socket never stays paused for a run that no longer exists. */
  resumeReading() {
    if (this.socket && !this.socket.destroyed) this.socket.resume();
  }

  /** The spawn function to hand to the runners. */
  get spawner() { return (file, args, options) => this.spawn(file, args, options); }

  close() {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }
}
