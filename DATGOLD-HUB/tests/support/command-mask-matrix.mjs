// Every construct that the reading of a command models, in three roles (strings only: nothing is executed):
//   - as a HOLDER: the construct holds, where a shell runs a word, a program that a variable of the command names, in the form in which that shell
//     really runs the value (bash: ./$t; PowerShell: & ./$t, . ./$t, & "$t", start $t; cmd: %t%). The value has to stay readable.
//   - as a FRONT: the construct stands in front of an ordinary credential. What maskSecrets hides (the masking of a text, which knows nothing of
//     shells) the card hides too, unless the row is a price that APPROVAL-PREVIEW.md names: PRICES lists those, and the list is exact. The same holds for a credential inside the
//     statement of a writer (WRITERS), whose every other word can be the file that it writes to.
//   - as the place of a WRITER: the construct holds a writer (cp a ./W, tee ./W, Out-File ./W, copy a .\W) where a shell runs it. The file stays readable.
// A construct is [name, template, shells]: S in the template is the place of the word; shells says where it is a statement there
// ('sh' bash, 'ps' PowerShell, 'cmd'), '' where it is none (a string), and the holder rows are made for those shells only.
const TICK = String.fromCharCode(96);
export const CONSTRUCTS = [
  // blocks behind a program, a keyword, else, finally, function f
  ['a block behind a program', 'x { S }', ''], ['a block of ForEach-Object', '1 | % { S }', 'ps'], ['a block glued to %', '1 | %{S}', 'ps'], ['a block of if', 'if (1) { S }', 'ps'], ['a block of else', 'if (1) {} else { S }', 'ps'],
  ['a block of try', 'try { S } finally {}', 'ps'], ['a block of finally', 'try {} finally { S }', 'ps'], ['a block of a function', 'function f { S }; f', 'ps'], ['a block of while', 'while (1) { S; break }', 'ps'],
  ['a block of switch', 'switch (1) { default { S } }', 'ps'], ['a block of Measure-Command', 'Measure-Command { S }', 'ps'], ['a block of process', 'begin { } process { S }', 'ps'],
  ['a block on the next line', `Measure-Command ${TICK}\n{ S }`, 'ps'], ['a block that is called', '& { S }', 'ps'], ['a block that is sourced', '. { S }', 'ps'], ['a group of bash', '{ S; }', 'sh'], ['a function of bash', 'f() { S; }; f', 'sh'],
  ['a loop of bash', 'for i in 1; do S; done', 'sh'], ['an if of bash', 'if true; then S; fi', 'sh'],
  // hashtables
  ['a hashtable', '@{a=S}', ''], ['a hashtable glued to its variable', '$h=@{a="S"}', ''], ['an entry behind another', '@{a=1; b="S"}', ''], ['an empty hashtable', '@{}; S', 'sh ps'],
  // assignments, glued and with blanks
  ['an assignment of PowerShell', '$y="S"', ''], ['an assignment of PowerShell with blanks', '$y = "S"', ''], ['an assignment of bash', 'y="S"', ''], ['a cast', '[string]$y="S"', ''], ['a list', '$p,$q="S","c"', ''],
  // ( ), $( ), @( )
  ['a group', '(S)', 'sh ps'], ['a substitution', 'echo $(S)', 'sh ps'], ['an array', '@(S)', 'ps'], ['a substitution in double quotes', 'echo "$(S)"', 'sh ps'],
  ['a substitution in a here-string', '$q = @"\n$(S)\n"@', 'ps'],
  // strings and here-strings
  ['a double-quoted string', 'echo "S"', ''], ['a single-quoted string', "echo 'S'", ''], ['a here-string', 'echo @"\nS\n"@', ''], ['a literal here-string', "echo @'\nS\n'@", ''],
  // call operators, runners, pipes, line continuations
  ['a call operator', 'S', 'ps'], ['nohup', 'nohup S', 'sh'], ['sudo', 'sudo S', 'sh'], ['timeout', 'timeout 5 S', 'sh'], ['start', 'start S', 'ps'], ['docker exec', 'docker exec web S', 'sh'],
  ['env', 'env S', 'sh'], ['time', 'time S', 'sh'], ['strace', 'strace S', 'sh'], ['a pipe in front', 'x | S', 'sh ps'], ['a pipe behind', 'S | sort', 'sh ps'], ['and', 'x && S', 'sh ps'], ['or', 'x || S', 'sh ps'],
  ['a line that goes on in PowerShell', `x ${TICK}\n  ; S`, 'ps'], ['a line that goes on in bash', 'x \\\n  ; S', 'sh'],
  // cmd: its loops and its variables
  ['a loop of cmd', 'for %i in (a) do S', 'cmd'], ['an if of cmd', 'if 1==1 S', 'cmd'], ['a sequence of cmd', 'set a=b&S', 'cmd'],
  // redirections and writers
  ['a redirection', 'S > out.txt', 'sh ps'], ['a redirection of errors', 'S 2>&1', 'sh ps'], ['Out-File', 'S | Out-File o.txt', 'ps'], ['tee', 'S | tee o.txt', 'sh'], ['cp', 'cp a b; S', 'sh ps'], ['curl -o', 'curl -o o https://h.test; S', 'sh ps'],
  ['Add-Type', 'Add-Type -Path a.dll; S', 'ps'],
];
// A substitution where a command is expected: its output can be empty, and then the next word is the command. Holders and writers only: such a command is one that a shell reads, where no
// pattern hides anything (the levels of APPROVAL-PREVIEW.md), so a front behind it says nothing about the places.
export const SUBSTITUTED = [['behind a substitution', '$(y) S', 'sh'], ['behind a runner and a substitution', 'sudo $(y) S', 'sh'], ['behind backticks', `${TICK}y${TICK} S`, 'sh'],
  ['behind a substitution of two words', '$(cat a.txt) S', 'sh'], ['behind a flag and a substitution', 'sudo -u $(y) S', 'sh']];
