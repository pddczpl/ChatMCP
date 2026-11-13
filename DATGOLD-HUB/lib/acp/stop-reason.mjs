// How the end of a task on the Hub becomes the end of an ACP turn: the stop-reason table.
//
// The state is the canonical one (lib/task-state.mjs `state`), not the older `status`: a task that hit a limit has the status `limit` and the state `paused`, and a record of a
// background agent that is blocked also shows as `paused`. `status` and `errorCode` are read only to say WHICH limit, in the notice.
//
//   completed                  -> end_turn
//   cancelled                  -> cancelled
//   paused (a limit, or the Hub was restarted)  -> max_turn_requests, with a notice that says which limit and that another message continues the task
//   uncertain                  -> end_turn, with a warning: an action may or may not have taken effect (the Hub never repeats it by itself)
//   failed                     -> an error of the request (JSON-RPC), never a stop reason: the protocol has no "failed" stop reason, and an error is how a client learns of a failure
//   any other state            -> an error: a turn is never decided over without the Hub saying the task is at rest
//   a cancel asked by the client -> cancelled, whatever the task did in the race: the protocol says this stop reason MUST be returned after session/cancel
//
// The names are those of `StopReason` in the schema of the protocol (version 1): end_turn, max_tokens, max_turn_requests, refusal, cancelled. The tests compare them with the schema.
import { ERROR_CODES } from './rpc.mjs';

export const STOP_REASONS = Object.freeze(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
/** The states in which a task is at rest (lib/task-state.mjs REST_STATES). */
export const RESTING_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'paused', 'uncertain']);

const LIMITS = Object.freeze({
  time_limit: 'The task reached its time limit',
  step_limit: 'The task reached its step limit',
  context_limit: 'The task filled the context window of the model',
  output_limit: 'The model reached its output limit',
});
const CONTINUE = 'Send another message to continue the same task.';

/**
 * @param {{state?: unknown, status?: unknown, errorCode?: unknown, error?: unknown}} task  a task as the Hub publishes it
 * @param {{cancelRequested?: boolean}} [options]
 * @returns {{stopReason?: string, notice: null | {severity: string, title: string, description: string}, error: null | {code: number, message: string}}}
 */
export function outcomeOf(task, { cancelRequested = false } = {}) {
  const state = task?.state;
  if (!RESTING_STATES.includes(state)) {
    return { notice: null, error: { code: ERROR_CODES.INTERNAL, message: `Unexpected task state ${JSON.stringify(state ?? null)}: the task is not finished, so the turn cannot end.` } };
  }
  if (cancelRequested) return { stopReason: 'cancelled', notice: null, error: null };
  switch (state) {
    case 'completed': return { stopReason: 'end_turn', notice: null, error: null };
    case 'cancelled': return { stopReason: 'cancelled', notice: null, error: null };
    case 'paused': {
      // Own keys only: an error code of "constructor" or "toString" must not find a function on the prototype of the table.
      const limit = typeof task.errorCode === 'string' && Object.hasOwn(LIMITS, task.errorCode) ? LIMITS[task.errorCode] : undefined;
      return {
        stopReason: 'max_turn_requests', error: null,
        notice: { severity: 'info', title: limit ?? 'The task paused', description: limit ? CONTINUE : `It stopped before it was finished (for example because the Hub was restarted). ${CONTINUE}` },
      };
    }
    case 'uncertain':
      return {
        stopReason: 'end_turn', error: null,
        notice: {
          severity: 'warning', title: 'The task stopped while an action may have been running',
          description: 'DatGold cannot tell whether the last action took effect: it may or may not have. Check the changes (for example with git diff) before you continue; DatGold will not run that action again by itself.',
        },
      };
    default: { // failed
      const reason = typeof task.error === 'string' && task.error.trim() ? task.error.trim() : 'the Hub gave no reason';
      return { notice: null, error: { code: ERROR_CODES.INTERNAL, message: `The task failed: ${reason}` } };
    }
  }
}
