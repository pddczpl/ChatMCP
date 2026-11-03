// maskSecrets (lib/permissions.mjs) is what keeps a secret out of the approval card, the pending list, the history and the hook messages. The card of a file change (P8 ux-7) now shows lines of
// real files, so the spellings of a secret that code and configuration really use have to be covered, and the lines of code that only talk about secrets have to stay readable.
//
//  1. every spelling in the first table is masked: the secret is gone and the rest of the line is still there
//  2. every line in the second table is left exactly as it is (an identifier that holds the word "token" is not a secret)
//  3. the time it takes does not depend on how the text is laid out
import assert from 'node:assert/strict';
import { maskSecrets } from '../lib/permissions.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the mask suite exceeded its own time budget'); process.exit(2); }, 60_000).unref();

// A secret in this file is built at run time, never written as a literal.
const R = 'Ab12Cd34Ef56';
const TOKEN = `ghp_${'Zx9Yw8Vu7T'.repeat(4)}`;
const STRIPE = ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_'); // built at run time: a literal of this shape is a hit of GitHub push protection
const SECRET = (what) => `${what}${R}${R}`;
const PEM_BODY = 'MIIEpAIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM9OiXx';

// [label, line, the secret that must be gone, what must still be there]
const MASKED = [
  ['openai key', `const k = "sk-${R.repeat(3)}";`, `sk-${R.repeat(3)}`, 'const k ='],
  ['openai project key in an env line', `OPENAI_API_KEY=sk-proj-${R.repeat(4)}`, `sk-proj-${R.repeat(4)}`, 'OPENAI_API_KEY='],
  ['anthropic key', `ANTHROPIC_API_KEY="sk-ant-api03-${R.repeat(4)}"`, `sk-ant-api03-${R.repeat(4)}`, 'ANTHROPIC_API_KEY='],
  ['github token', `token: ${TOKEN}`, TOKEN, 'token:'],
  ['github fine-grained token', `github_pat_${R.repeat(3)}${R}`, `github_pat_${R.repeat(3)}${R}`, ''],
  ['aws access key id', 'aws_access_key_id = AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP', 'aws_access_key_id ='],
  ['aws secret access key', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'aws_secret_access_key ='],
  ['password with quotes', 'password = "Hunter2-Hunter2-Only"', 'Hunter2-Hunter2-Only', 'password ='],
  ['password in yaml', 'password: Hunter2Only9', 'Hunter2Only9', 'password:'],
  ['password with spaces in quotes', "password: 'correct horse battery staple'", 'battery staple', 'password:'],
  ['json password', '{"password": "Hunter2-Only-9"}', 'Hunter2-Only-9', '{"password":'],
  ['json token', '{"access_token":"abcdef0123456789abcdef","x":1}', 'abcdef0123456789abcdef', '"x":1}'],
  ['json private key', '"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQ..."', 'MIIEvQ', '"private_key":'],
  ['env password with a prefix', 'DB_PASSWORD=Sup3rS3cretValue', 'Sup3rS3cretValue', 'DB_PASSWORD='],
  ['camel case secret', "const clientSecret = 'abcd1234efgh5678';", 'abcd1234efgh5678', 'const clientSecret ='],
  ['snake case secret', 'client_secret = abcd1234efgh5678', 'abcd1234efgh5678', 'client_secret ='],
  ['secret key attribute', 'app.config["SECRET_KEY"] = "dev-key-9f8e7d6c5b4a"', 'dev-key-9f8e7d6c5b4a', 'app.config["SECRET_KEY"]'],
  ['api key header', 'x-api-key: 0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef', 'x-api-key:'],
  ['bearer', 'Authorization: Bearer abcdefghijklmnop1234567890', 'abcdefghijklmnop1234567890', 'Authorization: Bearer'],
  ['basic authorization', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA==', 'Authorization:'],
  ['authorization in a header object', "headers: { 'Authorization': 'Token 0123456789abcdef' }", '0123456789abcdef', 'headers:'],
  ['url with a password', 'postgres://admin:Sup3rS3cret@db.example.com/app', 'Sup3rS3cret', 'postgres://admin:'],
  ['token in a query string', 'https://x.test/cb?token=abcdef0123456789&x=1', 'abcdef0123456789', '&x=1'],
  ['slack token', 'xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij', ''],
  ['google key', `AIza${'B'.repeat(35)}`, `AIza${'B'.repeat(35)}`, ''],
  ['stripe live key', STRIPE, STRIPE, ''],
  ['npm token', `npm_${R.repeat(3)}`, `npm_${R.repeat(3)}`, ''],
  ['gitlab token', `glpat-${R.repeat(2)}`, `glpat-${R.repeat(2)}`, ''],
  ['hugging face token', `hf_${R.repeat(3)}`, `hf_${R.repeat(3)}`, ''],
  ['sendgrid key', `SG.${R.repeat(2)}.${R.repeat(2)}`, `SG.${R.repeat(2)}.${R.repeat(2)}`, ''],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0', ''],
  ['key material body', PEM_BODY, PEM_BODY, ''],
  ['the registered secret', 'value = registered-secret-value-4711', 'registered-secret-value-4711', 'value ='],
];

// lines of code and prose that talk about secrets and are not one: they must come back as they went in
const BENIGN = [
  'if (password.length < 8) {',
  "const passwordInput = document.getElementById('pw');",
  'tokenizer = Tokenizer.from_pretrained(name)',
  '"max_tokens": 1000000,',
  'max_tokens: 4096',
  'const tokenCount = tokens.length;',
  'const SECRET_KEYS = /authorization|secret|password|token|api.?key|private.?key/i;',
  'export const TOKEN_PATTERNS = [',
  'password: z.string().min(8),',
  'token = getToken()',
  'function resetPassword(email) {',
  '// the token is read from the environment',
  'const secretary = new Secretary();',
  'password: ${DB_PASSWORD}',
  'token: ${{ secrets.GITHUB_TOKEN }}',
  'api_key: <your key here>',
  'const keyboard = 12345678;',
  'Authorization is checked before the handler runs.',
  'for (const token of tokens) {',
  'password_field = forms.CharField(widget=forms.PasswordInput)',
];

for (const [label, line, secret, kept] of MASKED) {
  const masked = maskSecrets(line, ['registered-secret-value-4711']);
  assert.ok(!masked.includes(secret), `${label}: the secret is still there: ${masked}`);
  assert.ok(masked.includes('[REDACTED]'), `${label}: nothing says it was masked: ${masked}`);
  if (kept) assert.ok(masked.includes(kept), `${label}: the rest of the line was lost: ${masked}`);
}
ok(`${MASKED.length} spellings of a secret: the secret is gone, the words around it stay`);

for (const line of BENIGN) assert.equal(maskSecrets(line, ['registered-secret-value-4711']), line, `a line that holds no secret was changed: ${line}`);
ok(`${BENIGN.length} lines of code and prose that only mention secrets come back unchanged`);

// the pins that were there before
assert.equal(maskSecrets('password=hunter2hunter2 keep this', []), 'password=[REDACTED] keep this');
assert.equal(maskSecrets('postgres://user:s3cretpass@db/app'), 'postgres://user:[REDACTED]@db/app');
assert.equal(maskSecrets('plain text with no secret'), 'plain text with no secret');
assert.equal(maskSecrets('Authorization: Bearer abcdefghijklmnop1234'), 'Authorization: Bearer [REDACTED]', 'the bearer rule and the authorization rule do not mask twice');
assert.equal(maskSecrets('a secret value is registered', ['value is']), 'a secret [REDACTED] registered');
assert.equal(maskSecrets(42), '42');
ok('what was pinned before is unchanged');

// several lines at once, as a head of a file or a pair of strings of an edit
{
  const block = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\nZm9vYmFyYmF6cXV4\n-----END RSA PRIVATE KEY-----\nafter`;
  const masked = maskSecrets(block);
  assert.ok(!masked.includes(PEM_BODY) && !masked.includes('Zm9vYmFyYmF6cXV4'), 'the body of a private key is masked, every line of it');
  assert.match(masked, /^-----BEGIN RSA PRIVATE KEY-----\n\[REDACTED\]\n-----END RSA PRIVATE KEY-----\nafter$/, 'the frame of the block and the text after it stay');
  assert.equal(maskSecrets('-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----'), '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----', 'a public key is not a secret');
  const file = `line one\npassword = "${SECRET('a')}"\nline three\ntoken: ${TOKEN}\n`;
  const out = maskSecrets(file);
  assert.equal(out.split('\n').length, file.split('\n').length, 'the lines of a text are still its lines');
  assert.ok(!out.includes(SECRET('a')) && !out.includes(TOKEN));
  ok('a private key block over several lines, a public key left alone, the number of lines of a text unchanged');
}

// the time does not depend on the layout of the text
{
  const layouts = {
    'one long identifier': `${'a'.repeat(9000)}`,
    'a long run of identifier characters before a secret word': `${'a_b.c$d-'.repeat(1000)}password`,
    'many assignments': 'token = x\n'.repeat(900),
    'many quotes': "password: '".repeat(900),
    'many equals signs': '='.repeat(9000),
    'a long value': `password=${'x'.repeat(9000)}`,
    'many key words': 'secret '.repeat(1200),
    'a long jwt-like run': `eyJ${'a'.repeat(4000)}.${'b'.repeat(4000)}`,
    'many dots': 'a.'.repeat(4500),
  };
  for (const [label, text] of Object.entries(layouts)) {
    const started = performance.now();
    maskSecrets(text, ['registered-secret-value-4711']);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 400, `${label}: ${elapsed.toFixed(0)} ms for ${text.length} characters`);
  }
  ok('nine awkward layouts of 9000 characters are masked in under 400 ms each');
}

console.log(`PASS: ${checks} mask checks`);
