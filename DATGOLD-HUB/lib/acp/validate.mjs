// The parameters of the four messages the agent takes from an editor, checked before anything is done with them.
//
// What is accepted is wider than what the schema calls required where a client that leaves a field out cannot do harm (mcpServers of session/new may be missing or null: the agent does not
// use them), and narrower where the value would be passed on (a folder must be an absolute path, an id must be a short string). A value that is refused is Invalid params (-32602) with
// a sentence that names the field. Nothing here touches the disk or the Hub: whether the folder exists is the agent's question.
import path from 'node:path';
import { ERROR_CODES, RpcError } from './rpc.mjs';

const MAX_PATH_CHARS = 4096;
const MAX_ID_CHARS = 200;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message) => new RpcError(ERROR_CODES.INVALID_PARAMS, message);

function requireObject(params, method) {
  if (!isObject(params)) throw invalid(`${method} needs its params as an object`);
  return params;
}

function sessionIdOf(params) {
  const { sessionId } = params;
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_ID_CHARS) throw invalid(`sessionId must be a non-empty string of at most ${MAX_ID_CHARS} characters`);
  return sessionId;
}

/** @returns {{protocolVersion: number, clientInfo: object|null, supportsNotices: boolean}} */
export function parseInitialize(params) {
  const body = requireObject(params, 'initialize');
  const { protocolVersion, clientCapabilities, clientInfo } = body;
  if (!Number.isInteger(protocolVersion) || protocolVersion < 0 || protocolVersion > 65535) throw invalid('protocolVersion must be an integer from 0 to 65535');
  if (clientCapabilities !== undefined && clientCapabilities !== null && !isObject(clientCapabilities)) throw invalid('clientCapabilities must be an object');
  if (clientInfo !== undefined && clientInfo !== null && !isObject(clientInfo)) throw invalid('clientInfo must be an object');
  const session = clientCapabilities?.session;
  // The capability is "supplied": `{}` means yes, null or absent means no (the schema says so for notices).
  const supportsNotices = isObject(session) && isObject(session.notices);
  return { protocolVersion, clientInfo: clientInfo ?? null, supportsNotices };
}

/** @returns {{cwd: string, mcpServers: object[], additionalDirectories: number}} */
export function parseNewSession(params) {
  const body = requireObject(params, 'session/new');
  const { cwd, mcpServers, additionalDirectories } = body;
  if (typeof cwd !== 'string' || cwd.length === 0) throw invalid('cwd must be the absolute path of the project folder');
  if (cwd.length > MAX_PATH_CHARS || cwd.includes('\0')) throw invalid(`cwd must be at most ${MAX_PATH_CHARS} characters and hold no NUL`);
  if (!path.isAbsolute(cwd)) throw invalid('cwd must be an absolute path');
  if (mcpServers !== undefined && mcpServers !== null) {
    if (!Array.isArray(mcpServers) || mcpServers.some((server) => !isObject(server) || typeof server.name !== 'string')) throw invalid('mcpServers must be a list of servers that each have a name');
  }
  if (additionalDirectories !== undefined && additionalDirectories !== null && (!Array.isArray(additionalDirectories) || additionalDirectories.some((entry) => typeof entry !== 'string'))) throw invalid('additionalDirectories must be a list of paths');
  return { cwd, mcpServers: mcpServers ?? [], additionalDirectories: additionalDirectories?.length ?? 0 };
}

/** @returns {{sessionId: string, prompt: unknown[]}} the blocks themselves are checked by lib/acp/content.mjs */
export function parsePrompt(params) {
  const body = requireObject(params, 'session/prompt');
  const sessionId = sessionIdOf(body);
  if (!Array.isArray(body.prompt)) throw invalid('prompt must be an array of content blocks');
  return { sessionId, prompt: body.prompt };
}

/** @returns {{sessionId: string}} */
export function parseCancel(params) {
  return { sessionId: sessionIdOf(requireObject(params, 'session/cancel')) };
}
