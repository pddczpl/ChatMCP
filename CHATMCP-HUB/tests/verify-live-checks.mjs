// The two checks in tests/live/ ask the REAL Anthropic API whether the thinking-block rules the Hub relies on hold (docs/ARCHITECTURE.md, "Khối suy luận của Anthropic (prov-18)"). They need
// a key and spend money, so CI never runs them. A tool that is never run rots: when the Hub's provider changes its shape, the check would break the next time the owner pays for it. This suite
// runs both of them, offline and with no key, against stand-ins for the API, and checks what they say and what they return:
//   1. check-anthropic-thinking.mjs against a small imitation of the Messages API, in the answers an account can give: a thinking block is required or not, the prefix binding is enforced or
//      not, the model never thinks, the control request fails, the key is refused and the API echoes it back.
//   2. check-anthropic-hub-adapter.mjs against the Hub's strict mock (thinking blocks signed for the conversation they were issued in): both modes, a model that never thinks, redacted blocks.
//   3. Negative controls: ONE defect at a time goes into a copy of the Hub's lib/ and check 2 must report it (the repeat without blocks is switched off, the digest ignores the system prompt,
//      the blocks are damaged on the way back) or call it a note (the Hub never sends blocks back).
// Both scripts must also refuse to start with no key, and never print the key. The imitations only copy the SHAPES of the answers: this proves the scripts' own logic, not Anthropic's behaviour.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockModel } from './e2e/mock-model-server.mjs';
import { call, redacted, sequence, thinking } from './e2e/scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(here, '..');
const CHECK_API = path.join(here, 'live', 'check-anthropic-thinking.mjs');
const CHECK_HUB = path.join(here, 'live', 'check-anthropic-hub-adapter.mjs');
const KEY = 'sk-ant-api03-TESTKEY-DO-NOT-PRINT-1234567890';
// A token for a gateway has any shape; only the exact text of it can be scrubbed, so a token that does not look like an Anthropic key is what proves that the scripts scrub the secret they were given.
const TOKEN = 'gw_9f8e7d6c5b4a3210_PLAIN_TOKEN_DO_NOT_PRINT';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

/** Runs a script as a child process with a made-up key (or none, or a token) and returns what it printed and its exit code. A script that hangs is killed. */
function run(script, args, { key = KEY, token = '', timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: token } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { output += '\n(killed after ' + timeoutMs / 1000 + ' s)'; child.kill(); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ output, code }); });
  });
}
const tail = (text) => (text.length > 6000 ? '...' + text.slice(-6000) : text);
/** Checks that hold for every run: the key is never printed, not even a part of it. */
function neverPrintsTheKey(output, label) {
  assert.ok(!output.includes(KEY), `${label}: the key was printed`);
  assert.ok(!/TESTKEY/.test(output), `${label}: a part of the key was printed`);
  assert.ok(!output.includes(TOKEN), `${label}: the token was printed`);
  assert.ok(!/PLAIN_TOKEN/.test(output), `${label}: a part of the token was printed`);
}

// ------------------------------------------------------------------------------------------------------------------------------- 1. check 1, against an imitation of the API
const THINK = { type: 'thinking', thinking: '', signature: 'SIG-' + 'A'.repeat(40) };
const TOOL = { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Hanoi' } };
const answer = (content, extra = {}) => ({ status: 200, body: { id: 'msg_x', type: 'message', role: 'assistant', content, stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 50 }, ...extra } });
const refusal = (status, type, message) => ({ status, body: { type: 'error', error: { type, message }, request_id: 'req_err' } });

/** Which of the five requests of check 1 this is, from what it carries. */
function classify(request, body) {
  if (body.messages.length === 1) return 'mint';
  const assistant = body.messages[1].content;
  const hasThinking = assistant.some((block) => block.type === 'thinking' || block.type === 'redacted_thinking');
  const edited = String(body.messages[0].content).includes('one short sentence');
  if (request.headers['anthropic-beta']) return 'drop_block';
  if (edited) return 'edited';
  return hasThinking ? 'control' : 'without';
}

