#!/usr/bin/env node
// The run sandbox of the benchmark (plan task P7 pod-36, corpus/SANDBOX.md): one agent run of one task, in a folder of its own.
//
//   runSandbox({task, gitSource, root, agent, ...})   -> the run: the agent's diff (bytes and sha256), its exit, output and time, the
//                                                        setup steps, the names of the profile variables and credentials, the cleanup
//
// The steps: a run folder <root>/<8 hex> on a short path; the base in a private store and its baseline commit checked out into w/; fresh
// profile folders (HOME, APPDATA, XDG, CODEX_HOME, CLAUDE_CONFIG_DIR) with nothing copied from the real profile; setup, which must leave
// the tree as it was; the agent, killed with its whole process tree at the wall limit or on cancel; the agent's diff, from the private
// store and never from the agent's own .git, checked to reproduce the final tree; what the processes left behind is killed and the run
// folder removed, after a failure as well. It is not an OS sandbox: the agent runs as the same user.
//
//   node corpus/tools/run-sandbox.mjs --task <dir> --patch-out <file> [--git-source <dir>] [--root <dir>] [--wall-seconds <n>]
//        [--credential <NAME>]... -- <program> [arguments...]
// prints the run as JSON (without the diff, which goes to --patch-out); exit 0 when the run finished, 2 for a usage error, 3 for a refusal.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BoundedCapture, killTree, windowsProcessTree } from './hub-process.mjs';
import { CorpusError, loadTask } from './load.mjs';
import {
  SandboxError, buildBase, changedPaths, checkPathBudget, checkSeed, checkVariables, checkoutBase, defaultMaxPath, defaultSandboxRoot,
  diffTrees, inspectBase, makeProfile, makeRunFolder, openGit, patchReproduces, profileEnvironment, reapTrees, removeRunFolder, runSetup,
  sha256, treeOfWork,
} from './sandbox-core.mjs';

export const RUN_FORMAT = 'datgold.corpus-run/1';
export const RUN_LIMITS = Object.freeze({ maxOutputBytes: 8 * 1024 * 1024, killWaitMs: 10_000, lingerMs: 1500 });

/** Runs the agent program and waits for it; kills its tree at the wall limit or on abort. Never throws: a start failure is `startError`. */
function runAgent({ agent, cwd, env, wallMs, signal, maxOutputBytes }) {
  return new Promise((resolve) => {
    const spawnedAt = Date.now();
    const stdout = new BoundedCapture(maxOutputBytes);
    const stderr = new BoundedCapture(Math.max(1000, Math.floor(maxOutputBytes / 4)));
    const state = { timedOut: false, cancelled: false, stuck: false };
    let child;
    try {
      child = spawn(agent.command, agent.args ?? [], {
        cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: [agent.input === undefined || agent.input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ startError: error.message, spawnedAt });
      return;
    }
    let done = false;
    let exitInfo = null;
    const timers = [];
    const finish = (extra = {}) => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const out = stdout.result();
      const err = stderr.result();
      resolve({
        pid: child.pid, spawnedAt, exitCode: exitInfo?.code ?? null, signal: exitInfo?.signal ?? null, ...state, wallMs: (exitInfo?.at ?? Date.now()) - spawnedAt,
        stdout: out.text, stderr: err.text, truncated: { stdout: out.truncated, stderr: err.truncated }, outputBytes: { stdout: out.totalBytes, stderr: err.totalBytes }, ...extra,
      });
    };
    const stop = (kind) => {
      if (exitInfo || done) return;
      state[kind] = true;
      killTree(child);
      timers.push(setTimeout(() => { state.stuck = true; child.stdout?.destroy(); child.stderr?.destroy(); finish(); }, RUN_LIMITS.killWaitMs));
    };
    const onAbort = () => stop('cancelled');
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(agent.input); }
    child.once('error', (error) => { if (!child.pid) finish({ startError: error.message }); });
    // A child that inherited the pipes keeps "close" away: after the agent's exit the streams get a moment to drain, then are cut.
    child.once('exit', (code, sig) => {
      exitInfo = { code, signal: sig, at: Date.now() };
      timers.push(setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, RUN_LIMITS.lingerMs));
    });
    child.once('close', () => finish());
    timers.push(setTimeout(() => stop('timedOut'), wallMs));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function checkTask(task) {
  if (!task || typeof task !== 'object' || !task.task || typeof task.dir !== 'string') throw new SandboxError('bad_argument', 'task must be a task loaded by corpus/tools/load.mjs (loadTask)');
}
export function checkRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new SandboxError('bad_argument', `the sandbox root must be an absolute path: ${JSON.stringify(root)}`);
  return path.resolve(root);
}
function checkCommands(commands) {
  if (!Array.isArray(commands) || commands.some((command) => typeof command !== 'string' || !command.trim())) throw new SandboxError('bad_argument', 'setup must be a list of commands');
  return commands;
}

