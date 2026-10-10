// What a shell command and a repository can do that their text does not show.
//
//   - lib/git-trust.mjs    reads a repository's own configuration and hooks: which settings would run a program, and for which
//                          Git commands. The Hub's Git tools refuse what they cannot switch off; a shell `git status` or
//                          `git commit` that would run the repository's program is put in front of the person.
//   - lib/command-paths.mjs follows the words of a command to where they really land (symlink, junction, alias of a secret),
//                          so `cat notes.txt` is not "read-only" when notes.txt is a link to ~/.ssh/id_rsa.
//
// The traps below are real: a positive control first proves that, on this machine, plain Git does run the planted program.
// A trap that cannot fire here is reported as "inconclusive" instead of passing the check for the wrong reason.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeProblem, pathProblems } from '../lib/command-paths.mjs';
import { gitRisksFor, gitSubcommand, inspectGitSafety, parseGitConfig, refusalsForRunner } from '../lib/git-trust.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const note = (label) => console.log(`  note - ${label}`);
const textOf = (result) => result.content.map((part) => part.text).join('\n');
setTimeout(() => { console.error('FAIL: the shell-guards suite exceeded its own time budget'); process.exit(2); }, 120_000).unref();

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-guards-'));
const home = path.join(root, 'home');
await fs.mkdir(home);
await fs.writeFile(path.join(home, 'empty.gitconfig'), '');
// Git behaves the same on every machine: no global or system configuration, no inherited GIT_* settings.
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))), HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let haveGit = true;
try { git(root, '--version'); } catch { haveGit = false; }
if (!haveGit) { console.log('CHATMCP_TEST_SKIP: git is not installed'); process.exit(0); }
const cleanup = () => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }).catch(() => {});
process.on('exit', () => { try { fsSync.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

// ----------------------------------------------------------------------------------------------------------------
// 1. The parser
// ----------------------------------------------------------------------------------------------------------------
{
  const entries = parseGitConfig([
    '# a comment', '; another', '[core]', '\trepositoryformatversion = 0', '\tFSMonitor = "node pwn.js \\"x\\"" ; trailing comment',
    '\tbare', '[remote "Origin"]', '\turl = https://example.invalid/a.git', '[branch.main]', '  remote = origin', '[user] name = A B',
    '[alias]', '\tlong = log \\', '\t  --oneline', '[filter "lfs"]', '\tclean = git-lfs clean -- %f', 'garbage line without structure', '',
  ].join('\r\n'));
  const find = (section, subsection, key) => entries.find((entry) => entry.section === section && entry.subsection === subsection && entry.key === key);
  assert.equal(find('core', null, 'repositoryformatversion').value, '0');
  assert.equal(find('core', null, 'fsmonitor').value, 'node pwn.js "x"', 'keys are case-insensitive; quotes and escapes are resolved; a trailing comment is dropped');
  assert.equal(find('core', null, 'bare').value, null, 'a key without "=" is a boolean');
  assert.equal(find('remote', 'Origin', 'url').value, 'https://example.invalid/a.git', 'a quoted subsection keeps its spelling');
  assert.equal(find('branch', 'main', 'remote').value, 'origin', 'the old [section.subsection] spelling');
  assert.equal(find('user', null, 'name').value, 'A B', 'a key on the same line as its section header');
  assert.match(find('alias', null, 'long').value, /^log\s+--oneline$/, 'a trailing backslash continues the value on the next line');
  assert.equal(find('filter', 'lfs', 'clean').value, 'git-lfs clean -- %f');
  assert.equal(parseGitConfig('').length, 0);
  assert.equal(parseGitConfig('[unterminated\nkey = value').length, 0, 'a broken header does not attach later keys to the wrong section');
  ok('parseGitConfig: sections, subsections, quoting, comments, continuation, same-line keys, junk tolerated');
}

// ----------------------------------------------------------------------------------------------------------------
// 2. Which settings count, and what they do to which command
// ----------------------------------------------------------------------------------------------------------------
const riskOf = async (configText, { hooks = [] } = {}) => {
  const repo = await fs.mkdtemp(path.join(root, 'cfg-'));
  await fs.mkdir(path.join(repo, '.git', 'hooks'), { recursive: true });
  await fs.writeFile(path.join(repo, '.git', 'config'), configText);
  for (const hook of hooks) await fs.writeFile(path.join(repo, '.git', 'hooks', hook), '#!/bin/sh\n');
  return inspectGitSafety(repo);
};
{
  const none = async (text) => assert.deepEqual((await riskOf(text)).risks, [], text);
  await none('[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n[remote "origin"]\n\turl = https://example.invalid/a.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n[user]\n\tname = X\n\temail = x@example.invalid\n');
  await none('[core]\n\tfsmonitor = false\n');
  await none('[core]\n\tfsmonitor = true\n');
  await none('[core]\n\tfsmonitor =\n');
  await none('[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n');
  await none('[filter "lfs"]\n\tsmudge = git-lfs smudge --skip -- %f\n\tprocess = git-lfs filter-process --skip\n');
  await none('[alias]\n\tco = !echo hello\n[difftool "x"]\n\tcmd = meld\n');
  ok('inspectGitSafety: ordinary configuration, Git LFS and boolean fsmonitor values are not risks');

  const one = async (text, expected) => {
    const { risks } = await riskOf(text);
    assert.equal(risks.length, 1, `${text.trim()} -> ${JSON.stringify(risks)}`);
    assert.deepEqual({ kind: risks[0].kind, affects: risks[0].affects, runner: risks[0].runner }, expected, text.trim());
    return risks[0].key;
  };
  assert.equal(await one('[core]\n\tfsmonitor = node pwn.js\n', { kind: 'fsmonitor', affects: 'all', runner: 'neutralized' }), 'core.fsmonitor');
  assert.equal(await one('[core]\n\thooksPath = .githooks\n', { kind: 'hooks', affects: 'hooks', runner: 'neutralized' }), 'core.hookspath');
  assert.equal(await one('[core]\n\tpager = evil\n', { kind: 'program', affects: 'all', runner: 'neutralized' }), 'core.pager');
  assert.equal(await one('[diff]\n\texternal = evil\n', { kind: 'program', affects: 'all', runner: 'neutralized' }), 'diff.external');
  assert.equal(await one('[core]\n\tworktree = ../..\n', { kind: 'worktree', affects: 'all', runner: 'ignore' }), 'core.worktree');
  assert.equal(await one('[filter "pwn"]\n\tclean = node pwn.js\n', { kind: 'filter', affects: 'all', runner: 'refuse' }), 'filter.pwn.clean');
  assert.equal(await one('[filter "lfs"]\n\tclean = node pwn.js\n', { kind: 'filter', affects: 'all', runner: 'refuse' }), 'filter.lfs.clean', 'a filter only called "lfs" is not Git LFS');
  assert.equal(await one('[diff "word"]\n\ttextconv = antiword\n', { kind: 'diff-driver', affects: 'all', runner: 'refuse' }), 'diff.word.textconv');
  assert.equal(await one('[merge "x"]\n\tdriver = evil %A\n', { kind: 'merge-driver', affects: 'all', runner: 'refuse' }), 'merge.x.driver');
  assert.equal(await one('[gpg]\n\tprogram = evil\n', { kind: 'gpg', affects: 'all', runner: 'refuse' }), 'gpg.program');
  assert.equal(await one('[gpg "ssh"]\n\tprogram = evil\n', { kind: 'gpg', affects: 'all', runner: 'refuse' }), 'gpg.ssh.program');
  assert.equal(await one('[include]\n\tpath = ../elsewhere.cfg\n', { kind: 'include', affects: 'all', runner: 'refuse' }), 'include.path');
  assert.equal(await one('[includeIf "gitdir:~/work/"]\n\tpath = work.cfg\n', { kind: 'include', affects: 'all', runner: 'refuse' }), 'includeif.gitdir:~/work/.path');
  assert.equal(await one('[credential]\n\thelper = !f() { echo x; }; f\n', { kind: 'credential-helper', affects: 'network', runner: 'ignore' }), 'credential.helper');
  assert.equal(await one('[core]\n\tsshCommand = evil\n', { kind: 'program', affects: 'network', runner: 'ignore' }), 'core.sshcommand');
  assert.equal(await one('[remote "o"]\n\tvcs = evil\n', { kind: 'program', affects: 'network', runner: 'ignore' }), 'remote.o.vcs');
  ok('inspectGitSafety: every setting that names a program is found, with what the Hub\'s own tools do about it');

  const secretish = await riskOf('[core]\n\tfsmonitor = node pwn.js hunter2-secret-value\n[credential]\n\thelper = store --file=/home/u/token-9f8e7d\n');
  assert.ok(!JSON.stringify(secretish).includes('hunter2') && !JSON.stringify(secretish).includes('token-9f8e7d'), 'only the names of the settings are reported, never their values');
  const dup = await riskOf('[core]\n\tfsmonitor = a\n[core]\n\tfsmonitor = b\n');
  assert.equal(dup.risks.length, 1, 'a setting that appears twice is listed once');
  ok('inspectGitSafety: values are never returned (they can hold credentials); duplicates collapse');
}
{
  const safety = await riskOf('[core]\n\tfsmonitor = x\n\thooksPath = h\n[credential]\n\thelper = y\n[filter "p"]\n\tclean = z\n', { hooks: ['pre-commit', 'commit-msg'] });
  const names = (sub) => gitRisksFor(sub, safety);
  assert.deepEqual(names('status').sort(), ['core.fsmonitor', 'filter.p.clean'], 'status runs the fsmonitor and may run a clean filter; hooks and credential helpers are not involved');
  assert.ok(names('commit').includes('core.hookspath') && names('commit').includes('hooks/pre-commit') && names('commit').includes('hooks/commit-msg'));
  assert.ok(!names('commit').includes('credential.helper'));
  assert.ok(names('push').includes('credential.helper') && names('push').includes('hooks/pre-commit'));
  assert.ok(names('fetch').includes('credential.helper'));
  assert.deepEqual(gitRisksFor('--version', safety), [], 'git --version reads no configuration');
  assert.deepEqual(gitRisksFor('status', { repository: false, risks: [], hooks: [] }), [], 'outside a repository nothing is at risk');
  assert.deepEqual(gitRisksFor('status', await riskOf('[core]\n\trepositoryformatversion = 0\n', { hooks: ['pre-commit.sample'] })), [], 'a .sample hook is inert');
  assert.deepEqual(refusalsForRunner(safety), ['filter.p.clean'], 'the Hub\'s Git tools stop only for what they cannot switch off themselves');
  assert.equal(gitSubcommand(['status']), 'status');
  assert.equal(gitSubcommand(['--no-pager', 'LOG', '-p']), 'log');
  assert.equal(gitSubcommand([]), '');
  assert.equal(gitSubcommand(['--version']), '--version');
  ok('gitRisksFor: a setting counts only for the Git commands it can affect (status vs commit vs push)');
}
{
  // `.git` can be a file pointing at the real directory (worktrees, submodules); the configuration lives there.
  const main = await fs.mkdtemp(path.join(root, 'wt-main-'));
  const gitDir = path.join(main, '.git');
  await fs.mkdir(path.join(gitDir, 'worktrees', 'w1'), { recursive: true });
  await fs.writeFile(path.join(gitDir, 'config'), '[core]\n\tfsmonitor = node pwn.js\n');
  await fs.writeFile(path.join(gitDir, 'worktrees', 'w1', 'commondir'), '../..\n');
  const tree = await fs.mkdtemp(path.join(root, 'wt-tree-'));
  await fs.writeFile(path.join(tree, '.git'), `gitdir: ${path.join(gitDir, 'worktrees', 'w1')}\n`);
  assert.deepEqual((await inspectGitSafety(tree)).risks.map((risk) => risk.key), ['core.fsmonitor'], 'a worktree uses the configuration of its common directory');
  assert.deepEqual(await inspectGitSafety(await fs.mkdtemp(path.join(root, 'plain-'))), { repository: false, risks: [], hooks: [], unreadable: false });
  const broken = await fs.mkdtemp(path.join(root, 'broken-'));
  await fs.writeFile(path.join(broken, '.git'), 'not a pointer\n');
  const unreadable = await inspectGitSafety(broken);
  assert.equal(unreadable.unreadable, true);
  assert.ok(gitRisksFor('status', unreadable).length > 0, 'a repository whose configuration cannot be read is not assumed safe');
  ok('inspectGitSafety: worktree pointers, no repository, an unreadable pointer (treated as not safe)');
}

// ----------------------------------------------------------------------------------------------------------------
// 3. Where the words of a command really point
// ----------------------------------------------------------------------------------------------------------------
const work = path.join(root, 'work');
const outside = path.join(root, 'outside');
await fs.mkdir(path.join(work, 'sub'), { recursive: true });
await fs.mkdir(outside);
await fs.writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n');
await fs.writeFile(path.join(work, 'ok.txt'), 'fine\n');
await fs.writeFile(path.join(work, '.env'), 'API_KEY=zzz-secret-value\n');
const tryLink = async (target, link, type) => { try { await fs.symlink(target, link, type); return true; } catch (error) { if (['EPERM', 'EACCES', 'ENOSYS', 'EINVAL'].includes(error.code)) return false; throw error; } };
const links = {
  file: await tryLink(path.join(outside, 'secret.txt'), path.join(work, 'link-file'), 'file'),
  directory: await tryLink(outside, path.join(work, 'link-dir'), process.platform === 'win32' ? 'junction' : 'dir'),
  alias: await tryLink(path.join(work, '.env'), path.join(work, 'alias-env'), 'file'),
  loopA: await tryLink(path.join(work, 'loop-b'), path.join(work, 'loop-a'), 'file'),
};
if (links.loopA) await tryLink(path.join(work, 'loop-a'), path.join(work, 'loop-b'), 'file');
const probe = (segments) => pathProblems({ segments, cwd: work, root: work });
const seg = (args, redirects = []) => ({ args, redirects });
{
  assert.deepEqual(await probe([seg(['ok.txt']), seg(['sub/new.txt']), seg(['status']), seg(['-n', '5']), seg(['--output=x']), seg(['https://example.invalid/a'])]), [], 'ordinary words, new files, options and URLs are fine');
  assert.deepEqual(await probe([seg(['../outside/secret.txt'])]), [{ word: '../outside/secret.txt', problem: 'outside' }], 'a plain ../ is caught here too');
  if (links.file) assert.deepEqual(await probe([seg(['link-file'])]), [{ word: 'link-file', problem: 'outside' }]);
  else note('file symlinks cannot be created on this machine; that check was skipped');
  if (links.directory) {
    assert.deepEqual((await probe([seg(['link-dir/secret.txt'])])).map((item) => item.problem), ['outside'], 'a file reached through a linked folder');
    assert.deepEqual((await probe([seg(['cat'], [{ op: '>', target: 'link-dir/new.txt' }])])).map((item) => item.problem), ['outside'], 'a redirect that writes through a linked folder, to a file that does not exist yet');
  } else note('directory links cannot be created on this machine; that check was skipped');
  if (links.alias) assert.deepEqual(await probe([seg(['alias-env'])]), [{ word: 'alias-env', problem: 'protected' }], 'an innocent name that is really .env');
  if (links.loopA) assert.deepEqual((await probe([seg(['loop-a'])])).map((item) => item.problem), ['unresolvable'], 'a link loop is not assumed harmless');
  assert.match(describeProblem({ word: 'link-file', problem: 'outside' }), /ngoài workspace/);
  assert.match(describeProblem({ word: 'alias-env', problem: 'protected' }), /bí mật/);
  ok(`pathProblems: ${Object.values(links).filter(Boolean).length} kinds of link followed to their real place; ordinary words, options, URLs and new files pass`);
}
{
  // PowerShell "drives" are not folders: Env: holds the environment variables (API keys), HKCU:/HKLM: the registry, Cert: the certificates.
  const shell = (words) => pathProblems({ segments: [seg(words)], cwd: work, root: work, powershell: true });
  const providerWords = ['Env:', 'env:OPENAI_API_KEY', 'Env:\\PATH', 'HKCU:\\Software', 'HKLM:\\SOFTWARE', 'Cert:\\CurrentUser\\My', 'Variable:', 'Function:', 'Alias:', 'WSMan:',
    'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE', 'Microsoft.PowerShell.Core\\FileSystem::C:\\Users\\me\\.ssh\\id_rsa', 'FileSystem::/etc/passwd', '-Path:Env:FOO', '-LiteralPath:HKCU:\\x'];
  for (const word of providerWords) assert.deepEqual((await shell([word])).map((item) => item.problem), ['provider'], `${word} is a provider path`);
  for (const word of ['fix: a thing', 'feat(parser): add', 'localhost:3000', 'ok.txt', 'Temperature: high', '-Path', '-Recurse']) assert.deepEqual(await shell([word]), [], `${word} is not`);
  // One letter and a colon is ordinary text to a POSIX shell, but on Windows it is a drive (drive A:, relative path "b"), which can lead
  // anywhere and may not even exist: there it is not assumed harmless, and the command is put to the person.
  if (process.platform === 'win32') assert.ok((await shell(['a:b'])).length > 0, 'a:b is a drive-relative path on Windows, so it is not assumed harmless');
  else assert.deepEqual(await shell(['a:b']), [], 'a:b is not');
  assert.deepEqual(await probe([seg(['Env:OPENAI_API_KEY'])]), [], 'the same word means nothing special to a POSIX shell');
  assert.match(describeProblem({ word: 'Env:', problem: 'provider' }), /PowerShell/);
  ok('pathProblems: PowerShell provider drives (Env:, registry, certificates, FileSystem::) are flagged for PowerShell only, and ordinary colons are not');
}

// ----------------------------------------------------------------------------------------------------------------
// 4. The permission check and the Git tools, end to end on real folders
// ----------------------------------------------------------------------------------------------------------------
const stateDir = path.join(root, 'state');
await fs.mkdir(stateDir);
const workspace = new StudioWorkspace({ manager: { workspace: work }, directory: stateDir });
const tools = new LocalTools({ workspace, stateDirectory: stateDir });
const category = async (command, extra = {}) => (await tools.assess('run_command', { command, ...extra }));
{
  assert.equal((await category('cat ok.txt')).category, 'read');
  assert.equal((await category('ls sub')).category, 'read');
  if (links.file) {
    const verdict = await category('cat link-file');
    assert.equal(verdict.category, 'execute', 'a "read-only" command on a link to a file outside the project asks first');
    assert.match(verdict.reason, /ngoài dự án hoặc tới file bí mật/);
    assert.equal(verdict.risk.kind, 'exec');
  }
  if (links.directory) {
    assert.equal((await category('ls link-dir')).category, 'execute');
    assert.equal((await category('echo hacked > link-dir/new.txt')).category, 'execute', 'an "edit" that writes through a linked folder asks first');
    assert.equal((await category('cat < link-dir/secret.txt')).category, 'execute');
  }
  if (links.alias) assert.equal((await category('cat alias-env')).category, 'execute');
  assert.equal((await category('echo done > sub/out.txt')).category, 'workspace_edit', 'a plain write inside the project is still an ordinary edit');
  assert.equal((await category('node ok.txt', { cwd: 'sub' })).category !== 'blocked', true);
  ok('assess: the permission category follows the real location of a command\'s paths (symlink, linked folder, alias of .env)');
}
{
  // What can print an environment variable or a registry value without naming a file is asked about like any other secret read.
  const ask = async (command, shell) => (await category(command, { shell })).category;
  for (const command of ['Get-Content Env:OPENAI_API_KEY', "Get-Content 'Env:OPENAI_API_KEY'", 'Get-Content -Path:Env:OPENAI_API_KEY', 'Get-ChildItem Env:', 'Get-ChildItem -Path Env:', 'gci env:', 'dir env:', 'ls Env:',
    'Get-Item Env:PATH', 'Get-ChildItem HKCU:\\Software', 'Get-ChildItem Cert:\\CurrentUser\\My', 'Get-ChildItem Variable:', 'Get-Content FileSystem::C:\\x']) {
    assert.equal(await ask(command, 'powershell'), 'execute', `${command} asks first`);
  }
  for (const command of ['Get-Content ok.txt', 'Get-ChildItem', 'Get-ChildItem sub', 'git log --oneline', 'Get-Process']) assert.equal(await ask(command, 'powershell'), 'read', `${command} stays a read`);
  assert.equal(await ask('git commit -m "fix: a thing"', 'powershell'), await ask('git commit -m "a thing"', 'powershell'), 'the colon in a commit message changes nothing');
  // BSD-style `ps e` prints every process's environment; plain listings of processes stay reads.
  for (const command of ['ps e', 'ps auxe', 'ps axe', 'ps eww -p 1']) assert.equal(await ask(command, 'bash'), 'execute', `${command} asks first`);
  for (const command of ['ps', 'ps aux', 'ps -ef', 'ps -e', 'ps -p 1']) assert.equal(await ask(command, 'bash'), 'read', `${command} stays a read`);
  ok('assess: reading environment variables or the registry through PowerShell drives, and `ps e`, asks first; ordinary listings stay reads');
}

// A repository with the traps: a program in core.fsmonitor, a pre-commit hook, and (second repository) a clean filter.
const PWN = "require('fs').writeFileSync('PWNED-' + (process.argv[2] || 'unknown'), 'ran\\n');\n";
async function trapRepository(name, config, { hook = false, attributes = '', files = {} } = {}) {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, 'pwn.js'), PWN);
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.invalid');
  if (attributes) await fs.writeFile(path.join(repo, '.gitattributes'), attributes);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  // The traps go in last and by hand, the way a downloaded folder carries them; git itself never wrote them.
  await fs.appendFile(path.join(repo, '.git', 'config'), config);
  if (hook) await fs.writeFile(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnode pwn.js pre-commit\n', { mode: 0o755 });
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(repo, file), content);
  return repo;
}
const fired = (repo, which) => fsSync.existsSync(path.join(repo, `PWNED-${which}`));
const clear = (repo) => { for (const entry of fsSync.readdirSync(repo)) if (entry.startsWith('PWNED-')) fsSync.rmSync(path.join(repo, entry)); };
const rawGit = (repo, ...args) => spawnSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8' });
{
  const repo = await trapRepository('trap-a', '[core]\n\tfsmonitor = node pwn.js fsmonitor\n', { hook: true });
  // Positive controls: on this machine, plain Git really does run both programs.
  rawGit(repo, 'status');
  const fsmonitorLive = fired(repo, 'fsmonitor');
  clear(repo);
  await fs.writeFile(path.join(repo, 'b.txt'), 'b\n');
  rawGit(repo, 'add', 'b.txt');
  rawGit(repo, 'commit', '-q', '-m', 'control');
  const hookLive = fired(repo, 'pre-commit');
  clear(repo);
  if (!fsmonitorLive) note('inconclusive: plain `git status` did not run core.fsmonitor on this Git, so that trap cannot show anything here');
  if (!hookLive) note('inconclusive: plain `git commit` did not run the pre-commit hook on this machine');
  else ok('control: plain git runs the planted fsmonitor program and the pre-commit hook (so the checks below can fail)');

  const ws = new StudioWorkspace({ manager: { workspace: repo }, directory: path.join(root, 'state-a') });
  const lt = new LocalTools({ workspace: ws, stateDirectory: path.join(root, 'state-a') });
  const verdict = (command) => lt.assess('run_command', { command });
  for (const command of ['git status', 'git diff', 'git log --oneline', 'git ls-files', 'git add . && git status']) {
    const result = await verdict(command);
    assert.equal(result.category, 'execute', `${command} asks when the repository names a program (${result.reason})`);
    assert.match(result.reason, /core\.fsmonitor/);
  }
  const commit = await verdict('git commit -m x');
  assert.equal(commit.category, 'execute');
  assert.match(commit.reason, /hooks\/pre-commit/);
  assert.equal((await verdict('git --version')).category, 'read', 'a command that reads no configuration is not slowed down');
  assert.equal((await verdict('ls')).category, 'read', 'other programs are unaffected');
  assert.equal((await lt.assess('git_status', {})).category, 'read', 'the Hub\'s own Git tools stay read-only: they switch the programs off themselves');

  // The Hub's own Git tools: the fsmonitor program and the hook do not run, and the tools still work.
  const status = await lt.call('git_status', {});
  assert.equal(status.isError, false, textOf(status));
  const added = await lt.call('git_add', { paths: ['a.txt'] });
  assert.equal(added.isError, false, textOf(added));
  await fs.writeFile(path.join(repo, 'a.txt'), 'changed\n');
  assert.equal((await lt.call('git_add', { paths: ['a.txt'] })).isError, false);
  const committed = await lt.call('git_commit', { message: 'through the Hub' });
  assert.equal(committed.isError, false, textOf(committed));
  assert.equal(fired(repo, 'fsmonitor'), false, 'git_status/git_add/git_commit did not run the fsmonitor program');
  assert.equal(fired(repo, 'pre-commit'), false, 'git_commit did not run the repository hook');
  ok('shell git in a repository with an fsmonitor program and a hook asks; the Hub\'s own git tools work and run neither');

  // The same repository without the traps costs nothing.
  const quiet = await trapRepository('quiet', '');
  const qws = new StudioWorkspace({ manager: { workspace: quiet }, directory: path.join(root, 'state-q') });
  const qlt = new LocalTools({ workspace: qws, stateDirectory: path.join(root, 'state-q') });
  for (const [command, expected] of [['git status', 'read'], ['git diff', 'read'], ['git log', 'read'], ['git add . && git commit -m x', 'workspace_edit']]) {
    assert.equal((await qlt.assess('run_command', { command })).category, expected, command);
  }
  ok('a repository without such settings keeps git status/diff/log as reads and add/commit as edits');
}
{
  const repo = await trapRepository('trap-b', '[filter "pwn"]\n\tclean = node pwn.js filter-clean\n', { attributes: '*.pwn filter=pwn\n', files: { 'x.pwn': 'content\n' } });
  rawGit(repo, 'add', 'x.pwn');
  const filterLive = fired(repo, 'filter-clean');
  clear(repo);
  rawGit(repo, 'reset', '-q');
  if (!filterLive) note('inconclusive: plain `git add` did not run the clean filter on this machine');
  const ws = new StudioWorkspace({ manager: { workspace: repo }, directory: path.join(root, 'state-b') });
  const lt = new LocalTools({ workspace: ws, stateDirectory: path.join(root, 'state-b') });
  for (const [tool, args] of [['git_status', {}], ['git_diff', {}], ['git_log', {}], ['git_add', { paths: ['x.pwn'] }], ['git_branch', { action: 'list' }]]) {
    const result = await lt.call(tool, args);
    assert.equal(result.isError, true, `${tool} refuses to run`);
    assert.equal(result.structuredContent?.error?.code, 'git_config_untrusted', tool);
    assert.match(textOf(result), /filter\.pwn\.clean/);
    assert.ok(!textOf(result).includes('node pwn.js'), 'the refusal names the setting, not its value');
  }
  assert.equal(fired(repo, 'filter-clean'), false, 'no Git tool ran the clean filter');
  assert.equal((await lt.assess('run_command', { command: 'git add x.pwn' })).category, 'execute', 'the shell route asks as well');
  if (filterLive) ok('control + guard: plain git runs a clean filter from .git/config; the Hub\'s git tools refuse and the shell route asks');
  else ok('guard: the Hub\'s git tools refuse a repository whose configuration names a clean filter, and the shell route asks');
}

await cleanup();
console.log(`PASS: ${checks} shell-guard checks (Git configuration and hooks, links followed to their real place, PowerShell drives, permission categories, Git tools)`);
