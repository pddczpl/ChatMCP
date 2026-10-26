// The download of the installer: step 2 of the in-app updater. The Hub fetches the installer of a release that its owner signed, counts it, hashes it and puts it in a folder of its own. It
// installs nothing, moves nothing, opens nothing and runs nothing: the next step does that, and hashes the file again first.
//
// A download starts ONLY from a click of the owner (POST /api/update/download). It never starts from a timer, at start-up, after a check or after the owner said yes to automatic checks; it is allowed
// while agent tasks run (only the step that applies it needs them idle).
//
// What a click does, in this order (the first thing that is wrong ends it, with a code of its own, before anything is written):
//   1. the signature: a newer release with a valid signature must be known (lib/update-check.mjs), and then the release is fetched AGAIN, by its tag, and its signature checked again here: the name of the
//      installer, its size and its SHA-256 come from that manifest and from nothing else (not from the page, not from a saved file, not from the body of the request, which holds the version and no more);
//   2. the platform (the installer is a Windows program) and the version (strictly greater than the one that runs);
//   3. the room on the disk: twice the size (setup stages its payload inside the install folder), looked at before the first byte;
//   4. the bytes: a GET on the address this module makes from the version and the name (https://github.com/pddczpl/ChatMCP/releases/download/v<version>/<name>), redirects by hand (3 at most, https and the
//      default port, only github.com, release-assets.githubusercontent.com and objects.githubusercontent.com), streamed to <data>/updates/<version>/<name>.part with an incremental SHA-256 and NEVER held in
//      memory, with an idle limit of 60 s per stretch of silence instead of a deadline for all of it; the count must equal the manifest's (a short body and a long one both fail), then the hash, then fsync and
//      an atomic rename;
//   5. beside the installer go the signed manifest and its signature, byte for byte (so that the step that runs the installer can verify the signature again by itself, with its own code), and a small
//      state file {version, release, name, bytes, sha256, kid}; the state file is written last, and a folder without a valid one is a leftover.
//
// What "ready" means: the Hub says that these bytes were checked when they arrived. It is the Hub's statement and nothing more: a program that runs with Full Access can write this folder, so the step that
// runs the installer hashes it again, under a handle that nobody can write to, and verifies the signature of the kept manifest again, before it runs anything.
//
// Everything is deleted that is not that: at start-up and after every attempt the folder of updates is cleaned of .part files and of the folders of other versions. Only names that are release versions are
// touched, a link (a junction on Windows) is removed as a link and never followed, and where the folder of updates is itself a link or a file nothing is done at all. The status is memory (no file is read to
// answer it). The module reads no clock: its one timer is the idle one, so a clock that jumps cannot matter, and no time is saved.
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FEED_URL, checkedFeedUrl, compareVersions, fetchReleaseManifest, isReleaseVersion, parseManifest, proveManifest, redirectAllowed, releaseAssetUrl } from './update-check.mjs';
import { SIGNATURE_ASSET, SIGNATURE_LIMITS, verifyManifest } from './release-signature.mjs';

export const UPDATES_FOLDER = 'updates';
export const STATE_FILE_NAME = 'state.json';
export const MANIFEST_COPY = 'RELEASE-MANIFEST.json';
export const SIGNATURE_COPY = SIGNATURE_ASSET;
export const DOWNLOAD = Object.freeze({ idleTimeoutMs: 60_000, maxBytes: 2 * 1024 ** 3, freeSpaceFactor: 2, maxRedirects: 3, renameAttempts: 5 });

const NAME = /^[A-Za-z0-9._-]{1,100}\.exe$/;
const DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const VERSION_FOLDER = /^\d+\.\d+\.\d+$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const RETRY_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const MANIFEST_LIMIT = 64 * 1024;

