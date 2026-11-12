// What a task that the editor loads again is replayed as (plan task ux-21, session/load): the protocol asks the agent to send the whole conversation back as session/update
// messages before it answers the load.
//
// The record of the Hub has the conversation (`dialogue`: what the person asked and what the model answered, per run) and the events (the calls and the messages of the model as
// they happened). The two are put in the order of their time; the events go through the same mapping as a live turn (lib/acp/event-map.mjs), so a call is replayed exactly as it was
// told, and an answer of the dialogue is told only for what no message of the model already said. The plan of the task comes last. The use of the context is not replayed: it was the
// size of the context at a moment that has passed.
import { createTurnMapper } from './event-map.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const wholeCount = (value) => Number.isSafeInteger(value) && value >= 0;
const RANK = { user: 0, event: 1, assistant: 2 };

/**
 * @param {object} task  the record of the task, as GET /api/tasks/<id> returns it
 * @param {{cwd: string}} options
 * @returns {{updates: object[], cursor: number, usageMark: {requests: number, input: number, output: number}|null}}
 *   `cursor`: how many events the record has, so that the next turn tells only what is new; `usageMark`: the usage the next turn counts from
 */
export function replayUpdates(task, { cwd }) {
  if (!isObject(task)) return { updates: [], cursor: 0, usageMark: null };
  const events = Array.isArray(task.events) ? task.events.filter(isObject) : [];
  const dialogue = Array.isArray(task.dialogue) ? task.dialogue.filter((entry) => isObject(entry) && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string' && entry.text.trim()) : [];
  const items = [
    ...dialogue.map((entry, index) => ({ at: String(entry.at ?? ''), rank: RANK[entry.role], index, entry })),
    ...events.map((event, index) => ({ at: String(event.at ?? ''), rank: RANK.event, index, event })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.rank - b.rank || a.index - b.index);

  const mapper = createTurnMapper({ cwd });
  const updates = [];
  const seen = [];
  let saidInRun = []; // what the model said as messages since the last message of the person: the answer of the dialogue often begins with it
  for (const item of items) {
    if (item.event) {
      seen.push(item.event);
      if (item.event.type === 'assistant' && typeof item.event.message === 'string' && item.event.message.trim()) saidInRun.push(item.event.message.trim());
      updates.push(...mapper.next({ events: seen, eventCount: seen.length }).filter((update) => update.sessionUpdate !== 'usage_update'));
    } else if (item.entry.role === 'user') {
      saidInRun = [];
      updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: item.entry.text } });
    } else {
      // The answer is told only for what no message of the model said: all of it, nothing, or what follows the words that were said (a notice of the Hub).
      let rest = item.entry.text.trim();
      const said = saidInRun.join('\n\n');
      if (said && rest.startsWith(said)) rest = rest.slice(said.length).trim();
      if (rest) updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: rest } });
    }
  }
  updates.push(...mapper.next({ events: seen, eventCount: seen.length, goalPlan: task.goalPlan }).filter((update) => update.sessionUpdate === 'plan'));

  const total = wholeCount(task.eventCount) && task.eventCount >= events.length ? task.eventCount : events.length;
  const usage = task.usage;
  const usageMark = isObject(usage) && wholeCount(usage.httpRequests) && wholeCount(usage.inputTokens) && wholeCount(usage.outputTokens)
    ? { requests: usage.httpRequests, input: usage.inputTokens, output: usage.outputTokens } : null;
  return { updates, cursor: total, usageMark };
}
