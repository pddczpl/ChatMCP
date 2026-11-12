// The pieces of an answer a model streams, masked the way the answer the task keeps is masked, before anyone watching the task sees them.
//
// The answer of a task is masked as a whole (lib/agent.mjs, #redact). Its pieces arrive as the provider reads them, and a secret can be cut between two pieces: masking each piece
// on its own would let "sk-proj-01" through in one piece and "23456789abcdef" in the next. So the mask keeps the text of the stream so far, sends only the part that the masked whole
// will begin with whatever comes next, and holds back the end that could still turn into something masked:
//   - the last word (a key-shaped string is a run of non-space characters, and "Bearer <token>" ends in one);
//   - an end that is the start of a secret the Hub knows (a secret may hold spaces, so the last word is not always enough);
//   - a "Bearer" whose token has not come yet;
//   - and, as a last check, anything up to a space where masking the text sent so far would not give the start of the masked whole.
// flush() sends the rest, masked, when the answer is complete. reset() forgets the stream (it was cut and is replaced by another request) and tells the watchers.
// If the masked text ever stops beginning with what was already sent, the watchers are told to drop it (a reset) and are sent the masked text from its start: they may lose what
// they showed, never see more.

const LAST_WORD = /\S*$/;
const PENDING_BEARER = /\bBearer\s*$/i;

/** The longest end of `text` that is the start (not the whole) of one of `secrets`. */
function heldSecretStart(text, secrets) {
  let held = 0;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 2) continue;
    for (let length = Math.min(secret.length - 1, text.length); length > held; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) { held = length; break; }
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
  const whole = redact(text);
  while (cut > 0 && !whole.startsWith(redact(text.slice(0, cut)))) {
    const space = text.slice(0, cut - 1).search(/\s\S*$/);
    cut = space < 0 ? 0 : space + 1;
  }
  return cut;
}

/**
 * @param {{redact: (text: string) => string, secrets: () => Iterable<string>, emit: (text: string) => void, reset: () => void}} options
 *   `redact` is the mask of the answer; `secrets` is read at every piece (a secret registered during the answer counts); `emit` sends a piece to the watchers, `reset` tells them
 *   to drop what they were sent.
 */
export function createTokenMask({ redact, secrets = () => [], emit, reset }) {
  let text = '';
  let sent = '';
  const send = (masked) => {
    if (masked.startsWith(sent)) {
      if (masked.length > sent.length) emit(masked.slice(sent.length));
      sent = masked;
    } else if (!sent.startsWith(masked)) {
      reset();
      sent = masked;
      if (masked) emit(masked);
    }
  };
  return {
    push(piece) {
      if (typeof piece !== 'string' || !piece) return;
      text += piece;
      send(redact(text.slice(0, safeCut(text, { redact, secrets: [...(secrets() ?? [])] }))));
    },
    flush() { if (text) send(redact(text)); },
    reset() { text = ''; sent = ''; reset(); },
  };
}
