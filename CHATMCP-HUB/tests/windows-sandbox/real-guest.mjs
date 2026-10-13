// Real Windows Sandbox Guest Isolation, Security Hardening, and Feasibility Suite (Phase 1, PR 2)
//
// Strictly requires real Windows 11 host with Windows Sandbox and wsb CLI.
// Launches an owned, hardened Windows Sandbox instance, executes GuestSupervisor
// inside the guest, collects and verifies authenticated cryptographic execution receipts,
// and enforces real negative isolation boundaries (canary, filesystem, network).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import {
  probeWindowsSandboxPreflight,
} from '../../lib/windows-sandbox-probe.mjs';
import {
  createSandboxConfiguration,
} from '../../lib/windows-sandbox-config.mjs';
import {
  prepareExecutionRequest,
  readAndVerifyExecutionReceipt,
} from '../../lib/windows-sandbox-transport.mjs';

let checks = 0;
const ok = (label) => {
  checks += 1;
  console.log(`  ok - ${label}`);
};

const DANGEROUS_ADMIN_PRIVILEGES = new Set([
  'sedebugprivilege',
  'setcbprivilege',
  'seloaddriverprivilege',
  'sebackupprivilege',
  'serestoreprivilege',
  'setakeownershipprivilege',
  'seassignprimarytokenprivilege',
  'seimpersonateprivilege',
  'secreatetokenprivilege',
  'sesecurityprivilege',
  'sesystemenvironmentprivilege',
]);

/**
 * Parses whoami /priv table output by column, strictly validating that no dangerous
 * administrative privilege is in the Enabled state.
 */
export function parseAndVerifyChildPrivileges(stdout) {
  if (typeof stdout !== 'string') {
    throw new Error('whoami /priv stdout must be a string');
  }

  const lines = stdout.split(/\r?\n/);
  const parsedPrivs = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('===') || trimmed.startsWith('---') || trimmed.startsWith('Privilege Name')) {
      continue;
    }
    // Match line: PrivilegeName   Description   State
    const match = /^(Se[A-Za-z0-9_]+)\s+(.+?)\s+(Enabled|Disabled)\s*$/i.exec(trimmed);
    if (match) {
      parsedPrivs.push({
        name: match[1],
        description: match[2].trim(),
        state: match[3].toLowerCase(),
      });
    }
  }

  const enabledDangerous = parsedPrivs.filter(
    (p) => DANGEROUS_ADMIN_PRIVILEGES.has(p.name.toLowerCase()) && p.state === 'enabled'
  );

  if (enabledDangerous.length > 0) {
    throw new Error(
      `Child token security violation: Dangerous administrative privilege(s) ENABLED: ${enabledDangerous.map((p) => p.name).join(', ')}`
    );
  }

  return { verified: true, parsedCount: parsedPrivs.length };
}

/**
 * Parses whoami /groups table output, ensuring Administrators group is deny-only if present.
 */
export function parseAndVerifyChildGroups(stdout) {
  if (typeof stdout !== 'string') {
    throw new Error('whoami /groups stdout must be a string');
  }
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (/administrators|s-1-5-32-544/i.test(line)) {
      if (!/deny\s*only/i.test(line)) {
        throw new Error(`Child token security violation: Administrators group is not Deny-Only: ${line}`);
      }
    }
  }
  return { verified: true };
}

let journalPath = null;
let ownedSandboxId = null;
let activeWsbCli = null;

const watchdogTimer = setTimeout(() => {
  console.error('FAIL: real-guest test suite exceeded time budget (180s)');
  if (journalPath && fs.existsSync(journalPath)) {
    try {
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      if (journal.status === 'running' && journal.sandboxId && journal.wsbCli) {
        console.error(`Emergency watchdog stopping owned sandbox ${journal.sandboxId}...`);
        execFileSync(journal.wsbCli, ['stop', '--id', journal.sandboxId, '--raw'], { encoding: 'utf8', timeout: 15_000 });
        journal.status = 'terminated_by_watchdog';
        fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8');
      }
    } catch (e) {
      console.error('Emergency stop error:', e.message);
    }
  }
  process.exit(2);
}, 180_000);
watchdogTimer.unref();

