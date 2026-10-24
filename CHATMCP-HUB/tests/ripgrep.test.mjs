// ripgrep for search_files and find_files (lib/ripgrep.mjs): which binary is used, the command line that is built, what is made of its JSON output and how its process
// ends. Nothing here needs ripgrep itself: the output is canned, the process is a fake or a small Node script. tests/verify-search-rg.mjs runs the real thing when it can.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  NdjsonSplitter, RIPGREP_ENV, Ripgrep, basenameTypeGlob, bundledRipgrepPath, compareWalkOrder, createSearchCollector, fileListArguments, normalizeRipgrepPath,
  patternNeedsPcre2, resolveRipgrep, runRipgrepProcess, searchArguments,
} from '../lib/ripgrep.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isWindows = process.platform === 'win32';
const programName = isWindows ? 'rg.exe' : 'rg';

// ------------------------------------------------------------------------------------------------------------------------------- 1. which binary
{
  const hub = path.join(os.tmpdir(), 'hub-under-test');
  const bundled = path.join(hub, 'runtimes', 'ripgrep', programName);
  assert.equal(bundledRipgrepPath(hub), bundled, 'the installer puts it in <hub>/runtimes/ripgrep');
  const bin1 = path.join(os.tmpdir(), 'bin-one');
  const bin2 = path.join(os.tmpdir(), 'bin-two');
  const onPath = path.join(bin2, programName);
  const override = path.join(os.tmpdir(), 'custom', programName);
  const present = (...files) => { const set = new Set(files); return async (file) => set.has(file); };
  const pathVariable = [bin1, '', 'relative-dir', `"${bin2}"`].join(path.delimiter);

  assert.deepEqual(await resolveRipgrep({ hubDirectory: hub, env: { PATH: pathVariable }, isFile: present(bundled, onPath) }), { path: bundled, source: 'bundled' }, 'the bundled binary comes before PATH');
  assert.deepEqual(await resolveRipgrep({ hubDirectory: hub, env: { PATH: pathVariable }, isFile: present(onPath) }), { path: onPath, source: 'path' }, 'then PATH (a quoted entry is unquoted)');
  assert.equal(await resolveRipgrep({ hubDirectory: hub, env: { PATH: pathVariable }, isFile: present() }), null, 'and then nothing: the built-in search is used');
  assert.equal(await resolveRipgrep({ hubDirectory: hub, env: { PATH: '' }, isFile: present(bundled.replace('runtimes', 'other')) }), null, 'no PATH, no binary');
  // an entry that is not an absolute folder (the folder the Hub was started in, say) is never searched: a program planted there must not be run
  assert.equal(await resolveRipgrep({ hubDirectory: hub, env: { PATH: ['', '.', 'relative-dir'].join(path.delimiter) }, isFile: async (file) => file.endsWith(programName) && !file.startsWith(hub) }), null, 'relative and empty PATH entries are skipped');
  assert.deepEqual(await resolveRipgrep({ hubDirectory: hub, env: { [RIPGREP_ENV]: override, PATH: pathVariable }, isFile: present(bundled, onPath, override) }), { path: override, source: 'env' }, 'the owner\'s own choice comes first');
  assert.equal(await resolveRipgrep({ hubDirectory: hub, env: { [RIPGREP_ENV]: override, PATH: pathVariable }, isFile: present(bundled, onPath) }), null, 'a choice that does not exist is not replaced by another binary behind the owner\'s back');
  assert.equal(await resolveRipgrep({ hubDirectory: hub, env: { [RIPGREP_ENV]: 'rg', PATH: pathVariable }, isFile: async () => true }), null, 'a choice that is not an absolute path would be taken from whatever folder the Hub was started in');
  for (const off of ['off', 'OFF', '0', 'false', 'none', 'no']) {
    assert.equal(await resolveRipgrep({ hubDirectory: hub, env: { [RIPGREP_ENV]: off, PATH: pathVariable }, isFile: present(bundled, onPath) }), null, `${RIPGREP_ENV}=${off} switches it off`);
  }
  assert.deepEqual(await resolveRipgrep({ hubDirectory: hub, env: { Path: pathVariable }, isFile: present(onPath) }), { path: onPath, source: 'path' }, 'Windows spells the variable Path');
  ok('which ripgrep: the choice of the owner, then the bundled one, then PATH (absolute entries only), then none; =off switches it off');
}

// ------------------------------------------------------------------------------------------------------------------------------- 2. what needs PCRE2
{
  for (const needs of ['foo(?=bar)', 'foo(?!bar)', '(?<=a)b', '(?<!a)b', '(a)\\1', '(?<x>a)\\k<x>', '^(\\w)\\w*\\1$', 'a(?=b)(?=c)']) assert.equal(patternNeedsPcre2(needs), true, needs);
  for (const plain of ['foo.*bar', 'a\\(?=b', '[(?=]x', '(?:a|b)+', '(?<name>a)b', '\\\\1', 'x\\d+', 'a{2,3}', '(?i)abc', '\\(', '[\\1]', 'x\\0y']) assert.equal(patternNeedsPcre2(plain), false, plain);
  ok('lookahead, lookbehind and backreferences need PCRE2; an escaped parenthesis, a class and a named group alone do not');
}

