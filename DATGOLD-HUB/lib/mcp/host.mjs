// The host of the Hub's MCP server for local clients (docs/MCP-SERVER.md "The host", roadmap P6 ext-18): how a client's tools/call goes
// through the Hub's own permission gate without colliding with the primary agent's task.
//
//   - Each client (its own name, cleaned: clientIdOf) gets a HubManager of its own, made with assembleStudio on the Hub's workspace, with
//     a data folder of its own under <data>/mcp-host: its checkpoints, its plan, its workflow and its permission history are its own, and
//     the primary agent's task, checkpoints and plan are never touched. The manager holds ONE synthetic task for its whole life
//     (hostTaskId: a UUID per workspace and client, the same at every start; the plan, the checkpoints and the workflow need a UUID, and a
//     colon in a file name is a stream on NTFS), and every call goes through the guarded session of HubManager (#guardCalls): the
//     permission gate, the owner's PreToolUse/PostToolUse hooks, the external-tool policy, a checkpoint before a change.
//   - The gate of a client is locked to its scope (lockGate): verify and read are Read Only, write is Review (or Read Only); autonomous and
//     Full Access are refused, by configure() and by a plain assignment. Its approval timeout is 90 s (the owner answers in the dashboard;
//     a client must not hang for the gate's usual 10 minutes) and an expired request is an `approval_timeout` result.
//   - One writer: a call that can change the workspace (spec.write, or any category but read, checkpoint and blocked) is `workspace_busy`
//     while another MCP write is under way (from the first question to its end), while the primary agent works (primaryState) or while the
//     workspace lock file is held (WorkspaceLock), before anyone is asked; an approval given after the primary agent started is
//     `workspace_busy` too (checked again before the call runs).
//   - Its approvals are merged into the Hub's /api/state (pendingApprovals, tagged source 'mcp', client and tag mcp:<client>) and the
//     dashboard's decide route reaches them (decide).
// What a client can call is the host's tool list (each tool names its target, a local tool, a Studio tool the local backend offers, or an
// external one); ext-18's Hub exposed only read_file (HUB_HOST_TOOLS). Since ext-19 the Hub's host serves every tool of the profiles
// (lib/mcp/tool-profiles.mjs) in the `profiles` scope (the gate in Review), and the token's scope decides which of them a client may call.
// Whatever the scope, a call is refused before the gate when the live definition of its target no longer says what tools/list told the
// client (readOnlyHint, destructiveHint: mcp_annotations_mismatch), when a tool that said it is read-only is not a read for the gate
// (mcp_profile_refused), and, once the owner has answered, when the caller's scope no longer allows it (stillAllowed: mcp_scope_refused).
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { HubManager, LOCAL_BACKEND_STUDIO_TOOLS } from '../manager.mjs';
import { assembleStudio } from '../assemble.mjs';
import { LocalTools } from '../local-tools.mjs';
import { STUDIO_TOOLS } from '../studio-tools.mjs';
import { externalToolName, maskSecrets } from '../permissions.mjs';
import { WorkspaceLock } from '../workspace-lock.mjs';
import { hubMcpProvider } from './server.mjs';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 90_000;
export const MAX_CLIENTS = 8;
export const MCP_HOST_SCOPES = Object.freeze(['verify', 'read', 'write', 'profiles']);
/** What ext-18's Hub let a client call through the host: one read tool, to prove the path. The Hub serves the profiles of ext-19 now; kept for the ext-18 host tests. */
export const HUB_HOST_TOOLS = Object.freeze([Object.freeze({ name: 'read_file', target: 'local.read_file' })]);
const MODES_OF_SCOPE = Object.freeze({ profiles: Object.freeze(['readonly', 'review']), verify: Object.freeze(['readonly']), read: Object.freeze(['readonly']), write: Object.freeze(['readonly', 'review']) });
const DEFAULT_MODE = Object.freeze({ verify: 'readonly', read: 'readonly', write: 'review' });
// The profiles scope: the token's scope chooses the tools (lib/mcp/tool-profiles.mjs) and the gate asks the owner for anything but a read.
const PROFILES_MODE = 'review';
const POLICIES = Object.freeze(['host-review', 'sandbox-only']);
// The categories of a call that cannot change the workspace: a read, the client's own plan or checkpoint (in the client's folder), and a
// call the gate refuses whatever happens (a protected file).
const NOT_WRITES = new Set(['read', 'checkpoint', 'blocked']);
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const RESERVED_NAMES = new Set(['hub_status']);
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
// A manager of the host offers no external server unless one of the host's tools is an external one: the owner's servers are not started
// for a client that cannot call them.
const NO_EXTERNAL_SERVERS = Object.freeze({ catalogGroups: () => [], status: () => null });

