// The command line of `chatmcp verify` (docs/PROOF-CLI.md, "Grammar"): the words before `--` are options and the command, the words after
// `--` are the command `run` runs. Nothing here touches a file.
import { COMMANDS, NOT_BUILT, stop } from './codes.mjs';

const GLOBAL = new Set(['--json', '--lang', '--workspace', '--help', '--version']);
/** The options of each command (besides the global ones). */
const OWN = Object.freeze({
  init: ['--print'],
  trust: ['--sha256', '--revoke'],
  snapshot: [],
  run: ['--shell', '--cwd', '--timeout'],
  show: [],
  pack: ['--agent', '--agent-version'],
});
/** The options that take a value; the others are flags. */
const VALUED = new Set(['--lang', '--workspace', '--sha256', '--shell', '--cwd', '--timeout', '--agent', '--agent-version']);
const KNOWN = new Set([...GLOBAL, ...Object.values(OWN).flat()]);

export const LANGS = Object.freeze(['en', 'vi']);
export const SHELLS = Object.freeze(['bash', 'sh', 'powershell', 'pwsh']);
export const MAX_TIMEOUT_SECONDS = 900;
const HEX64 = /^[0-9a-f]{64}$/i;

/** The language asked for, read before anything else so that every later answer is in it; an unreadable --lang answers in English. */
export function languageOf(argv) {
  const head = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  for (let i = 0; i < head.length; i++) {
    const value = head[i] === '--lang' ? head[i + 1] : head[i].startsWith('--lang=') ? head[i].slice('--lang='.length) : undefined;
    if (value !== undefined) return LANGS.includes(value) ? value : 'en';
  }
  return 'en';
}

/**
 * Reads the words of the command line. Returns {command, options, words, json, lang, workspace} where `command` is one of COMMANDS,
 * 'help' or 'version'; throws a CliStop with a usage code for a command line that is wrong. `json` and `lang` are read first, so that the
 * answer to a wrong command line still comes in the shape and the language asked for.
 */
export function parseArgs(argv) {
  const dashes = argv.indexOf('--');
  const head = dashes < 0 ? argv : argv.slice(0, dashes);
  const words = dashes < 0 ? null : argv.slice(dashes + 1);
  const options = {};
  const positional = [];
  const unknown = [];
  for (let i = 0; i < head.length; i++) {
    const token = head[i];
    if (token === '-h') { options['--help'] = true; continue; }
    if (!token.startsWith('-') || token === '-') { positional.push(token); continue; }
    const equals = token.indexOf('=');
    const name = token.startsWith('--') && equals > 0 ? token.slice(0, equals) : token;
    if (!KNOWN.has(name)) { unknown.push(name); continue; }
    if (Object.hasOwn(options, name)) throw stop('repeated_option', { option: name });
    if (!VALUED.has(name)) {
      if (equals > 0) throw stop('bad_value', { option: name, value: token.slice(equals + 1), expected: 'no value (a flag)' });
      options[name] = true;
    } else if (equals > 0) options[name] = token.slice(equals + 1);
    else {
      // the next word is the value unless it is another option: a value that starts with -- is written --name=value
      if (i + 1 >= head.length || head[i + 1].startsWith('--')) throw stop('missing_value', { option: name });
      options[name] = head[i += 1];
    }
  }
  const json = options['--json'] === true;
  if (options['--lang'] !== undefined && !LANGS.includes(options['--lang'])) throw stop('bad_value', { option: '--lang', value: options['--lang'], expected: LANGS.join(' or ') });
  const lang = options['--lang'] ?? 'en';
  const base = { json, lang, workspace: options['--workspace'] ?? null };
  if (base.workspace === '') throw stop('bad_value', { option: '--workspace', value: '', expected: 'a folder' });
  if (options['--version']) return { ...base, command: 'version', topic: null, options: {}, words: null };
  if (!positional.length) {
    if (options['--help']) return { ...base, command: 'help', topic: null, options: {}, words: null };
    throw stop('no_command');
  }
  if (positional[0] !== 'verify') throw stop('unknown_command', { command: positional[0] });
  const command = positional[1];
  if (command === undefined) {
    if (options['--help']) return { ...base, command: 'help', topic: null, options: {}, words: null };
    throw stop('no_command');
  }
  if (!COMMANDS.includes(command)) throw stop('unknown_command', { command });
  if (options['--help']) return { ...base, command: 'help', topic: command, options: {}, words: null };
  // a command a later task builds takes whatever follows it: its grammar is not fixed yet
  if (Object.hasOwn(NOT_BUILT, command)) return { ...base, command, topic: null, options: {}, words };
  const own = new Set(OWN[command]);
  if (unknown.length) throw stop('unknown_option', { option: unknown[0], command });
  const foreign = Object.keys(options).find((name) => !GLOBAL.has(name) && !own.has(name));
  if (foreign) throw stop('unknown_option', { option: foreign, command });
  if (positional.length > 2) throw stop('unexpected_argument', { argument: positional[2] });
  if (command !== 'run' && words !== null) throw stop('unexpected_argument', { argument: '--' });
  const read = {};
  if (command === 'init') read.print = options['--print'] === true;
  if (command === 'trust') {
    read.revoke = options['--revoke'] === true;
    const digest = options['--sha256'];
    if (digest !== undefined && !HEX64.test(digest)) throw stop('bad_value', { option: '--sha256', value: digest, expected: '64 hex digits' });
    read.sha256 = digest === undefined ? null : digest.toLowerCase();
  }
  if (command === 'run') {
    const shell = options['--shell'];
    if (shell !== undefined && !SHELLS.includes(shell)) throw stop('bad_value', { option: '--shell', value: shell, expected: SHELLS.join(', ') });
    const timeout = options['--timeout'];
    if (timeout !== undefined && (!/^[0-9]{1,6}$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > MAX_TIMEOUT_SECONDS)) {
      throw stop('bad_value', { option: '--timeout', value: timeout, expected: `whole seconds from 1 to ${MAX_TIMEOUT_SECONDS}` });
    }
    if (words === null || !words.length) throw stop('missing_command_text');
    Object.assign(read, { shell: shell === 'pwsh' ? 'powershell' : (shell ?? null), cwd: options['--cwd'] ?? '', timeoutSeconds: timeout === undefined ? null : Number(timeout) });
  }
  if (command === 'pack') {
    for (const [option, key] of [['--agent', 'agent'], ['--agent-version', 'agentVersion']]) {
      const value = options[option];
      if (value !== undefined && (!value.trim() || value.length > 200)) throw stop('bad_value', { option, value, expected: '1 to 200 characters' });
      read[key] = value ?? 'unknown';
    }
  }
  return { ...base, command, topic: null, options: read, words };
}

