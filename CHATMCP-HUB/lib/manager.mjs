import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { exists, readJson, writeJson, collectSecrets, redact, resolveProgram, npmCli, portOpen, spawnLogged, run, stopOwned, delay, isObject } from './runtime.mjs';
import { makeInstructions } from './instructions.mjs';
import { listAll, collectCatalog, verifyProxyCatalog, closeConnection, makeAgentSession, buildInternalCatalog } from './catalog.mjs';

export const VERSION = '2.3.0';
const PROXY_PORT = 3006;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}/mcp`;
const baseService = () => ({ state: 'unknown', detail: 'Chưa kiểm tra' });
const unusedService = () => ({ state: 'disabled', detail: 'Không dùng ở chế độ cục bộ' });
export const BACKENDS = Object.freeze(['local', 'mcp']);
// The local backend has its own file, search, Git and shell tools. Of the older Studio tools only those that add
// something are offered next to them (code intelligence, test discovery, checkpoints); the rest would duplicate local.*.
const LOCAL_BACKEND_STUDIO_TOOLS = new Set(['symbols', 'references', 'definitions', 'index_status', 'checks', 'skills', 'diff_check', 'checkpoints', 'checkpoint', 'review']);
const CHECKPOINT_CATEGORIES = new Set(['workspace_edit', 'dangerous', 'execute', 'unknown']);
// Calls that pass the same gate as a file edit without being one: a test run may write caches or build output, Git bookkeeping changes .git.
const NOT_FILE_EDITS = new Set(['local.run_command', 'local.git_add', 'local.git_commit', 'local.git_branch']);

/** Where the Hub keeps its state when no directory is given: per-user, outside any project. */
export function defaultDataDirectory(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.CHATMCP_STATE_DIR) return path.resolve(env.CHATMCP_STATE_DIR);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ChatMCP', 'hub');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ChatMCP', 'hub');
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'chatmcp');
}

export class HubManager {
  /**
   * backend 'local': tools run inside the Hub; nothing else needs to be installed or running (default without repoRoot).
   * backend 'mcp':   the original flow through Cloud Harness + Desktop Commander + the MCP proxy (needs repoRoot).
   */
  constructor({ repoRoot = null, bundleRoot, dataDirectory = null, backend = null, log = console.log }) {
    this.repoRoot = repoRoot ? path.resolve(repoRoot) : null;
    this.bundleRoot = path.resolve(bundleRoot);
    this.backend = backend ?? (this.repoRoot ? 'mcp' : 'local');
    if (!BACKENDS.includes(this.backend)) throw new Error(`Backend phải là ${BACKENDS.join(' hoặc ')}.`);
    if (this.backend === 'mcp' && !this.repoRoot) throw new Error('Backend mcp cần --repo-root (thư mục repository Cloud Harness).');
    if (!this.repoRoot && !dataDirectory) throw new TypeError('HubManager cần repoRoot hoặc dataDirectory.');
    this.generated = this.repoRoot ? path.join(this.repoRoot, 'deploy', '.generated') : null;
    this.hubDirectory = dataDirectory ? path.resolve(dataDirectory) : path.join(this.generated, 'chatmcp-hub');
    this.proxyRuntime = this.generated ? path.join(this.generated, 'browser-proxy-compat') : null;
    this.dcRuntime = this.generated ? path.join(this.generated, 'desktop-commander-local') : null;
    this.settingsFile = path.join(this.hubDirectory, 'hub-state.json');
    this.proxyConfig = path.join(this.hubDirectory, 'mcp-client.hub.json');
    this.proxyPackage = this.proxyRuntime ? path.join(this.proxyRuntime, 'node_modules', '@srbhptl39', 'mcp-superassistant-proxy') : null;
    this.dcPackage = this.dcRuntime ? path.join(this.dcRuntime, 'node_modules', '@wonderwhy-er', 'desktop-commander') : null;
    this.output = log;
    this.secrets = [];
    this.logs = [];
    this.workspace = null;
    this.busy = false;
    this.lastError = null;
    this.services = this.backend === 'local'
      ? { local: baseService(), docker: unusedService(), cloud: unusedService(), proxy: unusedService(), desktop: unusedService() }
      : { docker: baseService(), cloud: baseService(), proxy: baseService(), desktop: baseService() };
    this.proxyChild = null;
    this.children = new Set();
    this.tools = [];
    this.sdk = null;
    this.stopping = false;
    this.config = null;
    this.generation = 0;
    this.instanceId = randomUUID();
    this.expectedStops = new WeakSet();
    this.pickerOpen = false;
    this.taskId = null;
    this.catalog = { ready: false, tools: [], prompts: [], resources: [], resourceTemplates: [], counts: {}, servers: {} };
    this.agentSessions = new Set();
    this.studio = null;
    this.permissions = null;
    this.studioTools = null;
    this.localTools = null;
    this.environment = null;
    this.workflow = null;
  }

  log(message) {
    const clean = redact(message, this.secrets);
    if (!clean.trim()) return;
    const line = `${new Date().toLocaleTimeString('vi-VN', { hour12: false })}  ${clean}`;
    this.logs.push(line);
    if (this.logs.length > 160) this.logs.splice(0, this.logs.length - 160);
    this.output(`[CHATMCP-HUB] ${clean}`);
  }

  status(name, state, detail) { this.services[name] = { state, detail }; }
  state() {
    return {
      version: VERSION, backend: this.backend, workspace: { path: this.workspace }, busy: this.busy || Boolean(this.taskId),
      services: structuredClone(this.services), proxyUrl: this.backend === 'mcp' ? PROXY_URL : null,
      dataDirectory: this.hubDirectory, environment: this.environment,
      lastError: this.lastError, logs: [...this.logs], toolCount: this.tools.length,
      generation: this.generation, instanceId: this.instanceId,
      toolCounts: { ...this.catalog.counts }, catalogReady: this.catalog.ready, taskId: this.taskId,
    };
  }

  async load(project) {
    await fs.mkdir(this.hubDirectory, { recursive: true });
    const saved = await readJson(this.settingsFile);
    const legacy = this.dcRuntime ? await readJson(path.join(this.dcRuntime, 'local-settings.json')) : null;
    const candidate = project || saved?.workspace || legacy?.projectPath;
    if (candidate) {
      try { this.workspace = await this.validateWorkspace(candidate); }
      catch { this.log('Thư mục đã lưu không còn truy cập được. Hãy chọn lại trên trang localhost.'); }
    }
    if (this.backend === 'local') {
      this.status('local', 'stopped', this.workspace ? 'Chưa khởi động' : 'Chọn một thư mục dự án để bắt đầu');
      return;
    }
    this.status('proxy', 'stopped', 'Bấm Khởi động hoặc chọn workspace');
    this.status('desktop', 'stopped', this.workspace ? 'Chưa khởi động' : 'Chưa chọn workspace');
  }

  async validateWorkspace(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw new Error('Hãy chọn một đường dẫn thư mục hợp lệ.');
    if (!path.isAbsolute(value)) throw new Error('Đường dẫn workspace phải là đường dẫn tuyệt đối.');
    const real = await fs.realpath(value.trim());
    if (!(await fs.stat(real)).isDirectory()) throw new Error('Workspace phải là một thư mục.');
    return real;
  }

  async exclusive(operation) {
    if (this.busy || this.taskId) { const error = new Error('Hub đang xử lý một thao tác hoặc nhiệm vụ. Chờ hoàn tất hoặc hủy nhiệm vụ trước khi đổi workspace/dịch vụ.'); error.statusCode = 409; throw error; }
    this.busy = true;
    this.lastError = null;
    try { await operation(); }
    catch (error) {
      this.lastError = redact(error.message ?? 'Thao tác không thành công.', this.secrets);
      this.log(this.lastError);
      for (const [name, service] of Object.entries(this.services)) if (service.state === 'starting') this.status(name, 'error', this.lastError);
      throw error;
    } finally { this.busy = false; }
    return this.state();
  }

  async checkedRun(command, args, options = {}) {
    const proc = spawnLogged(command, args, { log: (line) => this.log(line), ...options });
    this.children.add(proc.child);
    try {
      const result = await proc.completion;
      if (result.code !== 0) throw new Error(`${path.basename(command)} dừng với mã ${result.code ?? result.signal}. Xem nhật ký để biết bước chưa hoàn tất.`);
      return result.output;
    } finally { this.children.delete(proc.child); }
  }

  async ensurePackage(runtime, name, version) {
    const packageRoot = path.join(runtime, 'node_modules', ...name.split('/'));
    const installed = await readJson(path.join(packageRoot, 'package.json'));
    const marker = path.join(runtime, `hub-install-${version}.ok`);
    const previousInstallerMarker = path.join(runtime, `install-complete-${version}.txt`);
    if (installed?.version === version && await exists(path.join(packageRoot, 'dist', 'index.js')) && (await exists(marker) || await exists(previousInstallerMarker))) {
      this.log(`Dùng ${name}@${version} đã cài.`);
      return;
    }
    await fs.mkdir(runtime, { recursive: true });
    const ownManifest = path.join(runtime, 'package.json');
    if (!await exists(ownManifest)) await writeJson(ownManifest, { name: 'chatmcp-hub-runtime', version: VERSION, private: true });
    this.log(`Đang cài ${name}@${version}. Lần đầu có thể mất vài phút.`);
    const npm = await npmCli();
    await fs.unlink(marker).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    await fs.unlink(previousInstallerMarker).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    await this.checkedRun(process.execPath, [npm, 'install', '--prefix', runtime, '--save-exact', '--prefer-offline', '--omit=dev', '--no-audit', '--no-fund', '--loglevel', 'warn', `${name}@${version}`], { timeout: 900000 });
    const verified = await readJson(path.join(packageRoot, 'package.json'));
    if (verified?.version !== version) throw new Error(`Chưa cài được đúng ${name}@${version}.`);
    await fs.writeFile(marker, `${name}@${version}\n`, 'utf8');
  }

  async ensurePackages() {
    await this.ensurePackage(this.dcRuntime, '@wonderwhy-er/desktop-commander', '0.2.52');
    await this.ensurePackage(this.proxyRuntime, '@srbhptl39/mcp-superassistant-proxy', '0.1.8');
    const require = createRequire(path.join(this.dcPackage, 'package.json'));
    try {
      const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
      const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);
      const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
      const schemas = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/types.js')).href);
      this.sdk = { Client, StreamableHTTPClientTransport, StdioClientTransport, schemas };
    } catch {
      throw new Error('Các dependency MCP chưa đầy đủ. Chạy lại bộ SETUP-MCP-LOCAL hoặc npm install trong desktop-commander-local rồi mở Hub lại.');
    }
  }

  async withMcp(url, headers, callback, { signal } = {}) {
    if (!this.sdk) throw new Error('MCP SDK chưa sẵn sàng.');
    signal?.throwIfAborted();
    const { Client, StreamableHTTPClientTransport } = this.sdk;
    const client = new Client({ name: 'chatmcp-hub', version: VERSION }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : {});
    let deadline;
    let abort;
    try {
      return await Promise.race([
        (async () => { await client.connect(transport, { signal, timeout: 30000 }); signal?.throwIfAborted(); return await callback(client); })(),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('MCP không phản hồi kịp. Kiểm tra dịch vụ rồi bấm Khởi động lại.')), 30000); }),
        ...(signal ? [new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); })] : []),
      ]);
    } finally {
      clearTimeout(deadline);
      if (abort) signal.removeEventListener('abort', abort);
      // Explicitly end only the hub's short-lived probe session. This does not
      // terminate sessions belonging to the user's browser extension.
      await closeConnection({ client, transport });
    }
  }

  async readSourceConfig() {
    const source = path.join(this.generated, 'mcp-client.proxy.json');
    const config = await readJson(source);
    if (!isObject(config?.mcpServers) || !isObject(config.mcpServers['cloud-harness'])) throw new Error('Chưa có mcp-client.proxy.json hợp lệ của bộ Cloud Harness hiện tại.');
    this.secrets = [...new Set([...this.secrets, ...collectSecrets(config)])];
    const cloud = config.mcpServers['cloud-harness'];
    let target;
    try { target = new URL(cloud.url); } catch { throw new Error('URL Cloud Harness trong cấu hình không hợp lệ.'); }
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !/^\/mcp\/?$/.test(target.pathname)) throw new Error('Hub cần URL Cloud Harness local http://127.0.0.1:3100/mcp trong mcp-client.proxy.json.');
    if (!isObject(cloud.headers) || !/^Bearer\s+\S+$/i.test(cloud.headers.Authorization ?? '')) throw new Error('Cấu hình Cloud Harness thiếu thông tin xác thực. Chạy lại launcher Cloud Harness đã dùng trước đây.');
    this.config = config;
    return cloud;
  }

  async ensureDocker() {
    this.status('docker', 'starting', 'Đang kiểm tra Docker Desktop');
    const docker = await resolveProgram('docker.exe', [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')]);
    if (!docker) throw new Error('Không tìm thấy docker.exe. Cần bản Docker Desktop bạn đã dùng với Cloud Harness.');
    const available = async () => {
      try { await run(docker, ['info', '--format', '{{.ServerVersion}}'], { quiet: true, timeout: 12000 }); return true; }
      catch { return false; }
    };
    if (!await available()) {
      const desktop = await resolveProgram('Docker Desktop.exe', [
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Docker', 'Docker', 'Docker Desktop.exe'),
      ]);
      if (!desktop) throw new Error('Hãy mở Docker Desktop, chờ engine sẵn sàng rồi bấm Khởi động MCP.');
      this.log('Đang mở Docker Desktop...');
      await this.openProgram(desktop, []);
      const until = Date.now() + 150000;
      while (Date.now() < until) {
        if (await available()) { this.status('docker', 'ready', 'Docker engine sẵn sàng'); return; }
        await delay(2000);
      }
      throw new Error('Docker Desktop chưa sẵn sàng. Kiểm tra cửa sổ Docker rồi bấm Khởi động MCP.');
    }
    this.status('docker', 'ready', 'Docker engine sẵn sàng');
  }

  async ensureCloud() {
    let cloud = await this.readSourceConfig();
    this.status('cloud', 'starting', 'Đang kiểm tra Cloud Harness local');
    const probe = async () => this.withMcp(cloud.url, cloud.headers, async (client) => {
      const listing = await listAll(client, 'tools', this.sdk.schemas);
      if (!listing.some((t) => t.name === 'workspace_list')) throw new Error('Endpoint không cung cấp công cụ Cloud Harness mong đợi.');
    });
    let ready = false;
    if (await portOpen(Number(new URL(cloud.url).port || 80))) { try { await probe(); ready = true; } catch {} }
    if (!ready) {
      const startup = path.join(this.generated, 'start-cloud-harness.ps1');
      if (!await exists(startup)) throw new Error('Không tìm thấy deploy/.generated/start-cloud-harness.ps1 của bộ Cloud Harness hiện tại.');
      const powershell = await this.powerShell();
      this.log('Đang gọi launcher Cloud Harness hiện tại...');
      await this.checkedRun(powershell, ['-NoLogo', '-NoProfile', '-File', startup], { cwd: path.dirname(this.repoRoot), timeout: 240000 });
      cloud = await this.readSourceConfig();
      await probe();
    }
    this.status('cloud', 'ready', 'Cloud Harness local đã phản hồi MCP');
  }

  async powerShell() {
    const program = await resolveProgram('powershell.exe', [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]);
    if (!program) throw new Error('Không tìm thấy Windows PowerShell.');
    return program;
  }

  async openProgram(program, args) {
    await new Promise((resolve, reject) => {
      const child = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }

  async configureWorkspace(workspace) {
    this.status('desktop', 'starting', 'Đang đặt và kiểm tra workspace Windows');
    const config = structuredClone(this.config);
    // The hub maintains its own copy. The user's original proxy configuration
    // and launcher remain available for returning to the previous workflow.
    delete config.mcpServers['desktop-commander'];
    if (await exists(this.proxyConfig)) {
      const backup = `${this.proxyConfig}.before-${Date.now()}.bak`;
      await fs.copyFile(this.proxyConfig, backup, constants.COPYFILE_EXCL);
    }
    await writeJson(this.proxyConfig, config);
    await this.checkedRun(process.execPath, [path.join(this.bundleRoot, 'lib', 'configure-local.mjs'), workspace, this.proxyConfig, this.dcRuntime], { timeout: 120000 });
    this.workspace = workspace;
    await writeJson(this.settingsFile, { version: VERSION, workspace, savedAt: new Date().toISOString() });
    this.status('desktop', 'starting', 'Đã kiểm tra thư mục; đang nối vào proxy');
  }

  async startProxy() {
    this.status('proxy', 'starting', 'Đang mở MCP tại 127.0.0.1:3006');
    const proc = spawnLogged(process.execPath, [
      path.join(this.bundleRoot, 'lib', 'proxy-adapter.mjs'), '--package-root', this.proxyPackage,
      '--config', this.proxyConfig, '--outputTransport', 'streamableHttp', '--stateful',
      '--host', '127.0.0.1', '--port', String(PROXY_PORT), '--logLevel', 'info',
      '--cors', 'https://chatgpt.com', 'chrome-extension://kngiafgkdnlkgmefdafaibkibegkcaef',
    ], { cwd: this.workspace, log: (line) => this.log(line) });
    this.proxyChild = proc.child;
    this.children.add(proc.child);
    proc.completion.then((result) => {
      this.children.delete(proc.child);
      if (this.proxyChild === proc.child) this.proxyChild = null;
      if (!this.expectedStops.has(proc.child)) {
        this.tools = [];
        this.catalog.ready = false;
        this.status('proxy', 'error', `Proxy đã dừng (${result.code ?? result.signal})`);
        this.status('desktop', 'stopped', 'Kết nối proxy đã dừng');
        this.lastError = 'Proxy đã dừng. Xem nhật ký rồi bấm Khởi động MCP.';
      }
    }).catch((error) => {
      this.children.delete(proc.child);
      if (this.proxyChild === proc.child) this.proxyChild = null;
      this.log(error.message);
      this.status('proxy', 'error', 'Không khởi động được proxy');
    });
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) throw new Error('Proxy dừng trước khi kết nối. Xem nhật ký bên dưới.');
      if (await portOpen(PROXY_PORT)) break;
      await delay(300);
    }
    if (!await portOpen(PROXY_PORT)) throw new Error('Proxy chưa mở được cổng 3006.');
    await this.withMcp(PROXY_URL, null, async (client) => {
      const tools = await listAll(client, 'tools', this.sdk.schemas);
      const names = new Set(tools.map((t) => t.name));
      if (!names.has('desktop-commander.list_directory') || !names.has('cloud-harness.workspace_list')) throw new Error('Proxy chưa cung cấp đủ Desktop Commander và Cloud Harness.');
      const read = await client.callTool({ name: 'desktop-commander.list_directory', arguments: { path: this.workspace, depth: 1 } });
      if (read.isError) throw new Error('Desktop Commander chưa đọc được workspace đã chọn.');
      const connections = await this.openDirectConnections();
      try {
        const catalog = await collectCatalog(connections, this.sdk.schemas);
        if (!catalog.counts['cloud-harness'] || !catalog.counts['desktop-commander']) throw new Error('Một server không trả công cụ. Chưa cho chạy nhiệm vụ.');
        catalog.proxyVerification = verifyProxyCatalog(catalog.tools, tools);
        this.catalog = catalog;
        this.tools = catalog.tools;
      } finally { await Promise.allSettled([...connections.values()].map(closeConnection)); }
    });
    this.generation += 1;
    this.status('proxy', 'ready', `Đã kết nối ${this.tools.length} công cụ; do Hub quản lý`);
    this.status('desktop', 'ready', 'Đã đọc được workspace Windows');
    this.log(`Đã đối chiếu đủ công cụ: Cloud Harness ${this.catalog.counts['cloud-harness']}; Desktop Commander ${this.catalog.counts['desktop-commander']}.`);
  }

  async startCore(workspace = this.workspace) {
    if (!workspace) throw new Error('Hãy chọn thư mục workspace trước.');
    const target = await this.validateWorkspace(workspace);
    if (this.proxyChild && target === this.workspace && this.services.proxy.state === 'ready') return;
    if (!this.proxyChild && await portOpen(PROXY_PORT)) {
      this.status('proxy', 'error', 'Cổng 3006 đang do cửa sổ proxy cũ hoặc ứng dụng khác sử dụng');
      throw new Error('Cổng 3006 đang được sử dụng. Ở lần chuyển sang Hub đầu tiên, nhấn Ctrl+C trong cửa sổ START-MCP-BROWSER.ps1 cũ, rồi bấm Khởi động MCP tại đây.');
    }
    if (this.proxyChild) await this.stopProxy();
    await this.readSourceConfig();
    await this.ensurePackages();
    await this.ensureDocker();
    await this.ensureCloud();
    await this.configureWorkspace(target);
    try { await this.startProxy(); }
    catch (error) { await this.stopProxy(); throw error; }
  }

  async start() {
    return await this.exclusive(async () => {
      if (this.backend === 'local') return await this.startLocal();
      if (this.proxyChild) await this.stopProxy();
      await this.startCore();
    });
  }
  async selectWorkspace(value) {
    return await this.exclusive(async () => {
      const target = await this.validateWorkspace(value);
      if (this.backend === 'local') return await this.startLocal(target);
      await this.startCore(target);
    });
  }

  /** Local backend: validates the folder, checks the shell and Git, and publishes the catalog of in-process tools. */
  async startLocal(workspace = this.workspace) {
    if (!workspace) throw new Error('Hãy chọn thư mục workspace trước.');
    if (!this.localTools || !this.studioTools) throw new Error('Công cụ cục bộ chưa được khởi tạo.');
    const target = await this.validateWorkspace(workspace);
    this.status('local', 'starting', 'Đang kiểm tra workspace, shell và Git');
    const previous = this.workspace;
    // The tools read manager.workspace, so it is set before they are asked about the environment.
    this.workspace = target;
    try {
      this.environment = await this.localTools.diagnose();
      const catalog = this.internalCatalog();
      await writeJson(this.settingsFile, { version: VERSION, workspace: target, savedAt: new Date().toISOString() });
      this.catalog = catalog;
      this.tools = catalog.tools;
    } catch (error) { this.workspace = previous; throw error; }
    this.generation += 1;
    const { shells = {}, git } = this.environment;
    const shell = Object.keys(shells).filter((name) => shells[name]).join('/') || 'không có shell';
    this.status('local', 'ready', `${this.catalog.counts.local} công cụ cục bộ · ${shell} · ${git ? (git.version || 'Git') : 'chưa cài Git'}`);
    this.log(`Workspace: ${target}. Công cụ cục bộ sẵn sàng (${this.catalog.counts.local} local, ${this.catalog.counts.studio} studio).${git ? '' : ' Cảnh báo: chưa tìm thấy Git, các công cụ git_* sẽ báo lỗi.'}`);
  }

  internalCatalog() {
    const local = this.localTools.definitions();
    const studio = this.studioTools.definitions().filter((tool) => LOCAL_BACKEND_STUDIO_TOOLS.has(tool.originalName));
    return buildInternalCatalog({ local, studio }, { version: VERSION });
  }

  async stopProxy() {
    this.stopping = true;
    try {
      const child = this.proxyChild;
      if (child) { this.expectedStops.add(child); await stopOwned(child); }
      if (this.proxyChild === child) this.proxyChild = null;
      this.tools = [];
      this.catalog.ready = false;
      this.status('proxy', 'stopped', 'MCP đã dừng');
      this.status('desktop', 'stopped', 'MCP đã dừng');
    } finally { this.stopping = false; }
  }
  async stop() {
    return await this.exclusive(async () => {
      if (this.backend === 'local') {
        this.catalog = { ...this.catalog, ready: false };
        this.tools = [];
        this.status('local', 'stopped', 'Đã tắt công cụ cục bộ');
        this.log('Đã tắt công cụ cục bộ; bấm Khởi động để bật lại.');
        return;
      }
      await this.stopProxy();
      this.log('Đã dừng MCP do Hub quản lý.');
    });
  }
  async shutdown() {
    this.stopping = true;
    await Promise.allSettled([...this.agentSessions].map((s) => s.close()));
    if (this.backend === 'mcp') await this.stopProxy();
    for (const child of this.children) await stopOwned(child).catch(() => {});
  }

  async browse() {
    if (this.busy || this.taskId || this.pickerOpen) { const e = new Error('Chờ nhiệm vụ hoặc hộp chọn thư mục hiện tại hoàn tất.'); e.statusCode = 409; throw e; }
    this.pickerOpen = true;
    try {
    const powershell = await this.powerShell();
    const args = ['-NoLogo', '-NoProfile', '-STA', '-File', path.join(this.bundleRoot, 'windows', 'Select-Workspace.ps1')];
    if (this.workspace) args.push('-InitialPath', this.workspace);
    const output = await this.checkedRun(powershell, args, { quiet: true });
    try {
      const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
      return { path: typeof result.path === 'string' ? result.path : null };
    } catch { throw new Error('Hộp chọn thư mục chưa trả đường dẫn hợp lệ. Bạn có thể dán đường dẫn vào ô workspace.'); }
    } finally { this.pickerOpen = false; }
  }

  async openVsCode() {
    if (!this.workspace) throw new Error('Chọn workspace trước khi mở VS Code.');
    const codeCmd = await resolveProgram('code.cmd');
    const candidates = [
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
      ...(codeCmd ? [path.join(path.dirname(codeCmd), '..', 'Code.exe')] : []),
    ];
    const code = await resolveProgram('Code.exe', candidates);
    if (!code) throw new Error('Không tìm thấy Code.exe. Mở VS Code rồi chọn File > Open Folder với workspace này.');
    await this.openProgram(code, [this.workspace]);
    return { ok: true };
  }

  instructions() {
    if (this.backend === 'local') throw Object.assign(new Error('Hướng dẫn cho MCP SuperAssistant chỉ dùng với backend MCP. Ở chế độ cục bộ, công cụ chạy ngay trong Hub nên không cần dán hướng dẫn.'), { statusCode: 409 });
    return makeInstructions(this.workspace, this.tools, VERSION);
  }

  registerSecret(value) {
    if (typeof value === 'string' && value.length >= 4 && !this.secrets.includes(value)) this.secrets.push(value);
  }

  acquireTask(id) {
    if (this.busy || this.taskId) { const e = new Error('Một nhiệm vụ hoặc thao tác dịch vụ đang chạy.'); e.statusCode = 409; throw e; }
    if (this.backend === 'local') {
      if (!this.workspace) throw Object.assign(new Error('Hãy chọn thư mục dự án trước khi giao việc.'), { statusCode: 409, code: 'workspace_missing' });
      if (!this.catalog.ready || this.services.local?.state !== 'ready') throw Object.assign(new Error('Công cụ cục bộ chưa sẵn sàng. Bấm Khởi động rồi thử lại.'), { statusCode: 409, code: 'local_not_ready' });
    } else if (!this.catalog.ready || this.services.proxy.state !== 'ready' || this.services.desktop.state !== 'ready') throw new Error('MCP chưa qua kiểm tra đầy đủ. Hãy khởi động dịch vụ trước.');
    this.taskId = id;
  }
  releaseTask(id) { if (this.taskId === id) this.taskId = null; }

  async openDirectConnections({ signal } = {}) {
    if (!this.sdk) throw new Error('MCP SDK chưa sẵn sàng.');
    signal?.throwIfAborted();
    const config = await readJson(this.proxyConfig);
    const connections = new Map();
    try {
      for (const server of ['cloud-harness', 'desktop-commander']) {
        signal?.throwIfAborted();
        const source = config?.mcpServers?.[server];
        if (!source) throw new Error(`Cấu hình thiếu ${server}.`);
        const client = new this.sdk.Client({ name: 'chatmcp-local-agent', version: VERSION }, { capabilities: {} });
        let transport;
        if (server === 'cloud-harness') {
          transport = new this.sdk.StreamableHTTPClientTransport(new URL(source.url), { requestInit: { headers: source.headers ?? {} } });
        } else {
          const env = { ...process.env, ...(source.env ?? {}) };
          delete env.OPENAI_API_KEY;
          transport = new this.sdk.StdioClientTransport({ command: source.command, args: source.args ?? [], env, cwd: this.workspace, stderr: 'pipe' });
          // Desktop Commander logs get_config contents to stderr. Drain it,
          // without sending credentials or config contents to the dashboard.
          transport.stderr?.on('data', () => {});
        }
        const connection = { client, transport };
        connections.set(server, connection);
        let timer;
        let abort;
        try {
          await Promise.race([
            client.connect(transport, { signal, timeout: 30000 }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${server} không kết nối trong 30 giây.`)), 30000); }),
            ...(signal ? [new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); })] : []),
          ]);
          signal?.throwIfAborted();
        } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
      }
      return connections;
    } catch (error) {
      await Promise.allSettled([...connections.values()].map(closeConnection));
      throw error;
    }
  }

  #binding() {
    const binding = { taskId: this.taskId, workspace: this.workspace, generation: this.generation, instanceId: this.instanceId };
    const check = () => {
      if (binding.taskId !== this.taskId || binding.workspace !== this.workspace || binding.generation !== this.generation || binding.instanceId !== this.instanceId) throw new Error('Workspace đã thay đổi; không thực thi lời gọi trong phiên cũ.');
    };
    return { binding, check };
  }

  async createAgentSession({ signal } = {}) {
    if (!this.taskId) throw new Error('Cần khóa workspace trước khi mở phiên nhiệm vụ.');
    signal?.throwIfAborted();
    if (this.backend === 'local') return this.#createLocalSession();
    const { binding, check: checkBinding } = this.#binding();
    const connections = await this.openDirectConnections({ signal });
    try {
      const catalog = await collectCatalog(connections, this.sdk.schemas, { signal });
      if (!catalog.counts['cloud-harness'] || !catalog.counts['desktop-commander']) throw new Error('Danh mục MCP chưa đầy đủ.');
      await this.withMcp(PROXY_URL, null, async (client) => {
        const tools = await listAll(client, 'tools', this.sdk.schemas, { signal });
        catalog.proxyVerification = verifyProxyCatalog(catalog.tools, tools);
      }, { signal });
      signal?.throwIfAborted();
      checkBinding();
      this.catalog = catalog;
      this.tools = catalog.tools;
      const session = makeAgentSession(connections, catalog, this.sdk.schemas, { bindingCheck: checkBinding });
      // Local coding features are additive; the complete verified upstream MCP
      // inventory remains available and is never truncated or substituted.
      if (this.studioTools) {
        const extras = this.studioTools.definitions();
        catalog.tools.push(...extras);
        catalog.counts.studio = extras.length;
        catalog.servers.studio = { capabilities: { tools: {} }, tools: extras.length, serverInfo: { name: 'chatmcp-studio', version: VERSION } };
      }
      this.#guardCalls(session, { catalog, binding, checkBinding, external: session.callTool.bind(session) });
      return this.#trackSession(session);
    } catch (error) {
      await Promise.allSettled([...connections.values()].map(closeConnection));
      throw error;
    }
  }

  /** Local backend: no connections to open; the tools live in this process. */
  #createLocalSession() {
    const { binding, check: checkBinding } = this.#binding();
    if (!this.localTools || !this.studioTools) throw new Error('Công cụ cục bộ chưa được khởi tạo.');
    checkBinding();
    const catalog = this.internalCatalog();
    this.catalog = catalog;
    this.tools = catalog.tools;
    let closed = false;
    const unsupported = (what) => async () => { throw new Error(`Backend cục bộ không có ${what}.`); };
    const session = {
      catalog,
      getPrompt: unsupported('MCP prompts'),
      readResource: unsupported('MCP resources'),
      async close() { closed = true; },
    };
    const external = async (name) => { throw new Error(`Không có công cụ ${name} trong danh mục cục bộ.`); };
    this.#guardCalls(session, { catalog, binding, checkBinding: () => { if (closed) throw new Error('Phiên công cụ đã đóng.'); checkBinding(); }, external });
    return this.#trackSession(session);
  }

  #trackSession(session) {
    this.agentSessions.add(session);
    const close = session.close;
    session.close = async () => { try { await close.call(session); } finally { this.agentSessions.delete(session); } };
    return session;
  }

  /**
   * Every call an agent makes passes through here, whatever the backend: workspace binding, permission
   * decision, workflow timeline, a checkpoint before changes, then the tool itself. A refusal and a failed
   * checkpoint are returned as results that say nothing was executed, so a model can react to them.
   */
  #guardCalls(session, { catalog, binding, checkBinding, external }) {
    const refused = (code, message) => ({ isError: true, content: [{ type: 'text', text: message }], structuredContent: { error: { code, message }, executed: false } });
    session.callTool = async (name, args, callerOptions = {}) => {
      // `onDecision` is for this guard only; the tool itself receives the transport options (signal, timeout).
      const { onDecision, ...options } = callerOptions;
      checkBinding();
      const definition = catalog.tools.find((tool) => tool.name === name);
      if (!definition) throw new Error('Unknown tool ' + name);
      if (name.startsWith('local.') && this.localTools?.has(name)) {
        // A call that cannot run is reported straight away: the user is never asked to approve it.
        const checked = this.localTools.validate(name, args);
        if (!checked.ok) return { ...refused(checked.code, `Tham số không hợp lệ cho ${name}: ${checked.errors.join('; ')}.`), structuredContent: { error: { code: checked.code, message: checked.errors.join('; ') }, executed: false, details: checked.errors } };
      }
      const decision = this.permissions ? await this.permissions.authorize({ name, args, definition, taskId: binding.taskId, signal: options.signal }) : { allowed: true, category: 'read' };
      // The caller learns what was decided BEFORE anything runs. It is awaited: whoever records "this call is now going
      // ahead" must have finished writing that down before the call can have any effect. If it throws, nothing runs.
      if (typeof onDecision === 'function') await onDecision({ name, allowed: decision.allowed === true, category: decision.category ?? null, kind: decision.risk?.kind ?? null });
      await this.workflow?.mark(binding.taskId, 'tool_start', { toolName: name, category: decision.category });
      if (!decision.allowed) return refused('permission_denied', 'Permission denied: ' + decision.reason);
      try { await this.#checkpointBefore(name, args, decision, binding); }
      catch (error) {
        if (options.signal?.aborted) throw error;
        return refused('checkpoint_failed', 'Could not create pre-operation checkpoint: ' + error.message + ' The operation was NOT executed.');
      }
      const result = name.startsWith('local.') && this.localTools ? await this.localTools.call(name, args, { taskId: binding.taskId, signal: options.signal })
        : name.startsWith('studio.') ? await this.studioTools.call(name, args, { taskId: binding.taskId, signal: options.signal })
          : await external(name, args, options);
      const structured = result?.structuredContent;
      const verified = (name === 'studio.diff_check' && structured?.ok === true)
        || (name === 'local.run_command' && result?.isError !== true && structured?.kind === 'verify' && structured?.exitCode === 0);
      await this.workflow?.mark(binding.taskId, 'tool_result', {
        toolName: name, category: decision.category, isError: result?.isError === true, verified,
        fileEdit: decision.category === 'workspace_edit' && !NOT_FILE_EDITS.has(name),
        commandKind: name === 'local.run_command' ? String(decision.risk?.kind ?? '') : '',
      });
      return result;
    };
  }

  /**
   * A snapshot is captured BEFORE a call that can change files, so the change can be reviewed and undone.
   * File tools name the files they will touch and only those are saved (a complete copy of exactly what
   * is at risk); a shell command can touch anything, so it gets the bounded workspace snapshot, reused
   * while nothing changed. A snapshot that is not complete is tagged as such and never presented as a backup.
   */
  async #checkpointBefore(name, args, decision, binding) {
    if (!this.studio || !CHECKPOINT_CATEGORIES.has(decision.category)) return;
    const label = `Before ${name} · ${binding.taskId}`;
    let request = { label, maxFiles: 140, maxTotalBytes: 8 * 1024 * 1024, reuseIfUnchanged: true };
    if (name.startsWith('local.') && name !== 'local.run_command' && this.localTools) {
      const files = await this.localTools.touchedPaths(name, args);
      if (!files.length) return; // nothing that exists today is about to change
      request = { label, files, maxFiles: 140, maxTotalBytes: 32 * 1024 * 1024 };
    }
    try {
      const snap = await this.studio.checkpoint(request);
      const incomplete = snap.partial || (snap.skipped?.length ?? 0) > 0;
      this.permissions?.onEvent({ type: 'checkpoint', taskId: binding.taskId, name, id: snap.id, partial: incomplete, reused: snap.reused === true });
      await this.workflow?.mark(binding.taskId, 'checkpoint', { toolName: name, checkpoint: snap.id });
    } catch (error) {
      if (this.permissions?.executionPolicy === 'full-access') {
        // Explicit opt-in has no checkpoint prerequisite: the operation
        // may touch files entirely outside the selected Git workspace.
        this.log(`Full Access: không tạo được checkpoint workspace trước ${name}: ${error.message}`);
        return;
      }
      throw Object.assign(new Error(error.message), { code: 'checkpoint_failed' });
    }
  }
}