/** The client's id: its own name (clientInfo.name of the request), lower case, only a-z 0-9 . _ -, at most 64 characters; else "client". */
export function clientIdOf(client) {
  const name = client !== null && typeof client === 'object' && typeof client.name === 'string' ? client.name : '';
  const id = name.normalize('NFKC').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '').slice(0, 64).replace(/[-._]+$/, '');
  return id || 'client';
}

/** The task of a client on a workspace: a UUID (version 4 shape) drawn from both, so it is the same at every start of the Hub. */
export function hostTaskId(workspace, clientId) {
  const hex = createHash('sha256').update(`datgold-mcp-host\0${workspace}\0${clientId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[Number.parseInt(hex[16], 16) & 3]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A pending request of a client's gate as /api/state carries it: the gate's own item, with who asked (the dashboard shows the tag). */
export const tagPending = (item, clientId) => ({ ...item, source: 'mcp', client: clientId, tag: `mcp:${clientId}` });

const failure = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
/** A result that says nothing ran, in the shape of HubManager's refusals: the code first in the text, and in structuredContent. */
const refusal = (code, message, extra = {}) => ({ isError: true, content: [{ type: 'text', text: `${code}: ${message}` }], structuredContent: { error: { code, message, ...extra }, executed: false } });
const codeOf = (result) => result?.structuredContent?.error?.code ?? null;
const alias = (mode) => (mode === 'manual' ? 'review' : mode);

/**
 * Locks a client's gate to the modes of its scope and to host-review / sandbox-only: `mode` and `executionPolicy` become accessors that
 * refuse anything else (a plain assignment throws too), configure() refuses autonomous and Full Access before it changes anything, the
 * timeout is fixed, and the owner is the one who answers (interactive, never a background agent).
 */
function lockGate(gate, scope, timeout) {
  const modes = MODES_OF_SCOPE[scope];
  const refuse = (what) => {
    throw failure('mcp_host_mode_refused', `The permission gate of an MCP client in the ${scope} scope allows ${modes.join(' or ')} with host review only; ${what} is refused.`, 403);
  };
  let mode = scope === 'profiles' ? PROFILES_MODE : DEFAULT_MODE[scope];
  let policy = 'host-review';
  Object.defineProperty(gate, 'mode', {
    enumerable: true, configurable: false, get: () => mode,
    set: (value) => { const next = alias(value); if (!modes.includes(next)) refuse(`the mode ${JSON.stringify(String(value)).slice(0, 40)}`); mode = next; },
  });
  Object.defineProperty(gate, 'executionPolicy', {
    enumerable: true, configurable: false, get: () => policy,
    set: (value) => { if (!POLICIES.includes(value)) refuse(`the policy ${JSON.stringify(String(value)).slice(0, 40)}`); policy = value; },
  });
  Object.defineProperty(gate, 'timeout', { enumerable: true, configurable: false, writable: false, value: timeout });
  const configure = gate.configure.bind(gate);
  Object.defineProperty(gate, 'configure', {
    enumerable: false, configurable: false, writable: false,
    value: (patch = {}) => {
      // Full Access is the mode 'full-access' or the policy 'full-access': neither is in the lists below, so both are refused here.
      const { mode: nextMode, executionPolicy } = patch ?? {};
      if (nextMode !== undefined && !modes.includes(alias(nextMode))) refuse(`the mode ${JSON.stringify(String(nextMode)).slice(0, 40)}`);
      if (executionPolicy !== undefined && !POLICIES.includes(executionPolicy)) refuse(`the policy ${JSON.stringify(String(executionPolicy)).slice(0, 40)}`);
      return configure(patch);
    },
  });
  gate.interactive = true;
  gate.backgroundAgent = false;
}

let hubCatalog = null;
/**
 * The definitions of the Hub's own tools a host may serve, by their catalog name: every local tool (`local.<tool>`, read once from a
 * LocalTools on no workspace) and the Studio tools the local backend offers beside them (`studio.<tool>`, LOCAL_BACKEND_STUDIO_TOOLS of
 * lib/manager.mjs). Schemas, descriptions and annotations, as the Hub's agents see them.
 */
export function hubToolCatalog() {
  hubCatalog ??= new Map([
    ...new LocalTools({ workspace: { resolve: async () => { throw failure('workspace_missing', 'No workspace.'); } } }).definitions().map((definition) => [definition.name, definition]),
    ...STUDIO_TOOLS.filter((definition) => LOCAL_BACKEND_STUDIO_TOOLS.has(definition.originalName)).map((definition) => [definition.name, structuredClone(definition)]),
  ]);
  return hubCatalog;
}

/** Whether two annotations say the same about what a tool changes: readOnlyHint and destructiveHint (an absent hint is not the same as false). */
export const sameChangeHints = (a, b) => a?.readOnlyHint === b?.readOnlyHint && a?.destructiveHint === b?.destructiveHint;

/**
 * The host's tools, checked: a unique name of the MCP rule, a target that is a local tool of the Hub, a Studio tool the local backend
 * offers, or `<server>.<tool>` of an external server (with its own inputSchema). The annotations of the Hub's own tools are their
 * definitions' (an override that says something else about what the tool changes is refused); an outputSchema is the spec's.
 */
function normalizeHostTools(tools) {
  if (!Array.isArray(tools)) throw new TypeError('The MCP host needs an array of tools.');
  const byName = new Map();
  for (const spec of tools) {
    const name = spec?.name;
    if (typeof name !== 'string' || !TOOL_NAME.test(name) || RESERVED_NAMES.has(name)) throw new TypeError(`Invalid MCP host tool name: ${JSON.stringify(name)}.`);
    if (byName.has(name)) throw new TypeError(`The MCP host tool ${name} is listed twice.`);
    const target = typeof spec.target === 'string' ? spec.target : '';
    const own = target.startsWith('local.') || target.startsWith('studio.');
    let definition;
    if (own) {
      const local = hubToolCatalog().get(target);
      if (!local) throw new TypeError(target.startsWith('local.') ? `The MCP host tool ${name} names ${target}, which is no local tool of the Hub.`
        : `The MCP host tool ${name} needs a target that is a Studio tool the Hub offers beside its local tools, not ${JSON.stringify(target)}.`);
      if (spec.annotations !== undefined && !sameChangeHints(spec.annotations, local.annotations)) throw new TypeError(`The annotations of the MCP host tool ${name} differ from the definition of ${target}: a client must be told what the tool changes.`);
      definition = { name, title: spec.title, description: spec.description ?? local.description, inputSchema: structuredClone(spec.inputSchema ?? local.inputSchema), annotations: structuredClone(spec.annotations ?? local.annotations) };
    } else {
      const external = target.startsWith('studio.') ? null : externalToolName(target);
      if (!external?.server || !external.tool) throw new TypeError(`The MCP host tool ${name} needs a target that is local.<tool> or <server>.<tool> of an external server, not ${JSON.stringify(target)}.`);
      if (spec.inputSchema === null || typeof spec.inputSchema !== 'object' || spec.inputSchema.type !== 'object') throw new TypeError(`The MCP host tool ${name} (external ${target}) needs its own inputSchema of type object.`);
      definition = { name, title: spec.title, description: spec.description, inputSchema: structuredClone(spec.inputSchema), annotations: spec.annotations === undefined ? undefined : structuredClone(spec.annotations) };
    }
    if (spec.outputSchema !== undefined) definition.outputSchema = structuredClone(spec.outputSchema);
    byName.set(name, Object.freeze({ name, target, write: spec.write === true, external: !own, definition: Object.freeze(definition) }));
  }
  return byName;
}

export class McpHost {
  #tools;
  #slots = new Map(); // client id -> Promise of its slot (made once; a failed one is forgotten)
  #ready = new Map(); // client id -> its slot, once made
  #writer = null; // the slot whose write is under way
  #calls = new AsyncLocalStorage(); // the record of the call in progress, for the gate's events (#watch)
  #closed = false;
  #closing = null;

  /**
   * @param {object} options
   * @param {string} options.bundleRoot
   * @param {string} options.directory    where the managers keep their data (<data>/mcp-host)
   * @param {() => string | null} options.workspace   the Hub's workspace now
   * @param {() => ({busy: boolean} | Promise<{busy: boolean}>)} options.primaryState   whether the primary agent works in it (fails closed)
   * @param {object} [options.hooks]   the owner's HookRunner (the same instance as the Hub's)
   * @param {object} [options.mcp]     the owner's McpClientManager, used only when a tool of the host is external
   * @param {object} [options.pluginManager]
   * @param {string[]} [options.secrets]   the Hub's registered secrets (the same array)
   * @param {'verify'|'read'|'write'} [options.scope]
   * @param {object[]} [options.tools]   [{name, target, write?, title?, description?, inputSchema?, annotations?}]
   * @param {number} [options.timeout]   the approval timeout of a client's gate, in ms
   */
  constructor({ bundleRoot, directory, workspace, primaryState, hooks = null, mcp = null, pluginManager = null, secrets = [], scope = 'read', tools = HUB_HOST_TOOLS, timeout = DEFAULT_APPROVAL_TIMEOUT_MS, log = () => {} } = {}) {
    if (typeof bundleRoot !== 'string' || !bundleRoot || typeof directory !== 'string' || !directory) throw new TypeError('The MCP host needs bundleRoot and directory.');
    if (typeof workspace !== 'function' || typeof primaryState !== 'function') throw new TypeError('The MCP host needs workspace() and primaryState().');
    if (!MCP_HOST_SCOPES.includes(scope)) throw new TypeError(`Unknown MCP host scope ${JSON.stringify(scope)}: ${MCP_HOST_SCOPES.join(', ')}.`);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) throw new TypeError('The approval timeout of the MCP host must be 1 ms to 10 minutes.');
    this.bundleRoot = bundleRoot;
    this.directory = path.resolve(directory);
    this.workspace = workspace;
    this.primaryState = primaryState;
    this.hooks = hooks;
    this.mcp = mcp;
    this.pluginManager = pluginManager;
    this.secrets = Array.isArray(secrets) ? secrets : [];
    this.scope = scope;
    this.timeout = timeout;
    this.log = log;
    this.#tools = normalizeHostTools(tools);
  }

  /** The MCP definitions of the host's tools (createMcpServerFactory checks and orders them). No manager is made for a list. */
  tools() { return [...this.#tools.values()].map((spec) => spec.definition); }

  /**
   * A client's call: `client` is the clientInfo of its request (lib/mcp/server.mjs clientInfoOf). `stillAllowed`, when given, is asked
   * again once the owner has answered: a call the caller's scope no longer allows then does not run (mcp_scope_refused). Always a result;
   * never throws.
   */
  async call(name, args = {}, { signal, client = null, stillAllowed = null } = {}) {
    if (this.#closed) return refusal('mcp_host_closed', 'The DatGold MCP host has closed.');
    const spec = this.#tools.get(name);
    if (!spec) return refusal('unknown_tool', `The DatGold MCP host has no tool ${String(name).slice(0, 128)}.`);
    let slot;
    try { slot = await this.#slotFor(clientIdOf(client)); }
    catch (error) { return refusal(/^[a-z0-9_]{1,64}$/.test(String(error?.code ?? '')) ? error.code : 'mcp_host_unavailable', this.#clean(error)); }
    const record = { approvalId: null, expired: false, stillAllowed: typeof stillAllowed === 'function' ? stillAllowed : null };
    return this.#calls.run(record, () => this.#run(slot, spec, args, signal, record));
  }

  async #run(slot, spec, args, signal, record) {
    const definition = slot.session.catalog.tools.find((tool) => tool.name === spec.target);
    if (!definition) return refusal('unknown_tool', `${spec.name} is not available in this workspace now (${spec.target} is not in the catalog).`);
    // What tools/list told the client about what the tool changes must still be true of the definition that runs.
    if (!spec.external && !sameChangeHints(spec.definition.annotations, definition.annotations)) {
      return refusal('mcp_annotations_mismatch', `${spec.name} is refused: its definition in this workspace (${spec.target}) no longer matches the annotations the client was given. Nothing ran; list the tools again.`);
    }
    const verdict = await slot.gate.assess(spec.target, args, definition, { taskId: slot.taskId });
    // One of the Hub's own tools the client was told is read-only runs only as a read (a protected path stays the gate's refusal). A tool
    // of an external server is always `external` for the gate, which applies the owner's policy to it; what its spec says is the owner's.
    if (!spec.external && spec.definition.annotations?.readOnlyHint === true && verdict.category !== 'read' && verdict.category !== 'blocked') {
      return refusal('mcp_profile_refused', `${spec.name} is refused: it was offered as read-only, and this call is not a read (${verdict.category}). Nothing ran.`);
    }
    const write = spec.write || !NOT_WRITES.has(verdict.category);
    let release = () => {};
    if (write) {
      // Taken before anything is awaited, so two writes cannot both find the place free.
      if (this.#writer) return this.#busyResult({ holder: 'mcp_client', message: `Another MCP client's change (${this.#writer.tag}) is under way in this workspace; one writer at a time. Nothing was changed.` });
      this.#writer = slot;
      release = () => { if (this.#writer === slot) this.#writer = null; };
      const busy = await this.#outsideBusy(slot);
      if (busy) { release(); return this.#busyResult(busy); }
    }
    try {
      const result = await slot.session.callTool(spec.target, args, {
        signal,
        // Checked again once the gate has decided (an approval can come long after the question): the primary agent may have started since.
        onDecision: async ({ allowed }) => {
          if (!allowed) return;
          // The caller's scope may have changed while the owner was deciding: what it no longer allows does not run.
          if (record.stillAllowed && record.stillAllowed() !== true) throw Object.assign(new Error('scope'), { code: 'mcp_scope_refused' });
          if (!write) return;
          const busy = await this.#outsideBusy(slot);
          if (busy) throw Object.assign(new Error(busy.message), { code: 'workspace_busy', busy });
        },
      });
      if (record.expired && codeOf(result) === 'permission_denied') {
        return refusal('approval_timeout', `Nobody answered the approval request in DatGold within ${Math.round(slot.gate.timeout / 1000)} s, so it expired; nothing was changed. Ask the owner to approve it in the DatGold dashboard and call again.`);
      }
      return result;
    } catch (error) {
      if (error?.code === 'workspace_busy' && error.busy) return this.#busyResult(error.busy);
      if (error?.code === 'mcp_scope_refused') return refusal('mcp_scope_refused', `${spec.name} is refused: the scope of the client's token changed while the owner was deciding, and it no longer allows this tool. Nothing ran.`);
      if (signal?.aborted) return refusal('cancelled', 'The client cancelled the call.');
      if (this.#closed || slot.retired) return refusal('mcp_host_closed', 'The DatGold MCP host closed during the call.');
      return refusal('mcp_host_call_failed', this.#clean(error));
    } finally { release(); }
  }

  /** Why a write cannot start now apart from another MCP write: the primary agent works, or the workspace lock file is held. Fails closed. */
  async #outsideBusy(slot) {
    let primary;
    try { primary = await this.primaryState(); } catch { primary = { busy: true }; }
    if (primary?.busy !== false) return { holder: 'agent', message: 'The DatGold agent is working in this workspace; a change from an MCP client waits until it has finished. Nothing was changed.' };
    const lock = await new WorkspaceLock({ workspaceRoot: slot.workspace }).inspect().catch(() => ({ locked: true, info: null }));
    if (lock.locked) return { holder: 'workspace_lock', message: `The workspace is locked by another task${lock.info?.pid ? ` (process ${lock.info.pid})` : ''}. Nothing was changed.` };
    return null;
  }

  #busyResult({ holder, message }) { return refusal('workspace_busy', message, { holder }); }

  #clean(error) { return maskSecrets(String(error?.message ?? error ?? 'error'), this.secrets).slice(0, 500); }

  /** The gate's events of the call in progress: which request it asked, and whether that request expired (AsyncLocalStorage keeps the call apart from the others). */
  #watch(event) {
    const record = this.#calls.getStore();
    if (!record) return;
    if (event?.type === 'approval_requested') record.approvalId = event.id;
    else if (event?.type === 'approval_expired' && event.id === record.approvalId) record.expired = true;
  }

  async #slotFor(clientId) {
    const workspace = this.workspace();
    if (!workspace) throw failure('workspace_missing', 'No workspace is selected in DatGold; choose a project folder on the dashboard first.');
    const known = this.#slots.get(clientId);
    if (known) {
      const slot = await known;
      if (!slot.retired && slot.workspace === workspace) return slot;
      // The owner chose another workspace: the client's manager of the old one ends (a request it is still waiting for is cancelled).
      if (this.#slots.get(clientId) === known) { this.#slots.delete(clientId); this.#ready.delete(clientId); }
      void this.#stop(slot);
    }
    if (this.#closed) throw failure('mcp_host_closed', 'The DatGold MCP host has closed.');
    if (!this.#slots.has(clientId) && this.#slots.size >= MAX_CLIENTS) throw failure('mcp_client_limit', `The DatGold MCP host serves at most ${MAX_CLIENTS} clients at a time; this one (${clientId}) was refused.`, 429);
    if (!this.#slots.has(clientId)) {
      const making = this.#make(clientId, workspace);
      this.#slots.set(clientId, making);
      making.then((slot) => { if (this.#slots.get(clientId) === making) this.#ready.set(clientId, slot); }, () => { if (this.#slots.get(clientId) === making) this.#slots.delete(clientId); });
    }
    const slot = await this.#slots.get(clientId);
    this.#ready.set(clientId, slot);
    return slot;
  }

  async #make(clientId, workspace) {
    const taskId = hostTaskId(workspace, clientId);
    const tag = `mcp:${clientId}`;
    const dataDirectory = path.join(this.directory, createHash('sha256').update(workspace).digest('hex').slice(0, 16), taskId);
    const relay = (line) => this.log(`MCP host ${tag}: ${String(line).replace(/^\[CHATMCP-HUB\] /, '')}`);
    const manager = new HubManager({ bundleRoot: this.bundleRoot, dataDirectory, log: relay });
    manager.secrets = this.secrets;
    try {
      await manager.load(workspace);
      if (this.hooks) manager.hooks = this.hooks;
      manager.hooksProjectRoot = workspace;
      manager.mcp = this.mcp && [...this.#tools.values()].some((spec) => spec.external) ? this.mcp : NO_EXTERNAL_SERVERS;
      if (this.pluginManager) manager.pluginManager = this.pluginManager;
      assembleStudio(manager, { bundleRoot: this.bundleRoot });
      const gate = manager.permissions;
      await gate.load();
      lockGate(gate, this.scope, this.timeout);
      gate.subscribe((event) => this.#watch(event));
      await manager.startLocal(workspace);
      manager.acquireTask(taskId);
      const session = await manager.createAgentSession({});
      if (this.#closed) throw failure('mcp_host_closed', 'The DatGold MCP host has closed.');
      this.log(`MCP host: a manager for ${tag} (${this.scope} scope, ${gate.mode}) on the workspace, task ${taskId}.`);
      return { clientId, tag, taskId, workspace, manager, gate, session, retired: false };
    } catch (error) {
      await manager.shutdown().catch(() => {});
      throw error;
    }
  }

  async #stop(slot) {
    slot.retired = true;
    if (this.#writer === slot) this.#writer = null;
    slot.gate.shutdown();
    await slot.session.close().catch(() => {});
    slot.manager.releaseTask(slot.taskId);
    await slot.manager.shutdown().catch(() => {});
  }

  /** The approvals the clients wait for, for /api/state: each one the gate's own, tagged with the client. */
  pendingApprovals() {
    return [...this.#ready.values()].filter((slot) => !slot.retired)
      .flatMap((slot) => slot.gate.state().pending.map((item) => tagPending(item, slot.clientId)));
  }

  /** The dashboard's answer to one of them; null when no client's gate has it (the route then answers 404). */
  decide(id, approved) {
    for (const slot of this.#ready.values()) {
      if (!slot.retired && slot.gate.state().pending.some((item) => item.id === id)) return slot.gate.decide(id, approved);
    }
    return null;
  }

  /** The gate and the manager of a client that has called (tests, and the dashboard of ext-20). */
  gate(clientId) { return this.#ready.get(clientId)?.gate ?? null; }
  managerOf(clientId) { return this.#ready.get(clientId)?.manager ?? null; }

  state() {
    return {
      scope: this.scope, approvalTimeoutMs: this.timeout, maxClients: MAX_CLIENTS, closed: this.#closed, writer: this.#writer?.tag ?? null,
      tools: [...this.#tools.keys()],
      clients: [...this.#ready.values()].filter((slot) => !slot.retired).map((slot) => ({ client: slot.clientId, tag: slot.tag, taskId: slot.taskId, mode: slot.gate.mode, pending: slot.gate.state().pending.length })),
    };
  }

  /** Ends every client's manager: a request a client waits for is cancelled, and a later call is `mcp_host_closed`. */
  close() {
    this.#closed = true;
    this.#closing ??= (async () => {
      const making = [...this.#slots.values()];
      this.#slots.clear();
      this.#ready.clear();
      const slots = (await Promise.allSettled(making)).filter((outcome) => outcome.status === 'fulfilled').map((outcome) => outcome.value);
      await Promise.allSettled(slots.map((slot) => this.#stop(slot)));
      this.log('MCP host: closed.');
    })();
    return this.#closing;
  }
}

/**
 * ext-18's provider of the MCP server with the host: ext-17's hub_status, answered here, and every tool of the host to every token, answered
 * by host.call with the client of the request. Nothing in the product uses it since ext-19: hub.mjs serves mcpProfileProvider
 * (lib/mcp/tool-profiles.mjs), which lists and allows the tools of the token's scope. Kept for the ext-18 host tests
 * (tests/verify-mcp-server-approvals.mjs), which drive a host of their own in the verify, read and write scopes.
 */
export function mcpHostProvider({ host, version, product = 'DatGold' }) {
  const status = hubMcpProvider({ product, version, workspaceTools: host.tools().map((tool) => tool.name), scope: host.scope });
  return {
    tools: () => [...status.tools, ...host.tools()],
    call: (name, args, context) => (name === 'hub_status' ? status.call(name, args, context) : host.call(name, args, context)),
  };
}
