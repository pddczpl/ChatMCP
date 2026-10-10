// Behavioural tests for lib/exec-broker.mjs: the wire protocol between the Hub and the command broker, and every guarantee the broker
// makes about the commands it runs - one at a time, bounded in time, output, arguments and environment, stopped when the Hub's
// connection goes away, and followed by a clean-up of everything the agent's account still has running.
//
// The real launcher switches to another account and needs root; verify-exec-separation.mjs proves that part. Here the broker runs with
// a stand-in launcher that starts the program as the current user and a stand-in reaper that kills what the test started, so all the
// rest is tested without root, on every Unix. Windows has neither Unix sockets nor /proc: only the pure checks run there and the
// suite then reports itself as skipped (never as passed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  BrokerClient, DEFAULT_LIMITS, PROTOCOL_VERSION, launchAsAgent, listProcessesOfUid, locateLauncherTools, reapAgentProcesses, startBrokerServer,
} from '../lib/exec-broker.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(() => { console.error('FAIL: the exec-broker suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

const AGENT = Object.freeze({ uid: 4242, gid: 4243, groups: Object.freeze([4243, 4244]), name: 'agent', home: '/home/agent-test' });
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const UNREAL_PID = 2_147_483_000; // no operating system hands out a pid this large

async function waitFor(condition, { timeoutMs = 6000, label = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await sleep(15);
  }
}

/** True while the process exists and is not a zombie (a killed orphan stays a zombie until init collects it; kill(pid, 0) still succeeds). */
async function isAlive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^State:\s+[ZX]/m.test(await fs.readFile(`/proc/${pid}/status`, 'utf8')); } catch {
    return !(await fs.access('/proc/self').then(() => true, () => false)); // /proc exists but the entry vanished: gone
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Pure checks: no socket, no /proc, no uid switching, so they run on Windows too.
// ---------------------------------------------------------------------------------------------------------------------------------
{
  assert.equal(PROTOCOL_VERSION, 1);
  assert.ok(Object.isFrozen(DEFAULT_LIMITS), 'the default limits cannot be edited by accident');
  assert.equal(DEFAULT_LIMITS.maxQueue, 8);
  assert.equal(DEFAULT_LIMITS.dataBytes, 0, 'no per-process memory limit unless the supervisor asks for one');
  assert.ok(DEFAULT_LIMITS.maxOutputBytes <= DEFAULT_LIMITS.maxOutputBytesHard);
  assert.ok(DEFAULT_LIMITS.maxRunMs >= 1000 && DEFAULT_LIMITS.maxRunMs <= 3_600_000);
  assert.ok(DEFAULT_LIMITS.nproc > 0 && DEFAULT_LIMITS.nofile > 0 && DEFAULT_LIMITS.fsizeBytes > 0);
  ok('default limits are frozen and bounded (queue, output, run time, processes, files, file size)');

  assert.throws(() => new BrokerClient({ socketPath: 'broker.sock' }), TypeError, 'a relative socket path is refused');
  assert.throws(() => new BrokerClient({}), TypeError);
  assert.throws(() => new BrokerClient(), TypeError);
  ok('the client refuses a socket path that is not absolute');

  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-broker-pure-'));
  try {
    const goodAgent = { ...AGENT, groups: [...AGENT.groups] };
    const absolute = path.join(base, 'b.sock');
    const mustThrow = (options, label) => assert.rejects(startBrokerServer(options), (error) => { assert.ok(error instanceof TypeError, `${label}: ${error.message}`); return true; }, label);
    await mustThrow({ socketPath: 'relative.sock', agent: goodAgent, cwdRoots: [base] }, 'relative socket path');
    await mustThrow({ agent: goodAgent, cwdRoots: [base] }, 'no socket path');
    await mustThrow({ socketPath: absolute, agent: { ...goodAgent, uid: 0 }, cwdRoots: [base] }, 'the agent must not be root');
    await mustThrow({ socketPath: absolute, agent: { ...goodAgent, uid: -5 }, cwdRoots: [base] }, 'negative uid');
    await mustThrow({ socketPath: absolute, agent: { ...goodAgent, uid: 1.5 }, cwdRoots: [base] }, 'fractional uid');
    await mustThrow({ socketPath: absolute, agent: { ...goodAgent, groups: undefined }, cwdRoots: [base] }, 'groups missing');
    await mustThrow({ socketPath: absolute, agent: { ...goodAgent, name: '' }, cwdRoots: [base] }, 'name missing');
    await mustThrow({ socketPath: absolute, agent: { ...goodAgent, home: '' }, cwdRoots: [base] }, 'home missing');
    await mustThrow({ socketPath: absolute, agent: goodAgent, cwdRoots: [] }, 'no working directory area');
    await mustThrow({ socketPath: absolute, agent: goodAgent }, 'working directory areas missing');
    await mustThrow({ socketPath: absolute, cwdRoots: [base] }, 'agent missing');
    await assert.rejects(fs.lstat(absolute), 'nothing was created for a refused configuration');
    ok('the server refuses to start for a relative path, a root or malformed agent, or without a working-directory area');
  } finally { await fs.rm(base, { recursive: true, force: true }); }

  assert.throws(() => launchAsAgent({ file: '/bin/true', args: [], cwd: os.tmpdir(), env: {}, agent: AGENT, limits: DEFAULT_LIMITS, tools: { prlimit: null, setpriv: '/x', env: '/y' } }), (error) => error.code === 'launcher_missing');
  assert.throws(() => launchAsAgent({ file: '/bin/true', args: [], cwd: os.tmpdir(), env: {}, agent: AGENT, limits: DEFAULT_LIMITS, tools: { prlimit: '/x', setpriv: null, env: '/y' } }), (error) => error.code === 'launcher_missing');
  assert.throws(() => launchAsAgent({ file: '/bin/true', args: [], cwd: os.tmpdir(), env: {}, agent: AGENT, limits: DEFAULT_LIMITS, tools: { prlimit: '/x', setpriv: '/x', env: null } }), (error) => error.code === 'launcher_missing');
  assert.throws(() => launchAsAgent({ file: '/bin/true', args: [], cwd: os.tmpdir(), env: {}, agent: AGENT, limits: DEFAULT_LIMITS }), (error) => error.code === 'launcher_missing');
  ok('the real launcher refuses to start anything when prlimit, setpriv or env is missing (it never falls back to running as the Hub)');

  const proc = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-fake-proc-'));
  try {
    const entry = async (name, text) => { if (text === null) { await fs.mkdir(path.join(proc, name)); return; } await fs.mkdir(path.join(proc, name), { recursive: true }); await fs.writeFile(path.join(proc, name, 'status'), text); };
    const status = (state, ids) => `Name:\tx\nState:\t${state}\nPid:\t1\nUid:\t${ids.join('\t')}\nGid:\t0\t0\t0\t0\n`;
    await entry('100', status('S (sleeping)', [5, 5, 5, 5]));
    await entry('101', status('R (running)', [9, 5, 9, 9])); // effective uid is another one but the real uid is 5
    await entry('102', status('S (sleeping)', [9, 9, 5, 9])); // saved uid 5
    await entry('103', status('S (sleeping)', [9, 9, 9, 5])); // filesystem uid 5
    await entry('104', status('Z (zombie)', [5, 5, 5, 5])); // already dead
    await entry('105', status('X (dead)', [5, 5, 5, 5]));
    await entry('106', status('S (sleeping)', [9, 9, 9, 9])); // somebody else
    await entry('107', null); // the process ended while we looked: no status file
    await entry('0', status('S (sleeping)', [5, 5, 5, 5])); // not a pid
    await entry('abc', status('S (sleeping)', [5, 5, 5, 5]));
    await entry('1x', status('S (sleeping)', [5, 5, 5, 5]));
    await entry('-3', status('S (sleeping)', [5, 5, 5, 5]));
    await entry('108', 'garbage without the fields\n');
    assert.deepEqual((await listProcessesOfUid(5, { procRoot: proc })).sort((a, b) => a - b), [100, 101, 102, 103], 'real, effective, saved and filesystem uid all count; zombies, dead, other users and non-pids do not');
    assert.deepEqual((await listProcessesOfUid(9, { procRoot: proc })).sort((a, b) => a - b), [101, 102, 103, 106]);
    assert.deepEqual(await listProcessesOfUid(77, { procRoot: proc }), []);
    assert.deepEqual(await listProcessesOfUid(5, { procRoot: path.join(proc, 'does-not-exist') }), [], 'no /proc: nothing to list');
    ok('the process scan counts a process under any of the four uids, ignores zombies, dead entries and names that are not pids');

    for (const bad of [0, -1, 1.5, Number.NaN, '4242', null, undefined, {}, [], Infinity]) {
      await assert.rejects(reapAgentProcesses(bad, { procRoot: proc, timeoutMs: 50 }), RangeError, `reap must refuse uid ${String(bad)}`);
    }
    if (typeof process.getuid === 'function') await assert.rejects(reapAgentProcesses(process.getuid(), { procRoot: proc, timeoutMs: 50 }), RangeError, 'reap must refuse the broker\'s own uid');
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-empty-proc-'));
    try { assert.equal(await reapAgentProcesses(5, { procRoot: empty, timeoutMs: 50 }), 0, 'nothing to kill is a success'); } finally { await fs.rm(empty, { recursive: true, force: true }); }
    ok('the reaper refuses uid 0, the broker\'s own uid and anything that is not a positive integer');

    const ghost = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-ghost-proc-'));
    try {
      await fs.mkdir(path.join(ghost, String(UNREAL_PID)));
      await fs.writeFile(path.join(ghost, String(UNREAL_PID), 'status'), status('S (sleeping)', [5, 5, 5, 5]));
      const started = Date.now();
      await assert.rejects(reapAgentProcesses(5, { procRoot: ghost, timeoutMs: 200 }), /survived SIGKILL/, 'a process that cannot be killed is reported, never ignored');
      assert.ok(Date.now() - started < 3000, 'and the reaper gives up within its time budget');
    } finally { await fs.rm(ghost, { recursive: true, force: true }); }
    ok('a process that survives SIGKILL makes the reaper fail within its time budget');
  } finally { await fs.rm(proc, { recursive: true, force: true }); }

  // A broker that is not there: the child reports it the way spawn() reports a missing program and the runners already handle.
  const missing = path.join(os.tmpdir(), `chatmcp-no-such-broker-${process.pid}`, 'b.sock');
  const lonely = new BrokerClient({ socketPath: missing, connectTimeoutMs: 1500 });
  const child = lonely.spawn('/bin/true', [], { cwd: os.tmpdir(), env: {} });
  const seen = await new Promise((resolve) => { let error = null; child.on('error', (e) => { error = e; }); child.once('close', () => resolve(error)); });
  assert.equal(seen?.code, 'EBROKERDOWN', 'a missing broker is reported as EBROKERDOWN');
  assert.equal(child.brokered, true);
  assert.equal(child.kill(), false, 'there is nothing left to kill');
  await assert.rejects(lonely.hello(), (error) => error.code === 'EBROKERDOWN');
  ok('with no broker, spawn() ends with EBROKERDOWN and hello() rejects with the same code');
}

if (process.platform === 'win32') {
  console.log(`PASS: ${checks} checks of the pure parts of the exec broker`);
  console.log('CHATMCP_TEST_SKIP: the command broker uses Unix sockets and /proc; only the pure checks run on Windows');
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// With a stand-in launcher: start the program as the current user, in its own process group (like the real launcher).
// ---------------------------------------------------------------------------------------------------------------------------------
const spawned = new Set();
process.once('exit', () => { for (const pid of spawned) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } } });
const launch = ({ file, args, cwd, env }) => {
  const child = spawn(file, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  if (child.pid) spawned.add(child.pid);
  return child;
};
let reapCalls = 0;
const reap = async () => {
  reapCalls += 1;
  let killed = 0;
  for (const pid of spawned) { try { process.kill(-pid, 'SIGKILL'); killed += 1; } catch { /* the group is gone */ } }
  spawned.clear();
  return killed;
};

async function withBroker(options, body) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-broker-')));
  const workspace = path.join(base, 'ws');
  await fs.mkdir(workspace);
  const socketPath = path.join(base, 'b.sock');
  await fs.symlink(process.execPath, path.join(base, 'node')); // a node whose path the broker's file pattern accepts on every machine
  const server = await startBrokerServer({ socketPath, agent: { ...AGENT, groups: [...AGENT.groups] }, cwdRoots: [workspace], launch, reap, limits: { killGraceMs: 400, lingerMs: 300, ...(options.limits ?? {}) }, ...(options.server ?? {}) });
  const clients = [];
  const connect = () => { const client = new BrokerClient({ socketPath }); clients.push(client); return client; };
  try { await body({ server, client: connect(), connect, workspace, socketPath, base, node: path.join(base, 'node') }); } finally {
    for (const client of clients) client.close();
    await server.close();
    await fs.rm(base, { recursive: true, force: true });
  }
}

