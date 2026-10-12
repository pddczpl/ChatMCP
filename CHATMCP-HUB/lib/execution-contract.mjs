// Execution Backend Contract & Fail-Closed Dispatch for ChatMCP (Phase 1, PR 1).
//
// Defines strict schemas, capability reports, execution requests/receipts,
// backend interfaces, and a fail-closed execution dispatcher that prevents
// unisolated host execution when OS isolation is required.

import process from 'node:process';
import { ShellRunner } from './shell-runner.mjs';
import { PermissionGate } from './permissions.mjs';

export const EXECUTION_STATUSES = Object.freeze([
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'isolation_unavailable',
  'unsupported_limit',
  'blocked',
  'rejected',
  'error',
]);

export const DEFAULT_EXECUTION_LIMITS = Object.freeze({
  timeoutSeconds: 120,
  maxOutputBytes: 100 * 1024, // 100 KB
  maxMemoryMb: null,
  maxCpuCores: null,
});

export const MAX_TIMEOUT_SECONDS = 900;

export const fault = (code, message, statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode });

/**
 * Safely truncates a UTF-8 string to stay within maxBytes without splitting multi-byte characters.
 *
 * @param {string} str
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean, byteLength: number }}
 */
export function truncateUtf8Bytes(str, maxBytes) {
  if (typeof str !== 'string' || !str) {
    return { text: '', truncated: false, byteLength: 0 };
  }
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) {
    return { text: str, truncated: false, byteLength: buf.length };
  }
  let end = maxBytes;
  // Step backward over partial UTF-8 multibyte characters if we split in the middle of one
  for (let i = 0; i < 4 && end - i > 0; i++) {
    const b = buf[end - 1 - i];
    if ((b & 0x80) === 0) {
      // ASCII single byte (0xxxxxxx)
      break;
    } else if ((b & 0xC0) === 0xC0) {
      // Multibyte start byte: 110xxxxx (2 bytes), 1110xxxx (3 bytes), 11110xxx (4 bytes)
      let seqLen = 1;
      if ((b & 0xE0) === 0xC0) seqLen = 2;
      else if ((b & 0xF0) === 0xE0) seqLen = 3;
      else if ((b & 0xF8) === 0xF0) seqLen = 4;
      if (end - 1 - i + seqLen > end) {
        end = end - 1 - i;
      }
      break;
    }
  }
  const text = buf.subarray(0, end).toString('utf8');
  return { text, truncated: true, byteLength: Buffer.byteLength(text, 'utf8') };
}

/**
 * Validates and freezes a CapabilityReport.
 *
 * @param {object} report
 * @returns {object} Validated, frozen CapabilityReport
 */
