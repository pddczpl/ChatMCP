import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { 
  Settings, 
  Shield, 
  Moon, 
  Sun, 
  Globe, 
  Download, 
  Server, 
  UserCheck,
  Folder,
  Bot,
  Link2,
  Copy,
  CircleCheck,
  Sparkles,
  RefreshCw
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ChatGptWebRiskNote } from '@/components/approval/ChatGptWebRiskNote';

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').replaceAll('\\', '/').toLowerCase() === b.replace(/[\\/]+$/, '').replaceAll('\\', '/').toLowerCase();

export function SettingsTab() {
  const { theme, setTheme, lang, setLang, showToast, setFullAccessModalOpen, setOnboardingOpen,
    selectedWorkspacePath,setSelectedWorkspacePath } = useAppStore();
  const queryClient=useQueryClient();
  const { t } = useTranslation();

  const { data: hub, error: hubError, refetch } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const { data: sandboxStatus, isLoading: isSandboxLoading } = useQuery({
    queryKey: ['sandboxStatus'],
    queryFn: api.getSandboxStatus,
    refetchInterval: 5000,
  });
  const { data: intelligence, refetch: refreshIntelligence } = useQuery({
    queryKey: ['intelligenceEngineHealth'],
    queryFn: api.getIntelligenceStatus,
    enabled: Boolean(hub?.workspace?.path),
    refetchInterval: 12000,
  });
  const [probingIntelligence, setProbingIntelligence] = useState(false);
  const probeIntelligence = async () => {
    setProbingIntelligence(true);
    try {
      await api.probeIntelligenceEngines();
      await refreshIntelligence();
      showToast('Đã kiểm tra các Code Intelligence engines', 'success');
    } catch (error: any) {
      showToast(error.message || 'Không thể kiểm tra Code Intelligence', 'error');
    } finally { setProbingIntelligence(false); }
  };
  const permissions: any = hub?.studio?.permissions || {};
  const currentMode = permissions.mode || 'review';
  const isFullAccess = permissions.executionPolicy === 'full-access';

  const currentWs = (hub?.workspaces?.items?.some(w=>w.path===selectedWorkspacePath)?selectedWorkspacePath:
    hub?.workspaces?.activePath) || hub?.workspace?.path || '';
  const [wsInput, setWsInput] = useState(currentWs);
  const [applyingWs, setApplyingWs] = useState(false);
  const [changingTransport,setChangingTransport]=useState(false);
  const [pairingBusy,setPairingBusy]=useState(false);
  const [pairCode,setPairCode]=useState<{code:string;expiresAt:string}|null>(null);
  const transport=hub?.agent?.mode||'api';
  const companion=hub?.browser;
  const changeTransport=async(mode:'api'|'chatgpt-web')=>{
    if(changingTransport)return;
    setChangingTransport(true);
    try{
      await api.setAgentMode(mode);
      await queryClient.invalidateQueries({queryKey:['hubState']});
      showToast(mode==='api'?'Đã chọn agent dùng Model API.':
        'Đã chọn ChatGPT Web Companion. Hãy ghép extension và đăng nhập ChatGPT trên trình duyệt.','success');
    }catch(e:any){showToast(e.message||'Không thể chuyển chế độ agent.','error');}
    finally{setChangingTransport(false);}
  };
  // "Review before send": off unless chosen; one global switch and an optional override for the workspace shown above.
  const [savingPrivacy,setSavingPrivacy]=useState(false);
  const reviewGlobal=companion?.privacy?.reviewBeforeSend===true;
  const workspaceOverride=companion?.privacy?.workspaces?.find(item=>currentWs&&samePath(item.path,currentWs));
  const savePrivacy=async(payload:{reviewBeforeSend?:boolean;workspacePath?:string;workspaceReview?:boolean|null},message:string)=>{
    if(savingPrivacy)return;
    setSavingPrivacy(true);
    try{
      await api.configureBrowserPrivacy(payload);
      await queryClient.invalidateQueries({queryKey:['hubState']});
      showToast(message,'success');
    }catch(e:any){showToast(e.message||'Không thể lưu cài đặt riêng tư.','error');}
    finally{setSavingPrivacy(false);}
  };
  const issuePairCode=async()=>{
    if(pairingBusy)return;
    setPairingBusy(true);
    try{
      const code=await api.createBrowserPairCode();
      setPairCode(code);
      showToast('Mã ghép có hiệu lực 5 phút. Nhập vào extension ChatMCP Hub Companion.','info');
    }catch(e:any){showToast(e.message||'Không thể tạo mã ghép.','error');}
    finally{setPairingBusy(false);}
  };
  const disconnectCompanion=async()=>{
    if(!window.confirm('Ngắt ghép ChatMCP Companion trên trình duyệt? Các cuộc chat đã lưu vẫn được giữ.'))return;
    setPairingBusy(true);
    try{
      await api.unpairBrowser();
      setPairCode(null);
      await queryClient.invalidateQueries({queryKey:['hubState']});
      showToast('Đã ngắt ghép tiện ích.','info');
    }catch(e:any){showToast(e.message||'Không thể ngắt ghép.','error');}
    finally{setPairingBusy(false);}
  };

  useEffect(() => {
    if (currentWs && !wsInput) {
      setWsInput(currentWs);
    }
  }, [currentWs]);

  const handleBrowseWs = async () => {
    try {
      const res = await api.browseWorkspace(currentWs||null);
      if(res.path){
        const added=await api.addWorkspace(res.path);
        await api.activateWorkspace(added.workspace.path);
        setWsInput(added.workspace.path);
        setSelectedWorkspacePath(added.workspace.path);
        await queryClient.invalidateQueries({queryKey:['hubState']});
        showToast(`${t('workspace_changed_toast')}: ${added.workspace.path}`,'success');
      }
    } catch (err: any) {
      showToast(err.message || 'Lỗi duyệt thư mục', 'error');
    }
  };

  const handleApplyWs = async () => {
    if (!wsInput.trim()) return;
    setApplyingWs(true);
    try {
      const added=await api.addWorkspace(wsInput.trim());
      await api.activateWorkspace(added.workspace.path);
      setWsInput(added.workspace.path);
      setSelectedWorkspacePath(added.workspace.path);
      await queryClient.invalidateQueries({queryKey:['hubState']});
      showToast(`${t('workspace_changed_toast')}: ${added.workspace.path}`,'success');
    } catch (err: any) {
      showToast(err.message || 'Lỗi thay đổi thư mục', 'error');
    } finally {
      setApplyingWs(false);
    }
  };

  const handleModeChange = async (mode: string) => {
    if (mode === 'full-access') {
      setFullAccessModalOpen(true);
      return;
    }
    try {
      await api.setPermissions({ mode, ...(isFullAccess ? { executionPolicy: 'host-review' } : {}) });
      showToast(`Đã đổi quyền sang ${mode}`, 'info');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi cập nhật quyền', 'error');
    }
  };

  const handleExportLogs = () => {
    const data = JSON.stringify(hub || {}, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chatmcp-audit-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Đã xuất nhật ký hệ thống', 'success');
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-4 select-none text-xs">
      {/* Workspace Directory Selector */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-sky-500/30 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 flex items-center justify-center">
              <Folder className="w-4 h-4" />
            </div>
            <div>
              <div className="font-semibold text-[var(--text)]">
                {t('workspace_setting_title')}
              </div>
              <div className="text-[10px] text-[var(--faint)]">
                {t('workspace_setting_desc')}
              </div>
            </div>
          </div>
          <button
            onClick={() => setOnboardingOpen(true)}
            className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--panel)] hover:bg-[var(--surface-hover)] border border-[var(--line-subtle)] text-[10px] text-sky-400 hover:text-sky-300 transition-colors"
            title={t('workspace_reopen_onboarding')}
          >
            <Sparkles className="w-3 h-3" />
            <span>{t('workspace_reopen_onboarding')}</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={wsInput}
            onChange={(e) => setWsInput(e.target.value)}
            placeholder="Đường dẫn thư mục dự án..."
            className="flex-1 bg-[var(--panel)] font-mono text-[11px] rounded-md px-2.5 py-1.5 border border-[var(--line)] text-[var(--text)] focus:border-sky-500 focus:outline-none"
          />
          <Button
            variant="secondary"
            onClick={handleBrowseWs}
            className="h-7 px-2.5 text-[11px] gap-1"
          >
            <Folder className="w-3 h-3 text-sky-400" />
            <span>{t('workspace_browse_btn')}</span>
          </Button>
          <Button
            variant="primary"
            onClick={handleApplyWs}
            disabled={applyingWs || !wsInput.trim() || wsInput === currentWs}
            className="h-7 px-2.5 text-[11px]"
          >
            {t('workspace_apply_btn')}
          </Button>
        </div>

        {currentWs && (
          <div className="text-[10px] text-[var(--muted)] font-mono truncate">
            <span className="text-[var(--faint)]">Đang dùng: </span>
            <span className="text-emerald-400 font-semibold">{currentWs}</span>
          </div>
        )}
      </div>

      {/* Local desktop scope */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 flex items-center justify-center">
            <UserCheck className="w-4 h-4" />
          </div>
          <div>
            <div className="font-semibold text-[var(--text)]">
              Máy tính cá nhân
            </div>
            <div className="text-[10px] text-[var(--faint)] font-mono uppercase">
              Một người dùng · Local Hub
            </div>
          </div>
        </div>

        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-sky-500/20 text-sky-400 border border-sky-500/30">
          Local-only
        </span>
      </div>

      {/* Execution Backend & OS Isolation */}
      <div data-testid="execution-backend-card" className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center border ${
              isSandboxLoading
                ? 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                : sandboxStatus?.osIsolated && sandboxStatus?.available
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
            }`}>
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <div className="font-semibold text-[var(--text)]">
                {t('sandbox_title')}
              </div>
              <div className="text-[10px] text-[var(--faint)]">
                {t('sandbox_desc')}
              </div>
            </div>
          </div>

          <span
            data-testid="backend-status-badge"
            className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
              isSandboxLoading
                ? 'bg-sky-500/20 text-sky-400 border-sky-500/30'
                : !sandboxStatus?.available
                  ? 'bg-rose-500/20 text-rose-400 border-rose-500/30'
                  : sandboxStatus?.osIsolated
                    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                    : 'bg-amber-500/20 text-amber-400 border-amber-500/30'
            }`}
          >
            {isSandboxLoading
              ? t('sandbox_probing')
              : !sandboxStatus?.available
                ? (lang === 'vi' ? 'Không khả dụng' : 'Unavailable')
                : sandboxStatus?.osIsolated
                  ? t('sandbox_isolated')
                  : t('sandbox_unisolated')}
          </span>
        </div>

        <div className="space-y-1.5 font-mono text-[10px] bg-[var(--panel)] p-2.5 rounded border border-[var(--line-subtle)]">
          <div className="flex justify-between items-center text-[var(--text)]">
            <span className="text-[var(--faint)]">{t('sandbox_backend')}:</span>
            <span className="font-semibold">{sandboxStatus?.backend || 'host'} ({sandboxStatus?.platform || 'local'})</span>
          </div>
          <div className="flex justify-between items-center text-[var(--text)]">
            <span className="text-[var(--faint)]">{t('sandbox_os_isolation')}:</span>
            <span className={sandboxStatus?.osIsolated ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
              {sandboxStatus?.osIsolated ? t('sandbox_isolation_active') : t('sandbox_isolation_none')}
            </span>
          </div>
          <div className="flex justify-between items-center text-[var(--text)]">
            <span className="text-[var(--faint)]">{t('sandbox_enforced')}:</span>
            <span className="text-emerald-400">
              {sandboxStatus?.enforcedLimits?.join(', ') || 'timeoutSeconds, maxOutputBytes'}
            </span>
          </div>
          <div className="flex justify-between items-center text-[var(--text)]">
            <span className="text-[var(--faint)]">{t('sandbox_unsupported')}:</span>
            <span className="text-amber-400/90">
              {sandboxStatus?.unsupportedLimits?.join(', ') || 'maxMemoryMb, maxCpuCores'} ({t('sandbox_unenforced_hint')})
            </span>
          </div>
          {sandboxStatus?.reasons && sandboxStatus.reasons.length > 0 && (
            <div className="pt-1 text-[10px] border-t border-[var(--line-subtle)] space-y-0.5">
              {sandboxStatus.reasons.map((r: string, idx: number) => (
                <div key={idx} className="leading-tight text-amber-400/80">• {r}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Real Code Intelligence checks: never advertise Ready on file presence. */}
      <section data-testid="code-intelligence-engines" className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] space-y-2.5">
        <div className="flex justify-between items-center gap-2">
          <div>
            <div className="font-semibold text-[var(--text)]">Code Intelligence Engines</div>
            <p className="text-[10px] text-[var(--faint)]">Trạng thái từ kết quả kiểm tra engine thực, không chỉ kiểm tra tệp</p>
          </div>
          <Button variant="secondary" onClick={probeIntelligence} disabled={probingIntelligence} className="h-7 text-[11px] gap-1">
            <RefreshCw className={'w-3 h-3 ' + (probingIntelligence ? 'animate-spin' : '')} />
            Kiểm tra lại
          </Button>
        </div>
        <div className="space-y-1.5">
          {[
            ['typescript-lsp', 'TypeScript LSP'],
            ['python-lsp', 'Python LSP (Pyright)'],
            ['tree-sitter', 'Tree-sitter WASM'],
            ['python-ast', 'Python Native AST'],
            ['heuristic', 'Heuristic Fallback'],
          ].map(([id, name]) => {
            const engine = intelligence?.engineHealth?.engines?.find((item: {id: string; status: string; source?: string; version?: string | null; detail?: string}) => item.id === id);
            const status = engine?.status || 'not_checked';
            return (
              <div key={id} className="flex items-start justify-between gap-2 rounded bg-[var(--panel)] px-2.5 py-2 border border-[var(--line-subtle)]">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-[var(--text)]">{name}</div>
                  <div className="text-[10px] text-[var(--faint)]">
                    {engine?.version ? 'v' + engine.version + ' · ' : ''}
                    {engine?.source || 'Chưa kiểm tra'}
                    {engine?.detail ? ' · ' + engine.detail : ''}
                  </div>
                </div>
                <span className={'text-[10px] font-semibold shrink-0 ' + (status === 'ready' ? 'text-emerald-400' : status === 'not_checked' ? 'text-[var(--muted)]' : 'text-amber-400')}>
                  {status === 'ready' ? 'Ready' : status === 'not_checked' ? 'Chưa kiểm tra' : 'Unavailable'}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* The browser transport is an existing paired extension, NOT a
          ChatGPT API token and never receives the user's login credentials. */}
      <section className="rounded-lg p-3 border border-[var(--line)] bg-[var(--surface)] space-y-3"
        data-testid="agent-transport-settings">
        <div className="flex items-center gap-2 text-[var(--text)] font-semibold">
          <Bot className="w-4 h-4 text-[var(--primary)]"/> Kênh điều khiển Coding Agent
        </div>
        <p className="text-[11px] text-[var(--muted)]">
          Kênh được chọn xử lý lượt tiếp theo kể cả trong hội thoại cũ. Khi đổi kênh, ChatMCP chuyển tóm tắt ngữ cảnh, liên kết với hội thoại gốc và không tự phát lại các thao tác sửa file chưa xác minh.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {([{id:'api',label:'Model API',hint:'Provider và API key đã cấu hình'},
             {id:'chatgpt-web',label:'ChatGPT Web',hint:'Qua extension Companion; không cần ChatGPT API key'}] as const).map(option=>
            <button type="button" key={option.id} disabled={changingTransport}
              aria-pressed={transport===option.id} aria-label={'Kênh agent: '+option.label}
              onClick={()=>void changeTransport(option.id)}
              className={'p-2 rounded-md border text-left space-y-1 disabled:opacity-50 '+
                (transport===option.id?'border-sky-500 bg-sky-500/10':'border-[var(--line)] hover:bg-[var(--surface-hover)]')}>
              <span className="block font-medium text-[var(--text)]">{option.label}</span>
              <span className="block text-[10px] text-[var(--faint)]">{option.hint}</span>
            </button>)}
        </div>
        {/* Visible BEFORE the person switches to this channel: what it automates, the Terms-of-Use risk, where content goes. */}
        <ChatGptWebRiskNote testId="chatgpt-web-risk-note"/>
        <div className="space-y-1.5 rounded-md border border-[var(--line)] p-2" data-testid="chatgpt-web-privacy-settings">
          <label className="flex items-start gap-2">
            <input type="checkbox" data-testid="review-before-send-toggle" checked={reviewGlobal} disabled={savingPrivacy}
              onChange={event=>void savePrivacy({reviewBeforeSend:event.target.checked},event.target.checked?'Đã bật xem lại trước khi gửi (mọi workspace, trừ nơi có cài đặt riêng).':'Đã tắt xem lại trước khi gửi.')}/>
            <span>
              <span className="block font-medium text-[var(--text)]">Xem lại trước khi gửi sang ChatGPT</span>
              <span className="block text-[10px] text-[var(--faint)]">Mỗi kết quả công cụ được giữ trên máy bạn cho tới khi bạn duyệt, che thêm hoặc giữ lại. Không có gì tự gửi; hết thời gian chờ thì nhiệm vụ dừng. Mặc định tắt.</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
            <span>Workspace hiện tại</span>
            <select data-testid="review-before-send-workspace" disabled={savingPrivacy||!currentWs} aria-label="Xem lại trước khi gửi cho workspace hiện tại"
              value={workspaceOverride?(workspaceOverride.review?'on':'off'):''}
              onChange={event=>void savePrivacy({workspacePath:currentWs,workspaceReview:event.target.value==='on'?true:event.target.value==='off'?false:null},'Đã lưu cài đặt cho workspace.')}
              className="rounded border border-[var(--line)] bg-[var(--bg)] px-1.5 py-1">
              <option value="">Theo cài đặt chung ({reviewGlobal?'bật':'tắt'})</option>
              <option value="on">Luôn xem lại</option>
              <option value="off">Không xem lại</option>
            </select>
          </label>
        </div>
        <div className="flex gap-2 items-center text-[11px] text-[var(--muted)]">
          <Link2 className="w-3.5 h-3.5"/>
          <span>{!companion?.paired?'Chưa ghép ChatMCP Hub Companion':
            companion.connected?'Companion đã ghép và đang kết nối':
              'Companion đã ghép; chờ mở tab ChatGPT với extension đang bật'}</span>
          {companion?.connected&&<CircleCheck className="w-3.5 h-3.5 text-emerald-500"/>}
        </div>
        <div className="flex flex-wrap gap-2" data-testid="browser-companion-install-links">
          <a className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 py-1.5 text-[11px] text-[var(--primary)] hover:bg-[var(--surface-hover)]"
            href="https://github.com/pddczpl/ChatMCP/releases/latest/download/ChatMCP-Browser-Companion.zip"
            target="_blank" rel="noopener noreferrer"
            aria-label="Tải Browser Companion ZIP từ GitHub Releases">
            <Download className="w-3.5 h-3.5"/> Tải Browser Companion (.zip)
          </a>
          <a className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 py-1.5 text-[11px] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
            href="https://github.com/pddczpl/ChatMCP/blob/main/CHATMCP-HUB/extension/INSTALL-EXTENSION.txt"
            target="_blank" rel="noopener noreferrer">Hướng dẫn cài / khôi phục</a>
        </div>
        <p className="text-[11px] text-[var(--faint)]">
          Giải nén file ZIP, sau đó mở <code>chrome://extensions</code> hoặc <code>edge://extensions</code> →
          Developer mode → Load unpacked, chọn <strong>thư mục đã giải nén có manifest.json</strong>.
          Nếu đã cài ứng dụng Windows, bạn cũng có thể chọn <code>CHATMCP-HUB/extension</code>
          trong thư mục ChatMCP đã cài. Trình duyệt yêu cầu bạn tự xác nhận quyền cài đặt;
          ChatMCP không cài extension âm thầm.
          Đăng nhập <a className="underline text-[var(--primary)]"
            href="https://chatgpt.com" target="_blank" rel="noreferrer">chatgpt.com</a> trên trình duyệt,
          mở extension ChatMCP Hub Companion và nhập mã ghép bên dưới.
        </p>
        <div className="flex items-center gap-2">
          <button type="button" onClick={()=>void issuePairCode()}
            disabled={pairingBusy||companion?.pairingAvailable===false}
            className="rounded-md border border-[var(--line)] px-2.5 py-1.5 hover:bg-[var(--surface-hover)] disabled:opacity-50">
            {pairingBusy?'Đang xử lý…':'Tạo mã ghép 5 phút'}
          </button>
          {companion?.paired&&<button type="button" onClick={()=>void disconnectCompanion()}
            disabled={pairingBusy} className="text-rose-400 hover:underline disabled:opacity-50">Ngắt ghép</button>}
        </div>
        {pairCode&&<div className="p-2 border border-sky-500/30 rounded-md bg-[var(--panel)] flex items-center gap-2">
          <code data-testid="chatgpt-pair-code" className="tracking-widest font-semibold text-lg text-[var(--text)]">
            {pairCode.code}
          </code>
          <button type="button" aria-label="Sao chép mã ghép"
            onClick={()=>void navigator.clipboard.writeText(pairCode.code)
              .then(()=>showToast('Đã sao chép mã ghép.','success'))
              .catch(()=>showToast('Hãy chọn và sao chép mã ghép thủ công.','info'))}
            className="p-1.5 rounded hover:bg-[var(--surface-hover)]"><Copy className="w-3.5 h-3.5"/></button>
          <span className="ml-auto text-[10px] text-[var(--faint)]">Hết hạn: {new Date(pairCode.expiresAt).toLocaleTimeString('vi-VN')}</span>
        </div>}
        {transport==='chatgpt-web'&&<p className="text-[11px] text-amber-500">
          ChatGPT Web dùng ô chat và model của tab trình duyệt thông qua Companion,
          không sử dụng cookie, API nội bộ hay ChatGPT API key. Một task web được thực hiện tại một thời điểm.
          Chọn workspace trước khi giao việc; không thể bảo đảm giao diện ChatGPT Web luôn tương thích.
        </p>}
      </section>

      {/* Permission Execution Modes */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          {t('agent_exec_mode')}
        </label>
        <div className="space-y-1.5">
          {[
            { id: 'readonly', label: t('perm_read_only'), desc: t('perm_read_only_desc') },
            { id: 'review', label: t('perm_review'), desc: t('perm_review_desc') },
            { id: 'autonomous', label: t('perm_auto'), desc: t('perm_auto_desc') },
            { id: 'full-access', label: t('perm_full_access'), desc: t('perm_full_access_desc') },
          ].map((m) => {
            const isSelected = m.id === 'full-access' ? isFullAccess : currentMode === m.id && !isFullAccess;
            return (
              <button
                key={m.id}
                onClick={() => handleModeChange(m.id)}
                className={`w-full p-2.5 rounded-lg border text-left transition-all ${
                  isSelected
                    ? m.id === 'full-access'
                      ? 'bg-rose-950/30 border-rose-500 text-rose-300 font-medium'
                      : 'bg-sky-500/15 border-sky-500 text-sky-300 font-medium'
                    : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)] hover:bg-[var(--surface-hover)]'
                }`}
              >
                <div className="text-xs font-semibold">{m.label}</div>
                <div className="text-[11px] text-[var(--faint)] mt-0.5">{m.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Theme */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          {t('theme_label')}
        </label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: 'dark', label: t('theme_dark'), icon: Moon },
            { id: 'light', label: t('theme_light'), icon: Sun },
            { id: 'system', label: t('theme_system'), icon: Globe },
          ].map((tItem) => {
            const Icon = tItem.icon;
            const isSelected = theme === tItem.id;
            return (
              <button
                key={tItem.id}
                onClick={() => setTheme(tItem.id as any)}
                className={`flex items-center justify-center gap-1.5 p-2 rounded-lg border text-xs transition-all ${
                  isSelected
                    ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold'
                    : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)] hover:bg-[var(--surface-hover)]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tItem.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Language */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-[var(--muted)] block">
          {t('lang_label')}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => {
              setLang('vi');
              showToast('Đã chuyển ngôn ngữ sang Tiếng Việt', 'info');
            }}
            className={`p-2 rounded-lg border text-xs text-center transition-all ${
              lang === 'vi'
                ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold'
                : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)] hover:bg-[var(--surface-hover)]'
            }`}
          >
            {t('lang_vi')}
          </button>
          <button
            onClick={() => {
              setLang('en');
              showToast('Switched language to English', 'info');
            }}
            className={`p-2 rounded-lg border text-xs text-center transition-all ${
              lang === 'en'
                ? 'bg-sky-500/15 border-sky-500/50 text-sky-300 font-semibold'
                : 'bg-[var(--surface)] border-[var(--line-subtle)] text-[var(--muted)] hover:bg-[var(--surface-hover)]'
            }`}
          >
            {t('lang_en')}
          </button>
        </div>
      </div>

      {/* Server & Port Info */}
      <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--line)] space-y-1.5 font-mono text-[11px]">
        <div className="flex items-center gap-2 text-sky-400 font-sans font-semibold text-xs">
          <Server className="w-3.5 h-3.5" />
          <span>{t('backend_status')}</span>
        </div>
        <div className="text-[var(--faint)]">
          Host: {typeof window !== 'undefined' ? window.location?.host || '127.0.0.1:3007' : '127.0.0.1:3007'} (Local-only daemon; external hosting is not supported)
        </div>
        <div className={hubError ? 'text-rose-400' : 'text-[var(--faint)]'} role="status">
          {hubError ? `Không kết nối được Hub: ${hubError.message}` : hub ? 'Đã nhận trạng thái từ Hub' : 'Đang kết nối Hub…'}
        </div>
      </div>

      {/* Export / Reset Actions */}
      <div className="pt-2 border-t border-[var(--line-subtle)] flex items-center gap-2">
        <Button
          variant="secondary"
          onClick={handleExportLogs}
          className="flex-1 gap-1.5 h-8 text-xs"
        >
          <Download className="w-3.5 h-3.5" />
          <span>{t('export_data')}</span>
        </Button>
      </div>
    </div>
  );
}
