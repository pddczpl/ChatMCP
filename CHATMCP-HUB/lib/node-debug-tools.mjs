// Local Node inspector debugger (CDP over loopback WebSocket).
// No MCP client, hooks, downloaded debugger, shell command string or exposed network port.
// Python debugpy / native DAP adapters require separate runtime integration.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { scrubEnv, killTree } from './shell-runner.mjs';
import { isProtectedPath } from './protected-paths.mjs';

const O=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const S=(description,extra={})=>({type:'string',description,...extra});
const I=(description,extra={})=>({type:'integer',description,...extra});
const fail=(code,message)=>Object.assign(new Error(message),{code});
const ok=(content)=>({isError:false,content:[{type:'text',text:JSON.stringify(content)}],structuredContent:content});
const SECRET=/(?:^|[^a-z0-9])(?:api_?key|secret|password|passwd|token|credential|private_?key|authorization|cookie|session)(?=$|[^a-z0-9])/i;
const preview=(value,n=500)=>String(value??'').slice(0,n);
export const redactDebugValue=(name,value)=>SECRET.test(String(name))?'[REDACTED]':preview(value,300);
const TIMEOUT=12000;

export class NodeDebugTools {
  constructor({workspace,spawner=spawn,websocket=globalThis.WebSocket,platform=process.platform}={}){
    this.workspace=workspace;
    this.spawner=spawner;
    this.websocket=websocket;
    this.platform=platform;
    this.sessions=new Map();
  }
  #get(taskId) {
    const s=this.sessions.get(taskId);
    if(!taskId||!s)throw fail('debug_not_running','No debugger session for this task.');
    return s;
  }
  async #rpc(s,method,params={},timeout=TIMEOUT){
    if(s.ws.readyState!==1)throw fail('debug_disconnected','Node inspector WebSocket disconnected.');
    const id=++s.id;
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{s.pending.delete(id);reject(fail('debug_timeout','Inspector '+method+' timed out.'));},timeout);
      s.pending.set(id,{resolve,reject,timer});
      try{s.ws.send(JSON.stringify({id,method,params}));}
      catch(error){clearTimeout(timer);s.pending.delete(id);reject(error);}
    });
  }
  async #startChild(program,signal) {
    if(typeof this.websocket!=='function')throw fail('inspector_websocket_missing','Node.js 22+ WebSocket runtime required.');
    const target=await this.workspace.resolve(program);
    if(!target.relative||isProtectedPath(target.relative))throw fail('protected_path','Debug program path is protected.');
    const stat=await fs.stat(target.absolute);
    if(!stat.isFile())throw fail('debug_program_invalid','Debug program must be a regular file.');
    if(!/\.(?:mjs|cjs|js)$/.test(target.relative))throw fail('debug_language_unsupported','Node debugger supports JS/MJS/CJS only.');
    const root=target.root;
    const processArgs=['--inspect-brk=127.0.0.1:0',target.absolute];
    const child=this.spawner(process.execPath,processArgs,{
      cwd:root,env:{...scrubEnv(process.env),NODE_OPTIONS:''},shell:false,
      detached:this.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe'],
    });
    const endpoint=await new Promise((resolve,reject)=>{
      let settled=false,stderr='';
      const stop=(error,url)=>{
        if(settled)return;settled=true;
        clearTimeout(timer);child.stderr.off('data',onData);child.off('error',onError);child.off('exit',onExit);
        signal?.removeEventListener('abort',onAbort);
        if(error)reject(error);else resolve(url);
      };
      const onData=(buffer)=>{
        stderr+=buffer.toString('utf8');
        stderr=stderr.slice(-3000);
        const match=stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+/);
        if(match)stop(null,match[0]);
      };
      const onError=(e)=>stop(fail('debug_spawn_failed',preview(e.message)));
      const onExit=(code)=>stop(fail('debug_spawn_exited','Debugged Node process exited before inspector startup: '+code));
      const onAbort=()=>stop(fail('cancelled','Debug startup cancelled.'));
      const timer=setTimeout(()=>stop(fail('debug_start_timeout','No Node inspector endpoint appeared.')),12000);
      child.stderr.on('data',onData);
      child.once('error',onError);
      child.once('exit',onExit);
      signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted)onAbort();
    }).catch(error=>{killTree(child);throw error;});
    if(!/^ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+$/.test(endpoint)){
      killTree(child);throw fail('debug_endpoint_rejected','Inspector advertised an unsafe endpoint.');
    }
    return {child,endpoint,target};
  }
  async start({program},{taskId,signal}={}) {
    if(!taskId)throw fail('missing_task','Debugger requires a task ID.');
    if(this.sessions.has(taskId))throw fail('debug_already_running','Close the current debugger before starting another.');
    const {child,endpoint,target}=await this.#startChild(program,signal);
    let ws;
    try {
      ws=new this.websocket(endpoint);
      await new Promise((resolve,reject)=>{
        let finished=false;
        const finish=err=>{
          if(finished)return;finished=true;clearTimeout(timer);
          ws.removeEventListener('open',opened);ws.removeEventListener('error',errored);
          if(err)reject(err);else resolve();
        };
        const opened=()=>finish();
        const errored=()=>finish(fail('inspector_connection_failed','Could not attach to Node inspector.'));
        const timer=setTimeout(()=>finish(fail('inspector_connection_timeout','Node inspector WebSocket connection timed out.')),10000);
        ws.addEventListener('open',opened,{once:true});
        ws.addEventListener('error',errored,{once:true});
      });
      const s={child,ws,id:0,pending:new Map(),paused:null,lastEvent:null,program:target.relative,closed:false};
      const receive=event=>{
        let data;
        try{data=JSON.parse(String(event.data));}catch{return;}
        if(data.id!==undefined){
          const p=s.pending.get(data.id);
          if(p){s.pending.delete(data.id);clearTimeout(p.timer);if(data.error)p.reject(fail('inspector_error',preview(data.error.message)));else p.resolve(data.result||{});}
        }
        if(data.method==='Debugger.paused')s.paused=data.params||{};
        if(data.method==='Debugger.resumed')s.paused=null;
        if(data.method)s.lastEvent=data.method;
      };
      const disconnected=()=>{
        s.closed=true;
        for(const p of s.pending.values()){clearTimeout(p.timer);p.reject(fail('inspector_disconnected','Debugger disconnected.'));}
        s.pending.clear();
      };
      ws.addEventListener('message',receive);
      ws.addEventListener('close',disconnected);
      child.once('exit',disconnected);
      this.sessions.set(taskId,s);
      await this.#rpc(s,'Runtime.enable');
      await this.#rpc(s,'Debugger.enable');
      await this.#rpc(s,'Runtime.runIfWaitingForDebugger');
      return ok({running:true,program:target.relative,adapter:'node-inspector',loopback:true,initialPausePending:true});
    }catch(error){
      try{ws?.close();}catch{}
      killTree(child);
      this.sessions.delete(taskId);
      throw error;
    }
  }
  async breakpoint({file,line,column=1},{taskId}={}) {
    const s=this.#get(taskId);
    const target=await this.workspace.resolve(file);
    if(!target.relative||isProtectedPath(target.relative))throw fail('protected_path','Breakpoint path protected.');
    if(!Number.isInteger(line)||line<1)throw fail('bad_line','Line is 1-based.');
    const result=await this.#rpc(s,'Debugger.setBreakpointByUrl',{
      url:pathToFileURL(target.absolute).href,lineNumber:line-1,columnNumber:column-1,
    });
    return ok({breakpointId:result.breakpointId,locations:result.locations||[],file:target.relative,line});
  }
  async continueTask({taskId}={}) {
    const s=this.#get(taskId);
    if(!s.paused)throw fail('debug_not_paused','Debugger is not paused; inspect status before resuming.');
    await this.#rpc(s,'Debugger.resume');
    return ok({resumed:true});
  }
  async step({mode='over'},{taskId}={}) {
    const s=this.#get(taskId);
    if(!s.paused)throw fail('debug_not_paused','Debugger must be paused before stepping.');
    await this.#rpc(s,({into:'Debugger.stepInto',over:'Debugger.stepOver',out:'Debugger.stepOut'})[mode]);
    return ok({step:mode,requested:true});
  }
  stack({taskId}={}) {
    const s=this.#get(taskId);
    const frames=(s.paused?.callFrames||[]).slice(0,30).map((f,i)=>({
      index:i,functionName:preview(f.functionName,120),
      url:preview(f.url,500),line:(f.location?.lineNumber??0)+1,
      column:(f.location?.columnNumber??0)+1,scopeCount:f.scopeChain?.length??0
    }));
    return ok({running:!s.closed,paused:Boolean(s.paused),reason:s.paused?.reason||null,frames});
  }
  async variables({frame=0,scope=0},{taskId}={}) {
    const s=this.#get(taskId);
    const target=s.paused?.callFrames?.[frame]?.scopeChain?.[scope]?.object?.objectId;
    if(!target)throw fail('debug_scope_unavailable','Paused frame/scope not available.');
    const data=await this.#rpc(s,'Runtime.getProperties',{objectId:target,ownProperties:true,accessorPropertiesOnly:false});
    const values=(data.result||[]).slice(0,60).map(x=>({
      name:preview(x.name,100),type:x.value?.type||null,
      value:redactDebugValue(x.name,x.value?.value??x.value?.description??''),
      writable:!!x.writable,
    }));
    return ok({frame,scope,values,truncated:(data.result?.length||0)>60});
  }
  async evaluate({expression,frame=0},{taskId}={}) {
    const s=this.#get(taskId);
    const callFrameId=s.paused?.callFrames?.[frame]?.callFrameId;
    if(!callFrameId)throw fail('debug_not_paused','Evaluate requires a paused stack frame.');
    if(!expression||expression.length>1200)throw fail('bad_expression','Expression must be 1-1200 characters.');
    if(/\bprocess\s*\.\s*env\b|\bglobalThis\s*\.\s*process\b/i.test(expression))
      throw fail('protected_debug_expression','Reading environment credentials through the debugger is prohibited.');
    // Runtime requests side-effect-free evaluation; PermissionGate still treats this as dangerous.
    const result=await this.#rpc(s,'Debugger.evaluateOnCallFrame',{
      callFrameId,expression,returnByValue:true,throwOnSideEffect:true,timeout:1500,
    });
    return ok({type:result.result?.type,
      value:preview(result.result?.value??result.result?.description??'',800),
      exception:Boolean(result.exceptionDetails),sideEffectsProhibited:true});
  }
  async stop({taskId}={}) {
    const s=this.#get(taskId);
    this.sessions.delete(taskId);
    s.closed=true;
    try{s.ws.close();}catch{}
    killTree(s.child);
    return ok({stopped:true,program:s.program});
  }
  async close() {
    for(const taskId of [...this.sessions.keys()])await this.stop({taskId}).catch(()=>{});
  }
  definitions(define) {
    const make=(name,description,schema,category,run)=>define(name,{
      description,schema,category,annotations:{readOnlyHint:category==='read',destructiveHint:category==='dangerous'},
      reason:category==='dangerous'?'Debugger may execute expressions or terminate a running process':
        category==='execute'?'Run or resume local JavaScript under Node inspector':'Inspect paused Node process',
      summary:()=>name,run,
    });
    make('debug_start','Start a Node.js .js/.mjs/.cjs program under the local inspector, paused on entry. Requires user execution approval.',
      O({program:S('Workspace-relative JavaScript entry file.')},['program']),'execute',(a,ctx)=>this.start(a,ctx));
    make('debug_breakpoint','Set a real Node inspector breakpoint by source URL and 1-based line number.',
      O({file:S('Source path under workspace.'),line:I('1-based line.',{minimum:1}),column:I('1-based column.',{minimum:1})},['file','line']),
      'checkpoint',(a,ctx)=>this.breakpoint(a,ctx));
    make('debug_continue','Resume a paused Node inspector program. Code will execute.',
      O({}),'execute',(_a,ctx)=>this.continueTask(ctx));
    make('debug_step','Single-step a paused Node inspector program (into, over, out). Code will execute.',
      O({mode:S('Step direction.',{enum:['into','over','out']})}),'execute',(a,ctx)=>this.step(a,ctx));
    make('debug_stack','Read paused JavaScript stack frames without variable contents.',
      O({}),'read',(_a,ctx)=>this.stack(ctx));
    make('debug_variables','Read bounded variable previews from a paused frame/scope. Sensitive-looking variable names are masked.',
      O({frame:I('Frame index.',{minimum:0}),scope:I('Scope index.',{minimum:0})}),'read',(a,ctx)=>this.variables(a,ctx));
    make('debug_evaluate','Evaluate an expression in a paused frame with side effects prohibited. Requires dangerous-operation approval.',
      O({expression:S('JavaScript expression to evaluate.',{maxLength:1200}),frame:I('Frame index.',{minimum:0})},['expression']),
      'dangerous',(a,ctx)=>this.evaluate(a,ctx));
    make('debug_stop','Close inspector and terminate the task-owned debugger process. Requires approval.',
      O({}),'dangerous',(_a,ctx)=>this.stop(ctx));
  }
}
export function registerDebugTools(define,context) {const group=new NodeDebugTools(context);group.definitions(define);return group;}
