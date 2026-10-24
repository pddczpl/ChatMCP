import { useState } from 'react';
import type { BackgroundWorkflow, WorkflowPhase } from '@/types';
import { useTranslation } from '@/lib/i18n';
import { hasHidden } from '@/lib/hidden-chars';
import { HiddenNote, HiddenText } from '@/components/inspector/HiddenText';
import {
  Workflow, ChevronDown, ChevronRight, Loader2, CircleCheck,
  CircleAlert, CirclePause, GitBranch, Square, Bot, ListChecks,
} from 'lucide-react';

const running=(state:string)=>['queued','preparing','planning','running','waiting_approval','verifying'].includes(state);
const completed=(state:string)=>state==='completed';
const interrupted=(state:string)=>['failed','uncertain','blocked','paused','cancelled','limit'].includes(state);
const short=(text:string,len=105)=>text.length>len?text.slice(0,len)+'…':text;
const usage=(tokens:number)=>{
  if(!Number.isFinite(tokens)||tokens<1)return '';
  return tokens>=1e6?(tokens/1e6).toFixed(1)+'M':tokens>=1000?(tokens/1000).toFixed(1)+'k':String(tokens);
};
const duration=(from?:string|null,to?:string|null)=>{
  if(!from)return '';
  const start=new Date(from).getTime(),end=to?new Date(to).getTime():Date.now();
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return '';
  const seconds=Math.floor((end-start)/1000);
  if(seconds<60)return seconds+'s';
  const minutes=Math.floor(seconds/60);
  return minutes<60?minutes+'m '+seconds%60+'s':Math.floor(minutes/60)+'h '+minutes%60+'m';
};
function StateIcon({status}:{status:string}){
  if(completed(status))return <CircleCheck className="w-3.5 h-3.5 text-success flex-shrink-0"/>;
  if(interrupted(status))return <CircleAlert className="w-3.5 h-3.5 text-warning flex-shrink-0"/>;
  if(running(status))return <Loader2 className="w-3.5 h-3.5 animate-spin text-primary flex-shrink-0"/>;
  return <CirclePause className="w-3.5 h-3.5 text-faint flex-shrink-0"/>;
}

