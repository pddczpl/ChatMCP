import type { Task, TaskStatus, TaskDetail, TaskSummary, Message, ToolCall, ApprovalRequest } from '../types/index';

const activeStates = new Set(['queued', 'planning', 'running', 'waiting_approval', 'verifying']);
const restingStates = new Set(['paused', 'completed', 'failed', 'cancelled', 'uncertain']);
const stateLabels: Record<string, string> = {
  created: 'Mới tạo', queued: 'Đang chờ', blocked: 'Chờ xử lý phụ thuộc', planning: 'Đọc và lập kế hoạch',
  running: 'Đang thực hiện', waiting_approval: 'Chờ bạn duyệt', verifying: 'Đang kiểm tra',
  paused: 'Tạm dừng', completed: 'Đã nhận phản hồi kết thúc', failed: 'Thất bại',
  cancelled: 'Đã dừng', uncertain: 'Chưa rõ kết quả',
};

export function isTaskActive(task?: { status?: string; state?: string } | null): boolean {
  return !!task && activeStates.has(task.state || task.status || '');
}

export function canContinueTask(task?: { status?: string; state?: string } | null): boolean {
  return !!task && restingStates.has(task.state || task.status || '');
}

export function taskStateLabel(status: string): string {
  return stateLabels[status] || status || 'Chưa rõ trạng thái';
}

function time(value?: string | number | null): number {
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function resultFailed(value: unknown): boolean {
  if (typeof value === 'string') {
    try { return resultFailed(JSON.parse(value)); } catch { return false; }
  }
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.isError === true || (typeof record.exitCode === 'number' && record.exitCode !== 0)) return true;
  if (Array.isArray(record.content)) return record.content.some(part => part?.type === 'text' && resultFailed(part.text));
  return false;
}

