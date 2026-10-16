import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BrowserRunner } from '../lib/browser-runner.mjs';

const base = new URL('../extension/', import.meta.url);
const route = fs.readFileSync(new URL('chat-route.js', base), 'utf8');
const background = fs.readFileSync(new URL('browser-background.js', base), 'utf8')
  .replace(/\}\)\(\);\s*$/, 'globalThis.fixture={ready,tick,publicState,get:()=>journal};\n})();');
const taskId = 'a1111111-1111-4111-8111-111111111111';
const oldTaskId = 'b2222222-2222-4222-8222-222222222222';
const clientId = 'c3333333-3333-4333-8333-333333333333';
const nonce = 'd'.repeat(48);
const message = { id: 'packet-1', taskId, turn: 1, text: `Task ${taskId} nonce ${nonce}`, nonce };
const canonical = 'https://chatgpt.com/c/test-conversation';
const recovery = { taskId: oldTaskId, nonce: 'e'.repeat(48), turn: 1 };

function worker(options = {}) {
  const state = {
    status: 'queued', recovery: null, prepared: 0, claim: 0, send: 0, recover: 0,
    fail: 0, probes: 0, inject: 0, creates: [], receiver: true, loading: false,
    prepareReason: null, uncertain: false, injectWorks: true, ...options,
  };
  const store = { chatmcpBrowserPairV1: { clientId, token: 't'.repeat(64) }, chatmcpBrowserJournalV1: null };
  let tab = null;
  const event = { addListener() {} };
  const chrome = {
    runtime: { id: 'a'.repeat(32), getURL: p => `chrome-extension://${'a'.repeat(32)}/${p}`, onMessage: event },
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.map(k => [k, structuredClone(store[k])])); },
      async set(value) { Object.assign(store, structuredClone(value)); },
    } },
    alarms: { async get() { return {}; }, async create() {}, onAlarm: event },
    scripting: { async executeScript(input) {
      assert.equal(input.target.tabId, 7);
      assert.deepEqual(Array.from(input.target.frameIds), [0]);
      assert.deepEqual(Array.from(input.files), ['chat-route.js', 'browser-runner.js']);
      assert.equal(input.world, 'ISOLATED');
      state.inject++;
      state.receiver = state.injectWorks;
      return [];
    } },
    tabs: {
      onUpdated: event, onRemoved: event,
      async create(input) {
        state.creates.push(input);
        return tab = { id: 7, status: state.loading ? 'loading' : 'complete', url: input.url };
      },
      async get() { return { ...tab, status: state.loading ? 'loading' : 'complete' }; },
      async query() { return [{ id: 7, status: 'complete', url: canonical }]; },
      async sendMessage(id, input) {
        assert.equal(id, 7);
        if (input.type === 'CHATMCP_BROWSER_VERIFY_OFFICIAL_URL') {
          state.probes++;
          return { ok: false, reason: 'no_witness' };
        }
        if (input.type === 'CHATMCP_BROWSER_PREPARE') {
          state.prepared++;
          if (!state.receiver) throw Error('Could not establish connection. Receiving end does not exist.');
          if (state.prepareReason) return { ok: false, reason: state.prepareReason, retryable: true };
          return { ok: true, pageId: 'page-7', url: tab.url };
        }
        if (input.type === 'CHATMCP_BROWSER_SEND') {
          state.send++;
          if (state.uncertain) throw Error('The message port closed before a response was received.');
          tab.url = canonical;
          return { ok: true, state: 'confirmed', pageId: 'page-7', url: canonical };
        }
        if (input.type === 'CHATMCP_BROWSER_RECOVER_SEND') {
          state.recover++;
          return { ok: true, state: 'waiting', pageId: 'page-7' };
        }
        if (input.type === 'CHATMCP_BROWSER_CANCEL') return { ok: true };
        if (input.type === 'CHATMCP_BROWSER_CHECK') return { ok: true, state: 'waiting', pageId: 'page-7' };
        throw Error(`Unexpected tab request ${input.type}`);
      },
    },
  };
  const globals = {
    chrome, URL, AbortController, TextEncoder, structuredClone, console,
    setTimeout: () => 1, clearTimeout() {}, crypto: { randomUUID: () => clientId },
    fetch: async (url, init) => {
      const endpoint = new URL(url).pathname.split('/').at(-1);
      const body = JSON.parse(init.body);
      assert.equal(body.clientId, clientId);
      let result;
      if (endpoint === 'poll') result = {
        instanceId: 'instance-1', task: { id: taskId, status: state.status, chatUrl: null },
        message: state.status === 'failed' ? null : message, recovery: state.recovery,
      };
      else if (endpoint === 'claim') { state.claim++; result = { ok: true, message }; }
      else if (endpoint === 'sent') result = { ok: true };
      else if (endpoint === 'fail') { state.fail++; result = { ok: true }; }
      else throw Error(`Unexpected HTTP request ${endpoint}`);
      return { ok: true, text: async () => JSON.stringify(result) };
    },
  };
  vm.runInNewContext(route, globals);
  vm.runInNewContext(background, globals);
  return { state, api: globals.fixture };
}

