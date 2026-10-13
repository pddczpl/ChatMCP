// Windows Sandbox Output Transport and Execution Protocol (Phase 1, PR 2).
//
// Manages the host <-> guest execution protocol:
// 1. Prepares versioned execution requests with cryptographic nonces.
// 2. Reads, verifies, and validates execution receipts returned in the export folder.
// 3. Checks untrusted guest outputs for size, schema, identity correlation and consistency.
// NONCE AND SHA-256 DO NOT AUTHENTICATE THE GUEST: a writer of both receipt files
// can recompute the checksum. Real isolated execution remains BLOCKED until the
// broker proves instance ownership, supervisor identity and safe result publication.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fault, validateExecutionReceipt } from './execution-contract.mjs';

const MAX_RECEIPT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB ceiling for receipt JSON

/**
 * Prepares an immutable execution request in the private input staging directory.
 *
 * @param {object} options
 * @param {string} options.inputDirectory
 * @param {string} options.runId
 * @param {string} options.command
 * @param {string[]} [options.args]
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutSeconds=120]
 * @param {number} [options.maxOutputBytes=102400]
 * @returns {Promise<{ runId: string, nonce: string, requestPath: string }>}
 */
export async function prepareExecutionRequest({
  inputDirectory,
  runId,
  command,
  args = [],
  cwd = null,
  timeoutSeconds = 120,
  maxOutputBytes = 100 * 1024,
}) {
  if (!inputDirectory || !fs.existsSync(inputDirectory)) {
    throw fault('invalid_input_dir', 'Input directory must exist.');
  }

  const nonce = crypto.randomBytes(32).toString('hex');
  const authKey = crypto.randomBytes(32).toString('hex');
  const request = {
    version: 1,
    runId,
    nonce,
    command,
    args: Array.isArray(args) ? [...args] : [],
    cwd: cwd || null,
    timeoutSeconds: Math.max(1, Number(timeoutSeconds) || 120),
    maxOutputBytes: Math.max(1024, Number(maxOutputBytes) || 100 * 1024),
  };

  const requestPath = path.join(inputDirectory, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2), 'utf8');

  return {
    runId,
    nonce,
    authKey,
    requestPath,
  };
}

/**
 * Reads and verifies an execution receipt from the export directory.
 * Fails closed if the receipt is missing, tampered, reparse-linked, oversized, or invalid.
 *
 * @param {object} options
 * @param {string} options.exportDirectory
 * @param {string} options.expectedRunId
 * @param {string} options.expectedNonce
 * @param {string} [options.expectedAuthKey=null] Cryptographic secret shared only with supervisor
 * @param {string} [options.backend='windows-sandbox']
 * @param {boolean} [options.allowUntrustedHostFixture=false] Explicit fixture opt-in
 * @returns {Promise<object>} Validated ExecutionReceipt with provenance metadata
 */
