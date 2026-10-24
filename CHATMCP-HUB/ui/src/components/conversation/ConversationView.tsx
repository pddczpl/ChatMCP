import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Cpu } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { PhaseRibbon } from '@/components/layout/PhaseRibbon';
import { MessageItem } from './MessageItem';
import { ToolActivityGroup } from './ToolActivityGroup';
import { WorkflowCard } from './WorkflowCard';
import { StateBanner } from './StateBanner';
import { Composer } from './Composer';
import { EmptyState } from './EmptyState';
import { ModelProfilePicker, RoleOverridesField } from './ModelProfilePicker';
import { ProofStrip } from './ProofStrip';
import { ProjectInstructionsNote } from './ProjectInstructionsNote';
import { ContextPolicyNotice } from './ContextPolicyNotice';
import { ObjectiveAcceptancePanel } from './ObjectiveAcceptancePanel';
import { CopyButton } from '@/components/ui/CopyButton';
import { ApprovalStack } from '@/components/approval/ApprovalStack';
import { OutboundReviewCard, type ReviewAction } from '@/components/approval/OutboundReviewCard';
import { ChatGptWebRiskNote } from '@/components/approval/ChatGptWebRiskNote';
import { isTaskActive, normalizeApproval, taskTimeline } from '@/lib/task-view';
import type { ChatAttachment } from '@/types';
import { parseRoleProfileOverrides } from '@/lib/model-profile-selection';
import { useTranslation } from '@/lib/i18n';

/** The reading column: wide enough for code, narrow enough to read. */
const column = 'mx-auto w-full max-w-[820px] px-5';

