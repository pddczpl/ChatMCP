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
import { resolveProgram } from '../lib/runtime.mjs';
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
    [`https://github.com/${'o'.repeat(100)}/${'r'.repeat(100)}`, 'github.com', 'o'.repeat(100), 'r'.repeat(100)], // the longest names GitHub allows
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
    'https://github.com/octo/.git', 'https://github.com/octo/..git', 'https://github.com/octo/.', 'https://github.com/oc\\to/hello', 'http://github.com/octo/hello', 'HTTP://github.com/octo/hello',
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
  // A tag on the tip of main (a clone must not fetch it), and a repository that has no commit at all.
  await git(['-C', path.join(remotes, 'octo', 'hello.git'), 'tag', 'v1', tips.main]);
  await git(['init', '--bare', '--initial-branch=main', '--', path.join(remotes, 'octo', 'empty.git')]);
  const server = await startGitHttpServer({ root: remotes, token, privateRepos: ['octo/private.git'] });
  const evilRequests = [];
  const evil = http.createServer((req, res) => { evilRequests.push(`${req.method} ${req.url} auth=${Boolean(req.headers.authorization)}`); res.writeHead(404); res.end(); });
  await new Promise((resolve) => evil.listen(0, '127.0.0.1', resolve));
  const evilBase = `http://127.0.0.1:${evil.address().port}`;
  // A second Git server that is NOT a host the token belongs to (it stands for an extra host in CHATMCP_GIT_ALLOWED_HOSTS).
  const other = await startGitHttpServer({ root: remotes });
  // A server that misbehaves in two ways: it answers a repository with a redirect to the "evil" server above, and it answers another
  // with a Git protocol error line that repeats the credential it was given (a real server can echo anything back).
  const oddRequests = [];
  const odd = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://odd.invalid');
    oddRequests.push(`${req.method} ${url.pathname}${url.search} auth=${Boolean(req.headers.authorization)}`);
    if (url.pathname.startsWith('/octo/redirect.git/')) { res.writeHead(302, { Location: `${evilBase}${url.pathname}${url.search}` }); res.end(); return; }
    if (url.pathname.startsWith('/octo/echo.git/')) {
      const packet = (line) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Cache-Control': 'no-cache' });
      res.end(`${packet('# service=git-upload-pack\n')}0000${packet(`ERR the server repeats your credential ${token} by mistake\n`)}`);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => odd.listen(0, '127.0.0.1', resolve));
  const oddHost = `127.0.0.1:${odd.address().port}`;

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
  // Recording of the Git processes a service starts (POSIX only): a `git` wrapper that logs what the process received - the NAMES of all
  // its environment variables and the VALUES of the harmless ones - and then runs the real Git. The wrapper is first on PATH only while the
  // service looks Git up (the service remembers the path), so the servers and the test's own Git commands never go through it.
  const spyOnGit = async (label) => {
    const realGit = await resolveProgram('git');
    const directory = path.join(tmp, `git-spy-${label}`);
    const log = path.join(tmp, `git-calls-${label}.log`);
    await fs.mkdir(directory);
    const script = [
      '#!/bin/sh',
      '{ printf \'ARGS %s\\n\' "$*"',
      '  printf \'NAMES %s\\n\' "$(env | cut -d= -f1 | sort | tr \'\\n\' \' \')"',
      '  printf \'VALUES NOSYSTEM=%s PROMPT=%s FROMUSER=%s LFS=%s ASKPASS=%s SSHASKPASS=%s GCM=%s PAGER=%s EDITOR=%s LC=%s\\n\' "$GIT_CONFIG_NOSYSTEM" "$GIT_TERMINAL_PROMPT" "$GIT_PROTOCOL_FROM_USER" "$GIT_LFS_SKIP_SMUDGE" "$GIT_ASKPASS" "$SSH_ASKPASS" "$GCM_INTERACTIVE" "$GIT_PAGER" "$GIT_EDITOR" "$LC_ALL"',
      '  printf \'HOME %s\\n\' "$HOME"',
      '  printf \'GLOBAL %s\\n\' "$GIT_CONFIG_GLOBAL"',
      '  printf \'ALLOW %s\\n\' "$GIT_ALLOW_PROTOCOL"',
      `} >> '${log}'`,
      `exec '${realGit}' "$@"`, '',
    ].join('\n');
    await fs.writeFile(path.join(directory, 'git'), script, { mode: 0o755 });
    return {
      /** Runs `work(realPath)` while the wrapper is first on PATH. */
      async during(work) {
        const realPath = process.env.PATH;
        process.env.PATH = `${directory}${path.delimiter}${realPath}`;
        try { return await work(realPath); } finally { process.env.PATH = realPath; }
      },
      async calls() {
        const lines = (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
        const calls = [];
        for (let at = 0; at + 5 < lines.length; at += 6) {
          const field = (index, name) => lines[at + index].slice(name.length + 1);
          calls.push({
            args: field(0, 'ARGS'),
            names: new Set(field(1, 'NAMES').split(' ').filter(Boolean)),
            values: Object.fromEntries(field(2, 'VALUES').split(' ').map((pair) => pair.split(/=(.*)/s).slice(0, 2))),
            home: field(3, 'HOME'), global: field(4, 'GLOBAL'), allow: field(5, 'ALLOW'),
          });
        }
        return calls;
      },
    };
  };
  const wordsOf = (call) => ` ${call.args} `;
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
  await rejects(svc.clone({ url: repoUrl('octo/hello'), branch: 'main/' }), 'bad_branch', 'branch with a trailing slash');
  await rejects(svc.clone({ url: repoUrl('octo/hello'), branch: 'wip.lock' }), 'bad_branch', 'branch ending in .lock');
  await rejects(svc.clone({ url: repoUrl('octo/hello'), depth: 1001 }), 'bad_depth', 'depth just above the limit');
  await rejects(svc.clone({ url: repoUrl('octo/hello'), depth: 1.5 }), 'bad_depth', 'fractional depth');
  assert.equal(server.requests.length, cloneBefore, 'a refused address never reaches the network');
  assert.equal(evilRequests.length, 0);
  assert.deepEqual((await fs.readdir(baseConfig('main').workspaces.root)).sort(), ['.chatmcp-workspaces', '.exchange']);
  ok('hostile addresses, branches and depths are refused before any Git process or network request, and no folder is left behind');

  const hello = await svc.clone({ url: repoUrl('octo/hello') });
  assert.equal(hello.name, 'octo-hello');
  assert.equal(hello.baseSha, tips.main);
  assert.equal(hello.branch, 'main');
  assert.equal((await gitIn(hello.path, ['rev-list', '--count', 'HEAD'])).trim(), '2', 'the default depth keeps a useful history');
  assert.equal(path.dirname(hello.path), await fs.realpath(baseConfig('main').workspaces.root));
  assert.equal((await gitIn(hello.path, ['rev-parse', 'HEAD'])).trim(), tips.main);
  assert.equal((await gitIn(hello.path, ['config', '--local', 'user.name'])).trim(), 'ChatMCP Agent');
  assert.equal((await gitIn(hello.path, ['config', '--local', 'user.email'])).trim(), 'agent@chatmcp.invalid');
  assert.equal(await fs.readFile(path.join(hello.path, 'src', 'app.py'), 'utf8'), 'print("two")\n');
  assert.equal((await gitIn(hello.path, ['tag', '--list'])).trim(), '', 'tags of the remote are not fetched');
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

  // -------------------------------------------------------------- clone: more edge cases
  {
    // Cloning a tag leaves a detached HEAD: the registry records "no branch".
    const tagged = await open('tagged');
    const atTag = await tagged.service.clone({ url: repoUrl('octo/hello'), branch: 'v1' });
    assert.equal(atTag.branch, null);
    assert.equal(atTag.baseSha, tips.main);
    assert.equal((await tagged.service.clone({ url: repoUrl('octo/hello'), branch: '' })).branch, 'main', 'an empty branch field means the default branch');

    // A repository without any commit cannot be a workspace: it is refused and leaves nothing behind.
    const hollow = await open('hollow');
    await rejects(hollow.service.clone({ url: repoUrl('octo/empty') }), 'git_failed', 'a repository with no commit');
    assert.deepEqual((await fs.readdir(baseConfig('hollow').workspaces.root)).sort(), ['.chatmcp-workspaces', '.exchange']);
    assert.equal(hollow.service.summary().count, 0);

    // The disk is checked as well: a clone limit that no disk can hold is refused up front, for both ways to make a workspace.
    if (await fs.statfs(tmp).catch(() => null)) {
      const huge = await open('huge', { overrides: { maxCloneBytes: 2 ** 60 } });
      await rejects(huge.service.clone({ url: repoUrl('octo/hello') }), 'disk_full', 'a clone limit larger than any disk');
      await rejects(huge.service.create({ name: 'x' }), 'disk_full', 'create with a clone limit larger than any disk');
      assert.equal(huge.service.summary().count, 0);
    }

    // A Git host that is not a token host never receives the credential, and a workspace cloned from it cannot be pushed.
    const scoped = await open('scoped', { overrides: { gitHosts: [server.hostPort, other.hostPort] }, tokenHosts: [server.hostPort] });
    const sentBefore = other.requests.length;
    const foreign = await scoped.service.clone({ url: `${other.origin}/octo/hello` });
    const sent = other.requests.slice(sentBefore);
    assert.ok(sent.length >= 2 && sent.every((request) => request.authorization === null), `the token must not be sent to a host that is not a token host (saw ${sent.map((request) => request.authorization).join(',')})`);
    await gitIn(foreign.path, ['commit', '-q', '--allow-empty', '-m', 'local work']);
    await rejects(scoped.service.push({ name: foreign.name }), 'push_unsupported', 'a clone from a host that is not a token host');
    const serverBefore = server.requests.length;
    await scoped.service.clone({ url: repoUrl('octo/hello') });
    const received = server.requests.slice(serverBefore);
    assert.ok(received.length >= 2 && received.every((request) => request.authorization === basicOf(token)), 'while the token host still receives it');

    // A redirect is not followed: the repository would otherwise be fetched from an address nobody approved.
    const odds = await open('odd', { overrides: { gitHosts: [oddHost] }, tokenHosts: [oddHost] });
    evilRequests.length = 0;
    const redirected = await odds.service.clone({ url: `http://${oddHost}/octo/redirect` }).catch((error) => error);
    assert.ok(redirected instanceof Error && redirected.code, 'a redirected clone fails');
    assert.ok(oddRequests.some((line) => line.includes('/octo/redirect.git/')), 'the redirecting server was asked');
    assert.equal(evilRequests.length, 0, `a redirect must not be followed (the other server saw: ${evilRequests.join('; ')})`);

    // What a server says is shown to the owner, but a credential inside it is not.
    const echoed = await odds.service.clone({ url: `http://${oddHost}/octo/echo` }).catch((error) => error);
    assert.equal(echoed.code, 'git_failed', echoed.message);
    assert.match(echoed.message, /repeats your credential/, 'the error shows what the server said');
    assert.ok(!echoed.message.includes(token), 'but never the token');
    assert.deepEqual((await fs.readdir(baseConfig('odd').workspaces.root)).sort(), ['.chatmcp-workspaces', '.exchange']);
    ok('clone: a tag leaves "no branch", a repository without commits is refused cleanly, a limit no disk can hold is refused, the token goes only to token hosts, a redirect is not followed, and a token echoed back by a server is hidden');
  }

  // -------------------------------------------------------------- the service as it runs for real (without the test switches)
  {
    const spy = process.platform === 'win32' ? null : await spyOnGit('production');
    const manager = makeManager('production');
    await fs.mkdir(manager.hubDirectory, { recursive: true });
    const build = async (realPath = process.env.PATH) => {
      const created = await createWorkspaceService({ config: baseConfig('production', { gitHosts: ['git.invalid'], githubToken: token }), manager, execution, env: { PATH: realPath }, log: () => {} });
      await created.create({ name: 'plain' }); // the first Git call: Git is looked up here
      return created;
    };
    const production = spy ? await spy.during(build) : await build();
    await rejects(production.clone({ url: 'http://git.invalid/octo/hello' }), 'bad_url', 'plain http is refused when the test switch is not set');
    await rejects(production.clone({ url: 'https://github.com/octo/hello' }), 'host_not_allowed', 'a host that is not on the list');
    const unreachable = await production.clone({ url: 'https://git.invalid/octo/hello' }).catch((error) => error);
    assert.equal(unreachable.code, 'git_network', unreachable.message);
    assert.equal(production.summary().count, 1, 'the failed clone left nothing behind');
    if (spy) {
      const calls = await spy.calls();
      assert.ok(calls.length >= 4, `${calls.length} Git calls recorded`);
      for (const call of calls) assert.equal(call.allow, 'https', `only https may be used: git ${call.args.slice(0, 100)}`);
      const attempt = calls.find((call) => wordsOf(call).includes(' clone '));
      assert.ok(attempt, 'the clone was attempted');
      assert.ok(attempt.args.includes('protocol.https.allow=always') && !attempt.args.includes('protocol.http.allow'), 'no plain http transport');
      assert.ok(!attempt.names.has('GIT_CONFIG_VALUE_0'), 'the token is not sent to a host that is not github.com');
    }
    ok('the service without test switches: http:// is refused, only https is allowed to Git, an unreachable host is reported as git_network, and the token goes only to github.com');
  }

  // -------------------------------------------------------------- the registry is written at once, not at the next operation
  {
    const reopen = (name, manager) => createWorkspaceService({ config: baseConfig(name), manager, execution, env: process.env, log: () => {}, testing: { allowHttp: true, tokenHosts: [server.hostPort] } });
    const cloning = await open('persist-clone');
    const cloned = await cloning.service.clone({ url: repoUrl('octo/hello') });
    assert.deepEqual((await (await reopen('persist-clone', cloning.manager)).list()).items.map((item) => item.name), [cloned.name], 'a clone is in the registry as soon as it exists');
    const making = await open('persist-create');
    const made = await making.service.create({ name: 'fresh' });
    assert.deepEqual((await (await reopen('persist-create', making.manager)).list()).items.map((item) => item.name), [made.name], 'a new workspace is in the registry as soon as it exists');
    ok('registry: a clone and a new workspace are written to disk at once (a restart right after loses nothing)');
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
    assert.equal((await scratch.service.list()).pushEnabled, false, 'the list says that pushing is not available without a token');
    const withToken = await open('withtoken');
    const empty = await withToken.service.create({ name: 'empty' });
    await rejects(withToken.service.push({ name: empty.name }), 'push_unsupported', 'an empty workspace has no repository to push to');
    ok('create: an empty repository on main with the committer identity, names are validated, duplicates get a suffix, push explains why it cannot run');

    const naming = await open('naming', { overrides: { max: 10, githubToken: null }, env: { ...process.env, CHATMCP_GIT_AUTHOR_NAME: 'Dev Name', CHATMCP_GIT_AUTHOR_EMAIL: 'dev@example.org' } });
    assert.equal((await naming.service.create({})).name, 'workspace', 'no name: a default one');
    assert.equal((await naming.service.create({ name: '  Notes_V2  ' })).name, 'notes_v2', 'names are trimmed and lower-cased');
    const longest = await naming.service.create({ name: 'x'.repeat(60) });
    assert.equal(longest.name, 'x'.repeat(60), 'the longest allowed name');
    await assert.rejects(fs.access(path.join(longest.path, '.git', 'hooks')), undefined, 'no hook samples are copied into a new repository');
    assert.equal((await gitIn(longest.path, ['config', '--local', 'user.name'])).trim(), 'Dev Name');
    assert.equal((await gitIn(longest.path, ['config', '--local', 'user.email'])).trim(), 'dev@example.org');
    const clipped = await open('clipped', { overrides: { githubToken: null }, env: { ...process.env, CHATMCP_GIT_AUTHOR_NAME: 'n'.repeat(150) } });
    assert.equal((await gitIn((await clipped.service.create({ name: 'c' })).path, ['config', '--local', 'user.name'])).trim().length, 100, 'a very long committer name is cut at 100');
    for (const bad of [{ CHATMCP_GIT_AUTHOR_NAME: 'Two\nLines' }, { CHATMCP_GIT_AUTHOR_EMAIL: 'a@b>c' }, { CHATMCP_GIT_AUTHOR_NAME: 'a<b' }]) {
      await assert.rejects(open('badidentity', { env: { ...process.env, ...bad } }), /xuống dòng/, `identity ${JSON.stringify(bad)}`);
    }
    ok('create: names are trimmed and lower-cased, the default and the longest name work, no sample hooks, the committer identity can be set (and cannot carry line breaks or < >)');

    const root = await fs.realpath(baseConfig('main').workspaces.root);
    await svc.guard(hello.path);
    await svc.guard(path.join(root, 'octo-hello-2'));
    await fs.mkdir(path.join(tmp, 'elsewhere', hello.name), { recursive: true }); // a real folder, elsewhere, that has a workspace's name
    for (const outside of [root, path.dirname(root), os.tmpdir(), path.join(hello.path, 'src'), path.join(root, '.exchange'), tmp, remotes, path.join(tmp, 'elsewhere', hello.name)]) {
      await rejects(svc.guard(outside), 'workspace_not_allowed', `guard ${outside}`);
    }
    await fs.mkdir(path.join(root, 'unregistered'));
    await rejects(svc.guard(path.join(root, 'unregistered')), 'workspace_not_allowed', 'a folder the registry does not know');
    const link = path.join(root, 'link-to-tmp');
    try { await fs.symlink(os.tmpdir(), link, 'dir'); await rejects(svc.guard(await fs.realpath(link)), 'workspace_not_allowed', 'a link resolved to the outside'); }
    catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
    await fs.rm(link, { force: true }); await fs.rm(path.join(root, 'unregistered'), { recursive: true, force: true });
    const vanishing = await open('vanishing');
    const vanished = await vanishing.service.create({ name: 'vanished' });
    await vanishing.service.guard(vanished.path);
    assert.equal((await vanishing.service.list()).items[0].exists, true);
    await fs.rm(vanished.path, { recursive: true, force: true });
    assert.equal((await vanishing.service.list()).items[0].exists, false, 'the list says which workspaces have lost their folder');
    await rejects(vanishing.service.guard(vanished.path), 'workspace_not_allowed', 'a registered workspace whose folder is gone is refused, not an ENOENT');
    await fs.writeFile(vanished.path, 'not a folder\n');
    await rejects(vanishing.service.guard(vanished.path), 'workspace_not_allowed', 'a registered workspace replaced by a plain file');
    ok('guard: only a folder that the registry lists, directly below the root, can be selected as the workspace (and one that has vanished from the disk is refused the same way)');
  }

  // -------------------------------------------------------------- push, with a workspace that the agent has tampered with
  {
    // Every Git process that the Hub starts for this service is recorded (see spyOnGit); the environment carries some secrets that
    // belong to the owner, which must never reach a Git process.
    const canaries = { CHATMCP_OWNER_TOKEN: 'canary-owner-token-0123456789abcdef0123456789abcdef', OPENROUTER_API_KEY: 'canary-provider-key', AWS_SECRET_ACCESS_KEY: 'canary-aws-secret', GITHUB_TOKEN: token };
    const spy = process.platform === 'win32' ? null : await spyOnGit('pusher');
    const pushed = spy
      ? await spy.during(async (realPath) => {
        const opened = await open('pusher', { env: { ...process.env, PATH: realPath, ...canaries } });
        await opened.service.create({ name: 'probe' }); // the first Git call: the service looks Git up here
        return opened;
      })
      : await open('pusher', { env: { ...process.env, ...canaries } });
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
    await fs.writeFile(path.join(work.path, 'uncommitted.txt'), 'not committed yet\n');
    const result = await pushed.service.push({ name: work.name, branch: 'feature/login' });
    assert.equal(result.warnings.length, 1, 'changes that are not committed are reported');
    assert.match(result.warnings[0], /chưa commit/);
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
    assert.deepEqual(third.warnings, [], 'nothing is left uncommitted, so there is nothing to warn about');
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

    // how many commits one push may carry
    {
      const bulkService = await open('bulk');
      const bulk = await bulkService.service.clone({ url: repoUrl('octo/hello') });
      const addCommits = async (count) => {
        const tip = (await gitIn(bulk.path, ['rev-parse', 'HEAD'])).trim();
        let stream = '';
        for (let n = 1; n <= count; n += 1) {
          const message = `bulk ${n}\n`;
          stream += `commit refs/heads/main\ncommitter Bulk <bulk@fixture.invalid> ${1_700_000_000 + n} +0000\ndata ${Buffer.byteLength(message)}\n${message}${n === 1 ? `from ${tip}\n` : ''}\n`;
        }
        await git(['-C', bulk.path, 'fast-import', '--quiet'], { input: stream });
      };
      await addCommits(500);
      assert.equal((await gitIn(bulk.path, ['rev-list', '--count', `${bulk.baseSha}..HEAD`])).trim(), '500');
      assert.equal((await bulkService.service.push({ name: bulk.name, branch: 'bulk/five-hundred' })).commits, 500, 'the most that one push may carry');
      await addCommits(1);
      await rejects(bulkService.service.push({ name: bulk.name, branch: 'bulk/too-many' }), 'too_many_commits', 'one commit more');
      // a workspace whose branch has no commit at all (the agent started an orphan branch)
      const orphanService = await open('orphan');
      const orphan = await orphanService.service.clone({ url: repoUrl('octo/hello') });
      await gitIn(orphan.path, ['checkout', '-q', '--orphan', 'void']);
      const none = await orphanService.service.push({ name: orphan.name }).catch((error) => error);
      assert.equal(none.code, 'nothing_to_push', none.message);
      assert.match(none.message, /chưa có commit/, 'and the message says why');
      ok('push: 500 new commits go in one push, 501 are refused, and a branch without any commit has nothing to push');
    }

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

    if (!spy) console.log('  skip - environment of the Git processes: the recording wrapper is a POSIX shell script');
    else {
      const calls = await spy.calls();
      assert.ok(calls.length >= 25, `the Hub ran Git ${calls.length} times in this service`);
      // The complete list of variables a Git process of the Hub may have. A new name must be reviewed and added here on purpose.
      const allowedNames = new Set([
        'PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE',
        'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'PATHEXT', 'COMSPEC',
        'HOME', 'USERPROFILE', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE', 'GIT_ASKPASS', 'SSH_ASKPASS',
        'GIT_ALLOW_PROTOCOL', 'GIT_PROTOCOL_FROM_USER', 'GIT_LFS_SKIP_SMUDGE', 'LC_ALL', 'LANGUAGE', 'GIT_PAGER', 'GIT_EDITOR',
        'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
        'PWD', 'OLDPWD', 'SHLVL', '_', // added by the shell of the wrapper itself
      ]);
      const harmless = { NOSYSTEM: '1', PROMPT: '0', FROMUSER: '0', LFS: '1', ASKPASS: 'echo', SSHASKPASS: 'echo', GCM: 'never', PAGER: 'cat', EDITOR: 'true', LC: 'C' };
      const privateRoot = path.join(pushed.manager.hubDirectory, 'workspace-tmp');
      const hardening = [
        'protocol.allow=never', 'protocol.https.allow=always', 'protocol.http.allow=always', 'http.followRedirects=false', 'transfer.fsckObjects=true', 'fetch.fsckObjects=true',
        'receive.fsckObjects=true', 'core.fsmonitor=false', `core.hooksPath=${path.join(privateRoot, 'no-hooks').replaceAll('\\', '/')}`, 'submodule.recurse=false', 'http.lowSpeedLimit=1000', 'http.lowSpeedTime=60',
      ];
      for (const call of calls) {
        const label = call.args.slice(0, 120);
        for (const name of Object.keys(canaries)) assert.ok(!call.names.has(name), `${name} must not reach a Git process: git ${label}`);
        assert.deepEqual([...call.names].filter((name) => !allowedNames.has(name)), [], `unexpected variables for git ${label}`);
        assert.deepEqual(call.values, harmless, `settings of git ${label}`);
        assert.equal(call.home, path.join(privateRoot, 'home'), `HOME of git ${label}`);
        assert.equal(call.global, path.join(privateRoot, 'empty'), `the global configuration of git ${label} is the empty file`);
        const remote = /https?:\/\/127\.0\.0\.1:/.test(call.args);
        assert.equal(call.names.has('GIT_CONFIG_VALUE_0'), remote, `the credential is in the environment of exactly the Git calls that talk to the server: git ${label}`);
        assert.equal(call.names.has('GIT_CONFIG_COUNT') && call.names.has('GIT_CONFIG_KEY_0'), remote);
        const unpacking = wordsOf(call).includes(' fetch ') && call.args.includes('refs/heads/work');
        assert.equal(call.allow, unpacking ? 'https:http:file' : 'https:http', `GIT_ALLOW_PROTOCOL of git ${label}`);
        assert.equal(call.args.includes('protocol.file.allow=always'), unpacking, `the file transport is allowed for the unpacking of the Hub's own bundle and nothing else: git ${label}`);
        if (remote) for (const flag of hardening) assert.ok(call.args.includes(flag), `a call to the server must carry -c ${flag}: git ${label}`);
      }
      assert.ok(calls.some((call) => wordsOf(call).includes(' clone ')) && calls.some((call) => wordsOf(call).includes(' push ')) && calls.some((call) => call.allow.endsWith(':file')), 'the recording saw a clone, a push and the unpacking of a bundle');
      // Nothing is left behind by the pushes: the exchange folder and the Hub's scratch folders are empty again.
      assert.deepEqual(await fs.readdir(path.join(baseConfig('pusher').workspaces.root, '.exchange')), [], 'the exchange folder is emptied after every push');
      assert.deepEqual((await fs.readdir(privateRoot)).filter((entry) => entry.startsWith('push-')), [], 'the Hub-private scratch repositories of a push are removed');
      ok(`git run by the Hub (${calls.length} calls recorded): only a short list of environment variables reaches it, none of the owner's secrets, the credential only on calls to the server, every call to the server carries the hardening flags, the file transport only unpacks the Hub's own bundle; pushes leave nothing behind`);
    }
  }

  // -------------------------------------------------------------- export
  {
    await fs.writeFile(path.join(hello.path, '.env'), 'API_KEY=hunter2hunter2\n');
    await fs.writeFile(path.join(hello.path, 'deploy.pem'), '-----BEGIN PRIVATE KEY-----\n');
    await fs.mkdir(path.join(hello.path, 'node_modules', 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(hello.path, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n');
    await fs.mkdir(path.join(hello.path, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(hello.path, 'src', 'deep', 'kept.txt'), 'kept\n');
    const secretLike = ['.env.local', 'server.key', 'cert.p12', 'cert.pfx', 'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json', '.venv/pyvenv.cfg', 'venv/pyvenv.cfg', '__pycache__/x.pyc', 'src/.env', 'src/deep/id_rsa', 'src/node_modules/x.js'];
    const lookAlikes = ['keys.txt', 'environment.md', 'src/venv_notes.md'];
    for (const file of [...secretLike, ...lookAlikes]) {
      const target = path.join(hello.path, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, 'x\n');
    }
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
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const archive = path.join(tmp, 'export.tar.gz');
    await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const listing = (await run('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 })).stdout.split(/\r?\n/).map((line) => line.replace(/^\.\//, '')).filter(Boolean);
    for (const wanted of ['README.md', 'src/app.py', 'src/util.py', 'src/deep/kept.txt', '.gitignore']) assert.ok(listing.includes(wanted), `${wanted} must be in the archive: ${listing.join(',')}`);
    for (const forbidden of listing) assert.ok(!/(^|\/)(\.git|node_modules)(\/|$)|(^|\/)\.env|\.pem$/.test(forbidden), `${forbidden} must not be exported`);
    for (const file of secretLike) assert.ok(!listing.includes(file), `${file} must not be exported`);
    assert.ok(!listing.some((entry) => /^(\.venv|venv|__pycache__)(\/|$)/.test(entry)), 'dependency and cache folders are not exported');
    for (const file of lookAlikes) assert.ok(listing.includes(file), `${file} is an ordinary file and must be exported`);
    const missing = await fetch(`${base}/?name=nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'workspace_unknown');
    assert.equal((await fetch(`${base}/?name=${encodeURIComponent('../ws-main/octo-hello')}`)).status, 404);
    await new Promise((resolve) => exporter.close(resolve));
    ok('export: a .tar.gz of the working tree without .git, dependency and cache folders, .env files and key files (every pattern), ordinary look-alikes kept; no-store and nosniff; an unknown or traversing name is a 404');
  }

  // -------------------------------------------------------------- remove, persistence
  {
    const root = await fs.realpath(baseConfig('main').workspaces.root);
    manager.workspace = hello.path;
    const asked = await svc.list();
    assert.deepEqual(asked.items.filter((entry) => entry.current).map((entry) => entry.name), [hello.name], 'the selected workspace is marked');
    assert.deepEqual([asked.max, asked.count, asked.gitHosts, asked.pushEnabled], [3, 3, [server.hostPort], true]);
    manager.workspace = path.join(tmp, 'elsewhere', hello.name);
    assert.deepEqual((await svc.list()).items.filter((entry) => entry.current), [], 'a folder with the same name somewhere else is not the selected workspace');
    manager.workspace = null;
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

    // A tree the agent made without any permission for itself must not make a workspace undeletable. (root ignores permissions, so
    // this only means something for another user; verify-exec-separation.mjs repeats it with the real hub and agent accounts.)
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      console.log('  skip - removal of a tree without permissions: the current user is not subject to file permissions');
    } else {
      const hostile = await svc.create({ name: 'hostile-tree' });
      const tree = path.join(hostile.path, 'd');
      await fs.mkdir(path.join(tree, 'e', 'h'), { recursive: true });
      for (const file of ['g', 'e/f', 'e/h/i']) await fs.writeFile(path.join(tree, file), 'x');
      await fs.chmod(path.join(tree, 'e', 'h'), 0o000);
      await fs.chmod(path.join(tree, 'e'), 0o000);
      await fs.chmod(tree, 0o500);
      const plain = await fs.rm(tree, { recursive: true }).then(() => null, (error) => error);
      assert.ok(plain && ['EACCES', 'EPERM'].includes(plain.code), `precondition: a plain recursive rm must fail on this tree (got ${plain?.code ?? 'success'})`);
      await svc.remove({ name: hostile.name });
      await assert.rejects(fs.lstat(hostile.path), (error) => error.code === 'ENOENT');
      assert.ok(!(await svc.list()).items.some((item) => item.name === hostile.name), 'and the registry forgets it');
      ok('remove: a tree the agent made with mode 000/500 (a plain rm fails on it) is still removed, by giving its owner the rights back first');
    }

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
    // A registry that has been damaged must never make a folder outside the root a workspace, nor stop the start.
    const outside = path.join(path.dirname(root), 'outside-folder');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep\n');
    for (const name of ['../outside-folder', 'a/b', '..', '.', '', 'UPPER', 'x'.repeat(61), 42, null]) reg2.items.push({ name, kind: 'clone', origin: null, baseSha: tips.main });
    reg2.items.push({ name: hello.name, kind: 'clone', origin: null, baseSha: tips.main }, null, 'text', 7);
    await fs.writeFile(path.join(root, 'afile'), 'a plain file, not a workspace\n');
    reg2.items.push({ name: 'afile', kind: 'clone', origin: null, baseSha: tips.main });
    let linked = false;
    try {
      await fs.symlink(outside, path.join(root, 'linked'), 'dir');
      linked = true;
      reg2.items.push({ name: 'linked', kind: 'clone', origin: null, baseSha: tips.main });
    } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
    await fs.mkdir(path.join(root, '.exchange', 'leftover-push'), { recursive: true });
    await fs.writeFile(path.join(root, '.exchange', 'leftover-push', 'new.bundle'), 'x');
    await fs.mkdir(path.join(manager.hubDirectory, 'workspace-tmp', 'push-stale'), { recursive: true });
    await fs.writeFile(path.join(manager.hubDirectory, 'workspaces.json'), JSON.stringify(reg2));
    const third = await createWorkspaceService({ config: baseConfig('main'), manager, execution, env: process.env, log: () => {}, testing: { allowHttp: true, tokenHosts: [server.hostPort] } });
    assert.deepEqual((await third.list()).items.map((item) => item.name), [hello.name], 'only the one real workspace is left (once)');
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep\n', 'a folder outside the root is never touched');
    if (linked) await assert.rejects(fs.lstat(path.join(root, 'linked')), (error) => error.code === 'ENOENT', 'a link in the root is removed, not followed');
    assert.deepEqual((await fs.readdir(root)).sort(), ['.chatmcp-workspaces', '.exchange', hello.name], 'the root holds the marker, the exchange folder and the one workspace');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(manager.hubDirectory, 'workspaces.json'), 'utf8')).items.map((item) => item.name), [hello.name], 'the registry on disk was rewritten without the dropped entries');
    assert.deepEqual(await fs.readdir(path.join(root, '.exchange')), [], 'what an interrupted push left behind is cleared at start');
    await assert.rejects(fs.access(path.join(manager.hubDirectory, 'workspace-tmp', 'push-stale')), undefined, 'the Hub-private scratch folder is cleared at start');
    ok('registry: workspaces survive a restart of the service; entries without a folder, folders without an entry, damaged or hostile entries (outside the root, links, duplicates, wrong types) and leftovers are dropped');
  }

  // -------------------------------------------------------------- nothing secret anywhere
  {
    const hits = await scanForSecrets(manager.hubDirectory, baseConfig('main').workspaces.root, baseConfig('pusher').workspaces.root, baseConfig('scratch').workspaces.root);
    assert.deepEqual(hits, [], `the token must not be written anywhere on disk: ${hits.join(', ')}`);
    assert.ok(!manager.lines.some((line) => line.includes(token)), 'the token must not be logged');
    ok('the GitHub token is not on disk (state, registry, any .git/config) and not in the log after clone, push and failures');
  }

  await new Promise((resolve) => evil.close(resolve));
  await new Promise((resolve) => odd.close(resolve));
  await other.close();
  await server.close();
} finally {
  await cleanup();
}

console.log(`PASS (${checks} checks)`);
