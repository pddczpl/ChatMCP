// Lifecycle hooks (phase P1, tasks ext-5 and ext-6).
//
// A hook is a program the OWNER configured that the Hub runs around a tool call: before it (PreToolUse), after it (PostToolUse,
// PostToolUseFailure) and, once the agent loop is wired to them, when a task stops (Stop, TaskCompleted, SubagentStop). The schema is the
// documented subset of Claude Code's (https://code.claude.com/docs/en/hooks) so that existing hook scripts keep working: the same event
// names, matcher groups, `command` handlers (exec form with `args`, or shell form), `timeout`, `onFailure`, `if`, the same JSON on stdin
// and the same exit-code contract (0 reads stdout, 2 blocks with stderr as the reason, anything else does not block unless onFailure is
// block). What is not implemented is listed in docs/HOOKS.md: input and output rewriting (updatedInput, updatedToolOutput), handler
// types other than `command`, running a hook in the background.
//
// Where the configuration lives:
//   * <Hub data folder>/hooks.json            the owner's file. It is the only file that is trusted as written.
//   * <project>/.chatmcp/hooks.json           shipped by a project. Ignored until the owner approves its sha256 (approveProject); any
//                                             change to the bytes switches it off again. It adds hooks, it never removes the owner's.
//
// What a hook cannot do (the guard in lib/manager.mjs relies on it): it is a veto and a request for confirmation, never a permission.
// This module returns `permission: deny | ask | allow`; the guard treats `allow` as "no objection", so no output of a hook can turn a
// refusal of the permission gate into an approval or skip an approval the gate asked for. Hook output is read through a whitelist of
// fields; everything else is listed as ignored and copied nowhere.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isObject, readJson, resolveProgram, stopOwned, writeJson } from './runtime.mjs';
import { ShellRunner, scrubEnv } from './shell-runner.mjs';
import { maskSecrets } from './permissions.mjs';

// ------------------------------------------------------------------------------------------------------------------ constants
export const HOOK_EVENTS = Object.freeze(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'TaskCompleted', 'SubagentStop']);
export const TOOL_EVENTS = Object.freeze(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
export const LIFECYCLE_EVENTS = Object.freeze(['Stop', 'TaskCompleted', 'SubagentStop']);
/**
 * What exit code 2 means for each event (Claude Code's table, for the events this build knows):
 * deny = the tool call does not run; feedback = the tool already ran, stderr goes to the model; block = the agent may not stop.
 */
export const EVENT_SPECS = Object.freeze({
  PreToolUse: Object.freeze({ tool: true, exit2: 'deny' }),
  PostToolUse: Object.freeze({ tool: true, exit2: 'feedback' }),
  PostToolUseFailure: Object.freeze({ tool: true, exit2: 'feedback' }),
  Stop: Object.freeze({ tool: false, exit2: 'block' }),
  TaskCompleted: Object.freeze({ tool: false, exit2: 'block' }),
  SubagentStop: Object.freeze({ tool: false, exit2: 'block' }),
});
// Every event name of the Claude Code reference. A name outside this list is a typo (an error); a name inside it that this build does
// not fire is accepted and ignored with a warning, so a settings file can be pasted in as it is.
const CLAUDE_EVENTS = Object.freeze([
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse',
  'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted',
  'Stop', 'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'FileChanged',
  'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'Elicitation', 'ElicitationResult',
  'SessionEnd',
]);
const HANDLER_TYPES = Object.freeze(['command', 'http', 'mcp_tool', 'prompt', 'agent']);
const SHELLS = Object.freeze(['bash', 'powershell', 'cmd']);
const COMMAND_FIELDS = new Set(['type', 'command', 'args', 'shell', 'timeout', 'onFailure', 'if', 'async', 'asyncRewake', 'statusMessage', 'once']);

export const MAX_STDOUT_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const MAX_TIMEOUT_SECONDS = 3600;
/** Claude Code stops a Stop hook that keeps blocking after 8 continuations in a row (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP). */
export const BLOCK_RETRY_LIMIT = 8;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_REASON_CHARS = 4000;
const MAX_CONTEXT_CHARS = 10_000; // Claude Code's cap on additionalContext
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PARALLEL = 16;
const MAX_LEDGER_ROWS = 200;
const MAX_TRACKED_TASKS = 200;
const MAX_APPROVALS = 200;
const KILL_WAIT_MS = 5000;
const LINGER_MS = 1500;

const fault = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const own = (object, key) => (isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined);
const sha256Of = (data) => createHash('sha256').update(data).digest('hex');
const isoNow = (now = Date.now) => new Date(now()).toISOString();

// ------------------------------------------------------------------------------------------------------------------ tool names
/**
 * Claude Code tool name -> the ChatMCP tools it stands for, so a matcher written for Claude Code ("Bash", "Edit|Write") still selects
 * the right calls. `Edit` and `Write` include the batch tools: a matcher that guards file changes must see them too. A tool with no
 * entry (local.move_path, local.delete_path, local.git_commit ...) is matched by its ChatMCP name only.
 */
export const TOOL_ALIASES = Object.freeze({
  Bash: Object.freeze(['local.run_command']),
  Edit: Object.freeze(['local.edit_file', 'local.files_apply_patch']),
  Write: Object.freeze(['local.write_file', 'local.files_write_batch']),
  Read: Object.freeze(['local.read_file']),
  Glob: Object.freeze(['local.find_files']),
  Grep: Object.freeze(['local.search_files']),
});
const FILE_PATH_TOOLS = new Set(['local.write_file', 'local.edit_file', 'local.read_file']);

/** Every name a tool answers to: its own, its Claude Code names, and mcp__server__tool for a tool of an external server. */
export function toolNames(toolName) {
  const name = String(toolName);
  const names = [name];
  for (const [alias, targets] of Object.entries(TOOL_ALIASES)) if (targets.includes(name)) names.push(alias);
  const external = /^([^.]+)\.(.+)$/.exec(name);
  if (external && !['local', 'studio'].includes(external[1])) names.push(`mcp__${external[1]}__${external[2]}`);
  return names;
}

// ------------------------------------------------------------------------------------------------------------------ matchers
const SIMPLE_MATCHER = /^[A-Za-z0-9_\- ,|]*$/;

/**
 * Claude Code's rule: empty, "*" or absent matches everything; letters, digits, _ - space , and | make an exact name or a list of exact
 * names; anything else is an unanchored JavaScript regular expression. `names` holds every name the tool answers to.
 */
export function matcherMatches(matcher, names) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  const text = String(matcher);
  if (SIMPLE_MATCHER.test(text)) {
    const listed = text.split(/[|,]/).map((item) => item.trim()).filter(Boolean);
    return names.some((name) => listed.includes(name));
  }
  let pattern;
  try { pattern = new RegExp(text); } catch { return false; }
  return names.some((name) => pattern.test(name));
}

