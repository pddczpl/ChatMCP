// The owner's list of external MCP servers: <hubDirectory>/mcp-servers.json (docs/MCP-CLIENT.md).
//
//   {"version": 1, "servers": {"<id>": {
//      "transport": "stdio", "command": "npx.cmd", "args": ["-y", "some-server"], "cwd": "C:\\work", "env": {"NAME": "text" | {"secret": "<blob>"}},
//      "enabled": true, "timeouts": {"connectMs": 30000, "callMs": 120000}, "policy": {...}}
//    | {"transport": "http", "url": "https://...", "headers": {"Name": "text" | {"secret": "<blob>"}}, "env": {...}, ...}}}
//
// Rules:
//  * An id is 1-32 of [a-z0-9_-], starting with a letter, with no "__" and no "_" at the end, so that the alias mcp__<server>__<tool> of a
//    hook names one server only; local and studio (the Hub's own tool prefixes) and a few product names are reserved.
//  * "sse" (the legacy HTTP+SSE transport) is refused; http means Streamable HTTP, over https, or plain http to a loopback address only.
//  * A secret value is stored as {"secret": blob}, the blob made by createProtector (lib/secret-box.mjs: Windows DPAPI, AES-GCM elsewhere).
//    These are always stored as secrets, whatever the caller asked: an env name that looks like a credential (SECRET_ENV_NAME of
//    lib/shell-runner.mjs), a header named like one (the short list SECRET_HEADER, or SECRET_ENV_NAME with "-" read as "_": PRIVATE-TOKEN,
//    X-Goog-Api-Key, Ocp-Apim-Subscription-Key ...), and any value that is a URL with a password in it (URL_WITH_PASSWORD of
//    lib/shell-runner.mjs: postgres://u:pw@host, redis://:pw@host). publicServer() and the store's list()/get() never return a secret, in
//    plain or protected form: {secret: true} says only that one is set.
//  * ${NAME} in command, args, cwd, env values, url and header values is replaced by the value of the env entry NAME of the SAME server.
//    A name the server's env map does not declare is a configuration error: nothing reaches into the Hub's environment unasked. The one way
//    to pass a variable of the Hub's environment on is to declare it as its own value: "GITHUB_TOKEN": "${GITHUB_TOKEN}".
//  * `policy` is stored as given (a JSON object, at most 16 KiB); this slice does not enforce it (the permission gate of a later slice does).
import path from 'node:path';
import { isObject, readJson, writeJson } from '../runtime.mjs';
import { SECRET_ENV_NAME, URL_WITH_PASSWORD } from '../shell-runner.mjs';

export const CONFIG_FILE = 'mcp-servers.json';
export const CONFIG_VERSION = 1;
// 1-32 characters; an "_" is always followed by a letter, a digit or "-" (so no "__" and none at the end).
export const SERVER_ID = /^(?=.{1,32}$)[a-z](?:[a-z0-9-]|_(?=[a-z0-9-]))*$/;
export const RESERVED_IDS = Object.freeze(['local', 'studio', 'mcp', 'hub', 'datgold', 'chatmcp']);
export const DEFAULT_TIMEOUTS = Object.freeze({ connectMs: 30_000, callMs: 120_000 });
export const TIMEOUT_LIMITS = Object.freeze({ connectMs: [1_000, 120_000], callMs: [1_000, 900_000] });
export const MAX_SERVERS = 64;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
export const SECRET_HEADER = /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i;
// Set by the transport itself; a configured value would break the protocol or smuggle a second request.
const TRANSPORT_HEADERS = /^(?:host|content-length|content-type|accept|connection|transfer-encoding|upgrade|te|trailer|keep-alive|mcp-session-id|mcp-protocol-version|last-event-id)$/i;
const TEMPLATE = /\$\{([^}]*)\}/g;
const HAS_TEMPLATE = /\$\{[^}]*\}/;
const MAX_TEXT = 8192;
const MAX_ARGS = 256;
const MAX_ENTRIES = 128;
const MAX_POLICY_BYTES = 16 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const KEYS = Object.freeze({
  stdio: new Set(['transport', 'command', 'args', 'cwd', 'env', 'enabled', 'timeouts', 'policy']),
  http: new Set(['transport', 'url', 'headers', 'env', 'enabled', 'timeouts', 'policy']),
});

