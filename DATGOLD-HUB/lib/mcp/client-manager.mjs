// Connections from the Hub to the owner's external MCP servers (docs/MCP-CLIENT.md), on the v2 client SDK (lib/mcp/sdk.mjs).
//
// HubManager (lib/manager.mjs) offers the tools of the servers the owner approved to the agent, behind the permission gate (docs/MCP-CLIENT.md
// "The seam"). The public surface:
//
//   const mcp = new McpClientManager({hubDirectory, bundleRoot, protector, registerSecret, secrets, log});
//   await mcp.connect(serverId, {signal})        spawn or open, negotiate, list and pin-check; 30 s deadline (timeouts.connectMs); pooled
//   await mcp.prepare({signal})                  task preflight: connect every enabled server that may start, re-list the connected ones
//   mcp.catalogGroups()                          what the catalog may offer: connected servers whose lists match the approved pin
//   await mcp.listTools(serverId, {signal, refresh}) / listPrompts / listResources   the sanitized lists (re-listed with refresh: true)
//   await mcp.callTool(serverId, name, args, {signal, timeoutMs})   one tools/call, never repeated; the result bounded by limitToolResult
//   await mcp.getPrompt(serverId, name, args, {signal}) / readResource(serverId, uri, {signal})
//   mcp.status()                                 runtime and per-server state; no secret, no command line, no header
//   await mcp.disconnect(serverId) / await mcp.close()
//
// The owner's approvals (docs/MCP-HARDENING.md "Wired into the client manager"; slice D's HTTP API and screen will call these, until then only code does):
//
//   await mcp.launchRecord(serverId)             {required, approved, fingerprint, record}: what starts a stdio server (no secret)
//   await mcp.approveLaunch(serverId, {expectedFingerprint})   approves exactly the record the owner was shown
//   mcp.toolReview(serverId)                     {state, fingerprint, diff?, tools, prompts, refused}: what the pin check saw
//   await mcp.approveTools(serverId, {expectedFingerprint})    pins exactly the lists the owner was shown
//
// A stdio server is never spawned before its launch record is approved, and any change of the record (command, args, cwd, env KEY names, the
// resolved executable or its sha256) needs approval again. A server's tools are offered and callable only while its lists match the pin.
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
// is an error, never a partial list. Every item then goes through sanitizeList (lib/mcp/sanitize.mjs): ONE name rule for the Hub, 1-128
// characters of [A-Za-z0-9_.-] (the MCP tool-name rule), applied per item: a bad or duplicate name drops that item (the first of two wins) and
// is counted in status().servers[].refused, never the whole list.
//
// A call that times out, loses its response or is stopped by its caller after it was sent is reported as such (`executed: 'unknown'`) and is
// never sent again: the server may have run it. On HTTP the transport does not resume a broken response stream (reconnectionOptions.maxRetries = 0).
// A stdio message longer than maxMessageBytes (64 MiB) closes the connection (mcp_message_too_large) before it is parsed.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stableJson } from '../catalog.mjs';
import { delay, isObject, readJson, redact, stopOwned, writeJson } from '../runtime.mjs';
import { scrubEnv } from '../shell-runner.mjs';
import { createPinStore } from './fingerprint-pins.mjs';
import { createStderrCollector, limitToolResult, RESULT_LIMITS } from './result-limits.mjs';
import { copyJson, LIMITS, sanitizeList, sanitizeText } from './sanitize.mjs';
import { defaultRuntimeRoots, loadMcpSdk, locateMcpRuntime } from './sdk.mjs';
import { McpServerStore } from './server-config.mjs';

export const MAX_LIST_PAGES = 1000;
// A whole listing (all its pages) is refused past these, before anything is sanitized: the Hub never holds more than this of one list.
export const MAX_LIST_ITEMS = 10_000;
export const MAX_LIST_BYTES = 16 * 1024 * 1024;
// How long the task preflight waits for the servers in all; a connect still running goes on and its tools are offered from the next task.
export const PREPARE_WAIT_MS = 3000;
// A server whose connect failed is not tried again by the preflight before this (1, 2, 5, then 15 minutes for each failure in a row). An explicit
// connect() (the owner or a test asking for that server) is not held back; reload(), a successful connect and a new launch approval clear it.
export const RETRY_BACKOFF_MS = Object.freeze([60_000, 120_000, 300_000, 900_000]);
export const MAX_NAME_LENGTH = LIMITS.nameMaxLength;
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
export const APPROVALS_FILE = 'mcp-approvals.json';
const APPROVALS_VERSION = 1;
const LAUNCH_RECORD_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;
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

/**
 * Walks one list method page by page. A repeated or malformed cursor, or more than `maxPages` pages, is an error. Names are not checked here:
 * every item goes through sanitizeList afterwards, which refuses a bad or duplicate name per item (the one name rule of the Hub).
 */
