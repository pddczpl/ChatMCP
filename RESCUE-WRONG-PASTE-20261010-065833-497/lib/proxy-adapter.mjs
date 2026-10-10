// Compatibility adapter for pinned MCP SuperAssistant proxy 0.1.8.
// Complete all upstream pages (the upstream manager reads one page), then
// omit outputSchema only on the browser tools/list response. Native Hub
// sessions retain every schema directly from the original servers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { listAll } from './catalog.mjs';

const index = process.argv.indexOf('--package-root');
if (index < 0 || !process.argv[index + 1]) throw new Error('Missing proxy package root.');
const packageRoot = process.argv[index + 1];
process.argv.splice(index, 2);
const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
if (manifest.version !== '0.1.8') throw new Error('Expected proxy 0.1.8.');
const { McpServerManager } = await import(pathToFileURL(path.join(packageRoot, 'dist/lib/mcpServerManager.js')).href);
const require = createRequire(path.join(packageRoot, 'package.json'));
const schemas = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/types.js')).href);
const addServer = McpServerManager.prototype.addServer;
if (typeof addServer !== 'function') throw new Error('Unsupported proxy addServer layout.');
McpServerManager.prototype.addServer = async function (name, config) {
  await addServer.call(this, name, config);
  const server = this.servers.get(name);
  if (!server?.client) throw new Error('Proxy did not retain upstream MCP connection.');
  const caps = server.client.getServerCapabilities() ?? {};
  if (caps.tools) server.tools = await listAll(server.client, 'tools', schemas);
  if (caps.resources) server.resources = await listAll(server.client, 'resources', schemas);
};
const handle = McpServerManager.prototype.handleRequest;
if (typeof handle !== 'function') throw new Error('Unsupported proxy module layout.');
McpServerManager.prototype.handleRequest = async function (request) {
  if (request?.method === 'tools/call' && typeof request.params?.name === 'string') {
    const dot = request.params.name.indexOf('.');
    const server = this.servers.get(request.params.name.slice(0, dot));
    const originalName = request.params.name.slice(dot + 1);
    if (dot > 0 && server?.connected && server.tools.some((t) => t.name === originalName)) {
      // Preserve dots inside an original tool name. The pinned manager's
      // split('.', 2) otherwise drops the rest of that name.
      try {
        const result = await server.client.request({ method: 'tools/call', params: { ...request.params, name: originalName } }, schemas.CallToolResultSchema);
        return { jsonrpc: '2.0', id: request.id, result };
      } catch (error) {
        return { jsonrpc: '2.0', id: request.id, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: String(error.message ?? 'MCP call failed') } };
      }
    }
  }
  const response = await handle.call(this, request);
  if (request?.method !== 'tools/list' || !Array.isArray(response?.result?.tools)) return response;
  return { ...response, result: { ...response.result, tools: response.result.tools.map((tool) => {
    const copy = { ...tool };
    delete copy.outputSchema;
    return copy;
  }) } };
};
await import(pathToFileURL(path.join(packageRoot, 'dist/index.js')).href);
