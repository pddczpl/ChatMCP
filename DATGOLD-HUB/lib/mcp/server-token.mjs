// The bearer token of the Hub's MCP server (docs/MCP-SERVER.md).
//
// 256 random bits, written as `dgmcp_` + base64url (the prefix lets secret scanners and people recognise it). <data>/mcp-server-token.json
// keeps its SHA-256 (what a request is checked against) and a copy sealed by the Hub's protector (lib/secret-box.mjs createProtector:
// Windows DPAPI, else AES-GCM with the data folder's master key), from which the connection kit (P6 ext-20) can show it to the owner. The
// token itself is never written in clear and never logged. A presented token is hashed and the two digests are compared with
// timingSafeEqual, so the comparison takes the same time whatever the candidate is. rotate() makes a new token and the old one is refused
// from the next request on.
//
// The token has a scope (P6 ext-19, lib/mcp/server-scope.mjs): the tool profiles a client that presents it may call. A new token has
// verify alone; setScope() is the owner's choice (the connection kit of ext-20 offers it) and rotate() keeps it. A file of ext-17 has no
// scope and means verify; a scope in the file that is not a valid one is no profile at all (fail closed), and a line of the log says so.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson } from '../runtime.mjs';
import { DEFAULT_SCOPE, normalizeScope, scopeOrNone } from './server-scope.mjs';

export const MCP_TOKEN_FILE = 'mcp-server-token.json';
export const MCP_TOKEN_PREFIX = 'dgmcp_';
const TOKEN_BYTES = 32;
const digest = (text) => createHash('sha256').update(text, 'utf8').digest();

export class McpServerTokenStore {
  #hash = null;
  #sealed = null;
  #createdAt = null;
  #scope = DEFAULT_SCOPE;
  #writes = Promise.resolve();

  constructor({ directory, protector, log = () => {} } = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('McpServerTokenStore needs the data folder of the Hub.');
    if (!protector || typeof protector.protect !== 'function' || typeof protector.unprotect !== 'function') throw new TypeError('McpServerTokenStore needs a protector.');
    this.file = path.join(directory, MCP_TOKEN_FILE);
    this.protector = protector;
    this.log = log;
  }

  /** Reads the stored digest. Never throws: a file that cannot be used is no token (ensure() then makes a new one). */
  async load() {
    this.#hash = null; this.#sealed = null; this.#createdAt = null; this.#scope = DEFAULT_SCOPE;
    let data;
    try { data = await readJson(this.file); } catch (error) {
      this.log(`MCP server: ${MCP_TOKEN_FILE} cannot be read (${error?.code ?? 'invalid JSON'}); a new token will be made.`);
      return;
    }
    if (data === null) return;
    if (data?.version !== 1 || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256) || typeof data.sealed !== 'string' || !data.sealed) {
      this.log(`MCP server: ${MCP_TOKEN_FILE} holds no usable token; a new token will be made.`);
      return;
    }
    this.#hash = Buffer.from(data.sha256, 'hex');
    this.#sealed = data.sealed;
    this.#createdAt = typeof data.createdAt === 'string' ? data.createdAt : null;
    if (data.scope !== undefined) {
      this.#scope = scopeOrNone(data.scope);
      if (this.#scope.length === 0) this.log(`MCP server: the scope in ${MCP_TOKEN_FILE} is not a valid one; the token allows no tool profile until the owner sets its scope again.`);
    }
  }

  status() { return Object.freeze({ configured: this.#hash !== null, createdAt: this.#createdAt, scope: this.#scope }); }

  /** The profiles the token allows now (frozen; empty when the file held a scope that is not a valid one). */
  scope() { return this.#scope; }

  /** The owner's choice of profiles (normalizeScope: refused with 400 for an unknown, empty or non-list scope; nothing changes then). File first, then memory. */
  async setScope(value) {
    const scope = normalizeScope(value);
    const write = this.#writes.catch(() => {}).then(async () => {
      if (this.#hash === null) throw Object.assign(new Error('The MCP server has no token yet.'), { code: 'mcp_server_no_token', statusCode: 404 });
      await writeJson(this.file, { version: 1, sha256: this.#hash.toString('hex'), sealed: this.#sealed, createdAt: this.#createdAt, scope: [...scope] });
      this.#scope = scope;
      return scope;
    });
    this.#writes = write;
    return write;
  }

  /** True only for the current token. Constant time in the candidate: both sides are 32-byte digests. */
  verify(candidate) {
    if (this.#hash === null || typeof candidate !== 'string' || candidate.length === 0) return false;
    return timingSafeEqual(digest(candidate), this.#hash);
  }

  /** Makes the token when there is none: {created: true, token} the one time, {created: false, token: null} after that. */
  async ensure() {
    if (this.#hash !== null) return { created: false, token: null };
    return { created: true, token: await this.rotate() };
  }

  /** A new token replaces the old one (file first, then memory) and is returned once. */
  async rotate() {
    const write = this.#writes.catch(() => {}).then(async () => {
      const token = `${MCP_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
      const sealed = await this.protector.protect(token);
      const createdAt = new Date().toISOString();
      const hash = digest(token);
      await writeJson(this.file, { version: 1, sha256: hash.toString('hex'), sealed, createdAt, scope: [...this.#scope] });
      this.#hash = hash; this.#sealed = sealed; this.#createdAt = createdAt;
      return token;
    });
    this.#writes = write;
    return write;
  }

  /** The token, unsealed (for the connection kit). Refuses a sealed copy that does not match the digest. */
  async reveal() {
    if (this.#sealed === null) throw Object.assign(new Error('The MCP server has no token yet.'), { code: 'mcp_server_no_token', statusCode: 404 });
    const token = await this.protector.unprotect(this.#sealed);
    if (!this.verify(token)) throw Object.assign(new Error('The sealed MCP server token does not match its digest.'), { code: 'mcp_server_token_mismatch', statusCode: 500 });
    return token;
  }
}
