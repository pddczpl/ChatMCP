import { useState } from 'react';
import { api } from '@/lib/api';
import { planStepUndo } from '@/lib/rollback';
import { useRestoreFlow } from '@/lib/use-restore-flow';
import type { RestoreOutcome } from '@/lib/use-restore-flow';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';

/**
 * "Undo this step" beside the receipt of a call that had a checkpoint: it puts back the files that very call changed, as the checkpoint of that call holds them, if they are still as the
 * call left them. A file changed since is not touched and is named; a step that ran a command is said to be incomplete, since only a snapshot of the source files was taken before it.
 * The Hub saves the files first, so the undo can itself be undone (Undo last restore).
 */
export function UndoStepButton({ checkpointId, label }: { checkpointId: string; label: string }) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const flow = useRestoreFlow();
  const [busy, setBusy] = useState(false);

  const report = (outcome: RestoreOutcome) => {
    if (outcome.kind === 'done') showToast(outcome.text, outcome.tone === 'ok' ? 'success' : 'warning');
    else if (outcome.kind === 'error') showToast(outcome.text, 'error');
  };
  const undo = async () => {
    setBusy(true);
    try {
      const plan = planStepUndo(await api.previewCheckpoint(checkpointId));
      if (plan.rows.length === 0) {
        showToast(plan.conflicts.length > 0 ? t('rollback_nothing_conflicts', { paths: plan.conflicts.join(', ') }) : t('rollback_nothing'), 'warning');
        return;
      }
      report(await flow.run({
        plan, tone: 'primary', source: 'step', confirmLabel: t('rollback_step_confirm'),
        title: plan.incomplete ? t('rollback_step_title_incomplete') : t('rollback_step_title'),
        execute: ({ files, expectedShas }) => api.revertCheckpoint(checkpointId, expectedShas, { files, onConflict: 'skip' }),
      }));
    } catch (error) {
      showToast(flow.sayError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" onClick={() => void undo()} disabled={busy || flow.running} aria-label={label} title={flow.running ? t('rollback_undo_blocked') : label} data-testid="receipt-undo-step"
      className="mr-2 shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50">
      {t('rollback_undo_step')}
    </button>
  );
}
