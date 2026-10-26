// What the page says about the update notice (lib/update-check.mjs on the Hub): which strip to draw under the header, which link to trust, how long "Check now" waits and how a failure is named.
// Plain functions, so a test can pin the rules without a browser. The words are in the dictionary (lib/i18n.ts, keys upd_*); this file only chooses the key.
//
// The notice tells that a newer release exists and where its notes are; with a signature that checks, the owner can have the Hub download the installer (a click, never by itself). Nothing here
// installs or starts anything. The words are in the dictionary; these functions only choose what to show.
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

export type ErrorGroup = 'network' | 'timeout' | 'http' | 'redirect' | 'answer' | 'save' | 'signature' | 'signature_key' | 'signature_read' | 'other';

const GROUPS: Record<string, ErrorGroup> = {
  update_network: 'network', update_timeout: 'timeout', update_http: 'http',
  update_redirect_refused: 'redirect', update_redirect_limit: 'redirect', update_redirect_invalid: 'redirect',
  update_too_large: 'answer', update_invalid_manifest: 'answer', update_not_a_release: 'answer',
  update_state_unsaved: 'save',
  update_signature_invalid: 'signature', update_signature_unknown_key: 'signature_key', update_signature_unreachable: 'signature_read',
};

/** How a failed check is named (the key is `upd_err_<group>`): what the Hub's diagnostic means to a person. A code the page does not know is "other". */
export function errorGroup(code: unknown): ErrorGroup {
  return typeof code === 'string' && Object.hasOwn(GROUPS, code) ? GROUPS[code] : 'other';
}

const REFUSALS: Record<string, string> = {
  update_skip_stale: 'upd_refused_stale', update_skip_invalid: 'upd_refused_invalid', update_setting_invalid: 'upd_refused_invalid',
  update_save_failed: 'upd_save_failed', update_unavailable: 'upd_refused_unavailable',
};

export type DownloadErrorGroup = 'network' | 'mismatch' | 'disk' | 'write' | 'platform' | 'unsigned' | 'stale' | 'name' | 'other';

const DOWNLOAD_GROUPS: Record<string, DownloadErrorGroup> = {
  update_download_stalled: 'network', update_download_interrupted: 'network', update_download_http: 'network', update_download_redirect: 'network', update_download_unverified: 'network',
  update_download_size: 'mismatch', update_download_hash: 'mismatch', update_download_bad_size: 'name', update_download_disk_full: 'disk', update_download_disk_unknown: 'disk',
  update_download_write: 'write', update_download_save: 'write', update_download_folder: 'write', update_download_platform: 'platform', update_download_unsigned: 'unsigned',
  update_download_stale: 'stale', update_download_not_newer: 'stale', update_download_invalid: 'stale', update_download_no_installer: 'name', update_download_bad_name: 'name',
};

/** How a failed or refused download is named (the key is `upd_dl_err_<group>`). A code the page does not know is "other". */
export function downloadErrorGroup(code: unknown): DownloadErrorGroup {
  return typeof code === 'string' && Object.hasOwn(DOWNLOAD_GROUPS, code) ? DOWNLOAD_GROUPS[code] : 'other';
}

/**
 * The key of the page's own words for a refusal the Hub gave a code of the update notice (the Hub's messages are Vietnamese only, so the English page must not show them as they are).
 * Null for any other code: those are shown as the Hub said them.
 */
export function refusalKey(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  if (Object.hasOwn(REFUSALS, code)) return REFUSALS[code];
  return Object.hasOwn(DOWNLOAD_GROUPS, code) ? `upd_dl_err_${DOWNLOAD_GROUPS[code]}` : null;
}

// ---- the signature and the download ---------------------------------------------------------------------------------------------------------------

export type SignatureView = 'valid' | 'missing' | 'invalid' | 'unknown_key' | 'unreadable' | 'unchecked';

/**
 * What the page says about the signature of the release on offer. Only 'valid' allows a download, and it is what the Hub says in `signature`, nothing the page works out: 'invalid' is told apart
 * when no key this version knows made it (a newer version may), a signature that could not be READ is told apart from one that has not been looked at, and anything the Hub did not say in
 * these words is 'unchecked', never 'valid'.
 */
export function signatureView(update: Pick<UpdateInfo, 'signature' | 'error'> | null | undefined): SignatureView {
  const signature = update?.signature;
  if (signature === 'valid') return 'valid';
  if (signature === 'missing') return 'missing';
  if (signature === 'invalid') return update?.error?.code === 'update_signature_unknown_key' ? 'unknown_key' : 'invalid';
  if (signature === null && update?.error?.code === 'update_signature_unreachable') return 'unreadable';
  return 'unchecked';
}

