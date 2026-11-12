// StudioTerminal.stop() / close() must end the WHOLE process tree of a session, and close() must say so when it could not.
//
// The defect (Windows, measured 2026-11-12): `taskkill /PID <shell> /T /F` issued ~300 ms after the shell started killed
// the Windows PowerShell shell and its conhost.exe, but node.exe - created by the shell in that same instant - was not in the tree taskkill
// enumerated. It survived as an orphan holding the stdout/stderr pipes, so the child's 'close' never fired, the session stayed
// 'stopping', and close() returned after 6.5 s as if it had finished; removing the workspace then failed with EBUSY.
//
// Sections A and B are deterministic: a fake spawner and a fake process table stand in for the operating system (they run on
// every platform). Section C reproduces the orphan with real processes on Windows by killing only the shell, which leaves its
// node.exe child in exactly the state the race leaves it in.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioTerminal, processTreeLeft } from '../lib/studio-terminal.mjs';

let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`  ok - ${label}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { if (await predicate()) return; await sleep(20); }
  assert.fail(`timed out waiting for: ${label}`);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-terminal-close-'));
const failures = [];
try {
  // A. which processes still belong to a session, read from a process table
  {
    const spawnedAt = Date.parse('2026-11-12T10:00:00.000Z');
    const at = (seconds) => spawnedAt + seconds * 1000;
    const table = [
      { pid: 4, ppid: 0, created: at(-9000) },
      { pid: 700, ppid: 100, created: at(-60) },   // the same parent pid, but older than the shell: the pid was in use before
      { pid: 201, ppid: 100, created: at(0.3) },   // the orphan: its parent (the shell, pid 100) is already gone
      { pid: 202, ppid: 201, created: at(0.5) },   // its own child
      { pid: 203, ppid: 202, created: at(0.6) },   // and a grandchild
      { pid: 900, ppid: 1, created: at(1) },
    ];
    const left = processTreeLeft(table, 100, spawnedAt).map((row) => row.pid).sort();
    check(JSON.stringify(left) === '[201,202,203]', `the orphan of a dead shell and its descendants are found, an older process with the same parent pid is not (${left})`);
    const alive = processTreeLeft([...table, { pid: 100, ppid: 50, created: at(0) }], 100, spawnedAt).map((row) => row.pid).sort();
    check(JSON.stringify(alive) === '[100,201,202,203]', `a shell that is still alive is part of what is left (${alive})`);
    // the shell died and its pid was given to a new, unrelated process that has children of its own
    const reused = processTreeLeft([...table, { pid: 100, ppid: 50, created: at(30) }, { pid: 301, ppid: 100, created: at(31) }], 100, spawnedAt).map((row) => row.pid).sort();
    check(JSON.stringify(reused) === '[201,202,203]', `when the shell's pid was reused, neither the new process nor its children are touched (${reused})`);
    check(processTreeLeft(null, 100, spawnedAt) === null && processTreeLeft([], 100, spawnedAt).length === 0, 'no table: unknown (null); an empty table: nothing left');
  }

  // B. a fake operating system: the shell's pid is 100; killing it does not end the session while an orphan still holds the pipes
  const root = path.join(temp, 'workspace');
  await fs.mkdir(root);
  const workspace = { requireRoot: () => root };
  const world = (options = {}) => {
    const alive = new Map();
    const killed = [];
    let listed = 0;
    let child = null;
    const closeIfDone = () => { if (child && ![...alive.keys()].length && !child.closed) { child.closed = true; child.emit('exit', 1, null); child.emit('close', 1, null); } };
    const spawner = () => {
      child = new EventEmitter();
      child.pid = 100; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = null; child.closed = false;
      child.brokered = Boolean(options.brokered);
      // the direct child is already gone in the cases below: a signal to it changes nothing - unless taskkill cannot run at all
      child.kill = () => { if (options.taskkillMissing) { alive.clear(); setTimeout(closeIfDone, 5); } return true; };
      const now = Date.now();
      alive.set(100, { pid: 100, ppid: 50, created: now });
      for (const extra of options.orphans ?? []) alive.set(extra.pid, { ...extra, created: now + 300 });
      return child;
    };
    const processTree = {
      async kill(pid) {
        killed.push(pid);
        if (options.taskkillMissing) return null;
        if (options.unkillable) return false;
        // like taskkill /T on a tree it enumerated before the orphan was born: only the given pid (and nothing of its tree) dies
        alive.delete(pid);
        setTimeout(closeIfDone, 5);
      },
      async list() { listed++; return options.listFails ? null : [...alive.values(), { pid: 4, ppid: 0, created: 0 }]; },
    };
    return { spawner, processTree, killed, alive, get listed() { return listed; }, get child() { return child; } };
  };
  const terminalOf = (fake, extra = {}) => new StudioTerminal({ workspace, ptyLoader: () => Promise.reject(Object.assign(new Error('absent'), { code: 'ERR_MODULE_NOT_FOUND' })), spawner: fake.spawner, processTree: fake.processTree, platform: 'win32', ...extra });

  // B1. nothing survives the kill: one kill, no process table needed
  {
    const fake = world();
    const terminal = terminalOf(fake);
    const run = await terminal.start({ command: 'node sleep.mjs' });
    const report = await terminal.close();
    check(report?.closed === true && report.pending.length === 0 && terminal.sessions.get(run.id).status === 'stopped', `a tree that dies at once: close() reports closed (${JSON.stringify(report)})`);
    check(JSON.stringify(fake.killed) === '[100]' && fake.listed === 0, `only the shell's tree is killed and the process table is not read (killed ${fake.killed}, listed ${fake.listed})`);
  }

  // B2. the race: an orphan (and its child) outlive the shell; close() finds them by their parent pid and kills them
  {
    const fake = world({ orphans: [{ pid: 201, ppid: 100 }, { pid: 202, ppid: 201 }] });
    const terminal = terminalOf(fake);
    const run = await terminal.start({ command: 'node sleep.mjs' });
    const started = Date.now();
    const report = await terminal.close();
    const elapsed = Date.now() - started;
    check(report?.closed === true && terminal.sessions.get(run.id).status === 'stopped', `the orphan is found and killed, the session ends as stopped (${JSON.stringify(report)}, status ${terminal.sessions.get(run.id).status})`);
    check(fake.killed[0] === 100 && fake.killed.includes(201) && fake.killed.includes(202) && fake.alive.size === 0, `the shell first, then every process left of its tree (killed ${fake.killed})`);
    check(elapsed < 4000, `close() did not need the grace period for it (${elapsed} ms)`);
  }

  // B3. a process that cannot be killed: close() is bounded and SAYS it could not, the session stays 'stopping'
  {
    const fake = world({ orphans: [{ pid: 201, ppid: 100 }], unkillable: true });
    const terminal = terminalOf(fake, { reapMs: 1500 });
    const run = await terminal.start({ command: 'node sleep.mjs' });
    const started = Date.now();
    const report = await terminal.close({ graceMs: 300 });
    const elapsed = Date.now() - started;
    check(report?.closed === false && report.pending.length === 1 && report.pending[0].id === run.id && report.pending[0].pid === 100, `close() reports the session it could not end (${JSON.stringify(report)})`);
    check(terminal.sessions.get(run.id).status === 'stopping', `the session is not reported as stopped (${terminal.sessions.get(run.id).status})`);
    check(elapsed < 300 + 1500 + 1000, `close() stays bounded (${elapsed} ms)`);
    check(terminal.state().find((session) => session.id === run.id).logs.some((line) => line.type === 'system' && /still running after stop: .*201/.test(line.message)), 'the session log names the process that is still running');
    await sleep(1600); // let the bounded reaper finish before the next case
    const seen = fake.listed;
    await sleep(900);
    check(seen > 0 && fake.listed === seen, `the reaper gives up after reapMs instead of reading the process table forever (${seen} then ${fake.listed} reads)`);
  }

  // B4. the process table cannot be read: the session is not reported as closed
  {
    const fake = world({ orphans: [{ pid: 201, ppid: 100 }], listFails: true });
    const terminal = terminalOf(fake, { reapMs: 1200 });
    const run = await terminal.start({ command: 'node sleep.mjs' });
    const report = await terminal.close({ graceMs: 300 });
    check(report?.closed === false && report.pending.length === 1, `an unreadable process table is no proof that the tree is gone (${JSON.stringify(report)})`);
    check(terminal.sessions.get(run.id).logs.some((line) => line.type === 'system' && /process table could not be read/.test(line.message)), 'the session log says the process table could not be read');
    await sleep(1300);
  }

  // B4b. taskkill cannot be started at all: the direct child is killed instead
  {
    const fake = world({ taskkillMissing: true });
    const terminal = terminalOf(fake);
    const run = await terminal.start({ command: 'node sleep.mjs' });
    terminal.stop(run.id); // stop() alone: close() would hide a missing fallback behind its own SIGKILL after the grace period
    await waitFor(() => terminal.sessions.get(run.id).status === 'stopped', 'stop() to end the session without taskkill', 2000);
    check(true, 'without taskkill stop() kills the child directly');
  }

  // B4c. a brokered command (another account): its own tree is killed, the process table of this account is not swept
  {
    const fake = world({ orphans: [{ pid: 201, ppid: 100 }], brokered: true });
    const terminal = terminalOf(fake, { reapMs: 1000 });
    await terminal.start({ command: 'node sleep.mjs' });
    const report = await terminal.close({ graceMs: 300 });
    check(report?.closed === false && JSON.stringify(fake.killed) === '[100]' && fake.listed === 0, `a brokered session is not swept (killed ${fake.killed}, listed ${fake.listed})`);
    await sleep(1100);
  }

  // B5. stop() used alone (no close()): the timeout stops the whole tree, orphans included
  {
    const fake = world({ orphans: [{ pid: 201, ppid: 100 }] });
    const terminal = terminalOf(fake);
    const run = await terminal.start({ command: 'node sleep.mjs', timeoutMinutes: 0.01 });
    await waitFor(() => terminal.sessions.get(run.id).status === 'stopped', 'the timeout to stop the session', 8000);
    check(fake.killed[0] === 100 && fake.killed.includes(201), `the timeout kills the shell and the orphan (killed ${fake.killed})`);
  }

  // B6. stop() used alone: the 6 MiB output cap stops the process (it used to set 'stopping' first, so stop() did nothing)
  {
    const fake = world({ orphans: [{ pid: 201, ppid: 100 }] });
    const terminal = terminalOf(fake);
    const run = await terminal.start({ command: 'node noisy.mjs' });
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < 7; i++) fake.child.stdout.emit('data', chunk);
    fake.child.stdout.emit('data', Buffer.from('PAST_THE_CAP'));
    await waitFor(() => terminal.sessions.get(run.id).status === 'stopped', 'the output cap to stop the session', 8000);
    check(fake.killed[0] === 100 && fake.killed.includes(201), `the output cap kills the shell and the orphan (killed ${fake.killed})`);
    const recorded = terminal.sessions.get(run.id).logs.filter((line) => line.type === 'stdout');
    check(recorded.length === 6 && !recorded.some((line) => line.message.includes('PAST_THE_CAP')), `output past the cap is not recorded (${recorded.length} chunks of output recorded)`);
  }

  // C. real processes (Windows): the shell is gone, its node.exe holds the pipes; close() must end it and wait for it
  if (process.platform === 'win32') {
    const real = path.join(temp, 'real-workspace');
    await fs.mkdir(real);
    await fs.writeFile(path.join(real, 'sleep.mjs'), "import fs from 'node:fs'; fs.writeFileSync('node.pid', String(process.pid)); setTimeout(() => {}, 60000);\n");
    const terminal = new StudioTerminal({ workspace: { requireRoot: () => real }, ptyLoader: () => Promise.reject(Object.assign(new Error('absent'), { code: 'ERR_MODULE_NOT_FOUND' })) });
    const run = await terminal.start({ command: 'node sleep.mjs', timeoutMinutes: 5 });
    const record = terminal.sessions.get(run.id);
    let nodePid = 0;
    await waitFor(async () => { nodePid = Number(await fs.readFile(path.join(real, 'node.pid'), 'utf8').catch(() => '0')); return nodePid > 0; }, 'node.exe to start', 30000);
    process.kill(record.child.pid); // TerminateProcess of the shell alone: node.exe is left as the race leaves it
    await sleep(500);
    const orphaned = record.status === 'running';
    const nodeAlive = () => { try { process.kill(nodePid, 0); return true; } catch { return false; } };
    check(orphaned && nodeAlive(), `control: with the shell gone the orphaned node.exe keeps the session open (status ${record.status}, node alive ${nodeAlive()})`);
    const started = Date.now();
    const report = await terminal.close();
    const elapsed = Date.now() - started;
    check(report?.closed === true && record.status === 'stopped', `close() ends the orphan and only then returns (${JSON.stringify(report)}, status ${record.status})`);
    check(!nodeAlive(), `node.exe ${nodePid} is gone`);
    check(elapsed < 5000, `close() finished promptly (${elapsed} ms)`);
    await fs.rm(real, { recursive: true, force: true });
    check(true, 'the workspace can be removed right after close()');
  } else {
    console.log('  SKIPPED real-process orphan check: Windows only (POSIX stops the whole process group)');
  }
  console.log(`PASS: ${checks} terminal close checks (process tree left of a session, orphan reaping, bounded and honest close(), timeout and output cap)`);
} catch (error) {
  failures.push(error);
} finally {
  // the first failure is the report; cleaning up is best effort and must never replace it
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error) => { if (!failures.length) console.warn(`  cleanup: ${error.message}`); });
}
if (failures.length) { console.error(failures[0]); process.exitCode = 1; }
