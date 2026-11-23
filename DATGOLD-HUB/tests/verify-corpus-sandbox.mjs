// The run sandbox and the clean-room scoring checkout of the Proof-of-Done benchmark corpus (plan task P7 pod-36, corpus/SANDBOX.md):
// corpus/tools/run-sandbox.mjs, corpus/tools/score-checkout.mjs and what they share (corpus/tools/sandbox-core.mjs, corpus/tools/tar.mjs).
//
// Every agent here is a scripted Node program: no model, no vendor CLI, no network. The tasks are synthetic, with no dependency: their
// "install" is a script that copies a lockfile. The repositories, the hidden test archives and the "real profile" with its fake
// credentials are written to a temporary folder; Git is cut off from the person's own configuration.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The corpus stands beside the Hub: in the repository, and in a copy the mutation runner makes (tests/mutation/corpus-sandbox.json).
const CORPUS = path.resolve(HUB, '..', 'corpus');
if (!existsSync(CORPUS) && !existsSync(path.join(HUB, '..', 'README.md'))) {
  console.log('CHATMCP_TEST_SKIP: corpus/ was not found next to DATGOLD-HUB (the corpus tools need the whole repository)');
  process.exit(0);
}
const TOOLS = path.join(CORPUS, 'tools');
const importTool = (name) => import(pathToFileURL(path.join(TOOLS, name)).href);
const sandbox = await importTool('run-sandbox.mjs');
const scoring = await importTool('score-checkout.mjs');
const core = await importTool('sandbox-core.mjs');
const tar = await importTool('tar.mjs');
const { loadTask } = await importTool('load.mjs');
const { MARKER_CONTRACT } = await importTool('marker.mjs');
const { PROTOCOL } = await importTool('protocol.mjs');
const { runSandbox } = sandbox;
const { scoreCheckout } = scoring;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const ROOT = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'datgold-corpus-sandbox-')));
const HOME = path.join(ROOT, 'home');
await fs.mkdir(HOME, { recursive: true });
await fs.writeFile(path.join(HOME, 'empty.gitconfig'), '');
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
  HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(HOME, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: path.dirname(ROOT),
};
function git(cwd, args, { input } = {}) {
  const result = spawnSync('git', args, { cwd, env: ENV, windowsHide: true, input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
}
const gitText = (cwd, args) => git(cwd, args).toString('utf8').trim();

// ---- a strict ustar writer (the archives of this suite) ----------------------------------------------------------------------------
const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;
function tarHeader({ name, size, mode = 0o644, type = '0', magic = 'ustar\0', version = '00', prefix = '' }) {
  const header = Buffer.alloc(512);
  const put = (value, at, length) => (Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')).copy(header, at, 0, length);
  put(name, 0, 100); put(octal(mode, 8), 100, 8); put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8); put(octal(size, 12), 124, 12);
  put(octal(1_700_000_000, 12), 136, 12); header.fill(0x20, 148, 156); put(type, 156, 1); put(magic, 257, 6); put(version, 263, 2); put(prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}
function tarBytes(entries, { gzip = false, end = true } = {}) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    let { name, prefix = '' } = entry;
    if (typeof name === 'string' && name.length > 100 && !prefix) {
      // the ustar split: the last 100 characters at most in `name`, the rest (at most 155) in `prefix`, cut at a slash
      const cut = name.indexOf('/', name.length - 101);
      assert.ok(cut > 0 && cut <= 155, `the test path ${name} cannot be split for ustar`);
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
    parts.push(tarHeader({ ...entry, name, prefix, size: data.length }), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  const bytes = Buffer.concat(parts);
  return gzip ? zlib.gzipSync(bytes) : bytes;
}
const paxRecord = (key, value) => {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length += 1;
  return `${length}${body}`;
};

// ---- the fixture repository ---------------------------------------------------------------------------------------------------------
const DEEP = `deep/${['a', 'b', 'c'].map((letter) => letter.repeat(40)).join('/')}/${'f'.repeat(20)}.txt`;
const BASE_SUM = [
  '// The base: sum is not implemented. A developer may drop an override in local/, which is ignored by Git.',
  "import { existsSync } from 'node:fs';",
  "const override = new URL('../local/sum.mjs', import.meta.url);",
  "export const sum = existsSync(override) ? (await import(override.href)).sum : () => { throw new Error('sum is not implemented'); };",
  '',
].join('\n');
const SOLVED_SUM = 'export const sum = (values) => values.reduce((total, value) => total + value, 0);\n';
const FILES = {
  'package.json': '{ "name": "sum-fixture", "private": true, "type": "module" }\n',
  '.gitignore': 'node_modules/\nlocal/\n',
  '.gitattributes': 'notes.txt text eol=crlf\n',
  'notes.txt': 'line one\nline two\n',
  'deps.lock': 'fixture-lock 1\n',
  'scripts/install.mjs': [
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "mkdirSync('node_modules', { recursive: true });",
    "writeFileSync('node_modules/.installed', readFileSync('deps.lock'));",
    "writeFileSync('node_modules/.cache', process.env.FIXTURE_CACHE ?? 'none');",
    "writeFileSync('node_modules/.setup-env', JSON.stringify(Object.keys(process.env).sort()));",
    '',
  ].join('\n'),
  'scripts/fail.mjs': 'process.exit(3);\n',
  'scripts/dirty.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('stray.txt', 'left by setup\\n');\n",
  'src/sum.mjs': BASE_SUM,
  'test/sum.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/sum.mjs';\ntest('sum of two numbers', () => assert.equal(sum([1, 2]), 3));\n",
  'bin/tool.sh': '#!/bin/sh\necho tool\n',
  [DEEP]: 'deep\n',
};
const SOURCE = path.join(ROOT, 'source');
await fs.mkdir(SOURCE, { recursive: true });
git(SOURCE, ['init', '-q']);
git(SOURCE, ['config', 'user.name', 'Corpus Test']);
git(SOURCE, ['config', 'user.email', 'corpus@test.invalid']);
git(SOURCE, ['config', 'core.autocrlf', 'false']);
for (const [name, text] of Object.entries(FILES)) {
  await fs.mkdir(path.dirname(path.join(SOURCE, name)), { recursive: true });
  await fs.writeFile(path.join(SOURCE, name), text);
}
git(SOURCE, ['add', '-A']);
git(SOURCE, ['update-index', '--chmod=+x', 'bin/tool.sh']);
git(SOURCE, ['commit', '-q', '-m', 'base']);
const COMMIT = gitText(SOURCE, ['rev-parse', 'HEAD']);
const TREE = gitText(SOURCE, ['rev-parse', 'HEAD^{tree}']);
/** A patch of the source repository: the change `edit` makes to its files, as `git diff --binary` writes it. */
async function sourcePatch(edit) {
  await edit(SOURCE);
  git(SOURCE, ['add', '-A']);
  const patch = git(SOURCE, ['diff', '--cached', '--binary']);
  git(SOURCE, ['reset', '-q', '--hard', 'HEAD']);
  git(SOURCE, ['clean', '-q', '-fdx']);
  return patch;
}
const ORACLE = await sourcePatch((dir) => fs.writeFile(path.join(dir, 'src', 'sum.mjs'), SOLVED_SUM));
const FAKE_HIDDEN = "import test from 'node:test';\ntest('a hidden test the agent wrote itself', () => {});\n";
const HIDDEN_PATH = 'test/hidden/sum.hidden.test.mjs';
const PRE_EMPT = await sourcePatch(async (dir) => {
  await fs.mkdir(path.join(dir, 'test', 'hidden'), { recursive: true });
  await fs.writeFile(path.join(dir, ...HIDDEN_PATH.split('/')), FAKE_HIDDEN);
});

// ---- the hidden tests and the tasks -------------------------------------------------------------------------------------------------
const HIDDEN_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { readFileSync } from 'node:fs';",
  "import { sum } from '../../src/sum.mjs';",
  "test('hidden: the sum of a list', () => { assert.equal(sum([1, 2, 3]), 6); assert.equal(sum([]), 0); });",
  "test('hidden: the clean install ran from the lockfile', () => assert.equal(readFileSync(new URL('../../node_modules/.installed', import.meta.url), 'utf8'), 'fixture-lock 1\\n'));",
  '',
].join('\n');
const PRIVATE = path.join(ROOT, 'private');
async function hiddenArchive(id, entries) {
  const file = path.join(PRIVATE, id, 'hidden-tests.tar.gz');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = tarBytes(entries, { gzip: true });
  await fs.writeFile(file, bytes);
  return { file, sha: sha256(bytes) };
}
const indent = (text, columns) => text.split('\n').map((line) => (line ? ' '.repeat(columns) + line : line)).join('\n');
const TASKS = path.join(ROOT, 'corpus', 'tasks');
async function makeTask(id, { hiddenSha, tarball = null }) {
  const dir = path.join(TASKS, id);
  await fs.mkdir(dir, { recursive: true });
  const repo = tarball
    ? ['repo:', '  tarball:', '    file: repo.tar', `    sha256: ${sha256(tarball)}`]
    : ['repo:', '  git:', `    url: https://example.invalid/corpus/${id}.git`, `    commit: ${COMMIT}`];
  if (tarball) await fs.writeFile(path.join(dir, 'repo.tar'), tarball);
  await fs.writeFile(path.join(dir, 'task.yml'), [
    '# A synthetic task written by verify-corpus-sandbox.',
    'version: 1',
    `id: ${id}`,
    'title: "Fixture: implement sum"',
    'prompt: |',
    '  Implement sum(values) in src/sum.mjs.',
    '',
    indent(MARKER_CONTRACT, 2),
    ...repo,
    'setup:',
    '  - node scripts/install.mjs',
    'acceptance: acceptance.yml',
    'hidden_tests:',
    '  archive: hidden-tests.tar.gz',
    `  sha256: ${hiddenSha}`,
    'allowed_paths:',
    '  - src/**',
    'limits:',
    '  wall_seconds: 120',
    'tags:',
    '  - fixture',
    'oracle: oracle.patch',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(dir, 'acceptance.yml'), ['version: 1', 'criteria:', '  - id: tests', '    text: The tests pass', '    checks:',
    '      - run: node --test', '        timeout: 120', 'protected:', '  - test/**', ''].join('\n'));
  await fs.writeFile(path.join(dir, 'oracle.patch'), ORACLE);
  return loadTask(dir);
}
const HIDDEN = await hiddenArchive('sum-fixture', [{ name: 'test/hidden/', type: '5' }, { name: HIDDEN_PATH, data: HIDDEN_TEST }]);
const TASK = await makeTask('sum-fixture', { hiddenSha: HIDDEN.sha });
const REPO_TAR = tarBytes([{ name: 'src/', type: '5' }, ...Object.entries(FILES).map(([name, data]) => ({ name, data, mode: name === 'bin/tool.sh' ? 0o755 : 0o644 }))]);
const HIDDEN_TARBALL_TASK = await hiddenArchive('sum-tarball', [{ name: HIDDEN_PATH, data: HIDDEN_TEST }]);
const TAR_TASK = await makeTask('sum-tarball', { hiddenSha: HIDDEN_TARBALL_TASK.sha, tarball: REPO_TAR });
const EVIL = await hiddenArchive('sum-evil', [{ name: '../evil.test.mjs', data: HIDDEN_TEST }]);
const EVIL_TASK = await makeTask('sum-evil', { hiddenSha: EVIL.sha });

// ---- the scripted agents ------------------------------------------------------------------------------------------------------------
const AGENTS = path.join(ROOT, 'agents');
await fs.mkdir(AGENTS, { recursive: true });
const agentScripts = {
  'observe.mjs': [
    "import { existsSync, readFileSync } from 'node:fs';",
    'const report = {',
    '  cwd: process.cwd(), deep: existsSync(process.argv[2]), installed: existsSync(\'node_modules/.installed\'),',
    "  cache: existsSync('node_modules/.cache') ? readFileSync('node_modules/.cache', 'utf8') : null,",
    "  notes: readFileSync('notes.txt').toString('hex'), tool: existsSync('bin/tool.sh'),",
    '};',
    'console.log(JSON.stringify(report));',
    "console.log('DONE');",
  ],
  'oracle.mjs': ["import { writeFileSync } from 'node:fs';", `writeFileSync('src/sum.mjs', ${JSON.stringify(SOLVED_SUM)});`, "console.log('{}');", "console.log('DONE');"],
  'ignored.mjs': [
    "import { spawnSync } from 'node:child_process';",
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "mkdirSync('local', { recursive: true });",
    `writeFileSync('local/sum.mjs', ${JSON.stringify(SOLVED_SUM)});`,
    "const run = spawnSync(process.execPath, ['--test'], { encoding: 'utf8' });",
    'console.log(JSON.stringify({ publicTests: run.status }));',
    "console.log('DONE');",
  ],
  'profile.mjs': [
    "import { spawnSync } from 'node:child_process';",
    "import { existsSync, readFileSync, readdirSync } from 'node:fs';",
    "import path from 'node:path';",
    `const names = ${JSON.stringify(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TEMP', 'TMP', 'TMPDIR'])};`,
    'const files = {};',
    'const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else files[file] = readFileSync(file, \'utf8\'); } };',
    'for (const name of names) if (process.env[name] && existsSync(process.env[name])) walk(process.env[name]);',
    "const config = (key) => spawnSync('git', ['config', '--get', key], { encoding: 'utf8' });",
    "const setupEnv = existsSync('node_modules/.setup-env') ? JSON.parse(readFileSync('node_modules/.setup-env', 'utf8')) : null;",
    "console.log(JSON.stringify({ env: process.env, files, helper: config('credential.helper').stdout.trim(), email: config('user.email').stdout.trim(), cwd: process.cwd(), setupEnv }));",
    "console.log('DONE');",
  ],
  'hang.mjs': [
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'console.log(`pids ${process.pid} ${child.pid}`);',
    'setInterval(() => {}, 1000);',
  ],
  'orphan.mjs': [
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', cwd: process.cwd() });",
    'child.unref();',
    'console.log(`pids ${process.pid} ${child.pid}`);',
    "console.log('DONE');",
  ],
};
for (const [name, lines] of Object.entries(agentScripts)) await fs.writeFile(path.join(AGENTS, name), `${lines.join('\n')}\n`);
const agent = (script, args = []) => ({ command: process.execPath, args: [path.join(AGENTS, script), ...args] });
const report = (run) => JSON.parse(run.agent.stdout.trim().split(/\r?\n/).at(-2));
const pidsOf = (run) => /pids (\d+) (\d+)/.exec(run.agent.stdout).slice(1).map(Number);

const SANDBOX = path.join(ROOT, 'r');
await fs.mkdir(SANDBOX, { recursive: true });
// The Windows process table costs a PowerShell start; the runs that leave no process behind skip it. The tree-kill runs use the real one.
const NO_SWEEP = { list: async () => [], kill: async () => true };
const runOptions = { task: TASK, gitSource: SOURCE, root: SANDBOX, env: ENV, processTree: NO_SWEEP };
const score = (patch, extra = {}) => scoreCheckout({ task: TASK, gitSource: SOURCE, root: SANDBOX, env: ENV, patch, hiddenArchive: HIDDEN.file, runs: 1, processTree: NO_SWEEP, ...extra });
const nothingLeft = (what) => assert.deepEqual(readdirSync(SANDBOX), [], `${what}: nothing is left in the sandbox root`);
async function refused(promise, code, what) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, `${what}: refused`);
  assert.equal(caught.name, 'SandboxError', `${what}: ${caught.stack}`);
  assert.equal(caught.code, code, `${what}: ${caught.message}`);
  nothingLeft(what);
  return caught;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function gone(pids, ms = 15_000) {
  const until = Date.now() + ms;
  while (pids.some(alive) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  return pids.filter(alive);
}

try {
  // ==== the strict tar reader ============================================================================================================
  {
    const read = (entries, options) => tar.readTar(tarBytes(entries, options));
    const plain = read([{ name: './', type: '5' }, { name: 'src/', type: '5' }, { name: 'a.txt', data: 'A' }, { name: 'bin/x.sh', data: '#!', mode: 0o755 }, { name: './src/b.mjs', data: 'B' }]);
    assert.deepEqual(plain.map((file) => [file.path, file.mode, file.data.toString('utf8')]), [['a.txt', '100644', 'A'], ['bin/x.sh', '100755', '#!'], ['src/b.mjs', '100644', 'B']]);
    assert.deepEqual(read([{ name: 'a.txt', data: 'A' }], { gzip: true }).map((file) => file.path), ['a.txt']);
    const long = `${'p'.repeat(60)}/${'q'.repeat(60)}/${'r'.repeat(90)}.txt`;
    assert.deepEqual(read([{ name: long, data: 'L' }]).map((file) => file.path), [long], 'the ustar prefix field');
    assert.deepEqual(read([{ name: '././@LongLink', type: 'L', data: `${long}\0` }, { name: long.slice(0, 99), data: 'G' }]).map((file) => [file.path, file.data.toString()]), [[long, 'G']], 'a GNU long name');
    assert.deepEqual(read([{ name: 'pax_global_header', type: 'g', data: paxRecord('comment', 'x') }, { name: 'PaxHeader/x', type: 'x', data: paxRecord('path', long) }, { name: 'short', data: 'P' }]).map((file) => file.path), [long], 'a pax path');
    assert.deepEqual(read([{ name: 'a.txt', data: 'A', magic: 'ustar ', version: ' \0' }]).map((file) => file.path), ['a.txt'], 'the GNU magic');
    const refuses = (entries, code, what, { options, bytes } = {}) => {
      assert.throws(() => tar.readTar(bytes ?? tarBytes(entries), options), (error) => {
        assert.equal(error.name, 'TarError', `${what}: ${error.stack}`);
        assert.equal(error.code, code, `${what}: ${error.message}`);
        return true;
      }, what);
    };
    for (const name of ['../evil.mjs', 'a/../../b', '/abs.txt', 'a\\b.txt', 'C:x.txt', 'a/C:/b', '.git/hooks/post-checkout', 'sub/.GIT/config', 'git~1/x',
      'con.txt', 'a/nul', 'dot.', 'space ', 'a\u0001b', 'a\u202eb', 'a"b', 'a|b', 'a<b', 'a*b', 'a?b', 'a//b', 'a/./b']) {
      refuses([{ name, data: 'x' }], 'unsafe_path', JSON.stringify(name));
    }
    refuses([{ name: Buffer.from([0x61, 0xff, 0x62]), data: 'x' }], 'unsafe_path', 'a name that is not UTF-8');
    refuses([{ name: './', type: '5' }, { name: '.', data: 'x' }], 'unsafe_path', 'a file named "." (the root folder entry "./" itself is skipped)');
    for (const [type, what] of [['1', 'a hard link'], ['2', 'a symbolic link'], ['3', 'a character device'], ['4', 'a block device'], ['6', 'a FIFO'], ['7', 'a contiguous file'], ['K', 'a GNU long link name'], ['S', 'a sparse file']]) {
      refuses([{ name: 'a', type, data: '' }], 'unsupported_entry', what);
    }
    refuses([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }], 'duplicate_path', 'a path twice');
    refuses([{ name: 'A.txt', data: '1' }, { name: 'a.txt', data: '2' }], 'duplicate_path', 'two paths that differ only in case');
    refuses([{ name: 'a', data: '1' }, { name: 'a/b', data: '2' }], 'path_conflict', 'a file under a file');
    refuses([{ name: 'a/b', data: '1' }, { name: 'A', data: '2' }], 'path_conflict', 'a file over a folder');
    const good = tarBytes([{ name: 'a.txt', data: 'A' }]);
    const badSum = Buffer.from(good); badSum[0] = 0x62;
    refuses(null, 'bad_checksum', 'a header whose checksum does not match', { bytes: badSum });
    refuses(null, 'truncated', 'data cut short', { bytes: good.subarray(0, 600) });
    refuses(null, 'truncated', 'a header cut short', { bytes: good.subarray(0, 300) });
    refuses(null, 'truncated', 'no end blocks', { bytes: tarBytes([{ name: 'a.txt', data: 'A' }], { end: false }) });
    refuses([{ name: 'a.txt', data: 'A', magic: 'xxxxx\0' }], 'not_ustar', 'no ustar magic');
    refuses([], 'empty_archive', 'an archive without a file');
    refuses([{ name: 'only/', type: '5' }], 'empty_archive', 'an archive with folders only');
    refuses([{ name: 'a', data: '1' }, { name: 'b', data: '2' }], 'too_large', 'more entries than allowed', { options: { maxEntries: 1 } });
    refuses([{ name: 'a', data: '12345' }], 'too_large', 'more bytes than allowed', { options: { maxBytes: 4 } });
    refuses(null, 'bad_gzip', 'a broken gzip stream', { bytes: Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), Buffer.alloc(40, 7)]) });
    refuses([{ name: 'PaxHeader/x', type: 'x', data: '5 x\n' }, { name: 'a', data: '1' }], 'bad_pax', 'a pax record with a wrong length');
    ok('the tar reader reads ustar, GNU long names and pax paths (gzip or not), keeps the executable bit, and refuses 23 unsafe paths, 8 kinds of link or device, duplicates, conflicts, bad checksums, cut data, other formats, empty archives and the size limits, each by its code');
  }

  // ==== the short root and the path budget ==============================================================================================
  {
    assert.equal(core.defaultSandboxRoot({ platform: 'win32', env: { SystemDrive: 'D:' } }), 'D:\\cmr');
    assert.equal(core.defaultSandboxRoot({ platform: 'win32', env: {} }), 'C:\\cmr');
    assert.equal(core.defaultSandboxRoot({ platform: 'linux', env: {} }), '/tmp/cmr');
    assert.equal(core.defaultSandboxRoot({ platform: 'win32', env: { SystemDrive: 'D:', DATGOLD_CORPUS_SANDBOX_ROOT: 'E:\\runs' } }), 'E:\\runs');
    assert.equal(core.MAX_PATH_WINDOWS, 259);
    const shortPrefix = 'C:\\cmr\\1a2b3c4d\\w';
    const worktreePrefix = 'F:\\Personal_Project\\Vin\\ChatMCP\\.claude\\worktrees\\p7-pod36-run-sandbox-660478\\DATGOLD-HUB\\tests\\tmp\\1a2b3c4d\\w';
    const exact = 'x'.repeat(259 - shortPrefix.length - 1);
    assert.doesNotThrow(() => core.checkPathBudget({ prefix: shortPrefix, paths: ['a', exact], maxPath: 259 }), 'a path that ends exactly at the limit fits');
    for (const [prefix, paths, what] of [[shortPrefix, ['a', `${exact}y`], 'one character over'], [worktreePrefix, [DEEP], 'the deep path under a worktree-like folder']]) {
      assert.throws(() => core.checkPathBudget({ prefix, paths, maxPath: 259 }), (error) => {
        assert.equal(error.code, 'path_too_long', what);
        assert.equal(error.length, prefix.length + 1 + paths.at(-1).length, what);
        assert.equal(error.path, paths.at(-1), what);
        return true;
      }, what);
    }
    assert.doesNotThrow(() => core.checkPathBudget({ prefix: shortPrefix, paths: [DEEP], maxPath: 259 }), 'the deep path under the short root');
    ok(`the default root is short (C:\\cmr on the system drive, /tmp/cmr elsewhere, DATGOLD_CORPUS_SANDBOX_ROOT wins); a path of ${DEEP.length} characters fits under it and not under a worktree-like folder; the budget is exact`);
  }

  // ==== the null agent through the whole path: it fails =================================================================================
  const nullRun = await runSandbox({ ...runOptions, agent: agent('observe.mjs', [DEEP]), extraEnv: { FIXTURE_CACHE: 'pinned-cache' } });
  {
    assert.equal(nullRun.format, 'datgold.corpus-run/1');
    assert.equal(nullRun.taskId, 'sum-fixture');
    assert.equal(nullRun.agent.exitCode, 0, nullRun.agent.stderr);
    assert.equal(nullRun.agent.timedOut, false);
    assert.equal(nullRun.baseTree, TREE, 'the baseline commit holds the task commit\'s tree, byte for byte');
    assert.match(nullRun.baseCommit, /^[0-9a-f]{40}$/);
    assert.equal(nullRun.finalTree, TREE);
    assert.equal(nullRun.patch.length, 0);
    assert.equal(nullRun.patchSha256, sha256(Buffer.alloc(0)));
    assert.match(nullRun.runId, /^[0-9a-f]{8}$/);
    assert.deepEqual(nullRun.setup.map((step) => [step.command, step.pass, step.exitCode]), [['node scripts/install.mjs', true, 0]]);
    const seen = report(nullRun);
    assert.equal(path.relative(SANDBOX, seen.cwd), path.join(nullRun.runId, 'w'), 'the agent works in <root>/<run id>/w');
    assert.equal(seen.deep, true, 'the deep path was checked out');
    assert.equal(seen.installed, true, 'setup ran before the agent');
    assert.equal(seen.cache, 'pinned-cache', 'setup gets the extra variables (a pinned cache)');
    assert.equal(Buffer.from(seen.notes, 'hex').toString('utf8'), 'line one\nline two\n', 'no attribute converted a line end: the file is the blob');
    assert.equal(seen.tool, true);
    assert.equal(nullRun.cleanup.removed, true);
    nothingLeft('after the null run');
    // the baseline commit is the same commit in every run of the task
    const again = await runSandbox({ ...runOptions, agent: agent('oracle.mjs') });
    assert.equal(again.baseCommit, nullRun.baseCommit);
    ok('a run checks out the task commit\'s tree under <root>/<8 hex>/w as one baseline commit (the same in every run), runs setup with the extra variables, keeps every byte, gives the null agent an empty diff and leaves nothing behind');

    const nullScore = await score(nullRun.patch);
    assert.equal(nullScore.format, 'datgold.corpus-score/1');
    assert.equal(nullScore.outcome, 'fail');
    assert.equal(nullScore.hiddenPass, false);
    assert.equal(nullScore.passes, 0);
    assert.equal(nullScore.requiredRuns, 1);
    assert.equal(nullScore.runs.length, 1);
    assert.equal(nullScore.runs[0].pass, false);
    assert.deepEqual(nullScore.runs[0].checks.map((check) => [check.criterionId, check.run, check.pass]), [['tests', 'node --test', false]]);
    assert.notEqual(nullScore.runs[0].checks[0].exitCode, 0);
    assert.equal(nullScore.baseTree, TREE);
    assert.equal(nullScore.hiddenSha256, HIDDEN.sha);
    assert.deepEqual(nullScore.setup.map((step) => step.pass), [true]);
    assert.deepEqual(nullScore.overwritten, []);
    assert.equal(nullScore.cleanup.removed, true);
    nothingLeft('after scoring the null run');
    ok('the null agent fails the hidden tests in the clean checkout (outcome fail, 0 of 1 runs), and the checkout is removed');

    // ==== the oracle passes =================================================================================================================
    const oracleScore = await score(ORACLE, { runs: undefined });
    assert.equal(oracleScore.outcome, 'pass', JSON.stringify(oracleScore.runs, null, 1));
    assert.equal(oracleScore.hiddenPass, true);
    assert.equal(oracleScore.requiredRuns, PROTOCOL.hidden_test_runs);
    assert.equal(oracleScore.passes, 3);
    assert.equal(oracleScore.runs.length, 3);
    assert.equal(oracleScore.patchSha256, sha256(ORACLE));
    nothingLeft('after scoring the oracle');
    const oracleRun = again;
    const oraclePatch = oracleRun.patch.toString('utf8');
    assert.match(oraclePatch, /^diff --git a\/src\/sum\.mjs b\/src\/sum\.mjs$/m);
    assert.equal((oraclePatch.match(/^diff --git /gm) ?? []).length, 1, 'only the agent\'s change: no mode change of bin/tool.sh, nothing from node_modules');
    assert.notEqual(oracleRun.finalTree, TREE);
    assert.equal(oracleRun.patchSha256, sha256(oracleRun.patch));
    const oracleRunScore = await score(oracleRun.patch);
    assert.equal(oracleRunScore.outcome, 'pass');
    nothingLeft('after scoring the oracle agent');
    ok('the oracle patch passes the hidden tests in 3 of 3 runs (the protocol\'s number), and so does a scripted agent that writes the oracle\'s file: its diff holds that file only');

    // ==== an edit in an ignored path has no effect on the score ==========================================================================
    const ignoredRun = await runSandbox({ ...runOptions, agent: agent('ignored.mjs') });
    assert.equal(report(ignoredRun).publicTests, 0, 'in its own tree the public tests pass');
    assert.equal(ignoredRun.patch.length, 0, 'the ignored path is not in the diff');
    const ignoredScore = await score(ignoredRun.patch);
    assert.equal(ignoredScore.outcome, 'fail');
    assert.deepEqual(ignoredScore.runs.map((run) => run.checks.map((check) => [check.pass, check.exitCode])), nullScore.runs.map((run) => run.checks.map((check) => [check.pass, check.exitCode])));
    nothingLeft('after the ignored-path agent');
    ok('an agent that solves the task in a Git-ignored path passes the public tests in its own tree, but its diff is empty and its score is the null agent\'s');

    // ==== the hidden tests always win =====================================================================================================
    const preEmpt = await score(PRE_EMPT);
    assert.equal(preEmpt.outcome, 'fail', 'the agent\'s own file at the hidden test\'s path was replaced');
    assert.deepEqual(preEmpt.overwritten, [HIDDEN_PATH]);
    nothingLeft('after the pre-empting patch');
    ok('a diff that writes a file at a hidden test\'s path is overwritten by the hidden test, and the score lists the path');
  }

  // ==== the profile holds no credential of the real profile ===============================================================================
  {
    const MARK = 'REALPROFILEMARK';
    const REAL = path.join(ROOT, 'real-profile');
    const realFiles = {
      '.claude/.credentials.json': `{"claudeAiOauth":{"accessToken":"${MARK}-claude"}}`,
      '.claude.json': `{"oauthAccount":"${MARK}"}`,
      '.codex/auth.json': `{"OPENAI_API_KEY":"${MARK}-codex"}`,
      '.gitconfig': `[credential]\n\thelper = store\n[user]\n\temail = ${MARK}@example.invalid\n`,
      '.git-credentials': `https://user:${MARK}@github.com\n`,
      '.npmrc': `//registry.npmjs.org/:_authToken=${MARK}\n`,
      '.ssh/id_ed25519': `${MARK} private key\n`,
      '.config/gh/hosts.yml': `github.com:\n  oauth_token: ${MARK}\n`,
      'AppData/Roaming/npm/etc/npmrc': `_authToken=${MARK}\n`,
      'AppData/Local/claude/token': MARK,
    };
    for (const [name, text] of Object.entries(realFiles)) {
      await fs.mkdir(path.dirname(path.join(REAL, name)), { recursive: true });
      await fs.writeFile(path.join(REAL, name), text);
    }
    const realEnv = {
      ...ENV,
      HOME: REAL, USERPROFILE: REAL, HOMEDRIVE: 'Q:', HOMEPATH: `\\${MARK}`, APPDATA: path.join(REAL, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(REAL, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(REAL, '.config'), XDG_DATA_HOME: path.join(REAL, '.local', 'share'), XDG_CACHE_HOME: path.join(REAL, '.cache'), XDG_STATE_HOME: path.join(REAL, '.local', 'state'),
      XDG_RUNTIME_DIR: path.join(REAL, 'run'), CODEX_HOME: path.join(REAL, '.codex'), CLAUDE_CONFIG_DIR: path.join(REAL, '.claude'),
      OPENAI_API_KEY: `sk-${MARK}`, ANTHROPIC_API_KEY: `sk-ant-${MARK}`, GITHUB_TOKEN: `ghp_${MARK}`, GH_TOKEN: MARK, NPM_TOKEN: MARK, AWS_SECRET_ACCESS_KEY: MARK,
      SSH_AUTH_SOCK: path.join(REAL, MARK), GPG_AGENT_INFO: MARK, GIT_ASKPASS: MARK, SSH_ASKPASS: MARK,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${MARK}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/${MARK}`, KUBECONFIG: MARK, DOCKER_CONFIG: MARK, GOOGLE_APPLICATION_CREDENTIALS: MARK,
      HTTPS_PROXY: `http://user:${MARK}@proxy.invalid:8080`, NODE_OPTIONS: `--require ${MARK}`, DATGOLD_FIXTURE_VALUE: MARK, PSModulePath: MARK,
    };
    const EXPLICIT = 'explicit-vendor-credential-0123456789';
    const run = await runSandbox({
      ...runOptions, env: realEnv,
      agent: { ...agent('profile.mjs'), credentials: { FAKE_VENDOR_API_KEY: EXPLICIT }, env: { FIXTURE_AGENT_SETTING: 'on' }, seed: { 'claude/settings.json': '{"theme":"dark"}\n' } },
    });
    assert.equal(run.agent.exitCode, 0, run.agent.stderr);
    const seen = report(run);
    const runDir = path.dirname(seen.cwd);
    assert.equal(path.dirname(runDir), SANDBOX);
    const inRun = (value) => typeof value === 'string' && !path.relative(runDir, value).startsWith('..') && !path.isAbsolute(path.relative(runDir, value));
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TEMP', 'TMP', 'TMPDIR', 'GIT_CONFIG_GLOBAL']) {
      assert.ok(inRun(seen.env[name]), `${name} points into the run's own profile: ${seen.env[name]}`);
    }
    assert.equal(new Set(['HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TEMP']
      .map((name) => seen.env[name])).size, 10, 'each profile folder is a folder of its own');
    assert.equal(seen.env.GIT_CEILING_DIRECTORIES, runDir, 'Git never looks for a repository above the run');
    assert.equal(seen.env.GIT_CONFIG_NOSYSTEM, '1');
    const dump = JSON.stringify(seen.env);
    assert.ok(!dump.includes(MARK), `no variable carries the real profile: ${Object.entries(seen.env).filter(([, value]) => String(value).includes(MARK)).map(([name]) => name).join(', ')}`);
    assert.ok(!dump.includes(REAL), 'no variable names the real profile');
    for (const name of ['OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'GIT_CONFIG_COUNT', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'HTTPS_PROXY', 'NODE_OPTIONS', 'PSModulePath', 'HOMEPATH']) {
      assert.ok(!Object.keys(seen.env).some((key) => key.toUpperCase() === name.toUpperCase() && seen.env[key].includes(MARK)), `${name} is left out`);
    }
    assert.equal(seen.env.FAKE_VENDOR_API_KEY, EXPLICIT, 'the credential the caller names reaches the agent');
    assert.equal(seen.env.FIXTURE_AGENT_SETTING, 'on');
    assert.ok(seen.env.PATH ?? seen.env.Path, 'PATH is inherited');
    const files = Object.fromEntries(Object.entries(seen.files).map(([file, text]) => [path.relative(runDir, file).split(path.sep).join('/'), text]));
    assert.deepEqual(Object.keys(files).sort(), ['h/claude/settings.json', 'h/home/.gitconfig'], 'the profile holds the seeded files and nothing copied');
    assert.equal(files['h/claude/settings.json'], '{"theme":"dark"}\n');
    assert.ok(!JSON.stringify(files).includes(MARK));
    assert.equal(seen.helper, '', 'no Git credential helper');
    assert.equal(seen.email, 'agent@corpus.datgold.invalid', 'the seeded Git identity');
    assert.ok(Array.isArray(seen.setupEnv) && !seen.setupEnv.includes('FAKE_VENDOR_API_KEY') && !seen.setupEnv.includes('FIXTURE_AGENT_SETTING'), 'setup gets neither the credential nor the agent\'s variables');
    assert.deepEqual(run.profile.credentials, ['FAKE_VENDOR_API_KEY']);
    assert.deepEqual(run.profile.seeded, ['claude/settings.json']);
    assert.ok(!JSON.stringify({ ...run, agent: null, patch: null }).includes(EXPLICIT), 'the run record names the credential, never its value');
    for (const name of core.PROFILE_VARIABLES.map((entry) => entry.name)) assert.ok(run.profile.variables.includes(name), `the record lists ${name}`);
    nothingLeft('after the profile run');
    ok('the agent\'s HOME, APPDATA, LOCALAPPDATA, XDG folders, CODEX_HOME, CLAUDE_CONFIG_DIR and TEMP are fresh folders of the run; no variable, file, Git helper or identity of a real profile full of fake credentials reaches it; only the credential the caller names does, and setup never sees it');

    for (const [extra, code, what] of [
      [{ credentials: { HOME: 'x' } }, 'bad_agent_env', 'a credential named like a profile variable'],
      [{ env: { CLAUDE_CONFIG_DIR: 'x' } }, 'bad_agent_env', 'an agent variable that moves a profile folder'],
      [{ credentials: { 'A=B': 'x' } }, 'bad_agent_env', 'a variable name with ='],
      [{ credentials: { KEY: 7 } }, 'bad_agent_env', 'a value that is not text'],
      [{ seed: { '../escape.txt': 'x' } }, 'bad_seed_path', 'a seed path that leaves the profile'],
      [{ seed: { '/abs.txt': 'x' } }, 'bad_seed_path', 'an absolute seed path'],
    ]) {
      await refused(runSandbox({ ...runOptions, agent: { ...agent('observe.mjs', [DEEP]), ...extra } }), code, what);
    }
    await refused(runSandbox({ ...runOptions, agent: agent('observe.mjs', [DEEP]), extraEnv: { HOME: 'x' } }), 'bad_agent_env', 'an extra variable that moves HOME');
    ok('a credential, variable or extra variable that would move a profile folder, a bad name or value, and a seed path outside the profile are refused before anything is written');
  }

  // ==== the process tree is killed ========================================================================================================
  {
    const started = Date.now();
    const hang = await runSandbox({ ...runOptions, processTree: undefined, agent: agent('hang.mjs'), wallSeconds: 2 });
    assert.equal(hang.agent.timedOut, true);
    assert.ok(hang.agent.wallMs >= 1900 && Date.now() - started < 60_000, `the limit stopped it: ${hang.agent.wallMs} ms`);
    assert.deepEqual(await gone(pidsOf(hang)), [], 'the agent and its child are gone');
    assert.equal(hang.cleanup.removed, true);
    nothingLeft('after the timed-out agent');

    const orphan = await runSandbox({ ...runOptions, processTree: undefined, agent: agent('orphan.mjs') });
    assert.equal(orphan.agent.exitCode, 0);
    assert.equal(orphan.agent.timedOut, false);
    const [, orphaned] = pidsOf(orphan);
    assert.deepEqual(await gone([orphaned], 5000), [], 'the child the agent left behind is gone');
    assert.deepEqual(orphan.cleanup.leftovers, []);
    assert.equal(orphan.cleanup.removed, true);
    nothingLeft('after the agent that left a child behind');

    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), 1500);
    const cancelled = await runSandbox({ ...runOptions, processTree: undefined, agent: agent('hang.mjs'), wallSeconds: 120, signal: controller.signal });
    clearTimeout(stop);
    assert.equal(cancelled.agent.cancelled, true);
    assert.equal(cancelled.agent.timedOut, false);
    assert.deepEqual(await gone(pidsOf(cancelled)), []);
    nothingLeft('after the cancelled agent');
    ok('the wall limit and a cancel kill the agent\'s whole process tree; a child left running after the agent exits is found and killed too; the run folder is removed every time');
  }

  // ==== cleanup after a failure ===========================================================================================================
  {
    const failed = await refused(runSandbox({ ...runOptions, setup: ['node scripts/fail.mjs'], agent: agent('observe.mjs', [DEEP]) }), 'setup_failed', 'a failing setup');
    assert.deepEqual(failed.setup.map((step) => [step.pass, step.exitCode]), [[false, 3]]);
    const dirty = await refused(runSandbox({ ...runOptions, setup: ['node scripts/dirty.mjs'], agent: agent('observe.mjs', [DEEP]) }), 'setup_changed_tree', 'a setup that writes a tracked path');
    assert.deepEqual(dirty.paths, ['stray.txt']);
    await refused(runSandbox({ ...runOptions, agent: { command: path.join(ROOT, 'no-such-agent.exe') } }), 'agent_failed_to_start', 'an agent program that does not exist');
    const empty = path.join(ROOT, 'empty-source');
    await fs.mkdir(empty, { recursive: true });
    git(empty, ['init', '-q']);
    await refused(runSandbox({ ...runOptions, gitSource: empty, agent: agent('observe.mjs', [DEEP]) }), 'base_missing', 'a Git source without the task commit');
    await refused(runSandbox({ ...runOptions, gitSource: undefined, agent: agent('observe.mjs', [DEEP]) }), 'git_source_required', 'a Git task without a local source');
    const longRoot = path.join(ROOT, `long-${'x'.repeat(120)}`);
    await refused(runSandbox({ ...runOptions, root: longRoot, maxPath: 259, agent: agent('observe.mjs', [DEEP]) }), 'path_too_long', 'a root too long for the deep path');
    assert.ok(!existsSync(longRoot) || readdirSync(longRoot).length === 0, 'nothing was written under the long root');
    await refused(runSandbox({ ...runOptions, root: 'relative/root', agent: agent('observe.mjs', [DEEP]) }), 'bad_argument', 'a relative root');
    await refused(runSandbox({ ...runOptions, wallSeconds: 0, agent: agent('observe.mjs', [DEEP]) }), 'bad_argument', 'a wall limit of 0');
    ok('a failing setup, a setup that changes the tree, a missing agent program, a source without the commit or no source, a root too long for the task\'s paths and bad arguments are refused by code, and each leaves nothing behind');
  }

  // ==== a diff that does not apply ======================================================================================================
  {
    const wrongContext = Buffer.from(ORACLE.toString('utf8').replace("throw new Error('sum is not implemented')", "throw new Error('another base')"), 'utf8');
    assert.notDeepEqual(wrongContext, ORACLE);
    const intoGit = Buffer.from('diff --git a/.git/hooks/post-checkout b/.git/hooks/post-checkout\nnew file mode 100755\n--- /dev/null\n+++ b/.git/hooks/post-checkout\n@@ -0,0 +1 @@\n+echo hook\n', 'utf8');
    for (const [patch, what] of [[wrongContext, 'a diff made on another base'], [intoGit, 'a diff into .git'], [Buffer.from('not a patch\n'), 'text that is not a diff']]) {
      const result = await score(patch);
      assert.equal(result.outcome, 'patch_does_not_apply', what);
      assert.equal(result.hiddenPass, false, what);
      assert.deepEqual(result.runs, [], `${what}: no test ran`);
      assert.deepEqual(result.setup, [], `${what}: no setup ran`);
      assert.ok(result.applyError.length > 0, what);
      assert.equal(result.patchSha256, sha256(patch));
      nothingLeft(what);
    }
    ok('a diff that does not apply to the fresh checkout (another base, a path into .git, not a diff) is the outcome patch_does_not_apply: hidden_pass false, nothing run, nothing left');
  }

  // ==== the hidden archive, the tarball base ============================================================================================
  {
    await refused(score(ORACLE, { hiddenArchive: HIDDEN_TARBALL_TASK.file }), 'hidden_archive_mismatch', 'a hidden archive with another sha256');
    await refused(score(ORACLE, { hiddenArchive: path.join(ROOT, 'no-such-archive.tar.gz') }), 'hidden_archive_missing', 'no hidden archive');
    const evil = await refused(score(ORACLE, { task: EVIL_TASK, hiddenArchive: EVIL.file }), 'hidden_archive_invalid', 'a hidden archive with ../');
    assert.equal(evil.tarCode, 'unsafe_path');
    assert.ok(!existsSync(path.join(SANDBOX, '..', 'evil.test.mjs')));

    const tarScore = await score(ORACLE, { task: TAR_TASK, gitSource: undefined, hiddenArchive: HIDDEN_TARBALL_TASK.file });
    assert.equal(tarScore.outcome, 'pass', JSON.stringify(tarScore.runs, null, 1));
    assert.equal(tarScore.baseTree, TREE, 'the tarball gives the same tree as the Git source: same bytes, same modes');
    nothingLeft('after the tarball task');
    const tarRun = await runSandbox({ ...runOptions, task: TAR_TASK, gitSource: undefined, agent: agent('observe.mjs', [DEEP]) });
    assert.equal(tarRun.baseTree, TREE);
    assert.equal(tarRun.baseCommit, nullRun.baseCommit, 'one baseline commit per tree, whatever the source');
    nothingLeft('after the tarball run');
    const tarFile = path.join(TAR_TASK.dir, 'repo.tar');
    await fs.writeFile(tarFile, Buffer.concat([REPO_TAR, Buffer.alloc(512)]));
    await refused(score(ORACLE, { task: TAR_TASK, gitSource: undefined, hiddenArchive: HIDDEN_TARBALL_TASK.file }), 'tarball_mismatch', 'a tarball changed after the task was loaded');
    await fs.writeFile(tarFile, REPO_TAR);
    ok('a hidden archive with another hash, a missing one and one with an unsafe path are refused; a tarball task scores like its Git twin (same tree, same baseline commit) and a tarball changed after loading is refused');
  }

  // ==== the command lines =================================================================================================================
  {
    const SCORE = path.join(TOOLS, 'score-checkout.mjs');
    const RUN = path.join(TOOLS, 'run-sandbox.mjs');
    const node = (args) => spawnSync(process.execPath, args, { cwd: ROOT, env: { ...ENV, FIXTURE_CLI_KEY: 'cli-credential-0123456789' }, encoding: 'utf8', windowsHide: true, timeout: 180_000 });
    const oracleFile = path.join(TASK.dir, 'oracle.patch');
    const scored = node([SCORE, '--task', TASK.dir, '--git-source', SOURCE, '--root', SANDBOX, '--hidden', HIDDEN.file, '--patch', oracleFile, '--runs', '1']);
    assert.equal(scored.status, 0, scored.stderr + scored.stdout);
    assert.equal(JSON.parse(scored.stdout).outcome, 'pass');
    const patchOut = path.join(ROOT, 'out', 'null.patch');
    const ran = node([RUN, '--task', TASK.dir, '--git-source', SOURCE, '--root', SANDBOX, '--patch-out', patchOut, '--credential', 'FIXTURE_CLI_KEY', '--', process.execPath, path.join(AGENTS, 'observe.mjs'), DEEP]);
    assert.equal(ran.status, 0, ran.stderr + ran.stdout);
    const summary = JSON.parse(ran.stdout);
    assert.equal(summary.agent.exitCode, 0);
    assert.deepEqual(summary.profile.credentials, ['FIXTURE_CLI_KEY'], 'a --credential is taken from the named variable');
    assert.ok(!ran.stdout.includes('cli-credential-0123456789'), 'the run printed names a credential, never its value');
    assert.equal(summary.patchSha256, sha256(Buffer.alloc(0)));
    assert.equal(readFileSync(patchOut).length, 0);
    const nullScored = node([SCORE, '--task', TASK.dir, '--git-source', SOURCE, '--root', SANDBOX, '--hidden', HIDDEN.file, '--patch', patchOut, '--runs', '1']);
    assert.equal(nullScored.status, 1, nullScored.stderr);
    assert.equal(JSON.parse(nullScored.stdout).outcome, 'fail');
    for (const args of [[SCORE], [SCORE, '--bogus'], [SCORE, '--task', TASK.dir, '--patch', oracleFile], [RUN], [RUN, '--task', TASK.dir, '--patch-out', patchOut], [RUN, '--task', TASK.dir, '--patch-out', patchOut, '--'],
      [RUN, '--task', TASK.dir, '--patch-out', patchOut, '--credential', 'FIXTURE_NOT_SET_ANYWHERE', '--', process.execPath]]) {
      assert.equal(node(args).status, 2, args.join(' '));
    }
    nothingLeft('after the command lines');
    ok('score-checkout.mjs exits 0 for a pass and 1 otherwise with the score as JSON; run-sandbox.mjs writes the diff and prints the run; usage errors exit 2');
  }

  // ==== the document ======================================================================================================================
  {
    const doc = readFileSync(path.join(CORPUS, 'SANDBOX.md'), 'utf8');
    for (const phrase of ['not an OS sandbox', 'dedicated machine', 'C:\\cmr', 'DATGOLD_CORPUS_SANDBOX_ROOT', 'GIT_ATTR_SOURCE', 'patch_does_not_apply', 'killTree', 'Credential Manager']) {
      assert.ok(doc.includes(phrase), `corpus/SANDBOX.md mentions ${phrase}`);
    }
    for (const { name } of core.PROFILE_VARIABLES) assert.ok(doc.includes(`\`${name}\``), `corpus/SANDBOX.md names the profile variable ${name}`);
    for (const name of [...core.INHERITED_VARIABLES.win32, ...core.INHERITED_VARIABLES.posix]) assert.ok(doc.includes(`\`${name}\``), `corpus/SANDBOX.md names the inherited variable ${name}`);
    for (const code of core.SANDBOX_CODES) assert.ok(doc.includes(`\`${code}\``), `corpus/SANDBOX.md names the code ${code}`);
    for (const code of tar.TAR_CODES) assert.ok(doc.includes(`\`${code}\``), `corpus/SANDBOX.md names the tar code ${code}`);
    assert.ok(readFileSync(path.join(CORPUS, 'README.md'), 'utf8').includes('(SANDBOX.md)'), 'corpus/README.md links SANDBOX.md');
    assert.ok(readFileSync(path.join(HUB, '..', 'docs', 'INDEX.md'), 'utf8').includes('(../corpus/SANDBOX.md)'), 'docs/INDEX.md links corpus/SANDBOX.md');
    ok('corpus/SANDBOX.md says it is not an OS sandbox and names every profile variable, every inherited variable and every refusal code; the README and docs/INDEX.md link it');
  }
} finally {
  await fs.rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

console.log(`PASS: ${checks} corpus-sandbox checks (tar reader, path budget, null agent, oracle, ignored path, hidden tests, profile, process tree, cleanup, patches that do not apply, tarball base, command lines, document)`);
