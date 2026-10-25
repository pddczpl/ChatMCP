// The PowerShell helper scripts present the Hub's session secret only to the process that listens on the port (docs/THREAT-MODEL.md, H6 / RR-4).
//
// Stop-ChatMcpHub.ps1 (behind STOP-CHATMCP-HUB.cmd), windows/Run-StudioSmoke.ps1 and windows/Test-Gateway-ViaHub.ps1 read
// <state dir>/run/hub-session.json. The file survives a crash, and a program that binds the port afterwards can answer /api/health
// like a Hub, so each script asks Windows who owns the listening socket (Get-NetTCPConnection) and compares that process id with
// the file's before any request carries the secret. The Node launcher (verify-hub-listener.mjs) and the native clients do the same.
//
//   1. The source (every platform): the three scripts carry one identical block (hub-listener-check), it names no bearer, and in
//      each script the call of Assert-HubSessionListener precedes every place that builds an Authorization header.
//   2. The decision, run for real (Windows PowerShell 5.1, strict mode 2.0, the block dot-sourced from the shipped script) against a
//      stand-in for Get-NetTCPConnection: a listener on 127.0.0.1 wins over a wildcard one, two owners, an unknown owner, an
//      unreadable table and "no listener" each give the documented answer, and each refusal says that no secret was sent.
//   3. The attack, with a real squatter process (it serves a real Hub's /api/health verbatim and records every byte it receives)
//      and a stale session file that names another process: each script refuses with a readable error and the squatter receives
//      no Authorization header, no secret and no "Bearer" in anything it was sent. For a Hub that predates the secret (no `auth` in its
//      health) the stop script's older flow runs on and sends no secret either (a squatter that imitates one stands in for it; the
//      real v3.9.0 Hub is only in the CI job windows-upgrade-from-secretless-hub). A base URL of http://localhost:port is connected to as 127.0.0.1, so a squatter on ::1 gets nothing either.
//   4. The control: when the stale file names the squatter's own process id (a recycled id) the lookup agrees and the bearer does
//      reach it, which shows that the recording can see a leak from PowerShell and pins the limit of a process-id check.
//   5. The positive case: against a real Hub the scripts get through (the state request with the secret succeeds; Stop stops it).
//
// Parts 2 to 5 need Windows PowerShell and Get-NetTCPConnection; elsewhere the suite reports what it did not run and passes on part 1.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionFile } from '../lib/hub-session.mjs';
import { HUB_ROOT, freePort, sleep, startHub, waitFor } from './e2e/hub-process.mjs';
import { createSquatterHarness } from './e2e/squatter-harness.mjs';
import { powerShellChildEnvironment } from './support/powershell-environment.mjs';

