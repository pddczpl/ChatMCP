// Finds and loads the MCP client SDK (@modelcontextprotocol/client, docs/MCP-CLIENT.md).
//
// The Hub has no runtime npm dependency. The SDK and its closure are staged by the installer into DATGOLD-HUB/runtimes/mcp
// (scripts/mcp-runtime/stage.mjs); a developer gets the same packages with `npm ci --ignore-scripts` in scripts/mcp-runtime. Nothing
// imports the SDK when the Hub starts: loadMcpSdk() imports it the first time a server is connected, so a Hub without it starts, serves
// /api/health, and reports the code `mcp_runtime_missing` (status of lib/mcp/client-manager.mjs).
//
// Where it is looked for, first match wins: CHATMCP_MCP_RUNTIME_DIR when set (and then ONLY there), else <bundle>/runtimes/mcp (the
// installed layout), else <bundle>/../scripts/mcp-runtime (a checkout). A copy whose client is not the pinned version is refused
// (`mcp_runtime_invalid`) instead of being run untested: MCP_CLIENT_VERSION must equal the pin of scripts/mcp-runtime/package.json.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MCP_CLIENT_PACKAGE = '@modelcontextprotocol/client';
export const MCP_CLIENT_VERSION = '2.4.0';
export const RUNTIME_DIR_ENV = 'CHATMCP_MCP_RUNTIME_DIR';
const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REQUIRED_EXPORTS = Object.freeze(['Client', 'StreamableHTTPClientTransport', 'ReadBuffer', 'serializeMessage', 'deserializeMessage', 'SdkError', 'SdkErrorCode']);

const fault = (code, message, extra = {}) => Object.assign(new Error(message), { code, statusCode: 503, ...extra });

/** The folders that may hold node_modules/@modelcontextprotocol/client, in the order they are tried. */
export function defaultRuntimeRoots(bundleRoot = HUB_ROOT, env = process.env) {
  const override = typeof env[RUNTIME_DIR_ENV] === 'string' ? env[RUNTIME_DIR_ENV].trim() : '';
  if (override) return [path.resolve(override)];
  return [path.join(bundleRoot, 'runtimes', 'mcp'), path.join(bundleRoot, '..', 'scripts', 'mcp-runtime')];
}

/** An entry of the package's export map, as an absolute path that stays inside the package folder; null when it is not a plain one. */
function exportEntry(packageFolder, manifest, subpath) {
  const target = manifest?.exports?.[subpath]?.import?.default;
  if (typeof target !== 'string' || !target.startsWith('./')) return null;
  const file = path.resolve(packageFolder, target);
  const relative = path.relative(packageFolder, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? file : null;
}

/**
 * Where the SDK is, without loading it (cheap and synchronous: status() calls it).
 * @returns {{state: 'ready', root: string, version: string, packageJson: string, entries: {index: string, stdio: string}}
 *   | {state: 'missing', code: 'mcp_runtime_missing', roots: string[]}
 *   | {state: 'invalid', code: 'mcp_runtime_invalid', root: string, detail: string}}
 */
export function locateMcpRuntime(roots = defaultRuntimeRoots()) {
  for (const root of roots) {
    const packageFolder = path.join(root, 'node_modules', ...MCP_CLIENT_PACKAGE.split('/'));
    const packageJson = path.join(packageFolder, 'package.json');
    if (!existsSync(packageJson)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(packageJson, 'utf8')); }
    catch { return { state: 'invalid', code: 'mcp_runtime_invalid', root, detail: 'the package.json of the MCP client cannot be read' }; }
    if (manifest?.name !== MCP_CLIENT_PACKAGE || manifest.version !== MCP_CLIENT_VERSION) {
      return { state: 'invalid', code: 'mcp_runtime_invalid', root, detail: `found ${MCP_CLIENT_PACKAGE} ${String(manifest?.version)}, this Hub is tested with ${MCP_CLIENT_VERSION}` };
    }
    const index = exportEntry(packageFolder, manifest, '.');
    const stdio = exportEntry(packageFolder, manifest, './stdio');
    if (!index || !stdio || !existsSync(index) || !existsSync(stdio)) return { state: 'invalid', code: 'mcp_runtime_invalid', root, detail: 'the MCP client package is incomplete' };
    return { state: 'ready', root, version: manifest.version, packageJson, entries: { index, stdio } };
  }
  return { state: 'missing', code: 'mcp_runtime_missing', roots: [...roots] };
}

export function runtimeFault(located) {
  if (located.state === 'missing') return fault('mcp_runtime_missing', 'The MCP client runtime is not installed (DATGOLD-HUB/runtimes/mcp; in a checkout: npm ci --ignore-scripts --prefix scripts/mcp-runtime).');
  return fault('mcp_runtime_invalid', `The MCP client runtime cannot be used: ${located.detail}.`);
}

const loaded = new Map();

/**
 * Imports the SDK (once per folder) and returns the parts the client manager uses.
 * @returns {Promise<Readonly<{root: string, version: string, Client: Function, StreamableHTTPClientTransport: Function, ReadBuffer: Function,
 *   serializeMessage: Function, deserializeMessage: Function, SdkError: Function, SdkErrorCode: object, inheritedEnvironment: readonly string[], spawn: Function}>>}
 */
export async function loadMcpSdk({ roots = defaultRuntimeRoots() } = {}) {
  const located = locateMcpRuntime(roots);
  if (located.state !== 'ready') throw runtimeFault(located);
  let pending = loaded.get(located.root);
  if (!pending) {
    pending = importSdk(located);
    loaded.set(located.root, pending);
    pending.catch(() => loaded.delete(located.root));
  }
  return pending;
}

async function importSdk(located) {
  let index, stdio, spawn;
  try {
    [index, stdio] = await Promise.all([import(pathToFileURL(located.entries.index).href), import(pathToFileURL(located.entries.stdio).href)]);
    // The SDK spawns stdio servers with cross-spawn (it runs a .cmd shim such as npx.cmd through cmd.exe with correct quoting); the Hub's own
    // stdio transport uses the same copy, resolved from the client package so that it is the one of the closure.
    spawn = createRequire(located.packageJson)('cross-spawn');
  } catch (error) {
    throw fault('mcp_runtime_invalid', `The MCP client runtime cannot be loaded: ${error?.message ?? error}.`);
  }
  const missing = REQUIRED_EXPORTS.filter((name) => index[name] === undefined);
  if (missing.length || !Array.isArray(stdio.DEFAULT_INHERITED_ENV_VARS) || typeof spawn !== 'function') {
    throw fault('mcp_runtime_invalid', `The MCP client runtime lacks ${[...missing, ...(Array.isArray(stdio.DEFAULT_INHERITED_ENV_VARS) ? [] : ['DEFAULT_INHERITED_ENV_VARS']), ...(typeof spawn === 'function' ? [] : ['cross-spawn'])].join(', ')}.`);
  }
  return Object.freeze({
    root: located.root,
    version: located.version,
    Client: index.Client,
    StreamableHTTPClientTransport: index.StreamableHTTPClientTransport,
    ReadBuffer: index.ReadBuffer,
    serializeMessage: index.serializeMessage,
    deserializeMessage: index.deserializeMessage,
    SdkError: index.SdkError,
    SdkErrorCode: index.SdkErrorCode,
    inheritedEnvironment: Object.freeze([...stdio.DEFAULT_INHERITED_ENV_VARS]),
    spawn,
  });
}
