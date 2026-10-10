#!/usr/bin/env node
// Supervisor of the container: the only part of the public server that runs as root, and the only part that is allowed to.
//
// What it does, in order:
//   1. Looks up the three accounts the image defines: hub (runs the server), agent (runs the programs the agent asks for) and the
//      group ws that both share for the workspace files. Nobody else may be root-equivalent.
//   2. Prepares the folders with exact owners and modes (state: hub only; workspaces: hub writes, ws reads; agent home; and the empty,
//      root-owned folder Git is pointed at as core.hooksPath so that no repository hook can run).
//   3. Starts the command broker (lib/exec-broker.mjs) on a Unix socket only the hub account can open, and PROVES that the
//      separation works on this very machine: a probe command is run as the agent and must report the agent's uid, no capabilities
//      and no_new_privs, and must be unable to read a decoy "hub" process's environment, the state folder or the socket.
//      When the probe fails (a platform that forbids switching accounts, a missing tool) the server still starts, in "no-shell"
//      mode: no command can run at all. It never falls back to running agent commands as the hub account.
//   4. Starts the server as the hub account with no capabilities and no_new_privs, passes the exit mode it settled on, and checks
//      once more, against the real server process, that the agent cannot read its environment.
//   5. Forwards SIGTERM/SIGINT, and when the server ends it stops the broker (which kills every process of the agent account) and exits.
//
// `node docker/supervisor.mjs --self-test` runs steps 1-3 against a decoy process and prints one JSON line (exit 0 = separation proven).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BrokerClient, DEFAULT_LIMITS, locateLauncherTools, startBrokerServer } from '../lib/exec-broker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB_ENTRY = path.join(HERE, '..', 'hub.mjs');
const EXIT_CONFIG = 78; // EX_CONFIG: the container is set up wrongly
const EXIT_SEPARATION = 70; // EX_SOFTWARE: the separation check failed against the real server

