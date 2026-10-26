// The download of the installer (lib/update-download.mjs), step 2 of the in-app updater: nothing is installed or run, and the finished installer is not opened or moved; a file is fetched, counted, hashed and put in a folder of the Hub.
//
// What this suite holds the module to, against a REAL loopback HTTP server that stands in for GitHub (tests/e2e/update-feed-server.mjs: the same hops, a signed address at the end), real files in a
// temporary folder, and keys made when it runs. Only the platform, the free space and the file system (for a failure on purpose) are handed in:
//   1. the order: nothing is asked for the installer until the owner's click; a click is refused unless a newer release with a valid signature is known, and the signature, the version, the platform and
//      the room on the disk are looked at again, in that order, before the first byte; the name, the size and the SHA-256 come from the manifest that was just verified and from nothing else;
//   2. the bytes: streamed to a .part file with an incremental SHA-256, never held in memory; the count must equal the manifest's (short and long both fail), then the hash, then fsync and an atomic
//      rename; the signed manifest and its signature are kept beside the installer for the step that runs it; progress is in memory; one at a time; cancel; a stalled stream gives up (idle, not total);
//   3. everything that can go wrong with the transport: a redirect to another host, no Location, a loop, a 404, a reset, a short body, a long body, a body that is not the signed one;
//   4. everything that can go wrong with the Hub's own files: leftovers of a Hub that was killed, folders of older versions, links planted where a folder should be, a folder that is a file, a
//      state file damaged field by field, a copy of the manifest or the signature that no longer checks, a disk that is full or a rename that fails, a clock that jumps (the module reads no clock);
//   5. what the module is not: it starts no program, reads no environment variable, reads no clock, and the finished installer is never opened, moved or run.
// "ready" is the Hub's own statement. It does not make the file trustworthy to whoever runs it: the step that runs the installer hashes it again (a program running with Full Access can write this
// folder); docs/THREAT-MODEL.md, Surface 8.
// CLAIM: update-download-checks-size-and-hash
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { feedManifest, startUpdateFeed } from './e2e/update-feed-server.mjs';
import { keyFileText, signatureFor, throwawayKey } from './support/release-keys.mjs';
import { createUpdateChecker } from '../lib/update-check.mjs';
import { parseReleaseKeys, verifyManifest } from '../lib/release-signature.mjs';
import { DOWNLOAD, DownloadError, createUpdateDownloader, installerNameProblem } from '../lib/update-download.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MiB = 1024 * 1024;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-update-download-'));
let count = 0;
const folder = () => { const directory = path.join(scratch, `hub-${count += 1}`); fs.mkdirSync(directory, { recursive: true }); return directory; };