/** Adapt the Hub's public task record. Text only comes from recorded prompts, dialogue, runs or events. */
export function normalizeTask(input: TaskDetail | TaskSummary): Task {
  const raw = input as TaskDetail;
  const candidate = raw.state || (raw.status === 'limit' ? 'paused' : raw.status) || 'created';
  const status: TaskStatus = Object.hasOwn(stateLabels, candidate) ? candidate as TaskStatus : 'unknown';
  const messages: Message[] = [];
  const runs = raw.runs || [];
  const dialogue = raw.dialogue || [];
  const runAt = (at?: string | number) => {
    let index = -1;
    for (let i = runs.length - 1; i >= 0; i--) {
      if (time(runs[i].startedAt) <= time(at)) { index = i; break; }
    }
    return index < 0 ? 1 : index + 1;
  };
  dialogue.forEach((entry, index) => {
    if (entry.text && ['user', 'assistant', 'system'].includes(entry.role)) {
      messages.push({ id: `dialogue:${index}`, role: entry.role as Message['role'], content: entry.text, timestamp: entry.at });
    }
  });
  // Older persisted sessions have no dialogue until their next continuation. Recover each missing run independently.
  const prompts = raw.prompts?.length ? raw.prompts : raw.prompt ? [{ text: raw.prompt, at: raw.startedAt }] : [];
  prompts.forEach((prompt, index) => {
    const hasUser = dialogue.some(entry => entry.role === 'user' && (entry.run ?? runAt(entry.at)) === index + 1);
    if (prompt.text && !hasUser) messages.push({ id: `prompt:${index}`, role: 'user', content: prompt.text, timestamp: prompt.at || runs[index]?.startedAt });
  });
  runs.forEach((run, index) => {
    const hasResponse = dialogue.some(entry => entry.role !== 'user' && (entry.run ?? runAt(entry.at)) === index + 1);
    if (run.finalText && !hasResponse) messages.push({ id: `run:${index}`, role: run.status === 'completed' ? 'assistant' : 'system', content: run.finalText, timestamp: run.finishedAt || undefined });
  });

  if (raw.finalText && !messages.some(message => message.role === 'assistant' && message.content === raw.finalText && runAt(message.timestamp) === Math.max(1, runs.length))) {
    messages.push({ id: 'final', role: 'assistant', content: raw.finalText, timestamp: raw.finishedAt || undefined });
  }
  // A final assistant event is also recorded in dialogue. The Hub publishes an
  // exact 12,000-character preview for longer event text (lib/agent.mjs clip).
  // Only replace that preview when the same run contains its full recorded reply.
  const recordedReplies = messages.filter(message => message.role === 'assistant');
  (raw.events || []).forEach((event, index) => {
    if (event.type !== 'assistant' || !event.message) return;
    const duplicate = recordedReplies.some(message => {
      if (runAt(message.timestamp) !== runAt(event.at)) return false;
      const preview = message.content.length > 12000
        ? `${message.content.slice(0, 12000)}\n[Phần còn lại được lưu trong bản ghi trên máy.]`
        : message.content;
      return message.content === event.message || preview === event.message;
    });
    if (!duplicate) messages.push({ id: `event:${index}`, role: 'assistant', content: event.message, timestamp: event.at });
  });
  messages.sort((a, b) => time(a.timestamp) - time(b.timestamp));

  const toolCalls: ToolCall[] = [];
  for (const [index, event] of (raw.events || []).entries()) {
    if (!event.toolName || !['tool_start', 'tool_result', 'tool_error'].includes(event.type)) continue;
    if (event.type === 'tool_start') {
      const currentRun = runAt(event.at) === Math.max(1, runs.length);
      toolCalls.push({ id: `tool:${index}`, name: event.toolName, summary: event.message, args: event.input, timestamp: event.at, status: activeStates.has(status) && currentRun ? 'running' : 'unknown' });
    } else {
      // The public event schema has no call IDs. Pair the last unmatched name in this run only.
      // A continuation must never make an unresolved operation from an earlier run look replayed or settled.
      const call = [...toolCalls].reverse().find(tool => tool.name === event.toolName && tool.result === undefined && runAt(tool.timestamp) === runAt(event.at));
      const result = event.output ?? event.message;
      const outcome = event.type === 'tool_error' || resultFailed(result) ? 'error' : 'success';
      if (call) {
        call.result = result;
        call.status = outcome;
        call.durationMs = event.durationMs ?? Math.max(0, time(event.at) - time(call.timestamp));
      } else {
        toolCalls.push({ id: `tool:${index}`, name: event.toolName, result, status: outcome, timestamp: event.at, durationMs: event.durationMs });
      }
    }
  }

  return {
    ...raw,
    task: raw.prompt,
    status,
    state: status,
    runnerStatus: raw.status,
    createdAt: raw.createdAt || raw.startedAt,
    finishedAt: raw.finishedAt || undefined,
    messages,
    toolCalls,
    lastMessage: messages.at(-1)?.content,
    stage: raw.stateReason || undefined,
    error: raw.error || undefined,
  };
}

export type TimelineItem = { kind: 'message'; value: Message } | { kind: 'tool'; value: ToolCall };

export function taskTimeline(task: Task): TimelineItem[] {
  return [
    ...task.messages.map(value => ({ kind: 'message' as const, value })),
    ...(task.toolCalls || []).map(value => ({ kind: 'tool' as const, value })),
  ].sort((a, b) => time(a.value.timestamp) - time(b.value.timestamp));
}

export interface ApprovalView {
  id: string;
  taskId?: string;
  tool: string;
  description: string;
  risk: string;
  reason?: string;
  targetPath?: string;
  oldContent?: string;
  newContent?: string;
  command?: string;
  preview?: string;
  diff?: string;
  expiresAt?: string;
  decision?: string;
  detail?: Record<string, unknown>;
}

export function normalizeApproval(raw: ApprovalRequest): ApprovalView {
  const detail = raw.detail && typeof raw.detail === 'object' ? raw.detail as Record<string, unknown> : undefined;
  return {
    id: raw.id, taskId: raw.taskId, tool: raw.toolName || raw.category,
    description: raw.summary || raw.reason || raw.toolName || raw.category,
    risk: raw.category, reason: raw.reason,
    targetPath: typeof detail?.path === 'string' ? detail.path : raw.file,
    oldContent: typeof detail?.old_string === 'string' ? detail.old_string : undefined,
    newContent: typeof detail?.new_string === 'string' ? detail.new_string : undefined,
    command: typeof detail?.command === 'string' ? detail.command : raw.command,
    preview: raw.preview, diff: raw.diff, expiresAt: raw.expiresAt, decision: raw.decision, detail,
  };
}