// ------------------------------------------------------------------------------------------------------------- the words after --
// One word is the command text as it is: the person's shell has already removed its own quoting, and `run -- "npm test"` must record
// exactly `npm test`. Several words are joined with one space, each word quoted for the shell that will run it when it holds anything but
// the characters that need no quoting there. A word Windows PowerShell 5.1 would change on its way to a program is refused (each one
// measured): it drops an empty word and the word `--%` (its stop-parsing token, quoted or not), does not escape a double quote inside a
// word, and wraps a word that holds white space in double quotes without doubling the backslashes before the closing one, so such a word
// that ends with a backslash swallows the words after it.
const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const POWERSHELL_SAFE = /^[A-Za-z0-9_+=:./\\-]+$/;
// PowerShell reads these four as single quotes too (U+2018, U+2019, U+201A, U+201B); inside a quoted word each is doubled
const POWERSHELL_QUOTES = /['‘’‚‛]/g;

const quotePosix = (word) => (POSIX_SAFE.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);
function quotePowerShell(word) {
  if (word === '') throw stop('unsafe_argument', { argument: word, shell: 'powershell', why: 'empty' });
  if (word.includes('"')) throw stop('unsafe_argument', { argument: word, shell: 'powershell', why: 'double_quote' });
  if (word === '--%') throw stop('unsafe_argument', { argument: word, shell: 'powershell', why: 'stop_parsing' });
  if (/\s/u.test(word) && word.endsWith('\\')) throw stop('unsafe_argument', { argument: word, shell: 'powershell', why: 'trailing_backslash' });
  return POWERSHELL_SAFE.test(word) ? word : `'${word.replace(POWERSHELL_QUOTES, (quote) => quote + quote)}'`;
}

/** The command text `run` hands to `shell` (bash, sh or powershell) for the words after `--`. */
export function joinCommand(words, shell) {
  if (!Array.isArray(words) || !words.length || (words.length === 1 && !words[0].trim())) throw stop('missing_command_text');
  if (words.length === 1) return words[0];
  const quote = shell === 'powershell' ? quotePowerShell : quotePosix;
  return words.map(quote).join(' ');
}
