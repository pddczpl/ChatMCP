// What "undo" means to the page: a plan made from the Hub's preview of a restore (which files go back, which are left alone and why), the words for it, and the words for what
// happened (docs/REVIEW-API.md, "Restoring"). Everything here is plain data in and plain data out: nothing touches the Hub or the screen, and no text is written here, only the
// names of the strings (lib/i18n.ts) with their values.
import type { ToolCall } from '@/types';
import { toolKind } from './tool-labels.ts';

export type RestoreAction = 'overwrite' | 'recreate' | 'remove' | 'unchanged';
export type DoneAction = Exclude<RestoreAction, 'unchanged'>;
export type Shas = Record<string, string | null>;

/** One file of the Hub's preview of a restore. `changedSinceStep` is null when the Hub did not note what the step left. */
export interface PreviewFile {
  path: string;
  kind: 'copy' | 'absent';
  action: RestoreAction;
  baselineSha: string | null;
  currentSha: string | null;
  afterSha?: string | null;
  changedSinceStep: boolean | null;
  willOverwriteNewer?: boolean;
}
export interface Unsupported { path: string; reason: string }
export interface RestorePreview {
  /** The Hub's own "this preview was made"; a preview that says otherwise is refused. */
  ok?: boolean;
  checkpointId?: string | null;
  taskId?: string | null;
  targeted: boolean;
  limitations?: string[];
  files: PreviewFile[];
  unsupported?: Unsupported[];
}

export interface RestoredFile { path: string; action: DoneAction; sha256: string | null }
export interface RestoreConflict { path: string; expectedSha: string | null; currentSha: string | null }
export interface RestoreResult {
  restoredCount: number;
  restored: RestoredFile[];
  unchanged: string[];
  conflicts: RestoreConflict[];
  undoCheckpointId: string | null;
  targeted: boolean;
  unsupported?: Unsupported[];
}

export interface PlanRow {
  path: string;
  action: DoneAction;
  /** The file was changed after the step that made the checkpoint: restoring it takes those later changes with it. */
  changedLater: boolean;
  /** The Hub did not note what the step left, so it cannot tell whether the file changed afterwards. */
  stepUnknown: boolean;
}
export interface RestorePlan {
  rows: PlanRow[];
  /** Files left alone because they changed after the step (or since the review was read). */
  conflicts: string[];
  /** Files that already are what the restore would make them. */
  unchanged: string[];
  /** Files the Hub cannot bring back from a checkpoint, with the reason. */
  unsupported: Unsupported[];
  /** A snapshot taken before a command: it holds source files only, not everything a command can change. */
  incomplete: boolean;
  unknownSteps: number;
  /** The sha each file of `rows` must still have when the restore runs (null: it must not be there). */
  expectedShas: Shas;
}

const emptyPlan = (preview: RestorePreview): RestorePlan => ({ rows: [], conflicts: [], unchanged: [], unsupported: preview.unsupported ?? [], incomplete: !preview.targeted, unknownSteps: 0, expectedShas: {} });

function addRow(plan: RestorePlan, file: PreviewFile, sha: string | null, flags: Pick<PlanRow, 'changedLater' | 'stepUnknown'>) {
  plan.rows.push({ path: file.path, action: file.action as DoneAction, ...flags });
  plan.expectedShas[file.path] = sha;
  if (flags.stepUnknown) plan.unknownSteps += 1;
}

/**
 * Undo one step: the files the step left go back; a file that was changed after the step (by a later step or by the person) is a conflict and is left alone; a file that already is as it
 * was is skipped. A file for which the Hub did not note what the step left goes back too, and the plan says that it could not be checked.
 */
export function planStepUndo(preview: RestorePreview): RestorePlan {
  const plan = emptyPlan(preview);
  for (const file of preview.files) {
    if (file.action === 'unchanged') plan.unchanged.push(file.path);
    else if (file.changedSinceStep === true) plan.conflicts.push(file.path);
    else addRow(plan, file, file.currentSha, { changedLater: false, stepUnknown: file.changedSinceStep === null });
  }
  return plan;
}

