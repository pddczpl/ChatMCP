// A single run-owned ledger; descendants cannot mint additional allowances.
// Reservations are synchronous to avoid concurrent model-worker overcommit.
import { randomUUID } from 'node:crypto';
import { fault } from './execution-contract.mjs';
export class WorkerBudget {
  constructor({ maxTokens = 120000, maxWorkers = 6, maxConcurrent = 2 } = {}) {
    if (![maxTokens,maxWorkers,maxConcurrent].every(Number.isSafeInteger) ||
        maxTokens < 0 || maxWorkers < 1 || maxWorkers > 6 || maxConcurrent < 1 || maxConcurrent > 2) {
      throw fault('invalid_budget', 'Unsupported global worker budget.');
    }
    this.maxTokens=maxTokens;this.maxWorkers=maxWorkers;this.maxConcurrent=maxConcurrent;
    this.reservations=new Map();this.spent=0;
  }
  outstanding() { return [...this.reservations.values()].reduce((s,x)=>s+x.remaining,0); }
  reserveWorkerBudget({ parentId, requested } = {}) {
    if (typeof parentId !== 'string' || !parentId ||
        !Number.isSafeInteger(requested) || requested < 1 ||
        this.reservations.size >= this.maxWorkers ||
        this.outstanding()+this.spent+requested > this.maxTokens) {
      throw fault('budget_exceeded','Shared run token/worker budget exceeded.',409);
    }
    const id=randomUUID();
    this.reservations.set(id,{id,parentId,remaining:requested,used:0,closed:false});
    return Object.freeze({id,parentId,reservedTokens:requested});
  }
  consume(id, tokens) {
    const r=this.reservations.get(id);
    if (!r || r.closed || !Number.isSafeInteger(tokens) || tokens<0 || tokens>r.remaining) {
      throw fault('budget_exceeded','Worker token usage exceeds its reservation.',409);
    }
    r.remaining-=tokens;r.used+=tokens;this.spent+=tokens;
  }
  release(id) {
    const r=this.reservations.get(id);
    if (!r || r.closed) return false;
    r.closed=true;r.remaining=0;
    return true;
  }
  state() { return Object.freeze({maxTokens:this.maxTokens,spent:this.spent,outstanding:this.outstanding(),
    reservations:[...this.reservations.values()].map(x=>({...x}))}); }
}
