// The acceptance file of Proof-of-Done, version 1: `.chatmcp/acceptance.yml` (docs/PROOF-ACCEPTANCE.md, plan task pod-20).
//
//   parseAcceptance(bytes | text)   the strict reader: the YAML subset of ./yaml-subset.mjs, then the schema; the result is normalised
//                                   (defaults filled in, paths in one spelling). Anything wrong throws AcceptanceError with the line.
//   compareAcceptance(base, now)    what an edit changed, by criterion id; null when the bytes are the same.
//   resolveAcceptance({baseline, current, trustStore})
//                                   the criteria of a task: ALWAYS the baseline's (the file as it was when the task started, given by
//                                   the caller as bytes); an edit made since is only reported (`acceptance_edited`); a check is runnable
//                                   only when the sha256 of the BASELINE bytes is trusted by the owner (./trust-store.mjs).
//   proposeAcceptance(workspace)    a proposed file built from discoverProjectChecks (what `verify init` will print); writes nothing.
//
// Commands in a workspace file are untrusted: the agent can write that file. Auto-running them would be remote execution by anyone who
// can get text into the workspace, so the two rules above (baseline only, trust by hash) are not options. This module runs nothing;
// the check runner is plan task pod-21.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { discoverProjectChecks } from '../project-check-discovery.mjs';
import { YAML_DEFAULT_MAX_DEPTH, YamlSubsetError, parseYamlSubset } from './yaml-subset.mjs';

export const ACCEPTANCE_FILE = '.chatmcp/acceptance.yml';
export const ACCEPTANCE_MAX_BYTES = 64 * 1024;
export const ACCEPTANCE_LIMITS = Object.freeze({
  criteria: 100, checksPerCriterion: 20, inspect: 50, protected: 200, setup: 50,
  text: 2000, note: 4000, run: 4000, path: 400,
  timeout: { min: 1, max: 3600, default: 600 }, repeat: { min: 1, max: 20, default: 1 }, exit: { min: 0, max: 255, default: 0 },
});
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// A character that shows differently from what it is (Trojan Source): the owner approves a file by its sha256 after READING it, so the
// text read must be the text that runs. Control characters but TAB and LF, format characters (bidi controls, zero-width, tag
// characters), every default-ignorable code point, line and paragraph separators, noncharacters and lone surrogates.
const HIDDEN = /(?![\t\n])\p{Cc}|\p{Cf}|\p{Default_Ignorable_Code_Point}|\p{Zl}|\p{Zp}|\p{Noncharacter_Code_Point}|\p{Cs}/u;
// Windows names that are not plain folders: devices (with or without an extension) and names ending in a dot or a space.
const DEVICE = /^(?:con|prn|aux|nul|com[0-9\p{No}]|lpt[0-9\p{No}]|conin\$|conout\$)(?:\..*)?$/iu;

const REASONS = {
  empty_file: 'the file has no content',
  not_a_mapping: 'the file must be a mapping (version, criteria, ...)',
  unknown_key: 'unknown key',
  missing_version: '`version: 1` is required',
  unsupported_version: 'only `version: 1` is supported',
  missing_key: 'a required key is missing',
  bad_type: 'wrong type',
  bad_value: 'value out of range',
  bad_id: 'an id is lower-case letters, digits, ., _ and -, at most 64, starting with a letter or digit',
  duplicate_id: 'two criteria have the same id',
  empty_criteria: '`criteria` needs at least one criterion',
  check_and_manual: 'a criterion has either `checks` or `manual`, not both',
  no_check_or_manual: 'a criterion needs `checks` or `manual`',
  empty_checks: '`checks` needs at least one check',
  empty_manual: '`manual` needs `inspect` or `note`',
  cwd_outside_workspace: '`cwd` must be a relative folder inside the workspace',
  reserved_name: '`cwd` names a Windows device or ends in a dot or a space',
  hidden_character: 'a hidden or control character is not allowed (the text read must be the text that runs)',
  ambiguous_comment: 'a ` #` cut a command that holds a quote; quote the whole command or use a block scalar',
  path_outside_workspace: 'a path must be relative and inside the workspace',
  too_many: 'too many entries',
};

