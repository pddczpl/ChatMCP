// The update notice: step 1 of the in-app updater. The Hub finds out that a newer release exists and the page says so. It downloads nothing and runs nothing.
//
// Where the news comes from: one address, https://github.com/pddczpl/ChatMCP/releases/latest/download/RELEASE-MANIFEST.json. GitHub answers it with two redirects (github.com, then
// release-assets.githubusercontent.com) to the manifest of the Latest release that is NOT flagged as a pre-release, so a test build never reaches anyone. No REST API, no token.
//
// What it promises, and what the tests hold it to (tests/verify-update-check.mjs against a loopback server, tests/verify-e2e-update-check.mjs against a real Hub process):
//   * Whether the Hub asks at all is the owner's choice. Until the owner has answered (a question the page asks once) the Hub makes NO request on its own; "yes" starts a timer, "no"
//     stops it. What happens before an answer is ONE constant, WHEN_UNANSWERED. "Check now" is the owner's own act and works in every state.
//   * One request, to GitHub only: a GET with `User-Agent: DatGold/<version>` and `Accept`, no cookie, no login, no referrer, no body. The address is fixed. A redirect is followed at most
//     3 times and only to https on the default port of github.com, release-assets.githubusercontent.com or objects.githubusercontent.com; the whole thing (every hop and the body) has 10 seconds
//     and 64 KiB. A loopback address may stand in for the feed in tests (checkedFeedUrl, updateOptionsFromEnvironment); no route and no page can change it.
//   * What comes back is data: strict JSON of a known shape (a BOM is dropped, keys it does not know are kept out of the way), a release version x.y.z and nothing else, never a pre-release.
//     The notice is offered only for a version strictly higher than the one that runs. The link to the notes is built here from that version, never read from the answer or from the saved file.
//   * It keeps the last good answer when a check fails, saves it so that the next start can say it before the first check ends, and works out "available" again against the version that runs.
//   * It is polite: the first check 30 s after the Hub starts, then every 12 hours (1 hour after a failure), each with jitter, never less than 15 minutes after the last attempt (the attempt is
//     saved BEFORE the request goes out, so a Hub that restarts in a loop still asks once per 15 minutes), and a manual check at most once a minute. Two callers share one request.
//   * It never starts a program and never writes a downloaded file: the only things it writes are its two small JSON files in the Hub's data folder.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './runtime.mjs';

export const FEED_URL = 'https://github.com/pddczpl/ChatMCP/releases/latest/download/RELEASE-MANIFEST.json';
export const NOTES_URL_PREFIX = 'https://github.com/pddczpl/ChatMCP/releases/tag/v';
export const FEED_HOSTS = Object.freeze(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
export const STATE_FILE = 'update-check.json';
export const SETTINGS_FILE = 'update-settings.json';
/**
 * What an owner who has not answered the question gets, in one place so that it is one line to change.
 *   'ask'  no request is made on the Hub's own initiative until the owner says yes (the page asks once);
 *   'on'   the check runs as if the owner had said yes, and nobody is asked.
 */
export const WHEN_UNANSWERED = 'ask';
export const LIMITS = Object.freeze({ timeoutMs: 10_000, maxBytes: 64 * 1024, maxRedirects: 3, maxAssets: 32 });
export const SCHEDULE = Object.freeze({
  firstCheckMs: 30_000, firstCheckJitter: 0.5, intervalMs: 12 * 3_600_000, intervalJitter: 0.1, retryMs: 3_600_000, minAutomaticGapMs: 15 * 60_000, minManualGapMs: 60_000,
});

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class UpdateError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'UpdateError'; this.code = code; Object.assign(this, extra); }
}
const fault = (code, message, extra) => new UpdateError(code, message, extra);

// ------------------------------------------------------------------------------------------------------------------------------- versions

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const MAX_VERSION_LENGTH = 64;

/** Semantic Versioning 2.0.0: major.minor.patch with an optional pre-release and build. Null for anything else (a leading zero, a missing part, a number that does not fit, text that is not text). */
export function parseVersion(text) {
  if (typeof text !== 'string' || text.length > MAX_VERSION_LENGTH) return null;
  const match = SEMVER.exec(text);
  if (!match) return null;
  const numbers = [match[1], match[2], match[3]].map(Number);
  if (!numbers.every(Number.isSafeInteger)) return null;
  return { major: numbers[0], minor: numbers[1], patch: numbers[2], prerelease: match[4] ? match[4].split('.') : [], build: match[5] ? match[5].split('.') : [] };
}

