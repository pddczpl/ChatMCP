import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/Button';
import { IsolatedChecksPanel } from './IsolatedChecksPanel';
import { DynamicSubagents } from './DynamicSubagents';
import { agentRoleLabel, agentStatusLabel } from './agentLabels';

type Node = {id:string;role:string;question:string;dependsOn:string[]};
type CodingTask = {id:string;prompt:string;verify:boolean;dependsOn:string[]};
const roles = ['planner','researcher','tester','reviewer','security','summarizer'];
const initial:Node[] = [
  {id:'plan',role:'planner',question:'Đề xuất kế hoạch triển khai và xác định các phần quan trọng của dự án.',dependsOn:[]},
  {id:'research',role:'researcher',question:'Tìm các cách làm sẵn có trong mã nguồn và những giới hạn cần lưu ý.',dependsOn:[]},
  {id:'review',role:'reviewer',question:'Rà soát các vấn đề dựa trên kết quả tìm hiểu và kế hoạch.',dependsOn:['plan','research']},
];

export function OrchestratorTab(){
  const {showToast}=useAppStore();
  const [nodes,setNodes]=useState<Node[]>(initial);
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<any>(null);
  const [concurrency,setConcurrency]=useState(2);
  const [codingTasks,setCodingTasks]=useState<CodingTask[]>([{id:'task-a',prompt:'',verify:false,dependsOn:[]}]);
  const [codingGoal,setCodingGoal]=useState('');
  const [codingModelAssist,setCodingModelAssist]=useState(false);
  const [codingPlan,setCodingPlan]=useState<any>(null);
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
      showToast('Đã tải thay đổi. Hãy đọc trước khi duyệt.','info');
    }catch(e:any){showToast(e.message||'Không tải được thay đổi','error');}
  };
  const {data:latest,refetch}=useQuery({queryKey:['delegates'],queryFn:api.getOrchestrator,refetchInterval:4000});
  const edit=(i:number,patch:Partial<Node>)=>setNodes(old=>old.map((v,j)=>j===i?{...v,...patch}:v));
  return <div aria-label="Trợ lý AI" className="h-full min-w-0 overflow-y-auto p-4 text-sm leading-relaxed space-y-5 text-[var(--text)]">
    <DynamicSubagents />
    <details data-testid="manual-agents" className="border-t border-[var(--line)] pt-4">
      <summary className="cursor-pointer font-semibold rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">Tự chia việc cho từng trợ lý</summary>
      <div className="space-y-3 mt-3">
        <p className="text-[var(--muted)]">Dành cho khi bạn muốn chọn vai trò và giao việc cụ thể. Các trợ lý chỉ đọc và phân tích dự án.</p>
    <div className="flex items-center justify-between">
      <label htmlFor="agent-concurrency">Số trợ lý làm cùng lúc</label>
      <select id="agent-concurrency" value={concurrency} onChange={e=>setConcurrency(Number(e.target.value))} className="bg-[var(--surface)] border border-[var(--line)] p-2 rounded">
        {[1,2,3].map(n=><option key={n} value={n}>{n} trợ lý</option>)}
      </select>
    </div>
    {nodes.map((node,i)=><div key={i} className="p-2 rounded border border-[var(--line)] bg-[var(--surface)] space-y-2">
      <div className="flex gap-2 items-center">
        <select aria-label={`Vai trò trợ lý ${i+1}`} value={node.role} disabled={busy} onChange={e=>edit(i,{role:e.target.value})} className="flex-1 min-w-0 p-2 border border-[var(--line)] bg-[var(--panel)] rounded">{roles.map(r=><option key={r} value={r}>{agentRoleLabel(r)}</option>)}</select>
        <Button size="sm" variant="danger" disabled={nodes.length===1||busy} onClick={()=>setNodes(old=>old.filter((_,j)=>j!==i))}>Xóa</Button>
      </div>
      <label className="block space-y-1"><span className="text-xs text-[var(--muted)]">Việc cần làm</span><textarea aria-label={`Việc cần làm của trợ lý ${i+1}`} value={node.question} disabled={busy} onChange={e=>edit(i,{question:e.target.value})} rows={3} className="w-full bg-[var(--panel)] border border-[var(--line)] rounded p-2" /></label>
      <details className="text-xs text-[var(--muted)]">
        <summary className="cursor-pointer">Thứ tự thực hiện và mã trợ lý</summary>
        <div className="space-y-2 mt-2">
          <label className="block space-y-1"><span>Mã trợ lý</span><input value={node.id} disabled={busy} onChange={e=>edit(i,{id:e.target.value})} className="w-full p-2 rounded border border-[var(--line)] bg-[var(--panel)] text-[var(--text)]" /></label>
          <label className="block space-y-1"><span>Chờ các trợ lý này hoàn tất</span><input value={node.dependsOn.join(',')} disabled={busy} placeholder="Ví dụ: plan, research. Để trống để chạy ngay." onChange={e=>edit(i,{dependsOn:e.target.value.split(',').map(x=>x.trim()).filter(Boolean)})} className="w-full bg-[var(--panel)] text-[var(--text)] border border-[var(--line)] rounded p-2" /></label>
        </div>
      </details>
    </div>)}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={nodes.length>=8||busy} onClick={()=>setNodes(old=>[...old,{id:'worker'+(old.length+1),role:'researcher',question:'',dependsOn:[]}])}>Thêm trợ lý</Button>
      {busy&&<Button size="sm" variant="danger" onClick={async()=>{try{await api.cancelOrchestrator();showToast('Đã yêu cầu dừng nhóm trợ lý','info');}catch(e:any){showToast(e.message||'Chưa thể dừng nhóm trợ lý','error');}}}>Dừng nhóm</Button>}
      <Button size="sm" variant="primary" disabled={busy||nodes.some(node=>!node.question.trim()||!node.id.trim())} onClick={async()=>{
        setBusy(true);try{const answer=await api.orchestrateAgents(nodes,concurrency);setResult(answer);showToast(agentStatusLabel(answer.status),answer.status==='completed'?'success':'warning');await refetch();}
        catch(e:any){showToast(e.message||'Không thể chạy nhóm trợ lý','error');}
        finally{setBusy(false);}
      }}>{busy?'Đang phân tích…':'Bắt đầu với nhóm này'}</Button>
    </div>
    {(result||latest?.last)&&<div className="space-y-2 select-text">
      <h4 className="font-semibold">Kết quả của nhóm</h4>
      {(result||latest?.last)?.workers?.map((w:any)=><div key={w.id} className="border border-[var(--line)] rounded p-3"><div className="font-medium">{agentRoleLabel(w.role||'researcher')} · {agentStatusLabel(w.status)}</div><p className="whitespace-pre-wrap break-words mt-2">{w.summary||w.error||'Chờ kết quả…'}</p></div>)}
      {(result||latest?.last)?.conclusion&&<div className="border border-[var(--line)] rounded p-3"><div className="font-semibold">Tổng hợp kết quả</div><p className="whitespace-pre-wrap mt-2">{(result||latest?.last)?.conclusion}</p></div>}
      {(result||latest?.last)?.error&&<p role="alert" className="text-[var(--danger)]">{(result||latest?.last)?.error}</p>}
    </div>}
      </div>
    </details>
    <details data-testid="coding-agents" className="border-t border-[var(--line)] pt-4">
      <summary className="cursor-pointer font-semibold rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">Nhờ AI sửa mã nguồn{activeCoding&&<span className="block text-xs font-normal text-[var(--muted)] mt-1">Lần gần nhất: {agentStatusLabel(activeCoding.status)}</span>}</summary>
      <div className="space-y-3 mt-3">
      <p className="text-[var(--muted)]">Mỗi công việc được sửa trên một bản làm việc riêng. Bạn xem thay đổi trước khi gộp hoặc đưa lên GitHub.</p>
      <div className="space-y-2 p-3 rounded border border-[var(--line)] bg-[var(--surface)]">
        <label className="text-xs font-semibold" htmlFor="coding-goal">Chia công việc từ một yêu cầu</label>
        <textarea id="coding-goal" value={codingGoal} onChange={e=>setCodingGoal(e.target.value)}
          placeholder="Mô tả mục tiêu hoặc viết 2–4 dòng gạch đầu dòng."
          disabled={codingBusy} rows={3} className="w-full p-2 bg-[var(--panel)] border border-[var(--line)] rounded" />
        <label className="flex gap-2 items-center text-xs text-[var(--muted)]">
          <input type="checkbox" checked={codingModelAssist} disabled={codingBusy}
            onChange={e=>setCodingModelAssist(e.target.checked)} />
          Cho AI đề xuất DAG (gửi một lượt gọi API model; bản xem trước vẫn cần bạn duyệt)
        </label>
        <Button size="sm" variant="outline" disabled={!codingGoal.trim()||codingBusy} onClick={async()=>{
          setCodingBusy(true);
          try{
            const proposal=await api.planCodingAgents(codingGoal,codingModelAssist);
            setCodingPlan(proposal);
            setCodingTasks(proposal.tasks);
            showToast('Đã tạo kế hoạch xem trước. Đọc và sửa từng công việc trước khi chạy.','info');
          }catch(e:any){showToast(e.message||'Không tạo được kế hoạch','error');}
          finally{setCodingBusy(false);}
        }}>Đề xuất chia công việc</Button>
        {codingPlan&&<p role="status" className="text-xs text-[var(--muted)]">
          Bản xem trước gồm {codingPlan.taskCount} công việc. Chưa chạy agent hoặc thay đổi Git.
        </p>}
      </div>
      {codingTasks.map((x,i)=><div key={i} className="p-3 rounded border border-[var(--line)] space-y-3">
        <div className="flex gap-2 items-center justify-between">
          <label htmlFor={`coding-task-${i}`} className="font-medium">Công việc {i+1}</label>
          <Button size="sm" variant="danger" disabled={codingBusy||codingTasks.length<=1} onClick={()=>setCodingTasks(a=>a.filter((_,j)=>j!==i))}>Xóa</Button>
        </div>
        <textarea id={`coding-task-${i}`} rows={3} disabled={codingBusy} placeholder="Mô tả phần cần sửa và kết quả bạn mong muốn…" className="w-full p-2 rounded border border-[var(--line)] bg-[var(--panel)]" value={x.prompt} onChange={e=>setCodingTasks(a=>a.map((v,j)=>j===i?{...v,prompt:e.target.value}:v))}/>
        <details className="text-xs text-[var(--muted)] space-y-2">
        <summary className="cursor-pointer">Thứ tự công việc và kiểm thử</summary>
        <label className="block space-y-1"><span>Mã công việc</span><input disabled={codingBusy} className="w-full p-2 bg-[var(--panel)] text-[var(--text)] rounded border border-[var(--line)]" value={x.id} onChange={e=>setCodingTasks(a=>a.map((v,j)=>j===i?{...v,id:e.target.value}:v))}/></label>
        <label className="block space-y-1"><span>Chờ các công việc này hoàn tất</span><input className="w-full p-2 rounded border border-[var(--line)] bg-[var(--panel)] text-[var(--text)]"
          placeholder="Ví dụ: task-a, task-b. Để trống để chạy ngay." value={x.dependsOn.join(',')}
          disabled={codingBusy}
          onChange={e=>setCodingTasks(a=>a.map((v,j)=>j===i?
            {...v,dependsOn:e.target.value.split(',').map(id=>id.trim()).filter(Boolean)}:v))}/></label>
        <p>Công việc sau sẽ nhận các thay đổi đã hoàn tất của công việc trước.</p>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={x.verify} disabled={codingBusy}
            onChange={e=>setCodingTasks(a=>a.map((v,j)=>j===i?{...v,verify:e.target.checked}:v))}/>
          Yêu cầu bằng chứng kiểm thử trong môi trường cách ly trước khi duyệt. Nếu máy không hỗ trợ, công việc sẽ được đánh dấu cần bạn kiểm tra.
        </label>
        </details>
      </div>)}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={codingTasks.length>=4||codingBusy} onClick={()=>setCodingTasks(a=>[...a,{id:'task-'+(a.length+1),prompt:'',verify:false,dependsOn:[]}])}>Thêm công việc</Button>
        <Button size="sm" variant="primary" disabled={codingBusy||Boolean(codingState?.activeRunId)||codingTasks.some(task=>!task.prompt.trim()||!task.id.trim())} onClick={async()=>{
          if(!confirm('Cho phép AI sửa tệp trong các nhánh Git và bản làm việc riêng? Trợ lý không chạy lệnh trên máy, không tự gộp thay đổi hay đưa mã lên GitHub. Phí sử dụng AI do nhà cung cấp tính.'))return;
          setCodingBusy(true);try{const j=await api.runCodingAgents(codingTasks,Math.min(concurrency,2));setCodingRun(j);setReviewedTokens({});setCodingReview(null);setCodingRecovery(null);setSelectedWorkers((j.workers||[]).filter((w:any)=>w.status==='ready_for_review').map((w:any)=>w.id));await refetchCoding();showToast(agentStatusLabel(j.status),j.status==='ready_for_review'?'success':'info');}
          catch(e:any){showToast(e.message||'Không thể bắt đầu sửa mã','error');}finally{setCodingBusy(false);}
        }}>{codingBusy?'Đang sửa mã…':'Bắt đầu sửa mã'}</Button>
        {(codingBusy||codingState?.activeRunId)&&<Button size="sm" variant="danger" onClick={async()=>{try{await api.cancelCodingAgents();showToast('Đã yêu cầu dừng sửa mã','info');}catch(e:any){showToast(e.message||'Chưa thể dừng sửa mã','error');}}}>Dừng sửa mã</Button>}
      </div>
      <IsolatedChecksPanel />
      {codingState?.recoveryFault&&<p role="alert" className="text-[var(--danger)] border border-[var(--danger)] rounded p-2">
        Cần kiểm tra nhật ký khôi phục: {codingState.recoveryFault}. Các thao tác bị gián đoạn sẽ không tự chạy lại.
      </p>}
      {activeCoding&&<div className="space-y-2 border-t border-[var(--line)] pt-2">
        <div className="font-semibold">Kết quả sửa mã · {agentStatusLabel(activeCoding.status)}</div>
        <details className="text-xs text-[var(--muted)]">
        <summary className="cursor-pointer">Kiểm tra lần chạy và khôi phục</summary>
        <p className="mt-2">Mã lần chạy: {activeCoding.id?.slice(0,8)}</p>
        <div className="flex items-center gap-2 flex-wrap mt-2">
          <Button size="sm" variant="outline" onClick={async()=>{
            try{
              const report=await api.getCodingRecovery(activeCoding.id);
              setCodingRecovery(report);
              showToast('Đã xem nhật ký khôi phục. Không chạy lại thao tác nào.','info');
            }catch(e:any){
              setCodingRecovery(null);
              showToast(e.message||'Không có nhật ký khôi phục. Cần kiểm tra thủ công.','error');
            }
          }}>Xem nhật ký khôi phục</Button>
          {activeCoding.status==='interrupted'&&codingRecovery?.runId===activeCoding.id&&
            codingRecovery.found&&codingRecovery.integrityDigest&&
            <Button size="sm" variant="outline" disabled={codingBusy} onClick={async()=>{
              if(prompt('Kiểm tra bản làm việc và điểm lưu bị gián đoạn trước. Nhập REVIEW INTERRUPTED RUN để đánh dấu cần kiểm tra lại. Thao tác này không tự tiếp tục công việc.')!=='REVIEW INTERRUPTED RUN')return;
              setCodingBusy(true);
              try{
                await api.acknowledgeCodingRecovery(activeCoding.id,codingRecovery.integrityDigest);
                setCodingRecovery(null);
                await refetchCoding();
                showToast('Đã ghi nhận gián đoạn. Bạn vẫn cần kiểm tra và xác minh lại.','warning');
              }catch(e:any){showToast(e.message||'Điểm lưu đã thay đổi. Hãy xem lại trước khi xác nhận.','error');}
              finally{setCodingBusy(false);}
            }}>Ghi nhận lần chạy bị gián đoạn</Button>}
          <span>Chỉ xem thông tin khôi phục. Không tự chạy lại thao tác, kiểm thử hay gộp mã.</span>
        </div>
        {codingRecovery?.runId===activeCoding.id&&
          <div role="status" data-testid="coding-recovery-status" className="p-2 border border-[var(--line-subtle)] rounded mt-2">
            Nhật ký: {codingRecovery.found?'đã tìm thấy':'không có'} · Trạng thái: {agentStatusLabel(codingRecovery.status)} ·
            Số bản ghi: {codingRecovery.entries??0}. Cần bạn kiểm tra lại. Không tự chạy lại; kết quả kiểm thử cũ chưa được xác minh lại.
          </div>
        }
        </details>
        {(activeCoding.workers||[]).map((w:any)=><div key={w.id} className="p-3 space-y-2 border border-[var(--line)] rounded select-text">
          <label className="flex gap-2 items-center">
            <input type="checkbox" disabled={w.status!=='ready_for_review'} checked={selectedWorkers.includes(w.id)} onChange={e=>setSelectedWorkers(a=>e.target.checked?[...a,w.id]:a.filter(id=>id!==w.id))}/>
            <strong>{w.id} · {agentStatusLabel(w.status)}</strong>
          </label>
          <p className="text-xs text-[var(--muted)] break-all">Nhánh: {w.branch}</p>
          {w.dependsOn?.length>0&&<p className="text-xs text-[var(--muted)]">Chờ công việc: {w.dependsOn.join(', ')}</p>}
          {w.inheritedCommits&&<details className="text-xs text-[var(--muted)]"><summary className="cursor-pointer">Các thay đổi nhận từ công việc trước</summary>{Object.entries(w.inheritedCommits).map(([id,sha])=>id+':'+String(sha).slice(0,8)).join(', ')}</details>}
          <p className="break-words">Tệp đã sửa: {(w.changedFiles||[]).join(', ')||'chưa có'}</p>
          <div className="flex flex-wrap gap-2">
          {w.status==='ready_for_review'&&<Button size="sm" variant="outline" disabled={codingBusy} onClick={()=>showCodingDiff(activeCoding.id,w.id)}>Xem thay đổi</Button>}
          {w.status==='ready_for_review'&&<Button size="sm" variant="outline" disabled={codingBusy} onClick={async()=>{
            try{setCodingContext(await api.getCodingContext(activeCoding.id,w.id));showToast('Đã tải bản xem trước trên máy, không tự gửi tới AI.','info');}
            catch(e:any){setCodingContext(null);showToast(e.message||'Không xem được tệp đã sửa','error');}
          }}>Xem nội dung tệp</Button>}
          {w.status==='ready_for_review'&&<Button size="sm" variant="outline" disabled={codingBusy||!reviewedTokens[w.id]} onClick={async()=>{
            if(prompt('Nhập PUBLISH DRAFT PR để đưa riêng công việc '+w.id+' lên GitHub và tạo yêu cầu duyệt bản nháp (Draft PR).')!=='PUBLISH DRAFT PR')return;
            setCodingBusy(true);try{const result=await api.publishCodingAgents(activeCoding.id,reviewedTokens[w.id],w.id);showToast('Đã tạo yêu cầu duyệt: '+result.prUrl,'success');await refetchCoding();}
            catch(e:any){showToast(e.message||'Không đưa được công việc lên GitHub','error');}finally{setCodingBusy(false);}
          }}>Tạo bản nháp trên GitHub</Button>}
          </div>
          {w.prUrl&&<p className="text-[var(--muted)] break-all">PR: {w.prUrl}</p>}
          {w.verifyRequired && <p className="text-xs text-[var(--muted)]">Kiểm thử: {w.verificationOutcome?.state?agentStatusLabel(w.verificationOutcome.state):'chờ bằng chứng xác minh'}. AI báo hoàn tất chưa có nghĩa là kiểm thử đã đạt.</p>}
          {w.verificationAttempts?.length>0 && <p className="text-xs text-[var(--muted)]">Số lần kiểm thử: {w.verificationAttempts.length} · Kết quả đạt đã xác minh: {w.verificationAttempts.filter((a:any)=>a.testOutcomeVerified===true).length}</p>}
          {w.summary&&<p className="whitespace-pre-wrap break-words">{w.summary}</p>}{w.error&&<p role="alert" className="text-[var(--danger)] break-words">{w.error}</p>}
        </div>)}
        {activeCoding.integration&&<p className="break-words">Bản gộp: {agentStatusLabel(activeCoding.integration.status)} · {activeCoding.integration.branch}</p>}
        <p className="text-xs text-[var(--muted)]">Xem thay đổi của từng công việc rồi chọn những mục muốn gộp.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!selectedWorkers.length||codingBusy||selectedWorkers.some(id=>!reviewedTokens[id])} onClick={async()=>{
            if(prompt('Nhập INTEGRATE WORKTREES để gộp các công việc đã chọn vào một nhánh Git MỚI. Nhánh chính không bị thay đổi.')!=='INTEGRATE WORKTREES')return;
            setCodingBusy(true);try{const v=await api.integrateCodingAgents(activeCoding.id,selectedWorkers,reviewedTokens);showToast('Bản gộp: '+agentStatusLabel(v.status),v.status==='ready_for_review'?'success':'warning');await refetchCoding();}
            catch(e:any){showToast(e.message||'Không gộp được các thay đổi','error');}finally{setCodingBusy(false);}
          }}>Gộp các công việc đã chọn</Button>
          {activeCoding.integration?.status==='ready_for_review'&&<Button size="sm" variant="outline" disabled={codingBusy} onClick={()=>showCodingDiff(activeCoding.id)}>Xem thay đổi của bản gộp</Button>}
          <Button size="sm" variant="outline" disabled={activeCoding.integration?.status!=='ready_for_review'||codingBusy||!reviewedTokens.integration} onClick={async()=>{
            if(prompt('Nhập PUBLISH DRAFT PR để đưa nhánh đã gộp lên GitHub và tạo yêu cầu duyệt bản nháp (Draft PR).')!=='PUBLISH DRAFT PR')return;
            setCodingBusy(true);try{const v=await api.publishCodingAgents(activeCoding.id,reviewedTokens.integration);showToast('Đã tạo yêu cầu duyệt: '+v.prUrl,'success');await refetchCoding();}
            catch(e:any){showToast(e.message||'Không đưa được bản gộp lên GitHub','error');}finally{setCodingBusy(false);}
          }}>Đưa bản gộp lên GitHub</Button>
        </div>
      </div>}
      {codingContext&&<div data-testid="coding-context-preview" className="border border-[var(--line)] p-3 space-y-2 select-text">
        <div className="font-semibold flex flex-wrap items-center justify-between gap-2">Nội dung tệp · {codingContext.workerId}
          <Button size="sm" variant="outline" onClick={()=>setCodingContext(null)}>Đóng bản xem trước</Button>
        </div>
        <p className="text-xs text-[var(--muted)]">Chỉ hiển thị một phần mã nguồn trên máy, không tự gửi tới AI. Đây không phải bằng chứng kiểm thử đã đạt.</p>
        {(codingContext.files||[]).map((file:any)=><div key={file.path}>
          <strong className="break-words">{file.path}</strong><details className="text-xs text-[var(--muted)] break-all"><summary className="cursor-pointer">Mã xác minh tệp</summary>SHA-256: {file.sha256}</details>
          <pre className="text-xs overflow-auto max-h-52 bg-[var(--surface)] text-[var(--text)] p-2 rounded mt-2">{(file.lines||[]).map((line:any)=>line.line+': '+line.text).join('\n')}</pre>
        </div>)}
        {!!codingContext.skipped?.length&&<p className="break-words">Tệp không hiển thị: {codingContext.skipped.map((f:any)=>f.path+' ('+f.reason+')').join(', ')}</p>}
      </div>}
      {codingReview&&<div className="border border-[var(--line)] bg-[var(--surface)] p-2 rounded">
        <div className="font-semibold flex flex-wrap justify-between gap-2"><span className="break-all">Thay đổi · {codingReview.branch}</span>
          <Button size="sm" variant="quiet" onClick={()=>setCodingReview(null)}>Đóng</Button></div>
        <p className="text-xs text-[var(--muted)] break-all">Phiên bản: {codingReview.revision}. Hãy đọc toàn bộ thay đổi trước khi gộp hoặc đưa lên GitHub.</p>
        <pre className="mt-2 p-2 rounded bg-[var(--surface)] text-[var(--text)] text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-80 overflow-y-auto select-text">{codingReview.diff||'Không có thay đổi'}</pre>
      </div>}
      </div>
    </details>
  </div>;
}
