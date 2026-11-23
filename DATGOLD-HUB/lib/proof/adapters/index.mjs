// The output adapters of `chatmcp verify exec --adapter <name>` (docs/PROOF-CLI.md, "exec", "Adapters"). An adapter reads the
// machine-readable output an agent CLI wrote on its stdout, in the shape its vendor documents, and nothing else: it is handed the text,
// it imports nothing, opens no file, starts no process and makes no network call. What it can read: the agent's final message (where the
// claim marker is), the cost when the output states one, the model and the CLI's version when the output names them, and whether the CLI
// reported an error.
//
// Agent CLIs change quickly, so adapters are optional and stamped: `version` is the adapter's own version (raised whenever what it reads
// changes), `checked` the day its documentation was read, `documentation` the pages it follows. Output an adapter does not recognise is
// reported (`recognized: false` and the reason) and nothing of it is used; exec then reads the claim from stdout as plain text.

const MODEL_CHARS = 200;
const VERSION_CHARS = 64;
const MAX_COST = 1e9;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null);
const none = (reason) => ({ recognized: false, reason, finalMessage: null, cost: null, model: null, agentVersion: null, isError: null });

/** The non-empty lines of `output`, each parsed as a JSON object; null when one is not. */
function jsonLines(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { return null; }
    if (!isObject(value)) return null;
    rows.push(value);
  }
  return rows;
}

/**
 * Claude Code in print mode: `claude -p ... --output-format json` prints one result object; `--output-format stream-json` prints JSON
 * Lines whose first event is usually {type: 'system', subtype: 'init', model, claude_code_version} and whose last is the result. The
 * result (the SDK's SDKResultMessage) holds `result` (the final text; error results have `errors` instead), `is_error`, `subtype` and
 * `total_cost_usd`, which the docs call an estimate made on the client: so it is a known subtotal, never a complete cost.
 */
function readClaude(output) {
  const trimmed = output.trim();
  if (!trimmed) return none('empty');
  let events;
  try {
    const whole = JSON.parse(trimmed);
    events = isObject(whole) ? [whole] : null;
    if (!events) return none('no_result');
  } catch {
    events = jsonLines(output);
    if (!events) return none('not_json');
  }
  const result = events.findLast((event) => event.type === 'result');
  if (!result) return none('no_result');
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init') ?? null;
  const total = result.total_cost_usd;
  const cost = typeof total === 'number' && Number.isFinite(total) && total >= 0 && total <= MAX_COST ? { currency: 'USD', knownSubtotal: total, complete: false } : null;
  return {
    recognized: true, reason: null,
    finalMessage: typeof result.result === 'string' ? result.result : null,
    cost,
    model: text(init?.model, MODEL_CHARS),
    agentVersion: text(init?.claude_code_version, VERSION_CHARS),
    isError: typeof result.is_error === 'boolean' ? result.is_error : null,
  };
}

const CODEX_EVENTS = /^(?:thread\.started|turn\.(?:started|completed|failed)|item\.(?:started|updated|completed)|error)$/;
/**
 * Codex: `codex exec --json` prints JSON Lines of events. The final message is the text of the last `item.completed` event whose item is
 * an `agent_message`; `turn.failed` or `error` is an error, `turn.completed` the end of a turn. The documented events state tokens, no
 * cost, no model and no version.
 */
function readCodex(output) {
  if (!output.trim()) return none('empty');
  const events = jsonLines(output);
  if (!events || events.some((event) => typeof event.type !== 'string')) return none('not_json');
  if (!events.some((event) => CODEX_EVENTS.test(event.type))) return none('no_events');
  const message = events.findLast((event) => event.type === 'item.completed' && isObject(event.item) && event.item.type === 'agent_message' && typeof event.item.text === 'string');
  const failed = events.some((event) => event.type === 'turn.failed' || event.type === 'error');
  const completed = events.some((event) => event.type === 'turn.completed');
  return {
    recognized: true, reason: null, finalMessage: message ? message.item.text : null, cost: null, model: null, agentVersion: null,
    isError: failed ? true : completed ? false : null,
  };
}

/** opencode documents no machine-readable output of `opencode run`: this adapter reads nothing, so the claim comes from stdout as text. */
const readOpencode = () => none('format_not_documented');

const define = (adapter) => Object.freeze({ ...adapter, documentation: Object.freeze([...adapter.documentation]) });
/** The adapters: name -> {name, version, checked, documentation, reads}. */
export const ADAPTERS = Object.freeze({
  claude: define({
    name: 'claude', version: 1, checked: '2026-11-23',
    documentation: ['https://code.claude.com/docs/en/headless', 'https://code.claude.com/docs/en/agent-sdk/typescript'],
    reads: 'claude -p with --output-format json (one result object) or stream-json (JSON Lines: the system init event and the last result event): result, is_error, total_cost_usd as a known subtotal, model, claude_code_version',
    parse: readClaude,
  }),
  codex: define({
    name: 'codex', version: 1, checked: '2026-11-23',
    documentation: ['https://learn.chatgpt.com/docs/non-interactive-mode', 'https://github.com/openai/codex/blob/main/docs/exec.md'],
    reads: 'codex exec --json (JSON Lines of events): the text of the last completed agent_message item, turn.failed and error events; no cost is documented',
    parse: readCodex,
  }),
  opencode: define({
    name: 'opencode', version: 1, checked: '2026-11-23',
    documentation: ['https://opencode.ai/docs/cli/'],
    reads: 'nothing: opencode documents no machine-readable output of opencode run, so the claim is read from stdout as plain text',
    parse: readOpencode,
  }),
});
export const ADAPTER_NAMES = Object.freeze(Object.keys(ADAPTERS));

/**
 * Reads `output` (the agent's whole stdout, as text) with the adapter `name`. Returns {adapter, version, checked, recognized, reason,
 * finalMessage, cost, model, agentVersion, isError}: `reason` says why output was not recognised (`empty`, `not_json`, `no_result`,
 * `no_events`, `format_not_documented`); `cost` is null or {currency, knownSubtotal, complete}. Throws a TypeError for an unknown name.
 */
export function readAgentOutput(name, output) {
  const adapter = Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : null;
  if (!adapter) throw new TypeError(`unknown adapter ${JSON.stringify(String(name))}: ${ADAPTER_NAMES.join(', ')}`);
  if (typeof output !== 'string') throw new TypeError('readAgentOutput needs the agent\'s output as text');
  return { adapter: adapter.name, version: adapter.version, checked: adapter.checked, ...adapter.parse(output) };
}
