import assert from 'node:assert/strict';
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
assert.throws(()=>chooseReadyCodingBatch([
  {id:'b',status:'queued',dependsOn:['forged']},
]),{code:'invalid_coding_batch'});
console.log('PASS: Phase3 owner-declared DAG, cycle rejection, blocked descendants and pre-integration path conflict checks');
