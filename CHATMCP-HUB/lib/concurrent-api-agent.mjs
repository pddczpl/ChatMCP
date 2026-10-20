// Multi-conversation API coordinator. Each additional conversation runs with its
// own HubManager and worktree; no two coding sessions share a writable checkout.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { HubManager } from './manager.mjs';
import { AgentRunner } from './agent.mjs';
import { WorkflowOrchestrator } from './workflow-orchestrator.mjs';
import { summarizeCostLedgers } from './model-cost.mjs';
import { assembleStudio } from './assemble.mjs';
import { readJson, writeJson } from './runtime.mjs';
import { childFacts } from './agent-results.mjs';
import { endSummary } from './subagent-notices.mjs';

const END = new Set(['completed', 'failed', 'cancelled', 'paused', 'uncertain', 'limit', 'interrupted']);
// Agents that a model spawns can spawn again. Without a limit a model that always delegates grows an unbounded tree of worktrees and
// model calls. Depth counts from the conversation the user started (depth 0): with the default 2 that conversation can spawn children
// (depth 1) and those can spawn grandchildren (depth 2), which cannot spawn at all and are not even offered the spawn tools.
export const DEFAULT_SPAWN_LIMITS = Object.freeze({ maxSpawnDepth: 2, maxSpawnDescendants: 16 });
const SPAWN_LIMIT_BOUNDS = Object.freeze({ maxSpawnDepth: [0, 4], maxSpawnDescendants: [0, 64] });
export const SPAWN_LIMIT_CODES = Object.freeze(['spawn_depth_exceeded', 'spawn_descendants_exceeded']);
function normalizeSpawnLimits(value, base = DEFAULT_SPAWN_LIMITS) {
  const next = { ...base };
  for (const key of Object.keys(SPAWN_LIMIT_BOUNDS)) {
    if (value?.[key] === undefined) continue;
    const [min, max] = SPAWN_LIMIT_BOUNDS[key];
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      throw Object.assign(new Error(`${key} must be an integer from ${min} to ${max}.`), { code: 'invalid_spawn_limits', statusCode: 400 });
    next[key] = value[key];
  }
  return next;
}
// The user's earlier requests that a handoff carries (DualAgent writes the last 4, 150 characters each). A client of the Hub can send them with the text, so the pool bounds
// them as it bounds the text: strings only, at most this many, cut at this length.
const HANDOFF_REQUESTS = 8, HANDOFF_REQUEST_CHARACTERS = 1000;
const handoffRequestsOf = (list) => list.filter((text) => typeof text === 'string' && text.trim()).slice(-HANDOFF_REQUESTS).map((text) => text.trim().slice(0, HANDOFF_REQUEST_CHARACTERS));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const now = () => new Date().toISOString();
// Normalize owner-provided role labels and model-generated workflow role names
// to the same safe lookup key (e.g. "Independent verifier" -> "independent_verifier").
const roleKey = role => typeof role==='string'
  ? role.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()
      .replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')
  : '';
function normalizeRoleProfiles(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||
      Object.keys(value).length>12)throw fail('invalid_role_profiles','Role profile mapping must have up to 12 entries.',400);
  const result=Object.create(null);
  for(const [label,profileId] of Object.entries(value)){
    const key=roleKey(label);
    if(!/^\p{L}[\p{L}\p{N}_ -]{0,80}$/u.test(label) ||
        !/^[a-z][a-z0-9_]{0,40}$/.test(key) ||
        typeof profileId!=='string' || !/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(profileId) ||
        Object.hasOwn(result,key))
      throw fail('invalid_role_profiles','Invalid or duplicated role profile mapping.',400);
    result[key]=profileId;
  }
  return {...result};
}

