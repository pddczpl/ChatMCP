import type { HubState, TaskDetail, TaskSummary, ApprovalRequest, ProviderPreset } from '@/types';

export const STATES = Object.freeze({
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

export const ACTIVE = Object.freeze(['queued', 'planning', 'running', 'waiting_approval', 'verifying']);
const LEGACY_STATE: Record<string, string> = Object.freeze({ preparing: 'queued', queued: 'queued', running: 'running', completed: 'completed', cancelled: 'cancelled', failed: 'failed', paused: 'paused', interrupted: 'paused', limit: 'paused' });
const LEGACY_LABEL: Record<string, string> = Object.freeze({ preparing: 'Chuẩn bị', interrupted: 'Gián đoạn', limit: 'Đạt giới hạn' });
const TAG_KIND: Record<string, string> = Object.freeze({ idle: 'neutral', active: 'working', attention: 'attention', warn: 'warn', ok: 'success', error: 'error' });

export const PERMISSION_MODES = Object.freeze([
  { id: 'readonly', label: 'Chỉ đọc', hint: 'Chỉ đọc và phân tích; mọi sửa đổi và lệnh bị từ chối.' },
  { id: 'review', label: 'Review', hint: 'Hỏi duyệt trước mỗi lần sửa file hoặc chạy lệnh.' },
  { id: 'autonomous', label: 'Tự động', hint: 'Tự sửa file và chạy lệnh an toàn trong workspace; lệnh khác cần duyệt.' },
]);

export const PROTOCOLS = Object.freeze([
  { id: 'gemini', label: 'Gemini (Google AI Studio)' },
  { id: 'openai-chat', label: 'OpenAI Chat Completions (/chat/completions)' },
  { id: 'openai-assistant', label: 'OpenAI Assistant / Responses API' },
  { id: 'anthropic', label: 'Anthropic Messages (/v1/messages)' },
  { id: 'ollama', label: 'Ollama local (/api/chat)' },
]);

export const AUTH_MODES = Object.freeze(['google-key', 'bearer', 'header-api-key', 'none']);

export function isActiveState(state?: string): boolean {
  return state ? ACTIVE.includes(state) : false;
}

export function taskState(task?: any): string | null {
  if (!task) return null;
  if (typeof task.state === 'string' && Object.hasOwn(STATES, task.state)) return task.state;
  return Object.hasOwn(LEGACY_STATE, task.status) ? LEGACY_STATE[task.status] : null;
}

export function describeTask(task?: any) {
  const state = taskState(task);
  if (!state) return { state: null, label: 'Sẵn sàng', tone: 'idle', kind: 'neutral', hint: '', active: false };
  const info = (STATES as any)[state];
  const legacyOnly = !(task && Object.hasOwn(STATES, String(task.state)));
  const label = legacyOnly && LEGACY_LABEL[task.status] ? LEGACY_LABEL[task.status] : info.label;
  return { state, label, tone: info.tone, kind: TAG_KIND[info.tone] || 'neutral', hint: info.hint, active: isActiveState(state) };
}

export function backendOf(hub?: HubState | null): 'local' | 'mcp' {
  return hub && hub.backend === 'local' ? 'local' : 'mcp';
}

export function agentMode(hub?: HubState | null): string {
  const mode = hub?.agent?.mode;
  if (mode === 'api' || mode === 'chatgpt-web') return mode;
  return backendOf(hub) === 'local' ? 'api' : 'chatgpt-web';
}

export function toolsState(hub?: HubState | null) {
  const services = hub?.services || {};
  if (backendOf(hub) === 'local') {
    const local = services.local || { state: 'ready' };
    return { backend: 'local', ready: local.state === 'ready', starting: local.state === 'starting', state: local.state || 'ready', detail: local.detail || '' };
  }
  const proxy = services.proxy || { state: 'ready' };
  const desktop = services.desktop || { state: 'ready' };
  return { backend: 'mcp', ready: proxy.state === 'ready' && desktop.state === 'ready', state: proxy.state || 'ready', detail: '' };
}

export function readiness(hub?: HubState | null, options: { connected?: boolean; mismatch?: boolean; wrongTransport?: string | null } = {}) {
  const blockers: { id: string; label: string; fix: string }[] = [];
  if (options.mismatch) blockers.push({ id: 'mismatch', label: 'Giao diện và Hub lệch phiên bản', fix: 'retry' });
  if (options.connected === false) blockers.push({ id: 'offline', label: 'Mất kết nối với Hub', fix: 'retry' });
  if (!hub?.workspace?.path) blockers.push({ id: 'workspace', label: 'Chưa chọn thư mục dự án', fix: 'workspace' });
  if (agentMode(hub) === 'api' && !hub?.ai?.configured) blockers.push({ id: 'ai', label: 'Chưa kết nối AI', fix: 'ai' });
  if (options.wrongTransport) blockers.push({ id: 'wrong-transport', label: `Phiên này ở chế độ ${options.wrongTransport}`, fix: 'companion' });

  return {
    ready: blockers.length === 0,
    blockers,
    startsTools: blockers.length === 0,
  };
}

export function countdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function describeApproval(req: ApprovalRequest, now = Date.now()) {
  const expiresAt = req.expiresAt ? Date.parse(req.expiresAt) : null;
  const secondsLeft = expiresAt !== null && !Number.isNaN(expiresAt) ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null;
  return {
    id: req.id,
    risk: req.risk || 'medium',
    categoryLabel: req.category === 'file-write' ? 'Ghi đè file' : req.category === 'command' ? 'Chạy lệnh' : 'Công cụ',
    title: req.title || (req.category === 'file-write' ? 'Sửa file' : 'Thực thi thao tác'),
    summary: req.detail || req.summary || '',
    command: req.command || '',
    file: req.file || '',
    diff: req.diff || '',
    secondsLeft,
  };
}

export function countdownFormatted(expiresAtIso?: string, now = Date.now()): string {
  if (!expiresAtIso) return '';
  const exp = Date.parse(expiresAtIso);
  if (Number.isNaN(exp)) return '';
  const left = Math.max(0, Math.round((exp - now) / 1000));
  return countdown(left);
}

export function reasonText(reason?: string): string {
  if (!reason) return '';
  const map: Record<string, string> = {
    turn_limit: 'Đạt giới hạn lượt trả lời',
    user_cancelled: 'Người dùng yêu cầu dừng',
    approval_rejected: 'Yêu cầu bị từ chối',
    approval_timeout: 'Hết thời gian chờ duyệt',
    error: 'Xảy ra lỗi trong khi xử lý',
  };
  return map[reason] || reason;
}

export function resumePrompt(task: TaskDetail): string {
  return 'Tiếp tục công việc từ bước đang dừng.';
}

export function keyStatus(ai?: HubState['ai']) {
  if (!ai || !ai.configured) return { kind: 'neutral', text: 'Chưa lưu khóa', source: 'none' };
  return { kind: 'success', text: 'Đã lưu khóa an toàn', source: 'saved' };
}

export function toolCallingBadge(ai?: HubState['ai']) {
  if (!ai?.configured) return { kind: 'neutral', label: 'Chưa kết nối' };
  return ai.toolCalling
    ? { kind: 'success', label: 'Tool calling hoạt động' }
    : { kind: 'warn', label: 'Tool calling chưa kiểm tra' };
}