/** x.y.z and nothing after it: what a release is called. */
export function isReleaseVersion(text) {
  const version = parseVersion(text);
  return version !== null && version.prerelease.length === 0 && version.build.length === 0;
}

function comparePrerelease(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // a release is above its own pre-releases
  if (!b.length) return -1;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    // numbers are compared as numbers (no leading zero, so more digits is more), words as ASCII, and a number is below a word
    if (xNumber && yNumber) return x.length !== y.length ? (x.length > y.length ? 1 : -1) : (x > y ? 1 : -1);
    if (xNumber) return -1;
    if (yNumber) return 1;
    return x > y ? 1 : -1;
  }
  return a.length === b.length ? 0 : (a.length > b.length ? 1 : -1);
}

/** -1, 0 or 1 by the precedence of Semantic Versioning (build metadata does not count). Throws a RangeError for text that is not a version. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new RangeError(`Not a version: ${String(left ? b : a).slice(0, 40)}`);
  for (const key of ['major', 'minor', 'patch']) if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** The page of the notes of a release, made from the version alone. Null for anything that is not a release version. */
export function notesUrlFor(version) {
  return isReleaseVersion(version) ? `${NOTES_URL_PREFIX}${version}` : null;
}

// ------------------------------------------------------------------------------------------------------------------------------- the manifest

const COMMIT = /^[0-9a-f]{40}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const invalidManifest = (reason) => fault('update_invalid_manifest', `The release description is not valid: ${reason}`);

/**
 * RELEASE-MANIFEST.json as the publish workflow writes it: {version, commit, assets: [{name, bytes, sha256}], ...}. Required parts are checked strictly; keys the Hub does not know are ignored,
 * because a later release will add some. `installerName` is the one asset whose name ends in .exe (the name changed once and may change again, so it is never written into the Hub); with none
 * or several it is null, and the check does not fail for it.
 */
export function parseManifest(text) {
  if (typeof text !== 'string') throw invalidManifest('the answer is not text');
  let document;
  try { document = JSON.parse(text.replace(/^﻿/, '')); } catch { throw invalidManifest('the answer is not JSON'); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw invalidManifest('the answer is not an object');
  const { version, commit, assets } = document;
  if (typeof version !== 'string') throw invalidManifest('no version');
  if (!isReleaseVersion(version)) {
    if (parseVersion(version)) throw fault('update_not_a_release', 'The feed names a version with a pre-release or build suffix; the feed carries releases only.');
    throw invalidManifest('the version is not x.y.z');
  }
  if (typeof commit !== 'string' || !COMMIT.test(commit)) throw invalidManifest('the commit is not 40 hexadecimal characters');
  if (!Array.isArray(assets) || assets.length > LIMITS.maxAssets) throw invalidManifest('the assets are not a short list');
  const seen = new Set();
  const list = assets.map((asset) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw invalidManifest('an asset is not an object');
    const { name, bytes, sha256 } = asset;
    if (typeof name !== 'string' || !ASSET_NAME.test(name)) throw invalidManifest('an asset has a name that is not a file name');
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw invalidManifest('an asset has a size that is not a count of bytes');
    if (typeof sha256 !== 'string' || !DIGEST.test(sha256)) throw invalidManifest('an asset has a digest that is not SHA-256');
    if (seen.has(name.toLowerCase())) throw invalidManifest('two assets have one name');
    seen.add(name.toLowerCase());
    return { name, bytes, sha256: sha256.toLowerCase() };
  });
  const programs = list.filter((asset) => /\.exe$/i.test(asset.name));
  return { version, commit: commit.toLowerCase(), installerName: programs.length === 1 ? programs[0].name : null, assets: list };
}

// ------------------------------------------------------------------------------------------------------------------------------- the address and the request

