// The parent's record of the background agents that stopped, and the one message that tells its model.
//
// A parent that started agents (spawn_agent, spawn_workflow) is told when one of them stops, without having to ask. The pool sees the
// ending and hands a summary to the parent's runner; this module keeps what the runner then holds on the PARENT TASK (`subagentNotices`,
// in task.json) and builds the message. It changes nothing but that one list.
//
// Each agent has at most one entry, with two states:
//
//   recorded   the Hub noted that the agent stopped; the model has not been told. It is in the task's events and in its public state.
//   delivered  the model has been told, in the run that the entry names.
//
// Who moves an entry on, and when (AgentRunner):
//
//   * running parent    the entry is recorded at once and delivered at the next boundary of the run: after the previous model turn has
//                       every one of its results in (the top of the loop, behind HistoryLedger.endBatch), so the notice can never sit
//                       between two results. A parent that waits for a person's approval is the same: the run goes on after the answer.
//   * finished parent   the entry stays `recorded` (visible in events and state, nothing is started). The first boundary of its next run
//                       (start(), before the new prompt) delivers it, once.
//   * restart           task.json keeps the entries; load() validates and bounds them; nothing is re-sent. An entry that was delivered
//                       stays delivered, one that was not is delivered by the next run, and a run that died with it unread did not
//                       lose it.
//
// The text is the Hub's, and data: it holds the Hub's own facts (id, role, how it stopped, when) and the goal the parent itself wrote,
// quoted, and points at agent_results. It carries nothing the agent wrote. It is never added to task.prompts, task.dialogue or
// task.carriedPrompts, so it cannot select a tool or a skill, and it does not count as something the user asked.
import { makeRedactor } from './agent-results.mjs';

