// search_files and find_files with ripgrep (multi-agent-tools-19), against a real workspace:
//   1. what LocalTools asks ripgrep for (the folder, the options, the file filter), and that what comes back is checked again;
//   2. the answer is formatted exactly as the built-in search formats it, whichever engine found the lines;
//   3. anything ripgrep cannot do falls back to the built-in search, a cancelled search does not;
//   4. without ripgrep the files of a Git repository come from Git (so .gitignore is honoured) and never through a link; otherwise the tree is walked as before;
//   5. with the real ripgrep (when the machine has one): the same match sets as the built-in search over this repository's own lib/, and the plan's special cases.
// The model ripgrep below is a small JavaScript stand-in that speaks ripgrep's JSON, so the contract is tested on every machine.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { compileGlob } from '../lib/glob.mjs';
import { LIMITS, LocalTools, NOISE_DIRECTORIES } from '../lib/local-tools.mjs';
import { PRIVATE_DIRECTORIES } from '../lib/protected-paths.mjs';
import { RIPGREP_ENV, Ripgrep, basenameTypeGlob, compareWalkOrder, createSearchCollector } from '../lib/ripgrep.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import './ripgrep.test.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const textOf = (result) => result.content.map((part) => part.text).join('\n');
const errorCode = (result) => result.structuredContent?.error?.code;
const body = (result) => textOf(result).split('\n').slice(1).join('\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let haveGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { haveGit = false; }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
setTimeout(() => { console.error('FAIL: the ripgrep search suite exceeded its own time budget'); process.exit(2); }, 560_000).unref();

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-search-rg-'));
let numbered = 0;
const cleanup = () => fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 }).catch(() => console.warn(`  (could not remove ${root})`));

/** A workspace holding `files` ({ path: string | Buffer }) and the LocalTools of it, with the ripgrep given (null: the built-in search). */
async function workspaceOf(files, { ripgrep = null, initGit = false, gitRunner = null } = {}) {
  numbered += 1;
  const directory = path.join(root, `work-${numbered}`);
  const state = path.join(root, `state-${numbered}`);
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(state, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  if (initGit) {
    git(directory, 'init', '-q');
    git(directory, 'config', 'user.email', 'test@example.invalid');
    git(directory, 'config', 'user.name', 'Test');
  }
  const workspace = new StudioWorkspace({ manager: { workspace: directory, secrets: [] }, directory: state });
  const tools = new LocalTools({ workspace, stateDirectory: state, ripgrep, ...(gitRunner ? { git: gitRunner } : {}) });
  return { directory, state, workspace, tools, call: (name, args, context) => tools.call(name, args, context), root: (await workspace.resolve('')).root };
}

// ---------------------------------------------------------------------------------------------------------------------------------- a model of ripgrep
/**
 * What ripgrep does with the options LocalTools gives it, in JavaScript: it walks the folder (hidden files in; links, private names and, as folders, noise names out; files over
 * 1 MiB out), skips binary files, decodes UTF-8 and UTF-16 with a BOM, and speaks the JSON of `rg --json` which the real collector reads. It does not know .gitignore.
 */
function modelRipgrep({ pcre2 = true, fail = null, ignoreOptions = false, spy = null, listing = {}, binaryEvents = false, flags = {} } = {}) {
  const calls = { search: [], files: [] };
  const listFiles = async (start, { privateNames, noiseNames, includeIgnored }) => {
    const found = [];
    const visit = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (!ignoreOptions && privateNames.includes(entry.name)) continue;
        if (entry.isDirectory()) {
          if (!ignoreOptions && !includeIgnored && noiseNames.includes(entry.name)) continue;
          await visit(absolute);
        } else if (entry.isFile()) found.push(absolute);
      }
    };
    await visit(start);
    // ripgrep walks in parallel and gives files in no order: backwards here, so that a caller which forgets to sort is noticed
    return found.sort((a, b) => compareWalkOrder(a.split(path.sep).join('/'), b.split(path.sep).join('/'))).reverse();
  };
  const decode = (buffer) => {
    if (buffer.includes(0) && !(buffer[0] === 0xff && buffer[1] === 0xfe)) return { binary: true };
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return { text: buffer.subarray(2).toString('utf16le') };
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return { text: buffer.subarray(3).toString('utf8') };
    const text = buffer.toString('utf8');
    return text.includes('\ufffd') ? { bytes: true } : { text };
  };
  return {
    calls,
    async info() { return { path: 'model-rg', source: 'env', version: '14.1.1', pcre2 }; },
    async search(options) {
      calls.search.push(options);
      spy?.(options);
      const failure = typeof fail === 'function' ? fail(options) : fail;
      if (failure) throw failure;
      const accept = ignoreOptions ? () => true : options.accept;
      const collector = createSearchCollector({ limit: options.limit, context: options.context, accept, platform: 'linux' });
      const start = path.resolve(options.directory, options.target);
      const stat = await fs.stat(start);
      const files = stat.isDirectory() ? await listFiles(start, options) : [start];
      const test = options.regex
        ? (() => { const expression = new RegExp(options.pattern, options.ignoreCase ? 'i' : ''); return (line) => expression.test(line); })()
        : (line) => (options.ignoreCase ? line.toLowerCase().includes(options.pattern.toLowerCase()) : line.includes(options.pattern));
      let searched = 0;
      let stopped = false;
      for (const absolute of files) {
        const info = await fs.stat(absolute);
        if (info.size > 1024 * 1024) continue;
        searched += 1;
        const decoded = decode(await fs.readFile(absolute));
        const local = path.relative(options.directory, absolute).split(path.sep).join('/');
        if (decoded.binary) {
          // ripgrep says nothing about a binary file it met on a walk, unless it was named; with `binaryEvents` the model does what it does for a named one
          if (binaryEvents) for (const event of [{ type: 'begin', data: { path: { text: local } } }, { type: 'end', data: { path: { text: local }, binary_offset: 2 } }]) collector.push(event);
          continue;
        }
        const lines = decoded.text === undefined ? [] : decoded.text.split('\n').map((line, at, all) => (at < all.length - 1 || line.length ? `${line}\n` : null)).filter((line) => line !== null);
        const hits = new Set();
        lines.forEach((line, at) => { if (test(line.replace(/\r?\n$/, ''))) hits.add(at); });
        if (decoded.bytes) { if (hits.size === 0 && !lines.length) { /* the model has no byte-level matching */ } }
        if (hits.size === 0) continue;
        const shown = new Set();
        for (const at of hits) for (let n = Math.max(0, at - options.context); n <= Math.min(lines.length - 1, at + options.context); n += 1) shown.add(n);
        const events = [{ type: 'begin', data: { path: { text: local } } }];
        for (const at of [...shown].sort((a, b) => a - b)) {
          events.push({ type: hits.has(at) ? 'match' : 'context', data: { path: { text: local }, lines: { text: lines[at] }, line_number: at + 1, absolute_offset: 0, submatches: [] } });
        }
        events.push({ type: 'end', data: { path: { text: local }, binary_offset: null } });
        for (const event of events) if (collector.push(event) === 'stop') { stopped = true; break; }
        if (stopped) break;
      }
      if (!stopped) collector.push({ type: 'summary', data: { stats: { searches: searched } } });
      return { ...collector.finish(), stopped, timedOut: Boolean(flags.timedOut), outputTruncated: Boolean(flags.outputTruncated) };
    },
    async files(options) {
      calls.files.push(options);
      spy?.(options);
      const failure = typeof fail === 'function' ? fail(options) : fail;
      if (failure) throw failure;
      const accept = ignoreOptions ? () => true : options.accept;
      const start = path.resolve(options.directory, options.target);
      const found =(await listFiles(start, options)).map((absolute) => path.relative(options.directory, absolute).split(path.sep).join('/')).filter((local) => accept(local));
      return { files: found, truncated: Boolean(listing.truncated), timedOut: Boolean(listing.timedOut), outputTruncated: Boolean(listing.outputTruncated) };
    },
  };
}

