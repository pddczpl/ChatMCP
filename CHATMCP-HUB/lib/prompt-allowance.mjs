// How much of its room a run may give to the guidance: the project instructions of the workspace and the index of the skills selected for the request.
//
// What a run's instructions say is sent again with every request of its loop, and so is the index of the skills (it is part of the conversation). Both take room from the history
// budget the run is planned on (resolveEffectiveContextBudget in lib/context-compaction.mjs), and a run whose KNOWN window leaves its history less than HISTORY_FLOOR_TOKENS is
// refused (context_limit, lib/agent.mjs). So neither is allowed to take what the run needs in order to work:
//   - together at most 15% of the planned history: 10% for the project instructions, 5% for the skill index and the definition of skill_load (the tool is paid out of the
//     index's share, so that index and tool together stay inside the 5%);
//   - together at most half of what is left above the floor: even if JSON's escaping doubled what they cost (a character becomes two at most), the history stays above it;
//   - never more than their absolute maxima, 8,192 and 4,096 bytes, which any window with room to spare reaches;
//   - in steps of 256 bytes, so that the few tokens a tool more or less moves the budget by do not move the cut of a block, and with it the prefix a provider caches.
// The same rule serves every window. An unknown one is planned as 32,768 tokens (that is what the run plans its history on), so it gets a share of that plan and not the maxima.
//
// `policy` is what resolveEffectiveContextBudget made of the instructions WITHOUT the guidance and of the tools without skill_load, as the run has them when everything else is in
// place: the guidance is sized last, on the instructions the run really has, and not on a guess of the text that comes after it.

export const HISTORY_FLOOR_TOKENS = 1000;
export const PROMPT_SHARE_PERCENT = Object.freeze({ instructions: 10, index: 5 });
export const INSTRUCTIONS_MAX_BYTES = 8192;
export const INDEX_MAX_BYTES = 4096;
export const STEP_BYTES = 256;
export const BUDGET_SOURCES = Object.freeze(['provider_configuration', 'trusted_model_metadata', 'conservative_fallback']);
export const BUDGET_REASONS = Object.freeze(['maximum', 'window', 'unknown_window']);

const TOTAL_PERCENT = PROMPT_SHARE_PERCENT.instructions + PROMPT_SHARE_PERCENT.index;
// 3.8 bytes to a token: the estimate the budget is planned with (integer arithmetic, so that no float noise moves a step).
const bytesOf = (tokens) => Math.floor((tokens * 38) / 10);
const step = (bytes) => Math.floor(bytes / STEP_BYTES) * STEP_BYTES;
const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);

/**
 * What the guidance may take of a run, from the policy of the run without it.
 * @param {{maxHistoryTokens: number, source?: string, capacityTokens?: number}} policy
 * @param {{toolBytes?: number, rulesBytes?: number}} options `toolBytes`: what the definition of skill_load costs in a request (JSON length), charged to the index's share when
 *   the tool is offered. `rulesBytes`: what the rules of the instructions say more when there is a block (that the files are in it, and not to read them again), charged to the
 *   block's share.
 * @returns {{source: string|null, capacityTokens: number, historyTokens: number, shareTokens: number,
 *   instructions: {bytes: number, tokens: number, percent: number, reason: string, source: string|null, capacityTokens: number, historyTokens: number},
 *   index: {bytes: number, shareBytes: number, withToolBytes: number, tokens: number, percent: number, reason: string, source: string|null, capacityTokens: number, historyTokens: number}}}
 *   `reason` per part: 'maximum' (the part reaches its absolute maximum), 'window' (a known window limits it) or 'unknown_window' (the window is unknown and planned as 32,768 tokens).
 */
export function promptAllowance(policy, { toolBytes = 0, rulesBytes = 0 } = {}) {
  const planned = Number(policy?.maxHistoryTokens);
  const history = Number.isFinite(planned) && planned > 0 ? Math.floor(planned) : 0;
  const source = BUDGET_SOURCES.includes(policy?.source) ? policy.source : null;
  const capacityTokens = count(policy?.capacityTokens);
  const total = Math.max(0, Math.min(Math.floor((history * TOTAL_PERCENT) / 100), Math.floor((history - HISTORY_FLOOR_TOKENS) / 2)));
  const instructionsTokens = Math.floor((total * PROMPT_SHARE_PERCENT.instructions) / TOTAL_PERCENT);
  const indexTokens = total - instructionsTokens;
  const instructionsBytes = Math.min(INSTRUCTIONS_MAX_BYTES, step(Math.max(0, bytesOf(instructionsTokens) - count(rulesBytes))));
  const indexShareBytes = step(bytesOf(indexTokens));
  const indexBytes = Math.min(INDEX_MAX_BYTES, indexShareBytes);
  const reasonOf = (bytes, maximum) => (bytes >= maximum ? 'maximum' : source === 'conservative_fallback' ? 'unknown_window' : 'window');
  const basis = { source, capacityTokens, historyTokens: history };
  return Object.freeze({
    ...basis, shareTokens: total,
    instructions: Object.freeze({ bytes: instructionsBytes, tokens: instructionsTokens, percent: PROMPT_SHARE_PERCENT.instructions, reason: reasonOf(instructionsBytes, INSTRUCTIONS_MAX_BYTES), ...basis }),
    index: Object.freeze({
      bytes: indexBytes, shareBytes: indexShareBytes, withToolBytes: Math.min(INDEX_MAX_BYTES, Math.max(0, indexShareBytes - count(toolBytes))),
      tokens: indexTokens, percent: PROMPT_SHARE_PERCENT.index, reason: reasonOf(indexBytes, INDEX_MAX_BYTES), ...basis,
    }),
  });
}

/**
 * The numbers a cap was made from, as a record the Hub can keep and show: only known reasons and sources and plain counts, so that nothing a caller hands in becomes text of
 * the activity log. Anything else is null.
 */
export function cleanBudget(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return null;
  if (!BUDGET_REASONS.includes(budget.reason) || !BUDGET_SOURCES.includes(budget.source)) return null;
  const counts = [budget.capacityTokens, budget.historyTokens, budget.tokens];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  if (!(typeof budget.percent === 'number' && Number.isFinite(budget.percent) && budget.percent > 0 && budget.percent <= 100)) return null;
  return { reason: budget.reason, source: budget.source, capacityTokens: budget.capacityTokens, historyTokens: budget.historyTokens, tokens: budget.tokens, percent: budget.percent };
}

/**
 * One sentence (Vietnamese, like the other events) about a limit that is lower than its maximum: how low, and why. '' when the limit is the maximum. `subject` is what is
 * limited ("Giới hạn" for the project instructions, "Giới hạn chỉ mục" for the skill index). A record that is not understood still says that the limit was lowered, without
 * a reason it cannot vouch for.
 */
export function describeLimit(subject, maxBytes, maximum, budget) {
  if (!(maxBytes < maximum)) return '';
  const numbers = budget ? `tối đa ${budget.percent}% của ${budget.historyTokens} token lịch sử dự toán` : '';
  if (budget?.reason === 'window') return `${subject} giảm còn ${maxBytes} byte vì cửa sổ ngữ cảnh của model nhỏ (${numbers}, cửa sổ ${budget.capacityTokens} token).`;
  if (budget?.reason === 'unknown_window') return `${subject} giảm còn ${maxBytes} byte vì chưa biết cửa sổ ngữ cảnh của model, nên tính theo ${budget.capacityTokens} token (${numbers}).`;
  return `${subject} giảm còn ${maxBytes} byte.`;
}
