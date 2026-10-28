import {useState} from 'react';
import {agentErrorText} from '@/lib/agent-errors';
import {api} from '@/lib/api';
import {useTranslation} from '@/lib/i18n';
import {acceptInOrder,kindFor,pendingSuggestions,suggestReceipt} from '@/lib/objective-suggestions';
import {useAppStore} from '@/store/useAppStore';
import type {Task} from '@/types';

export function ObjectiveAcceptancePanel({task,onAccepted}:{
  task:Task;onAccepted:()=>void;
}){
  const {t}=useTranslation();
  const {showToast}=useAppStore();
  // What the owner chose in a list; a criterion the owner did not touch shows the receipt the page suggests (the latest of the kind it needs).
  const [selection,setSelection]=useState<Record<string,string>>({});
  const [saving,setSaving]=useState<string|null>(null);
  const receipts=task.objectiveReceipts||[];
  const objectives=task.goalPlan?.objectives||[];
  const completed=new Set(objectives.filter(x=>x.status==='verified').map(x=>x.id));
  if(!objectives.length)return null;
  const suggested=pendingSuggestions(objectives,receipts);
  const approve=async(objectiveId:string,criterionIndex:number,receiptId:string)=>{
    setSaving(objectiveId+':'+criterionIndex);
    try{
      await api.acceptCriterion({id:task.id,objectiveId,criterionIndex,receiptId,confirmed:true});
      showToast(t('agents_obj_accepted'),'success');
      onAccepted();
    }catch(e:any){showToast(agentErrorText(e,t,t('agents_obj_failed')),'error');}
    finally{setSaving(null);}
  };
  // The owner's one click for the whole plan: every criterion that is not matched yet and has a suggestion, in the order the Hub needs, each confirmed with the receipt shown in its list.
  const approveSuggested=async()=>{
    setSaving('all');
    try{
      const outcome=await acceptInOrder(suggested,selection,item=>api.acceptCriterion({id:task.id,...item,confirmed:true}));
      if(outcome.failed)showToast(t('agents_obj_batch_failed',{done:outcome.done,message:agentErrorText(outcome.failed.error,t,t('agents_obj_failed'))}),'error');
      else showToast(t('agents_obj_batch_done',{count:outcome.done}),'success');
    }finally{setSaving(null);onAccepted();}
  };
  return <details className="my-3 rounded-xl border border-line bg-panel p-4 text-[13px]"
    data-testid="objective-acceptance">
    <summary className="cursor-pointer font-semibold text-fg">
      {t('agents_obj_summary',{done:completed.size,total:objectives.length})}
    </summary>
    <p className="mt-2 text-muted">{t('agents_obj_intro')}</p>
    <div className="mt-2 flex items-center gap-2">
      <button type="button" data-testid="objective-accept-all" disabled={saving!==null||suggested.length===0}
        onClick={()=>void approveSuggested()}
        className="rounded-lg border border-line bg-surface px-3 py-1.5 font-medium transition-colors hover:bg-hover disabled:opacity-40">
        {t('agents_obj_accept_all',{count:suggested.length})}
      </button>
    </div>
    <div className="mt-2 space-y-3">
      {objectives.map(objective=>{
        const blocked=(objective.dependsOn||[]).some(id=>!completed.has(id));
        return <section key={objective.id} className="border-t border-line-subtle pt-2">
          <p className="font-medium text-fg">{objective.id}: {objective.text}</p>
          <p className="text-faint">{t('agents_obj_status',{status:objective.status})}{blocked?t('agents_obj_waiting'):''}</p>
          {objective.acceptanceCriteria.map((criterion,index)=>{
            const matched=objective.evidence?.some(e=>e.criterionIndex===index&&
              receipts.some(r=>r.receiptId===e.receiptId));
            const key=objective.id+':'+index;
            const options=receipts.filter(r=>r.kind===kindFor(criterion));
            // A criterion that is matched shows the receipt it is matched to; one that is not shows what the owner chose, or else the suggestion.
            const accepted=objective.evidence?.find(e=>e.criterionIndex===index&&receipts.some(r=>r.receiptId===e.receiptId))?.receiptId;
            const receiptId=accepted??selection[key]??suggestReceipt(criterion,receipts)?.receiptId??'';
            return <div key={key} className="mt-1.5 space-y-1">
              <p>{criterion} {matched?'✓':''}</p>
              <div className="flex items-center gap-2">
                <select value={receiptId} onChange={e=>setSelection(prev=>({...prev,[key]:e.target.value}))}
                  aria-label={t('agents_obj_aria',{key})}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface p-1.5">
                  <option value="">{t('agents_obj_choose')}</option>
                  {options.map(r=><option key={r.receiptId} value={r.receiptId}>
                    {r.kind} · {t('agents_obj_step')} {r.step}{r.path?' · '+r.path:''}
                  </option>)}
                </select>
                <button type="button" disabled={blocked||!receiptId||saving!==null||matched}
                  onClick={()=>void approve(objective.id,index,receiptId)}
                  className="rounded-lg border border-line bg-surface px-3 py-1.5 font-medium transition-colors hover:bg-hover disabled:opacity-40">
                  {t('agents_obj_confirm')}
                </button>
              </div>
            </div>;
          })}
        </section>;
      })}
    </div>
  </details>;
}
