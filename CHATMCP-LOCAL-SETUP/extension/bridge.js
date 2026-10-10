(() => {
  'use strict';

  if (location.origin !== 'https://chatgpt.com' || window.top !== window) return;
  if (globalThis.__chatmcpJsonlBridgeInstalled) return;
  globalThis.__chatmcpJsonlBridgeInstalled = true;

  // Only this wrapper and its excluded toolbar were observed in Elements.
  // Manual mode does not assume message authors. Automatic mode additionally
  // requires an explicit assistant role, a per-activation call-ID prefix and a
  // recognized idle state. Unknown DOM variants stay manual.
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
  const AUTO_QUIET_MS = 1000;
  const automatic = {
    enabled: false, prefix: '', route: location.pathname, generation: 0,
    baseline: new WeakSet(), timers: new Map(), checks: new Map(), hubBinding: null, reason: 'off'
  };
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
    return { ok: true, callId: first.call_id, canonical: events.map((event) => JSON.stringify(event)).join('\n') };
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

  function cancelAutomatic(state) {
    const timer = automatic.timers.get(state);
    if (timer !== undefined) clearTimeout(timer);
    automatic.timers.delete(state);
    automatic.checks.delete(state);
  }

  function automaticSession() {
    return { enabled: automatic.enabled, callIdPrefix: automatic.enabled ? automatic.prefix : null };
  }

  function setAutomatic(enabled) {
    for (const state of automatic.timers.keys()) cancelAutomatic(state);
    automatic.checks.clear();
    automatic.hubBinding = null;
    automatic.generation += 1;
    automatic.enabled = enabled === true;
    automatic.route = location.pathname;
    automatic.reason = automatic.enabled ? 'waiting_for_new_call' : 'off';
    automatic.prefix = automatic.enabled ? 'chatmcp-' + crypto.randomUUID() + '-' : '';
    automatic.baseline = new WeakSet(document.querySelectorAll(WRAPPER));
    scheduleScan();
    return automaticSession();
  }

  function validBinding(binding) {
    return binding && typeof binding.workspacePath === 'string' && binding.workspacePath.length > 0 &&
      Number.isSafeInteger(binding.generation) && binding.generation >= 0 &&
      typeof binding.instanceId === 'string' && binding.instanceId.length > 0 && binding.instanceId.length <= 128;
  }

  function bindHub(binding, prefix) {
    if (!automatic.enabled || prefix !== automatic.prefix || !validBinding(binding)) return { ok: false };
    automatic.hubBinding = { workspacePath: binding.workspacePath, generation: binding.generation, instanceId: binding.instanceId };
    scheduleScan();
    return { ok: true };
  }

  function checkAutomaticRoute() {
    if (!automatic.enabled || automatic.route === location.pathname) return;
    // ChatGPT gives a fresh chat its /c/... route after the first submitted
    // message. Bind that initial transition once; all other changes disarm.
    if (automatic.route === '/' && /^\/c\/[^/]+\/?$/.test(location.pathname)) {
      automatic.route = location.pathname;
    } else {
      setAutomatic(false);
      automatic.reason = 'conversation_changed';
    }
  }

  function explicitAssistant(wrapper) {
    if (wrapper.closest('blockquote,[role="dialog"],[contenteditable="true"],.function-result-container,.system-message-container,.mcp-instructions-container,#mcp-popover-container,#mcp-popover-portal')) return null;
    let author = null;
    for (let element = wrapper; element; element = element.parentElement) {
      if (!element.hasAttribute('data-message-author-role')) continue;
      if (element.getAttribute('data-message-author-role') !== 'assistant') return null;
      if (!author) author = element;
    }
    return author;
  }

  function hasLayout(element) {
    if (!element || element.hidden || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 0 && rectangle.height > 0;
  }

  function idleReply(author) {
    if (author.closest('[aria-busy="true"]') || author.querySelector('[aria-busy="true"]')) return false;
    if (Array.from(document.querySelectorAll('button[data-testid="stop-button"]')).some(hasLayout)) return false;
    if (author.getAttribute('aria-busy') === 'false') return true;
    // These exact send selectors come from the inspected upstream adapter.
    // Presence with layout is used only as an idle signal; never click it.
    return Array.from(document.querySelectorAll('button[data-testid="send-button"],button[data-testid="fruitjuice-send-button"]')).some(hasLayout);
  }

  function automaticReason(state, parsed) {
    checkAutomaticRoute();
    if (!automatic.enabled) return 'off';
    if (!automatic.hubBinding) return 'workspace_not_prepared';
    if (automatic.baseline.has(state.wrapper)) return 'existing_block';
    const author = explicitAssistant(state.wrapper);
    if (!author) return 'unverified_author';
    if (typeof parsed.callId !== 'string' || !parsed.callId.startsWith(automatic.prefix) ||
        !/^[1-9]\d{0,8}$/.test(parsed.callId.slice(automatic.prefix.length))) return 'session_call_id_required';
    if (!idleReply(author)) return 'reply_not_known_idle';
    return null;
  }

  function considerAutomatic(state, parsed, counts) {
    const reason = automaticReason(state, parsed);
    if (reason) {
      cancelAutomatic(state);
      if (automatic.enabled) counts.autoBlockedReasons[reason] = (counts.autoBlockedReasons[reason] || 0) + 1;
      return reason;
    }
    if (!automatic.timers.has(state) && !automatic.checks.has(state)) {
      const generation = automatic.generation;
      const canonical = parsed.canonical;
      const timer = setTimeout(() => {
        automatic.timers.delete(state);
        if (!automatic.enabled || automatic.generation !== generation || !state.wrapper.isConnected) return;
        const current = parseCall(readWrapper(state.wrapper));
        if (!current.ok || current.canonical !== canonical || automaticReason(state, current)) { scheduleScan(); return; }
        verifyHubAndTransfer(state, current, generation);
      }, AUTO_QUIET_MS);
      automatic.timers.set(state, timer);
    }
    return null;
  }

  async function verifyHubAndTransfer(state, parsed, generation) {
    const ticket = {};
    automatic.checks.set(state, ticket);
    let result;
    try { result = await chrome.runtime.sendMessage({ type: 'CHATMCP_HUB_READ_STATE' }); }
    catch { result = null; }
    if (automatic.checks.get(state) !== ticket || automatic.generation !== generation || !automatic.enabled) return;
    automatic.checks.delete(state);
    const value = result?.state;
    const bound = automatic.hubBinding;
    const sameWorkspace = result?.ok === true && value?.ready === true && bound &&
      value.workspace?.path === bound.workspacePath && value.generation === bound.generation && value.instanceId === bound.instanceId;
    if (!sameWorkspace) {
      setAutomatic(false);
      automatic.reason = result?.ok === true ? 'hub_workspace_changed' : 'hub_unavailable';
      scheduleScan();
      return;
    }
    // Fetch is asynchronous. Recheck content, role, route, idle state and
    // ownership again; a changed source or canceled session never transfers.
    const current = parseCall(readWrapper(state.wrapper));
    if (!current.ok || current.canonical !== parsed.canonical || automaticReason(state, current)) { scheduleScan(); return; }
    transfer(state, true);
  }

  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  const reasonText = {
    incomplete: 'Khối lệnh chưa hoàn tất. Đợi câu trả lời chạy xong.',
    multiple_calls: 'Chỉ chuyển một lời gọi hoàn chỉnh trong mỗi khối mã.',
    unsupported_null_parameter: 'Bộ đọc MCP hiện tại làm đổi tham số null; khối này chưa được chuyển.',
    native_pre: 'Khối này đã có phần tử mã mà MCP quét trực tiếp. Nếu chưa có thẻ, hãy gửi phần kiểm tra từ ChatMCP Hub Companion.',
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
    cancelAutomatic(state);
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
        : 'Đã chuyển. Đang chờ MCP SuperAssistant tạo thẻ. Nếu chưa có, mở ChatMCP Hub Companion và sao chép phần kiểm tra.');
  }

  function transfer(state, auto = false) {
    const { wrapper } = state;
    if (!wrapper.isConnected || state.route !== location.pathname || !state.host.isConnected) { scheduleScan(); return; }
    const text = readWrapper(wrapper);
    const parsed = parseCall(text);
    if (!parsed.ok || parsed.canonical !== state.canonical || nativeCard(wrapper) || wrapper.querySelector('pre')) { scheduleScan(); return; }
    if (auto && automaticReason(state, parsed)) { scheduleScan(); return; }
    cancelAutomatic(state);
    const key = JSON.stringify([location.pathname, parsed.canonical]);
    const existing = imports.get(key);
    if (existing) {
      if (!auto && existing.host.isConnected) existing.host.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      describeRecord(state, existing);
      return;
    }
    const record = { host: state.host, canonical: parsed.canonical, automatic: auto };
    imports.set(key, record);
    if (auto) automatic.reason = 'active';
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
    checkAutomaticRoute();
    const counts = { codeWrappers: 0, callCandidates: 0, readyCalls: 0, nativeCardsInSources: 0, blockedReasons: {}, autoBlockedReasons: {} };
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
        cancelAutomatic(state);
        counts.blockedReasons[reason] = (counts.blockedReasons[reason] || 0) + 1;
        state.button.disabled = true;
        setText(state.button, 'Khối MCP chưa chuyển được');
        setText(state.note, reasonText[reason] || 'Khối lệnh chưa đúng định dạng được hỗ trợ. Mở ChatMCP Hub Companion và bấm Sao chép kiểm tra.');
        continue;
      }
      counts.readyCalls += 1;
      const key = JSON.stringify([location.pathname, parsed.canonical]);
      const record = imports.get(key);
      if (record) {
        cancelAutomatic(state);
        describeRecord(state, record);
      } else {
        state.button.disabled = false;
        setText(state.button, 'Chuyển lời gọi này sang MCP');
        const autoReason = considerAutomatic(state, parsed, counts);
        const autoNotes = {
          workspace_not_prepared: 'Bấm Chuẩn bị chat trong ChatMCP Hub để gắn phiên này với workspace đang chọn.',
          existing_block: 'Khối đã có trước khi bật Tự động; bạn vẫn có thể chọn chuyển thủ công.',
          unverified_author: 'Chưa xác minh được đây là khối của assistant. Chọn chuyển thủ công nếu đây là lời gọi bạn muốn chạy.',
          session_call_id_required: 'Khối chưa dùng mã của phiên Tự động này. Chèn hướng dẫn workspace từ ChatMCP Hub rồi gửi yêu cầu mới.',
          reply_not_known_idle: 'Đang chờ câu trả lời kết thúc và dấu hiệu trạng thái nghỉ. Nếu giao diện chưa được nhận diện, có thể chuyển thủ công.'
        };
        setText(state.note, automatic.enabled
          ? autoReason ? autoNotes[autoReason] || 'Chưa đủ điều kiện chuyển tự động.' : 'Đã nhận diện lời gọi mới của assistant; đang đợi nội dung ổn định trước khi chuyển sang MCP.'
          : 'MCP SuperAssistant có thể tự chạy nếu Auto Execute đang bật. Tắt các chế độ Auto để thử bằng nút Run.');
      }
    }
    for (const [wrapper, state] of states) if (!wrapper.isConnected || !seen.has(wrapper)) removeState(wrapper, state);
    snapshot = counts;
  }

  function scheduleScan() {
    if (scanTimer === null) scanTimer = setTimeout(scan, 80);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-markdown-copy', 'data-message-author-role', 'aria-busy', 'aria-hidden', 'hidden', 'data-testid'] });
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
    return { ...snapshot, importedCalls: imports.size, importedCards, pendingCards, detachedImports,
      autoEnabled: automatic.enabled, autoState: automatic.reason,
      autoPending: automatic.timers.size + automatic.checks.size,
      hubBound: Boolean(automatic.hubBinding),
      autoImportedCalls: Array.from(imports.values()).filter(record => record.automatic).length };
  };
  globalThis.__chatmcpBridgeSetAuto = setAutomatic;
  globalThis.__chatmcpBridgeSession = automaticSession;
  globalThis.__chatmcpBridgeBindHub = bindHub;
})();
