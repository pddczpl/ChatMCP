import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTES_PREFIX, autoView, cooldownMs, errorGroup, formatWhen, noticeKind, safeNotesUrl, statusKey } from '../src/lib/updates.ts';

// What the page says about the update notice (lib/update-check.mjs on the Hub): which strip to draw, which link to trust, how long a button waits, how a failure is named.
// Plain functions, so the words and the rules are pinned without a browser.
const update = (overrides = {}) => ({
  current: '3.10.2', latest: '3.10.3', available: true, checkedAt: '2026-10-26T12:00:00.000Z', lastAttemptAt: '2026-10-26T12:00:00.000Z',
  notesUrl: 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3', installerName: 'DatGoldSetup.exe', skippedVersion: null, error: null, checking: false,
  manualCheckAfter: '2026-10-26T12:01:00.000Z', nextAutomaticCheckAt: null, autoCheck: { enabled: true, saved: true, needsChoice: false }, ...overrides,
});
const asking = (overrides = {}) => update({ autoCheck: { enabled: false, saved: null, needsChoice: true }, ...overrides });

test('the strip under the header is the question while it is unanswered, then the release on offer, and nothing otherwise', () => {
  assert.equal(noticeKind(asking({ latest: null, available: false })), 'question', 'unanswered: ask');
  assert.equal(noticeKind(asking()), 'question', 'the question comes first even when a manual check found a release');
  assert.equal(noticeKind(update()), 'available', 'answered, and a release is on offer');
  assert.equal(noticeKind(update({ skippedVersion: '3.10.3' })), 'none', 'a release the owner skipped is not shown');
  assert.equal(noticeKind(update({ skippedVersion: '3.10.2' })), 'available', 'a skip of another version does not hide this one');
  assert.equal(noticeKind(update({ skippedVersion: '3.10.4', latest: '3.10.5' })), 'available', 'a newer release than the skipped one is shown again');
  assert.equal(noticeKind(update({ available: false, latest: '3.10.2' })), 'none', 'up to date: nothing');
  assert.equal(noticeKind(update({ latest: null, available: false })), 'none', 'nothing known: nothing');
  assert.equal(noticeKind(update({ autoCheck: { enabled: false, saved: false, needsChoice: false } })), 'available', 'said no, and a manual check found a release: it is shown');
  for (const missing of [null, undefined, {}, 'text', 5, []]) assert.equal(noticeKind(missing), 'none', `nothing to draw for ${JSON.stringify(missing)}`);
  assert.equal(noticeKind({ ...update(), autoCheck: undefined }), 'none', 'a state without the answer of the owner is read as nothing, not as a question');
  assert.equal(noticeKind(update({ error: { code: 'update_http', message: 'x', status: 500, at: '2026-10-26T12:00:00.000Z' } })), 'available', 'a failed check does not take away the last good release');
});

