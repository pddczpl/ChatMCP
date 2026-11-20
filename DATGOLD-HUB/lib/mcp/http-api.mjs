// What the Hub's /api/mcp/* routes do (P2 slice D, plan task ext-14; docs/MCP-CLIENT.md "The screen and its routes"). hub.mjs answers the routes behind
// its usual layers (the bearer, and for a POST the page's Origin, marker and CSRF token) and hands the JSON body here; this module checks the body,
// calls the client manager (lib/mcp/client-manager.mjs) and its store (lib/mcp/server-config.mjs), and never changes their rules:
//
//   GET  /api/mcp/servers               servers(): every configured server as the UI may see it (publicServer: never a secret, in plain or protected
//                                       form), its connection state (status()), its tools with the owner's rule, the review state of its lists.
//   POST /api/mcp/server/upsert         {id, server}: add or replace one server (store.save). A policy left out keeps the stored one. The server's open
//                                       connection is closed, so the next connect uses what was saved.
//   POST /api/mcp/server/delete         {id}
//   POST /api/mcp/server/test           {id}: connect (an explicit connect is not held back by the preflight's back-off), or list a connected server
//                                       again; reports {ok, error, status}. It calls no tool.
//   POST /api/mcp/server/launch-record  {id}: the launch record the owner approves (command, args, cwd, env NAMES, executable, sha256, fingerprint).
//   POST /api/mcp/server/approve-launch {id, expectedFingerprint}: the fingerprint the owner was shown; {fingerprint} is not a key of this body.
//   POST /api/mcp/server/tool-review    {id}: the lists the owner approves, with the diff against the pin when they changed.
//   POST /api/mcp/server/approve-tools  {id, expectedFingerprint}
//   POST /api/mcp/server/tool-policy    {id, default?, tools?}: the owner's word to the permission gate, ask | allow | deny; null clears a rule.
//   POST /api/mcp/reload                {}: reads mcp-servers.json again and closes the open connections (they reopen at the next task or test).
//
// Every route that changes the servers, their approvals or their connections refuses while a task is active (409 mcp_task_active, `busy()`); the
// reads (GET, launch-record, tool-review) always answer. The writes run one at a time. A body with a key it does not know is refused
// (mcp_request_invalid), so a misspelt field never passes as "nothing to change".
import { isObject } from '../runtime.mjs';
import { MAX_SERVERS, POLICY_WORDS, SERVER_ID, policyWordFor } from './server-config.mjs';

export const MCP_LIST_ROUTE = '/api/mcp/servers';
export const MCP_POST_ROUTES = Object.freeze({
  upsert: '/api/mcp/server/upsert',
  delete: '/api/mcp/server/delete',
  test: '/api/mcp/server/test',
  launchRecord: '/api/mcp/server/launch-record',
  approveLaunch: '/api/mcp/server/approve-launch',
  toolReview: '/api/mcp/server/tool-review',
  approveTools: '/api/mcp/server/approve-tools',
  toolPolicy: '/api/mcp/server/tool-policy',
  reload: '/api/mcp/reload',
});
/** The longest description of a tool the list carries (the review route carries the whole sanitized one). */
export const TOOL_DESCRIPTION_CHARS = 600;
/** How many tool rules one tool-policy body may set. */
export const MAX_POLICY_CHANGES = 256;
const HINTS = Object.freeze(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);

const requestFault = (message) => Object.assign(new Error(message), { code: 'mcp_request_invalid', statusCode: 400 });
const unknownServer = (id) => Object.assign(new Error(`No MCP server "${id}" is configured.`), { code: 'mcp_server_unknown', statusCode: 404 });

/** The fields of a body: every key must be allowed, every required one present. */
function take(payload, allowed, required = allowed) {
  if (!isObject(payload)) throw requestFault('The body must be a JSON object.');
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) throw requestFault(`"${key.slice(0, 64)}" is not a field of this request (${allowed.join(', ') || 'none'}).`);
  for (const key of required) if (payload[key] === undefined) throw requestFault(`"${key}" is required.`);
  return payload;
}

function serverId(id) {
  if (typeof id !== 'string' || !SERVER_ID.test(id)) throw requestFault('"id" must be a server id: 1-32 characters of a-z, 0-9, _ and -, starting with a letter.');
  return id;
}

/** What a stored server becomes as input to store.save(): plain values as they are, each secret kept ({keep: true}); the secret itself is never read. */
export function inputOf(view) {
  const map = (entries) => Object.fromEntries(Object.entries(entries ?? {}).map(([name, entry]) => [name, entry.secret ? { keep: true } : entry.value]));
  const input = {
    transport: view.transport, enabled: view.enabled, timeouts: { ...view.timeouts }, policy: structuredClone(view.policy ?? {}),
    trust: { annotations: view.trust?.annotations === true }, touchesWorkspace: view.touchesWorkspace === true, env: map(view.env),
  };
  if (view.transport === 'stdio') Object.assign(input, { command: view.command, args: [...(view.args ?? [])], ...(view.cwd ? { cwd: view.cwd } : {}) });
  else Object.assign(input, { url: view.url, headers: map(view.headers) });
  return input;
}

