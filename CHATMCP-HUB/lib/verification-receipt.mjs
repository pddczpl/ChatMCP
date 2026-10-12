// Execution facts are not test correctness. Never claim that a passing exit
// code certifies assertions, a model claim, or the origin of guest output.
import { createHash } from 'node:crypto';
import { fault, validateExecutionReceipt } from './execution-contract.mjs';
export const hashCheck = (descriptor) => createHash('sha256').update(JSON.stringify({
  workerId: descriptor.workerId, sourceHash: descriptor.sourceHash, command: descriptor.command,
  toolchain: descriptor.toolchain, cwd: descriptor.cwd, policy: descriptor.policy,
})).digest('hex');
export function recordVerificationAttempt({ descriptor, snapshot, execution, attempt, grantId, capturedAt = new Date().toISOString() }) {
  if (!descriptor || !snapshot || !execution) throw fault('invalid_verification', 'Missing content-bound execution evidence.');
  const receipt = validateExecutionReceipt(execution);
  if (receipt.runId !== descriptor.runId || receipt.backend !== 'windows-sandbox' ||
      receipt.snapshotHash !== snapshot.contentHash || receipt.checkHash !== descriptor.checkHash) {
    throw fault('stale_verification', 'Execution receipt identity does not match checked content.');
  }
  return Object.freeze({
    schema: 1, id: receipt.runId, workerId: descriptor.workerId, checkId: descriptor.id,
    grantId, attempt, sourceHash: descriptor.sourceHash, snapshotHash: snapshot.contentHash,
    checkHash: descriptor.checkHash, toolchain: descriptor.toolchain,
    status: receipt.status, exitCode: receipt.exitCode, backend: receipt.backend,
    commandSucceeded: receipt.status === 'completed' && receipt.exitCode === 0,
    testOutcomeVerified: false, // requires independent check parser, not a model assertion
    evidenceClassification: 'execution_observed_tests_unverified',
    startedAt: receipt.startedAt, completedAt: receipt.completedAt, capturedAt,
    truncated: receipt.truncated, reasons: [...receipt.reasons],
    stdoutPreview: receipt.stdout.slice(0, 3000), stderrPreview: receipt.stderr.slice(0, 1500),
  });
}
export function verificationIsFresh(record, { snapshotHash, checkHash, sourceHash }) {
  return Boolean(record && record.snapshotHash === snapshotHash &&
    record.checkHash === checkHash && record.sourceHash === sourceHash);
}
