// The life of the ACP agent as a PROCESS, with real processes: what an editor does to it (closes its input, kills it, kills its whole process tree) and what that does to a Hub (plan task ux-19).
//
//   The rule: a Hub the agent STARTED never outlives it, however the agent ends; a Hub it only ATTACHED to is never stopped by it. Port 3007 is never used (every port here is random).
//
//   1. A Hub the agent starts: session/new works on it, a Hub that had no workspace takes the first folder, a prompt without a model says so (authentication required), the Hub's own output
//      never reaches stdout (it goes to hub.log), stdout is valid protocol, and the end of the input stops the Hub the polite way (the process is gone, the port is closed, the session file is removed).
//   2. The agent is killed ALONE (TerminateProcess, no tree): the Hub it started notices the broken pipe and stops by itself, the polite way. No orphan.
//   3. The agent's whole process tree is killed (what an editor does): the Hub is gone with it.
//   4. SIGTERM (POSIX): a polite end, exit code 0, the Hub stopped.
//   5. A Hub that was only attached to survives the end of the agent, however it ends.
//   6. No Hub and --no-start; a port that another program holds (it answers as something else, or does not answer at all): an error that says so, the other program is not touched.
//   7. A program that answers as a Hub on the port while the session file names another process (a crash leaves the file behind): the secret of the file is NOT sent to it.
//   8. The Windows launcher windows/chatmcp-acp.cmd, from a folder with spaces in its path, with the Node that is installed beside it and with node from PATH: it prints nothing of its own.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { HUB_ROOT, cleanEnvironment, freePort, sleep } from './e2e/hub-process.mjs';
import { runScenario, eventually } from './e2e/harness.mjs';
import { createSquatterHarness } from './e2e/squatter-harness.mjs';
import { makeCalcProject } from './e2e/fixtures.mjs';
import { readSession, sessionFile } from '../lib/hub-session.mjs';
import { launchOwned } from '../lib/launch.mjs';
import { stopOwned } from '../lib/runtime.mjs';
import { loadAcpTools, missingToolsReason } from './support/acp-tools.mjs';
import { createAcpSchemaValidator } from './support/acp-schema.mjs';
import { killOnly, killTree, startAdapter, startRawAdapter } from './support/acp-adapter.mjs';

const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const healthOf = (port) => fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }).then((response) => response.json()).catch(() => null);
const line = (message) => `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`;

