// What the acceptance panel can suggest. What is accepted is decided by the Hub (lib/objective-acceptance.mjs: a criterion is matched to a fresh receipt the Hub itself recorded, and only the owner's
// confirmation writes it). This says which receipt the owner is most likely to choose, and in what order a whole plan can be confirmed, so that the owner reads a receipt that is already chosen
// and confirms it, instead of building the choice from an empty list for every criterion of every objective. Nothing here accepts anything.

export type ReceiptKind = 'inspect' | 'edit' | 'verify' | 'review';

export interface Receipt {
  receiptId: string;
  kind: ReceiptKind;
  step: number;
  path?: string;
}

export interface PlanObjective {
  id: string;
  status: string;
  dependsOn?: string[];
  acceptanceCriteria: string[];
  evidence?: Array<{ criterionIndex: number; receiptId: string }>;
}

export interface Suggestion {
  objectiveId: string;
  criterionIndex: number;
  receipt: Receipt;
}

/** The kind of receipt a criterion is matched to: the Hub's acceptanceKind (lib/objective-acceptance.mjs); a test holds the two together. */
export const kindFor = (criterion: string): 'inspect' | 'edit' | 'verify' | null =>
  criterion.startsWith('Observe workspace evidence') ? 'inspect'
    : criterion.startsWith('If code changes') ? 'edit'
      : criterion.startsWith('Run required supported checks') ? 'verify'
        : null;

/** The latest receipt of the kind the criterion needs: the one most likely to be still current after the edits. A criterion no receipt can match has none. */
export function suggestReceipt(criterion: string, receipts: Receipt[]): Receipt | null {
  const kind = kindFor(criterion);
  if (!kind) return null;
  let best: Receipt | null = null;
  for (const receipt of receipts) if (receipt.kind === kind && (best === null || receipt.step >= best.step)) best = receipt;
  return best;
}

const matchedNow = (objective: PlanObjective, index: number, receipts: Receipt[]): boolean =>
  (objective.evidence ?? []).some((entry) => entry.criterionIndex === index && receipts.some((receipt) => receipt.receiptId === entry.receiptId));

/**
 * What "confirm all suggested" would send, in the order the Hub needs: the objectives in the order of the plan, each criterion that is not matched yet and has a suggestion. An objective is
 * only reached when every objective it depends on is verified already or is completed by the suggestions before it (the Hub refuses to accept a criterion of an objective whose predecessor is
 * not verified); an objective with a criterion that has no suggestion is left incomplete, and so are the ones that depend on it.
 */
export function pendingSuggestions(objectives: PlanObjective[], receipts: Receipt[]): Suggestion[] {
  const done = new Set(objectives.filter((objective) => objective.status === 'verified').map((objective) => objective.id));
  const suggestions: Suggestion[] = [];
  for (const objective of objectives) {
    if (done.has(objective.id)) continue;
    if ((objective.dependsOn ?? []).some((id) => !done.has(id))) continue;
    const criteria = objective.acceptanceCriteria ?? [];
    let completes = criteria.length > 0;
    criteria.forEach((criterion, criterionIndex) => {
      if (matchedNow(objective, criterionIndex, receipts)) return;
      const receipt = suggestReceipt(criterion, receipts);
      if (receipt) suggestions.push({ objectiveId: objective.id, criterionIndex, receipt });
      else completes = false;
    });
    if (completes) done.add(objective.id);
  }
  return suggestions;
}

export interface AcceptOutcome {
  /** How many criteria were accepted before the end or the first refusal. */
  done: number;
  failed?: { suggestion: Suggestion; error: unknown };
}

/**
 * Confirms the suggestions one after the other (each is the owner's confirmation: the call is made by the button that says so), with the receipt the owner chose for that criterion in the list
 * when there is one, else the suggested one. It stops at the first refusal of the Hub: what was accepted before stays accepted, and the rest is not tried on a plan the Hub has just said
 * is not as the page thought.
 */
export async function acceptInOrder(
  items: Suggestion[],
  chosen: Record<string, string>,
  accept: (item: { objectiveId: string; criterionIndex: number; receiptId: string }) => Promise<unknown>,
): Promise<AcceptOutcome> {
  let done = 0;
  for (const suggestion of items) {
    const receiptId = chosen[`${suggestion.objectiveId}:${suggestion.criterionIndex}`] || suggestion.receipt.receiptId;
    try {
      await accept({ objectiveId: suggestion.objectiveId, criterionIndex: suggestion.criterionIndex, receiptId });
      done += 1;
    } catch (error) {
      return { done, failed: { suggestion, error } };
    }
  }
  return { done };
}
