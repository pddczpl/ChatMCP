// Real Windows Sandbox End-to-End Coding Worker Diagnostic Harness (Phase 1, PR 13 Round 2)
//
// Exercises the complete integration path on real Windows 11 hardware:
// WorkerTestBroker -> ExecutionSnapshotStore -> ExecutionRegistry ->
// WindowsSandboxBackend -> LazyWindowsSandboxDriver -> real wsb guest ->
// WindowsSandboxPublisher.
//
// Test scenarios:
//  1. Disposable Node project with initial bug -> real guest test FAILS with signed TAP assertion failure.
//  2. Scripted model repairs implementation only (baseline test unchanged) -> new snapshot -> real guest PASS with signed TAP success.
//  3. Worker/grant revocation between capability probe and execution dispatch -> fail-closed rejection.
//  4. Stale active.lock quarantine detection.
//  5. Verified cleanup: Sandbox stopped cleanly, 0 orphan instances remaining.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { probeWindowsSandboxPreflight } from '../../lib/windows-sandbox-probe.mjs';
import { ExecutionSnapshotStore } from '../../lib/execution-snapshot-store.mjs';
import { ExecutionRegistry } from '../../lib/execution-contract.mjs';
import { WindowsSandboxBackend } from '../../lib/windows-sandbox-backend.mjs';
import { LazyWindowsSandboxDriver } from '../../lib/windows-sandbox-driver.mjs';
import { WindowsSandboxPublisher } from '../../lib/windows-sandbox-publisher.mjs';
import { WorkerTestBroker } from '../../lib/worker-test-broker.mjs';
import { reconcileOwnedGuestTestCleanup } from './owned-guest-cleanup.mjs';
import { SEALED_PROTOCOL } from '../../lib/windows-sandbox-sealed-receipt.mjs';

const sealedProbe=process.env.CHATMCP_PROBE_SEALED==='1';

let checks = 0;
const ok = (label) => {
  checks += 1;
  console.log(`  ok - ${label}`);
};

const watchdogController=new AbortController();
const watchdog=setTimeout(()=>{
  console.error('BLOCKED: real-coding-e2e exceeded 300s; cancelling owned execution.');
  watchdogController.abort(new Error('Diagnostic guest execution watchdog reached.'));
},300_000);
watchdog.unref();

