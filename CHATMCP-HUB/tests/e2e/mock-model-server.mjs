#!/usr/bin/env node
// A scripted stand-in for an OpenAI-compatible model server, used by the end-to-end tests.
//
// It is NOT a model. It answers /v1/chat/completions with the next step of a fixed scenario (see scenarios.mjs), decided
// only by what the conversation already contains. A run is therefore repeatable and needs no API key, no network and no GPU.
// It listens on loopback only. It records what the Hub sent (never the Authorization value, only whether one was present).
//
// As a library:   const mock = await startMockModel({ scenario: 'repair-add' }); mock.url; await mock.close();
// As a program:   node tests/e2e/mock-model-server.mjs [--port N] [--scenario NAME]   (prints one "READY {json}" line)
// Control (loopback test traffic only):
//   GET  /__ping       {ok:true}
//   GET  /__requests   what the Hub has sent so far
//   GET  /__last       the body of the latest chat request
//   POST /__scenario   {"name": "..."}  switch scenario and forget the recorded requests
//   POST /__watch      {"needles": ["...", ...]}  from now on, report whether any request body contains one of them
//   GET  /__watch      {watching, scanned, hits:[{needle: <index>, request: <number>}]}
// The watch exists to prove that a secret never left the machine inside a model request. It reports positions, never the
// needle's text, and `scanned` says how many requests were actually looked at, so "no hits" cannot be an empty promise.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCENARIOS, call } from './scenarios.mjs';

export const MODEL_IDS = Object.freeze(['mock-coder', 'mock-coder-small']);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const contentText = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  return '';
};