// ------------------------------------------------------------------------------------------------------------------------------- 3. the command line
{
  const base = { pattern: 'needle', regex: false, ignoreCase: false, context: 0, includeIgnored: false, noiseNames: ['node_modules', 'dist'], privateNames: ['.git', '.ssh'] };
  const args = searchArguments(base);
  const after = (list, flag) => list[list.indexOf(flag) + 1];
  for (const flag of ['--json', '--no-config', '--no-messages', '--hidden', '--crlf', '-s', '-F']) assert.ok(args.includes(flag), `${flag} is passed`);
  assert.equal(after(args, '--color'), 'never');
  assert.equal(after(args, '--max-filesize'), '1M', 'files over 1 MiB are not searched, as in the built-in search');
  assert.equal(after(args, '-e'), 'needle', 'the pattern is the value of -e');
  assert.ok(!args.includes('--no-ignore') && !args.includes('-i') && !args.includes('--pcre2') && !args.includes('-C'));
  const globs = args.flatMap((value, at) => (args[at - 1] === '-g' ? [value] : []));
  assert.deepEqual(globs.sort(), ['!.git', '!.ssh', '!dist/', '!node_modules/'], 'private names are left out wherever they are, noise folders only as folders');
  assert.ok(args.every((value, at) => args[at - 1] !== '-g' || value.startsWith('!')), 'a glob that is not an exclusion would bring back what .gitignore left out');

  assert.equal(after(searchArguments({ ...base, pattern: '-x' }), '-e'), '-x', 'a pattern that looks like an option is still a pattern');
  const regex = searchArguments({ ...base, regex: true, ignoreCase: true, context: 3, pattern: 'a.c' });
  assert.ok(!regex.includes('-F') && regex.includes('-i') && !regex.includes('-s'));
  assert.equal(after(regex, '-C'), '3');
  assert.ok(searchArguments({ ...base, regex: true, pcre2: true, pattern: '(?=a)' }).includes('--pcre2'));
  const everything = searchArguments({ ...base, includeIgnored: true });
  assert.ok(everything.includes('--no-ignore'));
  assert.deepEqual(everything.flatMap((value, at) => (everything[at - 1] === '-g' ? [value] : [])).sort(), ['!.git', '!.ssh'], 'include_ignored brings back node_modules and the like, never the private folders');
  const typed = searchArguments({ ...base, typeGlob: '*.{js,mjs}' });
  assert.equal(after(typed, '--type-add'), 'cmglob:*.{js,mjs}');
  assert.equal(after(typed, '-t'), 'cmglob');
  assert.ok(!args.includes('--type-add'));

  const files = fileListArguments({ includeIgnored: false, noiseNames: ['node_modules'], privateNames: ['.git'], typeGlob: '*.py' });
  for (const flag of ['--files', '--null', '--no-config', '--no-messages', '--hidden']) assert.ok(files.includes(flag), `${flag} is passed to --files`);
  assert.ok(files.includes('!node_modules/') && files.includes('!.git') && after(files, '-t') === 'cmglob');
  assert.ok(!files.includes('-e') && !files.includes('--json'));
  assert.ok(fileListArguments({ includeIgnored: true, noiseNames: [], privateNames: [] }).includes('--no-ignore'));
  ok('the command line: JSON, no config, hidden files in, CRLF as a line end, 1 MiB, the pattern after -e, private and noise folders left out, no glob that is not an exclusion');
}

