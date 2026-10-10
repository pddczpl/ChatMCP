// Hardened Git invocation for the agent's git tools.
//
// A repository can carry configuration that makes ordinary read-only commands run programs
// (core.fsmonitor, diff drivers, hooks, pagers, editors). Every call therefore overrides those
// settings on the command line, runs with a scrubbed environment and without interactive prompts,
// and is pinned to the selected workspace: a repository that merely contains the workspace is
// refused instead of being modified.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { resolveProgram } from './runtime.mjs';
import { killTree, scrubEnv } from './shell-runner.mjs';
import { inspectGitSafety, refusalsForRunner } from './git-trust.mjs';

const fault = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

// Variables that would silently point Git at another repository or make it run a program.
const REDIRECTING_ENV = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
  'GIT_NAMESPACE', 'GIT_EXTERNAL_DIFF', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
]);

const REVISION = /^[A-Za-z0-9_.\/@~^{}-]{1,200}$/;
/** A single revision such as main, HEAD~2 or a hash; never an option, a range or `rev:path`. */
export function isSafeRevision(value) {
  return typeof value === 'string' && REVISION.test(value) && !value.startsWith('-') && !value.includes('..') && !value.includes('@{-');
}

export class GitRunner {
  constructor({ workspace, hooksDirectory, env = process.env, secrets = () => [] } = {}) {
    if (!workspace || typeof workspace.resolve !== 'function') throw new TypeError('GitRunner cần workspace có resolve().');
    if (!hooksDirectory) throw new TypeError('GitRunner cần hooksDirectory (thư mục rỗng dùng để tắt hook).');
    this.workspace = workspace;
    this.hooksDirectory = hooksDirectory;
    this.env = env;
    this.secrets = secrets;
    this.exe = null;
  }

  async executable() {
    this.exe ??= await resolveProgram(process.platform === 'win32' ? 'git.exe' : 'git');
    return this.exe;
  }

  /**
   * Runs git in the workspace root. Resolves for any exit code; throws for missing Git, cancellation
   * and spawn failures. `hooks: true` leaves the repository's hooks enabled (they run arbitrary code).
   * `writes: true` lets Git take its optional index lock; read-only calls never touch the index.
   */
  async exec(args, { signal, timeoutMs = 30_000, maxBytes = 2_000_000, hooks = false, writes = false } = {}) {
    signal?.throwIfAborted();
    const exe = await this.executable();
    if (!exe) throw fault('git_missing', 'Không tìm thấy Git trong PATH. Cài Git (https://git-scm.com/) rồi mở lại Hub.', 503);
    const { root } = await this.workspace.resolve('');
    // Settings that name a program and that the flags below cannot switch off (a clean filter runs even for `git status`).
    const refused = refusalsForRunner(await inspectGitSafety(root, { hooks: false }));
    if (refused.length) throw fault('git_config_untrusted', `Cấu hình Git của kho này (.git/config) có mục chạy chương trình: ${refused.slice(0, 5).join(', ')}. Hub không chạy Git khi chưa kiểm tra để tránh thực thi mã của kho. Xem và xóa các mục đó nếu bạn tin tưởng kho, hoặc tự dùng terminal.`, 409);
    const prefix = ['-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'core.quotepath=false', '-c', 'core.editor=true', '-c', 'diff.external=', '-c', 'color.ui=false'];
    if (!hooks) {
      await fs.mkdir(this.hooksDirectory, { recursive: true });
      prefix.push('-c', `core.hooksPath=${this.hooksDirectory.replaceAll('\\', '/')}`);
    }
    const env = scrubEnv(this.env, { secrets: this.secrets() ?? [] });
    for (const key of Object.keys(env)) if (REDIRECTING_ENV.has(key.toUpperCase())) delete env[key];
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_PAGER: 'cat', GIT_EDITOR: 'true', LC_MESSAGES: 'C', LANGUAGE: 'en' });
    if (!writes) env.GIT_OPTIONAL_LOCKS = '0';

    const child = spawn(exe, [...prefix, ...args], {
      cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const out = [];
    const err = [];
    let total = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    const collect = (list) => (chunk) => {
      if (truncated) return;
      total += chunk.length;
      if (total > maxBytes) { truncated = true; killTree(child); return; }
      list.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (aborted) throw signal.reason ?? fault('cancelled', 'Tác vụ đã dừng.');
      return { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), truncated, timedOut };
    } catch (error) {
      if (error?.code === 'ENOENT') throw fault('git_missing', 'Không chạy được Git (không tìm thấy chương trình).', 503);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Like exec() but decodes the streams. */
  async text(args, options) {
    const result = await this.exec(args, options);
    return { ...result, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
  }

  /** Verifies the workspace root is itself the top level of a repository and returns that root. */
  async ensureRepo(options = {}) {
    const { root } = await this.workspace.resolve('');
    const result = await this.text(['rev-parse', '--show-toplevel'], { ...options, timeoutMs: 10_000 });
    if (result.code !== 0) {
      const hint = /dubious ownership/i.test(result.stderr) ? ' Git từ chối vì thư mục thuộc người dùng khác ("dubious ownership").' : '';
      throw fault('not_git_repo', `Workspace chưa phải kho Git.${hint} Khởi tạo bằng run_command "git init" nếu cần.`, 409);
    }
    const top = await fs.realpath(result.stdout.trim()).catch(() => null);
    const same = top && (top === root || (process.platform === 'win32' && top.toLowerCase() === root.toLowerCase()));
    if (!same) throw fault('git_root_mismatch', `Kho Git nằm ở thư mục cha (${top ?? 'không xác định'}); workspace phải chính là gốc của kho. Công cụ git không thao tác trên kho cha.`, 409);
    return root;
  }
}