export function validateCapabilityReport(report) {
  if (!report || typeof report !== 'object') {
    throw fault('invalid_capability_report', 'CapabilityReport must be a non-null object.');
  }
  if (typeof report.backend !== 'string' || !report.backend.trim()) {
    throw fault('invalid_capability_report', 'backend identifier is required.');
  }
  if (typeof report.available !== 'boolean') {
    throw fault('invalid_capability_report', 'available must be a boolean.');
  }
  if (typeof report.osIsolated !== 'boolean') {
    throw fault('invalid_capability_report', 'osIsolated must be a boolean.');
  }
  if (typeof report.platform !== 'string' || !report.platform.trim()) {
    throw fault('invalid_capability_report', 'platform must be a non-empty string.');
  }
  if (typeof report.networkPolicy !== 'string' || !report.networkPolicy.trim()) {
    throw fault('invalid_capability_report', 'networkPolicy must be a non-empty string.');
  }
  if (typeof report.writeScope !== 'string' || !report.writeScope.trim()) {
    throw fault('invalid_capability_report', 'writeScope must be a non-empty string.');
  }
  if (typeof report.concurrency !== 'number' || !Number.isFinite(report.concurrency) || report.concurrency < 1) {
    throw fault('invalid_capability_report', 'concurrency must be a positive integer.');
  }
  if (!Array.isArray(report.enforcedLimits) || !report.enforcedLimits.every((x) => typeof x === 'string')) {
    throw fault('invalid_capability_report', 'enforcedLimits must be an array of strings.');
  }
  if (!Array.isArray(report.unsupportedLimits) || !report.unsupportedLimits.every((x) => typeof x === 'string')) {
    throw fault('invalid_capability_report', 'unsupportedLimits must be an array of strings.');
  }
  const enforcedSet = new Set(report.enforcedLimits);
  for (const limit of report.unsupportedLimits) {
    if (enforcedSet.has(limit)) {
      throw fault('invalid_capability_report', `Contradictory capability report: limit '${limit}' cannot be both enforced and unsupported.`);
    }
  }
  if (!Array.isArray(report.reasons) || !report.reasons.every((x) => typeof x === 'string')) {
    throw fault('invalid_capability_report', 'reasons must be an array of strings.');
  }
  if (typeof report.observedAt !== 'string' || Number.isNaN(Date.parse(report.observedAt))) {
    throw fault('invalid_capability_report', 'observedAt must be a valid ISO date string.');
  }

  return Object.freeze({
    backend: report.backend.trim(),
    available: report.available,
    osIsolated: report.osIsolated,
    platform: report.platform.trim(),
    networkPolicy: report.networkPolicy.trim(),
    writeScope: report.writeScope.trim(),
    concurrency: Math.floor(report.concurrency),
    enforcedLimits: Object.freeze([...report.enforcedLimits]),
    unsupportedLimits: Object.freeze([...report.unsupportedLimits]),
    reasons: Object.freeze([...report.reasons]),
    observedAt: report.observedAt,
  });
}

/**
 * Validates and freezes an ExecutionRequest.
 *
 * @param {object} input
 * @returns {object} Validated, frozen ExecutionRequest
 */
export function validateExecutionRequest(input) {
  if (!input || typeof input !== 'object') {
    throw fault('invalid_request', 'ExecutionRequest must be a non-null object.');
  }
  if (typeof input.runId !== 'string' || !input.runId.trim()) {
    throw fault('invalid_request', 'runId must be a non-empty string.');
  }
  if (typeof input.snapshotId !== 'string' || !input.snapshotId.trim()) {
    throw fault('invalid_request', 'snapshotId must be a non-empty string.');
  }
  if (typeof input.checkId !== 'string' || !input.checkId.trim()) {
    throw fault('invalid_request', 'checkId must be a non-empty string.');
  }
  if (typeof input.command !== 'string' || !input.command.trim()) {
    throw fault('invalid_request', 'command must be a non-empty string.');
  }
  if (input.cwd !== undefined && typeof input.cwd !== 'string') {
    throw fault('invalid_request', 'cwd must be a string.');
  }
  if (input.shell !== undefined && typeof input.shell !== 'string') {
    throw fault('invalid_request', 'shell must be a string.');
  }
  if (typeof input.isolationRequired !== 'boolean') {
    throw fault('invalid_request', 'isolationRequired must be a boolean.');
  }

  const limits = input.limits || {};
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    throw fault('invalid_request', 'limits must be an object.');
  }
  if (limits.timeoutSeconds !== undefined && limits.timeoutSeconds !== null) {
    if (typeof limits.timeoutSeconds !== 'number' || !Number.isFinite(limits.timeoutSeconds) || limits.timeoutSeconds <= 0) {
      throw fault('invalid_request', 'timeoutSeconds must be a positive number.');
    }
  }
  if (limits.maxOutputBytes !== undefined && limits.maxOutputBytes !== null) {
    if (typeof limits.maxOutputBytes !== 'number' || !Number.isFinite(limits.maxOutputBytes) || limits.maxOutputBytes <= 0) {
      throw fault('invalid_request', 'maxOutputBytes must be a positive number.');
    }
  }
  if (limits.maxMemoryMb !== undefined && limits.maxMemoryMb !== null) {
    if (typeof limits.maxMemoryMb !== 'number' || !Number.isFinite(limits.maxMemoryMb) || limits.maxMemoryMb <= 0) {
      throw fault('invalid_request', 'maxMemoryMb must be a positive number.');
    }
  }
  if (limits.maxCpuCores !== undefined && limits.maxCpuCores !== null) {
    if (typeof limits.maxCpuCores !== 'number' || !Number.isFinite(limits.maxCpuCores) || limits.maxCpuCores <= 0) {
      throw fault('invalid_request', 'maxCpuCores must be a positive number.');
    }
  }

  const envAllowlist = input.envAllowlist || [];
  if (!Array.isArray(envAllowlist) || !envAllowlist.every((x) => typeof x === 'string')) {
    throw fault('invalid_request', 'envAllowlist must be an array of strings.');
  }

  const requiredLimits = input.requiredLimits || [];
  if (!Array.isArray(requiredLimits) || !requiredLimits.every((x) => typeof x === 'string')) {
    throw fault('invalid_request', 'requiredLimits must be an array of strings.');
  }

  const env = input.env && typeof input.env === 'object' && !Array.isArray(input.env) ? input.env : {};

  return Object.freeze({
    runId: input.runId.trim(),
    snapshotId: input.snapshotId.trim(),
    checkId: input.checkId.trim(),
    command: input.command,
    cwd: input.cwd || '.',
    shell: input.shell || 'auto',
    isolationRequired: Boolean(input.isolationRequired),
    backend: typeof input.backend === 'string' && input.backend.trim() ? input.backend.trim() : null,
    limits: Object.freeze({
      timeoutSeconds: Math.min(
        limits.timeoutSeconds || DEFAULT_EXECUTION_LIMITS.timeoutSeconds,
        MAX_TIMEOUT_SECONDS
      ),
      maxOutputBytes: limits.maxOutputBytes || DEFAULT_EXECUTION_LIMITS.maxOutputBytes,
      maxMemoryMb: limits.maxMemoryMb ?? null,
      maxCpuCores: limits.maxCpuCores ?? null,
    }),
    requiredLimits: Object.freeze([...requiredLimits]),
    envAllowlist: Object.freeze([...envAllowlist]),
    env: Object.freeze({ ...env }),
    snapshotHash: typeof input.snapshotHash === 'string' ? input.snapshotHash : null,
    checkHash: typeof input.checkHash === 'string' ? input.checkHash : null,
  });
}

