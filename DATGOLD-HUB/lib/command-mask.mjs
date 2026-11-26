// What the masking of a COMMAND may hide (lib/permissions.mjs, maskCommand). The owner reads a command on the approval card before it runs, so a pattern that looks for a credential may hide text only when
// that text is plain to every shell the command can meet: bash (and sh), PowerShell and cmd. Plain means two things, and both are decided here:
//   - its CHARACTERS (plain): letters, digits and a few signs that no shell expands, escapes, splits on or quotes with. A candidate is hidden up to the first character that is not one of them; the rest stays;
//   - its PLACE (runs, belongsTo): not where a shell takes a word for a command, a part of an expansion, the right side of an assignment of PowerShell or the file of a redirection, and not an argument that
//     only looks like the value of the word before it.
// Nothing is proven about a text that is read again as code, so what the command says about itself is looked at first (levelOf): a command that gives text to a shell through a pipe, a variable, a decoder or an
// evaluation has nothing hidden by a pattern. The registered secrets are replaced by value before any of this, and they always are.
//
// This is a reading of the text and not a shell, and every doubt is answered by showing: a credential that stays readable costs less than a piece of a command that the owner does not see.
// The text of a file, a diff and the data of a tool go through maskSecrets, which hides by pattern alone and knows nothing of this module.

const MARK = '[REDACTED]';
/** A command longer than this is not read: nothing of it is hidden by a pattern (the Hub does not run one of more than 8,000 characters). */
const LONGEST = 10_000;
/** Nor one with more expansions than this: each of them is looked at with the words in front of it. */
const MOST_EXPANSIONS = 200;

// Letters: ASCII, and the Latin letters with their marks (a Vietnamese or a French password). Every other character is left readable: PowerShell takes typographic quotes and dashes for quotes and dashes and
// several spaces for blanks, and a program that is called with the code page of Windows can be given a quote or a bar for a character that only looks like one.
const LETTER = 'A-Za-z0-9\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u01bf\\u01c4-\\u024f\\u1e00-\\u1eff';
const FIRST = new RegExp(`[${LETTER}_./+]`);
const NEXT = new RegExp(`[${LETTER}_./+:@#~-]`);
// Inside plain double quotes (the `plain` strings of quotedStrings) these are characters like any other in all three shells. What is never hidden is not among them: $ ` \ " ' % ! ^ ; | & < > and a line break.
const QUOTED = new RegExp(`[${LETTER}_./+:@#~ ,=()\\[\\]{}*?-]`);
// What may stand right in front of a candidate: not a sign that a shell reads together with what follows it ($x, %x, \x, ?x, ~x), nor a character that is none of those of a command.
const BEFORE = new RegExp(`[${LETTER}\\s_./+:@,="';|&()<>-]`);
const BEFORE_IN_QUOTES = new RegExp(`[${LETTER}\\s_./+:@,="';|&()<>?*#~{}\\[\\]-]`);
const GLOB = /[*?[\]{}]/;
const FEWEST = 4;

