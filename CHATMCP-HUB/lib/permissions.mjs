import { writeJson, readJson, redact as redactSecrets } from './runtime.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Modes (what the agent may do without asking):
//   readonly    - reads and bookkeeping only; every change is refused without a prompt
//   review      - reads run; every change asks the user (legacy name: "manual")
//   autonomous  - file edits and known-safe verification commands run; execution, deletion and unknown tools still ask
export const PERMISSION_MODES = Object.freeze(['readonly', 'review', 'autonomous']);
const MODE_ALIASES = Object.freeze({ manual: 'review' });
const EXECUTION_POLICIES = Object.freeze(['host-review', 'sandbox-only', 'full-access']);
const normalizeMode = (value) => { const mode = MODE_ALIASES[value] ?? value; return PERMISSION_MODES.includes(mode) ? mode : null; };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const READ=/\b(?:read|list|search|find|browse|stat|info|status|get|describe|inspect|query|diff|diagnostic)\b/i;
const MUTATE=/\b(?:write|edit|replace|patch|move|rename|create|update|add|delete|remove|save|insert|commit|upload|run|execute|install|start_process|spawn|terminal|bash|powershell|execute_code|push|publish)\b/i;
const SECRET_KEYS=/authorization|secret|password|token|api.?key|private.?key/i;

