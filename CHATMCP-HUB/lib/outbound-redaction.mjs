// Outbound privacy filter for the ChatGPT Web Companion path.
//
// Everything the Hub hands to the user's chatgpt.com tab (the first message, a continuation, a tool result, a result page,
// the handoff text, and what poll() returns to the extension) can be filtered here. Two parts, both pure:
//
//   * redactText / redactDeep - replace text that has the SHAPE of a credential with [REDACTED:<label>].
//   * withholdProtected       - never pass on what a tool read from a protected file (.env*, *.pem, *.key, id_rsa*, and
//                               everything lib/protected-paths.mjs already protects); a short notice is sent instead.
//
// BEST EFFORT, NOT A GUARANTEE. This is a pattern list. It finds the well-known credential formats listed below and
// assignments such as `API_TOKEN=...` or `"password": "..."`. It does not find a secret that has no recognisable shape
// (a random 32-character string in prose, a password in a sentence, a secret split over two lines), it does not read
// images or other binary data, and it cannot know what is confidential for a client. Use "review before send" when that
// matters. A match is replaced as a whole, so the placeholder says what kind of thing was removed and nothing else.
//
// A raw match is never returned, logged or stored: callers receive labels and counts only.
import { isProtectedPath, mayExpandToProtected } from './protected-paths.mjs';

export const redactionMark = (label) => `[REDACTED:${label}]`;

// ----------------------------------------------------------------------------------------------------------------------
// Values that are obviously not a credential
// ----------------------------------------------------------------------------------------------------------------------
// A word that documents what belongs there (`password: string`, `token=<your-token>`, `API_KEY=changeme`).
const PLACEHOLDER = new RegExp('^(?:'
  + '\\[REDACTED[^\\]]*\\]|<[^>]*>|\\$\\{[^}]*\\}|\\$\\([^)]*\\)|\\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|\\{\\{[^}]*\\}\\}'
  + '|\\*{3,}|\\.{3,}|(?:your|my)[-_ ].*|enter[-_ ].*'
  + '|string|number|boolean|text|null|nil|none|undefined|true|false|yes|no|required|optional|secret|password|passwd|pass|token'
  + '|changeme|change[-_]?me|replace[-_]?me|placeholder|example|sample|redacted|hidden|empty|todo|tbd|dummy|value|bool|int|str'
  + '|omit|include|same-origin|inherit' // fetch(): `credentials: "omit"` is a policy, not a credential
  + ')$', 'i');
