// In-process tool server for the local coding agent: files, search, Git and shell.
//
// Every path goes through StudioWorkspace.resolve() (real-path containment, no symlink escape,
// no NTFS alternate streams) and then through the shared protected-path rules, so the tools
// themselves refuse to touch .env files, private keys or .git even if a permission mode would
// have allowed the call. PermissionGate asks assess() what a call would do; call() does it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeCommand, categoryForKind, maxKind } from './command-analysis.mjs';
import { applyEol, canonicalRelative, decodeText, encodeText, isUnsafeWindowsName, sha256, splitLines, toLf, writeFileAtomic } from './fs-safe.mjs';
import { GitRunner, isSafeRevision } from './git-runner.mjs';
import { compileGlob } from './glob.mjs';
import { PRIVATE_DIRECTORIES, isProtectedPath } from './protected-paths.mjs';
import { describeProblem, pathProblems } from './command-paths.mjs';
import { gitRisksFor, gitSubcommand, inspectGitSafety } from './git-trust.mjs';
import { ShellRunner } from './shell-runner.mjs';
import { validateArguments } from './tool-schema.mjs';

export const LOCAL_SERVER = 'local';
export const LIMITS = Object.freeze({
  readBytes: 10 * 1024 * 1024, readLines: 2000, readChars: 200_000, lineChars: 2000,
  writeBytes: 2 * 1024 * 1024, editBytes: 4 * 1024 * 1024,
  listEntries: 400, listNested: 60, findResults: 500, searchMatches: 300, searchFileBytes: 1024 * 1024, searchMillis: 10_000, walkEntries: 40_000, regexLineChars: 1000,
  commandChars: 8000, diffChars: 200_000, logEntries: 100, commitMessageChars: 5000, checkpointFiles: 140,
});
// Folders that are listed but not searched or descended into unless include_ignored is set.
export const NOISE_DIRECTORIES = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'dist', 'build', 'target', 'coverage', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.tox', '.idea', '.vs', '.gradle', '.terraform', '.cache',
]);

const fault = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const posix = (value) => value.replaceAll('\\', '/');
const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const clip = (value, limit) => (value.length > limit ? `${value.slice(0, limit)}… [đã cắt ${value.length - limit} ký tự]` : value);
const ok = (value, structured = {}) => ({ isError: false, content: [{ type: 'text', text: value }], structuredContent: structured });
const failure = (code, message, extra = {}) => ({ isError: true, content: [{ type: 'text', text: `${code}: ${message}` }], structuredContent: { error: { code, message }, ...extra } });
const protectedError = (relative) => fault('protected_path', `Không cho phép truy cập "${relative}": đây là file bí mật (.env, khóa riêng, credentials...) hoặc metadata Git. Hãy nhờ người dùng tự xử lý file này.`, 403);

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });

const EXPECTED_SHA = str('SHA-256 of the file as you last read it (from read_file). The call is refused if the file changed since.', { minLength: 64, maxLength: 64 });

const FRIENDLY = {
  ENOENT: ['not_found', 'Không tìm thấy đường dẫn.', 404], EACCES: ['permission_denied', 'Không có quyền truy cập.', 403], EPERM: ['permission_denied', 'Hệ điều hành không cho phép thao tác này.', 403],
  EISDIR: ['is_directory', 'Đây là thư mục.', 400], ENOTDIR: ['not_directory', 'Một thành phần của đường dẫn không phải thư mục.', 400], ENOTEMPTY: ['not_empty', 'Thư mục không rỗng.', 409],
  EEXIST: ['already_exists', 'Đường dẫn đã tồn tại.', 409], EBUSY: ['file_locked', 'Đang bị chương trình khác khóa.', 423], ENOSPC: ['disk_full', 'Hết dung lượng đĩa.', 507],
};
function describeError(error, subject = '') {
  const known = FRIENDLY[error?.code];
  if (known && !error.statusCode) return { code: known[0], message: `${known[1]}${subject ? ` (${subject})` : ''}`, statusCode: known[2] };
  return { code: error?.code && typeof error.code === 'string' && /^[a-z0-9_]+$/.test(error.code) ? error.code : 'local_error', message: error?.message ?? String(error), statusCode: error?.statusCode ?? 500 };
}

const renderLine = (line, number) => `${String(number).padStart(6)}\t${line.length > LIMITS.lineChars ? `${line.slice(0, LIMITS.lineChars)} …[dòng quá dài, đã cắt]` : line}`;
const encodingLabel = (encoding) => ({ utf8: 'UTF-8', 'utf8-bom': 'UTF-8 BOM', utf16le: 'UTF-16LE' })[encoding] ?? encoding;
const eolLabel = (eol) => ({ lf: 'LF', crlf: 'CRLF', mixed: 'hỗn hợp', none: 'không có xuống dòng' })[eol] ?? eol;

