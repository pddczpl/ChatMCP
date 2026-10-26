// What the page says about the update notice (lib/update-check.mjs on the Hub): which strip to draw under the header, which link to trust, how long "Check now" waits and how a failure is named.
// Plain functions, so a test can pin the rules without a browser. The words are in the dictionary (lib/i18n.ts, keys upd_*); this file only chooses the key.
//
// The notice tells that a newer release exists and where its notes are; with a signature that checks, the owner can have the Hub download the installer (a click, never by itself), and inside the
// desktop shell install it (a second click, which the shell checks again with its own code). Nothing here installs or starts anything by itself. The words are in the dictionary; these functions only
// choose what to show.
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

// ---- installing the update (step 3) ----------------------------------------------------------------------------------------------------------------
// The page offers "Install and restart" for an update that is ready, only inside the desktop shell (the page asks the shell, chatmcp.apply-update; in a plain browser there is nothing to ask), and holds it
// back while the Hub is doing work (the installer refuses to stop a Hub that is, and by then the window is gone: the shell asks the Hub first, and so does the page, to disable the button with its reason).

const WORK_STATUS: ReadonlySet<string> = new Set(['running', 'preparing', 'queued', 'planning', 'verifying', 'waiting_approval']);

/** HubLifecycle.HasWork of the shell: the DIRECT properties of an object, and arrays one by one (an object inside an object is not looked into). */
function hasWork(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasWork);
  if (!isObject(value)) return false;
  for (const [name, property] of Object.entries(value)) {
    if ((name === 'activeTaskId' || name === 'activeRunId') && typeof property === 'string' && property !== '') return true;
    if (name === 'activeTaskIds' && Array.isArray(property) && property.length > 0) return true;
    if ((name === 'running' || name === 'integrating') && property === true) return true;
    if ((name === 'status' || name === 'state') && typeof property === 'string' && WORK_STATUS.has(property)) return true;
  }
  return false;
}

/**
 * Whether the Hub is doing work that an update would cut off, from the state the page has (GET /api/state): the rule of HubLifecycle.WorkInState in native-shared/HubLifecycle.cs, which the installer
 * applies before it stops the Hub and the shell applies before it exits, held to the same list of cases (CHATMCP-HUB/tests/fixtures/active-work-cases.json). A state that is not an object, or has no
 * `agent`, or whose `agent` is not an object, is not an idle Hub (the page has not got it yet, or it is not a Hub): fail closed. The coding answer is not part of the state: the shell asks for it too.
 */
export function hasActiveWork(state: unknown): boolean {
  if (!isObject(state) || !isObject(state.agent) || hasWork(state.agent)) return true;
  const studio = state.studio;
  if (isObject(studio)) for (const name of ['terminals', 'delegates', 'dynamicDelegates']) if (name in studio && hasWork(studio[name])) return true;
  return false;
}

/**
 * The step of the owner's click: nothing yet, asked to confirm, waiting for the shell, or refused (with the code the shell gave). A question, the wait and a refusal are about ONE release: the one that was
 * ready when the owner pressed the button. When another release is ready later, the question and the refusal are not about it and are not shown for it.
 */
export type ApplyPhase = { phase: 'idle' } | { phase: 'confirm' | 'sending'; version: string } | { phase: 'refused'; version: string; code: string };
export type ApplyKind = 'hidden' | 'browser' | 'blocked' | 'offer' | 'confirm' | 'sending' | 'refused';
export type ApplyErrorGroup = 'tasks' | 'hub' | 'portable' | 'missing' | 'unproven' | 'nokey' | 'older' | 'busy' | 'launch' | 'no_answer' | 'other';

export interface ApplyView {
  kind: ApplyKind;
  /** The release that would be installed (the one the Hub says is downloaded and checked). */
  version: string | null;
  /** For a refusal, what went wrong. */
  group: ApplyErrorGroup | null;
  /** For a refusal: whether downloading the release again can help, which is what the words of a refusal about a folder that is gone, or does not prove itself, advise. */
  again: boolean;
}

const APPLY_GROUPS: Record<string, ApplyErrorGroup> = {
  tasks_running: 'tasks', hub_unreachable: 'hub', not_installed: 'portable', not_in_shell: 'portable', no_update: 'missing', stale: 'missing', ambiguous: 'missing',
  staging_unsafe: 'unproven', bad_signature: 'unproven', bad_manifest: 'unproven', bad_installer: 'unproven', no_trusted_key: 'nokey', not_newer: 'older', busy: 'busy', launch_failed: 'launch', no_answer: 'no_answer',
};

/** How a refusal of the shell is named (the key is `upd_apply_err_<group>`): what it means to a person. A code the page does not know is "other". */
export function applyErrorGroup(code: unknown): ApplyErrorGroup {
  return typeof code === 'string' && Object.hasOwn(APPLY_GROUPS, code) ? APPLY_GROUPS[code] : 'other';
}

/**
 * What to draw for installing the release that is ready: nothing (no update is ready), a note that the desktop app does it (a plain browser), the button held back with its reason (work is running), the
 * button, the confirm that says the app closes and opens again, the wait for the shell, or the shell's refusal in words (with the button back). `shell` is whether this page runs inside the desktop shell.
 */
