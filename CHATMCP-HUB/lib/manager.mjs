import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, redact, resolveProgram, spawnLogged, stopOwned } from './runtime.mjs';
import { buildInternalCatalog } from './catalog.mjs';
import { hookTextParts } from './hooks.mjs';

export const VERSION = '3.10.0';
const baseService = () => ({ state:'unknown', detail:'Chưa kiểm tra' });
export const BACKENDS = Object.freeze(['local']);
// The local backend has its own file, search, Git and shell tools. Of the older Studio tools only those that add
// something are offered next to them (code intelligence, test discovery, checkpoints); the rest would duplicate local.*.
const LOCAL_BACKEND_STUDIO_TOOLS = new Set(['symbols', 'references', 'definitions', 'index_status', 'checks', 'skills', 'diff_check', 'checkpoints', 'checkpoint', 'review']);
const CHECKPOINT_CATEGORIES = new Set(['workspace_edit', 'dangerous', 'execute', 'unknown']);
/** What a failed tool result says, for the PostToolUseFailure hooks. */
const failureText = (result) => {
  const parts = (Array.isArray(result?.content) ? result.content : []).filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text);
  return (parts.join('\n') || result?.structuredContent?.error?.message || 'The tool reported an error.').slice(0, 4000);
};
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
    // Lifecycle hooks (lib/hooks.mjs). assembleStudio creates the runner for the manager that owns the Hub's data folder. A manager
    // that works for it (a spawned agent, a second workspace, a coding worker) has a data folder of its own, so it is handed that SAME
    // instance before it is assembled: reading hooks.json from its own folder would silently run it without the owner's hooks.
    this.hooks = null;
    this.hooksOwned = false;
    // Where a project's .chatmcp/hooks.json is looked for when the tools run in another folder than the project (a managed worktree).
    this.hooksProjectRoot = null;
    // Set on the manager of an agent that a model (spawn_agent, a workflow) or the coding orchestrator started: its run ends with SubagentStop
    // instead of Stop (lib/lifecycle-hooks.mjs). { kind: 'subagent', role, parentTaskId, conversationId, workflowId, phaseId }; null for the
    // conversations a person started, which end with Stop.
    this.lifecycleAgent = null;
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
      if (result.code !== 0) {
        const failure = new Error(`${path.basename(command)} dừng với mã ${result.code ?? result.signal}. Xem nhật ký để biết bước chưa hoàn tất.`);
        // The caller can show an appropriate diagnostic; do not dump arbitrary
        // stdout/stderr (which may contain host paths) into the public UI.
        failure.result = result;
        throw failure;
      }
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
    // Only the manager that created the runner stops the hooks that are still running; a borrowed instance serves other managers too.
    if(this.hooksOwned)await this.hooks?.close?.().catch(()=>{});
  }

  async browse({initialPath=null}={}) {
    // Native picker only selects a folder; it never changes the currently
    // running workspace or acquires the task lock. Other agents keep working.
    if (this.pickerOpen) { const e = new Error('Một hộp chọn thư mục đã mở.'); e.statusCode = 409; throw e; }
    this.pickerOpen = true;
    try {
    const powershell = await this.powerShell();
    const args = ['-NoLogo', '-NoProfile', '-STA', '-File', path.join(this.bundleRoot, 'windows', 'Select-Workspace.ps1')];
    const initial=initialPath&&typeof initialPath==='string'
      ? await this.validateWorkspace(initialPath).catch(()=>null)
      : null;
    if(initial||this.workspace) args.push('-InitialPath',initial||this.workspace);
    // A hidden PowerShell process can hide the owned Windows Forms dialog too.
    // Run the native picker interactively while keeping all transport output
    // private. If the dialog fails, reveal only the exception TYPE, not paths.
    let output;
    try {
      output = await this.checkedRun(powershell, args, { quiet:true, windowsHide:false });
    } catch(error) {
      const reason = /\[CHATMCP-HUB\] Folder picker failed: ([A-Za-z][A-Za-z0-9]{0,75})/.exec(
        String(error?.result?.output||''))?.[1]||'unknown';
      this.log('Native Windows folder picker failed ('+reason+').');
      throw Object.assign(new Error(
        'Không mở được hộp chọn thư mục Windows ('+reason+'). '+
        'Bạn vẫn có thể dán đường dẫn thư mục trong Cài đặt > Workspace.'),
        {statusCode:503,code:'native_folder_picker_failed'});
    }
    try {
      // On PowerShell some incidental output may precede our JSON response.
      // The LAST JSON line belongs to the picker; never interpret arbitrary
      // warnings or PowerShell error text as a selected path.
      const candidate=output.replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim())
        .filter(Boolean).at(-1);
      const result=JSON.parse(candidate);
      if(!Object.hasOwn(result,'path') || (result.path !== null && typeof result.path!=='string'))
        throw new Error('invalid_picker_result');
      return {path:result.path};
    }catch{
      throw Object.assign(new Error('Hộp chọn thư mục chưa trả đường dẫn hợp lệ. '+
        'Bạn vẫn có thể dán đường dẫn trực tiếp trong Cài đặt > Workspace.'),
        {code:'native_folder_picker_invalid',statusCode:503});
    }
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
   * decision, the owner's PreToolUse hooks, workflow timeline, a checkpoint before changes, then the tool itself,
   * then the PostToolUse hooks. A refusal and a failed checkpoint are returned as results that say nothing was
   * executed, so a model can react to them.
   *
   * The ChatGPT Web Companion, a spawned agent and a coding worker reach their tools through the session built
   * here, so the hooks cover them without knowing about them.
   */
  #guardCalls(session, { catalog, binding, checkBinding, external }) {
    const refused = (code, message) => ({ isError: true, content: [{ type: 'text', text: message }], structuredContent: { error: { code, message }, executed: false } });
    session.callTool = async (name, args, callerOptions = {}) => {
      // `onDecision` and `toolUseId` are for this guard only; the tool itself receives the transport options (signal, timeout).
      const { onDecision, toolUseId: suppliedId, ...options } = callerOptions;
      checkBinding();
      const definition = catalog.tools.find((tool) => tool.name === name);
      if (!definition) throw new Error('Unknown tool ' + name);
      if (name.startsWith('local.') && this.localTools?.has(name)) {
        // A call that cannot run is reported straight away: the user is never asked to approve it.
        const checked = this.localTools.validate(name, args);
        if (!checked.ok) return { ...refused(checked.code, `Tham số không hợp lệ cho ${name}: ${checked.errors.join('; ')}.`), structuredContent: { error: { code: checked.code, message: checked.errors.join('; ') }, executed: false, details: checked.errors } };
      }
      // One id for the Pre and the Post hook of this call (the agent loop does not hand its own id down).
      const toolUseId = typeof suppliedId === 'string' && suppliedId ? suppliedId : `chatmcp_${randomUUID()}`;
      const gateDecision = this.permissions ? await this.permissions.authorize({ name, args, definition, taskId: binding.taskId, signal: options.signal }) : { allowed: true, category: 'read' };
      // The owner's PreToolUse hooks run AFTER the gate and BEFORE the caller is told, the timeline is written or a checkpoint is made.
      const { decision, refusal } = await this.#preToolHooks({ name, args, definition, binding, toolUseId, options, decision: gateDecision });
      // The caller learns what was decided BEFORE anything runs. It is awaited: whoever records "this call is now going
      // ahead" must have finished writing that down before the call can have any effect. If it throws, nothing runs.
      if (typeof onDecision === 'function') await onDecision({ name, allowed: decision.allowed === true && refusal === null, category: decision.category ?? null, kind: decision.risk?.kind ?? null });
      await this.workflow?.mark(binding.taskId, 'tool_start', { toolName: name, category: decision.category });
      if (refusal !== null) {
        await this.workflow?.mark(binding.taskId, 'hook_denied', { toolName: name, category: decision.category, isError: true });
        return refused('hook_denied', `Blocked by a PreToolUse hook (${refusal}). The operation was NOT executed.`);
      }
      if (!decision.allowed) return refused('permission_denied', 'Permission denied: ' + decision.reason);
      try { await this.#checkpointBefore(name, args, decision, binding); }
      catch (error) {
        if (options.signal?.aborted) throw error;
        return refused('checkpoint_failed', 'Could not create pre-operation checkpoint: ' + error.message + ' The operation was NOT executed.');
      }
      let result;
      try {
        result = name.startsWith('local.') && this.localTools ? await this.localTools.call(name, args, { taskId: binding.taskId, signal: options.signal })
          : name.startsWith('studio.') ? await this.studioTools.call(name, args, { taskId: binding.taskId, signal: options.signal })
            : await external(name, args, options);
      } catch (error) {
        // A stopped call is not a failure of the tool; any other exception is, and the hooks are told before it travels on.
        if (!options.signal?.aborted) await this.#postToolHooks('PostToolUseFailure', { name, args, binding, toolUseId, error: error?.message ?? String(error), signal: options.signal });
        throw error;
      }
      const structured = result?.structuredContent;
      const verified = (name === 'studio.diff_check' && structured?.ok === true)
        || (name === 'local.run_command' && result?.isError !== true && structured?.kind === 'verify' && structured?.exitCode === 0);
      await this.workflow?.mark(binding.taskId, 'tool_result', {
        toolName: name, category: decision.category, isError: result?.isError === true, verified,
        fileEdit: decision.category === 'workspace_edit' && !NOT_FILE_EDITS.has(name),
        commandKind: name === 'local.run_command' ? String(decision.risk?.kind ?? '') : '',
      });
      const failed = result?.isError === true;
      const parts = await this.#postToolHooks(failed ? 'PostToolUseFailure' : 'PostToolUse', { name, args, binding, toolUseId, toolResponse: result, error: failed ? failureText(result) : undefined, signal: options.signal });
      // Only text is added to the content; isError, structuredContent and the tool's own parts stay as the tool returned them.
      return parts.length ? { ...result, content: [...(Array.isArray(result?.content) ? result.content : []), ...parts] } : result;
    };
  }

  #hookInput(binding, extra) {
    return {
      taskId: binding.taskId, projectRoot: this.hooksProjectRoot ?? binding.workspace, cwd: binding.workspace,
      permissionMode: this.permissions?.mode ?? null, executionPolicy: this.permissions?.executionPolicy ?? null, ...extra,
    };
  }

  /**
   * PreToolUse hooks (lib/hooks.mjs). They run for every call that passed argument validation, whatever the gate decided, and they can
   * only add: a veto (`refusal` is the reason) or a question for the owner. A hook can never turn a refusal of the gate into an
   * approval and its "allow" skips nothing: the gate has already decided when the hook is asked. A question is asked through
   * PermissionGate.authorize({ forceAsk }) and only when the gate did not ask the owner itself, so a call costs the owner at most one
   * question. Where nobody can answer, the gate refuses at once.
   */
  async #preToolHooks({ name, args, definition, binding, toolUseId, options, decision }) {
    if (!this.hooks) return { decision, refusal: null };
    let outcome;
    try {
      outcome = await this.hooks.run(this.#hookInput(binding, { event: 'PreToolUse', toolName: name, toolInput: args, toolUseId, signal: options.signal }));
    } catch (error) {
      if (options.signal?.aborted || error?.code === 'hooks_closed') throw error;
      // The owner configured hooks and they cannot be run: the call is refused rather than run without them.
      this.log(`Hooks: PreToolUse could not run (${error?.code ?? error?.message}); the call to ${name} was refused.`);
      outcome = { permission: 'deny', reason: 'the hooks could not be run' };
    }
    if (!decision.allowed) return { decision, refusal: null };
    if (outcome.permission === 'deny') return { decision, refusal: outcome.reason ?? 'blocked by a hook' };
    if (outcome.permission !== 'ask' || decision.asked === true) return { decision, refusal: null };
    if (!this.permissions) return { decision, refusal: `a hook asked for confirmation and nobody can be asked${outcome.reason ? `: ${outcome.reason}` : ''}` };
    await this.workflow?.mark(binding.taskId, 'hook_asked', { toolName: name, category: decision.category });
    const asked = await this.permissions.authorize({ name, args, definition, taskId: binding.taskId, signal: options.signal, forceAsk: true, askReason: outcome.reason ?? '' });
    return { decision: asked.allowed ? { ...decision, asked: true } : asked, refusal: null };
  }

  /**
   * PostToolUse / PostToolUseFailure hooks. The tool has run, so nothing a hook does can change what happened: the result of the tool
   * is returned whatever happens here. What comes back are labelled text parts (additionalContext, feedback) for the model.
   */
  async #postToolHooks(event, { name, args, binding, toolUseId, toolResponse, error, signal }) {
    if (!this.hooks) return [];
    try {
      return hookTextParts(await this.hooks.run(this.#hookInput(binding, { event, toolName: name, toolInput: args, toolUseId, toolResponse, error, signal })));
    } catch (caught) {
      if (!signal?.aborted) this.log(`Hooks: ${event} for ${name} could not run (${caught?.code ?? caught?.message}).`);
      return [];
    }
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