let checks = 0;
const check = (condition, label, detail = '') => { assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`); checks += 1; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };

const SCRIPTS = ['Stop-ChatMcpHub.ps1', 'windows/Run-StudioSmoke.ps1', 'windows/Test-Gateway-ViaHub.ps1'];
const [STOP, SMOKE, GATEWAY] = SCRIPTS;
const MARKER = /# BEGIN hub-listener-check\n[\s\S]*?# END hub-listener-check\n/g;

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. The source
// ---------------------------------------------------------------------------------------------------------------------------------
const sources = Object.fromEntries(SCRIPTS.map((name) => [name, fs.readFileSync(path.join(HUB_ROOT, name), 'utf8').replace(/\r\n/g, '\n')]));
const blocks = Object.fromEntries(SCRIPTS.map((name) => [name, sources[name].match(MARKER) ?? []]));
for (const name of SCRIPTS) {
  equal(blocks[name].length, 1, `${name} has exactly one hub-listener-check block`);
  check(!/[^\x00-\x7f]/.test(sources[name]), `${name} is ASCII only (Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page)`);
}
equal(blocks[SMOKE][0], blocks[STOP][0], 'the block of Run-StudioSmoke.ps1 is the block of Stop-ChatMcpHub.ps1');
equal(blocks[GATEWAY][0], blocks[STOP][0], 'the block of Test-Gateway-ViaHub.ps1 is the block of Stop-ChatMcpHub.ps1');
const block = blocks[STOP][0];
check(/Get-NetTCPConnection -State Listen -LocalPort \$ListenPort -ErrorAction Stop/.test(block), 'the block asks for the listening sockets of the port and stops on an error');
check(/CmdletizationQuery_NotFound/.test(block) && !/\$_\.Exception\.Message -(?:like|match)/.test(block), '"nobody listens" is recognised by the error id, not by a localised message');
check(/\$listener -ne \$SessionPid/.test(block), 'the block compares the listener with the process id of the session file');
check(!/bearer/i.test(block), 'the block names no bearer: a script cannot have built a header before it ran');
for (const name of SCRIPTS) {
  const source = sources[name];
  const blockEnd = source.indexOf('# END hub-listener-check');
  const call = source.indexOf('Assert-HubSessionListener -SessionPid', blockEnd);
  const headers = [...source.matchAll(/'Bearer '/g)].map((match) => match.index);
  check(call > blockEnd && headers.length >= 1 && headers.every((at) => at > call), `${name}: the listener check is called before every place that builds the Authorization header`);
}
for (const name of [SMOKE, GATEWAY]) check(sources[name].includes("$BaseUrl = $BaseUrl -replace '^http://localhost:', 'http://127.0.0.1:'"), `${name} connects to 127.0.0.1 even when it is given localhost (a name may resolve to ::1 first)`);

if (process.platform !== 'win32') {
  console.log(`  --  the PowerShell helper scripts run on Windows only; ${process.platform} ran the source checks`);
  console.log(`PASS: ${checks} checks - the three scripts carry one identical listener check that precedes every Authorization header (the PowerShell runs are Windows only)`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Windows: run the scripts
// ---------------------------------------------------------------------------------------------------------------------------------
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-listener-ps-'));
const harness = createSquatterHarness(scratch);
const { sandbox, squat, deadPid, staleSession } = harness;
const hubs = [];

/** Windows PowerShell running `script` with `args`; resolves with the exit code and everything it printed. */
function powershell(script, args = [], { timeoutMs = 150_000 } = {}) {
  const env = powerShellChildEnvironment();
  delete env.CHATMCP_STATE_DIR; delete env.CHATMCP_HUB_SECRET; // the scripts are told where to look
  return new Promise((resolve) => {
    const child = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { output += '\n[the test killed it: timeout]'; child.kill(); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
const scriptPath = (name) => path.join(HUB_ROOT, name);

try {
  // ---- 2. the decision against a stand-in for Get-NetTCPConnection --------------------------------------------------------------
  const logic = sandbox('logic');
  fs.writeFileSync(path.join(logic, 'block.ps1'), block.replace('# BEGIN hub-listener-check\n', '').replace('# END hub-listener-check\n', ''));
  const row = (address, owner) => ({ a: address, o: owner });
  const cases = [
    { name: 'loopback', rows: [row('127.0.0.1', 4242)], value: '4242' },
    { name: 'one process on both wildcards', rows: [row('0.0.0.0', 55), row('::', 55)], value: '55' },
    { name: 'two wildcard owners', rows: [row('0.0.0.0', 55), row('::', 77)], error: /^processes 55, 77 all listen on port 3007$/ },
    { name: 'loopback beats wildcard', rows: [row('::', 77), row('127.0.0.1', 4242)], value: '4242' },
    { name: 'two loopback owners', rows: [row('127.0.0.1', 10), row('127.0.0.1', 11)], error: /^processes 10, 11 all listen on port 3007$/ },
    { name: 'other interfaces are not reached', rows: [row('::1', 7), row('192.168.1.5', 8)], value: 'null' },
    { name: 'other interfaces are ignored beside the owner', rows: [row('::1', 7), row('127.0.0.1', 4242)], value: '4242' },
    { name: 'no listener', rows: [], fail: 'notfound', value: 'null' },
    { name: 'access denied', rows: [], fail: 'denied', error: /^the TCP table cannot be read: Access is denied$/ },
    { name: 'the cmdlet throws', rows: [], fail: 'throw', error: /^the TCP table cannot be read: .*CIM service/ },
    { name: 'unknown owner', rows: [row('127.0.0.1', 0)], error: /no known owner/ },
    { name: 'unknown owner of a wildcard socket', rows: [row('127.0.0.1', 4242), row('::', 0)], error: /no known owner/ },
    { name: 'assert: the listener is the Hub', rows: [row('127.0.0.1', 4242)], assertPid: 4242, value: 'ok' },
    { name: 'assert: another process listens', rows: [row('127.0.0.1', 4242)], assertPid: 4243, error: /^Port 3007 is held by process 4242, not by the Hub \(process 4243\) that wrote hub-session\.json.* The session secret was not sent\./ },
    { name: 'assert: nobody listens', rows: [], fail: 'notfound', assertPid: 4242, error: /^Nothing listens on port 3007, although hub-session\.json says that the Hub \(process 4242\) runs there.* The session secret was not sent\./ },
    { name: 'assert: the table cannot be read', rows: [], fail: 'denied', assertPid: 4242, error: /^Cannot tell which process listens on port 3007 \(the TCP table cannot be read: Access is denied\).* The session secret was not sent\./ },
    { name: 'assert: two owners', rows: [row('0.0.0.0', 55), row('::', 77)], assertPid: 55, error: /^Cannot tell which process listens on port 3007 \(processes 55, 77 all listen on port 3007\).* The session secret was not sent\./ },
  ];
  fs.writeFileSync(path.join(logic, 'cases.json'), JSON.stringify(cases.map(({ name, rows, fail = '', assertPid }) => ({ name, rows, fail, ...(assertPid === undefined ? {} : { assertPid }) }))));
  fs.writeFileSync(path.join(logic, 'harness.ps1'), `param([string]$BlockFile, [string]$CasesFile)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. $BlockFile
$script:MockRows = @()
$script:MockFailure = ''
# A function outranks the cmdlet of the same name, so the block under test sees this table instead of the machine's.
function Get-NetTCPConnection {
    [CmdletBinding()]
    param([string]$State, [int]$LocalPort)
    if ($script:MockFailure -eq 'notfound') { Write-Error -Message 'No matching objects (the text depends on the language)' -ErrorId 'CmdletizationQuery_NotFound_LocalPort,Get-NetTCPConnection' -Category ObjectNotFound; return }
    if ($script:MockFailure -eq 'denied') { Write-Error -Message 'Access is denied' -ErrorId 'CimException,Get-NetTCPConnection' -Category PermissionDenied; return }
    if ($script:MockFailure -eq 'throw') { throw 'The CIM service is not running' }
    foreach ($row in $script:MockRows) { [pscustomobject]@{ LocalAddress = $row.a; LocalPort = $LocalPort; OwningProcess = [uint32]$row.o; State = 'Listen' } }
}
$cases = Get-Content -LiteralPath $CasesFile -Raw | ConvertFrom-Json
foreach ($case in $cases) {
    $script:MockRows = @($case.rows)
    $script:MockFailure = [string]$case.fail
    try {
        if ($null -ne $case.PSObject.Properties['assertPid']) { Assert-HubSessionListener -SessionPid ([int64]$case.assertPid) -ListenPort 3007; $text = 'ok' }
        else {
            $found = Get-HubListenerPid -ListenPort 3007
            if ($null -eq $found) { $text = 'null' } else { $text = [string]$found }
        }
        Write-Output ('CASE|' + $case.name + '|value|' + $text)
    }
    catch { Write-Output ('CASE|' + $case.name + '|error|' + $_.Exception.Message) }
}
Write-Output 'DONE'
`);

  // ---- 3. the attack: everything that can run at once is started together ---------------------------------------------------------
  const hub = await startHub({ scratch: sandbox('hub') });
  hubs.push(hub);
  const healthText = await (await fetch(`${hub.origin}/api/health`)).text();
  equal(JSON.parse(healthText).auth, 'bearer', 'the Hub health the squatters will copy says auth: bearer');
  const legacyHealth = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(healthText)).filter(([key]) => key !== 'auth')));

  /** A squatter on `host`, a stale session file that names `pid`, and what the squatter has been sent so far. */
  async function attackSetup(name, { host = '127.0.0.1', pid, health = healthText }) {
    const port = await freePort();
    const squatter = await squat({ name, port, host, healthText: health });
    const stalePid = pid === 'squatter' ? squatter.pid : (pid ?? await deadPid());
    const stale = await staleSession(sandbox(`state-${name}`), { port, pid: stalePid });
    return { port, squatter, stale, stalePid };
  }
  const scenarios = {
    stop: await attackSetup('stop', {}),
    smoke: await attackSetup('smoke', {}),
    gateway: await attackSetup('gateway-wildcard', { host: undefined }),
    nobody: null,
    legacy: await attackSetup('stop-legacy', { health: legacyHealth }),
    control: await attackSetup('control', { pid: 'squatter' }),
  };
  {
    const port = await freePort();
    scenarios.nobody = { port, stale: await staleSession(sandbox('state-nobody'), { port, pid: process.pid }), stalePid: process.pid };
  }
  // localhost: the real Hub on 127.0.0.1 and a squatter on ::1 only, at the same port. A request to the name "localhost" may go to ::1.
  let v6 = null;
  try { v6 = await squat({ name: 'v6', port: hub.port, host: '::1', healthText }); } catch { /* this machine has no IPv6 loopback */ }

  const dedicated = await startHub({ scratch: sandbox('hub-stop') });
  hubs.push(dedicated);

  const [logicRun, stopRun, smokeRun, gatewayRun, nobodyRun, legacyRun, controlRun, localhostRun, smokeOk, gatewayOk, stopOk] = await Promise.all([
    powershell(path.join(logic, 'harness.ps1'), ['-BlockFile', path.join(logic, 'block.ps1'), '-CasesFile', path.join(logic, 'cases.json')]),
    powershell(scriptPath(STOP), ['-Port', String(scenarios.stop.port), '-StateDir', scenarios.stop.stale.stateDir]),
    powershell(scriptPath(SMOKE), ['-BaseUrl', scenarios.smoke.squatter.origin, '-StateDir', scenarios.smoke.stale.stateDir]),
    powershell(scriptPath(GATEWAY), ['-BaseUrl', scenarios.gateway.squatter.origin, '-StateDir', scenarios.gateway.stale.stateDir]),
    powershell(scriptPath(SMOKE), ['-BaseUrl', `http://127.0.0.1:${scenarios.nobody.port}`, '-StateDir', scenarios.nobody.stale.stateDir]),
    powershell(scriptPath(STOP), ['-Port', String(scenarios.legacy.port), '-StateDir', scenarios.legacy.stale.stateDir]),
    powershell(scriptPath(SMOKE), ['-BaseUrl', scenarios.control.squatter.origin, '-StateDir', scenarios.control.stale.stateDir]),
    v6 ? powershell(scriptPath(SMOKE), ['-BaseUrl', `http://localhost:${hub.port}`, '-StateDir', hub.stateDir]) : Promise.resolve(null),
    powershell(scriptPath(SMOKE), ['-BaseUrl', hub.origin, '-StateDir', hub.stateDir]),
    powershell(scriptPath(GATEWAY), ['-BaseUrl', hub.origin, '-StateDir', hub.stateDir]),
    powershell(scriptPath(STOP), ['-Port', String(dedicated.port), '-StateDir', dedicated.stateDir]),
  ]);

  // ---- 2. the decision: the answers ---------------------------------------------------------------------------------------------
  {
    const answers = new Map(logicRun.output.split(/\r?\n/).filter((line) => line.startsWith('CASE|')).map((line) => { const [, name, kind, ...rest] = line.split('|'); return [name, { kind, text: rest.join('|') }]; }));
    check(/^DONE\s*$/m.test(logicRun.output) && answers.size === cases.length, 'the strict-mode harness ran every case', logicRun.output.slice(-800));
    for (const entry of cases) {
      const got = answers.get(entry.name);
      if (entry.error) check(got?.kind === 'error' && entry.error.test(got.text), `${entry.name}: refused with the documented message`, JSON.stringify(got));
      else equal(got, { kind: 'value', text: entry.value }, `${entry.name}: answer`);
    }
  }

  // ---- 3. the attack: what each script did ---------------------------------------------------------------------------------------
  const assertNothingSent = ({ squatter, stale }, label, allowed) => {
    const sent = squatter.requests();
    equal(sent.filter((request) => !allowed.includes(`${request.method} ${request.path}`)), [], `${label}: the squatter received nothing but ${allowed.join(', ') || 'nothing'}`);
    check(!sent.some((request) => 'authorization' in request.headers), `${label}: no request carried an Authorization header`);
    check(!squatter.raw().includes(stale.secret) && !/Bearer/i.test(squatter.raw()), `${label}: neither the secret nor the word Bearer is in anything the squatter received`);
    check(allowed.some((request) => request.startsWith('POST ')) || !squatter.raw().includes('POST '), `${label}: and no POST (no shutdown request, no ticket) reached it`);
  };
  const assertRefusal = (run, { squatter, stale, stalePid }, label, prefix) => {
    equal(run.code, 1, `${label}: exits with 1\n${run.output}`);
    check(new RegExp(`${prefix}.*Port ${stale.port} is held by process ${squatter.pid}, not by the Hub \\(process ${stalePid}\\) that wrote hub-session\\.json.* The session secret was not sent\\.`, 's').test(run.output), `${label}: says which process holds the port and that no secret was sent`, run.output);
    check(!run.output.includes(stale.secret), `${label}: the output never carries the secret`);
    check(fs.existsSync(sessionFile(stale.stateDir)), `${label}: the stale session file is left alone`);
  };

  assertRefusal(stopRun, scenarios.stop, 'Stop-ChatMcpHub.ps1 against a squatter on 127.0.0.1', '\\[CHATMCP-HUB\\] ');
  check(/Could not finish: reading the verified Hub session/.test(stopRun.output), 'Stop-ChatMcpHub.ps1: and it says where it stopped');
  assertNothingSent(scenarios.stop, 'Stop-ChatMcpHub.ps1', ['GET /api/health']);
  check(scenarios.stop.squatter.requests().some((request) => request.path === '/api/health'), 'Stop-ChatMcpHub.ps1: the squatter was consulted (it answered the health check), so the refusal is the listener check and not a missing Hub');

  assertRefusal(smokeRun, scenarios.smoke, 'Run-StudioSmoke.ps1 against a squatter on 127.0.0.1', 'Smoke test stopped: ');
  assertNothingSent(scenarios.smoke, 'Run-StudioSmoke.ps1', []);

  assertRefusal(gatewayRun, scenarios.gateway, 'Test-Gateway-ViaHub.ps1 against a squatter on the dual-stack wildcard', 'Gateway test failed: ');
  assertNothingSent(scenarios.gateway, 'Test-Gateway-ViaHub.ps1', ['GET /api/health']);
  check(scenarios.gateway.squatter.requests().some((request) => request.path === '/api/health'), 'Test-Gateway-ViaHub.ps1: the squatter answered the health check, so the refusal is the listener check');

  equal(nobodyRun.code, 1, `Run-StudioSmoke.ps1 with a stale file and nobody on the port: exits with 1\n${nobodyRun.output}`);
  check(new RegExp(`Smoke test stopped: Nothing listens on port ${scenarios.nobody.port}, although hub-session\\.json says that the Hub \\(process ${process.pid}\\) runs there.* The session secret was not sent\\.`).test(nobodyRun.output), 'Run-StudioSmoke.ps1: a stale file with nobody on the port is refused with that explanation', nobodyRun.output);

  // A Hub that predates the secret has no `auth` in its health: the script uses the older flow (session token, then shutdown), which
  // sends no secret, and does not consult the listener. The squatter acknowledges the shutdown and exits, so the flow runs to its end.
  assertNothingSent(scenarios.legacy, 'Stop-ChatMcpHub.ps1 against a Hub that predates the secret', ['GET /api/health', 'GET /api/state', 'POST /api/hub/shutdown']);
  check(scenarios.legacy.squatter.requests().some((request) => request.method === 'POST' && request.path === '/api/hub/shutdown'), 'Stop-ChatMcpHub.ps1: the older flow got as far as the shutdown request, without a secret');
  check(legacyRun.code === 0 && /Stopped\./.test(legacyRun.output) && !/is held by process/.test(legacyRun.output), 'Stop-ChatMcpHub.ps1: and it ended with "Stopped", without the listener check (there was no secret to protect)', legacyRun.output);

  // 4. the control: a recycled process id
  check(scenarios.control.squatter.requests().some((request) => request.method === 'GET' && request.path === '/api/state' && request.headers.authorization === `Bearer ${scenarios.control.stale.secret}`), 'LIMIT (RR-4 residual): when the stale file names the squatter\'s own process id, the lookup agrees and the bearer reaches it; a process-id check cannot tell a recycled id from the Hub, and this shows that the harness sees a leak from PowerShell');
  check(!/Smoke test stopped/.test(controlRun.output), 'and the script did not refuse in that case');

  // localhost
  if (v6) {
    check(/Read state without logging secrets\s+PASS/.test(localhostRun.output), 'Run-StudioSmoke.ps1 with http://localhost:port reached the Hub on 127.0.0.1 and was let in', localhostRun.output);
    equal(v6.requests(), [], 'a squatter on ::1 at the same port received no request at all: the name localhost was not used for the connection');
    check(!v6.raw().includes(hub.secret) && !/Bearer/i.test(v6.raw()), 'and nothing of the secret');
  } else console.log('  --  this machine has no IPv6 loopback: the localhost check was not run');

  // 5. the positive case
  check(!/Smoke test stopped|is held by process/.test(smokeOk.output), 'Run-StudioSmoke.ps1 against a real Hub: no refusal', smokeOk.output);
  check(/Hub health and version\s+PASS/.test(smokeOk.output) && /Read state without logging secrets\s+PASS/.test(smokeOk.output), 'Run-StudioSmoke.ps1 against a real Hub: health, then the state request with the secret, pass', smokeOk.output);
  check(/API refuses callers without the Hub session secret\s+PASS/.test(smokeOk.output), 'and the Hub still refuses a caller without it', smokeOk.output);
  check(!/is held by process|Nothing listens|Cannot tell which process/.test(gatewayOk.output) && /API key\/model are not configured/.test(gatewayOk.output), 'Test-Gateway-ViaHub.ps1 against a real Hub: it got past the listener check and the authenticated state request (only the unconfigured model stops it)', gatewayOk.output);
  equal(stopOk.code, 0, `Stop-ChatMcpHub.ps1 against a real Hub: exits with 0\n${stopOk.output}`);
  check(/Stopped\./.test(stopOk.output) && !/is held by process/.test(stopOk.output), 'Stop-ChatMcpHub.ps1: the Hub was stopped through its shutdown route with the secret', stopOk.output);
  await waitFor(async () => !dedicated.running, { timeoutMs: 20_000, label: 'the stopped Hub to exit' });
  check(!dedicated.running, 'and its process has exited');

  console.log(`PASS: ${checks} checks - the three PowerShell scripts carry one listener check; its decision, a real squatter refused by each (no Authorization header, no secret, no Bearer received), the legacy flow, localhost, the recycled-id limit, and a real Hub passed`);
} finally {
  await harness.stopAll();
  for (const hub of hubs) hub.killTree();
  await sleep(300);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