const SET = { sh: (t) => `t=${t}; `, ps: (t) => `$t="${t}"; `, cmd: (t) => `set t=${t}&` };
const RUN = { sh: ['./$t', '"./$t"', '$t'], ps: ['& ./$t', '& "./$t"', '. ./$t', '& $t'], cmd: ['%t%', '.\\%t%', 'call %t%'] };
const RUNNER = { sh: '', ps: '', cmd: '' };
/** [label, command, needle]: a program named by a variable that the command sets, where a shell runs it. */
export function holderRows(value) {
  const rows = [];
  for (const [name, template, shells] of [...CONSTRUCTS, ...SUBSTITUTED]) for (const shell of shells.split(' ').filter(Boolean)) for (const run of RUN[shell]) {
    if (/^(?:start|nohup|sudo|timeout|docker|env|time|strace) /.test(template) && /^[&.] /.test(run)) continue; // (a runner takes a program, not a call operator)
    const word = /^(?:start S)$/.test(template) ? run.replace(/^& /, '') : run;
    rows.push([`a holder, ${name}, ${shell}: ${word}`, SET[shell](value) + RUNNER[shell] + template.replace('S', word), value]);
  }
  return rows;
}
const WRITE = { sh: ['cp a ./W', 'tool | tee ./W'], ps: ['cp a ./W', 'Copy-Item a -Destination ./W', 'tool | Out-File ./W'], cmd: ['copy a .\\W'] };
/** [label, command, needle]: the file of a writer inside a construct, where a shell runs the writer. */
export function writerRows(value) {
  const rows = [];
  for (const [name, template, shells] of [...CONSTRUCTS, ...SUBSTITUTED]) for (const shell of shells.split(' ').filter(Boolean)) for (const write of WRITE[shell]) {
    rows.push([`a writer, ${name}, ${shell}: ${write}`, template.replace('S', write.replace('W', value)), value]);
  }
  return rows;
}
const CREDENTIALS = ['tool --token=G', 'API_KEY=G node a.js', 'curl -H "Authorization: Bearer G" https://h.test', 'mysql -u root -pG', 'tool --password G'];
const JOINERS = ['; ', '\n'];
// {} is the place of the credential inside the statement of a writer
const WRITERS = [['tee', 'tool | tee out {}'], ['tee, the credential first', 'tool | tee {} out'], ['Tee-Object', 'tool | Tee-Object out {}'], ['Out-File', 'tool | Out-File o.txt {}'], ['cp', 'cp a b {}'],
  ['cp, the credential first', 'cp {} a b'], ['mv', 'mv {} a b'], ['copy', 'copy {} a b'], ['xcopy', 'xcopy {} a b'], ['Copy-Item', 'Copy-Item a -Destination {}'], ['Move-Item', 'Move-Item a b {}']];
const INSIDE = ['--token G', '--password G', '--api-key "G"', '--token=G', 'https://u:G@h.test', '-Password:G'];
// {} is the place of the credential behind a substitution that is an argument of an ordinary program: bash runs the substitution, and the words behind it are arguments still
const ARGUMENTS = [['a substitution', 'x $(y) {}'], ['a substitution of two words', 'x $(cat a.txt) {}'], ['two substitutions', 'x $(y) $(z) {}'], ['a substitution behind a flag', 'x -h $(y) {}'],
  ['a substitution in a substitution', 'x $(y $(z)) {}'], ['a substitution in double quotes', 'x "$(y)" {}'], ['backticks', `x ${TICK}y${TICK} {}`], ['backticks of two words', `x ${TICK}cat a.txt${TICK} {}`],
  ['mysql', 'mysql -h $(cat host) -u root {}'], ['mysql behind backticks', `mysql -h ${TICK}cat host${TICK} -u root {}`], ['curl', `curl ${TICK}cat url${TICK} {}`], ['psql', 'psql $(cat dsn) {}']];
const BEHIND = ['--token=G', '--password G', '"api_key=G"', "'api_key=G'", '"password=G"', '"Authorization: Bearer G"', '-H "Authorization: Bearer G"', '"Authorization:Bearer G"', '-u user:G', 'https://u:G@h.test', '-pG'];
/** [label, command, credential]: an ordinary credential behind a construct, inside the statement of a writer, or behind a substitution that is an argument. */
export function frontRows(value) {
  const rows = [];
  for (const [name, template] of CONSTRUCTS) for (const joiner of JOINERS) for (const credential of CREDENTIALS) {
    rows.push([`a front, ${name}, ${JSON.stringify(joiner)}: ${credential}`, template.replace('S', 'x') + joiner + credential.replace('G', value), value]);
  }
  for (const [name, template] of WRITERS) for (const inside of INSIDE) rows.push([`a front inside a writer, ${name}: ${inside}`, template.replace('{}', inside.replace('G', value)), value]);
  for (const [name, template] of ARGUMENTS) for (const behind of BEHIND) rows.push([`a front behind an argument, ${name}: ${behind}`, template.replace('{}', behind.replace('G', value)), value]);
  return rows;
}
/**
 * The fronts that the card shows and maskSecrets hides, each with the reason that APPROVAL-PREVIEW.md gives (the key is the label of the row).
 * A row that is shown and not here, or one that is here and hidden, fails the suite.
 */
export const PRICES = {};
