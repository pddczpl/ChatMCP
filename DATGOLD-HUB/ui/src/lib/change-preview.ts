// What the approval request of a file change carries in `detail.preview` (lib/approval-preview.mjs): for each file what the call would do to it (create, overwrite, edit), the hash of the
// bytes the card was drawn from, how many lines it adds and takes away, and the hunks in the rows of the Review tab. The Hub worked all of it out from the plan the tool writes with;
// this reads it defensively, because it arrives as JSON and the card must never throw on a shape it does not know.
import type { TranslationKey } from './i18n';
import type { DiffRow, RowKind } from './review-hunks';

/** The most files the card draws, whatever the Hub sent (the Hub sends at most 20). */
export const CHANGE_FILES_SHOWN = 20;
/** The most rows of one file the card draws, whatever the Hub sent (the Hub sends at most 200). */
export const CHANGE_ROWS_SHOWN = 200;
/** A row is a line cut at 400 characters by the Hub, plus its line ending; anything longer than this was not sent by the Hub. */
const CHANGE_ROW_CHARS = 410;
const CHANGE_HUNKS_SHOWN = 100;

export type ChangeAction = 'create' | 'overwrite' | 'edit';

export interface ChangeHunk {
  baselineStart: number;
  baselineEnd: number;
  currentStart: number;
  currentEnd: number;
  removed: number;
  added: number;
  /** Only line endings or a byte order mark differ. */
  invisibleOnly: boolean;
  rows: DiffRow[];
}

export interface ChangeFile {
  path: string;
  action: ChangeAction;
  /** sha256 of the file the card was drawn from; null for a file that was not there. */
  baseSha: string | null;
  additions: number;
  deletions: number;
  unchanged: boolean;
  /** The file that is there is not text the tool can read: its old content is not shown and every new line counts as added. */
  oldUnreadable: boolean;
  hunks: ChangeHunk[];
  shownRows: number;
  hiddenRows: number;
  truncated: boolean;
}