const sampleFiles = {
  'README.md': '# Demo\n\nA tiny project with a needle in it.\n',
  'src/app.js': 'const needle = 1;\r\nfunction go() { return needle; }\r\n\r\nconst tail = "end";\r\n',
  'src/lib/util.js': 'export const needle2 = 2;\nexport const other = 3;\n// a needle in a comment\n',
  'src/lib/deep/tool.py': 'def needle():\n    return 1\n',
  'src/z.js': 'needle();\n',
  'docs/readme.md': 'A needle in the docs.\n-x is an option-like text\n',
  'blank.txt': 'first\n\nneedle\n   \nlast\n',
  'long.txt': `needle ${'y'.repeat(500)}\n`,
  'mid.txt': `needle ${'z'.repeat(350)}\n`,
  'enc/utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('needle in utf16\r\nsecond\r\n', 'utf16le')]),
  'enc/bom.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('needle with bom\n')]),
  'enc/unicode.txt': 'Tiếng Việt: kim chỉ nam needle\nÉcole\n',
  '.hidden/note.txt': 'needle in a hidden folder\n',
  'a b/space name.js': 'needle in a folder with a space\n',
  '.env': 'API_KEY=needle-secret\n',
  'id_rsa': '-----BEGIN PRIVATE KEY-----\nneedle-private\n-----END PRIVATE KEY-----\n',
  '.ssh/config': 'Host needle\n',
  'node_modules/pkg/index.js': 'module.exports = "needle noise";\n',
  'build/out.js': 'var needle = "build";\n',
};

