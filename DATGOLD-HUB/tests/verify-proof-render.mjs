// lib/proof/render/: a proof pack as a report people read, in Markdown (a pull request comment) and in one HTML file, in English and in
// Vietnamese (P5 pod-30, docs/PROOF-RENDER.md), and `chatmcp verify show --pack`, which makes them.
//
// What it proves:
//   1. the dictionary: the same keys and the same placeholders in both languages, NFC, no hidden character, a text for every code the
//      predicate can hold; translate() takes numbers and nodes only, so no pack text can become report text;
//   2. the escaping of one text: what is hidden is shown as a marker, everything else stays as it is (diacritics included, composed or not);
//      HTML text and attributes; Markdown code spans alone and in a table cell;
//   3. numbers, dates and money: no locale, exact decimals, a rate only when the caller gives one with its date and source;
//   4. the diff stat: counts from the patch itself, strict (a patch it does not understand has no counts), hunk lines that look like headers;
//   5. the report: the verdict from the statuses, each section, and an honest sentence where the pack holds nothing (egress, permissions,
//      cost per criterion, check changes, the ledger, the patch of a statement alone);
//   6. golden reports: 2 packs x 2 languages x 2 formats, byte for byte;
//   7. hostile texts: every one in every text field of a statement, both formats, both languages, read back with an HTML tokenizer and a
//      Markdown reader written here (code spans and table cells by the rules of cmark-gfm and of markdown-it): only the report's own tags,
//      only the report's own words outside code spans, the text itself intact inside; also after a consumer normalises the bytes to NFC;
//   8. the HTML page: one file, a policy that forbids scripts and every load and names the one style by its hash, a print style sheet;
//   9. determinism: the same bytes with the clock, Intl and locale functions broken, and for a statement held with another key order;
//  10. the Markdown cap: at most 65,000 characters, whole lines only, the verdict and how to verify kept, what was left out counted;
//  11. the command: show --pack in both formats and languages, --out (never over a file), --vnd-rate, --json, the usage errors, a pack that
//      does not verify renders nothing (exit 3).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_CHANGE_SCHEMA, CHECK_RESULTS, CRITERION_STATUS, PACK_LIMITS, REASON_CODES, canonicalJson, statementDigest, validateStatement } from '../lib/proof/pack.mjs';
import { compileSchema } from '../lib/proof/schema-validate.mjs';
import { readPackFile } from '../lib/proof/cli/check.mjs';
import { CLI_DATA_SCHEMAS, CLI_OUTPUT_SCHEMA, CODES, EXIT, main } from '../lib/proof/cli/index.mjs';
import { DICTIONARY, LANGS, code, text, translate } from '../lib/proof/render/i18n.mjs';
import { cutText, formatBytes, formatDecimal, formatDuration, formatInteger, readRate, shortId, visible, vndOf } from '../lib/proof/render/text.mjs';
import { DIFF_ROWS, diffStat } from '../lib/proof/render/diffstat.mjs';
import { RenderError, VERDICTS, buildReport } from '../lib/proof/render/model.mjs';
import { MD_MAX_CHARS, mdCode, mdText, renderMarkdown } from '../lib/proof/render/md.mjs';
import { CSP, STYLE, htmlText, renderHtml } from '../lib/proof/render/html.mjs';
import { HOSTILE, PACKS, REPORT_OPTIONS, buildPack, goldenFile, packFile } from './fixtures/proof-render/fixture.mjs';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Under the mutation runner the Hub is a copy without the repository around it; the runner says where it came from.
const REPO = path.resolve(process.env.CHATMCP_MUTATION_SOURCE ? path.resolve(process.env.CHATMCP_MUTATION_SOURCE) : HUB, '..');
const BIN = path.join(HUB, 'bin', 'chatmcp.mjs');

