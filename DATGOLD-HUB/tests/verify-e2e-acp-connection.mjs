// How the ACP agent finds, starts and loses a Hub, with real processes (plan task ux-19). The other half of the process tests is tests/verify-e2e-acp-lifecycle.mjs (the agent itself as a process).
//
//   9. launchOwned itself: a Hub that does not come up in time, one that exits, a port that is held, one that cannot start (its log says why), a second start on a port a Hub holds. A failure leaves no process behind.
//  10. What the agent says when it cannot use the Hub it finds: no session file, a session file of another port, a secret the Hub does not take, a Hub of an old version.
//  11. The program: whatever else writes to stdout is sent to stderr, an unhandled rejection is logged and survived, an uncaught error ends the agent in order (exit code 1), bad settings end it with code 2.
//  12. connectToHub with a Hub that is a script (a seam for tests that the command line cannot reach): what a failure leaves behind, a Hub that does not stop when asked (it is killed after ten seconds),
//      a Hub that is still loading, one that dies while loading, one that fails its first request, one that repeats its secret in an error, a process that ends without stopping its Hub.
//  13. The Hub the agent started is killed while the agent runs: the agent still ends in order.
//  Port 3007 is never used (every port here is random).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { HUB_ROOT, cleanEnvironment, freePort, sleep } from './e2e/hub-process.mjs';
import { runScenario, eventually } from './e2e/harness.mjs';
import { createSquatterHarness } from './e2e/squatter-harness.mjs';
import { makeCalcProject } from './e2e/fixtures.mjs';
import { readSession } from '../lib/hub-session.mjs';
import { connectToHub } from '../lib/acp/hub-client.mjs';
import { launchOwned } from '../lib/launch.mjs';
import { stopOwned } from '../lib/runtime.mjs';
import { killOnly, startRawAdapter } from './support/acp-adapter.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const healthOf = (port) => fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }).then((response) => response.json()).catch(() => null);
const line = (message) => `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`;

