#!/usr/bin/env node
// A stdio MCP server written as plain JSON-RPC lines, without any SDK, for the answers a real SDK refuses to send.
//
//   node mcp-raw-server.mjs --mode <mode> [--era modern|legacy] [--counter file]
//
// --era modern: answers server/discover with 2026-07-28 (results carry resultType); legacy: server/discover is "method not found" and the
// client must fall back to initialize.
// Modes:  plain           one tool "probe"
//         duplicate       tools/list names the tool "twin" twice
//         empty-name      a tool whose name is ""
//         repeat-cursor   page 1 -> cursor "c1", page "c1" -> cursor "c1" again
//         cycle-cursor    "" -> "c1" -> "c2" -> "c1"
//         endless         every page has a new cursor, for ever
//         unknown-result  tools/call answers with resultType "future_kind"
//         exit-on-probe   exits as soon as it reads server/discover (servers built on SDKs that stop on any request before initialize)
//         input-required  tools/call answers 2026-07-28's input_required (it asks for an elicitation)
//         mute            reads every request and answers none
// Every tools/list page and tools/call is written to --counter as "list <cursor>" / "call <name>", and the capabilities the client declared
// (initialize, or the _meta envelope of server/discover) as "caps <json>".
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const options = { mode: 'plain', era: 'modern', counter: '' };
for (let index = 2; index < process.argv.length; index += 2) options[process.argv[index].replace(/^--/, '')] = process.argv[index + 1];
const count = (line) => { if (options.counter) appendFileSync(options.counter, `${line}\n`); };
let era = null;
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const complete = (result) => (era === 'modern' ? { ...result, resultType: 'complete' } : result);
const tool = (name) => ({ name, description: `raw ${name}`, inputSchema: { type: 'object', properties: {} } });

function toolsPage(cursor) {
  count(`list ${cursor ?? ''}`);
  switch (options.mode) {
    case 'duplicate': return { tools: [tool('twin'), tool('other'), tool('twin')] };
    case 'empty-name': return { tools: [tool('fine'), tool('')] };
    case 'repeat-cursor': return { tools: [tool(cursor ? 'second' : 'first')], nextCursor: 'c1' };
    case 'cycle-cursor': return { tools: [tool(`t-${cursor ?? 'start'}`)], nextCursor: cursor === undefined ? 'c1' : cursor === 'c1' ? 'c2' : 'c1' };
    case 'endless': {
      const page = cursor === undefined ? 0 : Number(cursor.slice(1));
      return { tools: [tool(`t${page}`)], nextCursor: `p${page + 1}` };
    }
    default: return { tools: [tool('probe')] };
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications
  if (options.mode === 'mute') return;
  if (method === 'server/discover') count(`caps ${JSON.stringify(params?._meta?.['io.modelcontextprotocol/clientCapabilities'] ?? null)}`);
  if (method === 'initialize') count(`caps ${JSON.stringify(params?.capabilities ?? null)}`);
  if (method === 'server/discover') {
    if (options.mode === 'exit-on-probe') process.exit(4);
    if (options.era !== 'modern') { send({ id, error: { code: -32601, message: 'Method not found' } }); return; }
    era = 'modern';
    send({ id, result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'datgold-raw', version: '1.0.0' } } } });
    return;
  }
  if (method === 'initialize') {
    era = 'legacy';
    send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'datgold-raw', version: '1.0.0' } } });
    return;
  }
  if (method === 'ping') { send({ id, result: complete({}) }); return; }
  // 2026-07-28 makes the cache hints of a list result (SEP-2549) required.
  if (method === 'tools/list') { send({ id, result: complete({ ...toolsPage(params?.cursor), ...(era === 'modern' ? { ttlMs: 0, cacheScope: 'public' } : {}) }) }); return; }
  if (method === 'tools/call') {
    count(`call ${params?.name}`);
    if (options.mode === 'unknown-result') send({ id, result: { content: [{ type: 'text', text: 'from a later revision' }], resultType: 'future_kind' } });
    else if (options.mode === 'input-required') send({ id, result: { resultType: 'input_required', inputRequests: { confirm: { method: 'elicitation/create', params: { mode: 'form', message: 'Proceed?', requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } }, requestState: 'opaque-state' } });
    else send({ id, result: complete({ content: [{ type: 'text', text: `called ${params?.name}` }] }) });
    return;
  }
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});
