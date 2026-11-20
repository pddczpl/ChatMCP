// The owner's list of trusted acceptance files (docs/PROOF-ACCEPTANCE.md, plan task pod-20): `<hubDir>/proof/trusted-acceptance.json`.
//
// A check of `.chatmcp/acceptance.yml` may run only when the sha256 of the exact bytes of that file is in this list, put there after the
// owner approved it. The file lives in the Hub's data folder, which the agent's tools cannot write. The format is
//   {"version": 1, "trusted": {"<sha256 hex>": {"approvedBy": "<who>", "at": "<ISO time>"}}}
// and it is read strictly: anything else (bad JSON, another version, an extra key, a key that is not a digest, an entry without its two
// fields, more than 1 MiB, a folder in its place) makes the WHOLE file "nothing trusted" - never "all trusted". Writes are atomic
// (temporary file + rename) and serialised per file inside the process, so concurrent trust/revoke calls all land and the file is always
// valid JSON. Trusting over a corrupt file moves it aside (`trusted-acceptance.corrupt-<time>-<n>.json`) for the owner to look at.
//
// The approval dialog of the app and `chatmcp verify trust` that call trust() come later (plan tasks pod-24 and pod-34).
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../fs-safe.mjs';

export const TRUST_FILE = path.join('proof', 'trusted-acceptance.json');
export const TRUST_STORE_MAX_BYTES = 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_APPROVED_BY = 200;

/** Lower-case hex digest, or null when `value` is not a sha256 hex digest. */
const digestOf = (value) => (typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const sameKeys = (object, keys) => {
  const own = Object.keys(object);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(object, key));
};

/** The entries of a store text, or null when the text is not exactly a valid store. */
function entriesOf(text) {
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return null; }
  if (!isPlainObject(data) || !sameKeys(data, ['version', 'trusted']) || data.version !== 1 || !isPlainObject(data.trusted)) return null;
  const entries = new Map();
  for (const [digest, entry] of Object.entries(data.trusted)) {
    if (!DIGEST.test(digest) || !isPlainObject(entry) || !sameKeys(entry, ['approvedBy', 'at'])) return null;
    if (typeof entry.approvedBy !== 'string' || !entry.approvedBy.trim() || entry.approvedBy.length > MAX_APPROVED_BY) return null;
    if (typeof entry.at !== 'string' || Number.isNaN(Date.parse(entry.at))) return null;
    entries.set(digest, { approvedBy: entry.approvedBy, at: entry.at });
  }
  return entries;
}

/** {entries, state: 'missing' | 'valid' | 'corrupt'}; a corrupt store has no entries. */
async function load(file) {
  let bytes;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > TRUST_STORE_MAX_BYTES) return { entries: new Map(), state: 'corrupt' };
    bytes = await fs.readFile(file);
  } catch (error) {
    return { entries: new Map(), state: error?.code === 'ENOENT' ? 'missing' : 'corrupt' };
  }
  if (bytes.length > TRUST_STORE_MAX_BYTES) return { entries: new Map(), state: 'corrupt' };
  const entries = entriesOf(bytes.toString('utf8'));
  return entries ? { entries, state: 'valid' } : { entries: new Map(), state: 'corrupt' };
}

async function save(file, entries) {
  const trusted = {};
  for (const digest of [...entries.keys()].sort()) trusted[digest] = entries.get(digest);
  await writeFileAtomic(file, `${JSON.stringify({ version: 1, trusted }, null, 2)}\n`, { mode: 0o600 });
}

// One queue per store file for the whole process: two store objects on the same folder still take turns.
const queues = new Map();
function serialised(file, task) {
  const run = (queues.get(file) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  queues.set(file, tail);
  tail.then(() => { if (queues.get(file) === tail) queues.delete(file); });
  return run;
}

/**
 * The trust store of the Hub whose data folder is `hubDir` (absolute). isTrusted() reads the file every time, so a revoke by another
 * process counts at once.
 */
export function createTrustStore(hubDir) {
  if (typeof hubDir !== 'string' || !path.isAbsolute(hubDir)) throw new TypeError('createTrustStore needs the absolute data folder of the Hub.');
  const file = path.join(hubDir, TRUST_FILE);
  const lock = (task) => serialised(file, task);
  const requireDigest = (sha256) => {
    const digest = digestOf(sha256);
    if (!digest) throw new TypeError('A sha256 hex digest (64 characters) is required.');
    return digest;
  };
  return {
    file,

    /** True only when the store is valid and holds `sha256`. */
    async isTrusted(sha256) {
      const digest = digestOf(sha256);
      if (!digest) return false;
      return (await load(file)).entries.has(digest);
    },

    /** Records the owner's approval of the file whose sha256 is given. `at` is a Date or an ISO time; it defaults to now. */
    async trust(sha256, { approvedBy, at = new Date() } = {}) {
      const digest = requireDigest(sha256);
      if (typeof approvedBy !== 'string' || !approvedBy.trim() || approvedBy.length > MAX_APPROVED_BY) {
        throw new TypeError(`approvedBy must name who approved, in 1 to ${MAX_APPROVED_BY} characters.`);
      }
      const time = at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : Number.NaN;
      if (Number.isNaN(time)) throw new TypeError('at must be a Date or an ISO time.');
      const entry = { approvedBy, at: new Date(time).toISOString() };
      return lock(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const current = await load(file);
        if (current.state === 'corrupt') {
          const aside = path.join(path.dirname(file), `trusted-acceptance.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
          await fs.rename(file, aside);
        }
        current.entries.set(digest, entry);
        await save(file, current.entries);
        return { sha256: digest, ...entry };
      });
    },

    /** Removes the approval; true when there was one. A corrupt store trusts nothing, so there is nothing to revoke and it is left as it is. */
    async revoke(sha256) {
      const digest = requireDigest(sha256);
      return lock(async () => {
        const current = await load(file);
        if (!current.entries.has(digest)) return false;
        current.entries.delete(digest);
        await save(file, current.entries);
        return true;
      });
    },

    /** Every approval, ordered by digest. */
    async list() {
      const { entries } = await load(file);
      return [...entries.keys()].sort().map((digest) => ({ sha256: digest, ...entries.get(digest) }));
    },
  };
}
