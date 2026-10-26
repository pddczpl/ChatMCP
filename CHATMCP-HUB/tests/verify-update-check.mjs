// The update notice, step 1 of the in-app updater (lib/update-check.mjs): the Hub finds out that a newer release exists and says so. It downloads and runs nothing.
//
// What this suite holds the module to, against a REAL loopback HTTP server that stands in for GitHub (tests/e2e/update-feed-server.mjs: the same three hops, a signed
// address at the end, the same headers on the way in) and real files in a temporary folder. Nothing of the code under test is replaced by a double; the clock, the timers and
// the random number are handed in where a test has to move time (the scheduler), and the same questions are asked of real timers where a request is counted.
//   1. versions: the parser and the order of versions (x.y.z, a pre-release suffix on either side, build metadata, numbers that do not fit);
//   2. the manifest: what is accepted (a BOM, keys it does not know, either name of the installer) and what is refused (22 kinds of wrong shape, a pre-release);
//   3. the address: the feed is fixed, only a loopback address may stand in for it, and a redirect may go only where the policy says (github.com, release-assets..., objects...);
//   4. the request on the wire: the headers it sends (nothing that identifies the person), redirects, 404/500, a stall, a trickle, a huge or endless body, a closed port;
//   5. a check: newer, equal, older, a pre-release on either side, a bad answer that keeps the last good one, the state a restart finds, the rate limits, one request for two callers;
//   6. the setting and the timer: unanswered / yes / no, ZERO requests unless the owner said yes (with a positive control in the same timing), the schedule and its floors.
// The other half of the proof (a real Hub process, the routes and their layers) is tests/verify-e2e-update-check.mjs.
//
// This proves the module does what it was written to do against a server that imitates GitHub. It does not prove what GitHub answers today: that was read by hand once (docs/THREAT-MODEL.md, Surface 8).
// CLAIM: update-notice-one-request-to-github
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedManifest, startUpdateFeed } from './e2e/update-feed-server.mjs';
import {
  FEED_HOSTS, FEED_URL, LIMITS, NOTES_URL_PREFIX, SCHEDULE, SETTINGS_FILE, STATE_FILE, WHEN_UNANSWERED,
  checkedFeedUrl, compareVersions, createUpdateChecker, fetchManifest, isReleaseVersion, notesUrlFor, parseManifest, parseVersion, redirectAllowed, updateOptionsFromEnvironment,
} from '../lib/update-check.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-update-check-'));
let folderCount = 0;
const folder = () => { const dir = path.join(scratch, `state-${folderCount += 1}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
const readJson = (dir, name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; } };

/** Fails unless `promise` rejects with an error of this code. */
async function refuses(promise, code, label) {
  const error = await promise.then(() => null, (reason) => reason);
  assert.ok(error, `${label}: it must be refused`);
  assert.equal(error.code, code, `${label}: ${error?.code} ${error?.message}`);
  return error;
}

async function waitUntil(check, label, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(15);
  }
}

/** A clock a test can move. */
const clockAt = (iso = '2026-10-26T12:00:00.000Z') => ({ ms: Date.parse(iso), now() { return new Date(this.ms); }, advance(ms) { this.ms += ms; } });

/** Timers that record what was asked of them; `fire` runs a timer the way the clock would, and waits for what it started. */
function fakeTimers() {
  const all = [];
  return {
    all,
    setTimeout(fn, ms) { const handle = { fn, ms, cleared: false, fired: false, unref() { return handle; } }; all.push(handle); return handle; },
    clearTimeout(handle) { if (handle) handle.cleared = true; },
    pending: () => all.filter((handle) => !handle.cleared && !handle.fired),
    async fire(handle) { handle.fired = true; await handle.fn(); },
  };
}

const feed = await startUpdateFeed();
const foreign = await startUpdateFeed();

try {
  // ------------------------------------------------------------------------------------------------------------------------------- 1. versions
  {
    assert.deepEqual(parseVersion('3.10.2'), { major: 3, minor: 10, patch: 2, prerelease: [], build: [] });
    assert.deepEqual(parseVersion('3.11.0-rc.1+build.5'), { major: 3, minor: 11, patch: 0, prerelease: ['rc', '1'], build: ['build', '5'] });
    assert.deepEqual(parseVersion('0.0.0'), { major: 0, minor: 0, patch: 0, prerelease: [], build: [] });
    for (const bad of ['', '3', '3.10', '3.10.2.1', 'v3.10.2', '03.10.2', '3.010.2', '3.10.02', '3.10.2-', '3.10.2-01', '3.10.2-rc..1', '3.10.2+', '3.10.2-rc.', ' 3.10.2', '3.10.2 ', '3.10.2\n', 'x.y.z',
      '99999999999999999999.0.0', '1.99999999999999999999.0', `1.0.0-${'a'.repeat(80)}`, '1.0.0-rc_1', '1.0.0+build_1', null, undefined, 3, {}, ['3.10.2']]) {
      assert.equal(parseVersion(bad), null, `not a version: ${JSON.stringify(bad)}`);
    }
    assert.equal(isReleaseVersion('3.10.2'), true);
    for (const text of ['3.10.2-rc.1', '3.10.2+build', '3.10', '', null, 'v3.10.2']) assert.equal(isReleaseVersion(text), false, `not a release version: ${text}`);
    ok('parseVersion reads x.y.z with an optional pre-release and build, and refuses leading zeros, missing parts, numbers that do not fit, spaces and everything that is not text (27 cases); isReleaseVersion is x.y.z only');

    const order = [
      ['3.10.3', '3.10.2', 1], ['3.10.2', '3.10.2', 0], ['3.10.1', '3.10.2', -1], ['3.10.2', '3.9.9', 1], ['3.9.0', '3.10.0', -1], ['10.0.0', '9.9.9', 1], ['3.10.2', '3.10.10', -1], ['4.0.0', '3.99.99', 1], ['3.2.0', '3.10.0', -1],
      ['3.11.0-rc.1', '3.11.0', -1], ['3.11.0', '3.11.0-rc.1', 1], ['3.11.0-rc.1', '3.11.0-rc.2', -1], ['3.11.0-rc.2', '3.11.0-rc.10', -1], ['3.11.0-alpha', '3.11.0-beta', -1], ['3.11.0-alpha', '3.11.0-alpha.1', -1],
      ['3.11.0-1', '3.11.0-alpha', -1], ['3.11.0-rc.1', '3.10.9', 1], ['3.11.0-rc.1', '3.11.0-rc.1', 0], ['3.11.0-rc.1.2', '3.11.0-rc.1', 1],
      ['3.10.2+a', '3.10.2+b', 0], ['3.10.2+a', '3.10.2', 0], ['3.10.2-rc.1+x', '3.10.2-rc.1+y', 0],
      ['1.0.0-99999999999999999999', '1.0.0-99999999999999999998', 1], ['1.0.0-99999999999999999999', '1.0.0-9', 1],
    ];
    for (const [a, b, expected] of order) {
      assert.equal(compareVersions(a, b), expected, `${a} against ${b}`);
      assert.equal(compareVersions(b, a), -expected || 0, `${b} against ${a}`);
    }
    for (const [a, b] of [['x', '3.0.0'], ['3.0.0', 'x'], ['', '3.0.0'], ['3.0', '3.0.0']]) assert.throws(() => compareVersions(a, b), RangeError, `${a} / ${b} cannot be compared`);
    ok(`compareVersions orders ${order.length} pairs in both directions by semver precedence (numbers as numbers, a pre-release below its release, build metadata ignored) and refuses what is not a version`);
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 2. the manifest
  {
    const text = JSON.stringify(feedManifest());
    const parsed = parseManifest(text);
    assert.equal(parsed.version, '3.10.3');
    assert.equal(parsed.commit, '0123456789abcdef0123456789abcdef01234567');
    assert.equal(parsed.installerName, 'DatGoldSetup.exe');
    assert.deepEqual(parsed.assets.map((asset) => asset.name), ['DatGoldSetup.exe', 'DatGold-Browser-Companion.zip']);
    assert.equal(parseManifest(JSON.stringify(feedManifest({ assets: [{ name: 'ChatMCPSetup.exe', sha256: 'a'.repeat(64), bytes: 1 }] }))).installerName, 'ChatMCPSetup.exe', 'the installer of v3.10.2 and before keeps the old name');
    assert.equal(parseManifest(`\uFEFF${text}`).version, '3.10.3', 'a UTF-8 BOM (Windows PowerShell writes one) is dropped before the JSON is read');
    assert.equal(parseManifest(`${text}\r\n`).version, '3.10.3');
    assert.equal(parseManifest(JSON.stringify({ ...feedManifest(), somethingNew: { nested: [1, 2] }, signedInEdgeVerified: true })).version, '3.10.3', 'keys the Hub does not know are allowed: a later release will add some');
    assert.equal(parseManifest(JSON.stringify(feedManifest({ assets: [{ name: 'X.EXE', sha256: 'A'.repeat(64), bytes: 0 }] }))).assets[0].sha256, 'a'.repeat(64), 'a digest is lower-cased');
    assert.equal(parseManifest(JSON.stringify(feedManifest({ commit: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' }))).commit, 'abcdef0123456789abcdef0123456789abcdef01');
    const installerOf = (assets) => parseManifest(JSON.stringify(feedManifest({ assets }))).installerName;
    const asset = (name) => ({ name, sha256: 'd'.repeat(64), bytes: 10 });
    assert.equal(installerOf([asset('DatGold-Browser-Companion.zip'), asset('RELEASE-NOTES.txt')]), null, 'no .exe: no installer, and the check does not fail');
    assert.equal(installerOf([asset('A.exe'), asset('B.exe')]), null, 'two .exe files: the Hub does not guess which is the installer');
    assert.equal(installerOf([]), null, 'no assets at all');
    assert.equal(installerOf([asset('DatGoldSetup.exe.sha256'), asset('DatGoldSetup.exe')]), 'DatGoldSetup.exe', 'the checksum file is not the installer');
    ok('parseManifest accepts the published shape (a BOM, CRLF, keys it does not know, digests in either case) and names the installer from the manifest alone: one .exe, either name, none or several give null');

    const wrong = {
      'not JSON': 'not json', 'an empty body': '', 'null': 'null', 'a number': '5', 'a string': '"3.10.3"', 'an array': '[]',
      'no version': JSON.stringify({ ...feedManifest(), version: undefined }), 'a numeric version': JSON.stringify(feedManifest({ version: 3.1 })), 'a version with two parts': JSON.stringify(feedManifest({ version: '3.10' })),
      'a version with a leading v': JSON.stringify(feedManifest({ version: 'v3.10.3' })), 'a version with spaces': JSON.stringify(feedManifest({ version: ' 3.10.3' })),
      'no commit': JSON.stringify({ ...feedManifest(), commit: undefined }), 'a short commit': JSON.stringify(feedManifest({ commit: 'a'.repeat(39) })), 'a long commit': JSON.stringify(feedManifest({ commit: 'a'.repeat(41) })),
      'a commit that is not hex': JSON.stringify(feedManifest({ commit: 'g'.repeat(40) })), 'a numeric commit': JSON.stringify(feedManifest({ commit: 1234 })),
      'no assets': JSON.stringify({ ...feedManifest(), assets: undefined }), 'assets that are an object': JSON.stringify(feedManifest({ assets: {} })), 'an asset that is a string': JSON.stringify(feedManifest({ assets: ['DatGoldSetup.exe'] })),
      'an asset with a path in its name': JSON.stringify(feedManifest({ assets: [asset('../DatGoldSetup.exe')] })), 'an asset with a backslash': JSON.stringify(feedManifest({ assets: [asset('a\\b.exe')] })),
      'an asset with a space': JSON.stringify(feedManifest({ assets: [asset('Dat Gold.exe')] })), 'an asset with an empty name': JSON.stringify(feedManifest({ assets: [asset('')] })),
      'an asset name of 129 characters': JSON.stringify(feedManifest({ assets: [asset(`${'a'.repeat(125)}.exe`)] })), 'an asset size that is negative': JSON.stringify(feedManifest({ assets: [{ ...asset('a.exe'), bytes: -1 }] })),
      'an asset size with a fraction': JSON.stringify(feedManifest({ assets: [{ ...asset('a.exe'), bytes: 1.5 }] })), 'an asset size that is text': JSON.stringify(feedManifest({ assets: [{ ...asset('a.exe'), bytes: '10' }] })),
      'an asset size beyond a safe integer': JSON.stringify(feedManifest({ assets: [{ ...asset('a.exe'), bytes: 2 ** 60 }] })), 'a short digest': JSON.stringify(feedManifest({ assets: [{ ...asset('a.exe'), sha256: 'a'.repeat(63) }] })),
      'a digest that is not hex': JSON.stringify(feedManifest({ assets: [{ ...asset('a.exe'), sha256: 'z'.repeat(64) }] })), 'two assets of one name': JSON.stringify(feedManifest({ assets: [asset('a.exe'), asset('a.exe')] })),
      'more assets than a release has': JSON.stringify(feedManifest({ assets: Array.from({ length: LIMITS.maxAssets + 1 }, (_, index) => asset(`file-${index}.zip`)) })),
    };
    for (const [label, body] of Object.entries(wrong)) {
      const error = (() => { try { parseManifest(body); return null; } catch (reason) { return reason; } })();
      assert.ok(error, `${label} must be refused`);
      assert.equal(error.code, 'update_invalid_manifest', `${label}: ${error.code}`);
    }
    assert.throws(() => parseManifest(undefined), { code: 'update_invalid_manifest' });
    assert.throws(() => parseManifest({ version: '3.10.3' }), { code: 'update_invalid_manifest' }, 'the text is read, not an object');
    for (const version of ['3.11.0-rc.1', '3.11.0+build.7', '3.11.0-rc.1+build.7']) {
      assert.throws(() => parseManifest(JSON.stringify(feedManifest({ version }))), { code: 'update_not_a_release' }, `${version} in the feed is not a release: the feed carries releases only`);
    }
    assert.equal(parseManifest(JSON.stringify(feedManifest({ assets: Array.from({ length: LIMITS.maxAssets }, (_, index) => asset(`file-${index}.zip`)) }))).assets.length, LIMITS.maxAssets, 'exactly the limit is fine');
    ok(`parseManifest refuses ${Object.keys(wrong).length} kinds of wrong shape with one code, and a pre-release or build suffix in the feed as "not a release"`);
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 3. the address and the redirects
  {
    assert.equal(FEED_URL, 'https://github.com/pddczpl/ChatMCP/releases/latest/download/RELEASE-MANIFEST.json', 'the feed is the stable address of the Latest non-pre-release');
    assert.deepEqual([...FEED_HOSTS], ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
    assert.equal(NOTES_URL_PREFIX, 'https://github.com/pddczpl/ChatMCP/releases/tag/v');
    assert.equal(notesUrlFor('3.10.3'), 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3');
    assert.equal(notesUrlFor('3.10.3-rc.1'), null, 'a link is made for a release version only');
    assert.equal(notesUrlFor('../../x'), null);
    assert.equal(notesUrlFor(undefined), null);
    assert.equal(checkedFeedUrl(FEED_URL), FEED_URL);
    for (const loopback of ['http://127.0.0.1:1234/a/b.json', 'https://localhost:9/x', 'http://[::1]:80/x', 'http://localhost/RELEASE-MANIFEST.json']) assert.equal(checkedFeedUrl(loopback), new URL(loopback).href, `a loopback address may stand in: ${loopback}`);
    for (const bad of ['https://evil.example/RELEASE-MANIFEST.json', 'http://github.com/pddczpl/ChatMCP/releases/latest/download/RELEASE-MANIFEST.json', 'https://github.com/other/repo/releases/latest/download/RELEASE-MANIFEST.json',
      `${FEED_URL}?token=1`, `${FEED_URL}#x`, 'https://user:pw@github.com/pddczpl/ChatMCP/releases/latest/download/RELEASE-MANIFEST.json', 'http://127.0.0.1:1/x?token=1', 'http://user@127.0.0.1:1/x', 'http://127.0.0.1.evil.example/x',
      'http://127.0.0.2:1/x', 'ftp://127.0.0.1/x', 'file:///C:/x', 'javascript:alert(1)', 'not a url', '', 'https://github.com.evil.example/x', 'https://github.com:8443/pddczpl/ChatMCP/releases/latest/download/RELEASE-MANIFEST.json', null, undefined, 5]) {
      assert.throws(() => checkedFeedUrl(bad), { code: 'update_feed_refused' }, `the feed may not be ${JSON.stringify(bad)}`);
    }
    ok('the feed is the one fixed GitHub address; only a loopback address may stand in for it, never with a login, a query or a fragment; notesUrlFor builds the link from a release version alone');

    const allowed = [
      'https://github.com/pddczpl/ChatMCP/releases/download/v3.10.2/RELEASE-MANIFEST.json', 'https://release-assets.githubusercontent.com/github-production-release-asset/1413019619/24765420?X-Amz-Signature=a',
      'https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2', 'https://GITHUB.COM/x', 'https://github.com:443/x',
    ];
    const refused = [
      'http://github.com/x', 'http://release-assets.githubusercontent.com/x', 'https://github.com:8443/x', 'https://github.com:80/x', 'https://github.com.evil.example/x', 'https://evilgithub.com/x', 'https://notgithub.com/x',
      'https://github.com@evil.example/x', 'https://user:pw@github.com/x', 'https://user@release-assets.githubusercontent.com/x', 'https://api.github.com/x', 'https://raw.githubusercontent.com/x', 'https://githubusercontent.com/x',
      'https://release-assets.githubusercontent.com.evil.example/x', 'https://sub.release-assets.githubusercontent.com/x', 'https://github.com./x', 'ftp://github.com/x', 'file:///C:/x', 'javascript:alert(1)', 'https://[::1]/x', 'https://127.0.0.1/x', 'data:text/plain,x',
    ];
    for (const target of allowed) assert.equal(redirectAllowed(new URL(target), FEED_URL), true, `allowed: ${target}`);
    for (const target of refused) assert.equal(redirectAllowed(new URL(target), FEED_URL), false, `refused: ${target}`);
    assert.equal(redirectAllowed(null, FEED_URL), false);
    assert.equal(redirectAllowed('https://github.com/x', FEED_URL), false, 'a URL object is required: text is not trusted to mean what it says');
    const stand = 'http://127.0.0.1:5555/a/latest.json';
    assert.equal(redirectAllowed(new URL('http://127.0.0.1:5555/b?x=1'), stand), true, 'a stand-in on a loopback address may redirect within its own origin');
    for (const target of ['http://127.0.0.1:5556/b', 'http://localhost:5555/b', 'https://127.0.0.1:5555/b', 'https://github.com/x', 'https://release-assets.githubusercontent.com/x', 'http://[::1]:5555/b', 'http://user@127.0.0.1:5555/b']) {
      assert.equal(redirectAllowed(new URL(target), stand), false, `a stand-in may not send the Hub anywhere else: ${target}`);
    }
    ok(`the redirect policy: ${allowed.length} addresses allowed, ${refused.length} refused (http, another port, a look-alike host, a login in the address, another subdomain, a trailing dot); a loopback stand-in may stay on its own origin and go nowhere else`);
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 4. the request on the wire
  {
    const userAgent = 'DatGold/3.10.2';
    const fetched = await fetchManifest({ url: feed.url, userAgent });
    assert.equal(parseManifest(fetched.text).version, '3.10.3');
    assert.equal(fetched.redirects, 2, 'GitHub answers with two redirects; the stand-in does the same');
    assert.equal(feed.requests.length, 3, 'three requests for the three hops, nothing else');
    const names = new Set();
    for (const request of feed.requests) {
      assert.equal(request.method, 'GET');
      assert.equal(request.headers['user-agent'], userAgent, 'the User-Agent names the product and its version');
      assert.equal(request.headers.accept, 'application/json');
      for (const name of Object.keys(request.headers)) names.add(name);
      assert.equal(request.rawHeaders.filter((_, index) => index % 2 === 0).length, new Set(request.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase())).size, 'no header twice');
    }
    assert.deepEqual([...names].sort(), ['accept', 'connection', 'host', 'user-agent'], 'the only headers: the host asked, what is asked for, who asks (DatGold/<version>) and that the connection is not kept; no cookie, no referrer, no login, no language, no encoding');
    ok('one check is three GET requests to the stand-in with exactly four headers (host, user-agent DatGold/<version>, accept, connection) and nothing that identifies the person');

    feed.requests.length = 0;
    feed.mode('direct');
    assert.equal((await fetchManifest({ url: feed.url, userAgent })).redirects, 0);
    feed.mode('chain');

    // statuses
    for (const status of [404, 500, 403, 429, 503, 204]) {
      feed.mode('status', { status });
      const error = await refuses(fetchManifest({ url: feed.url, userAgent }), 'update_http', `HTTP ${status}`);
      assert.equal(error.status, status);
    }
    feed.mode('chain-500');
    const lastHop = await refuses(fetchManifest({ url: feed.url, userAgent }), 'update_http', 'the last hop fails');
    assert.ok(!/SIGNED-QUERY|X-Amz/.test(`${lastHop.message} ${JSON.stringify(lastHop)}`), 'the signed address of the last hop is in no message');
    ok('a final answer that is not 200 (404, 500, 403, 429, 503, 204) is update_http with the status, and the signed address of the last hop is in no message');

    // redirects
    feed.requests.length = 0;
    feed.mode('loop');
    await refuses(fetchManifest({ url: feed.url, userAgent }), 'update_redirect_limit', 'a redirect loop');
    assert.equal(feed.requests.length, LIMITS.maxRedirects + 1, 'three redirects are followed, the fourth is not');
    feed.mode('redirect', { target: `${foreign.origin}/x` });
    await refuses(fetchManifest({ url: feed.url, userAgent }), 'update_redirect_refused', 'another origin');
    feed.mode('redirect', { target: `http://localhost:${new URL(feed.origin).port}/x` });
    await refuses(fetchManifest({ url: feed.url, userAgent }), 'update_redirect_refused', 'another name for the same machine');
    assert.equal(foreign.requests.length, 0, 'the server it was sent to was never asked');
    feed.mode('redirect', { target: null });
    await refuses(fetchManifest({ url: feed.url, userAgent }), 'update_redirect_invalid', 'a redirect with no Location');
    feed.mode('redirect', { target: 'http://[bad' });
    await refuses(fetchManifest({ url: feed.url, userAgent }), 'update_redirect_invalid', 'a Location that is not an address');
    feed.mode('redirect', { target: 'ftp://127.0.0.1/x' });
    await refuses(fetchManifest({ url: feed.url, userAgent }), 'update_redirect_refused', 'another protocol');
    feed.mode('chain');
    ok('redirects: at most three are followed (a loop makes four requests); another origin, another host name and another protocol are refused before a connection is made (the other server saw nothing); a redirect with no usable Location is refused');

    // time and size
    feed.mode('stall');
    let started = Date.now();
    await refuses(fetchManifest({ url: feed.url, userAgent, timeoutMs: 300 }), 'update_timeout', 'a server that never answers');
    assert.ok(Date.now() - started < 3000, 'and gives up soon after the deadline');
    await waitUntil(() => feed.openCount() === 0, 'the stalled request to be closed');
    feed.mode('trickle');
    started = Date.now();
    await refuses(fetchManifest({ url: feed.url, userAgent, timeoutMs: 400 }), 'update_timeout', 'a body that arrives a byte at a time never ends');
    assert.ok(Date.now() - started < 3000);
    await waitUntil(() => feed.openCount() === 0, 'the trickling request to be closed');
    feed.mode('declared-huge', { bytes: 10 * 1024 * 1024 });
    started = Date.now();
    await refuses(fetchManifest({ url: feed.url, userAgent }), 'update_too_large', 'a declared size over the limit is refused before the body is read');
    assert.ok(Date.now() - started < 2500, 'at once: the headers were enough');
    feed.mode('endless');
    await refuses(fetchManifest({ url: feed.url, userAgent }), 'update_too_large', 'an endless body is cut at the limit');
    await waitUntil(() => feed.openCount() === 0, 'the endless answer to be closed by the Hub');
    ok('a stalled answer and a trickling one are cut at the deadline (one deadline for all the hops and the body), a declared size over 64 KiB is refused from the headers, an endless body is cut and its connection closed');

    feed.mode('direct');
    const edge = 200;
    feed.publish(null, { raw: ' '.repeat(edge - 2) + '{}' });
    assert.equal((await fetchManifest({ url: feed.url, userAgent, maxBytes: edge })).text.length, edge, 'a body of exactly the limit is read');
    feed.publish(null, { raw: ' '.repeat(edge - 1) + '{}' });
    await refuses(fetchManifest({ url: feed.url, userAgent, maxBytes: edge }), 'update_too_large', 'one byte more is not');
    feed.publish(feedManifest());
    assert.equal(LIMITS.maxBytes, 64 * 1024);
    assert.equal(LIMITS.timeoutMs, 10_000);
    assert.equal(LIMITS.maxRedirects, 3);
    feed.mode('chain');
    ok('the size limit is exact (200 bytes pass, 201 do not) and the production limits are 64 KiB, 10 s and 3 redirects');

    // a port nobody listens on
    const closed = await new Promise((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
    await refuses(fetchManifest({ url: `http://127.0.0.1:${closed}/RELEASE-MANIFEST.json`, userAgent }), 'update_network', 'nothing listens there');
    await refuses(fetchManifest({ url: 'https://evil.example/x', userAgent }), 'update_feed_refused', 'the address is checked before any connection');
    await refuses(fetchManifest({ url: `${FEED_URL}?x=1`, userAgent }), 'update_feed_refused', 'and so is the query');
    ok('a closed port is update_network; an address the policy refuses is refused before any connection');
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 5. a check
  const make = (overrides = {}) => {
    const clock = overrides.clock ?? clockAt();
    const lines = [];
    const checker = createUpdateChecker({ directory: overrides.directory ?? folder(), currentVersion: '3.10.2', feedUrl: feed.url, now: () => clock.now(), random: () => 0.5, log: (line) => lines.push(line), ...overrides.options });
    return { checker, clock, lines, directory: overrides.directory };
  };
  const KEYS = ['autoCheck', 'available', 'checkedAt', 'checking', 'current', 'error', 'installerName', 'lastAttemptAt', 'latest', 'manualCheckAfter', 'nextAutomaticCheckAt', 'notesUrl', 'skippedVersion'];
  {
    feed.mode('chain');
    feed.publish(feedManifest({ version: '3.10.3' }));
    const { checker, clock } = make();
    await checker.load();
    const before = checker.status();
    assert.deepEqual(Object.keys(before).sort(), KEYS, 'the state has exactly these keys');
    assert.deepEqual(Object.keys(before.autoCheck).sort(), ['enabled', 'needsChoice', 'saved']);
    assert.deepEqual({ ...before, autoCheck: undefined }, { current: '3.10.2', latest: null, available: false, checkedAt: null, lastAttemptAt: null, notesUrl: null, installerName: null, skippedVersion: null, error: null, checking: false, manualCheckAfter: null, nextAutomaticCheckAt: null, autoCheck: undefined }, 'nothing is known before the first check');
    const answer = await checker.check();
    assert.deepEqual([answer.checked, answer.throttled], [true, false]);
    const after = answer.update;
    assert.equal(after.current, '3.10.2');
    assert.equal(after.latest, '3.10.3');
    assert.equal(after.available, true, 'a newer release is offered');
    assert.equal(after.notesUrl, 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3');
    assert.equal(after.installerName, 'DatGoldSetup.exe', 'the name of the installer comes from the manifest');
    assert.equal(after.checkedAt, clock.now().toISOString());
    assert.equal(after.lastAttemptAt, clock.now().toISOString());
    assert.equal(after.manualCheckAfter, new Date(clock.ms + SCHEDULE.minManualGapMs).toISOString());
    assert.equal(after.skippedVersion, null);
    assert.equal(after.error, null);
    assert.equal(after.checking, false);
    assert.deepEqual(checker.status(), after, 'status() says what the check returned');
    ok('a newer release: current, latest, available, the notes address built from the version, the installer name from the manifest, both times, and the earliest time of the next manual check');
  }
  {
    // the line GitHub sees is made from the version that runs, by the checker itself (fetchManifest takes it as given); a version that is not x.y.z cannot be compared and asks nothing
    for (const current of ['3.10.2', '3.11.0-rc.1+local']) {
      feed.requests.length = 0;
      feed.mode('chain');
      feed.publish(feedManifest({ version: '3.10.3' }));
      const { checker } = make({ options: { currentVersion: current } });
      await checker.load();
      await checker.check();
      assert.ok(feed.requests.length > 0, `a check of ${current} asked`);
      for (const request of feed.requests) assert.equal(request.headers['user-agent'], `DatGold/${current}`, `the User-Agent of a Hub that runs ${current}`);
    }
    for (const current of ['three', '3.10', '', '3.10.2 evil', '3.10.2\r\nX-Injected: 1']) {
      feed.requests.length = 0;
      const { checker } = make({ options: { currentVersion: current } });
      await checker.load();
      const { update } = await checker.check();
      assert.equal(update.error?.code, 'update_current_invalid', `${JSON.stringify(current)} cannot be compared`);
      assert.equal(update.available, false);
      assert.equal(feed.requests.length, 0, `and asks nothing: ${JSON.stringify(current)}`);
    }
    ok('the User-Agent is DatGold/<the version that runs> as the checker makes it (a release or a pre-release with build metadata); a version that is not x.y.z gives "update_current_invalid" and no request');
  }
  {
    const cases = [
      ['equal', '3.10.2', '3.10.2', false], ['older', '3.10.1', '3.10.2', false], ['an older minor', '3.9.9', '3.10.2', false], ['a newer patch', '3.10.3', '3.10.2', true], ['a newer minor', '3.11.0', '3.10.2', true],
      ['a newer major', '4.0.0', '3.10.2', true], ['a newer minor but a smaller patch', '3.11.0', '3.10.9', true], ['numbers, not text', '3.10.10', '3.10.9', true], ['numbers, not text, downwards', '3.9.0', '3.10.0', false],
      ['a running pre-release of the release', '3.11.0', '3.11.0-rc.1', true], ['a running pre-release below an older release', '3.10.9', '3.11.0-rc.1', false], ['a running build with metadata', '3.10.2', '3.10.2+local', false],
      ['a running pre-release, a newer release', '3.12.0', '3.11.0-rc.1', true],
    ];
    for (const [label, latest, current, expected] of cases) {
      feed.publish(feedManifest({ version: latest }));
      const { checker } = make({ options: { currentVersion: current } });
      await checker.load();
      const { update } = await checker.check();
      assert.equal(update.latest, latest, label);
      assert.equal(update.available, expected, `${label}: ${latest} against ${current}`);
    }
    ok(`available only when the feed's release is strictly higher than the running version (${cases.length} cases: equal, older, newer by patch, minor and major, numbers not text, a running pre-release or build)`);
  }
  {
    // A bad answer keeps the last good one; a good one replaces it (even with a lower version: the feed is the truth).
    feed.publish(feedManifest({ version: '3.10.3' }));
    const { checker, clock } = make();
    await checker.load();
    await checker.check();
    const good = checker.status();
    const failures = [
      ['404', () => feed.mode('status', { status: 404 }), 'update_http'], ['500', () => feed.mode('status', { status: 500 }), 'update_http'],
      ['a page of HTML', () => feed.mode('html'), 'update_invalid_manifest'],
      ['broken JSON', () => { feed.mode('direct'); feed.publish(null, { raw: '{"version":' }); }, 'update_invalid_manifest'],
      ['a manifest of the wrong shape', () => { feed.mode('direct'); feed.publish(null, { raw: JSON.stringify({ version: '3.99.0' }) }); }, 'update_invalid_manifest'],
      ['a pre-release in the feed', () => { feed.mode('direct'); feed.publish(feedManifest({ version: '3.99.0-rc.1' })); }, 'update_not_a_release'],
      ['an endless answer', () => feed.mode('endless'), 'update_too_large'],
      ['a redirect to another host', () => feed.mode('redirect', { target: `${foreign.origin}/x` }), 'update_redirect_refused'],
    ];
    for (const [label, arrange, code] of failures) {
      clock.advance(SCHEDULE.minManualGapMs + 1);
      arrange();
      const { update, checked } = await checker.check();
      assert.equal(checked, true, label);
      assert.equal(update.error?.code, code, `${label}: ${update.error?.code}`);
      assert.equal(update.error.at, clock.now().toISOString(), `${label}: when it failed`);
      assert.equal(typeof update.error.message, 'string');
      assert.ok(update.error.message.length > 0 && update.error.message.length < 300);
      assert.equal(update.latest, good.latest, `${label}: the last good release is kept`);
      assert.equal(update.available, true);
      assert.equal(update.checkedAt, good.checkedAt, `${label}: checkedAt is the last SUCCESS`);
      assert.equal(update.lastAttemptAt, clock.now().toISOString(), `${label}: lastAttemptAt is this attempt`);
      assert.equal(update.installerName, good.installerName);
    }
    clock.advance(SCHEDULE.minManualGapMs + 1);
    feed.mode('chain');
    feed.publish(feedManifest({ version: '3.10.1' }));
    const lower = (await checker.check()).update;
    assert.equal(lower.error, null, 'a good answer clears the error');
    assert.deepEqual([lower.latest, lower.available], ['3.10.1', false], 'and replaces what was known, even by a lower version: the feed is the truth');
    assert.equal(lower.checkedAt, clock.now().toISOString());
    ok(`${failures.length} kinds of bad answer each give their own code and keep the last good release, its installer and its time (checkedAt is the last success, lastAttemptAt the last try); a good answer clears the error and replaces the release even by a lower one`);
  }
  {
    // the same ones from the cold: no earlier good answer
    feed.mode('direct');
    feed.publish(null, { raw: 'nonsense' });
    const { checker } = make();
    await checker.load();
    const { update } = await checker.check();
    assert.deepEqual([update.latest, update.available, update.checkedAt === null, update.error?.code], [null, false, true, 'update_invalid_manifest']);
    feed.mode('chain');
    feed.publish(feedManifest({ version: '3.10.3' }));
    feed.publish(feedManifest({ version: '3.10.3' }), { bom: true });
    feed.mode('direct');
    const bom = make();
    await bom.checker.load();
    assert.equal((await bom.checker.check()).update.latest, '3.10.3', 'a manifest that starts with a BOM is read end to end');
    feed.mode('chain');
    ok('a first check that fails leaves nothing known; a manifest with a BOM is read through the whole path');
  }

  // ---- the state a restart finds, and how little of the saved file is trusted
  {
    feed.mode('chain');
    feed.publish(feedManifest({ version: '3.10.3' }));
    const directory = folder();
    const first = make({ directory });
    await first.checker.load();
    await first.checker.check();
    assert.deepEqual(readJson(directory, STATE_FILE), { version: 1, latest: '3.10.3', installerName: 'DatGoldSetup.exe', checkedAt: first.clock.now().toISOString(), lastAttemptAt: first.clock.now().toISOString(), skippedVersion: null }, 'what is saved: the release, the installer name and the two times; no address, no error');
    assert.equal(readJson(directory, SETTINGS_FILE), null, 'the setting is not written until the owner chooses');
    const requestsBefore = feed.requests.length;

    // a new process: the notice is known before a single request is made
    const second = make({ directory, clock: first.clock });
    const loaded = await second.checker.load();
    assert.deepEqual([loaded.latest, loaded.available, loaded.installerName, loaded.notesUrl, loaded.checkedAt, loaded.error], ['3.10.3', true, 'DatGoldSetup.exe', 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3', first.clock.now().toISOString(), null]);
    assert.equal(feed.requests.length, requestsBefore, 'and it was known without a request');
    // an update that was installed since: the same file, no notice
    for (const [current, expected] of [['3.10.3', false], ['3.11.0', false], ['3.10.2', true], ['3.10.3-rc.1', true]]) {
      const installed = make({ directory, clock: first.clock, options: { currentVersion: current } });
      const state = await installed.checker.load();
      assert.deepEqual([state.current, state.latest, state.available], [current, '3.10.3', expected], `a Hub of ${current} reads the same file`);
    }
    ok('a restart finds the release, its installer name and its time without a request, and what is "available" is worked out against the running version every time: the Hub that was just updated does not announce the version it is');

    // the file is data of a program that can be edited: each field is checked on its own, and a link is never taken from it
    const hostile = {
      version: 1, latest: '3.10.4', installerName: '../../Windows/System32/cmd.exe', checkedAt: 'yesterday', lastAttemptAt: '2999-01-01T00:00:00.000Z', skippedVersion: 5, notesUrl: 'https://evil.example/', error: { code: 'x' }, extra: true,
    };
    fs.writeFileSync(path.join(directory, STATE_FILE), JSON.stringify(hostile));
    const sanitized = make({ directory, clock: first.clock });
    const state = await sanitized.checker.load();
    assert.deepEqual([state.latest, state.available, state.installerName, state.checkedAt, state.lastAttemptAt, state.skippedVersion, state.error], ['3.10.4', true, null, null, null, null, null], 'a field that is wrong is dropped on its own; the rest is kept');
    assert.equal(state.notesUrl, 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.4', 'the link is built from the version, whatever the file says');
    for (const latest of ['3.10.4-rc.1', '3.10', 'x', 7, null, '../../x', `3.10.4${'0'.repeat(80)}`]) {
      fs.writeFileSync(path.join(directory, STATE_FILE), JSON.stringify({ version: 1, latest, checkedAt: first.clock.now().toISOString() }));
      const dropped = await make({ directory, clock: first.clock }).checker.load();
      assert.deepEqual([dropped.latest, dropped.available, dropped.notesUrl], [null, false, null], `a release of ${JSON.stringify(latest)} in the file is no release`);
    }
    const future = new Date(first.clock.ms + 2 * 86400000).toISOString();
    fs.writeFileSync(path.join(directory, STATE_FILE), JSON.stringify({ version: 1, latest: '3.10.3', checkedAt: future, lastAttemptAt: future }));
    const clockSkew = await make({ directory, clock: first.clock }).checker.load();
    assert.deepEqual([clockSkew.latest, clockSkew.checkedAt, clockSkew.lastAttemptAt], ['3.10.3', null, null], 'a time two days ahead (a clock that was wrong) is dropped, so it cannot keep the Hub from checking for years');
    const slightlyAhead = new Date(first.clock.ms + 3600000).toISOString();
    fs.writeFileSync(path.join(directory, STATE_FILE), JSON.stringify({ version: 1, latest: '3.10.3', checkedAt: slightlyAhead, lastAttemptAt: slightlyAhead }));
    assert.equal((await make({ directory, clock: first.clock }).checker.load()).lastAttemptAt, slightlyAhead, 'an hour ahead is a clock a little off, and is kept');
    for (const bad of ['{ not json', '', '[]', 'null', '"text"', '5', '{"version":2,"latest":"3.10.3"}', '\u0000\u0000']) {
      fs.writeFileSync(path.join(directory, STATE_FILE), bad);
      const lines = [];
      const damaged = createUpdateChecker({ directory, currentVersion: '3.10.2', feedUrl: feed.url, now: () => first.clock.now(), log: (line) => lines.push(line) });
      const nothing = await damaged.load();
      assert.deepEqual([nothing.latest, nothing.available, nothing.checkedAt, nothing.lastAttemptAt], [null, false, null, null], `a damaged file (${JSON.stringify(bad)}) costs the saved state and nothing else`);
      if (bad !== '') assert.ok(lines.length >= 1, `and the Hub says so in its log (${JSON.stringify(bad)})`);
    }
    fs.writeFileSync(path.join(directory, SETTINGS_FILE), JSON.stringify({ version: 1, autoCheckUpdates: 'yes' }));
    const badSetting = await make({ directory }).checker.load();
    assert.deepEqual([badSetting.autoCheck.saved, badSetting.autoCheck.needsChoice], [null, true], 'a setting that is not true or false is no choice: the question is asked again');
    fs.writeFileSync(path.join(directory, SETTINGS_FILE), '{ not json');
    assert.equal((await make({ directory }).checker.load()).autoCheck.saved, null);
    ok('the saved file is not trusted: every field is checked on its own (a release that is not x.y.z, an installer name with a path, a time that is not a time or is days ahead, a skipped version that is not text), the link is rebuilt from the version, and a damaged file or setting is ignored with a line in the log');
  }

  // ---- the file is written before the request goes out, and a disk that fails does not stop a check
  {
    feed.mode('stall');
    const directory = folder();
    const { checker, clock } = make({ directory, options: { timeoutMs: 400 } });
    await checker.load();
    const running = checker.check();
    await waitUntil(() => feed.openCount() >= 1, 'the request to arrive');
    assert.equal(readJson(directory, STATE_FILE)?.lastAttemptAt, clock.now().toISOString(), 'the attempt is on disk while the request is still out: a Hub that crashes in the middle still counts it');
    assert.equal(checker.status().checking, true);
    const done = await running;
    assert.equal(done.update.error.code, 'update_timeout');
    assert.equal(checker.status().checking, false);
    feed.mode('chain');
    await waitUntil(() => feed.openCount() === 0, 'the stalled request to be closed');

    const file = path.join(scratch, 'a-file');
    fs.writeFileSync(file, 'not a folder');
    const lines = [];
    const broken = createUpdateChecker({ directory: path.join(file, 'inside'), currentVersion: '3.10.2', feedUrl: feed.url, log: (line) => lines.push(line) });
    await broken.load();
    const result = await broken.check();
    assert.equal(result.update.latest, '3.10.3', 'a check works when nothing can be saved');
    assert.ok(lines.some((line) => /update-check\.json/.test(line)), 'and the log says what could not be saved');
    const refused = await broken.setAutoCheck(true).then(() => null, (error) => error);
    assert.equal(refused?.code, 'update_save_failed');
    assert.equal(refused?.statusCode, 500);
    assert.equal(broken.status().autoCheck.saved, null, 'a choice that could not be saved is not shown as made');
    ok('the attempt is on disk before the request goes out; when the folder cannot be written a check still works, the log says so, and a choice that could not be saved is refused (500) and not shown as made');
  }

  // ---- the rate limits, and one request for two callers
  {
    feed.mode('chain');
    feed.publish(feedManifest({ version: '3.10.3' }));
    const { checker, clock } = make();
    await checker.load();
    const base = feed.checks();
    const [one, two] = await Promise.all([checker.check(), checker.check()]);
    assert.equal(feed.checks() - base, 1, 'two callers at once make one request');
    assert.deepEqual([one.checked, one.throttled, two.checked, two.throttled], [true, false, true, false]);
    assert.deepEqual(one.update, two.update, 'and get the same answer');
    const again = await checker.check();
    assert.deepEqual([again.checked, again.throttled], [false, true], 'a second press right after is answered from what is known');
    assert.equal(feed.checks() - base, 1);
    assert.equal(again.update.latest, '3.10.3', 'with the state, so the page can show it');
    clock.advance(SCHEDULE.minManualGapMs - 1);
    assert.equal((await checker.check()).throttled, true, '59.999 seconds after is still too soon');
    clock.advance(1);
    const later = await checker.check();
    assert.deepEqual([later.checked, later.throttled], [true, false], 'exactly a minute after is allowed');
    assert.equal(feed.checks() - base, 2);
    // a failed attempt counts: a button that fails is not a licence to ask again at once
    clock.advance(SCHEDULE.minManualGapMs);
    feed.mode('status', { status: 503 });
    assert.equal((await checker.check()).update.error.code, 'update_http');
    const failedTwice = await checker.check();
    assert.deepEqual([failedTwice.checked, failedTwice.throttled], [false, true]);
    assert.equal(failedTwice.update.error.code, 'update_http', 'the throttled answer still carries the error the page should show');
    assert.equal(feed.checks() - base, 3);
    feed.mode('chain');
    assert.equal(SCHEDULE.minManualGapMs, 60_000);
    ok('a manual check: two callers at once share one request; a second press within a minute is answered from the state without a request (59.999 s is too soon, 60 s is not); a failed attempt counts');
  }

  // ---- skipping a version
  {
    feed.mode('chain');
    feed.publish(feedManifest({ version: '3.10.3' }));
    const directory = folder();
    const first = make({ directory });
    await first.checker.load();
    await refuses(first.checker.skip('3.10.3'), 'update_skip_stale', 'nothing is known yet');
    await first.checker.check();
    await refuses(first.checker.skip('3.10.4'), 'update_skip_stale', 'a version that is not the one on offer');
    await refuses(first.checker.skip('3.10.2'), 'update_skip_stale', 'the running version');
    for (const bad of ['x', '', 5, {}, undefined, '3.10', '3.10.3-rc.1']) await refuses(first.checker.skip(bad), 'update_skip_invalid', `not a version: ${JSON.stringify(bad)}`);
    const skipped = await first.checker.skip('3.10.3');
    assert.equal(skipped.skippedVersion, '3.10.3');
    assert.equal(skipped.available, true, 'skipping does not change what is available: the page decides what to show');
    assert.equal(readJson(directory, STATE_FILE).skippedVersion, '3.10.3');
    const restarted = make({ directory, clock: first.clock });
    assert.equal((await restarted.checker.load()).skippedVersion, '3.10.3', 'a skip survives a restart');
    // a newer release is on offer again; the skip stays what it was
    first.clock.advance(SCHEDULE.minManualGapMs + 1);
    feed.publish(feedManifest({ version: '3.10.4' }));
    const newer = (await restarted.checker.check()).update;
    assert.deepEqual([newer.latest, newer.skippedVersion, newer.available], ['3.10.4', '3.10.3', true], 'a newer release than the skipped one is not skipped');
    assert.equal((await restarted.checker.skip(null)).skippedVersion, null, 'null takes the skip back');
    assert.equal(readJson(directory, STATE_FILE).skippedVersion, null);
    const nothingToSkip = make({ options: { currentVersion: '3.10.4' } });
    await nothingToSkip.checker.load();
    await nothingToSkip.checker.check();
    await refuses(nothingToSkip.checker.skip('3.10.4'), 'update_skip_stale', 'a release that is already running cannot be skipped');
    ok('skip accepts only the release on offer (409 otherwise, 400 for anything that is not a release version), survives a restart, does not hide a newer release, and null takes it back');
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 6. the setting and the timer
  {
    assert.ok(['ask', 'on'].includes(WHEN_UNANSWERED), 'the default is one constant with one of two values');
    assert.equal(WHEN_UNANSWERED, 'ask', 'and today it is: no request until the owner says yes. It is the owner\'s decision; to make it "on", change the constant and say so in the README, SECURITY.md, Surface 8 (U1) of the threat model and the tests that talk about "not answered"');
    // unanswered: no timer, a question to ask
    {
      const timers = fakeTimers();
      const { checker } = make({ options: { timers } });
      const state = await checker.load();
      assert.deepEqual(state.autoCheck, { enabled: false, saved: null, needsChoice: true });
      checker.start();
      assert.equal(timers.pending().length, 0, 'unanswered: no timer is set');
      assert.equal(checker.status().nextAutomaticCheckAt, null);
    }
    // the same with the constant flipped to "on": as if the owner had said yes, and no question
    {
      const timers = fakeTimers();
      const { checker, clock } = make({ options: { timers, whenUnanswered: 'on' } });
      assert.deepEqual((await checker.load()).autoCheck, { enabled: true, saved: null, needsChoice: false });
      checker.start();
      assert.equal(timers.pending().length, 1);
      assert.equal(checker.status().nextAutomaticCheckAt, new Date(clock.ms + SCHEDULE.firstCheckMs).toISOString());
      checker.stop();
    }
    // yes and no
    {
      const timers = fakeTimers();
      const directory = folder();
      const { checker, clock } = make({ directory, options: { timers } });
      await checker.load();
      checker.start();
      const yes = await checker.setAutoCheck(true);
      assert.deepEqual(yes.autoCheck, { enabled: true, saved: true, needsChoice: false });
      assert.deepEqual(readJson(directory, SETTINGS_FILE), { version: 1, autoCheckUpdates: true });
      assert.equal(timers.pending().length, 1, 'saying yes sets the timer');
      assert.equal(timers.pending()[0].ms, SCHEDULE.firstCheckMs, 'for the first check, a little later');
      assert.equal(yes.nextAutomaticCheckAt, new Date(clock.ms + SCHEDULE.firstCheckMs).toISOString());
      const no = await checker.setAutoCheck(false);
      assert.deepEqual(no.autoCheck, { enabled: false, saved: false, needsChoice: false });
      assert.deepEqual(readJson(directory, SETTINGS_FILE), { version: 1, autoCheckUpdates: false });
      assert.equal(timers.pending().length, 0, 'saying no clears it');
      assert.equal(no.nextAutomaticCheckAt, null);
      for (const bad of ['true', 1, 0, null, undefined, {}, []]) {
        const error = await checker.setAutoCheck(bad).then(() => null, (reason) => reason);
        assert.deepEqual([error?.code, error?.statusCode], ['update_setting_invalid', 400], `not a boolean: ${JSON.stringify(bad)}`);
      }
      assert.deepEqual(readJson(directory, SETTINGS_FILE), { version: 1, autoCheckUpdates: false }, 'and nothing was written for them');
      // the choice survives a restart, and calls are applied in the order they were made
      await Promise.all([checker.setAutoCheck(true), checker.setAutoCheck(false), checker.setAutoCheck(true)]);
      assert.deepEqual(readJson(directory, SETTINGS_FILE), { version: 1, autoCheckUpdates: true }, 'the last call wins on disk');
      assert.equal(checker.status().autoCheck.saved, true, 'and in memory');
      const restarted = make({ directory, clock });
      assert.deepEqual((await restarted.checker.load()).autoCheck, { enabled: true, saved: true, needsChoice: false });
      checker.stop();
    }
    ok('unanswered means no timer and a question; with the constant at "on" it runs as if the owner had said yes; yes saves true and sets the timer, no saves false and clears it; anything but a boolean is a 400 that writes nothing; the choice survives a restart and calls apply in order');

    // the schedule
    const spec = { random: () => 0.5 };
    const armed = async (lastAttemptAgoMs, extra = {}) => {
      const directory = folder();
      const clock = clockAt();
      fs.writeFileSync(path.join(directory, SETTINGS_FILE), JSON.stringify({ version: 1, autoCheckUpdates: true }));
      if (lastAttemptAgoMs !== null) fs.writeFileSync(path.join(directory, STATE_FILE), JSON.stringify({ version: 1, latest: '3.10.3', checkedAt: new Date(clock.ms - lastAttemptAgoMs).toISOString(), lastAttemptAt: new Date(clock.ms - lastAttemptAgoMs).toISOString() }));
      const timers = fakeTimers();
      const made = make({ directory, clock, options: { timers, ...spec, ...extra } });
      await made.checker.load();
      made.checker.start();
      return { ...made, timers, directory };
    };
    {
      const never = await armed(null);
      assert.equal(never.timers.pending().length, 1);
      assert.equal(never.timers.pending()[0].ms, 30_000, 'the first check comes 30 seconds after the Hub starts');
      assert.equal(SCHEDULE.firstCheckMs, 30_000);
      never.checker.start();
      assert.equal(never.timers.pending().length, 1, 'start() twice sets one timer');
      const justNow = await armed(0);
      assert.equal(justNow.timers.pending()[0].ms, 15 * 60_000, 'a Hub that restarts right after a try waits out the 15-minute floor, counted from that try');
      const fiveMinutes = await armed(5 * 60_000);
      assert.equal(fiveMinutes.timers.pending()[0].ms, 10 * 60_000, 'five minutes after a try: ten more');
      const closeToFloor = await armed(14 * 60_000 + 50_000);
      assert.equal(closeToFloor.timers.pending()[0].ms, 30_000, 'ten seconds from the floor: the usual 30 seconds is longer, and wins');
      const old = await armed(20 * 60_000);
      assert.equal(old.timers.pending()[0].ms, 30_000, 'twenty minutes after a try: the floor is behind, the usual 30 seconds');
      const yesterday = await armed(86_400_000);
      assert.equal(yesterday.timers.pending()[0].ms, 30_000);
      assert.equal(SCHEDULE.minAutomaticGapMs, 15 * 60_000);
      for (const entry of [never, justNow, fiveMinutes, closeToFloor, old, yesterday]) entry.checker.stop();
      ok('the first check: 30 s after start; after a restart it waits for the 15-minute floor counted from the last try (a crash loop makes one request per 15 minutes, not one per start), and never less than 30 s');
    }
    {
      // jitter bounds
      const low = await armed(null, { random: () => 0 });
      const high = await armed(null, { random: () => 1 });
      assert.equal(low.timers.pending()[0].ms, 15_000, 'the first check, at the lowest: half of 30 s');
      assert.equal(high.timers.pending()[0].ms, 45_000, 'at the highest: one and a half');
      low.checker.stop(); high.checker.stop();
      // success: 12 hours; failure: 1 hour; each jittered by 10%
      for (const [random, factor] of [[0, 0.9], [0.5, 1], [1, 1.1]]) {
        const lived = await armed(null, { random: () => random });
        feed.mode('chain');
        feed.publish(feedManifest({ version: '3.10.3' }));
        lived.clock.advance(lived.timers.pending()[0].ms);
        await lived.timers.fire(lived.timers.pending()[0]);
        assert.equal(lived.timers.pending().length, 1, 'after a check the next one is set');
        assert.equal(lived.timers.pending()[0].ms, Math.round(SCHEDULE.intervalMs * factor), `after a success: 12 hours, with the jitter at ${random}`);
        feed.mode('status', { status: 500 });
        lived.clock.advance(lived.timers.pending()[0].ms);
        await lived.timers.fire(lived.timers.pending()[0]);
        assert.equal(lived.timers.pending()[0].ms, Math.round(SCHEDULE.retryMs * factor), `after a failure: an hour, with the jitter at ${random}`);
        lived.checker.stop();
      }
      feed.mode('chain');
      assert.equal(SCHEDULE.intervalMs, 12 * 3_600_000);
      assert.equal(SCHEDULE.retryMs, 3_600_000);
      assert.ok(SCHEDULE.retryMs >= SCHEDULE.minAutomaticGapMs, 'a retry is never inside the floor');
      ok('the schedule: 12 hours after a success and 1 hour after a failure, each with 10% jitter (the first check 50%), and a retry is never inside the 15-minute floor');
    }
    {
      // the timer is a request, the setting is a gate, and everything that would let a stale timer through is closed
      const armedNow = await armed(null);
      const [timer] = armedNow.timers.pending();
      const base = feed.checks();
      await armedNow.checker.setAutoCheck(false);
      assert.equal(timer.cleared, true, 'turning it off clears the pending timer');
      await armedNow.timers.fire(timer);
      assert.equal(feed.checks(), base, 'and a timer that fires anyway (it was already running) makes no request');
      const again = await armed(null);
      const stale = again.timers.pending()[0];
      again.checker.stop();
      assert.equal(stale.cleared, true, 'stop() clears the timer');
      await again.timers.fire(stale);
      assert.equal(feed.checks(), base, 'and a timer that fires after stop() makes no request');
      assert.equal(again.timers.pending().length, 0, 'nor does it set another');
      // a manual check moves the next automatic one: twelve hours from the manual one
      const manual = await armed(null);
      const first = manual.timers.pending()[0];
      await manual.checker.check();
      assert.equal(first.cleared, true, 'a manual check replaces the pending timer');
      assert.equal(manual.timers.pending().length, 1);
      assert.equal(manual.timers.pending()[0].ms, SCHEDULE.intervalMs);
      // an automatic timer that fires inside the floor (another check happened) waits instead of asking
      const floor = await armed(null);
      const early = floor.timers.pending()[0];
      floor.clock.advance(1000);
      await floor.checker.check();
      const before = feed.checks();
      early.cleared = false; early.fired = false;
      await floor.timers.fire(early);
      assert.equal(feed.checks(), before, 'an automatic check inside the floor of a manual one is not made');
      for (const entry of [manual, floor, armedNow]) entry.checker.stop();
      // timers never keep the process alive
      let unrefs = 0;
      const timers = { setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); const original = handle.unref.bind(handle); handle.unref = () => { unrefs += 1; return original(); }; return handle; }, clearTimeout };
      const real = await armed(null, { timers });
      assert.ok(unrefs >= 1, 'the timer is unref()ed: it does not keep the Hub alive');
      real.checker.stop();
      ok('a cleared or stale timer makes no request (setting turned off, stop()), a manual check replaces the pending timer and moves the next automatic one 12 hours on, an automatic timer inside the floor does not ask, and timers are unref()ed');
    }
    {
      // ZERO requests unless the owner said yes - with a positive control in the same timing
      const probe = async (label, { saved, whenUnanswered }) => {
        const directory = folder();
        if (saved !== null) fs.writeFileSync(path.join(directory, SETTINGS_FILE), JSON.stringify({ version: 1, autoCheckUpdates: saved }));
        const checker = createUpdateChecker({ directory, currentVersion: '3.10.2', feedUrl: feed.url, firstCheckMs: 40, random: () => 0.5, ...(whenUnanswered ? { whenUnanswered } : {}) });
        await checker.load();
        const before = feed.checks();
        checker.start();
        await sleep(600);
        const made = feed.checks() - before;
        checker.stop();
        return { label, made };
      };
      const control = await probe('on', { saved: true });
      assert.equal(control.made, 1, 'POSITIVE CONTROL: with the setting on and a first check after 40 ms, the server is asked exactly once in 600 ms');
      const unanswered = await probe('unanswered', { saved: null });
      const off = await probe('off', { saved: false });
      assert.equal(unanswered.made, 0, 'unanswered: the same timing, no request at all');
      assert.equal(off.made, 0, 'off: the same timing, no request at all');
      const flipped = await probe('unanswered, constant on', { saved: null, whenUnanswered: 'on' });
      assert.equal(flipped.made, 1, 'and with the constant flipped to "on" the unanswered case asks once, which is what the constant is for');
      const noChoiceButManual = make({ options: {} });
      await noChoiceButManual.checker.load();
      const manualBefore = feed.checks();
      assert.equal((await noChoiceButManual.checker.check()).checked, true);
      assert.equal(feed.checks() - manualBefore, 1, 'a manual check works in every state, unanswered included');
      const manualOff = make({ options: {} });
      await manualOff.checker.load();
      await manualOff.checker.setAutoCheck(false);
      const offBefore = feed.checks();
      assert.equal((await manualOff.checker.check()).checked, true);
      assert.equal(feed.checks() - offBefore, 1, 'and with the setting off');
      ok('ZERO requests while unanswered or off (600 ms at a 40 ms first check), against a positive control that makes exactly one with the setting on; flipping the constant makes the unanswered case ask once; a manual check works unanswered and off');
    }
    {
      // the failure of one check does not take the timer or the Hub down
      const directory = folder();
      fs.writeFileSync(path.join(directory, SETTINGS_FILE), JSON.stringify({ version: 1, autoCheckUpdates: true }));
      const timers = fakeTimers();
      const checker = createUpdateChecker({ directory, currentVersion: '3.10.2', feedUrl: `http://127.0.0.1:${await new Promise((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); })}/x.json`, timers, random: () => 0.5, now: () => new Date() });
      await checker.load();
      checker.start();
      const rejections = [];
      const onRejection = (reason) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      await timers.fire(timers.pending()[0]);
      await sleep(30);
      process.off('unhandledRejection', onRejection);
      assert.deepEqual(rejections, [], 'no unhandled rejection: the Hub exits on one');
      assert.equal(checker.status().error?.code, 'update_network');
      assert.equal(timers.pending().length, 1, 'and the next try is set');
      checker.stop();
      ok('a check that fails in a timer sets the next try and raises no unhandled rejection (the Hub treats one as fatal)');
    }
  }

  // ------------------------------------------------------------------------------------------------------------------------------- 7. the hooks the tests use, and what the code is not
  {
    const lines = [];
    const log = (line) => lines.push(line);
    assert.deepEqual(updateOptionsFromEnvironment({}, log), {}, 'no variable: nothing changes');
    assert.deepEqual(updateOptionsFromEnvironment({ CHATMCP_UPDATE_FEED_URL: feed.url }, log), { feedUrl: new URL(feed.url).href }, 'a loopback address stands in for the feed');
    assert.deepEqual(updateOptionsFromEnvironment({ CHATMCP_UPDATE_FEED_URL: feed.url, CHATMCP_UPDATE_FIRST_CHECK_MS: '300' }, log), { feedUrl: new URL(feed.url).href, firstCheckMs: 300 }, 'with a first check that comes sooner');
    assert.deepEqual(updateOptionsFromEnvironment({ CHATMCP_UPDATE_FEED_URL: feed.url, CHATMCP_UPDATE_FIRST_CHECK_MS: '0' }, log).firstCheckMs, 0);
    for (const bad of ['-1', 'abc', '', '60001', '1e9', 'Infinity', '1.5e2x']) assert.equal('firstCheckMs' in updateOptionsFromEnvironment({ CHATMCP_UPDATE_FEED_URL: feed.url, CHATMCP_UPDATE_FIRST_CHECK_MS: bad }, log), false, `a delay of ${JSON.stringify(bad)} is ignored`);
    lines.length = 0;
    for (const remote of ['https://evil.example/RELEASE-MANIFEST.json', 'http://github.com/x', 'https://github.com/other/repo/releases/latest/download/RELEASE-MANIFEST.json', 'http://127.0.0.1:1/x?token=1']) {
      assert.deepEqual(updateOptionsFromEnvironment({ CHATMCP_UPDATE_FEED_URL: remote, CHATMCP_UPDATE_FIRST_CHECK_MS: '300' }, log), {}, `${remote}: ignored, and so is the delay that went with it`);
    }
    assert.equal(lines.length, 4, 'each one is said in the log');
    assert.ok(lines.every((line) => !/evil\.example|token=1/.test(line)), 'without repeating what was set');
    assert.deepEqual(updateOptionsFromEnvironment({ CHATMCP_UPDATE_FIRST_CHECK_MS: '300' }, log), {}, 'a short delay with the real feed is ignored: it is for a stand-in only');
    assert.deepEqual(updateOptionsFromEnvironment({ CHATMCP_UPDATE_FEED_URL: FEED_URL, CHATMCP_UPDATE_FIRST_CHECK_MS: '300' }, log), {}, 'and so is one with the real feed named');
    ok('the test hooks: CHATMCP_UPDATE_FEED_URL takes a loopback address only and anything else is ignored with a line in the log (the real feed stays); CHATMCP_UPDATE_FIRST_CHECK_MS counts only beside it, between 0 and 60 s');

    // The script of the hand check (tests/live/check-update-feed.mjs) is run here, offline, against the stand-in: a tool that is never run rots, and this is the one that is pointed at the real feed.
    const live = path.join(HUB_ROOT, 'tests', 'live', 'check-update-feed.mjs');
    const runLive = (args, env) => new Promise((resolve) => {
      const child = spawn(process.execPath, [live, ...args], { env: { ...process.env, ...env }, windowsHide: true });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    feed.mode('chain');
    feed.publish(feedManifest({ version: '3.10.3' }));
    const good = await runLive([], { CHATMCP_UPDATE_FEED_URL: feed.url });
    assert.equal(good.code, 0, good.output);
    assert.match(good.output, /\(a loopback stand-in\)/);
    assert.match(good.output, /redirects:\s+2/);
    assert.match(good.output, /release:\s+3\.10\.3\s+commit 0123456789abcdef0123456789abcdef01234567/);
    assert.match(good.output, /installer:\s+DatGoldSetup\.exe/);
    assert.match(good.output, /verdict:\s+the Hub would offer 3\.10\.3 \(newer than 3\.10\.2\)/);
    assert.match(good.output, /notes link:\s+https:\/\/github\.com\/pddczpl\/ChatMCP\/releases\/tag\/v3\.10\.3/);
    assert.match(good.output, /OK: the Hub reads this answer\./);
    feed.mode('status', { status: 503 });
    const bad = await runLive([], { CHATMCP_UPDATE_FEED_URL: feed.url });
    assert.equal(bad.code, 1, bad.output);
    assert.match(bad.output, /FAIL: update_http: GitHub answered HTTP 503\./);
    assert.equal((await runLive(['--anything'], { CHATMCP_UPDATE_FEED_URL: feed.url })).code, 2, 'a bad use is exit 2, and nothing is asked');
    feed.mode('chain');
    ok('the hand-check script (tests/live/check-update-feed.mjs) runs offline against the stand-in: it prints what the Hub makes of the answer (release, commit, installer name, verdict, notes link), exits 1 with the code of a failure and 2 for a bad use');

    const source = fs.readFileSync(path.join(HUB_ROOT, 'lib', 'update-check.mjs'), 'utf8');
    assert.ok(!/child_process|\bspawn\b|\bexecFile\b|\bexecSync\b|\bfork\(/.test(source), 'the module starts no program');
    assert.ok(!/createWriteStream|\bwriteFile\b[^\n]*\.exe|\.exe['"`][^\n]*writeFile/i.test(source), 'and writes no downloaded file');
    assert.ok(!/redirect:\s*['"]follow['"]/.test(source), 'it does not hand redirects to a library');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal((code.match(/process\.env/g) ?? []).length, 1, 'the environment is read in one place');
    assert.ok(/export function updateOptionsFromEnvironment\(env = process\.env/.test(code), 'and that is the hook function');
    assert.equal((code.match(/https?:\/\/[^\s'"`)]+/g) ?? []).filter((url) => !/github\.com|githubusercontent\.com|localhost|127\.0\.0\.1|example/.test(url)).length, 0, 'no address in the module but GitHub\'s');
    ok('the module starts no program, writes no downloaded file, follows no redirect by itself, reads the environment only in the hook function and names no address but GitHub\'s');
  }

  console.log(`PASS: ${checks} update-check groups`);
} finally {
  await feed.close();
  await foreign.close();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
