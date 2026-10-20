import { AlertTriangle } from 'lucide-react';

export interface ContextPolicy {
  source: string;
  capacityTokens: number;
  maxHistoryTokens: number;
  compactAtTokens?: number;
  /** What the request may generate (the cap the agent sends). */
  reservedOutputTokens: number;
  /** What the history budget keeps free; differs from the cap only when the window is unknown. */
  plannedOutputTokens?: number;
  approximate?: boolean;
}

const grouped = (value: number) => value.toLocaleString('en-US');

/** The context budget of a task. An unknown window is a warning that says what to do, never a quiet "estimated". */
export function ContextPolicyNotice({ policy }: { policy: ContextPolicy }) {
  const planned = policy.plannedOutputTokens ?? policy.reservedOutputTokens;
  const details = `History: about ${grouped(policy.maxHistoryTokens)} tokens. Output: the request may use up to ${grouped(policy.reservedOutputTokens)} tokens; history is planned for ${grouped(planned)}. Source: ${policy.source}. Estimates, not provider-billed usage.`;
  if (policy.source === 'conservative_fallback') {
    return (
      <span data-testid="context-window-warning" role="status" title={details}
        className="inline-flex items-center gap-1 text-amber-400">
        <AlertTriangle className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
        Context window unknown — planning with {grouped(policy.capacityTokens)} tokens.
        Set the model&apos;s context window in the AI Model tab (or in its model profile) to the real size.
      </span>
    );
  }
  return (
    <span title={details}>
      Context: {grouped(policy.capacityTokens)} tokens ({policy.source === 'trusted_model_metadata' ? 'from model metadata' : 'configured'})
    </span>
  );
}
