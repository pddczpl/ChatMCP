import test from 'node:test';
import assert from 'node:assert/strict';
import { OPEN_IN_APP_TAB_MESSAGE, installOpenInAppTabBridge, openInAppTabUrl } from '../src/lib/native-open-link.ts';

const hostile = "http://127.0.0.1:3007/#back\\slash'quote\"dq</script><img src=x onerror=window.__pwned=1>";

test('an http(s) address is passed on exactly as the shell sent it', () => {
  assert.equal(openInAppTabUrl({ type: OPEN_IN_APP_TAB_MESSAGE, url: hostile }), hostile);
  assert.equal(openInAppTabUrl({ type: OPEN_IN_APP_TAB_MESSAGE, url: 'https://example.com/a?b=c#d' }), 'https://example.com/a?b=c#d');
});

test('anything that is not an http/https open request is ignored', () => {
  for (const data of [null, undefined, 'text', 7, {}, { type: 'other', url: 'http://x.test/' }, { type: OPEN_IN_APP_TAB_MESSAGE },
    { type: OPEN_IN_APP_TAB_MESSAGE, url: 5 }, { type: OPEN_IN_APP_TAB_MESSAGE, url: 'javascript:window.__pwned=1' },
    { type: OPEN_IN_APP_TAB_MESSAGE, url: 'about:blank' }, { type: OPEN_IN_APP_TAB_MESSAGE, url: 'file:///C:/Windows/win.ini' },
    { type: OPEN_IN_APP_TAB_MESSAGE, url: 'data:text/html,<script>1</script>' }, { type: OPEN_IN_APP_TAB_MESSAGE, url: '/relative' },
    { type: OPEN_IN_APP_TAB_MESSAGE, url: `http://x.test/${'a'.repeat(9000)}` }]) {
    assert.equal(openInAppTabUrl(data), null, JSON.stringify(data)?.slice(0, 60));
  }
});

test('the bridge re-dispatches the shell message as the preview tab event, and nothing else', () => {
  const listeners = new Set();
  const host = { addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn) };
  const target = new EventTarget();
  const opened = [];
  target.addEventListener('chatmcp:open-in-app-tab', (event) => opened.push(event.detail.url));
  const stop = installOpenInAppTabBridge(host, target);
  assert.equal(listeners.size, 1);
  for (const fn of listeners) {
    fn({ data: { type: OPEN_IN_APP_TAB_MESSAGE, url: hostile } });
    fn({ data: { type: OPEN_IN_APP_TAB_MESSAGE, url: 'javascript:window.__pwned=1' } });
    fn({ data: { type: 'chatmcp.folder-result', id: 'x', path: 'C:\\x' } });
  }
  assert.deepEqual(opened, [hostile]);
  stop();
  assert.equal(listeners.size, 0, 'and it removes its listener');
});

test('outside the desktop shell there is nothing to listen to', () => {
  assert.doesNotThrow(() => installOpenInAppTabBridge(undefined, new EventTarget())());
});
