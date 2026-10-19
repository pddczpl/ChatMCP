// The Node launcher presents the Hub's session secret only to the process that listens on the port (docs/THREAT-MODEL.md, H6 / RR-4).
//
// The session file survives a crash. A program that binds the port afterwards can answer /api/health like a Hub, so "something
// answers on the port" is no proof that it is the Hub the file belongs to. The native clients compare the listener's process id with
// the file's (HubSession.ReadForListener); lib/hub-session.mjs `attachToRunningHub` does the same through lib/port-listener.mjs.
//
//   1. The two parsers on text: netstat -ano (Windows; a localised or multi-word state column, IPv6, UDP and established rows,
//      malformed rows) and /proc/net/tcp (Linux; rows captured from a real kernel) - plus the lookup of the owner of a socket
//      through a made-up /proc, including a listener that cannot be inspected.
//   2. The decision: no listener, another process, a failed lookup and an unsupported platform each refuse, with a readable message.
//   3. The real lookup against real sockets (Windows and Linux): a process that listens on 127.0.0.1, one on the dual-stack
//      wildcard, a real Hub, a closed port.
//   4. The attack, with a real squatter process that listens on a port, serves a real Hub's /api/health verbatim and records every
//      byte it receives, and a stale session file (written by the real writeSession) that names another process: through
//      attachToRunningHub, through launch() and through a second hub.mjs the squatter receives no request that carries the bearer,
//      the secret is not in anything it received, and no ticket is requested (so no browser would be opened).
//   5. The control: when the session file names the squatter's own process id (a recycled id) the real lookup agrees and the secret
//      does reach it. That is the limit of a process-id check, pinned here so a stronger fix has to change this suite and the documents.
//   6. The positive case: a real Hub is attached to, signs in with a ticket, and the lookup returns exactly its process id.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../lib/launch.mjs';
import { assertSessionListener, attachToRunningHub, sessionFile, writeSession } from '../lib/hub-session.mjs';
import { linuxOwners, listenerPid, parseNetstat, parseProcNetTcp } from '../lib/port-listener.mjs';
import { HUB_ROOT, cleanEnvironment, freePort, sleep, startHub, waitFor } from './e2e/hub-process.mjs';

