// The Hub as an MCP server for local clients (Claude Code, Codex, Claude Desktop): the listener's core (docs/MCP-SERVER.md, P6 ext-17).
//
// A SEPARATE listener on 127.0.0.1:<port> (3008 unless set), never the dashboard's server: the dashboard trusts only its own page and has
// no way to tell local processes apart, this listener trusts only a token. Off by default (lib/mcp/server-setting.mjs). Every request goes
// through the same gate, in this order, before the SDK sees a byte of its body:
//   1. Host must be 127.0.0.1:<port> or localhost:<port> (DNS-rebinding defence; the SDK's validateHostHeader agrees as well)  -> 403
//   2. Origin, when a browser sends one, must be this listener's own origin (the SDK's validateOriginHeader agrees as well)  -> 403
//   3. a request a browser page made (Sec-Fetch-Site present and not "none") is refused, before it is counted anywhere        -> 403
//   4. the rate limit (createRateLimiter), per client address, in two buckets: requests with the valid token in one, every other
//      request (no token, a wrong one) in a smaller one of its own, so that token-less requests can never use up the
//      owner's client's allowance                                                                                           -> 429
//   5. the path must be /mcp                                                                                                 -> 404
//   6. Authorization: Bearer <token>, checked in constant time (lib/mcp/server-token.mjs)                                    -> 401
//   7. the SDK (createMcpHandler, stateless: no sessions; 2026-07-28 and 2025 clients), with its body limit                  -> 413
// One log line per request names the method, `/mcp` or `(other path)`, the status and the time: never a header, a query or a body. A
// refusal of the gate (401, 403, 404, 429) is logged in full only the first time its status is seen in a window (createRefusalLog); the
// others are counted and summed up in one line when the window ends, so a flood adds a bounded number of lines.
//
// Tools come from an injected provider ({tools, call}); `call` gets the request's signal and the client as it names itself (clientInfoOf).
// The Hub's provider is the host's (lib/mcp/host.mjs, ext-18): `hub_status`, which reads no workspace and changes nothing, and the tools
// the host serves through the Hub's permission gate (read_file in ext-18). The verify/read/write profiles are P6 ext-19.
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { loadMcpServerSdk } from './server-sdk.mjs';
import { McpServerSettingStore } from './server-setting.mjs';
import { McpServerTokenStore } from './server-token.mjs';

export const MCP_SERVER_PATH = '/mcp';
export const MCP_SERVER_HOST = '127.0.0.1';
export const DEFAULT_BODY_LIMIT = 1024 * 1024;
export const DEFAULT_RATE_LIMIT = Object.freeze({ windowMs: 60_000, max: 600 });
export const DEFAULT_ANONYMOUS_RATE_LIMIT = Object.freeze({ windowMs: 60_000, max: 60 });
export const DEFAULT_REFUSAL_LOG_WINDOW_MS = 60_000;
export const DEFAULT_LIST_CACHE_HINT = Object.freeze({ ttlMs: 0, cacheScope: 'private' });
const MAX_CONNECTIONS = 64;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const REALM = 'Bearer realm="DatGold MCP"';
const BEARER = /^Bearer (\S+)$/i;
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The provider's tools, checked and copied, in code-unit order of their names (so every client sees one order). */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) throw new TypeError('The MCP tool provider must give an array of tools.');
  const seen = new Set();
  const list = tools.map((tool) => {
    if (!plainObject(tool) || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) throw new TypeError(`Invalid MCP tool name: ${JSON.stringify(tool?.name)}.`);
    if (seen.has(tool.name)) throw new TypeError(`Duplicate MCP tool: ${tool.name}.`);
    seen.add(tool.name);
    for (const key of ['inputSchema', 'outputSchema']) {
      if (key === 'outputSchema' && tool.outputSchema === undefined) continue;
      if (!plainObject(tool[key]) || tool[key].type !== 'object') throw new TypeError(`The ${key} of the MCP tool ${tool.name} must be a JSON Schema of type object.`);
    }
    if (tool.annotations !== undefined && !plainObject(tool.annotations)) throw new TypeError(`The annotations of the MCP tool ${tool.name} must be an object.`);
    for (const key of ['title', 'description']) if (tool[key] !== undefined && typeof tool[key] !== 'string') throw new TypeError(`The ${key} of the MCP tool ${tool.name} must be text.`);
    return Object.freeze(structuredClone({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations }));
  });
  return list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';
