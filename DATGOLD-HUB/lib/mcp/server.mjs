// The Hub as an MCP server for local clients (Claude Code, Codex, Claude Desktop): the listener's core (docs/MCP-SERVER.md, P6 ext-17).
//
// A SEPARATE listener on 127.0.0.1:<port> (3008 unless set), never the dashboard's server: the dashboard trusts only its own page and has
// no way to tell local processes apart, this listener trusts only a token. Off by default (lib/mcp/server-setting.mjs). Every request goes
// through the same gate, in this order, before the SDK sees a byte of its body:
//   1. Host must be 127.0.0.1:<port> or localhost:<port> (DNS-rebinding defence; the SDK's validateHostHeader agrees as well)  -> 403
//   2. Origin, when a browser sends one, must be this listener's own origin (the SDK's validateOriginHeader agrees as well)  -> 403
//   3. the rate limit of the client (createRateLimiter; also counts requests without a token)                                -> 429
//   4. the path must be /mcp                                                                                                 -> 404
//   5. Authorization: Bearer <token>, checked in constant time (lib/mcp/server-token.mjs)                                    -> 401
//   6. the SDK (createMcpHandler, stateless: no sessions; 2026-07-28 and 2025 clients), with its body limit                  -> 413
// One log line per request names the method, `/mcp` or `(other path)`, the status and the time: never a header, a query or a body.
//
// Tools come from an injected provider ({tools, call}); ext-17's Hub exposes only `hub_status` (hubMcpProvider), which reads no workspace
// and changes nothing. The verify/read/write profiles and their approvals are P6 ext-18/ext-19.
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { loadMcpServerSdk } from './server-sdk.mjs';
import { McpServerSettingStore } from './server-setting.mjs';
import { McpServerTokenStore } from './server-token.mjs';

export const MCP_SERVER_PATH = '/mcp';
export const MCP_SERVER_HOST = '127.0.0.1';
export const DEFAULT_BODY_LIMIT = 1024 * 1024;
export const DEFAULT_RATE_LIMIT = Object.freeze({ windowMs: 60_000, max: 600 });
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

/**
 * The factory createMcpHandler calls once per request (stateless): a fresh McpServer with the provider's tools, each registered with
 * fromJsonSchema(inputSchema) so that the SDK checks the arguments before `call(name, args, {signal})` runs.
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
      }, async (args, context) => call(tool.name, args ?? {}, { signal: context?.mcpReq?.signal }));
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

/**
 * Listens on 127.0.0.1:<port> (0: any free port) and serves `factory` behind the gate described at the top of this file.
 * @returns {Promise<{server: http.Server, port: number, url: string, close: () => Promise<void>}>}
 */
export async function startMcpListener({ sdk, port = 0, factory, verifyToken, bodyLimit = DEFAULT_BODY_LIMIT, rateLimit = DEFAULT_RATE_LIMIT, now = Date.now, log = () => {} } = {}) {
  if (typeof verifyToken !== 'function') throw new TypeError('startMcpListener needs verifyToken.');
  const handler = sdk.createMcpHandler(factory, {
    legacy: 'stateless', maxRequestBodySize: bodyLimit,
    onerror: (error) => log(`MCP server: request rejected by the SDK (${String(error?.code ?? error?.name ?? 'error')})`),
  });
  const serve = sdk.toNodeHandler(handler);
  const limiter = createRateLimiter({ ...rateLimit, now });
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
    res.once('close', () => log(`MCP server: ${method} ${shownPath} ${res.statusCode} (${Math.round(performance.now() - started)} ms)`));
    const refuse = (status, message, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
    };
    try {
      if (!hostAllowed(req.headers.host)) return refuse(403, 'Forbidden: this MCP server answers only to 127.0.0.1 and localhost on its own port.');
      if (!originAllowed(req.headers.origin)) return refuse(403, 'Forbidden: a request from another origin.');
      const allowance = limiter.take(req.socket.remoteAddress ?? 'unknown');
      if (!allowance.ok) return refuse(429, 'Too many requests.', { 'retry-after': String(Math.max(1, Math.ceil(allowance.retryAfterMs / 1000))) });
      if (pathname !== MCP_SERVER_PATH) return refuse(404, 'Not found.');
      const match = BEARER.exec(req.headers.authorization ?? '');
      if (!match) return refuse(401, 'Unauthorized: this MCP server needs its access token.', { 'www-authenticate': REALM });
      if (!verifyToken(match[1])) return refuse(401, 'Unauthorized: the access token is not valid.', { 'www-authenticate': `${REALM}, error="invalid_token"` });
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
    })()),
  };
}

/** The provider of ext-17's Hub: one harmless status tool, no workspace tool. */
export function hubMcpProvider({ product = 'DatGold', version }) {
  const text = JSON.stringify({ product, version, mcpServer: 'ext-17 core', workspaceTools: 'none yet' });
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
export async function startHubMcpServer({ env = process.env, directory, protector, roots, name, version, dashboardPort, tools, call, log = () => {}, registerSecret = () => {}, bodyLimit, rateLimit } = {}) {
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
    listener = await startMcpListener({ sdk, port: current.port, factory, verifyToken: (candidate) => tokens.verify(candidate), log, ...(bodyLimit ? { bodyLimit } : {}), ...(rateLimit ? { rateLimit } : {}) });
  } catch (error) {
    return fail('failed', error?.code === 'EADDRINUSE' ? 'mcp_server_port_in_use' : 'mcp_server_listen_failed', `${MCP_SERVER_HOST}:${current.port} (${error?.code ?? error?.message ?? 'error'}).`);
  }
  status = { ...status, state: 'listening', code: undefined, port: listener.port, url: listener.url };
  log(`MCP server: listening on ${listener.url} (loopback only; every request needs the access token).`);
  return handle;
}
