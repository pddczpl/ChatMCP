// The ACP agent on a REAL Hub in Review mode with a scripted model, driven by the official SDK as the client (plan task ux-20): the calls of a task as they happen, and the approvals answered in the editor.
//
//   A. The calls of a task are told as they happen (a read, a write, an edit), each with its kind, its title and its place, and they complete; the editor is asked before the write and the edit run, with
//      the change the Hub worked out as a diff; "allow" writes the file; every message the agent wrote is valid for the schema of the protocol.
//   B. "Reject" and "cancelled" write nothing, and the turn goes on to its end.
//   C. A key in a command, a key and a password in an argument, a key in a file the model writes, private key material, a protected file: none of it reaches the editor, the log or the model.
//   D. A cancel while the editor is being asked: the task stops, nothing is written, the Hub holds no request.
//   E. The same approval answered in the desktop app first: the late answer of the editor harms nothing.
//   F. A turn that continues a task tells only what is new.
//   Never touched: the Hub on port 3007 (every Hub and every agent here has a random port and a state folder of its own).
import fs from 'node:fs';
import path from 'node:path';
import { eventually, runScenario } from './e2e/harness.mjs';
import { connectModel, pendingApprovals, setMode } from './e2e/hub-process.mjs';
import { gitInit, makeCalcProject } from './e2e/fixtures.mjs';
import { call, say, sequence } from './e2e/scenarios.mjs';
import { loadAcpTools, missingToolsReason } from './support/acp-tools.mjs';
import { createAcpSchemaValidator } from './support/acp-schema.mjs';
import { startAdapter } from './support/acp-adapter.mjs';

