import { FileDiff } from 'lucide-react';
import { editedPaths } from '@/lib/review-offer';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import type { Task } from '@/types';

/**
 * Under a finished turn that edited files: how many files the conversation changed (from the edits the Hub recorded, not from what the model said), and the way into the Review tab.
 * It offers nothing when no edit went through.
 */
export function ReviewOffer({ task }: { task: Task }) {
  const { t } = useTranslation();
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const paths = editedPaths(task.toolCalls);
  if (paths.length === 0) return null;
  return (
    <section aria-label={t('review_offer_action')} data-testid="review-offer" className="anim-rise my-4 flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <FileDiff className="h-[18px] w-[18px] shrink-0 text-primary" />
      <p className="min-w-0 flex-1 text-[13px] leading-5 text-muted">{t('review_offer_text', { count: paths.length })}</p>
      <Button size="sm" variant="primary" onClick={() => setActiveTab('review')}>{t('review_offer_action')}</Button>
    </section>
  );
}
