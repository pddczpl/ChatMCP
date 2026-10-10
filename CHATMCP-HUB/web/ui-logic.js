/* ChatMCP Studio — the decisions the dashboard makes, kept apart from the page.
 *
 * Loaded before onboarding.js and react-app.js. Everything here is a pure function of data the Hub sends
 * (GET /api/state and friends): can a prompt be sent and what stands in the way, what is the agent waiting for,
 * what exactly does an approval request ask for, which permission mode is which. Keeping these out of the React
 * code means they are tested in Node (tests/verify-ui-logic.mjs) instead of only by clicking.
 * Nothing in this file touches the DOM, the network or storage, and nothing here renders model output as HTML. */
'use strict';
(function (root) {
  const arr = (value) => Array.isArray(value) ? value : [];
  const str = (value, fallback = '') => typeof value === 'string' ? value : fallback;
  const obj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const clip = (value, limit) => { const text = str(value); return text.length > limit ? `${text.slice(0, limit)}…` : text; };

  // ---------------------------------------------------------------------------------------------------------
  // Task state. Mirrors lib/task-state.mjs (TASK_STATE_INFO); tests/verify-ui-logic.mjs fails if the two drift.
  // ---------------------------------------------------------------------------------------------------------
  const STATES = Object.freeze({
    created: { label: 'Mới tạo', tone: 'idle', hint: 'Tác vụ vừa được tạo.' },
    queued: { label: 'Đang chuẩn bị', tone: 'idle', hint: 'Hub đang khóa thư mục dự án và nối công cụ.' },
    planning: { label: 'Đọc & lập kế hoạch', tone: 'active', hint: 'Agent đang đọc dự án và lập kế hoạch; chưa sửa gì.' },
    running: { label: 'Đang thực hiện', tone: 'active', hint: 'Agent đang sửa file hoặc chạy lệnh.' },
    waiting_approval: { label: 'Chờ bạn duyệt', tone: 'attention', hint: 'Agent cần bạn cho phép một thao tác. Không có gì chạy cho tới khi bạn quyết định.' },
    verifying: { label: 'Đang kiểm tra', tone: 'active', hint: 'Agent đang chạy kiểm thử hoặc lệnh kiểm tra.' },
    paused: { label: 'Tạm dừng', tone: 'warn', hint: 'Tác vụ dừng giữa chừng (hết giới hạn hoặc Hub khởi động lại). Gửi tin nhắn tiếp theo để tiếp tục cùng cuộc hội thoại.' },
    completed: { label: 'Hoàn tất', tone: 'ok', hint: 'Agent đã trả lời kết thúc. Hãy đọc bằng chứng kiểm tra trong kết quả.' },
    failed: { label: 'Thất bại', tone: 'error', hint: 'Tác vụ dừng vì lỗi. Xem lý do trong nhật ký.' },
    cancelled: { label: 'Đã dừng', tone: 'idle', hint: 'Bạn đã dừng tác vụ. Việc dừng không hoàn tác những gì đã làm.' },
    uncertain: { label: 'Chưa rõ kết quả', tone: 'warn', hint: 'Tác vụ dừng khi một thao tác có thể đã chạy nhưng Hub không nhận được kết quả. Kiểm tra thay đổi (Git diff) trước khi tiếp tục; Hub sẽ không chạy lại thao tác đó.' },
  });
  const ACTIVE = Object.freeze(['queued', 'planning', 'running', 'waiting_approval', 'verifying']);
  // Tasks written by older releases, and ChatGPT Web tasks, only have `status`.
  const LEGACY_STATE = Object.freeze({ preparing: 'queued', queued: 'queued', running: 'running', completed: 'completed', cancelled: 'cancelled', failed: 'failed', paused: 'paused', interrupted: 'paused', limit: 'paused' });
  const LEGACY_LABEL = Object.freeze({ preparing: 'Chuẩn bị', interrupted: 'Gián đoạn', limit: 'Đạt giới hạn' });
  const TAG_KIND = Object.freeze({ idle: 'neutral', active: 'working', attention: 'attention', warn: 'warn', ok: 'success', error: 'error' });

  const isActiveState = (state) => ACTIVE.includes(state);

  /** The canonical state of a task summary or task: its own `state`, or the closest one for its legacy `status`. */
  function taskState(task) {
    const t = obj(task);
    if (!t) return null;
    if (typeof t.state === 'string' && Object.hasOwn(STATES, t.state)) return t.state;
    return Object.hasOwn(LEGACY_STATE, t.status) ? LEGACY_STATE[t.status] : null;
  }

  /** @returns {{state: string|null, label: string, tone: string, kind: string, hint: string, active: boolean}} */
  function describeTask(task) {
    const state = taskState(task);
    if (!state) return { state: null, label: 'Sẵn sàng', tone: 'idle', kind: 'neutral', hint: '', active: false };
    const info = STATES[state];
    const legacyOnly = !(obj(task) && Object.hasOwn(STATES, str(task.state)));
    const label = legacyOnly && LEGACY_LABEL[task.status] ? LEGACY_LABEL[task.status] : info.label;
    return { state, label, tone: info.tone, kind: TAG_KIND[info.tone] || 'neutral', hint: info.hint, active: isActiveState(state) };
  }

  const tagKind = (tone) => TAG_KIND[tone] || 'neutral';

  // ---------------------------------------------------------------------------------------------------------
  // Backend, mode, readiness
  // ---------------------------------------------------------------------------------------------------------
  const backendOf = (hub) => hub && hub.backend === 'local' ? 'local' : 'mcp';

  /** api | chatgpt-web. Without a saved choice the local backend means "API" (ChatGPT Web is the legacy path). */
  function agentMode(hub) {
    const mode = hub && hub.agent && hub.agent.mode;
    if (mode === 'api' || mode === 'chatgpt-web') return mode;
    return backendOf(hub) === 'local' ? 'api' : 'chatgpt-web';
  }

  /** Whether the tools the agent works with are up. Local backend: the in-process tools. MCP backend: proxy + Desktop Commander. */
  function toolsState(hub) {
    const services = obj(hub && hub.services) || {};
    if (backendOf(hub) === 'local') {
      const local = obj(services.local) || {};
      const catalogOk = !(hub && hub.catalogReady === false);
      return { backend: 'local', ready: local.state === 'ready' && catalogOk, starting: local.state === 'starting', state: str(local.state, 'unknown'), detail: str(local.detail) };
    }
    const proxy = obj(services.proxy) || {};
    const desktop = obj(services.desktop) || {};
    const starting = proxy.state === 'starting' || desktop.state === 'starting';
    return { backend: 'mcp', ready: proxy.state === 'ready' && desktop.state === 'ready', starting, state: str(proxy.state, 'unknown'), detail: str(desktop.detail || proxy.detail) };
  }

  /**
   * What stands between the person and a task, and what sending a prompt may do about it.
   * `blockers` are things only the person can fix (each names the screen that fixes it). Tools that are merely not
   * started are not a blocker: sending a prompt starts them (`startsTools`), because the prompt is the consent.
   * @returns {{ready: boolean, blockers: {id: string, label: string, fix: string}[], mode: string, backend: string, tools: object, startsTools: boolean}}
   */
  function readiness(hub, { connected = true, mismatch = false, wrongTransport = null } = {}) {
    const blockers = [];
    const add = (id, label, fix) => blockers.push({ id, label, fix });
    const mode = agentMode(hub);
    const tools = toolsState(hub);
    if (!connected) add('connection', 'Chưa kết nối được Hub. Đang thử lại…', 'retry');
    if (mismatch) add('version', 'Giao diện và Hub không cùng phiên bản. Hãy dừng Hub cũ rồi khởi động lại.', 'restart');
    if (!(hub && hub.workspace && hub.workspace.path)) add('workspace', 'Chưa chọn thư mục dự án.', 'workspace');
    if (mode === 'api' && !(hub && hub.ai && hub.ai.configured)) add('ai', 'Chưa cấu hình AI: chọn nhà cung cấp và nhập API key.', 'ai');
    if (mode === 'chatgpt-web' && !(hub && hub.browser && hub.browser.paired)) add('companion', 'Chưa ghép Browser Companion (chế độ ChatGPT Web).', 'companion');
    if (wrongTransport) add('mode', `Phiên này thuộc chế độ ${wrongTransport}. Hãy chuyển đúng chế độ để tiếp tục.`, 'mode');
    if (tools.starting) add('tools-starting', 'Đang khởi động công cụ của dự án…', 'wait');
    return { ready: blockers.length === 0, blockers, mode, backend: tools.backend, tools, startsTools: blockers.length === 0 && !tools.ready };
  }

  /** One line under the composer: what is happening, or the first thing to fix. */
  function composerHint(r, { running = false, connected = true, pending = 0 } = {}) {
    if (running && pending > 0) return 'Agent đang chờ bạn duyệt ở khung phía trên. Không có gì chạy cho tới khi bạn quyết định.';
    if (running) return 'Agent đang chạy. Bạn có thể Dừng rồi gửi yêu cầu tiếp trong cùng hội thoại.';
    if (!connected) return 'Đang chờ Hub…';
    if (r.blockers.length) return r.blockers[0].label;
    if (r.startsTools) return 'Công cụ của dự án sẽ tự khởi động khi bạn giao việc.';
    return 'Enter để gửi · Shift+Enter xuống dòng · Lịch sử lưu tự động.';
  }

  // ---------------------------------------------------------------------------------------------------------
  // Permission modes
  // ---------------------------------------------------------------------------------------------------------
  const PERMISSION_MODES = Object.freeze([
    { id: 'readonly', label: 'Chỉ đọc', hint: 'Agent chỉ đọc và phân tích. Mọi thay đổi bị từ chối, không hỏi.', risk: 'low' },
    { id: 'review', label: 'Review', hint: 'Agent đọc tự do; mỗi lần sửa file hoặc chạy lệnh đều hỏi bạn trước.', risk: 'medium' },
    { id: 'autonomous', label: 'Tự động', hint: 'Agent tự sửa file và chạy lệnh kiểm tra an toàn; lệnh khác, lệnh nguy hiểm và công cụ lạ vẫn hỏi.', risk: 'high' },
  ]);
  /** "manual" is the old name of review; anything unknown is shown as the safe default. */
  function normalizeMode(mode) {
    if (mode === 'manual') return 'review';
    return PERMISSION_MODES.some((entry) => entry.id === mode) ? mode : 'review';
  }
  const modeInfo = (mode) => PERMISSION_MODES.find((entry) => entry.id === normalizeMode(mode));

  // ---------------------------------------------------------------------------------------------------------
  // Approval requests
  // ---------------------------------------------------------------------------------------------------------
  const CATEGORY = Object.freeze({
    read: { label: 'Đọc dữ liệu', risk: 'low' },
    checkpoint: { label: 'Sao lưu', risk: 'low' },
    workspace_edit: { label: 'Sửa file hoặc trạng thái dự án', risk: 'medium' },
    execute: { label: 'Chạy lệnh', risk: 'high' },
    dangerous: { label: 'Thao tác nguy hiểm', risk: 'high' },
    unknown: { label: 'Công cụ chưa phân loại', risk: 'high' },
  });
  const COMMAND_KIND = Object.freeze({
    read: 'Lệnh chỉ đọc',
    verify: 'Lệnh kiểm tra (test/build/lint) — có thể ghi file tạm',
    edit: 'Lệnh có thể sửa file',
    exec: 'Chạy chương trình',
    dangerous: 'Lệnh nguy hiểm',
  });

  /**
   * What the person is asked to approve, as rows and text blocks the page can show as plain text.
   * @param {object} request one entry of studio.permissions.pending
   */
  function describeApproval(request, nowMs = Date.now()) {
    const p = obj(request) || {};
    const detail = obj(p.detail);
    const category = Object.hasOwn(CATEGORY, p.category) ? p.category : 'unknown';
    const rows = [];
    const blocks = [];
    const row = (label, value, mono = false) => { const text = value === null || value === undefined || value === '' ? '' : String(value); if (text) rows.push({ label, value: text, mono }); };
    let title = `Gọi công cụ ${str(p.toolName, '(không tên)')}`;
    const kind = detail ? str(detail.kind, 'tool') : 'raw';
    if (kind === 'command') {
      title = 'Chạy lệnh trên máy của bạn';
      blocks.push({ label: 'Lệnh', text: str(detail.command), kind: 'command' });
      row('Thư mục', detail.cwd, true);
      row('Shell', detail.shell);
      row('Phân loại', COMMAND_KIND[detail.assessed_as] || detail.assessed_as);
      if (Number.isFinite(detail.timeout_seconds)) row('Giới hạn thời gian', `${detail.timeout_seconds} giây`);
      if (arr(detail.reasons).length) row('Lý do phân loại', arr(detail.reasons).join('; '));
      row('Agent mô tả', detail.description);
    } else if (kind === 'write') {
      title = 'Ghi file';
      row('Đường dẫn', detail.path, true);
      row('Kích thước', Number.isFinite(detail.bytes) ? `${detail.bytes} byte` : '');
      row('Ghi đè', detail.overwrite ? 'Có — thay toàn bộ nếu file đã tồn tại' : 'Không — chỉ tạo mới hoặc thay file vừa đọc (kiểm tra SHA-256)');
      if (str(detail.head)) blocks.push({ label: 'Nội dung (phần đầu)', text: str(detail.head), kind: 'text' });
    } else if (kind === 'edit') {
      title = 'Sửa file';
      row('Đường dẫn', detail.path, true);
      row('Phạm vi', detail.replace_all ? 'Thay TẤT CẢ chỗ khớp' : 'Thay một chỗ khớp duy nhất');
      blocks.push({ label: 'Đoạn cũ', text: str(detail.old_string), kind: 'before' });
      blocks.push({ label: 'Đoạn mới', text: str(detail.new_string), kind: 'after' });
    } else if (kind === 'tool') {
      blocks.push({ label: 'Tham số', text: str(detail.arguments), kind: 'text' });
    } else if (str(p.preview)) {
      blocks.push({ label: 'Tham số', text: str(p.preview), kind: 'text' });
    }
    const expires = Date.parse(str(p.expiresAt));
    return {
      id: str(p.id), taskId: str(p.taskId), tool: str(p.toolName), title, kind,
      category, categoryLabel: CATEGORY[category].label, risk: CATEGORY[category].risk,
      summary: clip(p.summary, 400), reason: clip(p.reason, 400), rows, blocks,
      secondsLeft: Number.isFinite(expires) ? Math.max(0, Math.round((expires - nowMs) / 1000)) : null,
    };
  }

  /** "9:41" for the time left on an approval request; empty when unknown. */
  function countdown(seconds) {
    if (!Number.isFinite(seconds)) return '';
    const total = Math.max(0, Math.floor(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  /** Text for the browser tab, so a request waiting for approval is noticed from another window. */
  function documentTitle(hub, { base = 'ChatMCP Studio' } = {}) {
    const pending = arr(hub && hub.studio && hub.studio.permissions && hub.studio.permissions.pending).length;
    if (pending > 0) return `(${pending}) Cần duyệt — ${base}`;
    if (hub && hub.agent && hub.agent.activeTaskId) return `Đang chạy — ${base}`;
    return base;
  }

  // ---------------------------------------------------------------------------------------------------------
  // AI connection (Settings and onboarding)
  // ---------------------------------------------------------------------------------------------------------
  const PROTOCOLS = Object.freeze([
    { id: 'anthropic', label: 'Anthropic Messages' },
    { id: 'openai-chat', label: 'OpenAI-compatible (chat completions)' },
    { id: 'gemini', label: 'Gemini generateContent' },
  ]);
  const AUTH_MODES = Object.freeze(['auto', 'bearer', 'google-key']);

  function toolCallingBadge(ai) {
    const status = str(ai && ai.toolCalling, 'unchecked');
    const note = str(ai && ai.toolCallingNote);
    switch (status) {
      case 'supported': return { status, kind: 'success', label: 'Tool calling hoạt động', note };
      case 'unsupported': return { status, kind: 'error', label: 'Model không hỗ trợ tool calling', note };
      case 'unreliable': return { status, kind: 'warn', label: 'Tool calling chưa đáng tin', note };
      case 'unknown': return { status, kind: 'neutral', label: 'Chưa xác định được tool calling', note };
      default: return { status: 'unchecked', kind: 'neutral', label: 'Chưa kiểm tra tool calling — bấm Test API', note: '' };
    }
  }

  /** How the key is held right now, in words. Never shows (or knows) the key itself. */
  function keyStatus(ai) {
    const source = str(ai && ai.keySource, 'none');
    const protection = str(ai && ai.secretStorage && ai.secretStorage.protection);
    if (source === 'saved') return { source, kind: 'success', text: `Key đã lưu${protection ? ` (${protection})` : ''}.` };
    if (source === 'environment') return { source, kind: 'success', text: 'Đang dùng key từ biến môi trường (không lưu vào file).' };
    if (source === 'session') return { source, kind: 'warn', text: 'Key chỉ giữ trong bộ nhớ của Hub; mất khi Hub dừng.' };
    if (ai && ai.keyRequired === false) return { source, kind: 'neutral', text: 'Máy chủ cục bộ: không cần API key.' };
    return { source: 'none', kind: 'error', text: 'Chưa có API key.' };
  }

  /** The form after choosing a provider: its values, nothing carried over from the previous one (the Hub does the same). */
  function draftFromPreset(preset, current) {
    const p = obj(preset) || {};
    return {
      preset: str(p.id), protocol: str(p.protocol, 'openai-chat'), apiBaseUrl: str(p.apiBaseUrl), model: str(p.defaultModel), authMode: str(p.authMode, 'auto'),
      customPath: '', contextWindowTokens: Number.isFinite(p.contextWindowTokens) && p.contextWindowTokens ? String(p.contextWindowTokens) : '',
      apiKey: '', useEnvKey: false, remember: Boolean(current && current.remember),
    };
  }

  /** The form as the Hub currently has it configured. */
  function draftFromState(ai) {
    const a = obj(ai) || {};
    return {
      preset: str(a.preset), protocol: str(a.protocol, 'gemini'), apiBaseUrl: str(a.apiBaseUrl), model: str(a.model), authMode: str(a.authMode, 'auto'),
      customPath: str(a.customPath), contextWindowTokens: Number.isFinite(a.contextWindowTokens) && a.contextWindowTokens ? String(a.contextWindowTokens) : '',
      apiKey: '', useEnvKey: false, remember: false,
    };
  }

  /** Problems the form can find on its own. The Hub validates again; this saves a round trip and says what to type. */
  function validateDraft(draft, preset, ai) {
    const d = obj(draft) || {};
    const problems = [];
    if (!str(d.apiBaseUrl).trim()) problems.push({ field: 'apiBaseUrl', text: 'Nhập địa chỉ API (Base URL).' });
    else if (!/^https?:\/\//i.test(d.apiBaseUrl.trim())) problems.push({ field: 'apiBaseUrl', text: 'Base URL phải bắt đầu bằng https:// (hoặc http://localhost cho máy chủ cục bộ).' });
    if (!str(d.model).trim()) problems.push({ field: 'model', text: 'Nhập tên model.' });
    if (str(d.contextWindowTokens).trim() && !/^\d+$/.test(str(d.contextWindowTokens).trim())) problems.push({ field: 'contextWindowTokens', text: 'Ngữ cảnh model phải là số token (để trống nếu không biết).' });
    const local = Boolean(preset && preset.local) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(str(d.apiBaseUrl).trim());
    const keyHeld = str(ai && ai.keySource, 'none') !== 'none' && sameOrigin(d.apiBaseUrl, ai && ai.apiBaseUrl) && (!d.preset || d.preset === str(ai && ai.preset));
    if (!local && !str(d.apiKey).trim() && !d.useEnvKey && !keyHeld) problems.push({ field: 'apiKey', text: 'Nhập API key (hoặc chọn dùng biến môi trường nếu Hub thấy key).' });
    return problems;
  }
  function sameOrigin(a, b) {
    try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
  }

  /** Body of POST /api/ai/config. The key is sent only when typed; an empty field never erases a stored key. */
  function configPayload(draft) {
    const d = obj(draft) || {};
    const payload = {
      preset: str(d.preset) || undefined, protocol: str(d.protocol), apiBaseUrl: str(d.apiBaseUrl).trim(), model: str(d.model).trim(),
      authMode: str(d.authMode, 'auto'), customPath: str(d.customPath).trim(), remember: Boolean(d.remember),
    };
    const window = str(d.contextWindowTokens).trim();
    payload.contextWindowTokens = window ? Number(window) : null;
    if (str(d.apiKey).trim()) payload.apiKey = d.apiKey.trim();
    else if (d.useEnvKey === true) payload.useEnvKey = true;
    if (payload.preset === undefined) delete payload.preset;
    return payload;
  }

  /** Pick a model the list actually contains if the typed one is not there; never silently changes anything. */
  function modelChoices(models, current) {
    const list = arr(models).filter((m) => obj(m) && str(m.id));
    const ids = list.map((m) => m.id);
    return { ids, currentListed: ids.includes(current), onlyConfigured: list.length > 0 && list.every((m) => m.configured === true && m.listed === false) };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Evidence, errors, onboarding
  // ---------------------------------------------------------------------------------------------------------
  // The Hub records why a task changed state as a short code. A person reads words, so known codes are translated and an
  // unknown code is shown as it is (nothing is hidden).
  const REASONS = Object.freeze({
    task_created: 'Tác vụ được tạo',
    start_requested: 'Bạn giao việc mới',
    continue_requested: 'Bạn tiếp tục hội thoại',
    preflight_done: 'Kiểm tra xong, agent bắt đầu đọc dự án',
    approval_approved: 'Bạn đã cho phép',
    approval_denied: 'Bạn đã từ chối',
    approval_expired: 'Yêu cầu hết hạn nên bị từ chối',
    approval_cancelled: 'Yêu cầu bị hủy',
    check_finished: 'Lệnh kiểm tra đã xong',
    final_answer: 'Agent đã trả lời kết thúc',
    user_cancelled: 'Bạn đã dừng tác vụ',
    shutdown: 'Hub tắt khi tác vụ đang chạy',
    time_limit: 'Hết thời gian cho phép',
    step_limit: 'Đạt giới hạn số bước',
    context_limit: 'Đạt giới hạn ngữ cảnh',
    output_limit: 'Đạt giới hạn đầu ra',
    hub_restarted: 'Hub khởi động lại giữa chừng',
    reconciled_on_load: 'Hub đối chiếu lại trạng thái khi khởi động',
    migrated_from_status: 'Chuyển từ phiên bản cũ',
    persistence_failed: 'Không ghi được trạng thái xuống đĩa',
    task_failed: 'Tác vụ thất bại',
  });
  const REASON_PREFIX = Object.freeze({ approval: 'Chờ bạn duyệt', check: 'Đang chạy kiểm tra', act: 'Đang thực hiện' });
  function reasonText(reason) {
    const code = str(reason);
    if (!code) return '';
    if (Object.hasOwn(REASONS, code)) return REASONS[code];
    const prefixed = /^(approval|check|act):(.+)$/.exec(code);
    return prefixed ? `${REASON_PREFIX[prefixed[1]]}: ${prefixed[2]}` : code;
  }

  /**
   * The text of a timeline event. The Hub stores a tool result as pretty-printed JSON; a person wants the text inside it
   * (the command's output, the file's header). Anything that is not such an object is shown as it is, clipped.
   */
  function eventText(event, limit = 400) {
    const e = obj(event) || {};
    const raw = str(e.message, str(e.type));
    if ((e.type === 'tool_result' || e.type === 'tool_error') && raw.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (obj(parsed) && Array.isArray(parsed.content)) {
          const text = parsed.content.map((part) => (obj(part) && typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n').trim();
          if (text) return clip(text, limit);
        }
      } catch (_) { /* cut off or not JSON: show it as it is */ }
    }
    return clip(raw, limit);
  }

  /** What the agent actually did, from the workflow record (GET /api/studio/workflow). */
  function evidenceSummary(workflow) {
    const w = obj(workflow);
    if (!w) return null;
    const edits = Number(w.editsObserved) || 0;
    const commands = Number(w.commandsObserved) || 0;
    const checks = Number(w.checksObserved) || 0;
    const verified = w.verified === true;
    const parts = [];
    if (edits) parts.push(`${edits} thao tác sửa file thành công`);
    // A shell command can change anything and the Hub cannot tell what: say so instead of claiming no file was touched.
    if (commands) parts.push(`${commands} lệnh shell có thể đã thay đổi file (xem Git diff)`);
    if (!edits && !commands) parts.push('Chưa sửa file nào');
    parts.push(verified ? `${checks} lệnh kiểm tra đã chạy và đạt (exit code 0)` : 'CHƯA có lệnh kiểm tra nào chạy thành công');
    return { edits, commands, checks, verified, text: parts.join(' · '), kind: verified ? 'success' : (edits || commands ? 'warn' : 'neutral') };
  }

  // A recorded call counts as "possibly in effect" unless it never started or only read (same rule as lib/task-state.mjs).
  const NOT_STARTED = ['awaiting_approval', 'refused'];
  const mayHaveChanged = (call) => Boolean(obj(call)) && call.readOnly !== true && !NOT_STARTED.includes(call.phase);

  /** Calls whose outcome the Hub does not know, from the full task view: [{tool, startedAt}]. */
  function unconfirmedOperations(task) {
    const t = obj(task);
    if (!t) return [];
    const calls = [...arr(t.unverifiedOperations), ...(t.pendingCall ? [t.pendingCall] : [])].filter(mayHaveChanged);
    const seen = new Set();
    const out = [];
    for (const call of calls) {
      const key = `${str(call.callId)}|${str(call.toolName)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tool: str(call.toolName, '(không rõ)'), startedAt: str(call.startedAt) });
    }
    return out;
  }

  /**
   * The message that continues a stopped task. After an uncertain stop it tells the model not to assume the unconfirmed
   * step happened (or did not), and to look at the project first; the Hub itself never re-runs that step.
   */
  function resumePrompt(task) {
    if (taskState(task) === 'uncertain') {
      const tools = [...new Set(unconfirmedOperations(task).map((operation) => operation.tool))];
      const what = tools.length ? `thao tác ${tools.join(', ')}` : 'một thao tác';
      return `Lần chạy trước dừng khi ${what} chưa rõ kết quả. Đừng giả định thao tác đó đã chạy hay chưa: hãy kiểm tra trạng thái hiện tại của dự án (git status, git diff, đọc lại file liên quan) rồi mới tiếp tục phần còn lại.`;
    }
    return 'Hãy tiếp tục từ chỗ đã dừng. Trước hết kiểm tra trạng thái hiện tại của dự án (git status, git diff), rồi làm nốt phần còn lại và chạy kiểm thử.';
  }

  /** Where a failed task should send the person. */
  function errorFix(code) {
    switch (code) {
      case 'gateway_auth': case 'gateway_quota': case 'gateway_model_not_found': case 'provider_not_ready': case 'gateway_not_ready': case 'gateway_context_length': case 'missing_key': return 'ai';
      case 'workspace_missing': case 'workspace_changed': return 'workspace';
      default: return null;
    }
  }

  /**
   * First-run guidance. `complete` means a task could be sent right now; the wizard opens by itself only for the
   * local backend and only until the person dismisses it (the dismissal is the page's, kept per browser).
   */
  function onboarding(hub, { dismissed = false } = {}) {
    const local = backendOf(hub) === 'local';
    const mode = agentMode(hub);
    const workspace = Boolean(hub && hub.workspace && hub.workspace.path);
    const toolsOk = toolsState(hub).ready;
    const ai = mode === 'api' ? Boolean(hub && hub.ai && hub.ai.configured) : Boolean(hub && hub.browser && hub.browser.paired);
    const steps = [
      { id: 'workspace', title: 'Thư mục dự án', done: workspace && (toolsOk || !local) },
      { id: 'ai', title: mode === 'api' ? 'Kết nối AI' : 'Ghép Companion', done: ai },
      { id: 'safety', title: 'Quyền của agent', done: false },
      { id: 'ready', title: 'Sẵn sàng', done: false },
    ];
    const complete = workspace && ai;
    const first = steps.find((step) => !step.done && (step.id === 'workspace' || step.id === 'ai'));
    return { steps, complete, current: first ? first.id : 'safety', shouldOpen: local && !dismissed && !complete };
  }

  const api = Object.freeze({
    STATES, ACTIVE, PERMISSION_MODES, PROTOCOLS, AUTH_MODES, CATEGORY,
    isActiveState, taskState, describeTask, tagKind,
    backendOf, agentMode, toolsState, readiness, composerHint,
    normalizeMode, modeInfo,
    describeApproval, countdown, documentTitle,
    toolCallingBadge, keyStatus, draftFromPreset, draftFromState, validateDraft, configPayload, modelChoices,
    evidenceSummary, reasonText, eventText, errorFix, onboarding, unconfirmedOperations, resumePrompt,
  });
  root.ChatMcpUi = api;
})(typeof window !== 'undefined' ? window : globalThis);
