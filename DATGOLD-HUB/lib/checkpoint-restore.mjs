// The engine under a checkpoint restore: which entries a request names, what each one would do, which ones are conflicts, and the all-or-nothing write.
//
// No Hub in here. An "entry" is one file as a checkpoint (or the baseline of a task) holds it: a copy to bring back (`kind: 'copy'`, with the sha of the copy) or a file
// that was not there (`kind: 'absent'`). StudioWorkspace reads the disk, asks this module what to do, makes the backup, and gives the operations back to applyRestore().
import { createHash, randomUUID } from 'node:crypto';
import nodeFs from 'node:fs/promises';
import path from 'node:path';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const fail = (code, message, statusCode, extra = {}) => Object.assign(new Error(message), { code, statusCode }, extra);

/**
 * The entries a request names, out of `held` (all the entries there are). `wanted` null or undefined means all of them, in the order they are held; a list gives them in the order
 * it was asked for, each once. Paths that are not held are returned as `unknown`, in the order asked, never skipped. `fold` is the comparison of two paths (lower case where the file
 * system ignores case); an entry keeps the spelling it is held with. The entries are copies.
 */
export function chooseEntries(held, wanted, fold = (value) => value) {
  const copy = (entry) => ({ ...entry });
  if (wanted === null || wanted === undefined) return { entries: held.map(copy), unknown: [] };
  const byKey = new Map(held.map((entry) => [fold(entry.path), entry]));
  const seen = new Set();
  const entries = [];
  const unknown = [];
  for (const requested of wanted) {
    const key = fold(String(requested));
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = byKey.get(key);
    if (entry) entries.push(copy(entry)); else unknown.push(requested);
  }
  return { entries, unknown };
}

const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : value ?? null);

/**
 * What each entry would do, given the sha each file has now (`observed`: path -> sha, null for a file that is not there) and the sha the person expects it to have (`expected`: an
 * object path -> sha or null, or null for a preview, which expects nothing).
 *   action: `unchanged` (the file is already what the entry says), `remove` (a file that should not be there is), `recreate` (a file that should be there is missing), `overwrite`.
 *   conflict: the file has to change and is not the one that was expected. A file that is already right is never a conflict, whatever was expected of it.
 *   missingExpected: nothing was said about this file (the caller refuses such a request).
 * The expectation must be the request's own property; a sha written in capitals is the same sha.
 */
export function classify(entries, observed, expected) {
  const asked = expected !== null && expected !== undefined;
  return entries.map((entry) => {
    const targetSha = entry.kind === 'copy' ? entry.sha256 : null;
    const currentSha = observed.get(entry.path) ?? null;
    const action = currentSha === targetSha ? 'unchanged' : targetSha === null ? 'remove' : currentSha === null ? 'recreate' : 'overwrite';
    const given = asked && Object.hasOwn(expected, entry.path);
    const expectedSha = given ? lower(expected[entry.path]) : undefined;
    return { ...entry, targetSha, currentSha, expectedSha, action, conflict: given && action !== 'unchanged' && expectedSha !== currentSha, missingExpected: asked && !given };
  });
}

/** What to do with classified rows: what to apply, what is already right, the conflicts, and whether the whole request stops for them (only `skip` goes on without them). */
export function planOutcome(rows, onConflict = 'abort') {
  const conflicts = rows.filter((row) => row.conflict);
  return {
    apply: rows.filter((row) => row.action !== 'unchanged' && !row.conflict),
    unchanged: rows.filter((row) => row.action === 'unchanged'),
    conflicts,
    abort: onConflict !== 'skip' && conflicts.length > 0,
  };
}

const same = (bytes, wanted) => (bytes === null || wanted === null ? bytes === wanted : sha(bytes) === sha(wanted));

async function readOrNull(io, file) {
  try { return await io.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function write(io, absolute, bytes) {
  await io.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  try {
    await io.writeFile(temporary, bytes, { flag: 'w', mode: 0o600 });
    await io.rename(temporary, absolute);
  } finally {
    await io.unlink(temporary).catch(() => {});
  }
}

/** Puts back, last first, what was done, but only a file that is still exactly what was written: a file somebody changed meanwhile is never overwritten. */
async function rollBack(done, io) {
  const rolledBack = [];
  const failedRollback = [];
  for (const op of [...done].reverse()) {
    try {
      if (!same(await readOrNull(io, op.absolute), op.next)) throw fail('rollback_conflict', 'File đã bị sửa trong lúc khôi phục; không ghi đè.', 409);
      if (op.previous === null) await io.unlink(op.absolute); else await write(io, op.absolute, op.previous);
      rolledBack.push(op.path);
    } catch (error) {
      failedRollback.push({ path: op.path, error: error.message });
    }
  }
  return { rolledBack, failedRollback };
}

/**
 * Does the operations, all or none. An operation is `{ path, absolute, action, previous, next }`: the bytes the file has now (null: not there) and the bytes it must have (null: not
 * there). Each file is read again just before it is written and must still be `previous`; each write goes through a temporary file and a rename. Afterwards every file is read back
 * and must be `next`. If anything fails the files already done are put back (see rollBack) and the error says which, as `rolledBack` and `failedRollback`:
 *   stale_state (409)             a file is no longer what it was when it was read
 *   restore_failed_rolled_back    a write or a removal failed, and everything done was put back
 *   restore_verify_failed         a file is not what was written when it is read back
 *   restore_partial_failure       and something could not be put back
 * `io` is the file system (fs/promises); a test hands in one that fails.
 */
export async function applyRestore(ops, io = nodeFs) {
  const done = [];
  let problem = null;
  let verification = false;
  try {
    for (const op of ops) {
      if (!same(await readOrNull(io, op.absolute), op.previous)) {
        throw fail('stale_state', `File "${op.path}" đã thay đổi trong lúc khôi phục (không còn là bản vừa xem); chưa ghi đè lên nó.`, 409);
      }
      if (op.next === null) await io.unlink(op.absolute); else await write(io, op.absolute, op.next);
      done.push(op);
    }
    const spoiled = [];
    for (const op of done) if (!same(await readOrNull(io, op.absolute), op.next)) spoiled.push(op.path);
    if (spoiled.length) {
      verification = true;
      throw fail('restore_verify_failed', `Sau khi ghi, file không khớp nội dung dự kiến: ${spoiled.join(', ')}. Các file còn lại đã được hoàn tác.`, 500);
    }
  } catch (error) {
    problem = error;
  }
  if (problem) {
    const { rolledBack, failedRollback } = await rollBack(done, io);
    const details = { rolledBack, failedRollback };
    if (failedRollback.length && !verification) {
      throw fail('restore_partial_failure', `Khôi phục thất bại: ${problem.message}. CẢNH BÁO: ${failedRollback.length} file không hoàn tác được: ${failedRollback.map((entry) => entry.path).join(', ')}.`, 500, details);
    }
    if (problem.code === 'stale_state' || verification) throw Object.assign(problem, details);
    throw fail('restore_failed_rolled_back', `Khôi phục thất bại: ${problem.message}. Toàn bộ ${rolledBack.length} file đã ghi đã được hoàn tác.`, 500, details);
  }
  return ops.map((op) => ({ path: op.path, action: op.action, sha256: op.next === null ? null : sha(op.next) }));
}
