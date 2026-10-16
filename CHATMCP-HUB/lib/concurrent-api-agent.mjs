// Multi-conversation API coordinator. Each additional conversation runs with its
// own HubManager and worktree; no two coding sessions share a writable checkout.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { HubManager } from './manager.mjs';
import { AgentRunner } from './agent.mjs';
import { assembleStudio } from './assemble.mjs';
import { readJson, writeJson } from './runtime.mjs';

const END = new Set(['completed', 'failed', 'cancelled', 'paused', 'uncertain', 'limit', 'interrupted']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const now = () => new Date().toISOString();

export class ConcurrentApiAgent {
  constructor({ primary, manager, provider, bundleRoot, directory, maxConcurrent = 4, log = () => {} }) {
    if (!primary || !manager || !provider || !bundleRoot || !directory)
      throw new TypeError('ConcurrentApiAgent requires the primary agent and local Hub resources.');
    this.primary = primary;
    this.manager = manager;
    this.provider = provider;
    this.bundleRoot = bundleRoot;
    this.directory = path.resolve(directory);
    this.maxConcurrent = maxConcurrent;
    this.log = log;
    this.records = new Map();
    this.children = new Map();
    this.accessManagers = new Map();
    this.readyAccessManagers = new Map();
    this.preflights = new Map();
    this.listeners = new Set();
    this.writes = Promise.resolve();
    this.draining = false;
    this.closed = false;
    this.primary.subscribe((event) => this.#event(event));
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  #event(event) {
    for (const callback of this.listeners) {
      try { callback(event); } catch { /* UI subscribers are not trusted code. */ }
    }
    if (event.type === 'state' || (event.type === 'event' && END.has(event.event?.type))) {
      setTimeout(() => { void this.#drain().catch(error => this.log(error.message)); }, 0);
    }
  }
  #save() {
    const snapshot = { version: 1, records: [...this.records.values()].map(({ attachments, ...r }) => r) };
    const next = this.writes.catch(() => {}).then(() => writeJson(path.join(this.directory, 'sessions.json'), snapshot));
    this.writes = next;
    next.catch(() => {});
    return next;
  }
  #queued(r) {
    const state = r.status === 'preparing' ? 'queued' : r.status === 'blocked' ? 'paused' : r.status;
    return {
      id: r.id, conversationId:r.conversationId||r.parentTaskId||r.id, workspacePath:r.sourceRoot, prompt: r.prompt, status: r.status === 'preparing' ? 'running' : r.status,
      state, createdAt: r.createdAt, updatedAt: r.updatedAt, workspace: { path: r.worktree || r.executionRoot || r.sourceRoot },
      branch: r.branch, dependsOn: r.dependsOn || [], parentTaskId: r.parentTaskId || null,
      parentRunId: r.parentRunId || null,
      events: [], toolCalls: 0, steps: 0, prompts: [{ at: r.createdAt, text: r.prompt }],
      dialogue: [{ role: 'user', at: r.createdAt, text: r.prompt }],
      error: r.error || null, runCount: 0, transport: 'api',
    };
  }
  #detail(record) {
    const real = this.children.get(record.id)?.runner.get(record.id);
    return real ? { ...real, branch: record.branch, worktree: record.worktree,
      workspacePath:record.sourceRoot, conversationId:record.conversationId||record.parentTaskId||record.id,
      dependsOn: record.dependsOn || [], parentTaskId: record.parentTaskId || null,
      parentRunId:record.parentRunId||null } : this.#queued(record);
  }
  #activeIds() {
    const ids = [];
    if (this.primary.activeTaskId) ids.push(this.primary.activeTaskId);
    for (const [id, child] of this.children) if (child.runner.activeTaskId) ids.push(id);
    for (const record of this.records.values()) if (record.status === 'preparing' && !ids.includes(record.id)) ids.push(record.id);
    return ids;
  }
  state() {
    const primary = this.primary.state();
    primary.tasks=primary.tasks.map(t=>({...t,conversationId:t.id,workspacePath:t.workspace?.path||this.manager.workspace}));
    const childTasks = [...this.records.values()].map(r => this.#detail(r));
    const tasks = [...primary.tasks, ...childTasks].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    const activeTaskIds = this.#activeIds();
    return { activeTaskId: activeTaskIds[0] || null, activeTaskIds,
      active: activeTaskIds.length ? this.get(activeTaskIds[0]) : null, tasks };
  }
  backgroundTasks() {
    // Deliberately NOT a list of chats. A conversation owns many task runs;
    // model-created child agents are subordinate to the run that delegated them.
    const all = this.state().tasks, map = new Map();
    for (const task of all) map.set(task.id, this.get(task.id));
    const activities = [];
    for (const summary of all) {
      if (summary.parentTaskId) continue; // visible inside its parent execution
      const detail = map.get(summary.id) || summary;
      const runs = Array.isArray(detail.runs) && detail.runs.length
        ? detail.runs : [{ status: detail.status, startedAt: detail.startedAt || detail.createdAt,
          finishedAt: detail.finishedAt, finalText: detail.finalText }];
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i], latest = i === runs.length - 1;
        const children = all.filter(child => child.parentTaskId === summary.id &&
            (child.parentRunId ? child.parentRunId === run.id : latest)).map(child => ({
              id: child.id, taskId: child.id, parentTaskId: summary.id,
              parentRunId:child.parentRunId||null,
              title: child.prompt, status: child.state || child.status,
              startedAt: child.startedAt || child.createdAt,
              finishedAt: child.finishedAt,
              branch: child.branch || null,
              workspacePath: child.workspacePath || summary.workspacePath,
            }));
        activities.push({
          id: run.id || summary.id + ':run:' + (i + 1),
          taskId: summary.id,
          conversationId: summary.id,
          workspacePath: summary.workspacePath || detail.workspace?.path || this.manager.workspace,
          title: run.title || detail.prompts?.[i]?.text || (i===0 ? summary.prompt : 'Continuation ' + (i + 1)),
          status: latest ? (detail.state || detail.status) : (run.status || 'completed'),
          startedAt: run.startedAt || detail.startedAt || summary.createdAt,
          finishedAt: latest ? detail.finishedAt : run.finishedAt,
          stepCount: latest ? Number(detail.steps || 0) : null,
          // Aggregate model token counts span the entire conversation. Do not
          // misrepresent them as exact per-run billing.
          conversationUsage: latest ? (detail.usage || null) : null,
          subagents: children,
        });
      }
    }
    return activities.sort((a,b) => String(b.startedAt||'').localeCompare(String(a.startedAt||''))).slice(0,80);
  }
  get(id) {
    const first = this.primary.get(id);
    if (first) return {...first,conversationId:id,workspacePath:first.workspace?.path||this.manager.workspace};
    const record = this.records.get(id);
    return record ? this.#detail(record) : null;
  }
  async report(id) {
    if (this.primary.get(id)) return this.primary.report(id);
    const child = this.children.get(id);
    if (child?.runner.get(id)) return child.runner.report(id);
    return this.records.has(id) ? 'Task has not started; waiting for a dependency, permission, or worktree.' : null;
  }
  async load() {
    await this.primary.load();
    const data = await readJson(path.join(this.directory, 'sessions.json')).catch(() => null);
    if (!data || !Array.isArray(data.records)) return this.state();
    for (const raw of data.records.slice(-100)) {
      if (!UUID.test(raw?.id || '') || typeof raw.sourceRoot !== 'string') continue;
      const record = { ...raw };
      // Never replay uncertain writes automatically after a Hub restart.
      if (['queued', 'preparing', 'running'].includes(record.status)) {
        record.status = record.pendingWorktree ? 'uncertain' : 'paused';
        record.error = record.pendingWorktree
          ? 'Hub restarted while preparing a worktree. Inspect '+record.pendingWorktree.path+' and Git refs manually; no operation is replayed.'
          : 'Hub restarted. Review the worktree and resume explicitly; no tool was replayed.' +
            (record.attachmentCount ? ' Reattach original files/images before resuming.' : '');
      }
      this.records.set(record.id, record);
      if (record.worktree || record.executionRoot) {
        try { await this.#initChild(record); }
        catch (error) { record.status = 'paused'; record.error = 'Workspace unavailable: ' + error.message; }
      }
    }
    await this.#save();
    return this.state();
  }
  async #workspaceManager(sourceRoot) {
    if (sourceRoot === this.manager.workspace) return this.manager;
    if (!this.accessManagers.has(sourceRoot)) {
      const initializing = (async () => {
        const stable = createHash('sha256').update(sourceRoot).digest('hex').slice(0, 24);
        const access = new HubManager({ bundleRoot: this.bundleRoot,
          dataDirectory: path.join(this.directory, 'workspace-access', stable), log: this.log });
        await access.load(sourceRoot);
        assembleStudio(access, { bundleRoot: this.bundleRoot });
        await access.permissions.load();
        access.permissions.mode = this.manager.permissions?.mode || 'review';
        access.permissions.executionPolicy = this.manager.permissions?.executionPolicy || 'host-review';
        access.pluginManager = this.manager.pluginManager;
        await access.startLocal(sourceRoot);
        this.readyAccessManagers.set(sourceRoot, access);
        return access;
      })();
      this.accessManagers.set(sourceRoot, initializing);
    }
    try { return await this.accessManagers.get(sourceRoot); }
    catch (error) { this.accessManagers.delete(sourceRoot); throw error; }
  }
  async gitRefs(workspacePath) {
    if (!this.manager.workspaceRegistry) throw fail('workspace_unavailable', 'No workspace registry.', 503);
    const root = (await this.manager.workspaceRegistry.resolve(workspacePath)).path;
    const owner = await this.#workspaceManager(root);
    const git = owner.studio?.gitRunner;
    if (!git) throw fail('git_unavailable', 'Git is not available for this workspace.', 503);
    const [branchesRun, worktreesRun, branchRun] = await Promise.all([
      git.text(['for-each-ref', '--format=%(refname)%09%(refname:short)', 'refs/heads'], { timeoutMs: 15000 }),
      git.text(['worktree', 'list', '--porcelain'], { timeoutMs: 15000 }),
      git.text(['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 15000 }),
    ]);
    if (branchesRun.truncated || worktreesRun.truncated || branchesRun.timedOut || worktreesRun.timedOut)
      throw fail('git_failed', 'Git discovery timed out or returned truncated data.');
    // Non-Git folders are valid local coding workspaces too. Show an empty
    // selector rather than failing the React page with HTTP 409.
    if (branchesRun.code !== 0 || worktreesRun.code !== 0)
      return {branches:[],worktrees:[],currentBranch:null,gitAvailable:false};
    return {
      branches: branchesRun.stdout.split(/\r?\n/).filter(Boolean).slice(0, 120)
        .map(line => { const [ref, name] = line.split('\t'); return { ref, name }; })
        .filter(x => /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(x.ref) && x.name),
      worktrees: worktreesRun.stdout.trim().split(/\r?\n\r?\n/).filter(Boolean).slice(0, 100)
        .map(block => {
          const rows = block.split(/\r?\n/);
          const field = prefix => rows.find(x => x.startsWith(prefix))?.slice(prefix.length) || null;
          const branch = field('branch ');
          return { path: field('worktree '), head: field('HEAD '),
            branch: branch?.startsWith('refs/heads/') ? branch.slice(11) : null };
        }).filter(x => x.path),
      currentBranch: branchRun.code === 0 ? branchRun.stdout.trim() : null,
      gitAvailable:true,
    };
  }
  async #initChild(record) {
    if (this.children.has(record.id)) return this.children.get(record.id);
    const stateDir = path.join(this.directory, record.id, 'state');
    const executionRoot = record.worktree || record.executionRoot || record.sourceRoot;
    const manager = new HubManager({ bundleRoot: this.bundleRoot, dataDirectory: stateDir, log: this.log });
    await manager.load(executionRoot);
    if (manager.workspace !== await fs.realpath(executionRoot))
      throw fail('missing_worktree', 'Managed worktree is missing.');
    manager.pluginManager = this.manager.pluginManager;
    assembleStudio(manager, { bundleRoot: this.bundleRoot });
    await manager.permissions.load();
    manager.permissions.mode = record.permissionMode || 'review';
    manager.permissions.executionPolicy = record.executionPolicy || 'host-review';
    manager.spawnBackgroundAgent = (_callerId, request) => this.spawnAgent(record.id, request);
    await manager.startLocal(executionRoot);
    const runner = new AgentRunner({ manager, provider: this.provider,
      taskDirectory: path.join(stateDir, 'tasks'), log: this.log, toolSelectionMode: 'auto' });
    await runner.load();
    runner.subscribe(event => this.#event(event));
    const child = { runner, manager };
    this.children.set(record.id, child);
    return child;
  }
  async #worktree(record, signal) {
    signal?.throwIfAborted();
    const owner = await this.#workspaceManager(record.sourceRoot);
    const git = owner.studio?.gitRunner;
    if (!git || !owner.workspace) throw fail('workspace_missing', 'A Git repository is required for parallel writes.');
    const check = await git.text(['rev-parse', '--verify', 'HEAD'], { timeoutMs: 15000, signal });
    if (check.code !== 0 || !/^[0-9a-f]{40}$/i.test(check.stdout.trim()))
      throw fail('git_required', 'Independent coding conversations require a Git repository with a committed HEAD.');
    const baseRef = record.baseRef || check.stdout.trim();
    if (record.baseRef) {
      if (!/^refs\/heads\/[A-Za-z0-9._/-]{1,150}$/.test(record.baseRef) || record.baseRef.includes('..') || record.baseRef.includes('//') || record.baseRef.endsWith('/'))
        throw fail('bad_branch', 'Invalid base branch.');
      const valid = await git.text(['show-ref', '--verify', '--quiet', record.baseRef], { timeoutMs: 15000, signal });
      if (valid.code !== 0) throw fail('unknown_branch', 'Selected branch no longer exists.');
    }
    const branch = 'chatmcp/chat/' + record.id.slice(0, 12);
    const worktree = path.join(this.directory, record.id, 'worktree');
    const gate = owner.permissions;
    if (gate && gate.mode !== 'autonomous') {
      const definition = owner.catalog.tools.find(x => x.name === 'local.worktrees_create');
      const decision = await gate.authorize({
        name: 'local.worktrees_create',
        args: { branch, path: worktree }, definition, taskId: record.id, signal,
      });
      if (!decision.allowed) throw fail('permission_denied', 'Worktree creation was not approved.', 403);
    }
    signal?.throwIfAborted();
    // Persist a crash marker before Git can create an independent branch.
    // Cancellation or a crash during Git may leave a partially created worktree;
    // never silently retry or remove it.
    record.pendingWorktree = { path: worktree, branch, startedAt: now() };
    await this.#save();
    signal?.throwIfAborted();
    const result = await git.text(['worktree', 'add', '-b', branch, worktree, baseRef], {
      writes: true, timeoutMs: 60000, signal,
    });
    if (result.code !== 0 || result.truncated || result.timedOut)
      throw fail('worktree_failed', 'Git worktree creation failed: ' + String(result.stderr || result.stdout).slice(0, 500));
    record.branch = branch;
    record.worktree = worktree;
    delete record.pendingWorktree;
    record.updatedAt = now();
    await this.#save();
  }
  #status(id) { return this.get(id)?.status; }
  async #runRecord(record) {
    const controller = new AbortController();
    this.preflights.set(record.id, controller);
    try {
      if (record.status !== 'preparing') return;
      if (!record.worktree && !record.executionRoot) await this.#worktree(record, controller.signal);
      if (record.status !== 'preparing' || controller.signal.aborted) return;
      const child = await this.#initChild(record);
      if (record.status !== 'preparing' || controller.signal.aborted) return;
      const result = await child.runner.start({ prompt: record.prompt, initialId: record.id, attachments: record.attachments || [] });
      record.status = result.status;
      record.updatedAt = now();
      delete record.attachments;
      await this.#save();
      this.#event({ type: 'state', taskId: record.id, state: result.state });
    } catch (error) {
      if (record.status === 'cancelled' || record.status === 'uncertain') return;
      record.status = record.pendingWorktree ? 'uncertain' : 'failed';
      record.error = String(error.message || error).slice(0, 800) +
        (record.pendingWorktree ? ' Inspect the pending worktree and Git branch before continuing.' : '');
      record.updatedAt = now();
      delete record.attachments;
      await this.#save().catch(() => {});
      this.#event({ type: 'state', taskId: record.id, state: record.status });
    } finally {
      if (this.preflights.get(record.id) === controller) this.preflights.delete(record.id);
    }
  }
  async #drain() {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      for (const record of this.records.values()) {
        if (this.#activeIds().length >= this.maxConcurrent) break;
        if (record.status !== 'queued') continue;
        const deps = (record.dependsOn || []).map(id => this.#status(id));
        if (deps.some(status => !status || ['failed', 'cancelled', 'uncertain', 'blocked', 'paused', 'limit'].includes(status))) {
          record.status = 'blocked'; record.error = 'A dependency has not completed successfully.';
          record.updatedAt = now();
          await this.#save();
          continue;
        }
        if (deps.some(status => status !== 'completed')) continue;
        record.status = 'preparing';
        record.updatedAt = now();
        await this.#save();
        void this.#runRecord(record);
      }
    } finally { this.draining = false; }
  }
  async start({ prompt, attachments = [], dependsOn = [], parentTaskId = null, baseRef = null, workspacePath = null } = {}) {
    if (this.closed) throw fail('shutting_down', 'Hub is shutting down.', 503);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) throw fail('invalid_prompt', 'A task prompt is required.', 400);
    if (!Array.isArray(dependsOn) || dependsOn.length > 12 || dependsOn.some(id => !UUID.test(id) || !this.get(id)))
      throw fail('invalid_dependencies', 'Dependencies must reference existing ChatMCP tasks.', 400);
    if (parentTaskId && (!UUID.test(parentTaskId) || !this.get(parentTaskId)))
      throw fail('invalid_parent', 'Parent task was not found.', 400);
    const parent = parentTaskId ? this.get(parentTaskId) : null;
    const desired = parent ? parent.workspacePath || parent.workspace?.path || this.manager.workspace : workspacePath;
    const root = this.manager.workspaceRegistry
      ? (await this.manager.workspaceRegistry.resolve(desired)).path
      : this.manager.workspace;
    if (!root) throw fail('workspace_missing', 'Select a project before starting an agent.');
    // A runner may have persisted its completed state a moment before its
    // finally block releases the workspace lock. Wait for cleanup, not a new
    // worktree, when a previous sequential task is already finished.
    if (this.primary.activeTaskId && this.primary.get(this.primary.activeTaskId)?.status !== 'running'
        && this.primary.context?.done) await this.primary.context.done.promise;
    // Preserve established sequential editing workflows: when the main
    // checkout is idle, a fresh chat may use it. Only overlapping sessions,
    // explicit branch selections or dependent background agents use isolated
    // worktrees. This avoids unexpectedly editing a throwaway branch after a
    // prior chat completed, while never allowing two writers in one checkout.
    const rootOccupied = Boolean(
      (this.primary.activeTaskId && root === this.manager.workspace) ||
      [...this.records.values()].some(r =>
        [r.executionRoot,r.worktree,r.pendingWorktree?.path].includes(root) &&
        (['queued','preparing','running'].includes(this.#status(r.id)) ||
          this.children.get(r.id)?.runner.activeTaskId === r.id))
    );
    if (!parentTaskId && !dependsOn.length && !baseRef &&
        root === this.manager.workspace && !this.primary.activeTaskId && !rootOccupied)
      return this.primary.start({ prompt, attachments });
    const id = randomUUID();
    const record = { id, prompt: prompt.trim(), attachments, attachmentCount: attachments.length,
      conversationId:parent?.conversationId||parentTaskId||id,
      parentRunId:parentTaskId?(parent?.runs?.at(-1)?.id||null):null,
      sourceRoot: root, createdAt: now(), updatedAt: now(),
      status: 'queued', dependsOn: [...new Set(dependsOn)], parentTaskId, baseRef,
      executionRoot: root !== this.manager.workspace && !rootOccupied && !parentTaskId && !baseRef ? root : null,
      worktree: null, branch: null, permissionMode: this.manager.permissions?.mode || 'review',
      executionPolicy: this.manager.permissions?.executionPolicy || 'host-review', error: null };
    this.records.set(id, record);
    await this.#save();
    void this.#drain().catch(error => this.log(error.message));
    return this.#queued(record);
  }
  async spawnAgent(parentTaskId, { goal, dependsOn = [] } = {}) {
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 8000)
      throw fail('invalid_goal', 'Subagent goal is required and must be under 8000 characters.', 400);
    // The caller's tool invocation already passes the active conversation's permissions.
    return this.start({ prompt: goal, dependsOn, parentTaskId,
      workspacePath: this.get(parentTaskId)?.workspacePath || null });
  }
  async continue({ id, prompt, attachments = [], ...limits } = {}) {
    if (this.primary.get(id)) {
      if (this.primary.activeTaskId === id) return this.primary.enqueueMessage({ id, prompt, attachments });
      return this.primary.continue({ id, prompt, attachments, ...limits });
    }
    const record = this.records.get(id);
    if (!record) throw fail('task_not_found', 'Conversation does not exist.', 404);
    const child = this.children.get(id);
    if (child?.runner.activeTaskId === id) return child.runner.enqueueMessage({ id, prompt, attachments });
    if (record.status === 'queued' || record.status === 'preparing')
      throw fail('task_queued', 'This conversation is waiting for its dependencies or worktree.');
    if (!child) {
      if (record.status === 'blocked' || record.status === 'paused' || record.status === 'failed') {
        if (record.attachmentCount && !attachments.length)
          throw fail('attachments_required','The interrupted task had attachments. Reattach files/images before starting a new run.',409);
        record.prompt += '\n\nFOLLOW-UP: ' + String(prompt || '');
        record.attachments = attachments;
        record.attachmentCount = attachments.length;
        record.status = 'queued'; record.error = null;
        await this.#save();
        void this.#drain();
        return this.#queued(record);
      }
      throw fail('missing_worktree', 'No worktree available for continuation.');
    }
    return child.runner.continue({ id, prompt, attachments, ...limits });
  }
  async cancel(id) {
    if (this.primary.get(id)) return this.primary.cancel(id);
    const record = this.records.get(id);
    if (!record) throw fail('task_not_found', 'Task does not exist.', 404);
    const child = this.children.get(id);
    if (child?.runner.activeTaskId === id) return child.runner.cancel(id);
    if (['queued', 'preparing'].includes(record.status)) {
      const preflight = this.preflights.get(id);
      if (preflight && !preflight.signal.aborted)
        preflight.abort(fail('user_cancelled','Owner cancelled worktree preparation.',409));
      record.status = record.pendingWorktree ? 'uncertain' : 'cancelled';
      record.error = record.pendingWorktree
        ? 'Git may have created a worktree during cancellation. Inspect the recorded path and Git refs.'
        : null;
      record.updatedAt = now();
      await this.#save();
    }
    return this.get(id);
  }
  async delete(id) {
    if (!this.primary.get(id) && !this.records.has(id))
      throw fail('task_not_found','Conversation or subagent does not exist.',404);
    // A conversation owns all of its delegated subagents. Removing only the
    // root would strand those children in Background Tasks and in sessions.json.
    const visited=new Set([id]), queue=[id];
    for(let i=0;i<queue.length;i++){
      for(const record of this.records.values()){
        if(record.parentTaskId===queue[i]&&!visited.has(record.id)){
          visited.add(record.id);queue.push(record.id);
        }
      }
    }
    for(const taskId of queue){
      const record=this.records.get(taskId),child=this.children.get(taskId);
      if(this.primary.activeTaskId===taskId || child?.runner.activeTaskId===taskId ||
        this.preflights.has(taskId) ||
        (record&&['queued','preparing','running'].includes(record.status)))
        throw fail('task_running','Stop all tasks and subagents in this conversation before deleting.',409);
    }
    const preservedWorktrees=[];
    // Delete descendants first so no child can retain a dangling parent.
    for(const taskId of [...queue].reverse()){
      const record=this.records.get(taskId);
      if(!record){
        await this.primary.delete(taskId);
        continue;
      }
      const child=this.children.get(taskId);
      if(child?.runner.get(taskId))await child.runner.delete(taskId);
      if(child)await child.manager.shutdown();
      if(record.worktree)preservedWorktrees.push(record.worktree);
      this.children.delete(taskId);
      this.records.delete(taskId);
    }
    await this.#save();
    this.#event({type:'state',taskId:id,state:'deleted'});
    // Git worktrees, branches and source files are NEVER deleted by removing
    // conversation history; only local task records are discarded.
    return {ok:true,deletedId:id,deletedIds:queue,preservedWorktrees};
  }
  async setAutoResume(id, enabled) {
    if (this.primary.get(id)) return this.primary.setAutoResume(id, enabled);
    const child = this.children.get(id);
    if (child?.runner.get(id)) return child.runner.setAutoResume(id, enabled);
    throw fail('task_not_found', 'Task does not exist.', 404);
  }
  decidePermission(id, approved) {
    for (const child of this.children.values()) {
      if ((child.manager.permissions?.state().pending || []).some(x => x.id === id))
        return child.manager.permissions.decide(id, approved);
    }
    for (const access of this.readyAccessManagers.values()) {
      if ((access.permissions?.state().pending || []).some(x => x.id === id))
        return access.permissions.decide(id, approved);
    }
    return null;
  }
  pendingApprovals() {
    return [...this.children.values()].flatMap(x => x.manager.permissions?.state().pending || [])
      .concat([...this.readyAccessManagers.values()].flatMap(x => x.permissions?.state().pending || []));
  }
  async shutdown() {
    this.closed = true;
    for (const controller of this.preflights.values())
      if (!controller.signal.aborted) controller.abort(fail('shutdown','Hub is shutting down.',503));
    await Promise.allSettled([this.primary.shutdown(), ...[...this.children.values()].map(x => x.runner.shutdown())]);
    await Promise.allSettled([...this.children.values()].map(x => x.manager.shutdown()));
    await Promise.allSettled([...this.readyAccessManagers.values()].map(x => x.shutdown()));
    await this.writes.catch(() => {});
  }
}
