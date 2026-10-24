// The text a finished run ends with, and whose words are in it.
//
// The AgentRunner (lib/agent.mjs) makes the final text of a completed run from the model's last answer and, after it, up to two sentences of the Hub's own:
//
//   * "[Verification notice] ChatMCP has NOT independently verified full completion: <gaps>."   when the Hub's evidence does not back the run's plan
//   * "[Hook notice] The Stop hook blocked 8 times; ..."                                       when a Stop / SubagentStop / TaskCompleted hook still objected after its blocks
//
// The main chat shows that text whole, on purpose. What shows the model's words alone (the summary of a coding worker, the claim of agent_results) must not take the
// Hub's sentences for them. They used to cut the text again, each at the place it guessed the runner had written its sentence; now the runner records the boundary where
// it makes the text (`finalParts`: the model's words and each sentence of the Hub's, apart) and the readers read that record.
//
// This module is the one place that says what the sentences are, how they are joined to the words and when a record can be trusted. The wording of the verification
// sentence is also used by the legacy readers (a task saved before the record existed has only the text, and they find the sentence again by it).

export const VERIFICATION_NOTICE_MARK = '\n\n[Verification notice] ';
export const HOOK_NOTICE_MARK = '\n\n[Hook notice] ';

/** The sentence of the Hub's about a run its evidence does not back, from the gaps its own record lists (`verificationOutcome.missing`). */
export function verificationWarning(missing) {
  return `ChatMCP has NOT independently verified full completion: ${missing.join('; ')}.`;
}

/**
 * The final text of a run: the model's words, then the Hub's verification sentence, then the Hub's hook note, each only when there is one.
 * A notice is a non-empty string or null.
 */
export function composeFinalText({ words, verificationNotice = null, hookNotice = null }) {
  return words + (verificationNotice ? VERIFICATION_NOTICE_MARK + verificationNotice : '') + (hookNotice ? HOOK_NOTICE_MARK + hookNotice : '');
}

const notice = (value) => value === null || value === undefined || (typeof value === 'string' && value !== '');

/**
 * The record of whose words a task's final text holds, from the task as the runner hands it out (`finalParts` next to `finalText`), or null.
 * It is trusted only when it makes the very text it came with, byte for byte: a record that is malformed, or that belongs to another text (an earlier run's, a clipped
 * list entry), is ignored and the reader does what it did before the record existed. Returns {words, verificationNotice, hookNotice} (a notice is a string or null).
 */
export function finalPartsOf(view) {
  const parts = view?.finalParts;
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) return null;
  const { words, verificationNotice, hookNotice } = parts;
  if (typeof words !== 'string' || !notice(verificationNotice) || !notice(hookNotice)) return null;
  const record = { words, verificationNotice: verificationNotice ?? null, hookNotice: hookNotice ?? null };
  return typeof view.finalText === 'string' && composeFinalText(record) === view.finalText ? record : null;
}

/**
 * What a reader that shows the model's words to a person, or hands them to another model, needs from a finished task: the words, and the Hub's own sentences apart from them, in the
 * order the runner wrote them (the verification notice, then the hook note). `recorded` says that they come from the runner's record. A task saved before the record, or one whose
 * record does not make its text, has only the text: the words are all of it, there is no sentence to tell apart, and the reader does what it always did with the text.
 */
export function wordsAndNotes(view) {
  const parts = finalPartsOf(view);
  if (parts) return { words: parts.words, notes: [parts.verificationNotice, parts.hookNotice].filter(Boolean), recorded: true };
  return { words: typeof view?.finalText === 'string' ? view.finalText : '', notes: [], recorded: false };
}