/** Runs one command through a BrokerClient and collects everything it did. */
function run(client, file, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = client.spawn(file, args, { cwd: options.cwd, env: options.env ?? { PATH: process.env.PATH }, timeout: options.timeout, maxOutputBytes: options.maxOutputBytes });
    const out = [];
    const err = [];
    let error = null;
    let spawnedEvent = false;
    child.stdout.on('data', (chunk) => { out.push(chunk); options.onOut?.(chunk, child); });
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('spawn', () => { spawnedEvent = true; });
    child.on('error', (e) => { error = e; });
    // 'close' says the command is over; what it wrote may still be on its way through the streams, so wait for them to end (a stream the
    // test left paused is not waited for beyond a moment).
    const ended = (stream) => (stream.readableEnded ? Promise.resolve() : new Promise((done) => { stream.once('end', done); setTimeout(done, 5000).unref(); }));
    child.once('close', async (code, signal) => {
      await Promise.all([ended(child.stdout), ended(child.stderr)]);
      resolve({ code, signal, out: Buffer.concat(out), err: Buffer.concat(err), reason: child.reason, reaped: child.reaped, error, child, spawnedEvent });
    });
    options.onChild?.(child);
  });
}
const text = (buffer) => buffer.toString('utf8');

/** A client that speaks the wire protocol directly, so the tests can send what the real client never would. */
function connectRaw(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    const queue = [];
    const waiters = [];
    let buffer = '';
    let closed = false;
    const deliver = () => {
      for (const waiter of [...waiters]) {
        const at = queue.findIndex(waiter.match);
        if (at >= 0) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(queue.splice(at, 1)[0]); }
      }
    };
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line) queue.push(JSON.parse(line));
      }
      deliver();
    });
    const closedPromise = new Promise((done) => socket.once('close', () => { closed = true; for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error('the connection was closed')); } done(); }));
    socket.on('error', () => {});
    socket.once('error', reject);
    socket.once('connect', () => resolve({
      socket,
      send: (message) => socket.write(`${JSON.stringify(message)}\n`),
      sendRaw: (data) => socket.write(data),
      next: (match = () => true, timeoutMs = 6000) => new Promise((res, rej) => {
        const waiter = { match, resolve: res, reject: rej, timer: setTimeout(() => { const at = waiters.indexOf(waiter); if (at >= 0) waiters.splice(at, 1); rej(new Error('timed out waiting for a broker message')); }, timeoutMs) };
        waiters.push(waiter);
        deliver();
      }),
      pending: () => queue.length,
      closed: () => closed,
      closedPromise,
      destroy: () => socket.destroy(),
    }));
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
await withBroker({}, async ({ client, server, workspace, node }) => {
  const hello = await client.hello();
  assert.equal(hello.ok, true);
  assert.equal(hello.v, PROTOCOL_VERSION);
  assert.deepEqual(hello.agent, { uid: AGENT.uid, gid: AGENT.gid, name: AGENT.name, home: AGENT.home }, 'the broker says who the agent is, and nothing else about the accounts');
  assert.equal(hello.limits.maxQueue, DEFAULT_LIMITS.maxQueue);
  assert.equal(Object.hasOwn(hello, 'groups'), false);
  ok('hello: protocol version, the agent account (uid, gid, name, home) and the queue and run-time limits');

  const first = await run(client, '/bin/sh', ['-c', 'echo to-out; echo to-err 1>&2; exit 3'], { cwd: workspace });
  assert.deepEqual([first.code, first.signal, text(first.out), text(first.err), first.reason], [3, null, 'to-out\n', 'to-err\n', null]);
  assert.equal(first.spawnedEvent, true);
  assert.ok(Number.isInteger(first.child.pid) && first.child.pid > 0, 'the child knows the pid the broker reported');
  assert.equal(first.child.brokered, true, 'runners can tell that the processes belong to another account');
  assert.equal(first.child.kill(), false, 'a finished command cannot be killed again');
  assert.equal(first.child.killTree(), false);
  ok('run: exit code, stdout and stderr arrive separately, the child has a pid and says it is brokered');

  const stdin = await run(client, '/bin/sh', ['-c', 'cat; echo after-cat'], { cwd: workspace });
  assert.equal(text(stdin.out), 'after-cat\n', 'the command has no stdin (it reads end-of-file at once instead of waiting for the Hub)');
  ok('a command that reads its standard input gets end-of-file immediately');

  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const binary = await run(client, node, ['-e', 'process.stdout.write(Buffer.from(Array.from({length:256},(_,i)=>i))); process.stderr.write(Buffer.from(Array.from({length:256},(_,i)=>255-i)))'], { cwd: workspace });
  assert.equal(binary.code, 0);
  assert.ok(binary.out.equals(all), 'every byte value survives on stdout');
  assert.ok(binary.err.equals(Buffer.from([...all].reverse())), 'and on stderr');
  ok('output is binary-safe: all 256 byte values arrive unchanged on both streams');

  const envRun = await run(client, '/usr/bin/env', [], { cwd: workspace, env: { HOME: '/evil', USER: 'root', LOGNAME: 'root', FOO: 'bar baz', EMPTY: '' } });
  const seenEnv = Object.fromEntries(text(envRun.out).split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.deepEqual(seenEnv, { HOME: AGENT.home, USER: AGENT.name, LOGNAME: AGENT.name, FOO: 'bar baz', EMPTY: '', PATH: SAFE_PATH }, 'identity variables describe the real account, PATH defaults to a fixed one, nothing else is added');
  const keepPath = await run(client, '/usr/bin/env', [], { cwd: workspace, env: { PATH: '/opt/custom/bin' } });
  assert.match(text(keepPath.out), /^PATH=\/opt\/custom\/bin$/m, 'a PATH the caller sets is kept');
  ok('environment: HOME/USER/LOGNAME are forced to the agent, PATH defaults to a fixed value, nothing from the broker leaks in');

  const sub = path.join(workspace, 'a', 'b');
  await fs.mkdir(sub, { recursive: true });
  const cwdRun = await run(client, '/bin/pwd', [], { cwd: sub });
  assert.equal(text(cwdRun.out).trim(), sub, 'a directory below the workspace area is accepted and used');
  assert.equal(server.stats().running, false);
  ok('cwd: a directory below an allowed area is used as the working directory');
});

// ---------------------------------------------------------------------------------------------------------------------------------
await withBroker({}, async ({ socketPath, workspace, base }) => {
  const raw = await connectRaw(socketPath);
  let counter = 100;
  const nextId = () => ++counter;
  const expectError = async (message, code, label) => {
    const id = Object.hasOwn(message, 'id') ? message.id : null;
    raw.send(message);
    const reply = await raw.next((m) => m.t === 'error' && (m.id === id || m.id === null), 4000);
    assert.equal(reply.code, code, `${label}: ${JSON.stringify(reply).slice(0, 200)}`);
    assert.ok(String(reply.message).length <= 500, 'error messages are bounded');
    return reply;
  };
  const request = (extra = {}) => ({ t: 'run', id: nextId(), file: '/bin/sh', args: ['-c', 'true'], cwd: workspace, env: {}, ...extra });

  raw.sendRaw('{this is not json\n');
  const notJson = await raw.next((m) => m.t === 'error');
  assert.deepEqual([notJson.id, notJson.code], [null, 'bad_request']);
  raw.sendRaw('\n   \n');
  raw.send({ t: 'hello' });
  assert.equal((await raw.next((m) => m.t === 'hello')).ok, true, 'blank lines are ignored and the connection stays usable');
  raw.sendRaw('null\n42\n"text"\ntrue\n');
  raw.send({ t: 'hello' });
  assert.equal((await raw.next((m) => m.t === 'hello')).ok, true, 'JSON that is not an object is ignored');
  assert.equal(raw.pending(), 0, 'and gets no answer');
  raw.sendRaw('[1,2]\n');
  const array = await raw.next((m) => m.t === 'error');
  assert.deepEqual([array.id, array.code], [null, 'bad_request'], 'an array has no id: it is a request without one');
  ok('protocol: broken JSON and requests without an id get bad_request; blank lines and JSON scalars are ignored; the connection survives');

  for (const id of [undefined, 0, -1, 1.5, '1', null, 2 ** 60, true, {}, []]) {
    const message = request();
    if (id === undefined) delete message.id; else message.id = id;
    await expectError(message, 'bad_request', `id ${JSON.stringify(id)}`);
  }
  ok('every request needs a positive safe integer id');

  raw.send({ t: 'unknown-type', id: nextId() });
  raw.send({ t: 'hello' });
  await raw.next((m) => m.t === 'hello');
  assert.equal(raw.pending(), 0, 'an unknown message type gets no answer at all');
  ok('an unknown message type is ignored');

  const notExecutable = path.join(workspace, 'plain.txt');
  await fs.writeFile(notExecutable, 'data', { mode: 0o644 });
  const files = [
    [['bin/sh', 'relative path'], 'bad_request'], [['/bin/../bin/sh', 'dot dot'], 'bad_request'], [['/bin/s h', 'space'], 'bad_request'], [['/bin/sh;id', 'semicolon'], 'bad_request'],
    [['/bin/sh=1', 'equals sign (would be an environment assignment for env -i)'], 'bad_request'], [['/bin/sh\n', 'newline'], 'bad_request'], [['', 'empty'], 'bad_request'],
    [[`/bin/${'a'.repeat(450)}`, 'too long'], 'bad_request'], [['/bin/$(id)', 'command substitution'], 'bad_request'], [['/bin/`id`', 'backticks'], 'bad_request'],
    [['/bin/sh\0', 'NUL'], 'bad_request'], [['/bin/sh|cat', 'pipe'], 'bad_request'], [['/bin/sh&', 'ampersand'], 'bad_request'], [['/bin/*', 'glob'], 'bad_request'],
    [['/definitely/not/here', 'missing program'], 'ENOENT'], [[notExecutable, 'a file without the execute bit'], 'ENOENT'],
  ];
  for (const [[file, label], code] of files) await expectError(request({ file }), code, `file: ${label}`);
  for (const file of [42, null, undefined, {}, [], ['/bin/sh']]) await expectError(request({ file }), 'bad_request', `file ${JSON.stringify(file)}`);
  ok(`file: ${files.length + 6} unacceptable program paths are refused (relative, "..", space, "=", shell syntax, NUL, glob, too long, wrong type, missing, not executable)`);

  const bigArg = 'x'.repeat(120_001);
  const argCases = [
    [{ args: 'sh -c true' }, 'bad_request', 'args as a string'], [{ args: { 0: 'a' } }, 'bad_request', 'args as an object'], [{ args: null }, 'bad_request', 'args null'],
    [{ args: Array.from({ length: 2001 }, () => 'x') }, 'bad_request', '2001 arguments'], [{ args: [1] }, 'bad_request', 'a number'], [{ args: [null] }, 'bad_request', 'null'],
    [{ args: [['nested']] }, 'bad_request', 'a nested array'], [{ args: ['ok', 'a\0b'] }, 'bad_request', 'NUL in an argument'],
    [{ args: [bigArg] }, 'E2BIG', 'one argument of 120001 bytes'], [{ args: Array.from({ length: 8 }, () => 'y'.repeat(120_000)) }, 'E2BIG', 'arguments above 900000 bytes in total'],
    [{ args: ['é'.repeat(60_001)] }, 'E2BIG', 'a multi-byte argument measured in bytes, not characters'],
  ];
  for (const [extra, code, label] of argCases) await expectError(request(extra), code, `args: ${label}`);
  ok(`args: ${argCases.length} unacceptable argument lists are refused (not an array, too many, wrong types, NUL, one too long in bytes, too long in total)`);

  const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`V${i}`, '1']));
  const heavy = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`H${i}`, 'z'.repeat(16_000)]));
  const envCases = [
    [{ env: [] }, 'bad_request', 'env as an array'], [{ env: 'A=1' }, 'bad_request', 'env as a string'], [{ env: 7 }, 'bad_request', 'env as a number'], [{ env: tooMany }, 'bad_request', '201 variables'],
    [{ env: { '1X': 'a' } }, 'bad_request', 'name starting with a digit'], [{ env: { 'A B': 'a' } }, 'bad_request', 'space in the name'], [{ env: { 'A=B': 'a' } }, 'bad_request', '"=" in the name'],
    [{ env: { '': 'a' } }, 'bad_request', 'empty name'], [{ env: { ['A'.repeat(65)]: 'a' } }, 'bad_request', 'name longer than 64'], [{ env: { 'A-B': 'a' } }, 'bad_request', 'dash in the name'],
    [{ env: { A: 5 } }, 'bad_request', 'number as a value'], [{ env: { A: null } }, 'bad_request', 'null as a value'], [{ env: { A: 'x\0y' } }, 'bad_request', 'NUL in a value'],
    [{ env: { A: 'q'.repeat(16_385) } }, 'bad_request', 'a value above 16384'], [{ env: heavy }, 'E2BIG', 'an environment above 131072 bytes'],
  ];
  for (const [extra, code, label] of envCases) await expectError(request(extra), code, `env: ${label}`);
  ok(`env: ${envCases.length} unacceptable environments are refused (wrong type, too many, bad names, NUL, too large)`);

  const outside = path.join(base, 'outside');
  const sibling = `${workspace}-evil`;
  await fs.mkdir(outside);
  await fs.mkdir(sibling);
  await fs.symlink(outside, path.join(workspace, 'escape'));
  await fs.symlink('..', path.join(workspace, 'up'));
  await fs.writeFile(path.join(workspace, 'afile'), 'x');
  const cwdCases = [
    [undefined, 'bad_request', 'no cwd'], ['relative/dir', 'bad_request', 'relative cwd'], [`${workspace}\0`, 'bad_request', 'NUL in cwd'], [42, 'bad_request', 'cwd as a number'],
    [path.join(workspace, 'missing'), 'ENOENT', 'a directory that does not exist'], ['/', 'cwd_denied', 'the file system root'], [base, 'cwd_denied', 'the parent of the area'],
    [os.tmpdir(), 'cwd_denied', 'the system temporary folder'], [path.join(workspace, '..'), 'cwd_denied', '.. out of the area'], [outside, 'cwd_denied', 'a directory beside the area'],
    [path.join(workspace, 'escape'), 'cwd_denied', 'a symbolic link inside the area that points outside'], [path.join(workspace, 'up'), 'cwd_denied', 'a link to the parent'],
    [path.join(workspace, 'up', 'outside'), 'cwd_denied', 'through a link to the parent'], [sibling, 'cwd_denied', 'a sibling whose name starts with the area\'s name'],
  ];
  for (const [cwd, code, label] of cwdCases) await expectError(request({ cwd }), code, `cwd: ${label}`);
  ok(`cwd: ${cwdCases.length} working directories outside the allowed area or malformed are refused (realpath-based: links, "..", prefix look-alikes)`);

  // A request that passes every check still has to run: the connection is intact after all the hostile input.
  const id = nextId();
  raw.send(request({ id, args: ['-c', 'echo still-fine'] }));
  const started = await raw.next((m) => m.t === 'started' && m.id === id);
  assert.ok(Number.isInteger(started.pid));
  const data = await raw.next((m) => m.t === 'data' && m.id === id);
  assert.equal(Buffer.from(data.b64, 'base64').toString(), 'still-fine\n');
  assert.equal(data.fd, 1);
  const exit = await raw.next((m) => m.t === 'exit' && m.id === id);
  assert.deepEqual([exit.code, exit.signal, exit.reason, exit.stuck], [0, null, null, false]);
  ok('after all that, a valid request on the same connection still runs: started, data (base64, fd 1), exit');

  // The same id twice while the first still runs.
  const dup = nextId();
  raw.send(request({ id: dup, args: ['-c', 'sleep 1.2'] }));
  await raw.next((m) => m.t === 'started' && m.id === dup);
  raw.send(request({ id: dup }));
  const duplicate = await raw.next((m) => m.t === 'error' && m.id === dup);
  assert.equal(duplicate.code, 'bad_request');
  assert.match(duplicate.message, /Duplicate/);
  const finished = await raw.next((m) => m.t === 'exit' && m.id === dup, 5000);
  assert.equal(finished.code, 0, 'the first request was not disturbed');
  ok('a request id that is already in use is refused without disturbing the running command');
});

