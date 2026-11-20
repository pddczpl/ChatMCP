// Connections from the Hub to the owner's external MCP servers (docs/MCP-CLIENT.md), on the v2 client SDK (lib/mcp/sdk.mjs).
//
// THIS SLICE OFFERS NOTHING TO THE MODEL. No agent, catalog, permission gate or route calls this module yet; a later slice puts the tools
// behind the permission gate. The public surface below is what those slices will use:
//
//   const mcp = new McpClientManager({hubDirectory, bundleRoot, protector, registerSecret, secrets, log});
//   await mcp.connect(serverId, {signal})        spawn or open, negotiate, list the tools; 30 s deadline (timeouts.connectMs); pooled
//   await mcp.listTools(serverId, {signal})      the tools of the connection, re-listed on request ({refresh: true})
//   await mcp.listPrompts / listResources(serverId, {signal})
//   await mcp.callTool(serverId, name, args, {signal, timeoutMs})   one tools/call, never repeated
//   mcp.status()                                 runtime and per-server state; no secret, no command line, no header
//   await mcp.disconnect(serverId) / await mcp.close()
//
// Lifecycle. One connection per server per manager (the Hub's manager owns one; lib/assemble.mjs). connect() is lazy and shared by callers
// that arrive while it runs. A stdio server runs in its own process tree: closing ends its stdin, waits a moment, then stops the tree the
// way the Hub stops every child it owns (stopOwned in lib/runtime.mjs: taskkill /T /F on Windows, the process group on POSIX), and waits
// for the process to exit before close() resolves (Node aborts on a libuv assertion when it exits right after killing a child).
//
// Environment of a stdio server: the SDK's own allow-list of inherited variables (PATH, SYSTEMROOT, APPDATA ... on Windows; HOME, PATH,
// SHELL ... elsewhere), scrubbed again by scrubEnv (lib/shell-runner.mjs) of credential-looking names and of values equal to a registered
// secret, plus the server's own env map (lib/mcp/server-config.mjs). Nothing else of the Hub's environment reaches it.
//
// Protocol posture. The SDK negotiates the version ('auto': a server/discover probe, falling back to initialize); a stdio server that dies
// on the probe is started again once with the plain 2025 handshake. The client declares NO capability (no roots, sampling, elicitation or
// logging) and answers no server request; an `input_required` result is an error (autoFulfill: false), so a call is never re-sent with
// answers. There is no HTTP+SSE fallback. A result with a resultType this SDK does not know is treated as complete (the SDK itself
// refuses one on 2026-07-28 connections). Lists are walked page by page here, not by the SDK: a repeated cursor or more than 1,000 pages
// is an error, never a partial list, and an empty, too long or duplicate name refuses the whole list.
//
// A call that times out or loses its response is reported as such (`executed: 'unknown'`) and is never sent again: the server may have
// run it. On HTTP the transport does not resume a broken response stream (reconnectionOptions.maxRetries = 0).
import path from 'node:path';
import { fingerprint } from '../catalog.mjs';
import { delay, isObject, redact, stopOwned } from '../runtime.mjs';
import { scrubEnv } from '../shell-runner.mjs';
import { defaultRuntimeRoots, loadMcpSdk, locateMcpRuntime } from './sdk.mjs';
import { McpServerStore } from './server-config.mjs';

export const MAX_LIST_PAGES = 1000;
export const MAX_NAME_LENGTH = 128;
export const PROBE_TIMEOUT_MS = 10_000;
export const CLOSE_GRACE_MS = 2000;
export const EXIT_WAIT_MS = 10_000;
export const DRAIN_WAIT_MS = 1000;
export const MAX_STDERR_LINES = 200;
export const KNOWN_RESULT_TYPES = Object.freeze(['complete', 'input_required']);
const MIN_CALL_TIMEOUT_MS = 1000;
const MAX_CALL_TIMEOUT_MS = 900_000;
const LISTS = Object.freeze({
  tools: { method: 'tools/list', field: 'tools', capability: 'tools', identity: (item) => item?.name },
  prompts: { method: 'prompts/list', field: 'prompts', capability: 'prompts', identity: (item) => item?.name },
  resources: { method: 'resources/list', field: 'resources', capability: 'resources', identity: (item) => item?.uri },
});
const WRAPPED = Symbol('datgold.mcp.wrapped');

