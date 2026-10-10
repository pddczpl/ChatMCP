/* ChatMCP Hub: the dashboard talks only to localhost; ChatGPT runs in its tab. */
'use strict';

(() => {
  const byId = (id) => document.getElementById(id);
  const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
  const number = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const pathInput = byId('workspace-path');
  const promptInput = byId('task-prompt');
  const serviceKeys = ['docker', 'cloud', 'proxy', 'desktop'];
  const stateLabels = { ready: 'Sẵn sàng', stopped: 'Đã dừng', starting: 'Đang khởi động', error: 'Cần kiểm tra', unknown: 'Chưa kiểm tra' };
  const taskLabels = { preparing: 'Đang chuẩn bị', queued: 'Đang chờ trình duyệt', running: 'Đang thực hiện', completed: 'Hoàn thành', failed: 'Tạm dừng do lỗi', cancelled: 'Đã dừng', interrupted: 'Bị gián đoạn', paused:'Chờ tiếp tục', limit: 'Đạt giới hạn' };
  const fallbackDetails = { docker: 'Môi trường cho Cloud Harness.', cloud: 'Kết nối workspace và công cụ Git.', proxy: 'Kết nối toàn bộ công cụ MCP cho Hub.', desktop: 'Đọc, sửa file và chạy lệnh trên Windows.' };
  let currentState = null;
  let apiInputsDirty = false;
  let online = false;
  let dirtyPath = false;
  let settingsInitialized = false;
  let pairing = null;
  let actionPending = false;
  let actionLabel = '';
  let actionEpoch = 0;
  let stateRequestPending = false;
  let copyPending = false;
  let shuttingDown = false;
  let pollTimer = null;
  let lastLogText = '';
  let selectedTaskId = null;
  let newSessionDraft = false;
  let sidebarSignature = '';
  let taskRequestId = null;
  let historySignature = '';
  let taskSignature = '';
  let catalogPending = false;
  let catalogSignature = '';
  let catalog = null;
  const taskCache = new Map();

  const workspacePath = () => text(currentState?.workspace?.path);
  const browserState = () => currentState?.browser ?? {};
  const executionMode = () => currentState?.agent?.mode === 'api' ? 'api' : 'chatgpt-web';
  const gatewayReady = () => currentState?.ai?.configured === true;
  const browserHubSupported = () => window.location.origin === 'http://127.0.0.1:3007';
  const activeTask = () => currentState?.agent?.active ?? null;
  const inProgress = (task) => ['preparing', 'queued', 'running'].includes(task?.status);
  const taskIsRunning = () => activeTask() ? inProgress(activeTask()) : Boolean(currentState?.agent?.activeTaskId);
  const isBusy = () => actionPending || currentState?.busy === true;
  const canRequest = () => online && Boolean(currentState?.csrfToken) && !actionPending && !shuttingDown;
  const canMutate = () => canRequest() && currentState?.busy !== true;
  const canConfigure = () => canMutate() && !taskIsRunning();
  const mcpReady = () => serviceKeys.every((key) => currentState?.services?.[key]?.state === 'ready');
  const taskSummaries = () => Array.isArray(currentState?.agent?.tasks) ? currentState.agent.tasks.filter((task) => task && typeof task.id === 'string') : [];

  function inputPath() {
    let value = pathInput.value.trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    return value;
  }
  const comparablePath = (value) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  function showNotice(message, error = false) {
    byId('notice-text').textContent = message;
    byId('notice').classList.toggle('notice-error', error);
    byId('notice').setAttribute('role', error ? 'alert' : 'status');
    byId('notice').hidden = false;
  }
  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  }
  function wakeBrowser() {
    // A wake hint only. The extension keeps its own paired credential.
    if (browserHubSupported()) window.postMessage({ type: 'CHATMCP_HUB_BROWSER_WAKE' }, window.location.origin);
  }
  function renderPairCode() {
    const expired = pairing && Date.now() >= pairing.expiresAt;
    if (browserState().paired === true || expired) {
      pairing = null;
      if (expired && browserState().paired !== true) showNotice('Mã ghép đã hết hạn. Bấm “Tạo mã ghép” để lấy mã mới.');
    }
    byId('pair-code-box').hidden = !pairing;
    byId('pair-code').textContent = pairing?.code ?? '';
    byId('pair-code-expiry').textContent = pairing ? `Dùng mã trước ${new Date(pairing.expiresAt).toLocaleTimeString('vi-VN')}.` : '';
    byId('copy-pair-code').disabled = !pairing || !online;
  }
  function renderBrowser() {
    const browser = browserState();
    const paired = browser.paired === true;
    const connected = paired && browser.connected === true;
    const label = connected ? 'Tiện ích đang kết nối' : paired ? 'Đã ghép · chờ trình duyệt' : 'Chưa ghép tiện ích';
    byId('browser-status-label').textContent = label;
    byId('browser-badge').textContent = connected ? 'Đang kết nối' : paired ? 'Đã ghép' : 'Chưa ghép';
    byId('browser-badge').classList.toggle('badge-ready', connected);
    byId('browser-badge').classList.toggle('badge-neutral', !connected);
    let detail = 'Ghép tiện ích ChatMCP Hub Companion với Hub trên máy này.';
    if (connected) detail = 'Hub đã nhận tín hiệu từ tiện ích. ChatGPT sẽ xử lý yêu cầu trong tab của trình duyệt.';
    else if (paired) detail = 'Đã lưu ghép nối. Mở trình duyệt có tiện ích; yêu cầu có thể xếp hàng trong lúc chờ kết nối.';
    if (browser.companionPhase === 'reconciling') detail = 'Đang chờ mạng / xác minh lượt gửi cũ. Không gửi lại tin; giữ tab tác vụ mở.';
    else if (typeof browser.companionNote === 'string' && /Đang chờ mạng|Đang đợi.*mạng|Chưa đọc được tab/.test(browser.companionNote)) detail = browser.companionNote;
    byId('browser-detail').textContent = detail;
    byId('browser-port-note').hidden = browserHubSupported();
    byId('unpair-browser').hidden = !paired;
    const isApi = executionMode() === 'api';
    byId('agent-model-label').textContent = isApi
      ? `API · ${text(currentState?.ai?.model, 'Chưa cấu hình')}`
      : connected ? 'ChatGPT web · đã nối tiện ích' : 'ChatGPT web';
    byId('agent-model-label').classList.toggle('badge-ready', isApi ? gatewayReady() : connected);
    byId('agent-model-label').classList.toggle('badge-neutral', !(isApi ? gatewayReady() : connected));
    if (!settingsInitialized) { byId('browser-settings').open = !paired; settingsInitialized = true; }
    renderPairCode();
  }


  function renderModes() {
    const isApi = executionMode() === 'api';
    byId('agent-mode').value = isApi ? 'api' : 'chatgpt-web';
    byId('api-settings').hidden = !isApi;
    byId('execution-limits').hidden = !isApi;
    byId('mode-description').textContent = isApi
      ? 'Agent gọi API trực tiếp, dùng MCP để đọc/sửa file và chạy lệnh. API có thể tính phí riêng.'
      : 'Chế độ Web giữ nguyên phiên ChatGPT hiện có, cần Companion. Không dùng API key.';
    byId('api-state-badge').textContent = gatewayReady() ? 'Đã cấu hình' : 'Cần API key';
    byId('api-state-badge').classList.toggle('badge-ready', gatewayReady());
    if (!apiInputsDirty && currentState?.ai) {
      byId('api-protocol').value = text(currentState.ai.protocol, 'gemini');
      byId('api-model').value = text(currentState.ai.model, 'gemini-2.5-flash');
      byId('api-base-url').value = text(currentState.ai.apiBaseUrl, 'https://generativelanguage.googleapis.com');
      byId('api-custom-path').value = text(currentState.ai.customPath);
      byId('api-auth-mode').value = text(currentState.ai.authMode, 'auto');
      byId('api-key-status').textContent = gatewayReady()
        ? `Key đã có (${text(currentState.ai.keySource, 'unknown')}); để trống để dùng key hiện tại. Không ghi key vào báo cáo.`
        : 'Cần nhập API key. Nếu muốn giữ qua lần khởi động lại, chọn Windows DPAPI.';
    }
    byId('background-note').textContent = isApi
      ? 'Chế độ API xử lý trong tiến trình Hub; dashboard có thể đóng nhưng phải giữ Hub đang chạy.'
      : 'Chế độ Web cần giữ Edge/Chrome và tab ChatGPT của tác vụ mở.';
  }

  function updateControls() {
    const enabled = canConfigure();
    pathInput.disabled = !enabled;
    byId('browse-workspace').disabled = !enabled;
    byId('apply-workspace').disabled = !enabled || !inputPath();
    byId('open-vscode').disabled = !canMutate() || !workspacePath();
    byId('start-services').disabled = !enabled;
    byId('stop-services').disabled = !enabled;
    byId('shutdown-hub').disabled = !enabled;
    byId('copy-url').disabled = !online || !currentState;
    byId('copy-instructions').disabled = !online || !currentState || isBusy() || copyPending;
    const downloadDisabled = !online || !currentState || isBusy();
    byId('download-instructions').setAttribute('aria-disabled', String(downloadDisabled));
    byId('download-instructions').tabIndex = downloadDisabled ? -1 : 0;
    byId('busy-banner').hidden = !isBusy();
    byId('busy-text').textContent = actionLabel || 'Hub đang cập nhật kết nối.';
    byId('workspace-form').setAttribute('aria-busy', String(isBusy()));
    const unapplied = dirtyPath && Boolean(inputPath()) && comparablePath(inputPath()) !== comparablePath(workspacePath());
    byId('path-hint').classList.toggle('is-draft', unapplied);
    byId('path-hint').textContent = taskIsRunning()
      ? 'Workspace được giữ cố định trong khi tác vụ đang chạy.'
      : unapplied ? 'Thư mục này chưa được áp dụng. Bấm “Dùng thư mục này” để chuyển workspace.'
        : 'Chọn bằng hộp thoại Windows hoặc dán đường dẫn vào đây.';

    byId('create-pair-code').disabled = !enabled || !browserHubSupported() || browserState().paired === true || browserState().pairingAvailable === false;
    byId('unpair-browser').disabled = !enabled || browserState().paired !== true;
    byId('refresh-catalog').disabled = !online || catalogPending || isBusy();
    promptInput.disabled = !online || taskIsRunning();
    byId('agent-mode').disabled = !enabled;
    for (const id of ['api-protocol', 'api-model', 'api-base-url', 'api-key', 'api-remember', 'api-save', 'api-test', 'api-clear-key', 'api-custom-path', 'api-auth-mode']) byId(id).disabled = !enabled;
    const transportReady = executionMode() === 'api' ? gatewayReady() : browserHubSupported() && browserState().paired === true;
    byId('start-task').disabled = !enabled || !workspacePath() || !mcpReady() || !transportReady || !promptInput.value.trim();
    byId('cancel-task').hidden = !taskIsRunning();
    byId('cancel-task').disabled = !canRequest() || !taskIsRunning();
    const selected = !newSessionDraft && selectedTaskId ? taskCache.get(selectedTaskId) ?? taskSummaries().find(t=>t.id===selectedTaskId) : null;
    byId('delete-conversation').hidden = !selected;
    byId('delete-conversation').disabled = !canRequest() || taskIsRunning();
    byId('start-task').textContent = selected ? 'Tiếp tục trong chat này →' : 'Bắt đầu cuộc chat mới →';
    let readiness = 'Nhập việc cần làm rồi bấm “Chạy yêu cầu”.';
    if (!online) readiness = shuttingDown ? 'Hub đã dừng. Chạy lại launcher để tiếp tục.' : 'Đang chờ kết nối với Hub…';
    else if (taskIsRunning()) readiness = text(activeTask()?.transport, text(activeTask()?.provider)) === 'api' || /^gateway/.test(text(activeTask()?.provider))
      ? 'Agent API đang chạy trong Hub và sử dụng MCP trực tiếp. Giữ tiến trình Hub hoạt động để tiếp tục công việc.'
      : browserState().companionPhase === 'reconciling'
        ? 'Đang chờ mạng hoặc bằng chứng tin nhắn đã gửi. Hub sẽ tự tiếp tục nếu xác minh được; không gửi lại lượt này.'
        : activeTask()?.status === 'queued' ? 'Yêu cầu đang chờ tiện ích. Giữ trình duyệt có tiện ích mở.' : 'Tác vụ đang chạy. Giữ trình duyệt và tab ChatGPT đang xử lý mở.';
    else if (!workspacePath()) readiness = 'Chọn một workspace ở bên dưới trước khi giao việc.';
    else if (!mcpReady()) readiness = 'Bấm “Khởi động MCP” để kết nối đầy đủ các công cụ.';
    else if (executionMode() === 'api' && !gatewayReady()) readiness = 'Mở “Thiết lập API Gateway”, nhập URL, model và API key rồi lưu.';
    else if (executionMode() === 'chatgpt-web' && !browserHubSupported()) readiness = 'Mở Hub tại http://127.0.0.1:3007 để kết nối tiện ích.';
    else if (executionMode() === 'chatgpt-web' && browserState().paired !== true) readiness = 'Mở “Kết nối trình duyệt” và ghép ChatMCP Hub Companion một lần.';
    else if (isBusy()) readiness = actionLabel || 'Hub đang cập nhật kết nối…';
    else if (executionMode() === 'chatgpt-web' && browserState().connected !== true) readiness = 'Đã ghép tiện ích. Bạn có thể gửi yêu cầu rồi mở trình duyệt để tiếp tục.';
    byId('task-readiness').textContent = readiness;
    renderPairCode();
  }

  function selectSession(id) {
    selectedTaskId = id || null;
    newSessionDraft = !selectedTaskId;
    taskSignature = ''; sidebarSignature = '';
    if (selectedTaskId) {
      byId('task-history').value = selectedTaskId;
      const cached = taskCache.get(selectedTaskId);
      if (cached) renderTask(cached);
      void loadTask(selectedTaskId);
    } else {
      byId('task-output').hidden = true;
      byId('task-empty').hidden = false;
      byId('task-empty').firstElementChild.textContent = 'Cuộc hội thoại mới';
    }
    promptInput.value = '';
    renderSessionSidebar();
    updateControls();
  }

  function renderSessionSidebar() {
    const query = byId('session-search').value.trim().toLowerCase();
    const entries = taskSummaries();
    byId('session-count').textContent = `${entries.length} phiên được lưu trên máy`;
    const visible = entries.filter(item => !query || [item.prompt, ...(item.prompts || []).map(p=>p.text),item.workspace?.path].join(' ').toLowerCase().includes(query));
    const signature = JSON.stringify({selectedTaskId,newSessionDraft,query,entries:visible.map(t=>[t.id,t.status,t.updatedAt,t.promptCount ?? t.prompts?.length])});
    if (signature === sidebarSignature) return;
    sidebarSignature = signature;
    const rows = visible.map(item => {
      const li = document.createElement('li');
      const btn = node('button','session-entry'); btn.type='button'; btn.dataset.sessionId=item.id;
      btn.classList.toggle('is-selected',selectedTaskId===item.id && !newSessionDraft);
      if (selectedTaskId===item.id && !newSessionDraft) btn.setAttribute('aria-current','true');
      btn.appendChild(node('span','session-entry-title',text(item.prompt,'Cuộc hội thoại').replace(/\s+/g,' ').slice(0,80)));
      const meta = node('span','session-entry-meta');
      meta.appendChild(node('span','',taskLabels[item.status] || text(item.status)));
      meta.appendChild(node('span','',`${item.promptCount ?? item.prompts?.length ?? 1} yêu cầu`));
      btn.appendChild(meta);
      btn.addEventListener('click',()=>selectSession(item.id));
      li.appendChild(btn); return li;
    });
    if(!rows.length) rows.push(node('li','session-list-empty',query?'Không tìm thấy phiên phù hợp.':'Chưa có phiên nào.'));
    byId('session-list').replaceChildren(...rows);
  }

  function renderConversationThread(task) {
    const thread = byId('conversation-thread');
    const prompts = Array.isArray(task.prompts) && task.prompts.length ? task.prompts : [{text:task.prompt,at:task.startedAt}];
    const runs = Array.isArray(task.runs) ? task.runs : [];
    const messages = [];
    for (let i=0; i<prompts.length; i++) {
      const user = node('article','conversation-bubble user-bubble');
      user.appendChild(node('div','bubble-label',`Bạn · yêu cầu ${i+1}`));
      user.appendChild(node('p','bubble-text',text(prompts[i]?.text)));
      messages.push(user);
      const response = text(runs[i]?.finalText);
      if (response) {
        const assistant = node('article','conversation-bubble agent-bubble');
        assistant.appendChild(node('div','bubble-label',`Agent · ${taskLabels[runs[i]?.status] || 'Đã ghi nhận'}`));
        assistant.appendChild(node('p','bubble-text',response.slice(0,12000)));
        messages.push(assistant);
      }
    }
    if (inProgress(task)) {
      const working = node('article','conversation-bubble agent-bubble is-working');
      working.appendChild(node('div','bubble-label','Agent · đang thực hiện'));
      working.appendChild(node('p','bubble-text','Đọc nhật ký công cụ và trạng thái bên dưới. Tiến độ được lưu sau mỗi sự kiện.'));
      messages.push(working);
    }
    thread.replaceChildren(...messages);
  }

  function renderTask(task) {
    if (!task || typeof task.id !== 'string') return;
    taskCache.set(task.id, task);
    if (task.id !== selectedTaskId) return;
    const signature = JSON.stringify(task);
    if (signature === taskSignature) return;
    taskSignature = signature;
    byId('task-empty').hidden = true;
    byId('task-output').hidden = false;
    const status = Object.prototype.hasOwnProperty.call(taskLabels, task.status) ? task.status : 'preparing';
    byId('task-status').textContent = taskLabels[status];
    byId('task-status').dataset.status = status;
    const steps = Array.isArray(task.steps) ? task.steps.length : number(task.steps);
    byId('task-step-count').textContent = `${steps} phản hồi AI`; 
    byId('task-tool-count').textContent = `${number(task.toolCalls)} lần gọi công cụ`;
    byId('task-workspace').textContent = text(task.workspace?.path, text(task.workspace));
    byId('task-original-prompt').textContent = `${Array.isArray(task.prompts) ? task.prompts.length : 1} yêu cầu đã lưu trong phiên · ${Array.isArray(task.runs) ? task.runs.length : 1} lần chạy`;
    renderConversationThread(task);
    byId('task-error').hidden = !text(task.error);
    byId('task-error').textContent = text(task.error);
    byId('task-final').textContent = text(task.finalText) || (inProgress(task) ? 'Hub đang thực hiện. Kết quả cuối sẽ xuất hiện tại đây.' : 'Tác vụ chưa có nội dung kết quả cuối. Xem các bước thực hiện và thông báo ở trên.');
    byId('task-report-link').href = '/api/tasks/' + encodeURIComponent(task.id) + '/report';
    byId('task-report-link').hidden = !text(task.reportUrl);
    const chatLink = byId('task-chat-link');
    chatLink.hidden = true;
    chatLink.removeAttribute('href');
    const chatRoute = globalThis.__chatmcpChatRoute.parse(text(task.chatUrl));
    if (chatRoute?.kind === 'chat') {
      chatLink.href = chatRoute.url;
      chatLink.hidden = false;
    }
    const events = Array.isArray(task.events) ? task.events : [];
    const lastEvent = events.at(-1);
    const actionLabel = task.status === 'completed' ? 'Tác vụ hoàn tất' :
      task.status === 'failed' ? 'Tác vụ dừng vì lỗi' :
      task.status === 'cancelled' ? 'Tác vụ đã hủy' :
      task.status === 'limit' ? 'Đã đạt ngân sách lượt/thời gian' :
      text(lastEvent?.toolName) ? `MCP · ${lastEvent.toolName}` :
      lastEvent?.type === 'model' ? 'Model đang xử lý yêu cầu' :
      'Agent đang làm việc';
    byId('activity-heading').textContent = actionLabel;
    byId('activity-description').textContent = text(lastEvent?.message, 'Đang chuẩn bị xử lý tác vụ.');
    byId('activity-mode').textContent = text(task.transport, text(task.provider)) === 'api' || /^gateway/.test(text(task.provider)) ? 'API Gateway' : 'ChatGPT Web';
    byId('activity-now').dataset.status = task.status;
    byId('task-event-count').textContent = `(${events.length})`;
    const list = byId('task-events');
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 12;
    const rows = events.map((event) => {
      const row = node('li', 'task-event');
      const type = text(event?.type);
      row.dataset.kind = /error|fail/.test(type) || event?.status === 'error' ? 'error' : text(event?.toolName) ? 'tool' : 'info';
      const at = new Date(text(event?.at));
      row.appendChild(node('time', '', Number.isFinite(at.getTime()) ? at.toLocaleTimeString('vi-VN') : ''));
      const body = node('div', 'task-event-body');
      if (text(event?.toolName)) body.appendChild(node('code', '', event.toolName));
      body.appendChild(node('p', '', text(event?.message, type || 'Đang xử lý…')));
      row.appendChild(body);
      return row;
    });
    list.replaceChildren(...(rows.length ? rows : [node('li', 'task-event-empty', 'Đang chờ bước thực hiện đầu tiên…')]));
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  async function loadTask(id) {
    if (!id || taskRequestId === id) return;
    taskRequestId = id;
    try {
      const task = await getJson('/api/tasks/' + encodeURIComponent(id));
      const resolved = task.task ?? task;
      if (typeof resolved.id !== 'string') throw new Error('Không đọc được tác vụ này.');
      taskCache.set(resolved.id, resolved);
      if (selectedTaskId === resolved.id) renderTask(resolved);
    } catch (error) {
      if (selectedTaskId === id) showNotice(text(error?.message, 'Không đọc được tác vụ.'), true);
    } finally { if (taskRequestId === id) taskRequestId = null; }
  }

  function renderAgent() {
    const active = activeTask();
    const summaries = taskSummaries();
    if (!selectedTaskId && !newSessionDraft) selectedTaskId = text(active?.id) || text(summaries[0]?.id) || null;
    renderSessionSidebar();
    const entries = [...summaries];
    if (active?.id && !entries.some((entry) => entry.id === active.id)) entries.unshift(active);
    const signature = JSON.stringify(entries.map((entry) => [entry.id, entry.status, entry.prompt]));
    if (signature !== historySignature) {
      const options = entries.map((entry) => {
        const option = node('option');
        option.value = entry.id;
        const title = text(entry.prompt, entry.id).replace(/\s+/g, ' ').slice(0, 62);
        option.textContent = `${taskLabels[entry.status] || entry.status || 'Tác vụ'} · ${title}`;
        return option;
      });
      if (!options.length) { const empty = node('option', '', 'Chưa có tác vụ'); empty.value = ''; options.push(empty); }
      byId('task-history').replaceChildren(...options);
      historySignature = signature;
    }
    byId('task-history').disabled = !entries.length;
    if (selectedTaskId) byId('task-history').value = selectedTaskId;
    if (active?.id) taskCache.set(active.id, active);
    if (!selectedTaskId) return;
    const cached = taskCache.get(selectedTaskId);
    const summary = entries.find((entry) => entry.id === selectedTaskId);
    if (active?.id === selectedTaskId) renderTask(active);
    else if (cached && (!summary || (summary.status === cached.status &&
      summary.updatedAt === cached.updatedAt &&
      (summary.promptCount ?? summary.prompts?.length ?? 1) === (cached.promptCount ?? cached.prompts?.length ?? 1)))) renderTask(cached);
    else void loadTask(selectedTaskId);
  }

  function renderCatalog() {
    if (!catalog) return;
    const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
    const derived = { 'cloud-harness': 0, 'desktop-commander': 0 };
    for (const tool of tools) {
      for (const server of Object.keys(derived)) if (text(tool?.name).startsWith(server + '.') || tool?.server === server || tool?.serverName === server) derived[server] += 1;
    }
    byId('cloud-tool-count').textContent = String(number(catalog.counts?.['cloud-harness'], derived['cloud-harness']));
    byId('desktop-tool-count').textContent = String(number(catalog.counts?.['desktop-commander'], derived['desktop-commander']));
    byId('catalog-total').textContent = `${tools.length} công cụ`;
    byId('catalog-readiness').textContent = catalog.ready ? 'Đã đọc danh sách đầy đủ. AI có thể dùng mọi công cụ được các server cấp quyền.' : 'MCP chưa sẵn sàng đầy đủ. Danh sách bên dưới phản ánh dữ liệu Hub đang có.';
    const query = byId('tool-search').value.trim().toLowerCase();
    const matching = tools.filter((tool) => !query || JSON.stringify(tool).toLowerCase().includes(query));
    byId('catalog-search-count').textContent = query ? `${matching.length}/${tools.length} công cụ khớp tìm kiếm` : `Hiển thị đủ ${tools.length} công cụ. Mở từng mục để xem mô tả và schema.`;
    const rows = matching.map((tool) => {
      const item = node('details', 'catalog-tool');
      const summary = node('summary');
      summary.appendChild(node('code', '', text(tool?.name, 'Công cụ chưa có tên')));
      summary.appendChild(node('span', 'details-chevron', '⌄'));
      item.appendChild(summary);
      if (text(tool?.description)) item.appendChild(node('p', 'catalog-tool-description', tool.description));
      const schema = node('pre', 'catalog-tool-schema', JSON.stringify(tool, null, 2));
      schema.tabIndex = 0;
      item.appendChild(schema);
      return item;
    });
    byId('catalog-tools').replaceChildren(...(rows.length ? rows : [node('p', 'catalog-empty', query ? 'Không có công cụ khớp tìm kiếm.' : 'Chưa có công cụ để hiển thị.')]));
  }

  async function refreshCatalog(quiet = false) {
    if (catalogPending || !online) return;
    catalogPending = true;
    updateControls();
    try { catalog = await getJson('/api/catalog'); renderCatalog(); }
    catch (error) {
      byId('catalog-readiness').textContent = text(error?.message, 'Chưa đọc được danh sách công cụ.');
      if (!quiet) showNotice(byId('catalog-readiness').textContent, true);
    } finally { catalogPending = false; updateControls(); }
  }

  function renderState(state) {
    const wasPaired = browserState().paired === true;
    currentState = state;
    online = true;
    byId('connection-pill').dataset.kind = 'ready';
    byId('connection-label').textContent = 'Hub đang hoạt động';
    byId('connection-alert').hidden = true;
    const savedPath = workspacePath();
    byId('current-workspace-path').textContent = savedPath || 'Chọn thư mục dự án để bắt đầu.';
    byId('current-workspace-path').classList.toggle('is-empty', !savedPath);
    byId('workspace-badge').textContent = savedPath ? 'Đã chọn workspace' : 'Chưa chọn thư mục';
    byId('workspace-badge').classList.toggle('badge-ready', Boolean(savedPath));
    byId('workspace-badge').classList.toggle('badge-neutral', !savedPath);
    if (!dirtyPath && document.activeElement !== pathInput) pathInput.value = savedPath;
    let readyCount = 0;
    for (const key of serviceKeys) {
      const service = state.services?.[key];
      const serviceState = Object.prototype.hasOwnProperty.call(stateLabels, service?.state) ? service.state : 'unknown';
      const detail = text(service?.detail, fallbackDetails[key]) || fallbackDetails[key];
      byId(`service-${key}`).dataset.state = serviceState;
      byId(`${key}-label`).textContent = stateLabels[serviceState];
      byId(`${key}-detail`).textContent = detail;
      byId(`${key}-detail`).title = detail;
      if (serviceState === 'ready') readyCount += 1;
    }
    byId('services-summary').textContent = `${readyCount}/4 dịch vụ sẵn sàng`;
    byId('proxy-url').textContent = text(state.proxyUrl, 'http://127.0.0.1:3006/mcp');
    byId('last-error').hidden = !text(state.lastError);
    byId('last-error-text').textContent = text(state.lastError);
    const logs = Array.isArray(state.logs) ? state.logs.filter((line) => typeof line === 'string').slice(-60) : [];
    const logText = logs.join('\n').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '') || 'Chưa có nhật ký.';
    if (logText !== lastLogText) {
      const box = byId('logs');
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 12;
      box.textContent = logText;
      if (atBottom) box.scrollTop = box.scrollHeight;
      lastLogText = logText;
    }
    byId('log-count').textContent = `${logs.length} dòng gần nhất`;
    byId('hub-version').textContent = state.version ? `ChatMCP Hub ${text(state.version)}` : 'ChatMCP Hub';
    byId('last-updated').textContent = `Cập nhật ${new Date().toLocaleTimeString('vi-VN')}`;
    renderModes();
    renderBrowser();
    renderAgent();
    updateControls();
    if (!wasPaired && browserState().paired === true) wakeBrowser();
    const nextCatalogSignature = `${state.generation ?? ''}:${state.toolCount ?? ''}:${readyCount}`;
    if (nextCatalogSignature !== catalogSignature && readyCount === 4) {
      catalogSignature = nextCatalogSignature;
      void refreshCatalog(true);
    }
  }

  async function responseError(response) {
    try { const payload = await response.json(); if (typeof payload.error === 'string' && payload.error) return new Error(payload.error); }
    catch { /* Do not print raw non-JSON responses. */ }
    return new Error(`Hub chưa thực hiện được yêu cầu (HTTP ${response.status}).`);
  }
  async function getJson(route, options = {}) {
    const response = await fetch(route, { cache: 'no-store', credentials: 'same-origin', ...options });
    if (!response.ok) throw await responseError(response);
    return response.json();
  }
  async function refreshState() {
    if (stateRequestPending || shuttingDown) return;
    stateRequestPending = true;
    const requestEpoch = actionEpoch;
    byId('refresh-state').disabled = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const state = await getJson('/api/state', { signal: controller.signal });
      if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.csrfToken !== 'string') throw new Error('Invalid state');
      if (requestEpoch === actionEpoch && !shuttingDown) renderState(state);
    } catch {
      if (requestEpoch !== actionEpoch || shuttingDown) return;
      online = false;
      byId('connection-pill').dataset.kind = 'error';
      byId('connection-label').textContent = 'Mất kết nối Hub';
      byId('connection-alert').hidden = false;
      updateControls();
    } finally {
      clearTimeout(timeout);
      stateRequestPending = false;
      byId('refresh-state').disabled = shuttingDown;
    }
  }
  async function post(route, body = {}) {
    const csrf = currentState?.csrfToken;
    if (!csrf || !online) throw new Error('Hub chưa kết nối. Hãy chờ trang cập nhật trạng thái.');
    let response;
    try {
      response = await fetch(route, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': csrf }, body: JSON.stringify(body) });
    } catch { throw new Error('Mất kết nối với Hub. Mở lại Hub và kiểm tra trạng thái trước khi gửi lại yêu cầu.'); }
    if (!response.ok) throw await responseError(response);
    return response.json();
  }
  async function runAction(label, action, { allowDuringTask = false, allowBusy = false } = {}) {
    if (!(allowBusy ? canRequest() : canMutate()) || (!allowDuringTask && taskIsRunning())) return;
    actionEpoch += 1;
    actionPending = true;
    actionLabel = label;
    byId('notice').hidden = true;
    updateControls();
    try { await action(); }
    catch (error) { showNotice(text(error?.message, 'Chưa thực hiện được thao tác. Hãy xem nhật ký Hub.'), true); }
    finally {
      actionEpoch += 1;
      actionPending = false;
      actionLabel = '';
      updateControls();
      await refreshState();
    }
  }
  async function copyText(value) {
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; } }
    catch { /* Fall back to a user-initiated local copy operation. */ }
    const previousFocus = document.activeElement;
    const field = node('textarea', 'clipboard-staging');
    field.value = value;
    field.readOnly = true;
    field.setAttribute('aria-hidden', 'true');
    document.body.appendChild(field);
    field.focus();
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); }
    finally { field.remove(); previousFocus?.focus?.(); }
    if (!copied) throw new Error('Trình duyệt chưa cho phép sao chép. Bạn có thể chọn nội dung thủ công hoặc tải file hướng dẫn.');
  }
  function openBrowserSettings() {
    byId('browser-settings').open = true;
    byId('browser-settings').scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }

  pathInput.addEventListener('input', () => { dirtyPath = true; updateControls(); });
  promptInput.addEventListener('input', updateControls);
  byId('show-browser-settings').addEventListener('click', openBrowserSettings);
  byId('agent-mode').addEventListener('change', () => {
    const mode = byId('agent-mode').value;
    void runAction('Đang chuyển chế độ Agent...', async () => {
      renderState(await post('/api/agent/mode', { mode }));
      showNotice(mode === 'api' ? 'Đã chọn API Gateway. Cấu hình kết nối và kiểm tra MCP.' : 'Đã chọn ChatGPT Web. Dùng Companion đã ghép.');
    });
  });
  for (const id of ['api-protocol','api-model','api-base-url','api-key','api-remember','api-custom-path','api-auth-mode']) byId(id).addEventListener('input', () => { apiInputsDirty = true; });
  byId('api-clear-key').addEventListener('click', () => {
    if (!confirm('Xóa API key đã lưu trên Hub? Nếu có GOOGLE_API_KEY trong môi trường, key đó vẫn được đọc ở lần chạy sau.')) return;
    void runAction('Đang xóa API key đã lưu...', async () => {
      renderState(await post('/api/ai/clear-key'));
      byId('api-key').value = '';
      showNotice('Đã xóa API key của phiên này và bản DPAPI đã lưu.');
    });
  });
  byId('api-test').addEventListener('click', () => {
    if (!gatewayReady()) { showNotice('Lưu API config trước khi test.', true); return; }
    void runAction('Đang gọi model để kiểm tra (có thể phát sinh phí API)...', async () => {
      const result = await post('/api/ai/test');
      showNotice(result.ok && result.responsePresent ? 'Model đã phản hồi yêu cầu kiểm tra API thành công.' : 'Model trả phản hồi trống; kiểm tra gateway/model.');
    });
  });
  byId('api-settings-form').addEventListener('submit', event => {
    event.preventDefault();
    const payload = {
      protocol: byId('api-protocol').value, model: byId('api-model').value.trim(),
      apiBaseUrl: byId('api-base-url').value.trim(),
      remember: byId('api-remember').checked,
      authMode: byId('api-auth-mode').value, customPath: byId('api-custom-path').value.trim(),
    };
    if (byId('api-key').value) payload.apiKey = byId('api-key').value;
    void runAction('Đang lưu cấu hình API bằng giao thức đã chọn...', async () => {
      renderState(await post('/api/ai/config', payload));
      byId('api-key').value = '';
      byId('api-remember').checked = false;
      apiInputsDirty = false;
      showNotice('Đã lưu cấu hình API. Không hiển thị key. API chỉ chạy khi bạn chọn chế độ API.');
    });
  });
  byId('dismiss-notice').addEventListener('click', () => { byId('notice').hidden = true; });
  byId('refresh-state').addEventListener('click', () => { void refreshState(); });
  byId('tool-search').addEventListener('input', renderCatalog);
  byId('refresh-catalog').addEventListener('click', () => { void refreshCatalog(); });
  byId('tool-catalog').addEventListener('toggle', () => { if (byId('tool-catalog').open && !catalog) void refreshCatalog(true); });
  byId('task-history').addEventListener('change', () => selectSession(byId('task-history').value || null));
  byId('session-search').addEventListener('input', () => { sidebarSignature=''; renderSessionSidebar(); });
  byId('new-conversation').addEventListener('click', () => { selectSession(null); promptInput.focus(); });
  byId('delete-conversation').addEventListener('click',()=>{
    const id = selectedTaskId;
    if (!id || taskIsRunning()) return;
    if (!window.confirm('Xóa lịch sử phiên trên máy? File workspace không bị xóa; cuộc chat trên chatgpt.com không bị xóa. Hành động này không hoàn tác được.')) return;
    void runAction('Đang xóa lịch sử phiên đã chọn…',async()=>{
      await post('/api/tasks/delete',{id});
      taskCache.delete(id);
      currentState.agent.tasks = taskSummaries().filter(t=>t.id!==id);
      historySignature='';sidebarSignature='';
      selectSession(null);
      showNotice('Đã xóa lịch sử phiên cục bộ; file dự án và cuộc chat ChatGPT vẫn giữ nguyên.');
    });
  });

  byId('browse-workspace').addEventListener('click', () => {
    void runAction('Hộp chọn thư mục Windows đang mở. Chọn thư mục rồi bấm OK.', async () => {
      const selected = await post('/api/workspace/browse');
      if (typeof selected.path === 'string' && selected.path) { pathInput.value = selected.path; dirtyPath = true; showNotice('Đã chọn thư mục. Bấm “Dùng thư mục này” để áp dụng vào MCP.'); }
    });
  });
  byId('workspace-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const path = inputPath();
    if (!path) { showNotice('Hãy chọn hoặc nhập đường dẫn thư mục trước.', true); return; }
    void runAction('Đang chuyển workspace và cập nhật MCP. Lần đầu có thể mất vài phút.', async () => {
      const state = await post('/api/workspace/select', { path });
      dirtyPath = false;
      pathInput.value = text(state.workspace?.path, path);
      renderState(state);
      showNotice('Đã áp dụng workspace. Bạn có thể nhập yêu cầu ở đầu trang.');
    });
  });
  byId('start-services').addEventListener('click', () => {
    void runAction('Đang khởi động kết nối MCP. Lần đầu có thể cần tải các thành phần.', async () => { renderState(await post('/api/services/start')); showNotice('Đã thực hiện yêu cầu khởi động. Kiểm tra các thẻ trạng thái bên dưới.'); });
  });
  byId('stop-services').addEventListener('click', () => {
    void runAction('Đang dừng kết nối MCP do Hub quản lý…', async () => { renderState(await post('/api/services/stop')); showNotice('Đã thực hiện yêu cầu dừng kết nối.'); });
  });
  byId('open-vscode').addEventListener('click', () => {
    void runAction('Đang mở workspace trong VS Code…', async () => { await post('/api/vscode/open'); showNotice('Đã gửi yêu cầu mở workspace trong VS Code.'); }, { allowDuringTask: true });
  });

  byId('create-pair-code').addEventListener('click', () => {
    if (!browserHubSupported() || browserState().paired === true || browserState().pairingAvailable === false) return;
    void runAction('Đang tạo mã ghép tiện ích…', async () => {
      // Requesting another code can invalidate the previous code on the server.
      pairing = null;
      renderPairCode();
      const result = await post('/api/browser/pair-code');
      const code = text(result.code);
      const expiresAt = Date.parse(text(result.expiresAt));
      if (!/^\d{8}$/.test(code) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Hub chưa trả mã ghép hợp lệ. Hãy tạo lại mã.');
      pairing = { code, expiresAt };
      renderPairCode();
      showNotice('Mở popup ChatMCP Hub Companion rồi dán mã ghép 8 chữ số.');
    });
  });
  byId('copy-pair-code').addEventListener('click', async () => {
    renderPairCode();
    if (!pairing || !online) return;
    try { await copyText(pairing.code); showNotice('Đã sao chép mã. Dán vào popup ChatMCP Hub Companion.'); }
    catch (error) { showNotice(text(error?.message, 'Chưa sao chép được mã ghép.'), true); }
  });
  byId('unpair-browser').addEventListener('click', () => {
    void runAction('Đang huỷ ghép tiện ích…', async () => {
      renderState(await post('/api/browser/unpair'));
      pairing = null;
      renderPairCode();
      openBrowserSettings();
      showNotice('Đã huỷ ghép. Tạo mã mới khi muốn nối lại tiện ích.');
    });
  });

  byId('task-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = promptInput.value.trim();
    if (!prompt) { showNotice('Nhập yêu cầu trước khi chạy.', true); return; }
    if (executionMode() === 'chatgpt-web' && (!browserHubSupported() || browserState().paired !== true)) { openBrowserSettings(); showNotice('Ghép ChatMCP Hub Companion với Hub tại cổng 3007 trước khi chạy yêu cầu.', true); return; }
    if (executionMode() === 'api' && !gatewayReady()) { byId('api-settings').open = true; showNotice('Cần cấu hình API Gateway trước khi chạy.', true); return; }
    if (!workspacePath() || !mcpReady()) { showNotice('Chọn workspace và khởi động đầy đủ MCP trước khi chạy.', true); return; }
    void runAction('Đang giao yêu cầu cho Hub…', async () => {
      const payload = { prompt };
      if (executionMode() === 'api') {
        payload.maxSteps = Number(byId('max-steps').value);
        payload.maxMinutes = Number(byId('max-minutes').value);
        if (!Number.isInteger(payload.maxSteps) || payload.maxSteps < 1 || payload.maxSteps > 1000 || !Number.isInteger(payload.maxMinutes) || payload.maxMinutes < 1 || payload.maxMinutes > 240) throw new Error('Chọn giới hạn agent hợp lệ: 1–1000 lượt, 1–240 phút.');
      }
      const isFollowUp = Boolean(selectedTaskId && !newSessionDraft);
      if (isFollowUp) payload.id = selectedTaskId;
      const result = await post(isFollowUp ? '/api/tasks/continue' : '/api/tasks/start', payload);
      const task = result.task;
      if (!task || typeof task.id !== 'string') throw new Error('Hub chưa trả lại mã tác vụ. Kiểm tra trạng thái trước khi gửi lại.');
      selectedTaskId = task.id; newSessionDraft = false; sidebarSignature='';
      taskSignature = '';
      promptInput.value = '';
      currentState.agent = { ...(currentState.agent ?? {}), activeTaskId: inProgress(task) ? task.id : null, active: inProgress(task) ? task : null };
      renderTask(task); renderSessionSidebar();
      if (executionMode() === 'chatgpt-web') wakeBrowser();
      showNotice(isFollowUp ? 'Đã thêm yêu cầu vào hội thoại cũ. Agent tiếp tục từ tiến độ đã lưu.' : 'Đã bắt đầu phiên mới. Lịch sử sẽ được tự động lưu sau từng bước.');
    });
  });
  byId('cancel-task').addEventListener('click', () => {
    const id = text(currentState?.agent?.activeTaskId) || text(activeTask()?.id);
    if (!id || !taskIsRunning()) return;
    void runAction('Đang gửi yêu cầu huỷ tác vụ…', async () => {
      const result = await post('/api/tasks/cancel', { id });
      if (result.task?.id) renderTask(result.task);
      showNotice('Đã gửi yêu cầu huỷ. Theo dõi trạng thái tác vụ để biết khi nào đã dừng.');
    }, { allowDuringTask: true, allowBusy: true });
  });

  byId('copy-url').addEventListener('click', async () => {
    try { await copyText(text(currentState?.proxyUrl, 'http://127.0.0.1:3006/mcp')); showNotice('Đã sao chép URL MCP. Chọn Streamable HTTP trong tiện ích.'); }
    catch (error) { showNotice(text(error?.message, 'Chưa sao chép được URL.'), true); }
  });
  byId('copy-instructions').addEventListener('click', async () => {
    if (copyPending || !online || isBusy()) return;
    copyPending = true;
    updateControls();
    try {
      const response = await fetch('/api/instructions', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw await responseError(response);
      const instructions = await response.text();
      if (!instructions.trim()) throw new Error('Hub chưa có hướng dẫn. Khởi động MCP rồi thử lại.');
      await copyText(instructions);
      showNotice('Đã sao chép hướng dẫn. Dán vào chat hoặc dùng nút Chèn hướng dẫn của tiện ích.');
    } catch (error) { showNotice(text(error?.message, 'Chưa lấy được hướng dẫn từ Hub.'), true); }
    finally { copyPending = false; updateControls(); }
  });
  byId('download-instructions').addEventListener('click', (event) => { if (!online || !currentState || isBusy()) event.preventDefault(); });
  byId('shutdown-hub').addEventListener('click', () => {
    void runAction('Đang tắt Hub và các tiến trình do Hub quản lý…', async () => {
      await post('/api/hub/shutdown');
      shuttingDown = true;
      online = false;
      if (pollTimer !== null) clearInterval(pollTimer);
      byId('connection-pill').dataset.kind = 'pending';
      byId('connection-label').textContent = 'Hub đã dừng';
      byId('connection-alert').hidden = true;
      byId('refresh-state').disabled = true;
      showNotice('Hub đã dừng. Chạy START-CHATMCP-HUB.cmd khi muốn dùng lại.');
    });
  });

  wakeBrowser();
  void refreshState();
  pollTimer = setInterval(() => { void refreshState(); }, 2000);
})();
