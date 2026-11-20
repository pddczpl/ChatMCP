// tests/fixtures/mcp-malicious-server.mjs over real stdio, spoken to with a few lines of JSON-RPC written here (no MCP SDK), and its answers piped through
// the three hardening modules of P2 slice C1 (lib/mcp/sanitize.mjs, fingerprint-pins.mjs, result-limits.mjs):
//
//  1. the handshake: initialize, tools/list, prompts/list, resources/list, ping, an unknown method, a line that is not JSON; the server ends with its stdin
//  2. a 1 MB description full of zero-width, tag and bidi characters -> 2 KB, the invisible characters gone; a tool whose NAME hides characters is refused
//  3. a description that changes after the first tools/list -> needs_review with the tool and the field
//  4. a 50 MB result -> capped at the 8 MB ceiling with a note
//  5. a call that never answers is counted once in the count file, and the server still answers a ping
//  6. a stderr flood of 5 MB -> 64 KB kept, the rest counted
//  7. a tools/list that repeats its cursor; a $ref cycle and a 40-level schema; 300 tools
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinStore } from '../lib/mcp/fingerprint-pins.mjs';
import { createStderrCollector, limitToolResult } from '../lib/mcp/result-limits.mjs';
import { sanitizeList, sanitizeTool } from '../lib/mcp/sanitize.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the MCP malicious fixture suite exceeded its own time budget'); process.exit(2); }, 150_000).unref();

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-malicious-server.mjs');
const MiB = 1024 * 1024;
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set();

// A JSON-RPC 2.0 peer over newline-delimited JSON, as the MCP stdio transport defines it: one message per line, no embedded newlines.
function startServer(args, { stderr } = {}) {
  const child = spawn(process.execPath, [FIXTURE, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  const pending = new Map();
  const unanswered = [];
  let nextId = 1;
  let parts = [];
  child.stdout.on('data', (chunk) => {
    let start = 0;
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, start)) {
      parts.push(chunk.subarray(start, index));
      const line = Buffer.concat(parts).toString('utf8');
      parts = [];
      start = index + 1;
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter(message); } else unanswered.push(message);
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  });
  child.stderr.on('data', (chunk) => stderr?.push(chunk));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal }); }));
  const stderrEnded = new Promise((resolve) => child.stderr.once('end', resolve));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    child, exited, stderrEnded, unanswered,
    request(method, params, { timeoutMs = 20_000 } = {}) {
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ timedOut: true, id }); }, timeoutMs);
        pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
        send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    notify(method, params) { send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); },
    raw(text) { child.stdin.write(text); },
    async close() { child.stdin.end(); return exited; },
  };
}
async function handshake(server) {
  const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'datgold-test', version: '0' } });
  assert.equal(init.result?.serverInfo?.name, 'mcp-malicious-fixture', JSON.stringify(init).slice(0, 300));
  server.notify('notifications/initialized');
  return init.result;
}
const tools = async (server, params) => {
  const answer = await server.request('tools/list', params);
  assert.ok(Array.isArray(answer.result?.tools), JSON.stringify(answer).slice(0, 300));
  return answer.result;
};
function namedHidden(text) {
  for (const char of text) {
    const point = char.codePointAt(0);
    if ((point <= 0x1f && point !== 9 && point !== 10) || (point >= 0x7f && point <= 0x9f) || (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069)
      || [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].includes(point) || (point >= 0xe0000 && point <= 0xe007f)) return point;
  }
  return null;
}