/**
 * Validates and freezes an ExecutionReceipt.
 *
 * @param {object} receipt
 * @returns {object} Validated, frozen ExecutionReceipt
 */
export function validateExecutionReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    throw fault('invalid_receipt', 'ExecutionReceipt must be a non-null object.');
  }
  if (typeof receipt.runId !== 'string' || !receipt.runId.trim()) {
    throw fault('invalid_receipt', 'runId must be a non-empty string.');
  }
  if (typeof receipt.status !== 'string' || !EXECUTION_STATUSES.includes(receipt.status)) {
    throw fault('invalid_receipt', `status must be one of: ${EXECUTION_STATUSES.join(', ')}.`);
  }
  if (receipt.exitCode !== null && (typeof receipt.exitCode !== 'number' || !Number.isInteger(receipt.exitCode))) {
    throw fault('invalid_receipt', 'exitCode must be an integer or null.');
  }
  if (receipt.status === 'completed' && receipt.exitCode !== 0) {
    throw fault('invalid_receipt', 'status cannot be "completed" when exitCode is non-zero or null.');
  }
  if (typeof receipt.stdout !== 'string') {
    throw fault('invalid_receipt', 'stdout must be a string.');
  }
  if (typeof receipt.stderr !== 'string') {
    throw fault('invalid_receipt', 'stderr must be a string.');
  }
  if (typeof receipt.startedAt !== 'string' || Number.isNaN(Date.parse(receipt.startedAt))) {
    throw fault('invalid_receipt', 'startedAt must be a valid ISO date string.');
  }
  if (typeof receipt.completedAt !== 'string' || Number.isNaN(Date.parse(receipt.completedAt))) {
    throw fault('invalid_receipt', 'completedAt must be a valid ISO date string.');
  }
  if (typeof receipt.durationMs !== 'number' || receipt.durationMs < 0) {
    throw fault('invalid_receipt', 'durationMs must be a non-negative number.');
  }
  if (typeof receipt.backend !== 'string' || !receipt.backend.trim()) {
    throw fault('invalid_receipt', 'backend must be a non-empty string.');
  }
  if (typeof receipt.truncated !== 'boolean') {
    throw fault('invalid_receipt', 'truncated must be a boolean.');
  }
  const reasons = Array.isArray(receipt.reasons) ? receipt.reasons : [];

  return Object.freeze({
    runId: receipt.runId,
    status: receipt.status,
    exitCode: receipt.exitCode,
    stdout: receipt.stdout,
    stderr: receipt.stderr,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    durationMs: receipt.durationMs,
    backend: receipt.backend,
    snapshotHash: typeof receipt.snapshotHash === 'string' ? receipt.snapshotHash : null,
    checkHash: typeof receipt.checkHash === 'string' ? receipt.checkHash : null,
    truncated: receipt.truncated,
    evidencePath: typeof receipt.evidencePath === 'string' ? receipt.evidencePath : null,
    reasons: Object.freeze([...reasons]),
  });
}

