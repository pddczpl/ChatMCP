// Text gate for false trust signals.
//
// v3.9.0 shipped words and flags that promised more than the product does: built-in skills marked "verified licence" and
// "redistributable" in a repository that has no LICENSE file, skill registries marked verified:true, an "MCP server" that is a
// prompt, "PageRank-style" ranking that is import counting, "sandbox" for things that are not one. This gate fails the build when
// such a claim comes back.
//
//   * forbidden phrases in what users read: lib (string literals and comments), ui/src (string literals, JSX text and comments),
//     the live documentation and the top-level security / notice / readme files. A sentence that NEGATES the word ("is not
//     tamper-proof", "not certified") is a correction, not a claim, and passes.
//   * "sandbox" is allowed only where it means something that exists here: Windows Sandbox, Docker, the sandbox-only policy,
//     `sed --sandbox`, the HTML iframe attribute, identifiers/paths that contain the word, or a negation.
//   * data: no built-in skill may carry a verified licence or be marked redistributable while the repository has no LICENSE file;
//     no skill source list may carry verified:true; a built-in may not call itself an MCP server.
//   * negative control: the same scanner is run over a temporary tree into which violations are inserted and must flag every one of
//     them (and must stay silent on the clean tree and on negated sentences).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKETPLACE_CATALOG, KNOWN_SKILL_SOURCES, PluginManager } from '../lib/plugins.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(hubRoot, '..');

// ------------------------------------------------------------------ the rules
const NEGATOR = /\b(?:not|no|nor|never|without|cannot|can't|isn't|aren't|doesn't|don't|neither|chưa|không)\b/i;
const FORBIDDEN = [
  { id: 'tamper-proof', pattern: /tamper[\s-]?proof/i, why: 'nothing here is tamper-proof; say tamper-evident and what it detects' },
  { id: 'certified', pattern: /\bcertified\b/i, why: 'no component of DatGold is certified by anyone' },
  { id: 'notary', pattern: /\bnotar(?:y|ize[ds]?|ise[ds]?|ization|isation)\b/i, why: 'no notarisation exists' },
  { id: 'pagerank', pattern: /PageRank-style/i, why: 'the repo map ranks by import counts, it is not PageRank' },
  { id: 'absolute-security', pattern: /\b(?:unhackable|unbreakable|military[\s-]grade|bulletproof)\b/i, why: 'absolute security claims' },
  { id: 'mcp-servers-label', pattern: /\bMCP Servers\b/, why: 'the skills catalog lists prompts, not MCP servers' },
];
const SANDBOX_WORD = /(?<![\w./$-])sandbox(?:es|ed|ing)?(?![\w./$-])/i;
const SANDBOX_CONTEXT = /windows[\s-]*sandbox|windowssandbox|docker|podman|container|sandbox-only|--sandbox|iframe|\bwsb\b/i;
const VERIFIED_TRUE = /\bverified\s*:\s*true\b/;

/** Splits text into sentences so that a negation only excuses its own sentence. */
const sentences = (text) => text.split(/(?<=[.!?;])\s+|\n/).filter(Boolean);

function judge(chunk, where, found) {
  for (const sentence of sentences(chunk)) {
    const negated = NEGATOR.test(sentence);
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(sentence) && !negated) found.push({ where, rule: rule.id, text: sentence.trim().slice(0, 140), why: rule.why });
    }
    if (SANDBOX_WORD.test(sentence) && !SANDBOX_CONTEXT.test(sentence) && !negated) {
      found.push({ where, rule: 'sandbox', text: sentence.trim().slice(0, 140), why: 'say Windows Sandbox or Docker, or do not call it a sandbox' });
    }
  }
}

