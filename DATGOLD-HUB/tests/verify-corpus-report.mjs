// The report of the Proof-of-Done benchmark corpus (plan task P7 pod-39, corpus/REPORT.md): corpus/tools/report.mjs turns the corpus, the
// folder of run packs and results.jsonl into one Markdown report and one static HTML site, in English and in Vietnamese.
//
// EVERY NUMBER HERE IS SYNTHETIC. No agent, no model and no paid call ran; the agents are agent-a, agent-b, ... What it proves:
//   1. the dictionaries: the same keys and placeholders, NFC, no markup, a text for every code; a lint that refuses wording no measurement
//      supports (proven safe, best, winner, outperforms, ... and the Vietnamese), over both dictionaries and over every page's own words;
//   2. numbers: percentages and money without a locale, a rate only as k/n with its Wilson interval, no rate for n = 0;
//   3. the golden report, byte for byte, in both languages and both formats; what stands in it against metrics.mjs;
//   4. the recompute: results.jsonl is refused when one byte of it is not what the packs give; every other refusal, each with its code, and
//      none leaves anything behind;
//   5. links: every href of every page, with its anchor; every pack once per language with the sha256 of the file it links;
//   6. the page: a policy that forbids scripts and every load, one style named by its hash, only the report's own tags;
//   7. the banner on every page of what is not registered, and on none of what is, with a real freeze and its tag in a temporary repository;
//   8. the kill rule: the registered consequence only for the registered run set, complete; undecided; every reason it is not applied;
//   9. edge sets: no run, one run, one agent, no claim, every cost unknown, 0 of n and n of n, an agent or a task without a run;
//  10. order: ids, never a result; no comparison;
//  11. hostile texts in every field, both formats, both languages, read back; ids that would leave the folder;
//  12. determinism: other names, another order, another process, time zone, locale and folder, no clock; the published folder makes itself again;
//  13. a large set (200 tasks, 10 agents); 14. a write that fails; 15. the command line; 16. the documents.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let checks = 0;
const suiteStart = performance.now();
const ok = (label) => { checks += 1; console.log(`  ok - ${label} [${((performance.now() - suiteStart) / 1000).toFixed(1)} s]`); };
setTimeout(() => { console.error('FAIL: the corpus report suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The corpus stands beside the Hub: in the repository, and in a copy the mutation runner makes (tests/mutation/corpus-report.json).
const CORPUS = path.resolve(HUB, '..', 'corpus');
if (!existsSync(CORPUS) && !existsSync(path.join(HUB, '..', 'README.md'))) {
  console.log('CHATMCP_TEST_SKIP: corpus/ was not found next to DATGOLD-HUB (the corpus tools need the whole repository)');
  process.exit(0);
}
// Under the mutation runner the Hub is a copy without the repository around it; the runner says where it came from.
const REPO = path.resolve(process.env.CHATMCP_MUTATION_SOURCE ? path.resolve(process.env.CHATMCP_MUTATION_SOURCE) : HUB, '..');
const fixture = await import('./fixtures/corpus-report/fixture.mjs');
const { agentPack, controlPack, controlsOf, fullRuns, packFiles, proofPack, scored, sha256, importTool, listFiles, isGolden, goldenPacks, goldenInput, GOLDEN, GOLDEN_AGENTS, GOLDEN_RESPONSE, EXAMPLES } = fixture;
const { HOSTILE } = await import('./fixtures/proof-render/fixture.mjs');
const { visible } = await import(pathToFileURL(path.join(HUB, 'lib', 'proof', 'render', 'text.mjs')).href);
const report = await importTool('report.mjs');
const { ReportError, WORDS, LANGS, translate, percent, fixed, rateNodes } = await importTool('report-text.mjs');
const { BANNER_REASONS, KILL_REASONS } = await importTool('report-model.mjs');
const { PAGE_CSP, PAGE_STYLE } = await importTool('report-html.mjs');
const { loadCorpus } = await importTool('load.mjs');
const { runPackBytes } = await importTool('score.mjs');
const { computeMetrics, rateOf, readResults } = await importTool('metrics.mjs');
const { KILL_RULE, METRICS, PROTOCOL } = await importTool('protocol.mjs');
const { OUTCOMES } = await importTool('score-checkout.mjs');
const { MARKER_CONTRACT } = await importTool('marker.mjs');
const { code, text } = await importTool('render.mjs');

const ROOT = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'datgold-corpus-report-')));
const REPORT = path.join(CORPUS, 'tools', 'report.mjs');
const HOME = path.join(ROOT, 'home');
await fs.mkdir(HOME);
await fs.writeFile(path.join(HOME, 'empty.gitconfig'), '');
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
  HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(HOME, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: path.dirname(ROOT),
};
const node = (script, args, { env = ENV, cwd = ROOT } = {}) => spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
function git(cwd, args, { allowFail = false, input } = {}) {
  const result = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true, input });
  if (!allowFail && result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}
let folders = 0;
const newFolder = async (name) => { const folder = path.join(ROOT, `${name}-${(folders += 1)}`); await fs.mkdir(folder); return folder; };

const { tasks: EXAMPLE_TASKS } = await loadCorpus(EXAMPLES);
// Two tasks that are not examples: copies of the example tasks under other ids and tags, in a folder of their own.
const ALPHA_CORPUS = path.join(ROOT, 'alpha-repo', 'corpus');
for (const [from, to] of [['example-slugify', 'alpha'], ['example-sum', 'beta']]) {
  const folder = path.join(ALPHA_CORPUS, 'tasks', to);
  await fs.mkdir(folder, { recursive: true });
  for (const name of readdirSync(path.join(EXAMPLES, 'tasks', from))) await fs.copyFile(path.join(EXAMPLES, 'tasks', from, name), path.join(folder, name));
  const yml = path.join(folder, 'task.yml');
  const hidden = sha256(`hidden archive of ${to}`);
  await fs.writeFile(yml, readFileSync(yml, 'utf8').replace(`id: ${from}`, `id: ${to}`).replace('  - example\n', '').replace(/sha256: [0-9a-f]{64}\nallowed_paths/, `sha256: ${hidden}\nallowed_paths`));
}
const { tasks: TASKS, errors: TASK_ERRORS } = await loadCorpus(ALPHA_CORPUS);
assert.deepEqual([TASK_ERRORS, TASKS.map((task) => task.id)], [[], ['alpha', 'beta']]);

const AGENTS = ['agent-a', 'agent-b'].map((id) => ({ id, cli: `${id} run`, version: '0.0.0-synthetic' }));
const registrationOf = (tasks, agents = AGENTS) => report.readRegistration({ bytes: Buffer.from(report.registrationText({ tasks, agents, corpus: { path: 'corpus', commit: '4'.repeat(40) }, scoringCode: null })), tasks });
const TAG = { name: 'prereg-test', object: '5'.repeat(40), time: 1_700_000_000, signed: false };
const registered = (tasks, agents = AGENTS) => ({ ...registrationOf(tasks, agents), tag: TAG });
/** The data of a report of synthetic packs, without a folder. */
const dataOf = (tasks, packs, { registration = null, responses = new Map(), date = null } = {}) => {
  const files = packFiles(packs);
  return report.readData({ tasks, jsonl: scored(tasks, packs).jsonl, packs: files.map((file) => file.bytes), registration, responses, date });
};
const filesOf = (tasks, packs, options) => report.renderFiles(dataOf(tasks, packs, options));

// What may never reach a reader as itself, written apart from the code under test (as in verify-proof-render).
const HIDDEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u1680\u2000-\u200F\u2028-\u202F\u205F-\u206F\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB\uFFFE\uFFFF\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/u;

// =====================================================================================================================
// the independent readers
// =====================================================================================================================
const VOID = new Set(['meta', 'br']);
const TAGS = {
  html: ['lang'], head: [], meta: ['charset', 'http-equiv', 'content', 'name'], title: [], style: [], body: [], header: [], main: [], footer: [], nav: ['aria-label'], aside: ['class', 'role'], section: ['id'],
  h1: [], h2: [], p: ['class'], ul: [], li: [], table: ['class'], thead: [], tbody: [], tr: ['id'], th: ['scope'], td: [], code: ['class', 'title'], pre: ['class'], span: ['class'], div: ['class'], a: ['href', 'lang', 'hreflang'], br: [], strong: [],
};
const CLASSES = new Set(['banner', 'verdict pass', 'verdict warn', 'verdict fail', 'note', 'scroll', 'facts', 'wide', 'word', 'verbatim', 'chip held', 'chip false', 'chip plain', 'chip error', 'chip gap']);
const unescapeHtml = (value) => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]);

