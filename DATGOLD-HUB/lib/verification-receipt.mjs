// Test execution evidence is not a model assertion. The signed result must
// match immutable source/check hashes. A zero exit code alone never means a
// test suite passed.
import { createHash } from 'node:crypto';
import { fault, validateExecutionReceipt } from './execution-contract.mjs';
import { NODE_TEST_SUMMARY_PREFIX } from './windows-sandbox-node-reporter.mjs';
import { BLACKBOX_KIND, BLACKBOX_COMMAND } from './native-blackbox-contract.mjs';
import { objectiveReceiptId } from './objective-acceptance.mjs';

/** What a check run for an MCP client proves: the Hub saw the command run and end; it never proves that a test suite passed. */
export const MCP_CHECK_EVIDENCE = 'execution_observed_tests_unverified';

/** JSON with the keys of every object in code-unit order, so the same record always has the same digest. */
const canonicalJson = (value) => JSON.stringify(value, (key, item) => (item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item));

/**
 * The receipt of a check the Hub ran for an MCP client (docs/MCP-SERVER.md "Tool profiles", P6 ext-19): the Hub's own record of what it
 * observed (`observed`: the structured result of test_run, or of tasks_status once the task has ended), digested with the tool, the
 * client and the time. `receiptId` is `verify:<step>:<sha256>` (objectiveReceiptId of lib/objective-acceptance.mjs). The client's own text
 * is never part of it, and like every receipt here an exit code alone never makes `testOutcomeVerified`. The receipt is returned with the
 * result; keeping and serving receipts (receipt_get, evidence_pack) is the Proof-of-Done work of P4.
 */
export function mcpCheckReceipt({ tool, client = null, step, observed, at = new Date().toISOString() } = {}) {
  if (typeof tool !== 'string' || !tool) throw fault('invalid_verification', 'A check receipt needs the name of the tool.');
  if (!Number.isSafeInteger(step) || step < 0) throw fault('invalid_verification', 'A check receipt needs a step: a whole number, 0 or more.');
  if (observed === null || typeof observed !== 'object' || Array.isArray(observed)) throw fault('invalid_verification', 'A check receipt needs what was observed (an object).');
  const sha256 = createHash('sha256').update(canonicalJson({ schema: 1, kind: 'verify', tool, client, at, observed })).digest('hex');
  const commandSucceeded = observed.exitCode === 0 && observed.timedOut !== true && observed.cancelled !== true
    && (observed.status === undefined || observed.status === 'completed');
  return Object.freeze({
    schema: 1, kind: 'verify', receiptId: objectiveReceiptId({ kind: 'verify', step, sha256 }), step, tool, client, at, sha256,
    commandSucceeded, testOutcomeVerified: false, evidenceClassification: MCP_CHECK_EVIDENCE,
  });
}

export const hashCheck = (descriptor) => createHash('sha256').update(JSON.stringify({
  workerId: descriptor.workerId, sourceHash: descriptor.sourceHash,
  command: descriptor.command, toolchain: descriptor.toolchain,
  cwd: descriptor.cwd, policy: descriptor.policy,
  ...(descriptor.checkKind ? {checkKind:descriptor.checkKind} : {}),
})).digest('hex');

/** Legacy diagnostic parser only. Node's TAP count includes a passing file
 * wrapper for empty files and process.exit(0), so this must not authorize PASS.
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

/** Recognizes complete registered-test evidence from the pinned reporter.
 * This fixes empty/early-terminated test correctness; it does not authenticate
 * Node child IPC against malicious code or prove that tests contain assertions.
 */
export function parseRegisteredNodeTests(stdout) {
  if (typeof stdout !== 'string' || stdout.length > 1024 * 1024) return null;
  const lines = stdout.trimEnd().split(/\r?\n/);
  const markers = lines.filter(line => line.startsWith(NODE_TEST_SUMMARY_PREFIX));
  if (markers.length !== 1 || lines.at(-1) !== markers[0]) return null;
  let summary;
  try { summary = JSON.parse(markers[0].slice(NODE_TEST_SUMMARY_PREFIX.length)); }
  catch { return null; }
  if (!summary || summary.version !== 1 || summary.valid !== true ||
      !Number.isSafeInteger(summary.tests) || summary.tests < 1 || summary.tests > 10000 ||
      summary.pass !== summary.tests || summary.fail !== 0 ||
      !Number.isSafeInteger(summary.files) || summary.files < 1 || summary.files > summary.tests ||
      !Array.isArray(summary.reasons) || summary.reasons.length ||
      summary.sourceProven !== false || summary.productionAuthenticated !== false) return null;
  return Object.freeze({ tests: summary.tests, pass: summary.pass, fail: 0 });
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
  const registeredTests = publisherAuthenticated &&
    descriptor.command === 'node --test' &&
    receipt.status === 'completed' && receipt.exitCode === 0 &&
    receipt.truncated === false ? parseRegisteredNodeTests(receipt.stdout) : null;
  const nativeGrader = descriptor.checkKind === BLACKBOX_KIND && descriptor.command === BLACKBOX_COMMAND &&
    publisherAuthenticated && execution.graderAuthenticated === true &&
    execution.publicationProtocol === 'system-sealed-exit-v1' &&
    receipt.grader?.manifestSha256 === descriptor.grader?.manifestSha256 &&
    receipt.grader?.cases === descriptor.grader?.caseIds?.length ? receipt.grader : null;
  const nativePass = nativeGrader?.valid === true && nativeGrader.passed === nativeGrader.cases &&
    nativeGrader.failed === 0 && receipt.status === 'completed' && receipt.exitCode === 0 && !receipt.truncated;
  return Object.freeze({
    schema:1, id:receipt.runId, workerId:descriptor.workerId, checkId:descriptor.id,
    grantId, attempt, sourceHash:descriptor.sourceHash, snapshotHash:snapshot.contentHash,
    checkHash:descriptor.checkHash, toolchain:descriptor.toolchain,
    status:receipt.status, exitCode:receipt.exitCode, backend:receipt.backend,
    commandSucceeded:receipt.status==='completed' && receipt.exitCode===0,
    publisherAuthenticated, testOutcomeVerified:Boolean(nativePass),
    parsedAssertions:nativePass ? {tests:nativeGrader.cases,pass:nativeGrader.passed,fail:0} : null,
    registeredTests,
    nativeGrader,
    checkKind:descriptor.checkKind ?? null,
    evidenceClassification:nativePass ? 'native_blackbox_public_cases_verified' :
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
