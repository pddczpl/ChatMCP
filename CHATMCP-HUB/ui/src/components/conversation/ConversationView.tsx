import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { PhaseRibbon } from '@/components/layout/PhaseRibbon';
import { MessageItem } from './MessageItem';
import { ToolReceipt } from './ToolReceipt';
import { StateBanner } from './StateBanner';
import { Composer } from './Composer';
import { ApprovalStack, PendingApproval } from '@/components/approval/ApprovalStack';
import { Card } from '@/components/ui/Card';
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
import { Task, Message, ToolCall } from '@/types';

export function ConversationView() {
  const queryClient = useQueryClient();
  const { selectedTaskId, setSelectedTaskId, showToast, streamingToken } = useAppStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch full Hub state
  const { data: hub } = useQuery({
    queryKey: ['hubState'],
    queryFn: api.getState,
    refetchInterval: 2000,
  });

  // Current task
  const task: Task | undefined = hub?.tasks?.find((t) => t.id === selectedTaskId) || hub?.tasks?.[0];
  const isWorking = task?.status === 'working' || task?.status === 'in_progress';
  const mode = hub?.studio?.permissions?.mode || 'review';

  // Auto-scroll on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [task?.messages, streamingToken]);

  // Send message handler
  const handleSendMessage = async (text: string) => {
    try {
      if (!selectedTaskId) {
        // Create new task with this initial prompt
        const res = await api.createTask({ task: text });
        if (res?.task?.id) {
          setSelectedTaskId(res.task.id);
        }
      } else {
        await api.sendMessage(selectedTaskId, text);
      }
      queryClient.invalidateQueries({ queryKey: ['hubState'] });
    } catch (err: any) {
      showToast(err.message || 'Không thể gửi tin nhắn', 'error');
    }
  };

  const handleStopTask = async () => {
    if (!task) return;
    try {
      await api.cancelTask(task.id);
      showToast('Đã dừng tác vụ', 'info');
      queryClient.invalidateQueries({ queryKey: ['hubState'] });
    } catch (err: any) {
      showToast(err.message || 'Không thể dừng tác vụ', 'error');
    }
  };

  const handleModeChange = async (newMode: string) => {
    try {
      await api.setPermissions({ mode: newMode as any, executionPolicy: 'review' });
      showToast(`Đã chuyển sang chế độ ${newMode}`, 'info');
      queryClient.invalidateQueries({ queryKey: ['hubState'] });
    } catch (err: any) {
      showToast(err.message || 'Không thể đổi chế độ quyền', 'error');
    }
  };

  // Approvals mapped from task approvals
  const pendingApprovals: PendingApproval[] = (task?.pendingApprovals || []).map((a: any) => ({
    id: a.id || a.approvalId,
    tool: a.tool || a.toolName || 'tool',
    description: a.description || a.summary || 'Yêu cầu hành động',
    risk: a.risk || 'medium',
    targetPath: a.args?.path || a.args?.TargetFile,
    oldContent: a.oldContent,
    newContent: a.newContent,
    command: a.args?.command || a.args?.cmd,
  }));

  const handleApprove = async (id: string) => {
    try {
      await api.approveAction(id);
      showToast('Đã phê duyệt hành động', 'success');
      queryClient.invalidateQueries({ queryKey: ['hubState'] });
    } catch (err: any) {
      showToast(err.message || 'Lỗi phê duyệt', 'error');
    }
  };

  const handleDeny = async (id: string, reason?: string) => {
    try {
      await api.denyAction(id, reason);
      showToast('Đã từ chối hành động', 'info');
      queryClient.invalidateQueries({ queryKey: ['hubState'] });
    } catch (err: any) {
      showToast(err.message || 'Lỗi từ chối', 'error');
    }
  };

  // Starter Prompts for Empty State
  const starters = [
    {
      title: 'Phân tích kiến trúc codebase',
      desc: 'Quét toàn bộ cấu trúc dự án và lập tài liệu tổng quan.',
      prompt: 'Hãy quét cấu trúc thư mục hiện tại của workspace, phân tích kiến trúc dự án và chỉ ra các module chính.',
      icon: FolderSearch,
      color: 'text-sky-400',
    },
    {
      title: 'Tạo unit test cho các module',
      desc: 'Viết test tự động và chạy xác minh ngay trong workspace.',
      prompt: 'Hãy tìm các file logic hoặc module quan trọng chưa có test và viết unit test bao phủ đầy đủ.',
      icon: CheckCircle2,
      color: 'text-emerald-400',
    },
    {
      title: 'Rà soát bảo mật & CSP',
      desc: 'Kiểm tra Content Security Policy, sanitize dữ liệu và an toàn runtime.',
      prompt: 'Hãy rà soát toàn bộ cấu hình CSP, các endpoint API và sanitize input để phát hiện rủi ro bảo mật.',
      icon: ShieldAlert,
      color: 'text-rose-400',
    },
    {
      title: 'Tối ưu hóa & Refactor',
      desc: 'Cải thiện hiệu năng, giảm duplicate code và làm sạch logic.',
      prompt: 'Hãy phân tích các file code có kích thước lớn hoặc nợ kỹ thuật để thực hiện refactor tối ưu.',
      icon: Zap,
      color: 'text-amber-400',
    },
  ];

  const hasMessages = task && task.messages && task.messages.length > 0;

  return (
    <div className="h-full flex flex-col bg-[var(--bg)] min-w-0 overflow-hidden relative">
      {/* Top Phase Ribbon */}
      {task && <PhaseRibbon task={task} onCancel={handleStopTask} />}

      {/* Main Conversation Stream */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
        {!hasMessages ? (
          /* Empty / Welcome State with 3D tilt cards */
          <div className="flex-1 flex flex-col items-center justify-center p-6 max-w-3xl mx-auto w-full select-none perspective-container">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-sky-500 to-teal-400 flex items-center justify-center text-slate-950 shadow-lg shadow-sky-500/20 mb-4 floating-step">
              <Bot className="w-6 h-6 stroke-[2.2]" />
            </div>

            <h1 className="text-xl font-bold tracking-tight text-[var(--text)] text-center">
              ChatMCP Studio
            </h1>
            <p className="text-xs text-[var(--muted)] text-center max-w-md mt-1 mb-6">
              AI Coding Agent chuyên nghiệp chạy trực tiếp trên workspace của bạn. Chọn gợi ý bên dưới hoặc nhập yêu cầu trực tiếp.
            </p>

            {/* 3D Suggestion Cards Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full transform-style-3d">
              {starters.map((item, idx) => {
                const Icon = item.icon;
                return (
                  <Card
                    key={idx}
                    tilt3d
                    onClick={() => handleSendMessage(item.prompt)}
                    className="p-3.5 cursor-pointer bg-[var(--panel)] hover:bg-[var(--surface-hover)] border-[var(--line)] hover:border-sky-500/50 group"
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
            {task.messages.map((m: Message, idx: number) => (
              <MessageItem key={m.id || idx} message={m} />
            ))}

            {/* Tool Receipts */}
            {task.toolCalls && task.toolCalls.length > 0 && (
              <div className="my-2">
                {task.toolCalls.map((tool: ToolCall, idx: number) => (
                  <ToolReceipt key={tool.id || idx} tool={tool} />
                ))}
              </div>
            )}

            {/* Streaming Token Chunk */}
            {streamingToken && (
              <div className="py-3.5 px-4 flex gap-3 text-xs border-b border-[var(--line-subtle)] bg-[var(--surface)]/20 animate-pulse">
                <div className="w-6 h-6 rounded-full bg-teal-500/20 text-teal-400 border border-teal-500/30 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 min-w-0 font-sans text-[13px] text-[var(--text)] whitespace-pre-wrap">
                  {streamingToken}
                </div>
              </div>
            )}

            {/* Pending Approvals in Stream */}
            {pendingApprovals.length > 0 && (
              <ApprovalStack
                approvals={pendingApprovals}
                onApprove={handleApprove}
                onDeny={handleDeny}
              />
            )}

            {/* State Banner */}
            <StateBanner
              status={task.status}
              message={task.error || task.stage}
              onRetry={() => handleSendMessage('Tiếp tục hoàn thành tác vụ')}
              onCancel={handleStopTask}
            />

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Bottom Composer */}
      <Composer
        onSendMessage={handleSendMessage}
        onStop={handleStopTask}
        isWorking={isWorking}
        currentMode={mode}
        onModeChange={handleModeChange}
      />
    </div>
  );
}
