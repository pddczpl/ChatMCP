// The scope of a token of the Hub's MCP server (docs/MCP-SERVER.md "Tool profiles", P6 ext-19): which tool profiles a client that presents
// it may call. A small module of its own, so that the token store (server-token.mjs) can check a scope without loading the Hub's tools.
//
//   verify  the default and the only profile of a new token: the project's checks, their status and Git's view of the work (read-only
//           apart from running a fixed check command, which the owner approves);
//   read    reading the workspace (files, search, code intelligence, history);
//   write   changing it (edits, commands, Git bookkeeping), every change through the owner's approval.
// read and write are opt-in. A scope is a list of these names: case and spaces do not matter, the order is always verify, read, write.
export const PROFILE_NAMES = Object.freeze(['verify', 'read', 'write']);
export const DEFAULT_SCOPE = Object.freeze(['verify']);

const refusal = (code, message) => Object.assign(new TypeError(message), { code, statusCode: 400 });

/** A scope the owner gives: the profile names, lower case, without repeats, in canonical order. Throws (400) for anything else. */
export function normalizeScope(value) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) throw refusal('mcp_scope_invalid', `A scope is a list of profile names: ${PROFILE_NAMES.join(', ')}.`);
  const names = new Set(value.map((name) => name.trim().toLowerCase()));
  const unknown = [...names].filter((name) => !PROFILE_NAMES.includes(name));
  if (unknown.length) throw refusal('mcp_scope_unknown', `Unknown profile ${JSON.stringify(unknown[0]).slice(0, 40)}: a scope names ${PROFILE_NAMES.join(', ')}.`);
  if (names.size === 0) throw refusal('mcp_scope_empty', 'A scope names at least one profile; to serve nothing, turn the MCP server off.');
  return Object.freeze(PROFILE_NAMES.filter((name) => names.has(name)));
}

/** A scope read from somewhere that may be damaged (a file, a request): the same rules, but anything wrong is no profile at all. */
export function scopeOrNone(value) {
  try { return normalizeScope(value); } catch { return Object.freeze([]); }
}
