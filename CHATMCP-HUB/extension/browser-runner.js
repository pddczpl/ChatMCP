(() => {
  'use strict';
  if (location.origin !== 'https://chatgpt.com' || window.top !== window) return;
  const pageId = crypto.randomUUID();
  const STABLE_MS = 1800;
  const CANONICAL_ROUTE_WAIT_MS = 60000;
  const FIRST_TURN_BINDING_WAIT_MS = 90000;
  const MAX_BYTES = 2 * 1024 * 1024;
  const WITNESS_KINDS = new Set(['catalog', 'describe', 'tool', 'result_page', 'capability', 'final']);
  const routes = globalThis.__chatmcpChatRoute;
  let current = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const url = () => location.origin + location.pathname;
  const plain = element => element.tagName === 'TEXTAREA' ? element.value : element.innerText || element.textContent || '';
  const normalized = text => String(text).replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  function visible(element) {
    if (!element || element.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function elements(selector) { return Array.from(document.querySelectorAll(selector)).filter(visible); }
  function input() {
    for (const selector of ['#prompt-textarea', '.ProseMirror[contenteditable="true"]']) {
      const matches = elements(selector).filter(element => !element.disabled && !element.readOnly && (element.tagName === 'TEXTAREA' || element.getAttribute('contenteditable') === 'true'));
      if (matches.length > 1) return { reason: 'ambiguous_composer' };
      if (matches.length === 1) return { element: matches[0] };
    }
    return { reason: 'composer_missing: Chưa thấy ô chat; kiểm tra đăng nhập và giao diện ChatGPT.' };
  }
  const EXCLUDED_CONTROLS = '[data-message-author-role],blockquote,[contenteditable="true"],[role="dialog"],.function-block,.function-result-container,.system-message-container,.mcp-instructions-container,#mcp-popover-container,#mcp-popover-portal';
  const SEND_NAMES = new Set(['send', 'send message', 'send prompt', 'gửi', 'gửi tin nhắn', 'gửi lời nhắc', 'gửi câu hỏi']);
  const STOP_NAMES = new Set(['stop generating', 'stop streaming', 'stop response', 'dừng tạo', 'dừng tạo câu trả lời', 'dừng phản hồi']);
  function controlName(button) {
    let name = button.getAttribute('aria-label');
    if (!name && button.getAttribute('aria-labelledby')) {
      name = button.getAttribute('aria-labelledby').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
    }
    return normalized(name || button.getAttribute('title') || plain(button)).normalize('NFC').toLowerCase();
  }
  function nativeButtons(root) {
    return Array.from(root?.querySelectorAll('button') || []).filter(button => visible(button) && !button.closest(EXCLUDED_CONTROLS));
  }
  function knownSend(button) {
    return ['send-button', 'fruitjuice-send-button'].includes(button.getAttribute('data-testid')) || button.id === 'composer-submit-button';
  }
  function sendPurpose(button, form) {
    const name = controlName(button);
    // A known marker can be reused for Stop while streaming. An explicit
    // conflicting name always wins; never click Upload/Allow/Voice as Send.
    if (name && !SEND_NAMES.has(name)) return false;
    if (form && ((button.getAttribute('form') && button.getAttribute('form') !== form.id) || (button.form && button.form !== form))) return false;
    return knownSend(button) || SEND_NAMES.has(name) || !!(form && button.getAttribute('type') === 'submit' && !name);
  }
  function composerScope(composer) {
    if (!composer || composer.closest(EXCLUDED_CONTROLS.replace('[contenteditable="true"],', ''))) return null;
    const form = composer.closest('form');
    if (form) return { root: form, form };
    // Some layouts omit a form. Only inspect bounded composer ancestors,
    // never the page/main/article or a container with conversation messages.
    let last = null;
    for (let parent = composer.parentElement, depth = 0; parent && depth < 6; parent = parent.parentElement, depth += 1) {
      if (['BODY', 'HTML', 'MAIN', 'ARTICLE'].includes(parent.tagName) || parent.querySelector('[data-message-author-role]') || parent.closest(EXCLUDED_CONTROLS)) break;
      last = { root: parent, form: null };
      if (nativeButtons(parent).some(button => sendPurpose(button, null))) return last;
    }
    return last;
  }
  function disabled(button) {
    return button.disabled === true || button.getAttribute('aria-disabled') === 'true' || !!button.closest('fieldset[disabled]');
  }
  function sendState(composer) {
    const scope = composerScope(composer);
    const controls = nativeButtons(scope?.root);
    const candidates = controls.filter(button => sendPurpose(button, scope?.form));
    const button = candidates.length === 1 && !disabled(candidates[0]) ? candidates[0] : null;
    return { composer, scope, controls, candidates, button };
  }
  function sendFailure(state) {
    const code = state.candidates.length > 1 ? 'send_button_ambiguous' : state.candidates.length ? 'send_button_disabled' : 'send_button_missing';
    const explanation = code === 'send_button_ambiguous' ? 'Có nhiều nút Gửi trong khung nhập; chưa bấm nút nào.' : code === 'send_button_disabled' ? 'Nút Gửi vẫn chưa được ChatGPT bật sau khi điền nội dung.' : 'Chưa nhận diện được nút Gửi trong khung nhập ChatGPT.';
    // Counts and fixed categories only: never collect prompt, result, account,
    // URLs or arbitrary attribute values in a readiness diagnostic.
    const diagnostics = [
      'companion=1.5.0', 'scope=' + (state.scope?.form ? 'form' : state.scope ? 'composer-container' : 'unknown'),
      'editor=' + (state.composer?.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable'),
      'visibility=' + (document.visibilityState === 'hidden' ? 'hidden' : document.visibilityState === 'visible' ? 'visible' : 'unknown'),
      'controls=' + state.controls.length, 'known=' + state.controls.filter(knownSend).length,
      'send=' + state.candidates.length, 'disabled=' + state.candidates.filter(disabled).length
    ].join(';');
    return { ok: false, reason: `${code}: ${explanation} [${diagnostics}]`, retryable: code !== 'send_button_ambiguous' };
  }
  function stops() {
    return elements('button').filter(button => !button.closest(EXCLUDED_CONTROLS) && (button.getAttribute('data-testid') === 'stop-button' || STOP_NAMES.has(controlName(button))));
  }
  function interruption() {
    const selectedMode = elements('[role="tab"][aria-selected="true"],[role="radio"][aria-checked="true"],button[aria-pressed="true"]')
      .find(element => !element.closest('[data-message-author-role],#mcp-popover-container,#mcp-popover-portal') && /^(work|codex|agent|agent mode|chế độ tác tử|chế độ tác nhân)$/i.test(normalized(plain(element))));
    if (selectedMode) return 'wrong_chat_mode: Giao diện đang chọn Work/Codex/Agent. Hãy chọn Chat thông thường; extension không tự đổi chế độ.';
    const login = elements('a,button').find(element => !element.closest('#mcp-popover-container,.mcp-instructions-container') && /^(log in|login|sign in|đăng nhập)$/i.test(normalized(plain(element))));
    if (login) return 'login_required: Đăng nhập ChatGPT thông thường trong trình duyệt; extension không nhập tài khoản.';
    // ChatGPT may keep the same /c/<id> URL for a deleted/inaccessible chat.
    // Fail closed only for an explicit missing-conversation UI notice, not
    // for arbitrary phrases inside user/assistant message content.
    if (current?.resumedFromCheckpoint === true &&
        elements('[role="alert"],h1,h2').some(el =>
          !el.closest('[data-message-author-role]') &&
          /^(conversation not found|chat not found|unable to load conversation|không tìm thấy cuộc trò chuyện|không tải được cuộc trò chuyện)[.!\s]*$/i.test(normalized(plain(el))))) {
      return 'original_chat_missing: Cuộc chat cũ không còn truy cập được. Không tạo cuộc chat mới.';
    }
    const dialogs = elements('[role="dialog"],[role="alert"]');
    for (const element of dialogs) {
      if (element.closest('#mcp-popover-container,#mcp-popover-portal')) continue;
      const text = plain(element);
      if (/usage limit|message limit|limit reached|reached.{0,35}limit|too many requests|try again later|hết.{0,25}hạn mức|đạt.{0,25}giới hạn|giới hạn.{0,25}tin nhắn/i.test(text)) return 'chatgpt_limit: ChatGPT đang báo hạn mức hoặc cần chờ. Không tự chuyển model/tài khoản hay vượt giới hạn.';
      if (element.getAttribute('role') === 'dialog') return 'dialog_requires_user: ChatGPT có hộp thoại cần người dùng xử lý; chưa bấm nút nào.';
    }
    return null;
  }
  function authored(role) {
    const composerRoot = composerScope(input().element)?.root;
    // A/B UI variants may render the user's bubble with a test ID and no
    // data-message-author-role attribute. Keep the fallback strictly scoped
    // to user messages; never mine arbitrary article text or assistant replies.
    const primary = elements('[data-message-author-role="' + role + '"]');
    const candidates = role === 'user' && !primary.length
      ? elements('[data-testid="user-message"]').filter(element => !element.closest('[data-message-author-role="assistant"]'))
      : primary;
    return candidates.filter(element => {
      if (composerRoot?.contains(element)) return false;
      if (element.closest('blockquote,textarea,script,style,[contenteditable="true"],.function-block,.function-result-container,.system-message-container,.mcp-instructions-container,#mcp-popover-container,#mcp-popover-portal')) return false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const value = parent.getAttribute('data-message-author-role');
        if (value !== null) return false; // Select one outer author node per turn.
      }
      return true;
    });
  }
  // ChatGPT may collapse the outgoing user message into a "Show more" or
  // attachment view with neither of the older author attributes. In that case,
  // the dedicated task tab's *assistant* reply is authoritative only when a
  // complete JSON code block echoes the unpredictable Hub nonce, task ID and
  // EXACT turn. This is stronger than guessing a conversation ID from a URL.
  // The underlying Hub independently checks these same fields before executing.
  function replyWitness() {
    if (!current || !/^[0-9a-f]{48}$/i.test(current.nonce || '')) return null;
    const found = new Map();
    for (const node of elements('pre,[data-markdown-copy="code-block"]')) {
      if (node.closest('[data-message-author-role="user"],[data-testid="user-message"],form,blockquote,[contenteditable="true"],#mcp-popover-container,#mcp-popover-portal,.mcp-instructions-container')) continue;
      const author = node.closest('[data-message-author-role]');
      if (author && author.getAttribute('data-message-author-role') !== 'assistant') continue;
      const preferred = node.querySelector('pre code,code,pre');
      const candidates = [preferred ? preferred.textContent : null, node.textContent, node.innerText];
      for (const text of candidates) {
        if (typeof text !== 'string' || text.length > 25000) continue;
        const first = text.indexOf('{'), last = text.lastIndexOf('}');
        if (first < 0 || last <= first) continue;
        const raw = text.slice(first, last + 1).trim();
        let value;
        try { value = JSON.parse(raw); } catch { continue; }
        if (!value || Array.isArray(value) || typeof value !== 'object' ||
            value.chatmcp_hub !== 'v1' || value.task !== current.taskId ||
            value.turn !== current.turn || value.nonce !== current.nonce ||
            !WITNESS_KINDS.has(value.kind)) continue;
        const canonical = JSON.stringify(value);
        if (!found.has(canonical)) found.set(canonical, { node, raw, value });
        break;
      }
    }
    if (found.size > 1) return { ambiguous: true };
    return found.values().next().value || null;
  }
  function routeStatus() {
    const next = routes?.parse(url());
    if (!next) return 'blocked';
    if (!current) return 'ok';
    const previous = routes.parse(location.origin + current.route);
    if (routes.sameConversation(previous, next)) {
      current.route = next.path; current.routePendingSince = null;
      return 'ok';
    }
    const initial = current.turn === 1 && !current.routeLocked;
    if (initial && ['prepared', 'send_preparing'].includes(current.stage)) {
      // A new empty composer can acquire a provisional conversation URL while
      // its draft is saved. No history may be present before the owned click.
      if (next.kind === 'chat' && !authored('user').length && !authored('assistant').length && draftMatches(input().element)) {
        current.route = next.path; return 'ok';
      }
      return 'blocked';
    }
    if (initial && ['sending', 'sent', 'reply'].includes(current.stage)) {
      const user = ownUser();
      const witness = !user ? replyWitness() : null;
      const laterUser = witness?.node && authored('user').some(element => after(element, witness.node));
      if (next.kind === 'chat' && ((user && !authored('user').some(element => element !== user && after(element, user))) ||
          (witness && !witness.ambiguous && !laterUser))) {
        // During first creation only, use the submitted turn as the anchor.
        // The page may assign a provisional ID before its final URL arrives.
        current.route = next.path; current.routePendingSince = null;
        current.stableText = null; current.stableSince = 0;
        current.provisionalReplySince = null;
        return 'ok';
      }
      // URL and message DOM can render on different ticks after the one click.
      // Wait for identity evidence; never send again to obtain that evidence.
      if (next.kind === 'chat') {
        current.routePendingSince ??= Date.now();
        if (Date.now() - current.routePendingSince <= FIRST_TURN_BINDING_WAIT_MS) return 'pending';
      }
    }
    return 'blocked';
  }
  function routeFailure() {
    const from = routes?.parse(location.origin + (current?.route || '/'));
    const to = routes?.parse(url());
    const shape = route => !route ? 'unsupported' : route.kind === 'home' ? 'home' : route.provisional ? 'temporary-chat' : route.path.startsWith('/g/') ? 'scoped-chat' : route.path.startsWith('/chat/') ? 'chat-path' : 'conversation';
    const firstUnbound = current?.turn === 1 && !current?.routeLocked && from?.kind === 'home' && to?.kind === 'chat';
    if (firstUnbound) {
      const nodes = authored('user');
      const hasText = !!current?.promptNormalized;
      const largePrompt = (current?.text?.length ?? 0) > 5000;
      const witness = replyWitness();
      return 'submitted_user_message_unverified: Không tìm thấy tin nhắn đầu hoặc câu trả lời có mã phiên chính xác trong tab tác vụ. Không tự gửi lại. [companion=1.5.0;from=home;to=' + shape(to) + ';visibleUsers=' + nodes.length + ';replyWitness=' + (witness?.ambiguous ? 'ambiguous' : !!witness) + ';promptPresent=' + hasText + ';longPrompt=' + largePrompt + ']';
    }
    return 'conversation_changed: Chưa xác minh được địa chỉ của cùng cuộc chat. [companion=1.5.0;from=' + shape(from) + ';to=' + shape(to) + ';turn=' + (current?.turn || 0) + ';locked=' + !!current?.routeLocked + ']';
  }
  function ownUser() {
    if (!current) return null;
    const expected = current.promptNormalized;
    // ChatGPT may add text to the outer user wrapper (copy/edit controls,
    // labels or metadata); match against the actual message body as well.
    // The task's unguessable UUID is present in every Hub-generated turn, so
    // wrapper-inclusive exact containment is still bound to THIS task.
    const matchesUser = element => {
      const candidates = [element, ...element.querySelectorAll('[data-testid="user-message"],[data-testid="message-content"],[data-message-content],.whitespace-pre-wrap,.prose')];
      for (const part of candidates) {
        if (part !== element && part.closest('[data-message-author-role]') !== element && element.hasAttribute('data-message-author-role')) continue;
        const options = [normalized(plain(part)), normalized(cleanupClone(part).textContent || '')];
        if (options.some(value => value === expected ||
          (expected.length > 100 && expected.includes(current.taskId) && value.includes(expected)))) return true;
      }
      return false;
    };
    return authored('user').findLast(matchesUser) || null;
  }
  function after(element, anchor) { return Boolean(anchor.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING); }
  function cleanupClone(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script,style,template,textarea,input,select,button,[contenteditable="true"],[data-markdown-copy="exclude"],.function-block,.function-result-container,.system-message-container,#mcp-popover-container').forEach(child => child.remove());
    return clone;
  }
  function extractReply(author) {
    const blocks = [];
    const seen = new Set();
    const candidates = Array.from(author.querySelectorAll('pre,[data-markdown-copy="code-block"]'));
    for (const element of candidates) {
      if (candidates.some(other => other !== element && other.contains(element))) continue;
      const clone = cleanupClone(element);
      const code = clone.tagName === 'PRE' ? clone.querySelector('code') : null;
      const text = (code || clone).textContent || '';
      if (!seen.has(text)) { blocks.push(text); seen.add(text); }
    }
    const text = cleanupClone(author).textContent || '';
    if (new TextEncoder().encode(JSON.stringify({ text, blocks })).length > MAX_BYTES) return { reason: 'reply_too_large: Không cắt bớt câu trả lời vượt 2 MiB.' };
    return { text, blocks };
  }
  async function hash(text) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function matches(message) { return current && message.taskId === current.taskId && message.messageId === current.messageId && (!message.pageId || message.pageId === pageId); }

  const draftValue = element => element ? plain(element).replace(/\r\n?/g, '\n') : null;
  function draftMatches(composer) {
    if (!composer || !current) return false;
    const value = draftValue(composer);
    return value === current.text.replace(/\r\n?/g, '\n') || value === current.ownedDraftValue;
  }
  function beforeSendGuard() {
    // An explicitly authorized follow-up is allowed in the exact saved
    // conversation even when the MV3 content script was recreated and has
    // no previousPromptNormalized. This permission is ONLY for that first
    // packet: all subsequent packets recheck the previous owned turn.
    if (current?.resumedFromCheckpoint === true &&
        ['prepared', 'send_preparing'].includes(current.stage) &&
        routes.normalize(url()) === current.resumeUrl) return null;
    const users = authored('user');
    if (current.turn === 1) return users.length || authored('assistant').length ? 'new_task_requires_empty_chat' : null;
    const last = users.at(-1);
    if (current.previousWitnessBound && !users.length) return null;
    if (current.previousWitnessBound && current.previousWitnessNode &&
        current.previousWitnessNode.isConnected !== false &&
        !users.some(element => after(element, current.previousWitnessNode))) return null;
    return !last || normalized(plain(last)) !== current.previousPromptNormalized ? 'user_intervened_in_owned_chat: Có tin nhắn mới đã gửi ngoài lượt Hub.' : null;
  }
  function replaceDraft(composer) {
    if (draftMatches(composer)) return null;
    composer.focus();
    try {
      if (composer.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setter) return 'input_setter_unavailable';
        setter.call(composer, current.text);
      } else {
        const selection = window.getSelection();
        if (!selection || typeof document.execCommand !== 'function') return 'input_insertion_unsupported';
        const range = document.createRange();
        range.selectNodeContents(composer); // Replace the entire authorized draft.
        selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('insertText', false, current.text)) return 'input_insertion_unconfirmed';
      }
      if (normalized(plain(composer)) !== current.promptNormalized) return 'draft_changed_or_insertion_unconfirmed';
      current.ownedDraftValue = draftValue(composer);
      const event = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: current.text })
        : new Event('input', { bubbles: true, composed: true });
      composer.dispatchEvent(event);
      return null;
    } catch { return 'input_insertion_unsupported'; }
  }
  async function prepareComposer(message, clickWhenReady = false) {
    let readiness = sendState(input().element);
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (!matches(message) || !['prepared', 'send_preparing'].includes(current.stage)) return { ok: false, reason: 'preparation_changed' };
      const route = routeStatus();
      if (route !== 'ok') return { ok: false, reason: routeFailure() };
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, reason: 'network_offline', retryable: true };
      const blocker = interruption() || beforeSendGuard();
      if (blocker) return { ok: false, reason: blocker };
      if (stops().length) return { ok: false, reason: 'chat_is_busy', retryable: true };
      const found = input();
      if (!found.element) return { ok: false, reason: found.reason, retryable: true };
      const replaced = replaceDraft(found.element);
      if (replaced) return { ok: false, reason: replaced };
      const present = input().element;
      if (present !== found.element || !draftMatches(present)) { await sleep(100); continue; }
      readiness = sendState(present);
      if (readiness.candidates.length > 1) return sendFailure(readiness);
      if (readiness.button) {
        // Input notifications may synchronously rerender the editor or change
        // its route. Recheck identity in the same tick as the only Send click.
        if (routeStatus() !== 'ok') return { ok: false, reason: routeFailure() };
        const finalBlocker = interruption() || beforeSendGuard();
        if (finalBlocker) return { ok: false, reason: finalBlocker };
        if (stops().length) return { ok: false, reason: 'chat_is_busy', retryable: true };
        if (clickWhenReady) {
          current.stage = 'sending'; current.sentAt = Date.now();
          readiness.button.click();
        }
        return { ok: true, pageId, url: url() };
      }
      await sleep(100);
    }
    return sendFailure(readiness);
  }

  async function prepare(message) {
    if (typeof message.text !== 'string' || !message.text.trim() || new TextEncoder().encode(message.text).length > 1024 * 1024 || typeof message.taskId !== 'string' || typeof message.messageId !== 'string' || !Number.isInteger(message.turn) || message.turn < 1 || !/^[0-9a-f]{48}$/i.test(message.nonce || '') || !message.text.includes(message.nonce)) return { ok: false, reason: 'invalid_prompt_payload_or_nonce' };
    const resumeUrl = message.resumeUrl ? routes.normalize(message.resumeUrl) : null;
    const validResume = Boolean(resumeUrl && routes.parse(resumeUrl)?.kind === 'chat' && routes.parse(resumeUrl)?.provisional !== true);
    const continuing = validResume && message.resumeStart === true;
    if (message.resumeUrl && (!validResume || routes.normalize(url()) !== resumeUrl)) return { ok: false, reason: 'resume_chat_mismatch: Không được gửi vào cuộc chat khác.' };
    if (!current && message.turn !== 1 && !continuing) return { ok: false, reason: 'missing_previous_turn: Tab đã tải lại hoặc thiếu ngữ cảnh của tác vụ; không gửi tiếp vào cuộc chat chưa xác minh.' };
    if (current && !matches(message) && !['reply', 'cancelled', 'failed'].includes(current.stage) && !continuing) return { ok: false, reason: 'previous_turn_not_finished' };
    if (current && matches(message) && current.stage !== 'prepared') return { ok: false, reason: 'send_already_attempted' };
    if (routeStatus() !== 'ok') return { ok: false, reason: routeFailure() };
    const blocker = interruption();
    if (blocker) return { ok: false, reason: blocker };
    if (stops().length) return { ok: false, reason: 'chat_is_busy', retryable: true };
    const found = input();
    if (!found.element) return { ok: false, reason: found.reason, retryable: true };
    if (!current || !matches(message)) {
      if (message.turn === 1 && !continuing && (authored('user').length || authored('assistant').length)) return { ok: false, reason: 'new_task_requires_empty_chat' };
      let previousUser = null, previousWitness = null, previousIntervention = false;
      if (current && message.turn !== 1 && !continuing) {
        if (message.taskId !== current.taskId || message.turn !== current.turn + 1) return { ok: false, reason: 'previous_turn_mismatch' };
        previousUser = ownUser();
        previousWitness = !previousUser && current.replyWitnessVerified ? replyWitness() : null;
        previousIntervention = Boolean(previousWitness?.node && authored('user').some(element => after(element, previousWitness.node)));
        if ((!previousUser && (!previousWitness || previousWitness.ambiguous || previousIntervention)) ||
            (previousUser && authored('user').some(element => element !== previousUser && after(element, previousUser))))
          return { ok: false, reason: 'user_intervened_in_owned_chat: Không xác minh được lượt trước thuộc tab tác vụ.' };
      }
      const previous = current;
      current = {
        taskId: message.taskId, messageId: message.messageId, nonce: message.nonce, turn: message.turn, stage: 'prepared',
        promptNormalized: normalized(message.text), text: message.text, route: routes.parse(url()).path,
        resumedFromCheckpoint: continuing, resumeUrl: continuing ? resumeUrl : null,
        routeLocked: continuing ? true : message.turn === 1 ? false : Boolean(previous?.routeLocked), routePendingSince: null,
        provisionalReplySince: null,
        previousPromptNormalized: previous?.promptNormalized || null,
        previousWitnessBound: Boolean(previous?.replyWitnessVerified && !previousUser && previousWitness && !previousIntervention),
        previousWitnessNode: previousWitness?.node || null,
        ownedDraftValue: null, stopSeen: false, sentAt: null,
        stableText: null, stableSince: 0, confirmedUser: false, boundViaReply: false, replyWitnessVerified: false
      };
      // The new dialect is separate from the legacy JSONL bridge. This affects
      // our companion only; it never changes MCP SuperAssistant's store/toggles.
      globalThis.__chatmcpBridgeSetAuto?.(false);
    }
    return prepareComposer(message);
  }

  function sendEvidence() {
    const user = ownUser();
    if (user && authored('user').some(element => element !== user && after(element, user))) return { ok: false, reason: 'user_intervened_in_owned_chat' };
    const witness = !user ? replyWitness() : null;
    if (witness?.ambiguous) return { ok: false, reason: 'ambiguous_task_reply: Nhiều lệnh khác nhau mang cùng mã phiên trong tab.' };
    if (witness?.node && authored('user').some(element => after(element, witness.node)))
      return { ok: false, reason: 'user_intervened_in_owned_chat' };
    if (!user && !witness) return null;
    current.confirmedUser = true; current.boundViaReply = !user; current.stage = 'sent';
    return { ok: true };
  }
  async function send(message) {
    if (!matches(message) || current.stage !== 'prepared') return { ok: false, reason: 'send_state_mismatch' };
    // Lock out duplicate SEND before any await. Replace a changed unsent draft
    // and wait for readiness, then click exactly once inside prepareComposer.
    current.stage = 'send_preparing';
    const prepared = await prepareComposer(message, true);
    if (!prepared.ok) {
      // When the page explicitly reports offline BEFORE any click, this turn
      // is known unsent. The worker may retry SEND when connectivity returns.
      if (prepared.retryable === true && current.stage === 'send_preparing' && current.sentAt === null)
        current.stage = 'prepared';
      return prepared;
    }
    // IMPORTANT: Do not hold an MV3 extension message port open for 90 seconds
    // while waiting for ChatGPT to confirm its submission. A service worker
    // suspended during that wait strands the Hub in browser_claimed.
    // The Send button was already clicked exactly once in prepareComposer().
    // Return immediately. Background reconciles the submitted turn with a
    // READ-ONLY RECOVER_SEND and never clicks Send again on uncertainty.
    if (!matches(message) || current.stage === 'cancelled')
      return { ok: false, reason: 'cancelled_during_send', pageId };
    const evidence = sendEvidence();
    if (evidence?.ok === false) return { ...evidence, pageId };
    if (evidence?.ok === true) return { ok: true, state: 'confirmed', pageId, url: url() };
    return { ok: true, state: 'clicked_unverified', pageId, url: url() };
  }

  async function check(message) {
    if (!matches(message) || !['sent', 'reply'].includes(current.stage)) return { ok: false, reason: 'tab_reloaded_or_turn_missing', pageId };
    const route = routeStatus();
    if (route === 'blocked') return { ok: false, reason: routeFailure(), pageId };
    if (route === 'pending') return { ok: true, state: 'waiting', pageId };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: true, state: 'network_waiting', pageId };
    const blocker = interruption();
    if (blocker) return { ok: false, reason: blocker, pageId };
    const user = ownUser();
    const users = authored('user');
    if (user && users.some(element => element !== user && after(element, user))) return { ok: false, reason: 'user_intervened_in_owned_chat', pageId };
    // When the normal user bubble is collapsed/virtualized, a matching
    // assistant command is the only permitted fallback. Never use it if a
    // different visible user message exists.
    const witness = !user && current.boundViaReply ? replyWitness() : null;
    if (witness?.node && users.some(element => after(element, witness.node)))
      return { ok: false, reason: 'user_intervened_in_owned_chat', pageId };
    if (witness?.ambiguous) return { ok: false, reason: 'ambiguous_task_reply', pageId };
    if (!user && !witness) return { ok: false, reason: 'own_submitted_message_missing', pageId };
    const composer = input().element;
    // An unsent draft does not change the conversation. Leave it in place
    // while collecting this reply; the next PREPARE replaces it as authorized.
    if (stops().length) { current.stopSeen = true; current.stableText = null; return { ok: true, state: 'busy', pageId }; }
    const author = user ? authored('assistant').filter(element => after(element, user)).at(-1) : null;
    if (!author && !witness) {
      // With intermittent LAN a response may not arrive within 60 seconds.
      // Do not abandon or regenerate it: the user can cancel explicitly.
      return { ok: true, state: 'waiting', pageId };
    }
    // In a current UI without author markers, a *complete* JSON reply with a
    // matching per-task nonce is used after a quiet interval and with no Stop
    // control visible. This never treats arbitrary stable prose as a command.
    const idle = witness ? Date.now() - current.sentAt >= 4500 :
      (author.getAttribute('aria-busy') === 'false' || (composer && current.stopSeen));
    if (!idle || (author && author.getAttribute('aria-busy') === 'true')) {
      // A stalled stream after LAN loss is not a definitive completion error.
      return { ok: true, state: 'waiting', pageId };
    }
    const reply = witness ? { text: witness.raw, blocks: [witness.raw] } : extractReply(author);
    if (reply.reason) return { ok: false, reason: reply.reason, pageId };
    if (!reply.text.trim()) return { ok: true, state: 'waiting', pageId };
    const canonical = JSON.stringify(reply);
    if (canonical !== current.stableText) { current.stableText = canonical; current.stableSince = Date.now(); return { ok: true, state: 'stabilizing', pageId }; }
    if (Date.now() - current.stableSince < (witness ? 4000 : STABLE_MS)) return { ok: true, state: 'stabilizing', pageId };
    if (current.turn === 1 && routes.parse(url())?.provisional) {
      // Do not execute the first result while bound to an unsaved local ID.
      // Its canonical URL may arrive after the answer becomes idle. Sending
      // again would duplicate the prompt, so only wait for this saved route.
      current.provisionalReplySince ??= Date.now();
      if (Date.now() - current.provisionalReplySince >= CANONICAL_ROUTE_WAIT_MS) return { ok: false, reason: 'local_conversation_not_saved: ChatGPT vẫn giữ địa chỉ cuộc chat tạm sau 60 giây kể từ khi câu trả lời ổn định. Giữ tab để kiểm tra; prompt không được gửi lại. [companion=1.5.0]', pageId };
      return { ok: true, state: 'waiting_for_canonical_url', pageId };
    }
    current.routeLocked = true; current.stage = 'reply'; current.replyWitnessVerified = Boolean(witness);
    const replyId = 'reply-' + await hash(current.messageId + '\n' + canonical);
    if (!matches(message) || current.stage !== 'reply') return { ok: false, reason: 'reply_state_changed', pageId };
    if (routeStatus() !== 'ok') return { ok: false, reason: routeFailure(), pageId };
    if (user) {
      if (ownUser() !== user || authored('user').some(element => element !== user && after(element, user))) return { ok: false, reason: 'user_intervened_in_owned_chat', pageId };
    } else {
      const finalWitness = replyWitness();
      if (!finalWitness || finalWitness.ambiguous ||
          authored('user').some(element => after(element, finalWitness.node)))
        return { ok: false, reason: 'reply_witness_lost', pageId };
    }
    return { ok: true, state: 'reply', pageId, replyId, text: reply.text, blocks: reply.blocks, url: url(), initialRouteBinding: current.turn === 1 };
  }

  // READ-ONLY after any lost send acknowledgement. The browser worker must
  // never call SEND again for a turn that could already have been submitted.
  // A reloaded content script may reattach only using an exact task message or
  // the assistant's authenticated task/turn/nonce witness in the *owned* tab.
  function recoverSend(message) {
    if (typeof message.taskId !== 'string' || typeof message.messageId !== 'string' ||
        !Number.isInteger(message.turn) || message.turn < 1 ||
        typeof message.text !== 'string' || !message.text.trim() ||
        !/^[0-9a-f]{48}$/i.test(message.nonce || '') || !message.text.includes(message.nonce))
      return { ok: false, reason: 'recovery_invalid_identity', pageId };
    const parsed = routes.parse(url());
    if (!parsed || parsed.kind !== 'chat') return { ok: true, state: 'waiting', reason: 'chat_route_not_ready', pageId };
    if (current && (current.taskId !== message.taskId || current.messageId !== message.messageId ||
        current.turn !== message.turn || current.nonce !== message.nonce ||
        current.promptNormalized !== normalized(message.text)))
      return { ok: false, reason: 'recovery_wrong_turn_or_tab', pageId };
    let reconstructed = false;
    if (!current) {
      // Page reloads reset the content script. Without an exact identity proof
      // do not reconstruct state, and especially do not resend a draft.
      current = {
        taskId: message.taskId, messageId: message.messageId, nonce: message.nonce,
        turn: message.turn, text: message.text, promptNormalized: normalized(message.text),
        route: parsed.path, routeLocked: true, stage: 'sending',
        routePendingSince: null, provisionalReplySince: null,
        previousPromptNormalized: null, previousWitnessBound: false, previousWitnessNode: null,
        ownedDraftValue: null, stopSeen: false,
        sentAt: Date.now() - 10000, stableText: null, stableSince: 0,
        confirmedUser: false, boundViaReply: false, replyWitnessVerified: false
      };
      reconstructed = true;
    }
    const own = ownUser();
    const users = authored('user');
    const witness = !own ? replyWitness() : null;
    if (witness?.ambiguous || (own && users.some(element => element !== own && after(element, own))) ||
        (witness?.node && users.some(element => after(element, witness.node)))) {
      if (reconstructed) current = null;
      return { ok: false, reason: 'recovery_foreign_or_ambiguous_message', pageId };
    }
    if (!own && !witness) {
      if (reconstructed) current = null;
      return { ok: true, state: 'waiting', reason: 'submitted_message_not_yet_verifiable', pageId };
    }
    if (routeStatus() !== 'ok') {
      if (reconstructed) current = null;
      return { ok: true, state: 'waiting', reason: 'conversation_route_pending', pageId };
    }
    if (current.stage === 'cancelled' || current.stage === 'failed')
      return { ok: false, reason: 'recovery_generation_cancelled', pageId };
    current.confirmedUser = true;
    current.boundViaReply = !own;
    current.stage = 'sent';
    // A recovered turn stays bound to this exact page and cannot open a new
    // chat. Reply extraction still independently validates the nonce at Hub.
    return { ok: true, state: 'confirmed', pageId, url: url(), recovered: reconstructed };
  }

  // Recovery is read-only and explicitly requested by the user in ChatMCP.
  // A browser tab is eligible only when its OFFICIAL /c/... URL and visible
  // task/nonce evidence identify the same earlier prompt or assistant reply.
  function verifyOfficialChatUrl(message) {
    const route=routes.parse(url());
    if(route?.kind!=='chat'||route.provisional)
      return {ok:false,reason:'official_chat_url_not_ready',pageId};
    if(typeof message.taskId!=='string'||!/^[0-9a-f]{48}$/i.test(message.nonce||''))
      return {ok:false,reason:'invalid_recovery_identity',pageId};
    const users=authored('user').filter(node=>{
      const content=normalized(plain(node));
      return content.includes(message.taskId)&&content.includes(message.nonce);
    });
    let witnessed=false;
    for(const node of elements('pre,[data-markdown-copy="code-block"]')){
      if(node.closest('[data-message-author-role="user"],[data-testid="user-message"],form,blockquote,[contenteditable="true"]'))
        continue;
      const text=node.textContent||'';
      if(text.length>25000||!text.includes(message.taskId)||!text.includes(message.nonce))continue;
      const start=text.indexOf('{'),end=text.lastIndexOf('}');
      if(start<0||end<start)continue;
      try{
        const item=JSON.parse(text.slice(start,end+1));
        if(item?.chatmcp_hub==='v1'&&item.task===message.taskId&&
            item.nonce===message.nonce&&Number.isInteger(item.turn)&&item.turn>=1)
          witnessed=true;
      }catch{}
    }
    if(users.length===1)return {ok:true,url:url(),pageId,proof:'user_task_nonce'};
    if(users.length>1)return {ok:false,reason:'ambiguous_owned_chat',pageId};
    if(witnessed)return {ok:true,url:url(),pageId,proof:'assistant_task_nonce'};
    return {ok:false,reason:'task_nonce_not_visible',pageId};
  }

  function cancel(message) {
    if (!matches(message)) return { ok: true, pageId };
    const user = ownUser();
    const ownGeneration = ['sent', 'sending'].includes(current.stage) && current.confirmedUser && routeStatus() === 'ok' && user && !authored('user').some(element => element !== user && after(element, user));
    current.stage = 'cancelled';
    if (message.stopGeneration === true && ownGeneration) {
      const buttons = stops();
      if (buttons.length === 1) buttons[0].click();
    }
    return { ok: true, pageId };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender?.id !== chrome.runtime.id || sender.tab || (sender.url && !sender.url.startsWith(chrome.runtime.getURL('')))) return false;
    if (!['CHATMCP_BROWSER_PREPARE', 'CHATMCP_BROWSER_SEND', 'CHATMCP_BROWSER_CHECK', 'CHATMCP_BROWSER_RECOVER_SEND', 'CHATMCP_BROWSER_VERIFY_OFFICIAL_URL', 'CHATMCP_BROWSER_CANCEL'].includes(message?.type)) return false;
    const work = message.type === 'CHATMCP_BROWSER_PREPARE' ? prepare(message) : message.type === 'CHATMCP_BROWSER_SEND' ? send(message) : message.type === 'CHATMCP_BROWSER_CHECK' ? check(message) : message.type === 'CHATMCP_BROWSER_RECOVER_SEND' ? Promise.resolve(recoverSend(message)) : message.type==='CHATMCP_BROWSER_VERIFY_OFFICIAL_URL'?Promise.resolve(verifyOfficialChatUrl(message)):Promise.resolve(cancel(message));
    work.then(respond, () => respond({ ok: false, reason: 'browser_dom_operation_failed', pageId }));
    return true;
  });
  window.addEventListener?.('online', () => {
    chrome.runtime.sendMessage({ type: 'CHATMCP_BROWSER_TICK', restored: true }).catch(() => {});
  });
  setInterval(() => {
    if (current && ['prepared', 'send_preparing', 'sending', 'sent', 'reply'].includes(current.stage)) {
      if (stops().length) current.stopSeen = true;
      chrome.runtime.sendMessage({ type: 'CHATMCP_BROWSER_TICK' }).catch(() => {});
    }
  }, 1500);
})();
