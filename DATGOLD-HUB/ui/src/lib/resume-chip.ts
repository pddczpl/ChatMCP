// What the chip beside the model profile says about how the latest run of a conversation started (P9 ac-18, docs/SESSION-RESUME.md): from the conversation's real
// history, replayed from the Hub's journal ('transcript'), or from the checkpoint summary because the journal could not be used ('checkpoint'). Plain functions, so a
// test can pin the words. The numbers are the Hub's (task.resume, counted by its loader); this file only prints them. A call with no recorded result or an unverified
// operation asks for attention: the run went on without knowing what that call did.
import { translate } from './i18n.ts';
import type { ResumeMode, Task } from '../types/index';

export type Lang = 'vi' | 'en';

export interface ResumeChipView {
  mode: ResumeMode;
  /** The chip's own text: the mode, then for a transcript the items replayed and the calls with no recorded result. */
  text: string;
  /** Every number, on hover. */
  title: string;
  /** A prior call has no recorded result, or an operation is unverified. */
  attention: boolean;
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/** A size in bytes, in B, KB or MB (1,024 apart), with the decimal mark of the language. */
export function formatSize(bytes: number | undefined | null, lang: Lang): string {
  const value = count(bytes);
  const number = (amount: number) => new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'vi-VN', { maximumFractionDigits: 1 }).format(amount);
  if (value < 1024) return `${number(value)} B`;
  if (value < 1024 * 1024) return `${number(value / 1024)} KB`;
  return `${number(value / (1024 * 1024))} MB`;
}

/** The chip of a task whose latest run continued an earlier one; null for one that did not (or a mode this page does not know). */
export function describeResume(task: Pick<Task, 'resumeMode' | 'resume'> | null | undefined, lang: Lang): ResumeChipView | null {
  const resume = task?.resume;
  if (!resume || resume.mode !== task?.resumeMode) return null;
  const t = (key: string, params?: Record<string, string | number>) => translate(lang, key, params);
  const unverified = count(resume.unverified);
  if (resume.mode === 'checkpoint') {
    return {
      mode: 'checkpoint',
      text: t('agents_conv_resume_checkpoint'),
      title: t('agents_conv_resume_title_checkpoint', { reason: String(resume.reason ?? ''), size: formatSize(resume.bytes, lang), unverified }),
      attention: unverified > 0,
    };
  }
  if (resume.mode !== 'transcript') return null;
  const items = count(resume.items);
  const noResult = count(resume.noResultCalls);
  const parts = [t('agents_conv_resume_transcript'), t(items === 1 ? 'agents_conv_resume_items_one' : 'agents_conv_resume_items_other', { count: items })];
  if (noResult > 0) parts.push(t(noResult === 1 ? 'agents_conv_resume_no_result_one' : 'agents_conv_resume_no_result_other', { count: noResult }));
  return {
    mode: 'transcript',
    text: parts.join(' · '),
    title: t('agents_conv_resume_title_transcript', {
      items, size: formatSize(resume.bytes, lang), tail: count(resume.droppedTailItems), old: count(resume.droppedOldItems),
      summary: t(resume.summaryUsed ? 'agents_conv_resume_yes' : 'agents_conv_resume_no'), noResult, unverified,
    }),
    attention: noResult > 0 || unverified > 0,
  };
}