export const configFault = (code, message) => Object.assign(new Error(message), { code, statusCode: 400 });
const invalid = (where, what) => configFault('mcp_config_invalid', `${where}: ${what}`);

function text(value, where, { max = MAX_TEXT, empty = false } = {}) {
  if (typeof value !== 'string') throw invalid(where, 'must be a string');
  if (!empty && !value) throw invalid(where, 'must not be empty');
  if (value.length > max) throw invalid(where, `is longer than ${max} characters`);
  if (/[\0\r\n]/.test(value)) throw invalid(where, 'must not contain NUL or line breaks');
  return value;
}

/** The ${NAME} references of a text, in order; a malformed reference is an error. */
export function templateNames(value, where) {
  const names = [];
  for (const match of value.matchAll(TEMPLATE)) {
    if (!VARIABLE_NAME.test(match[1])) throw invalid(where, `\${${match[1]}} is not a variable name`);
    names.push(match[1]);
  }
  return names;
}

function checkTemplates(value, where, declared) {
  for (const name of templateNames(value, where)) {
    if (!declared.has(name)) throw configFault('mcp_config_undeclared_variable', `${where}: \${${name}} is not declared in the env map of this server`);
  }
}

/** Whether a header name says that its value is a credential: the short list, or a credential word of SECRET_ENV_NAME ("-" read as "_"). */
export const isCredentialHeader = (name) => SECRET_HEADER.test(name) || SECRET_ENV_NAME.test(name.replace(/-/g, '_'));

/** A URL with a password in it. ${NAME} references are left out first: in postgres://u:${PASS}@db the password is not in the text. */
export const hasUrlPassword = (value) => typeof value === 'string' && URL_WITH_PASSWORD.test(value.replace(TEMPLATE, ''));

/** The password of a URL with one (for the masker: a log line may carry it alone), or null. */
export function urlPassword(value) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:([^/\s@]+)@/i.exec(String(value));
  return match ? match[1] : null;
}

/** Whether this value under this name must be stored as a secret, whatever the caller said. */
export const mustBeSecret = (kind, name, value) => (kind === 'env' ? SECRET_ENV_NAME.test(name) : isCredentialHeader(name)) || hasUrlPassword(value);

/**
 * A value that only refers to other values ("${GITHUB_TOKEN}", "Bearer ${API_TOKEN}"): it holds no credential itself, so it may stay plain
 * under a credential name. Anything else under such a name is a credential in plain text.
 */
export function isReferenceOnly(value) {
  if (typeof value !== 'string' || !HAS_TEMPLATE.test(value)) return false;
  const rest = value.replace(TEMPLATE, '').trim();
  return rest === '' || /^(?:bearer|basic|token)$/i.test(rest);
}

/**
 * One value of an env or headers map. Stored forms: a string (plain) or {secret: blob}. Input forms (save()): a string, {value, secret?}
 * or {keep: true} (keep the secret already stored under this name).
 */
