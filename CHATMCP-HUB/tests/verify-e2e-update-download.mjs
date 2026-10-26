// End-to-end scenario: the download of the installer through a REAL Hub process, and a loopback server that stands in for GitHub (tests/e2e/update-feed-server.mjs) with the owner's key made for this run.
//
// tests/verify-update-download.mjs holds the module to its promises. This suite looks at the Hub the page talks to: the two new routes and every layer in front of them, bodies that are refused and
// ask nothing, that NOTHING is downloaded until the owner clicks (not at start-up, not after a check that found a signed release, not after "yes" to automatic checks, with a positive control beside
// the "zero requests"), progress read from the status route while the stand-in holds the stream, cancel, two clicks, a Hub killed in the middle (SIGKILL) and the leftovers it finds when it starts
// again, a finished download found "ready" after a restart (and not when the key that signed it is no longer trusted), a Hub that shuts down politely in the middle, and a Hub that believes it runs
// on a system that cannot run the installer.
//
// The stand-in imitates GitHub's shape. It is not GitHub: the real feed is read by hand up to the signature (tests/live/check-update-download.mjs), and a real 230 MB download only with the
// owner's word.
// CLAIM: update-download-only-on-a-click
// CLAIM: update-download-needs-valid-signature
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { findNeedles, runScenario } from './e2e/harness.mjs';
import { HUB_ROOT, cleanEnvironment, freePort, sleep, waitFor } from './e2e/hub-process.mjs';
import { feedManifest, startUpdateFeed } from './e2e/update-feed-server.mjs';
import { throwawayKey } from './support/release-keys.mjs';

const ROUTES = Object.freeze({ download: '/api/update/download', cancel: '/api/update/download-cancel' });
const SIGNED = 'SIGNED-QUERY-MUST-NOT-BE-KEPT';
const MiB = 1024 * 1024;
const FIRST = 300; // the first check of a Hub that is allowed to ask, in ms (CHATMCP_UPDATE_FIRST_CHECK_MS)
const QUIET = 2000;

function pseudoBytes(size, seed) {
  const out = Buffer.alloc(size);
  let x = (Math.imul(seed, 2654435761) >>> 0) || 1;
  for (let index = 0; index < size; index += 4) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out.writeUInt32LE(x, index); }
  return out;
}