async function imitation(name, behave, expectations, { token = '' } = {}) {
  const seen = [];
  let mintCount = 0;
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      const kind = classify(request, body);
      if (kind === 'mint') mintCount += 1;
      seen.push({ kind, thinking: body.thinking, beta: request.headers['anthropic-beta'], auth: request.headers['x-api-key'] ? 'x-api-key' : request.headers.authorization ? 'bearer' : 'none', version: request.headers['anthropic-version'] });
      const reply = behave(kind, body, mintCount, request);
      response.writeHead(reply.status, { 'content-type': 'application/json', 'request-id': 'req_' + kind + '_' + mintCount });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { output, code } = await run(CHECK_API, ['--base-url', 'http://127.0.0.1:' + server.address().port], token ? { key: '', token } : {});
  server.close();
  try {
    neverPrintsTheKey(output, name);
    expectations({ output, code, seen });
  } catch (error) {
    throw new Error(`${name}: ${error.message}\n----- output -----\n${tail(output)}`);
  }
  ok(name);
}

console.log('1. check-anthropic-thinking.mjs against an imitation of the API');
await imitation('S1 a block is required, the account enforces the binding, drop_block works', (kind) => ({
  mint: answer([THINK, TOOL]),
  control: answer([{ type: 'text', text: 'Take an umbrella.' }]),
  without: refusal(400, 'invalid_request_error', 'messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`. When `thinking` is enabled, a final `assistant` message must start with a thinking block.'),
  edited: refusal(400, 'invalid_request_error', 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".'),
  drop_block: answer([{ type: 'text', text: 'ok' }], { input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }] }),
}[kind]), ({ output, code, seen }) => {
  assert.equal(code, 0);
  assert.match(output, /\[3\/5\][^\n]*\n\s+-> HTTP 400/);
  assert.match(output, /RESULT: step 3 returned 400 and drop_block works/);
  assert.match(output, /ENFORCES the prefix binding/);
  assert.match(output, /thinking_dropped/);
  assert.deepEqual(seen.map((entry) => entry.kind), ['mint', 'control', 'without', 'edited', 'drop_block']);
  assert.equal(seen[0].thinking, undefined, 'the first try sends no thinking field, as the Hub does');
  assert.equal(seen[0].auth, 'x-api-key');
  assert.equal(seen[0].version, '2023-06-01');
  assert.deepEqual(seen[4].thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.equal(seen[4].beta, 'thinking-binding-controls-2026-08-01');
  assert.match(output, /request ids/);
});
await imitation('S2 no block is required, the account does not enforce the binding', (kind) => ({
  mint: answer([THINK, TOOL]),
  control: answer([{ type: 'text', text: 'a' }]),
  without: answer([{ type: 'text', text: 'b' }]),
  edited: answer([{ type: 'text', text: 'c' }]),
  drop_block: answer([{ type: 'text', text: 'd' }], { input_transformations: [] }),
}[kind]), ({ output, code }) => {
  assert.equal(code, 0);
  assert.match(output, /RESULT: step 3 returned 200 - no block is required/);
  assert.match(output, /does not enforce the prefix binding/);
  assert.match(output, /nothing was dropped/);
});
await imitation('S3 the model never thinks: nothing to test, after three tries', (kind) => ({ mint: answer([TOOL]) }[kind]), ({ output, code, seen }) => {
  assert.equal(code, 2);
  assert.match(output, /NOTHING TO TEST/);
  assert.equal(seen.length, 3, 'three tries and then it stops');
});
await imitation('S4 the control request fails: the later answers are not read', (kind) => ({
  mint: answer([THINK, TOOL]),
  control: refusal(400, 'invalid_request_error', 'tools.0.input_schema: something is wrong with the request shape'),
}[kind]), ({ output, code, seen }) => {
  assert.equal(code, 2);
  assert.match(output, /INCONCLUSIVE: the control request failed/);
  assert.deepEqual(seen.map((entry) => entry.kind), ['mint', 'control']);
});
await imitation('S5 a refused key that the API echoes back is scrubbed', () => refusal(401, 'authentication_error', 'invalid x-api-key: ' + KEY), ({ output, code, seen }) => {
  assert.equal(code, 2);
  assert.match(output, /the key was refused \(HTTP 401\)/);
  assert.match(output, /\[key\]/, 'the echoed key is replaced');
  assert.equal(seen.length, 1);
});
await imitation('S5b a gateway token of any shape, echoed back by the API, is scrubbed too (sent as a bearer token)', (kind, body, mintCount, request) => refusal(401, 'authentication_error', 'invalid credential: ' + (request.headers.authorization || '')), ({ output, code, seen }) => {
  assert.equal(code, 2);
  assert.match(output, /the key was refused \(HTTP 401\)/);
  assert.match(output, /\[key\]/, 'the echoed token is replaced');
  assert.equal(seen[0].auth, 'bearer');
}, { token: TOKEN });
await imitation('S6 the model default does not think, adaptive does: the replays use the field that made it think', (kind, body, mintCount) => {
  if (kind === 'mint') return mintCount === 1 ? answer([TOOL]) : answer([THINK, TOOL]);
  return {
    control: answer([{ type: 'text', text: 'a' }]),
    without: refusal(400, 'invalid_request_error', 'Expected `thinking` or `redacted_thinking`, but found `tool_use`.'),
    edited: answer([{ type: 'text', text: 'c' }]),
    drop_block: answer([{ type: 'text', text: 'd' }], { input_transformations: [] }),
  }[kind];
}, ({ output, code, seen }) => {
  assert.equal(code, 0);
  assert.match(output, /\[attempt 2\]/);
  assert.deepEqual(seen.map((entry) => entry.kind), ['mint', 'mint', 'control', 'without', 'edited', 'drop_block']);
  assert.deepEqual(seen[1].thinking, { type: 'adaptive' });
  assert.deepEqual(seen[2].thinking, { type: 'adaptive' });
  assert.match(output, /RESULT: step 3 returned 400 and drop_block did not work here/);
});
{
  const dry = await run(CHECK_API, ['--dry-run'], { key: '' });
  assert.equal(dry.code, 0, tail(dry.output));
  assert.match(dry.output, /request 5: edited first message, drop_block and the beta header/);
  assert.match(dry.output, /"prefix_mismatch_behavior": "drop_block"/);
  assert.match(dry.output, /key header: x-api-key: \[key\]/);
  const none = await run(CHECK_API, [], { key: '' });
  assert.equal(none.code, 3, tail(none.output));
  assert.match(none.output, /no key found/);
  ok('check 1: --dry-run sends nothing and needs no key; with no key it refuses (exit 3)');
}

