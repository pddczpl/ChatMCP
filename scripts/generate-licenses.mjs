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

// ---------------------------------------------------------------------------------------------------------------------------------------
// The MCP client runtime (DATGOLD-HUB/runtimes/mcp, staged by scripts/mcp-runtime/stage.mjs): every package of its lockfile, with the
// licence of the lockfile entry, and the packages that @modelcontextprotocol/client compiles into its dist files (scripts/mcp-runtime/
// licenses/MANIFEST.json, whose texts are vendored). The same list is generated into THIRD-PARTY-NOTICES.md, DATGOLD-HUB/THIRD-PARTY-NOTICES.txt
// and docs/LICENSE-SCAN.md.
export const MCP_LOCKFILE = path.join(ROOT, 'scripts', 'mcp-runtime', 'package-lock.json');
export const MCP_BUNDLED = path.join(ROOT, 'scripts', 'mcp-runtime', 'licenses', 'MANIFEST.json');
const MCP_ID = 'mcp-runtime-packages';
const MCP_MARKERS = Object.freeze({
  markdown: [`<!-- BEGIN GENERATED: ${MCP_ID} (scripts/generate-licenses.mjs) -->`, `<!-- END GENERATED: ${MCP_ID} -->`],
  text: [`-- BEGIN GENERATED: ${MCP_ID} (scripts/generate-licenses.mjs) --`, `-- END GENERATED: ${MCP_ID} --`],
});
export const MCP_DOCUMENTS = Object.freeze([
  { label: 'THIRD-PARTY-NOTICES.md', relative: ['THIRD-PARTY-NOTICES.md'], kind: 'notices' },
  { label: 'DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', relative: ['DATGOLD-HUB', 'THIRD-PARTY-NOTICES.txt'], kind: 'text' },
  { label: 'docs/LICENSE-SCAN.md', relative: ['docs', 'LICENSE-SCAN.md'], kind: 'scan' },
]);

/** @returns {{name: string, version: string, license: string}[]} every package of the MCP runtime lockfile, sorted */
export function mcpRuntimePackages(lock) {
  const found = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key) continue;
    found.push({ name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length), version: String(entry.version), license: String(entry.license ?? 'UNKNOWN') });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

const countLicenses = (packages) => {
  const counts = new Map();
  for (const item of packages) counts.set(item.license, (counts.get(item.license) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([license, count]) => `${license} ${count}`).join(', ');
};

export function renderMcpSection(kind, packages, bundled) {
  const [begin, end] = kind === 'text' ? MCP_MARKERS.text : MCP_MARKERS.markdown;
  const folder = 'DATGOLD-HUB/runtimes/mcp/node_modules';
  const intro = `${packages.length} packages of scripts/mcp-runtime/package-lock.json (${countLicenses(packages)}), staged whole into ${folder}, each with its own licence file in its folder. The licence is the \`license\` field of the lockfile entry.`;
  const bundledIntro = `${bundled.length} packages compiled into the dist files of @modelcontextprotocol/client (${countLicenses(bundled)}). They are not packages of the lockfile and the client ships none of their texts; the texts are vendored in scripts/mcp-runtime/licenses/ and installed in DATGOLD-HUB/runtimes/mcp/licenses/bundled/.`;
  if (kind === 'text') {
    return [
      begin,
      `    ${intro.replaceAll('`', '')}`,
      ...packages.map((item) => `      ${item.name} ${item.version} - ${item.license}`),
      `    ${bundledIntro}`,
      ...bundled.map((item) => `      ${item.name} ${item.version} - ${item.license} - licenses/bundled/${item.file}`),
      end,
    ].join('\n');
  }
  const scan = kind === 'scan';
  const head = scan ? ['| Package | Version | Licence | Apache-2.0 compatible | Licence text |', '|---|---|---|---|---|'] : ['| Package | Version | License | License text in the installed copy |', '|---|---|---|---|'];
  const row = (item, where) => (scan ? `| \`${item.name}\` | ${item.version} | ${item.license} | Yes | ${where} |` : `| \`${item.name}\` | ${item.version} | ${item.license} | ${where} |`);
  return [
    begin,
    intro,
    '',
    ...head,
    ...packages.map((item) => row(item, `\`${folder}/${item.name}/\``)),
    '',
    bundledIntro,
    '',
    ...head,
    ...bundled.map((item) => row(item, `\`DATGOLD-HUB/runtimes/mcp/licenses/bundled/${item.file}\``)),
    end,
  ].join('\n');
}

function replaceMarked(document, [begin, end], section, label) {
  const start = document.indexOf(begin);
  const stop = document.indexOf(end);
  if (start < 0 || stop < start) throw new Error(`${label} must contain the lines ${begin} and ${end}`);
  return document.slice(0, start) + section + document.slice(stop + end.length);
}

/** The three documents as they are and as the MCP runtime lockfile and the bundled manifest say they must be. */
export async function expectedMcpDocuments({ root = ROOT } = {}) {
  const lock = JSON.parse(await fs.readFile(path.join(root, 'scripts', 'mcp-runtime', 'package-lock.json'), 'utf8'));
  const bundled = JSON.parse(await fs.readFile(path.join(root, 'scripts', 'mcp-runtime', 'licenses', 'MANIFEST.json'), 'utf8')).packages;
  const packages = mcpRuntimePackages(lock);
  const documents = [];
  for (const document of MCP_DOCUMENTS) {
    const file = path.join(root, ...document.relative);
    const current = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    const markers = document.kind === 'text' ? MCP_MARKERS.text : MCP_MARKERS.markdown;
    documents.push({ label: document.label, file, current, expected: replaceMarked(current, markers, renderMcpSection(document.kind, packages, bundled), document.label) });
  }
  return documents;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { current, expected } = await expectedDocument();
  const mcp = await expectedMcpDocuments();
  if (process.argv.includes('--check')) {
    let stale = false;
    if (current !== expected) {
      console.error('THIRD-PARTY-NOTICES.md is out of date with DATGOLD-HUB/ui/package-lock.json; run: node scripts/generate-licenses.mjs');
      stale = true;
    }
    for (const document of mcp) {
      if (document.current !== document.expected) {
        console.error(`${document.label} is out of date with scripts/mcp-runtime (package-lock.json, licenses/MANIFEST.json); run: node scripts/generate-licenses.mjs`);
        stale = true;
      }
    }
    if (stale) process.exit(1);
    console.log('THIRD-PARTY-NOTICES.md lists the production packages of the UI lockfile, and the three notice documents list the MCP client runtime.');
  } else {
    // The UI section and the MCP section of THIRD-PARTY-NOTICES.md are applied one after the other to the same text.
    let notices = expected;
    for (const document of mcp) {
      const text = document.label === 'THIRD-PARTY-NOTICES.md' ? replaceMarked(notices, MCP_MARKERS.markdown, document.expected.slice(document.expected.indexOf(MCP_MARKERS.markdown[0]), document.expected.indexOf(MCP_MARKERS.markdown[1]) + MCP_MARKERS.markdown[1].length), document.label) : document.expected;
      if (document.label === 'THIRD-PARTY-NOTICES.md') notices = text;
      else await fs.writeFile(document.file, text, 'utf8');
    }
    await fs.writeFile(NOTICES_FILE, notices, 'utf8');
    console.log(`Updated the generated sections of THIRD-PARTY-NOTICES.md, DATGOLD-HUB/THIRD-PARTY-NOTICES.txt and docs/LICENSE-SCAN.md (${expected === current && mcp.every((document) => document.current === document.expected) ? 'no change' : 'changed'}).`);
  }
}
