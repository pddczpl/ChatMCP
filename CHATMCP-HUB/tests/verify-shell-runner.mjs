// Behavioural tests for ShellRunner against real shells: bash/sh wherever they exist and
// Windows PowerShell where it is installed. Covers quoting, exit codes, timeouts that must
// take grandchildren down with them, cancellation, bounded output and environment scrubbing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { delay, exists } from '../lib/runtime.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { BoundedCapture, ShellRunner, decodeClixml, scrubEnv, wrapPowerShell } from '../lib/shell-runner.mjs';

const isWindows = process.platform === 'win32';
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const nl = (text) => text.replace(/\r\n/g, '\n');
const rejects = (promise, code, label) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code, `${label}: got ${error.code} (${error.message})`);
  return true;
}, label);
const samePath = async (a, b) => {
  const [x, y] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  return isWindows ? x.toLowerCase() === y.toLowerCase() : x === y;
};
setTimeout(() => { console.error('FAIL: the shell-runner suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

// ------------------------------------------------------------------ pure helpers
{
  const env = {
    PATH: '/bin', HOME: '/home/x', OPENAI_API_KEY: 'sk-abc', GITHUB_TOKEN: 'ghp_x', NPM_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's',
    DB_PASSWORD: 'p', SSH_AUTH_SOCK: '/tmp/agent', GIT_AUTHOR_NAME: 'Ann', AUTHOR: 'me', DATABASE_URL: 'postgres://user:pass@db/x',
    PLAIN_URL: 'https://example.com/x', LEAK: 'prefix-my-registered-secret-suffix', KEEP_ME: 'yes', UNSET: undefined,
  };
  const clean = scrubEnv(env, { secrets: ['my-registered-secret', 'abc'] });
  assert.deepEqual(Object.keys(clean).sort(), ['AUTHOR', 'GIT_AUTHOR_NAME', 'HOME', 'KEEP_ME', 'PATH', 'PLAIN_URL', 'SSH_AUTH_SOCK']);
  assert.deepEqual(Object.keys(scrubEnv({ FOO_TOKEN: 'x', BAR_TOKEN: 'y' }, { keep: ['foo_token'] })), ['FOO_TOKEN']);
  ok('scrubEnv drops credential variables, URLs with passwords and registered secrets, keeps ordinary ones');
}
{
  // Names that say "credential" without an underscore in front of the word, or with a plain KEY, were slipping through.
  const credentials = ['PGPASSWORD', 'MYSQL_PWD', 'SIGNING_KEY', 'ENCRYPTION_KEY', 'STRIPE_KEY', 'KEY', 'HF_TOKEN', 'GHTOKEN', 'DJANGO_SECRET_KEY', 'SENTRY_AUTH_TOKEN', 'AWS_SESSION_TOKEN', 'clientsecret'];
  // ...while ordinary variables that merely contain such letters must stay (PWD is the working directory).
  const ordinary = ['PATH', 'HOME', 'PWD', 'OLDPWD', 'TERM', 'NODE_ENV', 'LANG', 'LESSKEY', 'KEYBOARD_LAYOUT', 'TOKENIZERS_PARALLELISM', 'AUTHOR', 'GIT_AUTHOR_EMAIL', 'SESSIONNAME', 'PYTHONPATH', 'VIRTUAL_ENV', 'MONKEY'];
  const clean = scrubEnv(Object.fromEntries([...credentials, ...ordinary].map((name) => [name, 'plain value'])));
  assert.deepEqual(Object.keys(clean).sort(), [...ordinary].sort(), `scrubbed or kept the wrong names: ${Object.keys(clean).join(',')}`);
  const urls = scrubEnv({ REDIS_URL: 'redis://:hunter2hunter2@cache.example:6379/0', DB_URL: 'postgres://app@db.example/x', API_BASE: 'https://api.example.com/v1', PROXY_URL: 'http://user:pw@proxy:8080' });
  assert.deepEqual(Object.keys(urls).sort(), ['API_BASE', 'DB_URL'], 'a URL with a password is dropped even when the user part is empty; a URL without a password stays');
  ok('scrubEnv also drops PGPASSWORD, MYSQL_PWD, plain *_KEY names and redis://:password@host, and keeps PWD, LESSKEY, KEYBOARD_LAYOUT, TOKENIZERS_PARALLELISM, AUTHOR');
}
{
  // CI systems and proxies hand Git a credential as GIT_CONFIG_COUNT + GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> (http.extraheader = "AUTHORIZATION: basic ...").
  // The VALUE half has no secret-looking name, so the whole family goes; keeping COUNT alone makes Git fail with "missing config key".
  const family = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0', GIT_CONFIG_PARAMETERS: "'x.y=z'" };
  const kept = scrubEnv({ ...family, GIT_CONFIG_GLOBAL: '/tmp/empty', GIT_AUTHOR_NAME: 'a', PATH: '/usr/bin' });
  assert.deepEqual(Object.keys(kept).sort(), ['GIT_AUTHOR_NAME', 'GIT_CONFIG_GLOBAL', 'PATH'], `the GIT_CONFIG_* family must go as a whole: ${Object.keys(kept).join(',')}`);
  assert.ok(!JSON.stringify(kept).includes('eC1hY2Nlc3Mt'), 'the credential carried in GIT_CONFIG_VALUE_0 must not survive');
  ok('scrubEnv drops the GIT_CONFIG_COUNT/KEY_n/VALUE_n/PARAMETERS family (credentials travel there) but keeps GIT_CONFIG_GLOBAL');
}
{
  const small = new BoundedCapture(1000);
  small.push(Buffer.from('hello '));
  small.push(Buffer.from('world'));
  assert.deepEqual(small.result(), { text: 'hello world', truncated: false, omitted: 0, totalBytes: 11 });
  const big = new BoundedCapture(1000);
  for (let i = 0; i < 500; i += 1) big.push(Buffer.from(`line-${String(i).padStart(4, '0')}\n`));
  const result = big.result();
  assert.equal(result.truncated, true);
  assert.equal(result.totalBytes, 5000);
  assert.equal(result.omitted, 4000);
  assert.ok(result.text.startsWith('line-0000\n'));
  assert.ok(result.text.trimEnd().endsWith('line-0499'));
  assert.match(result.text, /đã lược 4000 byte/);
  assert.ok(Buffer.byteLength(result.text) < 1100);
  ok('BoundedCapture keeps head and tail and counts omitted bytes');
}
{
  const sample = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">boom _x000D__x000A_</S><S S="Error">at &lt;ScriptBlock&gt;_x000D__x000A_</S></Objs>';
  assert.equal(decodeClixml(sample), 'boom \nat <ScriptBlock>');
  assert.equal(decodeClixml('plain text'), 'plain text');
  const script = wrapPowerShell('Get-Date');
  assert.ok(script.includes('Get-Date\n$__chatmcp_ok = $?'));
  assert.ok(script.trimEnd().endsWith('exit 0'));
  ok('decodeClixml and wrapPowerShell');
}

// ------------------------------------------------------------------ fixture
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-shell-test-'));
const workspaceDir = path.join(root, 'work');
const stateDir = path.join(root, 'state');
await fs.mkdir(path.join(workspaceDir, 'sub'), { recursive: true });
await fs.mkdir(stateDir, { recursive: true });
await fs.writeFile(path.join(workspaceDir, 'file.txt'), 'x');
const workspace = new StudioWorkspace({ manager: { workspace: workspaceDir }, directory: stateDir });
process.env.CHATMCP_TEST_SECRET_TOKEN = 'zz-secret-value-123';
process.env.CHATMCP_TEST_PLAIN = 'visible';

async function cleanup() {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 400 }).catch((error) => console.warn(`  (could not remove ${root}: ${error.code})`));
}

const runner = new ShellRunner({ workspace, stateDirectory: stateDir });
const info = await runner.info();
const names = ['bash', 'sh', 'powershell'].filter((name) => info.shells[name]);
if (!names.length) {
  console.log('CHATMCP_TEST_SKIP: no usable shell (bash, sh or PowerShell) on this machine');
  await cleanup();
  process.exit(0);
}
if (info.shells.bash) assert.doesNotMatch(info.shells.bash, /[\\/]system32[\\/]/i, 'the WSL launcher must never be used as bash');
assert.ok(['bash', 'sh', 'powershell'].includes(info.defaultShell));
if (isWindows && info.shells.bash) assert.equal(info.defaultShell, 'bash', 'Git Bash is preferred over PowerShell on Windows');
ok(`shell discovery: default=${info.defaultShell}, available=${names.join(',')}`);
if (!info.shells.powershell) console.warn('  SKIPPED PowerShell checks: no PowerShell on this machine');
if (!info.shells.bash && !info.shells.sh) console.warn('  SKIPPED bash/sh checks: no POSIX shell on this machine');

// ------------------------------------------------------------------ per-shell behaviour
const NODE_CWD = 'node -e "console.log(process.cwd())"';
const NODE_ENV = 'node -e "console.log(process.env.CHATMCP_TEST_SECRET_TOKEN === undefined ? \'absent\' : \'present\', process.env.CHATMCP_TEST_PLAIN, process.env.GIT_TERMINAL_PROMPT, process.env.PAGER)"';
const NODE_EOF = 'node -e "process.stdin.on(\'data\',()=>{});process.stdin.on(\'end\',()=>console.log(\'eof\'))"';
const NODE_BIG = 'node -e "process.stdout.write(\'x\'.repeat(500000))"';
const NODE_FAIL = 'node -e "process.exit(7)"';
const nodeTree = (name, lateMs) => `node -e "require('fs').writeFileSync('started-${name}.txt','1');setTimeout(()=>require('fs').writeFileSync('late-${name}.txt','1'),${lateMs})"`;

const dialects = {
  posix: {
    echo: 'echo hello', exit3: 'exit 3', stderr: 'echo oops 1>&2', multi: 'a=1\nb=2\necho $((a+b))',
    quoting: 'echo "He said \\"hi\\" $((1+2)) — Xin chào"', literal: "echo 'a$b \\d'", literalOut: 'a$b \\d',
    sleep: 'sleep 30', long: `echo ${'y'.repeat(7000)}`, nativeFail: NODE_FAIL, lastWins: `${NODE_FAIL}; echo done`,
    tree: { timeout: 1000, late: 2500 },
  },
  powershell: {
    echo: 'Write-Output hello', exit3: 'exit 3', stderr: "[Console]::Error.WriteLine('oops')", multi: '$a = 1\n$b = 2\nWrite-Output ($a + $b)',
    quoting: 'Write-Output "He said `"hi`" $(1+2) — Xin chào"', literal: "Write-Output 'a$b \\d'", literalOut: 'a$b \\d',
    sleep: 'Start-Sleep -Seconds 30', long: `Write-Output '${'y'.repeat(7000)}'`, nativeFail: NODE_FAIL, lastWins: `${NODE_FAIL}; Write-Output done`,
    tree: { timeout: 2500, late: 4500 },
  },
};

for (const name of names) {
  const d = name === 'powershell' ? dialects.powershell : dialects.posix;
  const run = (options) => runner.run({ shell: name, timeoutMs: 30_000, ...options });
  console.log(`# shell: ${name}`);

  let r = await run({ command: d.echo });
  assert.equal(r.exitCode, 0);
  assert.equal(nl(r.stdout).trim(), 'hello');
  assert.equal(r.shell, name);
  assert.equal(r.cwd, '.');
  assert.equal(r.timedOut, false);
  assert.equal(r.cancelled, false);
  assert.equal(typeof r.pid, 'number');
  ok(`${name}: echo returns stdout and exit code 0`);

  r = await run({ command: d.exit3 });
  assert.equal(r.exitCode, 3);
  ok(`${name}: exit code is reported`);

  r = await run({ command: d.stderr });
  assert.equal(nl(r.stderr).trim(), 'oops');
  assert.equal(r.stdout.trim(), '');
  ok(`${name}: stderr is captured separately`);

  r = await run({ command: d.multi });
  assert.equal(nl(r.stdout).trim(), '3');
  ok(`${name}: multi-line scripts run`);

  r = await run({ command: d.quoting });
  assert.equal(nl(r.stdout).trim(), 'He said "hi" 3 — Xin chào');
  ok(`${name}: embedded double quotes, expansions and non-ASCII text survive`);

  r = await run({ command: d.literal });
  assert.equal(nl(r.stdout).trim(), d.literalOut);
  ok(`${name}: single-quoted text stays literal`);

  r = await run({ command: d.nativeFail });
  assert.equal(r.exitCode, 7);
  r = await run({ command: d.lastWins });
  assert.equal(r.exitCode, 0);
  assert.equal(nl(r.stdout).trim(), 'done');
  ok(`${name}: a failing program keeps its exit code; the last statement decides otherwise`);

  r = await run({ command: NODE_CWD, cwd: 'sub' });
  assert.equal(await samePath(r.stdout.trim(), path.join(workspaceDir, 'sub')), true, `cwd was ${r.stdout.trim()}`);
  assert.equal(r.cwd, 'sub');
  ok(`${name}: commands run inside the requested workspace folder`);

  r = await run({ command: NODE_ENV });
  assert.equal(r.stdout.trim(), 'absent visible 0 cat');
  ok(`${name}: credential-looking variables are removed, non-interactive defaults are set`);

  r = await run({ command: NODE_EOF, timeoutMs: 8000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout.trim(), 'eof');
  ok(`${name}: stdin is closed (programs reading it see end-of-file)`);

  r = await run({ command: NODE_BIG, maxOutputBytes: 20_000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.truncated.stdout, true);
  assert.equal(r.outputBytes.stdout, 500_000);
  assert.ok(r.stdout.length < 21_000, `stdout kept ${r.stdout.length} chars`);
  assert.match(r.stdout, /đã lược \d+ byte/);
  ok(`${name}: oversized output is truncated with head and tail kept`);

  r = await run({ command: d.long });
  assert.equal(r.exitCode, 0);
  assert.equal(nl(r.stdout).trim(), 'y'.repeat(7000));
  if (name !== 'powershell') assert.equal(r.transport, isWindows ? 'file' : 'file', 'long commands go through a script file');
  else assert.equal(r.transport, 'file');
  ok(`${name}: very long commands are delivered through a script file`);

  const started = Date.now();
  r = await run({ command: d.sleep, timeoutMs: 1000 });
  assert.equal(r.timedOut, true);
  assert.equal(r.cancelled, false);
  assert.ok(Date.now() - started < 12_000, `timeout took ${Date.now() - started} ms`);
  ok(`${name}: timeout stops a runaway command and says so`);

  {
    const { timeout, late } = d.tree;
    const runStart = Date.now();
    r = await run({ command: nodeTree(name, late), timeoutMs: timeout });
    assert.equal(r.timedOut, true, 'the grandchild must outlive the timeout for this check to mean anything');
    await delay(Math.max(0, runStart + timeout + late + 400 - Date.now()));
    assert.equal(await exists(path.join(workspaceDir, `started-${name}.txt`)), true, 'the grandchild never started: the check is inconclusive');
    assert.equal(await exists(path.join(workspaceDir, `late-${name}.txt`)), false, 'a grandchild survived the timeout kill');
    ok(`${name}: timeout kills the whole process tree`);
  }

  {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);
    const aborted = Date.now();
    r = await run({ command: d.sleep, signal: controller.signal });
    assert.equal(r.cancelled, true);
    assert.equal(r.timedOut, false);
    assert.ok(Date.now() - aborted < 12_000);
    ok(`${name}: cancellation stops the command and says so`);
  }

  if (name !== 'powershell') {
    r = await run({ command: 'definitely-not-a-command-xyz' });
    assert.equal(r.exitCode, 127);
    assert.match(r.stderr, /not found|không tìm thấy/i);
    ok(`${name}: unknown commands exit with 127`);

    const lingerStart = Date.now();
    r = await run({ command: 'sleep 4 &\necho started' });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), 'started');
    assert.equal(r.lingering, true);
    assert.ok(Date.now() - lingerStart < 3600, `returned after ${Date.now() - lingerStart} ms`);
    ok(`${name}: a background process holding the pipes does not hang the command`);
  } else {
    r = await run({ command: 'Write-Error boom' });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /boom/);
    assert.doesNotMatch(r.stderr, /CLIXML/);
    r = await run({ command: 'Get-Item does-not-exist.txt' });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /does-not-exist/);
    r = await run({ command: 'Write-Output ready; exit 4' });
    assert.equal(r.exitCode, 4);
    assert.equal(nl(r.stdout).trim(), 'ready');
    ok('powershell: errors become exit code 1 with readable stderr; explicit exit codes win');
  }
}

