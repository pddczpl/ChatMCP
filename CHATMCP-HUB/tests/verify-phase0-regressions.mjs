// Regression tests for defects found by the Phase 0 audit on Windows 11 / Node 24:
//  1. StudioWorkspace.checkpoints() returned nothing when the workspace was reached through
//     a non-canonical path (8.3 short names, junctions, symlinked temp directories).
//  2. StudioTerminal threw (HTTP 500) when node-pty's JavaScript was installed but its native
//     binding could not be loaded; it must fall back to pipes and report why.
//  3. StudioTerminal.close() returned before the processes exited, so removing the workspace
//     failed with EBUSY/ENOTEMPTY on Windows.
//  4. StudioTerminal handed the module folders of PowerShell 7 on to Windows PowerShell when the Hub was started from a pwsh session; Windows PowerShell
//     then lost Get-FileHash and five more commands (lib/powershell-environment.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { StudioTerminal } from '../lib/studio-terminal.mjs';
import { powerShell7ModuleStandIn, windowsPowerShellPath } from './support/powershell-environment.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-phase0-'));
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`  ok - ${label}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(40);
  }
  assert.fail(`timed out waiting for: ${label}`);
}
const outputOf = (terminal, id) => terminal.state().find((session) => session.id === id).logs.map((line) => line.message).join('');

try {
  // 1. checkpoints are found through an alias of the workspace directory
  const real = path.join(temp, 'real');
  await fs.mkdir(real);
  await fs.writeFile(path.join(real, 'a.txt'), 'one\n');
  const alias = path.join(temp, 'alias');
  let aliasCreated = true;
  try { await fs.symlink(real, alias, 'junction'); } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    aliasCreated = false;
    console.warn('  SKIPPED alias checks: this environment does not allow symlinks or junctions');
  }
  if (aliasCreated) {
    const viaAlias = new StudioWorkspace({ manager: { workspace: alias, secrets: [], log: () => {} }, directory: path.join(temp, 'state') });
    const created = await viaAlias.checkpoint({ label: 'via alias' });
    check((await viaAlias.checkpoints()).some((item) => item.id === created.id), 'checkpoint is listed when the workspace path is an alias of the real directory');
    const direct = new StudioWorkspace({ manager: { workspace: real, secrets: [], log: () => {} }, directory: path.join(temp, 'state') });
    check((await direct.checkpoints()).some((item) => item.id === created.id), 'the same checkpoint is listed through the canonical path');
  }
  const none = new StudioWorkspace({ manager: { workspace: null, secrets: [], log: () => {} }, directory: path.join(temp, 'state-none') });
  check((await none.checkpoints()).length === 0, 'no workspace selected: empty checkpoint list and no exception');

  // 2. interactive terminal falls back to pipes when the native PTY is unusable
  const terminalRoot = path.join(temp, 'terminal-workspace');
  await fs.mkdir(terminalRoot);
  const terminalWorkspace = { requireRoot: () => terminalRoot };
  const brokenNative = () => Promise.resolve({ spawn() { throw Object.assign(new Error("Cannot find module '../build/Release/conpty.node'"), { code: 'MODULE_NOT_FOUND' }); } });
  const absent = () => Promise.reject(Object.assign(new Error("Cannot find package 'node-pty'"), { code: 'ERR_MODULE_NOT_FOUND' }));

  const broken = new StudioTerminal({ workspace: terminalWorkspace, ptyLoader: brokenNative });
  const brokenCaps = await broken.capabilities();
  check(brokenCaps.nativeConPTY === false && /conpty\.node/.test(brokenCaps.note) && !/^Install optional/.test(brokenCaps.note), 'capabilities report an installed-but-unusable node-pty with the reason');
  const interactive = await broken.start({ interactive: true, command: 'echo SESSION_READY', timeoutMinutes: 0.2 });
  check(interactive.interactive === true && interactive.mode === 'pipes', 'interactive session falls back to pipes instead of failing');
  await waitFor(() => outputOf(broken, interactive.id).includes('SESSION_READY'), 'output of the initial command');
  broken.write(interactive.id, 'echo AFTER_STDIN\n');
  await waitFor(() => outputOf(broken, interactive.id).includes('AFTER_STDIN'), 'output after stdin write');
  check(true, 'stdin writes reach the fallback shell');
  await broken.close();

  const absentTerminal = new StudioTerminal({ workspace: terminalWorkspace, ptyLoader: absent });
  check(/^Install optional node-pty/.test((await absentTerminal.capabilities()).note), 'capabilities keep the install hint when node-pty is not installed');
  await absentTerminal.close();

  let spawnCalls = 0;
  const flaky = () => Promise.resolve({ spawn() { spawnCalls++; if (spawnCalls > 1) throw new Error('native spawn failed'); return { kill() {} }; } });
  const flakyTerminal = new StudioTerminal({ workspace: terminalWorkspace, ptyLoader: flaky });
  const flakySession = await flakyTerminal.start({ interactive: true, command: 'echo FLAKY', timeoutMinutes: 0.2 });
  check(flakySession.mode === 'pipes' && spawnCalls === 2, 'a PTY that passes the probe but fails the real spawn also falls back to pipes');
  check(/native spawn failed/.test((await flakyTerminal.capabilities()).note), 'the failure reason is remembered for the capabilities report');
  await flakyTerminal.close();

  // 3. close() waits until the processes have really exited
  await fs.writeFile(path.join(terminalRoot, 'sleep.mjs'), 'setTimeout(() => {}, 60000);\n');
  const closing = new StudioTerminal({ workspace: terminalWorkspace, ptyLoader: absent });
  const longRun = await closing.start({ command: 'node sleep.mjs', timeoutMinutes: 5 });
  const record = closing.sessions.get(longRun.id);
  await waitFor(() => record.child?.pid && record.status === 'running', 'long-running command to start');
  await sleep(300);
  const startedClosing = Date.now();
  await closing.close();
  const elapsed = Date.now() - startedClosing;
  check(record.status === 'stopped', `close() returned only after the process exited (status: ${record.status})`);
  check(elapsed < 5000, `close() finished promptly (${elapsed} ms)`);
  await fs.rm(terminalRoot, { recursive: true, force: true });
  check(true, 'the workspace directory can be removed immediately after close()');

  // 4. the module folders of PowerShell 7 do not reach Windows PowerShell through the terminal, however the terminal starts it
  const windowsPowerShell = windowsPowerShellPath();
  if (process.platform === 'win32' && await fs.stat(windowsPowerShell).catch(() => null)) {
    const moduleRoot = path.join(temp, 'module-path-workspace');
    await fs.mkdir(moduleRoot);
    const moduleWorkspace = { requireRoot: () => moduleRoot };
    const modules = await powerShell7ModuleStandIn(path.join(temp, 'ps7'), windowsPowerShell);
    const lookup = "try { 'FOUND ' + (Get-FileHash -LiteralPath $env:ComSpec -Algorithm SHA256).Hash.Length } catch { 'MISSING' }";
    const savedModulePath = process.env.PSModulePath;
    const opened = [];
    const terminal = (options) => { const made = new StudioTerminal({ workspace: moduleWorkspace, ...options }); opened.push(made); return made; };
    // the terminal reads the environment of this process when it starts a shell: make it the one of a Hub that a pwsh step started
    process.env.PSModulePath = `${modules};${savedModulePath ?? ''}`;
    try {
      const control = spawnSync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(lookup, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
      check(control.stdout.trim() === 'MISSING', `control: with the module folder of PowerShell 7 first in PSModulePath a raw Windows PowerShell loses Get-FileHash (${control.stdout}${control.stderr})`);

      const pipes = terminal({ ptyLoader: absent });
      const single = await pipes.start({ command: lookup, timeoutMinutes: 1 });
      await waitFor(() => /FOUND|MISSING/.test(outputOf(pipes, single.id)), 'the answer of one command', 60_000);
      check(outputOf(pipes, single.id).includes('FOUND 64'), `a command given to the terminal finds Get-FileHash behind the module folder of PowerShell 7 (it answered: ${outputOf(pipes, single.id).trim()})`);
      const talk = await pipes.start({ interactive: true, command: lookup, timeoutMinutes: 1 });
      await waitFor(() => /FOUND|MISSING/.test(outputOf(pipes, talk.id)), 'the answer of the interactive shell', 60_000);
      check(talk.mode === 'pipes' && outputOf(pipes, talk.id).includes('FOUND 64'), `an interactive shell over pipes finds Get-FileHash behind the module folder of PowerShell 7 (it answered: ${outputOf(pipes, talk.id).trim()})`);

      // ConPTY comes from the optional node-pty package, which CI does not install: a stand-in library shows what the terminal hands to it
      const seen = [];
      const fakePty = () => { let exit = () => {}; return { kill() { exit({ exitCode: 0 }); }, write() {}, resize() {}, onData() {}, onExit(callback) { exit = callback; } }; };
      const conpty = () => Promise.resolve({ spawn(file, args, options) { seen.push({ file, env: options.env }); return fakePty(); } });
      const viaConpty = terminal({ ptyLoader: conpty });
      const session = await viaConpty.start({ interactive: true, command: '', timeoutMinutes: 1 });
      const shellCall = seen.find((call) => /powershell\.exe$/i.test(call.file));
      check(session.mode === 'conpty' && Boolean(shellCall), 'the terminal starts Windows PowerShell through the ConPTY library');
      check(!Object.keys(shellCall.env).some((name) => name.toLowerCase() === 'psmodulepath') && typeof shellCall.env.CHATMCP_WORKSPACE === 'string', 'what the terminal hands to ConPTY has no PSModulePath and keeps CHATMCP_WORKSPACE');
    } finally {
      // a failing check must not leave an interactive shell holding the folder, which would hide the failure behind EBUSY when the folder is removed
      for (const made of opened) await made.close();
      if (savedModulePath === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = savedModulePath;
    }
  } else if (process.platform !== 'win32') {
    // Off Windows the shell of the terminal is $SHELL, which may be pwsh itself: it keeps the module path it was given.
    const keptRoot = path.join(temp, 'module-path-kept');
    await fs.mkdir(keptRoot);
    const savedModulePath = process.env.PSModulePath;
    process.env.PSModulePath = '/opt/module-path-of-a-pwsh-parent';
    const kept = new StudioTerminal({ workspace: { requireRoot: () => keptRoot }, ptyLoader: absent });
    try {
      const run = await kept.start({ command: 'node -e "process.stdout.write(process.env.PSModulePath ?? \'<unset>\')"', timeoutMinutes: 1 });
      await waitFor(() => kept.state().find((session) => session.id === run.id).status !== 'running', 'the command to end', 60_000);
      check(outputOf(kept, run.id).includes('/opt/module-path-of-a-pwsh-parent'), `off Windows the shell of the terminal keeps the module path it was given (it printed: ${outputOf(kept, run.id).trim()})`);
    } finally {
      await kept.close();
      if (savedModulePath === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = savedModulePath;
    }
  } else {
    console.warn('  SKIPPED module-path checks: no Windows PowerShell here');
  }

  console.log(`PASS: ${checks} Phase 0 regression checks (canonical checkpoint path, PTY fallback, awaited terminal close, module path of PowerShell 7)`);
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
