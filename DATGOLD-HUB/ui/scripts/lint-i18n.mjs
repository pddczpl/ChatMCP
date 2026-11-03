// The words of the interface live in lib/i18n.ts, lib/i18n-agents.ts and lib/i18n-models.ts, in both languages, and a component asks for them with t('key').
// This lint reads every source file of src/ with the TypeScript parser (no type check, so it is fast) and flags the words that a component writes into
// itself instead, because a person would see them in one language only:
//
//   jsx-text            text between tags that has letters, and a string written in braces among the children        <p>Saved</p>   {ok ? 'Done' : 'Failed'}
//   jsx-attribute       a literal in title, aria-label, placeholder, alt, label (and aria-description and the like)   <input placeholder="Search" />
//   call-argument       the message of showToast, confirm, alert, prompt and of new Error(...)                        showToast('Saved')
//   lang-ternary        a choice of words by the language                                                              lang === 'vi' ? 'Đã lưu' : 'Saved'
//   label-map           an object whose values are Vietnamese words or an English sentence                             { idle: 'Đang rảnh' }
//   vietnamese-literal  any other string with a Vietnamese letter (a helper that takes both languages is caught here)  copy('Nhập ...', 'Type ...')
//
// What exists today is not fixed by this lint: it is FROZEN in i18n-baseline.json (one entry per violation: file, rule and the hash of the string, so a
// line that moves is still the same entry). A violation that is not in the baseline fails, and so does a baseline entry whose string is gone (it has to be
// removed: the baseline only shrinks). A deliberate exception (a brand name, a key legend, a code token) goes in i18n-allow.json with the reason.
// The dictionaries themselves are not read: they are the one place where words are written.
//
//   node scripts/lint-i18n.mjs                    check the project (exit 1 on a new violation, a stale entry or a stale exception)
//   node scripts/lint-i18n.mjs --report           the numbers per rule
//   node scripts/lint-i18n.mjs --self-test        seed one violation of each shape in fixtures and check that every one is caught
//   node scripts/lint-i18n.mjs --init-baseline    write the baseline once, when there is none (refused if the file exists)
//   node scripts/lint-i18n.mjs --shrink-baseline  drop the entries whose string is gone (refused if there is a new violation: it never takes one in)
//   --root <folder>                               the ui folder to read (default: the one this script is in)
//
// tests/i18n-lint.test.mjs runs it with `npm run test:unit`, so a hard-coded string in a component fails the unit tests.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const RULES = ['jsx-text', 'jsx-attribute', 'call-argument', 'lang-ternary', 'label-map', 'vietnamese-literal'];
export const DICTIONARY_FILES = ['src/lib/i18n.ts', 'src/lib/i18n-agents.ts', 'src/lib/i18n-models.ts'];

const BASELINE_FILE = 'i18n-baseline.json';
const ALLOW_FILE = 'i18n-allow.json';
const here = path.dirname(fileURLToPath(import.meta.url));

const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const LETTER = /\p{L}/u;
const ENTITY = /&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9a-fA-F]+);/g;
const LOCALE_TAG = /^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/;
/** The attributes whose value a person reads or hears. */
const TEXT_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext']);
/** Calls whose first argument is a message for a person. */
const MESSAGE_CALLS = new Set(['showToast', 'confirm', 'alert', 'prompt']);
const ERROR_CALLS = /^(?:Type|Range|Syntax|Eval|URI)?Error$/;
const LANGUAGE_NAMES = /^(?:lang|language|locale|uiLang|appLang|currentLang)$/;
const LANGUAGE_FLAGS = /^(?:isVi|isEn|isVietnamese|isEnglish|vi|en)$/;
const LANGUAGE_VALUES = /^(?:vi|en)(?:[-_][A-Za-z]{2})?$/i;
const SK = ts.SyntaxKind;

const normalize = (text) => text.replace(/\s+/g, ' ').trim();
const hashOf = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
const keyOf = (item) => `${item.file}|${item.rule}|${item.hash}`;
const byKey = (a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);