export type DownloadKind = 'none' | 'offer' | 'blocked' | 'progress' | 'verifying' | 'ready' | 'failed';

export interface DownloadView {
  kind: DownloadKind;
  /** The release the view is about (the one on offer). */
  version: string | null;
  /** The Download button may be shown: the signature checked, the manifest names an installer, and nothing is running or finished. */
  canDownload: boolean;
  /** Why there is no button although a release is on offer: its signature, or its manifest (it names no single installer); null when there is one. */
  reason: 'signature' | 'installer' | null;
  canCancel: boolean;
  /** 0..100, or null while the Hub does not know the size yet. */
  percent: number | null;
  received: number;
  total: number | null;
  /** The size of the installer, from the manifest. */
  bytes: number | null;
  /** For a failure, what went wrong. */
  group: DownloadErrorGroup | null;
  signature: SignatureView;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * What to show for the download of the release on offer. A download state that belongs to another version is nothing here, and a state the page does not understand is read as nothing: the release is
 * then offered (when its signature checked) or explained (when it did not).
 */
export function downloadView(update: UpdateInfo | null | undefined): DownloadView {
  const none: DownloadView = { kind: 'none', version: null, canDownload: false, reason: null, canCancel: false, percent: null, received: 0, total: null, bytes: null, group: null, signature: 'unchecked' };
  if (!isObject(update) || update.available !== true || typeof update.latest !== 'string') return none;
  const version = update.latest;
  const signature = signatureView(update);
  const sized = typeof update.installerBytes === 'number' && Number.isFinite(update.installerBytes) && update.installerBytes >= 0 ? update.installerBytes : null;
  const base: DownloadView = { ...none, version, signature, bytes: sized };
  const download = isObject(update.download) && update.download.version === version ? update.download : null;
  if (download?.state === 'downloading') {
    const total = typeof download.total === 'number' && download.total > 0 ? download.total : null;
    const received = typeof download.received === 'number' ? Math.max(0, download.received) : 0;
    return { ...base, kind: 'progress', canCancel: true, received, total, bytes: total ?? sized, percent: total === null ? null : clamp(Math.floor((received * 100) / total), 0, 100) };
  }
  if (download?.state === 'verifying') return { ...base, kind: 'verifying', canCancel: true };
  if (download?.state === 'ready') return { ...base, kind: 'ready', bytes: typeof download.bytes === 'number' ? download.bytes : sized };
  // a manifest that names no single installer gives the Hub nothing to download: it would refuse the click, so the page does not offer one and says why
  const hasInstaller = typeof update.installerName === 'string' && update.installerName !== '';
  const canDownload = signature === 'valid' && hasInstaller;
  const reason: DownloadView['reason'] = canDownload ? null : (signature !== 'valid' ? 'signature' : 'installer');
  if (download?.state === 'failed') return { ...base, kind: 'failed', canDownload, reason, group: downloadErrorGroup(download.code) };
  return canDownload ? { ...base, kind: 'offer', canDownload: true } : { ...base, kind: 'blocked', reason };
}

/** How often the page asks the Hub for its state: quickly while a download runs, so that the bar moves, and every three seconds otherwise. */
export function pollInterval(update: Pick<UpdateInfo, 'download'> | null | undefined): number {
  const state = update?.download?.state;
  return state === 'downloading' || state === 'verifying' ? 700 : 3000;
}

/** A size for a person: megabytes the way Windows says them (one decimal under ten), kilobytes under one. A dash for anything that is not a size. */
export function formatBytes(bytes: unknown, lang: Lang): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '–';
  if (bytes === 0) return '0 KB';
  const locale = lang === 'en' ? 'en-US' : 'vi-VN';
  const megabytes = bytes / 1048576;
  const shown = megabytes >= 1 ? megabytes : bytes / 1024;
  const digits = shown < 10 ? 1 : 0;
  return `${shown.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${megabytes >= 1 ? 'MB' : 'KB'}`;
}

/** A time for a person, in the language of the page; a dash for anything that is not a time. `timeZone` is for tests. */
export function formatWhen(iso: unknown, lang: Lang, timeZone?: string): string {
  if (typeof iso !== 'string') return '–';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '–';
  return new Date(ms).toLocaleString(lang === 'en' ? 'en-US' : 'vi-VN', { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) });
}
