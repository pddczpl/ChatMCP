// Whether the proof ledger of a task holds a receipt the owner wants to accept an objective with (plan task P5 pod-33, docs/PROOF-HUB-API.md, "Accepting an objective").
//
// The receipts of the agent's progress (lib/agent-progress.mjs, docs/PROOF-RECEIPTS.md) are in the task's file and name the tree they were made on. The ledger
// (./ledger.mjs) is where those trees come from: its last tree is the task's current final tree, and what a receipt says was done on a tree is a record there. A receipt
// that the ledger does not show is refused, and so is every one when the ledger is missing or does not verify: what cannot be checked is not accepted.
import fs from 'node:fs/promises';
import { treeKey } from '../agent-progress.mjs';
import { EXEC_CALL_KIND, ledgerPath, verifyChain } from './ledger.mjs';

/** The codes of a refusal (HTTP 409). */
export const ACCEPT_CODES = Object.freeze({
  unreadable: 'acceptance_ledger_unreadable', treeUnknown: 'acceptance_tree_unknown', stale: 'stale_acceptance_receipt', notHeld: 'acceptance_receipt_not_in_ledger',
});
const MESSAGES = Object.freeze({
  [ACCEPT_CODES.unreadable]: 'Sổ bằng chứng của tác vụ không có hoặc không nguyên vẹn, nên không biên nhận nào được chấp nhận.',
  [ACCEPT_CODES.treeUnknown]: 'Sổ bằng chứng không có cây thư mục cuối của tác vụ, nên không biết biên nhận còn mới hay không.',
  [ACCEPT_CODES.stale]: 'Select a fresh first-party receipt for this criterion.',
  [ACCEPT_CODES.notHeld]: 'Sổ bằng chứng của tác vụ không có thao tác mà biên nhận này nói tới.',
});
const refusal = (code) => ({ code, message: MESSAGES[code] });

/** The trees of a record, oldest first: [before, after] of a run or a call, [tree] of a snapshot; none for a record without trees. */
function treesOf({ type, record }) {
  if (type === 'tree') return [record.tree];
  if (type === 'check' || (type === 'call' && record.kind !== EXEC_CALL_KIND)) return [record.treeBefore, record.treeAfter];
  return [];
}

/** Whether `entry` is the record of what `receipt` says was done on its tree. */
function shows(entry, receipt) {
  const { type, record } = entry;
  const keys = treesOf(entry).map(treeKey);
  const before = keys[0] ?? null;
  const after = keys.at(-1) ?? null;
  // an inspection and a diff review are not scanned: the ledger holds the tree they were made on, from another record
  if (receipt.kind === 'inspect' || receipt.kind === 'review') return keys.includes(receipt.tree);
  const alone = type === 'call' && record.outcome === 'ok' && record.overlapped !== true;
  if (receipt.kind === 'edit') return alone && after === receipt.tree;
  if (before !== receipt.tree || after !== receipt.tree) return false;
  // a passing check: one the done-gate ran (named by its ledger line), or a command of the model that left the tree as it found it
  return type === 'check' ? typeof receipt.id === 'string' && receipt.id.length === 16 && entry.hash.startsWith(receipt.id) : alone && /(?:^|\.)run_command$/.test(record.tool);
}

/** Why `receipt` (of createTaskProgress) cannot be accepted by the ledger of `taskId`: {code, message}, or null when the ledger shows it on the task's current final tree. */
export async function receiptProblem({ hubDir, taskId, receipt }) {
  const bytes = await fs.readFile(ledgerPath(hubDir, taskId)).catch(() => null);
  const report = bytes?.length ? verifyChain(bytes) : null;
  if (!report?.ok) return refusal(ACCEPT_CODES.unreadable);
  const entries = bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const last = entries.findLast((entry) => treesOf(entry).length > 0);
  const current = last ? treeKey(treesOf(last).at(-1)) : null;
  if (current === null) return refusal(ACCEPT_CODES.treeUnknown);
  if (!receipt || receipt.tree !== current) return refusal(ACCEPT_CODES.stale);
  return entries.some((entry) => shows(entry, receipt)) ? null : refusal(ACCEPT_CODES.notHeld);
}
