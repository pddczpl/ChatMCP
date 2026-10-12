// Persistent dynamic DAG scheduler. Children use strictly attenuated
// capabilities and one shared budget, never inherit integration/publish.
import { randomUUID } from 'node:crypto';
import { fault } from './execution-contract.mjs';
import { deriveChildCapabilities } from './worker-capabilities.mjs';
import { WorkerBudget } from './worker-budget.mjs';
export class WorkerScheduler {
  constructor({ root, authorized = false, budget = new WorkerBudget(), executeWorker, persist = async()=>{} } = {}) {
    if (!root || !root.id || !root.workspaceScope || typeof executeWorker !== 'function') {
      throw new TypeError('A trusted run owner and implementation are required.');
    }
    this.runId=randomUUID();this.root={ ...root, depth:0, status:'ready' };
    this.authorized=authorized===true;this.budget=budget;this.executeWorker=executeWorker;this.persist=persist;
    this.nodes=new Map([[root.id,this.root]]);
    this.controller=new AbortController();this.running=false;
  }
  spawnWorker({ parentId, role, goal, dependencies = [], requestedCapabilities = [], requestedBudget, workspaceScope } = {}) {
    if (!this.authorized || this.controller.signal.aborted) throw fault('worker_not_authorized','Dynamic spawning requires explicit authorized run.',403);
    const parent=this.nodes.get(parentId); // ignore any model-supplied parent object
    if (!parent || parent.depth >= 2 || parent.status==='failed' || parent.status==='cancelled' || parent.capabilities?.spawn !== true) {
      throw fault('worker_parent_denied','Parent missing, stopped, too deep, or lacking delegation rights.',403);
    }
    if (this.nodes.size-1 >= this.budget.maxWorkers || typeof goal !== 'string' || !goal.trim() || goal.length > 2000 ||
        !Array.isArray(dependencies) || dependencies.some(x => typeof x !== 'string' || !this.nodes.has(x))) {
      throw fault('invalid_worker','Worker count, goal or dependencies invalid.',400);
    }
    const capabilities=deriveChildCapabilities({parent,role,requested:requestedCapabilities,workspaceScope});
    const reservation=this.budget.reserveWorkerBudget({parentId,requested:requestedBudget});
    const id=randomUUID();
    if (dependencies.includes(id) || dependencies.includes(parentId)) {
      this.budget.release(reservation.id);throw fault('invalid_dependencies','Worker cannot depend on self or parent.');
    }
    const node={
      id,parentId,depth:parent.depth+1,role,goal,dependencies:[...new Set(dependencies)],
      workspaceScope:capabilities.workspaceScope,capabilities,reservationId:reservation.id,
      status:'queued',result:null,createdAt:new Date().toISOString(),
    };
    this.nodes.set(id,node);
    return Object.freeze({id,parentId,depth:node.depth,role,status:node.status,reservationId:node.reservationId});
  }
  async run() {
    if (this.running) throw fault('scheduler_busy','Dynamic scheduling already running.',409);
    if (!this.authorized) throw fault('worker_not_authorized','No approved run grant.',403);
    this.running=true;
    try {
      while ([...this.nodes.values()].some(n=>n.status==='queued')) {
        this.controller.signal.throwIfAborted();
        const pending=[...this.nodes.values()].filter(n=>n.status==='queued');
        const ready=pending.filter(n=>n.dependencies.every(d=>this.nodes.get(d)?.status==='completed'));
        if (!ready.length) {
          pending.forEach(n=>{n.status='blocked';n.error='Unfinished/failed dependency';this.budget.release(n.reservationId);});
          break;
        }
        const concurrent=ready.slice(0,this.budget.maxConcurrent);
        concurrent.forEach(n=>{n.status='running';});
        await this.persist(this.state());
        await Promise.all(concurrent.map(async node=>{
          try {
            const result=await this.executeWorker({
              id:node.id,goal:node.goal,role:node.role,capabilities:node.capabilities,
              reservationId:node.reservationId,signal:this.controller.signal,
            });
            if (this.controller.signal.aborted) {node.status='cancelled';return;}
            node.result=result;node.status='completed';
          } catch (e) {node.error=String(e.message||e).slice(0,300);node.status=this.controller.signal.aborted?'cancelled':'failed';}
          finally {this.budget.release(node.reservationId);await this.persist(this.state());}
        }));
      }
    } finally { this.running=false;await this.persist(this.state()); }
    return this.state();
  }
  cancel() {
    if (this.controller.signal.aborted) return false;
    this.controller.abort(new Error('Worker tree cancelled by run owner.'));
    for (const n of this.nodes.values()) if(n.status==='queued'){n.status='cancelled';this.budget.release(n.reservationId);}
    return true;
  }
  state() {return {runId:this.runId,authorized:this.authorized,active:this.running,
    workers:[...this.nodes.values()].map(n=>({id:n.id,parentId:n.parentId,role:n.role,status:n.status,
      capabilities:n.capabilities,error:n.error||null,depth:n.depth})),budget:this.budget.state()};}
}
