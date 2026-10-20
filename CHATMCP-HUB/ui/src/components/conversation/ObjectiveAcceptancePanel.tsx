import {useState} from 'react';
import {api} from '@/lib/api';
import {useAppStore} from '@/store/useAppStore';
import type {Task} from '@/types';

const kindFor=(criterion:string):'inspect'|'edit'|'verify'|null=>criterion.startsWith('Observe workspace evidence')?'inspect':
  criterion.startsWith('If code changes')?'edit':
  criterion.startsWith('Run required supported checks')?'verify':null;

export function ObjectiveAcceptancePanel({task,onAccepted}:{
  task:Task;onAccepted:()=>void;
}){
  const {showToast}=useAppStore();
  const [selection,setSelection]=useState<Record<string,string>>({});
  const [saving,setSaving]=useState<string|null>(null);
  const receipts=task.objectiveReceipts||[];
  const objectives=task.goalPlan?.objectives||[];
  const completed=new Set(objectives.filter(x=>x.status==='verified').map(x=>x.id));
  if(!objectives.length)return null;
  const approve=async(objectiveId:string,criterionIndex:number,receiptId:string)=>{
    setSaving(objectiveId+':'+criterionIndex);
    try{
      await api.acceptCriterion({id:task.id,objectiveId,criterionIndex,receiptId,confirmed:true});
      showToast('Evidence accepted for this criterion.','success');
      onAccepted();
    }catch(e:any){showToast(e.message||'Evidence acceptance failed.','error');}
    finally{setSaving(null);}
  };
  return <details className="my-3 rounded-xl border border-line bg-panel p-4 text-[13px]"
    data-testid="objective-acceptance">
    <summary className="cursor-pointer font-semibold text-fg">
      Objective acceptance · {objectives.filter(x=>x.status==='verified').length}/{objectives.length} verified
    </summary>
    <p className="mt-2 text-muted">
      A model response is not verification. Review each criterion and match it to a current
      first-party tool receipt. No automatic acceptance; receipts can become stale after edits.
    </p>
    <div className="mt-2 space-y-3">
      {objectives.map(objective=>{
        const blocked=(objective.dependsOn||[]).some(id=>!completed.has(id));
        return <section key={objective.id} className="border-t border-line-subtle pt-2">
          <p className="font-medium text-fg">{objective.id}: {objective.text}</p>
          <p className="text-faint">Status: {objective.status}{blocked?' · waiting for predecessor':''}</p>
          {objective.acceptanceCriteria.map((criterion,index)=>{
            const matched=objective.evidence?.some(e=>e.criterionIndex===index&&
              receipts.some(r=>r.receiptId===e.receiptId));
            const key=objective.id+':'+index;
            const options=receipts.filter(r=>r.kind===kindFor(criterion));
            const receiptId=selection[key]||'';
            return <div key={key} className="mt-1.5 space-y-1">
              <p>{criterion} {matched?'✓':''}</p>
              <div className="flex items-center gap-2">
                <select value={receiptId} onChange={e=>setSelection(prev=>({...prev,[key]:e.target.value}))}
                  aria-label={'Acceptance evidence '+key}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface p-1.5">
                  <option value="">Choose a verified receipt</option>
                  {options.map(r=><option key={r.receiptId} value={r.receiptId}>
                    {r.kind} · step {r.step}{r.path?' · '+r.path:''}
                  </option>)}
                </select>
                <button type="button" disabled={blocked||!receiptId||saving!==null||matched}
                  onClick={()=>void approve(objective.id,index,receiptId)}
                  className="rounded-lg border border-line bg-surface px-3 py-1.5 font-medium transition-colors hover:bg-hover disabled:opacity-40">
                  Confirm
                </button>
              </div>
            </div>;
          })}
        </section>;
      })}
    </div>
  </details>;
}
