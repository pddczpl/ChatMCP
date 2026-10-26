// End-to-end scenario: the hand-over after an update through a REAL Hub process. tests/verify-update-applied.mjs holds the module to its promises; this suite looks at the Hub the page talks to:
// a result file that the installer left is found when the Hub starts, shown under `update.applied` in /api/state and /api/update/status until the page dismisses it, and gone from the disk
// the moment it was read (so a restart does not announce it again); a file about another version, or one that is not a result at all, is thrown away and shown to nobody; the one new route,
// POST /api/update/applied-dismiss, is behind every layer of the others and writes nothing; and a second Hub on the same data folder, which finds out that the folder is taken and stops, does not
// read (and so does not consume) a file that the first Hub should have.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { runScenario } from './e2e/harness.mjs';
import { HUB_ROOT, cleanEnvironment, freePort } from './e2e/hub-process.mjs';

const ROUTE = '/api/update/applied-dismiss';
const RUNNING = JSON.parse(fs.readFileSync(path.join(HUB_ROOT, 'package.json'), 'utf8')).version;
const [major, minor, patch] = RUNNING.split('.').map(Number);
const OLDER = `${major}.${minor}.${Math.max(0, patch - 1) === patch ? patch + 1 : Math.max(0, patch - 1)}`;
const NEWER = `${major}.${minor + 1}.0`;
const note = (over = {}) => ({ format: 1, ok: true, version: RUNNING, previous: `${major}.${Math.max(0, minor - 1)}.0`, state: 'installed', reason: null, rolledBack: false, ...over });
const failure = (over = {}) => note({ ok: false, version: NEWER, previous: RUNNING, state: 'unchanged', reason: 'tasks_running', ...over });

