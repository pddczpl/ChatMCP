import { createHash } from 'node:crypto';

// Local in-process tool catalog only; retired MCP enumeration/proxy transports were removed.
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

export function fingerprint(tools) {
  return createHash('sha256').update(stableJson([...tools].sort((a, b) => a.name.localeCompare(b.name)))).digest('hex');
}


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

