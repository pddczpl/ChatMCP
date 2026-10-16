import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { PhaseRibbon } from '@/components/layout/PhaseRibbon';
import { MessageItem } from './MessageItem';
import { ToolActivityGroup } from './ToolActivityGroup';
import { WorkflowCard } from './WorkflowCard';
import { StateBanner } from './StateBanner';
import { Composer } from './Composer';
import { CopyButton } from '@/components/ui/CopyButton';
import { ApprovalStack, PendingApproval } from '@/components/approval/ApprovalStack';
import { Card } from '@/components/ui/Card';
import { useTranslation } from '@/lib/i18n';
import { 
  Sparkles, 
  Code2, 
  CheckCircle2, 
  ShieldAlert, 
  Zap, 
  Bot, 
  Terminal, 
  FolderSearch 
} from 'lucide-react';
import { isTaskActive, normalizeApproval, taskTimeline } from '@/lib/task-view';
import type { ChatAttachment } from '@/types';

export function ConversationView() {
  const queryClient = useQueryClient();
  const { selectedTaskId, setSelectedTaskId, showToast, streamingToken, streamingTaskId, selectedBaseRef, selectedWorkspacePath,
    setActiveTab,setInspectorOpen } = useAppStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const requestPending = useRef(false);
  const [sending, setSending] = useState(false);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [approving, setApproving] = useState(false);
  const [cancellingWorkflow,setCancellingWorkflow] = useState<string | null>(null);
  const [recoveringChatUrl,setRecoveringChatUrl] = useState(false);

  // Fetch full Hub state
  const { data: hub } = useQuery({
    queryKey: ['hubState'],
    queryFn: api.getState,
    refetchInterval: 2000,
  });

  // State contains summaries; the selected conversation needs its full persisted record.
  const { data: task, isLoading, error: taskError } = useQuery({
    queryKey: ['task', selectedTaskId],
    queryFn: () => api.getTask(selectedTaskId),
    enabled: !!selectedTaskId,
    refetchInterval: selectedTaskId ? 2000 : false,
  });
  const {data:background}=useQuery({
    queryKey:['backgroundRuns'],queryFn:api.getBackgroundRuns,
    enabled:!!selectedTaskId,refetchInterval:selectedTaskId?2000:false,
  });
  const relatedWorkflows=(background?.workflows||[]).filter(w=>w.conversationId===selectedTaskId);
  const isWorking = isTaskActive(task);
  const desiredTransport=hub?.agent?.mode||'api';
  const willSwitch=Boolean(selectedTaskId&&task?.transport&&task.transport!==desiredTransport);
  const permissions = hub?.studio?.permissions;
  const mode = permissions?.executionPolicy === 'full-access' ? 'full-access' : permissions?.mode || 'review';
  const visibleToken = isWorking && streamingTaskId === selectedTaskId ? streamingToken : '';
  const refreshTask = () => {
    void queryClient.invalidateQueries({ queryKey: ['hubState'] });
    void queryClient.invalidateQueries({ queryKey: ['task', selectedTaskId] });
  };

  useEffect(() => {
    if (!selectedTaskId) setDependsOn([]);
    followOutput.current = true;
    setShowLatest(false);
  }, [selectedTaskId]);

  // Reading/copying earlier output must not be interrupted by streaming or polling.
  useEffect(() => {
    if (followOutput.current) messagesEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [task?.messages, task?.toolCalls, visibleToken, background?.workflows]);

  // Send message handler
  const handleSendMessage = async (text: string, attachments: ChatAttachment[] = []) => {
    if ((!text.trim() && !attachments.length) || requestPending.current) return false;
    requestPending.current = true;
    setSending(true);
    try {
      if (!selectedTaskId) {
        const res = await api.startTask(text || 'Hãy phân tích tệp/ảnh đính kèm.', attachments, selectedBaseRef || null, dependsOn,
          selectedWorkspacePath || hub?.workspaces?.activePath || hub?.workspace?.path || null);
        if (res?.task?.id) {
          queryClient.setQueryData(['task', res.task.id], res.task);
          setSelectedTaskId(res.task.id);
        }
      } else {
        const res = await api.continueTask(selectedTaskId, text || 'Hãy phân tích tệp/ảnh đính kèm.', attachments);
        if(res.task.id!==selectedTaskId){
          // A user-requested mode switch creates a linked task in the chosen
          // transport rather than silently using the old model runner.
          queryClient.setQueryData(['task',res.task.id],res.task);
          setSelectedTaskId(res.task.id);
          showToast(res.task.handoff?.note||'Đã chuyển sang kênh agent đã chọn.','info');
        }else queryClient.setQueryData(['task',selectedTaskId],res.task);
      }
      refreshTask();
      return true;
    } catch (err: any) {
      showToast(err.message || 'Không thể gửi tin nhắn', 'error');
      return false;
    } finally {
      requestPending.current = false;
      setSending(false);
    }
  };

  const stopWorkflow=async(id:string)=>{
    if(cancellingWorkflow)return;
    setCancellingWorkflow(id);
    try{
      await api.cancelWorkflow(id);
      await queryClient.invalidateQueries({queryKey:['backgroundRuns']});
      showToast('Đã gửi yêu cầu dừng các subagent trong workflow.','info');
    }catch(err:any){
      showToast(err.message||'Không thể dừng workflow','error');
    }finally{setCancellingWorkflow(null);}
  };
  const recoverUrl=async()=>{
    if(!task||recoveringChatUrl)return;
    setRecoveringChatUrl(true);
    try{
      const result=await api.recoverBrowserChatUrl(task.id);
      showToast(result.alreadyBound?'URL chính thức đã có.':
        'Đang yêu cầu Companion kiểm tra tab ChatGPT cũ. Giữ tab đó mở, chờ kết quả rồi nhấn Tiếp tục.',
        'info');
      void queryClient.invalidateQueries({queryKey:['task',task.id]});
    }catch(err:any){
      showToast(err.message||'Không thể khôi phục URL chat.','error');
    }finally{setRecoveringChatUrl(false);}
  };
  const handleStopTask = async () => {
    if (!task) return;
    try {
      const res = await api.cancelTask(task.id);
      queryClient.setQueryData(['task', task.id], res.task);
      showToast('Đã gửi yêu cầu dừng tác vụ', 'info');
      refreshTask();
    } catch (err: any) {
      showToast(err.message || 'Không thể dừng tác vụ', 'error');
    }
  };

  const handleModeChange = async (newMode: string) => {
    try {
      await api.configurePermissions({ mode: newMode, ...(mode === 'full-access' ? { executionPolicy: 'host-review' } : {}) });
      showToast(`Đã chuyển sang chế độ ${newMode}`, 'info');
      queryClient.invalidateQueries({ queryKey: ['hubState'] });
    } catch (err: any) {
      showToast(err.message || 'Không thể đổi chế độ quyền', 'error');
    }
  };

  // The global gate also contains requests from Studio actions and other active conversations.
  const pendingApprovals = (permissions?.pending || []).map(normalizeApproval);
  const approvalHistory = (permissions?.recent || []).filter(item => item.taskId === selectedTaskId).map(normalizeApproval);

  const handleApprove = async (id: string) => {
    setApproving(true);
    try {
      await api.decidePermission(id, true);
      showToast('Đã phê duyệt hành động', 'success');
    } catch (err: any) {
      showToast(err.message || 'Lỗi phê duyệt', 'error');
    } finally {
      setApproving(false);
      refreshTask();
    }
  };

  const handleDeny = async (id: string, reason?: string) => {
    setApproving(true);
    try {
      await api.decidePermission(id, false);
      showToast('Đã từ chối hành động', 'info');
    } catch (err: any) {
      showToast(err.message || 'Lỗi từ chối', 'error');
    } finally {
      setApproving(false);
      refreshTask();
    }
  };

  const { t } = useTranslation();

  // Starter Prompts for Empty State
  const starters = [
    {
      title: t('starter_1_title'),
      desc: t('starter_1_desc'),
      prompt: 'Hãy quét cấu trúc thư mục hiện tại của workspace, phân tích kiến trúc dự án và chỉ ra các module chính.',
      icon: FolderSearch,
      color: 'text-sky-400',
    },
    {
      title: t('starter_2_title'),
      desc: t('starter_2_desc'),
      prompt: 'Hãy tìm các file logic hoặc module quan trọng chưa có test và viết unit test bao phủ đầy đủ.',
      icon: CheckCircle2,
      color: 'text-emerald-400',
    },
    {
      title: t('starter_3_title'),
      desc: t('starter_3_desc'),
      prompt: 'Hãy rà soát toàn bộ cấu hình CSP, các endpoint API và sanitize input để phát hiện rủi ro bảo mật.',
      icon: ShieldAlert,
      color: 'text-rose-400',
    },
    {
      title: t('starter_4_title'),
      desc: t('starter_4_desc'),
      prompt: 'Hãy phân tích các file code có kích thước lớn hoặc nợ kỹ thuật để thực hiện refactor tối ưu.',
      icon: Zap,
      color: 'text-amber-400',
    },
  ];

  const timeline = task ? taskTimeline(task) : [];
  const timelineGroups: Array<{kind:'message';value:any}|{kind:'tools';items:any[]}> = [];
  for (const item of timeline) {
    if (item.kind === 'tool') {
      const last = timelineGroups.at(-1);
      if (last?.kind === 'tools') last.items.push(item.value);
      else timelineGroups.push({kind:'tools',items:[item.value]});
    } else timelineGroups.push({kind:'message',value:item.value});
  }
  const continueTask = () => handleSendMessage('Tiếp tục tác vụ trong cùng cuộc hội thoại. Kiểm tra trạng thái hiện tại trước khi thao tác; không tự chạy lại thao tác có kết quả chưa rõ.');

  return (
    <div className="h-full flex flex-col bg-[var(--bg)] min-w-0 overflow-hidden relative">
      {task?.transport==='chatgpt-web'&&
        (!task.chatUrl||task.chatUrl.includes('local-chatgpt%3A'))&&
        !isWorking&&
        <div className="mx-4 my-2 p-3 rounded-md border border-amber-500/30 text-xs space-y-2">
          <p>Chưa có URL ChatGPT chính thức cho task này. Mở tab ChatGPT đã gửi nhiệm vụ, rồi yêu cầu Extension xác nhận URL. ChatMCP sẽ không tự tạo chat mới hoặc gửi lại prompt.</p>
          <button type="button" onClick={()=>void recoverUrl()} disabled={recoveringChatUrl}
            className="px-3 py-1 rounded border border-[var(--line)] text-[var(--text)] disabled:opacity-40">
            {recoveringChatUrl?'Đang yêu cầu…':'Khôi phục URL ChatGPT từ tab đã gửi'}
          </button>
        </div>}
      {/* Agent transport is distinct from permissions and model provider.
          The Browser Companion uses the user's logged-in ChatGPT web tab and
          never treats an account session/cookie as an API key. */}
      {willSwitch&&<div role="status" data-testid="transport-switch-notice"
        className="mx-4 my-2 p-2 rounded-md border border-sky-500/30 text-xs text-[var(--muted)]">
        Lượt tiếp theo sử dụng <strong>{desiredTransport==='chatgpt-web'?'ChatGPT Web Companion':'Model API'}</strong>.
        ChatMCP giữ liên kết với các lượt trước và chuyển tóm tắt ngữ cảnh, nhưng không giả định hai model dùng chung lịch sử.
        Các thao tác ghi file chưa xác minh sẽ không được tự động phát lại.
      </div>}
      {hub?.agent?.mode==='chatgpt-web'&&!selectedTaskId&&
        <div data-testid="chatgpt-web-mode-banner" role="status"
          className="px-4 py-2 bg-[var(--surface)] border-b border-[var(--line)] flex items-center gap-2 text-xs">
          <Bot className="w-4 h-4 text-sky-500 flex-shrink-0"/>
          <span className="flex-1 text-[var(--muted)]" title="Kênh Web Companion hiện chỉ gửi văn bản qua tab ChatGPT; dùng Model API để gửi ảnh/tệp đính kèm.">
            ChatGPT Web (text-only) · {hub.browser?.connected?'Companion đã kết nối':
              hub.browser?.paired?'Companion đã ghép; mở tab ChatGPT':'Cần ghép ChatMCP Hub Companion trước khi gửi task'}
          </span>
          <button type="button" onClick={()=>{setInspectorOpen(true);setActiveTab('settings');}}
            className="underline text-[var(--primary)]">Thiết lập</button>
        </div>}
      {/* Top Phase Ribbon */}
      {task && <PhaseRibbon task={task} onCancel={handleStopTask} />}
      {task?.usage && (
        <div className="px-4 py-1.5 text-[11px] text-[var(--muted)] border-b border-[var(--line-subtle)] flex flex-wrap items-center gap-x-4 gap-y-1"
          data-testid="agent-request-budget" role="status">
          <span>Model HTTP requests: {task.usage.httpRequests ?? 0}</span>
          <span>Input: {(task.usage.inputTokens ?? 0).toLocaleString()} tokens</span>
          <span>Output: {(task.usage.outputTokens ?? 0).toLocaleString()} tokens</span>
          {(task.usage.cachedInputTokens ?? 0)>0&&
            <span>Cache hit: {(task.usage.cachedInputTokens ?? 0).toLocaleString()} tokens</span>}
          {(task.usage.cacheWriteTokens ?? 0)>0&&
            <span>Cache write: {(task.usage.cacheWriteTokens ?? 0).toLocaleString()} tokens</span>}
          {(task.usage.reasoningTokens ?? 0)>0&&
            <span>Reasoning: {(task.usage.reasoningTokens ?? 0).toLocaleString()} tokens</span>}
          {task.verificationOutcome?.ready === false &&
            <span className="text-amber-400" title={task.verificationOutcome.missing.join('; ')}>
              Chưa xác minh đầy đủ ({task.verificationOutcome.missing.length})
            </span>}
        </div>
      )}

      {/* Main Conversation Stream */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col" data-testid="conversation-scroll" onScroll={event => {
        const el = event.currentTarget;
        followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        setShowLatest(!followOutput.current);
      }}>
        {isLoading && selectedTaskId ? <p className="p-4 text-xs text-[var(--muted)]">Đang tải hội thoại…</p> : taskError ? <p role="alert" className="p-4 text-xs text-rose-400">{taskError.message}</p> : !selectedTaskId ? (
          /* Empty / Welcome State with smooth cards */
          <div className="flex-1 flex flex-col items-center justify-center p-6 max-w-3xl mx-auto w-full select-none">
            <div className="w-12 h-12 rounded-2xl bg-[var(--primary-bg)] text-[var(--primary)] flex items-center justify-center mb-4">
              <Bot className="w-6 h-6 stroke-[2.2]" />
            </div>

            <h1 className="text-xl font-bold tracking-tight text-[var(--text)] text-center">
              {t('welcome_title')}
            </h1>
            <p className="text-xs text-[var(--muted)] text-center max-w-md mt-1 mb-6">
              {t('welcome_desc')}
            </p>

            {/* Suggestion Cards Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
              {starters.map((item, idx) => {
                const Icon = item.icon;
                return (
                  <Card
                    key={idx}
                    onClick={() => { if (!sending) void handleSendMessage(item.prompt); }}
                    className="p-3.5 cursor-pointer bg-[var(--panel)] hover:bg-[var(--surface-hover)] border-[var(--line)] hover:border-sky-500/50 group transition-all duration-150"
                  >
                    <div className="flex items-start gap-3">
                      <div className="p-2 rounded-lg bg-[var(--surface)] border border-[var(--line)] group-hover:border-sky-500/30 transition-colors">
                        <Icon className={`w-4 h-4 ${item.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-xs text-[var(--text)] group-hover:text-sky-300 transition-colors">
                          {item.title}
                        </div>
                        <p className="text-[11px] text-[var(--faint)] mt-0.5 line-clamp-2">
                          {item.desc}
                        </p>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        ) : (
          /* Message List */
          <div className="flex-1 py-2">
            {timelineGroups.map((item,index)=> item.kind==='message'
              ? <MessageItem key={`message:${item.value.id||index}`} message={item.value}/>
              : <ToolActivityGroup key={`tools:${index}`} items={item.items}/>)}
            {task && timeline.length === 0 && <p className="p-4 text-xs text-[var(--muted)]">Chưa có nội dung hội thoại được lưu.</p>}

            {/* The very same persisted workflow displayed in Background Tasks,
                not another chat or a mock progress widget. It remains live even
                after the parent agent has replied and released its run. */}
            {relatedWorkflows.map(workflow=><div key={workflow.id}
                className="mx-4 my-3 max-w-2xl" data-testid="chat-workflow">
              <WorkflowCard workflow={workflow} onOpenAgent={setSelectedTaskId}
                onCancel={id=>void stopWorkflow(id)}
                stopPending={cancellingWorkflow===workflow.id}/>
            </div>)}

            {/* Streaming Token Chunk */}
            {visibleToken && (
              <div className="py-4 px-4 flex gap-3 text-sm border-b border-[var(--line-subtle)]" data-testid="streaming-message">
                <div className="w-6 h-6 rounded-full bg-teal-500/20 text-teal-400 border border-teal-500/30 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1 text-xs text-[var(--muted)]">
                    <span>Đang trả lời…</span>
                    <CopyButton text={visibleToken} label="Sao chép nội dung đang trả lời" />
                  </div>
                  <div className="conversation-copy text-[var(--text)] whitespace-pre-wrap">{visibleToken}</div>
                </div>
              </div>
            )}

            {/* State Banner */}
            {task && <StateBanner
              status={task.status}
              message={task.error}
              onRetry={() => { void continueTask(); }}
              onResume={() => { void continueTask(); }}
              disabled={sending}
            />}
            {approvalHistory.length > 0 && <details className="mx-4 my-3 text-xs"><summary>Lịch sử phê duyệt ({approvalHistory.length})</summary><ApprovalStack approvals={approvalHistory} onApprove={handleApprove} onDeny={handleDeny} /></details>}

          </div>
        )}
        <ApprovalStack approvals={pendingApprovals} onApprove={handleApprove} onDeny={handleDeny} busy={approving} />
        <div ref={messagesEndRef} />
      </div>
      {showLatest && <div className="flex justify-center py-1 bg-[var(--panel)]"><button type="button" className="px-3 py-1 rounded-full text-xs text-[var(--primary)] border border-[var(--line)]" onClick={() => {
        followOutput.current = true;
        setShowLatest(false);
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
      }}>Về nội dung mới nhất ↓</button></div>}

      {/* ChatGPT Web transport only accepts browser-authenticated TEXT packets.
          It cannot send local image attachments through this protocol. */}
      {/* Bottom Composer */}
      <Composer
        key={selectedTaskId || 'new-conversation'}
        onSendMessage={handleSendMessage}
        onStop={handleStopTask}
        isWorking={isWorking}
        disabled={sending || (!!selectedTaskId && (isLoading || !!taskError))}
        currentMode={mode}
        onModeChange={handleModeChange}
        dependencyOptions={!selectedTaskId ? (hub?.tasks || []).filter(x=>x.id&&x.status!=='failed'&&x.status!=='cancelled').slice(0,15)
          .map(x=>({id:x.id,label:x.task || x.prompt || x.id,state:x.state || x.status})) : []}
        selectedDependsOn={dependsOn}
        onDependsOnChange={setDependsOn}
      />
    </div>
  );
}