// ---------------------------------------------------------------------------------------------------------------------------------
{
  const original = process.umask(0o027);
  try {
    await withBroker({ server: { umask: 0o002 } }, async ({ client, workspace, node }) => {
      assert.equal(process.umask(), 0o002, 'the broker applies the umask the supervisor asked for (so that files are group-writable)');
      const made = await run(client, node, ['-e', "const fs=require('fs');fs.writeFileSync('made.txt','x');console.log((fs.statSync('made.txt').mode&0o777).toString(8))"], { cwd: workspace });
      assert.equal(text(made.out).trim(), '664', 'a command inherits the umask');
    });
    assert.equal(process.umask(), 0o027, 'closing the broker puts back the umask the process had before');
  } finally { process.umask(original); }
  ok('umask: commands inherit the broker\'s umask (group-writable files) and closing the broker restores the previous one');
}

// ---------------------------------------------------------------------------------------------------------------------------------
await withBroker({}, async ({ client, workspace }) => {
  const started = Date.now();
  const timeout = await run(client, '/bin/sh', ['-c', 'echo before; sleep 30'], { cwd: workspace, timeout: 1 });
  const elapsed = Date.now() - started;
  assert.equal(timeout.reason, 'timeout');
  assert.equal(timeout.signal, 'SIGKILL');
  assert.equal(text(timeout.out), 'before\n', 'what the command wrote before the timeout is delivered');
  assert.ok(elapsed >= 900 && elapsed < 6000, `a requested time limit below one second is raised to one second (took ${elapsed} ms)`);
  ok('timeout: a command that outlives its limit is killed with reason "timeout" (limits below 1 s are raised to 1 s)');
});
await withBroker({ limits: { maxRunMs: 1500 } }, async ({ client, workspace }) => {
  for (const timeout of [undefined, 60_000, 'abc', 0]) {
    const started = Date.now();
    const result = await run(client, '/bin/sh', ['-c', 'sleep 30'], { cwd: workspace, timeout });
    const elapsed = Date.now() - started;
    assert.equal(result.reason, 'timeout', `timeout ${String(timeout)}`);
    assert.ok(elapsed >= 1200 && elapsed < 6000, `timeout ${String(timeout)} ends at the server's own maximum (took ${elapsed} ms)`);
  }
  for (const timeout of [-5, 500]) {
    const started = Date.now();
    const result = await run(client, '/bin/sh', ['-c', 'sleep 30'], { cwd: workspace, timeout });
    const elapsed = Date.now() - started;
    assert.equal(result.reason, 'timeout');
    assert.ok(elapsed >= 900 && elapsed < 1450 + 1500, `timeout ${String(timeout)} is raised to the one-second floor (took ${elapsed} ms)`);
  }
  ok('timeout: an absent, huge or non-numeric limit means the server\'s maximum and a tiny or negative one is raised to one second');
});