export function WorkflowCard({
  workflow,compact=false,onOpenAgent,onCancel,stopPending=false,
}:{
  workflow:BackgroundWorkflow;
  compact?:boolean;
  onOpenAgent?:(taskId:string)=>void;
  onCancel?:(workflowId:string)=>void;
  stopPending?:boolean;
}){
  const {t}=useTranslation();
  const [expanded,setExpanded]=useState(true);
  const [phaseExpanded,setPhaseExpanded]=useState<Record<string,boolean>>({});
  const tokens=usage((workflow.usage?.inputTokens||0)+(workflow.usage?.outputTokens||0));
  const status=workflow.status;
  const showPhase=(phase:WorkflowPhase)=>phaseExpanded[phase.id] ?? (!compact && phase.status!=='completed');
  const canCancel=running(status)&&workflow.activeAgents>0;
  return <section data-testid="agent-workflow" data-workflow-id={workflow.id}
    data-parent-run={workflow.parentRunId||''}
    className="rounded-xl border border-line bg-surface text-xs overflow-hidden">
    <div className="flex items-center gap-2 p-3">
      <Workflow className="w-4 h-4 text-primary flex-shrink-0"/>
      <button type="button" aria-expanded={expanded}
        onClick={()=>setExpanded(v=>!v)} className="flex-1 min-w-0 text-left flex items-center gap-1.5">
        <span className="font-semibold text-fg truncate" title={workflow.name}>{workflow.name}</span>
        {expanded?<ChevronDown className="w-3 h-3 flex-shrink-0 text-muted"/>:<ChevronRight className="w-3 h-3 flex-shrink-0 text-muted"/>}
      </button>
      <StateIcon status={status}/>
      <span className="text-[12px] text-faint whitespace-nowrap">{duration(workflow.createdAt,workflow.finishedAt)}</span>
      {canCancel&&onCancel&&<button type="button" title={t('agents_wf_stop_hint')}
        aria-label={t('agents_wf_stop_label',{name:workflow.name})} disabled={stopPending}
        onClick={()=>onCancel(workflow.id)}
        className="p-1 rounded-md text-muted hover:text-danger disabled:opacity-40">
        {stopPending?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:<Square className="w-3.5 h-3.5"/>}
      </button>}
    </div>
    {expanded&&<div className="px-3 pb-3 space-y-3">
      <div className="flex gap-3 flex-wrap items-center text-[12px] text-muted">
        <span>{t(status==='completed'?'agents_wf_completed':status==='cancelled'?'agents_wf_cancelled':
          status==='blocked'||status==='failed'?'agents_wf_needs_review':
          status==='paused'?'agents_wf_paused':'agents_wf_running')}</span>
        <span><Bot className="w-3 h-3 inline align-middle"/> {t(workflow.total===1?'agents_wf_agents_one':'agents_wf_agents_other',{n:workflow.total})}</span>
        <span>{t('agents_wf_progress',{done:workflow.completed,total:workflow.total})}</span>
        {tokens&&<span title={t('agents_wf_tokens_hint')}>{t('agents_wf_tokens',{tokens})}</span>}
      </div>
      <div className="h-1.5 rounded-full bg-hover overflow-hidden" aria-label={t('agents_wf_progress_label')}>
        <div className="h-full bg-primary transition-all duration-300 rounded-full"
          style={{width:(workflow.total?100*workflow.completed/workflow.total:0)+'%'}}/>
      </div>
      {workflow.error&&<p role="status" className="text-[12px] text-warning break-words">{workflow.error}</p>}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1 text-[12px] font-medium text-muted">
          <ListChecks className="w-3.5 h-3.5"/> {t('agents_wf_phases')}
        </div>
        {workflow.phases.map(phase=>{
          const open=showPhase(phase);
          return <div key={phase.id} className="rounded-lg border border-line overflow-hidden"
            data-testid="workflow-phase" data-phase={phase.name}>
            <button type="button" aria-expanded={open}
              onClick={()=>setPhaseExpanded(v=>({...v,[phase.id]:!open}))}
              className="w-full p-2 flex items-center gap-2 bg-panel hover:bg-hover text-left">
              <StateIcon status={phase.status}/>
              <span className="text-fg font-medium flex-1 truncate">{phase.name}</span>
              <span className="text-muted text-[12px]">{phase.completed}/{phase.total}</span>
              {open?<ChevronDown className="w-3 h-3 text-muted"/>:<ChevronRight className="w-3 h-3 text-muted"/>}
            </button>
            <div className="h-1 bg-hover flex gap-0.5">
              {phase.agents.map(agent=><div key={agent.id} className={'h-full flex-1 '+(completed(agent.status)?'bg-primary':running(agent.status)?'bg-primary/60':'bg-line')}/>)}
            </div>
            {open&&<div className="px-2 py-1 space-y-1 bg-surface">
              {phase.agents.map(agent=><div key={agent.taskId}
                data-testid="workflow-subagent" data-agent-status={agent.status}
                className="flex items-start gap-2 py-1.5 text-[12px]">
                <StateIcon status={agent.status}/>
                <div className="flex-1 min-w-0 space-y-0.5">
                  {onOpenAgent?<button type="button" title={agent.goal} onClick={()=>onOpenAgent(agent.taskId)}
                    className="text-left font-medium text-fg hover:underline break-words">
                    {agent.role||short(agent.goal,100)}
                  </button>:<p className="text-fg font-medium break-words">{agent.role||short(agent.goal,100)}</p>}
                  {agent.role&&<p className="text-faint break-words">{short(agent.goal,compact?95:155)}</p>}
                  {agent.branch&&<div className="text-faint truncate" title={agent.worktree||agent.branch}>
                    <GitBranch className="w-3 h-3 inline"/> {agent.branch}
                  </div>}
                  {agent.status==='completed'&&agent.resultPreview&&
                    <p className="text-muted line-clamp-2 break-words">{agent.resultPreview}</p>}
                  {agent.status==='completed'&&agent.resultNotice&&
                    <div className="space-y-0.5">
                      <HiddenNote show={hasHidden(agent.resultNotice)}/>
                      <p data-testid="workflow-subagent-notice" title={agent.resultNotice} className="text-faint line-clamp-4 break-words select-text">
                        <span className="font-medium text-muted">{t('agents_wf_hub_note')}</span>{' '}<HiddenText text={agent.resultNotice}/>
                      </p>
                    </div>}
                </div>
                <div className="text-right flex-shrink-0 text-faint space-y-0.5">
                  <div>{agent.model||agent.status}</div>
                  <div>{duration(agent.startedAt,agent.finishedAt)}</div>
                </div>
              </div>)}
              {!phase.agents.length&&<p className="text-[12px] text-faint py-2">
                {t('agents_wf_delegating')}
              </p>}
            </div>}
          </div>;
        })}
      </div>
      <p className="text-[12px] text-faint">
        {t('agents_wf_footer')}
      </p>
    </div>}
  </section>;
}
