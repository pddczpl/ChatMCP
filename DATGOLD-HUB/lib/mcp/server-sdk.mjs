// Finds and loads the MCP SERVER SDK (@modelcontextprotocol/server and its Node HTTP adapter @modelcontextprotocol/node, docs/MCP-SERVER.md).
//
// The sibling of lib/mcp/sdk.mjs (the client) and the same rules: the Hub has no runtime npm dependency; the packages are staged by the
// installer into DATGOLD-HUB/runtimes/mcp (scripts/mcp-runtime/stage.mjs) and a developer gets them with `npm ci --ignore-scripts` in
// scripts/mcp-runtime. Nothing imports them when the Hub starts: loadMcpServerSdk() is called only when the owner has turned the MCP server
// on, so a Hub without them starts and reports `mcp_runtime_missing` for the server. The folders tried are the client's
// (defaultRuntimeRoots: CHATMCP_MCP_RUNTIME_DIR when set, else <bundle>/runtimes/mcp, else <bundle>/../scripts/mcp-runtime), and a copy
// whose packages are not the pinned versions is refused (`mcp_runtime_invalid`) instead of being run untested.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultRuntimeRoots } from './sdk.mjs';

export const MCP_SERVER_PACKAGE = '@modelcontextprotocol/server';
export const MCP_SERVER_VERSION = '2.4.0';
export const MCP_NODE_PACKAGE = '@modelcontextprotocol/node';
export const MCP_NODE_VERSION = '2.1.2';
const PINS = Object.freeze([[MCP_SERVER_PACKAGE, MCP_SERVER_VERSION], [MCP_NODE_PACKAGE, MCP_NODE_VERSION]]);
const SERVER_EXPORTS = Object.freeze(['McpServer', 'createMcpHandler', 'fromJsonSchema', 'validateHostHeader', 'validateOriginHeader']);

const fault = (code, message, extra = {}) => Object.assign(new Error(message), { code, statusCode: 503, ...extra });

/** The ESM entry of a package's export map, as an absolute path that stays inside the package folder; null when it is not a plain one. */
function exportEntry(packageFolder, manifest) {
  const target = manifest?.exports?.['.']?.import?.default;
  if (typeof target !== 'string' || !target.startsWith('./')) return null;
  const file = path.resolve(packageFolder, target);
  const relative = path.relative(packageFolder, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? file : null;
}

/**
 * Where the server SDK is, without loading it. A root counts when it holds the server package; then both packages must be there, pinned.
 * @returns {{state: 'ready', root: string, versions: {server: string, node: string}, entries: {server: string, node: string}}
 *   | {state: 'missing', code: 'mcp_runtime_missing', roots: string[]}
 *   | {state: 'invalid', code: 'mcp_runtime_invalid', root: string, detail: string}}
 */
export function locateMcpServerRuntime(roots = defaultRuntimeRoots()) {
  for (const root of roots) {
    const folderOf = (name) => path.join(root, 'node_modules', ...name.split('/'));
    if (!existsSync(path.join(folderOf(MCP_SERVER_PACKAGE), 'package.json'))) continue;
    const entries = {};
    const versions = {};
    for (const [name, version] of PINS) {
      const folder = folderOf(name);
      let manifest;
      try { manifest = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8')); }
      catch { return { state: 'invalid', code: 'mcp_runtime_invalid', root, detail: `the package.json of ${name} cannot be read` }; }
      if (manifest?.name !== name || manifest.version !== version) {
        return { state: 'invalid', code: 'mcp_runtime_invalid', root, detail: `found ${name} ${String(manifest?.version)}, this Hub is tested with ${version}` };
      }
      const entry = exportEntry(folder, manifest);
      if (!entry || !existsSync(entry)) return { state: 'invalid', code: 'mcp_runtime_invalid', root, detail: `the package ${name} is incomplete` };
      const key = name === MCP_SERVER_PACKAGE ? 'server' : 'node';
      entries[key] = entry;
      versions[key] = manifest.version;
    }
    return { state: 'ready', root, versions, entries };
  }
  return { state: 'missing', code: 'mcp_runtime_missing', roots: [...roots] };
}

export function serverRuntimeFault(located) {
  if (located.state === 'missing') return fault('mcp_runtime_missing', 'The MCP server runtime is not installed (DATGOLD-HUB/runtimes/mcp; in a checkout: npm ci --ignore-scripts --prefix scripts/mcp-runtime).');
  return fault('mcp_runtime_invalid', `The MCP server runtime cannot be used: ${located.detail}.`);
}

const loaded = new Map();

/**
 * Imports the server SDK (once per folder) and returns the parts lib/mcp/server.mjs uses.
 * @returns {Promise<Readonly<{root: string, versions: {server: string, node: string}, McpServer: Function, createMcpHandler: Function,
 *   fromJsonSchema: Function, validateHostHeader: Function, validateOriginHeader: Function, toNodeHandler: Function}>>}
 */
export async function loadMcpServerSdk({ roots = defaultRuntimeRoots() } = {}) {
  const located = locateMcpServerRuntime(roots);
  if (located.state !== 'ready') throw serverRuntimeFault(located);
  let pending = loaded.get(located.root);
  if (!pending) {
    pending = importServerSdk(located);
    loaded.set(located.root, pending);
    pending.catch(() => loaded.delete(located.root));
  }
  return pending;
}

async function importServerSdk(located) {
  let server, node;
  try {
    // The adapter imports the server package by name; in the staged layout both are siblings of one node_modules, so it gets this copy.
    [server, node] = await Promise.all([import(pathToFileURL(located.entries.server).href), import(pathToFileURL(located.entries.node).href)]);
  } catch (error) {
    throw fault('mcp_runtime_invalid', `The MCP server runtime cannot be loaded: ${error?.message ?? error}.`);
  }
  const missing = [...SERVER_EXPORTS.filter((name) => typeof server[name] !== 'function'), ...(typeof node.toNodeHandler === 'function' ? [] : ['toNodeHandler'])];
  if (missing.length) throw fault('mcp_runtime_invalid', `The MCP server runtime lacks ${missing.join(', ')}.`);
  return Object.freeze({
    root: located.root,
    versions: Object.freeze({ ...located.versions }),
    McpServer: server.McpServer,
    createMcpHandler: server.createMcpHandler,
    fromJsonSchema: server.fromJsonSchema,
    validateHostHeader: server.validateHostHeader,
    validateOriginHeader: server.validateOriginHeader,
    toNodeHandler: node.toNodeHandler,
  });
}
