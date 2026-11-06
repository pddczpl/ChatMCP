// Shell commands as the approval card meets them inside a string of another language, shared by the suites that must keep their secret off the card: the permission gate (the prompt of a tool
// call is the JSON of its arguments) and the masker.
//
// In the JSON text of a tool call a double quote is written \", a line break \n, a carriage return \r and a tab \t, and none of that is decoded by a rule that reads the text. The shapes are those of
// the auditor's probes of round 5 of PR #103 (r5-json-quoted-credentials, r5-two-level-probe, r5-json-newline): a credential in double quotes, a container word behind a ; & | inside a double-quoted
// string and then the flag of the user, and curl after a line break or a tab. Each is [label, command, the password that must not show]. The commands are the decoded text, as the model wrote them.
export const SECRET = 'Zq424242aB';
export const NUMBER_PASSWORD = '7391824'; // the password of a numeric pair: 5551234567:7391824
const CI = 'https://ci.example.com/api';

export const JSON_TEXT_SHAPES = [
  // a credential in double quotes (the quotes are \" in the JSON text)
  ['--user in double quotes', `curl --user "admin:${SECRET}" https://x.test`, SECRET],
  ['-u in double quotes', `curl -u "admin:${SECRET}" https://x.test`, SECRET],
  ['--password in double quotes', `tool --password "${SECRET}" run`, SECRET],
  ['--token=, value in double quotes', `tool --token="${SECRET}" run`, SECRET],
  ['mysql -p"..."', `mysql -u root -p"${SECRET}" db`, SECRET],
  ['sshpass -p "..."', `sshpass -p "${SECRET}" ssh host`, SECRET],
  ['export API_KEY="..."', `export API_KEY="${SECRET}"`, SECRET],
  ['password = "..."', `password = "${SECRET}"`, SECRET],
  // a container word behind a ; & | inside a double-quoted string, then the flag
  ['data in double quotes, then ; docker', `curl -d "cmd=ls; docker ps" -u admin:${SECRET} ${CI}`, SECRET],
  ['header in double quotes, then | sudo docker', `curl -H "X-Run: a | sudo docker run img" --user admin:${SECRET} ${CI}`, SECRET],
  ['data in double quotes, then && docker', `curl --data "cmd=ls && docker run img" -u admin:${SECRET} ${CI}`, SECRET],
  ['URL in double quotes with an &', `curl "https://ci.example.com/api?x=1&docker=run" -u admin:${SECRET}`, SECRET],
  ['a numeric pair after double-quoted data', `curl -d "cmd=ls; docker ps" -u 5551234567:${NUMBER_PASSWORD} ${CI}`, NUMBER_PASSWORD],
  ['a JSON body in double quotes over lines, then docker', `curl -d "{\n  \\"a\\": 1,\ndocker ps\n}" -u admin:${SECRET} ${CI}`, SECRET],
  // curl after a line break or a tab (\n, \r, \t are escapes in the JSON text: a letter in front of curl)
  ['a numeric pair after a \\n and curl', `cd /app\ncurl -u 5551234567:${NUMBER_PASSWORD} https://x.test`, NUMBER_PASSWORD],
  ['a numeric pair after a \\t and curl', `run:\tcurl -u 5551234567:${NUMBER_PASSWORD} https://x.test`, NUMBER_PASSWORD],
  ['a numeric pair after a \\r\\n and curl', `cd /app\r\ncurl -u 5551234567:${NUMBER_PASSWORD} https://x.test`, NUMBER_PASSWORD],
  ['the URL after the flag, curl after a \\n', `export A=1\ncurl --user 5551234567:${NUMBER_PASSWORD} \\\n  https://x.test/api`, NUMBER_PASSWORD],
  ['curl.exe after a \\n', `cd C:\\work\ncurl.exe -u 5551234567:${NUMBER_PASSWORD} https://x.test`, NUMBER_PASSWORD],
];