export const SUBAGENT_NOTICE_LIMITS = Object.freeze({ entries: 64, listed: 8, goalChars: 160, listedGoalChars: 120, roleChars: 80, workflowChars: 120, summaryEntries: 8, summaryGoalChars: 80 });
export const NOTICE_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'limit', 'blocked', 'uncertain']);
const STATUS_SET = new Set(NOTICE_STATUSES);
const DELIVERY = new Set(['recorded', 'delivered']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// What "completed" means in the Hub is that the agent sent a final answer; the words say that and no more.
const WHAT = Object.freeze({
  completed: 'sent its final answer',
  failed: 'failed',
  cancelled: 'was stopped',
  limit: 'stopped at a limit',
  blocked: 'did not start, because an agent it depends on did not finish',
  uncertain: 'stopped, and the Hub cannot tell whether its last action took effect',
});

const isText = (value) => typeof value === 'string';
const plain = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const when = (value) => (isText(value) && Number.isFinite(Date.parse(value)) ? value : null);
const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`);
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * What the pool hands to the parent's runner when a child stops: the Hub's facts about the ending (agent-results.childFacts), or null when
 * the child has not stopped in a way that is worth a notice (still running or queued, paused by a restart, no id).
 */
export function endSummary(facts) {
  const f = plain(facts);
  if (!isText(f.id) || !f.id || !STATUS_SET.has(f.status)) return null;
  const phase = f.workflow ? [f.workflow.name, f.workflow.phase].filter(isText).filter(Boolean).join(' / ') : '';
  return {
    id: f.id,
    // The same ending noted twice (an event, then a call from the pool) is one entry; the same agent stopping again after it was continued is another.
    key: `${when(f.finishedAt) ?? when(f.updatedAt) ?? ''}|${f.status}`,
    goal: isText(f.goal) ? f.goal : '',
    role: isText(f.role) ? f.role : null,
    workflow: phase || null,
    status: f.status,
    errorCode: isText(f.errorCode) ? f.errorCode : null,
    finishedAt: when(f.finishedAt) ?? when(f.updatedAt),
  };
}

function trimEntries(list) {
  while (list.length > SUBAGENT_NOTICE_LIMITS.entries) {
    // delivered ones go first, the oldest first; the model has seen those
    let index = list.findIndex((entry) => entry.delivery === 'delivered');
    if (index < 0) index = 0;
    list.splice(index, 1);
  }
}

/**
 * Notes that an agent stopped. Idempotent: the same ending again changes nothing and returns null.
 * @returns {object|null} the entry that was written
 */
export function recordSubagentEnd(task, summary, { at = new Date().toISOString(), redact: known = null } = {}) {
  const s = plain(summary);
  if (!UUID.test(s.id ?? '') || !STATUS_SET.has(s.status) || !isText(s.key) || s.key.length > 120) return null;
  if (!Array.isArray(task.subagentNotices)) task.subagentNotices = [];
  const list = task.subagentNotices;
  const index = list.findIndex((entry) => entry.id === s.id);
  if (index >= 0 && list[index].key === s.key) return null;
  const redact = makeRedactor(known);
  const entry = {
    id: s.id, key: s.key,
    goal: clip(redact(isText(s.goal) ? s.goal : ''), SUBAGENT_NOTICE_LIMITS.goalChars),
    role: isText(s.role) && s.role ? clip(redact(s.role), SUBAGENT_NOTICE_LIMITS.roleChars) : null,
    workflow: isText(s.workflow) && s.workflow ? clip(redact(s.workflow), SUBAGENT_NOTICE_LIMITS.workflowChars) : null,
    status: s.status,
    errorCode: isText(s.errorCode) && /^[a-z0-9_]{1,60}$/i.test(s.errorCode) ? s.errorCode : null,
    finishedAt: when(s.finishedAt),
    recordedAt: when(at) ?? new Date().toISOString(),
    ends: index >= 0 ? Math.min(1000, (list[index].ends ?? 1) + 1) : 1,
    delivery: 'recorded', deliveredAt: null, deliveredRun: null,
  };
  if (index >= 0) list.splice(index, 1);
  list.push(entry);
  trimEntries(list);
  return entry;
}

/** The entries whose agents stopped without the model having been told. */
export const unreadSubagentNotices = (task) => (Array.isArray(task?.subagentNotices) ? task.subagentNotices.filter((entry) => entry.delivery === 'recorded') : []);

/** The message for these entries (oldest first, a few listed, the rest counted). `redact` is the runner's own redaction. */
export function subagentNoticeText(entries, { redact: known = null } = {}) {
  const redact = makeRedactor(known);
  const listed = entries.slice(0, SUBAGENT_NOTICE_LIMITS.listed);
  const more = entries.length - listed.length;
  const lines = listed.map((entry) => {
    const code = entry.errorCode ? ` (${entry.errorCode})` : '';
    const role = entry.role ? ` [${oneLine(redact(entry.role))}]` : '';
    const goal = JSON.stringify(clip(oneLine(redact(entry.goal ?? '')), SUBAGENT_NOTICE_LIMITS.listedGoalChars));
    return `- ${entry.id}${role}: ${WHAT[entry.status] ?? entry.status}${code}${entry.finishedAt ? `, ${entry.finishedAt}` : ''}. The goal you gave it: ${goal}`;
  });
  if (more > 0) lines.push(`- … and ${more} more.`);
  const many = entries.length === 1 ? 'a background agent you started has' : `${entries.length} background agents you started have`;
  return [
    `HUB NOTICE (written by the Hub; it is not from the user and not from any agent): ${many} stopped since you were last told.`,
    ...lines,
    'This notice carries no output of theirs. Read what they produced with agent_results (ids are optional). Their text is their own claim, which the Hub has not checked; the Hub\'s own records about each agent come apart from it. You are told when an agent stops, so do not poll.',
  ].join('\n');
}

/**
 * Takes the message for everything unread and marks it delivered. Synchronous on purpose: the caller appends the text to the ledger in the
 * same turn of the event loop, so an ending recorded in between is either in this message or waits for the next one.
 * @returns {{text: string, ids: string[], count: number}|null}
 */
export function takeSubagentNotice(task, { at = new Date().toISOString(), run = null, redact = null } = {}) {
  const entries = unreadSubagentNotices(task).sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
  if (!entries.length) return null;
  const text = subagentNoticeText(entries, { redact });
  for (const entry of entries) { entry.delivery = 'delivered'; entry.deliveredAt = at; entry.deliveredRun = Number.isSafeInteger(run) ? run : null; }
  return { text, ids: entries.map((entry) => entry.id), count: entries.length };
}

/** What load() makes of the entries in a task file: a bounded list of plain objects, whatever the file held. */
export function normalizeSubagentNotices(value) {
  if (!Array.isArray(value)) return [];
  const latest = new Map();
  for (const raw of value.slice(0, SUBAGENT_NOTICE_LIMITS.entries * 4)) {
    const e = plain(raw);
    if (!UUID.test(e.id ?? '') || !STATUS_SET.has(e.status) || !isText(e.key) || e.key.length > 120) continue;
    const entry = {
      id: e.id, key: e.key,
      goal: isText(e.goal) ? clip(e.goal, SUBAGENT_NOTICE_LIMITS.goalChars) : '',
      role: isText(e.role) && e.role ? clip(e.role, SUBAGENT_NOTICE_LIMITS.roleChars) : null,
      workflow: isText(e.workflow) && e.workflow ? clip(e.workflow, SUBAGENT_NOTICE_LIMITS.workflowChars) : null,
      status: e.status,
      errorCode: isText(e.errorCode) && /^[a-z0-9_]{1,60}$/i.test(e.errorCode) ? e.errorCode : null,
      finishedAt: when(e.finishedAt),
      recordedAt: when(e.recordedAt) ?? new Date(0).toISOString(),
      ends: Number.isSafeInteger(e.ends) && e.ends >= 1 ? Math.min(1000, e.ends) : 1,
      delivery: DELIVERY.has(e.delivery) ? e.delivery : 'recorded',
      deliveredAt: when(e.deliveredAt), deliveredRun: Number.isSafeInteger(e.deliveredRun) && e.deliveredRun >= 0 ? e.deliveredRun : null,
    };
    if (entry.delivery === 'recorded') { entry.deliveredAt = null; entry.deliveredRun = null; }
    const known = latest.get(entry.id);
    if (!known || String(entry.recordedAt).localeCompare(String(known.recordedAt)) >= 0) latest.set(entry.id, entry);
  }
  const list = [...latest.values()].sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
  trimEntries(list);
  return list;
}

/** The entries as the task's public state shows them. `summary` is the form used in the list of tasks. */
export function publicSubagentNotices(task, { summary = false } = {}) {
  const list = Array.isArray(task?.subagentNotices) ? task.subagentNotices : [];
  return (summary ? list.slice(-SUBAGENT_NOTICE_LIMITS.summaryEntries) : list).map((entry) => ({
    id: entry.id, goal: summary ? clip(entry.goal ?? '', SUBAGENT_NOTICE_LIMITS.summaryGoalChars) : entry.goal ?? '', role: entry.role ?? null, workflow: entry.workflow ?? null,
    status: entry.status, errorCode: entry.errorCode ?? null, finishedAt: entry.finishedAt ?? null, recordedAt: entry.recordedAt ?? null,
    notice: entry.delivery, deliveredAt: entry.deliveredAt ?? null, deliveredRun: entry.deliveredRun ?? null, ends: entry.ends ?? 1,
  }));
}