let checks = 0;
const suiteStart = performance.now();
const elapsed = () => `${((performance.now() - suiteStart) / 1000).toFixed(1)} s`;
const ok = (label) => { checks += 1; console.log(`  ok - ${label} [${elapsed()}]`); };
setTimeout(() => { console.error('FAIL: the proof render suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

const sha256 = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const SCRATCH = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-render-suite-')));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });

const READ = Object.fromEntries(PACKS.map((name) => [name, readPackFile(fs.readFileSync(packFile(name)))]));
const sourceOf = (name) => ({ ...READ[name], packChecked: true });
const report = (source, options = {}) => buildReport(source, { lang: 'en', ...options });
const md = (source, options = {}, limits = {}) => renderMarkdown(report(source, options), limits).text;
const html = (source, options = {}) => renderHtml(report(source, options)).text;
const statementAlone = (statement) => ({ statement });
/** The statement of a pack with `change` applied to a copy; asserted valid, so a test never renders what the builder could not make. */
function variant(name, change) {
  const statement = clone(READ[name].statement);
  change(statement.predicate, statement);
  const checked = validateStatement(statement);
  assert.ok(checked.valid, `(premise) the variant is a valid statement: ${JSON.stringify(checked.errors.slice(0, 3))}`);
  return statement;
}
// What may never reach a reader as itself, written apart from the code under test: control characters but the line end, format and
// default-ignorable characters, separators but the space and (in the report's own texts) the no-break space, private noncharacters.
const HIDDEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u1680\u2000-\u200F\u2028-\u202F\u205F-\u206F\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB\uFFFE\uFFFF\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/u;

// =====================================================================================================================
// the independent readers
// =====================================================================================================================
const VOID = new Set(['meta']);
const TAGS = {
  html: ['lang'], head: [], meta: ['charset', 'http-equiv', 'content', 'name'], title: [], style: [], body: [], header: [], main: [], section: ['id'], h1: [], h2: [],
  p: ['class'], ul: [], li: [], table: ['class'], thead: [], tbody: [], tr: [], th: ['scope'], td: [], code: ['title'], pre: [], strong: [], span: ['class'], div: ['class'],
};
const CLASSES = new Set(['verdict pass', 'verdict warn', 'verdict fail', 'note', 'scroll', 'facts', 'chip evidenced', 'chip owner_accepted', 'chip unverified', 'chip failed', 'chip stale', 'chip checks_modified',
  ...CHECK_RESULTS.map((result) => `chip ${result}`)]);
const unescapeHtml = (value) => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]);

/** Reads a page with no tolerance: only the tags and attributes above, balanced, every `&` one of five entities. Returns its text pieces. */
function readHtml(page, label) {
  const bad = (why, at) => assert.fail(`${label}: ${why} at ${at}: ${JSON.stringify(page.slice(Math.max(0, at - 60), at + 120))}`);
  const open = [];
  const pieces = []; // {tag, text}: the decoded text of each run, with the innermost tag around it
  const attributes = [];
  const prefix = '<!doctype html>\n';
  assert.ok(page.startsWith(prefix), `${label}: the page starts with its doctype`);
  let at = prefix.length;
  while (at < page.length) {
    if (page[at] !== '<') {
      const end = page.indexOf('<', at);
      const raw = page.slice(at, end < 0 ? page.length : end);
      if (open.at(-1) === 'style') pieces.push({ tag: 'style', text: raw });
      else {
        if (/&(?!(?:amp|lt|gt|quot|#39);)/.test(raw) || /[>"']/.test(raw)) bad('an unescaped character in text', at);
        pieces.push({ tag: open.at(-1) ?? null, text: unescapeHtml(raw) });
      }
      at += raw.length;
      continue;
    }
    const close = /^<\/([a-z0-9]+)>/.exec(page.slice(at, at + 40));
    if (close) {
      if (open.at(-1) !== close[1]) bad(`</${close[1]}> closes ${open.at(-1)}`, at);
      open.pop();
      at += close[0].length;
      continue;
    }
    const start = /^<([a-z0-9]+)((?: [a-z-]+="[^"<>]*")*)>/.exec(page.slice(at, at + 1200));
    if (!start) bad('a < that starts no tag of the report', at);
    const [whole, tag, rest] = start;
    if (!Object.hasOwn(TAGS, tag)) bad(`a tag the report does not use (${tag})`, at);
    for (const [, name, raw] of rest.matchAll(/ ([a-z-]+)="([^"]*)"/g)) {
      if (!TAGS[tag].includes(name)) bad(`an attribute ${tag} does not take (${name})`, at);
      if (/&(?!(?:amp|lt|gt|quot|#39);)/.test(raw)) bad('an unescaped character in an attribute', at);
      const value = unescapeHtml(raw);
      attributes.push({ tag, name, value });
      if (name === 'class' && !CLASSES.has(value)) bad(`a class the report does not use (${value})`, at);
      if (name === 'id' && !/^[a-z-]+$/.test(value)) bad(`an id that is not the report's (${value})`, at);
      if (name === 'title' && !/^[0-9a-f]{40,64}$/.test(value)) bad(`a title that is not a whole id (${value})`, at);
    }
    if (!VOID.has(tag)) open.push(tag);
    at += whole.length;
  }
  assert.deepEqual(open, [], `${label}: every tag is closed`);
  return { pieces, attributes };
}
const codesOfHtml = (page, label) => readHtml(page, label).pieces.filter((piece) => piece.tag === 'code').map((piece) => piece.text);

/** Splits a GFM table row into cells, the way cmark-gfm scans it (a backslash takes any ASCII punctuation with it). */
function cellsCmark(line) {
  const cells = [];
  let current = '';
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === '\\' && i + 1 < line.length && /[!-/:-@[-`{-~]/.test(line[i + 1])) { current += line[i] + line[i + 1]; i += 1; continue; }
    if (line[i] === '|') { cells.push(current); current = ''; continue; }
    current += line[i];
  }
  assert.equal(current, '', `the row ends with a pipe: ${line}`);
  return cells.map((cell) => cell.trim().replace(/\\\|/g, '|'));
}
/** The same the way markdown-it does it (a pipe is escaped when the one character before it is a backslash). */
function cellsMarkdownIt(line) {
  const cells = [];
  let current = '';
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === '|') {
      if (line[i - 1] === '\\') { current = `${current.slice(0, -1)}|`; continue; }
      cells.push(current);
      current = '';
      continue;
    }
    current += line[i];
  }
  assert.equal(current, '', `the row ends with a pipe: ${line}`);
  return cells.map((cell) => cell.trim());
}
/** Inline Markdown by CommonMark's code span rule: {outside: the text that is no code span, codes: the content of each span}. */
function inline(value) {
  const codes = [];
  let outside = '';
  let at = 0;
  while (at < value.length) {
    if (value[at] === '\\' && /[!-/:-@[-`{-~]/.test(value[at + 1] ?? '')) { outside += value.slice(at, at + 2); at += 2; continue; }
    if (value[at] !== '`') { outside += value[at]; at += 1; continue; }
    const run = /^`+/.exec(value.slice(at))[0].length;
    let end = -1;
    for (const match of value.slice(at + run).matchAll(/`+/g)) if (match[0].length === run) { end = at + run + match.index; break; }
    assert.ok(end >= 0, `a backtick run that opens nothing: ${value}`);
    let content = value.slice(at + run, end);
    if (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') content = content.slice(1, -1);
    codes.push(content);
    outside += '\u0001';
    at = end + run;
  }
  return { outside, codes };
}
// Outside code spans: the report's own words. No markup but the report's own bold, no link, no HTML, no mention, no issue number.
const OUTSIDE = /^[\p{L}\p{M}\p{N} \u00A0\u0001.,:;()/%+=×÷≈–—→…“”'"?·\-]*$/u;
const GLYPHS = /[✅❌❔⏳⚪\u{1F464}\u{1F6A9}\u{1F501}]/gu;

/** Reads a Markdown report: headings, paragraphs, lists, tables and one fenced block of commands. Returns {codes, outside, fenced, rows}. */
function readMd(body, label) {
  const codes = [];
  const outside = [];
  const fenced = [];
  let rows = 0;
  let inFence = false;
  let columns = 0;
  for (const [index, line] of body.split('\n').entries()) {
    const where = `${label} line ${index + 1}: ${line}`;
    if (inFence) { if (line === '```') inFence = false; else fenced.push(line); continue; }
    if (line === '```text') { inFence = true; continue; }
    assert.doesNotMatch(line, /^(?: {4}|\t| *>|~~~|```|===|---| *#{4,} )/, `${where}\nno block but the report's`);
    if (line.startsWith('|')) {
      if (/^\|(?: --- \|)+$/.test(line)) { assert.equal(line.split('---').length - 1, columns, `${where}\nthe delimiter row fits the head`); continue; }
      const cells = cellsCmark(line);
      assert.deepEqual(cellsMarkdownIt(line), cells, `${where}\ntwo table readers see the same cells`);
      if (columns === 0) columns = cells.length;
      assert.equal(cells.length, columns, `${where}\nevery row has ${columns} cells`);
      rows += 1;
      for (const cell of cells) { const read = inline(cell); codes.push(...read.codes); outside.push([where, read.outside]); }
      continue;
    }
    columns = 0;
    const prose = line.replace(/^#{2,3} /, '').replace(/^- /, '');
    const read = inline(prose);
    codes.push(...read.codes);
    outside.push([where, read.outside]);
  }
  assert.equal(inFence, false, `${label}: the fenced block is closed`);
  for (const [where, value] of outside) {
    const plain = value.replace(/\\([!-/:-@[-`{-~])/g, (_, char) => (/[<>[\]`|*_~&@#!]/.test(char) ? '\u0002' : char)).replaceAll('**', '').replace(GLYPHS, '');
    assert.match(plain, OUTSIDE, `${where}\noutside code spans there are only the report's own words: ${JSON.stringify(plain)}`);
  }
  return { codes, fenced, rows };
}

// =====================================================================================================================
// 1. the dictionary
// =====================================================================================================================
{
  assert.deepEqual([...LANGS], ['en', 'vi']);
  assert.deepEqual(Object.keys(DICTIONARY).sort(), ['en', 'vi']);
  assert.deepEqual(Object.keys(DICTIONARY.vi).sort(), Object.keys(DICTIONARY.en).sort(), 'the same keys in both languages');
  const slots = (value) => [...value.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]).sort();
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(DICTIONARY[lang])) {
      const where = `${lang} ${key}`;
      assert.equal(typeof value, 'string', where);
      assert.ok(value.trim() === value && value.length > 0, `${where} is a trimmed text`);
      assert.equal(value, value.normalize('NFC'), `${where} is NFC`);
      assert.doesNotMatch(value, HIDDEN, `${where} holds no hidden character`);
      assert.doesNotMatch(value, /[`<>|*_#[\]\\]/, `${where} holds no markup`);
      assert.doesNotMatch(value, / {2}|\s[,.;:!?]|\n/u, `${where}: single spaces, none before punctuation`);
      assert.doesNotMatch(value.replace(/\{[a-zA-Z]+\}/g, ''), /[{}]/, `${where}: every brace is a placeholder`);
      assert.deepEqual(slots(value), slots(DICTIONARY.en[key]), `${where} has the placeholders of the English text`);
    }
  }
  // Vietnamese is Vietnamese: a text that is the same in both languages is a name, a unit or a format
  const same = Object.keys(DICTIONARY.en).filter((key) => DICTIONARY.en[key] === DICTIONARY.vi[key]);
  assert.deepEqual(same.sort(), ['label.agent', 'unit.bytes.KiB', 'unit.bytes.MiB', 'unit.seconds', 'unit.usd'].filter((key) => Object.hasOwn(DICTIONARY.en, key)).sort(), 'what the languages share');
  const vietnamese = Object.entries(DICTIONARY.vi).filter(([key]) => !same.includes(key) && !key.startsWith('unit.'));
  const marked = vietnamese.filter(([, value]) => /[àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/iu.test(value));
  assert.ok(marked.length > vietnamese.length * 0.95, `${marked.length} of ${vietnamese.length} Vietnamese texts have Vietnamese letters`);
  // a text for every code the predicate can hold
  const { $defs } = AGENT_CHANGE_SCHEMA;
  const { properties } = $defs.predicate;
  const wanted = [
    ...CRITERION_STATUS.map((value) => `status.${value}`), ...CHECK_RESULTS.map((value) => `result.${value}`), ...REASON_CODES.map((value) => `reason.${value}`),
    ...Object.keys(properties.permissions.properties).filter((name) => name !== 'records').map((value) => `permission.${value}`),
    ...properties.limitations.items.enum.map((value) => `limitation.${value}`), ...$defs.tree.properties.limitations.items.enum.map((value) => `limitation.${value}`),
    ...properties.excludedPaths.properties.classes.items.enum.map((value) => `excluded.${value}`),
    ...properties.lockfiles.items.properties.status.enum.filter((value) => value !== 'unchanged').map((value) => `lockfile.${value}`),
    ...properties.ledger.properties.reason.enum.filter(Boolean).map((value) => `ledger.${value}`), ...VERDICTS.map((value) => `verdict.${value}`),
  ];
  for (const key of wanted) assert.ok(Object.hasOwn(DICTIONARY.en, key), `the dictionary has ${key}`);
  // translate: placeholders become nodes; only numbers and nodes go in, so a text of a pack cannot become a text of the report
  const key = Object.keys(DICTIONARY.en).find((name) => slots(DICTIONARY.en[name]).length === 1);
  const [slot] = slots(DICTIONARY.en[key]);
  const nodes = translate('en', key, { [slot]: code('<b>') });
  assert.ok(nodes.some((node) => node.type === 'code' && node.value === '<b>') && nodes.every((node) => ['code', 'text'].includes(node.type)), 'a node stays a node');
  assert.equal(translate('en', key, { [slot]: 1234567 }).find((node) => /1,234,567/.test(node.value))?.type, 'text', 'a number is written in the language of the report');
  assert.ok(translate('vi', key, { [slot]: 1234567 }).some((node) => /1\.234\.567/.test(node.value)));
  assert.deepEqual(translate('en', key, { [slot]: [text('a'), code('b')] }).filter((node) => ['a', 'b'].includes(node.value)).length, 2, 'a list of nodes is spliced in');
  for (const value of ['raw text', null, undefined, {}, true, 1.5, NaN]) assert.throws(() => translate('en', key, { [slot]: value }), TypeError, `translate refuses ${JSON.stringify(value)}`);
  assert.throws(() => translate('en', 'no.such.key', {}), TypeError);
  assert.throws(() => translate('fr', key, {}), TypeError);
  assert.throws(() => translate('en', key, {}), TypeError, 'a placeholder without its value');
  ok(`the dictionary: ${Object.keys(DICTIONARY.en).length} texts in 2 languages (same keys and placeholders, NFC, no markup), one for each of ${wanted.length} codes; translate takes numbers and nodes only`);
}

// =====================================================================================================================
// 2. one text
// =====================================================================================================================
{
  // what is hidden is shown, what is not stays
  assert.equal(visible('a\u202Eb'), 'a⟦U+202E⟧b');
  assert.equal(visible('\u0000\n\t\r\u001B\u007F\u0085'), '⟦U+0000⟧⟦U+000A⟧⟦U+0009⟧⟦U+000D⟧⟦U+001B⟧⟦U+007F⟧⟦U+0085⟧');
  assert.equal(visible('\u200B\u200D\u2060\uFEFF\u00AD\u{E0041}\u2028\u2029\u061C\u3164\uFE0F'), [...'\u200B\u200D\u2060\uFEFF\u00AD\u{E0041}\u2028\u2029\u061C\u3164\uFE0F'].map((char) => `⟦U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`).join(''));
  assert.equal(visible('a\u00A0b\u3000c\u2003d'), 'a⟦U+00A0⟧b⟦U+3000⟧c⟦U+2003⟧d', 'a space that is not the space');
  assert.equal(visible('\ud800x\udc00'), '⟦U+D800⟧x⟦U+DC00⟧', 'a lone surrogate');
  assert.equal(visible('⟦U+202E⟧'), '⟦U+27E6⟧U+202E⟦U+27E7⟧', 'a marker in the text itself cannot be taken for one of the report');
  assert.equal(visible('\u1FEF \u037E'), '⟦U+1FEF⟧ ⟦U+037E⟧', 'a character whose NFC form is a backtick or a semicolon');
  assert.equal(visible('\u0338x\u0338'), '⟦U+0338⟧x\u0338', 'a combining mark with nothing before it would join the markup before it');
  assert.equal(visible('\uFDD0\uFFFE\u{1FFFE}'), '⟦U+FDD0⟧⟦U+FFFE⟧⟦U+1FFFE⟧', 'noncharacters');
  for (const plain of ['', 'npm test', 'a  b', 'ắ ằ ẳ ẵ ặ Đ đ ₫', 'Tiếng Việt'.normalize('NFD'), '😀 日本語 عربي', 'a\u0301', '<>&"\'`|\\']) assert.equal(visible(plain), plain, `${JSON.stringify(plain)} is shown as it is`);
  assert.notEqual(visible('⟦'), '⟦', 'the mark itself is written as a code point');
  // injective: two texts never look the same because of the markers
  const seen = new Map();
  for (const value of [...Object.values(HOSTILE), ...Object.values(HOSTILE).map(visible), '\u202E', '⟦U+202E⟧', '⟦U+27E6⟧U+202E⟦U+27E7⟧']) {
    const shown = visible(value);
    assert.ok(!seen.has(shown) || seen.get(shown) === value, `two texts are shown as ${JSON.stringify(shown)}`);
    seen.set(shown, value);
    assert.doesNotMatch(shown, HIDDEN, 'nothing hidden is left');
  }

  // HTML
  assert.equal(htmlText('<a href="x" title=\'y\'>&amp;</a>'), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;');

  // Markdown code spans
  const span = (value, table) => { const { outside, codes } = inline(mdCode(value, { table })); assert.equal(outside, '\u0001', `${JSON.stringify(value)} is one code span`); return codes[0]; };
  for (const value of ['npm test', 'a`b', '`', '``', '```', '` ``` `', '`x`', 'a `` b ` c', ' lead', 'trail ', ' both ', ' ', '   ', '', 'x|y', '\\', 'a\\']) {
    assert.equal(span(value, false), value === '' ? ' ' : value, `${JSON.stringify(value)} in a code span`);
  }
  assert.equal(mdCode('x'), '`x`', 'the simple case is simple');
  assert.equal(mdCode('x', { table: true }), '`x`');
  // a pipe in a table cell has one backslash before it, never two: cmark-gfm and markdown-it read a longer run differently
  for (const value of ['a|b', '|', '||', '\\|', '\\\\|', '\\\\\\|', 'a\\', '\\`|', '| a | b |', 'x\\|y|z\\']) {
    const row = `| ${mdCode(value, { table: true })} | z |`;
    const cells = cellsCmark(row);
    assert.deepEqual(cellsMarkdownIt(row), cells, `${JSON.stringify(value)}: both table readers agree`);
    assert.equal(cells.length, 2, `${JSON.stringify(value)} stays in its cell`);
    const { outside, codes } = inline(cells[0]);
    assert.equal(outside, '\u0001');
    assert.equal(codes[0].replaceAll('⟦U+005C⟧', '\\'), value, `${JSON.stringify(value)} reads back`);
  }
  assert.equal(mdText('a*b_c`d<e>f|g[h]\\i#j~k&l!m'), 'a\\*b\\_c\\`d\\<e\\>f\\|g\\[h\\]\\\\i\\#j\\~k\\&l\\!m');
  // a long text is cut for Markdown, and says how long it was; whole characters only
  assert.deepEqual(cutText('abc', 3), { text: 'abc', length: 3, cut: false });
  assert.deepEqual(cutText('abcd', 3), { text: 'abc', length: 4, cut: true });
  assert.deepEqual(cutText('😀😀😀', 2), { text: '😀😀', length: 3, cut: true });
  // ids
  assert.equal(shortId('0123456789abcdef0123456789abcdef01234567'), '0123456789ab');
  ok('one text: hidden characters as markers (injective), the rest as it is (composed and decomposed diacritics); HTML; code spans alone and in a cell, as two table readers see them');
}

// =====================================================================================================================
// 3. numbers, money, dates
// =====================================================================================================================
{
  for (const [value, en, vi] of [[0, '0', '0'], [7, '7', '7'], [999, '999', '999'], [1000, '1,000', '1.000'], [1234567, '1,234,567', '1.234.567'], [100000, '100,000', '100.000'],
    [Number.MAX_SAFE_INTEGER, '9,007,199,254,740,991', '9.007.199.254.740.991']]) {
    assert.equal(formatInteger(value, 'en'), en);
    assert.equal(formatInteger(value, 'vi'), vi);
  }
  for (const [value, en, vi] of [[0, '0', '0'], [1.5, '1.5', '1,5'], [1234.5678, '1,234.5678', '1.234,5678'], [0.1 + 0.2, '0.30000000000000004', '0,30000000000000004'], [1e-7, '0.0000001', '0,0000001'],
    [1.25e-9, '0.00000000125', '0,00000000125'], [1e9, '1,000,000,000', '1.000.000.000'], [0.0000125, '0.0000125', '0,0000125'], [5e-324, `0.${'0'.repeat(323)}5`, `0,${'0'.repeat(323)}5`]]) {
    assert.equal(formatDecimal(value, 'en'), en, `${value}`);
    assert.equal(formatDecimal(value, 'vi'), vi, `${value}`);
  }
  assert.equal(formatDuration(0, 'en'), '0 ms');
  assert.equal(formatDuration(999, 'en'), '999 ms');
  assert.equal(formatDuration(1000, 'en'), '1.000 s');
  assert.equal(formatDuration(61_007, 'en'), '61.007 s');
  assert.equal(formatDuration(1_234_567, 'vi'), '1.234,567 s');
  assert.equal(formatBytes(0, 'en'), '0 bytes');
  assert.equal(formatBytes(5_678_901, 'vi'), '5.678.901 byte');

  // the rate: only what the caller gives, whole
  const rate = { rate: '25400', date: '2026-11-20', source: 'Vietcombank' };
  assert.deepEqual(readRate(rate), rate);
  assert.equal(readRate(null), null);
  assert.equal(readRate(undefined), null);
  assert.deepEqual(readRate({ ...rate, rate: '25400.1234' }).rate, '25400.1234');
  assert.equal(readRate({ ...rate, date: '2024-02-29' }).date, '2024-02-29', 'a leap day');
  for (const wrong of [{ rate: '0' }, { rate: '-1' }, { rate: '1e4' }, { rate: '25,400' }, { rate: '' }, { rate: 25400 }, { rate: '01' }, { rate: '1.23456' }, { rate: '100000000' }, { rate: '25400 ' }, { rate: '0.0000' },
    { date: '2026-13-01' }, { date: '2026-02-30' }, { date: '2025-02-29' }, { date: '20-11-2026' }, { date: '' }, { date: null }, { date: '2026-11-20T00:00:00Z' }, { date: '2026-00-10' }, { date: '2026-04-31' },
    { source: '' }, { source: '   ' }, { source: 'x'.repeat(201) }, { source: null }, { extra: 1 }]) {
    assert.throws(() => readRate({ ...rate, ...wrong }), (error) => error instanceof RenderError && error.code === 'render_bad_input', JSON.stringify(wrong));
  }
  for (const missing of ['rate', 'date', 'source']) { const partial = { ...rate }; delete partial[missing]; assert.throws(() => readRate(partial), RenderError, `a rate without its ${missing}`); }
  for (const wrong of ['25400', 25400, [], true]) assert.throws(() => readRate(wrong), RenderError, JSON.stringify(wrong));
  // whole dong, exact, half up; never a float product
  for (const [usd, per, en] of [[1, '25400', '25,400'], [1234.5678, '25400', '31,358,022'], [0.1, '25400', '2,540'], [0.00005, '10000', '1'], [0.00004999, '10000', '< 1'], [0, '25400', '0'],
    [1.5, '1', '2'], [2.5, '1', '3'], [1e9, '99999999.9999', '99,999,999,999,900,000'], [1.005, '100', '101'], [8.115, '100', '812'], [1e-7, '25400.5', '< 1']]) {
    assert.equal(vndOf(usd, per, 'en'), en, `${usd} x ${per}`);
  }
  assert.equal(vndOf(1234.5678, '25400', 'vi'), '31.358.022');
  ok('integers, decimals, durations and bytes without a locale; a rate only whole (rate, date, source); dong exact and half up');
}

// =====================================================================================================================
// 4. the diff stat
// =====================================================================================================================
{
  const stat = (patch) => diffStat(Buffer.from(patch, typeof patch === 'string' ? 'utf8' : undefined));
  const evidenced = stat(READ.evidenced.files['change.diff'].toString('utf8'));
  assert.deepEqual(evidenced, {
    files: [
      { path: 'src/tính-tổng.mjs', change: 'modified', added: 2, removed: 1, binary: false },
      { path: 'docs/huong dan.md', change: 'added', added: 2, removed: 0, binary: false },
      { path: 'old.txt', change: 'deleted', added: 0, removed: 1, binary: false },
      { path: 'logo.bin', change: 'modified', added: 0, removed: 0, binary: true },
      { path: 'run.sh', change: 'modified', added: 0, removed: 0, binary: false },
    ],
    total: 5, added: 4, removed: 2, binary: 1,
  });
  // lines of a hunk that look like headers are lines of the hunk; a quoted path is decoded
  const hostile = stat(READ.hostile.files['change.diff'].toString('utf8'));
  assert.deepEqual(hostile.files, [
    { path: '<img src=x onerror=alert(1)>.js', change: 'modified', added: 2, removed: 2, binary: false },
    { path: 'safe\u202Egpj.exe', change: 'added', added: 1, removed: 0, binary: false },
    { path: 'tài liệu\t|`[x](y)\n.md', change: 'deleted', added: 0, removed: 1, binary: false },
  ]);
  assert.deepEqual([hostile.total, hostile.added, hostile.removed, hostile.binary], [3, 3, 3, 0]);
  assert.deepEqual(stat(''), { files: [], total: 0, added: 0, removed: 0, binary: 0 }, 'an empty patch changes nothing');
  const head = (name = 'x') => `diff --git a/${name} b/${name}\nindex ${'1'.repeat(40)}..${'2'.repeat(40)} 100644\n`;
  const one = (name = 'x', lines = '@@ -1 +1 @@\n-a\n+b\n') => `${head(name)}--- a/${name}\n+++ b/${name}\n${lines}`;
  assert.deepEqual(stat(one('a b/a')).files[0].path, 'a b/a', 'a path that holds " b/": the two names are the same, so there is one way to split');
  assert.equal(stat(one('x', '@@ -1,2 +1,2 @@ fn()\n a\n-b\n+c\n@@ -9 +9,0 @@\n-z\n')).removed, 2, 'several hunks, a hunk header with a context');
  assert.equal(stat(one('x', '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n')).added, 1);
  assert.equal(stat(one('x', '@@ -1,1 +1,2 @@\n \n+b\n')).added, 1, 'an empty context line');
  assert.equal(stat(`diff --git "a/q\\"\\\\\\a\\b\\v\\f\\r\\303\\251" "b/q\\"\\\\\\a\\b\\v\\f\\r\\303\\251"\nold mode 100644\nnew mode 100755\n`).files[0].path, 'q"\\\u0007\b\v\f\ré');
  assert.equal(stat(`${head('e')}`.replace(/index.*\n/, 'new file mode 100644\nindex ' + '0'.repeat(40) + '..' + '2'.repeat(40) + '\n')).files[0].change, 'added', 'an empty file added');
  assert.equal(diffStat(Buffer.concat([Buffer.from('diff --git "a/\\377" "b/\\377"\nold mode 100644\nnew mode 100755\n')])).files[0].path, '�', 'a path that is not UTF-8');
  assert.equal(stat(one('x') + one('y')).total, 2);
  assert.equal(diffStat(Buffer.from(one('x', '@@ -1 +1 @@\n-\xff\n+\xfe\n'), 'latin1')).added, 1, 'content that is not UTF-8');
  // anything else has no counts: a patch that says more than its grammar is not counted half-way
  const binary = `${head('b')}GIT binary patch\nliteral 3\nKcmb<$WdZ;I0001u0000\n\ndelta 3\nKcmb<$WdZ;I0001u0000\n\n`;
  assert.equal(stat(binary).binary, 1);
  for (const [label, patch] of Object.entries({
    'text before the first file': `hello\n${one()}`, 'a traditional diff': '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n', 'text after a hunk': `${one()}garbage\n`, 'a hunk cut short': one('x', '@@ -1,2 +1,2 @@\n-a\n+b\n'),
    'a hunk too long': one('x', '@@ -1 +1 @@\n-a\n+b\n+c\n'), 'a hunk line of another kind': one('x', '@@ -1 +1 @@\n-a\n*b\n'), 'names that differ': 'diff --git a/x b/y\nold mode 100644\nnew mode 100755\n',
    'the old name differs': `${head()}--- a/evil\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`, 'the new name differs': `${head()}--- a/x\n+++ b/evil\n@@ -1 +1 @@\n-a\n+b\n`,
    'deleted without saying so': `${head()}--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n`, 'added without saying so': `${head()}--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+a\n`,
    'added with an old name': `diff --git a/x b/x\nnew file mode 100644\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+a\n`, 'deleted with a new name': `diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ b/x\n@@ -1 +0,0 @@\n-a\n`,
    'no new name': `${head()}--- a/x\n@@ -1 +1 @@\n-a\n+b\n`, 'a hunk without names': `${head()}@@ -1 +1 @@\n-a\n+b\n`, 'a rename': 'diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n',
    'no last line end': one().slice(0, -1), 'a bad escape': 'diff --git "a/\\q" "b/\\q"\nold mode 100644\nnew mode 100755\n', 'a quoted name that does not end': 'diff --git "a/x b/x\nold mode 100644\nnew mode 100755\n',
    'a binary block without its data': `${head('b')}GIT binary patch\nliteral 3\n\n`, 'a binary block that does not end': `${head('b')}GIT binary patch\nliteral 3\nKcmb<$WdZ;I0001u0000\n`,
    'a binary block with other data': `${head('b')}GIT binary patch\nliteral 3\n+++ b/x\n\n`, 'a binary patch without a block': `${head('b')}GIT binary patch\n`, 'a binary patch and hunks': `${binary}@@ -1 +1 @@\n-a\n+b\n`,
    'a hunk header that is not one': one('x', '@@ -a +b @@\n-a\n+b\n'), 'no names at all': 'diff --git\n', 'both added and deleted': 'diff --git a/x b/x\nnew file mode 100644\ndeleted file mode 100644\n', 'a name with another prefix': 'diff --git c/x d/x\nold mode 1\n',
    'names with no hunk': `${head()}--- a/x\n+++ b/x\n`, 'a note outside a hunk': `${head()}\\ No newline at end of file\n`, 'a negative hunk': one('x', '@@ --1 +1 @@\n-a\n+b\n'), 'an octal escape over a byte': 'diff --git "a/\\777" "b/\\777"\nold mode 1\n',
  })) assert.equal(stat(patch), null, `${label} has no counts`);
  // many files: the totals count all of them, the rows are the first
  const many = stat(Array.from({ length: DIFF_ROWS + 5 }, (_, i) => one(`f${i}`)).join(''));
  assert.equal(many.files.length, DIFF_ROWS);
  assert.deepEqual([many.total, many.added, many.removed], [DIFF_ROWS + 5, DIFF_ROWS + 5, DIFF_ROWS + 5]);
  ok('the diff stat: text, binary, mode, quoted and Vietnamese paths; hunk lines that look like headers; a patch outside its grammar has no counts; totals beyond the rows listed');
}

// =====================================================================================================================
// 5. the report
// =====================================================================================================================
const EN = DICTIONARY.en;
/** The plain text of a key (its placeholders as `…`), as a regular expression over a rendered Markdown report. */
const says = (key, lang = 'en') => new RegExp(mdText(DICTIONARY[lang][key]).split(/\\?\{[a-zA-Z]+\\?\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*?'));
const sectionOf = (body, key, lang = 'en') => { const title = `### ${DICTIONARY[lang][key]}\n`; const at = body.indexOf(title); assert.ok(at >= 0, `the report has the section ${key}`); const end = body.indexOf('\n### ', at + 4); return body.slice(at, end < 0 ? body.length : end); };
const SECTIONS = ['subject', 'criteria', 'receipts', 'diff', 'tamper', 'permissions', 'uncertain', 'egress', 'cost', 'integrity', 'verify'];
{
  // the verdict follows the statuses
  const verdict = (statement) => buildReport(statementAlone(statement), { lang: 'en' }).verdict;
  assert.deepEqual([...VERDICTS], ['evidenced', 'accepted', 'failed', 'checks_modified', 'not_evidenced', 'no_criteria']);
  assert.equal(verdict(READ.evidenced.statement), 'accepted', 'one criterion was accepted by the owner');
  assert.equal(verdict(READ.hostile.statement), 'failed');
  const keep = (...ids) => variant('hostile', (p) => { p.criteria = p.criteria.filter(({ id }) => ids.includes(id)); });
  assert.equal(verdict(keep('ok')), 'evidenced');
  assert.equal(verdict(keep('ok', 'accepted')), 'accepted');
  assert.equal(verdict(keep('accepted')), 'accepted');
  assert.equal(verdict(keep('ok', 'link')), 'checks_modified');
  assert.equal(verdict(keep('link', 'xss')), 'failed', 'a failure first');
  assert.equal(verdict(keep('ok', 'attr')), 'not_evidenced');
  assert.equal(verdict(keep('look')), 'not_evidenced');
  assert.equal(verdict(keep()), 'no_criteria');
  const tones = { evidenced: 'pass', accepted: 'pass', failed: 'fail', checks_modified: 'fail', not_evidenced: 'warn', no_criteria: 'warn' };
  const example = { evidenced: keep('ok'), accepted: keep('accepted'), failed: keep('xss'), checks_modified: keep('link'), not_evidenced: keep('look'), no_criteria: keep() };
  for (const kind of VERDICTS) {
    assert.match(html(statementAlone(example[kind])), new RegExp(`<p class="verdict ${tones[kind]}">`), `${kind} is shown as ${tones[kind]}`);
    assert.match(md(statementAlone(example[kind])).split('\n').slice(0, 4).join('\n'), says(`verdict.${kind}`), `${kind} opens the report`);
  }
  assert.match(md(statementAlone(READ.hostile.statement)), /1 of 11 criteria failed/);
  assert.match(md(statementAlone(READ.evidenced.statement)), /2 evidenced, 1 accepted/);

  // a pack that was checked, and a statement alone
  const checked = md(sourceOf('evidenced'));
  assert.match(checked, says('basis.pack'));
  assert.doesNotMatch(checked, says('basis.statement'));
  const alone = md(statementAlone(READ.evidenced.statement));
  assert.match(alone, says('basis.statement'));
  assert.doesNotMatch(alone, says('basis.pack'));
  assert.match(sectionOf(alone, 'section.diff'), says('diff.absent'), 'a statement alone has no patch');
  assert.doesNotMatch(sectionOf(alone, 'section.criteria'), /kiểm thử đơn vị/, 'and no criterion texts');
  assert.match(sectionOf(checked, 'section.criteria'), /`Các kiểm thử đơn vị đều đạt, chạy hai lần liên tiếp`/);
  assert.ok(md({ ...sourceOf('evidenced'), packChecked: false }).match(says('basis.statement')), 'only a caller that checked the pack may say so');
  assert.ok(checked.includes(statementDigest(READ.evidenced.statement)), 'the statement digest, computed here');

  // what it does not accept
  for (const [label, source] of Object.entries({
    nothing: null, 'no statement': {}, 'a statement that does not validate': { statement: { ...READ.evidenced.statement, extra: 1 } }, 'another patch': { statement: READ.evidenced.statement, files: { 'change.diff': Buffer.from('x') } },
    'another acceptance file': { statement: READ.evidenced.statement, files: { 'change.diff': READ.evidenced.files['change.diff'], 'acceptance.yml': Buffer.from('x') } },
    'a patch that is no bytes': { statement: READ.evidenced.statement, files: { 'change.diff': 'text' } },
  })) assert.throws(() => buildReport(source, { lang: 'en' }), (error) => error instanceof RenderError && error.code === 'render_bad_input', label);
  for (const [label, options] of Object.entries({ 'no language': {}, 'another language': { lang: 'fr' }, 'an unknown option': { lang: 'en', x: 1 }, 'half a rate': { lang: 'en', vnd: { rate: '1' } }, 'a name that is no text': { lang: 'en', packName: 7 } })) {
    assert.throws(() => buildReport(sourceOf('evidenced'), options), (error) => error instanceof RenderError, label);
  }
  // an acceptance file that does not read still gives a report: the criteria are the statement's, without their texts
  const broken = Buffer.from('not an acceptance file\n');
  const reworded = variant('evidenced', (p) => { p.acceptance.baselineSha256 = sha256(broken); });
  assert.match(sectionOf(md({ statement: reworded, files: { 'acceptance.yml': broken } }), 'section.criteria'), says('criteria.no_texts'));

  // every section, in order, in both languages and both formats
  for (const name of PACKS) {
    for (const lang of LANGS) {
      const body = md(sourceOf(name), { lang });
      const titles = [...body.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
      assert.deepEqual(titles, SECTIONS.map((id) => DICTIONARY[lang][`section.${id}`]), `${name} ${lang}: the sections`);
      const page = html(sourceOf(name), { lang });
      assert.deepEqual([...page.matchAll(/<section id="([a-z-]+)">\n<h2>([^<]+)<\/h2>/g)].map((match) => [match[1], match[2]]), SECTIONS.map((id) => [id, DICTIONARY[lang][`section.${id}`]]), `${name} ${lang}: the page`);
      assert.ok(page.includes(`<html lang="${lang}">`));
    }
  }

  // the criteria: status chips, checks, reasons
  const hostileBody = md(sourceOf('hostile'));
  const criteria = sectionOf(hostileBody, 'section.criteria');
  for (const criterion of READ.hostile.statement.predicate.criteria) {
    const row = criteria.split('\n').find((line) => line.startsWith(`| \`${criterion.id}\``));
    assert.ok(row.includes(EN[`status.${criterion.status}`]), `${criterion.id} is shown as ${criterion.status}`);
    assert.ok(html(sourceOf('hostile')).includes(`<span class="chip ${criterion.status}">`));
    for (const reason of criterion.reasons) assert.match(criteria, says(`reason.${reason.code}`), `${criterion.id}: ${reason.code}`);
  }
  for (const result of ['failed', 'stale', 'passed', 'not_run', 'tree_unknown', 'repeats_short']) assert.ok(criteria.includes(EN[`result.${result}`]), `the check result ${result}`);
  const unitRow = sectionOf(checked, 'section.criteria').split('\n').find((line) => line.includes('`node --test`'));
  assert.match(unitRow, /\| 2\/2 \|/, 'two of two runs');
  assert.match(sectionOf(checked, 'section.criteria'), /`src\/đăng-nhập\.mjs`/, 'what a person is asked to look at');
  assert.match(sectionOf(checked, 'section.criteria'), /`Xem ở cỡ chữ 200 %`/, 'and the note');
  assert.match(sectionOf(md(statementAlone(keep())), 'section.criteria'), says('criteria.none'));
  const cut = variant('hostile', (p) => { p.criteria = p.criteria.filter(({ id }) => id === 'link'); p.criteria[0].omittedReasons = 12; });
  assert.match(sectionOf(md(statementAlone(cut)), 'section.criteria'), /12 more findings/);

  // the receipts
  const receipts = sectionOf(hostileBody, 'section.receipts');
  const { after } = READ.hostile.statement.subject.reduce((all, { name, digest }) => ({ ...all, [name.split('-').at(-1)]: digest.gitTree }), {});
  assert.ok(receipts.includes(`\`${after.slice(0, 12)}\``), 'short tree ids');
  assert.ok(!receipts.includes(after), 'not the whole one');
  assert.ok(html(sourceOf('hostile')).includes(`<code title="${after}">${after.slice(0, 12)}</code>`), 'the whole one behind it, in HTML');
  for (const key of ['tree.final', 'tree.other', 'tree.none', 'outcome.timed_out', 'outcome.cancelled', 'outcome.signal']) assert.match(receipts, says(key), key);
  assert.match(receipts, /1,234\.567 s/);
  assert.match(sectionOf(md(sourceOf('hostile'), { lang: 'vi' }), 'section.receipts', 'vi'), /1\.234,567 s/);
  assert.match(receipts, /exit 2/);
  assert.match(receipts, says('receipts.omitted'));
  assert.doesNotMatch(sectionOf(checked, 'section.receipts'), says('receipts.omitted'));
  assert.match(receipts, says('receipts.command_cut'), 'a command the ledger cut says so');
  assert.match(receipts, says('tree.changed'), 'a run that changed the tree says so');
  assert.match(sectionOf(checked, 'section.receipts'), /\| `kiem-thu` #1 \|/, 'the check a receipt is listed by');
  const noReceipts = variant('hostile', (p) => { p.criteria = []; p.receipts = []; p.ledger.omittedReceipts = p.ledger.checks; });
  assert.match(sectionOf(md(statementAlone(noReceipts)), 'section.receipts'), says('receipts.omitted'));
  const noLedger = variant('hostile', (p) => {
    p.criteria = []; p.receipts = []; p.uncertain = []; Object.assign(p.ledger, { present: false, verified: false, records: 0, checks: 0, omittedReceipts: 0, omittedUncertain: 0 });
    for (const name of Object.keys(p.permissions)) p.permissions[name] = 0;
  });
  const noLedgerBody = md(statementAlone(noLedger));
  for (const id of ['receipts', 'permissions', 'uncertain']) {
    assert.match(sectionOf(noLedgerBody, `section.${id}`), says('ledger.absent'), `${id}: no ledger`);
    assert.doesNotMatch(sectionOf(noLedgerBody, `section.${id}`), /^\|/m, `${id}: no empty table`);
  }
  const brokenLedger = variant('evidenced', (p) => {
    Object.assign(p.ledger, { verified: false, brokenAt: 12, reason: 'hash_mismatch' });
    for (const criterion of p.criteria) if (criterion.kind === 'checks') { criterion.status = 'unverified'; criterion.reasons = [{ code: 'ledger_not_verified', check: null, detail: null }]; }
  });
  assert.match(sectionOf(md(statementAlone(brokenLedger)), 'section.integrity'), says('ledger.broken'));
  assert.match(sectionOf(md(statementAlone(brokenLedger)), 'section.integrity'), says('ledger.hash_mismatch'));

  // the diff
  const diff = sectionOf(checked, 'section.diff');
  assert.match(diff, says('diff.total'));
  assert.match(diff, /5 files.*4 lines added.*2 removed/);
  assert.match(diff, /\| `src\/tính-tổng\.mjs` \|.*\| 2 \| 1 \|/);
  assert.match(diff, says('diff.binary'));
  const odd = Buffer.from('--- not a git diff\n');
  const oddStatement = variant('evidenced', (p, statement) => { statement.subject.find(({ name }) => name === 'change.diff').digest.sha256 = sha256(odd); });
  assert.match(sectionOf(md({ statement: oddStatement, files: { 'change.diff': odd } }), 'section.diff'), says('diff.unreadable'));
  const nothing = Buffer.alloc(0);
  const emptyStatement = variant('evidenced', (p, statement) => { statement.subject.find(({ name }) => name === 'change.diff').digest.sha256 = sha256(nothing); });
  assert.match(sectionOf(md({ statement: emptyStatement, files: { 'change.diff': nothing } }), 'section.diff'), says('diff.empty'));

  // tamper flags
  const flags = sectionOf(hostileBody, 'section.tamper');
  assert.match(flags, says('tamper.modified'));
  assert.match(flags, /`assertions_removed tests\/\[x\]\(javascript:alert\(1\)\)\.test\.mjs`/);
  assert.match(flags, says('tamper.edited'));
  for (const key of ['lockfile.modified', 'lockfile.added', 'lockfile.deleted']) assert.ok(flags.includes(EN[key]), key);
  assert.ok(!flags.includes('same.lock'), 'a lockfile that did not change is only counted');
  assert.match(sectionOf(checked, 'section.tamper'), says('tamper.clean'));
  assert.match(sectionOf(checked, 'section.tamper'), says('tamper.not_edited'));
  const unlooked = variant('evidenced', (p) => {
    p.checkChanges = { reported: false, checksModified: false }; p.lockfiles = []; p.limitations = p.limitations.slice(0, 3);
    for (const criterion of p.criteria) if (criterion.kind === 'checks') { criterion.status = 'unverified'; criterion.reasons = [{ code: 'check_changes_unknown', check: null, detail: null }]; }
  });
  const unlookedFlags = sectionOf(md(statementAlone(unlooked)), 'section.tamper');
  assert.match(unlookedFlags, says('tamper.absent'));
  assert.doesNotMatch(unlookedFlags, says('tamper.clean'), 'nobody looked is not "nothing found"');
  assert.doesNotMatch(unlookedFlags, says('tamper.lockfiles_none'), 'nor for the lockfiles');
  assert.match(sectionOf(checked, 'section.tamper'), says('tamper.lockfiles_none'));
  // modified somewhere, but on no criterion of the pack
  const elsewhere = variant('evidenced', (p) => { p.checkChanges.checksModified = true; });
  assert.match(sectionOf(md(statementAlone(elsewhere)), 'section.tamper'), says('tamper.modified_elsewhere'));
  // no acceptance file: there is nothing that could be edited
  const bare = variant('evidenced', (p) => { p.criteria = []; p.acceptance = { baselineSha256: null, trusted: false, edited: false }; });
  assert.match(sectionOf(md(statementAlone(bare)), 'section.tamper'), says('tamper.no_acceptance'));
  assert.match(sectionOf(md(statementAlone(bare)), 'section.subject'), says('subject.no_acceptance'));

  // permissions, uncertain, egress
  const permissions = sectionOf(checked, 'section.permissions');
  assert.match(permissions, /\| Approved \| 2 \|/);
  assert.match(permissions, /\| Denied \| 1 \|/);
  assert.doesNotMatch(permissions, /\| Expired/, 'a decision nobody recorded has no row');
  const unasked = variant('evidenced', (p) => { for (const name of Object.keys(p.permissions)) p.permissions[name] = 0; });
  assert.match(sectionOf(md(statementAlone(unasked)), 'section.permissions'), says('permissions.absent'));
  assert.doesNotMatch(sectionOf(md(statementAlone(unasked)), 'section.permissions'), /^\|/m);
  const uncertain = sectionOf(hostileBody, 'section.uncertain');
  assert.match(uncertain, /\| 6 \| `torn_tail` \|/);
  assert.match(uncertain, says('uncertain.omitted'));
  assert.match(sectionOf(checked, 'section.uncertain'), says('uncertain.none'));
  assert.match(sectionOf(checked, 'section.egress'), says('egress.absent'));
  assert.doesNotMatch(sectionOf(checked, 'section.egress'), /^\||outbound/m);
  const outbound = [...READ.evidenced.entries, { seq: 99, type: 'outbound', record: {} }, { seq: 100, type: 'outbound', record: {} }];
  assert.match(sectionOf(md({ ...sourceOf('evidenced'), entries: outbound }), 'section.egress'), says('egress.unread'));
  assert.match(sectionOf(md({ ...sourceOf('evidenced'), entries: outbound }), 'section.egress'), /2 outbound records/);

  // the cost
  const costOf = (cost, options = {}) => sectionOf(md(statementAlone(variant('evidenced', (p) => { p.cost = cost; })), options), 'section.cost', options.lang ?? 'en');
  const vnd = { rate: '25400', date: '2026-11-20', source: 'Vietcombank [x](y) <b>' };
  assert.match(costOf('unknown'), says('cost.unknown'));
  assert.doesNotMatch(costOf('unknown', { vnd }), /VND.*[0-9]{4}/, 'an unknown cost has no amount in any currency');
  assert.match(costOf({ currency: 'USD', knownSubtotal: 1234.5678, complete: true }), /1,234\.5678 USD/);
  assert.match(costOf({ currency: 'USD', knownSubtotal: 1234.5678, complete: true }), says('cost.complete'));
  assert.match(costOf({ currency: 'USD', knownSubtotal: 1234.5678, complete: true }), says('cost.no_rate'), 'without a rate it says so');
  const dong = costOf({ currency: 'USD', knownSubtotal: 1234.5678, complete: true }, { vnd });
  assert.match(dong, /31,358,022 VND/);
  assert.match(dong, /25,400 VND/);
  assert.match(dong, /2026-11-20/);
  assert.match(dong, /`Vietcombank \[x\]\(y\) <b>`/, 'the date and the source beside the rate');
  assert.doesNotMatch(dong, says('cost.no_rate'));
  assert.match(costOf({ currency: 'USD', knownSubtotal: 1234.5678, complete: true }, { vnd, lang: 'vi' }), /31\.358\.022 VND/);
  const incomplete = costOf({ currency: 'USD', knownSubtotal: 0.0000125, complete: false }, { vnd });
  assert.match(incomplete, says('cost.incomplete'));
  assert.match(incomplete, /0\.0000125 USD/);
  assert.match(incomplete, /< 1 VND|\\< 1 VND/);
  assert.doesNotMatch(incomplete, says('cost.complete'));
  const euro = costOf({ currency: 'EUR', knownSubtotal: 2, complete: true }, { vnd });
  assert.match(euro, /2 EUR/);
  assert.match(euro, says('cost.not_usd'), 'the rate is for US dollars');
  assert.doesNotMatch(euro, /50,800/);
  for (const cost of ['unknown', { currency: 'USD', knownSubtotal: 3, complete: true }]) assert.match(costOf(cost, { vnd }), says('cost.per_criterion'), 'a cost per criterion is not in a v0.1 pack');
  assert.doesNotMatch(costOf({ currency: 'USD', knownSubtotal: 3, complete: true }), /\b1 USD|1\.5 USD/, 'and is not made up by a division');

  // integrity and how to verify
  const integrity = sectionOf(hostileBody, 'section.integrity');
  assert.match(integrity, /`unconfined`/);
  assert.match(integrity, says('integrity.unsigned'));
  for (const limitation of [...READ.hostile.statement.predicate.limitations, 'counts-from-last-full-snapshot']) assert.match(integrity, says(`limitation.${limitation}`), limitation);
  for (const name of READ.hostile.statement.predicate.excludedPaths.classes) assert.match(integrity, says(`excluded.${name}`), name);
  assert.match(integrity, /`<script>alert\(1\)<\/script>`/, 'why the engine fell back, as a text');
  const verify = readMd(checked, 'verify');
  const digest = statementDigest(READ.evidenced.statement);
  const commands = (body) => readMd(body, 'commands').fenced;
  assert.deepEqual(commands(md(sourceOf('evidenced'), { packName: 'evidenced.pack.json' })), [
    'chatmcp verify check evidenced.pack.json', 'chatmcp verify trust --pack evidenced.pack.json',
    `chatmcp verify reproduce evidenced.pack.json --base ${READ.evidenced.statement.predicate.baseCommit}`,
  ]);
  assert.equal(verify.fenced.length, 3);
  assert.ok(sectionOf(checked, 'section.verify').includes(digest), 'the digest to compare');
  assert.ok(commands(md(sourceOf('hostile')))[2].endsWith('--base <commit|folder>'), 'a pack without a base commit');
  for (const name of [undefined, null, 'a b.json', '-x.json', '../x.json', 'x;rm -rf /.json', '```.json', '<b>.json', 'x\n.json', '', 'x'.repeat(200), 'é.json', '$(x).json', '.x']) {
    assert.ok(commands(md(sourceOf('evidenced'), name === undefined ? {} : { packName: name })).every((line) => line.includes('<pack>')), `${JSON.stringify(name)} is no name to paste into a command`);
  }
  // the pack of a hostile maker names its ledger break only by code; the subject section names agent, model and trees
  const subject = sectionOf(checked, 'section.subject');
  for (const value of ['DatGold', '3.12.0', 'mô-hình-1', READ.evidenced.statement.predicate.baseCommit, READ.evidenced.statement.subject[1].digest.gitTree]) assert.ok(subject.includes(`\`${value}\``), `the subject names ${value}`);
  assert.ok(sectionOf(hostileBody, 'section.subject').includes(READ.hostile.statement.subject[3].digest.gitCommit), 'a commit of the change');
  assert.match(subject, says('subject.trusted'));
  assert.match(sectionOf(md(statementAlone(variant('evidenced', (p) => {
    p.acceptance.trusted = false;
    for (const criterion of p.criteria) if (criterion.kind === 'checks') { criterion.status = 'unverified'; criterion.reasons = [{ code: 'acceptance_untrusted', check: null, detail: null }]; }
  }))), 'section.subject'), says('subject.untrusted'));
  ok(`the report: ${VERDICTS.length} verdicts, ${SECTIONS.length} sections in both languages and formats; what a pack does not hold is said (egress, permissions, ledger, patch, check changes, cost per criterion, VND without a rate)`);
}

// =====================================================================================================================
// 6. golden reports
// =====================================================================================================================
{
  let files = 0;
  for (const name of PACKS) {
    assert.ok((await buildPack(name)).equals(fs.readFileSync(packFile(name))), `${name}: the committed pack is what its maker makes (node tests/fixtures/proof-render/fixture.mjs --write)`);
    for (const lang of LANGS) {
      for (const [format, render] of [['md', md], ['html', html]]) {
        const made = render(sourceOf(name), { lang, ...REPORT_OPTIONS[name] });
        assert.equal(made, fs.readFileSync(goldenFile(name, lang, format), 'utf8'), `${name}.${lang}.${format} is the golden report`);
        assert.ok(made.endsWith('\n') && !made.endsWith('\n\n') && !made.includes('\r'), 'LF, one at the end');
        assert.doesNotMatch(made.replaceAll('\u00A0', ''), HIDDEN, `${name}.${lang}.${format} holds no hidden character`);
        files += 1;
      }
    }
  }
  const attributes = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8');
  for (const pattern of ['DATGOLD-HUB/tests/fixtures/proof-render/*.pack.json -text', 'DATGOLD-HUB/tests/fixtures/proof-render/golden/** -text']) assert.ok(attributes.split(/\r?\n/).includes(pattern), `.gitattributes holds ${pattern}`);
  ok(`${files} golden reports (2 packs x 2 languages x 2 formats), byte for byte; the packs are what their maker makes`);
}

// =====================================================================================================================
// 7. hostile texts
// =====================================================================================================================
// Every place of a statement (and of the caller) that holds a free text, and how to put one there.
const PLACES = {
  'agent.name': (p, value) => { p.agent.name = value.slice(0, 100) || 'x'; },
  'agent.version': (p, value) => { p.agent.version = [...value].slice(0, 30).join('') || 'x'; },
  'model.provider': (p, value) => { p.model.provider = value; },
  'model.id': (p, value) => { p.model.id = value; },
  'model.profileRevision': (p, value) => { p.model.profileRevision = value; },
  engineReason: (p, value) => { p.trees.after.engineReason = value; },
  'engineReason before': (p, value) => { p.trees.before.engineReason = value; },
  'check.run': (p, value) => { p.criteria[0].checks[0].run = value; },
  'check.cwd': (p, value) => {
    const check = p.criteria.find(({ id }) => id === 'fence').checks[0];
    check.cwd = value;
  },
  'reason.detail': (p, value) => { p.criteria[0].reasons[0].detail = value; },
  'checks_modified detail': (p, value) => { p.criteria.find(({ id }) => id === 'link').reasons[0].detail = value; },
  'receipt.command': (p, value) => { p.receipts.at(-1).command = value; },
  'receipt.cwd': (p, value) => { p.receipts.at(-1).cwd = value; },
  'receipt.shell': (p, value) => { p.receipts.at(-1).shell = [...value].slice(0, 15).join(''); },
  'receipt.signal': (p, value) => { Object.assign(p.receipts.at(-1), { exit: null, signal: [...value].slice(0, 15).join('') }); },
  'lockfile.path': (p, value) => { p.lockfiles[0].path = value; },
};
{
  let rendered = 0;
  const lists = { md: (page, label) => readMd(page, label).codes, html: codesOfHtml };
  for (const [place, put] of Object.entries(PLACES)) {
    for (const [name, value] of Object.entries(HOSTILE)) {
      const statement = variant('hostile', (p) => put(p, value));
      const held = new Set();
      put(clone(statement).predicate, value);
      for (const lang of LANGS) {
        for (const [format, render] of [['md', md], ['html', html]]) {
          const label = `${name} in ${place}, ${lang} ${format}`;
          const page = render(statementAlone(statement), { lang });
          rendered += 1;
          assert.doesNotMatch(page.replaceAll('\u00A0', ''), HIDDEN, `${label}: nothing hidden reaches the reader`);
          const codes = lists[format](page, label);
          // the text itself is there, whole (or its first part, where the place or the format cuts it)
          const shown = visible(place.endsWith('version') || ['receipt.shell', 'receipt.signal'].includes(place) ? [...value].slice(0, place.endsWith('version') ? 30 : 15).join('') : value);
          const undo = (text) => (format === 'md' ? text.replaceAll('⟦U+005C⟧', '\\') : text);
          assert.ok(codes.some((text) => undo(text) === shown || (text === ' ' && shown === '')), `${label}: the text is shown as ${JSON.stringify(shown)}\n${JSON.stringify(codes.slice(0, 40))}`);
          held.add(format);
          // a consumer that normalises the bytes to NFC changes no structure
          if (name === 'normalises' || name === 'leadingMark' || name === 'markers') lists[format](page.normalize('NFC'), `${label}, normalised`);
        }
      }
      assert.equal(held.size, 2);
    }
  }
  // the caller's own texts: the source of a rate
  for (const [name, value] of Object.entries(HOSTILE)) {
    for (const [format, render] of [['md', md], ['html', html]]) {
      const page = render(sourceOf('evidenced'), { vnd: { rate: '25400', date: '2026-11-20', source: value } });
      lists[format](page, `${name} as the source of a rate, ${format}`);
      assert.doesNotMatch(page.replaceAll('\u00A0', ''), HIDDEN);
    }
  }
  // the hostile pack itself: its golden reports, read
  for (const lang of LANGS) {
    const { pieces, attributes } = readHtml(html(sourceOf('hostile'), { lang }), `hostile ${lang}`);
    assert.ok(pieces.some((piece) => piece.tag === 'code' && piece.text === HOSTILE.script), 'the script tag of the fixture is a text');
    assert.deepEqual(attributes.filter(({ name }) => ['href', 'src', 'style', 'onerror'].includes(name)), [], 'no link, no load, no handler');
    const read = readMd(md(sourceOf('hostile'), { lang }), `hostile ${lang}`);
    assert.ok(read.codes.includes(HOSTILE.script) && read.codes.includes(HOSTILE.javascriptUrl) === false);
    assert.ok(read.codes.some((text) => text.includes('javascript:alert(1)')), 'the javascript: URL is a text in a code span');
    assert.ok(read.codes.includes('safe⟦U+202E⟧gpj.exe'), 'the bidi control of a path is a marker');
    assert.ok(read.codes.includes('tài liệu⟦U+0009⟧|`[x](y)⟦U+000A⟧.md'), 'a path with a tab, a pipe, a backtick, a link and a line end');
  }
  // diacritics come back as they went in, composed or not, in both formats
  const composed = 'Đặt lịch ở Thừa Thiên–Huế: ắ ằ ẳ ẵ ặ ố ồ ổ ỗ ộ ứ ừ ử ữ ự ỷ ỹ ỵ Đ ₫';
  for (const value of [composed, composed.normalize('NFD')]) {
    assert.ok(value !== composed || value === value.normalize('NFC'));
    const statement = variant('hostile', (p) => { p.receipts.at(-1).command = value; p.lockfiles[0].path = value; });
    for (const lang of LANGS) {
      assert.equal(readMd(md(statementAlone(statement), { lang }), 'diacritics').codes.filter((text) => text === value).length, 2, 'Markdown');
      assert.equal(codesOfHtml(html(statementAlone(statement), { lang }), 'diacritics').filter((text) => text === value).length, 2, 'HTML');
    }
  }
  ok(`${Object.keys(HOSTILE).length} hostile texts in ${Object.keys(PLACES).length} places, ${rendered} reports read back: only the report's own tags and words, each text whole; safe after NFC; diacritics round trip`);
}

// =====================================================================================================================
// 8. the HTML page
// =====================================================================================================================
{
  const page = html(sourceOf('hostile'), { lang: 'vi' });
  const { pieces, attributes } = readHtml(page, 'the page');
  const styles = pieces.filter((piece) => piece.tag === 'style');
  assert.equal(styles.length, 1, 'one style element');
  assert.equal(styles[0].text, STYLE);
  const digest = createHash('sha256').update(STYLE, 'utf8').digest('base64');
  const policy = attributes.find(({ name, value }) => name === 'content' && value.includes('default-src')).value;
  assert.equal(policy, CSP);
  const directives = Object.fromEntries(CSP.split('; ').map((part) => [part.split(' ')[0], part.split(' ').slice(1).join(' ')]));
  assert.deepEqual(directives, { 'default-src': "'none'", 'script-src': "'none'", 'style-src': `'sha256-${digest}'`, 'img-src': "'none'", 'font-src': "'none'", 'connect-src': "'none'", 'object-src': "'none'", 'frame-src': "'none'", 'base-uri': "'none'", 'form-action': "'none'" });
  const order = ['<meta charset="utf-8">', '<meta http-equiv="Content-Security-Policy"', '<title>', '<style>', '<body>'].map((mark) => page.indexOf(mark));
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), 'the policy stands before anything it governs');
  assert.ok(order[0] < 1024, 'the charset is in the first 1,024 bytes');
  assert.ok(page.includes('<meta name="referrer" content="no-referrer">'));
  assert.doesNotMatch(STYLE, /url\(|@import|expression|https?:|\/\//i, 'the style loads nothing');
  assert.match(STYLE, /@media print/);
  assert.match(STYLE, /prefers-color-scheme: dark/);
  assert.match(STYLE, /unicode-bidi: isolate/, 'a text of the pack does not reorder what stands around it');
  assert.doesNotMatch(page, /<(?:script|link|img|iframe|object|embed|form|input|a|base|svg)\b/i);
  assert.equal([...page.matchAll(/<th /g)].length, [...page.matchAll(/<th scope="(?:col|row)">/g)].length, 'every table head says what it heads');
  ok('the page: one file, one style named by its hash in a policy that forbids scripts and every load, a print style sheet, heads with a scope');
}

// =====================================================================================================================
// 9. determinism
// =====================================================================================================================
{
  const reversed = (value) => (Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)])) : value);
  const baseline = PACKS.flatMap((name) => LANGS.flatMap((lang) => [md(sourceOf(name), { lang, ...REPORT_OPTIONS[name] }), html(sourceOf(name), { lang, ...REPORT_OPTIONS[name] })]));
  const saved = { Date: globalThis.Date, Intl: globalThis.Intl, toLocale: Number.prototype.toLocaleString, compare: String.prototype.localeCompare, random: Math.random, lower: String.prototype.toLocaleLowerCase };
  const refuse = (what) => function refused() { throw new Error(`${what} is not deterministic`); };
  let again;
  try {
    globalThis.Date = class { constructor() { throw new Error('a clock'); } static now() { throw new Error('a clock'); } };
    globalThis.Intl = undefined;
    Number.prototype.toLocaleString = refuse('toLocaleString');
    String.prototype.localeCompare = refuse('localeCompare');
    String.prototype.toLocaleLowerCase = refuse('toLocaleLowerCase');
    Math.random = refuse('Math.random');
    again = PACKS.flatMap((name) => LANGS.flatMap((lang) => {
      const source = { ...sourceOf(name), statement: reversed(READ[name].statement) };
      return [md(source, { lang, ...REPORT_OPTIONS[name] }), html(source, { lang, ...REPORT_OPTIONS[name] })];
    }));
  } finally {
    globalThis.Date = saved.Date;
    globalThis.Intl = saved.Intl;
    Number.prototype.toLocaleString = saved.toLocale;
    String.prototype.localeCompare = saved.compare;
    String.prototype.toLocaleLowerCase = saved.lower;
    Math.random = saved.random;
  }
  assert.deepEqual(again, baseline, 'the same bytes without a clock, a locale or an order of keys');
  // the report does not change what it is given
  const statement = clone(READ.hostile.statement);
  md(statementAlone(statement));
  assert.deepEqual(statement, READ.hostile.statement);
  ok('the same bytes with the clock, Intl and the locale functions broken, and whatever the key order; the statement is not changed');
}

// =====================================================================================================================
// 10. the Markdown cap
// =====================================================================================================================
{
  assert.equal(MD_MAX_CHARS, 65_000);
  assert.ok(MD_MAX_CHARS < 65_536, 'under the limit of a pull request comment');
  const small = renderMarkdown(report(sourceOf('evidenced')));
  assert.equal(small.truncated, false);
  assert.doesNotMatch(small.text, says('md.truncated'));
  // as much as a statement can hold: 100 criteria of 20 checks, long hostile commands, a thousand other receipts, 500 uncertain events
  const big = variant('hostile', (p) => {
    const long = `${HOSTILE.controls}${HOSTILE.tableLine}${'`|\\'.repeat(2600)}`.slice(0, 8192);
    const unrun = p.criteria.find(({ id }) => id === 'unrun');
    const link = p.criteria.find(({ id }) => id === 'link');
    const other = p.receipts.at(-1);
    p.criteria = [p.criteria[0], ...Array.from({ length: 98 }, (_, i) => ({
      ...clone(unrun), id: `c${i}`, checks: Array.from({ length: 20 }, (__, index) => ({ ...clone(unrun.checks[0]), index, run: long })), reasons: Array.from({ length: 20 }, (__, index) => ({ code: 'check_not_run', check: index, detail: 'd'.repeat(600) })),
    })), { ...clone(link), omittedReasons: 5, reasons: Array.from({ length: PACK_LIMITS.maxReasons }, (_, i) => ({ code: 'checks_modified', check: null, detail: `x ${'`'.repeat(i + 1)}${'é'.repeat(400)}` })) }];
    const listed = p.receipts.filter(({ seq }) => p.criteria.some((criterion) => criterion.checks.some((check) => check.receipts.includes(seq))));
    p.receipts = [...listed, ...Array.from({ length: 1000 }, (_, i) => ({ ...clone(other), seq: 1000 + i, command: long }))];
    p.uncertain = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, reason: 'torn_tail' }));
    p.lockfiles = Array.from({ length: 2000 }, (_, i) => ({ path: `${i}${'p'.repeat(1000)}`, status: 'modified', sha256Before: null, sha256After: null }));
  });
  for (const lang of LANGS) {
    const { text: body, truncated } = renderMarkdown(buildReport(statementAlone(big), { lang, packName: 'big.pack.json', vnd: { rate: '25400', date: '2026-11-20', source: 'x'.repeat(200) } }));
    assert.equal(truncated, true);
    assert.ok(body.length <= MD_MAX_CHARS, `${body.length} characters`);
    assert.ok(body.length > MD_MAX_CHARS * 0.95, `the room is used: ${body.length}`);
    const read = readMd(body, `the capped report, ${lang}`); // whole lines only: every span and every row still reads
    assert.ok(body.split('\n').slice(0, 6).some((line) => says('md.truncated', lang).test(line)), 'the note stands at the top, where a reader sees it');
    assert.match(body, says('verdict.failed', lang), 'the verdict is there');
    assert.deepEqual(read.fenced[0], 'chatmcp verify check big.pack.json', 'and how to verify');
    assert.deepEqual([...body.matchAll(/^### (.+)$/gm)].map((match) => match[1]), SECTIONS.map((id) => DICTIONARY[lang][`section.${id}`]), 'every section');
    // what was left out is counted, and the counts add up
    const left = [...body.matchAll(new RegExp(mdText(DICTIONARY[lang]['md.rows_left']).replace(/\\?\{n\\?\}/, '([0-9.,]+)').replace(/[()](?!\[)/g, (c) => c), 'g'))];
    assert.ok(left.length >= 4, `several sections say how many rows are not shown: ${left.length}`);
    const lockRows = [...body.matchAll(/^\| `[0-9]+p+`/gm)].length;
    assert.ok(lockRows > 0, 'a section in the middle still shows some of its rows');
    const lockLeft = Number(sectionOf(body, 'section.tamper', lang).match(new RegExp(mdText(DICTIONARY[lang]['md.rows_left']).split(/\\?\{n\\?\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([0-9.,]+)'), 'g')).at(-1).match(/[0-9][0-9.,]*/)[0].replace(/[.,]/g, ''));
    assert.equal(lockRows + lockLeft, 2000, 'the rows shown and the rows left out');
    const page = renderHtml(buildReport(statementAlone(big), { lang })).text;
    assert.equal([...page.matchAll(/<tr>/g)].length > 4000, true, 'the HTML page is not capped');
    assert.ok(!page.includes(DICTIONARY[lang]['md.truncated'].split('{')[0]));
  }
  // a lower cap, at its edge: the whole report when it just fits, one character less and it is cut
  const whole = md(sourceOf('hostile'));
  assert.equal(renderMarkdown(report(sourceOf('hostile')), { maxChars: whole.length }).text, whole);
  const less = renderMarkdown(report(sourceOf('hostile')), { maxChars: whole.length - 1 });
  assert.equal(less.truncated, true);
  assert.ok(less.text.length < whole.length);
  readMd(less.text, 'one character less');
  for (const maxChars of [0, 11_999, MD_MAX_CHARS + 1, 1.5, '65000', NaN]) assert.throws(() => renderMarkdown(report(sourceOf('evidenced')), { maxChars }), RenderError, `maxChars ${maxChars}`);
  const least = renderMarkdown(buildReport(statementAlone(big), { lang: 'vi' }), { maxChars: 12_000 });
  assert.ok(least.text.length <= 12_000 && least.truncated, 'the least cap still holds');
  readMd(least.text, 'the least cap');
  // a long text is cut in Markdown only, and says so
  const long = variant('hostile', (p) => { p.receipts.at(-1).command = 'y'.repeat(2000); });
  assert.match(md(statementAlone(long)), /`y{300}` \(.*2,000.*\)/);
  assert.ok(codesOfHtml(html(statementAlone(long)), 'long').includes('y'.repeat(2000)));
  ok(`the Markdown cap: at most ${MD_MAX_CHARS} characters, whole rows, the note, the verdict and how to verify kept, rows left out counted; the edge of a cap; the page has none`);
}

// =====================================================================================================================
// 11. the command
// =====================================================================================================================
{
  const outputSchema = compileSchema(CLI_OUTPUT_SCHEMA);
  const showSchema = compileSchema(CLI_DATA_SCHEMAS.show);
  const run = async (args, { cwd = SCRATCH, env = {} } = {}) => {
    const sink = () => { const chunks = []; return { chunks, write: (chunk, done) => { chunks.push(Buffer.from(chunk)); done?.(); }, get text() { return Buffer.concat(chunks).toString('utf8'); } }; };
    const stdout = sink();
    const stderr = sink();
    const status = await main(args, { stdout, stderr, cwd, env: { ...process.env, CHATMCP_STATE_DIR: path.join(SCRATCH, 'state'), ...env } });
    return { status, stdout: stdout.text, stderr: stderr.text };
  };
  const ask = async (args, options) => {
    const result = await run([...args, '--json'], options);
    const answer = JSON.parse(result.stdout);
    const where = `${args.join(' ')}: ${result.stdout.slice(0, 1500)}`;
    assert.ok(outputSchema.validate(answer).valid, where);
    if (answer.data !== null) { const data = showSchema.validate(answer.data); assert.ok(data.valid, `${where}\n${JSON.stringify(data.errors.slice(0, 4))}`); }
    assert.equal(result.status, answer.exitCode, where);
    assert.equal(EXIT[CODES[answer.code]], answer.exitCode, where);
    assert.equal(result.stderr, '', where);
    return answer;
  };
  const expectAnswer = (answer, exitCode, code, label) => assert.deepEqual([answer.exitCode, answer.code], [exitCode, code], `${label}: ${JSON.stringify(answer).slice(0, 600)}`);
  const file = path.join(SCRATCH, 'hostile.pack.json');
  fs.copyFileSync(packFile('hostile'), file);
  fs.copyFileSync(packFile('evidenced'), path.join(SCRATCH, 'evidenced.pack.json'));
  const golden = (name, lang, format) => fs.readFileSync(goldenFile(name, lang, format), 'utf8');

  // stdout is exactly the report
  const plain = await run(['verify', 'show', '--pack', 'hostile.pack.json']);
  assert.deepEqual([plain.status, plain.stderr], [0, '']);
  assert.equal(plain.stdout, golden('hostile', 'en', 'md'), 'Markdown in English unless told otherwise');
  for (const lang of LANGS) for (const format of ['md', 'html']) assert.equal((await run(['verify', 'show', '--pack', file, '--format', format, '--lang', lang])).stdout, golden('hostile', lang, format), `${lang} ${format}`);
  const rate = ['--vnd-rate', '25400', '--vnd-rate-date', '2026-11-20', '--vnd-rate-source', REPORT_OPTIONS.evidenced.vnd.source];
  assert.equal((await run(['verify', 'show', '--pack', 'evidenced.pack.json', '--lang', 'vi', ...rate])).stdout, golden('evidenced', 'vi', 'md'));

  // --json: the report in the answer, or its file
  const answer = await ask(['verify', 'show', '--pack', 'hostile.pack.json', '--format', 'html', '--lang', 'vi']);
  expectAnswer(answer, 0, 'report_printed', 'show --pack --json');
  assert.deepEqual(answer.data, {
    pack: { file, digest: READ.hostile.digest }, format: 'html', verdict: 'failed', truncated: false, out: null, bytes: Buffer.byteLength(golden('hostile', 'vi', 'html')), sha256: sha256(golden('hostile', 'vi', 'html')),
    text: golden('hostile', 'vi', 'html'),
  });
  assert.equal(answer.workspace, null, 'no workspace is read');
  const before = fs.readdirSync(SCRATCH).sort();
  const written = await ask(['verify', 'show', '--pack', 'hostile.pack.json', '--format', 'html', '--out', 'report.html']);
  expectAnswer(written, 0, 'report_written', '--out');
  const out = path.join(SCRATCH, 'report.html');
  assert.deepEqual([written.data.out, written.data.text, written.data.sha256], [out, null, sha256(fs.readFileSync(out))]);
  assert.equal(fs.readFileSync(out, 'utf8'), golden('hostile', 'en', 'html'));
  assert.deepEqual(fs.readdirSync(SCRATCH).sort(), [...before, 'report.html'].sort(), 'nothing else is written, no state folder is made');
  // never over a file: not another report, not the pack
  fs.writeFileSync(path.join(SCRATCH, 'mine.txt'), 'mine');
  expectAnswer(await ask(['verify', 'show', '--pack', 'hostile.pack.json', '--out', 'mine.txt']), 1, 'report_exists', 'a file that is there');
  assert.equal(fs.readFileSync(path.join(SCRATCH, 'mine.txt'), 'utf8'), 'mine');
  expectAnswer(await ask(['verify', 'show', '--pack', 'hostile.pack.json', '--out', 'hostile.pack.json']), 1, 'report_exists', 'the pack itself');
  assert.ok(fs.readFileSync(file).equals(fs.readFileSync(packFile('hostile'))));
  fs.mkdirSync(path.join(SCRATCH, 'folder'));
  expectAnswer(await ask(['verify', 'show', '--pack', 'hostile.pack.json', '--out', 'folder']), 1, 'report_exists', 'a folder');
  expectAnswer(await ask(['verify', 'show', '--pack', 'hostile.pack.json', '--out', path.join('missing', 'x.md')]), 4, 'io_error', 'a folder that is not there');
  for (const lang of LANGS) {
    const human = await run(['verify', 'show', '--pack', 'evidenced.pack.json', '--out', `human.${lang}.md`, '--lang', lang]);
    assert.equal(human.status, 0);
    assert.ok(human.stdout.includes(path.join(SCRATCH, `human.${lang}.md`)) && human.stderr === '', human.stdout);
  }

  // a pack that does not verify renders nothing
  const bytes = fs.readFileSync(file);
  const edited = Buffer.from(bytes.toString('utf8').replace('"exit":1', '"exit":0'));
  fs.writeFileSync(path.join(SCRATCH, 'edited.pack.json'), edited);
  const refused = await ask(['verify', 'show', '--pack', 'edited.pack.json', '--out', 'edited.md']);
  expectAnswer(refused, 3, 'pack_digest_mismatch', 'a changed pack');
  assert.equal(fs.existsSync(path.join(SCRATCH, 'edited.md')), false);
  const refusedText = await run(['verify', 'show', '--pack', 'edited.pack.json']);
  assert.deepEqual([refusedText.status, refusedText.stdout], [3, ''], 'nothing on stdout that could be taken for a report');
  fs.writeFileSync(path.join(SCRATCH, 'statement.json'), `${canonicalJson(READ.hostile.statement)}\n`);
  expectAnswer(await ask(['verify', 'show', '--pack', 'statement.json']), 3, 'pack_unreadable', 'a statement alone');
  expectAnswer(await ask(['verify', 'show', '--pack', 'nowhere.json']), 2, 'bad_pack', 'no file');

  // the command line
  for (const [args, code] of [
    [['verify', 'show', '--format', 'md'], 'missing_argument'], [['verify', 'show', '--out', 'x.md'], 'missing_argument'], [['verify', 'show', ...rate], 'missing_argument'],
    [['verify', 'show', '--pack', ''], 'bad_value'], [['verify', 'show', '--pack'], 'missing_value'], [['verify', 'show', '--pack', file, '--format', 'pdf'], 'bad_value'], [['verify', 'show', '--pack', file, '--out', ''], 'bad_value'],
    [['verify', 'show', '--pack', file, '--vnd-rate', '25400'], 'missing_argument'], [['verify', 'show', '--pack', file, '--vnd-rate', '25400', '--vnd-rate-date', '2026-11-20'], 'missing_argument'],
    [['verify', 'show', '--pack', file, '--vnd-rate-date', '2026-11-20', '--vnd-rate-source', 'x'], 'missing_argument'], [['verify', 'show', '--pack', file, ...rate.with(1, '25,400')], 'bad_value'],
    [['verify', 'show', '--pack', file, ...rate.with(3, '2026-02-30')], 'bad_value'], [['verify', 'show', '--pack', file, ...rate.with(5, ' ')], 'bad_value'], [['verify', 'show', '--pack', file, 'extra'], 'unexpected_argument'],
    [['verify', 'check', file, '--format', 'md'], 'unknown_option'], [['verify', 'show', '--pack', file, '--pack', file], 'repeated_option'],
  ]) {
    const result = await ask(args);
    expectAnswer(result, 2, code, args.join(' '));
  }
  const missing = await ask(['verify', 'show', '--pack', file, '--vnd-rate', '25400']);
  assert.deepEqual(missing.detail, { command: 'show', argument: '--vnd-rate-date' });
  assert.equal((await ask(['verify', 'show', '--format', 'md'])).detail.argument, '--pack');
  assert.match((await run(['verify', 'show', '--format', 'md'])).stderr, /chatmcp verify show --pack <pack>/);
  assert.match((await run(['verify', 'show', '--format', 'md', '--lang', 'vi'])).stderr, /chatmcp verify show --pack <gói>/);
  // without --pack it is the session, as before
  expectAnswer(await ask(['verify', 'show'], { cwd: path.join(SCRATCH, 'folder'), env: { CHATMCP_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'proof-render-state-')) } }), 2, 'no_session', 'show');

  // the real program, as a person runs it, in a console of another language
  const spawned = spawnSync(process.execPath, [BIN, 'verify', 'show', '--pack', file, '--format', 'html', '--lang', 'vi'], { cwd: SCRATCH, env: { ...process.env, LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', TZ: 'Asia/Ho_Chi_Minh' }, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  assert.deepEqual([spawned.status, spawned.stderr.toString()], [0, '']);
  assert.ok(spawned.stdout.equals(fs.readFileSync(goldenFile('hostile', 'vi', 'html'))), 'byte for byte the golden report');

  // the docs
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'PROOF-RENDER.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(fs.readFileSync(path.join(REPO, 'docs', 'INDEX.md'), 'utf8'), /\]\(PROOF-RENDER\.md\)/, 'docs/INDEX.md links docs/PROOF-RENDER.md');
  for (const phrase of ['--vnd-rate', '65,000', 'Content-Security-Policy', 'NFC', 'not recorded in this pack', ...VERDICTS.map((value) => `\`${value}\``), ...SECTIONS.map((id) => EN[`section.${id}`])]) assert.ok(doc.includes(phrase), `the doc mentions ${phrase}`);
  const cliDoc = fs.readFileSync(path.join(REPO, 'docs', 'PROOF-CLI.md'), 'utf8');
  for (const phrase of ['show --pack', '--format md|html', '--out', '--vnd-rate-source', 'PROOF-RENDER.md']) assert.ok(cliDoc.includes(phrase), `docs/PROOF-CLI.md mentions ${phrase}`);
  ok('chatmcp verify show --pack: both formats and languages, --out never over a file, --json, the rate, every usage error, a pack that does not verify renders nothing; the program itself; the docs');
}

console.log(`verify-proof-render: ${checks} checks passed in ${elapsed()}`);
