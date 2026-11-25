// The one way a proof pack is built: from a baseline, the workspace as it is now, an acceptance file and a ledger (plan task pod-33). Two callers: `chatmcp verify pack` and
// `exec` (./cli/commands.mjs), which keep a session of their own, and the Hub at the end of a run (./hub-pack.mjs). Nothing here knows about a session or a task, and
// nothing is written but a scratch folder that is removed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACCEPTANCE_FILE, AcceptanceError, parseAcceptance, resolveAcceptance } from './acceptance.mjs';
import { baselineFolder, diffBaseline, loadBaseline } from './baseline.mjs';
import { findGit } from './git-plumbing.mjs';
import { buildAgentChangeStatement, statementDigest } from './pack.mjs';
import { detectCheckChanges, workTreeSide } from './tamper.mjs';
import { encodePackFile } from './cli/check.mjs';
import { CODES, stop } from './cli/codes.mjs';
import { storeSide } from './cli/store-side.mjs';

const GIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The report on the changes to the checks between the baseline and the workspace as it is now; `scratch` is a folder of the caller's, a fresh folder in it is used and removed. */
async function changesOf({ hubDir, root, env, baseline, parsed, scratch }) {
  const work = path.join(scratch, `work-${randomUUID()}`);
  const { record, entries } = baseline;
  try {
    const baselineSide = await storeSide({
      git: await findGit(), env, storeDir: path.join(baselineFolder(hubDir, root), record.store.directory), entries,
      objectFormat: record.objectFormat, scratch: path.join(work, 'store'),
    });
    const finalSide = await workTreeSide({ root, stateDir: path.join(work, 'final'), env });
    return await detectCheckChanges({ baseline: baselineSide, final: finalSide, acceptance: parsed });
  } finally {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/**
 * Builds the statement and the pack file of a change. Resolves {statement, packBytes, digest, criteria: [{id, status}], diff}.
 *   hubDir, root, baselineId, anchor   the baseline (lib/proof/baseline.mjs) and the sha256 it was taken with
 *   acceptanceBytes, readCurrent       the bytes the change is held to (null: none), and a function that gives those of the workspace now (null: none), read after the diff
 *   ledgerBytes                        the ledger of the session or task
 *   agent, model, cost, secrets        as buildAgentChangeStatement takes them
 *   scratch                            a folder for scratch files (not in the workspace)
 *   checkChanges                       a function that gives the report on the changes to the checks; left out, it is made here from the baseline's store and the workspace
 *   onDiff                             called with the diff before anything is built from it; what it throws stops the build
 *   lock, diffLimits, maxBytes         of the diff and of the pack file
 * Throws the faults of the baseline, CliStop with the codes of `chatmcp verify pack`, PackError, or what `onDiff` and `signal` throw.
 */
export async function buildPackBytes({
  hubDir, root, baselineId, anchor, env = process.env, scratch, acceptanceBytes = null, readCurrent, trustStore, ledgerBytes, agent, model = null, cost = null, secrets = [],
  checkChanges = null, onDiff = () => {}, lock = {}, diffLimits = {}, maxBytes, signal = null,
}) {
  const baseline = await loadBaseline({ hubDir, root, id: baselineId, expectSha256: anchor });
  const { record } = baseline;
  const diff = await diffBaseline({ hubDir, root, id: baselineId, expectSha256: anchor, env, lock, limits: diffLimits, signal });
  onDiff(diff);
  if (diff.patch.status !== 'ok') throw stop(Object.hasOwn(CODES, diff.patch.reason) ? diff.patch.reason : 'baseline_objects_missing', { reason: diff.patch.reason });
  const current = await readCurrent();
  let acceptance;
  let parsedBaseline = null;
  try {
    acceptance = await resolveAcceptance({ baseline: acceptanceBytes, current, trustStore });
    if (acceptanceBytes) parsedBaseline = parseAcceptance(acceptanceBytes);
  } catch (error) {
    if (error instanceof AcceptanceError) throw stop('acceptance_invalid', { file: ACCEPTANCE_FILE, line: error.line ?? null, reason: error.reason ?? error.message });
    throw error;
  }
  const changes = checkChanges ? await checkChanges() : await changesOf({ hubDir, root, env, baseline, parsed: parsedBaseline, scratch });
  signal?.throwIfAborted();
  const statement = buildAgentChangeStatement({
    agent,
    model,
    baseCommit: typeof record.git?.head === 'string' && GIT_ID.test(record.git.head) ? record.git.head : null,
    trees: {
      before: { status: 'ok', treeAlgorithm: record.treeAlgorithm, objectFormat: record.objectFormat, tree: record.tree, rawTree: record.rawTree, ...record.snapshot },
      after: { status: 'ok', ...diff.final },
    },
    diff: diff.patchBytes, acceptance, checkChanges: changes, ledger: ledgerBytes, ownerAcceptances: [], cost, secrets,
  });
  // the pack file (./cli/check.mjs): the statement with the bytes it names, for someone without this state folder
  const packBytes = encodePackFile({ statement, diff: diff.patchBytes, ledger: ledgerBytes, acceptance: acceptanceBytes, maxBytes });
  const criteria = statement.predicate.criteria.map((criterion) => ({ id: criterion.id, status: criterion.status }));
  return { statement, packBytes, digest: statementDigest(statement), criteria, diff };
}