/** String literals and comments of a source file (identifiers are not user-facing text). */
function codeChunks(text) {
  const chunks = [];
  const pattern = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1|\/\/([^\n]*)|\/\*([\s\S]*?)\*\//g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    chunks.push([match[2] ?? match[3] ?? match[4] ?? '', text.slice(0, match.index).split('\n').length]);
  }
  return chunks;
}
/** JSX text between tags: `<p>Certified sandbox</p>`. */
function jsxChunks(text) {
  const chunks = [];
  const pattern = />([^<>{}\n][^<>{}]*)</g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) chunks.push([match[1], text.slice(0, match.index).split('\n').length]);
  return chunks;
}

async function* walk(directory, skip = () => false) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (skip(full, entry)) continue;
    if (entry.isDirectory()) yield* walk(full, skip);
    else yield full;
  }
}

const HISTORICAL_DOC = /^(?:PHASE|UPGRADE|WINDOWS-SANDBOX-REAL|PHASE\d)/i;

/** @returns {Promise<{where: string, rule: string, text: string, why: string}[]>} */
export async function scanTree(repo) {
  const found = [];
  const hub = path.join(repo, 'CHATMCP-HUB');
  const rel = (file) => path.relative(repo, file).replaceAll('\\', '/');
  const skipDirectories = (full, entry) => entry.isDirectory() && ['node_modules', 'dist', '.git', 'agent-handoffs', 'evidence', 'runtimes'].includes(entry.name);

  for await (const file of walk(path.join(hub, 'lib'), skipDirectories)) {
    if (!/\.(?:mjs|js)$/.test(file)) continue;
    const text = await fs.readFile(file, 'utf8');
    for (const [chunk, line] of codeChunks(text)) judge(chunk, `${rel(file)}:${line}`, found);
  }
  for await (const file of walk(path.join(hub, 'ui', 'src'), skipDirectories)) {
    if (!/\.(?:ts|tsx)$/.test(file)) continue;
    const text = await fs.readFile(file, 'utf8');
    for (const [chunk, line] of [...codeChunks(text), ...(file.endsWith('.tsx') ? jsxChunks(text) : [])]) judge(chunk, `${rel(file)}:${line}`, found);
    if (VERIFIED_TRUE.test(text)) found.push({ where: rel(file), rule: 'verified-flag', text: 'verified: true', why: 'a source list or UI model may not carry a verified flag' });
  }
  const prose = [];
  for await (const file of walk(path.join(repo, 'docs'), skipDirectories)) {
    if (/\.md$/.test(file) && !HISTORICAL_DOC.test(path.basename(file))) prose.push(file);
  }
  for (const name of ['SECURITY.md', 'THIRD-PARTY-NOTICES.md', 'README.md']) prose.push(path.join(repo, name));
  for (const file of prose) {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach((line, index) => judge(line, `${rel(file)}:${index + 1}`, found));
  }
  for (const name of ['plugins.mjs', 'skill-registry.mjs']) {
    let text;
    try { text = await fs.readFile(path.join(hub, 'lib', name), 'utf8'); } catch { continue; }
    if (VERIFIED_TRUE.test(text)) found.push({ where: `CHATMCP-HUB/lib/${name}`, rule: 'verified-flag', text: 'verified: true', why: 'a source list may not carry a verified flag' });
  }
  return found;
}

/** Data rules over a skill catalog. `hasLicense` is whether the repository root carries a LICENSE file. */
export function catalogViolations(catalog, { hasLicense }) {
  const found = [];
  for (const entry of catalog) {
    if (entry.provenance === 'chatmcp-builtin') {
      if (!hasLicense && entry.verifiedLicense) found.push(`${entry.id}: verifiedLicense "${entry.verifiedLicense}" on code without a LICENSE file`);
      if (!hasLicense && entry.redistributable) found.push(`${entry.id}: marked redistributable without a LICENSE file`);
      const claimsMcp = sentences(`${entry.id}. ${entry.name}. ${entry.description}`).some((sentence) => /\bMCP\b/.test(sentence) && !NEGATOR.test(sentence));
      if (entry.category === 'mcp-servers' || claimsMcp) found.push(`${entry.id}: a prompt-only built-in calls itself an MCP server`);
    }
    if (entry.provenance !== 'chatmcp-builtin' && entry.verifiedLicense) found.push(`${entry.id}: community skill with a verified licence`);
    if (entry.verified === true) found.push(`${entry.id}: verified flag`);
  }
  return found;
}

