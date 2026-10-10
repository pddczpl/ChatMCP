// Runs one non-interactive shell command for the agent and reports what really happened.
//
//  * Windows: Git Bash when installed (bash semantics are what models know best), otherwise
//    Windows PowerShell. PowerShell receives its script as -EncodedCommand (UTF-16LE base64), so
//    nested double quotes, '$', backticks and non-ASCII text arrive intact; very long scripts go
//    through a temporary .ps1 file. Git Bash always receives the command as a script file, which
//    sidesteps Windows command-line quoting entirely.
//  * POSIX: bash if present, otherwise sh.
//  * stdin is closed, the environment is scrubbed of credential-looking variables, output is
//    bounded (head + tail), and timeout / cancellation kill the whole process tree.
//
// The runner never decides whether a command is allowed: that is PermissionGate's job.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exists, resolveProgram } from './runtime.mjs';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 900_000;
export const DEFAULT_OUTPUT_BYTES = 200_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_COMMAND_CHARS = 60_000;
const ARGV_COMMAND_LIMIT = 6000;
const KILL_GRACE_MS = 4000;
const LINGER_MS = 1500;

export const SECRET_ENV_NAME = /(?:^|_)(?:API_?KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|ACCESS_?KEY|AUTH|SESSION_?KEY)(?:_|$)/i;
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const KEEP_ENV = new Set(['SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'GIT_ASKPASS', 'SSH_ASKPASS']);

const fault = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

/** Copy of `env` without credential-looking variables or values equal to a registered secret. */
export function scrubEnv(env, { keep = [], secrets = [] } = {}) {
  const keepSet = new Set([...KEEP_ENV, ...keep].map((name) => String(name).toUpperCase()));
  const needles = secrets.filter((secret) => typeof secret === 'string' && secret.length >= 6);
  const output = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!keepSet.has(key.toUpperCase()) && SECRET_ENV_NAME.test(key)) continue;
    const text = String(value);
    if (URL_WITH_PASSWORD.test(text)) continue;
    if (needles.some((secret) => text.includes(secret))) continue;
    output[key] = value;
  }
  return output;
}

/** Keeps the first 60% and the last 40% of a byte budget, and counts what was dropped. */
export class BoundedCapture {
  constructor(limit) {
    this.headLimit = Math.max(1, Math.floor(limit * 0.6));
    this.tailLimit = Math.max(1, limit - this.headLimit);
    this.head = [];
    this.headBytes = 0;
    this.tail = [];
    this.tailBytes = 0;
    this.total = 0;
  }

  push(chunk) {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headBytes < this.headLimit) {
      const take = Math.min(rest.length, this.headLimit - this.headBytes);
      this.head.push(rest.subarray(0, take));
      this.headBytes += take;
      rest = rest.subarray(take);
    }
    if (!rest.length) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    if (this.tailBytes > this.tailLimit * 2) {
      const merged = Buffer.concat(this.tail);
      this.tail = [merged.subarray(merged.length - this.tailLimit)];
      this.tailBytes = this.tail[0].length;
    }
  }

  result() {
    let tail = Buffer.concat(this.tail);
    if (tail.length > this.tailLimit) tail = tail.subarray(tail.length - this.tailLimit);
    const head = Buffer.concat(this.head);
    const omitted = this.total - head.length - tail.length;
    const decode = (buffer) => buffer.toString('utf8');
    if (omitted <= 0) return { text: decode(Buffer.concat([head, tail])), truncated: false, omitted: 0, totalBytes: this.total };
    return { text: `${decode(head)}\n[... đã lược ${omitted} byte ở giữa đầu ra ...]\n${decode(tail)}`, truncated: true, omitted, totalBytes: this.total };
  }
}

