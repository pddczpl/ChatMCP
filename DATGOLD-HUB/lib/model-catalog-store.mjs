// The list of models the Hub knows, kept up to date when its owner asks. The Hub ships with a dated snapshot of https://models.dev/api.json (lib/model-catalog.data.json). This store is the one
// other source: a newer snapshot the owner had the Hub fetch (Settings, AI model, "Update the list"), kept in the Hub's data folder, used from then on and at every start.
//
// What it promises, and what the tests hold it to (tests/verify-model-catalog-refresh.mjs):
//   * Nothing is fetched unless the owner asks. There is no timer, no check at start and no check when a model is chosen.
//   * One request, to models.dev (lib/model-catalog-build.mjs checkedSourceUrl): no key, no cookie, no body, no identity of the person, no redirect, a time limit and a size limit.
//   * What comes back is checked before it replaces anything: it must be the catalog (validateRaw), must build a snapshot that can be read (checkSnapshot) and is written whole
//     (a temporary file renamed over the old one). Anything else leaves the list in use, and the file, exactly as they were, and the owner is told why.
//   * A file in the data folder is not trusted either: damaged, edited, older than the snapshot that ships (a newer Hub came with a newer one) or dated in the future, it is ignored, with the reason.
//   * Two refreshes at once make one request.
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './fs-safe.mjs';
import { MAX_DOWNLOAD_BYTES, SOURCE_URL, checkSnapshot, checkedSourceUrl, compactCatalog, fetchRawCatalog, snapshotIsIntact, validateRaw } from './model-catalog-build.mjs';
import { bundledSnapshot, catalogInfo, catalogSource, createCatalog, resetCatalog, useCatalog } from './model-catalog.mjs';

const FILE_NAME = 'model-catalog.json';
const DAY_MS = 86400000;

/**
 * @param {{directory: string, fetchImpl?: typeof fetch, url?: string, now?: () => Date, maxBytes?: number, timeoutMs?: number}} options
 *   `url` and `fetchImpl` are for tests and a mirror on this machine; the Hub itself uses neither.
 */
export function createCatalogStore({ directory, fetchImpl = fetch, url = SOURCE_URL, now = () => new Date(), maxBytes = MAX_DOWNLOAD_BYTES, timeoutMs } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('A model catalog store needs the folder of the Hub\'s data.');
  const source = checkedSourceUrl(url);
  const file = path.join(directory, FILE_NAME);
  const today = () => now().toISOString().slice(0, 10);
  let ignored = null;
  let lastRefresh = null;
  let inFlight = null;
  let bundledSummary = null;

  const bundled = () => {
    if (!bundledSummary) { const info = createCatalog(bundledSnapshot()).info(); bundledSummary = { generatedAt: info.generatedAt, models: info.models }; }
    return bundledSummary;
  };

  function status() {
    const info = catalogInfo();
    return { source: catalogSource(), label: info.label, generatedAt: info.generatedAt, ageDays: info.ageDays, providers: info.providers, models: info.models, url: source,
      refreshing: inFlight !== null, ignored, lastRefresh, bundled: bundled() };
  }

  /** Read the refreshed snapshot from the data folder, if there is one the Hub can use; otherwise the snapshot that ships answers, and `ignored` says why a file was not used. */
  async function load() {
    ignored = null;
    resetCatalog();
    let text;
    try {
      const info = await stat(file);
      if (info.size > maxBytes) { ignored = { reason: 'damaged', detail: `The file is larger than ${maxBytes} bytes.` }; return status(); }
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') ignored = { reason: 'damaged', detail: `The file could not be read (${error?.code ?? 'error'}).` };
      return status();
    }
    let snapshot;
    try {
      snapshot = JSON.parse(text);
      checkSnapshot(snapshot);
      if (!snapshotIsIntact(snapshot)) throw new Error('Its hash does not match its content.');
      createCatalog(snapshot);
    } catch (error) {
      ignored = { reason: 'damaged', detail: String(error?.message ?? error).slice(0, 200) };
      return status();
    }
    if (snapshot.generatedAt < bundled().generatedAt) {
      ignored = { reason: 'older', detail: `It is dated ${snapshot.generatedAt}; the list that ships with the Hub is dated ${bundled().generatedAt}.` };
      return status();
    }
    // A clock a day off is not a reason to refuse one's own file; a date years ahead is.
    if (Date.parse(`${snapshot.generatedAt}T00:00:00Z`) > now().getTime() + DAY_MS) {
      ignored = { reason: 'future', detail: `It is dated ${snapshot.generatedAt}, which is after today.` };
      return status();
    }
    useCatalog(snapshot);
    return status();
  }

  const failure = (error) => Object.assign(error, { statusCode: error.statusCode ?? 502 });

  /** Fetch the list, check it, write it, use it. Resolves with the status; rejects (the list in use is unchanged) with an error that has a `code` and a message for the owner. */
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        // A machine whose clock is before the date of the list that ships would date the new list before the one it replaces, and the next start would ignore it as older: refused, before anything is downloaded.
        if (today() < bundled().generatedAt) {
          throw Object.assign(new Error(`The date of this machine (${today()}) is before the date of the list of models that ships with the Hub (${bundled().generatedAt}), so the new list would be dated before the one it replaces. Set the clock and try again.`), { code: 'catalog_clock', statusCode: 409 });
        }
        let raw;
        try { raw = await fetchRawCatalog({ fetchImpl, url: source, maxBytes, ...(timeoutMs ? { timeoutMs } : {}) }); } catch (error) { throw failure(error); }
        let snapshot;
        try {
          validateRaw(raw);
          snapshot = compactCatalog(raw, { generatedAt: today() });
          checkSnapshot(snapshot);
          createCatalog(snapshot);
        } catch (error) {
          throw Object.assign(new Error(String(error?.message ?? 'The answer is not the catalog.')), { code: 'catalog_unusable', statusCode: 502 });
        }
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFileAtomic(file, JSON.stringify(snapshot), { mode: 0o600 });
        } catch {
          throw Object.assign(new Error('The new list of models could not be saved in the Hub\'s folder; the list in use is unchanged.'), { code: 'catalog_write_failed', statusCode: 500 });
        }
        useCatalog(snapshot);
        ignored = null;
        lastRefresh = { at: now().toISOString(), ok: true };
        return { ...status(), refreshing: false }; // it is over when the caller reads this
      } catch (error) {
        lastRefresh = { at: now().toISOString(), ok: false, code: error?.code ?? 'catalog_error', error: String(error?.message ?? 'The refresh failed.').slice(0, 300) };
        throw error;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return { file, load, refresh, status };
}