// ------------------------------------------------------------------------------------------------------------------ `if` conditions
const CONDITION = /^\s*([A-Za-z0-9_.\-]+)\s*(?:\(([\s\S]*)\))?\s*$/;
const parseCondition = (condition) => CONDITION.exec(String(condition));
const isKnownToolClass = (name) => Object.hasOwn(TOOL_ALIASES, name) || name.includes('.') || name.startsWith('mcp__');

const SEGMENT_SPLIT = /&&|\|\||[;|&\n\r]/;
/** The command as written, each simple command in it and each `$(...)` or backtick body, with leading VAR=value words dropped. */
function commandForms(command) {
  const forms = new Set();
  const add = (text) => {
    const trimmed = String(text).trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    if (trimmed) forms.add(trimmed);
  };
  add(command);
  for (const part of command.split(SEGMENT_SPLIT)) add(part);
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const inner = match[1] ?? match[2] ?? '';
    add(inner);
    for (const part of inner.split(SEGMENT_SPLIT)) add(part);
  }
  return [...forms];
}

function commandPatternMatches(pattern, form) {
  const glob = pattern.trim();
  let source = '';
  for (const char of glob) source += char === '*' ? '.*' : char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // "git *" stands for a bare "git" too: the space before the star only keeps "git *" from matching "gitk"
  if (glob.endsWith(' *')) source = `${source.slice(0, -3)}(?:\\ .*)?`;
  return new RegExp(`^${source}$`, 's').test(form);
}

function pathGlobRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') { source += '(?:.*/)?'; index += 2; } else { source += '.*'; index += 1; }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

function relativeTarget(value, workspace) {
  if (typeof value !== 'string' || !value) return null;
  if (!workspace) return value.replaceAll('\\', '/');
  const absolute = path.resolve(workspace, value);
  const relative = path.relative(workspace, absolute);
  return (relative.startsWith('..') || path.isAbsolute(relative) ? absolute : relative).replaceAll('\\', '/');
}

function pathPatternMatches(pattern, target) {
  const glob = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const regex = pathGlobRegExp(glob);
  if (regex.test(target)) return true;
  return !glob.includes('/') && regex.test(path.posix.basename(target));
}

/**
 * Claude Code's `if`: one permission rule, "Tool" or "Tool(pattern)". It narrows a hook that already matched. Whatever cannot be
 * evaluated here (a malformed rule, a tool this build has no counterpart for, an argument that is not text) lets the hook RUN: skipping
 * would silently switch off a hook that was meant to guard something.
 */
export function conditionMatches(condition, { toolName, toolInput, workspace } = {}) {
  const parsed = parseCondition(condition);
  if (!parsed) return true;
  const [, ruleTool, pattern] = parsed;
  if (!toolNames(toolName).includes(ruleTool)) return !isKnownToolClass(ruleTool);
  if (pattern === undefined) return true;
  const input = isObject(toolInput) ? toolInput : {};
  if (toolName === 'local.run_command') {
    return typeof input.command !== 'string' ? true : commandForms(input.command).some((form) => commandPatternMatches(pattern, form));
  }
  if (FILE_PATH_TOOLS.has(toolName)) {
    const target = relativeTarget(input.path, workspace);
    return target === null ? true : pathPatternMatches(pattern, target);
  }
  return true;
}

// ------------------------------------------------------------------------------------------------------------------ permission_mode
/** The permission_mode of Claude Code's payload for a ChatMCP mode: plan, default, acceptEdits, bypassPermissions. Read Only wins, as in the gate. */
export function claudePermissionMode({ mode, executionPolicy } = {}) {
  if (mode === 'readonly') return 'plan';
  if (executionPolicy === 'full-access') return 'bypassPermissions';
  if (mode === 'autonomous') return 'acceptEdits';
  return 'default';
}

// ------------------------------------------------------------------------------------------------------------------ validation
function validateCommandHandler(handler, at, errors, warnings) {
  let good = true;
  const bad = (text) => { errors.push(`${at}${text}`); good = false; };
  for (const key of Object.keys(handler)) if (!COMMAND_FIELDS.has(key)) bad(`: unknown field "${key}" (a misspelt field would silently change what the hook does)`);
  if (typeof handler.command !== 'string' || handler.command.length === 0) bad('.command: required, a non-empty string');
  else if (handler.command.length > 8192) bad('.command: longer than 8192 characters');
  if (handler.args !== undefined && (!Array.isArray(handler.args) || handler.args.length > 64 || handler.args.some((item) => typeof item !== 'string' || item.length > 8192))) bad('.args: must be an array of at most 64 strings');
  if (handler.shell !== undefined && !SHELLS.includes(handler.shell)) bad(`.shell: must be one of ${SHELLS.join(', ')}`);
  if (handler.timeout !== undefined && !(Number.isInteger(handler.timeout) && handler.timeout >= 1 && handler.timeout <= MAX_TIMEOUT_SECONDS)) bad(`.timeout: must be an integer from 1 to ${MAX_TIMEOUT_SECONDS} (seconds)`);
  if (handler.onFailure !== undefined && !['continue', 'block'].includes(handler.onFailure)) bad('.onFailure: must be "continue" or "block"');
  if (handler.if !== undefined && (typeof handler.if !== 'string' || handler.if.length > 512)) bad('.if: must be a string of at most 512 characters');
  else if (typeof handler.if === 'string' && !parseCondition(handler.if)) warnings.push(`${at}.if: "${handler.if.slice(0, 80)}" cannot be read as Tool or Tool(pattern); the hook will run on every matching call`);
  for (const key of ['async', 'asyncRewake', 'once']) if (handler[key] !== undefined && typeof handler[key] !== 'boolean') bad(`.${key}: must be true or false`);
  if (handler.statusMessage !== undefined && (typeof handler.statusMessage !== 'string' || handler.statusMessage.length > 500)) bad('.statusMessage: must be a string of at most 500 characters');
  if (good && (handler.async === true || handler.asyncRewake === true)) warnings.push(`${at}: async is accepted for compatibility but this build runs the hook synchronously`);
  return good;
}

/**
 * Checks a parsed hooks file. `errors` make the file unusable; `warnings` name what is accepted but has no effect here. The result
 * holds the normalized configuration that the runner executes: only the supported events and only `command` handlers.
 */