const SQUATTER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e', 'port-squatter.mjs');
let checks = 0;
const check = (condition, label, detail = '') => { assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`); checks += 1; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };
const rejects = async (promise, pattern, label) => { await assert.rejects(promise, pattern, label); checks += 1; };

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Parsers on text
// ---------------------------------------------------------------------------------------------------------------------------------
const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1236
  TCP    127.0.0.1:3007         0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:3007         127.0.0.1:50321        ESTABLISHED     4242
  TCP    127.0.0.1:50321        127.0.0.1:3007         ESTABLISHED     9001
  TCP    127.0.0.1:3008         0.0.0.0:0              LISTENING       5555
  TCP    192.168.1.5:3007       0.0.0.0:0              LISTENING       6666
  TCP    [::1]:3007             [::]:0                 LISTENING       7777
  TCP    [::]:445               [::]:0                 LISTENING       4
  UDP    0.0.0.0:3007           *:*                                    8888
  UDP    [::]:5353              *:*                                    1111
`;
equal(parseNetstat(NETSTAT, 3007), [4242], 'netstat: only the listener on 127.0.0.1:3007 counts (not an established connection, another port, another interface, IPv6 loopback only, UDP)');
equal(parseNetstat(NETSTAT, 3008), [5555], 'netstat: another port gives its own owner');
equal(parseNetstat(NETSTAT, 3009), [], 'netstat: a port nobody listens on gives no owner');
equal(parseNetstat('  TCP    0.0.0.0:3007           0.0.0.0:0              LISTENING       55\n  TCP    [::]:3007              [::]:0                 LISTENING       77\n', 3007), [55, 77], 'netstat: the IPv4 and the IPv6 wildcard both reach 127.0.0.1');
equal(parseNetstat('  TCP    [::]:3007              [::]:0                 LISTENING       77\n  TCP    127.0.0.1:3007         0.0.0.0:0              LISTENING       4242\n', 3007), [4242], 'netstat: a listener bound to 127.0.0.1 takes precedence over a wildcard one, as it does for the connections');
equal(parseNetstat('  TCP    127.0.0.1:3007         0.0.0.0:0              ABHÖREN         4242\n', 3007), [4242], 'netstat: a localised state column (German) does not matter');
equal(parseNetstat('  TCP    127.0.0.1:3007         0.0.0.0:0              IN ASCOLTO      4242\n', 3007), [4242], 'netstat: nor a state of two words (Italian)');
equal(parseNetstat('  TCP    127.0.0.1:3007         0.0.0.0:0              LISTENING       4242\r\n', 3007), [4242], 'netstat: CRLF line ends');
for (const bad of ['  TCP    this is not a row\n', '  TCP    127.0.0.1:3007  nonsense  LISTENING  42\n', '  TCP    127.0.0.1:3007         0.0.0.0:0              LISTENING       forty\n']) {
  assert.throws(() => parseNetstat(bad, 3007), /unexpected line in the netstat table/, `netstat: ${JSON.stringify(bad.trim())} is not trusted`); checks += 1;
}
await rejects(listenerPid(3007, { platform: 'win32', netstat: async () => '  TCP    127.0.0.1:3007         0.0.0.0:0              LISTENING       10\n  TCP    127.0.0.1:3007         0.0.0.0:0              LISTENING       11\n' }), /ambiguous: processes 10, 11/, 'two different owners of 127.0.0.1:port are ambiguous, not "the first one"');
await rejects(listenerPid(3007, { platform: 'win32', netstat: async () => '  TCP    0.0.0.0:3007           0.0.0.0:0              LISTENING       10\n  TCP    [::]:3007              [::]:0                 LISTENING       11\n' }), /ambiguous: processes 10, 11/, 'so are two wildcard owners');
equal(await listenerPid(3007, { platform: 'win32', netstat: async () => NETSTAT }), 4242, 'listenerPid on the sample table');
equal(await listenerPid(3009, { platform: 'win32', netstat: async () => NETSTAT }), null, 'listenerPid: null when nothing listens');
await rejects(listenerPid(3007, { platform: 'win32', netstat: async () => { throw new Error('netstat failed: access denied'); } }), /netstat failed/, 'a netstat that fails is an error, not "no listener"');
for (const platform of ['darwin', 'freebsd']) await rejects(listenerPid(3007, { platform }), /no listener lookup for the platform/, `${platform}: no lookup, so an error (the caller then refuses)`);
for (const port of [0, 70000, 3007.5, '3007']) await rejects(listenerPid(port), /invalid port/, `invalid port ${JSON.stringify(port)}`);

// Rows of /proc/net/tcp and tcp6 as a Linux 6.18 kernel (WSL2 Ubuntu) printed them while one process held four listening sockets:
// 127.0.0.1:46793, [::1]:51701 (IPV6_V6ONLY), [::]:44701 (dual stack) and 0.0.0.0:43215. The fd table is what /proc/45/fd said.
const PROC_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B6C9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 14397 1 0000000026575da9 100 0 0 10 0
   1: 00000000:A8CF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 14400 1 00000000abedfa97 100 0 0 10 0
   2: 9F541EAC:E738 B2B671CB:0050 06 00000000:00000000 03:00001510 00000000     0        0 0 3 00000000f0102076
   3: 0100007F:B6C9 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 14500 1 0000000011111111 100 0 0 10 0
`;
const PROC_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:C9F5 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 14399 1 000000003bec5c97 100 0 0 10 0
   1: 00000000000000000000000000000000:AE9D 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 14398 1 00000000f2f0edda 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 14501 1 0000000022222222 100 0 0 10 0
`;
equal(parseProcNetTcp(PROC_TCP, 46793), ['14397'], '/proc/net/tcp: 127.0.0.1 listener (an established row with the same local port is not a listener)');
equal(parseProcNetTcp(PROC_TCP, 43215), ['14400'], '/proc/net/tcp: 0.0.0.0 listener');
equal(parseProcNetTcp(PROC_TCP, 0xE738), [], '/proc/net/tcp: a TIME_WAIT row (inode 0, state 06) is not a listener');
equal(parseProcNetTcp(PROC_TCP6, 44701, { v6: true }), ['14398'], '/proc/net/tcp6: the dual-stack [::] listener reaches 127.0.0.1');
equal(parseProcNetTcp(PROC_TCP6, 51701, { v6: true }), [], '/proc/net/tcp6: [::1] alone does not');
equal(parseProcNetTcp(PROC_TCP6, 8080, { v6: true }), ['14501'], '/proc/net/tcp6: ::ffff:127.0.0.1 does');
for (const bad of ['', 'garbage\n', `${PROC_TCP.split('\n')[0]}\n   0: nonsense\n`]) {
  assert.throws(() => parseProcNetTcp(bad, 46793), /unexpected (header|line) in \/proc\/net\/tcp/, `/proc/net/tcp: ${JSON.stringify(bad.slice(0, 20))} is not trusted`); checks += 1;
}
const fdTable = { 3: 'socket:[14397]', 4: 'socket:[14398]', 5: 'socket:[14399]', 6: 'socket:[14400]', 0: '/dev/null' };
const denied = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
const fakeProc = ({ withForeignListener = false, otherHolder = false } = {}) => ({
  readFile: async (file) => (file.endsWith('tcp6') ? PROC_TCP6 : PROC_TCP),
  readdir: async (directory) => {
    if (directory === '/proc') return ['1', '45', '46', 'self', 'net'];
    if (directory === '/proc/45/fd') return Object.keys(fdTable);
    if (directory === '/proc/46/fd' && otherHolder) return ['9']; // a second process holding the same listening socket (an inherited descriptor)
    if (directory === '/proc/1/fd' && withForeignListener) throw denied(); // another account's process
    if (directory === '/proc/1/fd') return [];
    if (directory === '/proc/46/fd') return [];
    throw new Error(`unexpected readdir ${directory}`);
  },
  readlink: async (link) => (link === '/proc/46/fd/9' ? 'socket:[14397]' : fdTable[link.split('/').pop()]),
});
equal(await linuxOwners(46793, fakeProc()), [45], 'linux: the process that holds the inode of the 127.0.0.1 listener');
equal(await linuxOwners(44701, fakeProc()), [45], 'linux: ... and of the dual-stack listener');
equal(await linuxOwners(51701, fakeProc()), [], 'linux: a [::1]-only listener does not receive 127.0.0.1 connections: no owner');
equal(await linuxOwners(9999, fakeProc()), [], 'linux: no listener on the port, no scan');
equal(await listenerPid(46793, { platform: 'linux', procfs: fakeProc() }), 45, 'linux: listenerPid');
await rejects(listenerPid(46793, { platform: 'linux', procfs: fakeProc({ otherHolder: true }) }), /ambiguous: processes 45, 46/, 'linux: two processes holding the listening socket are ambiguous');
await rejects(listenerPid(46793, { platform: 'linux', procfs: { ...fakeProc(), readdir: async (directory) => { if (directory === '/proc') return ['1', '2']; throw denied(); } } }), /cannot inspect/, 'linux: a listener whose holder cannot be inspected is an error, not "nobody"');
await rejects(listenerPid(46793, { platform: 'linux', procfs: { ...fakeProc(), readFile: async () => { throw denied(); } } }), /cannot read \/proc\/net\/tcp/, 'linux: an unreadable table is an error');

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. The decision
// ---------------------------------------------------------------------------------------------------------------------------------
const session = { port: 3007, pid: 4242, secret: randomBytes(32).toString('hex') };
await assertSessionListener(session, { listenerPid: async (port) => { assert.equal(port, 3007); return 4242; } });
checks += 1;
const refusal = async (listenerLookup, pattern, label) => {
  const error = await assertSessionListener(session, { listenerPid: listenerLookup, file: 'X/run/hub-session.json' }).then(() => null, (failure) => failure);
  assert.ok(error, `${label}: refused`);
  assert.equal(error.code, 'ERR_SESSION_LISTENER', label);
  assert.match(error.message, pattern, label);
  assert.ok(!error.message.includes(session.secret), `${label}: the message never carries the secret`);
  checks += 3;
};
await refusal(async () => 7, /pid 7 giữ, không phải Hub pid 4242 đã ghi X\/run\/hub-session\.json.*Không gửi secret/s, 'another process listens');
await refusal(async () => null, /Không có tiến trình nào đang lắng nghe cổng 3007.*pid 4242/s, 'nobody listens');
await refusal(async () => undefined, /Không có tiến trình nào/, 'an undefined answer is "nobody" too');
await refusal(async () => { throw new Error('ambiguous: processes 4242, 7 all listen on port 3007'); }, /Không xác định được tiến trình.*ambiguous: processes 4242, 7/s, 'the lookup cannot decide');
await refusal(() => listenerPid(3007, { platform: 'darwin' }), /Không xác định được tiến trình.*no listener lookup for the platform darwin/s, 'a platform without a lookup refuses instead of skipping');

// ---------------------------------------------------------------------------------------------------------------------------------
// The rest needs real sockets and a real Hub
// ---------------------------------------------------------------------------------------------------------------------------------
if (!['win32', 'linux'].includes(process.platform)) {
  console.log(`CHATMCP_TEST_SKIP: the listener lookup exists for win32 and linux only (this is ${process.platform}); the parser and decision checks above passed`);
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-listener-'));
const children = [];
let hub;
const sandbox = (name) => { const directory = path.join(scratch, name); fs.mkdirSync(directory, { recursive: true }); return directory; };
const stopChild = async (child) => {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]);
};

