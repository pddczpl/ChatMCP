import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NOTES_PREFIX, appliedView, applyErrorGroup, applyReducer, applyView, autoView, cooldownMs, downloadErrorGroup, downloadView, errorGroup, formatBytes, formatWhen, hasActiveWork, noticeKind, notesUrlFor, pollInterval, refusalKey, safeNotesUrl, signatureView, statusKey } from '../src/lib/updates.ts';

// What the page says about the update notice (lib/update-check.mjs on the Hub): which strip to draw, which link to trust, how long a button waits, how a failure is named.
// Plain functions, so the words and the rules are pinned without a browser.
const update = (overrides = {}) => ({
  current: '3.10.2', latest: '3.10.3', available: true, checkedAt: '2026-10-26T12:00:00.000Z', lastAttemptAt: '2026-10-26T12:00:00.000Z',
  notesUrl: 'https://github.com/pddczpl/ChatMCP/releases/tag/v3.10.3', installerName: 'DatGoldSetup.exe', installerBytes: 232753314, signature: null, kid: null, skippedVersion: null, error: null, checking: false,
  manualCheckAfter: '2026-10-26T12:01:00.000Z', nextAutomaticCheckAt: null, autoCheck: { enabled: true, saved: true, needsChoice: false }, download: { state: 'idle' }, ...overrides,
});
/** A release whose signature checked, so that it can be downloaded. */
const signed = (overrides = {}) => update({ signature: 'valid', kid: '1a2b3c4d', ...overrides });
const failure = (code, status = null) => ({ code, message: 'diagnostic in English that is never shown as it is', status, at: '2026-10-26T12:05:00.000Z' });
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

test('a failure is named by what went wrong, in ten groups, and an unknown code is "other"', () => {
  const groups = {
    update_network: 'network', update_timeout: 'timeout', update_http: 'http',
    update_redirect_refused: 'redirect', update_redirect_limit: 'redirect', update_redirect_invalid: 'redirect',
    update_too_large: 'answer', update_invalid_manifest: 'answer', update_not_a_release: 'answer',
    update_state_unsaved: 'save',
    update_signature_invalid: 'signature', update_signature_unknown_key: 'signature_key', update_signature_unreachable: 'signature_read',
    update_failed: 'other', update_current_invalid: 'other', update_feed_refused: 'other', '': 'other', nothing: 'other',
  };
  for (const [code, group] of Object.entries(groups)) assert.equal(errorGroup(code), group, code);
  for (const odd of [null, undefined, 5, {}]) assert.equal(errorGroup(odd), 'other');
  assert.equal(errorGroup('__proto__'), 'other');
  assert.equal(errorGroup('constructor'), 'other');
});

