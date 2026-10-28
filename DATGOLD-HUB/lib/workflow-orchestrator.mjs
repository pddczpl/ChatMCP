// A durable, model-declared *workflow*, distinct from an ordinary chat or one
// coding-agent task. A workflow holds ordered phases and many real child task
// IDs. Its execution still belongs to ConcurrentApiAgent, including its Git
// worktree/approval/dependency scheduler. This module never executes tools.
import { randomUUID } from 'node:crypto';
import { wordsAndNotes } from './final-text.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAILURE=new Set(['failed','cancelled','uncertain','blocked','limit','interrupted']);
const LIVE=new Set(['queued','preparing','planning','running','waiting_approval','verifying']);
const fault=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
// The preview of an agent's answer, and each sentence of the Hub's own that the runner put after it (lib/final-text.mjs), are cut on their own.
const PREVIEW_CHARACTERS=360,NOTE_CHARACTERS=240;
const clipped=(text,limit)=>text.length>limit?text.slice(0,limit-1)+'…':text;
const now=()=>new Date().toISOString();
const text=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
const title=(value,max,what)=>{
  const trimmed=text(value,max);
  if(!trimmed)throw fault('invalid_workflow',what+' is required.');
  return trimmed;
};
const statusOf=task=>{
  if(!task)return 'unknown';
  // The runner's persisted status is the authoritative final state; public
  // "state" may legitimately differ during a recovery or approval boundary.
  return String(task.status||task.state||'unknown');
};

