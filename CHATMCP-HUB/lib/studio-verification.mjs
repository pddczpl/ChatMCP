import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, writeJson, redact } from './runtime.mjs';

const fault=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const validTaskId = s => typeof s==='string' && /^[0-9a-f-]{36}$/i.test(s);

/**
 * Persisted evidence for explicitly approved, discovered project checks.
 * This is separate from arbitrary shell execution: only commands returned by
 * StudioWorkspace.checks() are admissible. No command is auto-retried after
 * restart. A missing terminal process is recorded as *interrupted*, not failed.
 */
export class StudioVerification {
  constructor({workspace,terminal,directory,secrets=()=>[],permissions=null}) {
    this.workspace=workspace;
    this.terminal=terminal;
    this.directory=path.resolve(directory);
    this.secrets=secrets;
    this.permissions=permissions;
    this.queue=Promise.resolve();
  }
  async #file() {
    const root=await this.workspace.resolve('');
    const name=createHash('sha256').update(root.root).digest('hex').slice(0,28);
    return { file:path.join(this.directory,`${name}.json`), workspace:root.root };
  }
  async #locked(fn) {
    const next=this.queue.catch(()=>{}).then(fn);
    this.queue=next.catch(()=>{});
    return await next;
  }
  async #read(file,workspace) {
    const data=await readJson(file);
    if(!data)return {schema:1,workspace,runs:[]};
    if(data.schema!==1 || data.workspace!==workspace || !Array.isArray(data.runs))throw fault('Nhật ký kiểm thử không khớp workspace hoặc bị hỏng.',409);
    return data;
  }
  async #sync(data) {
    const live=new Map(this.terminal.state().map(x=>[x.id,x]));
    let changed=false;
    for(const run of data.runs) {
      if(!['running','starting'].includes(run.status))continue;
      const term=live.get(run.terminalId);
      if(!term) {
        run.status='interrupted';run.finishedAt=new Date().toISOString();run.detail='Không còn tiến trình terminal để xác minh; không tự chạy lại.';changed=true;
      } else if(term.status!=='running'&&term.status!=='stopping') {
        run.status=term.status;run.exitCode=term.exitCode??null;run.finishedAt=new Date().toISOString();
        // Cap persisted output and redact any exact known secrets.
        const snapshot=term.logs.map(item=>redact(item.message,this.secrets())).join('').slice(-4500);
        run.outputPreview=snapshot;changed=true;
      }
    }
    return changed;
  }
  async list({taskId=''}={}) {
    if(taskId && !validTaskId(taskId))throw fault('ID hội thoại không hợp lệ.',400);
    return this.#locked(async()=>{
      const {file,workspace}=await this.#file();const data=await this.#read(file,workspace);
      if(await this.#sync(data))await writeJson(file,data);
      const runs=taskId?data.runs.filter(x=>x.taskId===taskId):data.runs;
      return {workspace,runs:runs.slice(-60).reverse(),total:runs.length};
    });
  }
  async start({command,taskId=''}={}) {
    if(taskId && !validTaskId(taskId))throw fault('ID hội thoại không hợp lệ.',400);
    const discovered=await this.workspace.checks();
    const commands=(discovered.suggested||[]).map(x=>x.command);
    if(!commands.includes(command))throw fault('Chỉ cho phép chạy lệnh kiểm thử đã phát hiện từ file cấu hình dự án. Dùng terminal thủ công cho lệnh khác.',403);
    return this.#locked(async()=>{
      const {file,workspace}=await this.#file();const data=await this.#read(file,workspace);
      await this.#sync(data);
      const sandbox=this.permissions?.executionPolicy==='sandbox-only';
      const entry={id:randomUUID(),terminalId:null,taskId:taskId||null,command,sandbox,status:'starting',exitCode:null,startedAt:new Date().toISOString(),finishedAt:null,outputPreview:''};
      data.runs.push(entry);
      if(data.runs.length>150)data.runs.splice(0,data.runs.length-150);
      // Durable intent before starting the process: an interrupted start must
      // never be interpreted as an invitation to run the command twice.
      await writeJson(file,data);
      try {
        const term=await this.terminal.start({command,timeoutMinutes:15,sandbox});
        entry.terminalId=term.id;entry.status='running';
      } catch(error) { entry.status='failed_to_start';entry.finishedAt=new Date().toISOString();entry.detail='Tiến trình không khởi động được.';await writeJson(file,data);throw error; }
      await writeJson(file,data);
      return entry;
    });
  }
}
