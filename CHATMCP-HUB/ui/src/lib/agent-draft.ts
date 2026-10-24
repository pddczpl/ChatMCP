// What the Hub refuses in a group of helpers or a set of coding tasks (a bad id, an unknown dependency, a loop, too long a text) is checked in
// the form first, so that the owner is told which field to fix instead of getting a 400 after pressing start. The limits are the Hub's own
// (lib/studio-delegates.mjs for helpers, lib/coding-orchestrator.mjs and lib/coding-task-dag.mjs for coding tasks); the Hub still checks.

export interface DraftLimits {
  maxItems: number;
  maxDeps: number;
  textMax: number;
  idPattern: RegExp;
}

export const GROUP_LIMITS: DraftLimits = { maxItems: 8, maxDeps: 7, textMax: 500, idPattern: /^[a-z][a-z0-9_-]{0,31}$/ };
export const CODING_LIMITS: DraftLimits = { maxItems: 4, maxDeps: 3, textMax: 3000, idPattern: /^[a-z][a-z0-9-]{0,30}$/ };

export type DraftField = 'id' | 'text' | 'deps' | 'list';
export type DraftIssueCode = 'empty' | 'invalid' | 'duplicate' | 'unknown' | 'self' | 'too_many' | 'too_long' | 'cycle';

export interface DraftIssue {
  /** The item the issue belongs to; for a list that is too long, the first item beyond the limit. */
  index: number;
  field: DraftField;
  code: DraftIssueCode;
  /** The limit, for too_long and too_many. */
  max?: number;
  /** The id that is not a task of the draft, for unknown. */
  detail?: string;
}

interface DraftItem { id: string; dependsOn?: string[]; prompt?: string; question?: string }

/** "plan, research" -> ['plan', 'research']: trimmed, no blanks, each id once. */
export const parseDeps = (raw: string): string[] => [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];

export function draftIssues(items: DraftItem[], limits: DraftLimits): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (items.length === 0) return [{ index: 0, field: 'list', code: 'empty' }];
  if (items.length > limits.maxItems) issues.push({ index: limits.maxItems, field: 'list', code: 'too_many', max: limits.maxItems });

  const seen = new Set<string>();
  items.forEach((item, index) => {
    const id = String(item.id ?? '');
    if (!limits.idPattern.test(id)) issues.push({ index, field: 'id', code: 'invalid' });
    else if (seen.has(id)) issues.push({ index, field: 'id', code: 'duplicate' });
    seen.add(id);
    const text = String(item.prompt ?? item.question ?? '');
    if (!text.trim()) issues.push({ index, field: 'text', code: 'empty' });
    else if (text.length > limits.textMax) issues.push({ index, field: 'text', code: 'too_long', max: limits.textMax });
  });

  const known = new Set(items.map((item) => String(item.id ?? '')));
  const edges = new Map<string, string[]>();
  items.forEach((item, index) => {
    const id = String(item.id ?? '');
    const deps = item.dependsOn ?? [];
    if (deps.length > limits.maxDeps) issues.push({ index, field: 'deps', code: 'too_many', max: limits.maxDeps });
    if (new Set(deps).size !== deps.length) issues.push({ index, field: 'deps', code: 'duplicate' });
    for (const dep of deps) {
      if (dep === id) issues.push({ index, field: 'deps', code: 'self' });
      else if (!known.has(dep)) issues.push({ index, field: 'deps', code: 'unknown', detail: dep });
    }
    if (!edges.has(id)) edges.set(id, deps.filter((dep) => dep !== id && known.has(dep)));
  });

  // A task is in a loop when it can reach itself by following what it waits for.
  const reaches = (from: string, target: string, visited = new Set<string>()): boolean => {
    for (const next of edges.get(from) ?? []) {
      if (next === target) return true;
      if (!visited.has(next)) { visited.add(next); if (reaches(next, target, visited)) return true; }
    }
    return false;
  };
  items.forEach((item, index) => { if (reaches(String(item.id ?? ''), String(item.id ?? ''))) issues.push({ index, field: 'deps', code: 'cycle' }); });
  return issues;
}