// ------------------------------------------------------------------------------------------------------------------------------- 4. the glob handed to ripgrep as a file type
{
  assert.equal(basenameTypeGlob('*.py'), '*.py');
  assert.equal(basenameTypeGlob('**/*.js'), '*.js', 'any depth is what a file type already does');
  assert.equal(basenameTypeGlob('src/**/test_*.js'), 'test_*.js', 'the folders are checked afterwards; the name already narrows');
  assert.equal(basenameTypeGlob('lib/*.mjs'), '*.mjs');
  assert.equal(basenameTypeGlob('*.{json,yaml}'), '*.{json,yaml}');
  assert.equal(basenameTypeGlob('.\\src\\*.ts'), '*.ts', 'a Windows habit');
  for (const none of ['src/**', '**', 'docs/', '{a/b,c}.txt', 'src/{lib/x,y}.js', 'a:b.js', '']) {
    assert.equal(basenameTypeGlob(none, { caseInsensitive: false }), null, `${JSON.stringify(none)}: no narrowing`);
    assert.equal(basenameTypeGlob(none, { caseInsensitive: true }), null, `${JSON.stringify(none)}: no narrowing, case-insensitively either`);
  }
  assert.equal(basenameTypeGlob('ÉCOLE*.md', { caseInsensitive: false }), 'ÉCOLE*.md');
  assert.equal(basenameTypeGlob('ÉCOLE*.md', { caseInsensitive: true }), null, 'a letter that is not ASCII cannot be given both cases here');
  assert.equal(basenameTypeGlob('*.py', { caseInsensitive: true }), '*.[pP][yY]', 'on Windows a file type would otherwise miss FILE.PY');
  assert.equal(basenameTypeGlob('*.{js,ts}', { caseInsensitive: true }), '*.{[jJ][sS],[tT][sS]}');
  assert.equal(basenameTypeGlob('Make*', { caseInsensitive: true }), '[mM][aA][kK][eE]*');
  assert.equal(basenameTypeGlob('fi[lx]e.js', { caseInsensitive: false }), 'fi[lx]e.js', 'a class is kept where the case matters');
  assert.equal(basenameTypeGlob('fi[lx]e.js', { caseInsensitive: true }), null, '...and given up where it would need rewriting');
  ok('the glob is narrowed to its file name for ripgrep (a superset; the exact glob is applied afterwards), case-insensitively on Windows, and given up when that cannot be done safely');
}

// ------------------------------------------------------------------------------------------------------------------------------- 5. order and paths
{
  const shuffled = ['z/q.js', 'a/x.js', 'b.js', 'a/b/y.js', 'a.js', 'a/c.js'];
  assert.deepEqual([...shuffled].sort(compareWalkOrder), ['a.js', 'b.js', 'a/c.js', 'a/x.js', 'a/b/y.js', 'z/q.js'], 'the files of a folder, then its folders: the order of the walk of the tree');
  assert.deepEqual(['B.js', 'a.js'].sort(compareWalkOrder), ['B.js', 'a.js'], 'by code unit, like the walk');
  assert.equal(compareWalkOrder('a.js', 'a.js'), 0);
  for (const [given, expected] of [['.\\src\\app.js', 'src/app.js'], ['./src/app.js', 'src/app.js'], ['src/lib\\util.js', 'src/lib/util.js'], ['app.js', 'app.js'], ['.\\.hidden\\x', '.hidden/x'], ['src\\\\x.js', 'src/x.js']]) {
    assert.equal(normalizeRipgrepPath(given, 'win32'), expected, given);
  }
  assert.equal(normalizeRipgrepPath('./src/a\\b.js', 'linux'), 'src/a\\b.js', 'where a backslash is part of a name it stays one');
  ok('the order of results is the walk order; ripgrep\'s Windows paths (.\\a\\b, a/b\\c) become a/b/c');
}

// ------------------------------------------------------------------------------------------------------------------------------- 6. lines of JSON, however the bytes arrive
{
  const text = '{"t":"Tiếng Việt: 日本語 🙂"}\n{"t":"second"}\n{"t":"third"}';
  const bytes = Buffer.from(text, 'utf8');
  const expected = text.split('\n');
  for (let cut = 0; cut <= bytes.length; cut += 1) {
    const splitter = new NdjsonSplitter();
    const lines = [...splitter.push(bytes.subarray(0, cut)), ...splitter.push(bytes.subarray(cut)), ...splitter.flush()];
    assert.deepEqual(lines, expected, `cut at byte ${cut}`);
  }
  const many = new NdjsonSplitter();
  const out = [];
  for (const byte of bytes) out.push(...many.push(Buffer.from([byte])));
  out.push(...many.flush());
  assert.deepEqual(out, expected, 'one byte at a time');
  assert.deepEqual(new NdjsonSplitter().push(Buffer.from('\n\n')), [], 'empty lines are nothing');
  ok('JSON lines are cut at newlines only, so a chunk that ends inside a character or a line changes nothing');
}