/** Reads a page with no tolerance: only the tags and attributes above, balanced, every `&` one of five entities. */
function readHtml(page, label) {
  const bad = (why, at) => assert.fail(`${label}: ${why} at ${at}: ${JSON.stringify(page.slice(Math.max(0, at - 60), at + 120))}`);
  const open = [];
  const pieces = []; // {tag, tags, text}: the decoded text of each run, with the tags around it, innermost last
  const ids = [];
  const links = [];
  const attributes = [];
  const prefix = '<!doctype html>\n';
  assert.ok(page.startsWith(prefix), `${label}: the page starts with its doctype`);
  let at = prefix.length;
  while (at < page.length) {
    if (page[at] !== '<') {
      const end = page.indexOf('<', at);
      const raw = page.slice(at, end < 0 ? page.length : end);
      if (open.at(-1) === 'style') pieces.push({ tag: 'style', tags: [...open], text: raw });
      else {
        if (/&(?!(?:amp|lt|gt|quot|#39);)/.test(raw) || /[>"']/.test(raw)) bad('an unescaped character in text', at);
        pieces.push({ tag: open.at(-1) ?? null, tags: [...open], text: unescapeHtml(raw) });
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
      if (name === 'id') { if (!/^[a-z0-9-]+$/.test(value)) bad(`an id that is not the report's (${value})`, at); ids.push(value); }
      if (name === 'href') links.push({ href: value, row: null });
      if (name === 'title' && !/^[0-9a-f]{40,64}$/.test(value)) bad(`a title that is not a whole id (${value})`, at);
    }
    if (!VOID.has(tag)) open.push(tag);
    at += whole.length;
  }
  assert.deepEqual(open, [], `${label}: every tag is closed`);
  assert.equal(new Set(ids).size, ids.length, `${label}: every id once`);
  return { pieces, attributes, ids, links };
}
/** Splits a GFM table row into cells, the way cmark-gfm scans it. */
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
// Outside code spans: the report's own words.
const OUTSIDE = /^[\p{L}\p{M}\p{N} \u0001.,:;()/%+=×÷≈–—→…“”'"?·\-]*$/u;
/** Reads a Markdown report: headings, paragraphs, lists, tables, fenced blocks and links. */
function readMd(body, label) {
  const codes = [];
  const outside = [];
  const fenced = [];
  const links = [];
  const rows = [];
  let fence = 0;
  let block = null;
  let columns = 0;
  const prose = (value, where) => {
    const read = inline(value);
    codes.push(...read.codes);
    const found = [];
    const plain = read.outside.replace(/(?<!\\)\[([^[\]\\]*)\]\(([^()\s]*)\)/g, (_, words, target) => { found.push(target); return words; })
      .replace(/\\([!-/:-@[-`{-~])/g, (_, char) => (/[<>[\]`|*_~&@#!]/.test(char) ? (/[<>]/.test(char) ? ' ' : '\u0002') : char)).replaceAll('**', '');
    assert.match(plain, OUTSIDE, `${where}\noutside code spans there are only the report's own words: ${JSON.stringify(plain)}`);
    outside.push(plain);
    links.push(...found.map((target) => ({ target, where })));
    return { plain, codes: read.codes, links: found };
  };
  for (const [index, line] of body.split('\n').entries()) {
    const where = `${label} line ${index + 1}: ${line.slice(0, 300)}`;
    if (fence) {
      const closing = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
      if (closing && closing[1].length >= fence) { fence = 0; fenced.push(block.join('\n')); } else block.push(line);
      continue;
    }
    const opening = /^(`{3,})text$/.exec(line);
    if (opening) { fence = opening[1].length; block = []; continue; }
    assert.doesNotMatch(line, /^(?: {4}|\t| *>|~~~|```|===|---| *#{4,} )/, `${where}\nno block but the report's`);
    if (line.startsWith('|')) {
      if (/^\|(?: --- \|)+$/.test(line)) { assert.equal(line.split('---').length - 1, columns, `${where}\nthe delimiter row fits the head`); continue; }
      const cells = cellsCmark(line);
      assert.deepEqual(cellsMarkdownIt(line), cells, `${where}\ntwo table readers see the same cells`);
      if (columns === 0) columns = cells.length;
      assert.equal(cells.length, columns, `${where}\nevery row has ${columns} cells`);
      rows.push(cells.map((cell) => prose(cell, where)));
      continue;
    }
    columns = 0;
    prose(line.replace(/^#{1,3} /, '').replace(/^- /, ''), where);
  }
  assert.equal(fence, 0, `${label}: every fenced block is closed`);
  return { codes, fenced, rows, links, outside };
}

/** Every page of a report read, with every link followed: to a file of `present`, with its anchor. Returns {pages, reports}. */
function checkSite(files, present, label) {
  const pages = new Map();
  const reports = new Map();
  for (const [name, body] of files) {
    assert.doesNotMatch(body.replaceAll('\u00A0', ''), HIDDEN, `${label} ${name}: nothing hidden reaches the reader`);
    assert.ok(body.endsWith('\n') && !body.endsWith('\n\n') && !body.includes('\r'), `${label} ${name}: LF, one at the end`);
    if (name.endsWith('.html')) pages.set(name, readHtml(body, `${label} ${name}`)); else reports.set(name, readMd(body, `${label} ${name}`));
  }
  const follow = (from, target) => {
    const where = `${label} ${from} -> ${target}`;
    assert.match(target, /^(?:\.\.\/)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*(?:#[a-z0-9-]+)?$|^#[a-z0-9-]+$/, `${where}: a relative link of plain characters`);
    const [file, anchor] = target.split('#');
    const resolved = file === '' ? from : path.posix.normalize(path.posix.join(path.posix.dirname(from), file));
    assert.ok(!resolved.startsWith('..') && !path.posix.isAbsolute(resolved), `${where}: stays inside the report`);
    assert.ok(present.has(resolved), `${where}: the file exists`);
    if (anchor !== undefined) assert.ok(pages.get(resolved)?.ids.includes(anchor), `${where}: the anchor exists`);
    return resolved;
  };
  let followed = 0;
  for (const [name, page] of pages) for (const link of page.links) { link.to = follow(name, link.href); followed += 1; }
  for (const [name, read] of reports) for (const link of read.links) { link.to = follow(name, link.target); followed += 1; }
  return { pages, reports, followed };
}
/** The files a report of `data` consists of, beside its pages. */
const copiesOf = (data) => new Set([...data.runs.values()].map((run) => run.file).concat(['results.jsonl'], data.registration ? ['preregistration.json'] : [], [...data.responses.keys()].map((agent) => `responses/agent-${agent}.txt`)));
function readSite(data, label) {
  const files = report.renderFiles(data);
  return { files, ...checkSite(files, new Set([...files.keys(), ...copiesOf(data)]), label) };
}
/** The words a person reads on a page, code left out. */
const wordsOf = (page) => page.pieces.filter((piece) => !piece.tags.includes('code') && !piece.tags.includes('pre') && piece.tag !== 'style').map((piece) => piece.text).join('');
const textOf = (page) => page.pieces.filter((piece) => piece.tag !== 'style' && !piece.tags.includes('head')).map((piece) => piece.text).join('');
const codesOf = (page) => page.pieces.filter((piece) => piece.tag === 'code').map((piece) => piece.text);
const literal = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A pattern of a dictionary text: anything in place of its placeholders. */
const says = (key, lang = 'en') => { assert.ok(Object.hasOwn(WORDS[lang], key), `the dictionary has ${key}`); return new RegExp(WORDS[lang][key].split(/\{[a-zA-Z]+\}/).map(literal).join('[^]*?')); };

// =====================================================================================================================
// 1. the dictionaries
// =====================================================================================================================
// Wording no measurement of this kind supports. A rate on some tasks says nothing about safety, and the protocol defines no comparison; so
// these words are refused anywhere, a denial included ("no ranking" is written as what the report does instead).
const FORBIDDEN = {
  en: /\b(?:prov(?:e|es|ed|en|ing|ably)|guarantee\w*|certif\w*|safe\w*|unsafe|secure\w*|security|trust\w*|reliab\w*|best|better|worst|worse|win|wins|won|winn\w+|los(?:e|es|er|ers|ing|t)|beat\w*|outperform\w*|superior\w*|inferior\w*|rank\w*|leader\w*|leads?|leading|top|champion\w*|strong\w*|weak\w*|fastest|slowest|cheapest|highest|lowest|significant\w*|perfect\w*|flawless\w*|infallib\w*|unbeatable|state of the art)\b/iu,
  vi: /(?:an toàn|bảo mật|chứng minh|đảm bảo|bảo đảm|cam đoan|cam kết|đáng tin|tin cậy|chứng nhận|tốt nhất|tốt hơn|tồi nhất|tồi hơn|kém nhất|kém hơn|tệ nhất|tệ hơn|xấu nhất|xấu hơn|giỏi nhất|giỏi hơn|thắng|thua|vượt trội|vượt xa|áp đảo|đánh bại|xếp hạng|thứ hạng|hạng nhất|bảng hạng|dẫn đầu|đứng đầu|đứng nhất|hàng đầu|số một|quán quân|vô địch|ưu việt|mạnh nhất|mạnh hơn|yếu nhất|yếu hơn|nhanh nhất|chậm nhất|rẻ nhất|đắt nhất|cao nhất|thấp nhất|đáng kể|hoàn hảo|tuyệt đối|không thể sai)/iu,
};
{
  assert.deepEqual([...LANGS], ['en', 'vi']);
  assert.deepEqual(Object.keys(WORDS).sort(), ['en', 'vi']);
  assert.deepEqual(Object.keys(WORDS.vi), Object.keys(WORDS.en), 'the same keys in the same order in both languages');
  const slots = (value) => [...value.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]).sort();
  for (const lang of LANGS) {
    const raw = readFileSync(path.join(CORPUS, 'templates', `${lang}.json`), 'utf8');
    assert.equal(raw, `${JSON.stringify(WORDS[lang], null, 2)}\n`, `${lang}.json: every key once, two-space JSON`);
    for (const [key, value] of Object.entries(WORDS[lang])) {
      const where = `${lang} ${key}`;
      assert.equal(typeof value, 'string', where);
      assert.ok(value.trim() === value && value.length > 0, `${where} is a trimmed text`);
      assert.equal(value, value.normalize('NFC'), `${where} is NFC`);
      assert.doesNotMatch(value, HIDDEN, `${where} holds no hidden character`);
      assert.doesNotMatch(value, /[`<>|*_#[\]\\~!@&]/, `${where} holds no markup`);
      assert.doesNotMatch(value, / {2}|\s[,.;:!?]|\n/u, `${where}: single spaces, none before punctuation`);
      assert.doesNotMatch(value.replace(/\{[a-zA-Z]+\}/g, ''), /[{}]/, `${where}: every brace is a placeholder`);
      assert.deepEqual(slots(value), slots(WORDS.en[key]), `${where} has the placeholders of the English text`);
      assert.doesNotMatch(value, FORBIDDEN[lang], `${where} uses wording no measurement supports: ${FORBIDDEN[lang].exec(value)?.[0]}`);
      assert.doesNotMatch(value, FORBIDDEN.en, `${where} uses English wording no measurement supports`);
    }
  }
  // the lint notices what it is for
  for (const bad of ['proven safe', 'Proved.', 'a guarantee', 'secure', 'the best agent', 'a winner', 'agent-a outperforms agent-b', 'better than', 'ranked by', 'ranking', 'state of the art', 'top agents', 'significantly', 'lost']) assert.match(bad, FORBIDDEN.en, bad);
  for (const bad of ['đã được chứng minh', 'an toàn', 'tốt nhất', 'tốt hơn', 'người chiến thắng', 'vượt trội', 'xếp hạng', 'dẫn đầu', 'đảm bảo', 'hàng đầu', 'đáng kể']) assert.match(bad, FORBIDDEN.vi, bad);
  for (const fine of ['Proof-of-Done', 'proof pack', 'approved', 'stop', 'rate', 'weekly'.slice(4), 'improvement']) assert.doesNotMatch(fine, FORBIDDEN.en, fine);
  for (const fine of ['gói bằng chứng', 'khoảng Wilson', 'tỷ lệ', 'không có lần chạy', 'toàn bộ']) assert.doesNotMatch(fine, FORBIDDEN.vi, fine);
  // Vietnamese is Vietnamese: what the languages share is a name or a format
  const same = Object.keys(WORDS.en).filter((key) => WORDS.en[key] === WORDS.vi[key]);
  assert.deepEqual(same.filter((key) => /\p{L}{3,}/u.test(WORDS.en[key].replace(/\{[a-zA-Z]+\}/g, '').replace(/\b(?:DONE|BLOCKED|Agent|USD|sha256|Oracle|Wilson)\b/g, ''))), [], `texts that are the same in both languages: ${same.join(', ')}`);
  const vietnamese = Object.entries(WORDS.vi).filter(([key]) => !same.includes(key));
  const marked = vietnamese.filter(([, value]) => /[àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/iu.test(value));
  assert.ok(marked.length > vietnamese.length * 0.95, `${marked.length} of ${vietnamese.length} Vietnamese texts have Vietnamese letters`);
  // a text for every code the data can hold
  const wanted = [
    ...METRICS.map((metric) => `metric.${metric.id}`), ...METRICS.map((metric) => `metric.${metric.id}.about`), ...OUTCOMES.map((value) => `outcome.${value}`), ...['complete', 'incomplete', 'unknown', 'not_usd'].map((value) => `cost.status.${value}`),
    ...['oracle_missing', 'oracle_not_pass', 'null_missing', 'null_not_fail'].map((value) => `control.${value}`), ...['DONE', 'BLOCKED', 'none'].map((value) => `claim.${value}`),
    ...BANNER_REASONS.map((value) => `banner.${value}`), ...KILL_REASONS.map((value) => `kill.reason.${value}`), ...['added', 'modified', 'deleted'].map((value) => `change.${value}`),
  ];
  for (const key of wanted) assert.ok(Object.hasOwn(WORDS.en, key), `the dictionary has ${key}`);
  // translate takes whole numbers and nodes only, so a text of the data cannot become a word of the report
  const key = Object.keys(WORDS.en).find((name) => slots(WORDS.en[name]).length === 1);
  const [slot] = slots(WORDS.en[key]);
  assert.ok(translate('en', key, { [slot]: code('<b>') }).some((item) => item.type === 'code' && item.value === '<b>'), 'a node stays a node');
  assert.ok(translate('en', key, { [slot]: 1234567 }).some((item) => /1,234,567/.test(item.value)));
  assert.ok(translate('vi', key, { [slot]: 1234567 }).some((item) => /1\.234\.567/.test(item.value)));
  assert.equal(translate('en', key, { [slot]: [text('a'), code('b')] }).filter((item) => ['a', 'b'].includes(item.value)).length, 2, 'a list of nodes is spliced in');
  for (const value of ['raw text', null, undefined, {}, true, 1.5, -1, NaN, ['x'], [{ type: 'raw', value: 'x' }]]) assert.throws(() => translate('en', key, { [slot]: value }), TypeError, `translate refuses ${JSON.stringify(value)}`);
  assert.throws(() => translate('en', 'no.such.key', {}), TypeError);
  assert.throws(() => translate('en', 'constructor', {}), TypeError);
  assert.throws(() => translate('fr', key, {}), TypeError);
  assert.throws(() => translate('en', key, {}), TypeError, 'a placeholder without its value');
  ok(`the dictionaries: ${Object.keys(WORDS.en).length} texts in 2 languages (same keys and placeholders, NFC, no markup), one for each of ${wanted.length} codes; none uses wording no measurement supports; translate takes numbers and nodes only`);
}

// =====================================================================================================================
// 2. numbers
// =====================================================================================================================
{
  for (const [value, en, vi] of [[0, '0%', '0%'], [1, '100%', '100%'], [0.5, '50.0%', '50,0%'], [2 / 3, '66.7%', '66,7%'], [0.123456, '12.3%', '12,3%'], [0.0004, '<0.1%', '<0,1%'], [1e-9, '<0.1%', '<0,1%'], [0.9996, '>99.9%', '>99,9%'],
    [1 - 1e-9, '>99.9%', '>99,9%'], [0.001, '0.1%', '0,1%'], [0.999, '99.9%', '99,9%'], [0.0005, '0.1%', '0,1%'], [0.05, '5.0%', '5,0%']]) {
    assert.equal(percent(value, 'en'), en, `${value}`);
    assert.equal(percent(value, 'vi'), vi, `${value}`);
  }
  for (const [value, digits, en, vi] of [[0, 4, '0.0000', '0,0000'], [4 / 3, 4, '1.3333', '1,3333'], [0.1 + 0.2, 4, '0.3000', '0,3000'], [1234567.5, 4, '1,234,567.5000', '1.234.567,5000'], [0.00001, 4, '<0.0001', '<0,0001'], [6e12, 4, '6,000,000,000,000.0000', '6.000.000.000.000,0000'],
    [0.04, 1, '<0.1', '<0,1'], [0.05, 1, '0.1', '0,1'], [12.34, 1, '12.3', '12,3']]) {
    assert.equal(fixed(value, digits, 'en'), en, `${value}`);
    assert.equal(fixed(value, digits, 'vi'), vi, `${value}`);
  }
  const shown = (rate, lang) => rateNodes(rate, lang).map((item) => item.value).join('');
  assert.equal(shown(rateOf(2, 4), 'en'), '2/4 = 50.0% (95%: 15.0% – 85.0%)');
  assert.equal(shown(rateOf(2, 4), 'vi'), '2/4 = 50,0% (95%: 15,0% – 85,0%)');
  assert.equal(shown(rateOf(0, 3), 'en'), '0/3 = 0% (95%: 0% – 56.1%)');
  assert.equal(shown(rateOf(3, 3), 'en'), '3/3 = 100% (95%: 43.9% – 100%)');
  assert.equal(shown(rateOf(1, 6000), 'en'), '1/6,000 = <0.1% (95%: <0.1% – <0.1%)');
  for (const lang of LANGS) {
    assert.equal(shown(rateOf(0, 0), lang), WORDS[lang]['rate.none']);
    assert.doesNotMatch(WORDS[lang]['rate.none'], /%/, 'no rate is not 0%');
  }
  ok('numbers without a locale: percentages to one decimal with exact 0 and 1 and nothing else shown as them, money and seconds, a rate as k/n, its value and its Wilson interval; n = 0 has no rate');
}

// =====================================================================================================================
// 3. the golden report
// =====================================================================================================================
const goldenFolder = await newFolder('golden');
const GOLDEN_OPTIONS = await goldenInput(goldenFolder);
const goldenOut = path.join(goldenFolder, 'out');
const goldenResult = await report.generateReport({ ...GOLDEN_OPTIONS, out: goldenOut });
const GOLDEN_PACKS = goldenPacks(EXAMPLE_TASKS);
const GOLDEN_JSONL = scored(EXAMPLE_TASKS, GOLDEN_PACKS).jsonl;
const GOLDEN_METRICS = computeMetrics(readResults(GOLDEN_JSONL));
const goldenFiles = new Map(listFiles(goldenOut).filter(isGolden).map((name) => [name, readFileSync(path.join(goldenOut, name), 'utf8')]));
const PAGES = ['index.html', 'methods.html', 'responses.html', ...['agent-a', 'agent-b', 'agent-c', 'agent-d'].map((id) => `agent-${id}.html`), ...EXAMPLE_TASKS.map((task) => `task-${task.id}.html`)].sort();
const goldenSite = checkSite(goldenFiles, new Set(listFiles(goldenOut)), 'golden');
{
  assert.deepEqual([...goldenFiles.keys()].sort(), [...LANGS.flatMap((lang) => PAGES.map((page) => `${lang}/${page}`)), ...LANGS.map((lang) => `report.${lang}.md`)].sort(), 'index, one page per agent and per task, methods and vendor responses, and one Markdown report, per language');
  for (const name of goldenFiles.keys()) assert.equal(goldenFiles.get(name), readFileSync(path.join(GOLDEN, name), 'utf8'), `${name} is the golden report (node tests/fixtures/corpus-report/fixture.mjs --write after an intended change)`);
  assert.deepEqual(listFiles(GOLDEN), [...goldenFiles.keys()].sort(), 'the golden folder holds nothing else');
  // beside the pages: the packs under names made of ids, the results, the registration and the responses, byte for byte
  const copied = listFiles(goldenOut).filter((name) => !isGolden(name));
  assert.deepEqual(copied, [...GOLDEN_PACKS.map((pack) => `packs/${pack.task.id}_${pack.control ? `control-${pack.control}` : `agent-${pack.agent}`}_${pack.repeat}.json`), 'results.jsonl', 'preregistration.json', 'responses/agent-agent-b.txt'].sort());
  assert.equal(readFileSync(path.join(goldenOut, 'results.jsonl'), 'utf8'), GOLDEN_JSONL);
  assert.equal(readFileSync(path.join(goldenOut, 'responses', 'agent-agent-b.txt'), 'utf8'), GOLDEN_RESPONSE);
  assert.ok(readFileSync(path.join(goldenOut, 'preregistration.json')).equals(readFileSync(GOLDEN_OPTIONS.preregistration)));
  assert.deepEqual(goldenResult, { out: goldenOut, pages: goldenFiles.size, packs: GOLDEN_PACKS.length, registered: false });
  const attributes = readFileSync(path.join(REPO, '.gitattributes'), 'utf8').split(/\r?\n/);
  assert.ok(attributes.includes('DATGOLD-HUB/tests/fixtures/corpus-report/golden/** -text'), '.gitattributes keeps the golden files byte for byte');

  // every rate of the metrics stands in the pages as k/n with its interval, and no other percentage does
  const RATES = /[0-9.,]+\/[0-9.,]+ = [<>]?[0-9.,]+% \(95%: [<>]?[0-9.,]+% – [<>]?[0-9.,]+%\)/g;
  for (const lang of LANGS) {
    const page = textOf(goldenSite.pages.get(`${lang}/index.html`));
    for (const agent of GOLDEN_METRICS.agents) {
      for (const name of ['claimed_done', 'hidden_pass', 'false_done_rate', 'reverified_pass', 'tamper', 'out_of_scope']) {
        const value = rateNodes(agent[name], lang).map((item) => item.value).join('');
        assert.ok(page.includes(value), `${lang}: the index has ${agent.agent} ${name} ${value}`);
        assert.ok(textOf(goldenSite.pages.get(`${lang}/agent-${agent.agent}.html`)).includes(value), `${lang}: the page of ${agent.agent} has ${name} ${value}`);
        assert.ok(goldenFiles.get(`report.${lang}.md`).includes(value.replace(/[<>]/g, '\\$&')), `${lang}: the Markdown report has ${agent.agent} ${name} ${value}`);
      }
    }
    for (const [name, read] of goldenSite.pages) {
      if (!name.startsWith(`${lang}/`)) continue;
      // the threshold of the rule and the name of the interval are the only other percentages
      const rest = wordsOf(read).replace(RATES, '').replaceAll('95%', '').replaceAll(percent(KILL_RULE.threshold, lang), '');
      assert.doesNotMatch(rest, /%/, `${name}: every rate stands with k/n and its interval: ${/.{0,60}%.{0,20}/.exec(rest)?.[0]}`);
      assert.doesNotMatch(wordsOf(read).replace(RATES, ''), FORBIDDEN[lang], `${name}: wording no measurement supports: ${FORBIDDEN[lang].exec(wordsOf(read))?.[0]}`);
    }
    for (const line of goldenSite.reports.get(`report.${lang}.md`).outside) assert.doesNotMatch(line, FORBIDDEN[lang], `report.${lang}.md: ${line}`);
  }
  // scoring errors, flaky, timed out and incomplete repeats, unknown re-verifications and costs are counted and named
  const index = textOf(goldenSite.pages.get('en/index.html'));
  const [a, b, c] = GOLDEN_METRICS.agents;
  assert.deepEqual([a.flaky, a.false_done_flaky, a.timed_out, c.scoring_errors, b.cost_per_verified_task.status, c.repeats.complete], [1, 1, 1, 1, 'unknown_cost', false], '(premise) the set holds each');
  const rowOf = (page, section, first) => { const at = page.indexOf(`<section id="${section}">`); const body = page.slice(at, page.indexOf('</section>', at)); return body.split('<tr>').find((row) => row.includes(`>${first}</`)); };
  const apart = (agent) => rowOf(goldenFiles.get('en/index.html'), 'apart', agent).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(apart('agent-a'), `agent-a 0 1 1 1 1 1 0`, 'scoring errors, flaky, flaky false DONE, timed out, BLOCKED, no marker, missing runs');
  assert.equal(apart('agent-b'), `agent-b 0 0 0 0 0 6 0`);
  assert.equal(apart('agent-c'), `agent-c 1 0 0 0 0 0 3`);
  assert.equal(apart('agent-d'), `agent-d 0 0 0 0 0 0 6`, 'a registered agent that never ran is there, with every run missing');
  assert.match(textOf(goldenSite.pages.get('en/agent-agent-c.html')), says('missing.item'));
  assert.match(index, says('rate.unknown'));
  assert.ok(index.includes(translate('en', 'cost.unknown', { n: 6, m: 6 }).map((item) => item.value).join('')), 'how many of the runs have no known cost');
  for (const status of ['unknown', 'incomplete', 'not_usd']) assert.match(textOf(goldenSite.pages.get('en/task-example-sum.html')), says(`cost.status.${status}`), `a run whose cost is ${status} is named`);
  // cost: a quotient is shown with what it is made of
  assert.ok(index.includes('1.3333 USD') && index.includes('4.0000 USD'), 'cost per run that passed, and the total');
  // the report says that it compares nothing
  for (const lang of LANGS) assert.match(textOf(goldenSite.pages.get(`${lang}/index.html`)), says('about.comparison', lang));
  // methods, definitions, limitations, the marker contract word for word, reproduction
  for (const lang of LANGS) {
    const methods = goldenSite.pages.get(`${lang}/methods.html`);
    const words = textOf(methods);
    for (const metric of METRICS) assert.ok(codesOf(methods).includes(metric.definition), `${lang}: the registered definition of ${metric.id}`);
    for (const metric of METRICS) assert.match(words, says(`metric.${metric.id}.about`, lang));
    assert.ok(codesOf(methods).includes(MARKER_CONTRACT), `${lang}: the marker contract`);
    for (const value of [KILL_RULE.rule, PROTOCOL.interval, PROTOCOL.claim, ...PROTOCOL.controls]) assert.ok(codesOf(methods).includes(value), `${lang}: ${value}`);
    for (const key of ['marker', 'ignored', 'versions', 'autonomy', 'repeats', 'pack_read', 'public', 'sandbox', 'hidden', 'cost', 'secrets', 'tag']) assert.match(words, says(`limit.${key}`, lang), `${lang}: the limitation ${key}`);
    for (const key of ['scoring_error', 'cost', 'kill', 'null', 'tamper', 'complete']) assert.match(words, says(`reading.${key}`, lang), `${lang}: the reading ${key}`);
    assert.ok(words.includes('node corpus/tools/report.mjs --corpus') && words.includes('--check results.jsonl'), `${lang}: how to make it again`);
  }
  ok(`${goldenFiles.size} golden files (${PAGES.length} pages and a Markdown report in 2 languages), byte for byte; every rate of metrics.mjs as k/n with its interval and no other percentage; unknown, flaky, timed out, missing and scoring errors counted and named; methods, limitations, marker contract, reproduction`);
}

// =====================================================================================================================
// 4. the recompute and the refusals
// =====================================================================================================================
{
  const base = await newFolder('refusals');
  const options = { ...GOLDEN_OPTIONS, out: path.join(base, 'out') };
  const writeJson = async (name, value) => { const file = path.join(base, name); await fs.writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); return file; };
  let refusals = 0;
  const refused = async (change, code, what, inspect = () => {}) => {
    const before = listFiles(base);
    let caught = null;
    try { await report.generateReport({ ...options, ...change }); } catch (error) { caught = error; }
    assert.ok(caught, `${what}: refused`);
    assert.ok(['ReportError', 'ScoreError', 'MetricsError'].includes(caught.name), `${what}: ${caught.stack}`);
    assert.equal(caught.code, code, `${what}: ${caught.message}`);
    assert.deepEqual(listFiles(base), before, `${what}: nothing was written`);
    assert.ok(!existsSync(options.out) || change.out, `${what}: no folder`);
    inspect(caught);
    refusals += 1;
    return caught;
  };
  // results.jsonl: every single byte counts
  const bytes = Buffer.from(GOLDEN_JSONL, 'utf8');
  const changed = async (edit, what, line) => refused({ results: await writeJson('changed.jsonl', edit(Buffer.from(bytes))) }, 'results_differ', what, (error) => assert.match(error.message, new RegExp(`line ${line}\\b`), error.message));
  await changed((value) => { value[10] ^= 1; return value; }, 'one bit of the first line', 1);
  await changed((value) => { value[value.length - 3] ^= 1; return value; }, 'one bit of the last line', GOLDEN_PACKS.length);
  await changed((value) => value.subarray(0, value.length - 1), 'no line break at the end', GOLDEN_PACKS.length + 1);
  await changed((value) => Buffer.concat([value, Buffer.from('\n')]), 'an empty line more', GOLDEN_PACKS.length + 1);
  await changed(() => Buffer.alloc(0), 'an empty file', 1);
  await changed((value) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), value]), 'a byte order mark', 1);
  await changed((value) => Buffer.from(value.toString('utf8').split('\n').toSpliced(4, 1).join('\n')), 'a line left out', 5);
  // the edit of a person who wants another number: consistent, canonical, and still not what the packs give
  await changed((value) => Buffer.from(value.toString('utf8').replace('"false_done":true,"flaky":false,"format":"datgold.corpus-result/1","hidden_outcome":"fail","hidden_pass":false,"hidden_passes":0', '"false_done":false,"flaky":false,"format":"datgold.corpus-result/1","hidden_outcome":"pass","hidden_pass":true,"hidden_passes":3')), 'a false DONE turned into a pass', 4);
  await refused({ results: path.join(base, 'none.jsonl') }, 'results_missing', 'no results file');
  await refused({ results: base }, 'results_missing', 'a folder for a results file');
  // the packs
  const copyPacks = async (edit) => { const folder = await newFolder('packs'); for (const file of packFiles(GOLDEN_PACKS)) await fs.writeFile(path.join(folder, file.name), file.bytes); await edit(folder); return folder; };
  const first = packFiles(GOLDEN_PACKS)[0];
  await refused({ packs: path.join(base, 'no-packs') }, 'packs_missing', 'no packs folder');
  await refused({ packs: await copyPacks((folder) => fs.writeFile(path.join(folder, first.name), '{')) }, 'pack_not_json', 'a pack that does not read', (error) => assert.match(error.message, /run-0000\.json/));
  await refused({ packs: await copyPacks((folder) => fs.writeFile(path.join(folder, first.name), first.bytes.subarray(0, 100))) }, 'pack_not_json', 'a pack cut short');
  await refused({ packs: await copyPacks((folder) => fs.writeFile(path.join(folder, 'readme.txt'), 'x')) }, 'unexpected_file', 'a file that is no pack');
  await refused({ packs: await copyPacks((folder) => fs.rm(path.join(folder, first.name))) }, 'results_differ', 'a pack left out');
  await refused({ packs: await copyPacks((folder) => fs.writeFile(path.join(folder, 'again.json'), first.bytes)) }, 'duplicate_run', 'a run twice');
  await refused({ corpus: ALPHA_CORPUS }, 'unknown_task', 'packs of another corpus');
  await refused({ corpus: base }, 'corpus_invalid', 'no corpus');
  // the registration
  const given = readFileSync(GOLDEN_OPTIONS.preregistration, 'utf8');
  const document = JSON.parse(given);
  const prereg = async (edit, code, what, pattern) => {
    const value = JSON.parse(given);
    const out = edit(value) ?? value;
    await refused({ preregistration: await writeJson('prereg.json', typeof out === 'string' || Buffer.isBuffer(out) ? out : `${JSON.stringify(out, null, 2)}\n`) }, code, what, pattern ? (error) => assert.match(error.message, pattern, error.message) : undefined);
  };
  await refused({ preregistration: path.join(base, 'none.json') }, 'preregistration_missing', 'no preregistration file');
  await refused({ preregistration: base }, 'preregistration_missing', 'a folder for a preregistration file');
  await prereg(() => '{', 'preregistration_invalid', 'a preregistration that is not JSON');
  await prereg(() => '[]\n', 'preregistration_invalid', 'a list');
  await prereg(() => 'null\n', 'preregistration_invalid', 'null');
  await prereg(() => Buffer.from([0x7b, 0xff, 0x7d]), 'preregistration_invalid', 'not UTF-8');
  await prereg((value) => JSON.stringify(value), 'preregistration_mismatch', 'the same value written another way');
  await prereg((value) => { value.corpus.sha256 = 'f'.repeat(64); }, 'preregistration_mismatch', 'another corpus hash', /corpus/);
  await prereg((value) => { value.tasks[0].sha256 = 'f'.repeat(64); }, 'preregistration_mismatch', 'another version of a task', /tasks/);
  await prereg((value) => { value.tasks.pop(); }, 'preregistration_mismatch', 'a task less', /tasks/);
  await prereg((value) => { value.protocol.repeats_per_task_and_agent = 1; }, 'preregistration_mismatch', 'another protocol', /protocol/);
  await prereg((value) => { value.metrics[0].definition = 'other'; }, 'preregistration_mismatch', 'another metric definition', /metrics/);
  await prereg((value) => { value.thresholds.kill_rule_false_done_rate = 0.5; }, 'preregistration_mismatch', 'another threshold', /thresholds/);
  await prereg((value) => { value.kill_rule.rule = 'other'; }, 'preregistration_mismatch', 'another kill rule', /kill_rule/);
  await prereg((value) => { value.marker_contract.text = 'other'; }, 'preregistration_mismatch', 'another marker contract', /marker_contract/);
  await prereg((value) => { value.format_version = 2; }, 'preregistration_mismatch', 'another format version', /format_version/);
  await prereg((value) => { value.extra = 1; }, 'preregistration_mismatch', 'a key more', /extra/);
  await prereg((value) => { value.agents = []; }, 'preregistration_invalid', 'no agents');
  await prereg((value) => { value.agents = 'agent-a'; }, 'preregistration_invalid', 'agents that are no list');
  await prereg((value) => { value.agents = Array.from({ length: 21 }, (_, index) => ({ id: `a${index}`, cli: 'x', version: '1' })); }, 'preregistration_invalid', '21 agents');
  for (const id of ['..', '.', 'a/b', 'a\\b', 'A', 'a.', 'a b', '', 'a'.repeat(41), '-a', 'a\n', 7, null]) await prereg((value) => { value.agents[0].id = id; }, 'preregistration_invalid', `an agent id ${JSON.stringify(id)}`);
  await prereg((value) => { value.agents[1].id = value.agents[0].id; }, 'preregistration_invalid', 'an agent twice');
  await prereg((value) => { value.agents[0].extra = 'x'; }, 'preregistration_invalid', 'an unknown key of an agent');
  await prereg((value) => { value.agents[0].cli = 5; }, 'preregistration_invalid', 'a command that is no text');
  await prereg((value) => { delete value.agents[0].version; }, 'preregistration_invalid', 'an agent without a version');
  await prereg((value) => { value.agents[0] = null; }, 'preregistration_invalid', 'an agent that is null');
  await prereg((value) => { value.corpus.path = 5; }, 'preregistration_invalid', 'a corpus path that is no text');
  await prereg((value) => { value.corpus.commit = 'main'; }, 'preregistration_invalid', 'a commit that is a branch');
  await prereg((value) => { delete value.corpus; }, 'preregistration_invalid', 'no corpus');
  await prereg((value) => { value.scoring_code = { commit: 'x', repository: null }; }, 'preregistration_invalid', 'a scoring commit that is none');
  await prereg((value) => { value.scoring_code.repository = 7; }, 'preregistration_invalid', 'a scoring repository that is no text');
  await prereg((value) => { delete value.scoring_code; }, 'preregistration_invalid', 'no scoring code');
  await prereg((value) => { value.agents = value.agents.filter((agent) => agent.id !== 'agent-c'); }, 'agent_not_registered', 'runs of an agent nobody registered', /agent-c/);
  assert.equal(document.agents.length, GOLDEN_AGENTS.length);
  // the responses
  const responses = async (files, code, what) => { const folder = await newFolder('responses'); for (const [name, value] of Object.entries(files)) { if (value === null) await fs.mkdir(path.join(folder, name)); else await fs.writeFile(path.join(folder, name), value); } await refused({ responses: folder }, code, what); };
  await refused({ responses: path.join(base, 'no-responses') }, 'responses_missing', 'no responses folder');
  await responses({ 'agent-agent-z.txt': 'x' }, 'response_unknown_agent', 'a response of an agent the report does not know');
  await responses({ 'agent-a.txt': 'x' }, 'response_unknown_agent', 'an id that is not an agent: agent-a.txt is the response of "a"');
  await responses({ 'agent-agent-a.md': 'x' }, 'unexpected_file', 'another ending');
  await responses({ 'notes.txt': 'x' }, 'unexpected_file', 'another name');
  await responses({ 'agent-agent-a.txt': null }, 'unexpected_file', 'a folder');
  await responses({ 'agent-agent-a.txt': '' }, 'response_empty', 'an empty response');
  await responses({ 'agent-agent-a.txt': ' \r\n\t\n' }, 'response_empty', 'a response of white space');
  await responses({ 'agent-agent-a.txt': Buffer.from([0x68, 0xff]) }, 'response_not_text', 'bytes that are not UTF-8');
  await responses({ 'agent-agent-a.txt': 'x'.repeat(65_537) }, 'response_too_large', 'a response over 64 KiB');
  // the output: a new folder only
  await fs.mkdir(path.join(base, 'taken'));
  await fs.writeFile(path.join(base, 'taken.txt'), 'mine');
  await refused({ out: path.join(base, 'taken') }, 'out_exists', 'an empty folder that exists');
  await refused({ out: path.join(base, 'taken.txt') }, 'out_exists', 'a file that exists');
  await refused({ out: base }, 'out_exists', 'a folder with files');
  await refused({ out: path.join(base, 'no', 'parent') }, 'out_parent_missing', 'a folder whose parent does not exist');
  await refused({ out: path.join(base, 'taken.txt', 'x') }, 'out_parent_missing', 'a file for a parent');
  await refused({ out: path.join(GOLDEN_OPTIONS.packs, 'out') }, 'out_inside_input', 'inside the packs');
  await refused({ out: path.join(GOLDEN_OPTIONS.responses, 'out') }, 'out_inside_input', 'inside the responses');
  await refused({ out: path.join(ALPHA_CORPUS, 'out'), corpus: ALPHA_CORPUS }, 'out_inside_input', 'inside the corpus');
  assert.equal(readFileSync(path.join(base, 'taken.txt'), 'utf8'), 'mine');
  assert.ok(!readdirSync(GOLDEN_OPTIONS.packs).includes('out') && !readdirSync(GOLDEN_OPTIONS.responses).includes('out'));
  // the date, and arguments that are no arguments
  for (const date of ['2026-02-30', '25-11-2026', '2026-11-25T00:00:00Z', '', 20261125, 'today', '2026-11-25\n']) await refused({ date }, 'bad_date', `the date ${JSON.stringify(date)}`);
  for (const change of [{ corpus: undefined }, { packs: null }, { results: 5 }, { out: '' }, { extra: 1 }, { tag: 'x', preregistration: null }, { tag: '' }]) await refused(change, 'bad_argument', JSON.stringify(change));
  // a pack that changes while the report is made
  const fsp = (await import('node:fs/promises')).default;
  const readFile = fsp.readFile;
  const racing = await copyPacks(() => {});
  let seen = 0;
  fsp.readFile = async (file, ...rest) => {
    const value = await readFile(file, ...rest);
    if (String(file).endsWith(first.name)) { seen += 1; if (seen > 1) return Buffer.concat([value, Buffer.from('\n')]); }
    return value;
  };
  try { await refused({ packs: racing }, 'packs_changed', 'a pack that changed after it was scored'); } finally { fsp.readFile = readFile; }
  ok(`${refusals} refusals, each with its code and nothing left behind: results.jsonl with one changed byte, packs, the registration, responses, the output folder, the date, a pack that changes meanwhile`);
}

// =====================================================================================================================
// 5. links
// =====================================================================================================================
{
  // checkSite above followed every link of the golden report (and its anchors); here: what is linked
  for (const lang of LANGS) {
    const packLinks = [...goldenSite.pages].filter(([name]) => name.startsWith(`${lang}/`)).flatMap(([, page]) => page.links.filter((link) => link.to.startsWith('packs/')).map((link) => link.to));
    assert.deepEqual(packLinks.sort(), listFiles(goldenOut).filter((name) => name.startsWith('packs/')), `${lang}: every pack is linked once, from its task's page`);
    const md = goldenSite.reports.get(`report.${lang}.md`);
    assert.deepEqual(md.links.map((link) => link.to).filter((to) => to.startsWith('packs/')).sort(), packLinks, `${lang}: and once from the Markdown report`);
    // the sha256 beside a pack is the sha256 of the file the link leads to
    let compared = 0;
    for (const row of md.rows) {
      const target = row.flatMap((cell) => cell.links).find((link) => link.startsWith('packs/'));
      if (!target) continue;
      assert.ok(row.flatMap((cell) => cell.codes).includes(sha256(readFileSync(path.join(goldenOut, target)))), `${target}: its sha256 stands in the row`);
      compared += 1;
    }
    assert.equal(compared, GOLDEN_PACKS.length);
    for (const task of EXAMPLE_TASKS) {
      const page = goldenFiles.get(`${lang}/task-${task.id}.html`);
      for (const [row, target] of [...page.matchAll(/<tr id="run-[^"]+">.*?<a href="\.\.\/(packs\/[^"]+)">.*?<\/tr>/g)].map((match) => [match[0], match[1]])) {
        assert.ok(row.includes(`>${sha256(readFileSync(path.join(goldenOut, target)))}<`), `${target}: its sha256 stands in the row`);
        compared += 1;
      }
    }
    assert.equal(compared, GOLDEN_PACKS.length * 2);
    // every page leads to the index, the methods, the responses and the same page in the other language
    const other = lang === 'en' ? 'vi' : 'en';
    for (const [name, page] of goldenSite.pages) {
      if (!name.startsWith(`${lang}/`)) continue;
      const to = new Set(page.links.map((link) => link.to));
      for (const wanted of ['index.html', 'methods.html', 'responses.html'].map((file) => `${lang}/${file}`).concat(`${other}/${name.slice(3)}`)) assert.ok(to.has(wanted), `${name} leads to ${wanted}`);
    }
    const index = new Set(goldenSite.pages.get(`${lang}/index.html`).links.map((link) => link.to));
    for (const page of PAGES) assert.ok(index.has(`${lang}/${page}`), `the index leads to ${page}`);
    assert.ok(index.has('results.jsonl') && index.has('preregistration.json'));
    assert.ok(goldenSite.pages.get(`${lang}/responses.html`).links.some((link) => link.to === 'responses/agent-agent-b.txt'));
  }
  // the reader itself refuses a link that leads nowhere
  for (const [bad, what] of [['task-none.html', 'a page that does not exist'], ['index.html#none', 'an anchor that does not exist'], ['../../etc/passwd', 'out of the folder'], ['https://example.invalid/', 'an address'], ['javascript:alert(1)', 'a script'], ['/index.html', 'an absolute path'], ['file:///x', 'a file address']]) {
    const broken = new Map(goldenFiles);
    broken.set('en/index.html', goldenFiles.get('en/index.html').replace('href="methods.html"', `href="${bad}"`));
    assert.notEqual(broken.get('en/index.html'), goldenFiles.get('en/index.html'));
    assert.throws(() => checkSite(broken, new Set(listFiles(goldenOut)), 'broken'), assert.AssertionError, what);
  }
  ok(`${goldenSite.followed} links of ${goldenFiles.size} files followed, with their anchors, all relative; every pack linked once per language and format with the sha256 of the file; the link checker refuses what leads nowhere`);
}

// =====================================================================================================================
// 6. the page
// =====================================================================================================================
{
  const digest = (await import('node:crypto')).createHash('sha256').update(PAGE_STYLE, 'utf8').digest('base64');
  const directives = Object.fromEntries(PAGE_CSP.split('; ').map((part) => [part.split(' ')[0], part.split(' ').slice(1).join(' ')]));
  assert.deepEqual(directives, { 'default-src': "'none'", 'script-src': "'none'", 'style-src': `'sha256-${digest}'`, 'img-src': "'none'", 'font-src': "'none'", 'connect-src': "'none'", 'object-src': "'none'", 'frame-src': "'none'", 'base-uri': "'none'", 'form-action': "'none'" });
  assert.doesNotMatch(PAGE_STYLE, /url\(|@import|expression|https?:|\/\/|<|\{\{/i, 'the style loads nothing');
  for (const wanted of [/@media print/, /prefers-color-scheme: dark/, /unicode-bidi: isolate/, /\.banner \{[^}]*position: sticky/]) assert.match(PAGE_STYLE, wanted);
  for (const [name, page] of goldenSite.pages) {
    const styles = page.pieces.filter((piece) => piece.tag === 'style');
    assert.deepEqual(styles.map((piece) => piece.text), [PAGE_STYLE], `${name}: one style`);
    assert.equal(page.attributes.find((attribute) => attribute.name === 'content' && attribute.value.includes('default-src')).value, PAGE_CSP, name);
    const body = goldenFiles.get(name);
    const order = ['<meta charset="utf-8">', '<meta http-equiv="Content-Security-Policy"', '<title>', '<style>', '<body>'].map((mark) => body.indexOf(mark));
    assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), `${name}: the policy stands before anything it governs`);
    assert.ok(order[0] < 1024 && body.includes('<meta name="referrer" content="no-referrer">'), name);
    assert.doesNotMatch(body, /<(?:script|link|img|iframe|object|embed|form|input|base|svg)\b|\sstyle=|\son[a-z]+=|\{\{/i, name);
    assert.equal(page.attributes.find((attribute) => attribute.tag === 'html').value, name.slice(0, 2));
    assert.equal([...body.matchAll(/<th /g)].length, [...body.matchAll(/<th scope="(?:col|row)">/g)].length, `${name}: every table head says what it heads`);
    assert.equal([...body.matchAll(/<h1>/g)].length, 1, `${name}: one heading of the page`);
    assert.ok(page.pieces.some((piece) => piece.tag === 'title' && piece.text.trim() !== ''), `${name}: a title`);
  }
  ok(`${goldenSite.pages.size} pages: a policy that forbids scripts and every load and names the one style by its hash, no handler, no inline style, heads with a scope, dark and print styles`);
}

// =====================================================================================================================
// 7. the banner, and a real freeze
// =====================================================================================================================
const bannerOf = (page) => page.pieces.filter((piece) => piece.tags.includes('aside')).map((piece) => piece.text).join('');
/** Asserts that every page (and, in the Markdown report, every part that is a page) has the banner with `reasons`, or that none has one. */
function checkBanner(site, reasons, label) {
  for (const [name, page] of site.pages) {
    const lang = name.slice(0, 2);
    const words = bannerOf(page);
    if (reasons === null) { assert.equal(words, '', `${label} ${name}: no banner`); assert.ok(!textOf(page).includes(WORDS[lang]['banner.title']), name); continue; }
    assert.ok(words.startsWith(WORDS[lang]['banner.title']), `${label} ${name}: the banner`);
    assert.ok(site.files.get(name).indexOf('<aside class="banner"') < site.files.get(name).indexOf('<header>'), `${label} ${name}: before anything else`);
    for (const reason of BANNER_REASONS) assert.equal(says(`banner.${reason}`, lang).test(words), reasons.includes(reason), `${label} ${name}: ${reason}`);
  }
  for (const [name, read] of site.reports) {
    const lang = name.slice(7, 9);
    const body = site.files.get(name);
    const count = body.split(WORDS[lang]['banner.title']).length - 1;
    const parts = [...body.matchAll(/^## /gm)].length;
    assert.equal(count, reasons === null ? 0 : parts, `${label} ${name}: at the head of every one of the ${parts} parts`);
    if (reasons !== null) assert.ok(body.split('\n').slice(0, 8).some((line) => line.includes(WORDS[lang]['banner.title'])), `${label} ${name}: at the top`);
    assert.ok(read.codes.length > 0);
  }
}
{
  assert.equal(WORDS.en['banner.title'], 'Synthetic data, not a measurement');
  assert.equal(WORDS.vi['banner.title'], 'Dữ liệu giả lập, không phải kết quả đo');
  assert.deepEqual([...BANNER_REASONS], ['no_registration', 'no_tag', 'example']);
  checkBanner({ ...goldenSite, files: goldenFiles }, ['no_tag', 'example'], 'golden');
  const exampleRuns = [...controlsOf(EXAMPLE_TASKS), ...fullRuns(EXAMPLE_TASKS, 'agent-a')];
  const alphaRuns = [...controlsOf(TASKS), ...fullRuns(TASKS, 'agent-a'), ...fullRuns(TASKS, 'agent-b')];
  checkBanner(readSite(dataOf(EXAMPLE_TASKS, exampleRuns), 'unregistered examples'), ['no_registration', 'example'], 'unregistered examples');
  checkBanner(readSite(dataOf(TASKS, alphaRuns), 'unregistered'), ['no_registration'], 'unregistered');
  checkBanner(readSite(dataOf(TASKS, alphaRuns, { registration: registrationOf(TASKS) }), 'untagged'), ['no_tag'], 'untagged');
  checkBanner(readSite(dataOf(EXAMPLE_TASKS, exampleRuns, { registration: registered(EXAMPLE_TASKS) }), 'tagged examples'), ['example'], 'tagged examples');
  checkBanner(readSite(dataOf(TASKS, alphaRuns, { registration: registered(TASKS) }), 'registered'), null, 'registered');
  // an example task is known by its id or by its tag
  const byTag = clone(TASKS);
  byTag[0].task.tags = ['example', 'node'];
  assert.match(textOf(readSite(dataOf(byTag, alphaRuns, { registration: registered(byTag) }), 'tagged example').pages.get('en/index.html')), says('banner.example'));

  // a real freeze, in a repository of its own, with its tag
  const repo = path.join(ROOT, 'alpha-repo');
  const hidden = path.join(ROOT, 'alpha-hidden');
  for (const task of TASKS) {
    await fs.mkdir(path.join(hidden, task.id), { recursive: true });
    await fs.writeFile(path.join(hidden, task.id, task.task.hidden_tests.archive), `hidden archive of ${task.id}`);
  }
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'Corpus Test']);
  git(repo, ['config', 'user.email', 'corpus-test@example.invalid']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'the corpus']);
  const work = await newFolder('registered');
  const config = path.join(work, 'freeze.json');
  await fs.writeFile(config, JSON.stringify({ version: 1, agents: AGENTS }));
  const frozen = path.join(work, 'preregistration.json');
  const frozenRun = node(path.join(CORPUS, 'tools', 'freeze.mjs'), ['--corpus', ALPHA_CORPUS, '--hidden', hidden, '--config', config, '--out', frozen, '--tag', 'prereg-1']);
  assert.equal(frozenRun.status, 0, frozenRun.stdout + frozenRun.stderr);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  // what freeze writes is what the report expects of a registration, byte for byte
  assert.equal(readFileSync(frozen, 'utf8'), report.registrationText({ tasks: TASKS, agents: AGENTS, corpus: { path: 'corpus', commit }, scoringCode: null }));
  const packs = path.join(work, 'packs');
  await fs.mkdir(packs);
  for (const file of packFiles(alphaRuns)) await fs.writeFile(path.join(packs, file.name), file.bytes);
  const results = path.join(work, 'results.jsonl');
  await fs.writeFile(results, scored(TASKS, alphaRuns).jsonl);
  const options = { corpus: ALPHA_CORPUS, packs, results, preregistration: frozen, tag: 'prereg-1', out: path.join(work, 'out') };
  const made = await report.generateReport(options);
  assert.equal(made.registered, true);
  const files = new Map(listFiles(options.out).filter(isGolden).map((name) => [name, readFileSync(path.join(options.out, name), 'utf8')]));
  const site = { files, ...checkSite(files, new Set(listFiles(options.out)), 'registered') };
  checkBanner(site, null, 'a real freeze');
  const tagObject = git(repo, ['rev-parse', 'refs/tags/prereg-1']);
  const seconds = Number(/^tagger .* (\d+) [+-]\d{4}$/m.exec(git(repo, ['cat-file', 'tag', 'prereg-1']))[1]);
  for (const lang of LANGS) {
    const codes = codesOf(site.pages.get(`${lang}/index.html`));
    for (const value of ['prereg-1', commit, tagObject, sha256(readFileSync(frozen)), JSON.parse(readFileSync(frozen, 'utf8')).corpus.sha256, sha256(readFileSync(results)), new Date(seconds * 1000).toISOString()]) assert.ok(codes.includes(value), `${lang}: the index names ${value}`);
    assert.match(textOf(site.pages.get(`${lang}/index.html`)), says('registration.unsigned', lang));
    assert.ok(!files.get(`${lang}/index.html`).includes('corpus-test@example.invalid'), 'nobody\'s address');
    assert.ok(codesOf(site.pages.get(`${lang}/methods.html`)).includes(commit), `${lang}: the methods name the scoring commit`);
  }
  // a tag that is not this registration's is refused
  const base = path.join(work, 'refused');
  await fs.mkdir(base);
  const refused = async (change, code, what, pattern) => {
    let caught = null;
    try { await report.generateReport({ ...options, out: path.join(base, 'out'), ...change }); } catch (error) { caught = error; }
    assert.ok(caught instanceof ReportError, `${what}: ${caught?.stack ?? 'not refused'}`);
    assert.equal(caught.code, code, `${what}: ${caught.message}`);
    if (pattern) assert.match(caught.message, pattern, caught.message);
    assert.deepEqual(listFiles(base), [], `${what}: nothing was written`);
  };
  await refused({ tag: 'no-such-tag' }, 'tag_missing', 'a tag that does not exist');
  for (const name of ['-x', 'a b', '../x', 'refs/tags/prereg-1', 'prereg-1^{}', 'a'.repeat(101)]) await refused({ tag: name }, 'bad_argument', `the tag name ${name}`);
  git(repo, ['tag', 'light', commit]);
  await refused({ tag: 'light' }, 'tag_mismatch', 'a lightweight tag', /annotated/);
  const message = git(repo, ['cat-file', 'tag', 'prereg-1']);
  const body = `${message.slice(message.indexOf('\n\n') + 2)}\n`;
  git(repo, ['tag', '-a', '--cleanup=verbatim', '-F', '-', 'other-message', commit], { input: 'a registration of something else\n' });
  await refused({ tag: 'other-message' }, 'tag_mismatch', 'a tag that holds another file', /message/);
  git(repo, ['tag', '-a', '--cleanup=verbatim', '-F', '-', 'more-text', commit], { input: `${body}and a sentence more\n` });
  await refused({ tag: 'more-text' }, 'tag_mismatch', 'a tag whose message goes on', /message/);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'later']);
  git(repo, ['tag', '-a', '--cleanup=verbatim', '-F', '-', 'moved', 'HEAD'], { input: body });
  await refused({ tag: 'moved' }, 'tag_mismatch', 'a tag on another commit', /commit/);
  git(repo, ['update-ref', 'refs/tags/renamed', tagObject]);
  await refused({ tag: 'renamed' }, 'tag_mismatch', 'a ref whose tag object has another name', /name/);
  const tree = git(repo, ['rev-parse', `${commit}^{tree}`]);
  git(repo, ['tag', '-a', '--cleanup=verbatim', '-F', '-', 'of-a-tree', tree], { input: body });
  await refused({ tag: 'of-a-tree' }, 'tag_mismatch', 'a tag of a tree');
  const strange = git(repo, ['hash-object', '-t', 'tag', '-w', '--stdin'], { input: `object ${commit}\ntype commit\ntag far-time\ntagger X <x@example.invalid> 99999999999999 +0000\n\n${body}` });
  git(repo, ['update-ref', 'refs/tags/far-time', strange]);
  await refused({ tag: 'far-time' }, 'tag_mismatch', 'a time that is no time');
  // the same tag with a signature after its message: read, said, not checked
  const signature = '-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQ==\n-----END SSH SIGNATURE-----\n';
  const signedObject = git(repo, ['hash-object', '-t', 'tag', '-w', '--stdin'], { input: `object ${commit}\ntype commit\ntag signed-1\ntagger Corpus Test <corpus-test@example.invalid> 1700000000 +0700\n\n${body}${signature}` });
  git(repo, ['update-ref', 'refs/tags/signed-1', signedObject]);
  const signedOut = path.join(work, 'signed');
  await report.generateReport({ ...options, tag: 'signed-1', out: signedOut });
  assert.match(readFileSync(path.join(signedOut, 'report.en.md'), 'utf8'), says('registration.signed'));
  assert.match(readFileSync(path.join(signedOut, 'report.en.md'), 'utf8'), /2023-11-14T22:13:20\.000Z/);
  // a replacement object does not stand in for the tag
  git(repo, ['replace', tagObject, signedObject]);
  await report.generateReport({ ...options, out: path.join(work, 'replaced') });
  assert.match(readFileSync(path.join(work, 'replaced', 'report.en.md'), 'utf8'), says('registration.unsigned'));
  git(repo, ['replace', '-d', tagObject]);
  // a corpus that is in no repository has no tag to check; the registration of one byte more is not the tag's
  const loose = await newFolder('loose');
  await fs.cp(ALPHA_CORPUS, path.join(loose, 'corpus'), { recursive: true });
  await refused({ corpus: path.join(loose, 'corpus') }, 'tag_missing', 'a corpus outside Git');
  const other = path.join(work, 'other.json');
  await fs.writeFile(other, report.registrationText({ tasks: TASKS, agents: [...AGENTS, { id: 'agent-z', cli: 'z', version: '1' }], corpus: { path: 'corpus', commit }, scoringCode: null }));
  await refused({ preregistration: other }, 'tag_mismatch', 'a registration with one agent more than the tag\'s');
  ok('the banner with its reasons on every page (and every part of the Markdown report) of what is not registered, and on none of a corpus frozen by freeze.mjs whose tag is this registration\'s; a tag that is missing, lightweight, moved, renamed, of a tree, of another file or with more text is refused; a signature is said, not checked');
}

// =====================================================================================================================
// 8. the kill rule
// =====================================================================================================================
{
  const controls = controlsOf(TASKS);
  const both = (make) => [...fullRuns(TASKS, 'agent-a', make), ...fullRuns(TASKS, 'agent-b')];
  const section = (packs, options = {}) => {
    const site = readSite(dataOf(TASKS, packs, { registration: registered(TASKS), ...options }), 'kill rule');
    return LANGS.map((lang) => {
      const page = site.files.get(`${lang}/index.html`);
      const at = page.indexOf('<section id="kill">');
      return unescapeHtml(page.slice(at, page.indexOf('</section>', at)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
    });
  };
  const VERDICTS = ['kill.met', 'kill.not_met', 'kill.undecided', 'kill.not_applied'];
  const check = (packs, verdict, reasons, options, label) => {
    const sections = section(packs, options);
    for (const [index, lang] of LANGS.entries()) {
      const body = sections[index];
      const loose = (key) => new RegExp(says(key, lang).source.replaceAll(' ', '\\s+'));
      for (const name of VERDICTS) assert.equal(loose(name).test(body), name === verdict, `${label} (${lang}): ${name}`);
      for (const reason of KILL_REASONS) assert.equal(loose(`kill.reason.${reason}`).test(body), reasons.includes(reason), `${label} (${lang}): ${reason}\n${body}`);
    }
    return sections;
  };
  // the registered set, complete
  const met = check([...controls, ...both(() => ({}))], 'kill.met', [], {}, 'no false DONE');
  assert.match(met[0], /not a measurable problem on this corpus/);
  assert.match(met[0], /withdraws the claim that Proof-of-Done is needed/);
  check([...controls, ...both((task, repeat) => ({ passes: task === TASKS[0] && repeat === 1 ? 0 : 3 }))], 'kill.not_met', [], {}, '1 of 6');
  const named = check([...controls, ...both(() => ({ passes: 0 }))], 'kill.not_met', [], {}, '6 of 6');
  assert.match(named[0], /agent-a/);
  assert.ok(!/withdraws/.test(named[0]), 'the consequence is stated only when the rule is met');
  check([...controls, ...['agent-a', 'agent-b'].flatMap((agent) => fullRuns(TASKS, agent, () => ({ message: 'BLOCKED: x', passes: 0 })))], 'kill.undecided', [], {}, 'no claim at all');
  // the rate is exactly at the threshold: not above it. (The 10 claims need 10 runs; the protocol's set of 2 tasks has 6 per agent, so the metrics are given.)
  const exact = dataOf(TASKS, [...controls, ...both(() => ({}))], { registration: registered(TASKS) });
  exact.metrics = clone(exact.metrics);
  exact.metrics.agents[0].false_done_rate = rateOf(1, 10);
  assert.match(report.renderFiles(exact).get('report.en.md'), says('kill.met'));
  // every reason it is not applied
  const notApplied = (packs, reasons, options, label) => {
    const [en] = check(packs, 'kill.not_applied', reasons, options, label);
    assert.ok(!/withdraws|not a measurable problem/.test(en), `${label}: the consequence is not stated`);
  };
  notApplied([...controls, ...both(() => ({}))], ['not_registered'], { registration: null }, 'not registered');
  notApplied([...controls, ...both(() => ({}))], ['not_registered'], { registration: registrationOf(TASKS) }, 'no tag');
  notApplied(controls, ['no_agent', 'agent_missing'], {}, 'controls alone');
  notApplied([...controls, ...both(() => ({})).slice(1)], ['repeats'], {}, 'a repeat missing');
  notApplied([...controls, ...both((task, repeat) => (repeat === 1 && task === TASKS[1] ? { outcome: 'patch_does_not_apply' } : {}))], ['scoring_errors'], {}, 'a scoring error');
  notApplied([...controls.slice(1), ...both(() => ({}))], ['controls'], {}, 'a control missing');
  notApplied([controlPack(TASKS[0], 'oracle', { passes: 2 }), ...controls.slice(1), ...both(() => ({}))], ['controls'], {}, 'a flaky oracle');
  notApplied([...controls, ...fullRuns(TASKS, 'agent-a')], ['agent_missing'], {}, 'a registered agent without a run');
  // metrics.mjs knows the tasks of the results only: a corpus task nobody ran is seen here
  const oneTask = [...controlsOf(TASKS.slice(0, 1)), ...['agent-a', 'agent-b'].flatMap((agent) => fullRuns(TASKS.slice(0, 1), agent))];
  assert.equal(dataOf(TASKS, oneTask, { registration: registered(TASKS) }).metrics.kill_rule.final, true, '(premise) final over the tasks that were seen');
  notApplied(oneTask, ['task_missing'], {}, 'a corpus task without a run');
  notApplied([], ['no_agent', 'controls', 'agent_missing', 'task_missing'], {}, 'no run at all');
  // the golden set names each of its reasons
  const golden = goldenFiles.get('report.en.md');
  for (const reason of ['not_registered', 'repeats', 'scoring_errors', 'controls', 'agent_missing']) assert.match(golden, says(`kill.reason.${reason}`));
  assert.doesNotMatch(golden, /withdraws the claim that Proof-of-Done is needed to catch them\.(?!`)(?![^`]*`)/, 'the consequence only in the quoted rule');
  ok(`the kill rule: met, not met (the agents above named with their rates), undecided without a claim, a rate exactly at the threshold; not applied, with every reason, for anything but the complete registered run set (${KILL_REASONS.length} reasons, a corpus task and a registered agent without a run among them)`);
}

// =====================================================================================================================
// 9. edge sets
// =====================================================================================================================
{
  const page = (site, name, lang = 'en') => textOf(site.pages.get(`${lang}/${name}`));
  // no run at all
  const none = readSite(dataOf(TASKS, []), 'no run');
  for (const lang of LANGS) {
    assert.match(page(none, 'index.html', lang), says('agents.none', lang));
    assert.doesNotMatch(wordsOf(none.pages.get(`${lang}/index.html`)).replaceAll('95%', '').replaceAll(percent(0.1, lang), ''), /%/, 'no percentage of nothing');
    assert.match(page(none, 'task-alpha.html', lang), says('runs.none', lang));
  }
  assert.deepEqual([...none.files.keys()].filter((name) => /agent-/.test(name)), [], 'no agent, no agent page');
  for (const [name, body] of none.files) assert.doesNotMatch(body, /<tbody>\n<\/tbody>/, `${name}: no empty table`);
  // one run of one agent
  const one = readSite(dataOf(TASKS, [agentPack(TASKS[0], { passes: 0 })]), 'one run');
  assert.ok(page(one, 'index.html').includes('1/1 = 100% (95%: 20.7% – 100%)'), 'one false DONE of one claim, with how little it says');
  assert.match(page(one, 'index.html'), says('control.oracle_missing'));
  assert.match(page(one, 'agent-agent-a.html'), says('missing.item'));
  // an agent that never claims DONE has no false DONE rate: never 0%
  const silent = readSite(dataOf(TASKS, [...controlsOf(TASKS), ...fullRuns(TASKS, 'agent-a', () => ({ message: null, passes: 0 }))]), 'no claim');
  for (const lang of LANGS) {
    assert.ok(page(silent, 'index.html', lang).includes(WORDS[lang]['rate.none']));
    assert.ok(page(silent, 'agent-agent-a.html', lang).includes(WORDS[lang]['rate.none']));
    assert.equal(page(silent, 'index.html', lang).split('0/6 = 0%').length - 1, 2 + 2, 'claimed, hidden tests passed, checks changed and out of scope: 0 of 6, which is a rate');
  }
  // every cost unknown: named and counted, no amount anywhere
  const costless = readSite(dataOf(TASKS, fullRuns(TASKS, 'agent-a', () => ({ cost: 'unknown' }))), 'costs unknown');
  assert.ok(page(costless, 'index.html').includes(translate('en', 'cost.unknown', { n: 6, m: 6 }).map((item) => item.value).join('')));
  assert.doesNotMatch(page(costless, 'index.html'), /[0-9] USD/);
  // a cost of 0 is a known cost; no run passed, so nothing to divide by
  const free = readSite(dataOf(TASKS, fullRuns(TASKS, 'agent-a', () => ({ cost: { currency: 'USD', knownSubtotal: 0, complete: true }, passes: 0 }))), 'free');
  assert.ok(page(free, 'index.html').includes('0.0000 USD'));
  assert.match(page(free, 'index.html'), says('cost.none_passed'));
  // 0 of n and n of n
  const zero = page(readSite(dataOf(TASKS, fullRuns(TASKS, 'agent-a')), 'n of n'), 'index.html');
  assert.ok(zero.includes('6/6 = 100% (95%: 61.0% – 100%)') && zero.includes('0/6 = 0% (95%: 0% – 39.0%)'));
  // a proof pack nowhere: re-verification and tamper are not known, which is not "no"
  const unproven = page(readSite(dataOf(TASKS, fullRuns(TASKS, 'agent-a', () => ({ proof: null }))), 'no proof pack'), 'index.html');
  assert.equal(unproven.split(translate('en', 'rate.unknown', { rate: [text(WORDS.en['rate.none'])], n: 6 }).map((item) => item.value).join('')).length - 1, 2);
  // a registered agent without a run and a task without a run are shown, not left out
  const gaps = readSite(dataOf(TASKS, [...controlsOf(TASKS.slice(0, 1)), ...fullRuns(TASKS.slice(0, 1), 'agent-a')], { registration: registered(TASKS) }), 'gaps');
  assert.match(page(gaps, 'agent-agent-b.html'), says('agent.no_run'));
  assert.match(page(gaps, 'task-beta.html'), says('runs.none'));
  assert.ok(gaps.pages.get('en/index.html').pieces.some((piece) => piece.text === WORDS.en['run.missing']), 'the grid says which runs are not there');
  // agents whose ids are device names or names of controls: pages, packs and anchors of their own
  const odd = ['con', 'nul', 'oracle', 'null', 'a-', 'agent-a', 'control-oracle', 'index', 'methods', '0'];
  const oddSite = readSite(dataOf(TASKS, [...controlsOf(TASKS), ...odd.map((agent) => agentPack(TASKS[0], { agent }))]), 'odd ids');
  for (const agent of odd) assert.ok(oddSite.files.has(`en/agent-${agent}.html`), agent);
  const names = [...dataOf(TASKS, [...controlsOf(TASKS), ...odd.map((agent) => agentPack(TASKS[0], { agent }))]).runs.values()].map((run) => run.file);
  assert.equal(new Set(names).size, odd.length + 4, 'a pack file of its own for every run, the oracle control and an agent called oracle among them');
  for (const name of [...names, ...oddSite.files.keys()]) assert.doesNotMatch(path.posix.basename(name), /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)|[. ]$/i, `${name} is a file on Windows`);
  // ids that would leave the folder are refused wherever they come from
  const hostileIds = ['..', '.', '', 'a/b', 'a\\b', '../x', 'C:x', 'a.', 'a ', 'A', 'con.', 'é', 'a\u0000', 'x'.repeat(65), '<b>'];
  const good = dataOf(TASKS, [agentPack(TASKS[0])]);
  for (const id of hostileIds) {
    const asTask = { ...good, tasks: [{ ...good.tasks[0], id }, good.tasks[1]] };
    assert.throws(() => report.renderFiles(asTask), (error) => error instanceof ReportError && error.code === 'bad_id', `a task ${JSON.stringify(id)}`);
    const asAgent = { ...good, metrics: { ...good.metrics, agents: [{ ...good.metrics.agents[0], agent: id }] } };
    assert.throws(() => report.renderFiles(asAgent), (error) => error instanceof ReportError && error.code === 'bad_id', `an agent ${JSON.stringify(id)}`);
  }
  ok('edge sets: no run, one run, an agent that never claims (no rate, never 0%), every cost unknown, a cost of 0, 0 of n and n of n, no proof pack, agents and tasks without a run; ids that are device names or control names keep files of their own; ids that would leave the folder are refused');
}

// =====================================================================================================================
// 10. order
// =====================================================================================================================
{
  const agents = ['agent-c', 'agent-a', 'agent-d', 'agent-b'];
  // whichever agent has which results, the order on every page is the order of the ids
  const orders = [agents, [...agents].reverse()].map((order) => {
    const packs = [...controlsOf(TASKS), ...order.flatMap((agent, index) => fullRuns(TASKS, agent, () => ({ passes: index })))];
    const site = readSite(dataOf(TASKS, packs), 'order');
    for (const lang of LANGS) {
      for (const section of ['rates', 'other', 'costs', 'apart', 'kill']) {
        const page = site.files.get(`${lang}/index.html`);
        const at = page.indexOf(`<section id="${section}">`);
        const found = [...page.slice(at, page.indexOf('</section>', at)).matchAll(/<th scope="row">(?:<a [^>]*>)?<code class="word">(agent-[a-z])</g)].map((match) => match[1]);
        assert.deepEqual(found, [...agents].sort(), `${lang} ${section}: by id`);
      }
    }
    return [...site.files.keys()];
  });
  assert.deepEqual(orders[0], orders[1]);
  ok('agents stand in the order of their ids in every table, whatever they scored');
}

// =====================================================================================================================
// 11. hostile texts
// =====================================================================================================================
function clone(value) { return JSON.parse(JSON.stringify(value)); }
{
  const fits = (value, max) => [...value].slice(0, max).join('') || 'x';
  const base = () => ({
    tasks: clone(TASKS), pack: {}, agents: clone(AGENTS), scoringCode: null, responses: new Map(), tag: TAG,
  });
  // where a free text can come from, and how to put one there
  const PLACES = {
    'task title': (d, value) => { d.tasks[0].task.title = value; },
    'task prompt': (d, value) => { d.tasks[0].task.prompt = `first line\n${value}\nlast line`; },
    'task setup': (d, value) => { d.tasks[0].task.setup = [value]; },
    'allowed path': (d, value) => { d.tasks[0].task.allowed_paths = [value]; },
    'task repository': (d, value) => { d.tasks[0].task.repo = { git: { url: `https://example.invalid/${value}`, commit: '1'.repeat(40) } }; },
    'task tag': (d, value) => { d.tasks[0].task.tags = [value]; },
    'criterion text': (d, value) => { d.tasks[0].acceptance.criteria[0].text = value; },
    'check command': (d, value) => { d.tasks[0].acceptance.criteria[0].checks[0].run = value; },
    'final message': (d, value) => { d.pack.message = `before\n${value}`; },
    'out of scope path': (d, value) => { d.pack.outOfScope = [{ path: value || 'x', change: 'added' }]; },
    'overwritten path': (d, value) => { d.pack.overwritten = [value || 'x']; },
    signal: (d, value) => { d.pack.signal = fits(value, 16); d.pack.exitCode = null; },
    'agent command': (d, value) => { d.agents[0].cli = value || 'x'; },
    'agent version': (d, value) => { d.agents[0].version = value || 'x'; },
    'agent model': (d, value) => { d.agents[0].model = value || 'x'; },
    'agent notes': (d, value) => { d.agents[0].notes = value || 'x'; },
    'scoring repository': (d, value) => { d.scoringCode = { commit: '6'.repeat(40), repository: value || 'x' }; },
    'corpus path': (d, value) => { d.path = value; },
    'tag name': (d, value) => { d.tag = { ...TAG, name: value || 'x' }; },
    'vendor response': (d, value) => { d.responses.set('agent-a', report.readResponse(Buffer.from(`Dear reader\n${value}\r\nend`.toWellFormed()))); },
  };
  let rendered = 0;
  for (const [place, put] of Object.entries(PLACES)) {
    for (const [name, raw] of Object.entries(HOSTILE)) {
      const value = raw.toWellFormed();
      const d = base();
      put(d, value);
      const packs = [agentPack(d.tasks[0], d.pack)];
      const registration = { ...report.readRegistration({ bytes: Buffer.from(report.registrationText({ tasks: d.tasks, agents: d.agents, corpus: { path: d.path ?? 'corpus', commit: '4'.repeat(40) }, scoringCode: d.scoringCode })), tasks: d.tasks }), tag: d.tag };
      const data = dataOf(d.tasks, packs, { registration, responses: d.responses });
      const label = `${name} in ${place}`;
      const site = readSite(data, label);
      rendered += site.files.size;
      const shown = (page) => page.pieces.filter((piece) => piece.tag === 'code').map((piece) => piece.text);
      const multi = place === 'task prompt' || place === 'vendor response';
      // the line of a final message that is shown is its last one; a text of many lines is shown line by line
      const pieces = multi ? value.replace(/\r\n/g, '\n').split('\n') : place === 'final message' ? [value.split('\n').at(-1).replace(/[ \t]+$/, '')] : place === 'signal' ? [fits(value, 16)] : place === 'task repository' ? [`https://example.invalid/${value}`] : [value || 'x'];
      for (const lang of LANGS) {
        const htmlCodes = [...site.pages].filter(([file]) => file.startsWith(`${lang}/`)).flatMap(([, page]) => shown(page));
        const md = site.reports.get(`report.${lang}.md`);
        for (const piece of pieces) {
          const wanted = visible(piece);
          if (multi) {
            assert.ok(htmlCodes.some((item) => item.split('\n').includes(wanted)), `${label}, ${lang} html: ${JSON.stringify(wanted)}`);
            assert.ok(md.fenced.some((item) => item.split('\n').includes(wanted)), `${label}, ${lang} md: ${JSON.stringify(wanted)}`);
          } else {
            assert.ok(htmlCodes.some((item) => item === (wanted || ' ')), `${label}, ${lang} html: ${JSON.stringify(wanted)}`);
            assert.ok(md.codes.some((item) => item.replaceAll('⟦U+005C⟧', '\\') === (wanted || ' ')), `${label}, ${lang} md: ${JSON.stringify(wanted)}`);
          }
        }
      }
      // a consumer that normalises the bytes to NFC changes no structure
      if (['normalises', 'leadingMark', 'markers'].includes(name)) for (const [file, body] of site.files) { if (file.endsWith('.html')) readHtml(body.normalize('NFC'), `${label}, normalised`); else readMd(body.normalize('NFC'), `${label}, normalised`); }
    }
  }
  // very long texts: cut with their length said, or whole where the text is the point
  const long = `${'`|\\<b>'.repeat(5000)}`;
  const d = base();
  d.pack = { message: `x\n${long}`, outOfScope: Array.from({ length: 5000 }, (_, index) => ({ path: `${index}/${'p'.repeat(4000)}`, change: 'added' })) };
  const longSite = readSite(dataOf(d.tasks, [agentPack(d.tasks[0], d.pack)], { responses: new Map([['agent-a', report.readResponse(Buffer.from('y'.repeat(65_536)))]]) }), 'long texts');
  const taskPage = textOf(longSite.pages.get('en/task-alpha.html'));
  assert.ok(taskPage.length < 80_000, `the page of a task stays readable: ${taskPage.length}`);
  assert.match(taskPage, says('text.cut'));
  assert.ok(taskPage.includes(translate('en', 'paths.more', { n: 4980 }).map((item) => item.value).join('')), 'the paths that are not listed are counted');
  assert.ok(codesOf(longSite.pages.get('en/responses.html')).includes('y'.repeat(65_536)), 'a response is whole');
  // diacritics come back as they went in, composed or not
  for (const value of ['Đặt lịch ở Thừa Thiên–Huế ắ ằ ẳ ẵ ặ', 'Đặt lịch ở Thừa Thiên–Huế ắ ằ ẳ ẵ ặ'.normalize('NFD')]) {
    const e = base();
    e.tasks[0].task.title = value;
    const site = readSite(dataOf(e.tasks, [agentPack(e.tasks[0])]), 'diacritics');
    for (const lang of LANGS) assert.ok(codesOf(site.pages.get(`${lang}/task-alpha.html`)).includes(value) && site.reports.get(`report.${lang}.md`).codes.includes(value));
  }
  ok(`${Object.keys(HOSTILE).length} hostile texts in ${Object.keys(PLACES).length} places, ${rendered} pages read back: only the report's own tags and words, each text whole, every link still the report's; long texts cut with their length; diacritics round trip`);
}

// =====================================================================================================================
// 12. determinism
// =====================================================================================================================
{
  const expected = new Map(listFiles(goldenOut).map((name) => [name, sha256(readFileSync(path.join(goldenOut, name)))]));
  const same = (folder, label) => assert.deepEqual(new Map(listFiles(folder).map((name) => [name, sha256(readFileSync(path.join(folder, name)))])), expected, label);
  // the packs under other names, in another folder, made by another process in another time zone and locale
  const moved = path.join(await newFolder('other place'), 'packs with a space');
  await fs.mkdir(moved);
  for (const [index, name] of readdirSync(GOLDEN_OPTIONS.packs).entries()) await fs.copyFile(path.join(GOLDEN_OPTIONS.packs, name), path.join(moved, `z${1000 - index}.json`));
  const work = await newFolder('determinism');
  const argv = (options, out) => ['--corpus', options.corpus, '--packs', options.packs, '--results', options.results, '--preregistration', options.preregistration, '--responses', options.responses, '--date', options.date, '--out', out];
  const again = node(REPORT, argv({ ...GOLDEN_OPTIONS, packs: moved }, path.join(work, 'again')), { env: { ...ENV, TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' } });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  same(path.join(work, 'again'), 'another process, folder, time zone and locale, other names of the packs');
  // the published folder holds everything the report is made of, and makes the same report again
  const published = { ...GOLDEN_OPTIONS, packs: path.join(goldenOut, 'packs'), results: path.join(goldenOut, 'results.jsonl'), preregistration: path.join(goldenOut, 'preregistration.json'), responses: path.join(goldenOut, 'responses') };
  await report.generateReport({ ...published, out: path.join(work, 'published') });
  same(path.join(work, 'published'), 'the published folder');
  // no clock, no locale, no chance; no order of keys, of packs or of tasks
  const reversed = (value) => (Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)])) : value);
  const files = packFiles(GOLDEN_PACKS);
  const registration = report.readRegistration({ bytes: readFileSync(GOLDEN_OPTIONS.preregistration), tasks: EXAMPLE_TASKS });
  const responses = new Map([['agent-b', report.readResponse(Buffer.from(GOLDEN_RESPONSE))]]);
  const saved = { Date: globalThis.Date, Intl: globalThis.Intl, toLocale: Number.prototype.toLocaleString, compare: String.prototype.localeCompare, random: Math.random, lower: String.prototype.toLocaleLowerCase };
  const refuse = (what) => function refused() { throw new Error(`${what} is not deterministic`); };
  let made;
  try {
    globalThis.Date = class { constructor(...args) { if (args.length === 0) throw new Error('a clock'); return new saved.Date(...args); } static now() { throw new Error('a clock'); } };
    globalThis.Intl = undefined;
    Number.prototype.toLocaleString = refuse('toLocaleString');
    String.prototype.localeCompare = refuse('localeCompare');
    String.prototype.toLocaleLowerCase = refuse('toLocaleLowerCase');
    Math.random = refuse('Math.random');
    made = report.renderFiles(report.readData({ tasks: reversed(EXAMPLE_TASKS).reverse(), jsonl: GOLDEN_JSONL, packs: [...files].reverse().map((file) => file.bytes), registration, responses, date: '2026-11-25' }));
  } finally {
    globalThis.Date = saved.Date;
    globalThis.Intl = saved.Intl;
    Number.prototype.toLocaleString = saved.toLocale;
    String.prototype.localeCompare = saved.compare;
    String.prototype.toLocaleLowerCase = saved.lower;
    Math.random = saved.random;
  }
  assert.deepEqual([...made.keys()].sort(), [...goldenFiles.keys()].sort());
  for (const [name, body] of made) assert.equal(body, goldenFiles.get(name), `${name}: the same bytes without a clock, a locale or an order`);
  // without a date there is none, and nothing else changes
  const undated = report.renderFiles(report.readData({ tasks: EXAMPLE_TASKS, jsonl: GOLDEN_JSONL, packs: files.map((file) => file.bytes), registration, responses, date: null }));
  assert.ok(!/20[0-9]{2}-[0-9]{2}-[0-9]{2}/.test(undated.get('report.en.md')), 'a report without a date names none');
  assert.deepEqual([...undated].filter(([name, body]) => body !== goldenFiles.get(name)).map(([name]) => name).sort(), ['en/index.html', 'report.en.md', 'report.vi.md', 'vi/index.html'], 'the date stands on the index alone');
  // what it is given is not changed
  const data = dataOf(EXAMPLE_TASKS, GOLDEN_PACKS, { registration, responses });
  const before = JSON.stringify([data.tasks, data.results, data.metrics, data.registration]);
  report.renderFiles(data);
  assert.equal(JSON.stringify([data.tasks, data.results, data.metrics, data.registration]), before);
  ok('the same bytes from packs under other names in another folder, another process, time zone and locale, without a clock, whatever the order of packs, tasks and keys; the published folder makes itself again; no date unless one is given');
}

// =====================================================================================================================
// 13. a large set
// =====================================================================================================================
{
  const tasks = Array.from({ length: 200 }, (_, index) => ({ ...TASKS[0], id: `t${String(index).padStart(3, '0')}`, task: { ...TASKS[0].task, id: `t${String(index).padStart(3, '0')}` } }));
  const agents = Array.from({ length: 10 }, (_, index) => `agent-${String.fromCharCode(97 + index)}`);
  const packs = [...controlsOf(tasks), ...agents.flatMap((agent, at) => fullRuns(tasks, agent, (task, repeat) => ({ passes: (at + repeat) % 4, proof: null })))];
  assert.equal(packs.length, 200 * 2 + 200 * 10 * 3);
  const data = dataOf(tasks, packs);
  const started = performance.now();
  const files = report.renderFiles(data);
  const seconds = (performance.now() - started) / 1000;
  assert.equal(files.size, 2 * (3 + 200 + 10) + 2);
  assert.ok(seconds < 30, `rendered in ${seconds.toFixed(1)} s`);
  const present = new Set([...files.keys(), ...copiesOf(data)]);
  // the pages that hold most links, followed; and one Markdown report
  const some = new Map([...files].filter(([name]) => ['en/index.html', 'en/agent-agent-j.html', 'en/task-t199.html', 'en/methods.html', 'en/responses.html', 'report.vi.md'].includes(name) || /^en\/task-t00/.test(name)));
  const { pages } = { pages: new Map([...files].filter(([name]) => name.endsWith('.html') && name.startsWith('en/')).map(([name, body]) => [name, readHtml(body, name)])) };
  for (const [name, page] of pages) {
    for (const { href } of page.links) {
      const [file, anchor] = href.split('#');
      const to = path.posix.join('en', file);
      assert.ok(present.has(to), `${name} -> ${href}`);
      if (anchor) assert.ok(pages.get(to).ids.includes(anchor), `${name} -> ${href}`);
    }
  }
  assert.equal(some.size, 16);
  const md = readMd(files.get('report.en.md'), 'the large Markdown report');
  assert.equal(new Set(md.links.map((link) => link.target).filter((target) => target.startsWith('packs/'))).size, packs.length, 'every pack of a large set is linked');
  ok(`200 tasks x 10 agents x 3 repeats (${packs.length} packs): ${files.size} files, ${[...pages.values()].reduce((sum, page) => sum + page.links.length, 0)} links followed`);
}

// =====================================================================================================================
// 14. a write that fails
// =====================================================================================================================
{
  const fsp = (await import('node:fs/promises')).default;
  const base = await newFolder('failing');
  const { writeFile, rename } = fsp;
  for (const nth of [1, 5, 25, 40]) {
    let calls = 0;
    fsp.writeFile = async (...args) => { calls += 1; if (calls === nth) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return writeFile(...args); };
    try { await assert.rejects(report.generateReport({ ...GOLDEN_OPTIONS, out: path.join(base, 'out') }), /ENOSPC/, `write ${nth} fails`); } finally { fsp.writeFile = writeFile; }
    assert.ok(calls >= nth, `(premise) write ${nth} was reached`);
    assert.deepEqual(readdirSync(base), [], `write ${nth} fails: nothing is left`);
  }
  // the folder appears while the report is made: it is not written over
  fsp.rename = async (from, to) => { await fsp.mkdir(to, { recursive: true }); await writeFile(path.join(to, 'mine.txt'), 'mine'); return rename(from, to); };
  try { await assert.rejects(report.generateReport({ ...GOLDEN_OPTIONS, out: path.join(base, 'out') }), (error) => error instanceof ReportError && error.code === 'out_exists'); } finally { fsp.rename = rename; }
  assert.deepEqual(listFiles(base), ['out/mine.txt'], 'what was there stays, and nothing else is left');
  ok('a write that fails, at any file, leaves nothing; a folder that appears meanwhile is not written over');
}

// =====================================================================================================================
// 15. the command line
// =====================================================================================================================
{
  const work = await newFolder('cli');
  const argv = ['--corpus', EXAMPLES, '--packs', GOLDEN_OPTIONS.packs, '--results', GOLDEN_OPTIONS.results];
  const made = node(REPORT, [...argv, '--out', path.join(work, 'out')]);
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /^report written to .*out \(\d+ pages, 22 run packs\): not registered, synthetic data\n$/);
  const missing = node(REPORT, [...argv, '--out', path.join(work, 'out')]);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /^refused: out_exists: /);
  const broken = node(REPORT, ['--corpus', EXAMPLES, '--packs', path.join(work, 'none'), '--results', GOLDEN_OPTIONS.results, '--out', path.join(work, 'b')]);
  assert.equal(broken.status, 3);
  assert.match(broken.stderr, /^refused: packs_missing: /);
  for (const args of [[], argv, [...argv, '--out'], [...argv, '--out', 'x', '--out', 'y'], [...argv, '--out', 'x', '--lang', 'en'], ['x', ...argv, '--out', 'y'], [...argv, '--out', 'x', '--tag', 'y']]) {
    const usage = node(REPORT, args);
    assert.equal(usage.status, 2, `${args.join(' ')}: ${usage.stderr}`);
    assert.match(usage.stderr, /^usage: node corpus\/tools\/report\.mjs /m);
  }
  assert.deepEqual(readdirSync(work), ['out'], 'a refused run writes nothing');
  ok('the command line: 0 when the report is written, 2 for a usage error, 3 for a refusal with its code');
}

// =====================================================================================================================
// 16. the documents
// =====================================================================================================================
{
  const doc = readFileSync(path.join(CORPUS, 'REPORT.md'), 'utf8');
  const sources = ['report.mjs', 'report-text.mjs', 'report-model.mjs', 'report-html.mjs', 'report-md.mjs'].map((name) => readFileSync(path.join(CORPUS, 'tools', name), 'utf8')).join('\n');
  const codes = new Set([...sources.matchAll(/refuse\('([a-z_]+)'/g)].map((match) => match[1]));
  assert.ok(codes.size >= 18, `the refusals of the sources: ${[...codes].join(', ')}`);
  for (const code of codes) assert.ok(doc.includes(`\`${code}\``), `REPORT.md names the refusal ${code}`);
  for (const word of ['Not verified', 'synthetic', 'results.jsonl', 'byte for byte', 'file://', 'Content-Security-Policy', 'corpus/templates', '--preregistration', '--tag', '--responses', '--date', 'kill rule', 'no comparison', 'sha256']) assert.ok(doc.includes(word), `REPORT.md says ${word}`);
  const readme = readFileSync(path.join(CORPUS, 'README.md'), 'utf8');
  for (const name of ['tools/report.mjs', 'tools/render.mjs', 'templates/', 'REPORT.md']) assert.ok(readme.includes(name), `corpus/README.md lists ${name}`);
  ok(`corpus/REPORT.md names all ${codes.size} refusals of the tool, the inputs, the output and what is not verified; corpus/README.md lists the new files`);
}

await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
console.log(`PASS: ${checks} corpus-report checks (dictionaries and the wording lint, numbers, golden report, recompute and refusals, links, pages, banner and a real freeze, kill rule, edge sets, order, hostile texts, determinism, a large set, failing writes, command line, documents)`);
