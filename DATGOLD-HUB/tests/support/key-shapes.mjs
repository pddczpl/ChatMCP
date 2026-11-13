// The ways in which a private key is written in code, in scripts and in configuration, shared by the suites that must hide it: the approval card, the answer of edit_file and the masker.
//
// The fourth audit of PR #103 (head 9fb53744) found that the card showed the WHOLE body of a real key in 23 of these 31 shapes: a row between two frames was hidden only when it was ONE token of
// base64 once a short list of quotes and commas was taken off it, so any other decoration (`-- ` in front of it, `echo "..." >> key` around it, b"...\n", a PowerShell backtick-n between the lines
// of a one-line key) made the whole row show. A list of decorations can never be complete, so what is hidden now is every run of 16 characters or more of base64 in a body, wherever it stands.
//
// Every shape holds the SAME key: four lines of 64 characters of base64 and a last line of 12. KEY_PIECES are 20 characters out of each long line; a piece in a text is a line of the key that
// shows. (The last line is short on purpose: a decorated last line shorter than 16 characters still shows, and the docs say so.)
export const BEGIN = '-----BEGIN PRIVATE KEY-----';
export const END = '-----END PRIVATE KEY-----';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let seed = 0x1d872b41;
const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 26; }; // the top six bits of the generator: 0..63
export const LONG_LINES = Array.from({ length: 4 }, () => Array.from({ length: 64 }, () => ALPHABET[next()]).join(''));
// a + and a / inside the pieces, so that the alphabet of the runs is tried with both
LONG_LINES[1] = `${LONG_LINES[1].slice(0, 12)}+${LONG_LINES[1].slice(13, 20)}/${LONG_LINES[1].slice(21)}`;
export const LAST_LINE = 't2R23QrNfeo=';
export const KEY_BODY = [...LONG_LINES, LAST_LINE];
export const KEY_PIECES = LONG_LINES.map((line) => line.slice(8, 28));

/** The pieces of the key that a text shows. */
export const piecesIn = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return KEY_PIECES.filter((piece) => text.includes(piece));
};

const body = KEY_BODY;
const lines = (fn) => body.map(fn);
const joined = (parts) => `${parts.join('\n')}\n`;

