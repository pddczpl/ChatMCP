// Windows Sandbox SOURCE/CONFIG and Windows HOST-only fixture tests (Phase 1, PR 2).
// NO code here launches a Windows Sandbox guest; real guest isolation is BLOCKED.
//
// Tests:
//  1. Read-only host preflight and honest detection of virtualization/feature blockers
//  2. Validated CapabilityReport schema (osIsolated, denied network, ephemeral scope)
//  3. Synthetic execution request preparation (cryptographic nonce, schema)
//  4. Synthetic HOST fixture bounded execution under Job Object (optional, required in Windows CI)
//  5. Receipt transport verification (checksum, nonce, runId, bounds)
//  6. Host canary file isolation integrity
//  7. Negative security attack tests:
//     - Nonce mismatch rejection
//     - RunId mismatch rejection
//     - Checksum mismatch rejection
//     - Oversized receipt (> 5 MB) rejection
//     - Reparse point / symlink receipt rejection
//     - Missing receipt rejection
//     - Timeout kill enforcement
//     - Output byte bound truncation
//  8. Fail-closed registry dispatch when isolation backend is unavailable

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
  prepareExecutionRequest,
  readAndVerifyExecutionReceipt,
} from '../../lib/windows-sandbox-transport.mjs';
import {
  ExecutionBackend,
  ExecutionRegistry,
  validateExecutionRequest,
} from '../../lib/execution-contract.mjs';

let checks = 0;
const ok = (label) => {
  checks += 1;
  console.log(`  ok - ${label}`);
};

setTimeout(() => {
  console.error('FAIL: windows-sandbox smoke suite exceeded time budget');
  process.exit(2);
}, 60_000).unref();

const testBaseDir = path.join(os.tmpdir(), `chatmcp-sandbox-smoke-${Date.now()}`);
fs.mkdirSync(testBaseDir, { recursive: true });