// ------------------------------------------------------------------------------------------------------------------------------- 7. what the output means
{
  const event = {
    begin: (file) => ({ type: 'begin', data: { path: { text: file } } }),
    match: (file, number, text) => ({ type: 'match', data: { path: { text: file }, lines: { text }, line_number: number, absolute_offset: 0, submatches: [] } }),
    context: (file, number, text) => ({ type: 'context', data: { path: { text: file }, lines: { text }, line_number: number, absolute_offset: 0, submatches: [] } }),
    bytesMatch: (file, number, base64) => ({ type: 'match', data: { path: { text: file }, lines: { bytes: base64 }, line_number: number, absolute_offset: 0, submatches: [] } }),
    end: (file, binary = null) => ({ type: 'end', data: { path: { text: file }, binary_offset: binary, stats: {} } }),
    summary: (searches) => ({ type: 'summary', data: { stats: { searches, searches_with_match: 1 } } }),
  };
  const feed = (collector, events) => events.map((item) => collector.push(item));

  // one file with context, one without; blank lines are known as blank; paths are the workspace's
  {
    const collector = createSearchCollector({ limit: 10, context: 1, platform: 'win32' });
    feed(collector, [
      event.begin('.\\src\\app.js'), event.context('.\\src\\app.js', 1, 'const a = 1;\r\n'), event.match('.\\src\\app.js', 2, 'needle();\r\n'), event.context('.\\src\\app.js', 3, '\r\n'), event.end('.\\src\\app.js'),
      event.begin('docs/readme.md'), event.match('docs/readme.md', 7, `${'x'.repeat(3000)}\n`), event.end('docs/readme.md'),
      event.summary(41),
    ]);
    const result = collector.finish();
    assert.equal(result.matches, 2);
    assert.equal(result.searched, 41);
    assert.equal(result.limited, false);
    assert.deepEqual(result.files.map((file) => file.path), ['src/app.js', 'docs/readme.md']);
    assert.deepEqual(result.files[0].lines.map((line) => [line.number, line.match, line.text, line.blank]), [[1, false, 'const a = 1;', false], [2, true, 'needle();', false], [3, false, '', true]], 'a line ends at its line end, whichever it is');
    assert.equal(result.files[1].lines[0].length, 3000, 'the length of a long line is known');
    assert.ok(result.files[1].lines[0].text.length <= 400, 'but only the start of it is kept');
  }

  // the paths a caller does not want are not results, and are not counted
  {
    const collector = createSearchCollector({ limit: 2, context: 0, accept: (file) => !file.startsWith('secret') });
    const verdicts = feed(collector, [
      event.begin('secret/.env'), event.match('secret/.env', 1, 'KEY=1\n'), event.match('secret/.env', 2, 'KEY=2\n'), event.match('secret/.env', 3, 'KEY=3\n'), event.end('secret/.env'),
      event.begin('a.js'), event.match('a.js', 1, 'one\n'),
    ]);
    assert.deepEqual(verdicts.slice(0, 5), ['continue', 'continue', 'continue', 'continue', 'continue'], 'a refused file never ends the search');
    const result = collector.finish();
    assert.equal(result.matches, 1);
    assert.deepEqual(result.files.map((file) => file.path), ['a.js']);
  }

  // the limit: the matches count, the context of the last one is still wanted, a later match inside that window is shown as context, then stop
  {
    const collector = createSearchCollector({ limit: 2, context: 2 });
    const verdicts = feed(collector, [
      event.begin('a.js'), event.context('a.js', 2, 'two\n'), event.match('a.js', 3, 'hit three\n'), event.context('a.js', 4, 'four\n'), event.match('a.js', 5, 'hit five\n'),
      event.match('a.js', 6, 'hit six, one past the limit\n'), event.context('a.js', 7, 'seven\n'),
    ]);
    assert.deepEqual(verdicts, ['continue', 'continue', 'continue', 'continue', 'continue', 'continue', 'stop'], 'the context of the last match is read to the end, then ripgrep is stopped');
    const result = collector.finish();
    assert.equal(result.matches, 2);
    assert.equal(result.limited, true);
    assert.deepEqual(result.files[0].lines.map((line) => [line.number, line.match]), [[2, false], [3, true], [4, false], [5, true], [6, false], [7, false]]);
  }
  {
    // after the limit a line beyond the window ends the search and is not kept (ripgrep gives the lines of the window first; this is for output that skips them)
    const gap = createSearchCollector({ limit: 1, context: 2 });
    assert.deepEqual(feed(gap, [event.begin('a.js'), event.match('a.js', 5, 'hit\n'), event.match('a.js', 9, 'far\n')]), ['continue', 'continue', 'stop']);
    assert.deepEqual(gap.finish().files[0].lines.map((line) => line.number), [5], 'the line beyond the window is not a result');
    const spaces = createSearchCollector({ limit: 5, context: 0 });
    feed(spaces, [event.begin('a.js'), event.match('a.js', 1, '   \t \n'), event.match('a.js', 2, 'x\n'), event.end('a.js')]);
    assert.deepEqual(spaces.finish().files[0].lines.map((line) => line.blank), [true, false], 'a line of spaces is blank');
  }
  {
    const collector = createSearchCollector({ limit: 1, context: 0 });
    assert.deepEqual(feed(collector, [event.begin('a.js'), event.match('a.js', 1, 'x\n')]), ['continue', 'stop'], 'without context the limit ends the search at once');
    assert.equal(collector.finish().files.length, 1, 'and the file in progress is a result');
    const short = createSearchCollector({ limit: 1, context: 3 });
    assert.deepEqual(feed(short, [event.begin('a.js'), event.match('a.js', 1, 'x\n'), event.context('a.js', 2, 'y\n'), event.end('a.js')]), ['continue', 'continue', 'continue', 'stop'], 'a file that ends inside the window is the end of it');
  }

  // a file that is not text is not a result: binary (NUL), or lines that are not UTF-8 (ripgrep gives those as bytes)
  {
    const collector = createSearchCollector({ limit: 10, context: 0 });
    feed(collector, [
      event.begin('blob.bin'), event.match('blob.bin', 1, 'needle\n'), event.end('blob.bin', 22),
      event.begin('latin1.txt'), event.match('latin1.txt', 1, 'needle first, in plain text\n'), event.bytesMatch('latin1.txt', 4, 'Y2Fm6SBuZWVkbGUK'), event.match('latin1.txt', 5, 'needle again\n'), event.end('latin1.txt'),
      event.begin('ok.txt'), event.match('ok.txt', 1, 'needle\n'), event.end('ok.txt'),
    ]);
    const result = collector.finish();
    assert.deepEqual(result.files.map((file) => file.path), ['ok.txt']);
    assert.equal(result.matches, 1, 'matches of a file that is dropped are not counted');
    assert.equal(result.skippedBinary, 1);
    assert.equal(result.skippedEncoding, 1);
  }

  // a path that is not UTF-8 cannot be named to the model or checked against the protected names
  {
    const collector = createSearchCollector({ limit: 10, context: 0 });
    feed(collector, [{ type: 'begin', data: { path: { bytes: 'Zm9v/w==' } } }, { type: 'match', data: { path: { bytes: 'Zm9v/w==' }, lines: { text: 'needle\n' }, line_number: 1, submatches: [] } }, { type: 'end', data: { path: { bytes: 'Zm9v/w==' }, binary_offset: null } }]);
    const result = collector.finish();
    assert.equal(result.files.length, 0);
    assert.equal(result.skippedEncoding, 1);
  }

  // events that mean nothing are nothing
  {
    const collector = createSearchCollector({ limit: 3, context: 0 });
    assert.deepEqual(feed(collector, [{ type: 'unknown', data: {} }, { type: 'match' }, { type: 'summary' }, null, 'text']), ['continue', 'continue', 'continue', 'continue', 'continue']);
    assert.equal(collector.finish().files.length, 0);
  }
  ok('ripgrep\'s JSON: files and lines with the walk\'s paths, refused files not counted, the limit with the context of its last match, binary and non-UTF-8 files dropped with their matches');
}

