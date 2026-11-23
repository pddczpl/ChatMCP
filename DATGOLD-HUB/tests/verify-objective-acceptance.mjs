import assert from 'node:assert/strict';
import { decomposeCodingTask, classifyTaskCompletion } from '../lib/agent-autonomy.mjs';
import { AUTO_ACCEPTED_BY, acceptObjectiveCriterion, acceptedObjectiveIds, autoAcceptVerifiedChecks, availableObjectiveReceipts, objectiveReceiptId } from '../lib/objective-acceptance.mjs';
import { treeKey } from '../lib/agent-progress.mjs';
// Receipts are bound to the tree they were made on (pod-18): only a receipt fresh on the task's latest tree can be accepted, and an acceptance counts only while its receipt is fresh.
const T=(c)=>({status:'ok',treeAlgorithm:'git-pinned-v1',objectFormat:'sha1',tree:c.repeat(40),rawTree:null});
const K=(c)=>treeKey(T(c));
const on=(c,receipts)=>({version:1,tree:c===null?null:K(c),receipts});
const plan=decomposeCodingTask('1. Inspect source files and project requirements, capture independently verified read evidence before editing any source code.\n2. Implement a bounded source patch and test the changed code thoroughly with real command exit status and actual Git review evidence.');
assert.ok(plan&&plan.objectives.length===2);
const RECEIPTS=[{kind:'inspect',step:1,id:'read-1',tree:K('b')},{kind:'edit',step:2,path:'source.js',sha256:'e'.repeat(64),tree:K('b')},
 {kind:'verify',step:3,id:'check-1',tree:K('b')},{kind:'review',step:4,id:'diff-1',tree:K('b')}];
const progress=on('b',RECEIPTS);
const all=availableObjectiveReceipts(progress);
assert.equal(all.length,4);
assert.deepEqual(all.map(x=>x.receiptId),['inspect:1:read-1@'+'b'.repeat(12),'edit:2:'+'e'.repeat(64)+'@'+'b'.repeat(12),'verify:3:check-1@'+'b'.repeat(12),'review:4:diff-1@'+'b'.repeat(12)],'a receipt id carries the prefix of its tree');
assert.ok(all.every(x=>x.freshness==='fresh'),'only fresh receipts are offered');
assert.equal(objectiveReceiptId({kind:'verify',step:3,id:'check-1',tree:null}),'verify:3:check-1','a receipt without a tree has no tree prefix');
assert.equal(objectiveReceiptId({kind:'verify',step:3,id:'check-1',tree:'not a key'}),'verify:3:check-1');
// Stale (the tree changed after them), unknown (the Hub does not know the tree) and old (saved before receipts had trees): none is offered.
assert.deepEqual(availableObjectiveReceipts(on('c',RECEIPTS)),[],'stale receipts are not offered');
assert.deepEqual(availableObjectiveReceipts(on(null,RECEIPTS)),[],'receipts of unknown freshness are not offered');
assert.deepEqual(availableObjectiveReceipts({version:1,verifiedChecks:[{kind:'verify',step:3,id:'check-1'}]}),[],"an old task's receipts: freshness unknown, not offered");
assert.equal(availableObjectiveReceipts(on('c',RECEIPTS),{tree:T('b')}).length,4,'judged against a tree given by the caller');
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
// A later tree: the acceptances were made with receipts of a tree that is gone, so they no longer count, and the same receipts cannot be accepted again.
const stale=on('c',RECEIPTS);
assert.equal(classifyTaskCompletion(accepted,stale).requirements,'unverified');
assert.deepEqual(acceptedObjectiveIds(accepted,stale),[],'an acceptance counts only while its receipt is fresh');
for(const later of [stale,on(null,RECEIPTS)])assert.throws(()=>acceptObjectiveCriterion(accepted,later,{
 objectiveId:second.id,criterionIndex:2,receiptId:all.find(x=>x.kind==='verify').receiptId,confirmed:true}),
 {code:'stale_acceptance_receipt'},'accepting requires the receipt to be fresh at accept time');
assert.throws(()=>acceptObjectiveCriterion(plan,progress,{objectiveId:first.id,criterionIndex:0,receiptId:'inspect:1:read-1',confirmed:true}),{code:'stale_acceptance_receipt'},'an id without its tree prefix (an old one) is not a fresh receipt');
// The files come back to the tree the receipts were made on: fresh again, and so is the acceptance.
assert.deepEqual(acceptedObjectiveIds(accepted,on('b',RECEIPTS)),acceptedObjectiveIds(accepted,progress));
assert.equal(classifyTaskCompletion(accepted,stale,{tree:T('b')}).requirements,'verified','the final tree can be given');
assert.equal(acceptObjectiveCriterion(accepted,stale,{objectiveId:second.id,criterionIndex:2,receiptId:all.find(x=>x.kind==='verify').receiptId,confirmed:true,tree:T('b')}).objectives[1].status,'verified','and to an acceptance');
assert.throws(()=>acceptObjectiveCriterion(plan,progress,{objectiveId:plan.objectives[1].id,
 criterionIndex:0,receiptId:inspect,confirmed:true}),{code:'objective_dependency_unverified'});
console.log('PASS receipt-bound owner acceptance and stale-evidence invalidation');

