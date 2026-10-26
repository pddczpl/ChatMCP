// What the page says about the update notice (lib/update-check.mjs on the Hub): which strip to draw under the header, which link to trust, how long "Check now" waits and how a failure is named.
// Plain functions, so a test can pin the rules without a browser. The words are in the dictionary (lib/i18n.ts, keys upd_*); this file only chooses the key.
//
// The notice only tells: a newer release exists, and here are its notes. Nothing in this version downloads or starts anything, and nothing here is drawn like a result that was checked.
import type { UpdateInfo } from '../types/index';

export type Lang = 'vi' | 'en';

/** The page of the notes of a release, up to the version: the Hub builds the link from the version it read, and the page insists on the same shape. */
export const NOTES_PREFIX = 'https://github.com/pddczpl/ChatMCP/releases/tag/v';
const RELEASE = /^\d+\.\d+\.\d+$/;
/** The Hub answers a second "Check now" within a minute of the last attempt without asking GitHub (SCHEDULE.minManualGapMs); the page waits the same, and never longer. */
const MANUAL_GAP_MS = 60_000;

export type NoticeKind = 'question' | 'available' | 'none';

/**
 * Which strip to draw: the question while the owner has not answered it (asked once), then a release that is on offer and that the owner did not skip, and nothing otherwise.
 * A state the Hub did not give in full is nothing, not a question.
 */
export function noticeKind(update: UpdateInfo | null | undefined): NoticeKind {
  if (!update || typeof update !== 'object' || !update.autoCheck || typeof update.autoCheck !== 'object') return 'none';
  if (update.autoCheck.needsChoice === true) return 'question';
  if (update.available === true && typeof update.latest === 'string' && update.skippedVersion !== update.latest) return 'available';
  return 'none';
}

/** The link to the notes, only when it is exactly the tag page of the release on offer on the project's GitHub. Anything else is no link. */
export function safeNotesUrl(update: Pick<UpdateInfo, 'latest' | 'notesUrl'> | null | undefined): string | null {
  if (!update || typeof update.latest !== 'string' || typeof update.notesUrl !== 'string') return null;
  return RELEASE.test(update.latest) && update.notesUrl === `${NOTES_PREFIX}${update.latest}` ? update.notesUrl : null;
}

/** Milliseconds until a press of "Check now" would be answered with a request; 0 when it would be now. Never more than the minute, whatever time the state holds. */
export function cooldownMs(update: Pick<UpdateInfo, 'manualCheckAfter'> | null | undefined, now: number): number {
  const after = Date.parse(typeof update?.manualCheckAfter === 'string' ? update.manualCheckAfter : '');
  if (!Number.isFinite(after)) return 0;
  return Math.max(0, Math.min(after - now, MANUAL_GAP_MS));
}

export type StatusKey = 'upd_status_unknown' | 'upd_status_uptodate' | 'upd_status_available' | 'upd_status_skipped';

/** The status line of Settings: nothing known, up to date, a release on offer, or one the owner skipped. */
export function statusKey(update: UpdateInfo | null | undefined): StatusKey {
  if (!update || typeof update.latest !== 'string') return 'upd_status_unknown';
  if (update.available !== true) return 'upd_status_uptodate';
  return update.skippedVersion === update.latest ? 'upd_status_skipped' : 'upd_status_available';
}

export type AutoStatusKey = 'upd_auto_unset' | 'upd_auto_on' | 'upd_auto_off' | 'upd_auto_default_on';

export interface AutoView {
  /** What the checkbox shows: whether the Hub looks by itself. */
  checked: boolean;
  /** Who decided: the owner's yes, the owner's no, nobody yet (the Hub does not look), or nobody but the Hub's default is to look. */
  statusKey: AutoStatusKey;
  /** The Hub has not said what the setting is. */
  disabled: boolean;
}

export function autoView(update: UpdateInfo | null | undefined): AutoView {
  const auto = update?.autoCheck;
  if (!auto || typeof auto.enabled !== 'boolean') return { checked: false, statusKey: 'upd_auto_unset', disabled: true };
  if (auto.saved === true) return { checked: true, statusKey: 'upd_auto_on', disabled: false };
  if (auto.saved === false) return { checked: false, statusKey: 'upd_auto_off', disabled: false };
  return auto.enabled ? { checked: true, statusKey: 'upd_auto_default_on', disabled: false } : { checked: false, statusKey: 'upd_auto_unset', disabled: false };
}

export type ErrorGroup = 'network' | 'timeout' | 'http' | 'redirect' | 'answer' | 'save' | 'other';

const GROUPS: Record<string, ErrorGroup> = {
  update_network: 'network', update_timeout: 'timeout', update_http: 'http',
  update_redirect_refused: 'redirect', update_redirect_limit: 'redirect', update_redirect_invalid: 'redirect',
  update_too_large: 'answer', update_invalid_manifest: 'answer', update_not_a_release: 'answer',
  update_state_unsaved: 'save',
};

/** How a failed check is named (the key is `upd_err_<group>`): what the Hub's diagnostic means to a person. A code the page does not know is "other". */
export function errorGroup(code: unknown): ErrorGroup {
  return typeof code === 'string' && Object.hasOwn(GROUPS, code) ? GROUPS[code] : 'other';
}

const REFUSALS: Record<string, string> = {
  update_skip_stale: 'upd_refused_stale', update_skip_invalid: 'upd_refused_invalid', update_setting_invalid: 'upd_refused_invalid',
  update_save_failed: 'upd_save_failed', update_unavailable: 'upd_refused_unavailable',
};

/**
 * The key of the page's own words for a refusal the Hub gave a code of the update notice (the Hub's messages are Vietnamese only, so the English page must not show them as they are).
 * Null for any other code: those are shown as the Hub said them.
 */
export function refusalKey(code: unknown): string | null {
  return typeof code === 'string' && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : null;
}

/** A time for a person, in the language of the page; a dash for anything that is not a time. `timeZone` is for tests. */
export function formatWhen(iso: unknown, lang: Lang, timeZone?: string): string {
  if (typeof iso !== 'string') return '–';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '–';
  return new Date(ms).toLocaleString(lang === 'en' ? 'en-US' : 'vi-VN', { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) });
}
