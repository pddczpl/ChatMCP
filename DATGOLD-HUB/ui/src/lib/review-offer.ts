// When a turn changed files the conversation offers the Review tab, and the receipt of an edit links to it. Both are read from the tool calls the Hub recorded (what each call was about, and
// whether it went through), never from what the model said it did.
import type { ToolCall } from '@/types';
import { toolKind } from './tool-labels.ts';

const named = (value: unknown): string[] => (typeof value === 'string' && value !== '' ? [value] : []);
const listed = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(named) : []);

/** The files the edits of a conversation named, once each, in the order they came: calls that went through and are edits (write, edit, patch, delete, move, batch). */
export function editedPaths(calls: readonly Pick<ToolCall, 'name' | 'args' | 'status'>[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const call of calls ?? []) {
    if (call.status !== 'success' || toolKind(call.name) !== 'edit') continue;
    const args = call.args;
    for (const path of [...named(args?.path), ...listed(args?.paths), ...named(args?.source), ...named(args?.destination)]) seen.add(path);
  }
  return [...seen];
}

/**
 * Where the receipt of an edit leads: the file it changed, when it went through and the Hub made a checkpoint for that very call. A move leads to the file that is there to be reviewed
 * (its destination). Nothing else gets a link.
 */
export function receiptTarget(call: Pick<ToolCall, 'name' | 'args' | 'status' | 'checkpointId'> | undefined): { path: string } | null {
  if (!call || call.status !== 'success' || !call.checkpointId || toolKind(call.name) !== 'edit') return null;
  const args = call.args;
  const path = [...named(args?.path), ...named(args?.destination), ...listed(args?.paths)][0];
  return path ? { path } : null;
}

const slashes = (path: string) => path.replace(/\\/g, '/');

/**
 * The file of the review that a path written by the model stands for. The Hub's paths are relative to the workspace with forward slashes; the model may write the other slash, another case
 * (a Windows file system does not tell), a leading ./ or the whole path from the root of the drive. The case as written is tried first; a path that is longer than the file's matches the
 * file whose path it ends with (after a slash), the longest if there are several. That covers ./src/a.js and an absolute path alike.
 */
export function findReviewFile<T extends { path: string }>(files: readonly T[], wanted: string): T | undefined {
  const target = slashes(wanted);
  for (const fold of [false, true]) {
    const key = (path: string) => (fold ? slashes(path).toLowerCase() : slashes(path));
    const wantedKey = fold ? target.toLowerCase() : target;
    const exact = files.find((file) => key(file.path) === wantedKey);
    if (exact) return exact;
    const ending = files.filter((file) => wantedKey.endsWith(`/${key(file.path)}`)).sort((a, b) => b.path.length - a.path.length)[0];
    if (ending) return ending;
  }
  return undefined;
}
