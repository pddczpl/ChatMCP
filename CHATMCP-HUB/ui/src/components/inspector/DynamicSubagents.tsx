import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { useAppStore } from '@/store/useAppStore';

export function DynamicSubagents() {
  const {showToast}=useAppStore();
  const [goal,setGoal]=useState('Inspect important modules and propose an evidence-based plan.');
  const [busy,setBusy]=useState(false);
  const {data,refetch,error}=useQuery({
    queryKey:['dynamic-delegates'],queryFn:api.getDynamicDelegates,
    refetchInterval:3000,
  });
  const active=Boolean(data?.activeRunId);
  const last=data?.last;
  return <section className="rounded-lg border border-[var(--line)] p-3 space-y-2 bg-[var(--surface)]">
    <h3 className="font-semibold">Dynamic research subagents (read-only)</h3>
    <p className="text-[var(--muted)]">Your configured model chooses read-only research, planning, review and security workers. No ChatMCP token or spending quota: provider billing remains yours. Workers cannot edit files, execute shell commands or publish.</p>
    <textarea aria-label="Dynamic subagent goal" rows={2} maxLength={2000}
      className="w-full p-2 rounded border border-[var(--line)] bg-[var(--panel)]"
      value={goal} onChange={e=>setGoal(e.target.value)} disabled={active||busy}/>
    <div className="flex gap-2">
      <Button variant="primary" size="sm" disabled={active||busy||!goal.trim()} onClick={async()=>{
        if(window.prompt('Type AUTHORIZE READONLY DELEGATION to start model requests using your configured API provider:')!=='AUTHORIZE READONLY DELEGATION')return;
        setBusy(true);
        try{const value=await api.runDynamicDelegates(goal);await refetch();
          showToast('Dynamic delegation: '+value.status,value.status==='completed'?'success':'warning');}
        catch(e:any){showToast(e?.message||'Could not start dynamic delegation','error');}
        finally{setBusy(false);}
      }}>{busy?'Running…':'Plan and run dynamic subagents'}</Button>
      {active&&<Button size="sm" variant="danger" onClick={async()=>{
        try{await api.cancelDynamicDelegates();await refetch();}
        catch(e:any){showToast(e?.message||'Cancel failed','error');}
      }}>Stop</Button>}
    </div>
    {error&&<p role="alert" className="text-rose-400">{error.message}</p>}
    {last&&<div className="space-y-1">
      <p className="font-semibold">Most recent run: {last.status} · {(last.workers||[]).length} workers</p>
      {(last.workers||[]).map((w:any)=><div key={w.id} className="p-2 border border-[var(--line-subtle)] rounded">
        <strong>{w.role} · {w.id} · {w.status}</strong>
        <p className="text-[var(--muted)] whitespace-pre-wrap">{w.summary||w.error||'No verified summary'}</p>
      </div>)}
      {last.error&&<p role="alert" className="text-rose-400">{last.error}</p>}
    </div>}
  </section>;
}
