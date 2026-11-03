// The marks a person makes with "accept" on the hunks of one file: local review state. They are not in the file and not in the Hub. They are kept in the browser, under one key, by
// conversation, file and the sha the file had when it was reviewed, so that a reload keeps them and any other change of the file starts again. Storage can be missing, full or blocked
// (a private window): nothing here throws, and a write that fails only means the marks last until the page is closed.
export const ACCEPTED_STORAGE_KEY = 'chatmcp:review-accepted';
/** Entries kept in all: a person reviews a few files at a time, and the oldest marks are the ones nobody comes back to. */
export const MAX_ENTRIES = 200;
const FINGERPRINT = /^[0-9a-f]{16}$/;

/** The part of `Storage` that is used, so that a test can bring a map instead of a browser. */
export interface MarkStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

interface Entry { task: string; path: string; sha: string; at: number; marks: string[] }

const isFingerprint = (value: unknown): value is string => typeof value === 'string' && FINGERPRINT.test(value);

const readEntries = (store: MarkStore | null | undefined): Entry[] => {
  try {
    const text = store?.getItem(ACCEPTED_STORAGE_KEY);
    if (!text) return [];
    const parsed = JSON.parse(text);
    if (parsed?.v !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .filter((entry: any) => entry && typeof entry.task === 'string' && typeof entry.path === 'string' && typeof entry.sha === 'string' && typeof entry.at === 'number' && Array.isArray(entry.marks))
      .map((entry: any) => ({ task: entry.task, path: entry.path, sha: entry.sha, at: entry.at, marks: entry.marks.filter(isFingerprint) }));
  } catch {
    return [];
  }
};

/** The hunks accepted in this conversation for this file as it is now (this sha). Another sha, another file or another conversation reads nothing. */
export function readMarks(store: MarkStore | null | undefined, task: string, path: string, sha: string | null): ReadonlySet<string> {
  const entry = readEntries(store).find((candidate) => candidate.task === task && candidate.path === path && candidate.sha === sha);
  return new Set(entry?.marks ?? []);
}

/**
 * Remembers the marks of a file at this sha. What was kept for the same file at any other sha goes: the file has changed, and a mark is only good for the file it was made on.
 * No marks takes the entry away. Answers whether the write went through.
 */
export function writeMarks(store: MarkStore | null | undefined, task: string, path: string, sha: string | null, marks: ReadonlySet<string>, now: number = Date.now()): boolean {
  if (!store || !sha) return false;
  const kept = readEntries(store).filter((entry) => !(entry.task === task && entry.path === path));
  const valid = [...marks].filter(isFingerprint).sort();
  if (valid.length) kept.push({ task, path, sha, at: now, marks: valid });
  const entries = kept.sort((a, b) => a.at - b.at).slice(-MAX_ENTRIES);
  try {
    store.setItem(ACCEPTED_STORAGE_KEY, JSON.stringify({ v: 1, entries }));
    return true;
  } catch {
    return false;
  }
}

/** After the page changed a file itself (put a hunk back), the marks of the hunks that are still there go on to the new sha; a mark for a hunk that is gone is dropped. */
export function carryMarks(marks: ReadonlySet<string>, hunks: readonly { fingerprint: string }[]): ReadonlySet<string> {
  return new Set([...marks].filter((mark) => hunks.some((hunk) => hunk.fingerprint === mark)));
}
