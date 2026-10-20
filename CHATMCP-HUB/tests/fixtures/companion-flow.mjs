// The real BrowserRunner, driven the way the extension drives it: start -> poll -> claim -> sent -> reply (a fenced JSON block)
// -> poll again. Only the tool server is a stand-in (`tools`): a function per tool name that returns what the server would. The
// manager around it is the smallest object the runner needs; nothing between the tool result and the message the extension
// receives is replaced, so a test sees exactly what chatgpt.com would be handed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserRunner } from '../../lib/browser-runner.mjs';

export const CHAT_URL = 'https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b';
const EXTENSION_ID = 'a'.repeat(32);

/** What a model reads out of the message text: the task id, the turn it must answer and the nonce. */
export function envelopeOf(text) {
  const task = /task=([0-9a-f-]{36})/.exec(text)?.[1] ?? /task ([0-9a-f-]{36})/.exec(text)?.[1];
  const turn = Number(/(?:turn=|CURRENT_TURN=)(\d+)/.exec(text)?.[1]);
  const nonce = /nonce=([0-9a-f]{48})/.exec(text)?.[1] ?? /"nonce":"([0-9a-f]{48})"/.exec(text)?.[1];
  return { task, turn, nonce };
}

export async function makeFlow({ tools = {}, workspace = 'F:\\workspace\\demo', reviewTimeoutMs = 600_000, registeredSecrets = [], reviewBeforeSend = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-companion-flow-'));
  const calls = [];
  const state = { workspace: { path: workspace }, generation: 1, instanceId: 'instance-1' };
  const catalogTools = [...Object.keys(tools)].map((name) => ({ name, description: name, server: name.split('.')[0] }));
  const manager = {
    secrets: [...registeredSecrets], workspace, instanceId: 'hub-test',
    state: () => structuredClone(state),
    registerSecret(value) { this.secrets.push(value); },
    acquireTask() {}, releaseTask() {},
    async createAgentSession() {
      return {
        catalog: { tools: catalogTools, servers: {}, prompts: [], resources: [] },
        async callTool(name, args) { calls.push({ name, args }); return tools[name](args); },
        async close() {},
      };
    },
  };
  const runner = new BrowserRunner({ manager, directory, reviewTimeoutMs });
  await runner.load();
  if (reviewBeforeSend) await runner.configurePrivacy({ reviewBeforeSend: true });
  const clientId = randomUUID();
  const { code } = await runner.createPairCode();
  await runner.pair({ code, clientId, extensionId: EXTENSION_ID });

  const flow = {
    runner, directory, calls, manager, clientId, tools,
    task: null, context: null,
    async start(options) {
      const task = await runner.start(options);
      flow.task = runner.tasks.get(task.id);
      flow.context = runner.context;
      return flow.task;
    },
    /** What the extension sees: poll, then claim and confirm the send. Returns the message exactly as the Hub handed it over. */
    async deliver() {
      const taskId = flow.task.id;
      const polled = await runner.poll({ clientId, taskId });
      assert.ok(polled.message, 'poll() offered no message');
      const claimed = await runner.claim({ clientId, taskId, messageId: polled.message.id });
      assert.deepEqual(claimed.message, polled.message, 'claim() and poll() hand over the same message');
      await runner.sent({ clientId, taskId, messageId: polled.message.id, url: CHAT_URL });
      return polled.message;
    },
    /** What chatgpt.com answers: one fenced JSON block that echoes the identifiers it read in the message. */
    async reply(message, body) {
      const identity = envelopeOf(message.text);
      const block = `\`\`\`json\n${JSON.stringify({ chatmcp_hub: 'v1', task: identity.task, turn: identity.turn, nonce: identity.nonce, ...body })}\n\`\`\``;
      await runner.reply({ clientId, taskId: flow.task.id, messageId: message.id, replyId: randomUUID(), text: block, blocks: [block], url: CHAT_URL });
      await flow.context.work;
    },
    /** deliver + reply for the first message, which must be a plain instruction */
    async poll() { return runner.poll({ clientId, taskId: flow.task.id }); },
    async close() {
      try { if (runner.context) await runner.cancel(runner.context.task.id); } catch { /* already finished */ }
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
  return flow;
}

/** A tool result in the shape MCP servers return. */
export const textResult = (text) => ({ content: [{ type: 'text', text }] });
