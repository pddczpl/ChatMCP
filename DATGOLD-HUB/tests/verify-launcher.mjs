#!/usr/bin/env node
// The background launcher: lib/launch.mjs everywhere, and on Windows also Start-ChatMcpHub.ps1 / Stop-ChatMcpHub.ps1.
//
// What it proves: the launcher works with nothing but Node.js (no repository, no Docker); it starts one Hub in the
// background, reuses it on the next call, switches its project, says so when the Hub runs in another mode, never
// touches a port owned by another program, and shows the reason when the Hub cannot start. On Windows the PowerShell
// wrapper builds exactly the arguments it should (checked against a stand-in launcher) and starts/stops a real Hub.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, hubDirectoryFor, quoteWindowsArgument } from '../lib/launch.mjs';
import { defaultDataDirectory } from '../lib/manager.mjs';
import { parseArguments } from '../hub.mjs';
import { readSession, sessionFile } from '../lib/hub-session.mjs';
import { powerShellChildEnvironment } from './support/powershell-environment.mjs';
import { RUNNING } from './support/running-version.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks += 1; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };

// The test must not depend on how the machine running it is configured.
for (const key of ['CHATMCP_BACKEND', 'CHATMCP_STATE_DIR', 'CHATMCP_NO_OPEN']) delete process.env[key];

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-launcher-'));
const root = await fs.realpath(temp);
const pids = new Set();
const hubPorts = new Set();
const hubStates = new Map(); // port -> state directory (where the Hub published its session)
const servers = [];
const freePort = () => new Promise((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const listening = (port) => new Promise((resolve) => { const socket = net.connect({ port, host: '127.0.0.1' }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
const bearer = async (stateDir) => { const session = stateDir ? await readSession(stateDir) : null; return session ? { Authorization: `Bearer ${session.secret}` } : {}; };
const getJson = async (url, stateDir = null) => { try { const response = await fetch(url, { signal: AbortSignal.timeout(3000), headers: await bearer(stateDir) }); return response.ok ? await response.json() : null; } catch { return null; } };
async function waitFor(label, probe, ms = 30_000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) { last = await probe(); if (last) return last; await sleep(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function project(name) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), `# ${name}\n`);
  return dir;
}
async function shutdown(port) {
  const base = `http://127.0.0.1:${port}`;
  const stateDir = hubStates.get(port);
  const state = await getJson(`${base}/api/state`, stateDir);
  if (!state) return false;
  await fetch(`${base}/api/hub/shutdown`, { method: 'POST', headers: { ...(await bearer(stateDir)), 'Content-Type': 'application/json', Origin: base, 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': state.csrfToken }, body: '{}' }).catch(() => {});
  await waitFor(`port ${port} to close`, async () => !(await listening(port)), 20_000);
  return true;
}
async function section(title, body) {
  const before = checks;
  const started = Date.now();
  await body();
  console.log(`  ok  ${title} (${checks - before} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

try {
  // ---------------------------------------------------------------- where the Hub keeps its data
  await section('the data directory is the one the Hub itself will use', async () => {
    const state = path.join(root, 'explicit-state');
    equal(hubDirectoryFor(parseArguments(['--state-dir', state], {})), state, '--state-dir wins');
    assert.throws(() => parseArguments(['--state-dir',state,'--repo-root',path.join(root,'repo')],{}),/unsupported|option/i); checks += 1;
    equal(hubDirectoryFor(parseArguments([], { CHATMCP_STATE_DIR: state })), state, 'environment variable');
    assert.throws(() => parseArguments(['--repo-root',path.join(root,'repo')],{}),/unsupported|option/i); checks += 1;
    equal(hubDirectoryFor(parseArguments([], {})), defaultDataDirectory({}), 'per-user default without any option');
    assert.throws(() => hubDirectoryFor({ stateDir: null, repoRoot: null }), /state-dir/); checks += 1;
    assert.throws(() => parseArguments(['--backend','mcp'],{}),/Only backend local/); checks += 1;
    assert.throws(() => parseArguments([],{CHATMCP_PUBLIC:'1'}),/Cloud\/public execution removed/); checks += 1;
    assert.throws(() => parseArguments(['--port', '3006'], {}), /3006/); checks += 1;
    equal(parseArguments(['--log-file', path.join(root, 'x.log')], {}).logFile, path.join(root, 'x.log'), '--log-file is understood');
  });

  await section('arguments are quoted the way CreateProcess reads them', async () => {
    equal(quoteWindowsArgument('plain'), 'plain', 'plain words are left alone');
    equal(quoteWindowsArgument(''), '""', 'an empty argument survives');
    equal(quoteWindowsArgument('C:\\my dir\\x'), '"C:\\my dir\\x"', 'spaces get quotes');
    equal(quoteWindowsArgument('C:\\my dir\\'), '"C:\\my dir\\\\"', 'a trailing backslash is doubled so it cannot escape the closing quote');
    equal(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""', 'quotes are escaped');
    if (process.platform === 'win32') {
      // The real parser: hand the quoted text to a new process verbatim and read back what it sees.
      const echo = path.join(root, 'echo-arguments.mjs');
      await fs.writeFile(echo, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
      const samples = ['plain', 'with space', 'C:\\dir with space\\', 'say "hi"', 'a\\"b', '', 'tab\there', 'ünï cödé', '100% & (done)'];
      const run = spawnSync(process.execPath, [quoteWindowsArgument(echo), ...samples.map(quoteWindowsArgument)], { encoding: 'utf8', windowsVerbatimArguments: true, argv0: quoteWindowsArgument(process.execPath) });
      equal(JSON.parse(run.stdout), samples, `the child sees exactly the arguments that were given\n${run.stderr}`);
    }
  });

  // ---------------------------------------------------------------- a real background Hub
  const port = await freePort();
  hubPorts.add(port);
  const state = path.join(root, 'hub-state');
  hubStates.set(port, state);
  const base = `http://127.0.0.1:${port}`;
  const first = await project('first project');
  const second = await project('second project');
  const args = ['--state-dir', state, '--port', String(port), '--no-open', '--project', first];

  await section('starts one Hub in the background with nothing but Node.js', async () => {
    const lines = [];
    const result = await launch(args, { log: (line) => lines.push(line), warn: (line) => lines.push(line) });
    if (result.pid) pids.add(result.pid);
    equal([result.reused, result.backend, result.url], [false, 'local', base], 'started a new local Hub');
    equal(result.logFile, path.join(state, 'hub.log'), 'the log lives in the data directory');
    check(Number.isInteger(result.pid) && result.pid > 0, 'process id is reported');
    check(lines.some((line) => line.includes(base)) && lines.some((line) => /Node\.js/.test(line)), `the user is told where it runs and that only Node.js is needed:\n${lines.join('\n')}`);
    const health = await getJson(`${base}/api/health`);
    equal([health.app, health.initialized, health.backend], ['chatmcp-local-hub', true, 'local'], 'health reports the backend');
    const snapshot = await waitFor('the local tools to be ready', async () => { const s = await getJson(`${base}/api/state`, state); return s?.services?.local?.state === 'ready' ? s : null; });
    equal([snapshot.backend, snapshot.workspace.path, snapshot.dataDirectory], ['local', first, state], 'project opened, data where --state-dir says');
    const log = await fs.readFile(result.logFile, 'utf8');
    check(log.includes(`Dashboard: ${base}`), `hub.log has the startup lines:\n${log}`);
    await fs.access(path.join(state, 'hub-instance.lock'));
    checks += 1;
    const published = await readSession(state);
    check(published && published.port === port && (!result.pid || published.pid === result.pid), 'the Hub published run/hub-session.json for its port and process');
    equal((await fetch(`${base}/api/state`)).status, 401, 'the state endpoint refuses a caller without the session secret');
    equal((await getJson(`${base}/api/health`)).auth, 'bearer', 'health says the Hub requires the secret');
  });

  await section('a second launch reuses the running Hub and can switch its project', async () => {
    const lines = [];
    const reuse = await launch(args, { log: (line) => lines.push(line), warn: (line) => lines.push(line) });
    equal([reuse.reused, reuse.pid, reuse.logFile, reuse.backend], [true, null, null, 'local'], 'reused, nothing new was started');
    check(lines.some((line) => line.includes(base)), 'it says where the Hub is');
    const switchArgs = ['--state-dir', state, '--port', String(port), '--no-open', '--project', second];
    const switched = await launch(switchArgs, { log: (line) => lines.push(line), warn: (line) => lines.push(line) });
    equal(switched.reused, true, 'still the same Hub');
    const snapshot = await waitFor('the second project to be open', async () => { const s = await getJson(`${base}/api/state`, state); return s?.workspace?.path === second && s?.services?.local?.state === 'ready' ? s : null; });
    equal(snapshot.workspace.path, second, 'the project was switched through the dashboard API');
    const processes = [...pids];
    equal(processes.length, 1, 'only one Hub process was ever started');
  });

  await section('deprecated backend arguments are rejected without disrupting local Hub',async()=>{
    await assert.rejects(()=>launch(['--backend','mcp','--port',String(port),'--no-open']),/Only backend local/);
    const health=await getJson(`${base}/api/health`);
    equal(health.backend,'local','local process is unaffected');
  });

  await section('the Hub stops through its shutdown endpoint and releases its lock', async () => {
    check(await shutdown(port), 'shutdown accepted');
    await waitFor('the instance lock to disappear', async () => { try { await fs.access(path.join(state, 'hub-instance.lock')); return false; } catch { return true; } }, 10_000);
    check(!(await listening(port)), 'the port is free again');
    check(await fs.access(sessionFile(state)).then(() => false, () => true), 'the session file is removed on a clean shutdown');
    pids.clear();
    await fs.access(path.join(state, 'hub-state.json'));
    checks += 1;
  });

  await section('a Hub from before the per-launch secret is never reused', async () => {
    const legacyPort = await freePort();
    const requested = [];
    const legacy = http.createServer((request, response) => {
      requested.push(request.url);
      response.setHeader('Content-Type', 'application/json');
      response.end(request.url === '/api/health' ? JSON.stringify({ app: 'chatmcp-local-hub', version: RUNNING, uiBuild: `${RUNNING}-react-agent`, initialized: true, backend: 'local' }) : JSON.stringify({ csrfToken: 'x'.repeat(64) }));
    });
    await new Promise((resolve) => legacy.listen(legacyPort, '127.0.0.1', resolve));
    servers.push(legacy);
    await assert.rejects(() => launch(['--state-dir', path.join(root, 'legacy-state'), '--port', String(legacyPort), '--no-open', '--project', first], { log: () => {}, warn: () => {} }), /STOP-CHATMCP-HUB/); checks += 1;
    check(requested.every((url) => url === '/api/health'), `only the health probe was sent to the old Hub (it would hand its CSRF token to anyone): ${requested.join(' ')}`);
    legacy.close();
  });

  // ---------------------------------------------------------------- failures are explained, other programs are left alone
  await section('a port owned by another program is never taken over', async () => {
    const busy = await freePort();
    const sockets = new Set();
    const blocker = net.createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.end(); });
    await new Promise((resolve) => blocker.listen(busy, '127.0.0.1', resolve));
    servers.push(blocker);
    await assert.rejects(() => launch(['--state-dir', path.join(root, 'busy-state'), '--port', String(busy), '--no-open'], { log: () => {}, warn: () => {} }), /dang do ung dung khac/); checks += 1;
    check(await listening(busy), 'the other program is still listening');
    for (const socket of sockets) socket.destroy();
    blocker.close();
  });

  await section('when the Hub cannot start, the reason from its log is shown', async () => {
    const guarded = path.join(root, 'locked-state');
    await fs.mkdir(guarded, { recursive: true });
    // A live process (this one) owns the data directory, so a second Hub must refuse to use it.
    await fs.writeFile(path.join(guarded, 'hub-instance.lock'), JSON.stringify({ pid: process.pid, port: 1, nonce: 'x', startedAt: new Date().toISOString() }));
    const lines = [];
    const lockedPort = await freePort();
    await assert.rejects(() => launch(['--state-dir', guarded, '--port', String(lockedPort), '--no-open'], { log: (line) => lines.push(line), warn: (line) => lines.push(line) }), (error) => /Hub chua mo duoc/.test(error.message) && error.message.includes(path.join(guarded, 'hub.log')));
    checks += 1;
    check(lines.some((line) => /đang giữ cấu hình/.test(line)), `the log tail explains why:\n${lines.join('\n')}`);
    check(!(await listening(lockedPort)), 'nothing is left listening');
  });

  // ---------------------------------------------------------------- the PowerShell wrapper (Windows)
  if (process.platform !== 'win32') {
    console.log('  --  PowerShell launcher checks run on Windows only');
  } else {
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const runScript = (script, scriptArgs, cwd = root) => {
      const began = Date.now();
      const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...scriptArgs], { cwd, encoding: 'utf8', timeout: 90_000, windowsHide: true, env: powerShellChildEnvironment() });
      return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, ms: Date.now() - began };
    };
    const startScript = path.join(bundleRoot, 'Start-ChatMcpHub.ps1');
    const stopScript = path.join(bundleRoot, 'Stop-ChatMcpHub.ps1');

    // A stand-in lib/launch.mjs prints the arguments it receives, so nothing is started.
    const fakeParent = path.join(root, 'fake bundle');
    const fakeHub = path.join(fakeParent, 'hub');
    await fs.mkdir(path.join(fakeHub, 'lib'), { recursive: true });
    await fs.copyFile(startScript, path.join(fakeHub, 'Start-ChatMcpHub.ps1'));
    await fs.writeFile(path.join(fakeHub, 'lib', 'launch.mjs'), "console.log('ARGS ' + JSON.stringify(process.argv.slice(2)));\n");
    const fakeStart = path.join(fakeHub, 'Start-ChatMcpHub.ps1');
    const argsOf = (run) => { const line = run.output.split(/\r?\n/).find((entry) => entry.startsWith('ARGS ')); return line ? JSON.parse(line.slice(5)) : null; };

    await section('PowerShell: the arguments given to the Hub', async () => {
      const spaced = await project('my project');
      const plain = runScript(fakeStart, []);
      equal(plain.code, 0, `default run succeeds\n${plain.output}`);
      equal(argsOf(plain), ['--port', '3007', '--backend', 'local'], 'nothing is required: local backend, default port');
      check(/backend: local/.test(plain.output), 'the chosen backend is printed');

      const full = runScript(fakeStart, ['-ProjectPath', `${spaced}\\`, '-StateDir', 'relative\\state dir', '-Port', '3011', '-NoOpen']);
      equal(full.code, 0, `full run succeeds\n${full.output}`);
      equal(argsOf(full), ['--port', '3011', '--backend', 'local', '--state-dir', path.join(root, 'relative', 'state dir'), '--project', spaced, '--no-open'], 'paths with spaces stay one argument; a relative -StateDir is resolved; the trailing backslash is dropped');

      const repo=await project('some-repo');
      const noRepo=runScript(fakeStart,['-RepoRoot',repo]);
      check(noRepo.code!==0,'PowerShell no longer accepts -RepoRoot');
      const noMcp=runScript(fakeStart,['-Backend','mcp']);
      check(noMcp.code!==0,'PowerShell no longer accepts -Backend mcp');
      const reserved = runScript(fakeStart, ['-Port', '3006']);
      equal(reserved.code, 1, 'port 3006 is refused');
      check(/reserved/.test(reserved.output), 'with a clear reason');
      const badProject = runScript(fakeStart, ['-ProjectPath', path.join(root, 'no such project')]);
      equal(badProject.code, 1, 'a project folder that does not exist stops');
      const invalid = runScript(fakeStart, ['-Backend', 'docker']);
      check(invalid.code !== 0, 'an unknown -Backend is rejected');
    });

    await section('PowerShell: starts and stops a real Hub', async () => {
      const realPort = await freePort();
      hubPorts.add(realPort);
      const realState = path.join(root, 'ps-state');
      hubStates.set(realPort, realState);
      const realProject = await project('ps project');
      const started = runScript(startScript, ['-NoOpen', '-StateDir', realState, '-Port', String(realPort), '-ProjectPath', realProject]);
      equal(started.code, 0, `Start-ChatMcpHub.ps1 succeeded\n${started.output}`);
      check(/backend: local/.test(started.output) && /Dang chay nen/.test(started.output), `it started a local Hub\n${started.output}`);
      // The output is captured through pipes here, as a CI step or an IDE task would. A Hub that inherited those pipes
      // would keep this call waiting until it exits (that took the full timeout before the Hub was started detached).
      check(started.ms < 60_000, `the call returns while the Hub keeps running (took ${started.ms} ms)`);
      const snapshot = await waitFor('the Hub to be ready', async () => { const s = await getJson(`http://127.0.0.1:${realPort}/api/state`, realState); return s?.services?.local?.state === 'ready' ? s : null; });
      equal([snapshot.backend, snapshot.workspace.path, snapshot.dataDirectory], ['local', realProject, realState], 'the Hub opened the project in the folder that was asked for');
      const again = runScript(startScript, ['-NoOpen', '-StateDir', realState, '-Port', String(realPort), '-ProjectPath', realProject]);
      equal(again.code, 0, 'starting again succeeds');
      check(/Hub da chay nen/.test(again.output), `and reuses the running Hub\n${again.output}`);
      const stopped = runScript(stopScript, ['-Port', String(realPort), '-StateDir', realState]);
      equal(stopped.code, 0, `Stop-ChatMcpHub.ps1 succeeded\n${stopped.output}`);
      check(/Stopped/.test(stopped.output), 'it confirms the Hub closed');
      check(!(await listening(realPort)), 'the port is free');
      const nothing = runScript(stopScript, ['-Port', String(realPort), '-StateDir', realState]);
      equal(nothing.code, 0, 'stopping a Hub that is not running is not an error');
      check(/Already stopped/.test(nothing.output), 'and says so');
    });

    // ---------------------------------------------------------------- the desktop launcher (Windows)
    // START-CHATMCP-DESKTOP.cmd and scripts/Start-DesktopApp.ps1 are never run where they stand: in a checkout that has a published desktop shell they would start the real
    // app. Each case runs a copy of the two files in a folder of its own, with stand-ins around them: a "ChatMCP.exe" that is a copy of node.exe and writes down how it was
    // started (NODE_OPTIONS makes it load the recorder below and exit), and a DATGOLD-HUB\Start-ChatMcpHub.ps1 that prints the parameters it was given.
    const repositoryRoot = path.resolve(bundleRoot, '..');
    const desktopScriptSource = path.join(repositoryRoot, 'scripts', 'Start-DesktopApp.ps1');
    const desktopCmdSource = path.join(repositoryRoot, 'START-CHATMCP-DESKTOP.cmd');
    const recorder = path.join(root, 'app-recorder.cjs');
    await fs.writeFile(recorder, "require('node:fs').appendFileSync(process.env.DESKTOP_STANDIN_RECORD, JSON.stringify({ exe: process.execPath, args: process.argv.slice(1) }) + '\\n');\nprocess.exit(0);\n");
    const printingHubLauncher = [
      'param([Parameter(Position = 0)][string]$ProjectPath, [int]$Port = 3007)',
      "Write-Host ('HUBARGS ' + (ConvertTo-Json -Compress @{ ProjectPath = [string]$ProjectPath; Port = $Port; Bound = @($PSBoundParameters.Keys | Sort-Object) }))",
      'if ($env:DESKTOP_STANDIN_EXIT) { exit [int]$env:DESKTOP_STANDIN_EXIT }', '',
    ].join('\r\n');
    async function desktopLayout(name, { app = null, hubLauncher = printingHubLauncher } = {}) {
      const folder = path.join(root, name);
      await fs.mkdir(path.join(folder, 'scripts'), { recursive: true });
      await fs.copyFile(desktopScriptSource, path.join(folder, 'scripts', 'Start-DesktopApp.ps1'));
      await fs.copyFile(desktopCmdSource, path.join(folder, 'START-CHATMCP-DESKTOP.cmd'));
      if (hubLauncher) {
        await fs.mkdir(path.join(folder, 'DATGOLD-HUB'), { recursive: true });
        await fs.writeFile(path.join(folder, 'DATGOLD-HUB', 'Start-ChatMcpHub.ps1'), hubLauncher);
      }
      const appPath = app === 'installed' ? path.join(folder, 'ChatMCP.exe') : app === 'published' ? path.join(folder, 'desktop-shell', 'bin', 'dist', 'ChatMCP.exe') : null;
      if (appPath) { await fs.mkdir(path.dirname(appPath), { recursive: true }); await fs.copyFile(process.execPath, appPath); }
      return { folder, script: path.join(folder, 'scripts', 'Start-DesktopApp.ps1'), cmd: path.join(folder, 'START-CHATMCP-DESKTOP.cmd'), appPath, record: path.join(folder, 'app-starts.jsonl') };
    }
    const desktopEnvironment = (layout, extra = {}) => powerShellChildEnvironment({ DESKTOP_STANDIN_RECORD: layout.record, NODE_OPTIONS: `--require "${recorder.replaceAll('\\', '/')}"`, ...extra });
    const runDesktopScript = (layout, scriptArgs, extra = {}) => {
      const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', layout.script, ...scriptArgs], { cwd: root, encoding: 'utf8', timeout: 90_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: desktopEnvironment(layout, extra) });
      return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    };
    // (stdin is the null device, so the "pause" that the .cmd ends a failure with returns at once)
    const runDesktopCmd = (layout, argumentText, extra = {}) => {
      const result = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', `""${layout.cmd}"${argumentText ? ` ${argumentText}` : ''}"`], { cwd: root, encoding: 'utf8', timeout: 90_000, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'], env: desktopEnvironment(layout, extra) });
      return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    };
    const appStarts = async (layout, count) => waitFor(`${count} start(s) of the stand-in app`, async () => {
      const lines = (await fs.readFile(layout.record, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      return lines.length >= count ? lines.map((line) => JSON.parse(line)) : null;
    });
    const hubArgsOf = (run) => { const line = run.output.split(/\r?\n/).find((entry) => entry.startsWith('HUBARGS ')); return line ? JSON.parse(line.slice(8)) : null; };
    const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

    await section('desktop launcher: with the app there, it starts the app and nothing else', async () => {
      const someProject = await project('desktop project');
      for (const where of ['installed', 'published']) {
        const layout = await desktopLayout(`desktop ${where}`, { app: where });
        const plain = runDesktopScript(layout, []);
        equal(plain.code, 0, `${where}: the script succeeds\n${plain.output}`);
        let starts = await appStarts(layout, 1);
        check(samePath(starts[0].exe, layout.appPath), `${where}: the app that was started is the one of this folder (${starts[0].exe})`);
        equal(starts[0].args, [], `${where}: it is started without arguments`);
        equal(hubArgsOf(plain), null, `${where}: the Hub launcher is not run (the app starts its own Hub)`);

        // The app reads no arguments (desktop-shell/Program.cs): what the launcher is given is not passed on, and the launcher says so.
        const withProject = runDesktopScript(layout, ['-ProjectPath', someProject, '-Port', '3011']);
        equal(withProject.code, 0, `${where}: a project folder does not stop the start\n${withProject.output}`);
        starts = await appStarts(layout, 2);
        equal(starts[1].args, [], `${where}: the project folder is not handed to an app that would ignore it`);
        check(/takes no arguments/.test(withProject.output), `${where}: and the launcher says that it is not passed on\n${withProject.output}`);
        equal(hubArgsOf(withProject), null, `${where}: still no Hub launcher`);

        const throughCmd = runDesktopCmd(layout, `"${someProject}"`);
        equal(throughCmd.code, 0, `${where}: START-CHATMCP-DESKTOP.cmd succeeds\n${throughCmd.output}`);
        starts = await appStarts(layout, 3);
        check(samePath(starts[2].exe, layout.appPath), `${where}: the .cmd starts the same app`);
        equal(starts[2].args, [], `${where}: the .cmd passes nothing on either`);
        check(/takes no arguments/.test(throughCmd.output), `${where}: and says so\n${throughCmd.output}`);
        equal(hubArgsOf(throughCmd), null, `${where}: the .cmd does not run the Hub launcher`);
      }
    });

    await section('desktop launcher: without the app, the Hub launcher does the work', async () => {
      const layout = await desktopLayout('desktop no app');
      const someProject = await project('browser project');
      const plain = runDesktopScript(layout, []);
      equal(plain.code, 0, `the script succeeds\n${plain.output}`);
      equal(hubArgsOf(plain), { ProjectPath: '', Port: 3007, Bound: ['Port'] }, 'the Hub launcher gets the port and no project');
      check(/ChatMCP\.exe/.test(plain.output) && /browser/.test(plain.output), `the launcher says that the app is not there and that the browser is used\n${plain.output}`);
      const full = runDesktopScript(layout, ['-ProjectPath', someProject, '-Port', '3011']);
      equal(hubArgsOf(full), { ProjectPath: someProject, Port: 3011, Bound: ['Port', 'ProjectPath'] }, 'a project folder with a space and the port reach it as they were given');
      const positional = runDesktopCmd(layout, `"${someProject}"`);
      equal(positional.code, 0, `the .cmd succeeds\n${positional.output}`);
      equal(hubArgsOf(positional), { ProjectPath: someProject, Port: 3007, Bound: ['Port', 'ProjectPath'] }, 'the .cmd hands its arguments to the script');
      const failed = runDesktopScript(layout, [], { DESKTOP_STANDIN_EXIT: '1' });
      equal(failed.code, 1, 'a Hub launcher that stops makes the script fail');
      const failedCmd = runDesktopCmd(layout, '', { DESKTOP_STANDIN_EXIT: '1' });
      check(failedCmd.code !== 0, 'and the .cmd');
      check(!(await fs.stat(layout.record).catch(() => null)), 'no app was started');

      const bare = await desktopLayout('desktop nothing', { hubLauncher: null });
      const nothing = runDesktopScript(bare, []);
      equal(nothing.code, 1, 'a folder with neither the app nor the Hub stops');
      check(/DatGoldSetup\.exe/.test(nothing.output), `and says in words what to install\n${nothing.output}`);

      // No second way of starting a Hub or of opening its page is left in the script: the route it used to ask does not exist, the message box had no assembly, and the
      // browser window it opened carried no sign-in ticket.
      const text = `${await fs.readFile(desktopScriptSource, 'utf8')}\n${await fs.readFile(desktopCmdSource, 'utf8')}`;
      for (const gone of ['healthz', 'System.Windows.Forms', '--app=', 'hub.mjs', 'WebClient', 'msedge', 'ChatMCP.exe" %*']) check(!text.includes(gone), `the desktop launcher no longer holds: ${gone}`);
    });

    await section('desktop launcher: the fallback is the real Hub launcher: one Hub, found on /api/health, reused by the next start', async () => {
      // The stand-in only adds what a test needs (-NoOpen, a state folder of its own) and hands over to the real Start-ChatMcpHub.ps1.
      const forwarding = [
        'param([Parameter(Position = 0)][string]$ProjectPath, [int]$Port = 3007)',
        '& $env:DESKTOP_REAL_LAUNCHER -NoOpen -StateDir $env:DESKTOP_REAL_STATE -Port $Port -ProjectPath $ProjectPath',
        'exit $LASTEXITCODE', '',
      ].join('\r\n');
      const layout = await desktopLayout('desktop real hub', { hubLauncher: forwarding });
      const desktopPort = await freePort();
      hubPorts.add(desktopPort);
      const desktopState = path.join(root, 'desktop-state');
      hubStates.set(desktopPort, desktopState);
      const desktopProject = await project('desktop real project');
      // (no NODE_OPTIONS here: the node that this starts is the Hub)
      const real = { DESKTOP_REAL_LAUNCHER: startScript, DESKTOP_REAL_STATE: desktopState, NODE_OPTIONS: '' };
      const first = runDesktopScript(layout, ['-ProjectPath', desktopProject, '-Port', String(desktopPort)], real);
      equal(first.code, 0, `the script succeeds\n${first.output}`);
      check(/Dang chay nen/.test(first.output), `it started a Hub\n${first.output}`);
      const health = await fetch(`http://127.0.0.1:${desktopPort}/api/health`);
      equal([health.status, (await health.json()).app], [200, 'chatmcp-local-hub'], 'the Hub answers the health route that exists');
      equal((await fetch(`http://127.0.0.1:${desktopPort}/healthz`)).status, 404, 'and has no /healthz, which the script used to ask');
      const snapshot = await waitFor('the Hub to be ready', async () => { const s = await getJson(`http://127.0.0.1:${desktopPort}/api/state`, desktopState); return s?.services?.local?.state === 'ready' ? s : null; });
      equal(snapshot.workspace.path, desktopProject, 'the Hub opened the project that the launcher was given');
      const second = runDesktopScript(layout, ['-ProjectPath', desktopProject, '-Port', String(desktopPort)], real);
      equal(second.code, 0, 'a second start succeeds');
      check(/Hub da chay nen/.test(second.output), `and reuses the Hub that runs instead of starting another\n${second.output}`);
      check(await shutdown(desktopPort), 'the Hub of this section is stopped');
    });
  }

  console.log(`PASS: ${checks} checks - launcher: standalone start, reuse, project switch, mode mismatch, busy port, startup failure${process.platform === 'win32' ? ', PowerShell wrapper' : ''}`);
} finally {
  for (const hubPort of hubPorts) await shutdown(hubPort).catch(() => {});
  for (const server of servers) { try { server.close(); } catch { /* already closed */ } }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
}