/**
 * The client of a request as it names itself: `{name, version}` from the per-request `_meta` envelope of the 2026-07-28 revision (the SDK
 * lifts it into `context.mcpReq.envelope`), strings only and at most 256 characters each; null when the request carries none (a 2025
 * client: in stateless mode its tools/call has no clientInfo). It is the client's own word, under the one token every client shares.
 */
export function clientInfoOf(context) {
  const info = context?.mcpReq?.envelope?.[CLIENT_INFO_KEY];
  if (!plainObject(info) || typeof info.name !== 'string') return null;
  return { name: info.name.slice(0, 256), version: typeof info.version === 'string' ? info.version.slice(0, 256) : null };
}

/**
 * The factory createMcpHandler calls once per request (stateless): a fresh McpServer with the provider's tools, each registered with
 * fromJsonSchema(inputSchema) so that the SDK checks the arguments before `call(name, args, {signal, client})` runs (client: clientInfoOf).
 * @param {{name: string, version: string, tools: object[] | (() => object[]), call: Function, listCacheHint?: {ttlMs?: number, cacheScope?: string}}} options
 */
export function createMcpServerFactory(sdk, { name, version, tools, call, listCacheHint = DEFAULT_LIST_CACHE_HINT } = {}) {
  if (typeof call !== 'function') throw new TypeError('createMcpServerFactory needs a call function.');
  if (typeof name !== 'string' || !name || typeof version !== 'string' || !version) throw new TypeError('createMcpServerFactory needs a name and a version.');
  const listOf = typeof tools === 'function' ? () => normalizeTools(tools()) : (() => { const fixed = normalizeTools(tools); return () => fixed; })();
  return () => {
    const server = new sdk.McpServer({ name, version }, { capabilities: { tools: {} }, cacheHints: { 'tools/list': { ...listCacheHint } } });
    for (const tool of listOf()) {
      server.registerTool(tool.name, {
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: sdk.fromJsonSchema(structuredClone(tool.inputSchema)),
        ...(tool.outputSchema !== undefined ? { outputSchema: sdk.fromJsonSchema(structuredClone(tool.outputSchema)) } : {}),
        ...(tool.annotations !== undefined ? { annotations: { ...tool.annotations } } : {}),
      }, async (args, context) => call(tool.name, args ?? {}, { signal: context?.mcpReq?.signal, client: clientInfoOf(context) }));
    }
    return server;
  };
}

/** A fixed-window counter per client key: at most `max` requests per `windowMs`. */
export function createRateLimiter({ windowMs = DEFAULT_RATE_LIMIT.windowMs, max = DEFAULT_RATE_LIMIT.max, now = Date.now } = {}) {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0 || !Number.isSafeInteger(max) || max <= 0) throw new TypeError('The rate limit needs a positive window and maximum.');
  const windows = new Map();
  return {
    take(key) {
      const at = now();
      if (windows.size > 1024) for (const [other, entry] of windows) if (at - entry.start >= windowMs) windows.delete(other);
      let entry = windows.get(key);
      if (!entry || at - entry.start >= windowMs) { entry = { start: at, count: 0 }; windows.set(key, entry); }
      if (entry.count >= max) return { ok: false, retryAfterMs: entry.start + windowMs - at };
      entry.count += 1;
      return { ok: true, retryAfterMs: 0 };
    },
  };
}

/** A request a browser page made: browsers send Sec-Fetch-Site on every request to a trustworthy origin (127.0.0.1 is one), "none" only for
 * what the user started (a typed address). Node's fetch, and so the SDK's client, sends `sec-fetch-mode: cors` and no Sec-Fetch-Site: the mode
 * alone must not count, or every Node client would be refused. */
export const fromBrowserPage = (site) => site !== undefined && String(site).trim().toLowerCase() !== 'none';

/**
 * The log of the gate's refusals: the first refusal of each status in a window is logged as it is, the others are counted; when the window
 * ends (or flush() is called, as close() does) one line says how many more there were, by status.
 */
export function createRefusalLog({ log = () => {}, windowMs = DEFAULT_REFUSAL_LOG_WINDOW_MS, now = Date.now } = {}) {
  let seen = new Set();
  let counts = new Map();
  let started = null;
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      const byStatus = [...counts].sort((a, b) => a[0] - b[0]).map(([status, count]) => `${status}: ${count}`).join(', ');
      log(`MCP server: ${total} more refused requests in the last ${Math.max(0, Math.round((now() - started) / 1000))} s (${byStatus})`);
    }
    seen = new Set(); counts = new Map(); started = null;
  };
  return {
    note(status, line) {
      if (started === null) {
        started = now();
        timer = setTimeout(flush, windowMs);
        timer.unref?.();
      }
      if (!seen.has(status)) { seen.add(status); log(line); return; }
      counts.set(status, (counts.get(status) ?? 0) + 1);
    },
    flush,
  };
}

