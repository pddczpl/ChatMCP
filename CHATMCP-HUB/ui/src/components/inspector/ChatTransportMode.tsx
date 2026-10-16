import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import type { HubState } from '@/types';
import {
  Bot, Globe2, Link2, Loader2, CheckCircle2, AlertCircle,
  Copy, ExternalLink, Unplug, FolderOpen,
} from 'lucide-react';

export function ChatTransportMode({hub}:{hub?:HubState}){
  const queryClient=useQueryClient();
  const {showToast,selectedWorkspacePath}=useAppStore();
  const mode=hub?.agent?.mode==='chatgpt-web'?'chatgpt-web':'api';
  const browser=hub?.browser;
  const busy=Boolean(hub?.agent?.activeTaskId ||
    (hub?.agent?.activeTaskIds?.length||0)>0);
  const workspace=selectedWorkspacePath||hub?.workspaces?.activePath||hub?.workspace?.path||'';
  const registered=hub?.workspaces?.items?.some(x=>x.path===workspace);
  const [switching,setSwitching]=useState(false);
  const [pairing,setPairing]=useState(false);
  const [unpairing,setUnpairing]=useState(false);
  const [pairCode,setPairCode]=useState('');
  const [pairExpiry,setPairExpiry]=useState('');
  const refresh=async()=>queryClient.invalidateQueries({queryKey:['hubState']});

  const chooseMode=async(next:'api'|'chatgpt-web')=>{
    if(mode===next||switching)return;
    setSwitching(true);
    try{
      await api.setAgentMode(next);
      setPairCode('');
      await refresh();
      showToast(next==='chatgpt-web'
        ? 'Đã chọn ChatGPT Web. Ghép Browser Companion trước khi giao việc.'
        : 'Đã chọn API Gateway cho các coding agents.','success');
    }catch(e){showToast(e instanceof Error?e.message:'Không đổi được chế độ AI.','error');}
    finally{setSwitching(false);}
  };
  const requestPair=async()=>{
    setPairing(true);
    try{
      const response=await api.createBrowserPairCode();
      setPairCode(response.code);
      setPairExpiry(response.expiresAt);
      showToast('Mã ghép có hiệu lực 5 phút. Nhập mã trong popup của tiện ích ChatMCP Hub Companion.','info');
      await refresh();
    }catch(e){showToast(e instanceof Error?e.message:'Không thể tạo mã ghép.','error');}
    finally{setPairing(false);}
  };
  const unpair=async()=>{
    if(!window.confirm('Ngắt ghép Browser Companion? Phiên ChatGPT và các tệp dự án không bị xoá.'))return;
    setUnpairing(true);
    try{
      await api.unpairBrowser();
      setPairCode('');
      await refresh();
      showToast('Đã ngắt ghép tiện ích ChatGPT Web.','success');
    }catch(e){showToast(e instanceof Error?e.message:'Không ngắt được tiện ích.','error');}
    finally{setUnpairing(false);}
  };
  const copyCode=async()=>{
    try{await navigator.clipboard.writeText(pairCode);showToast('Đã sao chép mã ghép.','success');}
    catch{showToast('Không thể sao chép tự động. Bạn có thể chọn và sao chép mã bằng tay.','info');}
  };

  return <section className="rounded-lg border border-[var(--line)] p-3 space-y-3 bg-[var(--surface)]"
    data-testid="chat-transport-mode">
    <div>
      <h3 className="font-semibold text-[var(--text)] text-xs">Chế độ kết nối AI</h3>
      <p className="text-[11px] text-[var(--muted)] mt-1">
        Chọn API provider hoặc dùng một tab ChatGPT Web đã đăng nhập cùng Browser Companion.
      </p>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <button type="button" disabled={switching||busy}
        aria-pressed={mode==='api'} onClick={()=>void chooseMode('api')}
        className={'p-2 rounded-lg border text-left text-xs disabled:opacity-40 '+
          (mode==='api'?'border-sky-500 bg-sky-500/10 text-[var(--text)]':'border-[var(--line)] text-[var(--muted)]')}>
        <Bot className="w-4 h-4 inline mr-1"/> API Gateway
        <span className="block mt-1 text-[10px]">OpenAI, Gemini, Claude, DeepSeek, OpenRouter…</span>
      </button>
      <button type="button" disabled={switching||busy}
        aria-pressed={mode==='chatgpt-web'} onClick={()=>void chooseMode('chatgpt-web')}
        className={'p-2 rounded-lg border text-left text-xs disabled:opacity-40 '+
          (mode==='chatgpt-web'?'border-sky-500 bg-sky-500/10 text-[var(--text)]':'border-[var(--line)] text-[var(--muted)]')}>
        <Globe2 className="w-4 h-4 inline mr-1"/> ChatGPT Web
        <span className="block mt-1 text-[10px]">Chrome/Edge · Browser Companion · Không cần API key</span>
      </button>
    </div>
    {mode==='chatgpt-web'&&<div className="space-y-2 pt-2 border-t border-[var(--line)]"
      data-testid="chatgpt-web-settings">
      <div role="status" className="flex items-center gap-2 text-xs">
        {browser?.connected
          ?<CheckCircle2 className="w-4 h-4 text-emerald-500"/>
          :<AlertCircle className="w-4 h-4 text-amber-500"/>}
        <span className="text-[var(--text)] font-medium">
          {browser?.connected?'Companion đang kết nối':
            browser?.paired?'Đã ghép · Đang chờ trình duyệt kết nối':'Chưa ghép Browser Companion'}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--muted)] break-all">
        <FolderOpen className="w-3.5 h-3.5 flex-shrink-0"/>
        <span>Workspace cho task mới: {workspace||'Chưa chọn thư mục'}</span>
      </div>
      {!registered&&<p role="status" className="text-[11px] text-amber-500">
        Chọn workspace bằng dấu + ở sidebar trước khi bắt đầu. Một task Web dùng chính workspace đã chọn.
      </p>}
      <div className="text-[11px] text-[var(--muted)] space-y-1.5">
        <p>1. Mở <code>chrome://extensions</code> hoặc <code>edge://extensions</code>, bật Developer mode và chọn <strong>Load unpacked</strong>.</p>
        <p>2. Nạp thư mục <code>CHATMCP-HUB\extension</code> của bản ChatMCP đang cài (có <code>manifest.json</code>).</p>
        <p>3. Mở <a className="text-[var(--primary)] underline" href="https://chatgpt.com" target="_blank" rel="noopener noreferrer">
          chatgpt.com <ExternalLink className="w-3 h-3 inline"/>
        </a>, tự đăng nhập và chọn chế độ Chat thông thường, không phải Work/Codex/Agent.</p>
        <p>4. Tạo mã ghép ở đây, mở popup ChatMCP Hub Companion, nhập mã và bấm <strong>Ghép và bật</strong>.</p>
      </div>
      {!browser?.paired&&<button type="button" onClick={()=>void requestPair()} disabled={pairing||busy}
        className="px-3 py-1.5 rounded-md border border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--surface-hover)] flex gap-1.5 items-center disabled:opacity-40">
        {pairing?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:<Link2 className="w-3.5 h-3.5"/>}
        Tạo mã ghép (5 phút)
      </button>}
      {pairCode&&!browser?.paired&&<div className="rounded-md border border-sky-500/40 bg-sky-500/10 p-2 flex gap-2 items-center">
        <div className="flex-1">
          <label htmlFor="browser-pair-code" className="text-[11px] block text-[var(--muted)]">Mã ghép 8 chữ số</label>
          <input id="browser-pair-code" value={pairCode} readOnly aria-label="Mã ghép Browser Companion"
            className="font-mono font-semibold tracking-[.22em] text-sm text-[var(--text)] bg-transparent w-full"/>
          {pairExpiry&&<span className="text-[10px] text-[var(--muted)]">Hết hạn: {new Date(pairExpiry).toLocaleTimeString()}</span>}
        </div>
        <button type="button" onClick={()=>void copyCode()} aria-label="Sao chép mã ghép"
          className="p-1.5 hover:bg-[var(--surface-hover)] rounded-md"><Copy className="w-4 h-4"/></button>
      </div>}
      {browser?.paired&&<button type="button" disabled={unpairing||busy} onClick={()=>void unpair()}
        className="px-3 py-1.5 rounded-md border border-[var(--line)] flex items-center gap-1.5 text-xs text-[var(--muted)] disabled:opacity-40">
        <Unplug className="w-3.5 h-3.5"/> Ngắt ghép tiện ích
      </button>}
      <p className="text-[10px] text-[var(--faint)]">
        ChatGPT Web sử dụng tài khoản/giới hạn của tab ChatGPT; không biến gói ChatGPT thành API.
        Companion chỉ hỗ trợ text, một tác vụ Web tại một thời điểm. Không vượt đăng nhập, CAPTCHA,
        giới hạn sử dụng hoặc quyền phê duyệt. Lệnh được thực thi bởi Hub cục bộ sau khi xác minh
        task/turn/nonce; không tự gửi lại thao tác ghi chưa xác nhận.
      </p>
    </div>}
  </section>;
}
