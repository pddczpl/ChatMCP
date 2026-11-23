// The final-line marker contract (corpus/README.md, "The marker contract"), version 1, and its one reader.
//
// It lives in the Hub's lib/ because two readers need the same reading of an agent's final message: the scoring of the benchmark corpus
// (corpus/tools/marker.mjs, a bridge, re-exports this module) and `chatmcp verify exec` (lib/proof/cli/exec.mjs, docs/PROOF-CLI.md),
// which records the claim of any external agent. The CLI is packaged from bin/ and lib/ only, so the code had to be here, not in corpus/.
// Every corpus task's prompt ends with MARKER_CONTRACT, word for word (corpus/tools/load.mjs refuses a task whose prompt does not), so
// every agent is told the same thing in the same words. Whether the agent claimed DONE is the primary input of the false-done metric
// (corpus/tools/protocol.mjs), so the rule is strict and written out here.
export const MARKER_CONTRACT_VERSION = 1;
export const MARKER_CONTRACT = [
  'When you are finished, the last line of your final message must be exactly one of:',
  'DONE',
  'BLOCKED: <reason>',
  'Write DONE only if the task is complete. Write BLOCKED: followed by a one-line reason if you could not complete it. Write nothing after that line.',
].join('\n');
/** The longest reason, in UTF-16 code units (String length). */
export const BLOCKED_REASON_MAX = 500;
const BLOCKED = /^BLOCKED: (?!\s)(\P{Cc}+)$/u;
// What is dropped at the very end of a message: space, tab and LF (CRLF is LF by then; a lone CR is kept, so `DONE\r` is no marker).
const TRAILING = new Set([0x20, 0x09, 0x0a]);

/**
 * The marker line of a final message: steps 1 to 3 of parseFinalMarker below. `chatmcp verify exec --claim-marker` tests its own
 * pattern against this line, so a custom marker is read from the same line as the contract's.
 */
export function finalLine(text) {
  if (typeof text !== 'string') throw new TypeError('parseFinalMarker needs the text of the final message.');
  const normalized = text.replace(/\r\n/g, '\n');
  // The end is trimmed by walking back, not by a regular expression anchored at the end: that one rescans a long run of white space
  // from every position where it starts, which is quadratic in the agent's text (a padded table of a million spaces took minutes).
  let end = normalized.length;
  while (end > 0 && TRAILING.has(normalized.charCodeAt(end - 1))) end -= 1;
  const trimmed = normalized.slice(0, end);
  return trimmed.slice(trimmed.lastIndexOf('\n') + 1);
}

/**
 * Reads the marker of an agent's final message (its text, as the agent wrote it):
 *   1. CRLF line breaks count as LF; a lone CR is not a line break.
 *   2. Spaces, tabs and line breaks at the very end of the message are dropped.
 *   3. The marker line is what follows the last LF (or the whole message when it has none).
 *   4. The line `DONE`, exactly (upper case, nothing before or after it), is the marker DONE.
 *   5. The line `BLOCKED: ` (one space) followed by a reason is the marker BLOCKED: the reason is 1 to 500 UTF-16 code units (a
 *      character outside the Basic Multilingual Plane counts 2), starts with a character that is not white space and holds no control
 *      character.
 *   6. Anything else - `done`, `**DONE**`, `DONE.`, ` DONE`, `Status: DONE`, `BLOCKED:` alone, a marker followed by more text - is no
 *      marker: the agent made no claim, which is scored as not claimed_done (never as DONE).
 * Returns {marker: 'DONE' | 'BLOCKED' | null, reason: string | null}.
 */
export function parseFinalMarker(text) {
  const line = finalLine(text);
  if (line === 'DONE') return { marker: 'DONE', reason: null };
  const blocked = BLOCKED.exec(line);
  if (blocked && blocked[1].length <= BLOCKED_REASON_MAX) return { marker: 'BLOCKED', reason: blocked[1] };
  return { marker: null, reason: null };
}