/**
 * Listens on 127.0.0.1:<port> (0: any free port) and serves `factory` behind the gate described at the top of this file.
 * @returns {Promise<{server: http.Server, port: number, url: string, close: () => Promise<void>}>}
 */
export async function startMcpListener({ sdk, port = 0, factory, verifyToken, bodyLimit = DEFAULT_BODY_LIMIT, rateLimit = DEFAULT_RATE_LIMIT, anonymousRateLimit = DEFAULT_ANONYMOUS_RATE_LIMIT,
  refusalLogWindowMs = DEFAULT_REFUSAL_LOG_WINDOW_MS, now = Date.now, log = () => {} } = {}) {
  if (typeof verifyToken !== 'function') throw new TypeError('startMcpListener needs verifyToken.');
  const handler = sdk.createMcpHandler(factory, {
    legacy: 'stateless', maxRequestBodySize: bodyLimit,
    onerror: (error) => log(`MCP server: request rejected by the SDK (${String(error?.code ?? error?.name ?? 'error')})`),
  });
  const serve = sdk.toNodeHandler(handler);
  const limiter = createRateLimiter({ ...rateLimit, now });
  const anonymousLimiter = createRateLimiter({ ...anonymousRateLimit, now });
  const refusals = createRefusalLog({ log, windowMs: refusalLogWindowMs, now });
  let boundPort = null;
  const ownHosts = () => new Set([`${MCP_SERVER_HOST}:${boundPort}`, `localhost:${boundPort}`]);
  const hostAllowed = (host) => typeof host === 'string' && ownHosts().has(host.toLowerCase()) && sdk.validateHostHeader(host, [MCP_SERVER_HOST, 'localhost']).ok === true;
  const originAllowed = (origin) => origin === undefined || (typeof origin === 'string' && [...ownHosts()].some((host) => origin.toLowerCase() === `http://${host}`)
    && sdk.validateOriginHeader(origin, [MCP_SERVER_HOST, 'localhost']).ok === true);

  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    const pathname = String(req.url ?? '').split('?')[0];
    const shownPath = pathname === MCP_SERVER_PATH ? MCP_SERVER_PATH : '(other path)';
    const method = /^[A-Z]{1,10}$/.test(req.method ?? '') ? req.method : '(method)';
    let refused = false;
    res.once('close', () => {
      const line = `MCP server: ${method} ${shownPath} ${res.statusCode} (${Math.round(performance.now() - started)} ms)`;
      if (refused) refusals.note(res.statusCode, line);
      else log(line);
    });
    const refuse = (status, message, headers = {}) => {
      refused = true;
      // A refused client keeps no socket: without this, a flood of refused requests on keep-alive connections fills MAX_CONNECTIONS and the
      // owner's client cannot connect at all.
      res.shouldKeepAlive = false;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close', ...headers });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
    };
    try {
      if (!hostAllowed(req.headers.host)) return refuse(403, 'Forbidden: this MCP server answers only to 127.0.0.1 and localhost on its own port.');
      if (!originAllowed(req.headers.origin)) return refuse(403, 'Forbidden: a request from another origin.');
      if (fromBrowserPage(req.headers['sec-fetch-site'])) return refuse(403, 'Forbidden: a request from a web page.');
      const match = BEARER.exec(req.headers.authorization ?? '');
      const authorized = match !== null && verifyToken(match[1]) === true;
      const allowance = (authorized ? limiter : anonymousLimiter).take(req.socket.remoteAddress ?? 'unknown');
      if (!allowance.ok) return refuse(429, 'Too many requests.', { 'retry-after': String(Math.max(1, Math.ceil(allowance.retryAfterMs / 1000))) });
      if (pathname !== MCP_SERVER_PATH) return refuse(404, 'Not found.');
      if (!match) return refuse(401, 'Unauthorized: this MCP server needs its access token.', { 'www-authenticate': REALM });
      if (!authorized) return refuse(401, 'Unauthorized: the access token is not valid.', { 'www-authenticate': `${REALM}, error="invalid_token"` });
      await serve(req, res);
    } catch {
      if (!res.headersSent) refuse(500, 'Internal error.');
      else res.destroy();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.maxConnections = MAX_CONNECTIONS;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, MCP_SERVER_HOST, () => { server.off('error', reject); resolve(); });
  });
  boundPort = server.address().port;
  let closing = null;
  return {
    server, port: boundPort, url: `http://${MCP_SERVER_HOST}:${boundPort}${MCP_SERVER_PATH}`,
    close: () => (closing ??= (async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
      await Promise.resolve(handler.close?.()).catch(() => {});
      refusals.flush();
    })()),
  };
}

