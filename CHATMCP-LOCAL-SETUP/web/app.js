/* ChatMCP Hub: all requests stay on this origin; credentials are never rendered. */
'use strict';

(() => {
  const byId = (id) => document.getElementById(id);
  const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
  const number = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const pathInput = byId('workspace-path');
  const promptInput = byId('task-prompt');
  const serviceKeys = ['docker', 'cloud', 'proxy', 'desktop'];
  const stateLabels = { ready: 'Sẵn sàng', stopped: 'Đã dừng', starting: 'Đang khởi động', error: 'Cần kiểm tra', unknown: 'Chưa kiểm tra' };
  const taskLabels = { pending: 'Đang chờ', running: 'Đang thực hiện', completed: 'Hoàn thành', failed: 'Không hoàn thành', cancelled: 'Đã huỷ', interrupted: 'Bị gián đoạn', limit: 'Đã đạt giới hạn' };
  const fallbackDetails = { docker: 'Môi trường cho Cloud Harness.', cloud: 'Kết nối workspace và công cụ Git.', proxy: 'Điểm kết nối cho tiện ích trình duyệt.', desktop: 'Đọc, sửa file và chạy lệnh trên Windows.' };
  let currentState = null;
  let online = false;
  let dirtyPath = false;
  let dirtyModel = false;
  let dirtyProvider = false;
  let dirtyLimits = false;
  let settingsInitialized = false;
  let actionPending = false;
  let actionLabel = '';
  let actionEpoch = 0;
  let stateRequestPending = false;
  let copyPending = false;
  let modelsPending = false;
  let shuttingDown = false;
  let pollTimer = null;
  let lastLogText = '';
  let selectedTaskId = null;
  let taskRequestId = null;
  let historySignature = '';
  let taskSignature = '';
  let catalogPending = false;
  let catalogSignature = '';
  let catalog = null;
  const taskCache = new Map();

  const workspacePath = () => text(currentState?.workspace?.path);
  const aiState = () => currentState?.ai ?? {};
  const activeTask = () => currentState?.agent?.active ?? null;
  const inProgress = (task) => ['pending', 'running'].includes(task?.status);
  const taskIsRunning = () => activeTask() ? inProgress(activeTask()) : Boolean(currentState?.agent?.activeTaskId);
  const isBusy = () => actionPending || currentState?.busy === true || aiState().busy === true;
  const canRequest = () => online && Boolean(currentState?.csrfToken) && !actionPending && !shuttingDown;
  const canMutate = () => canRequest() && currentState?.busy !== true && aiState().busy !== true;
  const canConfigure = () => canMutate() && !taskIsRunning();
  const mcpReady = () => serviceKeys.every((key) => currentState?.services?.[key]?.state === 'ready');
  const selectedProvider = () => byId('ai-provider').value === 'chatgpt' ? 'chatgpt' : 'openai';
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
  function modelOptions(models) {
    if (!Array.isArray(models)) return;
    const options = models.flatMap((entry) => {
      const id = typeof entry === 'string' ? entry : text(entry?.id);
      if (!id) return [];
      const option = node('option');
      option.value = id;
      if (typeof entry === 'object' && entry?.name) option.label = text(entry.name);
      return [option];
    });
    byId('ai-model-options').replaceChildren(...options);
  }

  function updateProviderFields() {
    const api = selectedProvider() === 'openai';
    byId('openai-settings').hidden = !api;
    byId('chatgpt-settings').hidden = api;
    const ai = aiState();
    const chatgpt = ai.chatgpt ?? {};
    let authMessage = 'Chưa đăng nhập ChatGPT.';
    if (chatgpt.loginPending) authMessage = 'Đang chờ bạn hoàn tất đăng nhập trong tab vừa mở…';
    else if (chatgpt.signedIn) {
      authMessage = chatgpt.planEnabled === false
        ? 'Đã đăng nhập, nhưng tài khoản chưa có quyền sử dụng chế độ này.'
        : 'Đã đăng nhập ChatGPT' + (text(chatgpt.email) ? ` · ${chatgpt.email}` : '.') ;
    }
    byId('chatgpt-auth-status').textContent = authMessage;
    byId('chatgpt-signout').hidden = !chatgpt.signedIn;
    byId('chatgpt-signin').textContent = chatgpt.signedIn ? 'Đăng nhập lại ChatGPT ↗' : 'Đăng nhập ChatGPT ↗';
    if (api) {
      const labels = { saved: 'Đã lưu key trên máy này.', environment: 'Đang dùng key từ biến môi trường.', session: 'Key chỉ có trong phiên Hub hiện tại.', none: 'Chưa có API key.' };
      byId('ai-key-source').textContent = labels[ai.keySource] || 'Nhập key nếu bạn muốn cập nhật thông tin đăng nhập.';
    } else byId('ai-key-source').textContent = chatgpt.signedIn ? 'Đang dùng tài khoản ChatGPT đã đăng nhập.' : 'Đăng nhập ChatGPT để bắt đầu.';
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
    byId('busy-text').textContent = actionLabel || (aiState().busy ? 'Hub đang cập nhật kết nối AI…' : 'Hub đang cập nhật kết nối.');
    byId('workspace-form').setAttribute('aria-busy', String(isBusy()));
    const unapplied = dirtyPath && Boolean(inputPath()) && comparablePath(inputPath()) !== comparablePath(workspacePath());
    byId('path-hint').classList.toggle('is-draft', unapplied);
    byId('path-hint').textContent = taskIsRunning()
      ? 'Workspace được giữ cố định trong khi tác vụ đang chạy.'
      : unapplied ? 'Thư mục này chưa được áp dụng. Bấm “Dùng thư mục này” để chuyển workspace.'
        : 'Chọn bằng hộp thoại Windows hoặc dán đường dẫn vào đây.';

    for (const id of ['ai-provider', 'ai-model', 'ai-api-key', 'remember-api-key', 'save-ai-config', 'chatgpt-signin', 'chatgpt-signout']) byId(id).disabled = !enabled;
    byId('refresh-models').disabled = !enabled || modelsPending;
    byId('refresh-catalog').disabled = !online || catalogPending || isBusy();
    promptInput.disabled = !online || taskIsRunning();
    byId('max-steps').disabled = !online || taskIsRunning();
    byId('max-minutes').disabled = !online || taskIsRunning();
    byId('start-task').disabled = !enabled || !workspacePath() || !mcpReady() || aiState().configured !== true || !promptInput.value.trim();
    byId('cancel-task').hidden = !taskIsRunning();
    byId('cancel-task').disabled = !canRequest() || !taskIsRunning();
    let readiness = 'Nhập việc cần làm rồi bấm “Chạy yêu cầu”.';
    if (!online) readiness = shuttingDown ? 'Hub đã dừng. Chạy lại launcher để tiếp tục.' : 'Đang chờ kết nối với Hub…';
    else if (taskIsRunning()) readiness = 'Hub đang thực hiện tác vụ. Bạn có thể đóng trang và quay lại sau.';
    else if (!workspacePath()) readiness = 'Chọn một workspace ở bên dưới trước khi giao việc.';
    else if (aiState().configured !== true) readiness = 'Mở “Thiết lập AI” để đăng nhập ChatGPT hoặc cấu hình OpenAI API.';
    else if (!mcpReady()) readiness = 'Bấm “Khởi động MCP” để kết nối đầy đủ các công cụ.';
    else if (isBusy()) readiness = actionLabel || 'Hub đang cập nhật kết nối…';
    byId('task-readiness').textContent = readiness;
    updateProviderFields();
  }

  function renderAi() {
    const ai = aiState();
    if (!dirtyProvider) byId('ai-provider').value = ai.provider === 'chatgpt' ? 'chatgpt' : 'openai';
    if (!dirtyModel && document.activeElement !== byId('ai-model')) byId('ai-model').value = text(ai.model, 'gpt-6-astra');
    if (!dirtyLimits) {
      byId('max-steps').value = String(number(ai.maxSteps, 100));
      byId('max-minutes').value = String(number(ai.maxMinutes, 30));
    }
    if (!settingsInitialized) {
      byId('ai-settings').open = ai.configured !== true;
      settingsInitialized = true;
    }
    const providerLabel = ai.provider === 'chatgpt' ? 'ChatGPT' : 'OpenAI API';
    byId('agent-model-label').textContent = ai.configured ? `${providerLabel} · ${text(ai.model)}` : 'Chưa thiết lập AI';
    byId('agent-model-label').classList.toggle('badge-ready', ai.configured === true);
    byId('agent-model-label').classList.toggle('badge-neutral', ai.configured !== true);
    byId('ai-status-label').textContent = ai.configured ? `${providerLabel} · đã kết nối` : 'Cần cấu hình';
    byId('ai-api-key').placeholder = ai.provider === 'openai' && ai.configured ? 'Để trống để giữ key hiện tại' : 'Nhập API key của bạn';
    byId('ai-error').hidden = !text(ai.lastError);
    byId('ai-error').textContent = text(ai.lastError);
    if (Array.isArray(ai.models)) modelOptions(ai.models);
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
    const status = Object.prototype.hasOwnProperty.call(taskLabels, task.status) ? task.status : 'pending';
    byId('task-status').textContent = taskLabels[status];
    byId('task-status').dataset.status = status;
    const steps = Array.isArray(task.steps) ? task.steps.length : number(task.steps);
    byId('task-step-count').textContent = `${steps} bước`;
    byId('task-token-count').textContent = `${number(task.usage?.inputTokens).toLocaleString('vi-VN')} token vào · ${number(task.usage?.outputTokens).toLocaleString('vi-VN')} token ra`;
    byId('task-workspace').textContent = text(task.workspace);
    byId('task-original-prompt').textContent = text(task.prompt);
    byId('task-error').hidden = !text(task.error);
    byId('task-error').textContent = text(task.error);
    byId('task-final').textContent = text(task.finalText) || (inProgress(task) ? 'Hub đang thực hiện. Kết quả cuối sẽ xuất hiện tại đây.' : 'Tác vụ chưa có nội dung kết quả cuối. Xem các bước thực hiện và thông báo ở trên.');
    byId('task-report-link').href = '/api/tasks/' + encodeURIComponent(task.id) + '/report';
    byId('task-report-link').hidden = !text(task.reportUrl);
    const events = Array.isArray(task.events) ? task.events : [];
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
    if (!selectedTaskId) selectedTaskId = text(active?.id) || text(summaries[0]?.id) || null;
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
    else if (cached && (!summary || summary.status === cached.status)) renderTask(cached);
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
    renderAi();
    renderAgent();
    updateControls();
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
  function openAiSettings() {
    byId('ai-settings').open = true;
    byId('ai-settings').scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }

  pathInput.addEventListener('input', () => { dirtyPath = true; updateControls(); });
  promptInput.addEventListener('input', updateControls);
  byId('ai-model').addEventListener('input', () => { dirtyModel = true; });
  byId('ai-provider').addEventListener('change', () => { dirtyProvider = true; if (selectedProvider() === 'chatgpt') byId('ai-api-key').value = ''; updateProviderFields(); });
  for (const id of ['max-steps', 'max-minutes']) byId(id).addEventListener('input', () => { dirtyLimits = true; });
  byId('show-ai-settings').addEventListener('click', openAiSettings);
  byId('dismiss-notice').addEventListener('click', () => { byId('notice').hidden = true; });
  byId('refresh-state').addEventListener('click', () => { void refreshState(); });
  byId('tool-search').addEventListener('input', renderCatalog);
  byId('refresh-catalog').addEventListener('click', () => { void refreshCatalog(); });
  byId('tool-catalog').addEventListener('toggle', () => { if (byId('tool-catalog').open && !catalog) void refreshCatalog(true); });
  byId('task-history').addEventListener('change', () => {
    selectedTaskId = byId('task-history').value || null;
    taskSignature = '';
    if (selectedTaskId) {
      const cached = taskCache.get(selectedTaskId);
      if (cached) renderTask(cached);
      void loadTask(selectedTaskId);
    }
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

  byId('ai-config-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const provider = selectedProvider();
    const model = byId('ai-model').value.trim();
    const apiKey = byId('ai-api-key').value.trim();
    if (!model) { showNotice('Nhập tên model trước khi lưu.', true); return; }
    const config = { provider, model, remember: byId('remember-api-key').checked };
    if (provider === 'openai' && apiKey) config.apiKey = apiKey;
    void runAction('Đang lưu cài đặt AI…', async () => {
      await post('/api/ai/config', config);
      byId('ai-api-key').value = '';
      dirtyModel = false;
      dirtyProvider = false;
      showNotice(provider === 'chatgpt' ? 'Đã lưu chế độ ChatGPT. Đăng nhập nếu tài khoản chưa kết nối.' : 'Đã lưu cài đặt OpenAI API.');
    });
  });
  byId('refresh-models').addEventListener('click', async () => {
    if (!canConfigure() || modelsPending) return;
    modelsPending = true;
    updateControls();
    try {
      const result = await getJson('/api/ai/models');
      const models = Array.isArray(result) ? result : result.models;
      modelOptions(models);
      showNotice(Array.isArray(models) && models.length ? 'Đã cập nhật danh sách model. Chọn hoặc nhập tên trong ô Model.' : 'Chưa có gợi ý model. Đăng nhập hoặc nhập đúng tên model tài khoản hỗ trợ.');
    } catch (error) { showNotice(text(error?.message, 'Chưa đọc được danh sách model.'), true); }
    finally { modelsPending = false; updateControls(); }
  });
  byId('chatgpt-signin').addEventListener('click', () => {
    if (!canConfigure()) return;
    const model = byId('ai-model').value.trim();
    if (!model) { showNotice('Nhập tên model trước khi đăng nhập.', true); return; }
    // Open from the click gesture; show a normal link if the browser blocks it.
    const popup = window.open('about:blank', '_blank');
    if (popup) { popup.opener = null; try { popup.document.body.textContent = 'Đang mở trang đăng nhập ChatGPT…'; } catch { } }
    void runAction('Đang chuẩn bị đăng nhập ChatGPT…', async () => {
      try {
        await post('/api/ai/config', { provider: 'chatgpt', model });
        const result = await post('/api/auth/chatgpt/start');
        const url = new URL(text(result.url));
        if (url.protocol !== 'https:') throw new Error('Địa chỉ đăng nhập không hợp lệ.');
        byId('chatgpt-auth-link').href = url.href;
        byId('chatgpt-auth-link').hidden = false;
        if (popup) popup.location.href = url.href;
        dirtyProvider = false;
        dirtyModel = false;
        showNotice('Hoàn tất đăng nhập và chấp thuận trong tab mới, rồi quay lại Hub. Nếu tab chưa mở, dùng liên kết “Tiếp tục đăng nhập ChatGPT”.');
      } catch (error) { try { popup?.close(); } catch { } throw error; }
    });
  });
  byId('chatgpt-signout').addEventListener('click', () => {
    void runAction('Đang đăng xuất ChatGPT khỏi Hub…', async () => { await post('/api/auth/logout'); byId('chatgpt-auth-link').hidden = true; showNotice('Đã đăng xuất ChatGPT khỏi Hub.'); });
  });

  byId('task-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = promptInput.value.trim();
    const maxSteps = Number(byId('max-steps').value);
    const maxMinutes = Number(byId('max-minutes').value);
    if (!prompt) { showNotice('Nhập yêu cầu trước khi chạy.', true); return; }
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || !Number.isFinite(maxMinutes) || maxMinutes <= 0) { showNotice('Giới hạn bước và thời gian phải là số lớn hơn 0.', true); return; }
    if (aiState().configured !== true) { openAiSettings(); showNotice('Thiết lập AI trước khi chạy yêu cầu.', true); return; }
    if (!workspacePath() || !mcpReady()) { showNotice('Chọn workspace và khởi động đầy đủ MCP trước khi chạy.', true); return; }
    void runAction('Đang giao yêu cầu cho Hub…', async () => {
      const result = await post('/api/tasks/start', { prompt, maxSteps, maxMinutes });
      const task = result.task;
      if (!task || typeof task.id !== 'string') throw new Error('Hub chưa trả lại mã tác vụ. Kiểm tra trạng thái trước khi gửi lại.');
      selectedTaskId = task.id;
      taskSignature = '';
      currentState.agent = { ...(currentState.agent ?? {}), activeTaskId: inProgress(task) ? task.id : null, active: inProgress(task) ? task : null };
      renderTask(task);
      showNotice('Hub đã nhận yêu cầu và đang xử lý ở nền. Bạn có thể theo dõi các bước bên dưới.');
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

  void refreshState();
  pollTimer = setInterval(() => { void refreshState(); }, 2000);
})();
