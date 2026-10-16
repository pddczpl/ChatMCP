"""One-shot, checked-source repair. Removed after the tested commit is made."""
from pathlib import Path
import json
import subprocess
import sys

ROOT = Path.cwd()
BASE = '278939c6c9eecc487031e2eaf359e3b3517d1e21'
TEST_PATH = ROOT / 'CHATMCP-HUB/tests/verify-browser-delivery-readiness.mjs'

TEST = r'''import assert from 'node:assert/strict';
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
'''


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, content):
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding='utf-8', newline='\n')


def replace(path, old, new, count=1):
    data = read(path)
    actual = data.count(old)
    if actual != count:
        raise RuntimeError(f'{path}: expected {count} occurrences, got {actual}: {old[:90]!r}')
    write(path, data.replace(old, new))


def main():
    write(TEST_PATH, TEST)
    if '--tests-only' in sys.argv:
        return
    # The repair is only applicable to the reviewed source blobs.
    expected = {
        'CHATMCP-HUB/extension/browser-background.js': 'dc2ac32b9bd281fbc45f4ea6a9996a58e2b824b0',
        'CHATMCP-HUB/extension/browser-runner.js': 'd6300daf4e2a9ad7aa3a4aed234ffa980cd9589b',
        'CHATMCP-HUB/lib/browser-runner.mjs': 'b77c822bff0f6f2e0db7ca2b4de9ffbcdd8ae8fb',
    }
    for path, sha in expected.items():
        actual = subprocess.check_output(['git', 'hash-object', path], text=True).strip()
        if actual != sha:
            raise RuntimeError(f'Review required: source changed: {path} ({actual})')

    bg = 'CHATMCP-HUB/extension/browser-background.js'
    replace(bg, "      if(poll.recovery){", """      // A recovery for an older task must never starve a queued packet or
      // interrupt reconciliation of an uncertain SEND. Keep idle recovery.
      const hasLiveTask = poll.task && !TERMINAL.has(poll.task.status);
      if(poll.recovery && !hasLiveTask){""")
    replace(bg, "await chrome.tabs.create({url:resumeUrl,active:false});", "await chrome.tabs.create({url:resumeUrl,active:true});")
    replace(bg, "await chrome.tabs.create({url:'https://chatgpt.com/',active:false});", "await chrome.tabs.create({url:'https://chatgpt.com/',active:true});")
    replace(bg, "  async function prepareAndSend(message, instanceId, ownEpoch) {", r'''  // Fixed categories only. Do not persist exception text, prompts, DOM text,
  // nonce, URL, tokens or arbitrary attributes in a readiness heartbeat.
  function readinessCode(reason) {
    const code = String(reason || '').split(':', 1)[0];
    return new Set(['composer_missing', 'ambiguous_composer', 'send_button_missing',
      'send_button_disabled', 'send_button_ambiguous', 'chat_is_busy', 'network_offline'])
      .has(code) ? code : 'composer_not_ready';
  }
  function receiverCode(error) {
    const message = String(error?.message || '');
    if (/Receiving end does not exist|Could not establish connection/i.test(message)) return 'receiver_missing';
    if (message === 'owned_tab_response_timeout') return 'receiver_timeout';
    return 'receiver_unavailable';
  }
  async function restoreReceiver(record, ownEpoch) {
    // Only PREPARE may restore a missing listener. Never reinject on a lost
    // SEND acknowledgement, or replay any claim/send on an uncertain turn.
    if (!isCurrent(record, ownEpoch) || record.phase !== 'preparing' || record.receiverRestoreAttempted) return;
    if (typeof chrome.scripting?.executeScript !== 'function') return;
    const tab = await chrome.tabs.get(record.tabId).catch(() => null);
    if (!tab || !safeChatUrl(tab.url) || !isCurrent(record, ownEpoch)) return;
    record.receiverRestoreAttempted = true;
    await saveJournal();
    if (!isCurrent(record, ownEpoch) || record.phase !== 'preparing') return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: record.tabId, frameIds: [0] }, world: 'ISOLATED',
        files: ['chat-route.js', 'browser-runner.js']
      });
    } catch {
      lastNote = '[receiver_reload_failed] Không nạp được Companion vào tab. Kiểm tra quyền truy cập chatgpt.com và tải lại extension/tab.';
    }
  }
  async function prepareAndSend(message, instanceId, ownEpoch) {''')
    replace(bg, """    catch {
      if (!atPhase('preparing')) return;
      waitForConnection('Chưa đọc được tab ChatGPT; kiểm tra mạng và để tab mở.'); return;
    }""", """    catch (error) {
      if (!atPhase('preparing')) return;
      const code = receiverCode(error);
      waitForConnection();
      lastNote = `[${code}] Chưa liên lạc được với Companion trong tab ChatGPT. Kiểm tra quyền truy cập trang và tải lại extension/tab.`;
      if (code === 'receiver_missing') await restoreReceiver(record, ownEpoch);
      return;
    }""")
    replace(bg, "      if (prepared?.retryable) { waitForConnection('Đang đợi ô chat/nút gửi sẵn sàng.'); return; }", """      if (prepared?.retryable) {
        waitForConnection();
        lastNote = `[${readinessCode(prepared.reason)}] Chưa chuẩn bị được ô nhập/nút Gửi. Giữ tab ChatGPT mở; kiểm tra đăng nhập và cập nhật Companion.`;
        return;
      }""")
    replace(bg, "    const eligible=[];\n    for(const tab of candidates){", """    const eligible=[];
    const deadline = Date.now() + 4000;
    for(const tab of candidates){
      if (ownEpoch !== epoch) return;
      if (Date.now() >= deadline) {
        lastNote = 'Chưa xác minh hết các tab khôi phục. Giữ tab cũ mở và thử lại.';
        return; // Never bind a URL from a partial scan.
      }""")
    replace(bg, "      let proof;\n      try{\n        proof=await chrome.tabs.sendMessage(tab.id,{", """      let proof, timer;
      try{
        proof=await Promise.race([chrome.tabs.sendMessage(tab.id,{""")
    replace(bg, """          nonce:recovery.nonce,turn:recovery.turn,
        },{frameId:0});
      }catch{continue;}""", """          nonce:recovery.nonce,turn:recovery.turn,
        },{frameId:0}), new Promise(resolve => {
          timer = setTimeout(() => resolve(null), Math.max(1, Math.min(1000, deadline - Date.now())));
        })]);
      }catch{continue;}finally{clearTimeout(timer);}""")

    hub = 'CHATMCP-HUB/lib/browser-runner.mjs'
    replace(hub, "if(this.context?.task.id===id)throw fault('task_running'", "if(this.context)throw fault('task_running'")
    replace(hub, "      recovery:this.urlRecovery?{", "      recovery:!this.context && this.urlRecovery?{")
    replace(hub, "      void this.finish(context, 'failed', fault('browser_queue_timeout',", """      const heartbeat = this.clientHeartbeat?.taskId === task.id ? this.clientHeartbeat.note : '';
      const diagnostic = /^\\[(receiver_missing|receiver_timeout|receiver_unavailable|receiver_reload_failed|composer_missing|ambiguous_composer|send_button_missing|send_button_disabled|send_button_ambiguous|composer_not_ready|chat_is_busy|network_offline)\\]/.exec(heartbeat || '')?.[1];
      void this.finish(context, 'failed', fault('browser_queue_timeout',""")
    replace(hub, "'Companion không nhận gói hội thoại trong thời gian cho phép. Kiểm tra kết nối tiện ích, tab ChatGPT và ghép nối rồi nhấn Tiếp tục. Tin nhắn chưa được claim; Hub không tự gửi lại.', 504))", "`Companion không nhận gói hội thoại trong thời gian cho phép. Kiểm tra kết nối tiện ích, tab ChatGPT và ghép nối rồi nhấn Tiếp tục. Tin nhắn chưa được claim; Hub không tự gửi lại.${diagnostic ? ' Chẩn đoán Companion: ' + diagnostic + '.' : ''}`, 504))")

    dom = 'CHATMCP-HUB/extension/browser-runner.js'
    replace(dom, "  const pageId = crypto.randomUUID();", """  // A bounded pre-claim restoration may load this file again. Preserve the
  // original ownership and listener, including any uncertain Send state.
  if (globalThis.__chatmcpBrowserRunnerInstalled) return;
  const pageId = crypto.randomUUID();""")
    old = '''  function input() {
    for (const selector of ['#prompt-textarea', '.ProseMirror[contenteditable="true"]']) {
      const matches = elements(selector).filter(element => !element.disabled && !element.readOnly && (element.tagName === 'TEXTAREA' || element.getAttribute('contenteditable') === 'true'));
      if (matches.length > 1) return { reason: 'ambiguous_composer' };
      if (matches.length === 1) return { element: matches[0] };
    }
    return { reason: 'composer_missing: Chưa thấy ô chat; kiểm tra đăng nhập và giao diện ChatGPT.' };
  }'''
    new = r'''  function input() {
    const excluded = '[data-message-author-role],[data-testid="user-message"],blockquote,[role="dialog"],.mcp-instructions-container,#mcp-popover-container,#mcp-popover-portal';
    const editable = element => !element.disabled && !element.readOnly && !element.closest(excluded) &&
      (element.tagName === 'TEXTAREA' || ['true', 'plaintext-only'].includes(element.getAttribute('contenteditable')));
    for (const selector of ['#prompt-textarea', '.ProseMirror[contenteditable="true"]',
      'textarea[name="prompt-textarea"]', '[data-testid="prompt-textarea"]']) {
      const matches = elements(selector).filter(editable);
      if (matches.length > 1) return { reason: 'ambiguous_composer' };
      if (matches.length === 1) return { element: matches[0] };
    }
    // New editor layouts may omit both the old id and ProseMirror class.
    // Constrain fallback editors to a form or an explicit ChatGPT label;
    // never grab an arbitrary page input, search field or conversation node.
    const label = element => normalized(element.getAttribute('placeholder') ||
      element.getAttribute('data-placeholder') || element.getAttribute('aria-label') || '').toLowerCase();
    const named = element => /^(ask chatgpt|message chatgpt|hỏi chatgpt|nhắn tin cho chatgpt)$/.test(label(element));
    const candidates = new Set();
    for (const selector of ['[data-lexical-editor="true"][contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]', '[role="textbox"][contenteditable="plaintext-only"]',
      'textarea[placeholder]']) {
      for (const element of elements(selector).filter(editable)) {
        if (element.tagName === 'TEXTAREA' ? named(element) : element.closest('form') || named(element)) candidates.add(element);
      }
    }
    if (candidates.size > 1) return { reason: 'ambiguous_composer' };
    if (candidates.size === 1) return { element: [...candidates][0] };
    return { reason: 'composer_missing: Chưa thấy ô chat; kiểm tra đăng nhập và giao diện ChatGPT.' };
  }'''
    replace(dom, old, new)
    data = read(dom)
    if not data.rstrip().endswith('})();'):
        raise RuntimeError('Unexpected content-script ending')
    data = data.rstrip()[:-5] + '  globalThis.__chatmcpBrowserRunnerInstalled = true;\n})();\n'
    write(dom, data)

    manifest_path = 'CHATMCP-HUB/extension/manifest.json'
    replace(manifest_path, '"permissions": ["storage", "alarms"]', '"permissions": ["storage", "alarms", "scripting"]')
    replace('scripts/Build-BrowserCompanion.ps1', "$allowedPermissions = @('storage','alarms')", "$allowedPermissions = @('storage','alarms','scripting')")
    for p in (ROOT / 'CHATMCP-HUB/extension').iterdir():
        if p.is_file() and p.suffix in {'.js', '.json', '.html', '.txt'} and p.name != 'VALIDATION.txt':
            text = p.read_text(encoding='utf-8')
            if '1.5.0' in text:
                p.write_text(text.replace('1.5.0', '1.5.1'), encoding='utf-8', newline='\n')
    doc = 'CHATMCP-HUB/extension/HUONG-DAN.txt'
    replace(doc, 'Quyền khai báo: storage, alarms;', 'Quyền khai báo: storage, alarms, scripting;')
    replace(doc, 'Không có quyền tabs rộng, cookies, scripting, debugger hoặc management.',
      'Không có quyền tabs rộng, cookies, debugger hoặc management. Quyền scripting chỉ nạp lại hai file đóng gói chat-route.js/browser-runner.js vào top frame ISOLATED của tab task đã xác minh, trước claim khi thiếu receiver; không nạp mã từ xa, không gửi lại SEND chưa xác minh.')

    # Use the previous release's exact runtime-version file set, not a global
    # replacement across dependencies, archived release notes or old workflows.
    paths = subprocess.check_output(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', BASE], text=True).splitlines()
    for path in paths:
        if path.startswith(('CHATMCP-HUB/', 'desktop-shell/', 'installer/')):
            data = read(path)
            if '3.8.1' in data:
                write(path, data.replace('3.8.1', '3.8.2'))

    notes = '''# ChatMCP v3.8.2 — ChatGPT Web task delivery repair

## Fixed

- A pending URL recovery for an old task no longer prevents a new queued task from being prepared, claimed and sent. Hub and Companion both enforce this separation; idle recovery remains read-only and bounded.
- A newly created task tab opens in the foreground once, rather than preparing the editor in a hidden tab.
- Companion 1.5.1 can recognize scoped Lexical, accessible contenteditable/plaintext and explicitly labelled ChatGPT textarea layouts in addition to the legacy editor. Ambiguous, hidden, dialog and conversation inputs are rejected.
- Missing content-script receivers get one bounded restoration attempt, only before claim, in the exact owned ChatGPT tab. The installed listener is idempotent. There is no restoration or repeated click after an uncertain SEND.
- Readiness diagnostics preserve safe error categories (receiver missing/timeout, composer missing, send button disabled/missing) instead of collapsing them into a generic network wait. Queue timeout retains the safe category without prompt, nonce, token or page text.

## Update both components

Stop the old Hub and install the new ChatMCPSetup.exe. Extract ChatMCP-Browser-Companion.zip and update/reload the **ChatMCP Hub Companion 1.5.1** extension in Edge/Chrome. Choose the folder containing the canonical manifest.json, not the repository-root legacy helper. Reload existing ChatGPT tabs after updating the extension; pair again only if pairing is no longer valid. Installing the desktop EXE alone does not update an already loaded unpacked extension.

The extension now declares `scripting` solely for pre-claim restoration of its two bundled scripts in an owned top-frame ChatGPT tab, in the ISOLATED world. Existing host permissions remain only chatgpt.com and the localhost Hub. No cookies, remote scripts, browser-wide tabs or debugger permission are added.

Test a **new ChatMCP Studio conversation** after updating both components. A previously failed task with no canonical ChatGPT URL is not silently replayed or rebound. Ordinary idle polling of a failed task is not another model request.

## Validation and limits

`verify-browser-delivery-readiness.mjs` exercises queued task/recovery contention, tab loading, receiver restoration, safe diagnostics, uncertain-send reconciliation, idle polling, Hub recovery isolation and representative editor layouts. Existing permission, nonce/URL ownership, no-duplicate-send and regression suites remain required by the release workflow. Release assets are built from the same versioned commit and source/ZIP/installer extension parity plus SHA-256 are verified.

Tests use scripted browser fixtures and the Windows WebView2 smoke test. They do not certify the owner's current signed-in Edge tab or every ChatGPT A/B layout. The Windows installer remains unsigned by Authenticode. Model limits, account login and user approvals are unchanged.
'''
    write('RELEASE-NOTES-v3.8.2.md', notes)
    changelog = 'CHANGELOG.md'
    replace(changelog, '# Lịch sử thay đổi\n', '# Lịch sử thay đổi\n\n## [3.8.2] — 2026-10-17 — Web task delivery repair\n\n- Separate idle URL recovery from active queued/send reconciliation; bound tab verification waits.\n- Foreground newly created task tabs, support scoped modern editors, and restore a missing receiver once before claim.\n- Preserve privacy-safe readiness/timeout diagnostics and all no-replay/nonce/permission guards.\n- Ship Companion 1.5.1 with explicitly documented host-limited scripting permission and matching installer/ZIP hashes.\n- Add executable delivery-readiness regression coverage. Live signed-in Edge verification remains an owner acceptance step.\n')
    readme = read('README.md')
    first, rest = readme.split('\n', 1)
    write('README.md', first + '\n\n**v3.8.2 — ChatGPT Web delivery repair:** update both the desktop installer and Browser Companion **1.5.1**, then reload existing ChatGPT tabs. Fixed stale URL-recovery starvation; added scoped editor compatibility, bounded pre-claim receiver restoration and safe readiness diagnostics. See [release notes](RELEASE-NOTES-v3.8.2.md).\n' + rest)
    security = read('SECURITY.md')
    write('SECURITY.md', security + '\n\n## Companion 1.5.1 receiver restoration\n\nThe `scripting` permission is restricted in code to bundled `chat-route.js` and `browser-runner.js`, top frame, ISOLATED world, of a validated owned ChatGPT tab, once per packet before claim when the receiver is missing. Host permissions are unchanged. No remote code, cookies or broad tabs permission is added. Uncertain SEND states are reconciled read-only and never authorize reinjection or another click. Diagnostics retain fixed categories, not exception/page/prompt contents.\n')

    publish = read('.github/workflows/publish-v3.8.1.yml').replace('3.8.1', '3.8.2').replace('1.5.0', '1.5.1').replace('Web Transport Switching & URL Recovery', 'ChatGPT Web Delivery Repair')
    publish = publish.replace('          $existingTag = git ls-remote', "          $main = ((git ls-remote origin refs/heads/main) -split '\\s+')[0]\n          if ($main -ne $env:GITHUB_SHA) { throw 'main moved during build; refusing stale release' }\n          $existingTag = git ls-remote")
    write('.github/workflows/publish-v3.8.2.yml', publish)
    print('Applied reviewed v3.8.2 repair; full tests must pass before commit.')


if __name__ == '__main__':
    main()