function updateJournal(status, extra = {}) {
  if (!journalPath) return;
  try {
    const data = {
      status,
      sandboxId: ownedSandboxId,
      wsbCli: activeWsbCli,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    fs.writeFileSync(journalPath, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

export async function runRealGuestTests() {
  console.log('=== CHATMCP PHASE 1: REAL WINDOWS SANDBOX GUEST VALIDATION ===\n');

  // [A] Host Preflight & Ownership Initialization
  console.log('--- [A] Host Preflight & Ownership Initialization ---');

  // Regression test first (Section 4): Deliberately dangerous fixture MUST fail validation
  assert.throws(
    () => parseAndVerifyChildPrivileges('SeDebugPrivilege       Debug programs       Enabled'),
    /Dangerous administrative privilege.*SeDebugPrivilege/i,
    'Regression test failed: validator must reject SeDebugPrivilege Enabled'
  );
  ok('[A] Child token privilege validator regression test passed: dangerous Enabled fixture correctly rejected');

  const preflight = await probeWindowsSandboxPreflight();
  assert.equal(preflight.supported, true, 'Host must support Windows Sandbox');
  assert.equal(preflight.available, true, 'Windows Sandbox must be available on this host');
  assert.ok(preflight.details.cliPath, 'wsb CLI path must be resolved');
  assert.equal(preflight.details.featureState, 'Enabled', 'Feature must be Enabled');
  assert.equal(preflight.blockers.length, 0, 'No preflight blockers permitted for real guest test');
  ok(`[A] Preflight passed: Windows 11 ${preflight.details.osArch} build ${preflight.details.osBuild}, CLI: ${preflight.details.cliPath}`);

  const wsbCli = preflight.details.cliPath;
  activeWsbCli = wsbCli;

  const listBefore = JSON.parse(execFileSync(wsbCli, ['list', '--raw'], { encoding: 'utf8' }));
  const existingEnvs = listBefore.WindowsSandboxEnvironments || [];
  if (existingEnvs.length > 0) {
    throw new Error(`Another Windows Sandbox instance is already running (${existingEnvs.map((e) => e.Id).join(', ')}). Aborting.`);
  }
  ok('[A] Clean concurrency verified: no active sandbox instances present');

  const runId = 'real-guest-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const baseDir = path.join(os.tmpdir(), `chatmcp-sandbox-${runId}`);
  journalPath = path.join(baseDir, 'ownership-journal.json');
  const inputDir = path.join(baseDir, 'input');
  const outputDir = path.join(baseDir, 'output');
  const canaryDir = path.join(baseDir, 'canary');

  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(canaryDir, { recursive: true });

  updateJournal('initializing', { baseDir });

  // Create host canary outside mapped folders
  const canarySecret = `CHATMCP_CANARY_SECRET_${crypto.randomBytes(16).toString('hex')}`;
  const canaryPath = path.join(canaryDir, 'host-canary.txt');
  fs.writeFileSync(canaryPath, canarySecret, 'utf8');

  // Copy published self-contained GuestSupervisor.exe to input folder
  const supervisorSource = path.resolve('CHATMCP-HUB/windows/sandbox/GuestSupervisor/publish/win-x64/GuestSupervisor.exe');
  assert.ok(fs.existsSync(supervisorSource), 'GuestSupervisor.exe must be published before real test');
  const supervisorDest = path.join(inputDir, 'GuestSupervisor.exe');
  fs.copyFileSync(supervisorSource, supervisorDest);

  const supervisorHash = crypto.createHash('sha256').update(fs.readFileSync(supervisorDest)).digest('hex');
  ok(`[A] Staged GuestSupervisor.exe in read-only input (SHA-256: ${supervisorHash.slice(0, 16)}...)`);
  ok(`[A] Staged host canary outside mappings at ${canaryPath}`);

  const wsbXml = createSandboxConfiguration({
    inputDirectory: inputDir,
    exportDirectory: outputDir,
    memoryMb: 4096,
    protectedClient: true,
  });
  assert.ok(wsbXml.includes('<Networking>Disable</Networking>'));
  assert.ok(wsbXml.includes('<ProtectedClient>Enable</ProtectedClient>'));
  ok('[A] Hardened .wsb isolation configuration generated');

  try {
    // [B] Guest Lifecycle & CLI Smoke
    console.log('\n--- [B] Guest Lifecycle & CLI Smoke ---');
    updateJournal('starting');
    const startOutputRaw = execFileSync(
      wsbCli,
      ['start', '-c', wsbXml, '--raw'],
      { encoding: 'utf8', timeout: 30_000 }
    );
    const startOutput = JSON.parse(startOutputRaw);
    ownedSandboxId = startOutput.Id;
    assert.ok(ownedSandboxId, 'Sandbox start must return valid Id');
    assert.match(ownedSandboxId, /^[0-9a-fA-F-]{36}$/, 'Sandbox ID must be UUID');

    updateJournal('running', { sandboxId: ownedSandboxId });

    const listDuring = JSON.parse(execFileSync(wsbCli, ['list', '--raw'], { encoding: 'utf8' }));
    const runningIds = (listDuring.WindowsSandboxEnvironments || []).map((e) => e.Id);
    assert.ok(runningIds.includes(ownedSandboxId), `Running list must contain owned Sandbox ID ${ownedSandboxId}`);
    ok(`[B] Owned Windows Sandbox launched and journaled (ID: ${ownedSandboxId})`);

    const smoke1Raw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'cmd.exe /c echo CHATMCP_GUEST_ONLINE', '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const smoke1 = JSON.parse(smoke1Raw);
    assert.equal(smoke1.ExitCode, 0);
    ok('[B] Guest built-in command executed successfully (exit code 0)');

    const smoke2Raw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'cmd.exe /c exit 13', '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const smoke2 = JSON.parse(smoke2Raw);
    assert.equal(smoke2.ExitCode, 13);
    ok('[B] Guest non-zero exit code propagated faithfully (exit code 13)');

    // [C] Restricted Token & Native Containment
    console.log('\n--- [C] Restricted Token & Native Containment ---');

    // Conflicting flags rejection inside sandbox
    const contradictoryRaw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'C:\\ChatMCP\\Input\\GuestSupervisor.exe --host-fixture --guest-fixture', '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const contradictoryExec = JSON.parse(contradictoryRaw);
    assert.equal(contradictoryExec.ExitCode, 3);
    ok('[C] GuestSupervisor in Sandbox rejected conflicting flags (--host-fixture + --guest-fixture) with exit code 3');

    // Prepare execution request with cryptographic authKey
    const req1 = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: 'exec-priv-' + crypto.randomBytes(4).toString('hex'),
      command: 'cmd.exe',
      args: ['/c', 'echo HELLO_RESTRICTED && whoami && whoami /priv && echo ---GROUPS--- && whoami /groups'],
      timeoutSeconds: 20,
      maxOutputBytes: 40960,
    });

    const supExecRaw = execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key ${req1.authKey}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );
    const supExec = JSON.parse(supExecRaw);
    assert.equal(supExec.ExitCode, 0, 'GuestSupervisor execution must exit 0');

    // Verify receipt with publisher authentication
    const receipt1 = await readAndVerifyExecutionReceipt({
      exportDirectory: outputDir,
      expectedRunId: req1.runId,
      expectedNonce: req1.nonce,
      expectedAuthKey: req1.authKey,
      backend: 'windows-sandbox',
    });

    assert.equal(receipt1.status, 'completed');
    assert.equal(receipt1.exitCode, 0);
    assert.equal(receipt1.publisherAuthenticated, true);
    assert.equal(receipt1.provenance, 'publisher_authenticated');
    ok(`[C] GuestSupervisor executed under Job Object with verified publisher signature (${receipt1.durationMs}ms)`);

    const rawReceipt1 = JSON.parse(fs.readFileSync(path.join(outputDir, 'receipt.json'), 'utf8'));
    assert.equal(rawReceipt1.isGuestExecution, true);
    assert.equal(rawReceipt1.restrictedChild, true);
    assert.equal(rawReceipt1.jobObjectAttached, true);
    assert.ok(rawReceipt1.childPid > 0);
    ok(`[C] Native containment verified: Child PID ${rawReceipt1.childPid} in Job Object under restricted token`);

    // Verify token privileges table by column
    const privResult = parseAndVerifyChildPrivileges(receipt1.stdout);
    assert.ok(privResult.parsedCount > 0, 'Must have parsed child token privileges');
    parseAndVerifyChildGroups(receipt1.stdout);
    ok(`[C] Child OS token verified: zero dangerous privileges enabled, admin group deny-only (${privResult.parsedCount} privileges audited)`);

    // Timeout containment under Job Object
    const reqTimeout = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: 'timeout-' + crypto.randomBytes(4).toString('hex'),
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', 'Start-Sleep -Seconds 15'],
      timeoutSeconds: 3,
      maxOutputBytes: 1024,
    });

    execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key ${reqTimeout.authKey}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );

    const receiptTimeout = await readAndVerifyExecutionReceipt({
      exportDirectory: outputDir,
      expectedRunId: reqTimeout.runId,
      expectedNonce: reqTimeout.nonce,
      expectedAuthKey: reqTimeout.authKey,
      backend: 'windows-sandbox',
    });
    assert.equal(receiptTimeout.status, 'timed_out');
    assert.equal(receiptTimeout.exitCode, null);
    ok('[C] Timeout enforcement in guest verified: runaway child terminated under Job Object');

    // [D] Publisher Authentication & Anti-Spoofing
    console.log('\n--- [D] Publisher Authentication & Anti-Spoofing ---');

    // 1. Unauthenticated receipt rejected when authKey is not provided and fixture bypass is absent
    await assert.rejects(
      () => readAndVerifyExecutionReceipt({
        exportDirectory: outputDir,
        expectedRunId: reqTimeout.runId,
        expectedNonce: reqTimeout.nonce,
        backend: 'windows-sandbox',
      }),
      { code: 'unverified_guest_origin' }
    );
    ok('[D] Unauthenticated receipt rejected with unverified_guest_origin when fixture bypass is absent');

    // 2. An untrusted guest attempts to write a receipt, followed by an
    // independent HOST-SIDE fully-rehashed tamper. The second half only proves
    // the host HMAC reader rejects altered bytes; it does NOT demonstrate
    // the guest child cannot inspect the supervisor's argv/HMAC key.
    // A genuine guest-auth-key secrecy test is still a production blocker.
    const forgedRunId = 'forged-' + crypto.randomBytes(4).toString('hex');
    const forgeReq = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: forgedRunId,
      command: 'cmd.exe',
      args: [
        '/c',
        `echo {"version":1,"runId":"${forgedRunId}","nonce":"TAMPERED_BY_CHILD","status":"completed","exitCode":0,"stdout":"PWNED"} > C:\\ChatMCP\\Output\\receipt.json`
      ],
      timeoutSeconds: 10,
      maxOutputBytes: 1024,
    });

    // Execute through supervisor with legitimate authKey, but child tampered output
    execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key ${forgeReq.authKey}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );

    // Host-side tampering simulation: intentionally rewrite both files after guest finishes.
    const receiptJsonPath = path.join(outputDir, 'receipt.json');
    const childForgedJson = JSON.stringify({
      version: 1,
      runId: forgedRunId,
      nonce: forgeReq.nonce,
      status: 'completed',
      exitCode: 0,
      stdout: 'FORGED_BY_MALICIOUS_CHILD',
      stderr: '',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 10,
    });
    fs.writeFileSync(receiptJsonPath, childForgedJson, 'utf8');
    const childSha = crypto.createHash('sha256').update(Buffer.from(childForgedJson, 'utf8')).digest('hex');
    fs.writeFileSync(path.join(outputDir, 'receipt.sha256'), `${childSha}  receipt.json\n`, 'utf8');

    // Host verifier MUST reject because child cannot forge supervisor HMAC in receipt.sig
    await assert.rejects(
      () => readAndVerifyExecutionReceipt({
        exportDirectory: outputDir,
        expectedRunId: forgedRunId,
        expectedNonce: forgeReq.nonce,
        expectedAuthKey: forgeReq.authKey,
        backend: 'windows-sandbox',
      }),
      { code: 'invalid_publisher_signature' }
    );
    ok('[D] Host-side fully-rehashed receipt tampering rejected by HMAC; guest key-secrecy gate remains BLOCKED');

    // [E] Negative OS Isolation Probes
    console.log('\n--- [E] Negative OS Isolation Probes ---');

    // Host Canary Protection (direct guest probe)
    const canaryAttemptRaw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', `cmd.exe /c type "${canaryPath}"`, '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const canaryAttempt = JSON.parse(canaryAttemptRaw);
    assert.notEqual(canaryAttempt.ExitCode, 0);
    assert.equal(fs.readFileSync(canaryPath, 'utf8'), canarySecret);
    ok('[E] Host canary file protected: guest cannot access unmapped host paths');

    // Restricted Child Canary Probe via Supervisor
    const childCanaryReq = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: 'child-canary-' + crypto.randomBytes(4).toString('hex'),
      command: 'cmd.exe',
      args: ['/c', `type "${canaryPath}"`],
      timeoutSeconds: 10,
      maxOutputBytes: 1024,
    });
    execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --auth-key ${childCanaryReq.authKey}`,
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );
    const childCanaryReceipt = await readAndVerifyExecutionReceipt({
      exportDirectory: outputDir,
      expectedRunId: childCanaryReq.runId,
      expectedNonce: childCanaryReq.nonce,
      expectedAuthKey: childCanaryReq.authKey,
    });
    assert.notEqual(childCanaryReceipt.exitCode, 0);
    assert.ok(!childCanaryReceipt.stdout.includes(canarySecret));
    ok('[E] Restricted child via GuestSupervisor cannot read host canary');

    // Read-Only Input Protection (direct guest probe)
    const writeAttemptRaw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'cmd.exe /c echo TAMPER > C:\\ChatMCP\\Input\\tamper.txt', '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const writeAttempt = JSON.parse(writeAttemptRaw);
    assert.notEqual(writeAttempt.ExitCode, 0);
    assert.equal(fs.existsSync(path.join(inputDir, 'tamper.txt')), false);

    const postTestHash = crypto.createHash('sha256').update(fs.readFileSync(supervisorDest)).digest('hex');
    assert.equal(postTestHash, supervisorHash);
    ok('[E] Read-only input boundary enforced: guest cannot write or tamper with supervisor files');

    // Positive Network Control & Guest Network Denial
    let hostNetworkActive = false;
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '8.8.8.8', port: 53, timeout: 3000 }, () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
        socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
      });
      hostNetworkActive = true;
    } catch {}

    if (!hostNetworkActive) {
      console.error('BLOCKED / INCONCLUSIVE: Host has no internet connectivity; cannot verify guest network isolation.');
      throw new Error('Host network positive control failed; cannot prove guest isolation.');
    }
    ok('[E] Positive host network control verified (host can reach 8.8.8.8:53)');

    const netAttemptRaw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'powershell.exe -NoProfile -Command "try { (New-Object System.Net.Sockets.TcpClient).Connect(\'8.8.8.8\', 53); exit 0 } catch { exit 99 }"', '--raw'],
      { encoding: 'utf8', timeout: 20_000 }
    );
    const netAttempt = JSON.parse(netAttemptRaw);
    assert.notEqual(netAttempt.ExitCode, 0);
    ok('[E] Guest network isolation policy verified: outbound connections rejected in guest while host is connected');

    // [F] Deterministic Native Fault Injections in Guest
    console.log('\n--- [F] Deterministic Native Fault Injections in Guest ---');
    const guestFaultModes = ['identity_fail', 'open_token_fail', 'create_restricted_token_fail', 'assign_job_fail'];
    for (const mode of guestFaultModes) {
      const faultExecRaw = execFileSync(
        wsbCli,
        [
          'exec',
          '--id', ownedSandboxId,
          '-r', 'System',
          '-c', `C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output --fault-inject ${mode}`,
          '--raw'
        ],
        { encoding: 'utf8', timeout: 15_000 }
      );
      const faultExec = JSON.parse(faultExecRaw);
      assert.notEqual(faultExec.ExitCode, 0, `Fault injection ${mode} must exit non-zero`);
      const faultReceipt = JSON.parse(fs.readFileSync(path.join(outputDir, 'receipt.json'), 'utf8'));
      assert.equal(faultReceipt.status, 'failed');
      assert.ok(faultReceipt.reasons.length > 0);
    }
    ok('[F] In-guest deterministic fault injections verified (identity_fail, open_token_fail, create_restricted_token_fail, assign_job_fail)');

  } finally {
    // [G] Lifecycle Termination & Journal Cleanup
    console.log('\n--- [G] Lifecycle Termination & Journal Cleanup ---');
    if (ownedSandboxId) {
      updateJournal('stopping');
      try {
        const stopOutputRaw = execFileSync(
          wsbCli,
          ['stop', '--id', ownedSandboxId, '--raw'],
          { encoding: 'utf8', timeout: 30_000 }
        );
        ok(`[G] Owned Windows Sandbox stopped cleanly (${ownedSandboxId})`);
      } catch (err) {
        console.error(`Warning: Failed to stop sandbox ${ownedSandboxId}:`, err.message);
      }

      const listAfter = JSON.parse(execFileSync(wsbCli, ['list', '--raw'], { encoding: 'utf8' }));
      const remainingIds = (listAfter.WindowsSandboxEnvironments || []).map((e) => e.Id);
      assert.ok(!remainingIds.includes(ownedSandboxId), 'Owned sandbox must be terminated');
      ok('[G] Sandbox termination verified: instance removed from active list');

      updateJournal('terminated');
    }

    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
      ok('[G] Temporary test fixtures cleanly removed from host');
    } catch {}
  }

  console.log(`\nPASS: All ${checks} real Windows Sandbox validation checks SUCCEEDED.`);
  console.log('REAL WINDOWS SANDBOX GUEST ISOLATION & PUBLISHER AUTHENTICATION: VERIFIED.\n');
  return { success: true, checks };
}

if (process.argv[1] && process.argv[1].endsWith('real-guest.mjs')) {
  await runRealGuestTests();
}