const fault = (code, message, extra = {}) => Object.assign(new Error(message), { code, statusCode: 502, ...extra });

/** A JSON-RPC result whose resultType is a string this client does not know, re-labelled complete; anything else unchanged. */
export function normalizeResultType(message, onUnknown = () => {}) {
  if (!isObject(message) || !isObject(message.result)) return message;
  const kind = message.result.resultType;
  if (typeof kind !== 'string' || KNOWN_RESULT_TYPES.includes(kind)) return message;
  onUnknown(kind);
  return { ...message, result: { ...message.result, resultType: 'complete' } };
}

/** Routes every message the transport delivers through normalizeResultType, whoever sets the handler (the SDK sets it more than once). */
export function interceptMessages(transport, onUnknown) {
  let handler;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => handler,
    set: (value) => {
      if (typeof value !== 'function' || value[WRAPPED]) { handler = value; return; }
      const wrapped = (message, extra) => value(normalizeResultType(message, onUnknown), extra);
      wrapped[WRAPPED] = true;
      handler = wrapped;
    },
  });
  return transport;
}

/** Walks one list method page by page. A repeated or malformed cursor, more than `maxPages` pages, or a bad name is an error. */
export async function listAll(request, kind, { signal, timeout, maxPages = MAX_LIST_PAGES } = {}) {
  const spec = LISTS[kind];
  if (!spec) throw new TypeError(`unknown list ${kind}`);
  const items = [];
  const seen = new Set();
  let cursor;
  let pages = 0;
  do {
    signal?.throwIfAborted();
    if (pages >= maxPages) throw fault('mcp_list_too_many_pages', `${spec.method} did not end after ${maxPages} pages; the list is refused rather than cut short.`);
    pages += 1;
    const page = await request({ method: spec.method, params: cursor === undefined ? {} : { cursor } }, { signal, timeout });
    if (!isObject(page) || !Array.isArray(page[spec.field])) throw fault('mcp_list_invalid', `${spec.method} did not return a list of ${spec.field}.`);
    items.push(...page[spec.field]);
    cursor = page.nextCursor ?? undefined;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || !cursor) throw fault('mcp_list_cursor_invalid', `${spec.method} returned a cursor that is not a non-empty string.`);
      if (seen.has(cursor)) throw fault('mcp_list_cursor_repeated', `${spec.method} returned a cursor it had returned before; the list is refused rather than read in a loop.`);
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  const names = new Set();
  for (const item of items) {
    const name = spec.identity(item);
    if (typeof name !== 'string' || !name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
      throw fault('mcp_list_invalid_name', `${spec.method} returned an entry whose ${kind === 'resources' ? 'uri' : 'name'} is empty, longer than ${MAX_NAME_LENGTH} characters or holds control characters.`);
    }
    if (names.has(name)) throw fault('mcp_list_duplicate_name', `${spec.method} returned "${name.slice(0, 80)}" twice.`);
    names.add(name);
  }
  return { items, pages };
}

/**
 * The stdio transport of the Hub: the SDK's wire format (ReadBuffer, serializeMessage) on a child the Hub owns, so that closing stops the
 * whole tree and waits for its exit. It exposes `pid` and `stderr` like the SDK's StdioClientTransport, which is how the SDK recognises a
 * stdio transport (a silent probe then falls back to initialize); as a class of its own it is probed in place, on the one child.
 */
export class ManagedStdioTransport {
  onclose;
  onerror;
  onmessage;
  #sdk;
  #params;
  #child = null;
  #buffer;
  #exited = null;
  #drained = null;
  #closing = null;
  #closeFired = false;
  #group = process.platform !== 'win32';

  constructor(sdk, { command, args = [], cwd, env, onStderrLine = () => {} }) {
    this.#sdk = sdk;
    this.#params = { command, args, cwd, env, onStderrLine };
    this.#buffer = new sdk.ReadBuffer();
  }

