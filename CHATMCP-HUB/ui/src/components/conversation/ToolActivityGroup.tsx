import { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { ToolCall } from '@/types';
import { ToolReceipt } from './ToolReceipt';

export function ToolActivityGroup({items}:{items:ToolCall[]}) {
  const [expanded,setExpanded]=useState(false);
  const reads=items.filter(t=>/read|search|find|list|symbol|reference|repo_map/.test(t.name)).length;
  const commands=items.filter(t=>/command|shell|exec|bash|test|check|terminal/.test(t.name)).length;
  const edits=items.filter(t=>/write|edit|patch|create|replace/.test(t.name)).length;
  const other=items.length-reads-commands-edits;
  const parts=[commands&&'Ran '+commands+' commands',reads&&'read '+reads+' files',edits&&'edited '+edits+' files',
    other>0&&'used '+other+' tools'].filter(Boolean);
  const title=parts.join(', ')||'Used '+items.length+' tools';
  const running=items.some(t=>t.status==='running');
  const failed=items.some(t=>t.status==='error');
  return <div className="mx-4 my-1.5 rounded-lg border border-[var(--line)] bg-[var(--panel)]" data-testid="tool-activity-group">
    <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(x=>!x)}
      className="w-full px-3 py-2 flex items-center gap-2 text-xs text-left hover:bg-[var(--surface-hover)] rounded-lg">
      {expanded?<ChevronDown className="w-3.5 h-3.5 text-[var(--muted)]"/>:<ChevronRight className="w-3.5 h-3.5 text-[var(--muted)]"/>}
      <Terminal className="w-3.5 h-3.5 text-[var(--muted)]"/>
      <span className="flex-1 truncate text-[var(--text)]">{title}</span>
      {running?<Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400"/>:
        failed?<AlertCircle className="w-3.5 h-3.5 text-rose-400"/>:
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400"/>}
    </button>
    {expanded&&<div className="pb-1 border-t border-[var(--line)]">
      {items.map((item,index)=><ToolReceipt key={item.id||index} tool={item}/>)}
    </div>}
  </div>;
}