// ------------------------------------------------------------------ invocation shape
{
  const fake = { name: 'powershell', file: 'pwsh-fake' };
  const short = await runner.buildInvocation(fake, 'Write-Output "é"');
  assert.equal(short.transport, 'encoded');
  for (const flag of ['-NoProfile', '-NonInteractive', '-NoLogo']) assert.ok(short.args.includes(flag), flag);
  assert.equal(Buffer.from(short.args[short.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le'), wrapPowerShell('Write-Output "é"'));
  const long = await runner.buildInvocation(fake, `Write-Output '${'z'.repeat(5000)}'`);
  assert.equal(long.transport, 'file');
  const scriptPath = long.args[long.args.indexOf('-File') + 1];
  const content = await fs.readFile(scriptPath, 'utf8');
  assert.ok(content.startsWith('﻿') && content.includes('z'.repeat(5000)));
  await long.cleanup();
  assert.equal(await exists(scriptPath), false);
  ok('PowerShell invocation: encoded command for short scripts, BOM script file for long ones');
}
{
  const posix = names.find((name) => name === 'bash' || name === 'sh');
  if (posix) {
    const viaFile = new ShellRunner({ workspace, stateDirectory: stateDir, bashTransport: 'file' });
    const first = await viaFile.run({ command: dialects.posix.quoting, shell: posix, timeoutMs: 30_000 });
    assert.equal(first.transport, 'file');
    assert.equal(first.stdout.trim(), 'He said "hi" 3 — Xin chào');
    if (!isWindows) {
      const viaArgv = new ShellRunner({ workspace, stateDirectory: stateDir, bashTransport: 'argv' });
      const second = await viaArgv.run({ command: dialects.posix.quoting, shell: posix, timeoutMs: 30_000 });
      assert.equal(second.transport, 'argv');
      assert.equal(second.stdout, first.stdout);
      const auto = await runner.run({ command: 'echo hi', shell: posix, timeoutMs: 30_000 });
      assert.equal(auto.transport, 'argv');
    }
    ok(`${posix}: script-file and argv transports agree`);
  }
}

// ------------------------------------------------------------------ input validation
{
  await rejects(runner.run({ command: '   ' }), 'bad_command', 'blank command');
  await rejects(runner.run({ command: 'echo\0x' }), 'bad_command', 'NUL byte');
  await rejects(runner.run({ command: 'x'.repeat(70_000) }), 'bad_command', 'oversized command');
  await rejects(runner.run({ command: 'echo hi', cwd: '../outside' }), 'outside_workspace', 'cwd outside the workspace');
  await rejects(runner.run({ command: 'echo hi', cwd: 'missing-folder' }), 'bad_cwd', 'missing cwd');
  await rejects(runner.run({ command: 'echo hi', cwd: 'file.txt' }), 'bad_cwd', 'cwd that is a file');
  await rejects(runner.run({ command: 'echo hi', shell: 'zsh' }), 'bad_shell', 'unknown shell');
  const done = new AbortController();
  done.abort();
  await assert.rejects(runner.run({ command: 'echo hi', signal: done.signal }), { name: 'AbortError' });
  if (!info.shells.powershell) await rejects(runner.run({ command: 'echo hi', shell: 'powershell' }), 'shell_unavailable', 'PowerShell missing');
  assert.throws(() => new ShellRunner({}), TypeError);
  ok('invalid commands, folders and shells are rejected with specific codes');
}

// ------------------------------------------------------------------ shutdown
{
  const first = names[0];
  const d = first === 'powershell' ? dialects.powershell : dialects.posix;
  const closer = new ShellRunner({ workspace, stateDirectory: stateDir });
  const pending = closer.run({ command: d.sleep, shell: first, timeoutMs: 120_000 });
  for (let i = 0; i < 100 && closer.active.size === 0; i += 1) await delay(50);
  assert.equal(closer.active.size, 1);
  const closing = Date.now();
  await closer.close();
  const result = await pending;
  assert.ok(Date.now() - closing < 9000);
  assert.equal(closer.active.size, 0);
  assert.equal(result.timedOut, false);
  ok('close() kills commands that are still running');
}

// ------------------------------------------------------------------ housekeeping
{
  const leftovers = (await fs.readdir(path.join(stateDir, 'shell-scripts')).catch(() => [])).filter((file) => /^cmd-.*\.(sh|ps1)$/.test(file));
  assert.deepEqual(leftovers, [], 'temporary script files must be removed after every run');
  assert.equal(runner.active.size, 0);
  ok('no temporary script files or running children are left behind');
}

await cleanup();
console.log(`PASS: ${checks} shell-runner checks (shells: ${names.join(', ')})`);
