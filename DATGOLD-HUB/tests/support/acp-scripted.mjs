// A Hub that is a script, and the ACP agent on in-memory streams with a client that is the test: shared by the suites of the agent that need no real Hub (verify-acp-logic.mjs, verify-acp-turn.mjs).
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { createAcpAgent } from '../../lib/acp/agent.mjs';
import { createMasker } from '../../lib/acp/mask.mjs';
import { createRpcPeer } from '../../lib/acp/rpc.mjs';

export const FAKE_KEY = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX0123456789';
export const FAKE_BEARER = 'b3a1c0ffee00112233445566778899aabbccddeeff00112233445566778899aa';
export const FAKE_CSRF = 'c5rf0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const eventually = async (check, label, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) assert.fail(`timed out: ${label}`); await sleep(5); }
};

/** A Hub that is a script: the agent calls it as it would call the real one; the test says what the tasks do. */
export function scriptedHub({ owned = false } = {}) {
  let closeHub;
  const closedPromise = new Promise((resolve) => { closeHub = resolve; });
  const hub = {
    owned,
    calls: [],
    tasks: new Map(),
    active: new Set(),
    secrets: [FAKE_BEARER, FAKE_CSRF],
    stopped: 0,
    registered: [],
    startDelay: 0,
    failOn: new Map(),
    pending: [], // the approval requests the Hub holds, in the shape of /api/state studio.permissions.pending
    decisions: [],
    closeHub,
    get closed() { return closedPromise; },
    async ensureWorkspace(cwd) { hub.calls.push(['ensureWorkspace', cwd]); if (hub.failOn.has('ensureWorkspace')) throw hub.failOn.get('ensureWorkspace'); const canonical = `${cwd}#canonical`; hub.registered.push(canonical); return { path: canonical }; },
    async startTask(input) {
      hub.calls.push(['startTask', input]);
      if (hub.failOn.has('startTask')) throw hub.failOn.get('startTask');
      if (hub.startDelay) await sleep(hub.startDelay);
      const id = `00000000-0000-4000-8000-${String(hub.tasks.size + 1).padStart(12, '0')}`;
      const task = { id, state: 'running', status: 'running', finalText: '', error: null, errorCode: null, runs: [{}], workspacePath: input.workspacePath };
      hub.tasks.set(id, task); hub.active.add(id);
      return structuredClone(task);
    },
    async continueTask(input) {
      hub.calls.push(['continueTask', input]);
      if (hub.failOn.has('continueTask')) throw hub.failOn.get('continueTask');
      const task = hub.tasks.get(input.id);
      Object.assign(task, { state: 'running', status: 'running', finalText: '', error: null, errorCode: null });
      task.runs.push({}); hub.active.add(task.id);
      return structuredClone(task);
    },
    async cancelTask(id) { hub.calls.push(['cancelTask', id]); hub.pending = hub.pending.filter((request) => request.taskId !== id); const task = hub.tasks.get(id); if (task && ['running', 'waiting_approval'].includes(task.state)) hub.finish(id, { state: 'cancelled', status: 'cancelled', error: 'stopped' }); return structuredClone(task ?? null); },
    async getTask(id) { hub.calls.push(['getTask', id]); if (hub.failOn.get('getTask')) throw hub.failOn.get('getTask'); const task = hub.tasks.get(id); return task ? structuredClone(task) : null; },
    async isActive(id) { return hub.active.has(id); },
    async pendingApprovals(taskId) { hub.calls.push(['pendingApprovals', taskId]); if (hub.failOn.has('pendingApprovals')) throw hub.failOn.get('pendingApprovals'); return structuredClone(hub.pending.filter((request) => request.taskId === taskId)); },
    async decide(id, approved) { hub.calls.push(['decide', id, approved]); if (hub.failOn.has('decide')) throw hub.failOn.get('decide'); const at =hub.pending.findIndex((request) => request.id === id); if (at < 0) return false; hub.pending.splice(at, 1); hub.decisions.push({ id, approved }); return true; },
    finish(id, patch) { Object.assign(hub.tasks.get(id), patch); hub.active.delete(id); },
    async stop() { hub.stopped += 1; hub.calls.push(['stop']); },
    of(name) { return hub.calls.filter(([call]) => call === name); },
  };
  return hub;
}

/** The agent on in-memory streams, with a client that is this test. */
export function connect({ hub = scriptedHub(), options = {} } = {}) {
  const input = new PassThrough();
  const written = [];
  const logs = [];
  const output = new Writable({ write(chunk, _encoding, callback) { written.push(chunk.toString('utf8')); callback(); } });
  const peer = createRpcPeer({ input, output, log: (line) => logs.push(line), graceMs: 200 });
  const masker = createMasker({ secrets: () => hub.secrets });
  const agent = createAcpAgent({ peer, connectHub: async () => hub, masker, log: (line) => logs.push(line), version: '9.9.9', pollMs: 5, lostContactMs: 120, ...options });
  agent.attach();
  peer.start();
  let nextId = 1;
  const messages = () => written.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const send = (message) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const waiting = new Map();
  const request = (method, params) => {
    const id = nextId; nextId += 1;
    send({ id, method, params });
    return eventually(() => messages().find((m) => m.id === id && !m.method), `${method} answered`).then((m) => { waiting.delete(id); return m; });
  };
  const requestLater = (method, params) => { const id = nextId; nextId += 1; send({ id, method, params }); return { id, answer: () => eventually(() => messages().find((m) => m.id === id && !m.method), `${method} answered`) }; };
  const notify = (method, params) => send({ method, params });
  const updates = (sessionId) => messages().filter((m) => m.method === 'session/update' && (sessionId === undefined || m.params.sessionId === sessionId)).map((m) => m.params.update);
  // What the agent asks of the client, and the client's answers to it.
  const asked = (method) => messages().filter((m) => m.method === method && m.id !== undefined);
  const respond = (id, result) => send({ id, result });
  const respondError = (id, code, message) => send({ id, error: { code, message } });
  const initialize = (extra = {}) => request('initialize', { protocolVersion: 1, clientInfo: { name: 'test', version: '0' }, ...extra });
  return { hub, agent, peer, input, logs, written, messages, request, requestLater, notify, updates, initialize, asked, respond, respondError, raw: () => written.join('') };
}
