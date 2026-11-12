// session/load of the ACP agent on a REAL Hub with a scripted model, driven by the official SDK (plan task ux-21).
//
//   A. A first agent process makes a session and a turn (a read and an answer), and ends, as when the editor is closed.
//   B. A second agent process on the same Hub loads that session: the conversation is replayed before the answer, every message is valid for the schema, and the next prompt
//      continues the SAME task of the Hub and tells only what is new.
//   C. The file of sessions holds ids and folders, never what was said, and no credential.
//   Never touched: the Hub on port 3007 (every Hub and every agent here has a random port and a state folder of its own).
import fs from 'node:fs';
import path from 'node:path';
import { runScenario } from './e2e/harness.mjs';
import { connectModel, setMode } from './e2e/hub-process.mjs';
import { gitInit, makeCalcProject } from './e2e/fixtures.mjs';
import { call, say, sequence } from './e2e/scenarios.mjs';
import { loadAcpTools, missingToolsReason } from './support/acp-tools.mjs';
import { createAcpSchemaValidator } from './support/acp-schema.mjs';
import { startAdapter } from './support/acp-adapter.mjs';

await runScenario({
  name: 'acp-load',
  summary: 'session/load of the ACP agent on a real Hub: a session of an earlier agent process is replayed and goes on with the same task',
  budgetMs: 150_000,
}, async (t) => {
  const tools = await loadAcpTools();
  if (!tools) t.skip(missingToolsReason());
  const validator = createAcpSchemaValidator({ Ajv2020: tools.Ajv2020, schema: JSON.parse(fs.readFileSync(tools.schemaFile, 'utf8')) });

  const selected = t.dir('hub-selected');
  makeCalcProject(selected);
  gitInit(selected, t.scratch);
  const project = t.dir('project-load');
  makeCalcProject(project);
  gitInit(project, t.scratch);

  const router = (ctx) => {
    if (ctx.prompt.includes('[[READ]]')) return sequence([call('read_file', { path: 'calc.js' })], { final: 'READ-DONE: calc.js subtracts.' })(ctx);
    if (ctx.prompt.includes('[[AGAIN]]')) return say('AGAIN-DONE: still here.');
    return say('OTHER');
  };
  const mock = await t.mock({ scenarios: { router }, scenario: 'router' });
  const hub = await t.hub({ project: selected });
  await connectModel(hub, mock);
  await setMode(hub, 'autonomous');

  const initialize = (adapter) => adapter.call('initialize', { protocolVersion: 1, clientCapabilities: { session: { notices: {} } }, clientInfo: { name: 'datgold-acp-test-client', version: '0.0.0' } });
  const clean = (adapter, label) => {
    const problems = adapter.problems();
    t.check(problems.length === 0 && adapter.wire().strays.length === 0, `${label}: every line on stdout is a valid message of the protocol (${adapter.wire().messages.length} checked), and nothing else was written`, problems.slice(0, 3).join(' || '));
  };

  // ---- A. the first agent process --------------------------------------------------------------------------------------------------------------------------------------
  const first = await startAdapter({ tools, validator, scratch: t.scratch, hub });
  t.own(() => first.end({ graceMs: 3000 }));
  t.check((await initialize(first)).result?.agentCapabilities?.loadSession === true, 'the agent says it can load a session');
  const sessionId = (await first.call('session/new', { cwd: project, mcpServers: [] })).result.sessionId;
  t.equal((await first.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[[READ]] what does calc.js do?' }] })).result, { stopReason: 'end_turn' }, 'the first turn ends');
  clean(first, 'first agent');
  const tasksBefore = (await hub.state()).agent.tasks.filter((task) => task.workspacePath && path.resolve(task.workspacePath).toLowerCase() === path.resolve(project).toLowerCase());
  t.check(tasksBefore.length === 1, `one task of the Hub belongs to the session (saw ${tasksBefore.length})`);
  const ended = await first.end({ graceMs: 8000 });
  t.check(ended?.code === 0, `the first agent ends as when the editor is closed (saw ${JSON.stringify(ended)})`);

  // ---- B. a second agent process loads the session ----------------------------------------------------------------------------------------------------------------------
  const second = await startAdapter({ tools, validator, scratch: t.scratch, hub });
  t.own(() => second.end({ graceMs: 3000 }));
  await initialize(second);
  const loaded = await second.call('session/load', { sessionId, cwd: project, mcpServers: [] });
  t.equal(loaded.result, {}, 'session/load answers with an empty result');
  const replayed = second.updates.filter((n) => n.sessionId === sessionId).map((n) => n.update);
  const kinds = replayed.map((u) => u.sessionUpdate);
  t.check(kinds[0] === 'user_message_chunk' && /\[\[READ\]\] what does calc\.js do\?/.test(replayed[0].content?.text ?? ''), 'the replay begins with the message of the person', JSON.stringify(kinds));
  const read = replayed.find((u) => u.sessionUpdate === 'tool_call');
  t.check(read?.title === 'Read calc.js' && read.kind === 'read', 'the call of the first turn is replayed, with its title and kind', JSON.stringify(read));
  t.check(replayed.some((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === read?.toolCallId && u.status === 'completed'), 'and its result');
  t.check(replayed.filter((u) => u.sessionUpdate === 'agent_message_chunk' && /READ-DONE/.test(u.content?.text ?? '')).length === 1, 'the answer of the model is replayed once', JSON.stringify(replayed.filter((u) => u.sessionUpdate === 'agent_message_chunk')));
  const again = await second.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[[AGAIN]] are you still there?' }] });
  t.equal(again.result, { stopReason: 'end_turn' }, 'the loaded session takes a prompt');
  const tasksAfter = (await hub.state()).agent.tasks.filter((task) => task.workspacePath && path.resolve(task.workspacePath).toLowerCase() === path.resolve(project).toLowerCase());
  t.check(tasksAfter.length === 1 && tasksAfter[0].id === tasksBefore[0].id, 'and continues the SAME task of the Hub (no second task)');
  const afterLoad = second.updates.filter((n) => n.sessionId === sessionId).map((n) => n.update).slice(replayed.length);
  t.check(afterLoad.some((u) => /AGAIN-DONE/.test(u.content?.text ?? '')) && !afterLoad.some((u) => u.sessionUpdate === 'tool_call' || /READ-DONE/.test(u.content?.text ?? '')), 'the new turn tells only what is new', JSON.stringify(afterLoad.map((u) => u.sessionUpdate)));
  const unknown = await second.call('session/load', { sessionId: 'never-made', cwd: project, mcpServers: [] });
  t.check(unknown.error?.code === -32002 || /not known/i.test(unknown.error?.message ?? ''), 'an unknown session is refused', JSON.stringify(unknown.error));
  clean(second, 'second agent');

  // ---- C. the file of sessions ----------------------------------------------------------------------------------------------------------------------------------------
  const file = path.join(hub.stateDir, 'acp-sessions.json');
  const text = fs.readFileSync(file, 'utf8');
  const kept = JSON.parse(text);
  t.check(kept.version === 1 && kept.sessions[sessionId]?.taskId === tasksBefore[0].id, 'the file of sessions in the state folder of the Hub names the session and its task');
  t.check(!text.includes('READ') && !text.includes('calc.js do') && !text.includes(hub.secret), 'and holds neither what was said nor the secret of the Hub');
});
