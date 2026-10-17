import assert from 'node:assert/strict';
import { decomposeCodingTask, classifyTaskCompletion } from '../lib/agent-autonomy.mjs';
import { acceptObjectiveCriterion, availableObjectiveReceipts } from '../lib/objective-acceptance.mjs';
const plan=decomposeCodingTask('1. Inspect source files for behavior\n2. Implement a patch and test the changed code thoroughly');
assert.ok(plan&&plan.objectives.length===2);
const progress={
 verifiedInspections:[{kind:'inspect',step:1,id:'read-1'}],
 verifiedFiles:[{kind:'edit',step:2,path:'source.js',sha256:'a'.repeat(64)}],
 verifiedChecks:[{kind:'verify',step:3,id:'check-1'}],
 gitReviews:[{kind:'review',step:4,id:'diff-1'}],
};
const all=availableObjectiveReceipts(progress);
assert.equal(all.length,4);
const first=plan.objectives[0];
const inspect=all.find(x=>x.kind==='inspect').receiptId;
assert.throws(()=>acceptObjectiveCriterion(plan,progress,{objectiveId:first.id,criterionIndex:0,receiptId:inspect}),
 {code:'owner_confirmation_required'});
let accepted=acceptObjectiveCriterion(plan,progress,{objectiveId:first.id,criterionIndex:0,receiptId:inspect,confirmed:true});
assert.equal(accepted.objectives[0].status,'verified');
const second=accepted.objectives[1];
for(let i=0;i<second.acceptanceCriteria.length;i++){
 const kind=second.acceptanceCriteria[i].startsWith('Observe')?'inspect':
   second.acceptanceCriteria[i].startsWith('If')?'edit':'verify';
 accepted=acceptObjectiveCriterion(accepted,progress,{objectiveId:second.id,criterionIndex:i,
   receiptId:all.find(x=>x.kind===kind).receiptId,confirmed:true});
}
assert.equal(classifyTaskCompletion(accepted,progress).requirements,'verified');
assert.equal(classifyTaskCompletion(accepted,progress).verification,'owner_accepted_with_fresh_receipts');
const stale={...progress,verifiedChecks:[]};
assert.equal(classifyTaskCompletion(accepted,stale).requirements,'unverified');
assert.throws(()=>acceptObjectiveCriterion(accepted,stale,{
 objectiveId:second.id,criterionIndex:2,receiptId:'verify:3:check-1',confirmed:true}),
 {code:'stale_acceptance_receipt'});
assert.throws(()=>acceptObjectiveCriterion(plan,progress,{objectiveId:plan.objectives[1].id,
 criterionIndex:0,receiptId:inspect,confirmed:true}),{code:'objective_dependency_unverified'});
console.log('PASS receipt-bound owner acceptance and stale-evidence invalidation');
