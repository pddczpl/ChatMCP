// The separation of accounts, tested with REAL accounts: the root-only half of the public server.
//
// verify-exec-broker.mjs covers the broker's protocol and limits with a stand-in launcher that needs no privileges. This suite is the
// other half. It runs the real launcher (prlimit + setpriv + env -i) and the real reaper as root, with three throw-away accounts
// (a hub, an agent, a stranger) and one shared group, and checks what the design rests on:
//   - a command of the agent really has the agent's uid and groups, no capability and no_new_privs (a setuid-root program does not
//     raise it), and the resource limits it was given; what it leaves behind - also in a session of its own - is killed afterwards;
//   - the folders docker/supervisor.mjs prepares let the hub do its work and keep the agent out of everything except its own home and
//     the workspaces (read-only at the top, read-write inside a workspace the hub made), and the hub can still remove a tree the
//     agent made without any permission for itself;
//   - the proof the supervisor runs at start-up (probeSeparation) passes on the real thing and FAILS, check by check, for each way of
//     getting the separation wrong (the agent is the hub, no no_new_privs, capabilities kept, a hub group kept, umask 022);
//   - `supervisor.mjs --self-test` as a process, with the mistakes it must stop on;
//   - the empty hooks folder keeps repository hooks from running and the agent cannot fill it.
// It needs Linux, root, util-linux (setpriv, prlimit) and a machine that lets root switch accounts. Otherwise only the pure checks
// run and the suite reports itself as skipped (never as passed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BrokerClient, DEFAULT_LIMITS, launchAsAgent, listProcessesOfUid, reapAgentProcesses, startBrokerServer,
} from '../lib/exec-broker.mjs';
import {
  ensureHooksDirectory, lookupGroup, lookupUser, pathsFromEnv, prepareFilesystem, probeSeparation, resolveAccounts, startDecoy,
} from '../docker/supervisor.mjs';
import { waitFor } from './e2e/hub-process.mjs';
import { findProgram, findPrograms, realAccountsAvailable } from './fixtures/real-accounts.mjs';