await runScenario({
  name: 'update-applied',
  summary: 'the hand-over after an update on a real Hub: a result file is found at start, shown until dismissed, consumed, thrown away when it is about another version or is not a result, and left alone by a second Hub',
  budgetMs: 120_000,
}, async (t) => {
  const stateWith = (name, content) => {
    const directory = path.join(t.scratch, name);
    fs.mkdirSync(directory, { recursive: true });
    if (content !== undefined) fs.writeFileSync(path.join(directory, 'update-result.json'), typeof content === 'string' ? content : JSON.stringify(content));
    return directory;
  };
  const fileOf = (directory) => path.join(directory, 'update-result.json');
  const appliedOf = async (hub) => (await hub.get('/api/update/status')).json.update.applied;
  // the feed is a closed port: this suite is about a file, and no test Hub may reach GitHub (the harness points every Hub at one)

  // ---- an update that went through -----------------------------------------------------------------------------------------------------------------
  const wentDir = stateWith('state-went', note());
  let hub = await t.hub({ stateDir: wentDir });
  const expected = { ok: true, version: RUNNING, previous: note().previous, state: 'installed', reason: null, rolledBack: false };
  t.equal(await appliedOf(hub), expected, 'a Hub that starts after an update says so under update.applied (/api/update/status)');
  t.equal((await hub.state()).update.applied, expected, 'and /api/state says the same');
  t.check(!fs.existsSync(fileOf(wentDir)), 'the file was consumed when it was read');
  t.equal(JSON.stringify(Object.keys((await hub.state()).update.applied).sort()), JSON.stringify(['ok', 'previous', 'reason', 'rolledBack', 'state', 'version']), 'and what the page is given is those six fields and nothing from the file beyond them');

  // ---- the one new route ---------------------------------------------------------------------------------------------------------------------------
  const declared = (await hub.get('/api/capabilities')).json.postRoutes;
  t.check(declared.includes(ROUTE), 'the route is declared in /api/capabilities');
  const csrf = await hub.csrfToken();
  const page = { origin: hub.origin, 'x-chatmcp-request': 'local-dashboard', 'x-chatmcp-csrf': csrf, 'content-type': 'application/json', ...hub.authHeaders };
  const send = (headers, body) => hub.rawRequest({ method: 'POST', route: ROUTE, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const without = (name) => Object.fromEntries(Object.entries(page).filter(([key]) => key !== name));
  t.equal((await send(without('authorization'), {})).status, 401, 'no bearer: 401');
  t.equal((await send(without('x-chatmcp-csrf'), {})).status, 403, 'no CSRF token: 403');
  t.equal((await send({ ...page, 'x-chatmcp-csrf': 'f'.repeat(64) }, {})).status, 403, 'a wrong CSRF token: 403');
  t.equal((await send(without('x-chatmcp-request'), {})).status, 403, 'no page marker: 403');
  t.equal((await send(without('origin'), {})).status, 403, 'no Origin: 403');
  t.equal((await send({ ...page, origin: 'http://evil.example' }, {})).status, 403, 'another origin: 403');
  t.equal((await send({ ...page, 'content-type': 'text/plain' }, {})).status, 415, 'not JSON: 415');
  t.equal((await hub.rawRequest({ method: 'GET', route: ROUTE, headers: hub.authHeaders })).status, 404, 'a GET is not a route');
  t.equal(await appliedOf(hub), expected, 'none of that cleared the note');
  const dismissed = await hub.request('POST', ROUTE, {});
  t.equal([dismissed.status, dismissed.json.update.applied], [200, null], 'the owner dismisses it: 200, and update.applied is null');
  t.equal([await appliedOf(hub), (await hub.state()).update.applied], [null, null], 'in both places');
  t.equal((await hub.request('POST', ROUTE, { version: '9.9.9', anything: true })).json.update.applied, null, 'a second dismissal, with anything in the body, does the same: nothing in the body is read');
  t.equal(fs.readdirSync(wentDir).filter((name) => /result/.test(name)), [], 'and the route wrote no file');
  await hub.stop();

  // ---- a restart does not announce it again ---------------------------------------------------------------------------------------------------------
  hub = await t.hub({ stateDir: wentDir });
  t.equal(await appliedOf(hub), null, 'after a restart the update is not announced again: the file went when it was read');
  await hub.stop();

  // ---- an update that did not go through ----------------------------------------------------------------------------------------------------------
  const refusedDir = stateWith('state-refused', failure());
  hub = await t.hub({ stateDir: refusedDir });
  t.equal(await appliedOf(hub), { ok: false, version: NEWER, previous: RUNNING, state: 'unchanged', reason: 'tasks_running', rolledBack: false }, 'a refused update is told in the old version, with its reason as a code');
  t.check(!fs.existsSync(fileOf(refusedDir)), 'and its file was consumed as well');
  await hub.stop();

  // ---- files that are about another time, or are not a result -------------------------------------------------------------------------------------------
  const strange = [
    ['an update to a version that is not the one that runs', note({ version: OLDER, previous: null })],
    ['a failure that is about an update from another version', failure({ previous: OLDER })],
    ['a failure about a version that is not newer', failure({ version: RUNNING })],
    ['text that is not JSON', 'the update went well'],
    ['a result of a format this Hub does not know', note({ format: 2 })],
    ['a result that contradicts itself', note({ state: 'unchanged' })],
    ['a file over 4 KiB', JSON.stringify({ ...note(), padding: 'x'.repeat(5000) })],
  ];
  for (const [label, content] of strange) {
    const directory = stateWith(`state-${label.replace(/\W+/g, '-')}`, content);
    const other = await t.hub({ stateDir: directory });
    t.equal(await appliedOf(other), null, `${label}: nothing is shown`);
    t.check(!fs.existsSync(fileOf(directory)), `${label}: and the file is gone`);
    await other.stop();
  }
  {
    const directory = stateWith('state-text-reason', failure({ reason: 'C:\\Users\\Test User\\secret\\log.txt' }));
    const other = await t.hub({ stateDir: directory });
    const applied = await appliedOf(other);
    t.equal([applied.reason, JSON.stringify(applied).includes('Test User')], ['install_failed', false], 'a reason that is a path is shown as a failure to install, and the path is nowhere in what the page is given');
    await other.stop();
  }

  // ---- a second Hub on the same data folder does not read the first one's file -------------------------------------------------------------------------
  {
    const sharedDir = stateWith('state-shared');
    const owner = await t.hub({ stateDir: sharedDir });
    fs.writeFileSync(fileOf(sharedDir), JSON.stringify(note()));
    const second = spawn(process.execPath, [path.join(HUB_ROOT, 'hub.mjs'), '--backend', 'local', '--port', String(await freePort()), '--state-dir', sharedDir, '--no-open'], {
      cwd: HUB_ROOT, env: cleanEnvironment(t.scratch, { CHATMCP_HUB_SECRET: randomBytes(32).toString('hex') }), stdio: 'ignore', windowsHide: true,
    });
    await new Promise((resolve) => { const timer = setTimeout(() => { second.kill(); resolve(); }, 15_000); second.on('close', () => { clearTimeout(timer); resolve(); }); });
    t.check(fs.existsSync(fileOf(sharedDir)), 'a second start of the launcher on the same data folder finds that it is taken and stops WITHOUT reading the file: only the Hub that holds the folder consumes it');
    await owner.stop();
  }

  // ---- what the Hub is not ------------------------------------------------------------------------------------------------------------------------
  const hubSource = fs.readFileSync(path.join(HUB_ROOT, 'hub.mjs'), 'utf8');
  const lock = hubSource.indexOf('releaseInstance = await acquireInstanceLock');
  const read = hubSource.indexOf('await applied.load()');
  t.check(lock > 0 && read > lock, 'the file is read after this process holds the instance lock, in the source as well');
  const dismissCase = hubSource.split('\n').filter((line) => line.includes(`case '${ROUTE}'`)).join('\n');
  t.check(dismissCase.length > 0 && !/requireNoTask|activeTaskId|writeFile|unlink|spawn|fetch/.test(dismissCase), 'and the route reads no body, asks no task, writes no file and starts nothing');
});