const stamp = (message) => process.stdout.write(`[SUPERVISOR] ${message}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------------- accounts
async function readTable(file) {
  try { return (await fs.readFile(file, 'utf8')).split('\n').map((line) => line.split(':')); } catch { return []; }
}

export async function lookupUser(name, { file = '/etc/passwd' } = {}) {
  const row = (await readTable(file)).find((fields) => fields[0] === name && fields.length >= 6);
  return row ? { name, uid: Number(row[2]), gid: Number(row[3]), home: row[5] } : null;
}

export async function lookupGroup(name, { file = '/etc/group' } = {}) {
  const row = (await readTable(file)).find((fields) => fields[0] === name && fields.length >= 3);
  return row ? { name, gid: Number(row[2]) } : null;
}

const numeric = (value) => (value !== undefined && /^[0-9]{1,9}$/.test(String(value).trim()) ? Number(value) : null);

/** hub / agent / ws as numbers. CHATMCP_*_UID/GID override the lookup (tests use ids without /etc/passwd entries). */
export async function resolveAccounts(env = process.env) {
  const userName = (key, fallback) => String(env[key] ?? fallback).trim() || fallback;
  const hubName = userName('CHATMCP_HUB_USER', 'hub');
  const agentName = userName('CHATMCP_AGENT_USER', 'agent');
  const wsName = userName('CHATMCP_WS_GROUP', 'ws');
  const hubRow = await lookupUser(hubName);
  const agentRow = await lookupUser(agentName);
  const wsRow = await lookupGroup(wsName);
  const hub = { name: hubName, uid: numeric(env.CHATMCP_HUB_UID) ?? hubRow?.uid ?? null, gid: numeric(env.CHATMCP_HUB_GID) ?? hubRow?.gid ?? null, home: env.CHATMCP_HUB_HOME || hubRow?.home || '/var/lib/chatmcp/home' };
  const agent = { name: agentName, uid: numeric(env.CHATMCP_AGENT_UID) ?? agentRow?.uid ?? null, gid: numeric(env.CHATMCP_AGENT_GID) ?? agentRow?.gid ?? null, home: env.CHATMCP_AGENT_HOME || agentRow?.home || '/home/agent' };
  const wsGid = numeric(env.CHATMCP_WS_GID) ?? wsRow?.gid ?? null;
  const problems = [];
  if (hub.uid === null || hub.gid === null) problems.push(`tài khoản "${hubName}" chưa có trong image`);
  if (agent.uid === null || agent.gid === null) problems.push(`tài khoản "${agentName}" chưa có trong image`);
  if (wsGid === null) problems.push(`nhóm "${wsName}" chưa có trong image`);
  if (problems.length === 0) {
    if (hub.uid === 0 || agent.uid === 0 || hub.gid === 0 || agent.gid === 0 || wsGid === 0) problems.push('hub/agent/ws không được là root');
    if (hub.uid === agent.uid) problems.push('hub và agent phải là hai tài khoản khác nhau');
    if (hub.gid === agent.gid || hub.gid === wsGid || agent.gid === hub.gid) problems.push('nhóm chính của hub, agent và nhóm ws phải khác nhau');
    if (agent.gid === wsGid) problems.push('nhóm chính của agent không được là nhóm ws (dùng nhóm riêng)');
  }
  return { ok: problems.length === 0, problems, hub, agent, wsGid };
}

// ---------------------------------------------------------------------------------------------------------------- folders
async function ensureDirectory(directory, { uid, gid, mode }) {
  await fs.mkdir(directory, { recursive: true });
  await fs.chown(directory, uid, gid);
  await fs.chmod(directory, mode);
}

/**
 * The empty folder Git is pointed at (core.hooksPath) so that no hook of a repository can run. Root owns it and nobody else may add a
 * file: a hook the agent could plant there would run in every repository. A folder that already has content, or is a link, is a
 * configuration error: this must never chmod or chown something that is not the empty folder the image made for it.
 */
export async function ensureHooksDirectory(directory) {
  const existing = await fs.lstat(directory).catch(() => null);
  if (existing) {
    if (!existing.isDirectory()) throw new Error(`${directory} không phải thư mục thường`);
    if ((await fs.readdir(directory)).length) throw new Error(`${directory} phải là thư mục rỗng (đang dùng làm core.hooksPath)`);
  } else {
    await fs.mkdir(directory, { recursive: true });
  }
  await fs.chown(directory, 0, 0);
  await fs.chmod(directory, 0o555);
}

/** Creates and sets the owner and mode of every folder the server and the agent use. Needs root. */
export async function prepareFilesystem({ accounts, paths, gitIdentity }) {
  const { hub, agent, wsGid } = accounts;
  await ensureDirectory(paths.dataRoot, { uid: 0, gid: 0, mode: 0o755 });
  await ensureDirectory(paths.state, { uid: hub.uid, gid: hub.gid, mode: 0o700 });
  await ensureDirectory(paths.tmp, { uid: hub.uid, gid: hub.gid, mode: 0o700 });
  await ensureDirectory(paths.hubHome, { uid: hub.uid, gid: hub.gid, mode: 0o700 });
  // The agent may read and walk the workspaces folder but not change it: only the server creates or removes a workspace, so the agent
  // cannot replace a workspace folder by a link to somewhere else between the server's check and its use.
  await ensureDirectory(paths.workspaces, { uid: hub.uid, gid: wsGid, mode: 0o2750 });
  await ensureDirectory(paths.agentHome, { uid: agent.uid, gid: agent.gid, mode: 0o700 });
  await ensureDirectory(paths.socketDir, { uid: 0, gid: hub.gid, mode: 0o750 });
  await ensureHooksDirectory(paths.noHooks);
  // Git refuses a repository owned by another account ("dubious ownership"); the workspaces are owned by the server's account.
  // It only honours safe.directory = * in the global file, so the agent's own global file says it.
  const identity = (text, fallback) => (/^[^\r\n"\\<>]{1,100}$/.test(text ?? '') ? text : fallback);
  const gitconfig = [
    '[safe]', '\tdirectory = *',
    '[user]', `\tname = ${identity(gitIdentity?.name, 'ChatMCP Agent')}`, `\temail = ${identity(gitIdentity?.email, 'agent@chatmcp.invalid')}`,
    '[init]', '\tdefaultBranch = main', '',
  ].join('\n');
  // The agent owns its home, so whatever sits at this name may have been put there by the agent. A link is removed (not followed), the
  // file is created with O_EXCL (never through a link) and handed over by descriptor, so a link swapped in meanwhile cannot make root
  // change the owner of something else.
  const target = path.join(paths.agentHome, '.gitconfig');
  await fs.rm(target, { force: true });
  const handle = await fs.open(target, 'wx', 0o644);
  try {
    await handle.chown(agent.uid, agent.gid);
    await handle.chmod(0o644);
    await handle.writeFile(gitconfig);
  } finally { await handle.close(); }
}

// ---------------------------------------------------------------------------------------------------------------- the proof
function parseProbe(stdout) {
  const values = {};
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/**
 * Runs one probe command as the agent, through the broker, and compares what it reports with what must hold.
 * `decoyPid` is a process of the hub account whose environment the agent must not be able to read.
 */
export async function probeSeparation({ client, accounts, paths, decoyPid, socketPath }) {
  const script = [
    'echo "UID=$(id -u)"',
    'echo "GIDS=$(id -G)"',
    'echo "CAPEFF=$(sed -n \'s/^CapEff:[[:space:]]*//p\' /proc/self/status)"',
    'echo "CAPBND=$(sed -n \'s/^CapBnd:[[:space:]]*//p\' /proc/self/status)"',
    'echo "NONEWPRIVS=$(sed -n \'s/^NoNewPrivs:[[:space:]]*//p\' /proc/self/status)"',
    'echo "UMASK=$(umask)"',
    'if [ -d "/proc/$DECOY" ]; then echo "HUBVISIBLE=yes"; else echo "HUBVISIBLE=no"; fi',
    'if cat "/proc/$DECOY/environ" >/dev/null 2>&1; then echo "HUBENV=readable"; else echo "HUBENV=denied"; fi',
    'if kill -0 "$DECOY" 2>/dev/null; then echo "HUBSIGNAL=allowed"; else echo "HUBSIGNAL=denied"; fi',
    'if ls "$STATE" >/dev/null 2>&1; then echo "STATE=listable"; else echo "STATE=denied"; fi',
    'if (: > "$WSROOT/.probe-write") 2>/dev/null; then rm -f "$WSROOT/.probe-write"; echo "WSROOT=writable"; else echo "WSROOT=readonly"; fi',
    'if [ -w "$SOCKET" ]; then echo "SOCKET=writable"; else echo "SOCKET=denied"; fi',
    'echo "HOME=$HOME"',
    'echo "END=1"',
  ].join('\n');
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });
  const child = client.spawn('/bin/sh', ['-c', script], {
    cwd: paths.workspaces,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', DECOY: String(decoyPid), STATE: paths.state, WSROOT: paths.workspaces, SOCKET: socketPath, HOME: accounts.agent.home },
    timeout: 20_000, maxOutputBytes: 64 * 1024,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (result.error) return { ok: false, checks: [{ name: 'probe-ran', ok: false, detail: String(result.error.message).slice(0, 300) }] };
  const seen = parseProbe(out);
  record('probe-ran', result.code === 0 && seen.END === '1', `exit=${result.code} stderr=${err.trim().slice(0, 160)}`);
  record('agent-uid', Number(seen.UID) === accounts.agent.uid, `uid=${seen.UID}`);
  const gids = (seen.GIDS ?? '').split(/\s+/).filter(Boolean).map(Number);
  record('agent-groups', gids.includes(accounts.agent.gid) && gids.includes(accounts.wsGid) && !gids.includes(accounts.hub.gid) && !gids.includes(0), `groups=${gids.join(',')}`);
  record('no-capabilities', /^0+$/.test(seen.CAPEFF ?? 'x') && /^0+$/.test(seen.CAPBND ?? 'x'), `CapEff=${seen.CAPEFF} CapBnd=${seen.CAPBND}`);
  record('no-new-privs', seen.NONEWPRIVS === '1', `NoNewPrivs=${seen.NONEWPRIVS}`);
  record('umask-group-writable', seen.UMASK === '0002' || seen.UMASK === '002', `umask=${seen.UMASK}`);
  // When the platform hides other processes altogether (hidepid) the two checks below hold trivially; the detail says so.
  record('hub-environ-unreadable', seen.HUBENV === 'denied', `HUBENV=${seen.HUBENV} visible=${seen.HUBVISIBLE}`);
  record('hub-not-signalable', seen.HUBSIGNAL === 'denied', `HUBSIGNAL=${seen.HUBSIGNAL} visible=${seen.HUBVISIBLE}`);
  record('state-unreadable', seen.STATE === 'denied', `STATE=${seen.STATE}`);
  record('workspaces-root-readonly', seen.WSROOT === 'readonly', `WSROOT=${seen.WSROOT}`);
  record('broker-socket-unreachable', seen.SOCKET === 'denied', `SOCKET=${seen.SOCKET}`);
  record('agent-home', seen.HOME === accounts.agent.home, `HOME=${seen.HOME}`);
  return { ok: checks.every((check) => check.ok), checks };
}

/** A stand-in for the server: a process of the hub account that holds a secret in its environment. */
export async function startDecoy({ accounts, tools }) {
  const decoy = spawn(tools.setpriv, [
    `--reuid=${accounts.hub.uid}`, `--regid=${accounts.hub.gid}`, `--groups=${[accounts.hub.gid, accounts.wsGid].join(',')}`,
    '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--pdeathsig=KILL', '--', '/bin/sleep', '120',
  ], { env: { PATH: '/usr/bin:/bin', CHATMCP_DECOY_SECRET: randomBytes(16).toString('hex') }, stdio: 'ignore' });
  await sleep(150);
  return decoy;
}

// ---------------------------------------------------------------------------------------------------------------- configuration
function limitsFromEnv(env) {
  const memoryMb = Number(env.CHATMCP_AGENT_MEMORY_MB ?? 384);
  return {
    ...(Number.isFinite(memoryMb) && memoryMb > 0 ? { dataBytes: Math.floor(memoryMb) * 1024 * 1024 } : {}),
    maxRunMs: Math.max(10, Math.min(900, Number(env.CHATMCP_COMMAND_MAX_SECONDS) || 300)) * 1000,
  };
}

export function pathsFromEnv(env = process.env) {
  const dataRoot = path.resolve(env.CHATMCP_DATA_ROOT || '/var/lib/chatmcp');
  const socket = path.resolve(env.CHATMCP_EXEC_BROKER || '/run/chatmcp/broker.sock');
  return {
    dataRoot,
    state: path.resolve(env.CHATMCP_STATE_DIR || path.join(dataRoot, 'state')),
    workspaces: path.resolve(env.CHATMCP_WORKSPACES_ROOT || path.join(dataRoot, 'workspaces')),
    tmp: path.join(dataRoot, 'tmp'),
    hubHome: path.join(dataRoot, 'home'),
    agentHome: path.resolve(env.CHATMCP_AGENT_HOME || '/home/agent'),
    noHooks: path.resolve(env.CHATMCP_NO_HOOKS_DIR || '/opt/chatmcp/no-hooks'),
    socket,
    socketDir: path.dirname(socket),
  };
}

/** Brings the broker up and proves the separation; resolves with a handle, or { broker: null, reason } to run without commands. */
async function startSeparatedExecution({ accounts, paths, env, log }) {
  const tools = await locateLauncherTools();
  const missing = Object.entries(tools).filter(([, file]) => !file).map(([name]) => name);
  if (missing.length) return { broker: null, reason: `thiếu công cụ ${missing.join(', ')} (gói util-linux)` };
  let broker;
  try {
    broker = await startBrokerServer({
      socketPath: paths.socket,
      agent: { uid: accounts.agent.uid, gid: accounts.agent.gid, groups: [accounts.agent.gid, accounts.wsGid], name: accounts.agent.name, home: accounts.agent.home },
      cwdRoots: [paths.workspaces],
      socketOwner: { uid: 0, gid: accounts.hub.gid },
      socketMode: 0o660,
      umask: 0o002,
      limits: limitsFromEnv(env),
      log,
    });
  } catch (error) { return { broker: null, reason: `môi giới lệnh không khởi động được: ${error.message}` }; }
  const client = new BrokerClient({ socketPath: paths.socket });
  const decoy = await startDecoy({ accounts, tools });
  let proof;
  try {
    await client.hello();
    proof = await probeSeparation({ client, accounts, paths, decoyPid: decoy.pid, socketPath: paths.socket });
  } catch (error) {
    proof = { ok: false, checks: [{ name: 'probe-ran', ok: false, detail: String(error.message).slice(0, 300) }] };
  } finally {
    client.close();
    try { decoy.kill('SIGKILL'); } catch { /* gone */ }
  }
  if (!proof.ok) {
    await broker.close().catch(() => {});
    const failed = proof.checks.filter((check) => !check.ok).map((check) => `${check.name} (${check.detail})`);
    return { broker: null, reason: `kiểm tra tách quyền không đạt: ${failed.join('; ')}`, proof };
  }
  return { broker, proof, tools };
}

// ---------------------------------------------------------------------------------------------------------------- the server process
function hubEnvironment({ env, accounts, paths, execMode }) {
  const next = { ...env };
  // Anything that only the supervisor needs, or that would point the server at the wrong account, is replaced.
  Object.assign(next, {
    HOME: paths.hubHome, USER: accounts.hub.name, LOGNAME: accounts.hub.name, TMPDIR: paths.tmp,
    CHATMCP_PUBLIC: env.CHATMCP_PUBLIC ?? '1', CHATMCP_STATE_DIR: paths.state, CHATMCP_WORKSPACES_ROOT: paths.workspaces,
    CHATMCP_EXEC_MODE: execMode, CHATMCP_NO_HOOKS_DIR: paths.noHooks,
  });
  if (execMode === 'broker') next.CHATMCP_EXEC_BROKER = paths.socket; else delete next.CHATMCP_EXEC_BROKER;
  return next;
}

function startHub({ env, accounts, paths, execMode, tools }) {
  const heap = Number(env.CHATMCP_HUB_HEAP_MB) > 0 ? Math.floor(Number(env.CHATMCP_HUB_HEAP_MB)) : 192;
  const hubEnv = hubEnvironment({ env, accounts, paths, execMode });
  const args = [
    `--reuid=${accounts.hub.uid}`, `--regid=${accounts.hub.gid}`, `--groups=${[accounts.hub.gid, accounts.wsGid].join(',')}`,
    '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--pdeathsig=KILL', '--',
    process.execPath, `--max-old-space-size=${heap}`, HUB_ENTRY, '--backend', 'local', '--state-dir', paths.state,
  ];
  return spawn(tools.setpriv, args, { env: hubEnv, stdio: 'inherit', cwd: '/' });
}

// ---------------------------------------------------------------------------------------------------------------- main
export async function main(argv = process.argv.slice(2), env = process.env) {
  const selfTest = argv.includes('--self-test');
  const paths = pathsFromEnv(env);
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    stamp('Không chạy bằng root nên không tách được tài khoản; khởi động server ở chế độ no-shell (agent không chạy được lệnh).');
    if (selfTest) { console.log(JSON.stringify({ ok: false, reason: 'not-root' })); return 1; }
    return await runWithoutSeparation({ env, paths });
  }
  const accounts = await resolveAccounts(env);
  if (!accounts.ok) {
    stamp(`Cấu hình tài khoản sai: ${accounts.problems.join('; ')}.`);
    if (selfTest) { console.log(JSON.stringify({ ok: false, reason: 'accounts', problems: accounts.problems })); return 1; }
    return EXIT_CONFIG;
  }
  const requested = String(env.CHATMCP_EXEC_MODE ?? 'broker').trim().toLowerCase();
  try {
    await prepareFilesystem({ accounts, paths, gitIdentity: { name: env.CHATMCP_GIT_AUTHOR_NAME, email: env.CHATMCP_GIT_AUTHOR_EMAIL } });
  } catch (error) {
    stamp(`Không chuẩn bị được thư mục: ${error.message}`);
    if (selfTest) { console.log(JSON.stringify({ ok: false, reason: 'filesystem', detail: String(error.message).slice(0, 300) })); return 1; }
    return EXIT_CONFIG;
  }
  const tools = await locateLauncherTools();
  if (!tools.setpriv) {
    stamp('Thiếu setpriv (gói util-linux): không hạ quyền được server.');
    return selfTest ? (console.log(JSON.stringify({ ok: false, reason: 'setpriv-missing' })), 1) : EXIT_CONFIG;
  }

  let execution = { broker: null, reason: 'CHATMCP_EXEC_MODE không phải broker' };
  if (requested === 'broker' || selfTest) execution = await startSeparatedExecution({ accounts, paths, env, log: stamp });
  if (selfTest) {
    console.log(JSON.stringify({ ok: Boolean(execution.broker), reason: execution.reason ?? null, checks: execution.proof?.checks ?? [] }));
    await execution.broker?.close();
    return execution.broker ? 0 : 1;
  }
  let execMode = 'no-shell';
  if (requested === 'same-user') execMode = 'same-user';
  if (execution.broker) {
    execMode = 'broker';
    stamp(`Đã chứng minh tách quyền trên máy này (${execution.proof.checks.length} kiểm tra đạt); lệnh của agent chạy bằng uid ${accounts.agent.uid}.`);
  } else if (requested === 'broker') {
    stamp(`CẢNH BÁO: ${execution.reason}. Server khởi động ở chế độ no-shell: agent KHÔNG chạy được lệnh, chỉ dùng công cụ file và Git.`);
  }

  const hub = startHub({ env, accounts, paths, execMode, tools });
  let stopping = false;
  let hubExit = null;
  const exited = new Promise((resolve) => { hub.once('exit', (code, signal) => { hubExit = { code, signal }; resolve(); }); hub.once('error', (error) => { stamp(`Không chạy được server: ${error.message}`); hubExit = { code: 1, signal: null }; resolve(); }); });
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    stamp(`Nhận ${signal}; đang dừng server.`);
    try { hub.kill('SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { hub.kill('SIGKILL'); } catch { /* gone */ } }, 10_000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  if (execution.broker && hub.pid) {
    // The same proof, now against the real server process. A failure here stops everything: this is the property the design rests on.
    // A server that has already stopped (a configuration error, say) has nothing to prove: its exit code is the answer.
    await sleep(800);
    const client = new BrokerClient({ socketPath: paths.socket });
    try {
      if (hubExit) throw Object.assign(new Error('server đã dừng trước khi kiểm tra'), { skipped: true });
      await client.hello();
      const proof = await probeSeparation({ client, accounts, paths, decoyPid: hub.pid, socketPath: paths.socket });
      if (hubExit) throw Object.assign(new Error('server đã dừng trong lúc kiểm tra'), { skipped: true });
      if (!proof.ok) {
        const failed = proof.checks.filter((check) => !check.ok).map((check) => `${check.name} (${check.detail})`);
        stamp(`DỪNG: kiểm tra tách quyền với server thật không đạt: ${failed.join('; ')}`);
        try { hub.kill('SIGKILL'); } catch { /* gone */ }
        await exited;
        await execution.broker.close().catch(() => {});
        return EXIT_SEPARATION;
      }
      stamp('Kiểm tra lần hai với tiến trình server thật: agent không đọc được môi trường, không gửi tín hiệu, không mở được socket môi giới.');
    } catch (error) {
      if (!error.skipped) {
        stamp(`DỪNG: không kiểm tra được tách quyền với server thật: ${error.message}`);
        try { hub.kill('SIGKILL'); } catch { /* gone */ }
        await exited;
        await execution.broker.close().catch(() => {});
        return EXIT_SEPARATION;
      }
      stamp(`Bỏ qua kiểm tra lần hai: ${error.message}.`);
    } finally { client.close(); }
  }

  await exited;
  await execution.broker?.close().catch(() => {});
  if (hubExit.signal) return 128 + ({ SIGTERM: 15, SIGINT: 2, SIGKILL: 9 }[hubExit.signal] ?? 1);
  return hubExit.code ?? 1;
}

async function runWithoutSeparation({ env, paths }) {
  const hubEnv = { ...env, CHATMCP_EXEC_MODE: 'no-shell', CHATMCP_STATE_DIR: env.CHATMCP_STATE_DIR || paths.state, CHATMCP_WORKSPACES_ROOT: paths.workspaces };
  delete hubEnv.CHATMCP_EXEC_BROKER;
  const child = spawn(process.execPath, [HUB_ENTRY, '--backend', 'local', '--state-dir', hubEnv.CHATMCP_STATE_DIR], { env: hubEnv, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { try { child.kill(signal); } catch { /* gone */ } });
  return await new Promise((resolve) => { child.once('exit', (code, signal) => resolve(signal ? 143 : code ?? 1)); child.once('error', () => resolve(1)); });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code), (error) => { stamp(`Lỗi không xử lý: ${error?.stack ?? error}`); process.exit(1); });
}
export { DEFAULT_LIMITS };
