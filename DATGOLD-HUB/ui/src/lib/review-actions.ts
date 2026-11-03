// What the Review tab does with a file, against a source of review: put a hunk back, put a file back, accept a file, and the same for every file. Each answers with what happened, never
// with words (the tab turns a kind into text), and none of them throws. A write is always guarded by the sha the file had when it was reviewed, and the writes of a batch are made one
// after the other, never together.
import { rejectAll, rejectHunk } from './review-hunks.ts';
import type { FileDiff } from './review-hunks.ts';
import type { ReviewFile, ReviewSource } from './review-source.ts';
import { conflictKind, fileActions, fileMode, listPaths } from './review-rules.ts';
import type { ConflictKind, ReviewItem, WriteState } from './review-rules.ts';

export type ActionOutcome = { ok: true; sha: string | null; text: string | null } | { ok: false; kind: ConflictKind };

const refused = (): ActionOutcome => ({ ok: false, kind: 'other' });

const failure = (error: unknown): ActionOutcome => ({ ok: false, kind: conflictKind(error) });

async function save(source: ReviewSource, file: ReviewFile, text: string): Promise<ActionOutcome> {
  if (!source.saveText || !file.currentSha) return refused();
  try {
    const saved = await source.saveText(file.path, text, file.currentSha);
    return { ok: true, sha: saved.sha256, text };
  } catch (error) {
    return failure(error);
  }
}

/** Puts one hunk of a text file back: the current text with that hunk undone, saved over the sha that was reviewed. */
export async function rejectHunkOf(source: ReviewSource, file: ReviewFile, diff: FileDiff, index: number): Promise<ActionOutcome> {
  const hunk = diff.hunks[index];
  if (!hunk || fileMode(file) !== 'text') return refused();
  return save(source, file, rejectHunk(diff, hunk.index));
}

/** Puts a whole file back: a text file gets the text it had before the task, a new file is moved away; nothing else can be put back from here. */
export async function rejectFileOf(source: ReviewSource, file: ReviewFile, diff: FileDiff | null): Promise<ActionOutcome> {
  const mode = fileMode(file);
  if (mode === 'created') {
    if (!file.rejectable || !source.rejectCreated || !file.currentSha) return refused();
    try {
      await source.rejectCreated(file);
      return { ok: true, sha: null, text: null };
    } catch (error) {
      return failure(error);
    }
  }
  if (mode !== 'text' || !diff || diff.hunks.length === 0) return refused();
  return save(source, file, rejectAll(diff));
}

/** Records the file, as reviewed, as accepted. */
export async function acceptFileOf(source: ReviewSource, file: ReviewFile): Promise<ActionOutcome> {
  if (!source.accept || !file.currentSha || !file.checkpointId) return refused();
  try {
    await source.accept(file);
    return { ok: true, sha: null, text: null };
  } catch (error) {
    return failure(error);
  }
}

export interface BatchResult {
  /** The paths that were done, in the order of the review. */
  done: string[];
  failed: Array<{ path: string; kind: ConflictKind }>;
  /** Files that were left alone: nothing to do for them, or not allowed now. */
  skipped: number;
}

/** What a batch did: the files that were done, those that failed, and those that were left alone (every file of the review that is neither). */
const tally = (total: number, done: string[], failed: BatchResult['failed']): BatchResult => ({ done, failed, skipped: total - done.length - failed.length });

const record = (outcome: ActionOutcome, path: string, done: string[], failed: BatchResult['failed']) => {
  if (outcome.ok) done.push(path);
  else failed.push({ path, kind: outcome.kind });
};

/** Puts back every file that can be put back, one after the other; a file that fails does not stop the ones after it. */
export async function rejectAllOf(source: ReviewSource, items: readonly ReviewItem[], state: WriteState): Promise<BatchResult> {
  const done: string[] = [];
  const failed: BatchResult['failed'] = [];
  for (const { file, diff } of items) {
    const actions = fileActions(file, state);
    if (!actions.rejectFile || (actions.mode === 'text' && (!diff || diff.hunks.length === 0))) continue;
    record(await rejectFileOf(source, file, diff), file.path, done, failed);
  }
  return tally(items.length, done, failed);
}

/** Asks the Hub to record every file that can be recorded and is not yet; the hunks' marks are the page's own and are made by the caller. */
export async function acceptAllOf(source: ReviewSource, items: readonly ReviewItem[], state: WriteState): Promise<BatchResult> {
  const done: string[] = [];
  const failed: BatchResult['failed'] = [];
  for (const { file } of items) {
    if (!fileActions(file, state).acceptFile || file.accepted) continue;
    record(await acceptFileOf(source, file), file.path, done, failed);
  }
  return tally(items.length, done, failed);
}

/** The lines the status after a batch is made of (the tab turns each key into text): the counts; the files that were saved and are still different once the review was read again; the files that could not be done, by name. */
export type BatchLineKey = 'review_result_all' | 'review_result_all_kept' | 'review_result_all_failed_files';
export interface BatchSummary { tone: 'ok' | 'warn'; lines: Array<{ key: BatchLineKey; values: Record<string, string | number> }> }

export function summarizeBatch(result: BatchResult, kept: readonly string[]): BatchSummary {
  const lines: BatchSummary['lines'] = [{ key: 'review_result_all', values: { done: result.done.length, failed: result.failed.length, skipped: result.skipped } }];
  if (kept.length > 0) lines.push({ key: 'review_result_all_kept', values: { kept: listPaths(kept) } });
  if (result.failed.length > 0) lines.push({ key: 'review_result_all_failed_files', values: { paths: listPaths(result.failed.map((failure) => failure.path)) } });
  return { tone: result.failed.length > 0 || kept.length > 0 ? 'warn' : 'ok', lines };
}
