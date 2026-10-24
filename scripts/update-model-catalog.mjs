#!/usr/bin/env node
// Builds CHATMCP-HUB/lib/model-catalog.data.json, the compact snapshot of https://models.dev/api.json (MIT) that lib/model-catalog.mjs answers from.
//
//   node scripts/update-model-catalog.mjs                     download api.json (HTTPS to models.dev, 12 MiB cap, 30 s) and write the snapshot
//   node scripts/update-model-catalog.mjs --from api.json     build it from a file instead (what the tests do; no network)
//   node scripts/update-model-catalog.mjs --check [--max-age-days 90]   exit 1 when the snapshot is older than that (or damaged)
//   --out <file>                                              write somewhere else (the default is the snapshot of the Hub)
//
// The snapshot is a data file, not code: the Hub downloads nothing by itself. Its owner can ask it to update the list of models (Settings, AI model), which does what this script does
// into the Hub's data folder; this script is how the snapshot that ships with a release is made. The date in the file says how old the answers are, and `--check` is what a release
// gate can call. The building and the download are lib/model-catalog-build.mjs (shared with the Hub); the format is documented in lib/model-catalog.mjs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FLAG, FORMAT_VERSION, SOURCE_URL, ageInDays, compactCatalog, fetchRawCatalog, snapshotIsIntact, validateRaw } from '../CHATMCP-HUB/lib/model-catalog-build.mjs';

export { FLAG, FORMAT_VERSION, SOURCE_URL, ageInDays, compactCatalog, snapshotIsIntact, validateRaw };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_FILE = path.resolve(HERE, '..', 'CHATMCP-HUB', 'lib', 'model-catalog.data.json');

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export async function main(args = process.argv.slice(2), { now = new Date(), out = console.log } = {}) {
  const target = path.resolve(option(args, '--out') ?? SNAPSHOT_FILE);
  if (args.includes('--check')) {
    const maxAge = Number(option(args, '--max-age-days') ?? 90);
    if (!existsSync(target)) { out(`No snapshot at ${target}.`); return 1; }
    const snapshot = JSON.parse(readFileSync(target, 'utf8'));
    if (!snapshotIsIntact(snapshot)) { out('The snapshot does not match its own hash: it was edited by hand or damaged.'); return 1; }
    const age = ageInDays(snapshot, now);
    out(`Model catalog snapshot of ${snapshot.generatedAt}: ${age} days old (limit ${maxAge}).`);
    return age > maxAge ? 1 : 0;
  }
  const from = option(args, '--from');
  const raw = from ? JSON.parse(readFileSync(path.resolve(from), 'utf8')) : await fetchRawCatalog();
  const generatedAt = option(args, '--date') ?? now.toISOString().slice(0, 10);
  const snapshot = compactCatalog(raw, { generatedAt });
  writeFileSync(target, JSON.stringify(snapshot));
  out(`Wrote ${target}: ${Object.keys(snapshot.providers).length} providers, ${snapshot.rows.length} distinct rows, dated ${generatedAt}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
}
