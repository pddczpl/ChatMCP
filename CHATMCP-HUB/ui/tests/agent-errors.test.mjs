import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundleTsx } from './support/bundle.mjs';

// The Hub names why it refused something with a code; the owner reads the sentence for that code in the language on screen, not the Hub's own
// text (which may be in the other language) and not a bare "HTTP 409".
const { loaded, dispose } = await bundleTsx(`
  export { translations, translate } from './src/lib/i18n';
  export { agentErrorText } from './src/lib/agent-errors';
`, 'chatmcp-errors-');
after(dispose);
const { translations, translate, agentErrorText } = loaded;
const tFor = (lang) => (key, params) => translate(lang, key, params);
const hubError = (code, message) => Object.assign(new Error(message), { status: 409, code });

test('an error with a code the page knows is told in the language on screen, whatever language the Hub used', () => {
  const error = hubError('stale_revision', 'Branch HEAD changed after review; review its diff again.');
  assert.match(agentErrorText(error, tFor('en'), 'x'), /branch changed after it was committed or read/i);
  assert.match(agentErrorText(error, tFor('vi'), 'x'), /nhánh/i);
  assert.notEqual(agentErrorText(error, tFor('en'), 'x'), error.message);
  const busy = hubError('coding_busy', 'Wait until active workers finish.');
  assert.match(agentErrorText(busy, tFor('en'), 'x'), /still going on/);
  assert.match(agentErrorText(hubError('worker_permission_denied', 'Parent is not in Autonomous mode.'), tFor('en'), 'x'), /Autonomous/);
});

test('a code the page has no sentence for shows the Hub’s own message, and then a fallback', () => {
  assert.equal(agentErrorText(hubError('invalid_tasks', 'Tasks require unique safe IDs.'), tFor('en'), 'fallback'), 'Tasks require unique safe IDs.');
  assert.equal(agentErrorText(hubError(undefined, 'Hub is not answering'), tFor('vi'), 'fallback'), 'Hub is not answering');
  assert.equal(agentErrorText(new Error(''), tFor('en'), 'fallback'), 'fallback');
  assert.equal(agentErrorText(null, tFor('en'), 'fallback'), 'fallback');
  assert.equal(agentErrorText({ code: 42 }, tFor('en'), 'fallback'), 'fallback');
  assert.equal(agentErrorText('boom', tFor('en'), 'fallback'), 'fallback');
});

test('a code cannot reach a dictionary key it was not meant to (no key is built from anything but a plain code)', () => {
  for (const code of ['constructor', '__proto__', 'toString', 'x y', '../agent_status_failed']) {
    assert.equal(agentErrorText(hubError(code, 'Hub text'), tFor('en'), 'fallback'), 'Hub text', code);
  }
});

test('every sentence written for a code is for a code the Hub really sends, and has both languages', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const source = ['hub.mjs', 'lib/coding-orchestrator.mjs', 'lib/worker-test-broker.mjs'].map((file) => fs.readFileSync(root + file, 'utf8')).join('\n');
  const codes = Object.keys(translations.vi).filter((key) => key.startsWith('agent_error_')).map((key) => key.slice('agent_error_'.length));
  assert.ok(codes.length >= 15, `there are ${codes.length} sentences`);
  for (const code of codes) {
    assert.ok(source.includes(`'${code}'`), `${code} is not a code the Hub sends any more`);
    assert.ok(translations.en[`agent_error_${code}`]?.trim(), `en: ${code}`);
    assert.doesNotMatch(translations.en[`agent_error_${code}`], /[ăâđêôơưàáảãạ]/i, `en.${code} still reads Vietnamese`);
  }
});