/** Where a violation is told apart from another: the file, the rule and the hash of the string (not the line, which moves). */
export const fingerprint = keyOf;

/** An English sentence: a capital letter, then words, with at least two lower-case words side by side. A class list, an id or a one-word label never is. */
function looksLikeSentence(text) {
  const clean = text.trim();
  return /^[A-Z][a-z]+(?:[ ,.'’-]+[A-Za-z]+){1,}/.test(clean) && /[a-z]{2,} [a-z]{2,}/.test(clean);
}

const unwrap = (node) => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
};
const nameOf = (node) => (ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : '');

/** Does this condition ask which language the screen is in? (lang === 'vi', props.lang !== 'en', isVi, !isEn) */
function isLanguageTest(condition) {
  const node = unwrap(condition);
  if (ts.isIdentifier(node)) return LANGUAGE_FLAGS.test(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === SK.ExclamationToken) return isLanguageTest(node.operand);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === SK.EqualsEqualsEqualsToken || operator === SK.EqualsEqualsToken || operator === SK.ExclamationEqualsEqualsToken || operator === SK.ExclamationEqualsToken) {
      const named = (side) => LANGUAGE_NAMES.test(nameOf(unwrap(side)));
      const value = (side) => ts.isStringLiteralLike(unwrap(side)) && LANGUAGE_VALUES.test(unwrap(side).text);
      return (named(node.left) && value(node.right)) || (named(node.right) && value(node.left));
    }
  }
  return false;
}

/**
 * The strings an expression can show as they are: a literal, the written parts of a template, both branches of a condition, the sides of + ?? || &&.
 * It does not look into calls (t('key') is the way to ask for words), and it stops at a language ternary, which has its own rule.
 */
function stringLeaves(expression) {
  const node = unwrap(expression);
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [{ node, text: node.text }];
  if (ts.isTemplateExpression(node)) return [{ node, text: node.head.text + node.templateSpans.map((span) => `{}${span.literal.text}`).join('') }];
  if (ts.isConditionalExpression(node)) return isLanguageTest(node.condition) ? [] : [...stringLeaves(node.whenTrue), ...stringLeaves(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === SK.PlusToken || operator === SK.QuestionQuestionToken || operator === SK.BarBarToken || operator === SK.AmpersandAmpersandToken) return [...stringLeaves(node.left), ...stringLeaves(node.right)];
  }
  return [];
}

/** Every violation of one source text. `file` is only a name (it decides TS or TSX and is copied into the violations). */
export function findViolations(text, file = 'fixture.tsx') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = [];
  /** The string nodes a rule has reported already, so that a later rule does not report them again. */
  const claimed = new Set();

  const add = (rule, anchor, words, nodes = []) => {
    const { line, character } = source.getLineAndCharacterOfPosition(anchor.getStart(source));
    const shown = normalize(words);
    found.push({ rule, file, line: line + 1, column: character + 1, text: shown, hash: hashOf(shown) });
    for (const node of nodes) claimed.add(node);
  };
  const addLeaves = (rule, leaves, kept) => {
    for (const leaf of leaves) if (!claimed.has(leaf.node) && kept(leaf.text)) add(rule, leaf.node, leaf.text, [leaf.node]);
  };
  const hasLetters = (words) => LETTER.test(words);

  const visit = (node) => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;

    if (node.kind === SK.JsxText) {
      if (!node.containsOnlyTriviaWhiteSpaces && hasLetters(node.text.replace(ENTITY, ' '))) add('jsx-text', node, node.text);
    } else if (ts.isJsxExpression(node)) {
      if (node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) addLeaves('jsx-text', stringLeaves(node.expression), hasLetters);
    } else if (ts.isJsxAttribute(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(source);
      const value = node.initializer;
      if (TEXT_ATTRIBUTES.has(name) && value) {
        const leaves = ts.isStringLiteral(value) ? [{ node: value, text: value.text }] : ts.isJsxExpression(value) && value.expression ? stringLeaves(value.expression) : [];
        addLeaves('jsx-attribute', leaves, hasLetters);
      }
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = nameOf(unwrap(node.expression));
      const isMessage = ts.isNewExpression(node) ? /Error$/.test(callee) : MESSAGE_CALLS.has(callee) || ERROR_CALLS.test(callee);
      if (isMessage && node.arguments?.length) addLeaves('call-argument', stringLeaves(node.arguments[0]), hasLetters);
    } else if (ts.isConditionalExpression(node)) {
      if (isLanguageTest(node.condition)) {
        const leaves = [...stringLeaves(node.whenTrue), ...stringLeaves(node.whenFalse)];
        if (leaves.some((leaf) => hasLetters(leaf.text) && !LOCALE_TAG.test(leaf.text))) add('lang-ternary', node, node.getText(source), leaves.map((leaf) => leaf.node));
      }
    } else if (ts.isPropertyAssignment(node)) {
      addLeaves('label-map', stringLeaves(node.initializer), (words) => VIETNAMESE.test(words) || looksLikeSentence(words));
    } else if (ts.isStringLiteralLike(node)) {
      if (!claimed.has(node) && VIETNAMESE.test(node.text)) add('vietnamese-literal', node, node.text, [node]);
    } else if (ts.isTemplateExpression(node)) {
      const [leaf] = stringLeaves(node);
      if (!claimed.has(node) && VIETNAMESE.test(leaf.text)) add('vietnamese-literal', node, leaf.text, [node]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// ---- the project: files, allowlist, baseline ------------------------------------------------------------------------------------------------------

function listSources(root) {
  const out = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(path.join(root, 'src'))) walk(path.join(root, 'src'));
  return out;
}

function readJson(root, name, what) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw new Error(`the ${what} (${name}) is not valid JSON: ${error.message}`); }
}