export async function runSmokeTests() {
  try {
    console.log('# 1. Read-Only Host Preflight & Honest Blocker Detection');
    const preflight = await probeWindowsSandboxPreflight();
    assert.equal(typeof preflight.supported, 'boolean');
    assert.equal(typeof preflight.available, 'boolean');
    assert.equal(typeof preflight.osIsolated, 'boolean');
    assert.ok(Array.isArray(preflight.blockers));
    assert.ok(Array.isArray(preflight.remediations));

    if (process.platform === 'win32') {
      // On Windows 11 host: verify preflight detected environment honestly
      assert.ok(preflight.details.osCaption.length > 0, 'Detected OS caption');
      assert.ok(preflight.details.osBuild > 0, 'Detected OS build');
      assert.equal(preflight.details.osArch, 'x64', 'Detected 64-bit architecture');

      // On this specific development host, VT-x is disabled in firmware or WindowsSandbox.exe is missing
      if (!preflight.available) {
        assert.ok(preflight.blockers.length > 0, 'Blockers reported when unavailable');
        assert.ok(preflight.remediations.length > 0, 'Remediations provided for blockers');
        assert.equal(preflight.osIsolated, false, 'osIsolated is false when backend is unavailable');
      }
    }
    ok('Host preflight executed read-only and reported state honestly');

    console.log('# 2. Windows Sandbox Capability Report Schema');
    const capability = await probeWindowsSandboxCapability();
    assert.equal(capability.backend, 'windows-sandbox');
    assert.equal(capability.osIsolated, true); // Capability contract type
    assert.equal(capability.networkPolicy, 'denied');
    assert.equal(capability.writeScope, 'guest-ephemeral');
    assert.equal(capability.concurrency, 1);
    assert.ok(Array.isArray(capability.enforcedLimits));
    assert.ok(Array.isArray(capability.unsupportedLimits));
    assert.ok(capability.unsupportedLimits.includes('customEnv'));
    ok('CapabilityReport conforms strictly to Phase 1 specification');

    console.log('# 3. Synthetic Request Preparation & Cryptographic Nonce');
    const inputDir = path.join(testBaseDir, 'test-input');
    const outputDir = path.join(testBaseDir, 'test-output');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const runId = 'smoke-run-' + crypto.randomBytes(6).toString('hex');
    const prep = await prepareExecutionRequest({
      inputDirectory: inputDir,
      runId,
      command: 'cmd.exe',
      args: ['/c', 'echo CHATMCP_SANDBOX_SMOKE_OK'],
      timeoutSeconds: 10,
      maxOutputBytes: 1024,
    });

    assert.equal(prep.runId, runId);
    assert.equal(prep.nonce.length, 64, 'Nonce is 32 bytes hex (64 characters)');
    assert.ok(fs.existsSync(prep.requestPath), 'request.json written to input dir');

    const writtenReq = JSON.parse(fs.readFileSync(prep.requestPath, 'utf8'));
    assert.equal(writtenReq.runId, runId);
    assert.equal(writtenReq.nonce, prep.nonce);
    assert.equal(writtenReq.command, 'cmd.exe');
    ok('Execution request prepared with 256-bit cryptographic nonce');

    console.log('# 4. Host-only synthetic supervisor fixture (NOT Windows Sandbox guest)');
    const supervisorDll = path.resolve('CHATMCP-HUB/windows/sandbox/GuestSupervisor/bin/Debug/net10.0/GuestSupervisor.dll');
    let hasDotnet = false;
    try {
      execFileSync('dotnet', ['--version'], { stdio: 'ignore' });
      hasDotnet = true;
    } catch {
      // dotnet not in PATH
    }

    const hostNativeReady = hasDotnet && fs.existsSync(supervisorDll) && process.platform === 'win32';
    if (process.env.CHATMCP_REQUIRE_HOST_SUPERVISOR === '1' && !hostNativeReady) {
      throw new Error('Required Windows host fixture unavailable: build GuestSupervisor with .NET 10 first.');
    }
    if (hostNativeReady) {
      // Run GuestSupervisor against synthetic request
      execFileSync(
        'dotnet',
        [supervisorDll, '--host-fixture', '--request', prep.requestPath, '--output', outputDir],
        { encoding: 'utf8', windowsHide: true }
      );

      const receipt = await readAndVerifyExecutionReceipt({
        exportDirectory: outputDir,
        expectedRunId: runId,
        expectedNonce: prep.nonce,
        allowUntrustedHostFixture: true,
      });

      assert.equal(receipt.runId, runId);
      assert.equal(receipt.status, 'completed');
      assert.equal(receipt.exitCode, 0);
      assert.ok(receipt.stdout.includes('CHATMCP_SANDBOX_SMOKE_OK'));
      assert.equal(receipt.truncated, false);
      assert.ok(receipt.durationMs >= 0);
      ok('Host fixture produced a consistency-checked receipt (NOT an authenticated guest result)');

      console.log('# 5. Host Canary File Isolation Integrity');
      const canaryPath = path.join(testBaseDir, 'host-canary-secret.txt');
      const canaryContent = 'CRITICAL_HOST_TOKEN_' + crypto.randomBytes(8).toString('hex');
      fs.writeFileSync(canaryPath, canaryContent, 'utf8');

      // A harmless echo is NOT an access-denial test. Only verify that our host
      // fixture leaves unrelated synthetic files unchanged; guest denial is BLOCKED.
      const canaryRunId = 'canary-run-' + crypto.randomBytes(6).toString('hex');
      const canaryInputDir = path.join(testBaseDir, 'canary-input');
      const canaryOutputDir = path.join(testBaseDir, 'canary-output');
      fs.mkdirSync(canaryInputDir, { recursive: true });
      fs.mkdirSync(canaryOutputDir, { recursive: true });

      const canaryPrep = await prepareExecutionRequest({
        inputDirectory: canaryInputDir,
        runId: canaryRunId,
        command: 'cmd.exe',
        args: ['/c', 'echo ATTEMPT'],
        timeoutSeconds: 5,
        maxOutputBytes: 1024,
      });

      execFileSync(
        'dotnet',
        [supervisorDll, '--host-fixture', '--request', canaryPrep.requestPath, '--output', canaryOutputDir],
        { encoding: 'utf8', windowsHide: true }
      );

      // Verify host canary file remained completely untouched
      assert.equal(fs.readFileSync(canaryPath, 'utf8'), canaryContent, 'Host canary file was not modified');
      ok('Host fixture did not modify synthetic canary (no OS-isolation claim)');

      console.log('# 6. Timeout Bounded Execution');
      const timeoutRunId = 'timeout-run-' + crypto.randomBytes(6).toString('hex');
      const timeoutInputDir = path.join(testBaseDir, 'timeout-input');
      const timeoutOutputDir = path.join(testBaseDir, 'timeout-output');
      fs.mkdirSync(timeoutInputDir, { recursive: true });
      fs.mkdirSync(timeoutOutputDir, { recursive: true });

      const timeoutPrep = await prepareExecutionRequest({
        inputDirectory: timeoutInputDir,
        runId: timeoutRunId,
        command: 'powershell.exe',
        args: ['-NoProfile', '-Command', 'Start-Sleep -Seconds 5'],
        timeoutSeconds: 1, // 1 second timeout for a 5 second sleep
        maxOutputBytes: 1024,
      });

      try {
        execFileSync(
          'dotnet',
          [supervisorDll, '--host-fixture', '--request', timeoutPrep.requestPath, '--output', timeoutOutputDir],
          { encoding: 'utf8', windowsHide: true }
        );
      } catch {
        // Expected: Supervisor exits with code 1 when child process times out
      }

      const timeoutReceipt = await readAndVerifyExecutionReceipt({
        exportDirectory: timeoutOutputDir,
        expectedRunId: timeoutRunId,
        expectedNonce: timeoutPrep.nonce,
        allowUntrustedHostFixture: true,
      });

      assert.equal(timeoutReceipt.status, 'timed_out');
      assert.equal(timeoutReceipt.exitCode, null);
      assert.ok(timeoutReceipt.reasons.some((r) => r.includes('timeout')));
      ok('GuestSupervisor enforced timeout bound and terminated subprocess');

      console.log('# 7. Output Byte Limit Truncation');
      const truncRunId = 'trunc-run-' + crypto.randomBytes(6).toString('hex');
      const truncInputDir = path.join(testBaseDir, 'trunc-input');
      const truncOutputDir = path.join(testBaseDir, 'trunc-output');
      fs.mkdirSync(truncInputDir, { recursive: true });
      fs.mkdirSync(truncOutputDir, { recursive: true });

      const truncPrep = await prepareExecutionRequest({
        inputDirectory: truncInputDir,
        runId: truncRunId,
        command: 'powershell.exe',
        args: ['-NoProfile', '-Command', "Write-Output ('A' * 10000)"],
        timeoutSeconds: 5,
        maxOutputBytes: 1024, // 1 KB limit on 10 KB string
      });

      execFileSync(
        'dotnet',
        [supervisorDll, '--host-fixture', '--request', truncPrep.requestPath, '--output', truncOutputDir],
        { encoding: 'utf8', windowsHide: true }
      );

      const truncReceipt = await readAndVerifyExecutionReceipt({
        exportDirectory: truncOutputDir,
        expectedRunId: truncRunId,
        expectedNonce: truncPrep.nonce,
        allowUntrustedHostFixture: true,
      });

      assert.equal(truncReceipt.truncated, true);
      assert.ok(Buffer.byteLength(truncReceipt.stdout, 'utf8') <= 1024, 'Stdout bounded to maxOutputBytes');
      ok('GuestSupervisor bounded output byte limits and flagged truncated: true');
    } else {
      console.log('BLOCKED: Windows host fixture not run (missing Windows/.NET 10/built helper). No guest execution attempted.');
    }

    console.log('# 8. Negative Transport Attacks & Boundary Validation');
    const attackDir = path.join(testBaseDir, 'attack-output');
    fs.mkdirSync(attackDir, { recursive: true });

    // Attack A: Nonce mismatch
    {
      const rPath = path.join(attackDir, 'receipt.json');
      const fakeReceipt = {
        version: 1,
        runId: 'attack-run-1',
        nonce: 'TAMPERED_NONCE',
        status: 'completed',
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
      fs.writeFileSync(rPath, JSON.stringify(fakeReceipt));
      await assert.rejects(
        () => readAndVerifyExecutionReceipt({
          exportDirectory: attackDir,
          expectedRunId: 'attack-run-1',
          expectedNonce: 'ORIGINAL_NONCE',
        }),
        { code: 'nonce_mismatch' }
      );
      ok('Receipt rejected on nonce mismatch');
    }

    // Attack B: RunId mismatch
    {
      const rPath = path.join(attackDir, 'receipt.json');
      const fakeReceipt = {
        version: 1,
        runId: 'WRONG_RUN_ID',
        nonce: 'MATCHING_NONCE',
        status: 'completed',
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
      fs.writeFileSync(rPath, JSON.stringify(fakeReceipt));
      await assert.rejects(
        () => readAndVerifyExecutionReceipt({
          exportDirectory: attackDir,
          expectedRunId: 'EXPECTED_RUN_ID',
          expectedNonce: 'MATCHING_NONCE',
        }),
        { code: 'run_id_mismatch' }
      );
      ok('Receipt rejected on runId mismatch');
    }

    // Attack C: Checksum mismatch
    {
      const rPath = path.join(attackDir, 'receipt.json');
      const sPath = path.join(attackDir, 'receipt.sha256');
      const fakeReceipt = {
        version: 1,
        runId: 'check-run',
        nonce: 'CHECK_NONCE',
        status: 'completed',
        exitCode: 0,
        stdout: 'original',
      };
      fs.writeFileSync(rPath, JSON.stringify(fakeReceipt));
      fs.writeFileSync(sPath, '0000000000000000000000000000000000000000000000000000000000000000  receipt.json');
      await assert.rejects(
        () => readAndVerifyExecutionReceipt({
          exportDirectory: attackDir,
          expectedRunId: 'check-run',
          expectedNonce: 'CHECK_NONCE',
        }),
        { code: 'checksum_mismatch' }
      );
      ok('Receipt rejected on SHA256 checksum mismatch');
      fs.unlinkSync(sPath);
    }

    // Attack D: Oversized receipt file (> 5 MB)
    {
      const rPath = path.join(attackDir, 'receipt.json');
      // Create a 5.5 MB file
      const bigBuffer = Buffer.alloc(5.5 * 1024 * 1024, 0x20);
      fs.writeFileSync(rPath, bigBuffer);
      await assert.rejects(
        () => readAndVerifyExecutionReceipt({
          exportDirectory: attackDir,
          expectedRunId: 'big-run',
          expectedNonce: 'big-nonce',
        }),
        { code: 'oversized_receipt' }
      );
      ok('Receipt rejected when exceeding 5 MB maximum file ceiling');
    }

    // Attack E: Reparse point / symlink receipt
    {
      const symTarget = path.join(testBaseDir, 'real-receipt.json');
      fs.writeFileSync(symTarget, '{}');
      const rPath = path.join(attackDir, 'receipt.json');
      try { fs.unlinkSync(rPath); } catch {}

      let symlinkCreated = false;
      try {
        fs.symlinkSync(symTarget, rPath, 'file');
        symlinkCreated = true;
      } catch {
        // May require privileges without developer mode
      }

      if (symlinkCreated) {
        await assert.rejects(
          () => readAndVerifyExecutionReceipt({
            exportDirectory: attackDir,
            expectedRunId: 'sym-run',
            expectedNonce: 'sym-nonce',
          }),
          { code: 'unsafe_receipt' }
        );
        ok('Symlinked receipt.json rejected as unsafe reparse point');
        fs.unlinkSync(rPath);
      } else {
        console.log('BLOCKED: symlink receipt attack cannot run with current OS privileges');
      }
    }

    // Attack F: Missing receipt
    {
      const emptyDir = path.join(testBaseDir, 'empty-export');
      fs.mkdirSync(emptyDir, { recursive: true });
      await assert.rejects(
        () => readAndVerifyExecutionReceipt({
          exportDirectory: emptyDir,
          expectedRunId: 'missing-run',
          expectedNonce: 'missing-nonce',
        }),
        { code: 'missing_receipt' }
      );
      ok('Missing receipt rejected cleanly');
    }


    // Unknown/missing version, missing checksum and untrusted origins may never
    // be accepted as independent evidence that guest code executed safely.
    {
      const dir = path.join(testBaseDir,'receipt-origin-tests');
      fs.mkdirSync(dir,{recursive:true});
      const candidate = {
        version: 1, runId:'origin-run', nonce:'ORIGIN_NONCE', status:'completed',
        exitCode:0, stdout:'forged output', stderr:'',
        startedAt:new Date().toISOString(), completedAt:new Date().toISOString(),
        durationMs:0, truncated:false,
      };
      const receiptFile = path.join(dir,'receipt.json');
      const hashFile = path.join(dir,'receipt.sha256');
      const writePair = () => {
        const raw = JSON.stringify(candidate);
        fs.writeFileSync(receiptFile,raw);
        fs.writeFileSync(hashFile,crypto.createHash('sha256').update(raw).digest('hex')+'  receipt.json\n');
      };
      writePair();
      await assert.rejects(
        () => readAndVerifyExecutionReceipt({exportDirectory:dir,expectedRunId:candidate.runId,expectedNonce:candidate.nonce}),
        {code:'unverified_guest_origin'}
      );
      candidate.version=99;writePair();
      await assert.rejects(
        () => readAndVerifyExecutionReceipt({exportDirectory:dir,expectedRunId:candidate.runId,expectedNonce:candidate.nonce,allowUntrustedHostFixture:true}),
        {code:'unsupported_receipt_version'}
      );
      candidate.version=1;writePair();fs.unlinkSync(hashFile);
      await assert.rejects(
        () => readAndVerifyExecutionReceipt({exportDirectory:dir,expectedRunId:candidate.runId,expectedNonce:candidate.nonce,allowUntrustedHostFixture:true}),
        {code:'missing_receipt_checksum'}
      );
      ok('Forged checksum/nonce cannot authorize verified guest execution; version and checksum mandatory');
    }

    console.log('# 9. Fail-Closed Dispatch When Isolation Backend Unavailable');
    {
      class MockUnavailableSandboxBackend extends ExecutionBackend {
        constructor() {
          super('windows-sandbox');
        }
        async probe() {
          return capability; // probed capability with available: false on current host
        }
        async execute() {
          throw new Error('SHOULD_NEVER_BE_CALLED');
        }
        cancel() {
          return false;
        }
      }

      const registry = new ExecutionRegistry();
      registry.register(new MockUnavailableSandboxBackend());

      const req = validateExecutionRequest({
        runId: 'fail-closed-smoke-run',
        snapshotId: 'snap-smoke-1',
        checkId: 'chk-smoke-1',
        command: 'cmd.exe',
        args: ['/c', 'dir'],
        cwd: process.cwd(),
        backend: 'windows-sandbox',
        isolationRequired: true,
      });

      const receipt = await registry.dispatch(req);
      assert.equal(receipt.status, 'isolation_unavailable');
      assert.ok(
        receipt.reasons.some((r) => /virtualization|sandbox|unavailable|disabled|unsupported|platform/i.test(r)),
        `Reasons explain blocker: ${receipt.reasons.join('; ')}`
      );
      ok('Registry dispatch rejected with fail-closed isolation_unavailable when backend is unavailable');
    }

    console.log(`\nPASS: ${checks} portable/host-fixture checks; REAL WINDOWS SANDBOX GUEST ISOLATION: BLOCKED (not executed).`);
  } finally {
    try {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup errors
    }
  }
}

// Run immediately if executed as main module
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('CHATMCP-HUB/tests/windows-sandbox/smoke.mjs')) {
  runSmokeTests().catch((err) => {
    console.error('Smoke test failure:', err);
    process.exit(1);
  });
}