const scratch = await mkdtemp(path.join(os.tmpdir(), 'datgold-mcp-fixture-'));
try {
  // ------------------------------------------------------------------ 1. the handshake
  {
    const server = startServer([]);
    const init = await handshake(server);
    assert.equal(init.protocolVersion, '2025-06-18', 'the version the client asked for is echoed');
    assert.deepEqual(Object.keys(init.capabilities).sort(), ['prompts', 'resources', 'tools']);
    const list = await tools(server);
    assert.deepEqual(list.tools.map((tool) => tool.name), ['tool_1', 'big_result', 'hang']);
    assert.equal(Object.hasOwn(list, 'nextCursor'), false);
    const call = await server.request('tools/call', { name: 'tool_1', arguments: {} });
    assert.deepEqual(call.result, { content: [{ type: 'text', text: 'tool_1 ran' }] });
    const big = await server.request('tools/call', { name: 'big_result', arguments: {} });
    assert.deepEqual(big.result, { content: [{ type: 'text', text: 'small' }] }, 'without --result-bytes the result is small');
    const missing = await server.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(missing.result.isError, true);
    assert.deepEqual(await server.request('ping'), { jsonrpc: '2.0', id: 6, result: {} });
    assert.equal((await server.request('no/such/method')).error.code, -32601);
    const prompts = await server.request('prompts/list');
    assert.deepEqual(prompts.result.prompts.map((prompt) => prompt.name), ['summarize']);
    const resources = await server.request('resources/list');
    assert.deepEqual(resources.result.resources.map((resource) => resource.uri), ['mem://fixture/readme']);
    server.raw('this is not json\n');
    await pause(200);
    assert.deepEqual(server.unanswered.map((message) => [message.id, message.error?.code]), [[null, -32700]], 'a line that is not JSON is a parse error with id null');
    const { code } = await server.close();
    assert.equal(code, 0, 'the server ends when its stdin ends');
    ok('fixture: initialize, tools/list, tools/call, ping, prompts/list, resources/list, -32601, -32700; it exits 0 when its stdin closes');
  }

  // ------------------------------------------------------------------ 2. 1 MB description with invisible characters
  {
    const server = startServer(['--description-bytes', String(MiB), '--invisible']);
    await handshake(server);
    const list = await tools(server);
    const raw = list.tools.find((tool) => tool.name === 'tool_1');
    assert.ok(bytes(raw.description) >= MiB, `the fixture sent ${bytes(raw.description)} bytes`);
    assert.notEqual(namedHidden(raw.description), null, 'and it is full of hidden characters');
    assert.ok(list.tools.some((tool) => namedHidden(tool.name) !== null), 'one tool hides characters in its name');
    assert.ok(list.tools.some((tool) => namedHidden(tool.title ?? '') !== null), 'one tool hides characters in its title');
    const started = performance.now();
    const clean = sanitizeList('tools', list.tools);
    const elapsed = performance.now() - started;
    const tool = clean.items.find((item) => item.name === 'tool_1');
    assert.ok(bytes(tool.description) <= 2048, `${bytes(tool.description)} bytes`);
    assert.equal(namedHidden(tool.description), null);
    assert.ok(tool.description.endsWith('[DatGold: invisible or control characters removed; cut to 2048 bytes]'));
    assert.ok(tool.description.startsWith('Reads a file.'), tool.description.slice(0, 60));
    for (const item of clean.items) {
      for (const text of [item.name, item.title ?? '', item.description]) assert.equal(namedHidden(text), null, item.name);
    }
    const refusal = clean.refused.find((entry) => entry.reason === 'name_bad_characters');
    assert.ok(refusal && /\\u\{200B\}|\\u\{202E\}|\\u\{E00/.test(refusal.preview), JSON.stringify(clean.refused));
    assert.ok(elapsed < 300, `sanitizing took ${Math.round(elapsed)} ms`);
    await server.close();
    ok(`1 MB description (${bytes(raw.description)} bytes) -> ${bytes(tool.description)} bytes with the invisible characters gone in ${elapsed.toFixed(1)} ms; the tool with a hidden name is refused (${refusal.preview})`);
  }

  // ------------------------------------------------------------------ 3. a description that changes after the first tools/list
  {
    const directory = path.join(scratch, 'pins');
    const logs = [];
    const store = createPinStore({ directory, log: (message) => logs.push(message) });
    const server = startServer(['--change-after', '1']);
    await handshake(server);
    const snapshotOf = async () => ({
      tools: (await tools(server)).tools,
      prompts: (await server.request('prompts/list')).result.prompts,
      resources: (await server.request('resources/list')).result.resources,
    });
    const first = await snapshotOf();
    assert.equal((await store.check('fixture', first)).state, 'unpinned');
    const approved = await store.approve('fixture', first);
    assert.equal(approved.ok, true);
    assert.equal((await store.check('fixture', first)).state, 'pinned');
    const second = await snapshotOf();
    assert.notEqual(second.tools[0].description, first.tools[0].description, 'the fixture changed its description');
    const review = await store.check('fixture', second);
    assert.equal(review.state, 'needs_review');
    assert.deepEqual(review.diff, { added: [], removed: [], changed: [{ kind: 'tool', name: 'tool_1', fields: ['description'] }] });
    assert.equal((await store.check('fixture', await snapshotOf())).state, 'needs_review', 'and it stays changed');
    assert.deepEqual(logs, []);
    await server.close();
    ok('changed description: the first tools/list approved and pinned, the second is needs_review with tool_1 / description');
  }

  // ------------------------------------------------------------------ 4. a 50 MB result
  {
    const server = startServer(['--result-bytes', String(50 * MiB)]);
    await handshake(server);
    const answer = await server.request('tools/call', { name: 'big_result', arguments: {} }, { timeoutMs: 60_000 });
    assert.equal(answer.timedOut, undefined, 'the 50 MB answer arrived');
    const text = answer.result.content[0].text;
    assert.equal(bytes(text), 50 * MiB, 'the fixture sent 50 MiB');
    const started = performance.now();
    const limited = limitToolResult(answer.result, { toolName: 'mcp.fixture.big_result' });
    const elapsed = performance.now() - started;
    const kept = limited.result.content[0].text;
    assert.equal(bytes(kept), 8 * MiB - 4096);
    assert.deepEqual(limited.notes, [`text cut: ${50 * MiB - (8 * MiB - 4096)} of ${50 * MiB} bytes not shown (ceiling ${8 * MiB} bytes)`]);
    assert.ok(limited.result.content.at(-1).text.startsWith('[DatGold limited this result: text cut'));
    await server.close();
    ok(`50 MB result -> ${bytes(kept)} bytes and a note, in ${Math.round(elapsed)} ms`);
  }

  // ------------------------------------------------------------------ 5. a call that never answers
  {
    const countFile = path.join(scratch, 'calls.txt');
    const server = startServer(['--hang', '--count-file', countFile]);
    await handshake(server);
    const hung = server.request('tools/call', { name: 'hang', arguments: {} }, { timeoutMs: 1500 });
    const deadline = Date.now() + 10_000;
    while (!existsSync(countFile) && Date.now() < deadline) await pause(25);
    assert.equal(readFileSync(countFile, 'utf8'), 'hang\n', 'the call reached the server once');
    const outcome = await hung;
    assert.deepEqual(outcome, { timedOut: true, id: 2 }, 'the call never answered');
    assert.deepEqual((await server.request('ping')).result, {}, 'the server still answers other requests');
    await pause(300);
    assert.equal(readFileSync(countFile, 'utf8'), 'hang\n', 'and it was counted once: nobody sent it again');
    assert.deepEqual(server.unanswered, []);
    const other = await server.request('tools/call', { name: 'tool_1', arguments: {} });
    assert.equal(other.result.content[0].text, 'tool_1 ran');
    assert.equal(readFileSync(countFile, 'utf8'), 'hang\ntool_1\n', 'every call is counted with its name');
    await server.close();
    ok('a hung call is counted once in the count file, times out on the client side, and the server keeps answering');
  }

  // ------------------------------------------------------------------ 6. a stderr flood
  {
    const collector = createStderrCollector({ maxBytes: 64 * 1024 });
    const server = startServer(['--stderr-bytes', String(5 * MiB)], { stderr: collector });
    await handshake(server);
    await server.close();
    await server.stderrEnded;
    const stats = collector.stats();
    assert.deepEqual(stats, { totalBytes: 5 * MiB, keptBytes: 64 * 1024, droppedBytes: 5 * MiB - 64 * 1024, ignored: 0 });
    assert.ok(collector.text().includes(`[DatGold dropped ${5 * MiB - 64 * 1024} bytes of stderr]`));
    ok(`stderr flood of ${stats.totalBytes} bytes -> ${stats.keptBytes} kept, ${stats.droppedBytes} counted as dropped`);
  }

  // ------------------------------------------------------------------ 7. repeated cursor, $ref cycle, deep schema, many tools
  {
    const server = startServer(['--repeat-cursor', '--ref-cycle', '--deep-schema', '40', '--tools', '300']);
    await handshake(server);
    const pages = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const list = await tools(server, cursor === undefined ? undefined : { cursor });
      pages.push(list.tools.length);
      if (list.nextCursor === undefined) break;
      if (cursors.has(list.nextCursor)) break;
      cursors.add(list.nextCursor);
      cursor = list.nextCursor;
    }
    assert.deepEqual([pages.length, [...cursors]], [2, ['again']], 'the fixture answers every page with the same cursor; a walker that remembers cursors stops at the second page');
    const list = await tools(server);
    assert.equal(list.tools.length, 300 + 4, '300 numbered tools, big_result, hang, ref_cycle and deep_schema');
    const started = performance.now();
    const cycle = sanitizeTool(list.tools.find((tool) => tool.name === 'ref_cycle'));
    const deep = sanitizeTool(list.tools.find((tool) => tool.name === 'deep_schema'));
    const elapsed = performance.now() - started;
    assert.equal(cycle.ok, true, 'a $ref cycle is accepted: it is never resolved');
    assert.deepEqual([deep.ok, deep.reason], [false, 'schema_too_deep']);
    assert.ok(elapsed < 100, `${elapsed} ms`);
    const clean = sanitizeList('tools', list.tools);
    assert.equal(clean.items.length, 303);
    await server.close();
    ok(`repeated cursor stopped after ${pages.length} pages, $ref cycle accepted and 40-level schema refused in ${elapsed.toFixed(1)} ms, 304 tools listed (303 accepted)`);
  }
} finally {
  for (const child of children) child.kill();
  await rm(scratch, { recursive: true, force: true });
}

console.log(`PASS: ${checks} MCP malicious fixture checks`);