async function normalizeValue(kind, name, raw, where, { protector, previous, input }) {
  if (!input) {
    if (typeof raw === 'string') {
      if (mustBeSecret(kind, name, raw) && !isReferenceOnly(raw)) throw invalid(where, 'holds a credential in plain text; store it as a secret');
      return text(raw, where, { empty: true });
    }
    if (isObject(raw) && Object.keys(raw).length === 1 && typeof raw.secret === 'string' && raw.secret) return { secret: text(raw.secret, where, { max: 65_536 }) };
    throw invalid(where, 'must be a string or {"secret": "..."}');
  }
  if (isObject(raw) && raw.keep === true && Object.keys(raw).length === 1) {
    if (!isObject(previous) || typeof previous.secret !== 'string') throw invalid(where, 'asks to keep a secret, but none is stored under this name');
    return { secret: previous.secret };
  }
  const plain = typeof raw === 'string' ? raw : isObject(raw) && typeof raw.value === 'string' && Object.keys(raw).every((key) => key === 'value' || key === 'secret') ? raw.value : null;
  if (plain === null) throw invalid(where, 'must be a string, {"value": "...", "secret": true|false} or {"keep": true}');
  text(plain, where, { empty: true });
  const secret = (isObject(raw) && raw.secret === true) || (mustBeSecret(kind, name, plain) && !isReferenceOnly(plain));
  if (!secret) return plain;
  if (!protector) throw configFault('mcp_secret_unavailable', `${where}: no secret store is available to protect this value`);
  return { secret: await protector.protect(plain) };
}

async function normalizeMap(kind, raw, where, options) {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw invalid(where, 'must be an object');
  const entries = Object.entries(raw);
  if (entries.length > MAX_ENTRIES) throw invalid(where, `has more than ${MAX_ENTRIES} entries`);
  const output = {};
  const seen = new Set();
  for (const [name, value] of entries) {
    if (!(kind === 'env' ? VARIABLE_NAME : HEADER_NAME).test(name)) throw invalid(`${where}.${name}`, 'is not a valid name');
    const key = name.toLowerCase();
    if (seen.has(key)) throw invalid(`${where}.${name}`, 'is given twice (names are compared without case)');
    seen.add(key);
    if (kind === 'headers' && TRANSPORT_HEADERS.test(name)) throw invalid(`${where}.${name}`, 'is set by the transport and cannot be configured');
    output[name] = await normalizeValue(kind, name, value, `${where}.${name}`, { ...options, previous: options.previousMap?.[name] });
  }
  return output;
}

function checkUrl(value, where) {
  text(value, where);
  let url;
  try { url = new URL(value.replace(TEMPLATE, 'x')); } catch { throw invalid(where, 'is not a URL'); }
  if (url.username || url.password) throw invalid(where, 'must not carry a user name or password; use a secret header');
  if (url.protocol === 'https:') return value;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return value;
  throw invalid(where, 'must be https://, or http:// to 127.0.0.1, [::1] or localhost');
}

function normalizeTimeouts(raw, where) {
  if (raw === undefined) return { ...DEFAULT_TIMEOUTS };
  if (!isObject(raw)) throw invalid(where, 'must be an object');
  const output = { ...DEFAULT_TIMEOUTS };
  for (const [key, value] of Object.entries(raw)) {
    const limits = TIMEOUT_LIMITS[key];
    if (!limits) throw invalid(`${where}.${key}`, 'is not a known timeout');
    if (!Number.isSafeInteger(value) || value < limits[0] || value > limits[1]) throw invalid(`${where}.${key}`, `must be a whole number of milliseconds from ${limits[0]} to ${limits[1]}`);
    output[key] = value;
  }
  return output;
}

function normalizePolicy(raw, where) {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw invalid(where, 'must be an object');
  const json = JSON.stringify(raw);
  if (Buffer.byteLength(json) > MAX_POLICY_BYTES) throw invalid(where, `is larger than ${MAX_POLICY_BYTES} bytes`);
  return JSON.parse(json);
}

/**
 * Checks one server and returns its stored form. With `input: true` the values come from a caller (save()) and secrets are protected
 * here; without it they come from the file and must already be in stored form.
 */
