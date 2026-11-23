// The tools of the Proof-of-Done benchmark corpus (corpus/, plan task P7 pod-35; corpus/README.md): the task format and its loader and
// validator (corpus/tools/load.mjs, corpus/schema/task.schema.json), the final-line DONE / BLOCKED marker contract
// (corpus/tools/marker.mjs) and the freeze that writes preregistration.json and tags the commit (corpus/tools/freeze.mjs).
//
// Everything runs on synthetic tasks in temporary folders and temporary Git repositories, with Git cut off from the person's own
// configuration. The repository's own tags and files are never touched, nothing contacts the network, no vendor CLI runs, and no real
// hidden test archive exists anywhere: the "archives" are a few bytes written here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const expectNone = (problems, what) => assert.equal(problems.length, 0, `${what}:\n  - ${problems.join('\n  - ')}`);

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The corpus stands beside the Hub: in the repository, and in a copy the mutation runner makes (tests/mutation/corpus-tools.json).
const CORPUS = path.resolve(HUB, '..', 'corpus');
if (!existsSync(CORPUS) && !existsSync(path.join(HUB, '..', 'README.md'))) {
  console.log('CHATMCP_TEST_SKIP: corpus/ was not found next to DATGOLD-HUB (the corpus tools need the whole repository)');
  process.exit(0);
}
const TOOLS = path.join(CORPUS, 'tools');
const importTool = (name) => import(pathToFileURL(path.join(TOOLS, name)).href);
const load = await importTool('load.mjs');
const marker = await importTool('marker.mjs');
const protocol = await importTool('protocol.mjs');
const schemaCheck = await importTool('schema-check.mjs');
const FREEZE = path.join(TOOLS, 'freeze.mjs');
const LOAD = path.join(TOOLS, 'load.mjs');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
// The long form of the path (Windows may hand out an 8.3 short name for the temp folder; Git reports the long one).
const ROOT = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'datgold-corpus-')));
const HOME = path.join(ROOT, 'home');
await fs.mkdir(HOME, { recursive: true });
await fs.writeFile(path.join(HOME, 'empty.gitconfig'), '');
// Git sees none of the person's configuration (no system or global file, no personal ignore or attributes file, no signing, no
// line-end conversion), no variable of a Git process that may have started this suite, and no repository above the temp folder.
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
  HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(HOME, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: path.dirname(ROOT),
};
function git(cwd, args, { allowFail = false } = {}) {
  const result = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true });
  if (!allowFail && result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result;
}
const node = (script, args, cwd = ROOT) => spawnSync(process.execPath, [script, ...args], { cwd, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 120_000 });

// ---- the exact contract text: a copy here, so that the module cannot change it without this suite noticing ----------------------------
const CONTRACT = [
  'When you are finished, the last line of your final message must be exactly one of:',
  'DONE',
  'BLOCKED: <reason>',
  'Write DONE only if the task is complete. Write BLOCKED: followed by a one-line reason if you could not complete it. Write nothing after that line.',
].join('\n');
const indent = (text, columns) => text.split('\n').map((line) => (line ? ' '.repeat(columns) + line : line)).join('\n');

// ---- a synthetic task ----------------------------------------------------------------------------------------------------------------
const hiddenBytes = (id) => Buffer.from(`synthetic hidden test archive of ${id}, written by verify-corpus-tools (not a real archive)\n`, 'utf8');
const tarBytes = (id) => Buffer.from(`synthetic repository tarball of ${id}, written by verify-corpus-tools\n`, 'utf8');
const ACCEPTANCE = ['version: 1', 'criteria:', '  - id: public-tests', '    text: The public tests pass', '    checks:', '      - run: node --test test', 'protected:', '  - test/**', ''].join('\n');
const ORACLE = ['diff --git a/src/sum.mjs b/src/sum.mjs', 'new file mode 100644', '--- /dev/null', '+++ b/src/sum.mjs', '@@ -0,0 +1 @@',
  '+export const sum = (values) => values.reduce((total, value) => total + value, 0);', ''].join('\n');

function taskYml(id, { source = 'git' } = {}) {
  const repo = source === 'git'
    ? ['repo:', '  git:', '    url: https://example.invalid/corpus/sum.git', '    commit: 0123456789abcdef0123456789abcdef01234567']
    : ['repo:', '  tarball:', '    file: repo.tar', `    sha256: ${sha256(tarBytes(id))}`];
  return [
    '# A synthetic task written by verify-corpus-tools.',
    'version: 1',
    `id: ${id}`,
    'title: Add a sum function',
    'prompt: |',
    '  Export a function `sum(values)` from src/sum.mjs that returns the sum of an array of numbers.',
    '',
    indent(CONTRACT, 2),
    ...repo,
    'setup:',
    '  - npm ci',
    'acceptance: acceptance.yml',
    'hidden_tests:',
    '  archive: hidden.tar.gz',
    `  sha256: ${sha256(hiddenBytes(id))}`,
    'allowed_paths:',
    '  - src/**',
    '  - ./test/extra/',
    'limits:',
    '  wall_seconds: 900',
    '  max_turns: 50',
    'tags:',
    '  - node',
    '  - small',
    'oracle: oracle.patch',
    '',
  ].join('\n');
}
function taskFiles(id, options = {}) {
  const files = { 'task.yml': taskYml(id, options), 'acceptance.yml': ACCEPTANCE, 'oracle.patch': ORACLE };
  if (options.source === 'tarball') files['repo.tar'] = tarBytes(id);
  return files;
}
async function writeTask(dir, files) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
}
/** `text` with `old` replaced once; a pattern that is not there is a broken test, not a passing one. */
function swap(text, old, replacement) {
  assert.ok(text.includes(old), `the test's pattern ${JSON.stringify(old)} is not in the text`);
  return text.replace(old, () => replacement);
}
const lineOf = (text, fragment) => text.slice(0, text.indexOf(fragment)).split('\n').length;

/** Runs in a child process (its source is passed to node -e): times parseFinalMarker on messages with a million white-space characters. */
async function markerTimingProbe() {
  const { parseFinalMarker } = await import(process.env.MARKER_URL);
  const space = ' ';
  const tab = String.fromCharCode(9);
  const lf = String.fromCharCode(10);
  const inputs = [
    ['spaces and tabs, then x', `${(space + tab).repeat(1_000_000)}x`, null],
    ['line breaks, then x', `${lf.repeat(1_000_000)}x`, null],
    ['x, then spaces', `x${space.repeat(1_000_000)}`, null],
    ['DONE, then white space', `DONE${(space + tab + lf).repeat(300_000)}`, 'DONE'],
  ];
  const results = inputs.map(([name, text, expected]) => {
    const started = performance.now();
    const { marker } = parseFinalMarker(text);
    return { name, length: text.length, marker, expected, ms: Math.round(performance.now() - started) };
  });
  console.log(JSON.stringify(results));
}

