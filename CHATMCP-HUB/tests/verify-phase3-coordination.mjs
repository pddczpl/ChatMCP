import assert from 'node:assert/strict';
import {deriveChildCapabilities} from '../lib/worker-capabilities.mjs';
import {WorkerScheduler} from '../lib/worker-scheduler.mjs';
import path from 'node:path';
import {
  validateCodingTaskGraph,chooseReadyCodingBatch,detectCodingFileConflicts,
} from '../lib/coding-task-dag.mjs';

const plans=[
  {id:'a',dependsOn:[]},{id:'b',dependsOn:['a']},
  {id:'c',dependsOn:['a']},{id:'d',dependsOn:['b','c']},
];
const graph=validateCodingTaskGraph(plans);
assert.deepEqual(graph.map(x=>x.id),['a','b','c','d']);
assert.deepEqual(graph[3].dependsOn,['b','c']);
assert.throws(()=>validateCodingTaskGraph([
  {id:'a',dependsOn:['b']},{id:'b',dependsOn:['a']},
]),{code:'cyclic_coding_dependency'});
assert.throws(()=>validateCodingTaskGraph([
  {id:'a',dependsOn:['missing']},
]),{code:'unknown_coding_dependency'});
assert.throws(()=>validateCodingTaskGraph([
  {id:'a',dependsOn:['a']},
]),{code:'invalid_coding_graph'});
assert.throws(()=>validateCodingTaskGraph([
  {id:'a',dependsOn:['b','b']},{id:'b'},
]),{code:'invalid_coding_graph'});

const nodes=graph.map(x=>({...x,status:'queued'}));
assert.deepEqual(chooseReadyCodingBatch(nodes,2).ready,['a']);
nodes[0].status='ready_for_review';
assert.deepEqual(chooseReadyCodingBatch(nodes,2).ready,['b','c']);
nodes[1].status='failed';
nodes[2].status='ready_for_review';
assert.deepEqual(chooseReadyCodingBatch(nodes,2).blocked,['d']);
nodes[1].status='ready_for_review';
assert.deepEqual(chooseReadyCodingBatch(nodes,2).ready,['d']);

const common=[
  {id:'a',changedFiles:['src/App.tsx','README.md']},
  {id:'b',changedFiles:['src/app.tsx','src/util.ts']},
];
const conflicts=detectCodingFileConflicts(common);
assert.deepEqual(conflicts,[{file:'src/app.tsx',workerIds:['a','b']}]);
assert.deepEqual(detectCodingFileConflicts([
  {id:'a',changedFiles:['src/first.js']},
  {id:'b',changedFiles:['src/second.js']},
]),[]);
assert.throws(()=>detectCodingFileConflicts([
  {id:'a',changedFiles:['../config']},
]),{code:'invalid_worker_file'});
// Fail-closed Windows file aliases and control characters. A malicious
// worker may touch filenames that normal Git line-oriented output obscures.
for(const suspicious of [
  '../config','src/../secret','src//double.js','src/./file.js',
  'src/aux.txt','src/NUL','src/COM1.js','src/evil:stream',
  'src/end.','src/end ','src/line\nbreak.js','C:/host.txt',
  '/absolute.js','\\\\server\\share\\file.js',
]){
  assert.throws(()=>detectCodingFileConflicts([
    {id:'a',changedFiles:[suspicious]},
  ]),{code:'invalid_worker_file'},'Unsafe changed path must fail: '+JSON.stringify(suspicious));
}
assert.deepEqual(detectCodingFileConflicts([
  {id:'a',changedFiles:['src/cafe\u0301.ts']},
  {id:'b',changedFiles:['src/café.ts']},
]),[{file:'src/café.ts',workerIds:['a','b']}],
'Equivalent normalized Unicode paths must be treated as collisions');
assert.deepEqual(detectCodingFileConflicts([
  {id:'a',changedFiles:['src/Foo.ts']},
  {id:'b',changedFiles:['src/foo.ts']},
]),[{file:'src/foo.ts',workerIds:['a','b']}]);

assert.throws(()=>chooseReadyCodingBatch([
  {id:'b',status:'queued',dependsOn:['forged']},
]),{code:'invalid_coding_batch'});
// Extended research/architect/debug roles may only DECREASE inherited rights.
const scope=path.resolve('/tmp/chatmcp-phase3');
const owner={id:'root',workspaceScope:scope,
  capabilities:{read:true,edit:true,checksList:true,checksRun:true,spawn:true}};
const architect=deriveChildCapabilities({
  parent:owner,role:'architect',requested:['read','spawn','edit'],
  workspaceScope:scope,
});
assert.equal(architect.spawn,true);
assert.equal(architect.edit,false);
assert.equal(architect.shell,false);
const debuggerCaps=deriveChildCapabilities({
  parent:owner,role:'debugger',requested:['edit','checksRun'],
  workspaceScope:path.join(scope,'bug'),
});
assert.equal(debuggerCaps.edit,true);
assert.equal(debuggerCaps.integrate,false);
let invoked=0;
const orchestrator=new WorkerScheduler({
  root:owner,authorized:true,maxConcurrent:2,maxWorkers:4,
  executeWorker:async({goal})=>{
    invoked++;
    return goal==='unverified' ? {status:'failed'} : {status:'completed'};
  },
});
const bad=orchestrator.spawnWorker({
  parentId:'root',role:'tester',goal:'unverified',
  requestedCapabilities:['read'],workspaceScope:scope,
});
orchestrator.spawnWorker({
  parentId:'root',role:'reviewer',goal:'dependent',
  dependencies:[bad.id],requestedCapabilities:['read'],workspaceScope:scope,
});
const phase3Run=await orchestrator.run();
assert.equal(invoked,1,'A dependent agent must never run after upstream failure.');
assert.equal(phase3Run.workers.filter(x=>x.status==='failed').length,1);
assert.equal(phase3Run.workers.filter(x=>x.status==='blocked').length,1);

console.log('PASS: Phase3 owner-declared DAG, cycle rejection, blocked descendants and pre-integration path conflict checks');