// Reproduces the user's poll: queued first packet + another task's recovery.
{
  const h = worker({ recovery }); await h.api.ready(); await h.api.tick();
  assert.equal(h.state.send, 1, 'recovery must not starve queued task');
  assert.equal(h.state.probes, 0);
  assert.equal(h.state.claim, 1);
  assert.equal(h.state.creates[0].active, true, 'new task tab must be foregrounded once');
  await h.api.tick(); assert.equal(h.state.send, 1);
  console.log('PASS queued packet beats stale recovery; one claim and one Send');
}
{
  const h = worker({ status: 'failed', recovery }); await h.api.ready(); await h.api.tick();
  assert.equal(h.state.probes, 1); assert.equal(h.state.send, 0); assert.equal(h.state.inject, 0);
  console.log('PASS idle URL recovery remains read-only');
}
{
  const h = worker({ loading: true }); await h.api.ready(); await h.api.tick();
  assert.equal(h.state.prepared, 0); assert.equal(h.state.claim, 0);
  h.state.loading = false; await h.api.tick();
  assert.equal(h.state.creates.length, 1); assert.equal(h.state.send, 1);
  console.log('PASS loading tab is reused and sends when ready');
}
{
  const h = worker({ receiver: false }); await h.api.ready(); await h.api.tick();
  assert.equal(h.state.inject, 1); assert.equal(h.state.send, 0);
  await h.api.tick(); assert.equal(h.state.claim, 1); assert.equal(h.state.send, 1);
  console.log('PASS absent content script is restored before claim, then one Send');
}
{
  const h = worker({ receiver: false, injectWorks: false }); await h.api.ready();
  await h.api.tick(); await h.api.tick(); await h.api.tick();
  assert.equal(h.state.inject, 1, 'one bounded restoration attempt per packet');
  assert.equal(h.state.send, 0); assert.equal(h.state.claim, 0);
  assert.match(h.api.publicState().note, /receiver_missing/);
  console.log('PASS blocked receiver remains unsent, with bounded repair and diagnostic');
}
{
  const h = worker({ prepareReason: 'composer_missing: PRIVATE_PROMPT_SENTINEL' });
  await h.api.ready(); await h.api.tick();
  assert.match(h.api.publicState().note, /composer_missing/);
  assert.ok(!h.api.publicState().note.includes('PRIVATE_PROMPT_SENTINEL'));
  assert.equal(h.state.claim, 0); assert.equal(h.state.send, 0);
  h.state.prepareReason = null; await h.api.tick(); assert.equal(h.state.send, 1);
  console.log('PASS readiness diagnostic is retained without page text or prompt');
}
{
  const h = worker({ uncertain: true }); await h.api.ready(); await h.api.tick();
  assert.equal(h.state.send, 1); assert.equal(h.api.get().phase, 'reconciling');
  h.state.recovery = recovery;
  await h.api.tick(); await h.api.tick();
  assert.equal(h.state.send, 1); assert.equal(h.state.inject, 0); assert.equal(h.state.probes, 0);
  assert.ok(h.state.recover >= 2);
  console.log('PASS uncertain Send is reconciled read-only and never replayed or reinjected');
}
{
  const h = worker({ status: 'failed' }); await h.api.ready();
  await h.api.tick(); await h.api.tick(); assert.equal(h.state.send, 0);
  assert.equal(h.state.creates.length, 0);
  console.log('PASS idle polling of a failed task is not another send');
}
{
  const runner = new BrowserRunner({ manager: { instanceId: 'hub-test' }, directory: '.' });
  runner.client = { clientId };
  const task = { id: taskId, status: 'queued', message: { ...message, status: 'pending' } };
  runner.tasks.set(taskId, task); runner.tasks.set(oldTaskId, { id: oldTaskId, nonce });
  runner.context = { task }; runner.urlRecovery = { ...recovery, expiresAt: Date.now() + 300000 };
  assert.equal((await runner.poll({ clientId })).recovery, null);
  assert.throws(() => runner.requestUrlRecovery({ id: oldTaskId }), e => e.code === 'task_running');
  runner.context = null; runner.lastTaskId = taskId;
  assert.equal((await runner.poll({ clientId })).recovery.taskId, oldTaskId);
  console.log('PASS Hub suspends recovery while any Web task is active');
}

