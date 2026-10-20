import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { agentErrorText } from '@/lib/agent-errors';
import { taskStateText } from '@/components/inspector/agentLabels';
import type { BackgroundRun } from '@/types';
import { WorkflowCard } from '@/components/conversation/WorkflowCard';
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
const runCount=(workspace:WorkspaceGroup)=>workspace.conversations.reduce((n,c)=>n+c.runs.length,0);

export function BackgroundTasks() {
  const queryClient=useQueryClient();
  const {t}=useTranslation();
  const {setSelectedTaskId,setSelectedWorkspacePath,selectedTaskId,selectedWorkspacePath,showToast}=useAppStore();
  const {data}=useQuery({queryKey:['backgroundRuns'],queryFn:api.getBackgroundRuns,refetchInterval:2000});
  const {data:hub}=useQuery({queryKey:['hubState'],queryFn:api.getState,refetchInterval:3000});
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  const [scope,setScope]=useState<'all'|'workspace'|'conversation'>('all');
  const [cancellingWorkflow,setCancellingWorkflow]=useState<string|null>(null);
  const tasks=data?.tasks||[];
  const workflows=data?.workflows||[];
  const workspaceRoots=hub?.workspaces?.items||[];
  const currentWorkspace=workspaceRoots.find(w=>w.path===selectedWorkspacePath)?.path||hub?.workspaces?.activePath||'';
  const currentConversation=hub?.tasks?.find(item=>item.id===selectedTaskId&&!item.parentTaskId);
  const activeItems=tasks.filter(item=>active(item.status));
  // The names made up for a chat or a folder that has none: read here, not inside the memo, so that a change of language re-groups the list.
  const untitledChat=t('agents_bg_untitled_chat'),unnamedWorkspace=t('agents_bg_workspace_fallback');

  const grouped=useMemo(()=>{
    const roots=new Map<string,WorkspaceGroup>();
    const chats=new Map((hub?.tasks||[]).filter(item=>!item.parentTaskId)
      .map(item=>[item.id,item.task||item.prompt||untitledChat] as const));
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
        const name=registered.get(run.workspacePath)||run.workspacePath.split(/[\\/]/).filter(Boolean).pop()||unnamedWorkspace;
        workspace={path:run.workspacePath,name,conversations:[]};
        roots.set(run.workspacePath,workspace);
      }
      let conversation=workspace.conversations.find(item=>item.id===run.conversationId);
      if(!conversation){
        conversation={id:run.conversationId,
          title:chats.get(run.conversationId)||run.title||untitledChat,runs:[]};
        workspace.conversations.push(conversation);
      }
      conversation.runs.push(run);
    }
    return [...roots.values()];
  },[tasks,hub?.tasks,hub?.workspaces,workspaceRoots,currentWorkspace,selectedTaskId,scope,untitledChat,unnamedWorkspace]);

  const stop=async(taskId:string)=>{
    try{
      await api.cancelTask(taskId);
      await Promise.all([
        queryClient.invalidateQueries({queryKey:['backgroundRuns']}),
        queryClient.invalidateQueries({queryKey:['hubState']}),
      ]);
      showToast(t('agents_bg_stop_task_toast'),'info');
    }catch(e){showToast(agentErrorText(e,t,t('agents_bg_stop_task_failed')),'error');}
  };
  const stopWorkflow=async(id:string)=>{
    if(cancellingWorkflow)return;
    setCancellingWorkflow(id);
    try{
      await api.cancelWorkflow(id);
      await Promise.all([
        queryClient.invalidateQueries({queryKey:['backgroundRuns']}),
        queryClient.invalidateQueries({queryKey:['hubState']}),
      ]);
      showToast(t('agents_bg_stop_workflow_toast'),'info');
    }catch(e){
      showToast(agentErrorText(e,t,t('agents_bg_stop_workflow_failed')),'error');
    }finally{setCancellingWorkflow(null);}
  };
  const openChat=async(folder:string,conversationId:string)=>{
    try{
      await api.activateWorkspace(folder);
      setSelectedWorkspacePath(folder);
      setSelectedTaskId(conversationId);
      await queryClient.invalidateQueries({queryKey:['hubState']});
    }catch(e){showToast(agentErrorText(e,t,t('agents_bg_open_chat_failed')),'error');}
  };
  const openAgent=async(folder:string,taskId:string)=>{
    try{
      await api.activateWorkspace(folder);
      setSelectedWorkspacePath(folder);
      setSelectedTaskId(taskId);
      await queryClient.invalidateQueries({queryKey:['hubState']});
    }catch(e){showToast(agentErrorText(e,t,t('agents_bg_open_agent_failed')),'error');}
  };
  const openWorkspace=async(folder:string)=>{
    try{
      await api.activateWorkspace(folder);
      setSelectedWorkspacePath(folder);
      setSelectedTaskId('');
      await queryClient.invalidateQueries({queryKey:['hubState']});
    }catch(e){showToast(agentErrorText(e,t,t('agents_bg_open_workspace_failed')),'error');}
  };

  const renderRun=(task:BackgroundRun,workspaceName:string,chatTitle:string)=> {
    const running=active(task.status),open=expanded[task.id]===true,agents=task.subagents||[];
    const usage=task.conversationUsage;
    const tokens=usage?formatTokens((usage.inputTokens||0)+(usage.outputTokens||0)):null;
    return <article key={task.id} className="rounded-lg border border-line bg-surface p-2.5 space-y-2"
      data-testid="background-task" data-workspace={task.workspacePath} data-conversation={task.conversationId} data-run={task.id}>
      <div className="flex items-center gap-2">
        {running?<Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-primary"/>:
          task.status==='completed'?<CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-muted"/>:
            <Clock className="h-3.5 w-3.5 flex-shrink-0 text-muted"/>}
        <button type="button" onClick={()=>setExpanded(v=>({...v,[task.id]:!open}))}
          aria-expanded={open} className="flex-1 min-w-0 flex items-center text-left text-xs gap-1">
          <span className="font-medium text-fg truncate" title={task.title}>{compact(task.title,200)}</span>
          {open?<ChevronDown className="w-3 h-3 flex-shrink-0"/>:<ChevronRight className="w-3 h-3 flex-shrink-0"/>}
        </button>
        <span className="text-[12px] text-faint whitespace-nowrap">{elapsed(task)}</span>
      </div>
      <div className="text-[12px] text-faint truncate" title={workspaceName+' › '+chatTitle}>
        <FolderGit2 className="w-3 h-3 inline align-middle"/> {workspaceName} › <MessageSquare className="w-3 h-3 inline align-middle"/> {chatTitle}
      </div>
      <div className="flex flex-wrap gap-2 items-center text-[12px] text-muted">
        <span>{taskStateText(task.status,t)}</span>
        <span>{t(agents.length===1?'agents_bg_subagents_one':'agents_bg_subagents_other',{n:agents.length})}</span>
        {tokens&&<span title={t('agents_bg_tokens_hint')}>{t('agents_bg_tokens',{tokens})}</span>}
      </div>
      {open&&<div className="space-y-2 border-t border-line pt-2">
        <p className="text-[12px] text-faint break-words">{task.title}</p>
        <p className="text-[12px] text-muted break-all">{t('agents_bg_detail_workspace',{path:task.workspacePath})}</p>
        <p className="text-[12px] text-muted break-words">{t('agents_bg_detail_chat',{title:chatTitle})}</p>
        {agents.length>0&&<div className="space-y-1">
          <div className="text-[12px] font-medium text-muted flex items-center gap-1">
            <Network className="w-3 h-3"/> {t('agents_bg_subagents_title')}
          </div>
          {agents.map(agent=><div key={agent.id}
            className="rounded border border-line bg-panel px-2 py-1.5 text-[12px]">
            <div className="flex items-center gap-2">
              {active(agent.status)?<Loader2 className="w-3 h-3 animate-spin"/>:<CheckCircle2 className="w-3 h-3"/>}
              <span className="truncate flex-1" title={agent.title}>{agent.title}</span>
              <span className="text-faint">{taskStateText(agent.status,t)}</span>
              {active(agent.status)&&<button type="button" onClick={()=>void stop(agent.id)}
                aria-label={t('agents_bg_stop_subagent',{id:agent.id})}><Square className="w-3 h-3"/></button>}
            </div>
            {agent.branch&&<div className="flex gap-1 items-center text-faint mt-1">
              <GitBranch className="w-3 h-3"/>{agent.branch}
            </div>}
          </div>)}
        </div>}
        <div className="flex gap-3 items-center">
          <button type="button" onClick={()=>void openChat(task.workspacePath,task.conversationId)}
            className="text-[12px] underline text-primary">{t('agents_bg_open_chat')}</button>
          {running&&<button type="button" onClick={()=>void stop(task.taskId)}
            className="text-[12px] text-danger flex items-center gap-1"><Square className="w-3 h-3"/> {t('agents_bg_stop_task')}</button>}
        </div>
      </div>}
    </article>;
  };

  return <div className="h-full flex flex-col bg-panel min-h-0">
    <div className="px-3 py-2 border-b border-line text-xs text-muted space-y-2">
      <div>{t('agents_bg_summary',{active:activeItems.length,total:tasks.length})}</div>
      <div className="flex gap-1 flex-wrap" aria-label={t('agents_bg_filter_label')}>
        <button type="button" aria-pressed={scope==='all'} onClick={()=>setScope('all')}
          className={'px-2 py-1 rounded-md '+(scope==='all'?'bg-hover text-fg':'text-muted')}>{t('agents_bg_filter_all')}</button>
        <button type="button" disabled={!currentWorkspace} aria-pressed={scope==='workspace'} onClick={()=>setScope('workspace')}
          className={'px-2 py-1 rounded-md disabled:opacity-30 '+(scope==='workspace'?'bg-hover text-fg':'text-muted')}>{t('agents_bg_filter_workspace')}</button>
        <button type="button" disabled={!currentConversation} aria-pressed={scope==='conversation'} onClick={()=>setScope('conversation')}
          className={'px-2 py-1 rounded-md disabled:opacity-30 '+(scope==='conversation'?'bg-hover text-fg':'text-muted')}>{t('agents_bg_filter_conversation')}</button>
      </div>
    </div>
    <div className="flex-1 overflow-y-auto p-2 space-y-3">
      {!tasks.length&&<p className="p-4 text-xs text-faint">
        {t('agents_bg_empty')}
      </p>}
      {tasks.length>0&&!grouped.length&&<p className="p-4 text-xs text-faint">
        {t('agents_bg_empty_scope')}
      </p>}
      {grouped.map(workspace=><section key={workspace.path} data-testid="background-workspace"
        data-workspace={workspace.path} className="space-y-2">
        <button type="button" onClick={()=>void openWorkspace(workspace.path)} title={workspace.path}
          className="w-full text-left flex gap-2 items-center rounded-md bg-hover px-2 py-2 text-xs text-fg">
          <FolderGit2 className="w-4 h-4 text-primary flex-shrink-0"/>
          <span className="flex-1 truncate font-semibold">{workspace.name}</span>
          <span className="text-faint">{t(runCount(workspace)===1?'agents_bg_tasks_one':'agents_bg_tasks_other',{n:runCount(workspace)})}</span>
        </button>
        {workspace.conversations.map(chat=><div key={chat.id} data-testid="background-conversation"
          data-conversation={chat.id} className="space-y-1.5 pl-2 border-l-2 border-line">
          <button type="button" onClick={()=>void openChat(workspace.path,chat.id)}
            title={chat.title} className="w-full flex items-center gap-1.5 p-1 text-xs text-left text-muted hover:text-fg">
            <MessageSquare className="w-3.5 h-3.5 flex-shrink-0"/>
            <span className="truncate flex-1 font-medium">{chat.title}</span>
            <span className="text-faint">{chat.runs.length}</span>
          </button>
          {chat.runs.map((run,index)=><div key={run.id} className="space-y-1.5">
            {renderRun(run,workspace.name,chat.title)}
            {workflows.filter(w=>w.workspacePath===workspace.path&&
              w.conversationId===chat.id&&
              (w.parentRunId?w.parentRunId===run.id:index===0)).map(w=>
              <div className="ml-2" key={w.id} data-testid="background-workflow">
                <WorkflowCard compact workflow={w}
                  onOpenAgent={id=>void openAgent(workspace.path,id)}
                  onCancel={id=>void stopWorkflow(id)}
                  stopPending={cancellingWorkflow===w.id}/>
              </div>)}
          </div>)}
        </div>)}
      </section>)}
    </div>
  </div>;
}
