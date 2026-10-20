// Text helpers for what a model is shown of third-party text (project instruction files, skills): clean it, keep it to a byte limit without breaking a
// character, and make a name fit on one line. No regular expression runs over the text itself (a table, loops and trimEnd), so the cost is linear in its length.

// What carries a hidden instruction or a terminal trick, as code point ranges (a table and a loop: no pattern, no raw invisible character in this
// source): control characters except tab and line feed, soft hyphen and other invisible format characters, zero-width and bidi controls, the
// invisible Hangul and Khmer fillers, the byte order mark, and the tag characters and variation selectors of plane 14.
const INVISIBLE = Object.freeze([
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5],
  [0x180b, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
  [0xfff9, 0xfffb], [0xe0000, 0xe0fff],
]);
const invisible = (code) => INVISIBLE.some(([first, last]) => code >= first && code <= last);

/** Line ends become LF (CR LF, a lone CR, U+2028, U+2029 and NEL); the invisible characters are removed and counted. */
export function cleanText(text) {
  const out = [];
  let stripped = 0;
  let afterCr = false;
  for (const character of String(text ?? '')) {
    const code = character.codePointAt(0);
    if (code === 0x0a && afterCr) { afterCr = false; continue; }
    afterCr = code === 0x0d;
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029 || code === 0x85) out.push('\n');
    else if (code === 0x09 || !invisible(code)) out.push(character);
    else stripped += 1;
  }
  return { text: out.join(''), stripped };
}

/** Lines that hold only blanks are dropped from the start, whitespace from the end (a loop and trimEnd: no pattern that can backtrack). */
export function trimBlank(text) {
  let start = 0;
  for (;;) {
    let i = start;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
    if (i < text.length && text[i] === '\n') { start = i + 1; continue; }
    if (i >= text.length) start = text.length;
    break;
  }
  return text.slice(start).trimEnd();
}

// A cut prefers the end of a line when there is one within this many bytes (or a quarter of what is kept, whichever is less).
const LINE_WINDOW_BYTES = 1024;
/** How many bytes of `buffer` to keep when at most `limit` fit: never the middle of a character, and the end of a line when one is near. */
export function alignCut(buffer, limit) {
  let cut = Math.max(0, Math.min(limit, buffer.length));
  if (cut >= buffer.length) return buffer.length;
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) cut -= 1;
  if (buffer[cut] === 0x0a) return cut;
  const window = Math.min(LINE_WINDOW_BYTES, Math.floor(cut / 4));
  const newline = cut > 0 ? buffer.lastIndexOf(0x0a, cut - 1) : -1;
  return newline > 0 && newline >= cut - window ? newline : cut;
}

/** A value of unknown origin as one plain line of at most `maxBytes` bytes: cleaned, every run of whitespace one space, cut on a character with an ellipsis. */
export function oneLine(value, maxBytes) {
  const source = String(value ?? '');
  // Nothing past what could survive the cut needs to be looked at.
  const { text } = cleanText(source.length > maxBytes * 4 ? source.slice(0, maxBytes * 4) : source);
  const line = text.split(/\s+/).filter(Boolean).join(' ');
  const buffer = Buffer.from(line, 'utf8');
  if (buffer.length <= maxBytes) return line;
  const cut = Math.min(alignCut(buffer, maxBytes - 3), maxBytes - 3);
  return `${buffer.subarray(0, cut).toString('utf8').trimEnd()}…`;
}