// ------------------------------------------------------------------------------------------------------------------------------- 2. check 2, against the Hub's strict mock
const TWO_ROUNDS = sequence([
  thinking('weighing Hanoi against Da Nang', call('get_weather', { city: 'Hanoi' })),
  thinking('now Da Nang', call('get_weather', { city: 'Da Nang' })),
], { final: 'Hanoi has rain, Da Nang is sunny: go to Da Nang.' });

/** The Hub's mock imitates the Messages API strictly: it signs thinking blocks for the conversation they were issued in and answers 400 "bound to a different conversation" to a replay after a change. */
async function withMock(scenario, body) {
  const mock = await startMockModel({ scenario: 'live-check', scenarios: { 'live-check': scenario }, strict: true, bindThinking: true, keepBodies: true, models: ['claude-sonnet-5-5'] });
  try { return await body(mock); } finally { await mock.close(); }
}
async function hubCheck(name, scenario, args, expectations) {
  const { output, code } = await withMock(scenario, (mock) => run(CHECK_HUB, ['--base-url', mock.origin, ...args]));
  try {
    neverPrintsTheKey(output, name);
    expectations({ output, code });
  } catch (error) {
    throw new Error(`${name}: ${error.message}\n----- output -----\n${tail(output)}`);
  }
  ok(name);
}