test('a refusal of the Hub that has a code of the update notice is told in the words of the page, and any other is left as the Hub said it', () => {
  assert.equal(refusalKey('update_skip_stale'), 'upd_refused_stale');
  assert.equal(refusalKey('update_skip_invalid'), 'upd_refused_invalid');
  assert.equal(refusalKey('update_setting_invalid'), 'upd_refused_invalid');
  assert.equal(refusalKey('update_save_failed'), 'upd_save_failed');
  assert.equal(refusalKey('update_unavailable'), 'upd_refused_unavailable');
  for (const other of ['hub_auth_required', 'something_new', '', null, undefined, 5, {}, '__proto__', 'constructor']) assert.equal(refusalKey(other), null, `${JSON.stringify(other)}: no words of the page`);
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

test('the size of an installer is said in megabytes, the way Windows says it', () => {
  assert.equal(formatBytes(232753314, 'en'), '222 MB', 'the installer of 3.10.2: 221.97 MB');
  assert.equal(formatBytes(5 * 1048576, 'en'), '5.0 MB', 'under ten, one decimal');
  assert.equal(formatBytes(5 * 1048576, 'vi'), '5,0 MB', 'in Vietnamese a comma');
  assert.equal(formatBytes(1048576 * 1000, 'en'), '1,000 MB');
  assert.equal(formatBytes(1536, 'en'), '1.5 KB');
  assert.equal(formatBytes(0, 'en'), '0 KB');
  for (const odd of [null, undefined, -1, Number.NaN, Infinity, '5', {}]) assert.equal(formatBytes(odd, 'en'), '–', `a dash for ${JSON.stringify(odd)}`);
});

test('what the page says about the signature of the release on offer: six ways, and only one of them allows a download', () => {
  assert.equal(signatureView(signed()), 'valid');
  assert.equal(signatureView(update({ signature: 'missing' })), 'missing');
  assert.equal(signatureView(update({ signature: 'invalid', error: failure('update_signature_invalid') })), 'invalid');
  assert.equal(signatureView(update({ signature: 'invalid', error: failure('update_signature_unknown_key') })), 'unknown_key', 'a key this version does not know: the person can install a newer version');
  assert.equal(signatureView(update({ signature: 'invalid', error: null })), 'invalid', 'invalid without an error to name it is still invalid, never valid');
  assert.equal(signatureView(update({ signature: null, error: failure('update_signature_unreachable', 500) })), 'unreadable');
  assert.equal(signatureView(update({ signature: null })), 'unchecked');
  assert.equal(signatureView(update({ signature: null, error: failure('update_http', 500) })), 'unchecked', 'a failure of the first chain says nothing about the signature');
  for (const odd of ['yes', 'VALID', true, 1, {}, [], undefined]) assert.equal(signatureView(update({ signature: odd })), 'unchecked', `${JSON.stringify(odd)} is not a signature that checked`);
  assert.equal(signatureView(null), 'unchecked');
  assert.equal(signatureView({}), 'unchecked');
});

test('the download: what to offer, show or say for the release on offer', () => {
  const idle = downloadView(signed());
  assert.deepEqual([idle.kind, idle.canDownload, idle.canCancel, idle.version, idle.bytes], ['offer', true, false, '3.10.3', 232753314], 'a signed release with nothing downloaded: offer the download, with its size');
  for (const [signature, error] of [['missing', null], ['invalid', failure('update_signature_invalid')], [null, null], [null, failure('update_signature_unreachable', 500)]]) {
    const blocked = downloadView(update({ signature, error }));
    assert.deepEqual([blocked.kind, blocked.canDownload, blocked.reason], ['blocked', false, 'signature'], `no download for a signature that is ${JSON.stringify(signature)}`);
    assert.equal(blocked.signature, signatureView(update({ signature, error })));
  }
  assert.equal(downloadView(signed({ available: false, latest: '3.10.2' })).kind, 'none', 'nothing newer: nothing to download');
  assert.equal(downloadView(signed({ latest: null, available: false })).kind, 'none');
  assert.equal(downloadView(null).kind, 'none');
  assert.equal(downloadView({}).kind, 'none');
  // a release whose manifest names no single installer cannot be downloaded: the Hub would refuse the click, so the page does not offer it and says why
  for (const odd of [null, '', 5, undefined]) {
    const noInstaller = downloadView(signed({ installerName: odd, installerBytes: null }));
    assert.deepEqual([noInstaller.kind, noInstaller.canDownload, noInstaller.reason, noInstaller.signature], ['blocked', false, 'installer', 'valid'], `an installer name of ${JSON.stringify(odd)}`);
  }
  assert.deepEqual([idle.kind, idle.reason], ['offer', null], 'an offer has no reason against it');
  const failedWithoutInstaller = downloadView(signed({ installerName: null, download: { state: 'failed', version: '3.10.3', code: 'update_download_no_installer' } }));
  assert.deepEqual([failedWithoutInstaller.kind, failedWithoutInstaller.canDownload, failedWithoutInstaller.reason], ['failed', false, 'installer'], 'a failure that cannot be tried again says why');
  const running = downloadView(signed({ download: { state: 'downloading', version: '3.10.3', received: 50_000_000, total: 232753314 } }));
  assert.deepEqual([running.kind, running.canDownload, running.canCancel, running.percent, running.received, running.total], ['progress', false, true, 21, 50_000_000, 232753314]);
  assert.equal(downloadView(signed({ download: { state: 'downloading', version: '3.10.3', received: 0, total: null } })).percent, null, 'the size is not known while the Hub looks at the release again: no percentage');
  assert.equal(downloadView(signed({ download: { state: 'downloading', version: '3.10.3', received: 999, total: 10 } })).percent, 100, 'never more than 100');
  assert.equal(downloadView(signed({ download: { state: 'downloading', version: '3.10.3', received: -5, total: 10 } })).percent, 0, 'never less than 0');
  const verifying = downloadView(signed({ download: { state: 'verifying', version: '3.10.3' } }));
  assert.deepEqual([verifying.kind, verifying.canDownload, verifying.canCancel], ['verifying', false, true]);
  const ready = downloadView(signed({ download: { state: 'ready', version: '3.10.3', bytes: 232753314 } }));
  assert.deepEqual([ready.kind, ready.canDownload, ready.canCancel, ready.bytes], ['ready', false, false, 232753314]);
  const failed = downloadView(signed({ download: { state: 'failed', version: '3.10.3', code: 'update_download_hash' } }));
  assert.deepEqual([failed.kind, failed.canDownload, failed.group], ['failed', true, 'mismatch'], 'a failure can be tried again');
  const failedUnsigned = downloadView(update({ signature: 'missing', download: { state: 'failed', version: '3.10.3', code: 'update_download_hash' } }));
  assert.deepEqual([failedUnsigned.canDownload, failedUnsigned.reason], [false, 'signature'], 'not when the signature no longer checks, and the page says why');
  // a download of another release is not this release's
  for (const state of ['downloading', 'verifying', 'ready', 'failed']) {
    const other = downloadView(signed({ download: { state, version: '3.10.2', received: 1, total: 2, bytes: 2, code: 'update_download_hash' } }));
    assert.equal(other.kind, 'offer', `${state} for another version is nothing here: this release is still on offer`);
  }
  for (const odd of [null, undefined, {}, 'ready', { state: 'weird', version: '3.10.3' }, { state: 'ready' }, { state: 5 }, []]) assert.equal(downloadView(signed({ download: odd })).kind, 'offer', `a download state of ${JSON.stringify(odd)} is read as nothing`);
});

test('the page asks the Hub quickly while a download runs, so that the bar moves, and every three seconds otherwise', () => {
  assert.equal(pollInterval(signed({ download: { state: 'downloading', version: '3.10.3', received: 1, total: 2 } })), 700);
  assert.equal(pollInterval(signed({ download: { state: 'verifying', version: '3.10.3' } })), 700);
  for (const state of ['idle', 'ready', 'failed', 'weird']) assert.equal(pollInterval(signed({ download: { state } })), 3000, state);
  for (const odd of [null, undefined, {}, { download: null }, { download: 5 }]) assert.equal(pollInterval(odd), 3000, `${JSON.stringify(odd)}`);
});

test('a failure of the download is named by what went wrong, and an unknown code is "other"', () => {
  const groups = {
    update_download_stalled: 'network', update_download_interrupted: 'network', update_download_http: 'network', update_download_redirect: 'network', update_download_unverified: 'network',
    update_download_size: 'mismatch', update_download_hash: 'mismatch', update_download_bad_size: 'name', update_download_disk_full: 'disk', update_download_disk_unknown: 'disk',
    update_download_write: 'write', update_download_save: 'write', update_download_folder: 'write', update_download_platform: 'platform', update_download_unsigned: 'unsigned',
    update_download_stale: 'stale', update_download_not_newer: 'stale', update_download_invalid: 'stale', update_download_no_installer: 'name', update_download_bad_name: 'name',
    update_download_something_new: 'other', '': 'other', update_http: 'other',
  };
  for (const [code, group] of Object.entries(groups)) assert.equal(downloadErrorGroup(code), group, code);
  for (const odd of [null, undefined, 5, {}, '__proto__', 'constructor']) assert.equal(downloadErrorGroup(odd), 'other');
});

test('a refusal of the Hub that has a code of the download is told in the words of the page', () => {
  for (const [code, key] of Object.entries({
    update_download_invalid: 'upd_dl_err_stale', update_download_stale: 'upd_dl_err_stale', update_download_not_newer: 'upd_dl_err_stale', update_download_unsigned: 'upd_dl_err_unsigned',
    update_download_unverified: 'upd_dl_err_network', update_download_platform: 'upd_dl_err_platform', update_download_disk_full: 'upd_dl_err_disk', update_download_disk_unknown: 'upd_dl_err_disk',
    update_download_folder: 'upd_dl_err_write', update_download_no_installer: 'upd_dl_err_name', update_download_bad_name: 'upd_dl_err_name', update_download_bad_size: 'upd_dl_err_name', update_download_size: 'upd_dl_err_mismatch',
  })) assert.equal(refusalKey(code), key, code);
  assert.equal(refusalKey('update_download_something_new'), null, 'a code the page does not know is shown as the Hub said it');
});

// ---- installing the update (step 3): when the page may offer it, and what it says when it was not done -------------------------------------------------------------

const workCases = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/active-work-cases.json', import.meta.url), 'utf8')).cases;

test('the page tells when work is running by the SAME rule as the shell and the installer, held to the same list of cases', () => {
  assert.ok(workCases.length >= 25, `${workCases.length} cases`);
  for (const item of workCases) assert.equal(hasActiveWork(item.state), item.inState, `${item.name} (the page has the state, not the coding answer)`);
  for (const odd of [null, undefined, 5, 'agent', [], [{ agent: {} }]]) assert.equal(hasActiveWork(odd), true, `${JSON.stringify(odd)}: a state that is not an object is not an idle Hub (fail closed)`);
});

const ready = (overrides = {}) => signed({ download: { state: 'ready', version: '3.10.3', bytes: 232753314 }, ...overrides });
const idleHub = { agent: { activeTaskId: null, tasks: [] }, studio: null };
const busyHub = { agent: { activeTaskId: 'task-1', tasks: [] }, studio: null };
const IDLE = { phase: 'idle' };

test('the install control is offered only for an update that is ready, only inside the desktop shell, and is held back while work runs', () => {
  const view = (update, hub, shell, apply = IDLE) => applyView(update, hub, shell, apply);
  assert.deepEqual([view(ready(), idleHub, true).kind, view(ready(), idleHub, true).version], ['offer', '3.10.3'], 'ready, in the shell, idle: offered');
  assert.equal(view(ready(), idleHub, false).kind, 'browser', 'in a plain browser it does nothing, and the page says where it can be done');
  assert.equal(view(ready(), busyHub, true).kind, 'blocked', 'tasks running: held back, with the reason');
  assert.equal(view(ready(), { agent: {}, studio: { terminals: [{ running: true }] } }, true).kind, 'blocked', 'a running terminal is work too');
  assert.equal(view(ready(), {}, true).kind, 'blocked', 'a state with no agent is not an idle Hub');
  assert.equal(view(ready(), undefined, true).kind, 'blocked', 'nor is a state the page has not got yet');
  for (const other of [{ state: 'idle' }, { state: 'downloading', version: '3.10.3', received: 1, total: 2 }, { state: 'verifying', version: '3.10.3' }, { state: 'failed', version: '3.10.3', code: 'update_download_hash' }, undefined, null]) {
    assert.equal(view(signed({ download: other }), idleHub, true).kind, 'hidden', `nothing to install while the download is ${JSON.stringify(other)}`);
  }
  assert.equal(view(ready({ download: { state: 'ready', version: '3.10.2', bytes: 5 } }), idleHub, true).kind, 'hidden', 'a ready download of another version than the one on offer is nothing here');
  assert.equal(view(update({ available: false, latest: '3.10.2', download: { state: 'ready', version: '3.10.2', bytes: 5 } }), idleHub, true).kind, 'hidden', 'nothing newer is on offer: nothing to install');
  assert.equal(view(null, idleHub, true).kind, 'hidden');
  // the steps of the owner's click
  assert.equal(view(ready(), idleHub, true, { phase: 'confirm' }).kind, 'confirm', 'asked once: the confirm says the app closes and opens again');
  assert.equal(view(ready(), idleHub, true, { phase: 'sending' }).kind, 'sending', 'confirmed: waiting for the shell');
  assert.equal(view(ready(), busyHub, true, { phase: 'confirm' }).kind, 'blocked', 'a task that starts while the owner is deciding takes the confirm back');
  const refused = view(ready(), idleHub, true, { phase: 'refused', code: 'bad_signature' });
  assert.deepEqual([refused.kind, refused.group], ['refused', 'unproven'], 'refused: the reason is said and the button is back');
  assert.equal(view(ready(), busyHub, true, { phase: 'sending' }).kind, 'sending', 'sending shows even when a task has started (it is the shell that decides)');
  assert.equal(view(ready(), idleHub, false, { phase: 'confirm' }).kind, 'browser', 'no confirm outside the shell, whatever state a test puts it in');
});

test("a refusal of the shell is named by what went wrong, and a code the page does not know is 'other'", () => {
  const groups = {
    tasks_running: 'tasks', hub_unreachable: 'hub', not_installed: 'portable', no_update: 'missing', stale: 'missing', ambiguous: 'missing',
    staging_unsafe: 'unproven', bad_signature: 'unproven', bad_manifest: 'unproven', bad_installer: 'unproven', no_trusted_key: 'nokey', not_newer: 'older', busy: 'busy', launch_failed: 'launch',
    no_answer: 'no_answer', not_in_shell: 'portable', something_new: 'other', '': 'other', update_http: 'other',
  };
  for (const [code, group] of Object.entries(groups)) assert.equal(applyErrorGroup(code), group, code);
  for (const odd of [null, undefined, 5, {}, '__proto__', 'constructor', 'toString']) assert.equal(applyErrorGroup(odd), 'other');
});

test('what the last update left is shown for the version that runs, with its notes, and in words of the page', () => {
  const applied = (overrides = {}) => ({ ok: true, version: '3.10.3', previous: '3.10.2', state: 'installed', reason: null, rolledBack: false, ...overrides });
  const withApplied = (value) => update({ current: '3.10.3', available: false, latest: '3.10.3', applied: value });
  assert.deepEqual(appliedView(withApplied(applied())), { kind: 'updated', version: '3.10.3', previous: '3.10.2', notesUrl: NOTES_PREFIX + '3.10.3', reasonKey: null, state: 'installed' });
  const refused = appliedView(update({ applied: applied({ ok: false, version: '3.10.4', previous: '3.10.2', state: 'unchanged', reason: 'tasks_running' }) }));
  assert.deepEqual(refused, { kind: 'not_updated', version: '3.10.4', previous: '3.10.2', notesUrl: NOTES_PREFIX + '3.10.4', reasonKey: 'upd_applied_reason_tasks_running', state: 'unchanged' });
  for (const reason of ['shell_not_exited', 'no_installation', 'not_newer', 'disk_full', 'pending_recovery', 'tasks_running', 'foreign_listener', 'hub_stop_failed', 'window_open', 'another_update', 'payload_invalid', 'install_failed'])
    assert.equal(appliedView(update({ applied: applied({ ok: false, state: 'unchanged', reason }) })).reasonKey, `upd_applied_reason_${reason}`, reason);
  assert.equal(appliedView(update({ applied: applied({ ok: false, state: 'unchanged', reason: 'a reason of a later version' }) })).reasonKey, 'upd_applied_reason_install_failed', 'a reason the page has no words for is a failure to install');
  assert.equal(appliedView(update({ applied: applied({ ok: false, state: 'unchanged', reason: 'C:\\Users\\x\\secret' }) })).reasonKey, 'upd_applied_reason_install_failed', 'and a path is never a key');
  assert.equal(appliedView(update({ applied: applied({ ok: false, state: 'rolled_back', reason: 'install_failed', rolledBack: true }) })).state, 'rolled_back');
  assert.equal(appliedView(update({ applied: applied({ ok: false, state: 'needs_recovery', reason: 'install_failed' }) })).state, 'needs_recovery');
  for (const none of [undefined, null, 5, 'updated', [], {}, { ok: 'yes', version: '3.10.3' }, applied({ version: '3.10.3-rc.1' }), applied({ version: 3.103 }), applied({ version: '../3.10.3' }), applied({ state: 'exploded' })])
    assert.equal(appliedView(update({ applied: none })).kind, 'none', `nothing for ${JSON.stringify(none)}`);
  assert.equal(appliedView(null).kind, 'none');
  assert.equal(appliedView(undefined).kind, 'none');
  assert.equal(notesUrlFor('3.10.3'), NOTES_PREFIX + '3.10.3');
  for (const odd of ['3.10', '3.10.3-rc.1', '../3.10.3', '3.10.3/../../x', '', null, undefined, 3, '3.10.3\n']) assert.equal(notesUrlFor(odd), null, `no link for ${JSON.stringify(odd)}`);
});

test('the click on Install and restart goes in steps, and every step can be taken back or refused', () => {
  const step = (state, event) => applyReducer(state, event);
  assert.deepEqual(step({ phase: 'idle' }, { type: 'ask' }), { phase: 'confirm' }, 'the button asks the question');
  assert.deepEqual(step({ phase: 'confirm' }, { type: 'back' }), { phase: 'idle' }, 'not now');
  assert.deepEqual(step({ phase: 'confirm' }, { type: 'confirm' }), { phase: 'sending' }, 'close and install');
  assert.deepEqual(step({ phase: 'sending' }, { type: 'answered', result: { ok: true } }), { phase: 'sending' }, 'launched: the window is closing, there is nothing more to show');
  assert.deepEqual(step({ phase: 'sending' }, { type: 'answered', result: { ok: false, code: 'bad_signature' } }), { phase: 'refused', code: 'bad_signature' }, 'refused: with the code of the shell');
  assert.deepEqual(step({ phase: 'refused', code: 'x' }, { type: 'ask' }), { phase: 'confirm' }, 'after a refusal the button asks again');
  assert.deepEqual(step({ phase: 'refused', code: 'x' }, { type: 'back' }), { phase: 'idle' }, 'and the refusal can be put away');
  const same = [
    [{ phase: 'idle' }, { type: 'confirm' }], [{ phase: 'idle' }, { type: 'back' }], [{ phase: 'idle' }, { type: 'answered', result: { ok: false, code: 'x' } }],
    [{ phase: 'confirm' }, { type: 'answered', result: { ok: true } }], [{ phase: 'confirm' }, { type: 'ask' }],
    [{ phase: 'sending' }, { type: 'ask' }], [{ phase: 'sending' }, { type: 'back' }], [{ phase: 'sending' }, { type: 'confirm' }],
    [{ phase: 'refused', code: 'x' }, { type: 'confirm' }], [{ phase: 'refused', code: 'x' }, { type: 'answered', result: { ok: true } }],
  ];
  for (const [state, event] of same) assert.deepEqual(step(state, event), state, `${state.phase} + ${event.type}: an event that does not belong to the step changes nothing`);
});
