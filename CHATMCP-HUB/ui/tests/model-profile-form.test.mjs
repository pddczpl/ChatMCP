import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, parseContextWindowInput } from '../src/lib/context-window.ts';
import { buildProfilePayload, draftFromProfile, emptyProfileDraft } from '../src/lib/model-profile-form.ts';
import * as hub from '../../lib/context-window.mjs';

test('the settings forms and the Hub use one context-window range', () => {
  assert.equal(CONTEXT_WINDOW_MIN, hub.CONTEXT_WINDOW_MIN);
  assert.equal(CONTEXT_WINDOW_MAX, hub.CONTEXT_WINDOW_MAX);
  for (const value of ['', ' ', '0', '3000', '4095', '4096', '64000', '2000000', '5000000', 'abc', '12.5', '-1']) {
    const mine = parseContextWindowInput(value);
    const theirs = hub.parseContextWindow(value.trim() === '' ? null : value);
    if (theirs === undefined) assert.equal(mine.ok, false, `${value} is refused by both`);
    else {
      assert.equal(mine.ok, true, `${value} is accepted by both`);
      assert.equal(mine.value, theirs, `${value} means the same number`);
    }
  }
});

test('a window below the minimum is refused with the range; one above the maximum is clamped; empty means unknown', () => {
  const tooSmall = parseContextWindowInput('3000');
  assert.equal(tooSmall.ok, false);
  assert.match(tooSmall.message, /4,096/);
  assert.match(tooSmall.message, /2,000,000/);
  assert.deepEqual(parseContextWindowInput('5000000'), { ok: true, value: 2_000_000, clamped: true });
  assert.deepEqual(parseContextWindowInput('64000'), { ok: true, value: 64000, clamped: false });
  assert.deepEqual(parseContextWindowInput(''), { ok: true, value: null, clamped: false });
});

const filled = () => ({ ...emptyProfileDraft(), model: 'claude-x', apiBaseUrl: 'https://gw.example.com', protocol: 'anthropic' });

test('a profile carries its custom path and, only when edited, its custom headers', () => {
  const plain = buildProfilePayload(filled());
  assert.equal(plain.customPath, '', 'an empty path is sent so that it can be cleared');
  assert.equal('customHeaders' in plain, false, 'untouched headers are not resent: the Hub keeps the sealed ones');
  const draft = { ...filled(), customPath: ' /proxy/{model}/messages ', customHeadersText: '[{"name":"X-Tenant","envKeyName":"CHATMCP_TENANT"}]', customHeadersDirty: true };
  const payload = buildProfilePayload(draft);
  assert.equal(payload.customPath, '/proxy/{model}/messages');
  assert.deepEqual(payload.customHeaders, [{ name: 'X-Tenant', envKeyName: 'CHATMCP_TENANT' }]);
  assert.deepEqual(buildProfilePayload({ ...filled(), customHeadersText: '', customHeadersDirty: true }).customHeaders, [], 'an edited, empty field clears the headers');
});

test('malformed headers never leave the form', () => {
  for (const text of ['not json', '{"name":"X"}', '"X-A: b"'])
    assert.throws(() => buildProfilePayload({ ...filled(), customHeadersText: text, customHeadersDirty: true }), /JSON/);
});

test('the context window of a profile is validated with the shared range and can be cleared', () => {
  assert.throws(() => buildProfilePayload({ ...filled(), contextWindow: '3000' }), /4,096/);
  assert.equal(buildProfilePayload({ ...filled(), contextWindow: '5000000' }).contextWindow, 2_000_000);
  assert.equal(buildProfilePayload({ ...filled(), contextWindow: '' }).contextWindow, null, 'emptied: sent as null so that the Hub forgets it');
});

test('editing a saved profile starts from its path and the NAMES of its headers, never a value', () => {
  const draft = draftFromProfile({
    id: 'tenant', name: 'Tenant', provider: 'anthropic', protocol: 'anthropic', model: 'claude-x', apiBaseUrl: 'https://gw.example.com',
    customPath: '/proxy/{model}/messages', customHeaders: [{ name: 'X-Tenant', source: 'protected' }],
  });
  assert.equal(draft.customPath, '/proxy/{model}/messages');
  assert.equal(draft.customHeadersText, '', 'the textarea starts empty: values are never returned by the Hub');
  assert.equal(draft.customHeadersDirty, false);
  assert.equal('customHeaders' in buildProfilePayload(draft), false);
});
