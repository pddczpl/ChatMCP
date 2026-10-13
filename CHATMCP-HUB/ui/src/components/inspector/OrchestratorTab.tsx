import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/Button';
import { IsolatedChecksPanel } from './IsolatedChecksPanel';
import { DynamicSubagents } from './DynamicSubagents';

type Node = {id:string;role:string;question:string;dependsOn:string[]};
type CodingTask = {id:string;prompt:string;verify:boolean;dependsOn:string[]};
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
  const [codingTasks,setCodingTasks]=useState<CodingTask[]>([{id:'task-a',prompt:'Implement the first independent coding task.',verify:false,dependsOn:[]}]);
  const [codingBusy,setCodingBusy]=useState(false);
  const [codingRun,setCodingRun]=useState<any>(null);
  const [codingContext,setCodingContext]=useState<any>(null);
  const [codingRecovery,setCodingRecovery]=useState<any>(null);
  const {data:codingState,refetch:refetchCoding}=useQuery({queryKey:['codingWorkers'],queryFn:api.getCodingRuns,refetchInterval:3000});
  const activeCoding=codingState?.jobs?.find((x:any)=>x.id===codingRun?.id)||codingRun||codingState?.jobs?.at(-1);
  const [selectedWorkers,setSelectedWorkers]=useState<string[]>([]);
  const [reviewedTokens,setReviewedTokens]=useState<Record<string,string>>({});
  const [codingReview,setCodingReview]=useState<any>(null);
  const showCodingDiff=async(runId:string,workerId?:string)=>{
    try{
      const review=await api.getCodingDiff(runId,workerId);
      setCodingReview(review);
      setReviewedTokens(current=>({...current,[workerId||'integration']:review.reviewToken}));
      showToast('Diff retrieved for review. Inspect it before continuing.','info');
    }catch(e:any){showToast(e.message||'Cannot review branch diff','error');}
  };
  const {data:latest,refetch}=useQuery({queryKey:['delegates'],queryFn:api.getOrchestrator,refetchInterval:4000});
  const edit=(i:number,patch:Partial<Node>)=>setNodes(old=>old.map((v,j)=>j===i?{...v,...patch}:v));
  return <div className="h-full overflow-y-auto p-3 text-xs space-y-3 text-[var(--text)]">
    <div><h3 className="font-semibold text-sm">Multi-Agent Orchestrator</h3>
      <p className="text-[var(--muted)] mt-1">Standalone desktop AI agents with your configured Base URL/model/API key. Provider usage and costs remain under your account; ChatMCP has no model token/spend quota. Read-only DAG workers cannot execute host commands.</p>
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

    <DynamicSubagents />
    <section className="border border-[var(--line)] rounded-lg p-3 bg-[var(--surface)] space-y-2">
      <h3 className="font-semibold">Coding Agents — isolated Git worktrees</h3>
      <p className="text-[var(--muted)]">Parallel coding workers edit only their own branches. No shell, network, Git push or automatic merge. Worktrees isolate Git state, not OS processes.</p>
      {codingTasks.map((x,i)=><div key={i} className="p-2 rounded border border-[var(--line-subtle)] space-y-1">
        <div className="flex gap-2">
          <input aria-label="Coder ID" className="w-32 p-1 bg-[var(--panel)] rounded border border-[var(--line)]" value={x.id} onChange={e=>setCodingTasks(a=>a.map((v,j)=>j===i?{...v,id:e.target.value}:v))}/>
          <Button size="sm" variant="danger" disabled={codingBusy||codingTasks.length<=1} onClick={()=>setCodingTasks(a=>a.filter((_,j)=>j!==i))}>Xóa</Button>
        </div>
        <textarea aria-label="Coding task" rows={2} className="w-full p-1 rounded border border-[var(--line)] bg-[var(--panel)]" value={x.prompt} onChange={e=>setCodingTasks(a=>a.map((v,j)=>j===i?{...v,prompt:e.target.value}:v))}/>
        <input aria-label="Coding dependencies" className="w-full p-1 rounded border border-[var(--line)] bg-[var(--panel)]"
          placeholder="Dependencies by coder ID, e.g. task-a,task-b" value={x.dependsOn.join(',')}
          disabled={codingBusy}
          onChange={e=>setCodingTasks(a=>a.map((v,j)=>j===i?
            {...v,dependsOn:e.target.value.split(',').map(id=>id.trim()).filter(Boolean)}:v))}/>
        <p className="text-[10px] text-[var(--muted)]">Owner-defined dependency order; downstream worktrees inherit only finished predecessor commits via trusted GitRunner.</p>
        <label className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
          <input type="checkbox" checked={x.verify} disabled={codingBusy}
            onChange={e=>setCodingTasks(a=>a.map((v,j)=>j===i?{...v,verify:e.target.checked}:v))}/>
          Require signed isolated test evidence before ready-for-review. Unsupported systems will report needs_attention; the agent never runs a host shell.
        </label>
      </div>)}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={codingTasks.length>=4||codingBusy} onClick={()=>setCodingTasks(a=>[...a,{id:'task-'+(a.length+1),prompt:'Describe the next coding task.',verify:false,dependsOn:[]}])}>Add coding worker</Button>
        <Button size="sm" variant="primary" disabled={codingBusy||Boolean(codingState?.activeRunId)} onClick={async()=>{
          if(!confirm('Create Git branches/worktrees, granting limited file-write access to the selected AI model? No shell and no automatic merge.'))return;
          setCodingBusy(true);try{const j=await api.runCodingAgents(codingTasks,Math.min(concurrency,2));setCodingRun(j);setReviewedTokens({});setCodingReview(null);setCodingRecovery(null);setSelectedWorkers((j.workers||[]).filter((w:any)=>w.status==='ready_for_review').map((w:any)=>w.id));await refetchCoding();showToast('Coding workers: '+j.status,'success');}
          catch(e:any){showToast(e.message||'Coding workers failed','error');}finally{setCodingBusy(false);}
        }}>{codingBusy?'Running...':'Run coding workers'}</Button>
        {(codingBusy||codingState?.activeRunId)&&<Button size="sm" variant="danger" onClick={async()=>{try{await api.cancelCodingAgents();showToast('Stop requested','info');}catch(e:any){showToast(e.message||'Stop failed','error');}}}>Stop</Button>}
      </div>
      <IsolatedChecksPanel />
      {codingState?.recoveryFault&&<p role="alert" className="text-red-400 border border-red-400 rounded p-2">
        Coding recovery locked: {codingState.recoveryFault}. Inspect the local recovery journal; no interrupted tools will be replayed.
      </p>}
      {activeCoding&&<div className="space-y-2 border-t border-[var(--line)] pt-2">
        <div className="font-semibold">Run {activeCoding.id?.slice(0,8)} — {activeCoding.status}</div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={async()=>{
            try{
              const report=await api.getCodingRecovery(activeCoding.id);
              setCodingRecovery(report);
              showToast('Recovery checkpoint inspected (no automatic replay).','info');
            }catch(e:any){
              setCodingRecovery(null);
              showToast(e.message||'Recovery journal unavailable; manual review required.','error');
            }
          }}>Inspect recovery</Button>
          {activeCoding.status==='interrupted'&&codingRecovery?.runId===activeCoding.id&&
            codingRecovery.found&&codingRecovery.integrityDigest&&
            <Button size="sm" variant="outline" disabled={codingBusy} onClick={async()=>{
              if(prompt('Review the interrupted worktree and checkpoint first. Type REVIEW INTERRUPTED RUN to mark it needs_attention (NO automatic resume)')!=='REVIEW INTERRUPTED RUN')return;
              setCodingBusy(true);
              try{
                await api.acknowledgeCodingRecovery(activeCoding.id,codingRecovery.integrityDigest);
                setCodingRecovery(null);
                await refetchCoding();
                showToast('Interrupted run acknowledged; fresh manual review and verification remain required.','warning');
              }catch(e:any){showToast(e.message||'Recovery checkpoint changed; re-inspect before acknowledgement.','error');}
              finally{setCodingBusy(false);}
            }}>Acknowledge interrupted run</Button>}
          <span className="text-[10px] text-[var(--muted)]">Crash recovery is read-only. No uncertain tool/test/merge is replayed.</span>
        </div>
        {codingRecovery?.runId===activeCoding.id&&
          <div role="status" data-testid="coding-recovery-status" className="p-2 border border-[var(--line-subtle)] rounded text-[11px]">
            Journal: {codingRecovery.found?'found':'unavailable'} · Last: {codingRecovery.status||'unknown'} ·
            Entries: {codingRecovery.entries??0} · Human review required ·
            Automatic replay: disabled · Prior test receipts: not re-attested.
          </div>
        }
        {(activeCoding.workers||[]).map((w:any)=><div key={w.id} className="p-2 border border-[var(--line-subtle)] rounded">
          <label className="flex gap-2 items-center">
            <input type="checkbox" disabled={w.status!=='ready_for_review'} checked={selectedWorkers.includes(w.id)} onChange={e=>setSelectedWorkers(a=>e.target.checked?[...a,w.id]:a.filter(id=>id!==w.id))}/>
            <strong>{w.id} · {w.status}</strong>
          </label>
          <p className="text-[10px] text-[var(--muted)] break-all">{w.branch}</p>
          {w.dependsOn?.length>0&&<p className="text-[11px] text-[var(--muted)]">Depends on: {w.dependsOn.join(', ')}</p>}
          {w.inheritedCommits&&<p className="text-[10px] text-[var(--muted)]">Pinned upstream commits: {Object.entries(w.inheritedCommits).map(([id,sha])=>id+':'+String(sha).slice(0,8)).join(', ')}</p>}
          <p>Changed: {(w.changedFiles||[]).join(', ')||'none'}</p>
          {w.status==='ready_for_review'&&<Button size="sm" variant="outline" disabled={codingBusy} onClick={()=>showCodingDiff(activeCoding.id,w.id)}>Review diff</Button>}
          {w.status==='ready_for_review'&&<Button size="sm" variant="outline" disabled={codingBusy} onClick={async()=>{
            try{setCodingContext(await api.getCodingContext(activeCoding.id,w.id));showToast('Bounded file preview loaded; never auto-sent to AI.','info');}
            catch(e:any){setCodingContext(null);showToast(e.message||'Unable to preview worker files','error');}
          }}>Preview changed files</Button>}
          {w.status==='ready_for_review'&&<Button size="sm" variant="outline" disabled={codingBusy||!reviewedTokens[w.id]} onClick={async()=>{
            if(prompt('Type PUBLISH DRAFT PR to push ONLY worker '+w.id+' and create a draft GitHub PR')!=='PUBLISH DRAFT PR')return;
            setCodingBusy(true);try{const result=await api.publishCodingAgents(activeCoding.id,reviewedTokens[w.id],w.id);showToast('Worker Draft PR: '+result.prUrl,'success');await refetchCoding();}
            catch(e:any){showToast(e.message||'Worker publishing failed','error');}finally{setCodingBusy(false);}
          }}>Draft PR for {w.id}</Button>}
          {w.prUrl&&<p className="text-[var(--muted)] break-all">PR: {w.prUrl}</p>}
          {w.verifyRequired && <p className="text-[11px] text-sky-400">Verified coding requested: {w.verificationOutcome?.state||'awaiting signed checks'}. A model's completion is not test evidence.</p>}
          {w.verificationAttempts?.length>0 && <p className="text-[11px] text-[var(--muted)]">Recorded attempts: {w.verificationAttempts.length} · parsed passes: {w.verificationAttempts.filter((a:any)=>a.testOutcomeVerified===true).length}</p>}
          {w.summary&&<p className="text-[var(--muted)] whitespace-pre-wrap">{w.summary}</p>}{w.error&&<p role="alert" className="text-red-400">{w.error}</p>}
        </div>)}
        {activeCoding.integration&&<p>Integration: {activeCoding.integration.status} · {activeCoding.integration.branch}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!selectedWorkers.length||codingBusy||selectedWorkers.some(id=>!reviewedTokens[id])} onClick={async()=>{
            if(prompt('Type INTEGRATE WORKTREES to merge these workers into a NEW integration branch')!=='INTEGRATE WORKTREES')return;
            setCodingBusy(true);try{const v=await api.integrateCodingAgents(activeCoding.id,selectedWorkers,reviewedTokens);showToast('Integration: '+v.status,v.status==='ready_for_review'?'success':'warning');await refetchCoding();}
            catch(e:any){showToast(e.message||'Integration failed','error');}finally{setCodingBusy(false);}
          }}>Review + integrate</Button>
          {activeCoding.integration?.status==='ready_for_review'&&<Button size="sm" variant="outline" disabled={codingBusy} onClick={()=>showCodingDiff(activeCoding.id)}>Review integration diff</Button>}
          <Button size="sm" variant="outline" disabled={activeCoding.integration?.status!=='ready_for_review'||codingBusy||!reviewedTokens.integration} onClick={async()=>{
            if(prompt('Type PUBLISH DRAFT PR to explicitly push the integration branch and create a draft GitHub PR')!=='PUBLISH DRAFT PR')return;
            setCodingBusy(true);try{const v=await api.publishCodingAgents(activeCoding.id,reviewedTokens.integration);showToast('Draft PR: '+v.prUrl,'success');await refetchCoding();}
            catch(e:any){showToast(e.message||'Publish failed','error');}finally{setCodingBusy(false);}
          }}>Push + Draft PR</Button>
        </div>
      </div>}
      {codingContext&&<div data-testid="coding-context-preview" className="border border-[var(--line)] p-2 space-y-2">
        <div className="font-semibold">Read-only changed-file preview · {codingContext.workerId}
          <Button size="sm" variant="outline" onClick={()=>setCodingContext(null)}>Close preview</Button>
        </div>
        <p className="text-[var(--muted)]">Bounded local source display only; never auto-sent to AI and never proof that tests passed.</p>
        {(codingContext.files||[]).map((file:any)=><div key={file.path}>
          <strong>{file.path}</strong><p className="text-[var(--muted)]">SHA-256: {file.sha256}</p>
          <pre className="text-[10px] overflow-auto max-h-52">{(file.lines||[]).map((line:any)=>line.line+': '+line.text).join('\n')}</pre>
        </div>)}
        {!!codingContext.skipped?.length&&<p>Skipped: {codingContext.skipped.map((f:any)=>f.path+' ('+f.reason+')').join(', ')}</p>}
      </div>}
      {codingReview&&<div className="border border-[var(--line)] bg-[var(--surface)] p-2 rounded">
        <div className="font-semibold flex justify-between"><span>Git diff preview · {codingReview.branch}</span>
          <Button size="sm" variant="quiet" onClick={()=>setCodingReview(null)}>Close</Button></div>
        <p className="text-[var(--muted)]">Revision: {codingReview.revision} · Read the complete diff before authorizing integration or PR.</p>
        <pre className="mt-2 text-[10px] overflow-x-auto whitespace-pre-wrap break-all max-h-80 overflow-y-auto select-text">{codingReview.diff||'No changes'}</pre>
      </div>}
    </section>
    <div className="space-y-2">
      <h4 className="font-semibold">Kết quả gần nhất</h4>
      {(result||latest?.last)?.workers?.map((w:any)=><div key={w.id} className="border border-[var(--line)] rounded p-2"><div className="font-semibold">{w.id} · {w.role||'researcher'} · {w.status}</div><p className="text-[var(--muted)] whitespace-pre-wrap mt-1">{w.summary||w.error||'Chờ chạy...'}</p></div>)}
      {(result||latest?.last)?.conclusion&&<div className="border border-[var(--line)] rounded p-2"><div className="font-semibold">Coordinator synthesis</div><p className="text-[var(--muted)] whitespace-pre-wrap">{(result||latest?.last)?.conclusion}</p></div>}
      {(result||latest?.last)?.error&&<p role="alert" className="text-red-400">{(result||latest?.last)?.error}</p>}
    </div>
  </div>;
}
