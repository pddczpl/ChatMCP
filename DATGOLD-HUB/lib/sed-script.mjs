// A strict grammar for the sed scripts that Read Only may run without asking.
//
// GNU sed is not a read-only program: `1e CMD` and `s/x/y/e` run a shell command, `w FILE`, `W FILE` and `s/x/y/w FILE` write files and
// `r FILE` / `R FILE` read any file into the output. A denylist of those letters cannot be trusted (the script is a language of its own:
// custom delimiters, addresses made of regular expressions, several -e fragments glued with newlines). So the question is turned around:
// only scripts that this parser fully understands and that use nothing but
//
//     [address[,address]][!] p | d | = | q[N] | Q[N] | s/regex/replacement/FLAGS      FLAGS = g p i I m M and a count
//
// are "read". Everything else (including every `e r R w W F a i c y b t l n N D P h H g G x z { }` command and a comment) is refused
// by the parser and the caller treats the program as an unknown, unreviewed one.
//
// The parser follows GNU sed's own splitting of `s` (an escaped delimiter is part of the text, a raw newline ends the command, brackets
// are NOT special) and also splits the regular expression bracket-aware, as POSIX seds do. When the two readings disagree on where the
// regular expression ends, the script is refused: that is exactly the ambiguity a hostile script would use.
//
// `--sandbox` (GNU sed >= 4.3) makes sed itself reject e/r/R/w/W, so the caller does not need the grammar for it.

import { isProtectedPath, mayExpandToProtected } from './protected-paths.mjs';

const DELIMITERS = new Set(['/', '|', '#', ',', ':', '@', '%', '!', '_', '~', '+']);
const SAFE_FLAGS = new Set(['g', 'p', 'i', 'I', 'm', 'M']);
const isDigit = (ch) => ch >= '0' && ch <= '9';

/** End index of a bracket expression that opens at `open`, or -1. */
function bracketEnd(text, open) {
  let i = open + 1;
  if (text[i] === '^') i += 1;
  if (text[i] === ']') i += 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') return -1;
    if (ch === '[' && (text[i + 1] === ':' || text[i + 1] === '.' || text[i + 1] === '=')) {
      const close = text.indexOf(`${text[i + 1]}]`, i + 2);
      if (close === -1) return -1;
      i = close + 2;
      continue;
    }
    if (ch === ']') return i;
    i += 1;
  }
  return -1;
}

/** Reads up to the closing delimiter. `start` is the first character after the opening one. Returns {end} (index after the closer) or null. */
function scanDelimited(text, start, delimiter, brackets) {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') return null;
    if (ch === '\\') {
      if (i + 1 >= text.length || text[i + 1] === '\n') return null;
      i += 2;
      continue;
    }
    if (brackets && ch === '[') {
      const close = bracketEnd(text, i);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (ch === delimiter) return { end: i + 1 };
    i += 1;
  }
  return null;
}

/** A delimited regular expression whose end both readings agree on. */
function scanRegex(text, start, delimiter) {
  const gnu = scanDelimited(text, start, delimiter, false);
  const posix = scanDelimited(text, start, delimiter, true);
  return gnu && posix && gnu.end === posix.end ? gnu : null;
}

