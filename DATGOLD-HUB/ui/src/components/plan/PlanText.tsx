import { useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import { hasHidden } from '@/lib/hidden-chars';
import { MarkdownText } from '@/components/conversation/MessageItem';
import { HiddenNote, HiddenText } from '@/components/inspector/HiddenText';
import { cn } from '@/lib/utils';

/**
 * The text of a plan, formatted or as its source. The source is what the agent is given on an approval: Markdown can hold words that formatting does not show (the
 * address of a link), and a text with characters that cannot be seen is shown as its source, with those marked, until the owner chooses otherwise.
 */
export function PlanText({ text }: { text: string }) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<'formatted' | 'source' | null>(null);
  const hidden = hasHidden(text);
  const source = choice === null ? hidden : choice === 'source';
  const tab = (value: 'formatted' | 'source', label: string) => (
    <button type="button" data-action={`view-${value}`} aria-pressed={source === (value === 'source')} title={value === 'source' ? t('plan_view_source_hint') : undefined} onClick={() => setChoice(value)}
      className={cn('h-7 rounded-md px-2 text-[12px] font-medium transition-colors', source === (value === 'source') ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}>{label}</button>
  );
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-muted">{t('plan_text_title')}</span>
        <div role="group" aria-label={t('plan_view_label')} className="flex shrink-0 rounded-lg border border-line bg-surface p-0.5">
          {tab('formatted', t('plan_view_formatted'))}
          {tab('source', t('plan_view_source'))}
        </div>
      </div>
      <div role="region" aria-label={t('plan_text_title')} tabIndex={0} data-testid="plan-text" className="max-h-96 overflow-auto rounded-lg border border-line bg-bg px-3 py-2">
        {source ? <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-fg"><HiddenText text={text} /></pre>
          : <div className="conversation-copy max-w-none text-fg"><MarkdownText text={text} /></div>}
      </div>
      <HiddenNote show={hidden} />
    </div>
  );
}
