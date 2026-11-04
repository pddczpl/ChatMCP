import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, FileSearch, RefreshCw, RotateCcw, Undo2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { hasTranslation, useTranslation } from '@/lib/i18n';
import { acceptHunk as markAccepted, acceptHunks as markAllAccepted, diffFile } from '@/lib/review-hunks';
import { carryMarks, readMarks, writeMarks } from '@/lib/review-accepted';
import type { MarkStore } from '@/lib/review-accepted';
import { acceptAllOf, acceptFileOf, rejectAllOf, rejectFileOf, rejectHunkOf, summarizeBatch } from '@/lib/review-actions';
import type { BatchResult } from '@/lib/review-actions';
import { findReviewFile } from '@/lib/review-offer';
import { planTaskUndo } from '@/lib/rollback';
import { useRestoreFlow } from '@/lib/use-restore-flow';
import type { RestoreOutcome } from '@/lib/use-restore-flow';
import { byteOrderMarkDiffers, fileActions, fileGone, fileMode, hunkGone, keyAction, landAfterReject, moveHunk, pendingTotal, planAccept, planReject, touchesByteOrderMark, writeState } from '@/lib/review-rules';
import type { ConflictKind, ReviewItem } from '@/lib/review-rules';
import { taskCheckpointSource } from '@/lib/review-source-task';
import type { ReviewFile, ReviewLimitation, ReviewSnapshot } from '@/lib/review-source';
import { Button } from '@/components/ui/Button';
import { EmptyBlock, ErrorLine, LoadingLine, TabBody } from './parts';
import { ReviewConfirm } from './ReviewConfirm';
import type { ConfirmKind } from './ReviewConfirm';
import { ReviewFileList } from './ReviewFileList';
import { ReviewFileView } from './ReviewFileView';
import { LastRestoreBar } from './LastRestoreBar';

type Status = { tone: 'ok' | 'warn'; text: string } | null;

/** The line under the buttons for what a restore did; cancelling says nothing. */
const statusOf = (outcome: RestoreOutcome, nothing: string): Status => {
  if (outcome.kind === 'done') return { tone: outcome.tone, text: outcome.text };
  if (outcome.kind === 'error') return { tone: 'warn', text: outcome.text };
  return outcome.kind === 'nothing' ? { tone: 'warn', text: nothing } : null;
};

const NO_FILES: ReviewFile[] = [];

/** The browser's storage, or nothing when it is blocked (a private window): the marks then last until the page is closed. */
const browserStore = (): MarkStore | null => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};

/**
 * The Review tab: every file the selected conversation changed, read from the Hub's checkpoints, with each hunk to accept (a mark kept on this page) or reject (the file saved with the hunk
 * undone, guarded by the sha that was reviewed), and a file to accept or reject as a whole. What the Hub will refuse is not offered, and says why.
 */