export async function listAll(request, kind, { signal, timeout, maxPages = MAX_LIST_PAGES, maxItems = MAX_LIST_ITEMS, maxBytes = MAX_LIST_BYTES } = {}) {
  const spec = LISTS[kind];
  if (!spec) throw new TypeError(`unknown list ${kind}`);
  const items = [];
  const seen = new Set();
  let cursor;
  let pages = 0;
  let bytes = 0;
  do {
    signal?.throwIfAborted();
    if (pages >= maxPages) throw fault('mcp_list_too_many_pages', `${spec.method} did not end after ${maxPages} pages; the list is refused rather than cut short.`);
    pages += 1;
    const page = await request({ method: spec.method, params: cursor === undefined ? {} : { cursor } }, { signal, timeout });
    if (!isObject(page) || !Array.isArray(page[spec.field])) throw fault('mcp_list_invalid', `${spec.method} did not return a list of ${spec.field}.`);
    bytes += Buffer.byteLength(JSON.stringify(page[spec.field]) ?? '');
    if (items.length + page[spec.field].length > maxItems || bytes > maxBytes) {
      throw fault('mcp_list_too_large', `${spec.method} passed ${maxItems} items or ${maxBytes} bytes in all; the list is refused rather than held.`);
    }
    items.push(...page[spec.field]);
    cursor = page.nextCursor ?? undefined;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || !cursor) throw fault('mcp_list_cursor_invalid', `${spec.method} returned a cursor that is not a non-empty string.`);
      if (seen.has(cursor)) throw fault('mcp_list_cursor_repeated', `${spec.method} returned a cursor it had returned before; the list is refused rather than read in a loop.`);
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return { items, pages };
}

/**
 * The newline-delimited JSON of the stdio transport, read without the SDK's ReadBuffer (which copies its whole buffer on every chunk and keeps
 * 10 MiB in all): chunks are kept in a list and joined once per line, and a line that grows over `maxBytes` before its newline is refused at
 * once with mcp_message_too_large, so no single message can make the Hub hold more than that. A line that is not JSON is skipped, as the SDK does.
 */