export async function readAndVerifyExecutionReceipt({
  exportDirectory,
  expectedRunId,
  expectedNonce,
  expectedAuthKey = null,
  backend = 'windows-sandbox',
  // Explicit fixture opt-in; NEVER pass this from a model, browser or production worker.
  allowUntrustedHostFixture = false,
}) {
  if (!exportDirectory || !fs.existsSync(exportDirectory)) {
    throw fault('missing_export_dir', `Export directory does not exist: '${exportDirectory}'.`);
  }

  const receiptPath = path.join(exportDirectory, 'receipt.json');
  if (!fs.existsSync(receiptPath)) {
    throw fault('missing_receipt', 'Execution receipt (receipt.json) was not found in export directory.');
  }

  // 1. rawObservation: inspect reparse point / symlink on the receipt file
  const stat = fs.lstatSync(receiptPath);
  if (stat.isSymbolicLink()) {
    throw fault('unsafe_receipt', 'receipt.json is a symbolic link, which is forbidden.');
  }

  // 1. rawObservation: enforce hard file size limit (5 MB)
  if (stat.size > MAX_RECEIPT_FILE_BYTES) {
    throw fault('oversized_receipt', `receipt.json size (${stat.size} bytes) exceeds limit (${MAX_RECEIPT_FILE_BYTES} bytes).`);
  }

  const rawBuffer = fs.readFileSync(receiptPath);
  const rawContent = rawBuffer.toString('utf8');
  const content = rawContent.replace(/^\uFEFF/, '');
  let rawReceipt;
  try {
    rawReceipt = JSON.parse(content);
  } catch (err) {
    throw fault('invalid_receipt_json', `receipt.json is not valid JSON: ${err.message}`);
  }

  // 2. schemaConsistent: Cryptographic identity verification: nonce must strictly match
  if (rawReceipt.nonce !== expectedNonce) {
    throw fault('nonce_mismatch', `Receipt nonce '${rawReceipt.nonce}' does not match expected nonce '${expectedNonce}'.`);
  }

  // 2. schemaConsistent: RunId verification
  if (rawReceipt.runId !== expectedRunId) {
    throw fault('run_id_mismatch', `Receipt runId '${rawReceipt.runId}' does not match expected runId '${expectedRunId}'.`);
  }

  // 2. schemaConsistent: Versioned wire format
  if (rawReceipt.version !== 1) {
    throw fault('unsupported_receipt_version', 'Only version 1 execution receipts are supported.');
  }

  // 2. schemaConsistent: SHA-256 consistency check
  const shaPath = path.join(exportDirectory, 'receipt.sha256');
  if (!fs.existsSync(shaPath)) {
    throw fault('missing_receipt_checksum', 'receipt.sha256 is required for consistency checking.');
  }
  const shaStat = fs.lstatSync(shaPath);
  if (!shaStat.isFile() || shaStat.isSymbolicLink() || shaStat.size > 256) {
    throw fault('unsafe_receipt', 'receipt.sha256 must be a small regular file.');
  }
  const shaContent = fs.readFileSync(shaPath, 'utf8').trim();
  const parsed = /^([0-9a-fA-F]{64})\s+receipt\.json$/.exec(shaContent);
  if (!parsed) throw fault('invalid_receipt_checksum', 'receipt.sha256 has an invalid format.');
  const actualHash = crypto.createHash('sha256').update(rawBuffer).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(parsed[1].toLowerCase()), Buffer.from(actualHash))) {
    throw fault('checksum_mismatch', 'receipt.sha256 does not match receipt.json.');
  }

  // 3. publisherAuthenticated: cryptographic HMAC verification
  let provenance = 'unverified';
  if (expectedAuthKey) {
    if (typeof expectedAuthKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(expectedAuthKey)) {
      throw fault('invalid_auth_key', 'expectedAuthKey must be a 64-character hex string.');
    }
    const sigPath = path.join(exportDirectory, 'receipt.sig');
    if (!fs.existsSync(sigPath)) {
      throw fault('missing_publisher_signature', 'receipt.sig is required for authenticated execution receipts.');
    }
    const sigStat = fs.lstatSync(sigPath);
    if (!sigStat.isFile() || sigStat.isSymbolicLink() || sigStat.size > 256) {
      throw fault('unsafe_receipt', 'receipt.sig must be a small regular file.');
    }
    const sigContent = fs.readFileSync(sigPath, 'utf8').trim();
    const sigParsed = /^([0-9a-fA-F]{64})\s+receipt\.json$/.exec(sigContent);
    if (!sigParsed) {
      throw fault('invalid_publisher_signature', 'receipt.sig has an invalid format.');
    }
    const expectedSig = crypto
      .createHmac('sha256', Buffer.from(expectedAuthKey, 'hex'))
      .update(rawBuffer)
      .digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sigParsed[1].toLowerCase()), Buffer.from(expectedSig))) {
      throw fault('invalid_publisher_signature', 'Publisher signature verification failed; receipt may be forged or tampered by child.');
    }
    provenance = 'publisher_authenticated';
  } else {
    // When no expectedAuthKey is provided, allowUntrustedHostFixture must be strictly boolean true
    if (allowUntrustedHostFixture !== true) {
      throw fault('unverified_guest_origin', 'Receipt consistency checked, but guest origin and supervisor identity are NOT authenticated.');
    }
    provenance = 'untrusted_fixture';
  }

  // 4. testOutcomeVerified
  let status = rawReceipt.status || 'error';
  if (status === 'completed' && rawReceipt.exitCode !== 0) {
    status = 'failed';
  }

  const stdout = typeof rawReceipt.stdout === 'string' ? rawReceipt.stdout : '';
  const stderr = typeof rawReceipt.stderr === 'string' ? rawReceipt.stderr : '';
  const reasons = Array.isArray(rawReceipt.reasons) ? rawReceipt.reasons : [];

  const checked = validateExecutionReceipt({
    runId: rawReceipt.runId,
    status,
    exitCode: typeof rawReceipt.exitCode === 'number' ? rawReceipt.exitCode : null,
    stdout,
    stderr,
    startedAt: rawReceipt.startedAt,
    completedAt: rawReceipt.completedAt,
    durationMs: rawReceipt.durationMs,
    backend,
    truncated: Boolean(rawReceipt.truncated),
    evidencePath: receiptPath,
    reasons,
  });

  return {
    ...checked,
    rawObservation: true,
    schemaConsistent: true,
    publisherAuthenticated: provenance === 'publisher_authenticated',
    provenance,
  };
}