// A lookup of a value kept elsewhere: `process.env.X`, `$VAR`, `os.environ[...]`, `config.apiKey`.
const ENV_LOOKUP = /^(?:\$(?:\{|[A-Za-z_(])|%[A-Za-z_]|\{\{|process\.env|import\.meta\.env|os\.(?:environ|getenv)|getenv|System\.getenv|ENV\[|env\(|Deno\.env|config\.|settings\.|secrets\.|vault\.|self\.|this\.|args\.|opts\.|options\.|params\.|req\.|request\.)/i;
const PATHISH = /^(?:\/|\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|https?:\/\/|file:)/i;

/** Plain `x` / `0` / `*` repeated, or a word that only names the thing: never worth hiding. */
function isTemplate(value) {
  return PLACEHOLDER.test(value) || ENV_LOOKUP.test(value) || /^(.)\1{3,}$/.test(value);
}

/**
 * Has the look of a chosen or generated secret rather than of a word or a variable: a digit, a symbol or mixed case,
 * and not a plain identifier or property path.
 */
function looksSecretShape(value) {
  if (value.length < 8) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value) && !/\d/.test(value)) return false;
  return /\d/.test(value) || /[!@#$%^&*+=]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value));
}

/**
 * @param {string} raw      the candidate value
 * @param {object} how      quoted: it was a string literal; strong: the key is secret by its last word; dotenv: NAME=value shape
 */
function acceptValue(raw, { quoted = false, strong = false, dotenv = false } = {}) {
  const value = raw.trim();
  if (value.length < 3 || value.length > 4096 || /\s/.test(value) || isTemplate(value) || PATHISH.test(value)) return false;
  if (!quoted && /[()[\]{}<>;,]/.test(value)) return false; // code, not a literal
  if (strong && (quoted || dotenv)) return value.length >= 4 || dotenv;
  return looksSecretShape(value);
}

// How secret a key name is: 2 = it ends in a secret word (password, token, apiKey, client_secret ...), 1 = it mentions one or
// names a kind of key, 0 = not a secret by name. PASSWORD_MIN_LENGTH, token_type, max_tokens and PRIMARY_KEY are 0 or need a
// secret-looking value.
function keyClass(key) {
  const spaced = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const squashed = spaced.replace(/_/g, '');
  if (/(?:secret|password|passwd|passphrase|passcode|pwd|apikey|privatekey|accesskey|secretkey|clientsecret|token|credentials?)$/.test(squashed)) return 2;
  if (/(?:secret|passw|credential|apikey|privatekey|accesskey|authorization)/.test(squashed)
    || /(?:^|_)(?:auth|pass|dsn|salt|bearer|sessionid|cookie)$/.test(spaced)
    || /(?:signing|encryption|decryption|master|auth|hmac|jwt|webhook|deploy|ssh|shared|service|license|app)_?key$/.test(spaced)) return 1;
  return 0;
}

// ----------------------------------------------------------------------------------------------------------------------
// The rules. Order matters: the specific formats go first, so a generic rule later only sees what is left.
// Every pattern has a bounded quantifier or a word boundary on its leading edge: input can be a megabyte of base64.
// ----------------------------------------------------------------------------------------------------------------------
const NOT_ALNUM_BEFORE = '(?<![A-Za-z0-9])';
const NOT_ALNUM_AFTER = '(?![A-Za-z0-9])';

/**
 * @typedef {{id: string, pattern: RegExp, accept?: (groups: Record<string,string>) => boolean}} Rule
 * A pattern with a `secret` group replaces only that group (the key name and the quote stay readable); without one the
 * whole match goes.
 */
/** @type {Rule[]} */
const RULES = [
  // ---- vendor token formats ----------------------------------------------------------------------------------------
  { id: 'anthropic-key', pattern: new RegExp(`${NOT_ALNUM_BEFORE}sk-ant-[A-Za-z0-9_-]{20,}`, 'g') },
  { id: 'openrouter-key', pattern: new RegExp(`${NOT_ALNUM_BEFORE}sk-or-v1-[A-Za-z0-9]{32,}`, 'g') },
  // Legacy keys are one unbroken run (kebab-case identifiers such as sk-learn-cache-directory are not keys); project and
  // service-account keys carry a prefix; every key minted for a few years also has the T3BlbkFJ marker.
  { id: 'openai-key', pattern: new RegExp(`${NOT_ALNUM_BEFORE}sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}|[A-Za-z0-9]{32,}|[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{8,})`, 'g') },
  { id: 'github-fine-grained-pat', pattern: new RegExp(`${NOT_ALNUM_BEFORE}github_pat_[A-Za-z0-9_]{22,}`, 'g') },
  { id: 'github-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}gh[pousr]_[A-Za-z0-9]{30,}`, 'g') },
  { id: 'gitlab-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}gl(?:pat|dt|rt|cbt|ptt|ft|imt|agent|oas)-[A-Za-z0-9_-]{20,}`, 'g') },
  { id: 'aws-access-key-id', pattern: new RegExp(`${NOT_ALNUM_BEFORE}(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[A-Z0-9]{16}${NOT_ALNUM_AFTER}`, 'g') },
  { id: 'aws-secret-access-key', pattern: /(?<pre>\b(?:aws_secret_access_key|aws_secret_key|aws_session_token|secret_?access_?key|session_?token)["']?\]?[ \t]*(?:=>|:=|[:=])[ \t]*\\?["']?)(?<secret>[A-Za-z0-9/+=]{16,})/gi,
    accept: ({ secret }) => !isTemplate(secret) },
  { id: 'google-api-key', pattern: new RegExp(`${NOT_ALNUM_BEFORE}AIza[0-9A-Za-z_-]{35}`, 'g') },
  { id: 'google-oauth', pattern: new RegExp(`${NOT_ALNUM_BEFORE}(?:GOCSPX-[A-Za-z0-9_-]{20,}|ya29\\.[A-Za-z0-9_-]{30,}|1//0[A-Za-z0-9_-]{40,})`, 'g') },
  { id: 'slack-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}(?:xox[abeoprs]-[A-Za-z0-9-]{10,}|xapp-[0-9]-[A-Za-z0-9]+-[0-9]+-[A-Za-z0-9]+)`, 'g') },
  { id: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{20,}/g },
  { id: 'discord-webhook', pattern: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{6,}\/[A-Za-z0-9_-]{20,}/g },
  { id: 'stripe-key', pattern: new RegExp(`${NOT_ALNUM_BEFORE}(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{24,})`, 'g') },
  { id: 'twilio-key', pattern: new RegExp(`${NOT_ALNUM_BEFORE}SK[0-9a-f]{32}${NOT_ALNUM_AFTER}`, 'g') },
  { id: 'sendgrid-key', pattern: new RegExp(`${NOT_ALNUM_BEFORE}SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`, 'g') },
  { id: 'mailgun-key', pattern: new RegExp(`${NOT_ALNUM_BEFORE}key-[0-9a-f]{32}${NOT_ALNUM_AFTER}`, 'g') },
  { id: 'npm-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}npm_[A-Za-z0-9]{36}${NOT_ALNUM_AFTER}`, 'g') },
  { id: 'pypi-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}pypi-AgE[A-Za-z0-9_-]{50,}`, 'g') },
  { id: 'huggingface-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}hf_[A-Za-z0-9]{30,}`, 'g') },
  { id: 'digitalocean-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}do[opr]_v1_[a-f0-9]{64}`, 'g') },
  { id: 'shopify-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}`, 'g') },
  { id: 'docker-pat', pattern: new RegExp(`${NOT_ALNUM_BEFORE}dckr_pat_[A-Za-z0-9_-]{20,}`, 'g') },
  { id: 'vault-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}hv[sbr]\\.[A-Za-z0-9_-]{24,}`, 'g') },
  { id: 'databricks-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}dapi[a-f0-9]{32}${NOT_ALNUM_AFTER}`, 'g') },
  { id: 'postman-key', pattern: new RegExp(`${NOT_ALNUM_BEFORE}PMAK-[a-f0-9]{24}-[a-f0-9]{34}`, 'g') },
  { id: 'linear-key', pattern: new RegExp(`${NOT_ALNUM_BEFORE}lin_api_[A-Za-z0-9]{36,}`, 'g') },
  { id: 'grafana-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}glsa_[A-Za-z0-9]{32}_[a-f0-9]{8}`, 'g') },
  { id: 'atlassian-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}ATATT3[A-Za-z0-9_=-]{50,}`, 'g') },
  { id: 'terraform-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}[A-Za-z0-9]{14}\\.atlasv1\\.[A-Za-z0-9_=-]{60,}`, 'g') },
  { id: 'doppler-token', pattern: new RegExp(`${NOT_ALNUM_BEFORE}dp\\.(?:pt|st|sa|ct)\\.[A-Za-z0-9]{40,}`, 'g') },
  { id: 'age-secret-key', pattern: /AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}/g },
  { id: 'telegram-bot-token', pattern: /(?<![0-9])[0-9]{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g },
  { id: 'discord-bot-token', pattern: /(?<![A-Za-z0-9_.-])(?=[^.\s]*[0-9])[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}(?![A-Za-z0-9_-])/g },

  // ---- generic credentials with a recognisable frame ----------------------------------------------------------------
  { id: 'jwt', pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
  // A `Bearer` word in prose is not a token: the value needs the look of one.
  { id: 'bearer-token', pattern: /(?<pre>\bBearer[ \t]+)(?<secret>[A-Za-z0-9._~+/=-]{16,})/gi,
    accept: ({ secret }) => /\d/.test(secret) || /[._~+/=]/.test(secret) || (/[a-z]/.test(secret) && /[A-Z]/.test(secret)) },
  { id: 'cookie-header', pattern: /(?<pre>^[ \t]*(?:Set-)?Cookie:[ \t]*)(?<secret>[^\r\n]{8,})/gim,
    accept: ({ secret }) => secret.includes('=') && !isTemplate(secret.trim()) },
  // `[:=](?![=>])`: `headers.Authorization === token` is a comparison, not a header. A scheme word with nothing after it
  // ("`Authorization: Bearer`.") is prose; the token behind `Bearer ` is the bearer rule's.
  { id: 'auth-header', pattern: /(?<pre>\b(?:Proxy-)?Authorization["']?[ \t]*[:=](?![=>])[ \t]*\\?["']?(?:(?:Basic|Digest|Token|ApiKey|Negotiate|NTLM|AWS4-HMAC-SHA256)[ \t]+)?|\bX-(?:Api-Key|Auth-Token|Access-Token|Amz-Security-Token|Secret)["']?[ \t]*[:=](?![=>])[ \t]*\\?["']?)(?<secret>[^\s"',;]{8,})/gi,
    // After a scheme word the value must look like a credential ("Authorization: Basic followed by ..." is prose).
    accept: ({ pre, secret }) => !isTemplate(secret) && !/[()[\]{}<>$]/.test(secret) && !/^(?:Bearer|Basic|Digest|Token|ApiKey|Negotiate|NTLM)\b/i.test(secret)
      && (!/(?:Basic|Digest|Token|ApiKey|Negotiate|NTLM|AWS4-HMAC-SHA256)[ \t]+$/i.test(pre) || looksSecretShape(secret)) },
  // user:password@ inside a URL of any scheme (postgres, mongodb+srv, amqp, redis, ftp, https ...)
  { id: 'url-credentials', pattern: /(?<pre>\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'<>]{0,64}:)(?<secret>[^\s@/"'<>]{3,})(?=@)/gi,
    accept: ({ secret }) => !/^(?:\[REDACTED[^\]]*\]|<.*|\$\{.*|\{\{.*|\$[A-Za-z_]\w*|%s|%[A-Za-z_]\w*%|\*{3,}|x{3,})$/i.test(secret) },
  { id: 'azure-storage-key', pattern: /(?<pre>\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)=)(?<secret>[A-Za-z0-9+/=%]{20,})|(?<pre2>[?&]sig=)(?<secret2>[A-Za-z0-9%+/=]{20,})/g },
  // ADO.NET / ODBC / JDBC style: Server=...;Password=...;  jdbc:...?user=a&password=b
  { id: 'connection-password', pattern: /(?<pre>(?:^|[;?&\s])(?:password|pwd|passwd)[ \t]*=(?!=)[ \t]*)(?<secret>[^;&\s"'`\\]{3,})/gim,
    accept: ({ secret }) => acceptValue(secret, { strong: true, dotenv: true }) },
  { id: 'sql-password', pattern: /(?<pre>\b(?:IDENTIFIED[ \t]+BY|PASSWORD)[ \t]+')(?<secret>[^'\r\n]{3,200})(?=')/g,
    accept: ({ secret }) => !isTemplate(secret) },
  { id: 'npmrc-auth', pattern: /(?<pre>:_(?:authToken|auth|password)[ \t]*=[ \t]*)(?<secret>[^\s"']{4,})/g,
    accept: ({ secret }) => !isTemplate(secret) },
  { id: 'netrc-password', pattern: /(?<pre>\bmachine[ \t]+\S+[ \t]+login[ \t]+\S+[ \t]+password[ \t]+)(?<secret>\S+)/g },
  { id: 'kube-key-data', pattern: /(?<pre>\b(?:client-key-data|tls\.key|private-key-data)["']?[ \t]*:[ \t]*["']?)(?<secret>[A-Za-z0-9+/=]{40,})/g },
  { id: 'powershell-secure-string', pattern: /(?<pre>\bConvertTo-SecureString[ \t]+(?<q>["']))(?<secret>[^"'\r\n]{3,200})(?=\k<q>[ \t]+-AsPlainText)/gi },
  // command lines: --password hunter2, --token=abc, -u user:pass, sshpass -p secret, cmdkey /pass:secret
  { id: 'query-secret', pattern: /(?<pre>[?&](?<key>access_token|id_token|refresh_token|api[_-]?key|apikey|token|secret|client_secret|password|passwd|pwd|auth)=)(?<secret>[^&\s"'#]{4,300})/gi,
    accept: ({ key, secret }) => { const klass = keyClass(key); return klass > 0 && acceptValue(secret, { quoted: true, strong: klass === 2 }); } },
  { id: 'cli-secret-flag', pattern: /(?<pre>(?:^|[ \t])(?:--?(?:[a-z0-9]+-)?(?:password|passwd|token|api-?key|apikey|secret|client-?secret|access-?token|auth-?token)(?:=|[ \t]+)["']?|sshpass[ \t]+-p[ \t]*["']?|\/pass(?:word)?:|(?:docker|podman|helm|oras)[ \t]+(?:registry[ \t]+)?login\b[^\n|;&]*?[ \t]-p[ \t]*["']?|mysql(?:dump|admin)?\b[^\n|;&]*?[ \t]-p(?=[^\s-])|redis-cli\b[^\n|;&]*?[ \t]-a[ \t]+["']?|(?:curl|wget|http|https)\b[^\n|;&]*?[ \t]-u[ \t]+["']?[^\s:"']+:))(?<secret>[^\s"'|;&]{3,})/gim,
    accept: ({ secret }) => !isTemplate(secret) && !/^-/.test(secret) },

  { id: 'setx-secret', pattern: /(?<pre>\bsetx[ \t]+(?<key>[A-Za-z_][A-Za-z0-9_]{0,80})[ \t]+["']?)(?<secret>[^\s"']{3,})/gi,
    accept: ({ key, secret }) => { const klass = keyClass(key); return klass > 0 && acceptValue(secret, { strong: klass === 2, dotenv: true }); } },

  // ---- assignments: the key says it is a secret ---------------------------------------------------------------------
  // NAME=value at the start of a line (.env, shell, ini, toml, a diff of one of them)
  { id: 'env-secret', pattern: /^(?<pre>[ \t]*(?:[+-][ \t]*)?(?:export[ \t]+|setx?[ \t]+|\$env:)?(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,80})[ \t]*=(?!=)[ \t]*["']?)(?<secret>[^\r\n"']{3,300}?)(?=["']?[ \t]*[;,]?[ \t]*$)/gm,
    accept: ({ key, secret }) => {
      const klass = keyClass(key);
      return klass > 0 && acceptValue(secret, { strong: klass === 2, dotenv: /^[A-Z][A-Z0-9_]*$/.test(key) });
    } },
  // "key": "value" / key = 'value' / key: "value" anywhere on a line (JSON, JS objects, Python keyword arguments, YAML)
  { id: 'assigned-secret', pattern: /(?<pre>(?<![A-Za-z0-9_.-])\\?["']?(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,80})\\?["']?\]?[ \t]*(?:=>|:=|[:=])[ \t]*\\?(?<q>["'`]))(?<secret>[^"'`\\\r\n]{4,300})(?=\\?\k<q>)/g,
    accept: ({ key, secret }) => { const klass = keyClass(key); return klass > 0 && acceptValue(secret, { quoted: true, strong: klass === 2 }); } },
  // key: value without quotes (YAML)
  { id: 'yaml-secret', pattern: /^(?<pre>[ \t]*(?:-[ \t]+)?(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,80})[ \t]*:[ \t]+)(?<secret>[^\s"'#[\]{}][^\r\n#]{3,300}?)(?=[ \t]*(?:#[^\r\n]*)?$)/gm,
    accept: ({ key, secret }) => keyClass(key) > 0 && acceptValue(secret) },
];

// ----------------------------------------------------------------------------------------------------------------------
// Private key blocks are found by scanning, not by one regex: the END line may be missing (a result cut by paging or by a
// read limit) and then everything up to the end of the text goes, in one linear pass.
// ----------------------------------------------------------------------------------------------------------------------
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;

function redactPrivateKeys(text, found) {
  if (!text.includes('PRIVATE KEY')) return text;
  let output = '', cursor = 0;
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  for (let begin = PRIVATE_KEY_BEGIN.exec(text); begin; begin = PRIVATE_KEY_BEGIN.exec(text)) {
    PRIVATE_KEY_END.lastIndex = begin.index + begin[0].length;
    const end = PRIVATE_KEY_END.exec(text);
    const stop = end ? end.index + end[0].length : text.length;
    output += text.slice(cursor, begin.index) + redactionMark('private-key');
    cursor = stop;
    found.set('private-key', (found.get('private-key') ?? 0) + 1);
    PRIVATE_KEY_BEGIN.lastIndex = stop;
    if (!end) break;
  }
  return output + text.slice(cursor);
}

/** Every label the scanner can produce, for tests and documentation. */
export const REDACTION_LABELS = Object.freeze(['private-key', ...RULES.map((rule) => rule.id), 'secret-field', 'manual']);

function applyRule(rule, text, found) {
  return text.replace(rule.pattern, (...args) => {
    const groups = args.at(-1);
    const hasGroups = groups && typeof groups === 'object';
    const secretName = hasGroups ? (groups.secret !== undefined ? 'secret' : groups.secret2 !== undefined ? 'secret2' : null) : null;
    if (secretName) {
      if (rule.accept && !rule.accept(groups)) return args[0];
      const pre = secretName === 'secret' ? groups.pre : groups.pre2;
      found.set(rule.id, (found.get(rule.id) ?? 0) + 1);
      return `${pre}${redactionMark(rule.id)}`;
    }
    if (rule.accept && !rule.accept(groups ?? {})) return args[0];
    found.set(rule.id, (found.get(rule.id) ?? 0) + 1);
    return redactionMark(rule.id);
  });
}

function manualPatterns(extra) {
  const literals = [];
  for (const item of extra ?? []) {
    if (typeof item !== 'string' || item.length < 3 || item.length > 200) continue;
    literals.push(item);
    // the same text as it appears inside a JSON string
    const escaped = JSON.stringify(item).slice(1, -1);
    if (escaped !== item) literals.push(escaped);
  }
  return literals;
}

/**
 * @param {string} input
 * @param {{extra?: string[]}} [options] extra: literal strings the person asked to hide as well
 * @returns {{text: string, count: number, labels: Record<string, number>}}
 */
export function redactText(input, { extra = [] } = {}) {
  let text = typeof input === 'string' ? input : String(input ?? '');
  const found = new Map();
  text = redactPrivateKeys(text, found);
  for (const rule of RULES) text = applyRule(rule, text, found);
  for (const literal of manualPatterns(extra)) {
    if (!text.includes(literal)) continue;
    const pieces = text.split(literal);
    found.set('manual', (found.get('manual') ?? 0) + pieces.length - 1);
    text = pieces.join(redactionMark('manual'));
  }
  const labels = Object.fromEntries(found);
  return { text, count: [...found.values()].reduce((a, b) => a + b, 0), labels };
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Filters every string inside a JSON-like value. A string that sits under a key that names a secret
 * (`{"password": "..."}`) is judged by its key as well as by its content. Returns a copy.
 * @returns {{value: any, count: number, labels: Record<string, number>}}
 */
export function redactDeep(input, options = {}) {
  const labels = {};
  const merge = (report) => { for (const [label, n] of Object.entries(report)) labels[label] = (labels[label] ?? 0) + n; };
  const visit = (value, key = '') => {
    if (typeof value === 'string') {
      const klass = key ? keyClass(key) : 0;
      if (klass > 0 && acceptValue(value, { quoted: true, strong: klass === 2 })) { merge({ 'secret-field': 1 }); return redactionMark('secret-field'); }
      const report = redactText(value, options);
      merge(report.labels);
      return report.text;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, key));
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    return value;
  };
  const result = visit(input);
  return { value: result, count: Object.values(labels).reduce((a, b) => a + b, 0), labels };
}

// ----------------------------------------------------------------------------------------------------------------------
// Protected files
// ----------------------------------------------------------------------------------------------------------------------
// The names the owner asked to keep out of ChatGPT, on top of everything protected-paths.mjs already covers. `.env*` is
// literal: `.env.example` is withheld too (lib/protected-paths.mjs lets a template through; this filter does not).
const DENIED_NAME = /^(?:\.env.*|.*\.(?:pem|key)|id_rsa.*)$/i;

function cleanPath(value) {
  let text = String(value).trim().replace(/^file:\/\/\/?/i, '');
  try { text = decodeURIComponent(text); } catch { /* keep the text as written */ }
  return text.replace(/[\\/]+$/, '');
}

/** True when the path names a file whose content must never be passed on, however it was read. */
export function isDeniedOutboundPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return false;
  const text = cleanPath(value);
  const parts = text.split(/[\\/]+/).filter((part) => part && part !== '.');
  const name = (parts.at(-1) ?? '')
    .replace(/:[^\\/]*$/, '') // NTFS alternate stream  (.env::$DATA)
    .replace(/[. ]+$/, '');  // Windows ignores trailing dots and spaces
  if (name && DENIED_NAME.test(name)) return true;
  if (isProtectedPath(text)) return true;
  return /[*?]/.test(text) && mayExpandToProtected(text);
}

const PATH_KEYS = /^(?:path|paths|file|files|filepath|file_path|file_paths|filename|file_name|filenames|source|sources|src|dest|destination|dst|target|targets|old_?path|new_?path|uri|uris|dir|directory|folder|cwd|glob)$/i;
const COMMAND_KEYS = /^(?:command|cmd|commandline|command_line|script|args|argv|shell|run|exec|code|input)$/i;

/** Paths a call names: path-like arguments, and the tokens of anything that looks like a command line. */
function pathsOfCall(argumentsValue) {
  const paths = [];
  const visit = (value, key = '', asCommand = false) => {
    if (typeof value === 'string') {
      if (PATH_KEYS.test(key)) paths.push(value);
      else if (asCommand || COMMAND_KEYS.test(key)) {
        for (const token of value.split(/[\s|&;<>()"'`=,]+/)) {
          if (!token) continue;
          paths.push(token);
          // `git show HEAD:.env`, `scp host:.env .` - each side of a colon may be the path
          if (token.includes(':') && !/^[A-Za-z]:[\\/]/.test(token)) for (const piece of token.split(':')) if (piece) paths.push(piece);
        }
      }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, key, asCommand || COMMAND_KEYS.test(key)); return; }
    if (isPlainObject(value)) for (const [name, item] of Object.entries(value)) visit(item, name, false);
  };
  visit(argumentsValue);
  return paths;
}

const GREP_LINE = /^(?<path>(?:[A-Za-z]:)?[^\s:"'<>|*?]+?)(?::\d+){0,2}:(?=\s|$|\S)/;
const HEAD_BANNER = /^==>\s*(?<path>.+?)\s*<==$/;

/** Lines of a search or `head -n` dump that come from a protected file. */
function withholdLines(text, names) {
  if (!text.includes('\n') && !GREP_LINE.test(text)) return text;
  return text.split('\n').map((line) => {
    const hit = GREP_LINE.exec(line) ?? HEAD_BANNER.exec(line);
    const candidate = hit?.groups?.path;
    if (candidate && isDeniedOutboundPath(candidate)) { names.add(candidate.split(/[\\/]/).pop()); return `${candidate}: [content withheld]`; }
    return line;
  }).join('\n');
}

function withholdStructure(value, names) {
  if (Array.isArray(value)) return value.map((item) => withholdStructure(item, names));
  if (isPlainObject(value)) {
    const denied = Object.entries(value).find(([key, item]) => typeof item === 'string' && /^(?:path|file|filepath|file_path|filename|uri)$/i.test(key) && isDeniedOutboundPath(item));
    if (denied) {
      names.add(String(denied[1]).split(/[\\/]/).pop());
      return { [denied[0]]: denied[1], withheld: true, notice: 'Content withheld: protected file.' };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withholdStructure(item, names)]));
  }
  if (typeof value === 'string') return withholdLines(value, names);
  return value;
}

export const WITHHELD_NOTICE = (names) => `[WITHHELD by ChatMCP: this result involves a protected file (${names.slice(0, 5).join(', ') || '.env, private key, credentials'}). `
  + 'Its content was not sent to ChatGPT. Ask the user to describe what you need instead of reading secret files.]';

/**
 * Keeps what a tool read from a protected file out of the chat.
 * @param {{name?: string, arguments?: any, uri?: string}} call what the model asked for
 * @param {any} result what the tool returned (an MCP result, or any JSON value)
 * @returns {{result: any, withheld: string[]}} withheld: file names only, never content
 */
export function withholdProtected(call, result) {
  const argumentsValue = call?.arguments ?? (call?.uri ? { uri: call.uri } : {});
  const named = pathsOfCall(argumentsValue).filter(isDeniedOutboundPath);
  if (named.length) {
    // file names only, and short: a "name" comes from a string the model wrote
    const names = [...new Set(named.map((item) => cleanPath(item).split(/[\\/]/).pop().slice(0, 80)))];
    return {
      withheld: names,
      result: { isError: false, content: [{ type: 'text', text: WITHHELD_NOTICE(names) }], structuredContent: { withheld: true, reason: 'protected_path', paths: names } },
    };
  }
  const names = new Set();
  const filtered = withholdStructure(result, names);
  return { result: filtered, withheld: [...names] };
}