await withBroker({ limits: { maxOutputBytes: 4096, maxOutputBytesHard: 8192 } }, async ({ client, workspace }) => {
  const bytes = (n) => ['-c', `head -c ${n} /dev/zero`];
  const probe = async (n, maxOutputBytes, label, limit) => {
    const result = await run(client, '/bin/sh', bytes(n), { cwd: workspace, maxOutputBytes });
    if (n <= limit) {
      assert.equal(result.reason, null, `${label}: ${n} bytes are within the limit of ${limit}`);
      assert.equal(result.out.length, n, `${label}: all ${n} bytes are delivered`);
    } else {
      assert.equal(result.reason, 'output-limit', `${label}: ${n} bytes exceed the limit of ${limit}`);
      assert.ok(result.out.length <= limit, `${label}: no more than ${limit} bytes are delivered (got ${result.out.length})`);
    }
  };
  await probe(2048, 2048, 'a limit of 2048', 2048);
  await probe(2049, 2048, 'a limit of 2048', 2048);
  await probe(1024, 1, 'a request below the floor', 1024);
  await probe(1025, 1, 'a request below the floor', 1024);
  await probe(4096, undefined, 'no request means the server default', 4096);
  await probe(4097, undefined, 'no request means the server default', 4096);
  await probe(8192, 10 * 1024 ** 3, 'a huge request is cut to the hard limit', 8192);
  await probe(8193, 10 * 1024 ** 3, 'a huge request is cut to the hard limit', 8192);
  await probe(5000, -1, 'a negative request is read as "not given" or the floor, never as unlimited', 1024);
  const both = await run(client, '/bin/sh', ['-c', 'head -c 3000 /dev/zero; head -c 3000 /dev/zero 1>&2'], { cwd: workspace });
  assert.equal(both.reason, 'output-limit', 'stdout and stderr count together');
  assert.ok(both.out.length + both.err.length <= 4096);
  const quiet = await run(client, '/bin/echo', ['after the limit hits, the next command is unaffected'], { cwd: workspace });
  assert.equal(quiet.reason, null);
  ok('output cap: the limit counts stdout and stderr together, is floored at 1 KiB, has a default, is cut to the hard maximum, and a command under it is untouched');
});

