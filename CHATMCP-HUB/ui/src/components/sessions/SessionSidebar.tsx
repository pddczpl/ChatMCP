import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { FolderGit2, Plus, Search, Trash2, Loader2, MessageSquare, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/lib/i18n';
import { isTaskActive } from '@/lib/task-view';

export function SessionSidebar() {
  const {
    selectedTaskId,setSelectedTaskId,selectedWorkspacePath,setSelectedWorkspacePath,
    showToast,
  }=useAppStore();
  const {t}=useTranslation();
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
  const conversations=useMemo(()=>allTasks.filter(x=>!x.parentTaskId),[allTasks]);
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
      showToast(error instanceof Error?error.message:'Không thể chọn workspace.','error');
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
      showToast('Đã chọn workspace '+added.workspace.path,'success');
    }catch(e){showToast(e instanceof Error?e.message:'Đường dẫn workspace không hợp lệ.','error');}
    finally{setChoosing(false);}
  };
  const selectWorkspace=async(folder:string)=>{
    try{
      await api.activateWorkspace(folder);
      setSelectedWorkspacePath(folder);
      setSelectedTaskId('');
      await queryClient.invalidateQueries({queryKey:['hubState']});
    }catch(error){showToast(error instanceof Error?error.message:'Không thể chuyển workspace.','error');}
  };
  const selectConversation=async(id:string,folder:string)=>{
    if(folder!==activeWorkspace){
      await api.activateWorkspace(folder).catch(()=>{});
      setSelectedWorkspacePath(folder);
    }
    setSelectedTaskId(id);
  };
  const removeWorkspace=async(folder:string,name:string)=>{
    if(removingWorkspace)return;
    const count=perWorkspace(folder).length;
    if(!window.confirm('Gỡ workspace "'+name+'" khỏi ChatMCP?\n\n'
      +count+' hội thoại và các background tasks của workspace sẽ được ẩn khỏi giao diện. '
      +'Lịch sử vẫn được lưu và hiện lại khi thêm đúng thư mục.\n\n'
      +'KHÔNG xoá thư mục, file, nhánh Git hay worktree trên máy.'))return;
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
      showToast('Đã gỡ workspace khỏi danh sách. Tệp trên ổ đĩa vẫn được giữ nguyên.','success');
    }catch(error){showToast(error instanceof Error?error.message:'Không thể gỡ workspace.','error');}
    finally{setRemovingWorkspace(null);}
  };
  const removeConversation=async(id:string,title:string)=>{
    if(removingConversation)return;
    const related=allTasks.filter(task=>task.id!==id&&task.conversationId===id).length;
    if(!window.confirm('Xóa hội thoại "'+title+'"?\n\n'
      +'Lịch sử các lượt task'+(related?' và '+related+' subagent':'')+' sẽ bị xóa khỏi ChatMCP. '
      +'Không thể hoàn tác việc xóa lịch sử.\n\n'
      +'KHÔNG xóa file dự án, nhánh Git hay worktree.'))return;
    setRemovingConversation(id);
    try{
      await api.deleteTask(id);
      if(selectedTaskId===id)setSelectedTaskId('');
      queryClient.removeQueries({queryKey:['task',id]});
      await Promise.all([
        queryClient.invalidateQueries({queryKey:['hubState']}),
        queryClient.invalidateQueries({queryKey:['backgroundRuns']}),
      ]);
      showToast('Đã xóa hội thoại và các tác vụ con. Các tệp dự án được giữ nguyên.','success');
    }catch(error){showToast(error instanceof Error?error.message:'Không thể xóa hội thoại.','error');}
    finally{setRemovingConversation(null);}
  };

  return <aside className="w-full h-full flex flex-col bg-[var(--panel)] border-r border-[var(--line)] min-w-0 select-none">
    <div className="p-3 border-b border-[var(--line)] space-y-2.5">
      <Button size="sm" variant="primary" onClick={createConversation}
        className="w-full text-xs px-2.5 gap-1.5">
        <Plus className="w-3.5 h-3.5"/><span>{t('new_conversation_btn')}</span>
      </Button>
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]"/>
        <input aria-label="Tìm hội thoại" type="text" value={search}
          onChange={e=>setSearch(e.target.value)} placeholder={t('search_sessions')}
          className="w-full bg-[var(--surface)] text-[var(--text)] text-xs rounded-md pl-8 pr-2.5 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"/>
      </div>
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto p-2">
      <div className="flex items-center justify-between px-2 py-2">
        <span className="text-xs font-medium text-[var(--muted)]">This computer · Workspaces</span>
        <button type="button" aria-label="Thêm workspace" title="Chọn thư mục bằng Windows Explorer"
          onClick={()=>void pickWorkspace()} disabled={choosing}
          className="p-1 rounded hover:bg-[var(--surface-hover)] text-[var(--muted)]">
          {choosing?<Loader2 className="w-4 h-4 animate-spin"/>:<Plus className="w-4 h-4"/>}
        </button>
      </div>
      {manualFolderOpen&&<form onSubmit={e=>{e.preventDefault();void addManualWorkspace();}}
        className="mx-2 mb-2 rounded-md border border-[var(--line)] p-2 space-y-1.5">
        <label className="block text-[11px] text-[var(--muted)]">Nhập đường dẫn thư mục nếu hộp chọn Windows không mở</label>
        <input aria-label="Nhập đường dẫn workspace thủ công" value={manualFolder}
          onChange={e=>setManualFolder(e.target.value)} placeholder="F:\\Personal_Project\\Vin\\ChatMCP"
          className="w-full px-2 py-1.5 rounded bg-[var(--surface)] border border-[var(--line)] text-xs text-[var(--text)]"/>
        <div className="flex gap-2">
          <button type="submit" disabled={!manualFolder.trim()||choosing}
            className="text-xs px-2 py-1 bg-[var(--primary)] text-white rounded disabled:opacity-50">Thêm workspace</button>
          <button type="button" onClick={()=>setManualFolderOpen(false)}
            className="text-xs text-[var(--muted)]">Hủy</button>
        </div>
      </form>}
      {!workspaceEntries.length&&<div className="p-3 text-xs text-[var(--faint)]">
        Chưa có workspace. Bấm dấu + để chọn thư mục trên máy Windows.
      </div>}
      {workspaceEntries.map(entry=>{
        const folder=entry.path, current=folder===activeWorkspace, shut=collapsed[folder]===true;
        const items=perWorkspace(folder);
        return <div key={folder} className="mb-2">
          <div className={'rounded-md flex items-center gap-1 px-1 py-1 '+(current?'bg-[var(--surface-hover)]':'')}>
            <button type="button" aria-label={shut?'Mở nhóm '+entry.name:'Thu gọn nhóm '+entry.name}
              onClick={()=>setCollapsed(v=>({...v,[folder]:!shut}))} className="p-1 text-[var(--faint)]">
              {shut?<ChevronRight className="w-3.5 h-3.5"/>:<ChevronDown className="w-3.5 h-3.5"/>}
            </button>
            <button type="button" title={folder} onClick={()=>void selectWorkspace(folder)}
              aria-pressed={current}
              className="flex-1 min-w-0 flex items-center gap-2 py-1 text-left">
              <FolderGit2 className="w-4 h-4 flex-shrink-0 text-[var(--primary)]"/>
              <span className="text-xs truncate text-[var(--text)] font-medium">{entry.name}</span>
            </button>
            <span className="text-[10px] text-[var(--faint)]">{items.length}</span>
            <button type="button" aria-label={'Gỡ workspace '+entry.name}
              title="Gỡ khỏi ChatMCP — không xóa thư mục trên ổ đĩa"
              disabled={removingWorkspace!==null}
              onClick={()=>void removeWorkspace(folder,entry.name)}
              className="p-1 rounded text-[var(--muted)] hover:text-rose-400 hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-rose-400 disabled:opacity-30">
              {removingWorkspace===folder?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:<Trash2 className="w-3.5 h-3.5"/>}
            </button>
          </div>
          {!shut&&<div className="pl-5 pt-1 space-y-0.5">
            {items.map(chat=>{
              const selected=chat.id===selectedTaskId;
              const busy=isTaskActive(chat)||allTasks.some(task=>task.id!==chat.id&&task.conversationId===chat.id&&isTaskActive(task));
              return <div key={chat.id} className={'group flex items-center gap-1 rounded-md '+(selected?'bg-[var(--primary-bg)]':'hover:bg-[var(--surface-hover)]')}>
                <button onClick={()=>void selectConversation(chat.id,folder)} title={chat.task||chat.prompt}
                  className="flex-1 min-w-0 p-1.5 flex items-center gap-2 text-left text-xs">
                  {isTaskActive(chat)
                    ? <Loader2 className="w-3 h-3 animate-spin text-sky-400 flex-shrink-0"/>
                    : <MessageSquare className="w-3 h-3 text-[var(--faint)] flex-shrink-0"/>}
                  <span className={'truncate '+(selected?'text-[var(--primary)]':'text-[var(--muted)]')}>
                    {chat.task||chat.prompt||'Cuộc hội thoại'}
                  </span>
                </button>
                <button type="button"
                  onClick={()=>void removeConversation(chat.id,chat.task||chat.prompt||'Cuộc hội thoại')}
                  aria-label={'Xóa hội thoại: '+(chat.task||chat.prompt||chat.id)}
                  title={busy?'Dừng task và subagent trước khi xóa':'Xóa hội thoại và lịch sử task (không xóa file)'}
                  disabled={busy||removingConversation!==null}
                  className="p-1 rounded text-[var(--muted)] hover:text-rose-400 hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-rose-400 disabled:opacity-20">
                  {removingConversation===chat.id?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:<Trash2 className="w-3.5 h-3.5"/>}
                </button>
              </div>;
            })}
            {!items.length&&current&&<p className="px-2 py-2 text-[11px] text-[var(--faint)]">
              Chưa có hội thoại. Tạo chat mới để giao việc.
            </p>}
          </div>}
        </div>;
      })}
    </div>
  </aside>;
}
