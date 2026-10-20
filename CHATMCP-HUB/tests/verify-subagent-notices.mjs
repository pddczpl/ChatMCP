// A parent agent reads what its background agents produced, and is told when one of them stops (P1-F), on the REAL AgentRunner, HubManager,
// PermissionGate and HistoryLedger, and (sections D and E) on the real ConcurrentApiAgent with real Git worktrees. The model is scripted.
//
//   C. the runner, with the endings injected at chosen moments (lib/agent.mjs): the tool is offered and answers; a polling parent is stopped by the
//      no-progress detector; a stop recorded while a model turn is in flight is told at the next boundary, behind every result of that turn and in
//      front of a queued message; a parent that waits for an approval goes on; a final answer given while an agent stops is not the last word;
//      a limit that would lose the answer wins; a parent that is not running only records, and is told once before the prompt of its next run;
//      the notice selects no tool and no skill and is not something the user asked; restart.
//   D. the pool: a parent spawns two agents, both stop, its next request carries the notice, it reads their results and its final answer is
//      built from them; the same when the parent finished first; blocked and cancelled agents; workflows; only the caller's children; a full tree.
//   E. restart of the pool.
//   F. the same notices and the tool on the wire of all four protocols (Chat Completions, Anthropic Messages, Responses, Gemini): the real runner and provider
//      against a mock server that refuses what the real API refuses.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { AgentRunner, selectConversationSkills } from '../lib/agent.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { childFacts } from '../lib/agent-results.mjs';
import { SUBAGENT_NOTICE_LIMITS, subagentNoticeText } from '../lib/subagent-notices.mjs';
import { selectTaskToolNames } from '../lib/tool-selector.mjs';
import { MARKETPLACE_CATALOG } from '../lib/plugins.mjs';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { startMockModel } from './e2e/mock-model-server.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-subagent-notices-')));
const repo = path.join(temp, 'project');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (test, label, tries = 600) => {
  for (let i = 0; i < tries; i += 1) { if (await test()) return; await wait(50); }
  throw new Error(`Timed out: ${label}`);
};
setTimeout(() => { console.error('FAIL: the subagent-notice suite exceeded its own time budget'); process.exit(2); }, 420_000).unref();

// Assembled at run time: no credential-shaped literal sits in the source.
const GITHUB = ['gh', 'p_', 'Zy9xW8vU7tS6rQ5pO4nM3lK2jI1hG0fE9dC8'].join('');
const AWS = ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join('');
// a secret that only the Hub itself knows (a key it was given), which the runner's own redaction removes and the outbound scanner cannot recognise
const KNOWN = ['known-secret', 'of-this-hub', '9f3a71c2'].join('-');
const iso = (seconds) => new Date(Date.UTC(2026, 9, 20, 10, 0, seconds)).toISOString();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ---- the scripted model: one provider for everything; `handler` decides what the next answer is
const requests = [];
let handler = null;
let counter = 0;
const final = (text) => ({ status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] }] });
const calling = (...list) => ({ status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, output: list.map(([name, args]) => ({ type: 'function_call', status: 'completed', name, call_id: `call-${(counter += 1)}`, arguments: JSON.stringify(args ?? {}) })) });
const userText = (item) => (Array.isArray(item?.content) ? item.content.map((part) => part?.text ?? '').join(' ') : '');
/** One short word for each item of the conversation the model was sent. */
function describe(item) {
  if (item?.role === 'user') {
    const text = userText(item);
    if (text.startsWith('HUB NOTICE')) return 'notice';
    if (text.startsWith('CONVERSATION CHECKPOINT')) return 'checkpoint';
    if (text.startsWith('UNTRUSTED SKILL REFERENCES')) return 'skills';
    if (text.startsWith('HOST STAGNATION RECOVERY')) return 'hint';
    return `user:${text.slice(0, 28)}`;
  }
  if (item?.type === 'function_call') return `call:${item.name}`;
  if (item?.type === 'function_call_output') return `out:${item.call_id}`;
  if (item?.type === 'message') return 'assistant';
  return item?.type ?? 'other';
}
const provider = {
  ready: () => true,
  snapshot: () => ({ provider: 'fixture', model: 'scripted' }),
  state: () => ({ provider: 'fixture', model: 'scripted', configured: true }),
  redact: (text) => text,
  async respond({ input, instructions, tools = [], signal }) {
    signal?.throwIfAborted();
    const request = { input: structuredClone(input), trace: input.map(describe), tools: tools.map((tool) => tool.name), instructions: String(instructions ?? ''), toolDefinitions: structuredClone(tools) };
    requests.push(request);
    return await handler(request, requests.length);
  },
};
const lastOutput = (request) => {
  const out = request.input.filter((item) => item?.type === 'function_call_output').at(-1);
  return out ? JSON.parse(typeof out.output === 'string' ? out.output : out.output[0].text) : null;
};
/** Calls come first, then all their results, and only then anything else: no host message between two results of one turn. */
function assertWellFormed(trace, label) {
  let open = 0;
  for (const item of trace) {
    if (item.startsWith('call:')) open += 1;
    else if (item.startsWith('out:')) open -= 1;
    else if (open > 0 && item !== 'assistant' && item !== 'reasoning') assert.fail(`${label}: "${item}" stands between a call and its result: ${trace.join(' | ')}`);
    assert.ok(open >= 0, `${label}: a result without a call: ${trace.join(' | ')}`);
  }
  assert.equal(open, 0, `${label}: a call without a result: ${trace.join(' | ')}`);
}
async function scan(directory, needles) {
  const found = [];
  let files = 0;
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      const text = await fs.readFile(full, 'utf8').catch(() => '');
      files += 1;
      for (const needle of needles) if (text.includes(needle) || text.includes(JSON.stringify(needle).slice(1, -1))) found.push(`${path.relative(directory, full)}:${needle.slice(0, 8)}`);
    }
  };
  await walk(directory);
  return { files, found };
}
const stopSummary = (n, extra = {}) => ({ id: uuid(n), key: `${iso(50 + n)}|completed`, goal: `Goal ${n}: inspect part ${n}`, role: null, workflow: null, status: 'completed', errorCode: null, finishedAt: iso(50 + n), ...extra });
const settle = async (runner, id, label = 'the run settles') => until(() => runner.get(id).status !== 'running' && runner.activeTaskId === null, label);