// ---------------------------------------------------------------------------------------------------------------------------------
await withBroker({}, async ({ client, connect, server, workspace, socketPath }) => {
  const term = await run(client, '/bin/sh', ['-c', 'trap "echo caught-term; exit 7" TERM; echo ready; sleep 30 & wait'], {
    cwd: workspace, onOut: (chunk, child) => { if (text(chunk).includes('ready') && !child.killed) child.kill(); },
  });
  assert.equal(term.reason, 'signal');
  assert.equal(term.code, 7, 'kill() sends SIGTERM by default, which the command can handle');
  assert.match(text(term.out), /caught-term/);
  ok('signal: kill() sends SIGTERM to the whole process group by default (a command can clean up) and reports reason "signal"');

  const stubborn = Date.now();
  const hard = await run(client, '/bin/sh', ['-c', 'trap "" TERM; echo ready; sleep 30'], {
    cwd: workspace, onOut: (chunk, child) => { if (text(chunk).includes('ready') && !child.killed) child.kill('SIGTERM'); },
  });
  assert.equal(hard.reason, 'signal');
  assert.equal(hard.signal, 'SIGKILL', 'a command that ignores SIGTERM is given the grace period and then dropped');
  assert.ok(Date.now() - stubborn < 6000);
  assert.ok(hard.reaped >= 1, `the reaper had to kill what was left (reaped ${hard.reaped})`);
  ok('signal: a command that ignores SIGTERM is abandoned after the grace period and what it left is reaped');

  const killed = await run(client, '/bin/sh', ['-c', 'trap "" TERM; echo ready; sleep 30'], {
    cwd: workspace, onOut: (chunk, child) => { if (text(chunk).includes('ready') && !child.killed) child.killTree(); },
  });
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(killed.reason, 'signal');
  ok('signal: killTree() is SIGKILL');

  // Unknown signal names are turned into SIGTERM; only four names are ever delivered.
  const raw = await connectRaw(socketPath);
  for (const [name, expected] of [['SIGUSR1', 7], ['SIGSTOP', 7], ['SIGSEGV', 7], ['sigterm', 7], [undefined, 7], [15, 7], ['SIGHUP', 9]]) {
    const id = 500 + Math.floor(Math.random() * 1e6);
    raw.send({ t: 'run', id, file: '/bin/sh', args: ['-c', `trap "exit 7" TERM; trap "exit 9" HUP; echo ready; sleep 30 & wait`], cwd: workspace, env: {} });
    await raw.next((m) => m.t === 'data' && m.id === id);
    raw.send({ t: 'signal', id, signal: name });
    const exit = await raw.next((m) => m.t === 'exit' && m.id === id, 6000);
    assert.equal(exit.code, expected, `signal ${String(name)} is delivered as ${expected === 9 ? 'SIGHUP' : 'SIGTERM'}`);
    assert.equal(exit.reason, 'signal');
  }
  raw.destroy();
  ok('signal: only SIGTERM, SIGKILL, SIGINT and SIGHUP exist; any other name (SIGSTOP, SIGUSR1, a number) becomes SIGTERM');

  // Signals for runs that do not exist (or belong to another connection) are ignored.
  const other = await connectRaw(socketPath);
  const mine = connect();
  const victim = run(mine, '/bin/sh', ['-c', 'sleep 1.5; echo survived'], { cwd: workspace });
  await waitFor(() => server.stats().running, { label: 'the victim to start' });
  other.send({ t: 'signal', id: 1, signal: 'SIGKILL' });
  other.send({ t: 'signal', id: 999999, signal: 'SIGKILL' });
  other.send({ t: 'signal', id: 'x', signal: 'SIGKILL' });
  const result = await victim;
  assert.equal(text(result.out), 'survived\n', 'another connection cannot signal this connection\'s command');
  other.destroy();
  ok('signal: a connection can only signal its own runs; unknown ids are ignored');
});