export function validateHooksConfig(value) {
  const errors = [];
  const warnings = [];
  const config = { hooks: {} };
  let handlers = 0;
  const finish = () => ({ ok: errors.length === 0, errors, warnings, config, handlers });
  if (!isObject(value)) { errors.push('the top level must be a JSON object such as {"hooks": {...}}'); return finish(); }
  for (const key of Object.keys(value)) if (!['$schema', 'hooks'].includes(key)) warnings.push(`${key}: not a hooks setting, ignored (only "hooks" is read)`);
  if (value.hooks === undefined) return finish();
  if (!isObject(value.hooks)) { errors.push('hooks: must be an object that maps event names to matcher groups'); return finish(); }
  for (const [event, groups] of Object.entries(value.hooks)) {
    const where = `hooks.${event}`;
    if (!CLAUDE_EVENTS.includes(event)) { errors.push(`${where}: "${event.slice(0, 60)}" is not a hook event name`); continue; }
    if (!Array.isArray(groups)) { errors.push(`${where}: must be an array of matcher groups`); continue; }
    if (groups.length > 32) errors.push(`${where}: more than 32 matcher groups`);
    const supported = HOOK_EVENTS.includes(event);
    if (!supported) warnings.push(`${where}: this build does not fire ${event}; its handlers are ignored`);
    const kept = [];
    groups.forEach((group, groupIndex) => {
      const at = `${where}[${groupIndex}]`;
      if (!isObject(group)) { errors.push(`${at}: must be an object with a "hooks" array`); return; }
      for (const key of Object.keys(group)) if (!['matcher', 'hooks'].includes(key)) errors.push(`${at}: unknown key "${key}"`);
      if (group.matcher !== undefined) {
        if (typeof group.matcher !== 'string' || group.matcher.length > 512) errors.push(`${at}.matcher: must be a string of at most 512 characters`);
        else if (!SIMPLE_MATCHER.test(group.matcher) && group.matcher !== '*') {
          try { new RegExp(group.matcher); } catch (error) { errors.push(`${at}.matcher: not a valid regular expression (${error.message.slice(0, 120)})`); }
        }
      }
      if (!Array.isArray(group.hooks) || group.hooks.length < 1) { errors.push(`${at}.hooks: must be a non-empty array of handlers`); return; }
      if (group.hooks.length > MAX_PARALLEL) errors.push(`${at}.hooks: more than ${MAX_PARALLEL} handlers in one group`);
      const accepted = [];
      group.hooks.forEach((handler, handlerIndex) => {
        const handlerAt = `${at}.hooks[${handlerIndex}]`;
        if (!isObject(handler)) { errors.push(`${handlerAt}: must be an object`); return; }
        if (!HANDLER_TYPES.includes(handler.type)) { errors.push(`${handlerAt}.type: must be one of ${HANDLER_TYPES.join(', ')}`); return; }
        if (handler.type !== 'command') { warnings.push(`${handlerAt}: handler type "${handler.type}" is not supported by this build; ignored`); return; }
        if (!validateCommandHandler(handler, handlerAt, errors, warnings) || !supported) return;
        accepted.push({
          type: 'command', command: handler.command,
          ...(handler.args !== undefined ? { args: [...handler.args] } : {}),
          ...(handler.shell !== undefined ? { shell: handler.shell } : {}),
          timeout: handler.timeout ?? DEFAULT_TIMEOUT_SECONDS,
          onFailure: handler.onFailure ?? 'continue',
          ...(typeof handler.if === 'string' ? { if: handler.if } : {}),
        });
      });
      if (supported && accepted.length) { handlers += accepted.length; kept.push({ ...(group.matcher !== undefined ? { matcher: group.matcher } : {}), hooks: accepted }); }
    });
    if (supported && kept.length) config.hooks[event] = kept;
  }
  return finish();
}

const handlerKey = (handler) => JSON.stringify([handler.command, handler.args ?? null, handler.shell ?? null, handler.timeout, handler.onFailure, handler.if ?? null]);
const handlerId = (event, handler) => `h_${sha256Of(`${event}\n${handlerKey(handler)}`).slice(0, 12)}`;

// ------------------------------------------------------------------------------------------------------------------ text from hooks
/**
 * Everything a hook prints is untrusted text on its way to the model, the dashboard and the log: escape sequences (colours, cursor
 * moves, terminal titles), control characters, line separators and bidirectional overrides are removed, registered secrets and
 * token-shaped strings are masked, and the length is capped.
 */
export function sanitizeHookText(text, { secrets = [], max = MAX_REASON_CHARS } = {}) {
  let value = String(text ?? '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\u001b/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
  value = maskSecrets(value, secrets).trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const KNOWN_TOP_LEVEL = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'decision', 'reason', 'hookSpecificOutput', 'terminalSequence']);
const KNOWN_SPECIFIC = new Set(['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'additionalContext']);

/**
 * Reads the JSON a hook printed on exit 0. Only the fields below are looked at; every other field is reported by name in `ignored` and
 * copied nowhere. Returns { decision, reason, block, additionalContext, systemMessage, ignored }.
 */
function readHookJson(event, text, truncated, secrets) {
  const result = { decision: null, reason: null, block: false, additionalContext: null, systemMessage: null, ignored: [] };
  if (truncated) { result.ignored.push({ reason: 'stdout_truncated' }); return result; }
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return result; // plain text: a status line, not an answer
  let data;
  try { data = JSON.parse(trimmed); } catch { result.ignored.push({ reason: 'invalid_json' }); return result; }
  if (!isObject(data)) { result.ignored.push({ reason: 'invalid_json' }); return result; }
  for (const key of Object.keys(data)) {
    if (!KNOWN_TOP_LEVEL.has(key) && result.ignored.length < 30) result.ignored.push({ reason: 'unsupported_field', field: sanitizeHookText(key, { max: 64 }) });
  }
  const spec = EVENT_SPECS[event];
  const clean = (value, max) => (typeof value === 'string' && value.trim() ? sanitizeHookText(value, { secrets, max }) : null);
  const specific = own(data, 'hookSpecificOutput');
  let specificUsable = false;
  if (specific !== undefined) {
    if (!isObject(specific)) result.ignored.push({ reason: 'invalid_json' });
    else if (own(specific, 'hookEventName') !== event) result.ignored.push({ reason: 'wrong_event' });
    else {
      specificUsable = true;
      for (const key of Object.keys(specific)) {
        if (!KNOWN_SPECIFIC.has(key) && result.ignored.length < 30) result.ignored.push({ reason: 'unsupported_field', field: sanitizeHookText(key, { max: 64 }) });
      }
      result.additionalContext = clean(own(specific, 'additionalContext'), MAX_CONTEXT_CHARS);
    }
  }
  result.systemMessage = clean(own(data, 'systemMessage'), 1000);
  const topReason = clean(own(data, 'reason'), MAX_REASON_CHARS);
  if (event === 'PreToolUse') {
    const wanted = specificUsable ? own(specific, 'permissionDecision') : undefined;
    if (wanted === 'allow' || wanted === 'deny' || wanted === 'ask' || wanted === 'defer') {
      // "defer" asks Claude Code to pause the call for a later resume; the closest safe reading here is to ask the owner
      result.decision = wanted === 'defer' ? 'ask' : wanted;
      result.reason = clean(own(specific, 'permissionDecisionReason'), MAX_REASON_CHARS);
    } else if (wanted !== undefined) result.ignored.push({ reason: 'invalid_decision' });
    else if (own(data, 'decision') === 'block') { result.decision = 'deny'; result.reason = topReason; }
    else if (own(data, 'decision') === 'approve') result.decision = 'allow';
    // Claude Code: continue:false stops the whole run and wins over the event's own decision
    if (own(data, 'continue') === false) { result.decision = 'deny'; result.reason = clean(own(data, 'stopReason'), MAX_REASON_CHARS) ?? result.reason ?? 'a hook asked to stop'; }
  } else if (own(data, 'decision') === 'block') {
    result.block = true;
    result.reason = topReason;
  } else if (own(data, 'continue') === false && spec.tool) result.ignored.push({ reason: 'continue_false_after_the_tool_ran' });
  return result;
}

// ------------------------------------------------------------------------------------------------------------------ the payload
function truncateStrings(value, limit, depth = 0) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…[${value.length - limit} characters cut]` : value;
  if (depth > 24 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, limit, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateStrings(item, limit, depth + 1)]));
}

/** The JSON text handed to a hook, at most about 1 MiB: long strings are cut (largest allowance first) until it fits. */
function boundedJson(payload, maxBytes = MAX_PAYLOAD_BYTES) {
  let text = JSON.stringify(payload);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  for (const limit of [256 * 1024, 64 * 1024, 16 * 1024, 4 * 1024, 1024, 256]) {
    text = JSON.stringify({ ...truncateStrings(payload, limit), chatmcp_truncated: true });
    if (Buffer.byteLength(text) <= maxBytes) return text;
  }
  return JSON.stringify({ session_id: payload.session_id, cwd: payload.cwd, permission_mode: payload.permission_mode, hook_event_name: payload.hook_event_name, tool_name: payload.tool_name, chatmcp_truncated: true });
}

// ------------------------------------------------------------------------------------------------------------------ files
async function readBounded(file, { limit, refuseLinks }) {
  let handle;
  try {
    if (refuseLinks && (await fs.lstat(file)).isSymbolicLink()) return { exists: true, error: 'symlink' };
    handle = await fs.open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) return { exists: true, error: 'not_a_file' };
    if (info.size > limit) return { exists: true, error: 'too_large' };
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return { exists: true, bytes: buffer.subarray(0, bytesRead) };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { exists: false };
    return { exists: true, error: 'unreadable', detail: String(error?.code ?? error?.message ?? '').slice(0, 60) };
  } finally { await handle?.close().catch(() => {}); }
}

function parseConfigBytes(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${String(error.message).slice(0, 160)}`], warnings: [], config: { hooks: {} }, handlers: 0 };
  }
  return validateHooksConfig(value);
}