/** Kills a spawned shell and everything it started (never anything outside that tree). */
export function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.once('error', () => { try { child.kill(); } catch { /* already gone */ } });
  } else {
    // The child leads its own process group (detached), so -pid reaches its descendants only.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

const PS_PRELUDE = [
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; [Console]::InputEncoding = [Console]::OutputEncoding; $OutputEncoding = [Console]::OutputEncoding } catch {}',
  '$global:LASTEXITCODE = $null',
  '',
].join('\n');
// Exit status follows the last statement, like a normal shell: a native command's own code when it
// failed, 1 for a failed cmdlet, 0 otherwise. `exit N` inside the command still wins.
const PS_EPILOGUE = [
  '',
  '$__chatmcp_ok = $?',
  'if (-not $__chatmcp_ok) { if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 } }',
  'exit 0',
].join('\n');

/** Script text executed by PowerShell for one agent command. */
export const wrapPowerShell = (command) => `${PS_PRELUDE}${command}${PS_EPILOGUE}`;

/** Windows PowerShell can serialize its streams as CLIXML when redirected; turn that back into text. */
export function decodeClixml(text) {
  if (typeof text !== 'string' || !text.startsWith('#< CLIXML')) return text;
  const unescape = (value) => value
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const pieces = [...text.matchAll(/<S S="(?:Error|Output|Warning|Verbose|Debug)">([\s\S]*?)<\/S>/g)].map((match) => unescape(match[1]));
  return pieces.join('').replace(/\r\n/g, '\n').trimEnd();
}

async function findGitBash(env, platform) {
  if (platform !== 'win32') return null;
  const candidates = [];
  if (env.CHATMCP_BASH) candidates.push(env.CHATMCP_BASH);
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  }
  const git = await resolveProgram('git.exe');
  if (git) candidates.push(path.join(path.dirname(git), '..', 'bin', 'bash.exe'), path.join(path.dirname(git), '..', '..', 'bin', 'bash.exe'));
  for (const candidate of candidates) {
    // C:\Windows\System32\bash.exe is the WSL launcher, never Git Bash.
    if (/[\\/]system32[\\/]/i.test(candidate)) continue;
    if (await exists(candidate)) return path.resolve(candidate);
  }
  return null;
}

async function findPowerShell(env, platform) {
  if (platform === 'win32') {
    const system = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (await exists(system)) return system;
    return await resolveProgram('powershell.exe');
  }
  return await resolveProgram('pwsh');
}

export class ShellRunner {
  /**
   * @param {object} options
   * @param {{resolve: Function}} options.workspace   StudioWorkspace-like object (resolve(relative) -> {absolute, relative})
   * @param {string|null} options.stateDirectory      where temporary script files are written (default: OS temp)
   * @param {() => string[]} options.secrets           registered secret values to keep out of the child's environment
   * @param {'auto'|'argv'|'file'} options.bashTransport  how bash/sh receive the command (default: file on Windows)
   */
  constructor({ workspace, stateDirectory = null, env = process.env, platform = process.platform, secrets = () => [], keepEnv = [], bashTransport = null } = {}) {
    if (!workspace || typeof workspace.resolve !== 'function') throw new TypeError('ShellRunner cần workspace có resolve().');
    this.workspace = workspace;
    this.stateDirectory = stateDirectory;
    this.env = env;
    this.platform = platform;
    this.secrets = secrets;
    this.keepEnv = keepEnv;
    this.bashTransport = bashTransport ?? (platform === 'win32' ? 'file' : 'auto');
    this.active = new Set();
    this.discovered = null;
  }

  /** Detects the available shells once. */
  async info() {
    if (!this.discovered) {
      const win = this.platform === 'win32';
      const bash = win ? await findGitBash(this.env, this.platform) : (await resolveProgram('bash')) ?? ((await exists('/bin/bash')) ? '/bin/bash' : null);
      const sh = win ? null : ((await exists('/bin/sh')) ? '/bin/sh' : await resolveProgram('sh'));
      const powershell = await findPowerShell(this.env, this.platform);
      const defaultShell = bash ? 'bash' : win ? (powershell ? 'powershell' : null) : (sh ? 'sh' : null);
      this.discovered = { platform: this.platform, defaultShell, shells: { bash, sh, powershell } };
    }
    return structuredClone(this.discovered);
  }