test('a link to the notes is trusted only when it is the page of the tag of the release on offer', () => {
  assert.equal(NOTES_PREFIX, 'https://github.com/pddczpl/ChatMCP/releases/tag/v');
  assert.equal(safeNotesUrl(update()), 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3');
  const bad = [
    'https://evil.example/pddczpl/ChatMCP/releases/tag/v3.10.3', 'http://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3', 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.4', 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3/',
    'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3?x=1', 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3#x', 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3 ', 'https://github.com.evil.example/pddczpl/ChatMCP/releases/tag/v3.10.3',
    'https://user@github.com/pddczpl/ChatMCP/releases/tag/v3.10.3', 'javascript:alert(1)', 'data:text/html,x', '/releases/tag/v3.10.3', '', null, undefined, 5,
  ];
  for (const url of bad) assert.equal(safeNotesUrl(update({ notesUrl: url })), null, `not trusted: ${JSON.stringify(url)}`);
  assert.equal(safeNotesUrl(update({ latest: null, notesUrl: 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3' })), null, 'a link with no release it belongs to');
  assert.equal(safeNotesUrl(null), null);
  assert.equal(safeNotesUrl({}), null);
});

test('"Check now" waits out the minute the Hub keeps between two requests, and not a moment more', () => {
  const at = Date.parse('2026-10-26T12:00:00.000Z');
  const state = update({ manualCheckAfter: '2026-10-26T12:01:00.000Z' });
  assert.equal(cooldownMs(state, at), 60_000);
  assert.equal(cooldownMs(state, at + 59_999), 1);
  assert.equal(cooldownMs(state, at + 60_000), 0);
  assert.equal(cooldownMs(state, at + 3_600_000), 0);
  assert.equal(cooldownMs(update({ manualCheckAfter: null }), at), 0, 'no attempt yet: no wait');
  for (const odd of [null, undefined, {}, update({ manualCheckAfter: 'soon' })]) assert.equal(cooldownMs(odd, at), 0, `no wait for ${JSON.stringify(odd)?.slice(0, 40)}`);
  assert.equal(cooldownMs(update({ manualCheckAfter: '2999-01-01T00:00:00.000Z' }), at), 60_000, 'a time far ahead (a clock that was wrong) never holds the button for more than the minute');
});

test('the status line says what is known, in one of four ways', () => {
  assert.equal(statusKey(update()), 'upd_status_available');
  assert.equal(statusKey(update({ skippedVersion: '3.10.3' })), 'upd_status_skipped');
  assert.equal(statusKey(update({ available: false, latest: '3.10.2' })), 'upd_status_uptodate');
  assert.equal(statusKey(update({ available: false, latest: '3.10.1' })), 'upd_status_uptodate');
  assert.equal(statusKey(update({ latest: null, available: false })), 'upd_status_unknown');
  assert.equal(statusKey(null), 'upd_status_unknown');
  assert.equal(statusKey(undefined), 'upd_status_unknown');
});

test('the owner\'s choice is shown as three states, and "on by default" is not the same as "on"', () => {
  assert.deepEqual(autoView(asking()), { checked: false, statusKey: 'upd_auto_unset', disabled: false });
  assert.deepEqual(autoView(update()), { checked: true, statusKey: 'upd_auto_on', disabled: false });
  assert.deepEqual(autoView(update({ autoCheck: { enabled: false, saved: false, needsChoice: false } })), { checked: false, statusKey: 'upd_auto_off', disabled: false });
  assert.deepEqual(autoView(update({ autoCheck: { enabled: true, saved: null, needsChoice: false } })), { checked: true, statusKey: 'upd_auto_default_on', disabled: false }, 'the Hub was set to check until the owner says no');
  assert.deepEqual(autoView(null), { checked: false, statusKey: 'upd_auto_unset', disabled: true }, 'the Hub has not said: the box cannot be used');
  assert.deepEqual(autoView({}), { checked: false, statusKey: 'upd_auto_unset', disabled: true });
});

test('a failure is named by what went wrong, in six groups, and an unknown code is "other"', () => {
  const groups = {
    update_network: 'network', update_timeout: 'timeout', update_http: 'http',
    update_redirect_refused: 'redirect', update_redirect_limit: 'redirect', update_redirect_invalid: 'redirect',
    update_too_large: 'answer', update_invalid_manifest: 'answer', update_not_a_release: 'answer',
    update_failed: 'other', update_current_invalid: 'other', update_feed_refused: 'other', '': 'other', nothing: 'other',
  };
  for (const [code, group] of Object.entries(groups)) assert.equal(errorGroup(code), group, code);
  for (const odd of [null, undefined, 5, {}]) assert.equal(errorGroup(odd), 'other');
  assert.equal(errorGroup('__proto__'), 'other');
  assert.equal(errorGroup('constructor'), 'other');
});

test('a time is written for the language of the page, in the time zone asked for', () => {
  const iso = '2026-10-26T12:34:00.000Z';
  assert.match(formatWhen(iso, 'en', 'UTC'), /Oct 26, 2026/);
  assert.match(formatWhen(iso, 'en', 'UTC'), /12:34/);
  assert.match(formatWhen(iso, 'vi', 'UTC'), /26/);
  assert.match(formatWhen(iso, 'vi', 'UTC'), /12:34/);
  assert.notEqual(formatWhen(iso, 'en', 'UTC'), formatWhen(iso, 'vi', 'UTC'), 'the two languages do not write it the same way');
  for (const odd of [null, undefined, '', 'yesterday', 5, {}]) assert.equal(formatWhen(odd, 'en', 'UTC'), '–', `a dash for ${JSON.stringify(odd)}`);
});
