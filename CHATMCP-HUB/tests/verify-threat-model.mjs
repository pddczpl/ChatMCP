// docs/THREAT-MODEL.md must cite code that exists and say what SECURITY.md, the README and docs/HUB-AUTH.md say.
//
// A threat model that names a function nobody can find, quotes a limit the code no longer has, or contradicts the security policy
// is worse than none. This suite reads the document and checks, against the real sources:
//
//   1. the "Code references" table: every file exists and contains the symbol (and every other identifier in the role column);
//      every [C#] used in the text is in the table and every row is used;
//   2. every test the document names exists, and every threat row (H, O, R) names a test or says "not tested";
//   3. the numbers in the text equal the code: ticket lifetime and limit, pairing validity and attempts, review timeout, and the
//      routes that answer a browser-extension Origin without the secret (EXTENSION_READ_ROUTES) are the ones the documents name;
//   4. the same-OS-user limitation is stated in the threat model, SECURITY.md, the README and HUB-AUTH.md; SECURITY.md links the
//      threat model and describes the bearer (not only Host/Origin/CSRF), the open exceptions and the best-effort Companion filter;
//   4b. Surface 8 (the update notice, the signature on the manifest and the download): the address, the hosts, the limits, the times and the constant that says what "not answered" means
//      are the ones in lib/update-check.mjs, the limits of the signature file, of the key list and of the download are the ones in lib/release-signature.mjs and lib/update-download.mjs, and
//      SECURITY.md and the README say that the Hub looks only after the owner has said yes, that Download needs a valid signature, that a download starts only on the owner's click and that
//      nothing is installed or run;
//   5. negative controls: the same checks on a temporary copy of the documents with defects put in one at a time (a symbol that does
//      not exist, a missing file, a wrong ticket lifetime, a route missing from SECURITY.md, the same-user sentence removed, a
//      dangling reference ...); each must be reported.
//
// Needs the repository root next to CHATMCP-HUB; without it the suite reports SKIP, never PASS.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');
const DOCUMENTS = ['docs/THREAT-MODEL.md', 'SECURITY.md', 'README.md', 'docs/HUB-AUTH.md', 'docs/INDEX.md'];

if (DOCUMENTS.some((name) => !existsSync(path.join(REPO, name)))) {
  console.log('CHATMCP_TEST_SKIP: the repository documents were not found next to CHATMCP-HUB (the threat model check needs the whole repository)');
  process.exit(0);
}

