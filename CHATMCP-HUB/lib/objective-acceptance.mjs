// Owner-confirmed objective acceptance with first-party tool receipts.
// Neither model narration nor user text can fabricate a receipt.
const err=(code,message)=>Object.assign(new Error(message),{code,statusCode:409});
export function objectiveReceiptId(record){
  if(!record||!['inspect','edit','verify','review'].includes(record.kind)||
     !Number.isSafeInteger(record.step)||record.step<0)return null;
  const source=record.sha256||record.id;
  if(typeof source!=='string'||!(/^[a-f0-9]{64}$/i.test(source)||/^[a-zA-Z0-9_-]{1,40}$/.test(source)))
    return null;
  return record.kind+':'+record.step+':'+source;
}
export function availableObjectiveReceipts(progress){
  const all=[];
  for(const [bucket,kind] of [
    ['verifiedInspections','inspect'],['verifiedFiles','edit'],
    ['verifiedChecks','verify'],['gitReviews','review']]){
    for(const r of Array.isArray(progress?.[bucket])?progress[bucket]:[]){
      const receiptId=objectiveReceiptId(r);
      if(r.kind===kind&&receiptId)all.push({
        receiptId,kind,step:r.step,...(r.path?{path:r.path}:{}),
      });
    }
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
export function acceptedObjectiveIds(plan,progress){
  if(!Array.isArray(plan?.objectives))return [];
  const all=availableObjectiveReceipts(progress);
  return plan.objectives.filter(o=>o.status==='verified' &&
    Array.isArray(o.acceptanceCriteria)&&o.acceptanceCriteria.length>0 &&
    o.acceptanceCriteria.every((criterion,i)=>
      hasFreshCriterionEvidence(criterion,i,o.evidence,all)))
    .map(o=>o.id);
}
export function acceptObjectiveCriterion(plan,progress,{objectiveId,criterionIndex,receiptId,confirmed}={}){
  if(confirmed!==true)throw err('owner_confirmation_required','Owner confirmation is required.');
  if(!Array.isArray(plan?.objectives))throw err('acceptance_not_applicable','This task has no acceptance plan.');
  const index=plan.objectives.findIndex(o=>o.id===objectiveId);
  if(index<0||!Number.isSafeInteger(criterionIndex)||criterionIndex<0)
    throw err('invalid_objective','Unknown objective or criterion.');
  const target=plan.objectives[index],criterion=target.acceptanceCriteria?.[criterionIndex];
  const kind=acceptanceKind(criterion);
  if(!kind)throw err('invalid_criterion','Criterion cannot be independently mapped to a receipt.');
  const receipts=availableObjectiveReceipts(progress);
  if(!receipts.some(r=>r.kind===kind&&r.receiptId===receiptId))
    throw err('stale_acceptance_receipt','Select a fresh first-party receipt for this criterion.');
  const accepted=new Set(acceptedObjectiveIds(plan,progress));
  if((target.dependsOn||[]).some(id=>!accepted.has(id)))
    throw err('objective_dependency_unverified','Accept predecessor objectives first.');
  const copy=structuredClone(plan),next=copy.objectives[index];
  next.evidence=(next.evidence||[]).filter(x=>x.criterionIndex!==criterionIndex);
  next.evidence.push({criterionIndex,receiptId,acceptedAt:new Date().toISOString(),acceptedBy:'local_owner'});
  next.status=next.acceptanceCriteria.every((s,i)=>
    hasFreshCriterionEvidence(s,i,next.evidence,receipts))?'verified':'has_evidence';
  return copy;
}