/** The feed: the fixed GitHub address, or a loopback address for a stand-in on this machine (tests). No login, query or fragment. */
export function checkedFeedUrl(value) {
  const refused = (why) => fault('update_feed_refused', `The update feed must be the GitHub address (or a loopback address in a test): ${why}.`);
  let url;
  try { url = new URL(value); } catch { throw refused('not a URL'); }
  if (url.username || url.password || url.search || url.hash) throw refused('no login, query or fragment');
  if (url.href === FEED_URL) return FEED_URL;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)) return url.href;
  throw refused('another host');
}

/**
 * May the request go on to `target`? Production: https, the default port, no login, and exactly one of FEED_HOSTS. A stand-in on a loopback address: its own origin and nowhere else
 * (a test never reaches the internet through it).
 */
export function redirectAllowed(target, feedUrl = FEED_URL) {
  if (!(target instanceof URL) || target.username || target.password) return false;
  if (feedUrl === FEED_URL) return target.protocol === 'https:' && target.port === '' && FEED_HOSTS.includes(target.hostname);
  return target.origin === new URL(feedUrl).origin;
}

const networkFault = (error) => fault('update_network', `GitHub could not be reached (${error?.code ?? error?.cause?.code ?? 'network error'}).`);
const tooLarge = (limit) => fault('update_too_large', `The answer is larger than ${limit} bytes; it was not read.`);

/** One HTTP request; resolves with the status and, for 200, the body (read up to `maxBytes`); a redirect resolves with its Location. */
function requestOnce(target, { userAgent, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const done = (finish, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      finish(value);
    };
    const onAbort = () => { request?.destroy(); done(reject, fault('update_timeout', 'GitHub did not answer in time.')); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    const client = target.protocol === 'https:' ? https : http;
    // agent: false = a connection of its own that is closed after the answer; the only headers are the two below (and Host, Connection).
    request = client.request(target, { method: 'GET', agent: false, headers: { 'user-agent': userAgent, accept: 'application/json' } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status !== 200) {
        response.resume();
        done(resolve, { status, location: REDIRECTS.has(status) ? String(response.headers.location ?? '') : '' });
        return;
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) { request.destroy(); done(reject, tooLarge(maxBytes)); return; }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { request.destroy(); done(reject, tooLarge(maxBytes)); return; }
        chunks.push(chunk);
      });
      response.on('end', () => done(resolve, { status, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', (error) => done(reject, networkFault(error)));
      response.on('close', () => { if (!response.complete) done(reject, networkFault(null)); });
    });
    request.on('error', (error) => done(reject, networkFault(error)));
    request.end();
  });
}

/**
 * Reads the manifest: the address `url` (checkedFeedUrl), redirects followed by hand (at most `maxRedirects`, each checked by redirectAllowed before a connection is made), one deadline for
 * all of it, the body cut at `maxBytes`. Resolves with {text, redirects}; rejects with an UpdateError whose message never holds an address (the last hop of the real feed is signed).
 */
export async function fetchManifest({ url = FEED_URL, userAgent = 'DatGold', timeoutMs = LIMITS.timeoutMs, maxBytes = LIMITS.maxBytes, maxRedirects = LIMITS.maxRedirects } = {}) {
  const feed = checkedFeedUrl(url);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    let target = new URL(feed);
    for (let hops = 0; ; hops += 1) {
      const answer = await requestOnce(target, { userAgent, maxBytes, signal: deadline.signal });
      if (REDIRECTS.has(answer.status)) {
        if (!answer.location) throw fault('update_redirect_invalid', 'GitHub redirected the request without saying where.');
        if (hops >= maxRedirects) throw fault('update_redirect_limit', `More than ${maxRedirects} redirects.`);
        let next;
        try { next = new URL(answer.location, target); } catch { throw fault('update_redirect_invalid', 'GitHub redirected the request to something that is not an address.'); }
        if (!redirectAllowed(next, feed)) throw fault('update_redirect_refused', `A redirect to ${next.host || 'another place'} was refused.`);
        target = next;
        continue;
      }
      if (answer.status !== 200) throw fault('update_http', `GitHub answered HTTP ${answer.status}.`, { status: answer.status });
      return { text: answer.text, redirects: hops };
    }
  } finally { clearTimeout(timer); }
}

// ------------------------------------------------------------------------------------------------------------------------------- the hooks of the tests

