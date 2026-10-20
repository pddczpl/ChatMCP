// Glob matching that cannot be made slow.
//
// A glob is matched by walking a table over (pattern position x text position), so the work is at most pattern length times text length
// whatever either of them contains. A regular expression built from a glob backtracks without a bound: a pattern with many stars against
// a text that almost matches takes longer than the life of the machine. Both sides can come from a model: the text is a command line of up
// to 60,000 characters or a path, and the pattern can be an operand of a shell command that is only being looked at (protected-paths.mjs).
//
//   default mode  `*` is any run of characters, every other character stands for itself (the `if` rule of a Bash hook).
//   path mode     `*` is a run inside one folder, `**` a run that may cross "/", `**/` zero or more folders, `?` one character that is not "/"
//                 (a file pattern of an `if` rule; a path segment that may expand to a protected name).
//   brackets      (path mode) a bracket expression "[...]" stands for any one character that is not "/": a superset of what it can match,
//                 which is the safe reading when the question is whether a name MAY be matched.

/** True when `glob` matches the whole of `text`. */
export function globMatches(glob, text, { path = false, ignoreCase = false, brackets = false } = {}) {
  const pattern = String(glob);
  const subject = ignoreCase ? String(text).toLowerCase() : String(text);
  const tokens = [];
  // two runs in a row are one run; two single characters are two
  const push = (token) => { if (token.kind === 'lit' || token.kind === 'one' || tokens.at(-1)?.kind !== token.kind) tokens.push(token); };
  let unclosed = false; // once a "[" has no "]" after it, no later "[" has one either: the pattern is not searched again
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '[' && brackets && !unclosed) {
      const close = pattern.indexOf(']', index + 2);
      if (close !== -1) { push({ kind: 'one' }); index = close; continue; }
      unclosed = true;
    }
    if (char === '*') {
      if (path && pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') { index += 1; push({ kind: 'dirs' }); } else push({ kind: 'any' });
      } else push({ kind: path ? 'run' : 'any' });
    } else if (char === '?' && path) push({ kind: 'one' });
    else push({ kind: 'lit', char: ignoreCase ? char.toLowerCase() : char });
  }
  const length = subject.length;
  let next = new Uint8Array(length + 2); // does tokens[j + 1 ..] match subject[i ..]
  let current = new Uint8Array(length + 2);
  next[length] = 1;
  for (let j = tokens.length - 1; j >= 0; j -= 1) {
    const token = tokens[j];
    let reach = 0; // 'dirs': some later position that follows a "/" and from which the rest matches
    for (let i = length; i >= 0; i -= 1) {
      let value;
      switch (token.kind) {
        case 'lit': value = i < length && subject[i] === token.char && next[i + 1]; break;
        case 'one': value = i < length && subject[i] !== '/' && next[i + 1]; break;
        case 'any': value = next[i] || (i < length && current[i + 1]); break;
        case 'run': value = next[i] || (i < length && subject[i] !== '/' && current[i + 1]); break;
        default: value = next[i] || reach; // 'dirs'
      }
      current[i] = value ? 1 : 0;
      if (token.kind === 'dirs' && i > 0 && subject[i - 1] === '/' && next[i]) reach = 1;
    }
    [next, current] = [current, next];
  }
  return next[0] === 1;
}