export async function normalizeServer(id, raw, { protector = null, input = false, previous = null } = {}) {
  const where = `servers.${id}`;
  if (!SERVER_ID.test(id)) throw invalid(where, 'the id must be 1-32 characters of a-z, 0-9, _ and -, starting with a letter, with no "__" and no "_" at the end');
  if (RESERVED_IDS.includes(id)) throw invalid(where, 'this id is reserved');
  if (!isObject(raw)) throw invalid(where, 'must be an object');
  if (raw.transport === 'sse') throw configFault('mcp_transport_unsupported', `${where}.transport: the legacy HTTP+SSE transport is not supported; use "http" (Streamable HTTP)`);
  const keys = KEYS[raw.transport];
  if (!keys) throw invalid(`${where}.transport`, 'must be "stdio" or "http"');
  for (const key of Object.keys(raw)) if (!keys.has(key)) throw invalid(`${where}.${key}`, `is not a setting of a ${raw.transport} server`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw invalid(`${where}.enabled`, 'must be true or false');
  const env = await normalizeMap('env', raw.env, `${where}.env`, { protector, input, previousMap: previous?.env });
  const declared = new Set(Object.keys(env));
  const server = { transport: raw.transport };
  if (raw.transport === 'stdio') {
    server.command = text(raw.command, `${where}.command`, { max: 4096 });
    checkTemplates(server.command, `${where}.command`, declared);
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.length > MAX_ARGS)) throw invalid(`${where}.args`, `must be a list of at most ${MAX_ARGS} strings`);
    server.args = (raw.args ?? []).map((arg, index) => {
      text(arg, `${where}.args[${index}]`, { empty: true });
      checkTemplates(arg, `${where}.args[${index}]`, declared);
      return arg;
    });
    if (raw.cwd !== undefined) {
      text(raw.cwd, `${where}.cwd`, { max: 4096 });
      checkTemplates(raw.cwd, `${where}.cwd`, declared);
      if (!templateNames(raw.cwd, `${where}.cwd`).length && !path.isAbsolute(raw.cwd)) throw invalid(`${where}.cwd`, 'must be an absolute path');
      server.cwd = raw.cwd;
    }
  } else {
    server.url = checkUrl(raw.url, `${where}.url`);
    checkTemplates(server.url, `${where}.url`, declared);
    server.headers = await normalizeMap('headers', raw.headers, `${where}.headers`, { protector, input, previousMap: previous?.headers });
    for (const [name, value] of Object.entries(server.headers)) if (typeof value === 'string') checkTemplates(value, `${where}.headers.${name}`, declared);
  }
  for (const [name, value] of Object.entries(env)) if (typeof value === 'string') checkTemplates(value, `${where}.env.${name}`, declared);
  server.env = env;
  server.enabled = raw.enabled ?? true;
  server.timeouts = normalizeTimeouts(raw.timeouts, `${where}.timeouts`);
  server.policy = normalizePolicy(raw.policy, `${where}.policy`);
  return server;
}

/** What the UI may see of a map: plain values, and {secret: true} where a secret is set. */
const publicMap = (map) => Object.fromEntries(Object.entries(map ?? {}).map(([name, value]) => [name, typeof value === 'string' ? { value, secret: false } : { secret: true }]));

/** A stored server as the UI may see it. No secret, in plain or protected form. */
export function publicServer(id, server) {
  const view = { id, transport: server.transport, enabled: server.enabled, timeouts: { ...server.timeouts }, policy: structuredClone(server.policy), env: publicMap(server.env) };
  if (server.transport === 'stdio') Object.assign(view, { command: server.command, args: [...server.args], ...(server.cwd ? { cwd: server.cwd } : {}) });
  else Object.assign(view, { url: server.url, headers: publicMap(server.headers) });
  return view;
}

/**
 * The values of a server's env map, unprotected and with their ${NAME} references replaced. An entry that names itself ("X": "${X}") takes
 * the Hub's variable X (an error when it is not set); any other reference must be an entry of the same map. Cycles are errors.
 * @returns {{values: Map<string, string>, secret: Set<string>}} secret: the names whose value is a secret
 */