  /** Chooses the shell for a request (explicit or default) or explains why it is unavailable. */
  async resolveShell(requested) {
    const info = await this.info();
    let name = !requested || requested === 'auto' ? info.defaultShell : requested === 'pwsh' ? 'powershell' : requested;
    if (!name) throw fault('no_shell', 'Không tìm thấy shell nào (cần bash/sh hoặc PowerShell).', 503);
    if (!['bash', 'sh', 'powershell'].includes(name)) throw fault('bad_shell', 'shell phải là bash, sh hoặc powershell.');
    let file = info.shells[name];
    if (!file && name === 'sh' && info.shells.bash) { name = 'bash'; file = info.shells.bash; } // Git Bash also provides sh
    if (!file) throw fault('shell_unavailable', `Shell "${name}" không có trên máy này. Dùng: ${Object.entries(info.shells).filter(([, value]) => value).map(([key]) => key).join(', ') || 'không có'}.`, 409);
    return { name, file };
  }

  async #scriptFile(extension, content, encoding) {
    const directory = this.stateDirectory ? path.join(this.stateDirectory, 'shell-scripts') : path.join(os.tmpdir(), `chatmcp-shell-${process.pid}`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `cmd-${randomUUID()}${extension}`);
    await fs.writeFile(file, encoding === 'bom' ? `\uFEFF${content}` : content, { mode: 0o600 });
    return file;
  }

  /** Builds the executable + arguments for a command; the shape is stable so tests can inspect it. */
  async buildInvocation(shell, command) {
    if (shell.name === 'powershell') {
      const script = wrapPowerShell(command);
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const base = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text'];
      if (encoded.length <= ARGV_COMMAND_LIMIT) return { file: shell.file, args: [...base, '-EncodedCommand', encoded], transport: 'encoded' };
      const scriptFile = await this.#scriptFile('.ps1', script, 'bom');
      return { file: shell.file, args: [...base, '-File', scriptFile], transport: 'file', cleanup: () => fs.unlink(scriptFile).catch(() => {}) };
    }
    const useArgv = this.bashTransport === 'argv' || (this.bashTransport === 'auto' && command.length <= ARGV_COMMAND_LIMIT);
    if (useArgv) return { file: shell.file, args: ['-c', command], transport: 'argv' };
    const scriptFile = await this.#scriptFile('.sh', `${command.replace(/\r\n/g, '\n')}\n`, 'plain');
    const target = this.platform === 'win32' ? scriptFile.replaceAll('\\', '/') : scriptFile;
    return { file: shell.file, args: [target], transport: 'file', cleanup: () => fs.unlink(scriptFile).catch(() => {}) };
  }

  #environment(shellName) {
    const env = scrubEnv(this.env, { keep: this.keepEnv, secrets: this.secrets() ?? [] });
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    if (this.platform === 'win32' && shellName !== 'powershell') Object.assign(env, { MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*', CHERE_INVOKING: '1' });
    return env;
  }

  /**
   * Run `command`. Resolves (never rejects) for process-level outcomes: non-zero exit, timeout and
   * cancellation are reported in the result; invalid input and an unavailable shell throw.
   */
  async run({ command, cwd = '', timeoutMs = DEFAULT_TIMEOUT_MS, shell, signal, maxOutputBytes = DEFAULT_OUTPUT_BYTES } = {}) {
    if (typeof command !== 'string' || !command.trim()) throw fault('bad_command', 'Cần lệnh shell không rỗng.');
    if (command.length > MAX_COMMAND_CHARS || command.includes('\0')) throw fault('bad_command', `Lệnh quá dài (tối đa ${MAX_COMMAND_CHARS} ký tự) hoặc chứa ký tự NUL.`);
    signal?.throwIfAborted();
    const limit = Math.max(1000, Math.min(2_000_000, Number(maxOutputBytes) || DEFAULT_OUTPUT_BYTES));
    const timeout = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const target = await this.workspace.resolve(cwd || '');
    const stat = await fs.stat(target.absolute).catch(() => null);
    if (!stat?.isDirectory()) throw fault('bad_cwd', `Thư mục chạy lệnh không tồn tại: ${target.relative || '.'}`, 404);
    const chosen = await this.resolveShell(shell);
    const invocation = await this.buildInvocation(chosen, command);
    const started = Date.now();
    const stdout = new BoundedCapture(limit);
    const stderr = new BoundedCapture(Math.max(1000, Math.floor(limit / 2)));
    const state = { timedOut: false, cancelled: false, stuck: false, spawnError: null };

    let child;
    try {
      child = spawn(invocation.file, invocation.args, {
        cwd: target.absolute, env: this.#environment(chosen.name), shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], detached: this.platform !== 'win32',
      });
    } catch (error) {
      await invocation.cleanup?.();
      throw fault('spawn_failed', `Không khởi động được shell ${chosen.name}: ${error.message}`, 500);
    }
    this.active.add(child);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    // Output streams can keep emitting errors while we tear them down; they carry nothing useful.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    let exitInfo = null;
    let lingerTimer = null;
    let hardStopTimer = null;
    const destroyStreams = () => { child.stdout.destroy(); child.stderr.destroy(); };
    child.once('error', (error) => { state.spawnError = error; finish({ code: null, signal: null, lingering: false }); });
    // A background process that inherited our pipes would keep "close" from firing; give the
    // streams a moment to drain after the shell itself exited, then stop waiting for them.
    child.once('exit', (code, sig) => {
      exitInfo = { code, signal: sig };
      lingerTimer = setTimeout(() => { destroyStreams(); finish({ ...exitInfo, lingering: true }); }, LINGER_MS);
    });
    child.once('close', (code, sig) => finish({ ...(exitInfo ?? { code, signal: sig }), lingering: false }));

    const requestKill = (kind) => {
      if (kind === 'timeout') state.timedOut = true; else state.cancelled = true;
      killTree(child);
      hardStopTimer ??= setTimeout(() => { state.stuck = true; destroyStreams(); finish({ code: null, signal: 'SIGKILL', lingering: false }); }, KILL_GRACE_MS);
    };
    const timer = setTimeout(() => requestKill('timeout'), timeout);
    const onAbort = () => requestKill('abort');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    let exit;
    try {
      exit = await finished;
    } finally {
      clearTimeout(timer);
      clearTimeout(lingerTimer);
      clearTimeout(hardStopTimer);
      signal?.removeEventListener('abort', onAbort);
      this.active.delete(child);
      await invocation.cleanup?.();
    }
    if (state.spawnError) throw fault('spawn_failed', `Không khởi động được shell ${chosen.name}: ${state.spawnError.message}`, 500);
    const out = stdout.result();
    const err = stderr.result();
    const powershell = chosen.name === 'powershell';
    return {
      shell: chosen.name, transport: invocation.transport, cwd: target.relative || '.', pid: child.pid,
      exitCode: exit.code, signal: exit.signal, timedOut: state.timedOut, cancelled: state.cancelled, lingering: exit.lingering, stuck: state.stuck,
      durationMs: Date.now() - started,
      stdout: powershell ? decodeClixml(out.text) : out.text,
      stderr: powershell ? decodeClixml(err.text) : err.text,
      truncated: { stdout: out.truncated, stderr: err.truncated },
      outputBytes: { stdout: out.totalBytes, stderr: err.totalBytes },
    };
  }

  /** Kills every command that is still running (used when the Hub shuts down). */
  async close() {
    for (const child of [...this.active]) killTree(child);
    const until = Date.now() + 3000;
    while (this.active.size && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
