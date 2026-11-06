import { writeJson, readJson, redact as redactSecrets } from './runtime.mjs';
import { FILE_CHANGE_TOOLS, hideKeyBlocks } from './approval-preview.mjs';
import { isProtectedPath } from './protected-paths.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Modes (what the agent may do without asking):
//   readonly    - reads and bookkeeping only; every change is refused without a prompt
//   review      - reads run; every change asks the user (legacy name: "manual")
//   autonomous  - file edits and known-safe verification commands run; execution and deletion still ask; an unclassified tool is refused (not asked)
export const PERMISSION_MODES = Object.freeze(['readonly', 'review', 'autonomous']);
const MODE_ALIASES = Object.freeze({ manual: 'review' });
const EXECUTION_POLICIES = Object.freeze(['host-review', 'sandbox-only', 'full-access']);
const normalizeMode = (value) => { const mode = MODE_ALIASES[value] ?? value; return PERMISSION_MODES.includes(mode) ? mode : null; };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Operations that Full Access still asks about. Category 'dangerous' (deletion, history rewrite, git push, destructive gh/npm/kubectl/
// terraform commands as classified by lib/command-analysis.mjs) covers most of them; the tool names are listed too so that
// re-categorising a tool can never silently drop them from the list.
const ALWAYS_ASK_TOOLS=/(?:^|\.)(?:github_pr_merge|github_release_create|git_push)$/i;
function mustAskEvenInFullAccess(name,verdict){
  return verdict.category==='dangerous'||verdict.risk?.kind==='dangerous'||ALWAYS_ASK_TOOLS.test(String(name));
}

const READ=/\b(?:read|list|search|find|browse|stat|info|status|get|describe|inspect|query|diff|diagnostic)\b/i;
const MUTATE=/\b(?:write|edit|replace|patch|move|rename|create|update|add|delete|remove|save|insert|commit|upload|run|execute|install|start_process|spawn|terminal|bash|powershell|execute_code|push|publish)\b/i;
const SECRET_KEYS=/authorization|secret|password|token|api.?key|private.?key/i;

// Best-effort masking of credentials that were not registered as secrets (previews are shown in the UI
// and kept in the audit history). Registered secrets are always replaced exactly.
// The name of a secret as code and configuration spell it: DB_PASSWORD, clientSecret, "access_token", x-api-key, aws_secret_access_key, app.config["SECRET_KEY"]. The word may carry a prefix and one
// of a few endings (_key, token, value, hash, id, string), nothing else: tokenCount, passwordInput and tokenizer are names of code that talks about secrets, not secrets.
const SECRET_WORD = String.raw`(?:api[_-]?key|access[_-]?key|private[_-]?key|ssh[_-]?key|secret|password|passwd|pwd|passphrase|token|credentials?)`;
const SECRET_ENDING = String.raw`(?:[_-]?(?:key|token|value|hash|id|string))?`;
const SECRET_NAME = String.raw`\b[A-Za-z0-9_.$-]{0,40}${SECRET_WORD}${SECRET_ENDING}["']?\]?`;
// A value written bare after such a name that is no secret: the type of the name (`token: string;`), a read of the environment or of a variable (`process.env.API_KEY`, `os.environ[..]`, `$TOKEN`,
// `%TOKEN%`), a word that says it is a placeholder (`changeme`), the plain name of a secret (`password=password`, `token: Token`: a variable or a type) and a member read that ends in one (`this.token`,
// `config.dbPassword`). Each has to be the WHOLE value: a value that only starts like one (`string1Hunter`, `$ecret!9`, `changeme123`, `password123`) is masked, and so is a name with a prefix and no dot
// (`MyPassword`, `supersecret`): a word of letters cannot be told from a weak password by its shape.
// A quoted value is a literal and is masked, but for the three words of the `credentials` option of fetch (include, omit, same-origin).
const VALUE_CHAR = String.raw`[^\s"'&,;(){}\[\]<>]`;
const TYPE_WORDS = ['string', 'number', 'boolean', 'unknown', 'object', 'symbol', 'bigint', 'undefined', 'buffer', 'bytearray', 'uint8array', 'integer', 'double', 'decimal', 'varchar', 'optional', 'secretstr', 'securestring', 'requestcredentials'];
const PLACEHOLDER_WORDS = ['changeme', 'change[-_]me', 'replace[-_]?me', 'placeholder', 'redacted', 'example', 'x+', String.raw`\*+`, 'your[-_][a-z_-]+'];
const WHOLE_VALUES = String.raw`(?:${TYPE_WORDS.join('|')}|${PLACEHOLDER_WORDS.join('|')}|${SECRET_WORD}${SECRET_ENDING}|(?:[A-Za-z_]\w*\.)+\w{0,40}${SECRET_WORD}${SECRET_ENDING}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)(?!${VALUE_CHAR})`;
const READS_OF_THE_ENVIRONMENT = String.raw`(?:process\.env|import\.meta\.env|os\.environ|ENV)[.\[]|\$env:`;
// A secret given to a command as the value of a flag. A flag counts when a space (or the start of the text) comes before it; the value is bare or in quotes; a read of a variable ($PASSWORD,
// %PASSWORD%) is no secret, and neither is another flag. A flag whose name says that there is no password (--no-password, --ask-password) takes no value.
const LONG_FLAG = String.raw`(?<!\S)--(?!(?:no|skip|ask|prompt|disable|enable|with|use|require|show|hide|ignore)-)(?:[a-z0-9]+-)*(?:password|passwd|passphrase|pass|pwd|token|secret|api-?key|access-?key|secret-?key)`;
// -u, --user and --proxy-user take a user and a password (user:password) in curl and in a good many other clients; the clients of containers take a user and a group with the same flags (-u 1000:1000,
// --user node:node). So the flags are a user and a password wherever they stand, but for two things: a numeric pair (a user id and a group id), and the flags of a container client (see
// afterContainerClient). A secret fails safe: what is not known to be a container is masked.
const USER_FLAG = String.raw`(?<!\S)(?:-u|--user|--proxy-user)[ \t=]+`;
const NUMERIC_PAIR = String.raw`\d{1,10}:\d{1,10}`;
const CONTAINER_CLIENT = /\b(?:docker|podman|nerdctl|buildah|skopeo|kubectl|oc|crictl|ctr|lxc|incus)\b/gi;
const CONTAINER_WINDOW = 200;
const isWordCharacter = (code) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
/** Whether the word curl starts at `index` (as a whole word, in any case). */
const curlStartsAt = (text, index) => (text[index] === 'c' || text[index] === 'C') && text.slice(index, index + 4).toLowerCase() === 'curl' && !isWordCharacter(text.charCodeAt(index - 1)) && !isWordCharacter(text.charCodeAt(index + 4));
// The ends of the names of container clients in the text that the rules are working on: read once for it (the callbacks of one replace get the very same string), and let go at the end of maskSecrets.
let clientEnds = { text: null, ends: [] };
const containerClientEnds = (text) => {
  if (clientEnds.text !== text) clientEnds = { text, ends: Array.from(text.matchAll(CONTAINER_CLIENT), (match) => match.index + match[0].length) };
  return clientEnds.ends;
};
/**
 * Whether the flag that starts at `at` comes after the name of a container client in the same command: at most 200 characters before it (a continuation of the line, a backslash or a caret or a
 * backtick and then the line ending, counts as one), with no curl and no ; & | and no other line ending in between. It walks back from the flag, so what it reads is what lies between the flag and
 * the nearest name of a client: docker exec web curl -u user:secret is a curl; docker pull x; tool -u user:secret is another command; and a user and a group after docker stay as they are.
 */
function afterContainerClient(text, at) {
  const ends = containerClientEnds(text);
  let low = 0;
  let high = ends.length - 1;
  let end = -1;
  while (low <= high) { // the last name that ends at or before the flag: a name further back would have this one between itself and the flag, and no more is allowed there
    const middle = (low + high) >> 1;
    if (ends[middle] <= at) { end = ends[middle]; low = middle + 1; } else high = middle - 1;
  }
  if (end < 0) return false;
  let cursor = at;
  for (let items = 0; ; items += 1) {
    if (cursor === end) return true;
    if (items === CONTAINER_WINDOW) return false;
    const character = text[cursor - 1];
    if (character === '\n') { // only the continuation of a line goes over a line ending
      let back = cursor - 2;
      if (text[back] === '\r') back -= 1;
      while (text[back] === ' ' || text[back] === '\t') back -= 1; // text[-1] is undefined: the loop and the test below stop at the start of the text
      if (text[back] !== '\\' && text[back] !== '^' && text[back] !== '`') return false;
      cursor = back;
    } else if (character === '\r' || character === ';' || character === '&' || character === '|' || curlStartsAt(text, cursor - 1)) {
      return false;
    } else {
      cursor -= 1;
    }
  }
}
// The -p of the clients of MySQL has its password glued to it (-psecret); in sshpass and in the login of a container client it is a word of its own (-p secret). Their letters are small and so is
// the -p: a capital -P is the port of mysql (-P3306), so these two do not ignore the case.
const MYSQL_P = String.raw`\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mysqlpump|mariadb)\b[^\r\n]{0,200}?(?<!\S)-p`;
const SPACED_P = String.raw`(?:\bsshpass[ \t]+-p[ \t]*|\b(?:docker|podman|nerdctl|buildah|skopeo)[ \t]+login\b[^\r\n]{0,200}?(?<!\S)-p[ \t]+)`;
const quotedValue = (head, flags = 'gi') => new RegExp(String.raw`(${head})(["'])(?![$%])(?:(?!\2)[^\r\n]){1,2000}\2`, flags);
const bareValue = (head, least, flags = 'gi') => new RegExp(String.raw`(${head})(?![$%-])[^\s"'|;&<>()]{${least},}`, flags);
// XML: <password>secret</password>, <db-password encrypted="false">secret</db-password>, <add key="ApiKey" value="secret" />, <property name="password" value="secret"/>.
const XML_NAME = String.raw`[A-Za-z0-9_.:-]{0,40}${SECRET_WORD}${SECRET_ENDING}`;
const TOKEN_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED]'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, '[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\bhf_[A-Za-z0-9]{30,}/g, '[REDACTED]'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bpypi-[A-Za-z0-9_-]{30,}/g, '[REDACTED]'],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  // The body of a private key once decoded starts with MII (DER); the whole block, when the text holds its two frames, is hidden before this table by hideKeyBlocks.
  [/\bMII[A-Za-z0-9+/]{30,}={0,2}/g, '[REDACTED]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]'],
  // Any other Authorization header (Basic, Token, Digest ...): everything after it, unless the Bearer rule has masked it already.
  [/(\bAuthorization["']?\s*[:=]\s*["']?)(?![^\r\n]*\[REDACTED\])[^\r\n"']{6,}/gi, '$1[REDACTED]'],
  // A secret given to a command: --password secret, --github-token secret, curl -u user:secret, mysql -psecret, sshpass -p secret, docker login -p secret.
  [quotedValue(`${LONG_FLAG}[ \\t]+`), '$1$2[REDACTED]$2'],
  [bareValue(`${LONG_FLAG}[ \\t]+`, 4), '$1[REDACTED]'],
  [new RegExp(String.raw`(${USER_FLAG}(["'])(?!${NUMERIC_PAIR}\2)[^\r\n"':]{1,100}:)(?!//|[$%])(?:(?!\2)[^\r\n]){1,2000}\2`, 'gi'),
    (all, head, quote, at, text) => (afterContainerClient(text, at) ? all : `${head}[REDACTED]${quote}`)],
  [new RegExp(String.raw`(${USER_FLAG}(?!${NUMERIC_PAIR}(?![^\s"'|;&<>()]))[^\s:"']{1,100}:)(?!//|[$%])[^\s"'|;&<>()]+`, 'gi'),
    (all, head, at, text) => (afterContainerClient(text, at) ? all : `${head}[REDACTED]`)],
  [quotedValue(MYSQL_P, 'g'), '$1$2[REDACTED]$2'],
  [bareValue(MYSQL_P, 1, 'g'), '$1[REDACTED]'],
  [quotedValue(SPACED_P, 'g'), '$1$2[REDACTED]$2'],
  [bareValue(SPACED_P, 1, 'g'), '$1[REDACTED]'],
  // A secret in XML: the text of an element named like a secret, and the value of an entry (<add key=".." value=".."/>) whose key is named like one. A read (${env.X}, %X%) and a placeholder are not.
  [new RegExp(String.raw`(<(${XML_NAME})(?:[ \t][^<>\r\n]{0,200})?>)(?![ \t]*(?:[$%]|(?:${PLACEHOLDER_WORDS.join('|')})[ \t]*<))[^<\r\n]{4,}?(?=<\/\2[ \t]*>)`, 'gi'), '$1[REDACTED]'],
  [new RegExp(String.raw`(\b(?:key|name)=(["'])[^"'\r\n]{0,60}${SECRET_WORD}[^"'\r\n]{0,20}\2\s+value=)(["'])(?![$%])(?:(?!\3)[^\r\n<>]){4,}\3`, 'gi'), '$1$3[REDACTED]$3'],
  // A secret assigned to a name: in quotes (up to the closing quote, spaces included, but for the words of fetch's credentials option), or bare (not a number, not a regular expression, not a call, not a
  // ${placeholder} or <placeholder>, and none of the values that are no secret: a type, a read of the environment or of a variable, a placeholder).
  [new RegExp(String.raw`(${SECRET_NAME}\s*[=:]\s*)(["'])(?!(?:include|omit|same-origin)\2)(?:(?!\2)[^\r\n]){4,}\2`, 'gi'), '$1$2[REDACTED]$2'],
  [new RegExp(String.raw`(${SECRET_NAME}\s*[=:]\s*)(?!["'/]|[0-9]+(?![\w.@/+=-])|${VALUE_CHAR}*\(|${WHOLE_VALUES}|${READS_OF_THE_ENVIRONMENT})${VALUE_CHAR}{6,}`, 'gi'), '$1[REDACTED]'],
  [/(\/\/[^\s/:@]+:)[^\s/@]{3,}(@)/g, '$1[REDACTED]$2'],
];
export function maskSecrets(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  // The keys first: a rule below can break a frame (a token glued to it takes five of its dashes) and then leaves the body behind. hideKeyBlocks reads the text once, whatever it holds.
  text = hideKeyBlocks(text);
  for (const [pattern, replacement] of TOKEN_PATTERNS) text = text.replace(pattern, replacement);
  clientEnds = { text: null, ends: [] }; // do not keep the text (it can be megabytes) until the next call
  return text;
}
const maskDeep = (value, secrets) => {
  if (typeof value === 'string') return maskSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, secrets));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(item, secrets)]));
  return value;
};