/**
 * One run of `agent` on `task`.
 * @param {object} options
 * @param {object} options.task           a task loaded by loadTask (corpus/tools/load.mjs)
 * @param {string} [options.gitSource]    a local repository that holds the task's commit (Git tasks; the tools never fetch)
 * @param {string} [options.root]         the sandbox root (default: C:\cmr on Windows, /tmp/cmr elsewhere, or DATGOLD_CORPUS_SANDBOX_ROOT)
 * @param {object} options.agent          {command, args?, input?, env?, credentials?, seed?}: the program, its standard input, its own
 *                                        variables, the credentials it may have (named by the caller, never copied), files for its profile
 * @param {number} [options.wallSeconds]  the wall limit (default: the task's limits.wall_seconds)
 * @param {string[]} [options.setup]      the setup commands (default: the task's)
 * @param {object} [options.extraEnv]     variables for setup and the agent (a pinned cache, say); never a credential
 * @param {object} [options.env]          the environment the allow-list is read from (default: process.env)
 */
export async function runSandbox(options = {}) {
  const {
    task, gitSource, agent, signal = null, env = process.env, git: gitExe, processTree = windowsProcessTree,
    setupTimeoutSeconds, maxOutputBytes = RUN_LIMITS.maxOutputBytes, maxPath = defaultMaxPath(),
  } = options;
  checkTask(task);
  const root = checkRoot(options.root ?? defaultSandboxRoot({ env }));
  const wallSeconds = options.wallSeconds ?? task.task.limits.wall_seconds;
  if (!Number.isInteger(wallSeconds) || wallSeconds < 1 || wallSeconds > 14_400) throw new SandboxError('bad_argument', `wallSeconds must be a whole number from 1 to 14400, not ${wallSeconds}`);
  if (!agent || typeof agent.command !== 'string' || !agent.command || (agent.args !== undefined && (!Array.isArray(agent.args) || agent.args.some((arg) => typeof arg !== 'string')))) {
    throw new SandboxError('bad_argument', 'agent must be {command, args?: string[]}');
  }
  const setupCommands = checkCommands(options.setup ?? task.task.setup);
  const extraEnv = checkVariables(options.extraEnv, 'extraEnv');
  const agentEnv = checkVariables(agent.env, 'agent.env');
  const credentials = checkVariables(agent.credentials, 'agent.credentials');
  const seed = checkSeed(agent.seed);
  const context = await openGit({ exe: gitExe, env });

  const layout = await makeRunFolder(root);
  const roots = [];
  let result = null;
  let failure = null;
  let leftovers = [];
  try {
    const base = await inspectBase({ task, gitSource, context, layout });
    checkPathBudget({ prefix: layout.work, paths: base.paths, maxPath });
    const built = await buildBase({ base, context, layout });
    await checkoutBase({ base, built, context, layout, dest: layout.work });
    await makeProfile(layout, seed);
    const environments = profileEnvironment({ layout, env, extraEnv, agentEnv, credentials });
    const setup = await runSetup({ commands: setupCommands, dir: layout.work, env: environments.setup, layout, timeoutSeconds: setupTimeoutSeconds, signal, roots });
    if (signal?.aborted) throw new SandboxError('cancelled', 'the run was cancelled before the agent started', { setup });
    if (setup.some((step) => !step.pass)) throw new SandboxError('setup_failed', `the setup command ${JSON.stringify(setup.at(-1).command)} failed (exit ${setup.at(-1).exitCode}${setup.at(-1).timedOut ? ', timed out' : ''})`, { setup });
    // Setup may write ignored paths (node_modules) but nothing the diff would see: the agent's diff must be the agent's alone.
    const afterSetup = await treeOfWork({ base, built, context, layout, name: 'setup' });
    if (afterSetup !== built.tree) {
      const paths = await changedPaths({ base, context, layout, from: built.tree, to: afterSetup });
      throw new SandboxError('setup_changed_tree', `setup changed ${paths.length} path(s) Git does not ignore (${paths.slice(0, 5).join(', ')}): the task's setup must leave the tree as it was`, { setup, paths });
    }

    const ran = await runAgent({ agent, cwd: layout.work, env: environments.agent, wallMs: wallSeconds * 1000, signal, maxOutputBytes });
    if (ran.pid) roots.push({ pid: ran.pid, spawnedAt: ran.spawnedAt });
    if (ran.startError) throw new SandboxError('agent_failed_to_start', `the agent program ${agent.command} did not start: ${ran.startError}`, { setup });
    // The tree is read after the agent's processes are gone, so that nothing writes while it is read.
    leftovers = (await reapTrees(roots.splice(0), { processTree })).leftovers;
    await fs.mkdir(layout.work, { recursive: true });
    const finalTree = await treeOfWork({ base, built, context, layout, name: 'final' });
    const patch = await diffTrees({ base, context, layout, from: built.tree, to: finalTree });
    if (!(await patchReproduces({ base, context, layout, from: built.tree, to: finalTree, patch }))) {
      throw new SandboxError('patch_not_reproducible', 'the agent\'s diff does not turn the base tree into the final tree', { setup });
    }
    const { pid, spawnedAt, startError, ...agentResult } = ran;
    result = {
      format: RUN_FORMAT, runId: layout.id, taskId: task.id, root, baseTree: built.tree, baseCommit: built.commit, finalTree,
      patch, patchSha256: sha256(patch), patchBytes: patch.length, agent: agentResult, setup,
      profile: { ...environments.record, seeded: Object.keys(seed).sort() },
    };
  } catch (error) {
    failure = error;
  } finally {
    const reaped = await reapTrees(roots, { processTree }).catch(() => ({ leftovers: null }));
    const removed = await removeRunFolder(layout.dir);
    const cleanup = { ...removed, leftovers: leftovers === null || reaped.leftovers === null ? null : [...leftovers, ...reaped.leftovers] };
    if (failure) failure.cleanup = cleanup;
    else result.cleanup = cleanup;
  }
  if (failure) throw failure;
  return result;
}

