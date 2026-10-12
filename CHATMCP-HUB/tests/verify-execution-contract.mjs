// Tests for ExecutionBackend contracts, capability reports, and fail-closed dispatch (Phase 1, PR 1).
//
// Verifies:
//  1. Unknown backend
//  2. Missing backend
//  3. Unavailable Windows provider
//  4. Stale capability report
//  5. Isolation-required dispatch rejection
//  6. Unsupported required resource limit
//  7. Invalid execution request
//  8. Revoked permissions
//  9. Cancellation lifecycle
// 10. Host execution spawner is NEVER called on fail-closed rejections (spy verification)
// 11. Status API matches actual execution backend
// 12. Existing host-review behavior has no regression

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  ExecutionBackend,
  HostExecutionBackend,
  WindowsSandboxPlaceholderBackend,
  ExecutionRegistry,
  createDefaultExecutionRegistry,
  validateCapabilityReport,
  validateExecutionRequest,
  validateExecutionReceipt,
  DEFAULT_EXECUTION_LIMITS,
} from '../lib/execution-contract.mjs';
import { SandboxEngine } from '../lib/sandbox-engine.mjs';
import { ShellRunner } from '../lib/shell-runner.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { PermissionGate } from '../lib/permissions.mjs';
import { delay } from '../lib/runtime.mjs';

let checks = 0;
const ok = (label) => {
  checks += 1;
  console.log(`  ok - ${label}`);
};

setTimeout(() => {
  console.error('FAIL: verify-execution-contract exceeded time budget');
  process.exit(2);
}, 60_000).unref();

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-exec-contract-'));
const work = path.join(root, 'work');
const state = path.join(root, 'state');
await fs.mkdir(work, { recursive: true });
await fs.mkdir(state, { recursive: true });

