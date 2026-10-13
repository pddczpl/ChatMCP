// Only trusted host orchestration can register a collected native seal. Guest
// files and caller-created lookalike objects never carry publication authority.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fault, validateExecutionReceipt } from './execution-contract.mjs';
import { readBoundedReceiptFile } from './windows-sandbox-transport.mjs';
import { observeUnattestedExitDigest } from './windows-sandbox-exitcode-channel.mjs';
import { BLACKBOX_KIND, BLACKBOX_COMMAND, ZERO_SHA256, validateNativeGraderEvidence } from './native-blackbox-contract.mjs';

export const SEALED_PROTOCOL = 'system-sealed-exit-v1';
const PREFIX = Buffer.from('ChatMCP.G4.SealedReceipt.v1\n', 'ascii');
const collected = new WeakMap();
const SHA = value => createHash('sha256').update(value).digest('hex');

export function sealedReceiptPayload(envelopeBytes, receiptBytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(envelopeBytes.length);
  return Buffer.concat([PREFIX, length, envelopeBytes, receiptBytes]);
}

export function readSealedReceiptBytes(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw fault('unsafe_export_dir', 'Expected a host-owned regular export directory.');
  }
  return readBoundedReceiptFile(path.join(directory, 'receipt.json'), 900 * 1024, 'oversized_receipt');
}

// Called by the driver only after its nine serial, fixed, pinned supervisor
// invocations. This is an internal trusted-code boundary, never an HTTP API.
export function registerSealedCollection({ context, envelopeBytes, receiptBytes, responses }) {
  if (!observeUnattestedExitDigest({
    payload: sealedReceiptPayload(envelopeBytes, receiptBytes), rawResponses: responses,
  }).digestMatches) throw fault('sealed_digest_mismatch', 'Native protected digest does not match the exact exported receipt and request envelope.');
  const raw = Object.freeze({ ...context, publicationProtocol: SEALED_PROTOCOL, publisherAuthenticated: false });
  collected.set(raw, { envelope: JSON.parse(envelopeBytes), receiptBytes: Buffer.from(receiptBytes) });
  return raw;
}

export function verifySealedCollection({ raw, request, snapshot, instanceId, generation }) {
  const entry = collected.get(raw);
  if (!entry) throw fault('untrusted_publisher_context', 'No unconsumed host-owned native seal collection exists.');
  // Consume even a rejected collection: each owned generation may publish once.
  collected.delete(raw);
  const e = entry.envelope;
  if (raw.instanceId !== instanceId || raw.generation !== generation || raw.runId !== request.runId ||
      e.instanceId !== instanceId || e.generation !== generation || e.runId !== request.runId ||
      e.nonce !== raw.expectedNonce || e.snapshotSha256 !== snapshot.contentHash ||
      e.snapshotSha256 !== request.snapshotHash || e.checkSha256 !== request.checkHash ||
      e.testBaselineSha256 !== snapshot.contentHash || !Number.isInteger(raw.cliExitCode)) {
    throw fault('stale_receipt', 'Native publication does not match this owned instance, generation, snapshot, check and nonce.');
  }
  let receipt;
  try { receipt = JSON.parse(entry.receiptBytes.toString('utf8')); }
  catch { throw fault('invalid_receipt_json', 'Sealed receipt is not valid JSON.'); }
  if (receipt.version !== 1 || receipt.runId !== request.runId || receipt.nonce !== e.nonce ||
      receipt.isGuestExecution !== true || receipt.restrictedChild !== true ||
      receipt.jobObjectAttached !== true || receipt.cleanupConfirmed !== true) {
    throw fault('unverified_guest_origin', 'Sealed receipt lacks verified restricted execution and child cleanup.');
  }
  if ((receipt.status === 'completed') !== (receipt.exitCode === 0 && raw.cliExitCode === 0) ||
      (receipt.status !== 'completed' && raw.cliExitCode === 0)) {
    throw fault('contradictory_exit', 'Native process exit and sealed receipt disagree.');
  }
  let grader=null;
  if(request.checkKind===BLACKBOX_KIND) {
    if(request.command!==BLACKBOX_COMMAND || !request.grader ||
        e.graderSha256!==request.grader.manifestSha256 || e.reporterSha256!==ZERO_SHA256)
      throw fault('stale_receipt','Native grader identity differs from the approved public check.');
    grader=validateNativeGraderEvidence(receipt.grader);
    if(grader.manifestSha256!==request.grader.manifestSha256 || grader.cases!==request.grader.caseIds.length ||
        (receipt.status==='completed' && (!grader.valid || grader.passed!==grader.cases || grader.failed!==0 || receipt.truncated)) ||
        (grader.valid && (receipt.status!=='completed' || receipt.exitCode!==0 || raw.cliExitCode!==0 || receipt.truncated)))
      throw fault('invalid_grader_evidence','Native grader result does not match complete approved-case execution.');
  } else if(receipt.grader!=null || e.graderSha256!==ZERO_SHA256) {
    throw fault('invalid_grader_evidence','Legacy execution cannot claim native black-box grading.');
  }
  return Object.freeze({
    publisherAuthenticated: true, testOutcomeVerified: false, provenance: 'publisher_authenticated',
    receipt: validateExecutionReceipt({ ...receipt, backend: 'windows-sandbox',
      snapshotHash: snapshot.contentHash, checkHash: request.checkHash,
      evidencePath: null, reasons: receipt.reasons || [] }),
    publicationProtocol: SEALED_PROTOCOL, envelopeSha256: SHA(JSON.stringify(e)),
    graderAuthenticated:grader!==null,
  });
}
