#!/usr/bin/env node
// The clean-room scoring checkout of the benchmark (plan task P7 pod-36, corpus/SANDBOX.md). Scoring never trusts the agent's tree:
//
//   scoreCheckout({task, gitSource, root, patch, hiddenArchive, runs})  -> the score: outcome, hidden_pass, each run's checks
//
// 1. a fresh checkout of the base in a new run folder, from the task's own source (never from the run's folder, which is gone);
// 2. the agent's diff applied to it with `git apply --index` (a diff that does not apply is the outcome patch_does_not_apply);
// 3. a clean install: the task's setup commands (from its lockfiles, e.g. `npm ci`);
// 4. the hidden tests copied in from the archive whose sha256 the task names: a file the diff put at a hidden test's path is replaced;
// 5. the task's acceptance checks, `runs` times (the protocol's 3): hidden_pass only when every run passes, `flaky` when some do.
// Files the agent wrote in a Git-ignored path never reach the checkout, which closes the ignored-path tamper hole. It is not an OS sandbox.
//
//   node corpus/tools/score-checkout.mjs --task <dir> --hidden <archive> --patch <file> [--git-source <dir>] [--root <dir>] [--runs <n>]
// prints the score as JSON; exit 0 for the outcome pass, 1 for any other outcome, 2 for a usage error, 3 for a refusal.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowsProcessTree } from './hub-process.mjs';
import { CorpusError, loadTask } from './load.mjs';
import { PROTOCOL } from './protocol.mjs';
import { checkRoot } from './run-sandbox.mjs';
import {
  SandboxError, applyToCheckout, buildBase, checkPathBudget, checkVariables, checkoutBase, defaultMaxPath, defaultSandboxRoot, inspectBase,
  makeProfile, makeRunFolder, openGit, profileEnvironment, reapTrees, removeRunFolder, runCommand, runSetup, sha256,
} from './sandbox-core.mjs';
import { TarError, readTar } from './tar.mjs';

export const SCORE_FORMAT = 'datgold.corpus-score/1';
export const OUTCOMES = Object.freeze(['pass', 'fail', 'flaky', 'patch_does_not_apply', 'setup_failed']);

/** The checks of the task's acceptance file, in order: [{criterionId, index, run, cwd, timeout, expect: {exit}, repeat}]. */
export function scoringChecks(task) {
  return task.acceptance.criteria.flatMap((criterion) => (criterion.checks ?? []).map((check, index) => ({ criterionId: criterion.id, index, ...check })));
}

