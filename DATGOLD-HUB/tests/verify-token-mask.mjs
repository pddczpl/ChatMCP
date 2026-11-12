// The pieces of an answer a model streams are shown to the page as `token` events. The answer the task keeps is masked (lib/agent.mjs, #redact: the secrets the Hub knows, key-shaped
// and bearer-shaped strings, what the provider masks); the pieces must not show more than that. A secret can be cut between two pieces, so each piece cannot be masked on its own:
// lib/token-mask.mjs holds back the end of the text that could still turn into something masked, and only sends what the masked whole will begin with.
//
// The question every case asks: for every way of cutting the text into pieces, is the text sent (a) free of every secret and of every prefix of one that the final mask removes, and
// (b) once flushed, exactly the masked whole?
import assert from 'node:assert/strict';
import { createTokenMask } from '../lib/token-mask.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const SECRET = 'hub-secret-9f8e7d6c5b4a';
const SPACED = 'open sesame please';
const secrets = [SECRET, SPACED];
// The same rules as lib/agent.mjs #redact (registered secrets, then key and bearer shapes).
const redact = (text) => {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join('[REDACTED]');
  return out.replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
};

/** Feeds `pieces` through a mask; returns what was sent, as the page would hold it (a reset drops what was shown), and every intermediate view. */
function play(pieces, { flush = true, resetAfter = -1 } = {}) {
  const sent = [];
  let shown = '';
  const views = [];
  const mask = createTokenMask({ redact, secrets: () => secrets, emit: (text) => { sent.push(['token', text]); shown += text; views.push(shown); }, reset: () => { sent.push(['reset']); shown = ''; views.push(shown); } });
  pieces.forEach((piece, index) => { mask.push(piece); if (index === resetAfter) mask.reset(); });
  if (flush) mask.flush();
  return { sent, shown, views };
}
/** Every way to cut `text` in two, and every way to cut it into single characters. */
function* cuts(text) {
  for (let i = 1; i < text.length; i += 1) yield [text.slice(0, i), text.slice(i)];
  yield [...text];
}
const leaks = (view, secret) => { for (let k = 4; k <= secret.length; k += 1) if (view.includes(secret.slice(0, k))) return secret.slice(0, k); return null; };

// ---- 1. what is sent ends up as the masked whole, every way it is cut ------------------------------------------------------------------------------------
{
  const texts = [
    `Your key is ${SECRET} and nothing else.`,
    `A key looks like sk-e2eStreamProbe0123456789 here.`,
    `Send it with Authorization: Bearer abc.def-ghi_123 next time.`,
    `Say ${SPACED} to enter.`,
    `${SECRET}`,
    `Ends with the key ${SECRET}`,
    `Ends with sk-proj-0123456789abcdefABCD`,
    `Dự án là một máy tính.`,
    'plain text without anything',
    `two: ${SECRET} and ${SECRET}.`,
  ];
  for (const text of texts) for (const pieces of cuts(text)) {
    const { shown, views, sent } = play(pieces);
    assert.equal(shown, redact(text), `cut ${JSON.stringify(pieces)}: the page ends up with the masked whole`);
    assert.ok(!sent.some(([kind]) => kind === 'reset'), `cut ${JSON.stringify(pieces)}: no reset was needed`);
    for (const view of views) {
      for (const secret of [SECRET, SPACED, 'sk-e2eStreamProbe0123456789', 'sk-proj-0123456789abcdefABCD', 'abc.def-ghi_123']) {
        const leaked = leaks(view, secret);
        assert.equal(leaked, null, `cut ${JSON.stringify(pieces)}: the page never showed ${JSON.stringify(leaked)} of ${secret} (it showed ${JSON.stringify(view)})`);
      }
    }
  }
  ok('every way of cutting ten texts into pieces: the page ends with the masked whole and never shows four characters or more of a secret');
}

// ---- 2. text is not held back for longer than it must be -------------------------------------------------------------------------------------------------
{
  const { sent } = play(['Dự án ', 'là một ', 'máy tính.'], { flush: false });
  assert.deepEqual(sent, [['token', 'Dự án '], ['token', 'là một '], ['token', 'máy ']], 'a word is sent once the space after it arrived; the last word waits');
  const flushed = play(['Dự án ', 'là một ', 'máy tính.']);
  assert.deepEqual(flushed.sent.at(-1), ['token', 'tính.'], 'and comes with the flush');
  ok('a word is held only until the text after it shows it is not the start of something masked');
}
{
  // The start of a secret is held, the text before it is not.
  const { sent } = play(['See ', 'hub-sec'], { flush: false });
  assert.deepEqual(sent, [['token', 'See ']], 'what could be the start of a secret is held');
  const { sent: spaced } = play(['Say open ', 'sesame'], { flush: false });
  assert.deepEqual(spaced, [['token', 'Say ']], 'also when the secret has spaces in it');
  const { sent: notSecret } = play(['Say open ', 'door '], { flush: false });
  assert.deepEqual(notSecret, [['token', 'Say '], ['token', 'open door ']], 'and sent once it is not one');
  // A whole secret with spaces, the last word of it not yet ended: the text before the secret is still sent.
  const { sent: whole } = play(['Say open sesame please'], { flush: false });
  assert.deepEqual(whole, [['token', 'Say ']], 'a cut inside a whole secret backs off to the space before it, not to nothing');
  ok('the start of a secret is held, even one with spaces in it, and released when the text goes elsewhere');
}