// ---------------------------------------------------------------------------------------------------------------------------------
await withBroker({ limits: { maxQueue: 2 } }, async ({ client, connect, server, workspace }) => {
  const log = path.join(workspace, 'log');
  const mark = (name, extra = '') => ['-c', `echo ${name}-start >> log; ${extra} echo ${name}-end >> log`];
  const a = run(client, '/bin/sh', mark('A', 'sleep 1;'), { cwd: workspace });
  await waitFor(() => server.stats().running, { label: 'A to start' });
  const second = connect(); // another connection: commands of all connections share one line
  const b = run(second, '/bin/sh', mark('B'), { cwd: workspace });
  await waitFor(() => server.stats().queued === 1, { label: 'B to queue' });
  const c = run(client, '/bin/sh', mark('C'), { cwd: workspace });
  await waitFor(() => server.stats().queued === 2, { label: 'C to queue' });
  const d = await run(client, '/bin/sh', mark('D'), { cwd: workspace });
  assert.equal(d.error?.code, 'busy', 'a third waiting command is refused at once');
  assert.equal(d.code, null);
  assert.equal(server.stats().queued, 2, 'a refused command does not occupy the queue');
  const results = await Promise.all([a, b, c]);
  assert.deepEqual(results.map((r) => r.code), [0, 0, 0]);
  assert.equal(await fs.readFile(log, 'utf8'), 'A-start\nA-end\nB-start\nB-end\nC-start\nC-end\n', 'commands of every connection run strictly one after the other, in order');
  ok('queue: one command at a time across all connections, first in first out, and a full queue answers "busy" immediately');

  await fs.rm(log);
  const long = run(client, '/bin/sh', mark('L', 'sleep 1.2;'), { cwd: workspace });
  await waitFor(() => server.stats().running, { label: 'L to start' });
  let cancelled;
  const waiting = run(second, '/bin/sh', mark('W'), { cwd: workspace, onChild: (child) => { cancelled = child; } });
  await waitFor(() => server.stats().queued === 1, { label: 'W to queue' });
  assert.equal(cancelled.kill(), true);
  const gone = await waiting;
  assert.equal(gone.reason, 'cancelled');
  assert.equal(gone.spawnedEvent, false, 'a cancelled command never started');
  assert.equal(server.stats().queued, 0, 'and left the queue');
  await long;
  await sleep(150);
  assert.equal(await fs.readFile(log, 'utf8'), 'L-start\nL-end\n', 'the cancelled command did not run, before or after');
  ok('queue: cancelling a waiting command removes it without ever starting it');
});

// ---------------------------------------------------------------------------------------------------------------------------------
await withBroker({}, async ({ client, connect, server, workspace }) => {
  const doomed = run(client, '/bin/sh', ['-c', 'echo up; sleep 2; echo late > late.txt'], { cwd: workspace });
  const queued = run(client, '/bin/sh', ['-c', 'echo queued > queued.txt'], { cwd: workspace });
  await waitFor(() => server.stats().queued === 1 && server.stats().running, { label: 'one running, one waiting' });
  const began = Date.now();
  client.close(); // the Hub's connection goes away
  const [first, second] = await Promise.all([doomed, queued]);
  assert.equal(first.error?.code, 'EBROKERLOST', 'the Hub side learns that the connection is gone');
  assert.equal(second.error?.code, 'EBROKERLOST');
  await waitFor(() => !server.stats().running && server.stats().connections === 0 && server.stats().queued === 0, { label: 'the broker to clean up' });
  await sleep(Math.max(0, 2600 - (Date.now() - began)));
  await assert.rejects(fs.access(path.join(workspace, 'late.txt')), 'the running command was killed with the connection');
  await assert.rejects(fs.access(path.join(workspace, 'queued.txt')), 'the waiting command was dropped with the connection');
  const fresh = await run(connect(), '/bin/echo', ['next connection works'], { cwd: workspace });
  assert.equal(text(fresh.out), 'next connection works\n');
  ok('disconnect: a closed connection kills its running command, drops its waiting ones, and the broker serves the next connection');
});

