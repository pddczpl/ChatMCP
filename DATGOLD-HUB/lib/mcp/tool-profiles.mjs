// The tool profiles of the Hub's MCP server (docs/MCP-SERVER.md "Tool profiles", roadmap P6 ext-19): which of the Hub's own tools a local
// MCP client may call, decided by the scope of the token it presents (lib/mcp/server-scope.mjs, kept by lib/mcp/server-token.mjs).
//
//   verify  (the default) the project's checks and Git's view of the work: discover the checks, run one of the fixed check commands as a
//           background task (a handle comes back at once: a tunnel call must not take more than 120 s) or in the foreground, follow and
//           cancel it, the Studio's test discovery, whitespace check and review against a checkpoint, git status and diff. The results
//           of a finished check carry the Hub's receipt (lib/verification-receipt.mjs mcpCheckReceipt).
//   read    reading the workspace: files, folders, search, the repository map, code symbols, definitions and references, git log.
//   write   changing it: the edit and file tools, run_command, Git bookkeeping, the plan, refactorings.
//
// Every tool keeps the name, input schema, description and annotations of the Hub's own definition (hubToolCatalog of lib/mcp/host.mjs:
// local.* and the Studio tools the local backend offers); nothing here restates what a tool does. Two additions: tasks_run in verify takes
// only the fixed check commands of test_run (its `command` is an enum, so the SDK refuses any other text before anything is asked), and
// the check results carry an outputSchema. The table is checked when it is built (buildToolProfiles): a read-only tool under write, a
// tool that changes something under read (or under verify unless it is one of verify's declared runners), a tool in two profiles, an
// unknown target or profile and an annotations override that differs from the definition are refused.
//
// The Proof-of-Done tools of P4 are not built yet: verify_run, evidence_pack and receipt_get (RESERVED_VERIFY_TOOLS) are served by no
// profile. When they exist, they are added to PROFILE_TABLE.verify here, with their outputSchema, and the counts in
// tests/verify-mcp-profiles.mjs change with them.
import { clientIdOf, hubToolCatalog } from './host.mjs';
import { DEFAULT_SCOPE, PROFILE_NAMES, scopeOrNone } from './server-scope.mjs';
import { mcpCheckReceipt } from '../verification-receipt.mjs';

export { hubToolCatalog };

/** The commands test_run runs (lib/agent-capabilities.mjs shellTest) and test_discover finds: the only commands tasks_run takes in verify. */
export const CHECK_COMMANDS = Object.freeze(['npm test', 'node --test', 'python -m pytest', 'dotnet test']);
/** Proof-of-Done tools of P4 that do not exist yet: no profile serves them, and their names are not invented in tools/list. */
export const RESERVED_VERIFY_TOOLS = Object.freeze(['verify_run', 'evidence_pack', 'receipt_get']);
/** The names of the plan (docs/ROADMAP) that are no tool of the Hub, and the real tool each one is served as. */
export const PLAN_NAME_MAP = Object.freeze({
  checks_list: 'test_discover', checks_run: 'tasks_run', 'studio.checks': 'studio_checks', 'studio.diff_check': 'studio_diff_check', 'studio.review': 'studio_review',
});

// A name every client accepts: the MCP rule allows a dot, the function names of model APIs do not, so a Studio tool is studio_<tool>.
const PROFILE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const RECEIPT_SCHEMA = Object.freeze({
  type: 'object',
  description: 'The Hub\'s own record of the finished check (lib/verification-receipt.mjs). An exit code alone never verifies a test outcome.',
  properties: {
    schema: { type: 'integer' }, kind: { type: 'string', enum: ['verify'] }, receiptId: { type: 'string', pattern: '^verify:[0-9]+:[a-f0-9]{64}$' },
    step: { type: 'integer', minimum: 0 }, tool: { type: 'string' }, client: { type: ['string', 'null'] }, at: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    commandSucceeded: { type: 'boolean' }, testOutcomeVerified: { type: 'boolean', enum: [false] }, evidenceClassification: { type: 'string' },
  },
  required: ['kind', 'receiptId', 'step', 'tool', 'sha256', 'commandSucceeded', 'testOutcomeVerified', 'evidenceClassification'],
});
const CHECK_RUN_INPUT = Object.freeze({
  type: 'object',
  properties: {
    command: { type: 'string', enum: [...CHECK_COMMANDS], description: 'One of the fixed check commands (test_discover says which ones this project has). No other command is taken.' },
    cwd: { type: 'string', description: 'Working directory relative to the workspace.' },
    description: { type: 'string', maxLength: 300, description: 'Description of the check.' },
  },
  required: ['command'],
  additionalProperties: false,
});
const TASK_HANDLE_OUTPUT = Object.freeze({
  type: 'object',
  properties: { taskId: { type: 'string', description: 'The handle: pass it to tasks_status and tasks_cancel.' }, status: { type: 'string' } },
  required: ['taskId', 'status'],
});
const TASK_STATUS_OUTPUT = Object.freeze({
  type: 'object',
  properties: {
    taskId: { type: 'string' }, status: { type: 'string', description: 'running, completed, failed, cancelled or timed_out.' }, exitCode: { type: ['integer', 'null'] },
    error: { type: ['string', 'null'] }, receipt: RECEIPT_SCHEMA,
  },
  required: ['taskId', 'status'],
});
const TEST_RUN_OUTPUT = Object.freeze({
  type: 'object',
  properties: {
    framework: { type: 'string' }, exitCode: { type: ['integer', 'null'] }, timedOut: { type: 'boolean' }, cancelled: { type: 'boolean' }, durationMs: { type: 'number' },
    truncated: {}, receipt: RECEIPT_SCHEMA,
  },
  required: ['framework', 'exitCode'],
});