// ---- 3. a reset starts over ------------------------------------------------------------------------------------------------------------------------------
{
  const { sent, shown } = play(['The key ', 'is hub-se'], { resetAfter: 1 });
  assert.deepEqual(sent, [['token', 'The key '], ['token', 'is '], ['reset']], 'a reset drops what was held and says so');
  assert.equal(shown, '', 'nothing of the cut stream is sent after it');
  const again = play(['The key ', 'is hub-se', `The key is ${SECRET}.`], { resetAfter: 1 });
  assert.equal(again.shown, redact(`The key is ${SECRET}.`), 'the next stream is masked from its own start');
  ok('a reset forgets the held text; the next stream starts from nothing');
}

// ---- 4. the mask is asked again for every piece ---------------------------------------------------------------------------------------------------------
{
  const late = [];
  const sent = [];
  const mask = createTokenMask({ redact: (text) => { let out = text; for (const secret of late) out = out.split(secret).join('[REDACTED]'); return out; }, secrets: () => late, emit: (text) => sent.push(text), reset: () => sent.push('<reset>') });
  // With spaces in it: only the list of secrets can hold it.
  late.push('late secret 123');
  mask.push('it is late secret 1');
  assert.equal(sent.join(''), 'it is ', 'the start of a secret registered after the mask was made is held');
  mask.push('23 now');
  mask.flush();
  assert.equal(sent.join(''), 'it is [REDACTED] now', 'and the secret is masked');
  ok('the list of secrets is read at every piece');
}

// ---- 5. empty pieces and a flush of nothing --------------------------------------------------------------------------------------------------------------
{
  const { sent } = play(['', 'a ', '', 'b']);
  assert.deepEqual(sent, [['token', 'a '], ['token', 'b']], 'an empty piece sends nothing');
  assert.deepEqual(play([]).sent, [], 'a flush with nothing held sends nothing');
  const twice = play(['a b']);
  assert.deepEqual(twice.sent, [['token', 'a '], ['token', 'b']]);
  ok('empty pieces and an empty flush send nothing');
}

// ---- 6. a rule the mask cannot see coming ---------------------------------------------------------------------------------------------------------------
{
  // A mask that hides a phrase it does not list as a secret (a provider's own rule): the text already sent turns out not to be the start of the masked whole. The watchers are told to
  // drop it and get the masked whole from its start.
  const sent = [];
  const mask = createTokenMask({ redact: (text) => text.split('open door').join('[R]'), secrets: () => [], emit: (text) => sent.push(text), reset: () => sent.push('<reset>') });
  mask.push('open ');
  mask.push('door.');
  assert.deepEqual(sent, ['open '], 'before the end nothing more is sent: the text after the last space no longer agrees with what was sent');
  mask.flush();
  assert.deepEqual(sent, ['open ', '<reset>', '[R].'], 'at the end: a reset, then the masked whole');
  ok('when the masked whole stops beginning with what was sent, the watchers drop it and get the masked whole');
}

// ---- 7. the cost of a long answer --------------------------------------------------------------------------------------------------------------------
// The mask runs on the Hub's one thread. Masking the whole text so far at every piece costs the square of the answer (60,000 characters in pieces of 4: seconds of CPU). What the
// mask is asked to mask, summed over the whole answer, must grow with the answer, not with its square: counted in characters handed to `redact`, so the check does not depend on
// the speed of the machine.
{
  const measure = (text, size) => {
    let masked = 0;
    let looks = 0;
    let shown = '';
    const counted = (value) => { masked += value.length; return redact(value); };
    const mask = createTokenMask({ redact: counted, secrets: () => { looks += 1; return secrets; }, emit: (piece) => { shown += piece; }, reset: () => { shown = ''; } });
    for (let i = 0; i < text.length; i += size) mask.push(text.slice(i, i + size));
    mask.flush();
    return { masked, looks, shown };
  };
  const words = ['the', 'function', 'returns', 'a', 'value,', 'and', `${SECRET}`, 'then', 'sk-proj-0123456789abcdefXYZ', 'Bearer', 'abc.def', 'with', SPACED, 'line\n'];
  let prose = '';
  for (let i = 0; prose.length < 100_000; i += 1) prose += words[(i * 7) % words.length] + ' ';
  const long = measure(prose, 4);
  assert.equal(long.shown, redact(prose), '100,000 characters of prose in pieces of 4: the page ends with the masked whole');
  assert.ok(long.masked <= 60 * prose.length, `and redact was handed at most 60 times the length of the text (${long.masked} characters for ${prose.length}, ${(long.masked / prose.length).toFixed(1)} times)`);
  // A run without a space (a long hash, base64, minified code): the last word is held, so nothing of it can be sent before it ends.
  const run = 'x'.repeat(60_000) + ' done';
  const blob = measure(run, 4);
  assert.equal(blob.shown, redact(run), '60,000 characters without a space: the page ends with the masked whole');
  assert.ok(blob.masked <= 60 * run.length, `and redact was handed at most 60 times its length (${blob.masked} characters for ${run.length})`);
  // A piece that only makes the held word longer cannot release anything: it is not looked at (looking at it scans the whole word, which is again the square of the word). Each
  // look reads the list of secrets once, so the reads count the looks.
  assert.ok(blob.looks <= 5, `the pieces of one long word are not looked at one by one (${blob.looks} looks for ${Math.ceil(run.length / 4)} pieces)`);
  ok(`a long answer costs in proportion to its length: ${(long.masked / prose.length).toFixed(1)} and ${(blob.masked / run.length).toFixed(1)} characters masked per character of text`);
}

console.log(`\nPASS: ${checks} token mask checks`);