// ---- the command line ------------------------------------------------------------------------------------------------------------------

const USAGE = 'usage: node corpus/tools/run-sandbox.mjs --task <dir> --patch-out <file> [--git-source <dir>] [--root <dir>] [--wall-seconds <n>] [--credential <NAME>]... -- <program> [arguments...]';

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const split = argv.indexOf('--');
  const own = split < 0 ? argv : argv.slice(0, split);
  const program = split < 0 ? [] : argv.slice(split + 1);
  const options = { credential: [] };
  for (let index = 0; index < own.length; index += 1) {
    const flag = own[index];
    const value = own[index + 1];
    if (!['--task', '--patch-out', '--git-source', '--root', '--wall-seconds', '--credential'].includes(flag) || value === undefined) { stderr.write(`${USAGE}\n`); return 2; }
    index += 1;
    if (flag === '--credential') options.credential.push(value);
    else options[flag.slice(2)] = value;
  }
  if (!options.task || !options['patch-out'] || !program.length) { stderr.write(`${USAGE}\n`); return 2; }
  const credentials = {};
  for (const name of options.credential) {
    if (typeof env[name] !== 'string') { stderr.write(`--credential ${name}: the variable is not set\n${USAGE}\n`); return 2; }
    credentials[name] = env[name];
  }
  const wallSeconds = options['wall-seconds'] === undefined ? undefined : Number(options['wall-seconds']);
  try {
    const task = await loadTask(path.resolve(options.task));
    const run = await runSandbox({
      task, gitSource: options['git-source'], root: options.root ? path.resolve(options.root) : undefined, wallSeconds, env,
      agent: { command: program[0], args: program.slice(1), credentials },
    });
    const out = path.resolve(options['patch-out']);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, run.patch);
    const { patch, ...summary } = run;
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof SandboxError) && !(error instanceof CorpusError)) throw error;
    stderr.write(`refused: ${error.message}\n`);
    return 3;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