/** Waits on the monotonic clock: a test that moves the wall clock must not move its own deadline. */
async function waitUntil(check, label, timeoutMs = 15_000) {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** Fails unless `promise` rejects with a DownloadError of this code (and status code). */
async function refuses(promise, code, label, statusCode = null) {
  const error = await promise.then(() => null, (reason) => reason);
  assert.ok(error, `${label}: it must be refused`);
  assert.ok(error instanceof DownloadError, `${label}: a DownloadError, not ${error?.constructor?.name}: ${error?.message}`);
  assert.equal(error.code, code, `${label}: ${error.code} ${error.message}`);
  if (statusCode !== null) assert.equal(error.statusCode, statusCode, `${label}: the HTTP status the route gives`);
  assert.ok(!/X-Amz|SIGNED-QUERY|https?:\/\//.test(error.message), `${label}: no address in the message`);
  return error;
}

/** Bytes that do not repeat (a block that is dropped or doubled would show), the same for the same seed. */
function pseudoBytes(size, seed) {
  const out = Buffer.alloc(size);
  let x = (Math.imul(seed, 2654435761) >>> 0) || 1;
  for (let index = 0; index < size; index += 4) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out.writeUInt32LE(x, index);
  }
  return out;
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A release: the manifest that lists these bytes as its installer, and the bytes. */
function releaseFor({ version = '3.11.0', size = 6 * MiB, seed = 1, name = 'DatGoldSetup.exe', assets = null } = {}) {
  const bytes = pseudoBytes(size, seed);
  const manifest = feedManifest({ version, assets: assets ?? [{ name, sha256: sha256(bytes), bytes: size }, { name: 'DatGold-Browser-Companion.zip', sha256: 'c'.repeat(64), bytes: 48568 }] });
  return { version, name, bytes, size, manifest, sha: sha256(bytes) };
}

const owner = throwawayKey();
const trusted = parseReleaseKeys(keyFileText([owner.entry])).keys;
const feed = await startUpdateFeed({ key: owner });
const foreign = await startUpdateFeed();
const MANIFEST_COPY = 'RELEASE-MANIFEST.json';
const SIGNATURE_COPY = 'RELEASE-MANIFEST.json.sig';

/** Puts a release on the stand-in the way the owner publishes it (signed, with its installer), every file served the way GitHub does. */
function publish(release, { serve = release.bytes } = {}) {
  feed.mode('chain');
  feed.pinTag(null);
  feed.signature.mode('chain');
  feed.signature.set(null);
  feed.publish(release.manifest);
  feed.installer.set({ name: release.name, bytes: serve });
}

/** A Hub's worth of state: a checker that has looked at the feed, and a downloader that reads its offer. `options` change the downloader; the defaults are a Windows with room to spare. */
async function world({ release = releaseFor(), served = release.bytes, running = '3.10.2', options = {}, check = true } = {}) {
  publish(release, { serve: served });
  const directory = folder();
  const clock = { ms: Date.now(), now() { return new Date(this.ms); } };
  const checker = createUpdateChecker({ directory, currentVersion: running, feedUrl: feed.url, releaseKeys: trusted, now: () => clock.now() });
  await checker.load();
  if (check) await checker.check();
  const lines = [];
  const downloader = createUpdateDownloader({
    directory, currentVersion: running, feedUrl: feed.url, releaseKeys: trusted, offer: () => checker.status(), log: (line) => lines.push(line),
    platform: 'win32', freeBytes: async () => 1000 * 1024 * MiB, idleTimeoutMs: 5000, timeoutMs: 5000, ...options,
  });
  await downloader.load();
  const root = path.join(directory, 'updates');
  /** Looks at the feed again, a minute later (a manual check is held back for a minute). */
  const recheck = async () => { clock.ms += 61_000; return checker.check(); };
  return { directory, checker, downloader, lines, release, root, recheck, folderOf: (version = release.version) => path.join(root, version) };
}
const installerRequests = () => feed.requests.filter((request) => request.url.split('?')[0].endsWith('.exe'));
const listing = (directory) => { try { return fs.readdirSync(directory, { recursive: true }).map((name) => String(name).replaceAll('\\', '/')).sort(); } catch { return null; } };
const left = (w) => listing(w.root) ?? [];
const settled = async (downloader, states) => waitUntil(() => states.includes(downloader.status().state) && downloader.status(), `a state in ${states.join('/')}`);
const another = (w, options = {}) => createUpdateDownloader({
  directory: w.directory, currentVersion: '3.10.2', feedUrl: feed.url, releaseKeys: trusted, offer: () => w.checker.status(), platform: 'win32', freeBytes: async () => 1e12, idleTimeoutMs: 5000, timeoutMs: 5000, ...options,
});
/** A file system whose calls go through `hook(name, args, call)`, so that a test can make one of them fail or change what it gives back. */
function faulty(hook) {
  const promises = new Proxy(fs.promises, { get(target, property) { const value = target[property]; return typeof value === 'function' ? (...args) => hook(String(property), args, () => value.apply(target, args)) : value; } });
  return { ...fs, promises };
}
const coded = (code) => Object.assign(new Error(code), { code });
/** A gate for a test: the code under test says `arrive()` when it has got there and then waits until the test calls `release()`. */
const hold = () => {
  let release;
  let arrive;
  const opened = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { arrive = resolve; });
  return { opened, release, arrived, arrive };
};
const isRoot = (target) => String(target).endsWith(`${path.sep}updates`);

try {
  // ------------------------------------------------------------------------------------------------------------------------------- 1. a download, from the click to "ready"
  {
    const w = await world();
    const before = feed.requests.length;
    assert.deepEqual(w.downloader.status(), { state: 'idle' });
    await sleep(300);
    assert.equal(installerRequests().length, 0, 'nothing is asked for the installer while nobody clicks: not at start, not after a check that found a signed release');
    assert.equal(feed.requests.length, before, 'nothing at all is asked');
    assert.equal(listing(w.root), null, 'and no folder is made');

    feed.requests.length = 0;
    const seen = new Set();
    const watcher = setInterval(() => seen.add(JSON.stringify(w.downloader.status())), 2);
    const started = await w.downloader.start({ version: '3.11.0' });
    assert.equal(started.started, true);
    assert.equal(started.status.state, 'downloading');
    const ready = await settled(w.downloader, ['ready', 'failed']);
    clearInterval(watcher);
    assert.deepEqual(ready, { state: 'ready', version: '3.11.0', bytes: w.release.size }, `ready, with the version and the size: ${JSON.stringify(ready)}`);
    const states = [...seen].map((text) => JSON.parse(text));
    assert.ok(states.some((entry) => entry.state === 'downloading' && entry.total === w.release.size), 'it was downloading with the total of the manifest');
    assert.ok(states.every((entry) => entry.state !== 'failed'), 'and never failed');
    const received = states.filter((entry) => entry.state === 'downloading').map((entry) => entry.received);
    assert.ok(received.every((value, index) => index === 0 || value >= received[index - 1]), 'progress never goes back');
    assert.ok(received.every((value) => value <= w.release.size));
    // the files
    assert.ok(fs.readFileSync(path.join(w.folderOf(), 'DatGoldSetup.exe')).equals(w.release.bytes), 'the installer on disk is the bytes that were served');
    assert.deepEqual(listing(w.folderOf()), ['DatGoldSetup.exe', 'RELEASE-MANIFEST.json', 'RELEASE-MANIFEST.json.sig', 'state.json'], 'nothing else in the folder: no .part, no temporary file');
    const keptManifest = fs.readFileSync(path.join(w.folderOf(), MANIFEST_COPY));
    assert.ok(keptManifest.equals(feed.manifestBytes()), 'the signed manifest is kept beside it, byte for byte, for the step that runs the installer');
    assert.equal(verifyManifest(keptManifest, fs.readFileSync(path.join(w.folderOf(), SIGNATURE_COPY)), trusted).kid, owner.kid, 'and so is its signature, which checks');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.folderOf(), 'state.json'), 'utf8')), { version: 1, release: '3.11.0', name: 'DatGoldSetup.exe', bytes: w.release.size, sha256: w.release.sha, kid: owner.kid }, 'the state file: what was checked, and no time');
    // the requests: the release again by its tag, its signature, then the installer; nothing else
    const paths = feed.requests.map((request) => request.url.split('?')[0]);
    assert.deepEqual(paths, [
      '/pddczpl/ChatMCP/releases/download/v3.11.0/RELEASE-MANIFEST.json', '/github-production-release-asset/1413019619/24765420',
      '/pddczpl/ChatMCP/releases/download/v3.11.0/RELEASE-MANIFEST.json.sig', '/github-production-release-asset/1413019619/24765421',
      '/pddczpl/ChatMCP/releases/download/v3.11.0/DatGoldSetup.exe', '/github-production-release-asset/1413019619/24765422',
    ], 'the manifest and its signature are fetched again by the tag, then the installer');
    const names = new Set();
    for (const request of feed.requests) {
      assert.equal(request.method, 'GET');
      assert.equal(request.headers['user-agent'], 'DatGold/3.10.2');
      for (const name of Object.keys(request.headers)) names.add(name);
    }
    assert.deepEqual([...names].sort(), ['accept', 'connection', 'host', 'user-agent'], 'the same four headers: no cookie, no login, no referrer');
    assert.equal(feed.requests.find((request) => request.url.includes('DatGoldSetup.exe')).headers.accept, 'application/octet-stream');
    assert.ok(![...w.lines, JSON.stringify(w.downloader.status()), fs.readFileSync(path.join(w.folderOf(), 'state.json'), 'utf8')].some((text) => /X-Amz|SIGNED-QUERY/.test(text)), 'no signed address in the log, the status or the state file');
    // and it is "ready" after a restart, from the folder alone
    assert.deepEqual(await another(w, { freeBytes: async () => 0 }).load(), { state: 'ready', version: '3.11.0', bytes: w.release.size }, 'a Hub that starts again finds it ready');
    // a click on a ready download does not fetch it again, and does not touch it
    feed.requests.length = 0;
    const second = await w.downloader.start({ version: '3.11.0' });
    assert.equal(second.started, false);
    assert.equal(second.status.state, 'ready');
    assert.equal(feed.requests.length, 0, 'a click on something that is ready asks nothing');
    ok('a click downloads the signed installer: the release is fetched again by its tag and its signature checked again, then the installer streams to a .part file and is renamed whole; ready names the version and the size; the folder holds the installer, the signed manifest and signature (for the step that runs it) and a state file with no time in it; the requests are those and nothing else; a restart finds it ready; nothing was asked before the click');
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 2. progress, cancel, one at a time
  {
    const w = await world({ release: releaseFor({ size: 8 * MiB, seed: 2 }) });
    feed.installer.mode('chain', { pauseAfter: 3 * MiB });
    const sentBefore = feed.installer.sent();
    const started = await w.downloader.start({ version: '3.11.0' });
    assert.equal(started.started, true);
    const midway = await waitUntil(() => { const status = w.downloader.status(); return status.state === 'downloading' && status.received >= 3 * MiB && status; }, 'part of the installer');
    assert.deepEqual(Object.keys(midway).sort(), ['received', 'state', 'total', 'version']);
    assert.equal(midway.total, 8 * MiB);
    assert.equal(midway.received, 3 * MiB, 'the count is the bytes that have arrived');
    const part = path.join(w.folderOf(), 'DatGoldSetup.exe.part');
    assert.ok(fs.existsSync(part) && fs.statSync(part).size <= 8 * MiB, 'the bytes go to a .part file, not into memory');
    assert.ok(!fs.existsSync(path.join(w.folderOf(), 'DatGoldSetup.exe')), 'the installer does not exist before it is whole');
    // two clicks: the second changes nothing
    const requestsBefore = installerRequests().length;
    const twice = await w.downloader.start({ version: '3.11.0' });
    assert.equal(twice.started, false, 'a click while a download runs does not start another');
    assert.equal(twice.status.state, 'downloading');
    assert.equal(installerRequests().length, requestsBefore, 'one request for the installer');
    // cancel
    const cancelled = await w.downloader.cancel();
    assert.equal(cancelled.cancelled, true);
    assert.deepEqual(w.downloader.status(), { state: 'idle' }, 'a cancelled download is not a failure');
    assert.deepEqual(left(w), [], 'the .part file and the folder are gone');
    feed.installer.resume();
    await waitUntil(() => feed.installer.openCount() === 0, 'the connection to be closed by the Hub');
    assert.equal(feed.installer.sent() - sentBefore, 3 * MiB, 'and the rest of the installer was never sent: the connection was gone when the server went on');
    assert.deepEqual(await w.downloader.cancel(), { cancelled: false, status: { state: 'idle' } }, 'a cancel with nothing to cancel is not an error');
    // a cancel while the Hub is still waiting for the first answer (nothing has arrived yet) is a cancel too, not a failure of the connection
    feed.installer.mode('stall');
    const hitsBefore = feed.installer.hits();
    await w.downloader.start({ version: '3.11.0' });
    await waitUntil(() => feed.installer.hits() > hitsBefore, 'the request for the installer');
    assert.equal(w.downloader.status().state, 'downloading');
    await w.downloader.cancel();
    assert.deepEqual(w.downloader.status(), { state: 'idle' }, 'cancelled before a byte came: idle, not failed');
    assert.deepEqual(left(w), []);
    await waitUntil(() => feed.openCount() === 0, 'the waiting request to be closed');
    // a click after a cancel starts again, from the beginning
    feed.installer.mode('chain');
    await w.downloader.start({ version: '3.11.0' });
    assert.equal((await settled(w.downloader, ['ready', 'failed'])).state, 'ready');
    assert.equal((await w.downloader.cancel()).cancelled, false);
    assert.equal(w.downloader.status().state, 'ready', 'a cancel after ready leaves it ready');
    // two clicks at the same moment, before the first has got anywhere
    const race = await world({ release: releaseFor({ size: 2 * MiB, seed: 3 }) });
    feed.requests.length = 0;
    const [one, two] = await Promise.all([race.downloader.start({ version: '3.11.0' }), race.downloader.start({ version: '3.11.0' })]);
    assert.deepEqual([one.started, two.started].sort(), [false, true], 'two clicks at once: one starts, one is told it is running');
    await settled(race.downloader, ['ready', 'failed']);
    assert.equal(installerRequests().length, 1, 'one request for the installer');
    ok('the count is the bytes that arrived (progress in memory, never going back), they go to a .part file; a second click while it runs (also at the same moment) starts nothing; cancel closes the connection, removes the file and the folder and is no failure; a cancel with nothing to cancel, or after ready, changes nothing; a click after a cancel starts again');
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 3. refusals: nothing is asked for, nothing is written
  {
    const base = async (extra = {}) => { const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 4 }), ...extra }); feed.requests.length = 0; return w; };
    const untouched = (w, label) => {
      assert.equal(installerRequests().length, 0, `${label}: the installer was not asked for`);
      assert.deepEqual(left(w), [], `${label}: nothing was written`);
      assert.deepEqual(w.downloader.status(), { state: 'idle' }, `${label}: idle`);
    };
    // a body that is not a release version
    {
      const w = await base();
      feed.requests.length = 0;
      for (const version of [undefined, null, 5, '', 'x', '3.11', '3.11.0-rc.1', '../3.11.0', '3.11.0\n', {}, ['3.11.0']]) await refuses(w.downloader.start({ version }), 'update_download_invalid', `a version of ${JSON.stringify(version)}`, 400);
      await refuses(w.downloader.start(), 'update_download_invalid', 'no body', 400);
      await refuses(w.downloader.start(null), 'update_download_invalid', 'a body that is null', 400);
      assert.equal(feed.requests.length, 0, 'none of those asked anything');
      untouched(w, 'a bad version');
    }
    // a version that is not the one on offer
    {
      const w = await base();
      feed.requests.length = 0;
      await refuses(w.downloader.start({ version: '3.11.1' }), 'update_download_stale', 'a version other than the one on offer', 409);
      await refuses(w.downloader.start({ version: '3.10.2' }), 'update_download_stale', 'the version that runs');
      assert.equal(feed.requests.length, 0);
      untouched(w, 'another version');
      const none = await base({ check: false });
      await refuses(none.downloader.start({ version: '3.11.0' }), 'update_download_stale', 'nothing is known: no check was made', 409);
      untouched(none, 'nothing known');
    }
    // a release the owner has not signed, or whose signature does not check, or that could not be read
    for (const [label, arrange] of [
      ['not signed yet (404)', () => feed.signature.mode('missing')],
      ['a signature that does not check', () => feed.signature.set(signatureFor(Buffer.from('another manifest'), owner))],
      ['a signature of another key', () => feed.signature.set(signatureFor(feed.manifestBytes(), throwawayKey()))],
      ['a signature that could not be read (500)', () => feed.signature.mode('status', { status: 500 })],
    ]) {
      const w = await base();
      arrange();
      await w.recheck();
      feed.requests.length = 0;
      const error = await refuses(w.downloader.start({ version: '3.11.0' }), 'update_download_unsigned', label, 409);
      assert.match(error.message, /signature|signed/i, label);
      assert.equal(feed.requests.length, 0, `${label}: the state already says so, so nothing is asked`);
      untouched(w, label);
    }
    // the state says "valid", the feed no longer agrees: the signature is checked AGAIN, from the feed, by the tag
    for (const [label, arrange, code, statusCode] of [
      ['the signature was withdrawn after the check', () => feed.signature.mode('missing'), 'update_download_unsigned', 409],
      ['the signature was replaced by one that does not check', () => feed.signature.set(signatureFor(feed.manifestBytes(), throwawayKey())), 'update_download_unsigned', 409],
      ['the signature cannot be read now (500)', () => feed.signature.mode('status', { status: 500 }), 'update_download_unverified', 502],
      ['the signature does not come (a stall)', () => feed.signature.mode('stall'), 'update_download_unverified', 502],
      ['the manifest of the tag cannot be read (404)', () => feed.mode('status', { status: 404 }), 'update_download_unverified', 502],
      ['the tag now holds the manifest of another release', () => { const next = releaseFor({ version: '3.11.1', size: 1 * MiB, seed: 5 }); feed.pinTag('3.11.0'); feed.publish(next.manifest); }, 'update_download_stale', 409],
      ['the manifest no longer lists the installer that was offered', () => { feed.publish(feedManifest({ version: '3.11.0', assets: [{ name: 'DatGold-Browser-Companion.zip', sha256: 'c'.repeat(64), bytes: 48568 }] })); }, 'update_download_no_installer', 409],
    ]) {
      const w = await base({ options: { timeoutMs: 600 } });
      assert.equal(w.checker.status().signature, 'valid', `${label}: the check said valid`);
      arrange();
      feed.requests.length = 0;
      await refuses(w.downloader.start({ version: '3.11.0' }), code, label, statusCode);
      assert.equal(installerRequests().length, 0, `${label}: the installer was not asked for`);
      untouched(w, label);
      await waitUntil(() => feed.openCount() === 0, 'stalled requests to be closed');
    }
    // the version does not rise
    {
      const w = await base({ running: '3.11.0' });
      assert.equal(w.checker.status().available, false, 'the check offers nothing that is not newer');
      feed.requests.length = 0;
      await refuses(w.downloader.start({ version: '3.11.0' }), 'update_download_not_newer', 'the version that runs', 409);
      assert.equal(feed.requests.length, 0, 'the offer already says that it is not newer, so nothing is asked: not the release again, not its signature');
      untouched(w, 'the same version');
      // an offer that says it is available although it is not newer (a bug elsewhere, or a state that was edited): this module checks the version itself
      const lying = (running) => createUpdateDownloader({ directory: w.directory, currentVersion: running, feedUrl: feed.url, releaseKeys: trusted, offer: () => ({ latest: '3.11.0', available: true, signature: 'valid' }), platform: 'win32', freeBytes: async () => 1e12 });
      await refuses(lying('3.11.0').start({ version: '3.11.0' }), 'update_download_not_newer', 'an offer for the version that runs', 409);
      await refuses(lying('3.12.0').start({ version: '3.11.0' }), 'update_download_not_newer', 'an offer for an older version', 409);
      assert.equal(installerRequests().length, 0);
      const pre = lying('3.11.0-rc.1');
      await pre.load();
      assert.equal((await pre.start({ version: '3.11.0' })).started, true, 'a running pre-release is below its own release: that one is newer');
      await settled(pre, ['ready', 'failed']);
    }
    for (const platform of ['linux', 'darwin', 'freebsd', 'aix', null, '']) {
      const w = await base({ options: { platform } });
      await refuses(w.downloader.start({ version: '3.11.0' }), 'update_download_platform', `platform ${JSON.stringify(platform)}`, 501);
      untouched(w, `platform ${platform}`);
    }
    {
      const w = await base({ options: { platform: 'win32' } });
      assert.equal((await w.downloader.start({ version: '3.11.0' })).started, true, 'and on win32 it goes ahead');
      await settled(w.downloader, ['ready', 'failed']);
    }
    // the order in which things are looked at: the signature first, then the platform, then the room on the disk
    {
      const w = await base({ options: { platform: 'linux', freeBytes: async () => 0 } });
      await refuses(w.downloader.start({ version: '3.11.0' }), 'update_download_platform', 'Linux with no room: the platform comes before the disk');
      feed.signature.mode('missing');
      await w.recheck();
      await refuses(w.downloader.start({ version: '3.11.0' }), 'update_download_unsigned', 'unsigned, on Linux, with no room: the signature comes first');
      const disk = await base({ options: { freeBytes: async () => 0 } });
      await refuses(disk.downloader.start({ version: '3.11.0' }), 'update_download_disk_full', 'signed, on Windows, with no room');
    }
    // the request carries a version and nothing else: a name in it is not read
    {
      const w = await base();
      feed.requests.length = 0;
      await w.downloader.start({ version: '3.11.0', name: 'Other.exe', url: `${foreign.origin}/x.exe`, sha256: 'a'.repeat(64), bytes: 5, path: 'C:\\Windows\\x.exe' });
      await settled(w.downloader, ['ready', 'failed']);
      assert.equal(w.downloader.status().state, 'ready');
      assert.ok(installerRequests().every((request) => request.url.includes('DatGoldSetup.exe')), 'only the installer the manifest names was asked for');
      assert.equal(foreign.requests.length, 0, 'and nobody else');
      assert.deepEqual(listing(w.folderOf()).filter((name) => name.endsWith('.exe')), ['DatGoldSetup.exe']);
    }
    ok('a click is refused (and nothing is asked for or written) for a version that is not a release or not the one on offer, a release that is unsigned, badly signed or unreadable, a signature that was withdrawn, replaced or cannot be read AFTER the check (the signature is checked again, by the tag, with its own codes), a version that does not rise (the module checks it itself), every platform but win32 (with a code and a status of its own); the signature comes before the platform and the platform before the disk; a name, an address or a hash in the body is not read');
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 4. names, sizes and room on the disk
  {
    for (const name of ['DatGoldSetup.exe', 'ChatMCPSetup.exe', 'a.exe', 'A-b_c.1.exe', `${'a'.repeat(100)}.exe`, 'COM10.exe', 'console.exe']) assert.equal(installerNameProblem(name), null, `${name.slice(0, 30)} is a name`);
    const wrong = {
      'a path up': '..\\x.exe', 'a path up with a slash': '../x.exe', 'a drive': 'C:\\x.exe', 'an alternate stream': 'a:b.exe', 'a folder': 'a/b.exe', 'a share': '\\\\host\\share\\x.exe', 'a device': 'CON.exe', 'a device in lower case': 'con.exe',
      'a device with another extension after it': 'nul.tar.exe', 'COM1': 'COM1.exe', 'LPT9': 'LPT9.exe', 'PRN': 'PRN.exe', 'AUX': 'aux.exe', 'a stem of 101 characters': `${'a'.repeat(101)}.exe`, 'an empty stem': '.exe', 'a hidden file': '.hidden.exe',
      'two dots in a row': 'a..b.exe', 'a space': 'a b.exe', 'a trailing dot': 'a.exe.', 'another extension': 'a.zip', 'an upper-case extension': 'a.EXE', 'no extension': 'a', 'a null': 'a\u0000.exe', 'a letter with an accent': 'ä.exe', 'a number': 5, 'nothing': null,
    };
    for (const [label, name] of Object.entries(wrong)) assert.notEqual(installerNameProblem(name), null, `${label} is not a name: ${JSON.stringify(name)}`);
    // something that is not text is refused as such, also when it would turn into a good name (an array or an object that says so) and then break the rules that read text
    for (const value of [5, null, undefined, true, ['a.exe'], { toString: () => 'a.exe' }]) assert.equal(installerNameProblem(value), 'type', `${typeof value} is not text`);

    // names the manifest may carry that the download still refuses (the manifest check allows up to 128 characters and any extension)
    for (const [name, label] of [['CON.exe', 'a device name'], [`${'a'.repeat(101)}.exe`, 'a stem of 101 characters'], ['setup.EXE', 'an upper-case extension']]) {
      const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 6, name }) });
      assert.equal(w.checker.status().installerName, name, `${label}: the notice still names it`);
      feed.requests.length = 0;
      await refuses(w.downloader.start({ version: '3.11.0' }), 'update_download_bad_name', label, 409);
      assert.equal(installerRequests().length, 0);
      assert.deepEqual(left(w), []);
    }
    // two programs, or none: the Hub does not guess
    for (const [label, assets] of [
      ['two .exe', [{ name: 'A.exe', sha256: 'a'.repeat(64), bytes: 1 * MiB }, { name: 'B.exe', sha256: 'b'.repeat(64), bytes: 1 * MiB }]],
      ['no .exe', [{ name: 'DatGold-Browser-Companion.zip', sha256: 'c'.repeat(64), bytes: 48568 }]],
    ]) {
      const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 7, assets }) });
      await refuses(w.downloader.start({ version: '3.11.0' }), 'update_download_no_installer', label, 409);
      assert.deepEqual(left(w), []);
    }
    // sizes
    for (const [label, size] of [['empty', 0], ['over the limit', DOWNLOAD.maxBytes + 1]]) {
      const release = releaseFor({ size: 1 * MiB, seed: 8 });
      release.manifest.assets[0].bytes = size;
      const w = await world({ release });
      await refuses(w.downloader.start({ version: '3.11.0' }), 'update_download_bad_size', `an installer that is ${label}`, 409);
      assert.deepEqual(left(w), []);
    }
    assert.equal(DOWNLOAD.maxBytes, 2 * 1024 ** 3);
    ok('an installer name is refused unless it is 1 to 100 safe characters and .exe, and not a device name of Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9, whatever follows the first dot): a path, a drive, an alternate stream, a hidden file, two dots; the signed manifest may carry names the download refuses (nothing is asked then); two programs or none are not guessed at; a size of 0 or over 2 GiB is refused');
  }
  {
    const release = releaseFor({ size: 3 * MiB, seed: 9 });
    const calls = [];
    // room: twice the size (the installer stages its payload inside the install folder), looked at before the first byte
    for (const [label, free, expected] of [['one byte short of twice the size', 6 * MiB - 1, 'update_download_disk_full'], ['exactly twice the size', 6 * MiB, null], ['nothing', 0, 'update_download_disk_full']]) {
      const w = await world({ release, options: { freeBytes: async (directory) => { calls.push(directory); return free; } } });
      feed.requests.length = 0;
      if (expected) {
        await refuses(w.downloader.start({ version: '3.11.0' }), expected, label, 507);
        assert.equal(installerRequests().length, 0, `${label}: the installer was not asked for`);
        assert.deepEqual(w.downloader.status(), { state: 'idle' });
        assert.ok(!left(w).some((name) => name.endsWith('.part')), `${label}: no .part file`);
      } else {
        assert.equal((await w.downloader.start({ version: '3.11.0' })).started, true, label);
        assert.equal((await settled(w.downloader, ['ready', 'failed'])).state, 'ready', label);
      }
    }
    assert.ok(calls.length >= 3 && calls.every((directory) => directory.startsWith(scratch)), 'the room is asked about the folder the Hub keeps the file in');
    for (const [label, probe] of [['throws', async () => { throw new Error('no probe'); }], ['NaN', async () => Number.NaN], ['negative', async () => -1], ['text', async () => 'lots'], ['null', async () => null], ['Infinity', async () => Infinity]]) {
      const w = await world({ release, options: { freeBytes: probe } });
      feed.requests.length = 0;
      await refuses(w.downloader.start({ version: '3.11.0' }), 'update_download_disk_unknown', `a probe that ${label}`, 500);
      assert.equal(installerRequests().length, 0, `a probe that ${label}: the installer is not asked for on a guess`);
      assert.equal(w.downloader.status().state, 'idle');
    }
    ok('twice the size must be free (one byte short is refused, exactly twice goes ahead) and that is looked at, on the folder of the Hub, before the first byte; a probe that fails or answers nonsense is a refusal of its own, not a guess');
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 5. the transport goes wrong
  {
    const failure = async (label, arrange, code, { release = releaseFor({ size: 2 * MiB, seed: 10 }), served = release.bytes, options = {} } = {}) => {
      const w = await world({ release, served, options });
      arrange(w);
      feed.requests.length = 0;
      foreign.requests.length = 0;
      const started = await w.downloader.start({ version: '3.11.0' });
      assert.equal(started.started, true, label);
      const done = await settled(w.downloader, ['ready', 'failed']);
      assert.deepEqual(done, { state: 'failed', version: '3.11.0', code }, `${label}: ${JSON.stringify(done)}`);
      assert.deepEqual(left(w), [], `${label}: nothing is left: no .part, no folder`);
      assert.equal(foreign.requests.length, 0, `${label}: the other server was never asked`);
      assert.ok(!JSON.stringify([done, w.lines]).match(/X-Amz|SIGNED-QUERY/), `${label}: no signed address anywhere`);
      await waitUntil(() => feed.openCount() === 0, `${label}: the connection to be closed`);
      return w;
    };
    const base = releaseFor({ size: 2 * MiB, seed: 10 });
    await failure('a hash that is not the signed one (same size, other bytes)', () => {}, 'update_download_hash', { release: base, served: pseudoBytes(2 * MiB, 99) });
    await failure('one bit changed', () => {}, 'update_download_hash', { release: base, served: Buffer.from(base.bytes.map((byte, index) => (index === 1000 ? byte ^ 1 : byte))) });
    await failure('a body shorter than the manifest says, sent without a length', () => feed.installer.mode('chain', { chunked: true }), 'update_download_size', { release: base, served: base.bytes.subarray(0, 2 * MiB - 1) });
    await failure('a body shorter than the manifest says, with its length', () => {}, 'update_download_size', { release: base, served: base.bytes.subarray(0, 1 * MiB) });
    await failure('a body longer than the manifest says, with its length', () => {}, 'update_download_size', { release: base, served: Buffer.concat([base.bytes, Buffer.from('x')]) });
    await failure('a body longer than the manifest says, sent without a length', () => feed.installer.mode('chain', { chunked: true }), 'update_download_size', { release: base, served: Buffer.concat([base.bytes, pseudoBytes(1 * MiB, 11)]) });
    await failure('a body that ends before the length it declared', () => feed.installer.mode('chain', { endAfter: 1 * MiB }), 'update_download_interrupted', { release: base });
    await failure('a connection that is reset half way', () => feed.installer.mode('chain', { resetAfter: 1 * MiB }), 'update_download_interrupted', { release: base });
    await failure('a stream that stops for good', () => feed.installer.mode('chain', { stallAfter: 1 * MiB }), 'update_download_stalled', { release: base, options: { idleTimeoutMs: 400 } });
    await failure('an installer that is not there (404)', () => feed.installer.mode('missing'), 'update_download_http', { release: base });
    await failure('an installer that answers 500', () => feed.installer.mode('status', { status: 500 }), 'update_download_http', { release: base });
    await failure('a redirect to another host', () => feed.installer.mode('redirect', { target: `${foreign.origin}/x.exe` }), 'update_download_redirect', { release: base });
    await failure('a redirect to another port of the same machine', () => feed.installer.mode('redirect', { target: `http://127.0.0.1:${Number(new URL(foreign.origin).port)}/x.exe` }), 'update_download_redirect', { release: base });
    await failure('a redirect to https on the same machine', () => feed.installer.mode('redirect', { target: `https://127.0.0.1:${new URL(feed.origin).port}/x.exe` }), 'update_download_redirect', { release: base });
    await failure('a redirect with no Location', () => feed.installer.mode('redirect', { target: null }), 'update_download_redirect', { release: base });
    await failure('a redirect that never ends', () => feed.installer.mode('redirect', { target: `${feed.origin}${feed.installer.path()}` }), 'update_download_redirect', { release: base });
    assert.equal(installerRequests().length, DOWNLOAD.maxRedirects + 1, 'a redirect that never ends is followed as many times as the limit says and then refused: the request and three redirects');
    await failure('a redirect to a login in the address', () => feed.installer.mode('redirect', { target: `http://user:pw@127.0.0.1:${new URL(feed.origin).port}/x.exe` }), 'update_download_redirect', { release: base });
    // a body that goes on past the size of the manifest is cut at the first bytes over, as they come: the server holds the stream a little after the size, and the Hub has already given up
    {
      const w = await world({ release: base, served: Buffer.concat([base.bytes, pseudoBytes(1 * MiB, 15)]), options: { idleTimeoutMs: 5000 } });
      feed.installer.mode('chain', { chunked: true, pauseAfter: 2 * MiB + 128 * 1024 });
      await w.downloader.start({ version: '3.11.0' });
      const cut = await waitUntil(() => w.downloader.status().state === 'failed' && w.downloader.status(), 'the failure of a body that is too long', 3000);
      assert.equal(cut.code, 'update_download_size', 'cut as it comes, not after the server has gone on or the connection has been idle');
      feed.installer.resume();
      await waitUntil(() => feed.openCount() === 0, 'the connection to be closed');
      assert.deepEqual(left(w), []);
    }
    // a stream that is slow but never idle for long is fine: there is no deadline for all of it
    const slow = await world({ release: releaseFor({ size: 1 * MiB, seed: 12 }), options: { idleTimeoutMs: 600 } });
    feed.installer.mode('chain', { pauseAfter: 512 * 1024 });
    await slow.downloader.start({ version: '3.11.0' });
    await waitUntil(() => slow.downloader.status().received === 512 * 1024, 'the first half');
    await sleep(300);
    feed.installer.resume();
    assert.equal((await settled(slow.downloader, ['ready', 'failed'])).state, 'ready', 'a pause shorter than the idle limit does not matter');
    // a body that is headed for a size the manifest does not have is cut as soon as it is known: not read to its end
    const huge = await world({ release: releaseFor({ size: 1 * MiB, seed: 13 }), served: pseudoBytes(40 * MiB, 14) });
    const sentBefore = feed.installer.sent();
    await huge.downloader.start({ version: '3.11.0' });
    await settled(huge.downloader, ['failed']);
    const sentOf40 = feed.installer.sent() - sentBefore;
    assert.ok(sentOf40 < 1 * MiB, 'a declared size that is not the manifest\'s is refused from the headers: the body is not read (a body read until it passes the size of the manifest would have sent at least 1 MiB)');
    ok('every way the transport can go wrong ends as a failure with its own code and nothing left behind (no .part, no folder, the other server never asked): other bytes of the same size, one bit, a short body (with or without a length), a long one (declared, or counted as it comes and cut), a body that ends before its length, a reset, a stall (idle, not total: a pause shorter than the limit is fine), a 404 or 500, a redirect to another host, another port, https, a login, nowhere, or for ever');
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 6. the Hub's own files go wrong
  {
    const fail = (code) => ({ state: 'failed', version: '3.11.0', code });
    const outcome = async (label, hook, expected, { release = releaseFor({ size: 2 * MiB, seed: 15 }) } = {}) => {
      const w = await world({ release, options: { fsApi: faulty(hook), renameDelayMs: 1 } });
      const started = await w.downloader.start({ version: '3.11.0' });
      assert.equal(started.started, true, label);
      const done = await settled(w.downloader, ['ready', 'failed']);
      assert.deepEqual(done, expected ?? { state: 'ready', version: '3.11.0', bytes: release.size }, `${label}: ${JSON.stringify(done)}`);
      if (expected) assert.deepEqual(left(w), [], `${label}: nothing is left`);
      return w;
    };
    const limited = (real, limit) => { let written = 0; return new Writable({ write(chunk, encoding, callback) { written += chunk.length; if (written > limit) callback(coded('ENOSPC')); else real.write(chunk, callback); }, final(callback) { real.end(callback); } }); };
    await outcome('the disk fills up while the installer is written', async (name, args, call) => {
      const result = await call();
      if (name === 'open' && String(args[0]).endsWith('.part')) { const original = result.createWriteStream.bind(result); result.createWriteStream = (...more) => limited(original(...more), 1 * MiB); }
      return result;
    }, fail('update_download_disk_full'));
    await outcome('the .part file cannot be created', async (name, args, call) => { if (name === 'open' && String(args[0]).endsWith('.part')) throw coded('EACCES'); return call(); }, fail('update_download_write'));
    await outcome('the folder of the version cannot be made', async (name, args, call) => { if (name === 'mkdir' && String(args[0]).includes('3.11.0')) throw coded('EACCES'); return call(); }, fail('update_download_write'));
    let renames = 0;
    await outcome('the antivirus holds the file for a moment: a rename that fails twice and then works', async (name, args, call) => { if (name === 'rename' && String(args[0]).endsWith('.part') && (renames += 1) <= 2) throw coded('EPERM'); return call(); }, null);
    assert.equal(renames, 3, 'and it was tried three times');
    let busy = 0;
    await outcome('a rename that never works', async (name, args, call) => { if (name === 'rename' && String(args[0]).endsWith('.part')) { busy += 1; throw coded('EBUSY'); } return call(); }, fail('update_download_write'));
    assert.equal(busy, DOWNLOAD.renameAttempts, 'and it was tried as many times as the limit says, and no more');
    let stateRenames = 0;
    await outcome('the antivirus holds the state file for a moment too: its rename fails twice and then works', async (name, args, call) => { if (name === 'rename' && String(args[0]).endsWith('state.json.tmp') && (stateRenames += 1) <= 2) throw coded('EPERM'); return call(); }, null);
    assert.equal(stateRenames, 3, 'and it was tried three times: a checked installer is not thrown away for a lock that lasts a moment');
    let others = 0;
    await outcome('a rename that is refused for another reason is not tried again', async (name, args, call) => { if (name === 'rename' && String(args[0]).endsWith('.part')) { others += 1; throw coded('ENOENT'); } return call(); }, fail('update_download_write'));
    assert.equal(others, 1);
    await outcome('the state file cannot be saved: the installer is not left without it', async (name, args, call) => { if ((name === 'rename' || name === 'writeFile') && /state\.json/.test(`${args[0]} ${args[1]}`)) throw coded('EIO'); return call(); }, fail('update_download_save'));
    await outcome('the copy of the manifest cannot be saved', async (name, args, call) => { if (name === 'writeFile' && String(args[0]).endsWith('RELEASE-MANIFEST.json')) throw coded('EIO'); return call(); }, fail('update_download_save'));
    await outcome('the copy of the signature cannot be saved', async (name, args, call) => { if (name === 'writeFile' && String(args[0]).endsWith('RELEASE-MANIFEST.json.sig')) throw coded('EIO'); return call(); }, fail('update_download_save'));
    // fsync happens before the rename
    const order = [];
    const synced = await world({ release: releaseFor({ size: 1 * MiB, seed: 16 }), options: { renameDelayMs: 1, fsApi: faulty(async (name, args, call) => {
      if (name === 'rename' && String(args[0]).endsWith('.part')) order.push('rename');
      const result = await call();
      if (name === 'open' && String(args[0]).endsWith('.part')) { const sync = result.sync.bind(result); result.sync = async () => { order.push('sync'); return sync(); }; }
      return result;
    }) } });
    await synced.downloader.start({ version: '3.11.0' });
    await settled(synced.downloader, ['ready', 'failed']);
    assert.equal(synced.downloader.status().state, 'ready');
    assert.ok(order.indexOf('sync') >= 0 && order.indexOf('sync') < order.indexOf('rename'), `the file is flushed before it is renamed (${order.join(',')})`);
    // the folder for updates is not a folder
    for (const [label, plant] of [
      ['a file', (root) => fs.writeFileSync(root, 'not a folder')],
      ['a link to a folder that is not the Hub\'s', (root, target) => fs.symlinkSync(target, root, process.platform === 'win32' ? 'junction' : 'dir')],
    ]) {
      const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 17 }) });
      const target = folder();
      fs.writeFileSync(path.join(target, 'canary.txt'), 'must survive');
      fs.mkdirSync(path.join(target, '3.0.0'));
      fs.writeFileSync(path.join(target, '3.0.0', 'canary.txt'), 'must survive');
      plant(w.root, target);
      const fresh = another(w);
      await fresh.load();
      feed.requests.length = 0;
      await refuses(fresh.start({ version: '3.11.0' }), 'update_download_folder', `updates is ${label}`, 500);
      assert.equal(installerRequests().length, 0, `${label}: the installer was not asked for`);
      assert.equal(fs.readFileSync(path.join(target, 'canary.txt'), 'utf8'), 'must survive', `${label}: nothing was written through it`);
      assert.equal(fs.readFileSync(path.join(target, '3.0.0', 'canary.txt'), 'utf8'), 'must survive', `${label}: and nothing was deleted through it`);
      assert.deepEqual(fs.readdirSync(target).sort(), ['3.0.0', 'canary.txt'], `${label}: the other folder is as it was`);
      fs.rmSync(w.root, { recursive: true, force: true });
    }
    // the folder of updates is a plain folder when the click looks at it, and is looked at again before the attempt is tidied: a link put there in the meantime is not walked into
    {
      const canary = folder();
      fs.mkdirSync(path.join(canary, '3.0.0'));
      fs.writeFileSync(path.join(canary, '3.0.0', 'canary.txt'), 'must survive');
      let swapped = false;
      const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 31 }), options: { renameDelayMs: 1, fsApi: faulty(async (name, args, call) => {
        const result = await call();
        if (name === 'rename' && String(args[0]).endsWith('state.json.tmp') && !swapped) { // the last write of the attempt: only the tidying is left
          swapped = true;
          const root = path.dirname(path.dirname(String(args[0])));
          fs.rmSync(root, { recursive: true, force: true });
          fs.symlinkSync(canary, root, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return result;
      }) } });
      await w.downloader.start({ version: '3.11.0' });
      await settled(w.downloader, ['ready', 'failed']);
      assert.ok(swapped, 'the test did put a link where the folder of updates was');
      assert.equal(fs.readFileSync(path.join(canary, '3.0.0', 'canary.txt'), 'utf8'), 'must survive', 'the tidying did not walk into it and delete what it holds');
      fs.rmSync(w.root, { recursive: true, force: true });
    }
    ok('the Hub\'s own files can fail and the promises hold: a disk that fills, a file or folder that cannot be made, a rename that the antivirus holds (tried again a few times, only for EPERM, EBUSY and EACCES), a state file, a copy of the manifest or of the signature that cannot be saved, each ends as a failure with its code and nothing left (no installer without its state); the file is flushed before it is renamed; a folder for updates that is a file or a link is refused and nothing is written or deleted through it');
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 6b. the moments of a download, held still
  {
    // a Cancel that comes while the click is still being looked at, before there is any connection for the installer, is a cancel: the click starts nothing
    {
      const held = hold();
      const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 25 }), options: { fsApi: faulty(async (name, args, call) => { if (name === 'mkdir' && isRoot(args[0])) { held.arrive(); await held.opened; } return call(); }) } });
      feed.requests.length = 0;
      const click = w.downloader.start({ version: '3.11.0' });
      await held.arrived;
      assert.equal(w.downloader.status().state, 'downloading', 'the click is under way');
      const cancelled = await w.downloader.cancel();
      assert.equal(cancelled.cancelled, true, 'a Cancel before the download has begun is a cancel');
      held.release();
      assert.equal((await click).started, false, 'and the click that was cancelled starts nothing');
      assert.deepEqual(w.downloader.status(), { state: 'idle' });
      assert.equal(installerRequests().length, 0, 'the installer was never asked for');
      assert.deepEqual(left(w), []);
    }

    // a Cancel that comes while the release is being looked at, and a look that then fails (the signature does not come), ends as a click that was cancelled, not as a failure the owner never asked about
    {
      const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 32 }), options: { timeoutMs: 600 } });
      feed.signature.mode('stall');
      const click = w.downloader.start({ version: '3.11.0' });
      assert.equal((await w.downloader.cancel()).cancelled, true);
      assert.equal((await click).started, false, 'the click is answered as a cancelled one');
      assert.deepEqual(w.downloader.status(), { state: 'idle' });
      await waitUntil(() => feed.openCount() === 0, 'the request that stalled to be closed');
      feed.signature.mode('chain');
    }

    // the end of a download, held still twice: while the file is being flushed and renamed, and while the folder is being tidied
    {
      const renaming = hold();
      const tidying = hold();
      let tidies = 0;
      const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 26 }), options: { renameDelayMs: 1, fsApi: faulty(async (name, args, call) => {
        if (name === 'rename' && String(args[0]).endsWith('.part')) { renaming.arrive(); await renaming.opened; }
        if (name === 'readdir' && isRoot(args[0]) && (tidies += 1) === 2) { tidying.arrive(); await tidying.opened; } // the second look at the folder is the tidying after the attempt
        return call();
      }) } });
      await w.downloader.start({ version: '3.11.0' });
      await renaming.arrived;
      assert.equal(w.downloader.status().state, 'verifying', 'while the file is being flushed and renamed the status says that it is being checked');
      renaming.release();
      await tidying.arrived;
      assert.notEqual(w.downloader.status().state, 'ready', 'and it is not ready while the folder is still being tidied: nobody sees "ready" and then finds a download still at work');
      const late = w.downloader.cancel();
      tidying.release();
      assert.equal((await late).cancelled, false, 'a Cancel that comes when the work is done is not a cancel');
      assert.deepEqual(w.downloader.status(), { state: 'ready', version: '3.11.0', bytes: 1 * MiB }, 'and the download stays ready');
      assert.ok(fs.existsSync(path.join(w.folderOf(), 'DatGoldSetup.exe')));
    }
    ok('a Cancel that comes while the click is still being looked at (no connection yet) is a cancel and the click starts nothing; the status says "verifying" while the file is flushed and renamed, is not "ready" while the folder is still being tidied, and a Cancel that comes when the work is done does not claim to have cancelled');
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 7. what a Hub that starts again finds
  {
    const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 18 }) });
    await w.downloader.start({ version: '3.11.0' });
    await settled(w.downloader, ['ready']);
    const root = w.root;
    const plant = (name, files) => { const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true }); for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), text); };
    // leftovers of a Hub that was killed in the middle of a download
    plant('3.12.0', { 'DatGoldSetup.exe.part': 'half' });
    plant('3.9.0', { 'DatGoldSetup.exe': 'an old installer', 'state.json': '{}' });
    plant('3.11.5', {});
    fs.writeFileSync(path.join(root, '3.8.0'), 'a file where a folder should be');
    fs.writeFileSync(path.join(w.folderOf(), 'DatGoldSetup.exe.part'), 'a part beside a finished installer');
    plant('not-a-version', { 'keep.txt': 'not ours' });
    fs.writeFileSync(path.join(root, 'notes.txt'), 'not ours either');
    // a link where a version folder should be, and a link inside the kept one: neither is followed
    const target = folder();
    fs.writeFileSync(path.join(target, 'canary.txt'), 'must survive');
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(target, path.join(root, '3.0.0'), kind);
    fs.symlinkSync(target, path.join(w.folderOf(), 'evil'), kind);
    const found = await another(w, { freeBytes: async () => 0 }).load();
    assert.deepEqual(found, { state: 'ready', version: '3.11.0', bytes: w.release.size }, 'what was finished is still ready');
    assert.deepEqual(fs.readdirSync(root).sort(), ['3.11.0', 'not-a-version', 'notes.txt'], 'the leftovers are gone: a .part, folders of other versions, an empty one, a file named like a version, a link; names that are not versions are not touched');
    assert.ok(!listing(w.folderOf()).some((name) => name.endsWith('.part')), 'a .part beside a finished installer is removed');
    assert.equal(fs.existsSync(path.join(w.folderOf(), 'evil')), false, 'and a link inside the folder that is kept is removed as a link');
    assert.equal(fs.readFileSync(path.join(target, 'canary.txt'), 'utf8'), 'must survive', 'neither link was followed: what they pointed at is untouched');
    assert.equal(fs.readFileSync(path.join(root, 'not-a-version', 'keep.txt'), 'utf8'), 'not ours');
    // two finished downloads that both prove themselves: the newer is kept and the older one goes
    const two = await world({ release: releaseFor({ size: 1 * MiB, seed: 24 }) });
    await two.downloader.start({ version: '3.11.0' });
    await settled(two.downloader, ['ready']);
    const older = folder();
    fs.cpSync(two.folderOf(), path.join(older, '3.11.0'), { recursive: true });
    publish(releaseFor({ version: '3.12.0', size: 1 * MiB, seed: 29 }));
    await two.recheck();
    await two.downloader.start({ version: '3.12.0' });
    await settled(two.downloader, ['ready']);
    fs.cpSync(path.join(older, '3.11.0'), path.join(two.root, '3.11.0'), { recursive: true });
    assert.ok(fs.existsSync(path.join(two.root, '3.11.0', 'state.json')) && fs.existsSync(path.join(two.root, '3.12.0', 'state.json')), 'both folders are finished');
    const kept = await another(two).load();
    assert.deepEqual(kept, { state: 'ready', version: '3.12.0', bytes: 1 * MiB }, 'of two downloads that both prove themselves the newer is the one that is ready');
    assert.ok(!fs.existsSync(path.join(two.root, '3.11.0')), 'and the older one is removed');
    fs.cpSync(two.folderOf('3.12.0'), path.join(two.root, '3.10.9'), { recursive: true });
    assert.equal((await another(two).load()).version, '3.12.0');
    assert.ok(!fs.existsSync(path.join(two.root, '3.10.9')), 'a folder of an older version is removed even when it looks finished');
    // names in the folder of updates that are not versions are not touched by a download either
    {
      const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 27 }) });
      fs.mkdirSync(path.join(w.root, 'not-a-version'), { recursive: true });
      fs.writeFileSync(path.join(w.root, 'not-a-version', 'keep.txt'), 'not ours');
      fs.writeFileSync(path.join(w.root, 'notes.txt'), 'not ours either');
      await w.downloader.start({ version: '3.11.0' });
      assert.equal((await settled(w.downloader, ['ready', 'failed'])).state, 'ready');
      assert.deepEqual(fs.readdirSync(w.root).sort(), ['3.11.0', 'not-a-version', 'notes.txt'], 'a download touches the folders of versions and nothing else');
      assert.equal(fs.readFileSync(path.join(w.root, 'not-a-version', 'keep.txt'), 'utf8'), 'not ours');
    }
    // a link where a version folder should be, which leads to a folder that proves itself: removed as a link, and what it led to is as it was
    {
      const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 30 }) });
      await w.downloader.start({ version: '3.11.0' });
      await settled(w.downloader, ['ready']);
      const elsewhere = folder();
      fs.renameSync(w.folderOf(), path.join(elsewhere, '3.11.0'));
      fs.symlinkSync(path.join(elsewhere, '3.11.0'), w.folderOf(), process.platform === 'win32' ? 'junction' : 'dir');
      assert.deepEqual(await another(w).load(), { state: 'idle' }, 'a link is not a download, however good what it leads to is');
      assert.equal(fs.existsSync(w.folderOf()), false, 'the link is gone');
      assert.ok(fs.existsSync(path.join(elsewhere, '3.11.0', 'DatGoldSetup.exe')), 'and what it led to is as it was');
    }
    // a state file that names an installer which the download would not have accepted is not believed, although the signed manifest lists the same name
    {
      const w = await world({ release: releaseFor({ size: 1 * MiB, seed: 28, name: 'setup.EXE' }) });
      fs.mkdirSync(w.folderOf(), { recursive: true });
      fs.writeFileSync(path.join(w.folderOf(), MANIFEST_COPY), feed.manifestBytes());
      fs.writeFileSync(path.join(w.folderOf(), SIGNATURE_COPY), Buffer.from(feed.signature.current()));
      fs.writeFileSync(path.join(w.folderOf(), 'setup.EXE'), w.release.bytes);
      fs.writeFileSync(path.join(w.folderOf(), 'state.json'), JSON.stringify({ version: 1, release: '3.11.0', name: 'setup.EXE', bytes: w.release.size, sha256: w.release.sha, kid: owner.kid }));
      assert.equal(verifyManifest(fs.readFileSync(path.join(w.folderOf(), MANIFEST_COPY)), fs.readFileSync(path.join(w.folderOf(), SIGNATURE_COPY)), trusted).kid, owner.kid, 'the manifest that is kept is signed, and lists that name');
      assert.equal((await another(w).load()).state, 'idle', 'the name is not one that the download accepts');
      assert.equal(fs.existsSync(w.folderOf()), false);
    }
    ok('a Hub that starts again deletes what a killed one left: .part files, folders of other versions, an empty one, a file named like a version, a link where a folder should be (as a link: what it points at is untouched), a link inside the kept folder; it keeps what is finished and valid, and does not touch names that are not versions');
  }
  {
    // a finished download is trusted only as far as its own files prove it
    const release = releaseFor({ size: 1 * MiB, seed: 20 });
    const finished = async () => {
      const w = await world({ release });
      await w.downloader.start({ version: '3.11.0' });
      await settled(w.downloader, ['ready']);
      return w;
    };
    const state = (w) => JSON.parse(fs.readFileSync(path.join(w.folderOf(), 'state.json'), 'utf8'));
    const rewrite = (w, change) => fs.writeFileSync(path.join(w.folderOf(), 'state.json'), JSON.stringify(change(state(w))));
    const damages = {
      'state.json: not JSON': (w) => fs.writeFileSync(path.join(w.folderOf(), 'state.json'), '{ nope'),
      'state.json: empty': (w) => fs.writeFileSync(path.join(w.folderOf(), 'state.json'), ''),
      'state.json: an array': (w) => fs.writeFileSync(path.join(w.folderOf(), 'state.json'), '[]'),
      'state.json: another format': (w) => rewrite(w, (s) => ({ ...s, version: 2 })),
      'state.json: another release': (w) => rewrite(w, (s) => ({ ...s, release: '3.11.1' })),
      'state.json: a release that is not x.y.z': (w) => rewrite(w, (s) => ({ ...s, release: '3.11.0-rc.1' })),
      'state.json: a name with a path': (w) => rewrite(w, (s) => ({ ...s, name: '..\\x.exe' })),
      'state.json: another name': (w) => rewrite(w, (s) => ({ ...s, name: 'Other.exe' })),
      'state.json: a device name': (w) => rewrite(w, (s) => ({ ...s, name: 'CON.exe' })),
      'state.json: a size that is text': (w) => rewrite(w, (s) => ({ ...s, bytes: String(s.bytes) })),
      'state.json: a size that is negative': (w) => rewrite(w, (s) => ({ ...s, bytes: -1 })),
      'state.json: a size that is not the file\'s': (w) => rewrite(w, (s) => ({ ...s, bytes: s.bytes + 1 })),
      'state.json: a digest that is not hex': (w) => rewrite(w, (s) => ({ ...s, sha256: 'z'.repeat(64) })),
      'state.json: another digest': (w) => rewrite(w, (s) => ({ ...s, sha256: 'a'.repeat(64) })),
      'state.json: no key id': (w) => rewrite(w, (s) => ({ ...s, kid: undefined })),
      'state.json: another key id': (w) => rewrite(w, (s) => ({ ...s, kid: '00000000' })),
      'the copy of the manifest: one byte changed': (w) => { const file = path.join(w.folderOf(), MANIFEST_COPY); const bytes = fs.readFileSync(file); bytes[bytes.length - 4] ^= 1; fs.writeFileSync(file, bytes); },
      'the copy of the manifest: gone': (w) => fs.rmSync(path.join(w.folderOf(), MANIFEST_COPY)),
      'the copy of the signature: gone': (w) => fs.rmSync(path.join(w.folderOf(), SIGNATURE_COPY)),
      'the copy of the signature: another key': (w) => fs.writeFileSync(path.join(w.folderOf(), SIGNATURE_COPY), signatureFor(fs.readFileSync(path.join(w.folderOf(), MANIFEST_COPY)), throwawayKey())),
      'the copy of the signature: empty': (w) => fs.writeFileSync(path.join(w.folderOf(), SIGNATURE_COPY), ''),
      'the installer: a byte more': (w) => fs.appendFileSync(path.join(w.folderOf(), 'DatGoldSetup.exe'), 'x'),
      'the installer: a byte less': (w) => { const file = path.join(w.folderOf(), 'DatGoldSetup.exe'); fs.writeFileSync(file, fs.readFileSync(file).subarray(1)); },
      'the installer: gone': (w) => fs.rmSync(path.join(w.folderOf(), 'DatGoldSetup.exe')),
      'the installer: a folder': (w) => { const file = path.join(w.folderOf(), 'DatGoldSetup.exe'); fs.rmSync(file); fs.mkdirSync(file); },
      'state.json: gone': (w) => fs.rmSync(path.join(w.folderOf(), 'state.json')),
    };
    for (const [label, damage] of Object.entries(damages)) {
      const w = await finished();
      damage(w);
      const restarted = another(w);
      assert.deepEqual(await restarted.load(), { state: 'idle' }, `${label}: not ready`);
      assert.equal(fs.existsSync(w.folderOf()), false, `${label}: and the folder is removed (a download that cannot prove itself is not kept)`);
      assert.deepEqual(restarted.status(), { state: 'idle' });
    }
    // a finished download that no longer applies
    const applies = await finished();
    assert.equal((await another(applies, { currentVersion: '3.11.0' }).load()).state, 'idle', 'the version that runs is already the one downloaded (the update was installed): nothing to offer');
    assert.equal(fs.existsSync(applies.folderOf()), false);
    const newer = await finished();
    assert.equal((await another(newer, { currentVersion: '3.12.0' }).load()).state, 'idle', 'a Hub that is newer than the download');
    const other = await finished();
    assert.equal((await another(other).load()).state, 'ready');
    assert.equal((await another(other, { releaseKeys: parseReleaseKeys(keyFileText([throwawayKey().entry])).keys }).load()).state, 'idle', 'a Hub that no longer trusts the key that signed it (a key list that changed) does not call it ready');
    assert.equal(fs.existsSync(other.folderOf()), false);
    ok(`a finished download is ready after a restart only as far as its own files prove it: ${Object.keys(damages).length} kinds of damage (the state file field by field, the copy of the manifest or of the signature, the installer's size, gone, or a folder) each give "not ready" and remove the folder; one that is no longer newer than the Hub, or was signed by a key the Hub no longer trusts, is not ready either`);
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 8. the offer changes under a download
  {
    const release = releaseFor({ size: 8 * MiB, seed: 21 });
    const watched = async (options = {}) => {
      const w = await world({ release });
      let current = w.checker.status();
      const downloader = another(w, { offer: () => current, ...options });
      await downloader.load();
      return { ...w, downloader, offerIs: (next) => { current = { ...current, ...next }; } };
    };
    // a download that runs when the release changes is stopped
    for (const [label, change] of [['a newer release', { latest: '3.11.1' }], ['the release is gone', { available: false }], ['the signature was withdrawn', { signature: 'missing' }], ['the signature does not check', { signature: 'invalid' }]]) {
      const w = await watched();
      feed.installer.mode('chain', { pauseAfter: 2 * MiB });
      await w.downloader.start({ version: '3.11.0' });
      await waitUntil(() => w.downloader.status().received >= 2 * MiB, 'part of the installer');
      w.offerIs(change);
      await w.downloader.reconcile();
      assert.deepEqual(w.downloader.status(), { state: 'idle' }, `${label}: the download was stopped`);
      assert.deepEqual(left(w), [], `${label}: and its files are gone`);
      feed.installer.resume();
      await waitUntil(() => feed.installer.openCount() === 0, 'the connection to close');
    }
    // one that is running keeps running when a check could not READ the signature (null says nothing about the release)
    {
      const w = await watched();
      feed.installer.mode('chain', { pauseAfter: 2 * MiB });
      await w.downloader.start({ version: '3.11.0' });
      await waitUntil(() => w.downloader.status().received >= 2 * MiB, 'part of the installer');
      w.offerIs({ signature: null });
      await w.downloader.reconcile();
      assert.equal(w.downloader.status().state, 'downloading', 'a signature that could not be read does not stop a download');
      feed.installer.resume();
      assert.equal((await settled(w.downloader, ['ready', 'failed'])).state, 'ready');
    }
    // a download that is ready is dropped when the release it belongs to is not on offer any more
    for (const [label, change, kept] of [['a newer release', { latest: '3.11.1' }, false], ['an older one (the feed is the truth)', { latest: '3.10.9' }, false], ['no longer available', { available: false }, false], ['the signature withdrawn', { signature: 'missing' }, false], ['the signature unreadable', { signature: null }, true], ['nothing known', { latest: null }, true], ['unchanged', {}, true]]) {
      const w = await watched();
      await w.downloader.start({ version: '3.11.0' });
      await settled(w.downloader, ['ready']);
      w.offerIs(change);
      await w.downloader.reconcile();
      assert.equal(w.downloader.status().state, kept ? 'ready' : 'idle', `${label}: ${kept ? 'kept' : 'dropped'}`);
      assert.equal(fs.existsSync(w.folderOf()), kept, `${label}: the files ${kept ? 'stay' : 'go'}`);
    }
    // a check that finishes while the click is still being looked at (nothing is running yet) stops that click, as the owner's Cancel would
    {
      const held = hold();
      const w = await watched({ fsApi: faulty(async (name, args, call) => { if (name === 'mkdir' && isRoot(args[0])) { held.arrive(); await held.opened; } return call(); }) });
      feed.requests.length = 0;
      const click = w.downloader.start({ version: '3.11.0' });
      await held.arrived;
      w.offerIs({ latest: '3.11.1' });
      await w.downloader.reconcile();
      held.release();
      assert.equal((await click).started, false, 'the click that the offer has left behind starts nothing');
      assert.deepEqual(w.downloader.status(), { state: 'idle' });
      assert.equal(installerRequests().length, 0, 'and the installer is never asked for');
      assert.deepEqual(left(w), []);
    }
    // a check that finishes when the file is already being renamed into place, where nothing reads a cancel any more, still drops the download
    {
      const renaming = hold();
      const w = await watched({ renameDelayMs: 1, fsApi: faulty(async (name, args, call) => { if (name === 'rename' && String(args[0]).endsWith('.part')) { renaming.arrive(); await renaming.opened; } return call(); }) });
      await w.downloader.start({ version: '3.11.0' });
      await renaming.arrived;
      w.offerIs({ signature: 'missing' });
      const dropping = w.downloader.reconcile();
      renaming.release();
      await dropping;
      assert.deepEqual(w.downloader.status(), { state: 'idle' }, 'a download that was past the point of a cancel is dropped all the same');
      assert.deepEqual(left(w), [], 'with its files');
    }
    // a ready download is dropped by saying so first: while its folder is being removed the status is not "ready" any more
    {
      const removing = hold();
      let gate = false;
      const w = await watched({ fsApi: faulty(async (name, args, call) => { if (gate && name === 'rm') { removing.arrive(); await removing.opened; } return call(); }) });
      await w.downloader.start({ version: '3.11.0' });
      await settled(w.downloader, ['ready']);
      gate = true;
      w.offerIs({ signature: 'missing' });
      const dropping = w.downloader.reconcile();
      await removing.arrived;
      assert.deepEqual(w.downloader.status(), { state: 'idle' }, 'the status stops saying "ready" before its folder is gone');
      removing.release();
      await dropping;
      assert.deepEqual(left(w), []);
    }
    // stop() (the Hub shuts down): a download in progress is cut and its .part is removed
    const w = await watched();
    feed.installer.mode('chain', { pauseAfter: 2 * MiB });
    await w.downloader.start({ version: '3.11.0' });
    await waitUntil(() => w.downloader.status().received >= 2 * MiB, 'part of the installer');
    const stopping = performance.now();
    await w.downloader.stop();
    assert.ok(performance.now() - stopping < 2000, 'stop() cuts the connection at once: it does not wait for the idle limit (5 s here) to run out');
    assert.deepEqual(left(w), [], 'a Hub that shuts down leaves no .part behind');
    feed.installer.resume();
    await waitUntil(() => feed.installer.openCount() === 0, 'the connection to close');
    ok('when a check changes the offer under a download it is stopped and its files removed (a newer release, the release gone, a signature withdrawn or not checking), but not for a signature that could not be read; a ready download is dropped for the same reasons and kept for "unreadable" and "nothing known"; stop() cuts a download and removes its .part');
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 9. a clock that jumps, status that reads nothing, and what the module is not
  {
    const w = await world({ release: releaseFor({ size: 8 * MiB, seed: 22 }) });
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    feed.installer.mode('chain', { pauseAfter: 2 * MiB });
    try {
      await w.downloader.start({ version: '3.11.0' });
      await waitUntil(() => w.downloader.status().received >= 2 * MiB, 'part of the installer');
      skew = 3 * 86_400_000; // the clock jumps three days ahead in the middle of the stream
      feed.installer.resume();
      await sleep(50);
      skew = -5 * 86_400_000; // and then two days behind where it started
      const done = await settled(w.downloader, ['ready', 'failed']);
      assert.deepEqual(done, { state: 'ready', version: '3.11.0', bytes: 8 * MiB }, 'a clock that jumps forwards and backwards does not matter to a download that has no deadline for all of it');
    } finally { Date.now = realNow; }
    const state = fs.readFileSync(path.join(w.folderOf(), 'state.json'), 'utf8');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(state), 'no time is saved, so a clock cannot make a saved file wrong');
    const source = fs.readFileSync(path.join(HUB_ROOT, 'lib', 'update-download.mjs'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bDate\b|performance\.now|process\.hrtime/.test(code), 'the module reads no clock: its only timer is the idle one');
    assert.ok(!/child_process|\bspawn\b|\bexecFile\b|\bexecSync\b|\bfork\(|process\.env|\bshell\b/.test(code), 'it starts no program and reads no environment variable');
    assert.ok(!/readFile\([^)]*\.exe|createReadStream|\.exe['"`]\)?\s*,\s*['"`]r/.test(code), 'and never opens the installer to read it');
    assert.ok(!/redirect:\s*['"]follow['"]/.test(code), 'it does not hand redirects to a library');
    // status() is memory: no file is touched however often it is asked
    const touched = [];
    const quiet = await world({ release: releaseFor({ size: 1 * MiB, seed: 23 }), options: { fsApi: faulty(async (name, args, call) => { touched.push(name); return call(); }) } });
    touched.length = 0;
    for (let index = 0; index < 200; index += 1) quiet.downloader.status();
    assert.deepEqual(touched, [], 'status() reads memory only');
    assert.deepEqual(Object.keys(quiet.downloader.status()), ['state']);
    assert.equal(DOWNLOAD.idleTimeoutMs, 60_000);
    assert.equal(DOWNLOAD.freeSpaceFactor, 2);
    assert.equal(DOWNLOAD.maxRedirects, 3);
    ok('a clock that jumps three days ahead and five behind in the middle of a download changes nothing, no time is in any file and the module reads no clock; status() touches no file; the module starts no program, reads no environment variable, never opens the installer and hands no redirect to a library; the limits are 60 s idle, twice the size free and 3 redirects');
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 10. the script of the hand check
  {
    // tests/live/check-update-download.mjs is what the owner runs by hand against the real feed; here it runs offline against the stand-in, because a tool that is never run rots
    const live = path.join(HUB_ROOT, 'tests', 'live', 'check-update-download.mjs');
    const runLive = (args, env = {}) => new Promise((resolve) => {
      const child = spawn(process.execPath, [live, ...args], { env: { ...process.env, CHATMCP_UPDATE_FEED_URL: feed.url, CHATMCP_UPDATE_TEST_KEY: owner.spkiBase64, ...env }, windowsHide: true });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    publish(releaseFor({ size: 1 * MiB, seed: 31 }));
    const before = feed.requests.length;
    const valid = await runLive(['--expect', 'valid']);
    assert.equal(valid.code, 0, valid.output);
    assert.match(valid.output, /\(a loopback stand-in\)/);
    assert.match(valid.output, new RegExp(`signature:\\s+valid\\s+\\(key ${owner.kid}\\)`));
    assert.match(valid.output, /newer:\s+3\.11\.0 is newer than 3\.10\.2/);
    assert.match(valid.output, /download:\s+a click would fetch .*\/releases\/download\/v3\.11\.0\/DatGoldSetup\.exe/);
    assert.match(valid.output, /NOT fetched now/);
    assert.match(valid.output, /OK: the Hub reads this answer and would offer the download\./);
    const asked = feed.requests.slice(before).map((request) => request.url.split('?')[0]);
    assert.ok(asked.length >= 2 && asked.every((url) => !url.endsWith('.exe')), `the script asks for the manifest and the signature and never for the installer: ${asked.join(' ')}`);
    feed.signature.mode('missing');
    const missing = await runLive([]);
    assert.equal(missing.code, 0, missing.output);
    assert.match(missing.output, /signature:\s+missing\s+\(GitHub answered 404/);
    assert.match(missing.output, /download:\s+no button; the page says why/);
    assert.match(missing.output, /would announce the release without a download button/);
    assert.equal((await runLive(['--expect', 'missing'])).code, 0, 'the answer that was expected');
    const unexpected = await runLive(['--expect', 'valid']);
    assert.equal(unexpected.code, 1, unexpected.output);
    assert.match(unexpected.output, /FAIL: the signature is missing, not the valid that was expected\./);
    feed.signature.mode('status', { status: 503 });
    const unreadable = await runLive([]);
    assert.equal(unreadable.code, 1, unreadable.output);
    assert.match(unreadable.output, /FAIL: update_signature_unreachable/);
    feed.signature.mode('chain');
    const stranger = await runLive([], { CHATMCP_UPDATE_TEST_KEY: throwawayKey().spkiBase64 });
    assert.equal(stranger.code, 0, stranger.output);
    assert.match(stranger.output, /signature:\s+invalid\s+\(update_signature_unknown_key, unknown_kid\)/);
    assert.match(stranger.output, /download:\s+no button/);
    for (const args of [['--anything'], ['--expect'], ['--expect', 'maybe'], ['--expect', 'valid', 'extra']]) assert.equal((await runLive(args)).code, 2, `a bad use is exit 2: ${args.join(' ')}`);
    ok('the hand-check script (tests/live/check-update-download.mjs) runs offline against the stand-in: it reads the manifest and then the signature, says valid (with the key), missing or invalid, what a click would fetch, never asks for the installer, exits 1 for an unreadable signature or an answer that is not the expected one, and 2 for a bad use');
  }

  console.log(`PASS: ${checks} update-download groups`);
} finally {
  await feed.close();
  await foreign.close();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
