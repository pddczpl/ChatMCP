import assert from 'node:assert/strict';
import { deriveChildCapabilities } from '../lib/worker-capabilities.mjs';
import { WorkerBudget } from '../lib/worker-budget.mjs';
import { WorkerScheduler } from '../lib/worker-scheduler.mjs';
import path from 'node:path';
const base=path.resolve('/tmp', 'chatmcp-worker');
const root={id:'root',workspaceScope:base,capabilities:{read:true,edit:true,checksList:true,checksRun:true,spawn:true}};
const coder=deriveChildCapabilities({parent:root,role:'coder',requested:['read','edit','checksRun','spawn'],workspaceScope:path.join(base,'w1')});
assert.equal(coder.edit,true);assert.equal(coder.shell,false);assert.equal(coder.publish,false);
assert.throws(()=>deriveChildCapabilities({parent:root,role:'coder',requested:['shell'],workspaceScope:base}),/capabilities/i);
assert.throws(()=>deriveChildCapabilities({parent:root,role:'coder',requested:['edit'],workspaceScope:path.resolve(base,'..','escape')}),/scope/i);
const ledger = new WorkerBudget({ maxTokens:1000 });
const a=ledger.reserveWorkerBudget({parentId:'root',requested:600});
assert.throws(()=>ledger.reserveWorkerBudget({parentId:'root',requested:500}),/budget/i);
ledger.consume(a.id,200);ledger.release(a.id);assert.equal(ledger.state().spent,200);
let callCount=0;
const scheduler=new WorkerScheduler({root,authorized:true,
  budget:new WorkerBudget({maxTokens:5000}),
  executeWorker:async()=>{callCount++;return {status:'completed'};},
});
const first=scheduler.spawnWorker({parentId:'root',role:'coder',goal:'repair',requestedCapabilities:['read','edit','checksRun','spawn'],
  requestedBudget:500,workspaceScope:path.join(base,'w1')});
const next=scheduler.spawnWorker({parentId:first.id,role:'researcher',goal:'research',requestedCapabilities:['read'],
  requestedBudget:100,workspaceScope:path.join(base,'w1')});
assert.equal(next.depth,2);
assert.throws(()=>scheduler.spawnWorker({parentId:next.id,role:'coder',goal:'escape',requestedCapabilities:['edit'],requestedBudget:100,workspaceScope:base}),/parent/i);
const result=await scheduler.run();
assert.equal(callCount,2);assert.equal(result.workers.filter(x=>x.status==='completed').length,2);
const blocked=new WorkerScheduler({root,authorized:false,executeWorker:async()=>{}});
assert.throws(()=>blocked.spawnWorker({parentId:'root',role:'coder',goal:'bad',workspaceScope:base}),/authorized/i);
console.log('PASS: capability attenuation, shared budget, authorized spawn, depth and dependency handling');