function safePreview(value,length=1800,secrets=[]){
  const redact=(x,key='')=>{
    if(SECRET_KEYS.test(key))return '[REDACTED]';
    if(typeof x==='string') return x.slice(0,700);
    if(Array.isArray(x)) return x.slice(0,30).map(v=>redact(v));
    if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).slice(0,50).map(([k,v])=>[k,redact(v,k)]));
    return x;
  };
  return redactSecrets(JSON.stringify(redact(value)).slice(0,length),secrets);
}
function error(code,message,statusCode=403){return Object.assign(new Error(message),{code,statusCode});}
const cut = (value, limit) => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit)}… [+${text.length - limit} ký tự nữa]` : text; };

// An edit_file call with several edits: the owner is shown ALL of them, never only the first. `edits` lists the first 20 (400 characters of each side); old_string and new_string are
// the combined view the diff panel prints, each edit under its position, and they say how many are left out when there are more than 20.
const EDITS_LISTED = 20;
function editListDetail(input) {
  const edits = input.edits.filter(isObject);
  const shown = edits.slice(0, EDITS_LISTED);
  const combined = (field) => shown.map((edit, index) => `[${index + 1}/${edits.length}]${edit.replace_all ? ' (replace_all)' : ''}\n${cut(edit[field], 400)}`).join('\n----\n')
    + (edits.length > shown.length ? `\n----\n… ${edits.length - shown.length} chỉnh sửa nữa không hiển thị ở đây` : '');
  return {
    kind: 'edit', path: input.path, replace_all: false, edit_count: edits.length,
    edits: shown.map((edit) => ({ old_string: cut(edit.old_string, 400), new_string: cut(edit.new_string, 400), replace_all: Boolean(edit.replace_all) })),
    old_string: cut(combined('old_string'), 4000), new_string: cut(combined('new_string'), 4000),
  };
}
const HISTORY_PREVIEW_CHARS = 2000;

export class PermissionGate {
  constructor({ manager, workspace, directory=null, now=()=>Date.now(), timeout=10*60*1000 }){
    this.manager=manager;this.workspace=workspace;this.now=now;this.timeout=timeout;
    this.mode='review';this.executionPolicy='host-review';this.requests=new Map();this.history=[];this.onEvent=()=>{};this.listeners=new Set();this.file=directory?path.join(directory,'permission-history.json'):null;this.writes=Promise.resolve();
    this.localTools=null;
    this.executionRegistry=null;
    // Who can answer an approval request. A coding-orchestrator worker is never interactive. A background agent that a model spawned
    // can ask only in Review, where the owner expects to be asked and sees the request; in Autonomous and Full Access nobody is watching.
    this.interactive=true;
    this.backgroundAgent=false;
  }
  /** Whether a request for approval can be answered at all in this context. */
  canAsk(){
    if(!this.interactive)return false;
    if(this.backgroundAgent&&this.mode!=='review')return false;
    return true;
  }
  /** Gives the gate knowledge of the execution capability registry. */
  attachExecutionRegistry(registry){this.executionRegistry=registry;}
  /** Gives the gate exact knowledge of the local tools (per-call category, blocked paths, command analysis). */
  attachLocalTools(localTools){this.localTools=localTools;}
  /** Several parties can watch approval events (the log, a task runner); `onEvent` stays as the single legacy hook. Returns the unsubscribe function. */
  subscribe(listener){if(typeof listener!=='function')throw error('bad_listener','Listener phải là hàm.',400);this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};}
  #emit(event){
    this.onEvent(event);
    // A watcher that throws must never change what the gate decides.
    for(const listener of [...this.listeners]){try{listener(event);}catch{ /* ignored on purpose */ }}
  }
  async load(){
    if(!this.file)return;
    const saved=await readJson(this.file);
    const mode=normalizeMode(saved?.mode);
    if(mode)this.mode=mode;
    if(EXECUTION_POLICIES.includes(saved?.executionPolicy))this.executionPolicy=saved.executionPolicy;
    if(Array.isArray(saved?.history))this.history=saved.history.slice(-100);
  }
  #save(){if(!this.file)return;this.writes=this.writes.catch(()=>{}).then(()=>writeJson(this.file,{mode:this.mode,executionPolicy:this.executionPolicy,history:this.history.slice(-100)}));this.writes.catch(()=>{});}
  state(){return {mode:this.mode,modes:[...PERMISSION_MODES],executionPolicy:this.executionPolicy,fullAccess:this.executionPolicy==='full-access',canAsk:this.canAsk(),approvalTimeoutMs:this.timeout,pending:[...this.requests.values()].map(({id,taskId,toolName,category,reason,summary,preview,detail,at,expiresAt})=>({id,taskId,toolName,category,reason,summary,preview,detail,at,expiresAt})),recent:this.history.slice(-60)};}
  configure({mode,executionPolicy,confirmation,leaveFullAccess}={}){
    let nextMode;
    if(mode==='full-access'){
      executionPolicy='full-access';
      nextMode='autonomous';
    } else if(mode!==undefined){
      nextMode=normalizeMode(mode);
      if(!nextMode)throw error('bad_mode','Chế độ phải là readonly (chỉ đọc), review hoặc autonomous.',400);
    }
    // A page that means "any mode but Full Access" says so here instead of reading the state first: what it read can be older than this call
    // (Full Access was turned on a moment ago), and a mode sent alone leaves the policy where it is. Only a policy that is full-access is lowered,
    // sandbox-only and host-review stay as they are, and a policy named in the same request is the person's word and wins.
    if(leaveFullAccess===true&&executionPolicy===undefined&&this.executionPolicy==='full-access')executionPolicy='host-review';
    if(executionPolicy!==undefined&&!EXECUTION_POLICIES.includes(executionPolicy))throw error('bad_policy','Chính sách sandbox không hợp lệ.',400);
    if(executionPolicy==='full-access' && this.executionPolicy!=='full-access' && confirmation!=='FULL ACCESS') throw error('full_access_confirmation_required','Nhập chính xác FULL ACCESS để cho phép agent đọc/sửa file ngoài workspace, sử dụng Internet và chạy công cụ nguy hiểm với quyền Windows hiện tại.',403);
    if(nextMode!==undefined)this.mode=nextMode;
    if(executionPolicy!==undefined)this.executionPolicy=executionPolicy;
    this.#save();return this.state();
  }
  classify(name,args={},definition={}) {
    const n=String(name).toLowerCase();
    if(n.startsWith('studio.')) {
      if(/^(studio\.(tree|read|search|status|diff|diff_check|checkpoints|review|plan_get|skills|checks|symbols|references|definitions|index_status))$/.test(n))return {category:'read',reason:'Workspace read-only'};
      if(n==='studio.plan_set')return {category:'checkpoint',reason:'Update durable task plan'};
      if(n==='studio.checkpoint')return {category:'checkpoint',reason:'Local backup'};
      return {category:'dangerous',reason:'Local workspace mutation'};
    }
    if(/(?:start_process|spawn|execute_code|terminal|(?:^|[._-])command(?:[._-]|$)|shell|run_script|bash|powershell)/.test(n))return {category:'execute',reason:'Lệnh có thể chạy mã ngoài workspace'};
    if(/(?:delete|remove|truncate|wipe|reset|push|publish|upload|destroy|force)/.test(n))return {category:'dangerous',reason:'Thao tác phá huỷ/xuất dữ liệu'};
    // Tool descriptions/annotations originate from external MCP providers and
    // are not a trust boundary. A malicious 'readOnlyHint' must never downgrade
    // a tool whose name indicates mutation or execution.
    if(MUTATE.test(n)||/(?:^|[._-])(?:write|edit|replace|patch|move|rename|create|update|delete|remove|save|insert|upload)(?:[._-]|$)/.test(n))return {category:'workspace_edit',reason:'Có thể thay đổi file/trạng thái'};
    if(READ.test(n)||/(?:^|[._-])(?:read|list|search|find|browse|stat|info|status|get|describe|inspect|query|diff)(?:[._-]|$)/.test(n))return {category:'read',reason:'Đọc dữ liệu'};
    // Unknown provider hints are not sufficient to authorize unknown tools.

    return {category:'unknown',reason:'Chưa phân loại được công cụ'};
  }
  /** Category of one concrete call. Local tools are assessed per call (a shell command is read, edit, exec or dangerous by its text). */
  async assess(name,args={},definition={},context={}){
    if(String(name).toLowerCase().startsWith('local.')&&this.localTools?.has(name)){
      const verdict=await this.localTools.assess(name,args,context);
      return {category:verdict.category,reason:verdict.reason||'Công cụ local',summary:verdict.summary,risk:verdict.risk,local:true,detail:verdict.detail,code:verdict.code};
    }
    return {...this.classify(name,args,definition),local:false};
  }
  async inspectPaths(args,category){
    if(!['workspace_edit','dangerous','execute','unknown'].includes(category))return;
    if(!this.workspace?.root)return;
    const visit=async(v,key='')=>{
      if(v&&typeof v==='object'){for(const [k,item] of Object.entries(v))await visit(item,k);return;}
      if(typeof v!=='string'||!/(^|_)(path|file|directory|folder|source|target|destination|oldpath|newpath|cwd|workdir|workingdir|workingdirectory)$/i.test(key))return;
      // A path value must stay within workspace; arbitrary shell statements are
      // not path values and remain subject to interactive approval.
      if(v.length<4097&&v&&!v.includes('\n')){
        // On Linux tests, Windows drive paths are recognized as absolute-like.
        if(process.platform!=='win32'&&/^[a-z]:[\\/]/i.test(v)) throw error('foreign_absolute_path','Không thể kiểm chứng đường dẫn Windows trên máy chủ khác.');
        await this.workspace.resolve(v);
      }
    };
    await visit(args);
  }
  /**
   * What the person sees when asked to approve: the whole command for shell calls, never a truncated prefix. `changes` is the change a file tool would make, drawn from the plan of
   * the call (LocalTools.previewChanges): it goes into the card as `detail.preview` and is masked like every other word of the card. The text of the request (`preview`) is the card without it,
   * so that the history and the pending list stay small. What a protected file would hold is never written into the card, whether or not the call is allowed.
   */
  #describe(name,args,verdict,changes=null){
    const secrets=this.manager?.secrets??[];
    // The summary and the reason can quote the command, so they are masked like the preview.
    const words={summary:maskSecrets(verdict.summary??name,secrets),reason:maskSecrets(verdict.reason??'',secrets)};
    if(!verdict.local)return {...words,preview:maskSecrets(safePreview(args,1800,secrets),secrets),detail:null};
    const input=isObject(args)?args:{};
    const op=String(name).replace(/^local\./i,'');
    const secret=(typeof input.path==='string'&&isProtectedPath(input.path))||changes?.privateKeys===true;
    let detail;
    if(op==='run_command'){
      detail={kind:'command',command:cut(input.command,9000),cwd:input.cwd||'.',shell:verdict.risk?.shell??input.shell??'auto',timeout_seconds:input.timeout_seconds??null,description:input.description??null,assessed_as:verdict.risk?.kind??null,reasons:verdict.risk?.reasons??[]};
    }else if(op==='write_file'){
      detail=secret?{kind:'write',path:input.path,hidden:true}:{kind:'write',path:input.path,bytes:Buffer.byteLength(String(input.content??'')),overwrite:Boolean(input.overwrite),head:cut(input.content,600)};
    }else if(op==='edit_file'&&secret){
      detail={kind:'edit',path:input.path,hidden:true};
    }else if(op==='edit_file'&&Array.isArray(input.edits)){
      detail=editListDetail(input);
    }else if(op==='edit_file'){
      detail={kind:'edit',path:input.path,replace_all:Boolean(input.replace_all),old_string:cut(input.old_string,800),new_string:cut(input.new_string,800)};
    }else if(op==='files_apply_patch'){
      detail=secret?{kind:'edit',path:input.path,hidden:true}:{kind:'edit',path:input.path,replace_all:false,old_string:cut(input.old_text,800),new_string:cut(input.new_text,800)};
    }else if(op==='files_write_batch'&&Array.isArray(input.files)){
      // The paths and the sizes, never the content: what each file would hold is on the card only through the plan, and a protected file's not at all.
      const items=input.files.filter(isObject);
      detail={kind:'batch',count:items.length,files:items.slice(0,50).map((item)=>({path:String(item.path??''),bytes:Buffer.byteLength(String(item.content??'')),overwrite:Boolean(item.overwrite),checked:typeof item.expected_sha256==='string'}))};
    }else if(op==='git_push'&&isObject(verdict.detail)&&verdict.detail.kind==='git_push'){
      // The commits that would be sent, worked out by LocalTools from the repository (lib/git-push.mjs), not the two names the model wrote.
      detail=verdict.detail;
    }else{
      detail={kind:'tool',arguments:safePreview(args,1500,secrets)};
    }
    detail=maskDeep(detail,secrets);
    const text=JSON.stringify(detail);
    if(changes&&FILE_CHANGE_TOOLS.includes(op))detail={...detail,preview:maskDeep(changes,secrets)};
    return {...words,preview:text,detail};
  }
  /** The change a file tool would make, drawn from its plan before anyone is asked; null for any other call, or when it cannot be drawn (the card is then the old card). */
  async #previewChanges(name,args,verdict,signal){
    if(!verdict.local||typeof this.localTools?.previewChanges!=='function')return null;
    if(!FILE_CHANGE_TOOLS.includes(String(name).replace(/^local\./i,'')))return null;
    try{return await this.localTools.previewChanges(name,args,{signal});}
    catch(caught){if(signal?.aborted)throw signal.reason||caught;return null;}
  }
  #refuse(name,args,verdict,taskId,decision,reason){
    const {preview,summary}=this.#describe(name,args,verdict);
    this.#record({id:randomUUID(),taskId,toolName:name,category:verdict.category,reason:maskSecrets(reason,this.manager?.secrets??[]),summary,preview,at:new Date(this.now()).toISOString()},decision);
    return {allowed:false,category:verdict.category,reason};
  }
  /**
   * The decision for one call. `forceAsk` is the only thing a PreToolUse hook can ask of the gate (lib/manager.mjs): a call that
   * would have run without a question becomes a question for the owner. It is checked after every refusal below (a protected file,
   * Read Only, sandbox-only, an unclassified tool in Autonomous, nobody to ask), so it can add a question and never remove one or
   * turn a refusal into an approval; `askReason` is shown with the question. A result with `asked: true` went to the owner.
   */
  async authorize({name,args={},definition={},taskId,signal,forceAsk=false,askReason=''}={}){
    const verdict=await this.assess(name,args,definition,{taskId});
    const {category,reason}=verdict;
    if(signal?.aborted)throw signal.reason || error('cancelled','Tác vụ đã dừng.');
    // Protected files (.env, private keys, .git ...) are never touched and never prompt, in any mode or policy.
    if(category==='blocked')return this.#refuse(name,args,verdict,taskId,'blocked',reason);
    if(args?.isolationRequired){
      return this.#refuse(name,args,verdict,taskId,'policy','Yêu cầu cách ly hệ điều hành (isolationRequired), nhưng lệnh shell host không có cách ly OS. Bị từ chối fail-closed.');
    }
    // Read Only is the strictest choice and wins over Full Access: nothing but reads and bookkeeping runs.
    if(this.mode==='readonly'&&category!=='read'&&category!=='checkpoint')
      return this.#refuse(name,args,verdict,taskId,'policy',`Chế độ Chỉ đọc: ${reason}. Chuyển sang Review hoặc Autonomous nếu muốn cho phép thay đổi.`);
    // Explicit Full Access: run MCP tools with the current Windows account's OS
    // permissions, without Studio workspace checks or per-tool approvals.
    // This never elevates OS privileges, disables Windows ACLs, or grants admin.
    // It does NOT cover what cannot be taken back: deletion, history rewrites, git push, merging a pull request, creating or deleting
    // a release or repository. Those fall through to the ordinary approval below, in every mode.
    const fullAccess=this.executionPolicy==='full-access';
    if(fullAccess&&!forceAsk&&!mustAskEvenInFullAccess(name,verdict)){
      this.#emit({type:'full_access_tool',taskId,toolName:name,category});
      return {allowed:true,category,risk:verdict.risk,local:verdict.local,reason:'Full Access: user explicitly enabled unrestricted host tools'};
    }
    // Full Access stays outside the workspace checks even for the operations it still asks about.
    if(!verdict.local&&!fullAccess)await this.inspectPaths(args,category);
    // STRICT MODE: external MCP tools are not OS-confined (even when they claim
    // readOnlyHint). Allow built-in Studio tools and local file tools only; commands run on the host,
    // so they are refused here as well, even with an approval.
    if(this.executionPolicy==='sandbox-only'){
      if(!verdict.local&&!name.startsWith('studio.'))
        return {allowed:false,category,reason:'Sandbox-only: external MCP không chạy trong Docker sandbox. Chuyển sang host-review nếu muốn dùng Desktop Commander.'};
      if(verdict.local&&(category==='execute'||String(name).toLowerCase()==='local.run_command'))
        return {allowed:false,category,reason:'Sandbox-only: lệnh shell chạy trực tiếp trên máy host nên bị chặn. Chuyển sang host-review để dùng (mỗi lệnh đều cần xác nhận).'};
      // A push is Git on the host talking to the network with the owner's credentials: "ghi/lệnh trên host", which sandbox-only refuses (docs/PHASE1-DESIGN.md).
      if(verdict.local&&/(?:^|\.)git_push$/i.test(String(name)))
        return this.#refuse(name,args,verdict,taskId,'policy','Sandbox-only: git_push chạy Git trên máy host và gửi commit ra ngoài nên bị chặn. Chuyển sang host-review nếu muốn đẩy (mỗi lần đều hỏi).');
    }
    if(!forceAsk&&(category==='read'||category==='checkpoint'||(category==='workspace_edit'&&this.mode==='autonomous')))return {allowed:true,category,risk:verdict.risk,local:verdict.local};
    if(this.mode==='autonomous'&&category==='unknown') return {allowed:false,category,reason:'Chế độ Tự động: công cụ chưa phân loại bị từ chối. Chuyển sang Review nếu muốn được hỏi từng lần.'};
    // A worker or background agent has nobody to answer: refuse at once instead of holding the run for the whole approval timeout.
    if(!this.canAsk()){
      return this.#refuse(name,args,verdict,taskId,'policy',`Ngữ cảnh chạy nền: thao tác này (${reason}) cần người dùng phê duyệt nhưng không có ai để hỏi trong worker/agent nền nên bị từ chối ngay, không chờ ${Math.round(this.timeout/60000)} phút. Hãy tự chạy thao tác này hoặc yêu cầu từ một phiên tương tác.`);
    }
    if(!taskId)throw error('missing_task','Thiếu mã tác vụ khi xin quyền.');
    if(signal?.aborted)throw signal.reason;
    const id=randomUUID();
    // The owner is shown what the call would leave on disk, worked out now from the files as they are; the call that follows the answer is held to it (`guard`).
    const shown=await this.#previewChanges(name,args,verdict,signal);
    if(signal?.aborted)throw signal.reason||error('cancelled','Tác vụ đã dừng.');
    const {preview,detail,summary,reason:describedReason}=this.#describe(name,args,verdict,shown?.preview);
    // A hook that asked for this question says why; the text is the hook's (already cleaned), so it is masked like every other reason.
    const hookReason=forceAsk&&askReason?maskSecrets(`Hook: ${String(askReason).slice(0,500)}`,this.manager?.secrets??[]):'';
    const shownReason=hookReason?(describedReason?`${hookReason} · ${describedReason}`:hookReason):describedReason;
    // `expiresAt` lets the page show how long the request will wait; the timer below is what actually enforces it.
    const askedAt=this.now();
    const request={id,taskId,toolName:name,category,reason:shownReason,summary,preview,detail,at:new Date(askedAt).toISOString(),expiresAt:new Date(askedAt+this.timeout).toISOString()};
    const promise=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.requests.delete(id);this.#record(request,'expired');resolve(false);},this.timeout);
      const aborted=()=>{clearTimeout(timer);this.requests.delete(id);this.#record(request,'cancelled');reject(signal.reason||error('cancelled','Tác vụ đã dừng.'));};
      if(signal)signal.addEventListener('abort',aborted,{once:true});
      this.requests.set(id,{...request,resolve:(yes)=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);this.requests.delete(id);this.#record(request,yes?'approved':'denied');resolve(yes);},abort:aborted});
    });
    this.#emit({type:'approval_requested',...request});
    const yes=await promise;
    return {allowed:yes,category,risk:verdict.risk,local:verdict.local,asked:true,reason:yes?'Đã được người dùng phê duyệt':'Người dùng từ chối hoặc hết hạn phê duyệt',...(yes&&shown?.guard?{guard:shown.guard}:{})};
  }
  #record(request,decision){
    // The audit trail keeps a bounded preview, never the full structured detail.
    const {detail,...rest}=request;
    this.history.push({...rest,preview:String(rest.preview??'').slice(0,HISTORY_PREVIEW_CHARS),decision,decidedAt:new Date(this.now()).toISOString()});
    if(this.history.length>100)this.history.shift();
    const type=decision==='blocked'||decision==='policy'?'tool_'+decision:'approval_'+decision;
    this.#emit({type,id:request.id,taskId:request.taskId,toolName:request.toolName});
    this.#save();
  }
  decide(id,approved){const req=this.requests.get(id);if(!req)throw error('not_pending','Yêu cầu đã hết hạn hoặc không tồn tại.',404);if(typeof approved!=='boolean')throw error('bad_decision','approved phải là boolean.',400);req.resolve(approved);return {ok:true,id,approved};}
  cancelTask(taskId){for(const request of [...this.requests.values()])if(request.taskId===taskId)request.resolve(false);}
  shutdown(){for(const request of [...this.requests.values()])request.resolve(false);}
}
