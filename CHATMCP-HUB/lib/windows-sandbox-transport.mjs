// Windows Sandbox Output Transport and Execution Protocol (Phase 1, PR 2).
//
// Manages the host <-> guest execution protocol:
// 1. Prepares versioned execution requests with cryptographic nonces.
// 2. Reads, verifies, and validates execution receipts returned in the export folder.
// 3. Enforces that receipts are never trusted purely on nonce presence:
//    checks for reparse points, file quotas, schema validity, and checksums.

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
 * @param {string} [options.backend='windows-sandbox']
 * @returns {Promise<object>} Validated ExecutionReceipt
 */
export async function readAndVerifyExecutionReceipt({
  exportDirectory,
  expectedRunId,
  expectedNonce,
  backend = 'windows-sandbox',
}) {
  if (!exportDirectory || !fs.existsSync(exportDirectory)) {
    throw fault('missing_export_dir', `Export directory does not exist: '${exportDirectory}'.`);
  }

  const receiptPath = path.join(exportDirectory, 'receipt.json');
  if (!fs.existsSync(receiptPath)) {
    throw fault('missing_receipt', 'Execution receipt (receipt.json) was not found in export directory.');
  }

  // Security check: inspect reparse point / symlink on the receipt file
  const stat = fs.lstatSync(receiptPath);
  if (stat.isSymbolicLink()) {
    throw fault('unsafe_receipt', 'receipt.json is a symbolic link, which is forbidden.');
  }

  // Security check: enforce hard file size limit
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

  // Cryptographic identity verification: nonce must strictly match
  if (rawReceipt.nonce !== expectedNonce) {
    throw fault('nonce_mismatch', `Receipt nonce '${rawReceipt.nonce}' does not match expected nonce '${expectedNonce}'.`);
  }

  // RunId verification
  if (rawReceipt.runId !== expectedRunId) {
    throw fault('run_id_mismatch', `Receipt runId '${rawReceipt.runId}' does not match expected runId '${expectedRunId}'.`);
  }

  // Checksum verification if receipt.sha256 is present
  const shaPath = path.join(exportDirectory, 'receipt.sha256');
  if (fs.existsSync(shaPath)) {
    const shaContent = fs.readFileSync(shaPath, 'utf8').trim();
    const expectedHash = shaContent.split(/\s+/)[0];
    const actualHash = crypto.createHash('sha256').update(rawBuffer).digest('hex');
    if (expectedHash && expectedHash.toLowerCase() !== actualHash.toLowerCase()) {
      throw fault('checksum_mismatch', `receipt.sha256 mismatch (expected: ${expectedHash}, computed: ${actualHash}).`);
    }
  }

  // Normalize status
  let status = rawReceipt.status || 'error';
  if (status === 'completed' && rawReceipt.exitCode !== 0) {
    status = 'failed';
  }

  const stdout = typeof rawReceipt.stdout === 'string' ? rawReceipt.stdout : '';
  const stderr = typeof rawReceipt.stderr === 'string' ? rawReceipt.stderr : '';
  const reasons = Array.isArray(rawReceipt.reasons) ? rawReceipt.reasons : [];

  return validateExecutionReceipt({
    runId: rawReceipt.runId,
    status,
    exitCode: typeof rawReceipt.exitCode === 'number' ? rawReceipt.exitCode : null,
    stdout,
    stderr,
    startedAt: rawReceipt.startedAt || new Date().toISOString(),
    completedAt: rawReceipt.completedAt || new Date().toISOString(),
    durationMs: typeof rawReceipt.durationMs === 'number' && rawReceipt.durationMs >= 0 ? rawReceipt.durationMs : 0,
    backend,
    truncated: Boolean(rawReceipt.truncated),
    evidencePath: receiptPath,
    reasons,
  });
}
