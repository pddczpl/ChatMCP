import { useQuery } from '@tanstack/react-query';
import { Bell, CircleArrowUp } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { translate, useTranslation } from '@/lib/i18n';
import { noticeKind, safeNotesUrl } from '@/lib/updates';
import { useUpdateActions } from '@/lib/useUpdateActions';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import type { UpdateInfo } from '@/types';

const strip = 'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-primary/30 bg-primary/10 px-4 py-2 text-[13px] text-fg';

/**
 * The strip under the header: first the question the owner is asked once (may DatGold look for a new version by itself?), then a release that is on offer, with "What's new" and
 * "Skip this version". Presentational (the container below talks to the Hub), so that a test can render every state. It only tells: nothing here downloads or starts anything.
 */
export function UpdateNotice({ update, lang: pinned, busy = false, onAnswer, onSkip, onDetails }: {
  update: UpdateInfo | null | undefined; lang?: 'vi' | 'en'; busy?: boolean;
  onAnswer: (enabled: boolean) => void; onSkip: (version: string) => void; onDetails: () => void;
}) {
  const { lang: current } = useTranslation();
  const lang = pinned ?? current;
  const t = (key: string, params?: Record<string, string | number>) => translate(lang, key, params);
  const kind = noticeKind(update);
  if (!update || kind === 'none') return null;

  if (kind === 'question') {
    return (
      <div role="status" data-testid="update-question" data-kind="question" className={strip}>
        <Bell className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-[16rem] flex-1">
          <p data-testid="update-question-title" className="font-medium">{t('upd_q_title')}</p>
          <p data-testid="update-question-body" className="mt-0.5 text-[12px] leading-5 text-muted">{t('upd_q_body', { version: update.current })}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button data-testid="update-yes" size="sm" variant="primary" disabled={busy} onClick={() => onAnswer(true)}>{t('upd_q_yes')}</Button>
          <Button data-testid="update-no" size="sm" variant="secondary" disabled={busy} onClick={() => onAnswer(false)}>{t('upd_q_no')}</Button>
          <button type="button" data-testid="update-details" onClick={onDetails} className="text-[13px] text-fg underline decoration-fg/40 underline-offset-2 hover:decoration-fg">{t('upd_q_details')}</button>
        </div>
      </div>
    );
  }

  const latest = String(update.latest);
  // The Hub builds the link from the version; the page shows it only when it is exactly the tag page of that release on the project's GitHub.
  const notes = safeNotesUrl(update);
  return (
    <div role="status" data-testid="update-notice" data-kind="available" data-version={latest} className={strip}>
      <CircleArrowUp className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span data-testid="update-notice-text" className="min-w-0 flex-1 font-medium">{t('upd_n_available', { version: latest })}</span>
      {notes && (
        <a data-testid="update-notes" href={notes} target="_blank" rel="noopener noreferrer"
          className="inline-flex h-8 shrink-0 items-center rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-primary transition-colors hover:border-line-strong hover:bg-hover">{t('upd_n_notes')}</a>
      )}
      {/* In the desktop shell a link that opens a new window goes to the preview tab, which cannot show github.com: the owner can always copy the address instead. */}
      {notes && <span data-testid="update-copy" className="shrink-0"><CopyButton text={notes} label={t('upd_copy_link')} /></span>}
      <Button data-testid="update-skip" size="sm" variant="secondary" disabled={busy} onClick={() => onSkip(latest)}>{t('upd_n_skip')}</Button>
    </div>
  );
}

export function UpdateBanner() {
  const openSettings = useAppStore(state => state.openSettings);
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const { busy, answer, skip } = useUpdateActions();
  return <UpdateNotice update={hub?.update} busy={busy} onAnswer={enabled => void answer(enabled)} onSkip={version => void skip(version)} onDetails={() => openSettings('updates')} />;
}
