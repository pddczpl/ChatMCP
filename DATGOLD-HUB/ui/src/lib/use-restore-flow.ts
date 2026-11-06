// The one way the page restores files: plan from the Hub's preview, ask (components/ui/ConfirmDialog.tsx), restore, and say what happened. The step, the task, the checkpoint and the last
// restore all go through it, so that they ask the same questions, keep the same backup and report the same way (lib/rollback.ts has the plans and the words).
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import type { TranslationKey } from '@/lib/i18n';
import { describePlan, describeResult, lastRestoreOf, planTaskUndo, readLastRestore, restoreErrorKey, undoRequestOf, writeLastRestore } from '@/lib/rollback';
import type { LastRestore, RestorePlan, RestoreResult, Said, Shas } from '@/lib/rollback';
import { useAppStore } from '@/store/useAppStore';

export interface RestoreRun {
  plan: RestorePlan;
  title: string;
  body?: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  source: LastRestore['source'];
  /** Sends the restore to the Hub: only the files of the plan, each expected to be as the plan saw it; conflicts that come up are skipped and listed. */
  execute: (request: { files: string[]; expectedShas: Shas }) => Promise<RestoreResult>;
}

export type RestoreOutcome =
  | { kind: 'nothing' }
  | { kind: 'cancelled' }
  | { kind: 'done'; tone: 'ok' | 'warn'; text: string; result: RestoreResult }
  | { kind: 'error'; text: string };

const storage = () => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};

/** The data the page keeps that a restore can make stale: all of it is read again. */
const AFFECTED = ['taskReview', 'checkpointsList', 'checkpointPreview', 'checkpointDiff', 'gitStatus', 'gitDiff', 'hubState', 'files', 'tree'];

export function useRestoreFlow() {
  const { t } = useTranslation();
  const ask = useConfirm();
  const queryClient = useQueryClient();
  const hub = useQuery({ queryKey: ['hubState'], queryFn: api.getState });
  const workspace = hub.data?.workspace?.path ?? '';
  /** The Hub refuses to restore while an agent runs; the page says so before it is asked. */
  const running = Boolean(hub.data?.agent?.activeTaskId);
  const lastRestore = useAppStore((state) => (workspace ? state.lastRestores[workspace] ?? null : null));
  const setLastRestore = useAppStore((state) => state.setLastRestore);

  // A page that was reloaded finds the last restore of this workspace in the browser's storage.
  useEffect(() => {
    if (workspace && !Object.hasOwn(useAppStore.getState().lastRestores, workspace)) setLastRestore(workspace, readLastRestore(storage(), workspace));
  }, [workspace, setLastRestore]);

  const say = (said: Said) => t(said.key as TranslationKey, said.values);
  const sayError = (error: unknown) => {
    const said = restoreErrorKey(error);
    return said.key === 'rollback_error_generic' && !said.values.message ? t('git_checkpoint_restore_failed') : say(said);
  };
  const remember = (last: LastRestore | null) => {
    if (!workspace) return;
    setLastRestore(workspace, last);
    writeLastRestore(storage(), workspace, last);
  };
  const refresh = () => Promise.all(AFFECTED.map((name) => queryClient.invalidateQueries({ queryKey: [name] })));

  /** Asks, restores, remembers the backup, reads the page's data again, and says what happened. Cancelling changes nothing. */
  async function run(options: RestoreRun): Promise<RestoreOutcome> {
    if (options.plan.rows.length === 0) return { kind: 'nothing' };
    const words = describePlan(options.plan);
    const confirmed = await ask({
      title: options.title, body: options.body, tone: options.tone, confirmLabel: options.confirmLabel,
      details: words.details.map(say), notes: words.notes.map((note) => ({ tone: note.tone, text: say(note) })),
    });
    if (!confirmed) return { kind: 'cancelled' };
    try {
      const result = await options.execute({ files: options.plan.rows.map((row) => row.path), expectedShas: options.plan.expectedShas });
      const last = lastRestoreOf(result, options.source, new Date().toISOString());
      if (last) remember(last);
      await refresh();
      const summary = describeResult(result, options.plan.conflicts);
      return { kind: 'done', tone: summary.tone, text: summary.lines.map(say).join(' '), result };
    } catch (error) {
      return { kind: 'error', text: sayError(error) };
    }
  }

  /** Puts back what the last restore replaced, if the files are still as that restore left them. */
  async function undoLast(): Promise<RestoreOutcome> {
    if (!lastRestore) return { kind: 'nothing' };
    const request = undoRequestOf(lastRestore);
    try {
      const preview = await api.previewCheckpoint(request.checkpointId);
      return await run({
        plan: planTaskUndo(preview, request.expectedShas),
        title: t('rollback_last_title'), body: t('rollback_last_body'), confirmLabel: t('rollback_last_confirm'), tone: 'primary', source: 'undo',
        execute: ({ files, expectedShas }) => api.revertCheckpoint(request.checkpointId, expectedShas, { files, onConflict: 'skip' }),
      });
    } catch (error) {
      return { kind: 'error', text: sayError(error) };
    }
  }

  return { run, undoLast, forgetLast: () => remember(null), lastRestore, running, say, sayError, workspace };
}