/** Restore from a checkpoint the files the person ticked. A file changed after the step that made the checkpoint goes back too (they chose it); the plan says its later changes go with it. */
export function planSelection(preview: RestorePreview, selected: ReadonlySet<string>): RestorePlan {
  const plan = emptyPlan(preview);
  for (const file of preview.files) {
    if (!selected.has(file.path)) continue;
    if (file.action === 'unchanged') plan.unchanged.push(file.path);
    else addRow(plan, file, file.currentSha, { changedLater: file.changedSinceStep === true, stepUnknown: false });
  }
  return plan;
}

/**
 * Undo all the changes of a task: only the files of the review the person is looking at, each expected to have the sha it had when the review was read (`reviewShas`). A file that has
 * another sha now is a conflict; a file the review does not show is not touched.
 */
export function planTaskUndo(preview: RestorePreview, reviewShas: Shas): RestorePlan {
  const plan = emptyPlan(preview);
  for (const file of preview.files) {
    if (!Object.hasOwn(reviewShas, file.path)) continue;
    if (file.action === 'unchanged') plan.unchanged.push(file.path);
    else if (reviewShas[file.path] !== file.currentSha) plan.conflicts.push(file.path);
    else addRow(plan, file, reviewShas[file.path], { changedLater: false, stepUnknown: false });
  }
  return plan;
}

const NAMES_SHOWN = 8;
/** Up to eight names, then how many more (as +n: no word to translate). */
const listOf = (names: readonly string[]) => (names.length <= NAMES_SHOWN ? names.join(', ') : `${names.slice(0, NAMES_SHOWN).join(', ')}, +${names.length - NAMES_SHOWN}`);

export interface Said { key: string; values: Record<string, string | number> }
export interface PlanNote extends Said { tone: 'warn' | 'info' }
export interface PlanWords { details: Said[]; notes: PlanNote[] }

const ROW_KEYS: Record<DoneAction, string> = { overwrite: 'rollback_row_overwrite', recreate: 'rollback_row_recreate', remove: 'rollback_row_remove' };

/** The words for a plan: a line for each file that will change, and a note for everything the person should know before saying yes (most important first). */
export function describePlan(plan: RestorePlan): PlanWords {
  const details = plan.rows.map((row) => ({ key: ROW_KEYS[row.action], values: { path: row.path } }));
  const notes: PlanNote[] = [];
  const note = (tone: PlanNote['tone'], key: string, values: Said['values'] = {}) => notes.push({ tone, key, values });
  if (plan.incomplete) note('warn', 'rollback_note_incomplete');
  if (plan.conflicts.length > 0) note('warn', 'rollback_note_conflicts', { paths: listOf(plan.conflicts), count: plan.conflicts.length });
  if (plan.unsupported.length > 0) note('warn', 'rollback_note_unsupported', { paths: listOf(plan.unsupported.map((entry) => entry.path)), count: plan.unsupported.length });
  if (plan.unknownSteps > 0) note('warn', 'rollback_note_unknown_step', { count: plan.unknownSteps });
  const later = plan.rows.filter((row) => row.changedLater).map((row) => row.path);
  if (later.length > 0) note('warn', 'rollback_note_changed_later', { paths: listOf(later), count: later.length });
  if (plan.rows.length > 0) note('info', 'rollback_note_backup');
  return { details, notes };
}

export interface ResultWords { tone: 'ok' | 'warn'; lines: Said[] }

/**
 * What a restore did, in words: how many files, and the files that were left alone (the ones the plan had already left alone and the ones that changed while it ran, each named once).
 * Nothing restored is never a success.
 */
export function describeResult(result: RestoreResult, left: readonly string[] = []): ResultWords {
  const lines: Said[] = [result.restoredCount > 0 ? { key: result.restoredCount === 1 ? 'rollback_done_one' : 'rollback_done_other', values: { count: result.restoredCount } } : { key: 'rollback_done_none', values: {} }];
  const named = [...new Set([...left, ...result.conflicts.map((conflict) => conflict.path)])];
  if (named.length > 0) lines.push({ key: 'rollback_conflicts_left', values: { paths: listOf(named), count: named.length } });
  return { tone: result.restoredCount > 0 && named.length === 0 ? 'ok' : 'warn', lines };
}

