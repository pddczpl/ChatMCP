// Regression tests for defects found by the Phase 0 audit on Windows 11 / Node 24:
//  1. StudioWorkspace.checkpoints() returned nothing when the workspace was reached through
//     a non-canonical path (8.3 short names, junctions, symlinked temp directories).
//  2. StudioTerminal threw (HTTP 500) when node-pty's JavaScript was installed but its native
//     binding could not be loaded; it must fall back to pipes and report why.
//  3. StudioTerminal.close() returned before the processes exited, so removing the workspace
//     failed with EBUSY/ENOTEMPTY on Windows.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { StudioTerminal } from '../lib/studio-terminal.mjs';

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

  console.log(`PASS: ${checks} Phase 0 regression checks (canonical checkpoint path, PTY fallback, awaited terminal close)`);
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
