(() => {
  'use strict';
  const HUB = 'http://127.0.0.1:3007';
  const PAIR_KEY = 'chatmcpBrowserPairV1';
  const JOURNAL_KEY = 'chatmcpBrowserJournalV1';
  const ALARM = 'chatmcp-browser-poll';
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'limit', 'paused']);
  const UNCERTAIN = new Set(['claiming', 'claimed', 'sending', 'reconciling']);
  const ENDPOINTS = new Set(['pair', 'poll', 'claim', 'sent', 'reply', 'fail', 'recover-url']);
  let pair = null, journal = null, lastNote = 'Chưa ghép với Hub.', lastContact = null;
  let ticking = false, epoch = 0, scheduled = null, networkFailures = 0;
  let persistence = Promise.resolve();
  let bootPromise;

  const ownPopup = sender => sender?.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('popup.html');
  const safeChatUrl = value => globalThis.__chatmcpChatRoute.normalize(value);
  const topChat = sender => sender?.id === chrome.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && safeChatUrl(sender.url);
  const topHub = sender => {
    try { const url = new URL(sender.url); return sender.id === chrome.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && url.origin === HUB && url.pathname === '/'; }
    catch { return false; }
  };
  const active = () => journal && !['terminal', 'failed'].includes(journal.phase);
  const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
  const serialSize = value => new TextEncoder().encode(JSON.stringify(value)).length;

  function persist(work) {
    const pending = persistence.then(work);
    persistence = pending.catch(() => {});
    return pending;
  }
  async function savePair() { const value = structuredClone(pair); await persist(() => chrome.storage.local.set({ [PAIR_KEY]: value })); }
  async function saveJournal() { const value = structuredClone(journal); await persist(() => chrome.storage.local.set({ [JOURNAL_KEY]: value })); }
  const isCurrent = (record, ownEpoch) => ownEpoch === epoch && journal === record;
  async function boot() {
    // Content scripts never receive the Hub capability token, including through
    // chrome.storage. No ChatGPT credential is read, stored or requested.
    await chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    const saved = await chrome.storage.local.get([PAIR_KEY, JOURNAL_KEY]);
    pair = saved[PAIR_KEY] || null;
    journal = saved[JOURNAL_KEY] || null;
    if (pair && (!uuid(pair.clientId) || typeof pair.token !== 'string' || pair.token.length < 16)) pair = null;
    if (journal && (!uuid(journal.taskId) || typeof journal.messageId !== 'string' || typeof journal.phase !== 'string')) journal = null;
    if (journal && journal.phase === 'sending') {
      // SEND may have clicked before service worker was suspended. Reconcile
      // the original turn using read-only DOM evidence; NEVER send again.
      journal.phase = 'reconciling';
      await saveJournal();
    }
    if (pair) {
      const alarm = await chrome.alarms.get(ALARM);
      if (!alarm) await chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
      lastNote = pair.authFailed ? 'Ghép nối không còn hợp lệ. Lấy mã mới trên Hub.' : 'Đã ghép; đang chờ yêu cầu từ localhost.';
    }
  }
  function ready() { return bootPromise ||= boot(); }
  function schedule(ms = 1200) {
    if (!pair || pair.authFailed) return;
    if (scheduled) {
      if (ms > 0) return; // Keep the current backoff.
      clearTimeout(scheduled); // A verified online/wake event overrides it.
      scheduled = null;
    }
    scheduled = setTimeout(() => { scheduled = null; void tick(); }, ms);
  }
  function waitForConnection(detail = '') {
    networkFailures = Math.min(networkFailures + 1, 5);
    lastNote = 'Đang chờ mạng hoặc tab ChatGPT kết nối lại. Tác vụ được giữ nguyên; không gửi lại lượt chưa xác minh.' +
      (detail ? ' ' + String(detail).slice(0, 110) : '');
  }
  function networkBackoffMs() { return networkFailures ? Math.min(30000, 1500 * (2 ** networkFailures)) : 1200; }

  async function api(endpoint, body, authentication = pair) {
    if (!ENDPOINTS.has(endpoint)) throw new Error('invalid_endpoint');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (endpoint !== 'pair') {
        if (!authentication?.token || authentication.authFailed) throw new Error('pairing_required');
        headers.Authorization = 'Bearer ' + authentication.token;
        body = { ...body, clientId: authentication.clientId };
      }
      const response = await fetch(HUB + '/api/browser/clients/' + endpoint, {
        method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal
      });
      if (!response.ok) throw new Error('hub_http_' + response.status);
      const text = await response.text();
      if (new TextEncoder().encode(text).length > 3 * 1024 * 1024) throw new Error('hub_response_too_large');
      const value = JSON.parse(text);
      lastContact = Date.now();
      return value;
    } finally { clearTimeout(timer); }
  }

  async function toTab(type, extra = {}, record = journal) {
    if (!Number.isInteger(record?.tabId)) throw new Error('owned_tab_missing');
    // Bound the extension-side IPC wait. Even a delayed SEND acknowledgement
    // MUST NOT authorize a second click. The caller switches to read-only
    // reconciliation when the result cannot be confirmed.
    let timer;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(record.tabId, { type, taskId: record.taskId, messageId: record.messageId, pageId: record.pageId || null, ...extra }, { frameId: 0 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned_tab_response_timeout')), 12000); })
      ]);
    } finally { clearTimeout(timer); }
  }

  async function fail(reason, record = journal, ownEpoch = epoch) {
    if (!record || !isCurrent(record, ownEpoch) || record.phase === 'terminal') return;
    const authentication = pair;
    record.phase = 'failed'; record.reason = String(reason).slice(0, 500); record.failurePending = true;
    delete record.reply;
    lastNote = record.reason;
    await saveJournal();
    if (!isCurrent(record, ownEpoch)) return;
    try { await toTab('CHATMCP_BROWSER_CANCEL', { stopGeneration: false }, record); } catch {}
    if (!isCurrent(record, ownEpoch)) return;
    try {
      await api('fail', { taskId: record.taskId, messageId: record.messageId, reason: record.reason }, authentication);
      if (!isCurrent(record, ownEpoch)) return;
      record.failurePending = false; await saveJournal();
    } catch { /* Retry only the idempotent failure report, never claim/send. */ }
  }

  async function end(status) {
    const record = journal, ownEpoch = epoch;
    if (!record || record.phase === 'terminal') return;
    try { await toTab('CHATMCP_BROWSER_CANCEL', { stopGeneration: status === 'cancelled' }, record); } catch {}
    if (!isCurrent(record, ownEpoch)) return;
    record.phase = 'terminal'; record.status = status; record.failurePending = false;
    delete record.reply;
    await saveJournal();
    lastNote = 'Phiên kết thúc: ' + status + '.';
  }

  async function acknowledgeSent() {
    const record = journal, ownEpoch = epoch;
    if (record.sentAck) return;
    await api('sent', { taskId: record.taskId, messageId: record.messageId, url: record.url });
    if (!isCurrent(record, ownEpoch)) return;
    record.sentAck = true; await saveJournal();
  }
  async function deliverReply() {
    const record = journal, ownEpoch = epoch;
    if (!record.reply) throw new Error('reply_record_missing');
    const result = await api('reply', record.reply);
    if (!isCurrent(record, ownEpoch)) return;
    if (result?.accepted !== true) throw new Error('reply_not_accepted');
    record.phase = 'replied'; delete record.reply; await saveJournal();
    lastNote = 'Đã chuyển câu trả lời về Hub; đang chờ công cụ hoặc bước tiếp theo.';
  }

  async function markSent(record, result, ownEpoch) {
    if (!isCurrent(record, ownEpoch)) return;
    const url = safeChatUrl(result?.url);
    if (!url || typeof result.pageId !== 'string') {
      waitForConnection('Đã thấy dấu hiệu gửi nhưng URL/tab chưa xác minh.');
      return;
    }
    record.phase = 'sent'; record.pageId = result.pageId;
    record.url = url; record.sentAck = false;
    await saveJournal();
    if (!isCurrent(record, ownEpoch) || record.phase !== 'sent') return;
    networkFailures = 0;
    lastNote = 'Đã xác minh lượt gửi trước đó; tự tiếp tục chờ câu trả lời.';
    await acknowledgeSent();
  }

  async function sendClaimed(record, message, ownEpoch) {
    if (!isCurrent(record, ownEpoch) || record.phase !== 'claimed') return;
    // Persist BEFORE the sole SEND. On restart/transport uncertainty this
    // phase becomes 'reconciling', and never causes an automatic second click.
    record.phase = 'sending'; await saveJournal();
    lastNote = 'Đã yêu cầu tab ChatGPT bấm Gửi đúng một lần; đang đợi xác nhận.';
    if (!isCurrent(record, ownEpoch) || record.phase !== 'sending') return;
    let sent;
    try { sent = await toTab('CHATMCP_BROWSER_SEND', {}, record); }
    catch {
      if (!isCurrent(record, ownEpoch)) return;
      record.phase = 'reconciling'; await saveJournal();
      waitForConnection('Đang kiểm tra lượt đã bấm Gửi qua tab đang mở.');
      return;
    }
    if (!isCurrent(record, ownEpoch) || record.phase !== 'sending') return;
    if (sent?.ok === false && sent.retryable === true) {
      // The content script positively confirms the Send button was NOT clicked.
      record.phase = 'claimed'; await saveJournal();
      waitForConnection('Chưa thể bấm Gửi (offline, tab bận hoặc nút chưa sẵn sàng); sẽ thử khi sẵn sàng.');
      return;
    }
    if (sent?.ok && sent.state !== 'waiting' && sent.state !== 'clicked_unverified' && sent.pageId === record.pageId && safeChatUrl(sent.url)) {
      await markSent(record, sent, ownEpoch); return;
    }
    // Even a failed SEND response could be delivered after a real click.
    // Only a read-only recovery can justify moving to 'sent'.
    record.phase = 'reconciling'; await saveJournal();
    waitForConnection('Đang đối chiếu tin nhắn đã gửi; không bấm Gửi lần hai.');
  }

  async function claimThenSend(record, message, ownEpoch) {
    if (!isCurrent(record, ownEpoch) || record.phase !== 'claiming') return;
    let claim;
    try { claim = await api('claim', { taskId: message.taskId, messageId: message.id }); }
    catch (error) {
      if (!isCurrent(record, ownEpoch)) return;
      // 'claim' is idempotent for THIS already-claimed client+message in Hub.
      // An HTTP ack can disappear after claim succeeds, so retry the claim
      // after connectivity returns instead of creating another message.
      if (/^hub_http_4/.test(String(error.message))) throw error;
      waitForConnection('Đang chờ xác nhận đã nhận lượt từ Hub.'); return;
    }
    if (!isCurrent(record, ownEpoch) || record.phase !== 'claiming') return;
    if (claim?.ok !== true || claim.message?.id !== message.id ||
        claim.message?.taskId !== message.taskId || claim.message?.turn !== message.turn ||
        claim.message?.text !== message.text) {
      await fail('claim_mismatch: Nội dung đã đổi hoặc bước không còn hợp lệ.', record, ownEpoch);
      return;
    }
    if (claim.alreadySent === true) {
      record.phase = 'reconciling'; await saveJournal();
      lastNote = 'Hub đã ghi nhận lượt Gửi; đang đối chiếu với tab.'; return;
    }
    record.phase = 'claimed'; await saveJournal();
    lastNote = 'Hub đã nhận gói; chuẩn bị gửi vào tab ChatGPT dành cho tác vụ.';
    await sendClaimed(record, message, ownEpoch);
  }

  async function reconcileSend(record, message, ownEpoch) {
    if (!isCurrent(record, ownEpoch) || record.phase !== 'reconciling') return;
    let evidence;
    try {
      evidence = await toTab('CHATMCP_BROWSER_RECOVER_SEND', {
        turn: message.turn, text: message.text, nonce: message.nonce,
        // Allow the exact owned tab to reattach after a content-script reload.
        // No click or draft modification is performed by this message type.
        pageId: null
      }, record);
    } catch { waitForConnection('Chưa đọc được tab ChatGPT để xác nhận lượt trước.'); return; }
    if (!isCurrent(record, ownEpoch) || record.phase !== 'reconciling') return;
    if (evidence?.ok === true && evidence.state === 'confirmed') {
      await markSent(record, evidence, ownEpoch); return;
    }
    if (evidence?.ok === false && /recovery_wrong_turn_or_tab|recovery_foreign_or_ambiguous_message/.test(evidence.reason || '')) {
      await fail('recovery_conflict: Tab chứa tin nhắn hoặc mã phiên không thuộc lượt đang chờ.', record, ownEpoch);
      return;
    }
    // No proof is not permission to resend. Poll again until an exact user
    // bubble or task/turn/nonce assistant witness appears after reconnection.
    waitForConnection(evidence?.reason === 'submitted_message_not_yet_verifiable'
      ? 'Không thấy bằng chứng đã gửi; nếu tab bị tải lại trước lúc gửi, cần kiểm tra thủ công.'
      : 'Đang đợi bằng chứng của lượt đã gửi trong tab tác vụ.');
  }

  // Fixed categories only. Do not persist exception text, prompts, DOM text,
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
  async function prepareAndSend(message, instanceId, ownEpoch) {
    if (ownEpoch !== epoch) return;
    if (!journal || journal.taskId !== message.taskId || journal.messageId !== message.id) {
      const sameTask = journal?.taskId === message.taskId;
      if (sameTask && !['replied', 'terminal'].includes(journal.phase)) return;
      journal = { taskId: message.taskId, messageId: message.id, turn: message.turn, phase: 'preparing', tabId: sameTask ? journal.tabId : null, pageId: sameTask ? journal.pageId : null, instanceId, preparedAt: Date.now(), sentAck: false };
      await saveJournal();
    }
    const record = journal;
    const atPhase = phase => isCurrent(record, ownEpoch) && record.phase === phase;
    if (!atPhase('preparing')) return;
    const resumeUrl = message.resumeUrl ? safeChatUrl(message.resumeUrl) : null;
    if (message.resumeUrl && (!resumeUrl || globalThis.__chatmcpChatRoute.parse(resumeUrl)?.kind !== 'chat')) {
      await fail('resume_chat_invalid: Không có URL cuộc chat cũ hợp lệ.'); return;
    }
    let tab = Number.isInteger(record.tabId) ? await chrome.tabs.get(record.tabId).catch(()=>null) : null;
    if (resumeUrl && tab && safeChatUrl(tab.url) !== resumeUrl) tab = null;
    if (!tab && resumeUrl) {
      // Reuse the original chat tab if still open, otherwise open the exact
      // saved conversation URL. NEVER fall back to the blank home/new chat.
      const existing = await chrome.tabs.query({url:'https://chatgpt.com/c/*'});
      tab = existing.find(candidate => safeChatUrl(candidate.url) === resumeUrl) ||
        await chrome.tabs.create({url:resumeUrl,active:true});
    }
    if (!tab && !resumeUrl) tab = await chrome.tabs.create({url:'https://chatgpt.com/',active:true});
    if (!atPhase('preparing')) return;
    if (!Number.isInteger(tab?.id)) throw new Error('cannot_find_or_open_chat_tab');
    if (record.tabId !== tab.id) { record.tabId = tab.id; record.pageId = null; await saveJournal(); }
    if (!atPhase('preparing')) return;
    if (tab.status === 'loading') { lastNote = resumeUrl ? 'Đang mở lại đúng cuộc chat cũ.' : 'Đang mở tab ChatGPT dành riêng cho tác vụ.'; return; }
    if (!safeChatUrl(tab.url) || (resumeUrl && safeChatUrl(tab.url) !== resumeUrl)) {
      await fail('owned_tab_navigated: Tab không còn ở đúng cuộc chat đã lưu. Không mở chat mới.'); return;
    }
    let prepared;
    try { prepared = await toTab('CHATMCP_BROWSER_PREPARE', { turn: message.turn, text: message.text, nonce: message.nonce, resumeUrl, resumeStart: message.resumeStart === true }, record); }
    catch (error) {
      if (!atPhase('preparing')) return;
      const code = receiverCode(error);
      waitForConnection();
      lastNote = `[${code}] Chưa liên lạc được với Companion trong tab ChatGPT. Kiểm tra quyền truy cập trang và tải lại extension/tab.`;
      if (code === 'receiver_missing') await restoreReceiver(record, ownEpoch);
      return;
    }
    if (!atPhase('preparing')) return;
    if (!prepared?.ok) {
      if (prepared?.reason === 'network_offline') { waitForConnection('ChatGPT báo offline trước khi gửi.'); return; }
      if (prepared?.retryable) {
        waitForConnection();
        lastNote = `[${readinessCode(prepared.reason)}] Chưa chuẩn bị được ô nhập/nút Gửi. Giữ tab ChatGPT mở; kiểm tra đăng nhập và cập nhật Companion.`;
        return;
      }
      await fail(prepared?.reason || 'unknown_chat_dom'); return;
    }
    if (typeof prepared.pageId !== 'string' || !safeChatUrl(prepared.url)) { await fail('invalid_prepare_response'); return; }
    record.pageId = prepared.pageId;
    // Claim is retryable only because the Hub now recognizes an idempotent
    // claim for the same client and message. SEND itself is never replayed.
    record.phase = 'claiming'; await saveJournal();
    if (!atPhase('claiming')) return;
    await claimThenSend(record, message, ownEpoch);
  }

  async function recoverOfficialChat(recovery,ownEpoch) {
    // No send, no text entry, and no retry of an old tool. Search only browser
    // tabs the user has opened at the ChatGPT host. A single verified nonce
    // witness is mandatory; two matches are ambiguous and are not bound.
    if(!uuid(recovery?.taskId)||!/^[0-9a-f]{48}$/i.test(recovery?.nonce||''))return;
    const candidates=[];
    if(journal?.taskId===recovery.taskId&&Number.isInteger(journal.tabId)) {
      const owned=await chrome.tabs.get(journal.tabId).catch(()=>null);
      if(owned)candidates.push(owned);
    }
    const incomplete = () => { lastNote = '[recovery_scan_incomplete] Chưa xác minh đủ các tab. Giữ tab cũ mở, tải lại tab chưa phản hồi rồi thử lại; không gắn URL khi thiếu bằng chứng.'; };
    let tabs;
    try { tabs = await chrome.tabs.query({url:'https://chatgpt.com/*'}); }
    catch { incomplete(); return; }
    const official = tab => {
      const route = globalThis.__chatmcpChatRoute.parse(safeChatUrl(tab.url));
      return route?.kind === 'chat' && !route.provisional;
    };
    // Do not silently truncate the candidate set and then claim uniqueness.
    tabs = tabs.filter(official);
    if (tabs.length > 30) { incomplete(); return; }
    for(const tab of tabs)
      if(Number.isInteger(tab.id)&&!candidates.some(t=>t.id===tab.id))candidates.push(tab);
    const eligible=[];
    const deadline = Date.now() + 4000;
    for(const tab of candidates){
      if (ownEpoch !== epoch) return;
      if (Date.now() >= deadline) {
        incomplete();
        return; // Never bind a URL from a partial scan.
      }
      const actual=safeChatUrl(tab.url);
      if(!actual||globalThis.__chatmcpChatRoute.parse(actual)?.kind!=='chat'||
        globalThis.__chatmcpChatRoute.parse(actual)?.provisional)continue;
      let proof, timer;
      try{
        proof=await Promise.race([chrome.tabs.sendMessage(tab.id,{
          type:'CHATMCP_BROWSER_VERIFY_OFFICIAL_URL',taskId:recovery.taskId,
          nonce:recovery.nonce,turn:recovery.turn,
        },{frameId:0}), new Promise(resolve => {
          timer = setTimeout(() => resolve(null), Math.max(1, Math.min(1000, deadline - Date.now())));
        })]);
      }catch{incomplete();return;}finally{clearTimeout(timer);}
      if (ownEpoch !== epoch) return;
      // Null/timeout/ambiguous/unknown responses are not negative evidence.
      if (!proof || (proof.ok !== true &&
          !(proof.ok === false && proof.reason === 'task_nonce_not_visible'))) {
        incomplete(); return;
      }
      if (proof.ok === true && (proof.url !== actual ||
          !['user_task_nonce','assistant_task_nonce'].includes(proof.proof))) {
        incomplete(); return;
      }
      if(proof?.ok===true&&proof.url===actual&&
        ['user_task_nonce','assistant_task_nonce'].includes(proof.proof))
        eligible.push({url:actual,proof:proof.proof});
    }
    const distinct=[...new Map(eligible.map(x=>[x.url,x])).values()];
    if(distinct.length!==1){
      lastNote=distinct.length?'Nhiều tab cùng xác minh task; cần đóng tab trùng và thử lại.':
        'Chưa thấy tab ChatGPT có URL chính thức và mã task/nonce chính xác. Mở lại tab cũ rồi chờ.';
      return;
    }
    if(ownEpoch!==epoch)return;
    try{
      const result=await api('recover-url',{
        taskId:recovery.taskId,nonce:recovery.nonce,
        url:distinct[0].url,proof:distinct[0].proof,
      });
      if(result?.ok===true)lastNote='Đã khôi phục URL chat chính thức, bạn có thể Tiếp tục trên tab cũ.';
    }catch(error){
      lastNote='Không thể xác minh URL chat chính thức: '+String(error.message||error).slice(0,80);
    }
  }

  async function tick() {
    await ready();
    if (ticking || !pair || pair.authFailed) return;
    ticking = true;
    const ownEpoch = epoch;
    try {
      const poll = await api('poll', { taskId: journal?.taskId || null, phase: journal?.phase || 'idle', note: lastNote.slice(0, 250) });
      if (ownEpoch !== epoch) return;
      if (!poll || typeof poll.instanceId !== 'string') throw new Error('invalid_poll_response');
      // A recovery for an older task must never starve a queued packet or
      // interrupt reconciliation of an uncertain SEND. Keep idle recovery.
      const hasLiveTask = poll.task && !TERMINAL.has(poll.task.status);
      if(poll.recovery && !hasLiveTask){
        await recoverOfficialChat(poll.recovery,ownEpoch);
        return;
      }
      const task = poll.task;
      if (!task || TERMINAL.has(task.status)) {
        if (journal && (!task || journal.taskId === task.id)) await end(task?.status || 'interrupted');
        return;
      }
      if (!uuid(task.id)) throw new Error('invalid_task');
      // An EXPLICIT user-authorized follow-up can reopen the SAME ChatGPT
      // conversation after the previous run finished/failed or Hub restarted.
      // A different queued messageId and a matching persisted chat URL are
      // mandatory. Do not replay any unfinished SEND from the old journal.
      const nextMessage = poll.message;
      const originalChat = safeChatUrl(task.chatUrl);
      const requestedChat = nextMessage?.resumeUrl ? safeChatUrl(nextMessage.resumeUrl) : null;
      const explicitContinuation = journal?.taskId === task.id && nextMessage?.resumeStart === true &&
        nextMessage?.id && nextMessage.id !== journal.messageId &&
        Number.isSafeInteger(nextMessage.turn) && nextMessage.turn > journal.turn &&
        requestedChat && requestedChat === originalChat &&
        globalThis.__chatmcpChatRoute.parse(requestedChat)?.kind === 'chat' &&
        globalThis.__chatmcpChatRoute.parse(requestedChat)?.provisional !== true;
      if (explicitContinuation) {
        // Cancel only our content-script ownership of the OLD turn; never
        // stop the user's ChatGPT generation and never click Send again.
        const prior = journal;
        try { await toTab('CHATMCP_BROWSER_CANCEL', { stopGeneration: false }, prior); } catch {}
        if (ownEpoch !== epoch || journal !== prior) return;
        prior.phase = 'terminal'; prior.failurePending = false; prior.status = 'continued';
        delete prior.reply;
        await saveJournal();
        if (ownEpoch !== epoch) return;
        lastNote = 'Tiếp tục đúng hội thoại cũ; đã bỏ trạng thái nhận/gửi của lượt trước mà không phát lại.';
      }
      if (journal?.taskId === task.id && journal.instanceId !== poll.instanceId && active()) { await fail('hub_restarted: Phiên Hub đã thay đổi; không tự gửi lại bước cũ.'); return; }
      if (journal?.taskId === task.id && journal.phase === 'failed') {
        if (journal.failurePending) await fail(journal.reason);
        return;
      }
      if (journal?.taskId === task.id && UNCERTAIN.has(journal.phase)) {
        const record = journal;
        const message = poll.message;
        if (!message || message.id !== record.messageId || message.taskId !== task.id) {
          lastNote = 'Đang đợi Hub xác nhận đúng lượt đang xử lý; không gửi lại tin.';
          return;
        }
        if (record.phase === 'sending') {
          record.phase = 'reconciling'; await saveJournal();
        }
        if (!isCurrent(record, ownEpoch)) return;
        if (record.phase === 'claiming') await claimThenSend(record, message, ownEpoch);
        else if (record.phase === 'claimed') await sendClaimed(record, message, ownEpoch);
        else if (record.phase === 'reconciling') await reconcileSend(record, message, ownEpoch);
        return;
      }
      if (journal?.taskId === task.id && journal.phase === 'sent') {
        const record = journal;
        await acknowledgeSent();
        if (!isCurrent(record, ownEpoch) || record.phase !== 'sent') return;
        const result = await toTab('CHATMCP_BROWSER_CHECK', {}, record);
        if (!isCurrent(record, ownEpoch) || record.phase !== 'sent') return;
        if (!result?.ok || result.pageId !== journal.pageId) {
          if (['tab_reloaded_or_turn_missing', 'own_submitted_message_missing', 'reply_witness_lost', 'browser_dom_operation_failed'].includes(result?.reason) || result?.pageId !== journal.pageId) {
            record.phase = 'reconciling'; await saveJournal();
            waitForConnection('Tab tải lại; đang xác minh lượt cũ bằng chứng trên trang.');
            return;
          }
          await fail(result?.reason || 'tab_reloaded_or_unknown_dom'); return;
        }
        if (result.state === 'reply') {
          if (typeof result.text !== 'string' || !Array.isArray(result.blocks) || result.blocks.some(block => typeof block !== 'string') || typeof result.replyId !== 'string' || result.replyId.length > 256 || !safeChatUrl(result.url)) { await fail('invalid_reply_payload'); return; }
          const reply = { taskId: journal.taskId, messageId: journal.messageId, replyId: result.replyId, text: result.text, blocks: result.blocks, url: safeChatUrl(result.url), initialRouteBinding: journal.turn === 1 && result.initialRouteBinding === true };
          if (serialSize({ ...reply, clientId: pair.clientId }) > 2 * 1024 * 1024) { await fail('reply_too_large: Câu trả lời vượt 2 MiB; không tự cắt bỏ nội dung.'); return; }
          journal.reply = reply; journal.phase = 'reply_pending'; journal.url = reply.url;
          await saveJournal();
          if (!isCurrent(record, ownEpoch) || record.phase !== 'reply_pending') return;
          await deliverReply();
        } else {
          if (result.state === 'network_waiting') waitForConnection('ChatGPT đang offline.');
          else { networkFailures = 0; lastNote = result.state === 'busy' ? 'ChatGPT đang trả lời trong tab tác vụ.' : result.state === 'waiting_for_canonical_url' ? 'Đang đợi ChatGPT lưu cuộc chat và cấp địa chỉ chính thức.' : 'Đang đợi câu trả lời kết thúc và ổn định.'; }
        }
        return;
      }
      if (journal?.taskId === task.id && journal.phase === 'reply_pending') { await deliverReply(); return; }
      const message = poll.message;
      if (!message) { lastNote = 'Đang chờ Hub/công cụ xử lý bước tiếp theo.'; return; }
      if (typeof message.id !== 'string' || !message.id || message.taskId !== task.id || !Number.isSafeInteger(message.turn) || message.turn < 1 || typeof message.text !== 'string' || !message.text.trim() || new TextEncoder().encode(message.text).length > 1024 * 1024) {
        // Bind the failure to this queued message, never a previous task.
        if (typeof message.id === 'string' && message.id && message.taskId === task.id) {
          journal = { taskId: task.id, messageId: message.id, phase: 'preparing', instanceId: poll.instanceId, tabId: journal?.taskId === task.id ? journal.tabId : null };
          await fail('invalid_queued_message');
        } else lastNote = 'Hub trả bước thiếu mã hợp lệ; chưa nhận/gửi yêu cầu.';
        return;
      }
      if (journal?.messageId === message.id && journal.phase !== 'preparing') return;
      await prepareAndSend(message, poll.instanceId, ownEpoch);
    } catch (error) {
      if (ownEpoch !== epoch) return;
      const reason = String(error?.message || 'bridge_error');
      if (reason === 'hub_http_401' || reason === 'hub_http_403') {
        pair.authFailed = true; await savePair().catch(() => {});
        lastNote = 'Ghép nối đã hết hiệu lực. Lấy mã mới trên Hub; không tự gửi thêm tin.';
      } else if (reason.startsWith('hub_http_4')) {
        await fail('hub_rejected_step: Hub không chấp nhận bước; không gửi lại tin nhắn.').catch(() => {});
      } else {
        if (journal?.phase === 'sending') {
          journal.phase = 'reconciling'; await saveJournal().catch(() => {});
        }
        // Temporary LAN loss and an unavailable content-script response are
        // indistinguishable from an acknowledgement lost AFTER one Send click.
        // Wait for the same tab to recover; never fail or click again here.
        waitForConnection('Mất kết nối hoặc mất phản hồi tạm thời; sẽ tự kiểm tra lại.');
      }
    } finally {
      ticking = false;
      if (pair && !pair.authFailed && active()) schedule(networkBackoffMs());
    }
  }

  async function pairWithHub(code) {
    await ready();
    if (active()) throw new Error('Hãy dừng tác vụ hiện tại trên Hub trước khi ghép lại.');
    if (typeof code !== 'string' || !code.trim() || code.trim().length > 128) throw new Error('Nhập mã ghép được cấp trên Hub.');
    const ownEpoch = ++epoch;
    const clientId = pair?.clientId || crypto.randomUUID();
    const result = await api('pair', { code: code.trim(), clientId, extensionId: chrome.runtime.id }, null);
    if (ownEpoch !== epoch) throw new Error('pairing_cancelled');
    if (result?.clientId !== clientId || typeof result.token !== 'string' || result.token.length < 16 || result.token.length > 4096 || /\s/.test(result.token)) throw new Error('Hub trả kết quả ghép không hợp lệ.');
    pair = { clientId, token: result.token, authFailed: false }; journal = null;
    await savePair();
    if (ownEpoch !== epoch) throw new Error('pairing_cancelled');
    await saveJournal();
    if (ownEpoch !== epoch) throw new Error('pairing_cancelled');
    await chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    if (ownEpoch !== epoch) throw new Error('pairing_cancelled');
    lastNote = 'Đã ghép. Kiểm tra tab ChatGPT mở ra đang đăng nhập và ở Chat thông thường, rồi gửi yêu cầu trên Hub.';
    await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
    if (ownEpoch !== epoch) throw new Error('pairing_cancelled');
    schedule(50);
    return publicState();
  }
  async function resetPair() {
    await ready(); epoch += 1;
    const oldPair = pair, oldJournal = journal, ownEpoch = epoch;
    pair = null; journal = null;
    clearTimeout(scheduled); scheduled = null;
    const cleanup = persist(() => chrome.storage.local.remove([PAIR_KEY, JOURNAL_KEY]));
    await chrome.alarms.clear(ALARM); await cleanup;
    if (oldJournal && !['terminal', 'failed'].includes(oldJournal.phase)) {
      try { await toTab('CHATMCP_BROWSER_CANCEL', { stopGeneration: false }, oldJournal); } catch {}
      try { await api('fail', { taskId: oldJournal.taskId, messageId: oldJournal.messageId, reason: 'pairing_reset: Người dùng ngắt ghép nối extension.' }, oldPair); } catch {}
    }
    if (ownEpoch !== epoch) return publicState();
    lastNote = 'Đã ngắt ghép. Không nhận thêm yêu cầu từ Hub.';
    return publicState();
  }
  function publicState() {
    return { paired: !!pair && !pair.authFailed, clientId: pair?.clientId || null, note: lastNote, lastContact, taskId: journal?.taskId || null, phase: journal?.phase || 'idle', chatUrl: journal?.url || null };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || sender?.id !== chrome.runtime.id) return false;
    if (ownPopup(sender) && ['CHATMCP_BROWSER_PAIR', 'CHATMCP_BROWSER_RESET', 'CHATMCP_BROWSER_STATUS'].includes(message.type)) {
      const work = message.type === 'CHATMCP_BROWSER_PAIR' ? pairWithHub(message.code) : message.type === 'CHATMCP_BROWSER_RESET' ? resetPair() : ready().then(publicState);
      work.then(state => respond({ ok: true, ...state }), () => respond({ ok: false, reason: 'Chưa thực hiện được. Kiểm tra Hub, mã ghép còn hạn và dừng tác vụ cũ nếu có.' }));
      return true;
    }
    if ((message.type === 'CHATMCP_BROWSER_WAKE' && topHub(sender)) || (message.type === 'CHATMCP_BROWSER_TICK' && topChat(sender))) {
      if (message.type === 'CHATMCP_BROWSER_TICK' && sender.tab.id === journal?.tabId && message.restored === true) networkFailures = 0;
      ready().then(() => {
        if (message.type === 'CHATMCP_BROWSER_TICK' && sender.tab.id !== journal?.tabId) return;
        schedule(message.restored === true || message.type === 'CHATMCP_BROWSER_WAKE' ? 0 : 1200);
      }).catch(() => {});
      respond({ ok: true }); return false;
    }
    return false;
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void tick(); });
  chrome.runtime.onStartup?.addListener(() => { void ready().then(() => tick()); });
  chrome.tabs.onUpdated?.addListener(tabId => { if (tabId === journal?.tabId) schedule(100); });
  chrome.tabs.onRemoved?.addListener(tabId => { if (tabId === journal?.tabId && active()) void fail('owned_tab_closed: Tab ChatGPT của tác vụ đã bị đóng.'); });
  void ready().then(() => schedule(50)).catch(() => { lastNote = 'Không đọc/lưu được ghép nối extension. Chưa nhận tác vụ.'; });
})();