/** One tool as the list shows it: its sanitized name, title, description (cut), the boolean hints the server gave, and the owner's rule. */
function toolView(tool, server) {
  const annotations = {};
  for (const hint of HINTS) if (typeof tool.annotations?.[hint] === 'boolean') annotations[hint] = tool.annotations[hint];
  const rule = isObject(server.policy?.tools) && Object.hasOwn(server.policy.tools, tool.name) ? server.policy.tools[tool.name] : null;
  return {
    name: tool.name, ...(typeof tool.title === 'string' && tool.title ? { title: tool.title } : {}),
    description: String(tool.description ?? '').slice(0, TOOL_DESCRIPTION_CHARS), annotations, rule, policy: policyWordFor(server, tool.name) ?? 'ask',
  };
}

export class McpHttpApi {
  /**
   * @param {object} options
   * @param {import('./client-manager.mjs').McpClientManager} options.mcp   the Hub's shared client manager (manager.mcp)
   * @param {() => boolean} [options.busy]        true while a task, a coding or dynamic worker or a delegate runs
   * @param {(text: string) => string} [options.mask]  the Hub's masker (registered secrets), for errors this module returns in a 200 answer
   */
  constructor({ mcp, busy = () => false, mask = (text) => text }) {
    if (!mcp?.store) throw new TypeError('McpHttpApi requires the client manager.');
    this.mcp = mcp;
    this.busy = busy;
    this.mask = mask;
    this.loadError = null;
    // id -> Promise<{required, approved, fingerprint}>: the launch check of a stdio server that has no connection, for the list. status() alone says
    // "approved" for any approval on file, even one of a record that changed since; this is the record as it is now. Dropped on every change.
    this.launches = new Map();
    this.writes = Promise.resolve();
  }