const emptySource = (source, file) => ({ source, path: file, exists: false, sha256: null, valid: true, errors: [], warnings: [], config: { hooks: {} }, handlers: 0, state: 'none' });
const rootKey = (root) => (process.platform === 'win32' ? root.toLowerCase() : root);
const safeName = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || '_';

/** What the dashboard and the tests may see of a configuration source: never the parsed configuration itself. */
function publicSource(source) {
  const { config, ...rest } = source;
  void config;
  return rest;
}

// ------------------------------------------------------------------------------------------------------------------ running a program
class Capture {
  constructor(limit) { this.limit = limit; this.chunks = []; this.kept = 0; this.total = 0; }
  push(chunk) {
    this.total += chunk.length;
    if (this.kept >= this.limit) return;
    const take = Math.min(chunk.length, this.limit - this.kept);
    this.chunks.push(chunk.subarray(0, take));
    this.kept += take;
  }
  get truncated() { return this.total > this.limit; }
  text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

const programError = (text) => fault('hook_program_unavailable', text, 400);

export class HookRunner {
  #state = null;
  #writes = Promise.resolve();
  #ledgers = new Map();
  #ledgerWrites = new Map();
  #seen = new Map();
  #cache = new Map();
  #warned = new Set();
  #running = new Set();
  #active = new Set();
  #lifecycle = new AbortController();
  #shell;

