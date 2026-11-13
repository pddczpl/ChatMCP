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
    secrets: [REGISTERED, SPACED], generation: 1, instanceId: 'stream-agent', locked: false, workspace: work, hooks, hooksProjectRoot: null, lifecycleAgent: null, permissions: { mode: 'review', executionPolicy: 'host-review' }, pluginManager: null,
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
// A secret the Hub knows (the manager's list): the answer the task keeps shows it as [REDACTED], and so must its pieces.
const REGISTERED = 'registered-stream-secret-0a1b2c3d';
// A secret with spaces in it: the last word of a piece is not enough to hold it.
const SPACED = 'spaced stream secret 4e5f';
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
    assert.deepEqual(stream.map((event) => [event.type, event.token ?? null]), [['token', 'Dự án '], ['token', 'là một '], ['token_reset', null], ['token', 'Dự án là một máy '], ['token', 'tính.']]);
    assert.ok(stream.every((event) => event.taskId === answer.id), 'every event names its task');
    assert.equal(answer.task.finalText, 'Dự án là một máy tính.', 'the task keeps the final answer, not the pieces');
    const lastPiece = answer.events.lastIndexOf(stream.at(-1));
    const assistant = answer.events.findIndex((event) => event.type === 'event' && event.event?.type === 'assistant');
    assert.ok(assistant > lastPiece, 'the pieces come before the event that carries the answer');
    ok('The agent forwards onToken as token events and onStreamReset as token_reset, in order, before the answer');
  }
  // A secret cut between pieces: never shown, not even its start; the pieces add up to the masked answer.
  {
    const text = `The key is ${REGISTERED} and sk-proj-0123456789abcdefXYZ, the phrase ${SPACED}. Done.`;
    const answer = await play(async (request) => {
      for (let i = 0; i < text.length; i += 5) await request.onToken(text.slice(i, i + 5));
      return { status: 'completed', usage, output: say(text) };
    });
    assert.equal(answer.task.status, 'completed', answer.task.error);
    const pieces = answer.events.filter((event) => event.type === 'token').map((event) => event.token);
    let shown = '';
    for (const piece of pieces) {
      shown += piece;
      for (const secret of [REGISTERED, 'sk-proj-0123456789abcdefXYZ', SPACED]) for (let k = 6; k <= secret.length; k += 1) assert.ok(!shown.includes(secret.slice(0, k)), `the page never shows ${JSON.stringify(secret.slice(0, k))} (it showed ${JSON.stringify(shown)})`);
    }
    assert.equal(shown, 'The key is [REDACTED] and [REDACTED], the phrase [REDACTED]. Done.', 'the pieces add up to the answer as the task keeps it');
    assert.equal(answer.task.finalText, shown, 'which is what the task kept');
    assert.ok(!answer.events.some((event) => event.type === 'token_reset'), 'no reset was needed');
    const lastPiece = answer.events.lastIndexOf(answer.events.filter((event) => event.type === 'token').at(-1));
    const assistant = answer.events.findIndex((event) => event.type === 'event' && event.event?.type === 'assistant');
    assert.ok(assistant > lastPiece, 'the held end is sent before the event that carries the answer');
    ok('A secret cut between the pieces of an answer is held and masked; the pieces add up to the masked answer, before the answer event');
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