/** A separate process that listens on `port` and answers like a Hub; see e2e/port-squatter.mjs. */
async function squat({ name, port, host, healthText }) {
  const directory = sandbox(`squatter-${name}`);
  const files = { health: path.join(directory, 'health.json'), requests: path.join(directory, 'requests.jsonl'), raw: path.join(directory, 'raw.bin') };
  fs.writeFileSync(files.health, healthText);
  for (const file of [files.requests, files.raw]) fs.writeFileSync(file, '');
  const child = spawn(process.execPath, [SQUATTER, '--port', String(port), ...(host ? ['--host', host] : []), '--health', files.health, '--requests', files.requests, '--raw', files.raw], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  children.push(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the squatter did not start')), 15_000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the squatter exited early (${code})`)); });
  });
  return {
    port, pid: child.pid, origin: `http://127.0.0.1:${port}`,
    requests: () => fs.readFileSync(files.requests, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    raw: () => fs.readFileSync(files.raw, 'latin1'),
    stop: () => stopChild(child),
  };
}
const deadPid = async () => { const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true }); await new Promise((resolve) => child.once('exit', resolve)); return child.pid; };
/** The session file as the Hub's own writer makes it, naming `pid` (a process that is not the one listening, unless a test says so). */
async function staleSession(stateDir, { port, pid, secret = randomBytes(32).toString('hex') }) { await writeSession(stateDir, { port, secret, pid }); return { stateDir, secret, pid, port }; }

