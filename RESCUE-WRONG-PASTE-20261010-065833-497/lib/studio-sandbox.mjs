/** Docker Desktop executes untrusted verification commands in a Linux container.
 * The workspace is mounted READ-ONLY. No network, host PID/IPC, docker socket,
 * Windows pipe, extra caps, privilege escalation, or host write mount.
 * This is NOT a sandbox for external Desktop Commander MCP operations.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const fault=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
export const DEFAULT_IMAGE='python:3.11-slim';
export function dockerSandboxArgs({workspace,command,image=DEFAULT_IMAGE,name=`chatmcp-sbox-${randomUUID()}`}={}) {
  if(typeof workspace!=='string'||!workspace || /[\r\n\0]/.test(workspace))throw fault('Workspace path không hợp lệ.',400);
  if(typeof command!=='string'||!command.trim()||command.length>8000)throw fault('Lệnh sandbox không hợp lệ.',400);
  if(typeof image!=='string'|| !/^[a-z0-9][a-z0-9._:/@-]{0,180}$/i.test(image))throw fault('Tên Docker image không hợp lệ.',400);
  if(!/^chatmcp-sbox-[0-9a-f-]{36}$/.test(name))throw fault('Tên container sandbox không hợp lệ.',400);
  return ['run','--rm','--name',name,'--pull','never','--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--pids-limit','96','--memory','1024m','--cpus','1.0',
    '--user','65534:65534','--tmpfs','/tmp:rw,nosuid,nodev,size=256m',
    '--mount',`type=bind,src=${workspace},dst=/workspace,readonly`,
    '--workdir','/workspace','--env','HOME=/tmp','--env','PYTHONDONTWRITEBYTECODE=1',
    '--entrypoint','/bin/sh',image,'-lc',command];
}
export class StudioSandbox {
  constructor({workspace,spawnProcess=spawn}){this.workspace=workspace;this.spawnProcess=spawnProcess;this.active=new Set();this.cleanups=new Set();}
  async status(){
    return await new Promise(resolve=>{
      const child=this.spawnProcess('docker',['version','--format','{{.Server.Os}}'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let result='',done=false;
      const finish=(ready,detail)=>{if(done)return;done=true;clearTimeout(timer);resolve({ready,detail,scope:'Docker Desktop Linux container; terminal commands only; read-only workspace',image:DEFAULT_IMAGE});};
      const timer=setTimeout(()=>{child.kill();finish(false,'Docker không phản hồi trong 3 giây');},3000);
      child.stdout?.on('data',b=>{result+=String(b).slice(0,200);});
      child.on('error',e=>finish(false,e.message));
      child.on('close',code=>finish(code===0 && result.trim()==='linux',code===0?`Docker ${result.trim()}`:'Docker Desktop chưa sẵn sàng hoặc không ở Linux containers'));
    });
  }
  async launch({command,image=DEFAULT_IMAGE}={}){
    const workspace=await fs.realpath(this.workspace.requireRoot());
    const name=`chatmcp-sbox-${randomUUID()}`;
    const args=dockerSandboxArgs({workspace,command,image,name});
    const child=this.spawnProcess('docker',args,{cwd:workspace,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    this.active.add(name);
    child.once('close',()=>this.active.delete(name));
    child.once('error',()=>this.active.delete(name));
    return {child,name,mode:'docker-readonly'};
  }
  stop(name){
    if(!this.active.has(name))return false;
    // Container cleanup is explicit: terminating the docker CLI alone does not
    // necessarily stop an already-started container.
    const cleanup=this.spawnProcess('docker',['rm','-f',name],{windowsHide:true,stdio:'ignore'});
    const done=new Promise(resolve=>{cleanup.once('error',resolve);cleanup.once('close',resolve);});
    this.cleanups.add(done);done.finally(()=>this.cleanups.delete(done));
    return true;
  }
  async close(){for(const name of [...this.active])this.stop(name);await Promise.allSettled([...this.cleanups]);}
}