/**
 * Base ExecutionBackend contract.
 */
export class ExecutionBackend {
  /**
   * @param {string} id
   */
  constructor(id) {
    if (!id || typeof id !== 'string') {
      throw fault('invalid_backend_id', 'Backend ID must be a non-empty string.');
    }
    this.id = id;
  }

  /**
   * Probes backend capabilities.
   * @returns {Promise<CapabilityReport>}
   */
  async probe() {
    throw fault('not_implemented', `Backend '${this.id}' does not implement probe().`);
  }

  /**
   * Executes a validated ExecutionRequest.
   * @param {object} request Validated ExecutionRequest
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<ExecutionReceipt>}
   */
  async execute(request, { signal } = {}) {
    throw fault('not_implemented', `Backend '${this.id}' does not implement execute().`);
  }

  /**
   * Cancels a running execution by runId.
   * @param {string} runId
   * @returns {Promise<boolean>}
   */
  async cancel(runId) {
    return false;
  }
}

/**
 * Default Host Execution Backend.
 *
 * Runs through ShellRunner on the host machine.
 * Honestly reports osIsolated: false, and lists unsupported OS memory/CPU limits.
 */
export class HostExecutionBackend extends ExecutionBackend {
  /**
   * @param {object} [options]
   * @param {string} [options.workspaceRoot]
   * @param {object} [options.workspace]
   * @param {ShellRunner} [options.shellRunner]
   * @param {object} [options.limits]
   */
  constructor({ workspaceRoot, workspace = null, shellRunner = null, limits = {} } = {}) {
    super('host');
    this.workspaceRoot = workspaceRoot || process.cwd();
    this.workspace = workspace;
    this.shellRunner = shellRunner || new ShellRunner({ workspace });
    this.limits = { ...DEFAULT_EXECUTION_LIMITS, ...limits };
    this.activeRuns = new Map();
  }

  getStaticCapabilityReport() {
    return validateCapabilityReport({
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
    });
  }

  async probe() {
    return this.getStaticCapabilityReport();
  }

