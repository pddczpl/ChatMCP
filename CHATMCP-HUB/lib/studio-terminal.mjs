import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StudioSandbox } from './studio-sandbox.mjs';
const fault=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const stamp=()=>new Date().toISOString();
export class StudioTerminal {
  // `spawner`/`childEnv`/`restrict` are for the public server: commands go through the command broker (another account), run with an
  // allow-listed environment, in a non-interactive shell, for a bounded time. restrict = {disabled?: string, maxTimeoutMinutes, shellFile}.
  constructor({workspace,maxSessions=3,sandbox,ptyLoader,spawner=spawn,childEnv=null,restrict=null}={}) { this.spawner=spawner;this.childEnv=childEnv;this.restrict=restrict;this.workspace=workspace;this.sessions=new Map();this.maxSessions=maxSessions;this.onEvent=()=>{};this.listeners=new Set();this.sandbox=sandbox??new StudioSandbox({workspace});this.ptyLoader=ptyLoader??(()=>import('node-pty'));this.ptyState=null; }
  // The optional node-pty package can be present as JavaScript while its native
  // binding is missing or was built for another Node ABI. Importing it is not
  // enough: prove it works with one short-lived spawn and remember the result.
  async #loadPty(){
    if(this.ptyState)return this.ptyState;
    let state;
    try{
      const lib=await this.ptyLoader();
      if(typeof lib?.spawn!=='function')throw new Error('node-pty không xuất hàm spawn.');
      const win=process.platform==='win32';
      const probe=lib.spawn(win?(process.env.ComSpec||'cmd.exe'):'/bin/sh',win?['/d','/c','exit','0']:['-c','exit 0'],{name:'xterm-256color',cols:20,rows:5,cwd:os.tmpdir(),env:process.env});
      try{probe.kill();}catch{}
      state={lib,error:null,missing:false};
    }catch(error){
      // ERR_MODULE_NOT_FOUND = the package is not installed at all; any other
      // failure (for example a missing native .node file) means it is installed but unusable.
      state={lib:null,error:String(error?.message??error).split('\n')[0].slice(0,200),missing:error?.code==='ERR_MODULE_NOT_FOUND'};
    }
    this.ptyState=state;return state;
  }
  async capabilities(){
    const pty=await this.#loadPty();
    const note=pty.lib?'Native PTY module available':pty.missing?'Install optional node-pty for full TTY semantics on Windows':`node-pty đã cài nhưng không chạy được (${pty.error}); đang dùng pipes. Chạy lại windows\\Install-OptionalConPTY.ps1 hoặc bỏ qua.`;
    return {platform:process.platform,interactivePipes:true,nativeConPTY:process.platform==='win32'&&Boolean(pty.lib),ansiTerminalEmulator:false,sandboxedTests:true,note};
  }
  subscribe(listener){if(typeof listener!=='function')throw fault('Callback không hợp lệ.');this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  emit(event){this.onEvent(event);for(const callback of this.listeners){try{callback(event);}catch{}}}
  state(){return [...this.sessions.values()].map(({id,command,createdAt,status,exitCode,logs,mode,interactive,sequence})=>({id,command,createdAt,status,exitCode,mode,interactive,sequence,logs:logs.slice(-150)})).slice(-20);}
  async start({command='',timeoutMinutes=5,interactive=false,sandbox=false,image}={}) {
    if(this.restrict?.disabled)throw fault(this.restrict.disabled,403);
    if(this.restrict&&(interactive||sandbox))throw fault('Terminal tương tác và Docker sandbox không có ở chế độ công khai.',403);
    if(typeof command!=='string'||command.length>8000 ||(!interactive&&!command.trim()))throw fault('Lệnh terminal trống hoặc quá 8000 ký tự.');
    if(sandbox && interactive)throw fault('Docker sandbox không hỗ trợ terminal tương tác trong bản này; hãy chạy một lệnh kiểm thử.',409);
    const running=[...this.sessions.values()].filter(s=>s.status==='running');if(running.length>=this.maxSessions)throw fault('Có quá nhiều terminal đang chạy.',409);
    const cwd=this.workspace.requireRoot(),id=randomUUID(),win=process.platform==='win32';
    let child,pty=null,sandboxName=null,mode=sandbox?'docker-readonly':interactive?'pipes':'host';
    if(sandbox){
      const check=await this.sandbox.status();if(!check.ready)throw fault(`Docker sandbox chưa sẵn sàng: ${check.detail}. Kiểm tra Docker Desktop và image ${image||'python:3.11-slim'} đã pull trước.`,503);
      const started=await this.sandbox.launch({command,image});child=started.child;sandboxName=started.name;
    } else if(interactive) {
      // Real Windows ConPTY is used only when optional native node-pty is
      // installed for the Windows Node version. Do not pretend pipes are PTY.
      const shell=win?(process.env.SystemRoot?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):'powershell.exe'):(process.env.SHELL||'/bin/sh');
      const args=win?['-NoLogo','-NoProfile']:['-i'];
      const {lib:ptyLib}=await this.#loadPty();
      if(ptyLib){
        try{pty=ptyLib.spawn(shell,args,{name:'xterm-256color',cols:100,rows:28,cwd,env:{...process.env,CHATMCP_WORKSPACE:cwd}});mode='conpty';}
        catch(error){pty=null;this.ptyState={lib:null,error:String(error?.message??error).split('\n')[0].slice(0,200),missing:false};}
      }
      if(!pty)child=spawn(shell,win?['-NoLogo','-NoProfile','-NonInteractive','-Command','-']:[],{cwd,windowsHide:true,shell:false,detached:!win,stdio:['pipe','pipe','pipe'],env:{...process.env,CHATMCP_WORKSPACE:cwd}});
    } else {
      const shell=win?(process.env.SystemRoot?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):'powershell.exe'):(this.restrict?.shellFile||process.env.SHELL||'/bin/sh');
      const args=win?['-NoLogo','-NoProfile','-NonInteractive','-Command',command]:['-c',command];
      child=this.spawner(shell,args,{cwd,windowsHide:true,shell:false,detached:!win,stdio:['ignore','pipe','pipe'],env:this.childEnv?this.childEnv(cwd):{...process.env,CHATMCP_WORKSPACE:cwd},...(this.spawner===spawn?{}:{timeout:Math.max(.01,Math.min(this.restrict?.maxTimeoutMinutes??120,Number(timeoutMinutes)||5))*60000+5000})});
    }
    // On POSIX the shell is started as its own process-group leader (detached) so stop() can signal the whole tree.
    const session={id,command,createdAt:stamp(),status:'running',exitCode:null,logs:[],child,pty,mode,interactive,sandboxName,timer:null,bytes:0,sequence:0,groupLeader:!win&&!sandboxName&&!pty&&Boolean(child)&&!child.brokered};this.sessions.set(id,session);
    // Resolves when the process has really exited (or failed to start), so close() can wait for it.
    let markExited;session.exited=new Promise(resolve=>{markExited=resolve;});
    const add=(type,buf)=>{
      const message=String(buf).slice(0,10000);session.bytes+=Buffer.byteLength(String(buf));
      if(session.bytes>6*1024*1024){session.status='stopping';this.stop(id);return;}
      const record={seq:++session.sequence,at:stamp(),type,message};session.logs.push(record);
      if(session.logs.length>300)session.logs.shift();this.emit({type:'terminal_output',id,stream:type,message:message.slice(0,800)});
    };
    if(pty){pty.onData(v=>add('stdout',v));pty.onExit(({exitCode})=>{clearTimeout(session.timer);session.status=session.status==='stopping'?'stopped':exitCode===0?'completed':'failed';session.exitCode=exitCode;this.emit({type:'terminal_finished',id,code:exitCode});markExited();});}
    else {
      child.stdin?.on('error',e=>add('system',`stdin closed: ${e.message}`));
      child.stdout?.on('data',v=>add('stdout',v.toString('utf8')));child.stderr?.on('data',v=>add('stderr',v.toString('utf8')));
      child.on('error',e=>{session.status='failed';add('system',e.message);if(!child.pid)markExited();});
      child.on('close',(code,signal)=>{clearTimeout(session.timer);session.status=session.status==='stopping'?'stopped':code===0?'completed':'failed';session.exitCode=code;this.emit({type:'terminal_finished',id,code,signal});markExited();});
    }
    if(interactive && command.trim())this.write(id,command+'\n');
    timeoutMinutes=Math.max(.01,Math.min(this.restrict?.maxTimeoutMinutes??120,Number(timeoutMinutes)||5));
    session.timer=setTimeout(()=>this.stop(id),timeoutMinutes*60000);session.timer.unref?.();
    return {id,command,status:'running',mode,interactive};
  }
  write(id,text){
    const x=this.sessions.get(id);if(!x)throw fault('Terminal không tồn tại.',404);
    if(!x.interactive||x.status!=='running')throw fault('Phiên terminal không tương tác hoặc đã dừng.',409);
    if(typeof text!=='string'||!text||Buffer.byteLength(text)>4000)throw fault('Dữ liệu nhập terminal quá lớn.',413);
    if(x.pty)x.pty.write(text);else if(x.child?.stdin?.writable)x.child.stdin.write(text);else throw fault('stdin terminal đã đóng.',409);
    return {ok:true,id,acceptedBytes:Buffer.byteLength(text)};
  }
  resize(id,{cols,rows}={}){
    const x=this.sessions.get(id);if(!x)throw fault('Terminal không tồn tại.',404);
    if(!x.pty)return {id,resized:false,reason:'ConPTY không có; chạy bằng pipes'};
    cols=Number(cols);rows=Number(rows);
    if(!Number.isInteger(cols)||cols<20||cols>300||!Number.isInteger(rows)||rows<5||rows>120)throw fault('Kích thước terminal không hợp lệ.');
    x.pty.resize(cols,rows);return {id,resized:true};
  }
  stop(id){const x=this.sessions.get(id);if(!x)throw fault('Terminal không tồn tại.',404);
    if(x.status==='running'){
      x.status='stopping';if(x.sandboxName)this.sandbox.stop(x.sandboxName);
      if(x.pty)x.pty.kill();else if(process.platform==='win32'&&x.child?.pid){const killer=spawn('taskkill.exe',['/PID',String(x.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',()=>x.child.kill());}
      else this.#signal(x,'SIGTERM');
    }return {id,status:x.status};
  }
  // POSIX: signal the whole process group so grandchildren (npm, dev servers, test runners)
  // do not survive the shell. Falls back to the direct child when no group exists.
  #signal(x,signal){
    if(!x.child)return;
    try{
      if(x.groupLeader&&x.child.pid)process.kill(-x.child.pid,signal);else x.child.kill(signal);
    }catch{try{x.child.kill(signal);}catch{}}
  }
  // Stops every running session and waits (bounded) for the processes to exit so
  // callers can safely remove the workspace afterwards (Windows keeps the cwd locked).
  // Processes that ignore the polite stop are killed forcefully after graceMs.
  async close({graceMs=5000}={}){
    const waiting=[];
    for(const x of this.sessions.values()){
      if(x.status==='running')this.stop(x.id);
      if(x.status==='stopping')waiting.push(x.exited);
    }
    if(waiting.length){
      const within=async(ms)=>{let timer;const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);timer.unref?.();});const done=Promise.allSettled(waiting).then(()=>true);try{return await Promise.race([done,timeout]);}finally{clearTimeout(timer);}};
      if(!await within(graceMs)){
        for(const x of this.sessions.values())if(x.status==='stopping'){try{if(x.pty)x.pty.kill();else this.#signal(x,'SIGKILL');}catch{}}
        await within(1500);
      }
    }
    await this.sandbox.close();
  }
}
