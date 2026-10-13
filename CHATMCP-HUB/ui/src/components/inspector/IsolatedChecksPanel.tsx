import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { agentStatusLabel } from './agentLabels';

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
    <p className="text-xs font-semibold">Kiểm thử cho công việc {workerId}</p>
    {isLoading && <p role="status">Đang tìm các lệnh kiểm thử của dự án…</p>}
    {error && <p role="alert" className="text-[var(--danger)]">Không tải được lệnh kiểm thử: {error.message}</p>}
    {data?.checks?.length===0 && <p className="text-[var(--muted)]">Dự án chưa đăng ký lệnh kiểm thử ngoại tuyến.</p>}
    {(data?.checks as Check[]|undefined)?.map(check=><div key={check.id} className="p-2 border border-[var(--line-subtle)] rounded">
      <p className="font-mono break-words">{check.command}</p>
      <details className="text-xs text-[var(--muted)] break-words"><summary className="cursor-pointer">Nguồn và mã kiểm thử</summary>{check.from} · {check.id}</details>
      {check.approvedGrantId
        ? <p className="text-[var(--muted)]">Đã cho phép kiểm thử, còn {check.remainingAttempts} lần. Cần có Windows Sandbox khả dụng.</p>
        : confirmation!==check.id
          ? <Button size="sm" className="mt-2" onClick={()=>setConfirmation(check.id)}>Xem và cho phép kiểm thử</Button>
          : <div className="space-y-1 mt-1">
              <p>Cho phép lệnh này chạy tối đa 3 lần trong Windows Sandbox đã xác minh? Quyền này không cho phép chạy lệnh trực tiếp trên máy của bạn.</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" disabled={grant.isPending} onClick={()=>grant.mutate(check.id)}>Cho phép kiểm thử cách ly</Button>
                <Button size="sm" disabled={grant.isPending} onClick={()=>setConfirmation(null)}>Hủy</Button>
              </div>
            </div>}
      {grant.error && confirmation===check.id && <p role="alert" className="text-[var(--danger)]">Chưa thể cấp quyền: {grant.error.message}</p>}
    </div>)}
  </div>;
}
export function IsolatedChecksPanel() {
  const {data,error}=useQuery({queryKey:['coding-runs'],queryFn:api.getCodingRuns,refetchInterval:3000});
  if(error || !Array.isArray(data?.jobs) || data.jobs.length===0) return null;
  const job=data.jobs.find((x:{id:string})=>x.id===data.activeRunId) || data.jobs.at(-1);
  const workers=(job?.workers??[]).filter((w:{status:string})=>['running','awaiting_test_grant','testing'].includes(w.status));
  const prior=(job?.workers??[]).flatMap((w:{id:string;verificationAttempts?:any[]})=>
    (w.verificationAttempts||[]).map(record=>({...record,workerId:w.id})));
  if(!workers.length && !prior.length)return null;
  return <section data-testid="isolated-checks-panel" className="space-y-2 border-t border-[var(--line-subtle)] pt-3">
    <h3 className="font-semibold text-sm">Kiểm thử cần bạn cho phép</h3>
    <p className="text-xs leading-relaxed text-[var(--muted)]">Quyền chỉ áp dụng cho công việc và lệnh kiểm thử bạn chọn, với số lần chạy giới hạn. Môi trường cách ly phải được xác minh trước khi chạy.</p>
    {workers.map((w:{id:string})=><WorkerChecks key={w.id} workerId={w.id}/>)}
    {prior.length>0 && <div className="space-y-2">
      <p className="font-semibold text-xs">Kết quả kiểm thử đã ghi nhận</p>
      {prior.slice(-30).map((x:any,index:number)=><div key={String(x.id||index)} className="border border-[var(--line)] p-2 rounded">
        <p>{x.workerId} · {agentStatusLabel(x.status)}</p>
        <p className="text-[var(--muted)]">{x.testOutcomeVerified===true?'Kết quả kiểm thử đạt đã được xác minh':'Chưa có bằng chứng xác minh kiểm thử đạt'}</p>
        <details className="text-xs text-[var(--muted)] break-all"><summary className="cursor-pointer">Chi tiết kiểm thử</summary><p>Mã kiểm thử: {x.checkId} · Mã thoát: {x.exitCode??'?'}</p>{x.snapshotHash&&<p>Mã bản lưu: {String(x.snapshotHash).slice(0,16)}…</p>}</details>
      </div>)}
    </div>}
  </section>;
}
