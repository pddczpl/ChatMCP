// A small model of how GitHub decides whether a workflow runs, for tests that must reason about triggers without GitHub.
//
// It reads the `on:` and `concurrency:` blocks of a workflow file and answers: "does this event start this workflow?" and "which
// concurrency group does the run join?". It implements the documented filter rules for `push` and `pull_request`: `branches`,
// `branches-ignore`, `tags`, `tags-ignore`, `paths`, `paths-ignore` (patterns `*`, `**`, and a leading `!`), the default activity types
// of `pull_request`, and the rule that a workflow with only `paths-ignore` is skipped when EVERY changed file matches.
//
// It is a model, not GitHub: it does not know about forks, required checks, `workflow_run`, schedules or the 300-file diff limit,
// and it throws on a pattern character it does not implement (`?`, `+`, `[`) instead of guessing. Whether GitHub agrees can only be
// seen on GitHub: the first pull request after a change shows it (scripts/ci-health.mjs reports runs per merged PR).

/** Strips a trailing comment (a `#` preceded by whitespace and outside quotes). */
function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index).trimEnd();
  }
  return line.trimEnd();
}

function parseScalar(text) {
  const value = text.trim();
  if (value === '') return null;
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  if (/^".*"$/.test(value)) return value.slice(1, -1);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function splitFlow(inner) {
  const items = [];
  let current = '';
  let quote = null;
  for (const char of inner) {
    if (quote) { current += char; if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === ',') { items.push(current); current = ''; continue; }
    current += char;
  }
  if (current.trim() !== '') items.push(current);
  return items;
}

function parseValue(text) {
  const value = text.trim();
  if (value.startsWith('[') && value.endsWith(']')) return splitFlow(value.slice(1, -1)).map(parseScalar);
  return parseScalar(value);
}

/** Indentation-based parser for the YAML subset that workflow headers use: mappings, block and flow sequences, scalars. */
function parseBlock(lines, start, indent) {
  let index = start;
  if (index >= lines.length) return [null, index];
  if (lines[index].text.startsWith('- ') || lines[index].text === '-') {
    const list = [];
    while (index < lines.length && lines[index].indent === indent && (lines[index].text.startsWith('- ') || lines[index].text === '-')) {
      const rest = lines[index].text.slice(1).trim();
      // `- cron: '23 5 * * 1'` (schedule): an item that is one key and one scalar is a one-key mapping. A longer mapping inside a list is still not read.
      const single = rest.match(/^('[^']*'|"[^"]*"|[A-Za-z_][\w-]*)\s*:\s+(\S.*)$/);
      if (single && !(index + 1 < lines.length && lines[index + 1].indent > indent)) { list.push({ [parseScalar(single[1])]: parseValue(single[2]) }); index += 1; continue; }
      if (rest.includes(': ') || rest.endsWith(':')) throw new Error(`unsupported workflow header syntax (a mapping inside a list): ${lines[index].text}`);
      list.push(parseValue(rest));
      index += 1;
    }
    return [list, index];
  }
  const map = {};
  while (index < lines.length && lines[index].indent === indent) {
    const match = lines[index].text.match(/^('[^']*'|"[^"]*"|[^:\s][^:]*?)\s*:(?:\s+(.*))?$/);
    if (!match) throw new Error(`unsupported workflow header syntax: ${lines[index].text}`);
    const key = parseScalar(match[1]);
    const rest = match[2];
    index += 1;
    if (rest !== undefined && rest !== '' && !/^[|>][-+]?$/.test(rest)) { map[key] = parseValue(rest); continue; }
    if (rest !== undefined && /^[|>]/.test(rest)) { while (index < lines.length && lines[index].indent > indent) index += 1; map[key] = '<block scalar>'; continue; }
    if (index < lines.length && lines[index].indent > indent) {
      const [value, next] = parseBlock(lines, index, lines[index].indent);
      map[key] = value; index = next;
    } else if (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith('- ')) {
      const [value, next] = parseBlock(lines, index, indent);
      map[key] = value; index = next;
    } else map[key] = null;
  }
  return [map, index];
}

/** The top-level blocks of a workflow file as raw lines, by key (`on`, `concurrency`, `name`, ...). */
function topLevelBlocks(text) {
  const blocks = {};
  let current = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*#/.test(raw) || raw.trim() === '') { continue; }
    if (/^\S/.test(raw)) {
      const match = raw.match(/^('on'|"on"|on|name|concurrency|permissions|env|defaults|jobs)\s*:(.*)$/);
      current = match ? { key: match[1].replace(/['"]/g, ''), inline: stripComment(match[2]).trim(), lines: [] } : null;
      if (current) blocks[current.key] = current;
    } else if (current) current.lines.push(raw);
  }
  return blocks;
}

function parseHeader(block) {
  if (!block) return undefined;
  if (block.inline !== '') return parseValue(block.inline);
  const lines = block.lines.map((raw) => stripComment(raw)).filter((raw) => raw.trim() !== '')
    .map((raw) => ({ indent: raw.length - raw.trimStart().length, text: raw.trim() }));
  if (lines.length === 0) return null;
  return parseBlock(lines, 0, lines[0].indent)[0];
}

/** @returns {{name: string|null, on: Record<string, any>, concurrency: any}} the trigger-relevant header of a workflow file */
export function parseWorkflow(text) {
  const blocks = topLevelBlocks(text);
  let on = parseHeader(blocks.on);
  if (typeof on === 'string') on = { [on]: null };
  else if (Array.isArray(on)) on = Object.fromEntries(on.map((name) => [name, null]));
  const concurrency = parseHeader(blocks.concurrency);
  return { name: blocks.name ? String(parseHeader(blocks.name)) : null, on: on ?? {}, concurrency: concurrency ?? null };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// GitHub filter patterns
// ---------------------------------------------------------------------------------------------------------------------------------------
function globToRegExp(pattern) {
  if (/[?+[\]()]/.test(pattern.replace(/^!/, ''))) throw new Error(`filter pattern "${pattern}" uses a character this model does not implement`);
  let source = '';
  const body = pattern.replace(/^!/, '');
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '*' && body[index + 1] === '*') { source += '.*'; index += 1; }
    else if (char === '*') source += '[^/]*';
    else source += char.replace(/[.\\^$|{}]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** GitHub applies the patterns in order: a match includes, a later `!` pattern that matches excludes again. */
export function matchesFilter(patterns, value) {
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) { if (globToRegExp(pattern).test(value)) included = false; }
    else if (globToRegExp(pattern).test(value)) included = true;
  }
  return included;
}

const asList = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

function pathsAllow(config, files) {
  if (config.paths !== undefined) return files.some((file) => matchesFilter(asList(config.paths), file));
  if (config['paths-ignore'] !== undefined) return !files.every((file) => matchesFilter(asList(config['paths-ignore']), file));
  return true;
}

/**
 * Does this event start a run of the workflow? `event` is one of
 *   {name: 'push', branch, files}  {name: 'push', tag}  {name: 'pull_request', action, base, head, files}  {name: 'workflow_dispatch'}
 */
export function triggers(workflow, event) {
  const config = workflow.on[event.name];
  if (config === undefined) return false;
  const filters = config ?? {};
  if (event.name === 'workflow_dispatch') return true;
  if (event.name === 'push') {
    const hasBranches = filters.branches !== undefined || filters['branches-ignore'] !== undefined;
    const hasTags = filters.tags !== undefined || filters['tags-ignore'] !== undefined;
    if (event.tag !== undefined) {
      if (hasTags) {
        if (filters.tags !== undefined && !matchesFilter(asList(filters.tags), event.tag)) return false;
        if (filters['tags-ignore'] !== undefined && matchesFilter(asList(filters['tags-ignore']), event.tag)) return false;
      } else if (hasBranches) return false;
      return true;
    }
    if (hasBranches) {
      if (filters.branches !== undefined && !matchesFilter(asList(filters.branches), event.branch)) return false;
      if (filters['branches-ignore'] !== undefined && matchesFilter(asList(filters['branches-ignore']), event.branch)) return false;
    } else if (hasTags) return false;
    return pathsAllow(filters, event.files ?? []);
  }
  if (event.name === 'pull_request') {
    const types = filters.types !== undefined ? asList(filters.types) : ['opened', 'synchronize', 'reopened'];
    if (!types.includes(event.action)) return false;
    if (filters.branches !== undefined && !matchesFilter(asList(filters.branches), event.base)) return false;
    if (filters['branches-ignore'] !== undefined && matchesFilter(asList(filters['branches-ignore']), event.base)) return false;
    return pathsAllow(filters, event.files ?? []);
  }
  throw new Error(`this model does not know the event ${event.name}`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------------------------------------------------------------------
/** The `github` context of an event, as far as the expressions of the concurrency block use it. */
export function contextOf(event) {
  if (event.name === 'pull_request') return { event_name: 'pull_request', ref: `refs/pull/${event.number}/merge`, event: { pull_request: { number: event.number } } };
  if (event.name === 'push') return { event_name: 'push', ref: event.tag !== undefined ? `refs/tags/${event.tag}` : `refs/heads/${event.branch}`, event: {} };
  return { event_name: event.name, ref: 'refs/heads/main', event: {} };
}

function lookup(expression, context) {
  const parts = expression.trim().split('.');
  if (parts[0] !== 'github') throw new Error(`unsupported expression: ${expression}`);
  let value = context;
  for (const part of parts.slice(1)) value = value?.[part];
  return value;
}

/** Evaluates `${{ a || b }}` / `${{ github.event_name == 'pull_request' }}` (the only forms the workflows use). */
export function evaluateExpression(text, context) {
  return text.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, expression) => {
    const comparison = expression.match(/^(github\.[\w.]+)\s*==\s*'([^']*)'$/);
    if (comparison) return String(lookup(comparison[1], context) === comparison[2]);
    const alternatives = expression.split('||').map((part) => part.trim());
    for (const alternative of alternatives) {
      const value = lookup(alternative, context);
      if (value !== undefined && value !== null && value !== '') return String(value);
    }
    return '';
  });
}

/** `{group, cancelInProgress}` of the run this event would start, or null when the workflow has no concurrency block. */
export function concurrencyOf(workflow, event) {
  if (!workflow.concurrency) return null;
  const context = contextOf(event);
  const group = evaluateExpression(String(workflow.concurrency.group ?? ''), context);
  const cancel = workflow.concurrency['cancel-in-progress'];
  return { group, cancelInProgress: typeof cancel === 'string' ? evaluateExpression(cancel, context) === 'true' : cancel === true };
}