/** Writes the hidden files into `dest`; whatever stands at one of their paths (or where one needs a folder) is removed first. */
async function placeHidden(dest, files) {
  const overwritten = [];
  for (const file of files) {
    const parts = file.path.split('/');
    let dir = dest;
    for (const [index, part] of parts.slice(0, -1).entries()) {
      dir = path.join(dir, part);
      const stat = await fs.lstat(dir).catch(() => null);
      if (stat?.isDirectory()) continue;
      if (stat) {
        // a file or a link where a hidden test needs a folder: the hidden tests win, and nothing is written through a link
        overwritten.push(parts.slice(0, index + 1).join('/'));
        await fs.rm(dir, { recursive: true, force: true });
      }
      await fs.mkdir(dir);
    }
    const target = path.join(dir, parts.at(-1));
    if (await fs.lstat(target).then(() => true, () => false)) {
      overwritten.push(file.path);
      await fs.rm(target, { recursive: true, force: true });
    }
    await fs.writeFile(target, file.data, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
  }
  return overwritten;
}

/**
 * Scores one diff of `task` in a clean checkout.
 * @param {object} options
 * @param {object} options.task            a task loaded by loadTask
 * @param {Buffer} options.patch           the agent's diff (run-sandbox.mjs: run.patch), or the oracle patch; empty for no change
 * @param {string} options.hiddenArchive   the task's hidden test archive (its sha256 must be the task's hidden_tests.sha256)
 * @param {string} [options.gitSource]     the local repository that holds the task's commit (Git tasks)
 * @param {number} [options.runs]          how many times the checks run in the checkout (default: the protocol's hidden_test_runs, 3)
 */
export async function scoreCheckout(options = {}) {
  const { task, gitSource, patch, hiddenArchive, signal = null, env = process.env, git: gitExe, processTree = windowsProcessTree, setupTimeoutSeconds, maxPath = defaultMaxPath() } = options;
  if (!task || typeof task !== 'object' || !task.task || !task.acceptance) throw new SandboxError('bad_argument', 'task must be a task loaded by corpus/tools/load.mjs (loadTask)');
  const root = checkRoot(options.root ?? defaultSandboxRoot({ env }));
  if (!Buffer.isBuffer(patch)) throw new SandboxError('bad_argument', 'patch must be the bytes of a diff (a Buffer; empty for no change)');
  const runs = options.runs ?? PROTOCOL.hidden_test_runs;
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new SandboxError('bad_argument', `runs must be a whole number from 1 to 20, not ${runs}`);
  if (typeof hiddenArchive !== 'string' || !hiddenArchive) throw new SandboxError('bad_argument', 'hiddenArchive must be the path of the hidden test archive');
  const extraEnv = checkVariables(options.extraEnv, 'extraEnv');
  const setupCommands = options.setup ?? task.task.setup;
  const checks = scoringChecks(task);
  if (!checks.length) throw new SandboxError('no_checks', `${task.id}: the acceptance file has no check to run (manual criteria only)`);
  const context = await openGit({ exe: gitExe, env });

  let archive;
  try { archive = await fs.readFile(hiddenArchive); } catch (error) {
    if (error?.code === 'ENOENT') throw new SandboxError('hidden_archive_missing', `there is no hidden test archive at ${hiddenArchive}`);
    throw error;
  }
  const hiddenSha256 = sha256(archive);
  if (hiddenSha256 !== task.task.hidden_tests.sha256) {
    throw new SandboxError('hidden_archive_mismatch', `${hiddenArchive} has the sha256 ${hiddenSha256}, the task registered ${task.task.hidden_tests.sha256}`);
  }
  let hidden;
  try { hidden = readTar(archive); } catch (error) {
    if (!(error instanceof TarError)) throw error;
    throw new SandboxError('hidden_archive_invalid', `${hiddenArchive}: ${error.message}`, { tarCode: error.code });
  }

  const layout = await makeRunFolder(root);
  const roots = [];
  let result = null;
  let failure = null;
  try {
    const base = await inspectBase({ task, gitSource, context, layout });
    checkPathBudget({ prefix: layout.work, paths: [...base.paths, ...hidden.map((file) => file.path)], maxPath });
    const built = await buildBase({ base, context, layout });
    await checkoutBase({ base, built, context, layout, dest: layout.work });
    result = {
      format: SCORE_FORMAT, taskId: task.id, baseTree: built.tree, baseCommit: built.commit, patchSha256: sha256(patch), patchBytes: patch.length,
      hiddenSha256, outcome: null, hiddenPass: false, passes: 0, requiredRuns: runs, runs: [], setup: [], applyError: null, overwritten: [],
    };
    const applied = await applyToCheckout({ base, context, layout, dest: layout.work, patch });
    if (!applied.ok) {
      result.outcome = 'patch_does_not_apply';
      result.applyError = applied.error;
    } else {
      await makeProfile(layout);
      const environment = profileEnvironment({ layout, env, extraEnv }).setup;
      result.setup = await runSetup({ commands: setupCommands, dir: layout.work, env: environment, layout, timeoutSeconds: setupTimeoutSeconds, signal, roots });
      if (signal?.aborted) throw new SandboxError('cancelled', 'the scoring was cancelled');
      if (result.setup.some((step) => !step.pass)) result.outcome = 'setup_failed';
      else {
        result.overwritten = await placeHidden(layout.work, hidden);
        for (let number = 1; number <= runs; number += 1) {
          const records = [];
          for (const check of checks) {
            for (let attempt = 1; attempt <= check.repeat; attempt += 1) {
              const step = await runCommand({ command: check.run, dir: layout.work, cwd: check.cwd === '.' ? '' : check.cwd, env: environment, layout, timeoutSeconds: check.timeout, signal, roots });
              const { command, ...rest } = step;
              records.push({ criterionId: check.criterionId, index: check.index, attempt, run: check.run, expectExit: check.expect.exit, ...rest,
                pass: step.exitCode === check.expect.exit && !step.timedOut && !step.cancelled });
            }
          }
          if (signal?.aborted) throw new SandboxError('cancelled', 'the scoring was cancelled');
          result.runs.push({ run: number, pass: records.every((record) => record.pass), checks: records });
        }
        result.passes = result.runs.filter((run) => run.pass).length;
        result.outcome = result.passes === runs ? 'pass' : result.passes === 0 ? 'fail' : 'flaky';
      }
    }
    result.hiddenPass = result.outcome === 'pass';
  } catch (error) {
    failure = error;
  } finally {
    const reaped = await reapTrees(roots, { processTree }).catch(() => ({ leftovers: null }));
    const cleanup = { ...(await removeRunFolder(layout.dir)), leftovers: reaped.leftovers };
    if (failure) failure.cleanup = cleanup;
    else result.cleanup = cleanup;
  }
  if (failure) throw failure;
  return result;
}

// ---- the command line ------------------------------------------------------------------------------------------------------------------

const USAGE = 'usage: node corpus/tools/score-checkout.mjs --task <dir> --hidden <archive> --patch <file> [--git-source <dir>] [--root <dir>] [--runs <n>]';

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--task', '--hidden', '--patch', '--git-source', '--root', '--runs'].includes(flag) || argv[index + 1] === undefined) { stderr.write(`${USAGE}\n`); return 2; }
    options[flag.slice(2)] = argv[index + 1];
  }
  if (!options.task || !options.hidden || !options.patch) { stderr.write(`${USAGE}\n`); return 2; }
  try {
    const task = await loadTask(path.resolve(options.task));
    const score = await scoreCheckout({
      task, gitSource: options['git-source'], root: options.root ? path.resolve(options.root) : undefined, env,
      patch: await fs.readFile(path.resolve(options.patch)), hiddenArchive: path.resolve(options.hidden),
      runs: options.runs === undefined ? undefined : Number(options.runs),
    });
    stdout.write(`${JSON.stringify(score, null, 2)}\n`);
    return score.outcome === 'pass' ? 0 : 1;
  } catch (error) {
    if (!(error instanceof SandboxError) && !(error instanceof CorpusError)) throw error;
    stderr.write(`refused: ${error.message}\n`);
    return 3;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