// Editor matching uses actual content-script code, not a reimplementation.
const content = fs.readFileSync(new URL('browser-runner.js', base), 'utf8');
const instrumented = content.replace(/\}\)\(\);\s*$/, 'globalThis.editorFixture={input,prepare,send};\n})();');
function editorsFixture() {
  const state = { bySelector: new Map(), listeners: 0, clicks: 0 };
  const button = { tagName: 'BUTTON', disabled: false,
    getAttribute: n => n === 'aria-label' ? 'Send' : n === 'data-testid' ? 'send-button' : null,
    closest: () => null, getBoundingClientRect: () => ({ width: 30, height: 30 }),
    click() { state.clicks++; },
  };
  const form = { id: 'composer', tagName: 'FORM', querySelectorAll: s => s === 'button' ? [button] : [] };
  button.form = form;
  class Area {
    constructor(attrs = {}, tag = 'TEXTAREA') { this.attrs = attrs; this.tagName = tag; this._value = ''; this.textContent = ''; this.innerText = ''; }
    get value() { return this._value; } set value(v) { this._value = v; }
    getAttribute(n) { return this.attrs[n] ?? null; }
    closest(s) { if (this.excluded && s !== 'form') return {}; return s === 'form' ? form : null; }
    getBoundingClientRect() { return { width: this.hidden ? 0 : 400, height: 40 }; }
    focus() { state.focused = this; } dispatchEvent() { return true; }
  }
  const document = {
    querySelectorAll(s) { return state.bySelector.get(s) || []; },
    getElementById() { return null; },
    createRange() { return { selectNodeContents() {} }; },
    execCommand(cmd, ui, text) { state.focused.innerText = text; state.focused.textContent = text; return true; },
  };
  const window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) }; window.top = window;
  const globals = {
    URL, document, window, location: { origin: 'https://chatgpt.com', pathname: '/' },
    HTMLTextAreaElement: Area, Event: class {}, TextEncoder, setTimeout, setInterval() {},
    crypto: { randomUUID: () => 'editor-page' },
    chrome: { runtime: { id: 'a'.repeat(32), onMessage: { addListener() { state.listeners++; } }, sendMessage: async () => {} } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  vm.runInNewContext(route, globals); vm.runInNewContext(instrumented, globals);
  return { state, Area, api: globals.editorFixture, reload() { vm.runInNewContext(instrumented, globals); } };
}
for (const variant of ['lexical', 'textbox', 'textarea']) {
  const h = editorsFixture(); let selector, editor;
  if (variant === 'lexical') {
    selector = '[data-lexical-editor="true"][contenteditable="true"]';
    editor = new h.Area({ contenteditable: 'true', 'data-lexical-editor': 'true' }, 'DIV');
  } else if (variant === 'textbox') {
    selector = '[role="textbox"][contenteditable="plaintext-only"]';
    editor = new h.Area({ contenteditable: 'plaintext-only', role: 'textbox' }, 'DIV');
  } else {
    selector = 'textarea[placeholder]'; editor = new h.Area({ placeholder: 'Ask ChatGPT' });
  }
  h.state.bySelector.set(selector, [editor]);
  assert.equal(h.api.input().element, editor);
  const packet = { ...message, messageId: message.id };
  assert.equal((await h.api.prepare(packet)).ok, true, `${variant} prepares`);
  assert.equal(editor.tagName === 'TEXTAREA' ? editor.value : editor.innerText, message.text);
  assert.equal((await h.api.send(packet)).ok, true, `${variant} sends`);
  assert.equal(h.state.clicks, 1);
  assert.equal((await h.api.send(packet)).ok, false); assert.equal(h.state.clicks, 1);
  h.reload(); assert.equal(h.state.listeners, 1, 'restoration must not install a second listener');
  console.log(`PASS ${variant} composer: full draft, one click, duplicate blocked, idempotent installation`);
}
{
  const h = editorsFixture();
  const hidden = new h.Area({ placeholder: 'Ask ChatGPT' }); hidden.hidden = true;
  const foreign = new h.Area({ placeholder: 'Ask ChatGPT' }); foreign.excluded = true;
  const search = new h.Area({ placeholder: 'Search' });
  h.state.bySelector.set('textarea[placeholder]', [hidden, foreign, search]);
  assert.match(h.api.input().reason, /^composer_missing/);
  h.state.bySelector.set('textarea[placeholder]', [new h.Area({ placeholder: 'Ask ChatGPT' }), new h.Area({ placeholder: 'Ask ChatGPT' })]);
  assert.equal(h.api.input().reason, 'ambiguous_composer');
  assert.equal(h.state.clicks, 0);
  console.log('PASS hidden, conversation/dialog and unrelated inputs excluded; ambiguity fails closed');
}
console.log('PASS browser delivery readiness regression suite');