export class ConcurrentApiAgent {
  constructor({ primary, manager, provider, bundleRoot, directory, maxConcurrent = 4, log = () => {}, ...spawnLimits }) {
    if (!primary || !manager || !provider || !bundleRoot || !directory)
      throw new TypeError('ConcurrentApiAgent requires the primary agent and local Hub resources.');
    this.limits = normalizeSpawnLimits(spawnLimits);
    this.spawnReservations = new Map();
    // The primary agent asks this before it offers spawn_agent / spawn_workflow to the model.
    manager.spawnAllowed = (taskId) => this.spawnAllowed(taskId);
    // And this to read what the agents it started produced (its agent_results tool) and to know whether it has any.
    manager.listSubagents = (taskId) => this.listSubagents(taskId);
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
    this.workflows=new WorkflowOrchestrator({
      startAgent:(id,args)=>this.spawnAgent(id,args),
      getTask:id=>this.get(id),
      cancelTask:id=>this.cancel(id),
      maxAgents:12,
      onChange:async({type,workflowId,conversationId})=>{
        await this.#save();
        this.#event({type:'workflow',event:{type,workflowId},taskId:conversationId});
      },
      log:this.log,
    });
    this.primary.subscribe((event) => this.#event(event));
  }
  async #scopedProvider(profileId=null,expectedRevision=null) {
    if(typeof this.manager.resolveAiProfileProvider==='function')
      return this.manager.resolveAiProfileProvider({profileId,expectedRevision});
    if(profileId && profileId!=='__global__')
      throw fail('profile_unsupported','Model profile selection is not available on this Hub.',409);
    return {provider:this.provider,effectiveProfile:null};
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
    // A child run that ended (its runner emits this from #finish, after its result is recorded) is news for the task that started it.
    if (event.type === 'event' && END.has(event.event?.type) && typeof event.taskId === 'string') this.#noteEnded(event.taskId);
  }
  #save() {
    const snapshot = { version: 2, records: [...this.records.values()].map(({ attachments, ...r }) => r), workflows:this.workflows.serialize(), spawnLimits: { ...this.limits } };
    const next = this.writes.catch(() => {}).then(() => writeJson(path.join(this.directory, 'sessions.json'), snapshot));
    this.writes = next;
    next.catch(() => {});
    return next;
  }
  #queued(r) {
    const state = r.status === 'preparing' ? 'queued' : r.status === 'blocked' ? 'paused' : r.status;
    return {
      id: r.id, conversationId:r.conversationId||r.parentTaskId||r.id, linkedFromTaskId:r.linkedFromTaskId||null, workspacePath:r.sourceRoot, prompt: r.prompt, workflowId:r.workflowId||null,phaseId:r.phaseId||null,role:r.role||null, status: r.status === 'preparing' ? 'running' : r.status,
      state, createdAt: r.createdAt, updatedAt: r.updatedAt, workspace: { path: r.worktree || r.executionRoot || r.sourceRoot },
      branch: r.branch, dependsOn: r.dependsOn || [], parentTaskId: r.parentTaskId || null,
      effectiveProfile:r.effectiveProfile||null,roleProfiles:r.roleProfiles||{},
      parentRunId: r.parentRunId || null,
      events: [], toolCalls: 0, steps: 0, prompts: [{ at: r.createdAt, text: r.prompt }],
      dialogue: [{ role: 'user', at: r.createdAt, text: r.prompt }],
      error: r.error || null, runCount: 0, transport: 'api',
    };
  }
  #detail(record) {
    const real = this.children.get(record.id)?.runner.get(record.id);
    return real ? { ...real, branch: record.branch, worktree: record.worktree,
      workspacePath:record.sourceRoot, conversationId:record.conversationId||record.parentTaskId||record.id,linkedFromTaskId:record.linkedFromTaskId||null,
      dependsOn: record.dependsOn || [], parentTaskId: record.parentTaskId || null,
      parentRunId:record.parentRunId||null,workflowId:record.workflowId||null,phaseId:record.phaseId||null,role:record.role||null,
      effectiveProfile:record.effectiveProfile||null,roleProfiles:record.roleProfiles||{} } : this.#queued(record);
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
      active: activeTaskIds.length ? this.get(activeTaskIds[0]) : null,
      modelCostSummary:summarizeCostLedgers(tasks.map(t=>t.modelCost).filter(Boolean)),
      spawnLimits: this.spawnLimits(),
      tasks };
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
          conversationId: summary.conversationId||summary.id,
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
    // The limits chosen in the Hub's state win over the constructor defaults; a damaged value falls back to what the constructor set.
    try { this.limits = normalizeSpawnLimits(data?.spawnLimits, this.limits); } catch { /* keep the constructor limits */ }
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
    this.workflows.load(data.workflows);
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
        access.hooks = this.manager.hooks; // the owner's hooks, as for a child: its own data folder holds none
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
  // ------------------------------------------------------------------ what a task's children produced
  /** The workflow and phase a child belongs to, by name, for what the parent reads. */
  #workflowOf(record) {
    const workflow = record.workflowId ? this.workflows.workflows.get(record.workflowId) : null;
    if (!workflow) return null;
    return { name: workflow.name, phase: workflow.phases?.find((phase) => phase.id === record.phaseId)?.name ?? null };
  }
  #factsOf(record) { return childFacts({ record, detail: this.#detail(record), workflow: this.#workflowOf(record) }); }
  /** What the Hub knows about the agents that `parentTaskId` started, one object per agent (lib/agent-results.mjs): the source of that task's agent_results tool. */
  listSubagents(parentTaskId) {
    const facts = [];
    for (const record of this.records.values()) if (record.parentTaskId === parentTaskId) facts.push(this.#factsOf(record));
    return facts;
  }
  /** A child may have stopped: the runner that holds its parent task is told, once per ending (the parent's record keeps the key). Never throws. */
  #noteEnded(childId) {
    try {
      const record = this.records.get(childId);
      if (this.closed || !record?.parentTaskId) return;
      const runner = this.primary.tasks.has(record.parentTaskId) ? this.primary : this.children.get(record.parentTaskId)?.runner;
      if (!runner?.tasks.has(record.parentTaskId)) return;
      const summary = endSummary(this.#factsOf(record));
      if (summary) void runner.recordSubagentFinished(record.parentTaskId, summary).catch((error) => this.log(`Subagent notice: ${error.message}`));
    } catch (error) { this.log(`Subagent notice: ${error.message}`); }
  }

  // ------------------------------------------------------------------ spawn limits
  /** Depth of a task: 0 for a conversation the user started, parent depth + 1 for an agent that another agent spawned. */
  #depthOf(id) {
    if (!id || this.primary.get(id)) return 0;
    let record = this.records.get(id);
    let depth = 0;
    while (record && depth < 32) {
      if (Number.isInteger(record.depth)) return record.depth + depth;
      if (!record.parentTaskId) return depth;
      depth += 1;
      record = this.records.get(record.parentTaskId);
    }
    return depth;
  }
  #conversationOf(id) {
    const record = this.records.get(id);
    return record ? (record.conversationId || record.parentTaskId || record.id) : id;
  }
  #descendantCount(conversationId) {
    let count = this.spawnReservations.get(conversationId) || 0;
    for (const record of this.records.values()) {
      if (record.parentTaskId && (record.conversationId || record.parentTaskId || record.id) === conversationId) count += 1;
    }
    return count;
  }
  spawnLimits() { return { ...this.limits }; }
  /** Changes the limits (persisted with the Hub's conversation state) and re-syncs the tools of the running children. */
  async configureSpawnLimits(patch = {}) {
    this.limits = normalizeSpawnLimits(patch, this.limits);
    for (const [id, child] of this.children) { const record = this.records.get(id); if (record) this.#syncSpawnTools(record, child.manager); }
    await this.#save();
    return this.spawnLimits();
  }
  /** Whether the model working on `taskId` may be offered the spawn tools at all: below the depth cap and with room left in the tree. */
  spawnAllowed(taskId) {
    const { maxSpawnDepth, maxSpawnDescendants } = this.limits;
    return this.#depthOf(taskId) < maxSpawnDepth && this.#descendantCount(this.#conversationOf(taskId)) < maxSpawnDescendants;
  }
  /** Spawn tools exist on a child's manager only while its depth is below the cap, so an agent at the cap is never offered them. */
  #syncSpawnTools(record, manager) {
    if (this.#depthOf(record.id) < this.limits.maxSpawnDepth) {
      manager.spawnBackgroundAgent = (_callerId, request) => this.spawnAgent(record.id, request);
      manager.spawnWorkflow = (_callerId, request) => this.spawnWorkflow(record.id, request);
    } else {
      delete manager.spawnBackgroundAgent;
      delete manager.spawnWorkflow;
    }
  }
  /** Checks depth and tree size for `count` new agents under `parentTaskId` and holds their place until the records exist. */
  #reserveSpawn(parentTaskId, count = 1) {
    const parentDepth = this.#depthOf(parentTaskId);
    const { maxSpawnDepth, maxSpawnDescendants } = this.limits;
    const conversationId = this.#conversationOf(parentTaskId);
    const used = this.#descendantCount(conversationId);
    const detail = { depth: parentDepth, requestedDepth: parentDepth + 1, maxSpawnDepth, descendants: used, requested: count, maxSpawnDescendants, conversationId };
    const refuse = (code, message) => Object.assign(fail(code, message, 409), { structured: { code, message, ...detail } });
    if (parentDepth + 1 > maxSpawnDepth)
      throw refuse('spawn_depth_exceeded', `This agent is at spawn depth ${parentDepth} and the limit is ${maxSpawnDepth}: it cannot start more agents. Finish the work yourself or report what is missing.`);
    if (used + count > maxSpawnDescendants)
      throw refuse('spawn_descendants_exceeded', `This conversation already has ${used} spawned agents and the limit is ${maxSpawnDescendants}; ${count} more were requested. Reuse the agents that exist or finish the work yourself.`);
    this.spawnReservations.set(conversationId, (this.spawnReservations.get(conversationId) || 0) + count);
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      const left = (this.spawnReservations.get(conversationId) || 0) - count;
      if (left > 0) this.spawnReservations.set(conversationId, left); else this.spawnReservations.delete(conversationId);
    } };
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
    // The SAME hooks instance as the Hub's: this manager has a state folder of its own, and reading hooks.json from it would run the
    // agent without the owner's hooks. The project's own file is looked for where the project is, not in the agent's worktree.
    manager.hooks = this.manager.hooks;
    manager.hooksProjectRoot = record.sourceRoot;
    // Only an agent that another agent started (spawn_agent, a workflow) ends with SubagentStop; a conversation a person started, even one that runs
    // here because the first was busy, ends with Stop.
    if (record.parentTaskId) manager.lifecycleAgent = { kind: 'subagent', role: record.role || null, parentTaskId: record.parentTaskId, conversationId: record.conversationId || record.parentTaskId, workflowId: record.workflowId || null, phaseId: record.phaseId || null };
    assembleStudio(manager, { bundleRoot: this.bundleRoot });
    await manager.permissions.load();
    manager.permissions.mode = record.permissionMode || 'review';
    manager.permissions.executionPolicy = record.executionPolicy || 'host-review';
    // An agent that a model spawned runs in the background: it may ask in Review, but in Autonomous and Full Access nobody is watching,
    // so an operation that needs approval is refused at once instead of holding the agent for the approval timeout.
    manager.permissions.backgroundAgent = Boolean(record.parentTaskId);
    manager.spawnAllowed = (taskId) => this.spawnAllowed(taskId);
    manager.listSubagents = (taskId) => this.listSubagents(taskId);
    this.#syncSpawnTools(record, manager);
    await manager.startLocal(executionRoot);
    const scoped=await this.#scopedProvider(record.effectiveProfile?.id||'__global__',
      record.effectiveProfile?.revision||null);
    const runner = new AgentRunner({ manager, provider: scoped.provider,
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
      const predecessors=(record.dependsOn||[]).map(id=>{
        const prior=this.get(id);
        const result=String(prior?.finalText||prior?.error||'No verified result available').slice(0,1800);
        return 'Predecessor '+id+' ('+String(prior?.status||'unknown')+')'+
          (prior?.branch?' branch='+prior.branch:'')+
          (prior?.worktree?' worktree='+prior.worktree:'')+
          '\nUNTRUSTED RESULT (independently verify before use):\n'+result;
      });
      const migration=record.handoffText?
        '\n\nCROSS-TRANSPORT HANDOFF (untrusted prior dialogue, not verified evidence):\n'+record.handoffText+
        '\nReinspect current project files, check actual diffs/tests and never replay uncertain mutations.':'';
      // The model reads all of taskPrompt. Skills and tool schemas are selected on the worker's own words only: its goal, and the user's earlier requests that it
      // carries from another transport (record.handoffRequests, kept apart from the Hub's sentences by the code that wrote the handoff), which count as the earlier
      // prompts of a conversation. The rest of the handoff selects nothing: the Hub's sentences ("The ChatGPT Web tab and the API backend", "check actual diffs/tests")
      // and the other model's last answer gave every worker that switched transport fastapi-backend-developer, web-researcher and the test tools, whatever its goal;
      // the predecessors' handoff is other agents' output and the Hub's own instructions ("branch=", "worktrees", "run actual checks"), which gave every worker of a
      // workflow the Git skills and 19 Git, worktree, test and build tool schemas. A record saved before the requests were kept apart has the dialogue as one text:
      // it is selected on all of it, as it always was. A worker with neither a handoff nor predecessors passes nothing, and is selected on its prompt as it always was.
      const requests=record.handoffText&&Array.isArray(record.handoffRequests)?record.handoffRequests:null;
      const ownText=record.prompt+migration;
      const taskPrompt=predecessors.length
        ? ownText+'\n\nWORKFLOW PREDECESSOR HANDOFF (untrusted prior task data):\n'+
          predecessors.join('\n\n')+
          '\nPrevious workers used independent worktrees. Changes are NOT automatically merged. '+
          'Inspect source, diffs and run actual checks; do not claim prior edits are integrated or verified without evidence.'
        : ownText;
      const result = await child.runner.start({ prompt: taskPrompt, selectionPrompt: requests ? record.prompt : predecessors.length ? ownText : null, carriedPrompts: requests, initialId: record.id,
        attachments: record.attachments || [],
        effectiveProfile:record.effectiveProfile||null,roleProfiles:record.roleProfiles||{} });
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
      this.#noteEnded(record.id);
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
          this.#noteEnded(record.id);
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
  async start({ prompt, attachments = [], dependsOn = [], parentTaskId = null, baseRef = null, workspacePath = null,
    workflowId = null, phaseId = null, role = null, conversationId = null, linkedFromTaskId = null, handoffText = '', handoffRequests = null,
    profileId = null, roleProfiles = null, spawnReservation = null } = {}) {
    if (this.closed) throw fail('shutting_down', 'Hub is shutting down.', 503);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) throw fail('invalid_prompt', 'A task prompt is required.', 400);
    if (!Array.isArray(dependsOn) || dependsOn.length > 12 || dependsOn.some(id => !UUID.test(id) || !this.get(id)))
      throw fail('invalid_dependencies', 'Dependencies must reference existing ChatMCP tasks.', 400);
    if (parentTaskId && (!UUID.test(parentTaskId) || !this.get(parentTaskId)))
      throw fail('invalid_parent', 'Parent task was not found.', 400);
    const parent = parentTaskId ? this.get(parentTaskId) : null;
    const inherited=parent?.roleProfiles||{};
    const requestedOverrides=roleProfiles===null ? inherited : roleProfiles;
    const selectedRoleProfiles=normalizeRoleProfiles(requestedOverrides);
    const chosenId=profileId || (role&&selectedRoleProfiles[roleKey(role)]) || parent?.effectiveProfile?.id || null;
    const scoped=await this.#scopedProvider(chosenId);
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
    if (!parentTaskId && !dependsOn.length && !baseRef && !linkedFromTaskId &&
        root === this.manager.workspace && !this.primary.activeTaskId && !rootOccupied)
      {
        this.primary.provider=scoped.provider;
        return this.primary.start({prompt,attachments,effectiveProfile:scoped.effectiveProfile,
          roleProfiles:selectedRoleProfiles});
      }
    const id = randomUUID();
    const record = { id, prompt: prompt.trim(), attachments, attachmentCount: attachments.length,
      conversationId:conversationId||parent?.conversationId||parentTaskId||id,
      linkedFromTaskId:linkedFromTaskId||null,
      handoffText:typeof handoffText==='string'?handoffText.slice(0,2500):'',
      // The user's requests inside handoffText, apart from the Hub's sentences around them (see #runRecord). A record saved without them has the text alone.
      ...(typeof handoffText==='string'&&handoffText&&Array.isArray(handoffRequests)?{handoffRequests:handoffRequestsOf(handoffRequests)}:{}),
      parentRunId:parentTaskId?(parent?.runs?.at(-1)?.id||null):null,
      workflowId,phaseId,role,
      profileId:scoped.effectiveProfile?.id||null,
      effectiveProfile:scoped.effectiveProfile||null,roleProfiles:selectedRoleProfiles,
      sourceRoot: root, createdAt: now(), updatedAt: now(),
      depth: parentTaskId ? this.#depthOf(parentTaskId) + 1 : 0,
      status: 'queued', dependsOn: [...new Set(dependsOn)], parentTaskId, baseRef,
      executionRoot: root !== this.manager.workspace && !rootOccupied && !parentTaskId && !baseRef ? root : null,
      worktree: null, branch: null, permissionMode: this.manager.permissions?.mode || 'review',
      executionPolicy: this.manager.permissions?.executionPolicy || 'host-review', error: null };
    this.records.set(id, record);
    // The record now counts toward the tree size by itself.
    spawnReservation?.release();
    await this.#save();
    void this.#drain().catch(error => this.log(error.message));
    return this.#queued(record);
  }
  async spawnAgent(parentTaskId, { goal, dependsOn = [], workflowId = null, phaseId = null, role = null } = {}) {
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 8000)
      throw fail('invalid_goal', 'Subagent goal is required and must be under 8000 characters.', 400);
    // The enforcement point: depth and tree size are checked here, whatever tools the model was offered, and the place is held
    // synchronously so parallel spawn calls cannot all slip under the limit together.
    const reservation = this.#reserveSpawn(parentTaskId, 1);
    try {
      // Role overrides are inherited from the owner's original task. A model
      // cannot supply a new credential destination through spawn_agent.
      const parent=this.get(parentTaskId);
      return await this.start({ prompt: goal, dependsOn, parentTaskId,
        workflowId,phaseId,role,roleProfiles:parent?.roleProfiles||{},
        profileId:(role?parent?.roleProfiles?.[roleKey(role)]:null)||parent?.effectiveProfile?.id||null,
        workspacePath: parent?.workspacePath || null, spawnReservation: reservation });
    } finally { reservation.release(); }
  }
  async spawnWorkflow(parentTaskId, request = {}) {
    if (!this.get(parentTaskId)) throw fail('parent_missing','Conversation not found.',404);
    // A workflow starts many agents; refuse it up front when they cannot all fit, instead of creating half of it.
    const planned = Array.isArray(request?.phases)
      ? request.phases.reduce((sum, phase) => sum + (Array.isArray(phase?.agents) ? phase.agents.length : 0), 0) : 0;
    this.#reserveSpawn(parentTaskId, Math.max(1, Math.min(planned, 1000))).release();
    const root=this.get(parentTaskId)?.workspacePath||this.get(parentTaskId)?.workspace?.path;
    if (this.manager.workspaceRegistry&&root)
      await this.manager.workspaceRegistry.resolve(root);
    return this.workflows.create(parentTaskId,request);
  }
  async continue({ id, prompt, attachments = [], ...limits } = {}) {
    const original=this.get(id);
    if(!original)throw fail('task_not_found','Conversation does not exist.',404);
    const root=original.workspacePath||original.workspace?.path;
    // A detached workspace must be explicitly re-added before any old chat
    // can start writing there again, even when its task ID is still known.
    if(this.manager.workspaceRegistry&&root)
      await this.manager.workspaceRegistry.resolve(root);
    if (this.primary.get(id)) {
      if (this.primary.activeTaskId === id) {
        // The task's completed state is persisted before its finally block
        // releases the owner workspace lock. A follow-up in this gap must
        // begin another run, not be enqueued onto a finished model loop.
        if (this.primary.get(id)?.status === 'running')
          return this.primary.enqueueMessage({id,prompt,attachments});
        await this.primary.context?.done?.promise;
      }
      const scoped=await this.#scopedProvider(original.effectiveProfile?.id||'__global__',
        original.effectiveProfile?.revision||null);
      this.primary.provider=scoped.provider;
      return this.primary.continue({ id, prompt, attachments, ...limits,
        effectiveProfile:scoped.effectiveProfile,roleProfiles:original.roleProfiles||{} });
    }
    const record = this.records.get(id);
    if (!record) throw fail('task_not_found', 'Conversation does not exist.', 404);
    const child = this.children.get(id);
    if (child?.runner.activeTaskId === id) {
      if (child.runner.get(id)?.status === 'running')
        return child.runner.enqueueMessage({id,prompt,attachments});
      await child.runner.context?.done?.promise;
    }
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
    const scoped=await this.#scopedProvider(record.effectiveProfile?.id||'__global__',
      record.effectiveProfile?.revision||null);
    child.runner.provider=scoped.provider;
    return child.runner.continue({id,prompt,attachments,...limits,
      effectiveProfile:scoped.effectiveProfile,roleProfiles:record.roleProfiles||{} });
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
      this.#noteEnded(id);
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
      const started=child?.runner.get(taskId);
      if(this.primary.activeTaskId===taskId || child?.runner.activeTaskId===taskId ||
        this.preflights.has(taskId) ||
        (record&&!started&&['queued','preparing','running'].includes(record.status)))
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
    this.workflows.removeByConversation(id);
    await this.#save();
    this.#event({type:'state',taskId:id,state:'deleted'});
    // Git worktrees, branches and source files are NEVER deleted by removing
    // conversation history; only local task records are discarded.
    return {ok:true,deletedId:id,deletedIds:queue,preservedWorktrees};
  }
  async acceptCriterion(payload={}) {
    const id=payload?.id;
    if(this.primary.get(id))return this.primary.acceptCriterion(payload);
    const child=this.children.get(id);
    if(child?.runner?.get(id))return child.runner.acceptCriterion(payload);
    throw fail('task_not_found','Task does not exist.',404);
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
