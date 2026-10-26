import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLY_TIMEOUT_MS, APPLY_UPDATE_MESSAGE, UPDATE_RESULT_MESSAGE, desktopShellHost, isDesktopShell, requestApplyUpdate } from '../src/lib/native-apply-update.ts';

// The page asks the desktop shell to install the update the Hub downloaded (chatmcp.apply-update) and hears one answer (chatmcp.update-result). The shell reads {type, id} and nothing else, so that is
// all the page sends; the answer is matched by the id; a shell that never answers is not waited for for ever; and outside the desktop shell (a plain browser has no window.chrome.webview) there is
// nothing to ask. A pretend shell stands in here: what the real one does with the message is native-shared/PageMessage.cs and UpdateApplier.cs, run by the native tests.

/** A WebView2 host: what the page can post to, and the listeners the shell's answers reach. */
function fakeHost({ throwOnPost = false } = {}) {
  const posted = [];
  const listeners = new Set();
  const order = [];
  return {
    posted, listeners, order,
    postMessage(message) { order.push('post'); if (throwOnPost) throw new Error('the shell is gone'); posted.push(message); },
    addEventListener(type, listener) { order.push(`add:${type}`); if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { order.push(`remove:${type}`); if (type === 'message') listeners.delete(listener); },
    say(data) { for (const listener of [...listeners]) listener({ data }); },
  };
}
const answer = (id, ok, code) => ({ type: UPDATE_RESULT_MESSAGE, id, ok, code });

test('the message names and the time limit are the ones of the shell and the page', () => {
  assert.equal(APPLY_UPDATE_MESSAGE, 'chatmcp.apply-update');
  assert.equal(UPDATE_RESULT_MESSAGE, 'chatmcp.update-result');
  assert.ok(APPLY_TIMEOUT_MS >= 30_000 && APPLY_TIMEOUT_MS <= 180_000, 'long enough for 230 MB to be hashed, short enough that a shell that never answers is not waited for for ever');
});

test('inside the desktop shell there is a host to ask; in a plain browser there is not', () => {
  assert.ok(desktopShellHost(fakeHost()), 'a WebView2 host');
  assert.equal(isDesktopShell(fakeHost()), true);
  for (const odd of [undefined, null, {}, { postMessage: 'x' }, { postMessage() {} }, { postMessage() {}, addEventListener() {} }, { addEventListener() {}, removeEventListener() {} }, 5, 'chrome']) {
    assert.equal(isDesktopShell(odd), false, JSON.stringify(odd) ?? String(odd));
    assert.equal(desktopShellHost(odd), null);
  }
  assert.equal(isDesktopShell(), false, 'and in the test process there is no window.chrome.webview');
});

test('the page sends the type and an id and nothing else, and listens before it posts', async () => {
  const host = fakeHost();
  const pending = requestApplyUpdate({ host });
  assert.equal(host.posted.length, 1);
  const [message] = host.posted;
  assert.deepEqual(Object.keys(message).sort(), ['id', 'type'], 'two fields: the shell computes the folder, the file and the version itself');
  assert.equal(message.type, 'chatmcp.apply-update');
  assert.match(message.id, /^[a-fA-F0-9-]{16,64}$/, 'an id the shell accepts (PageMessage: 16 to 64 hex digits and dashes)');
  assert.deepEqual(host.order, ['add:message', 'post'], 'the listener is there before the message goes, so that a fast answer is not missed');
  host.say(answer(message.id, true, 'launched'));
  assert.deepEqual(await pending, { ok: true }, 'launched is the one success');
  assert.equal(host.listeners.size, 0, 'and the listener is removed');
});

test('each refusal of the shell comes back with its code, and only the answer with this id counts', async () => {
  for (const code of ['tasks_running', 'hub_unreachable', 'not_installed', 'no_update', 'ambiguous', 'staging_unsafe', 'no_trusted_key', 'bad_signature', 'bad_manifest', 'not_newer', 'bad_installer', 'stale', 'busy', 'launch_failed']) {
    const host = fakeHost();
    const pending = requestApplyUpdate({ host });
    const [{ id }] = host.posted;
    host.say(answer('0123456789abcdef-other-id', false, 'launch_failed'));
    host.say({ type: 'chatmcp.open-in-app-tab', url: 'https://example.com/' });
    host.say({ type: 'chatmcp.folder-result', id, path: 'C:\\x', error: null });
    host.say('chatmcp.update-result');
    host.say(null);
    host.say(7);
    host.say([answer(id, false, code)]);
    assert.equal(host.listeners.size, 1, `${code}: answers for another id, other messages and things that are not messages leave it waiting`);
    host.say(answer(id, false, code));
    assert.deepEqual(await pending, { ok: false, code }, code);
    assert.equal(host.listeners.size, 0, `${code}: removed`);
  }
  const host = fakeHost();
  const pending = requestApplyUpdate({ host });
  host.say(answer(host.posted[0].id, true, 'something else'));
  assert.deepEqual(await pending, { ok: false, code: 'something else' }, 'ok with a code that is not launched is not a success');
  const odd = fakeHost();
  const oddPending = requestApplyUpdate({ host: odd });
  odd.say({ type: UPDATE_RESULT_MESSAGE, id: odd.posted[0].id, ok: false });
  assert.deepEqual(await oddPending, { ok: false, code: 'unknown' }, 'an answer with no code is an unknown failure, never a success');
});

test('a shell that never answers is not waited for for ever, and a late answer changes nothing', async () => {
  const host = fakeHost();
  const started = Date.now();
  const result = await requestApplyUpdate({ host, timeoutMs: 40 });
  assert.deepEqual(result, { ok: false, code: 'no_answer' });
  assert.ok(Date.now() - started >= 30, 'it did wait');
  assert.equal(host.listeners.size, 0, 'and the listener is gone');
  host.say(answer(host.posted[0].id, true, 'launched'));
  assert.equal(host.listeners.size, 0, 'a late answer finds nobody');
});

test('outside the shell nothing is asked, and a shell that cannot take the message is a failure to launch', async () => {
  assert.deepEqual(await requestApplyUpdate({ host: null }), { ok: false, code: 'not_in_shell' }, 'no host: nothing to ask');
  assert.deepEqual(await requestApplyUpdate({}), { ok: false, code: 'not_in_shell' }, 'and in the test process there is none');
  const broken = fakeHost({ throwOnPost: true });
  assert.deepEqual(await requestApplyUpdate({ host: broken }), { ok: false, code: 'launch_failed' });
  assert.equal(broken.listeners.size, 0, 'with no listener left behind');
});

test('two requests get two ids and are answered separately', async () => {
  const host = fakeHost();
  const first = requestApplyUpdate({ host });
  const second = requestApplyUpdate({ host });
  assert.notEqual(host.posted[0].id, host.posted[1].id);
  host.say(answer(host.posted[1].id, false, 'busy'));
  host.say(answer(host.posted[0].id, true, 'launched'));
  assert.deepEqual([await first, await second], [{ ok: true }, { ok: false, code: 'busy' }]);
});

test('an id is made from the random numbers of the browser, and the module reads nothing from the page', async () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) { const host = fakeHost(); void requestApplyUpdate({ host, timeoutMs: 10 }); seen.add(host.posted[0].id); }
  assert.equal(seen.size, 50, 'fifty requests, fifty ids');
  const host = fakeHost();
  void requestApplyUpdate({ host, timeoutMs: 10, newId: () => 'fedcba9876543210-fedcba98' });
  assert.equal(host.posted[0].id, 'fedcba9876543210-fedcba98', 'a test can hand it an id');
  const hostBadId = fakeHost();
  assert.deepEqual(await requestApplyUpdate({ host: hostBadId, newId: () => 'not an id; drop table' }), { ok: false, code: 'launch_failed' }, 'an id the shell would not accept is never sent');
  assert.equal(hostBadId.posted.length, 0);
});
