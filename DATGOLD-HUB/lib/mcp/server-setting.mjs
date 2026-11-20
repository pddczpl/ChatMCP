// The owner's switch for the Hub's MCP server (docs/MCP-SERVER.md): off unless the owner turns it on.
//
// Said in three places, strongest first, like the switch of project instructions (lib/project-instructions.mjs):
//   1. the environment of the Hub: CHATMCP_MCP_SERVER=on (1, true, yes, enabled) or =off (0, false, no, disabled). Any other value decides
//      nothing. CHATMCP_MCP_SERVER_PORT=<port> sets the port the same way;
//   2. the choice saved in <data>/mcp-server.json ({version: 1, enabled, port?}). No page writes it yet: the connection kit (P6 ext-20)
//      adds the toggle;
//   3. the default: off, port 3008.
// A port is 0 (any free port; the Hub logs the one it got) or 1024..65535, never 3006 (reserved); the dashboard's own port is refused when
// the listener starts (lib/mcp/server.mjs startHubMcpServer).
import path from 'node:path';
import { readJson, writeJson } from '../runtime.mjs';

export const MCP_SERVER_VARIABLE = 'CHATMCP_MCP_SERVER';
export const MCP_SERVER_PORT_VARIABLE = 'CHATMCP_MCP_SERVER_PORT';
export const MCP_SERVER_FILE = 'mcp-server.json';
export const DEFAULT_MCP_SERVER_PORT = 3008;

const OFF = new Set(['off', '0', 'false', 'no', 'disabled']);
const ON = new Set(['on', '1', 'true', 'yes', 'enabled']);

/** A usable port, or null. Accepts a number or the decimal text of one. */
export function mcpServerPort(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port === 0 || (port >= 1024 && port <= 65535 && port !== 3006) ? port : null;
}

const savedChoice = (saved) => (saved !== null && typeof saved === 'object' ? {
  enabled: typeof saved.enabled === 'boolean' ? saved.enabled : null,
  port: saved.port === undefined ? null : saved.port,
} : { enabled: null, port: null });

/**
 * What applies: `enabled` and its `source` ('env' | 'config' | 'default'), the `port` (null with `portError` when the one given cannot be
 * used) and its `portSource`. `saved` is what the file says, whatever decided.
 */
export function mcpServerSetting(env = process.env, saved = null) {
  const value = String(env?.[MCP_SERVER_VARIABLE] ?? '').trim().toLowerCase();
  const decidedByEnvironment = OFF.has(value) || ON.has(value);
  const stored = savedChoice(saved);
  const enabled = decidedByEnvironment ? ON.has(value) : stored.enabled ?? false;
  const source = decidedByEnvironment ? 'env' : stored.enabled === null ? 'default' : 'config';
  const portText = String(env?.[MCP_SERVER_PORT_VARIABLE] ?? '').trim();
  const portSource = portText ? 'env' : stored.port !== null ? 'config' : 'default';
  const given = portSource === 'env' ? portText : portSource === 'config' ? stored.port : DEFAULT_MCP_SERVER_PORT;
  const port = mcpServerPort(given);
  return Object.freeze({
    enabled, source, port, portSource, ...(port === null ? { portError: 'mcp_server_port_invalid' } : {}),
    saved: stored.enabled === null && stored.port === null ? null : Object.freeze({ ...stored }),
    variable: MCP_SERVER_VARIABLE, portVariable: MCP_SERVER_PORT_VARIABLE,
  });
}

/** The saved choice in the Hub's data folder; the environment is read once, when the store is made (the Hub's start). */
export class McpServerSettingStore {
  #env;
  #saved = null;
  #writes = Promise.resolve();

  constructor({ directory, env = process.env, log = () => {} } = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('McpServerSettingStore needs the data folder of the Hub.');
    this.file = path.join(directory, MCP_SERVER_FILE);
    this.log = log;
    this.#env = { [MCP_SERVER_VARIABLE]: env?.[MCP_SERVER_VARIABLE], [MCP_SERVER_PORT_VARIABLE]: env?.[MCP_SERVER_PORT_VARIABLE] };
  }

  /** Reads the saved choice. Never throws: a file that cannot be used costs the saved choice and nothing else (the default is off). */
  async load() {
    this.#saved = null;
    let data;
    try { data = await readJson(this.file); } catch (error) {
      this.log(`MCP server: ${MCP_SERVER_FILE} cannot be read (${error?.code ?? 'invalid JSON'}); the default applies (off).`);
      return;
    }
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) this.#saved = data;
  }

  current() { return mcpServerSetting(this.#env, this.#saved); }

  /**
   * Saves {enabled, port?}. Refused (400) for an `enabled` that is not a boolean or a port that cannot be used, and (409) while the variable
   * decides: it is the stronger setting. The file is written first and the memory follows. Takes effect at the next start of the Hub.
   */
  async set({ enabled, port } = {}) {
    if (typeof enabled !== 'boolean') throw Object.assign(new TypeError('enabled must be true or false.'), { statusCode: 400, code: 'mcp_server_setting_invalid' });
    if (port !== undefined && mcpServerPort(port) === null) throw Object.assign(new TypeError('The port must be 0 or 1024..65535 (not 3006).'), { statusCode: 400, code: 'mcp_server_port_invalid' });
    if (this.current().source === 'env') {
      throw Object.assign(new Error(`${MCP_SERVER_VARIABLE} decides whether the MCP server runs and is stronger than the saved setting.`), { statusCode: 409, code: 'mcp_server_env' });
    }
    const write = this.#writes.catch(() => {}).then(async () => {
      const record = { version: 1, enabled, ...(port !== undefined ? { port: mcpServerPort(port) } : {}) };
      await writeJson(this.file, record);
      this.#saved = record;
      return this.current();
    });
    this.#writes = write;
    return write;
  }
}