await runScenario({
  name: 'acp-connection',
  summary: 'how the agent finds, starts and loses a Hub: launchOwned, the refusals, the program, a Hub that is a script, a Hub that is killed',
  budgetMs: 175_000,
}, async (t) => {
  const project = t.dir('project');
  makeCalcProject(project);
  const gone = (pid, label) => eventually(() => !alive(pid), { timeoutMs: 25_000, label: `process ${pid} (${label}) to be gone` });
  const closed = (port) => eventually(async () => (await healthOf(port)) === null, { timeoutMs: 25_000, label: `port ${port} to close` });
  const startOwned = async (name) => {
    const hub = { port: await freePort(), stateDir: t.dir(name) };
    const adapter = startRawAdapter({ scratch: t.scratch, hub, start: true });
    t.own(() => adapter.kill());
    await adapter.write(line({ id: 1, method: 'initialize', params: { protocolVersion: 1 } }));
    await adapter.waitFor((m) => m.id === 1 && m.result, { label: 'initialize' });
    await adapter.write(line({ id: 2, method: 'session/new', params: { cwd: project, mcpServers: [] } }));
    const created = await adapter.waitFor((m) => m.id === 2, { timeoutMs: 60_000, label: 'session/new on a Hub the agent starts' });
    t.must(created.result?.sessionId, `session/new works on the Hub the agent started (${name})`, JSON.stringify(created));
    const session = await readSession(hub.stateDir);
    t.must(session && alive(session.pid), `the Hub of ${name} is running and has published its session`);
    return { hub, adapter, session };
  };
  // A Hub that is running and that the agent only attaches to.
  const hub5 = await t.hub({ project });

  // ---- 9. launchOwned itself: a Hub that does not come up, one that exits, a port that is held -----------------------------------------------------------------
  {
    const never = path.join(t.scratch, 'never-serves.mjs');
    fs.writeFileSync(never, "import fs from 'node:fs';\nconst at = process.argv.indexOf('--state-dir');\nfs.writeFileSync(`${process.argv[at + 1]}/never.pid`, String(process.pid));\nsetInterval(() => {}, 1000);\n");
    const quits = path.join(t.scratch, 'exits-at-once.mjs');
    fs.writeFileSync(quits, 'process.exit(3);\n');
    const folder = t.dir('never-state');
    const began = Date.now();
    await launchOwned(['--backend', 'local', '--port', String(await freePort()), '--state-dir', folder, '--no-open'], { env: cleanEnvironment(t.scratch), timeoutMs: 1500, hubEntry: never }).then(
      () => t.check(false, 'a Hub that never comes up is reported'),
      (error) => t.check(/did not start within 1\.5 s/.test(error.message) && Date.now() - began < 25_000, 'a Hub that does not come up within the time is reported with the time, and the wait is that long and no longer', error.message));
    const neverPid = Number(fs.readFileSync(path.join(folder, 'never.pid'), 'utf8'));
    await gone(neverPid, 'the Hub that never came up');
    t.check(!alive(neverPid), 'and the process that never came up is stopped: a failure leaves no Hub behind');
    // The same Hub when stopping it returns only after it has exited, which is what a signal does on Linux and macOS (the first CI run on Ubuntu found it): it did not come up in time, and it did not exit by itself.
    await launchOwned(['--backend', 'local', '--port', String(await freePort()), '--state-dir', t.dir('never-state-slow-stop'), '--no-open'], { env: cleanEnvironment(t.scratch), timeoutMs: 1500, hubEntry: never, stop: async (child) => { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)); } }).then(
      () => t.check(false, 'a Hub that never comes up is reported, also when the stop returns after its exit'),
      (error) => t.check(/did not start within 1\.5 s/.test(error.message) && !/it exited/.test(error.message), 'a Hub that did not come up in time is told as that even when stopping it returns only after it has exited (Linux, macOS), and not as a Hub that exited by itself', error.message));
    const quitBegan = Date.now();
    await launchOwned(['--backend', 'local', '--port', String(await freePort()), '--state-dir', t.dir('quits-state'), '--no-open'], { env: cleanEnvironment(t.scratch), timeoutMs: 20_000, hubEntry: quits }).then(
      () => t.check(false, 'a Hub that exits is reported'),
      (error) => t.check(/did not start \(it exited\)/.test(error.message) && Date.now() - quitBegan < 12_000, `a Hub that exits at once is reported as exited, without waiting for the 20 s that were allowed (took ${Date.now() - quitBegan} ms)`, error.message));
    const held = net.createServer((socket) => socket.on('error', () => {}));
    await new Promise((resolve) => held.listen(0, '127.0.0.1', resolve));
    t.own(() => held.close());
    await launchOwned(['--backend', 'local', '--port', String(held.address().port), '--state-dir', t.dir('held-state'), '--no-open'], { env: cleanEnvironment(t.scratch) }).then(
      () => t.check(false, 'a held port is reported'),
      (error) => t.check(/Port \d+ is used by another program\. It is not stopped\./.test(error.message), 'launchOwned never starts a Hub on a port that something holds', error.message));
    // The log of the Hub: one that grew past 4 MB is kept as hub.previous.log and a new one begins; 4 MB exactly is left alone.
    for (const [size, rotated] of [[4_000_001, true], [4_000_000, false]]) {
      const stateDir = t.dir(`rotation-${size}`);
      fs.writeFileSync(path.join(stateDir, 'hub.log'), Buffer.alloc(size, 0x61));
      await launchOwned(['--backend', 'local', '--port', String(await freePort()), '--state-dir', stateDir, '--no-open'], { env: cleanEnvironment(t.scratch), timeoutMs: 20_000, hubEntry: quits }).catch(() => {});
      const previous = path.join(stateDir, 'hub.previous.log');
      const logFile = path.join(stateDir, 'hub.log');
      const logSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0; // the Hub that writes the new log is the script that exits at once, which writes nothing
      t.check(rotated ? fs.existsSync(previous) && fs.statSync(previous).size === size && logSize < size : !fs.existsSync(previous) && logSize === size, `a log of ${size} bytes is ${rotated ? 'kept as hub.previous.log and a new one begins' : 'left alone (only a log past 4,000,000 bytes is rotated)'}`);
    }
    const spawnOwnedEntry = (args) => {
      const child = spawn(process.execPath, [path.join(HUB_ROOT, 'lib', 'acp', 'owned-hub.mjs'), ...args], { cwd: HUB_ROOT, env: cleanEnvironment(t.scratch), stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      t.own(() => stopOwned(child));
      return { child, exited: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))) };
    };
    const badLog = path.join(t.scratch, 'bad-port.log');
    const bad = spawnOwnedEntry(['--backend', 'local', '--port', '80', '--state-dir', t.dir('bad-port'), '--no-open', '--log-file', badLog]);
    const badExit = await Promise.race([bad.exited, sleep(20_000).then(() => null)]);
    t.check(badExit?.code === 1 && fs.existsSync(badLog) && /Invalid local dashboard port/.test(fs.readFileSync(badLog, 'utf8')), `a Hub that cannot start says why in its log and exits with code 1 (saw ${JSON.stringify(badExit)})`);
    const second = spawnOwnedEntry(['--backend', 'local', '--port', String(hub5.port), '--state-dir', hub5.stateDir, '--no-open', '--log-file', path.join(t.scratch, 'second.log')]);
    const secondExit = await Promise.race([second.exited, sleep(30_000).then(() => null)]);
    t.check(secondExit !== null && hub5.running && (await healthOf(hub5.port))?.initialized === true, `an owned Hub that finds its port taken by a Hub ends by itself and does not disturb the first (saw ${JSON.stringify(secondExit)})`);
  }

  // ---- 10. what an agent that fails to find its Hub says ---------------------------------------------------------------------------------------------------
  {
    const squatters = createSquatterHarness(t.scratch);
    t.own(() => squatters.stopAll());
    const ask = async (hub, label) => {
      const adapter = startRawAdapter({ scratch: t.scratch, hub });
      t.own(() => adapter.kill());
      await adapter.write(line({ id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + line({ id: 2, method: 'session/new', params: { cwd: project, mcpServers: [] } }));
      const answer = await adapter.waitFor((m) => m.id === 2, { timeoutMs: 20_000, label });
      adapter.end();
      await Promise.race([adapter.exited, sleep(10_000)]);
      return answer;
    };
    const noSession = await ask({ port: hub5.port, stateDir: t.dir('no-session-here') }, 'a Hub whose session file is not there');
    t.check(noSession.error?.code === -32603 && /did not publish a session in .*hub-session\.json/.test(noSession.error.message), 'a Hub that is running, with a state folder in which it published nothing, is not talked to: the sentence names the file and the option', JSON.stringify(noSession));
    const otherPort = await squatters.staleSession(t.dir('other-port'), { port: await freePort(), pid: hub5.pid }); // a session file of another Hub, on another port
    const mismatch = await ask({ port: hub5.port, stateDir: otherPort.stateDir }, 'a session file for another port');
    t.check(mismatch.error?.code === -32603 && /did not publish a session in .*hub-session\.json/.test(mismatch.error.message), 'a session file that names another port is not a session of this Hub: the same sentence as no file at all', JSON.stringify(mismatch));
    const wrong = await squatters.staleSession(t.dir('wrong-secret'), { port: hub5.port, pid: hub5.pid }); // the right process, a secret the Hub does not know
    const rejected = await ask({ port: hub5.port, stateDir: wrong.stateDir }, 'a Hub that does not take the saved secret');
    t.check(rejected.error?.code === -32603 && /rejected the saved session/.test(rejected.error.message), 'a session file with a secret the Hub does not know (it was restarted) is reported as rejected', JSON.stringify(rejected));
    const oldHealth = { ...(await healthOf(hub5.port)) };
    delete oldHealth.auth;
    const oldPort = await freePort();
    await squatters.squat({ name: 'old-hub', port: oldPort, healthText: JSON.stringify(oldHealth) });
    const old = await ask({ port: oldPort, stateDir: t.dir('old-hub-state') }, 'a Hub of a version without a secret');
    t.check(old.error?.code === -32603 && /no session secret/.test(old.error.message), 'a Hub of a version without the per-launch secret is never used, and the sentence says to stop it', JSON.stringify(old));
  }

  // ---- 11. the program: stray output, uncaught errors, bad settings ------------------------------------------------------------------------------------------
  {
    const wrapper = path.join(t.scratch, 'stray-output.mjs');
    const agentUrl = new URL(`file:///${path.join(HUB_ROOT, 'lib', 'acp', 'agent.mjs').replaceAll('\\', '/')}`).href;
    fs.writeFileSync(wrapper, `import { main } from '${agentUrl}';\nconst done = main(process.argv.slice(2));\nsetTimeout(() => {\n  console.log('STRAY console.log of a library');\n  console.info('STRAY console.info');\n  process.stdout.write('STRAY process.stdout.write\\n');\n  Promise.reject(new Error('a lonely rejection'));\n}, 700);\nsetTimeout(() => { throw new Error('an uncaught error'); }, 4500);\nawait done;\n`);
    const adapter = startRawAdapter({ scratch: t.scratch, hub: hub5, args: [wrapper, '--port', String(hub5.port), '--state-dir', hub5.stateDir, '--no-start'] });
    t.own(() => adapter.kill());
    await adapter.write(line({ id: 1, method: 'initialize', params: { protocolVersion: 1 } }));
    await adapter.waitFor((m) => m.id === 1 && m.result, { label: 'initialize' });
    await eventually(() => /unhandled rejection/.test(adapter.stderrText()), { timeoutMs: 20_000, label: 'the stray writes and the rejection to happen' });
    await adapter.write(line({ id: 2, method: 'session/new', params: { cwd: project, mcpServers: [] } }));
    const served = await adapter.waitFor((m) => m.id === 2 && m.result, { label: 'session/new after a lonely rejection' });
    t.check(typeof served.result.sessionId === 'string', 'a rejection nobody handled is logged and the agent goes on serving');
    t.check(adapter.wire().strays.length === 0 && !adapter.stdoutText().includes('STRAY'), 'whatever else writes to standard output (console.log, console.info, process.stdout.write) never reaches it: stdout holds only the messages');
    t.check(/STRAY console\.log of a library/.test(adapter.stderrText()) && /STRAY console\.info/.test(adapter.stderrText()) && /STRAY process\.stdout\.write/.test(adapter.stderrText()) && /unhandled rejection: Error: a lonely rejection/.test(adapter.stderrText()), 'the stray writes and the rejection are on standard error');
    const crashed = await Promise.race([adapter.exited, sleep(30_000).then(() => null)]);
    t.check(crashed?.code === 1 && /uncaught exception: Error: an uncaught error/.test(adapter.stderrText()) && /ending: uncaught exception/.test(adapter.stderrText()), `an uncaught error is logged, the agent ends in order and exits with code 1 (saw ${JSON.stringify(crashed)})`);
    t.check((await healthOf(hub5.port))?.initialized === true && hub5.running, 'and the Hub it was attached to is untouched');
  }
  {
    const run = async (extraArguments, env = {}) => {
      const adapter = startRawAdapter({ scratch: t.scratch, hub: hub5, args: [path.join(HUB_ROOT, 'lib', 'acp', 'agent.mjs'), ...extraArguments], env });
      t.own(() => adapter.kill());
      const exit = await Promise.race([adapter.exited, sleep(15_000).then(() => null)]);
      return { exit, stderr: adapter.stderrText(), stdout: adapter.stdoutText() };
    };
    const badArgument = await run(['--wat']);
    t.check(badArgument.exit?.code === 2 && /datgold-acp: Unknown argument "--wat"/.test(badArgument.stderr) && badArgument.stdout === '', 'an option the agent does not know ends it with exit code 2 and a sentence on stderr, and nothing on stdout');
    const badPort = await run(['--port', '3006']);
    t.check(badPort.exit?.code === 2 && /3006/.test(badPort.stderr) && badPort.stdout === '', 'the port the Hub reserves is refused the same way');
    const hubArguments = ['--port', String(hub5.port), '--state-dir', hub5.stateDir, '--no-start'];
    for (const [name, value] of [['CHATMCP_ACP_POLL_MS', 'abc'], ['CHATMCP_ACP_POLL_MS', '5'], ['CHATMCP_ACP_POLL_MS', '70000'], ['CHATMCP_ACP_POLL_MS', '25.5'], ['CHATMCP_ACP_LOST_CONTACT_MS', '100'], ['CHATMCP_ACP_LOST_CONTACT_MS', '1.5']]) {
      const outcome = await run(hubArguments, { [name]: value });
      t.check(outcome.exit?.code === 2 && outcome.stderr.includes(`${name} must be a whole number from`) && outcome.stdout === '', `${name}=${value} is refused with exit code 2 and the range`, outcome.stderr);
    }
    // The ends of the ranges, and a setting that is empty, are accepted.
    for (const [name, value] of [['CHATMCP_ACP_POLL_MS', '20'], ['CHATMCP_ACP_POLL_MS', '60000'], ['CHATMCP_ACP_LOST_CONTACT_MS', '500'], ['CHATMCP_ACP_LOST_CONTACT_MS', '600000'], ['CHATMCP_ACP_POLL_MS', '']]) {
      const adapter = startRawAdapter({ scratch: t.scratch, hub: hub5, env: { [name]: value } });
      t.own(() => adapter.kill());
      await adapter.write(line({ id: 1, method: 'initialize', params: { protocolVersion: 1 } }));
      const answered = await adapter.waitFor((m) => m.id === 1, { label: `initialize with ${name}=${value}` });
      adapter.end();
      const exit = await Promise.race([adapter.exited, sleep(15_000).then(() => null)]);
      t.check(answered.result?.protocolVersion === 1 && exit?.code === 0, `${name}=${JSON.stringify(value)} is accepted`);
    }
  }

  // ---- 12. connectToHub with a Hub that is a script: what a failure leaves behind, a Hub that does not stop when asked, and a process that ends without stopping its Hub --------------
  {
    const fake = path.join(t.scratch, 'fake-hub.mjs');
    const sessionModule = new URL(`file:///${path.join(HUB_ROOT, 'lib', 'hub-session.mjs').replaceAll('\\', '/')}`).href;
    fs.writeFileSync(fake, [
      "import fs from 'node:fs';",
      "import http from 'node:http';",
      "import path from 'node:path';",
      `import { writeSession } from '${sessionModule}';`,
      'const arg = (name) => process.argv[process.argv.indexOf(name) + 1];',
      "const port = Number(arg('--port'));",
      "const stateDir = arg('--state-dir');",
      "const secret = 'f4'.repeat(32);",
      "const [kind, delay] = String(process.env.CHATMCP_FAKE_HUB ?? '').split(':');",
      'let published = false;', // like the real Hub, it says it has loaded only after its session is published
      "const readyAt = kind === 'loading' ? Date.now() + Number(delay) : (kind === 'never-ready' || kind === 'dies-loading') ? Infinity : 0;",
      "if (kind === 'dies-loading') setTimeout(() => process.exit(0), 1500);",
      "fs.writeFileSync(path.join(stateDir, 'fake.pid'), String(process.pid));",
      'const server = http.createServer((request, response) => {',
      "  const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };",
      "  if (request.url === '/api/health') return json(200, { app: 'chatmcp-local-hub', initialized: published && Date.now() >= readyAt, auth: 'bearer', version: '0.0.0-fake', backend: 'local' });",
      "  if (request.headers.authorization !== `Bearer ${secret}`) return json(401, { error: 'no' });",
      "  if (request.url === '/api/state') return kind === 'state-500' ? json(500, { error: 'broken' }) : json(200, { csrfToken: 'csrf', agent: { activeTaskIds: [] } });",
      "  if (kind === 'leaky' && request.url === '/api/workspaces/add') return json(500, { error: 'refused for ' + secret });", // an error that repeats the secret
      "  if (request.url === '/api/hub/shutdown') return json(200, {});", // asked to stop, and does not
      '  return json(404, {});',
      '});',
      "server.listen(port, '127.0.0.1', async () => { if (process.env.CHATMCP_FAKE_HUB !== 'no-session') await writeSession(stateDir, { port, secret, pid: process.pid }); published = true; });",
      "process.on('SIGTERM', () => {});", // does not obey a signal
      'process.stdin.resume();', // reads the pipe of its owner and does not care when it ends
    ].join('\n') + '\n');
    const pidOf = (stateDir) => Number(fs.readFileSync(path.join(stateDir, 'fake.pid'), 'utf8'));
    const envOf = (mode) => cleanEnvironment(t.scratch, { CHATMCP_FAKE_HUB: mode });

    // A Hub the agent started and then cannot use is stopped again.
    const failedDir = t.dir('fake-no-session');
    await connectToHub({ port: await freePort(), stateDir: failedDir, start: true, hubEntry: fake, env: envOf('no-session'), timeoutMs: 20_000 }).then(
      () => t.check(false, 'a Hub that publishes no session is refused'),
      (error) => t.check(error.code === 'hub_unavailable' && /did not publish a session/.test(error.message), 'a Hub the agent started that publishes no session is refused, with the sentence', error.message));
    const failedPid = pidOf(failedDir);
    await gone(failedPid, 'the Hub that could not be used');
    t.check(!alive(failedPid), 'and that Hub is stopped again: a failure to use a Hub the agent started leaves no Hub behind');

    // A Hub that does not stop when asked, nor when its pipe ends, is stopped by force after ten seconds.
    const lines = [];
    const stubbornDir = t.dir('fake-stubborn');
    const connection = await connectToHub({ port: await freePort(), stateDir: stubbornDir, start: true, hubEntry: fake, env: envOf('stubborn'), timeoutMs: 20_000, log: (text) => lines.push(text) });
    const stubbornPid = pidOf(stubbornDir);
    t.check(connection.owned === true && alive(stubbornPid), 'the agent owns the Hub it started');
    const began = Date.now();
    const stopped = await connection.stop();
    const took = Date.now() - began;
    t.check(stopped === true && !alive(stubbornPid) && took >= 9_500 && took < 40_000 && lines.some((text) => /did not exit in 10 s/.test(text)), `a Hub that ignores the shutdown and the end of its pipe is stopped by force after ten seconds, and the agent says so (took ${took} ms)`);
    const asked = lines.length;
    t.check((await connection.stop()) === true && lines.length === asked, 'and a second stop() is the first one: it asks the Hub nothing more and logs nothing');

    // launchOwned itself waits until the Hub says it has loaded.
    const loadingDir = t.dir('fake-owned-loading');
    const ownedBegan = Date.now();
    const ownedLoading = await launchOwned(['--backend', 'local', '--port', String(await freePort()), '--state-dir', loadingDir, '--no-open'], { env: envOf('loading:1500'), timeoutMs: 20_000, hubEntry: fake });
    t.own(() => stopOwned(ownedLoading.child));
    t.check(Date.now() - ownedBegan >= 1000, `launchOwned does not return before the Hub says it has loaded (waited ${Date.now() - ownedBegan} ms)`);
    await stopOwned(ownedLoading.child);

    // A Hub that is already running but still loading (the desktop app has just started it): the agent waits for it, up to the time it was given.
    const spawnFake = async (mode, name) => {
      const stateDir = t.dir(name);
      const port = await freePort();
      const child = spawn(process.execPath, [fake, '--port', String(port), '--state-dir', stateDir], { cwd: HUB_ROOT, env: envOf(mode), stdio: 'ignore', windowsHide: true });
      t.own(() => stopOwned(child));
      await eventually(async () => (await healthOf(port)) !== null && (await readSession(stateDir)) !== null, { timeoutMs: 20_000, label: `the fake Hub (${mode}) to answer and to publish its session` });
      return { stateDir, port, child, exited: new Promise((resolve) => child.once('exit', resolve)) };
    };
    const loading = await spawnFake('loading:1500', 'fake-loading');
    const loadingBegan = Date.now();
    const afterLoading = await connectToHub({ port: loading.port, stateDir: loading.stateDir, start: false, timeoutMs: 15_000 });
    t.check(afterLoading.owned === false && Date.now() - loadingBegan >= 1000, `the agent waits for a Hub that is still loading and then uses it (waited ${Date.now() - loadingBegan} ms)`);
    const neverReady = await spawnFake('never-ready', 'fake-never-ready');
    const neverBegan = Date.now();
    await connectToHub({ port: neverReady.port, stateDir: neverReady.stateDir, start: false, timeoutMs: 1000 }).then(
      () => t.check(false, 'a Hub that never finishes loading is reported'),
      (error) => t.check(error.code === 'hub_unavailable' && /did not finish loading within 1 s/.test(error.message) && Date.now() - neverBegan < 10_000, 'a Hub that does not finish loading in the time given is reported with the time, and not waited for longer', error.message));
    const dying = await spawnFake('dies-loading', 'fake-dies-loading');
    await connectToHub({ port: dying.port, stateDir: dying.stateDir, start: false, timeoutMs: 15_000 }).then(
      () => t.check(false, 'a Hub that stops while loading is reported'),
      (error) => t.check(error.code === 'hub_unavailable' && /stopped answering while it was loading/.test(error.message), 'a Hub that stops answering while it is loading is reported as that', error.message));
    const broken = await spawnFake('state-500', 'fake-state-500');
    await connectToHub({ port: broken.port, stateDir: broken.stateDir, start: false, timeoutMs: 5_000 }).then(
      () => t.check(false, 'a Hub that fails its first request is reported'),
      (error) => t.check(error.code === 'hub_unavailable' && /did not accept the first request: HTTP 500/.test(error.message), 'a Hub that answers the first request with an error is reported with that error', error.message));

    // A Hub whose error repeats the secret of the session: the sentence the editor gets, and the log, carry [REDACTED] and not the secret (the masker of the program knows the credentials of its connection).
    const leaky = await spawnFake('leaky', 'fake-leaky');
    const leakyAdapter = startRawAdapter({ scratch: t.scratch, hub: leaky });
    t.own(() => leakyAdapter.kill());
    await leakyAdapter.write(line({ id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + line({ id: 2, method: 'session/new', params: { cwd: project, mcpServers: [] } }));
    const leakyAnswer = await leakyAdapter.waitFor((m) => m.id === 2, { timeoutMs: 20_000, label: 'session/new on a Hub that repeats the secret' });
    const fakeSecret = 'f4'.repeat(32);
    t.check(leakyAnswer.error?.code === -32603 && /HTTP 500/.test(leakyAnswer.error.message) && leakyAnswer.error.message.includes('refused for [REDACTED]') && !JSON.stringify(leakyAnswer).includes(fakeSecret), 'an error of the Hub that repeats its secret reaches the editor with [REDACTED] in its place', JSON.stringify(leakyAnswer));
    leakyAdapter.end();
    await Promise.race([leakyAdapter.exited, sleep(15_000)]);
    t.check(!leakyAdapter.stdoutText().includes(fakeSecret) && !leakyAdapter.stderrText().includes(fakeSecret), 'and the secret is on neither standard output nor standard error of the agent');

    // Attached: stop() sends nothing and stops nothing.
    const attached = await connectToHub({ port: hub5.port, stateDir: hub5.stateDir, start: false });
    t.check(attached.owned === false && (await attached.stop()) === false && hub5.running && (await healthOf(hub5.port))?.initialized === true, 'for a Hub the agent only attached to stop() does nothing and says so');

    // A process that ends without stopping the Hub it started: the exit handler kills it.
    const abruptDir = t.dir('fake-abrupt');
    const abrupt = path.join(t.scratch, 'abrupt.mjs');
    const clientModule = new URL(`file:///${path.join(HUB_ROOT, 'lib', 'acp', 'hub-client.mjs').replaceAll('\\', '/')}`).href;
    // An uncaught error is what skips the polite stop. (It comes a moment after the connection: Node on Windows can fail an assertion of libuv when a process ends in the same instant as the
    // lookup of the listener of the port that connectToHub has just made. The exit handler runs in either case; this keeps the test about the Hub.)
    fs.writeFileSync(abrupt, `import { connectToHub } from '${clientModule}';\nawait connectToHub({ port: Number(process.argv[2]), stateDir: process.argv[3], start: true, hubEntry: process.argv[4], timeoutMs: 20000 });\nsetTimeout(() => { throw new Error('an uncaught error'); }, 300);\n`);
    const child = spawn(process.execPath, [abrupt, String(await freePort()), abruptDir, fake], { cwd: HUB_ROOT, env: envOf('stubborn'), stdio: 'ignore', windowsHide: true });
    t.own(() => stopOwned(child));
    const abruptExit = await Promise.race([new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))), sleep(60_000).then(() => null)]);
    t.check(abruptExit?.code === 1, `the process that started the Hub ended with an uncaught error and did not stop it (saw ${JSON.stringify(abruptExit)})`);
    const abruptPid = pidOf(abruptDir);
    await gone(abruptPid, 'the Hub of the process that ended without stopping it');
    t.check(!alive(abruptPid), 'and the Hub it started, which obeys neither a signal nor the end of its pipe, was killed by the exit handler: no orphan');
  }

  // ---- 13. the Hub the agent started is killed while the agent runs -----------------------------------------------------------------------------------------------------
  {
    const { hub, adapter, session } = await startOwned('owned-killed');
    killOnly(session.pid); // the Hub only, not the agent
    await gone(session.pid, 'the Hub that was killed');
    await closed(hub.port);
    await sleep(500);
    adapter.end();
    const outcome = await Promise.race([adapter.exited, sleep(30_000).then(() => null)]);
    t.check(outcome?.code === 0 && !/uncaught exception|unhandled rejection/.test(adapter.stderrText()), `an agent whose own Hub was killed still ends in order, exit code 0, with nothing uncaught (saw ${JSON.stringify(outcome)})`, adapter.stderrText().slice(-600));
  }
});