  async execute(request, { signal } = {}) {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const runId = request.runId;

    if (this.activeRuns.has(runId)) {
      throw fault('duplicate_run_id', `Execution run '${runId}' is already active.`, 409);
    }

    if (signal?.aborted) {
      return validateExecutionReceipt({
        runId,
        status: 'cancelled',
        exitCode: null,
        stdout: '',
        stderr: signal.reason ? String(signal.reason) : 'Execution aborted before start.',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: 0,
        backend: this.id,
        snapshotHash: request.snapshotHash,
        checkHash: request.checkHash,
        truncated: false,
        evidencePath: null,
        reasons: ['Aborted by caller before launch'],
      });
    }

    // Fail-closed: Sub-second timeout check (ShellRunner minimum is 1000ms)
    if (request.limits.timeoutSeconds < 1) {
      throw fault(
        'unsupported_limit',
        `Host backend cannot enforce sub-second timeout (${request.limits.timeoutSeconds}s < 1s).`,
        400
      );
    }

    // Fail-closed: custom environment overrides are not supported per-call
    if (request.env && Object.keys(request.env).length > 0) {
      throw fault(
        'unsupported_limit',
        'Host backend does not support per-call custom environment overrides (customEnv).',
        400
      );
    }

    const abortController = new AbortController();
    const onParentAbort = () => abortController.abort(signal?.reason);
    if (signal) signal.addEventListener('abort', onParentAbort, { once: true });

    this.activeRuns.set(runId, abortController);

    try {
      const timeoutMs = Math.round(request.limits.timeoutSeconds * 1000);
      const maxOutputBytes = request.limits.maxOutputBytes || DEFAULT_EXECUTION_LIMITS.maxOutputBytes;

      const result = await this.shellRunner.run({
        command: request.command,
        cwd: request.cwd || '.',
        shell: request.shell || 'auto',
        timeoutMs,
        maxOutputBytes,
        signal: abortController.signal,
      });

      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;
      const timedOut = Boolean(result?.timed_out || result?.timedOut);
      const isCancelled = abortController.signal.aborted || Boolean(result?.cancelled);
      const hasSignal = result?.signal !== null && result?.signal !== undefined;
      const isStuck = Boolean(result?.stuck);
      const rawExitCode = result?.exitCode !== undefined ? result.exitCode : result?.exit_code;

      let status;
      let exitCode;
      let reasons = [];

      if (isCancelled) {
        status = 'cancelled';
        exitCode = null;
        reasons = ['Execution cancelled by caller or abort signal'];
      } else if (timedOut) {
        status = 'timed_out';
        exitCode = null;
        reasons = ['Command execution exceeded timeout'];
      } else if (isStuck) {
        status = 'failed';
        exitCode = null;
        reasons = ['Process became stuck/unresponsive and was forcefully terminated'];
      } else if (hasSignal) {
        status = 'failed';
        exitCode = null;
        reasons = [`Process terminated by signal ${result.signal}`];
      } else if (typeof rawExitCode !== 'number') {
        status = 'failed';
        exitCode = null;
        reasons = ['Process exited with unknown or missing exit code'];
      } else if (rawExitCode !== 0) {
        status = 'failed';
        exitCode = rawExitCode;
        reasons = [`Process exited with non-zero exit code ${rawExitCode}`];
      } else {
        status = 'completed';
        exitCode = 0;
      }

      const rawStdout = typeof result?.stdout === 'string' ? result.stdout : '';
      const rawStderr = typeof result?.stderr === 'string' ? result.stderr : '';
      const outCut = truncateUtf8Bytes(rawStdout, maxOutputBytes);
      const errCut = truncateUtf8Bytes(rawStderr, maxOutputBytes);
      const runnerTruncated = Boolean(result?.truncated?.stdout || result?.truncated?.stderr);
      const truncated = runnerTruncated || outCut.truncated || errCut.truncated;

      return validateExecutionReceipt({
        runId,
        status,
        exitCode,
        stdout: outCut.text,
        stderr: errCut.text,
        startedAt,
        completedAt,
        durationMs,
        backend: this.id,
        snapshotHash: request.snapshotHash,
        checkHash: request.checkHash,
        truncated,
        evidencePath: null,
        reasons,
      });
    } catch (err) {
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;
      const isCancelled = abortController.signal.aborted;

      if (err?.code === 'unsupported_limit') {
        throw err;
      }

      return validateExecutionReceipt({
        runId,
        status: isCancelled ? 'cancelled' : 'error',
        exitCode: null,
        stdout: '',
        stderr: err?.message || String(err),
        startedAt,
        completedAt,
        durationMs,
        backend: this.id,
        snapshotHash: request.snapshotHash,
        checkHash: request.checkHash,
        truncated: false,
        evidencePath: null,
        reasons: [err?.message || 'Host execution encountered an unhandled error'],
      });
    } finally {
      if (signal) signal.removeEventListener('abort', onParentAbort);
      if (this.activeRuns.get(runId) === abortController) {
        this.activeRuns.delete(runId);
      }
    }
  }

