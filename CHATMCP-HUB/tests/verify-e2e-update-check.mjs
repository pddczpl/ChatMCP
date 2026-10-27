// End-to-end scenario: the update notice through a REAL Hub process, and a loopback server that stands in for GitHub (tests/e2e/update-feed-server.mjs).
//
// tests/verify-update-check.mjs holds the module to its promises. This suite looks at the Hub the page talks to: the routes and every layer in front of them, what a real Hub sends over HTTP
// (its own version in the User-Agent, four headers and nothing else; two chains of requests, the manifest and its signature, and nothing else; the signature as the Hub says it with the key it was given
// and without it), that NOTHING is asked until the owner says yes (a positive control beside every "zero requests"),
// that a restart finds the notice without a request and keeps the 15-minute floor between attempts, that a skip and a choice survive a restart, and that bad answers (a page of HTML, an error, an
// endless body, a redirect to another server) leave a Hub that is still up and a notice that is still the last good one.
//
// The stand-in imitates GitHub's shape. It is not GitHub: whether the real answer is what the module expects was read by hand once, on 2026-10-26 (docs/THREAT-MODEL.md, Surface 8).
// CLAIM: update-notice-no-request-until-yes
import fs from 'node:fs';
import path from 'node:path';
import { findNeedles, runScenario } from './e2e/harness.mjs';
import { sleep, waitFor } from './e2e/hub-process.mjs';
import { feedManifest, startUpdateFeed } from './e2e/update-feed-server.mjs';
import { throwawayKey } from './support/release-keys.mjs';
import { VERSION } from '../lib/manager.mjs';
import { NEXT_PATCH, NEXT_PATCH_2, exactly } from './support/running-version.mjs';

const ROUTES = Object.freeze({ check: '/api/update/check', skip: '/api/update/skip', auto: '/api/update/auto-check' });
const STATE = 'update-check.json';
const SETTINGS = 'update-settings.json';
const SIGNED = 'SIGNED-QUERY-MUST-NOT-BE-KEPT';
const FIRST = 300; // the first check of a Hub that is allowed to ask, in ms (CHATMCP_UPDATE_FIRST_CHECK_MS)
const QUIET = 2000; // how long a Hub that must not ask is watched: more than six first checks

