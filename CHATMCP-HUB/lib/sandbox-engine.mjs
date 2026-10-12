// Unified Sandbox Engine for ChatMCP (Phase 1, PR 1).
//
// Provides an extensible execution layer backed by honest execution contracts.
// Reports osIsolated: false for host mode, explicitly enumerates unsupported limits,
// and routes isolation-required dispatch through the capability registry.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShellRunner } from './shell-runner.mjs';
import {
  createDefaultExecutionRegistry,
  ExecutionRegistry,
  DEFAULT_EXECUTION_LIMITS,
  fault,
} from './execution-contract.mjs';

export const SANDBOX_MODES = Object.freeze(['host']);

const DEFAULT_LIMITS = Object.freeze({
  timeoutSeconds: 120,
  maxMemoryMb: 512,
  maxCpuCores: 1,
  maxOutputBytes: 100 * 1024, // 100 KB
});

export class SandboxEngine {
  /**
   * @param {object} options
   * @param {string} [options.mode='host'] Execution mode ('host' only; OS isolation is not implemented)
   * @param {string} [options.workspaceRoot] Working directory root
   * @param {object} [options.workspace] StudioWorkspace or adapter with resolve()
   * @param {object} [options.limits] Resource limit overrides
   * @param {ShellRunner} [options.shellRunner] Custom ShellRunner instance
   * @param {ExecutionRegistry} [options.registry] ExecutionRegistry instance
   */
  constructor({
    mode = 'host',
    workspaceRoot,
    workspace = null,
    limits = {},
    shellRunner = null,
    registry = null,
    permissionGate = null,
    trustedInternal = false,
  } = {}) {
    if (!SANDBOX_MODES.includes(mode)) {
      throw fault('invalid_mode', `Chế độ sandbox không hợp lệ (${mode}). Cho phép: ${SANDBOX_MODES.join(', ')}.`);
    }
    this.mode = mode;
    this.workspaceRoot = workspaceRoot || process.cwd();
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    const effectiveWs = workspace && typeof workspace.resolve === 'function'
      ? workspace
      : { resolve: async (rel = '') => ({ absolute: path.resolve(this.workspaceRoot, String(rel || '.')), relative: String(rel || '.') }) };
    this.shellRunner = shellRunner || new ShellRunner({ workspace: effectiveWs });
    this.permissionGate = permissionGate;
    this.trustedInternal = Boolean(trustedInternal);
    this.registry = registry || createDefaultExecutionRegistry({
      workspaceRoot: this.workspaceRoot,
      workspace: effectiveWs,
      shellRunner: this.shellRunner,
      limits: this.limits,
      permissionGate: this.permissionGate,
    });
  }

  /**
   * Returns current sandbox configuration and capability status.
   * Reports honest osIsolated: false and lists unsupported limits.
   */
  status() {
    const hostBackend = this.registry.get('host');
    const report = hostBackend && typeof hostBackend.getStaticCapabilityReport === 'function'
      ? hostBackend.getStaticCapabilityReport()
      : {
          backend: 'host',
          available: true,
          osIsolated: false,
          platform: process.platform,
          networkPolicy: 'host-governed',
          writeScope: 'host-filesystem',
          concurrency: 1,
          enforcedLimits: ['timeoutSeconds', 'maxOutputBytes'],
          unsupportedLimits: ['maxMemoryMb', 'maxCpuCores', 'customEnv'],
          reasons: [
            'Host execution shares the host OS kernel and user account credentials',
            'OS-level memory/CPU limits are not enforced by host backend',
            'Process has unconfined host filesystem write access (no OS filesystem jail)',
            'Per-call environment variable overrides are not supported by host shell runner',
          ],
          observedAt: new Date().toISOString(),
        };

    const backends = this.registry.list().map((id) => {
      const b = this.registry.get(id);
      return b && typeof b.getStaticCapabilityReport === 'function'
        ? b.getStaticCapabilityReport()
        : null;
    }).filter(Boolean);

    return {
      mode: this.mode,
      backend: report.backend,
      available: report.available,
      osIsolated: false,
      platform: report.platform,
      workspaceRoot: this.workspaceRoot,
      networkPolicy: report.networkPolicy,
      writeScope: report.writeScope,
      concurrency: report.concurrency,
      limits: { ...this.limits },
      enforcedLimits: [...report.enforcedLimits],
      unsupportedLimits: [...report.unsupportedLimits],
      reasons: [...report.reasons],
      observedAt: report.observedAt,
      capabilities: report,
      backends,
    };
  }

