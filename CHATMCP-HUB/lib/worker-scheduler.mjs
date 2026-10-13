// Dynamic DAG worker scheduling with inherited, attenuated authority.
//
// No ChatMCP-imposed token quota, spend budget, or provider billing controls.
// The user configures their own model API base URL and key and manages
// consumption with that provider. Limits here are ONLY process/concurrency,
// hierarchy and cancellation safety bounds, never model usage allowances.
import { randomUUID } from 'node:crypto';
import { fault } from './execution-contract.mjs';
import { deriveChildCapabilities } from './worker-capabilities.mjs';

const validInt=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;

export class WorkerScheduler {
  constructor({
    root, authorized = false, maxWorkers = 6, maxConcurrent = 2,
    maxDepth = 2, executeWorker, persist = async()=>{},
  } = {}) {
    if (!root?.id || !root.workspaceScope || typeof executeWorker !== 'function') {
      throw new TypeError('A trusted run owner and implementation are required.');
    }
    if (!validInt(maxWorkers,1,32)||!validInt(maxConcurrent,1,8)||
        !validInt(maxDepth,1,4)||maxConcurrent>maxWorkers||
        typeof persist !== 'function') {
      throw fault('invalid_worker_capacity','Worker concurrency/graph bounds must be safe integers.');
    }
    this.runId=randomUUID();
    this.root={...root,depth:0,status:'ready'};
    this.authorized=authorized===true;
    this.maxWorkers=maxWorkers;this.maxConcurrent=maxConcurrent;this.maxDepth=maxDepth;
    this.executeWorker=executeWorker;this.persist=persist;
    this.nodes=new Map([[root.id,this.root]]);
    this.controller=new AbortController();this.running=false;
  }
  spawnWorker({
    parentId,role,goal,dependencies=[],requestedCapabilities=[],workspaceScope,
  }={}) {
    if (!this.authorized||this.controller.signal.aborted) {
      throw fault('worker_not_authorized','Dynamic spawning requires explicit authorized run.',403);
    }
    const parent=this.nodes.get(parentId); // NEVER accept a model-supplied parent object
    if (!parent || parent.depth>=this.maxDepth ||
        ['failed','cancelled','blocked','needs_attention','interrupted'].includes(parent.status)||
        parent.capabilities?.spawn!==true) {
      throw fault('worker_parent_denied','Parent missing, stopped, too deep, or lacking delegation rights.',403);
    }
    if(this.nodes.size-1>=this.maxWorkers||typeof goal!=='string'||
       !goal.trim()||goal.length>2000||!Array.isArray(dependencies)||
       new Set(dependencies).size!==dependencies.length||
       dependencies.some(id=>typeof id!=='string'||id===parentId||!this.nodes.has(id))) {
      throw fault('invalid_worker','Worker count, goal, or dependency scope invalid.',400);
    }
    const capabilities=deriveChildCapabilities({
      parent,role,requested:requestedCapabilities,workspaceScope,
    });
    const id=randomUUID();
    const node={
      id,parentId,depth:parent.depth+1,role,goal,
      dependencies:[...dependencies],workspaceScope:capabilities.workspaceScope,
      capabilities,status:'queued',result:null,createdAt:new Date().toISOString(),
    };
    this.nodes.set(id,node);
    return Object.freeze({id,parentId,depth:node.depth,role,status:node.status});
  }
  async run(){
    if(this.running)throw fault('scheduler_busy','Dynamic scheduling already running.',409);
    if(!this.authorized)throw fault('worker_not_authorized','No approved run grant.',403);
    this.running=true;
    try{
      while([...this.nodes.values()].some(n=>n.status==='queued')){
        this.controller.signal.throwIfAborted();
        const pending=[...this.nodes.values()].filter(n=>n.status==='queued');
        const ready=pending.filter(n=>n.dependencies.every(d=>this.nodes.get(d)?.status==='completed'));
        if(!ready.length){
          pending.forEach(n=>{n.status='blocked';n.error='Dependency not completed';});
          await this.persist(this.state());
          break;
        }
        const concurrent=ready.slice(0,this.maxConcurrent);
        concurrent.forEach(n=>{n.status='running';});
        await this.persist(this.state());
        await Promise.all(concurrent.map(async node=>{
          try{
            const result=await this.executeWorker({
              id:node.id,goal:node.goal,role:node.role,
              capabilities:node.capabilities,signal:this.controller.signal,
            });
            if(this.controller.signal.aborted){node.status='cancelled';return;}
            // A model/worker claiming "finished" is not automatically a
            // completed job. Explicit failed/blocked outcomes must prevent
            // dependent workers from running; unknown outcomes are UNVERIFIED.
            // No late success after owner cancellation can be published.
            const state=result?.status??result?.state;
            if(state!=='completed'){
              node.status=state==='failed'?'failed':'blocked';
              node.error='Worker returned '+String(state||'unknown')+
                '; completion was not independently established.';
              return;
            }
            node.result={status:'completed'};
            node.status='completed';
          }catch(e){
            node.error=String(e?.message||e).slice(0,300);
            node.status=this.controller.signal.aborted?'cancelled':'failed';
          }finally{await this.persist(this.state());}
        }));
      }
    }finally{this.running=false;await this.persist(this.state());}
    return this.state();
  }
  cancel(){
    if(this.controller.signal.aborted)return false;
    this.controller.abort(new Error('Worker tree cancelled by run owner.'));
    for(const node of this.nodes.values())if(node.status==='queued')node.status='cancelled';
    return true;
  }
  state(){
    return {
      runId:this.runId,authorized:this.authorized,active:this.running,
      modelUsageLimit:null,modelCostLimit:null,
      concurrencyLimit:this.maxConcurrent,workerGraphLimit:this.maxWorkers,depthLimit:this.maxDepth,
      workers:[...this.nodes.values()].map(n=>({
        id:n.id,parentId:n.parentId,role:n.role,status:n.status,
        capabilities:n.capabilities,error:n.error||null,depth:n.depth,
      })),
    };
  }
}
