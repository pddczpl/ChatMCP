// Test execution evidence is not a model assertion. The signed result must
// match immutable source/check hashes. A zero exit code alone never means a
// test suite passed.
import { createHash } from 'node:crypto';
import { fault, validateExecutionReceipt } from './execution-contract.mjs';

export const hashCheck = (descriptor) => createHash('sha256').update(JSON.stringify({
  workerId: descriptor.workerId, sourceHash: descriptor.sourceHash,
  command: descriptor.command, toolchain: descriptor.toolchain,
  cwd: descriptor.cwd, policy: descriptor.policy,
})).digest('hex');

/** Recognizes a positive Node built-in test runner TAP summary. This is not
 * proof that adversarial project assertions were sufficiently comprehensive.
 * Enforce no zero-test, skipped, failed, incomplete or truncated execution.
 */
export function parseNodeTapSummary(stdout) {
  if (typeof stdout !== 'string' || stdout.length > 1024*1024 ||
      !/^TAP version 13\s*$/m.test(stdout)) return null;
  const counts = {};
  for (const name of ['tests','pass','fail','cancelled','skipped','todo']) {
    const matches = [...stdout.matchAll(new RegExp('^# '+name+' ([0-9]{1,8})\\s*$','gm'))];
    if (matches.length !== 1) return null;
    counts[name] = Number(matches[0][1]);
  }
  if (!Number.isSafeInteger(counts.tests) || counts.tests < 1 ||
      counts.pass !== counts.tests || counts.fail !== 0 ||
      counts.cancelled !== 0 || counts.skipped !== 0 ||
      counts.todo !== 0) return null;
  const plans = [...stdout.matchAll(/^1\.\.([0-9]{1,8})\s*$/gm)];
  if (!plans.length || Number(plans.at(-1)[1]) !== counts.tests) return null;
  return Object.freeze({ tests: counts.tests, pass: counts.pass, fail: 0 });
}

export function recordVerificationAttempt({
  descriptor, snapshot, execution, attempt, grantId, capturedAt = new Date().toISOString(),
} = {}) {
  if (!descriptor || !snapshot || !execution) {
    throw fault('invalid_verification','Missing content-bound execution evidence.');
  }
  const receipt = validateExecutionReceipt(execution);
  if (receipt.runId !== descriptor.runId ||
      receipt.backend !== 'windows-sandbox' ||
      receipt.snapshotHash !== snapshot.contentHash ||
      receipt.checkHash !== descriptor.checkHash) {
    throw fault('stale_verification','Execution receipt identity does not match checked content.');
  }
  const publisherAuthenticated = execution.publisherAuthenticated === true &&
    execution.provenance === 'publisher_authenticated';
  const nodeAssertions = publisherAuthenticated &&
    descriptor.command === 'node --test' &&
    receipt.status === 'completed' && receipt.exitCode === 0 &&
    receipt.truncated === false ? parseNodeTapSummary(receipt.stdout) : null;
  return Object.freeze({
    schema:1, id:receipt.runId, workerId:descriptor.workerId, checkId:descriptor.id,
    grantId, attempt, sourceHash:descriptor.sourceHash, snapshotHash:snapshot.contentHash,
    checkHash:descriptor.checkHash, toolchain:descriptor.toolchain,
    status:receipt.status, exitCode:receipt.exitCode, backend:receipt.backend,
    commandSucceeded:receipt.status==='completed' && receipt.exitCode===0,
    publisherAuthenticated, testOutcomeVerified:Boolean(nodeAssertions),
    parsedAssertions:nodeAssertions,
    evidenceClassification:nodeAssertions ? 'signed_execution_with_parsed_node_assertions' :
      'execution_observed_tests_unverified',
    startedAt:receipt.startedAt, completedAt:receipt.completedAt, capturedAt,
    truncated:receipt.truncated, reasons:[...receipt.reasons],
    stdoutPreview:receipt.stdout.slice(0,3000),stderrPreview:receipt.stderr.slice(0,1500),
  });
}
export function verificationIsFresh(record, {snapshotHash,checkHash,sourceHash}) {
  return Boolean(record && record.snapshotHash===snapshotHash &&
    record.checkHash===checkHash && record.sourceHash===sourceHash);
}
