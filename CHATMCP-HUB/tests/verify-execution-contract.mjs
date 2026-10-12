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
    assert.equal(status.writeScope, 'host-filesystem');
    assert.deepEqual(status.enforcedLimits, ['timeoutSeconds', 'maxOutputBytes']);
    assert.deepEqual(status.unsupportedLimits, ['maxMemoryMb', 'maxCpuCores', 'customEnv']);
    assert.ok(status.backends.length >= 2, 'Must list both host and windows-sandbox placeholder');

    const sandboxBackendInfo = status.backends.find((b) => b.backend === 'windows-sandbox');
    assert.ok(sandboxBackendInfo);
    assert.equal(sandboxBackendInfo.available, false);
    assert.equal(sandboxBackendInfo.osIsolated, true);
    assert.deepEqual(sandboxBackendInfo.enforcedLimits, []);
    assert.deepEqual(sandboxBackendInfo.unsupportedLimits, ['timeoutSeconds', 'maxOutputBytes', 'maxMemoryMb', 'maxCpuCores', 'customEnv']);

    // Asynchronous probe matches status
    const probed = await engine.probe('host');
    assert.equal(probed.backend, 'host');
    assert.equal(probed.osIsolated, false);
    assert.equal(probed.available, true);
    assert.equal(probed.writeScope, 'host-filesystem');

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
      trustedInternal: true,
    });

    // Run a standard safe command on the host
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

  // ------------------------------------------------------------------ 13. ShellRunner timeoutMs and limits conversion & sub-second rejection
  {
    class TrackingShellRunner {
      constructor() {
        this.lastOptions = null;
      }
      async run(options) {
        this.lastOptions = options;
        return {
          shell: 'bash',
          transport: 'argv',
          cwd: '.',
          pid: 10101,
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          lingering: false,
          stuck: false,
          durationMs: 40,
          stdout: 'tracking ok\n',
          stderr: '',
          truncated: { stdout: false, stderr: false },
          outputBytes: { stdout: 12, stderr: 0 },
        };
      }
    }

    const trackingRunner = new TrackingShellRunner();
    const hostBackend = new HostExecutionBackend({
      workspaceRoot: work,
      workspace: studio,
      shellRunner: trackingRunner,
    });
    const registry = new ExecutionRegistry();
    registry.register(hostBackend);

    // Timeout in seconds (45s) must be accurately converted to timeoutMs (45000ms)
    const receipt = await registry.dispatch(
      {
        runId: 'run-timeout-conv',
        snapshotId: 's',
        checkId: 'c',
        command: 'echo timing',
        backend: 'host',
        isolationRequired: false,
        limits: { timeoutSeconds: 45, maxOutputBytes: 4096 },
      },
      { trustedInternal: true }
    );

    assert.equal(receipt.status, 'completed');
    assert.equal(trackingRunner.lastOptions.timeoutMs, 45000, 'timeoutSeconds (45) must be converted to timeoutMs (45000)');
    assert.equal(trackingRunner.lastOptions.maxOutputBytes, 4096, 'maxOutputBytes must be passed to ShellRunner');

    // Sub-second timeout (< 1s) cannot be enforced by ShellRunner and must be rejected fail-closed
    await assert.rejects(
      () =>
        registry.dispatch(
          {
            runId: 'run-subsecond-fail',
            snapshotId: 's',
            checkId: 'c',
            command: 'echo quick',
            backend: 'host',
            isolationRequired: false,
            limits: { timeoutSeconds: 0.5 },
          },
          { trustedInternal: true }
        ),
      (err) => {
        assert.equal(err.code, 'unsupported_limit');
        assert.match(err.message, /sub-second timeout/);
        return true;
      }
    );

    // Per-call custom env overrides must be rejected fail-closed
    await assert.rejects(
      () =>
        registry.dispatch(
          {
            runId: 'run-env-unsupported',
            snapshotId: 's',
            checkId: 'c',
            command: 'echo env',
            backend: 'host',
            isolationRequired: false,
            env: { SECRET_OVERRIDE: 'custom' },
          },
          { trustedInternal: true }
        ),
      (err) => {
        assert.equal(err.code, 'unsupported_limit');
        assert.match(err.message, /custom environment overrides/);
        return true;
      }
    );

    ok('13. ShellRunner timeoutMs and maxOutputBytes enforced accurately; sub-second and env overrides fail closed');
  }

  // ------------------------------------------------------------------ 14. Output byte cap and UTF-8 multi-byte character boundary safety
  {
    const multiByteText = 'Xin chào ChatMCP: Tiếng Việt có dấu và biểu tượng cảm xúc 🎉 hoàn toàn hợp lệ!';
    const rawBytes = Buffer.byteLength(multiByteText, 'utf8');

    class OutputCapShellRunner {
      async run() {
        return {
          shell: 'bash',
          transport: 'argv',
          cwd: '.',
          pid: 20202,
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          lingering: false,
          stuck: false,
          durationMs: 20,
          stdout: multiByteText,
          stderr: '',
          truncated: { stdout: false, stderr: false },
          outputBytes: { stdout: rawBytes, stderr: 0 },
        };
      }
    }

    const hostBackend = new HostExecutionBackend({
      workspaceRoot: work,
      workspace: studio,
      shellRunner: new OutputCapShellRunner(),
    });
    const registry = new ExecutionRegistry();
    registry.register(hostBackend);

    // Byte limit set to 25 bytes (must cut cleanly without breaking multi-byte characters)
    const receipt = await registry.dispatch(
      {
        runId: 'run-unicode-cap',
        snapshotId: 's',
        checkId: 'c',
        command: 'echo unicode',
        backend: 'host',
        isolationRequired: false,
        limits: { maxOutputBytes: 25 },
      },
      { trustedInternal: true }
    );

    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.truncated, true);
    assert.ok(Buffer.byteLength(receipt.stdout, 'utf8') <= 25, 'Stdout byte length must not exceed 25 bytes');
    assert.ok(!receipt.stdout.includes('\uFFFD'), 'Must not contain UTF-8 replacement characters from broken multibyte sequences');

    // Also verify when ShellRunner itself reported truncation
    class TruncatedShellRunner {
      async run() {
        return {
          shell: 'bash',
          transport: 'argv',
          cwd: '.',
          pid: 20203,
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          lingering: false,
          stuck: false,
          durationMs: 30,
          stdout: 'truncated text',
          stderr: '',
          truncated: { stdout: true, stderr: false },
          outputBytes: { stdout: 100000, stderr: 0 },
        };
      }
    }

    const runner2 = new HostExecutionBackend({ workspaceRoot: work, workspace: studio, shellRunner: new TruncatedShellRunner() });
    const reg2 = new ExecutionRegistry();
    reg2.register(runner2);

    const receipt2 = await reg2.dispatch(
      { runId: 'r-tr', snapshotId: 's', checkId: 'c', command: 'big', backend: 'host', isolationRequired: false },
      { trustedInternal: true }
    );
    assert.equal(receipt2.truncated, true);

    ok('14. Output byte cap and UTF-8 multi-byte boundary truncation verified strictly');
  }

  // ------------------------------------------------------------------ 15. Unknown/null exit code, signal termination, and stuck process never report completed/PASS
  {
    // Fake runner returning exitCode: null without a signal (stuck or abnormal exit)
    class NullExitShellRunner {
      async run() {
        return {
          shell: 'bash',
          transport: 'argv',
          cwd: '.',
          pid: 30301,
          exitCode: null,
          signal: null,
          timedOut: false,
          cancelled: false,
          lingering: false,
          stuck: false,
          durationMs: 100,
          stdout: '',
          stderr: 'process terminated abnormally',
          truncated: { stdout: false, stderr: false },
          outputBytes: { stdout: 0, stderr: 30 },
        };
      }
    }

    const hostBackend = new HostExecutionBackend({
      workspaceRoot: work,
      workspace: studio,
      shellRunner: new NullExitShellRunner(),
    });
    const registry = new ExecutionRegistry();
    registry.register(hostBackend);

    const receiptNull = await registry.dispatch(
      { runId: 'r-null-exit', snapshotId: 's', checkId: 'c', command: 'crash', backend: 'host', isolationRequired: false },
      { trustedInternal: true }
    );

    assert.equal(receiptNull.status, 'failed', 'Null exit code must report failed, NEVER completed');
    assert.equal(receiptNull.exitCode, null);
    assert.match(receiptNull.reasons[0], /unknown or missing exit code/);

    // Verify validateExecutionReceipt rejects completed status with null or non-zero exit code
    assert.throws(
      () =>
        validateExecutionReceipt({
          runId: 'r-bad-receipt',
          status: 'completed',
          exitCode: null,
          stdout: '',
          stderr: '',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 10,
          backend: 'host',
          truncated: false,
        }),
      (err) => err.code === 'invalid_receipt'
    );

    assert.throws(
      () =>
        validateExecutionReceipt({
          runId: 'r-bad-receipt-2',
          status: 'completed',
          exitCode: 1,
          stdout: '',
          stderr: '',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 10,
          backend: 'host',
          truncated: false,
        }),
      (err) => err.code === 'invalid_receipt'
    );

    // Process killed by signal (SIGTERM)
    class SignalShellRunner {
      async run() {
        return {
          shell: 'bash',
          transport: 'argv',
          cwd: '.',
          pid: 30302,
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: false,
          cancelled: false,
          lingering: false,
          stuck: false,
          durationMs: 150,
          stdout: '',
          stderr: 'Terminated',
          truncated: { stdout: false, stderr: false },
          outputBytes: { stdout: 0, stderr: 10 },
        };
      }
    }

    const hostSignal = new HostExecutionBackend({ workspaceRoot: work, workspace: studio, shellRunner: new SignalShellRunner() });
    const regSignal = new ExecutionRegistry();
    regSignal.register(hostSignal);

    const receiptSignal = await regSignal.dispatch(
      { runId: 'r-sig', snapshotId: 's', checkId: 'c', command: 'killme', backend: 'host', isolationRequired: false },
      { trustedInternal: true }
    );

    assert.equal(receiptSignal.status, 'failed', 'Signal termination must NEVER be reported as completed');
    assert.equal(receiptSignal.exitCode, null);
    assert.match(receiptSignal.reasons[0], /SIGTERM/);

    // Stuck process forcefully terminated
    class StuckShellRunner {
      async run() {
        return {
          shell: 'bash',
          transport: 'argv',
          cwd: '.',
          pid: 30303,
          exitCode: null,
          signal: 'SIGKILL',
          timedOut: false,
          cancelled: false,
          lingering: false,
          stuck: true,
          durationMs: 4000,
          stdout: '',
          stderr: 'Hard kill',
          truncated: { stdout: false, stderr: false },
          outputBytes: { stdout: 0, stderr: 9 },
        };
      }
    }

    const hostStuck = new HostExecutionBackend({ workspaceRoot: work, workspace: studio, shellRunner: new StuckShellRunner() });
    const regStuck = new ExecutionRegistry();
    regStuck.register(hostStuck);

    const receiptStuck = await regStuck.dispatch(
      { runId: 'r-stuck', snapshotId: 's', checkId: 'c', command: 'hang', backend: 'host', isolationRequired: false },
      { trustedInternal: true }
    );
    assert.equal(receiptStuck.status, 'failed');
    assert.equal(receiptStuck.exitCode, null);
    assert.match(receiptStuck.reasons[0], /stuck\/unresponsive/);

    ok('15. Unknown/null exit code, signals, and stuck processes strictly report failure and never PASS');
  }

  // ------------------------------------------------------------------ 16. PermissionGate cannot be bypassed; untrusted execution blocked fail-closed
  {
    const spy = new SpySpawner();
    const registry = createTestRegistry(spy);

    // Dispatch WITHOUT PermissionGate and WITHOUT trustedInternal: true
    const blockedReceipt = await registry.dispatch({
      runId: 'r-untrusted-no-gate',
      snapshotId: 's',
      checkId: 'c',
      command: 'dir',
      backend: 'host',
      isolationRequired: false,
    });

    assert.equal(blockedReceipt.status, 'blocked', 'Untrusted execution without gate must be blocked');
    assert.equal(blockedReceipt.exitCode, null);
    assert.match(blockedReceipt.stderr, /Permission gate missing/);
    assert.match(blockedReceipt.reasons[0], /Untrusted execution requires an authoritative PermissionGate/);
    assert.equal(spy.calls, 0, 'Host spawner must NEVER be called when untrusted execution lacks a PermissionGate');

    // Trusted internal execution with trustedInternal: true
    const trustedReceipt = await registry.dispatch(
      {
        runId: 'r-trusted-internal',
        snapshotId: 's',
        checkId: 'c',
        command: 'echo internal',
        backend: 'host',
        isolationRequired: false,
      },
      { trustedInternal: true }
    );

    assert.equal(trustedReceipt.status, 'completed');
    assert.equal(trustedReceipt.exitCode, 0);
    assert.equal(spy.calls, 1, 'Host spawner called exactly once for verified trusted internal execution');

    ok('16. Untrusted execution without PermissionGate blocked fail-closed; trusted internal execution isolated');
  }

  // ------------------------------------------------------------------ 17. No silent host fallback when backend unavailable or failing
  {
    const spy = new SpySpawner();
    const registry = createTestRegistry(spy);

    // Target windows-sandbox directly when unavailable
    await assert.rejects(
      () =>
        registry.dispatch(
          {
            runId: 'r-no-fallback',
            snapshotId: 's',
            checkId: 'c',
            command: 'echo isolated',
            backend: 'windows-sandbox',
            isolationRequired: false,
          },
          { trustedInternal: true }
        ),
      (err) => {
        assert.equal(err.code, 'backend_unavailable');
        return true;
      }
    );

    assert.equal(spy.calls, 0, 'Host spawner must NEVER be silently invoked as fallback');
    ok('17. No silent fallback to host shell when designated backend is unavailable');
  }

  // ------------------------------------------------------------------ 18. Windows Sandbox placeholder honesty: no unverified capabilities
  {
    const placeholder = new WindowsSandboxPlaceholderBackend();
    const report = await placeholder.probe();

    assert.equal(report.backend, 'windows-sandbox');
    assert.equal(report.available, false);
    assert.equal(report.osIsolated, true);
    assert.deepEqual(report.enforcedLimits, [], 'Placeholder must not claim any limits are enforced yet');
    assert.ok(report.unsupportedLimits.includes('timeoutSeconds'));
    assert.ok(report.unsupportedLimits.includes('maxOutputBytes'));
    assert.ok(report.unsupportedLimits.includes('maxMemoryMb'));
    assert.ok(report.unsupportedLimits.includes('maxCpuCores'));
    assert.ok(report.reasons.some((r) => r.includes('feasibility gate prerequisite')));

    ok('18. Windows Sandbox placeholder strictly avoids advertising unverified capabilities');
  }

  // ------------------------------------------------------------------ 19. In-flight cancellation safety and double-cancel idempotency
  {
    const controller = new AbortController();
    const registry = createTestRegistry();

    // Trigger cancel during active run
    const activePromise = registry.dispatch(
      {
        runId: 'r-in-flight-cancel',
        snapshotId: 's',
        checkId: 'c',
        command: 'dir',
        backend: 'host',
        isolationRequired: false,
      },
      { signal: controller.signal, trustedInternal: true }
    );

    controller.abort(new Error('User aborted operation'));
    const receipt = await activePromise;

    assert.equal(receipt.status, 'cancelled');
    assert.equal(receipt.exitCode, null);

    // Double cancel or non-existent cancel is completely safe and returns false
    assert.equal(await registry.cancel('r-in-flight-cancel'), false);
    assert.equal(await registry.cancel('r-never-existed'), false);

    ok('19. In-flight cancellation and double-cancel verified without race conditions');
  }

  // ------------------------------------------------------------------ 20. Unknown required limits & contradictory capabilities fail closed (Issue A)
  {
    const spy = new SpySpawner();
    const registry = createTestRegistry(spy);

    // 1. Unknown required limit (not in enforcedLimits and not in unsupportedLimits)
    await assert.rejects(
      () =>
        registry.dispatch(
          {
            runId: 'r-unknown-limit',
            snapshotId: 's',
            checkId: 'c',
            command: 'echo limit',
            backend: 'host',
            isolationRequired: false,
            requiredLimits: ['totallyUnknownConstraint999'],
          },
          { trustedInternal: true }
        ),
      (err) => {
        assert.equal(err.code, 'unsupported_limit');
        assert.match(err.message, /totallyUnknownConstraint999/);
        return true;
      }
    );
    assert.equal(spy.calls, 0, 'Host spawner must never be called for unknown required limits');

    // 2. Contradictory capability report rejected at schema validation
    assert.throws(
      () =>
        validateCapabilityReport({
          backend: 'contradictory',
          available: true,
          osIsolated: false,
          platform: 'win32',
          networkPolicy: 'host-governed',
          writeScope: 'host-filesystem',
          concurrency: 1,
          enforcedLimits: ['timeoutSeconds', 'maxMemoryMb'],
          unsupportedLimits: ['maxMemoryMb'], // contradicts enforcedLimits!
          reasons: [],
          observedAt: new Date().toISOString(),
        }),
      (err) => {
        assert.equal(err.code, 'invalid_capability_report');
        assert.match(err.message, /cannot be both enforced and unsupported/);
        return true;
      }
    );

    // 3. Backend with contradictory report rejected during dispatch
    class ContradictoryBackend extends ExecutionBackend {
      constructor() {
        super('contradictory');
      }
      async probe() {
        return {
          backend: 'contradictory',
          available: true,
          osIsolated: false,
          platform: 'win32',
          networkPolicy: 'host-governed',
          writeScope: 'host-filesystem',
          concurrency: 1,
          enforcedLimits: ['timeoutSeconds'],
          unsupportedLimits: ['timeoutSeconds'], // contradictory!
          reasons: [],
          observedAt: new Date().toISOString(),
        };
      }
    }
    const regContra = new ExecutionRegistry();
    regContra.register(new ContradictoryBackend());
    await assert.rejects(
      () =>
        regContra.dispatch(
          {
            runId: 'r-contra-disp',
            snapshotId: 's',
            checkId: 'c',
            command: 'echo hi',
            backend: 'contradictory',
            isolationRequired: false,
          },
          { trustedInternal: true }
        ),
      (err) => err.code === 'backend_probe_failed'
    );

    ok('20. Unknown required limits fail closed; contradictory capability reports rejected');
  }

  // ------------------------------------------------------------------ 21. Duplicate runId & cancellation race conditions (Issue B)
  {
    // Fake runner with concurrency barrier
    let runnerStartedResolve;
    const runnerStarted = new Promise((resolve) => {
      runnerStartedResolve = resolve;
    });

    let continueResolve;
    const continuePromise = new Promise((resolve) => {
      continueResolve = resolve;
    });

    class BarrierShellRunner {
      async run(options) {
        runnerStartedResolve();
        // Wait until instructed to continue or aborted
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error('Runner aborted'));
          if (options.signal?.aborted) return onAbort();
          options.signal?.addEventListener('abort', onAbort, { once: true });
          continuePromise.then(() => {
            options.signal?.removeEventListener('abort', onAbort);
            resolve();
          });
        });
        return {
          shell: 'bash',
          transport: 'argv',
          cwd: '.',
          pid: 40401,
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          lingering: false,
          stuck: false,
          durationMs: 50,
          stdout: 'barrier done\n',
          stderr: '',
          truncated: { stdout: false, stderr: false },
          outputBytes: { stdout: 13, stderr: 0 },
        };
      }
    }

    const barrierBackend = new HostExecutionBackend({
      workspaceRoot: work,
      workspace: studio,
      shellRunner: new BarrierShellRunner(),
    });
    const registry = new ExecutionRegistry();
    registry.register(barrierBackend);

    const runId = 'r-duplicate-barrier';

    // Start first execution
    const firstPromise = registry.dispatch(
      {
        runId,
        snapshotId: 's',
        checkId: 'c',
        command: 'echo barrier',
        backend: 'host',
        isolationRequired: false,
      },
      { trustedInternal: true }
    );

    // Wait until runner has actually started
    await runnerStarted;

    // Dispatch second request with the same runId while first is active -> must fail closed with duplicate_run_id (409)
    await assert.rejects(
      () =>
        registry.dispatch(
          {
            runId,
            snapshotId: 's',
            checkId: 'c',
            command: 'echo barrier 2',
            backend: 'host',
            isolationRequired: false,
          },
          { trustedInternal: true }
        ),
      (err) => {
        assert.equal(err.code, 'duplicate_run_id');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );

    // Cancel the first run
    const cancelResult = await registry.cancel(runId);
    assert.equal(cancelResult, true, 'Cancellation of active run must succeed');

    const firstReceipt = await firstPromise;
    assert.equal(firstReceipt.status, 'cancelled');

    // After completion and cleanup in finally, runId is no longer active in activeRuns
    // A fresh execution with same runId can now run
    class QuickRunner {
      async run() {
        return {
          shell: 'bash',
          cwd: '.',
          pid: 40402,
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          lingering: false,
          stuck: false,
          durationMs: 10,
          stdout: 'quick ok',
          stderr: '',
          truncated: { stdout: false, stderr: false },
          outputBytes: { stdout: 8, stderr: 0 },
        };
      }
    }
    const freshBackend = new HostExecutionBackend({ workspaceRoot: work, workspace: studio, shellRunner: new QuickRunner() });
    const freshRegistry = new ExecutionRegistry();
    freshRegistry.register(freshBackend);

    const subsequentReceipt = await freshRegistry.dispatch(
      { runId, snapshotId: 's', checkId: 'c', command: 'echo quick', backend: 'host', isolationRequired: false },
      { trustedInternal: true }
    );
    assert.equal(subsequentReceipt.status, 'completed');

    ok('21. Duplicate runId strictly rejected with duplicate_run_id (409) without corrupting active runs');
  }

  // ------------------------------------------------------------------ 22. Trusted internal authorization & forged gate prevention (Issue C)
  {
    const spy = new SpySpawner();
    const authoritativeGate = new PermissionGate({ manager, workspace: studio });
    const registry = createDefaultExecutionRegistry({
      workspaceRoot: work,
      workspace: studio,
      shellRunner: new ShellRunner({ workspace: studio, stateDirectory: state, spawner: (...args) => spy.spawn(...args) }),
      permissionGate: authoritativeGate,
    });

    // 1. Forged gate object rejected
    const forgedGate = {
      authorize: async () => ({ allowed: true, reason: 'forged pass' }),
    };
    await assert.rejects(
      () =>
        registry.dispatch(
          { runId: 'r-forged-gate', snapshotId: 's', checkId: 'c', command: 'echo hack', backend: 'host', isolationRequired: false },
          { permissionGate: forgedGate }
        ),
      (err) => {
        assert.equal(err.code, 'invalid_permission_gate');
        return true;
      }
    );

    // 2. Unauthorized override of authoritative PermissionGate
    const anotherValidGate = new PermissionGate({ manager, workspace: studio });
    await assert.rejects(
      () =>
        registry.dispatch(
          { runId: 'r-override-gate', snapshotId: 's', checkId: 'c', command: 'echo override', backend: 'host', isolationRequired: false },
          { permissionGate: anotherValidGate }
        ),
      (err) => {
        assert.equal(err.code, 'unauthorized_gate_override');
        return true;
      }
    );

    // 3. Default SandboxEngine constructor defaults trustedInternal to false
    const untrustedEngine = new SandboxEngine({
      mode: 'host',
      workspaceRoot: work,
      workspace: studio,
      // No permissionGate, no trustedInternal
    });
    assert.equal(untrustedEngine.trustedInternal, false, 'SandboxEngine default trustedInternal must be false');

    const blockedResult = await untrustedEngine.execute({
      command: 'echo unauthenticated',
    });
    assert.equal(blockedResult.status, 'blocked');
    assert.match(blockedResult.stderr, /Permission gate missing/);

    // 4. Registry constructor rejects non-PermissionGate defaultGate
    assert.throws(
      () => new ExecutionRegistry({ defaultGate: { fake: true } }),
      (err) => err.code === 'invalid_permission_gate'
    );

    assert.equal(spy.calls, 0, 'Host spawner must never be called during gate forging or unauthorized overrides');
    ok('22. Forged gate objects and unauthorized gate overrides strictly rejected; default untrusted verified');
  }

  // ------------------------------------------------------------------ 23. Future Windows isolation compatibility & broker contract (Issue D)
  {
    const gate = new PermissionGate({ manager, workspace: studio });

    // 1. PermissionGate in PR 1 rejects isolationRequired fail-closed
    const authResult = await gate.authorize({
      name: 'local.run_command',
      args: { command: 'echo isolated', isolationRequired: true },
      taskId: 'task-iso-check',
    });
    assert.equal(authResult.allowed, false);
    assert.match(authResult.reason, /Yêu cầu cách ly hệ điều hành \(isolationRequired\)/);

    // 2. Registry dispatch contract readiness: in PR 2/3, a verified OS-isolated backend
    // reporting osIsolated: true and available: true can be dispatched to with isolationRequired: true
    class MockVerifiedIsolatedBackend extends ExecutionBackend {
      constructor() {
        super('mock-isolated');
        this.executedRequests = [];
      }
      async probe() {
        return validateCapabilityReport({
          backend: 'mock-isolated',
          available: true,
          osIsolated: true,
          platform: 'win32',
          networkPolicy: 'denied',
          writeScope: 'guest-ephemeral',
          concurrency: 1,
          enforcedLimits: ['timeoutSeconds', 'maxOutputBytes'],
          unsupportedLimits: ['maxMemoryMb', 'maxCpuCores', 'customEnv'],
          reasons: ['Verified OS guest isolation container'],
          observedAt: new Date().toISOString(),
        });
      }
      async execute(request) {
        this.executedRequests.push(request);
        return validateExecutionReceipt({
          runId: request.runId,
          status: 'completed',
          exitCode: 0,
          stdout: 'isolated guest output\n',
          stderr: '',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 15,
          backend: this.id,
          truncated: false,
        });
      }
    }

    const isolatedBackend = new MockVerifiedIsolatedBackend();
    const isolatedRegistry = new ExecutionRegistry();
    isolatedRegistry.register(isolatedBackend);

    const isolatedReceipt = await isolatedRegistry.dispatch(
      {
        runId: 'r-verified-isolated',
        snapshotId: 's',
        checkId: 'c',
        command: 'echo guest',
        backend: 'mock-isolated',
        isolationRequired: true,
      },
      { trustedInternal: true }
    );

    assert.equal(isolatedReceipt.status, 'completed');
    assert.equal(isolatedReceipt.backend, 'mock-isolated');
    assert.equal(isolatedReceipt.exitCode, 0);
    assert.equal(isolatedBackend.executedRequests.length, 1);
    assert.equal(isolatedBackend.executedRequests[0].isolationRequired, true);

    ok('23. PermissionGate rejects isolationRequired fail-closed; ExecutionRegistry contract ready for PR 2/3 broker');
  }

  // ------------------------------------------------------------------ 24. Final cancellation check before backend execution begins (Stage A)
  {
    // Test 1: Cancellation during deferred capability probe
    let probeResolve;
    const probePromise = new Promise((resolve) => {
      probeResolve = resolve;
    });

    class DeferredProbeBackend extends ExecutionBackend {
      constructor() {
        super('deferred-probe');
        this.executed = false;
      }
      async probe() {
        await probePromise;
        return validateCapabilityReport({
          backend: 'deferred-probe',
          available: true,
          osIsolated: false,
          platform: 'win32',
          networkPolicy: 'host-governed',
          writeScope: 'workspace-only',
          concurrency: 1,
          enforcedLimits: ['timeoutSeconds'],
          unsupportedLimits: ['maxMemoryMb'],
          reasons: [],
          observedAt: new Date().toISOString(),
        });
      }
      async execute(request) {
        this.executed = true;
        throw new Error('DeferredProbeBackend execute() should NEVER be called on cancelled run');
      }
    }

    const deferredBackend = new DeferredProbeBackend();
    const deferredRegistry = new ExecutionRegistry();
    deferredRegistry.register(deferredBackend);

    const probeRunId = 'r-cancel-deferred-probe';
    const probeDispatchPromise = deferredRegistry.dispatch(
      {
        runId: probeRunId,
        snapshotId: 's',
        checkId: 'c',
        command: 'echo deferred',
        backend: 'deferred-probe',
        isolationRequired: false,
      },
      { trustedInternal: true }
    );

    // Cancel while probe is still running
    const cancelProbeRes = await deferredRegistry.cancel(probeRunId);
    assert.equal(cancelProbeRes, true, 'cancel() must succeed while waiting for capability probe');

    // Resolve the probe promise
    probeResolve();

    const probeReceipt = await probeDispatchPromise;
    assert.equal(probeReceipt.status, 'cancelled');
    assert.equal(probeReceipt.exitCode, null);
    assert.equal(deferredBackend.executed, false, 'Backend execute must NEVER be invoked after probe cancellation');
    assert.equal(deferredRegistry.activeRuns.size, 0, 'Registry activeRuns must release ownership cleanly');

    // Test 2: Cancellation during pending permission decision & late approval refusal
    class MonitoredBackend extends ExecutionBackend {
      constructor() {
        super('monitored');
        this.executed = false;
      }
      async probe() {
        return validateCapabilityReport({
          backend: 'monitored',
          available: true,
          osIsolated: false,
          platform: 'win32',
          networkPolicy: 'host-governed',
          writeScope: 'workspace-only',
          concurrency: 1,
          enforcedLimits: ['timeoutSeconds'],
          unsupportedLimits: ['maxMemoryMb'],
          reasons: [],
          observedAt: new Date().toISOString(),
        });
      }
      async execute(request) {
        this.executed = true;
        return validateExecutionReceipt({
          runId: request.runId,
          status: 'completed',
          exitCode: 0,
          stdout: 'ran\n',
          stderr: '',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 10,
          backend: this.id,
          truncated: false,
        });
      }
    }

    const gate = new PermissionGate({ manager: { secrets: [] }, workspace: null, timeout: 60000 });
    gate.classify = () => ({ category: 'execute', reason: 'Needs review' });

    const monitoredBackend = new MonitoredBackend();
    const gateRegistry = new ExecutionRegistry({ defaultGate: gate });
    gateRegistry.register(monitoredBackend);

    const gateRunId = 'r-cancel-pending-gate';
    const gateDispatchPromise = gateRegistry.dispatch({
      runId: gateRunId,
      snapshotId: 's',
      checkId: 'c',
      command: 'echo pending-permission',
      backend: 'monitored',
      isolationRequired: false,
    });

    // Wait until request is registered in gate
    await new Promise((r) => setTimeout(r, 20));
    const pendingReqs = [...gate.requests.values()];
    assert.equal(pendingReqs.length, 1, 'Request must be pending in PermissionGate');
    const pendingId = pendingReqs[0].id;

    // Cancel while waiting for permission decision
    const cancelGateRes = await gateRegistry.cancel(gateRunId);
    assert.equal(cancelGateRes, true, 'cancel() must succeed while waiting for permission decision');

    // Verify request was aborted and removed from gate
    assert.equal(gate.requests.has(pendingId), false, 'Pending request must be removed from gate on cancellation');
    assert.throws(
      () => gate.decide(pendingId, true),
      (err) => err.code === 'not_pending',
      'Late approval after cancellation must be rejected as not_pending'
    );

    const gateReceipt = await gateDispatchPromise;
    assert.equal(gateReceipt.status, 'cancelled');
    assert.equal(gateReceipt.exitCode, null);
    assert.equal(monitoredBackend.executed, false, 'Command must NEVER execute after gate cancellation');
    assert.equal(gateRegistry.activeRuns.size, 0, 'Registry activeRuns must release ownership cleanly');

    // Test 3: Cancellation does not affect an unrelated run
    const concurrentBackend = new MonitoredBackend();
    const concurrentRegistry = new ExecutionRegistry();
    concurrentRegistry.register(concurrentBackend);

    let blockerResolve;
    const blockerPromise = new Promise((resolve) => { blockerResolve = resolve; });
    class BlockingBackend extends ExecutionBackend {
      constructor() { super('blocking'); }
      async probe() { return concurrentBackend.probe(); }
      async execute(request, { signal }) {
        await new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
          blockerPromise.then(resolve);
        });
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

    const blocker = new BlockingBackend();
    concurrentRegistry.register(blocker);

    const runA = 'run-to-cancel';
    const runB = 'run-to-succeed';

    const promiseA = concurrentRegistry.dispatch(
      { runId: runA, snapshotId: 's', checkId: 'c', command: 'echo a', backend: 'blocking', isolationRequired: false },
      { trustedInternal: true }
    );
    const promiseB = concurrentRegistry.dispatch(
      { runId: runB, snapshotId: 's', checkId: 'c', command: 'echo b', backend: 'blocking', isolationRequired: false },
      { trustedInternal: true }
    );

    // Cancel ONLY run A
    assert.equal(await concurrentRegistry.cancel(runA), true);

    // Allow blocker to finish for remaining runs
    blockerResolve();

    const receiptA = await promiseA;
    const receiptB = await promiseB;

    assert.equal(receiptA.status, 'cancelled');
    assert.equal(receiptB.status, 'completed', 'Unrelated run B must succeed without being affected by cancellation of run A');

    ok('24. Pre-execution cancellation verified during probe and permission phases with 0 orphaned executions');
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