  #idle() {
    if (this.busy()) throw Object.assign(new Error('A task is running. Stop it or let it finish before changing the MCP servers.'), { code: 'mcp_task_active', statusCode: 409 });
  }

  /** One write at a time, each checked against an active task when its turn comes. */
  #write(operation) {
    const run = this.writes.then(() => { this.#idle(); return operation(); });
    this.writes = run.catch(() => {});
    return run;
  }

  async #loaded() {
    if (this.mcp.store.loaded) return;
    try { await this.mcp.reload(); this.loadError = null; }
    catch (error) { this.loadError = { code: error.code ?? 'mcp_config_invalid', message: this.mask(String(error.message ?? error)).slice(0, 500) }; throw error; }
  }

  #known(id) {
    if (!this.mcp.store.get(id)) throw unknownServer(id);
  }

  #launch(id) {
    if (!this.launches.has(id)) {
      const check = this.mcp.launchRecord(id).then(({ required, approved, fingerprint }) => ({ required, approved, fingerprint }), () => null);
      this.launches.set(id, check);
    }
    return this.launches.get(id);
  }

  /** GET /api/mcp/servers */
  async servers() {
    if (!this.mcp.store.loaded && !this.loadError) await this.#loaded().catch(() => {});
    const status = this.mcp.status();
    const byId = new Map(status.servers.map((entry) => [entry.id, entry]));
    const servers = [];
    for (const config of this.mcp.store.list()) {
      const state = byId.get(config.id) ?? null;
      if (state && config.transport === 'stdio' && config.enabled && !this.mcp.connections.has(config.id)) {
        const launch = await this.#launch(config.id);
        if (launch) state.launch = launch;
      }
      const review = this.mcp.toolReview(config.id);
      servers.push({ ...config, status: state, tools: review.tools.map((tool) => toolView(tool, config)), toolReview: { state: review.state, fingerprint: review.fingerprint, refused: review.refused } });
    }
    return { runtime: status.runtime, configLoaded: status.configLoaded, configError: this.loadError, closed: status.closed, maxServers: MAX_SERVERS, servers };
  }

  async #afterChange(ids) {
    for (const id of ids) { this.launches.delete(id); await this.mcp.disconnect(id); }
    // Read the file just written: the back-off of the changed server is cleared and the approvals are read again.
    await this.mcp.reload();
    this.loadError = null;
  }

  /** POST /api/mcp/server/upsert {id, server} */
  async upsert(payload) {
    const { id, server } = take(payload, ['id', 'server']);
    serverId(id);
    if (!isObject(server)) throw requestFault('"server" must be an object.');
    return this.#write(async () => {
      await this.#loaded();
      const previous = this.mcp.store.get(id);
      const input = { ...server };
      if (input.policy === undefined && previous) input.policy = previous.policy;
      const saved = await this.mcp.store.save(id, input);
      await this.#afterChange([id]);
      return { server: this.mcp.store.get(id) ?? saved, created: !previous };
    });
  }

  /** POST /api/mcp/server/delete {id} */
  async remove(payload) {
    const { id } = take(payload, ['id']);
    serverId(id);
    return this.#write(async () => {
      await this.#loaded();
      this.#known(id);
      await this.mcp.store.remove(id);
      await this.#afterChange([id]);
      return { deleted: true, id };
    });
  }

  /** POST /api/mcp/server/test {id}: connect and report; a connected server lists again (and is checked against its pin). No tool is called. */
  async test(payload) {
    const { id } = take(payload, ['id']);
    serverId(id);
    this.#idle();
    await this.#loaded();
    this.#known(id);
    let error = null;
    try {
      if (this.mcp.connections.get(id)?.state === 'connected') await this.mcp.listTools(id, { refresh: true });
      else await this.mcp.connect(id);
    } catch (failure) {
      error = { code: typeof failure?.code === 'string' && /^mcp_/.test(failure.code) ? failure.code : 'mcp_connect_failed', message: this.mask(String(failure?.message ?? failure)).slice(0, 500) };
    }
    this.launches.delete(id);
    const status = this.mcp.status().servers.find((entry) => entry.id === id) ?? null;
    return { ok: error === null, error, status };
  }

  /** POST /api/mcp/server/launch-record {id} */
  async launchRecord(payload) {
    const { id } = take(payload, ['id']);
    serverId(id);
    await this.#loaded();
    this.#known(id);
    return await this.mcp.launchRecord(id);
  }

  /** POST /api/mcp/server/approve-launch {id, expectedFingerprint} */
  async approveLaunch(payload) {
    const { id, expectedFingerprint } = take(payload, ['id', 'expectedFingerprint'], ['id']);
    serverId(id);
    return this.#write(async () => {
      await this.#loaded();
      this.#known(id);
      const answer = await this.mcp.approveLaunch(id, { expectedFingerprint });
      this.launches.delete(id);
      // A connection that was refused for want of this approval is only a record of that refusal: drop it, so the list shows the approval.
      if (this.mcp.connections.get(id)?.state === 'needs_launch_approval') await this.mcp.disconnect(id);
      return answer;
    });
  }

  /** POST /api/mcp/server/tool-review {id} */
  async toolReview(payload) {
    const { id } = take(payload, ['id']);
    serverId(id);
    await this.#loaded();
    this.#known(id);
    return this.mcp.toolReview(id);
  }

  /** POST /api/mcp/server/approve-tools {id, expectedFingerprint} */
  async approveTools(payload) {
    const { id, expectedFingerprint } = take(payload, ['id', 'expectedFingerprint'], ['id']);
    serverId(id);
    return this.#write(async () => {
      await this.#loaded();
      this.#known(id);
      return await this.mcp.approveTools(id, { expectedFingerprint });
    });
  }

  /**
   * POST /api/mcp/server/tool-policy {id, default?, tools?}: `default` is a word or null (no default: ask); `tools` maps a tool name to a word or null
   * (no rule). The rest of the server is saved as it is (its secrets kept). The gate reads the policy at each call, so no connection is closed.
   */
  async toolPolicy(payload) {
    const { id, default: fallback, tools } = take(payload, ['id', 'default', 'tools'], ['id']);
    serverId(id);
    if (fallback === undefined && tools === undefined) throw requestFault('Give "default", "tools" or both.');
    const word = (value, where) => {
      if (value !== null && !POLICY_WORDS.includes(value)) throw requestFault(`${where} must be "ask", "allow", "deny" or null.`);
      return value;
    };
    if (fallback !== undefined) word(fallback, '"default"');
    if (tools !== undefined) {
      if (!isObject(tools)) throw requestFault('"tools" must be an object of tool name -> "ask" | "allow" | "deny" | null.');
      const entries = Object.entries(tools);
      if (entries.length > MAX_POLICY_CHANGES) throw requestFault(`"tools" may change at most ${MAX_POLICY_CHANGES} rules at once.`);
      for (const [name, value] of entries) word(value, `"tools.${name.slice(0, 128)}"`);
    }
    return this.#write(async () => {
      await this.#loaded();
      const view = this.mcp.store.get(id);
      if (!view) throw unknownServer(id);
      const input = inputOf(view);
      const policy = input.policy;
      if (fallback === null) delete policy.default;
      else if (fallback !== undefined) policy.default = fallback;
      if (tools !== undefined) {
        policy.tools = { ...(policy.tools ?? {}) };
        for (const [name, value] of Object.entries(tools)) {
          if (value === null) delete policy.tools[name];
          else policy.tools[name] = value;
        }
      }
      const server = await this.mcp.store.save(id, input);
      return { server };
    });
  }

  /** POST /api/mcp/reload {} */
  async reload(payload) {
    take(payload, []);
    return this.#write(async () => {
      try { await this.mcp.reload(); }
      catch (error) { this.loadError = { code: error.code ?? 'mcp_config_invalid', message: this.mask(String(error.message ?? error)).slice(0, 500) }; throw error; }
      this.loadError = null;
      this.launches.clear();
      for (const id of [...this.mcp.connections.keys()]) await this.mcp.disconnect(id);
      return await this.servers();
    });
  }
}
