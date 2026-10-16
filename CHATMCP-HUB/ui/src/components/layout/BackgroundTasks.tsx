import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { taskStateLabel } from '@/lib/task-view';
import type { BackgroundRun } from '@/types';
import { Loader2, Square, ChevronDown, ChevronRight, CheckCircle2, Clock, GitBranch, Network } from 'lucide-react';

const active=(state:string)=>['queued','preparing','planning','running','waiting_approval','verifying'].includes(state);
const elapsed=(task:BackgroundRun)=>{
  if(!task.startedAt)return '';
  const end=task.finishedAt?new Date(task.finishedAt).getTime():Date.now();
  const begin=new Date(task.startedAt).getTime();
  if(!Number.isFinite(begin)||!Number.isFinite(end)||end<begin)return '';
  const seconds=Math.round((end-begin)/1000);
  if(seconds<60)return seconds+'s';
  const minutes=Math.floor(seconds/60);
  return minutes<60?minutes+'m '+String(seconds%60).padStart(2,'0')+'s':Math.floor(minutes/60)+'h '+minutes%60+'m';
};
const formatTokens=(n?:number)=>!Number.isFinite(n)?null
  :(n!>=1e6?(n!/1e6).toFixed(1)+'M':n!>=1000?(n!/1000).toFixed(1)+'k':String(n));
const compact=(v:string,length=160)=>v.length>length?v.slice(0,length)+'…':v;

export function BackgroundTasks() {
  const queryClient=useQueryClient();
  const {setSelectedTaskId,setSelectedWorkspacePath,showToast}=useAppStore();
  const {data}=useQuery({queryKey:['backgroundRuns'],queryFn:api.getBackgroundRuns,refetchInterval:2000});
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  const tasks=data?.tasks||[];
  const activeItems=tasks.filter(t=>active(t.status));
  const finished=tasks.filter(t=>!active(t.status));
  const stop=async(taskId:string)=>{
    try{
      await api.cancelTask(taskId);
      await queryClient.invalidateQueries({queryKey:['backgroundRuns']});
      await queryClient.invalidateQueries({queryKey:['hubState']});
      showToast('Đã gửi yêu cầu dừng riêng task này.','info');
    }catch(e){showToast(e instanceof Error?e.message:'Không thể dừng task.','error');}
  };
  const openChat=(task:BackgroundRun)=>{
    setSelectedWorkspacePath(task.workspacePath);
    setSelectedTaskId(task.conversationId);
  };
  const renderRun=(task:BackgroundRun)=> {
    const isActive=active(task.status),open=expanded[task.id]===true;
    const agents=task.subagents||[];
    const usage=task.conversationUsage;
    const tokens=usage?formatTokens((usage.inputTokens||0)+(usage.outputTokens||0)):null;
    return <article key={task.id} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 space-y-2" data-testid="background-task">
      <div className="flex items-center gap-2">
        {isActive?<Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--primary)]"/>:
          task.status==='completed'?<CheckCircle2 className="h-3.5 w-3.5 text-[var(--muted)]"/>:
            <Clock className="h-3.5 w-3.5 text-[var(--muted)]"/>}
        <button type="button" onClick={()=>setExpanded(s=>({...s,[task.id]:!open}))}
          aria-expanded={open} className="flex-1 min-w-0 flex items-center text-left text-xs gap-1">
          <span className="font-medium text-[var(--text)] truncate" title={task.title}>{compact(task.title,200)}</span>
          {open?<ChevronDown className="w-3 h-3 flex-shrink-0"/>:<ChevronRight className="w-3 h-3 flex-shrink-0"/>}
        </button>
        <span className="text-[11px] text-[var(--faint)] whitespace-nowrap">{elapsed(task)}</span>
      </div>
      <div className="flex gap-2 items-center text-[11px] text-[var(--muted)]">
        <span>{taskStateLabel(task.status)}</span>
        <span>{agents.length} subagent{agents.length===1?'':'s'}</span>
        {tokens&&<span title="Tokens cộng dồn của toàn hội thoại, không phải riêng lượt này">{tokens} tokens (chat)</span>}
      </div>
      {open&&<div className="space-y-2 border-t border-[var(--line)] pt-2">
        <p className="text-[11px] text-[var(--faint)] break-words">{task.title}</p>
        <p className="text-[11px] text-[var(--muted)] truncate" title={task.workspacePath}>
          Workspace: {task.workspacePath}
        </p>
        {agents.length>0&&<div className="space-y-1">
          <div className="text-[11px] font-medium text-[var(--muted)] flex items-center gap-1">
            <Network className="w-3 h-3"/> Subagents
          </div>
          {agents.map(agent=><div key={agent.id}
            className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-[11px]">
            <div className="flex items-center gap-2">
              {active(agent.status)?<Loader2 className="w-3 h-3 animate-spin"/>:<CheckCircle2 className="w-3 h-3"/>}
              <span className="truncate flex-1" title={agent.title}>{agent.title}</span>
              <span className="text-[var(--faint)]">{taskStateLabel(agent.status)}</span>
              {active(agent.status)&&<button type="button" onClick={()=>void stop(agent.id)}
                aria-label={'Dừng subagent '+agent.id}><Square className="w-3 h-3"/></button>}
            </div>
            {agent.branch&&<div className="flex gap-1 items-center text-[var(--faint)] mt-1">
              <GitBranch className="w-3 h-3"/>{agent.branch}
            </div>}
          </div>)}
        </div>}
        <div className="flex gap-3 items-center">
          <button type="button" onClick={()=>openChat(task)}
            className="text-[11px] underline text-[var(--primary)]">Mở hội thoại gốc</button>
          {isActive&&<button type="button" onClick={()=>void stop(task.taskId)}
            className="text-[11px] text-rose-400 flex items-center gap-1"><Square className="w-3 h-3"/> Dừng task</button>}
        </div>
      </div>}
    </article>;
  };
  return <div className="h-full flex flex-col bg-[var(--panel)] min-h-0">
    <div className="px-3 py-2 border-b border-[var(--line)] text-xs text-[var(--muted)]">
      {activeItems.length} đang thực hiện · {tasks.length} tác vụ (không tính hội thoại)
    </div>
    <div className="flex-1 overflow-y-auto p-2 space-y-3">
      {!tasks.length&&<p className="p-4 text-xs text-[var(--faint)]">
        Chưa có công việc nền. Agent có thể giao task cho subagent trong lúc bạn chat hoặc mở workspace khác.
      </p>}
      {activeItems.length>0&&<section className="space-y-1.5">
        <p className="text-[11px] font-semibold text-[var(--muted)] px-1">Running / Queued</p>
        {activeItems.map(renderRun)}
      </section>}
      {finished.length>0&&<section className="space-y-1.5">
        <p className="text-[11px] font-semibold text-[var(--muted)] px-1">Finished · {finished.length}</p>
        {finished.map(renderRun)}
      </section>}
    </div>
  </div>;
}