function readBaseline(root) {
  const data = readJson(root, BASELINE_FILE, 'baseline');
  if (data === null) return { entries: [] };
  const valid = (entry) => entry && typeof entry.file === 'string' && RULES.includes(entry.rule) && /^[0-9a-f]{16}$/.test(entry.hash ?? '');
  if (data.version !== 1 || !Array.isArray(data.entries) || !data.entries.every(valid)) throw new Error(`the baseline (${BASELINE_FILE}) must be {"version": 1, "entries": [{"file", "rule", "hash"}, ...]}`);
  return data;
}

function readAllowlist(root) {
  const data = readJson(root, ALLOW_FILE, 'allowlist');
  if (data === null) return { entries: [] };
  if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error(`the allowlist (${ALLOW_FILE}) must be {"version": 1, "entries": [{"text", "reason", "file"?, "rule"?}, ...]}`);
  for (const entry of data.entries) {
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) throw new Error(`an allowlist entry (${ALLOW_FILE}) has no text`);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 8) throw new Error(`the allowlist entry ${JSON.stringify(entry.text)} needs a reason of at least 8 characters: why this string may stay in the code`);
    if (entry.rule !== undefined && !RULES.includes(entry.rule)) throw new Error(`the allowlist entry ${JSON.stringify(entry.text)} names a rule that does not exist: ${entry.rule}`);
  }
  return data;
}

const allows = (entry, violation) => normalize(entry.text) === violation.text && (entry.file === undefined || entry.file === violation.file) && (entry.rule === undefined || entry.rule === violation.rule);

/**
 * Read the project and sort what is found: allowlisted (deliberate), baselined (frozen debt) and fresh (new: these fail). `stale` are baseline entries whose string
 * is gone and `staleAllow` allowlist entries that match nothing. The baseline is counted, so the same string once more than it holds is fresh.
 */
