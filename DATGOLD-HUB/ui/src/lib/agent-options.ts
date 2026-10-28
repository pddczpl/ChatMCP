// What the page says about the owner's two agent options (Settings): from which percent of its budget the history is compacted, and whether the Hub itself matches the checks it ran.
// Plain functions, so a test can pin the words and the limits.
//
// The wording rule: turning the second one on RELAXES "only the owner accepts", and the page says so next to the switch and tags every criterion the Hub matched (its evidence says
// acceptedBy "auto_hub_check"); it is never drawn like the owner's own acceptance.
import type { AgentOptions } from '../types/index';

/** What the Hub writes as `acceptedBy` when it matched a check because the owner turned the option on; the owner's own click says "local_owner". */
export const AUTO_ACCEPTED_BY = 'auto_hub_check';

const DEFAULTS = { min: 50, max: 95, fallback: 80 } as const;

type Limits = Partial<Pick<AgentOptions, 'minCompactPercent' | 'maxCompactPercent'>> | null | undefined;

/** The percent that a field holds, as a whole number inside the Hub's limits, or null when it is not one (then nothing is sent). */
export function parsePercent(text: unknown, limits?: Limits): number | null {
  const trimmed = String(text ?? '').trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  const min = limits?.minCompactPercent ?? DEFAULTS.min;
  const max = limits?.maxCompactPercent ?? DEFAULTS.max;
  return value >= min && value <= max ? value : null;
}

export type PercentStatusKey = 'ao_percent_status_unknown' | 'ao_percent_status_default' | 'ao_percent_status_saved';

export interface OptionsView {
  /** The Hub has said what the options are; otherwise nothing can be changed. */
  known: boolean;
  /** The percent that applies now. */
  percent: number;
  statusKey: PercentStatusKey;
  /** The owner chose a percent: "use the default" does something. */
  canReset: boolean;
  defaultPercent: number;
  min: number;
  max: number;
  /** Whether the Hub accepts the checks it ran. */
  autoAccept: boolean;
}

export function describeOptions(options: AgentOptions | null | undefined): OptionsView {
  const known = Boolean(options) && typeof options!.autoCompactPercent === 'number' && typeof options!.autoAcceptChecks === 'boolean';
  if (!known) return { known: false, percent: DEFAULTS.fallback, statusKey: 'ao_percent_status_unknown', canReset: false, defaultPercent: DEFAULTS.fallback, min: DEFAULTS.min, max: DEFAULTS.max, autoAccept: false };
  const saved = typeof options!.autoCompactSaved === 'number';
  return {
    known: true,
    percent: options!.autoCompactPercent,
    statusKey: saved ? 'ao_percent_status_saved' : 'ao_percent_status_default',
    canReset: saved,
    defaultPercent: options!.defaultCompactPercent ?? DEFAULTS.fallback,
    min: options!.minCompactPercent ?? DEFAULTS.min,
    max: options!.maxCompactPercent ?? DEFAULTS.max,
    autoAccept: options!.autoAcceptChecks,
  };
}

/** Whether a criterion of the plan was matched by the Hub itself (the owner's option) and not by the owner's click. */
export function acceptedByHub(evidence: { acceptedBy?: string } | null | undefined): boolean {
  return evidence?.acceptedBy === AUTO_ACCEPTED_BY;
}
