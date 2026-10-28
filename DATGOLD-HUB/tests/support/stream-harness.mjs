// What the streaming suites (verify-stream-chat, -anthropic, -gemini) have in common: fixtures, scripted responses and a driver for one call of the adapter. Nothing here is under test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { respondStandard } from '../../lib/standard-adapter.mjs';

export const encoder = new TextEncoder();
const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtureRoot = path.join(here, '..', 'fixtures', 'streams');

/** A read that never ends is a failure of the test, not a hang of the suite. */
export const deadline = (promise, label, ms = 5000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} was still waiting after ${ms} ms`)), ms).unref())]);

/** The fixtures of one protocol (tests/fixtures/streams/<name>.json) and the text of each stream. */
export function loadFixtures(name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, `${name}.json`), 'utf8'));
  return { fixtures: manifest.fixtures, textOf: (fixture) => fs.readFileSync(path.join(fixtureRoot, fixture.file), 'utf8'), byName: (fixtureName) => manifest.fixtures.find((fixture) => fixture.name === fixtureName) };
}

/** The text as a stream of UTF-8 chunks of the given size (a chunk may end inside a character). */
export function bodyOf(text, chunkBytes = 97) {
  const bytes = encoder.encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(at, at + chunkBytes));
      at += chunkBytes;
    },
  });
}

/** The frames of a stream text (an event and the blank line after it), each ending in LF whatever the file had. */
export const framesOf = (text) => text.split(/\r?\n\r?\n/).filter((piece) => piece.length > 0).map((piece) => `${piece}\n\n`);
export const firstFrames = (text, count) => framesOf(text).slice(0, count).join('');

export const sse = (text, chunkBytes = 64) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream; charset=utf-8' }), body: bodyOf(text, chunkBytes) });
export const jsonResponse = (status, data, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json', ...headers }), text: async () => JSON.stringify(data) });

export const HISTORY = [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }];
export const TOOLS = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
export const ENDPOINTS = { 'openai-chat': 'https://example.test/v1/chat/completions', anthropic: 'https://example.test/v1/messages' };

/** One call of respondStandard against scripted responses. `events` is what happened, in order; `shown` is the text that was handed to onToken. */
export async function drive(responses, { ctx = {}, options = {}, protocol = 'openai-chat' } = {}) {
  const sent = [];
  const events = [];
  const queue = [...responses];
  const outcome = await respondStandard({
    protocol, endpoint: ENDPOINTS[protocol], headers: { authorization: 'Bearer fixture' }, model: 'm', stream: true, redact: (value) => value,
    fetch: async (url, init) => { sent.push(JSON.parse(init.body)); events.push('fetch'); const next = queue.shift(); return typeof next === 'function' ? next(init) : next; },
    sleep: async (ms) => { events.push(`sleep:${ms}`); },
    onStreamRefused: () => events.push('remembered'), onStreamOptionsRefused: () => events.push('remembered-options'),
    limits: { requestTimeoutMs: 5000 },
    ...ctx,
  }, {
    input: HISTORY, instructions: 'Test', tools: TOOLS, maxOutputTokens: 1024,
    beforeModelRequest: () => events.push('before'), onStatus: async () => { events.push('status'); }, onToken: (token) => events.push(`token:${token}`), onStreamReset: () => events.push('reset'),
    ...options,
  }).then((value) => ({ value }), (error) => ({ error }));
  return { ...outcome, sent, events, left: queue.length, shown: events.filter((event) => event.startsWith('token:')).map((event) => event.slice(6)).join('') };
}
export const kinds = (events) => events.map((event) => (event.startsWith('token:') ? 'token' : event.startsWith('sleep:') ? 'sleep' : event));
