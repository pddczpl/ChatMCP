#!/usr/bin/env node
// A rehearsal of the page-driving half of the end-to-end proof of the in-app updater, on any machine, WITHOUT the desktop shell and WITHOUT installing anything:
//
//     node scripts/tests/updater-e2e/rehearse-page.mjs [--keep] [--evidence <folder>] [--webview2 [--policy]]
//
// With --webview2 the window is a REAL WebView2 (a small stand-in for the shell, scripts/tests/updater-e2e/WebView2Host, built here with dotnet), reached through a debugging port; with --policy (the CI job,
// a Windows account that may write HKLM) the port is opened the way the job opens it for the installed shell, by the WebView2 policy for the program, so that the same mechanism is tried in seconds before
// 10 minutes of builds. --policy writes a machine-wide setting, so it refuses (exit code 2, before it makes anything) anywhere but a GitHub-hosted Windows runner. With --evidence <folder> a failure leaves
// its screenshot, the tail of the Hub's log and the error there (the CI job uploads the folder).
//
// It starts the Hub of this work tree on a free port (never 3007), a stand-in for GitHub on another one, makes a throwaway key with scripts/new-release-key.mjs, signs a manifest for a stand-in
// installer with scripts/sign-release.mjs, opens the Studio in a Chromium-based browser (Edge or Playwright's Chromium, headless) with a debugging port, and drives it with lib/page-driver.mjs the way
// run.mjs drives the installed shell: answer the question, Check now, Download, Install and restart, the confirmation. The one thing that is pretended is the shell: a window.chrome.webview put in front
// of the page that answers the apply-update message with the code a script gives it (the real shell answers with the same words: native-shared/PageMessage.cs). So this proves the driver, the selectors
// and the way the Hub's state, the staged files and the page agree, and it cannot prove the shell, the installer or WebView2: those are the CI job's.
//
// It is also the place where the facts the job relies on are checked once, cheaply: a download of the Hub stays "ready" when a byte of the staged installer is changed (the Hub hashes once, when the
// file arrives, so the tamper of the job is seen by the shell and not by the Hub), and the presses are TRUSTED clicks.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHub } from '../../../CHATMCP-HUB/tests/e2e/hub-process.mjs';
import { startUpdateFeed, feedManifest } from '../../../CHATMCP-HUB/tests/e2e/update-feed-server.mjs';
import { startMockModel } from '../../../CHATMCP-HUB/tests/e2e/mock-model-server.mjs';
import { dashboardUrl, requestTicket } from '../../../CHATMCP-HUB/lib/hub-session.mjs';
import { buildReleaseManifest, flipByte, makeTestKeys, signWithTool } from './release-files.mjs';
import { connectPage, sleep } from './lib/cdp.mjs';
import { PageDriver } from './lib/page-driver.mjs';
import { HubClient } from './lib/hub-client.mjs';
import { assertHostedRunnerEnvironment, clearDebugPolicy, killTree, setDebugPolicy } from './lib/windows.mjs';
import { startRunningWork } from './lib/work.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB_ROOT = path.resolve(HERE, '..', '..', '..', 'CHATMCP-HUB');
const keep = process.argv.includes('--keep');
const evidenceIndex = process.argv.indexOf('--evidence');
const evidenceFolder = evidenceIndex > 0 ? process.argv[evidenceIndex + 1] : null;
if (evidenceIndex > 0 && !evidenceFolder) { console.error('--evidence needs a folder'); process.exit(2); }
// --webview2: the window is a REAL WebView2 (scripts/tests/updater-e2e/WebView2Host, a stand-in for the shell that is built here), reached through a debugging port, as the installed shell is in the job;
// --policy (Windows, an account that may write HKLM): the port is opened the way the job opens it for the installed shell, by the WebView2 policy of the host's program name, which a newer WebView2
// honours for an elevated account where it ignores the environment variable. Without --webview2 the window is a headless Edge or Chromium and the shell is a script in the page.
const webview2 = process.argv.includes('--webview2');
const policy = process.argv.includes('--policy');
if (policy && !webview2) { console.error('--policy goes with --webview2'); process.exit(2); }
// the one thing here that changes the machine: a policy of HKLM. It is for a GitHub-hosted runner, before a folder is made or a program is started.
if (policy) {
  try { assertHostedRunnerEnvironment(); } catch (error) { console.error(error.message); process.exit(2); }
}
const HOST_PROGRAM = 'WebView2Host.exe';
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${line}`);
let failures = 0;
const check = (condition, label) => {
  if (!condition) { failures += 1; console.log(`  FAIL - ${label}`); throw new Error(`Rehearsal check failed: ${label}`); }
  console.log(`  ok - ${label}`);
};

/** Rejects when the program could not be started at all (a missing file, a refusal of the system): the wait for its window would otherwise run to its end for nothing. */
const neverStarted = (child, label) => new Promise((_, reject) => child.once('error', (error) => reject(new Error(`${label} could not be started: ${error.message}`))));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** A Chromium-based browser that can run headless with a debugging port: CHATMCP_REHEARSAL_BROWSER, Edge, or the Chromium of Playwright. */
function findBrowser() {
  const candidates = [process.env.CHATMCP_REHEARSAL_BROWSER, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const root of [path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')]) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).filter((entry) => /^chromium-\d+$/.test(entry))) {
      for (const inner of ['chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe', 'chrome-linux/chrome']) candidates.push(path.join(root, name, ...inner.split(/[\\/]/)));
    }
  }
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error('No Chromium-based browser found: set CHATMCP_REHEARSAL_BROWSER to the path of one.');
  return found;
}

/** The desktop shell, pretended: what the page needs of window.chrome.webview, and an answer to the apply-update message from a script (window.__pretend.script, in order; `launched` when it is empty). */
const PRETEND_SHELL = `(() => {
  if (window.chrome && window.chrome.webview) return;
  const listeners = new Set();
  window.__pretend = { received: [], script: [] };
  const webview = {
    postMessage(message) {
      window.__pretend.received.push(JSON.parse(JSON.stringify(message)));
      if (!message || message.type !== 'chatmcp.apply-update') return;
      const code = window.__pretend.script.length ? window.__pretend.script.shift() : 'launched';
      setTimeout(() => { const data = { type: 'chatmcp.update-result', id: message.id, ok: code === 'launched', code }; for (const listener of [...listeners]) listener({ data }); }, 30);
    },
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { listeners.delete(listener); },
  };
  window.chrome = window.chrome || {};
  window.chrome.webview = webview;
})();`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-updater-rehearsal-'));
let hub = null;
let feed = null;
let browser = null;
let cdp = null;
let mock = null;
let policySet = false;
try {
  // ---- what the proof makes: a key, a manifest, a signature, a stand-in installer ---------------------------------------------------------------
  const keys = await makeTestKeys(path.join(scratch, 'keys'));
  const runVersion = JSON.parse(fs.readFileSync(path.join(HUB_ROOT, 'package.json'), 'utf8')).version;
  const [major, minor, patch] = runVersion.split('.').map(Number);
  const offered = `${major}.${minor}.${patch + 2}`;
  const installerBytes = randomBytes(3 * 1024 * 1024);
  const installerFile = path.join(scratch, 'DatGoldSetup.exe');
  fs.writeFileSync(installerFile, installerBytes);
  const manifest = buildReleaseManifest({ version: offered, commit: createHash('sha1').update('rehearsal').digest('hex'), installer: { name: 'DatGoldSetup.exe', bytes: installerBytes.length, sha256: createHash('sha256').update(installerBytes).digest('hex') } });
  const manifestFile = path.join(scratch, 'RELEASE-MANIFEST.json');
  fs.writeFileSync(manifestFile, manifest);
  const signed = await signWithTool({ tag: `v${offered}`, keyFile: keys.run.keyFile, keysFile: keys.run.listFile, manifestFile, installerFile, outDirectory: path.join(scratch, 'signature') });
  log(`the Hub runs ${runVersion}; the release on offer is ${offered}, signed by key ${keys.run.kid}`);

  feed = await startUpdateFeed({ manifest: feedManifest({ version: offered }) });
  feed.publish(feedManifest({ version: offered }), { raw: manifest });
  feed.signature.set(signed.bytes);
  feed.signature.mode('chain');
  feed.installer.set({ name: 'DatGoldSetup.exe', bytes: installerBytes });
  const spki = JSON.parse(fs.readFileSync(keys.run.listFile, 'utf8')).keys[0].spki;

  // ---- the Hub of this work tree, on a free port, reading the stand-in ----------------------------------------------------------------------------
  hub = await startHub({ scratch: path.join(scratch, 'hub'), env: { CHATMCP_UPDATE_FEED_URL: feed.url, CHATMCP_UPDATE_FIRST_CHECK_MS: '300', CHATMCP_UPDATE_TEST_KEY: spki } });
  check(hub.port !== 3007, `the Hub is on port ${hub.port}, not 3007`);
  log(`Hub on ${hub.origin}, stand-in on ${feed.origin}`);

  // ---- a window with a debugging port, and the shell pretended ---------------------------------------------------------------------------------------
  const debugPort = await freePort();
  const profile = path.join(scratch, 'profile');
  const session = await hub.session();
  const address = dashboardUrl(hub.origin, await requestTicket(hub.origin, session.secret));
  let driver;
  // what the pretended shell has been told to answer and what it has been sent, the same two things in either kind of window
  let shell;
  if (webview2) {
    const hostOutput = path.join(scratch, 'host');
    const built = spawnSync('dotnet', ['build', path.join(HERE, 'WebView2Host', 'WebView2Host.csproj'), '-c', 'Release', '-o', hostOutput, '--nologo', '-v', 'q'], { encoding: 'utf8', timeout: 300_000, windowsHide: true });
    if (built.status !== 0) throw new Error(`The WebView2 host did not build:\n${String(built.stdout).slice(-1500)}${String(built.stderr).slice(-500)}`);
    const replies = path.join(scratch, 'replies.txt');
    const receivedFile = path.join(scratch, 'received.jsonl');
    fs.writeFileSync(replies, '');
    fs.writeFileSync(receivedFile, '');
    if (policy) {
      setDebugPolicy(debugPort, HOST_PROGRAM);
      policySet = true;
      log(`WebView2 policy: ${HOST_PROGRAM} gets --remote-debugging-port=${debugPort}`);
    }
    browser = spawn(path.join(hostOutput, HOST_PROGRAM), [address, profile, replies, receivedFile], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` }, stdio: 'ignore' });
    log(`WebView2 host pid ${browser.pid} with debugging port ${debugPort}`);
    cdp = await Promise.race([connectPage({ port: debugPort, match: (url) => url.startsWith(`${hub.origin}/`), timeoutMs: 120_000, label: 'the WebView2 window of the host' }), neverStarted(browser, 'the WebView2 host')]);
    driver = new PageDriver(cdp, { log });
    shell = {
      pushReply: async (...codes) => { fs.appendFileSync(replies, `${codes.join('\n')}\n`); },
      received: async () => fs.readFileSync(receivedFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    };
  } else {
    const exe = findBrowser();
    browser = spawn(exe, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), '--window-size=1366,850', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    log(`browser ${path.basename(exe)} with debugging port ${debugPort}`);
    cdp = await Promise.race([connectPage({ port: debugPort, match: () => true, timeoutMs: 30_000, label: 'the browser' }), neverStarted(browser, 'the browser')]);
    driver = new PageDriver(cdp, { log });
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PRETEND_SHELL });
    await cdp.send('Page.navigate', { url: address });
    shell = {
      pushReply: (...codes) => driver.evaluate(`window.__pretend.script.push(...${JSON.stringify(codes)}); true`),
      received: () => driver.evaluate('window.__pretend.received'),
    };
  }
  const page = await driver.prepare({ language: 'en' });
  check(page.shell === true && page.language === 'en' && page.address === hub.origin, `the Studio is open in English in ${webview2 ? 'a real WebView2 window' : 'a headless browser'}, the shell is ${webview2 ? 'a stand-in host' : 'pretended'}, the page has its Hub session`);
  await driver.recordShellMessages();

  // ---- the question, Check now, Download -----------------------------------------------------------------------------------------------------
  await driver.waitForVisible('update-question', { label: 'the question about automatic checks' });
  check(feed.requests.length === 0, 'the Hub has made no request while the question is unanswered');
  await driver.pressTestId('update-no');
  await driver.waitForGone('update-question');
  await driver.openSettings('Updates');
  await driver.waitForVisible('updates-check');
  await driver.pressTestId('updates-check');
  await driver.waitFor(`document.querySelector('[data-testid="updates-latest"]')?.innerText.includes(${JSON.stringify(offered)})`, { label: 'Settings to show the release on offer' });
  check(feed.checks() === 1, 'one look at the stand-in, because Check now was pressed');
  await driver.closeSettings();
  await driver.waitForVisible('update-notice');
  await driver.waitForVisible('update-download');
  check(!(await driver.isDisabled('update-download')), 'Download is offered (the signature is valid: the key list of the run signed it)');
  await driver.pressTestId('update-download');
  await driver.waitForVisible('update-download-ready', { timeoutMs: 60_000 });
  await driver.waitForVisible('update-apply');
  const staged = path.join(hub.stateDir, 'updates', offered);
  check(fs.readFileSync(path.join(staged, 'DatGoldSetup.exe')).equals(installerBytes), 'the Hub staged exactly the installer that was served');
  check(fs.readFileSync(path.join(staged, 'RELEASE-MANIFEST.json')).equals(manifest), 'and the manifest, byte for byte (byte order mark and CRLF included)');
  check(fs.readFileSync(path.join(staged, 'RELEASE-MANIFEST.json.sig')).equals(signed.bytes), 'and the signature made by the owner\'s tool');
  check(fs.existsSync(path.join(staged, 'state.json')), 'and its state file');

  // ---- Install and restart: ask, think again, confirm; the pretended shell refuses, then accepts -------------------------------------------------------
  await driver.pressTestId('update-apply');
  await driver.waitForVisible('update-apply-confirm');
  await driver.pressTestId('update-apply-no');
  await driver.waitForGone('update-apply-confirm');
  check((await shell.received()).length === 0, 'Not now sent nothing to the shell');
  await shell.pushReply('bad_installer');
  await driver.pressTestId('update-apply');
  await driver.waitForVisible('update-apply-confirm');
  await driver.pressTestId('update-apply-yes');
  await driver.waitForVisible('update-apply-error');
  const received = await shell.received();
  check(received.length === 1 && received[0].type === 'chatmcp.apply-update' && /^[a-f0-9-]{16,64}$/i.test(received[0].id) && Object.keys(received[0]).sort().join() === 'id,type', 'the page sent ONE message to the shell: its type and an id, nothing else');
  await driver.waitForVisible('update-apply-again');
  await driver.pressTestId('update-apply-again');
  await driver.waitForVisible('update-download-ready', { timeoutMs: 60_000 });
  check(feed.installer.hits() >= 2, 'Download again fetched the installer anew (two requests for it now)');

  // ---- work that is running holds the button back in the page, and a press on it does nothing ------------------------------------------------------------
  const client = new HubClient({ origin: hub.origin, stateDirectory: hub.stateDir });
  const workspace = path.join(scratch, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# rehearsal\n');
  mock = await startMockModel({ scenario: 'canned-answer' });
  const work = await startRunningWork({ hub: client, mock, workspace });
  await driver.waitForVisible('update-apply-blocked', { timeoutMs: 30_000 });
  check(await driver.isDisabled('update-apply'), 'a task that is running disables Install and restart in the page, with its reason beside it');
  const sentBefore = (await shell.received()).length;
  await driver.pressDisabled('update-apply');
  await sleep(300);
  check((await shell.received()).length === sentBefore && (await driver.count('update-apply-confirm')) === 0, 'and a press on the disabled button asks nothing and sends nothing');
  await work.release();
  await driver.waitForGone('update-apply-blocked', { timeoutMs: 30_000 });
  check(!(await driver.isDisabled('update-apply')), 'the button is back when the work is over');

  await shell.pushReply('launched');
  await driver.pressTestId('update-apply');
  await driver.waitForVisible('update-apply-confirm');
  await driver.pressTestId('update-apply-yes');
  await driver.waitForVisible('update-apply-sending');
  check((await shell.received()).length === 2, 'and the second message is the next click, not a repeat');

  // ---- messages posted by script, which the page itself never sends -----------------------------------------------------------------------------------
  await shell.pushReply('busy', 'tasks_running');
  const ids = await driver.postApplyRequests(2);
  const answers = [await driver.shellAnswer(ids[0]), await driver.shellAnswer(ids[1])];
  check(answers[0].code === 'busy' && answers[1].code === 'tasks_running' && ids[0] !== ids[1], 'two requests posted by script in one go are two messages with two ids, and each gets its own answer');

  // ---- the Hub says ready after a byte of the staged installer was changed ----------------------------------------------------------------------------
  const stagedInstaller = path.join(staged, 'DatGoldSetup.exe');
  flipByte(stagedInstaller, 4096);
  await sleep(4000);
  const afterTamper = (await hub.state()).update.download;
  check(afterTamper?.state === 'ready', 'the Hub still says ready after a byte of the staged installer was changed (it hashes once, when the file arrives: the shell is the one that looks again)');
  flipByte(stagedInstaller, 4096);
  check(fs.readFileSync(stagedInstaller).equals(installerBytes), 'and turned again the staged installer is the one that was served');
  console.log('\nREHEARSAL PASSED');
} catch (error) {
  failures += 1;
  console.error(`\nREHEARSAL FAILED: ${error?.stack ?? error}`);
  if (cdp?.open) {
    try { await new PageDriver(cdp).screenshot(path.join(scratch, 'failure.png')); console.error(`(a screenshot of the page: ${path.join(scratch, 'failure.png')})`); } catch { /* best effort */ }
  }
  if (hub) console.error(hub.logTail());
  // what the CI job uploads for a red rehearsal: the error, the Hub's log and the picture of the window, without the machine
  if (evidenceFolder) {
    try {
      fs.mkdirSync(evidenceFolder, { recursive: true });
      fs.writeFileSync(path.join(evidenceFolder, 'rehearsal-error.txt'), `${error?.stack ?? error}\n`);
      if (hub) fs.writeFileSync(path.join(evidenceFolder, 'rehearsal-hub-log.txt'), `${hub.logTail()}\n`);
      if (fs.existsSync(path.join(scratch, 'failure.png'))) fs.copyFileSync(path.join(scratch, 'failure.png'), path.join(evidenceFolder, 'rehearsal-failure.png'));
    } catch { /* best effort */ }
  }
} finally {
  cdp?.close();
  if (browser && browser.exitCode === null) {
    if (process.platform === 'win32') killTree(browser.pid); else browser.kill('SIGKILL');
  }
  await hub?.stop().catch(() => {});
  if (policySet) clearDebugPolicy(HOST_PROGRAM);
  await mock?.close().catch(() => {});
  await feed?.close().catch(() => {});
  if (!keep && failures === 0) await sleep(500).then(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  else console.error(`(files kept in ${scratch})`);
}
process.exit(failures === 0 ? 0 : 1);
