import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { GitBranch, GitMerge, ChevronDown } from 'lucide-react';

export function GitWorkspacePicker({workspace}:{workspace:string}) {
  const [open,setOpen]=useState(false);
  const {selectedBaseRef,setSelectedBaseRef,showToast,setSelectedWorkspacePath,setSelectedTaskId}=useAppStore();
  const queryClient=useQueryClient();
  const {data,error}=useQuery({queryKey:['gitRefs',workspace],queryFn:()=>api.getGitRefs(workspace),
    enabled:Boolean(workspace),refetchInterval:7000});
  const selectedName=selectedBaseRef ? data?.branches.find(b=>b.ref===selectedBaseRef)?.name : data?.currentBranch;
  const selectWorktree=async(path:string)=>{
    setOpen(false);
    try {
      const selected=await api.addWorkspace(path);
      await api.activateWorkspace(selected.workspace.path);
      setSelectedWorkspacePath(selected.workspace.path);
      setSelectedTaskId('');
      setSelectedBaseRef('');
      await queryClient.invalidateQueries({queryKey:['hubState']});
      await queryClient.invalidateQueries({queryKey:['gitRefs']});
      showToast('Đã chọn worktree '+path,'success');
    } catch(e) {
      showToast(e instanceof Error?e.message:'Không thể chuyển worktree.','error');
    }
  };
  return <div className="relative hidden md:block">
    <button aria-expanded={open} aria-label="Chọn nhánh Git và worktree"
      className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-line text-xs text-muted hover:bg-hover"
      onClick={()=>setOpen(x=>!x)}>
      <GitBranch className="w-3.5 h-3.5"/><span className="truncate max-w-32">{selectedName||'Git refs'}</span>
      <ChevronDown className="w-3 h-3"/>
    </button>
    {open && <div className="absolute top-full left-0 z-50 mt-2 w-80 max-h-96 overflow-y-auto rounded-lg border border-line bg-panel p-3 shadow-xl">
      <div className="text-xs font-semibold mb-1">Nhánh nguồn cho chat mới</div>
      <select className="w-full border rounded-md bg-surface text-xs p-2 border-line"
        aria-label="Nhánh nguồn Git" value={selectedBaseRef} onChange={e=>setSelectedBaseRef(e.target.value)}>
        <option value="">HEAD hiện tại</option>
        {(data?.branches||[]).map(b=><option key={b.ref} value={b.ref}>{b.name}</option>)}
      </select>
      <p className="mt-1 text-[12px] text-faint">Chat mới tạo worktree riêng từ commit của nhánh nguồn. Thay đổi chưa commit không được sao chép.</p>
      <div className="mt-3 text-xs font-semibold">Các Git worktree đã có</div>
      {error && <p role="alert" className="text-xs text-danger mt-1">{error.message}</p>}
      <div className="space-y-1 mt-1">
        {(data?.worktrees||[]).map(w=><button key={w.path} onClick={()=>void selectWorktree(w.path)}
          title={w.path} className="w-full p-2 rounded border border-line text-xs text-left hover:bg-hover">
          <span className="flex items-center gap-1"><GitMerge className="w-3 h-3"/>{w.branch||'detached HEAD'}</span>
          <span className="block truncate text-[12px] text-muted">{w.path}</span>
        </button>)}
        {!data?.worktrees?.length && <p className="text-xs text-faint">Chưa tìm thấy worktree.</p>}
      </div>
    </div>}
  </div>;
}
