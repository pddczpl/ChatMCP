import { writeJson, readJson, redact as redactSecrets } from './runtime.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SENSITIVE=/\b(?:rm\b|del\b|rmdir\b|Remove-Item|format\b|diskpart\b|reg\s+(?:add|delete)|sc\s+(?:delete|stop)|shutdown\b|reboot\b|curl\b.*(?:\||-o)|Invoke-WebRequest|Invoke-Expression|iex\b|Set-ExecutionPolicy|git\s+push|git\s+reset\s+--hard|git\s+clean|chmod\s+777)\b/i;
const READ=/\b(?:read|list|search|find|browse|stat|info|status|get|describe|inspect|query|diff|diagnostic)\b/i;
const MUTATE=/\b(?:write|edit|replace|patch|move|rename|create|update|add|delete|remove|save|insert|commit|upload|run|execute|install|start_process|spawn|terminal|bash|powershell|execute_code|push|publish)\b/i;
const SECRET_KEYS=/authorization|secret|password|token|api.?key|private.?key/i;
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

export class PermissionGate {
  constructor({ manager, workspace, directory=null, now=()=>Date.now(), timeout=10*60*1000 }){
    this.manager=manager;this.workspace=workspace;this.now=now;this.timeout=timeout;
    this.mode='review';this.executionPolicy='host-review';this.requests=new Map();this.history=[];this.onEvent=()=>{};this.file=directory?path.join(directory,'permission-history.json'):null;this.writes=Promise.resolve();
  }
  async load(){if(this.file){const saved=await readJson(this.file);if(saved?.mode&&['review','manual','autonomous'].includes(saved.mode))this.mode=saved.mode;if(['host-review','sandbox-only','full-access'].includes(saved?.executionPolicy))this.executionPolicy=saved.executionPolicy;if(Array.isArray(saved?.history))this.history=saved.history.slice(-100);}}
  #save(){if(!this.file)return;this.writes=this.writes.catch(()=>{}).then(()=>writeJson(this.file,{mode:this.mode,executionPolicy:this.executionPolicy,history:this.history.slice(-100)}));this.writes.catch(()=>{});}
  state(){return {mode:this.mode,executionPolicy:this.executionPolicy,fullAccess:this.executionPolicy==='full-access',pending:[...this.requests.values()].map(({id,taskId,toolName,category,reason,preview,at})=>({id,taskId,toolName,category,reason,preview,at})),recent:this.history.slice(-60)};}
  configure({mode,executionPolicy,confirmation}={}){
    if(mode!==undefined&&!['review','manual','autonomous'].includes(mode))throw error('bad_mode','Chế độ phải là review, manual hoặc autonomous.',400);
    if(executionPolicy!==undefined&&!['host-review','sandbox-only','full-access'].includes(executionPolicy))throw error('bad_policy','Chính sách sandbox không hợp lệ.',400);
    if(executionPolicy==='full-access' && this.executionPolicy!=='full-access' && confirmation!=='FULL ACCESS') throw error('full_access_confirmation_required','Nhập chính xác FULL ACCESS để cho phép agent đọc/sửa file ngoài workspace, sử dụng Internet và chạy công cụ nguy hiểm với quyền Windows hiện tại.',403);
    if(mode!==undefined)this.mode=mode;
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
  async inspectPaths(args,category){
    if(!['workspace_edit','dangerous','execute','unknown'].includes(category))return;
    if(!this.workspace?.root)return;
    const visit=async(v,key='')=>{
      if(v&&typeof v==='object'){for(const [k,item] of Object.entries(v))await visit(item,k);return;}
      if(typeof v!=='string'||!/(^|_)(path|file|directory|folder|source|target|destination|oldpath|newpath)$/i.test(key))return;
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
  async authorize({name,args={},definition={},taskId,signal}={}){
    const {category,reason}=this.classify(name,args,definition);
    if(signal?.aborted)throw signal.reason || error('cancelled','Tác vụ đã dừng.');
    // Explicit Full Access: run MCP tools with the current Windows account's OS
    // permissions, without Studio workspace checks or per-tool approvals.
    // This never elevates OS privileges, disables Windows ACLs, or grants admin.
    if(this.executionPolicy==='full-access'){
      this.onEvent({type:'full_access_tool',taskId,toolName:name,category});
      return {allowed:true,category,reason:'Full Access: user explicitly enabled unrestricted host tools'};
    }
    await this.inspectPaths(args,category);
    // STRICT MODE: external MCP tools are not OS-confined (even when they claim
    // readOnlyHint). Allow built-in read-only Studio tools only; block all
    // external tool executions or edits, even with an approval.
    if(this.executionPolicy==='sandbox-only' && !name.startsWith('studio.'))
      return {allowed:false,category,reason:'Sandbox-only: external MCP không chạy trong Docker sandbox. Chuyển sang host-review nếu muốn dùng Desktop Commander.'};
    if(category==='read'||category==='checkpoint'||(category==='workspace_edit'&&this.mode==='autonomous'))return {allowed:true,category};
    if(this.mode==='autonomous'&&category==='unknown') return {allowed:false,category,reason:'Unknown tool requires approval even in autonomous mode'};
    if(!taskId)throw error('missing_task','Thiếu mã tác vụ khi xin quyền.');
    if(signal?.aborted)throw signal.reason;
    const id=randomUUID();const request={id,taskId,toolName:name,category,reason,preview:safePreview(args,1800,this.manager?.secrets??[]),at:new Date(this.now()).toISOString()};
    const promise=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.requests.delete(id);this.#record(request,'expired');resolve(false);},this.timeout);
      const aborted=()=>{clearTimeout(timer);this.requests.delete(id);this.#record(request,'cancelled');reject(signal.reason||error('cancelled','Tác vụ đã dừng.'));};
      if(signal)signal.addEventListener('abort',aborted,{once:true});
      this.requests.set(id,{...request,resolve:(yes)=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);this.requests.delete(id);this.#record(request,yes?'approved':'denied');resolve(yes);},abort:aborted});
    });
    this.onEvent({type:'approval_requested',...request});
    const yes=await promise;
    return {allowed:yes,category,reason:yes?'Đã được người dùng phê duyệt':'Người dùng từ chối hoặc hết hạn phê duyệt'};
  }
  #record(request,decision){this.history.push({...request,decision,decidedAt:new Date(this.now()).toISOString()});if(this.history.length>100)this.history.shift();this.onEvent({type:'approval_'+decision,id:request.id,taskId:request.taskId,toolName:request.toolName});this.#save();}
  decide(id,approved){const req=this.requests.get(id);if(!req)throw error('not_pending','Yêu cầu đã hết hạn hoặc không tồn tại.',404);if(typeof approved!=='boolean')throw error('bad_decision','approved phải là boolean.',400);req.resolve(approved);return {ok:true,id,approved};}
  cancelTask(taskId){for(const request of [...this.requests.values()])if(request.taskId===taskId)request.resolve(false);}
  shutdown(){for(const request of [...this.requests.values()])request.resolve(false);}
}