/** Rejects regular expressions likely to backtrack catastrophically (the event loop cannot interrupt one). */
function assertSafeRegex(pattern) {
  if (pattern.length > 300) throw fault('bad_pattern', 'Regex tối đa 300 ký tự.');
  const flat = pattern.replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x').replace(/\(\?(?::|=|!|<=|<!|<\w+>)/g, '(');
  if (/\\[1-9]/.test(pattern)) throw fault('bad_pattern', 'Regex không được dùng backreference (\\1...). Dùng tìm kiếm chuỗi thường hoặc run_command với ripgrep.');
  if (/\([^()]*[|+*?{][^()]*\)\s*[+*{]/.test(flat)) throw fault('bad_pattern', 'Regex có nhóm lặp chứa lặp/lựa chọn (ví dụ (a+)+ hoặc (a|b)*) dễ làm treo tìm kiếm. Đơn giản hóa mẫu hoặc dùng chuỗi thường.');
  const unbounded = (flat.match(/[*+]|\{\d+,\}/g) ?? []).length;
  if (unbounded > 4) throw fault('bad_pattern', 'Regex có quá nhiều lặp không giới hạn (* hoặc +); giảm xuống tối đa 4.');
}

export class LocalTools {
  /**
   * @param {object} options
   * @param {object} options.workspace  StudioWorkspace (resolve(), plan())
   * @param {ShellRunner} [options.shell]
   * @param {GitRunner} [options.git]
   * @param {string} [options.stateDirectory]  Hub state directory (script files, empty hooks folder)
   * @param {() => string[]} [options.secrets]
   * @param {string[]} [options.disabledTools]  tools left out of the catalog (public server without a way to isolate commands: run_command)
   * @param {boolean} [options.sharedWorkspace] the agent's commands run under another account that shares a group with the Hub, so files
   *                                            the Hub writes keep group-write permission (the agent must be able to change them too)
   */
  constructor({ workspace, shell, git, stateDirectory = null, secrets = () => [], disabledTools = [], sharedWorkspace = false } = {}) {
    if (!workspace || typeof workspace.resolve !== 'function') throw new TypeError('LocalTools cần workspace có resolve().');
    this.workspace = workspace;
    this.stateDirectory = stateDirectory;
    this.shell = shell ?? new ShellRunner({ workspace, stateDirectory, secrets });
    this.git = git ?? new GitRunner({ workspace, hooksDirectory: path.join(stateDirectory ?? path.join(os.tmpdir(), `chatmcp-${process.pid}`), 'no-hooks'), secrets });
    this.tools = new Map();
    this.sharedWorkspace = sharedWorkspace;
    this.#register();
    for (const name of disabledTools) this.tools.delete(String(name).replace(/^local\./, ''));
    this.shellDisabled = !this.tools.has('run_command');
  }

  // ------------------------------------------------------------------ catalog
  definitions() {
    return [...this.tools.values()].map((tool) => ({
      name: `${LOCAL_SERVER}.${tool.name}`, originalName: tool.name, server: LOCAL_SERVER, description: tool.description,
      inputSchema: structuredClone(tool.schema), annotations: structuredClone(tool.annotations),
    }));
  }

  has(name) { return this.tools.has(String(name).replace(/^local\./, '')); }

  #lookup(name) { return this.tools.get(String(name).replace(/^local\./, '')); }

  /** What PermissionGate needs to know about a call before it runs: category, reason and a one-line summary. */
  async assess(name, args = {}) {
    const tool = this.#lookup(name);
    if (!tool) return { category: 'unknown', reason: 'Công cụ local không tồn tại.', summary: String(name) };
    const input = isObject(args) ? args : {};
    for (const key of tool.pathArgs ?? []) {
      const value = input[key];
      if (typeof value === 'string' && value && isProtectedPath(value)) {
        return { category: 'blocked', reason: `Đường dẫn bị chặn: "${value}" là file bí mật hoặc metadata Git.`, summary: tool.summary(input) };
      }
    }
    const verdict = typeof tool.category === 'function' ? await tool.category(input) : { category: tool.category, reason: tool.reason };
    return { category: verdict.category, reason: verdict.reason ?? tool.reason ?? '', summary: tool.summary(input), ...(verdict.risk ? { risk: verdict.risk } : {}), ...(verdict.command !== undefined ? { command: verdict.command } : {}) };
  }

  /** Checks arguments against the tool's schema without running anything, so an invalid call never asks for approval. */
  validate(name, args = {}) {
    const tool = this.#lookup(name);
    if (!tool) return { ok: false, code: 'unknown_tool', errors: [`Không có công cụ ${name}`] };
    const checked = validateArguments(tool.schema, args ?? {});
    return checked.ok ? { ok: true, errors: [] } : { ok: false, code: 'invalid_arguments', errors: checked.errors };
  }

  /** Existing files a call is about to change or delete, for a targeted pre-change checkpoint. */
  async touchedPaths(name, args = {}) {
    const op = String(name).replace(/^local\./, '');
    const input = isObject(args) ? args : {};
    const files = new Set();
    const addFile = async (value) => {
      if (typeof value !== 'string' || !value) return;
      const target = await this.workspace.resolve(path.isAbsolute(value) ? await this.#spellInsideRoot(value) : value);
      const stat = await fs.lstat(target.absolute).catch(() => null);
      if (!target.relative || !stat) return;
      if (stat.isFile() && !isProtectedPath(target.relative)) files.add(target.relative);
      else if (stat.isDirectory()) {
        for await (const file of this.#walk(target.absolute, target.root, { includeIgnored: true, state: { visited: 0 } })) {
          if (files.size >= LIMITS.checkpointFiles) break;
          files.add(file.rel);
        }
      }
    };
    try {
      if (op === 'write_file' || op === 'edit_file') await addFile(input.path);
      else if (op === 'move_path') { await addFile(input.source); await addFile(input.destination); }
      else if (op === 'delete_path') await addFile(input.path);
    } catch { /* an invalid path is reported by the call itself */ }
    return [...files].slice(0, LIMITS.checkpointFiles);
  }

  /**
   * Executes a tool. Resolves with {isError, content, structuredContent}; failures are results, not
   * exceptions. Cancellation rejects (the call was stopped before or while it ran), except run_command,
   * which resolves with `cancelled: true` and the output captured so far.
   */
  async call(name, args = {}, { taskId, signal } = {}) {
    signal?.throwIfAborted();
    const tool = this.#lookup(name);
    if (!tool) return failure('unknown_tool', `Không có công cụ ${name}.`, { executed: false });
    const checked = validateArguments(tool.schema, args ?? {});
    if (!checked.ok) return failure('invalid_arguments', `Tham số không hợp lệ cho ${tool.name}: ${checked.errors.join('; ')}.`, { executed: false, details: checked.errors });
    try {
      return await tool.run(checked.value, { taskId, signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const subject = ['path', 'source', 'cwd'].map((key) => checked.value[key]).find((value) => typeof value === 'string' && value) ?? '';
      const info = describeError(error, subject);
      return failure(info.code, info.message);
    }
  }

  /** Environment facts the UI shows during onboarding (never throws). */
  async diagnose() {
    const shells = this.shellDisabled
      ? { shells: {}, defaultShell: null, platform: process.platform } // no run_command, so the agent is told about no shell
      : await this.shell.info().catch(() => ({ shells: {}, defaultShell: null, platform: process.platform }));
    const git = await this.git.executable().catch(() => null);
    let version = null;
    if (git) {
      try { version = (await this.git.text(['--version'], { timeoutMs: 8000 })).stdout.trim(); } catch { /* reported as missing version */ }
    }
    return { platform: shells.platform, defaultShell: shells.defaultShell, shells: shells.shells, git: git ? { path: git, version } : null, node: process.version };
  }

  /** Mode for a file the Hub writes: unchanged normally; with a shared workspace the group keeps read/write. */
  #fileMode(mode) {
    if (!this.sharedWorkspace || process.platform === 'win32') return mode;
    return mode === undefined ? undefined : mode | 0o060;
  }

  // ------------------------------------------------------------------ path helpers
  async #target(value, { allowRoot = false, write = false } = {}) {
    let input = value === undefined || value === null ? '' : value;
    if (typeof input !== 'string') throw fault('bad_path', 'Đường dẫn phải là chuỗi.');
    if (!input && !allowRoot) throw fault('bad_path', 'Cần đường dẫn.');
    if (input && path.isAbsolute(input)) input = await this.#spellInsideRoot(input);
    const target = await this.workspace.resolve(input);
    const relative = target.relative;
    if (!relative && !allowRoot) throw fault('is_directory', 'Đường dẫn trỏ tới thư mục gốc workspace; cần một file hoặc thư mục con.');
    if (relative && process.platform === 'win32') {
      if (relative.includes(':')) throw fault('alternate_stream', 'Không hỗ trợ luồng dữ liệu thay thế (dấu ":") trong đường dẫn.', 403);
      for (const part of relative.split('/')) if (isUnsafeWindowsName(part)) throw fault('bad_name', `Tên "${part}" không hợp lệ trên Windows (tên thiết bị, dấu chấm/khoảng trắng ở cuối...).`);
    }
    if (relative && isProtectedPath(relative)) throw protectedError(relative);
    if (relative) {
      // A symlink, a junction or an 8.3 short name must not be a way around the name-based rule.
      // canonicalRelative() fails closed: if the real location cannot be determined, the call fails.
      const canonical = await canonicalRelative(target.root, target.absolute);
      if (!canonical.inside) throw fault('outside_workspace', `"${relative}" trỏ (qua symlink) ra ngoài workspace.`, 403);
      if (isProtectedPath(canonical.relative)) throw protectedError(relative);
    }
    if (write && !relative && !allowRoot) throw fault('bad_path', 'Không thể ghi vào thư mục gốc.');
    return target;
  }

  /**
   * An absolute path may spell the workspace differently from its real location (Windows 8.3 names such
   * as PHAND~1, a symlinked temp folder). Only the folder part is resolved: the last name stays as given,
   * so a symlink is still seen as a symlink. Anything unusual falls through to the normal checks.
   */
  async #spellInsideRoot(input) {
    const name = path.basename(input);
    const parent = path.dirname(input);
    if (!name || parent === input) return input;
    try {
      const { root } = await this.workspace.resolve('');
      const canonical = await canonicalRelative(root, parent);
      return canonical.inside ? path.join(root, canonical.relative, name) : input;
    } catch { return input; }
  }

  #decodeError(relative, reason) {
    if (reason === 'binary') return fault('binary_file', `"${relative}" là file nhị phân; công cụ chỉ làm việc với file văn bản.`, 415);
    if (reason === 'utf16be') return fault('unsupported_encoding', `"${relative}" là UTF-16BE; công cụ không đọc/sửa để tránh làm hỏng nội dung.`, 415);
    return fault('unsupported_encoding', `"${relative}" không phải UTF-8 (hoặc UTF-16LE có BOM) — có thể là mã hóa cũ như cp1252. Công cụ không đọc/sửa để tránh làm hỏng nội dung; dùng run_command (iconv, Get-Content -Encoding) nếu thật sự cần.`, 415);
  }

  /** Depth-first walk that never follows symlinks and skips Git internals, secrets and (optionally) noise folders. */
  async *#walk(startAbsolute, rootAbsolute, { includeIgnored = false, state, signal }) {
    const stack = [startAbsolute];
    while (stack.length) {
      signal?.throwIfAborted();
      const directory = stack.pop();
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const directories = [];
      for (const entry of entries) {
        state.visited += 1;
        if (state.visited > LIMITS.walkEntries) { state.truncated = true; return; }
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (PRIVATE_DIRECTORIES.has(entry.name.toLowerCase())) continue;
          if (!includeIgnored && NOISE_DIRECTORIES.has(entry.name)) continue;
          directories.push(absolute);
        } else if (entry.isFile()) {
          const rel = posix(path.relative(rootAbsolute, absolute));
          if (!isProtectedPath(rel)) yield { absolute, rel };
        }
      }
      stack.push(...directories.reverse());
    }
  }

  // ------------------------------------------------------------------ registration
  #register() {
    const define = (name, spec) => this.tools.set(name, { name, annotations: { readOnlyHint: true }, pathArgs: [], reason: '', ...spec });
    const WRITE = { readOnlyHint: false, destructiveHint: false };

    define('read_file', {
      description: 'Read a UTF-8 text file in the workspace. Returns numbered lines plus the file SHA-256 (pass it back as expected_sha256 when editing). Use offset/limit for large files. Secrets (.env, private keys) and .git are refused.',
      schema: obj({ path: str('File path relative to the workspace.'), offset: int('First line to return (1-based).', { minimum: 1 }), limit: int(`Maximum lines to return (default ${LIMITS.readLines}).`, { minimum: 1, maximum: 5000 }) }, ['path']),
      category: 'read', reason: 'Đọc file trong workspace', pathArgs: ['path'], summary: (a) => `Đọc ${a.path}`,
      run: (a) => this.#readFile(a),
    });
    define('list_directory', {
      description: 'List a directory in the workspace (default: the root). depth 1-3 shows nested folders. Dependency/build folders such as node_modules are shown but not opened unless include_ignored is true.',
      schema: obj({ path: str('Directory relative to the workspace (empty = root).'), depth: int('How many levels to show (1-3).', { minimum: 1, maximum: 3 }), include_ignored: bool('Also open node_modules, dist, build, .venv and similar folders.') }),
      category: 'read', reason: 'Liệt kê thư mục', pathArgs: ['path'], summary: (a) => `Liệt kê ${a.path || '.'}`,
      run: (a) => this.#listDirectory(a),
    });
    define('find_files', {
      description: 'Find files by glob pattern, e.g. "**/*.py", "src/**/test_*.js", "*.{json,yaml}". A pattern without "/" matches the file name at any depth.',
      schema: obj({ pattern: str('Glob pattern.'), path: str('Directory to search in (default: workspace root).'), include_ignored: bool('Also search node_modules, dist, build, .venv and similar folders.'), limit: int(`Maximum results (default 200, max ${LIMITS.findResults}).`, { minimum: 1, maximum: LIMITS.findResults }) }, ['pattern']),
      category: 'read', reason: 'Tìm file', pathArgs: ['path'], summary: (a) => `Tìm file ${a.pattern}`,
      run: (a, ctx) => this.#findFiles(a, ctx),
    });
    define('search_files', {
      description: 'Search text inside files (like grep -n). Literal match by default; regex:true uses JavaScript regex (patterns that could hang, such as (a+)+, are rejected). Binary files, files over 1 MB, secrets and .git are skipped.',
      schema: obj({
        pattern: str('Text or regex to look for.', { maxLength: 300 }), path: str('File or directory to search (default: workspace root).'), glob: str('Only search files matching this glob, e.g. "*.py".'),
        regex: bool('Treat pattern as a JavaScript regular expression.'), ignore_case: bool('Case-insensitive match.'), context: int('Lines of context around each match (0-5).', { minimum: 0, maximum: 5 }),
        limit: int(`Maximum matches (default 100, max ${LIMITS.searchMatches}).`, { minimum: 1, maximum: LIMITS.searchMatches }), include_ignored: bool('Also search node_modules, dist, build, .venv and similar folders.'),
      }, ['pattern']),
      category: 'read', reason: 'Tìm nội dung trong file', pathArgs: ['path'], summary: (a) => `Tìm "${clip(String(a.pattern ?? ''), 60)}"`,
      run: (a, ctx) => this.#searchFiles(a, ctx),
    });
    define('git_status', {
      description: 'Show the current branch, HEAD and changed/untracked files of the workspace repository.',
      schema: obj({}), category: 'read', reason: 'Đọc trạng thái Git', summary: () => 'git status',
      run: (a, ctx) => this.#gitStatus(a, ctx),
    });
    define('git_diff', {
      description: 'Show changes as a diff with a summary. staged:true shows what is staged; base compares the working tree to a revision (branch, tag or hash). Changes to secret files are hidden.',
      schema: obj({ path: str('Limit the diff to this file or folder.'), staged: bool('Show staged changes instead of unstaged ones.'), base: str('Revision to compare with, e.g. main or HEAD~3.', { maxLength: 200 }) }),
      category: 'read', reason: 'Đọc diff Git', pathArgs: ['path'], summary: (a) => `git diff${a.path ? ` ${a.path}` : ''}`,
      run: (a, ctx) => this.#gitDiff(a, ctx),
    });
    define('git_log', {
      description: 'Show recent commits (hash, author, date, subject), optionally only those touching a path.',
      schema: obj({ limit: int(`Number of commits (default 20, max ${LIMITS.logEntries}).`, { minimum: 1, maximum: LIMITS.logEntries }), path: str('Only commits touching this path.') }),
      category: 'read', reason: 'Đọc lịch sử Git', pathArgs: ['path'], summary: () => 'git log',
      run: (a, ctx) => this.#gitLog(a, ctx),
    });
    define('get_plan', {
      description: 'Load the saved task plan (checklist) for this conversation.',
      schema: obj({}), category: 'read', reason: 'Đọc kế hoạch', summary: () => 'Đọc kế hoạch',
      run: (a, ctx) => this.#plan('get', a, ctx),
    });
    define('update_plan', {
      description: 'Save the task plan as a checklist. Use it for multi-step work and keep it current. Status: todo, doing, done, blocked; put the evidence (test output, file, command) in "evidence" before marking an item done.',
      schema: obj({
        title: str('Short plan title.', { maxLength: 240 }),
        items: { type: 'array', maxItems: 100, items: obj({ text: str('Step description.', { maxLength: 500 }), status: str('Step status.', { enum: ['todo', 'doing', 'done', 'blocked'] }), evidence: str('Proof the step is done.', { maxLength: 600 }) }, ['text', 'status']) },
      }, ['items']),
      annotations: { readOnlyHint: false }, category: 'checkpoint', reason: 'Cập nhật kế hoạch', summary: () => 'Cập nhật kế hoạch',
      run: (a, ctx) => this.#plan('set', a, ctx),
    });
    define('write_file', {
      description: 'Create a file or replace its whole content (parent folders are created). To replace an existing file you must pass expected_sha256 from read_file, or overwrite:true. Existing line endings (CRLF) and BOM are preserved. Prefer edit_file for small changes. Secrets and .git are refused.',
      schema: obj({ path: str('File path relative to the workspace.'), content: str('Complete new file content.'), overwrite: bool('Allow replacing an existing file without expected_sha256.'), expected_sha256: EXPECTED_SHA }, ['path', 'content']),
      annotations: WRITE, category: 'workspace_edit', reason: 'Ghi file', pathArgs: ['path'],
      summary: (a) => `Ghi ${a.path} (${formatBytes(Buffer.byteLength(String(a.content ?? '')))})`, run: (a) => this.#writeFile(a),
    });
    define('edit_file', {
      description: 'Replace an exact piece of text in a file. old_string must match exactly (including indentation) and be unique unless replace_all is true; include enough surrounding lines to make it unique. Line endings are handled for you. Read the file first.',
      schema: obj({ path: str('File path relative to the workspace.'), old_string: str('Exact text to replace.'), new_string: str('Replacement text (may be empty to delete).'), replace_all: bool('Replace every occurrence.'), expected_sha256: EXPECTED_SHA }, ['path', 'old_string', 'new_string']),
      annotations: WRITE, category: 'workspace_edit', reason: 'Sửa file', pathArgs: ['path'], summary: (a) => `Sửa ${a.path}`, run: (a) => this.#editFile(a),
    });
    define('make_directory', {
      description: 'Create a directory (and missing parents) inside the workspace.',
      schema: obj({ path: str('Directory path relative to the workspace.') }, ['path']),
      annotations: WRITE, category: 'workspace_edit', reason: 'Tạo thư mục', pathArgs: ['path'], summary: (a) => `Tạo thư mục ${a.path}`, run: (a) => this.#makeDirectory(a),
    });
    define('move_path', {
      description: 'Move or rename a file or directory inside the workspace. Replacing an existing file requires overwrite:true.',
      schema: obj({ source: str('Existing path.'), destination: str('New path.'), overwrite: bool('Replace an existing destination file.') }, ['source', 'destination']),
      annotations: WRITE, category: 'workspace_edit', reason: 'Di chuyển/đổi tên', pathArgs: ['source', 'destination'], summary: (a) => `Di chuyển ${a.source} → ${a.destination}`, run: (a) => this.#movePath(a),
    });
    define('git_add', {
      description: 'Stage files for commit. Pass explicit paths (or "." for everything); wildcards are not accepted. Secret files are never staged.',
      schema: obj({ paths: { type: 'array', items: str('Path relative to the workspace.'), minItems: 1, maxItems: 100 } }, ['paths']),
      annotations: WRITE, category: 'workspace_edit', reason: 'Stage file', summary: (a) => `git add ${(a.paths ?? []).join(' ')}`, run: (a, ctx) => this.#gitAdd(a, ctx),
    });
    define('git_commit', {
      description: 'Commit the staged changes with a message (all:true also commits modified tracked files). Repository hooks are skipped because they run arbitrary code; run_hooks:true runs them and needs approval. Never pushes.',
      schema: obj({ message: str('Commit message.', { maxLength: LIMITS.commitMessageChars }), all: bool('Also include modified tracked files (git commit -a).'), run_hooks: bool('Run the repository hooks (pre-commit etc.).') }, ['message']),
      annotations: WRITE, category: (a) => (a.run_hooks === true || a.run_hooks === 'true' ? { category: 'execute', reason: 'Chạy Git hook (mã tùy ý của kho)' } : { category: 'workspace_edit', reason: 'Tạo commit' }),
      summary: (a) => `git commit -m "${clip(String(a.message ?? '').split('\n')[0], 70)}"`, run: (a, ctx) => this.#gitCommit(a, ctx),
    });
    define('git_branch', {
      description: 'List branches, create a branch (and switch to it) or switch to an existing one. Does not delete or force anything.',
      schema: obj({ action: str('What to do.', { enum: ['list', 'create', 'switch'] }), name: str('Branch name (create/switch).', { maxLength: 200 }), start_point: str('Revision to start a new branch from.', { maxLength: 200 }) }, ['action']),
      annotations: WRITE, category: (a) => (a.action === 'list' ? { category: 'read', reason: 'Liệt kê nhánh' } : { category: 'workspace_edit', reason: 'Tạo/chuyển nhánh' }),
      summary: (a) => `git branch ${a.action ?? ''} ${a.name ?? ''}`.trim(), run: (a, ctx) => this.#gitBranch(a, ctx),
    });
    define('delete_path', {
      description: 'Delete a file or an empty directory; recursive:true deletes a non-empty directory. Always asks the user for approval. Cannot delete the workspace root, .git or secret files.',
      schema: obj({ path: str('Path relative to the workspace.'), recursive: bool('Delete a non-empty directory and everything in it.') }, ['path']),
      annotations: { readOnlyHint: false, destructiveHint: true }, category: 'dangerous', reason: 'Xóa file/thư mục', pathArgs: ['path'],
      summary: (a) => `XÓA ${a.path}${a.recursive ? ' (đệ quy)' : ''}`, run: (a) => this.#deletePath(a),
    });
    define('run_command', {
      description: 'Run a shell command in the workspace (bash/Git Bash by default, or PowerShell on Windows when you pass shell:"powershell"). Non-interactive: stdin is closed. Output is truncated in the middle if huge; a timeout stops the command and its children. Prefer the dedicated file and Git tools for reading and editing. Use it to run tests, builds and project scripts. Read-only and test commands may run without asking; anything else needs approval.',
      schema: obj({
        command: str(`The command line (max ${LIMITS.commandChars} characters).`, { maxLength: LIMITS.commandChars }), cwd: str('Working directory relative to the workspace (default: root).'),
        timeout_seconds: int('Maximum run time in seconds (default 120, max 900).', { minimum: 1, maximum: 900 }), shell: str('Shell to use.', { enum: ['bash', 'sh', 'powershell'] }), description: str('One short sentence: what this command is for.', { maxLength: 300 }),
      }, ['command']),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, pathArgs: ['cwd'],
      category: (a) => this.#assessCommand(a), summary: (a) => `$ ${clip(String(a.command ?? '').split('\n')[0], 120)}`, run: (a, ctx) => this.#runCommand(a, ctx),
    });
  }

  // ------------------------------------------------------------------ read tools
  async #readFile({ path: p, offset = 1, limit = LIMITS.readLines }) {
    const target = await this.#target(p);
    const stat = await fs.stat(target.absolute);
    if (stat.isDirectory()) throw fault('is_directory', `"${target.relative}" là thư mục; dùng list_directory.`);
    if (!stat.isFile()) throw fault('not_file', `"${target.relative}" không phải file thông thường.`);
    if (stat.size > LIMITS.readBytes) throw fault('file_too_large', `File ${formatBytes(stat.size)} vượt giới hạn ${formatBytes(LIMITS.readBytes)}; dùng search_files hoặc run_command (head/tail) để xem phần cần thiết.`, 413);
    const buffer = await fs.readFile(target.absolute);
    const decoded = decodeText(buffer);
    if (!decoded.ok) throw this.#decodeError(target.relative, decoded.reason);
    const lines = splitLines(decoded.text);
    const total = lines.length;
    const digest = sha256(buffer);
    const header = `${target.relative} · ${total} dòng · ${formatBytes(stat.size)} · ${encodingLabel(decoded.encoding)} · ${eolLabel(decoded.eol)}\nsha256: ${digest}`;
    const meta = { path: target.relative, sha256: digest, size: stat.size, lines: total, encoding: decoded.encoding, eol: decoded.eol };
    if (!total) return ok(`${header}\n(file rỗng)`, { ...meta, start: 0, end: 0 });
    if (offset > total) throw fault('offset_out_of_range', `File chỉ có ${total} dòng (offset=${offset}).`);
    const picked = [];
    let chars = 0;
    let end = offset - 1;
    for (let i = offset - 1; i < total && picked.length < limit; i += 1) {
      const rendered = renderLine(lines[i], i + 1);
      if (chars + rendered.length > LIMITS.readChars && picked.length) break;
      picked.push(rendered);
      chars += rendered.length + 1;
      end = i + 1;
    }
    const footer = end < total ? `\n[Đã hiển thị dòng ${offset}-${end} / ${total}. Gọi lại với offset=${end + 1} để đọc tiếp.]` : '';
    return ok(`${header}\n${picked.join('\n')}${footer}`, { ...meta, start: offset, end, truncated: end < total });
  }

  async #listDirectory({ path: p = '', depth = 1, include_ignored: includeIgnored = false }) {
    const base = await this.#target(p, { allowRoot: true });
    const stat = await fs.stat(base.absolute);
    if (!stat.isDirectory()) throw fault('not_directory', `"${base.relative}" không phải thư mục.`);
    const lines = [];
    let count = 0;
    let totalCapped = false;
    let nestedTrimmed = false;
    const visit = async (directory, level) => {
      let entries = await fs.readdir(directory, { withFileTypes: true });
      entries = entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const indent = '  '.repeat(level);
      // A nested folder only gets a short preview, so one huge folder cannot hide its siblings.
      const cap = level === 0 ? LIMITS.listEntries : LIMITS.listNested;
      let shown = 0;
      for (const entry of entries) {
        if (shown >= cap || count >= LIMITS.listEntries) {
          if (level === 0 || count >= LIMITS.listEntries) totalCapped = true; else nestedTrimmed = true;
          lines.push(`${indent}… và ${entries.length - shown} mục khác`);
          return;
        }
        shown += 1;
        count += 1;
        const absolute = path.join(directory, entry.name);
        const rel = posix(path.relative(base.root, absolute));
        const secret = isProtectedPath(rel);
        if (entry.isSymbolicLink()) { lines.push(`${indent}${entry.name} (symlink, không theo dõi)`); continue; }
        if (entry.isDirectory()) {
          const skipped = (!includeIgnored && NOISE_DIRECTORIES.has(entry.name)) || secret;
          lines.push(`${indent}${entry.name}/${secret ? '  [bảo vệ]' : skipped ? '  [không mở: thư mục phụ thuộc/sinh ra; dùng include_ignored=true]' : ''}`);
          if (!skipped && level + 1 < depth) await visit(absolute, level + 1);
        } else {
          const size = (await fs.stat(absolute).catch(() => null))?.size;
          lines.push(`${indent}${entry.name}${size === undefined ? '' : `  (${formatBytes(size)})`}${secret ? '  [bảo vệ]' : ''}`);
        }
      }
    };
    await visit(base.absolute, 0);
    const notes = [totalCapped ? `đã giới hạn ${LIMITS.listEntries}` : '', nestedTrimmed ? `thư mục con chỉ hiện ${LIMITS.listNested} mục đầu; dùng path để xem riêng` : ''].filter(Boolean);
    const title = `${base.relative || '.'}/ · ${count} mục${notes.length ? ` (${notes.join('; ')})` : ''}`;
    return ok(`${title}\n${lines.join('\n') || '(thư mục rỗng)'}`, { path: base.relative, entries: count, truncated: totalCapped || nestedTrimmed });
  }

  async #findFiles({ pattern, path: p = '', include_ignored: includeIgnored = false, limit = 200 }, { signal }) {
    const base = await this.#target(p, { allowRoot: true });
    const stat = await fs.stat(base.absolute);
    if (!stat.isDirectory()) throw fault('not_directory', `"${base.relative}" không phải thư mục.`);
    const matcher = compileGlob(pattern);
    const prefix = base.relative ? `${base.relative}/` : '';
    const found = [];
    const state = { visited: 0, truncated: false };
    for await (const file of this.#walk(base.absolute, base.root, { includeIgnored, state, signal })) {
      const local = prefix && file.rel.startsWith(prefix) ? file.rel.slice(prefix.length) : file.rel;
      if (matcher.test(local)) { found.push(file.rel); if (found.length >= limit) break; }
    }
    const limited = found.length >= limit;
    const note = limited ? `\n[Đã dừng ở ${limit} kết quả.]` : state.truncated ? '\n[Đã dừng vì quá nhiều mục; thu hẹp path hoặc mẫu.]' : '';
    return ok(`${found.length} file khớp "${pattern}"${base.relative ? ` trong ${base.relative}` : ''}\n${found.join('\n') || '(không có)'}${note}`, { count: found.length, truncated: limited || Boolean(state.truncated) });
  }

  async #searchFiles({ pattern, path: p = '', glob, regex = false, ignore_case: ignoreCase = false, context = 0, limit = 100, include_ignored: includeIgnored = false }, { signal }) {
    if (!pattern) throw fault('bad_pattern', 'Cần mẫu tìm kiếm.');
    let matches;
    if (regex) {
      assertSafeRegex(pattern);
      let expression;
      try { expression = new RegExp(pattern, ignoreCase ? 'i' : ''); } catch (error) { throw fault('bad_pattern', `Regex không hợp lệ: ${error.message}`); }
      matches = (line) => expression.test(line.length > LIMITS.regexLineChars ? line.slice(0, LIMITS.regexLineChars) : line);
    } else {
      const needle = ignoreCase ? pattern.toLowerCase() : pattern;
      matches = (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
    }
    const base = await this.#target(p, { allowRoot: true });
    const stat = await fs.stat(base.absolute);
    const globber = glob ? compileGlob(glob) : null;
    const prefix = base.relative && stat.isDirectory() ? `${base.relative}/` : '';
    const state = { visited: 0, truncated: false };
    const files = stat.isDirectory() ? this.#walk(base.absolute, base.root, { includeIgnored, state, signal }) : (async function* single() { yield { absolute: base.absolute, rel: base.relative }; }());
    const started = Date.now();
    const output = [];
    let scanned = 0;
    let skipped = 0;
    let found = 0;
    let filesWithHits = 0;
    let partial = false;
    for await (const file of files) {
      if (globber && !globber.test(prefix && file.rel.startsWith(prefix) ? file.rel.slice(prefix.length) : file.rel)) continue;
      if (Date.now() - started > LIMITS.searchMillis) { partial = true; break; }
      const info = await fs.stat(file.absolute).catch(() => null);
      if (!info?.isFile() || info.size > LIMITS.searchFileBytes) { skipped += 1; continue; }
      const decoded = decodeText(await fs.readFile(file.absolute).catch(() => Buffer.alloc(0)));
      if (!decoded.ok) { skipped += 1; continue; }
      scanned += 1;
      const lines = splitLines(decoded.text);
      const hits = [];
      for (let i = 0; i < lines.length && found + hits.length < limit; i += 1) if (matches(lines[i])) hits.push(i);
      if (!hits.length) continue;
      filesWithHits += 1;
      found += hits.length;
      if (!context) { for (const i of hits) output.push(`${file.rel}:${i + 1}: ${clip(lines[i].trim() ? lines[i] : '(dòng trống)', 300)}`); } else {
        const ranges = [];
        for (const i of hits) {
          const range = [Math.max(0, i - context), Math.min(lines.length - 1, i + context)];
          const last = ranges.at(-1);
          if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]); else ranges.push(range);
        }
        const hitSet = new Set(hits);
        for (const [from, to] of ranges) {
          if (output.length) output.push('--');
          for (let n = from; n <= to; n += 1) output.push(`${file.rel}${hitSet.has(n) ? ':' : '-'}${n + 1}${hitSet.has(n) ? ':' : '-'} ${clip(lines[n], 300)}`);
        }
      }
      if (found >= limit) break;
    }
    const notes = [];
    if (found >= limit) notes.push(`Đã dừng ở ${limit} kết quả.`);
    if (partial) notes.push(`Đã dừng sau ${LIMITS.searchMillis / 1000}s; thu hẹp path hoặc glob.`);
    if (state.truncated) notes.push('Có quá nhiều mục để quét hết; thu hẹp path.');
    if (skipped) notes.push(`${skipped} file bị bỏ qua (nhị phân, không phải UTF-8 hoặc lớn hơn ${formatBytes(LIMITS.searchFileBytes)}).`);
    const head = `${found} kết quả trong ${filesWithHits} file (đã quét ${scanned} file) cho ${regex ? 'regex' : 'chuỗi'} "${clip(pattern, 80)}"`;
    return ok(`${head}\n${output.join('\n') || '(không có kết quả)'}${notes.length ? `\n[${notes.join(' ')}]` : ''}`, { matches: found, files: filesWithHits, scanned, skipped, truncated: found >= limit || partial || Boolean(state.truncated) });
  }

  // ------------------------------------------------------------------ write tools
  async #writeFile({ path: p, content, overwrite = false, expected_sha256: expectedSha }) {
    const target = await this.#target(p, { write: true });
    if (Buffer.byteLength(content, 'utf8') > LIMITS.writeBytes) throw fault('content_too_large', `Nội dung vượt ${formatBytes(LIMITS.writeBytes)}; chia nhỏ file.`, 413);
    if (content.includes('\0')) throw fault('bad_content', 'Nội dung chứa ký tự NUL; công cụ chỉ ghi file văn bản.');
    const stat = await fs.lstat(target.absolute).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    let existing = null;
    if (stat) {
      if (stat.isSymbolicLink()) throw fault('symlink', `"${target.relative}" là symlink; không ghi qua symlink.`, 403);
      if (stat.isDirectory()) throw fault('is_directory', `"${target.relative}" là thư mục.`);
      if (!stat.isFile()) throw fault('not_file', `"${target.relative}" không phải file thông thường.`);
      existing = await fs.readFile(target.absolute);
      const current = sha256(existing);
      if (expectedSha) {
        if (current !== expectedSha.toLowerCase()) throw fault('stale_revision', `"${target.relative}" đã thay đổi kể từ lần đọc (sha256 khác). Đọc lại trước khi ghi.`, 409);
      } else if (!overwrite) {
        throw fault('file_exists', `"${target.relative}" đã tồn tại. Đọc file (read_file) rồi truyền expected_sha256, hoặc đặt overwrite=true nếu thật sự muốn ghi đè toàn bộ.`, 409);
      }
    } else {
      const parent = path.dirname(target.absolute);
      const parentStat = await fs.stat(parent).catch(() => null);
      if (parentStat && !parentStat.isDirectory()) throw fault('not_directory', 'Thư mục cha là một file.');
      if (!parentStat) await fs.mkdir(parent, { recursive: true });
    }
    let encoding = 'utf8';
    let text = content;
    if (existing) {
      const old = decodeText(existing);
      if (old.ok) { encoding = old.encoding; if (old.eol === 'crlf') text = applyEol(content, 'crlf'); }
    }
    const data = encodeText(text, encoding);
    const digest = sha256(data);
    if (existing && data.equals(existing)) return ok(`${target.relative}: nội dung không đổi, không ghi.`, { path: target.relative, unchanged: true, sha256: digest });
    await writeFileAtomic(target.absolute, data, { mode: this.#fileMode(stat?.mode), expectedSha: existing ? sha256(existing) : null });
    return ok(`${existing ? 'Đã ghi đè' : 'Đã tạo'} ${target.relative} (${formatBytes(data.length)}, ${splitLines(text).length} dòng).\nsha256: ${digest}`,
      { path: target.relative, created: !existing, bytes: data.length, sha256: digest, previousSha: existing ? sha256(existing) : null });
  }

  async #editFile({ path: p, old_string: oldString, new_string: newString, replace_all: replaceAll = false, expected_sha256: expectedSha }) {
    if (!oldString) throw fault('bad_edit', 'old_string không được rỗng. Để tạo file mới dùng write_file.');
    if (oldString === newString) throw fault('bad_edit', 'old_string và new_string giống nhau; không có gì để sửa.');
    const target = await this.#target(p, { write: true });
    const stat = await fs.lstat(target.absolute);
    if (stat.isSymbolicLink()) throw fault('symlink', `"${target.relative}" là symlink; không sửa qua symlink.`, 403);
    if (!stat.isFile()) throw fault(stat.isDirectory() ? 'is_directory' : 'not_file', `"${target.relative}" không phải file thông thường.`);
    if (stat.size > LIMITS.editBytes) throw fault('file_too_large', `File ${formatBytes(stat.size)} vượt giới hạn sửa ${formatBytes(LIMITS.editBytes)}.`, 413);
    const buffer = await fs.readFile(target.absolute);
    const before = sha256(buffer);
    if (expectedSha && before !== expectedSha.toLowerCase()) throw fault('stale_revision', `"${target.relative}" đã thay đổi kể từ lần đọc (sha256 khác). Đọc lại trước khi sửa.`, 409);
    const decoded = decodeText(buffer);
    if (!decoded.ok) throw this.#decodeError(target.relative, decoded.reason);
    const crlf = decoded.eol === 'crlf';
    const hay = crlf ? toLf(decoded.text) : decoded.text;
    const needle = crlf ? toLf(oldString) : oldString;
    const replacement = crlf ? toLf(newString) : newString;
    const positions = [];
    for (let at = hay.indexOf(needle); at !== -1 && positions.length < 5000; at = hay.indexOf(needle, at + needle.length)) positions.push(at);
    const lineAt = (position) => hay.slice(0, position).split('\n').length;
    if (!positions.length) {
      const trimmed = needle.split('\n').map((line) => line.trim()).filter(Boolean);
      const lines = hay.split('\n');
      let hint = '';
      if (trimmed.length) {
        const probe = trimmed[0];
        const near = lines.findIndex((line) => line.trim() === probe);
        if (near !== -1) hint = ` Dòng đầu của old_string xuất hiện ở dòng ${near + 1} nhưng khác khoảng trắng/thụt lề hoặc các dòng sau; dùng read_file để lấy đoạn chính xác.`;
      }
      throw fault('not_found', `Không tìm thấy old_string trong "${target.relative}".${hint || ' Kiểm tra khoảng trắng, thụt lề và dấu xuống dòng; dùng read_file để lấy đoạn chính xác.'}`, 404);
    }
    if (positions.length > 1 && !replaceAll) {
      throw fault('ambiguous_match', `old_string xuất hiện ${positions.length} lần (dòng ${positions.slice(0, 10).map(lineAt).join(', ')}${positions.length > 10 ? ', ...' : ''}). Thêm vài dòng ngữ cảnh xung quanh để duy nhất, hoặc đặt replace_all=true.`, 409);
    }
    const updatedLf = replaceAll ? hay.split(needle).join(replacement) : hay.slice(0, positions[0]) + replacement + hay.slice(positions[0] + needle.length);
    const updated = crlf ? updatedLf.replace(/\n/g, '\r\n') : updatedLf;
    const data = encodeText(updated, decoded.encoding);
    await writeFileAtomic(target.absolute, data, { mode: this.#fileMode(stat.mode), expectedSha: before });
    const digest = sha256(data);
    const firstLine = lineAt(positions[0]);
    const replacedLines = replacement ? replacement.split('\n').length : 1;
    const outLines = updatedLf.split('\n');
    const from = Math.max(1, firstLine - 3);
    const to = Math.min(outLines.length, firstLine + replacedLines - 1 + 3);
    const snippet = outLines.slice(from - 1, to).map((line, i) => renderLine(line, from + i)).join('\n');
    const count = replaceAll ? positions.length : 1;
    return ok(`Đã sửa ${target.relative}: thay ${count} chỗ${count === 1 ? ` (dòng ${firstLine})` : ''}.\nsha256: ${digest}\n${snippet}`,
      { path: target.relative, replacements: count, firstLine, sha256: digest, previousSha: before });
  }

  async #makeDirectory({ path: p }) {
    const target = await this.#target(p, { write: true });
    const stat = await fs.lstat(target.absolute).catch(() => null);
    if (stat?.isDirectory()) return ok(`${target.relative} đã tồn tại.`, { path: target.relative, created: false });
    if (stat) throw fault('already_exists', `"${target.relative}" đã tồn tại và không phải thư mục.`, 409);
    await fs.mkdir(target.absolute, { recursive: true });
    return ok(`Đã tạo thư mục ${target.relative}.`, { path: target.relative, created: true });
  }

  async #movePath({ source, destination, overwrite = false }) {
    const from = await this.#target(source, { write: true });
    const to = await this.#target(destination, { write: true });
    const fromStat = await fs.lstat(from.absolute);
    if (from.relative === to.relative) throw fault('bad_move', 'Nguồn và đích giống nhau.');
    if (fromStat.isDirectory() && to.relative.startsWith(`${from.relative}/`)) throw fault('bad_move', 'Không thể di chuyển thư mục vào chính nó.');
    const toStat = await fs.lstat(to.absolute).catch(() => null);
    const caseOnly = process.platform === 'win32' && from.relative.toLowerCase() === to.relative.toLowerCase();
    if (toStat && !caseOnly) {
      if (!overwrite) throw fault('already_exists', `Đích "${to.relative}" đã tồn tại. Đặt overwrite=true để thay file, hoặc chọn tên khác.`, 409);
      if (toStat.isDirectory() || fromStat.isDirectory()) throw fault('bad_move', 'Chỉ ghi đè được file bằng file; không ghi đè thư mục.');
    }
    await fs.mkdir(path.dirname(to.absolute), { recursive: true });
    await fs.rename(from.absolute, to.absolute);
    return ok(`Đã di chuyển ${from.relative} → ${to.relative}.`, { source: from.relative, destination: to.relative });
  }

  async #deletePath({ path: p, recursive = false }) {
    const target = await this.#target(p, { write: true });
    const stat = await fs.lstat(target.absolute);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(target.absolute);
      if (entries.length && !recursive) throw fault('not_empty', `Thư mục "${target.relative}" có ${entries.length} mục. Đặt recursive=true để xóa toàn bộ.`, 409);
      await fs.rm(target.absolute, { recursive: true, force: false });
      return ok(`Đã xóa thư mục ${target.relative}${entries.length ? ` (${entries.length} mục ở cấp đầu)` : ''}.`, { path: target.relative, kind: 'directory' });
    }
    await fs.unlink(target.absolute);
    return ok(`Đã xóa ${target.relative}.`, { path: target.relative, kind: stat.isSymbolicLink() ? 'symlink' : 'file' });
  }

  // ------------------------------------------------------------------ git tools
  async #stagedNames(signal) {
    const result = await this.git.text(['diff', '--cached', '--name-only', '-z'], { signal });
    if (result.code !== 0) throw fault('git_error', result.stderr.trim() || 'git diff --cached thất bại.');
    return result.stdout.split('\0').filter(Boolean);
  }

  async #gitStatus(_args, { signal }) {
    await this.git.ensureRepo({ signal });
    const result = await this.git.text(['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], { signal, maxBytes: 1_000_000 });
    if (result.code !== 0) throw fault('git_error', result.stderr.trim() || 'git status thất bại.');
    const parts = result.stdout.split('\0');
    if (parts.at(-1) === '') parts.pop();
    const branchLine = parts[0]?.startsWith('## ') ? parts.shift().slice(3) : '';
    const entries = [];
    for (let i = 0; i < parts.length; i += 1) {
      const record = parts[i];
      const code = record.slice(0, 2);
      const entry = { code, path: record.slice(3) };
      if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') { i += 1; entry.from = parts[i]; }
      entries.push(entry);
    }
    const head = await this.git.text(['rev-parse', '--short', 'HEAD'], { signal });
    const lines = entries.slice(0, 500).map((entry) => `${entry.code} ${entry.path}${entry.from ? ` (từ ${entry.from})` : ''}${isProtectedPath(entry.path) ? '  [bảo vệ]' : ''}`);
    const text = `Nhánh: ${branchLine || '(không rõ)'}\nHEAD: ${head.code === 0 ? head.stdout.trim() : '(chưa có commit)'}\n${entries.length ? `Thay đổi (${entries.length}):\n${lines.join('\n')}${entries.length > 500 ? '\n[Đã rút gọn 500 mục đầu]' : ''}` : 'Cây làm việc sạch (không có thay đổi).'}`;
    return ok(text, { branch: branchLine, head: head.code === 0 ? head.stdout.trim() : null, changed: entries.length, clean: entries.length === 0, truncated: result.truncated });
  }

  async #gitDiff({ path: p, staged = false, base }, { signal }) {
    await this.git.ensureRepo({ signal });
    if (base === '') base = undefined;
    if (base !== undefined && !isSafeRevision(base)) throw fault('bad_revision', `Revision "${base}" không hợp lệ (dùng tên nhánh, tag hoặc hash; không dùng khoảng a..b).`);
    const spec = [];
    if (p) { const target = await this.#target(p, { allowRoot: true }); if (target.relative) spec.push(target.relative); }
    const common = ['--no-ext-diff', '--no-textconv', '--no-color'];
    const scope = [...(staged ? ['--cached'] : []), ...(base ? [base] : [])];
    const names = await this.git.text(['diff', ...common, '--name-only', '-z', ...scope, '--', ...spec], { signal });
    if (names.code !== 0) throw fault('git_error', names.stderr.trim() || 'git diff thất bại.');
    const changed = names.stdout.split('\0').filter(Boolean);
    const hidden = changed.filter(isProtectedPath);
    const excludes = hidden.map((name) => `:(exclude,literal)${name}`);
    const pathspec = [...(spec.length ? spec : excludes.length ? ['.'] : []), ...excludes];
    const result = await this.git.text(['diff', ...common, '--stat', '--patch', ...scope, '--', ...pathspec], { signal, maxBytes: 800_000 });
    if (result.code !== 0) throw fault('git_error', result.stderr.trim() || 'git diff thất bại.');
    const notes = [];
    if (hidden.length) notes.push(`${hidden.length} file bí mật bị ẩn khỏi diff: ${hidden.join(', ')}`);
    if (result.truncated || result.stdout.length > LIMITS.diffChars) notes.push('Diff quá lớn nên đã bị cắt; hỏi theo từng file bằng tham số path.');
    const body = result.stdout.trim() ? clip(result.stdout, LIMITS.diffChars) : 'Không có thay đổi.';
    return ok(`${body}${notes.length ? `\n[${notes.join(' ')}]` : ''}`, { files: changed.length - hidden.length, hidden: hidden.length, staged, truncated: result.truncated });
  }

  async #gitLog({ limit = 20, path: p }, { signal }) {
    await this.git.ensureRepo({ signal });
    const spec = [];
    if (p) { const target = await this.#target(p, { allowRoot: true }); if (target.relative) spec.push(target.relative); }
    const result = await this.git.text(['log', `--max-count=${limit}`, '--date=short', '--no-color', '--no-show-signature', '--format=%h%x09%an%x09%ad%x09%s', '--', ...spec], { signal });
    if (result.code !== 0) {
      if (/does not have any commits|bad default revision/i.test(result.stderr)) return ok('Chưa có commit nào.', { commits: 0 });
      throw fault('git_error', result.stderr.trim() || 'git log thất bại.');
    }
    const lines = result.stdout.split('\n').filter(Boolean);
    return ok(`${lines.length} commit gần nhất${spec.length ? ` của ${spec[0]}` : ''}:\n${lines.map((line) => line.split('\t').join('  ')).join('\n') || '(không có)'}`, { commits: lines.length });
  }

  async #gitAdd({ paths }, { signal }) {
    await this.git.ensureRepo({ signal });
    const specs = [];
    for (const item of paths) {
      if (/[*?[]/.test(item) || item.startsWith(':')) throw fault('bad_path', `"${item}": git_add không nhận wildcard hay pathspec đặc biệt; liệt kê đường dẫn cụ thể hoặc dùng ".".`);
      const target = await this.#target(item, { allowRoot: true });
      specs.push(target.relative || '.');
    }
    const before = new Set(await this.#stagedNames(signal));
    const added = await this.git.text(['add', '--', ...specs], { signal, writes: true });
    if (added.code !== 0) throw fault('git_error', added.stderr.trim() || 'git add thất bại.');
    const after = await this.#stagedNames(signal);
    const secrets = after.filter((name) => !before.has(name) && isProtectedPath(name));
    if (secrets.length) {
      const reset = await this.git.text(['reset', '-q', '--', ...secrets], { signal, writes: true });
      if (reset.code !== 0) await this.git.text(['rm', '--cached', '-q', '-f', '--', ...secrets], { signal, writes: true });
    }
    const staged = after.filter((name) => !secrets.includes(name));
    const text = `Đã stage. Hiện có ${staged.length} file trong stage${staged.length ? `:\n${staged.slice(0, 100).join('\n')}${staged.length > 100 ? '\n...' : ''}` : '.'}`
      + (secrets.length ? `\n[Bỏ qua và gỡ khỏi stage file bí mật: ${secrets.join(', ')}. Thêm chúng vào .gitignore.]` : '');
    return ok(text, { staged: staged.length, skippedSecrets: secrets });
  }

  async #gitCommit({ message, all = false, run_hooks: runHooks = false }, { signal }) {
    await this.git.ensureRepo({ signal });
    const text = message.trim();
    if (!text) throw fault('bad_message', 'Commit message không được rỗng.');
    if (text.includes('\0')) throw fault('bad_message', 'Commit message chứa ký tự NUL.');
    if (all) {
      const modified = await this.git.text(['diff', '--name-only', '-z'], { signal });
      const secrets = modified.stdout.split('\0').filter((name) => name && isProtectedPath(name));
      if (secrets.length) throw fault('protected_staged', `Không commit -a vì file bí mật đã theo dõi có thay đổi: ${secrets.join(', ')}.`, 409);
    }
    const staged = await this.#stagedNames(signal);
    const secrets = staged.filter(isProtectedPath);
    if (secrets.length) throw fault('protected_staged', `Stage đang chứa file bí mật: ${secrets.join(', ')}. Gỡ chúng khỏi stage (git reset <file>) trước khi commit.`, 409);
    if (!all && !staged.length) throw fault('nothing_to_commit', 'Chưa có gì trong stage. Dùng git_add trước (hoặc all:true để commit file đã theo dõi bị sửa).', 409);
    const result = await this.git.text(['commit', ...(all ? ['-a'] : []), '-m', text], { signal, writes: true, hooks: runHooks === true, timeoutMs: runHooks ? 120_000 : 30_000 });
    if (result.code !== 0) {
      const detail = `${result.stdout}\n${result.stderr}`.trim();
      if (/nothing to commit|no changes added/i.test(detail)) throw fault('nothing_to_commit', 'Không có thay đổi để commit.', 409);
      throw fault('git_error', detail || 'git commit thất bại.');
    }
    const info = await this.git.text(['show', '--stat', '--format=%h %s', '--no-color', '--no-ext-diff', 'HEAD'], { signal });
    return ok(`Đã commit:\n${info.stdout.trim()}`, { committed: true, files: staged.length });
  }

  async #gitBranch({ action, name, start_point: startPoint }, { signal }) {
    await this.git.ensureRepo({ signal });
    if (action === 'list') {
      const result = await this.git.text(['branch', '--list', '--format=%(HEAD)%09%(refname:short)%09%(upstream:short)'], { signal });
      if (result.code !== 0) throw fault('git_error', result.stderr.trim() || 'git branch thất bại.');
      const rows = result.stdout.split('\n').filter(Boolean).map((line) => { const [head, branch, upstream] = line.split('\t'); return { current: head === '*', branch, upstream: upstream || null }; });
      return ok(`${rows.length} nhánh:\n${rows.map((row) => `${row.current ? '*' : ' '} ${row.branch}${row.upstream ? ` → ${row.upstream}` : ''}`).join('\n') || '(chưa có nhánh nào — chưa có commit)'}`, { branches: rows });
    }
    if (!name) throw fault('bad_branch', `Cần name để ${action === 'create' ? 'tạo' : 'chuyển'} nhánh.`);
    if (name.startsWith('-')) throw fault('bad_branch', 'Tên nhánh không được bắt đầu bằng "-".');
    const valid = await this.git.text(['check-ref-format', '--branch', name], { signal });
    if (valid.code !== 0) throw fault('bad_branch', `Tên nhánh "${name}" không hợp lệ.`);
    if (startPoint !== undefined && !isSafeRevision(startPoint)) throw fault('bad_revision', `start_point "${startPoint}" không hợp lệ.`);
    const args = action === 'create' ? ['switch', '-c', name, ...(startPoint ? [startPoint] : [])] : ['switch', name];
    const result = await this.git.text(args, { signal, writes: true });
    if (result.code !== 0) throw fault('git_error', `${result.stderr}${result.stdout}`.trim() || 'git switch thất bại.');
    return ok(`${action === 'create' ? 'Đã tạo và chuyển sang' : 'Đã chuyển sang'} nhánh ${name}.`, { branch: name, action });
  }

  // ------------------------------------------------------------------ plan
  async #plan(operation, args, { taskId }) {
    const plan = await this.workspace.plan({ taskId, operation, title: args.title ?? '', items: args.items ?? [] });
    const marks = { todo: '[ ]', doing: '[~]', done: '[x]', blocked: '[!]' };
    const body = plan.items.map((item) => `${marks[item.status] ?? '[ ]'} ${item.text}${item.evidence ? ` — ${item.evidence}` : ''}`).join('\n');
    const done = plan.items.filter((item) => item.status === 'done').length;
    return ok(`${plan.title ? `${plan.title}\n` : ''}${body || '(kế hoạch trống)'}${plan.items.length ? `\n${done}/${plan.items.length} bước hoàn tất.` : ''}`, { title: plan.title, items: plan.items, done, total: plan.items.length });
  }

  // ------------------------------------------------------------------ shell
  async #assessCommand(args) {
    const command = typeof args.command === 'string' ? args.command : '';
    let shellName;
    try { shellName = (await this.shell.resolveShell(args.shell)).name; } catch { shellName = args.shell === 'powershell' ? 'powershell' : 'bash'; }
    const analysis = analyzeCommand(command, { shell: shellName === 'powershell' ? 'powershell' : 'bash' });
    let { kind } = analysis;
    const reasons = [...analysis.reasons];
    if (command.length > LIMITS.commandChars) { kind = maxKind(kind, 'exec'); reasons.push(`Lệnh dài hơn ${LIMITS.commandChars} ký tự, không thể xem xét đầy đủ`); }
    // The analyser reads text. Two things it cannot see are decided by the file system and the repository, so a command it
    // would let through unasked gets one more look before it does.
    if (kind !== 'exec' && kind !== 'dangerous' && command.length <= LIMITS.commandChars) {
      try {
        const { root, absolute: cwd } = await this.workspace.resolve(typeof args.cwd === 'string' ? args.cwd : '');
        const problems = await pathProblems({ segments: analysis.segments, cwd, root, powershell: shellName === 'powershell' });
        if (problems.length) { kind = maxKind(kind, 'exec'); reasons.push(`Đối số trỏ ra ngoài dự án hoặc tới file bí mật: ${problems.slice(0, 3).map(describeProblem).join('; ')}`); }
        const gitSegments = analysis.segments.filter((segment) => segment.program === 'git');
        if (gitSegments.length) {
          const safety = await inspectGitSafety(root);
          const names = [...new Set(gitSegments.flatMap((segment) => gitRisksFor(gitSubcommand(segment.args), safety)))];
          if (names.length) { kind = maxKind(kind, 'exec'); reasons.push(`Kho Git này có cấu hình hoặc hook sẽ chạy chương trình của kho khi dùng lệnh git (${names.slice(0, 4).join(', ')})`); }
        }
      } catch {
        // If the real locations cannot be worked out, the safe reading of "unknown" is the same as everywhere else: ask.
        kind = maxKind(kind, 'exec'); reasons.push('Không xác định được vị trí thật của các đường dẫn trong lệnh');
      }
    }
    return {
      category: categoryForKind(kind), command,
      reason: `Lệnh shell (${kind})${reasons.length ? `: ${reasons.join('; ')}` : ''}`,
      risk: { kind, reasons, shell: shellName },
    };
  }

  async #runCommand({ command, cwd = '', timeout_seconds: timeoutSeconds, shell }, { signal }) {
    if (command.length > LIMITS.commandChars) throw fault('command_too_long', `Lệnh dài hơn ${LIMITS.commandChars} ký tự nên người dùng không thể xem xét đầy đủ. Ghi thành file script (write_file) rồi chạy file đó.`);
    if (cwd && isProtectedPath(cwd)) throw protectedError(cwd);
    const result = await this.shell.run({ command, cwd, timeoutMs: (timeoutSeconds ?? 120) * 1000, shell, signal });
    const seconds = (result.durationMs / 1000).toFixed(1);
    const status = result.timedOut ? `HẾT GIỜ sau ${seconds}s — lệnh và tiến trình con đã bị dừng`
      : result.cancelled ? 'ĐÃ HỦY'
        : result.exitCode === null ? `bị dừng bởi tín hiệu ${result.signal ?? 'không rõ'}`
          : `exit code ${result.exitCode}`;
    const lines = [`${status} · ${result.shell} · ${seconds}s · cwd=${result.cwd}`];
    if (result.stdout.trim()) lines.push('--- stdout ---', result.stdout.trimEnd());
    if (result.stderr.trim()) lines.push('--- stderr ---', result.stderr.trimEnd());
    if (!result.stdout.trim() && !result.stderr.trim()) lines.push('(không có đầu ra)');
    if (result.truncated.stdout || result.truncated.stderr) lines.push(`[Đầu ra quá dài (${formatBytes(result.outputBytes.stdout)} stdout, ${formatBytes(result.outputBytes.stderr)} stderr) nên phần giữa đã bị lược. Chạy lại với bộ lọc (grep/head/tail) nếu cần phần đó.]`);
    if (result.lingering) lines.push('[Lệnh đã thoát nhưng còn tiến trình nền giữ đầu ra; đầu ra phát sinh sau đó không được ghi nhận.]');
    const failed = result.timedOut || result.cancelled || result.exitCode !== 0;
    const analysis = await this.#assessCommand({ command, shell });
    return {
      isError: failed,
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, cancelled: result.cancelled, durationMs: result.durationMs,
        shell: result.shell, cwd: result.cwd, kind: analysis.risk.kind, truncated: result.truncated, lingering: result.lingering,
      },
    };
  }
}