await runScenario({
  name: 'update-download',
  summary: 'the download of the installer on a real Hub: the routes and their layers, nothing downloaded before a click, progress, cancel, two clicks, a kill in the middle and what the next start finds, a restart, a shutdown, a system that cannot run the installer',
  budgetMs: 300_000,
}, async (t) => {
  const owner = throwawayKey();
  const feed = await startUpdateFeed({ key: owner });
  t.own(() => feed.close());
  const size = 6 * MiB;
  const bytes = pseudoBytes(size, 31);
  const sha = createHash('sha256').update(bytes).digest('hex');
  feed.publish(feedManifest({ version: '3.11.0', assets: [{ name: 'DatGoldSetup.exe', sha256: sha, bytes: size }, { name: 'DatGold-Browser-Companion.zip', sha256: 'c'.repeat(64), bytes: 48568 }] }));
  feed.installer.set({ name: 'DatGoldSetup.exe', bytes });
  const hooks = (extra = {}) => ({ CHATMCP_UPDATE_FEED_URL: feed.url, CHATMCP_UPDATE_FIRST_CHECK_MS: String(FIRST), CHATMCP_UPDATE_TEST_KEY: owner.spkiBase64, CHATMCP_UPDATE_TEST_PLATFORM: 'win32', ...extra });
  const installerHits = () => feed.requests.filter((request) => request.url.split('?')[0].endsWith('.exe')).length;
  const updateOf = async (hub) => (await hub.get('/api/update/status')).json.update;
  const post = (hub, route, body) => hub.request('POST', route, body);
  const folderOf = (stateDir) => path.join(stateDir, 'updates');
  const listing = (directory) => { try { return fs.readdirSync(directory, { recursive: true }).map((name) => String(name).replaceAll('\\', '/')).sort(); } catch { return null; } };
  const downloaded = async (hub) => waitFor(async () => { const download = (await updateOf(hub)).download; return ['ready', 'failed'].includes(download.state) ? download : null; }, { timeoutMs: 40_000, label: 'the download to end' });

  // ---- a Hub that has been asked nothing: the shape of the state, the routes, and no request at all -----------------------------------------------
  const stateDir = path.join(t.scratch, 'state-a');
  let hub = await t.hub({ env: hooks(), stateDir });
  const initial = await updateOf(hub);
  t.equal(initial.download, { state: 'idle' }, 'the state holds the download under "update": idle, with nothing else in it');
  t.equal((await hub.state()).update.download, { state: 'idle' }, '/api/state says the same');
  t.equal([initial.signature, initial.kid, initial.installerBytes], [null, null, null], 'and nothing is known about a signature before a check');
  const declared = (await hub.get('/api/capabilities')).json.postRoutes;
  t.check(Object.values(ROUTES).every((route) => declared.includes(route)), 'both POST routes are declared in /api/capabilities');
  const csrf = await hub.csrfToken();
  const page = { origin: hub.origin, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': csrf, 'content-type': 'application/json', ...hub.authHeaders };
  const send = (route, headers, body) => hub.rawRequest({ method: 'POST', route, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const without = (name) => Object.fromEntries(Object.entries(page).filter(([key]) => key !== name));
  for (const route of Object.values(ROUTES)) {
    t.equal((await send(route, without('authorization'), {})).status, 401, `${route}: no bearer: 401`);
    t.equal((await send(route, without('x-chatmcp-csrf'), {})).status, 403, `${route}: no CSRF token: 403`);
    t.equal((await send(route, { ...page, 'x-chatmcp-csrf': 'f'.repeat(64) }, {})).status, 403, `${route}: a wrong CSRF token: 403`);
    t.equal((await send(route, without('x-chatmcp-request'), {})).status, 403, `${route}: no page marker: 403`);
    t.equal((await send(route, without('origin'), {})).status, 403, `${route}: no Origin: 403`);
    t.equal((await send(route, { ...page, origin: 'http://evil.example' }, {})).status, 403, `${route}: another origin: 403`);
    t.equal((await send(route, { ...page, 'content-type': 'text/plain' }, {})).status, 415, `${route}: not JSON: 415`);
    t.equal((await hub.rawRequest({ method: 'GET', route, headers: hub.authHeaders })).status, 404, `${route}: a GET is not a route (what changes state is a POST)`);
  }
  for (const [label, body] of [['nothing', {}], ['a number', { version: 5 }], ['text that is no version', { version: 'x' }], ['a pre-release', { version: '3.11.0-rc.1' }], ['a path', { version: '../3.11.0' }]]) {
    const answer = await send(ROUTES.download, page, body);
    t.check(answer.status === 400 && JSON.parse(answer.text).code === 'update_download_invalid', `download with ${label}: 400 update_download_invalid`, `${answer.status} ${answer.text.slice(0, 100)}`);
  }
  t.check((await send(ROUTES.download, page, '{ not json')).status === 400, 'a body that is not JSON: 400');
  const early = await send(ROUTES.download, page, { version: '3.11.0' });
  t.check(early.status === 409 && JSON.parse(early.text).code === 'update_download_stale', 'a release nobody has offered (no check yet): 409 update_download_stale', `${early.status} ${early.text.slice(0, 100)}`);
  const idleCancel = await post(hub, ROUTES.cancel, {});
  t.equal([idleCancel.status, idleCancel.json.cancelled, idleCancel.json.update.download], [200, false, { state: 'idle' }], 'a cancel with nothing to cancel: 200, not cancelled');
  t.equal(feed.requests.length, 0, 'none of that asked the feed anything');
  t.equal(listing(folderOf(stateDir)), null, 'and none of it made a folder');

  // ---- nothing is downloaded until the owner clicks: not even after "yes", a check, and a release that is signed -------------------------------------
  const yes = await post(hub, '/api/update/auto-check', { enabled: true });
  t.equal([yes.status, yes.json.update.download], [200, { state: 'idle' }], 'yes to automatic checks: the answer carries the download state too');
  const found = await waitFor(async () => { const state = await updateOf(hub); return state.signature === 'valid' ? state : null; }, { timeoutMs: 20_000, label: 'the first automatic check to find a signed release' });
  t.equal([found.latest, found.available, found.signature, found.kid, found.installerBytes, found.error], ['3.11.0', true, 'valid', owner.kid, size, null], 'POSITIVE CONTROL: the automatic check ran and found a release that is signed (the key was given by the test hook)');
  await sleep(QUIET);
  t.equal(installerHits(), 0, `ZERO requests for the installer in ${QUIET} ms after that, although everything is ready for one`);
  t.equal(listing(folderOf(stateDir)), null, 'and no folder');
  const manual = await post(hub, '/api/update/check', {});
  t.equal(manual.json.update.download, { state: 'idle' }, 'a manual check: still nothing downloaded, and the answer carries the download state');

  // ---- the click: progress, two clicks, cancel -----------------------------------------------------------------------------------------------------
  feed.installer.mode('chain', { pauseAfter: 2 * MiB });
  const click = await post(hub, ROUTES.download, { version: '3.11.0', name: 'Other.exe', url: 'https://evil.example/x.exe' });
  t.equal([click.status, click.json.started, click.json.update.download.state, click.json.update.download.total], [200, true, 'downloading', size], 'the click: 200, started; the status says downloading with the size of the manifest; a name or an address in the body is not read');
  const midway = await waitFor(async () => { const download = (await updateOf(hub)).download; return download.state === 'downloading' && download.received >= 2 * MiB ? download : null; }, { timeoutMs: 20_000, label: 'part of the installer' });
  t.equal([midway.received, midway.total, midway.version], [2 * MiB, size, '3.11.0'], 'progress, read from GET /api/update/status while the stand-in holds the stream: the bytes that arrived out of the total');
  t.check(fs.existsSync(path.join(folderOf(stateDir), '3.11.0', 'DatGoldSetup.exe.part')) && !fs.existsSync(path.join(folderOf(stateDir), '3.11.0', 'DatGoldSetup.exe')), 'the bytes are in a .part file and the installer does not exist yet');
  t.equal((await hub.state()).update.download.received, 2 * MiB, '/api/state says the same');
  const twice = await post(hub, ROUTES.download, { version: '3.11.0' });
  t.equal([twice.status, twice.json.started, twice.json.update.download.state], [200, false, 'downloading'], 'a second click while it runs: 200, nothing started');
  t.equal(installerHits(), 1, 'one request for the installer');
  const cancelled = await post(hub, ROUTES.cancel, {});
  t.equal([cancelled.status, cancelled.json.cancelled, cancelled.json.update.download], [200, true, { state: 'idle' }], 'cancel: the download is stopped, and it is idle, not failed');
  t.equal(listing(folderOf(stateDir)), [], 'and its folder is gone');
  feed.installer.resume();
  await waitFor(() => feed.installer.openCount() === 0, { timeoutMs: 10_000, label: 'the connection to be closed' });
  t.equal(feed.installer.sent(), 2 * MiB, 'the Hub closed the connection: the rest of the installer was never sent');

  // ---- a whole download ---------------------------------------------------------------------------------------------------------------------------------
  feed.installer.mode('chain');
  const whole = await post(hub, ROUTES.download, { version: '3.11.0' });
  t.equal(whole.json.started, true, 'a click after a cancel starts again');
  const ready = await downloaded(hub);
  t.equal(ready, { state: 'ready', version: '3.11.0', bytes: size }, 'ready, with the version and the size');
  const folder = path.join(folderOf(stateDir), '3.11.0');
  t.equal(listing(folder), ['DatGoldSetup.exe', 'RELEASE-MANIFEST.json', 'RELEASE-MANIFEST.json.sig', 'state.json'], 'the folder holds the installer, the signed manifest and its signature, and the state file: no .part');
  t.check(fs.readFileSync(path.join(folder, 'DatGoldSetup.exe')).equals(bytes), 'the installer on disk is the bytes the stand-in served');
  t.equal(JSON.parse(fs.readFileSync(path.join(folder, 'state.json'), 'utf8')), { version: 1, release: '3.11.0', name: 'DatGoldSetup.exe', bytes: size, sha256: sha, kid: owner.kid }, 'the state file: the version, the name, the size, the SHA-256 and the id of the key that signed');
  const before = installerHits();
  const again = await post(hub, ROUTES.download, { version: '3.11.0' });
  t.equal([again.json.started, again.json.update.download.state, installerHits()], [false, 'ready', before], 'a click on something that is ready: nothing is fetched again');
  const log = hub.logText();
  t.check(log.includes('3.11.0') && !log.includes(SIGNED), 'the Hub log says what happened and holds no signed address');

  // ---- a restart finds it ready, from the folder alone; a Hub that no longer trusts the key does not -------------------------------------------------------
  await hub.stop();
  feed.mode('stall');
  const hitsBefore = feed.requests.length;
  hub = await t.hub({ env: hooks({ CHATMCP_UPDATE_FIRST_CHECK_MS: '60000' }), stateDir });
  t.equal((await updateOf(hub)).download, { state: 'ready', version: '3.11.0', bytes: size }, 'after a restart the download is ready (known from the folder, with no request: the feed would stall)');
  t.equal(feed.requests.length, hitsBefore, 'and nothing was asked');
  await hub.stop();
  hub = await t.hub({ env: { CHATMCP_UPDATE_FEED_URL: feed.url, CHATMCP_UPDATE_TEST_PLATFORM: 'win32' }, stateDir });
  t.equal((await updateOf(hub)).download, { state: 'idle' }, 'a Hub that does not trust the key that signed it (no test key, the placeholder only) does not call it ready');
  t.equal(listing(folderOf(stateDir)), [], 'and it removed the folder: what cannot prove itself is not kept');
  feed.mode('chain');
  await hub.stop();

  // ---- a Hub killed in the middle of a download: the leftovers are gone at the next start --------------------------------------------------------------
  const killedDir = path.join(t.scratch, 'state-killed');
  let doomed = await t.hub({ env: hooks(), stateDir: killedDir });
  await post(doomed, '/api/update/check', {});
  feed.installer.mode('chain', { pauseAfter: 2 * MiB });
  await post(doomed, ROUTES.download, { version: '3.11.0' });
  await waitFor(async () => (await updateOf(doomed)).download.received >= 2 * MiB, { timeoutMs: 20_000, label: 'part of the installer' });
  const part = path.join(folderOf(killedDir), '3.11.0', 'DatGoldSetup.exe.part');
  t.check(fs.existsSync(part), 'the .part file is on disk while the Hub downloads');
  await doomed.kill();
  t.check(fs.existsSync(part), 'and a Hub that is killed (no chance to clean up) leaves it there');
  fs.mkdirSync(path.join(folderOf(killedDir), '3.9.0'));
  fs.writeFileSync(path.join(folderOf(killedDir), '3.9.0', 'DatGoldSetup.exe'), 'an old installer');
  feed.installer.resume();
  feed.installer.mode('chain');
  // the signature is not saved, so the next Hub needs a check before it can offer the download; "Check now" waits a minute after the last attempt, so the note of the last attempt is made old
  const noteFile = path.join(killedDir, 'update-check.json');
  fs.writeFileSync(noteFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(noteFile, 'utf8')), lastAttemptAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
  const survivor = await t.hub({ env: hooks(), stateDir: killedDir });
  t.equal((await updateOf(survivor)).download, { state: 'idle' }, 'the next start: idle');
  t.equal(listing(folderOf(killedDir)), [], 'and the .part file and the folder of an old version are deleted');
  await post(survivor, '/api/update/check', {});
  const redo = await post(survivor, ROUTES.download, { version: '3.11.0' });
  t.equal(redo.json.started, true, 'and a click downloads again, from the start');
  t.equal((await downloaded(survivor)).state, 'ready', 'to the end');

  // ---- a Hub that shuts down politely in the middle leaves nothing but what is finished -------------------------------------------------------------------
  const politeDir = path.join(t.scratch, 'state-polite');
  const polite = await t.hub({ env: hooks(), stateDir: politeDir });
  await post(polite, '/api/update/check', {});
  feed.installer.mode('chain', { pauseAfter: 2 * MiB });
  await post(polite, ROUTES.download, { version: '3.11.0' });
  await waitFor(async () => (await updateOf(polite)).download.received >= 2 * MiB, { timeoutMs: 20_000, label: 'part of the installer' });
  await polite.stop();
  t.equal(listing(folderOf(politeDir)), [], 'a Hub that is stopped in the middle removes its .part file');
  feed.installer.resume();
  feed.installer.mode('chain');

  // ---- a system that cannot run the installer --------------------------------------------------------------------------------------------------------------
  const linuxDir = path.join(t.scratch, 'state-linux');
  const linux = await t.hub({ env: hooks({ CHATMCP_UPDATE_TEST_PLATFORM: 'linux' }), stateDir: linuxDir });
  await post(linux, '/api/update/check', {});
  const hitsLinux = installerHits();
  const refused = await post(linux, ROUTES.download, { version: '3.11.0' });
  t.equal([refused.status, refused.json.code, (await updateOf(linux)).download, installerHits()], [501, 'update_download_platform', { state: 'idle' }, hitsLinux], 'a Hub on a system that is not Windows: 501 update_download_platform, nothing fetched, idle');
  t.equal(listing(folderOf(linuxDir)), null, 'and nothing written');

  // ---- an unsigned release: no click can download it --------------------------------------------------------------------------------------------------------
  feed.signature.mode('missing');
  const unsignedDir = path.join(t.scratch, 'state-unsigned');
  const unsigned = await t.hub({ env: hooks(), stateDir: unsignedDir });
  const checked = (await post(unsigned, '/api/update/check', {})).json.update;
  t.equal([checked.available, checked.signature, checked.error], [true, 'missing', null], 'a release the owner has not signed: on offer, "missing"');
  const hitsUnsigned = installerHits();
  const refusedUnsigned = await post(unsigned, ROUTES.download, { version: '3.11.0' });
  t.equal([refusedUnsigned.status, refusedUnsigned.json.code, installerHits(), listing(folderOf(unsignedDir))], [409, 'update_download_unsigned', hitsUnsigned, null], 'a click is refused (409 update_download_unsigned): nothing fetched, nothing written');
  feed.signature.mode('chain');

  // ---- a release signed with a key this Hub was not given: no click can download it either ------------------------------------------------------------
  const stranger = throwawayKey();
  const strangerDir = path.join(t.scratch, 'state-stranger');
  const strangerHub = await t.hub({ env: hooks({ CHATMCP_UPDATE_TEST_KEY: stranger.spkiBase64 }), stateDir: strangerDir });
  const strangerCheck = (await post(strangerHub, '/api/update/check', {})).json.update;
  t.equal([strangerCheck.available, strangerCheck.signature, strangerCheck.error?.code], [true, 'invalid', 'update_signature_unknown_key'], 'a release signed with a key this Hub does not know: on offer, "invalid", and told apart from one whose signature does not check');
  const hitsStranger = installerHits();
  const refusedStranger = await post(strangerHub, ROUTES.download, { version: '3.11.0' });
  t.equal([refusedStranger.status, refusedStranger.json.code, installerHits(), listing(folderOf(strangerDir))], [409, 'update_download_unsigned', hitsStranger, null], 'a click is refused (409 update_download_unsigned): nothing fetched, nothing written');

  // ---- a check that finds the release no longer signed drops the download that was ready ----------------------------------------------------------------
  const withdrawnDir = path.join(t.scratch, 'state-withdrawn');
  const first = await t.hub({ env: hooks(), stateDir: withdrawnDir });
  await post(first, '/api/update/check', {});
  await post(first, ROUTES.download, { version: '3.11.0' });
  t.equal((await downloaded(first)).state, 'ready', 'a download that is ready');
  await first.stop();
  feed.signature.mode('missing');
  // the signature is not saved, so the next Hub has to look again; "Check now" waits a minute after the last attempt, so the note of the last attempt is made old
  const withdrawnNote = path.join(withdrawnDir, 'update-check.json');
  fs.writeFileSync(withdrawnNote, JSON.stringify({ ...JSON.parse(fs.readFileSync(withdrawnNote, 'utf8')), lastAttemptAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
  const second = await t.hub({ env: hooks({ CHATMCP_UPDATE_FIRST_CHECK_MS: '60000' }), stateDir: withdrawnDir });
  t.equal((await updateOf(second)).download.state, 'ready', 'after a restart it is ready again, known from the folder alone');
  const rechecked = (await post(second, '/api/update/check', {})).json.update;
  t.equal(rechecked.signature, 'missing', 'the check finds that the release is not signed any more');
  const dropped = await waitFor(async () => { const download = (await updateOf(second)).download; return download.state === 'idle' ? download : null; }, { timeoutMs: 10_000, label: 'the download to be dropped' });
  const emptied = await waitFor(() => (listing(folderOf(withdrawnDir))?.length === 0 ? [] : null), { timeoutMs: 10_000, label: 'the folder of the dropped download to be removed' }); // "idle" is said first, then the folder goes
  t.equal([dropped, emptied], [{ state: 'idle' }, []], 'and the download is dropped, with its folder: a finished check tells the downloader');
  feed.signature.mode('chain');
  await second.stop();

  // ---- a second Hub on the same data folder leaves the first one's download alone ------------------------------------------------------------------------
  {
    const sharedDir = path.join(t.scratch, 'state-shared');
    const owner1 = await t.hub({ env: hooks(), stateDir: sharedDir });
    await post(owner1, '/api/update/check', {});
    feed.installer.mode('chain', { pauseAfter: 2 * MiB });
    await post(owner1, ROUTES.download, { version: '3.11.0' });
    await waitFor(async () => (await updateOf(owner1)).download.received >= 2 * MiB, { timeoutMs: 20_000, label: 'part of the installer' });
    const part = path.join(folderOf(sharedDir), '3.11.0', 'DatGoldSetup.exe.part');
    t.check(fs.existsSync(part), 'the first Hub is downloading: its .part file is on disk');
    // a second Hub process on the same data folder (another port, as a second start of the launcher would be): it finds that the folder is taken and stops
    const second = spawn(process.execPath, [path.join(HUB_ROOT, 'hub.mjs'), '--backend', 'local', '--port', String(await freePort()), '--state-dir', sharedDir, '--no-open'], {
      cwd: HUB_ROOT, env: cleanEnvironment(t.scratch, { CHATMCP_HUB_SECRET: randomBytes(32).toString('hex'), ...hooks() }), stdio: 'ignore', windowsHide: true,
    });
    await new Promise((resolve) => { const timer = setTimeout(() => { second.kill(); resolve(); }, 15_000); second.on('close', () => { clearTimeout(timer); resolve(); }); });
    t.check(fs.existsSync(part), 'and it did not delete the first Hub\'s .part file: what a killed Hub left is cleaned up only by a Hub that holds the data folder');
    feed.installer.resume();
    t.equal((await downloaded(owner1)).state, 'ready', 'so the first download goes on to the end');
    feed.installer.mode('chain');
    await owner1.stop();
  }

  // ---- what the Hub is not -----------------------------------------------------------------------------------------------------------------------------------
  const hubSource = fs.readFileSync(new URL('../hub.mjs', import.meta.url), 'utf8');
  const downloadCase = hubSource.split('\n').filter((line) => /case '\/api\/update\/download(-cancel)?'/.test(line)).join('\n');
  t.check(downloadCase.length > 0 && !/requireNoTask|requireIdle|activeTaskId/.test(downloadCase), 'a download is allowed while agent tasks run: the routes do not ask whether a task is running');
  const moduleSource = fs.readFileSync(new URL('../lib/update-download.mjs', import.meta.url), 'utf8');
  t.check(!/child_process|\bspawn\b|\bexecFile\b|\bexecSync\b|\bfork\(/.test(moduleSource), 'the download module starts no program');
  const leaks = findNeedles(t.scratch, [SIGNED]);
  t.equal(leaks.hits, [], 'the signed address of the last hop is in no file of any Hub (state, logs, settings, the download folder)');
  t.check(leaks.scanned > 10, 'and that was looked for in files', String(leaks.scanned));
});
