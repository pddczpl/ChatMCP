import { createHash } from 'node:crypto';

const LISTS = {
  tools: ['tools/list', 'tools', 'ListToolsResultSchema'],
  prompts: ['prompts/list', 'prompts', 'ListPromptsResultSchema'],
  resources: ['resources/list', 'resources', 'ListResourcesResultSchema'],
  resourceTemplates: ['resources/templates/list', 'resourceTemplates', 'ListResourceTemplatesResultSchema'],
};

// A repeated cursor or an unreasonable stream is an error, never a successful
// partial inventory. Schema objects are kept intact for the agent and UI.
export async function listAll(client, kind, schemas, { signal, timeout = 30000 } = {}) {
  const entry = LISTS[kind];
  if (!entry) throw new Error('Loại danh mục MCP không hợp lệ.');
  const [method, field, schemaName] = entry;
  const result = [];
  const seen = new Set();
  let cursor;
  do {
    signal?.throwIfAborted();
    let page;
    try { page = await client.request({ method, params: cursor === undefined ? {} : { cursor } }, schemas[schemaName], { signal, timeout }); }
    catch (error) {
      // MCP resources capability does not independently advertise templates.
      // An unimplemented optional templates method is not a missing tool.
      if (kind === 'resourceTemplates' && cursor === undefined && error.code === -32601) return [];
      throw error;
    }
    if (!Array.isArray(page?.[field])) throw new Error(`${method} không trả một danh sách hợp lệ.`);
    result.push(...page[field]);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error(`${method} trả cursor lặp hoặc không hợp lệ; chưa thể xác nhận đủ danh mục.`);
      seen.add(cursor);
      if (seen.size > 1000) throw new Error(`${method} vượt 1000 trang; dừng kiểm tra thay vì bỏ bớt công cụ.`);
    }
  } while (cursor !== undefined);
  return result;
}

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

export function fingerprint(tools) {
  return createHash('sha256').update(stableJson([...tools].sort((a, b) => a.name.localeCompare(b.name)))).digest('hex');
}

export async function collectCatalog(connections, schemas, options = {}) {
  const catalog = { ready: false, tools: [], prompts: [], resources: [], resourceTemplates: [], counts: {}, servers: {}, checkedAt: new Date().toISOString() };
  for (const [server, connection] of connections) {
    const client = connection.client ?? connection;
    const capabilities = client.getServerCapabilities() ?? {};
    const info = client.getServerVersion() ?? {};
    const serverData = { serverInfo: info, capabilities, tools: 0, prompts: 0, resources: 0, resourceTemplates: 0 };
    for (const kind of Object.keys(LISTS)) {
      const supported = kind === 'resourceTemplates' ? capabilities.resources : capabilities[kind];
      if (!supported) continue;
      const entries = await listAll(client, kind, schemas, options);
      const identities = new Set();
      for (const original of entries) {
        const identity = kind === 'resources' ? original.uri : kind === 'resourceTemplates' ? original.uriTemplate : original.name;
        if (typeof identity !== 'string' || !identity || identities.has(identity)) throw new Error(`${server}: ${kind} có mục thiếu tên hoặc trùng tên.`);
        identities.add(identity);
        const item = { ...structuredClone(original), server };
        if (kind === 'tools' || kind === 'prompts') {
          item.originalName = original.name;
          item.name = `${server}.${original.name}`;
        }
        catalog[kind].push(item);
      }
      serverData[kind] = entries.length;
    }
    catalog.counts[server] = serverData.tools;
    catalog.servers[server] = serverData;
  }
  const names = new Set(catalog.tools.map((t) => t.name));
  if (names.size !== catalog.tools.length) throw new Error('Tên công cụ MCP bị trùng sau khi ghép server.');
  catalog.fingerprint = fingerprint(catalog.tools);
  catalog.ready = true;
  return catalog;
}

/**
 * Catalog for tools that run inside the Hub process: no MCP connection is involved, so the definitions are
 * taken as given. `groups` maps a server name to its tool definitions ({name:'server.tool', originalName, ...}).
 */
export function buildInternalCatalog(groups, { version = '0' } = {}) {
  const catalog = { ready: false, tools: [], prompts: [], resources: [], resourceTemplates: [], counts: {}, servers: {}, checkedAt: new Date().toISOString() };
  for (const [server, definitions] of Object.entries(groups)) {
    for (const definition of definitions) {
      if (typeof definition?.name !== 'string' || !definition.name.startsWith(`${server}.`) || typeof definition.originalName !== 'string') throw new Error(`Định nghĩa công cụ nội bộ của ${server} thiếu tên đầy đủ.`);
      catalog.tools.push({ ...structuredClone(definition), server });
    }
    catalog.counts[server] = definitions.length;
    catalog.servers[server] = { serverInfo: { name: `chatmcp-${server}`, version }, capabilities: { tools: {} }, tools: definitions.length, prompts: 0, resources: 0, resourceTemplates: 0 };
  }
  const names = new Set(catalog.tools.map((tool) => tool.name));
  if (names.size !== catalog.tools.length) throw new Error('Tên công cụ nội bộ bị trùng.');
  catalog.fingerprint = fingerprint(catalog.tools);
  catalog.ready = true;
  return catalog;
}

