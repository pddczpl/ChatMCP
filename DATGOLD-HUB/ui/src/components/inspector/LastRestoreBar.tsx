import { useState } from 'react';
import { History } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { formatDateTime } from '@/lib/format';
import { useTranslation } from '@/lib/i18n';
import { useRestoreFlow } from '@/lib/use-restore-flow';
import type { RestoreOutcome } from '@/lib/use-restore-flow';

/**
 * The restore that was made last in this workspace, and the way back from it: "Undo last restore" puts every file back as it was before that restore, if none of them has changed since
 * (the Hub made a backup before it wrote, and gave its id). It stays until it is used or dismissed, also after the page is reloaded. `onOutcome` lets the screen it stands in show the result.
 */
export function LastRestoreBar({ onOutcome }: { onOutcome: (outcome: RestoreOutcome) => void }) {
  const { t, lang } = useTranslation();
  const flow = useRestoreFlow();
  const [busy, setBusy] = useState(false);
  const last = flow.lastRestore;
  if (!last) return null;
  const undo = async () => {
    setBusy(true);
    try { onOutcome(await flow.undoLast()); } finally { setBusy(false); }
  };
  return (
    <div role="group" aria-label={t('rollback_undo_last')} data-testid="last-restore" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
      <p className="flex min-w-0 items-center gap-2 text-[13px] text-muted"><History className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('rollback_last_summary', { count: last.files })} · {formatDateTime(last.at, lang)}</p>
      <div className="flex gap-1.5">
        <Button size="sm" variant="secondary" disabled={busy || flow.running} title={flow.running ? t('rollback_undo_blocked') : undefined} onClick={() => void undo()} data-testid="undo-last-restore">{t('rollback_undo_last')}</Button>
        <Button size="sm" variant="quiet" disabled={busy} onClick={flow.forgetLast}>{t('rollback_last_dismiss')}</Button>
      </div>
    </div>
  );
}