try {
  // ------------------------------------------------------------------------------------------------------------------------------ 1. what ripgrep is asked
  {
    const model = modelRipgrep();
    const w = await workspaceOf(sampleFiles, { ripgrep: model });
    const typeGlob = (glob) => basenameTypeGlob(glob, { caseInsensitive: isWindows });
    await w.call('search_files', { pattern: 'needle', glob: 'src/**/*.js', ignore_case: true, context: 2, limit: 7 });
    let asked = model.calls.search.at(-1);
    assert.equal(asked.directory, w.root, 'it runs in the workspace folder');
    assert.equal(asked.target, '.');
    assert.deepEqual([asked.pattern, asked.regex, asked.ignoreCase, asked.context, asked.includeIgnored, asked.limit, asked.timeoutMs], ['needle', false, true, 2, false, 7, LIMITS.searchMillis]);
    assert.equal(asked.typeGlob, typeGlob('src/**/*.js'), 'the glob is handed over as a narrowing of the file name only (never as a -g include, which would bring back ignored files)');
    assert.deepEqual(asked.noiseNames, [...NOISE_DIRECTORIES]);
    assert.deepEqual(asked.privateNames, [...PRIVATE_DIRECTORIES]);
    assert.ok(asked.signal === undefined || asked.signal === null || asked.signal instanceof AbortSignal);
    // the filter it is given: the Hub decides which files are results
    assert.equal(asked.accept('src/a.js'), true);
    assert.equal(asked.accept('src/lib/deep/b.js'), true);
    assert.equal(asked.accept('.env'), false, 'secrets');
    assert.equal(asked.accept('src/.env'), false, 'secrets at any depth');
    assert.equal(asked.accept('id_rsa'), false);
    assert.equal(asked.accept('.git/config'), false, 'Git metadata');
    assert.equal(asked.accept('x/.SSH/config'), false, 'private folders in any case');
    assert.equal(asked.accept('node_modules/p/i.js'), false, 'noise folders');
    assert.equal(asked.accept('src/node_modules/p/i.js'), false, 'at any depth');
    assert.equal(asked.accept('src/build/o.js'), false);
    assert.equal(asked.accept('docs/x.md'), false, 'a file the glob does not match');
    assert.equal(asked.accept('src/readme.txt'), false, 'the exact glob, not only the file name');

    await w.call('search_files', { pattern: 'x' });
    asked = model.calls.search.at(-1);
    assert.equal(asked.typeGlob, null, 'no glob, nothing to narrow');
    assert.equal(asked.accept('node_modules'), true, 'a FILE called node_modules is not a noise folder');
    assert.equal(asked.accept('node_modules/p/i.js'), false);
    assert.equal(asked.accept('Node_Modules/p/i.js'), true, 'the names of noise folders are matched exactly, as the walk does');
    assert.equal(asked.accept('a/.hidden/b.txt'), true, 'hidden folders are searched');

    await w.call('search_files', { pattern: 'a.b', regex: true, include_ignored: true });
    asked = model.calls.search.at(-1);
    assert.deepEqual([asked.regex, asked.includeIgnored, asked.context, asked.limit, asked.ignoreCase], [true, true, 0, 100, false]);
    assert.equal(asked.typeGlob, null);
    assert.equal(asked.accept('node_modules/p/i.js'), true, 'include_ignored brings the noise folders back');
    assert.equal(asked.accept('.env'), false, 'but never the secrets');
    assert.equal(asked.accept('.git/config'), false);

    await w.call('search_files', { pattern: 'needle', path: 'src', glob: 'lib/*.js' });
    asked = model.calls.search.at(-1);
    assert.equal(asked.directory, path.join(w.root, 'src'), 'a folder is searched from inside it');
    assert.equal(asked.target, '.');
    assert.equal(asked.accept('lib/util.js'), true, 'paths are relative to it, and so is the glob');
    assert.equal(asked.accept('src/lib/util.js'), false);
    assert.equal(asked.accept('.env'), false);

    await w.call('search_files', { pattern: 'needle', path: 'src/app.js' });
    asked = model.calls.search.at(-1);
    assert.equal(asked.directory, path.join(w.root, 'src'), 'a file is searched from its folder');
    assert.equal(asked.target, 'app.js');
    assert.equal(asked.accept('app.js'), true);

    await w.call('find_files', { pattern: '**/*.py', limit: 12 });
    asked = model.calls.files.at(-1);
    assert.equal(asked.directory, w.root);
    assert.equal(asked.target, '.');
    assert.equal(asked.includeIgnored, false);
    assert.equal(asked.typeGlob, typeGlob('**/*.py'));
    assert.equal(asked.accept('src/lib/deep/tool.py'), true);
    assert.equal(asked.accept('src/app.js'), false, 'only what the glob matches is kept');
    assert.equal(asked.accept('.env'), false);
    assert.equal(asked.accept('node_modules/x.py'), false);
    assert.deepEqual(asked.noiseNames, [...NOISE_DIRECTORIES]);
    assert.ok(asked.maxFiles >= 1000, 'a bound exists, and is not the limit asked for');
    ok('LocalTools asks ripgrep for the workspace folder (or the folder/file searched), the options, a narrowed glob and a filter that refuses secrets, Git metadata, noise folders and files the exact glob does not match');
  }

  // ------------------------------------------------------------------------------------------------------------------------------ 2. the same text as the built-in search
  {
    const model = modelRipgrep();
    const withRg = await workspaceOf(sampleFiles, { ripgrep: model });
    const withoutRg = await workspaceOf(sampleFiles);
    // ripgrep finds files in no particular order (the model below returns them backwards), so when a limit cuts the result which matches are kept may differ; the text is then
    // compared by its size, not its lines
    const same = async (args, label) => {
      const a = await withRg.call('search_files', args);
      const b = await withoutRg.call('search_files', args);
      assert.equal(a.isError, b.isError, label);
      if (args.limit === undefined) assert.equal(body(a), body(b), `${label}: the lines`);
      else assert.equal(a.structuredContent.matches, b.structuredContent.matches, `${label}: as many matches`);
      for (const field of ['matches', 'truncated']) assert.equal(a.structuredContent?.[field], b.structuredContent?.[field], `${label}: ${field}`);
      if (args.limit === undefined) assert.equal(a.structuredContent?.files, b.structuredContent?.files, `${label}: files`);
      return a;
    };
    const first = await same({ pattern: 'needle' }, 'literal');
    assert.equal(first.structuredContent.engine, 'ripgrep');
    assert.equal((await withoutRg.call('search_files', { pattern: 'needle' })).structuredContent.engine, 'walk');
    assert.ok(!textOf(first).includes('needle-secret') && !textOf(first).includes('needle-private') && !textOf(first).includes('needle noise') && !textOf(first).includes('Host needle'), 'secrets, private folders and noise folders are not in it');
    assert.ok(textOf(first).includes('.hidden/note.txt:1:') && textOf(first).includes('enc/utf16.txt:1: needle in utf16'), 'hidden folders and UTF-16 files are');
    await same({ pattern: 'NEEDLE', ignore_case: true }, 'ignore case');
    await same({ pattern: 'NEEDLE' }, 'case-sensitive, no result');
    await same({ pattern: 'need\\w+\\(', regex: true }, 'regex');
    await same({ pattern: '^$', regex: true }, 'blank lines');
    await same({ pattern: 'needle', context: 1 }, 'context 1');
    await same({ pattern: 'needle', context: 3 }, 'context 3');
    await same({ pattern: 'needle', glob: '*.js' }, 'glob by name');
    await same({ pattern: 'needle', glob: 'src/**/*.js' }, 'glob by path');
    await same({ pattern: 'needle', glob: '*.{py,md}', context: 1 }, 'glob with braces and context');
    await same({ pattern: 'needle', path: 'src' }, 'a folder');
    await same({ pattern: 'needle', path: 'src', glob: 'lib/*.js', context: 1 }, 'a folder and a glob relative to it');
    await same({ pattern: 'needle', path: 'src/app.js', context: 1 }, 'a file');
    await same({ pattern: 'needle', path: 'src/app.js', glob: 'src/*.js' }, 'a file and a glob that is relative to the workspace');
    await same({ pattern: 'needle', path: 'src/app.js', glob: '*.py' }, 'a file the glob does not match');
    await same({ pattern: 'need', path: 'long.txt' }, 'a long line is cut');
    const middling = await same({ pattern: 'need', path: 'mid.txt' }, 'a line only a little over the limit is cut too');
    assert.match(textOf(middling), /… \[đã cắt 57 ký tự\]/, 'at 300 characters, with the number of those left out');
    await same({ pattern: '-x' }, 'a pattern that looks like an option');
    await same({ pattern: 'needle', include_ignored: true }, 'include_ignored');
    await same({ pattern: 'needle', limit: 3 }, 'a limit');
    await same({ pattern: 'needle', limit: 3, context: 2 }, 'a limit with context');
    await same({ pattern: 'return', context: 1, limit: 1 }, 'a limit of one');
    const cut = await withRg.call('search_files', { pattern: 'needle', limit: 3 });
    assert.equal(cut.structuredContent.truncated, true);
    assert.match(textOf(cut), /Đã dừng ở 3 kết quả/);
    assert.match(textOf(await withRg.call('search_files', { pattern: 'needle', ignore_case: true })), /^\d+ kết quả trong \d+ file \(đã quét \d+ file\) cho chuỗi "needle"/, 'the head line says how many files were looked at');
    ok('whichever engine finds the lines, the text is the same: literal and regex, case, context and its separators, glob, folder and file, long and blank lines, the limit and what it cuts');
  }

  // the notes under a result: files that were not text, a search out of time, an answer too large to read
  {
    const files = { 'a.txt': 'needle\n', 'blob.bin': Buffer.from([110, 101, 0, 1]) };
    const w = await workspaceOf(files, { ripgrep: modelRipgrep({ binaryEvents: true }) });
    const result = await w.call('search_files', { pattern: 'needle' });
    assert.equal(result.structuredContent.skipped, 1);
    assert.equal(result.structuredContent.scanned, 1, 'two files were opened and one of them is not text');
    assert.match(textOf(result), /\(đã quét 1 file\)/);
    assert.match(textOf(result), /\[1 file bị bỏ qua/);
    assert.equal(result.structuredContent.truncated, false);
    for (const [flag, note] of [['timedOut', /Đã dừng sau 10s/], ['outputTruncated', /Có quá nhiều kết quả/]]) {
      const slow = await workspaceOf(files, { ripgrep: modelRipgrep({ flags: { [flag]: true } }) });
      const cut = await slow.call('search_files', { pattern: 'needle' });
      assert.equal(cut.structuredContent.truncated, true, flag);
      assert.match(textOf(cut), note, flag);
      assert.equal(cut.structuredContent.matches, 1, `${flag}: what was found is still shown`);
    }
    ok('a search that was cut short says so (time, size, the files that were not text) and still shows what it found');
  }

  // ------------------------------------------------------------------------------------------------------------------------------ 3. what comes back is checked again
  {
    const hostile = modelRipgrep({ ignoreOptions: true });
    const w = await workspaceOf(sampleFiles, { ripgrep: hostile });
    const result = await w.call('search_files', { pattern: 'needle' });
    for (const secret of ['needle-secret', 'needle-private', 'Host needle', 'needle noise', 'var needle = "build"']) assert.ok(!textOf(result).includes(secret), `${secret} must not come through even when ripgrep returns it`);
    assert.ok(textOf(result).includes('src/z.js:1:'), 'the rest does');
    const listing = await w.call('find_files', { pattern: '**/*' });
    for (const hidden of ['.env', 'id_rsa', '.ssh/config', 'node_modules/pkg/index.js', 'build/out.js']) assert.ok(!textOf(listing).split('\n').includes(hidden), `${hidden} must not be listed even when ripgrep returns it`);
    ok('files that ripgrep returns although they were refused (secrets, private folders, noise folders) are dropped again before anything is shown');
  }

  // ------------------------------------------------------------------------------------------------------------------------------ 4. what ripgrep cannot do goes to the built-in search; a cancel does not
  {
    const reference = await workspaceOf(sampleFiles);
    const expected = await reference.call('search_files', { pattern: 'needle', context: 1 });
    for (const code of ['ripgrep_pattern', 'ripgrep_failed', 'ripgrep_unavailable', 'ripgrep_pcre2_unavailable']) {
      const model = modelRipgrep({ fail: Object.assign(new Error(`${code} for the test`), { code }) });
      const w = await workspaceOf(sampleFiles, { ripgrep: model });
      const result = await w.call('search_files', { pattern: 'needle', context: 1 });
      assert.equal(result.isError, false, code);
      assert.equal(body(result), body(expected), `${code}: the built-in search answers`);
      assert.equal(result.structuredContent.engine, 'walk');
      assert.equal(model.calls.search.length, 1, `${code}: ripgrep was tried`);
      const listing = await w.call('find_files', { pattern: '*.py' });
      assert.equal(listing.isError, false);
      assert.match(textOf(listing), /tool\.py/);
    }
    // an error that is not one of ripgrep's own failures is a bug: it is shown to the caller, not hidden behind another engine
    {
      const buggy = await workspaceOf(sampleFiles, { ripgrep: modelRipgrep({ fail: new TypeError('a bug in the search') }) });
      const result = await buggy.call('search_files', { pattern: 'needle' });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /a bug in the search/);
      const listing = await buggy.call('find_files', { pattern: '*.js' });
      assert.equal(listing.isError, true);
      assert.match(textOf(listing), /a bug in the search/);
    }
    // a regex that ripgrep cannot read but JavaScript can
    const refusing = modelRipgrep({ fail: (options) => (options.pattern === '[^]needle' ? Object.assign(new Error('regex parse error'), { code: 'ripgrep_pattern' }) : null) });
    const w = await workspaceOf(sampleFiles, { ripgrep: refusing });
    const odd = await w.call('search_files', { pattern: '[^]needle', regex: true });
    assert.equal(odd.isError, false);
    assert.match(textOf(odd), /src\/app\.js:1:/);
    // a backreference: allowed for ripgrep+PCRE2 only; when ripgrep then fails, the in-process engine must not run it
    const failing = modelRipgrep({ fail: Object.assign(new Error('boom'), { code: 'ripgrep_failed' }) });
    const f = await workspaceOf(sampleFiles, { ripgrep: failing });
    assert.equal(errorCode(await f.call('search_files', { pattern: '(n)eedle \\1', regex: true })), 'bad_pattern', 'a backreference is never run in-process');
    // a cancelled search is not repeated by another engine
    const controller = new AbortController();
    const reason = Object.assign(new Error('stopped by the owner'), { code: 'cancelled' });
    const cancelling = modelRipgrep({ fail: () => { controller.abort(reason); return reason; } });
    const c = await workspaceOf(sampleFiles, { ripgrep: cancelling });
    await assert.rejects(c.call('search_files', { pattern: 'needle' }, { signal: controller.signal }), (error) => error === reason, 'a cancelled search ends with the reason it was cancelled for');
    assert.equal(cancelling.calls.search.length, 1, 'and is not repeated by another engine');
    ok('ripgrep missing, failing, refusing the pattern or without PCRE2: the built-in search answers (a backreference is then refused, not run in-process); a cancelled search is not repeated');
  }

  // ------------------------------------------------------------------------------------------------------------------------------ 5. which patterns go to ripgrep
  {
    const withPcre2 = modelRipgrep({ pcre2: true });
    const a = await workspaceOf(sampleFiles, { ripgrep: withPcre2 });
    const lookahead = await a.call('search_files', { pattern: 'needle(?= =)', regex: true });
    assert.equal(lookahead.isError, false);
    assert.equal(withPcre2.calls.search.length, 1, 'lookahead goes to ripgrep when it has PCRE2');
    assert.match(textOf(lookahead), /src\/app\.js:1:/);
    const backreference = await a.call('search_files', { pattern: '(need)le .* \\1', regex: true });
    assert.equal(backreference.isError, false, 'and so does a backreference');
    assert.equal(withPcre2.calls.search.length, 2);
    for (const dangerous of ['(a+)+$', '(a|b)*c', 'a*a*a*a*a*b']) assert.equal(errorCode(await a.call('search_files', { pattern: dangerous, regex: true })), 'bad_pattern', `${dangerous} stays refused`);
    assert.equal(errorCode(await a.call('search_files', { pattern: '(', regex: true })), 'bad_pattern');
    assert.equal(withPcre2.calls.search.length, 2, 'a refused pattern never reaches ripgrep');
    // a pattern with a line end can never match one line, and is not a command-line argument ripgrep could take
    const newline = await a.call('search_files', { pattern: 'needle\nsecond' });
    assert.equal(newline.isError, false);
    assert.equal(withPcre2.calls.search.length, 2);
    assert.match(textOf(newline), /^0 kết quả/);

    const withoutPcre2 = modelRipgrep({ pcre2: false });
    const b = await workspaceOf(sampleFiles, { ripgrep: withoutPcre2 });
    const built = await b.call('search_files', { pattern: 'needle(?= =)', regex: true });
    assert.equal(built.isError, false);
    assert.equal(withoutPcre2.calls.search.length, 0, 'without PCRE2 a lookahead is searched in-process (JavaScript has it)');
    assert.match(textOf(built), /src\/app\.js:1:/);
    assert.equal(errorCode(await b.call('search_files', { pattern: '(need)le .* \\1', regex: true })), 'bad_pattern', 'and a backreference is refused, as it always was');
    const plain = await b.call('search_files', { pattern: 'need\\w+', regex: true });
    assert.equal(plain.isError, false);
    assert.equal(withoutPcre2.calls.search.length, 1, 'an ordinary regex still goes to ripgrep');
    ok('lookahead and backreferences go to ripgrep with PCRE2 (in-process: lookahead only, a backreference is refused), ReDoS shapes and unreadable patterns are refused first, a pattern with a line end stays in-process');
  }

  // ------------------------------------------------------------------------------------------------------------------------------ 6. find_files
  {
    const model = modelRipgrep();
    const withRg = await workspaceOf(sampleFiles, { ripgrep: model });
    const without = await workspaceOf(sampleFiles);
    for (const args of [{ pattern: '*.js' }, { pattern: '**/*.js' }, { pattern: 'src/*.js' }, { pattern: '*.{py,md}' }, { pattern: '**/*' , limit: 500 }, { pattern: '*.txt', path: 'enc' }, { pattern: 'lib/*.js', path: 'src' }, { pattern: '*.js', include_ignored: true }, { pattern: '*.JS' }, { pattern: 'readme.*' }, { pattern: 'space*' }, { pattern: '*.js', limit: 2 }, { pattern: '**/*', limit: 5 }]) {
      const a = await withRg.call('find_files', args);
      const b = await without.call('find_files', args);
      assert.equal(textOf(a), textOf(b), JSON.stringify(args));
      assert.equal(a.structuredContent.count, b.structuredContent.count);
      assert.equal(a.structuredContent.truncated, b.structuredContent.truncated);
    }
    assert.equal((await withRg.call('find_files', { pattern: '*.js' })).structuredContent.engine, 'ripgrep');
    assert.equal((await without.call('find_files', { pattern: '*.js' })).structuredContent.engine, 'walk');
    const limited = await withRg.call('find_files', { pattern: '*.js', limit: 2 });
    assert.equal(limited.structuredContent.count, 2);
    assert.equal(limited.structuredContent.truncated, true);
    assert.deepEqual(textOf(limited).split('\n').slice(1, 3), ['a b/space name.js', 'src/app.js'], 'the first by the walk order: the files of a folder, then its folders in order');
    const broken = await workspaceOf(sampleFiles, { ripgrep: modelRipgrep({ fail: Object.assign(new Error('boom'), { code: 'ripgrep_failed' }) }) });
    assert.equal(textOf(await broken.call('find_files', { pattern: '*.py' })), textOf(await without.call('find_files', { pattern: '*.py' })), 'a failing ripgrep: the walk');
    assert.equal(errorCode(await withRg.call('find_files', { pattern: '' })), errorCode(await without.call('find_files', { pattern: '' })), 'an empty glob is refused the same way');
    assert.equal(errorCode(await withRg.call('find_files', { pattern: '*/*/*/*/*/*/*/*/*' })), 'bad_pattern');
    for (const [flag, what] of [['truncated', 'a list that was cut'], ['timedOut', 'a listing that ran out of time'], ['outputTruncated', 'a listing that printed too much']]) {
      const w = await workspaceOf(sampleFiles, { ripgrep: modelRipgrep({ listing: { [flag]: true } }) });
      const cut = await w.call('find_files', { pattern: '*.js' });
      assert.equal(cut.structuredContent.truncated, true, what);
      assert.match(textOf(cut), /quá nhiều mục/, `${what}: the model is told to narrow the search`);
    }
    ok('find_files gives the same list through ripgrep as through the walk: globs, folders, include_ignored, the limit and the walk order');
  }

  // ------------------------------------------------------------------------------------------------------------------------------ 7. without ripgrep: Git's file list, or the walk
  if (haveGit) {
    const files = { '.gitignore': 'generated/\n*.min.js\n', 'src/app.js': 'const needle = 1;\n', 'src/lib.min.js': 'var needle = 1;\n', 'generated/out.js': 'var needle = 2;\n', 'notes.md': 'needle note\n',
      '.hidden/h.txt': 'needle hidden\n', 'node_modules/p/i.js': 'needle noise\n', '.env': 'KEY=needle\n', 'src/gone.js': 'needle gone\n' };
    const g = await workspaceOf(files, { initGit: true });
    git(g.directory, 'add', '.gitignore', 'src/app.js', 'src/gone.js', 'notes.md');
    await fs.rm(path.join(g.directory, 'src', 'gone.js'));
    const search = await g.call('search_files', { pattern: 'needle' });
    assert.equal(search.structuredContent.engine, 'git');
    const hits = textOf(search).split('\n').filter((line) => /:\d+:/.test(line)).map((line) => line.split(':')[0]).sort();
    assert.deepEqual(hits, ['.hidden/h.txt', 'notes.md', 'src/app.js'], 'what .gitignore excludes is not searched; hidden files are; secrets, noise folders and a file that was deleted are not');
    assert.ok(!textOf(await g.call('search_files', { pattern: 'needle', glob: '*.js' })).includes('generated'), 'and a glob does not bring it back');
    const ignored = await g.call('search_files', { pattern: 'needle', include_ignored: true });
    assert.equal(ignored.structuredContent.engine, 'walk');
    assert.ok(textOf(ignored).includes('generated/out.js:1:') && textOf(ignored).includes('src/lib.min.js:1:') && textOf(ignored).includes('node_modules/p/i.js:1:'), 'include_ignored walks the whole tree');
    assert.ok(!textOf(ignored).includes('KEY=needle'), 'secrets still never');
    const found = await g.call('find_files', { pattern: '**/*.js' });
    assert.equal(found.structuredContent.engine, 'git');
    assert.deepEqual(textOf(found).split('\n').slice(1).filter(Boolean), ['src/app.js'], 'find_files leaves out the ignored files too');
    assert.equal(textOf(await g.call('find_files', { pattern: '*.js', include_ignored: true })).includes('generated/out.js'), true);
    const folder = await g.call('search_files', { pattern: 'needle', path: 'src' });
    assert.deepEqual(textOf(folder).split('\n').filter((line) => /:\d+:/.test(line)), ['src/app.js:1: const needle = 1;'], 'a folder is listed by Git from inside it');
    // Git lists in the order of its index; the answer is in the order of the walk, whichever engine gave the files
    const tracked = { 'z.js': 'x\n', 'a.js': 'x\n', 'a/b.js': 'x\n', 'b/c.js': 'x\n', 'a/deep/d.js': 'x\n' };
    const ordered = await workspaceOf(tracked, { initGit: true });
    git(ordered.directory, 'add', '.');
    const unordered = await workspaceOf(tracked);
    const viaGit = await ordered.call('find_files', { pattern: '*.js' });
    assert.equal(viaGit.structuredContent.engine, 'git');
    assert.equal(textOf(viaGit), textOf(await unordered.call('find_files', { pattern: '*.js' })), 'the same list in the same order as the walk');
    assert.deepEqual(textOf(viaGit).split('\n').slice(1), ['a.js', 'z.js', 'a/b.js', 'a/deep/d.js', 'b/c.js'], 'the files of a folder, then its folders');
    // a repository with more files than the search will look at says so
    const hugeList = { text: async () => ({ code: 0, stdout: `${Array.from({ length: LIMITS.walkEntries + 1 }, (_, i) => `gen/f${i}.js`).join('\0')}\0` }) };
    const huge = await workspaceOf({ 'a.txt': 'x\n' }, { gitRunner: hugeList });
    const bounded = await huge.call('find_files', { pattern: '*.js' });
    assert.equal(bounded.structuredContent.engine, 'git');
    assert.equal(bounded.structuredContent.truncated, true);
    assert.match(textOf(bounded), /quá nhiều mục/);
    // not a repository, or a Git that cannot answer: the walk of the tree
    const plain = await workspaceOf(files);
    const walked = await plain.call('search_files', { pattern: 'needle' });
    assert.equal(walked.structuredContent.engine, 'walk');
    assert.ok(textOf(walked).includes('generated/out.js:1:'), 'the walk does not know .gitignore');
    // a folder named on purpose is searched even when .gitignore excludes it (ripgrep does the same): Git has nothing to list there, so the tree is walked
    const named = await g.call('search_files', { pattern: 'needle', path: 'generated' });
    assert.ok(textOf(named).includes('generated/out.js:1:'), 'an ignored folder that is asked for by name is searched');
    assert.equal(named.structuredContent.engine, 'walk');
    // a link is never followed, by either engine (Git for Windows lists what a junction points to)
    const outside = path.join(root, 'outside-the-workspace');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'leak.js'), 'needle outside\n');
    let linkable = true;
    try {
      for (const workspaceDirectory of [g.directory, plain.directory]) {
        await fs.symlink(outside, path.join(workspaceDirectory, 'escape'), 'junction');
        await fs.symlink(path.join(workspaceDirectory, 'src'), path.join(workspaceDirectory, 'alias'), 'junction');
      }
    } catch { linkable = false; }
    for (const workspaceDirectory of [g.directory, plain.directory]) {
      try { await fs.symlink(path.join(outside, 'leak.js'), path.join(workspaceDirectory, 'leak-link.js'), 'file'); } catch { /* a file link needs a privilege on Windows */ }
    }
    if (linkable) {
      for (const [label, tools] of [['git', g], ['walk', plain]]) {
        const viaLinks = await tools.call('search_files', { pattern: 'needle' });
        assert.ok(!textOf(viaLinks).includes('needle outside') && !textOf(viaLinks).includes('escape/') && !textOf(viaLinks).includes('alias/') && !textOf(viaLinks).includes('leak-link'), `${label}: nothing behind a link is searched`);
        const listing = await tools.call('find_files', { pattern: '**/*.js' });
        assert.ok(!textOf(listing).includes('escape/') && !textOf(listing).includes('alias/'), `${label}: nothing behind a link is listed`);
      }
    } else console.log('  skip - this account cannot make a link: the link checks were not run');
    ok('without ripgrep a Git repository is searched through Git\'s own file list (.gitignore honoured, hidden files in, secrets/noise/deleted files out, never through a link), include_ignored and other folders by the walk');
  } else console.log('  skip - Git is not installed: the file-list checks were not run');

  // ------------------------------------------------------------------------------------------------------------------------------ 8. how the tools read to the model, and how they are wired
  {
    const w = await workspaceOf({ 'a.txt': 'x\n' });
    const definitions = new Map(w.tools.definitions().map((tool) => [tool.originalName, tool]));
    assert.match(definitions.get('search_files').description, /gitignore/i);
    assert.match(definitions.get('find_files').description, /gitignore/i);
    assert.match(definitions.get('search_files').description, /lookahead|backreference/i, 'the model is told what only ripgrep adds');
    assert.equal(definitions.size, 99, 'the number of tools is unchanged');
    for (const name of ['search_files', 'find_files']) assert.equal(definitions.get(name).inputSchema.properties.include_ignored.type, 'boolean');
    const assemble = await fs.readFile(path.join(here, '..', 'lib', 'assemble.mjs'), 'utf8');
    assert.match(assemble, /ripgrep\s*[:=]\s*new Ripgrep\(/, 'the Hub assembles LocalTools with ripgrep');
    assert.match(assemble, /import \{ Ripgrep \} from '\.\/ripgrep\.mjs'/);
    const source = await fs.readFile(path.join(here, '..', 'lib', 'local-tools.mjs'), 'utf8');
    assert.ok(!/ripgrep\s*=\s*new Ripgrep/.test(source), 'tests that build LocalTools by hand get the built-in search unless they ask for ripgrep');
    ok('the descriptions mention .gitignore and what only ripgrep adds, the tool count is 99, assemble.mjs turns ripgrep on and LocalTools alone does not');
  }

  // ------------------------------------------------------------------------------------------------------------------------------ 9. a cancelled search ends the program (a real process behind the real class)
  {
    const folder = path.join(root, 'sleeper');
    await fs.mkdir(folder, { recursive: true });
    const script = path.join(folder, 'sleeper.mjs');
    await fs.writeFile(script, 'const line = (type, data) => process.stdout.write(JSON.stringify({ type, data }) + "\\n");\nline("begin", { path: { text: "./a.js" } });\nsetInterval(() => {}, 1000);\n');
    const children = [];
    const spawner = (command, args, options) => {
      const version = args[0] === '--version';
      const child = spawn(process.execPath, version ? ['-e', 'process.stdout.write("ripgrep 14.1.1\\n\\nfeatures:+pcre2\\n")'] : [script], options);
      children.push(child);
      return child;
    };
    const rg = new Ripgrep({ env: { [RIPGREP_ENV]: path.join(os.tmpdir(), isWindows ? 'rg.exe' : 'rg'), PATH: '' }, isFile: async () => true, spawner, platform: process.platform });
    const w = await workspaceOf({ 'a.js': 'needle\n' }, { ripgrep: rg });
    const controller = new AbortController();
    const pending = w.call('search_files', { pattern: 'needle' }, { signal: controller.signal });
    for (let i = 0; i < 100 && children.length < 2; i += 1) await sleep(50);
    assert.equal(children.length, 2, '(premise) a version probe and a search were started');
    const reason = Object.assign(new Error('stopped by the owner'), { code: 'cancelled' });
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason, 'the owner\'s reason, not a second search');
    const searching = children[1];
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && alive(searching.pid); i += 1) await sleep(50);
    assert.equal(alive(searching.pid), false, 'the program of a cancelled search is gone');
    ok('cancelling a search through the tool ends the ripgrep process, and the answer is an error, not a second search');
  }

  // ------------------------------------------------------------------------------------------------------------------------------ 10. the real ripgrep, when this machine has one
  const real = new Ripgrep();
  const info = await real.info();
  if (!info) {
    console.log(`  skip - no ripgrep binary (${real.problem}): the real-ripgrep checks were not run (put rg on PATH or set ${RIPGREP_ENV})`);
  } else {
    console.log(`  (real ripgrep ${info.version} from ${info.source}, PCRE2 ${info.pcre2 ? 'yes' : 'no'})`);
    const fixture = {
      ...sampleFiles,
      '.gitignore': 'generated/\n*.min.js\n',
      'generated/out.js': 'var needle = "generated";\n',
      'vendor.min.js': 'var needle = "minified";\n',
      'big/one-mib.txt': `needle\n${'x'.repeat(1024 * 1024 - 8)}\n`,
      'big/over-one-mib.txt': `needle\n${'x'.repeat(1024 * 1024 - 7)}\n`,
      'bin/blob.bin': Buffer.concat([Buffer.from('needle before the NUL\n'), Buffer.from([0, 1, 2]), Buffer.from('\nneedle after\n')]),
      'enc/latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x0a]),
      'UPPER.JS': 'needle in capitals\n',
    };
    const realWorkspace = await workspaceOf(fixture, { ripgrep: real, initGit: haveGit });
    const builtinWorkspace = await workspaceOf(fixture, { initGit: haveGit });
    const matchSet = (result) => new Set(textOf(result).split('\n').filter((line) => /^[^\s].*?:\d+:/.test(line)).map((line) => line.replace(/^(.*?:\d+):.*$/, '$1')));
    const both = async (args, label) => {
      const a = await realWorkspace.call('search_files', args);
      const b = await builtinWorkspace.call('search_files', args);
      assert.equal(a.isError, false, `${label}: ${textOf(a).slice(0, 200)}`);
      assert.equal(a.structuredContent.engine, 'ripgrep', `${label}: ripgrep ran`);
      assert.deepEqual([...matchSet(a)].sort(), [...matchSet(b)].sort(), `${label}: the same matches`);
      return { a, b };
    };

    // .gitignore is honoured by ripgrep and by Git's list alike; a glob does not bring ignored files back
    if (haveGit) {
      const { a } = await both({ pattern: 'needle' }, 'gitignore');
      assert.ok(!textOf(a).includes('generated/out.js') && !textOf(a).includes('vendor.min.js'), 'gitignored files are not found');
      const globbed = await realWorkspace.call('search_files', { pattern: 'needle', glob: '*.js' });
      assert.ok(!textOf(globbed).includes('vendor.min.js') && !textOf(globbed).includes('generated'), 'a glob does not resurrect ignored files');
      assert.ok(textOf(globbed).includes('UPPER.JS:1:') === isWindows, 'the case of a glob follows the file system (Windows: UPPER.JS matches *.js)');
      const all = await realWorkspace.call('search_files', { pattern: 'needle', include_ignored: true });
      assert.ok(textOf(all).includes('generated/out.js:1:') && textOf(all).includes('vendor.min.js:1:'), 'include_ignored finds them');
      const inside = await realWorkspace.call('search_files', { pattern: 'needle', path: 'generated' });
      assert.ok(textOf(inside).includes('generated/out.js:1:'), 'a folder named on purpose is searched even if it is ignored');
      const files = await realWorkspace.call('find_files', { pattern: '**/*.js' });
      assert.ok(!textOf(files).includes('generated/') && !textOf(files).includes('vendor.min.js'), 'find_files honours .gitignore');
      assert.equal(files.structuredContent.engine, 'ripgrep');
    }

    // the plan's special cases
    {
      const dash = await both({ pattern: '-x' }, "pattern '-x'");
      assert.ok(textOf(dash.a).includes('docs/readme.md:2:'));
      const unicode = await both({ pattern: 'kim chỉ nam' }, 'Unicode');
      assert.ok(textOf(unicode.a).includes('enc/unicode.txt:1: Tiếng Việt'));
      const crlf = await both({ pattern: '= 1;$', regex: true }, 'CRLF: $ before \\r\\n');
      assert.ok(textOf(crlf.a).includes('src/app.js:1:'));
      assert.ok(!textOf(crlf.a).includes('\r'), 'no carriage return in the output');
      const utf16 = await both({ pattern: 'utf16' }, 'UTF-16');
      assert.ok(textOf(utf16.a).includes('enc/utf16.txt:1: needle in utf16'));
      await both({ pattern: 'with bom' }, 'UTF-8 BOM');
      const secrets = await realWorkspace.call('search_files', { pattern: 'needle', include_ignored: true });
      for (const hidden of ['needle-secret', 'needle-private', 'Host needle', '[core]']) assert.ok(!textOf(secrets).includes(hidden), `${hidden}: .env, private keys, .ssh and .git never come back`);
      assert.ok(textOf(secrets).includes('.hidden/note.txt:1:'), 'a hidden folder that is not private does');
      const lookahead = await both({ pattern: 'needle(?= =)', regex: true }, 'lookahead');
      assert.ok(textOf(lookahead.a).includes('src/app.js:1:'));
      assert.equal(lookahead.a.structuredContent.engine, 'ripgrep', 'PCRE2 does it');
      if (info.pcre2) {
        const back = await realWorkspace.call('search_files', { pattern: '(nee)dle .* \\1', regex: true });
        assert.equal(back.isError, false);
      }
      const big = await both({ pattern: 'needle', path: 'big' }, 'a file of exactly 1 MiB and one byte more');
      assert.ok(textOf(big.a).includes('big/one-mib.txt:1:') && !textOf(big.a).includes('over-one-mib'), '1 MiB is searched, 1 MiB + 1 byte is not');
      const binary = await both({ pattern: 'needle', path: 'bin' }, 'a binary file');
      assert.match(textOf(binary.a), /^0 kết quả/);
      const encoded = await realWorkspace.call('search_files', { pattern: 'needle', path: 'enc' });
      assert.ok(!textOf(encoded).includes('latin1.txt'), 'a file that is not UTF-8 is skipped, not shown mangled');
      assert.ok(encoded.structuredContent.skipped >= 1, 'and counted');
      const blank = await both({ pattern: '^\\s*$', regex: true, path: 'blank.txt', context: 1 }, 'blank lines with context');
      assert.equal(body(blank.a), body(blank.b));
      await both({ pattern: 'needle', context: 2 }, 'context');
      await both({ pattern: 'needle', glob: 'src/**/*.js' }, 'glob');
      await both({ pattern: 'NEEDLE', ignore_case: true, glob: '*.{js,py}' }, 'ignore case with a glob');
      const text = await both({ pattern: 'needle', context: 1 }, 'the text of a search with context');
      const withoutNotes = (result) => body(result).replace(/\n\[[^\n]*\]$/, '');
      assert.equal(withoutNotes(text.a), withoutNotes(text.b), 'the same lines in the same order (the note about skipped files differs: ripgrep cannot count the files it left out for their size)');
      assert.match(body(text.a), /\n\[1 file bị bỏ qua \(nhị phân hoặc không phải UTF-8\)\.\]$/, 'it counts the one file it saw and could not read as text');
    }

    // a link is not followed
    {
      const outside = path.join(root, 'outside-the-real-workspace');
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, 'leak.js'), 'needle outside\n');
      let linkable = true;
      try { await fs.symlink(outside, path.join(realWorkspace.directory, 'escape'), 'junction'); } catch { linkable = false; }
      if (linkable) {
        const viaLink = await realWorkspace.call('search_files', { pattern: 'needle', include_ignored: true });
        assert.ok(!textOf(viaLink).includes('needle outside') && !textOf(viaLink).includes('escape/'), 'a junction/symlink is not followed');
        assert.ok(!textOf(await realWorkspace.call('find_files', { pattern: '**/*.js', include_ignored: true })).includes('escape/'));
      }
    }

    // the glob handed to ripgrep never loses a file the exact glob would keep: the real ripgrep against compileGlob
    {
      const listing = (await real.files({ directory: realWorkspace.root, includeIgnored: true, accept: () => true, noiseNames: [] })).files;
      const globs = ['*.js', '**/*.js', 'src/**/*.js', 'src/*.js', '*.{js,py}', '*.{json,md}', 'readme.*', 'README*', 'space*', '*.JS', 'UPPER.*', 'lib/*.js', '**/lib/**', 'src/**', '**/*', 'big/*.txt', '*.txt', 'a b/*', '?.js', 'src/lib/deep/*.py', 'enc/*.[tu]xt', '*.min.js'];
      for (const glob of globs) {
        const exact = new Set(listing.filter((file) => compileGlob(glob).test(file)));
        const narrowed = basenameTypeGlob(glob, { caseInsensitive: isWindows });
        const viaRipgrep = new Set((await real.files({ directory: realWorkspace.root, includeIgnored: true, typeGlob: narrowed, accept: () => true, noiseNames: [] })).files.filter((file) => compileGlob(glob).test(file)));
        assert.deepEqual([...viaRipgrep].sort(), [...exact].sort(), `${glob}${narrowed ? ` (as ${narrowed})` : ''}: nothing lost by narrowing`);
      }
    }

    // 200 queries over this repository's own lib/: the same matches from ripgrep and from the walk
    {
      const libDirectory = path.join(here, '..', 'lib');
      const names = (await fs.readdir(libDirectory)).filter((name) => name.endsWith('.mjs'));
      const snapshot = {};
      for (const name of names) snapshot[`lib/${name}`] = await fs.readFile(path.join(libDirectory, name));
      const corpus = await workspaceOf(snapshot, { ripgrep: real });
      const reference = await workspaceOf(snapshot);
      const words = new Map();
      for (const buffer of Object.values(snapshot)) for (const word of buffer.toString('utf8').match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []) words.set(word, (words.get(word) ?? 0) + 1);
      const ranked = [...words.entries()].filter(([, count]) => count >= 2 && count <= 60).map(([word]) => word).sort();
      let seed = 20261024;
      const next = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const pick = () => ranked[Math.floor(next() * ranked.length)];
      const queries = [];
      while (queries.length < 200) {
        const word = pick();
        const kind = queries.length % 5;
        if (kind === 0) queries.push({ pattern: word });
        else if (kind === 1) queries.push({ pattern: word.toUpperCase(), ignore_case: true });
        else if (kind === 2) queries.push({ pattern: `${word.slice(0, 3)}\\w+`, regex: true, limit: 300 });
        else if (kind === 3) queries.push({ pattern: `\\b${word}\\b`, regex: true });
        else queries.push({ pattern: `${word}|${pick()}`, regex: true, limit: 300 });
      }
      let compared = 0;
      for (const query of queries) {
        const withRg = await corpus.call('search_files', { limit: 300, ...query });
        const without = await reference.call('search_files', { limit: 300, ...query });
        assert.equal(withRg.isError, false, JSON.stringify(query));
        assert.equal(without.isError, false, JSON.stringify(query));
        if (withRg.structuredContent.truncated || without.structuredContent.truncated) continue;
        assert.equal(withRg.structuredContent.engine, 'ripgrep');
        assert.deepEqual([...matchSet(withRg)].sort(), [...matchSet(without)].sort(), JSON.stringify(query));
        compared += 1;
      }
      assert.ok(compared >= 150, `${compared} of 200 queries could be compared (the rest hit the limit)`);
      ok(`the real ripgrep ${info.version}: .gitignore honoured and not undone by a glob, the plan's special cases (-x, Unicode, CRLF, UTF-16, secrets, links, lookahead, 1 MiB, binary), globs never lose a file, and ${compared} of 200 queries over lib/ give the same matches as the walk`);
    }
  }
} finally {
  await cleanup();
}

console.log(`\nPASS: ${checks} search checks`);
