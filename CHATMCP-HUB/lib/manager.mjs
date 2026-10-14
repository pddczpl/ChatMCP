import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, redact, resolveProgram, spawnLogged, stopOwned } from './runtime.mjs';
import { buildInternalCatalog } from './catalog.mjs';

export const VERSION = '3.0.3';
const baseService = () => ({ state:'unknown', detail:'Chưa kiểm tra' });
export const BACKENDS = Object.freeze(['local']);
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
  /** Local-only manager. Cloud Harness/hosted runtime no longer exists. */
  constructor({ bundleRoot, dataDirectory = null, backend = 'local', repoRoot = null, log = console.log } = {}) {
    if (!bundleRoot) throw new TypeError('HubManager requires bundleRoot.');
    if (backend !== 'local' || repoRoot)
      throw Object.assign(new Error('Chỉ hỗ trợ backend local; Cloud Harness/MCP backend đã được loại bỏ.'), { code:'legacy_backend_removed', statusCode:400 });
    this.bundleRoot = path.resolve(bundleRoot);
    this.backend = 'local';
    this.hubDirectory = path.resolve(dataDirectory || defaultDataDirectory());
    this.settingsFile = path.join(this.hubDirectory,'hub-state.json');
    this.output = log;
    this.secrets = [];
    this.logs = [];
    this.workspace = null;
    this.busy = false;
    this.lastError = null;
    this.services = { local:baseService() };
    this.children = new Set();
    this.tools = [];
    this.stopping = false;
    this.generation = 0;
    this.instanceId = randomUUID();
    this.pickerOpen = false;
    this.taskId = null;
    this.catalog = {ready:false,tools:[],prompts:[],resources:[],resourceTemplates:[],counts:{},servers:{}};
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
      services: structuredClone(this.services), proxyUrl: null,
      dataDirectory: this.hubDirectory, environment: this.environment,
      lastError: this.lastError, logs: [...this.logs], toolCount: this.tools.length,
      generation: this.generation, instanceId: this.instanceId,
      toolCounts: { ...this.catalog.counts }, catalogReady: this.catalog.ready, taskId: this.taskId,
    };
  }

  async load(project) {
    await fs.mkdir(this.hubDirectory, { recursive: true });
    const saved = await readJson(this.settingsFile);
    const candidate = project || saved?.workspace;
    if (candidate) {
      try { this.workspace = await this.validateWorkspace(candidate); }
      catch { this.log('Thư mục đã lưu không còn truy cập được. Hãy chọn lại trên trang localhost.'); }
    }
    this.status('local','stopped',this.workspace ? 'Chưa khởi động' : 'Chọn một thư mục dự án để bắt đầu');
  }

  async validateWorkspace(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0'))
      throw new Error('Hãy chọn một đường dẫn thư mục hợp lệ.');
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

  async start() {return await this.exclusive(async()=>{await this.startLocal();});}
  async selectWorkspace(value) {return await this.exclusive(async()=>{
    const target=await this.validateWorkspace(value);
    await this.localTools?.close?.();
    await this.startLocal(target);
  });}

  /** Forget a selected workspace without deleting any files. */
  async clearWorkspace() {
    if (this.busy || this.taskId) { const error = new Error('Hub đang xử lý một thao tác hoặc nhiệm vụ; chưa bỏ chọn workspace được.'); error.statusCode = 409; throw error; }
    this.workspace = null;
    this.generation += 1;
    this.tools = [];
    this.catalog = { ...this.catalog, ready: false };
    this.status('local', 'stopped', 'Chọn hoặc tạo một workspace để bắt đầu');
    await writeJson(this.settingsFile, { version: VERSION, workspace: null, savedAt: new Date().toISOString() });
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

  async stop() {return await this.exclusive(async()=>{
    this.catalog={...this.catalog,ready:false};this.tools=[];
    this.status('local','stopped','Đã tắt công cụ cục bộ');
    this.log('Đã tắt công cụ cục bộ; bấm Khởi động để bật lại.');
  });}
  async shutdown() {
    this.stopping=true;
    await Promise.allSettled([...this.agentSessions].map(s=>s.close()));
    for(const child of this.children)await stopOwned(child).catch(()=>{});
    await this.localTools?.close?.();
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

  instructions() {
    throw Object.assign(new Error('Legacy MCP/Cloud Harness integration removed. Use the local agent.'), {code:'legacy_backend_removed',statusCode:410});
  }

  registerSecret(value) {
    if (typeof value === 'string' && value.length >= 4 && !this.secrets.includes(value)) this.secrets.push(value);
  }

  acquireTask(id) {
    if (this.busy || this.taskId) { const e = new Error('Một nhiệm vụ hoặc thao tác dịch vụ đang chạy.'); e.statusCode = 409; throw e; }
    if (!this.workspace) throw Object.assign(new Error('Hãy chọn thư mục dự án trước khi giao việc.'),{statusCode:409,code:'workspace_missing'});
    if (!this.catalog.ready || this.services.local?.state!=='ready')
      throw Object.assign(new Error('Công cụ cục bộ chưa sẵn sàng.'),{statusCode:409,code:'local_not_ready'});
    this.taskId = id;
  }
  releaseTask(id) { if (this.taskId === id) this.taskId = null; }

  #binding() {
    const binding = { taskId: this.taskId, workspace: this.workspace, generation: this.generation, instanceId: this.instanceId };
    const check = () => {
      if (binding.taskId !== this.taskId || binding.workspace !== this.workspace || binding.generation !== this.generation || binding.instanceId !== this.instanceId) throw new Error('Workspace đã thay đổi; không thực thi lời gọi trong phiên cũ.');
    };
    return { binding, check };
  }

  async createAgentSession({ signal } = {}) {
    if(!this.taskId)throw new Error('Cần khóa workspace trước khi mở phiên nhiệm vụ.');
    signal?.throwIfAborted();
    return this.#createLocalSession();
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
    const BROAD_CHECKPOINT_TOOLS = new Set([
      'local.run_command',
      'local.tasks_run',
      'local.git_checkout',
      'local.git_merge',
      'local.git_commit',
      'local.worktrees_create',
      'local.worktrees_remove',
    ]);
    if (name.startsWith('local.') && !BROAD_CHECKPOINT_TOOLS.has(name) && this.localTools) {
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
