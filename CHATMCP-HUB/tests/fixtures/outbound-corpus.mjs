// Corpora for the outbound secret scanner (tests/verify-outbound-redaction.mjs and the runner tests).
//
// Every positive is assembled at run time from a prefix and a generated body, never written out as one literal: the
// repository must not contain strings that a secret scanner (GitHub push protection included) would take for a leaked
// credential. The bodies come from a seeded generator, so a failure reproduces.

let seed = 0x5eed1234;
const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGIT = '0123456789';
const HEX = '0123456789abcdef';
const B62 = UPPER + LOWER + DIGIT;
const B64URL = `${B62}-_`;
const B64 = `${B62}+/`;
const BECH32 = 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L';

/** `length` characters of `alphabet`; `mixed` forces at least one digit and one upper-case letter (a body that cannot be a word). */
export function body(alphabet, length, { mixed = false } = {}) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[next() % alphabet.length];
  if (mixed && alphabet.includes('A') && alphabet.includes('0')) out = `${UPPER[next() % 26]}${DIGIT[next() % 10]}${out.slice(2)}`;
  return out;
}
const password = () => `${body(B62, 8, { mixed: true })}!${body(DIGIT, 2)}`;

/** @returns {{label: string, text: string, secret: string}[]} secret = the substring that must not survive; label = the rule expected to fire */
export function positives() {
  const list = [];
  const add = (label, secret, wrap = (value) => value) => list.push({ label, secret, text: wrap(secret) });
  const addFramed = (label, secret, text) => list.push({ label, secret, text });

  // private keys (full block, one-line JSON escape, cut off before the END line)
  for (const kind of ['RSA PRIVATE KEY', 'PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
    const lines = [body(B64, 64), body(B64, 64), body(B64, 40)];
    addFramed('private-key', lines[1], `-----BEGIN ${kind}-----\n${lines.join('\n')}\n-----END ${kind}-----`);
  }
  { const lines = [body(B64, 64), body(B64, 64)]; addFramed('private-key', lines[0], `{"private_key":"-----BEGIN PRIVATE KEY-----\\n${lines.join('\\n')}\\n-----END PRIVATE KEY-----\\n"}`); }
  { const lines = [body(B64, 64), body(B64, 64)]; addFramed('private-key', lines[1], `ssh key follows:\n-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n`); } // cut by a read limit

  for (let i = 0; i < 3; i++) {
    const frames = [(v) => v, (v) => `export ANTHROPIC_API_KEY=${v}`, (v) => `{"key": "${v}"}`];
    add('anthropic-key', `sk-ant-api03-${body(B64URL, 90)}AA`, frames[i]);
  }
  add('openrouter-key', `sk-or-v1-${body(HEX, 64)}`);
  add('openai-key', `sk-proj-${body(B64URL, 64)}`, (v) => `OPENAI_API_KEY=${v}`);
  add('openai-key', `sk-${body(B62, 48)}`, (v) => `Authorization header uses ${v} here`);
  add('openai-key', `sk-${body(B62, 20)}T3BlbkFJ${body(B62, 20)}`);
  add('openai-key', `sk-svcacct-${body(B64URL, 70)}`, (v) => `"apiKey": "${v}"`);

  add('github-fine-grained-pat', `github_pat_${body(B62, 11)}_${body(B62, 59)}`, (v) => `git clone https://${v}@github.com/o/r.git`);
  for (const kind of ['ghp', 'gho', 'ghs', 'ghu', 'ghr']) add('github-token', `${kind}_${body(B62, 36)}`, (v) => `GITHUB_TOKEN: ${v}`);
  add('gitlab-token', `glpat-${body(B64URL, 20)}`);
  add('gitlab-token', `glrt-${body(B64URL, 24)}`, (v) => `runner token ${v}`);

  add('aws-access-key-id', `AKIA${body(UPPER + DIGIT, 16)}`, (v) => `aws_access_key_id = ${v}`);
  add('aws-access-key-id', `ASIA${body(UPPER + DIGIT, 16)}`, (v) => `"AccessKeyId": "${v}"`);
  add('aws-secret-access-key', body(B64, 40), (v) => `aws_secret_access_key = ${v}`);
  add('aws-secret-access-key', body(B64, 40), (v) => `"SecretAccessKey": "${v}"`);
  add('aws-secret-access-key', body(B64, 120), (v) => `"SessionToken": "${v}"`);

  add('google-api-key', `AIza${body(B64URL, 35)}`, (v) => `https://maps.example/api?key=${v}&q=1`);
  add('google-oauth', `GOCSPX-${body(B64URL, 28)}`);
  add('google-oauth', `ya29.${body(B64URL, 70)}`, (v) => `access_token ${v}`);
  add('google-oauth', `1//0${body(B64URL, 60)}`, (v) => `"refresh_token": "${v}"`);

  add('slack-token', `xoxb-${body(DIGIT, 12)}-${body(DIGIT, 13)}-${body(B62, 24)}`);
  add('slack-token', `xoxp-${body(DIGIT, 12)}-${body(DIGIT, 12)}-${body(DIGIT, 12)}-${body(HEX, 32)}`, (v) => `SLACK_TOKEN=${v}`);
  add('slack-token', `xapp-1-A${body(UPPER + DIGIT, 10)}-${body(DIGIT, 13)}-${body(HEX, 40)}`);
  add('slack-webhook', `https://hooks.slack.com/services/T${body(UPPER + DIGIT, 8)}/B${body(UPPER + DIGIT, 10)}/${body(B62, 24)}`, (v) => `curl -X POST ${v}`);
  add('discord-webhook', `https://discord.com/api/webhooks/${body(DIGIT, 18)}/${body(B64URL, 68)}`);

  add('stripe-key', `sk_live_${body(B62, 24)}`, (v) => `stripe.api_key = "${v}"`);
  add('stripe-key', `sk_test_${body(B62, 24)}`);
  add('stripe-key', `rk_live_${body(B62, 24)}`);
  add('stripe-key', `whsec_${body(B62, 32)}`);
  add('twilio-key', `SK${body(HEX, 32)}`, (v) => `TWILIO_API_KEY_SID ${v}`);
  add('sendgrid-key', `SG.${body(B64URL, 22)}.${body(B64URL, 43)}`);
  add('mailgun-key', `key-${body(HEX, 32)}`, (v) => `api:${v}`);
  add('npm-token', `npm_${body(B62, 36)}`, (v) => `//registry.npmjs.org/:_authToken=${v}`);
  add('pypi-token', `pypi-AgEIcHlwaS5vcmcCJ${body(B64URL, 70)}`);
  add('huggingface-token', `hf_${body(B62, 34)}`, (v) => `HF_TOKEN=${v}`);
  add('digitalocean-token', `dop_v1_${body(HEX, 64)}`);
  add('shopify-token', `shpat_${body(HEX, 32)}`);
  add('docker-pat', `dckr_pat_${body(B64URL, 27)}`);
  add('vault-token', `hvs.${body(B64URL, 90)}`, (v) => `VAULT_TOKEN: ${v}`);
  add('databricks-token', `dapi${body(HEX, 32)}`);
  add('postman-key', `PMAK-${body(HEX, 24)}-${body(HEX, 34)}`);
  add('linear-key', `lin_api_${body(B62, 40)}`);
  add('grafana-token', `glsa_${body(B62, 32)}_${body(HEX, 8)}`);
  add('atlassian-token', `ATATT3xFfGF0${body(B64URL, 100)}`);
  add('terraform-token', `${body(B62, 14)}.atlasv1.${body(B64URL, 70)}`);
  add('doppler-token', `dp.pt.${body(B62, 44)}`);
  add('age-secret-key', `AGE-SECRET-KEY-1${body(BECH32, 58)}`);
  add('telegram-bot-token', `${body(DIGIT, 10)}:AA${body(B64URL, 33)}`, (v) => `bot token ${v}`);
  add('discord-bot-token', `M${body(B62, 23, { mixed: true })}.${body(B64URL, 6)}.${body(B64URL, 30)}`);

  const jwtHead = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
  const jwtBody = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkphbmUifQ';
  add('jwt', `${jwtHead}.${jwtBody}.${body(B64URL, 43)}`);
  add('jwt', `${jwtHead}.${jwtBody}.${body(B64URL, 43)}`, (v) => `{"access_token":"${v}","token_type":"bearer"}`);
  add('jwt', `${jwtHead}.${jwtBody}.`, (v) => `unsigned: ${v}`);
  add('bearer-token', body(B62, 40), (v) => `Authorization: Bearer ${v}`);
  add('bearer-token', body(B64URL, 36), (v) => `curl -H "Authorization: Bearer ${v}" https://api.example/v1`);
  add('bearer-token', body(HEX, 40), (v) => `bearer ${v}`);
  add('cookie-header', `sid=${body(B62, 32)}`, (v) => `Cookie: ${v}; theme=dark`);
  add('cookie-header', `__Secure-session=${body(B62, 40)}`, (v) => `Set-Cookie: ${v}; HttpOnly; Secure`);
  add('auth-header', body(B64, 22), (v) => `Authorization: Basic ${v}==`);
  add('auth-header', body(B62, 32), (v) => `X-API-Key: ${v}`);
  add('auth-header', body(B62, 32), (v) => `"Authorization": "Token ${v}"`);

  add('url-credentials', password(), (v) => `postgres://app:${v}@db.internal:5432/app`);
  add('url-credentials', password(), (v) => `mongodb+srv://admin:${v}@cluster0.example.net/test`);
  add('url-credentials', password(), (v) => `git clone https://deploy:${v}@git.example.com/team/repo.git`);
  add('url-credentials', password(), (v) => `REDIS_URL=redis://:${v}@cache:6379/0`);
  add('azure-storage-key', `${body(B64, 86)}==`, (v) => `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${v};EndpointSuffix=core.windows.net`);
  add('azure-storage-key', body(B62, 43), (v) => `https://acct.blob.core.windows.net/c/b?sv=2022-11-02&ss=b&sig=${v}%3D`);
  add('connection-password', password(), (v) => `Server=db1;Database=app;User Id=sa;Password=${v};TrustServerCertificate=true`);
  add('connection-password', password(), (v) => `jdbc:mysql://db/app?user=root&password=${v}`);
  add('sql-password', password(), (v) => `CREATE USER bob WITH PASSWORD '${v}';`);
  add('sql-password', password(), (v) => `GRANT ALL ON app.* TO 'bob'@'%' IDENTIFIED BY '${v}';`);
  add('npmrc-auth', body(B62, 36), (v) => `//registry.example.com/:_authToken=${v}`);
  add('netrc-password', password(), (v) => `machine api.example.com login deploy password ${v}`);
  add('kube-key-data', body(B64, 120), (v) => `users:\n- name: admin\n  user:\n    client-key-data: ${v}`);
  add('powershell-secure-string', password(), (v) => `$p = ConvertTo-SecureString "${v}" -AsPlainText -Force`);
  add('cli-secret-flag', password(), (v) => `mysql -h db --password=${v} app`);
  add('cli-secret-flag', body(B62, 30), (v) => `deploy --token ${v} --env prod`);
  add('cli-secret-flag', password(), (v) => `curl -u admin:${v} https://api.example/status`);
  add('cli-secret-flag', password(), (v) => `sshpass -p ${v} ssh ops@host`);

  add('env-secret', password(), (v) => `DATABASE_PASSWORD=${v}`);
  add('env-secret', body(HEX, 64), (v) => `export SECRET_KEY_BASE=${v}`);
  add('env-secret', body(B62, 30), (v) => `API_TOKEN="${v}"`);
  add('env-secret', 'letmeinplease', (v) => `ADMIN_PASSWORD=${v}`);
  add('env-secret', password(), (v) => `# .env\nPORT=3000\nSTRIPE_WEBHOOK_SECRET=${v}\r\nNODE_ENV=production\r\n`);
  add('env-secret', password(), (v) => `+DB_PASS=${v}`);
  // a passphrase with spaces in an upper-case NAME=value line
  add('env-secret', 'correct horse battery staple 9', (v) => `DB_PASSWORD="${v}"`);
  add('env-secret', 'two word secret', (v) => `ADMIN_PASSWORD=${v}`);
  add('env-secret', 'abc def ghi', (v) => `export API_TOKEN='${v}'`);
  add('assigned-secret', password(), (v) => `{"password": "${v}", "user": "admin"}`);
  add('assigned-secret', body(B62, 32), (v) => `const config = { apiKey: '${v}', retries: 3 };`);
  add('assigned-secret', 'hunter2hunter2', (v) => `db.connect(host="db", user="root", password="${v}")`);
  add('assigned-secret', body(HEX, 40), (v) => `client_secret = "${v}"`);
  add('assigned-secret', password(), (v) => `{\\"password\\": \\"${v}\\"}`);
  add('yaml-secret', `${body(B62, 10, { mixed: true })}9`, (v) => `database:\n  host: db\n  password: ${v}\n`);
  add('yaml-secret', body(B62, 32), (v) => `  - api_key: ${v}`);

  // other places the same material turns up: shells, other languages, query strings, kubeconfigs
  add('aws-secret-access-key', body(B64, 40), (v) => `os.environ["AWS_SECRET_ACCESS_KEY"] = "${v}"`);
  add('assigned-secret', password(), (v) => `$config = array('db' => 'app', 'password' => "${v}");`);
  add('assigned-secret', password(), (v) => `password := "${v}"`);
  add('assigned-secret', `django-insecure-${body(B62, 40)}`, (v) => `SECRET_KEY = '${v}'`);
  add('assigned-secret', body(B64, 24, { mixed: true }), (v) => `{"auths":{"registry.example.com":{"auth": "${v}"}}}`);
  add('env-secret', body(B62, 32), (v) => `process.env.API_KEY = "${v}"`);
  add('env-secret', body(B62, 32), (v) => `$env:API_TOKEN = "${v}"`);
  add('setx-secret', password(), (v) => `setx DB_PASSWORD ${v}`);
  add('env-secret', password(), (v) => `PGPASSWORD=${v} psql -h db app`.replace(/ psql.*$/, ''));
  add('query-secret', body(B62, 32), (v) => `https://app.example.com/cb?access_token=${v}&state=1`);
  add('cli-secret-flag', password(), (v) => `docker login -u bob -p ${v} registry.example.com`);
  add('cli-secret-flag', password(), (v) => `mysql -u root -p${v} app`);
  add('cli-secret-flag', password(), (v) => `redis-cli -a ${v} ping`);
  add('cli-secret-flag', password(), (v) => `wget --http-password=${v} https://files.example.com/a.zip`);
  add('yaml-secret', body(B64, 24, { mixed: true }), (v) => `apiVersion: v1\nkind: Secret\ndata:\n  password: ${v}==\n`);
  return list;
}

/** Strings that look like secrets to a careless scanner and are not. */
export function benign() {
  const list = [
    // source code that mentions secrets without containing one
    // labels and prose with spaces next to a secret-sounding name stay readable
    'PASSWORD_LABEL="Enter your password"',
    'TOKEN_HELP="Paste your access token here"',
    'SECRET_HINT=where I keep the key',
    'password: "Enter your password"',
    'password = "The password must have 12 characters"',
    'const token = await getToken();',
    'const apiKey = process.env.OPENAI_API_KEY;',
    'const apiKey = process.env.OPENAI_API_KEY ?? "";',
    "api_key = os.environ['API_KEY']",
    'password = input("Password: ")',
    'password: string;',
    'password?: string',
    'readonly token: string;',
    'token: SecretString;',
    'password: PasswordHash;',
    'private apiKey: string | undefined;',
    'export function hashPassword(password: string): Promise<string> {',
    'if (!password) throw new Error("password is required");',
    'const isValid = await bcrypt.compare(password, user.passwordHash);',
    'expect(response.body.token).toBeDefined();',
    'assert.equal(user.password, undefined);',
    'headers: { Authorization: `Bearer ${token}` },',
    "headers['Authorization'] = 'Bearer ' + accessToken;",
    'Authorization: Bearer ${ACCESS_TOKEN}',
    'curl -H "Authorization: Bearer $TOKEN" https://api.example.com/v1/items',
    'curl -H "Authorization: Bearer <your-token>" https://api.example.com',
    'const [password, setPassword] = useState("");',
    '<input type="password" name="password" autoComplete="current-password" />',
    '<label htmlFor="password">Password</label>',
    '@Column({ select: false }) passwordHash: string;',
    'user.password = await hash(user.password, 10);',
    'const secret = crypto.randomBytes(32).toString("hex");',
    'fn read_token(path: &Path) -> io::Result<String> {',
    'func (c *Client) SetToken(token string) { c.token = token }',
    'def get_password(self) -> str:',
    'self.api_key = config.get("api_key")',
    'token = tokens[index]',
    'access_token = response.json()["access_token"]',
    'secret_name = "prod/database"',
    'const SECRET_NAME = "prod-db-credentials";',
    'const TOKEN_URL = "https://auth.example.com/oauth/token";',
    'PASSWORD_MIN_LENGTH = 12',
    'MAX_TOKENS = 4096',
    'const maxTokens = 4096;',
    'const PRIMARY_KEY = "id";',
    'cacheKey: `user:${id}`,',
    'sort_key = "created_at"',
    'public_key = "-----BEGIN PUBLIC KEY-----"',
    // configuration
    'PORT=3000',
    'NODE_ENV=production',
    'LOG_LEVEL=debug',
    'DATABASE_URL=postgres://localhost:5432/app',
    'REDIS_URL=redis://localhost:6379',
    'MONGO_URL=mongodb://localhost:27017/test',
    'API_BASE_URL=https://api.example.com',
    'DB_PASSWORD=${DB_PASSWORD}',
    'API_KEY=<your-api-key>',
    'API_KEY=changeme',
    'SECRET_KEY=your-secret-key-here',
    'OPENAI_API_KEY=',
    'AUTH_MODE=basic',
    'PWD=/home/dev/project',
    'password: ${DB_PASSWORD}',
    'token: ${{ secrets.GITHUB_TOKEN }}',
    'secretName: db-credentials',
    'password: string',
    '  token_type: Bearer',
    '"token_type": "Bearer"',
    '"max_tokens": 4096',
    '"tokens": 1234,',
    '"auth": "oauth"',
    '"password": "string"',
    '"password": "Enter your password"',
    '"secret": "${SECRET}"',
    '"apiKey": "<YOUR_API_KEY>"',
    '"api_key": "your-api-key-here"',
    '{"name":"demo","version":"1.0.0","private":true}',
    '[credentials]',
    'auth = basic',
    'keyring = true',
    'CREATE TABLE users (id integer primary key, password_hash text not null);',
    'ALTER TABLE users ADD COLUMN reset_token text;',
    // addresses
    'https://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'https://user@example.com/path',
    'postgres://localhost/db',
    'http://localhost:3000/api/tokens',
    'https://example.com/docs#authentication',
    'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
    'C:\\Users\\dev\\project\\src\\app.ts',
    '/etc/ssl/certs/ca-certificates.crt',
    '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUZm9vYmFyYmF6cXV4\n-----END CERTIFICATE-----',
    '-----BEGIN PUBLIC KEY-----\nMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAL\n-----END PUBLIC KEY-----',
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 dev@laptop',
    // prose
    'Bearer authentication-based approaches are common in REST APIs.',
    'The password field is required and must contain at least 12 characters.',
    'Reset your password by clicking the link in the email.',
    'This token expires in one hour, so refresh it before then.',
    'Use an API key from the dashboard to call the service.',
    'The Authorization header is required for every request.',
    'Secret sharing schemes split a key between several parties.',
    'Install scikit-learn with pip install scikit-learn.',
    'import sklearn.ensemble as ensemble  # sk-learn style',
    'class names such as task-queue-management-service-adapter are fine',
    'Cookie: banner dismissed',
    'Set the Cookie header on the outgoing request.',
    'See docs/authentication.md for the OAuth flow.',
    'Run npm install and then npm test.',
    'TypeError: Cannot read properties of undefined (reading "token")',
    '    at Object.<anonymous> (/app/src/auth.js:42:17)',
    '2026-10-19T10:00:00Z INFO request id=7f9c2d4e user=42 path=/login status=200',
    '| Header | Description |\n|---|---|\n| Authorization | Bearer token |',
    'sudo apt-get install -y build-essential',
    'git commit -m "fix: rotate the signing token on logout"',
    'git log --oneline -5',
    'docker run --rm -p 8080:80 nginx:1.27',
    'kubectl get secret db-credentials -o yaml',
    'terraform apply -var-file=prod.tfvars',
    'export PATH="$HOME/bin:$PATH"',
    'set NODE_OPTIONS=--max-old-space-size=4096',
    'very-long-kebab-case-component-name-for-the-design-system-library',
    'sk-this-is-a-css-class-with-many-parts-in-the-selector',
    'desk-lamp-configuration-1234567890-abcdefghijklmnopqrstuv',
    'task-1234567890abcdefghijklmnopqrstuvwxyz0123',
    'xoxo hugs and kisses',
    'AKIA is the prefix AWS uses for access key ids',
    'ghp_ is the prefix of a GitHub personal access token',
    'eyJ is how base64 starts for a JSON object',
    'The hf_ prefix belongs to Hugging Face tokens.',
    'Use --token-file instead of --token on shared machines.',
    'mysql --help | grep -i password',
    'ls -la ~/project',
    'curl -X POST https://api.example.com/login -d @credentials-template.json',
    'echo "enter the password when prompted"',
    'Enter password:',
    'Password must not be empty',
    // found by running the scanner over this repository's own files: code and prose that only look like a credential
    "method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',",
    "fetch(url, { credentials: 'same-origin', headers });",
    'if (opts.headers.Authorization === `Bearer ${key}` && url.includes(":generateContent")) return fixture(200);',
    "if (headers.Authorization==='Bearer '+token) return true;",
    'Gemini calls the generateContent path with `x-goog-api-key`; OpenAI-compatible calls /v1/chat/completions with `Authorization: Bearer`. A custom gateway may differ.',
    'The request carries Authorization: Basic followed by the base64 of user:password (RFC 7617).',
    'if (TOKEN == expected) { grant(); }',
    'while (password==input) retry();',
    'docker login -u bob --password-stdin registry.example.com',
    'curl --token-file ./token.txt https://api.example.com',
    'mysql -u root -p app',
    'https://app.example.com/callback?state=abc123&code=xyz&redirect=home',
    'https://app.example.com/feed?token=true&page=2',
    'https://maps.example.com/embed?key=public-demo&q=hanoi',
    'redis-cli -h cache ping',
    'setx PATH "%PATH%;C:\\tools"',
    '$env:NODE_ENV = "production"',
    'data:\n  password: ${DB_PASSWORD}',
    'wget --http-user=bob https://files.example.com/a.zip',
    // numbers and identifiers
    '0x7f9c2d4e5a6b7c8d',
    'build 20261019.1',
    'v3.9.0-rc.1+build.5',
    'lat=10.7769,lng=106.7009',
    'SELECT id, name FROM customers WHERE created_at > now() - interval \'7 days\';',
    '<div className="rounded-lg border border-[var(--line)] p-3">Settings</div>',
    'const re = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)$/;',
    'return Buffer.from(value, "base64").toString("utf8");',
  ];
  // Hashes, ids and integrity strings: high entropy, never secret.
  for (let i = 0; i < 12; i++) list.push(`commit ${body(HEX, 40)}`);
  for (let i = 0; i < 10; i++) list.push(`id: ${body(HEX, 8)}-${body(HEX, 4)}-4${body(HEX, 3)}-a${body(HEX, 3)}-${body(HEX, 12)}`);
  for (let i = 0; i < 8; i++) list.push(`"integrity": "sha512-${body(B64, 86)}=="`);
  for (let i = 0; i < 6; i++) list.push(`sha256:${body(HEX, 64)}`);
  for (let i = 0; i < 6; i++) list.push(`"resolved": "https://registry.npmjs.org/pkg/-/pkg-1.0.${i}.tgz#${body(HEX, 40)}"`);
  for (let i = 0; i < 4; i++) list.push(`<img src="data:image/png;base64,${body(B64, 120)}==" alt="logo">`);
  for (let i = 0; i < 4; i++) list.push(`checksum md5 ${body(HEX, 32)}`);
  for (let i = 0; i < 4; i++) list.push(`etag: W/"${body(HEX, 32)}"`);
  for (let i = 0; i < 4; i++) list.push(`font-face src: url(data:font/woff2;base64,${body(B64, 100)})`);
  for (let i = 0; i < 4; i++) list.push(`const nonce = "${body(B62, 24)}"; // csp nonce for inline script ${i}`);
  for (let i = 0; i < 4; i++) list.push(`{ "id": "${body(B62, 21)}", "type": "document", "revision": ${i} }`);
  for (let i = 0; i < 4; i++) list.push(`tmp file ${body(B62, 16)}.tmp written in ${i + 1}ms`);
  for (let i = 0; i < 4; i++) list.push(`import ${body(LOWER, 8)} from "./${body(LOWER, 6)}-${body(LOWER, 6)}.js";`);
  for (let i = 0; i < 4; i++) list.push(`workspace=${body(LOWER, 6)} generation=${i + 1} instance=${body(HEX, 16)}`);
  for (let i = 0; i < 4; i++) list.push(`color: #${body(HEX, 6)}; background: #${body(HEX, 6)};`);
  for (let i = 0; i < 4; i++) list.push(`Merge ${body(HEX, 7)} into ${body(HEX, 7)}`);
  for (let i = 0; i < 4; i++) list.push(`browser.sessionStorage key chatmcp.${body(LOWER, 8)} ${i}`);
  return list;
}