// Best-effort masking of credentials that were not registered as secrets (previews are shown in the UI
// and kept in the audit history). Registered secrets are always replaced exactly.
const TOKEN_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]'],
  [/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\b\s*[=:]\s*)(["']?)[^\s"'&]{6,}\2/gi, '$1$2[REDACTED]$2'],
  [/(\/\/[^\s/:@]+:)[^\s/@]{3,}(@)/g, '$1[REDACTED]$2'],
];
export function maskSecrets(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  for (const [pattern, replacement] of TOKEN_PATTERNS) text = text.replace(pattern, replacement);
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
const HISTORY_PREVIEW_CHARS = 2000;

export class PermissionGate {
  constructor({ manager, workspace, directory=null, now=()=>Date.now(), timeout=10*60*1000 }){
    this.manager=manager;this.workspace=workspace;this.now=now;this.timeout=timeout;
    this.mode='review';this.executionPolicy='host-review';this.requests=new Map();this.history=[];this.onEvent=()=>{};this.listeners=new Set();this.file=directory?path.join(directory,'permission-history.json'):null;this.writes=Promise.resolve();
    this.localTools=null;
  }
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
  state(){return {mode:this.mode,modes:[...PERMISSION_MODES],executionPolicy:this.executionPolicy,fullAccess:this.executionPolicy==='full-access',pending:[...this.requests.values()].map(({id,taskId,toolName,category,reason,summary,preview,detail,at})=>({id,taskId,toolName,category,reason,summary,preview,detail,at})),recent:this.history.slice(-60)};}
  configure({mode,executionPolicy,confirmation}={}){
    let nextMode;
    if(mode!==undefined){nextMode=normalizeMode(mode);if(!nextMode)throw error('bad_mode','Chế độ phải là readonly (chỉ đọc), review hoặc autonomous.',400);}
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
  async assess(name,args={},definition={}){
    if(String(name).toLowerCase().startsWith('local.')&&this.localTools?.has(name)){
      const verdict=await this.localTools.assess(name,args);
      return {category:verdict.category,reason:verdict.reason||'Công cụ local',summary:verdict.summary,risk:verdict.risk,local:true};
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
  /** What the person sees when asked to approve: the whole command for shell calls, never a truncated prefix. */
  #describe(name,args,verdict){
    const secrets=this.manager?.secrets??[];
    // The summary and the reason can quote the command, so they are masked like the preview.
    const words={summary:maskSecrets(verdict.summary??name,secrets),reason:maskSecrets(verdict.reason??'',secrets)};
    if(!verdict.local)return {...words,preview:maskSecrets(safePreview(args,1800,secrets),secrets),detail:null};
    const input=isObject(args)?args:{};
    const op=String(name).replace(/^local\./i,'');
    let detail;
    if(op==='run_command'){
      detail={kind:'command',command:cut(input.command,9000),cwd:input.cwd||'.',shell:verdict.risk?.shell??input.shell??'auto',timeout_seconds:input.timeout_seconds??null,description:input.description??null,assessed_as:verdict.risk?.kind??null,reasons:verdict.risk?.reasons??[]};
    }else if(op==='write_file'){
      detail={kind:'write',path:input.path,bytes:Buffer.byteLength(String(input.content??'')),overwrite:Boolean(input.overwrite),head:cut(input.content,600)};
    }else if(op==='edit_file'){
      detail={kind:'edit',path:input.path,replace_all:Boolean(input.replace_all),old_string:cut(input.old_string,800),new_string:cut(input.new_string,800)};
    }else{
      detail={kind:'tool',arguments:safePreview(args,1500,secrets)};
    }
    detail=maskDeep(detail,secrets);
    return {...words,preview:JSON.stringify(detail),detail};
  }
  #refuse(name,args,verdict,taskId,decision,reason){
    const {preview,summary}=this.#describe(name,args,verdict);
    this.#record({id:randomUUID(),taskId,toolName:name,category:verdict.category,reason:maskSecrets(reason,this.manager?.secrets??[]),summary,preview,at:new Date(this.now()).toISOString()},decision);
    return {allowed:false,category:verdict.category,reason};
  }
  async authorize({name,args={},definition={},taskId,signal}={}){
    const verdict=await this.assess(name,args,definition);
    const {category,reason}=verdict;
    if(signal?.aborted)throw signal.reason || error('cancelled','Tác vụ đã dừng.');
    // Protected files (.env, private keys, .git ...) are never touched and never prompt, in any mode or policy.
    if(category==='blocked')return this.#refuse(name,args,verdict,taskId,'blocked',reason);
    // Read Only is the strictest choice and wins over Full Access: nothing but reads and bookkeeping runs.
    if(this.mode==='readonly'&&category!=='read'&&category!=='checkpoint')
      return this.#refuse(name,args,verdict,taskId,'policy',`Chế độ Chỉ đọc: ${reason}. Chuyển sang Review hoặc Autonomous nếu muốn cho phép thay đổi.`);
    // Explicit Full Access: run MCP tools with the current Windows account's OS
    // permissions, without Studio workspace checks or per-tool approvals.
    // This never elevates OS privileges, disables Windows ACLs, or grants admin.
    if(this.executionPolicy==='full-access'){
      this.#emit({type:'full_access_tool',taskId,toolName:name,category});
      return {allowed:true,category,risk:verdict.risk,local:verdict.local,reason:'Full Access: user explicitly enabled unrestricted host tools'};
    }
    if(!verdict.local)await this.inspectPaths(args,category);
    // STRICT MODE: external MCP tools are not OS-confined (even when they claim
    // readOnlyHint). Allow built-in Studio tools and local file tools only; commands run on the host,
    // so they are refused here as well, even with an approval.
    if(this.executionPolicy==='sandbox-only'){
      if(!verdict.local&&!name.startsWith('studio.'))
        return {allowed:false,category,reason:'Sandbox-only: external MCP không chạy trong Docker sandbox. Chuyển sang host-review nếu muốn dùng Desktop Commander.'};
      if(verdict.local&&(category==='execute'||String(name).toLowerCase()==='local.run_command'))
        return {allowed:false,category,reason:'Sandbox-only: lệnh shell chạy trực tiếp trên máy host nên bị chặn. Chuyển sang host-review để dùng (mỗi lệnh đều cần xác nhận).'};
    }
    if(category==='read'||category==='checkpoint'||(category==='workspace_edit'&&this.mode==='autonomous'))return {allowed:true,category,risk:verdict.risk,local:verdict.local};
    if(this.mode==='autonomous'&&category==='unknown') return {allowed:false,category,reason:'Unknown tool requires approval even in autonomous mode'};
    if(!taskId)throw error('missing_task','Thiếu mã tác vụ khi xin quyền.');
    if(signal?.aborted)throw signal.reason;
    const id=randomUUID();const {preview,detail,summary,reason:shownReason}=this.#describe(name,args,verdict);
    const request={id,taskId,toolName:name,category,reason:shownReason,summary,preview,detail,at:new Date(this.now()).toISOString()};
    const promise=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.requests.delete(id);this.#record(request,'expired');resolve(false);},this.timeout);
      const aborted=()=>{clearTimeout(timer);this.requests.delete(id);this.#record(request,'cancelled');reject(signal.reason||error('cancelled','Tác vụ đã dừng.'));};
      if(signal)signal.addEventListener('abort',aborted,{once:true});
      this.requests.set(id,{...request,resolve:(yes)=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);this.requests.delete(id);this.#record(request,yes?'approved':'denied');resolve(yes);},abort:aborted});
    });
    this.#emit({type:'approval_requested',...request});
    const yes=await promise;
    return {allowed:yes,category,risk:verdict.risk,local:verdict.local,reason:yes?'Đã được người dùng phê duyệt':'Người dùng từ chối hoặc hết hạn phê duyệt'};
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
