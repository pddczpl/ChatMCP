// Behavioural tests for lib/workspaces.mjs, the part of the public server that owns the agent's files.
//
// The address checks run on a table of hostile inputs. Everything else runs against a REAL Git server on this machine (Node's http
// module in front of `git http-backend`, tests/fixtures/git-http-server.mjs): clone with and without a credential, the limits, the
// registry, the folder guard, export as .tar.gz, removal, and the push - including a workspace whose .git has been tampered with the
// way a hostile command could (a redirected remote, an insteadOf rule, a proxy, a program-launching setting, a hook).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createExecution } from '../lib/exec-mode.mjs';
import { createWorkspaceService, parseRepositoryUrl, pushBranchName, workspaceNameFor } from '../lib/workspaces.mjs';
import { createBareRepo, findHttpBackend, git, isolatedGitEnv, startGitHttpServer } from './fixtures/git-http-server.mjs';

const run = promisify(execFile);
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const rejects = (promise, code, label) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code, `${label}: got ${error.code} (${error.message})`);
  return true;
}, label);
setTimeout(() => { console.error('FAIL: the workspaces suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

// ------------------------------------------------------------------ the address of a repository
{
  const hosts = ['github.com', 'git.example.org'];
  const accepted = [
    ['https://github.com/octo/hello', 'github.com', 'octo', 'hello'],
    ['https://github.com/octo/hello.git', 'github.com', 'octo', 'hello'],
    ['  https://GitHub.com/Octo/Hello/  ', 'github.com', 'Octo', 'Hello'],
    ['octo/hello', 'github.com', 'octo', 'hello'],
    ['https://git.example.org/team/app-1.x', 'git.example.org', 'team', 'app-1.x'],
    ['https://github.com/o_c-t.o/h.e_l-l.o.git', 'github.com', 'o_c-t.o', 'h.e_l-l.o'],
  ];
  for (const [input, host, owner, repo] of accepted) {
    const parsed = parseRepositoryUrl(input, { hosts });
    assert.deepEqual([parsed.host, parsed.owner, parsed.repo], [host, owner, repo], input);
    assert.equal(parsed.url, `https://${host}/${owner}/${repo}.git`, input);
  }
  ok('repository addresses: https and owner/repo forms are accepted and normalised to https://host/owner/repo.git');

  const hostile = [
    'git@github.com:octo/hello.git', 'ssh://git@github.com/octo/hello', 'git://github.com/octo/hello', 'file:///etc/passwd', '/etc/passwd',
    'C:\\Users\\x\\repo', '\\\\server\\share\\repo', '../../etc', 'ext::sh -c touch /tmp/pwned', 'ext::sh -c id%20>/tmp/x', '--upload-pack=touch /tmp/x',
    '-oProxyCommand=id', 'ftp://github.com/octo/hello', 'javascript:alert(1)', 'data:text/plain,x',
    'https://evil.example/octo/hello', 'https://github.com.evil.example/octo/hello', 'https://github.com@evil.example/octo/hello',
    'https://evil.example/github.com/hello', 'https://user:password@github.com/octo/hello', 'https://token@github.com/octo/hello',
    'https://github.com:8443/octo/hello', 'https://github.com:443/octo/hello', 'https://[::1]/octo/hello', 'https://127.0.0.1/octo/hello',
    'https://github.com/octo', 'https://github.com/octo/hello/extra', 'https://github.com//hello', 'https://github.com/octo/',
    'https://github.com/octo/hello?x=1', 'https://github.com/octo/hello#frag', 'https://github.com/octo/hello%2e', 'https://github.com/%2e%2e/hello',
    'https://github.com/octo/../hello', 'https://github.com/./hello', 'https://github.com/octo/hel lo', 'https://github.com/octo/hello\n--evil',
    'https://github.com/octo/hello\r\nHost: evil', 'https://github.com/octo/hello\u0000', 'https://github.com/-octo/hello', 'https://github.com/octo/-hello',
    'https://github.com/octo/.git', 'https://github.com/octo/..git', 'https://github.com/oc\\to/hello', 'http://github.com/octo/hello', 'HTTP://github.com/octo/hello',
    'octo/hello:evil', 'octo:hello', '', ' ', 'x'.repeat(400), 'https://github.com/' + 'a'.repeat(120) + '/hello', 'https://github.com/octo/' + 'a'.repeat(120),
    'https://github.com/octo/hello@{u}', 'https://github.com/octo/hello::x',
  ];
  for (const input of hostile) {
    assert.throws(() => parseRepositoryUrl(input, { hosts }), (error) => {
      assert.ok(['bad_url', 'host_not_allowed'].includes(error.code), `${JSON.stringify(input).slice(0, 60)} -> ${error.code}`);
      assert.ok([400, 403].includes(error.statusCode));
      return true;
    }, `must refuse ${JSON.stringify(input).slice(0, 80)}`);
  }
  for (const input of [null, undefined, 42, {}, [], ['https://github.com/octo/hello']]) assert.throws(() => parseRepositoryUrl(input, { hosts }), (error) => error.code === 'bad_url');
  assert.throws(() => parseRepositoryUrl('http://github.com/o/r', { hosts }), (error) => error.code === 'bad_url', 'plain http is refused by default');
  assert.equal(parseRepositoryUrl('http://github.com/o/r', { hosts, allowHttp: true }).url, 'http://github.com/o/r.git', 'only the test switch allows http');
  ok(`repository addresses: ${hostile.length} hostile inputs (ssh, file, ext::, credentials, ports, escapes, traversal, options, other hosts, control characters) are refused`);

  assert.equal(workspaceNameFor('Octo', 'Hello.World'), 'octo-hello.world');
  assert.equal(workspaceNameFor('a'.repeat(60), 'b'.repeat(60)).length <= 56, true);
  assert.match(workspaceNameFor('...', '---'), /^[a-z0-9][a-z0-9._-]{0,59}$/);
  ok('workspace names derived from owner and repository are always valid folder names');

  const stamp = pushBranchName('', new Date('2026-10-11T03:04:05Z'));
  assert.match(stamp, /^chatmcp\/20261011-030405Z-[0-9a-f]{4}$/);
  assert.equal(pushBranchName('fix/login'), 'chatmcp/fix/login');
  assert.equal(pushBranchName('chatmcp/fix'), 'chatmcp/fix');
  for (const bad of ['..', 'a..b', '-x', 'x.lock', 'a//b', 'a/', 'a.', 'x@{1}', 'has space', 'a/.b', 'x\ny', 'x~1', 'x^', 'x:y', 'x?', 'x*', 'x[', 'a\\b', '']) {
    if (bad === '') continue; // empty means "pick a name"
    assert.throws(() => pushBranchName(bad), (error) => error.code === 'bad_branch', `must refuse branch ${JSON.stringify(bad)}`);
  }
  ok('branch names for a push always start with chatmcp/ and refuse everything Git would treat specially');
}

// ------------------------------------------------------------------ against a real Git server
if (!(await findHttpBackend())) {
  console.log(`CHATMCP_TEST_SKIP: git-http-backend is not available, so clone and push cannot be exercised (the ${checks} address checks passed)`);
  process.exit(0);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-ws-'));
const cleanup = async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); };
process.once('exit', () => { try { import('node:fs').then((module) => module.rmSync(tmp, { recursive: true, force: true })); } catch { /* best effort */ } });
const token = 'ghp_TestTokenAbCdEf0123456789xyz';
const basicOf = (value) => `basic ${Buffer.from(`x-access-token:${value}`).toString('base64')}`;
const remotes = path.join(tmp, 'remotes');
const text = (label) => `${label}\n`.repeat(40);

try {
  const tips = await createBareRepo(remotes, 'octo/hello.git', {
    commits: [
      { files: { 'README.md': '# hello\n', 'src/app.py': 'print("one")\n', '.gitignore': 'node_modules/\n' }, message: 'first' },
      { files: { 'src/app.py': 'print("two")\n', 'src/util.py': 'X = 1\n' }, message: 'second' },
    ],
    branches: { dev: [{ files: { 'dev.txt': 'dev branch\n' }, message: 'dev work' }] },
  });
  await createBareRepo(remotes, 'octo/private.git', { commits: [{ files: { 'secret-plan.md': 'private\n' }, message: 'private first' }] });
  await createBareRepo(remotes, 'octo/big.git', { commits: [{ files: { 'blob.bin': Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 2654435761) % 251)).toString('latin1') }, message: 'big' }] });
  const server = await startGitHttpServer({ root: remotes, token, privateRepos: ['octo/private.git'] });
  const evilRequests = [];
  const evil = http.createServer((req, res) => { evilRequests.push(`${req.method} ${req.url} auth=${Boolean(req.headers.authorization)}`); res.writeHead(404); res.end(); });
  await new Promise((resolve) => evil.listen(0, '127.0.0.1', resolve));
  const evilBase = `http://127.0.0.1:${evil.address().port}`;

  const makeManager = (name) => {
    const manager = {
      hubDirectory: path.join(tmp, `state-${name}`), workspace: null, secrets: [token], lines: [], cleared: 0,
      log(line) { this.lines.push(String(line)); },
      async clearWorkspace() { this.workspace = null; this.cleared += 1; },
    };
    return manager;
  };
  const execution = await createExecution({ exec: { mode: 'same-user', commandMaxSeconds: 60 } }, { env: process.env, log: () => {} });
  const baseConfig = (name, overrides = {}) => ({
    workspaces: { root: path.join(tmp, `ws-${name}`), max: 3, maxCloneBytes: 50 * 1024 * 1024, gitHosts: [server.hostPort], githubToken: token, ...overrides },
  });
  const open = async (name, { overrides = {}, manager = makeManager(name), env = process.env, tokenHosts = [server.hostPort] } = {}) => {
    await fs.mkdir(manager.hubDirectory, { recursive: true });
    const service = await createWorkspaceService({ config: baseConfig(name, overrides), manager, execution, env, log: (line) => manager.log(line), testing: { allowHttp: true, tokenHosts } });
    return { service, manager };
  };
  const repoUrl = (name) => `${server.origin}/${name}`;
  const gitIn = (directory, args, env) => git(['-C', directory, ...args], { env });
  const scanForSecrets = async (...roots) => {
    const needles = [token, Buffer.from(`x-access-token:${token}`).toString('base64')];
    const hits = [];
    const walk = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.isFile()) continue;
        const stat = await fs.stat(full);
        if (stat.size > 8 * 1024 * 1024) continue;
        const body = await fs.readFile(full, 'latin1');
        if (needles.some((needle) => body.includes(needle))) hits.push(full);
      }
    };
    for (const root of roots) await walk(root);
    return hits;
  };

  // -------------------------------------------------------------- start-up and the registry
  {
    const foreign = path.join(tmp, 'foreign');
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(path.join(foreign, 'precious.txt'), 'do not touch\n');
    const manager = makeManager('foreign');
    await fs.mkdir(manager.hubDirectory, { recursive: true });
    await assert.rejects(createWorkspaceService({ config: baseConfig('x', { root: foreign }), manager, execution, env: process.env, log: () => {}, testing: { allowHttp: true } }), /không rỗng|not empty/i);
    assert.equal(await fs.readFile(path.join(foreign, 'precious.txt'), 'utf8'), 'do not touch\n');
    ok('a workspaces root that is not empty and was not created by ChatMCP is refused and nothing in it is touched');

    const marked = path.join(tmp, 'marked');
    const first = await open('marked', { overrides: { root: marked } });
    assert.ok((await fs.readdir(marked)).includes('.chatmcp-workspaces'));
    await fs.mkdir(path.join(marked, 'leftover-of-a-crashed-clone', 'objects'), { recursive: true });
    const again = await open('marked2', { overrides: { root: marked } });
    assert.deepEqual((await fs.readdir(marked)).sort(), ['.chatmcp-workspaces', '.exchange']);
    assert.equal(again.service.summary().count, 0);
    void first;
    ok('a root created by the service is marked; folders that are not in the registry (an interrupted clone) are removed at start');
  }

  const main = await open('main');
  const svc = main.service;
  const manager = main.manager;

  // -------------------------------------------------------------- clone
  const cloneBefore = server.requests.length;
  for (const hostileUrl of ['file:///etc/passwd', 'ssh://git@github.com/o/r', 'ext::sh -c touch /tmp/pwned', 'https://evil.example/octo/hello', `${evilBase}/octo/hello`, 'https://user:pw@127.0.0.1/o/r', '--upload-pack=x', `${server.origin}/octo/hello?x=1`]) {
    await assert.rejects(svc.clone({ url: hostileUrl }), (error) => ['bad_url', 'host_not_allowed'].includes(error.code), hostileUrl);
  }
  await rejects(svc.clone({ url: repoUrl('octo/hello'), branch: '--evil' }), 'bad_branch', 'option-looking branch');
  await rejects(svc.clone({ url: repoUrl('octo/hello'), branch: 'a..b' }), 'bad_branch', 'range-looking branch');
  await rejects(svc.clone({ url: repoUrl('octo/hello'), depth: 0 }), 'bad_depth', 'depth 0');
  await rejects(svc.clone({ url: repoUrl('octo/hello'), depth: 100000 }), 'bad_depth', 'depth too large');
  await rejects(svc.clone({ url: repoUrl('octo/hello'), depth: 'abc' }), 'bad_depth', 'depth text');
  assert.equal(server.requests.length, cloneBefore, 'a refused address never reaches the network');
  assert.equal(evilRequests.length, 0);
  assert.deepEqual((await fs.readdir(baseConfig('main').workspaces.root)).sort(), ['.chatmcp-workspaces', '.exchange']);
  ok('hostile addresses, branches and depths are refused before any Git process or network request, and no folder is left behind');

  const hello = await svc.clone({ url: repoUrl('octo/hello') });
  assert.equal(hello.name, 'octo-hello');
  assert.equal(hello.baseSha, tips.main);
  assert.equal(hello.branch, 'main');
  assert.equal(path.dirname(hello.path), await fs.realpath(baseConfig('main').workspaces.root));
  assert.equal((await gitIn(hello.path, ['rev-parse', 'HEAD'])).trim(), tips.main);
  assert.equal((await gitIn(hello.path, ['config', '--local', 'user.name'])).trim(), 'ChatMCP Agent');
  assert.equal((await gitIn(hello.path, ['config', '--local', 'user.email'])).trim(), 'agent@chatmcp.invalid');
  assert.equal(await fs.readFile(path.join(hello.path, 'src', 'app.py'), 'utf8'), 'print("two")\n');
  await assert.rejects(fs.access(path.join(hello.path, '.git', 'hooks')), undefined, 'no hook samples are copied into a cloned repository');
  const gitConfig = await fs.readFile(path.join(hello.path, '.git', 'config'), 'utf8');
  assert.match(gitConfig, new RegExp(`url = ${server.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/octo/hello\\.git`));
  assert.ok(!gitConfig.includes(token) && !/extraheader|authorization|x-access-token/i.test(gitConfig), 'the credential must never be written to .git/config');
  assert.ok(server.requests.slice(cloneBefore).length >= 2 && server.requests.slice(cloneBefore).every((request) => request.authorization === basicOf(token)), 'the credential travels as one header on every request to the trusted host');
  ok('clone: files, base commit, committer identity and an origin URL without credentials; hook samples are not copied; the token is sent only as a request header');

  const dev = await svc.clone({ url: repoUrl('octo/hello'), branch: 'dev' });
  assert.equal(dev.name, 'octo-hello-2');
  assert.equal(dev.branch, 'dev');
  assert.equal(dev.baseSha, tips.dev);
  assert.equal(await fs.readFile(path.join(dev.path, 'dev.txt'), 'utf8'), 'dev branch\n');
  const shallow = await svc.clone({ url: repoUrl('octo/private'), depth: 1 });
  assert.equal(shallow.name, 'octo-private');
  assert.equal((await gitIn(shallow.path, ['rev-list', '--count', 'HEAD'])).trim(), '1');
  await rejects(svc.clone({ url: repoUrl('octo/hello') }), 'workspace_limit', 'fourth workspace');
  assert.equal(svc.summary().count, 3);
  ok('clone: a second clone of the same repository gets its own folder, --branch and depth are honoured, a private repository works with the token, the limit of workspaces holds');

  {
    const concurrent = await open('concurrent');
    const slow = concurrent.service.clone({ url: repoUrl('octo/hello') });
    await rejects(concurrent.service.clone({ url: repoUrl('octo/hello') }), 'workspace_busy', 'second clone while one runs');
    await rejects(concurrent.service.create({ name: 'other' }), 'workspace_busy', 'create while a clone runs');
    await slow;
    ok('one operation at a time: a second clone or create while one runs is refused with workspace_busy');
  }

  {
    const limited = await open('limited', { overrides: { maxCloneBytes: 100 * 1024 } });
    await rejects(limited.service.clone({ url: repoUrl('octo/big') }), 'clone_too_big', 'oversized repository');
    assert.deepEqual((await fs.readdir(baseConfig('limited').workspaces.root)).sort(), ['.chatmcp-workspaces', '.exchange']);
    assert.equal(limited.service.summary().count, 0);
    const missing = await open('missing');
    await rejects(missing.service.clone({ url: repoUrl('octo/does-not-exist') }), 'repo_not_found', 'unknown repository');
    const wrong = await open('wrong', { overrides: { githubToken: 'ghp_WrongTokenAbCdEf0123456789xyz' } });
    const failure = await wrong.service.clone({ url: repoUrl('octo/private') }).catch((error) => error);
    assert.equal(failure.code, 'git_auth', failure.message);
    assert.ok(!failure.message.includes('WrongToken') && !failure.message.includes(token), 'an error message never contains a token');
    const anonymous = await open('anon', { overrides: { githubToken: null } });
    assert.equal((await anonymous.service.clone({ url: repoUrl('octo/hello') })).name, 'octo-hello');
    await rejects(anonymous.service.clone({ url: repoUrl('octo/private') }), 'git_auth', 'private repository without a token');
    ok('clone: too big a repository, an unknown repository, a wrong token and a missing token each fail with their own message, leave no folder and leak no token');
  }

  // -------------------------------------------------------------- create / guard
  {
    const scratch = await open('scratch', { overrides: { githubToken: null } });
    const created = await scratch.service.create({ name: 'notes' });
    assert.equal(created.kind, 'empty');
    assert.equal((await gitIn(created.path, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'main');
    assert.equal((await gitIn(created.path, ['config', '--local', 'user.name'])).trim(), 'ChatMCP Agent');
    for (const bad of ['../x', 'A B', 'a/b', '.hidden', '', 'x'.repeat(61), 'tên-việt']) await rejects(scratch.service.create({ name: bad }), 'bad_name', `name ${JSON.stringify(bad)}`);
    const second = await scratch.service.create({ name: 'notes' });
    assert.equal(second.name, 'notes-2');
    await rejects(scratch.service.push({ name: 'notes' }), 'no_github_token', 'push without a token is explained');
    const withToken = await open('withtoken');
    const empty = await withToken.service.create({ name: 'empty' });
    await rejects(withToken.service.push({ name: empty.name }), 'push_unsupported', 'an empty workspace has no repository to push to');
    ok('create: an empty repository on main with the committer identity, names are validated, duplicates get a suffix, push explains why it cannot run');

    const root = await fs.realpath(baseConfig('main').workspaces.root);
    await svc.guard(hello.path);
    await svc.guard(path.join(root, 'octo-hello-2'));
    for (const outside of [root, path.dirname(root), os.tmpdir(), path.join(hello.path, 'src'), path.join(root, '.exchange'), tmp, remotes]) {
      await rejects(svc.guard(outside), 'workspace_not_allowed', `guard ${outside}`);
    }
    await fs.mkdir(path.join(root, 'unregistered'));
    await rejects(svc.guard(path.join(root, 'unregistered')), 'workspace_not_allowed', 'a folder the registry does not know');
    const link = path.join(root, 'link-to-tmp');
    try { await fs.symlink(os.tmpdir(), link, 'dir'); await rejects(svc.guard(await fs.realpath(link)), 'workspace_not_allowed', 'a link resolved to the outside'); }
    catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
    await fs.rm(link, { force: true }); await fs.rm(path.join(root, 'unregistered'), { recursive: true, force: true });
    ok('guard: only a folder that the registry lists, directly below the root, can be selected as the workspace');
  }

  // -------------------------------------------------------------- push, with a workspace that the agent has tampered with
  {
    const pushed = await open('pusher');
    const work = await pushed.service.clone({ url: repoUrl('octo/hello') });
    await fs.writeFile(path.join(work.path, 'src', 'feature.py'), 'def feature():\n    return 42\n');
    await gitIn(work.path, ['add', '-A']);
    await gitIn(work.path, ['commit', '-q', '-m', 'add feature']);
    const head = (await gitIn(work.path, ['rev-parse', 'HEAD'])).trim();

    // What a hostile command could write into .git: a redirected remote, an insteadOf rule, a proxy, an extra header and a hook.
    const marker = path.join(tmp, 'HOOK-RAN');
    await fs.mkdir(path.join(work.path, '.git', 'hooks'), { recursive: true });
    for (const hook of ['pre-push', 'pre-commit', 'post-commit', 'reference-transaction', 'pre-receive', 'update']) {
      await fs.writeFile(path.join(work.path, '.git', 'hooks', hook), `#!/bin/sh\necho ran > "${marker.replaceAll('\\', '/')}"\n`, { mode: 0o755 });
    }
    const config = path.join(work.path, '.git', 'config');
    const original = await fs.readFile(config, 'utf8');
    await fs.appendFile(config, [
      '[remote "origin"]', `\turl = ${evilBase}/evil.git`, `\tpushurl = ${evilBase}/evil.git`,
      `[url "${evilBase}/"]`, `\tinsteadOf = ${server.origin}/`,
      '[http]', `\tproxy = ${evilBase}`, '\textraheader = X-Leak: yes',
      '[push]', '\tdefault = matching', '',
    ].join('\n'));
    const result = await pushed.service.push({ name: work.name, branch: 'feature/login' });
    assert.equal(result.branch, 'chatmcp/feature/login');
    assert.equal(result.commits, 1);
    assert.equal(result.commit, head);
    assert.equal(result.base, tips.main);
    assert.equal(result.compareUrl, null, 'only github.com gets a compare link');
    assert.equal((await git(['-C', path.join(remotes, 'octo', 'hello.git'), 'rev-parse', 'refs/heads/chatmcp/feature/login'])).trim(), head);
    assert.equal(evilRequests.length, 0, `the redirected remote, insteadOf rule and proxy written into .git/config must never be used (saw: ${evilRequests.join('; ')})`);
    await assert.rejects(fs.access(marker), undefined, 'no hook of the workspace may run');
    const writes = server.requests.filter((request) => request.path.endsWith('git-receive-pack') || request.query.includes('service=git-receive-pack'));
    assert.ok(writes.length >= 2 && writes.every((request) => request.authorized), 'pushing needs the token and the server accepted it');
    ok('push: the new commits reach a new branch of the REGISTERED origin; a tampered remote, insteadOf, proxy, header or hook in .git is not used');

    await rejects(pushed.service.push({ name: work.name, branch: 'feature/login' }), 'branch_exists', 'same branch again');
    await rejects(pushed.service.push({ name: work.name, force: true }), 'force_refused', 'force');
    await rejects(pushed.service.push({ name: work.name, force: 'true' }), 'force_refused', 'force as text');
    await rejects(pushed.service.push({ name: work.name, branch: '../main' }), 'bad_branch', 'traversal branch');
    await rejects(pushed.service.push({ name: 'does-not-exist' }), 'workspace_unknown', 'unknown workspace');
    await rejects(pushed.service.push({ name: '../octo-hello' }), 'workspace_unknown', 'traversal name');
    assert.equal(evilRequests.length, 0);
    ok('push: an existing branch, force, a bad branch name and an unknown workspace are all refused');

    // Settings that name a program. fsmonitor is switched off on the command line, so the push goes through and the program never runs;
    // a clean filter or a diff driver cannot be switched off, so the Hub refuses to run Git there at all.
    const launcher = path.join(tmp, 'fsmonitor.sh');
    const programMarker = path.join(tmp, 'PROGRAM-RAN');
    const quiet = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${path.join(tmp, 'no-hooks-for-the-test').replaceAll('\\', '/')}`]; // the test's own commits must not trigger the planted hooks
    await fs.writeFile(launcher, `#!/bin/sh\necho ran > "${programMarker.replaceAll('\\', '/')}"\n`, { mode: 0o755 });
    await fs.appendFile(config, `[core]\n\tfsmonitor = ${launcher.replaceAll('\\', '/')}\n`);
    await fs.writeFile(path.join(work.path, 'again.txt'), 'x\n');
    await gitIn(work.path, [...quiet, 'add', '-A']);
    await gitIn(work.path, [...quiet, 'commit', '-q', '-m', 'second']);
    const second = await pushed.service.push({ name: work.name, branch: 'feature/second' });
    assert.equal(second.commits, 2);
    await assert.rejects(fs.access(programMarker), undefined, 'the fsmonitor program must not have run');
    await assert.rejects(fs.access(marker), undefined, 'no hook may have run');
    await fs.appendFile(config, `[filter "evil"]\n\tclean = ${launcher.replaceAll('\\', '/')}\n[diff "evil"]\n\ttextconv = ${launcher.replaceAll('\\', '/')}\n`);
    await rejects(pushed.service.push({ name: work.name, branch: 'feature/third' }), 'git_config_untrusted', 'clean filter and textconv in .git/config');
    await assert.rejects(fs.access(programMarker), undefined, 'no program named in .git/config may have run');
    await assert.rejects(fs.access(marker), undefined, 'no hook may have run');
    await fs.writeFile(config, original);
    const third = await pushed.service.push({ name: work.name, branch: 'feature/third' });
    assert.equal(third.commits, 2);
    ok('push: fsmonitor in .git/config is neutralised (pushes, never runs); a clean filter or diff driver makes the Hub refuse (git_config_untrusted) and nothing runs; once removed the push succeeds');

    // nothing new / rewritten history
    const clean = await pushed.service.clone({ url: repoUrl('octo/hello') });
    await rejects(pushed.service.push({ name: clean.name }), 'nothing_to_push', 'no new commit');
    await gitIn(clean.path, ['reset', '-q', '--hard', 'HEAD']);
    await fs.writeFile(path.join(clean.path, 'other.txt'), 'y\n');
    await gitIn(clean.path, ['add', '-A']);
    await gitIn(clean.path, ['commit', '-q', '--amend', '-m', 'rewritten second']);
    await rejects(pushed.service.push({ name: clean.name }), 'history_rewritten', 'amended base commit');
    ok('push: nothing to push and rewritten history (the base commit is no longer an ancestor) are refused');

    // a token that GitHub would refuse
    const refused = await open('refused', { overrides: { githubToken: 'ghp_RefusedTokenAbCdEf0123456789x' } });
    const other = await refused.service.clone({ url: repoUrl('octo/hello') });
    await fs.writeFile(path.join(other.path, 'z.txt'), 'z\n');
    await gitIn(other.path, ['add', '-A']);
    await gitIn(other.path, ['commit', '-q', '-m', 'z']);
    const denied = await refused.service.push({ name: other.name }).catch((error) => error);
    assert.equal(denied.code, 'git_auth', denied.message);
    assert.ok(!denied.message.includes('RefusedToken'), 'the rejected token is not repeated in the message');
    ok('push: a token the server rejects is reported as git_auth without repeating it');
  }

  // -------------------------------------------------------------- export
  {
    await fs.writeFile(path.join(hello.path, '.env'), 'API_KEY=hunter2hunter2\n');
    await fs.writeFile(path.join(hello.path, 'deploy.pem'), '-----BEGIN PRIVATE KEY-----\n');
    await fs.mkdir(path.join(hello.path, 'node_modules', 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(hello.path, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n');
    await fs.mkdir(path.join(hello.path, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(hello.path, 'src', 'deep', 'kept.txt'), 'kept\n');
    const exporter = http.createServer((req, res) => {
      const name = new URL(req.url, 'http://x').searchParams.get('name') ?? '';
      void svc.exportArchive(res, name, { onError: (status, message, code) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: message, code })); } });
    });
    await new Promise((resolve) => exporter.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${exporter.address().port}`;
    const response = await fetch(`${base}/?name=${hello.name}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/gzip');
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="octo-hello\.tar\.gz"/);
    const archive = path.join(tmp, 'export.tar.gz');
    await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const listing = (await run('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 })).stdout.split(/\r?\n/).map((line) => line.replace(/^\.\//, '')).filter(Boolean);
    for (const wanted of ['README.md', 'src/app.py', 'src/util.py', 'src/deep/kept.txt', '.gitignore']) assert.ok(listing.includes(wanted), `${wanted} must be in the archive: ${listing.join(',')}`);
    for (const forbidden of listing) assert.ok(!/(^|\/)(\.git|node_modules)(\/|$)|(^|\/)\.env|\.pem$/.test(forbidden), `${forbidden} must not be exported`);
    const missing = await fetch(`${base}/?name=nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'workspace_unknown');
    assert.equal((await fetch(`${base}/?name=${encodeURIComponent('../ws-main/octo-hello')}`)).status, 404);
    await new Promise((resolve) => exporter.close(resolve));
    ok('export: a .tar.gz of the working tree without .git, node_modules, .env and key files; an unknown or traversing name is a 404');
  }

  // -------------------------------------------------------------- remove, persistence
  {
    const root = await fs.realpath(baseConfig('main').workspaces.root);
    manager.workspace = dev.path;
    const removed = await svc.remove({ name: dev.name }, { current: dev.path });
    assert.equal(removed.wasCurrent, true);
    assert.equal(manager.cleared, 1, 'removing the selected workspace unselects it first');
    await assert.rejects(fs.access(dev.path));
    await rejects(svc.remove({ name: dev.name }), 'workspace_unknown', 'removing twice');
    await rejects(svc.remove({ name: '../ws-main' }), 'workspace_unknown', 'traversal');
    await rejects(svc.remove({ name: '.exchange' }), 'workspace_unknown', 'the exchange folder');
    await rejects(svc.remove({}), 'workspace_unknown', 'no name');
    const kept = await svc.remove({ name: shallow.name }, { current: hello.path });
    assert.equal(kept.wasCurrent, false);
    assert.equal(manager.cleared, 1, 'removing another workspace leaves the selection alone');
    const registry = JSON.parse(await fs.readFile(path.join(manager.hubDirectory, 'workspaces.json'), 'utf8'));
    assert.deepEqual(registry.items.map((item) => item.name), [hello.name]);
    ok('remove: the selected workspace is unselected first, other workspaces keep the selection, the registry follows, unknown and traversing names are refused');

    // a new service on the same root sees the same workspaces; a folder that disappeared is dropped
    await fs.mkdir(path.join(root, 'octo-ghost'), { recursive: true });
    const reopened = await createWorkspaceService({ config: baseConfig('main'), manager, execution, env: process.env, log: () => {}, testing: { allowHttp: true, tokenHosts: [server.hostPort] } });
    const listed = await reopened.list();
    assert.deepEqual(listed.items.map((item) => item.name), [hello.name]);
    assert.equal(listed.items[0].exists, true);
    assert.equal(listed.pushEnabled, true);
    assert.deepEqual((await fs.readdir(root)).sort(), ['.chatmcp-workspaces', '.exchange', hello.name]);
    const reg2 = JSON.parse(await fs.readFile(path.join(manager.hubDirectory, 'workspaces.json'), 'utf8'));
    reg2.items.push({ name: 'vanished', kind: 'clone', origin: { host: server.hostPort, owner: 'o', repo: 'r' }, baseSha: tips.main });
    await fs.writeFile(path.join(manager.hubDirectory, 'workspaces.json'), JSON.stringify(reg2));
    const third = await createWorkspaceService({ config: baseConfig('main'), manager, execution, env: process.env, log: () => {}, testing: { allowHttp: true, tokenHosts: [server.hostPort] } });
    assert.deepEqual((await third.list()).items.map((item) => item.name), [hello.name]);
    ok('registry: workspaces survive a restart of the service; entries without a folder and folders without an entry are dropped');
  }

  // -------------------------------------------------------------- nothing secret anywhere
  {
    const hits = await scanForSecrets(manager.hubDirectory, baseConfig('main').workspaces.root, baseConfig('pusher').workspaces.root, baseConfig('scratch').workspaces.root);
    assert.deepEqual(hits, [], `the token must not be written anywhere on disk: ${hits.join(', ')}`);
    assert.ok(!manager.lines.some((line) => line.includes(token)), 'the token must not be logged');
    ok('the GitHub token is not on disk (state, registry, any .git/config) and not in the log after clone, push and failures');
  }

  await new Promise((resolve) => evil.close(resolve));
  await server.close();
} finally {
  await cleanup();
}

console.log(`PASS (${checks} checks)`);
