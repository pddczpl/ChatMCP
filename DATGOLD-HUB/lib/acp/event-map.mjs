// What an editor is told while a task runs, as pure functions of what the Hub records (plan task ux-20). The Hub's own streams of events send nothing in this build (docs/ACP.md), so the agent
// reads the record of the task again and again (GET /api/tasks/<id>) and this module says what is new in it: a tool call that started, one that ended, a message of the model, the plan,
// the use of the context. It knows nothing of the wire, of masking (every update leaves through the one function of lib/acp/agent.mjs that masks it) or of the Hub's routes.
//
// What is NOT said: the Hub's preparation and bookkeeping (`preflight`, `repo_map_*`, `context_budget`, `goal_evidence`, ...: its own words, in another language), the arguments of a call beyond
// the public `input` the Hub records for it (a path, a command), a checkpoint id, and the structured content of a result.
import path from 'node:path';

export const TOOL_KINDS = Object.freeze(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other']);
export const MAX_TITLE_CHARS = 200;
export const MAX_TOOL_OUTPUT_CHARS = 4000;
const MAX_LOCATIONS = 50;

// ---- the kind of a tool -------------------------------------------------------------------------------------------------------------------------------------------------
// By name, for every tool of the Hub's catalogs (tests/verify-acp-events.mjs reads the catalogs and fails for a tool that is not here). Names of the local tools are bare, the studio tools keep their prefix.
const KIND_GROUPS = {
  read: [
    'read_file', 'list_directory', 'git_status', 'git_diff', 'git_log', 'git_conflict_inspect', 'binary_inspect', 'tasks_list', 'tasks_status', 'worktrees_list', 'knowledge_list', 'token_stats', 'token_restore',
    'test_discover', 'test_results', 'test_coverage', 'test_impact_analysis', 'build_detect', 'skills_discover', 'code_diagnostics', 'dependency_graph', 'code_actions', 'type_hierarchy', 'debug_stack',
    'debug_variables', 'github_workflow_runs', 'github_workflow_status', 'github_job_logs', 'github_pr_review', 'github_read', 'browser_console', 'browser_network', 'browser_dom_snapshot', 'browser_assert',
    'screenshot_compare', 'visual_diff', 'accessibility_audit',
    'studio.tree', 'studio.read', 'studio.status', 'studio.diff', 'studio.diff_check', 'studio.checks', 'studio.skills', 'studio.checkpoints', 'studio.review', 'studio.index_status',
  ],
  search: [
    'repo_map', 'code_symbols', 'find_definition', 'find_references', 'find_files', 'search_files', 'symbols_search', 'symbols_references', 'knowledge_search', 'find_implementations', 'github_code_search',
    'docs_search', 'web_search', 'studio.search', 'studio.symbols', 'studio.references', 'studio.definitions',
  ],
  edit: ['write_file', 'edit_file', 'make_directory', 'files_write_batch', 'files_apply_patch', 'rename_symbol', 'format_document', 'organize_imports', 'knowledge_create', 'worktrees_create'],
  delete: ['delete_path', 'worktrees_remove'],
  move: ['move_path'],
  execute: [
    'run_command', 'tasks_run', 'tasks_cancel', 'test_run', 'build_run', 'git_add', 'git_commit', 'git_branch', 'git_checkout', 'git_merge', 'git_push', 'debug_start', 'debug_breakpoint', 'debug_continue',
    'debug_step', 'debug_evaluate', 'debug_stop', 'github_action', 'github_rerun_failed', 'github_pr_merge', 'github_release_create',
  ],
  think: ['update_plan', 'get_plan', 'studio.plan_get', 'studio.plan_set', 'spawn_agent', 'spawn_workflow', 'agent_results', 'skill_load'],
  fetch: ['web_fetch', 'web_extract', 'dependency_lookup', 'browser_navigate'],
  other: ['browser_launch', 'browser_click', 'browser_fill', 'browser_screenshot', 'browser_close', 'screenshot_capture', 'browser_trace_start', 'browser_trace_stop', 'responsive_check', 'token_profile', 'studio.checkpoint'],
};
const KIND_OF = new Map(Object.entries(KIND_GROUPS).flatMap(([kind, names]) => names.map((name) => [name, kind])));

/** The name of a tool as the table has it: the local tools lose their prefix, the studio tools keep theirs. */
const tableName = (toolName) => (typeof toolName === 'string' ? toolName.replace(/^local\./, '') : '');

/**
 * The kind of a tool call (the icon an editor draws). A tool that is not in the table (another program's, through MCP) is `other`; with `{strict: true}` it is null, which is what the test asks
 * to find a tool of the Hub that nobody has given a kind.
 */
export function kindOf(toolName, { strict = false } = {}) {
  const kind = KIND_OF.get(tableName(toolName));
  if (kind !== undefined) return kind;
  return strict ? null : 'other';
}

// ---- the title of a tool call -------------------------------------------------------------------------------------------------------------------------------------------
const FIXED_TITLES = new Map([
  ['web_fetch', 'Fetch a web page'], ['web_extract', 'Extract a web page'], ['web_search', 'Search the web'], ['docs_search', 'Search the documentation'], ['dependency_lookup', 'Look up a dependency'],
  ['update_plan', 'Update the plan'], ['studio.plan_set', 'Update the plan'], ['get_plan', 'Read the plan'], ['studio.plan_get', 'Read the plan'], ['spawn_agent', 'Start a helper agent'],
  ['spawn_workflow', 'Start a workflow'], ['agent_results', 'Read the results of the helper agents'], ['skill_load', 'Load a skill'], ['files_apply_patch', 'Apply a patch'],
]);
const VERBS = new Map([
  ['read_file', 'Read'], ['studio.read', 'Read'], ['list_directory', 'List'], ['studio.tree', 'List'], ['write_file', 'Write'], ['edit_file', 'Edit'], ['delete_path', 'Delete'], ['make_directory', 'Create folder'],
  ['run_command', 'Run'], ['files_write_batch', 'Write'],
]);
const SEARCHES = new Map([['search_files', 'Search files'], ['studio.search', 'Search files'], ['find_files', 'Find files']]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const clip = (value, limit) => (value.length <= limit ? value : `${value.slice(0, limit - 1)}…`);
const humanize = (name) => {
  const words = String(name).split(/[._\s-]+/).filter(Boolean).join(' ');
  return words ? words[0].toUpperCase() + words.slice(1) : '';
};

/** A title in plain English for the call, from its tool name and the public input the Hub records for it (a path, a list of paths, a source and a destination, a command). */
export function titleOf(toolName, input) {
  if (typeof toolName !== 'string' || toolName === '') return 'Tool call';
  const name = tableName(toolName);
  const source = isObject(input) ? input : {};
  const first = text(source.path);
  const many = Array.isArray(source.paths) ? source.paths.filter((value) => text(value) !== null) : [];
  const command = text(source.command);
  const fixed = FIXED_TITLES.get(name);
  if (fixed !== undefined) return clip(fixed, MAX_TITLE_CHARS);
  const search = SEARCHES.get(name);
  if (search !== undefined) return clip(first ? `${search} in ${first}` : search, MAX_TITLE_CHARS);
  if (name === 'move_path') {
    const from = text(source.source);
    const to = text(source.destination);
    return clip(from && to ? `Move ${from} to ${to}` : from ? `Move ${from}` : 'Move a file', MAX_TITLE_CHARS);
  }
  const verb = VERBS.get(name);
  if (verb !== undefined) {
    if (name === 'files_write_batch' && many.length > 1) return `Write ${many.length} files`;
    const detail = name === 'run_command' ? command : (first ?? (many.length === 1 ? text(many[0]) : null));
    return clip(detail ? `${verb} ${detail}` : humanize(name), MAX_TITLE_CHARS);
  }
  // Anything else: the words of its name (without the name of the program it belongs to) and what it was about.
  const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const detail = command ?? first ?? (many.length === 1 ? text(many[0]) : null);
  const base = humanize(bare) || 'Tool call';
  return clip(detail ? `${base} ${detail}` : base, MAX_TITLE_CHARS);
}

// ---- where a call happened ----------------------------------------------------------------------------------------------------------------------------------------------
/** The files of a call that are inside the folder of the session, as absolute paths (the editor opens them). A path outside the folder, empty, not a string or with a NUL is not a location. */
export function locationsOf(input, cwd) {
  if (!isObject(input) || typeof cwd !== 'string' || cwd === '') return [];
  const candidates = [input.path, ...(Array.isArray(input.paths) ? input.paths : []), input.source, input.destination];
  const found = [];
  const seen = new Set();
  for (const value of candidates) {
    if (typeof value !== 'string' || value === '' || value.includes('\u0000')) continue;
    const absolute = path.resolve(cwd, value);
    const relative = path.relative(cwd, absolute);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    found.push({ path: absolute });
    if (found.length >= MAX_LOCATIONS) break;
  }
  return found;
}

// ---- the result of a call -----------------------------------------------------------------------------------------------------------------------------------------------
const FAILED = new Set(['failed', 'error', 'refused', 'denied']);
/** `{failed, text}` of a tool_result event: the Hub writes `{isError, content: [{type: 'text', text}], structuredContent}` as the message; anything else is taken as plain text. */
function resultOf(event) {
  let parsed = null;
  try { parsed = typeof event.message === 'string' ? JSON.parse(event.message) : null; } catch { parsed = null; }
  const structured = isObject(parsed);
  let words = '';
  if (structured) {
    if (Array.isArray(parsed.content)) words = parsed.content.filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n\n');
  } else if (typeof event.message === 'string') words = event.message;
  const failed = (structured && parsed.isError === true) || FAILED.has(String(event.status));
  if (words.length > MAX_TOOL_OUTPUT_CHARS) words = `${words.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… ${words.length - MAX_TOOL_OUTPUT_CHARS} characters not shown`;
  return { failed, text: words };
}

const PLAN_STATUS = new Map([['working', 'in_progress'], ['has_evidence', 'completed']]);
const wholeCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * The state of one turn of one session: how far the record has been read, which calls have been announced, what was said as a message, the last plan and the last use of the context.
 * `next(task)` gives the updates that are new in the record `task` (as `GET /api/tasks/<id>` returns it), in order; called again with the same or a later record it never repeats an update.
 * @param {{cwd: string, from?: number, usageMark?: {requests: number, input: number, output: number}}} options
 *   `from`: the number of events of the task that were there before this turn (a turn that continues a task starts after them); `usageMark`: the usage at the end of the turn before.
 */
export function createTurnMapper({ cwd, from = 0, usageMark = null } = {}) {
  let cursor = wholeCount(from) ? from : 0;
  let missed = 0;
  const calls = new Map(); // callId -> { status }
  const said = new Set(); // the trimmed texts of the model that were sent as messages
  let lastPlan = null;
  let mark = usageMark;

  const announce = (event, task, status) => {
    const input = isObject(event.input) ? event.input : undefined;
    const locations = locationsOf(input, cwd);
    return {
      sessionUpdate: 'tool_call',
      toolCallId: event.callId,
      title: titleOf(event.toolName, input),
      kind: kindOf(event.toolName),
      status,
      ...(locations.length ? { locations } : {}),
      ...(input ? { rawInput: input } : {}),
    };
  };

  const mapEvent = (event, task, updates) => {
    if (!isObject(event) || typeof event.type !== 'string') return;
    if (event.type === 'tool_start') {
      if (typeof event.callId !== 'string' || event.callId === '' || calls.has(event.callId)) return;
      const waiting = isObject(task.pendingCall) && task.pendingCall.callId === event.callId && task.pendingCall.phase === 'awaiting_approval';
      const status = waiting ? 'pending' : 'in_progress';
      calls.set(event.callId, { status });
      updates.push(announce(event, task, status));
    } else if (event.type === 'tool_result' || event.type === 'tool_error') {
      // A call the owner refused, the permission gate blocked (a protected path) or that failed is a `tool_error` of its own; the words are the same kind of message, or plain words.
      if (typeof event.callId !== 'string' || event.callId === '') return;
      const result = resultOf(event);
      const status = result.failed || event.type === 'tool_error' ? 'failed' : 'completed';
      const content = result.text ? [{ type: 'content', content: { type: 'text', text: result.text } }] : undefined;
      const known = calls.get(event.callId);
      if (known === undefined) {
        updates.push({ ...announce(event, task, status), ...(content ? { content } : {}) });
      } else {
        updates.push({ sessionUpdate: 'tool_call_update', toolCallId: event.callId, status, ...(content ? { content } : {}) });
      }
      calls.set(event.callId, { status });
    } else if (event.type === 'assistant') {
      if (typeof event.message !== 'string' || event.message.trim() === '') return;
      said.add(event.message.trim());
      updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.message } });
    }
  };

  const planOf = (goalPlan) => {
    if (!isObject(goalPlan) || goalPlan.version !== 1 || !Array.isArray(goalPlan.phases)) return null;
    const entries = [];
    for (const phase of goalPlan.phases) {
      const title = isObject(phase) ? text(phase.title) : null;
      if (title === null) continue;
      entries.push({ content: clip(title, MAX_TITLE_CHARS), priority: 'medium', status: PLAN_STATUS.get(phase.status) ?? 'pending' });
    }
    return entries.length ? entries : null;
  };

  // The use of the context, said only from numbers the provider reported and only when exactly one response was added since the last look: the Hub keeps SUMS, and the sum of several
  // responses is not the size of the context. The window is the one the Hub plans against, and only when it is not a fallback or an estimate.
  const usageOf = (task) => {
    const usage = task.usage;
    if (!isObject(usage) || !wholeCount(usage.httpRequests) || !wholeCount(usage.inputTokens) || !wholeCount(usage.outputTokens)) return null;
    if (usage.inputUsageMissing !== 0 || usage.outputUsageMissing !== 0) return null;
    const now = { requests: usage.httpRequests, input: usage.inputTokens, output: usage.outputTokens };
    const before = mark ?? { requests: 0, input: 0, output: 0 };
    mark = now;
    if (now.requests - before.requests !== 1) return null;
    const policy = task.contextPolicy;
    if (!isObject(policy) || policy.source === 'conservative_fallback' || policy.approximate === true || !Number.isSafeInteger(policy.capacityTokens) || policy.capacityTokens <= 0) return null;
    const used = (now.input - before.input) + (now.output - before.output);
    if (!(used > 0) || used > policy.capacityTokens) return null;
    return { sessionUpdate: 'usage_update', used, size: policy.capacityTokens };
  };

  return {
    /** How many events of the task have been read (the cursor of the next turn that continues it). */
    get cursor() { return cursor; },
    /** How many events the Hub had already dropped from its record when they were first looked for. */
    get missed() { return missed; },
    /** The usage at the last look, to start the next turn from. */
    get usageMark() { return mark; },
    next(task) {
      if (!isObject(task)) return [];
      const updates = [];
      const events = Array.isArray(task.events) ? task.events : [];
      const total = wholeCount(task.eventCount) && task.eventCount >= events.length ? task.eventCount : events.length;
      const base = total - events.length;
      if (cursor < base) { missed += base - cursor; cursor = base; }
      for (const event of events.slice(cursor - base)) mapEvent(event, task, updates);
      if (total > cursor) cursor = total;
      // A call that waited for an approval and now runs.
      const pending = task.pendingCall;
      if (isObject(pending) && typeof pending.callId === 'string' && pending.phase === 'executing' && calls.get(pending.callId)?.status === 'pending') {
        calls.set(pending.callId, { status: 'in_progress' });
        updates.push({ sessionUpdate: 'tool_call_update', toolCallId: pending.callId, status: 'in_progress' });
      }
      const entries = planOf(task.goalPlan);
      if (entries !== null) {
        const key = JSON.stringify(entries);
        if (key !== lastPlan) { lastPlan = key; updates.push({ sessionUpdate: 'plan', entries }); }
      }
      const meter = usageOf(task);
      if (meter !== null) updates.push(meter);
      return updates;
    },
    /** What is left to say at the end of the turn: the answer of the task, less what was already said as messages of the model (the sentences of the Hub that follow the words are kept). */
    finalText(task) {
      if (!isObject(task)) return '';
      const parts = task.finalParts;
      const candidates = isObject(parts) ? [parts.words, parts.verificationNotice, parts.hookNotice] : [task.finalText];
      return candidates.map(text).filter((value) => value !== null && !said.has(value)).join('\n\n');
    },
  };
}
