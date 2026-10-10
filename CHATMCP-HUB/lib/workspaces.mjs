// The workspaces of the public server: where the agent's files live, how they get their content (a clone from GitHub, or an empty
// repository), how the result leaves (a download, or a push to a new branch of the owner's repository) and how they are removed.
//
// Trust model, in a few sentences. The agent can change anything inside a workspace, including the repository's own `.git` folder
// and configuration. The Hub therefore never lets that configuration touch a secret: the clone and the push are made by the Hub
// itself (with the GitHub token in the environment of that one Git process only), from a URL taken from the Hub's own registry and
// not from `.git/config`; the commits the agent made travel from the workspace to GitHub inside a bundle file that is copied
// (without following links) into a Hub-private folder and unpacked into a fresh repository the agent never touched. The workspace
// root itself is not writable by the agent, so it cannot swap a workspace folder for a link to somewhere else.
//
// Everything the service creates is listed in a registry (workspaces.json in the Hub's private state folder). The folder holds
// nothing else, which is why a leftover folder can be removed safely - but only when the root carries the marker file this service
// writes, so that a mistaken CHATMCP_WORKSPACES_ROOT can never make it delete somebody's files.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GitRunner } from './git-runner.mjs';
import { readJson, redact, resolveProgram, writeJson } from './runtime.mjs';
import { killTree } from './shell-runner.mjs';

const MARKER = '.chatmcp-workspaces';
const NAME = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const SHA = /^[0-9a-f]{40}$/;
const DEFAULT_IDENTITY = Object.freeze({ name: 'ChatMCP Agent', email: 'agent@chatmcp.invalid' });
const CLONE_TIMEOUT_MS = 180_000;
const PUSH_TIMEOUT_MS = 180_000;
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const MAX_PUSH_COMMITS = 500;
const EXPORT_EXCLUDES = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json'];

const fault = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

// ---------------------------------------------------------------------------------------------------------------- pure helpers
/**
 * A repository address the owner typed, reduced to host/owner/repo - or refused. Only https://<allowed host>/<owner>/<repo>[.git] and
 * the shorthand <owner>/<repo> (on the first allowed host) pass. Everything that could make Git talk to another place or run a
 * program (ssh, file, ext::, git://, credentials in the URL, ports, query strings, percent-escapes, whitespace) is refused.
 */
export function parseRepositoryUrl(input, { hosts, allowHttp = false } = {}) {
  if (typeof input !== 'string') throw fault('bad_url', 'Cần địa chỉ kho (https://github.com/chu-so-huu/ten-kho).');
  const text = input.trim();
  if (!text || text.length > 300) throw fault('bad_url', 'Địa chỉ kho trống hoặc quá dài.');
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\%?#@]|::|\.\./.test(text)) throw fault('bad_url', 'Địa chỉ kho chứa ký tự không được phép (khoảng trắng, \\, %, ?, #, @, ::, ..).');
  let host;
  let rest;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme) {
    const protocol = scheme[1].toLowerCase();
    if (protocol !== 'https' && !(allowHttp && protocol === 'http')) throw fault('bad_url', 'Chỉ chấp nhận địa chỉ https://.');
    const afterScheme = text.slice(scheme[0].length);
    const slash = afterScheme.indexOf('/');
    if (slash <= 0) throw fault('bad_url', 'Địa chỉ kho phải có dạng https://host/chu-so-huu/ten-kho.');
    host = afterScheme.slice(0, slash).toLowerCase();
    rest = afterScheme.slice(slash + 1);
  } else if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(text) && !text.includes(':')) {
    host = hosts[0];
    rest = text;
  } else {
    throw fault('bad_url', 'Địa chỉ kho phải là https://host/chu-so-huu/ten-kho hoặc chu-so-huu/ten-kho.');
  }
  if (!hosts.includes(host)) throw fault('host_not_allowed', `Máy chủ Git "${host.slice(0, 80)}" không nằm trong danh sách cho phép (${hosts.join(', ')}). Đặt CHATMCP_GIT_ALLOWED_HOSTS nếu bạn tin máy chủ đó.`, 403);
  const parts = rest.replace(/\/+$/, '').split('/');
  if (parts.length !== 2) throw fault('bad_url', 'Địa chỉ kho phải có đúng hai phần: chủ-sở-hữu/tên-kho.');
  const [owner, rawRepo] = parts;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPOSITORY.test(repo) || repo === '.' || repo === '..' || owner.startsWith('-') || repo.startsWith('-')) throw fault('bad_url', 'Tên chủ sở hữu hoặc tên kho không hợp lệ.');
  const protocol = scheme && scheme[1].toLowerCase() === 'http' ? 'http' : 'https';
  return { host, owner, repo, url: `${protocol}://${host}/${owner}/${repo}.git` };
}

