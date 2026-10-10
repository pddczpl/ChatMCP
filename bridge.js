(() => {
  'use strict';

  if (location.origin !== 'https://chatgpt.com' || window.top !== window) return;
  if (globalThis.__chatmcpJsonlBridgeInstalled) return;
  globalThis.__chatmcpJsonlBridgeInstalled = true;

  // Only this wrapper and its excluded toolbar were observed in Elements.
  // No assumption is made about message authors or the code body's markup.
  const WRAPPER = 'div[data-markdown-copy="code-block"]';
  const OWN = '[data-chatmcp-bridge]';
  const EXCLUDED = '[data-markdown-copy="exclude"],script,style,template,textarea';
  const MAX_LENGTH = 262144;
  const MAX_EVENTS = 512;
  const states = new Map();
  const imports = new Map();
  let sequence = 0;
  let scanTimer = null;
  let snapshot = {};
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const reject = (reason) => ({ ok: false, reason });

  function finiteValues(value) {
    const pending = [value];
    while (pending.length) {
      const current = pending.pop();
      if (typeof current === 'number' && !Number.isFinite(current)) return false;
      if (current && typeof current === 'object') {
        for (const child of Object.values(current)) pending.push(child);
      }
    }
    return true;
  }

  function parseCall(text) {
    if (text.length > MAX_LENGTH) return reject('too_large');
    const events = [];
    let position = 0;
    while (position < text.length) {
      while (position < text.length && /\s/u.test(text[position])) position += 1;
      if (position === text.length) break;
      if (text[position] !== '{') return reject('extra_text');
      const start = position;
      const stack = [];
      let quoted = false;
      let escaped = false;
      do {
        const character = text[position++];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') {
          quoted = true;
        } else if (character === '{' || character === '[') {
          stack.push(character);
          if (stack.length > 64) return reject('too_deep');
        } else if (character === '}' || character === ']') {
          if (stack.pop() !== (character === '}' ? '{' : '[')) return reject('invalid_json');
        }
      } while (position < text.length && (stack.length || quoted));
      if (stack.length || quoted) return reject('incomplete');
      try { events.push(JSON.parse(text.slice(start, position))); }
      catch { return reject('invalid_json'); }
      if (events.length > MAX_EVENTS) return reject('too_many_events');
    }

    if (events.length < 2) return reject('incomplete');
    const first = events[0];
    const last = events[events.length - 1];
    if (first.type !== 'function_call_start' || last.type !== 'function_call_end') return reject('event_order');
    if (typeof first.name !== 'string' || !first.name.trim() || first.name !== first.name.trim()) return reject('invalid_name');
    const validId = (value) => (typeof value === 'string' && value.trim().length > 0) || Number.isSafeInteger(value);
    if (!validId(first.call_id) || first.call_id !== last.call_id) return reject('call_id_mismatch');
    const allowed = {
      function_call_start: ['type', 'name', 'call_id'],
      description: ['type', 'text'],
      parameter: ['type', 'key', 'value'],
      function_call_end: ['type', 'call_id']
    };
    const keys = new Set();
    let descriptions = 0;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (typeof event.type !== 'string' || !hasOwn(allowed, event.type)) return reject('unknown_event');
      if (Object.keys(event).some((key) => !allowed[event.type].includes(key))) return reject('unknown_field');
      if (!finiteValues(event)) return reject('nonfinite_number');
      if (i > 0 && i < events.length - 1) {
        if (event.type === 'description') {
          if (typeof event.text !== 'string' || ++descriptions > 1) return reject('invalid_description');
        } else if (event.type === 'parameter') {
          if (typeof event.key !== 'string' || !event.key.trim() || !hasOwn(event, 'value')) return reject('invalid_parameter');
          if (['__proto__', 'constructor', 'prototype', 'hasOwnProperty'].includes(event.key)) return reject('unsupported_parameter_key');
          if (keys.has(event.key)) return reject('duplicate_parameter');
          // The inspected native parser changes a top-level null into "".
          // Reject that input instead of silently changing the tool arguments.
          if (event.value === null) return reject('unsupported_null_parameter');
          keys.add(event.key);
        } else {
          return reject('multiple_calls');
        }
      }
    }
    return { ok: true, canonical: events.map((event) => JSON.stringify(event)).join('\n') };
  }

  function readWrapper(wrapper) {
    const clone = wrapper.cloneNode(true);
    clone.querySelectorAll(EXCLUDED).forEach((element) => element.remove());
    clone.querySelectorAll(OWN + ',.function-block').forEach((element) => element.remove());
    return clone.textContent || '';
  }

  function nativeCard(wrapper) {
    const inside = wrapper.querySelector('.function-block');
    if (inside) return inside;
    const blockIds = new Set(Array.from(wrapper.querySelectorAll('pre[data-block-id]'), (pre) => pre.getAttribute('data-block-id')));
    if (!blockIds.size) return null;
    return Array.from(document.querySelectorAll('.function-block')).find((card) => blockIds.has(card.getAttribute('data-block-id'))) || null;
  }

  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  const reasonText = {
    incomplete: 'Khối lệnh chưa hoàn tất. Đợi câu trả lời chạy xong.',
    multiple_calls: 'Chỉ chuyển một lời gọi hoàn chỉnh trong mỗi khối mã.',
    unsupported_null_parameter: 'Bộ đọc MCP hiện tại làm đổi tham số null; khối này chưa được chuyển.',
    native_pre: 'Khối này đã có phần tử mã mà MCP quét trực tiếp. Nếu chưa có thẻ, hãy gửi phần kiểm tra từ ChatMCP Button Fix.',
    call_id_mismatch: 'Mã call_id ở đầu và cuối lời gọi phải trùng nhau.'
  };

  function ensureState(wrapper) {
    let state = states.get(wrapper);
    if (state) return state;
    const host = document.createElement('div');
    host.setAttribute('data-chatmcp-bridge', '1');
    host.className = 'chatmcp-bridge';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chatmcp-bridge-transfer';
    const note = document.createElement('p');
    note.className = 'chatmcp-bridge-note';
    note.setAttribute('role', 'status');
    host.append(button, note);
    state = { wrapper, host, button, note, canonical: null, record: null, route: location.pathname };
    states.set(wrapper, state);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      // Lock immediately; do not wait for the renderer's asynchronous scan.
      button.disabled = true;
      transfer(state);
    });
    return state;
  }

  function removeState(wrapper, state) {
    state.host.remove();
    states.delete(wrapper);
    // Imported records deliberately survive DOM replacement for this document.
    // A detached card is never recreated automatically, or on a second click.
  }

  function describeRecord(state, record) {
    const connected = record.host.isConnected;
    const card = connected ? record.host.querySelector('.function-block') : null;
    const isOwner = record.host === state.host;
    state.button.disabled = isOwner || !connected;
    setText(state.button, isOwner ? 'Đã chuyển lời gọi này' : connected ? 'Mở thẻ đã chuyển' : 'Lời gọi này đã được chuyển');
    setText(state.note, !connected
      ? 'Thẻ cũ đã bị trang gỡ. Tải lại trang để thử lại; không tạo thêm bản chạy trong tab này.'
      : card
        ? 'MCP SuperAssistant đã tạo thẻ bên dưới. Khi Auto Execute tắt, bấm Run trên thẻ để chạy.'
        : 'Đã chuyển. Đang chờ MCP SuperAssistant tạo thẻ. Nếu chưa có, mở ChatMCP Button Fix và sao chép phần kiểm tra.');
  }

  function transfer(state) {
    const { wrapper } = state;
    if (!wrapper.isConnected || state.route !== location.pathname || !state.host.isConnected) { scheduleScan(); return; }
    const text = readWrapper(wrapper);
    const parsed = parseCall(text);
    if (!parsed.ok || parsed.canonical !== state.canonical || nativeCard(wrapper) || wrapper.querySelector('pre')) { scheduleScan(); return; }
    const key = JSON.stringify([location.pathname, parsed.canonical]);
    const existing = imports.get(key);
    if (existing) {
      if (existing.host.isConnected) existing.host.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      describeRecord(state, existing);
      return;
    }
    const record = { host: state.host, canonical: parsed.canonical };
    imports.set(key, record);
    state.record = record;
    const pre = document.createElement('pre');
    pre.className = 'chatmcp-bridge-input';
    pre.setAttribute('data-block-id', 'chatmcp-bridge-' + Date.now().toString(36) + '-' + (++sequence));
    const code = document.createElement('code');
    code.className = 'language-jsonl';
    code.textContent = parsed.canonical;
    pre.appendChild(code);
    // Never hide this pre ourselves: the original renderer hides it only after
    // creating its native card, which keeps the original Run/automation flow.
    state.host.appendChild(pre);
    describeRecord(state, record);
    scheduleScan();
  }

  function scan() {
    scanTimer = null;
    const counts = { codeWrappers: 0, callCandidates: 0, readyCalls: 0, nativeCardsInSources: 0, blockedReasons: {} };
    const seen = new Set();
    for (const wrapper of document.querySelectorAll(WRAPPER)) {
      if (wrapper.closest(OWN + ',.function-block,textarea,script,style,template')) continue;
      counts.codeWrappers += 1;
      seen.add(wrapper);
      const text = readWrapper(wrapper);
      const candidate = text.includes('function_call_start') || text.includes('function_call_end');
      const old = states.get(wrapper);
      if (!candidate) { if (old) removeState(wrapper, old); continue; }
      counts.callCandidates += 1;
      if (nativeCard(wrapper)) {
        counts.nativeCardsInSources += 1;
        if (old) removeState(wrapper, old);
        continue;
      }
      const parsed = parseCall(text);
      // A native pre could be processed concurrently with our copy. Fail closed
      // rather than produce two executable cards. Metadata reports this case.
      const reason = wrapper.querySelector('pre') ? 'native_pre' : parsed.ok ? null : parsed.reason;
      if (old && (old.route !== location.pathname || old.canonical !== (parsed.ok ? parsed.canonical : null))) removeState(wrapper, old);
      const state = ensureState(wrapper);
      state.canonical = parsed.ok ? parsed.canonical : null;
      if (!state.host.isConnected && !state.record && wrapper.parentNode) wrapper.parentNode.insertBefore(state.host, wrapper.nextSibling);
      if (reason) {
        counts.blockedReasons[reason] = (counts.blockedReasons[reason] || 0) + 1;
        state.button.disabled = true;
        setText(state.button, 'Khối MCP chưa chuyển được');
        setText(state.note, reasonText[reason] || 'Khối lệnh chưa đúng định dạng được hỗ trợ. Mở ChatMCP Button Fix và bấm Sao chép kiểm tra.');
        continue;
      }
      counts.readyCalls += 1;
      const key = JSON.stringify([location.pathname, parsed.canonical]);
      const record = imports.get(key);
      if (record) {
        describeRecord(state, record);
      } else {
        state.button.disabled = false;
        setText(state.button, 'Chuyển lời gọi này sang MCP');
        setText(state.note, 'MCP SuperAssistant có thể tự chạy nếu Auto Execute đang bật. Tắt các chế độ Auto để thử bằng nút Run.');
      }
    }
    for (const [wrapper, state] of states) if (!wrapper.isConnected || !seen.has(wrapper)) removeState(wrapper, state);
    snapshot = counts;
  }

  function scheduleScan() {
    if (scanTimer === null) scanTimer = setTimeout(scan, 80);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-markdown-copy'] });
  addEventListener('popstate', scheduleScan);
  scan();

  // Only metadata crosses the extension message boundary. Payloads remain in
  // the current tab's isolated world and the user-selected DOM copy.
  globalThis.__chatmcpBridgeStatus = () => {
    let importedCards = 0;
    let pendingCards = 0;
    let detachedImports = 0;
    for (const record of imports.values()) {
      if (!record.host.isConnected) detachedImports += 1;
      else if (record.host.querySelector('.function-block')) importedCards += 1;
      else pendingCards += 1;
    }
    return { ...snapshot, importedCalls: imports.size, importedCards, pendingCards, detachedImports };
  };
})();