  async cancel(runId) {
    const active = this.activeRuns.get(runId);
    if (active) {
      active.abort(new Error(`Execution ${runId} was cancelled.`));
      this.activeRuns.delete(runId);
      return true;
    }
    return false;
  }
}

/**
 * Windows Sandbox placeholder provider for PR 1.
 *
 * Reports available: false until the real feasibility & transport gate lands in PR 2/3.
 */
export class WindowsSandboxPlaceholderBackend extends ExecutionBackend {
  constructor({ platform = process.platform } = {}) {
    super('windows-sandbox');
    this.platform = platform;
  }

  getStaticCapabilityReport() {
    return validateCapabilityReport({
      backend: 'windows-sandbox',
      available: false,
      osIsolated: true,
      platform: 'win32',
      networkPolicy: 'denied',
      writeScope: 'guest-ephemeral',
      concurrency: 1,
      enforcedLimits: [],
      unsupportedLimits: ['timeoutSeconds', 'maxOutputBytes', 'maxMemoryMb', 'maxCpuCores', 'customEnv'],
      reasons: [
        'Windows Sandbox execution provider is not implemented in PR 1 (feasibility gate prerequisite for PR 2/3)',
        'Windows Sandbox guest supervisor and execution transport are not yet provisioned',
        'No isolation capabilities or limits have been verified on this machine',
      ],
      observedAt: new Date().toISOString(),
    });
  }

  async probe() {
    return this.getStaticCapabilityReport();
  }

  async execute(request, { signal } = {}) {
    const startedAt = new Date().toISOString();
    return validateExecutionReceipt({
      runId: request.runId,
      status: 'isolation_unavailable',
      exitCode: null,
      stdout: '',
      stderr: 'Windows Sandbox provider is unavailable in PR 1.',
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      backend: this.id,
      snapshotHash: request.snapshotHash,
      checkHash: request.checkHash,
      truncated: false,
      evidencePath: null,
      reasons: [
        'Windows Sandbox execution provider is not implemented in PR 1 (feasibility gate prerequisite for PR 2/3)',
      ],
    });
  }

  async cancel(runId) {
    return false;
  }
}

/**
 * Execution Registry that manages backends and dispatches execution requests fail-closed.
 */
export class ExecutionRegistry {
  constructor({ maxCapabilityAgeMs = 30000, now = () => Date.now(), defaultGate = null } = {}) {
    if (defaultGate && !(defaultGate instanceof PermissionGate)) {
      throw fault('invalid_permission_gate', 'defaultGate must be an authoritative PermissionGate instance.', 400);
    }
    this.backends = new Map();
    this.cachedReports = new Map();
    this.activeRuns = new Map();
    this.maxCapabilityAgeMs = maxCapabilityAgeMs;
    this.now = now;
    this.permissionGate = defaultGate;
  }

  attachPermissionGate(gate) {
    if (gate && !(gate instanceof PermissionGate)) {
      throw fault('invalid_permission_gate', 'permissionGate must be an authoritative PermissionGate instance.', 400);
    }
    this.permissionGate = gate;
  }

  register(backend) {
    if (!(backend instanceof ExecutionBackend)) {
      throw fault('invalid_backend', 'Registered backend must inherit from ExecutionBackend.');
    }
    this.backends.set(backend.id, backend);
    this.cachedReports.delete(backend.id);
  }

  get(id) {
    return this.backends.get(id) || null;
  }

  has(id) {
    return this.backends.has(id);
  }

  list() {
    return [...this.backends.keys()];
  }

  async getCapabilityReport(id, { maxAgeMs = this.maxCapabilityAgeMs, force = false } = {}) {
    const backend = this.get(id);
    if (!backend) {
      throw fault('unknown_backend', `Backend '${id}' is not registered.`, 404);
    }
    const cached = this.cachedReports.get(id);
    const nowMs = this.now();
    if (!force && cached && (nowMs - cached.cachedAt) < maxAgeMs) {
      return cached.report;
    }
    const report = await backend.probe();
    const validated = validateCapabilityReport(report);
    this.cachedReports.set(id, { report: validated, cachedAt: nowMs });
    return validated;
  }

