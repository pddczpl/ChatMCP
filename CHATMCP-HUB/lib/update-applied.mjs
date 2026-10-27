// The hand-over after an update: step 3 of the in-app updater. The installer that the desktop shell starts writes a small result file when it is done (--result, <data>/update-result.json), and the Hub
// that runs next tells the page "Updated to x.y.z", or why the update did not go through and what state DatGold was left in. The Hub never learns this any other way: it was stopped by the installer
// and the new one starts after the file is written.
//
// The file is a contract ACROSS VERSIONS (the installer of any later version may have written it, for the Hub of any earlier one), so it is read as data and by these rules:
//   * once. It is read at start (after this process holds the instance lock, like the cleaning of the folder of updates) and CONSUMED, whatever it holds: a damaged or stale file does not linger and a
//     later start never announces it again. The note lives in memory; dismissing it clears it. The status is memory: reading it touches neither the disk nor the network.
//   * as little as a file can be: at most 4 KiB, a regular file (a link is removed and never followed, a folder is left alone), JSON of format 1 with the shape the installer writes, and consistent: `ok`
//     is true only for the state `installed`, `rolledBack` only for `rolled_back`, and a success has no reason.
//   * for the version that runs. An update that went through counts only in the version it updated to; one that did not counts only in a version older than the one it tried, started from the version that
//     runs now. Anything else is a file from another time and is thrown away.
//   * with words of the page's own. `reason` is one of a closed list of codes (the same the installer writes: native-shared/HubLifecycle.cs StepCode.Known); a code a later installer adds, a text and a
//     path are all shown as "the files could not be replaced". No text of the file is ever shown.
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, isReleaseVersion } from './update-check.mjs';

export const RESULT_FILE = 'update-result.json';
export const FORMAT = 1;
/** What is on disk after the installer: the new files in place, nothing replaced, everything replaced and put back, or an unfinished update the launcher refuses to start behind. */
export const STATES = Object.freeze(['installed', 'unchanged', 'rolled_back', 'needs_recovery']);
export const REASONS = Object.freeze([
  'shell_not_exited', 'no_installation', 'not_newer', 'disk_full', 'pending_recovery', 'tasks_running', 'foreign_listener', 'hub_stop_failed', 'window_open', 'another_update', 'payload_invalid', 'install_failed',
]);
const MAX_BYTES = 4096;

/** The text without a byte order mark in front of it (Windows PowerShell and Notepad write one). */
const withoutByteOrderMark = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The note a file makes, or null when the file is not a result of format 1 of the shape the installer writes. */
function interpret(text) {
  let document;
  try { document = JSON.parse(text); } catch { return null; }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  if (document.format !== FORMAT) return null;
  if (typeof document.ok !== 'boolean' || typeof document.rolledBack !== 'boolean' || !STATES.includes(document.state)) return null;
  if (!isReleaseVersion(document.version)) return null;
  if (document.previous !== null && !isReleaseVersion(document.previous)) return null;
  if (document.ok !== (document.state === 'installed') || document.rolledBack !== (document.state === 'rolled_back')) return null;
  if (document.ok && document.reason !== null) return null;
  const reason = document.ok ? null : (typeof document.reason === 'string' && REASONS.includes(document.reason) ? document.reason : 'install_failed');
  return { ok: document.ok, version: document.version, previous: document.previous, state: document.state, reason, rolledBack: document.rolledBack };
}

/** Whether a note is about the version that runs now (see the rules above). */
function concerns(note, running) {
  try {
    if (note.ok) return compareVersions(note.version, running) === 0 && (note.previous === null || compareVersions(note.previous, note.version) < 0);
    return compareVersions(note.version, running) > 0 && (note.previous === null || note.previous === running);
  } catch { return false; }
}

/**
 * @param {{directory: string, currentVersion: string, log?: (line: string) => void, fsApi?: object}} options `directory` is the Hub's data folder (the one update-check.json is in); `fsApi` is for tests.
 */
export function createAppliedNote({ directory, currentVersion, log = () => {}, fsApi = fs } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('The note of an update needs the data folder of the Hub.');
  const fsp = fsApi.promises;
  const file = path.join(directory, RESULT_FILE);
  let note = null;

  /** Removes the file (a link as a link). Never throws: a file that stays is announced again at the next start, which is better than an update that fails for it. */
  async function consume() {
    try { await fsp.unlink(file); } catch (error) { if (error?.code !== 'ENOENT') log(`Không xóa được tệp kết quả của lần cập nhật (${error?.code ?? 'lỗi'}).`); }
  }

  /** At start, once this process holds the instance lock: reads the file the installer left, keeps the note if it is about this version, and removes the file. Never throws. */
  async function load() {
    note = null;
    let stat;
    try { stat = await fsp.lstat(file); } catch { return; }
    if (stat.isSymbolicLink()) { await consume(); return; }
    if (!stat.isFile()) return;
    let text = null;
    if (stat.size <= MAX_BYTES) {
      try { text = withoutByteOrderMark((await fsp.readFile(file)).toString('utf8')); } catch { text = null; }
    }
    await consume();
    if (text === null) return;
    const read = interpret(text);
    if (read && concerns(read, String(currentVersion))) {
      note = read;
      log(read.ok ? `Lần cập nhật lên ${read.version} đã xong.` : `Lần cập nhật lên ${read.version} không xong (${read.state}, ${read.reason}).`);
    }
  }

  return { load, status: () => (note ? { ...note } : null), dismiss: () => { note = null; }, file };
}
