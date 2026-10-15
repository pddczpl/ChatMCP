// Integration tests for the local tool server against a real workspace and a real Git repository.
// The emphasis is on what must NEVER happen: secrets read or staged, files outside the workspace
// touched, a stale file overwritten, a repository hook or fsmonitor executed, a file corrupted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { delay, exists } from '../lib/runtime.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools, LIMITS } from '../lib/local-tools.mjs';
import { sha256 } from '../lib/fs-safe.mjs';

const isWindows = process.platform === 'win32';
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const nl = (value) => value.replace(/\r\n/g, '\n');
const textOf = (result) => result.content.map((part) => part.text).join('\n');
const errorCode = (result) => result.structuredContent?.error?.code;
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
let haveGit = true;
try { git(os.tmpdir(), '--version'); } catch { haveGit = false; }
setTimeout(() => { console.error('FAIL: the local-tools suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

// ------------------------------------------------------------------ fixture
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-local-tools-'));
const work = path.join(root, 'work');
const state = path.join(root, 'state');
await fs.mkdir(work);
await fs.mkdir(state);
const put = async (name, content) => {
  const file = path.join(work, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
};
await put('README.md', '# Demo\n\nA tiny project.\n');
await put('src/app.py', 'import os\n\n\ndef main():\n    print("hello")\n\n\nif __name__ == "__main__":\n    main()\n');
await put('src/util.py', 'def add(a, b):\n    return a + b\n\n\ndef add(x, y):\n    return x + y\n');
await put('notes.txt', 'alpha\nbeta\ngamma\n');
await put('.gitignore', '.env\nnode_modules/\nhook-ran.txt\n');
await put('.env', 'API_KEY=topsecret123\n');
await put('.env.example', 'API_KEY=\n');
await put('id_rsa', '-----BEGIN PRIVATE KEY-----\nshh-private\n-----END PRIVATE KEY-----\n');
await put('config/credentials.json', '{"password":"hunter2"}\n');
await put('node_modules/pkg/index.js', 'module.exports = "noise-marker";\n');
await put('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
await put('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n')]));
await put('utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('xin chào\r\n', 'utf16le')]));
await put('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
await put('data.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]));
await put('empty.txt', '');
await put('big.txt', Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
await put('long-line.txt', `${'x'.repeat(5000)}\n`);
await put('mixed.txt', 'a\r\nb\nc\r\n');
for (let i = 0; i < 450; i += 1) await put(`many/f${String(i).padStart(3, '0')}.txt`, 'x');
await put('.env.production', 'TOKEN=old-prod-token\n');
let defaultBranch = 'main';
if (haveGit) {
  git(work, 'init', '-q');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'add', 'README.md', 'src', 'notes.txt', '.gitignore', '.env.example', 'crlf.txt', 'bom.txt');
  git(work, 'add', '-f', '.env.production');
  git(work, 'commit', '-q', '-m', 'initial commit');
  defaultBranch = git(work, 'branch', '--show-current').trim();
}
const workspace = new StudioWorkspace({ manager: { workspace: work }, directory: state });
process.env.CHATMCP_LT_TOKEN = 'must-not-reach-children';
const tools = new LocalTools({ workspace, stateDirectory: state });
const call = (name, args, context) => tools.call(name, args, context);
async function cleanup() { await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 400 }).catch(() => console.warn(`  (could not remove ${root})`)); }

// ------------------------------------------------------------------ catalog
{
  const definitions = tools.definitions();
  const expected = [
    'read_file', 'list_directory', 'find_files', 'search_files', 'git_status', 'git_diff', 'git_log', 'get_plan', 'update_plan', 'write_file', 'edit_file',
    'make_directory', 'move_path', 'git_add', 'git_commit', 'git_branch', 'delete_path', 'run_command',
    'symbols_search', 'symbols_references', 'tasks_run', 'tasks_list', 'tasks_status', 'tasks_cancel',
    'files_write_batch', 'files_apply_patch', 'git_checkout', 'git_merge', 'worktrees_list', 'worktrees_create', 'worktrees_remove',
    'knowledge_create', 'knowledge_search', 'knowledge_list', 'github_read', 'github_action',
    'repo_map', 'code_symbols', 'find_definition', 'find_references', 'dependency_graph', 'code_diagnostics',
    'token_stats', 'token_restore', 'token_profile',
    'web_fetch','web_extract','web_search','docs_search','dependency_lookup','github_code_search',
    'test_discover','test_run','test_results','test_coverage','github_workflow_runs','github_workflow_status',
    'github_job_logs','github_pr_review','github_rerun_failed','github_pr_merge','github_release_create',
    'browser_launch','browser_navigate','browser_click','browser_fill','browser_screenshot','browser_console',
    'browser_network','browser_close','screenshot_capture','screenshot_compare','responsive_check',
    'git_conflict_inspect','build_detect','build_run','test_impact_analysis','binary_inspect','skills_discover',
  ];
  assert.deepEqual(definitions.map((tool) => tool.originalName).sort(), [...expected].sort());
  for (const tool of definitions) {
    assert.equal(tool.name, `local.${tool.originalName}`);
    assert.equal(tool.server, 'local');
    assert.ok(tool.description.length > 30, tool.name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const key of tool.inputSchema.required) assert.ok(key in tool.inputSchema.properties, `${tool.name}.${key}`);
    for (const [key, schema] of Object.entries(tool.inputSchema.properties)) assert.ok(schema.type && schema.description || schema.items, `${tool.name}.${key} needs a type and a description`);
  }
  assert.equal(tools.has('local.read_file'), true);
  assert.equal(tools.has('read_file'), true);
  assert.equal(tools.has('local.symbols_search'), true);
  assert.equal(tools.has('local.nope'), false);
  ok('definitions: internal tool schemas, local.* names and descriptions');
}

// ------------------------------------------------------------------ read_file
{
  let r = await call('read_file', { path: 'src/app.py' });
  assert.equal(r.isError, false);
  const text = textOf(r);
  assert.match(text, /^src\/app\.py · 9 dòng · /);
  assert.ok(text.includes(`sha256: ${sha256(await fs.readFile(path.join(work, 'src/app.py')))}`));
  assert.ok(text.includes('     1\timport os'));
  assert.ok(text.includes('     5\t    print("hello")'));
  assert.equal(r.structuredContent.lines, 9);
  assert.equal(r.structuredContent.eol, 'lf');

  r = await call('read_file', { path: 'big.txt', offset: 100, limit: 5 });
  assert.match(textOf(r), /   100\tline 100\n {3}101\tline 101\n {3}102\tline 102\n {3}103\tline 103\n {3}104\tline 104\n\[Đã hiển thị dòng 100-104 \/ 3000\. Gọi lại với offset=105/);
  r = await call('read_file', { path: 'big.txt' });
  assert.equal(r.structuredContent.end, LIMITS.readLines);
  assert.match(textOf(r), /offset=2001 để đọc tiếp/);
  r = await call('read_file', { path: 'notes.txt', limit: '2' });
  assert.equal(r.isError, false, 'numeric strings are coerced');
  assert.equal(r.structuredContent.end, 2);
  ok('read_file: numbered lines, SHA-256, offset/limit paging with a continuation hint');
}
{
  assert.ok(textOf(await call('read_file', { path: 'long-line.txt' })).includes('dòng quá dài, đã cắt'));
  const crlf = textOf(await call('read_file', { path: 'crlf.txt' }));
  assert.ok(!crlf.includes('\r'), 'carriage returns are not shown');
  assert.match(crlf, /CRLF/);
  assert.match(textOf(await call('read_file', { path: 'bom.txt' })), /UTF-8 BOM/);
  assert.ok(textOf(await call('read_file', { path: 'utf16.txt' })).includes('xin chào'));
  assert.match(textOf(await call('read_file', { path: 'empty.txt' })), /file rỗng/);
  assert.equal(errorCode(await call('read_file', { path: 'latin1.txt' })), 'unsupported_encoding');
  assert.equal(errorCode(await call('read_file', { path: 'data.bin' })), 'binary_file');
  assert.equal(errorCode(await call('read_file', { path: 'src' })), 'is_directory');
  const missing = await call('read_file', { path: 'nope/missing.txt' });
  assert.equal(errorCode(missing), 'not_found');
  assert.match(textOf(missing), /nope\/missing\.txt/);
  assert.equal(errorCode(await call('read_file', { path: 'notes.txt', offset: 99 })), 'offset_out_of_range');
  assert.equal(errorCode(await call('read_file', { path: '../outside.txt' })), 'outside_workspace');
  assert.equal(errorCode(await call('read_file', { path: path.join(os.tmpdir(), 'x.txt') })), 'outside_workspace');
  assert.equal((await call('read_file', { path: path.join(work, 'notes.txt') })).isError, false, 'an absolute path inside the workspace is fine');
  try {
    await fs.symlink(work, path.join(root, 'work-alias'), 'junction');
    const viaAlias = await call('read_file', { path: path.join(root, 'work-alias', 'notes.txt') });
    assert.equal(viaAlias.isError, false, `a differently spelled absolute path to the same folder (links, 8.3 names) is accepted: ${textOf(viaAlias)}`);
    assert.equal(viaAlias.structuredContent.path, 'notes.txt');
    assert.equal(errorCode(await call('read_file', { path: path.join(root, 'work-alias', '.env') })), 'protected_path');
    assert.equal(errorCode(await call('read_file', { path: path.join(root, 'state', 'x.txt') })), 'outside_workspace');
  } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; console.warn('  SKIPPED alias-path check: this environment cannot create links'); }
  ok('read_file: encodings, binary, directories, missing files and paths outside the workspace');
}
{
  for (const secret of ['.env', './.env', 'src/../.env', '.ENV', '.git/config', 'id_rsa', 'config/credentials.json', '.env.production']) {
    const r = await call('read_file', { path: secret });
    assert.equal(r.isError, true, secret);
    assert.equal(errorCode(r), 'protected_path', secret);
    assert.ok(!textOf(r).includes('topsecret123') && !textOf(r).includes('hunter2'), `${secret} leaked`);
  }
  assert.equal((await call('read_file', { path: '.env.example' })).isError, false);
  let linked = false;
  try { await fs.symlink('.env', path.join(work, 'innocent.txt')); linked = true; } catch { /* no symlink privilege */ }
  if (linked) {
    const r = await call('read_file', { path: 'innocent.txt' });
    assert.equal(errorCode(r), 'protected_path', 'a symlink must not be a way to read a secret');
    assert.ok(!textOf(r).includes('topsecret123'));
    await fs.unlink(path.join(work, 'innocent.txt'));
  } else console.warn('  SKIPPED symlink-to-secret check: this environment does not allow symlinks');
  ok('read_file: .env, private keys, credentials and .git are refused (names, case, ../ tricks, symlinks); .env.example is allowed');
}

// ------------------------------------------------------------------ list / find / search
{
  const root1 = textOf(await call('list_directory', {}));
  assert.match(root1, /^\.\/ · \d+ mục/);
  assert.ok(root1.includes('src/\n'));
  assert.ok(root1.includes('README.md'));
  assert.match(root1, /\.env {2}\(\d+ B\) {2}\[bảo vệ\]/);
  if (haveGit) assert.match(root1, /\.git\/ {2}\[bảo vệ\]/);
  assert.match(root1, /node_modules\/ {2}\[không mở/);
  assert.ok(!root1.includes('app.py'), 'depth 1 does not open src');
  const deep = textOf(await call('list_directory', { depth: 2 }));
  assert.ok(deep.includes('  app.py'), 'a huge sibling folder must not hide src/');
  assert.match(deep, /many\/\n(?: {2}f\d{3}\.txt {2}\(1 B\)\n){60} {2}… và 390 mục khác\n/, 'a nested folder shows a short preview and says how many entries it hides');
  assert.match(deep.split('\n')[0], /thư mục con chỉ hiện 60 mục đầu/);
  assert.ok(!deep.includes('index.js'), 'node_modules stays closed');
  assert.ok(textOf(await call('list_directory', { depth: 3, include_ignored: true })).includes('index.js'));
  assert.equal(errorCode(await call('list_directory', { path: 'README.md' })), 'not_directory');
  assert.equal(errorCode(await call('list_directory', { path: '.git' })), 'protected_path');
  const many = await call('list_directory', { path: 'many' });
  assert.equal(many.structuredContent.truncated, true);
  assert.match(textOf(many), /đã giới hạn 400/);
  ok('list_directory: depth, protected and noise folders marked, entry limit');
}
{
  const py = textOf(await call('find_files', { pattern: '*.py' }));
  assert.ok(py.includes('src/app.py') && py.includes('src/util.py'));
  assert.ok(textOf(await call('find_files', { pattern: 'src/*.py' })).includes('2 file khớp'));
  assert.ok(textOf(await call('find_files', { pattern: '**/*.md' })).includes('README.md'));
  assert.ok(!textOf(await call('find_files', { pattern: '*.js' })).includes('node_modules'), 'noise folders are skipped');
  assert.ok(textOf(await call('find_files', { pattern: '*.js', include_ignored: true })).includes('node_modules/pkg/index.js'));
  const everything = textOf(await call('find_files', { pattern: '**/*', limit: 500 }));
  for (const hidden of ['.env\n', 'id_rsa', 'credentials.json', '.git/']) assert.ok(!everything.includes(hidden) && !everything.endsWith(hidden.trim()), `${hidden.trim()} must not be listed`);
  assert.ok(everything.includes('.env.example'));
  const scoped = textOf(await call('find_files', { pattern: '*.py', path: 'src' }));
  assert.ok(scoped.includes('src/app.py'), 'results stay workspace-relative');
  assert.equal(errorCode(await call('find_files', { pattern: '' })), 'invalid_arguments' && errorCode(await call('find_files', { pattern: '  ' })));
  assert.equal(errorCode(await call('find_files', { pattern: 'x/'.repeat(0) + '*/*/*/*/*/*/*/*/*' })), 'bad_pattern');
  const limited = await call('find_files', { pattern: '*.txt', path: 'many', limit: 3 });
  assert.equal(limited.structuredContent.count, 3);
  assert.equal(limited.structuredContent.truncated, true);
  ok('find_files: globs, noise folders, secrets never listed, limits');
}
{
  const literal = textOf(await call('search_files', { pattern: 'def add' }));
  assert.ok(literal.includes('src/util.py:1: def add(a, b):') && literal.includes('src/util.py:5: def add(x, y):'));
  assert.ok(textOf(await call('search_files', { pattern: 'DEF ADD', ignore_case: true })).includes('src/util.py:1:'));
  assert.ok(textOf(await call('search_files', { pattern: 'DEF ADD' })).includes('0 kết quả'));
  assert.ok(textOf(await call('search_files', { pattern: 'def (add|main)\\(', regex: true })).includes('src/app.py:4:'));
  assert.ok(textOf(await call('search_files', { pattern: 'hello', glob: '*.md' })).includes('0 kết quả'));
  assert.ok(textOf(await call('search_files', { pattern: 'tiny', glob: '*.md' })).includes('README.md:3:'));
  const context = textOf(await call('search_files', { pattern: 'return a + b', context: 1 }));
  assert.ok(context.includes('src/util.py-1- def add(a, b):') && context.includes('src/util.py:2:     return a + b') && context.includes('src/util.py-3-'));
  for (const secretText of ['topsecret123', 'hunter2', 'shh-private', 'old-prod-token']) assert.ok(textOf(await call('search_files', { pattern: secretText })).includes('0 kết quả'), `${secretText} must not be searchable`);
  assert.ok(textOf(await call('search_files', { pattern: 'noise-marker' })).includes('0 kết quả'));
  assert.ok(textOf(await call('search_files', { pattern: 'noise-marker', include_ignored: true })).includes('node_modules/pkg/index.js:1:'));
  assert.equal(errorCode(await call('search_files', { pattern: 'topsecret123', path: '.env' })), 'protected_path');
  const limited = await call('search_files', { pattern: 'line', path: 'big.txt', limit: 5 });
  assert.equal(limited.structuredContent.matches, 5);
  assert.equal(limited.structuredContent.truncated, true);
  const skipped = await call('search_files', { pattern: 'caf' });
  assert.ok(skipped.structuredContent.skipped >= 2, 'binary and non-UTF-8 files are skipped, not mangled');
  ok('search_files: literal/regex/case/glob/context, secrets and noise never searched, limits');
}
{
  for (const dangerous of ['(a+)+$', '(a|b)*c', '(x)\\1', 'a*a*a*a*a*b', '(.*)*x', '(\\w+)*$']) assert.equal(errorCode(await call('search_files', { pattern: dangerous, regex: true })), 'bad_pattern', dangerous);
  assert.equal(errorCode(await call('search_files', { pattern: '(', regex: true })), 'bad_pattern');
  for (const fine of ['def\\s+\\w+\\(', 'import .*os', 'class .*\\(.*\\):', '(foo)+', '^\\s*#', 'TODO|FIXME', '(?:foo|bar)baz', '(\\w+)\\s*=']) assert.equal((await call('search_files', { pattern: fine, regex: true })).isError, false, fine);
  const started = Date.now();
  await call('search_files', { pattern: 'a.*b.*c.*d', regex: true, path: 'long-line.txt' });
  assert.ok(Date.now() - started < 3000, 'a multi-wildcard regex over a long line stays fast');
  ok('search_files: catastrophic regexes are rejected, ordinary ones run');
}

// ------------------------------------------------------------------ write_file
{
  let r = await call('write_file', { path: 'pkg/mod/new.py', content: 'print("new")\n' });
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.created, true);
  assert.equal(await fs.readFile(path.join(work, 'pkg/mod/new.py'), 'utf8'), 'print("new")\n');
  assert.equal(r.structuredContent.sha256, sha256(Buffer.from('print("new")\n')));
  r = await call('write_file', { path: 'pkg/mod/new.py', content: 'print("v2")\n' });
  assert.equal(errorCode(r), 'file_exists');
  assert.equal(await fs.readFile(path.join(work, 'pkg/mod/new.py'), 'utf8'), 'print("new")\n', 'a refused write changes nothing');
  r = await call('write_file', { path: 'pkg/mod/new.py', content: 'print("v2")\n', expected_sha256: 'f'.repeat(64) });
  assert.equal(errorCode(r), 'stale_revision');
  r = await call('write_file', { path: 'pkg/mod/new.py', content: 'print("v2")\n', expected_sha256: sha256(Buffer.from('print("new")\n')).toUpperCase() });
  assert.equal(r.isError, false, 'the hash comparison is case-insensitive');
  assert.equal(r.structuredContent.previousSha, sha256(Buffer.from('print("new")\n')));
  r = await call('write_file', { path: 'pkg/mod/new.py', content: 'print("v3")\n', overwrite: true });
  assert.equal(r.isError, false);
  r = await call('write_file', { path: 'pkg/mod/new.py', content: 'print("v3")\n', overwrite: true });
  assert.equal(r.structuredContent.unchanged, true);
  assert.equal(errorCode(await call('write_file', { path: 'pkg/mod/new.py', content: 'x', expected_sha256: 'abc' })), 'invalid_arguments');
  ok('write_file: create, refuse blind overwrite, expected_sha256 guard, overwrite, unchanged');
}
{
  await call('write_file', { path: 'crlf.txt', content: 'a\nb\n', overwrite: true });
  assert.equal(await fs.readFile(path.join(work, 'crlf.txt'), 'utf8'), 'a\r\nb\r\n', 'CRLF is preserved');
  await call('write_file', { path: 'bom.txt', content: 'new\n', overwrite: true });
  assert.deepEqual([...(await fs.readFile(path.join(work, 'bom.txt'))).subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the BOM is preserved');
  await call('write_file', { path: 'utf16.txt', content: 'mới\n', overwrite: true });
  const wide = await fs.readFile(path.join(work, 'utf16.txt'));
  assert.deepEqual([...wide.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(wide.subarray(2).toString('utf16le'), 'mới\r\n', 'UTF-16LE and CRLF are preserved');
  ok('write_file preserves CRLF, BOM and UTF-16LE of the file it replaces');
}
{
  for (const secret of ['.env', 'id_rsa', 'config/credentials.json', '.git/hooks/pre-commit', '.git/config', '.env.local']) {
    assert.equal(errorCode(await call('write_file', { path: secret, content: 'x', overwrite: true })), 'protected_path', secret);
  }
  assert.equal(await fs.readFile(path.join(work, '.env'), 'utf8'), 'API_KEY=topsecret123\n', '.env is untouched');
  assert.equal((await call('write_file', { path: '.env.example', content: 'API_KEY=\nOTHER=\n', overwrite: true })).isError, false);
  assert.equal(errorCode(await call('write_file', { path: 'src', content: 'x', overwrite: true })), 'is_directory');
  assert.equal(errorCode(await call('write_file', { path: 'notes.txt/child.txt', content: 'x' })), 'not_directory');
  assert.equal(errorCode(await call('write_file', { path: '../escape.txt', content: 'x' })), 'outside_workspace');
  assert.equal(errorCode(await call('write_file', { path: 'with-nul-byte.txt', content: 'a\0b' })), 'bad_content');
  assert.equal(errorCode(await call('write_file', { path: 'huge.txt', content: 'x'.repeat(LIMITS.writeBytes + 1) })), 'content_too_large');
  assert.equal(errorCode(await call('write_file', { path: 'bad.txt', content: 'lone \ud800' })), 'invalid_unicode');
  assert.equal(await exists(path.join(work, 'huge.txt')), false);
  let linked = false;
  try { await fs.symlink('notes.txt', path.join(work, 'alias.txt')); linked = true; } catch { /* no symlink privilege */ }
  if (linked) {
    assert.equal(errorCode(await call('write_file', { path: 'alias.txt', content: 'x', overwrite: true })), 'symlink');
    assert.equal(errorCode(await call('edit_file', { path: 'alias.txt', old_string: 'alpha', new_string: 'omega' })), 'symlink');
    await fs.unlink(path.join(work, 'alias.txt'));
  } else console.warn('  SKIPPED symlink write check: this environment does not allow symlinks');
  if (isWindows) {
    for (const name of ['CON', 'aux.txt', 'trailing.', 'space ', 'stream.txt:hidden', '.env::$DATA']) assert.ok(['bad_name', 'alternate_stream', 'protected_path'].includes(errorCode(await call('write_file', { path: name, content: 'x', overwrite: true }))), name);
  }
  assert.deepEqual((await fs.readdir(work, { recursive: true })).filter((name) => String(name).endsWith('.tmp')), [], 'no temporary files are left behind');
  ok('write_file: secrets, .git, directories, escapes, NUL, size, bad Unicode, symlinks and Windows device names are refused');
}

// ------------------------------------------------------------------ edit_file
{
  let r = await call('edit_file', { path: 'src/app.py', old_string: 'print("hello")', new_string: 'print("hi there")' });
  assert.equal(r.isError, false, textOf(r));
  assert.match(textOf(r), /thay 1 chỗ \(dòng 5\)/);
  assert.ok(textOf(r).includes('     5\t    print("hi there")'), 'the result shows the edited region');
  assert.equal((await fs.readFile(path.join(work, 'src/app.py'), 'utf8')).includes('hi there'), true);
  r = await call('edit_file', { path: 'src/util.py', old_string: 'def add(', new_string: 'def plus(' });
  assert.equal(errorCode(r), 'ambiguous_match');
  assert.match(textOf(r), /2 lần \(dòng 1, 5\)/);
  r = await call('edit_file', { path: 'src/util.py', old_string: 'def add(', new_string: 'def plus(', replace_all: true });
  assert.equal(r.structuredContent.replacements, 2);
  r = await call('edit_file', { path: 'src/app.py', old_string: '    def main():\n        print("hi there")', new_string: 'x' });
  assert.equal(errorCode(r), 'not_found');
  assert.match(textOf(r), /dòng 4/);
  assert.equal(errorCode(await call('edit_file', { path: 'src/app.py', old_string: 'absent text', new_string: 'x' })), 'not_found');
  assert.equal(errorCode(await call('edit_file', { path: 'src/app.py', old_string: '', new_string: 'x' })), 'bad_edit');
  assert.equal(errorCode(await call('edit_file', { path: 'src/app.py', old_string: 'import os', new_string: 'import os' })), 'bad_edit');
  assert.equal(errorCode(await call('edit_file', { path: 'missing.py', old_string: 'a', new_string: 'b' })), 'not_found');
  assert.equal(errorCode(await call('edit_file', { path: 'src/app.py', old_string: 'import os', new_string: 'import sys', expected_sha256: '0'.repeat(64) })), 'stale_revision');
  ok('edit_file: exact replacement with context snippet, ambiguity, replace_all and helpful not-found hints');
}
{
  let r = await call('edit_file', { path: 'crlf.txt', old_string: 'a\nb', new_string: 'A\nB' });
  assert.equal(r.isError, false, textOf(r));
  assert.equal(await fs.readFile(path.join(work, 'crlf.txt'), 'utf8'), 'A\r\nB\r\n', 'LF in old/new text is matched against and written as CRLF');
  r = await call('edit_file', { path: 'notes.txt', old_string: 'beta', new_string: 'price $& and $1 and $$' });
  assert.equal(r.isError, false);
  assert.ok((await fs.readFile(path.join(work, 'notes.txt'), 'utf8')).includes('price $& and $1 and $$'), 'replacement text is literal');
  r = await call('edit_file', { path: 'notes.txt', old_string: 'alpha\n', new_string: '' });
  assert.equal(r.isError, false, textOf(r));
  assert.equal(await fs.readFile(path.join(work, 'notes.txt'), 'utf8'), 'price $& and $1 and $$\ngamma\n', 'an empty new_string deletes the text');
  await call('edit_file', { path: 'bom.txt', old_string: 'new', new_string: 'edited' });
  assert.deepEqual([...(await fs.readFile(path.join(work, 'bom.txt'))).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  await call('edit_file', { path: 'utf16.txt', old_string: 'mới', new_string: 'cũ' });
  assert.equal((await fs.readFile(path.join(work, 'utf16.txt'))).subarray(2).toString('utf16le'), 'cũ\r\n');
  r = await call('edit_file', { path: 'mixed.txt', old_string: 'b', new_string: 'B' });
  assert.equal(await fs.readFile(path.join(work, 'mixed.txt'), 'utf8'), 'a\r\nB\nc\r\n', 'mixed line endings are left exactly as they were');
  assert.equal(errorCode(await call('edit_file', { path: 'latin1.txt', old_string: 'caf', new_string: 'x' })), 'unsupported_encoding');
  assert.equal(errorCode(await call('edit_file', { path: 'data.bin', old_string: 'a', new_string: 'x' })), 'binary_file');
  assert.equal(errorCode(await call('edit_file', { path: '.env', old_string: 'topsecret123', new_string: 'x' })), 'protected_path');
  assert.equal(await fs.readFile(path.join(work, '.env'), 'utf8'), 'API_KEY=topsecret123\n');
  const sha = sha256(await fs.readFile(path.join(work, 'README.md')));
  r = await call('edit_file', { path: 'README.md', old_string: 'tiny', new_string: 'small', expected_sha256: sha });
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.previousSha, sha);
  ok('edit_file: CRLF/BOM/UTF-16/mixed endings preserved, replacement text literal, legacy encodings and secrets refused');
}

// ------------------------------------------------------------------ directories and moves
{
  assert.equal((await call('make_directory', { path: 'build/out/deep' })).structuredContent.created, true);
  assert.equal((await call('make_directory', { path: 'build/out/deep' })).structuredContent.created, false);
  assert.equal(errorCode(await call('make_directory', { path: 'notes.txt' })), 'already_exists');
  assert.equal(errorCode(await call('make_directory', { path: '.git/evil' })), 'protected_path');
  assert.equal(errorCode(await call('make_directory', { path: '../up' })), 'outside_workspace');

  await put('mv/a.txt', 'a');
  await put('mv/b.txt', 'b');
  assert.equal((await call('move_path', { source: 'mv/a.txt', destination: 'mv/renamed.txt' })).isError, false);
  assert.equal(await exists(path.join(work, 'mv/a.txt')), false);
  assert.equal(errorCode(await call('move_path', { source: 'mv/renamed.txt', destination: 'mv/b.txt' })), 'already_exists');
  assert.equal((await call('move_path', { source: 'mv/renamed.txt', destination: 'mv/b.txt', overwrite: true })).isError, false);
  assert.equal(await fs.readFile(path.join(work, 'mv/b.txt'), 'utf8'), 'a');
  assert.equal((await call('move_path', { source: 'mv/b.txt', destination: 'deep/er/place/b.txt' })).isError, false, 'parents are created');
  assert.equal(errorCode(await call('move_path', { source: 'mv', destination: 'mv/inside' })), 'bad_move');
  assert.equal(errorCode(await call('move_path', { source: 'mv', destination: 'mv' })), 'bad_move');
  assert.equal(errorCode(await call('move_path', { source: 'nothing', destination: 'x' })), 'not_found');
  assert.equal(errorCode(await call('move_path', { source: '.env', destination: 'env.txt' })), 'protected_path');
  assert.equal(errorCode(await call('move_path', { source: 'notes.txt', destination: '.env.local' })), 'protected_path');
  assert.equal(errorCode(await call('move_path', { source: 'notes.txt', destination: '../out.txt' })), 'outside_workspace');
  assert.equal((await call('move_path', { source: 'mv', destination: 'moved-dir' })).isError, false);
  assert.equal(await exists(path.join(work, 'moved-dir')), true);
  ok('make_directory / move_path: overwrite rules, parents, self-moves, secrets and escapes');
}
{
  await put('del/one.txt', '1');
  await put('del/sub/two.txt', '2');
  await fs.mkdir(path.join(work, 'del-empty'));
  assert.equal((await call('delete_path', { path: 'del/one.txt' })).isError, false);
  assert.equal(await exists(path.join(work, 'del/one.txt')), false);
  assert.equal((await call('delete_path', { path: 'del-empty' })).isError, false);
  assert.equal(errorCode(await call('delete_path', { path: 'del' })), 'not_empty');
  assert.equal(await exists(path.join(work, 'del/sub/two.txt')), true);
  assert.equal((await call('delete_path', { path: 'del', recursive: true })).isError, false);
  assert.equal(await exists(path.join(work, 'del')), false);
  assert.equal(errorCode(await call('delete_path', { path: '.' })), 'is_directory', 'the workspace root cannot be deleted');
  assert.equal(errorCode(await call('delete_path', { path: '' })), 'bad_path');
  assert.equal(errorCode(await call('delete_path', { path: '.git', recursive: true })), 'protected_path');
  assert.equal(errorCode(await call('delete_path', { path: '.env' })), 'protected_path');
  assert.equal(errorCode(await call('delete_path', { path: 'missing.txt' })), 'not_found');
  assert.equal(await exists(path.join(work, '.git')) || !haveGit, true, '.git survived');
  let linked = false;
  try { await fs.symlink('notes.txt', path.join(work, 'goner-link')); linked = true; } catch { /* no symlink privilege */ }
  if (linked) { await call('delete_path', { path: 'goner-link' }); assert.equal(await exists(path.join(work, 'notes.txt')), true, 'deleting a symlink never deletes its target'); }
  ok('delete_path: files, empty/non-empty folders, never the root, .git or secrets');
}

// ------------------------------------------------------------------ plan
{
  const taskId = '123e4567-e89b-42d3-a456-426614174000';
  const set = await call('update_plan', { title: 'Fix bug', items: [{ text: 'Reproduce', status: 'done', evidence: 'pytest fails' }, { text: 'Patch', status: 'doing' }, { text: 'Verify', status: 'todo' }] }, { taskId });
  assert.equal(set.isError, false, textOf(set));
  assert.match(textOf(set), /Fix bug\n\[x\] Reproduce — pytest fails\n\[~\] Patch\n\[ \] Verify\n1\/3 bước hoàn tất/);
  const got = await call('get_plan', {}, { taskId });
  assert.equal(got.structuredContent.total, 3);
  assert.equal(got.structuredContent.items[1].status, 'doing');
  assert.equal(errorCode(await call('update_plan', { items: [{ text: 'x', status: 'maybe' }] }, { taskId })), 'invalid_arguments');
  assert.equal(errorCode(await call('get_plan', {}, { taskId: 'not-a-uuid' })), 'bad_task_id');
  ok('update_plan / get_plan: checklist with evidence, validation, per-conversation storage');
}

// ------------------------------------------------------------------ git
if (!haveGit) console.warn('  SKIPPED git tool checks: git is not installed');
else {
  let r = await call('git_status', {});
  assert.equal(r.isError, false, textOf(r));
  assert.ok(textOf(r).includes(`Nhánh: ${defaultBranch}`));
  assert.match(textOf(r), /HEAD: [0-9a-f]{7,}/);
  assert.ok(textOf(r).includes('id_rsa') && textOf(r).includes('[bảo vệ]'), 'untracked secrets are named but flagged');
  assert.ok(!textOf(r).includes('.env\n') || textOf(r).includes('.env.production'), 'the ignored .env is not listed');
  assert.ok(textOf(r).includes(' M src/app.py'));
  ok('git_status: branch, HEAD, changes, protected files flagged');

  // diff
  r = await call('git_diff', {});
  assert.equal(r.isError, false, textOf(r));
  assert.ok(textOf(r).includes('-    print("hello")') && textOf(r).includes('+    print("hi there")'));
  assert.ok(textOf(await call('git_diff', { path: 'src/util.py' })).includes('def plus('));
  assert.ok(!textOf(await call('git_diff', { path: 'src/util.py' })).includes('hi there'), 'path filter works');
  assert.match(textOf(await call('git_diff', { staged: true })), /Không có thay đổi/);
  assert.equal((await call('git_diff', { base: 'HEAD' })).isError, false);
  for (const bad of ['--output=/tmp/x', 'a..b', 'HEAD:.env', 'x y']) assert.equal(errorCode(await call('git_diff', { base: bad })), 'bad_revision', bad);
  await fs.writeFile(path.join(work, '.env.production'), 'TOKEN=brand-new-prod-token\n');
  const hidden = textOf(await call('git_diff', {}));
  assert.ok(!hidden.includes('brand-new-prod-token') && !hidden.includes('old-prod-token'), 'diffs of tracked secrets are hidden');
  assert.match(hidden, /1 file bí mật bị ẩn khỏi diff: \.env\.production/);
  assert.ok(hidden.includes('src/app.py'), 'the rest of the diff is still shown');
  assert.equal(errorCode(await call('git_diff', { path: '.env.production' })), 'protected_path');
  await fs.writeFile(path.join(work, '.env.production'), 'TOKEN=old-prod-token\n');
  ok('git_diff: bounded diff, path/staged/base options, unsafe revisions rejected, tracked secrets hidden');

  // log
  r = await call('git_log', {});
  assert.match(textOf(r), /1 commit gần nhất:\n[0-9a-f]{7,} {2}Test {2}\d{4}-\d\d-\d\d {2}initial commit/);
  assert.match(textOf(await call('git_log', { path: 'src/app.py' })), /initial commit/);
  assert.equal((await call('git_log', { limit: '1' })).structuredContent.commits, 1);

  // add: explicit file, wildcard refusal, secrets never staged
  r = await call('git_add', { paths: ['src/app.py'] });
  assert.equal(r.isError, false, textOf(r));
  assert.equal(git(work, 'diff', '--cached', '--name-only').trim(), 'src/app.py');
  assert.equal(errorCode(await call('git_add', { paths: ['src/*.py'] })), 'bad_path');
  assert.equal(errorCode(await call('git_add', { paths: [':(top)x'] })), 'bad_path');
  assert.equal(errorCode(await call('git_add', { paths: ['.env'] })), 'protected_path');
  assert.equal(errorCode(await call('git_add', { paths: ['.git/config'] })), 'protected_path');
  assert.equal(errorCode(await call('git_add', { paths: ['../x'] })), 'outside_workspace');
  r = await call('git_add', { paths: ['.'] });
  assert.equal(r.isError, false, textOf(r));
  const staged = git(work, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);
  assert.ok(staged.includes('src/app.py') && staged.includes('pkg/mod/new.py'), `staged: ${staged.join(', ')}`);
  assert.ok(!staged.includes('id_rsa') && !staged.includes('config/credentials.json') && !staged.includes('.env'), 'git add . never stages secrets');
  assert.ok(r.structuredContent.skippedSecrets.includes('id_rsa'));
  assert.match(textOf(r), /Bỏ qua và gỡ khỏi stage file bí mật: .*id_rsa/);
  ok('git_add: explicit paths, wildcard/pathspec magic refused, secrets never end up staged');

  // commit: hooks are skipped by default, run only on request; secrets block the commit
  const hook = path.join(work, '.git', 'hooks', 'pre-commit');
  await fs.mkdir(path.dirname(hook), { recursive: true });
  await fs.writeFile(hook, '#!/bin/sh\necho ran > hook-ran.txt\n', { mode: 0o755 });
  git(work, 'add', '-f', '.env');
  r = await call('git_commit', { message: 'should be blocked' });
  assert.equal(errorCode(r), 'protected_staged');
  assert.match(textOf(r), /\.env/);
  git(work, 'reset', '-q', '.env');
  r = await call('git_commit', { message: 'feat: second commit\n\nbody line' });
  assert.equal(r.isError, false, textOf(r));
  assert.match(textOf(r), /feat: second commit/);
  assert.equal(await exists(path.join(work, 'hook-ran.txt')), false, 'repository hooks are not executed by default');
  assert.equal(git(work, 'log', '-1', '--format=%B').trim(), 'feat: second commit\n\nbody line');
  assert.equal(errorCode(await call('git_commit', { message: 'nothing staged' })), 'nothing_to_commit');
  assert.equal(errorCode(await call('git_commit', { message: '   ' })), 'bad_message');
  await fs.appendFile(path.join(work, 'README.md'), 'more\n');
  r = await call('git_commit', { message: 'docs: with hooks', all: true, run_hooks: true });
  assert.equal(r.isError, false, textOf(r));
  assert.equal(await exists(path.join(work, 'hook-ran.txt')), true, 'run_hooks:true runs the repository hook');
  await fs.rm(path.join(work, 'hook-ran.txt'), { force: true });
  await fs.writeFile(path.join(work, '.env.production'), 'TOKEN=changed\n');
  await fs.appendFile(path.join(work, 'README.md'), 'again\n');
  r = await call('git_commit', { message: 'must not include secrets', all: true });
  assert.equal(errorCode(r), 'protected_staged', 'commit -a refuses when a tracked secret is modified');
  await fs.writeFile(path.join(work, '.env.production'), 'TOKEN=old-prod-token\n');
  r = await call('git_commit', { message: 'docs: all', all: true });
  assert.equal(r.isError, false, textOf(r));
  assert.equal(git(work, 'status', '--porcelain', '--untracked-files=no').trim(), '');
  ok('git_commit: message kept verbatim, hooks skipped unless requested, secrets block the commit, -a guarded');

  // branches
  r = await call('git_branch', { action: 'list' });
  assert.ok(textOf(r).includes(`* ${defaultBranch}`));
  r = await call('git_branch', { action: 'create', name: 'feature/login' });
  assert.equal(r.isError, false, textOf(r));
  assert.equal(git(work, 'branch', '--show-current').trim(), 'feature/login');
  assert.equal((await call('git_branch', { action: 'switch', name: defaultBranch })).isError, false);
  assert.equal(git(work, 'branch', '--show-current').trim(), defaultBranch);
  assert.equal(errorCode(await call('git_branch', { action: 'create', name: 'bad name' })), 'bad_branch');
  assert.equal(errorCode(await call('git_branch', { action: 'create', name: '-x' })), 'bad_branch');
  assert.equal(errorCode(await call('git_branch', { action: 'create', name: 'x', start_point: '--force' })), 'bad_revision');
  assert.equal(errorCode(await call('git_branch', { action: 'create' })), 'bad_branch');
  assert.equal(errorCode(await call('git_branch', { action: 'create', name: 'feature/login' })), 'git_error');
  assert.equal(errorCode(await call('git_branch', { action: 'delete', name: 'x' })), 'invalid_arguments');
  assert.equal(errorCode(await call('git_branch', { action: 'switch', name: 'does-not-exist' })), 'git_error');
  ok('git_branch: list/create/switch, invalid names and revisions rejected, no delete');

  // not a repository / nested workspace
  const plainDir = path.join(root, 'plain');
  await fs.mkdir(plainDir);
  const plainTools = new LocalTools({ workspace: new StudioWorkspace({ manager: { workspace: plainDir }, directory: state }), stateDirectory: state });
  assert.equal(errorCode(await plainTools.call('git_status', {})), 'not_git_repo');
  const nestedDir = path.join(work, 'nested-ws');
  await fs.mkdir(nestedDir, { recursive: true });
  const nestedTools = new LocalTools({ workspace: new StudioWorkspace({ manager: { workspace: nestedDir }, directory: state }), stateDirectory: state });
  assert.equal(errorCode(await nestedTools.call('git_status', {})), 'git_root_mismatch');
  assert.equal(errorCode(await nestedTools.call('git_commit', { message: 'x', all: true })), 'git_root_mismatch');
  await fs.rm(nestedDir, { recursive: true, force: true });
  const emptyRepo = path.join(root, 'empty-repo');
  await fs.mkdir(emptyRepo);
  git(emptyRepo, 'init', '-q');
  const emptyTools = new LocalTools({ workspace: new StudioWorkspace({ manager: { workspace: emptyRepo }, directory: state }), stateDirectory: state });
  assert.match(textOf(await emptyTools.call('git_log', {})), /Chưa có commit nào/);
  assert.match(textOf(await emptyTools.call('git_status', {})), /\(chưa có commit\)/);
  ok('git tools: a folder that is not a repository, a workspace nested in a parent repository and an empty repository');
}

// ------------------------------------------------------------------ run_command
{
  let r = await call('run_command', { command: 'node -e "console.log(\'hi from node\')"', description: 'smoke' });
  assert.equal(r.isError, false, textOf(r));
  assert.match(textOf(r), /^exit code 0 · (bash|sh|powershell) · /);
  assert.ok(textOf(r).includes('--- stdout ---\nhi from node'));
  assert.equal(r.structuredContent.exitCode, 0);
  assert.equal(r.structuredContent.kind, 'exec');
  r = await call('run_command', { command: 'node -e "process.exit(3)"' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^exit code 3/);
  assert.equal(r.structuredContent.exitCode, 3);
  r = await call('run_command', { command: 'node -e "console.error(\'oops\')"' });
  assert.ok(textOf(r).includes('--- stderr ---\noops'));
  r = await call('run_command', { command: 'node -e "console.log(process.cwd())"', cwd: 'src' });
  assert.ok(textOf(r).trim().split('\n').at(-1).replaceAll('\\', '/').endsWith('/src'), textOf(r));
  r = await call('run_command', { command: 'node -e "console.log(process.env.CHATMCP_LT_TOKEN === undefined ? \'scrubbed\' : \'LEAKED\')"' });
  assert.ok(textOf(r).includes('scrubbed'));
  assert.equal(errorCode(await call('run_command', { command: 'echo hi', cwd: '.git' })), 'protected_path');
  assert.equal(errorCode(await call('run_command', { command: 'echo hi', cwd: '../' })), 'outside_workspace');
  assert.equal(errorCode(await call('run_command', { command: 'echo hi', cwd: 'nope' })), 'bad_cwd');
  assert.equal(errorCode(await call('run_command', { command: 'x'.repeat(LIMITS.commandChars + 1) })), 'invalid_arguments');
  assert.equal(errorCode(await call('run_command', { command: '   ' })), 'bad_command');
  if (!isWindows) {
    const psCheck = await call('run_command', { command: 'echo hi', shell: 'powershell' });
    if (psCheck.isError) assert.equal(errorCode(psCheck), 'shell_unavailable');
    else assert.ok(textOf(psCheck).includes('hi'));
  }
  const started = Date.now();
  r = await call('run_command', { command: 'node -e "setTimeout(()=>{},30000)"', timeout_seconds: 1 });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.timedOut, true);
  assert.match(textOf(r), /HẾT GIỜ/);
  assert.ok(Date.now() - started < 12_000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('user pressed stop')), 600);
  const abortedAt = Date.now();
  const stopped = await call('run_command', { command: 'node -e "setTimeout(()=>{},30000)"' }, { signal: controller.signal });
  assert.equal(stopped.isError, true);
  assert.equal(stopped.structuredContent.cancelled, true, 'cancelling a command reports what happened instead of throwing');
  assert.match(textOf(stopped), /ĐÃ HỦY/);
  assert.ok(Date.now() - abortedAt < 12_000, 'the command and its children are stopped promptly');
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(call('read_file', { path: 'notes.txt' }, { signal: pre.signal }));
  ok('run_command: output formatting, exit codes, cwd rules, scrubbed environment, timeout, cancellation');
}

// ------------------------------------------------------------------ assess
{
  const table = [
    ['read_file', { path: 'src/app.py' }, 'read'], ['read_file', { path: '.env' }, 'blocked'], ['read_file', { path: 'a/.git/config' }, 'blocked'], ['read_file', { path: '.env.example' }, 'read'],
    ['list_directory', { path: '.git' }, 'blocked'], ['find_files', { pattern: '*', path: 'config' }, 'read'], ['search_files', { pattern: 'x', path: 'id_rsa' }, 'blocked'],
    ['git_status', {}, 'read'], ['git_diff', {}, 'read'], ['git_diff', { path: '.env' }, 'blocked'], ['git_log', {}, 'read'], ['get_plan', {}, 'read'], ['update_plan', { items: [] }, 'checkpoint'],
    ['write_file', { path: 'a.py', content: 'x' }, 'workspace_edit'], ['write_file', { path: '.env', content: 'x' }, 'blocked'], ['edit_file', { path: 'a.py', old_string: 'a', new_string: 'b' }, 'workspace_edit'],
    ['make_directory', { path: 'd' }, 'workspace_edit'], ['move_path', { source: 'a', destination: 'b' }, 'workspace_edit'], ['move_path', { source: 'a', destination: '.env' }, 'blocked'],
    ['git_add', { paths: ['a'] }, 'workspace_edit'], ['git_commit', { message: 'x' }, 'workspace_edit'], ['git_commit', { message: 'x', run_hooks: true }, 'execute'],
    ['git_branch', { action: 'list' }, 'read'], ['git_branch', { action: 'create', name: 'x' }, 'workspace_edit'], ['delete_path', { path: 'a' }, 'dangerous'],
    ['run_command', { command: 'git status' }, 'read'], ['run_command', { command: 'cat src/app.py | grep main' }, 'read'], ['run_command', { command: 'npm test' }, 'workspace_edit'],
    // The suite planted an active pre-commit hook earlier, so a shell commit (which would run it) must ask; without the hook it does not (below).
    ['run_command', { command: 'git add . && git commit -m x' }, haveGit ? 'execute' : 'workspace_edit'], ['run_command', { command: 'git push' }, 'dangerous'], ['run_command', { command: 'rm -rf build' }, 'dangerous'],
    ['run_command', { command: 'curl https://example.com' }, 'execute'], ['run_command', { command: 'npm install left-pad' }, 'execute'], ['run_command', { command: 'cat .env' }, 'execute'],
    ['run_command', { command: 'ls', cwd: '.git' }, 'blocked'], ['run_command', { command: 'Get-ChildItem', shell: 'powershell' }, 'read'], ['run_command', { command: 'x'.repeat(LIMITS.commandChars + 1) }, 'execute'],
    ['nope', {}, 'unknown'], ['local.read_file', { path: 'notes.txt' }, 'read'],
  ];
  for (const [name, args, expected] of table) {
    const verdict = await tools.assess(name, args);
    assert.equal(verdict.category, expected, `${name} ${JSON.stringify(args).slice(0, 60)} -> ${verdict.category} (${verdict.reason})`);
    assert.equal(typeof verdict.summary, 'string');
  }
  const risky = await tools.assess('run_command', { command: 'npm test && git push' });
  assert.equal(risky.risk.kind, 'dangerous');
  assert.equal(risky.command, 'npm test && git push');
  assert.match(risky.reason, /dangerous/);
  assert.equal((await tools.assess('read_file', null)).category, 'read', 'malformed arguments never throw');
  assert.equal((await tools.assess('run_command', { command: 5 })).category, 'execute');
  ok(`assess: ${table.length} (tool, arguments) cases map to the right permission category`);
}
if (haveGit) {
  // A shell `git commit` would run the repository's hook with the person's rights, so it is put in front of them; switch the hook
  // off (a .sample file is inert) and the same command is an ordinary workspace edit again.
  const hook = path.join(work, '.git', 'hooks', 'pre-commit');
  const withHook = await tools.assess('run_command', { command: 'git commit -m x' });
  assert.equal(withHook.category, 'execute');
  assert.match(withHook.reason, /hooks\/pre-commit/);
  assert.equal((await tools.assess('run_command', { command: 'git status' })).category, 'read', 'a command that never runs hooks is unaffected');
  assert.equal((await tools.assess('run_command', { command: 'git diff' })).category, 'read');
  await fs.rename(hook, `${hook}.sample`);
  try {
    assert.equal((await tools.assess('run_command', { command: 'git commit -m x' })).category, 'workspace_edit');
    assert.equal((await tools.assess('run_command', { command: 'git add . && git commit -m x' })).category, 'workspace_edit');
  } finally { await fs.rename(`${hook}.sample`, hook); }
  ok('assess: a shell git command that would run a repository hook asks; without the hook it is an ordinary edit');
}
{
  assert.deepEqual(await tools.touchedPaths('write_file', { path: 'notes.txt' }), ['notes.txt']);
  assert.deepEqual(await tools.touchedPaths('write_file', { path: 'brand-new.txt' }), []);
  assert.deepEqual(await tools.touchedPaths('edit_file', { path: 'src/app.py' }), ['src/app.py']);
  assert.deepEqual(await tools.touchedPaths('write_file', { path: '.env' }), []);
  assert.deepEqual((await tools.touchedPaths('move_path', { source: 'README.md', destination: 'notes.txt' })).sort(), ['README.md', 'notes.txt']);
  await put('tp/a.txt', 'a');
  await put('tp/.env', 'secret');
  assert.deepEqual(await tools.touchedPaths('delete_path', { path: 'tp' }), ['tp/a.txt']);
  assert.deepEqual(await tools.touchedPaths('delete_path', { path: '../elsewhere' }), []);
  assert.deepEqual(await tools.touchedPaths('read_file', { path: 'notes.txt' }), []);
  ok('touchedPaths: the existing, non-secret files a call would change (for targeted checkpoints)');
}

// ------------------------------------------------------------------ arguments and environment
{
  let r = await call('read_file', {});
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.executed, false);
  assert.match(textOf(r), /path: bắt buộc/);
  r = await call('read_file', { path: 'notes.txt', bogus: 1 });
  assert.equal(errorCode(r), 'invalid_arguments');
  assert.match(textOf(r), /bogus: tham số không tồn tại/);
  assert.equal(errorCode(await call('read_file', null)), 'invalid_arguments');
  assert.equal(errorCode(await call('read_file', { path: 5 })), 'invalid_arguments');
  assert.equal(errorCode(await call('local.nothing', {})), 'unknown_tool');
  const info = await tools.diagnose();
  assert.equal(info.platform, process.platform);
  assert.ok(info.defaultShell);
  assert.equal(info.node, process.version);
  if (haveGit) assert.match(info.git.version, /^git version/);
  ok('call: schema errors come back as structured results (executed:false); diagnose() reports the environment');
}

// ------------------------------------------------------------------ extended local tools
{
  let r = await call('symbols_search', { query: 'main' });
  assert.equal(r.isError, false);
  assert.ok(r.structuredContent.count >= 1);

  r = await call('symbols_references', { symbol: 'main' });
  assert.equal(r.isError, false);
  assert.ok(r.structuredContent.count >= 1);

  r = await call('files_write_batch', { files: [{ path: 'batch1.txt', content: 'b1' }, { path: 'batch2.txt', content: 'b2' }] });
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.count, 2);

  r = await call('files_apply_patch', { path: 'batch1.txt', old_text: 'b1', new_text: 'b1_patched' });
  assert.equal(r.isError, false);

  r = await call('knowledge_create', { title: 'Test Decision', content: 'Architecture note', tags: ['arch', 'db'] });
  assert.equal(r.isError, false);

  r = await call('knowledge_list', {});
  assert.equal(r.isError, false);
  assert.ok(r.structuredContent.count >= 1);

  r = await call('knowledge_search', { query: 'Architecture' });
  assert.equal(r.isError, false);
  assert.ok(r.structuredContent.count >= 1);

  // Security checks:
  // 1. no-shell enforcement
  {
    const toolsNoShell = new LocalTools({ workspace, disabledTools: ['run_command'] });
    assert.equal(toolsNoShell.has('run_command'), false);
    assert.equal(toolsNoShell.has('tasks_run'), false);
    assert.equal(toolsNoShell.has('github_action'), false);
    const rNoShell = await toolsNoShell.call('tasks_run', { command: 'echo 1' });
    assert.equal(rNoShell.isError, true);
    assert.equal(rNoShell.structuredContent?.error?.code, 'unknown_tool');
  }

  // 2. batch preflight checks: rejecting protected .env and duplicate paths
  {
    const rBadBatch = await call('files_write_batch', { files: [{ path: 'valid_x.txt', content: 'x' }, { path: '.env', content: 'KEY=1' }] });
    assert.equal(rBadBatch.isError, true);
    assert.equal(rBadBatch.structuredContent?.error?.code, 'protected_path');
    assert.equal(await exists(path.join(work, 'valid_x.txt')), false, 'preflight prevents partial write');

    const rDup = await call('files_write_batch', { files: [{ path: 'dup.txt', content: '1' }, { path: 'dup.txt', content: '2' }] });
    assert.equal(rDup.isError, true);
    assert.equal(rDup.structuredContent?.error?.code, 'duplicate_path');
  }

  // 3. worktree & git safety: non-worktree deletion refused, bad ref refused
  {
    const rBadRemove = await call('worktrees_remove', { path: 'notes.txt' });
    assert.equal(rBadRemove.isError, true);
    assert.ok(['not_a_worktree', 'git_error'].includes(rBadRemove.structuredContent?.error?.code));

    const rBadRef = await call('git_checkout', { ref: '--help' });
    assert.equal(rBadRef.isError, true);
    assert.equal(rBadRef.structuredContent?.error?.code, 'bad_ref');
  }

  // 4. batch expected SHA-256 preflight check
  {
    const beforeContent = await fs.readFile(path.join(work, 'notes.txt'), 'utf8');
    const rShaMismatch = await call('files_write_batch', {
      files: [{ path: 'notes.txt', content: 'new notes', expected_sha256: 'a'.repeat(64) }]
    });
    assert.equal(rShaMismatch.isError, true);
    assert.equal(rShaMismatch.structuredContent?.error?.code, 'stale_revision');
    assert.equal(await fs.readFile(path.join(work, 'notes.txt'), 'utf8'), beforeContent);
  }

  // 5. background tasks workspace scoping and close() lifecycle
  {
    const tList = await call('tasks_list', {});
    assert.equal(tList.isError, false);
    assert.ok(Array.isArray(tList.structuredContent?.tasks));

    const tStat = await call('tasks_status', { taskId: 'nonexistent-task-id' });
    assert.equal(tStat.isError, true);
    assert.equal(tStat.structuredContent?.error?.code, 'task_not_found');

    tools.close();
  }

  ok('extended tools: symbols_search/references, files_write_batch/apply_patch, knowledge_create/list/search, tasks_list');
}
if (isWindows) {
  // Short (8.3) names must not be a way around the protected-name rule.
  let short = '';
  try { short = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${path.join(work, 'config', 'credentials.json')}") do @echo %~sI`], { encoding: 'utf8' }).trim(); } catch { /* ignore */ }
  if (short.includes('~')) {
    const rel = path.relative(work, short).replaceAll('\\', '/');
    const r = await call('read_file', { path: rel });
    assert.equal(r.isError, true, `${rel} must be refused`);
    assert.ok(!textOf(r).includes('hunter2'));
    ok('Windows: an 8.3 short name cannot be used to read a protected file');
  } else console.warn('  SKIPPED 8.3 short-name check: short names are not enabled on this volume');
}

await delay(100);
await cleanup();
console.log(`PASS: ${checks} local-tools checks (files, search, git, shell, permissions, secrets)`);
