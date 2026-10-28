// What the agent does with a model's stream (prov-13 and after): the provider hands it the text of an answer in pieces (`onToken`), and takes back what it showed when the stream it was
// reading is cut and replaced by another request (`onStreamReset`). The agent forwards both to whoever watches the task, as `token` and `token_reset` events, and the answer the task
// keeps is the final one, never the pieces.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { HookRunner } from '../lib/hooks.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the stream agent suite exceeded its own time budget'); process.exit(2); }, 120_000).unref();

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-stream-agent-')));
const work = path.join(root, 'project');
const hubDirectory = path.join(root, 'hub');
await fs.mkdir(work, { recursive: true });
await fs.mkdir(hubDirectory, { recursive: true });

const say = (text) => [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] }];
function fakeManager(hooks) {
  return {
    secrets: [], generation: 1, instanceId: 'stream-agent', locked: false, workspace: work, hooks, hooksProjectRoot: null, lifecycleAgent: null, permissions: { mode: 'review', executionPolicy: 'host-review' }, pluginManager: null,
    state() { return { workspace: { path: work }, generation: 1, instanceId: this.instanceId }; },
    acquireTask() { if (this.locked) return false; this.locked = true; return true; },
    releaseTask() { this.locked = false; },
    async createAgentSession() {
      return {
        catalog: { tools: [{ name: 'desktop-commander.list_directory', server: 'desktop-commander', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} },
        async close() {},
        async callTool(name, args, { onDecision } = {}) { await onDecision?.({ name, category: 'read', allowed: true }); return { content: [{ type: 'text', text: '[FILE] README.md' }] }; },
      };
    },
  };
}
const hookRunner = new HookRunner({ hubDirectory, log: () => {} });

/** One run to its end with a provider whose `respond` is the given function; returns the events the runner sent and the task. */
async function play(respond, { prompt = 'What does this project do?' } = {}) {
  const events = [];
  const provider = { ready: () => true, snapshot: () => ({ provider: 'fixture', model: 'fixture' }), respond };
  const runner = new AgentRunner({ manager: fakeManager(hookRunner), provider, taskDirectory: path.join(root, 'tasks', String(Math.random()).slice(2)), toolSelectionMode: 'auto' });
  await runner.load();
  runner.subscribe((event) => events.push(event));
  const started = await runner.start({ prompt });
  const task = await Promise.race([runner.context.done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('the task did not end within 60 s')), 60_000).unref())]);
  return { events, task, id: started.id, runner };
}
const usage = { input_tokens: 1, output_tokens: 1 };

try {
  // The pieces reach the watchers in order, before the answer; a replaced stream is announced between them.
  {
    const answer = await play(async (request) => {
      await request.onToken('Dự án ');
      await request.onToken('là một ');
      await request.onStreamReset();
      await request.onToken('Dự án là một máy tính.');
      return { status: 'completed', usage, output: say('Dự án là một máy tính.') };
    });
    assert.equal(answer.task.status, 'completed', answer.task.error);
    const stream = answer.events.filter((event) => event.type === 'token' || event.type === 'token_reset');
    assert.deepEqual(stream.map((event) => [event.type, event.token ?? null]), [['token', 'Dự án '], ['token', 'là một '], ['token_reset', null], ['token', 'Dự án là một máy tính.']]);
    assert.ok(stream.every((event) => event.taskId === answer.id), 'every event names its task');
    assert.equal(answer.task.finalText, 'Dự án là một máy tính.', 'the task keeps the final answer, not the pieces');
    const lastPiece = answer.events.lastIndexOf(stream.at(-1));
    const assistant = answer.events.findIndex((event) => event.type === 'event' && event.event?.type === 'assistant');
    assert.ok(assistant > lastPiece, 'the pieces come before the event that carries the answer');
    ok('The agent forwards onToken as token events and onStreamReset as token_reset, in order, before the answer');
  }
  // A provider that never streams sends nothing of the kind.
  {
    const answer = await play(async () => ({ status: 'completed', usage, output: say('Xong.') }));
    assert.equal(answer.task.status, 'completed', answer.task.error);
    assert.equal(answer.events.some((event) => event.type === 'token' || event.type === 'token_reset'), false);
    ok('A provider that does not stream produces no token events');
  }
  // The provider is given both callbacks on every request.
  {
    const seen = [];
    await play(async (request) => { seen.push([typeof request.onToken, typeof request.onStreamReset]); return { status: 'completed', usage, output: say('Xong.') }; });
    assert.deepEqual(seen, [['function', 'function']]);
    ok('Every model request is given onToken and onStreamReset');
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(`\nPASS: ${checks} stream agent checks`);