  async probeAll({ maxAgeMs = this.maxCapabilityAgeMs, force = false } = {}) {
    const reports = {};
    for (const id of this.backends.keys()) {
      reports[id] = await this.getCapabilityReport(id, { maxAgeMs, force });
    }
    return reports;
  }

  async cancel(runId, backendId = null) {
    if (backendId) {
      const backend = this.get(backendId);
      return backend ? backend.cancel(runId) : false;
    }
    const trackedBackendId = this.activeRuns.get(runId);
    if (trackedBackendId) {
      const backend = this.get(trackedBackendId);
      if (backend) {
        const cancelled = await backend.cancel(runId);
        if (cancelled) return true;
      }
    }
    let anyCancelled = false;
    for (const backend of this.backends.values()) {
      const res = await backend.cancel(runId);
      if (res) anyCancelled = true;
    }
    return anyCancelled;
  }

  /**
   * Dispatches an ExecutionRequest fail-closed:
   *
   * 1. Validates request structure.
   * 2. Rejects duplicate active runIds across the registry.
   * 3. Rejects unknown backends without falling back to host.
   * 4. Probes capabilities (re-probing if stale).
   * 5. Fails closed if backend is unavailable.
   * 6. Fails closed with 'isolation_unavailable' if OS isolation is required but unavailable.
   * 7. Fails closed if any required resource limit is not strictly enforced by the backend.
   * 8. Fail-closed: Authoritative permission check (untrusted execution requires gate; forged gates rejected).
   * 9. Executes via verified backend only.
   *
   * @param {object} requestInput
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {object} [options.permissionGate]
   * @param {string} [options.taskId]
   * @param {boolean} [options.trustedInternal=false]
   * @param {string[]} [options.requiredLimits]
   * @returns {Promise<ExecutionReceipt>}
   */
  async dispatch(requestInput, { signal, permissionGate = null, taskId = null, trustedInternal = false, requiredLimits = [] } = {}) {
    const request = validateExecutionRequest(requestInput);
    const startedAt = new Date(this.now()).toISOString();

    if (this.activeRuns.has(request.runId)) {
      throw fault('duplicate_run_id', `Execution run '${request.runId}' is already active in registry.`, 409);
    }

    // 1. Identify target backend
    const targetBackendId = request.backend || (request.isolationRequired ? 'windows-sandbox' : 'host');
    const backend = this.get(targetBackendId);
    if (!backend) {
      throw fault('unknown_backend', `Backend '${targetBackendId}' is not registered.`, 404);
    }

    this.activeRuns.set(request.runId, targetBackendId);

    try {
      // 2. Cancellation check before doing work
      if (signal?.aborted) {
        return validateExecutionReceipt({
          runId: request.runId,
          status: 'cancelled',
          exitCode: null,
          stdout: '',
          stderr: signal.reason ? String(signal.reason) : 'Execution cancelled before dispatch.',
          startedAt,
          completedAt: startedAt,
          durationMs: 0,
          backend: targetBackendId,
          snapshotHash: request.snapshotHash,
          checkHash: request.checkHash,
          truncated: false,
          evidencePath: null,
          reasons: ['Aborted by caller before launch'],
        });
      }

      // 3. Obtain capability report (re-probing if stale)
      let report;
      try {
        report = await this.getCapabilityReport(targetBackendId);
      } catch (err) {
        throw fault('backend_probe_failed', `Failed to probe backend '${targetBackendId}': ${err.message}`, 500);
      }

      // 4. Fail-closed: Check backend availability
      if (!report.available) {
        if (request.isolationRequired) {
          return validateExecutionReceipt({
            runId: request.runId,
            status: 'isolation_unavailable',
            exitCode: null,
            stdout: '',
            stderr: `Target backend '${targetBackendId}' is not available.`,
            startedAt,
            completedAt: startedAt,
            durationMs: 0,
            backend: targetBackendId,
            snapshotHash: request.snapshotHash,
            checkHash: request.checkHash,
            truncated: false,
            evidencePath: null,
            reasons: report.reasons.length > 0 ? report.reasons : [`Backend '${targetBackendId}' is unavailable`],
          });
        }
        throw fault(
          'backend_unavailable',
          `Backend '${targetBackendId}' is currently unavailable: ${report.reasons.join('; ')}`,
          503
        );
      }

      // 5. Fail-closed: Check OS isolation requirement
      if (request.isolationRequired && !report.osIsolated) {
        return validateExecutionReceipt({
          runId: request.runId,
          status: 'isolation_unavailable',
          exitCode: null,
          stdout: '',
          stderr: `Execution requires OS isolation, but backend '${targetBackendId}' is not OS-isolated.`,
          startedAt,
          completedAt: startedAt,
          durationMs: 0,
          backend: targetBackendId,
          snapshotHash: request.snapshotHash,
          checkHash: request.checkHash,
          truncated: false,
          evidencePath: null,
          reasons: ['Backend does not provide OS isolation', ...report.reasons],
        });
      }

      // 6. Fail-closed: Check required resource limits
      // Limit must be explicitly in enforcedLimits and NOT in unsupportedLimits
      const allRequiredLimits = new Set([
        ...(request.requiredLimits || []),
        ...(requiredLimits || []),
      ]);

      for (const reqLimit of allRequiredLimits) {
        if (!report.enforcedLimits.includes(reqLimit) || report.unsupportedLimits.includes(reqLimit)) {
          throw fault(
            'unsupported_limit',
            `Required resource limit '${reqLimit}' is not supported or enforced by backend '${targetBackendId}'.`,
            400
          );
        }
      }

      // 7. Fail-closed: Authoritative permission check
      let gate = this.permissionGate;
      if (permissionGate) {
        if (!(permissionGate instanceof PermissionGate)) {
          throw fault('invalid_permission_gate', 'permissionGate must be an authoritative PermissionGate instance.', 400);
        }
        if (this.permissionGate && permissionGate !== this.permissionGate) {
          throw fault('unauthorized_gate_override', 'Cannot override registry authoritative PermissionGate with another gate instance.', 403);
        }
        gate = permissionGate;
      }

      if (gate) {
        const auth = await gate.authorize({
          name: 'local.run_command',
          args: { command: request.command, cwd: request.cwd, isolationRequired: request.isolationRequired },
          taskId: taskId || request.runId,
          signal,
        });
        if (!auth.allowed) {
          return validateExecutionReceipt({
            runId: request.runId,
            status: 'blocked',
            exitCode: null,
            stdout: '',
            stderr: `Permission denied: ${auth.reason}`,
            startedAt,
            completedAt: startedAt,
            durationMs: 0,
            backend: targetBackendId,
            snapshotHash: request.snapshotHash,
            checkHash: request.checkHash,
            truncated: false,
            evidencePath: null,
            reasons: [auth.reason],
          });
        }
      } else if (!trustedInternal) {
        return validateExecutionReceipt({
          runId: request.runId,
          status: 'blocked',
          exitCode: null,
          stdout: '',
          stderr: 'Permission gate missing: untrusted execution requires an authoritative PermissionGate or explicit trustedInternal authorization.',
          startedAt,
          completedAt: startedAt,
          durationMs: 0,
          backend: targetBackendId,
          snapshotHash: request.snapshotHash,
          checkHash: request.checkHash,
          truncated: false,
          evidencePath: null,
          reasons: ['Untrusted execution requires an authoritative PermissionGate or explicit trustedInternal authorization'],
        });
      }

      // 8. Execute via target backend
      return await backend.execute(request, { signal });
    } finally {
      this.activeRuns.delete(request.runId);
    }
  }
}

/**
 * Creates default ExecutionRegistry populated with Host backend and Windows Sandbox placeholder.
 */
export function createDefaultExecutionRegistry({
  workspaceRoot,
  workspace = null,
  shellRunner = null,
  limits = {},
  permissionGate = null,
} = {}) {
  const registry = new ExecutionRegistry({ defaultGate: permissionGate });
  const hostBackend = new HostExecutionBackend({ workspaceRoot, workspace, shellRunner, limits });
  const sandboxBackend = new WindowsSandboxPlaceholderBackend();
  registry.register(hostBackend);
  registry.register(sandboxBackend);
  return registry;
}
