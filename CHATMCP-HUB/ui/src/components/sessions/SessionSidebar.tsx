import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { FolderGit2, Plus, Search, Trash2, Loader2, MessageSquare, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/lib/i18n';
import { isTaskActive } from '@/lib/task-view';
import { formatRelative } from '@/lib/format';

export function SessionSidebar() {
  const {
    selectedTaskId,setSelectedTaskId,selectedWorkspacePath,setSelectedWorkspacePath,
    showToast,
  }=useAppStore();
  const {t,lang}=useTranslation();
  const queryClient=useQueryClient();
  const [search,setSearch]=useState('');
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({});
  const [choosing,setChoosing]=useState(false);
  const [manualFolder,setManualFolder]=useState('');
  const [manualFolderOpen,setManualFolderOpen]=useState(false);
  const [removingWorkspace,setRemovingWorkspace]=useState<string | null>(null);
  const [removingConversation,setRemovingConversation]=useState<string | null>(null);
  const {data:hub}=useQuery({queryKey:['hubState'],queryFn:api.getState,refetchInterval:3000});

  // An explicitly empty registry means all workspaces were removed from the
  // ChatMCP sidebar. Never reintroduce the old primary path from Hub state.
  const workspaceEntries=hub?.workspaces
    ? hub.workspaces.items
    : hub?.workspace?.path
      ? [{path:hub.workspace.path,name:hub.workspace.path.split(/[\\/]/).filter(Boolean).pop()||'Workspace'}]
      : [];
  const activeWorkspace=workspaceEntries.find(w=>w.path===selectedWorkspacePath)?.path
    || hub?.workspaces?.activePath || workspaceEntries[0]?.path || '';
  const allTasks=hub?.tasks||[];
  // Conversations are first-class sidebar entities. Model-spawned child tasks
  // remain inside their parent conversation's background execution, not here.
  const conversations=useMemo(()=>allTasks.filter(x=>!x.parentTaskId&&!x.linkedFromTaskId),[allTasks]);
  const latestSegment=(rootId:string)=>{
    return allTasks.filter(x=>!x.parentTaskId&&(x.conversationId||x.id)===rootId)
      .sort((a,b)=>String(b.createdAt||b.updatedAt||'').localeCompare(String(a.createdAt||a.updatedAt||'')))[0];
  };
  const perWorkspace=(folder:string)=>conversations.filter(item=>{
    const source=item.workspacePath||item.workspace?.path||hub?.workspace?.path;
    const query=search.trim().toLocaleLowerCase();
    return source===folder && (!query ||
      (item.task||item.prompt||'').toLocaleLowerCase().includes(query));
  });

  useEffect(()=>{
    if(!hub)return;
    if(selectedWorkspacePath!==activeWorkspace){
      setSelectedWorkspacePath(activeWorkspace);
      // Previously saved chat selections must not reopen a detached project.
      if(selectedTaskId)setSelectedTaskId('');
    }
  },[hub,activeWorkspace,selectedWorkspacePath,selectedTaskId,setSelectedWorkspacePath,setSelectedTaskId]);

  const createConversation=()=>setSelectedTaskId('');
  const pickWorkspace=async()=>{
    if(choosing)return;
    setChoosing(true);
    try{
      // Windows native Explorer-style folder selection; the picker is safe to
      // open while agents in any already selected workspace keep running.
      const result=await api.browseWorkspace(activeWorkspace||null);
      if(!result.path)return;
      const added=await api.addWorkspace(result.path);
      await api.activateWorkspace(added.workspace.path);
      setSelectedWorkspacePath(added.workspace.path);
      setSelectedTaskId('');
      await queryClient.invalidateQueries({queryKey:['hubState']});
    }catch(error){
      showToast(error instanceof Error?error.message:t('agents_side_pick_failed'),'error');
      setManualFolderOpen(true);
    }finally{setChoosing(false);}
  };
  const addManualWorkspace=async()=>{
    if(!manualFolder.trim()||choosing)return;
    setChoosing(true);
    try{
      const added=await api.addWorkspace(manualFolder.trim());
      await api.activateWorkspace(added.workspace.path);
      setSelectedWorkspacePath(added.workspace.path);
      setSelectedTaskId('');
      setManualFolder('');
      setManualFolderOpen(false);
      await queryClient.invalidateQueries({queryKey:['hubState']});
      showToast(t('agents_side_picked',{path:added.workspace.path}),'success');
    }catch(e){showToast(e instanceof Error?e.message:t('agents_side_path_invalid'),'error');}
    finally{setChoosing(false);}
  };
  const selectWorkspace=async(folder:string)=>{
    try{
      await api.activateWorkspace(folder);
      setSelectedWorkspacePath(folder);
      setSelectedTaskId('');
      await queryClient.invalidateQueries({queryKey:['hubState']});
    }catch(error){showToast(error instanceof Error?error.message:t('agents_bg_open_workspace_failed'),'error');}
  };
  const selectConversation=async(id:string,folder:string)=>{
    if(folder!==activeWorkspace){
      await api.activateWorkspace(folder).catch(()=>{});
      setSelectedWorkspacePath(folder);
    }
    setSelectedTaskId(latestSegment(id)?.id||id);
  };
  const removeWorkspace=async(folder:string,name:string)=>{
    if(removingWorkspace)return;
    const count=perWorkspace(folder).length;
    if(!window.confirm(t(count===1?'agents_side_remove_confirm_one':'agents_side_remove_confirm_other',{name,n:count})))return;
    setRemovingWorkspace(folder);
    try{
      const result=await api.removeWorkspace(folder);
      if(activeWorkspace===folder || selectedWorkspacePath===folder){
        setSelectedTaskId('');
        setSelectedWorkspacePath(result.activePath||'');
      }
      await Promise.all([
        queryClient.invalidateQueries({queryKey:['hubState']}),
        queryClient.invalidateQueries({queryKey:['backgroundRuns']}),
      ]);
      showToast(t('agents_side_removed'),'success');
    }catch(error){showToast(error instanceof Error?error.message:t('agents_side_remove_failed'),'error');}
    finally{setRemovingWorkspace(null);}
  };
  const removeConversation=async(id:string,title:string)=>{
    if(removingConversation)return;
    const related=allTasks.filter(task=>task.id!==id&&task.conversationId===id).length;
    if(!window.confirm(t(!related?'agents_side_delete_confirm':related===1?'agents_side_delete_confirm_one':'agents_side_delete_confirm_other',{title,n:related})))return;
    setRemovingConversation(id);
    try{
      await api.deleteTask(id);
      if(selectedTaskId===id)setSelectedTaskId('');
      queryClient.removeQueries({queryKey:['task',id]});
      await Promise.all([
        queryClient.invalidateQueries({queryKey:['hubState']}),
        queryClient.invalidateQueries({queryKey:['backgroundRuns']}),
      ]);
      showToast(t('agents_side_deleted'),'success');
    }catch(error){showToast(error instanceof Error?error.message:t('agents_side_delete_failed'),'error');}
    finally{setRemovingConversation(null);}
  };

  return <aside className="flex h-full w-full min-w-0 select-none flex-col border-r border-line bg-panel">
    <div className="space-y-2.5 border-b border-line p-3">
      <Button size="sm" variant="primary" onClick={createConversation}
        className="h-9 w-full gap-1.5 px-2.5">
        <Plus className="h-4 w-4"/><span>{t('new_conversation_btn')}</span>
      </Button>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"/>
        <input aria-label={t('agents_side_search')} type="text" value={search}
          onChange={e=>setSearch(e.target.value)} placeholder={t('search_sessions')}
          className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-2.5 text-[13px] text-fg placeholder:text-faint transition-colors hover:border-line-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25"/>
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <div className="flex items-center justify-between px-2 pb-1 pt-2">
        <span className="text-[12px] font-medium text-faint">{t('sidebar_workspaces')}</span>
        <button type="button" aria-label={t('sidebar_add_workspace')} title={t('agents_side_add_hint')}
          onClick={()=>void pickWorkspace()} disabled={choosing}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg">
          {choosing?<Loader2 className="h-4 w-4 animate-spin"/>:<Plus className="h-4 w-4"/>}
        </button>
      </div>
      {manualFolderOpen&&<form onSubmit={e=>{e.preventDefault();void addManualWorkspace();}}
        className="mx-1 mb-2 space-y-2 rounded-xl border border-line bg-surface p-3">
        <label className="block text-[12px] leading-4 text-muted">{t('agents_side_manual')}</label>
        <input aria-label={t('agents_side_manual_label')} value={manualFolder}
          onChange={e=>setManualFolder(e.target.value)} placeholder="F:\\Personal_Project\\Vin\\ChatMCP"
          className="h-8 w-full rounded-lg border border-line bg-panel px-2.5 font-mono text-[12px] text-fg focus:border-primary focus:outline-none"/>
        <div className="flex gap-2">
          <button type="submit" disabled={!manualFolder.trim()||choosing}
            className="h-8 rounded-lg bg-primary px-3 text-[13px] font-semibold text-primary-fg disabled:opacity-50">{t('sidebar_add_workspace')}</button>
          <button type="button" onClick={()=>setManualFolderOpen(false)}
            className="h-8 px-2 text-[13px] text-muted hover:text-fg">{t('agents_side_cancel')}</button>
        </div>
      </form>}
      {!workspaceEntries.length&&<div className="p-3 text-[13px] leading-5 text-faint">
        {t('sidebar_empty_workspaces')}
      </div>}
      {workspaceEntries.map(entry=>{
        const folder=entry.path, current=folder===activeWorkspace, shut=collapsed[folder]===true;
        const items=perWorkspace(folder);
        return <div key={folder} className="mb-1">
          <div className={'group flex items-center gap-0.5 rounded-lg px-1 '+(current?'bg-hover':'hover:bg-hover')}>
            <button type="button" aria-label={shut?t('agents_side_open',{name:entry.name}):t('agents_side_shut',{name:entry.name})}
              onClick={()=>setCollapsed(v=>({...v,[folder]:!shut}))} className="flex h-7 w-6 items-center justify-center text-faint hover:text-fg">
              <ChevronRight className={'h-3.5 w-3.5 transition-transform '+(shut?'':'rotate-90')}/>
            </button>
            <button type="button" title={folder} onClick={()=>void selectWorkspace(folder)}
              aria-pressed={current}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left">
              <FolderGit2 className={'h-4 w-4 shrink-0 '+(current?'text-primary':'text-muted')}/>
              <span className="truncate text-[13px] font-semibold text-fg">{entry.name}</span>
            </button>
            <span className="px-1 text-[12px] tabular-nums text-faint">{items.length}</span>
            <button type="button" aria-label={t('agents_side_remove_label',{name:entry.name})}
              title={t('agents_side_remove_hint')}
              disabled={removingWorkspace!==null}
              onClick={()=>void removeWorkspace(folder,entry.name)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-faint opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-30">
              {removingWorkspace===folder?<Loader2 className="h-3.5 w-3.5 animate-spin"/>:<Trash2 className="h-3.5 w-3.5"/>}
            </button>
          </div>
          {!shut&&<div className="space-y-0.5 pb-1 pl-4 pt-1">
            {items.map(chat=>{
              const selected=chat.id===selectedTaskId||latestSegment(chat.id)?.id===selectedTaskId;
              const busy=isTaskActive(chat)||allTasks.some(task=>task.id!==chat.id&&task.conversationId===chat.id&&isTaskActive(task));
              const when=latestSegment(chat.id)?.updatedAt||chat.updatedAt||chat.createdAt;
              return <div key={chat.id} className={'group flex items-center gap-1 rounded-lg '+(selected?'bg-primary/10':'hover:bg-hover')}>
                <button onClick={()=>void selectConversation(chat.id,folder)} title={chat.task||chat.prompt}
                  aria-current={selected?'true':undefined}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left">
                  {isTaskActive(chat)
                    ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"/>
                    : <MessageSquare className={'h-3.5 w-3.5 shrink-0 '+(selected?'text-primary':'text-faint')}/>}
                  <span className="min-w-0 flex-1">
                    <span className={'block truncate text-[13px] leading-5 '+(selected?'font-medium text-primary':'text-fg')}>
                      {chat.task||chat.prompt||t('agents_bg_untitled_chat')}
                    </span>
                    {when&&<span className="block truncate text-[12px] leading-4 text-faint">{formatRelative(when,lang)}</span>}
                  </span>
                </button>
                <button type="button"
                  onClick={()=>void removeConversation(chat.id,chat.task||chat.prompt||t('agents_bg_untitled_chat'))}
                  aria-label={t('agents_side_delete_label',{title:chat.task||chat.prompt||chat.id})}
                  title={busy?t('agents_side_delete_busy'):t('agents_side_delete_hint')}
                  disabled={busy||removingConversation!==null}
                  className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-faint opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0">
                  {removingConversation===chat.id?<Loader2 className="h-3.5 w-3.5 animate-spin"/>:<Trash2 className="h-3.5 w-3.5"/>}
                </button>
              </div>;
            })}
            {!items.length&&current&&<p className="px-2 py-2 text-[12px] leading-4 text-faint">
              {t('sidebar_empty_chats')}
            </p>}
          </div>}
        </div>;
      })}
    </div>
  </aside>;
}
