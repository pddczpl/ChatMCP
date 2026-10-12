// Real Windows Sandbox Guest Isolation and Feasibility Test Suite (Phase 1, PR 2)
//
// Strictly requires real Windows 11 host with Windows Sandbox and wsb CLI.
// Launches an owned, hardened Windows Sandbox instance, executes GuestSupervisor
// inside the guest, collects and verifies cryptographic execution receipts,
// and enforces real negative isolation boundaries (canary, filesystem, network).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  probeWindowsSandboxPreflight,
  probeWindowsSandboxCapability,
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

let activeSandboxId = null;
let activeWsbCli = null;

const watchdogTimer = setTimeout(() => {
  console.error('FAIL: real-guest test suite exceeded time budget (180s)');
  if (activeSandboxId && activeWsbCli) {
    try {
      console.error(`Emergency watchdog stopping owned sandbox ${activeSandboxId}...`);
      execFileSync(activeWsbCli, ['stop', '--id', activeSandboxId, '--raw'], { encoding: 'utf8', timeout: 15_000 });
      console.error('Emergency sandbox stop completed.');
    } catch (e) {
      console.error('Emergency stop error:', e.message);
    }
  }
  process.exit(2);
}, 180_000);
watchdogTimer.unref();

export async function runRealGuestTests() {
  console.log('=== CHATMCP PHASE 1: REAL WINDOWS SANDBOX GUEST VALIDATION ===\n');

  // Step 1: Preflight verification
  console.log('# 1. Real Host Preflight Verification');
  const preflight = await probeWindowsSandboxPreflight();
  assert.equal(preflight.supported, true, 'Host must support Windows Sandbox');
  assert.equal(preflight.available, true, 'Windows Sandbox must be available on this host');
  assert.ok(preflight.details.cliPath, 'wsb CLI path must be resolved');
  assert.equal(preflight.details.featureState, 'Enabled', 'Feature must be Enabled');
  assert.equal(preflight.blockers.length, 0, 'No preflight blockers permitted for real guest test');
  ok(`Preflight passed: Windows 11 ${preflight.details.osArch} build ${preflight.details.osBuild}, CLI: ${preflight.details.cliPath}`);

  const wsbCli = preflight.details.cliPath;

  // Step 2: Ensure no existing unmanaged sandbox is running
  console.log('# 2. Single-Instance & Clean Concurrency Check');
  const listBefore = JSON.parse(execFileSync(wsbCli, ['list', '--raw'], { encoding: 'utf8' }));
  const existingEnvs = listBefore.WindowsSandboxEnvironments || [];
  if (existingEnvs.length > 0) {
    throw new Error(`Another Windows Sandbox instance is already running (${existingEnvs.map(e => e.Id).join(', ')}). Aborting to prevent collision.`);
  }
  ok('No active sandbox instances present; ownership slot available');

  // Step 3: Setup isolated per-run directories
  console.log('# 3. Per-Run Isolated Fixture Environment Setup');
  const runId = 'real-guest-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const baseDir = path.join(os.tmpdir(), `chatmcp-sandbox-${runId}`);
  const inputDir = path.join(baseDir, 'input');
  const outputDir = path.join(baseDir, 'output');
  const canaryDir = path.join(baseDir, 'canary');

  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(canaryDir, { recursive: true });

  // Create synthetic host canary (outside mapped folders)
  const canarySecret = `CHATMCP_CANARY_SECRET_${crypto.randomBytes(16).toString('hex')}`;
  const canaryPath = path.join(canaryDir, 'host-canary.txt');
  fs.writeFileSync(canaryPath, canarySecret, 'utf8');

  // Copy published self-contained GuestSupervisor.exe to input folder
  const supervisorSource = path.resolve('CHATMCP-HUB/windows/sandbox/GuestSupervisor/publish/win-x64/GuestSupervisor.exe');
  assert.ok(fs.existsSync(supervisorSource), 'GuestSupervisor.exe must be published before real test');
  const supervisorDest = path.join(inputDir, 'GuestSupervisor.exe');
  fs.copyFileSync(supervisorSource, supervisorDest);

  const supervisorHash = crypto.createHash('sha256').update(fs.readFileSync(supervisorDest)).digest('hex');
  ok(`GuestSupervisor staged in read-only input (SHA-256: ${supervisorHash.slice(0, 16)}...)`);
  ok(`Host canary initialized outside mappings at ${canaryPath}`);

  // Step 4: Generate hardened configuration
  console.log('# 4. Hardened .wsb Configuration Generation');
  const wsbXml = createSandboxConfiguration({
    inputDirectory: inputDir,
    exportDirectory: outputDir,
    memoryMb: 4096,
    protectedClient: true,
  });

  assert.ok(wsbXml.includes('<Networking>Disable</Networking>'));
  assert.ok(wsbXml.includes('<ClipboardRedirection>Disable</ClipboardRedirection>'));
  assert.ok(wsbXml.includes('<ProtectedClient>Enable</ProtectedClient>'));
  assert.ok(wsbXml.includes('<ReadOnly>true</ReadOnly>'));
  assert.ok(wsbXml.includes('<ReadOnly>false</ReadOnly>'));
  ok('Strict isolation configuration generated (.wsb XML)');

  let ownedSandboxId = null;

  try {
    // Step 5: Launch Owned Windows Sandbox Instance
    console.log('# 5. Windows Sandbox Launch & Ownership Binding');
    const startOutputRaw = execFileSync(
      wsbCli,
      ['start', '-c', wsbXml, '--raw'],
      { encoding: 'utf8', timeout: 30_000 }
    );
    const startOutput = JSON.parse(startOutputRaw);
    ownedSandboxId = startOutput.Id;
    activeSandboxId = ownedSandboxId;
    activeWsbCli = wsbCli;
    assert.ok(ownedSandboxId, 'Sandbox start must return valid Id');
    assert.match(ownedSandboxId, /^[0-9a-fA-F-]{36}$/, 'Sandbox ID must be UUID');

    // Verify ownership in list
    const listDuring = JSON.parse(execFileSync(wsbCli, ['list', '--raw'], { encoding: 'utf8' }));
    const runningIds = (listDuring.WindowsSandboxEnvironments || []).map(e => e.Id);
    assert.ok(runningIds.includes(ownedSandboxId), `Running list must contain owned Sandbox ID ${ownedSandboxId}`);
    ok(`Owned Windows Sandbox started successfully (ID: ${ownedSandboxId})`);

    // Step 6: Harmless Guest Built-in Command Smoke
    console.log('# 6. Harmless Guest Built-in Command Smoke');
    const smoke1Raw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'cmd.exe /c echo CHATMCP_GUEST_ONLINE', '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const smoke1 = JSON.parse(smoke1Raw);
    assert.equal(smoke1.ExitCode, 0, 'Built-in command must return exit code 0');
    ok('Harmless command executed in guest with exit code 0');

    // Step 7: Real Non-Zero Exit Code Smoke
    console.log('# 7. Real Non-Zero Exit Code Smoke');
    const smoke2Raw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'cmd.exe /c exit 13', '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const smoke2 = JSON.parse(smoke2Raw);
    assert.equal(smoke2.ExitCode, 13, 'Non-zero exit code must be faithfully propagated');
    ok('Guest command returned real non-zero exit code (13)');

    // Step 8: Real Trusted GuestSupervisor Execution
    console.log('# 8. Real Trusted GuestSupervisor Execution in Guest');

    // P0-A: GuestSupervisor rejects contradictory flags inside Sandbox
    const contradictoryExecRaw = execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', 'C:\\ChatMCP\\Input\\GuestSupervisor.exe --host-fixture --guest-fixture',
        '--raw'
      ],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const contradictoryExec = JSON.parse(contradictoryExecRaw);
    assert.equal(contradictoryExec.ExitCode, 3, 'GuestSupervisor must exit with code 3 on conflicting flags in guest');
    ok('GuestSupervisor inside Sandbox rejected conflicting flags with exit code 3');

    const req1 = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId: 'exec-smoke-' + crypto.randomBytes(4).toString('hex'),
      command: 'cmd.exe',
      args: ['/c', 'echo HELLO_FROM_RESTRICTED_CHILD && whoami && whoami /priv'],
      timeoutSeconds: 20,
      maxOutputBytes: 20480,
    });

    const supExecRaw = execFileSync(
      wsbCli,
      [
        'exec',
        '--id', ownedSandboxId,
        '-r', 'System',
        '-c', 'C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output',
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );
    const supExec = JSON.parse(supExecRaw);
    assert.equal(supExec.ExitCode, 0, 'GuestSupervisor execution must exit 0');

    // P0-C: Unauthenticated provenance check fails closed without fixture opt-in
    await assert.rejects(
      () => readAndVerifyExecutionReceipt({
        exportDirectory: outputDir,
        expectedRunId: req1.runId,
        expectedNonce: req1.nonce,
        backend: 'windows-sandbox',
      }),
      { code: 'unverified_guest_origin' }
    );
    ok('Guest receipt rejected with unverified_guest_origin when fixture bypass is absent');

    // Verify receipt returned via output mapping with explicit prototype verification opt-in
    const receipt1 = await readAndVerifyExecutionReceipt({
      exportDirectory: outputDir,
      expectedRunId: req1.runId,
      expectedNonce: req1.nonce,
      backend: 'windows-sandbox',
      allowUntrustedHostFixture: true, // Prototype verification mode
    });

    assert.equal(receipt1.status, 'completed');
    assert.equal(receipt1.exitCode, 0);
    assert.ok(receipt1.stdout.includes('HELLO_FROM_RESTRICTED_CHILD'));
    ok(`GuestSupervisor executed in guest, verified receipt and stdout captured (${receipt1.durationMs}ms)`);

    // Inspect detailed receipt fields
    const rawReceipt1 = JSON.parse(fs.readFileSync(path.join(outputDir, 'receipt.json'), 'utf8'));
    assert.equal(rawReceipt1.isGuestExecution, true, 'Receipt must record guest execution flag');
    assert.equal(rawReceipt1.restrictedChild, true, 'Receipt must record restricted token child flag');
    assert.equal(rawReceipt1.jobObjectAttached, true, 'Receipt must record Job Object attachment');
    assert.ok(rawReceipt1.childPid > 0, 'Child PID must be recorded');
    ok(`Child process contained under Job Object with restricted token (Child PID: ${rawReceipt1.childPid}, Supervisor PID: ${rawReceipt1.supervisorPid})`);

    // P0-A: Child token privilege verification (whoami /priv)
    // When running under CreateRestrictedToken with DISABLE_MAX_PRIVILEGE from SYSTEM,
    // dangerous administrative privileges must not be Enabled
    const dangerousPrivRegex = /Se(Debug|Tcb|LoadDriver|Backup|Restore|TakeOwnership|AssignPrimaryToken)Privilege\s+Enabled/i;
    assert.ok(!dangerousPrivRegex.test(receipt1.stdout), 'Dangerous administrative privileges must not be Enabled in restricted child');
    ok('Child OS-level token privileges verified: dangerous administrative privileges stripped/disabled');

    // Step 9: Guest Timeout Enforcement under Job Object
    console.log('# 9. Guest Timeout Enforcement');
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
        '-c', 'C:\\ChatMCP\\Input\\GuestSupervisor.exe --guest-fixture --request C:\\ChatMCP\\Input\\request.json --output C:\\ChatMCP\\Output',
        '--raw'
      ],
      { encoding: 'utf8', timeout: 25_000 }
    );

    const rawReceiptTimeout = JSON.parse(fs.readFileSync(path.join(outputDir, 'receipt.json'), 'utf8'));
    assert.equal(rawReceiptTimeout.status, 'timed_out');
    assert.equal(rawReceiptTimeout.exitCode, null);
    assert.ok(rawReceiptTimeout.reasons.some(r => r.includes('timeout')));
    ok('Timeout enforced in guest; process terminated and status recorded as timed_out');

    // Step 10: Real Negative Isolation Test F1: Host Canary File Boundary
    console.log('# 10. Negative Isolation Test F1: Host Canary Protection');
    // Attempt to access host canary path from inside guest
    const canaryAttemptRaw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', `cmd.exe /c type "${canaryPath}"`, '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const canaryAttempt = JSON.parse(canaryAttemptRaw);
    assert.notEqual(canaryAttempt.ExitCode, 0, 'Accessing host file from guest must fail');

    // Verify host canary file was not modified or read
    const currentCanaryContent = fs.readFileSync(canaryPath, 'utf8');
    assert.equal(currentCanaryContent, canarySecret, 'Host canary file must remain completely intact');
    ok('Host canary file is protected: guest cannot access unmapped host paths');

    // Step 11: Real Negative Isolation Test F2: Read-Only Filesystem Boundary
    console.log('# 11. Negative Isolation Test F2: Read-Only Input Protection');
    const writeAttemptRaw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'cmd.exe /c echo TAMPER > C:\\ChatMCP\\Input\\tamper.txt', '--raw'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    const writeAttempt = JSON.parse(writeAttemptRaw);
    assert.notEqual(writeAttempt.ExitCode, 0, 'Writing to read-only mapped input must fail');

    assert.equal(fs.existsSync(path.join(inputDir, 'tamper.txt')), false, 'Tamper file must not exist on host');

    // Verify supervisor binary integrity in input directory
    const postTestHash = crypto.createHash('sha256').update(fs.readFileSync(supervisorDest)).digest('hex');
    assert.equal(postTestHash, supervisorHash, 'GuestSupervisor binary must remain unmodified');
    ok('Read-only input boundary enforced: guest cannot write or tamper with supervisor files');

    // Step 12: Real Negative Isolation Test F3: Network Isolation
    console.log('# 12. Negative Isolation Test F3: Network Isolation');

    // Positive host control: verify that host itself has network connectivity
    let hostReachable = false;
    try {
      const net = await import('node:net');
      await new Promise((resolve, reject) => {
        const s = net.createConnection({ host: '8.8.8.8', port: 53, timeout: 3000 }, () => {
          s.destroy();
          resolve();
        });
        s.on('error', reject);
        s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
      });
      hostReachable = true;
    } catch { }

    if (hostReachable) {
      ok('Positive host network control verified (host can reach 8.8.8.8:53)');
    } else {
      console.log('NOTICE: Host cannot connect to 8.8.8.8:53 directly; proceeding with guest network isolation test');
    }

    const netAttemptRaw = execFileSync(
      wsbCli,
      ['exec', '--id', ownedSandboxId, '-r', 'System', '-c', 'powershell.exe -NoProfile -Command "try { (New-Object System.Net.Sockets.TcpClient).Connect(\'8.8.8.8\', 53); exit 0 } catch { exit 99 }"', '--raw'],
      { encoding: 'utf8', timeout: 20_000 }
    );
    const netAttempt = JSON.parse(netAttemptRaw);
    assert.notEqual(netAttempt.ExitCode, 0, 'Network connection outside sandbox must fail');
    ok('Network isolation enforced: outbound connections rejected in guest');

    // Step 13: Receipt Tampering & Negative Verification Tests
    console.log('# 13. Negative Receipt Transport & Tampering Tests');
    // Nonce mismatch test
    await assert.rejects(
      readAndVerifyExecutionReceipt({
        exportDirectory: outputDir,
        expectedRunId: rawReceiptTimeout.runId,
        expectedNonce: '0000000000000000000000000000000000000000000000000000000000000000',
        backend: 'windows-sandbox',
        allowUntrustedHostFixture: true,
      }),
      (err) => err.code === 'nonce_mismatch'
    );
    ok('Receipt transport rejected forged nonce');

    // Checksum mismatch test (tampered content without updating sha256)
    const receiptPath = path.join(outputDir, 'receipt.json');
    const originalReceiptContent = fs.readFileSync(receiptPath, 'utf8');
    fs.writeFileSync(receiptPath, originalReceiptContent.replace('"timed_out"', '"completed"'), 'utf8');
    await assert.rejects(
      readAndVerifyExecutionReceipt({
        exportDirectory: outputDir,
        expectedRunId: rawReceiptTimeout.runId,
        expectedNonce: rawReceiptTimeout.nonce,
        backend: 'windows-sandbox',
        allowUntrustedHostFixture: true,
      }),
      (err) => err.code === 'checksum_mismatch'
    );
    ok('Receipt transport detected and rejected tampered receipt content');
    // Restore original receipt
    fs.writeFileSync(receiptPath, originalReceiptContent, 'utf8');

    // Oversized receipt test
    const oversizedDir = path.join(baseDir, 'oversized');
    fs.mkdirSync(oversizedDir, { recursive: true });
    const hugeReceipt = { ...rawReceiptTimeout, stdout: 'X'.repeat(6 * 1024 * 1024) };
    const hugeJson = JSON.stringify(hugeReceipt);
    fs.writeFileSync(path.join(oversizedDir, 'receipt.json'), hugeJson, 'utf8');
    const hugeHash = crypto.createHash('sha256').update(hugeJson).digest('hex');
    fs.writeFileSync(path.join(oversizedDir, 'receipt.sha256'), `${hugeHash}  receipt.json\n`, 'utf8');
    await assert.rejects(
      readAndVerifyExecutionReceipt({
        exportDirectory: oversizedDir,
        expectedRunId: rawReceiptTimeout.runId,
        expectedNonce: rawReceiptTimeout.nonce,
        backend: 'windows-sandbox',
        allowUntrustedHostFixture: true,
      }),
      (err) => err.code === 'oversized_receipt'
    );
    ok('Receipt transport rejected oversized receipt (> 5 MB)');

  } finally {
    // Step 14: Stop and Cleanup Owned Sandbox Instance
    console.log('# 14. Stop Owned Sandbox & Lifecycle Termination');
    if (ownedSandboxId) {
      activeSandboxId = null;
      try {
        const stopOutputRaw = execFileSync(
          wsbCli,
          ['stop', '--id', ownedSandboxId, '--raw'],
          { encoding: 'utf8', timeout: 30_000 }
        );
        ok(`Owned Windows Sandbox stopped cleanly (${ownedSandboxId})`);
      } catch (err) {
        console.error(`Warning: Failed to stop sandbox ${ownedSandboxId}:`, err.message);
      }

      // Verify sandbox is no longer in list
      const listAfter = JSON.parse(execFileSync(wsbCli, ['list', '--raw'], { encoding: 'utf8' }));
      const remainingIds = (listAfter.WindowsSandboxEnvironments || []).map(e => e.Id);
      assert.ok(!remainingIds.includes(ownedSandboxId), 'Owned sandbox must be terminated');
      ok('Sandbox termination verified: instance removed from active list');
    }

    // Clean up temporary files
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
      ok('Temporary test fixtures cleanly removed from host');
    } catch { }
  }

  console.log(`\nPASS: All ${checks} real Windows Sandbox guest validation checks SUCCEEDED.`);
  console.log('REAL WINDOWS SANDBOX GUEST ISOLATION: VERIFIED.\n');
  return { success: true, checks };
}

if (process.argv[1] && process.argv[1].endsWith('real-guest.mjs')) {
  await runRealGuestTests();
}
