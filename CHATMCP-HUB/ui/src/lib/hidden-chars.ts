// Characters that cannot be seen but change what a reader sees. A right-to-left override reorders a line of code on screen, a zero-width space
// splits a word that a search will not find, a control character can hide the rest of a line. Text from an AI and the diff of what it changed
// are shown with these made visible, so that a reviewer reads what is really there.

/** Control characters except tab, line feed and carriage return; soft hyphen and other invisible marks; zero-width and direction-changing characters. */
const HIDDEN_SOURCE = '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]';
const HIDDEN = new RegExp(HIDDEN_SOURCE);
const HIDDEN_ALL = new RegExp(HIDDEN_SOURCE, 'g');

export type HiddenPart = { text: string } | { hidden: string };

/** Whether the text holds a character that cannot be seen. */
export const hasHidden = (text: string): boolean => HIDDEN.test(text);

/** The text cut around its hidden characters, each named as "U+202E" (capitals, at least four digits). The visible text is kept whole. */
export function splitHidden(text: string): HiddenPart[] {
  const parts: HiddenPart[] = [];
  let last = 0;
  for (const match of text.matchAll(HIDDEN_ALL)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ hidden: `U+${(match[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}` });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
