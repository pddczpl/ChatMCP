// Bounded Code -> Test -> Diagnose -> Repair -> Retest workflow.
// Model narration is never an execution receipt. Missing or forged assertions
// cannot produce ready_for_review. No integration, push, installation or host shell.
import { fault } from './execution-contract.mjs';
export const VERIFIED_CODING_DEFAULTS = Object.freeze({
  maxRepairCycles: 2, maxTestAttempts: 3, maxTotalMs: 20 * 60 * 1000, maxCommandSeconds: 120,
});
export async function runVerifiedCoding({
  workerId, checks, grants, broker, repair, currentContentHash,
  signal, clock = () => Date.now(), onEvent = () => {}, limits = {},
} = {}) {
  if (typeof workerId !== 'string' || !workerId || !Array.isArray(checks) || !checks.length ||
      !Array.isArray(grants) || grants.length !== checks.length || !broker ||
      typeof currentContentHash !== 'function' || typeof repair !== 'function') {
    throw fault('invalid_coding_loop', 'Broker, trusted scoped repair callback, worker and approved check grants are required.');
  }
  const bounds = {};
  for (const key of ['maxRepairCycles','maxTestAttempts','maxTotalMs','maxCommandSeconds']) {
    const requested = limits[key];
    if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) throw fault('invalid_budget', 'Invalid coding budget: ' + key);
    bounds[key] = Math.min(requested ?? VERIFIED_CODING_DEFAULTS[key], VERIFIED_CODING_DEFAULTS[key]);
  }
  bounds.maxRepairCycles = Math.floor(bounds.maxRepairCycles);
  bounds.maxTestAttempts = Math.floor(bounds.maxTestAttempts);
  const deadline = clock() + bounds.maxTotalMs;
  const timeline = [], attempts = [];
  let repairs = 0;
  let status = 'editing';
  const emit = (stage, detail = '') => {
    status = stage;
    const event = Object.freeze({ stage, detail: String(detail).slice(0, 400), at: new Date().toISOString() });
    timeline.push(event); onEvent(event);
  };
  const done = (state, reason) => {
    emit(state, reason);
    return Object.freeze({ workerId, state, reason, repairs, attempts: [...attempts], timeline: [...timeline],
      integrated: false, published: false });
  };
  try {
    for (let round = 0; round < bounds.maxTestAttempts; round++) {
      signal?.throwIfAborted();
      if (clock() >= deadline) return done('needs_attention', 'Total time budget exhausted.');
      emit('testing', 'Attempt ' + (round + 1));
      const roundEvidence = [];
      for (let i = 0; i < checks.length; i++) {
        signal?.throwIfAborted();
        if (clock() >= deadline) return done('needs_attention', 'Deadline reached before all checks.');
        let evidence;
        try {
          evidence = await broker.requestCheck({
            workerId, checkId: checks[i], grantId: grants[i], signal,
          });
        } catch (error) {
          // Infrastructure failures are NOT an invitation to spend repair turns.
          attempts.push({ attempt: round + 1, checkId: checks[i], outcome: 'infrastructure_failed',
            error: String(error.message || error).slice(0, 300) });
          return done('needs_attention', 'Infrastructure or grant failure: ' + String(error.code || error.message));
        }
        if (!evidence || evidence.checkId !== checks[i] || evidence.workerId !== workerId) {
          return done('needs_attention', 'Broker evidence does not match worker/check.');
        }
        const state = evidence.status === 'completed' && evidence.exitCode === 0 &&
          evidence.testOutcomeVerified === true ? 'verified' :
          evidence.status === 'failed' ? 'failed_check' : 'unverified';
        roundEvidence.push({ ...evidence, verdict: state });
        attempts.push({ attempt: round + 1, checkId: checks[i], outcome: state, snapshotHash: evidence.snapshotHash,
          reasons: evidence.reasons || [], receiptId: evidence.id });
        if (state === 'unverified') return done('needs_attention', 'Check result is blocked, unknown or insufficiently verified.');
      }
      const failures = roundEvidence.filter(x => x.verdict !== 'verified');
      if (!failures.length) {
        const expected = roundEvidence[0].snapshotHash;
        if (!expected || roundEvidence.some(x => x.snapshotHash !== expected) ||
            (await currentContentHash(workerId)) !== expected) {
          return done('needs_attention', 'Code has changed since testing; evidence is stale.');
        }
        return done('ready_for_review', 'All required checks have fresh independently verified results.');
      }
      emit('diagnosing', 'Failing checks: ' + failures.map(x => x.checkId).join(', '));
      if (repairs >= bounds.maxRepairCycles || round + 1 >= bounds.maxTestAttempts) {
        return done('needs_attention', 'Repair/test retry budget exhausted.');
      }
      const before = await currentContentHash(workerId);
      emit('repairing', 'One bounded repair iteration');
      const change = await repair({
        workerId, failures: failures.map(x => ({ checkId:x.checkId, status:x.status, reasons:x.reasons })),
        cycle: repairs + 1, signal,
      });
      repairs += 1;
      const after = await currentContentHash(workerId);
      if (!change?.changed || !before || !after || after === before) {
        return done('needs_attention', 'No changed content after repair; unchanged retries require separate approval.');
      }
    }
    return done('needs_attention', 'Maximum number of test attempts reached.');
  } catch (error) {
    if (signal?.aborted) return done('cancelled', 'Stopped by user.');
    return done('needs_attention', 'Coding loop failed: ' + String(error.message || error).slice(0, 200));
  }
}