try {
  // ==== the marker contract ==============================================================================================================
  {
    assert.equal(marker.MARKER_CONTRACT, CONTRACT, 'the contract text is pinned here word for word');
    assert.equal(marker.MARKER_CONTRACT_VERSION, 1);
    const cases = [
      ['All done.\nDONE', 'DONE', null],
      ['DONE', 'DONE', null],
      ['Summary of the work\nDONE\n', 'DONE', null],
      ['First line\nsecond line\nDONE', 'DONE', null],
      ['Summary\r\nDONE\r\n', 'DONE', null],
      ['Summary\nDONE   \n\n\t\n', 'DONE', null],
      ['Tried twice.\nBLOCKED: the API key is missing', 'BLOCKED', 'the API key is missing'],
      ['BLOCKED: x', 'BLOCKED', 'x'],
      ['BLOCKED: two  spaces inside  \n', 'BLOCKED', 'two  spaces inside'],
      [`BLOCKED: ${'r'.repeat(500)}`, 'BLOCKED', 'r'.repeat(500)],
      [`BLOCKED: ${'r'.repeat(501)}`, null, null],
      ['DONE\nmore text after the marker', null, null],
      ['done', null, null],
      ['Done', null, null],
      ['**DONE**', null, null],
      ['`DONE`', null, null],
      ['DONE.', null, null],
      [' DONE', null, null],
      ['Status: DONE', null, null],
      ['DONE\u200b', null, null],
      ['BLOCKED:', null, null],
      ['BLOCKED: ', null, null],
      ['BLOCKED:reason', null, null],
      ['BLOCKED:  leading space', null, null],
      ['BLOCKED: a\tb', null, null],
      ['blocked: lower case', null, null],
      ['DONE\rBLOCKED: a lone CR is not a line break', null, null],
      ['DONE\r', null, null],
      ['', null, null],
      ['\n \n', null, null],
    ];
    const problems = [];
    for (const [text, expected, reason] of cases) {
      const got = marker.parseFinalMarker(text);
      if (got.marker !== expected || got.reason !== reason) problems.push(`${JSON.stringify(text.slice(0, 40))}: got ${JSON.stringify(got)}, expected ${JSON.stringify({ marker: expected, reason })}`);
    }
    expectNone(problems, 'final-line markers read wrongly');
    assert.throws(() => marker.parseFinalMarker(null), TypeError);
    ok(`the marker contract is the exact pinned text, and ${cases.length} final messages read as DONE, BLOCKED with its reason, or no marker`);
  }
  {
    // The final message is the agent's text: a long run of white space that is not at its end (a padded table) must not make the reading
    // quadratic, or the scoring stalls. Measured in a child process, so a slow version is stopped at the timeout instead of hanging here.
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await (${markerTimingProbe.toString()})();`], {
      env: { ...process.env, MARKER_URL: pathToFileURL(path.join(TOOLS, 'marker.mjs')).href }, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.equal(run.status, 0, `the probe did not finish within 30 s (${run.error?.code ?? run.signal ?? `exit ${run.status}`}): parseFinalMarker is not linear\n${run.stderr}`);
    const results = JSON.parse(run.stdout);
    for (const result of results) {
      assert.equal(result.marker, result.expected, `${result.name}: marker ${result.marker}, expected ${result.expected}`);
      assert.ok(result.ms < 2000, `${result.name} (${result.length} characters) took ${result.ms} ms; the bound is 2000 ms`);
    }
    ok(`long white space is read in linear time: ${results.map((result) => `${result.name} ${result.ms} ms`).join(', ')}`);
  }

  // ==== the schema and its checker =======================================================================================================
  {
    const schema = JSON.parse(readFileSync(path.join(CORPUS, 'schema', 'task.schema.json'), 'utf8'));
    schemaCheck.compileSchema(schema);
    const open = [];
    (function walk(node, where) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object' && node.additionalProperties !== false) open.push(where);
      for (const [key, value] of Object.entries(node)) walk(value, `${where}/${key}`);
    })(schema, '#');
    expectNone(open, 'object schemas that accept unknown keys');
    assert.throws(() => schemaCheck.compileSchema({ type: 'object', oneOf: [] }), /unsupported keyword `oneOf`/);
    assert.throws(() => schemaCheck.compileSchema({ type: 'object', properties: { a: { type: 'string', format: 'uri' } } }), /unsupported keyword `format`/);
    assert.throws(() => schemaCheck.compileSchema({ type: 'object', additionalProperties: true }), /additionalProperties/);
    assert.throws(() => schemaCheck.compileSchema({ type: 'object', properties: { a: { $ref: '#/$defs/missing' } } }), /\$ref/);
    assert.throws(() => schemaCheck.compileSchema({ type: 'number' }), /type/);
    ok('task.schema.json uses only the keywords the checker implements, and every mapping in it refuses unknown keys; a schema with any other keyword is refused');
  }

  // ==== valid tasks ======================================================================================================================
  const CASES_ROOT = path.join(ROOT, 'cases');
  {
    const dir = path.join(CASES_ROOT, 'valid-git', 'base-task');
    await writeTask(dir, taskFiles('base-task'));
    const loaded = await load.loadTask(dir);
    assert.equal(loaded.id, 'base-task');
    assert.equal(loaded.task.version, 1);
    assert.equal(loaded.task.title, 'Add a sum function');
    assert.ok(loaded.task.prompt.endsWith(`${CONTRACT}\n`), 'the prompt is kept as written');
    assert.deepEqual(loaded.task.repo, { git: { url: 'https://example.invalid/corpus/sum.git', commit: '0123456789abcdef0123456789abcdef01234567' } });
    assert.deepEqual(loaded.task.setup, ['npm ci']);
    assert.deepEqual(loaded.task.allowed_paths, ['src/**', 'test/extra'], 'allowed_paths come back in the one spelling of the acceptance reader');
    assert.deepEqual(loaded.task.limits, { wall_seconds: 900, max_turns: 50 });
    assert.deepEqual(loaded.task.tags, ['node', 'small']);
    assert.deepEqual(loaded.task.hidden_tests, { archive: 'hidden.tar.gz', sha256: sha256(hiddenBytes('base-task')) });
    assert.equal(loaded.task.acceptance, 'acceptance.yml');
    assert.equal(loaded.task.oracle, 'oracle.patch');
    assert.equal(loaded.acceptance.criteria[0].id, 'public-tests', 'acceptance.yml is read by the pod-20 parser');
    assert.deepEqual(loaded.acceptance.protected, ['test/**']);
    const files = taskFiles('base-task');
    assert.deepEqual(loaded.files.map((file) => file.name), ['acceptance.yml', 'oracle.patch', 'task.yml'], 'files in code-unit order of their names');
    for (const file of loaded.files) assert.equal(file.sha256, sha256(Buffer.from(files[file.name])), file.name);
    const manifest = loaded.files.map((file) => `${file.sha256}  ${file.name}\n`).join('');
    assert.equal(loaded.sha256, sha256(manifest), 'the task hash is the sha256 of "<sha256>  <name>\\n" lines in name order');

    const tarDir = path.join(CASES_ROOT, 'valid-tarball', 'tar-task');
    const tarFiles = taskFiles('tar-task', { source: 'tarball' });
    await writeTask(tarDir, { ...tarFiles, 'task.yml': swap(tarFiles['task.yml'], 'setup:\n  - npm ci\n', '') });
    const tar = await load.loadTask(tarDir);
    assert.deepEqual(tar.task.repo, { tarball: { file: 'repo.tar', sha256: sha256(tarBytes('tar-task')) } });
    assert.deepEqual(tar.task.setup, [], 'a task without setup has an empty list');
    assert.deepEqual(tar.files.map((file) => file.name), ['acceptance.yml', 'oracle.patch', 'repo.tar', 'task.yml']);

    // The oracle patch is kept byte for byte: a patch of a CRLF file holds CR, and a README beside the task is allowed.
    const crlfDir = path.join(CASES_ROOT, 'valid-crlf-patch', 'crlf-patch');
    await writeTask(crlfDir, { ...taskFiles('crlf-patch'), 'oracle.patch': ORACLE.replace(/\n/g, '\r\n'), 'README.md': 'Notes about this task.\n' });
    const crlf = await load.loadTask(crlfDir);
    assert.deepEqual(crlf.files.map((file) => file.name), ['README.md', 'acceptance.yml', 'oracle.patch', 'task.yml']);
    ok('a valid task loads: normalised task, the parsed acceptance.yml, every file with its sha256, and the task hash by the documented rule (git and tarball sources, a CRLF oracle patch, a README)');
  }

  // ==== malformed tasks: each refused with its own code and message ======================================================================
  {
    const base = taskYml('base-task');
    const yml = (edit) => (files) => ({ ...files, 'task.yml': edit(files['task.yml']) });
    const without = (name) => (files) => ({ ...files, [name]: null });
    const CASES = [
      // [name, change, code, fragment of the message, line?, folder?]
      ['marker-missing', yml((t) => swap(t, indent(CONTRACT, 2), '  Say when you are done.')), 'marker_contract_missing', 'prompt'],
      ['marker-altered', yml((t) => swap(t, '  BLOCKED: <reason>', '  BLOCKED <reason>')), 'marker_contract_missing', 'prompt'],
      ['marker-not-last', yml((t) => swap(t, indent(CONTRACT, 2), `${indent(CONTRACT, 2)}\n  Thank you.`)), 'marker_contract_not_last', 'prompt'],
      ['marker-glued', yml((t) => swap(t, 'numbers.\n\n  When you are finished', 'numbers.\n  Then: When you are finished')), 'marker_contract_missing', 'prompt'],
      ['sha256-upper-case', yml((t) => swap(t, sha256(hiddenBytes('base-task')), sha256(hiddenBytes('base-task')).toUpperCase())), 'bad_sha256', 'hidden_tests.sha256', lineOf(base, '  sha256:')],
      ['sha256-short', yml((t) => swap(t, sha256(hiddenBytes('base-task')), sha256(hiddenBytes('base-task')).slice(1))), 'bad_sha256', 'hidden_tests.sha256'],
      ['sha256-number', yml((t) => swap(t, `  sha256: ${sha256(hiddenBytes('base-task'))}`, '  sha256: 1234')), 'bad_sha256', 'hidden_tests.sha256'],
      ['git-without-commit', yml((t) => swap(t, '    commit: 0123456789abcdef0123456789abcdef01234567\n', '')), 'missing_key', '`commit`', lineOf(base, '  git:')],
      ['git-short-commit', yml((t) => swap(t, 'commit: 0123456789abcdef0123456789abcdef01234567', 'commit: 0123abc')), 'bad_commit', 'repo.git.commit'],
      ['git-branch-name', yml((t) => swap(t, 'commit: 0123456789abcdef0123456789abcdef01234567', 'commit: main')), 'bad_commit', 'repo.git.commit'],
      ['git-url-credentials', yml((t) => swap(t, 'https://example.invalid/corpus/sum.git', 'https://user:secret@example.invalid/corpus/sum.git')), 'bad_git_url', 'repo.git.url'],
      ['git-url-ssh', yml((t) => swap(t, 'https://example.invalid/corpus/sum.git', 'git@example.invalid:corpus/sum.git')), 'bad_git_url', 'repo.git.url'],
      ['git-url-http', yml((t) => swap(t, 'https://example.invalid/corpus/sum.git', 'http://example.invalid/corpus/sum.git')), 'bad_git_url', 'repo.git.url'],
      ['both-sources', (files) => ({ ...files, 'repo.tar': tarBytes('base-task'), 'task.yml': swap(files['task.yml'], 'repo:\n', `repo:\n  tarball:\n    file: repo.tar\n    sha256: ${sha256(tarBytes('base-task'))}\n`) }), 'repo_source_both', '`git` and `tarball`'],
      ['no-source', yml((t) => swap(t, 'repo:\n  git:\n    url: https://example.invalid/corpus/sum.git\n    commit: 0123456789abcdef0123456789abcdef01234567\n', 'repo:\n')), 'bad_type', '`repo`'],
      ['acceptance-duplicate-id', (files) => ({ ...files, 'acceptance.yml': `${ACCEPTANCE.replace('protected:', '  - id: public-tests\n    text: Again\n    manual:\n      note: x\nprotected:')}` }), 'acceptance_invalid', 'two criteria have the same id', 7],
      ['acceptance-anchor', (files) => ({ ...files, 'acceptance.yml': ACCEPTANCE.replace('text: The public tests pass', 'text: &t The public tests pass') }), 'acceptance_invalid', 'anchors', 4],
      ['acceptance-cwd-escape', (files) => ({ ...files, 'acceptance.yml': ACCEPTANCE.replace('      - run: node --test test', '      - run: node --test test\n        cwd: ../..') }), 'acceptance_invalid', 'cwd'],
      ['path-parent', yml((t) => swap(t, '  - src/**', '  - ../outside/**')), 'path_outside_repo', 'allowed_paths[0]', lineOf(base, '  - src/**')],
      ['path-parent-inside', yml((t) => swap(t, '  - src/**', '  - src/../../outside')), 'path_outside_repo', 'allowed_paths[0]'],
      ['path-absolute', yml((t) => swap(t, '  - ./test/extra/', '  - /etc/**')), 'path_outside_repo', 'allowed_paths[1]', lineOf(base, '  - ./test/extra/')],
      ['path-drive', yml((t) => swap(t, '  - src/**', '  - C:\\work\\**')), 'path_outside_repo', 'allowed_paths[0]'],
      ['path-drive-relative', yml((t) => swap(t, '  - src/**', '  - D:src')), 'path_outside_repo', 'allowed_paths[0]'],
      ['path-unc', yml((t) => swap(t, '  - src/**', '  - \\\\server\\share\\src')), 'path_outside_repo', 'allowed_paths[0]'],
      ['path-home', yml((t) => swap(t, '  - src/**', '  - ~/src')), 'path_outside_repo', 'allowed_paths[0]'],
      ['path-duplicate-spelling', yml((t) => swap(t, '  - ./test/extra/', '  - ./src/**')), 'duplicate_item', 'allowed_paths[1]'],
      ['path-too-many', yml((t) => swap(t, '  - ./test/extra/\n', Array.from({ length: 100 }, (_, i) => `  - extra${i}/**\n`).join(''))), 'bad_count', 'allowed_paths'],
      ['limit-negative', yml((t) => swap(t, 'wall_seconds: 900', 'wall_seconds: -5')), 'out_of_range', 'limits.wall_seconds', lineOf(base, 'wall_seconds')],
      ['limit-huge', yml((t) => swap(t, 'wall_seconds: 900', 'wall_seconds: 99999999')), 'out_of_range', 'limits.wall_seconds'],
      ['limit-zero-turns', yml((t) => swap(t, 'max_turns: 50', 'max_turns: 0')), 'out_of_range', 'limits.max_turns'],
      ['limit-huge-cost', yml((t) => swap(t, 'max_turns: 50', 'max_turns: 50\n  max_cost_cents: 1000000')), 'out_of_range', 'limits.max_cost_cents'],
      ['limit-not-whole', yml((t) => swap(t, 'wall_seconds: 900', 'wall_seconds: 1.5')), 'bad_type', 'limits.wall_seconds'],
      ['limit-missing', yml((t) => swap(t, '  wall_seconds: 900\n', '')), 'missing_key', '`wall_seconds`'],
      ['unknown-key', yml((t) => `${t}difficulty: hard\n`), 'unknown_key', '`difficulty`', base.split('\n').length],
      ['unknown-key-nested', yml((t) => swap(t, '  max_turns: 50', '  max_turns: 50\n  memory_mb: 512')), 'unknown_key', '`memory_mb` in `limits`', lineOf(base, 'max_turns') + 1],
      ['id-case', yml((t) => swap(t, 'id: base-task', 'id: Base-Task')), 'bad_id', '`id`'],
      ['id-underscore', yml((t) => swap(t, 'id: base-task', 'id: base_task')), 'bad_id', '`id`'],
      ['id-dots', yml((t) => swap(t, 'id: base-task', 'id: ..')), 'bad_id', '`id`'],
      ['id-slash', yml((t) => swap(t, 'id: base-task', 'id: tasks/base-task')), 'bad_id', '`id`'],
      ['id-device', yml((t) => swap(t, 'id: base-task', 'id: con')), 'bad_id', 'Windows device'],
      ['id-trailing-hyphen', yml((t) => swap(t, 'id: base-task', 'id: base-')), 'bad_id', '`id`'],
      ['id-folder-mismatch', yml((t) => swap(t, 'id: base-task', 'id: other-task')), 'id_folder_mismatch', 'other-task'],
      ['bom', yml((t) => `\uFEFF${t}`), 'bom', 'byte order mark'],
      ['crlf', yml((t) => t.replace(/\n/g, '\r\n')), 'crlf', 'LF'],
      ['empty', yml(() => ''), 'empty_file', 'no content'],
      ['only-comments', yml(() => '# nothing here yet\n\n'), 'empty_file', 'no content'],
      ['not-a-mapping', yml(() => '- a\n- b\n'), 'not_a_mapping', 'mapping'],
      ['too-large', yml((t) => `${t}# ${'x'.repeat(70 * 1024)}\n`), 'too_large', 'bytes'],
      ['yaml-anchor', yml((t) => swap(t, 'title: Add a sum function', 'title: &t Add a sum function')), 'yaml_invalid', 'anchors', lineOf(base, 'title:')],
      ['yaml-tab-indent', yml((t) => swap(t, '  - node', '\t- node')), 'yaml_invalid', 'tabs'],
      ['version-2', yml((t) => swap(t, 'version: 1', 'version: 2')), 'unsupported_version', '`version`'],
      ['version-quoted', yml((t) => swap(t, 'version: 1', 'version: "1"')), 'unsupported_version', '`version`'],
      ['title-too-long', yml((t) => swap(t, 'title: Add a sum function', `title: ${'t'.repeat(201)}`)), 'bad_length', '`title`'],
      ['title-empty', yml((t) => swap(t, 'title: Add a sum function', 'title: ""')), 'bad_length', '`title`'],
      ['title-bidi', yml((t) => swap(t, 'title: Add a sum function', 'title: "Add a \\u202Esum function"')), 'hidden_character', 'U+202E'],
      ['prompt-zero-width', yml((t) => swap(t, 'returns the sum', 'returns the\u200b sum')), 'hidden_character', 'U+200B'],
      ['title-quoted-line-break', yml((t) => swap(t, 'title: Add a sum function', 'title: "Add a\\nsum function"')), 'hidden_character', 'line break'],
      ['setup-ambiguous-comment', yml((t) => swap(t, '  - npm ci', '  - node -e "process.exit(0)" # keep')), 'ambiguous_comment', 'setup[0]'],
      ['setup-not-a-list', yml((t) => swap(t, 'setup:\n  - npm ci', 'setup: npm ci')), 'bad_type', '`setup`'],
      ['tag-duplicate', yml((t) => swap(t, '  - small', '  - node')), 'duplicate_item', 'tags[1]'],
      ['tag-bad', yml((t) => swap(t, '  - small', '  - Small Task')), 'bad_tag', 'tags[1]'],
      ['tags-missing', yml((t) => swap(t, 'tags:\n  - node\n  - small\n', '')), 'missing_key', '`tags`'],
      ['oracle-file-missing', without('oracle.patch'), 'oracle_missing', 'oracle.patch'],
      ['oracle-key-missing', yml((t) => swap(t, 'oracle: oracle.patch\n', '')), 'missing_key', '`oracle`'],
      ['oracle-not-a-patch', (files) => ({ ...files, 'oracle.patch': 'TODO: write the fix\n' }), 'oracle_not_a_patch', 'oracle.patch'],
      ['oracle-empty', (files) => ({ ...files, 'oracle.patch': '' }), 'oracle_not_a_patch', 'oracle.patch'],
      ['oracle-bad-name', yml((t) => swap(t, 'oracle: oracle.patch', 'oracle: ../oracle.patch')), 'bad_file_name', '`oracle`'],
      ['oracle-device-name', yml((t) => swap(t, 'oracle: oracle.patch', 'oracle: nul.patch')), 'bad_file_name', 'Windows device'],
      ['oracle-is-task-file', yml((t) => swap(t, 'oracle: oracle.patch', 'oracle: task.yml')), 'file_name_clash', 'task.yml'],
      ['oracle-is-task-file-by-case', yml((t) => swap(t, 'oracle: oracle.patch', 'oracle: TASK.yml')), 'file_name_clash', 'TASK.yml'],
      ['oracle-too-large', (files) => ({ ...files, 'oracle.patch': `${ORACLE}+${'x'.repeat(1024 * 1024)}\n` }), 'too_large', 'oracle.patch'],
      ['acceptance-file-missing', without('acceptance.yml'), 'acceptance_missing', 'acceptance.yml'],
      ['acceptance-crlf', (files) => ({ ...files, 'acceptance.yml': ACCEPTANCE.replace(/\n/g, '\r\n') }), 'crlf', 'acceptance.yml'],
      ['acceptance-bom', (files) => ({ ...files, 'acceptance.yml': `\uFEFF${ACCEPTANCE}` }), 'bom', 'acceptance.yml'],
      ['task-file-missing', without('task.yml'), 'task_file_missing', 'task.yml'],
      ['hidden-archive-committed', (files) => ({ ...files, 'hidden.tar.gz': hiddenBytes('base-task') }), 'hidden_archive_committed', 'hidden.tar.gz'],
      ['hidden-archive-renamed', (files) => ({ ...files, 'README.md': hiddenBytes('base-task') }), 'hidden_archive_committed', 'README.md'],
      ['hidden-archive-by-case', (files) => ({ ...files, 'HIDDEN.tar.gz': Buffer.from('another copy\n') }), 'hidden_archive_committed', 'hidden.tar.gz'],
      ['unexpected-file', (files) => ({ ...files, 'notes.txt': 'scratch\n' }), 'unexpected_file', 'notes.txt'],
      ['unexpected-folder', (files) => ({ ...files, 'extra/solution.mjs': 'export {};\n' }), 'unexpected_file', 'extra'],
      ['folder-named-like-a-file', (files) => ({ ...files, 'README.md/notes.txt': 'a folder, not the notes file\n' }), 'unexpected_file', 'README.md/'],
      ['tarball-mismatch', (files) => ({ ...files, 'repo.tar': Buffer.from('another tarball\n'), 'task.yml': swap(files['task.yml'], 'repo:\n  git:\n    url: https://example.invalid/corpus/sum.git\n    commit: 0123456789abcdef0123456789abcdef01234567\n', `repo:\n  tarball:\n    file: repo.tar\n    sha256: ${sha256(tarBytes('base-task'))}\n`) }), 'tarball_mismatch', 'repo.tar'],
      ['tarball-missing', yml((t) => swap(t, 'repo:\n  git:\n    url: https://example.invalid/corpus/sum.git\n    commit: 0123456789abcdef0123456789abcdef01234567\n', `repo:\n  tarball:\n    file: repo.tar\n    sha256: ${sha256(tarBytes('base-task'))}\n`)), 'tarball_missing', 'repo.tar'],
    ];
    const problems = [];
    const codes = new Set();
    for (const [name, change, code, fragment, line, folder = 'base-task'] of CASES) {
      const dir = path.join(CASES_ROOT, name, folder);
      await writeTask(dir, change(taskFiles('base-task')));
      try {
        await load.loadTask(dir);
        problems.push(`${name}: loaded, expected ${code}`);
      } catch (error) {
        if (!(error instanceof load.CorpusError)) { problems.push(`${name}: threw ${error?.name}: ${error?.message}`); continue; }
        codes.add(error.code);
        if (error.code !== code) problems.push(`${name}: code ${error.code} (${error.message}), expected ${code}`);
        else if (!error.message.includes(fragment)) problems.push(`${name}: the message "${error.message}" does not name ${fragment}`);
        else if (line !== undefined && error.line !== line) problems.push(`${name}: line ${error.line}, expected ${line} (${error.message})`);
      }
    }
    expectNone(problems, 'malformed tasks not refused as expected');
    assert.ok(codes.size >= 15, `only ${codes.size} different refusal codes`);
    ok(`${CASES.length} malformed tasks are refused, each with its own code (${codes.size} different ones), a message that names the field or file, and the line where it matters`);
  }

  // ==== the corpus: duplicates, strays and the examples ===================================================================================
  {
    const corpus = path.join(ROOT, 'corpus-duplicate');
    await writeTask(path.join(corpus, 'tasks', 'a-task'), taskFiles('a-task'));
    await writeTask(path.join(corpus, 'tasks', 'b-task'), { ...taskFiles('a-task') });
    await writeTask(path.join(corpus, 'tasks', 'c-task'), taskFiles('c-task'));
    await fs.writeFile(path.join(corpus, 'tasks', 'README.md'), 'stray\n');
    const result = await load.loadCorpus(corpus);
    const byCode = (code) => result.errors.filter((error) => error.code === code);
    assert.equal(byCode('duplicate_id').length, 1, result.errors.map((error) => error.message).join('\n'));
    assert.match(byCode('duplicate_id')[0].message, /a-task.*a-task.*b-task|a-task.*b-task/s);
    assert.match(byCode('duplicate_id')[0].message, /b-task/);
    assert.equal(byCode('unexpected_file').length, 1);
    assert.match(byCode('unexpected_file')[0].message, /README\.md/);
    assert.deepEqual(result.tasks.map((task) => task.id), ['a-task', 'c-task'], 'the tasks that load are still returned, in id order');

    const missing = await load.loadCorpus(path.join(ROOT, 'no-such-corpus'));
    assert.deepEqual(missing.errors.map((error) => error.code), ['no_tasks_folder']);
    const emptyRoot = path.join(ROOT, 'corpus-empty');
    await fs.mkdir(path.join(emptyRoot, 'tasks'), { recursive: true });
    assert.deepEqual((await load.loadCorpus(emptyRoot)).errors.map((error) => error.code), ['empty_corpus']);
    const badFolder = path.join(ROOT, 'corpus-bad-folder');
    await writeTask(path.join(badFolder, 'tasks', 'Bad Folder'), taskFiles('bad-folder'));
    assert.deepEqual((await load.loadCorpus(badFolder)).errors.map((error) => error.code), ['bad_id']);
    ok('a corpus reports a duplicate id (naming both folders), a stray file in tasks/, a missing or empty tasks/ folder and an unsafe folder name, and still returns the tasks that load');

    const examples = await load.loadCorpus(path.join(CORPUS, 'examples'));
    expectNone(examples.errors.map((error) => error.message), 'the example corpus does not load');
    assert.deepEqual(examples.tasks.map((task) => task.id), ['example-slugify', 'example-sum']);
    for (const task of examples.tasks) {
      assert.ok(task.task.prompt.endsWith(`${CONTRACT}\n`), `${task.id}: the prompt ends with the contract`);
      assert.match(readFileSync(path.join(CORPUS, 'examples', 'tasks', task.id, 'task.yml'), 'utf8'), /^# EXAMPLE TASK/, `${task.id} says it is an example on its first line`);
    }
    assert.deepEqual(examples.tasks.map((task) => Object.keys(task.task.repo)[0]), ['tarball', 'git'], 'one example of each repository source');
    const cli = node(LOAD, [path.join(CORPUS, 'examples')]);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /2 tasks, 0 errors/);
    const cliBad = node(LOAD, [corpus]);
    assert.equal(cliBad.status, 1, cliBad.stdout + cliBad.stderr);
    assert.match(cliBad.stdout + cliBad.stderr, /duplicate_id/);
    assert.equal(node(LOAD, ['--bogus']).status, 2);
    ok('the two example tasks under corpus/examples load (one git, one tarball source, both marked as examples); the CLI exits 0, 1 with the errors, 2 for a usage error');
  }

  // ==== only the four bridge files cross into the Hub, and nothing reaches the network =====================================================
  {
    const problems = [];
    // acceptance-parser.mjs: the acceptance reader; hub-process.mjs (pod-36): the shell runner, the process tree and the pinned Git process;
    // marker.mjs (pod-26): the marker contract and its reader, which chatmcp verify exec reads an agent's claim with too; json-schema.mjs
    // (pod-38): the JSON Schema validator of the proof pack, which checks the scoring's run packs and result lines.
    const bridges = new Map([
      ['acceptance-parser.mjs', new Set(['../../DATGOLD-HUB/lib/proof/acceptance.mjs', '../../DATGOLD-HUB/lib/proof/yaml-subset.mjs', '../../DATGOLD-HUB/lib/glob-match.mjs'])],
      ['hub-process.mjs', new Set(['../../DATGOLD-HUB/lib/shell-runner.mjs', '../../DATGOLD-HUB/lib/studio-terminal.mjs', '../../DATGOLD-HUB/lib/proof/git-plumbing.mjs'])],
      ['marker.mjs', new Set(['../../DATGOLD-HUB/lib/proof/marker.mjs'])],
      ['json-schema.mjs', new Set(['../../DATGOLD-HUB/lib/proof/schema-validate.mjs'])],
    ]);
    const files = readdirSync(TOOLS).filter((name) => name.endsWith('.mjs'));
    for (const bridge of bridges.keys()) assert.ok(files.includes(bridge), `the bridge ${bridge} exists`);
    assert.ok(files.length >= 6, `expected the corpus tools, found ${files.join(', ')}`);
    for (const name of files) {
      const text = readFileSync(path.join(TOOLS, name), 'utf8');
      for (const match of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*([^)]*)\)|^\s*import\s*['"]([^'"]+)['"]/gm)) {
        const specifier = match[1] ?? match[3] ?? match[2].trim().replace(/^['"]|['"]$/g, '');
        if (match[2] !== undefined && !/^['"][^'"]+['"]$/.test(match[2].trim())) { problems.push(`${name}: a dynamic import of a computed name`); continue; }
        if (/^node:(?:http|https|http2|net|tls|dgram|dns)$/.test(specifier)) problems.push(`${name}: imports ${specifier}`);
        else if (specifier.startsWith('node:')) continue;
        else if (/^\.\/[\w.-]+\.mjs$/.test(specifier)) continue;
        else if (bridges.get(name)?.has(specifier)) continue;
        else problems.push(`${name}: imports ${specifier}`);
      }
      if (/\bfetch\s*\(/.test(text)) problems.push(`${name}: calls fetch`);
      if (/['"](?:push|fetch|pull|clone|ls-remote|remote|submodule)['"]/.test(text)) problems.push(`${name}: names a Git command that talks to a remote`);
    }
    expectNone(problems, 'corpus tools that reach past the four bridges or towards the network');
    // the bridge passes the Hub's reader on as it is: the scoring and chatmcp verify exec read a claim with the same function
    const hubMarker = await import(pathToFileURL(path.join(HUB, 'lib', 'proof', 'marker.mjs')).href);
    for (const name of ['parseFinalMarker', 'finalLine', 'MARKER_CONTRACT', 'MARKER_CONTRACT_VERSION', 'BLOCKED_REASON_MAX']) {
      assert.ok(hubMarker[name] !== undefined && marker[name] === hubMarker[name], `corpus/tools/marker.mjs passes on ${name} of DATGOLD-HUB/lib/proof/marker.mjs`);
    }
    // the fourth bridge passes the validator on as it is: run packs and result lines are checked by the code that checks proof packs
    const hubSchema = await import(pathToFileURL(path.join(HUB, 'lib', 'proof', 'schema-validate.mjs')).href);
    const jsonSchema = await importTool('json-schema.mjs');
    for (const name of ['compileSchema', 'SchemaError', 'SUPPORTED_KEYWORDS']) {
      assert.ok(hubSchema[name] !== undefined && jsonSchema[name] === hubSchema[name], `corpus/tools/json-schema.mjs passes on ${name} of DATGOLD-HUB/lib/proof/schema-validate.mjs`);
    }
    ok(`the ${files.length} corpus tools import only node: modules, each other and, in four bridge files alone, the pod-20 acceptance parser, the Hub's process and pinned Git helpers, the marker reader and the schema validator; none can reach the network`);
  }

  // ==== freeze ==========================================================================================================================
  const CONFIG = {
    version: 1,
    agents: [
      { id: 'claude-code', cli: 'claude -p', version: '2.1.0', model: 'example-model' },
      { id: 'codex', cli: 'codex exec', version: '0.50.0' },
    ],
  };
  async function makeRepo(where, { corpusPath = 'corpus' } = {}) {
    await fs.mkdir(where, { recursive: true });
    git(where, ['init', '-q']);
    git(where, ['config', 'user.name', 'Corpus Test']);
    git(where, ['config', 'user.email', 'corpus-test@example.invalid']);
    const corpus = path.join(where, corpusPath);
    await writeTask(path.join(corpus, 'tasks', 'alpha'), taskFiles('alpha'));
    await writeTask(path.join(corpus, 'tasks', 'beta'), taskFiles('beta', { source: 'tarball' }));
    if (corpusPath !== '.') await fs.writeFile(path.join(where, 'other.txt'), 'outside the corpus\n');
    git(where, ['add', '-A']);
    git(where, ['commit', '-q', '-m', 'the corpus']);
    return corpus;
  }
  async function makeHidden(where) {
    for (const id of ['alpha', 'beta']) {
      await fs.mkdir(path.join(where, id), { recursive: true });
      await fs.writeFile(path.join(where, id, 'hidden.tar.gz'), hiddenBytes(id));
    }
    return where;
  }
  async function writeConfig(file, config = CONFIG) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
    return file;
  }
  const freeze = (args) => node(FREEZE, args);
  const refusal = (result) => `${result.stdout}${result.stderr}`;
  const head = (repo) => git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  const tags = (repo) => git(repo, ['tag', '--list']).stdout.trim();

  const repoA = path.join(ROOT, 'repo-a');
  const corpusA = await makeRepo(repoA);
  const hiddenA = await makeHidden(path.join(ROOT, 'hidden-a'));
  const configA = await writeConfig(path.join(ROOT, 'config-a', 'freeze.json'));
  const outDir = path.join(ROOT, 'out');
  await fs.mkdir(outDir, { recursive: true });
  const base = (out, extra = []) => ['--corpus', corpusA, '--hidden', hiddenA, '--config', configA, '--out', out, ...extra];

  // ---- the file: deterministic, complete, free of time and of paths ---------------------------------------------------------------------
  let preregistrationText;
  {
    const first = freeze(base(path.join(outDir, 'one.json'), ['--no-tag']));
    assert.equal(first.status, 0, refusal(first));
    await new Promise((resolve) => { setTimeout(resolve, 1100); });
    const second = freeze(base(path.join(outDir, 'two.json'), ['--no-tag']));
    assert.equal(second.status, 0, refusal(second));
    const one = readFileSync(path.join(outDir, 'one.json'));
    assert.ok(one.equals(readFileSync(path.join(outDir, 'two.json'))), 'two runs, more than a second apart, write the same bytes');
    assert.equal(tags(repoA), '', '--no-tag creates no tag');
    preregistrationText = one.toString('utf8');
    assert.match(first.stdout, new RegExp(`sha256 ${sha256(one)}`), 'the run prints the sha256 of the file');

    const doc = JSON.parse(preregistrationText);
    assert.equal(preregistrationText, `${JSON.stringify(doc, null, 2)}\n`, 'two-space JSON with a final LF');
    assert.equal(doc.format, 'pod-corpus-preregistration');
    assert.equal(doc.format_version, 1);
    assert.equal(doc.corpus.path, 'corpus');
    assert.equal(doc.corpus.commit, head(repoA));
    assert.equal(doc.corpus.tasks, 2);
    assert.equal(doc.corpus.schema_sha256, sha256(readFileSync(path.join(CORPUS, 'schema', 'task.schema.json'))));
    const loaded = await load.loadCorpus(corpusA);
    assert.deepEqual(doc.tasks.map((task) => task.id), ['alpha', 'beta']);
    for (const [index, task] of loaded.tasks.entries()) {
      const entry = doc.tasks[index];
      assert.equal(entry.sha256, task.sha256, `${task.id}: the task hash`);
      assert.deepEqual(entry.files, Object.fromEntries(task.files.map((file) => [file.name, file.sha256])), `${task.id}: every file's hash`);
      for (const file of task.files) assert.equal(entry.files[file.name], sha256(readFileSync(path.join(corpusA, 'tasks', task.id, file.name))));
      assert.deepEqual(entry.hidden_tests, { archive: 'hidden.tar.gz', sha256: sha256(hiddenBytes(task.id)) }, `${task.id}: the hidden archive hash`);
      assert.deepEqual(entry.repo, task.task.repo);
      assert.deepEqual(entry.limits, task.task.limits);
      assert.deepEqual(entry.tags, task.task.tags);
    }
    assert.equal(doc.corpus.sha256, sha256(loaded.tasks.map((task) => `${task.sha256}  ${task.id}\n`).join('')), 'the corpus hash is the sha256 of "<task sha256>  <id>\\n" lines in id order');
    assert.deepEqual(doc.agents, CONFIG.agents, 'the agent versions come from the configuration file, as written');
    assert.deepEqual(doc.marker_contract, { version: 1, text: CONTRACT, sha256: sha256(CONTRACT) });
    assert.deepEqual(doc.protocol, JSON.parse(JSON.stringify(protocol.PROTOCOL)));
    assert.deepEqual(doc.metrics, JSON.parse(JSON.stringify(protocol.METRICS)));
    assert.deepEqual(doc.kill_rule, JSON.parse(JSON.stringify(protocol.KILL_RULE)));
    assert.equal(doc.kill_rule.metric, 'false_done_rate');
    assert.equal(doc.kill_rule.threshold, 0.1, 'the 10 percent false-done kill rule');
    for (const id of ['claimed_done', 'reverified_pass', 'hidden_pass', 'false_done', 'false_done_rate', 'tamper', 'out_of_scope', 'cost_per_verified_task', 'wall_seconds']) {
      assert.ok(doc.metrics.some((metric) => metric.id === id && metric.definition.length > 20), `the metric ${id} is defined`);
    }
    assert.equal(doc.protocol.repeats_per_task_and_agent, 3);
    assert.equal(doc.protocol.hidden_test_runs, 3);
    assert.deepEqual(doc.scoring_code, { commit: head(repoA), repository: null });
    for (const form of [ROOT, ROOT.replace(/\\/g, '/'), ROOT.replace(/\\/g, '\\\\'), path.basename(ROOT)]) {
      assert.ok(!preregistrationText.includes(form), `the file names ${form}`);
    }
    assert.doesNotMatch(preregistrationText, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\b1[6-9]\d{8}\b/, 'no date or Unix time in the file');
    ok('freeze writes the same bytes twice (a second apart): task and file hashes, hidden archive hashes, agent versions from the config, the marker contract, metric definitions, thresholds with the 10 percent false-done kill rule and the scoring commit; no time and no local path');
  }

  // ---- the same corpus elsewhere gives the same file; another scoring commit is taken from the config --------------------------------------
  {
    const repoB = path.join(ROOT, 'elsewhere', 'deeper', 'repo-b');
    git(ROOT, ['clone', '-q', '--no-hardlinks', repoA, repoB]);
    const hiddenB = path.join(ROOT, 'elsewhere', 'private');
    await fs.cp(hiddenA, hiddenB, { recursive: true });
    const configB = await writeConfig(path.join(ROOT, 'elsewhere', 'config.json'));
    const result = freeze(['--corpus', path.join(repoB, 'corpus'), '--hidden', hiddenB, '--config', configB, '--out', path.join(outDir, 'b.json'), '--no-tag']);
    assert.equal(result.status, 0, refusal(result));
    assert.equal(readFileSync(path.join(outDir, 'b.json'), 'utf8'), preregistrationText, 'a clone at another path, with the archives and the config elsewhere, gives the same bytes');

    const scoring = { repository: 'https://example.invalid/scoring.git', commit: 'fedcba9876543210fedcba9876543210fedcba98' };
    const configC = await writeConfig(path.join(ROOT, 'config-c.json'), { ...CONFIG, scoring_code: scoring });
    const withScoring = freeze(base(path.join(outDir, 'c.json'), ['--no-tag']).map((arg) => (arg === configA ? configC : arg)));
    assert.equal(withScoring.status, 0, refusal(withScoring));
    assert.deepEqual(JSON.parse(readFileSync(path.join(outDir, 'c.json'), 'utf8')).scoring_code, scoring);

    const flat = path.join(ROOT, 'repo-flat');
    const flatCorpus = await makeRepo(flat, { corpusPath: '.' });
    const flatResult = freeze(['--corpus', flatCorpus, '--hidden', hiddenA, '--config', configA, '--out', path.join(outDir, 'flat.json'), '--no-tag']);
    assert.equal(flatResult.status, 0, refusal(flatResult));
    const flatDoc = JSON.parse(readFileSync(path.join(outDir, 'flat.json'), 'utf8'));
    assert.equal(flatDoc.corpus.path, '.', 'a corpus at the top of its repository (the planned public repository) has the path "."');
    assert.equal(flatDoc.corpus.sha256, JSON.parse(preregistrationText).corpus.sha256, 'the same tasks hash the same wherever the corpus stands');
    ok('the same corpus in a clone at another path writes the same bytes; a scoring commit in the config is recorded as given; a corpus at the top of its repository is recorded with the path "."');
  }

  // ---- the tag: local, annotated, carrying the file ---------------------------------------------------------------------------------------
  {
    const bare = path.join(ROOT, 'remote.git');
    git(ROOT, ['init', '-q', '--bare', bare]);
    git(repoA, ['remote', 'add', 'origin', bare]);
    const out = path.join(outDir, 'tagged.json');
    const result = freeze(base(out, ['--tag', 'prereg-2026-test']));
    assert.equal(result.status, 0, refusal(result));
    assert.equal(readFileSync(out, 'utf8'), preregistrationText, 'the tagged run writes the same file');
    assert.equal(git(repoA, ['cat-file', '-t', 'refs/tags/prereg-2026-test']).stdout.trim(), 'tag', 'an annotated tag');
    assert.equal(git(repoA, ['rev-parse', 'prereg-2026-test^{commit}']).stdout.trim(), head(repoA), 'on the commit whose corpus was hashed');
    const tagObject = git(repoA, ['cat-file', 'tag', 'prereg-2026-test']).stdout;
    assert.ok(tagObject.includes(`preregistration.json sha256 ${sha256(preregistrationText)}`), 'the tag message names the file hash');
    assert.ok(tagObject.includes(preregistrationText), 'and holds the file itself, byte for byte');
    assert.match(tagObject, /^tagger Corpus Test <corpus-test@example\.invalid> \d+ [+-]\d{4}$/m, 'the tagger line holds the time: that is the evidence');
    assert.equal(git(bare, ['for-each-ref', 'refs/tags']).stdout.trim(), '', 'nothing was pushed to the remote');

    const again = freeze(base(path.join(outDir, 'again.json'), ['--tag', 'prereg-2026-test']));
    assert.equal(again.status, 1);
    assert.match(refusal(again), /tag_exists/);
    assert.ok(!existsSync(path.join(outDir, 'again.json')), 'a refused freeze writes no file');
    for (const name of ['bad name', '../escape', '-flag', 'a..b', 'x.lock', '']) {
      const bad = freeze(base(path.join(outDir, 'bad-tag.json'), ['--tag', name]));
      assert.equal(bad.status, name === '' ? 2 : 1, `${JSON.stringify(name)}: ${refusal(bad)}`);
      if (name) assert.match(refusal(bad), /bad_tag_name/);
    }
    assert.equal(tags(repoA), 'prereg-2026-test', 'no other tag was created');
    ok('freeze tags the hashed commit with a local annotated tag whose message holds the file and its hash (the tagger time is the evidence), pushes nothing, and refuses an existing or malformed tag name');
  }

  // ---- refusals --------------------------------------------------------------------------------------------------------------------------
  {
    const out = path.join(outDir, 'refused.json');
    const expectRefused = (args, code, what) => {
      const result = freeze(args);
      assert.equal(result.status, 1, `${what}: ${refusal(result)}`);
      assert.match(refusal(result), new RegExp(code), what);
      assert.ok(!existsSync(out), `${what}: a refused freeze writes no file`);
    };
    const tagsBefore = tags(repoA);

    // A tampered hidden archive, and a missing one.
    const archive = path.join(hiddenA, 'beta', 'hidden.tar.gz');
    const original = readFileSync(archive);
    const tampered = Buffer.from(original);
    tampered[0] ^= 0x01;
    await fs.writeFile(archive, tampered);
    expectRefused(base(out, ['--tag', 'refused-1']), 'hidden_archive_mismatch', 'a tampered hidden archive');
    assert.match(refusal(freeze(base(out, ['--no-tag']))), /beta/);
    await fs.rm(archive);
    expectRefused(base(out, ['--no-tag']), 'hidden_archive_missing', 'a missing hidden archive');
    await fs.writeFile(archive, original);

    // A dirty corpus: a changed tracked file, an untracked file. A change outside the corpus folder does not count.
    const taskFile = path.join(corpusA, 'tasks', 'alpha', 'task.yml');
    const taskText = readFileSync(taskFile);
    await fs.appendFile(taskFile, '# an edit after the commit\n');
    expectRefused(base(out, ['--tag', 'refused-2']), 'dirty_tree', 'a modified task file');
    await fs.writeFile(taskFile, taskText);
    await fs.writeFile(path.join(corpusA, 'notes.txt'), 'untracked\n');
    expectRefused(base(out, ['--no-tag']), 'dirty_tree', 'an untracked file in the corpus');
    await fs.rm(path.join(corpusA, 'notes.txt'));
    await fs.appendFile(path.join(repoA, 'other.txt'), 'edited\n');
    const outside = freeze(base(path.join(outDir, 'outside.json'), ['--no-tag']));
    assert.equal(outside.status, 0, `a change outside the corpus folder: ${refusal(outside)}`);
    git(repoA, ['checkout', '--', 'other.txt']);

    // Private material inside the repository, the file inside the corpus, a repository that is not one, a corpus that does not load.
    const inside = path.join(repoA, 'private');
    await fs.cp(hiddenA, inside, { recursive: true });
    expectRefused(['--corpus', corpusA, '--hidden', inside, '--config', configA, '--out', out, '--no-tag'], 'hidden_inside_repository', 'hidden archives inside the repository');
    await fs.rm(inside, { recursive: true, force: true });
    const inCorpus = path.join(corpusA, 'preregistration.json');
    const inCorpusRun = freeze(['--corpus', corpusA, '--hidden', hiddenA, '--config', configA, '--out', inCorpus, '--no-tag']);
    assert.equal(inCorpusRun.status, 1);
    assert.match(refusal(inCorpusRun), /out_inside_corpus/);
    assert.ok(!existsSync(inCorpus));
    const plain = path.join(ROOT, 'not-a-repo');
    await writeTask(path.join(plain, 'tasks', 'alpha'), taskFiles('alpha'));
    expectRefused(['--corpus', plain, '--hidden', hiddenA, '--config', configA, '--out', out, '--no-tag'], 'not_a_repository', 'a corpus outside Git');
    const unborn = path.join(ROOT, 'unborn');
    await fs.mkdir(unborn, { recursive: true });
    git(unborn, ['init', '-q']);
    await writeTask(path.join(unborn, 'tasks', 'alpha'), taskFiles('alpha'));
    expectRefused(['--corpus', unborn, '--hidden', hiddenA, '--config', configA, '--out', out, '--no-tag'], 'no_commit', 'a repository without a commit');
    const broken = path.join(ROOT, 'repo-broken');
    const brokenCorpus = await makeRepo(broken);
    await fs.writeFile(path.join(brokenCorpus, 'tasks', 'beta', 'oracle.patch'), 'not a patch\n');
    git(broken, ['commit', '-q', '-am', 'break beta']);
    expectRefused(['--corpus', brokenCorpus, '--hidden', hiddenA, '--config', configA, '--out', out, '--no-tag'], 'corpus_invalid', 'a corpus with an invalid task');
    assert.match(refusal(freeze(['--corpus', brokenCorpus, '--hidden', hiddenA, '--config', configA, '--out', out, '--no-tag'])), /oracle_not_a_patch/);

    // Bytes on disk that are not the committed bytes (a line-end conversion at checkout): the hashes would not be the commit's.
    const converted = path.join(ROOT, 'repo-converted');
    const convertedCorpus = await makeRepo(converted);
    git(converted, ['config', 'core.autocrlf', 'true']);
    await fs.rm(path.join(convertedCorpus, 'tasks', 'alpha', 'oracle.patch'));
    git(converted, ['checkout', '--', 'corpus/tasks/alpha/oracle.patch']);
    assert.ok(readFileSync(path.join(convertedCorpus, 'tasks', 'alpha', 'oracle.patch'), 'utf8').includes('\r\n'), 'the checkout converted the line ends (the test setup)');
    expectRefused(['--corpus', convertedCorpus, '--hidden', hiddenA, '--config', configA, '--out', out, '--no-tag'], 'checkout_differs', 'a converted checkout');

    // The configuration.
    const configs = [
      ['no agents', { version: 1, agents: [] }],
      ['an unknown key', { ...CONFIG, extra: true }],
      ['an unknown agent key', { version: 1, agents: [{ ...CONFIG.agents[0], api_key: 'x' }] }],
      ['a duplicate agent', { version: 1, agents: [CONFIG.agents[0], CONFIG.agents[0]] }],
      ['an agent without a version', { version: 1, agents: [{ id: 'claude-code', cli: 'claude -p' }] }],
      ['a hidden character in a version', { version: 1, agents: [{ ...CONFIG.agents[0], version: '2.1.0\u202e' }] }],
      ['a bad agent id', { version: 1, agents: [{ ...CONFIG.agents[0], id: 'Claude Code' }] }],
      ['version 2', { ...CONFIG, version: 2 }],
      ['a short scoring commit', { ...CONFIG, scoring_code: { repository: 'https://example.invalid/s.git', commit: 'abc' } }],
    ];
    for (const [what, config] of configs) {
      const file = await writeConfig(path.join(ROOT, 'configs', `${what.replace(/\W+/g, '-')}.json`), config);
      expectRefused(['--corpus', corpusA, '--hidden', hiddenA, '--config', file, '--out', out, '--no-tag'], 'config_invalid', what);
    }
    const notJson = path.join(ROOT, 'configs', 'not-json.json');
    await fs.writeFile(notJson, '{ "version": 1, ');
    expectRefused(['--corpus', corpusA, '--hidden', hiddenA, '--config', notJson, '--out', out, '--no-tag'], 'config_invalid', 'a file that is not JSON');

    // Usage errors.
    for (const args of [[], ['--corpus', corpusA], base(out, ['--bogus']), ['--corpus', corpusA, '--hidden', hiddenA, '--config', configA, '--no-tag'], base(out, ['--tag', 'x', '--no-tag'])]) {
      const result = freeze(args);
      assert.equal(result.status, 2, `${args.join(' ')}: ${refusal(result)}`);
    }
    assert.equal(tags(repoA), tagsBefore, 'no refused run created a tag');
    ok('freeze refuses a tampered or missing hidden archive, a dirty corpus (an outside change is allowed), archives inside the repository, the file inside the corpus, no repository or commit, an invalid task, a converted checkout and 10 bad configurations; usage errors exit 2; no refusal writes a file or a tag');
  }

  // ==== the README states the format, the contract and the limits ===========================================================================
  {
    const readme = readFileSync(path.join(CORPUS, 'README.md'), 'utf8');
    for (const line of CONTRACT.split('\n')) assert.ok(readme.includes(line), `corpus/README.md quotes the contract line ${JSON.stringify(line)}`);
    for (const phrase of ['preregistration.json', 'leak', 'training', 'owner', 'vendor', 'PoD-24', 'task.schema.json', 'never pushes']) {
      assert.ok(readme.includes(phrase), `corpus/README.md mentions ${phrase}`);
    }
    ok('corpus/README.md quotes the marker contract word for word and covers pre-registration, what is not protected, the vendoring plan and the pending split');
  }
} finally {
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
}

console.log(`PASS: ${checks} corpus-tool checks (marker contract, schema, valid and malformed tasks, corpus, import boundary, freeze, README)`);
