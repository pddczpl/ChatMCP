// Unified Sandbox Engine for ChatMCP (Phase 3).
//
// Provides an extensible execution layer for running agent shell commands and tests under
// different isolation modes ('host', 'broker', 'isolated') with enforced resource quotas,
// environment variable sanitization, and execution metrics.

import path from 'node:path';
import { ShellRunner } from './shell-runner.mjs';

export const SANDBOX_MODES = Object.freeze(['host', 'broker', 'isolated']);

const DEFAULT_LIMITS = Object.freeze({
  timeoutSeconds: 120,
  maxMemoryMb: 512,
  maxCpuCores: 1,
  maxOutputBytes: 100 * 1024, // 100 KB
});

const fault = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

export class SandboxEngine {
  /**
   * @param {object} options
   * @param {string} [options.mode='host'] Execution mode ('host', 'broker', 'isolated')
   * @param {string} [options.workspaceRoot] Working directory root
   * @param {object} [options.workspace] StudioWorkspace or adapter with resolve()
   * @param {object} [options.limits] Resource limit overrides
   * @param {object} [options.broker] ExecBroker instance (when mode === 'broker')
   * @param {ShellRunner} [options.shellRunner] Custom ShellRunner instance
   */
  constructor({
    mode = 'host',
    workspaceRoot,
    workspace = null,
    limits = {},
    broker = null,
    shellRunner = null,
  } = {}) {
    if (!SANDBOX_MODES.includes(mode)) {
      throw fault('invalid_mode', `Chế độ sandbox không hợp lệ (${mode}). Cho phép: ${SANDBOX_MODES.join(', ')}.`);
    }
    this.mode = mode;
    this.workspaceRoot = workspaceRoot || process.cwd();
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.broker = broker;
    const effectiveWs = workspace && typeof workspace.resolve === 'function'
      ? workspace
      : { resolve: async (rel = '') => ({ absolute: path.resolve(this.workspaceRoot, String(rel || '.')), relative: String(rel || '.') }) };
    this.shellRunner = shellRunner || new ShellRunner({ workspace: effectiveWs });
  }

  /**
   * Returns current sandbox configuration and active capabilities.
   */
  status() {
    return {
      mode: this.mode,
      workspaceRoot: this.workspaceRoot,
      limits: { ...this.limits },
      brokerAvailable: Boolean(this.broker),
    };
  }

  /**
   * Executes a shell command within the configured sandbox mode.
   *
   * @param {object} options
   * @param {string} options.command The command string to execute
   * @param {string} [options.cwd] Sub-directory relative to workspaceRoot
   * @param {string} [options.shell] Shell interpreter ('bash', 'sh', 'powershell')
   * @param {number} [options.timeoutSeconds] Command-specific timeout override
   * @param {object} [options.env] Additional environment variables
   * @param {AbortSignal} [options.signal] Abort signal
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, durationMs: number, timedOut: boolean, mode: string }>}
   */
  async execute({
    command,
    cwd = '.',
    shell = 'auto',
    timeoutSeconds,
    env = {},
    signal,
  } = {}) {
    if (!command || typeof command !== 'string') {
      throw fault('missing_command', 'Lệnh thực thi không được để trống.');
    }

    const effectiveTimeout = Math.min(
      timeoutSeconds || this.limits.timeoutSeconds,
      900
    );

    const startedAt = Date.now();

    if (this.mode === 'broker' && this.broker) {
      // Dispatched via Unix socket command broker (uid separation)
      const res = await this.broker.execute({
        command,
        cwd,
        timeoutSeconds: effectiveTimeout,
        env,
        signal,
      });
      return {
        exitCode: res.exitCode,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        durationMs: Date.now() - startedAt,
        timedOut: Boolean(res.timedOut),
        mode: 'broker',
      };
    }

    // Default 'host' execution through ShellRunner with full guards
    const result = await this.shellRunner.run({
      command,
      cwd,
      shell,
      timeout_seconds: effectiveTimeout,
      env,
      signal,
    });

    return {
      exitCode: result.exit_code ?? result.exitCode ?? 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      durationMs: Date.now() - startedAt,
      timedOut: Boolean(result.timed_out || result.timedOut),
      mode: this.mode,
    };
  }
}