let checks = 0;
const notes = [];
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const notApplicable = (label) => { notes.push(label); console.log(`  skip - ${label}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(() => { console.error('FAIL: the exec-separation suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPERVISOR = path.join(HUB_ROOT, 'docker', 'supervisor.mjs');
const PROBE_NAMES = [
  'probe-ran', 'agent-uid', 'agent-groups', 'no-capabilities', 'no-new-privs', 'umask-group-writable', 'hub-environ-unreadable',
  'hub-not-signalable', 'state-unreadable', 'workspaces-root-readonly', 'broker-socket-unreachable', 'agent-home',
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Pure checks: account tables, the rules for the three accounts, the folder layout. No root, no /proc, so they run on Windows too.
// ---------------------------------------------------------------------------------------------------------------------------------
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-sep-pure-'));
  try {
    const passwd = path.join(dir, 'passwd');
    await fs.writeFile(passwd, [
      'root:x:0:0:root:/root:/bin/bash', '# a comment line', '', 'hub:x:10000:10000::/var/lib/chatmcp/home:/usr/sbin/nologin',
      'agent:x:10001:10001::/home/agent:/bin/sh', 'short:x:5:5', 'agentish:x:10003:10003::/home/agentish:/bin/sh',
    ].join('\n'));
    assert.deepEqual(await lookupUser('hub', { file: passwd }), { name: 'hub', uid: 10000, gid: 10000, home: '/var/lib/chatmcp/home' });
    assert.deepEqual(await lookupUser('agent', { file: passwd }), { name: 'agent', uid: 10001, gid: 10001, home: '/home/agent' }, 'a whole name is matched, not a prefix');
    assert.equal(await lookupUser('short', { file: passwd }), null, 'a line with too few fields is not an account');
    assert.equal(await lookupUser('nobody-here', { file: passwd }), null);
    assert.equal(await lookupUser('# a comment line', { file: passwd }), null);
    assert.equal(await lookupUser('hub', { file: path.join(dir, 'missing') }), null, 'a missing table finds nobody');
    const groups = path.join(dir, 'group');
    await fs.writeFile(groups, ['root:x:0:', 'ws:x:10002:hub,agent', 'wsx:x:10009:', 'broken:x'].join('\n'));
    assert.deepEqual(await lookupGroup('ws', { file: groups }), { name: 'ws', gid: 10002 });
    assert.equal(await lookupGroup('broken', { file: groups }), null);
    assert.equal(await lookupGroup('nothing', { file: groups }), null);
    ok('the account tables are read exactly: whole names only, short or missing lines and files find nobody');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }

  const GOOD = {
    CHATMCP_HUB_USER: 'chatmcp-test-hub', CHATMCP_AGENT_USER: 'chatmcp-test-agent', CHATMCP_WS_GROUP: 'chatmcp-test-ws',
    CHATMCP_HUB_UID: '10000', CHATMCP_HUB_GID: '10000', CHATMCP_AGENT_UID: '10001', CHATMCP_AGENT_GID: '10001', CHATMCP_WS_GID: '10002',
    CHATMCP_AGENT_HOME: '/home/agent-test',
  };
  const good = await resolveAccounts(GOOD);
  assert.equal(good.ok, true);
  assert.deepEqual(good.problems, []);
  assert.deepEqual([good.hub.uid, good.hub.gid, good.agent.uid, good.agent.gid, good.wsGid], [10000, 10000, 10001, 10001, 10002]);
  assert.equal(good.agent.home, '/home/agent-test');
  assert.equal(good.agent.name, 'chatmcp-test-agent');
  const wrong = async (patch, pattern, label) => {
    const result = await resolveAccounts({ ...GOOD, ...patch });
    assert.equal(result.ok, false, `${label}: must be refused`);
    assert.ok(result.problems.some((problem) => pattern.test(problem)), `${label}: ${JSON.stringify(result.problems)}`);
    return result;
  };
  await wrong({ CHATMCP_HUB_UID: '0' }, /root/, 'the hub as root');
  await wrong({ CHATMCP_HUB_GID: '0' }, /root/, 'the hub in the root group');
  await wrong({ CHATMCP_AGENT_UID: '0' }, /root/, 'the agent as root');
  await wrong({ CHATMCP_AGENT_GID: '0' }, /root/, 'the agent in the root group');
  await wrong({ CHATMCP_WS_GID: '0' }, /root/, 'the shared group is root');
  await wrong({ CHATMCP_AGENT_UID: '10000' }, /khác nhau/, 'one account for hub and agent');
  await wrong({ CHATMCP_AGENT_GID: '10000' }, /nhóm chính/, 'hub and agent share a primary group');
  await wrong({ CHATMCP_WS_GID: '10000' }, /nhóm chính/, 'the shared group is the hub\'s group');
  await wrong({ CHATMCP_WS_GID: '10001' }, /nhóm ws/, 'the shared group is the agent\'s group');
  for (const [key, label] of [['CHATMCP_HUB_UID', 'hub'], ['CHATMCP_HUB_GID', 'hub'], ['CHATMCP_AGENT_UID', 'agent'], ['CHATMCP_AGENT_GID', 'agent'], ['CHATMCP_WS_GID', 'ws']]) {
    const { [key]: removed, ...rest } = GOOD; // eslint-disable-line no-unused-vars
    const result = await resolveAccounts(rest);
    assert.equal(result.ok, false, `${key} missing`);
    assert.ok(result.problems.some((problem) => /chưa có trong image/.test(problem) && problem.includes(label === 'ws' ? 'chatmcp-test-ws' : `chatmcp-test-${label}`)), `${key}: ${JSON.stringify(result.problems)}`);
  }
  for (const garbage of ['abc', '-1', '1e3', '', ' ', '12345678901', '1.5', '0x10', '１２３']) {
    const result = await resolveAccounts({ ...GOOD, CHATMCP_HUB_UID: garbage });
    assert.equal(result.ok, false, `an id like ${JSON.stringify(garbage)} is not an id`);
  }
  ok('three accounts are required and distinct; root, a shared primary group, a missing account and an id that is not a plain number are each refused');

  const defaults = pathsFromEnv({});
  const at = (...parts) => path.resolve(...parts);
  assert.deepEqual(
    { ...defaults },
    {
      dataRoot: at('/var/lib/chatmcp'), state: at('/var/lib/chatmcp/state'), workspaces: at('/var/lib/chatmcp/workspaces'), tmp: at('/var/lib/chatmcp/tmp'),
      hubHome: at('/var/lib/chatmcp/home'), agentHome: at('/home/agent'), noHooks: at('/opt/chatmcp/no-hooks'), socket: at('/run/chatmcp/broker.sock'), socketDir: at('/run/chatmcp'),
    },
  );
  const custom = pathsFromEnv({ CHATMCP_DATA_ROOT: '/data', CHATMCP_STATE_DIR: '/elsewhere/state', CHATMCP_WORKSPACES_ROOT: '/data/w', CHATMCP_EXEC_BROKER: '/sock/b.sock', CHATMCP_AGENT_HOME: '/h/a', CHATMCP_NO_HOOKS_DIR: '/n/h' });
  assert.deepEqual(
    { ...custom },
    { dataRoot: at('/data'), state: at('/elsewhere/state'), workspaces: at('/data/w'), tmp: at('/data', 'tmp'), hubHome: at('/data', 'home'), agentHome: at('/h/a'), noHooks: at('/n/h'), socket: at('/sock/b.sock'), socketDir: at('/sock') },
  );
  assert.ok(path.isAbsolute(pathsFromEnv({ CHATMCP_DATA_ROOT: 'relative/data' }).dataRoot), 'a relative folder becomes an absolute one');
  ok('the folder layout: defaults for the image, every folder overridable, always absolute, the socket folder is the socket\'s own folder');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Everything below needs root on Linux.
// ---------------------------------------------------------------------------------------------------------------------------------
function skipRest(reason) {
  console.log(`PASS: ${checks} checks of the pure parts of the account separation`);
  console.log(`CHATMCP_TEST_SKIP: ${reason}`);
  process.exit(0);
}
const available = await realAccountsAvailable();
if (!available.ok) skipRest(available.reason);
const { tools, ids, tempRoot } = available;
const { found: P, missing: lacking } = await findPrograms(['sh', 'id', 'sleep', 'dd', 'find', 'chmod', 'cat', 'ls', 'rm', 'mkdir', 'stat', 'env', 'touch', 'cp', 'chown']);
if (lacking.length) skipRest(`basic tools are missing: ${lacking.join(', ')}`);
P.git = await findProgram('git');

// ------------------------------------------------------------------------------------------------------------- environment and helpers
const base = await fs.realpath(await fs.mkdtemp(path.join(tempRoot, 'chatmcp-sep-')));
await fs.chmod(base, 0o755);
const running = new Set();
let brokerForCleanup = null;
process.once('exit', () => {
  for (const pid of running) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});

const ENV = {
  CHATMCP_HUB_USER: 'chatmcp-test-hub', CHATMCP_AGENT_USER: 'chatmcp-test-agent', CHATMCP_WS_GROUP: 'chatmcp-test-ws',
  CHATMCP_HUB_UID: String(ids.hub), CHATMCP_HUB_GID: String(ids.hub), CHATMCP_AGENT_UID: String(ids.agent), CHATMCP_AGENT_GID: String(ids.agent), CHATMCP_WS_GID: String(ids.ws),
  CHATMCP_DATA_ROOT: path.join(base, 'data'), CHATMCP_EXEC_BROKER: path.join(base, 'run', 'broker.sock'),
  CHATMCP_AGENT_HOME: path.join(base, 'agent-home'), CHATMCP_NO_HOOKS_DIR: path.join(base, 'no-hooks'), CHATMCP_HUB_HOME: path.join(base, 'data', 'home'),
};
const accounts = await resolveAccounts(ENV);
assert.equal(accounts.ok, true, JSON.stringify(accounts.problems));
const paths = pathsFromEnv(ENV);
const asLauncher = (account, groups) => ({ uid: account.uid, gid: account.gid, groups, name: account.name, home: account.home });
const AGENT = asLauncher(accounts.agent, [accounts.agent.gid, accounts.wsGid]);
const HUB = asLauncher(accounts.hub, [accounts.hub.gid, accounts.wsGid]);
const STRANGER = { uid: ids.stranger, gid: ids.stranger, groups: [ids.stranger], name: 'stranger', home: base };
const SAFE_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin' };

/** Runs a program as an account through the REAL launcher; stops waiting a moment after the exit even if a background process holds the pipes. */
function runAs(account, file, args = [], { cwd = base, env = {}, limits = {}, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = launchAsAgent({ file, args, cwd, env: { ...SAFE_ENV, HOME: account.home, ...env }, agent: account, limits: { ...DEFAULT_LIMITS, ...limits }, tools });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, signal: null, out, err, error }); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); resolve({ code, signal, out, err }); }, 250);
    });
  });
}
const sh = (account, script, options) => runAs(account, P.sh, ['-c', script], options);

/** Runs a program with no change of account (the control for the checks that need one). */
function capture(file, args, { cwd = base, env = SAFE_ENV, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, out, err, error }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const keyValues = (text) => Object.fromEntries(text.split('\n').filter((line) => /^[A-Za-z0-9_.-]+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const statusField = (text, name) => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(text)?.[1].trim();
const limitOf = (text, name) => { const match = new RegExp(`^Max ${name}\\s+(\\S+)\\s+(\\S+)`, 'm').exec(text); return match ? [match[1], match[2]] : null; };
async function ownerAndMode(target) { const stat = await fs.lstat(target); return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 }; }
async function noAgentProcesses(label) { assert.deepEqual(await listProcessesOfUid(accounts.agent.uid), [], `${label}: processes of the agent account are still running`); }
async function assertAlive(pid, label) { assert.doesNotThrow(() => process.kill(pid, 0), `${label}: process ${pid} must still be alive`); }

// Can root really switch to another account here? (gVisor, some user namespaces and hardened sandboxes say no.)
{
  const probe = await runAs(AGENT, P.id, ['-u'], { cwd: '/' });
  if (probe.code !== 0 || probe.out.trim() !== String(accounts.agent.uid)) {
    await fs.rm(base, { recursive: true, force: true });
    skipRest(`this machine does not let root switch to another account (exit ${probe.code}, stdout ${JSON.stringify(probe.out.trim())}, stderr ${JSON.stringify(probe.err.trim().slice(0, 120))})`);
  }
}
const nodeForAgent = await (async () => {
  const result = await runAs(AGENT, process.execPath, ['--version'], { cwd: '/' });
  return result.code === 0 && /^v\d+\./.test(result.out.trim());
})();

try {
  // -------------------------------------------------------------------------------------------------------------------------------
  // 1. The real launcher
  // -------------------------------------------------------------------------------------------------------------------------------
  const scratch = path.join(base, 'scratch');
  await fs.mkdir(scratch, { mode: 0o755 });
  await fs.chown(scratch, accounts.agent.uid, accounts.agent.gid);

  {
    const result = await sh(AGENT, 'cat /proc/self/status', { cwd: scratch });
    assert.equal(result.code, 0, result.err);
    const four = (name) => statusField(result.out, name).split(/\s+/).map(Number);
    assert.deepEqual(four('Uid'), Array(4).fill(accounts.agent.uid), 'real, effective, saved and filesystem uid are all the agent\'s');
    assert.deepEqual(four('Gid'), Array(4).fill(accounts.agent.gid));
    assert.deepEqual(four('Groups').sort((a, b) => a - b), [accounts.agent.gid, accounts.wsGid].sort((a, b) => a - b), 'supplementary groups: the agent\'s own and the shared one, nothing else (no root, no hub)');
    for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
      const value = statusField(result.out, name);
      if (value === undefined && name === 'CapAmb') continue; // kernels before 4.3 have no ambient set
      assert.match(value ?? 'missing', /^0+$/, `${name} must be empty`);
    }
    assert.equal(statusField(result.out, 'NoNewPrivs'), '1');
    const hub = await sh(HUB, 'cat /proc/self/status', { cwd: base });
    assert.deepEqual(statusField(hub.out, 'Groups').split(/\s+/).map(Number).sort((a, b) => a - b), [accounts.hub.gid, accounts.wsGid].sort((a, b) => a - b), 'the hub gets its own group and the shared one');
    assert.equal(statusField(hub.out, 'NoNewPrivs'), '1');
    assert.match(statusField(hub.out, 'CapBnd'), /^0+$/);
    ok('the real launcher: all four uids and gids are the account\'s, only the intended groups, no capability in any set, no_new_privs (hub and agent alike)');
  }

  {
    const directory = path.join(base, 'suid');
    await fs.mkdir(directory, { mode: 0o755 });
    const copy = path.join(directory, 'suid-id');
    await fs.copyFile(P.id, copy);
    await fs.chown(copy, 0, 0);
    await fs.chmod(copy, 0o4755);
    // The control: the same program under the same account WITHOUT no_new_privs becomes root. If it does not, this file system ignores
    // setuid and the check below would prove nothing.
    const control = await capture(tools.setpriv, [`--reuid=${accounts.agent.uid}`, `--regid=${accounts.agent.gid}`, '--clear-groups', '--', copy, '-u']);
    if (control.out.trim() !== '0') {
      notApplicable(`no_new_privs against a setuid-root program: this file system does not honour setuid (control printed ${JSON.stringify(control.out.trim())})`);
    } else {
      const guarded = await runAs(AGENT, copy, ['-u'], { cwd: scratch });
      assert.equal(guarded.out.trim(), String(accounts.agent.uid), 'with no_new_privs the setuid bit does nothing');
      ok('no_new_privs works: a setuid-root program (which does become root without it) stays the agent\'s uid');
    }
  }

  {
    // Some container runtimes hand PID 1 a non-empty inheritable capability set. In a parent that has one, a launcher that does not clear
    // the set would pass it on to the agent's program; --inh-caps=-all is what stops that.
    const script = path.join(base, 'dirty-parent.mjs');
    await fs.writeFile(script, [
      `import fs from 'node:fs';`,
      `import { DEFAULT_LIMITS, launchAsAgent } from ${JSON.stringify(pathToFileURL(path.join(HUB_ROOT, 'lib', 'exec-broker.mjs')).href)};`,
      `const spec = JSON.parse(process.argv[2]);`,
      `console.log('PARENT=' + /^CapInh:\\s*(\\S+)/m.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1]);`,
      `const child = launchAsAgent({ file: spec.file, args: ['/proc/self/status'], cwd: '/', env: { PATH: '/usr/bin:/bin' }, agent: spec.agent, limits: DEFAULT_LIMITS, tools: spec.tools });`,
      `let out = '';`,
      `child.stdout.on('data', (chunk) => { out += chunk; });`,
      `child.once('close', () => { console.log('AGENT=' + /^CapInh:\\s*(\\S+)/m.exec(out)?.[1]); });`,
    ].join('\n'));
    await fs.chmod(script, 0o644);
    const dirty = await capture(tools.setpriv, ['--inh-caps=+chown,+net_raw', '--', process.execPath, script, JSON.stringify({ file: P.cat, agent: AGENT, tools })], { cwd: '/' });
    assert.equal(dirty.code, 0, dirty.err);
    const seen = keyValues(dirty.out);
    assert.match(seen.PARENT, /[1-9a-f]/i, 'the control: the parent really has inheritable capabilities');
    assert.match(seen.AGENT ?? 'missing', /^0+$/, 'and the agent\'s program has none');
    ok('--inh-caps=-all clears the inheritable capabilities that a parent process has (control: the parent has some)');
  }

  {
    const table = 'grep -E "^Max (processes|open files|file size|core file size|data size)" /proc/self/limits';
    const fixed = await sh(AGENT, table, { cwd: scratch, limits: { nproc: 77, nofile: 55, fsizeBytes: 1048576, dataBytes: 300 * 1048576 } });
    assert.deepEqual(limitOf(fixed.out, 'processes'), ['77', '77'], 'soft and hard limit are the same, so the agent cannot raise them');
    assert.deepEqual(limitOf(fixed.out, 'open files'), ['55', '55']);
    assert.deepEqual(limitOf(fixed.out, 'file size'), ['1048576', '1048576']);
    assert.deepEqual(limitOf(fixed.out, 'core file size'), ['0', '0'], 'no core dumps (they would hold the memory of the program)');
    assert.deepEqual(limitOf(fixed.out, 'data size'), [String(300 * 1048576), String(300 * 1048576)]);
    const normal = await sh(AGENT, table, { cwd: scratch });
    assert.deepEqual(limitOf(normal.out, 'processes'), [String(DEFAULT_LIMITS.nproc), String(DEFAULT_LIMITS.nproc)]);
    assert.deepEqual(limitOf(normal.out, 'open files'), [String(DEFAULT_LIMITS.nofile), String(DEFAULT_LIMITS.nofile)]);
    assert.deepEqual(limitOf(normal.out, 'file size'), [String(DEFAULT_LIMITS.fsizeBytes), String(DEFAULT_LIMITS.fsizeBytes)]);
    assert.deepEqual(limitOf(normal.out, 'data size'), ['unlimited', 'unlimited'], 'without a memory setting there is no data limit');
    const raise = await sh(AGENT, 'ulimit -H -f 2000000 2>&1; echo "rc=$?"', { cwd: scratch, limits: { fsizeBytes: 1048576 } });
    assert.match(raise.out, /rc=[1-9]/, 'the agent cannot raise a hard limit');
    ok('resource limits reach the program as soft = hard limits (processes, open files, file size, data, no core files) and cannot be raised');
  }

  {
    const big = await sh(AGENT, 'dd if=/dev/zero of=./big bs=1024 count=3000 2>/dev/null; echo "rc=$?"; wc -c < ./big', { cwd: scratch, limits: { fsizeBytes: 1048576 } });
    assert.deepEqual(big.out.trim().split('\n'), ['rc=153', '1048576'], 'writing past the file-size limit ends the writer with SIGXFSZ and leaves exactly the limit on disk');
    const forks = await sh(AGENT, 'i=0; while [ $i -lt 30 ]; do (sleep 20 &) || break; i=$((i+1)); done; echo "started=$i"', { cwd: scratch, limits: { nproc: 12 } });
    const started = Number(/started=(\d+)/.exec(forks.out)?.[1] ?? 30);
    assert.ok(started < 30 && /Cannot fork|Resource temporarily unavailable/i.test(forks.err + forks.out), `the process limit stops a loop that forks (started ${started}): ${forks.err}`);
    assert.ok((await reapAgentProcesses(accounts.agent.uid)) >= 1, 'the sleeping processes it did start are still there to be reaped');
    const fits = await runAs(AGENT, P.dd, ['if=/dev/zero', 'of=/dev/null', 'bs=4M', 'count=1'], { cwd: scratch, limits: { dataBytes: 64 * 1048576 } });
    const toobig = await runAs(AGENT, P.dd, ['if=/dev/zero', 'of=/dev/null', 'bs=128M', 'count=1'], { cwd: scratch, limits: { dataBytes: 64 * 1048576 } });
    const unlimited = await runAs(AGENT, P.dd, ['if=/dev/zero', 'of=/dev/null', 'bs=128M', 'count=1'], { cwd: scratch });
    assert.equal(fits.code, 0, fits.err);
    assert.notEqual(toobig.code, 0, 'a 128 MiB buffer is refused under a 64 MiB data limit');
    assert.match(toobig.err, /memory exhausted|Cannot allocate/i);
    assert.equal(unlimited.code, 0, 'and allowed without the limit');
    await noAgentProcesses('after the limit tests');
    ok('the limits bite: file size (SIGXFSZ, exactly the limit on disk), process count (fork fails) and memory (a 128 MiB buffer fails under 64 MiB)');
  }

  {
    const printed = await sh(AGENT, 'printf "%s|" "$A" "$B" "$C" "$D" "$E" "$F"', { cwd: scratch, env: { A: '1=2', B: '$(echo hacked)', C: 'a b', D: ';touch evil', E: '', F: 'line1\nline2' } });
    assert.equal(printed.out, '1=2|$(echo hacked)|a b|;touch evil||line1\nline2|', 'values arrive byte for byte: no shell, no expansion');
    await assert.rejects(fs.lstat(path.join(scratch, 'evil')));
    const full = await runAs(AGENT, P.env, [], { cwd: scratch, env: { ONLY: 'this' } });
    assert.deepEqual(Object.keys(keyValues(full.out)).sort(), ['HOME', 'ONLY', 'PATH'], 'nothing but what was passed (and the HOME/PATH of the test) reaches the program');
    // An LD_PRELOAD that the root-owned helpers (prlimit, setpriv, env) would have honoured is reported once per program that loads it.
    const preload = await runAs(AGENT, P.sh, ['-c', 'echo ok'], { cwd: scratch, env: { LD_PRELOAD: '/nonexistent/evil.so' } });
    const complaints = (preload.err.match(/LD_PRELOAD/g) ?? []).length;
    assert.ok(complaints <= 1, `LD_PRELOAD reached ${complaints} programs; only the agent's own program may see it`);
    ok('the environment is rebuilt with env -i: values are passed byte for byte (no shell), nothing extra, and an LD_PRELOAD reaches only the agent\'s own program, not the root-owned helpers');
  }

  {
    const decoy = await startDecoy({ accounts, tools });
    running.add(decoy.pid);
    const setsidTool = await findProgram('setsid');
    const script = setsidTool ? `(${P.sleep} 100 &) ; (${setsidTool} ${P.sleep} 100 &) ; (${setsidTool} ${P.sh} -c '${P.sleep} 100 & ${P.sleep} 100' &) ; echo started` : `(${P.sleep} 100 &) ; (${P.sleep} 100 &) ; echo started`;
    const left = await sh(AGENT, script, { cwd: scratch });
    assert.equal(left.out.trim(), 'started');
    const before = await listProcessesOfUid(accounts.agent.uid);
    assert.ok(before.length >= (setsidTool ? 4 : 2), `the command left ${before.length} processes behind`);
    const started = Date.now();
    const killed = await reapAgentProcesses(accounts.agent.uid);
    assert.ok(killed >= before.length, `reaped ${killed} of ${before.length}`);
    assert.deepEqual(await listProcessesOfUid(accounts.agent.uid), []);
    assert.ok(Date.now() - started < 3000, 'reaping is quick');
    await assertAlive(decoy.pid, 'the hub\'s process');
    assert.ok((await listProcessesOfUid(accounts.hub.uid)).includes(decoy.pid), 'and it is still seen as the hub\'s');
    decoy.kill('SIGKILL');
    ok('the reaper kills what a command left behind - background jobs, a new session (setsid), a daemon with children - and nothing of the hub\'s');
  }

  {
    // A process can hold the agent's uid only as its effective uid (a set-uid program of the agent's, started by somebody else): it is the
    // agent's all the same, and the reaper has to find it by any of the four ids.
    const split = spawn(tools.setpriv, [`--ruid=${ids.stranger}`, `--euid=${accounts.agent.uid}`, '--', P.sleep, '100'], { stdio: 'ignore', detached: true });
    running.add(split.pid);
    const exited = new Promise((resolve) => split.once('exit', () => resolve('exited')));
    // The control reads /proc itself: what is being tested (listProcessesOfUid) must not be what decides whether the test applies.
    const uids = new RegExp(`^Uid:\\s+${ids.stranger}\\s+${accounts.agent.uid}\\s`, 'm');
    const split_ok = await waitFor(async () => (uids.test(await fs.readFile(`/proc/${split.pid}/status`, 'utf8').catch(() => '')) ? true : null), { timeoutMs: 3000, intervalMs: 50, label: 'the split-uid process to show' }).catch(() => false);
    if (!split_ok) {
      notApplicable('reaper and split uids: this setpriv cannot start a process with different real and effective uids');
    } else {
      await reapAgentProcesses(accounts.agent.uid);
      assert.equal(await Promise.race([exited, sleep(3000).then(() => 'alive')]), 'exited', 'the reaper killed a process that is the agent\'s only by its effective uid');
      ok('the reaper finds a process by its effective uid, not only by its real uid (control: /proc shows real uid = a stranger\'s, effective uid = the agent\'s)');
    }
    running.delete(split.pid);
    await noAgentProcesses('after the split-uid process');
  }

  {
    // The broker is a process of its own here, as in the container. If it is killed outright nothing runs the reaper, so the kernel has to
    // do it: --pdeathsig=KILL in the launcher.
    const socketPath = path.join(base, 'pdeath.sock');
    const host = path.join(base, 'broker-host.mjs');
    await fs.writeFile(host, [
      `import { startBrokerServer } from ${JSON.stringify(pathToFileURL(path.join(HUB_ROOT, 'lib', 'exec-broker.mjs')).href)};`,
      `const spec = JSON.parse(process.argv[2]);`,
      `await startBrokerServer({ socketPath: spec.socketPath, agent: spec.agent, cwdRoots: [spec.cwd], limits: { maxRunMs: 60000, killGraceMs: 1000, lingerMs: 400 } });`,
      `console.log('READY');`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'));
    await fs.chmod(host, 0o644);
    const hostProcess = spawn(process.execPath, [host, JSON.stringify({ socketPath, agent: AGENT, cwd: scratch })], { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(hostProcess.pid);
    let hostOut = '';
    hostProcess.stdout.on('data', (chunk) => { hostOut += chunk; });
    let hostErr = '';
    hostProcess.stderr.on('data', (chunk) => { hostErr += chunk; });
    try {
      await waitFor(async () => (hostOut.includes('READY') ? true : (hostProcess.exitCode !== null ? Promise.reject(Object.assign(new Error(`broker host ended: ${hostErr}`), { fatal: true })) : null)), { timeoutMs: 10_000, intervalMs: 50, label: 'the broker host to be ready' });
      const lone = new BrokerClient({ socketPath });
      const child = lone.spawn(P.sleep, ['300'], { cwd: scratch, env: SAFE_ENV });
      child.on('error', () => {});
      await waitFor(async () => (child.pid ? true : null), { timeoutMs: 10_000, intervalMs: 20, label: 'the command to start' });
      assert.equal((await listProcessesOfUid(accounts.agent.uid)).length, 1, 'the command is running');
      hostProcess.kill('SIGKILL');
      await waitFor(async () => ((await listProcessesOfUid(accounts.agent.uid)).length === 0 ? true : null), { timeoutMs: 5000, intervalMs: 50, label: 'the kernel to kill the command of a dead broker' });
      lone.close();
    } finally {
      hostProcess.kill('SIGKILL');
      running.delete(hostProcess.pid);
      await reapAgentProcesses(accounts.agent.uid).catch(() => {});
    }
    ok('a command dies with the broker that started it, even when the broker is killed outright (pdeathsig)');
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // 2. The folders the supervisor prepares
  // -------------------------------------------------------------------------------------------------------------------------------
  await prepareFilesystem({ accounts, paths, gitIdentity: { name: 'Test Agent', email: 'agent@example.invalid' } });
  {
    const expected = [
      ['dataRoot', paths.dataRoot, 0, 0, 0o755], ['state', paths.state, accounts.hub.uid, accounts.hub.gid, 0o700], ['tmp', paths.tmp, accounts.hub.uid, accounts.hub.gid, 0o700],
      ['hub home', paths.hubHome, accounts.hub.uid, accounts.hub.gid, 0o700], ['workspaces', paths.workspaces, accounts.hub.uid, accounts.wsGid, 0o2750],
      ['agent home', paths.agentHome, accounts.agent.uid, accounts.agent.gid, 0o700], ['socket folder', paths.socketDir, 0, accounts.hub.gid, 0o750],
      ['hooks folder', paths.noHooks, 0, 0, 0o555],
    ];
    for (const [label, target, uid, gid, mode] of expected) {
      const have = await ownerAndMode(target);
      assert.deepEqual(have, { uid, gid, mode }, `${label}: owner ${have.uid}:${have.gid} mode ${have.mode.toString(8)}`);
    }
    assert.deepEqual(await fs.readdir(paths.noHooks), [], 'the hooks folder is empty');
    const config = await fs.readFile(path.join(paths.agentHome, '.gitconfig'), 'utf8');
    assert.match(config, /\[safe\]\n\tdirectory = \*/);
    assert.match(config, /name = Test Agent/);
    assert.match(config, /email = agent@example\.invalid/);
    assert.match(config, /defaultBranch = main/);
    assert.deepEqual(await ownerAndMode(path.join(paths.agentHome, '.gitconfig')), { uid: accounts.agent.uid, gid: accounts.agent.gid, mode: 0o644 });
    ok('prepareFilesystem: every folder has exactly the owner and mode of the design, the hooks folder is empty, the agent\'s Git settings are in its own home');
  }

  {
    // Repair: whatever state a previous run (or the agent) left, the next start puts it right.
    await fs.chmod(paths.state, 0o777);
    await fs.chown(paths.workspaces, accounts.agent.uid, accounts.agent.gid);
    await fs.chmod(paths.workspaces, 0o777);
    await fs.chmod(paths.noHooks, 0o777);
    await fs.chown(paths.agentHome, 0, 0);
    await prepareFilesystem({ accounts, paths, gitIdentity: { name: 'Test Agent', email: 'agent@example.invalid' } });
    assert.deepEqual(await ownerAndMode(paths.state), { uid: accounts.hub.uid, gid: accounts.hub.gid, mode: 0o700 });
    assert.deepEqual(await ownerAndMode(paths.workspaces), { uid: accounts.hub.uid, gid: accounts.wsGid, mode: 0o2750 });
    assert.deepEqual(await ownerAndMode(paths.noHooks), { uid: 0, gid: 0, mode: 0o555 });
    assert.deepEqual(await ownerAndMode(paths.agentHome), { uid: accounts.agent.uid, gid: accounts.agent.gid, mode: 0o700 });
    // The agent's home is the agent's: a link it left where the Git settings go must not make root change the owner of what it points to.
    const victim = path.join(base, 'victim');
    await fs.writeFile(victim, 'root-only\n', { mode: 0o600 });
    await fs.rm(path.join(paths.agentHome, '.gitconfig'), { force: true });
    await fs.symlink(victim, path.join(paths.agentHome, '.gitconfig'));
    await prepareFilesystem({ accounts, paths, gitIdentity: {} });
    assert.deepEqual(await ownerAndMode(victim), { uid: 0, gid: 0, mode: 0o600 }, 'the file the link pointed at is untouched');
    assert.equal(await fs.readFile(victim, 'utf8'), 'root-only\n');
    const settings = await fs.lstat(path.join(paths.agentHome, '.gitconfig'));
    assert.ok(settings.isFile() && !settings.isSymbolicLink(), 'a regular file replaced the link');
    assert.match(await fs.readFile(path.join(paths.agentHome, '.gitconfig'), 'utf8'), /name = ChatMCP Agent/, 'no identity given: the defaults');
    // An identity that could break out of the config file is replaced by the default.
    await prepareFilesystem({ accounts, paths, gitIdentity: { name: 'Eve"\n[core]\n\tsshCommand = evil', email: 'a<b>@c' } });
    const sanitized = await fs.readFile(path.join(paths.agentHome, '.gitconfig'), 'utf8');
    assert.ok(!/sshCommand|\[core\]/.test(sanitized), 'a name with a newline or a quote cannot add settings');
    assert.match(sanitized, /name = ChatMCP Agent/);
    assert.match(sanitized, /email = agent@chatmcp\.invalid/);
    ok('prepareFilesystem repairs wrong owners and modes, replaces a planted link without following it, and refuses to let an identity add Git settings');
  }

  {
    const target = path.join(base, 'hooks-cases');
    await fs.mkdir(target);
    const fresh = path.join(target, 'fresh', 'deeper');
    await ensureHooksDirectory(fresh);
    assert.deepEqual(await ownerAndMode(fresh), { uid: 0, gid: 0, mode: 0o555 }, 'a missing folder is made, with its parents');
    const loose = path.join(target, 'loose');
    await fs.mkdir(loose, { mode: 0o777 });
    await fs.chown(loose, accounts.agent.uid, accounts.agent.gid);
    await fs.chmod(loose, 0o777);
    await ensureHooksDirectory(loose);
    assert.deepEqual(await ownerAndMode(loose), { uid: 0, gid: 0, mode: 0o555 }, 'an empty folder somebody else owned is taken over');
    await ensureHooksDirectory(loose);
    const filled = path.join(target, 'filled');
    await fs.mkdir(filled, { mode: 0o777 });
    await fs.chown(filled, accounts.agent.uid, accounts.agent.gid);
    await fs.chmod(filled, 0o777);
    await fs.writeFile(path.join(filled, 'pre-commit'), '#!/bin/sh\n');
    await assert.rejects(ensureHooksDirectory(filled), /rỗng/);
    assert.deepEqual(await ownerAndMode(filled), { uid: accounts.agent.uid, gid: accounts.agent.gid, mode: 0o777 }, 'a folder with content is not touched');
    const plain = path.join(target, 'plain-file');
    await fs.writeFile(plain, 'x', { mode: 0o666 });
    await assert.rejects(ensureHooksDirectory(plain), /thư mục thường/);
    const secret = path.join(target, 'secret-dir');
    await fs.mkdir(secret, { mode: 0o700 });
    const link = path.join(target, 'link-to-secret');
    await fs.symlink(secret, link);
    await assert.rejects(ensureHooksDirectory(link), /thư mục thường/);
    assert.deepEqual(await ownerAndMode(secret), { uid: 0, gid: 0, mode: 0o700 }, 'a link is refused and what it points to keeps its owner and mode');
    ok('ensureHooksDirectory: creates, takes over an empty folder, and refuses (touching nothing) a folder with content, a file or a link');
  }

  {
    const probe = [
      'w() { if ( : > "$1/.probe" ) 2>/dev/null; then rm -f "$1/.probe"; echo "$2=writable"; else echo "$2=denied"; fi; }',
      'r() { if ls "$1" >/dev/null 2>&1; then echo "$2=listable"; else echo "$2=denied"; fi; }',
      'w "$STATE" state-w; r "$STATE" state-r', 'w "$WORKSPACES" workspaces-w; r "$WORKSPACES" workspaces-r', 'w "$NOHOOKS" nohooks-w',
      'w "$AGENTHOME" agenthome-w; r "$AGENTHOME" agenthome-r', 'w "$HUBHOME" hubhome-w; r "$HUBHOME" hubhome-r', 'w "$HUBTMP" tmp-w',
      'w "$SOCKETDIR" socketdir-w; r "$SOCKETDIR" socketdir-r', 'echo end=1',
    ].join('\n');
    const env = { STATE: paths.state, WORKSPACES: paths.workspaces, NOHOOKS: paths.noHooks, AGENTHOME: paths.agentHome, HUBHOME: paths.hubHome, HUBTMP: paths.tmp, SOCKETDIR: paths.socketDir };
    const view = async (account) => { const result = await sh(account, probe, { env }); const seen = keyValues(result.out); assert.equal(seen.end, '1', result.err); delete seen.end; return seen; };
    assert.deepEqual(await view(HUB), {
      'state-w': 'writable', 'state-r': 'listable', 'workspaces-w': 'writable', 'workspaces-r': 'listable', 'nohooks-w': 'denied', 'agenthome-w': 'denied', 'agenthome-r': 'denied',
      'hubhome-w': 'writable', 'hubhome-r': 'listable', 'tmp-w': 'writable', 'socketdir-w': 'denied', 'socketdir-r': 'listable',
    }, 'the hub: its own folders, the workspaces, the socket folder to walk in; not the hooks folder, not the agent\'s home');
    assert.deepEqual(await view(AGENT), {
      'state-w': 'denied', 'state-r': 'denied', 'workspaces-w': 'denied', 'workspaces-r': 'listable', 'nohooks-w': 'denied', 'agenthome-w': 'writable', 'agenthome-r': 'listable',
      'hubhome-w': 'denied', 'hubhome-r': 'denied', 'tmp-w': 'denied', 'socketdir-w': 'denied', 'socketdir-r': 'denied',
    }, 'the agent: its home, and a read-only look at the workspaces; nothing of the hub\'s');
    assert.deepEqual(await view(STRANGER), {
      'state-w': 'denied', 'state-r': 'denied', 'workspaces-w': 'denied', 'workspaces-r': 'denied', 'nohooks-w': 'denied', 'agenthome-w': 'denied', 'agenthome-r': 'denied',
      'hubhome-w': 'denied', 'hubhome-r': 'denied', 'tmp-w': 'denied', 'socketdir-w': 'denied', 'socketdir-r': 'denied',
    }, 'an account that belongs to neither: nothing');
    ok('who can do what: the hub has its state, home, tmp and the workspaces; the agent only its home and a read-only look at the workspaces; a stranger nothing');
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // 3. The real broker with the real launcher
  // -------------------------------------------------------------------------------------------------------------------------------
  const brokerOptions = (socketPath, extra = {}) => ({
    socketPath,
    agent: { uid: accounts.agent.uid, gid: accounts.agent.gid, groups: [accounts.agent.gid, accounts.wsGid], name: accounts.agent.name, home: accounts.agent.home },
    cwdRoots: [paths.workspaces], socketOwner: { uid: 0, gid: accounts.hub.gid }, socketMode: 0o660, umask: 0o002,
    limits: { dataBytes: 384 * 1048576, maxRunMs: 60_000, killGraceMs: 1000, lingerMs: 400 }, ...extra,
  });
  const broker = await startBrokerServer(brokerOptions(paths.socket));
  brokerForCleanup = broker;
  const client = new BrokerClient({ socketPath: paths.socket });
  const viaBroker = (file, args = [], { cwd = paths.workspaces, env = SAFE_ENV, timeout } = {}) => new Promise((resolve) => {
    const child = client.spawn(file, args, { cwd, env, timeout });
    let out = '';
    let err = '';
    let error = null;
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (caught) => { error = caught; });
    child.once('close', (code, signal) => setTimeout(() => resolve({ code, signal, out, err, error, reason: child.reason, reaped: child.reaped, child }), 50));
  });

  {
    const hello = await client.hello();
    assert.deepEqual(hello.agent, { uid: accounts.agent.uid, gid: accounts.agent.gid, name: accounts.agent.name, home: accounts.agent.home });
    const socket = await ownerAndMode(paths.socket);
    assert.deepEqual(socket, { uid: 0, gid: accounts.hub.gid, mode: 0o660 }, 'the socket belongs to root and the hub\'s group');
    const identity = await viaBroker(P.sh, ['-c', 'id -u; id -g; umask; echo "$HOME $USER $LOGNAME"']);
    assert.deepEqual(identity.out.trim().split('\n'), [String(accounts.agent.uid), String(accounts.agent.gid), '0002', `${accounts.agent.home} ${accounts.agent.name} ${accounts.agent.name}`]);
    ok('through the broker a command has the agent\'s uid and gid, umask 002 and the agent\'s HOME/USER/LOGNAME; the socket is root:hub-group 0660');
  }

  {
    const proof = await (async () => {
      const decoy = await startDecoy({ accounts, tools });
      running.add(decoy.pid);
      try { return await probeSeparation({ client, accounts, paths, decoyPid: decoy.pid, socketPath: paths.socket }); } finally { decoy.kill('SIGKILL'); }
    })();
    assert.deepEqual(proof.checks.map((check) => check.name), PROBE_NAMES);
    assert.deepEqual(proof.checks.filter((check) => !check.ok), [], 'every check of the start-up proof passes on the real thing');
    assert.equal(proof.ok, true);
    ok('the start-up proof (probeSeparation) passes all 12 checks against a real broker, a real launcher and a decoy hub process');
  }

  {
    // The hub makes a workspace folder the way the service does; the agent works in it through the broker; the hub keeps its rights.
    const workspace = path.join(paths.workspaces, 'w1');
    const made = await sh(HUB, `mkdir -m 2775 "${workspace}" && chmod 2775 "${workspace}"`, { cwd: paths.workspaces });
    assert.equal(made.code, 0, made.err);
    const wrote = await viaBroker(P.sh, ['-c', 'mkdir -p src/deep && echo from-agent > src/a.txt && echo more > src/deep/b.txt && stat -c "%u:%g %a" . src src/a.txt'], { cwd: workspace });
    assert.equal(wrote.code, 0, wrote.err);
    assert.deepEqual(wrote.out.trim().split('\n'), [`${accounts.hub.uid}:${accounts.wsGid} 2775`, `${accounts.agent.uid}:${accounts.wsGid} 2775`, `${accounts.agent.uid}:${accounts.wsGid} 664`], 'files made by the agent belong to the shared group and the hub can write them');
    const hubSide = await sh(HUB, `echo hub-added >> "${workspace}/src/a.txt" && : > "${workspace}/src/hub.txt" && cat "${workspace}/src/deep/b.txt" && rm "${workspace}/src/a.txt" && echo removed`, { cwd: paths.workspaces });
    assert.equal(hubSide.code, 0, hubSide.err);
    assert.match(hubSide.out, /more\nremoved/);
    const hubFile = await viaBroker(P.sh, ['-c', 'echo agent-adds >> src/hub.txt && echo shared-ok'], { cwd: workspace });
    assert.equal(hubFile.out.trim(), 'shared-ok', 'and the agent can change what the hub put there');
    const top = await viaBroker(P.sh, ['-c', '( : > ../should-not-exist ) 2>/dev/null && echo created || echo refused'], { cwd: workspace });
    assert.equal(top.out.trim(), 'refused', 'the agent cannot create anything next to a workspace (the workspaces folder is read-only for it)');
    ok('workspaces: the hub makes a folder, the agent works in it, each can change what the other made, and the agent cannot write above it');

    // The tree the agent leaves without any permission for itself: the hub's own rm fails, and so does the agent's find -delete.
    const hostile = await viaBroker(P.sh, ['-c', 'mkdir -p d/e/h && echo x > d/e/f && echo y > d/g && echo z > d/e/h/i && chmod 000 d/e/h d/e && chmod 500 d && echo built'], { cwd: workspace });
    assert.equal(hostile.out.trim(), 'built', hostile.err);
    const hubRm = await sh(HUB, `${P.rm} -rf "${workspace}"`, { cwd: paths.workspaces });
    assert.notEqual(hubRm.code, 0, 'precondition: the hub alone cannot remove the tree');
    const findOnly = await viaBroker(P.find, [workspace, '-mindepth', '1', '-delete'], { cwd: paths.workspaces });
    assert.notEqual(findOnly.code, 0, 'precondition: neither can the agent\'s find -delete');
    // What WorkspaceService#removeFolder does: the agent gives itself the rights back, empties the folder, the hub removes the rest.
    const chmodAgent = await viaBroker(P.chmod, ['-R', 'u+rwX', '--', workspace], { cwd: paths.workspaces });
    assert.notEqual(chmodAgent.code, 0, 'chmod reports the folder the hub owns; that is expected');
    assert.equal((await viaBroker(P.find, [workspace, '-mindepth', '1', '-delete'], { cwd: paths.workspaces })).code, 0);
    const hubRm2 = await sh(HUB, `${P.rm} -rf "${workspace}"`, { cwd: paths.workspaces });
    assert.equal(hubRm2.code, 0, hubRm2.err);
    await assert.rejects(fs.lstat(workspace));
    ok('a tree the agent made with mode 000/500 is removed by: agent chmod -R u+rwX, agent find -delete, hub rm (each alone fails)');
  }

  {
    const decoy = await startDecoy({ accounts, tools });
    running.add(decoy.pid);
    const left = await viaBroker(P.sh, ['-c', `(${P.sleep} 300 &) ; (${P.sleep} 300 &) ; echo started`]);
    assert.equal(left.out.trim(), 'started');
    assert.ok(left.reaped >= 2, `the broker reports what it reaped (${left.reaped})`);
    await noAgentProcesses('after a command that left background jobs');
    const slow = await viaBroker(P.sleep, ['300'], { timeout: 1000 });
    assert.equal(slow.reason, 'timeout');
    assert.equal(slow.signal, 'SIGKILL');
    await noAgentProcesses('after a timeout');
    const second = new BrokerClient({ socketPath: paths.socket });
    const long = second.spawn(P.sleep, ['300'], { cwd: paths.workspaces, env: SAFE_ENV });
    long.stdout.resume(); long.stderr.resume();
    long.on('error', () => {}); // the loss of the connection is what this test causes on purpose
    const begun = Date.now();
    while (!long.pid && Date.now() - begun < 3000) await sleep(20);
    assert.ok(long.pid, 'the long command started');
    assert.deepEqual((await listProcessesOfUid(accounts.agent.uid)).includes(long.pid), true, 'and it runs as the agent');
    second.close();
    const until = Date.now() + 5000;
    while ((await listProcessesOfUid(accounts.agent.uid)).length && Date.now() < until) await sleep(50);
    await noAgentProcesses('after the hub\'s connection went away');
    await assertAlive(decoy.pid, 'the hub\'s decoy');
    decoy.kill('SIGKILL');
    ok('with the real reaper: background jobs of a finished command, a timed-out command and a command whose Hub connection vanished are all gone; the hub\'s process lives');
  }

  if (!nodeForAgent) {
    notApplicable('socket reachability from the three accounts: node cannot be run by the throw-away accounts here');
  } else {
    const connectScript = "const s=require('net').connect(process.argv[1]);s.on('connect',()=>{console.log('CONNECTED');s.destroy()});s.on('error',(e)=>{console.log('ERR '+e.code)})";
    const attempt = async (account) => (await runAs(account, process.execPath, ['-e', connectScript, paths.socket], { cwd: '/' })).out.trim();
    assert.equal(await attempt(HUB), 'CONNECTED', 'the hub can open the socket');
    assert.equal(await attempt(AGENT), 'ERR EACCES', 'the agent cannot');
    assert.equal(await attempt(STRANGER), 'ERR EACCES', 'nor can a stranger');
    // A stranger that is not even allowed to look in the folder cannot learn that the socket exists, and cannot connect by guessing.
    ok('only the hub\'s account can open the broker socket (the agent and a stranger get EACCES)');
  }

  await client.close();
  await broker.close();
  brokerForCleanup = null;
  await assert.rejects(fs.lstat(paths.socket), 'closing the broker removes its socket');
  await noAgentProcesses('after closing the broker');

  // -------------------------------------------------------------------------------------------------------------------------------
  // 4. The proof must FAIL for each way of getting the separation wrong
  // -------------------------------------------------------------------------------------------------------------------------------
  const wrongSocketDir = path.join(base, 'wrong');
  await fs.mkdir(wrongSocketDir, { mode: 0o750 });
  await fs.chown(wrongSocketDir, 0, accounts.hub.gid);
  let wrongCount = 0;
  /** Starts a broker that is set up WRONG in one way, runs the proof against it and returns the names of the checks that failed. */
  async function failedChecks(patch) {
    wrongCount += 1;
    const socketPath = path.join(wrongSocketDir, `b${wrongCount}.sock`);
    const wrongBroker = await startBrokerServer({ ...brokerOptions(socketPath), ...patch });
    const wrongClient = new BrokerClient({ socketPath });
    const decoy = await startDecoy({ accounts, tools });
    running.add(decoy.pid);
    try {
      await wrongClient.hello();
      const proof = await probeSeparation({ client: wrongClient, accounts, paths, decoyPid: decoy.pid, socketPath });
      assert.deepEqual(proof.checks.map((check) => check.name), PROBE_NAMES);
      const failed = proof.checks.filter((check) => !check.ok).map((check) => check.name);
      assert.equal(proof.ok, failed.length === 0, 'the proof as a whole fails exactly when one of its checks does');
      return failed;
    } finally {
      wrongClient.close();
      try { decoy.kill('SIGKILL'); } catch { /* gone */ }
      await wrongBroker.close();
    }
  }
  /** The launcher of the real broker with one protection left out. */
  // `ambient`: the program keeps one capability in its effective set (an ambient capability survives the change of uid) while the bounding
  // set is empty, so only the effective set tells it from a correct launcher. It needs the capability to be inheritable first.
  const weakLauncher = ({ noNewPrivs = true, dropCapabilities = true, groups = null, ambient = false } = {}) => ({ file, args, cwd, env, agent, limits }) => spawn(tools.prlimit, [
    `--nproc=${limits.nproc}`, `--nofile=${limits.nofile}`, `--fsize=${limits.fsizeBytes}`, '--core=0', '--',
    ...(ambient ? [tools.setpriv, '--inh-caps=+chown', '--'] : []), tools.setpriv,
    `--reuid=${agent.uid}`, `--regid=${agent.gid}`, `--groups=${(groups ?? agent.groups).join(',')}`,
    ...(ambient ? ['--ambient-caps=+chown', '--bounding-set=-all'] : dropCapabilities ? ['--inh-caps=-all', '--bounding-set=-all'] : []), ...(noNewPrivs ? ['--no-new-privs'] : []), '--pdeathsig=KILL',
    '--', tools.env, '-i', '--', ...Object.entries(env).map(([name, value]) => `${name}=${value}`), file, ...args,
  ], { cwd, env: { PATH: '/usr/bin:/bin' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  assert.deepEqual(await failedChecks({}), [], 'control: the correct set-up fails nothing');
  const hubAsAgent = { uid: accounts.hub.uid, gid: accounts.hub.gid, groups: [accounts.hub.gid, accounts.wsGid], name: accounts.agent.name, home: accounts.agent.home };
  assert.deepEqual(
    await failedChecks({ agent: hubAsAgent }),
    ['agent-uid', 'agent-groups', 'hub-environ-unreadable', 'hub-not-signalable', 'state-unreadable', 'workspaces-root-readonly', 'broker-socket-unreachable'],
    'the agent running as the hub: the proof sees the wrong uid and group, and the agent can read the hub\'s environment, signal it, list the state, write the workspaces and open the socket',
  );
  assert.deepEqual(await failedChecks({ launch: weakLauncher({ noNewPrivs: false }) }), ['no-new-privs'], 'a launcher without no_new_privs');
  assert.deepEqual(await failedChecks({ launch: weakLauncher({ dropCapabilities: false }) }), ['no-capabilities'], 'a launcher that keeps the bounding set');
  assert.deepEqual(
    await failedChecks({ launch: weakLauncher({ groups: [accounts.agent.gid, accounts.wsGid, accounts.hub.gid] }) }),
    ['agent-groups', 'broker-socket-unreachable'],
    'the hub\'s group among the agent\'s groups: it can open the socket',
  );
  assert.deepEqual(
    await failedChecks({ launch: weakLauncher({ groups: [accounts.agent.gid, accounts.wsGid, 0] }) }),
    ['agent-groups'],
    'root\'s group among the agent\'s groups',
  );
  assert.deepEqual(await failedChecks({ launch: weakLauncher({ ambient: true }) }), ['no-capabilities'], 'a program that keeps an ambient capability (effective set not empty, bounding set empty)');
  assert.deepEqual(await failedChecks({ agent: { ...AGENT, home: '/not/the/agent/home' } }), ['agent-home'], 'a broker that gives the agent another HOME than the one the supervisor expects');
  const before = process.umask(0o022);
  try { assert.deepEqual(await failedChecks({ umask: null }), ['umask-group-writable'], 'a broker that does not set umask 002'); } finally { process.umask(before); }
  await noAgentProcesses('after the wrong set-ups');

  // The probe itself can fail to run: it must say so, and nothing else may excuse it. A client that replays what the real probe printed
  // with a different ending stands in for a probe that was cut short.
  {
    const replayBroker = await startBrokerServer(brokerOptions(path.join(wrongSocketDir, 'replay.sock')));
    const real = new BrokerClient({ socketPath: path.join(wrongSocketDir, 'replay.sock') });
    const decoy = await startDecoy({ accounts, tools });
    running.add(decoy.pid);
    let printed = '';
    const recording = { spawn: (...args) => { const child = real.spawn(...args); child.stdout.on('data', (chunk) => { printed += chunk; }); return child; } };
    try {
      await real.hello();
      const first = await probeSeparation({ client: recording, accounts, paths, decoyPid: decoy.pid, socketPath: path.join(wrongSocketDir, 'replay.sock') });
      assert.equal(first.ok, true, 'the control: the probe passes against the real broker');
      assert.match(printed, /^END=1$/m);
      const replay = (out, code, extra = {}) => ({ spawn: () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        setImmediate(() => { child.stdout.end(out); child.stderr.end(''); setImmediate(() => child.emit(extra.error ? 'error' : 'close', ...(extra.error ? [extra.error] : [code, null]))); });
        return child;
      } });
      const run = (client) => probeSeparation({ client, accounts, paths, decoyPid: decoy.pid, socketPath: path.join(wrongSocketDir, 'replay.sock') });
      const exitedBadly = await run(replay(printed, 3));
      assert.deepEqual([exitedBadly.ok, exitedBadly.checks.filter((check) => !check.ok).map((check) => check.name)], [false, ['probe-ran']], 'a probe that printed everything but exited with an error');
      const cutShort = await run(replay(printed.replace(/^END=1$/m, ''), 0));
      assert.deepEqual([cutShort.ok, cutShort.checks.filter((check) => !check.ok).map((check) => check.name)], [false, ['probe-ran']], 'a probe that never reached its last line');
      const broken = await run(replay('', 0, { error: new Error('the broker went away') }));
      assert.deepEqual([broken.ok, broken.checks.map((check) => [check.name, check.ok])], [false, [['probe-ran', false]]], 'a probe that could not be run at all');
    } finally {
      real.close();
      try { decoy.kill('SIGKILL'); } catch { /* gone */ }
      await replayBroker.close();
    }
  }
  ok('the proof fails for exactly the right checks when: the agent is the hub, no_new_privs or the capability drop is missing (bounding set or effective set), a hub group or root\'s group is kept, the agent\'s HOME differs, umask is 022, or the probe itself did not run to its end');

  // -------------------------------------------------------------------------------------------------------------------------------
  // 5. The supervisor as a process
  // -------------------------------------------------------------------------------------------------------------------------------
  const selfTest = async (patch = {}, { asHub = false, dir: reuse = null } = {}) => {
    const dir = reuse ?? await fs.mkdtemp(path.join(base, 'self-'));
    await fs.chmod(dir, 0o755);
    const env = {
      ...SAFE_ENV, ...ENV, CHATMCP_DATA_ROOT: path.join(dir, 'data'), CHATMCP_EXEC_BROKER: path.join(dir, 'run', 'broker.sock'), CHATMCP_AGENT_HOME: path.join(dir, 'agent-home'),
      CHATMCP_NO_HOOKS_DIR: path.join(dir, 'no-hooks'), CHATMCP_HUB_HOME: path.join(dir, 'data', 'home'), ...patch,
    };
    const command = asHub
      ? [tools.setpriv, [`--reuid=${accounts.hub.uid}`, `--regid=${accounts.hub.gid}`, '--clear-groups', '--', process.execPath, SUPERVISOR, '--self-test']]
      : [process.execPath, [SUPERVISOR, '--self-test']];
    const result = await capture(command[0], command[1], { env, cwd: dir, timeoutMs: 60_000 });
    const line = result.out.split('\n').filter((text) => text.startsWith('{')).pop();
    return { dir, env, code: result.code, report: line ? JSON.parse(line) : null, out: result.out, err: result.err };
  };

  {
    const run = await selfTest();
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    assert.equal(run.report.ok, true);
    assert.equal(run.report.reason, null);
    assert.deepEqual(run.report.checks.map((check) => check.name), PROBE_NAMES);
    assert.ok(run.report.checks.every((check) => check.ok));
    const paths2 = pathsFromEnv(run.env);
    assert.deepEqual(await ownerAndMode(paths2.workspaces), { uid: accounts.hub.uid, gid: accounts.wsGid, mode: 0o2750 }, 'the self-test prepared the folders');
    assert.deepEqual(await ownerAndMode(paths2.noHooks), { uid: 0, gid: 0, mode: 0o555 });
    await assert.rejects(fs.lstat(paths2.socket), 'and removed its socket');
    await noAgentProcesses('after the self-test');
    // A second run on the same folders: still passes, and puts back what was changed in between.
    await fs.chmod(paths2.state, 0o755);
    await fs.chmod(paths2.workspaces, 0o777);
    const again = await selfTest({}, { dir: run.dir });
    assert.equal(again.code, 0, `${again.out}\n${again.err}`);
    assert.equal(again.report.ok, true);
    assert.deepEqual(await ownerAndMode(paths2.state), { uid: accounts.hub.uid, gid: accounts.hub.gid, mode: 0o700 }, 'the second start repaired the state folder');
    assert.deepEqual(await ownerAndMode(paths2.workspaces), { uid: accounts.hub.uid, gid: accounts.wsGid, mode: 0o2750 });
    ok('supervisor.mjs --self-test as a process: exit 0, one JSON line with the 12 passing checks, folders prepared, socket removed, nothing left running, a second start repairs what changed');
  }

  {
    const sameUid = await selfTest({ CHATMCP_AGENT_UID: String(ids.hub) });
    assert.equal(sameUid.code, 1);
    assert.equal(sameUid.report.ok, false);
    assert.equal(sameUid.report.reason, 'accounts');
    assert.ok(sameUid.report.problems.some((problem) => /khác nhau/.test(problem)));
    const rootAgent = await selfTest({ CHATMCP_AGENT_UID: '0' });
    assert.equal(rootAgent.code, 1);
    assert.equal(rootAgent.report.reason, 'accounts');
    const wsIsAgentGroup = await selfTest({ CHATMCP_WS_GID: String(ids.agent) });
    assert.equal(wsIsAgentGroup.report.reason, 'accounts');
    const crowded = await fs.mkdtemp(path.join(base, 'crowded-'));
    await fs.writeFile(path.join(crowded, 'pre-commit'), '#!/bin/sh\n');
    const hooksNotEmpty = await selfTest({ CHATMCP_NO_HOOKS_DIR: crowded });
    assert.equal(hooksNotEmpty.code, 1);
    assert.equal(hooksNotEmpty.report.reason, 'filesystem');
    assert.match(hooksNotEmpty.report.detail, /rỗng/);
    assert.deepEqual(await fs.readdir(crowded), ['pre-commit'], 'and the folder with content was left alone');
    for (const refused of [sameUid, rootAgent, wsIsAgentGroup, hooksNotEmpty]) {
      await assert.rejects(fs.lstat(pathsFromEnv(refused.env).socket), 'a refused configuration never opened the socket');
    }
    if (!nodeForAgent) {
      notApplicable('--self-test run by a non-root account: node cannot be run by the throw-away accounts here');
    } else {
      const nonRoot = await selfTest({}, { asHub: true });
      assert.equal(nonRoot.code, 1);
      assert.deepEqual(nonRoot.report, { ok: false, reason: 'not-root' });
      await assert.rejects(fs.lstat(pathsFromEnv(nonRoot.env).dataRoot), 'and it created nothing');
    }
    ok('--self-test refuses (exit 1, a reason, nothing created or changed) for: one account for hub and agent, a root agent, a shared primary group, a hooks folder with content, a non-root caller');
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // 6. The hooks folder
  // -------------------------------------------------------------------------------------------------------------------------------
  if (!P.git) {
    notApplicable('hooks folder with real Git: git is not installed');
  } else {
    const planted = await sh(AGENT, `( : > "${paths.noHooks}/pre-commit" ) 2>/dev/null && echo planted || echo refused`, { cwd: scratch });
    assert.equal(planted.out.trim(), 'refused', 'the agent cannot put a hook into the hooks folder');
    const repo = path.join(scratch, 'repo');
    const env = { HOME: paths.agentHome, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const prepare = await sh(AGENT, [
      `${P.git} init -q -b main "${repo}"`, `cd "${repo}"`, `printf '#!/bin/sh\\ntouch "${repo}/hook-ran"\\n' > .git/hooks/pre-commit`, 'chmod +x .git/hooks/pre-commit', 'echo a > a.txt', `${P.git} add a.txt`, 'echo ready',
    ].join(' && '), { cwd: scratch, env });
    assert.equal(prepare.out.trim(), 'ready', prepare.err);
    const guarded = await sh(AGENT, `cd "${repo}" && ${P.git} -c core.hooksPath="${paths.noHooks}" commit -q -m one && echo committed`, { cwd: scratch, env });
    assert.equal(guarded.out.trim(), 'committed', guarded.err);
    await assert.rejects(fs.lstat(path.join(repo, 'hook-ran')), 'with core.hooksPath on the empty folder the hook of the repository did not run');
    const control = await sh(AGENT, `cd "${repo}" && ${P.git} commit -q --allow-empty -m two && echo committed`, { cwd: scratch, env });
    assert.equal(control.out.trim(), 'committed', control.err);
    assert.ok((await fs.lstat(path.join(repo, 'hook-ran'))).isFile(), 'control: without the setting the very same hook does run');
    ok('core.hooksPath on the empty root-owned folder stops a repository hook (with a control that the hook runs otherwise); the agent cannot fill the folder');
  }

  await noAgentProcesses('at the end');
  console.log(`PASS (${checks} checks${notes.length ? `; ${notes.length} not applicable here: ${notes.join('; ')}` : ''})`);
} finally {
  try { await brokerForCleanup?.close(); } catch { /* best effort */ }
  try { await reapAgentProcesses(accounts.agent.uid); } catch { /* best effort */ }
  try { await reapAgentProcesses(accounts.hub.uid); } catch { /* best effort */ }
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});
}