export class WorkflowOrchestrator {
  constructor({startAgent,getTask,cancelTask,onChange=async()=>{},maxAgents=12,log=()=>{}}={}){
    if(!startAgent||!getTask||!cancelTask)throw new TypeError('WorkflowOrchestrator requires agent callbacks.');
    this.startAgent=startAgent;
    this.getTask=getTask;
    this.cancelTask=cancelTask;
    this.onChange=onChange;
    this.log=log;
    this.maxAgents=maxAgents;
    this.workflows=new Map();
  }
  serialize(){
    return [...this.workflows.values()].map(w=>structuredClone(w));
  }
  load(raw=[]){
    this.workflows.clear();
    if(!Array.isArray(raw))return;
    for(const original of raw.slice(-100)){
      if(!UUID.test(original?.id||'')||!UUID.test(original?.conversationId||'')||
         !Array.isArray(original.phases)||original.phases.length<1||original.phases.length>5)continue;
      const phases=[];
      for(const phase of original.phases){
        if(!UUID.test(phase?.id||'')||typeof phase?.name!=='string'||!Array.isArray(phase.agents)||
           phase.agents.length>this.maxAgents)continue;
        phases.push({
          id:phase.id,name:text(phase.name,100),expectedAgents:Number.isInteger(phase.expectedAgents)?phase.expectedAgents:phase.agents.length,dependsOn:Array.isArray(phase.dependsOn)?phase.dependsOn.filter(x=>UUID.test(x)).slice(0,4):[],
          agents:phase.agents.filter(a=>UUID.test(a?.taskId||'')).slice(0,this.maxAgents)
            .map(a=>({id:UUID.test(a.id)?a.id:randomUUID(),goal:text(a.goal,4000),
              role:text(a.role,80),taskId:a.taskId})),
        });
      }
      if(!phases.length)continue;
      const workflow={
        id:original.id,conversationId:original.conversationId,
        parentRunId:UUID.test(original.parentRunId||'')?original.parentRunId:null,
        workspacePath:String(original.workspacePath||''),
        name:text(original.name,150)||'Background workflow',
        createdAt:original.createdAt||now(),updatedAt:original.updatedAt||now(),
        phases,statusOverride:original.statusOverride==='cancelled'?'cancelled':original.statusOverride==='failed'?'failed':null,
        error:text(original.error,500)||null,
      };
      this.workflows.set(workflow.id,workflow);
    }
    // Deliberately no automatic restart: interrupted Git writes and old
    // dependencies must first be reviewed by the user after a Hub crash.
  }
  forConversation(conversationId){
    return this.list().filter(w=>w.conversationId===conversationId);
  }
  removeByConversation(conversationId){
    let changed=false;
    for(const [id,w] of this.workflows){
      if(w.conversationId===conversationId){this.workflows.delete(id);changed=true;}
    }
    return changed;
  }
  get(id){
    const raw=this.workflows.get(id);
    if(!raw)return null;
    const phases=raw.phases.map(p=>{
      const agents=p.agents.map(a=>{
        const task=this.getTask(a.taskId);
        const {words,notes,recorded}=wordsAndNotes(task);
        return {...a,status:statusOf(task),branch:task?.branch||null,
          worktree:task?.worktree||null,startedAt:task?.startedAt||task?.createdAt||null,
          finishedAt:task?.finishedAt||null,model:task?.model||null,
          usage:task?.usage&&typeof task.usage==='object'?{
            inputTokens:Number(task.usage.inputTokens||0),
            outputTokens:Number(task.usage.outputTokens||0),
            httpRequests:Number(task.usage.httpRequests||0),
          }:null,
          // The verified result remains in each actual child conversation.
          // We only expose a concise, untrusted preview in workflow UI. It is the model's words; the sentences of the Hub's own that the runner put after them are the note
          // beside it (resultNotice), which the card shows as the Hub's. A task with no record of where the words end keeps its text whole, as it always did.
          resultPreview:typeof task?.finalText==='string'?words.slice(0,PREVIEW_CHARACTERS):null,
          resultNotice:recorded&&notes.length?notes.map(note=>clipped(note,NOTE_CHARACTERS)).join(' '):null};
      });
      const complete=agents.filter(a=>a.status==='completed').length;
      const failed=agents.filter(a=>FAILURE.has(a.status));
      const status=failed.length?'blocked':agents.length<(p.expectedAgents||agents.length)?'preparing':
        complete===agents.length&&agents.length>0?'completed':
        agents.length>0&&agents.every(a=>a.status==='queued')?'waiting':
        agents.some(a=>LIVE.has(a.status))?'running':'paused';
      return {...p,agents,status,completed:complete,total:agents.length};
    });
    const total=phases.reduce((n,p)=>n+p.total,0);
    const complete=phases.reduce((n,p)=>n+p.completed,0);
    const blocked=phases.some(p=>p.status==='blocked');
    const live=phases.some(p=>p.status==='running'||p.status==='preparing'||p.status==='waiting');
    const status=raw.statusOverride||(
      blocked?'blocked':complete===total&&total>0?'completed':live?'running':'paused');
    const aggregate=phases.flatMap(p=>p.agents).reduce((n,a)=>({
      inputTokens:n.inputTokens+(a.usage?.inputTokens||0),
      outputTokens:n.outputTokens+(a.usage?.outputTokens||0),
      httpRequests:n.httpRequests+(a.usage?.httpRequests||0),
    }),{inputTokens:0,outputTokens:0,httpRequests:0});
    const ends=phases.flatMap(p=>p.agents).map(a=>a.finishedAt).filter(Boolean).sort();
    const finishedAt=['completed','blocked','failed','cancelled'].includes(status)&&
      phases.every(p=>p.agents.every(a=>!LIVE.has(a.status)))?ends.at(-1)||raw.updatedAt:null;
    return {...raw,phases,status,completed:complete,total,finishedAt,usage:aggregate,
      activeAgents:phases.flatMap(p=>p.agents).filter(a=>LIVE.has(a.status)).length,
      failedAgents:phases.flatMap(p=>p.agents).filter(a=>FAILURE.has(a.status)).length};
  }
  list(){
    return [...this.workflows.keys()].map(id=>this.get(id))
      .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  async create(conversationId,{name,phases}={}){
    if(!UUID.test(conversationId||'')||!this.getTask(conversationId))
      throw fault('parent_missing','A running conversation must own this workflow.',404);
    if(!Array.isArray(phases)||phases.length<1||phases.length>5)
      throw fault('invalid_workflow','A workflow requires 1–5 phases.');
    const total=phases.reduce((n,p)=>n+(Array.isArray(p.agents)?p.agents.length:0),0);
    if(total<1||total>this.maxAgents)
      throw fault('workflow_capacity','Workflow requires 1–'+this.maxAgents+' subagents.');
    const seen=new Set();
    const valid=phases.map((phase,index)=>{
      const name=title(phase?.name,100,'Phase name');
      if(seen.has(name.toLowerCase()))throw fault('duplicate_phase','Phase names must be unique.');
      const predecessors=Array.isArray(phase?.dependsOn)?phase.dependsOn:
        index>0?[phases[index-1].name]:[];
      if(predecessors.length>4||predecessors.some(ref=>typeof ref!=='string'||!seen.has(ref.toLowerCase())))
        throw fault('invalid_dependencies','Phase dependencies must refer to earlier named phases.');
      const agents=phase?.agents;
      if(!Array.isArray(agents)||agents.length<1||agents.length>this.maxAgents)
        throw fault('invalid_agents','Every phase must have at least one subagent.');
      const normalizedAgents=agents.map(a=>({
        id:randomUUID(),role:text(a?.role,80),goal:title(a?.goal,4000,'Agent goal'),taskId:null,
      }));
      seen.add(name.toLowerCase());
      return {id:randomUUID(),name,dependsOnNames:predecessors,agents:normalizedAgents};
    });
    const parent=this.getTask(conversationId);
    const workflow={
      id:randomUUID(),conversationId,
      parentRunId:parent?.runs?.at(-1)?.id||null,
      workspacePath:parent?.workspacePath||parent?.workspace?.path||'',
      name:title(name,150,'Workflow name'),
      createdAt:now(),updatedAt:now(),statusOverride:null,error:null,
      phases:valid.map(p=>({id:p.id,name:p.name,expectedAgents:p.agents.length,dependsOn:[],
        agents:[]})),
    };
    this.workflows.set(workflow.id,workflow);
    await this.onChange({type:'workflow_created',workflowId:workflow.id,conversationId});
    const nameToIndex=new Map();
    try{
      for(let i=0;i<valid.length;i++){
        const phase=valid[i],saved=workflow.phases[i];
        const predecessors=phase.dependsOnNames.map(n=>workflow.phases[nameToIndex.get(n.toLowerCase())]);
        saved.dependsOn=predecessors.map(p=>p.id);
        const deps=predecessors.flatMap(p=>p.agents.map(a=>a.taskId));
        for(const agent of phase.agents){
          const request={
            goal:agent.goal,dependsOn:deps,workflowId:workflow.id,
            phaseId:saved.id,role:agent.role,
          };
          // startAgent returns an actual queued task in the isolated worktree
          // scheduler. This is not a simulated progress bar.
          const task=await this.startAgent(conversationId,request);
          saved.agents.push({...agent,taskId:task.id});
          workflow.updatedAt=now();
          await this.onChange({type:'workflow_updated',workflowId:workflow.id,conversationId});
        }
        nameToIndex.set(phase.name.toLowerCase(),i);
      }
    }catch(error){
      workflow.statusOverride='failed';
      workflow.error=String(error?.message||error).slice(0,500);
      workflow.updatedAt=now();
      await this.onChange({type:'workflow_failed',workflowId:workflow.id,conversationId});
      this.log('Workflow '+workflow.id+' partially scheduled: '+workflow.error);
    }
    return this.get(workflow.id);
  }
  async cancel(id){
    const workflow=this.workflows.get(id);
    if(!workflow)throw fault('workflow_not_found','Unknown workflow.',404);
    if(workflow.statusOverride==='cancelled'||this.get(id)?.status==='completed')return this.get(id);
    const errors=[];
    for(const taskId of workflow.phases.flatMap(p=>p.agents.map(a=>a.taskId))){
      const task=this.getTask(taskId);
      if(task&&LIVE.has(statusOf(task))){
        try{
          const result=await this.cancelTask(taskId);
          if(result?.status==='uncertain'||result?.status==='failed')
            errors.push('Task '+taskId+' is '+result.status+'; inspect its Git worktree before retrying.');
        }catch(error){errors.push(String(error?.message||error).slice(0,120));}
      }
    }
    workflow.statusOverride=errors.length?'failed':'cancelled';
    workflow.error=errors.length?errors.join('; ').slice(0,500):null;
    workflow.updatedAt=now();
    await this.onChange({type:'workflow_cancelled',workflowId:id,conversationId:workflow.conversationId});
    return this.get(id);
  }
}