const entry = (name, target, extra = {}) => Object.freeze({ name, target, ...extra });
/**
 * The profiles: each tool in exactly one. `runner`: a verify tool that runs or stops a check (it is not read-only; the gate asks the owner).
 * `receipt`: 'always' (test_run) or 'terminal' (tasks_status, once the task has ended) adds the Hub's receipt to the structured result.
 */
export const PROFILE_TABLE = Object.freeze({
  verify: Object.freeze([
    entry('test_discover', 'local.test_discover'),
    entry('tasks_run', 'local.tasks_run', { runner: true, inputSchema: CHECK_RUN_INPUT, outputSchema: TASK_HANDLE_OUTPUT }),
    entry('tasks_status', 'local.tasks_status', { outputSchema: TASK_STATUS_OUTPUT, receipt: 'terminal' }),
    entry('tasks_cancel', 'local.tasks_cancel', { runner: true }),
    entry('test_run', 'local.test_run', { runner: true, outputSchema: TEST_RUN_OUTPUT, receipt: 'always' }),
    entry('test_results', 'local.test_results'),
    entry('studio_checks', 'studio.checks'),
    entry('studio_diff_check', 'studio.diff_check'),
    entry('studio_review', 'studio.review'),
    entry('git_status', 'local.git_status'),
    entry('git_diff', 'local.git_diff'),
  ]),
  read: Object.freeze(['read_file', 'list_directory', 'find_files', 'search_files', 'repo_map', 'code_symbols', 'find_definition', 'find_references', 'git_log']
    .map((name) => entry(name, `local.${name}`))),
  write: Object.freeze(['edit_file', 'write_file', 'files_apply_patch', 'files_write_batch', 'make_directory', 'move_path', 'delete_path', 'run_command',
    'git_add', 'git_commit', 'git_branch', 'git_checkout', 'git_merge', 'update_plan', 'knowledge_create', 'rename_symbol', 'format_document', 'organize_imports']
    .map((name) => entry(name, `local.${name}`))),
});

/**
 * The table checked against the Hub's definitions: `tools` (MCP name -> {name, target, profile, write, runner, receipt, definition}) and
 * `byProfile` (profile -> names, in the table's order). Throws (TypeError) for a table that breaks a rule above.
 */
export function buildToolProfiles(table = PROFILE_TABLE, catalog = hubToolCatalog()) {
  if (!plainObject(table)) throw new TypeError('The tool profiles must be an object of profiles.');
  const declared = Object.keys(table);
  if (declared.length !== PROFILE_NAMES.length || !PROFILE_NAMES.every((name) => declared.includes(name))) {
    throw new TypeError(`The tool profiles must declare exactly ${PROFILE_NAMES.join(', ')} (got ${declared.join(', ') || 'none'}).`);
  }
  const tools = new Map();
  const targets = new Set();
  const byProfile = {};
  for (const profile of PROFILE_NAMES) {
    if (!Array.isArray(table[profile])) throw new TypeError(`The profile ${profile} must be a list of tools.`);
    byProfile[profile] = [];
    for (const spec of table[profile]) {
      const name = spec?.name;
      if (typeof name !== 'string' || !PROFILE_TOOL_NAME.test(name) || name === 'hub_status' || RESERVED_VERIFY_TOOLS.includes(name)) throw new TypeError(`Invalid profile tool name: ${JSON.stringify(name)}.`);
      if (tools.has(name) || targets.has(spec.target)) throw new TypeError(`The tool ${name} (${spec.target}) is listed twice: a tool belongs to one profile.`);
      const own = typeof spec.target === 'string' ? catalog.get(spec.target) : undefined;
      if (!own) throw new TypeError(`The profile tool ${name} names ${JSON.stringify(spec.target)}, which is no tool of the Hub.`);
      if (spec.annotations !== undefined && JSON.stringify(spec.annotations) !== JSON.stringify(own.annotations)) {
        throw new TypeError(`The annotations of ${name} differ from the definition of ${spec.target}: the profiles take them from the definition.`);
      }
      const readOnly = own.annotations?.readOnlyHint === true;
      if (profile === 'write' && readOnly) throw new TypeError(`${name} is read-only (readOnlyHint) but listed under write: it belongs in read or verify.`);
      if (profile === 'read' && !readOnly) throw new TypeError(`${name} is not read-only, so it cannot be in read.`);
      if (profile === 'verify' && !readOnly && spec.runner !== true) throw new TypeError(`${name} is not read-only: in verify only a declared runner of checks may be.`);
      const definition = {
        name, description: own.description, inputSchema: structuredClone(spec.inputSchema ?? own.inputSchema), annotations: structuredClone(own.annotations),
        ...(spec.outputSchema !== undefined ? { outputSchema: structuredClone(spec.outputSchema) } : {}),
      };
      tools.set(name, Object.freeze({ name, target: spec.target, profile, write: profile === 'write', runner: spec.runner === true, receipt: spec.receipt ?? null, definition: Object.freeze(definition) }));
      targets.add(spec.target);
      byProfile[profile].push(name);
    }
  }
  return Object.freeze({ tools, byProfile: Object.freeze(Object.fromEntries(Object.entries(byProfile).map(([profile, names]) => [profile, Object.freeze(names)]))) });
}