await withBroker({}, async ({ connect, server, workspace }) => {
  const client = connect();
  let pid = 0;
  const victim = run(client, '/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { cwd: workspace, onOut: (chunk) => { pid = Number(text(chunk).trim()) || pid; } });
  await waitFor(() => pid > 0, { label: 'the background pid' });
  client.close();
  await victim;
  await waitFor(() => !server.stats().running, { label: 'clean-up' });
  assert.equal(await isAlive(pid), false, 'the background process of a disconnected command is gone');
  ok('disconnect: processes the command had started in the background are reaped too');
});

// ---------------------------------------------------------------------------------------------------------------------------------
await withBroker({ limits: { lingerMs: 300 } }, async ({ socketPath, workspace }) => {
  const raw = await connectRaw(socketPath);
  const id = 700;
  const before = reapCalls;
  raw.send({ t: 'run', id, file: '/bin/sh', args: ['-c', 'sleep 30 & echo bg=$!'], cwd: workspace, env: {} });
  const line = await raw.next((m) => m.t === 'data' && m.id === id);
  const pid = Number(/bg=(\d+)/.exec(Buffer.from(line.b64, 'base64').toString())[1]);
  const started = Date.now();
  const exit = await raw.next((m) => m.t === 'exit' && m.id === id, 6000);
  assert.ok(Date.now() - started < 3000, 'a background process that holds the pipes open delays the end by the linger time only');
  assert.equal(exit.lingering, true, 'the end is reported as "lingering"');
  assert.equal(exit.code, 0);
  assert.ok(exit.reaped >= 1, 'the reaper stopped the background process before "exit" was sent');
  assert.equal(await isAlive(pid), false, 'it is already gone when the Hub hears about the end');
  assert.ok(reapCalls > before, 'the reaper ran');
  raw.destroy();
  ok('linger: a background process holding the pipes open delays the end by the linger time and is reaped before "exit" is reported');
});

// ---------------------------------------------------------------------------------------------------------------------------------
{
  let failures = 1;
  const flaky = async () => { reapCalls += 1; if (failures > 0) { failures = failures === Infinity ? failures : failures - 1; throw new Error('2 process(es) of uid 4242 survived SIGKILL'); } return reap(); };
  await withBroker({ server: { reap: flaky } }, async ({ server, socketPath, workspace }) => {
    const raw = await connectRaw(socketPath);
    const go = async (id, args = ['-c', 'echo go']) => { raw.send({ t: 'run', id, file: '/bin/sh', args, cwd: workspace, env: {} }); return raw.next((m) => (m.t === 'exit' || m.t === 'error') && m.id === id, 8000); };

    const first = await go(1);
    assert.equal(first.t, 'exit');
    assert.equal(first.stuck, true, 'when the clean-up fails the exit message says so');
    assert.match(String(server.stats().stuck), /survived/);
    const second = await go(2);
    assert.equal(second.t, 'exit', 'the next command first tries to clean up; when that works it runs normally');
    assert.equal(second.stuck, false);
    assert.equal(server.stats().stuck, null);
    ok('stuck: a failed clean-up is reported, and the next command retries it before running');

    failures = Infinity;
    const third = await go(3);
    assert.equal(third.t, 'exit');
    assert.equal(third.stuck, true);
    const refused = await go(4);
    assert.equal(refused.t, 'error');
    assert.equal(refused.code, 'agent_processes_stuck', 'while processes of the agent account cannot be stopped no command runs');
    assert.ok(server.stats().stuck);
    assert.equal(server.stats().running, false);
    const refusedAgain = await go(5);
    assert.equal(refusedAgain.code, 'agent_processes_stuck');
    failures = 0;
    const recovered = await go(6);
    assert.equal(recovered.t, 'exit', 'as soon as the clean-up works again, commands run again');
    assert.equal(recovered.stuck, false);
    raw.destroy();
    ok('stuck: commands are refused (agent_processes_stuck) for as long as the clean-up fails, and resume when it succeeds');
  });
}

await withBroker({}, async ({ client, workspace }) => {
  const before = reapCalls;
  await run(client, '/bin/sh', ['-c', 'exit 0'], { cwd: workspace });
  await run(client, '/bin/sh', ['-c', 'exit 9'], { cwd: workspace });
  await run(client, '/bin/sh', ['-c', 'sleep 30'], { cwd: workspace, timeout: 1 });
  await run(client, '/bin/sh', ['-c', 'head -c 100000 /dev/zero'], { cwd: workspace, maxOutputBytes: 1024 });
  const notAProgram = path.join(workspace, 'broken-interpreter');
  await fs.writeFile(notAProgram, '#!/definitely/not/an/interpreter\n', { mode: 0o755 });
  const failed = await run(client, notAProgram, [], { cwd: workspace });
  assert.ok(failed.error, `a program that cannot be executed is reported as an error (${failed.error?.code})`);
  assert.equal(failed.code, null);
  assert.ok(reapCalls - before >= 5, `the clean-up ran after every command, whatever its outcome (${reapCalls - before} runs for 5 commands)`);
  const after = await run(client, '/bin/echo', ['alive'], { cwd: workspace });
  assert.equal(text(after.out), 'alive\n');
  ok('clean-up: the reaper runs after every command - success, failure, timeout, output limit and a program that cannot be executed');
});

// ---------------------------------------------------------------------------------------------------------------------------------
await withBroker({}, async ({ client, server, workspace, node }) => {
  // 24 MiB through a reader that is stalled, then resumed: nothing is lost, nothing is reordered, nothing piles up, and the command is
  // held back meanwhile.
  const total = 24 * 1024 * 1024;
  const producer = ['-e', `
    const crypto = require('crypto'); const hash = crypto.createHash('sha256'); let left = ${total}; let seed = 1;
    function chunk(n) { const b = Buffer.allocUnsafe(n); for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; b[i] = seed >> 16; } return b; }
    (function pump() { while (left > 0) { const b = chunk(Math.min(65536, left)); left -= b.length; hash.update(b); if (!process.stdout.write(b)) { process.stdout.once('drain', pump); return; } } process.stderr.write('sha256=' + hash.digest('hex')); })();
  `];
  let child;
  const finished = run(client, node, producer, { cwd: workspace, onChild: (c) => { child = c; c.stdout.pause(); } });
  await sleep(900);
  assert.equal(server.stats().running, true, 'with nobody reading, the command is held back and cannot finish');
  const buffered = child.stdout.readableLength + child.stdout.writableLength;
  assert.ok(buffered > 0, 'some output is waiting for the reader');
  assert.ok(buffered <= 2 * 1024 * 1024 + 256 * 1024, `and no more than a couple of MiB (${buffered} bytes) pile up on the Hub side while it waits`);
  await sleep(300);
  assert.ok(child.stdout.readableLength + child.stdout.writableLength <= buffered + 256 * 1024, 'the buffer does not keep growing');
  child.stdout.resume();
  const result = await finished;
  assert.equal(result.code, 0);
  assert.equal(result.reason, null);
  const reported = /sha256=([0-9a-f]{64})/.exec(text(result.err))?.[1];
  assert.ok(reported, 'the command reported the hash of what it wrote');
  assert.equal(result.out.length, total, 'every byte arrived');
  assert.equal(crypto.createHash('sha256').update(result.out).digest('hex'), reported, 'in the right order and unchanged');
  ok('back-pressure: 24 MiB through a reader that stalls and then resumes arrives complete and in order; the command is held back and the buffer stays bounded');

  // A reader that never comes back, and a command that is killed: the shared connection must not stay paused.
  let stuckChild;
  const never = run(client, node, ['-e', 'const b=Buffer.alloc(65536,97); (function pump(){ while (process.stdout.write(b)); process.stdout.once("drain", pump); })()'], {
    cwd: workspace, onChild: (c) => { stuckChild = c; c.stdout.pause(); },
  });
  await sleep(900);
  assert.equal(server.stats().running, true);
  const began = Date.now();
  stuckChild.kill();
  const ended = await never;
  assert.equal(ended.reason, 'signal');
  assert.ok(Date.now() - began < 8000, 'a command whose reader stopped can still be killed');
  const next = await run(client, '/bin/echo', ['connection is free again'], { cwd: workspace });
  assert.equal(text(next.out), 'connection is free again\n', 'and the connection it shared is not left paused for the next command');
  ok('back-pressure: killing a command whose reader stopped reading does not leave the shared connection paused');
});

// ---------------------------------------------------------------------------------------------------------------------------------
await withBroker({}, async ({ client, server, workspace, socketPath, base }) => {
  const mode = (await fs.stat(socketPath)).mode & 0o777;
  assert.equal(mode, 0o660, 'the socket is group-readable and writable only (root:hub in the container)');
  assert.ok((await fs.lstat(socketPath)).isSocket());

  // One reconnect: the broker goes away, the command dies with an error the runners understand, and the same client works with a new broker.
  let pid = 0;
  const running = run(client, '/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { cwd: workspace, onOut: (chunk) => { pid = Number(text(chunk).trim()) || pid; } });
  await waitFor(() => pid > 0, { label: 'the command to start' });
  await server.close();
  const lost = await running;
  assert.equal(lost.error?.code, 'EBROKERLOST');
  assert.equal(await isAlive(pid), false, 'closing the broker kills the command and what it started');
  await assert.rejects(client.hello(), (error) => ['EBROKERDOWN', 'EBROKERLOST'].includes(error.code), 'a closed broker does not answer');
  await assert.rejects(fs.lstat(socketPath), 'the socket file is removed');
  const revived = await startBrokerServer({ socketPath, agent: { ...AGENT, groups: [...AGENT.groups] }, cwdRoots: [workspace], launch, reap });
  try {
    const again = await run(client, '/bin/echo', ['reconnected'], { cwd: workspace });
    assert.equal(text(again.out), 'reconnected\n', 'the same client reconnects by itself');
  } finally { await revived.close(); }
  ok('lifecycle: a closed broker kills its command and removes its socket; the client reports EBROKERLOST and reconnects to a new broker');

  const custom = path.join(base, 'custom.sock');
  const modest = await startBrokerServer({ socketPath: custom, agent: { ...AGENT, groups: [...AGENT.groups] }, cwdRoots: [workspace], socketMode: 0o600, launch, reap });
  assert.equal((await fs.stat(custom)).mode & 0o777, 0o600);
  await modest.close();
  await assert.rejects(fs.lstat(custom));
  const regular = path.join(base, 'regular-file');
  await fs.writeFile(regular, 'precious');
  await assert.rejects(startBrokerServer({ socketPath: regular, agent: { ...AGENT, groups: [...AGENT.groups] }, cwdRoots: [workspace], launch, reap }), /not a socket/);
  assert.equal(await fs.readFile(regular, 'utf8'), 'precious', 'a file that is not a socket is never deleted');
  // A socket file left behind by a process that was killed is replaced, so a restart after a crash does not need manual clean-up.
  const stale = path.join(base, 'stale.sock');
  const crashed = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => console.log('listening'))", stale], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { crashed.stdout.once('data', resolve); crashed.once('error', reject); crashed.once('exit', () => reject(new Error('the helper exited early'))); });
  const gone = new Promise((resolve) => crashed.once('exit', resolve));
  crashed.kill('SIGKILL');
  await gone;
  assert.ok((await fs.lstat(stale)).isSocket(), 'a killed process leaves its socket file behind');
  const afterCrash = await startBrokerServer({ socketPath: stale, agent: { ...AGENT, groups: [...AGENT.groups] }, cwdRoots: [workspace], launch, reap });
  try {
    const probe = new BrokerClient({ socketPath: stale });
    assert.equal((await probe.hello()).ok, true, 'the broker took over the path of the dead one');
    probe.close();
  } finally { await afterCrash.close(); }
  ok('lifecycle: the socket mode is configurable; a stale socket file is replaced; a regular file at the socket path is refused and left alone');
});

await withBroker({}, async ({ client, server, workspace, socketPath }) => {
  const pidFile = path.join(workspace, 'pid');
  const running = run(client, '/bin/sh', ['-c', `echo $$ > pid; sleep 30`], { cwd: workspace });
  await waitFor(async () => server.stats().running && (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim(), { label: 'the command to start' });
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  const closing = server.close();
  await closing;
  const result = await running;
  assert.ok(result.error || result.reason === 'shutdown', 'the command is told that the broker is shutting down');
  assert.equal(await isAlive(pid), false, 'close() resolves only after the command is dead');
  await assert.rejects(connectRaw(socketPath), 'nobody can connect to a closed broker');
  await server.close(); // closing twice is harmless
  ok('close(): resolves after the running command is dead, refuses new connections and is idempotent');
});

await withBroker({}, async ({ socketPath }) => {
  const raw = await connectRaw(socketPath);
  raw.sendRaw('a'.repeat(5 * 1024 * 1024));
  await Promise.race([raw.closedPromise, sleep(5000).then(() => { throw new Error('the broker kept a connection that sent an endless line'); })]);
  assert.equal(raw.closed(), true);
  const sane = await connectRaw(socketPath);
  sane.send({ t: 'hello' });
  assert.equal((await sane.next((m) => m.t === 'hello')).ok, true, 'other connections are not affected');
  sane.destroy();
  ok('protocol: a line above 4 MiB without a newline gets the connection closed; the broker keeps serving others');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The real launcher's command line, pinned exactly (a stand-in "prlimit" prints what it was given).
// ---------------------------------------------------------------------------------------------------------------------------------
{
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-launcher-'));
  try {
    // A stand-in "prlimit" that prints the command line and the environment it was started with, NUL-separated.
    const fake = path.join(base, 'prlimit');
    await fs.writeFile(fake, [
      '#!/bin/sh',
      "printf 'ARG\\0%s\\0' \"$@\"",
      "printf 'PWD\\0%s\\0' \"$(pwd -P)\"",
      "/usr/bin/env | while IFS= read -r line; do printf 'ENV\\0%s\\0' \"$line\"; done",
      '',
    ].join('\n'), { mode: 0o755 });
    process.env.CHATMCP_TEST_SECRET = 'owner-token-that-must-not-reach-the-helpers';
    const launcher = async (extra = {}) => {
      const child = launchAsAgent({
        file: '/usr/bin/some-program', args: ['plain', 'with space', '$HOME', 'semi;colon', '--option', '', '-rf'], cwd: base, env: { PATH: '/usr/bin', NAME: 'two words', EMPTY: '' },
        agent: { ...AGENT, groups: [...AGENT.groups] }, limits: { ...DEFAULT_LIMITS, ...extra }, tools: { prlimit: fake, setpriv: '/usr/bin/setpriv', env: '/usr/bin/env' },
      });
      assert.equal(typeof child.pid, 'number');
      assert.equal(child.spawnfile, fake, 'the first program started is prlimit, never the command itself');
      const chunks = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', () => {});
      await new Promise((resolve) => child.once('close', resolve));
      const parts = Buffer.concat(chunks).toString('utf8').split('\0');
      const args = [];
      const env = {};
      let pwd = null;
      for (let i = 0; i + 1 < parts.length; i += 2) {
        if (parts[i] === 'ARG') args.push(parts[i + 1]);
        else if (parts[i] === 'PWD') pwd = parts[i + 1];
        else if (parts[i] === 'ENV') { const line = parts[i + 1]; env[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1); }
      }
      return { args, env, pwd };
    };
    const normal = await launcher();
    assert.deepEqual(normal.args, [
      `--nproc=${DEFAULT_LIMITS.nproc}`, `--nofile=${DEFAULT_LIMITS.nofile}`, `--fsize=${DEFAULT_LIMITS.fsizeBytes}`, '--core=0',
      '--', '/usr/bin/setpriv', `--reuid=${AGENT.uid}`, `--regid=${AGENT.gid}`, `--groups=${AGENT.groups.join(',')}`,
      '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--pdeathsig=KILL',
      '--', '/usr/bin/env', '-i', '--', 'PATH=/usr/bin', 'NAME=two words', 'EMPTY=',
      '/usr/bin/some-program', 'plain', 'with space', '$HOME', 'semi;colon', '--option', '', '-rf',
    ], 'the exact command line: resource limits, the switch to the agent account without capabilities and with no_new_privs, a rebuilt environment, then the program and its arguments untouched');
    assert.equal(normal.pwd, await fs.realpath(base), 'the working directory is the requested one');
    assert.equal(normal.env.PATH, SAFE_PATH, 'the helpers (still root until setpriv has switched) see a fixed PATH');
    assert.equal(Object.hasOwn(normal.env, 'CHATMCP_TEST_SECRET'), false, 'nothing from the broker\'s own environment reaches the helpers');
    assert.equal(Object.hasOwn(normal.env, 'HOME'), false);
    const limited = await launcher({ dataBytes: 123_456_789 });
    const at = limited.args.indexOf('--core=0');
    assert.equal(limited.args[at + 1], '--data=123456789', 'a memory limit is added right after the other limits');
    assert.equal(limited.args[at + 2], '--');
    assert.equal(limited.args.filter((arg) => arg.startsWith('--data')).length, 1);
    assert.equal(normal.args.some((arg) => arg.startsWith('--data')), false, 'without a memory limit the flag is absent');
    ok('launcher: the command line is pinned (limits, setpriv with all capabilities dropped and no_new_privs, env -i, program and arguments verbatim); the helpers see no secret');
  } finally { delete process.env.CHATMCP_TEST_SECRET; await fs.rm(base, { recursive: true, force: true }); }

  const tools = await locateLauncherTools();
  assert.deepEqual(Object.keys(tools).sort(), ['env', 'prlimit', 'setpriv']);
  for (const [name, file] of Object.entries(tools)) assert.ok(file === null || path.isAbsolute(file), `${name}: ${file}`);
  ok(`launcher tools are located by absolute path (prlimit ${tools.prlimit ? 'found' : 'missing'}, setpriv ${tools.setpriv ? 'found' : 'missing'}, env ${tools.env ? 'found' : 'missing'} on this machine)`);
}

for (const pid of spawned) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
console.log(`PASS: ${checks} checks of the command broker (wire protocol, request validation, limits, queue, cancellation, disconnects, reaping, back-pressure, launcher command line)`);
