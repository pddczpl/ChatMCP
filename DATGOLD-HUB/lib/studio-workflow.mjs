import path from 'node:path';
import { readJson, writeJson } from './runtime.mjs';
const idOk = id => typeof id==='string' && /^[0-9a-f-]{36}$/i.test(id);
/** A durable, observable *activity* timeline, not the model's hidden reasoning. */
export class StudioWorkflow {
  constructor({directory}) {this.directory=directory;this.cache=new Map();this.writes=new Map();}
  async load(id){
    if(!idOk(id))throw new Error('Bad task ID');
    if(this.cache.has(id))return this.cache.get(id);
    const data=await readJson(path.join(this.directory,`${id}.json`))??{taskId:id,steps:[],phase:'discovery',editsObserved:0,checksObserved:0,verified:false};
    this.cache.set(id,data);return data;
  }
  async mark(taskId,type,{toolName='',category='',isError=false,checkpoint=null,verified=false,fileEdit,commandKind=''}={}){
    const data=await this.load(taskId);const t=new Date().toISOString();
    const safeTool=String(toolName).slice(0,200);
    const phase=type==='tool_start'?(category==='workspace_edit'||category==='dangerous'?'editing':category==='execute'?'running':'discovery'):
      type==='checkpoint'?'checkpoint':type==='tool_result'?(verified?'verification':data.phase):data.phase;
    data.phase=phase;
    if(type==='tool_result' && !isError){
      // An edit is a call that changed files. The caller says so with `fileEdit`: a test run passes the same gate as an edit
      // (it may write caches or build output) but is not one. Without that information the category decides, as before.
      if(fileEdit??(category==='workspace_edit'))data.editsObserved++;
      // A shell command that is not a plain read or a known check may have changed anything: counted apart, never as an edit.
      if(['edit','exec','dangerous'].includes(commandKind))data.commandsObserved=(data.commandsObserved||0)+1;
      if(verified){data.checksObserved++;data.verified=true;}
    }
    const item={at:t,type,toolName:safeTool,category,isError,checkpoint,verified};data.steps.push(item);
    if(data.steps.length>250)data.steps.splice(0,data.steps.length-250);
    const previous=this.writes.get(taskId)||Promise.resolve();
    const next=previous.catch(()=>{}).then(()=>writeJson(path.join(this.directory,`${taskId}.json`),data));
    this.writes.set(taskId,next);await next;return data;
  }
  async state(taskId){if(!taskId)return null;const data=await this.load(taskId);return {...data,steps:data.steps.slice(-70)};}
}