const { EXTENSION_READ_ROUTES } = await import(pathToFileURL(path.join(HUB, 'hub.mjs')).href);
const { TICKET_LIMIT, TICKET_TTL_MS, attachToRunningHub } = await import(pathToFileURL(path.join(HUB, 'lib', 'hub-session.mjs')).href);
const UPDATE = await import(pathToFileURL(path.join(HUB, 'lib', 'update-check.mjs')).href);
const { DOWNLOAD } = await import(pathToFileURL(path.join(HUB, 'lib', 'update-download.mjs')).href);
const { MAX_KEYS, SIGNATURE_ASSET, SIGNATURE_LIMITS } = await import(pathToFileURL(path.join(HUB, 'lib', 'release-signature.mjs')).href);

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const read = (root, name) => readFileSync(path.join(root, name), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

/** Problems found in the documents under `docsRoot`, with the code and tests taken from `codeRoot`. */
export function checkThreatModel(docsRoot, codeRoot = REPO, constants = { WHEN_UNANSWERED: UPDATE.WHEN_UNANSWERED }) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const model = read(docsRoot, 'docs/THREAT-MODEL.md');
  const security = read(docsRoot, 'SECURITY.md');
  const readme = read(docsRoot, 'README.md');
  const hubAuth = read(docsRoot, 'docs/HUB-AUTH.md');
  const index = read(docsRoot, 'docs/INDEX.md');

  // 1. code references ----------------------------------------------------------------------------------------------------------------
  const referencesStart = model.indexOf('## Code references');
  const referencesEnd = model.indexOf('\n## ', referencesStart + 1);
  const referenceSection = referencesStart < 0 ? '' : model.slice(referencesStart, referencesEnd < 0 ? undefined : referencesEnd);
  const body = referencesStart < 0 ? model : model.slice(0, referencesStart) + (referencesEnd < 0 ? '' : model.slice(referencesEnd));
  const rows = [...referenceSection.matchAll(/^\| (C\d+) \| `([^`]+)` \| `([^`]+)` \| (.*) \|$/gm)].map((match) => ({ id: match[1], file: match[2], symbol: match[3], role: match[4] }));
  if (rows.length < 20) fail(`the code reference table has ${rows.length} rows; at least 20 are expected`);
  for (const row of rows) {
    const file = path.join(codeRoot, row.file);
    if (!existsSync(file)) { fail(`${row.id}: ${row.file} does not exist`); continue; }
    const source = readFileSync(file, 'utf8');
    const has = (symbol) => (symbol.startsWith('#') ? source.includes(symbol) : new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(source));
    if (!has(row.symbol)) fail(`${row.id}: ${row.file} has no symbol ${row.symbol}`);
    for (const [, token] of row.role.matchAll(/`([^`]+)`/g)) {
      const identifier = token.replace(/\(\)$/, '');
      if (identifier.includes('/') || identifier.includes(' ') || identifier.includes('*')) continue; // paths and globs are not symbols
      if (!has(identifier)) fail(`${row.id}: ${row.file} has no ${identifier}, which the role column names`);
    }
  }
  const ids = new Set(rows.map((row) => row.id));
  const used = new Set([...body.matchAll(/\[(C\d+)\]/g)].map((match) => match[1]));
  for (const id of used) if (!ids.has(id)) fail(`the text cites [${id}], which is not in the code reference table`);
  for (const id of ids) if (!used.has(id)) fail(`${id} is in the code reference table but no text cites it`);

  // 2. tests ---------------------------------------------------------------------------------------------------------------------------
  const named = new Set([...model.matchAll(/`((?:CHATMCP-HUB\/tests\/|tests\/)?verify-[\w-]+\.mjs|ui\/e2e\/[\w.-]+\.(?:mjs|spec\.mjs)|scripts\/tests\/[\w/.-]+\.mjs|CHATMCP-HUB\/tests\/[\w/.-]+\.mjs)`/g)].map((match) => match[1]));
  if (named.size < 10) fail(`only ${named.size} tests are named; the document should point at the evidence`);
  for (const name of named) {
    const candidates = [name, `CHATMCP-HUB/tests/${name}`, `CHATMCP-HUB/${name}`].map((candidate) => path.join(codeRoot, candidate));
    if (!candidates.some((candidate) => existsSync(candidate))) fail(`the test ${name} does not exist`);
  }
  for (const match of model.matchAll(/^\| ((?:H|O|R|K|S|P|M|U)\d+) \|(.*)\|$/gm)) {
    const cells = match[2].split(' | ');
    const testCell = cells[cells.length - 2] ?? '';
    if (!/`[^`]*(?:verify-|\.spec\.|smoke|run\.mjs)[^`]*`|not tested/i.test(testCell)) fail(`${match[1]}: the Test column names no test and does not say "not tested"`);
    const limitCell = cells[cells.length - 1] ?? '';
    if (limitCell.trim().length < 4) fail(`${match[1]}: the Limit column is empty`);
  }

  // 3. numbers and routes equal the code -------------------------------------------------------------------------------------------------
  const runner = readFileSync(path.join(codeRoot, 'CHATMCP-HUB/lib/browser-runner.mjs'), 'utf8');
  const pairingMinutes = Number(runner.match(/expires: this\.now\(\) \+ (\d+)/)?.[1]) / 60_000;
  const pairingAttempts = Number(runner.match(/\+\+pending\.attempts > (\d+)/)?.[1]);
  const reviewMinutes = Number(runner.match(/reviewTimeoutMs = ([\d_]+)/)?.[1].replaceAll('_', '')) / 60_000;
  if (!model.includes(`a ${TICKET_TTL_MS / 1000} second, single-use ticket`)) fail(`the text does not say that a ticket lives ${TICKET_TTL_MS / 1000} seconds (TICKET_TTL_MS)`);
  if (!new RegExp(`at most ${TICKET_LIMIT} outstanding`).test(model)) fail(`the text does not say that at most ${TICKET_LIMIT} tickets are outstanding (TICKET_LIMIT)`);
  if (!Number.isFinite(pairingMinutes) || !Number.isFinite(pairingAttempts)) fail('browser-runner.mjs: the pairing validity or attempt limit was not found');
  else {
    if (!new RegExp(`valid ${pairingMinutes} minutes`).test(model)) fail(`the text does not say that a pairing code is valid ${pairingMinutes} minutes`);
    if (!new RegExp(`${pairingAttempts} attempts`).test(model)) fail(`the text does not say that a pairing code allows ${pairingAttempts} attempts`);
    if (!new RegExp(`${pairingMinutes} minute and ${pairingAttempts} attempt limits`).test(model)) fail('RR-3 does not quote the pairing limits of the code');
  }
  const reviewWords = { 10: 'Ten' }[reviewMinutes];
  if (!reviewWords || !new RegExp(`${reviewWords} minutes without a decision`).test(model)) fail(`the text does not say that a held message times out after ${reviewMinutes} minutes (reviewTimeoutMs)`);
  for (const route of EXTENSION_READ_ROUTES) {
    for (const [name, text] of [['docs/THREAT-MODEL.md', model], ['SECURITY.md', security], ['docs/HUB-AUTH.md', hubAuth]]) {
      if (!text.includes(`\`${route}\``) && !text.includes(`\`GET ${route}\``)) fail(`${name} does not name ${route}, which answers a browser-extension Origin without the secret`);
    }
  }
  if (!/browser-extension origin/i.test(readme)) fail('README.md does not say that the Companion status routes answer a browser-extension origin without the secret');

  // 3b. Surface 8: the update notice says what lib/update-check.mjs does -----------------------------------------------------------------------
  {
    const start = model.indexOf('## Surface 8');
    const end = model.indexOf('\n## ', start + 1);
    const surface = start < 0 ? '' : model.slice(start, end < 0 ? undefined : end);
    if (!surface) fail('docs/THREAT-MODEL.md has no Surface 8 (the update notice)');
    const { FEED_URL, FEED_HOSTS, LIMITS, SCHEDULE } = UPDATE;
    const stated = [
      [`\`${FEED_URL}\``, 'the address of the feed (FEED_URL)'],
      ...FEED_HOSTS.map((host) => [host, `the host ${host} (FEED_HOSTS)`]),
      [`${LIMITS.maxBytes / 1024} KiB`, 'the size limit (LIMITS.maxBytes)'],
      [`${LIMITS.timeoutMs / 1000} seconds`, 'the deadline (LIMITS.timeoutMs)'],
      [`at most ${LIMITS.maxRedirects} times`, 'the number of redirects (LIMITS.maxRedirects)'],
      [`${SCHEDULE.firstCheckMs / 1000} seconds after it starts`, 'the first check (SCHEDULE.firstCheckMs)'],
      [`every ${SCHEDULE.intervalMs / 3_600_000} hours`, 'the interval (SCHEDULE.intervalMs)'],
      [`${SCHEDULE.retryMs / 3_600_000} hour after a failure`, 'the retry after a failure (SCHEDULE.retryMs)'],
      [`${SCHEDULE.minAutomaticGapMs / 60_000} minutes of the last attempt`, 'the floor between attempts (SCHEDULE.minAutomaticGapMs)'],
      [SCHEDULE.minManualGapMs === 60_000 ? 'at most once a minute' : '', 'the limit of a manual check (SCHEDULE.minManualGapMs)'],
      ['`WHEN_UNANSWERED`', 'the constant that says what "not answered" means'],
      [`at most ${SIGNATURE_LIMITS.maxBytes / 1024} KiB`, 'the size limit of the signature file (SIGNATURE_LIMITS.maxBytes)'],
      [`at most ${MAX_KEYS};`, 'the number of keys the key file may hold (MAX_KEYS)'],
      [SIGNATURE_ASSET, 'the name of the signature file (SIGNATURE_ASSET)'],
      ['CHATMCP-HUB/lib/release-keys.json', 'the key file'],
      ['ECDSA over P-256 with SHA-256', 'the algorithm of the signature'],
      [`at most ${DOWNLOAD.maxBytes / 1024 ** 3} GiB`, 'the size limit of the installer (DOWNLOAD.maxBytes)'],
      [`${DOWNLOAD.idleTimeoutMs / 1000} seconds without a byte`, 'the idle limit of the download (DOWNLOAD.idleTimeoutMs)'],
      [DOWNLOAD.freeSpaceFactor === 2 ? 'twice the installer\'s size free' : '', 'the room needed on the disk (DOWNLOAD.freeSpaceFactor)'],
      ['only from the owner\'s click on Download', 'that a download starts only from the owner\'s click'],
      ['Nothing is installed, moved or run', 'that nothing is installed, moved or run'],
    ];
    for (const [needle, what] of stated) if (needle && !surface.includes(needle)) fail(`Surface 8 does not state ${what}: ${needle}`);
    if (constants.WHEN_UNANSWERED !== 'ask') fail('WHEN_UNANSWERED is not "ask": the README, SECURITY.md and Surface 8 say that nothing is asked until the owner has said yes; change them with the constant');
    const security8 = security.slice(security.indexOf('## Update notice'), security.indexOf('\n## ', security.indexOf('## Update notice') + 1));
    if (!security8.includes('## Update notice')) fail('SECURITY.md has no "Update notice" section');
    for (const [needle, what] of [
      [`\`${FEED_URL}\``, 'the address of the feed'], ...FEED_HOSTS.map((host) => [host, `the host ${host}`]), [`${LIMITS.maxBytes / 1024} KiB`, 'the size limit'], [`${LIMITS.timeoutMs / 1000} seconds`, 'the deadline'],
      [`at most ${LIMITS.maxRedirects} redirects`, 'the number of redirects'], [`${SCHEDULE.firstCheckMs / 1000} seconds after the Hub starts`, 'the first check'], [`every ${SCHEDULE.intervalMs / 3_600_000} hours`, 'the interval'],
      [`${SCHEDULE.minAutomaticGapMs / 60_000} minutes of the last attempt`, 'the floor between attempts'], ['at most once a minute', 'the limit of a manual check'],
      ['**only after you have said yes**', 'that the Hub asks only after the owner has said yes'],
      ['**A download starts only from your click on Download**', 'that a download starts only from the owner\'s click'], ['**Nothing is installed, moved or run in this step**', 'that nothing is installed, moved or run'],
      ['**Only a release whose manifest has a valid signature is offered for download.**', 'that Download needs a valid signature'], ['ECDSA over P-256 with SHA-256', 'the algorithm of the signature'],
      [`at most ${SIGNATURE_LIMITS.maxBytes / 1024} KiB`, 'the size limit of the signature file'], [SIGNATURE_ASSET, 'the name of the signature file'], ['CHATMCP-HUB/lib/release-keys.json', 'the key file'],
      [`takes at most ${DOWNLOAD.maxBytes / 1024 ** 3} GiB`, 'the size limit of the installer'], [`${DOWNLOAD.idleTimeoutMs / 1000} seconds without a byte`, 'the idle limit of the download'],
      [DOWNLOAD.freeSpaceFactor === 2 ? 'twice the installer\'s size free' : '', 'the room needed on the disk'],
    ]) if (needle && !security8.includes(needle)) fail(`SECURITY.md (Update notice) does not state ${what}: ${needle}`);
    for (const [needle, what] of [['github.com', 'the host it asks'], ['until you answer, the app makes no request of its own', 'that nothing is asked before the owner answers'],
      ['A download starts only when you click **Download**', 'that a download starts only on the owner\'s click'], ['Nothing is installed or run in this version', 'that nothing is installed or run'],
      ['offers **Download** only for a release whose signature checks', 'that Download needs a signature that checks'], ['it has no Authenticode signature', 'that the installer has no Authenticode signature'],
    ]) if (!readme.includes(needle)) fail(`README.md does not state ${what} (update notice): ${needle}`);
    if (!/Surface 8/.test(security8)) fail('SECURITY.md (Update notice) does not point at Surface 8 of the threat model');
    if (!/update check of Surface 8/.test(model.slice(model.indexOf('## Surface 7'), model.indexOf('## Surface 8')))) fail('Surface 7 still says that nothing but the owner\'s button makes the Hub ask: it does not name the update check of Surface 8');
    if (/models\.dev, or any host, without the owner asking/.test(model)) fail('M1 still says "or any host": the update check of Surface 8 is a second request the Hub can make');
  }

  // 4. the documents agree -------------------------------------------------------------------------------------------------------------
  const SAME_USER = /(running as (?:you|the owner)|runs? as the (?:same Windows user|owner)|as the same Windows user|same Windows user)/i;
  const NOT_PROTECT = /(does \*\*not\*\* protect|does not protect|not protect against)/i;
  for (const [name, text] of [['docs/THREAT-MODEL.md', model], ['SECURITY.md', security], ['README.md', readme], ['docs/HUB-AUTH.md', hubAuth]]) {
    if (!SAME_USER.test(text) || !NOT_PROTECT.test(text)) fail(`${name} does not state that the secret does not protect against a program running as the same Windows user`);
    if (!text.includes('run/hub-session.json')) fail(`${name} does not name run/hub-session.json, the file that holds the secret`);
  }
  if (!/readable by any process that runs as the same Windows user|Any process that runs as the same Windows user can read/i.test(model)) fail('docs/THREAT-MODEL.md does not say that the session file is readable by any process of the same Windows user');
  for (const group of ['other Windows accounts', 'sandboxed processes', 'web pages']) {
    for (const [name, text] of [['docs/THREAT-MODEL.md', model], ['SECURITY.md', security], ['README.md', readme], ['docs/HUB-AUTH.md', hubAuth]]) {
      if (!text.includes(group)) fail(`${name} does not list "${group}" among what the secret protects against`);
    }
  }
  if (!security.includes('(docs/THREAT-MODEL.md)')) fail('SECURITY.md does not link docs/THREAT-MODEL.md');
  if (!readme.includes('(docs/THREAT-MODEL.md)')) fail('README.md does not link docs/THREAT-MODEL.md');
  if (!index.includes('(THREAT-MODEL.md)')) fail('docs/INDEX.md does not link THREAT-MODEL.md');
  if (!/Authorization: Bearer/.test(security) || !/per-launch secret/.test(security)) fail('SECURITY.md does not describe the per-launch bearer secret');
  if (/validates Host and Origin and applies CSRF protection to mutations\. Browser Companion/.test(security)) fail('SECURITY.md still describes only Host, Origin and CSRF for the local interface');
  if (!/best effort/i.test(security) || !/credential/.test(security)) fail('SECURITY.md does not state that the Companion outbound filter is best effort');
  if (!/best effort|pattern-based/i.test(model)) fail('docs/THREAT-MODEL.md does not state the limits of the outbound filter');
  // RR-4 is closed for every client that reads the session file: the native clients, the Node launcher and the PowerShell helper scripts.
  // The old exceptions must be gone everywhere and the check must be stated.
  for (const [name, text] of [['docs/THREAT-MODEL.md', model], ['SECURITY.md', security], ['README.md', readme], ['docs/HUB-AUTH.md', hubAuth]]) {
    if (/does not check which process listens on the port|do not compare the session's process id|does not do that check|checks only the port and the health answer/.test(text)) fail(`${name} still says that the Node launcher does not check which process listens on the port`);
    if (/\*\*Still open:\*\*|without (?:first )?(?:checking|looking up) (?:which process listens|the listener)|do not (?:yet )?look (?:that )?up|do not yet look up|look up no listener/i.test(text)) fail(`${name} still says that the PowerShell helper scripts do not look up which process listens on the port`);
  }
  if (!/Node launcher and the PowerShell helper scripts present the secret only to the process that listens on the port/.test(model)) fail('docs/THREAT-MODEL.md (H6) does not say that the Node launcher and the PowerShell helper scripts present the secret only to the process that listens on the port');
  if (!/Node launcher[\s\S]{0,120}PowerShell helper scripts[\s\S]{0,60}present the secret only to the process that listens on the port/.test(hubAuth)) fail('docs/HUB-AUTH.md does not say that the Node launcher and the PowerShell helper scripts present the secret only to the process that listens on the port');
  if (!/PowerShell helper scripts[\s\S]{0,300}only to the process that listens on the port/.test(security)) fail('SECURITY.md does not say that the PowerShell helper scripts present the secret only to the process that listens on the port');
  // The three scripts are named where the check is described.
  for (const [name, text] of [['docs/THREAT-MODEL.md', model], ['SECURITY.md', security], ['docs/HUB-AUTH.md', hubAuth]]) {
    if (!text.includes('Stop-ChatMcpHub.ps1')) fail(`${name} does not name Stop-ChatMcpHub.ps1, one of the PowerShell helper scripts that check the listener before they present the session secret`);
  }
  for (const script of ['Run-StudioSmoke.ps1', 'Test-Gateway-ViaHub.ps1']) {
    if (!model.includes(script)) fail(`docs/THREAT-MODEL.md does not name ${script}, one of the PowerShell helper scripts that check the listener before they present the session secret`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
const real = checkThreatModel(REPO);
assert.deepEqual(real, [], `threat model problems:\n  - ${real.join('\n  - ')}`);
ok('every code reference of docs/THREAT-MODEL.md exists, every cited reference is in the table and every row is cited');
ok('every named test exists and every threat row names a test or says "not tested"');
ok(`the numbers in the text equal the code (ticket ${TICKET_TTL_MS / 1000} s / ${TICKET_LIMIT}, pairing code, review timeout) and the routes of EXTENSION_READ_ROUTES (${EXTENSION_READ_ROUTES.join(', ')}) are named in the threat model, SECURITY.md and HUB-AUTH.md`);
ok('the threat model, SECURITY.md, the README and HUB-AUTH.md all state the same-user limitation, the same protected groups and the session file; SECURITY.md describes the bearer, the open exceptions and the best-effort filter');

// ---- the open exceptions, observed on a real Hub ---------------------------------------------------------------------------------------
// RR-2 and RR-3 are documented as open. Each is pinned to what the code does today, so a fix flips an assertion here and the
// threat model, SECURITY.md and the README have to be changed together with it. RR-4 (a client presenting the secret to whatever
// listens on the port) is closed for the Node launcher and the PowerShell helper scripts; its wiring is pinned below and the real
// squatters are in verify-hub-listener.mjs and verify-hub-listener-powershell.mjs.
{
  const { startHub } = await import(pathToFileURL(path.join(HUB, 'tests', 'e2e', 'hub-process.mjs')).href);
  const liveScratch = mkdtempSync(path.join(os.tmpdir(), 'chatmcp-threat-live-'));
  let hub;
  try {
    hub = await startHub({ scratch: liveScratch });
    const forged = `chrome-extension://${'a'.repeat(32)}`; // any 32 letters from a to p: a pattern, not a registered extension
    const ask = (route, headers = {}, method = 'GET', body = null) => hub.rawRequest({ method, route, headers: { host: `127.0.0.1:${hub.port}`, ...headers }, body });

    const noOrigin = await ask('/api/extension-state');
    assert.equal(noOrigin.status, 401, 'without an Origin and without the secret the route is refused');
    const web = await ask('/api/extension-state', { origin: 'http://evil.example' });
    assert.equal(web.status, 403, 'a web origin is refused');
    const withSecret = await ask('/api/extension-state', hub.authHeaders);
    assert.equal(withSecret.status, 200, 'with the secret the route answers');
    const leak = await ask('/api/extension-state', { origin: forged });
    assert.equal(leak.status, 200, 'RR-2: a request that only forges an extension Origin is answered without the secret');
    const leaked = JSON.parse(leak.text);
    assert.ok(typeof leaked.version === 'string' && 'workspace' in leaked && 'instanceId' in leaked, 'RR-2: the answer carries the version, the workspace and the instance id');
    assert.equal(leaked.proxyUrl, null, 'RR-2: proxyUrl is null, as the threat model says');
    assert.equal((await ask('/api/instructions', { origin: forged })).status, 410, 'RR-2: /api/instructions passes the gate and answers HTTP 410 in this build');
    assert.equal((await ask('/api/state', { origin: forged })).status, 403, 'RR-2 is limited to the two routes: any other route refuses the forged Origin');
    assert.equal((await ask('/api/state', { origin: forged, ...hub.authHeaders })).status, 403, 'even with the secret an extension Origin is refused on other routes');
    ok('RR-2 observed: the two extension routes answer a forged extension Origin without the secret (and only those: another route answers 403); no Origin gives 401, a web origin 403');

    const pairing = await ask('/api/browser/clients/pair', { 'content-type': 'application/json' }, 'POST', JSON.stringify({ code: '00000000', clientId: '3c2f9c78-436d-4b2e-bd8d-2e803d8695cf', extensionId: 'b'.repeat(32) }));
    assert.equal(pairing.status, 401);
    assert.equal(JSON.parse(pairing.text).code, 'invalid_pair_code', 'RR-3: the pairing route is reached without the Hub secret and without any Origin (the refusal comes from the code check)');
    ok('RR-3 observed: the pairing route is reachable without the Hub secret and without an Origin; only the pairing code stands in the way');

    // RR-4 is closed: the Node attach path compares the listener of the port with the session's process id before it sends anything.
    // The real squatter that shows it is in verify-hub-listener.mjs; here the wiring is pinned in the source and observed on this Hub.
    const hubSession = readFileSync(path.join(HUB, 'lib', 'hub-session.mjs'), 'utf8');
    const attach = hubSession.slice(hubSession.indexOf('export async function attachToRunningHub'));
    const firstRequest = attach.search(/\bfetch\(|requestTicket\(|bearerHeaders\(/);
    const checkAt = attach.indexOf('assertSessionListener(session');
    assert.ok(checkAt > 0 && firstRequest > checkAt, 'RR-4: attachToRunningHub must call assertSessionListener before the first fetch, header or ticket that carries the secret');
    assert.match(hubSession.slice(hubSession.indexOf('export async function assertSessionListener'), hubSession.indexOf('export async function attachToRunningHub')), /listener !== session\.pid/, 'RR-4: the check compares the listener with the session\'s process id');
    const callers = [['lib/launch.mjs', readFileSync(path.join(HUB, 'lib', 'launch.mjs'), 'utf8')], ['hub.mjs', readFileSync(path.join(HUB, 'hub.mjs'), 'utf8')]];
    for (const [name, source] of callers) {
      const calls = [...source.matchAll(/attachToRunningHub\(\{[^}]*\}\)/g)].map((match) => match[0]);
      assert.ok(calls.length >= 1 && calls.every((call) => !/listenerPid/.test(call)), `RR-4: ${name} calls attachToRunningHub with the real lookup (no injected listenerPid)`);
    }
    const launchSource = callers[0][1];
    assert.ok(launchSource.indexOf('assertSessionListener(session') > 0 && launchSource.indexOf('assertSessionListener(session') < launchSource.indexOf('requestTicket(url, session.secret)'), 'RR-4: launch checks the listener before it asks the Hub it just started for a ticket');
    const refused = await attachToRunningHub({ origin: hub.origin, stateDirectory: hub.stateDir, listenerPid: async () => hub.pid + 1 }).then(() => null, (error) => error);
    assert.equal(refused?.code, 'ERR_SESSION_LISTENER', 'RR-4: with another process as the listener, attaching to this live Hub is refused');
    const attached = await attachToRunningHub({ origin: hub.origin, stateDirectory: hub.stateDir });
    assert.equal(attached.session.pid, hub.pid, 'RR-4: with the real lookup the live Hub is attached to');
    assert.match(readFileSync(path.join(REPO, 'native-shared', 'HubSession.cs'), 'utf8'), /HubLifecycle\.ListenerPid\(port\) == session\.Pid/, 'the native clients do compare the listener with the session pid');
    // The PowerShell helper scripts read the same file. Each asks Windows who owns the listening socket of the port and compares that
    // process id with the session's before the first place that builds the Authorization header; the real squatter that shows what
    // that does is in verify-hub-listener-powershell.mjs, which also compares the three copies of the block.
    for (const script of ['Stop-ChatMcpHub.ps1', 'windows/Run-StudioSmoke.ps1', 'windows/Test-Gateway-ViaHub.ps1']) {
      const source = readFileSync(path.join(HUB, script), 'utf8').replace(/\r\n/g, '\n');
      assert.ok(source.includes('hub-session.json'), `RR-4: ${script} reads the session file`);
      assert.ok(/Get-NetTCPConnection -State Listen -LocalPort/.test(source) && /\$listener -ne \$SessionPid/.test(source), `RR-4: ${script} asks Windows who owns the listening socket of the port and compares it with the process id in the session file`);
      const checkAt = source.indexOf('Assert-HubSessionListener -SessionPid', source.indexOf('# END hub-listener-check'));
      const headerAt = [...source.matchAll(/'Bearer '/g)].map((match) => match.index);
      assert.ok(checkAt > 0 && headerAt.length >= 1 && headerAt.every((at) => at > checkAt), `RR-4: ${script} calls the listener check before every place that builds the Authorization header`);
    }
    ok('RR-4 observed: attachToRunningHub and launch check the listener process id before they send the secret (source and a live Hub), the callers use the real lookup, the native clients do the same; the three PowerShell helper scripts ask Windows who owns the listening socket before they build the Authorization header (source)');
  } finally {
    hub?.killTree();
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(liveScratch, { recursive: true, force: true });
  }
}

// ---- negative controls ---------------------------------------------------------------------------------------------------------------
const scratch = mkdtempSync(path.join(os.tmpdir(), 'chatmcp-threat-model-'));
try {
  for (const name of DOCUMENTS) {
    mkdirSync(path.dirname(path.join(scratch, name)), { recursive: true });
    writeFileSync(path.join(scratch, name), readFileSync(path.join(REPO, name)));
  }
  assert.deepEqual(checkThreatModel(scratch), [], 'the copy must be clean before a defect is put in');
  const mutate = (name, change) => {
    const file = path.join(scratch, name);
    const before = readFileSync(file, 'utf8');
    const after = change(before);
    assert.notEqual(after, before, `the mutation of ${name} changed nothing`);
    writeFileSync(file, after);
    return () => writeFileSync(file, before);
  };
  const model = 'docs/THREAT-MODEL.md';
  const mutations = [
    ['a symbol that does not exist', model, (text) => text.replace('| `createHubServer` |', '| `createHubServerOld` |'), /no symbol createHubServerOld/],
    ['a file that does not exist', model, (text) => text.replace('`CHATMCP-HUB/lib/sed-script.mjs`', '`CHATMCP-HUB/lib/sed-grammar.mjs`'), /sed-grammar\.mjs does not exist/],
    ['an identifier of the role column that does not exist', model, (text) => text.replace('`decideOutbound`', '`decideOutboundNow`'), /decideOutboundNow/],
    ['a wrong ticket lifetime', model, (text) => text.replace('60 second', '30 second'), /ticket lives 60 seconds/],
    ['a wrong pairing limit', model, (text) => text.replace('10 attempts', '3 attempts'), /allows 10 attempts/],
    ['a reference that is not in the table', model, (text) => text.replace('single-use ticket in a URL fragment [C9]', 'single-use ticket in a URL fragment [C99] [C9]'), /\[C99\]/],
    ['a table row nobody cites', model, (text) => text.replace(/\[C18\]/g, ''), /C18 is in the code reference table but no text cites it/],
    ['a test that does not exist', model, (text) => text.replace('`CHATMCP-HUB/tests/verify-readonly-corpus.mjs`', '`CHATMCP-HUB/tests/verify-readonly-nothing.mjs`'), /verify-readonly-nothing\.mjs does not exist/],
    ['a route missing from SECURITY.md', 'SECURITY.md', (text) => text.replaceAll('`/api/extension-state`', 'the extension state route'), /SECURITY\.md does not name \/api\/extension-state/],
    ['the same-user sentence removed from SECURITY.md', 'SECURITY.md', (text) => text.replace(/\*\*The secret protects against[\s\S]*?either\.\*\*/, ''), /SECURITY\.md does not state that the secret does not protect/],
    ['SECURITY.md back to Host, Origin and CSRF only', 'SECURITY.md', (text) => text.replace('Every `/api/*` and `/auth/*` request', 'The local HTTP interface validates Host and Origin and applies CSRF protection to mutations. Browser Companion pairing; every `/api/*` and `/auth/*` request'), /still describes only Host, Origin and CSRF|per-launch bearer/],
    ['the threat model link removed from SECURITY.md', 'SECURITY.md', (text) => text.replaceAll('(docs/THREAT-MODEL.md)', '(docs/ARCHITECTURE.md)'), /SECURITY\.md does not link docs\/THREAT-MODEL\.md/],
    ['the README no longer names the forged-origin exception', 'README.md', (text) => text.replace('browser-extension origin', 'extension'), /README\.md does not say that the Companion status routes/],
    ['a host missing from Surface 8', model, (text) => text.replaceAll('objects.githubusercontent.com', 'objects.example'), /Surface 8 does not state the host objects\.githubusercontent\.com/],
    ['a wrong interval in Surface 8', model, (text) => text.replace('then every 12 hours (1 hour after a failure)', 'then every 24 hours (1 hour after a failure)'), /Surface 8 does not state the interval/],
    ['a wrong size limit in Surface 8', model, (text) => text.replaceAll('64 KiB', '1 MiB'), /Surface 8 does not state the size limit/],
    ['a wrong floor in Surface 8', model, (text) => text.replaceAll('15 minutes of the last attempt', '5 minutes of the last attempt'), /Surface 8 does not state the floor between attempts/],
    ['the constant no longer named in Surface 8', model, (text) => text.replaceAll('`WHEN_UNANSWERED`', '`SOMETHING_ELSE`'), /Surface 8 does not state the constant/],
    ['the feed address changed in Surface 8', model, (text) => text.replaceAll('releases/latest/download/RELEASE-MANIFEST.json', 'releases/latest/download/MANIFEST.json'), /Surface 8 does not state the address of the feed/],
    ['a U row without a test', model, (text) => text.replace('`verify-update-check.mjs` (a hostile file, eight kinds of damaged file, a clock two days ahead, seven hours ahead and put back, a Hub that was updated since the file was written)', 'nothing'), /U4: the Test column/],
    ['a U row with an empty limit', model, (text) => text.replace('a program that can write the file can write anything in it (RR-1): the worst it can make the page show is a notice for a version at the project\'s GitHub |', ' |'), /U4: the Limit column is empty/],
    ['a code reference of the update notice to a symbol that does not exist', model, (text) => text.replace('| `fetchManifest` |', '| `fetchManifestOld` |'), /no symbol fetchManifestOld/],
    ['a code reference to a file that does not exist', model, (text) => text.replace('`CHATMCP-HUB/ui/src/lib/updates.ts`', '`CHATMCP-HUB/ui/src/lib/update-notice.ts`'), /update-notice\.ts does not exist/],
    ['a code reference of the update notice that no text cites', model, (text) => text.replaceAll('[C66]', ''), /C66 is in the code reference table but no text cites it/],
    ['Surface 8 removed', model, (text) => text.replace('## Surface 8: the notice that a newer release exists', '## Something else'), /has no Surface 8/],
    ['M1 back to "or any host"', model, (text) => text.replace('| M1 | The Hub contacts models.dev without the owner asking |', '| M1 | The Hub contacts models.dev, or any host, without the owner asking |'), /M1 still says "or any host"/],
    ['Surface 7 no longer naming the update check', model, (text) => text.replace('is the update check of Surface 8', 'is nothing else'), /Surface 7 still says that nothing but the owner's button/],
    ['SECURITY.md without the Update notice section', 'SECURITY.md', (text) => text.replace('## Update notice', '## Something else'), /SECURITY\.md has no "Update notice" section/],
    ['SECURITY.md no longer saying only after a yes', 'SECURITY.md', (text) => text.replace('**only after you have said yes**', '**always**'), /does not state that the Hub asks only after the owner has said yes/],
    ['SECURITY.md no longer saying that a download starts only from the click', 'SECURITY.md', (text) => text.replace('**A download starts only from your click on Download**', 'A download starts at once'), /does not state that a download starts only from the owner's click/],
    ['SECURITY.md no longer saying that nothing is installed or run', 'SECURITY.md', (text) => text.replace('**Nothing is installed, moved or run in this step**', 'Something is installed in this step'), /does not state that nothing is installed, moved or run/],
    ['SECURITY.md no longer saying that Download needs a valid signature', 'SECURITY.md', (text) => text.replace('**Only a release whose manifest has a valid signature is offered for download.**', 'A release is offered for download.'), /does not state that Download needs a valid signature/],
    ['SECURITY.md with another installer limit', 'SECURITY.md', (text) => text.replace('takes at most 2 GiB', 'takes at most 4 GiB'), /SECURITY\.md \(Update notice\) does not state the size limit of the installer/],
    ['SECURITY.md with another idle limit', 'SECURITY.md', (text) => text.replace('60 seconds without a byte', '90 seconds without a byte'), /SECURITY\.md \(Update notice\) does not state the idle limit of the download/],
    ['SECURITY.md without the key file', 'SECURITY.md', (text) => text.replaceAll('CHATMCP-HUB/lib/release-keys.json', 'the key file'), /SECURITY\.md \(Update notice\) does not state the key file/],
    ['SECURITY.md with another size for the signature file', 'SECURITY.md', (text) => text.replace('at most 4 KiB', 'at most 8 KiB'), /SECURITY\.md \(Update notice\) does not state the size limit of the signature file/],
    ['a wrong installer size limit in Surface 8', model, (text) => text.replaceAll('at most 2 GiB', 'at most 4 GiB'), /Surface 8 does not state the size limit of the installer/],
    ['a wrong idle limit in Surface 8', model, (text) => text.replaceAll('60 seconds without a byte', '120 seconds without a byte'), /Surface 8 does not state the idle limit of the download/],
    ['a wrong room on the disk in Surface 8', model, (text) => text.replaceAll('twice the installer\'s size free', 'the installer\'s size free'), /Surface 8 does not state the room needed on the disk/],
    ['a wrong size for the signature file in Surface 8', model, (text) => text.replaceAll('at most 4 KiB', 'at most 8 KiB'), /Surface 8 does not state the size limit of the signature file/],
    ['a wrong number of keys in Surface 8', model, (text) => text.replaceAll('at most 4;', 'at most 9;'), /Surface 8 does not state the number of keys/],
    ['the key file no longer named in Surface 8', model, (text) => text.replaceAll('CHATMCP-HUB/lib/release-keys.json', 'the key file'), /Surface 8 does not state the key file/],
    ['the algorithm no longer named in Surface 8', model, (text) => text.replaceAll('ECDSA over P-256 with SHA-256', 'a signature'), /Surface 8 does not state the algorithm of the signature/],
    ['the click no longer named in Surface 8', model, (text) => text.replaceAll('only from the owner\'s click on Download', 'on its own'), /Surface 8 does not state that a download starts only from the owner's click/],
    ['Surface 8 no longer saying that nothing is run', model, (text) => text.replaceAll('Nothing is installed, moved or run', 'Something is installed'), /Surface 8 does not state that nothing is installed, moved or run/],
    ['a download row without a test', model, (text) => text.replace('`verify-update-download.mjs` (other bytes of the same size, one bit, short and long bodies with and without a length, a connection that is reset, a stall, a disk that fills, a rename that the antivirus holds), `verify-e2e-update-download.mjs` (the whole file on a real Hub is the bytes that were served, and a cancel leaves nothing)', 'nothing'), /U9: the Test column/],
    ['a download row with an empty limit', model, (text) => text.replace('there is no total deadline (a slow connection that keeps sending may finish), no resume (a broken download starts again from the start) and no limit on how often the owner clicks |', ' |'), /U11: the Limit column is empty/],
    ['a download code reference to a symbol that does not exist', model, (text) => text.replace('| `installerNameProblem` |', '| `installerNameProblemOld` |'), /no symbol installerNameProblemOld/],
    ['a gate code reference to a symbol that does not exist', model, (text) => text.replace('| `verify_release_keys` |', '| `verify_release_keys_old` |'), /no symbol verify_release_keys_old/],
    ['a code reference of the download that no text cites', model, (text) => text.replaceAll('[C72]', ''), /C72 is in the code reference table but no text cites it/],
    ['a code reference of the signature that no text cites', model, (text) => text.replaceAll('[C68]', ''), /C68 is in the code reference table but no text cites it/],
    ['a download test that does not exist', model, (text) => text.replace('`CHATMCP-HUB/tests/verify-e2e-update-download.mjs`', '`CHATMCP-HUB/tests/verify-e2e-update-nothing.mjs`'), /verify-e2e-update-nothing\.mjs does not exist/],
    ['SECURITY.md with another deadline', 'SECURITY.md', (text) => text.replace('in 10 seconds', 'in 60 seconds'), /SECURITY\.md \(Update notice\) does not state the deadline/],
    ['SECURITY.md not pointing at Surface 8', 'SECURITY.md', (text) => text.replace('(Surface 8)', '(a section)'), /does not point at Surface 8/],
    ['the README no longer saying nothing is asked before an answer', 'README.md', (text) => text.replace('until you answer, the app makes no request of its own', 'the app asks'), /README\.md does not state that nothing is asked before the owner answers/],
    ['the README no longer saying that a download starts only on a click', 'README.md', (text) => text.replace('A download starts only when you click **Download**', 'A download starts by itself'), /README\.md does not state that a download starts only on the owner's click/],
    ['the README no longer saying that nothing is installed or run', 'README.md', (text) => text.replace('Nothing is installed or run in this version', 'Something is installed in this version'), /README\.md does not state that nothing is installed or run/],
    ['the README no longer saying that Download needs a signature that checks', 'README.md', (text) => text.replace('offers **Download** only for a release whose signature checks', 'offers **Download** for every release'), /README\.md does not state that Download needs a signature that checks/],
    ['the README no longer saying that the installer has no Authenticode signature', 'README.md', (text) => text.replace('it has no Authenticode signature', 'it is signed'), /README\.md does not state that the installer has no Authenticode signature/],
    ['the threat model no longer in the index', 'docs/INDEX.md', (text) => text.replace('(THREAT-MODEL.md)', '(ARCHITECTURE.md)'), /INDEX\.md does not link THREAT-MODEL\.md/],
    ['a threat row without a test', model, (text) => text.replace('comparison is exercised by `verify-hub-auth.mjs`; no timing measurement', 'nothing'), /H3: the Test column/],
    ['a hooks threat row without a test', model, (text) => text.replace('`verify-hooks-core.mjs` (inert until approved, a one-byte edit, a restart, the same bytes in another folder), `verify-hooks-guard.mjs` (the route on a real Hub, behind the bearer)', 'nothing'), /K1: the Test column/],
    ['a hooks symbol that does not exist', model, (text) => text.replace('| `HookRunner` |', '| `HookRunnerOld` |'), /no symbol HookRunnerOld/],
    ['a hooks test that does not exist', model, (text) => text.replace('`CHATMCP-HUB/tests/verify-hooks-guard.mjs`', '`CHATMCP-HUB/tests/verify-hooks-nothing.mjs`'), /verify-hooks-nothing\.mjs does not exist/],
    ['the best-effort statement removed from SECURITY.md', 'SECURITY.md', (text) => text.replaceAll('best effort', 'complete'), /best effort/],
    ['the Node launcher exception back in SECURITY.md', 'SECURITY.md', (text) => text.replace('Browser Companion pairing grants', 'The Node launcher does not check which process listens on the port. Browser Companion pairing grants'), /SECURITY\.md still says that the Node launcher does not check/],
    ['the PowerShell helper scripts no longer named in SECURITY.md', 'SECURITY.md', (text) => text.replaceAll('Stop-ChatMcpHub.ps1', 'the stop script'), /SECURITY\.md does not name Stop-ChatMcpHub\.ps1/],
    ['the launcher and script check no longer stated in the threat model', model, (text) => text.replace('the Node launcher and the PowerShell helper scripts present the secret only to the process that listens on the port', 'the Node launcher and the PowerShell helper scripts present the secret'), /docs\/THREAT-MODEL\.md \(H6\) does not say that the Node launcher and the PowerShell helper scripts present the secret only/],
    ['the launcher and script check no longer stated in HUB-AUTH.md', 'docs/HUB-AUTH.md', (text) => text.replace('present the secret only to the process that listens on the port (the file\'s `pid`)', 'present the secret (the file\'s `pid`)'), /docs\/HUB-AUTH\.md does not say that the Node launcher and the PowerShell helper scripts present the secret only/],
    ['the RR-4 row saying again that the launcher does not check', model, (text) => text.replace('A Hub from before the secret existed', 'The Node launcher does not check which process listens on the port. A Hub from before the secret existed'), /docs\/THREAT-MODEL\.md still says that the Node launcher does not check/],
    ['the RR-4 row open again for the PowerShell scripts', model, (text) => text.replace('A Hub from before the secret existed', '**Still open:** the PowerShell helper scripts look up no listener. A Hub from before the secret existed'), /docs\/THREAT-MODEL\.md still says that the PowerShell helper scripts do not look up/],
    ['the PowerShell exception back in SECURITY.md', 'SECURITY.md', (text) => text.replace('Browser Companion pairing grants', 'The PowerShell helper scripts of the launcher read the secret of the last launch without first checking which process listens on the port. Browser Companion pairing grants'), /SECURITY\.md still says that the PowerShell helper scripts do not look up/],
    ['HUB-AUTH.md saying again that the scripts do not look the listener up', 'docs/HUB-AUTH.md', (text) => text.replace('and first ask `Get-NetTCPConnection`', '**They do not yet look up which process listens on the port** and first ask `Get-NetTCPConnection`'), /docs\/HUB-AUTH\.md still says that the PowerShell helper scripts do not look up/],
    ['the SECURITY.md sentence on the scripts weakened', 'SECURITY.md', (text) => text.replace('presents the secret only to the process that listens on the port and is the one the file names, and sends nothing otherwise', 'presents the secret, and sends nothing otherwise'), /SECURITY\.md does not say that the PowerShell helper scripts present the secret only/],
    ['a script no longer named in the threat model', model, (text) => text.replaceAll('Test-Gateway-ViaHub.ps1', 'the gateway script'), /docs\/THREAT-MODEL\.md does not name Test-Gateway-ViaHub\.ps1/],
  ];
  for (const [label, name, change, expected] of mutations) {
    const restore = mutate(name, change);
    const found = checkThreatModel(scratch);
    restore();
    assert.ok(found.some((problem) => expected.test(problem)), `defect "${label}" was not reported; problems: ${JSON.stringify(found)}`);
  }
  const flipped = checkThreatModel(scratch, REPO, { WHEN_UNANSWERED: 'on' });
  assert.ok(flipped.some((problem) => /WHEN_UNANSWERED is not "ask"/.test(problem)), `a constant flipped to "on" must be reported: ${JSON.stringify(flipped)}`);
  ok(`${mutations.length} seeded defects in a temporary copy of the documents are each reported, and so is the constant of the update notice flipped to "on" while the documents still say "ask"`);
  assert.deepEqual(checkThreatModel(scratch), [], 'removing the defects must make the copy clean again');
  ok('the temporary copy is clean again once the defects are removed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`PASS: ${checks} threat model checks (code references, tests, numbers, cross-document limits)`);