/**
 * The two variables a test may set, read once when the Hub starts. CHATMCP_UPDATE_FEED_URL puts a loopback server where GitHub is; CHATMCP_UPDATE_FIRST_CHECK_MS (0 to 60000) makes the first
 * check come sooner, and only counts beside it. Anything else is ignored with a line in the log that does not repeat the value, so the address that is read stays GitHub's.
 * There is no route, setting or page that can change the feed.
 */
export function updateOptionsFromEnvironment(env = process.env, log = () => {}) {
  const options = {};
  const raw = env?.CHATMCP_UPDATE_FEED_URL;
  if (typeof raw !== 'string' || !raw.trim()) return options;
  let feedUrl;
  try { feedUrl = checkedFeedUrl(raw.trim()); } catch {
    log('CHATMCP_UPDATE_FEED_URL bị bỏ qua: chỉ nhận địa chỉ loopback (127.0.0.1, localhost, [::1]); kiểm tra bản mới vẫn đọc từ GitHub.');
    return options;
  }
  if (feedUrl === FEED_URL) return options;
  options.feedUrl = feedUrl;
  const delay = env.CHATMCP_UPDATE_FIRST_CHECK_MS;
  if (typeof delay === 'string' && /^\d{1,5}$/.test(delay.trim()) && Number(delay) <= 60_000) options.firstCheckMs = Number(delay);
  return options;
}

// ------------------------------------------------------------------------------------------------------------------------------- the checker

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY_MS = 86_400_000;
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

/**
 * @param {{directory: string, currentVersion: string, feedUrl?: string, whenUnanswered?: 'ask'|'on', now?: () => Date, random?: () => number,
 *   timers?: {setTimeout: Function, clearTimeout: Function}, firstCheckMs?: number, timeoutMs?: number, log?: (line: string) => void}} options
 *   `feedUrl`, `now`, `random`, `timers`, `firstCheckMs` and `timeoutMs` are for tests; the Hub passes only `directory`, `currentVersion`, `log` and what updateOptionsFromEnvironment allows.
 */