export function workspaceNameFor(owner, repo) {
  const base = `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 56);
  return NAME.test(base) ? base : 'workspace';
}

/** Branch name the owner may ask for; the result always lives under chatmcp/. */
export function pushBranchName(requested, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
  let tail = typeof requested === 'string' && requested.trim() ? requested.trim() : `${stamp}-${randomBytes(2).toString('hex')}`;
  tail = tail.replace(/^chatmcp\//, '');
  if (!BRANCH.test(tail) || tail.includes('..') || tail.includes('//') || tail.endsWith('/') || tail.endsWith('.') || tail.endsWith('.lock') || /\/\./.test(tail) || /@\{/.test(tail)) throw fault('bad_branch', 'Tên nhánh chỉ gồm chữ, số, . _ - / và không được có "..", "//", "@{" hay kết thúc bằng "/", ".", ".lock".');
  return `chatmcp/${tail}`;
}

async function directorySize(directory, { limit = Infinity, maxEntries = 400_000 } = {}) {
  let total = 0;
  let seen = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    let list;
    try { list = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of list) {
      seen += 1;
      if (seen > maxEntries) return total;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      try { total += (await fs.lstat(full)).size; } catch { /* vanished */ }
      if (total > limit) return total;
    }
  }
  return total;
}

/** Copies a regular file into a private place without following a link at the last component. */
async function copyRegularFile(source, target, { maxBytes }) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const input = await fs.open(source, flags);
  try {
    const stat = await input.stat();
    if (!stat.isFile()) throw fault('bad_bundle', 'Tệp trao đổi không phải tệp thường.');
    if (stat.size > maxBytes) throw fault('bundle_too_big', `Các commit mới nặng quá ${(maxBytes / 1048576).toFixed(0)} MB; không đẩy lên được.`, 413);
    const output = await fs.open(target, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let copied = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        copied += bytesRead;
        if (copied > maxBytes) throw fault('bundle_too_big', 'Tệp trao đổi lớn hơn giới hạn.', 413);
        await output.write(buffer, 0, bytesRead);
      }
    } finally { await output.close(); }
  } finally { await input.close(); }
}

// ---------------------------------------------------------------------------------------------------------------- the service
class WorkspaceService {
  constructor({ config, manager, execution, env, log, testing }) {
    this.config = config.workspaces;
    this.manager = manager;
    this.execution = execution;
    this.env = env;
    this.log = log;
    // `testing` exists for the test suite only: nothing in the environment can turn it on. It lets a local plain-HTTP Git server stand in
    // for GitHub (http allowed, and that server's host receives the token like github.com does).
    this.allowHttp = testing?.allowHttp === true;
    this.tokenHosts = new Set(Array.isArray(testing?.tokenHosts) && testing.tokenHosts.length ? testing.tokenHosts : ['github.com']);
    this.hosts = [...this.config.gitHosts];
    this.root = null;
    this.exchange = null;
    this.private = null;
    this.registryFile = path.join(manager.hubDirectory, 'workspaces.json');
    this.items = [];
    this.active = null;
    this.gitExe = null;
    this.identity = {
      name: String(env.CHATMCP_GIT_AUTHOR_NAME ?? '').trim().slice(0, 100) || DEFAULT_IDENTITY.name,
      email: String(env.CHATMCP_GIT_AUTHOR_EMAIL ?? '').trim().slice(0, 100) || DEFAULT_IDENTITY.email,
    };
    if (/[\r\n<>]/.test(this.identity.name + this.identity.email)) throw new Error('CHATMCP_GIT_AUTHOR_NAME/EMAIL không được chứa xuống dòng hoặc < >.');
    this.guard = async (real) => this.#guard(real);
  }

  // -------------------------------------------------------------------------------------------------------------- setup
  async init() {
    const wanted = this.config.root;
    await fs.mkdir(wanted, { recursive: true, mode: 0o750 });
    this.root = await fs.realpath(wanted);
    const marker = path.join(this.root, MARKER);
    const present = await fs.readdir(this.root);
    const hasMarker = present.includes(MARKER);
    if (!hasMarker && present.length > 0) {
      throw new Error(`Thư mục gốc workspace (${path.basename(this.root)}) không rỗng và không do ChatMCP tạo (thiếu ${MARKER}). Đặt CHATMCP_WORKSPACES_ROOT trỏ vào một thư mục rỗng; Hub không bao giờ xóa trong thư mục lạ.`);
    }
    if (!hasMarker) await fs.writeFile(marker, 'ChatMCP workspaces. Everything in this folder is managed by the Hub.\n', { mode: 0o640 });
    this.exchange = path.join(this.root, '.exchange');
    await fs.rm(this.exchange, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(this.exchange, { mode: 0o770 });
    await fs.chmod(this.exchange, 0o2770).catch(() => {});
    this.private = path.join(this.manager.hubDirectory, 'workspace-tmp');
    await fs.rm(this.private, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(this.private, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(this.private, 'empty'), '', { mode: 0o600 });
    await fs.mkdir(path.join(this.private, 'home'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.private, 'no-hooks'), { recursive: true, mode: 0o700 });

    const saved = await readJson(this.registryFile).catch(() => null);
    const known = new Set();
    this.items = [];
    for (const item of saved?.items ?? []) {
      if (!item || !NAME.test(String(item.name)) || known.has(item.name)) continue;
      const stat = await fs.lstat(path.join(this.root, item.name)).catch(() => null);
      if (!stat?.isDirectory()) continue; // the folder is gone (a free server forgets them) - so is the entry
      known.add(item.name);
      this.items.push({ name: item.name, kind: item.kind === 'empty' ? 'empty' : 'clone', origin: item.origin ?? null, branch: item.branch ?? null, baseSha: SHA.test(item.baseSha ?? '') ? item.baseSha : null, createdAt: item.createdAt ?? null });
    }
    // Folders nobody lists are the remains of an interrupted clone. They sit in a root this service marked, so they are ours to remove.
    for (const name of present) {
      if (name === MARKER || name === '.exchange' || known.has(name)) continue;
      await this.#removeFolder(path.join(this.root, name)).catch((error) => this.log(`Không xóa được thư mục thừa ${name}: ${error.message}`));
    }
    await this.#saveRegistry();
  }

  async #saveRegistry() { await writeJson(this.registryFile, { version: 1, items: this.items }); }

  // -------------------------------------------------------------------------------------------------------------- queries
  summary() {
    return { count: this.items.length, max: this.config.max, items: this.items.map((item) => ({ name: item.name, kind: item.kind, branch: item.branch, origin: item.origin ? `${item.origin.host}/${item.origin.owner}/${item.origin.repo}` : null })) };
  }

  async list() {
    const current = this.manager.workspace ? path.basename(this.manager.workspace) : null;
    const items = [];
    for (const item of this.items) {
      const dir = path.join(this.root, item.name);
      items.push({ ...item, path: dir, current: current === item.name && path.dirname(this.manager.workspace) === this.root, exists: Boolean(await fs.lstat(dir).catch(() => null)) });
    }
    return { items, max: this.config.max, count: this.items.length, pushEnabled: Boolean(this.config.githubToken), gitHosts: this.hosts };
  }

  #find(name) {
    const item = typeof name === 'string' ? this.items.find((entry) => entry.name === name) : null;
    if (!item) throw fault('workspace_unknown', 'Không có workspace với tên đó.', 404);
    return item;
  }

  async #guard(real) {
    if (path.dirname(real) !== this.root || !this.items.some((item) => item.name === path.basename(real))) {
      throw fault('workspace_not_allowed', 'Chế độ công khai chỉ chọn được workspace do Hub tạo (clone hoặc tạo mới).', 403);
    }
    const stat = await fs.lstat(real);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('workspace_not_allowed', 'Workspace không phải thư mục thường.', 403);
  }

  async #exclusive(label, work) {
    if (this.active) throw fault('workspace_busy', `Hub đang ${this.active}; chờ xong rồi thử lại.`, 409);
    this.active = label;
    try { return await work(); } finally { this.active = null; }
  }

  // -------------------------------------------------------------------------------------------------------------- Git run by the Hub
  async #gitExecutable() {
    this.gitExe ??= await resolveProgram(process.platform === 'win32' ? 'git.exe' : 'git');
    if (!this.gitExe) throw fault('git_missing', 'Không tìm thấy Git trên máy chủ.', 503);
    return this.gitExe;
  }

  #gitEnvironment({ token = false, host = null, localFile = false } = {}) {
    const allowed = ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'PATHEXT', 'COMSPEC'];
    const env = {};
    for (const name of allowed) if (this.env[name] !== undefined) env[name] = this.env[name];
    Object.assign(env, {
      HOME: path.join(this.private, 'home'), USERPROFILE: path.join(this.private, 'home'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(this.private, 'empty'),
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo',
      GIT_ALLOW_PROTOCOL: `${this.allowHttp ? 'https:http' : 'https'}${localFile ? ':file' : ''}`, GIT_PROTOCOL_FROM_USER: '0',
      GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C', LANGUAGE: 'en', GIT_PAGER: 'cat', GIT_EDITOR: 'true',
    });
    if (token && this.config.githubToken && this.tokenHosts.has(host)) {
      // One header for one URL prefix, in the environment of this process only: not on a command line, not in .git/config.
      const basic = Buffer.from(`x-access-token:${this.config.githubToken}`).toString('base64');
      Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${this.allowHttp ? 'http' : 'https'}://${host}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
    }
    return env;
  }

  /** `localFile` is for the one command that reads the bundle file the Hub itself wrote; nothing else may use the file transport. */
  #transportFlags({ localFile = false } = {}) {
    return [
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...(this.allowHttp ? ['-c', 'protocol.http.allow=always'] : []), ...(localFile ? ['-c', 'protocol.file.allow=always'] : []),
      '-c', 'http.followRedirects=false', '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', '-c', 'receive.fsckObjects=true',
      '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${path.join(this.private, 'no-hooks').replaceAll('\\', '/')}`, '-c', 'submodule.recurse=false',
      '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60',
    ];
  }

  /** Runs Git as the Hub's own account. Never used inside a workspace (see the header comment). */
  async #git(args, { cwd, timeoutMs = 60_000, token = false, host = null, localFile = false, watch = null, maxBytes = 400_000 } = {}) {
    const exe = await this.#gitExecutable();
    const child = spawn(exe, args, { cwd, env: this.#gitEnvironment({ token, host, localFile }), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const out = [];
    const err = [];
    let size = 0;
    const collect = (list) => (chunk) => { size += chunk.length; if (size <= maxBytes * 2) list.push(chunk); };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    let timedOut = false;
    let tooBig = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    let watcher = null;
    if (watch) {
      const check = async () => {
        if (tooBig) return;
        if ((await directorySize(watch.directory, { limit: watch.limit })) > watch.limit) { tooBig = true; killTree(child); }
      };
      watcher = setInterval(() => { void check(); }, 2000);
    }
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      const secrets = this.manager.secrets || [];
      return { code, timedOut, tooBig, stdout: redact(Buffer.concat(out).toString('utf8').slice(-maxBytes), secrets), stderr: redact(Buffer.concat(err).toString('utf8').slice(-maxBytes), secrets), raw: Buffer.concat(out) };
    } catch (error) {
      if (error?.code === 'ENOENT') throw fault('git_missing', 'Không chạy được Git.', 503);
      throw error;
    } finally { clearTimeout(timer); if (watcher) clearInterval(watcher); }
  }

  /** A GitRunner bound to one workspace folder, running under the agent's account when there is one. */
  #runner(directory) {
    const brokered = this.execution.mode === 'broker';
    return new GitRunner({
      workspace: { resolve: async () => ({ root: directory, absolute: directory, relative: '' }) },
      hooksDirectory: path.join(this.private, 'no-hooks'),
      env: this.execution.agentEnv,
      secrets: () => this.manager.secrets || [],
      ...(brokered ? { spawner: this.execution.helperSpawn, safeDirectory: true, hooksDirectory: this.execution.studioOptions.exec.hooksDirectory ?? path.join(this.private, 'no-hooks') } : {}),
    });
  }

  #friendlyGitError(result, what) {
    const text = `${result.stderr}\n${result.stdout}`;
    if (result.timedOut) return fault('git_timeout', `${what} quá thời gian cho phép.`, 504);
    if (/repository not found|not found|does not exist/i.test(text)) return fault('repo_not_found', 'Không tìm thấy kho (sai địa chỉ, hoặc kho riêng tư mà token không có quyền).', 404);
    if (/authentication failed|invalid username or token|could not read username|http 40[13]|returned error: 40[13]|permission to .* denied|forbidden/i.test(text)) return fault('git_auth', `GitHub từ chối quyền (${what}). Với kho riêng tư hoặc khi đẩy, GITHUB_TOKEN phải là token chi tiết có quyền Contents trên đúng kho.`, 403);
    if (/could not resolve host|failed to connect|connection (?:timed out|refused|reset)|unable to access/i.test(text)) return fault('git_network', `Không kết nối được tới máy chủ Git (${what}).`, 502);
    if (/non-fast-forward|fetch first|\[rejected\]|already exists/i.test(text)) return fault('branch_exists', 'Nhánh đó đã có trên GitHub với lịch sử khác. Chọn tên nhánh khác.', 409);
    return fault('git_failed', `${what} thất bại: ${text.trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'không rõ lý do'}`, 502);
  }

  // -------------------------------------------------------------------------------------------------------------- create / clone
  async #newFolder(preferred) {
    let name = preferred;
    for (let n = 2; this.items.some((item) => item.name === name) || (await fs.lstat(path.join(this.root, name)).catch(() => null)); n += 1) name = `${preferred.slice(0, 54)}-${n}`;
    const directory = path.join(this.root, name);
    await fs.mkdir(directory, { mode: 0o775 }); // below the setgid root, so the group is inherited
    await fs.chmod(directory, 0o2775).catch(() => {});
    return { name, directory };
  }

  async #checkCapacity() {
    if (this.items.length >= this.config.max) throw fault('workspace_limit', `Đã đủ ${this.config.max} workspace. Xóa bớt một workspace (sau khi push hoặc tải về) rồi thử lại.`, 409);
    const stats = await fs.statfs(this.root).catch(() => null);
    if (stats && stats.bavail * stats.bsize < this.config.maxCloneBytes + 64 * 1024 * 1024) throw fault('disk_full', 'Ổ đĩa của máy chủ không đủ chỗ cho một kho mới. Xóa bớt workspace.', 507);
  }

  async #configureIdentity(directory) {
    for (const [key, value] of [['user.name', this.identity.name], ['user.email', this.identity.email]]) {
      const result = await this.#git(['-C', directory, 'config', '--local', key, value], { cwd: directory });
      if (result.code !== 0) throw fault('git_failed', 'Không đặt được danh tính commit cho kho.', 500);
    }
  }

  async clone(payload = {}) {
    return this.#exclusive('clone kho', async () => {
      const repository = parseRepositoryUrl(payload.url, { hosts: this.hosts, allowHttp: this.allowHttp });
      const branch = payload.branch === undefined || payload.branch === '' ? null : String(payload.branch);
      if (branch !== null && (!BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock'))) throw fault('bad_branch', 'Tên nhánh không hợp lệ.');
      const depth = payload.depth === undefined ? 50 : Number(payload.depth);
      if (!Number.isInteger(depth) || depth < 1 || depth > 1000) throw fault('bad_depth', 'depth phải là số nguyên từ 1 đến 1000.');
      await this.#checkCapacity();
      const { name, directory } = await this.#newFolder(workspaceNameFor(repository.owner, repository.repo));
      try {
        const result = await this.#git([
          ...this.#transportFlags(), 'clone', '--depth', String(depth), '--single-branch', '--no-tags', '--no-recurse-submodules', '--template=',
          ...(branch ? ['--branch', branch] : []), '--', repository.url, directory,
        ], { cwd: this.root, timeoutMs: CLONE_TIMEOUT_MS, token: true, host: repository.host, watch: { directory, limit: this.config.maxCloneBytes } });
        if (result.tooBig) throw fault('clone_too_big', `Kho lớn hơn giới hạn ${Math.round(this.config.maxCloneBytes / 1048576)} MB (CHATMCP_MAX_CLONE_MB).`, 413);
        if (result.code !== 0 || result.timedOut) throw this.#friendlyGitError(result, 'Clone');
        if ((await directorySize(directory, { limit: this.config.maxCloneBytes })) > this.config.maxCloneBytes) throw fault('clone_too_big', `Kho lớn hơn giới hạn ${Math.round(this.config.maxCloneBytes / 1048576)} MB (CHATMCP_MAX_CLONE_MB).`, 413);
        await this.#configureIdentity(directory);
        const head = await this.#git(['-C', directory, 'rev-parse', 'HEAD'], { cwd: directory });
        const current = await this.#git(['-C', directory, 'symbolic-ref', '--short', '-q', 'HEAD'], { cwd: directory });
        const baseSha = head.stdout.trim();
        if (head.code !== 0 || !SHA.test(baseSha)) throw fault('git_failed', 'Kho rỗng hoặc không đọc được commit đầu.', 502);
        const item = { name, kind: 'clone', origin: { host: repository.host, owner: repository.owner, repo: repository.repo }, branch: current.code === 0 ? current.stdout.trim() : null, baseSha, createdAt: new Date().toISOString() };
        this.items.push(item);
        await this.#saveRegistry();
        this.log(`Đã clone ${repository.host}/${repository.owner}/${repository.repo} vào workspace ${name}.`);
        return { name, path: directory, ...item };
      } catch (error) {
        await this.#removeFolder(directory).catch(() => {});
        throw error;
      }
    });
  }

  async create(payload = {}) {
    return this.#exclusive('tạo workspace', async () => {
      const requested = String(payload.name ?? 'workspace').trim().toLowerCase();
      if (!NAME.test(requested)) throw fault('bad_name', 'Tên workspace chỉ gồm chữ thường, số, . _ - (tối đa 60 ký tự).');
      await this.#checkCapacity();
      const { name, directory } = await this.#newFolder(requested);
      try {
        const init = await this.#git(['-c', 'init.templateDir=', 'init', '--initial-branch=main', '--template=', '--', directory], { cwd: this.root });
        if (init.code !== 0) throw fault('git_failed', 'git init thất bại.', 500);
        await this.#configureIdentity(directory);
        const item = { name, kind: 'empty', origin: null, branch: 'main', baseSha: null, createdAt: new Date().toISOString() };
        this.items.push(item);
        await this.#saveRegistry();
        return { name, path: directory, ...item };
      } catch (error) {
        await this.#removeFolder(directory).catch(() => {});
        throw error;
      }
    });
  }

  // -------------------------------------------------------------------------------------------------------------- remove
  /** Removes a folder. Files the agent made may be ones the Hub's account may not delete; then the agent's account empties it. */
  async #removeFolder(directory) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EACCES', 'EPERM', 'ENOTEMPTY'].includes(error.code) || !this.execution.helperSpawn) throw error;
    }
    const find = await resolveProgram('find');
    if (!find) throw fault('remove_failed', 'Không xóa được workspace (thiếu công cụ find).', 500);
    await new Promise((resolve) => {
      const child = this.execution.helperSpawn(find, [directory, '-mindepth', '1', '-delete'], { cwd: this.root, env: this.execution.agentEnv, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: true, timeout: 120_000 });
      child.stdout.resume(); child.stderr.resume();
      child.once('error', () => resolve());
      child.once('close', () => resolve());
    });
    await fs.rm(directory, { recursive: true, force: true });
  }

  async remove(payload = {}, { current = null } = {}) {
    return this.#exclusive('xóa workspace', async () => {
      const item = this.#find(payload.name);
      const directory = path.join(this.root, item.name);
      const wasCurrent = Boolean(current) && path.resolve(current) === directory;
      if (wasCurrent) await this.manager.clearWorkspace();
      await this.#removeFolder(directory);
      this.items = this.items.filter((entry) => entry !== item);
      await this.#saveRegistry();
      this.log(`Đã xóa workspace ${item.name}.`);
      return { name: item.name, wasCurrent };
    });
  }

  // -------------------------------------------------------------------------------------------------------------- export
  /**
   * Streams the working tree as .tar.gz (no .git, no dependency folders, no secret-looking files). tar runs under the agent's
   * account when there is one, so it reads the tree with the agent's rights and the Hub never follows a link the agent planted.
   */
  async exportArchive(res, name, { onError }) {
    let item;
    try { item = this.#find(name); } catch (error) { onError(error.statusCode, error.message, error.code); return; }
    const tar = await resolveProgram(process.platform === 'win32' ? 'tar.exe' : 'tar');
    if (!tar) { onError(503, 'Máy chủ không có tar.', 'tar_missing'); return; }
    const directory = path.join(this.root, item.name);
    const excludes = EXPORT_EXCLUDES.flatMap((pattern) => ['--exclude', pattern]);
    const spawnFn = this.execution.helperSpawn;
    const child = spawnFn(tar, ['-czf', '-', ...excludes, '-C', directory, '.'], { cwd: this.root, env: this.execution.agentEnv, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', timeout: 15 * 60_000, maxOutputBytes: 1024 * 1024 * 1024 });
    let started = false;
    let finished = false;
    let stderrText = '';
    child.stderr.on('data', (chunk) => { if (stderrText.length < 2000) stderrText += chunk.toString('utf8'); });
    child.stderr.on('error', () => {});
    child.stdout.on('error', () => {});
    res.once('close', () => { if (!finished) killTree(child); });
    child.stdout.on('data', (chunk) => {
      if (!started) {
        started = true;
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${item.name}.tar.gz"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      }
      if (!res.write(chunk)) { child.stdout.pause(); res.once('drain', () => child.stdout.resume()); }
    });
    await new Promise((resolve) => {
      child.once('error', (error) => { finished = true; if (!started) onError(500, `Không chạy được tar: ${String(error.message).slice(0, 200)}`, 'tar_failed'); else res.destroy(); resolve(); });
      child.once('close', (code) => {
        finished = true;
        if (!started) {
          if (code === 0 || code === 1) { res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${item.name}.tar.gz"`, 'Cache-Control': 'no-store' }); res.end(); }
          else onError(500, `tar thất bại (mã ${code}): ${redact(stderrText, this.manager.secrets || []).slice(0, 300)}`, 'tar_failed');
        } else if (code === 0 || code === 1) res.end(); // 1: some file changed while it was read - the archive is still complete
        else res.destroy();
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------- push
  async push(payload = {}) {
    return this.#exclusive('đẩy lên GitHub', async () => {
      if (payload.force === true || payload.force === 'true') throw fault('force_refused', 'Hub không bao giờ force-push.', 400);
      if (!this.config.githubToken) throw fault('no_github_token', 'Chưa đặt GITHUB_TOKEN nên Hub không đẩy lên GitHub được. Dùng "Tải về" để lấy mã, hoặc thêm token chi tiết (quyền Contents: read/write trên đúng một kho) vào biến môi trường GITHUB_TOKEN.', 409);
      const item = this.#find(payload.name);
      if (!item.origin || !this.tokenHosts.has(item.origin.host) || !item.baseSha) throw fault('push_unsupported', 'Chỉ đẩy được workspace clone từ github.com.', 409);
      const branch = pushBranchName(payload.branch);
      const directory = path.join(this.root, item.name);
      const runner = this.#runner(directory);
      const text = async (args, options) => { const result = await runner.text(args, { timeoutMs: 60_000, ...options }); return result; };

      await runner.ensureRepo();
      const head = (await text(['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout.trim();
      if (!SHA.test(head)) throw fault('nothing_to_push', 'Workspace chưa có commit nào.', 409);
      if (head === item.baseSha) throw fault('nothing_to_push', 'Chưa có commit mới nào so với lúc clone. Hãy yêu cầu agent commit, hoặc tự commit trong terminal.', 409);
      const ancestor = await text(['merge-base', '--is-ancestor', item.baseSha, head]);
      if (ancestor.code !== 0) throw fault('history_rewritten', 'Lịch sử không còn bắt đầu từ commit lúc clone (đã rebase/reset?). Hub chỉ đẩy các commit mới nối tiếp commit gốc.', 409);
      const count = Number((await text(['rev-list', '--count', `${item.baseSha}..${head}`])).stdout.trim());
      if (!Number.isInteger(count) || count < 1 || count > MAX_PUSH_COMMITS) throw fault('too_many_commits', `Số commit mới phải từ 1 đến ${MAX_PUSH_COMMITS}.`, 409);
      const status = await text(['status', '--porcelain=v1', '--untracked-files=normal']);
      const warnings = [];
      if (status.code === 0 && status.stdout.trim()) warnings.push('Còn thay đổi chưa commit trong workspace; chúng KHÔNG được đẩy lên.');

      const exchange = path.join(this.exchange, randomBytes(8).toString('hex'));
      await fs.mkdir(exchange, { mode: 0o770 });
      await fs.chmod(exchange, 0o2770).catch(() => {});
      const scratch = await fs.mkdtemp(path.join(this.private, 'push-'));
      try {
        // 1. The agent's account packs the new commits (the repository is the agent's to change, so nothing here is trusted).
        const bundleOut = path.join(exchange, 'new.bundle');
        const packed = await runner.text(['bundle', 'create', bundleOut, 'HEAD', `^${item.baseSha}`], { timeoutMs: 120_000, writes: true });
        if (packed.code !== 0) throw fault('bundle_failed', `Không đóng gói được các commit mới: ${packed.stderr.trim().slice(0, 200)}`, 500);
        // 2. The Hub copies it, without following links, to a place only the Hub can reach.
        const bundle = path.join(scratch, 'new.bundle');
        await copyRegularFile(bundleOut, bundle, { maxBytes: MAX_BUNDLE_BYTES });
        // 3. A fresh repository, made by the Hub, that holds only: the original base commit from GitHub, and the bundle.
        const repo = path.join(scratch, 'repo.git');
        const init = await this.#git(['init', '--bare', '--initial-branch=main', '--template=', '--', repo], { cwd: scratch });
        if (init.code !== 0) throw fault('git_failed', 'Không tạo được kho tạm.', 500);
        const remote = `${this.allowHttp ? 'http' : 'https'}://${item.origin.host}/${item.origin.owner}/${item.origin.repo}.git`;
        const flags = ['--git-dir', repo, ...this.#transportFlags()];
        const base = await this.#git([...flags, 'fetch', '--depth=1', '--no-tags', '--quiet', remote, item.baseSha], { cwd: scratch, timeoutMs: PUSH_TIMEOUT_MS, token: true, host: item.origin.host });
        if (base.code !== 0 || base.timedOut) throw this.#friendlyGitError(base, 'Lấy commit gốc từ GitHub');
        const heads = await this.#git([...flags, 'bundle', 'list-heads', bundle], { cwd: scratch });
        const ref = heads.stdout.split('\n').map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === 'HEAD');
        if (heads.code !== 0 || !ref || !SHA.test(ref[0])) throw fault('bundle_failed', 'Gói commit không hợp lệ.', 500);
        const unpack = await this.#git(['--git-dir', repo, ...this.#transportFlags({ localFile: true }), 'fetch', '--no-tags', '--quiet', bundle, 'HEAD:refs/heads/work'], { cwd: scratch, timeoutMs: 120_000, localFile: true });
        if (unpack.code !== 0) throw fault('bundle_failed', `Gói commit không qua được kiểm tra toàn vẹn: ${unpack.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200)}`, 422);
        const tip = (await this.#git([...flags, 'rev-parse', '--verify', 'refs/heads/work'], { cwd: scratch })).stdout.trim();
        const descends = await this.#git([...flags, 'merge-base', '--is-ancestor', item.baseSha, tip], { cwd: scratch });
        if (!SHA.test(tip) || descends.code !== 0) throw fault('history_rewritten', 'Các commit mới không nối tiếp commit gốc.', 409);
        // 4. One new branch, never forced, never an existing one.
        const present = await this.#git([...flags, 'ls-remote', '--heads', remote, `refs/heads/${branch}`], { cwd: scratch, timeoutMs: 60_000, token: true, host: item.origin.host });
        if (present.code !== 0 || present.timedOut) throw this.#friendlyGitError(present, 'Kiểm tra nhánh trên GitHub');
        if (present.stdout.trim()) throw fault('branch_exists', `Nhánh ${branch} đã có trên GitHub. Chọn tên nhánh khác.`, 409);
        const pushed = await this.#git([...flags, 'push', '--porcelain', remote, `refs/heads/work:refs/heads/${branch}`], { cwd: scratch, timeoutMs: PUSH_TIMEOUT_MS, token: true, host: item.origin.host });
        if (pushed.code !== 0 || pushed.timedOut) throw this.#friendlyGitError(pushed, 'Đẩy lên GitHub');
        this.log(`Đã đẩy ${count} commit lên nhánh ${branch} của ${item.origin.owner}/${item.origin.repo}.`);
        const baseBranch = item.branch ? encodeURIComponent(item.branch) : 'HEAD';
        return {
          branch, commit: tip, base: item.baseSha, commits: count, warnings,
          compareUrl: item.origin.host === 'github.com'
            ? `https://github.com/${item.origin.owner}/${item.origin.repo}/compare/${baseBranch}...${branch.split('/').map(encodeURIComponent).join('/')}?expand=1`
            : null,
        };
      } finally {
        await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
        await this.#removeFolder(exchange).catch(() => {});
      }
    });
  }
}

export async function createWorkspaceService({ config, manager, execution, env = process.env, log = () => {}, testing = null }) {
  const service = new WorkspaceService({ config, manager, execution, env, log, testing });
  await service.init();
  return service;
}