let manager; let pool;
try {
  await fs.mkdir(repo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'chatmcp-ci@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'ChatMCP CI'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'README.md'), '# Subagent notice fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
  manager = new HubManager({ bundleRoot, dataDirectory: path.join(temp, 'hub'), log: () => {} });
  await manager.load(repo);
  manager.registerSecret(KNOWN);
  assembleStudio(manager, { bundleRoot });
  await manager.permissions.load();
  manager.permissions.mode = 'autonomous';
  await manager.startLocal(repo);

  // =========================================================================================================================================== C. the runner
  const tasksDirectory = path.join(temp, 'hub', 'api-tasks-c');
  const runner = new AgentRunner({ manager, provider, taskDirectory: tasksDirectory, log: () => {}, toolSelectionMode: 'full' });
  await runner.load();
  let facts = [];
  manager.spawnAllowed = () => true;
  manager.listSubagents = () => facts;
  const reset = () => { requests.length = 0; };

  // ---- C1 the tool is offered, answers, reads only the caller's children, and a bad call is a recoverable error
  {
    reset();
    facts = [
      childFacts({ record: { id: uuid(1), prompt: 'Goal 1: inspect part 1', createdAt: iso(1) }, detail: { id: uuid(1), status: 'completed', startedAt: iso(2), finishedAt: iso(42), finalText: `Part 1 is fine. ${GITHUB} ${AWS} ${KNOWN}`, steps: 3, toolCalls: 2, usage: { httpRequests: 3 } } }),
      childFacts({ record: { id: uuid(2), prompt: 'Goal 2: inspect part 2', createdAt: iso(2) }, detail: { id: uuid(2), status: 'running', state: 'running', startedAt: iso(3), steps: 1 } }),
      // the Hub's own secret starts a few characters before the end of the first page of this text
      childFacts({ record: { id: uuid(3), prompt: 'Goal 3: a long report', createdAt: iso(3) }, detail: { id: uuid(3), status: 'completed', startedAt: iso(4), finishedAt: iso(44), finalText: `${'z'.repeat(7990)} ${KNOWN} and more text after it` } }),
    ];
    let pendingDuringCall = null;
    const realList = manager.listSubagents;
    manager.listSubagents = (taskId) => { pendingDuringCall = runner.tasks.get(taskId)?.pendingCall ?? pendingDuringCall; return realList(taskId); };
    handler = (request, n) => {
      if (n === 1) return calling(['agent_results', {}]);
      if (n === 2) return calling(['agent_results', { ids: [uuid(2), uuid(99), '../../etc/passwd'] }]);
      if (n === 3) return calling(['agent_results', { offset: 5 }]);
      if (n === 4) return calling(['agent_results', { limit: 3 }]);
      if (n === 5) return calling(['agent_results', { ids: [uuid(3)] }]);
      return final('read them');
    };
    const started = await runner.start({ prompt: 'Look at what the agents did.' });
    await settle(runner, started.id);
    assert.equal(runner.get(started.id).status, 'completed');
    assert.ok(requests[0].tools.includes('agent_results'), 'offered');
    assert.match(requests[0].instructions, /BACKGROUND AGENT RESULTS/, 'and explained');
    assert.equal(requests[0].toolDefinitions.find((tool) => tool.name === 'agent_results').strict, false);
    const [all, named, badOffset, badKey] = [1, 2, 3, 4].map((n) => lastOutput(requests[n]));
    assert.equal(all.isError, false);
    const view = all.structuredContent.children;
    assert.deepEqual(view.map((child) => child.id), [uuid(1), uuid(2), uuid(3)]);
    assert.match(view[0].claim.text, /^Part 1 is fine\. \[REDACTED:github-token\] \[REDACTED:aws-access-key-id\] \[REDACTED\]$/, 'the claim the model reads is redacted: the scanner\'s shapes and the Hub\'s own secret');
    assert.equal(view[0].claim.verifiedByHub, false);
    assert.equal(view[1].claim, null);
    const straddle = lastOutput(requests[5]).structuredContent.children[0].claim;
    assert.equal(straddle.truncated, true);
    assert.equal(straddle.text.includes(KNOWN.slice(0, 8)), false, `no half of the Hub's own secret where the page ends: ${straddle.text.slice(7950, 8010)}`);
    assert.equal(named.structuredContent.children.filter((child) => child.found).length, 1, 'only the caller\'s child answers');
    assert.deepEqual(named.structuredContent.children.slice(1).map((child) => child.found), [false, false]);
    for (const bad of [badOffset, badKey]) { assert.equal(bad.isError, true); assert.equal(bad.executed, false); assert.equal(bad.error.code, 'invalid_arguments'); }
    assert.match(badOffset.error.message, /exactly one id/); assert.match(badKey.error.message, /not: limit/);
    assert.equal(pendingDuringCall?.readOnly, true, 'while it runs, the call is recorded as read-only: a stop during it is not an unknown outcome');
    assert.equal(pendingDuringCall?.toolName, 'chatmcp.agent_results');
    const events = runner.get(started.id).events;
    assert.equal(events.filter((event) => event.type === 'tool_result' && event.toolName === 'chatmcp.agent_results').length, 3);
    assert.equal(events.filter((event) => event.type === 'tool_error' && event.toolName === 'agent_results').length, 2, 'a bad call is an ordinary recoverable tool error');
    assert.equal(runner.get(started.id).state, 'completed', 'and not an uncertain run');
    const files = await scan(path.join(tasksDirectory, started.id), [GITHUB, AWS, KNOWN]);
    assert.ok(files.files >= 3 && files.found.length === 0, `no credential in the parent's own task files (${files.files} files): ${files.found}`);
    for (const request of requests) assert.equal([GITHUB, AWS, KNOWN].some((secret) => JSON.stringify(request.input).includes(secret)), false, 'and none reached the model');
    ok('C1 the tool: offered with its explanation, answers with the caller\'s children only, the model reads the claim redacted (scanner shapes and the Hub\'s own secret), a bad call is a recoverable error, the call is recorded read-only while it runs, no credential in the parent\'s files or in any request');
  }

  // ---- C2 offered or not
  {
    reset();
    handler = (request, n) => (n === 1 ? calling(['agent_results', {}]) : final('done'));
    manager.spawnAllowed = () => false; facts = [];
    const none = await runner.start({ prompt: 'No agents here, no spawning.' });
    await settle(runner, none.id);
    assert.equal(requests[0].tools.includes('agent_results'), false, 'a task that cannot spawn and has no agent is not offered it');
    assert.equal(lastOutput(requests[1]).error.code, 'unknown_function', 'and a call to it is an ordinary unknown function');
    reset();
    facts = [childFacts({ record: { id: uuid(1), prompt: 'Goal', createdAt: iso(1) }, detail: { id: uuid(1), status: 'completed', finalText: 'x' } })];
    const full = await runner.start({ prompt: 'The tree is full, but one agent exists.' });
    await settle(runner, full.id);
    assert.ok(requests[0].tools.includes('agent_results'), 'a task whose tree is full still has to read its agents');
    manager.spawnAllowed = () => true;
    reset();
    delete manager.listSubagents;
    handler = () => final('plain');
    const plain = await runner.start({ prompt: 'A manager that has no agents at all.' });
    await settle(runner, plain.id);
    assert.equal(requests[0].tools.includes('agent_results'), false, 'a manager without listSubagents (every runner that is not the pool\'s) never offers it');
    manager.listSubagents = () => facts;
    ok('C2 offered where the Hub can spawn or the task has agents; never to a task that has neither, nor to a manager that has no agents to list');
  }

  // ---- C3 a polling parent is what the no-progress detector says it is
  {
    reset();
    facts = [childFacts({ record: { id: uuid(1), prompt: 'Goal', createdAt: iso(1) }, detail: { id: uuid(1), status: 'running', state: 'running', startedAt: iso(2), steps: 2 } })];
    handler = () => calling(['agent_results', {}]);
    const polling = await runner.start({ prompt: 'Keep asking how the agent is doing.' });
    await settle(runner, polling.id, 'the polling parent is stopped');
    const task = runner.get(polling.id);
    assert.equal(task.status, 'failed'); assert.equal(task.errorCode, 'progress_stalled');
    assert.equal(requests.length, 11, 'eleven identical calls: the first is new, the next ten add nothing');
    assert.equal(requests[10].trace.filter((item) => item === 'hint').length, 2, 'a recovery hint at four repeats and another at seven are in the history of the last request');
    assert.equal(requests[4].trace.includes('hint'), false); assert.equal(requests[5].trace.filter((item) => item === 'hint').length, 1);
    assert.equal(task.events.filter((event) => event.type === 'progress_recovery' || event.type === 'progress_warning').length, 2);
    const first = requests[1].input.at(-1).output, last = requests[10].input.at(-1).output;
    assert.equal(first, last, 'the answer was the same bytes every time (nothing in it depends on the clock)');
    ok('C3 a parent that polls an unchanged child gets two recovery hints and is stopped as stalled after eleven identical answers: the tool is not a way around the no-progress detector');
  }

  // ---- C4 a stop recorded while a turn is running is told behind every result of that turn
  {
    reset();
    facts = [];
    let injected = false;
    const off = runner.subscribe((event) => {
      // between the first and the second result of the same model turn
      if (!injected && event.type === 'event' && event.event?.type === 'tool_result') { injected = true; void runner.recordSubagentFinished(event.taskId, stopSummary(1)); }
    });
    handler = (request, n) => (n === 1 ? calling(['list_directory', {}], ['read_file', { path: 'README.md' }], ['list_directory', {}]) : final('Three things done, and I saw the notice.'));
    const running = await runner.start({ prompt: 'Look around the project.' });
    await settle(runner, running.id);
    off();
    const task = runner.get(running.id);
    assert.equal(injected, true);
    const second = requests[1].trace;
    assertWellFormed(second, 'request 2');
    const results = second.filter((item) => item.startsWith('out:')).length;
    assert.equal(results, 3);
    assert.equal(second.at(-1), 'notice', `the notice follows the LAST result of the turn: ${second.join(' | ')}`);
    assert.equal(second.filter((item) => item === 'notice').length, 1);
    assert.equal(requests.length, 2, 'the model was told before its second request and answered it');
    assert.equal(task.finalText, 'Three things done, and I saw the notice.');
    const entry = task.subagentNotices.find((e) => e.id === uuid(1));
    assert.equal(entry.notice, 'delivered'); assert.equal(entry.deliveredRun, 1);
    assert.deepEqual(task.events.map((event) => event.type).filter((type) => type.startsWith('subagent_')), ['subagent_finished', 'subagent_notice']);
    const noticeText = requests[1].input.at(-1).content[0].text;
    assert.match(noticeText, new RegExp(`${uuid(1)}: sent its final answer`));
    assert.doesNotMatch(noticeText, /Goal 1: inspect part 1.*Part/s, 'and nothing of the agent\'s output');
    assert.equal(task.promptCount, 1); assert.deepEqual(task.dialogue.filter((entry) => entry.role === 'user').map((entry) => entry.text), ['Look around the project.'], 'the notice is not something the user said');
    ok('C4 running parent: an ending recorded between two results of one model turn is delivered once, after the last result, as a host message (not a user prompt), in the very next request; the entry says delivered in run 1');
  }

  // ---- C5 ordering at one boundary: the recovery hint that waited, then the notice, then the message the user queued
  {
    reset();
    facts = [childFacts({ record: { id: uuid(1), prompt: 'Goal', createdAt: iso(1) }, detail: { id: uuid(1), status: 'running', state: 'running', startedAt: iso(2) } })];
    let step = 0;
    handler = async (request, n) => {
      step = n;
      if (n <= 5) return calling(['agent_results', {}]); // the fifth identical answer makes the Hub write a recovery hint behind it
      return final('ordered');
    };
    let queued = false;
    const off = runner.subscribe((event) => {
      if (!queued && step === 5 && event.type === 'event' && (event.event?.type === 'progress_warning' || event.event?.type === 'progress_recovery')) {
        queued = true;
        void runner.recordSubagentFinished(event.taskId, stopSummary(7));
        void runner.enqueueMessage({ id: event.taskId, prompt: 'Also tell me the time zone.' });
      }
    });
    const started = await runner.start({ prompt: 'Poll, but I will interrupt.' });
    await settle(runner, started.id);
    off();
    assert.equal(queued, true);
    const sixth = requests[5].trace;
    assertWellFormed(sixth, 'request 6');
    assert.deepEqual(sixth.slice(-3), ['hint', 'notice', 'user:Also tell me the time zone.'], `at one boundary: the host message that waited, the notice, then what the user queued: ${sixth.join(' | ')}`);
    ok('C5 ordering at one boundary: the recovery hint that waited behind the results, then the notice, then the message the user queued last');
  }

  // ---- C6 a parent that waits for an approval goes on; the notice comes after the answer
  {
    reset();
    facts = [];
    manager.permissions.mode = 'review';
    handler = (request, n) => (n === 1 ? calling(['write_file', { path: 'note.txt', content: 'hello\n' }]) : n === 2 ? final('Written, and I saw the notice.') : final('unexpected'));
    const waiting = await runner.start({ prompt: 'Write a note for me.' });
    await until(() => manager.permissions.state().pending.some((p) => p.taskId === waiting.id), 'the approval request');
    assert.equal(runner.get(waiting.id).state, 'waiting_approval');
    await runner.recordSubagentFinished(waiting.id, stopSummary(3));
    assert.equal(requests.length, 1, 'nothing was sent to the model while the person is being asked');
    assert.equal(runner.get(waiting.id).subagentNotices[0].notice, 'recorded');
    assert.equal(runner.get(waiting.id).state, 'waiting_approval', 'and the wait is not disturbed');
    const request = manager.permissions.state().pending.find((p) => p.taskId === waiting.id);
    manager.permissions.decide(request.id, true);
    await settle(runner, waiting.id);
    manager.permissions.mode = 'autonomous';
    const task = runner.get(waiting.id);
    assert.equal(task.status, 'completed');
    assert.equal(requests[1].trace.at(-1), 'notice', `after the result: ${requests[1].trace.join(' | ')}`);
    assertWellFormed(requests[1].trace, 'request 2');
    assert.equal(requests.length, 2, 'the run went on after the approval; its next request carried the notice and the answer to it ended the run');
    assert.equal(task.subagentNotices[0].notice, 'delivered');
    assert.equal((await fs.readFile(path.join(repo, 'note.txt'), 'utf8')).trim(), 'hello', 'and the approved call really ran');
    ok('C6 waiting parent: the Hub records the ending while a tool call waits for approval and sends nothing; after the answer the run continues and the very next request tells the model, behind the tool result');
  }

  // ---- C7 a final answer is not the last word when an agent stops while it is being written
  {
    reset();
    facts = [];
    handler = async (request, n) => {
      if (n === 1) { await runner.recordSubagentFinished(runner.activeTaskId, stopSummary(4)); return final('First answer, written while an agent stopped.'); }
      return final('Second answer, after the notice.');
    };
    const started = await runner.start({ prompt: 'Answer quickly.' });
    await settle(runner, started.id);
    const task = runner.get(started.id);
    assert.equal(requests.length, 2, 'the run did not end on the first final answer');
    assert.deepEqual(requests[1].trace.slice(-3), ['user:Answer quickly.', 'assistant', 'notice']);
    assert.equal(task.finalText, 'Second answer, after the notice.');
    assert.deepEqual(task.dialogue.filter((entry) => entry.role === 'assistant').map((entry) => entry.text), ['First answer, written while an agent stopped.', 'Second answer, after the notice.'], 'both answers are in the conversation, in order');
    assert.equal(task.subagentNotices[0].notice, 'delivered');
    assert.equal(task.steps, 2);
    ok('C7 final answer in flight: an agent that stops while the answer is written is not lost; the run continues, the model is told behind its answer, and answers again');
  }

  // ---- C8 but not when no further turn is possible
  {
    reset();
    facts = [];
    handler = async (request, n) => { await runner.recordSubagentFinished(runner.activeTaskId, stopSummary(5)); return final('The only answer.'); };
    const started = await runner.start({ prompt: 'One step only.', maxSteps: 1 });
    await settle(runner, started.id);
    const task = runner.get(started.id);
    assert.equal(task.status, 'completed', 'the answer that was given stands (a step-limit failure would lose it)');
    assert.equal(task.finalText, 'The only answer.'); assert.equal(requests.length, 1);
    assert.equal(task.subagentNotices[0].notice, 'recorded', 'the ending stays recorded for the next run');
    reset();
    handler = (request, n) => final('Next run.');
    await runner.continue({ id: started.id, prompt: 'Go on.' });
    await settle(runner, started.id);
    assert.deepEqual(requests[0].trace.slice(-2), ['notice', 'user:Go on.'], `the next run is told, before its prompt: ${requests[0].trace.join(' | ')}`);
    assert.equal(runner.get(started.id).subagentNotices[0].deliveredRun, 2);
    ok('C8 a step limit that would lose the answer wins: the answer stands, the ending is kept for the next run, which tells the model before its prompt');
  }

  // ---- C8b endings that keep arriving cannot keep the model answering for ever
  {
    reset();
    facts = [];
    let round = 0;
    handler = async () => {
      round += 1;
      await runner.recordSubagentFinished(runner.activeTaskId, stopSummary(2000 + round)); // a new agent stops during every answer
      return final(`answer ${round}`);
    };
    const started = await runner.start({ prompt: 'Answer, and answer again.' });
    await settle(runner, started.id, 'the run ends although an agent stops during every answer');
    const task = runner.get(started.id);
    const bound = SUBAGENT_NOTICE_LIMITS.entries;
    assert.equal(task.status, 'completed'); assert.equal(requests.length, bound + 1, `one extra turn for each of the ${bound} endings that a task keeps entries for, and the last answer stands`);
    assert.equal(task.finalText, `answer ${bound + 1}`);
    assert.equal(task.subagentNotices.filter((entry) => entry.notice === 'recorded').length, 1, 'the ending that arrived during the last answer stays recorded for the next run');
    assert.equal(task.subagentNotices.length, bound);
    ok(`C8b a source of endless endings: each ending held back one final answer, at most as many as a task keeps entries (${bound}), then the answer stands and the last ending waits for the next run`);
  }

  // ---- C9 a parent that is not running only records; the next run tells it once, before the prompt
  {
    reset();
    facts = [];
    handler = () => final('Finished first.');
    const finished = await runner.start({ prompt: 'Start the agents and finish.' });
    await settle(runner, finished.id);
    const before = requests.length; const eventsBefore = runner.get(finished.id).events.length;
    assert.equal(runner.activeTaskId, null);
    assert.equal(await runner.recordSubagentFinished(finished.id, stopSummary(1)), true);
    assert.equal(await runner.recordSubagentFinished(finished.id, stopSummary(1)), false, 'the same ending twice');
    assert.equal(await runner.recordSubagentFinished(finished.id, stopSummary(2, { status: 'failed', errorCode: 'step_limit', key: `${iso(60)}|failed` })), true);
    assert.equal(await runner.recordSubagentFinished('00000000-0000-4000-8000-0000000000aa', stopSummary(3)), false, 'a task the runner does not have');
    assert.equal(await runner.recordSubagentFinished(finished.id, { ...stopSummary(4), id: 'nope' }), false);
    assert.equal(requests.length, before, 'no model request: nothing is started for a parent that finished');
    assert.equal(runner.activeTaskId, null);
    const task = runner.get(finished.id);
    assert.equal(task.status, 'completed', 'the parent is still what it was');
    assert.deepEqual(task.subagentNotices.map((entry) => [entry.id, entry.notice, entry.status]), [[uuid(1), 'recorded', 'completed'], [uuid(2), 'recorded', 'failed']], 'visible in its state');
    const added = task.events.slice(eventsBefore).map((event) => event.type);
    assert.deepEqual(added, ['subagent_finished', 'subagent_finished'], 'and in its events, once each');
    assert.match(task.events.at(-1).message, /không đang chạy/, 'which say that nothing is running');
    const summary = runner.state().tasks.find((entry) => entry.id === finished.id);
    assert.equal(summary.subagentNotices.length, 2, 'the list of tasks carries them too');
    // the next run
    reset();
    handler = (request, n) => final('Here is the answer.');
    await runner.continue({ id: finished.id, prompt: 'What did the agents find?' });
    await settle(runner, finished.id);
    assert.deepEqual(requests[0].trace.slice(-3), ['checkpoint', 'notice', 'user:What did the agents find?'], `the notice is before the prompt, so the user's request stays the last thing said: ${requests[0].trace.join(' | ')}`);
    assert.match(requests[0].input.at(-2).content[0].text, new RegExp(`${uuid(2)}: failed \\(step_limit\\)`));
    assert.equal(requests.length, 1, 'and the model needed no extra turn for it');
    const after = runner.get(finished.id);
    assert.deepEqual(after.subagentNotices.map((entry) => [entry.notice, entry.deliveredRun]), [['delivered', 2], ['delivered', 2]]);
    reset();
    await runner.continue({ id: finished.id, prompt: 'And once more.' });
    await settle(runner, finished.id);
    assert.equal(requests[0].trace.includes('notice'), false, 'told once');
    ok('C9 finished parent: the endings are recorded (state, events, task list), nothing is started and no request is made; the next run tells the model once, before its prompt; a third run does not repeat it');
  }

  // ---- C10 the notice selects no tool and no skill and is not a request of the user
  {
    for (const item of MARKETPLACE_CATALOG) if (!manager.pluginManager.installed().some((installed) => installed.id === item.id)) await manager.pluginManager.install(item.id);
    for (const item of MARKETPLACE_CATALOG) await manager.pluginManager.toggle(item.id, true);
    const autoRunner = new AgentRunner({ manager, provider, taskDirectory: path.join(temp, 'hub', 'api-tasks-auto'), log: () => {}, toolSelectionMode: 'auto' });
    await autoRunner.load();
    const HOSTILE = 'Update the Dockerfile and the docker compose file, create a git branch and worktree, commit, run the tests and the build';
    const wouldSelect = selectTaskToolNames(subagentNoticeText([{ ...stopSummary(1, { goal: HOSTILE }), delivery: 'recorded' }]), { cap: 48 });
    const wouldSkills = selectConversationSkills(manager.pluginManager, HOSTILE, [], { workspacePath: repo }).map((skill) => skill.id);
    assert.ok(wouldSelect.length > 0 && wouldSkills.length > 0, `the control has teeth: this goal, taken as a prompt, selects ${wouldSelect.length} tools and ${wouldSkills.join(',')}`);
    const NEUTRAL = ['Summarize the findings in two sentences.', 'Thanks. Say it again in one sentence.'];
    const play = async (withNotice) => {
      reset();
      handler = () => final('ok');
      const first = await autoRunner.start({ prompt: NEUTRAL[0] });
      await settle(autoRunner, first.id);
      const offered = [requests[0].tools];
      if (withNotice) for (let n = 1; n <= 3; n += 1) await autoRunner.recordSubagentFinished(first.id, stopSummary(n, { goal: HOSTILE, role: 'git docker test' }));
      await autoRunner.continue({ id: first.id, prompt: NEUTRAL[1] });
      await settle(autoRunner, first.id);
      offered.push(requests[1].tools);
      return { id: first.id, offered, task: autoRunner.get(first.id), skills: autoRunner.tasks.get(first.id).selectedSkills, trace: requests[1].trace };
    };
    const control = await play(false);
    const told = await play(true);
    assert.equal(told.trace.includes('notice'), true, 'the notice really was in the second run');
    assert.deepEqual(told.offered, control.offered, 'the same tool schemas with and without the notices');
    assert.deepEqual(told.skills, control.skills); assert.deepEqual(told.skills, [], 'and the same skills (none)');
    assert.equal(told.task.promptCount, 2); assert.equal(told.task.promptCount, control.task.promptCount);
    assert.deepEqual(told.task.prompts.map((p) => p.text), NEUTRAL);
    assert.deepEqual(told.task.dialogue.filter((entry) => entry.role === 'user').map((entry) => entry.text), NEUTRAL, 'the dialogue holds only what the user said');
    const onDisk = JSON.parse(await fs.readFile(path.join(temp, 'hub', 'api-tasks-auto', told.id, 'task.json'), 'utf8'));
    assert.equal(onDisk.carriedPrompts, undefined); assert.ok(onDisk.prompts.every((p) => p.selectionText === undefined), 'nothing was stored as text to select on');
    assert.equal(JSON.stringify(onDisk.prompts).includes('Dockerfile'), false);
    ok('C10 no selection and no request: taking the notice as a prompt would select tools and skills, yet with three notices full of such words the next run is offered exactly the tools and skills of the control, and prompts, dialogue and promptCount hold only what the user said');
  }

  // ---- C11 restart: the state is in task.json, nothing is sent again
  {
    const directory = path.join(temp, 'hub', 'api-tasks-restart');
    const first = new AgentRunner({ manager, provider, taskDirectory: directory, log: () => {}, toolSelectionMode: 'full' });
    await first.load();
    reset();
    handler = () => final('Done before the agents.');
    const started = await first.start({ prompt: 'Spawn and finish.' });
    await settle(first, started.id);
    await first.recordSubagentFinished(started.id, stopSummary(1));
    await first.recordSubagentFinished(started.id, stopSummary(2));
    const eventsBefore = first.get(started.id).events.length;
    // restart 1: the Hub is gone and comes back
    const second = new AgentRunner({ manager, provider, taskDirectory: directory, log: () => {}, toolSelectionMode: 'full' });
    await second.load();
    const loaded = second.get(started.id);
    assert.deepEqual(loaded.subagentNotices.map((entry) => entry.notice), ['recorded', 'recorded'], 'the state survived');
    assert.equal(loaded.events.length, eventsBefore, 'and loading made no new event and no request');
    assert.equal(requests.length, 1);
    reset();
    handler = () => final('Told after the restart.');
    await second.continue({ id: started.id, prompt: 'Report.' });
    await settle(second, started.id);
    assert.equal(requests[0].trace.filter((item) => item === 'notice').length, 1, 'told once, in one message for both');
    // restart 2: it was told, and it stays told
    const third = new AgentRunner({ manager, provider, taskDirectory: directory, log: () => {}, toolSelectionMode: 'full' });
    await third.load();
    assert.deepEqual(third.get(started.id).subagentNotices.map((entry) => [entry.notice, entry.deliveredRun]), [['delivered', 2], ['delivered', 2]]);
    reset();
    await third.continue({ id: started.id, prompt: 'Report again.' });
    await settle(third, started.id);
    assert.equal(requests[0].trace.includes('notice'), false, 'nothing is replayed');
    // a task file edited by hand or written by another version
    const file = path.join(directory, started.id, 'task.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.subagentNotices = [{ id: 'junk' }, null, 'x', { ...data.subagentNotices[0], goal: 'g'.repeat(100_000), delivery: 'maybe' }, ...Array.from({ length: 500 }, (_, n) => ({ ...data.subagentNotices[0], id: uuid(100 + n), recordedAt: iso(n) }))];
    await fs.writeFile(file, JSON.stringify(data));
    const fourth = new AgentRunner({ manager, provider, taskDirectory: directory, log: () => {}, toolSelectionMode: 'full' });
    await fourth.load();
    const bounded = fourth.get(started.id).subagentNotices;
    assert.ok(bounded.length <= 64 && bounded.every((entry) => entry.goal.length <= 160), `bounded: ${bounded.length}`);
    data.subagentNotices = 'not a list'; await fs.writeFile(file, JSON.stringify(data));
    const fifth = new AgentRunner({ manager, provider, taskDirectory: directory, log: () => {}, toolSelectionMode: 'full' });
    await fifth.load();
    assert.deepEqual(fifth.get(started.id).subagentNotices, []);
    ok('C11 restart: the entries survive in task.json, loading sends and records nothing, the next run tells the model once and a later restart does not tell it again; a task file with junk or a flood in that field loads as a bounded list');
  }

  // ---- C12 a run that was cut off with an ending unread still tells the next run
  {
    const directory = path.join(temp, 'hub', 'api-tasks-crash');
    const first = new AgentRunner({ manager, provider, taskDirectory: directory, log: () => {}, toolSelectionMode: 'full' });
    await first.load();
    reset();
    let release; const hang = new Promise((resolve) => { release = resolve; });
    handler = async (request, n) => { await hang; throw Object.assign(new Error('cut'), { code: 'user_cancelled' }); };
    const started = await first.start({ prompt: 'A run that the Hub loses.' });
    await until(() => requests.length === 1, 'the request is in flight');
    await first.recordSubagentFinished(started.id, stopSummary(1));
    const copy = path.join(temp, 'hub', 'api-tasks-crash-copy');
    await fs.cp(directory, copy, { recursive: true });
    const crashed = JSON.parse(await fs.readFile(path.join(copy, started.id, 'task.json'), 'utf8'));
    assert.equal(crashed.status, 'running', 'the copy is what a crash leaves: a running task');
    release();
    await first.cancel(started.id).catch(() => {});
    const second = new AgentRunner({ manager, provider, taskDirectory: copy, log: () => {}, toolSelectionMode: 'full' });
    await second.load();
    const loaded = second.get(started.id);
    assert.equal(loaded.status, 'paused'); assert.equal(loaded.errorCode, 'process_interrupted');
    assert.equal(loaded.subagentNotices[0].notice, 'recorded', 'the ending was recorded and not told');
    reset();
    handler = () => final('Resumed.');
    await second.continue({ id: started.id, prompt: 'Carry on.' });
    await settle(second, started.id);
    assert.deepEqual(requests[0].trace.slice(-3), ['checkpoint', 'notice', 'user:Carry on.'], 'the run after the crash tells the model');
    ok('C12 a run lost in a crash with an ending unread: the task comes back paused with the entry still recorded, and its next run tells the model');
  }

  // =========================================================================================================================================== D. the pool
  const primary = new AgentRunner({ manager, provider, taskDirectory: path.join(temp, 'hub', 'api-tasks'), log: () => {}, toolSelectionMode: 'full' });
  await primary.load();
  pool = new ConcurrentApiAgent({ primary, manager, provider, bundleRoot, directory: path.join(temp, 'hub', 'api-conversations'), log: () => {} });
  manager.spawnBackgroundAgent = (parentId, request) => pool.spawnAgent(parentId, request);
  manager.spawnWorkflow = (parentId, request) => pool.spawnWorkflow(parentId, request);
  assert.equal(typeof manager.listSubagents, 'function');
  const ownerOf = (request) => {
    const text = request.input.filter((item) => item?.role === 'user').map(userText).filter((value) => !value.startsWith('UNTRUSTED SKILL')).join(' ');
    return /(Parent|Child|Grand)\s?(\w+):/.exec(text)?.[0].replace(/:$/, '') ?? 'unknown';
  };
  const tokens = new Map();
  const tokenOf = (name) => { if (!tokens.has(name)) tokens.set(name, `TOKEN-${randomUUID().slice(0, 8).toUpperCase()}`); return tokens.get(name); };
  const gate = new Map();
  const closed = (name) => { let open; const promise = new Promise((resolve) => { open = resolve; }); gate.set(name, { promise, open }); return promise; };
  const childAnswer = (name) => final(`${name} report: ${tokenOf(name)}. ${name === 'Child C2' ? `Also, its key is ${GITHUB}.` : ''}`);

  // ---- D1 the plan criterion: the real result of a subagent appears in the parent's output
  {
    reset();
    let parentId = null;
    handler = async (request, n) => {
      const who = ownerOf(request);
      if (who.startsWith('Child')) return childAnswer(who);
      // the parent
      const mine = requests.filter((entry) => ownerOf(entry) === 'Parent P1').length;
      if (mine === 1) return calling(['spawn_agent', { goal: 'Child C1: inspect the readme' }], ['spawn_agent', { goal: 'Child C2: inspect the license' }]);
      if (mine === 2) {
        parentId = pool.primary.activeTaskId;
        await until(() => (pool.get(parentId)?.subagentNotices ?? []).length === 2, 'both endings are recorded on the parent');
        return calling(['list_directory', {}]);
      }
      if (mine === 3) return calling(['agent_results', {}]);
      // build the answer only from what the tool returned
      const out = lastOutput(request);
      const parts = out.structuredContent.children.map((child) => `${child.goal.split(':')[0]} -> ${/TOKEN-[A-Z0-9]+/.exec(child.claim.text)?.[0]} (${child.status}, Hub receipts ${child.hubRecord.shaCheckedEdits})`);
      return final(`Combined: ${parts.join(' ; ')}`);
    };
    const parent = await pool.start({ prompt: 'Parent P1: start two agents and report what they found.' });
    parentId = parent.id;
    await until(() => pool.get(parent.id)?.status === 'completed', 'the parent finishes', 400);
    const mine = requests.filter((entry) => ownerOf(entry) === 'Parent P1');
    assert.equal(mine.length, 4);
    for (const [index, request] of mine.entries()) assertWellFormed(request.trace, `parent request ${index + 1}`);
    assert.ok(mine[0].tools.includes('agent_results') && mine[0].tools.includes('spawn_agent'));
    assert.equal(mine[1].trace.includes('notice'), false, 'request 2 carries the spawn results and no notice');
    assert.equal(mine[2].trace.at(-1), 'notice', `request 3 carries the notice, behind the result of the call before it: ${mine[2].trace.join(' | ')}`);
    assert.equal(mine[2].trace.filter((item) => item === 'notice').length, 1, 'one message for both agents');
    const notice = mine[2].input.at(-1).content[0].text;
    assert.match(notice, /2 background agents you started have stopped/);
    assert.match(notice, /Child C1: inspect the readme/); assert.match(notice, /Child C2: inspect the license/);
    assert.doesNotMatch(notice, /TOKEN-/, 'the notice itself carries nothing the agents wrote');
    assert.equal(mine[3].trace.at(-1).startsWith('out:'), true);
    const read = lastOutput(mine[3]).structuredContent;
    assert.equal(read.total, 2);
    assert.deepEqual(read.children.map((child) => child.status), ['completed', 'completed']);
    assert.ok(read.children.every((child) => child.claim.verifiedByHub === false && child.startedAt && child.finishedAt && child.durationMs >= 0));
    assert.ok(read.children.every((child) => child.hubRecord.steps >= 1 && child.hubRecord.branch?.startsWith('chatmcp/chat/')), 'the Hub\'s record: its steps and its branch');
    const answer = pool.get(parent.id).finalText;
    assert.ok(answer.includes(tokenOf('Child C1')) && answer.includes(tokenOf('Child C2')), `the parent's output carries the real result of both agents: ${answer}`);
    assert.ok(read.children[1].claim.text.includes('[REDACTED:github-token]') && !JSON.stringify(mine[3].input).includes(GITHUB), 'and the credential one of them printed did not reach the parent\'s model');
    const task = pool.get(parent.id);
    assert.deepEqual(task.subagentNotices.map((entry) => entry.notice), ['delivered', 'delivered']);
    for (const entry of task.subagentNotices) {
      const child = pool.get(entry.id);
      assert.ok(child.finishedAt && entry.finishedAt === child.finishedAt, `the ending is noted when the child has settled, with the time it finished: ${entry.finishedAt} / ${child.finishedAt}`);
      assert.equal(entry.status, child.status);
    }
    assert.deepEqual(task.events.map((event) => event.type).filter((type) => type.startsWith('subagent_')), ['subagent_finished', 'subagent_finished', 'subagent_notice']);
    assert.deepEqual(task.dialogue.filter((entry) => entry.role === 'user').map((entry) => entry.text), ['Parent P1: start two agents and report what they found.']);
    const files = await scan(path.join(temp, 'hub', 'api-tasks', parent.id), [GITHUB]);
    assert.ok(files.files >= 3 && files.found.length === 0, `the parent's own files hold no credential: ${files.found}`);
    const childFiles = await scan(path.join(temp, 'hub', 'api-conversations'), [GITHUB]);
    if (childFiles.found.length) console.log(`  note - the child's own task files keep the credential-shaped text as the child wrote it (${childFiles.found.length} file(s)); this is how the Hub already stored a final message, and only the parent's view is filtered`);
    ok('D1 the plan criterion: a parent spawns two agents, both stop while it works, its next request carries ONE notice behind the last result, it reads their results through agent_results and its final answer is built from what the tool returned (tokens the agents made up, a credential one of them printed is gone)');
  }

  // ---- D2 the parent finishes first; the agents stop later
  {
    reset();
    closed('Child C3'); closed('Child C4');
    handler = async (request, n) => {
      const who = ownerOf(request);
      if (who.startsWith('Child')) { await gate.get(who).promise; return childAnswer(who); }
      const mine = requests.filter((entry) => ownerOf(entry) === 'Parent P2').length;
      if (mine === 1) return calling(['spawn_agent', { goal: 'Child C3: first part' }], ['spawn_agent', { goal: 'Child C4: second part' }]);
      if (mine === 2) return final('Both agents are started; I will not claim any result yet.');
      if (mine === 3) return calling(['agent_results', {}]);
      const parts = lastOutput(request).structuredContent.children.map((child) => `${/TOKEN-[A-Z0-9]+/.exec(child.claim?.text ?? '')?.[0] ?? 'none'}`);
      return final(`After the notice: ${parts.join(' and ')}`);
    };
    const parent = await pool.start({ prompt: 'Parent P2: start two agents and finish.' });
    await until(() => pool.get(parent.id)?.status === 'completed', 'the parent finishes first');
    await until(() => pool.primary.activeTaskId === null, 'the parent released the workspace');
    const mineBefore = requests.filter((entry) => ownerOf(entry) === 'Parent P2').length;
    assert.equal(mineBefore, 2);
    assert.equal(pool.get(parent.id).finalText, 'Both agents are started; I will not claim any result yet.');
    // the agents are still waiting for the model; open them
    gate.get('Child C3').open(); gate.get('Child C4').open();
    await until(() => (pool.get(parent.id)?.subagentNotices ?? []).length === 2, 'both endings are recorded on the finished parent');
    const task = pool.get(parent.id);
    assert.equal(task.status, 'completed'); assert.equal(task.state, 'completed');
    assert.deepEqual(task.subagentNotices.map((entry) => entry.notice), ['recorded', 'recorded']);
    assert.equal(requests.filter((entry) => ownerOf(entry) === 'Parent P2').length, mineBefore, 'the parent was not run again by an ending');
    assert.equal(pool.primary.activeTaskId, null, 'and nothing is running for it');
    assert.equal(task.events.filter((event) => event.type === 'subagent_finished').length, 2);
    assert.ok(task.events.filter((event) => event.type === 'subagent_finished').every((event) => /không đang chạy/.test(event.message)));
    // the user comes back
    await pool.continue({ id: parent.id, prompt: 'Parent P2: what did they find?' });
    await until(() => pool.get(parent.id)?.runs?.length === 2 && pool.get(parent.id)?.status === 'completed', 'the second run');
    const second = requests.filter((entry) => ownerOf(entry) === 'Parent P2').slice(mineBefore);
    assert.equal(second.length, 2);
    assert.deepEqual(second[0].trace.slice(-3), ['checkpoint', 'notice', `user:${'Parent P2: what did they find?'.slice(0, 28)}`], second[0].trace.join(' | '));
    const answer = pool.get(parent.id).finalText;
    assert.ok(answer.includes(tokenOf('Child C3')) && answer.includes(tokenOf('Child C4')), `after the user comes back, the parent's output carries the real results: ${answer}`);
    assert.deepEqual(pool.get(parent.id).subagentNotices.map((entry) => [entry.notice, entry.deliveredRun]), [['delivered', 2], ['delivered', 2]]);
    ok('D2 the parent finished first: the endings are only recorded (state and events, no run, no request); when the user comes back the model is told before the prompt and the answer is built from the real results');
  }

  // ---- D3 an agent that never ran: blocked by a failed dependency, and cancelled while queued
  {
    reset();
    closed('Child C5');
    handler = async (request) => {
      const who = ownerOf(request);
      if (who === 'Child C5') { await gate.get(who).promise; throw Object.assign(new Error('provider exploded'), { code: 'provider_down', statusCode: 502 }); }
      if (who.startsWith('Child')) return childAnswer(who);
      const mine = requests.filter((entry) => ownerOf(entry) === 'Parent P3').length;
      if (mine === 1) return calling(['spawn_agent', { goal: 'Child C5: will fail' }]);
      return final('started');
    };
    const parent = await pool.start({ prompt: 'Parent P3: one agent that fails, one that depends on it.' });
    await until(() => pool.get(parent.id)?.status === 'completed', 'parent P3 finishes');
    const c5 = [...pool.records.values()].find((record) => record.parentTaskId === parent.id);
    const dependent = await pool.spawnAgent(parent.id, { goal: 'Child C6: needs C5', dependsOn: [c5.id] });
    const queued = await pool.spawnAgent(parent.id, { goal: 'Child C7: waits for C5 too', dependsOn: [c5.id] });
    await pool.cancel(queued.id);
    await until(() => (pool.get(parent.id)?.subagentNotices ?? []).some((entry) => entry.id === queued.id), 'the cancelled queued agent is recorded');
    gate.get('Child C5').open();
    await until(() => (pool.get(parent.id)?.subagentNotices ?? []).length === 3, 'all three endings are recorded');
    const byId = Object.fromEntries(pool.get(parent.id).subagentNotices.map((entry) => [entry.id, entry]));
    assert.equal(byId[c5.id].status, 'failed'); assert.equal(byId[dependent.id].status, 'blocked'); assert.equal(byId[queued.id].status, 'cancelled');
    assert.equal(byId[c5.id].goal, 'Child C5: will fail');
    // reading them
    handler = async (request) => { const mine = requests.filter((entry) => ownerOf(entry) === 'Parent P3').length; return mine % 2 ? calling(['agent_results', {}]) : final('read'); };
    reset();
    await pool.continue({ id: parent.id, prompt: 'Parent P3: report.' });
    await until(() => pool.get(parent.id)?.runs?.length === 2 && pool.get(parent.id)?.status === 'completed', 'the second run of P3');
    const text = requests.find((entry) => ownerOf(entry) === 'Parent P3').input.map(userText).find((value) => value.startsWith('HUB NOTICE'));
    assert.match(text, /3 background agents you started have stopped/);
    assert.match(text, /did not start, because an agent it depends on did not finish/); assert.match(text, /was stopped/); assert.match(text, /: failed/);
    const read = lastOutput(requests.filter((entry) => ownerOf(entry) === 'Parent P3').at(-1)) ?? lastOutput(requests.at(-1));
    const children = Object.fromEntries(read.structuredContent.children.map((child) => [child.id, child]));
    assert.equal(children[dependent.id].claim, null); assert.equal(children[dependent.id].status, 'blocked');
    assert.match(children[dependent.id].hubRecord.error, /dependency/); assert.deepEqual(children[dependent.id].hubRecord.dependsOn, [c5.id]);
    assert.equal(children[queued.id].status, 'cancelled');
    assert.equal(children[c5.id].status, 'failed'); assert.equal(children[c5.id].hubRecord.errorCode, 'provider_down'); assert.match(children[c5.id].hubRecord.error, /provider exploded/);
    ok('D3 an agent that failed, one that was blocked by it and one cancelled while queued: each is an ending with its own words ("did not start", "was stopped", "failed"), and agent_results shows the Hub\'s error and no claim for the ones that never answered');
  }

  // ---- D4 only the caller's children; a grandchild belongs to its own parent
  {
    reset();
    handler = async (request) => {
      const who = ownerOf(request);
      const mine = requests.filter((entry) => ownerOf(entry) === who).length;
      if (who === 'Parent P4') {
        if (mine === 1) return calling(['spawn_agent', { goal: 'Child C8: has a helper' }]);
        if (mine === 2) { await until(() => (pool.get(pool.primary.activeTaskId)?.subagentNotices ?? []).length === 1, 'child C8 stopped'); return calling(['list_directory', {}]); }
        if (mine === 3) {
          const grand = [...pool.records.values()].find((record) => /Grand G1/.test(record.prompt));
          return calling(['agent_results', { ids: [grand.id, uuid(777)] }], ['agent_results', {}]);
        }
        const outs = request.input.filter((item) => item?.type === 'function_call_output').slice(-2).map((item) => JSON.parse(item.output));
        return final(JSON.stringify({ named: outs[0].structuredContent.children.map((c) => c.found), all: outs[1].structuredContent.children.map((c) => c.goal.split(':')[0]) }));
      }
      if (who === 'Child C8') {
        if (mine === 1) return calling(['spawn_agent', { goal: 'Grand G1: the helper of C8' }]);
        if (mine === 2) { await until(() => (pool.get([...pool.records.values()].find((record) => /Child C8/.test(record.prompt)).id)?.subagentNotices ?? []).length === 1, 'the grandchild stopped'); return calling(['agent_results', {}]); }
        const out = lastOutput(request).structuredContent;
        return final(`C8 saw ${out.children.map((child) => `${child.goal.split(':')[0]}=${/TOKEN-[A-Z0-9]+/.exec(child.claim.text)?.[0]}`).join(',')}`);
      }
      return childAnswer(who);
    };
    const parent = await pool.start({ prompt: 'Parent P4: one agent that has its own helper.' });
    await until(() => pool.get(parent.id)?.status === 'completed', 'parent P4 finishes');
    const out = JSON.parse(pool.get(parent.id).finalText);
    assert.deepEqual(out.named, [false, false], 'the grandchild and a stranger are not the parent\'s children: found:false');
    assert.deepEqual(out.all, ['Child C8'], 'and the list holds the parent\'s own child only');
    const c8 = [...pool.records.values()].find((record) => /Child C8/.test(record.prompt));
    const grandRecord = [...pool.records.values()].find((record) => /Grand G1/.test(record.prompt));
    assert.equal(grandRecord.parentTaskId, c8.id);
    assert.match(pool.get(c8.id).finalText, new RegExp(`C8 saw Grand G1=${tokenOf('Grand G1')}`), 'the child read its own helper\'s result');
    assert.equal(pool.get(c8.id).subagentNotices[0].id, grandRecord.id, 'the notice of the helper went to the child, not to the root');
    assert.deepEqual(pool.get(parent.id).subagentNotices.map((entry) => entry.id), [c8.id], 'and the root was told about its own child only');
    ok('D4 a grandchild belongs to its own parent: the root\'s agent_results does not show it (found:false) and the root is told only about its child, which was told about its helper');
  }

  // ---- D5 a workflow: roles and phases are part of what the parent reads
  {
    reset();
    handler = async (request) => {
      const who = ownerOf(request);
      const mine = requests.filter((entry) => ownerOf(entry) === who).length;
      if (who === 'Parent P5') {
        if (mine === 1) return calling(['spawn_workflow', { name: 'Two-pass audit', phases: [{ name: 'Review', agents: [{ role: 'Security', goal: 'Child C9: review security' }, { role: 'Correctness', goal: 'Child C10: review correctness' }] }, { name: 'Verify', agents: [{ role: 'Independent verifier', goal: 'Child C11: check the reviews' }] }] }]);
        if (mine === 2) { await until(() => (pool.get(pool.primary.activeTaskId)?.subagentNotices ?? []).length === 3, 'the workflow finished', 400); return calling(['agent_results', {}]); }
        return final(JSON.stringify(lastOutput(request).structuredContent.children.map((child) => [child.role, child.workflow, child.status])));
      }
      return childAnswer(who);
    };
    const parent = await pool.start({ prompt: 'Parent P5: run a two-pass audit.' });
    await until(() => pool.get(parent.id)?.status === 'completed', 'parent P5 finishes', 800);
    const rows = JSON.parse(pool.get(parent.id).finalText).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    assert.deepEqual(rows, [['Correctness', { name: 'Two-pass audit', phase: 'Review' }, 'completed'], ['Independent verifier', { name: 'Two-pass audit', phase: 'Verify' }, 'completed'], ['Security', { name: 'Two-pass audit', phase: 'Review' }, 'completed']]);
    const notice = pool.get(parent.id).subagentNotices;
    assert.equal(notice.length, 3); assert.ok(notice.every((entry) => entry.workflow?.startsWith('Two-pass audit / ')));
    assert.deepEqual(notice.map((entry) => entry.role).sort(), ['Correctness', 'Independent verifier', 'Security']);
    ok('D5 workflow: every agent of a workflow is an ending of its parent with its role, workflow and phase, and agent_results carries them');
  }

  // ---- D6 a full tree still reads its agents
  {
    reset();
    await pool.configureSpawnLimits({ maxSpawnDescendants: 0 });
    handler = (request) => (requests.length === 1 ? calling(['agent_results', {}]) : final('read'));
    const parent = await pool.start({ prompt: 'Parent P6: nothing to spawn.' });
    await until(() => pool.get(parent.id)?.status === 'completed', 'parent P6');
    assert.equal(requests[0].tools.includes('agent_results'), false, 'no child, and no room to spawn: no tool');
    assert.equal(requests[0].tools.includes('spawn_agent'), false);
    await pool.configureSpawnLimits({ maxSpawnDescendants: 1 });
    handler = async (request) => { const who = ownerOf(request); return who.startsWith('Child') ? childAnswer(who) : requests.filter((entry) => ownerOf(entry) === 'Parent P7').length === 1 ? calling(['spawn_agent', { goal: 'Child C12: the only one' }]) : final('started'); };
    const full = await pool.start({ prompt: 'Parent P7: fill the tree.' });
    await until(() => pool.get(full.id)?.status === 'completed', 'parent P7');
    await until(() => (pool.get(full.id)?.subagentNotices ?? []).length === 1, 'its agent stops');
    assert.equal(pool.spawnAllowed(full.id), false, 'the tree is full');
    reset();
    handler = (request) => (requests.length === 1 ? calling(['agent_results', {}]) : final(`read ${lastOutput(request).structuredContent.total}`));
    await pool.continue({ id: full.id, prompt: 'Parent P7: read it.' });
    await until(() => pool.get(full.id)?.runs?.length === 2 && pool.get(full.id)?.status === 'completed', 'second run of P7');
    assert.ok(requests[0].tools.includes('agent_results') && !requests[0].tools.includes('spawn_agent'), 'a full tree is offered the reader and not the spawner');
    assert.equal(pool.get(full.id).finalText, 'read 1');
    await pool.configureSpawnLimits({ maxSpawnDescendants: 16 });
    ok('D6 a full tree: a task that cannot spawn any more but has an agent is still offered agent_results (and not spawn_agent); one with neither is offered neither');
  }

  // ---- D7 an agent that fails before it ever starts: no runner reports that ending, the pool's own catch does
  {
    reset();
    handler = () => final('Finished before the agent was made.');
    const parent = await pool.start({ prompt: 'Parent P8: nothing to spawn myself.' });
    await until(() => pool.get(parent.id)?.status === 'completed', 'parent P8');
    // the pool's own entry point for a child, with a base branch that does not exist: the worktree cannot be made
    const child = await pool.start({ prompt: 'Child C13: needs a branch that does not exist', parentTaskId: parent.id, baseRef: 'refs/heads/does-not-exist' });
    await until(() => (pool.get(parent.id)?.subagentNotices ?? []).some((entry) => entry.id === child.id), 'the failed start is recorded on the parent');
    const entry = pool.get(parent.id).subagentNotices.find((item) => item.id === child.id);
    assert.deepEqual([entry.status, entry.notice, entry.goal], ['failed', 'recorded', 'Child C13: needs a branch that does not exist']);
    const fact = pool.listSubagents(parent.id).find((item) => item.id === child.id);
    assert.equal(fact.status, 'failed'); assert.equal(fact.finalText, null); assert.match(fact.error, /branch no longer exists/i);
    assert.equal(pool.primary.activeTaskId, null, 'and nothing ran for the parent');
    ok('D7 an agent that fails before it starts (its base branch is gone, so no worktree and no runner): the pool\'s own catch records the ending on the parent, with the Hub\'s error and no claim');
  }

  // =========================================================================================================================================== E. restart of the pool
  {
    const persisted = [...pool.records.values()].filter((record) => record.parentTaskId).length;
    const parentRecord = pool.primary.state().tasks.find((task) => /Parent P1/.test(task.prompt));
    const before = pool.get(parentRecord.id);
    const beforeFacts = pool.listSubagents(parentRecord.id).map((fact) => ({ id: fact.id, status: fact.status, finalText: fact.finalText, finishedAt: fact.finishedAt, steps: fact.steps }));
    const eventsBefore = before.events.length;
    await pool.shutdown();
    await manager.shutdown().catch(() => {});
    // restart: new objects over the same folders
    const manager2 = new HubManager({ bundleRoot, dataDirectory: path.join(temp, 'hub'), log: () => {} });
    await manager2.load(repo);
    assembleStudio(manager2, { bundleRoot });
    await manager2.permissions.load();
    manager2.permissions.mode = 'autonomous';
    await manager2.startLocal(repo);
    manager2.pluginManager = manager.pluginManager;
    const primary2 = new AgentRunner({ manager: manager2, provider, taskDirectory: path.join(temp, 'hub', 'api-tasks'), log: () => {}, toolSelectionMode: 'full' });
    reset();
    const pool2 = new ConcurrentApiAgent({ primary: primary2, manager: manager2, provider, bundleRoot, directory: path.join(temp, 'hub', 'api-conversations'), log: () => {} });
    manager2.spawnBackgroundAgent = (parentId, request) => pool2.spawnAgent(parentId, request);
    manager2.spawnWorkflow = (parentId, request) => pool2.spawnWorkflow(parentId, request);
    await pool2.load();
    assert.equal([...pool2.records.values()].filter((record) => record.parentTaskId).length, persisted, 'every agent record came back');
    const after = pool2.get(parentRecord.id);
    assert.deepEqual(after.subagentNotices, before.subagentNotices, 'the parent\'s entries came back exactly as they were');
    assert.equal(after.events.length, eventsBefore, 'loading made no event');
    assert.equal(requests.length, 0, 'and no model request');
    const afterFacts = pool2.listSubagents(parentRecord.id).map((fact) => ({ id: fact.id, status: fact.status, finalText: fact.finalText, finishedAt: fact.finishedAt, steps: fact.steps }));
    assert.deepEqual(afterFacts, beforeFacts, 'what agent_results reads came back too: same status, same final message, same times');
    handler = async (request) => { const mine = requests.length; return mine === 1 ? calling(['agent_results', {}]) : final(`restarted, ${lastOutput(request).structuredContent.shown} agents`); };
    await pool2.continue({ id: parentRecord.id, prompt: 'Parent P1: still there after a restart?' });
    await until(() => pool2.get(parentRecord.id)?.runs?.length === 2 && pool2.get(parentRecord.id)?.status === 'completed', 'a run after the restart');
    assert.equal(requests[0].trace.includes('notice'), false, 'both endings had been told before the restart: nothing is told again');
    assert.equal(pool2.get(parentRecord.id).finalText, 'restarted, 2 agents');
    await pool2.shutdown();
    ok('E the pool restarts: the records, the parent\'s entries and what agent_results reads all come back as they were; loading made no event and no request; an ending that was told before the restart is not told again');
  }

  // =========================================================================================================================================== F. the four wire formats
  {
    const wireRoot = path.join(temp, 'wire');
    await fs.mkdir(wireRoot, { recursive: true });
    const listing = { content: [{ type: 'text', text: '[FILE] README.md' }] };
    const wireFacts = [childFacts({ record: { id: uuid(1), prompt: 'Goal 1: inspect part 1', createdAt: iso(1) }, detail: { id: uuid(1), status: 'completed', startedAt: iso(2), finishedAt: iso(42), finalText: 'Part 1 is fine.', steps: 2 } })];
    const listDirectory = () => ({ name: 'mcp_call', args: { name: 'desktop-commander.list_directory', arguments_json: JSON.stringify({ path: wireRoot }) } });
    const NOTICE = 'HUB NOTICE';
    const times = (haystack, needle) => haystack.split(needle).length - 1;
    for (const [format, api] of [['openai-chat', 'chat'], ['anthropic', 'anthropic'], ['openai-responses', 'responses'], ['gemini', 'gemini']]) {
      const wireManager = {
        secrets: [], generation: 1, instanceId: `wire-${api}`, locked: false,
        state() { return { workspace: { path: wireRoot }, generation: 1, instanceId: this.instanceId }; },
        acquireTask() { if (this.locked) return false; this.locked = true; return true; },
        releaseTask() { this.locked = false; },
        spawnAllowed: () => true, listSubagents: () => wireFacts,
        async createAgentSession() {
          return {
            catalog: { tools: [{ name: 'desktop-commander.list_directory', server: 'desktop-commander', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} },
            async close() {},
            async callTool(name, args, { onDecision } = {}) { await onDecision?.({ name, category: 'read', allowed: true }); return listing; },
          };
        },
      };
      const bodies = [];
      let runnerOfWire = null; let step = 0;
      const wire = await startMockModel({ scenario: 'wire', strict: true, scenarios: {
        wire: async () => {
          step += 1;
          bodies.push(JSON.stringify(wire.state.lastBody));
          // 1: an agent stops while the request is in flight; the model answers with two calls -> the notice must follow BOTH results
          if (step === 1) { await runnerOfWire.recordSubagentFinished(runnerOfWire.activeTaskId, stopSummary(1)); return { calls: [listDirectory(), listDirectory()] }; }
          if (step === 2) return { calls: [{ name: 'agent_results', args: {} }] };
          // 3: another agent stops while the FINAL answer is written -> the run goes on; the notice follows the answer
          if (step === 3) { await runnerOfWire.recordSubagentFinished(runnerOfWire.activeTaskId, stopSummary(2)); return { text: 'First answer.' }; }
          if (step === 4) return { text: 'Second answer.' };
          return { text: 'Done.' };
        },
      } });
      try {
        const gateway = new GatewayProvider({ directory: path.join(wireRoot, `gateway-${api}`), bundleRoot, manager: wireManager, env: {} });
        const wireProvider = gateway.forkForTask({ protocol: format, apiBaseUrl: wire.origin, model: 'mock-coder' });
        runnerOfWire = new AgentRunner({ manager: wireManager, provider: wireProvider, taskDirectory: path.join(wireRoot, `tasks-${api}`), log: () => {} });
        await runnerOfWire.load();
        const started = await runnerOfWire.start({ prompt: 'Look at the project and read what the agents found.' });
        await settle(runnerOfWire, started.id, `${api}: the first run`);
        assert.equal(runnerOfWire.get(started.id).status, 'completed', `${api}: ${runnerOfWire.get(started.id).error ?? ''} ${JSON.stringify(wire.state.rejections.at(-1)?.errors?.[0] ?? null)}`);
        // 5: a finished parent: the ending is recorded and the next run tells the model before its prompt
        await runnerOfWire.recordSubagentFinished(started.id, stopSummary(3));
        await runnerOfWire.continue({ id: started.id, prompt: 'And now?' });
        await settle(runnerOfWire, started.id, `${api}: the continued run`);
        assert.equal(runnerOfWire.get(started.id).status, 'completed');
        assert.equal(wire.state.requests.length, 5, `${api}: five model requests`);
        assert.deepEqual(wire.state.requests.map((request) => request.rejected), Array(5).fill(null), `${api}: the strict server refused nothing the Hub sent: ${JSON.stringify(wire.state.rejections.at(-1)?.errors?.[0] ?? null)}`);
        assert.ok(wire.state.requests.every((request) => request.tools.includes('agent_results')), `${api}: the tool was declared in a form this protocol accepts, in every request`);
        // the two results first, then the notice
        assert.equal(times(bodies[1], NOTICE), 1, `${api}: request 2 carries one notice`);
        assert.ok(bodies[1].lastIndexOf('[FILE] README.md') < bodies[1].indexOf(NOTICE), `${api}: and it follows both results`);
        // the tool's answer round-trips on this wire
        assert.ok(bodies[2].includes('Part 1 is fine.') && bodies[2].includes('verifiedByHub'), `${api}: the answer of agent_results reached the model`);
        // the second notice follows the first final answer
        assert.equal(times(bodies[3], NOTICE), 2, `${api}: request 4 carries both notices`);
        assert.ok(bodies[3].indexOf('First answer.') < bodies[3].lastIndexOf(NOTICE), `${api}: and the second follows the answer that was already given`);
        // the continued run: checkpoint, notice, prompt
        assert.equal(times(bodies[4], NOTICE), 1, `${api}: the continued run carries the notice of the finished parent once`);
        const [checkpointAt, noticeAt, promptAt] = ['CONVERSATION CHECKPOINT', NOTICE, 'And now?'].map((needle) => bodies[4].indexOf(needle));
        assert.ok(checkpointAt >= 0 && checkpointAt < noticeAt && noticeAt < promptAt, `${api}: checkpoint, then the notice, then the prompt (${checkpointAt} < ${noticeAt} < ${promptAt})`);
        if (api === 'chat') assert.deepEqual(JSON.parse(bodies[1]).messages.slice(-4).map((message) => message.role), ['assistant', 'tool', 'tool', 'user'], 'Chat: the notice follows BOTH results');
        if (api === 'anthropic') assert.deepEqual(JSON.parse(bodies[1]).messages.at(-1).content.map((block) => block.type), ['tool_result', 'tool_result', 'text'], 'Anthropic: both results lead the user message, the notice follows');
        if (api === 'responses') assert.deepEqual(JSON.parse(bodies[1]).input.slice(-5).map((item) => item.type ?? item.role), ['function_call', 'function_call', 'function_call_output', 'function_call_output', 'user']);
        if (api === 'gemini') assert.deepEqual(JSON.parse(bodies[1]).contents.at(-1).parts.map((part) => Object.keys(part)[0]), ['functionResponse', 'functionResponse', 'text'], 'Gemini: both responses lead the user turn, the notice follows');
      } finally {
        await runnerOfWire?.shutdown().catch(() => {});
        await wire.close();
      }
    }
    ok('F the wire: the tool declaration, a notice behind the results of a turn, a notice behind a final answer given while an agent stops, and a notice before the prompt of a continued run are all accepted by the strict mock of Chat Completions, Anthropic Messages, Responses and Gemini through the real runner and provider, in the order the Hub means');
  }
} finally {
  try { await pool?.shutdown?.(); } catch { /* best effort */ }
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch(() => {});
}

console.log(`PASS: ${checks} checks (the runner and the pool tell a parent about its agents)`);
process.exit(0);