await runScenario({
  name: 'acp-lifecycle',
  summary: 'the agent as a process: a Hub it starts never outlives it, a Hub it attaches to is never stopped, an impostor never gets the secret, the Windows launcher',
  budgetMs: 175_000,
}, async (t) => {
  const tools = await loadAcpTools();
  if (!tools) t.skip(missingToolsReason());
  const validator = createAcpSchemaValidator({ Ajv2020: tools.Ajv2020, schema: JSON.parse(fs.readFileSync(tools.schemaFile, 'utf8')) });
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

  // ---- 1. a Hub the agent starts, ended the polite way ----------------------------------------------------------------------------------------------------
  {
    const hub = { port: await freePort(), stateDir: t.dir('owned-polite') };
    const adapter = await startAdapter({ tools, validator, scratch: t.scratch, hub, start: true });
    t.own(() => adapter.end({ graceMs: 3000 }));
    t.check((await adapter.call('initialize', { protocolVersion: 1 })).result?.protocolVersion === 1, 'initialize does not wait for the Hub');
    const created = await adapter.call('session/new', { cwd: project, mcpServers: [] });
    t.must(typeof created.result?.sessionId === 'string', 'session/new starts a Hub and registers the folder in it', JSON.stringify(created));
    const session = await readSession(hub.stateDir);
    t.check(session?.port === hub.port && alive(session.pid) && (await healthOf(hub.port))?.initialized === true, 'the Hub the agent started answers on the port it was given, and its process is the one named in the session file');
    const state = await fetch(`http://127.0.0.1:${hub.port}/api/state`, { headers: { authorization: `Bearer ${session.secret}` } }).then((r) => r.json());
    t.check(samePath(state.studio.workspace, project) && state.workspaces.items.some((item) => samePath(item.path, project)), 'a Hub that had no workspace at all takes the folder of the first session as its workspace (the same as adding a folder in the desktop app); documented in docs/ACP.md');
    const noModel = await adapter.call('session/prompt', { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'Hello' }] });
    t.check(noModel.error?.code === -32000 && /no model/i.test(noModel.error.message), 'a Hub with no model connected answers a prompt with "authentication required" and a sentence that says what to do', JSON.stringify(noModel));
    t.check(adapter.problems().length === 0 && adapter.wire().strays.length === 0 && !adapter.stdoutText().includes('Dashboard'), `stdout is protocol and nothing else (${adapter.wire().messages.length} messages valid), and nothing of the Hub's own output is in it`, adapter.problems().join(' || '));
    const hubLog = path.join(hub.stateDir, 'hub.log');
    t.check(fs.existsSync(hubLog) && fs.readFileSync(hubLog, 'utf8').includes('Dashboard:'), 'the output of the Hub went to its log file (hub.log in the state folder)');
    const leaks = [adapter.stdoutText(), adapter.stderrText()].filter((text) => text.includes(session.secret));
    t.check(leaks.length === 0, 'and the secret of the Hub is on neither stdout nor stderr');
    const outcome = await adapter.end();
    t.check(outcome?.code === 0, `the end of the input ends the agent with exit code 0 (saw ${JSON.stringify(outcome)})`);
    await gone(session.pid, 'the Hub of the polite end');
    await closed(hub.port);
    t.check(!fs.existsSync(sessionFile(hub.stateDir)), 'the Hub the agent started was stopped the polite way: its process is gone, its port is closed and its session file was removed (a force-killed Hub leaves the file)');
  }

  // ---- 2. the agent is killed alone ------------------------------------------------------------------------------------------------------------------
  {
    const { hub, adapter, session } = await startOwned('owned-alone');
    killOnly(adapter.pid);
    await Promise.race([adapter.exited, sleep(10_000)]);
    t.check(!alive(adapter.pid), 'the agent was killed without its process tree (TerminateProcess; no handler of its own ran)');
    await gone(session.pid, 'the Hub after the agent alone was killed');
    await closed(hub.port);
    t.check(true, 'the Hub the agent had started is gone and its port is closed: no orphan');
    if (process.platform === 'win32') {
      // Node starts a child that is not detached inside a job object that the system closes when Node ends, whatever ends it: the child is ended at once, and no handler of its own runs, so its
      // session file stays, as after a crash (the next start deals with it: docs/HUB-AUTH.md). The polite path of the pipe is tested directly below.
      t.note('on Windows the system ended the Hub together with the agent (a job object that Node makes); the session file it leaves is the one of a crash');
    } else {
      t.check(!fs.existsSync(sessionFile(hub.stateDir)), 'and, with nothing to end it but the pipe, it stopped the polite way (its session file is removed)');
    }
  }

  // ---- 2b. the pipe itself: an owned Hub stops the polite way when its owner lets go of it ------------------------------------------------------------------
  {
    const hub = { port: await freePort(), stateDir: t.dir('lifeline') };
    const owned = await launchOwned(['--backend', 'local', '--port', String(hub.port), '--state-dir', hub.stateDir, '--no-open'], { env: cleanEnvironment(t.scratch) });
    t.own(() => stopOwned(owned.child));
    const session = await readSession(hub.stateDir);
    t.check(session?.pid === owned.pid && (await healthOf(hub.port))?.initialized === true, 'a Hub started by launchOwned is the process named in its session file');
    owned.child.stdin.end(); // the owner goes away without being killed: its end of the pipe closes
    const exit = await Promise.race([owned.exited, sleep(25_000).then(() => null)]);
    t.check(exit?.code === 0 && (await healthOf(hub.port)) === null && !fs.existsSync(sessionFile(hub.stateDir)), `when the owner's end of the pipe closes the Hub stops the polite way: exit code 0, port closed, session file removed (saw ${JSON.stringify(exit)})`);

    // The same when the end of the pipe comes before the Hub has finished starting.
    const early = { port: await freePort(), stateDir: t.dir('lifeline-early') };
    fs.mkdirSync(early.stateDir, { recursive: true });
    const child = spawn(process.execPath, [path.join(HUB_ROOT, 'lib', 'acp', 'owned-hub.mjs'), '--backend', 'local', '--port', String(early.port), '--state-dir', early.stateDir, '--no-open', '--log-file', path.join(early.stateDir, 'hub.log')],
      { cwd: HUB_ROOT, env: cleanEnvironment(t.scratch), stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    t.own(() => stopOwned(child));
    child.stdin.end();
    const earlyExit = await Promise.race([new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))), sleep(40_000).then(() => null)]);
    t.check(earlyExit?.code === 0 && !fs.existsSync(sessionFile(early.stateDir)) && (await healthOf(early.port)) === null, `and when the pipe closes before the Hub is up, the Hub stops as soon as it is (saw ${JSON.stringify(earlyExit)})`);
  }

  // ---- 3. the whole process tree is killed -----------------------------------------------------------------------------------------------------------
  {
    const { hub, adapter, session } = await startOwned('owned-tree');
    killTree(adapter.pid);
    await Promise.race([adapter.exited, sleep(10_000)]);
    await gone(session.pid, 'the Hub after the process tree was killed');
    await closed(hub.port);
    t.check(!alive(adapter.pid) && !alive(session.pid), 'the process tree of the agent was killed (what an editor does): the Hub went with it, and its port is closed');
  }

  // ---- 4. SIGTERM -------------------------------------------------------------------------------------------------------------------------------------
  if (process.platform === 'win32') t.note('SIGTERM to a process ends it at once on Windows (there is no signal to handle); that case is the one of the agent killed alone, above');
  else {
    const { hub, adapter, session } = await startOwned('owned-sigterm');
    process.kill(adapter.pid, 'SIGTERM');
    const outcome = await Promise.race([adapter.exited, sleep(15_000).then(() => null)]);
    t.check(outcome?.code === 0, `SIGTERM is a polite end: exit code 0 (saw ${JSON.stringify(outcome)})`);
    await gone(session.pid, 'the Hub after SIGTERM');
    t.check(!fs.existsSync(sessionFile(hub.stateDir)), 'and the Hub the agent had started was stopped the polite way');
  }

  // ---- 5. a Hub that was only attached to survives ---------------------------------------------------------------------------------------------------
  const hub5 = await t.hub({ project });
  {
    const adapter = startRawAdapter({ scratch: t.scratch, hub: hub5 });
    t.own(() => adapter.kill());
    await adapter.write(line({ id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + line({ id: 2, method: 'session/new', params: { cwd: project, mcpServers: [] } }));
    await adapter.waitFor((m) => m.id === 2 && m.result, { label: 'session/new on the attached Hub' });
    adapter.kill();
    await Promise.race([adapter.exited, sleep(10_000)]);
    await sleep(1500);
    t.check((await healthOf(hub5.port))?.initialized === true && hub5.running, 'a Hub the agent only attached to is still running after the agent was killed with its process tree');
  }

  // ---- 6. no Hub with --no-start, a port that something else holds -------------------------------------------------------------------------------------
  {
    const quiet = { port: await freePort(), stateDir: t.dir('nobody') };
    const adapter = startRawAdapter({ scratch: t.scratch, hub: quiet }); // --no-start
    t.own(() => adapter.kill());
    await adapter.write(line({ id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + line({ id: 2, method: 'session/new', params: { cwd: project, mcpServers: [] } }));
    const refused = await adapter.waitFor((m) => m.id === 2, { label: 'session/new without a Hub' });
    t.check(refused.error?.code === -32603 && /No DatGold Hub is running/.test(refused.error.message) && /--no-start/.test(refused.error.message), 'with --no-start and no Hub running, session/new says so', JSON.stringify(refused));
    t.check((await healthOf(quiet.port)) === null, 'and no Hub was started');
    adapter.end();
    t.check((await Promise.race([adapter.exited, sleep(10_000).then(() => null)]))?.code === 0, 'the agent is still fine and ends with exit code 0');
  }
  {
    // Something else answers on the port, and something else just listens and says nothing.
    const stranger = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ app: 'something-else' })); });
    await new Promise((resolve) => stranger.listen(0, '127.0.0.1', resolve));
    const mute = net.createServer((socket) => { socket.on('error', () => {}); });
    await new Promise((resolve) => mute.listen(0, '127.0.0.1', resolve));
    t.own(() => { stranger.close(); mute.close(); });
    for (const [name, server] of [['answers as something else', stranger], ['listens and says nothing', mute]]) {
      const port = server.address().port;
      const adapter = startRawAdapter({ scratch: t.scratch, hub: { port, stateDir: t.dir(`held-${port}`) }, start: true });
      t.own(() => adapter.kill());
      await adapter.write(line({ id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + line({ id: 2, method: 'session/new', params: { cwd: project, mcpServers: [] } }));
      const answer = await adapter.waitFor((m) => m.id === 2, { timeoutMs: 20_000, label: `session/new on a port that ${name}` });
      const sentence = name === 'listens and says nothing' ? /^Port \d+ is used by another program\. The agent does not stop it: choose another port with --port\.$/ : /^Port \d+ is used by another program \(it answers, but not as a DatGold Hub\)\. The agent does not stop it: choose another port with --port\.$/;
      t.check(answer.error?.code === -32603 && sentence.test(answer.error.message) && server.listening, `a port held by a program that ${name}: the agent does not start a Hub there, says whose it is, and leaves the program alone`, JSON.stringify(answer));
      adapter.end();
      await Promise.race([adapter.exited, sleep(10_000)]);
    }
  }

  // ---- 7. an impostor on the port: the secret of a stale session file is NOT sent -------------------------------------------------------------------------
  {
    const squatters = createSquatterHarness(t.scratch);
    t.own(() => squatters.stopAll());
    const healthText = JSON.stringify(await healthOf(hub5.port));
    const port = await freePort();
    const stale = await squatters.staleSession(t.dir('stale-state'), { port, pid: await squatters.deadPid() });
    const squatter = await squatters.squat({ name: 'impostor', port, healthText });
    const adapter = startRawAdapter({ scratch: t.scratch, hub: { port, stateDir: stale.stateDir } }); // attaches
    t.own(() => adapter.kill());
    await adapter.write(line({ id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + line({ id: 2, method: 'session/new', params: { cwd: project, mcpServers: [] } }));
    const answer = await adapter.waitFor((m) => m.id === 2, { timeoutMs: 20_000, label: 'session/new against the impostor' });
    t.check(answer.error?.code === -32603 && /Not sending the Hub's secret/.test(answer.error.message), 'a program that answers on the port like a Hub, while the session file names another process, is refused with a sentence that says why', JSON.stringify(answer));
    const seen = squatter.requests();
    t.check(seen.length > 0 && seen.every((request) => request.path === '/api/health') && seen.every((request) => !request.headers.authorization), `the impostor saw ${seen.length} request(s), all of them the health probe, none with an Authorization header`);
    t.check(!squatter.raw().includes(stale.secret), 'and the secret of the stale session file is nowhere in the bytes it received');
    adapter.end();
    await Promise.race([adapter.exited, sleep(10_000)]);
    t.check(alive(squatter.pid), 'and the program on the port was not touched');
  }

  // ---- 8. the Windows launcher ------------------------------------------------------------------------------------------------------------------------
  if (process.platform !== 'win32') t.note('windows/chatmcp-acp.cmd is a Windows launcher; it is exercised on Windows only');
  else {
    const base = path.join(t.scratch, 'with spaces', 'Dat Gold');
    const hubCopy = path.join(base, 'DATGOLD-HUB');
    fs.mkdirSync(path.join(hubCopy, 'windows'), { recursive: true });
    for (const name of ['hub.mjs', 'package.json']) fs.copyFileSync(path.join(HUB_ROOT, name), path.join(hubCopy, name));
    fs.cpSync(path.join(HUB_ROOT, 'lib'), path.join(hubCopy, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(HUB_ROOT, 'windows', 'chatmcp-acp.cmd'), path.join(hubCopy, 'windows', 'chatmcp-acp.cmd'));
    const launcher = path.join(hubCopy, 'windows', 'chatmcp-acp.cmd');
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    // node from PATH: the folder of this Node is put first, so that a machine on which node runs by its full path still has one on PATH.
    const pathKey = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
    const env = { [pathKey]: `${path.dirname(process.execPath)}${path.delimiter}${process.env[pathKey] ?? ''}` };
    const run = async (label) => {
      const adapter = await startAdapter({ tools, validator, scratch: t.scratch, hub: hub5, env, command: comspec, verbatim: true, args: ['/d', '/s', '/c', `""${launcher}" --port ${hub5.port} --state-dir "${hub5.stateDir}" --no-start"`] });
      t.own(() => adapter.kill());
      const init = await adapter.call('initialize', { protocolVersion: 1 });
      t.check(init.result?.protocolVersion === 1, `${label}: initialize through the launcher`, JSON.stringify(init));
      const created = await adapter.call('session/new', { cwd: project, mcpServers: [] });
      t.check(typeof created.result?.sessionId === 'string', `${label}: session/new through the launcher`, JSON.stringify(created));
      t.check(adapter.problems().length === 0 && adapter.wire().strays.length === 0, `${label}: stdout holds protocol and nothing else (the launcher prints no banner and echoes nothing)`, adapter.problems().concat(adapter.wire().strays).join(' || '));
      const outcome = await adapter.end();
      t.check(outcome?.code === 0, `${label}: exit code 0 comes back through the launcher (saw ${JSON.stringify(outcome)})`);
      return adapter.stderrText();
    };
    const onPath = await run('node from PATH');
    t.check(/ready \(node v\d+/.test(onPath) && !/runtimes[\\/]node/i.test(onPath), 'with no Node beside it the launcher uses node from PATH (the dev checkout case)');
    const bundled = path.join(base, 'runtimes', 'node', 'node.exe');
    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    try { fs.linkSync(process.execPath, bundled); } catch { fs.copyFileSync(process.execPath, bundled); }
    const withBundled = await run('the Node of the installation');
    t.check(withBundled.toLowerCase().includes(bundled.toLowerCase()), 'with runtimes\\node\\node.exe beside the Hub folder (the installed layout) the launcher uses THAT Node, from a path with spaces in it');
  }
});