const ERROR_CODES = new Set([
  'task_in_progress', 'stale_state', 'restore_busy', 'checkpoint_corrupt', 'checkpoint_missing', 'undo_backup_incomplete', 'restore_failed_rolled_back', 'restore_partial_failure',
  'restore_verify_failed', 'not_in_checkpoint', 'missing_expected_shas', 'path_escape',
]);

/** The string that says what went wrong, from the code the Hub gave (the page's request helper puts it on the error). A code nobody wrote words for shows the Hub's own message. */
export function restoreErrorKey(error: unknown): Said {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
  if (ERROR_CODES.has(code)) return { key: `rollback_error_${code}`, values: {} };
  return { key: 'rollback_error_generic', values: { message: error instanceof Error ? error.message : '' } };
}

/** What the last restore left, kept so that it can be undone: the backup the Hub made, and the sha each file has now. */
export interface LastRestore { undoCheckpointId: string; files: number; shas: Shas; source: 'step' | 'task' | 'panel' | 'undo'; at: string }

export function lastRestoreOf(result: RestoreResult, source: LastRestore['source'], at: string): LastRestore | null {
  if (!result.undoCheckpointId || result.restored.length === 0) return null;
  return { undoCheckpointId: result.undoCheckpointId, files: result.restored.length, shas: Object.fromEntries(result.restored.map((entry) => [entry.path, entry.sha256])), source, at };
}

/** The request that undoes it: restore the backup, expecting the files to be as the restore left them. */
export function undoRequestOf(last: LastRestore): { checkpointId: string; expectedShas: Shas } {
  return { checkpointId: last.undoCheckpointId, expectedShas: { ...last.shas } };
}

export interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const STORAGE_KEY = 'datgold:last-restore';
const SOURCES = new Set(['step', 'task', 'panel', 'undo']);
const ID = /^[0-9a-f-]{36}$/i;
const SHA = /^[0-9a-f]{64}$/i;

function wellFormed(last: unknown): last is LastRestore {
  const value = last as LastRestore | null;
  if (!value || typeof value !== 'object' || typeof value.undoCheckpointId !== 'string' || !ID.test(value.undoCheckpointId)) return false;
  if (!Number.isInteger(value.files) || value.files <= 0 || !SOURCES.has(value.source) || typeof value.at !== 'string') return false;
  return Boolean(value.shas) && typeof value.shas === 'object' && Object.values(value.shas).every((sha) => sha === null || (typeof sha === 'string' && SHA.test(sha)));
}

/** The last restore of this workspace, from the browser's storage; nothing when there is none, when it is damaged, or when storage is blocked. */
export function readLastRestore(storage: KeyValueStore | null, workspace: string): LastRestore | null {
  try {
    const record = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as { workspace?: unknown; last?: unknown } | null;
    return record && record.workspace === workspace && wellFormed(record.last) ? record.last : null;
  } catch {
    return null;
  }
}

/** Keeps the last restore of this workspace (or forgets it, when it is the one that is kept). Never throws: a page whose storage is blocked still works. */
export function writeLastRestore(storage: KeyValueStore | null, workspace: string, last: LastRestore | null): void {
  try {
    if (!storage) return;
    if (last) storage.setItem(STORAGE_KEY, JSON.stringify({ workspace, last }));
    else {
      const kept = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as { workspace?: unknown } | null;
      if (!kept || kept.workspace === workspace) storage.removeItem(STORAGE_KEY);
    }
  } catch {
    // storage is blocked: the last restore lasts until the page is closed
  }
}

/** Where the receipt of a step leads to an undo: an edit that went through, or a command that ran (it may have changed files before it failed), with the checkpoint the Hub made for that very call. */
export function undoTarget(call: Pick<ToolCall, 'name' | 'status' | 'checkpointId'> | undefined): { checkpointId: string } | null {
  if (!call?.checkpointId) return null;
  const kind = toolKind(call.name);
  const went = kind === 'edit' ? call.status === 'success' : kind === 'run' ? call.status === 'success' || call.status === 'error' : false;
  return went ? { checkpointId: call.checkpointId } : null;
}