// Importing this file only gives access to the scanner; running it executes the gate.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runGate();

async function runGate() {
// ------------------------------------------------------------------ 1. the real tree
const licenseFiles = (await fs.readdir(repoRoot)).filter((name) => /^licen[sc]e(?:\.|$)/i.test(name));
const hasLicense = licenseFiles.length > 0;

{
  const found = await scanTree(repoRoot);
  const lines = found.map((item) => `  ${item.where} [${item.rule}] ${item.text}  -- ${item.why}`);
  assert.equal(found.length, 0, `${found.length} false-trust signal(s):\n${lines.join('\n')}`);
  ok('0 forbidden phrases (tamper-proof, certified, notary, PageRank-style, absolute-security words, "MCP Servers"), 0 verified flags and 0 unqualified "sandbox" in lib, ui/src, live docs, SECURITY, notices and README');
}
{
  const violations = catalogViolations(MARKETPLACE_CATALOG, { hasLicense });
  assert.deepEqual(violations, [], violations.join('\n'));
  assert.ok(MARKETPLACE_CATALOG.some((entry) => entry.provenance === 'chatmcp-builtin'));
  for (const source of KNOWN_SKILL_SOURCES) assert.equal(Object.hasOwn(source, 'verified'), false, `${source.id} must not carry a verified flag`);
  ok(`built-in skills carry no verified licence / redistributable flag${hasLicense ? '' : ' (the repository has no LICENSE file)'}; skill sources carry no verified flag`);
}
{
  // An installation made by an older release keeps writing the old claims: loading must clear them and follow the rename.
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-trust-state-'));
  try {
    await fs.writeFile(path.join(state, 'installed-plugins.json'), '{}');
    const probe = new PluginManager({ stateDir: state });
    await fs.rm(path.join(state, 'installed-plugins.json'));
    const old = {
      id: 'sqlite-mcp-explorer', name: 'SQLite MCP Explorer', version: '1.3.0', license: 'MIT', declaredLicense: 'MIT', verifiedLicense: 'MIT', redistributable: true,
      provenance: 'chatmcp-builtin', category: 'mcp-servers', author: 'ChatMCP Team', description: 'MCP server plugin for querying local SQLite databases', tools: [], systemPrompt: 'x', enabled: true, installedAt: '2026-10-01T00:00:00.000Z',
    };
    const git = { ...old, id: 'git-workflow-pro', name: 'Git Workflow Pro', category: 'coding' };
    await fs.writeFile(probe.filePath, JSON.stringify({ plugins: [old, git] }));
    const loaded = new PluginManager({ stateDir: state });
    await loaded.load();
    const installed = loaded.installed();
    assert.equal(installed.some((entry) => entry.id === 'sqlite-mcp-explorer'), false, 'the old id is gone');
    const renamed = installed.find((entry) => entry.id === 'sqlite-explorer');
    assert.ok(renamed, 'the entry follows the rename');
    assert.equal(renamed.enabled, true, "the owner's choice is kept");
    assert.equal(renamed.installedAt, old.installedAt);
    assert.deepEqual([renamed.verifiedLicense, renamed.redistributable, renamed.category], [null, false, 'data']);
    const other = installed.find((entry) => entry.id === 'git-workflow-pro');
    assert.deepEqual([other.verifiedLicense, other.redistributable], [null, false], 'licence claims written by an older release are cleared');
    ok('an installation from an older release loses its verified-licence claims and follows the sqlite-explorer rename');
  } finally { await fs.rm(state, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ 2. negative control: seeded violations must be caught
{
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-trust-control-'));
  const write = async (name, content) => { await fs.mkdir(path.dirname(path.join(temp, name)), { recursive: true }); await fs.writeFile(path.join(temp, name), content); };
  try {
    const clean = {
      'CHATMCP-HUB/lib/ok.mjs': "// Runs in Windows Sandbox or in Docker. The receipt is tamper-evident, not tamper-proof.\nexport const text = 'Results are not certified by anyone; sed --sandbox refuses the e command.';\n",
      'CHATMCP-HUB/ui/src/ok.tsx': "export const A = () => <p>Isolated checks run in Windows Sandbox.</p>;\nexport const iframe = <iframe sandbox=\"allow-scripts\" />;\n",
      'docs/ok.md': 'Worktrees are not sandboxes. The installer is not certified. A skill is untrusted text.\n',
      'SECURITY.md': 'Nothing here is notarized or guaranteed.\n'.replace('notarized or guaranteed', 'guaranteed'),
    };
    for (const [name, content] of Object.entries(clean)) await write(name, content);
    assert.deepEqual(await scanTree(temp), [], 'the clean tree (including negated sentences and allowed sandbox contexts) must pass');

    const seeded = [
      ['CHATMCP-HUB/lib/bad1.mjs', "export const a = 'A tamper-proof audit trail';\n", 'tamper-proof'],
      ['CHATMCP-HUB/lib/bad2.mjs', "// This build is certified for production use.\nexport const b = 1;\n", 'certified'],
      ['CHATMCP-HUB/lib/bad3.mjs', "export const c = 'Receipts are notarized by the Hub';\n", 'notary'],
      ['CHATMCP-HUB/lib/bad4.mjs', "export const d = 'Runs every check in a secure sandbox';\n", 'sandbox'],
      ['CHATMCP-HUB/lib/bad5.mjs', "export const d = 'Generates a PageRank-style map';\n", 'pagerank'],
      ['CHATMCP-HUB/lib/plugins.mjs', "export const SOURCES = [{ id: 'x', verified: true }];\n", 'verified-flag'],
      ['CHATMCP-HUB/ui/src/bad.tsx', "export const A = () => <p>Certified sandbox execution</p>;\n", 'certified'],
      ['CHATMCP-HUB/ui/src/label.ts', "export const t = { cat_mcp: 'MCP Servers' };\n", 'mcp-servers-label'],
      ['docs/bad.md', 'Every result is tamper-proof and notarized.\n', 'tamper-proof'],
    ];
    for (const [name, content, rule] of seeded) {
      await write(name, content);
      const found = await scanTree(temp);
      assert.ok(found.some((item) => item.where.startsWith(name) && item.rule === rule), `the gate must flag ${name} as ${rule} (found: ${JSON.stringify(found.map((item) => [item.where, item.rule]))})`);
      await fs.rm(path.join(temp, name));
    }
    assert.deepEqual(await scanTree(temp), [], 'removing the seeded files makes the gate pass again');

    const dishonest = MARKETPLACE_CATALOG.map((entry) => (entry.provenance === 'chatmcp-builtin' ? { ...entry, verifiedLicense: 'MIT', redistributable: true } : entry));
    assert.ok(catalogViolations(dishonest, { hasLicense: false }).length >= 2, 'a verified licence on unlicensed built-ins must be flagged');
    assert.deepEqual(catalogViolations(dishonest, { hasLicense: true }).filter((line) => /LICENSE/.test(line)), [], 'with a LICENSE file the licence rule does not apply');
    assert.ok(catalogViolations([{ id: 'x', provenance: 'chatmcp-builtin', category: 'mcp-servers', name: 'X MCP', description: 'MCP server' }], { hasLicense: true }).length >= 1);
    ok(`negative control: ${seeded.length} seeded violations (phrases, sandbox, verified flag, label, docs) and a dishonest catalog are all caught; the clean tree and negated sentences pass`);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

console.log(`PASS: ${checks} trust-label checks`);
}
