import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StudioSandbox } from './studio-sandbox.mjs';
const fault=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const stamp=()=>new Date().toISOString();
export class StudioTerminal {
  constructor({workspace,maxSessions=3,sandbox}={}) { this.workspace=workspace;this.sessions=new Map();this.maxSessions=maxSessions;this.onEvent=()=>{};this.listeners=new Set();this.sandbox=sandbox??new StudioSandbox({workspace}); }
  async capabilities(){
    let nativePty=false;
    try{const pty=await import('node-pty');nativePty=typeof pty.spawn==='function';}catch{}
    return {platform:process.platform,interactivePipes:true,nativeConPTY:process.platform==='win32'&&nativePty,ansiTerminalEmulator:false,sandboxedTests:true,note:nativePty?'Native PTY module available':'Install optional node-pty for full TTY semantics on Windows'};
  }
  subscribe(listener){if(typeof listener!=='function')throw fault('Callback không hợp lệ.');this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  emit(event){this.onEvent(event);for(const callback of this.listeners){try{callback(event);}catch{}}}
  state(){return [...this.sessions.values()].map(({id,command,createdAt,status,exitCode,logs,mode,interactive,sequence})=>({id,command,createdAt,status,exitCode,mode,interactive,sequence,logs:logs.slice(-150)})).slice(-20);}
  async start({command='',timeoutMinutes=5,interactive=false,sandbox=false,image}={}) {
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
      let ptyLib;
      try{ptyLib=await import('node-pty');}catch{}
      if(ptyLib?.spawn){pty=ptyLib.spawn(shell,args,{name:'xterm-256color',cols:100,rows:28,cwd,env:{...process.env,CHATMCP_WORKSPACE:cwd}});mode='conpty';}
      else child=spawn(shell,win?['-NoLogo','-NoProfile','-NonInteractive','-Command','-']:[],{cwd,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,CHATMCP_WORKSPACE:cwd}});
    } else {
      const shell=win?(process.env.SystemRoot?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):'powershell.exe'):(process.env.SHELL||'/bin/sh');
      const args=win?['-NoLogo','-NoProfile','-NonInteractive','-Command',command]:['-c',command];
      child=spawn(shell,args,{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,CHATMCP_WORKSPACE:cwd}});
    }
    const session={id,command,createdAt:stamp(),status:'running',exitCode:null,logs:[],child,pty,mode,interactive,sandboxName,timer:null,bytes:0,sequence:0};this.sessions.set(id,session);
    const add=(type,buf)=>{
      const message=String(buf).slice(0,10000);session.bytes+=Buffer.byteLength(String(buf));
      if(session.bytes>6*1024*1024){session.status='stopping';this.stop(id);return;}
      const record={seq:++session.sequence,at:stamp(),type,message};session.logs.push(record);
      if(session.logs.length>300)session.logs.shift();this.emit({type:'terminal_output',id,stream:type,message:message.slice(0,800)});
    };
    if(pty){pty.onData(v=>add('stdout',v));pty.onExit(({exitCode})=>{clearTimeout(session.timer);session.status=session.status==='stopping'?'stopped':exitCode===0?'completed':'failed';session.exitCode=exitCode;this.emit({type:'terminal_finished',id,code:exitCode});});}
    else {
      child.stdin?.on('error',e=>add('system',`stdin closed: ${e.message}`));
      child.stdout?.on('data',v=>add('stdout',v.toString('utf8')));child.stderr?.on('data',v=>add('stderr',v.toString('utf8')));
      child.on('error',e=>{session.status='failed';add('system',e.message);});
      child.on('close',(code,signal)=>{clearTimeout(session.timer);session.status=session.status==='stopping'?'stopped':code===0?'completed':'failed';session.exitCode=code;this.emit({type:'terminal_finished',id,code,signal});});
    }
    if(interactive && command.trim())this.write(id,command+'\n');
    timeoutMinutes=Math.max(.01,Math.min(120,Number(timeoutMinutes)||5));
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
      else x.child?.kill('SIGTERM');
    }return {id,status:x.status};
  }
  async close(){for(const x of this.sessions.values())if(x.status==='running')this.stop(x.id);await this.sandbox.close();}
}
