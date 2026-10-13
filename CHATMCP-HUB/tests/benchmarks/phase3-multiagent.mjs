// Phase 3 deterministic benchmark. Source-only graph and scheduler planning,
// never real model API, host command, Windows guest attestation or Git writes.
import assert from 'node:assert/strict';
import {deriveChildCapabilities} from '../../lib/worker-capabilities.mjs';
import {validateCodingTaskGraph,chooseReadyCodingBatch,detectCodingFileConflicts}
  from '../../lib/coding-task-dag.mjs';
import {WorkerScheduler} from '../../lib/worker-scheduler.mjs';

const rows=[],record=(id,expected,actual)=>{rows.push({id,expected,actual,passed:expected===actual});assert.equal(actual,expected,id);};
const graph=validateCodingTaskGraph([
  {id:'base'},{id:'analyzer',dependsOn:['base']},
  {id:'worker',dependsOn:['base']},{id:'finish',dependsOn:['analyzer','worker']},
]);
let workers=graph.map(x=>({...x,status:'queued'}));
record('dag-initial','base',chooseReadyCodingBatch(workers,2).ready.join(','));
workers.find(x=>x.id==='base').status='ready_for_review';
record('dag-parallel-ready','analyzer,worker',chooseReadyCodingBatch(workers,2).ready.join(','));
workers.find(x=>x.id==='analyzer').status='failed';
record('dag-failed-predecessor','finish',chooseReadyCodingBatch(workers,2).blocked.join(','));
workers.find(x=>x.id==='analyzer').status='ready_for_review';
workers.find(x=>x.id==='worker').status='ready_for_review';
record('dag-final-ready','finish',chooseReadyCodingBatch(workers,2).ready.join(','));
record('overlapping-windows-path','shared.js',
  detectCodingFileConflicts([
    {id:'analyzer',changedFiles:['Shared.js']},
    {id:'worker',changedFiles:['shared.js']},
  ])[0]?.file);
const root={id:'owner',workspaceScope:process.cwd(),
  capabilities:{read:true,edit:true,spawn:true,checksRun:true}};
const reviewer=deriveChildCapabilities({parent:root,role:'reviewer',
  requested:['read','edit','checksRun'],workspaceScope:process.cwd()});
record('reviewer-attenuation','safe',reviewer.read&&!reviewer.edit&&!reviewer.checksRun&&!reviewer.shell?'safe':'unsafe');
let active=0,maxActive=0,invoked=0;
const scheduler=new WorkerScheduler({
  root,authorized:true,maxWorkers:4,maxConcurrent:2,
  executeWorker:async({goal})=>{
    invoked++;active++;maxActive=Math.max(maxActive,active);
    await new Promise(r=>setTimeout(r,10));active--;
    return {status:goal==='fails'?'failed':'completed'};
  },
});
const a=scheduler.spawnWorker({parentId:'owner',role:'researcher',goal:'A',
  requestedCapabilities:['read'],workspaceScope:process.cwd()});
const b=scheduler.spawnWorker({parentId:'owner',role:'researcher',goal:'B',
  requestedCapabilities:['read'],workspaceScope:process.cwd()});
scheduler.spawnWorker({parentId:'owner',role:'reviewer',goal:'dependent',
  dependencies:[a.id,b.id],requestedCapabilities:['read'],workspaceScope:process.cwd()});
const result=await scheduler.run();
record('max-parallel-workers',2,maxActive);
record('dependency-activated',3,invoked);
record('all-finished',3,result.workers.filter(x=>x.status==='completed').length);
const report={
  schema:1,phase:3,fixture:'scripted-no-network',modelRequests:0,networkRequests:0,
  hostCommandExecutions:0,windowsGuestAttested:false,
  total:rows.length,passed:rows.filter(r=>r.passed).length,rows,
  caveat:'Pure coordination benchmark, not autonomous coding quality or Windows security proof.'
};
console.log(JSON.stringify(report));