/**
 * @param {string} script  the complete script (several -e fragments already joined with newlines)
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkSedScript(script) {
  const text = String(script);
  const n = text.length;
  let i = 0;
  const blanks = () => { while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1; };
  const no = (reason) => ({ ok: false, reason });

  // address: N, $, first~step, /re/flags, \cREc flags ; second address also +N and ~N. Returns true/false, or null for a malformed one.
  const address = (second) => {
    const ch = text[i];
    if (ch === undefined) return false;
    if (isDigit(ch)) {
      while (i < n && isDigit(text[i])) i += 1;
      if (!second && text[i] === '~') {
        i += 1;
        if (!isDigit(text[i] ?? '')) return null;
        while (i < n && isDigit(text[i])) i += 1;
      }
      return true;
    }
    if (ch === '$') { i += 1; return true; }
    if (second && (ch === '+' || ch === '~')) {
      i += 1;
      if (!isDigit(text[i] ?? '')) return null;
      while (i < n && isDigit(text[i])) i += 1;
      return true;
    }
    if (ch === '/' || ch === '\\') {
      let delimiter = ch;
      let start = i + 1;
      if (ch === '\\') {
        delimiter = text[i + 1];
        if (delimiter === undefined || !DELIMITERS.has(delimiter)) return null;
        start = i + 2;
      }
      const scanned = scanRegex(text, start, delimiter);
      if (!scanned) return null;
      i = scanned.end;
      while (text[i] === 'I' || text[i] === 'M') i += 1;
      return true;
    }
    return false;
  };

  for (;;) {
    while (i < n && (text[i] === ';' || /\s/.test(text[i]))) i += 1;
    if (i >= n) return { ok: true };
    const first = address(false);
    if (first === null) return no('địa chỉ sed không hợp lệ hoặc mơ hồ');
    if (first) {
      blanks();
      if (text[i] === ',') {
        i += 1;
        blanks();
        const closing = address(true);
        if (closing === null) return no('địa chỉ thứ hai của sed không hợp lệ hoặc mơ hồ');
        if (!closing) return no('thiếu địa chỉ thứ hai của sed');
      }
    }
    blanks();
    if (text[i] === '!') { i += 1; blanks(); }
    const command = text[i];
    i += 1;
    if (command === 'p' || command === 'd' || command === '=') {
      // nothing more
    } else if (command === 'q' || command === 'Q') {
      blanks();
      while (i < n && isDigit(text[i])) i += 1;
    } else if (command === 's') {
      const delimiter = text[i];
      if (delimiter === undefined || !DELIMITERS.has(delimiter)) return no('dấu phân cách của lệnh s không nằm trong danh sách an toàn');
      const regex = scanRegex(text, i + 1, delimiter);
      if (!regex) return no('biểu thức chính quy của lệnh s không hợp lệ hoặc mơ hồ');
      const replacement = scanDelimited(text, regex.end, delimiter, false);
      if (!replacement) return no('phần thay thế của lệnh s không hợp lệ');
      i = replacement.end;
      while (i < n && /[A-Za-z0-9]/.test(text[i])) {
        if (!SAFE_FLAGS.has(text[i]) && !isDigit(text[i])) return no(`cờ '${text[i]}' của lệnh s có thể chạy lệnh hoặc ghi file`);
        i += 1;
      }
    } else {
      return no(command === undefined ? 'thiếu lệnh sed' : `lệnh sed '${command}' không nằm trong danh sách an toàn (chỉ p, d, q, =, s)`);
    }
    blanks();
    if (i < n && text[i] !== ';' && text[i] !== '\n') return no(`ký tự không mong đợi trong script sed: '${text[i]}'`);
  }
}

/**
 * Best-effort list of the files that a script the grammar refused would read or write (r, R, w, W commands and the w flag of s). It over
 * approximates on purpose: it is only used to decide how loudly a refused script is reported and which paths are looked at.
 * @returns {{op: 'read' | 'write', target: string}[]}
 */
export function sedFileTargets(script) {
  const found = [];
  for (const line of String(script).split('\n')) {
    const pattern = /(?:^|[\s;{}!,\d$/\\])([rRwW])[ \t]*(\S[^\n]*)/g;
    for (const match of line.matchAll(pattern)) {
      const target = match[2].trim().slice(0, 240);
      if (target) found.push({ op: match[1] === 'r' || match[1] === 'R' ? 'read' : 'write', target });
    }
    const flagged = /[gpiImM0-9]w[ \t]*(\S[^\n]*)/g;
    for (const match of line.matchAll(flagged)) {
      const target = match[1].trim().slice(0, 240);
      if (target) found.push({ op: 'write', target });
    }
  }
  return found;
}

/** True for a target that must never be read or written through the shell: protected files, or text that may expand to one. */
export const isProtectedSedTarget = (target) => isProtectedPath(target) || mayExpandToProtected(target);
