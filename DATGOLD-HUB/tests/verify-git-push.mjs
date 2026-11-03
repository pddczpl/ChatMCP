// git_push, end to end on real repositories: a working copy, a bare repository as `origin` (no network, no account), the real LocalTools with the hardened Git
// runner, and the real PermissionGate. The pure part is tests/verify-git-push-logic.mjs.
//
//  1. a push publishes the branch (and only that), sets the upstream when there is none, never forces, never runs a hook, never touches the working tree
//  2. the call is refused before anything is asked: forbidden arguments, an unknown remote or branch, main / master / the remote's default branch, a range that
//     holds a secret or a protected file, a diverged branch, a repository whose own configuration would run a program, an address that runs a program
//  3. the owner is asked, in every mode and also in Full Access, with the real list of commits; "no" pushes nothing, "yes" pushes exactly what was shown
//  4. credentials in an address never reach the card, the history or a result
//  5. a plan that went stale after the question is refused, a stop and a timeout end the push
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { delay } from '../lib/runtime.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { GitRunner } from '../lib/git-runner.mjs';
import { PermissionGate } from '../lib/permissions.mjs';
import { executePush, planPush, PUSH_LIMITS } from '../lib/git-push.mjs';

const isWindows = process.platform === 'win32';
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const textOf = (result) => result.content.map((part) => part.text).join('\n');
const errorCode = (result) => result.structuredContent?.error?.code;
setTimeout(() => { console.error('FAIL: the git_push suite exceeded its own time budget'); process.exit(2); }, 230_000).unref();

// A secret in this file is built at run time, never written as a literal.
const TOKEN = `ghp_${'Zx9Yw8Vu7T'.repeat(4)}`;
const PASSWORD = 'Pa55-w0rd-Only-In-Tests';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-git-push-'));
const emptyConfig = path.join(root, 'empty.gitconfig');
await fs.writeFile(emptyConfig, '');
// The machine's own Git configuration (a credential manager, a signing key, an include) must not change what a test sees.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', HOME: root, USERPROFILE: root, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
for (const key of Object.keys(gitEnv)) if (/^GIT_(?!CONFIG_GLOBAL$|CONFIG_NOSYSTEM$|TERMINAL_PROMPT$)/i.test(key)) delete gitEnv[key];
const slashes = (value) => value.replaceAll('\\', '/');
/** Raw Git, for building the fixtures and for looking at what the tool did. */
function sh(cwd, ...args) { return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const shFails = (cwd, ...args) => { try { sh(cwd, ...args); return false; } catch { return true; } };
const write = async (file, content) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };

let counter = 0;
let template = null;
/**
 * The fixture, built once (a dozen Git processes) and copied for every scenario: a working copy on `feature/x` with two commits that `origin` (a bare repository) does not
 * have; `main` is on both. `origin/HEAD` points at main like after a clone.
 */
async function buildTemplate() {
  const dir = path.join(root, 'template');
  const bare = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  await fs.mkdir(bare, { recursive: true });
  await fs.mkdir(work, { recursive: true });
  sh(bare, 'init', '-q', '--bare', '-b', 'main');
  sh(work, 'init', '-q', '-b', 'main');
  sh(work, 'config', 'user.email', 'dev@example.invalid');
  sh(work, 'config', 'user.name', 'Dev Test');
  await write(path.join(work, 'README.md'), '# Demo\n');
  sh(work, 'add', 'README.md');
  sh(work, 'commit', '-q', '-m', 'initial commit');
  sh(work, 'remote', 'add', 'origin', slashes(bare));
  sh(work, 'push', '-q', '-u', 'origin', 'main');
  sh(work, 'remote', 'set-head', 'origin', 'main');
  sh(work, 'checkout', '-q', '-b', 'feature/x');
  await write(path.join(work, 'a.txt'), 'alpha\n');
  sh(work, 'add', 'a.txt');
  sh(work, 'commit', '-q', '-m', 'feat: add a');
  await write(path.join(work, 'src', 'b.txt'), 'beta\n');
  sh(work, 'add', 'src/b.txt');
  sh(work, 'commit', '-q', '-m', 'feat: add b (Tiếng Việt)');
  return dir;
}

/** `count` empty commits on the branch that is checked out, made by one `git fast-import` instead of `count` commits. */
function bulkCommits(p, count) {
  const branch = sh(p.work, 'symbolic-ref', '--short', 'HEAD');
  const tip = sh(p.work, 'rev-parse', 'HEAD'); // fast-import will not start a branch "from itself", but from the commit it points at
  let stream = '';
  for (let i = 1; i <= count; i += 1) {
    const message = `bulk ${i}`;
    stream += `commit refs/heads/${branch}\ncommitter Dev Test <dev@example.invalid> ${1_700_000_000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${i === 1 ? `from ${tip}\n` : ''}\n`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: p.work, env: gitEnv, input: stream, stdio: ['pipe', 'ignore', 'pipe'] });
}

/** A scenario's own copy of the fixture, with its tools. */
async function project({ head = true, spawner = null, secrets = () => [] } = {}) {
  template ??= await buildTemplate();
  const dir = path.join(root, `p${++counter}`);
  const bare = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  const state = path.join(dir, 'state');
  await fs.cp(template, dir, { recursive: true });
  await fs.mkdir(state, { recursive: true });
  sh(work, 'remote', 'set-url', 'origin', slashes(bare));
  if (!head) sh(work, 'remote', 'set-head', 'origin', '-d');
  const manager = { workspace: work, secrets: [] };
  const studio = new StudioWorkspace({ manager, directory: path.join(state, 'studio') });
  const git = new GitRunner({ workspace: studio, hooksDirectory: path.join(state, 'no-hooks'), env: gitEnv, secrets, ...(spawner ? { spawner } : {}) });
  const tools = new LocalTools({ workspace: studio, stateDirectory: state, git, secrets });
  const gate = (options = {}) => {
    const created = new PermissionGate({ manager, workspace: studio, timeout: 60_000, ...options });
    created.attachLocalTools(tools);
    return created;
  };
  const refs = () => sh(bare, 'for-each-ref', '--format=%(refname) %(objectname)');
  return { dir, bare, work, state, studio, tools, git, gate, manager, refs, head: () => sh(work, 'rev-parse', 'HEAD'), call: (args, context) => tools.call('git_push', args, context) };
}
/** A new commit on the branch that is checked out. */
async function commit(p, name = `n${++counter}.txt`, content = `${name}\n`, message = `chore: ${name}`) {
  await write(path.join(p.work, name), content);
  sh(p.work, 'add', name);
  sh(p.work, 'commit', '-q', '-m', message);
}
const closedPort = async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