export function createUpdateChecker({
  directory, currentVersion, feedUrl = FEED_URL, whenUnanswered = WHEN_UNANSWERED, now = () => new Date(), random = Math.random,
  timers = { setTimeout, clearTimeout }, firstCheckMs = SCHEDULE.firstCheckMs, timeoutMs = LIMITS.timeoutMs, log = () => {},
} = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('The update check needs the data folder of the Hub.');
  const feed = checkedFeedUrl(feedUrl);
  const stateFile = path.join(directory, STATE_FILE);
  const settingsFile = path.join(directory, SETTINGS_FILE);
  const running = String(currentVersion);
  const runningParsed = parseVersion(running);
  const userAgent = /^[0-9A-Za-z.+-]{1,64}$/.test(running) ? `DatGold/${running}` : 'DatGold';

  let latest = null;
  let installerName = null;
  let checkedAt = null;
  let lastAttemptAt = null;
  let skippedVersion = null;
  let saved = null;
  let error = null;
  let inFlight = null;
  let started = false;
  let timer = null;
  let nextAt = null;
  let stateWrites = Promise.resolve();
  let settingsWrites = Promise.resolve();

  const nowMs = () => now().getTime();
  const autoEnabled = () => (saved === null ? whenUnanswered === 'on' : saved);
  const isAvailable = () => latest !== null && runningParsed !== null && compareVersions(latest, running) > 0;
  const jittered = (base, fraction) => Math.round(base * (1 + fraction * (2 * random() - 1)));

  function status() {
    return {
      current: running,
      latest,
      available: isAvailable(),
      checkedAt: iso(checkedAt),
      lastAttemptAt: iso(lastAttemptAt),
      notesUrl: latest === null ? null : notesUrlFor(latest),
      installerName,
      skippedVersion,
      error: error ? { ...error } : null,
      checking: inFlight !== null,
      manualCheckAfter: lastAttemptAt === null ? null : iso(lastAttemptAt + SCHEDULE.minManualGapMs),
      nextAutomaticCheckAt: iso(nextAt),
      autoCheck: { enabled: autoEnabled(), saved, needsChoice: saved === null && whenUnanswered === 'ask' },
    };
  }

  // ---- the two files
  /** The text of a file, null when there is none, or {damaged} with the reason. A BOM is dropped. */
  async function readFile(file) {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (reason) {
      if (reason?.code === 'ENOENT') return null;
      return { damaged: `không đọc được (${reason?.code ?? 'lỗi'})` };
    }
    try {
      const data = JSON.parse(text.replace(/^﻿/, ''));
      return data && typeof data === 'object' && !Array.isArray(data) ? { data } : { damaged: 'không phải một đối tượng JSON' };
    } catch { return { damaged: 'không phải JSON' }; }
  }

  const validTime = (value, limit) => {
    if (typeof value !== 'string' || !TIME.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms <= limit ? ms : null;
  };

  /** Reads both files; never throws. Each field is checked on its own, and what is wrong costs that field and nothing else. */
  async function load() {
    latest = null; installerName = null; checkedAt = null; lastAttemptAt = null; skippedVersion = null; saved = null; error = null;
    const setting = await readFile(settingsFile);
    if (setting?.damaged) log(`Không dùng được ${SETTINGS_FILE}: ${setting.damaged}; hỏi lại chủ máy có muốn kiểm tra bản mới không.`);
    else if (setting) {
      if (typeof setting.data.autoCheckUpdates === 'boolean') saved = setting.data.autoCheckUpdates;
      else log(`${SETTINGS_FILE} không có lựa chọn hợp lệ; hỏi lại chủ máy có muốn kiểm tra bản mới không.`);
    }
    const state = await readFile(stateFile);
    if (state?.damaged) log(`Không dùng được ${STATE_FILE}: ${state.damaged}; chưa biết bản mới nhất cho đến lần kiểm tra sau.`);
    else if (state && state.data.version !== 1) log(`${STATE_FILE} thuộc một định dạng khác; bỏ qua.`);
    else if (state) {
      const { data } = state;
      const limit = nowMs() + DAY_MS;
      if (isReleaseVersion(data.latest)) {
        latest = data.latest;
        checkedAt = validTime(data.checkedAt, limit);
        if (typeof data.installerName === 'string' && ASSET_NAME.test(data.installerName) && /\.exe$/i.test(data.installerName)) installerName = data.installerName;
      }
      lastAttemptAt = validTime(data.lastAttemptAt, limit);
      if (isReleaseVersion(data.skippedVersion)) skippedVersion = data.skippedVersion;
    }
    return status();
  }

  function stateDocument(overrides = {}) {
    return { version: 1, latest, installerName, checkedAt: iso(checkedAt), lastAttemptAt: iso(lastAttemptAt), skippedVersion, ...overrides };
  }
  /** Writes the state in the order calls were made; a failure is returned, not raised. */
  function saveState(overrides) {
    const write = stateWrites.catch(() => {}).then(() => writeJson(stateFile, stateDocument(overrides)));
    stateWrites = write.catch(() => {});
    return write;
  }
  const saveStateQuietly = () => saveState().catch((reason) => log(`Không lưu được ${STATE_FILE} (${reason?.code ?? 'lỗi'}); bản đã biết vẫn dùng trong lần chạy này.`));

  // ---- one check
  async function attempt() {
    lastAttemptAt = nowMs();
    // on disk BEFORE the request: a Hub that is killed in the middle, or restarted in a loop, still counts this try
    await saveStateQuietly();
    try {
      if (runningParsed === null) throw fault('update_current_invalid', 'The version of this Hub is not x.y.z, so it cannot be compared.');
      const { text } = await fetchManifest({ url: feed, userAgent, timeoutMs });
      const manifest = parseManifest(text);
      latest = manifest.version;
      installerName = manifest.installerName;
      checkedAt = nowMs();
      error = null;
      log(isAvailable() ? `Kiểm tra bản cập nhật: DatGold ${latest} đã có (bản đang chạy ${running}).` : `Kiểm tra bản cập nhật: bản mới nhất là ${latest}, không mới hơn bản đang chạy (${running}).`);
    } catch (reason) {
      const known = reason instanceof UpdateError;
      error = { code: known ? reason.code : 'update_failed', message: String(known ? reason.message : 'The check failed.').slice(0, 200), status: known ? (reason.status ?? null) : null, at: iso(nowMs()) };
      log(`Kiểm tra bản cập nhật không thành công (${error.code}${error.status ? ` ${error.status}` : ''}); giữ thông tin lần trước.`);
    }
    await saveStateQuietly();
    schedule(jittered(error ? SCHEDULE.retryMs : SCHEDULE.intervalMs, SCHEDULE.intervalJitter));
  }

  /** The one try that is out: whoever asks while it is out gets its answer, and the answer is taken once it is over (checking is false in it). */
  function run() {
    inFlight = attempt().then(() => { inFlight = null; return { checked: true, throttled: false, update: status() }; }, (reason) => { inFlight = null; throw reason; });
    return inFlight;
  }

  /** The owner's "Check now": one request at most per minute, and two callers at once share it. */
  function check() {
    if (inFlight) return inFlight;
    if (lastAttemptAt !== null && nowMs() - lastAttemptAt < SCHEDULE.minManualGapMs) return Promise.resolve({ checked: false, throttled: true, update: status() });
    return run();
  }

  // ---- the timer
  function clearTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    nextAt = null;
  }
  function schedule(delayMs) {
    clearTimer();
    if (!started || !autoEnabled()) return;
    timer = timers.setTimeout(() => runAutomatic(), delayMs);
    timer?.unref?.();
    nextAt = nowMs() + delayMs;
  }
  /** The first try after start, or after the owner says yes: a little later, and never inside the floor of the last attempt (which survives a restart). */
  function firstDelay() {
    const floor = lastAttemptAt === null ? 0 : lastAttemptAt + SCHEDULE.minAutomaticGapMs - nowMs();
    return Math.max(jittered(firstCheckMs, SCHEDULE.firstCheckJitter), floor);
  }
  async function runAutomatic() {
    timer = null;
    nextAt = null;
    // a timer that was already running when it was cleared, or when the owner said no, asks nothing
    if (!started || !autoEnabled()) return;
    if (inFlight) return; // a try is out; when it ends it sets the next one
    const wait = lastAttemptAt === null ? 0 : lastAttemptAt + SCHEDULE.minAutomaticGapMs - nowMs();
    if (wait > 0) { schedule(wait); return; }
    try { await run(); } catch { /* attempt() reports failures in the state; nothing may escape from a timer: an unhandled rejection stops the Hub */ }
  }

  function start() {
    if (started) return;
    started = true;
    if (autoEnabled()) schedule(firstDelay());
  }
  function stop() {
    started = false;
    clearTimer();
  }

  // ---- what the owner decides
  const refusal = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });

  async function setAutoCheck(enabled) {
    if (typeof enabled !== 'boolean') throw refusal('update_setting_invalid', 'enabled phải là true hoặc false.', 400);
    const write = settingsWrites.catch(() => {}).then(async () => {
      try { await writeJson(settingsFile, { version: 1, autoCheckUpdates: enabled }); } catch (reason) {
        log(`Không lưu được ${SETTINGS_FILE} (${reason?.code ?? 'lỗi'}).`);
        throw refusal('update_save_failed', 'Không lưu được lựa chọn trong thư mục dữ liệu của Hub.', 500);
      }
      saved = enabled;
      log(`Tự kiểm tra bản cập nhật: ${enabled ? 'bật' : 'tắt'} (chủ máy chọn).`);
      if (!enabled) clearTimer();
      else if (started && timer === null) schedule(firstDelay());
      return status();
    });
    settingsWrites = write;
    return write;
  }

  async function skip(version) {
    if (version !== null) {
      if (!isReleaseVersion(version)) throw refusal('update_skip_invalid', 'version phải là một bản phát hành dạng x.y.z, hoặc null.', 400);
      if (version !== latest || !isAvailable()) throw refusal('update_skip_stale', 'Bản này không còn là bản mới đang được đề nghị.', 409);
    }
    try { await saveState({ skippedVersion: version }); } catch (reason) {
      log(`Không lưu được ${STATE_FILE} (${reason?.code ?? 'lỗi'}).`);
      throw refusal('update_save_failed', 'Không lưu được lựa chọn trong thư mục dữ liệu của Hub.', 500);
    }
    skippedVersion = version;
    return status();
  }

  return { load, start, stop, status, check, skip, setAutoCheck };
}
