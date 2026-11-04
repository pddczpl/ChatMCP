// maskSecrets (lib/permissions.mjs) is what keeps a secret out of the approval card, the pending list, the history and the hook messages. The card of a file change (P8 ux-7) now shows lines of
// real files, so the spellings of a secret that code and configuration really use have to be covered, and the lines of code that only talk about secrets have to stay readable.
//
//  1. every spelling in the first table is masked: the secret is gone and the rest of the line is still there
//  2. every line in the second table is left exactly as it is (an identifier that holds the word "token" is not a secret)
//  3. the lines that the audit of PR #103 listed: 49 spellings of a secret that all have to be masked, 47 lines of code that all have to stay as they are; the exemptions that keep the
//     47 readable (a type, a read of the environment, a placeholder, a fetch option) are narrow: a value that only looks like one is still masked
//  4. the time it takes does not depend on how the text is laid out
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
  ['curl -u on a line of its own', `  -u admin:${V} \\`, '  -u admin:[REDACTED] \\'],
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
  ['a -p within 200 characters of docker login', `docker login${' x'.repeat(75)} -p ${V} registry.example.test`, `docker login${' x'.repeat(75)} -p [REDACTED] registry.example.test`],
  ['a -p beyond 200 characters of docker login (the limit)', `docker login${' x'.repeat(150)} -p ${V} registry.example.test`, `docker login${' x'.repeat(150)} -p ${V} registry.example.test`],
  ['an empty value in quotes', 'tool --password "" run', 'tool --password "" run'],
  ['a long option that holds the letters -p', 'mysql --protocol=tcp -u root', 'mysql --protocol=tcp -u root'],
  ['another one in the middle of a word', 'mysqldump --set-gtid-purged=OFF mydb', 'mysqldump --set-gtid-purged=OFF mydb'],
  ['an option of docker login that ends in -p', 'docker login --dry-p value registry.example.test', 'docker login --dry-p value registry.example.test'],
  ['a -u glued to a word is no flag', 'foo-u bar:bazqux', 'foo-u bar:bazqux'],
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
];
for (const [label, line, expected] of COMMAND_LINES) assert.equal(maskSecrets(line, []), expected, `${label}: not the line that was expected`);
ok(`${COMMAND_LINES.length} lines on the edges of the flags and the tags (their limits, glued words, reads, short values, several in a line)`);

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
  // a PGP private key is armoured with "PRIVATE KEY BLOCK" in its frame; a public one is not a secret either
  const pgp = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQdGBF2xYZkBEADl3Kx9mP0qTz7RvW2nB8cD4eF6gH1jK3lM5nP7qR9sT1uV3wX5\n=ab12\n-----END PGP PRIVATE KEY BLOCK-----\nafter`;
  assert.equal(maskSecrets(pgp), '-----BEGIN PGP PRIVATE KEY BLOCK-----\n[REDACTED]\n-----END PGP PRIVATE KEY BLOCK-----\nafter', 'a PGP private key block is masked like any private key');
  const pgpPublic = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nmQENBF2xYZkBCADl3Kx9mP0qTz7RvW2nB8cD4eF6gH1jK3lM5nP7qR9sT1uV3wX5\n-----END PGP PUBLIC KEY BLOCK-----';
  assert.equal(maskSecrets(pgpPublic), pgpPublic, 'a PGP public key block is not');
  // a key that begins and ends in one line (the line breaks of a service-account key are \n escapes) is masked inside its line: the line is still one line
  const inline = `x -----BEGIN RSA PRIVATE KEY-----\\nZm9vYmFyYmF6cXV4\\nZm9vYmFyYmF6cXV4\\n-----END RSA PRIVATE KEY----- y`;
  assert.equal(maskSecrets(inline), 'x -----BEGIN RSA PRIVATE KEY-----[REDACTED]-----END RSA PRIVATE KEY----- y', 'a key in one line is masked in that line: the number of lines does not change');
  assert.equal(maskSecrets(maskSecrets(inline)), maskSecrets(inline), 'and masking it again changes nothing');
  assert.equal(maskSecrets('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'), '-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----', 'a block over several lines keeps its frame on lines of their own');
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

console.log(`PASS: ${checks} mask checks`);