try {
  const manager = { workspace: work, secrets: [] };
  const studio = new StudioWorkspace({ manager, directory: path.join(state, 'studio') });

  // Spy spawner to verify that host processes are NEVER spawned when dispatch fails closed.
  class SpySpawner {
    constructor() {
      this.calls = 0;
      this.spawnedCommands = [];
    }

    spawn(command, args, options) {
      this.calls += 1;
      this.spawnedCommands.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 99999 + this.calls;
      child.kill = () => true;

      // Asynchronous zero-exit simulation
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('spy output\n'));
        child.emit('close', 0);
      });
      return child;
    }
  }

  // Helper to build a clean registry with an optional spy spawner
  function createTestRegistry(spySpawner = null) {
    const runner = new ShellRunner({
      workspace: studio,
      stateDirectory: state,
      ...(spySpawner ? { spawner: (...args) => spySpawner.spawn(...args) } : {}),
    });
    return createDefaultExecutionRegistry({
      workspaceRoot: work,
      workspace: studio,
      shellRunner: runner,
    });
  }

  // ------------------------------------------------------------------ 1. Unknown backend
  {
    const spy = new SpySpawner();
    const registry = createTestRegistry(spy);

    await assert.rejects(
      () =>
        registry.dispatch({
          runId: 'run-1',
          snapshotId: 'snap-1',
          checkId: 'chk-1',
          command: 'echo test',
          backend: 'non-existent-backend',
          isolationRequired: false,
        }),
      (err) => {
        assert.equal(err.code, 'unknown_backend');
        assert.match(err.message, /non-existent-backend/);
        return true;
      }
    );

    assert.equal(spy.calls, 0, 'Host spawner must never be called for unknown backend');
    ok('1. Unknown backend rejected fail-closed with unknown_backend');
  }

  // ------------------------------------------------------------------ 2. Missing backend
  {
    const registry = new ExecutionRegistry();
    assert.equal(registry.get('host'), null);
    assert.equal(registry.has('host'), false);

    await assert.rejects(
      () => registry.getCapabilityReport('host'),
      (err) => err.code === 'unknown_backend'
    );

    await assert.rejects(
      () =>
        registry.dispatch({
          runId: 'run-2',
          snapshotId: 'snap-2',
          checkId: 'chk-2',
          command: 'echo test',
          backend: 'host',
          isolationRequired: false,
        }),
      (err) => err.code === 'unknown_backend'
    );

    ok('2. Missing backend from registry rejected fail-closed');
  }

  // ------------------------------------------------------------------ 3. Unavailable Windows provider
  {
    const placeholder = new WindowsSandboxPlaceholderBackend();
    const report = await placeholder.probe();

    assert.equal(report.backend, 'windows-sandbox');
    assert.equal(report.available, false);
    assert.equal(report.osIsolated, true);
    assert.equal(report.networkPolicy, 'denied');
    assert.equal(report.writeScope, 'guest-ephemeral');
    assert.ok(report.reasons.length > 0);

    const spy = new SpySpawner();
    const registry = new ExecutionRegistry();
    registry.register(placeholder);

    const receipt = await registry.dispatch({
      runId: 'run-3',
      snapshotId: 'snap-3',
      checkId: 'chk-3',
      command: 'echo sandbox',
      backend: 'windows-sandbox',
      isolationRequired: true,
    });

    assert.equal(receipt.status, 'isolation_unavailable');
    assert.equal(receipt.exitCode, null);
    assert.equal(receipt.backend, 'windows-sandbox');
    assert.ok(receipt.reasons.length > 0);
    assert.equal(spy.calls, 0, 'Host spawner must never be called for unavailable Windows provider');
    ok('3. Unavailable Windows provider reports available:false and fails closed');
  }

  // ------------------------------------------------------------------ 4. Stale capability report
  {
    let probeCount = 0;
    let isAvailable = true;

    class FlakyBackend extends ExecutionBackend {
      constructor() {
        super('flaky');
      }
      async probe() {
        probeCount += 1;
        return validateCapabilityReport({
          backend: 'flaky',
          available: isAvailable,
          osIsolated: false,
          platform: 'win32',
          networkPolicy: 'host-governed',
          writeScope: 'workspace-only',
          concurrency: 1,
          enforcedLimits: ['timeoutSeconds'],
          unsupportedLimits: ['maxMemoryMb'],
          reasons: isAvailable ? [] : ['Flaky backend became unavailable'],
          observedAt: new Date().toISOString(),
        });
      }
      async execute(request) {
        return validateExecutionReceipt({
          runId: request.runId,
          status: 'completed',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 5,
          backend: this.id,
          truncated: false,
        });
      }
    }

    let fakeNow = 1000;
    const registry = new ExecutionRegistry({
      maxCapabilityAgeMs: 50,
      now: () => fakeNow,
    });
    const flaky = new FlakyBackend();
    registry.register(flaky);

    const rep1 = await registry.getCapabilityReport('flaky');
    assert.equal(probeCount, 1);
    assert.equal(rep1.available, true);

    // Call within TTL: should reuse cache without re-probing
    fakeNow += 20;
    const rep2 = await registry.getCapabilityReport('flaky');
    assert.equal(probeCount, 1, 'Should reuse cached capability report within TTL');

    // Advance clock past TTL: should re-probe
    fakeNow += 100;
    isAvailable = false; // backend broke while report was stale
    const rep3 = await registry.getCapabilityReport('flaky');
    assert.equal(probeCount, 2, 'Should re-probe stale capability report after TTL');
    assert.equal(rep3.available, false);

    // Dispatching now fails closed
    await assert.rejects(
      () =>
        registry.dispatch({
          runId: 'run-stale',
          snapshotId: 'snap-stale',
          checkId: 'chk-stale',
          command: 'echo hi',
          backend: 'flaky',
          isolationRequired: false,
        }),
      (err) => err.code === 'backend_unavailable'
    );

    ok('4. Stale capability report triggers re-probe and fails closed when backend degrades');
  }

  // ------------------------------------------------------------------ 5. Isolation-required dispatch rejection
  {
    const spy = new SpySpawner();
    const registry = createTestRegistry(spy);

    // Explicitly target host with isolationRequired: true
    const receipt = await registry.dispatch({
      runId: 'run-iso-1',
      snapshotId: 'snap-iso-1',
      checkId: 'chk-iso-1',
      command: 'echo dangerous',
      backend: 'host',
      isolationRequired: true,
    });

    assert.equal(receipt.status, 'isolation_unavailable');
    assert.equal(receipt.exitCode, null);
    assert.equal(receipt.backend, 'host');
    assert.match(receipt.reasons[0], /Backend does not provide OS isolation/);
    assert.equal(spy.calls, 0, 'Host spawner must never be invoked when isolation is required but unavailable');

    // Omitting backend but requesting isolationRequired: true targets windows-sandbox placeholder (which is unavailable)
    const receipt2 = await registry.dispatch({
      runId: 'run-iso-2',
      snapshotId: 'snap-iso-2',
      checkId: 'chk-iso-2',
      command: 'echo dangerous-2',
      isolationRequired: true,
    });

    assert.equal(receipt2.status, 'isolation_unavailable');
    assert.equal(receipt2.exitCode, null);
    assert.equal(receipt2.backend, 'windows-sandbox');
    assert.equal(spy.calls, 0, 'No host fallback for isolation-required request');
    ok('5. Isolation-required dispatch strictly rejected with isolation_unavailable and 0 host spawns');
  }

  // ------------------------------------------------------------------ 6. Unsupported required resource limit
  {
    const spy = new SpySpawner();
    const registry = createTestRegistry(spy);

    // Host backend does not support OS-enforced memory or CPU limits
    await assert.rejects(
      () =>
        registry.dispatch({
          runId: 'run-lim-1',
          snapshotId: 'snap-lim-1',
          checkId: 'chk-lim-1',
          command: 'echo limits',
          backend: 'host',
          isolationRequired: false,
          requiredLimits: ['maxMemoryMb'],
        }),
      (err) => {
        assert.equal(err.code, 'unsupported_limit');
        assert.match(err.message, /maxMemoryMb/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        registry.dispatch({
          runId: 'run-lim-2',
          snapshotId: 'snap-lim-2',
          checkId: 'chk-lim-2',
          command: 'echo limits',
          backend: 'host',
          isolationRequired: false,
          requiredLimits: ['maxCpuCores'],
        }),
      (err) => {
        assert.equal(err.code, 'unsupported_limit');
        assert.match(err.message, /maxCpuCores/);
        return true;
      }
    );

    assert.equal(spy.calls, 0, 'Host spawner must never be called for unsupported required limit');
    ok('6. Unsupported required resource limit fails closed with unsupported_limit');
  }

  // ------------------------------------------------------------------ 7. Invalid execution request
  {
    const registry = createTestRegistry();

    // Missing runId
    assert.throws(
      () => validateExecutionRequest({ snapshotId: 's', checkId: 'c', command: 'x', isolationRequired: false }),
      (err) => err.code === 'invalid_request'
    );

    // Missing snapshotId
    assert.throws(
      () => validateExecutionRequest({ runId: 'r', checkId: 'c', command: 'x', isolationRequired: false }),
      (err) => err.code === 'invalid_request'
    );

    // Missing checkId
    assert.throws(
      () => validateExecutionRequest({ runId: 'r', snapshotId: 's', command: 'x', isolationRequired: false }),
      (err) => err.code === 'invalid_request'
    );

    // Missing command
    assert.throws(
      () => validateExecutionRequest({ runId: 'r', snapshotId: 's', checkId: 'c', isolationRequired: false }),
      (err) => err.code === 'invalid_request'
    );

    // Invalid timeoutSeconds type
    assert.throws(
      () => validateExecutionRequest({
        runId: 'r',
        snapshotId: 's',
        checkId: 'c',
        command: 'x',
        isolationRequired: false,
        limits: { timeoutSeconds: -5 },
      }),
      (err) => err.code === 'invalid_request'
    );

    // Non-boolean isolationRequired
    assert.throws(
      () => validateExecutionRequest({
        runId: 'r',
        snapshotId: 's',
        checkId: 'c',
        command: 'x',
        isolationRequired: 'true',
      }),
      (err) => err.code === 'invalid_request'
    );

    ok('7. Invalid execution requests strictly rejected by schema validation');
  }

  // ------------------------------------------------------------------ 8. Revoked permissions
  {
    const spy = new SpySpawner();
    const registry = createTestRegistry(spy);
    const gate = new PermissionGate({ manager, workspace: studio, timeout: 5000 });
    const localTools = new LocalTools({ workspace: studio, stateDirectory: state });
    gate.attachLocalTools(localTools);

    // Set gate to readonly mode: commands are disallowed by policy
    gate.configure({ mode: 'readonly' });

    const receipt = await registry.dispatch(
      {
        runId: 'run-perm-1',
        snapshotId: 'snap-perm-1',
        checkId: 'chk-perm-1',
        command: 'python app.py',
        backend: 'host',
        isolationRequired: false,
      },
      { permissionGate: gate }
    );

    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.exitCode, null);
    assert.match(receipt.reasons[0], /Chế độ Chỉ đọc/);
    assert.equal(spy.calls, 0, 'Host spawner must never be called when permission is denied');

    // Set execution policy to sandbox-only: host commands are forbidden
    gate.configure({ mode: 'review', executionPolicy: 'sandbox-only' });

    const receipt2 = await registry.dispatch(
      {
        runId: 'run-perm-2',
        snapshotId: 'snap-perm-2',
        checkId: 'chk-perm-2',
        command: 'echo blocked-by-sandbox-only',
        backend: 'host',
        isolationRequired: false,
      },
      { permissionGate: gate }
    );

    assert.equal(receipt2.status, 'blocked');
    assert.equal(receipt2.exitCode, null);
    assert.match(receipt2.reasons[0], /Sandbox-only: lệnh shell chạy trực tiếp trên máy host nên bị chặn/);
    assert.equal(spy.calls, 0, 'Host spawner must not be called under sandbox-only policy');
    ok('8. Revoked / disallowed permissions block execution without running host commands');
  }

  // ------------------------------------------------------------------ 9. Cancellation
  {
    const registry = createTestRegistry();

    // Abort before dispatch
    const controller1 = new AbortController();
    controller1.abort(new Error('Pre-aborted'));

    const receipt1 = await registry.dispatch(
      {
        runId: 'run-cancel-1',
        snapshotId: 'snap-cancel-1',
        checkId: 'chk-cancel-1',
        command: 'echo cancel',
        backend: 'host',
        isolationRequired: false,
      },
      { signal: controller1.signal }
    );

    assert.equal(receipt1.status, 'cancelled');
    assert.equal(receipt1.exitCode, null);
    assert.equal(receipt1.durationMs, 0);

    // Cancel via cancel(runId)
    const hostBackend = registry.get('host');
    const controller2 = new AbortController();
    hostBackend.activeRuns.set('run-active', controller2);
    assert.equal(await registry.cancel('run-active'), true);
    assert.equal(controller2.signal.aborted, true);
    assert.equal(await registry.cancel('non-existent'), false);

    ok('9. Cancellation lifecycle cleanly aborts without leaving orphaned runs');
  }

  // ------------------------------------------------------------------ 10. Spy verification: 0 host executions across all fail-closed modes
  {
    const spy = new SpySpawner();
    const registry = createTestRegistry(spy);

    const failClosedCases = [
      // 1. Unknown backend
      () =>
        registry.dispatch({
          runId: 'f1',
          snapshotId: 's',
          checkId: 'c',
          command: 'dir',
          backend: 'phantom',
          isolationRequired: false,
        }),
      // 2. Missing isolation targeting host
      () =>
        registry.dispatch({
          runId: 'f2',
          snapshotId: 's',
          checkId: 'c',
          command: 'dir',
          backend: 'host',
          isolationRequired: true,
        }),
      // 3. Missing isolation default routing to sandbox placeholder
      () =>
        registry.dispatch({
          runId: 'f3',
          snapshotId: 's',
          checkId: 'c',
          command: 'dir',
          isolationRequired: true,
        }),
      // 4. Unsupported required memory limit
      () =>
        registry.dispatch({
          runId: 'f4',
          snapshotId: 's',
          checkId: 'c',
          command: 'dir',
          backend: 'host',
          isolationRequired: false,
          requiredLimits: ['maxMemoryMb'],
        }),
    ];

    for (const testCase of failClosedCases) {
      try {
        await testCase();
      } catch (err) {
        // Expected rejection
      }
    }

    assert.equal(spy.calls, 0, 'CRITICAL: Host spawner was called 0 times across all fail-closed cases');
    ok('10. Confirmed 0 host spawner invocations across all fail-closed isolation and capability checks');
  }

  // ------------------------------------------------------------------ 11. Status API matches actual execution backend
  {
    const engine = new SandboxEngine({
      mode: 'host',
      workspaceRoot: work,
      workspace: studio,
    });

    const status = engine.status();
    assert.equal(status.mode, 'host');
    assert.equal(status.backend, 'host');
    assert.equal(status.available, true);
    assert.equal(status.osIsolated, false);
    assert.equal(status.platform, process.platform);
    assert.deepEqual(status.enforcedLimits, ['timeoutSeconds', 'maxOutputBytes']);
    assert.deepEqual(status.unsupportedLimits, ['maxMemoryMb', 'maxCpuCores']);
    assert.ok(status.backends.length >= 2, 'Must list both host and windows-sandbox placeholder');

    const sandboxBackendInfo = status.backends.find((b) => b.backend === 'windows-sandbox');
    assert.ok(sandboxBackendInfo);
    assert.equal(sandboxBackendInfo.available, false);
    assert.equal(sandboxBackendInfo.osIsolated, true);

    // Asynchronous probe matches status
    const probed = await engine.probe('host');
    assert.equal(probed.backend, 'host');
    assert.equal(probed.osIsolated, false);
    assert.equal(probed.available, true);

    // Executing with isolationRequired fails closed
    const isoResult = await engine.execute({
      command: 'echo isolated',
      isolationRequired: true,
    });
    assert.equal(isoResult.status, 'isolation_unavailable');
    assert.equal(isoResult.exitCode, null);

    ok('11. Status API accurately reports honest host capabilities and matches execution engine registry');
  }

  // ------------------------------------------------------------------ 12. Existing host-review behavior regression
  {
    const engine = new SandboxEngine({
      mode: 'host',
      workspaceRoot: work,
      workspace: studio,
    });

    // Run a standard safe command on the host (like node -e "console.log('hello host')")
    const result = await engine.execute({
      command: 'node -e "console.log(\'hello host\')"',
      cwd: '.',
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello host/);
    assert.equal(result.timedOut, false);
    assert.equal(result.status, 'completed');
    assert.ok(result.receipt);
    assert.equal(result.receipt.status, 'completed');
    assert.equal(result.receipt.exitCode, 0);

    ok('12. Existing host execution behavior works without regression');
  }

  console.log(`\nAll ${checks} verification checks passed successfully.`);
} finally {
  const resolved = await fs.realpath(root);
  const temp = await fs.realpath(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('chatmcp-exec-contract-')) {
    throw new Error('Unsafe test cleanup path');
  }
  await fs.rm(resolved, { recursive: true, force: true });
}