export class DownloadError extends Error {
  /** `code` is what the page says in its own words; `statusCode` is what the route answers. */
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
const refusal = (code, message, statusCode) => new DownloadError(code, message, statusCode);

/** A failure inside a download: its code is the one the status will carry. */
class Failure extends Error {
  constructor(code) { super(code); this.name = 'Failure'; this.code = code; }
}

/**
 * Why a name cannot be the name of the installer, or null. 1 to 100 characters of A-Z a-z 0-9 . _ - and then ".exe"; it starts with a letter or a digit, has no two dots in a row, and its first part
 * (up to the first dot) is not the name of a device of Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9), which Windows opens whatever follows it. Nothing that has a slash, a colon or a space gets through.
 */
export function installerNameProblem(name) {
  if (typeof name !== 'string') return 'type';
  if (!NAME.test(name)) return 'shape';
  if (!/^[A-Za-z0-9]/.test(name)) return 'start';
  if (name.includes('..')) return 'dots';
  if (DEVICE.test(name.split('.')[0])) return 'device';
  return null;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function statfsFree(directory) {
  const info = await fs.promises.statfs(directory);
  return Number(info.bavail) * Number(info.bsize);
}

/**
 * @param {{directory: string, currentVersion: string, feedUrl?: string, releaseKeys?: object[], offer?: () => object, log?: (line: string) => void, platform?: string,
 *   freeBytes?: (directory: string) => Promise<number>, idleTimeoutMs?: number, timeoutMs?: number, fsApi?: object, renameDelayMs?: number}} options
 *   `directory` is the Hub's data folder (the one update-check.json is in). `offer` says what the update notice knows ({latest, available, signature}). `platform`, `freeBytes`, `idleTimeoutMs`,
 *   `timeoutMs`, `fsApi` and `renameDelayMs` are for tests; the Hub passes the others.
 */
export function createUpdateDownloader({
  directory, currentVersion, feedUrl = FEED_URL, releaseKeys = [], offer = () => ({ latest: null, available: false, signature: null }), log = () => {}, platform = process.platform,
  freeBytes = statfsFree, idleTimeoutMs = DOWNLOAD.idleTimeoutMs, timeoutMs, fsApi = fs, renameDelayMs = 100,
} = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('The download needs the data folder of the Hub.');
  const feed = checkedFeedUrl(feedUrl);
  const fsp = fsApi.promises;
  const root = path.join(directory, UPDATES_FOLDER);
  const running = String(currentVersion);
  const userAgent = /^[0-9A-Za-z.+-]{1,64}$/.test(running) ? `DatGold/${running}` : 'DatGold';

  let state = { state: 'idle' };
  let job = null; // the download that is running: {version, controller, done}
  let starting = false; // a click is being looked at: nothing else may start
  let cancelWanted = false;

  const snapshot = () => ({ ...state });

  // ------------------------------------------------------------------------------------------------------------------------------- the folder of updates
  async function lstatOrNull(file) {
    try { return await fsp.lstat(file); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }

  /** The folder of updates exists and is a plain folder (not a link, not a file): made if it is not there. Refused otherwise, before anything is written through it. */
  async function ensureRoot() {
    let stat;
    try { stat = await lstatOrNull(root); } catch { throw refusal('update_download_folder', 'The folder for updates cannot be looked at.', 500); }
    if (stat === null) {
      try { await fsp.mkdir(root, { recursive: true }); } catch { throw refusal('update_download_folder', 'The folder for updates cannot be made.', 500); }
      return;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw refusal('update_download_folder', 'The folder for updates is a link or a file, so nothing is written there.', 500);
  }

  /** Removes one thing under the folder of updates: a link as a link (never followed), a folder with what is in it, a file. Never throws. */
  async function removeEntry(file) {
    try {
      const stat = await lstatOrNull(file);
      if (stat === null) return;
      if (stat.isSymbolicLink() || !stat.isDirectory()) await fsp.unlink(file);
      else await fsp.rm(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) { log(`Không xóa được một mục thừa trong thư mục cập nhật (${error?.code ?? 'lỗi'}).`); }
  }

  /** In the folder that is kept: a .part file and a link are leftovers. */
  async function tidy(folder) {
    let names;
    try { names = await fsp.readdir(folder); } catch { return; }
    for (const name of names) {
      const file = path.join(folder, name);
      const stat = await lstatOrNull(file).catch(() => null);
      if (stat && (name.endsWith('.part') || stat.isSymbolicLink())) await removeEntry(file);
    }
  }

  /** Every version folder under the folder of updates except `keep`; only names that are release versions are touched. */
  async function clearRoot(keep = null) {
    let names;
    try { names = await fsp.readdir(root); } catch { return; }
    for (const name of names) if (VERSION_FOLDER.test(name) && name !== keep) await removeEntry(path.join(root, name));
  }

  /** What a folder of a finished download proves by its own files, or null: the state file field by field, the signed manifest and its signature checked again, the installer's size. */
  async function inspect(version) {
    const folder = path.join(root, version);
    try {
      const read = async (name, limit) => {
        const file = path.join(folder, name);
        const stat = await fsp.lstat(file);
        if (!stat.isFile() || stat.size > limit) throw new Error('not a file');
        return fsp.readFile(file);
      };
      const saved = JSON.parse((await read(STATE_FILE_NAME, 4096)).toString('utf8').replace(/^﻿/, ''));
      if (!isPlainObject(saved) || saved.version !== 1 || saved.release !== version || !isReleaseVersion(version)) return null;
      if (installerNameProblem(saved.name) !== null) return null;
      if (!Number.isSafeInteger(saved.bytes) || saved.bytes < 1 || saved.bytes > DOWNLOAD.maxBytes) return null;
      if (typeof saved.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(saved.sha256)) return null;
      if (typeof saved.kid !== 'string' || !/^[0-9a-f]{8}$/.test(saved.kid)) return null;
      if (compareVersions(version, running) <= 0) return null;
      const manifestBytes = await read(MANIFEST_COPY, MANIFEST_LIMIT);
      const signatureBytes = await read(SIGNATURE_COPY, SIGNATURE_LIMITS.maxBytes);
      if (verifyManifest(manifestBytes, signatureBytes, releaseKeys).kid !== saved.kid) return null;
      const manifest = parseManifest(manifestBytes.toString('utf8'));
      const listed = manifest.installer;
      if (manifest.version !== version || !listed || listed.name !== saved.name || listed.bytes !== saved.bytes || listed.sha256 !== saved.sha256) return null;
      const installer = await fsp.lstat(path.join(folder, saved.name));
      if (!installer.isFile() || installer.size !== saved.bytes) return null;
      return { version, bytes: saved.bytes };
    } catch { return null; }
  }

  /** At start-up: what a Hub that was killed left is deleted, what is finished and proves itself is kept (the newest of them), and the rest goes. Makes nothing if there is no folder. */
  async function load() {
    state = { state: 'idle' };
    let stat;
    try { stat = await lstatOrNull(root); } catch { return snapshot(); }
    if (stat === null) return snapshot();
    if (stat.isSymbolicLink() || !stat.isDirectory()) { log('Thư mục cập nhật là một liên kết hoặc một tệp, nên không đụng vào.'); return snapshot(); }
    let names;
    try { names = await fsp.readdir(root); } catch { return snapshot(); }
    const finished = [];
    for (const name of names) {
      if (!VERSION_FOLDER.test(name)) continue; // not ours
      const file = path.join(root, name);
      const entry = await lstatOrNull(file).catch(() => null);
      if (entry === null) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) { await removeEntry(file); continue; }
      const found = await inspect(name);
      if (found) finished.push(found); else await removeEntry(file);
    }
    finished.sort((a, b) => compareVersions(b.version, a.version));
    const [best, ...rest] = finished;
    for (const old of rest) await removeEntry(path.join(root, old.version));
    if (best) {
      await tidy(path.join(root, best.version));
      state = { state: 'ready', version: best.version, bytes: best.bytes };
      log(`Bản cập nhật ${best.version} đã tải về từ trước và còn nguyên.`);
    }
    return snapshot();
  }

  // ------------------------------------------------------------------------------------------------------------------------------- the click
  /** The room on the disk, in bytes; throws a refusal where it cannot be told. */
  async function room() {
    let free;
    try { free = await freeBytes(root); } catch { free = Number.NaN; }
    if (typeof free !== 'number' || !Number.isFinite(free) || free < 0) throw refusal('update_download_disk_unknown', 'The room on the disk cannot be measured, so nothing is downloaded.', 500);
    return free;
  }

  /** Looks at the release again, by its tag: the manifest, then its signature. Returns what the download is made from. */
  async function verifyAgain(version) {
    const unverified = () => refusal('update_download_unverified', 'The release could not be looked at again, so nothing is downloaded.', 502);
    let answer;
    try { answer = await fetchReleaseManifest({ feed, version, userAgent, timeoutMs }); } catch { throw unverified(); }
    let manifest;
    try { manifest = parseManifest(answer.text); } catch { throw unverified(); }
    if (manifest.version !== version) throw refusal('update_download_stale', 'The release at this tag is not the one that was offered.', 409);
    let proof;
    try { proof = await proveManifest({ feed, version, manifestBytes: answer.bytes, keys: releaseKeys, userAgent, timeoutMs }); } catch { throw unverified(); }
    if (proof.state !== 'valid') throw refusal('update_download_unsigned', 'The signature of the release does not check any more, so nothing is downloaded.', 409);
    return { manifest, manifestBytes: answer.bytes, signatureBytes: proof.signature, kid: proof.kid };
  }

  /**
   * The owner's click. `body` holds the version the page showed and nothing else is read. Resolves {started, status}: `started` is false when a download is already running or finished for this
   * version (a second click changes nothing). Rejects with a DownloadError for a refusal; the status is not changed by a refusal.
   */
  async function start(body) {
    const version = isPlainObject(body) ? body.version : undefined;
    if (!isReleaseVersion(version)) throw refusal('update_download_invalid', 'version must be a release x.y.z.', 400);
    if (starting || job) return { started: false, status: snapshot() };
    if (state.state === 'ready' && state.version === version) return { started: false, status: snapshot() };
    const known = offer() ?? {};
    if (known.latest !== version) throw refusal('update_download_stale', 'That is not the release that is on offer.', 409);
    if (known.signature !== 'valid') throw refusal('update_download_unsigned', 'The release is not signed with a valid signature, so nothing is downloaded.', 409);
    if (platform !== 'win32') throw refusal('update_download_platform', 'The installer is a Windows program; this system cannot use it.', 501);
    if (known.available !== true || compareVersions(version, running) <= 0) throw refusal('update_download_not_newer', 'That release is not newer than the one that runs.', 409);

    const previous = snapshot();
    starting = true;
    cancelWanted = false;
    state = { state: 'downloading', version, received: 0, total: null };
    try {
      const proven = await verifyAgain(version);
      if (compareVersions(proven.manifest.version, running) <= 0) throw refusal('update_download_not_newer', 'That release is not newer than the one that runs.', 409);
      const installer = proven.manifest.installer;
      if (!installer) throw refusal('update_download_no_installer', 'The release does not name exactly one installer.', 409);
      if (installerNameProblem(installer.name) !== null) throw refusal('update_download_bad_name', 'The name of the installer is not one that is accepted.', 409);
      if (!Number.isSafeInteger(installer.bytes) || installer.bytes < 1 || installer.bytes > DOWNLOAD.maxBytes) throw refusal('update_download_size', 'The size of the installer is out of range.', 409);
      await ensureRoot();
      const free = await room();
      if (free < installer.bytes * DOWNLOAD.freeSpaceFactor) throw refusal('update_download_disk_full', 'There is not enough room on the disk for the installer and for setting it up.', 507);
      if (cancelWanted) { state = { state: 'idle' }; return { started: false, status: snapshot() }; }
      const controller = new AbortController();
      const plan = { version, name: installer.name, bytes: installer.bytes, sha256: installer.sha256, kid: proven.kid, manifestBytes: proven.manifestBytes, signatureBytes: proven.signatureBytes };
      state = { state: 'downloading', version, received: 0, total: plan.bytes };
      job = { version, controller, done: null };
      job.done = run(plan, controller).finally(() => { job = null; });
      return { started: true, status: snapshot() };
    } catch (error) {
      state = previous;
      throw error;
    } finally { starting = false; }
  }

  // ------------------------------------------------------------------------------------------------------------------------------- the bytes
  /** One GET, resolved when the headers are in: {status, location} for anything but 200 (the body is not read), {status, response, request} for 200. */
  function requestOnce(target, signal, flags, expected) {
    return new Promise((resolve, reject) => {
      const client = target.protocol === 'https:' ? https : http;
      const request = client.request(target, { method: 'GET', agent: false, headers: { 'user-agent': userAgent, accept: 'application/octet-stream' } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          resolve({ status, location: REDIRECTS.has(status) ? String(response.headers.location ?? '') : '' });
          request.destroy();
          return;
        }
        const declared = response.headers['content-length'];
        if (declared !== undefined && Number(declared) !== expected) { request.destroy(); reject(new Failure('update_download_size')); return; }
        request.on('error', () => {}); // from here a failure reaches the pipeline through the response
        resolve({ status, response, request });
      });
      // idle: a stretch of silence on the connection, whatever the hop. There is no deadline for all of it.
      request.setTimeout(idleTimeoutMs, () => { flags.stalled = true; request.destroy(); });
      request.on('error', () => reject(flags.stalled ? new Failure('update_download_stalled') : new Failure('update_download_interrupted')));
      const onAbort = () => request.destroy();
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      request.end();
    });
  }

  /** The installer's response: redirects followed by hand (3 at most, only where redirectAllowed says), anything but a 200 is a failure. */
  async function open(plan, signal, flags) {
    let target = new URL(releaseAssetUrl(feed, plan.version, plan.name));
    for (let hops = 0; ; hops += 1) {
      const answer = await requestOnce(target, signal, flags, plan.bytes);
      if (REDIRECTS.has(answer.status)) {
        if (!answer.location || hops >= DOWNLOAD.maxRedirects) throw new Failure('update_download_redirect');
        let next;
        try { next = new URL(answer.location, target); } catch { throw new Failure('update_download_redirect'); }
        if (!redirectAllowed(next, feed)) throw new Failure('update_download_redirect');
        target = next;
        continue;
      }
      if (answer.status !== 200) throw new Failure('update_download_http');
      return answer;
    }
  }

  async function renameWhole(from, to) {
    for (let attempt = 1; ; attempt += 1) {
      try { await fsp.rename(from, to); return; } catch (error) {
        if (!RETRY_RENAME.has(error?.code) || attempt >= DOWNLOAD.renameAttempts) throw error;
        await delay(renameDelayMs * attempt); // the antivirus may hold a file it has just seen written
      }
    }
  }

  /** Writes a file whole: a temporary file beside it, then a rename. */
  async function writeWhole(file, content) {
    const temporary = `${file}.tmp`;
    await fsp.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await fsp.rename(temporary, file);
  }

  /** What failure a thing that went wrong is. */
  function failureOf(error, flags) {
    if (error instanceof Failure) return error.code;
    if (flags.stalled) return 'update_download_stalled';
    const code = error?.code;
    if (code === 'ENOSPC' || code === 'EDQUOT') return 'update_download_disk_full';
    if (['EACCES', 'EPERM', 'EBUSY', 'EROFS', 'EMFILE', 'EIO', 'ENOENT', 'ENAMETOOLONG', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(code)) return 'update_download_write';
    return 'update_download_interrupted';
  }

  /** The whole download. Never rejects: it ends in `ready`, `failed` or (cancelled) `idle`, with nothing left behind unless it is ready. */
  async function run(plan, controller) {
    const { signal } = controller;
    const folder = path.join(root, plan.version);
    const part = path.join(folder, `${plan.name}.part`);
    const flags = { stalled: false };
    let handle = null;
    let out = null;
    try {
      await clearRoot(); // whatever an earlier attempt left, and the folders of other versions
      try { await fsp.mkdir(folder); } catch (error) { throw Object.assign(new Failure(failureOf(error, flags)), { cause: error }); }
      try { handle = await fsp.open(part, 'wx', 0o600); } catch (error) { throw new Failure(failureOf(error, flags)); }
      log(`Bắt đầu tải bản cập nhật ${plan.version} (${plan.bytes} byte).`);
      const answer = await open(plan, signal, flags);
      const hash = createHash('sha256');
      let received = 0;
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          if (received > plan.bytes) { callback(new Failure('update_download_size')); return; }
          hash.update(chunk);
          state = { state: 'downloading', version: plan.version, received, total: plan.bytes };
          callback(null, chunk);
        },
      });
      // autoClose is off so that the file can be flushed (fsync) before it is closed: destroying the stream is what closes the handle, so that comes after the flush
      out = handle.createWriteStream({ autoClose: false });
      try { await pipeline(answer.response, counter, out, { signal }); } catch (error) {
        out.destroy();
        if (signal.aborted) throw new Failure('cancelled');
        throw new Failure(failureOf(error, flags));
      }
      if (received !== plan.bytes) throw new Failure('update_download_size');
      state = { state: 'verifying', version: plan.version };
      if (hash.digest('hex') !== plan.sha256) throw new Failure('update_download_hash');
      try {
        await handle.sync();
        await new Promise((resolve) => { out.once('close', resolve); out.destroy(); }); // the stream closes the handle it was made from
        await handle.close(); // already closed by the stream: a second close does nothing
      } catch (error) { throw new Failure(failureOf(error, flags)); } finally { handle = null; }
      if (signal.aborted) throw new Failure('cancelled');
      try { await renameWhole(part, path.join(folder, plan.name)); } catch (error) { throw new Failure(failureOf(error, flags) === 'update_download_disk_full' ? 'update_download_disk_full' : 'update_download_write'); }
      try {
        await fsp.writeFile(path.join(folder, MANIFEST_COPY), plan.manifestBytes, { flag: 'wx', mode: 0o600 });
        await fsp.writeFile(path.join(folder, SIGNATURE_COPY), plan.signatureBytes, { flag: 'wx', mode: 0o600 });
        await writeWhole(path.join(folder, STATE_FILE_NAME), `${JSON.stringify({ version: 1, release: plan.version, name: plan.name, bytes: plan.bytes, sha256: plan.sha256, kid: plan.kid }, null, 2)}\n`);
      } catch { throw new Failure('update_download_save'); }
      state = { state: 'ready', version: plan.version, bytes: plan.bytes };
      log(`Bản cập nhật ${plan.version} đã tải xong, đủ ${plan.bytes} byte và khớp SHA-256 đã ký.`);
    } catch (error) {
      if (out) out.destroy(); // a stream that is left alone holds a reference on the handle, and close() would wait for it for ever
      if (handle) { try { await handle.close(); } catch { /* it is being removed */ } }
      await removeEntry(folder);
      const code = error instanceof Failure ? error.code : failureOf(error, flags);
      if (code === 'cancelled') { state = { state: 'idle' }; log('Đã hủy tải bản cập nhật.'); } else {
        state = { state: 'failed', version: plan.version, code };
        log(`Tải bản cập nhật ${plan.version} không thành công (${code}).`);
      }
    }
    await clearRoot(state.state === 'ready' ? plan.version : null); // after every attempt
  }

  // ------------------------------------------------------------------------------------------------------------------------------- stopping
  /** Stops the download that runs (the owner's Cancel): its connection is closed, its files are removed and the status is idle. */
  async function cancel() {
    if (starting && !job) { cancelWanted = true; return { cancelled: true, status: snapshot() }; }
    if (!job) return { cancelled: false, status: snapshot() };
    const current = job;
    current.controller.abort();
    await current.done;
    return { cancelled: true, status: snapshot() };
  }

  /**
   * The update notice has changed its mind (a check finished): a download that runs, or one that is ready, is dropped when the release it belongs to is not the one on offer any more (another version,
   * no longer newer, its signature withdrawn or not checking). A signature that could not be READ says nothing about the release, and neither does a notice that knows nothing: those keep it.
   */
  async function reconcile() {
    const subject = job?.version ?? (state.state === 'ready' ? state.version : null);
    if (subject === null) return;
    const known = offer() ?? {};
    const departed = known.latest !== null && known.latest !== undefined && known.latest !== subject;
    const withdrawn = known.latest !== null && known.latest !== undefined && known.available === false;
    const unsigned = known.signature === 'missing' || known.signature === 'invalid';
    if (!departed && !withdrawn && !unsigned) return;
    if (job) { await cancel(); return; }
    await removeEntry(path.join(root, subject));
    state = { state: 'idle' };
    log(`Bản cập nhật ${subject} đã tải về không còn được đề nghị nữa, nên đã xóa.`);
  }

  /** The Hub shuts down: a download in progress is cut and its .part removed; a finished one stays. */
  async function stop() {
    if (job) { job.controller.abort(); await job.done; }
  }

  return { load, start, cancel, reconcile, stop, status: snapshot, folder: root };
}