const ENV_SECRET = 'ACP-ENV-FILE-BODY-must-not-appear-5151';
const PASSWORD = 'SuperSecretPassw0rd-must-be-masked';
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
const FAKE_KEY = 'sk-ACPEVENTSTESTKEY0123456789abcdefGHIJ';
const PEM_BODY = 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8QuKUpRKfFLfRYC9AIKjbJTWit';
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----\n`;
const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
const allow = { outcome: { outcome: 'selected', optionId: 'allow_once' } };
const reject = { outcome: { outcome: 'selected', optionId: 'reject_once' } };

await runScenario({
  name: 'acp-events',
  summary: 'the ACP agent on a real Hub in Review mode: the calls of a task as they happen, the approvals answered in the editor, what is kept out',
  budgetMs: 175_000,
}, async (t) => {
  const tools = await loadAcpTools();
  if (!tools) t.skip(missingToolsReason());
  const validator = createAcpSchemaValidator({ Ajv2020: tools.Ajv2020, schema: JSON.parse(fs.readFileSync(tools.schemaFile, 'utf8')) });

  const selected = t.dir('hub-selected');
  makeCalcProject(selected);
  gitInit(selected, t.scratch);
  /** A folder of its own for each scenario: the first task of a folder runs in it, a second one would run in a Git worktree. */
  const folders = new Map();
  const folderFor = (name) => {
    if (!folders.has(name)) {
      const folder = t.dir(`project-${name}`);
      makeCalcProject(folder);
      fs.writeFileSync(path.join(folder, '.env'), `API_TOKEN=${ENV_SECRET}\n`);
      gitInit(folder, t.scratch);
      fs.writeFileSync(path.join(folder, '.gitignore'), '.env\n');
      folders.set(name, folder);
    }
    return folders.get(name);
  };

  const router = (ctx) => {
    if (ctx.prompt.includes('[[TOOLS]]')) return sequence([call('read_file', { path: 'calc.js' }), call('write_file', { path: 'out.txt', content: 'from acp\n' }), call('edit_file', { path: 'calc.js', old_string: 'return a - b;', new_string: 'return a + b;' })], { final: 'TOOLS-DONE all three.' })(ctx);
    if (ctx.prompt.includes('[[WRITE]]')) return sequence([call('write_file', { path: 'out.txt', content: 'from acp\n' })], { final: 'WRITE-DONE.' })(ctx);
    if (ctx.prompt.includes('[[COMMAND]]')) return sequence([call('run_command', { command: `curl -u admin:${PASSWORD} -H "Authorization: Bearer ${GITHUB_TOKEN}" https://example.invalid/` })], { final: 'COMMAND-DONE.' })(ctx);
    if (ctx.prompt.includes('[[KEYFILE]]')) return sequence([call('write_file', { path: 'config.js', content: `const API_KEY = "${FAKE_KEY}";\nmodule.exports = { API_KEY };\n` })], { final: 'KEYFILE-DONE.' })(ctx);
    if (ctx.prompt.includes('[[PEM]]')) return sequence([call('write_file', { path: 'notes.txt', content: PEM })], { final: 'PEM-DONE.' })(ctx);
    if (ctx.prompt.includes('[[ENV]]')) return sequence([call('read_file', { path: '.env' })], { final: 'ENV-DONE.' })(ctx);
    return say('The answer is 42. FINAL-ANSWER');
  };
  const mock = await t.mock({ scenarios: { router }, scenario: 'router', keepBodies: true });
  const hub = await t.hub({ project: selected });
  await connectModel(hub, mock);
  await setMode(hub, 'review'); // before any session: a conversation in another folder keeps the mode it began with
  await mock.watch([ENV_SECRET, PASSWORD, GITHUB_TOKEN, FAKE_KEY, PEM_BODY]);

  /** An agent attached to the Hub, a session in a folder of its own, and a client whose answer to an approval is `answer(params)`. */
  async function editor(name, answer) {
    const state = { answer };
    const adapter = await startAdapter({ tools, validator, scratch: t.scratch, hub, handlers: { permission: (params) => state.answer(params) } });
    t.own(() => adapter.end({ graceMs: 3000 }));
    await adapter.call('initialize', { protocolVersion: 1, clientCapabilities: { session: { notices: {} } }, clientInfo: { name: 'datgold-acp-test-client', version: '0.0.0' } });
    const folder = folderFor(name);
    const sessionId = (await adapter.call('session/new', { cwd: folder, mcpServers: [] })).result.sessionId;
    const prompt = (text) => adapter.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    const updates = () => adapter.updates.filter((n) => n.sessionId === sessionId).map((n) => n.update);
    return { adapter, state, folder, sessionId, prompt, updates };
  }
  const clean = (adapter, label) => {
    const problems = adapter.problems();
    t.check(problems.length === 0 && adapter.wire().strays.length === 0, `${label}: every line on stdout is a valid message of the protocol (${adapter.wire().messages.length} checked), and nothing else was written`, problems.slice(0, 3).join(' || '));
  };

  // ---- A. the calls of a task, and the approvals ------------------------------------------------------------------------------------------------------------------------------
  {
    const e = await editor('tools', async () => allow);
    const done = await e.prompt('[[TOOLS]] read, write and edit');
    t.equal(done.result, { stopReason: 'end_turn' }, 'a turn of three calls ends with end_turn');
    await e.adapter.drained();
    const updates = e.updates();
    const calls = updates.filter((u) => u.sessionUpdate === 'tool_call');
    t.equal(calls.map((u) => [u.title, u.kind]), [['Read calc.js', 'read'], ['Write out.txt', 'edit'], ['Edit calc.js', 'edit']], 'the three calls were told as they happened, with their titles and kinds');
    t.check(calls.every((u) => u.locations?.length === 1 && samePath(u.locations[0].path, path.join(e.folder, u.rawInput.path))) && calls.every((u) => typeof u.toolCallId === 'string' && u.toolCallId !== ''), 'each with the file it is about, as an absolute path inside the folder of the session');
    const finals = updates.filter((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed');
    t.equal(finals.map((u) => u.toolCallId).sort(), calls.map((u) => u.toolCallId).sort(), 'and each completed');
    t.check(updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').length === 1 && /TOOLS-DONE/.test(updates.at(-1).content?.text ?? ''), 'the answer of the model was told once, last');
    const asked = e.adapter.permissionRequests;
    t.equal(asked.map((p) => p.toolCall.title), ['Write out.txt', 'Edit calc.js'], 'the editor was asked before the write and before the edit, and not before the read');
    t.check(asked.every((p) => calls.some((c) => c.toolCallId === p.toolCall.toolCallId)), 'about the calls it had been told of');
    const writeDiff = asked[0].toolCall.content[0];
    t.check(asked[0].toolCall.content.length === 1 && writeDiff.type === 'diff' && samePath(writeDiff.path, path.join(e.folder, 'out.txt')) && writeDiff.oldText == null && writeDiff.newText === 'from acp\n', 'the new file is the diff the editor is shown, with no old text', JSON.stringify(asked[0].toolCall.content).slice(0, 300));
    const editDiff = asked[1].toolCall.content[0];
    t.check(editDiff.type === 'diff' && editDiff.oldText.includes('return a - b;') && editDiff.newText.includes('return a + b;'), 'and the edit shows the line before and the line after');
    t.equal(fs.readFileSync(path.join(e.folder, 'out.txt'), 'utf8'), 'from acp\n', 'allow wrote the file');
    t.check(fs.readFileSync(path.join(e.folder, 'calc.js'), 'utf8').includes('return a + b;'), 'and made the edit');
    t.equal(await pendingApprovals(hub), [], 'the Hub holds no request');
    const order = updates.map((u) => `${u.sessionUpdate}:${u.status ?? ''}`);
    const pendingAt = order.indexOf('tool_call:pending');
    t.check(pendingAt > -1, 'a call that waited for the editor was told as pending first');
    clean(e.adapter, 'A');
  }

  // ---- B. reject, cancelled ---------------------------------------------------------------------------------------------------------------------------------------------------
  for (const [name, answer, label] of [['reject', reject, 'a rejection'], ['cancelled', { outcome: { outcome: 'cancelled' } }, 'a cancellation']]) {
    const e = await editor(name, async () => answer);
    const done = await e.prompt('[[WRITE]] write out.txt');
    t.equal(done.result, { stopReason: 'end_turn' }, `${label}: the turn goes on to its end`);
    await e.adapter.drained();
    t.check(!fs.existsSync(path.join(e.folder, 'out.txt')), `${label}: nothing was written`);
    const failed = e.updates().filter((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'failed');
    t.check(failed.length === 1, `${label}: the call is told as failed (${failed.length})`);
    t.equal(await pendingApprovals(hub), [], `${label}: the Hub holds no request`);
    clean(e.adapter, name);
  }

  // ---- C. what is kept out ----------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const e = await editor('command', async () => reject);
    await e.prompt('[[COMMAND]] call the API');
    await e.adapter.drained();
    const asked = e.adapter.permissionRequests[0];
    t.check(asked && /^Run curl/.test(asked.toolCall.title) && asked.toolCall.kind === 'execute', 'a command is asked about with its title and kind', JSON.stringify(asked)?.slice(0, 300));
    const said = JSON.stringify([e.adapter.permissionRequests, e.updates()]);
    t.check(!said.includes(PASSWORD) && !said.includes(GITHUB_TOKEN), 'a password after -u and a token in a header are not in the request to the editor or in any update');
    t.check(said.includes('[REDACTED]') && said.includes('example.invalid'), 'they are masked, the rest of the command is there');
    clean(e.adapter, 'command');
  }
  {
    const e = await editor('keyfile', async () => reject);
    await e.prompt('[[KEYFILE]] write the config');
    await e.adapter.drained();
    const asked = e.adapter.permissionRequests[0];
    const diff = asked.toolCall.content[0];
    t.check(diff.type === 'diff' && diff.newText.includes('API_KEY') && !diff.newText.includes(FAKE_KEY) && diff.newText.includes('[REDACTED]'), 'a key in a file the model writes: the name of the setting stays, the key is masked in the diff the editor is shown', JSON.stringify(diff).slice(0, 300));
    clean(e.adapter, 'keyfile');
  }
  {
    const e = await editor('pem', async () => reject);
    await e.prompt('[[PEM]] write the notes');
    await e.adapter.drained();
    const asked = e.adapter.permissionRequests[0];
    const wholeRequest = JSON.stringify(asked);
    t.check(!wholeRequest.includes(PEM_BODY) && !wholeRequest.includes('BEGIN RSA PRIVATE KEY') || /private key/i.test(wholeRequest), 'private key material that the model writes is not shown in the request (and the request says so)', wholeRequest.slice(0, 300));
    t.check(!wholeRequest.includes(PEM_BODY), 'none of its body is in the request', wholeRequest.slice(0, 300));
    clean(e.adapter, 'pem');
  }
  {
    const e = await editor('env', async () => allow);
    await e.prompt('[[ENV]] read the secrets');
    await e.adapter.drained();
    const read = e.updates().filter((u) => u.sessionUpdate === 'tool_call' && u.kind === 'read');
    t.check(read.length === 1 && read[0].rawInput.path === '.env', 'the read of a protected file is told as what it is: a path');
    t.equal(e.adapter.permissionRequests, [], 'and the editor is not asked: the Hub refuses it before anyone is asked');
    const result = e.updates().find((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === read[0].toolCallId);
    t.check(result?.status === 'failed', 'it failed');
    clean(e.adapter, 'env');
  }
  {
    const watched = mock.watchReport();
    t.check(watched.scanned > 0, `the model's requests were scanned (${watched.scanned})`);
    t.check(!watched.hits.some((hit) => hit.needle === 0), 'the text of the protected .env never reached the model');
    t.check(watched.hits.some((hit) => hit.needle === 1), 'while the password that the model wrote itself in a command did (the control: the watch can see what a request holds)');
  }

  // ---- D. a cancel while the editor is asked ------------------------------------------------------------------------------------------------------------------------------------
  {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const e = await editor('cancel', () => held);
    const running = e.prompt('[[WRITE]] write out.txt');
    await eventually(() => e.adapter.permissionRequests.length === 1, { label: 'the editor is asked' });
    await e.adapter.notify('session/cancel', { sessionId: e.sessionId });
    release({ outcome: { outcome: 'cancelled' } }); // what an editor does with the request it was asked when the person cancels
    const cancelled = await running;
    t.equal(cancelled.result, { stopReason: 'cancelled' }, 'a cancel while the editor is asked: the turn answers cancelled');
    t.check(!fs.existsSync(path.join(e.folder, 'out.txt')), 'nothing was written');
    t.equal(await pendingApprovals(hub), [], 'and the Hub holds no request');
    clean(e.adapter, 'cancel');
  }

  // ---- E. answered in the desktop app first ------------------------------------------------------------------------------------------------------------------------------------
  {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const e = await editor('desktop', () => held);
    const running = e.prompt('[[WRITE]] write out.txt');
    const [request] = await eventually(async () => { const list = await pendingApprovals(hub); return list.length ? list : null; }, { label: 'the approval request' });
    await hub.post('/api/studio/permissions/decide', { id: request.id, approved: true }); // the owner approves in the desktop app
    const done = await running.then(() => null, () => null);
    void done;
    await eventually(() => fs.existsSync(path.join(e.folder, 'out.txt')), { label: 'the file written after the approval in the desktop app' });
    release(allow); // the editor answers later, to a request nobody waits for any more
    const result = await running;
    t.equal(result.result, { stopReason: 'end_turn' }, 'an approval answered in the desktop app first: the turn ends normally');
    t.equal(fs.readFileSync(path.join(e.folder, 'out.txt'), 'utf8'), 'from acp\n', 'and the file was written once');
    clean(e.adapter, 'desktop');
  }

  // ---- F. a turn that continues a task ------------------------------------------------------------------------------------------------------------------------------------------
  {
    const e = await editor('continue', async () => allow);
    await e.prompt('[[WRITE]] write out.txt');
    await e.adapter.drained();
    const before = e.updates().length;
    const second = await e.prompt('[[ANSWER]] and now?');
    t.equal(second.result, { stopReason: 'end_turn' }, 'the second turn ends');
    await e.adapter.drained();
    const later = e.updates().slice(before);
    t.check(later.length === 1 && later[0].sessionUpdate === 'agent_message_chunk' && /FINAL-ANSWER/.test(later[0].content.text), 'it tells what is new: its answer, and not the calls of the turn before', JSON.stringify(later).slice(0, 300));
    clean(e.adapter, 'continue');
  }

  // ---- G. the plan the Hub makes for a longer coding request ------------------------------------------------------------------------------------------------------------------
  {
    const e = await editor('plan', async () => allow);
    const prompt = '[[WRITE]] First inspect the project files and read calc.js carefully to see what it does. Then write out.txt with the greeting from acp. Finally run the checks and review the change before you report back.';
    const done = await e.prompt(prompt);
    t.equal(done.result, { stopReason: 'end_turn' }, 'a longer coding request ends with end_turn');
    await e.adapter.drained();
    const updates = e.updates();
    const plans = updates.filter((u) => u.sessionUpdate === 'plan');
    t.check(plans.length >= 1, `the plan the Hub made for the request is told (${plans.length})`, JSON.stringify(updates.map((u) => u.sessionUpdate)));
    const first = plans[0]?.entries ?? [];
    t.equal(first.map((entry) => entry.content), ['Inspect project instructions and relevant code', 'Implement bounded changes', 'Run relevant checks and diagnose results', 'Review actual changes and report limitations'], 'with the phases of the Hub, in their order');
    t.check(first[0]?.status === 'in_progress' && first.slice(1).every((entry) => entry.status === 'pending' || entry.status === 'completed' || entry.status === 'in_progress'), 'the first phase is in progress when it is first told', JSON.stringify(first));
    t.check(updates.findIndex((u) => u.sessionUpdate === 'plan') < updates.findIndex((u) => u.sessionUpdate === 'agent_message_chunk'), 'and the plan is told before the answer');
    clean(e.adapter, 'plan');
  }
});