// ---- the owner's option: the Hub itself matches the checks it ran (Settings; off unless the owner turns it on) ------------------------------------------------------------------------------
// It RELAXES "only the owner accepts", for the criteria that ask for a check and nothing else, and everything else of the acceptance holds: a fresh receipt of the right kind, a predecessor
// accepted first, and the evidence says who did it.
{
  const fresh=decomposeCodingTask('1. Inspect source files and project requirements, capture independently verified read evidence before editing any source code.\n2. Implement a bounded source patch and test the changed code thoroughly with real command exit status and actual Git review evidence.');
  const withChecks=on('b',[...RECEIPTS,{kind:'verify',step:6,id:'check-2',tree:K('b')}]);
  const ids=availableObjectiveReceipts(withChecks);
  const verifyIds=ids.filter(x=>x.kind==='verify').map(x=>x.receiptId);
  assert.equal(autoAcceptVerifiedChecks(fresh,on('b',RECEIPTS.filter(x=>x.kind!=='verify'))),fresh,'no check was run: the same plan, nothing accepted');
  assert.equal(autoAcceptVerifiedChecks(fresh,on('c',[...RECEIPTS,{kind:'verify',step:7,id:'check-3',tree:K('b')}])),fresh,'a check of a tree that is gone is not matched');
  assert.equal(autoAcceptVerifiedChecks(null,withChecks),null,'no plan: nothing');
  assert.equal(autoAcceptVerifiedChecks(fresh,withChecks),fresh,'objective-2 waits for objective-1, as it does for the owner: its check is not matched yet');
  // the owner accepts the inspection of objective-1; then the check of objective-2 can be matched, with the LATEST check
  const ownerFirst=acceptObjectiveCriterion(fresh,withChecks,{objectiveId:'objective-1',criterionIndex:0,receiptId:ids.find(x=>x.kind==='inspect').receiptId,confirmed:true});
  const auto=autoAcceptVerifiedChecks(ownerFirst,withChecks,{at:'2026-10-28T00:00:00.000Z'});
  assert.notEqual(auto,ownerFirst);
  const second=auto.objectives[1];
  assert.deepEqual(second.evidence,[{criterionIndex:2,receiptId:verifyIds[1],acceptedAt:'2026-10-28T00:00:00.000Z',acceptedBy:AUTO_ACCEPTED_BY}],'only the criterion that asks for a check, with the latest check, marked as the Hub\'s');
  assert.equal(AUTO_ACCEPTED_BY,'auto_hub_check');
  assert.equal(second.status,'has_evidence','the other two criteria (observe, edit) stay the owner\'s: the objective is not verified');
  assert.deepEqual(auto.objectives[0].evidence,ownerFirst.objectives[0].evidence,'what the owner accepted is untouched');
  assert.equal(autoAcceptVerifiedChecks(auto,withChecks),auto,'asked again: the same plan');
  // the owner finishes the objective: it is verified, and what is said of the completion says that the Hub accepted a check
  let done=auto;
  for(const [index,kind] of [[0,'inspect'],[1,'edit']])done=acceptObjectiveCriterion(done,withChecks,{objectiveId:'objective-2',criterionIndex:index,receiptId:ids.find(x=>x.kind===kind).receiptId,confirmed:true});
  assert.deepEqual(acceptedObjectiveIds(done,withChecks),['objective-1','objective-2']);
  assert.equal(classifyTaskCompletion(done,withChecks).verification,'accepted_with_fresh_receipts_checks_by_hub','not "owner_accepted": a check was accepted by the Hub');
  const allOwner=acceptObjectiveCriterion(done,withChecks,{objectiveId:'objective-2',criterionIndex:2,receiptId:verifyIds[1],confirmed:true});
  assert.equal(classifyTaskCompletion(allOwner,withChecks).verification,'owner_accepted_with_fresh_receipts','the owner replaced it with their own acceptance: all the owner\'s again');
  // a criterion the owner already matched to a current check is left alone
  const ownerChecks=acceptObjectiveCriterion(ownerFirst,withChecks,{objectiveId:'objective-2',criterionIndex:2,receiptId:verifyIds[0],confirmed:true});
  assert.equal(autoAcceptVerifiedChecks(ownerChecks,withChecks),ownerChecks,'matched by the owner to a current receipt: not matched again by the Hub');
  // nothing can forge the mark: the owner's call takes no "acceptedBy"
  const forged=acceptObjectiveCriterion(fresh,withChecks,{objectiveId:'objective-1',criterionIndex:0,receiptId:ids.find(x=>x.kind==='inspect').receiptId,confirmed:true,acceptedBy:AUTO_ACCEPTED_BY});
  assert.equal(forged.objectives[0].evidence[0].acceptedBy,'local_owner');
  // a file changed after it: the checks are gone, so is the acceptance of the check, and the Hub does not match what does not exist
  const stale=on('b',[...RECEIPTS.filter(x=>x.kind!=='verify'),{kind:'edit',step:7,path:'source.js',sha256:'f'.repeat(64),tree:K('c')}]);
  stale.tree=K('c');
  assert.equal(acceptedObjectiveIds(auto,stale).includes('objective-2'),false);
  assert.equal(autoAcceptVerifiedChecks(auto,stale),auto,'no check to match any more: the plan is left as it is (its stale evidence counts for nothing)');
  console.log('PASS the owner\'s option: the Hub matches only the criteria that ask for a check, with its latest passing check, after the predecessor, marked as its own; stale or forged does not count');
}
