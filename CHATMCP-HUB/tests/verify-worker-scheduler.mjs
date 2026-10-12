import assert from 'node:assert/strict';
import path from 'node:path';
import { deriveChildCapabilities } from '../lib/worker-capabilities.mjs';
import { WorkerScheduler } from '../lib/worker-scheduler.mjs';

const base=path.resolve('/tmp','chatmcp-worker');
const root={id:'root',workspaceScope:base,
  capabilities:{read:true,edit:true,checksList:true,checksRun:true,spawn:true}};
const coder=deriveChildCapabilities({
  parent:root,role:'coder',requested:['read','edit','checksRun','spawn'],
  workspaceScope:path.join(base,'w1'),
});
assert.equal(coder.edit,true);
assert.equal(coder.shell,false);
assert.equal(coder.publish,false);
assert.throws(()=>deriveChildCapabilities({
  parent:root,role:'coder',requested:['shell'],workspaceScope:base,
}),/capabilities/i);
assert.throws(()=>deriveChildCapabilities({
  parent:root,role:'coder',requested:['edit'],
  workspaceScope:path.resolve(base,'..','escape'),
}),/scope/i);

let active=0,peak=0,executed=0;
const scheduler=new WorkerScheduler({
  root,authorized:true,maxWorkers:6,maxConcurrent:2,
  executeWorker:async()=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,5));
    active--;executed++;return {status:'completed'};
  },
});
const first=scheduler.spawnWorker({
  parentId:'root',role:'coder',goal:'repair',
  requestedCapabilities:['read','edit','checksRun','spawn'],
  workspaceScope:path.join(base,'w1'),
});
const child=scheduler.spawnWorker({
  parentId:first.id,role:'researcher',goal:'research',
  requestedCapabilities:['read'],workspaceScope:path.join(base,'w1'),
});
assert.equal(child.depth,2);
assert.throws(()=>scheduler.spawnWorker({
  parentId:child.id,role:'coder',goal:'escalate',
  requestedCapabilities:['edit'],workspaceScope:base,
}),{code:'worker_parent_denied'});
for(let i=0;i<3;i++)scheduler.spawnWorker({
  parentId:'root',role:'reviewer',goal:'review '+i,
  requestedCapabilities:['read'],workspaceScope:base,
});
const state=scheduler.state();
assert.equal(state.modelUsageLimit,null);
assert.equal(state.modelCostLimit,null);
assert.equal(Object.hasOwn(state,'budget'),false);
const result=await scheduler.run();
assert.equal(executed,5);
assert.equal(peak,2,'Only active worker concurrency, never model tokens, is capped.');
assert.equal(result.workers.filter(x=>x.status==='completed').length,5);
assert.ok(result.workers.every(x=>!Object.hasOwn(x,'reservationId')));
assert.throws(()=>new WorkerScheduler({root,executeWorker:async()=>{},maxConcurrent:0}),/capacity|bound/i);
assert.throws(()=>new WorkerScheduler({root,executeWorker:async()=>{},maxWorkers:10000}),/capacity|bound/i);
const blocked=new WorkerScheduler({root,authorized:false,executeWorker:async()=>{}});
assert.throws(()=>blocked.spawnWorker({
  parentId:'root',role:'coder',goal:'bad',workspaceScope:base,
}),{code:'worker_not_authorized'});
console.log('PASS: capability attenuation, explicit authorization and safe concurrency without ChatMCP token/spend quotas');