export class LineReader {
  constructor({ maxBytes = MAX_MESSAGE_BYTES, parse }) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive whole number');
    this.maxBytes = maxBytes;
    this.parse = parse;
    this.chunks = [];
    this.size = 0;
  }

  #tooLarge() {
    this.clear();
    return fault('mcp_message_too_large', `The MCP server sent one message of more than ${this.maxBytes} bytes; the connection is closed rather than read further.`);
  }

  /** Takes one chunk; calls onMessage for each complete message, onError for one that is JSON but not JSON-RPC. Throws mcp_message_too_large. */
  push(chunk, onMessage, onError = () => {}) {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      if (newline === -1) {
        const rest = chunk.length - start;
        if (this.size + rest > this.maxBytes) throw this.#tooLarge();
        if (rest > 0) { this.chunks.push(chunk.subarray(start)); this.size += rest; }
        return;
      }
      const piece = chunk.subarray(start, newline);
      if (this.size + piece.length > this.maxBytes) throw this.#tooLarge();
      const line = this.size ? Buffer.concat([...this.chunks, piece]) : piece;
      this.chunks = [];
      this.size = 0;
      start = newline + 1;
      const text = line.toString('utf8').replace(/\r$/, '');
      if (!text.trim()) continue;
      let message;
      try { message = this.parse(text); }
      catch (error) { if (!(error instanceof SyntaxError)) onError(error); continue; }
      onMessage(message);
    }
  }

  clear() { this.chunks = []; this.size = 0; }
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
  /** Why the transport closed itself (mcp_message_too_large), or null. */
  closeReason = null;

  constructor(sdk, { command, args = [], cwd, env, onStderrLine = () => {}, onStderr = () => {}, maxMessageBytes = MAX_MESSAGE_BYTES }) {
    this.#sdk = sdk;
    this.#params = { command, args, cwd, env, onStderrLine, onStderr };
    this.#buffer = new LineReader({ maxBytes: maxMessageBytes, parse: sdk.deserializeMessage });
  }

  get pid() { return this.#child?.pid ?? null; }
  get stderr() { return null; }
  /** True once the child has exited (close() resolves only then). */
  get exited() { return Boolean(this.#child) && (this.#child.exitCode !== null || this.#child.signalCode !== null); }

  start() {
    if (this.#child) return Promise.reject(new Error('This stdio transport has already been started.'));
    const { command, args, cwd, env, onStderrLine, onStderr } = this.#params;
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
        if (this.closeReason) return;
        try { this.#buffer.push(chunk, (message) => this.onmessage?.(message), (error) => this.onerror?.(error)); }
        catch (error) { this.closeReason = error; this.onerror?.(error); void this.close(); }
      });
      let pending = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('error', () => {});
      child.stderr.on('data', (text) => {
        onStderr(text);
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
    this.tools = new Map();       // name -> the sanitized tool (what the catalog, the instructions and the card may see)
    this.rawTools = new Map();    // name -> the tool as the server listed it (the SDK checks a call against it)
    this.prompts = [];
    this.resources = [];
    this.refused = { tools: 0, prompts: 0, resources: 0 };
    this.toolCount = null;
    this.fingerprint = null;
    this.review = null;           // {state: 'unpinned' | 'pinned' | 'needs_review', fingerprint, diff?, reason?}
    this.launch = null;           // {required, approved, fingerprint}
    this.stderr = createStderrCollector();
    this.connectedAt = null;
    this.lastError = null;
    this.calls = 0;
    this.attempts = 0;
    this.unknownResultTypes = 0;
    this.stderrLines = 0;
    this.secrets = [];
  }

  /** Connected and pinned: what the catalog may offer and what may be called. */
  get usable() { return this.state === 'connected' && this.review?.state === 'pinned'; }

  /** What status() and connect() return: nothing configured (no command, argument, url or header), nothing secret. */
  summary() {
    return {
      id: this.id,
      transport: this.transport,
      // A connected server whose lists are not (or no longer) the approved pin is quarantined: needs_review until the owner approves them.
      state: this.state === 'connected' && this.review?.state !== 'pinned' ? 'needs_review' : this.state,
      review: this.review ? { state: this.review.state, fingerprint: this.review.fingerprint, ...(this.review.reason ? { reason: this.review.reason } : {}), ...(this.review.diff ? { diff: structuredClone(this.review.diff) } : {}) } : null,
      launch: this.launch ? { ...this.launch } : null,
      refused: { ...this.refused },
      stderr: this.stderr.stats(),
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
   * @param {number} [options.maxMessageBytes] the longest stdio message read (MAX_MESSAGE_BYTES); the tests lower it
   */
  constructor({ hubDirectory, bundleRoot, protector = null, registerSecret = () => {}, secrets = () => [], log = () => {}, runtimeRoots = null, env = process.env, platform = process.platform, clientInfo = { name: 'DatGold', version: '0.0.0' }, store = null, maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
    if (!hubDirectory && !store) throw new TypeError('McpClientManager requires hubDirectory.');
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1024) throw new TypeError('maxMessageBytes must be a whole number of at least 1024');
    this.maxMessageBytes = maxMessageBytes;
    this.roots = runtimeRoots ?? defaultRuntimeRoots(bundleRoot ? path.resolve(bundleRoot) : undefined, env);
    this.env = env;
    this.platform = platform;
    this.clientInfo = { name: String(clientInfo.name), version: String(clientInfo.version) };
    this.secrets = secrets;
    this.output = log;
    this.store = store ?? new McpServerStore({ hubDirectory, protector, registerSecret });
    // The owner's approvals live beside mcp-servers.json: the launch records (mcp-approvals.json) and the pins of the lists (mcp-pins.json).
    this.directory = path.dirname(this.store.file);
    this.approvalsFile = path.join(this.directory, APPROVALS_FILE);
    this.approvals = null;
    this.approvalWrites = Promise.resolve();
    this.pins = createPinStore({ directory: this.directory, log: (line) => this.log(`MCP pins: ${line}`) });
    this.runtime = locateMcpRuntime(this.roots);
    this.connections = new Map();
    // id -> {failures, retryAt (ms)}: the preflight's back-off of a server whose connect failed.
    this.backoff = new Map();
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
      const approved = this.approvals?.launch?.[server.id] ?? null;
      const launch = { required: server.transport === 'stdio', approved: server.transport !== 'stdio' || Boolean(approved), fingerprint: approved?.fingerprint ?? null };
      const retry = this.backoff.get(server.id);
      return { ...(connection ? connection.summary() : { id: server.id, transport: server.transport, state: 'idle', review: null, launch, refused: { tools: 0, prompts: 0, resources: 0 }, stderr: null, protocolVersion: null, era: null, server: null, tools: null, fingerprint: null, connectedAt: null, calls: 0, unknownResultTypes: 0, lastError: null }), enabled: server.enabled, retryAt: retry ? new Date(retry.retryAt).toISOString() : null };
    }) : [];
    return { runtime, configLoaded: this.store.loaded, closed: this.closed, servers };
  }

  /** Reads mcp-servers.json again. Connections that are open keep running with the configuration they were opened with. */
  async reload() {
    const servers = await this.store.load();
    this.approvals = null;
    this.backoff.clear();
    await this.#loadApprovals().catch((error) => this.log(`MCP: ${APPROVALS_FILE} was not read (${error.message}); every stdio server needs its launch approved again.`));
    return servers;
  }

  // ------------------------------------------------------------------------------------------------------------------ launch approval

  /** The approvals file: {version, launch: {<id>: {fingerprint, record, approvedAt}}}. A file that cannot be read approves nothing. */
  async #loadApprovals() {
    if (this.approvals) return this.approvals;
    let data = null;
    try { data = await readJson(this.approvalsFile); }
    catch (error) { this.approvals = { version: APPROVALS_VERSION, launch: {} }; throw error; }
    const launch = {};
    if (isObject(data) && data.version === APPROVALS_VERSION && isObject(data.launch)) {
      for (const [id, entry] of Object.entries(data.launch)) if (isObject(entry) && typeof entry.fingerprint === 'string' && HEX64.test(entry.fingerprint)) launch[id] = entry;
    }
    this.approvals = { version: APPROVALS_VERSION, launch };
    return this.approvals;
  }

  /**
   * What starts a stdio server, as the owner approves it: the command, args and cwd as they are once the ${NAME} references are expanded (each
   * secret value replaced by "[secret]"), the NAMES of its env map (never a value), the executable the Hub will start (resolved on the PATH the
   * server gets, PATHEXT on Windows, real path) and the sha256 of that file. Its fingerprint is the sha256 of the record's canonical JSON.
   */
  async #launchFor(serverId, config, sdk = null) {
    const secrets = [...config.secrets].filter((value) => typeof value === 'string' && value.length > 0).sort((a, b) => b.length - a.length);
    const mask = (text) => secrets.reduce((value, secret) => value.split(secret).join('[secret]'), String(text));
    const environment = sdk ? this.#childEnvironment(sdk, config) : { ...this.env, ...config.env };
    const executable = resolveExecutable(config.command, { env: environment, cwd: config.cwd, platform: this.platform });
    const record = {
      version: LAUNCH_RECORD_VERSION, transport: 'stdio', command: mask(config.command), args: config.args.map(mask), cwd: config.cwd ? mask(config.cwd) : null,
      envKeys: Object.keys(config.env).sort(), executable, sha256: executable ? await hashFile(executable) : null,
    };
    const fingerprint = createHash('sha256').update(stableJson(record)).digest('hex');
    const approvals = await this.#loadApprovals().catch(() => this.approvals);
    return { required: true, approved: approvals?.launch?.[serverId]?.fingerprint === fingerprint, fingerprint, record };
  }

  /** {required, approved, fingerprint, record} of one server: what the owner must approve before a stdio server is started (HTTP: required false). */
  async launchRecord(serverId) {
    this.#assertOpen();
    const config = await this.store.resolveForConnect(serverId, { parentEnv: this.env, platform: this.platform });
    if (config.transport !== 'stdio') return { required: false, approved: true, fingerprint: null, record: null };
    const sdk = await loadMcpSdk({ roots: this.roots }).catch(() => null);
    return await this.#launchFor(serverId, config, sdk);
  }

  /**
   * Approves the launch record the owner was shown: `expectedFingerprint` is its fingerprint, and a record that has changed since (another command,
   * argument or env name, another executable or other bytes in it) is refused with mcp_launch_changed. There is no approval without it; the
   * {fingerprint} key is NOT read.
   */
  async approveLaunch(serverId, { expectedFingerprint } = {}) {
    this.#assertOpen();
    if (typeof expectedFingerprint !== 'string' || !HEX64.test(expectedFingerprint)) throw fault('mcp_fingerprint_required', 'An approval names the fingerprint of the launch record the owner was shown (expectedFingerprint).', { statusCode: 400 });
    const current = await this.launchRecord(serverId);
    if (!current.required) return { ok: true, fingerprint: null };
    if (current.fingerprint !== expectedFingerprint) throw fault('mcp_launch_changed', `The launch record of "${serverId}" changed after it was shown; show it again and approve what it is now.`, { statusCode: 409 });
    const write = this.approvalWrites.then(async () => {
      const approvals = await this.#loadApprovals();
      approvals.launch[serverId] = { fingerprint: current.fingerprint, record: current.record, approvedAt: new Date().toISOString() };
      await writeJson(this.approvalsFile, approvals);
    });
    this.approvalWrites = write.catch(() => {});
    await write;
    this.backoff.delete(serverId);
    this.log(`MCP ${serverId}: the owner approved the launch record ${current.fingerprint.slice(0, 12)}.`);
    return { ok: true, fingerprint: current.fingerprint };
  }

  // ------------------------------------------------------------------------------------------------------------------ pins of the lists

  /** What the pin check saw on the server's last listing: {state, fingerprint, diff?, reason?, tools, prompts, refused}; state 'not_connected' without one. */
  toolReview(serverId) {
    const connection = this.connections.get(serverId);
    if (!connection?.review || connection.state !== 'connected') return { state: 'not_connected', fingerprint: null, tools: [], prompts: [], refused: null };
    return {
      state: connection.review.state, fingerprint: connection.review.fingerprint,
      ...(connection.review.diff ? { diff: structuredClone(connection.review.diff) } : {}), ...(connection.review.reason ? { reason: connection.review.reason } : {}),
      tools: [...connection.tools.values()].map((tool) => structuredClone(tool)), prompts: structuredClone(connection.prompts), refused: { ...connection.refused },
    };
  }

  /**
   * Pins the lists the owner was shown (toolReview): `expectedFingerprint` is their fingerprint; lists that hash otherwise now are refused with
   * mcp_fingerprint_mismatch, and nothing is pinned without it. The {fingerprint} key is NOT read.
   */
  async approveTools(serverId, { expectedFingerprint } = {}) {
    this.#assertOpen();
    if (typeof expectedFingerprint !== 'string' || !HEX64.test(expectedFingerprint)) throw fault('mcp_fingerprint_required', 'An approval names the fingerprint of the lists the owner was shown (expectedFingerprint).', { statusCode: 400 });
    const connection = this.connections.get(serverId);
    if (!connection?.snapshot || connection.state !== 'connected') throw fault('mcp_not_connected', `The MCP server "${serverId}" is not connected; its lists cannot be approved.`, { statusCode: 409 });
    const answer = await this.pins.approve(serverId, connection.snapshot, { expectedFingerprint });
    if (!answer.ok) {
      if (answer.reason === 'fingerprint_mismatch') throw fault('mcp_fingerprint_mismatch', `The lists of "${serverId}" changed after they were shown; show them again and approve what they are now.`, { statusCode: 409 });
      throw fault('mcp_pin_failed', `The lists of "${serverId}" could not be pinned (${answer.reason}).`, { statusCode: 500 });
    }
    connection.review = { state: 'pinned', fingerprint: answer.fingerprint };
    connection.fingerprint = answer.fingerprint;
    this.log(`MCP ${serverId}: the owner approved ${connection.toolCount} tools (pin ${answer.fingerprint.slice(0, 12)}).`);
    return { ok: true, fingerprint: answer.fingerprint };
  }

  /**
   * Opens the connection to one server if it is not open (spawn or HTTP, version negotiation, the first tools/list), within its connect
   * deadline (timeouts.connectMs, 30 s by default). Callers that arrive while it is opening share the attempt; `signal` stops the waiting of
   * this caller only.
   */
  async connect(serverId, { signal } = {}) {
    this.#assertOpen();
    signal?.throwIfAborted();
    return await this.#connect(serverId, { signal });
  }

  async #connect(serverId, { signal } = {}) {
    let connection = this.connections.get(serverId);
    if (!connection || !['connected', 'connecting'].includes(connection.state)) {
      const config = await this.store.resolveForConnect(serverId, { parentEnv: this.env, platform: this.platform });
      // A stdio server starts only with the launch record the owner approved, and the Hub starts exactly the executable it hashed.
      // Without the SDK nothing can start, and the connection reports mcp_runtime_missing (#open) rather than a launch to approve.
      let launch = null;
      if (config.transport === 'stdio') {
        const sdk = await loadMcpSdk({ roots: this.roots }).catch(() => null);
        if (sdk) {
          launch = await this.#launchFor(serverId, config, sdk);
          if (launch.record.executable) config.command = launch.record.executable;
        }
      }
      this.#assertOpen();
      connection = this.connections.get(serverId);
      if (!connection || !['connected', 'connecting'].includes(connection.state)) {
        const previous = connection;
        connection = new Connection(serverId, config.transport);
        connection.calls = previous?.calls ?? 0;
        connection.secrets = config.secrets;
        connection.timeouts = config.timeouts;
        connection.launch = launch ? { required: true, approved: launch.approved, fingerprint: launch.fingerprint } : { required: config.transport === 'stdio', approved: config.transport !== 'stdio', fingerprint: null };
        this.connections.set(serverId, connection);
        if (launch && !launch.approved) {
          connection.state = 'needs_launch_approval';
          connection.lastError = { code: 'mcp_launch_not_approved', message: `The owner has not approved how the MCP server "${serverId}" is started (or it changed since); it was not started.` };
          throw fault('mcp_launch_not_approved', connection.lastError.message, { statusCode: 409 });
        }
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
      await this.#refreshLists(connection, { signal, timeout: Math.max(1, remaining()) });
      signal.throwIfAborted();
      connection.state = 'connected';
      connection.connectedAt = new Date().toISOString();
      connection.lastError = null;
      this.backoff.delete(connection.id);
      const channel = connection.channel;
      client.onclose = () => {
        if (connection.state !== 'connected') return;
        connection.state = 'lost';
        const reason = channel?.closeReason;
        connection.lastError = reason?.code === 'mcp_message_too_large'
          ? { code: 'mcp_message_too_large', message: String(reason.message).slice(0, 500) }
          : { code: 'mcp_connection_lost', message: 'The connection to the server was lost.' };
        this.log(`MCP ${connection.id}: the connection was lost (${connection.lastError.code}).`, connection);
        this.#background(this.#dispose(connection));
      };
      this.log(`MCP ${connection.id}: connected (${config.transport}, protocol ${connection.protocolVersion ?? 'unknown'}, ${connection.toolCount} tools, pin ${connection.review?.state}).`, connection);
    } catch (error) {
      // A server that sent one message over the read limit is named for that, not as an ordinary failed connect.
      const reason = connection.channel?.closeReason;
      await this.#dispose(connection);
      return this.#failed(connection, signal.aborted ? signal.reason : reason?.code === 'mcp_message_too_large' ? reason : error);
    } finally {
      clearTimeout(timer);
    }
  }

  #closeAll = null;

  #failed(connection, error) {
    connection.state = 'failed';
    if (!this.closed) {
      const failures = (this.backoff.get(connection.id)?.failures ?? 0) + 1;
      this.backoff.set(connection.id, { failures, retryAt: Date.now() + RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length) - 1] });
    }
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
        command: config.command, args: config.args, cwd: config.cwd, env: this.#childEnvironment(sdk, config), maxMessageBytes: this.maxMessageBytes,
        // Kept, bounded, for status() (createStderrCollector: the first and the latest 32 KiB); the first 200 lines also go to the log.
        onStderr: (text) => connection.stderr.push(text),
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

  /**
   * Lists the tools, prompts and resources of a connection, sanitizes them (sanitizeList: nothing else of a server's lists is kept) and checks the
   * tools and prompts against the owner's pin. Resources are offered but NOT pinned: a server's resource list is data that changes (files,
   * records), and only their uri, name and mimeType reach the model, never a description or title. A prompts or resources list that fails is
   * empty (logged); a pin check that fails is needs_review.
   */
  async #refreshLists(connection, { signal, timeout }) {
    const raw = await this.#list(connection, 'tools', { signal, timeout });
    const optional = async (kind) => {
      try { return await this.#list(connection, kind, { signal, timeout }); }
      catch (error) {
        if (signal?.aborted) throw error;
        this.log(`MCP ${connection.id}: ${kind}/list failed (${String(error?.message ?? error).slice(0, 200)}); none is offered.`, connection);
        return [];
      }
    };
    const rawPrompts = await optional('prompts');
    const rawResources = await optional('resources');
    const lists = {};
    for (const [kind, items] of [['tools', raw], ['prompts', rawPrompts], ['resources', rawResources]]) {
      const sanitized = sanitizeList(kind, items);
      if (!sanitized.ok) throw fault('mcp_list_invalid', `The ${kind} list of the server could not be read (${sanitized.reason}).`);
      lists[kind] = sanitized;
      connection.refused[kind] = sanitized.refusedCount + sanitized.overLimit;
      if (connection.refused[kind]) this.log(`MCP ${connection.id}: ${connection.refused[kind]} of ${items.length} ${kind} refused (${sanitized.refused.slice(0, 3).map((entry) => `${entry.preview ?? ''}: ${entry.reason}`).join('; ')}).`, connection);
    }
    connection.tools = new Map(lists.tools.items.map((tool) => [tool.name, tool]));
    connection.rawTools = new Map(raw.filter((tool) => connection.tools.has(tool?.name)).map((tool) => [tool.name, tool]));
    connection.prompts = lists.prompts.items;
    connection.resources = lists.resources.items.map(({ uri, name, mimeType }) => ({ uri, name, ...(mimeType ? { mimeType } : {}) }));
    connection.toolCount = connection.tools.size;
    connection.snapshot = { tools: lists.tools.items, prompts: lists.prompts.items, resources: [] };
    const check = await this.pins.check(connection.id, connection.snapshot);
    if (!check.ok) connection.review = { state: 'needs_review', fingerprint: null, reason: check.reason };
    else connection.review = { state: check.state, fingerprint: check.fingerprint, ...(check.diff ? { diff: check.diff } : {}), ...(check.reason ? { reason: check.reason } : {}) };
    connection.fingerprint = connection.review.fingerprint;
    if (connection.review.state === 'needs_review') this.log(`MCP ${connection.id}: its lists differ from the approved pin; its tools are not offered until the owner reviews them.`, connection);
    return [...connection.tools.values()];
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

  /** The sanitized tools of a connection (re-listed and pin-checked again with refresh: true). */
  async listTools(serverId, { signal, refresh = false } = {}) {
    this.#assertOpen();
    const connection = await this.#ready(serverId, signal);
    if (refresh) await this.#refreshLists(connection, { signal, timeout: connection.timeouts.connectMs });
    return [...connection.tools.values()].map((tool) => structuredClone(tool));
  }

  async listPrompts(serverId, { signal, refresh = false } = {}) {
    this.#assertOpen();
    const connection = await this.#ready(serverId, signal);
    if (refresh) await this.#refreshLists(connection, { signal, timeout: connection.timeouts.connectMs });
    return structuredClone(connection.prompts);
  }

  async listResources(serverId, { signal, refresh = false } = {}) {
    this.#assertOpen();
    const connection = await this.#ready(serverId, signal);
    if (refresh) await this.#refreshLists(connection, { signal, timeout: connection.timeouts.connectMs });
    return structuredClone(connection.resources);
  }

  /** A connection that may be called: connected, and its lists are the approved pin (else mcp_needs_review, nothing is sent). */
  async #usable(serverId, signal) {
    const connection = await this.#ready(serverId, signal);
    if (!connection.usable) {
      throw fault('mcp_needs_review', `The tools of the MCP server "${serverId}" are not approved (${connection.review?.state ?? 'not listed'}); the owner must review them first. Nothing was sent.`, { statusCode: 409, executed: false });
    }
    return connection;
  }

  /**
   * The servers whose tools the catalog may offer, now: connected, and their lists match the approved pin. For each: {id, serverInfo,
   * capabilities, fingerprint, tools, prompts, resources}, sanitized. Synchronous: HubManager.internalCatalog() reads it; prepare() fills it.
   */
  catalogGroups() {
    const order = this.store.loaded ? this.store.list().map((server) => server.id) : [...this.connections.keys()];
    return order.map((id) => this.connections.get(id)).filter((connection) => connection?.usable).map((connection) => ({
      id: connection.id,
      serverInfo: connection.serverInfo ? { name: String(connection.serverInfo.name ?? '').slice(0, 200), version: String(connection.serverInfo.version ?? '').slice(0, 100) } : { name: connection.id, version: '' },
      capabilities: structuredClone(connection.capabilities ?? {}),
      fingerprint: connection.fingerprint,
      tools: [...connection.tools.values()].map((tool) => structuredClone(tool)),
      prompts: structuredClone(connection.prompts),
      resources: structuredClone(connection.resources),
    }));
  }

  /**
   * Task preflight (HubManager.createAgentSession): every enabled server is connected if it may start (a stdio server whose launch is not
   * approved is left alone: nothing is spawned), and the lists of a connected one are read again, so a change since the last task is caught by
   * the pin check before the catalog is built. It waits `waitMs` (PREPARE_WAIT_MS) in all: a connect or a listing still running goes on, and what
   * it brings is offered from the next task. A server whose connect failed is backed off (RETRY_BACKOFF_MS, `retryAt` in status()) and not
   * tried again here before then. Never throws: what fails is logged and is simply not in the catalog.
   */
  async prepare({ signal, waitMs = PREPARE_WAIT_MS } = {}) {
    if (this.closed) return this.status();
    if (!this.store.loaded) await this.reload().catch((error) => this.log(`MCP: mcp-servers.json was not read (${error.message}).`));
    if (!this.store.loaded) return this.status();
    if (this.runtime.state !== 'ready') this.runtime = locateMcpRuntime(this.roots);
    const servers = this.store.list().filter((server) => server.enabled);
    if (servers.length && this.runtime.state !== 'ready') return this.status();
    const now = Date.now();
    const work = Promise.allSettled(servers.map(async ({ id }) => {
      const connection = this.connections.get(id);
      if (connection?.state !== 'connected' && connection?.state !== 'connecting' && (this.backoff.get(id)?.retryAt ?? 0) > now) return;
      try {
        if (connection?.state === 'connected') await this.#refreshLists(connection, { signal, timeout: connection.timeouts.connectMs });
        else await this.#connect(id, { signal });
      } catch (error) {
        if (error?.code !== 'mcp_launch_not_approved' && !signal?.aborted) this.log(`MCP ${id}: not available for this task (${error?.code ?? 'error'}).`);
      }
    }));
    let timer;
    const waited = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, waitMs)); timer.unref?.(); });
    try { await Promise.race([work, waited]); } finally { clearTimeout(timer); }
    return this.status();
  }

  /**
   * One tools/call. The timeout (the server's timeouts.callMs, or the caller's timeoutMs when that is shorter: the agent passes its own deadline,
   * and the owner's word for the server must still hold) covers the whole call, progress included; when it passes the SDK
   * sends notifications/cancelled and this rejects with `mcp_call_timeout`. Nothing is ever sent twice. A caller's abort before anything was
   * sent rejects with the signal's reason; after the request went out it rejects with mcp_call_aborted, executed: 'unknown'. The result goes
   * through limitToolResult (the 8 MiB ceiling, only png/jpeg/gif/webp images), so only {content, structuredContent?, isError?} comes back.
   */
  async callTool(serverId, name, args = {}, { signal, timeoutMs } = {}) {
    this.#assertOpen();
    const connection = await this.#usable(serverId, signal);
    const tool = connection.rawTools.get(name);
    if (!tool || !connection.tools.has(name)) throw fault('mcp_tool_unknown', `The MCP server "${serverId}" has no tool "${String(name).slice(0, 128)}".`, { statusCode: 404, executed: false });
    if (!isObject(args)) throw fault('mcp_arguments_invalid', 'The arguments of an MCP tool call must be an object.', { statusCode: 400, executed: false });
    const requested = Number.isFinite(timeoutMs) ? Math.min(timeoutMs, connection.timeouts.callMs) : connection.timeouts.callMs;
    const limit = Math.min(MAX_CALL_TIMEOUT_MS, Math.max(MIN_CALL_TIMEOUT_MS, Math.trunc(requested)));
    signal?.throwIfAborted();
    const channel = connection.channel;
    connection.calls += 1;
    let raw;
    try {
      raw = await connection.client.callTool({ name, arguments: args }, { signal, timeout: limit, maxTotalTimeout: limit, resetTimeoutOnProgress: false, toolDefinition: tool });
    } catch (error) {
      if (channel?.closeReason?.code === 'mcp_message_too_large') throw fault('mcp_message_too_large', `The MCP tool ${serverId}/${name} answered with a message larger than ${this.maxMessageBytes} bytes; the connection was closed. The call is not repeated; the server may have run it.`, { executed: 'unknown' });
      if (signal?.aborted) throw fault('mcp_call_aborted', `The call to the MCP tool ${serverId}/${name} was stopped after it was sent. It is not repeated; the server may have run it.`, { executed: 'unknown', cause: signal.reason });
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
    return limitToolResult(raw, { toolName: `${serverId}.${name}`, optimize: false }).result;
  }

  /** prompts/get of a prompt the server listed (and the owner pinned). The answer is a bounded copy; its text is data, never instructions. */
  async getPrompt(serverId, name, args = {}, { signal, timeoutMs } = {}) {
    this.#assertOpen();
    const connection = await this.#usable(serverId, signal);
    if (!connection.prompts.some((prompt) => prompt.name === name)) throw fault('mcp_prompt_unknown', `The MCP server "${serverId}" has no prompt "${String(name).slice(0, 128)}".`, { statusCode: 404, executed: false });
    if (!isObject(args) || Object.values(args).some((value) => typeof value !== 'string')) throw fault('mcp_arguments_invalid', 'The arguments of an MCP prompt must be strings.', { statusCode: 400, executed: false });
    const timeout = Math.min(MAX_CALL_TIMEOUT_MS, Math.max(MIN_CALL_TIMEOUT_MS, Math.trunc(Number.isFinite(timeoutMs) ? Math.min(timeoutMs, connection.timeouts.callMs) : connection.timeouts.callMs)));
    const answer = await this.#request(connection, () => connection.client.getPrompt({ name, arguments: args }, { signal, timeout }), `${serverId}:prompts/get:${name}`, signal);
    return bounded(answer, 'prompt');
  }

  /** resources/read of one URI through the server that owns it. The answer is a bounded copy; its text is data, never instructions. */
  async readResource(serverId, uri, { signal, timeoutMs } = {}) {
    this.#assertOpen();
    const connection = await this.#usable(serverId, signal);
    if (!connection.capabilities?.resources) throw fault('mcp_capability_missing', `The MCP server "${serverId}" does not offer resources.`, { statusCode: 400, executed: false });
    if (typeof uri !== 'string' || !uri || uri.length > 32_768) throw fault('mcp_arguments_invalid', 'A resource URI must be a non-empty string.', { statusCode: 400, executed: false });
    const timeout = Math.min(MAX_CALL_TIMEOUT_MS, Math.max(MIN_CALL_TIMEOUT_MS, Math.trunc(Number.isFinite(timeoutMs) ? Math.min(timeoutMs, connection.timeouts.callMs) : connection.timeouts.callMs)));
    const answer = await this.#request(connection, () => connection.client.readResource({ uri }, { signal, timeout }), `${serverId}:resources/read`, signal);
    return bounded(answer, 'resource');
  }

  /** One request other than tools/call, with the same reading of its failures (never repeated, executed: 'unknown' when it may have run). */
  async #request(connection, send, label, signal) {
    signal?.throwIfAborted();
    try { return await send(); }
    catch (error) {
      if (signal?.aborted) throw fault('mcp_call_aborted', `${label} was stopped after it was sent; it is not repeated.`, { executed: 'unknown', cause: signal.reason });
      const codes = connection.sdk.SdkErrorCode;
      if (error?.code === codes.RequestTimeout) throw fault('mcp_call_timeout', `${label} did not answer in time; it is not repeated.`, { executed: 'unknown' });
      if ([codes.ConnectionClosed, codes.NotConnected, codes.SendFailed].includes(error?.code) || connection.state !== 'connected') throw fault('mcp_connection_lost', `The connection was lost during ${label}; it is not repeated.`, { executed: 'unknown' });
      const message = redact(String(error?.message ?? error), [...(this.secrets() ?? []), ...connection.secrets]).slice(0, 1000);
      throw fault('mcp_call_failed', `${label} failed: ${message}`, { executed: 'unknown', ...(Number.isInteger(error?.code) ? { protocolCode: error.code } : {}) });
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

/** A prompt or resource answer as plain JSON of at most the result ceiling, its description cleaned; a larger or odd answer is an error result. */
function bounded(answer, what) {
  const copy = copyJson(answer, { maxBytes: RESULT_LIMITS.maxReadBytes, maxDepth: 32 });
  if (!copy.ok) return { isError: true, content: [{ type: 'text', text: `[DatGold: the ${what} answer was dropped: ${copy.reason}]` }] };
  const value = copy.value;
  if (isObject(value) && typeof value.description === 'string') value.description = sanitizeText(value.description).text ?? '';
  return value;
}

/**
 * The executable a command starts, found on the absolute entries of `env`'s PATH (PATHEXT on Windows; a command with a path is taken
 * relative to `cwd`), as a real path; null when none is found. Only regular files count (on POSIX, executable ones).
 */
export function resolveExecutable(command, { env = process.env, cwd = null, platform = process.platform } = {}) {
  const text = String(command ?? '');
  if (!text) return null;
  const lookup = (name) => {
    if (Object.hasOwn(env, name)) return env[name];
    if (platform !== 'win32') return undefined;
    const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : env[key];
  };
  const win = platform === 'win32';
  const extensions = win ? String(lookup('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.trim()).filter(Boolean) : [];
  const forms = (base) => {
    if (!win) return [base];
    const ext = path.extname(base).toLowerCase();
    return ext && extensions.some((known) => known.toLowerCase() === ext) ? [base] : extensions.map((known) => base + known);
  };
  const usable = (file) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (!win) fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch { return false; }
  };
  const hasPath = text.includes('/') || (win && text.includes('\\'));
  const bases = hasPath || path.isAbsolute(text)
    ? [path.resolve(cwd ?? process.cwd(), text)]
    : String(lookup('PATH') ?? '').split(win ? ';' : ':').map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).filter((dir) => (win ? path.win32 : path.posix).isAbsolute(dir)).map((dir) => path.join(dir, text));
  for (const base of bases) for (const file of forms(base)) if (usable(file)) { try { return fs.realpathSync.native(file); } catch { return path.resolve(file); } }
  return null;
}

/** The sha256 of a file, read as a stream (node.exe is about 90 MB). */
export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
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