/** What a scenario is allowed to see: the request and the tool results that came back since it. */
export function describeConversation(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let lastUser = -1;
  messages.forEach((message, index) => { if (message?.role === 'user') lastUser = index; });
  const results = messages.slice(lastUser + 1).filter((message) => message?.role === 'tool').map(contentText);
  const tools = (Array.isArray(body?.tools) ? body.tools : []).map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean);
  return {
    prompt: lastUser >= 0 ? contentText(messages[lastUser]) : '',
    // Every user-role message, oldest first. A continued conversation carries the Hub's notes about the earlier run in a
    // user message of its own, before the person's new request.
    users: messages.filter((message) => message?.role === 'user').map(contentText),
    turn: results.length,
    results,
    last: results.at(-1) ?? '',
    tools,
    system: messages.filter((message) => message?.role === 'system').map(contentText).join('\n'),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('request too large'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Reads a JSON request body and also hands back the exact text that was sent (the watch scans the text, not the parsed copy). */
async function readJsonWithText(req) {
  const text = await readBody(req);
  if (!text.trim()) return { text, json: {} };
  try { return { text, json: JSON.parse(text) }; } catch { throw Object.assign(new Error('body is not JSON'), { statusCode: 400 }); }
}
const readJson = async (req) => (await readJsonWithText(req)).json;

export async function startMockModel({ scenario = 'repair-add', scenarios: extra = {}, host = '127.0.0.1', port = 0, models = MODEL_IDS } = {}) {
  // `scenarios` lets a test bring its own scripted behaviour (a closure over the paths it created) next to the shared ones.
  const registry = { ...SCENARIOS, ...extra };
  if (!registry[scenario]) throw new Error(`unknown scenario "${scenario}"`);
  const state = { scenario, requests: [], lastBody: null, callCounter: 0, needles: [], hits: [], scanned: 0 };

  /** A short needle would match ordinary text and make a clean report meaningless in the other direction, so it is refused. */
  const setNeedles = (needles) => {
    if (!Array.isArray(needles) || needles.some((needle) => typeof needle !== 'string' || needle.length < 6)) throw Object.assign(new Error('needles must be an array of strings of at least 6 characters'), { statusCode: 400 });
    state.needles = needles.slice(0, 50);
    state.hits = [];
    state.scanned = 0;
  };

  /** Looks for each watched needle in the raw request text, in both its plain and its JSON-escaped spelling. */
  const scanForNeedles = (text, requestNumber) => {
    if (!state.needles.length) return;
    state.scanned += 1;
    state.needles.forEach((needle, index) => {
      const escaped = JSON.stringify(needle).slice(1, -1);
      if (text.includes(needle) || text.includes(escaped)) state.hits.push({ needle: index, request: requestNumber });
    });
  };

  const completion = (model, step) => {
    const calls = Array.isArray(step.calls) ? step.calls : [];
    const message = { role: 'assistant', content: typeof step.text === 'string' ? step.text : null };
    if (calls.length) {
      message.tool_calls = calls.map((entry) => {
        state.callCounter += 1;
        return { id: `call_mock_${state.callCounter}`, type: 'function', function: { name: entry.name, arguments: JSON.stringify(entry.args ?? {}) } };
      });
    }
    return {
      id: `chatcmpl-mock-${state.callCounter}-${state.requests.length}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message }],
      usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 },
    };
  };

  const server = http.createServer(async (req, res) => {
    const reply = (status, body, headers = {}) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers });
      res.end(text);
    };
    try {
      const url = new URL(req.url, 'http://mock.invalid');
      const route = url.pathname.replace(/\/+$/, '');
      if (req.method === 'GET' && route === '/__ping') return reply(200, { ok: true });
      if (req.method === 'GET' && route === '/__requests') return reply(200, { scenario: state.scenario, requests: state.requests });
      if (req.method === 'GET' && route === '/__last') return reply(200, state.lastBody);
      if (req.method === 'POST' && route === '/__scenario') {
        const { name } = await readJson(req);
        if (!registry[name]) return reply(400, { error: { message: `unknown scenario "${name}"`, known: Object.keys(registry) } });
        state.scenario = name;
        state.requests.length = 0;
        state.lastBody = null;
        return reply(200, { scenario: name });
      }
      if (route === '/__watch' && req.method === 'POST') {
        setNeedles((await readJson(req)).needles);
        return reply(200, { watching: state.needles.length });
      }
      if (route === '/__watch' && req.method === 'GET') return reply(200, { watching: state.needles.length, scanned: state.scanned, hits: state.hits });
      if (req.method === 'GET' && route.endsWith('/models')) return reply(200, { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'mock' })) });
      if (req.method === 'POST' && route.endsWith('/chat/completions')) {
        const { text: rawBody, json: body } = await readJsonWithText(req);
        const info = describeConversation(body);
        const probe = info.tools.includes('record_probe');
        state.lastBody = body;
        state.requests.push({
          at: new Date().toISOString(), model: body.model ?? null, probe, turn: info.turn, tools: info.tools, messages: Array.isArray(body.messages) ? body.messages.length : 0,
          hasAuthorization: Boolean(req.headers.authorization), promptStart: info.prompt.slice(0, 160),
        });
        scanForNeedles(rawBody, state.requests.length);
        if (probe) return reply(200, completion(body.model, call('record_probe', { value: 'ok' })));
        // A request that offers no tools (the Hub's connectivity check) can only be answered in text, as with a real model.
        if (!info.tools.length) return reply(200, completion(body.model, { text: 'OK' }));
        const step = await registry[state.scenario](info);
        if (step?.http) return reply(step.http.status ?? 500, step.http.body ?? { error: { message: 'mock failure' } }, step.http.headers);
        return reply(200, completion(body.model, step ?? { text: '' }));
      }
      return reply(404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
    } catch (error) {
      return reply(error?.statusCode ?? 500, { error: { message: String(error?.message ?? error) } });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const boundPort = server.address().port;
  const origin = `http://${host}:${boundPort}`;
  return {
    url: `${origin}/v1`, origin, port: boundPort, state,
    setScenario(name) {
      if (!registry[name]) throw new Error(`unknown scenario "${name}"`);
      state.scenario = name; state.requests.length = 0; state.lastBody = null;
    },
    /** Adds or replaces a scenario while the server is running. */
    define(name, fn) {
      if (typeof fn !== 'function') throw new TypeError('a scenario is a function');
      registry[name] = fn;
    },
    /** Starts watching request bodies for these strings (see /__watch). */
    watch: setNeedles,
    watchReport: () => ({ watching: state.needles.length, scanned: state.scanned, hits: state.hits.map((hit) => ({ ...hit })) }),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// ----------------------------------------------------------------------------------------------------------------
// Command line
// ----------------------------------------------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback; };
  const mock = await startMockModel({ scenario: option('--scenario', 'repair-add'), port: Number(option('--port', '0')) });
  console.log(`READY ${JSON.stringify({ url: mock.url, origin: mock.origin, port: mock.port, scenario: mock.state.scenario })}`);
  const stop = () => mock.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
