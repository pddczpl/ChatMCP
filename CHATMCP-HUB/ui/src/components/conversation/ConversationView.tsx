import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { PhaseRibbon } from '@/components/layout/PhaseRibbon';
import { MessageItem } from './MessageItem';
import { ToolReceipt } from './ToolReceipt';
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
  const { selectedTaskId, setSelectedTaskId, showToast, streamingToken, streamingTaskId, selectedBaseRef } = useAppStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const requestPending = useRef(false);
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);

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
  const isWorking = isTaskActive(task);
  const permissions = hub?.studio?.permissions;
  const mode = permissions?.executionPolicy === 'full-access' ? 'full-access' : permissions?.mode || 'review';
  const visibleToken = isWorking && streamingTaskId === selectedTaskId ? streamingToken : '';
  const refreshTask = () => {
    void queryClient.invalidateQueries({ queryKey: ['hubState'] });
    void queryClient.invalidateQueries({ queryKey: ['task', selectedTaskId] });
  };

  useEffect(() => {
    followOutput.current = true;
    setShowLatest(false);
  }, [selectedTaskId]);

  // Reading/copying earlier output must not be interrupted by streaming or polling.
  useEffect(() => {
    if (followOutput.current) messagesEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [task?.messages, task?.toolCalls, visibleToken]);

  // Send message handler
  const handleSendMessage = async (text: string, attachments: ChatAttachment[] = []) => {
    if ((!text.trim() && !attachments.length) || requestPending.current) return false;
    requestPending.current = true;
    setSending(true);
    try {
      if (!selectedTaskId) {
        const res = await api.startTask(text || 'Hãy phân tích tệp/ảnh đính kèm.', attachments, selectedBaseRef || null);
        if (res?.task?.id) {
          queryClient.setQueryData(['task', res.task.id], res.task);
          setSelectedTaskId(res.task.id);
        }
      } else {
        const res = await api.continueTask(selectedTaskId, text || 'Hãy phân tích tệp/ảnh đính kèm.', attachments);
        queryClient.setQueryData(['task', selectedTaskId], res.task);
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
  const continueTask = () => handleSendMessage('Tiếp tục tác vụ trong cùng cuộc hội thoại. Kiểm tra trạng thái hiện tại trước khi thao tác; không tự chạy lại thao tác có kết quả chưa rõ.');

  return (
    <div className="h-full flex flex-col bg-[var(--bg)] min-w-0 overflow-hidden relative">
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
            {timeline.map((item, index) => item.kind === 'message'
              ? <MessageItem key={`message:${item.value.id || index}`} message={item.value} />
              : <ToolReceipt key={`receipt:${item.value.id || index}`} tool={item.value} />)}
            {task && timeline.length === 0 && <p className="p-4 text-xs text-[var(--muted)]">Chưa có nội dung hội thoại được lưu.</p>}

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

      {/* Bottom Composer */}
      <Composer
        key={selectedTaskId || 'new-conversation'}
        onSendMessage={handleSendMessage}
        onStop={handleStopTask}
        isWorking={isWorking}
        disabled={sending || (!!selectedTaskId && (isLoading || !!taskError))}
        currentMode={mode}
        onModeChange={handleModeChange}
      />
    </div>
  );
}