await runScenario({
  name: 'update-check',
  summary: 'the update notice on a real Hub: the routes and their layers, what is sent, nothing asked until the owner says yes, the floor across restarts, skip and choice across restarts, bad answers',
  budgetMs: 240_000,
}, async (t) => {
  const feed = await startUpdateFeed({ manifest: feedManifest({ version: NEXT_PATCH }) });
  t.own(() => feed.close());
  const other = await startUpdateFeed({ manifest: feedManifest({ version: NEXT_PATCH }) });
  t.own(() => other.close());
  const hooks = (extra = {}) => ({ CHATMCP_UPDATE_FEED_URL: feed.url, CHATMCP_UPDATE_FIRST_CHECK_MS: String(FIRST), ...extra });
  const read = (hub, name) => { try { return JSON.parse(fs.readFileSync(path.join(hub.stateDir, name), 'utf8')); } catch { return null; } };
  const updateOf = async (hub) => (await hub.state()).update;
  const post = (hub, route, body) => hub.request('POST', route, body);
  t.equal(feed.requests.length + other.requests.length, 0, 'the stand-ins start untouched');

  // ---- a Hub the owner has not answered: the state, the routes, and no request at all -----------------------------------------------------------
  const stateDir = path.join(t.scratch, 'state-a');
  let hub = await t.hub({ env: hooks(), stateDir });
  const initial = await updateOf(hub);
  t.equal(initial.current, VERSION, '/api/state: the version that runs is the Hub\'s own');
  t.equal([initial.latest, initial.available, initial.checkedAt, initial.lastAttemptAt, initial.installerName, initial.skippedVersion, initial.error, initial.checking], [null, false, null, null, null, null, null, false], 'nothing is known yet');
  t.equal(initial.autoCheck, { enabled: false, saved: null, needsChoice: true }, 'and the owner has not been asked: the page will ask');
  const status = await hub.get('/api/update/status');
  t.equal([status.status, Object.keys(status.json)], [200, ['update']], 'GET /api/update/status answers 200 with the state under "update", not at the top (a top-level "error" reads as a failed request to the page\'s checks)');
  t.equal({ ...status.json.update, nextAutomaticCheckAt: null }, { ...initial, nextAutomaticCheckAt: null }, 'and it says what /api/state says');
  const declared = (await hub.get('/api/capabilities')).json.postRoutes;
  t.check(Object.values(ROUTES).every((route) => declared.includes(route)), 'all three POST routes are declared in /api/capabilities');
  t.check(read(hub, STATE) === null && read(hub, SETTINGS) === null, 'no file is written until the owner does something');

  // ---- the layers in front of the routes, and bodies that are refused: none of them reaches the network -------------------------------------------
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
  }
  t.equal((await hub.rawRequest({ route: '/api/update/status' })).status, 401, 'GET /api/update/status: no bearer: 401');
  t.equal((await hub.rawRequest({ route: '/api/update/status', headers: { origin: hub.origin } })).status, 401, 'and the page\'s own Origin does not stand in for it');
  t.equal((await hub.rawRequest({ route: '/api/update/status', headers: { ...hub.authHeaders, host: 'evil.example' } })).status, 403, 'a Host that is not the Hub\'s: 403');
  for (const [label, body] of [['"true"', { enabled: 'true' }], ['1', { enabled: 1 }], ['0', { enabled: 0 }], ['null', { enabled: null }], ['an object', { enabled: {} }], ['nothing', {}], ['another key', { enable: true }]]) {
    const answer = await send(ROUTES.auto, page, body);
    t.check(answer.status === 400 && JSON.parse(answer.text).code === 'update_setting_invalid', `auto-check with ${label}: 400`, `${answer.status} ${answer.text.slice(0, 100)}`);
  }
  for (const [label, body] of [['nothing', {}], ['a number', { version: 5 }], ['text that is no version', { version: 'x' }], ['a pre-release', { version: `${NEXT_PATCH}-rc.1` }]]) {
    const answer = await send(ROUTES.skip, page, body);
    t.check(answer.status === 400 && JSON.parse(answer.text).code === 'update_skip_invalid', `skip with ${label}: 400`, `${answer.status} ${answer.text.slice(0, 100)}`);
  }
  const early = await send(ROUTES.skip, page, { version: NEXT_PATCH });
  t.check(early.status === 409 && JSON.parse(early.text).code === 'update_skip_stale', 'skip of a version nobody offered: 409', `${early.status} ${early.text.slice(0, 100)}`);
  t.check((await send(ROUTES.auto, page, '{ not json')).status === 400, 'a body that is not JSON: 400');
  t.check(read(hub, STATE) === null && read(hub, SETTINGS) === null, 'none of those wrote a file');
  await sleep(QUIET);
  t.equal(feed.requests.length, 0, `ZERO requests to the feed in ${QUIET} ms with the owner not asked yet (a first check would have come after ${FIRST} ms), after all of that`);

  // ---- "Check now" works unanswered: what a real Hub sends, and nothing else ---------------------------------------------------------------------
  const first = await post(hub, ROUTES.check, {});
  t.equal([first.status, first.json.checked, first.json.throttled], [200, true, false], 'POST check: 200, a check was made');
  t.equal(Object.keys(first.json).sort(), ['checked', 'csrfToken', 'throttled', 'update'], 'the answer holds the state under "update" next to the two flags');
  const found = first.json.update;
  t.equal([found.current, found.latest, found.available, found.installerName, found.notesUrl, found.error, found.checking], [VERSION, NEXT_PATCH, true, 'DatGoldSetup.exe', `https://github.com/pddczpl/ChatMCP/releases/tag/v${NEXT_PATCH}`, null, false], 'a newer release: the version, the installer name from the manifest, the link made from the version');
  t.equal([found.signature, found.kid, found.installerBytes], ['missing', null, 232753314], 'the owner has not signed it yet (the stand-in has no signature): the release shows up, "missing" says no download, and the size is the one the manifest gives');
  t.equal(found.autoCheck, { enabled: false, saved: null, needsChoice: true }, 'and the owner is still not asked-and-answered: a manual check is not an answer');
  t.equal(feed.checks(), 1, 'one check');
  t.equal(feed.requests.length, 4, 'is four GET requests in two chains: the three hops of the stand-in towards the manifest, and one for its signature (a 404)');
  const names = new Set();
  for (const request of feed.requests) {
    t.equal([request.method, request.headers['user-agent'], request.headers.accept], ['GET', `DatGold/${VERSION}`, 'application/json'], `${request.url.split('?')[0].slice(-40)}: GET, DatGold/${VERSION}, accept`);
    for (const name of Object.keys(request.headers)) names.add(name);
  }
  t.equal([...names].sort(), ['accept', 'connection', 'host', 'user-agent'], 'the only headers: nothing that identifies the person (no cookie, no login, no referrer, no language)');
  t.check(feed.requests.every((request) => new RegExp(`^/(pddczpl/ChatMCP/releases/(latest/download|download/v${exactly(NEXT_PATCH)})/RELEASE-MANIFEST\\.json(\\.sig)?|github-production-release-asset/)`).test(request.url)), 'every address asked for is the manifest, its signature or a hop towards one of them: no installer, no page, nothing to download');
  t.check(feed.requests.every((request) => !/\.exe|\.zip|installer/i.test(request.url.split('?')[0])), 'in particular not the installer the manifest names');
  t.equal(read(hub, STATE), { version: 1, latest: NEXT_PATCH, installerName: 'DatGoldSetup.exe', checkedAt: found.checkedAt, lastAttemptAt: found.lastAttemptAt, skippedVersion: null }, 'the state file: the release, the installer name and the two times');
  t.check(read(hub, SETTINGS) === null, 'and no setting: the owner has not decided');
  const second = await post(hub, ROUTES.check, {});
  t.equal([second.status, second.json.checked, second.json.throttled, second.json.update.latest], [200, false, true, NEXT_PATCH], 'a second press at once is answered from the state, flagged as throttled');
  t.equal(feed.checks(), 1, 'without a request');
  t.equal((await updateOf(hub)).available, true, '/api/state says the same');
  const log = hub.logText();
  t.check(log.includes(`DatGold ${NEXT_PATCH} đã có (bản đang chạy ${VERSION})`), 'the Hub log says what the check found');
  t.check(!log.includes(SIGNED) && !fs.readFileSync(path.join(hub.stateDir, STATE), 'utf8').includes(SIGNED), 'and neither the log nor the state file holds the signed address of the last hop');

  // ---- skip, and a restart that finds the notice without asking ---------------------------------------------------------------------------------
  const stale = await post(hub, ROUTES.skip, { version: NEXT_PATCH_2 });
  t.equal([stale.status, stale.json.code], [409, 'update_skip_stale'], 'skip of another version than the one on offer: 409');
  const skipped = await post(hub, ROUTES.skip, { version: NEXT_PATCH });
  t.equal([skipped.status, skipped.json.update.skippedVersion, skipped.json.update.available], [200, NEXT_PATCH, true], 'skip of the one on offer: saved; it is still available (the page decides what to show)');
  await hub.stop();
  feed.mode('stall'); // from here on a check would hang: what the restarted Hub knows, it knows from the file
  const checksBefore = feed.checks();
  hub = await t.hub({ env: hooks(), stateDir });
  const found2 = await updateOf(hub);
  t.equal([found2.latest, found2.available, found2.skippedVersion, found2.installerName, found2.checkedAt, found2.error], [NEXT_PATCH, true, NEXT_PATCH, 'DatGoldSetup.exe', found.checkedAt, null], 'a restart: the notice, the installer and the skip are there at once');
  t.equal(feed.checks(), checksBefore, 'and it was known without a request');
  const cleared = await post(hub, ROUTES.skip, { version: null });
  t.equal([cleared.status, cleared.json.update.skippedVersion], [200, null], 'null takes the skip back');
  feed.mode('chain');

  // ---- saying yes: the floor holds across the restart, then a positive control ----------------------------------------------------------------
  const yes = await post(hub, ROUTES.auto, { enabled: true });
  t.equal([yes.status, yes.json.update.autoCheck], [200, { enabled: true, saved: true, needsChoice: false }], 'yes: saved, on, nobody to ask');
  t.equal(read(hub, SETTINGS), { version: 1, autoCheckUpdates: true }, 'the setting file');
  const held = await updateOf(hub);
  t.equal(Date.parse(held.nextAutomaticCheckAt) - Date.parse(held.lastAttemptAt), 15 * 60_000, 'the next automatic check is exactly 15 minutes after the last attempt (the floor), not the 0.3 s of the first check: a Hub that restarts does not ask again at once');
  await sleep(QUIET);
  t.equal(feed.checks(), checksBefore, `ZERO new requests in ${QUIET} ms with the setting on, because the last attempt was minutes ago`);
  await hub.stop();
  hub = await t.hub({ env: hooks(), stateDir });
  await sleep(QUIET);
  t.equal(feed.checks(), checksBefore, 'and the same after another restart: the floor is counted from the attempt on disk');

  // the positive control: the same timing, a Hub whose last attempt is old, and the owner has said yes
  const oldState = path.join(t.scratch, 'state-b');
  fs.mkdirSync(oldState, { recursive: true });
  fs.writeFileSync(path.join(oldState, SETTINGS), JSON.stringify({ version: 1, autoCheckUpdates: true }));
  fs.writeFileSync(path.join(oldState, STATE), JSON.stringify({ version: 1, latest: '3.10.2', checkedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), lastAttemptAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
  const base = feed.checks();
  const control = await t.hub({ env: hooks(), stateDir: oldState });
  await waitFor(() => feed.checks() === base + 1, { timeoutMs: 8000, label: 'the first check of a Hub that may ask' });
  await sleep(1500);
  t.equal(feed.checks(), base + 1, 'POSITIVE CONTROL: a Hub with the setting on and an old attempt asks exactly once, shortly after it starts, and not again');
  const afterFirst = await waitFor(async () => { const state = await updateOf(control); return state.latest === NEXT_PATCH ? state : null; }, { label: 'the answer to be taken' });
  t.equal([afterFirst.available, afterFirst.error, afterFirst.checking], [true, null, false], 'and the notice is there');
  const timed = Date.parse(afterFirst.nextAutomaticCheckAt) - Date.parse(afterFirst.lastAttemptAt);
  t.check(timed >= 0.9 * 12 * 3_600_000 && timed <= 1.1 * 12 * 3_600_000, 'the next one is 12 hours on (with 10% jitter)', String(timed));

  // ---- saying no stops it, across a restart; a manual check still works -------------------------------------------------------------------------
  const no = await post(control, ROUTES.auto, { enabled: false });
  t.equal([no.status, no.json.update.autoCheck, no.json.update.nextAutomaticCheckAt], [200, { enabled: false, saved: false, needsChoice: false }, null], 'no: saved, off, no timer');
  await control.stop();
  fs.writeFileSync(path.join(oldState, STATE), JSON.stringify({ ...read({ stateDir: oldState }, STATE), lastAttemptAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
  const stopped = await t.hub({ env: hooks(), stateDir: oldState });
  const before = feed.checks();
  await sleep(QUIET);
  t.equal(feed.checks(), before, `ZERO requests in ${QUIET} ms after "no", although the last attempt is two days old (the same timing as the control above)`);
  t.equal((await updateOf(stopped)).autoCheck.saved, false, 'and the choice is the one the owner made');
  const manual = await post(stopped, ROUTES.check, {});
  t.equal([manual.status, manual.json.checked], [200, true], 'a manual check works with the setting off');
  t.equal(feed.checks(), before + 1, 'and it asked once');

  // ---- a Hub killed in the middle of a check: the attempt was already on disk, so a restart loop asks once per 15 minutes, not once per start ---
  {
    const dir = path.join(t.scratch, 'state-crash');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SETTINGS), JSON.stringify({ version: 1, autoCheckUpdates: true }));
    fs.writeFileSync(path.join(dir, STATE), JSON.stringify({ version: 1, latest: '3.10.2', checkedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), lastAttemptAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
    feed.mode('stall');
    const asked = feed.checks();
    const doomed = await t.hub({ env: hooks(), stateDir: dir });
    await waitFor(() => feed.checks() === asked + 1, { timeoutMs: 8000, label: 'the Hub to begin its check' });
    t.check(doomed.running && (await updateOf(doomed)).checking === true, 'the Hub is in the middle of a check that never answers');
    await doomed.kill();
    const cut = read({ stateDir: dir }, STATE);
    t.check(Date.now() - Date.parse(cut.lastAttemptAt) < 60_000, 'the attempt was on disk before the Hub was killed', String(cut.lastAttemptAt));
    t.equal(cut.latest, '3.10.2', 'and what was known is what it was');
    feed.mode('chain');
    const again = await t.hub({ env: hooks(), stateDir: dir });
    await sleep(QUIET);
    t.equal(feed.checks(), asked + 1, 'the restarted Hub asks nothing for the next 15 minutes: the floor is counted from the attempt that was cut short');
    const resumed = await updateOf(again);
    t.check(Date.parse(resumed.nextAutomaticCheckAt) - Date.parse(resumed.lastAttemptAt) === 15 * 60_000, 'and its next try is exactly 15 minutes after that attempt');
  }

  // ---- bad answers: the Hub stays up, says why, and keeps what it knew ---------------------------------------------------------------------------
  const badStates = [];
  const bad = [
    ['a page of HTML', () => feed.mode('html'), 'update_invalid_manifest'],
    ['an error from GitHub', () => feed.mode('status', { status: 503 }), 'update_http'],
    ['an answer that never ends', () => feed.mode('endless'), 'update_too_large'],
    ['a redirect to another server', () => feed.mode('redirect', { target: `${other.origin}/x` }), 'update_redirect_refused'],
    ['a feed that serves a pre-release', () => { feed.mode('direct'); feed.publish(feedManifest({ version: '3.99.0-rc.1' })); }, 'update_not_a_release'],
  ];
  for (const [label, arrange, code] of bad) {
    const dir = path.join(t.scratch, `bad-${badStates.length}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, STATE), JSON.stringify({ version: 1, latest: NEXT_PATCH, installerName: 'DatGoldSetup.exe', checkedAt: '2026-10-01T00:00:00.000Z', lastAttemptAt: '2026-10-01T00:00:00.000Z' }));
    badStates.push(dir);
    arrange();
    const victim = await t.hub({ env: hooks(), stateDir: dir });
    const answer = await post(victim, ROUTES.check, {});
    t.equal([answer.status, answer.json.update.error?.code], [200, code], `${label}: the answer is 200 with the error "${code}" in the state`);
    t.equal([answer.json.update.latest, answer.json.update.available, answer.json.update.checkedAt], [NEXT_PATCH, true, '2026-10-01T00:00:00.000Z'], `${label}: the last good release is kept`);
    t.check((await victim.get('/api/health')).ok && victim.running, `${label}: the Hub is still up`);
    t.check(!victim.logText().includes(SIGNED), `${label}: nothing signed in the log`);
    feed.mode('chain'); feed.publish(feedManifest({ version: NEXT_PATCH }));
  }
  t.equal(other.requests.length, 0, 'the server a redirect pointed at was never asked');

  // ---- the signature, on a real Hub: with the key it is given, without it ---------------------------------------------------------------------------
  {
    const owner = throwawayKey();
    const signed = await startUpdateFeed({ manifest: feedManifest({ version: NEXT_PATCH }), key: owner });
    t.own(() => signed.close());
    const signedHooks = (extra = {}) => ({ CHATMCP_UPDATE_FEED_URL: signed.url, CHATMCP_UPDATE_FIRST_CHECK_MS: String(FIRST), ...extra });
    const dir = path.join(t.scratch, 'state-signed');
    const trusting = await t.hub({ env: signedHooks({ CHATMCP_UPDATE_TEST_KEY: owner.spkiBase64 }), stateDir: dir });
    const answer = await post(trusting, ROUTES.check, {});
    const checked = answer.json.update;
    t.equal([answer.status, checked.signature, checked.kid, checked.error, checked.available, checked.installerBytes], [200, 'valid', owner.kid, null, true, 232753314], 'a Hub that is given the owner\'s key (the test hook) and a release signed with it: "valid", with the id of the key');
    t.equal([(await updateOf(trusting)).signature, (await trusting.get('/api/update/status')).json.update.kid], ['valid', owner.kid], '/api/state and GET /api/update/status say the same');
    t.equal(signed.requests.length, 5, 'two chains of requests: three hops towards the manifest and two towards its signature');
    t.equal(Object.keys(read(trusting, STATE)).sort(), ['checkedAt', 'installerName', 'lastAttemptAt', 'latest', 'skippedVersion', 'version'], 'nothing about the signature is saved');
    await trusting.stop();
    const restarted = await t.hub({ env: signedHooks({ CHATMCP_UPDATE_TEST_KEY: owner.spkiBase64 }), stateDir: dir });
    const afterRestart = await updateOf(restarted);
    t.equal([afterRestart.latest, afterRestart.available, afterRestart.signature, afterRestart.kid], [NEXT_PATCH, true, null, null], 'after a restart the release is known and its signature is not, until a check has looked: the Download button waits for it');
    const strangers = await t.hub({ env: signedHooks(), stateDir: path.join(t.scratch, 'state-signed-b') });
    const unknown = (await post(strangers, ROUTES.check, {})).json.update;
    t.equal([unknown.signature, unknown.kid, unknown.error?.code, unknown.available], ['invalid', null, 'update_signature_unknown_key', true], 'a Hub that does not trust that key (it has the placeholder only): "invalid", told apart from a signature that does not check, and the release still shows up');
    t.check(!trusting.logText().includes(SIGNED) && !strangers.logText().includes(SIGNED), 'no signed address in either log');
    signed.signature.set(Buffer.from('{"alg":"ES256","kid":"00000000","sig":"AAAA"}'));
    const forged = await t.hub({ env: signedHooks({ CHATMCP_UPDATE_TEST_KEY: owner.spkiBase64 }), stateDir: path.join(t.scratch, 'state-signed-c') });
    t.equal((await post(forged, ROUTES.check, {})).json.update.signature, 'invalid', 'a Hub that trusts the key and a signature that is not one: "invalid"');
  }

  // ---- what the Hub is not ----------------------------------------------------------------------------------------------------------------------
  const source = fs.readFileSync(new URL('../lib/update-check.mjs', import.meta.url), 'utf8');
  t.check(!/child_process|\bspawn\b|\bexecFile\b|\bexecSync\b|\bfork\(/.test(source), 'the module starts no program');
  const leaks = findNeedles(t.scratch, [SIGNED]);
  t.equal(leaks.hits, [], 'the signed address of the last hop is in no file of any Hub (state, logs, settings)');
  t.check(leaks.scanned > 10, 'and that was looked for in files', String(leaks.scanned));
});