export function ConversationView() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { selectedTaskId, setSelectedTaskId, showToast, streamingToken, streamingTaskId, selectedBaseRef, selectedWorkspacePath,
    openSettings } = useAppStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const requestPending = useRef(false);
  const [sending, setSending] = useState(false);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [roleProfilesDraft, setRoleProfilesDraft] = useState('');
  const [showRoleProfiles, setShowRoleProfiles] = useState(false);
  const [approving, setApproving] = useState(false);
  const [cancellingWorkflow,setCancellingWorkflow] = useState<string | null>(null);
  const [recoveringChatUrl,setRecoveringChatUrl] = useState(false);
  const [decidingReview,setDecidingReview] = useState(false);

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
  // ChatGPT Web "review before send": a tool result held on this computer until the owner decides.
  const outboundReview = hub?.browser?.outboundReview || null;
  const decideReview = async (action: ReviewAction, redact: string[] = []) => {
    if (!outboundReview || decidingReview) return;
    setDecidingReview(true);
    try {
      const result = await api.decideOutboundReview(outboundReview.id, action, redact);
      if (action === 'redact_more' && result.matched === 0) showToast(t('agents_conv_review_missing'), 'info');
      else showToast(action === 'approve' ? t('agents_conv_review_approved') : action === 'withhold' ? t('agents_conv_review_withheld') : t('agents_conv_review_redacted'), 'success');
      refreshTask();
    } catch (error: any) {
      showToast(error.message || t('agents_conv_review_failed'), 'error');
      refreshTask();
    } finally { setDecidingReview(false); }
  };
  const desiredTransport=hub?.agent?.mode||'api';
  const willSwitch=Boolean(selectedTaskId&&task?.transport&&task.transport!==desiredTransport);
  // the sentence is cut where the new channel's name goes (in bold)
  const [switchBefore, switchAfter] = t('agents_conv_switch').split('{transport}');
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
        const apiMode=(hub?.agent?.mode||'api')==='api';
        const knownProfiles=hub?.ai?.profiles||[];
        if(apiMode && selectedProfileId && selectedProfileId!=='__global__' &&
           !knownProfiles.some(p=>p.id===selectedProfileId))
          throw new Error(t('agents_conv_profile_gone'));
        const roleProfiles=apiMode?parseRoleProfileOverrides(roleProfilesDraft,knownProfiles):{};
        const res = await api.startTask(text || t('agents_conv_files_prompt'), attachments, selectedBaseRef || null, dependsOn,
          selectedWorkspacePath || hub?.workspaces?.activePath || hub?.workspace?.path || null,
          apiMode ? selectedProfileId || null : null, roleProfiles);
        if (res?.task?.id) {
          queryClient.setQueryData(['task', res.task.id], res.task);
          setSelectedTaskId(res.task.id);
        }
      } else {
        const res = await api.continueTask(selectedTaskId, text || t('agents_conv_files_prompt'), attachments);
        if(res.task.id!==selectedTaskId){
          // A user-requested mode switch creates a linked task in the chosen
          // transport rather than silently using the old model runner.
          queryClient.setQueryData(['task',res.task.id],res.task);
          setSelectedTaskId(res.task.id);
          showToast(res.task.handoff?.note||t('agents_conv_handoff'),'info');
        }else queryClient.setQueryData(['task',selectedTaskId],res.task);
      }
      refreshTask();
      return true;
    } catch (err: any) {
      showToast(err.message || t('agents_conv_send_failed'), 'error');
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
      showToast(t('agents_conv_workflow_stop'),'info');
    }catch(err:any){
      showToast(err.message||t('agents_conv_workflow_stop_failed'),'error');
    }finally{setCancellingWorkflow(null);}
  };
  const recoverUrl=async()=>{
    if(!task||recoveringChatUrl)return;
    setRecoveringChatUrl(true);
    try{
      const result=await api.recoverBrowserChatUrl(task.id);
      showToast(result.alreadyBound?t('agents_conv_url_known'):
        t('agents_conv_url_asking'),
        'info');
      void queryClient.invalidateQueries({queryKey:['task',task.id]});
    }catch(err:any){
      showToast(err.message||t('agents_conv_url_failed'),'error');
    }finally{setRecoveringChatUrl(false);}
  };
  const handleStopTask = async () => {
    if (!task) return;
    try {
      const res = await api.cancelTask(task.id);
      queryClient.setQueryData(['task', task.id], res.task);
      showToast(t('agents_conv_stop_sent'), 'info');
      refreshTask();
    } catch (err: any) {
      showToast(err.message || t('agents_conv_stop_failed'), 'error');
    }
  };

  const handleModeChange = async (newMode: string) => {
    try {
      await api.configurePermissions({ mode: newMode, leaveFullAccess: true });
      showToast(t('agents_conv_mode_set', { mode: newMode }), 'info');
      queryClient.invalidateQueries({ queryKey: ['hubState'] });
    } catch (err: any) {
      showToast(err.message || t('agents_conv_mode_failed'), 'error');
    }
  };

  // The global gate also contains requests from Studio actions and other active conversations.
  const pendingApprovals = (permissions?.pending || []).map(normalizeApproval);
  const approvalHistory = (permissions?.recent || []).filter(item => item.taskId === selectedTaskId).map(normalizeApproval);

  const handleApprove = async (id: string) => {
    setApproving(true);
    try {
      await api.decidePermission(id, true);
      showToast(t('agents_conv_approved'), 'success');
    } catch (err: any) {
      showToast(err.message || t('agents_conv_approve_failed'), 'error');
    } finally {
      setApproving(false);
      refreshTask();
    }
  };

  const handleDeny = async (id: string, reason?: string) => {
    setApproving(true);
    try {
      await api.decidePermission(id, false);
      showToast(t('agents_conv_denied'), 'info');
    } catch (err: any) {
      showToast(err.message || t('agents_conv_deny_failed'), 'error');
    } finally {
      setApproving(false);
      refreshTask();
    }
  };

  const timeline = task ? taskTimeline(task) : [];
  const timelineGroups: Array<{kind:'message';value:any}|{kind:'tools';items:any[]}> = [];
  for (const item of timeline) {
    if (item.kind === 'tool') {
      const last = timelineGroups.at(-1);
      if (last?.kind === 'tools') last.items.push(item.value);
      else timelineGroups.push({kind:'tools',items:[item.value]});
    } else timelineGroups.push({kind:'message',value:item.value});
  }
  const continueTask = () => handleSendMessage(t('agents_conv_continue_prompt'));

  const chatGptWeb = task?.transport === 'chatgpt-web';
  const newTaskPicker = !selectedTaskId && desiredTransport === 'api';

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-bg">
      {/* Agent transport is distinct from permissions and model provider.
          The Browser Companion uses the user's logged-in ChatGPT web tab and
          never treats an account session/cookie as an API key. */}
      {(chatGptWeb && (!task.chatUrl || task.chatUrl.includes('local-chatgpt%3A')) && !isWorking) && (
        <div className={`${column} pt-3`}>
          <div className="space-y-2 rounded-xl border border-warning/40 bg-warning/[0.08] p-3 text-[13px] leading-5">
            <p>{t('agents_conv_url_missing')}</p>
            <button type="button" onClick={() => void recoverUrl()} disabled={recoveringChatUrl}
              className="h-8 rounded-lg border border-line bg-panel px-3 text-[13px] font-medium text-fg transition-colors hover:bg-hover disabled:opacity-40">
              {recoveringChatUrl ? t('agents_conv_url_busy') : t('agents_conv_url_recover')}
            </button>
          </div>
        </div>
      )}
      {willSwitch && (
        <div className={`${column} pt-3`}>
          <div role="status" data-testid="transport-switch-notice" className="rounded-xl border border-primary/30 bg-primary/[0.06] p-3 text-[13px] leading-5 text-muted">
            {switchBefore}<strong className="text-fg">{desiredTransport === 'chatgpt-web' ? 'ChatGPT Web Companion' : 'Model API'}</strong>{switchAfter}
          </div>
        </div>
      )}
      {hub?.agent?.mode === 'chatgpt-web' && !selectedTaskId && (
        <div className={`${column} pt-3`}>
          <div data-testid="chatgpt-web-mode-banner" role="status"
            className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px]">
            <Bot className="h-4 w-4 shrink-0 text-primary" />
            <span className="flex-1 text-muted" title={t('agents_conv_web_hint')}>
              ChatGPT Web (text-only) · {hub.browser?.connected ? t('status_companion_connected') :
                hub.browser?.paired ? t('agents_conv_web_paired') : t('agents_conv_web_unpaired')}
            </span>
            <button type="button" onClick={() => openSettings('agent-channel')} className="font-medium text-primary hover:underline">{t('agents_conv_setup')}</button>
          </div>
        </div>
      )}
      {(chatGptWeb || (hub?.agent?.mode === 'chatgpt-web' && !selectedTaskId)) && (
        <div className={`${column} pt-3`}>
          <ChatGptWebRiskNote compact testId={chatGptWeb ? 'chatgpt-web-task-risk-note' : 'chatgpt-web-mode-risk-note'} />
        </div>
      )}

      {task && <PhaseRibbon task={task} onCancel={handleStopTask} />}
      {/* A window the Hub does not know is not a quiet "estimated": it says so under the header and takes you to the field that fixes it. */}
      {task?.contextPolicy?.source === 'conservative_fallback' && (
        <div className={`${column} pt-3`}>
          <ContextPolicyNotice policy={task.contextPolicy} onFix={() => openSettings('model')} />
        </div>
      )}

      {/* Main conversation stream */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="conversation-scroll" onScroll={event => {
        const el = event.currentTarget;
        followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        setShowLatest(!followOutput.current);
      }}>
        {isLoading && selectedTaskId ? <p className={`${column} py-6 text-[13px] text-muted`}>{t('agents_conv_loading')}</p>
          : taskError ? <p role="alert" className={`${column} py-6 text-[13px] text-danger`}>{taskError.message}</p>
          : !selectedTaskId ? (
            <EmptyState hub={hub} sending={sending} onPick={prompt => { if (!sending) void handleSendMessage(prompt); }} />
          ) : (
            <div className={`${column} flex-1 pb-4 pt-2`}>
              {timelineGroups.map((item,index)=> item.kind==='message'
                ? <MessageItem key={`message:${item.value.id||index}`} message={item.value}/>
                : <ToolActivityGroup key={`tools:${index}`} items={item.items}/>)}
              {task && timeline.length === 0 && <p className="py-4 text-[13px] text-muted">{t('agents_conv_empty')}</p>}

              {/* The very same persisted workflow displayed in Background Tasks,
                  not another chat or a mock progress widget. It remains live even
                  after the parent agent has replied and released its run. */}
              {relatedWorkflows.map(workflow=><div key={workflow.id} className="my-3 max-w-2xl" data-testid="chat-workflow">
                  <WorkflowCard workflow={workflow} onOpenAgent={setSelectedTaskId}
                    onCancel={id=>void stopWorkflow(id)}
                    stopPending={cancellingWorkflow===workflow.id}/>
                </div>)}

              {/* Streaming token chunk */}
              {visibleToken && (
                <div className="group py-3" data-testid="streaming-message">
                  <div className="mb-1 flex items-center gap-2 text-[12px] text-muted">
                    <span className="font-semibold text-primary">DatGold</span>
                    <span className="pulse-dot">{t('agents_conv_replying')}</span>
                    <span className="ml-auto"><CopyButton text={visibleToken} label={t('agents_conv_copy_reply')} /></span>
                  </div>
                  <div className="conversation-copy whitespace-pre-wrap text-fg">{visibleToken}</div>
                </div>
              )}

              {/* What the Hub recorded, not what the model wrote. */}
              {task && !isWorking && <ProofStrip task={task} />}
              {/* What the Hub put into the instructions of this run (AGENTS.md, CLAUDE.md) and which skills the model read: a record, never a proof. */}
              {task && !isWorking && <ProjectInstructionsNote task={task} />}
              {/* Owner-reviewed evidence is distinct from an agent completion message. */}
              {task && !isWorking && task.transport!=='chatgpt-web' && task.goalPlan?.objectives?.length &&
                <ObjectiveAcceptancePanel task={task} onAccepted={refreshTask}/>}
              {task && <StateBanner
                status={task.status}
                message={task.error}
                onRetry={() => { void continueTask(); }}
                onResume={() => { void continueTask(); }}
                disabled={sending}
              />}
              {approvalHistory.length > 0 && (
                <details className="my-3 text-[13px]">
                  <summary className="cursor-pointer text-muted hover:text-fg">{t('agents_conv_approvals', { n: approvalHistory.length })}</summary>
                  <ApprovalStack approvals={approvalHistory} onApprove={handleApprove} onDeny={handleDeny} />
                </details>
              )}
            </div>
          )}
        <div className={column}>
          {outboundReview && <OutboundReviewCard review={outboundReview} onDecide={decideReview} busy={decidingReview} />}
          <ApprovalStack approvals={pendingApprovals} onApprove={handleApprove} onDeny={handleDeny} busy={approving} />
        </div>
        <div ref={messagesEndRef} />
      </div>

      {showLatest && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[112px] z-10 flex justify-center">
          <button type="button" className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-panel px-3 text-[13px] font-medium text-primary shadow-[var(--shadow-pop)] transition-colors hover:bg-hover" onClick={() => {
            followOutput.current = true;
            setShowLatest(false);
            messagesEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
          }}>{t('agents_conv_latest')}</button>
        </div>
      )}

      {/* Bottom composer. A new conversation also chooses its model profile; an existing one keeps the saved revision. */}
      <div className="shrink-0 pb-4 pt-1">
        <div className={`${column} space-y-2`}>
          {newTaskPicker && showRoleProfiles && <RoleOverridesField value={roleProfilesDraft} onChange={setRoleProfilesDraft} />}
          <Composer
            key={selectedTaskId || 'new-conversation'}
            onSendMessage={handleSendMessage}
            onStop={handleStopTask}
            isWorking={isWorking}
            disabled={sending || (!!selectedTaskId && (isLoading || !!taskError))}
            currentMode={mode}
            onModeChange={handleModeChange}
            extraTools={<>
              {newTaskPicker && <ModelProfilePicker hub={hub} value={selectedProfileId} onChange={setSelectedProfileId}
                rolesOpen={showRoleProfiles} onToggleRoles={() => setShowRoleProfiles(x => !x)} />}
              {!!selectedTaskId && !!task?.effectiveProfile && (
                <span data-testid="active-model-profile" className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-muted"
                  title={t('agents_conv_profile_title', { name: task.effectiveProfile.name, model: task.effectiveProfile.model, revision: String(task.effectiveProfile.revision?.slice(0, 8)) })}>
                  <Cpu className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{task.effectiveProfile.name} · {task.effectiveProfile.model}</span>
                </span>
              )}
            </>}
            dependencyOptions={!selectedTaskId ? (hub?.tasks || []).filter(x=>x.id&&x.status!=='failed'&&x.status!=='cancelled').slice(0,15)
              .map(x=>({id:x.id,label:x.task || x.prompt || x.id,state:x.state || x.status})) : []}
            selectedDependsOn={dependsOn}
            onDependsOnChange={setDependsOn}
          />
        </div>
      </div>
    </div>
  );
}
