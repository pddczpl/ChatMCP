import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { taskStateLabel } from '@/lib/task-view';
import type { BackgroundRun } from '@/types';
import {
  Loader2, Square, ChevronDown, ChevronRight, CheckCircle2, Clock,
  GitBranch, Network, FolderGit2, MessageSquare,
} from 'lucide-react';

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
const formatTokens=(n?:number)=>{
  if(typeof n!=='number'||!Number.isFinite(n))return null;
  return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'k':String(n);
};
const compact=(v:string,length=150)=>v.length>length?v.slice(0,length)+'…':v;
type ConversationGroup={id:string;title:string;runs:BackgroundRun[]};
type WorkspaceGroup={path:string;name:string;conversations:ConversationGroup[]};

export function BackgroundTasks() {
  const queryClient=useQueryClient();
  const {setSelectedTaskId,setSelectedWorkspacePath,selectedTaskId,selectedWorkspacePath,showToast}=useAppStore();
  const {data}=useQuery({queryKey:['backgroundRuns'],queryFn:api.getBackgroundRuns,refetchInterval:2000});
  const {data:hub}=useQuery({queryKey:['hubState'],queryFn:api.getState,refetchInterval:3000});
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  const [scope,setScope]=useState<'all'|'workspace'|'conversation'>('all');
  const tasks=data?.tasks||[];
  const workspaceRoots=hub?.workspaces?.items||[];
  const currentWorkspace=workspaceRoots.find(w=>w.path===selectedWorkspacePath)?.path||hub?.workspaces?.activePath||'';
  const currentConversation=hub?.tasks?.find(t=>t.id===selectedTaskId&&!t.parentTaskId);
  const activeItems=tasks.filter(t=>active(t.status));

  const grouped=useMemo(()=>{
    const roots=new Map<string,WorkspaceGroup>();
    const chats=new Map((hub?.tasks||[]).filter(t=>!t.parentTaskId)
      .map(t=>[t.id,t.task||t.prompt||'Cuộc hội thoại'] as const));
    const registered=new Map(workspaceRoots.map(w=>[w.path,w.name] as const));
    const sorted=[...tasks].sort((a,b)=>String(b.startedAt||'').localeCompare(String(a.startedAt||'')));
    for(const run of sorted){
      // A detached workspace keeps its local history, but it no longer belongs
      // to the visible desktop workspace tree until the user re-adds it.
      if(hub?.workspaces&&!registered.has(run.workspacePath))continue;
      if(scope==='workspace'&&run.workspacePath!==currentWorkspace)continue;
      if(scope==='conversation'&&run.conversationId!==selectedTaskId)continue;
      let workspace=roots.get(run.workspacePath);
      if(!workspace){
        const name=registered.get(run.workspacePath)||run.workspacePath.split(/[\\/]/).filter(Boolean).pop()||'Workspace';
        workspace={path:run.workspacePath,name,conversations:[]};
        roots.set(run.workspacePath,workspace);
      }
      let conversation=workspace.conversations.find(item=>item.id===run.conversationId);
      if(!conversation){
        conversation={id:run.conversationId,
          title:chats.get(run.conversationId)||run.title||'Cuộc hội thoại',runs:[]};
        workspace.conversations.push(conversation);
      }
      conversation.runs.push(run);
    }
    return [...roots.values()];
  },[tasks,hub?.tasks,hub?.workspaces,workspaceRoots,currentWorkspace,selectedTaskId,scope]);

  const stop=async(taskId:string)=>{
    try{
      await api.cancelTask(taskId);
      await Promise.all([
        queryClient.invalidateQueries({queryKey:['backgroundRuns']}),
        queryClient.invalidateQueries({queryKey:['hubState']}),
      ]);
      showToast('Đã gửi yêu cầu dừng riêng task này.','info');
    }catch(e){showToast(e instanceof Error?e.message:'Không thể dừng task.','error');}
  };
  const openChat=async(folder:string,conversationId:string)=>{
    try{
      await api.activateWorkspace(folder);
      setSelectedWorkspacePath(folder);
      setSelectedTaskId(conversationId);
      await queryClient.invalidateQueries({queryKey:['hubState']});
    }catch(e){showToast(e instanceof Error?e.message:'Không thể mở hội thoại.','error');}
  };
  const openWorkspace=async(folder:string)=>{
    try{
      await api.activateWorkspace(folder);
      setSelectedWorkspacePath(folder);
      setSelectedTaskId('');
      await queryClient.invalidateQueries({queryKey:['hubState']});
    }catch(e){showToast(e instanceof Error?e.message:'Không thể chuyển workspace.','error');}
  };

  const renderRun=(task:BackgroundRun,workspaceName:string,chatTitle:string)=> {
    const running=active(task.status),open=expanded[task.id]===true,agents=task.subagents||[];
    const usage=task.conversationUsage;
    const tokens=usage?formatTokens((usage.inputTokens||0)+(usage.outputTokens||0)):null;
    return <article key={task.id} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2.5 space-y-2"
      data-testid="background-task" data-workspace={task.workspacePath} data-conversation={task.conversationId} data-run={task.id}>
      <div className="flex items-center gap-2">
        {running?<Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-[var(--primary)]"/>:
          task.status==='completed'?<CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-[var(--muted)]"/>:
            <Clock className="h-3.5 w-3.5 flex-shrink-0 text-[var(--muted)]"/>}
        <button type="button" onClick={()=>setExpanded(v=>({...v,[task.id]:!open}))}
          aria-expanded={open} className="flex-1 min-w-0 flex items-center text-left text-xs gap-1">
          <span className="font-medium text-[var(--text)] truncate" title={task.title}>{compact(task.title,200)}</span>
          {open?<ChevronDown className="w-3 h-3 flex-shrink-0"/>:<ChevronRight className="w-3 h-3 flex-shrink-0"/>}
        </button>
        <span className="text-[11px] text-[var(--faint)] whitespace-nowrap">{elapsed(task)}</span>
      </div>
      <div className="text-[10px] text-[var(--faint)] truncate" title={workspaceName+' › '+chatTitle}>
        <FolderGit2 className="w-3 h-3 inline align-middle"/> {workspaceName} › <MessageSquare className="w-3 h-3 inline align-middle"/> {chatTitle}
      </div>
      <div className="flex flex-wrap gap-2 items-center text-[11px] text-[var(--muted)]">
        <span>{taskStateLabel(task.status)}</span><span>{agents.length} subagent{agents.length===1?'':'s'}</span>
        {tokens&&<span title="Tokens cộng dồn toàn hội thoại, không phải riêng task này">{tokens} tokens (chat)</span>}
      </div>
      {open&&<div className="space-y-2 border-t border-[var(--line)] pt-2">
        <p className="text-[11px] text-[var(--faint)] break-words">{task.title}</p>
        <p className="text-[11px] text-[var(--muted)] break-all">Workspace: {task.workspacePath}</p>
        <p className="text-[11px] text-[var(--muted)] break-words">Hội thoại: {chatTitle}</p>
        {agents.length>0&&<div className="space-y-1">
          <div className="text-[11px] font-medium text-[var(--muted)] flex items-center gap-1">
            <Network className="w-3 h-3"/> Subagents của task này
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
          <button type="button" onClick={()=>void openChat(task.workspacePath,task.conversationId)}
            className="text-[11px] underline text-[var(--primary)]">Mở đúng hội thoại</button>
          {running&&<button type="button" onClick={()=>void stop(task.taskId)}
            className="text-[11px] text-rose-400 flex items-center gap-1"><Square className="w-3 h-3"/> Dừng task</button>}
        </div>
      </div>}
    </article>;
  };

  return <div className="h-full flex flex-col bg-[var(--panel)] min-h-0">
    <div className="px-3 py-2 border-b border-[var(--line)] text-xs text-[var(--muted)] space-y-2">
      <div>{activeItems.length} đang thực hiện · {tasks.length} tác vụ (không tính hội thoại)</div>
      <div className="flex gap-1 flex-wrap" aria-label="Lọc background tasks">
        <button type="button" aria-pressed={scope==='all'} onClick={()=>setScope('all')}
          className={'px-2 py-1 rounded-md '+(scope==='all'?'bg-[var(--surface-hover)] text-[var(--text)]':'text-[var(--muted)]')}>Tất cả</button>
        <button type="button" disabled={!currentWorkspace} aria-pressed={scope==='workspace'} onClick={()=>setScope('workspace')}
          className={'px-2 py-1 rounded-md disabled:opacity-30 '+(scope==='workspace'?'bg-[var(--surface-hover)] text-[var(--text)]':'text-[var(--muted)]')}>Workspace này</button>
        <button type="button" disabled={!currentConversation} aria-pressed={scope==='conversation'} onClick={()=>setScope('conversation')}
          className={'px-2 py-1 rounded-md disabled:opacity-30 '+(scope==='conversation'?'bg-[var(--surface-hover)] text-[var(--text)]':'text-[var(--muted)]')}>Hội thoại này</button>
      </div>
    </div>
    <div className="flex-1 overflow-y-auto p-2 space-y-3">
      {!tasks.length&&<p className="p-4 text-xs text-[var(--faint)]">
        Chưa có công việc nền. Agent có thể giao task cho subagent trong lúc bạn chat hoặc mở workspace khác.
      </p>}
      {tasks.length>0&&!grouped.length&&<p className="p-4 text-xs text-[var(--faint)]">
        Không có background task nào thuộc phạm vi đang chọn.
      </p>}
      {grouped.map(workspace=><section key={workspace.path} data-testid="background-workspace"
        data-workspace={workspace.path} className="space-y-2">
        <button type="button" onClick={()=>void openWorkspace(workspace.path)} title={workspace.path}
          className="w-full text-left flex gap-2 items-center rounded-md bg-[var(--surface-hover)] px-2 py-2 text-xs text-[var(--text)]">
          <FolderGit2 className="w-4 h-4 text-[var(--primary)] flex-shrink-0"/>
          <span className="flex-1 truncate font-semibold">{workspace.name}</span>
          <span className="text-[var(--faint)]">{workspace.conversations.reduce((n,c)=>n+c.runs.length,0)} task</span>
        </button>
        {workspace.conversations.map(chat=><div key={chat.id} data-testid="background-conversation"
          data-conversation={chat.id} className="space-y-1.5 pl-2 border-l-2 border-[var(--line)]">
          <button type="button" onClick={()=>void openChat(workspace.path,chat.id)}
            title={chat.title} className="w-full flex items-center gap-1.5 p-1 text-xs text-left text-[var(--muted)] hover:text-[var(--text)]">
            <MessageSquare className="w-3.5 h-3.5 flex-shrink-0"/>
            <span className="truncate flex-1 font-medium">{chat.title}</span>
            <span className="text-[var(--faint)]">{chat.runs.length}</span>
          </button>
          {chat.runs.map(run=>renderRun(run,workspace.name,chat.title))}
        </div>)}
      </section>)}
    </div>
  </div>;
}
