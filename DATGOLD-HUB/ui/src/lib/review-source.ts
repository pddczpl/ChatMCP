// What a source of review gives the Review tab, as types only: nothing in this file runs. `task-checkpoint` is the source the Review tab will use (GET
// /api/studio/task-review, see docs/REVIEW-API.md); `git-head` and `worker-run` are names for sources to come, and nothing implements them yet. The functions that cut a
// file into hunks and undo one are in review-hunks.ts.
export type ReviewSourceKind = 'task-checkpoint' | 'git-head' | 'worker-run';
export type ReviewChange = 'modified' | 'created' | 'deleted';
export type ReviewFileStatus = ReviewChange | 'binary';
export type TextUnavailable = 'binary' | 'not_utf8' | 'too_large' | 'checkpoint_corrupt' | 'budget' | 'baseline_unavailable';

/** One file of the review, as docs/REVIEW-API.md gives it. A text is the file's bytes: a BOM is its first character and the line endings are as they are. */
export interface ReviewFile {
  path: string;
  status: ReviewFileStatus;
  change: ReviewChange;
  baselineText: string | null;
  currentText: string | null;
  baselineSha: string | null;
  currentSha: string | null;
  /** The baseline is approximate: it comes from a snapshot taken before a command, or from the last commit. */
  partial: boolean;
  accepted: boolean;
  /** A file the task created can be moved out of the way (rejectCreated); nothing else can. */
  rejectable: boolean;
  baselineSource: string;
  checkpointId: string;
  textUnavailable?: TextUnavailable;
}

export interface ReviewLimitation { code: string; message: string }

export interface ReviewSnapshot {
  /** The task the review is about, and how many checkpoints it has: what `task-review` says besides the files; a source that has no task leaves them out. */
  taskId?: string;
  checkpoints?: { total: number; targeted: number; broad: number };
  files: ReviewFile[];
  truncated: boolean;
  omitted: { protected: number };
  limitations: ReviewLimitation[];
}

export interface ReviewSource {
  readonly kind: ReviewSourceKind;
  load(): Promise<ReviewSnapshot>;
  /** Writes the whole text of one file if the file still has the sha that was reviewed, and answers the sha of what is on disk now. A source without it cannot undo a hunk. */
  saveText?(path: string, content: string, expectedSha: string): Promise<{ sha256: string }>;
  /** Records that the file, as it is now, was reviewed. */
  accept?(file: ReviewFile): Promise<void>;
  /** Moves a file the task created out of the way, if it still has the reviewed sha. */
  rejectCreated?(file: ReviewFile): Promise<void>;
}