export function lintProject(root = path.resolve(here, '..')) {
  const baseline = readBaseline(root);
  const allow = readAllowlist(root);
  const sources = listSources(root);
  const skipped = sources.filter((file) => DICTIONARY_FILES.includes(file)).sort();
  const files = sources.filter((file) => !DICTIONARY_FILES.includes(file));
  const found = files.flatMap((file) => findViolations(fs.readFileSync(path.join(root, file), 'utf8'), file));

  const used = new Set();
  const allowlisted = [];
  const remaining = [];
  for (const violation of found) {
    const index = allow.entries.findIndex((entry) => allows(entry, violation));
    if (index >= 0) { used.add(index); allowlisted.push(violation); } else remaining.push(violation);
  }
  const staleAllow = allow.entries.filter((_, index) => !used.has(index));

  const budget = new Map();
  for (const entry of baseline.entries) budget.set(keyOf(entry), { entry, left: (budget.get(keyOf(entry))?.left ?? 0) + 1 });
  const baselined = [];
  const fresh = [];
  for (const violation of remaining) {
    const slot = budget.get(keyOf(violation));
    if (slot && slot.left > 0) { slot.left -= 1; baselined.push(violation); } else fresh.push(violation);
  }
  const stale = [...budget.values()].flatMap(({ entry, left }) => Array.from({ length: left }, () => ({ file: entry.file, rule: entry.rule, hash: entry.hash }))).sort(byKey);
  return { files: files.length, skipped, found, allowlisted, baselined, fresh, stale, staleAllow };
}

function writeBaseline(root, entries) {
  const lines = entries.map((entry) => `    ${JSON.stringify({ file: entry.file, rule: entry.rule, hash: entry.hash })}`);
  const body = lines.length ? `[\n${lines.join(',\n')}\n  ]` : '[]';
  fs.writeFileSync(path.join(root, BASELINE_FILE), `{\n  "version": 1,\n  "entries": ${body}\n}\n`);
}

/** Freeze what the project has today. Only once: a second call would be a way to take new violations in. */
export function initBaseline(root = path.resolve(here, '..')) {
  if (fs.existsSync(path.join(root, BASELINE_FILE))) throw new Error(`the baseline (${BASELINE_FILE}) already exists: it is frozen, and it only shrinks (--shrink-baseline)`);
  const { fresh } = lintProject(root);
  writeBaseline(root, fresh.map((violation) => ({ file: violation.file, rule: violation.rule, hash: violation.hash })).sort(byKey));
}

/** Drop the entries whose string is gone. Refused while there is a new violation, so that this can never be used to take one in. */
export function shrinkBaseline(root = path.resolve(here, '..')) {
  const result = lintProject(root);
  if (result.fresh.length) throw new Error(`${result.fresh.length} new violation(s): fix them (t() and the dictionaries) before the baseline is shrunk; it never takes a violation in`);
  writeBaseline(root, result.baselined.map((violation) => ({ file: violation.file, rule: violation.rule, hash: violation.hash })).sort(byKey));
}

// ---- the self-test --------------------------------------------------------------------------------------------------------------------------------

/** Each seeded fixture holds exactly one violation of its rule; the clean ones hold the look-alikes that are not violations. */
const FIXTURES = [
  { name: 'text between tags', rule: 'jsx-text', seeded: true, source: 'export const A = () => <p>Nothing to show here</p>;' },
  { name: 'a literal in an attribute', rule: 'jsx-attribute', seeded: true, source: 'export const A = () => <button title="Close the panel" />;' },
  { name: 'the message of a toast', rule: 'call-argument', seeded: true, source: "showToast('Settings were saved');" },
  { name: 'words chosen by the language', rule: 'lang-ternary', seeded: true, source: "export const text = lang === 'vi' ? 'Đã lưu' : 'Saved';" },
  { name: 'an object of Vietnamese labels', rule: 'label-map', seeded: true, source: "export const LABELS = { idle: 'Đang rảnh' };" },
  { name: 'a Vietnamese string in a helper', rule: 'vietnamese-literal', seeded: true, source: "export const message = copy('Không tìm thấy', 'Not found');" },
  { name: 'words that are asked for', rule: null, seeded: false, source: "export const A = () => <p title={t('close')}>{t('saved')}</p>;" },
  { name: 'comments, types, class lists, locale tags', rule: null, seeded: false, source: "// Đã xong\ntype Mode = 'Không' | 'Có';\nexport const B = () => <p className=\"flex gap-2\" data-testid=\"a b\">·</p>;\nexport const tag = lang === 'en' ? 'en-US' : 'vi-VN';" },
];

