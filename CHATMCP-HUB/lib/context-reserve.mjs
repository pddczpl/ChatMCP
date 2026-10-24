// The part of a context window that is not for the conversation: the room kept for the answer and a margin against estimates that are not exact. One definition, used by the budget of a run
// (lib/context-compaction.mjs) and by the capacity the model catalog allows (lib/model-facts.mjs), so that the two cannot drift apart.

/** The output a run plans for: what it asks the model to write, at most a quarter of the window and at least 1,024 tokens. */
export const plannedOutputFor = (capacityTokens, outputLimit) => Math.min(outputLimit, Math.max(1024, Math.floor(capacityTokens / 4)));

/** The margin kept against token estimates that are not exact: 3.5% of the window, at least 768 tokens. */
export const safetyMarginFor = (capacityTokens) => Math.max(768, Math.ceil(capacityTokens * 0.035));