export function applyView(update: UpdateInfo | null | undefined, hub: unknown, shell: boolean, apply: ApplyPhase): ApplyView {
  const download = downloadView(update);
  if (download.kind !== 'ready') return { kind: 'hidden', version: null, group: null, again: false };
  const base = { version: download.version, group: null, again: false };
  if (!shell) return { kind: 'browser', ...base };
  if (apply.phase === 'sending') return { kind: 'sending', ...base };
  if (hasActiveWork(hub)) return { kind: 'blocked', ...base };
  // a question and a refusal are about the release the owner pressed the button for: for another one that is ready later the button is offered afresh
  if (apply.phase === 'confirm' && apply.version === download.version) return { kind: 'confirm', ...base };
  if (apply.phase === 'refused' && apply.version === download.version) {
    const group = applyErrorGroup(apply.code);
    return { kind: 'refused', ...base, group, again: APPLY_AGAIN_GROUPS.has(group) };
  }
  return { kind: 'offer', ...base };
}

/** The refusals whose words say "download it again" and for which that can help: the folder is gone or is not the release that was offered, or it does not prove itself. */
const APPLY_AGAIN_GROUPS: ReadonlySet<ApplyErrorGroup> = new Set<ApplyErrorGroup>(['missing', 'unproven']);

export type ApplyEvent = { type: 'ask'; version: string } | { type: 'back' } | { type: 'confirm'; version: string } | { type: 'answered'; result: { ok: true } | { ok: false; code: string } };

/**
 * The steps of the owner's click on Install and restart: the button asks the question about a release (also after a refusal), "back" is "not now" or putting a refusal away, Confirm sends the message, and
 * the shell's answer is either the end (launched: the window is closing, so there is nothing more to show) or a refusal. A question is about a release x.y.z and a confirm is taken only for the release that
 * was asked about. An event that does not belong to the step changes nothing.
 */
export function applyReducer(state: ApplyPhase, event: ApplyEvent): ApplyPhase {
  switch (event.type) {
    case 'ask':
      if (typeof event.version !== 'string' || !RELEASE.test(event.version) || state.phase === 'sending') return state;
      return state.phase === 'confirm' && state.version === event.version ? state : { phase: 'confirm', version: event.version };
    case 'back': return state.phase === 'confirm' || state.phase === 'refused' ? { phase: 'idle' } : state;
    case 'confirm': return state.phase === 'confirm' && event.version === state.version ? { phase: 'sending', version: state.version } : state;
    case 'answered': return state.phase === 'sending' ? (event.result.ok ? state : { phase: 'refused', version: state.version, code: event.result.code }) : state;
    default: return state;
  }
}

/** The page of the notes of a release, built from the version alone; null for anything that is not a release version x.y.z. */
export function notesUrlFor(version: unknown): string | null {
  return typeof version === 'string' && RELEASE.test(version) ? `${NOTES_PREFIX}${version}` : null;
}

const APPLIED_STATES: ReadonlySet<string> = new Set(['installed', 'unchanged', 'rolled_back', 'needs_recovery']);
/** The reasons the installer can write (native-shared/HubLifecycle.cs StepCode.Known); the key of the words is `upd_applied_reason_<code>`. Anything else is a failure to install. */
const APPLIED_REASONS: ReadonlySet<string> = new Set([
  'shell_not_exited', 'no_installation', 'not_newer', 'disk_full', 'pending_recovery', 'tasks_running', 'foreign_listener', 'hub_stop_failed', 'window_open', 'another_update', 'payload_invalid', 'install_failed',
]);

export interface AppliedView {
  kind: 'none' | 'updated' | 'not_updated';
  version: string | null;
  previous: string | null;
  /** The notes of `version`, built by the page; null when it is not a release version. */
  notesUrl: string | null;
  /** The key of the words for what went wrong; null for an update that went through. */
  reasonKey: string | null;
  state: 'installed' | 'unchanged' | 'rolled_back' | 'needs_recovery' | null;
}

/**
 * What the last update left, from `update.applied`: "Updated to x.y.z" or why it did not go through. Read defensively (the Hub checked the file, and the page checks what it is given): anything that is not
 * the shape of a result is nothing, a reason the page has no words for is "the files could not be replaced", and no text of the result is ever drawn.
 */
export function appliedView(update: UpdateInfo | null | undefined): AppliedView {
  const none: AppliedView = { kind: 'none', version: null, previous: null, notesUrl: null, reasonKey: null, state: null };
  const applied = isObject(update) ? update.applied : null;
  if (!isObject(applied) || typeof applied.ok !== 'boolean' || typeof applied.version !== 'string' || !RELEASE.test(applied.version) || typeof applied.state !== 'string' || !APPLIED_STATES.has(applied.state)) return none;
  const previous = typeof applied.previous === 'string' && RELEASE.test(applied.previous) ? applied.previous : null;
  const state = applied.state as AppliedView['state'];
  if (applied.ok) return { kind: 'updated', version: applied.version, previous, notesUrl: notesUrlFor(applied.version), reasonKey: null, state };
  const reason = typeof applied.reason === 'string' && APPLIED_REASONS.has(applied.reason) ? applied.reason : 'install_failed';
  return { kind: 'not_updated', version: applied.version, previous, notesUrl: notesUrlFor(applied.version), reasonKey: `upd_applied_reason_${reason}`, state };
}
