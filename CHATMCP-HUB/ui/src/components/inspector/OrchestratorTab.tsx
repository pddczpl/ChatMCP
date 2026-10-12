import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/Button';

type Node = {id:string;role:string;question:string;dependsOn:string[]};
const roles = ['planner','researcher','tester','reviewer','security','summarizer'];
const initial:Node[] = [
  {id:'plan',role:'planner',question:'Identify the implementation plan and important modules.',dependsOn:[]},
  {id:'research',role:'researcher',question:'Find existing code patterns and constraints.',dependsOn:[]},
  {id:'review',role:'reviewer',question:'Review potential issues using findings from plan and research.',dependsOn:['plan','research']},
];

export function OrchestratorTab(){
  const {showToast}=useAppStore();
  const [nodes,setNodes]=useState<Node[]>(initial);
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<any>(null);
  const [concurrency,setConcurrency]=useState(2);
  const {data:latest,refetch}=useQuery({queryKey:['delegates'],queryFn:api.getOrchestrator,refetchInterval:4000});
  const edit=(i:number,patch:Partial<Node>)=>setNodes(old=>old.map((v,j)=>j===i?{...v,...patch}:v));
  return <div className="h-full overflow-y-auto p-3 text-xs space-y-3 text-[var(--text)]">
    <div><h3 className="font-semibold text-sm">Multi-Agent Orchestrator</h3>
      <p className="text-[var(--muted)] mt-1">Read-only DAG workers: nghiên cứu, lập kế hoạch, review và tổng hợp. Không cấp công cụ ghi hay terminal cho subagents.</p>
    </div>
    <div className="flex items-center justify-between">
      <span>Song song tối đa</span>
      <select value={concurrency} onChange={e=>setConcurrency(Number(e.target.value))} className="bg-[var(--surface)] border border-[var(--line)] p-1 rounded">
        {[1,2,3].map(n=><option key={n} value={n}>{n}</option>)}
      </select>
    </div>
    {nodes.map((node,i)=><div key={i} className="p-2 rounded border border-[var(--line)] bg-[var(--surface)] space-y-2">
      <div className="flex gap-2">
        <input aria-label="Agent ID" value={node.id} onChange={e=>edit(i,{id:e.target.value})} className="w-24 p-1 rounded border border-[var(--line)] bg-[var(--panel)]" />
        <select aria-label="Role" value={node.role} onChange={e=>edit(i,{role:e.target.value})} className="flex-1 p-1 border border-[var(--line)] bg-[var(--panel)] rounded">{roles.map(r=><option key={r}>{r}</option>)}</select>
        <Button size="sm" variant="danger" disabled={nodes.length===1||busy} onClick={()=>setNodes(old=>old.filter((_,j)=>j!==i))}>Xóa</Button>
      </div>
      <textarea aria-label="Agent question" value={node.question} onChange={e=>edit(i,{question:e.target.value})} rows={2} className="w-full bg-[var(--panel)] border border-[var(--line)] rounded p-1" />
      <input aria-label="Dependencies" value={node.dependsOn.join(',')} placeholder="dependsOn: plan,research" onChange={e=>edit(i,{dependsOn:e.target.value.split(',').map(x=>x.trim()).filter(Boolean)})} className="w-full bg-[var(--panel)] border border-[var(--line)] rounded p-1" />
    </div>)}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={nodes.length>=8||busy} onClick={()=>setNodes(old=>[...old,{id:'worker'+(old.length+1),role:'researcher',question:'Inspect a focused concern in the workspace.',dependsOn:[]}])}>Thêm agent</Button>
      {busy&&<Button size="sm" variant="danger" onClick={async()=>{try{await api.cancelOrchestrator();showToast('Đã yêu cầu hủy orchestration','info');}catch(e:any){showToast(e.message||'Cancel failed','error');}}}>Dừng agents</Button>}
      <Button size="sm" variant="primary" disabled={busy} onClick={async()=>{
        setBusy(true);try{const answer=await api.orchestrateAgents(nodes,concurrency);setResult(answer);showToast('Orchestration: '+answer.status,answer.status==='completed'?'success':'warning');await refetch();}
        catch(e:any){showToast(e.message||'Orchestration failed','error');}
        finally{setBusy(false);}
      }}>{busy?'Đang điều phối...':'Chạy agents'}</Button>
    </div>
    <div className="space-y-2">
      <h4 className="font-semibold">Kết quả gần nhất</h4>
      {(result||latest?.last)?.workers?.map((w:any)=><div key={w.id} className="border border-[var(--line)] rounded p-2"><div className="font-semibold">{w.id} · {w.role||'researcher'} · {w.status}</div><p className="text-[var(--muted)] whitespace-pre-wrap mt-1">{w.summary||w.error||'Chờ chạy...'}</p></div>)}
      {(result||latest?.last)?.conclusion&&<div className="border border-[var(--line)] rounded p-2"><div className="font-semibold">Coordinator synthesis</div><p className="text-[var(--muted)] whitespace-pre-wrap">{(result||latest?.last)?.conclusion}</p></div>}
      {(result||latest?.last)?.error&&<p role="alert" className="text-red-400">{(result||latest?.last)?.error}</p>}
    </div>
  </div>;
}