/** [name, content, kind]: kind is 'block' (the key is over several lines) or 'one-line' (the key is in one line, its line breaks spelled in some way). */
export function keyShapes() {
  return [
    // the shapes that the card hid already
    ['control: plain PEM block', joined([BEGIN, ...body, END]), 'block'],
    ['control: PEM, CRLF', `${[BEGIN, ...body, END].join('\r\n')}\r\n`, 'block'],
    ['control: YAML block, indented', joined(['key: |', `  ${BEGIN}`, ...lines((l) => `  ${l}`), `  ${END}`]), 'block'],
    ['control: JSON one line, \\n escapes', `{"private_key":"${BEGIN}\\n${body.join('\\n')}\\n${END}\\n"}\n`, 'one-line'],
    ['control: JS array of quoted lines with commas', joined(['const k = [', `  "${BEGIN}",`, ...lines((l) => `  "${l}",`), `  "${END}",`, '].join("\\n");']), 'block'],
    ['control: Java strings with +', joined([`String k = "${BEGIN}\\n" +`, ...lines((l) => `  "${l}\\n" +`), `  "${END}\\n";`]), 'block'],
    // decorations of the lines of a body that real code uses
    ['multi-line: SQL/Lua comment "-- " prefix', joined([`-- ${BEGIN}`, ...lines((l) => `-- ${l}`), `-- ${END}`]), 'block'],
    ['multi-line: batch "REM " prefix', joined([`REM ${BEGIN}`, ...lines((l) => `REM ${l}`), `REM ${END}`]), 'block'],
    ['multi-line: batch ":: " prefix', joined([`:: ${BEGIN}`, ...lines((l) => `:: ${l}`), `:: ${END}`]), 'block'],
    ['multi-line: markdown table "| x |"', joined([`| ${BEGIN} |`, ...lines((l) => `| ${l} |`), `| ${END} |`]), 'block'],
    ['multi-line: Python bytes b"...\\n"', joined(['KEY = (', `    b"${BEGIN}\\n"`, ...lines((l) => `    b"${l}\\n"`), `    b"${END}\\n"`, ')']), 'block'],
    ['multi-line: Python f/r-string r"..."', joined(['KEY = (', `    r"${BEGIN}\\n"`, ...lines((l) => `    r"${l}\\n"`), `    r"${END}\\n"`, ')']), 'block'],
    ['multi-line: PHP concatenation with a dot', joined([`$key = "${BEGIN}\\n" .`, ...lines((l) => `  "${l}\\n" .`), `  "${END}\\n";`]), 'block'],
    ['multi-line: VB "..." & _', joined([`key = "${BEGIN}" & vbLf & _`, ...lines((l) => `  "${l}" & vbLf & _`), `  "${END}"`]), 'block'],
    ['multi-line: Lua "..." ..', joined([`local key = "${BEGIN}\\n" ..`, ...lines((l) => `  "${l}\\n" ..`), `  "${END}\\n"`]), 'block'],
    ['multi-line: trailing comment after the line', joined([BEGIN, ...lines((l) => `${l}  # tmp`), END]), 'block'],
    ['multi-line: ini "key.N = " words', joined([`key.0 = ${BEGIN}`, ...lines((l, i) => `key.${i + 1} = ${l}`), `key.9 = ${END}`]), 'block'],
    ['multi-line: echo per line (Dockerfile / CI script)', joined([`echo "${BEGIN}" > /root/key`, ...lines((l) => `echo "${l}" >> /root/key`), `echo "${END}" >> /root/key`]), 'block'],
    ['multi-line: printf per line', joined([`printf '%s\\n' '${BEGIN}' > key`, ...lines((l) => `printf '%s\\n' '${l}' >> key`), `printf '%s\\n' '${END}' >> key`]), 'block'],
    ['multi-line: PowerShell Add-Content per line', joined([`Set-Content key "${BEGIN}"`, ...lines((l) => `Add-Content key "${l}"`), `Add-Content key "${END}"`]), 'block'],
    ['multi-line: Dockerfile RUN echo ... && \\', joined([`RUN echo "${BEGIN}" > /k && \\`, ...lines((l) => `    echo "${l}" >> /k && \\`), `    echo "${END}" >> /k`]), 'block'],
    ['multi-line: XML element per line', joined([`<k>${BEGIN}</k>`, ...lines((l) => `<l>${l}</l>`), `<k>${END}</k>`]), 'block'],
    ['multi-line: C# verbatim @"..." block', joined([`var k = @"${BEGIN}`, ...body, `${END}";`]), 'block'],
    // one-line keys with another spelling of the line ending
    ['one-line: PowerShell backtick-n', `$k = "${BEGIN}\`n${body.join('`n')}\`n${END}"\n`, 'one-line'],
    ['one-line: double-escaped \\\\n (JSON inside JSON)', `{"a":"{\\"private_key\\":\\"${BEGIN}\\\\n${body.join('\\\\n')}\\\\n${END}\\\\n\\"}"}\n`, 'one-line'],
    ['one-line: percent-encoded %0A', `KEY=${BEGIN}%0A${body.join('%0A')}%0A${END}\n`, 'one-line'],
    ['one-line: \\x0a hex escapes', `k = "${BEGIN}\\x0a${body.join('\\x0a')}\\x0a${END}"\n`, 'one-line'],
    ['one-line: XML entities &#10;', `<key>${BEGIN}&#10;${body.join('&#10;')}&#10;${END}</key>\n`, 'one-line'],
    ['one-line: \\r\\n escapes', `{"k":"${BEGIN}\\r\\n${body.join('\\r\\n')}\\r\\n${END}"}\n`, 'one-line'],
    ['one-line: implicit concatenation "..." "..."', `k = ("${BEGIN}\\n" "${body.join('\\n" "')}\\n" "${END}")\n`, 'one-line'],
    ['one-line: Python bytes b"..." b"..."', `k = (b"${BEGIN}\\n" b"${body.join('\\n" b"')}\\n" b"${END}")\n`, 'one-line'],
  ].map(([name, content, kind]) => ({ name, content, kind }));
}

/**
 * The edges of a RUN of base64 (16 characters or more of A-Z a-z 0-9 + / _ -, and up to two = after it): [label, a middle line of a body, what it becomes]. Every line has other tokens around
 * the run, so the rule of a whole line (one short token) does not decide it and only the run does.
 */
const chars = (length, char = 'a') => char.repeat(length);
export const RUN_EDGES = [
  ['15 characters are no run', `x ${chars(15)} y`, `x ${chars(15)} y`],
  ['16 are', `x ${chars(16)} y`, 'x [REDACTED] y'],
  ['17 are', `x ${chars(17)} y`, 'x [REDACTED] y'],
  ['capitals', `x ${chars(16, 'Q')} y`, 'x [REDACTED] y'],
  ['digits', `x ${chars(16, '7')} y`, 'x [REDACTED] y'],
  ['plus signs', `x ${chars(16, '+')} y`, 'x [REDACTED] y'],
  ['slashes', `x ${chars(16, '/')} y`, 'x [REDACTED] y'],
  ['underscores', `x ${chars(16, '_')} y`, 'x [REDACTED] y'],
  ['hyphens', `x ${chars(16, '-')} y`, 'x [REDACTED] y'],
  ['all of them in one run', `x ${'Aa0+/_-b'.repeat(2)} y`, 'x [REDACTED] y'],
  ['a dot is no character of a run: 8 and 8', `x ${chars(8)}.${chars(8)} y`, `x ${chars(8)}.${chars(8)} y`],
  ['nor is a colon', `x ${chars(8)}:${chars(8)} y`, `x ${chars(8)}:${chars(8)} y`],
  ['one = after a run goes with it', `x ${chars(16)}= y`, 'x [REDACTED] y'],
  ['two do', `x ${chars(16)}== y`, 'x [REDACTED] y'],
  ['the third does not', `x ${chars(16)}=== y`, 'x [REDACTED]= y'],
  ['an = in front of a run stays', `x =${chars(16)} y`, 'x =[REDACTED] y'],
  ['two runs in a line are both hidden', `x ${chars(16)} ${chars(16, 'b')} y`, 'x [REDACTED] [REDACTED] y'],
  ['a run between quotes and a comma', `x "${chars(16)}", y`, 'x "[REDACTED]", y'],
];

/** Single-token lines that a model can put behind a fake BEGIN frame: they may be hidden (the known edge: a lone token looks like the last line of a key), but then the card has to count them. */
export const HIDEABLE_WORDS = ['Stop-Computer', 'Restart-Computer', '/sbin/reboot', 'SHUTDOWN', '/usr/local/bin/launch_the_missiles', 'deploy_everything_to_production', './install_backdoor_script', 'Clear-RecycleBin'];