export function verifyProxyCatalog(sourceTools, proxyTools) {
  const actual = new Map(proxyTools.map((t) => [t.name, t]));
  if (actual.size !== proxyTools.length) throw new Error('Danh mục proxy có tên công cụ trùng nhau.');
  const missing = [];
  const changed = [];
  for (const tool of sourceTools) {
    const proxy = actual.get(tool.name);
    if (!proxy) missing.push(tool.name);
    else if (stableJson(proxy.inputSchema) !== stableJson(tool.inputSchema)) changed.push(tool.name);
  }
  if (missing.length || changed.length) {
    const error = new Error(`Danh mục proxy chưa đầy đủ: thiếu ${missing.length} tool, lệch input schema ${changed.length}. ${[...missing, ...changed].join(', ')}`);
    error.missing = missing; error.changed = changed; throw error;
  }
  return { expected: sourceTools.length, matched: sourceTools.length, missing: [], changed: [] };
}

export async function closeConnection(connection) {
  if (!connection) return;
  if (connection.transport.sessionId && typeof connection.transport.terminateSession === 'function') {
    let timer;
    await Promise.race([
      connection.transport.terminateSession().catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, 1500); }),
    ]);
    clearTimeout(timer);
  }
  await connection.client.close().catch(() => {});
}

export function makeAgentSession(connections, catalog, schemas, { bindingCheck = () => {} } = {}) {
  const tools = new Map(catalog.tools.map((t) => [t.name, t]));
  const prompts = new Map(catalog.prompts.map((p) => [p.name, p]));
  let closed = false;
  function check() { if (closed) throw new Error('Phiên MCP đã đóng.'); bindingCheck(); }
  return {
    catalog,
    async callTool(name, args, { signal, timeout = 180000 } = {}) {
      check(); signal?.throwIfAborted();
      const definition = tools.get(name);
      if (!definition) throw new Error(`Không có công cụ ${name} trong danh mục đã kiểm tra.`);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tham số công cụ phải là JSON object.');
      const client = connections.get(definition.server).client;
      const params = { name: definition.originalName, arguments: args };
      // Use the original schema metadata to honor task-required tools too.
      // Do not replay a call after any timeout or lost response.
      if (definition.execution?.taskSupport === 'required') {
        const tasks = client.experimental?.tasks;
        if (!tasks?.callToolStream) throw new Error(`${name} cần MCP tasks mà SDK hiện tại chưa hỗ trợ.`);
        let taskId;
        const onAbort = () => { if (taskId) void tasks.cancelTask(taskId, { timeout: 3000 }).catch(() => {}); };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          for await (const item of tasks.callToolStream(params, schemas.CallToolResultSchema, { signal, timeout, task: {} })) {
            if (item.type === 'taskCreated') { taskId = item.task.taskId; if (signal?.aborted) onAbort(); }
            else if (item.type === 'result') return item.result;
            else if (item.type === 'error') throw item.error;
          }
          throw new Error(`${name} kết thúc mà chưa có kết quả.`);
        } finally { signal?.removeEventListener('abort', onAbort); }
      }
      return await client.request({ method: 'tools/call', params }, schemas.CallToolResultSchema, { signal, timeout, resetTimeoutOnProgress: true, maxTotalTimeout: timeout });
    },
    async getPrompt(server, name, args = {}, options = {}) {
      check();
      if (!prompts.has(`${server}.${name}`)) throw new Error('Prompt không có trong danh mục MCP hiện tại.');
      return await connections.get(server).client.getPrompt({ name, arguments: args }, { timeout: 30000, ...options });
    },
    async readResource(server, uri, options = {}) {
      check();
      const connection = connections.get(server);
      if (!connection || !catalog.servers[server].capabilities.resources) throw new Error('Server không cung cấp MCP resources.');
      if (typeof uri !== 'string' || !uri) throw new Error('Resource URI không hợp lệ.');
      // URI templates are intentionally allowed; the upstream owns validation.
      return await connection.client.readResource({ uri }, { timeout: 30000, ...options });
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...connections.values()].map(closeConnection));
    },
  };
}