let built = null;
const profiles = () => (built ??= buildToolProfiles());

/** The profile a tool name belongs to (exact name: case and spaces count), or null. hub_status belongs to none: every token may call it. */
export function profileOf(name) { return profiles().tools.get(name)?.profile ?? null; }

/** The host's tools for the Hub (McpHost tools): every profile tool, its target, whether it is a write, its input and output schemas. */
export const PROFILE_HOST_TOOLS = Object.freeze([...profiles().tools.values()].map((spec) => Object.freeze({
  name: spec.name, target: spec.target, profile: spec.profile, write: spec.write, inputSchema: spec.definition.inputSchema,
  ...(spec.definition.outputSchema !== undefined ? { outputSchema: spec.definition.outputSchema } : {}),
})));

const refusal = (code, message, extra = {}) => ({ isError: true, content: [{ type: 'text', text: `${code}: ${message}` }], structuredContent: { error: { code, message, ...extra }, executed: false } });
const STATUS_TOOL = Object.freeze({
  name: 'hub_status', title: 'DatGold Hub status',
  description: 'Says that the DatGold Hub MCP server runs, its version, the scope of this token and the tools it allows. It reads no workspace and changes nothing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

/**
 * The provider of the Hub's MCP server with the profiles (startHubMcpServer spreads it): the tools of the request's scope beside hub_status,
 * the scope challenge that answers a tools/call outside the scope with HTTP 403 insufficient_scope before anything runs (createMcpServerFactory),
 * and the call, which checks the scope of the request and the token's scope now, and again once the owner has answered (the host's
 * stillAllowed), before the host runs anything. The scope of a request is `authInfo.scopes`, which the listener sets from the token.
 */
export function mcpProfileProvider({ host, version, product = 'DatGold', now = () => new Date() }) {
  const served = new Set(host.tools().map((tool) => tool.name));
  const specOf = (name) => (served.has(name) ? profiles().tools.get(name) ?? null : null);
  const inScope = (scope) => host.tools().filter((tool) => scope.includes(specOf(tool.name)?.profile));
  let step = 0;
  return {
    tools: (request) => [STATUS_TOOL, ...inScope(scopeOrNone(request?.authInfo?.scopes))],
    scopeChallenge(name, authInfo) {
      const spec = specOf(name);
      if (!spec || scopeOrNone(authInfo?.scopes).includes(spec.profile)) return undefined;
      return { scopes: [spec.profile], errorDescription: `This token's scope does not include the ${spec.profile} profile, which ${spec.name} belongs to` };
    },
    async call(name, args, { signal, client = null, scopes, liveScopes } = {}) {
      const scope = scopeOrNone(scopes);
      if (name === 'hub_status') {
        const text = JSON.stringify({ product, version, mcpServer: 'ext-19 profiles', scope: [...scope], workspaceTools: inScope(scope).map((tool) => tool.name).sort(), defaultScope: [...DEFAULT_SCOPE] });
        return { content: [{ type: 'text', text }] };
      }
      const spec = specOf(name);
      if (!spec) return refusal('unknown_tool', `The DatGold MCP server has no tool ${String(name).slice(0, 128)}.`);
      const allowed = () => scope.includes(spec.profile) && (typeof liveScopes !== 'function' || scopeOrNone(liveScopes()).includes(spec.profile));
      if (!allowed()) return refusal('mcp_scope_refused', `${spec.name} needs the ${spec.profile} profile, which this token's scope does not include. Nothing ran.`, { required: spec.profile });
      const result = await host.call(name, args, { signal, client, stillAllowed: allowed });
      const observed = result?.structuredContent;
      // A refusal (its structuredContent has an error object) is no observation; tasks_status says `error: null` for a task that did not fail to start.
      if (!spec.receipt || !plainObject(observed) || plainObject(observed.error) || observed.executed === false) return result;
      if (spec.receipt === 'terminal' && !TERMINAL.has(observed.status)) return result;
      step += 1;
      const receipt = mcpCheckReceipt({ tool: spec.name, client: clientIdOf(client), step, observed: { ...observed }, at: now().toISOString() });
      return { ...result, structuredContent: { ...observed, receipt } };
    },
  };
}