export async function resolveEnvironment(id, env, { protector, parentEnv = process.env, platform = process.platform }) {
  const raw = new Map();
  const secret = new Set();
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string') raw.set(name, value);
    else {
      if (!protector) throw configFault('mcp_secret_unavailable', `servers.${id}.env.${name}: no secret store is available to read this value`);
      raw.set(name, await protector.unprotect(value.secret));
      secret.add(name);
    }
  }
  const parent = (name) => {
    if (Object.hasOwn(parentEnv, name)) return parentEnv[name];
    if (platform !== 'win32') return undefined;
    const key = Object.keys(parentEnv).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : parentEnv[key];
  };
  const values = new Map();
  const visiting = new Set();
  const resolve = (name) => {
    if (values.has(name)) return values.get(name);
    if (visiting.has(name)) throw configFault('mcp_config_invalid', `servers.${id}.env.${name}: its value refers back to itself through other entries`);
    visiting.add(name);
    const value = raw.get(name).replace(TEMPLATE, (_, reference) => {
      if (reference === name) {
        const inherited = parent(name);
        if (typeof inherited !== 'string') throw configFault('mcp_env_missing', `servers.${id}.env.${name}: it passes on the Hub's variable ${name}, which is not set`);
        return inherited;
      }
      if (!raw.has(reference)) throw configFault('mcp_config_undeclared_variable', `servers.${id}.env.${name}: \${${reference}} is not declared in the env map of this server`);
      const referenced = resolve(reference);
      if (secret.has(reference)) secret.add(name);
      return referenced;
    });
    visiting.delete(name);
    values.set(name, value);
    return value;
  };
  for (const name of raw.keys()) resolve(name);
  // A credential-looking name holds a secret however its value was made (a reference, a pass-through): the masker must know it.
  for (const name of raw.keys()) if (SECRET_ENV_NAME.test(name)) secret.add(name);
  // So does a value that is a URL with a password, however it was put together (postgres://u:${PASS}@db once expanded).
  for (const name of raw.keys()) if (URL_WITH_PASSWORD.test(values.get(name))) secret.add(name);
  return { values, secret };
}

/** Replaces the ${NAME} references of a text by the resolved env values; `used` collects the names it took. */
export function expandTemplate(value, values, where, used = null) {
  return value.replace(TEMPLATE, (_, name) => {
    if (!values.has(name)) throw configFault('mcp_config_undeclared_variable', `${where}: \${${name}} is not declared in the env map of this server`);
    used?.add(name);
    return values.get(name);
  });
}

export class McpServerStore {
  /**
   * @param {{hubDirectory: string, protector?: {protect: Function, unprotect: Function} | null, registerSecret?: (value: string) => void}} options
   */
  constructor({ hubDirectory, protector = null, registerSecret = () => {} }) {
    if (!hubDirectory) throw new TypeError('McpServerStore requires hubDirectory.');
    this.file = path.join(path.resolve(hubDirectory), CONFIG_FILE);
    this.protector = protector;
    this.registerSecret = registerSecret;
    this.servers = new Map();
    this.loaded = false;
  }

  /** Reads the file (a missing file is an empty list). A file that breaks a rule is refused whole, with the place of the first fault. */
  async load() {
    const data = await readJson(this.file).catch((error) => { throw configFault('mcp_config_invalid', `${CONFIG_FILE}: ${error.message}`); });
    const servers = new Map();
    if (data !== null) {
      if (!isObject(data) || data.version !== CONFIG_VERSION || !isObject(data.servers)) throw configFault('mcp_config_invalid', `${CONFIG_FILE}: expected {"version": ${CONFIG_VERSION}, "servers": {...}}`);
      const entries = Object.entries(data.servers);
      if (entries.length > MAX_SERVERS) throw configFault('mcp_config_invalid', `${CONFIG_FILE}: more than ${MAX_SERVERS} servers`);
      for (const [id, raw] of entries) servers.set(id, await normalizeServer(id, raw));
    }
    this.servers = servers;
    this.loaded = true;
    return this.list();
  }