const BREAKS = new Set([...'\n\r;|&()`{}']);
const isBreak = (character) => BREAKS.has(character);
const isBlank = (character) => character === ' ' || character === '\t';
/** How many characters of a line break stand at a place: 0, 1 (\n) or 2 (\r\n). */
const endsLine = (text, at) => (text[at] === '\n' ? 1 : text[at] === '\r' && text[at + 1] === '\n' ? 2 : 0);
const QUOTES = /["'\u2018-\u201f]/g;

// ------------------------------------------------------------------ the characters
/**
 * How many characters of a candidate may be hidden, counted from its start: what is plain, or nothing when that is only a few characters of more. `after` is the character behind the candidate, `lone` says
 * which of % and ! stand once in the whole command (a variable of cmd has two of them).
 */
function plain(candidate, after, first, next, lone) {
  // a pattern of bash (a*b, {a,b}) is one word: all of it stays, or none
  if (first === FIRST && GLOB.test(candidate.split(/\s/)[0].split(MARK).join(''))) return 0;
  let length = 0;
  while (length < candidate.length) {
    if (candidate.startsWith(MARK, length)) length += MARK.length;
    else if ((length === 0 ? first : next).test(candidate[length]) || (length > 0 && lone[candidate[length]] === true)) length += 1;
    else break;
  }
  // The = at the end of base64 (elsewhere it is a separator of arguments to cmd).
  let padded = length;
  while (candidate[padded] === '=') padded += 1;
  if (length > 0 && padded === candidate.length && !NEXT.test(after)) length = padded;
  while (length > 0 && /[@#~:]/.test(candidate[length - 1])) length -= 1; // a sign that can begin what follows: @( of PowerShell, #, ~
  return length === candidate.length || length >= FEWEST ? length : 0;
}
/** How many characters of text[start, end) are plain, counted from its start, whatever the place: for a text that is not a command (the JSON of the arguments of a call). */
export const plainLength = (text, start, end) => plain(text.slice(start, end), text[end] ?? ' ', FIRST, NEXT, {});
/** Whether a whole text is plain: one word that no shell expands, splits or quotes with. */
export const isPlain = (text) => text !== '' && plain(text, ' ', FIRST, NEXT, {}) === text.length;

// ------------------------------------------------------------------ words
// The brace of a block, an assignment of PowerShell (or several; what is left of it behind a brace, a blank), or the entry that opens a hashtable, glued to the statement behind it: {tool, $x=tool, $env:A+=tool, [string]$x=tool, $a,$b=tool, $a=$b=tool,
// @{a=tool.
const A_VARIABLE = `(?:[[\\]][^\\s$]*\\])?\\$(?:\\{[^}]*\\}|[\\w:?\\u0080-\\uffff]+)(?:\\[[^\\]]*\\]|\\.[\\w\\u0080-\\uffff]+)*`;
const GLUED = new RegExp(`^(?:[%?]?\\{|(?:${A_VARIABLE}(?:,${A_VARIABLE})*|[^\\s=$[\\]{}]*[\\]}])?(?:[-+*/%]|\\?\\?)?=|(?:\\[[^\\s$]*\\])?@\\{[^\\s=]*=)*`);
/** What is glued in front of the statement in a word. */
const gluedTo = (word) => (/[={]/.test(word) ? GLUED.exec(word)[0] : '');
// What begins an expression of PowerShell: a variable, a string, a bracket, a number with an operator behind it, a sign in front of one of them. Any other word is a command.
const EXPRESSION = /^(?:$|["'$[(@]|[-+!,]+(?:$|["'$[(@\d])|\d[\d.]*[-+*/%,])/;
/** A word as a program is named in it: nothing glued in front of it, no quotes around it, no folder, no .exe, small letters; where a command is expected (`open`) a comma, an equals sign or a @ in front of it, and what follows one of them, are no part of the name to cmd. */
function programOf(word, open = true) {
  const bare = (word.slice(gluedTo(word).length) || word).replace(QUOTES, '').replace(/[\^`]/g, '');
  const name = open ? bare.replace(/^[,=;@]+/, '').replace(/[,=;].*$/s, '') : bare;
  return name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).replace(/\.(?:exe|cmd|bat|com)$/i, '').toLowerCase();
}
// Words that stand in front of a command: LEADS only where a command is expected, RUNS wherever they stand (docker exec web sh -c "..."); those of TAKES_ONE take a word for themselves first (a host, a user).
const LEADS = new Set(['then', 'elif', 'else', 'elseif', 'while', 'until', 'do', 'case', 'not', '!', 'time', 'command', 'builtin', 'exec', 'call', 'source', '.', 'in', 'coproc', 'function',
  'return', 'throw', 'exit', 'begin', 'process', 'end', 'try', 'catch', 'finally', 'foreach', 'for', 'switch', 'param', '{', 'compgen', 'complete', 'mapfile', 'readarray', 'enable', 'jobs', 'fc', 'bind']);
const SHELLS = ['sh', 'bash', 'dash', 'ash', 'ksh', 'mksh', 'zsh', 'fish', 'csh', 'tcsh', 'rsh', 'rbash', 'cmd', 'powershell', 'powershell_ise', 'pwsh', 'wsl', 'su'];
const RUNS = new Set([...SHELLS, 'sudo', 'doas', 'gsudo', 'env', 'nohup', 'setsid', 'nice', 'ionice', 'stdbuf', 'timeout', 'watch', 'strace', 'ltrace', 'xargs', 'parallel', 'busybox', 'chroot', 'runas', 'proxychains', '-exec', '-execdir', '-ok', '-okdir', 'start-process', 'saps', 'invoke-item', 'ii',
  'invoke-command', 'icm', 'import-module', 'ipmo', 'start-job', 'sajb', 'start-threadjob', 'ssh']);
const TAKES_ONE = new Set(['ssh', 'su', 'chroot', 'runas']);
// Words that an assignment of bash can follow: its reserved words, and the programs that take assignments for themselves (RUNS has them too). The others of LEADS and RUNS take the name of a program, or of a script.
const ASSIGNS = new Set(['then', 'elif', 'else', 'while', 'until', 'do', '!', '{', 'coproc', 'env', 'sudo']); // (time is a program to PowerShell)
const RESERVED = new Set(['then', 'elif', 'else', 'while', 'until', 'do', '!', 'time', '{', 'coproc', '.']); // words of LEADS that have no flags of their own
const OF_CONTAINERS = /^-(?:[itdqPT]+|-rm|-interactive|-tty|-detach|-init|-privileged)$/; // flags of exec and run that take no value
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'perl', 'ruby', 'php']); // the next word is a script of them, when it is no flag
// Words of LEADS that an expression of PowerShell can follow, or a block: a variable behind them is not run.
const EXPRESSIONS = new Set(['then', 'elif', 'else', 'elseif', 'while', 'until', 'do', 'case', 'not', '!', 'in', 'function', 'return', 'throw', 'exit', 'begin', 'process', 'end', 'try', 'catch', 'finally', 'foreach', 'for', 'switch', 'param', '{']);
const CONTAINERS = new Set(['docker', 'podman', 'nerdctl', 'docker-compose', 'podman-compose', 'kubectl', 'oc', 'lxc']); // exec and run of them take a container or an image, then a command
const READS_A_LINE = new Set(['ssh', 'powershell', 'powershell_ise', 'pwsh']); // a string behind them is a command, with no flag in front of it
// Words that take the next one for themselves where a command is expected: those of the condition of cmd's if (exist a, errorlevel 1, a EQU b, a == b), the title of its start, the kind of PowerShell's using.
const CONDITIONS = new Set(['if', '/i', 'exist', 'defined', 'errorlevel', 'equ', 'neq', 'lss', 'leq', 'gtr', 'geq', '==']);
const LEADS_AND_TAKE = new Set(['start', 'using']);
const ASSIGNMENT = /^["']*[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const SCRIPT_FLAG = /^["']*(?:-[a-z]*c|\/[ck]|-command|-file)["']*$/i; // what follows it is the command itself
const FILE_FLAG = /file/i; // ... or the name of the script
const IS_ASSIGNED = /^[A-Za-z_]\w*=/; // name= at the start of a word, an assignment of bash where one can stand
const OPERATOR = /^["']*(?:[-+*/]?=|,)["']*$/;
const TYPE = /^\[[\w.[\],]+\]$/; // [string] of PowerShell
/**
 * Whether a shell can take the word that follows `words` for a command (`open`): every word before it is an assignment, a word that stands in front of a command, a flag of such a word (and one word that it can take),
 * or an expansion that may be empty. `expression`: one of them is a variable of PowerShell (what is assigned to it is run). `assigns`: name=value is an assignment to bash there; `first`: nothing is in front of it, so that it is a
 * command to PowerShell whatever it looks like; `flags`: a word in front of it can have a flag there; `container`: that word is one of a container client;
 * `runner`: a word in front of it runs what follows; `script`: that word is an interpreter. `opens`, when given, gets `open` as it is in front of each word (what expects(words.slice(0, i)) says).
 */
function expects(words, opens = null) {
  let open = true;
  let wrapped = false;
  let takes = 0; // how many of the next words can belong to the flags seen so far
  let shell = false;
  let line = false; // the next string is a command of its own
  let expression = false;
  let assigns = true;
  let first = true;
  let flags = false;
  let client = false; // a container client, whose exec or run is still to come
  let container = false;
  let runner = false;
  let script = false; // the next word is the script of an interpreter
  for (const whole of words) {
    opens?.push(open);
    if (script) {
      script = false;
      open = false;
    }
    const statement = whole.slice(gluedTo(whole).length);
    const word = EXPRESSION.test(statement) ? whole : statement; // (as with a blank)
    const name = programOf(word, open);
    if (open && CONTAINERS.has(name)) client = true;
    first = false;
    if (CONDITIONS.has(word.toLowerCase())) takes += 1;
    else if (client && (name === 'exec' || name === 'run')) {
      open = true;
      wrapped = true;
      takes = 1;
      container = true;
      client = false;
      assigns = false;
      flags = true;
      runner = true;
    } else if (container && word === '--') takes = 0;
    else if (RUNS.has(name)) {
      open = true;
      wrapped = true;
      shell = SHELLS.includes(name);
      line = READS_A_LINE.has(name);
      takes = TAKES_ONE.has(name) ? 1 : 0;
      expression = false;
      assigns = ASSIGNS.has(name) || name === 'ssh';
      first = false;
      flags = name !== 'ssh'; // (it has a command in a string)
      container = false;
      runner = true;
    } else if (!open || name === '') {
      if (word === '=') expression = true; // ${x} = value
      continue;
    }
    else if (INTERPRETERS.has(name)) {
      script = true;
      assigns = false;
      flags = true;
      runner = true;
    }
    else if (LEADS.has(name)) {
      wrapped = true;
      if (!ASSIGNS.has(name)) assigns = false;
      if (!RESERVED.has(name)) flags = true;
      if (!EXPRESSIONS.has(name)) runner = true;
    } else if (LEADS_AND_TAKE.has(name)) {
      wrapped = true;
      takes += 1;
      assigns = false;
      flags = true;
      runner = true;
    } else if (ASSIGNMENT.test(word) || OPERATOR.test(word)) continue;
    else if (/[$!]|%[\w~%]/.test(word) || TYPE.test(word)) expression = true; // a % alone is a loop of PowerShell
    else if (/^["']*-/.test(word) || (shell && /^["']*\+/.test(word)) || (wrapped && /^["']*\/[A-Za-z]+(?::\S*)?$/.test(word))) {
      if (!wrapped) open = false;
      else if (shell && SCRIPT_FLAG.test(word)) {
        takes = 0;
        line = !FILE_FLAG.test(word);
        assigns = line;
        first = true;
        flags = false;
      } else if (!(container && (word.includes('=') || OF_CONTAINERS.test(word)))) takes += 1;
    } else if (wrapped && /^\d+[a-z]?$/.test(name)) continue;
    else if (takes > 0) {
      takes -= 1;
      first = line; // (behind the host of ssh)
    }
    else open = false;
  }
  return { open, expression, line, assigns, first, flags, runner, script, container: container && /^["']*-(?!-$)/.test(words.at(-1) ?? '') };
}

/**
 * For each place of a text, where the stretch of commands it is in starts when a separator inside quotes separates nothing. Read once for a text, the last two of them kept (the rules work on one text after another).
 */
const stretches = [];
function stretchStarts(text, escapes, braces) {
  const known = stretches.find((item) => item.text === text && item.escapes === escapes && item.braces === braces);
  if (known) return known.starts;
  const starts = new Int32Array(text.length + 1);
  let quote = '';
  let ansi = false;
  let from = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    starts[index] = from;
    if (quote !== '') {
      if (escapes && character === '\\' && (quote === '"' || ansi)) {
        index += 1;
        starts[index] = from;
      } else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
      ansi = character === "'" && text[index - 1] === '$';
    } else if (escapes && (character === '\\' || (character === '^' && endsLine(text, index + 1) > 0))) {
      for (let left = Math.max(1, endsLine(text, index + 1)); left > 0; left -= 1) {
        index += 1;
        starts[index] = from;
      }
    } else if (isBreak(character) && (braces || (character !== '{' && character !== '}')) && !((character === '&' || character === '|') && (text[index - 1] === '>' || text[index - 1] === '<'))) from = index + 1;
  }
  starts[text.length] = from;
  stretches.unshift({ text, escapes, braces, starts });
  stretches.length = Math.min(stretches.length, 8);
  return starts;
}

/** A stretch in which the blanks of ${any name} of PowerShell are no blanks. */
function bracesJoined(stretch) {
  let joined = '';
  let at = 0;
  for (let open = stretch.indexOf('${'); open !== -1; open = stretch.indexOf('${', at)) {
    const close = stretch.indexOf('}', open);
    if (close === -1) break;
    joined += stretch.slice(at, open) + stretch.slice(open, close + 1).replace(/\s/g, '_');
    at = close + 1;
  }
  return joined + stretch.slice(at);
}
const CASE = /(?<![\w-])case(?![\w-])/; // a case of bash: its patterns end with a bracket (case $x in a) ...), so brackets do not tell where a substitution ends
const tables = [];
/**
 * Whether a hashtable of PowerShell (@{ ... ) is open in front of text[at]; the braces inside quotes count for nothing, and from a quote that is not closed on there is a doubt: open. Read once for a text, the last
 * four of them kept.
 */
function inTable(text, at) {
  let known = tables.find((item) => item.text === text);
  if (known === undefined) {
    const open = new Uint8Array(text.length + 1);
    if (text.includes('@{')) {
      const stack = [];
      const substitutions = []; // the $( ) inside double quotes that are open, with how many ( are open in each
      let depth = 0;
      let quote = '';
      let opened = -1;
      for (let index = 0; index < text.length; index += 1) {
        open[index] = depth > 0 ? 1 : 0;
        const character = text[index];
        if (quote !== '') {
          if (character === '`' && quote === '"') {
            index += 1;
            open[index] = open[index - 1];
          } else if (character === '$' && quote === '"' && text[index + 1] === '(') {
            if (CASE.test(text)) {
              opened = index;
              break; // (a doubt: open from here)
            }
            substitutions.push(0);
            quote = '';
            index += 1;
            open[index] = open[index - 1];
          } else if (character === quote) quote = '';
        } else if (character === '"' || character === "'") {
          quote = character;
          opened = index;
        } else if (character === '{') {
          const table = text[index - 1] === '@';
          stack.push(table);
          depth += table ? 1 : 0;
        } else if (character === '}' && stack.length > 0) depth -= stack.pop() ? 1 : 0;
        else if (character === '(' && substitutions.length > 0) substitutions[substitutions.length - 1] += 1;
        else if (character === ')' && substitutions.length > 0) {
          if (substitutions.at(-1) === 0) {
            substitutions.pop();
            quote = '"';
          } else substitutions[substitutions.length - 1] -= 1;
        }
      }
      open[text.length] = depth > 0 ? 1 : 0;
      if (quote !== '') open.fill(1, opened);
    }
    known = { text, open };
    tables.unshift(known);
    tables.length = Math.min(tables.length, 4);
  }
  return known.open[at] === 1;
}
/** Where the value of the entry of a hashtable that holds text[start - 1] begins, behind its equals sign; -1 when it is none. A semicolon or a line break begins an entry. */
function entryBefore(text, start) {
  if (!inTable(text, start)) return -1;
  const table = text.lastIndexOf('@{', start);
  let from = start;
  while (from > table + 2 && !/[;\n]/.test(text[from - 1])) from -= 1;
  const equals = text.indexOf('=', from);
  return equals === -1 || equals >= start ? -1 : equals + 1;
}
/** Where the stretch that begins at `from` begins when the lines that go on in front of it (a backtick at the end of a line) are read as one. */
function continuedFrom(text, from, braces) {
  let at = from;
  for (let lines = 0; lines < MOST_EXPANSIONS && text[at - 1] === '\n'; lines += 1) {
    const tick = text[at - 2] === '`' ? at - 2 : text[at - 2] === '\r' && text[at - 3] === '`' ? at - 3 : -1;
    if (tick === -1) break;
    at = wordAt(text, tick, false, braces).from;
  }
  return at;
}
/** Whether it does, with the words as they stand between blanks or as the shells join them (a quoted or an escaped blank is a part of a word, and in bash a backslash escapes a quote inside double quotes): one of them is enough. */
function expectsCommand(text, from, start, braces = true) {
  // an expansion in front is a word of the command: behind an ordinary program the words that follow it are arguments still (x $(y) "a=b")
  const stretch = text.slice(acrossExpansions(text, from, (at) => stretchStarts(text, false, braces)[at]), start);
  const bare = { ...expects(bracesJoined(stretch).replace(REDIRECTION, ' ').split(BLANKS).filter(Boolean)), partial: '' };
  const readings = [bare];
  const continued = continuedFrom(text, from, braces); // PowerShell: a backtick at the end of a line joins it to the next
  if (continued < from) readings.push({ ...expects(bracesJoined(text.slice(continued, start)).replace(REDIRECTION, ' ').split(BLANKS).filter(Boolean)), partial: '' });
  const entry = entryBefore(text, start); // in the value of an entry of a hashtable, behind what runs something
  for (const escapes of [false, true]) {
    const starts = stretchStarts(text, escapes, braces);
    const joinedFrom = acrossExpansions(text, starts[start], (at) => starts[at]);
    const stretch = text.slice(joinedFrom, start);
    if (entry === -1 && joinedFrom === from && !/["'\\]/.test(stretch)) continue;
    const { words, unclosed } = joinedWords(stretch, escapes);
    const joined = { ...expects(words.slice(0, -1)), partial: words.at(-1) };
    // In a quote that is open the place is that of the word it belongs to; the value of an assignment is no command, and the words of a string that is a command are those between the blanks.
    if (!unclosed || !(joined.line || ASSIGNMENT.test(words.at(-1)))) readings.push(joined);
    if (entry === -1) continue;
    const { words: inEntry } = joinedWords(text.slice(entry, start), escapes);
    const value = { ...expects(inEntry.slice(0, -1)), partial: inEntry.at(-1) };
    if (value.runner) readings.push(value);
  }
  const open = readings.filter((reading) => reading.open && !reading.container); // (the value of a flag of a container client is no command)
  return {
    open: open.length > 0,
    expression: readings.some((reading) => reading.expression),
    program: (lead) => open.some((reading) => !reading.assigns || !IS_ASSIGNED.test(reading.partial + (reading.line ? lead.replace(/^["']/, '') : lead))), // a word that begins with `lead` is the name of a program, whatever it looks like
    first: open.some((reading) => reading.first),
    script: open.some((reading) => reading.line),
    runner: open.some((reading) => reading.runner),
    interpreter: open.every((reading) => reading.script), // no command is expected, or only a script
  };
}
const MAY_VANISH = /^(?:\$\{?\w+\}?)+$/; // a word that is nothing but variables, without quotes
/**
 * Whether the word at `start`, which begins with a minus, is the name of a program to bash (to PowerShell and cmd it is none): nothing that has flags is in front of it. `strings`: the quoted strings of the text.
 */
function flagIsAProgram(text, start, strings) {
  let from = stretchStarts(text, true, false)[start];
  const line = text.lastIndexOf('\n', start - 1) + 1; // (only a backslash in front of it joins two lines, and only outside quotes)
  if (line > from && text[line - 2] !== '\\' && !joinedWords(text.slice(from, line), true).unclosed) from = line;
  const { words } = joinedWords(text.slice(from, start), true);
  const { open, flags } = expects(words.slice(0, -1));
  if (!open || (flags && words.at(-1) === '') || words.slice(0, -1).some((word) => /[$%]|!./.test(word) && !MAY_VANISH.test(word))) return false;
  // Behind the end of a substitution stands the next argument of its command, when the command is not still expected where the substitution begins.
  const front = text.slice(0, from);
  if (text[from - 1] === '`' && front.split('`').length % 2 === 1 && !/["'#\\]/.test(front)) {
    const word = wordAt(text, text.lastIndexOf('`', from - 2), false, false);
    return expectsCommand(text, word.from, word.start, false).open;
  }
  if (text[from - 1] !== ')' || strings.until < from || /(?<![\w-])case(?![\w-])/.test(text)) return true;
  const opened = [];
  for (let index = 0, next = 0; index < from - 1; index += 1) {
    if (strings[next]?.start === index) index = strings[next++].end;
    else if (text[index] === '(') opened.push(index);
    else if (text[index] === ')') opened.pop();
  }
  const at = opened.pop();
  if (at === undefined || text[at - 1] !== '$') return true;
  const word = wordAt(text, at - 1, false, false);
  return expectsCommand(text, word.from, word.start, false).open;
}
/** Whether a word has a folder in front of the first colon: the name of a file to PowerShell. */
const hasAFolder = (word) => /^[^:\\/]*[\\/]/.test(word);
/** The end of the word that starts at `start`: a blank or a separator that is not in quotes. */
function wordEnd(text, start) {
  let quote = '';
  let end = start;
  while (end < text.length && (quote !== '' || !(isBlank(text[end]) || isBreak(text[end]) || text[end] === '<' || text[end] === '>'))) {
    if (quote !== '') quote = text[end] === quote ? '' : quote;
    else if (text[end] === '"' || text[end] === "'") quote = text[end];
    end += 1;
  }
  return end;
}
const BLANKS = /\s+/;
const OPERATOR_OF_REDIRECTION = /^(?:<<-|[<>]&|>\||[<>])/; // (the rest of them are one behind the other)
/**
 * The words of a stretch, a quoted or an escaped blank being a part of one, without the redirections and their files; `unclosed` when the last one ends in an open quote, `file` when the stretch ends where the file of a
 * redirection stands, or in it. `escapes`: a backslash escapes inside double quotes and $'...'.
 */
function joinedWords(stretch, escapes) {
  const words = [];
  let word = '';
  let file = false; // the next word is the file of a redirection
  let quote = '';
  let ansi = false;
  const finish = () => {
    if (word !== '' && !file) words.push(word);
    if (word !== '') file = false;
    word = '';
  };
  for (let index = 0; index < stretch.length; index += 1) {
    const character = stretch[index];
    if (quote !== '') {
      if (escapes && character === '\\' && (quote === '"' || ansi)) {
        word += character;
        index += 1;
      } else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
      ansi = character === "'" && stretch[index - 1] === '$';
    } else if ((character === '\\' || character === '^') && endsLine(stretch, index + 1) > 0) {
      index += endsLine(stretch, index + 1); // a word goes on in the next line
      continue;
    } else if ((character === '\\' || character === '^') && index + 1 < stretch.length) {
      word += character;
      index += 1;
    } else if (isBlank(character)) {
      finish();
      continue;
    } else if (character === '<' || character === '>') {
      if (/^[0-9]+$/.test(word)) word = '';
      finish();
      index += OPERATOR_OF_REDIRECTION.exec(stretch.slice(index, index + 3))[0].length - 1;
      file = true;
      continue;
    }
    word += stretch[index];
  }
  const reading = { words, unclosed: quote !== '' && !file, file };
  if (word === '') words.push('');
  finish();
  return reading;
}

const REDIRECTION = /(?<![0-9*])[0-9*]*[<>]+[&|-]?\s*[^\s<>]*/g;
/**
 * The word that holds the character before `at`: where it starts, where its stretch does (after the last separator of commands), and the words of the stretch in front of it, without the redirections (a command
 * can follow them). With `escapes`, the escape of a line break (\n, `n) is a separator too; without `braces`, a brace is a part of a word.
 */
function wordAt(text, at, escapes, braces = true) {
  const separates = (index) => {
    const character = text[index];
    if ((character === '&' || character === '|') && (text[index - 1] === '>' || text[index - 1] === '<')) return false; // 2>&1, >|file
    if (escapes && (character === 'n' || character === 'r') && (text[index - 1] === '\\' || text[index - 1] === '`')) return true;
    return isBreak(character) && (braces || (character !== '{' && character !== '}'));
  };
  let start = at;
  while (start > 0 && !isBlank(text[start - 1]) && text[start - 1] !== '<' && text[start - 1] !== '>' && !separates(start - 1)) start -= 1;
  let from = start;
  while (from > 0 && !separates(from - 1)) from -= 1;
  return { start, from, words: text.slice(from, start).replace(REDIRECTION, ' ').split(BLANKS).filter(Boolean) };
}

// ------------------------------------------------------------------ what a command says about itself
const SHELL = /(?<![\w.-])(?:(?:r?ba|da|a|k|mk|z|t?c|fi|r)?sh|cmd|powershell(?:_ise)?|pwsh|wsl|ssh|su)(?:\.exe)?(?![\w-])/i;
const POWERSHELL = /(?<![\w.-])(?:powershell(?:_ise)?|pwsh)(?![\w-])/i;
// A blank that is one to PowerShell and a part of a word to bash, a control character, a mark that changes the direction of the text: the shells do not read such a text alike, and the card may not show it as it is.
const UNUSUAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]|\r(?!\n)/;
// Text that is read as code by a way of its own: a comment of PowerShell (its quotes are none), the drives of its functions and aliases, the call of what a command writes, the source of a substitution or a heredoc,
// a loop of cmd whose variable is no letter (it can be any character).
const OTHER_WAYS = /<#|(?:function|alias):|newscriptblock|invokescript|expandstring|diagnostics\.process|wscript\.shell|shell\.application|win32_process|\.invoke\(|%(?![A-Za-z][\s,;=])[^\s%]{1,3}[\s,;=]+in[\s,;=]*\(|(?:^|[\s;|&({=,+])[&.](?:\s|`)*\(|[<>]\(/i;
const SOURCES = /(?:^|[\s;|&({])(?:source|\.)\s/;
const EVALUATES = /(?<![\w.-])(?:eval|iex|invoke-expression|scriptblock|alias|set-alias|new-alias|sal|nal|doskey|trap|hash\s+-p)(?![\w-])/i;
const STARTS = /(?<![\w.-])(?:start-process|saps|invoke-item|ii|invoke-command|icm|call|xargs|parallel)(?![\w-])/i;
const DECODES = /base64['"]?\s[^|;&\n]*?-(?:\w*d|-d)|basenc|frombase64string|b64decode|certutil|openssl\S*\s+(?:enc|base64)|xxd\S*\s+-\w*r|unhexlify|uudecode|\batob\b/i;
const ENCODED_FLAG = /(?:^|[\s"'`(,;])[-/\u2013-\u2015](?:e|ec|en[a-z]*)["'`]*(?=[\s:]|$)/i;
// The output of these comes from the network, not from the words of their command line.
const FETCHES = /^(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)$/i;
// $name, ${name}, $env:name, $1, $_, a ${...} with any other name of PowerShell, %name%, %name:a=b%, the %i of a loop, !name!
const EXPANSIONS = /\$(?:env:)?\{?([A-Za-z_\u0080-\uffff]\w*|[0-9@*?!#])|\$\{|%([A-Za-z_][^%\s"';&|<>()]*)(?:%|:)|%%?~?([A-Za-z])\b|!([A-Za-z_][^!\s"']*)!/gi;
const LOOP_DECLARED = /for(?:\s+(?:"[^"]*"|[^\s%"]\S*))*\s+$/i; // for /f "tokens=1" %i: the place where the variable of the loop is given
const SUBSTITUTES = /\(|`(?!\r?\n)/;
// What a shell itself fills in from the command: the last argument, the line that was read, the arguments of a block.
const FILLED_IN = new Set(['_', 'reply', 'mapfile', 'bash_rematch', 'optarg', 'bash_argv', 'bash_command', 'bash_execution_string', 'args', 'input', 'psitem', 'matches', 'myinvocation', 'psboundparameters']);
// The same of PowerShell, where the name of a program is expected: a word that is nothing else is an expression.
const FILLED_IN_TOO = new Set(['error', 'stacktrace', 'this', 'event', 'eventargs', 'sender']);

/** Whether a pattern is in the text, or in the text without the characters that the name of a program can be written around with (pow""ershell, p^owershell). */
const says = (pattern, text) => pattern.test(text) || pattern.test(text.replace(/["'^`\\]/g, ''));
/** A name in a pattern. */
const asPattern = (name) => name.replace(/\W/g, '\\$&');
/** Whether `name` stands in the text otherwise than as its own expansion ($name, ${name}, $env:name, %name%, !name!): assigned, read, the word of a loop, given a value by ${name:=value} of bash, or a list. */
const namedIn = (text, name) => new RegExp(`(?:(?<![$%!{:@\\w])|\\$\\{(?=\\w+(?:\\[|:*=)))${asPattern(name)}(?!\\w)`, 'i').test(text);
const assignedIn = (text, name) => new RegExp(`(?<![$%!{:\\w-])${asPattern(name)}\\+?=`, 'i').test(text);

const PROGRAM_FLAG = /^-(?:fi?|fil\w*|fu\w*|na?|nam\w*|pa?|pat\w*|l|li\w*):/i; // -FilePath:program, -FullyQualifiedName:module, -Name:module, -Path:file, -LiteralPath:file of PowerShell, and what they can be shortened to
/** How the word at `index`, which holds an expansion, stands where a command is expected (a brace is a group only there: "% { $_.Name }" is an argument and a block of PowerShell): null when it does not. */
function placeOf(text, index, strings) {
  const { start, from, words } = wordAt(text, index, false, false);
  // what is assigned to a variable of PowerShell, or to an entry of a hashtable: an expression (a string is read whole), or a command
  const string = strings.find((item) => item.start <= index && index < item.end);
  const word = string === undefined ? { start, words } : wordAt(text, string.start - 1, false, false);
  const value = text.slice(word.start, string?.start ?? index);
  const glued = gluedTo(value);
  const right = value.slice(glued.length);
  const entry = entryBefore(text, index);
  const inEntry = entry === -1 ? '' : text.slice(entry, string?.start ?? index).trimStart();
  if (entry !== -1 && !/\s/.test(inEntry) && !EXPRESSION.test(inEntry)) return { alone: false };
  const { runner, interpreter } = expectsCommand(text, from, start, false);
  const lead = text.slice(start, index).replace(QUOTES, '').replace(/^[{@]+/, '');
  const block = wordAt(text, index, false);
  const there = block.from === from && block.start === start && !/[{}]/.test(text) ? { runner, interpreter } : expectsCommand(text, block.from, block.start);
  if (there.runner && !there.interpreter && (!lead.startsWith('-') || PROGRAM_FLAG.test(lead)) && !ASSIGNMENT.test(lead)) return { alone: false }; // behind a runner in a block
  if (interpreter || lead.startsWith('-') || ASSIGNMENT.test(lead)) return null; // an argument, or the script of an interpreter (what it does with one that a variable names is its own)
  if (word.words.length > 1 && OPERATOR.test(word.words.at(-1))) return EXPRESSION.test(right) ? null : { alone: false }; // $x = value
  if (glued.endsWith('=') && EXPRESSION.test(right)) return { alone: true };
  return { alone: !runner && lead === '' }; // an expression of PowerShell
}
const runsHere = (text, index, strings) => placeOf(text, index, strings) !== null;
const GAP = /^[\s`]$/; // what can stand between a variable and its operator
/**
 * Whether the command sets a variable, in any of the ways of the three shells, as far as it can be told: the name stands in the text otherwise than as its own expansion, or as one that something is assigned to, that is
 * one of a list or of a loop, or that a function can be given.
 */
function setsVariable(text, name) {
  if (FILLED_IN.has(name.toLowerCase()) || FILLED_IN_TOO.has(name.toLowerCase()) || namedIn(text, name)) return true;
  const word = asPattern(name);
  if (new RegExp(`(?<!\\$\\{?)(?:variable|env|environment:):${word}(?!\\w)`, 'i').test(text)) return true;
  let seen = 0;
  for (const match of text.matchAll(new RegExp(`\\$\\{?(?:\\w+:)?${word}\\}?(?!\\w)`, 'gi'))) {
    seen += 1;
    const end = match.index + match[0].length;
    const near = text.slice(end, end + 80);
    const members = /^(?:[\w.:'"$()]|\[[^\]]*\])*/.exec(near)[0].length;
    if (members === 80 || (near[members] === '[' && near.length === 80)) return true; // too much to read
    let behind = end + members;
    while (GAP.test(text[behind])) behind += 1;
    if (/^(?:(?:[-+*/%]|\?\??)?=(?!=)|,)/.test(text.slice(behind, behind + 4)) || /^(?:\+\+|--)(?![\w-])/.test(near.slice(members)) || /^in\b/i.test(text.slice(behind, behind + 3))) return true;
    let front = match.index;
    while (GAP.test(text[front - 1])) front -= 1;
    if (/(?:,|\[ref\])$/i.test(text.slice(Math.max(0, front - 5), front)) || /(?:\+\+|--)$/.test(text.slice(Math.max(0, match.index - 2), match.index))) return true;
  }
  return seen > 1 && /(?<![\w-])(?:param|function|filter)(?![\w-])/i.test(text);
}
const VARIABLE = /\$(?:\{([^}]*)\}|\{?([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)(?::([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*))?)/y;
/** The names that a variable can have: that of $name (to bash it ends where ASCII does), of $scope:name, of $name in front of a colon, of ${any text} (closed) and of ${name:-value}; env is a drive, and a name only where something is assigned to it. */
function namesOf([, braced, name, scoped], text) {
  const names = braced === undefined ? [name, /^\w*/.exec(name)[0], scoped] : [braced.slice(braced.lastIndexOf(':') + 1), /^\w*/.exec(braced)[0]];
  return names.filter((item) => item && (item.toLowerCase() !== 'env' || assignedIn(text, 'env')));
}
/** The names of the variable that begins at a place of a text. */
function namesAt(text, index) {
  VARIABLE.lastIndex = index;
  const match = VARIABLE.exec(text);
  return match === null ? [] : namesOf(match, text);
}
/** The end of the word behind a call operator of PowerShell, which can be made of brackets, quotes, a cast, a here-string. */
function endOfCalled(text, start) {
  let depth = 0;
  let quote = '';
  let index = start;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== '') quote = character === quote ? '' : quote;
    else if (character === '"' || character === "'") quote = character;
    else if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (isBlank(character) ? !isBlank(text[index - 1]) && !TYPE.test(text.slice(start, index)) : /[;|&\r\n]/.test(character))) break;
  }
  return index;
}
const CALLS = /(?<![&<>])&|(?<![^\s;|&({=])\.(?=[\s`"'$(@[{])/g;
/** Whether a word behind a call operator (& or a dot) holds a variable that the command sets. Those words overlap when operators are nested, so the variables are asked about first, each of them once. */
function callsAVariable(text, sets, strings) {
  const calls = [...text.matchAll(CALLS)];
  const places = [];
  if (calls.length > 0) for (let at = text.indexOf('$'); at !== -1; at = text.indexOf('$', at + 1)) if (namesAt(text, at).some(sets)) places.push(at);
  let next = 0;
  let dots = 0;
  for (const { 0: operator, index } of calls) {
    if (!(index < places.at(-1))) return false;
    while (next < strings.length && strings[next].end <= index) next += 1;
    if (next < strings.length && strings[next].start <= index) continue; // in a string
    let start = index + 1;
    while (isBlank(text[start]) || (text[start] === '`' && endsLine(text, start + 1) > 0)) start += isBlank(text[start]) ? 1 : 1 + endsLine(text, start + 1);
    const end = endOfCalled(text, start);
    if (!places.some((at) => start <= at && at < end)) continue;
    if (operator === '&') return true;
    dots += 1;
    const place = wordAt(text, index, false, false);
    if (dots > MOST_EXPANSIONS || expectsCommand(text, place.from, place.start, false).open) return true; // (the dot of an argument calls nothing)
  }
  return false;
}
/** Whether an expansion at `index` is the value of a name whose value a program runs. */
const isOfAProgram = (text, index) => joinedBefore(text, index).some(({ words }) => namesAProgram(words));
/** Whether what a variable or a substitution of the command holds is run as a command, and the variable is one that the command itself fills. */
function runsAnExpansion(text) {
  let seen = 0;
  const strings = quotedStrings(text);
  const known = new Map();
  const sets = (name) => {
    if (!known.has(name)) known.set(name, setsVariable(text, name));
    return known.get(name);
  };
  for (const match of text.matchAll(EXPANSIONS)) {
    seen += 1;
    if (seen > MOST_EXPANSIONS) return true;
    let end = match.index;
    while (end > 0 && /[\s"]/.test(text[end - 1])) end -= 1;
    const caller = text.slice(Math.max(0, end - 2), end);
    if (caller.endsWith('&') || /(?:^|[\s;|({])\.$/.test(caller)) return true; // & $x, . $x
    const name = match[1] ?? match[2] ?? match[4];
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 80);
    if (match[3] !== undefined && LOOP_DECLARED.test(text.slice(Math.max(0, match.index - 80), match.index))) continue; // the variable of a loop of cmd where it is given
    const filled = name === undefined || /^[0-9@*?!#]/.test(name) || FILLED_IN.has(name.toLowerCase()); // %i, $1, $@, $_
    const names = filled ? [] : match[0].startsWith('$') ? namesAt(text, match.index) : [name.split(':')[0]];
    if (isOfAProgram(text, match.index)) {
      if (filled) return true;
      // the value of PAGER=$x; that of PATH=$PATH:/x only when the variable is set elsewhere too
      const rest = WHOLE_NAME.test(name) ? `${text.slice(0, stretchStarts(text, false, false)[match.index])} ${text.slice(match.index + match[0].length)}` : text;
      if (names.some((item) => (rest === text ? sets(item) : setsVariable(rest, item)))) return true;
    }
    const place = placeOf(text, match.index, strings);
    if (place === null) continue;
    if (filled) return true;
    if (!namedIn(text, name.split(':')[0]) && (place.alone || !names.some(sets))) continue; // from the environment, or an expression of PowerShell
    if (/^[\w.:[\]'"}]*\s*[-+*/]?=(?!=)/.test(after) && !assignedIn(text, name)) continue; // $x = ..., $x.y = ...: an assignment of PowerShell
    return true;
  }
  for (const match of text.matchAll(/(?<=\s)@([A-Za-z_]\w*)(?![\w/.:=-])/g)) {
    seen += 1; // a splat of PowerShell: arguments, and the program too behind what runs one
    if (seen > MOST_EXPANSIONS || (placeOf(text, match.index, strings)?.alone === false && sets(match[1]))) return true;
  }
  let opening = true;
  for (let index = 0; index < text.length; index += 1) {
    const substitution = text[index] === '$' && text[index + 1] === '(';
    const backtick = text[index] === '`' && !/^\r?\n/.test(text.slice(index + 1, index + 3));
    if (substitution || (backtick && opening)) {
      seen += 1;
      const quote = substitution ? strings.inStrings.find(([at]) => at === index)?.[1] : undefined; // (a substitution inside a string runs where the string stands)
      if (seen > MOST_EXPANSIONS || runsHere(text, quote === undefined ? index : quote + 1, strings) || isOfAProgram(text, index)) return true;
    }
    if (backtick) opening = !opening;
  }
  return callsAVariable(text, sets, strings);
}
/** Whether the command gives a value to a variable of cmd whose name is no word, and reads it: %1a%, %a b%, !a-b! */
function readsAnOddName(text) {
  const bare = text.replace(/\^/g, '').toLowerCase();
  for (const sign of ['%', '!']) {
    for (const piece of new Set(bare.split(sign).slice(1, -1))) {
      const name = piece.split(':')[0];
      if (name !== '' && !/^[a-z_]\w*$/.test(name) && !/[=\n]/.test(name) && bare.includes(`${name}=`)) return true;
    }
  }
  return false;
}
/** Whether something else than the network is piped in the text. */
function pipesText(text) {
  for (let index = text.indexOf('|'); index !== -1; index = text.indexOf('|', index + 1)) {
    if (text[index + 1] === '|' || text[index - 1] === '|' || text[index - 1] === '>') continue;
    const { from } = wordAt(text, index, false);
    if (!FETCHES.test(programOf(text.slice(from, index).trim().split(/\s+/)[0] ?? ''))) return true;
  }
  return false;
}
// ---- Text that the command writes to a file can be code: this command can run the file, or a later one whose card shows only its name.
/** What writes out words that it is given: as an argument of any program (docker exec web echo ...), or only where a command is expected. */
const PRINTS_ANYWHERE = new Set(['echo', 'printf', 'printenv', 'write-output', 'write-host', 'write-information', 'write-warning', 'write-error', 'write-verbose', 'write-debug', 'print', 'puts', 'console.log']);
const PRINTS = new Set(['type', 'write', 'yes', 'expr', 'date', 'basename', 'dirname', 'realpath', 'readlink', 'seq', 'get-date', 'join-path', 'split-path', 'get-variable', 'gv', '-join', '-split']);
/** What the words of are written out by PowerShell too: the drives of its variables, a method. */
const READS_BACK = /(?<![$\w{])(?:env|variable|environment:):|getenvironmentvariable/gi;
/** What writes what it is given to a file, or keeps it as a command: WRITES_ANYWHERE as an argument of any program too, WRITERS with the text in its own words too. */
const SINKS = new Set(['tee', 'tee-object', 'out-file', 'set-content', 'sc', 'add-content', 'ac', 'sponge', 'dd', 'cp', 'install', 'patch', 'ed', 'ex', 'crontab', 'at', 'batch']);
const WRITES_ANYWHERE = new Set(['tee', 'dd', 'sponge', 'patch']);
const WRITERS = new Set(['set-content', 'sc', 'add-content', 'ac']);
const APPLIES = /^\S+\s[^;|&\n]*?(?<!\S)(?:apply|am)(?!\S)/;
const WRITES_A_VALUE = /^(?:new-item|ni|set-content|sc|add-content|ac)\s[^;|&\n]*-va|^(?:out-file|tee-object)\s[^;|&\n]*-inp/i;
const WRITES_BY_CALL = /(?:write|append)all(?:text|lines|bytes)|streamwriter|(?:create|append)text|\.["']?write(?:line)?["']?\s*\(/i;
const NO_FILE = /^(?:\/dev\/(?:null|stdout|stderr|tty|fd\/[0-9]+)|\$null)$/i;
const AFTER_A_STRING = /^\s*(?:[0-9]?>|[|+.,)}*[;\n]|-(?:f|join|[ci]?replace|[ci]?split|as)\b|$)/i;
/** What the statements of a text cannot be told apart with: a quote, an escape, a group, a substitution, a line that goes on, a word that ends a loop. */
const DIVIDED = /[)}`'"]|[\\^][\s;&|]|\|[ \t\r]*[#\n]|\n[ \t\r]*\||(?<![\w-])(?:done|fi)[ \t]*(?:[0-9*&]*[<>]|\|(?!\|))|(?<![\w-])exec(?![\w-])/;
const SEPARATOR = /\n|\|\||(?<![<>|])&(?!>)/g;
/** The pieces of text[from, end) between the matches of a separator: [from, end]. */
function pieces(text, separator, from = 0, end = text.length) {
  const ends = [...text.slice(from, end).matchAll(separator)].map((match) => from + match.index);
  return [...ends, end].map((last, index) => [index === 0 ? from : ends[index - 1], last]);
}
/** Whether an output of text goes to a file (a descriptor and /dev/null are none). */
function redirectsToAFile(text, whole = text) {
  const named = /null/i.test(whole.replace(/\$null(?!\w)|\/dev\/null/gi, '')); // bash: a variable like any other
  for (const [, operator, file] of text.matchAll(/(>>|>\||>&|>)\s*([^\s;|&<>()]*)/g)) {
    if (!(operator === '>&' && /^(?:[0-9]+-?|-)$/.test(file)) && (!NO_FILE.test(file) || (named && file[0] === '$'))) return true;
  }
  return false;
}
/** The words of a text that name one of the `wanted` programs, where a command is expected or (`anywhere`) at any place: {name, index}; null when there are too many of them to look at. */
function programs(text, wanted, anywhere) {
  const found = [];
  let seen = 0;
  for (const match of text.matchAll(/[^\s;|&()`{}<>]+/g)) {
    const entry = entryBefore(text, match.index + match[0].length); // of a hashtable: its value is a statement
    const index = entry > match.index ? entry : match.index + gluedTo(match[0]).length;
    const word = match[0].slice(index - match.index);
    const name = [programOf(word), programOf(word.replace(/\\/g, '')), /^["'@]*echo[.:/\\+[\]]/i.test(word) ? 'echo' : ''].find((item) => wanted(item, index));
    if (name === undefined) continue;
    seen += 1;
    if (seen > MOST_EXPANSIONS) return null;
    const { from, start } = wordAt(text, match.index, false);
    if (anywhere(name) || (entry !== -1 && text.slice(entry, index).trim() === '') || expectsCommand(text, from, start).open) found.push({ name, index });
  }
  return found;
}
/** The strings of a text and the variables that it fills, where a command is expected and as what PowerShell writes out; null when there are too many of them to look at. */
function writtenValues(text) {
  const found = [];
  let seen = 0;
  for (const match of text.matchAll(/(["'])|@["']|\$\{?([A-Za-z_]\w*)(:\w+)?\}?|\]::/g)) {
    if (match[0] !== ']::' && /[^\s,\];|&()`{}<>]/.test(text[match.index - 1] ?? ' ')) continue;
    const { from, start } = wordAt(text, match.index, false);
    const type = text.slice(start, match[0] === ']::' ? match.index + 1 : match.index).replace(/^,/, '');
    if (type !== '' && !TYPE.test(type)) continue;
    if (match[2] !== undefined && text.toLowerCase().split((match[3] ?? match[2]).toLowerCase().replace(':', '')).length < 3) continue; // from the environment
    seen += 1;
    if (seen > MOST_EXPANSIONS) return null;
    const opened = match.index + match[0].length;
    const end = match[1] === undefined ? opened : text.indexOf(match[1], opened) + 1;
    if (end === 0 || (match[0] !== ']::' && !AFTER_A_STRING.test(text.slice(end, end + 40)))) continue;
    if (expectsCommand(text, from, start).open) found.push({ index: match.index });
  }
  return found;
}
/** Whether a command writes text of its own to a file. */
function writesText(text) {
  if (WRITES_BY_CALL.test(text)) return true;
  const sinks = programs(text, (name, index) => SINKS.has(name) || name === 'new-item' || name === 'ni' || (name === 'git' && APPLIES.test(text.slice(index, index + 400))), (name) => WRITES_ANYWHERE.has(name));
  if (sinks === null || sinks.some(({ name, index }) => (WRITERS.has(name) && !/(?<!\|)\|\s*$/.test(text.slice(0, index))) || WRITES_A_VALUE.test(text.slice(index)))) return true;
  const named = says(SHELL, text);
  // An arrow or a tag inside quotes is no redirection, where the shells agree on the string and none is named that reads it once more (single quotes are no quotes to cmd).
  let bare = text;
  for (const { start, end, plain: agreed } of named ? [] : quotedStrings(text)) {
    if (agreed || !text.slice(start, end).includes('>')) bare = bare.slice(0, start - 1) + 'x'.repeat(end - start + 2) + bare.slice(end + 1);
  }
  const files = sinks.filter(({ name }) => SINKS.has(name) || name === 'git');
  if (files.length === 0 && !redirectsToAFile(bare)) return false;
  if (text.includes('<<')) return true;
  const prints = programs(text, (name, index) => PRINTS_ANYWHERE.has(name) || PRINTS.has(name) || (name === 'set' && /^\S*\s*\/p/i.test(text.slice(index, index + 40))), (name) => PRINTS_ANYWHERE.has(name));
  const values = writtenValues(text);
  if (prints === null || values === null) return true;
  const written = [...prints, ...values, ...text.matchAll(READS_BACK)];
  if (written.length === 0) return false;
  if (named || DIVIDED.test(bare)) return true;
  const has = (items, [from, end]) => items.some(({ index }) => index >= from && index < end);
  const toAFile = (piece) => has(files, piece) || redirectsToAFile(bare.slice(...piece), bare);
  return pieces(bare, SEPARATOR).some((statement) => {
    const parts = pieces(bare, /;/g, ...statement);
    const first = parts.find((part) => /[^\s;&|]/.test(bare.slice(...part))) ?? statement; // a semicolon separates nothing to cmd: the words behind it are words of the first command
    return (has(prints, first) && toAFile(statement)) || parts.some((part) => has(written, part) && toAFile(part));
  });
}

/**
 * What a command says about itself: 0 when no word of it reads text as code; 1 when a shell is named in it (what is quoted can be read once more); 2 when text of the command can reach a shell as code by a way
 * that is not read here: a pipe, a variable, a substitution, a decoder, an evaluation.
 */
let last = { text: null, level: 0 }; // the parts of one card are read with the same whole
export function levelOf(text) {
  if (last.text !== text) last = { text: text.length > LONGEST ? null : text, level: readLevel(text) };
  return last.level;
}
function readLevel(text) {
  if (text.length > LONGEST || UNUSUAL.test(text) || OTHER_WAYS.test(text) || (text.includes('<<') && SOURCES.test(text)) || says(EVALUATES, text) || says(DECODES, text) || runsAnExpansion(text) || readsAnOddName(text) || writesText(text)) return 2;
  if (!says(STARTS, text) && !says(SHELL, text)) return 0;
  if (says(POWERSHELL, text) && says(ENCODED_FLAG, text)) return 2;
  const read = text.replace(/\$(?:env:)?[A-Za-z_]\w*\s*\+?=(?!=)/gi, ''); // the left side of an assignment of PowerShell reads no variable
  return pipesText(text) || text.includes('<<') || SUBSTITUTES.test(read) || read.search(EXPANSIONS) !== -1 ? 2 : 1;
}

// ------------------------------------------------------------------ quotes
/**
 * The quoted strings at the start of a text, as far as they can be read without a doubt: `{start, end, lines, plain}`, the text between the quotes (over several lines or not). Bash and PowerShell agree on every one of them, and cmd does too on
 * those that are `plain` (double quotes, one line, and nothing before them that cmd reads in another way). The reading stops at the first thing that the shells do not agree on.
 */
/**
 * Where the double-quoted string that opens at text[index] ends when it holds substitutions ($( ), which can hold strings of their own): both shells end it at the first quote outside them.
 * -1 where that cannot be told: an escape (a backslash, a backtick), a ${, a comment, a quote that stays open, or too deep.
 */
function endOfDouble(text, index, depth = 0) {
  if (depth > 20) return -1;
  for (let at = index + 1; at < text.length; at += 1) {
    const character = text[at];
    if (character === '"') return at;
    if (character === '\\' || character === '`' || (character === '$' && text[at + 1] === '{')) return -1;
    if (character === '$' && text[at + 1] === '(') {
      at = endOfCode(text, at + 2, depth + 1);
      if (at === -1) return -1;
    }
  }
  return -1;
}
/** Where the substitution whose code begins at text[from] closes (its bracket), or -1 (see endOfDouble). */
function endOfCode(text, from, depth) {
  let open = 0;
  for (let at = from; at < text.length; at += 1) {
    const character = text[at];
    if (character === '(') open += 1;
    else if (character === ')') {
      if (open === 0) return at;
      open -= 1;
    } else if (character === '"') {
      at = endOfDouble(text, at, depth);
      if (at === -1) return -1;
    } else if (character === "'") {
      at = text.indexOf("'", at + 1);
      if (at === -1) return -1;
    } else if (character === '\\' || character === '`' || (character === '#' && /\s/.test(text[at - 1] ?? ' ')) || (character === 'c' && CASE.test(text.slice(Math.max(0, at - 1), at + 5)))) return -1;
  }
  return -1;
}
/**
 * Pushes the literal pieces of text[from, close) between its substitutions as strings (`plain` for those of one line), and where those substitutions begin with the quote that opens the string
 * (`inStrings`); false when one does not close inside.
 */
function piecesOf(found, text, from, close, plain) {
  let piece = from;
  for (let at = text.indexOf('$(', piece); at !== -1 && at < close; at = text.indexOf('$(', piece)) {
    if (at > piece) found.push({ start: piece, end: at, lines: /[\r\n]/.test(text.slice(piece, at)), plain: plain && !/[\r\n]/.test(text.slice(piece, at)) });
    const shut = endOfCode(text, at + 2, 1);
    if (shut === -1 || shut >= close) return false;
    found.inStrings.push([at, from - 1, shut]);
    piece = shut + 1;
  }
  if (close > piece) found.push({ start: piece, end: close, lines: /[\r\n]/.test(text.slice(piece, close)), plain: plain && !/[\r\n]/.test(text.slice(piece, close)) });
  return true;
}
export function quotedStrings(text) {
  const found = [];
  found.until = 0; // how far they can be read
  found.inStrings = []; // [the $( of a substitution whose output is a part of a string, the quote that opens that string, its closing bracket]
  if (/[\u2018-\u201f]/.test(text) || text.includes('--%')) return found; // PowerShell: typographic quotes are quotes, --% ends the reading
  let agreed = !/%[^%]*%|![^!]*!|\^|\brem\b/i.test(text); // cmd: a variable can hold a quote, a caret escapes one, what follows rem is not read
  for (let index = 0; index < text.length; index += 1) {
    found.until = index;
    const character = text[index];
    if (character === '`' && /^\r?\n/.test(text.slice(index + 1, index + 3))) continue; // a continued line of PowerShell
    if (character === '`') {
      // backticks that are one word to the three shells (x `cat url` "a b"): the strings go on behind them
      const close = text.indexOf('`', index + 1);
      if (close === -1 || expansionBefore(text, close + 1) !== index) return found;
      index = close;
      continue;
    }
    if (character === '<' && text[index + 1] === '<') return found;
    if (character === '\\') {
      let end = index;
      while (text[end] === '\\') end += 1;
      if (text[end] === '"' || text[end] === "'") return found;
      index = end - 1;
      continue;
    }
    if (character === '#' && (index === 0 || isBlank(text[index - 1]) || isBreak(text[index - 1]))) return found;
    if (character !== '"' && character !== "'") continue;
    if (text[index - 1] === '@' && /^\r?\n/.test(text.slice(index + 1, index + 3))) {
      // a here-string of PowerShell with no quote of its kind in it ends where the string of bash does (a quote in a substitution or behind a backtick is one); in one of double quotes
      // both shells run a substitution (its pieces are strings), bash a backtick too and ${...} in its own way
      const close = text.indexOf(character, index + 1);
      if (close === -1 || text[close + 1] !== '@' || text[close - 1] !== '\n') return found;
      if (character === "'") found.push({ start: index + 1, end: close, lines: true, plain: false });
      else if (/`|\$\{/.test(text.slice(index + 1, close)) || !piecesOf(found, text, index + 1, close, false)) return found;
      agreed = false;
      index = close + 1;
      continue;
    }
    if (text[index - 1] === '$' || text[index - 1] === '@') return found;
    const end = text.indexOf(character, index + 1);
    if (end === -1 || text[end + 1] === character) return found;
    const inner = text.slice(index + 1, end);
    const lines = /[\r\n]/.test(inner);
    if (character === '"' && /`|\$\{|\\$/.test(inner)) return found;
    if (character === '"' && inner.includes('$(')) {
      // the literal pieces between the substitutions are strings; the substitutions are code
      // (cmd reads it as one string when no double quote stands inside it)
      const close = endOfDouble(text, index);
      const nested = close !== -1 && text.slice(index + 1, close).includes('"');
      if (close === -1 || !piecesOf(found, text, index + 1, close, agreed && !nested)) return found;
      if (nested || /[\r\n]/.test(text.slice(index + 1, close))) agreed = false;
      index = close;
      continue;
    }
    found.push({ start: index + 1, end, lines, plain: character === '"' && agreed && !lines });
    if (lines || (character === "'" && inner.includes('"'))) agreed = false;
    index = end;
  }
  found.until = text.length;
  return found;
}

// ------------------------------------------------------------------ the place
// PowerShell: a command without a folder is looked for on the path, among the functions and on the drives, so it is a program where the command changes them.
const MAKES_A_COMMAND = /env:(?:path(?!\w)|(?!\w))|environment::[\\/]?path(?!\w)|setenvironmentvariable|commandnotfoundaction|(?<![\w.-])(?:ipmo|import-module)(?![\w-])|(?<![\w-])(?:function|filter|workflow)\s+[^\s{(]*=/i;
const MAKES_A_DRIVE = /new-psdrive|-psprovider|(?<![\w.-])(?:ndr|mount)\s[^;|&\n]*filesystem/i;
// $name = "..., ${name}="..., $env:name = '..., $x['name'] = "..., $x = [string]"...: the string is data, and the variable that holds it is another question (runsAnExpansion).
const ASSIGNED_TABLE = /(?:^|[\s;|&(])(?:\[[\w.]+(?:\[\])?\])?\$[\w:.]+(?:\[[^\]]*\])?\+?=(?:\[[\w.]+\])?$/; // what a hashtable is glued to: $h=@{, $h=[ordered]@{
const POWERSHELL_ASSIGNMENT = /(?:^|[\s"'\]])\$\{?[\w:.]+\}?(?:\[["']?[\w-]+["']?\])?(?:\s+\+?=\s*|\+?=)(?:\[[\w.]+(?:\[\])?\]\s*)*["']$/;
/** The words in front of text[start, ...) as the shells join them, the one that it stands in among them: a quote or an escape of bash, and without one; those of the entry of a hashtable too; the escapes of PowerShell. A line that goes on is one line. */
function joinedBefore(text, start) {
  const whole = text.replace(/`\r?\n/g, (match) => ' '.repeat(match.length)); // (joinedWords knows the other lines that go on)
  const entry = entryBefore(whole, start);
  const from = [false, true].flatMap((escapes) => {
    const starts = stretchStarts(whole, escapes, false);
    return [[acrossSubstitutions(whole, starts[start], (at) => starts[at]), escapes], [entry, escapes]];
  }).filter(([at]) => at !== -1);
  const readings = from.map(([at, escapes]) => joinedWords(whole.slice(at, start), escapes));
  if (!whole.includes('`')) return readings;
  const escaped = escapedOfPowerShell(whole);
  return [...readings, joinedWords(escaped.slice(stretchStarts(escaped, false, false)[start], start), false)];
}
/**
 * The text as PowerShell joins its words: a backtick escapes the character behind it, which stays in the word (a.exe`TOKEN=x is one file), a blank too (x > a` X writes to the file "a X"); an
 * escaped backtick escapes no blank (a`` X). The backtick and the blank or backtick that it escapes become `_`, so every place stays where it is. (In single quotes a backtick is a character,
 * but there a blank ends no word either. An escaped quote or bracket the other readings take for one, which shows more; to cmd it is one. In double quotes an escaped quote leaves the
 * string open to PowerShell, where bash runs the backticks or fails: the level, or the doubt of quotedStrings about a string with a backtick, shows it.)
 */
const escapedOfPowerShell = (text) => text.replace(/`[\s`]?/g, (found) => '_'.repeat(found.length));
const codes = [];
/**
 * For each place of a text, where the code of the substitution ($( )) that holds it begins when the innermost bracket open in front of it is one, else -1; `opens` is where the substitution that a
 * closing bracket closes begins ($). Read once for a text, the last four kept.
 */
function substitutions(text) {
  let known = codes.find((item) => item.text === text);
  if (known === undefined) {
    const starts = new Int32Array(text.length + 1).fill(-1);
    const opens = new Map();
    if (text.includes('$(')) {
      const stack = [];
      const cased = CASE.test(text); // (a bracket can end a pattern of a case: a substitution stays open)
      for (let index = 0; index < text.length; index += 1) {
        starts[index] = stack.at(-1) ?? -1;
        if (text[index] === '(') stack.push(text[index - 1] === '$' ? index + 1 : -1);
        else if (text[index] === ')' && !(cased && (stack.at(-1) ?? -1) !== -1)) {
          const code = stack.pop() ?? -1;
          if (code !== -1) opens.set(index, code - 2); // (the $ of what it closes)
        }
      }
    }
    known = { text, starts, opens };
    codes.unshift(known);
    codes.length = Math.min(codes.length, 4);
  }
  return known;
}
/** Where a stretch that begins at `from` begins when the closing brackets of substitutions in front of it separate nothing (x $(y) tee a, "$(y)" @{...}). */
function acrossSubstitutions(text, from, starts) {
  const { opens } = substitutions(text);
  for (let times = 0; times < MOST_EXPANSIONS && opens.has(from - 1); times += 1) from = starts(opens.get(from - 1));
  return from;
}
// What backticks may hold to be one word to the three shells (a substitution of bash, two escapes of PowerShell, text to cmd): no quote, escape, separator or other expansion.
const SIMPLE_TICKS = /^[^\r\n"'`\\$;|&<>(){}#]*$/;
const marks = [];
/** Where a text first has a bracket at the start of a word, and a quote, a comment or an escape; the backticks of it in order. Read once for a text, the last four kept. */
function marksOf(text) {
  let known = marks.find((item) => item.text === text);
  if (known === undefined) {
    const ticks = [];
    for (let index = text.indexOf('`'); index !== -1; index = text.indexOf('`', index + 1)) ticks.push(index);
    known = { text, group: text.search(/(?:^|[\s;&|=,(<>])\(/), quoted: text.search(/["'#\\]/), ticks };
    marks.unshift(known);
    marks.length = Math.min(marks.length, 4);
  }
  return known;
}
/**
 * Where the expansion that ends right in front of text[at] begins, when a blank follows it: a substitution, or backticks of SIMPLE_TICKS with no quote, comment or escape in front of them.
 * It is one word of the command that it stands in, which may be empty ($(y) ./x runs ./x, x $(y) ./x does not). -1 when none ends there.
 */
function expansionBefore(text, at) {
  if (!isBlank(text[at] ?? '')) return -1;
  const { group, quoted, ticks } = marksOf(text);
  const close = text[at - 1] === '"' ? at - 2 : at - 1; // (the quote of a string can follow the bracket: -h "$(cat host)")
  if (text[close] === ')') {
    // (to cmd a bracket ends a group that a bracket at the start of a word opened: none may stand in front)
    const begins = substitutions(text).opens.get(close) ?? -1;
    return begins === -1 || (group !== -1 && group < begins) ? -1 : begins;
  }
  if (text[at - 1] !== '`') return -1;
  const closing = ticks.indexOf(at - 1);
  if (closing % 2 === 0) return -1; // (an even number of backticks in front of the pair, so that its first one opens it)
  const open = ticks[closing - 1];
  // (to PowerShell the closing backtick escapes the blank: where they are a file, x > `y` X, the reading of PowerShell in joinedBefore has the next word in it)
  return !SIMPLE_TICKS.test(text.slice(open + 1, at - 1)) || (quoted !== -1 && quoted < open) ? -1 : open;
}
const readStrings = [];
/** How far the strings of a text are known (quotedStrings: the shells agree on the quotes up to there). Read once for a text, the last four kept. */
function stringsKnown(text) {
  let known = readStrings.find((item) => item.text === text);
  if (known === undefined) {
    known = { text, until: quotedStrings(text).until };
    readStrings.unshift(known);
    readStrings.length = Math.min(readStrings.length, 4);
  }
  return known.until;
}
/**
 * Where a stretch that begins at `from` begins when the expansions that end right in front of it, and in front of the stretch that holds each of them, are words of it: `starts` gives where the
 * stretch of a place begins. Only where the shells agree on the quotes up to there (tool \' $(x) --token=X). (An expansion where a command is expected runs, and such a command is read by no pattern.)
 */
function acrossExpansions(text, from, starts) {
  let at = from;
  for (let times = 0; times < MOST_EXPANSIONS; times += 1) {
    const expansion = expansionBefore(text, text[at] === '"' ? at + 1 : at); // (a stretch that the bracket of "$(y)" ends begins at the closing quote)
    if (expansion === -1 || stringsKnown(text) < at) break;
    at = starts(expansion);
  }
  return at;
}
/** text[from, end) without the expansions of expansionBefore that stand wholly in it (what separates the commands of a substitution separates nothing outside it). */
function withoutExpansions(text, from, end) {
  let kept = '';
  let at = end;
  for (let index = end - 1; index >= from; index -= 1) {
    if (text[index] !== ')' && text[index] !== '`' && text[index] !== '"') continue;
    const expansion = expansionBefore(text, index + 1);
    if (expansion < from) continue;
    kept = `_${text.slice(index + 1, at)}${kept}`;
    at = expansion;
    index = expansion;
  }
  return text.slice(from, at) + kept;
}
/**
 * The words in front of text[start, ...) in the statement that a block opens (gci | % { cp a X }, function f { cp a X }: a brace that follows no $ and no @) or a substitution opens, inside double
 * quotes too ("$(cp a X)"), which the readings of joinedBefore take for arguments.
 */
function statementsBefore(text, start) {
  const found = [];
  for (const escapes of [false, true]) {
    const from = stretchStarts(text, escapes, true)[start];
    if (text[from - 1] === '{' && !/[$@]/.test(text[from - 2] ?? '')) found.push(joinedWords(text.slice(from, start), escapes).words);
  }
  const code = substitutions(text).starts[start];
  if (code !== -1) {
    const piece = text.slice(code, start);
    const cut = Math.max(...[';', '|', '&', '(', ')', '\n'].map((separator) => piece.lastIndexOf(separator))); // (behind the pattern of a case too)
    found.push(joinedWords(piece, false).words, joinedWords(piece.slice(cut + 1), false).words);
  }
  return found;
}
/** Whether the word at `start` is the file of a redirection, with no quote and no escape read (a caret is no escape to bash and PowerShell: x a^> X, nor a backslash to PowerShell). */
const redirects = (text, start) => /[<>]/.test(text.slice(0, start).trimEnd().at(-1) ?? '');
/**
 * Whether text[start] is in the file of a redirection as cmd reads its line: only double quotes are quotes, a caret escapes, a blank ends the file, and a file in double quotes goes on to
 * the closing one (x ' > "a X": to bash and PowerShell a string, to cmd the file "a X"). Read once for a text, the last four kept.
 */
const filesOfCmd = [];
function inFileOfCmd(text, start) {
  let known = filesOfCmd.find((item) => item.text === text);
  if (known === undefined) {
    const files = new Uint8Array(text.length + 1); // in front of each place: 0 no file, 1 a redirection waits for its file, 2 in it
    let quote = false;
    let file = 0;
    for (let index = 0; index < text.length; index += 1) {
      files[index] = file;
      const character = text[index];
      if (character === '\n') {
        quote = false;
        file = 0;
      } else if (character === '"') {
        quote = !quote;
        if (file === 1) file = 2;
      } else if (quote) continue;
      else if (character === '<' || character === '>') file = 1;
      else if (isBlank(character)) file = file === 2 ? 0 : file; // (a word glued to & or | is the first word of a command: readable as such)
      else {
        if (file === 1) file = 2;
        if (character === '^' && index + 1 < text.length) files[(index += 1)] = file;
      }
    }
    files[text.length] = file;
    known = { text, files };
    filesOfCmd.unshift(known);
    filesOfCmd.length = Math.min(filesOfCmd.length, 4);
  }
  return known.files[start] !== 0;
}

// What a shell reads, runs or searches before anything else, and the names whose value a program of every day runs. A short list: a program can run any of its arguments.
const VARIABLES = ['BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'PS[0-4]', 'PATH', 'PATHEXT', 'COMSPEC', 'SHELL', 'LD_PRELOAD', 'GIT_SSH(?:_COMMAND)?', 'GIT_EXTERNAL_DIFF', 'PAGER', 'MANPAGER', 'EDITOR', 'VISUAL', '\\w+_EDITOR', '\\w+_ASKPASS', '\\w+_PAGER',
  'npm_config_script_shell', 'NODE_OPTIONS', 'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT', 'BROWSER', 'LESSOPEN'].join('|');
const KEYS = ['core\\.(?:sshcommand|pager|editor|hookspath|fsmonitor|askpass)', 'alias\\.[\\w-]+', 'pager\\.[\\w-]+', 'diff\\.external', 'sequence\\.editor', 'gpg\\.(?:\\w+\\.)?program', 'proxycommand', 'localcommand', 'knownhostscommand', 'script-shell'].join('|');
const GROUPS = ['filter', 'merge', 'diff', 'difftool', 'mergetool', 'credential'].join('|'); // of git: group.name.key
const KEYS_OF_A_GROUP = ['clean', 'smudge', 'process', 'driver', 'textconv', 'cmd', 'command', 'helper'].join('|');
const FLAGS = ['to-command', 'use-compress-program', 'checkpoint-action', 'rsh', 'rsync-path', 'entrypoint', 'require', 'import', 'loader', 'upload-pack', 'receive-pack', 'exec-path', 'exec'].join('|');
const SHORT_FLAGS = { rsync: /^-\w*e/, node: /^-r/, ruby: /^-r/, tar: /^-\w*I/, scp: /^-S/, sftp: /^-S/ };
// Each of these is asked about ONE word, at its start or at its end: a pattern over all the words of a command would be read again from every one of them.
const NAME = new RegExp(`(?<![\\w.-])(?:${VARIABLES})$`, 'i');
const NAME_AND_VALUE = new RegExp(`(?<![\\w.-])(?:${VARIABLES})\\+?=`, 'i');
const WHOLE_NAME = new RegExp(`^(?:${VARIABLES})$`, 'i');
const WHOLE_NAME_AND_VALUE = new RegExp(`^(?:${VARIABLES})=`, 'i');
const NAME_OF_THE_DRIVE = new RegExp(`(?<![$\\w])env:(?:${VARIABLES})$`, 'i');
const KEY = new RegExp(`(?:(?<![\\w.])|^-[oc])(?:${KEYS})$`, 'i');
const GROUP = new RegExp(`(?:(?<![\\w.])|^-c)(?:${GROUPS})\\.`, 'i');
const KEY_OF_A_GROUP = new RegExp(`\\.(?:${KEYS_OF_A_GROUP})$`, 'i');
const isKey = (part) => KEY.test(part) || (KEY_OF_A_GROUP.test(part) && GROUP.test(part));
const FLAG = new RegExp(`(?<![\\w-])--(?:${FLAGS})$`, 'i');
const FLAG_AND_VALUE = new RegExp(`(?<![\\w-])--(?:${FLAGS})=`, 'i');
const SETS_A_VARIABLE = new RegExp(`^setenvironmentvariable["']?\\s*\\(\\s*["'](?:${VARIABLES})["']\\s*,\\s*(?:["'][^"']*|[^"'\\s][^"']*)?$`, 'i');
const ADD_TYPE_PATH = /^-(?:pa?(?:th?)?|li\w*|lp|pspath)$/i;
const ADD_TYPE_PATH_GLUED = /^-(?:pa?(?:th?)?|li\w*|lp|pspath):/i;
/** Whether the last of the words is the value of a name whose value is run, or read by a shell before anything else. */
function namesAProgram(words) {
  const word = (back) => (words.at(-back) ?? '').replace(/["']/g, '');
  const [last, previous, before] = [word(1), word(2), word(3)];
  if (NAME_AND_VALUE.test(last) || (/^\+?=/.test(last) && NAME.test(previous)) || (/^\+?=$/.test(previous) && NAME.test(before))) return true;
  const parts = last.split(/[=\s]/);
  if (parts.slice(0, -1).some(isKey) || isKey(previous) || FLAG_AND_VALUE.test(last) || FLAG.test(previous)) return true;
  const named = /^-\w+$/.test(previous) ? before : previous; // setx NAME value, Set-Item env:NAME -Value value
  if (NAME_OF_THE_DRIVE.test(named) || (WHOLE_NAME.test(named) && programOf(word(named === previous ? 3 : 4)) === 'setx')) return true;
  for (let index = words.length - 2; index > 0; index -= 1) if (WHOLE_NAME_AND_VALUE.test(words[index]) && programOf(words[index - 1]) === 'set') return true; // cmd: the value goes on to the end
  if ((ADD_TYPE_PATH.test(previous) || ADD_TYPE_PATH_GLUED.test(last)) && words.some((item) => /add-type/i.test(item) && programOf(item) === 'add-type')) return true; // a file of code that is loaded
  const flagged = Object.keys(SHORT_FLAGS).filter((program) => SHORT_FLAGS[program].test(last) || (SHORT_FLAGS[program].test(previous) && SHORT_FLAGS[program].exec(previous)[0] === previous));
  return flagged.length > 0 && words.slice(0, -1).some((item) => flagged.includes(programOf(item)));
}
// NAME=..., $name = "..., $name = [string]"..., $env:name="..., set NAME=..., and Set-Variable name "... (sv, set, New-Variable, nv; with -Name and -Value or without)
const ASSIGNED = /([A-Za-z_]\w*)\s*\+?=\s*(?:\[[\w.]+(?:\[\])?\]\s*)*["']?[^\s"'=;|&<>]*$/;
const SET_VARIABLE = /(?<![\w-])(?:set-variable|sv|set|new-variable|nv)(?:\s|\x60(?=\s))+(?:-n(?:a(?:me?)?)?(?::|(?:\s|\x60(?=\s))+))?["']?([A-Za-z_]\w*)["']?(?:\s|\x60(?=\s))+(?:-va(?:l(?:ue?)?)?(?::|(?:\s|\x60(?=\s))+))?["']?[^\s"'=;|&<>]*$/i; // (a backtick in front of a blank: a line that goes on)
/** Whether text[start, ...) is the value of a variable that names the file of a redirection in the text. */
function namesAFile(text, start) {
  const before = text.slice(Math.max(0, start - 200), start);
  const name = ASSIGNED.exec(before)?.[1] ?? SET_VARIABLE.exec(before)?.[1];
  if (name === undefined) return false;
  if (new RegExp(`[<>]\\|?\\s*[^\\s;|&<>]*[$%!]\\{?(?:env:)?${name}(?!\\w)`, 'i').test(text)) return true;
  for (const found of text.matchAll(new RegExp(`[$%!]\\{?(?:env:)?${name}(?!\\w)`, 'gi'))) if (joinedBefore(text, found.index).some(({ words }) => writesTo([...words.slice(0, -1), words.at(-1) + found[0]]))) return true; // the file of a writer
  return false;
}
// The programs and cmdlets that write to a file that they are given: every word that is no flag (WRITE_TO_EVERY_WORD), or the value of a flag of them (OUTPUT_FLAGS: the flag, glued to it or not).
const WRITE_TO_EVERY_WORD = new Set(['out-file', 'tee', 'tee-object', 'export-csv', 'export-clixml', 'cp', 'mv', 'copy', 'move', 'xcopy', 'copy-item', 'cpi', 'move-item', 'mi']);
const OUTPUT_FLAGS = {
  curl: [/^-[a-zA-Z]*o$|^--output$/, /^-[sSLkfvqiIgGjJlnNpRZ#]*o(?=.)|^--output=/],
  wget: [/^-[a-zA-Z]*O$|^--output-document$/, /^-[qvcNkrxSnp]*O(?=.)|^--output-document=/],
  iwr: [/^-outf(?:i(?:le?)?)?$/i, /^-outf(?:i(?:le?)?)?:/i],
};
OUTPUT_FLAGS['invoke-webrequest'] = OUTPUT_FLAGS.iwr;
OUTPUT_FLAGS.irm = OUTPUT_FLAGS.iwr;
OUTPUT_FLAGS['invoke-restmethod'] = OUTPUT_FLAGS.iwr;
const WRITER = /out-file|tee|export-c|cp|mv|copy|move|mi|curl|wget|iwr|irm|invoke-/i;
// The value of a flag named like a credential (tee out --token X, cp --token X a b) is no file: bash refuses the flag, and to PowerShell and cmd it is one more file, so the command fails. But behind
// -- every word is a file, and the programs that copy to their last file copy a file named --token to X when no file stands before the flag and none behind the value (cp --token X, cp -Force --token X).
const SECRET_FLAG = /^--(?:[a-z0-9]+-)*(?:password|passwd|passphrase|pass|pwd|token|secret|api-?key|access-?key|secret-?key)$/i;
const SECRET_PARAMETER = /^-\w*(?:password|passwd|passphrase|pwd|token|secret|key|credential)\w*:/i; // (-Password:X: no writer has such a parameter)
const COPIES = new Set(['cp', 'mv', 'copy', 'move', 'xcopy', 'copy-item', 'cpi', 'move-item', 'mi']);
// The password of a URL (cp a https://user:X@host/x) is a part of one name inside a folder, wherever the rest of the word puts it (a slash and a backslash are never hidden).
const URL_USER = /\/\/[^\s/:@]+:$/;
const FOLLOWED = /^[^\s;|&<>()]*[ \t]+[\w./\\~:"'+,=@]/; // a word that is no flag follows in the same command (cp --token X a: a copy of three files)
/**
 * Whether the last of the words is the file that a program of them writes to, the program standing where a command is expected. `followed`: a word that is no flag follows it.
 */
function writesTo(words, { followed = false } = {}) {
  const word = (words.at(-1) ?? '').replace(QUOTES, '');
  const previous = (words.at(-2) ?? '').replace(QUOTES, '');
  let opens = null; // where a command is expected, read once for all the words (one reading for each would grow with the cube of a long text)
  for (let index = words.length - 2; index >= 0; index -= 1) {
    if (!WRITER.test(words[index])) continue; // (a quick look before the name)
    const name = programOf(words[index]);
    const flags = OUTPUT_FLAGS[name];
    if (!(WRITE_TO_EVERY_WORD.has(name) || flags)) continue;
    if (opens === null) expects(words.slice(0, -1), (opens = []));
    if (!opens[index]) continue;
    if (URL_USER.test(word)) return false;
    if (flags) return flags[0].test(previous) || flags[1].test(word);
    if (word.startsWith('-')) return /^-\w+:/.test(word) && !SECRET_PARAMETER.test(word);
    const between = words.slice(index + 1, -2);
    if (!SECRET_FLAG.test(previous) || between.some((item) => /^--(?:%|$)/.test(item.replace(QUOTES, '')))) return true;
    const placed = between.some((item, at) => !/^["']?[-/]/.test(item) && !/^["']?-/.test(between[at - 1] ?? '')); // a file that is surely no value of a flag
    return COPIES.has(name) && !followed && !placed;
  }
  return false;
}
const SEPARATES_IN_CMD = /[&|<>()]/;
const HEADER_NAME = /^[\w-]+:$/;

/**
 * The reading of one command: how much of a candidate text[start, end) may be hidden. `original` is the command before any rule touched it (what it says about itself does not change); `whole` is the call that
 * it is a part of, when it is one (a summary that was cut, one argument of several).
 */
export function createCommandReading(original, whole = original) {
  const level = Math.max(whole === original ? 0 : readLevel(original), levelOf(whole));
  const once = (character) => Math.max(original.split(character).length, whole.split(character).length) === 2;
  const lone = { '%': once('%'), '!': once('!') };
  let makes = null; // whether the command makes a command of PowerShell
  let known = { text: null, list: [] };
  const strings = (text) => {
    if (known.text !== text) known = { text, list: quotedStrings(text) };
    return known.list;
  };

  /** The word of wordAt with its stretch going on across the closing bracket of a substitution, which separates nothing ("$(x)" "a=X", x $(y) tee a). */
  function aroundStrings(text, word) {
    const from = acrossSubstitutions(text, word.from, (at) => wordAt(text, at, level > 0).from);
    return from === word.from ? word : { start: word.start, from, words: text.slice(from, word.start).replace(REDIRECTION, ' ').split(BLANKS).filter(Boolean) };
  }
  /** Whether text[start, ...) stands where a shell takes it for something else than an argument, the value of a name or the text of a string. */
  function runs(text, start, quoted, begin, holder) {
    const { start: wordStart, from, words } = aroundStrings(text, wordAt(text, start, level > 0));
    const lead = text.slice(wordStart, start);
    const bare = lead.replace(/\\(?=["'])/g, '').replace(QUOTES, '');
    if (redirects(text, wordStart)) return true;
    if (text[from - 1] === '{' && /[<>]\s*@$/.test(text.slice(Math.max(0, from - 40), from - 1))) {
      // <@{-p "X": to bash and cmd the brace is a part of the file of the redirection, and the command follows it
      const reading = expectsCommand(text, from, wordStart, false);
      if (reading.program(lead)) return true;
    }
    const before = text.slice(from, start);
    if (text[wordStart - 1] === '{' && text[wordStart - 2] === '$') return true; // the value of ${name...}
    if ((bare.includes('%') && !lone['%']) || (bare.includes('!') && !lone['!'])) return true; // a part of %name:a=b%, of !name:a=b!
    if (POWERSHELL_ASSIGNMENT.test(before.slice(-120))) return false;
    if (!quoted && inTable(text, start)) return true; // a value of a hashtable is an expression
    if (!quoted && /^\s*\S+\s*=\s*$/.test(before) && /\s=|=\s/.test(before)) return true; // name = value: an expression of PowerShell, or a command of bash
    const { open, expression, program, first, script, runner, interpreter } = expectsCommand(text, from, wordStart);
    if (!open || (/^--[A-Za-z]/.test(words.at(-1) ?? '') && text.slice(begin, start).includes(words.at(-1)))) return false; // (no word that takes a command has a flag that names a credential)
    if (expression && !quoted && !bare.startsWith('-')) return true;
    // The word is the command, or the script of a shell: it stays readable, unless it is an assignment (or a flag) to every shell that can read it.
    if (/^["']*-/.test(lead)) return (runner && !interpreter && PROGRAM_FLAG.test(bare)) || flagIsAProgram(text, wordStart, strings(text));
    const glued = text[wordStart - 1] ?? '';
    if ((glued === '{' && !(text[wordStart - 2] === '@' && ASSIGNED_TABLE.test(text.slice(Math.max(0, wordStart - 122), wordStart - 2)))) || glued === '}') {
      // To bash a brace is a part of the word; to PowerShell it begins a block, or a hashtable, whose strings are data ($h=@{a="b"} is an assignment of PowerShell, like $h="b").
      const word = wordAt(text, start, level > 0, false);
      const there = expectsCommand(text, word.from, word.start, false);
      const group = wordAt(text, word.from - 1, false, false); // (a parenthesis behind an argument is an error to bash)
      const argument = text[word.from - 1] === '(' && text[word.from - 2] !== '$' && !expectsCommand(text, group.from, group.start, false).open;
      if (!argument && there.program(text.slice(word.start, start)) && !(there.expression && OPERATOR.test(word.words.at(-1) ?? ''))) return true;
    }
    const table = text.lastIndexOf('@{', wordStart);
    const entry = holder !== null && table > text.lastIndexOf('}', wordStart) && !strings(text).some((found) => found.start <= table && table < found.end) && !/[&|]/.test(text.slice(table, wordStart).replace(/"[^"]*"/g, '')); // of a hashtable: data to PowerShell (cmd splits it at & and |)
    const opened = script ? /^["']?/.exec(lead)[0] : ''; // the quote of a script: its first word ends at a blank, or with the script
    const folder = hasAFolder(text.slice(wordStart + opened.length, wordEnd(text, wordStart + opened.length)).split(opened || /$^/)[0]);
    if (glued !== '{' && glued !== '}' && !(entry && !folder && !/path["']?\s*[+]?=/i.test(whole)) && (glued === ')' || program(lead))) return true;
    if (!first || entry) return false;
    makes ??= MAKES_A_COMMAND.test(whole) || MAKES_A_DRIVE.test(whole);
    return makes || folder;
  }
  /**
   * Whether a candidate that is a word of its own (Bearer X, name: X, name = X) can be read as the value of what stands before it, which starts at `begin`. Outside quotes it is an argument like any other
   * (rm -rf token: src), unless the name is the first word of its line (a line of a heredoc, an entry of a hashtable, a whole header).
   */
  function belongsTo(text, begin, start) {
    const head = text.slice(begin, start).replace(/\\?["']$/, '');
    if (/[\n\r;|&()`]/.test(withoutExpansions(text, begin, start))) return false; // the name belongs to another command (mysql -h $(cat host) -pX: to the same one)
    if (!/\s$/.test(head) || /(?:^|\s)-\S*\s+$/.test(head)) return true; // glued to its name, or the value of a flag
    const { start: nameStart, words } = wordAt(text, begin, level > 0);
    const firstOf = (list) => list.every((word) => HEADER_NAME.test(word));
    if (firstOf(words) || POWERSHELL_ASSIGNMENT.test(text.slice(nameStart, start))) return true;
    const string = strings(text).find((found) => found.start <= begin && start <= found.end);
    if (!string) return false;
    let offset = string.start;
    let plainString = string.plain;
    if (level > 0) {
      // A command that names a shell: the string can be a command itself, so it is a string of that string that counts.
      const inner = quotedStrings(text.slice(string.start, string.end)).find((found) => offset + found.start <= begin && start <= offset + found.end);
      plainString = inner !== undefined && inner.plain;
      offset += inner === undefined ? 0 : inner.start;
    }
    // Single quotes are no quotes to cmd: there the value has to be that of a header, or of a key of JSON.
    return plainString || firstOf(text.slice(offset, begin).split(/\s+/).filter(Boolean)) || /^[\w.-]+["']\s*:\s*$/.test(head);
  }

  return {
    level,
    strings,
    /** How many characters of text[start, end) may be hidden, counted from its start; 0 when none (nothing is asked at level 2). `begin` is where what a rule shows in front of it starts. */
    hideable(text, start, end, begin) {
      if (/\$[\w.]*:$/.test(text.slice(Math.max(0, start - 80), start)) || (begin < start && !belongsTo(text, begin, start))) return 0; // ($drive:name)
      const readings = joinedBefore(text, start);
      if (level > 0) readings.push({ words: text.slice(wordAt(text, start, true).from, start).split(BLANKS) }); // (the words of a string that a shell reads)
      const around = { followed: FOLLOWED.test(text.slice(end, end + 200)) };
      if (readings.some(({ words, file }) => file || namesAProgram(words) || writesTo(words, around))) return 0;
      if (statementsBefore(text, start).some((words) => writesTo(words, around)) || inFileOfCmd(text, start)) return 0; // a writer that begins a block or a substitution, a file to cmd
      const set = text.slice(0, start).toLowerCase().lastIndexOf('setenvironmentvariable');
      if ((set !== -1 && SETS_A_VARIABLE.test(text.slice(set, start))) || namesAFile(text, start)) return 0;
      // The string that bash and PowerShell agree on stands where it begins; its characters are those of plain double quotes only when cmd agrees too.
      const holder = level > 0 ? null : strings(text).find((found) => !found.lines && found.start <= start && end <= found.end) ?? null;
      const string = holder?.plain ? holder : null;
      const previous = text[start - 1] ?? ' ';
      if (!(string === null ? BEFORE : BEFORE_IN_QUOTES).test(previous) && !text.startsWith(MARK, start - MARK.length)) return 0;
      // (single quotes are no quotes to cmd: a separator inside them separates)
      const anchor = holder !== null && (holder.plain || !SEPARATES_IN_CMD.test(text.slice(holder.start, start))) ? holder.start : start;
      if (runs(text, anchor, holder !== null || previous === '"' || previous === "'", begin, holder)) return 0;
      return plain(text.slice(start, end), text[end] ?? ' ', string === null ? FIRST : QUOTED, string === null ? NEXT : QUOTED, lone);
    },
  };
}