/** Run a detector (the lint's own by default) over the fixtures. A detector that misses a seeded shape, or flags a clean fixture, does not pass. */
export function selfTest(find = findViolations) {
  const cases = FIXTURES.map((fixture) => {
    const rules = find(fixture.source, 'fixture.tsx').map((violation) => violation.rule);
    const ok = fixture.seeded ? rules.length === 1 && rules[0] === fixture.rule : rules.length === 0;
    return { name: fixture.name, rule: fixture.rule, seeded: fixture.seeded, ok, rules };
  });
  return { ok: cases.every((item) => item.ok), cases };
}

// ---- the command ----------------------------------------------------------------------------------------------------------------------------------

/** What --self-test prints, line by line, and the exit code it ends with: 1 as soon as one fixture is wrong. */
export function selfTestReport(find = findViolations) {
  const result = selfTest(find);
  const lines = result.cases.map((item) => {
    const label = item.ok ? (item.seeded ? 'caught ' : 'clean  ') : 'WRONG  ';
    return `${label} ${String(item.rule ?? '-').padEnd(18)} ${item.name}${item.ok ? '' : `  (found: ${item.rules.join(', ') || 'nothing'})`}`;
  });
  lines.push(result.ok ? 'self-test: every seeded shape is caught and the clean fixtures stay quiet' : 'self-test: FAILED');
  return { code: result.ok ? 0 : 1, lines };
}

function main(args) {
  const rootAt = args.indexOf('--root');
  const root = rootAt >= 0 ? path.resolve(args[rootAt + 1]) : path.resolve(here, '..');
  const say = (line = '') => console.log(line);
  const where = (violation) => `${violation.file}:${violation.line}:${violation.column}  ${violation.rule}  ${JSON.stringify(violation.text)}`;

  if (args.includes('--self-test')) {
    const report = selfTestReport();
    for (const line of report.lines) say(line);
    process.exitCode = report.code;
    return;
  }
  try {
    if (args.includes('--init-baseline')) { initBaseline(root); say(`wrote ${BASELINE_FILE}`); return; }
    if (args.includes('--shrink-baseline')) { shrinkBaseline(root); say(`shrank ${BASELINE_FILE}`); return; }
    const result = lintProject(root);
    if (args.includes('--report')) {
      for (const rule of RULES) {
        const count = (list) => list.filter((violation) => violation.rule === rule).length;
        say(`${rule.padEnd(19)} found ${String(count(result.found)).padStart(4)}   allowlisted ${String(count(result.allowlisted)).padStart(3)}   baselined ${String(count(result.baselined)).padStart(4)}   new ${String(count(result.fresh)).padStart(3)}`);
      }
    }
    if (result.fresh.length) {
      say(`New hard-coded strings (${result.fresh.length}):`);
      for (const violation of result.fresh) say(`  ${where(violation)}`);
      say('Put the words in lib/i18n.ts (or lib/i18n-agents.ts) in both languages and ask for them with t(\'key\'). A deliberate exception (a brand name, a code token) goes in');
      say(`${ALLOW_FILE} with its reason. The baseline (${BASELINE_FILE}) is frozen: it does not take new entries.`);
    }
    if (result.stale.length) {
      say(`Baseline entries whose string is gone (${result.stale.length}): run node scripts/lint-i18n.mjs --shrink-baseline`);
      for (const entry of result.stale) say(`  ${entry.file}  ${entry.rule}  ${entry.hash}`);
    }
    if (result.staleAllow.length) {
      say(`Allowlist entries that match nothing (${result.staleAllow.length}): remove them from ${ALLOW_FILE}`);
      for (const entry of result.staleAllow) say(`  ${JSON.stringify(entry.text)}`);
    }
    say(`i18n lint: ${result.files} files read (${result.skipped.length} dictionaries skipped); ${result.found.length} found, ${result.allowlisted.length} allowlisted, ${result.baselined.length} in the baseline, ${result.fresh.length} new`);
    process.exitCode = result.fresh.length || result.stale.length || result.staleAllow.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