  /**
   * Asynchronously probes and returns full capability report for the active backend.
   */
  async probe(backendId = 'host') {
    return this.registry.getCapabilityReport(backendId);
  }

  /**
   * Executes a shell command within the configured sandbox mode.
   *
   * @param {object} options
   * @param {string} options.command The command string to execute
   * @param {string} [options.cwd] Sub-directory relative to workspaceRoot
   * @param {string} [options.shell] Shell interpreter ('bash', 'sh', 'powershell', 'auto')
   * @param {number} [options.timeoutSeconds] Command-specific timeout override
   * @param {object} [options.env] Additional environment variables
   * @param {AbortSignal} [options.signal] Abort signal
   * @param {boolean} [options.isolationRequired=false] If true, dispatch fails closed unless OS isolation is available
   * @param {string} [options.runId] Optional execution run identifier
   * @param {string} [options.snapshotId] Optional snapshot identifier
   * @param {string} [options.checkId] Optional check identifier
   * @param {string[]} [options.requiredLimits] Optional array of strictly required limits
   * @param {object} [options.permissionGate] Optional PermissionGate instance
   * @param {string} [options.taskId] Optional taskId for permission authorization
   * @param {boolean} [options.trustedInternal] Optional trusted internal bypass flag
   * @returns {Promise<{ exitCode: number|null, stdout: string, stderr: string, durationMs: number, timedOut: boolean, mode: string, receipt: object, status: string }>}
   */
  async execute({
    command,
    cwd = '.',
    shell = 'auto',
    timeoutSeconds,
    env = {},
    signal,
    isolationRequired = false,
    runId,
    snapshotId,
    checkId,
    requiredLimits = [],
    permissionGate = null,
    taskId = null,
    trustedInternal = null,
  } = {}) {
    if (!command || typeof command !== 'string') {
      throw fault('missing_command', 'Lệnh thực thi không được để trống.');
    }

    const effectiveRunId = runId || randomUUID();
    const effectiveSnapshotId = snapshotId || 'ephemeral-snapshot';
    const effectiveCheckId = checkId || 'command-check';

    const request = {
      runId: effectiveRunId,
      snapshotId: effectiveSnapshotId,
      checkId: effectiveCheckId,
      command,
      cwd,
      shell,
      isolationRequired: Boolean(isolationRequired),
      limits: {
        timeoutSeconds: Math.min(timeoutSeconds || this.limits.timeoutSeconds, 900),
        maxOutputBytes: this.limits.maxOutputBytes,
      },
      requiredLimits,
      env,
    };

    const effectiveGate = permissionGate !== null ? permissionGate : this.permissionGate;
    const effectiveTrusted = trustedInternal !== null ? Boolean(trustedInternal) : this.trustedInternal;

    const receipt = await this.registry.dispatch(request, {
      signal,
      permissionGate: effectiveGate,
      taskId: taskId || effectiveRunId,
      trustedInternal: effectiveTrusted,
    });

    return {
      exitCode: receipt.exitCode,
      stdout: receipt.stdout || '',
      stderr: receipt.stderr || '',
      durationMs: receipt.durationMs,
      timedOut: receipt.status === 'timed_out',
      mode: this.mode,
      status: receipt.status,
      receipt,
    };
  }

  /**
   * Cancels an active execution by runId.
   * @param {string} runId
   * @returns {Promise<boolean>}
   */
  async cancel(runId) {
    return this.registry.cancel(runId);
  }
}
