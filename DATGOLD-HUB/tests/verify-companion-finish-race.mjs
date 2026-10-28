// A finished ChatGPT Web task shows "completed" a moment before it releases the Companion: finish() sets the status, then waits for
// its event and for session.close(), and only then clears the runner's context. Starting the next task in that window answered 409
// ("ChatGPT Web Companion is handling another task") although the previous task was over. CI hit it on 2 of 6 legs of the outbound
// Hub test. Here the window is opened on purpose: the session takes 400 ms to close.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DualAgent } from '../lib/dual-agent.mjs';
import { CHAT_URL, envelopeOf, makeFlow, textResult } from './fixtures/companion-flow.mjs';

const WORKSPACE = 'F:\workspace\demo';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const flow = await makeFlow({ workspace: WORKSPACE, tools: { 'local.read_file': () => textResult('contents') } });
try {
  const create = flow.manager.createAgentSession.bind(flow.manager);
  flow.manager.createAgentSession = async (...args) => {
    const session = await create(...args);
    const close = session.close.bind(session);
    session.close = async () => { await sleep(400); return close(); };
    return session;
  };
  const api = { manager: { workspace: WORKSPACE }, state: () => ({ activeTaskIds: [], tasks: [] }), get: () => null };
  const dual = new DualAgent({ browser: flow.runner, api, directory: path.join(flow.directory, 'dual'), defaultMode: 'chatgpt-web' });
  await dual.load();

  const first = await flow.start({ prompt: 'First task', workspacePath: WORKSPACE });
  const message = await flow.deliver();
  const identity = envelopeOf(message.text);
  const block = '```json\n' + JSON.stringify({ chatmcp_hub: 'v1', task: identity.task, turn: identity.turn, nonce: identity.nonce, kind: 'final', text: 'Done.' }) + '\n```';
  await flow.runner.reply({ clientId: flow.clientId, taskId: first.id, messageId: message.id, replyId: randomUUID(), text: block, blocks: [block], url: CHAT_URL });

  const deadline = Date.now() + 5000;
  while (flow.task.status !== 'completed') { assert.ok(Date.now() < deadline, 'the first task never completed'); await sleep(5); }
  assert.ok(flow.runner.context, 'precondition: the finished task is still closing, so the runner is not released yet');
  assert.ok(flow.runner.state().activeTaskId, 'precondition: the runner still reports an active task id');
  ok('the window is open: status is completed while the runner is still held');

  const second = await dual.start({ prompt: 'Second task' });
  assert.notEqual(second.id, first.id);
  assert.equal(flow.runner.state().activeTaskId, second.id);
  ok('starting the next task in that window waits for the release instead of answering 409');

  await assert.rejects(() => dual.start({ prompt: 'Third task' }), (error) => error.statusCode === 409, 'a task that is really running still blocks a new one');
  await assert.rejects(() => flow.runner.start({ prompt: 'Third task', workspacePath: WORKSPACE }), (error) => error.code === 'task_active');
  ok('a task that is really running still answers 409 (both the Dual agent and the runner)');
} finally {
  await flow.close();
}
console.log(`PASS companion finish race: ${checks} checks`);