export interface ChangePreview {
  files: ChangeFile[];
  fileCount: number;
  hiddenFiles: number;
  truncated: boolean;
  /** The call would be refused when it runs: why. */
  error: { code: string; message: string } | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const ROW_KINDS: ReadonlySet<string> = new Set<RowKind>(['context', 'removed', 'added']);
const ACTIONS: ReadonlySet<string> = new Set<ChangeAction>(['create', 'overwrite', 'edit']);

function parseRow(value: unknown): DiffRow | null {
  if (!isObject(value) || typeof value.kind !== 'string' || !ROW_KINDS.has(value.kind) || typeof value.text !== 'string') return null;
  const omitted = count(value.omitted);
  return { kind: value.kind as RowKind, text: value.text.slice(0, CHANGE_ROW_CHARS), ...(omitted > 0 ? { omitted } : {}) };
}

/** The hunks of one file, with at most CHANGE_ROWS_SHOWN rows between them. */
function parseHunks(value: unknown): ChangeHunk[] {
  if (!Array.isArray(value)) return [];
  const hunks: ChangeHunk[] = [];
  let room = CHANGE_ROWS_SHOWN;
  for (const entry of value.slice(0, CHANGE_HUNKS_SHOWN)) {
    if (room <= 0) break;
    if (!isObject(entry) || !Array.isArray(entry.rows)) continue;
    const rows: DiffRow[] = [];
    for (const row of entry.rows) {
      if (rows.length >= room) break;
      const parsed = parseRow(row);
      if (parsed) rows.push(parsed);
    }
    if (!rows.length) continue;
    room -= rows.length;
    hunks.push({
      baselineStart: count(entry.baselineStart), baselineEnd: count(entry.baselineEnd), currentStart: count(entry.currentStart), currentEnd: count(entry.currentEnd),
      removed: count(entry.removed), added: count(entry.added), invisibleOnly: entry.invisibleOnly === true, rows,
    });
  }
  return hunks;
}

function parseFile(value: unknown): ChangeFile[] {
  if (!isObject(value) || typeof value.path !== 'string' || !value.path) return [];
  const hunks = parseHunks(value.hunks);
  const rows = hunks.reduce((total, hunk) => total + hunk.rows.length, 0);
  const hiddenRows = count(value.hiddenRows);
  return [{
    path: value.path.slice(0, 500),
    action: typeof value.action === 'string' && ACTIONS.has(value.action) ? value.action as ChangeAction : 'edit',
    baseSha: typeof value.baseSha === 'string' && /^[0-9a-f]{64}$/.test(value.baseSha) ? value.baseSha : null,
    additions: count(value.additions),
    deletions: count(value.deletions),
    unchanged: value.unchanged === true,
    oldUnreadable: value.oldUnreadable === true,
    hunks,
    shownRows: value.shownRows === undefined ? rows : count(value.shownRows),
    hiddenRows,
    truncated: value.truncated === true || hiddenRows > 0,
  }];
}

/** The change the request describes, or null when the request does not carry one (an older Hub, or a call that is not a file change). */
export function parseChangePreview(detail: unknown): ChangePreview | null {
  if (!isObject(detail) || !isObject(detail.preview)) return null;
  const raw = detail.preview;
  const refusal = isObject(raw.error) ? raw.error : null;
  const error = refusal
    ? { code: typeof refusal.code === 'string' && refusal.code ? refusal.code.slice(0, 64) : 'local_error', message: typeof refusal.message === 'string' ? refusal.message.slice(0, 600) : '' }
    : null;
  if (!Array.isArray(raw.files) && !error) return null;
  const sent = Array.isArray(raw.files) ? raw.files.flatMap(parseFile) : [];
  const files = sent.slice(0, CHANGE_FILES_SHOWN);
  const fileCount = Math.max(count(raw.fileCount), sent.length);
  const hiddenFiles = Math.max(count(raw.hiddenFiles), fileCount - files.length);
  return { files, fileCount, hiddenFiles, truncated: raw.truncated === true || hiddenFiles > 0 || files.some((file) => file.truncated), error };
}

const REFUSAL_SENTENCES: Readonly<Record<string, TranslationKey>> = {
  not_found: 'agents_apr_changes_why_not_found',
  ambiguous_match: 'agents_apr_changes_why_ambiguous_match',
  bad_edit: 'agents_apr_changes_why_bad_edit',
  stale_revision: 'agents_apr_changes_why_stale_revision',
  file_exists: 'agents_apr_changes_why_file_exists',
  protected_path: 'agents_apr_changes_why_protected_path',
  binary_file: 'agents_apr_changes_why_not_text',
  unsupported_encoding: 'agents_apr_changes_why_not_text',
  invalid_unicode: 'agents_apr_changes_why_not_text',
  symlink: 'agents_apr_changes_why_not_file',
  is_directory: 'agents_apr_changes_why_not_file',
  not_file: 'agents_apr_changes_why_not_file',
  not_directory: 'agents_apr_changes_why_not_file',
  file_too_large: 'agents_apr_changes_why_too_large',
  content_too_large: 'agents_apr_changes_why_too_large',
  bad_content: 'agents_apr_changes_why_bad_request',
  bad_path: 'agents_apr_changes_why_bad_request',
  bad_files: 'agents_apr_changes_why_bad_request',
  bad_revision: 'agents_apr_changes_why_bad_request',
  duplicate_path: 'agents_apr_changes_why_bad_request',
  outside_workspace: 'agents_apr_changes_why_bad_request',
  alternate_stream: 'agents_apr_changes_why_bad_request',
  bad_name: 'agents_apr_changes_why_bad_request',
};

/** The sentence, in the language on screen, for a code the tools refuse with; null for a code the page has no sentence for (the card then shows the Hub's own words). */
export function refusalSentenceKey(code: string): TranslationKey | null {
  return Object.prototype.hasOwnProperty.call(REFUSAL_SENTENCES, code) ? REFUSAL_SENTENCES[code] : null;
}

/** The request without its preview: the technical details below the card stay readable instead of repeating every row of every file. */
export function detailWithoutPreview(detail: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(detail).filter(([key]) => key !== 'preview'));
}
