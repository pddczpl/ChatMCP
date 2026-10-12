import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

type Check = { id:string; from:string; command:string; approvedGrantId?:string|null; remainingAttempts?:number };
function WorkerChecks({workerId}:{workerId:string}) {
  const client=useQueryClient();
  const [confirmation,setConfirmation]=useState<string|null>(null);
  const {data,isLoading,error}=useQuery({
    queryKey:['worker-checks',workerId],queryFn:()=>api.getWorkerChecks(workerId),
    refetchInterval:3000,
  });
  const grant=useMutation({
    mutationFn:(checkId:string)=>api.approveIsolatedCheck(workerId,checkId,3),
    onSuccess:()=>{setConfirmation(null);void client.invalidateQueries({queryKey:['worker-checks',workerId]});},
  });
  return <div className="border border-[var(--line)] rounded-lg p-2 space-y-2">
    <p className="text-[11px] font-semibold">Worker: {workerId} · Registered tests</p>
    {isLoading && <p role="status">Discovering project checks…</p>}
    {error && <p role="alert" className="text-rose-400">Cannot discover registered checks: {error.message}</p>}
    {data?.checks?.length===0 && <p className="text-[var(--faint)]">No registered offline test command.</p>}
    {(data?.checks as Check[]|undefined)?.map(check=><div key={check.id} className="p-2 border border-[var(--line-subtle)] rounded">
      <p className="font-mono break-words">{check.command}</p>
      <p className="text-[var(--faint)]">From {check.from} · Check ID {check.id}</p>
      {check.approvedGrantId
        ? <p className="text-sky-400">Approved isolated check grant · {check.remainingAttempts} attempts remaining. Windows Sandbox must still be available.</p>
        : confirmation!==check.id
          ? <button className="mt-1 rounded border border-[var(--line)] px-2 py-1" onClick={()=>setConfirmation(check.id)}>Review grant</button>
          : <div className="space-y-1 mt-1">
              <p>Allow this specific check to run up to three times inside verified Windows Sandbox? This does not permit host shell execution.</p>
              <button disabled={grant.isPending} className="rounded border px-2 py-1" onClick={()=>grant.mutate(check.id)}>Approve isolated check</button>
              <button className="rounded border px-2 py-1 ml-2" onClick={()=>setConfirmation(null)}>Cancel</button>
            </div>}
      {grant.error && confirmation===check.id && <p role="alert" className="text-rose-400">Grant blocked: {grant.error.message}</p>}
    </div>)}
  </div>;
}
export function IsolatedChecksPanel() {
  const {data,error}=useQuery({queryKey:['coding-runs'],queryFn:api.getCodingRuns,refetchInterval:3000});
  if(error || !data?.activeRunId || !Array.isArray(data.jobs)) return null;
  const job=data.jobs.find((x:{id:string})=>x.id===data.activeRunId);
  const workers=(job?.workers??[]).filter((w:{status:string})=>w.status==='running');
  if(!workers.length)return null;
  return <section data-testid="isolated-checks-panel" className="space-y-2 border-t border-[var(--line-subtle)] pt-3">
    <h3 className="font-semibold uppercase text-[11px] text-[var(--muted)]">Owner-approved isolated checks</h3>
    <p className="text-[var(--faint)]">Grants are bound to worker, check definition, retry limit, and current permission policy. Approval cannot enable an unverified Sandbox backend.</p>
    {workers.map((w:{id:string})=><WorkerChecks key={w.id} workerId={w.id}/>)}
  </section>;
}
