// Gate for the outbound filter on the real Companion path (pod-13, pod-14 part 1): what chatgpt.com is handed.
//
// The real BrowserRunner runs start -> poll -> claim -> sent -> reply -> poll, as the extension drives it (tests/fixtures/
// companion-flow.mjs); only the tool server is a stand-in. The assertions look at the message text that poll() and claim()
// return, because that is what the extension types into the page.
//
//   * a secret-shaped string inside a tool result never appears in that text, in any of the formats of the corpus, nor in any page
//     result_page serves later, even when the secret straddles the 900-character chunk boundary
//   * the first message, the handoff text and a continuation prompt are scrubbed too
//   * a protected file read through a non-local tool (what Desktop Commander does) is withheld whole, including its harmless lines
//   * the protocol envelope survives (a model that reads the scrubbed text can still answer it), a secret registered with the Hub is
//     still masked, and the ledger records labels and counts only
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { positives, body } from './fixtures/outbound-corpus.mjs';
import { envelopeOf, makeFlow, textResult } from './fixtures/companion-flow.mjs';

let checks = 0;
const check = (condition, label, detail = '') => { assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`); checks += 1; };

const FILE = 'desktop-commander.read_file';
const SHELL = 'desktop-commander.start_process';
const LIST = 'desktop-commander.list_directory';
const reads = new Map();
const tools = {
  [FILE]: ({ path }) => textResult(reads.get(path) ?? `contents of ${path}`),
  [SHELL]: ({ command }) => textResult(reads.get(command) ?? `ran ${command}`),
  [LIST]: () => textResult('src\nREADME.md'),
};
const flow = await makeFlow({ tools, registeredSecrets: ['registered-secret-value-77'] });
try {
  const task = await flow.start({ prompt: 'Review the configuration of this project.' });
  let message = await flow.deliver();
  check(/^CHATMCP HUB — task /.test(message.text), 'the first message is the instruction');

  /** Asks the model's side to read `path`; returns the message the extension receives next. */
  const readThrough = async (name, args, content) => {
    reads.set(args.path ?? args.command, content);
    await flow.reply(message, { kind: 'tool', name, arguments: args });
    check(flow.task.status === 'queued', 'the result is queued for delivery', flow.task.status);
    message = await flow.deliver();
    return message;
  };

  // ---- 1. every format of the corpus, in a tool result -------------------------------------------------------------
  const corpus = positives();
  let leaks = 0;
  for (const sample of corpus) {
    const result = await readThrough(FILE, { path: 'src/config.ts' }, `// config\n${sample.text}\nexport default {};\n`);
    if (result.text.includes(sample.secret) || flow.task.message.text.includes(sample.secret)) { leaks++; console.log('LEAK', sample.label); }
    // The extension can still answer: identifiers read from the text match the task.
    const identity = envelopeOf(result.text);
    if (identity.task !== task.id || identity.nonce !== task.nonce || identity.turn !== result.turn) assert.fail(`the envelope was damaged for ${sample.label}`);
  }
  check(leaks === 0, 'no secret of the corpus reaches poll() or claim()', `${leaks} leaked`);
  console.log(`PASS ${corpus.length} secret-bearing tool results (${new Set(corpus.map((s) => s.label)).size} formats) -> 0 reached the extension; the envelope stayed intact for every turn`);

  // ---- 2. a secret that straddles the first-page boundary ------------------------------------------------------------
  const token = `ghp_${body('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 36)}`;
  const build = (fill) => `${'x'.repeat(fill)}\nGITHUB_TOKEN: ${token}\n${'y'.repeat(2500)}`;
  const at = (fill) => JSON.stringify(textResult(build(fill)), null, 2).indexOf(token);
  const content = build(880 - at(0)); // the token starts 20 characters before the first page ends
  const raw = JSON.stringify(textResult(content), null, 2);
  assert.ok(raw.indexOf(token) < 900 && raw.indexOf(token) + token.length > 900, 'the fixture really straddles offset 900');
  let page = await readThrough(FILE, { path: 'src/big.txt' }, content);
  check(/"paged":true/.test(page.text), 'a large result is paged');
  const resultId = /"resultId":"([0-9a-f-]{36})"/.exec(page.text)[1];
  const pieces = [page.text];
  let offset = 900;
  for (let guard = 0; guard < 20; guard++) {
    await flow.reply(page, { kind: 'result_page', resultId, offset, limit: 600 }); // small enough that a page is not paged again
    page = await flow.deliver();
    pieces.push(page.text);
    const next = /"nextOffset":\s*(\d+|null)/.exec(page.text)?.[1];
    if (!next || next === 'null') break;
    offset = Number(next);
  }
  message = page; // the latest message the model has to answer
  const everything = pieces.join('\n');
  check(pieces.length >= 3, 'the result was read page by page', `${pieces.length} messages`);
  for (const part of [token, token.slice(0, 12), token.slice(12, 24), token.slice(-12)]) check(!everything.includes(part), 'no part of a secret that straddles a page boundary reaches the extension', part.slice(0, 6));
  console.log(`PASS a secret across the 900-character boundary: ${pieces.length} messages, no fragment of it delivered`);

  // ---- 3. protected files read through a tool the Hub does not control --------------------------------------------------
  const harmless = 'FEATURE_FLAG=blue-green-rollout\nLOG_FORMAT=json\nCACHE_TTL=300\n';
  for (const [name, args] of [[FILE, { path: 'C:\\workspace\\demo\\.env' }], [FILE, { path: 'deploy/server.pem' }], [FILE, { path: '.env.production' }],
    [SHELL, { command: 'cat .env' }], [FILE, { path: '~/.ssh/id_rsa' }], [FILE, { path: 'config/credentials.json' }]]) {
    const result = await readThrough(name, args, harmless);
    check(/WITHHELD by ChatMCP/.test(result.text), 'the notice replaces the content', JSON.stringify(args));
    check(!result.text.includes('blue-green-rollout') && !result.text.includes('CACHE_TTL'), 'no line of a protected file is delivered, secret-shaped or not', JSON.stringify(args));
  }
  check(flow.calls.some((call) => call.args.path === '.env.production'), 'the tool did run (only its output was withheld)');
  const normal = await readThrough(FILE, { path: 'src/app.ts' }, 'export const answer = 42;');
  check(normal.text.includes('export const answer = 42;'), 'an ordinary file is delivered as before');
  const filtered = flow.task.events.filter((event) => event.type === 'outbound_filtered' && event.withheld?.length);
  check(filtered.length >= 6, 'the ledger records each withheld read', `${filtered.length}`);
  console.log(`PASS six protected-file reads withheld whole (${filtered.length} ledger entries), an ordinary file untouched`);

  // ---- 4. registered secrets, and what the ledger may contain ---------------------------------------------------------
  const masked = await readThrough(FILE, { path: 'notes.txt' }, 'the hub token is registered-secret-value-77 and that is all');
  check(!masked.text.includes('registered-secret-value-77') && masked.text.includes('[REDACTED]'), 'a secret registered with the Hub is still masked');
  const ledgerText = JSON.stringify(flow.task.events);
  for (const sample of corpus) check(!ledgerText.includes(sample.secret), 'the ledger holds no raw match', sample.label);
  check(/outbound_filtered/.test(ledgerText), 'the ledger exists');
  console.log('PASS registered secrets still masked; the ledger carries labels and counts only');

  // The ledger of what left the computer: every message handed to the extension is recorded as it was handed over.
  const transcript = (await fs.readFile(path.join(flow.directory, 'tasks', task.id, 'transcript.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const sent = transcript.filter((entry) => entry.type === 'outbound_message');
  check(sent.length >= corpus.length, 'every delivered message is in the ledger', `${sent.length} entries`);
  const recorded = sent.find((entry) => entry.messageId === masked.id);
  check(recorded && recorded.text === masked.text && recorded.sha256 === createHash('sha256').update(masked.text).digest('hex') && recorded.bytes === Buffer.byteLength(masked.text), 'an entry holds the exact text, its size and its hash');
  for (const entry of sent) for (const sample of corpus) if (entry.text.includes(sample.secret)) assert.fail(`the ledger holds a raw secret (${sample.label})`);
  check(true, 'the ledger of sent messages holds no raw match');
  console.log(`PASS the transcript records what was sent: ${sent.length} messages, exact text with size and hash, no raw secret`);

  // ---- 5. the backstop in messageView ------------------------------------------------------------------------------------
  {
    const leak = `AKIA${body('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16)}`;
    await flow.reply(message, { kind: 'tool', name: LIST, arguments: {} });
    const taskNow = flow.task;
    taskNow.message.text += `\nstored by an older Hub: ${leak}`; // a message that bypassed makeMessage
    const polled = await flow.poll();
    check(!polled.message.text.includes(leak) && polled.message.text.includes('[REDACTED:aws-access-key-id]'), 'poll() redacts a stored message on its way out');
    const claimed = await flow.runner.claim({ clientId: flow.clientId, taskId: taskNow.id, messageId: polled.message.id });
    check(!claimed.message.text.includes(leak), 'claim() redacts as well');
    await flow.runner.sent({ clientId: flow.clientId, taskId: taskNow.id, messageId: polled.message.id, url: 'https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b' });
    message = polled.message;
    console.log('PASS poll() and claim() redact even a message that never went through makeMessage');
  }

  // ---- 6. the model finishes, then a continuation prompt with a pasted secret ---------------------------------------
  await flow.reply(message, { kind: 'final', text: 'Done.' });
  check(flow.task.status === 'completed', 'the task completed', flow.task.status);
  const pasted = `ghp_${body('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 36)}`;
  await flow.runner.continue({ id: task.id, prompt: `Push to the remote using ${pasted} and tell me the result.` });
  flow.context = flow.runner.context;
  const resumed = await flow.poll();
  check(resumed.message && !resumed.message.text.includes(pasted) && resumed.message.text.includes('[REDACTED:github-token]'), 'a continuation prompt is scrubbed');
  check(resumed.message.text.includes('Push to the remote using'), 'the rest of the prompt is kept');
  check(flow.task.prompts.at(-1).text.includes(pasted), 'the owner still sees what they typed in the task history');
  console.log('PASS continuation prompt scrubbed on the way out, kept as typed in the local history');
} finally { await flow.close(); }

// ---- 7. first message and handoff text -----------------------------------------------------------------------------------
{
  const handoffFlow = await makeFlow({ tools });
  try {
    const key = `AKIA${body('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16)}`;
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${body('abcdefghijklmnopqrstuvwxyz0123456789_-', 43)}`;
    const pem = `-----BEGIN PRIVATE KEY-----\n${body('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', 64)}\n-----END PRIVATE KEY-----`;
    await handoffFlow.start({ prompt: `Deploy with the key ${key} please`, handoffText: `Earlier the user pasted a token: ${jwt}\nand a key:\n${pem}\nthen asked to deploy.` });
    const first = await handoffFlow.poll();
    for (const secret of [key, jwt, pem.split('\n')[1]]) check(!first.message.text.includes(secret), 'the first message holds no pasted secret');
    check(first.message.text.includes('Deploy with the key') && first.message.text.includes('then asked to deploy'), 'the rest of the prompt and handoff is kept');
    check(/CROSS-TRANSPORT CONTEXT/.test(first.message.text), 'the handoff is still attached');
    check(envelopeOf(first.message.text).nonce === handoffFlow.task.nonce, 'the first message still carries the nonce');
    check(Buffer.byteLength(first.message.text) <= 4800, 'the first message is within the limit');
    console.log('PASS first message and handoff text scrubbed, the pasted secrets are gone');
  } finally { await handoffFlow.close(); }
}

// ---- 8. the size limit is applied to the scrubbed text ---------------------------------------------------------------------
{
  // A placeholder is longer than a short secret: 100 four-character passwords (about 1.7 KB as typed) grow past the
  // 4800-byte limit once masked. The limit must see the masked text; the message must be refused, not sent over the limit.
  const crowded = await makeFlow({ tools });
  try {
    const prompt = Array.from({ length: 100 }, () => 'password: "abcd"').join('\n');
    assert.ok(Buffer.byteLength(prompt) < 2000);
    await assert.rejects(crowded.start({ prompt }), (error) => error.code === 'initial_chat_message_too_large');
    check(true, 'the size limit is applied after masking');
    console.log('PASS the 4800-byte limit is checked on the masked text (a prompt that only fits unmasked is refused)');
  } finally { await crowded.close(); }
}

console.log(`PASS outbound runner suite (${checks} checks)`);