  async #ensureLoaded() { if (!this.loaded) await this.load(); }

  /** Every server as the UI may see it. */
  list() { return [...this.servers].map(([id, server]) => publicServer(id, server)); }

  get(id) {
    const server = this.servers.get(id);
    return server ? publicServer(id, server) : null;
  }

  /** Adds or replaces one server from caller input (see normalizeValue for the forms of a value). Returns what the UI may see. */
  async save(id, input) {
    await this.#ensureLoaded();
    if (!this.servers.has(id) && this.servers.size >= MAX_SERVERS) throw configFault('mcp_config_invalid', `at most ${MAX_SERVERS} servers can be configured`);
    const server = await normalizeServer(id, input, { protector: this.protector, input: true, previous: this.servers.get(id) ?? null });
    const next = new Map(this.servers).set(id, server);
    await this.#write(next);
    return publicServer(id, server);
  }

  async remove(id) {
    await this.#ensureLoaded();
    if (!this.servers.has(id)) return false;
    const next = new Map(this.servers);
    next.delete(id);
    await this.#write(next);
    return true;
  }

  async #write(servers) {
    await writeJson(this.file, { version: CONFIG_VERSION, servers: Object.fromEntries(servers) });
    this.servers = servers;
  }

  /**
   * What a connection needs, with secrets unprotected and templates expanded. FOR lib/mcp/client-manager.mjs ONLY: the result holds
   * secrets in plain text and must never be returned to a caller outside lib/mcp, logged or stored. Every secret value is registered with
   * `registerSecret` (the Hub's masker) before this returns.
   */
  async resolveForConnect(id, { parentEnv = process.env, platform = process.platform } = {}) {
    await this.#ensureLoaded();
    const server = this.servers.get(id);
    if (!server) throw Object.assign(configFault('mcp_server_unknown', `No MCP server "${id}" is configured.`), { statusCode: 404 });
    if (!server.enabled) throw Object.assign(configFault('mcp_server_disabled', `The MCP server "${id}" is disabled.`), { statusCode: 409 });
    const { values, secret } = await resolveEnvironment(id, server.env, { protector: this.protector, parentEnv, platform });
    const secrets = new Set();
    for (const name of secret) secrets.add(values.get(name));
    const expand = (value, where) => expandTemplate(value, values, `servers.${id}.${where}`);
    const resolved = { id, transport: server.transport, timeouts: { ...server.timeouts }, env: Object.fromEntries(values) };
    if (server.transport === 'stdio') {
      resolved.command = expand(server.command, 'command');
      resolved.args = server.args.map((arg, index) => expand(arg, `args[${index}]`));
      if (server.cwd) {
        resolved.cwd = expand(server.cwd, 'cwd');
        if (!path.isAbsolute(resolved.cwd)) throw configFault('mcp_config_invalid', `servers.${id}.cwd: must be an absolute path`);
      }
    } else {
      resolved.url = checkUrl(expand(server.url, 'url'), `servers.${id}.url`);
      resolved.headers = {};
      for (const [name, value] of Object.entries(server.headers)) {
        if (typeof value === 'string') {
          resolved.headers[name] = expand(value, `headers.${name}`);
          if (mustBeSecret('headers', name, resolved.headers[name])) secrets.add(resolved.headers[name]);
        } else {
          if (!this.protector) throw configFault('mcp_secret_unavailable', `servers.${id}.headers.${name}: no secret store is available to read this value`);
          resolved.headers[name] = await this.protector.unprotect(value.secret);
          secrets.add(resolved.headers[name]);
        }
      }
    }
    // The password of a URL is registered on its own as well: a log line may carry it without the rest of the URL.
    for (const value of [...secrets]) { const password = urlPassword(value); if (password && password.length >= 4) secrets.add(password); }
    for (const value of secrets) if (value) this.registerSecret(value);
    resolved.secrets = [...secrets].filter(Boolean);
    return resolved;
  }
}