// ------------------------------------------------------------------------------------------------------------------------------- 8. the process: stop, time, cancel, size, errors
{
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-rg-process-'));
  try {
    const script = async (name, source) => { const file = path.join(folder, name); await fs.writeFile(file, source); return file; };
    const exists = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const gone = async (pid) => { for (let i = 0; i < 60; i += 1) { if (!exists(pid)) return true; await sleep(50); } return false; };

    // a program that writes a line every 20 ms, for ever
    const endless = await script('endless.mjs', 'let n = 0; setInterval(() => { process.stdout.write(`line ${++n}\\n`); }, 20);\n');
    const run = (file, options = {}) => runRipgrepProcess({ command: process.execPath, args: [file], cwd: folder, env: process.env, timeoutMs: 20_000, ...options });

    // the caller can say "enough"
    let seen = '';
    const stopped = await run(endless, { onChunk: (chunk) => { seen += chunk.toString(); return seen.includes('line 3'); } });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.timedOut, false);
    assert.ok(stopped.pid > 0 && await gone(stopped.pid), 'the program is stopped when the caller has enough');

    // time
    const started = Date.now();
    const slow = await run(endless, { timeoutMs: 300 });
    assert.equal(slow.timedOut, true);
    assert.ok(Date.now() - started < 5000);
    assert.ok(await gone(slow.pid), 'and when the time is up');

    // cancel
    const controller = new AbortController();
    let pid = 0;
    const pending = run(endless, { signal: controller.signal, onSpawn: (child) => { pid = child.pid; } });
    await sleep(200);
    const reason = Object.assign(new Error('stopped by the owner'), { code: 'cancelled' });
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason, 'a cancelled search ends with the reason it was cancelled for');
    assert.ok(pid > 0 && await gone(pid), 'no program is left behind');
    await assert.rejects(run(endless, { signal: AbortSignal.abort(reason) }), (error) => error === reason, 'already cancelled: nothing is started');

    // size
    const flood = await script('flood.mjs', 'const block = "x".repeat(65536); for (let i = 0; i < 400; i += 1) process.stdout.write(block); setInterval(() => {}, 1000);\n');
    const big = await run(flood, { maxOutputBytes: 300_000 });
    assert.equal(big.outputTruncated, true);
    assert.ok(await gone(big.pid), 'too much output stops the program');

    // an ordinary end: code and stderr
    const failing = await script('failing.mjs', 'process.stderr.write("rg: regex parse error:\\n    (\\n"); process.exit(2);\n');
    const failed = await run(failing);
    assert.equal(failed.code, 2);
    assert.match(failed.stderr, /regex parse error/);
    assert.equal(failed.stopped || failed.timedOut || failed.outputTruncated, false);

    // a reader that fails ends the program and the failure is the answer
    const boom = new Error('the reader failed');
    await assert.rejects(run(endless, { onChunk: () => { throw boom; } }), (error) => error === boom);
    // a program that does not close its pipes after it was told to stop is not waited for for ever
    {
      const stuck = new EventEmitter();
      stuck.stdout = new PassThrough(); stuck.stderr = new PassThrough(); stuck.pid = 7; stuck.kill = () => true;
      const waited = Date.now();
      const answer = await runRipgrepProcess({ command: 'rg', args: [], cwd: folder, env: {}, timeoutMs: 100, spawner: () => stuck });
      assert.equal(answer.timedOut, true);
      assert.ok(Date.now() - waited < 8000, 'the answer comes a few seconds after the stop, close or no close');
    }
    // a program that is not there
    await assert.rejects(runRipgrepProcess({ command: path.join(folder, 'no-such-program'), args: [], cwd: folder, env: process.env, timeoutMs: 5000 }), (error) => error.code === 'ripgrep_unavailable');
    // how it is started: no shell, no window
    const calls = [];
    const fake = new EventEmitter();
    fake.stdout = new PassThrough(); fake.stderr = new PassThrough(); fake.pid = 1; fake.kill = () => true;
    const quick = runRipgrepProcess({ command: 'rg', args: ['x'], cwd: folder, env: { A: '1' }, timeoutMs: 5000, spawner: (command, args, options) => { calls.push({ command, args, options }); setImmediate(() => { fake.stdout.end(); fake.stderr.end(); fake.emit('close', 1, null); }); return fake; } });
    assert.equal((await quick).code, 1);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.cwd, folder);
    assert.deepEqual(calls[0].options.env, { A: '1' });
    assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
  ok('the process: stopped when the caller has enough, when the time is up, when the owner cancels and when it prints too much (never left running); stderr and the exit code are kept; no shell');
}

