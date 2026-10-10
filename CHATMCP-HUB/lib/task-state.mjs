// The life cycle of a coding task, in one place.
//
// The runner keeps its original `status` field (running / completed / failed / cancelled / limit / paused): the
// dashboard, the auto-resume scheduler and task files written by older releases all depend on it. `state` is the
// finer view a person actually needs: is the agent reading, working, waiting for me, checking its work, or did it
// stop without knowing whether its last action took effect?
//
//   created → queued → planning → running ⇄ waiting_approval / verifying
//                                   └→ completed | failed | cancelled | paused | uncertain
//
// What this module guarantees (the runner relies on all of it):
//   - only the transitions listed in TRANSITIONS are legal; anything else is refused and reported, never applied
//   - a task that stops while a tool call may or may not have taken effect is `uncertain`, never `failed` or
//     `cancelled`, so nobody mistakes "stopped" for "nothing happened"
//   - a stopped task (paused / completed / failed / cancelled / uncertain) moves on only by starting a new run
//     (`queued`): the same conversation can always be continued, but never silently resumed
//   - deriving the state of a stored task is a pure function of the stored fields, so a task file written by an
//     older release, or one found mid-run after a crash, is classified the same way a live task would be
export const TASK_STATES = Object.freeze(['created', 'queued', 'planning', 'running', 'waiting_approval', 'verifying', 'paused', 'completed', 'failed', 'cancelled', 'uncertain']);

/** A run is in progress: the Hub holds the workspace lock for this task. */
export const ACTIVE_STATES = Object.freeze(new Set(['queued', 'planning', 'running', 'waiting_approval', 'verifying']));
/** The run is over. The conversation can be continued, which starts a new run. */
export const REST_STATES = Object.freeze(new Set(['paused', 'completed', 'failed', 'cancelled', 'uncertain']));

const AT_REST_NEXT = Object.freeze(['queued']);
const ENDINGS = Object.freeze(['completed', 'failed', 'cancelled', 'paused', 'uncertain']);

export const TRANSITIONS = Object.freeze({
  created: Object.freeze(['queued', 'failed', 'cancelled']),
  // Nothing has been asked of a tool yet while a run is only queued, so it cannot be `uncertain` or `completed`.
  queued: Object.freeze(['planning', 'failed', 'cancelled', 'paused']),
  planning: Object.freeze(['running', 'waiting_approval', 'verifying', ...ENDINGS]),
  running: Object.freeze(['waiting_approval', 'verifying', ...ENDINGS]),
  // After an answer the agent goes on; a task cannot finish while a decision is still outstanding.
  waiting_approval: Object.freeze(['planning', 'running', 'verifying', 'failed', 'cancelled', 'paused', 'uncertain']),
  verifying: Object.freeze(['running', 'waiting_approval', ...ENDINGS]),
  paused: AT_REST_NEXT,
  completed: AT_REST_NEXT,
  failed: AT_REST_NEXT,
  cancelled: AT_REST_NEXT,
  uncertain: AT_REST_NEXT,
});

export const TASK_STATE_INFO = Object.freeze({
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

export const isTaskState = (value) => typeof value === 'string' && TASK_STATES.includes(value);
export const isActiveState = (value) => ACTIVE_STATES.has(value);
export const isRestState = (value) => REST_STATES.has(value);

export function canTransition(from, to) {
  if (!isTaskState(to)) return false;
  if (!isTaskState(from)) return true; // a task without a recorded state has no history to contradict
  return TRANSITIONS[from].includes(to);
}

const HISTORY_LIMIT = 100;

/**
 * Move a task to a new state and remember why. Mutates `task` (state, stateReason, stateChangedAt, stateHistory).
 * An illegal move is refused and described, never applied: `force` exists for the one place that must record the
 * truth even when the table did not foresee it (a finished task whose record then fails to save).
 *
 * @returns {{ok: boolean, changed: boolean, from: string|null, to: string, entry?: object, error?: string}}
 */
export function applyTransition(task, to, { reason = '', at = new Date().toISOString(), force = false } = {}) {
  const from = isTaskState(task.state) ? task.state : null;
  if (!isTaskState(to)) return { ok: false, changed: false, from, to, error: `Trạng thái không tồn tại: ${String(to).slice(0, 40)}` };
  if (from === to) return { ok: true, changed: false, from, to };
  if (!force && !canTransition(from, to)) return { ok: false, changed: false, from, to, error: `Chuyển trạng thái không hợp lệ: ${from} → ${to}` };
  const entry = { at, from, to, reason: String(reason).slice(0, 200) };
  if (force && !canTransition(from, to)) entry.forced = true;
  task.state = to;
  task.stateReason = entry.reason;
  task.stateChangedAt = at;
  if (!Array.isArray(task.stateHistory)) task.stateHistory = [];
  task.stateHistory.push(entry);
  if (task.stateHistory.length > HISTORY_LIMIT) task.stateHistory.splice(0, task.stateHistory.length - HISTORY_LIMIT);
  return { ok: true, changed: true, from, to, entry };
}

/**
 * Phases of a recorded tool call in which the tool has not been started: it is waiting for the person's approval, or it
 * was refused. (`executing` is the cautious default: from the moment a call is made until the permission guard says
 * otherwise, it may have taken effect.)
 */
export const NOT_STARTED_PHASES = Object.freeze(new Set(['awaiting_approval', 'refused']));

// A recorded call whose outcome matters. A call that never started changed nothing; a call that only reads cannot have
// changed anything, however it ended.
const mayHaveChangedSomething = (call) => !!call && typeof call === 'object' && call.readOnly !== true && !NOT_STARTED_PHASES.has(call.phase);

/**
 * True when the task stopped without knowing whether something it did took effect: a tool call was in flight, or an
 * earlier run left such a call unverified and this run did not finish the job.
 */
export function hasUnknownOutcome(task) {
  if (!task || typeof task !== 'object') return false;
  if (mayHaveChangedSomething(task.pendingCall)) return true;
  return task.status !== 'completed' && Array.isArray(task.unverifiedOperations) && task.unverifiedOperations.some(mayHaveChangedSomething);
}

/**
 * The state of a task that is not running right now, from its stored fields only. A record that still says
 * `running` was written by a Hub that is gone, so it is `paused` (or `uncertain` if a call was in flight).
 */
export function restState(task) {
  const status = task?.status;
  if (status === 'completed') return 'completed';
  if (hasUnknownOutcome(task)) return 'uncertain';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  // limit (steps, time, context, output), paused, interrupted, and running-without-a-runner: all can be continued
  return 'paused';
}

/**
 * The state of any task. For one that is running right now, `task.state` is kept precise by the runner as it works
 * (planning, running, verifying…); `pendingApprovals` lets a caller who knows of an open approval request say so even
 * if the record has not caught up yet.
 */
export function deriveState(task, { live = false, pendingApprovals = 0 } = {}) {
  if (live && task?.status === 'running') {
    if (pendingApprovals > 0) return 'waiting_approval';
    return isActiveState(task.state) ? task.state : 'running';
  }
  return restState(task);
}

/** The text shown next to a state: its label, a tone for the badge and a one-sentence hint about what it means. */
export function describeState(state) {
  return TASK_STATE_INFO[state] ?? { label: String(state ?? ''), tone: 'idle', hint: '' };
}