export function ReviewTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selectedTaskId, reviewFocus, clearReviewFocus } = useAppStore();
  const hubQuery = useQuery({ queryKey: ['hubState'], queryFn: api.getState });
  const taskQuery = useQuery({ queryKey: ['task', selectedTaskId], queryFn: () => api.getTask(selectedTaskId), enabled: Boolean(selectedTaskId) });
  const hub = hubQuery.data;
  const task = taskQuery.data;
  // What a conversation changed grows while it runs and is final when it stops: the review is read again when its state changes, and after what this tab does itself. It is not polled
  // (an answer can carry megabytes of text) and not read again when the window gets the focus, so that what is on screen stays the review the sha of a write refers to.
  const version = `${task?.status ?? ''}:${task?.finishedAt ?? ''}`;
  const source = useMemo(() => taskCheckpointSource(selectedTaskId, api), [selectedTaskId]);
  const reviewKey = ['taskReview', selectedTaskId, version];
  const reviewQuery = useQuery({
    queryKey: reviewKey, queryFn: () => source.load(), enabled: Boolean(selectedTaskId),
    refetchOnWindowFocus: false, refetchOnReconnect: false,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === selectedTaskId ? previous : undefined),
  });
  const snapshot = reviewQuery.data;
  const files = snapshot?.files ?? NO_FILES;

  const [selectedPath, setSelectedPath] = useState('');
  const [activeHunk, setActiveHunk] = useState(-1);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [markVersion, bumpMarks] = useReducer((count: number) => count + 1, 0);
  const working = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  // Marks made while storage is blocked, so that "accept" still does something until the page is closed.
  const memoryMarks = useRef(new Map<string, ReadonlySet<string>>());

  const state = writeState({ activeTaskId: hub?.agent?.activeTaskId, executionPolicy: hub?.studio?.permissions?.executionPolicy });
  const flow = useRestoreFlow();
  const diffs = useMemo(() => files.map((file) => {
    const mode = fileMode(file);
    return mode === 'text' || mode === 'created' || mode === 'deleted' ? diffFile(file.baselineText ?? '', file.currentText ?? '') : null;
  }), [files]);
  const items: ReviewItem[] = useMemo(() => files.map((file, index) => {
    const remembered = memoryMarks.current.get(`${selectedTaskId}\n${file.path}\n${file.currentSha}`);
    return { file, diff: diffs[index], accepted: new Set([...readMarks(browserStore(), selectedTaskId, file.path, file.currentSha), ...(remembered ?? [])]) };
    // markVersion: a mark was made or dropped
  }), [files, diffs, selectedTaskId, markVersion]);
  const selected = items.find((item) => item.file.path === selectedPath) ?? items[0];
  const pending = pendingTotal(items);
  const acceptPlan = planAccept(items, state);
  const rejectPlan = planReject(items, state);

  useEffect(() => {
    setSelectedPath('');
    setActiveHunk(-1);
    setStatus(null);
    setConfirm(null);
  }, [selectedTaskId]);
  // A hunk that is put back is gone when the file is read again, and the focus with it. The person lands on the hunk that now sits at that place (or the last one), so that the keys go on
  // without a click; any other change of the open file, or another file, starts with no hunk open.
  const landing = useRef<{ path: string; index: number } | null>(null);
  const [focusHunk, setFocusHunk] = useState<number | null>(null);
  useEffect(() => {
    const wanted = landing.current;
    landing.current = null;
    const next = wanted && wanted.path === selected?.file.path ? landAfterReject(wanted.index, selected?.diff?.hunks.length ?? 0) : -1;
    setActiveHunk(next);
    setFocusHunk(next >= 0 ? next : null);
  }, [selected?.file.path, selected?.file.currentSha]);
  useEffect(() => {
    if (focusHunk === null) return;
    listRef.current?.querySelector<HTMLElement>(`[data-hunk-index="${focusHunk}"]`)?.focus();
    setFocusHunk(null);
  }, [focusHunk, items]);
  // The receipt of an edit asks for one file: open it as soon as the review is there.
  useEffect(() => {
    if (!reviewFocus || reviewQuery.isPending) return;
    const match = findReviewFile(files, reviewFocus.path);
    if (match) setSelectedPath(match.path);
    clearReviewFocus();
  }, [reviewFocus, reviewQuery.isPending, files, clearReviewFocus]);

  // Reads the review again and hands it back, so that what a write did can be checked against what the Hub says now (null when it could not be read: the query shows why).
  const reload = async (): Promise<ReviewSnapshot | null> => {
    try { return await queryClient.fetchQuery({ queryKey: reviewKey, queryFn: () => source.load(), staleTime: 0 }); } catch { return null; }
  };
  const remember = (item: ReviewItem, sha: string | null, marks: ReadonlySet<string>) => {
    if (sha) memoryMarks.current.set(`${selectedTaskId}\n${item.file.path}\n${sha}`, marks);
    writeMarks(browserStore(), selectedTaskId, item.file.path, sha, marks);
  };
  const settle = async (work: () => Promise<Status>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try { setStatus(await work()); } finally { working.current = false; setBusy(false); }
  };
  const refused = async (kind: ConflictKind, path: string): Promise<Status> => {
    if (kind === 'stale') await reload();
    return { tone: 'warn', text: t(`review_conflict_${kind}`, { path }) };
  };
  const summary = (result: BatchResult, kept: readonly string[] = []): Status => {
    const { tone, lines } = summarizeBatch(result, kept);
    return { tone, text: lines.map((line) => t(line.key, line.values)).join(' ') };
  };

  const acceptHunkAt = (item: ReviewItem, index: number) => {
    const hunk = item.diff?.hunks[index];
    if (!hunk) return;
    remember(item, item.file.currentSha, markAccepted(item.accepted, hunk));
    bumpMarks();
  };
  const rejectHunkAt = (item: ReviewItem, index: number) => settle(async () => {
    const hunk = item.diff?.hunks[index];
    if (!item.diff || !hunk) return null;
    landing.current = { path: item.file.path, index };
    const outcome = await rejectHunkOf(source, item.file, item.diff, index);
    if (!outcome.ok) {
      landing.current = null;
      return refused(outcome.kind, item.file.path);
    }
    // A hunk that is still there after this one went keeps its mark: its fingerprint does not depend on where in the file it is. Another change of the file starts again. A file the Hub had
    // recorded as accepted counted all its hunks as accepted; that record belongs to the version that was saved over, so the hunks that are left take it over as marks.
    const looked = item.file.accepted ? markAllAccepted(item.accepted, item.diff.hunks) : item.accepted;
    if (outcome.sha && outcome.text !== null) remember(item, outcome.sha, carryMarks(looked, diffFile(item.file.baselineText ?? '', outcome.text).hunks));
    // The save went through, but "put back" is true only if the review that is read now no longer has the hunk: the Hub keeps a byte order mark on every save, so the hunk that put one in stays.
    const fresh = await reload();
    if (fresh && !hunkGone(fresh.files, item.file.path, hunk.fingerprint)) {
      landing.current = null;
      return { tone: 'warn', text: t(touchesByteOrderMark(item.file, hunk) ? 'review_result_hunk_kept_bom' : 'review_result_hunk_kept', { path: item.file.path }) };
    }
    return { tone: 'ok', text: t('review_result_hunk', { path: item.file.path }) };
  });
  const acceptFile = (item: ReviewItem) => settle(async () => {
    const outcome = await acceptFileOf(source, item.file);
    if (!outcome.ok) return refused(outcome.kind, item.file.path);
    await reload();
    return { tone: 'ok', text: t('review_result_accepted', { path: item.file.path }) };
  });
  const rejectFile = (item: ReviewItem) => settle(async () => {
    const outcome = await rejectFileOf(source, item.file, item.diff);
    if (!outcome.ok) return refused(outcome.kind, item.file.path);
    const fresh = await reload();
    if (fresh && !fileGone(fresh.files, item.file.path)) return { tone: 'warn', text: t(byteOrderMarkDiffers(item.file) ? 'review_result_file_kept_bom' : 'review_result_file_kept', { path: item.file.path }) };
    return { tone: 'ok', text: t(item.file.change === 'created' ? 'review_result_created' : 'review_result_file', { path: item.file.path }) };
  });
  const confirmAll = () => settle(async () => {
    const kind = confirm;
    setConfirm(null);
    if (kind === 'reject') {
      const result = await rejectAllOf(source, items, state);
      const fresh = await reload();
      return summary(result, fresh ? result.done.filter((path) => !fileGone(fresh.files, path)) : []);
    }
    for (const item of items) if (item.diff && fileActions(item.file, state).byHunk) remember(item, item.file.currentSha, markAllAccepted(item.accepted, item.diff.hunks));
    bumpMarks();
    const result = await acceptAllOf(source, items, state);
    await reload();
    return summary(result);
  });

  // Undo all the changes of the task: every file goes back to the baseline of the task in one restore (also a file the task deleted, which the hunks cannot bring back), each expected to be
  // what this review shows. The Hub saves the files first, so the undo can be undone from the bar below the buttons.
  const undoAll = () => settle(async () => {
    try {
      const preview = await api.previewTaskRestore(selectedTaskId);
      const plan = planTaskUndo(preview, Object.fromEntries(files.map((file) => [file.path, file.currentSha ?? null])));
      const outcome = await flow.run({
        plan, tone: 'danger', source: 'task', title: t('rollback_task_title'), body: t('rollback_task_body'), confirmLabel: t('rollback_task_confirm'),
        execute: ({ files: wanted, expectedShas }) => api.revertTask(selectedTaskId, expectedShas, { files: wanted, onConflict: 'skip' }),
      });
      await reload();
      return statusOf(outcome, plan.conflicts.length > 0 ? t('rollback_nothing_conflicts', { paths: plan.conflicts.join(', ') }) : t('rollback_task_nothing'));
    } catch (error) {
      return { tone: 'warn', text: flow.sayError(error) };
    }
  });

  // Single keys, only while the focus is inside the hunks: j and k move, a accepts, r puts the hunk back. Never with Ctrl, Alt or Meta, never in a field, never while the dialog is open.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (confirm !== null || working.current || !selected?.diff) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const action = keyAction(event);
    if (!action) return;
    const focused = Number(target.closest('[data-hunk-index]')?.getAttribute('data-hunk-index') ?? Number.NaN);
    const current = Number.isNaN(focused) ? activeHunk : focused;
    const count = selected.diff.hunks.length;
    event.preventDefault();
    if (action === 'next' || action === 'prev') {
      const next = moveHunk(current, action === 'next' ? 1 : -1, count);
      if (next < 0) return;
      setActiveHunk(next);
      const element = listRef.current?.querySelector<HTMLElement>(`[data-hunk-index="${next}"]`);
      element?.focus();
      element?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (current < 0 || current >= count) return;
    const actions = fileActions(selected.file, state);
    if (action === 'accept' && actions.acceptHunk) acceptHunkAt(selected, current);
    if (action === 'reject' && actions.rejectHunk) void rejectHunkAt(selected, current);
  };

  const limitText = (limit: ReviewLimitation) => {
    const key = `review_limit_${limit.code}`;
    return hasTranslation(key) ? t(key) : limit.message;
  };

  return (
    <TabBody label={t('review_region')} testId="review-tab">
      {!selectedTaskId ? <EmptyBlock icon={FileSearch} title={t('review_no_task')} />
        : reviewQuery.error && !snapshot ? <ErrorLine message={t('review_error', { message: reviewQuery.error.message })} />
        : !snapshot ? <LoadingLine text={t('review_loading')} />
        : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p data-testid="review-summary" className="text-[13px] text-muted">{t('review_summary', { files: items.length, pending })}</p>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="quiet" disabled={busy || reviewQuery.isFetching} onClick={() => void reload()}><RefreshCw className="h-3.5 w-3.5" />{t('review_reload')}</Button>
                <Button size="sm" variant="secondary" disabled={busy || acceptPlan.files + acceptPlan.hunks === 0} onClick={() => setConfirm('accept')}><CheckCheck className="h-3.5 w-3.5" />{t('review_accept_all')}</Button>
                <Button size="sm" variant="danger" disabled={busy || rejectPlan.rewrite + rejectPlan.created === 0} onClick={() => setConfirm('reject')}><Undo2 className="h-3.5 w-3.5" />{t('review_reject_all')}</Button>
                <Button size="sm" variant="danger" disabled={busy || flow.running || state === 'policy' || items.length === 0} title={flow.running ? t('rollback_undo_blocked') : undefined} onClick={() => void undoAll()} data-testid="review-undo-all"><RotateCcw className="h-3.5 w-3.5" />{t('rollback_undo_task')}</Button>
              </div>
            </div>

            {status && <p role="status" aria-live="polite" data-testid="review-status" data-tone={status.tone}
              className={status.tone === 'warn' ? 'rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-warning' : 'rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-success'}>{status.text}</p>}
            <LastRestoreBar onOutcome={(outcome) => { setStatus(statusOf(outcome, t('rollback_task_nothing'))); void reload(); }} />
            {snapshot.limitations.map((limit) => <p key={limit.code} role="note" data-testid="review-limitation" data-code={limit.code} className="rounded-lg border border-line bg-surface px-3 py-2 text-[12px] leading-5 text-muted">{limitText(limit)}</p>)}
            {snapshot.omitted.protected > 0 && <p role="note" data-testid="review-protected" className="text-[12px] text-faint">{t('review_protected', { count: snapshot.omitted.protected })}</p>}

            {items.length === 0 ? <EmptyBlock icon={FileSearch} title={t('review_empty')} /> : (
              <>
                <div className="max-h-60 overflow-y-auto"><ReviewFileList items={items} selectedPath={selected?.file.path ?? ''} onSelect={setSelectedPath} /></div>
                {selected && (
                  <ReviewFileView item={selected} state={state} busy={busy} activeHunk={activeHunk} listRef={listRef} onActivateHunk={setActiveHunk} onKeyDown={onKeyDown}
                    onAcceptHunk={(index) => acceptHunkAt(selected, index)} onRejectHunk={(index) => void rejectHunkAt(selected, index)}
                    onAcceptFile={() => void acceptFile(selected)} onRejectFile={() => void rejectFile(selected)} />
                )}
              </>
            )}
          </>
        )}
      <ReviewConfirm kind={confirm} accept={acceptPlan} reject={rejectPlan} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => void confirmAll()} />
    </TabBody>
  );
}