/** The status tool of the Hub: harmless, no workspace. `workspaceTools` are the names of the tools the host serves (lib/mcp/host.mjs mcpHostProvider). */
export function hubMcpProvider({ product = 'DatGold', version, workspaceTools = [] }) {
  const text = JSON.stringify({ product, version, mcpServer: workspaceTools.length ? 'ext-18 host' : 'ext-17 core', workspaceTools: workspaceTools.length ? [...workspaceTools] : 'none yet' });
  return {
    tools: [{
      name: 'hub_status', title: 'DatGold Hub status',
      description: 'Says that the DatGold Hub MCP server runs, and its version. It reads no workspace and changes nothing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }],
    call: async () => ({ content: [{ type: 'text', text }] }),
  };
}

/**
 * Starts the Hub's MCP server when the owner has turned it on. Never throws for what the owner can fix (the setting, the port, the SDK):
 * the answer is in status() and in one log line. `roots` overrides where the SDK is looked for (tests).
 * @returns {Promise<{setting: McpServerSettingStore, tokens: McpServerTokenStore | null, status: () => object, rotate: () => Promise<string>, close: () => Promise<void>}>}
 */
export async function startHubMcpServer({ env = process.env, directory, protector, roots, name, version, dashboardPort, tools, call, log = () => {}, registerSecret = () => {}, bodyLimit, rateLimit, anonymousRateLimit } = {}) {
  const setting = new McpServerSettingStore({ directory, env, log });
  await setting.load();
  const current = setting.current();
  let status = { state: 'off', enabled: current.enabled, source: current.source, port: null, url: null };
  let listener = null;
  const handle = {
    setting, tokens: null,
    status: () => Object.freeze({ ...status }),
    async rotate() {
      if (!handle.tokens) throw Object.assign(new Error('The MCP server is not running.'), { code: 'mcp_server_off', statusCode: 409 });
      const token = await handle.tokens.rotate();
      registerSecret(token);
      return token;
    },
    async close() {
      if (!listener) return;
      const closing = listener;
      listener = null;
      await closing.close();
      status = { ...status, state: 'closed' };
      log('MCP server: closed.');
    },
  };
  const fail = (state, code, line) => { status = { ...status, state, code }; log(`MCP server: not started (${code}): ${line}`); return handle; };
  if (!current.enabled) { log(`MCP server: off (${current.source}); nothing listens.`); return handle; }
  if (current.port === null || current.port === dashboardPort) return fail('failed', 'mcp_server_port_invalid', `the port cannot be used (${current.portSource}; it must be 0 or 1024..65535, not 3006 and not the dashboard's).`);
  let sdk;
  try { sdk = await loadMcpServerSdk(roots ? { roots } : {}); }
  catch (error) { return fail('unavailable', error?.code ?? 'mcp_runtime_invalid', error?.message ?? String(error)); }
  const tokens = new McpServerTokenStore({ directory, protector, log });
  await tokens.load();
  try {
    const made = await tokens.ensure();
    if (made.created) {
      registerSecret(made.token);
      log('MCP server: a new access token was made (kept sealed in mcp-server-token.json).');
    } else {
      registerSecret(await tokens.reveal());
    }
  } catch (error) {
    return fail('failed', 'mcp_server_token_failed', `the access token cannot be made or read (${error?.code ?? 'error'}).`);
  }
  handle.tokens = tokens;
  try {
    const factory = createMcpServerFactory(sdk, { name, version, tools, call });
    listener = await startMcpListener({ sdk, port: current.port, factory, verifyToken: (candidate) => tokens.verify(candidate), log, ...(bodyLimit ? { bodyLimit } : {}), ...(rateLimit ? { rateLimit } : {}), ...(anonymousRateLimit ? { anonymousRateLimit } : {}) });
  } catch (error) {
    return fail('failed', error?.code === 'EADDRINUSE' ? 'mcp_server_port_in_use' : 'mcp_server_listen_failed', `${MCP_SERVER_HOST}:${current.port} (${error?.code ?? error?.message ?? 'error'}).`);
  }
  status = { ...status, state: 'listening', code: undefined, port: listener.port, url: listener.url };
  log(`MCP server: listening on ${listener.url} (loopback only; every request needs the access token).`);
  return handle;
}
