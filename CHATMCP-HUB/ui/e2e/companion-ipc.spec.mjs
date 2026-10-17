// Actual Chromium MV3 service worker -> isolated content script IPC. The ChatGPT
// page and the Hub transport endpoint are scripted fixtures; no live login/API.
import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('installed Companion sends one claimed turn through real extension IPC and excludes Search', async ({}, testInfo) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-companion-ipc-'));
  const taskId = 'a1111111-1111-4111-8111-111111111111';
  const clientId = 'c3333333-3333-4333-8333-333333333333';
  const nonce = 'd'.repeat(48), token = 'e'.repeat(64);
  const packet = { id: 'packet-ipc-1', taskId, turn: 1, text: `Fixture task ${taskId} nonce ${nonce}`, nonce };
  const state = { queued: false, claims: 0, sent: 0, failure: null, heartbeat: null, requests: [] };
  const server = createServer(async (request, response) => {
    const headers = { 'content-type': 'application/json' };
    if (/^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin || '')) {
      headers['access-control-allow-origin'] = request.headers.origin;
      headers['access-control-allow-headers'] = 'Content-Type, Authorization';
      headers['access-control-allow-methods'] = 'POST, GET';
    }
    if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    let value = { ready: true, workspace: { path: 'C:\\Fixture' }, generation: 1, instanceId: 'ipc-fixture' };
    const route = request.url.split('/').at(-1);
    state.requests.push(route);
    if (route === 'poll') state.heartbeat = { phase: body.phase, note: body.note };
    if (route === 'pair') value = { clientId: body.clientId, token };
    else if (route === 'poll') value = { instanceId: 'ipc-fixture',
      task: state.queued ? { id: taskId, status: 'queued', chatUrl: null } : null,
      message: state.queued ? packet : null, recovery: null };
    else if (route === 'claim') { state.claims++; value = { ok: true, message: packet }; }
    else if (route === 'sent') { state.sent++; value = { ok: true }; }
    else if (route === 'fail') { state.failure = body.reason; value = { ok: true }; }
    response.writeHead(200, headers); response.end(JSON.stringify(value));
  });
  let context;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3007, '127.0.0.1', resolve); });
    const extension = fileURLToPath(new URL('../../extension/', import.meta.url));
    const launch = () => chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: ['--host-resolver-rules=MAP chatgpt.com ~NOTFOUND', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const installRoute = context => context.route('https://chatgpt.com/**', route => route.request().resourceType() !== 'document' ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html>
      <html><head><title>Scripted ChatGPT fixture</title><style>[contenteditable]{min-height:48px;width:640px;border:1px solid}button{height:32px}</style></head><body>
      <form id="search-form"><div contenteditable="true" role="textbox" aria-label="Search">keep search</div></form>
      <form id="composer"><div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Ask ChatGPT"></div>
      <button type="button" data-testid="send-button" aria-label="Send">Send</button></form>
      <script>window.sentCount=0;document.querySelector('[data-testid="send-button"]').onclick=()=>{
        window.sentCount++;const text=document.getElementById('prompt-textarea').innerText;
        const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=text;document.body.append(user);
        document.getElementById('prompt-textarea').textContent='';
        history.pushState({},'', '/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      };</script></body></html>` }));
    context = await launch();
    await installRoute(context);
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    // Seed a fixture-owned pairing and restart the actual MV3 worker so its
    // production boot path reads storage. A popup opened as a normal browser
    // tab has sender.tab and is intentionally NOT an authorized popup sender.
    // This is delivery IPC acceptance, not a browser-toolbar pairing UI test.
    await worker.evaluate(async value => {
      await chrome.storage.local.set({ chatmcpBrowserPairV1: value });
    }, { clientId, token, authFailed: false });
    // Close and reopen the persistent profile after storage has flushed. An
    // extension runtime.reload destroys its own evaluation channel; awaiting
    // that evaluation is not a reliable worker-restart test on Chromium.
    await context.close();
    context = await launch();
    await installRoute(context);
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const newTab = context.waitForEvent('page');
    state.queued = true;
    await worker.evaluate(() => chrome.alarms.create('chatmcp-browser-poll', { when: Date.now() + 100 }));
    const taskPage = await newTab;
    // Extension-created targets can issue their initial navigation before
    // Playwright attaches routing. DNS is blocked for this host; navigate the
    // now-attached owned target to the scripted page before any claim.
    await taskPage.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    await expect(taskPage).toHaveTitle('Scripted ChatGPT fixture');
    await expect.poll(() => state.sent, { timeout: 30_000, message: 'real MV3 claim/send must complete' }).toBe(1);
    expect(state.claims).toBe(1); expect(state.failure).toBe(null);
    const chat = context.pages().find(p => p.url().includes('/c/aaaaaaaa-'));
    expect(chat).toBeTruthy();
    expect(await chat.evaluate(() => window.sentCount)).toBe(1);
    await expect(chat.locator('#search-form [role="textbox"]')).toHaveText('keep search');
    await expect(chat.locator('[data-message-author-role="user"]')).toHaveText(packet.text);
    await worker.evaluate(() => chrome.alarms.create('chatmcp-browser-poll', { when: Date.now() + 100 }));
    await chat.waitForTimeout(1600);
    expect(await chat.evaluate(() => window.sentCount)).toBe(1);
    expect(state.claims).toBe(1);
  } finally {
    await testInfo.attach('delivery-fixture-state', { body: JSON.stringify(state), contentType: 'application/json' });
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