// ------------------------------------------------------------------------------------------------------------------------------- 9. the class, with a program that is faked
{
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const fakeSpawner = (plan) => {
    const calls = [];
    const spawner = (command, args, options) => {
      const call = { command, args, options, killed: false };
      calls.push(call);
      const answer = plan(command, args, options);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 4000 + calls.length;
      child.kill = () => { call.killed = true; setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', null, 'SIGKILL'); }); return true; };
      setImmediate(async () => {
        if (answer.error) { child.emit('error', answer.error); return; }
        for (const chunk of answer.stdout ?? []) { if (call.killed) return; child.stdout.write(chunk); await tick(); }
        if (answer.hang || call.killed) return;
        child.stdout.end(answer.tail ?? undefined);
        child.stderr.end(answer.stderr ?? '');
        child.emit('close', answer.code ?? 0, null);
      });
      return child;
    };
    return { spawner, calls };
  };
  const version = (extra = '') => Buffer.from(`ripgrep 14.1.1 (rev 9aa0ec3430)\n\nfeatures:+pcre2\nsimd(compile):+SSE2\n${extra}`);
  const json = (...events) => events.map((item) => Buffer.from(`${JSON.stringify(item)}\n`));
  const made = (spawner, extra = {}) => new Ripgrep({ hubDirectory: path.join(os.tmpdir(), 'no-hub'), platform: 'win32', env: { [RIPGREP_ENV]: path.join(os.tmpdir(), programName), PATH: '', RIPGREP_CONFIG_PATH: 'C:\\evil.rc', GITHUB_TOKEN: 'ghp_secret_token_value', HOME: os.homedir() }, spawner, isFile: async () => true, ...extra });
  const hit = (file, number, text) => ({ type: 'match', data: { path: { text: file }, lines: { text }, line_number: number, absolute_offset: 0, submatches: [] } });
  const begin = (file) => ({ type: 'begin', data: { path: { text: file } } });
  const end = (file) => ({ type: 'end', data: { path: { text: file }, binary_offset: null } });

  // the version is asked once; what it says is remembered
  {
    const { spawner, calls } = fakeSpawner(() => ({ stdout: [version()] }));
    const rg = made(spawner);
    const info = await rg.info();
    assert.deepEqual({ source: info.source, version: info.version, pcre2: info.pcre2 }, { source: 'env', version: '14.1.1', pcre2: true });
    await rg.info();
    assert.equal(calls.length, 1, 'asked once');
    assert.deepEqual(calls[0].args, ['--version']);
    const noPcre = made(fakeSpawner(() => ({ stdout: [Buffer.from('ripgrep 13.0.0\n\nfeatures:-pcre2\n')] })).spawner);
    assert.equal((await noPcre.info()).pcre2, false);
    // a program that does not run, does not answer or is too old is not used
    assert.equal(await made(fakeSpawner(() => ({ error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) })).spawner).info(), null);
    assert.equal(await made(fakeSpawner(() => ({ stdout: [Buffer.from('hello\n')] })).spawner).info(), null);
    assert.equal(await made(fakeSpawner(() => ({ stdout: [Buffer.from('ripgrep 0.10.0\n')] })).spawner).info(), null);
    assert.equal(await made(fakeSpawner(() => ({ stdout: [version()], code: 3 })).spawner).info(), null);
    const missing = new Ripgrep({ hubDirectory: path.join(os.tmpdir(), 'no-hub'), env: { PATH: '' }, isFile: async () => false, spawner: () => { throw new Error('must not be started'); } });
    assert.equal(await missing.info(), null);
  }

  // a binary that is not there, or does not work, is looked for again after a minute (it may have been installed or repaired); one that worked and then vanished at once
  {
    let clock = 1_000_000;
    let installed = false;
    const { spawner, calls } = fakeSpawner(() => ({ stdout: [version()] }));
    const rg = new Ripgrep({ hubDirectory: path.join(os.tmpdir(), 'no-hub'), env: { PATH: path.join(os.tmpdir(), 'bin-x') }, isFile: async () => installed, spawner, now: () => clock });
    assert.equal(await rg.info(), null);
    installed = true;
    clock += 30_000;
    assert.equal(await rg.info(), null, 'within the minute the answer stands');
    clock += 31_000;
    assert.equal((await rg.info())?.version, '14.1.1', 'after it the binary is found');
    assert.equal(calls.length, 1);
    // it worked, then the program disappeared: the next call asks again instead of failing for a minute
    const unplugged = fakeSpawner((command, args) => (args[0] === '--version' ? { stdout: [version()] } : { error: Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' }) }));
    const gone = made(unplugged.spawner);
    assert.equal((await gone.info())?.version, '14.1.1');
    await assert.rejects(gone.search({ directory: os.tmpdir(), pattern: 'x', limit: 1, accept: () => true }), (error) => error.code === 'ripgrep_unavailable');
    await assert.rejects(gone.files({ directory: os.tmpdir(), accept: () => true }), (error) => error.code === 'ripgrep_unavailable');
    assert.equal(unplugged.calls.filter((call) => call.args[0] === '--version').length, 2, 'the version is asked again after a failure, not served from the memory of the first answer');
  }

  // a search: where it runs, with what, and what comes back
  {
    const { spawner, calls } = fakeSpawner((command, args) => (args[0] === '--version'
      ? { stdout: [version()] }
      : { stdout: json(begin('.\\a.js'), hit('.\\a.js', 3, 'needle one\n'), end('.\\a.js'), { type: 'summary', data: { stats: { searches: 9 } } }), code: 0 }));
    const rg = made(spawner);
    const directory = path.join(os.tmpdir(), 'workspace');
    const result = await rg.search({ directory, target: '.', pattern: 'needle', limit: 5, accept: () => true, noiseNames: ['node_modules'], privateNames: ['.git'] });
    assert.deepEqual(result.files.map((file) => file.path), ['a.js']);
    assert.equal(result.matches, 1);
    assert.equal(result.searched, 9);
    const call = calls.find((item) => item.args[0] !== '--version');
    assert.equal(call.options.cwd, directory, 'it runs in the folder that is searched');
    assert.deepEqual(call.args.slice(-2), ['--', '.'], 'the path is after --');
    assert.equal(call.args[call.args.indexOf('-e') + 1], 'needle');
    assert.equal(call.options.env.RIPGREP_CONFIG_PATH, undefined, 'no configuration file of the user is read');
    assert.equal(call.options.env.GITHUB_TOKEN, undefined, 'and no credential is handed over');
    assert.ok(call.options.env.HOME, 'the rest of the environment is');
    assert.equal(call.options.shell, false);

    const lookahead = await rg.search({ directory, target: 'src', pattern: 'a(?=b)', regex: true, limit: 5, accept: () => true });
    assert.equal(lookahead.matches, 1, '(the canned answer is the same for every call)');
    // the final line of the output may come without its newline
    const bare = fakeSpawner((command, args) => (args[0] === '--version' ? { stdout: [version()] } : { stdout: [...json(begin('a.js'), hit('a.js', 1, 'x\n'), end('a.js')), Buffer.from(JSON.stringify({ type: 'summary', data: { stats: { searches: 77 } } }))] }));
    assert.equal((await made(bare.spawner).search({ directory, pattern: 'x', limit: 5, accept: () => true })).searched, 77, 'a last line without a newline is read');
    const last = calls.at(-1);
    assert.ok(last.args.includes('--pcre2') && !last.args.includes('-F'), 'a regular expression with lookahead goes to PCRE2');
    assert.deepEqual(last.args.slice(-2), ['--', 'src']);
    const plain = await rg.search({ directory, target: '.', pattern: 'a.b', regex: true, limit: 5, accept: () => true });
    assert.ok(!calls.at(-1).args.includes('--pcre2') && !calls.at(-1).args.includes('-F'), 'an ordinary one stays with the default engine');
    assert.equal(plain.matches, 1);
  }

  // PCRE2 is not there: say so, and let the caller choose
  {
    const { spawner } = fakeSpawner(() => ({ stdout: [Buffer.from('ripgrep 14.1.1\n\nfeatures:-pcre2\n')] }));
    await assert.rejects(made(spawner).search({ directory: os.tmpdir(), pattern: '(?=a)', regex: true, limit: 5, accept: () => true }), (error) => error.code === 'ripgrep_pcre2_unavailable');
  }

  // it is stopped at the limit
  {
    const { spawner, calls } = fakeSpawner((command, args) => (args[0] === '--version'
      ? { stdout: [version()] }
      : { stdout: [...json(begin('a.js'), hit('a.js', 1, 'x\n'), hit('a.js', 2, 'y\n'), hit('a.js', 3, 'z\n')), ...json(end('a.js'))], hang: true }));
    const result = await made(spawner).search({ directory: os.tmpdir(), pattern: 'x', limit: 2, accept: () => true });
    assert.equal(result.limited, true);
    assert.equal(result.matches, 2);
    assert.equal(calls.at(-1).killed, true, 'ripgrep is stopped once there are enough matches');
  }

  // errors: a pattern it cannot read, anything else it cannot do, and "nothing found" which is not an error
  {
    const failing = (stderr, code = 2) => made(fakeSpawner((command, args) => (args[0] === '--version' ? { stdout: [version()] } : { stderr, code })).spawner);
    await assert.rejects(failing('rg: regex parse error:\n    (?:a[)\n          ^\nerror: unclosed character class').search({ directory: os.tmpdir(), pattern: 'a[', regex: true, limit: 5, accept: () => true }), (error) => error.code === 'ripgrep_pattern' && /unclosed/.test(error.message));
    await assert.rejects(failing('rg: error parsing flag --foo').search({ directory: os.tmpdir(), pattern: 'a', limit: 5, accept: () => true }), (error) => error.code === 'ripgrep_failed');
    const none = await failing('', 1).search({ directory: os.tmpdir(), pattern: 'a', limit: 5, accept: () => true });
    assert.deepEqual([none.files.length, none.matches, none.timedOut], [0, 0, false]);
    // exit code 2 with results: some file could not be read; the results stand
    const partial = made(fakeSpawner((command, args) => (args[0] === '--version' ? { stdout: [version()] } : { stdout: json(begin('a.js'), hit('a.js', 1, 'x\n'), end('a.js')), stderr: 'rg: .\\locked: Access is denied.', code: 2 })).spawner);
    assert.equal((await partial.search({ directory: os.tmpdir(), pattern: 'x', limit: 5, accept: () => true })).matches, 1);
  }

  // the list of files
  {
    const listing = (names) => Buffer.from(names.join('\0') + '\0');
    const { spawner, calls } = fakeSpawner((command, args) => (args[0] === '--version' ? { stdout: [version()] } : { stdout: [listing(['.\\b.js', 'src/a.js', 'src\\deep\\c.py', 'node_modules/x.js', 'name with\nnewline.txt'])] }));
    const rg = made(spawner);
    const result = await rg.files({ directory: os.tmpdir(), target: '.', accept: (file) => !file.startsWith('node_modules/'), maxFiles: 100 });
    assert.deepEqual(result.files, ['b.js', 'src/a.js', 'src/deep/c.py', 'name with\nnewline.txt']);
    assert.equal(result.truncated, false);
    assert.ok(calls.at(-1).args.includes('--files') && calls.at(-1).args.includes('--null'));
    const capped = made(fakeSpawner((command, args) => (args[0] === '--version' ? { stdout: [version()] } : { stdout: [listing(['a', 'b', 'c', 'd'])], hang: true })).spawner);
    const few = await capped.files({ directory: os.tmpdir(), maxFiles: 2, accept: () => true });
    assert.equal(few.files.length, 2);
    assert.equal(few.truncated, true);
  }
  ok('the class: the version is asked once and judged, the run is in the searched folder with a clean environment, PCRE2 for lookahead, stopped at the limit, errors told apart, the file list is NUL-separated');
}

console.log(`\nPASS: ${checks} ripgrep checks`);
