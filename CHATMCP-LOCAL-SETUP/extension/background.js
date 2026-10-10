'use strict';

const STATE_URL = 'http://127.0.0.1:3007/api/extension-state';

async function readLimitedState() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(STATE_URL, {
      method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal
    });
    if (!response.ok) return { ok: false, reason: 'hub_unavailable' };
    const text = await response.text();
    if (text.length > 65536) return { ok: false, reason: 'invalid_hub_state' };
    const value = JSON.parse(text);
    if (typeof value?.ready !== 'boolean' || typeof value?.workspace?.path !== 'string' ||
        !Number.isSafeInteger(value.generation) || value.generation < 0 ||
        typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 128) {
      return { ok: false, reason: 'invalid_hub_state' };
    }
    // Never relay arbitrary fields, CSRF material, commands or URLs.
    return { ok: true, state: { ready: value.ready, workspace: { path: value.workspace.path }, generation: value.generation, instanceId: value.instanceId } };
  } catch {
    return { ok: false, reason: 'hub_unavailable' };
  } finally { clearTimeout(timeout); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'CHATMCP_HUB_READ_STATE' || sender.id !== chrome.runtime.id ||
      !sender.tab || sender.frameId !== 0 || !/^https:\/\/chatgpt\.com\//.test(sender.url || '')) return false;
  readLimitedState().then(sendResponse, () => sendResponse({ ok: false, reason: 'hub_unavailable' }));
  return true;
});