  get pid() { return this.#child?.pid ?? null; }
  get stderr() { return null; }
  /** True once the child has exited (close() resolves only then). */
  get exited() { return Boolean(this.#child) && (this.#child.exitCode !== null || this.#child.signalCode !== null); }

  start() {
    if (this.#child) return Promise.reject(new Error('This stdio transport has already been started.'));
    const { command, args, cwd, env, onStderrLine } = this.#params;
    return new Promise((resolve, reject) => {
      let child;
      try {
        // detached on POSIX only: the child leads a process group of its own, so stopOwned({group: true}) stops what it started too. On
        // Windows a detached child would get a console window; taskkill /T covers the tree there.
        child = this.#sdk.spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: this.#group });
      } catch (error) { reject(error); return; }
      this.#child = child;
      let spawned = false;
      this.#exited = new Promise((done) => {
        child.once('exit', () => done());
        child.once('error', () => { if (!spawned) done(); });
      });
      // 'close' comes after the pipes are drained, so the last answer a server wrote before exiting is still read. A grandchild that keeps
      // the pipes open would hold it back for ever, so close() waits for it a short while only.
      this.#drained = new Promise((done) => child.once('close', () => done()));
      child.once('spawn', () => { spawned = true; resolve(); });
      child.once('error', (error) => { if (!spawned) reject(error); else this.onerror?.(error); });
      child.once('exit', () => { void this.close(); });
      child.stdin.on('error', (error) => this.onerror?.(error));
      child.stdout.on('error', (error) => this.onerror?.(error));
      child.stdout.on('data', (chunk) => {
        try { this.#buffer.append(chunk); }
        catch (error) { this.onerror?.(error); void this.close(); return; }
        for (;;) {
          let message;
          try { message = this.#buffer.readMessage(); }
          catch (error) { this.onerror?.(error); continue; }
          if (message === null) break;
          this.onmessage?.(message);
        }
      });
      let pending = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('error', () => {});
      child.stderr.on('data', (text) => {
        pending = (pending + text).slice(-65_536);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) if (line.trim()) onStderrLine(line);
      });
    });
  }

  send(message) {
    return new Promise((resolve, reject) => {
      const stdin = this.#child?.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded || this.#closing) {
        reject(new this.#sdk.SdkError(this.#sdk.SdkErrorCode.NotConnected, 'Not connected'));
        return;
      }
      if (stdin.write(this.#sdk.serializeMessage(message))) resolve();
      else stdin.once('drain', resolve);
    });
  }

  /** Ends stdin, waits CLOSE_GRACE_MS for the server to leave, stops its tree, and resolves only once the child has exited. Idempotent. */
  close() {
    if (!this.#closing) this.#closing = this.#close();
    return this.#closing;
  }

  async #close() {
    const child = this.#child;
    if (child?.pid) {
      const running = () => child.exitCode === null && child.signalCode === null;
      if (running()) {
        try { child.stdin.end(); } catch { /* already closed */ }
        await Promise.race([this.#exited, delay(CLOSE_GRACE_MS)]);
      }
      if (running()) await stopOwned(child, { group: this.#group }).catch((error) => this.onerror?.(error));
      else if (this.#group) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already empty */ } }
      const exited = await Promise.race([this.#exited.then(() => true), delay(EXIT_WAIT_MS).then(() => false)]);
      if (!exited) this.onerror?.(new Error(`The MCP server process ${child.pid} did not exit after it was stopped.`));
      await Promise.race([this.#drained, delay(DRAIN_WAIT_MS)]);
      for (const stream of [child.stdin, child.stdout, child.stderr]) { try { stream?.destroy(); } catch { /* gone */ } }
    }
    this.#buffer.clear?.();
    if (!this.#closeFired) { this.#closeFired = true; this.onclose?.(); }
  }
}

class Connection {
  constructor(id, transport) {
    this.id = id;
    this.transport = transport;
    this.state = 'connecting';
    this.opening = null;
    this.client = null;
    this.channel = null;
    this.timeouts = null;
    this.protocolVersion = null;
    this.era = null;
    this.serverInfo = null;
    this.capabilities = null;
    this.tools = new Map();
    this.toolCount = null;
    this.fingerprint = null;
    this.connectedAt = null;
    this.lastError = null;
    this.calls = 0;
    this.attempts = 0;
    this.unknownResultTypes = 0;
    this.stderrLines = 0;
    this.secrets = [];
  }

  /** What status() and connect() return: nothing configured (no command, argument, url or header), nothing secret. */
  summary() {
    return {
      id: this.id,
      transport: this.transport,
      state: this.state,
      protocolVersion: this.protocolVersion,
      era: this.era,
      server: this.serverInfo ? { name: String(this.serverInfo.name ?? '').slice(0, 200), version: String(this.serverInfo.version ?? '').slice(0, 100) } : null,
      tools: this.toolCount,
      fingerprint: this.fingerprint,
      connectedAt: this.connectedAt,
      calls: this.calls,
      unknownResultTypes: this.unknownResultTypes,
      lastError: this.lastError ? { ...this.lastError } : null,
    };
  }
}

export class McpClientManager {
  /**
   * @param {object} options
   * @param {string} options.hubDirectory     where mcp-servers.json lives
   * @param {string} [options.bundleRoot]     the Hub folder (DATGOLD-HUB), for the installed SDK
   * @param {object} [options.protector]      createProtector() of lib/secret-box.mjs
   * @param {(value: string) => void} [options.registerSecret]   HubManager.registerSecret: the masker hides these values
   * @param {() => string[]} [options.secrets] the secrets the masker knows (for scrubEnv and the log)
   * @param {(line: string) => void} [options.log]
   * @param {string[]} [options.runtimeRoots] where the SDK is looked for (defaultRuntimeRoots)
   * @param {object} [options.env]            the Hub's environment (process.env)
   */
  constructor({ hubDirectory, bundleRoot, protector = null, registerSecret = () => {}, secrets = () => [], log = () => {}, runtimeRoots = null, env = process.env, platform = process.platform, clientInfo = { name: 'DatGold', version: '0.0.0' }, store = null } = {}) {
    if (!hubDirectory && !store) throw new TypeError('McpClientManager requires hubDirectory.');
    this.roots = runtimeRoots ?? defaultRuntimeRoots(bundleRoot ? path.resolve(bundleRoot) : undefined, env);
    this.env = env;
    this.platform = platform;
    this.clientInfo = { name: String(clientInfo.name), version: String(clientInfo.version) };
    this.secrets = secrets;
    this.output = log;
    this.store = store ?? new McpServerStore({ hubDirectory, protector, registerSecret });
    this.runtime = locateMcpRuntime(this.roots);
    this.connections = new Map();
    this.disposals = new Set();
    this.closed = false;
    this.closing = null;
  }

  log(line, connection = null) {
    const clean = redact(line, [...(this.secrets() ?? []), ...(connection?.secrets ?? [])]);
    if (clean.trim()) this.output(clean);
  }

  #assertOpen() {
    if (this.closed) throw fault('mcp_closed', 'The MCP client manager has been closed.', { statusCode: 409 });
  }

  /** The runtime, and every configured server with its connection state. Contains no secret and nothing the owner typed except ids. */
  status() {
    if (this.runtime.state !== 'ready') this.runtime = locateMcpRuntime(this.roots);
    const runtime = this.runtime.state === 'ready' ? { state: 'ready', version: this.runtime.version } : { state: this.runtime.state, code: this.runtime.code };
    const servers = this.store.loaded ? this.store.list().map((server) => {
      const connection = this.connections.get(server.id);
      return { ...(connection ? connection.summary() : { id: server.id, transport: server.transport, state: 'idle', protocolVersion: null, era: null, server: null, tools: null, fingerprint: null, connectedAt: null, calls: 0, unknownResultTypes: 0, lastError: null }), enabled: server.enabled };
    }) : [];
    return { runtime, configLoaded: this.store.loaded, closed: this.closed, servers };
  }

  /** Reads mcp-servers.json again. Connections that are open keep running with the configuration they were opened with. */
  async reload() { return await this.store.load(); }

  /**
   * Opens the connection to one server if it is not open (spawn or HTTP, version negotiation, the first tools/list), within its connect
   * deadline (timeouts.connectMs, 30 s by default). Callers that arrive while it is opening share the attempt; `signal` stops the waiting of
   * this caller only.
   */
  async connect(serverId, { signal } = {}) {
    this.#assertOpen();
    signal?.throwIfAborted();
    let connection = this.connections.get(serverId);
    if (!connection || !['connected', 'connecting'].includes(connection.state)) {
      const config = await this.store.resolveForConnect(serverId, { parentEnv: this.env, platform: this.platform });
      this.#assertOpen();
      connection = this.connections.get(serverId);
      if (!connection || !['connected', 'connecting'].includes(connection.state)) {
        const previous = connection;
        connection = new Connection(serverId, config.transport);
        connection.calls = previous?.calls ?? 0;
        connection.secrets = config.secrets;
        connection.timeouts = config.timeouts;
        this.connections.set(serverId, connection);
        connection.opening = this.#open(connection, config).finally(() => { connection.opening = null; });
        connection.opening.catch(() => {});
      }
    }
    if (connection.opening) await raceSignal(connection.opening, signal);
    if (connection.state !== 'connected') throw fault(connection.lastError?.code ?? 'mcp_connect_failed', connection.lastError?.message ?? `The MCP server "${serverId}" is not connected.`);
    return connection.summary();
  }

  async #open(connection, config) {
    let sdk;
    try {
      sdk = await loadMcpSdk({ roots: this.roots });
      connection.sdk = sdk;
      this.runtime = locateMcpRuntime(this.roots);
    } catch (error) {
      this.runtime = locateMcpRuntime(this.roots);
      return this.#failed(connection, error);
    }
    const started = Date.now();
    const limit = config.timeouts.connectMs;
    const remaining = () => limit - (Date.now() - started);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(fault('mcp_connect_timeout', `The MCP server "${connection.id}" did not connect within ${limit} ms.`)), limit);
    this.#closeAll ??= new AbortController();
    const signal = AbortSignal.any([deadline.signal, this.#closeAll.signal]);
    try {
      let mode = 'auto';
      for (;;) {
        connection.attempts += 1;
        const { client, channel } = this.#createClient(sdk, connection, config, mode);
        connection.client = client;
        connection.channel = channel;
        try {
          await raceSignal(client.connect(channel, { timeout: Math.max(1, remaining()), signal }), signal);
          break;
        } catch (error) {
          await this.#dispose(connection);
          // A stdio server built on an SDK that exits on any request before `initialize` dies on the server/discover probe: it is started
          // once more with the plain 2025 handshake. Nothing was called yet, so nothing is repeated.
          if (mode === 'auto' && config.transport === 'stdio' && error?.code === sdk.SdkErrorCode.EraNegotiationFailed && remaining() > 2000 && !signal.aborted) {
            this.log(`MCP ${connection.id}: the server closed the connection on the version probe; starting it again with the 2025 handshake.`, connection);
            mode = 'legacy';
            continue;
          }
          throw signal.aborted ? signal.reason : error;
        }
      }
      const client = connection.client;
      connection.protocolVersion = client.getNegotiatedProtocolVersion() ?? null;
      connection.era = client.getProtocolEra?.() ?? null;
      connection.serverInfo = client.getServerVersion() ?? null;
      connection.capabilities = client.getServerCapabilities() ?? {};
      await this.#listTools(connection, { signal, timeout: Math.max(1, remaining()) });
      signal.throwIfAborted();
      connection.state = 'connected';
      connection.connectedAt = new Date().toISOString();
      connection.lastError = null;
      client.onclose = () => {
        if (connection.state !== 'connected') return;
        connection.state = 'lost';
        connection.lastError = { code: 'mcp_connection_lost', message: 'The connection to the server was lost.' };
        this.log(`MCP ${connection.id}: the connection was lost.`, connection);
        this.#background(this.#dispose(connection));
      };
      this.log(`MCP ${connection.id}: connected (${config.transport}, protocol ${connection.protocolVersion ?? 'unknown'}, ${connection.toolCount} tools).`, connection);
    } catch (error) {
      await this.#dispose(connection);
      return this.#failed(connection, signal.aborted ? signal.reason : error);
    } finally {
      clearTimeout(timer);
    }
  }

  #closeAll = null;

  #failed(connection, error) {
    connection.state = 'failed';
    const message = redact(String(error?.message ?? error ?? 'The connection failed.'), [...(this.secrets() ?? []), ...connection.secrets]).slice(0, 500);
    connection.lastError = { code: typeof error?.code === 'string' && /^mcp_/.test(error.code) ? error.code : 'mcp_connect_failed', message };
    this.log(`MCP ${connection.id}: could not connect (${connection.lastError.code}): ${message}`, connection);
  }

  #createClient(sdk, connection, config, mode) {
    const client = new sdk.Client(this.clientInfo, {
      capabilities: {},
      versionNegotiation: mode === 'auto' ? { mode: 'auto', probe: { timeoutMs: Math.min(PROBE_TIMEOUT_MS, config.timeouts.connectMs) } } : { mode: 'legacy' },
      inputRequired: { autoFulfill: false },
      listMaxPages: MAX_LIST_PAGES,
    });
    let errors = 0;
    client.onerror = (error) => {
      errors += 1;
      if (errors <= 5) this.log(`MCP ${connection.id}: ${String(error?.message ?? error).slice(0, 300)}`, connection);
    };
    const channel = config.transport === 'stdio'
      ? new ManagedStdioTransport(sdk, {
        command: config.command, args: config.args, cwd: config.cwd, env: this.#childEnvironment(sdk, config),
        onStderrLine: (line) => {
          connection.stderrLines += 1;
          if (connection.stderrLines <= MAX_STDERR_LINES) this.log(`MCP ${connection.id} (stderr): ${line.slice(0, 500)}`, connection);
          else if (connection.stderrLines === MAX_STDERR_LINES + 1) this.log(`MCP ${connection.id}: further stderr lines are not logged.`, connection);
        },
      })
      : new sdk.StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: { ...config.headers } },
        redirectPolicy: 'same-origin',
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      });
    interceptMessages(channel, (kind) => {
      connection.unknownResultTypes += 1;
      if (connection.unknownResultTypes === 1) this.log(`MCP ${connection.id}: a result of the unknown type "${String(kind).slice(0, 60)}" was treated as complete.`, connection);
    });
    return { client, channel };
  }

  /** The SDK's allow-list of inherited variables, scrubbed, plus the server's own env map (which wins, without regard to case on Windows). */
  #childEnvironment(sdk, config) {
    const inherited = {};
    const keys = Object.keys(this.env);
    for (const name of sdk.inheritedEnvironment) {
      const key = this.platform === 'win32' ? keys.find((candidate) => candidate.toUpperCase() === name.toUpperCase()) : name;
      const value = key === undefined ? undefined : this.env[key];
      if (typeof value === 'string' && !value.startsWith('()')) inherited[key] = value;
    }
    const environment = scrubEnv(inherited, { secrets: [...(this.secrets() ?? []), ...config.secrets] });
    for (const name of Object.keys(config.env)) {
      for (const key of Object.keys(environment)) if (key !== name && this.platform === 'win32' && key.toUpperCase() === name.toUpperCase()) delete environment[key];
      environment[name] = config.env[name];
    }
    return environment;
  }

  async #listTools(connection, { signal, timeout }) {
    const tools = await this.#list(connection, 'tools', { signal, timeout });
    connection.tools = new Map(tools.map((tool) => [tool.name, tool]));
    connection.toolCount = tools.length;
    connection.fingerprint = fingerprint(tools);
    return tools;
  }

  async #list(connection, kind, { signal, timeout }) {
    if (!connection.capabilities?.[LISTS[kind].capability]) return [];
    const { items } = await listAll((request, options) => connection.client.request(request, options), kind, { signal, timeout });
    // The SDK drops, on a 2026-07-28 Streamable HTTP connection, the tools whose x-mcp-header declarations break the spec (a MUST), but only
    // in its own aggregated listTools(); this walk calls the same check so that the two agree.
    if (kind === 'tools' && typeof connection.client._excludeInvalidXMcpHeaderTools === 'function') {
      const page = { tools: items };
      connection.client._excludeInvalidXMcpHeaderTools(page);
      return structuredClone(page.tools);
    }
    return structuredClone(items);
  }

  /** The connection, opened when it is not (a later call is a new call; a lost one is never repeated). */
  async #ready(serverId, signal) {
    const current = this.connections.get(serverId);
    if (current?.state === 'connected') return current;
    await this.connect(serverId, { signal });
    return this.connections.get(serverId);
  }

  async listTools(serverId, { signal, refresh = false } = {}) {
    this.#assertOpen();
    const connection = await this.#ready(serverId, signal);
    if (refresh) await this.#listTools(connection, { signal, timeout: connection.timeouts.connectMs });
    return [...connection.tools.values()].map((tool) => structuredClone(tool));
  }

  async listPrompts(serverId, { signal } = {}) {
    this.#assertOpen();
    const connection = await this.#ready(serverId, signal);
    return await this.#list(connection, 'prompts', { signal, timeout: connection.timeouts.connectMs });
  }

  async listResources(serverId, { signal } = {}) {
    this.#assertOpen();
    const connection = await this.#ready(serverId, signal);
    return await this.#list(connection, 'resources', { signal, timeout: connection.timeouts.connectMs });
  }

  /**
   * One tools/call. The timeout (timeoutMs, else the server's timeouts.callMs) covers the whole call, progress included; when it passes the SDK
   * sends notifications/cancelled and this rejects with `mcp_call_timeout`. Nothing is ever sent twice.
   */
  async callTool(serverId, name, args = {}, { signal, timeoutMs } = {}) {
    this.#assertOpen();
    const connection = await this.#ready(serverId, signal);
    const tool = connection.tools.get(name);
    if (!tool) throw fault('mcp_tool_unknown', `The MCP server "${serverId}" has no tool "${String(name).slice(0, 128)}".`, { statusCode: 404 });
    if (!isObject(args)) throw fault('mcp_arguments_invalid', 'The arguments of an MCP tool call must be an object.', { statusCode: 400 });
    const requested = Number.isFinite(timeoutMs) ? timeoutMs : connection.timeouts.callMs;
    const limit = Math.min(MAX_CALL_TIMEOUT_MS, Math.max(MIN_CALL_TIMEOUT_MS, Math.trunc(requested)));
    connection.calls += 1;
    try {
      return await connection.client.callTool({ name, arguments: args }, { signal, timeout: limit, maxTotalTimeout: limit, resetTimeoutOnProgress: false, toolDefinition: tool });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const code = error?.code;
      const codes = connection.sdk.SdkErrorCode;
      if (code === codes.RequestTimeout) throw fault('mcp_call_timeout', `The MCP tool ${serverId}/${name} did not answer within ${limit} ms. The call was cancelled and is not repeated; the server may still have run it.`, { executed: 'unknown' });
      // fetch rejects with a TypeError that carries the network cause (UND_ERR_SOCKET ...) when an HTTP answer is cut off.
      const networkFailure = connection.transport === 'http' && error?.name === 'TypeError' && error?.cause !== undefined;
      if (code === codes.ConnectionClosed || code === codes.NotConnected || code === codes.SendFailed || networkFailure || connection.state !== 'connected') {
        throw fault('mcp_connection_lost', `The connection to the MCP server "${serverId}" was lost during the call to ${name}. The call is not repeated; the server may have run it.`, { executed: 'unknown' });
      }
      const message = redact(String(error?.message ?? error), [...(this.secrets() ?? []), ...connection.secrets]).slice(0, 1000);
      throw fault('mcp_call_failed', `The MCP tool ${serverId}/${name} failed: ${message}`, { executed: 'unknown', ...(Number.isInteger(code) ? { protocolCode: code } : {}) });
    }
  }

  /** Remembers a disposal that runs on its own (a lost connection), so that close() waits for it too. */
  #background(promise) {
    this.disposals.add(promise);
    promise.finally(() => this.disposals.delete(promise)).catch(() => {});
  }

  async #dispose(connection) {
    const { client, channel } = connection;
    connection.client = null;
    connection.channel = null;
    if (channel && typeof channel.terminateSession === 'function' && channel.sessionId) {
      await Promise.race([channel.terminateSession().catch(() => {}), delay(1500)]);
    }
    await client?.close().catch(() => {});
    await channel?.close?.().catch(() => {});
  }

  /** Closes the connection to one server (and waits for its process to exit). */
  async disconnect(serverId) {
    const connection = this.connections.get(serverId);
    if (!connection) return false;
    if (connection.opening) await connection.opening.catch(() => {});
    connection.state = 'closed';
    await this.#dispose(connection);
    this.connections.delete(serverId);
    return true;
  }

  /** Closes every connection and waits until each stdio server has exited. Later calls are refused. */
  close() {
    if (!this.closing) {
      this.closed = true;
      this.#closeAll ??= new AbortController();
      this.#closeAll.abort(fault('mcp_closed', 'The MCP client manager is closing.'));
      this.closing = Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)))
        .then(() => Promise.allSettled([...this.disposals]))
        .then(() => undefined);
    }
    return this.closing;
  }
}

/** Waits for `promise`, or rejects as soon as `signal` aborts (the promise itself goes on). */
function raceSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); }, (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}