try {
  // ---- 6. the positive case, on a real Hub ------------------------------------------------------------------------------------
  hub = await startHub({ scratch: sandbox('hub') });
  equal(await listenerPid(hub.port), hub.pid, 'a real Hub: the lookup returns exactly its process id (the one in run/hub-session.json)');
  equal((await hub.session()).pid, hub.pid, 'and that is the pid the Hub published');
  const attached = await attachToRunningHub({ origin: hub.origin, stateDirectory: hub.stateDir });
  equal([attached.session.pid, attached.selectError], [hub.pid, null], 'attachToRunningHub: attached to the real Hub');
  const ticket = await attached.ticket();
  check(typeof ticket === 'string' && ticket.length >= 16, 'and the ticket (what the browser is opened with) comes from the real Hub');
  await rejects(attachToRunningHub({ origin: hub.origin, stateDirectory: hub.stateDir, listenerPid: async () => hub.pid + 1 }), /ERR_SESSION_LISTENER|không phải Hub/, 'the injectable lookup is honoured: a different listener refuses even a real Hub');
  const healthText = await (await fetch(`${hub.origin}/api/health`)).text();
  equal(JSON.parse(healthText).auth, 'bearer', 'the Hub health the squatters will copy says auth: bearer');

  // ---- 3. the real lookup against sockets of other processes --------------------------------------------------------------------
  for (const [name, host] of [['loopback', '127.0.0.1'], ['wildcard', undefined]]) {
    const port = await freePort();
    const squatter = await squat({ name: `lookup-${name}`, port, host, healthText });
    equal(await listenerPid(port), squatter.pid, `the lookup finds the other process that listens on ${host ?? 'the dual-stack wildcard'}`);
    await squatter.stop();
    await waitFor(async () => (await listenerPid(port)) === null, { timeoutMs: 10_000, label: 'the port to be free again' });
    equal(await listenerPid(port), null, 'and null once it is gone');
  }

  // ---- Windows: a wildcard listener beside a live Hub does not receive its connections, so it must not make the Hub unusable ---------
  if (process.platform === 'win32') {
    const beside = await startHub({ scratch: sandbox('hub-beside-squatter') });
    let squatter;
    try {
      squatter = await squat({ name: 'beside-hub', port: beside.port, host: undefined, healthText });
      equal(await listenerPid(beside.port), beside.pid, 'Windows: with a wildcard listener and a Hub on 127.0.0.1 the lookup answers with the Hub (the most specific listener gets the connections)');
      // A new connection each time (a pooled one would have been made before the squatter existed).
      const fresh = (route) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: beside.port, path: route, agent: false, headers: beside.authHeaders }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode)); }).once('error', reject));
      equal([await fresh('/api/state'), await fresh('/api/state'), await fresh('/api/state')], [200, 200, 200], 'Windows: and connections to 127.0.0.1 reach the Hub');
      equal(squatter.requests(), [], 'Windows: the wildcard listener received none of them');
      const attachedBeside = await attachToRunningHub({ origin: beside.origin, stateDirectory: beside.stateDir });
      equal(attachedBeside.session.pid, beside.pid, 'Windows: attachToRunningHub attaches to that Hub');
    } finally { beside.killTree(); await squatter?.stop(); }
  }

  // ---- off Windows launch() itself prints the sign-in link of a Hub it just started; it checks the listener first ------------------------
  // (On Windows the Hub opens the browser from its own process and the launcher asks for nothing, so this branch does not exist there.)
  if (process.platform !== 'win32') {
    delete process.env.CHATMCP_NO_OPEN;
    const port = await freePort();
    const lines = [];
    const started = await launch(['--state-dir', sandbox('state-launch-open'), '--port', String(port)], { log: (line) => lines.push(line), warn: (line) => lines.push(line) });
    try {
      equal([started.reused, Number.isInteger(started.pid)], [false, true], 'launch() started a new Hub in the background');
      equal(await listenerPid(port), started.pid, 'the process that listens on the port is the one launch() started');
      check(lines.some((line) => /Open within a minute.*#chatmcp-boot=/.test(line)), 'launch() printed the single-use sign-in link after the listener check', lines.join('\n'));
    } finally {
      try { process.kill(started.pid, 'SIGTERM'); } catch { /* already gone */ }
      await waitFor(() => { try { process.kill(started.pid, 0); return false; } catch { return true; } }, { timeoutMs: 15_000, label: 'the launched Hub to exit' }).catch(() => { try { process.kill(started.pid, 'SIGKILL'); } catch { /* gone */ } });
    }
  }

  // ---- 4. the attack ------------------------------------------------------------------------------------------------------------
  const scenarios = [
    { name: 'loopback-live', host: '127.0.0.1', describe: 'a squatter on 127.0.0.1; the stale session names a live process that is not listening', pid: async () => process.pid, secondHub: true },
    // On Windows a Hub can start beside a program that holds the wildcard (it binds the more specific 127.0.0.1), so a second hub.mjs
    // has no EADDRINUSE path to take there; the launcher, which asks /api/health first, does reach the squatter.
    { name: 'wildcard-dead', host: undefined, describe: 'a squatter on the dual-stack wildcard; the stale session names a process that no longer exists', pid: deadPid, secondHub: process.platform !== 'win32' },
  ];
  for (const scenario of scenarios) {
    const port = await freePort();
    const squatter = await squat({ name: scenario.name, port, host: scenario.host, healthText });
    const stalePid = await scenario.pid();
    assert.notEqual(stalePid, squatter.pid);
    const stale = await staleSession(sandbox(`state-${scenario.name}`), { port, pid: stalePid });
    const assertNothingSent = (label, { allowed = [] } = {}) => {
      const sent = squatter.requests();
      const unexpected = sent.filter((request) => !allowed.includes(`${request.method} ${request.path}`));
      equal(unexpected, [], `${label}: the squatter received nothing but ${allowed.join(', ') || 'nothing'}`);
      check(!sent.some((request) => 'authorization' in request.headers), `${label}: no request carried an Authorization header`);
      check(!squatter.raw().includes(stale.secret) && !/Bearer/i.test(squatter.raw()), `${label}: neither the secret nor the word Bearer is in anything the squatter received`);
    };
    const mismatch = new RegExp(`pid ${squatter.pid} giữ, không phải Hub pid ${stalePid}`);

    // (a) the function every caller goes through: the lookup precedes the first byte
    const refusedAttach = await attachToRunningHub({ origin: squatter.origin, stateDirectory: stale.stateDir }).then(() => null, (error) => error);
    check(refusedAttach?.code === 'ERR_SESSION_LISTENER' && mismatch.test(refusedAttach.message), `${scenario.describe}: attachToRunningHub refuses and names both processes`, refusedAttach?.message);
    check(refusedAttach.message.includes(sessionFile(stale.stateDir)), 'the message names the session file');
    assertNothingSent('attachToRunningHub', { allowed: [] });

    // (b) launch(): the launcher's reuse path (it asks /api/health first, which a squatter can answer)
    const lines = [];
    const refusedLaunch = await launch(['--port', String(port), '--state-dir', stale.stateDir, '--no-open'], { log: (line) => lines.push(line), warn: (line) => lines.push(line) }).then(() => null, (error) => error);
    check(refusedLaunch?.code === 'ERR_SESSION_LISTENER' && mismatch.test(refusedLaunch.message), 'launch() refuses with the same message', refusedLaunch?.message ?? lines.join('\n'));
    check(!lines.some((line) => line.includes('Hub da chay nen')), 'and says nothing about having reused a Hub');
    assertNothingSent('launch()', { allowed: ['GET /api/health'] });
    check(squatter.requests().some((request) => request.path === '/api/health'), 'the squatter was consulted (it answered the health probe), so the refusal is the listener check and not a missing Hub');

    // (c) a second hub.mjs on the same port
    if (scenario.secondHub) {
      const logFile = path.join(sandbox(`hubmjs-${scenario.name}`), 'hub.log');
      const output = fs.openSync(logFile, 'a');
      const second = spawn(process.execPath, [path.join(HUB_ROOT, 'hub.mjs'), '--port', String(port), '--state-dir', stale.stateDir, '--no-open'], {
        cwd: HUB_ROOT, env: cleanEnvironment(path.dirname(logFile)), stdio: ['ignore', output, output], windowsHide: true,
      });
      children.push(second);
      fs.closeSync(output);
      const exitCode = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 60_000);
        second.once('exit', (code) => { clearTimeout(timer); resolve(code); });
      });
      const secondLog = fs.readFileSync(logFile, 'utf8');
      check(exitCode === 1 && mismatch.test(secondLog) && !/Hub đã chạy sẵn/.test(secondLog), 'a second hub.mjs exits with the refusal and does not claim to have attached', `${exitCode}\n${secondLog.slice(-600)}`);
      assertNothingSent('hub.mjs on an occupied port', { allowed: ['GET /api/health'] });
      equal(fs.existsSync(sessionFile(stale.stateDir)), true, 'the stale session file is left alone (it is not deleted behind the owner\'s back)');
    }

    // (d) a lookup that fails is a refusal, and nothing was sent either
    await rejects(attachToRunningHub({ origin: squatter.origin, stateDirectory: stale.stateDir, listenerPid: async () => { throw new Error('netstat failed: simulated'); } }), /Không xác định được tiến trình.*netstat failed: simulated/s, 'a lookup that cannot answer refuses');
    assertNothingSent('after a failed lookup', { allowed: ['GET /api/health'] });
    await squatter.stop();
  }

  // ---- no listener at all (the Hub died, the file is stale) ---------------------------------------------------------------------
  {
    const port = await freePort();
    const stale = await staleSession(sandbox('state-nobody'), { port, pid: process.pid });
    await rejects(attachToRunningHub({ origin: `http://127.0.0.1:${port}`, stateDirectory: stale.stateDir }), /Không có tiến trình nào đang lắng nghe cổng/, 'a stale file with nobody on the port is refused before any connection is made');
  }

  // ---- 5. the limit: a recycled process id -------------------------------------------------------------------------------------
  {
    const port = await freePort();
    const squatter = await squat({ name: 'recycled', port, host: '127.0.0.1', healthText });
    const recycled = await staleSession(sandbox('state-recycled'), { port, pid: squatter.pid });
    const attachedToSquatter = await attachToRunningHub({ origin: squatter.origin, stateDirectory: recycled.stateDir });
    await attachedToSquatter.ticket();
    check(squatter.requests().some((request) => request.headers.authorization === `Bearer ${recycled.secret}`), 'LIMIT (RR-4 residual): when the stale file names the squatter\'s own process id, the lookup agrees and the bearer reaches it; a process-id check cannot tell a recycled id from the Hub');
    check(squatter.requests().some((request) => request.method === 'POST' && request.path === '/api/session/ticket'), 'and the harness records a ticket request, so the "nothing was sent" checks above can fail');
    await squatter.stop();
  }

  console.log(`PASS: ${checks} checks - netstat and /proc parsers, the decision, the real lookup, a real squatter refused through attachToRunningHub, launch() and hub.mjs, and a real Hub attached to`);
} finally {
  for (const child of children) await stopChild(child);
  hub?.killTree();
  await sleep(300);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
