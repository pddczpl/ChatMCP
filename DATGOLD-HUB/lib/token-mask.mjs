// The pieces of an answer a model streams, masked the way the answer the task keeps is masked, before anyone watching the task sees them.
//
// The answer of a task is masked as a whole (lib/agent.mjs, #redact). Its pieces arrive as the provider reads them, and a secret can be cut between two pieces: masking each piece
// on its own would let "sk-proj-01" through in one piece and "23456789abcdef" in the next. So the mask sends only the part of the text that the masked whole will begin with, and
// holds back the end that could still turn into something masked:
//   - the last word (a key-shaped string is a run of non-space characters, and "Bearer <token>" ends in one);
//   - an end that is the start of a secret the Hub knows (a secret may hold spaces, so the last word is not always enough);
//   - a "Bearer" whose token has not come yet;
//   - and, as a last check, anything up to a space where masking the text to be sent would not give the start of the masked text.
// What is sent is final: the mask keeps only the text after it (the tail) and masks only that, so the cost of a piece is bounded by the tail, not by the answer (the Hub has one
// thread; masking the whole answer at every piece costs its square). A piece that only makes the last word longer cannot release anything and is not looked at until a space or
// the end comes.
// flush() sends the rest, masked, when the answer is complete, and compares what was sent with the masked whole once: if they differ (a rule the mask could not see coming), the
// watchers are told to drop what they were sent (a reset) and get the masked whole. They may lose what they showed, never see more. reset() forgets the stream (it was cut and is
// replaced by another request) and tells the watchers.

const LAST_WORD = /\S*$/;
const PENDING_BEARER = /\bBearer\s*$/i;
const SPACE = /\s/;

/** The longest end of `text` that is the start (not the whole) of one of `secrets`. Only positions where a secret's first character stands are tried. */
function heldSecretStart(text, secrets) {
  let held = 0;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 2) continue;
    const from = Math.max(0, text.length - (secret.length - 1));
    for (let start = from; start < text.length - held; start += 1) {
      if (text[start] === secret[0] && secret.startsWith(text.slice(start))) { held = text.length - start; break; }
    }
  }
  return held;
}

/** Where the text can be cut: what comes before the cut is sent, what comes after waits for more text. */
function safeCut(text, { redact, secrets }) {
  let cut = text.length - LAST_WORD.exec(text)[0].length;
  cut = Math.min(cut, text.length - heldSecretStart(text, secrets));
  const bearer = PENDING_BEARER.exec(text.slice(0, cut));
  if (bearer) cut = bearer.index;
  if (cut <= 0) return 0;
  const whole = redact(text);
  while (cut > 0 && !whole.startsWith(redact(text.slice(0, cut)))) {
    const space = text.slice(0, cut - 1).search(/\s\S*$/);
    cut = space < 0 ? 0 : space + 1;
  }
  return cut;
}

/**
 * @param {{redact: (text: string) => string, secrets: () => Iterable<string>, emit: (text: string) => void, reset: () => void}} options
 *   `redact` is the mask of the answer; `secrets` is read at every piece that is looked at (a secret registered during the answer counts); `emit` sends a piece to the watchers,
 *   `reset` tells them to drop what they were sent.
 */
export function createTokenMask({ redact, secrets = () => [], emit, reset }) {
  let whole = '';  // the text of the stream so far, for the one comparison at the end
  let tail = '';   // the text not sent yet
  let sent = '';   // what the watchers were sent since the stream began
  return {
    push(piece) {
      if (typeof piece !== 'string' || !piece) return;
      const extendsWord = tail !== '' && !SPACE.test(tail[tail.length - 1]) && !SPACE.test(piece);
      whole += piece;
      tail += piece;
      if (extendsWord) return;
      const cut = safeCut(tail, { redact, secrets: [...(secrets() ?? [])] });
      if (cut <= 0) return;
      const masked = redact(tail.slice(0, cut));
      tail = tail.slice(cut);
      if (masked) { emit(masked); sent += masked; }
    },
    flush() {
      if (!whole) return;
      const rest = tail ? redact(tail) : '';
      const masked = redact(whole);
      if (sent + rest === masked) { if (rest) emit(rest); }
      else { reset(); if (masked) emit(masked); }
      sent = masked;
      tail = '';
    },
    reset() { whole = ''; tail = ''; sent = ''; reset(); },
  };
}