export async function runRealCodingE2ETests() {
  console.log('=== CHATMCP PHASE 1: REAL WINDOWS SANDBOX CODING WORKER E2E HARNESS ===\n');

  // Preflight check
  console.log('--- [1] Environment Preflight & Staging Setup ---');
  const preflight = await probeWindowsSandboxPreflight();
  if (!preflight.available) {
    console.log('BLOCKED: Windows Sandbox is not available on this host:', preflight.reasons.join('; '));
    return { success: false, blocked: true, reasons: preflight.reasons };
  }
  const wsbCli = preflight.details.cliPath;
  const listBefore = JSON.parse(execFileSync(wsbCli, ['list', '--raw'], { encoding: 'utf8' }));
  if ((listBefore.WindowsSandboxEnvironments || []).length > 0) {
    throw new Error('Another Windows Sandbox is currently running. Tests require single-instance concurrency.');
  }
  ok('[1] Host preflight passed and single-instance clean concurrency verified');

  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-real-coding-e2e-'));
  const runtimeDir = path.join(testDir, 'runtime');
  const nodeToolchainDir = path.join(testDir, 'toolchain');
  const projectDir = path.join(testDir, 'project');
  const backendStateDir = path.join(testDir, 'backend-state');
  const snapshotStoreDir = path.join(testDir, 'snapshots');

  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(nodeToolchainDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });

  // 1. Stage GuestSupervisor.exe and its pinned SHA-256
  const supervisorSource = path.resolve('DATGOLD-HUB/windows/sandbox/GuestSupervisor/bin/Release/net10.0/win-x64/publish/GuestSupervisor.exe');
  if (!existsSync(supervisorSource)) {
    throw new Error(`GuestSupervisor.exe must be published at ${supervisorSource} before running real E2E.`);
  }
  const supervisorBytes = await fs.readFile(supervisorSource);
  const supervisorSha = crypto.createHash('sha256').update(supervisorBytes).digest('hex');
  await fs.writeFile(path.join(runtimeDir, 'GuestSupervisor.exe'), supervisorBytes);
  await fs.writeFile(path.join(runtimeDir, 'GuestSupervisor.exe.sha256'), `${supervisorSha}  GuestSupervisor.exe\n`);
  ok(`[1] Pinned GuestSupervisor staged with SHA-256 (${supervisorSha.slice(0, 16)}...)`);

  // 2. Stage host node.exe as offline toolchain
  const nodeSource = process.execPath;
  const nodeBytes = await fs.readFile(nodeSource);
  const nodeSha = crypto.createHash('sha256').update(nodeBytes).digest('hex');
  await fs.writeFile(path.join(nodeToolchainDir, 'node.exe'), nodeBytes);
  await fs.writeFile(path.join(nodeToolchainDir, 'node.exe.sha256'), `${nodeSha}  node.exe\n`);
  ok(`[1] Offline Node runtime toolchain staged with SHA-256 (${nodeSha.slice(0, 16)}...)`);

  // 3. Initialize disposable project with an intentional implementation bug
  await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'disposable-calc-worker',
    version: '1.0.0',
    type: 'module',
    scripts: {
      test: 'node --test',
    },
  }, null, 2));

  // Initial buggy code: subtraction instead of addition
  await fs.writeFile(path.join(projectDir, 'calc.mjs'), 'export function add(a, b) {\n  return a - b;\n}\n');

  // Baseline test: asserts add(2, 3) === 5
  await fs.writeFile(path.join(projectDir, 'calc.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './calc.mjs';

test('adds numbers correctly', () => {
  assert.equal(add(2, 3), 5);
});
`);
  ok('[1] Disposable test project initialized with intentional implementation bug');

  let managedDriver=null;
  let guestCleanupVerified=false;

  try {
    // 4. Assemble the execution stack
    console.log('\n--- [2] Stack Wiring & Check Discovery ---');
    const snapshotStore = new ExecutionSnapshotStore({ directory: snapshotStoreDir });
    const driver = new LazyWindowsSandboxDriver({
      preflight: probeWindowsSandboxPreflight,
      runtimeDirectory: runtimeDir,
      nodeToolchainDirectory: nodeToolchainDir,
      stateDirectory: path.join(backendStateDir, 'driver'),
      publicationProtocol:sealedProbe?SEALED_PROTOCOL:'diagnostic-hmac',
    });
    managedDriver=driver;

    // DIAGNOSTIC ONLY: hostAttested true is a trusted test-harness injection.
    // The sealed candidate needs independent full-threat-model review; legacy
    // HMAC still traverses a guest-readable mapping. Neither unlocks production.
    const publisher = new WindowsSandboxPublisher({ hostAttested: true });
    const backend = new WindowsSandboxBackend({
      stateDirectory: backendStateDir,
      driver,
      publisher,
      snapshotLookup: (id) => snapshotStore.lookup(id),
    });

    const registry = new ExecutionRegistry();
    registry.register(backend);

    const workerRecord = {
      id: 'worker-coding-1',
      workspace: projectDir,
      files: ['package.json', 'calc.mjs', 'calc.test.mjs'],
      checks: async () => ({
        suggested: [{ from: 'package.json', command: 'node --test' }],
      }),
      parentPolicy: 'autonomous',
      capabilities: { checksRun: true },
      revoked: false,
    };

    const broker = new WorkerTestBroker({
      resolveWorker: async (id) => (id === workerRecord.id ? workerRecord : null),
      registry,
      authorizeGrant: async () => ({ approved: true }),
      snapshotFactory: (opts) => snapshotStore.create(opts),
      releaseSnapshot: (id) => snapshotStore.release(id),
    });

    const checksDiscovered = await broker.discoverChecks({ workerId: workerRecord.id });
    assert.equal(checksDiscovered.length, 1);
    assert.equal(checksDiscovered[0].command, 'node --test');
    assert.equal(checksDiscovered[0].testFiles.length, 1);
    assert.equal(checksDiscovered[0].testFiles[0].path, 'calc.test.mjs');
    ok('[2] Worker checks discovered: pinned node --test bound to immutable package.json and calc.test.mjs');

    const grant = await broker.issueGrant({
      workerId: workerRecord.id,
      checkId: checksDiscovered[0].id,
      maxAttempts: 3,
    });
    assert.ok(grant.id);
    assert.equal(grant.maxAttempts, 3);
    ok(`[2] Owner authorized isolated check grant (ID: ${grant.id.slice(0, 8)}...)`);

    // 5. First Execution: Real Guest test with intentional bug -> must FAIL
    console.log('\n--- [3] First Real Guest Run: Initial Bug Assertion Failure ---');
    const attempt1 = await broker.requestCheck({
      workerId: workerRecord.id,
      checkId: checksDiscovered[0].id,
      grantId: grant.id,
      signal:watchdogController.signal,
    });

    console.log('Attempt 1 status:', attempt1.status, 'exitCode:', attempt1.exitCode);
    console.log('Attempt 1 reasons:', attempt1.reasons);
    console.log('Attempt 1 stderr preview:\n' + attempt1.stderrPreview);
    console.log('Attempt 1 stdout preview:\n' + attempt1.stdoutPreview);

    assert.equal(attempt1.attempt, 1);
    assert.equal(attempt1.backend, 'windows-sandbox');
    assert.equal(attempt1.status, 'failed');
    assert.equal(attempt1.exitCode, 1);
    assert.equal(attempt1.publisherAuthenticated, true);
    assert.ok(
      attempt1.stdoutPreview.includes('"type":"test:fail"') &&
      attempt1.stdoutPreview.includes('adds numbers correctly') &&
      attempt1.stdoutPreview.includes('-1 !== 5'),
      'Output must contain genuine Node test assertion failure'
    );
    ok(`[3] First real guest execution failed with signed diagnostic receipt (ExitCode: 1; G4 not attested)`);
    ok('[3] Publisher-authenticated receipt verified for failing run');

    // 6. Agent Code Repair: Update implementation only
    console.log('\n--- [4] Agent Implementation Repair & Snapshot Retest ---');
    await fs.writeFile(path.join(projectDir, 'calc.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
    ok('[4] Scripted repair applied to implementation (calc.mjs fixed; calc.test.mjs unchanged)');

    // Ensure host Sandbox process cleanup from attempt 1 has fully settled
    for (let wait = 0; wait < 20; wait++) {
      const pf = await probeWindowsSandboxPreflight();
      if (pf.available) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // 7. Second Execution: Retest with repaired code -> must PASS
    const attempt2 = await broker.requestCheck({
      workerId: workerRecord.id,
      checkId: checksDiscovered[0].id,
      grantId: grant.id,
      signal:watchdogController.signal,
    });

    console.log('Attempt 2 status:', attempt2.status, 'exitCode:', attempt2.exitCode);
    console.log('Attempt 2 reasons:', attempt2.reasons);
    console.log('Attempt 2 stderr preview:\n' + attempt2.stderrPreview);
    console.log('Attempt 2 stdout preview:\n' + attempt2.stdoutPreview);

    assert.equal(attempt2.attempt, 2);
    assert.equal(attempt2.backend, 'windows-sandbox');
    assert.equal(attempt2.status, 'completed');
    assert.equal(attempt2.exitCode, 0);
    assert.equal(attempt2.commandSucceeded, true);
    assert.equal(attempt2.publisherAuthenticated, true);
    assert.equal(attempt2.testOutcomeVerified,false);
    assert.deepEqual(attempt2.registeredTests,{tests:1,pass:1,fail:0});
    ok(`[4] Second real guest execution passed with signed diagnostic receipt (ExitCode: 0; G4 not attested)`);
    ok('[4] Pinned reporter observed one registered test; full adversarial test-result authenticity remains unproven');

    // 8. Adversarial & Fail-Closed Scenarios
    console.log('\n--- [5] Security Boundary & Adversarial Invariant Probes ---');

    // 8a. Test baseline modification: altering calc.test.mjs must invalidate grant
    await fs.writeFile(path.join(projectDir, 'calc.test.mjs'), '// altered test\n');
    await assert.rejects(
      () => broker.requestCheck({ workerId: workerRecord.id, checkId: checksDiscovered[0].id, grantId: grant.id }),
      /check|test|stale/i
    );
    ok('[5] Tampered test baseline rejected fail-closed');

    // Restore test file
    await fs.writeFile(path.join(projectDir, 'calc.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './calc.mjs';

test('adds numbers correctly', () => {
  assert.equal(add(2, 3), 5);
});
`);

    // 8b. Grant revocation during probe
    const checksNew = await broker.discoverChecks({ workerId: workerRecord.id });
    const grantRevoke = await broker.issueGrant({ workerId: workerRecord.id, checkId: checksNew[0].id, maxAttempts: 2 });
    broker.revokeGrant(grantRevoke.id);
    await assert.rejects(
      () => broker.requestCheck({ workerId: workerRecord.id, checkId: checksNew[0].id, grantId: grantRevoke.id }),
      { code: 'stale_grant' }
    );
    ok('[5] Revoked grant rejected before launch with stale_grant');

    // 8c. Worker parent policy revocation
    const grantRevokeWorker = await broker.issueGrant({ workerId: workerRecord.id, checkId: checksNew[0].id, maxAttempts: 2 });
    workerRecord.revoked = true;
    await assert.rejects(
      () => broker.requestCheck({ workerId: workerRecord.id, checkId: checksNew[0].id, grantId: grantRevokeWorker.id }),
      { code: 'worker_permission_denied' }
    );
    workerRecord.revoked = false;
    ok('[5] Revoked worker authority rejected fail-closed with worker_permission_denied');

    // 8d. Stale active.lock detection
    await fs.writeFile(path.join(backendStateDir, 'active.lock'), 'orphan');
    const capLocked = await backend.probe();
    assert.equal(capLocked.available, false);
    assert.ok(capLocked.reasons.some((r) => r.includes('reconciliation') || r.includes('lock')));
    await fs.rm(path.join(backendStateDir, 'active.lock'), { force: true });
    ok('[5] Stale active.lock quarantined without live owner; dispatch blocked');

  } finally {
    clearTimeout(watchdog);
    console.log('\n--- [6] Owner-Bound Guest Termination & Host Cleanup ---');
    // A new, unrelated Sandbox can appear while this diagnostic runs.
    // NEVER call wsb stop for every UUID returned by "wsb list".
    const cleanup=await reconcileOwnedGuestTestCleanup({
      driver:managedDriver,
      listRunning:()=>{
        const listing=JSON.parse(execFileSync(wsbCli,['list','--raw'],{
          encoding:'utf8',timeout:15000,
        }));
        return listing.WindowsSandboxEnvironments;
      },
    });
    assert.equal(cleanup.unownedStopped,0);
    guestCleanupVerified=cleanup.verified;
    ok('[6] Only positively owned guest UUIDs reconciled; no foreign sandbox stopped');
    if(guestCleanupVerified){
      await fs.rm(testDir,{recursive:true,force:true});
      ok('[6] Disposable host fixtures removed only after verified cleanup');
    }
  }

  console.log(`\nPASS: All ${checks} real coding worker E2E diagnostic checks SUCCEEDED.`);
  console.log('FUNCTIONAL DIAGNOSTIC PASS ONLY: '+(sealedProbe?'native sealed ExitCode transport exercised; independent G4 security acceptance remains required.':'legacy mapped HMAC key remains unsafe.')+' NO MERGE / RELEASE.\n');
  return { success:true, checks, productionAuthenticated:false, securityGate:'G4_BLOCKED',publicationProtocol:sealedProbe?SEALED_PROTOCOL:'diagnostic-hmac' };
}

if (process.argv[1] && process.argv[1].endsWith('real-coding-e2e.mjs')) {
  await runRealCodingE2ETests();
}