console.log('2. check-anthropic-hub-adapter.mjs against the Hub\'s strict mock');
await hubCheck('S1 the Hub behaves: tool loop, changed conversation, refused blocks, in JSON and in stream', TWO_ROUNDS, [], ({ output, code }) => {
  assert.equal(code, 0);
  assert.match(output, /RESULT: every scenario that could be run behaved as the Hub promises \(10 decided, 0 not decided\)/);
  assert.match(output, /==== mode: JSON/);
  assert.match(output, /==== mode: STREAM/);
  assert.equal((output.match(/=> PROBLEM/g) || []).length, 0, 'no problem line');
  assert.match(output, /exactly the 1 block\(s\) the API issued/, 'A: the blocks go back unchanged and are accepted');
  assert.match(output, /no block was sent and the API answered HTTP 200 at once/, 'B: a changed conversation keeps the blocks home');
  assert.match(output, /THIS REQUEST WAS EDITED ON PURPOSE/);
  assert.match(output, /HTTP 400 in [0-9.]+ s REJECTED/);
  assert.match(output, /the API answered 400 to the edited request, the Hub repeated it ONCE without the blocks, and the repeat got HTTP 200/, 'C: part c');
  assert.match(output, /the next round sent no blocks \(the Hub remembers/);
  assert.equal((output.match(/\| stream/g) || []).length > 0, true, 'the stream mode asked for a stream');
});
await hubCheck('S2 a model that never thinks: nothing to test, exit 2', sequence([call('get_weather', { city: 'Hanoi' })], { final: 'Take an umbrella.' }), ['--tries', '2', '--mode', 'json'], ({ output, code }) => {
  assert.equal(code, 2);
  assert.match(output, /NOT DECIDED: the model called the tool WITHOUT thinking in every try/);
  assert.match(output, /RESULT: nothing could be decided/);
});
await hubCheck('S3 redacted thinking blocks go back too; --no-tamper skips scenario C', sequence([redacted(call('get_weather', { city: 'Hanoi' }))], { final: 'Done.' }), ['--mode', 'json', '--no-tamper'], ({ output, code }) => {
  assert.equal(code, 0);
  assert.match(output, /exactly the 1 block\(s\) the API issued/);
  assert.doesNotMatch(output, /\[C\] The Hub is sure/);
});
{
  // the API refuses the credential and echoes it back: nothing of it may be printed, however it looks (the Hub redacts what it prints too, but the script prints the API's own text)
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(401, { 'content-type': 'application/json', 'request-id': 'req_echo' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid credential: ' + (request.headers.authorization || request.headers['x-api-key'] || '') } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const refused = await run(CHECK_HUB, ['--base-url', 'http://127.0.0.1:' + server.address().port, '--mode', 'json', '--tries', '1'], { key: '', token: TOKEN });
  server.close();
  neverPrintsTheKey(refused.output, 'a refused token');
  assert.equal(refused.code, 2, tail(refused.output));
  assert.match(refused.output, /reason from the API: invalid credential: Bearer \[key\]/, 'the API\'s own words are shown, with the credential replaced');
  assert.match(refused.output, /NOT DECIDED: the key or the model was refused \(HTTP 401\)/);
  ok('check 2: a credential that the API refuses and echoes back is never printed (exit 2)');

  const dry = await run(CHECK_HUB, ['--dry-run'], { key: '' });
  assert.equal(dry.code, 0, tail(dry.output));
  assert.match(dry.output, /Dry run: nothing is sent/);
  assert.ok(dry.output.includes(hubRoot), 'the Hub tested by default is the one this file is in');
  const none = await run(CHECK_HUB, [], { key: '' });
  assert.equal(none.code, 3, tail(none.output));
  assert.match(none.output, /no key found/);
  const missing = await run(CHECK_HUB, ['--hub', path.join(os.tmpdir(), 'chatmcp-no-such-hub')]);
  assert.equal(missing.code, 3, tail(missing.output));
  assert.match(missing.output, /the Hub code was not found/);
  neverPrintsTheKey(missing.output, 'missing Hub folder');
  ok('check 2: --dry-run needs no key and names the Hub it would test; with no key, or with a Hub folder that does not exist, it refuses (exit 3)');
}

// ------------------------------------------------------------------------------------------------------------------------------- 3. negative controls
/** A copy of the Hub's lib/ with one text changed, in a folder of its own. */
function variantOfTheHub(label, edits) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-hub-variant-'));
  fs.cpSync(path.join(hubRoot, 'lib'), path.join(folder, 'lib'), { recursive: true });
  for (const [file, from, to] of edits) {
    const target = path.join(folder, 'lib', file);
    const text = fs.readFileSync(target, 'utf8');
    assert.ok(text.includes(from), `the control "${label}" no longer finds its text in lib/${file}: the Hub changed, so the control must change with it`);
    fs.writeFileSync(target, text.replace(from, to));
  }
  return folder;
}
async function control(label, edits, expectations) {
  const folder = variantOfTheHub(label, edits);
  try {
    const { output, code } = await withMock(TWO_ROUNDS, (mock) => run(CHECK_HUB, ['--base-url', mock.origin, '--hub', folder, '--mode', 'json']));
    try {
      expectations({ output, code });
    } catch (error) {
      throw new Error(`control "${label}": ${error.message}\n----- output -----\n${tail(output)}`);
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  ok(`negative control: ${label}`);
}

console.log('3. negative controls: a defect in the Hub must be reported');
await control('the repeat without the blocks is switched off (part c): reported as a problem, exit 1', [
  ['thinking-blocks.mjs', 'export const refusesThinkingReplay = (status, detail) => status === 400 &&', 'export const refusesThinkingReplay = (status, detail) => false &&'],
], ({ output, code }) => {
  assert.equal(code, 1);
  assert.match(output, /PROBLEM \(json C\): the API refused the blocks \(400\) and the Hub did NOT recover/);
});
await control('the digest ignores the system prompt (part a): blocks go back into a changed conversation, reported as a problem', [
  ['thinking-blocks.mjs', 'system: withoutCacheControl(system ?? null),', 'system: null,'],
], ({ output, code }) => {
  assert.equal(code, 1);
  assert.match(output, /PROBLEM \(json B\): the Hub sent blocks although the system prompt changed/);
});
await control('the Hub damages the blocks it sends back: the API refuses them in an unchanged conversation, reported as a problem', [
  ['thinking-blocks.mjs', 'return structuredClone(item.providerBlocks);', "return structuredClone(item.providerBlocks).map((block) => ({ ...block, ...(block.signature ? { signature: 'damaged-' + block.signature } : { data: 'damaged-' + block.data }) }));"],
], ({ output, code }) => {
  assert.equal(code, 1);
  assert.match(output, /PROBLEM \(json A round 2\): the API answered HTTP 400 to blocks the Hub sent back in an UNCHANGED conversation/);
  assert.match(output, /The Hub recovered by repeating without the blocks/);
});
await control('the Hub never sends blocks back: a note, not a problem (exit 0), and scenario C has nothing to refuse', [
  ['anthropic-api.mjs', 'if (replay) putThinkingBack(body, began, { model, origin: replay.origin });', 'if (false) putThinkingBack(body, began, { model, origin: replay.origin });'],
], ({ output, code }) => {
  assert.equal(code, 0, 'a note is not a problem');
  assert.match(output, /NOTE \(json A round 2\): the Hub held the blocks back although nothing changed/);
  assert.match(output, /\[C\] API refuses the blocks: not decided/);
});

console.log(`\nPASS: ${checks} live-check suite checks (both scripts run offline against stand-ins; four Hub defects reported)`);