  /**
   * @param {object} options
   * @param {string} options.hubDirectory  the Hub data folder: hooks.json, hooks/state.json (approvals, retry counters), hooks/tasks/<id>.json
   * @param {() => string[]} [options.secrets]  registered secrets: kept out of the hook environment and masked in what a hook prints
   * @param {object} [options.env]  the environment hooks inherit from (default: the live process.env), after scrubbing
   */
  constructor({ hubDirectory, secrets = () => [], env = process.env, platform = process.platform, log = () => {}, now = Date.now, retryLimit = BLOCK_RETRY_LIMIT } = {}) {
    if (!hubDirectory) throw new TypeError('HookRunner needs hubDirectory.');
    this.hubDirectory = path.resolve(hubDirectory);
    this.ownerFile = path.join(this.hubDirectory, 'hooks.json');
    this.stateDirectory = path.join(this.hubDirectory, 'hooks');
    this.stateFile = path.join(this.stateDirectory, 'state.json');
    this.secrets = secrets;
    this.env = env;
    this.platform = platform;
    this.log = log;
    this.now = now;
    this.retryLimit = retryLimit;
    this.#shell = new ShellRunner({
      workspace: { resolve() { throw new Error('not used by hooks'); } },
      stateDirectory: this.stateDirectory, env, platform, secrets,
    });
  }

  // ---------------------------------------------------------------------------------------------------------------- state file
  async #load() {
    if (this.#state) return this.#state;
    let saved = null;
    try { saved = await readJson(this.stateFile); } catch { saved = null; } // damaged file: no approval survives (inert, the safe side)
    const approvals = Array.isArray(saved?.approvals) ? saved.approvals.filter((item) => isObject(item) && typeof item.root === 'string' && /^[0-9a-f]{64}$/.test(item.sha256 ?? '')) : [];
    this.#state = { version: 1, approvals: approvals.slice(-MAX_APPROVALS), retries: isObject(saved?.retries) ? saved.retries : {} };
    return this.#state;
  }

  #save() {
    this.#writes = this.#writes.catch(() => {}).then(() => writeJson(this.stateFile, this.#state));
    return this.#writes;
  }

  // ---------------------------------------------------------------------------------------------------------------- configuration
  #parse(bytes) {
    const key = sha256Of(bytes);
    let parsed = this.#cache.get(key);
    if (!parsed) {
      parsed = parseConfigBytes(bytes);
      if (this.#cache.size >= 16) this.#cache.delete(this.#cache.keys().next().value);
      this.#cache.set(key, parsed);
    }
    return { key, parsed };
  }

  async #loadOwner() {
    const read = await readBounded(this.ownerFile, { limit: MAX_CONFIG_BYTES, refuseLinks: false });
    const source = emptySource('owner', this.ownerFile);
    if (!read.exists) return source;
    source.exists = true;
    if (read.error) return { ...source, valid: false, errors: [`cannot be read (${read.error}${read.detail ? ` ${read.detail}` : ''})`], state: 'unreadable' };
    const { key, parsed } = this.#parse(read.bytes);
    return { ...source, sha256: key, valid: parsed.ok, errors: parsed.errors, warnings: parsed.warnings, config: parsed.config, handlers: parsed.handlers, state: parsed.ok ? 'active' : 'invalid' };
  }

  async #loadProject(projectRoot) {
    const file = projectRoot ? path.join(path.resolve(projectRoot), '.chatmcp', 'hooks.json') : null;
    const source = emptySource('project', file);
    if (!projectRoot) return source;
    let root;
    try { root = await fs.realpath(projectRoot); } catch { return source; }
    source.root = root;
    source.path = path.join(root, '.chatmcp', 'hooks.json');
    const read = await readBounded(source.path, { limit: MAX_CONFIG_BYTES, refuseLinks: true });
    if (!read.exists) return source;
    source.exists = true;
    if (read.error) return { ...source, valid: false, errors: [`cannot be read (${read.error}${read.detail ? ` ${read.detail}` : ''})`], state: 'unreadable' };
    const { key, parsed } = this.#parse(read.bytes);
    source.sha256 = key;
    source.valid = parsed.ok;
    source.errors = parsed.errors;
    source.warnings = parsed.warnings;
    source.handlers = parsed.handlers;
    const approval = (await this.#load()).approvals.find((item) => rootKey(item.root) === rootKey(root));
    source.approvedSha256 = approval?.sha256 ?? null;
    if (!approval) source.state = 'unapproved';
    else if (approval.sha256 !== key) source.state = 'changed';
    else if (!parsed.ok) source.state = 'invalid';
    else { source.state = 'approved'; source.config = parsed.config; }
    return source;
  }

  async #snapshot(projectRoot) {
    return { owner: await this.#loadOwner(), project: await this.#loadProject(projectRoot) };
  }

  /** The owner's file and the project's file as the runner sees them now (no configuration, only states, hashes and problems). */
  async status({ projectRoot = null } = {}) {
    const snapshot = await this.#snapshot(projectRoot);
    return { owner: publicSource(snapshot.owner), project: publicSource(snapshot.project), retryLimit: this.retryLimit };
  }

  /**
   * The owner approves one project file: only the bytes whose sha256 the caller names, and only while they are still the file's bytes.
   * A later change of a single byte switches the project hooks off again until the owner approves the new sha256.
   */
  async approveProject({ projectRoot, sha256 } = {}) {
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw fault('hooks_bad_request', 'sha256 must be 64 hexadecimal digits: the hash of the project hooks file you reviewed.');
    const project = await this.#loadProject(projectRoot);
    if (!project.exists) throw fault('hooks_project_missing', 'This project has no .chatmcp/hooks.json.', 404);
    if (project.state === 'unreadable') throw fault('hooks_project_unreadable', `The project hooks file cannot be approved: ${project.errors[0]}.`);
    if (project.sha256 !== sha256) throw Object.assign(fault('hooks_project_changed', `The project hooks file is not the one you reviewed: its sha256 is ${project.sha256}. Review it again before approving.`, 409), { sha256: project.sha256 });
    if (!project.valid) throw Object.assign(fault('hooks_project_invalid', `The project hooks file is not valid: ${project.errors[0]}.`), { errors: project.errors });
    const state = await this.#load();
    state.approvals = state.approvals.filter((item) => rootKey(item.root) !== rootKey(project.root));
    state.approvals.push({ root: project.root, file: '.chatmcp/hooks.json', sha256, approvedAt: isoNow(this.now) });
    if (state.approvals.length > MAX_APPROVALS) state.approvals.splice(0, state.approvals.length - MAX_APPROVALS);
    await this.#save();
    return publicSource(await this.#loadProject(projectRoot));
  }

  async revokeProject({ projectRoot } = {}) {
    let root;
    try { root = await fs.realpath(projectRoot); } catch { return { revoked: false }; }
    const state = await this.#load();
    const before = state.approvals.length;
    state.approvals = state.approvals.filter((item) => rootKey(item.root) !== rootKey(root));
    if (state.approvals.length === before) return { revoked: false };
    await this.#save();
    return { revoked: true };
  }

  // ---------------------------------------------------------------------------------------------------------------- retry counters
  async retryState({ taskId, event } = {}) {
    const entry = (await this.#load()).retries?.[taskId]?.[event];
    const consecutive = Number(entry?.consecutive) || 0;
    return { consecutive, total: Number(entry?.total) || 0, limit: this.retryLimit, exhausted: consecutive >= this.retryLimit };
  }

  /** Counts one more block of `event` for the task, or resets the run of blocks when nothing blocked. Durable before it returns. */
  async #noteBlock(taskId, event, blocked) {
    const state = await this.#load();
    state.retries ??= {};
    // A call nothing blocked changes nothing when no run of blocks is open: no entry, no write.
    if (!blocked && !state.retries[taskId]?.[event]?.consecutive) return this.retryState({ taskId, event });
    const forTask = (state.retries[taskId] ??= {});
    const entry = (forTask[event] ??= { consecutive: 0, total: 0, updatedAt: null });
    if (blocked) { entry.consecutive += 1; entry.total += 1; } else entry.consecutive = 0;
    entry.updatedAt = isoNow(this.now);
    const tracked = Object.keys(state.retries);
    if (tracked.length > MAX_TRACKED_TASKS) {
      const oldest = tracked.map((id) => [id, Math.max(0, ...Object.values(state.retries[id]).map((item) => Date.parse(item?.updatedAt) || 0))]).sort((a, b) => a[1] - b[1]);
      for (const [id] of oldest.slice(0, tracked.length - MAX_TRACKED_TASKS)) delete state.retries[id];
    }
    await this.#save();
    return this.retryState({ taskId, event });
  }

  // ---------------------------------------------------------------------------------------------------------------- the per-task ledger
  async #ledger(taskId) {
    const key = safeName(taskId);
    if (this.#ledgers.has(key)) return this.#ledgers.get(key);
    let saved = null;
    try { saved = await readJson(path.join(this.stateDirectory, 'tasks', `${key}.json`)); } catch { saved = null; }
    const ledger = isObject(saved) && saved.taskId === taskId ? saved : null;
    if (ledger) this.#ledgers.set(key, ledger);
    return ledger;
  }

  /** What the hooks did for a task: the sha256 of the hooks files at the first call and at each change, every hook that fired, and counts. */
  async taskRecord(taskId) {
    const ledger = await this.#ledger(taskId);
    return ledger ? structuredClone(ledger) : null;
  }

  async #record(taskId, event, input, snapshot, outcome) {
    if (!taskId) return;
    const configuration = { ownerSha256: snapshot.owner.sha256, ownerValid: snapshot.owner.valid, projectSha256: snapshot.project.sha256, projectState: snapshot.project.state };
    const same = (a, b) => a && b && ['ownerSha256', 'ownerValid', 'projectSha256', 'projectState'].every((field) => a[field] === b[field]);
    let ledger = await this.#ledger(taskId);
    const known = ledger?.configHistory?.at(-1) ?? this.#seen.get(taskId)?.configuration;
    const changed = Boolean(known) && !same(known, configuration);
    const nothingConfigured = !configuration.ownerSha256 && !configuration.projectSha256 && configuration.ownerValid;
    if (!ledger && !outcome.fired.length && !changed && (nothingConfigured || known)) {
      // Nothing happened worth a file yet: remember what was seen, so that a later change can be reported against it.
      if (!this.#seen.has(taskId)) { this.#seen.set(taskId, { configuration, at: isoNow(this.now) }); if (this.#seen.size > 500) this.#seen.delete(this.#seen.keys().next().value); }
      return;
    }
    if (!ledger) {
      ledger = { version: 1, taskId, createdAt: isoNow(this.now), updatedAt: null, configHistory: [], fired: [], counts: {} };
      const seen = this.#seen.get(taskId);
      if (seen && !same(seen.configuration, configuration)) ledger.configHistory.push({ at: seen.at, ...seen.configuration, changed: false });
      this.#ledgers.set(safeName(taskId), ledger);
      if (this.#ledgers.size > MAX_TRACKED_TASKS) this.#ledgers.delete(this.#ledgers.keys().next().value);
    }
    if (!ledger.configHistory.length || !same(ledger.configHistory.at(-1), configuration)) ledger.configHistory.push({ at: isoNow(this.now), ...configuration, changed: ledger.configHistory.length > 0 });
    const counts = (ledger.counts[event] ??= { fired: 0, blocked: 0 });
    for (const record of outcome.fired) {
      counts.fired += 1;
      if (record.blocked) counts.blocked += 1;
      ledger.fired.push({
        at: record.at, event, tool: input.toolName ?? null, toolUseId: input.toolUseId ?? null, id: record.id, source: record.source, decision: record.decision, blocked: record.blocked,
        failure: record.failure, exitCode: record.exitCode, timedOut: record.timedOut, durationMs: record.durationMs, ...(record.reason ? { reason: record.reason.slice(0, 300) } : {}),
      });
    }
    if (ledger.fired.length > MAX_LEDGER_ROWS) ledger.fired.splice(0, ledger.fired.length - MAX_LEDGER_ROWS);
    ledger.updatedAt = isoNow(this.now);
    const file = path.join(this.stateDirectory, 'tasks', `${safeName(taskId)}.json`);
    const snapshotText = structuredClone(ledger);
    const previous = this.#ledgerWrites.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => writeJson(file, snapshotText));
    this.#ledgerWrites.set(taskId, next);
    try { await next; } catch (error) { this.log(`hooks: the ledger of a task could not be written (${error?.code ?? 'error'})`); }
  }

  // ---------------------------------------------------------------------------------------------------------------- running hooks
  /**
   * Runs the hooks of one event and returns what they decided. Never starts a process when nothing matches.
   *
   * Input: event, taskId, projectRoot (where .chatmcp/hooks.json is looked for), cwd (working directory of the hooks), permissionMode and
   * executionPolicy (the gate's, for the payload), and for the tool events toolName, toolInput, toolUseId, toolResponse (Post) or error
   * (PostToolUseFailure). payloadExtra adds fields for the lifecycle events. signal cancels the run: the hooks' process trees are killed
   * and run() rejects with the reason of the abort.
   *
   * Outcome: { event, taskId, matched, fired[], permission: 'deny'|'ask'|'allow'|null (PreToolUse), blocked, reason, code, feedback[],
   * additionalContext[], systemMessages[], ignored[], config, retries }.
   */
  async run(input = {}) {
    const event = input.event;
    if (!HOOK_EVENTS.includes(event)) throw new TypeError(`Unknown hook event ${String(event)}`);
    if (EVENT_SPECS[event].tool && typeof input.toolName !== 'string') throw new TypeError(`${event} needs toolName`);
    const signal = input.signal ? AbortSignal.any([input.signal, this.#lifecycle.signal]) : this.#lifecycle.signal;
    signal.throwIfAborted();
    const running = this.#run({ ...input, signal });
    this.#running.add(running);
    try { return await running; } finally { this.#running.delete(running); }
  }

  async #run(input) {
    const { event, taskId = null, signal } = input;
    const spec = EVENT_SPECS[event];
    const cwd = path.resolve(input.cwd ?? input.projectRoot ?? process.cwd());
    const snapshot = await this.#snapshot(input.projectRoot ?? cwd);
    const outcome = {
      event, taskId, matched: 0, fired: [], permission: null, blocked: false, reason: null, feedback: [], additionalContext: [], systemMessages: [], ignored: [], retries: null,
      config: { ownerSha256: snapshot.owner.sha256, ownerValid: snapshot.owner.valid, projectSha256: snapshot.project.sha256, projectState: snapshot.project.state },
    };
    for (const source of [snapshot.owner, snapshot.project]) {
      if (source.exists && source.warnings.length && !this.#warned.has(`${source.path}:${source.sha256}`)) {
        this.#warned.add(`${source.path}:${source.sha256}`);
        this.log(`hooks: ${source.path}: ${source.warnings[0]}${source.warnings.length > 1 ? ` (+${source.warnings.length - 1} more)` : ''}`);
      }
    }
    if (snapshot.owner.exists && !snapshot.owner.valid) {
      // The owner configured guards and the file cannot be read as they wrote it: running without them would be silent, so a call that a
      // PreToolUse hook could have vetoed is refused until the file is fixed.
      outcome.code = 'hooks_config_invalid';
      const message = `The hooks file ${snapshot.owner.path} is not valid (${snapshot.owner.errors[0]}). Calls are refused until it is fixed or removed.`;
      if (!this.#warned.has(`invalid:${snapshot.owner.sha256}`)) { this.#warned.add(`invalid:${snapshot.owner.sha256}`); this.log(`hooks: ${message}`); }
      if (event === 'PreToolUse') { outcome.permission = 'deny'; outcome.blocked = true; outcome.reason = sanitizeHookText(message, { secrets: this.secrets() }); } else outcome.feedback.push(sanitizeHookText(message, { secrets: this.secrets() }));
      await this.#record(taskId, event, input, snapshot, outcome);
      return outcome;
    }

    const names = spec.tool ? toolNames(input.toolName) : [];
    const selected = [];
    const seenHandlers = new Set();
    for (const source of [snapshot.owner, snapshot.project]) {
      for (const group of source.config.hooks[event] ?? []) {
        if (spec.tool && !matcherMatches(group.matcher, names)) continue;
        for (const handler of group.hooks) {
          // Claude Code: on an event that is not a tool event a hook with `if` never runs
          if (handler.if !== undefined && (!spec.tool || !conditionMatches(handler.if, { toolName: input.toolName, toolInput: input.toolInput, workspace: cwd }))) continue;
          const key = handlerKey(handler);
          if (seenHandlers.has(key)) continue;
          seenHandlers.add(key);
          selected.push({ ...handler, id: handlerId(event, handler), source: source.source, matcher: group.matcher });
        }
      }
    }
    outcome.matched = selected.length;

    if (selected.length) {
      const payload = boundedJson(this.#payload(event, input, cwd, names));
      for (let start = 0; start < selected.length; start += MAX_PARALLEL) {
        const wave = selected.slice(start, start + MAX_PARALLEL);
        outcome.fired.push(...await Promise.all(wave.map((handler) => this.#execute(handler, { event, spec, payload, cwd, signal }))));
      }
      signal.throwIfAborted();
      this.#aggregate(event, spec, outcome);
    }

    if (taskId && (selected.length || (this.#state ?? (await fs.access(this.stateFile).then(() => true, () => false))))) outcome.retries = await this.#noteBlock(taskId, event, outcome.blocked);
    await this.#record(taskId, event, input, snapshot, outcome);
    return outcome;
  }

  #payload(event, input, cwd, names) {
    const payload = {
      session_id: String(input.taskId ?? ''),
      cwd,
      permission_mode: claudePermissionMode({ mode: input.permissionMode, executionPolicy: input.executionPolicy }),
      hook_event_name: event,
    };
    if (EVENT_SPECS[event].tool) {
      let toolInput = input.toolInput;
      if (FILE_PATH_TOOLS.has(input.toolName) && isObject(toolInput) && typeof toolInput.path === 'string' && !Object.hasOwn(toolInput, 'file_path')) {
        // Claude Code scripts read an absolute file_path; the ChatMCP field stays beside it
        toolInput = { ...toolInput, file_path: path.resolve(cwd, toolInput.path) };
      }
      payload.tool_name = input.toolName;
      payload.tool_input = toolInput ?? {};
      payload.tool_use_id = input.toolUseId ?? null;
      if (names.length > 1) payload.tool_aliases = names.slice(1);
      if (event === 'PostToolUse') payload.tool_response = input.toolResponse ?? null;
      if (event === 'PostToolUseFailure') payload.error = String(input.error ?? '');
    }
    payload.chatmcp_permission_mode = input.permissionMode ?? null;
    payload.chatmcp_execution_policy = input.executionPolicy ?? null;
    if (isObject(input.payloadExtra)) for (const [key, value] of Object.entries(input.payloadExtra)) if (!Object.hasOwn(payload, key)) payload[key] = value;
    return payload;
  }

  // ---------------------------------------------------------------------------------------------------------------- one handler
  async #program(command, cwd) {
    if (/^node(?:\.exe)?$/i.test(command)) return process.execPath; // the Hub's own Node: the installed app does not put one on PATH
    if (path.isAbsolute(command) || /[\\/]/.test(command)) {
      const file = path.resolve(cwd, command);
      const found = await fs.stat(file).then((info) => info.isFile(), () => false);
      if (!found) throw programError(`the program ${command} does not exist`);
      return file;
    }
    const withExtension = this.platform === 'win32' && !/\.[A-Za-z0-9]{1,4}$/.test(command);
    for (const candidate of withExtension ? [`${command}.exe`, `${command}.com`] : [command]) {
      const found = await resolveProgram(candidate);
      if (found) return found;
    }
    if (withExtension && (await resolveProgram(`${command}.cmd`) || await resolveProgram(`${command}.bat`))) throw programError(`${command} is a batch file; start it through "shell": "cmd" (a program cannot be started from a .cmd directly)`);
    throw programError(`the program ${command} is not on PATH`);
  }

  async #invocation(handler, cwd) {
    const expand = (text) => text.replace(/\$\{(?:CLAUDE|CHATMCP)_PROJECT_DIR\}/g, cwd);
    if (Array.isArray(handler.args)) {
      return { file: await this.#program(expand(handler.command), cwd), args: handler.args.map(expand), kind: 'exec', shell: null, environment: scrubEnv(this.env, { secrets: this.secrets() }) };
    }
    if (handler.shell === 'cmd') {
      if (this.platform !== 'win32') throw programError('the cmd shell exists on Windows only');
      const file = this.env.ComSpec || path.join(this.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
      return { file, args: ['/d', '/s', '/c', `"${expand(handler.command)}"`], kind: 'shell', shell: 'cmd', verbatim: true, environment: scrubEnv(this.env, { secrets: this.secrets() }) };
    }
    let shell;
    try { shell = await this.#shell.resolveShell(handler.shell); } catch (error) { throw programError(error.message); }
    // Claude Code rewrites the placeholder for PowerShell, which does not expand ${NAME}; bash and sh read the exported variable
    const command = shell.name === 'powershell' ? handler.command.replace(/\$\{((?:CLAUDE|CHATMCP)_PROJECT_DIR)\}/g, '${env:$1}') : handler.command;
    const invocation = await this.#shell.buildInvocation(shell, command);
    return { file: invocation.file, args: invocation.args, kind: 'shell', shell: shell.name, cleanup: invocation.cleanup, environment: this.#shell.environment(shell.name) };
  }

  async #execute(handler, context) {
    const { event, spec, payload, cwd, signal } = context;
    const started = Date.now();
    const record = {
      id: handler.id, event, source: handler.source, matcher: handler.matcher ?? null, kind: Array.isArray(handler.args) ? 'exec' : 'shell', shell: handler.shell ?? null,
      command: sanitizeHookText(handler.command, { secrets: this.secrets(), max: 300 }), at: isoNow(this.now),
      exitCode: null, signal: null, timedOut: false, cancelled: false, failure: null, spawnError: null, durationMs: 0, stdoutBytes: 0, stdoutKept: 0, stderrBytes: 0, stdoutTruncated: false,
      decision: 'none', blocked: false, reason: null, feedback: null, additionalContext: null, systemMessage: null, ignored: [],
    };
    let invocation;
    try { invocation = await this.#invocation(handler, cwd); } catch (error) {
      record.failure = 'spawn';
      record.spawnError = sanitizeHookText(error?.message, { secrets: this.secrets(), max: 300 });
      return this.#interpret(handler, spec, record, { stdout: '', stderr: '' }, started);
    }
    record.shell = invocation.shell;
    try {
      const result = await this.#spawn(invocation, payload, { cwd, timeoutMs: handler.timeout * 1000, signal });
      return this.#interpret(handler, spec, record, result, started);
    } finally { await invocation.cleanup?.(); }
  }

  #spawn(invocation, payload, { cwd, timeoutMs, signal }) {
    return new Promise((resolve) => {
      const environment = { ...invocation.environment, CLAUDE_PROJECT_DIR: cwd, CHATMCP_PROJECT_DIR: cwd };
      let child;
      try {
        child = spawn(invocation.file, invocation.args, {
          cwd, env: environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          detached: this.platform !== 'win32', windowsVerbatimArguments: invocation.verbatim === true,
        });
      } catch (error) { resolve({ spawnError: error, stdout: '', stderr: '' }); return; }
      this.#active.add(child);
      const stdout = new Capture(MAX_STDOUT_BYTES);
      const stderr = new Capture(MAX_STDERR_BYTES);
      let timedOut = false;
      let cancelled = false;
      let exited = null;
      let settled = false;
      let killing = null;
      let lingerTimer = null;
      let hardTimer = null;
      const destroyStreams = () => { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); };
      const finish = async (extra = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(lingerTimer); clearTimeout(hardTimer);
        signal?.removeEventListener('abort', onAbort);
        await killing; // the answer comes after the tree is gone, never while taskkill is still working
        this.#active.delete(child);
        destroyStreams();
        resolve({
          exitCode: exited?.code ?? null, signal: exited?.signal ?? null, timedOut, cancelled, stdout: stdout.text(), stderr: stderr.text(),
          stdoutBytes: stdout.total, stdoutKept: stdout.kept, stderrBytes: stderr.total, stdoutTruncated: stdout.truncated, ...extra,
        });
      };
      const stop = (why) => {
        if (why === 'timeout') timedOut = true; else cancelled = true;
        killing ??= stopOwned(child, { group: true }).catch(() => {});
        hardTimer ??= setTimeout(() => { destroyStreams(); void finish({ stuck: true }); }, KILL_WAIT_MS);
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const onAbort = () => stop('abort');
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});
      // A hook that exits without reading its input makes the write fail with EPIPE; that is the hook's business, never the Hub's.
      child.stdin.on('error', () => {});
      child.once('error', (error) => { void finish({ spawnError: error }); });
      // A program that left a background process holding our pipes would keep "close" from firing: give the streams a moment, then stop waiting.
      child.once('exit', (code, sig) => { exited = { code, signal: sig }; lingerTimer = setTimeout(() => { destroyStreams(); void finish(); }, LINGER_MS); });
      child.once('close', (code, sig) => { exited ??= { code, signal: sig }; void finish(); });
      if (signal?.aborted) onAbort();
      child.stdin.end(`${payload}\n`);
    });
  }

  #interpret(handler, spec, record, result, started) {
    const secrets = this.secrets();
    const text = (value, max = MAX_REASON_CHARS) => sanitizeHookText(value, { secrets, max });
    record.durationMs = Date.now() - started;
    record.exitCode = result.exitCode ?? null;
    record.signal = result.signal ?? null;
    record.timedOut = result.timedOut === true;
    record.cancelled = result.cancelled === true;
    record.stdoutBytes = result.stdoutBytes ?? 0;
    record.stdoutKept = result.stdoutKept ?? 0;
    record.stderrBytes = result.stderrBytes ?? 0;
    record.stdoutTruncated = result.stdoutTruncated === true;
    if (result.spawnError && !record.spawnError) { record.failure = 'spawn'; record.spawnError = text(result.spawnError.message, 300); }
    if (record.cancelled) return record;
    let failureText = null;
    if (record.failure === 'spawn') failureText = `the hook could not be started (${record.spawnError})`;
    else if (record.timedOut) { record.failure = 'timeout'; failureText = `the hook timed out after ${handler.timeout} s`; }
    else if (record.exitCode === 2) {
      // The exit code decides; whatever JSON came with it is not read.
      const reason = text(result.stderr) || 'the hook exited with code 2 and gave no reason';
      record.reason = reason;
      if (spec.exit2 === 'deny') { record.decision = 'deny'; record.blocked = true; } else if (spec.exit2 === 'block') record.blocked = true; else record.feedback = reason;
      return record;
    } else if (record.exitCode !== 0) {
      record.failure = 'exit';
      failureText = `the hook failed with exit code ${record.exitCode ?? result.signal ?? 'unknown'}${text(result.stderr, 200) ? `: ${text(result.stderr, 200).split('\n')[0]}` : ''}`;
    }
    if (failureText) {
      record.reason = text(failureText);
      if (handler.onFailure === 'block') {
        if (spec.exit2 === 'deny') { record.decision = 'deny'; record.blocked = true; } else if (spec.exit2 === 'block') record.blocked = true; else record.feedback = record.reason;
      }
      return record;
    }
    const read = readHookJson(record.event, result.stdout, result.stdoutTruncated === true, secrets);
    record.ignored = read.ignored;
    record.additionalContext = read.additionalContext;
    record.systemMessage = read.systemMessage;
    if (record.event === 'PreToolUse') {
      if (read.decision) { record.decision = read.decision; record.blocked = read.decision === 'deny'; record.reason = read.reason; }
    } else if (read.block) {
      if (spec.exit2 === 'block') record.blocked = true; else record.feedback = read.reason;
      record.reason = read.reason;
    }
    return record;
  }

  #aggregate(event, spec, outcome) {
    const texts = (list) => list.filter((item) => typeof item === 'string' && item);
    for (const record of outcome.fired) {
      outcome.ignored.push(...record.ignored.map((item) => ({ ...item, handler: record.id })));
      if (record.systemMessage) outcome.systemMessages.push(record.systemMessage);
    }
    outcome.additionalContext = texts(outcome.fired.map((record) => record.additionalContext));
    if (event === 'PreToolUse') {
      const by = (decision) => outcome.fired.find((record) => record.decision === decision);
      const deny = by('deny');
      const ask = by('ask');
      if (deny) { outcome.permission = 'deny'; outcome.blocked = true; outcome.reason = deny.reason ?? 'blocked by a hook'; } else if (ask) { outcome.permission = 'ask'; outcome.reason = ask.reason; } else if (by('allow')) outcome.permission = 'allow';
      return;
    }
    if (spec.exit2 === 'feedback') { outcome.feedback.push(...texts(outcome.fired.map((record) => record.feedback))); return; }
    const blocking = outcome.fired.find((record) => record.blocked);
    if (blocking) { outcome.blocked = true; outcome.reason = blocking.reason ?? 'blocked by a hook'; }
  }

  /** Kills every hook that is still running (Hub shutdown). Runs in progress reject with code hooks_closed; the runner stays usable. */
  async close() {
    const lifecycle = this.#lifecycle;
    this.#lifecycle = new AbortController();
    lifecycle.abort(Object.assign(new Error('The hooks runner was closed.'), { code: 'hooks_closed' }));
    await Promise.allSettled([...this.#running]);
    await Promise.allSettled([...this.#active].map((child) => stopOwned(child, { group: true })));
  }
}

/**
 * The text parts the guard appends to a tool result for the model: feedback of a Post hook (stderr of exit 2, a block reason) and
 * additionalContext. Each is labelled so the model can tell it from the tool's own output.
 */
export function hookTextParts(outcome) {
  const label = outcome.event;
  return [
    ...outcome.feedback.map((text) => ({ type: 'text', text: `[Hook feedback · ${label}]\n${text}` })),
    ...outcome.additionalContext.map((text) => ({ type: 'text', text: `[Hook context · ${label}]\n${text}` })),
  ];
}