export class AcceptanceError extends Error {
  constructor(line, reason, detail = '') {
    super(`${ACCEPTANCE_FILE} line ${line}: ${REASONS[reason] ?? reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'AcceptanceError';
    this.code = 'acceptance_invalid';
    this.line = line;
    this.reason = reason;
    this.detail = detail;
  }
}

const fail = (line, reason, detail) => { throw new AcceptanceError(line, reason, detail); };
const bytesOf = (input) => (typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input.buffer, input.byteOffset, input.byteLength));

/** sha256 hex of the exact bytes (text is hashed as its UTF-8 bytes). */
export function acceptanceSha256(input) {
  return createHash('sha256').update(bytesOf(input)).digest('hex');
}

/** The entries of a mapping node by key, refusing keys outside `allowed`. */
function fields(node, allowed) {
  const result = new Map();
  for (const entry of node.entries) {
    if (!allowed.includes(entry.key)) fail(entry.line, 'unknown_key', entry.key);
    result.set(entry.key, entry);
  }
  return result;
}

const isNull = (node) => node.kind === 'scalar' && node.value === null;

function mapping(entry) {
  if (entry.value.kind !== 'map') fail(entry.value.line, 'bad_type', `\`${entry.key}\` must be a mapping`);
  return entry.value;
}

function sequence(entry, limit) {
  if (entry.value.kind !== 'seq') fail(entry.value.line, 'bad_type', `\`${entry.key}\` must be a list`);
  if (entry.value.items.length > limit) fail(entry.value.items[limit].line, 'too_many', `at most ${limit} in \`${entry.key}\``);
  return entry.value.items;
}

function string(node, what, limit) {
  if (node.kind !== 'scalar' || typeof node.value !== 'string') fail(node.line, 'bad_type', `${what} must be text`);
  if (!node.value.trim() || node.value.length > limit) fail(node.line, 'bad_value', `${what} must be 1 to ${limit} characters`);
  const hidden = HIDDEN.exec(node.value);
  if (hidden) fail(node.line, 'hidden_character', `U+${hidden[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} in ${what}`);
  // A line break only where the file shows one: in a block scalar (a quoted "\n" would hide the second line).
  if (node.style !== 'block' && node.value.includes('\n')) fail(node.line, 'hidden_character', `a line break in ${what}`);
  return node.value;
}

/** A command (`run`, a `setup` step): also refused when a ` #` comment cut a plain value that holds a quote. */
function command(node, what) {
  const value = string(node, what, ACCEPTANCE_LIMITS.run);
  if (node.style === 'plain' && node.comment === true && /["'`]/.test(value)) fail(node.line, 'ambiguous_comment', value.slice(0, 60));
  return value;
}

function integer(node, what, { min, max }) {
  if (node.kind !== 'scalar' || typeof node.value !== 'number') fail(node.line, 'bad_type', `${what} must be a whole number`);
  if (node.value < min || node.value > max) fail(node.line, 'bad_value', `${what} must be ${min} to ${max}`);
  return node.value;
}

/**
 * A relative path (or glob) inside the workspace, in one spelling: `/` separators, no `.` segments, no trailing `/`. Refused: absolute
 * paths (`/x`, `\x`, `C:\x`), drive-relative (`D:x`) and UNC (`\\server`) paths, `~`, any `..` segment and any `:` (Windows streams).
 */
function relativePath(node, what, reason, { folder = false } = {}) {
  const value = string(node, what, ACCEPTANCE_LIMITS.path);
  if (/^[\\/~]/.test(value) || value.includes(':') || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) fail(node.line, reason, value);
  const parts = value.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (parts.includes('..')) fail(node.line, reason, value);
  if (folder && parts.some((part) => DEVICE.test(part) || /[. ]$/.test(part))) fail(node.line, 'reserved_name', value);
  return parts.join('/') || '.';
}

function readCheck(node) {
  if (node.kind !== 'map') fail(node.line, 'bad_type', 'a check must be a mapping');
  const f = fields(node, ['run', 'cwd', 'timeout', 'expect', 'repeat']);
  if (!f.has('run')) fail(node.line, 'missing_key', 'run');
  const check = {
    run: command(f.get('run').value, '`run`'),
    cwd: f.has('cwd') ? relativePath(f.get('cwd').value, '`cwd`', 'cwd_outside_workspace', { folder: true }) : '.',
    timeout: f.has('timeout') ? integer(f.get('timeout').value, '`timeout`', ACCEPTANCE_LIMITS.timeout) : ACCEPTANCE_LIMITS.timeout.default,
    expect: { exit: ACCEPTANCE_LIMITS.exit.default },
    repeat: f.has('repeat') ? integer(f.get('repeat').value, '`repeat`', ACCEPTANCE_LIMITS.repeat) : ACCEPTANCE_LIMITS.repeat.default,
  };
  if (f.has('expect')) {
    const expect = fields(mapping(f.get('expect')), ['exit']);
    if (expect.has('exit')) check.expect.exit = integer(expect.get('exit').value, '`exit`', ACCEPTANCE_LIMITS.exit);
  }
  return check;
}

function readManual(entry) {
  if (isNull(entry.value)) fail(entry.line, 'empty_manual');
  const node = mapping(entry);
  const f = fields(node, ['inspect', 'note']);
  if (!f.has('inspect') && !f.has('note')) fail(node.line, 'empty_manual');
  return {
    inspect: f.has('inspect') ? sequence(f.get('inspect'), ACCEPTANCE_LIMITS.inspect).map((item) => relativePath(item, 'an `inspect` path', 'path_outside_workspace')) : [],
    note: f.has('note') ? string(f.get('note').value, '`note`', ACCEPTANCE_LIMITS.note) : null,
  };
}

function readCriterion(node, ids) {
  if (node.kind !== 'map') fail(node.line, 'bad_type', 'a criterion must be a mapping');
  const f = fields(node, ['id', 'text', 'checks', 'manual']);
  if (!f.has('id')) fail(node.line, 'missing_key', 'id');
  if (!f.has('text')) fail(node.line, 'missing_key', 'text');
  const idNode = f.get('id').value;
  if (idNode.kind !== 'scalar' || typeof idNode.value !== 'string' || !ID.test(idNode.value)) fail(idNode.line, 'bad_id', String(idNode.value ?? ''));
  const id = idNode.value;
  if (ids.has(id)) fail(idNode.line, 'duplicate_id', id);
  ids.add(id);
  const text = string(f.get('text').value, '`text`', ACCEPTANCE_LIMITS.text);
  if (f.has('checks') && f.has('manual')) fail(node.line, 'check_and_manual', id);
  if (f.has('checks')) {
    const entry = f.get('checks');
    if (isNull(entry.value)) fail(entry.line, 'empty_checks', id);
    return { id, text, checks: sequence(entry, ACCEPTANCE_LIMITS.checksPerCriterion).map(readCheck) };
  }
  if (f.has('manual')) return { id, text, manual: readManual(f.get('manual')) };
  return fail(node.line, 'no_check_or_manual', id);
}

/**
 * Reads an acceptance file (a string or its bytes) and returns the normalised object
 *   {version: 1, criteria: [{id, text, checks: [{run, cwd, timeout, expect: {exit}, repeat}]} | {id, text, manual: {inspect, note}}],
 *    protected: [glob], reproduce: {setup: [command]}}.
 * Throws AcceptanceError {code: 'acceptance_invalid', line, reason} for the first problem found.
 */
export function parseAcceptance(input) {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw new TypeError('parseAcceptance needs the text or the bytes of the file.');
  let root;
  try { root = parseYamlSubset(input, { maxBytes: ACCEPTANCE_MAX_BYTES, maxDepth: YAML_DEFAULT_MAX_DEPTH }); }
  catch (error) {
    if (error instanceof YamlSubsetError) throw new AcceptanceError(error.line, error.reason, error.detail);
    throw error;
  }
  if (!root) fail(1, 'empty_file');
  if (root.kind !== 'map') fail(root.line, 'not_a_mapping');
  const f = fields(root, ['version', 'criteria', 'protected', 'reproduce']);
  if (!f.has('version')) fail(root.line, 'missing_version');
  const version = f.get('version').value;
  if (version.kind !== 'scalar' || version.value !== 1 || version.style !== 'plain') fail(f.get('version').line, 'unsupported_version', String(version.value ?? ''));
  if (!f.has('criteria')) fail(root.line, 'missing_key', 'criteria');
  const criteriaEntry = f.get('criteria');
  if (isNull(criteriaEntry.value)) fail(criteriaEntry.line, 'empty_criteria');
  const ids = new Set();
  const criteria = sequence(criteriaEntry, ACCEPTANCE_LIMITS.criteria).map((node) => readCriterion(node, ids));
  let protectedGlobs = [];
  if (f.has('protected') && !isNull(f.get('protected').value)) {
    protectedGlobs = sequence(f.get('protected'), ACCEPTANCE_LIMITS.protected).map((item) => relativePath(item, 'a `protected` glob', 'path_outside_workspace'));
  }
  const reproduce = { setup: [] };
  if (f.has('reproduce')) {
    const r = fields(mapping(f.get('reproduce')), ['setup']);
    if (r.has('setup')) reproduce.setup = sequence(r.get('setup'), ACCEPTANCE_LIMITS.setup).map((item) => command(item, 'a `setup` command'));
  }
  return { version: 1, criteria, protected: protectedGlobs, reproduce };
}

const EMPTY = Object.freeze({ criteria: [], protected: [], reproduce: { setup: [] } });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What changed between the baseline and the current file, both bytes, text or null (no file):
 *   null when the bytes are identical (or both are absent), else
 *   {code: 'acceptance_edited', deleted, unparseable: null | {line, reason}, removed, added, changed, sections}
 * with criterion ids (removed and changed in baseline order, added in current order) and the other parts that changed
 * ('protected', 'reproduce', 'criteria_order'). A baseline that does not read throws AcceptanceError.
 */
export function compareAcceptance(baseline, current) {
  const absent = (input) => input === null || input === undefined;
  if (absent(baseline) && absent(current)) return null;
  if (!absent(baseline) && !absent(current) && bytesOf(baseline).equals(bytesOf(current))) return null;
  const before = absent(baseline) ? EMPTY : parseAcceptance(baseline);
  let after = EMPTY, unparseable = null;
  if (!absent(current)) {
    try { after = parseAcceptance(current); } catch (error) {
      if (!(error instanceof AcceptanceError)) throw error;
      unparseable = { line: error.line, reason: error.reason };
    }
  }
  const edit = { code: 'acceptance_edited', deleted: absent(current), unparseable, removed: [], added: [], changed: [], sections: [] };
  if (unparseable) {
    edit.removed = before.criteria.map((criterion) => criterion.id);
    return edit;
  }
  const byId = (list) => new Map(list.map((criterion) => [criterion.id, criterion]));
  const was = byId(before.criteria), now = byId(after.criteria);
  for (const [id, criterion] of was) {
    if (!now.has(id)) edit.removed.push(id);
    else if (!same(criterion, now.get(id))) edit.changed.push(id);
  }
  for (const id of now.keys()) if (!was.has(id)) edit.added.push(id);
  if (!same(before.protected, after.protected)) edit.sections.push('protected');
  if (!same(before.reproduce, after.reproduce)) edit.sections.push('reproduce');
  const order = (list, other) => list.map((criterion) => criterion.id).filter((id) => other.has(id));
  if (!same(order(before.criteria, now), order(after.criteria, was))) edit.sections.push('criteria_order');
  return edit;
}

/**
 * The criteria of a task and what may run.
 *   baseline     the bytes (or text) of `.chatmcp/acceptance.yml` when the task started - from the task's baseline tree or git blob - or
 *                null when there was no such file. It is the ONLY source of criteria: a later edit cannot drop or weaken one.
 *   current      the bytes (or text) now, or null when the file is gone; only compared, never used as a source.
 *   trustStore   an object with isTrusted(sha256) (./trust-store.mjs).
 * Returns {criteria, protected, reproduce, baselineSha256, currentSha256, trusted, blocked, runnable, edit}:
 *   runnable     [{criterionId, index, run, cwd, timeout, expect, repeat}] - every check of the baseline when its sha256 is trusted, else [];
 *   blocked      null, 'acceptance_untrusted' or 'no_baseline';
 *   edit         compareAcceptance(baseline, current).
 * A baseline that does not read throws AcceptanceError: it is the owner's file to fix, never read as "no criteria".
 */
export async function resolveAcceptance({ baseline = null, current = null, trustStore } = {}) {
  if (!trustStore || typeof trustStore.isTrusted !== 'function') throw new TypeError('resolveAcceptance needs a trust store (createTrustStore).');
  const parsed = baseline === null || baseline === undefined ? null : parseAcceptance(baseline);
  const edit = compareAcceptance(baseline, current);
  const baselineSha256 = parsed ? acceptanceSha256(baseline) : null;
  const currentSha256 = current === null || current === undefined ? null : acceptanceSha256(current);
  if (!parsed) {
    return { criteria: [], protected: [], reproduce: { setup: [] }, baselineSha256, currentSha256, trusted: false, blocked: 'no_baseline', runnable: [], edit };
  }
  const trusted = (await trustStore.isTrusted(baselineSha256)) === true;
  const runnable = trusted
    ? parsed.criteria.flatMap((criterion) => (criterion.checks ?? []).map((check, index) => ({ criterionId: criterion.id, index, ...structuredClone(check) })))
    : [];
  return {
    criteria: parsed.criteria, protected: parsed.protected, reproduce: parsed.reproduce,
    baselineSha256, currentSha256, trusted, blocked: trusted ? null : 'acceptance_untrusted', runnable, edit,
  };
}

/** A criterion id made from a command: `npm run lint` -> `npm-run-lint`, unique within `taken`. */
function idFor(command, taken) {
  const base = command.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'check';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * A proposed acceptance file for the project at `workspace` (absolute), built from discoverProjectChecks: one criterion per discovered
 * check, or one manual criterion to fill in when nothing usable was found, and `.chatmcp/**` protected. A check whose criterion the
 * reader would refuse is left out and listed in `skipped` ({command, from, reason}). Writes nothing and runs nothing.
 * Returns {file, text, sha256, acceptance, suggested, skipped}.
 */
export async function proposeAcceptance(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new TypeError('proposeAcceptance needs the absolute workspace folder.');
  const { suggested } = await discoverProjectChecks(workspace);
  const q = (text) => JSON.stringify(text);
  const lines = [
    `# Proposed ${ACCEPTANCE_FILE}, built by DatGold from the project's own files (nothing was run or written).`,
    '# Review it and save it: no check in it runs before the owner trusts the sha256 of the saved file.',
    'version: 1',
    'criteria:',
  ];
  const taken = new Set();
  const skipped = [];
  let kept = 0;
  for (const check of suggested) {
    const criterion = [`    text: ${q(`The check \`${check.command}\` passes (found in ${check.from}).`)}`, '    checks:', `      - run: ${q(check.command)}`];
    // The reader decides: a criterion it would refuse (a file name with a hidden character, say) is reported, not written.
    try { parseAcceptance(['version: 1', 'criteria:', '  - id: probe', ...criterion, ''].join('\n')); } catch (error) {
      if (!(error instanceof AcceptanceError)) throw error;
      skipped.push({ command: check.command, from: check.from, reason: error.reason });
      continue;
    }
    lines.push(`  - id: ${idFor(check.command, taken)}`, ...criterion);
    kept++;
  }
  if (!kept) {
    lines.push('  - id: done', `    text: ${q('Describe what done means for this project.')}`, '    manual:',
      `      note: ${q('No test, build or lint command was found; replace this with the checks of the project.')}`);
  }
  lines.push('protected:', `  - ${q('.chatmcp/**')}`, '');
  const text = lines.join('\n');
  return { file: ACCEPTANCE_FILE, text, sha256: acceptanceSha256(text), acceptance: parseAcceptance(text), suggested, skipped };
}
