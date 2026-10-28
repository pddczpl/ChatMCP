// Keeps the list of UI production packages in THIRD-PARTY-NOTICES.md equal to the lockfile.
//
//   node scripts/generate-licenses.mjs           rewrite the generated section of THIRD-PARTY-NOTICES.md
//   node scripts/generate-licenses.mjs --check   exit 1 when the section differs from what the lockfile says
//
// The source is DATGOLD-HUB/ui/package-lock.json, not node_modules: every entry that is not "dev": true is part of the production closure
// that the Vite build can compile into web/dist (docs/LICENSE-SCAN.md uses the same definition). It is an upper bound, because tree
// shaking drops what is not imported. The old version of this script read only the direct dependencies of ui/package.json out of
// node_modules and listed the development tools as if they were bundled.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICES_FILE = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
export const LOCKFILE = path.join(ROOT, 'DATGOLD-HUB', 'ui', 'package-lock.json');
export const BEGIN = '<!-- BEGIN GENERATED: ui-production-packages (scripts/generate-licenses.mjs) -->';
export const END = '<!-- END GENERATED: ui-production-packages -->';

/** @returns {{name: string, version: string, license: string}[]} the production closure, sorted by name then version */
export function productionPackages(lock) {
  const found = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key || entry.dev) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    found.push({ name, version: String(entry.version), license: String(entry.license ?? 'UNKNOWN') });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en', { numeric: true }));
}

export function renderSection(packages) {
  const counts = new Map();
  for (const item of packages) counts.set(item.license, (counts.get(item.license) ?? 0) + 1);
  const summary = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([license, count]) => `${license} ${count}`).join(', ');
  return [
    BEGIN,
    `${packages.length} packages of the production dependency closure of DATGOLD-HUB/ui/package-lock.json (${summary}). Tree shaking means web/dist contains only the parts that are imported, so this list is an upper bound. The license is the \`license\` field of the lockfile entry.`,
    '',
    '| Package | Version | License |',
    '|---|---|---|',
    ...packages.map((item) => `| \`${item.name}\` | ${item.version} | ${item.license} |`),
    END,
  ].join('\n');
}

/** Replaces the text between the markers (markers included). */
export function applySection(document, section) {
  const start = document.indexOf(BEGIN);
  const end = document.indexOf(END);
  if (start < 0 || end < start) throw new Error(`THIRD-PARTY-NOTICES.md must contain the lines ${BEGIN} and ${END}`);
  return document.slice(0, start) + section + document.slice(end + END.length);
}

export async function expectedDocument({ notices = NOTICES_FILE, lockfile = LOCKFILE } = {}) {
  const lock = JSON.parse(await fs.readFile(lockfile, 'utf8'));
  const current = (await fs.readFile(notices, 'utf8')).replace(/\r\n/g, '\n');
  return { current, expected: applySection(current, renderSection(productionPackages(lock))) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { current, expected } = await expectedDocument();
  if (process.argv.includes('--check')) {
    if (current !== expected) {
      console.error('THIRD-PARTY-NOTICES.md is out of date with DATGOLD-HUB/ui/package-lock.json; run: node scripts/generate-licenses.mjs');
      process.exit(1);
    }
    console.log('THIRD-PARTY-NOTICES.md lists the production packages of the lockfile.');
  } else {
    await fs.writeFile(NOTICES_FILE, expected, 'utf8');
    console.log(`Updated the generated section of THIRD-PARTY-NOTICES.md (${expected === current ? 'no change' : 'changed'}).`);
  }
}