/** allowed unasked ('allow'), asked ('prompt', answered with `approve`), or refused ('policy' / 'blocked' / 'deny'), plus the request that was shown. */
async function outcome(gate, name, args, { approve = false } = {}) {
  const run = gate.authorize({ name, args, definition: {}, taskId: 'task-1' });
  let settled = null;
  run.then((value) => { settled = { value }; }, (thrown) => { settled = { thrown }; });
  for (let i = 0; i < 3000 && !settled && gate.state().pending.length === 0; i += 1) await delay(5);
  if (settled?.thrown) return { kind: 'throw', error: settled.thrown };
  if (settled) {
    const last = gate.state().recent.at(-1);
    const kind = settled.value.allowed ? 'allow' : last && last.toolName === name && ['blocked', 'policy'].includes(last.decision) ? last.decision : 'deny';
    return { kind, result: settled.value };
  }
  const pending = gate.state().pending;
  assert.equal(pending.length, 1, `${name}: exactly one request`);
  const request = pending[0];
  gate.decide(request.id, approve);
  return { kind: 'prompt', result: await run, request };
}

try {
  // ---------------------------------------------------------------- the tool in the catalog
  {
    const p = await project();
    const definition = p.tools.definitions().find((tool) => tool.originalName === 'git_push');
    assert.ok(definition, 'git_push is in the catalog');
    assert.equal(definition.name, 'local.git_push');
    assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(), ['branch', 'remote', 'set_upstream']);
    assert.equal(definition.inputSchema.additionalProperties, false, 'nothing else can be passed');
    assert.deepEqual(definition.inputSchema.required ?? [], [], 'every argument has a default');
    assert.match(definition.description, /never|không bao giờ/i, 'the description tells the model what it will not do');
    assert.match(definition.description, /force/i);
    assert.equal(definition.annotations.readOnlyHint, false);
    const verdict = await p.tools.assess('git_push', {});
    assert.equal(verdict.category, 'dangerous', 'the category is dangerous: it sends commits out of the machine');
    assert.equal(verdict.detail?.kind, 'git_push');
    assert.match(verdict.summary, /git push origin feature\/x/);
    ok('catalog: git_push is dangerous, takes remote / branch / set_upstream and nothing else, and says what it will not do');
  }

  // ---------------------------------------------------------------- 1. a push
  {
    const calls = [];
    const p = await project({ spawner: (exe, args, options) => { calls.push(args); return spawn(exe, args, options); } });
    await write(path.join(p.work, '.git', 'hooks', 'pre-push'), `#!/bin/sh\necho ran > "${slashes(p.work)}/PRE-PUSH-RAN"\nexit 0\n`);
    await fs.chmod(path.join(p.work, '.git', 'hooks', 'pre-push'), 0o755);
    await write(path.join(p.work, 'untracked.txt'), 'not committed\n');
    const head = p.head();
    const statusBefore = sh(p.work, 'status', '--porcelain');
    const result = await p.call({});
    assert.equal(result.isError, false, textOf(result));
    const done = result.structuredContent;
    assert.equal(done.pushed, true);
    assert.equal(done.remote, 'origin');
    assert.equal(done.branch, 'feature/x');
    assert.equal(done.ref, 'refs/heads/feature/x');
    assert.deepEqual(done.range, { from: null, to: head }, 'a new branch: nothing before, the head after');
    assert.equal(done.commits, 2);
    assert.equal(done.setUpstream, true, 'there was no upstream, so one is set');
    assert.equal(done.upstream, 'origin/feature/x');
    assert.match(textOf(result), /2 commit/);
    assert.match(textOf(result), /origin/);
    assert.equal(sh(p.bare, 'rev-parse', 'refs/heads/feature/x'), head, 'the bare repository has the branch');
    assert.equal(sh(p.bare, 'rev-parse', 'refs/heads/main'), sh(p.work, 'rev-parse', 'main'), 'and main is as it was');
    assert.equal(sh(p.work, 'config', 'branch.feature/x.remote'), 'origin');
    assert.equal(sh(p.work, 'config', 'branch.feature/x.merge'), 'refs/heads/feature/x');
    assert.equal(sh(p.work, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
    assert.equal(sh(p.work, 'status', '--porcelain'), statusBefore, 'the working tree and the index are as they were');
    assert.equal(await fs.stat(path.join(p.work, 'PRE-PUSH-RAN')).then(() => true, () => false), false, 'the pre-push hook of the repository did not run');
    const pushes = calls.filter((args) => args.includes('push'));
    assert.equal(pushes.length, 1, 'one push');
    const line = pushes[0].join(' ');
    assert.match(line, /refs\/heads\/feature\/x:refs\/heads\/feature\/x/, 'one branch, spelled out in full');
    assert.ok(pushes[0].includes('--set-upstream'));
    assert.ok(pushes[0].includes('--porcelain'));
    assert.ok(pushes[0].includes('--no-verify'));
    assert.ok(pushes[0].includes('--no-follow-tags'));
    assert.ok(pushes[0].includes('--recurse-submodules=no'), 'submodules are not pushed along');
    assert.match(line, /core\.hooksPath=/, 'the hardened runner: hooks off');
    assert.equal(pushes[0].filter((arg) => /^(?:-f|--force.*|--delete|-d|--mirror|--all|--tags|--prune|--atomic|\+.*)$/.test(arg)).length, 0, 'no force, no delete, no mirror, no --all, no --tags');
    const afterPush = pushes[0].slice(pushes[0].indexOf('push') + 1);
    assert.equal(afterPush.filter((arg) => arg.includes(':')).length, 1, 'exactly one refspec after "push"');
    assert.deepEqual(afterPush.slice(-2), ['origin', 'refs/heads/feature/x:refs/heads/feature/x'], 'the remote by name, then the one branch');

    // later: new work is pushed as a fast-forward and the existing upstream is left alone
    await commit(p);
    const next = await p.call({});
    assert.equal(next.isError, false, textOf(next));
    assert.deepEqual(next.structuredContent.range, { from: head, to: p.head() }, 'the range is what the remote had and what it has now');
    assert.equal(next.structuredContent.commits, 1);
    assert.equal(next.structuredContent.setUpstream, false, 'it has an upstream: not set again');
    assert.equal(calls.filter((args) => args.includes('push')).at(-1).includes('--set-upstream'), false);
    assert.equal(sh(p.bare, 'rev-parse', 'refs/heads/feature/x'), p.head());

    // and then there is nothing left to say
    const nothing = await p.call({});
    assert.equal(errorCode(nothing), 'nothing_to_push');
    assert.equal((await p.tools.assess('git_push', {})).category, 'blocked', 'nothing to push is not worth a question');
    ok('push: the branch reaches origin as one explicit refspec, upstream set once, no force/delete/mirror/tags, no hook, HEAD / index / working tree untouched; the next push is a fast-forward; then "nothing to push"');
  }
  {
    const p = await project();
    const result = await p.call({ set_upstream: false });
    assert.equal(result.isError, false, textOf(result));
    assert.equal(result.structuredContent.setUpstream, false);
    assert.ok(shFails(p.work, 'config', 'branch.feature/x.remote'), 'no upstream when the call said not to');
    const q = await project();
    await commit(q);
    sh(q.work, 'push', '-q', '-u', 'origin', 'feature/x');
    await commit(q);
    const forced = await q.call({ set_upstream: true });
    assert.equal(forced.isError, false, textOf(forced));
    assert.equal(forced.structuredContent.setUpstream, true, 'asked for explicitly: set (again)');
    ok('set_upstream: false is honoured, true is honoured');
  }
  {
    const p = await project();
    sh(p.work, 'checkout', '-q', '-b', 'other');
    await commit(p, 'other.txt');
    sh(p.work, 'checkout', '-q', 'feature/x');
    const result = await p.call({ branch: 'other' });
    assert.equal(result.isError, false, textOf(result));
    assert.equal(result.structuredContent.branch, 'other', 'a branch that is not checked out can be pushed by name');
    assert.equal(sh(p.bare, 'rev-parse', 'refs/heads/other'), sh(p.work, 'rev-parse', 'other'));
    assert.ok(shFails(p.bare, 'rev-parse', '--verify', '-q', 'refs/heads/feature/x'), 'and only that branch');
    ok('branch: a branch other than the current one is pushed by name, and only it');
  }

  // ---------------------------------------------------------------- 2. refused before anything is asked
  {
    const p = await project();
    const before = p.refs();
    const keys = ['force', 'force_with_lease', 'forceWithLease', 'force-with-lease', 'delete', 'mirror', 'all', 'tags', 'follow_tags', 'prune', 'refspec', 'no_verify', 'receive_pack', 'push_option', 'url', 'dry_run', 'atomic'];
    for (const key of keys) {
      for (const value of [true, false, 'true', 'refs/heads/main']) {
        const checked = p.tools.validate('git_push', { [key]: value });
        assert.equal(checked.ok, false, `${key}=${JSON.stringify(value)} is not an argument of git_push`);
        assert.equal(checked.code, 'invalid_arguments');
        assert.match(checked.errors.join(' '), new RegExp(key.replace(/[-]/g, '\\-')), 'and the error names it');
        assert.equal(errorCode(await p.call({ [key]: value })), 'invalid_arguments');
      }
    }
    const values = [
      { branch: '+feature/x' }, { branch: '--force' }, { branch: '-f' }, { branch: '--delete' }, { branch: '--mirror' }, { branch: '--all' }, { branch: '--tags' }, { branch: '--force-with-lease=main' },
      { branch: 'feature/x:main' }, { branch: 'HEAD:refs/heads/main' }, { branch: ':feature/x' }, { branch: '+refs/heads/feature/x:refs/heads/main' }, { branch: 'refs/heads/feature/x' }, { branch: 'refs/tags/v1' },
      { branch: 'a b' }, { branch: 'a..b' }, { branch: '' }, { branch: 'HEAD' }, { branch: '*' }, { branch: 'feature/*' }, { branch: 'x\ny' },
      { remote: '--mirror' }, { remote: '--all' }, { remote: '-f' }, { remote: 'https://example.invalid/r.git' }, { remote: slashes(p.bare) }, { remote: 'git@github.com:o/r.git' }, { remote: 'origin main' }, { remote: '' }, { remote: '*' },
      { remote: 'origin', branch: '+feature/x' },
    ];
    for (const args of values) {
      const checked = p.tools.validate('git_push', args);
      assert.equal(checked.ok, false, `${JSON.stringify(args)} is refused`);
      const result = await p.call(args);
      assert.equal(result.isError, true, `${JSON.stringify(args)}: ${textOf(result)}`);
      assert.equal(errorCode(result), 'invalid_arguments', JSON.stringify(args));
    }
    assert.equal(p.refs(), before, 'nothing reached the bare repository');
    ok(`forbidden: ${keys.length} options and ${values.length} values (+refspec, src:dst, --force, --delete, --mirror, --all, --tags, an address, a pattern ...) are refused as invalid arguments; the remote is untouched`);
  }
  {
    const p = await project();
    const before = p.refs();
    const missing = await p.call({ remote: 'upstream' });
    assert.equal(errorCode(missing), 'remote_not_found');
    assert.match(textOf(missing), /upstream/);
    assert.match(textOf(missing), /origin/, 'it lists the remotes there are');
    assert.equal((await p.tools.assess('git_push', { remote: 'upstream' })).category, 'blocked');
    assert.equal(errorCode(await p.call({ branch: 'no-such-branch' })), 'branch_not_found');
    sh(p.work, 'checkout', '-q', '--detach');
    assert.equal(errorCode(await p.call({})), 'detached_head', 'a detached HEAD has no branch to push');
    assert.equal(p.refs(), before);
    ok('remote not configured, branch not found and a detached HEAD are refused with their own code');
  }
  {
    // main and master, and the default branch of the remote
    const p = await project();
    sh(p.work, 'checkout', '-q', 'main');
    await commit(p, 'on-main.txt');
    const before = p.refs();
    for (const args of [{}, { branch: 'main' }]) {
      const result = await p.call(args);
      assert.equal(errorCode(result), 'push_protected_branch', JSON.stringify(args));
      assert.match(textOf(result), /pull request/i);
      assert.match(textOf(result), /main/);
    }
    assert.equal((await p.tools.assess('git_push', {})).category, 'blocked');
    sh(p.work, 'branch', 'master');
    sh(p.work, 'checkout', '-q', 'master');
    await commit(p, 'on-master.txt');
    assert.equal(errorCode(await p.call({ branch: 'master' })), 'push_protected_branch');
    assert.equal(p.refs(), before, 'neither was pushed');

    // the default branch of the remote is whatever origin/HEAD says
    sh(p.work, 'checkout', '-q', '-b', 'trunk');
    sh(p.work, 'push', '-q', 'origin', 'trunk');
    sh(p.work, 'remote', 'set-head', 'origin', 'trunk');
    await commit(p, 'on-trunk.txt');
    const trunk = await p.call({ branch: 'trunk' });
    assert.equal(errorCode(trunk), 'push_protected_branch');
    assert.match(textOf(trunk), /trunk/, 'it names the default branch of the remote');
    sh(p.work, 'checkout', '-q', '-b', 'develop');
    await commit(p, 'on-develop.txt');
    assert.equal((await p.call({ branch: 'develop' })).isError, false, 'a branch that is not the default is pushed');
    ok('main, master and the default branch of the remote (origin/HEAD) are refused with "use a feature branch and a pull request"; other branches are not');
  }
  {
    // the remote's real default is asked of the remote at the moment of the push when origin/HEAD says nothing
    const p = await project({ head: false });
    sh(p.work, 'checkout', '-q', '-b', 'trunk');
    sh(p.work, 'push', '-q', 'origin', 'trunk');
    sh(p.bare, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
    await commit(p, 'on-trunk.txt');
    const before = p.refs();
    const plan = await planPush(p.git, { remote: 'origin', branch: 'trunk' });
    assert.equal(plan.ok, true, 'by the local facts alone trunk is not a default branch');
    const result = await p.call({ branch: 'trunk' });
    assert.equal(errorCode(result), 'push_protected_branch', 'the remote is asked and says it is its default');
    assert.equal(p.refs(), before);
    ok('the default branch is also asked of the remote at push time (ls-remote --symref) when origin/HEAD is missing');
  }
  {
    // a branch that was rewritten cannot be pushed over the old one: there is no force
    const p = await project();
    assert.equal((await p.call({})).isError, false);
    sh(p.work, 'commit', '-q', '--amend', '-m', 'rewritten history');
    const before = p.refs();
    const result = await p.call({});
    assert.equal(errorCode(result), 'push_not_fast_forward');
    assert.match(textOf(result), /force|ghi đè|fast-forward/i);
    assert.equal((await p.tools.assess('git_push', {})).category, 'blocked');
    assert.equal(p.refs(), before, 'the remote has the old history still');
    ok('a rewritten branch is refused (no force), the remote keeps its history');
  }
  {
    // a secret in the range, even one that a later commit removes
    const p = await project();
    const before = p.refs();
    await commit(p, 'deploy.js', `const token = "${TOKEN}";\n`, 'chore: deploy');
    await commit(p, 'deploy.js', 'const token = process.env.TOKEN;\n', 'fix: no hard-coded token');
    const result = await p.call({});
    assert.equal(errorCode(result), 'push_secret_found');
    const message = textOf(result);
    assert.match(message, /github-token/, 'the kind of secret');
    assert.match(message, /deploy\.js/, 'the file');
    assert.match(message, new RegExp(sh(p.work, 'rev-parse', '--short=7', 'HEAD~1')), 'and the commit that added it');
    for (const leak of [TOKEN, 'Zx9Yw8Vu7T']) assert.ok(!message.includes(leak), 'the message does not repeat the secret');
    const verdict = await p.tools.assess('git_push', {});
    assert.equal(verdict.category, 'blocked', 'no question is asked');
    assert.equal(verdict.code, 'push_secret_found');
    assert.ok(!JSON.stringify(verdict).includes('Zx9Yw8Vu7T'));
    assert.equal(p.refs(), before, 'nothing was pushed');
    // a secret only in a commit the remote already has is not this push's business
    const q = await project();
    await commit(q, 'old.js', `const token = "${TOKEN}";\n`, 'chore: old mistake');
    sh(q.work, 'push', '-q', 'origin', 'feature/x');
    await commit(q);
    assert.equal((await q.call({})).isError, false, 'only the commits that would be sent are scanned');
    ok('a secret in the range is refused with its kind, file and commit (never its value) and before any question; one the remote already has is not');
  }
  {
    const p = await project();
    const before = p.refs();
    await write(path.join(p.work, '.env'), 'PLAIN=1\n');
    sh(p.work, 'add', '-f', '.env');
    sh(p.work, 'commit', '-q', '-m', 'oops');
    const result = await p.call({});
    assert.equal(errorCode(result), 'push_protected_file');
    assert.match(textOf(result), /\.env/);
    assert.equal(p.refs(), before);
    ok('a protected file (.env) in the range is refused even when its content looks harmless');
  }
  {
    const p = await project();
    await commit(p, 'big.txt', 'x\n'.repeat(5000));
    const plan = await planPush(p.git, { remote: 'origin', scanLimit: 1000 });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, 'push_scan_incomplete', 'a range that is too large to read is refused, not waved through');
    assert.ok(PUSH_LIMITS.scanChars >= 1_000_000, 'but the limit is generous: a megabyte of change is read');
    // the same when Git's answer was read whole and is just longer than the limit
    const q = await project();
    await commit(q, 'mid.txt', 'y\n'.repeat(600));
    const mid = await planPush(q.git, { remote: 'origin', scanLimit: 1000 });
    assert.equal(mid.ok, false);
    assert.equal(mid.code, 'push_scan_incomplete', 'a range that was read but is longer than the limit is refused as well');
    // Git's answer cut short, or Git failing, with little or no text collected: that is not "no secret found"
    for (const answer of [{ code: 0, stdout: '', stderr: '', truncated: true }, { code: 1, stdout: '', stderr: 'fatal: x', truncated: false }]) {
      const cutShort = { ensureRepo: (options) => q.git.ensureRepo(options), secrets: () => [], text: async (args, options) => (args.includes('-p') ? answer : q.git.text(args, options)) };
      const refused = await planPush(cutShort, { remote: 'origin' });
      assert.equal(refused.ok, false, JSON.stringify(answer));
      assert.equal(refused.code, 'push_scan_incomplete', 'a scan that was cut or failed is not an empty scan');
    }
    ok('a range too large to scan is refused (fail closed), whether Git cut its answer or it was read whole');
  }
  {
    // a current branch whose name is not a plain one (it holds a zero-width space, which Git allows)
    const p = await project();
    const odd = `x${String.fromCharCode(0x200b)}y`;
    sh(p.work, 'checkout', '-q', '-b', odd);
    await commit(p);
    const before = p.refs();
    assert.equal(errorCode(await p.call({})), 'bad_branch', 'the current branch is not pushed under a name that cannot be shown honestly');
    assert.equal(p.refs(), before);
    // a range of more than fifty commits: the card lists the newest fifty, oldest of them first, and counts the rest
    const q = await project();
    bulkCommits(q, 55);
    const many = await q.tools.assess('git_push', {});
    assert.equal(many.category, 'dangerous');
    assert.equal(many.detail.commitCount, 57, 'two real commits and fifty-five more');
    assert.equal(many.detail.commits.length, 50, 'at most fifty are listed');
    assert.equal(many.detail.commitsOmitted, 7);
    assert.equal(many.detail.commits[0].subject, 'bulk 6', 'the newest fifty, the oldest of them first');
    assert.equal(many.detail.commits.at(-1).subject, 'bulk 55');
    assert.equal(many.summary.includes('57 commit'), true, 'and the summary counts all of them');
    // the plan that was shown is what executePush holds the branch to
    const r = await project();
    const shown = await planPush(r.git, { remote: 'origin' });
    assert.equal(shown.ok, true);
    await commit(r);
    const beforePush = r.refs();
    const stale = await executePush(r.git, shown.plan);
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'plan_changed', 'a plan whose branch has moved is not executed');
    assert.equal(r.refs(), beforePush);
    ok('a branch name that cannot be shown honestly is refused, more than fifty commits are counted and capped, a stale plan is not executed');
  }
  {
    // a repository whose own configuration would run a program when Git talks to a remote
    const p = await project();
    const before = p.refs();
    const marker = path.join(p.dir, 'PWNED');
    const cases = [
      ['credential.helper', `!sh -c 'echo x > ${slashes(marker)}'`],
      ['core.sshCommand', `sh -c 'echo x > ${slashes(marker)}'`],
      ['core.askPass', `${slashes(marker)}`],
      ['core.gitProxy', `${slashes(marker)}`],
      ['remote.origin.receivepack', `${slashes(marker)}`],
      ['remote.origin.uploadpack', `${slashes(marker)}`],
      ['remote.origin.proxy', `http://127.0.0.1:9`],
      ['remote.origin.vcs', 'pwn'],
      // the HTTP transport: a proxy of the repository's own, or a certificate check that it switched off, would let the author of the folder read the push
      ['http.proxy', 'http://127.0.0.1:9'],
      ['http.https://example.com/.proxy', 'http://127.0.0.1:9'],
      ['http.sslVerify', 'false'],
      ['http.sslCAInfo', `${slashes(marker)}`],
      ['http.sslCAPath', `${slashes(marker)}`],
      ['http.sslCert', `${slashes(marker)}`],
      ['http.sslKey', `${slashes(marker)}`],
      ['http.pinnedPubKey', 'sha256//x'],
      ['http.cookieFile', `${slashes(marker)}`],
      ['http.proxyAuthMethod', 'basic'],
      ['https.proxy', 'http://127.0.0.1:9'],
      ['http.extraHeader', 'X-Test: 1'],
    ];
    for (const [index, [key, value]] of cases.entries()) {
      sh(p.work, 'config', key, value);
      const result = await p.call({});
      assert.equal(errorCode(result), 'push_untrusted_repo', `${key}: ${textOf(result)}`);
      assert.ok(textOf(result).toLowerCase().includes(key.toLowerCase()), 'it names the setting (Git lower-cases the section and the key)');
      assert.ok(!textOf(result).includes(slashes(marker)) && !textOf(result).includes('echo x'), 'and not its value');
      if (index % 4 === 0) { // the assessment is the same plan: looked at for every fourth setting
        const verdict = await p.tools.assess('git_push', {});
        assert.equal(verdict.category, 'blocked');
        assert.equal(verdict.code, 'push_untrusted_repo');
      }
      sh(p.work, 'config', '--unset-all', key);
    }
    assert.equal(await fs.stat(marker).then(() => true, () => false), false, 'no program of the repository ran');
    assert.equal(p.refs(), before);
    // and a setting the runner refuses for every command
    sh(p.work, 'config', 'filter.pwn.clean', 'sh -c true');
    assert.equal(errorCode(await p.call({})), 'git_config_untrusted');
    assert.equal((await p.tools.assess('git_push', {})).category, 'blocked');
    sh(p.work, 'config', '--unset-all', 'filter.pwn.clean');
    assert.equal((await p.call({})).isError, false, 'with the settings gone the push goes through');
    ok(`untrusted folder: ${cases.length} repository settings that name a program for the network are refused by name (never by value), a clean-filter is refused by the runner, nothing ran`);
  }
  {
    // an address that runs a program
    const p = await project();
    const before = p.refs();
    for (const url of ['ext::sh -c "echo x"', 'pwn::something', '-oProxyCommand=x']) {
      sh(p.work, 'config', 'remote.origin.url', url);
      const result = await p.call({});
      assert.equal(errorCode(result), 'push_bad_remote', url);
      assert.equal((await p.tools.assess('git_push', {})).category, 'blocked');
    }
    // a remote with two push addresses is pushed to at both, and the card shows one: only a single address is accepted
    sh(p.work, 'config', 'remote.origin.url', slashes(p.bare));
    sh(p.work, 'config', '--add', 'remote.origin.pushurl', slashes(p.bare));
    sh(p.work, 'config', '--add', 'remote.origin.pushurl', `${slashes(p.bare)}-second`);
    const several = await p.call({});
    assert.equal(errorCode(several), 'push_bad_remote');
    assert.match(textOf(several), /nhiều địa chỉ/, 'it says that the remote has several push addresses');
    assert.equal((await p.tools.assess('git_push', {})).category, 'blocked');
    sh(p.work, 'config', '--unset-all', 'remote.origin.pushurl');
    sh(p.work, 'config', '--add', 'remote.origin.pushurl', slashes(p.bare));
    assert.equal((await p.call({})).isError, false, 'one push address of its own (pushurl) is fine, and is the one that is pushed to');
    assert.equal(p.refs().includes('feature/x'), true);
    ok('a remote address that names a helper program (ext::, x::y) or an option is refused, and so is a remote with several push addresses');
  }
  {
    const empty = await fs.mkdtemp(path.join(root, 'norepo-'));
    const studio = new StudioWorkspace({ manager: { workspace: empty, secrets: [] }, directory: path.join(empty, '.state') });
    const tools = new LocalTools({ workspace: studio, stateDirectory: path.join(empty, '.state'), git: new GitRunner({ workspace: studio, hooksDirectory: path.join(empty, '.hooks'), env: gitEnv }) });
    const result = await tools.call('git_push', {});
    assert.equal(errorCode(result), 'not_git_repo');
    assert.equal((await tools.assess('git_push', {})).category, 'blocked');
    ok('a folder that is not a repository is refused');
  }

  // ---------------------------------------------------------------- 3. the owner is asked
  {
    const p = await project();
    const gate = p.gate();
    gate.configure({ mode: 'review' });
    const denied = await outcome(gate, 'local.git_push', {}, { approve: false });
    assert.equal(denied.kind, 'prompt', 'Review asks');
    assert.equal(denied.result.allowed, false);
    assert.equal(denied.request.category, 'dangerous');
    const detail = denied.request.detail;
    assert.equal(detail.kind, 'git_push');
    assert.equal(detail.remote, 'origin');
    assert.equal(detail.url, slashes(p.bare), 'the address of the remote');
    assert.equal(detail.localBranch, 'feature/x');
    assert.equal(detail.remoteRef, 'refs/heads/feature/x');
    assert.equal(detail.setUpstream, true);
    assert.equal(detail.commitCount, 2);
    assert.deepEqual(detail.commits.map((entry) => entry.subject), ['feat: add a', 'feat: add b (Tiếng Việt)'], 'the real commits, oldest first');
    assert.deepEqual(detail.commits.map((entry) => entry.sha), [sh(p.work, 'rev-parse', '--short=7', 'HEAD~1'), sh(p.work, 'rev-parse', '--short=7', 'HEAD')]);
    assert.equal(detail.commitsOmitted, 0);
    assert.match(detail.diffstat, /a\.txt/);
    assert.match(detail.diffstat, /src\/b\.txt/);
    assert.equal(detail.totals.files, 2);
    assert.match(denied.request.summary, /git push origin feature\/x/);
    assert.match(denied.request.preview, /"kind":"git_push"/);
    assert.equal(p.refs().includes('feature/x'), false, 'a "no" pushes nothing');
    assert.equal(gate.state().recent.at(-1).decision, 'denied');

    const approved = await outcome(gate, 'local.git_push', {}, { approve: true });
    assert.equal(approved.kind, 'prompt');
    assert.equal(approved.result.allowed, true);
    const pushed = await p.call({});
    assert.equal(pushed.isError, false, textOf(pushed));
    assert.equal(sh(p.bare, 'rev-parse', 'refs/heads/feature/x'), p.head(), 'a "yes" pushes what was shown');
    ok('Review: the card carries the remote, its address, local -> remote ref, the real commits (oldest first) and the diffstat; "no" pushes nothing, "yes" pushes it');
  }
  {
    const p = await project();
    for (const [label, configure] of [
      ['Autonomous', (gate) => gate.configure({ mode: 'autonomous' })],
      ['Full Access', (gate) => gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' })],
      ['Full Access, then Autonomous again', (gate) => { gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' }); gate.configure({ mode: 'autonomous' }); }],
    ]) {
      const gate = p.gate();
      configure(gate);
      const asked = await outcome(gate, 'local.git_push', {}, { approve: false });
      assert.equal(asked.kind, 'prompt', `${label} still asks`);
      assert.equal(asked.result.allowed, false, 'and "no" is honoured');
      assert.equal(asked.request.category, 'dangerous');
      assert.equal(asked.request.detail.kind, 'git_push');
    }
    const full = p.gate();
    full.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' });
    assert.equal(full.state().fullAccess, true);
    const yes = await outcome(full, 'local.git_push', {}, { approve: true });
    assert.equal(yes.result.allowed, true, 'an approval in Full Access is honoured');
    assert.equal(p.refs().includes('feature/x'), false, 'asking pushes nothing by itself');
    ok('Autonomous and Full Access cannot waive the question');
  }
  {
    const p = await project();
    const readonly = p.gate();
    readonly.configure({ mode: 'readonly' });
    assert.equal((await outcome(readonly, 'local.git_push', {})).kind, 'policy', 'Read Only refuses without asking');
    const full = p.gate();
    full.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' });
    full.configure({ mode: 'readonly' });
    assert.equal((await outcome(full, 'local.git_push', {})).kind, 'policy', 'Read Only wins over Full Access');
    const sandbox = p.gate();
    sandbox.configure({ mode: 'review', executionPolicy: 'sandbox-only' });
    const refused = await outcome(sandbox, 'local.git_push', {});
    assert.equal(refused.kind, 'policy', 'sandbox-only: the host Git would talk to the network, it is refused without asking');
    assert.match(refused.result.reason, /sandbox/i);
    for (const [label, configure] of [
      ['worker, Full Access', (gate) => { gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' }); gate.interactive = false; }],
      ['worker, Review', (gate) => { gate.configure({ mode: 'review' }); gate.interactive = false; }],
      ['background agent, Full Access', (gate) => { gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' }); gate.backgroundAgent = true; }],
      ['background agent, Autonomous', (gate) => { gate.configure({ mode: 'autonomous' }); gate.backgroundAgent = true; }],
    ]) {
      const gate = p.gate({ timeout: 10 * 60 * 1000 });
      configure(gate);
      const started = performance.now();
      const result = await outcome(gate, 'local.git_push', {});
      assert.equal(result.kind, 'policy', `${label}: nobody to ask, refused`);
      assert.ok(performance.now() - started < 3000, `${label}: at once, not after the approval timeout`);
      assert.equal(gate.state().pending.length, 0);
    }
    assert.equal(p.refs().includes('feature/x'), false);
    ok('Read Only and sandbox-only refuse without a question; a worker or a model-spawned agent with nobody to ask is refused at once');
  }
  {
    // a refusal is not a question, in any mode
    const p = await project();
    await commit(p, 'deploy.js', `const token = "${TOKEN}";\n`);
    for (const configure of [(gate) => gate.configure({ mode: 'review' }), (gate) => gate.configure({ mode: 'autonomous' }), (gate) => gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' })]) {
      const gate = p.gate();
      configure(gate);
      const result = await outcome(gate, 'local.git_push', {});
      assert.equal(result.kind, 'blocked', 'a push that holds a secret is refused, not asked');
      assert.match(result.result.reason, /github-token/);
      assert.ok(!result.result.reason.includes('Zx9Yw8Vu7T'));
      assert.equal(gate.state().pending.length, 0, 'nobody is asked to approve what cannot be pushed');
    }
    const q = await project();
    sh(q.work, 'checkout', '-q', 'main');
    await commit(q, 'm.txt');
    const full = q.gate();
    full.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' });
    assert.equal((await outcome(full, 'local.git_push', {})).kind, 'blocked', 'main is not asked about either');
    ok('a push that would be refused is refused without a question in Review, Autonomous and Full Access');
  }
  {
    // the name of the tool is on the list that Full Access never waives, whatever category the tool has
    const p = await project();
    const rated = { has: () => true, assess: async () => ({ category: 'execute', reason: 'x', summary: 'x' }) };
    const gate = p.gate();
    gate.attachLocalTools(rated);
    gate.configure({ mode: 'full-access', confirmation: 'FULL ACCESS' });
    const asked = await outcome(gate, 'local.git_push', {});
    assert.equal(asked.kind, 'prompt', 'even a tool wrongly rated execute asks in Full Access when it is git_push');
    const other = await outcome(gate, 'local.git_add', { paths: ['a.txt'] });
    assert.equal(other.kind, 'allow', '(and the same stand-in lets another tool through unasked, so the stand-in itself is not what asks)');
    ok('git_push is also on the list of names that Full Access never waives');
  }

  // ---------------------------------------------------------------- 4. credentials never show
  {
    const port = await closedPort();
    const secret = { user: 'deploy-user', password: PASSWORD };
    const registered = 'registered-token-value-123'; // a secret the Hub was told about, which turns up in a path
    const p = await project({ secrets: () => [registered] });
    p.manager.secrets.push(registered);
    sh(p.work, 'config', 'remote.origin.url', `http://${secret.user}:${secret.password}@127.0.0.1:${port}/${registered}/r.git`);
    const gate = p.gate();
    gate.configure({ mode: 'review' });
    const asked = await outcome(gate, 'local.git_push', {}, { approve: true });
    assert.equal(asked.kind, 'prompt');
    assert.equal(asked.request.detail.url, `http://[REDACTED]@127.0.0.1:${port}/[REDACTED]/r.git`, 'the address is shown without its credentials, nor a secret that the Hub knows');
    const shown = JSON.stringify({ request: asked.request, state: gate.state() });
    for (const leak of [PASSWORD, secret.user, registered]) assert.ok(!shown.includes(leak), `the card, the preview and the history do not hold "${leak}"`);
    const result = await p.call({});
    assert.equal(result.isError, true, 'nothing listens there');
    assert.ok(['push_failed', 'remote_unreachable'].includes(errorCode(result)), errorCode(result));
    const said = JSON.stringify(result);
    for (const leak of [PASSWORD, secret.user, registered]) assert.ok(!said.includes(leak), `the failure does not hold "${leak}": ${said}`);
    assert.ok(!/:\/\/(?!\[REDACTED\]@)[^\s/@'"]+@/.test(said), `an address in the failure carries no user part, or only the redacted one: ${said}`);
    assert.match(said, /Chưa đẩy gì|127\.0\.0\.1/, 'and it says what happened');
    assert.equal(p.refs().includes('feature/x'), false);
    ok('credentials in the remote address are hidden on the card, in the history and in the failure of a push that could not connect');
  }

  // ---------------------------------------------------------------- 5. stale plans, stop, timeout
  {
    const p = await project();
    const shown = await p.tools.assess('git_push', {});
    assert.equal(shown.detail.commitCount, 2);
    await commit(p);
    const before = p.refs();
    const stale = await p.call({});
    assert.equal(errorCode(stale), 'plan_changed', 'the branch moved after the question was prepared');
    assert.equal(p.refs(), before, 'what was not shown is not pushed');
    const again = await p.tools.assess('git_push', {});
    assert.equal(again.detail.commitCount, 3, 'a new question shows the new list');
    const done = await p.call({});
    assert.equal(done.isError, false, textOf(done));
    assert.equal(done.structuredContent.commits, 3);
    // what was shown to ONE task is what that task's call is held to: another task's question about the same branch does not move it
    const t = await project();
    const forA = await t.tools.assess('git_push', {}, { taskId: 'task-A' });
    assert.equal(forA.detail.commitCount, 2, 'task A was shown two commits');
    await commit(t);
    const forB = await t.tools.assess('git_push', {}, { taskId: 'task-B' });
    assert.equal(forB.detail.commitCount, 3, 'task B is shown three');
    const beforeA = t.refs();
    const staleA = await t.tools.call('git_push', {}, { taskId: 'task-A' });
    assert.equal(errorCode(staleA), 'plan_changed', 'task A\'s owner saw two commits: the question of task B does not change what A was shown');
    assert.equal(t.refs(), beforeA, 'so nothing was pushed for A');
    const forBagain = await t.tools.call('git_push', {}, { taskId: 'task-B' });
    assert.equal(forBagain.isError, false, textOf(forBagain));
    assert.equal(forBagain.structuredContent.commits, 3, 'and B pushes exactly what B was shown');
    // the gate hands the id of the task to the assessment (outcome() asks as task-1)
    const g = await project();
    const gate = g.gate();
    gate.configure({ mode: 'review' });
    const askedAsTask = await outcome(gate, 'local.git_push', {}, { approve: true });
    assert.equal(askedAsTask.result.allowed, true);
    await commit(g);
    const beforeG = g.refs();
    assert.equal(errorCode(await g.tools.call('git_push', {}, { taskId: 'task-1' })), 'plan_changed', 'the question that the gate asked for task-1 is remembered under task-1');
    assert.equal(g.refs(), beforeG);
    // the address is held to what was shown as well: another task may change the configuration between the question and the call
    const q = await project();
    const asked = await q.tools.assess('git_push', {});
    assert.equal(asked.category, 'dangerous');
    sh(q.work, 'config', 'remote.origin.url', `${slashes(q.bare)}-elsewhere`);
    const beforeRedirect = q.refs();
    const redirected = await q.call({});
    assert.equal(errorCode(redirected), 'plan_changed', 'the remote now points somewhere else than the card said');
    assert.match(textOf(redirected), /địa chỉ/, 'and the message says it is the address');
    assert.equal(q.refs(), beforeRedirect, 'nothing was pushed, there or here');
    ok('a branch that moved, or a remote whose address changed, after the question was prepared is not pushed until the new card was shown');
  }
  {
    // stop in the middle of a push: the remote has a hook that takes its time
    const p = await project();
    const hook = path.join(p.bare, 'hooks', 'pre-receive');
    await write(hook, '#!/bin/sh\ntouch hook-started\nsleep 25\n');
    await fs.chmod(hook, 0o755);
    const controller = new AbortController();
    const started = performance.now();
    const running = p.call({}, { signal: controller.signal });
    let seen = false;
    for (let i = 0; i < 300 && !seen; i += 1) { seen = await fs.stat(path.join(p.bare, 'hook-started')).then(() => true, () => false); if (!seen) await delay(50); }
    assert.ok(seen, 'the push reached the remote');
    controller.abort(new Error('stopped by the test'));
    await assert.rejects(running, /stopped by the test/, 'a stop rejects the call');
    assert.ok(performance.now() - started < 20_000, 'and does not wait for the remote');
    assert.equal(p.refs().includes('feature/x'), false, 'the branch was not created');
    const aborted = new AbortController();
    aborted.abort(new Error('already stopped'));
    await assert.rejects(p.call({}, { signal: aborted.signal }), /already stopped/);
    ok('a stop ends a push that is in progress (and a stop before it starts); the remote has nothing');
  }
  {
    const p = await project();
    const hook = path.join(p.bare, 'hooks', 'pre-receive');
    await write(hook, '#!/bin/sh\nsleep 25\n');
    await fs.chmod(hook, 0o755);
    const plan = await planPush(p.git, { remote: 'origin' });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const started = performance.now();
    const outcomeOfPush = await executePush(p.git, plan.plan, { timeoutMs: 700 });
    assert.equal(outcomeOfPush.ok, false);
    assert.equal(outcomeOfPush.code, 'push_timeout', 'a push that takes too long is ended');
    assert.ok(performance.now() - started < 20_000);
    assert.equal(p.refs().includes('feature/x'), false);
    ok('a push that takes longer than its timeout is ended with push_timeout');
  }
  {
    // a remote that declines the push says why, and nothing is forced around it
    const p = await project();
    const hook = path.join(p.bare, 'hooks', 'pre-receive');
    await write(hook, '#!/bin/sh\necho "policy: no thanks" >&2\nexit 1\n');
    await fs.chmod(hook, 0o755);
    const before = p.refs();
    const declined = await p.call({});
    assert.equal(errorCode(declined), 'push_rejected');
    assert.match(textOf(declined), /policy: no thanks/, 'what the remote said is passed on');
    assert.match(textOf(declined), /không ép/, 'and the model is told that there is no way around it');
    assert.equal(p.refs(), before, 'the remote has nothing');
    ok('a push that the remote declines is push_rejected, with the remote\'s own words');
  }
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 400 }).catch(() => console.warn(`  (could not remove ${root})`));
}

console.log(`PASS: ${checks} git_push checks${isWindows ? ' (Windows)' : ''}`);
process.exit(0);
