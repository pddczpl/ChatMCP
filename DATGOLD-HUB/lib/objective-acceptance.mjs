// Owner-confirmed objective acceptance with first-party tool receipts.
// Neither model narration nor user text can fabricate a receipt.
// Receipts are bound to the tree they were made on (pod-18, docs/PROOF-RECEIPTS.md): only a receipt FRESH on the task's latest tree is offered or can be accepted, and an
// acceptance counts only while the receipt it was made with is fresh. A receipt id carries the prefix of its tree, so an acceptance names the tree it was made on.
import { FRESHNESS, createTaskProgress, receiptFreshness, treeKey } from './agent-progress.mjs';
const TREE_PREFIX=12;
const err=(code,message)=>Object.assign(new Error(message),{code,statusCode:409});
export function objectiveReceiptId(record){
  if(!record||!['inspect','edit','verify','review'].includes(record.kind)||
     !Number.isSafeInteger(record.step)||record.step<0)return null;
  const source=record.sha256||record.id;
  if(typeof source!=='string'||!(/^[a-f0-9]{64}$/i.test(source)||/^[a-zA-Z0-9_-]{1,40}$/.test(source)))
    return null;
  const tree=typeof record.tree==='string'?/:([0-9a-f]{40,64})$/.exec(record.tree)?.[1]:null;
  return record.kind+':'+record.step+':'+source+(tree?'@'+tree.slice(0,TREE_PREFIX):'');
}
/** The receipts that can be accepted: those fresh on `tree` (a tree reference's ids) when given, else on the latest tree the progress knows; in the order they were made. */
export function availableObjectiveReceipts(progress,{tree}={}){
  const p=createTaskProgress(progress);
  const current=tree===undefined?p.tree:treeKey(tree);
  const all=[];
  for(const r of p.receipts){
    const receiptId=objectiveReceiptId(r);
    if(receiptId&&receiptFreshness(r,current)===FRESHNESS.fresh)all.push({
      receiptId,kind:r.kind,step:r.step,...(r.path?{path:r.path}:{}),freshness:FRESHNESS.fresh,
    });
  }
  return all;
}
export const acceptanceKind=criterion=>{
  const s=String(criterion||'');
  return s.startsWith('Observe workspace evidence')?'inspect':
    s.startsWith('If code changes')?'edit':
    s.startsWith('Run required supported checks')?'verify':null;
};
export function hasFreshCriterionEvidence(criterion,index,evidence,all){
  const kind=acceptanceKind(criterion);
  return Boolean(kind&&Array.isArray(evidence)&&evidence.some(record=>
    record.criterionIndex===index &&
    all.some(receipt=>receipt.kind===kind&&receipt.receiptId===record.receiptId)));
}
export function acceptedObjectiveIds(plan,progress,{tree}={}){
  if(!Array.isArray(plan?.objectives))return [];
  const all=availableObjectiveReceipts(progress,{tree});
  return plan.objectives.filter(o=>o.status==='verified' &&
    Array.isArray(o.acceptanceCriteria)&&o.acceptanceCriteria.length>0 &&
    o.acceptanceCriteria.every((criterion,i)=>
      hasFreshCriterionEvidence(criterion,i,o.evidence,all)))
    .map(o=>o.id);
}
/** What the evidence says when the HUB matched a check to its criterion, because the owner turned the option on (lib/agent-options.mjs); the owner's own acceptance says "local_owner". */
export const AUTO_ACCEPTED_BY='auto_hub_check';
/**
 * The owner's option: a criterion that asks for a check ("Run required supported checks...") is matched, by the Hub itself, to the latest passing check that the Hub ran and recorded (the same
 * first-party receipts the owner chooses from), without a click. It RELAXES the rule that only the owner accepts, and only for checks: the criteria that ask to have observed or edited stay the
 * owner's. Everything else of the owner's acceptance holds: a fresh receipt of the right kind, a predecessor objective accepted first (the plan is walked in order, so a check can complete an
 * objective that the next one waits for), a criterion already matched to a current receipt is left as it is, and the evidence is marked so that nobody reads it as the owner's.
 * Returns the same plan object when nothing changed.
 */
export function autoAcceptVerifiedChecks(plan,progress,{at=new Date().toISOString()}={}){
  if(!Array.isArray(plan?.objectives))return plan;
  const all=availableObjectiveReceipts(progress);
  const latest=all.filter(r=>r.kind==='verify').reduce((best,r)=>!best||r.step>=best.step?r:best,null);
  if(!latest)return plan;
  const accepted=new Set(acceptedObjectiveIds(plan,progress));
  let copy=null;
  for(let o=0;o<plan.objectives.length;o++){
    const objective=(copy??plan).objectives[o];
    if(!Array.isArray(objective.acceptanceCriteria)||!objective.acceptanceCriteria.length)continue;
    if((objective.dependsOn||[]).some(id=>!accepted.has(id)))continue;
    for(let i=0;i<objective.acceptanceCriteria.length;i++){
      if(acceptanceKind(objective.acceptanceCriteria[i])!=='verify')continue;
      if(hasFreshCriterionEvidence(objective.acceptanceCriteria[i],i,(copy??plan).objectives[o].evidence,all))continue;
      copy??=structuredClone(plan);
      const target=copy.objectives[o];
      target.evidence=(target.evidence||[]).filter(x=>x.criterionIndex!==i);
      target.evidence.push({criterionIndex:i,receiptId:latest.receiptId,acceptedAt:at,acceptedBy:AUTO_ACCEPTED_BY});
      target.status=target.acceptanceCriteria.every((s,k)=>hasFreshCriterionEvidence(s,k,target.evidence,all))?'verified':'has_evidence';
    }
    if(((copy??plan).objectives[o]).status==='verified')accepted.add(objective.id);
  }
  return copy??plan;
}
export function acceptObjectiveCriterion(plan,progress,{objectiveId,criterionIndex,receiptId,confirmed,tree}={}){
  if(confirmed!==true)throw err('owner_confirmation_required','Owner confirmation is required.');
  if(!Array.isArray(plan?.objectives))throw err('acceptance_not_applicable','This task has no acceptance plan.');
  const index=plan.objectives.findIndex(o=>o.id===objectiveId);
  if(index<0||!Number.isSafeInteger(criterionIndex)||criterionIndex<0)
    throw err('invalid_objective','Unknown objective or criterion.');
  const target=plan.objectives[index],criterion=target.acceptanceCriteria?.[criterionIndex];
  const kind=acceptanceKind(criterion);
  if(!kind)throw err('invalid_criterion','Criterion cannot be independently mapped to a receipt.');
  // Fresh at accept time: judged now, against the latest tree the task knows (or the tree given), not when the receipt was made.
  const receipts=availableObjectiveReceipts(progress,{tree});
  if(!receipts.some(r=>r.kind===kind&&r.receiptId===receiptId))
    throw err('stale_acceptance_receipt','Select a fresh first-party receipt for this criterion.');
  const accepted=new Set(acceptedObjectiveIds(plan,progress,{tree}));
  if((target.dependsOn||[]).some(id=>!accepted.has(id)))
    throw err('objective_dependency_unverified','Accept predecessor objectives first.');
  const copy=structuredClone(plan),next=copy.objectives[index];
  next.evidence=(next.evidence||[]).filter(x=>x.criterionIndex!==criterionIndex);
  next.evidence.push({criterionIndex,receiptId,acceptedAt:new Date().toISOString(),acceptedBy:'local_owner'});
  next.status=next.acceptanceCriteria.every((s,i)=>
    hasFreshCriterionEvidence(s,i,next.evidence,receipts))?'verified':'has_evidence';
  return copy;
}
