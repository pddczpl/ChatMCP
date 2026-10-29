#!/usr/bin/env node
// READ-ONLY LIVE CHECK, no key, no cost: can the Hub read every SKILL.md that a skill catalog lists? For the owner, by hand:
//
//     node DATGOLD-HUB/tests/live/check-skill-manifests.mjs                       (the catalog anthropics/skills)
//     node DATGOLD-HUB/tests/live/check-skill-manifests.mjs --source all --verbose  (the five catalogs, one line for every skill)
//
// The Skills card lists the skills of a catalog from the Git tree alone; a SKILL.md is read only when somebody presses Install. A skill that the Hub cannot read therefore looks fine until that
// click (claude-api of anthropics/skills, 2026-10-29: `description: |-` was refused with "Unsupported or malformed SKILL.md YAML on line 3."). This asks GitHub for the same list the card shows
// (GitHubSkillRegistry.refresh, in a temporary folder), downloads every SKILL.md the way Install does (the same fetch, at most 128 KiB, valid UTF-8), runs parseSkillManifest on it and says which
// ones the Hub cannot read and why, with the message that the card would show. Pass `--source <id>` for one catalog: anthropic, openai, vercel, github, cloudflare.
//
// It installs nothing and writes only a temporary folder, deleted at the end. It sends two requests to api.github.com per catalog (the anonymous limit is 60 an hour) and downloads one file
// from raw.githubusercontent.com per skill, a few at a time. CI never runs it against GitHub: tests/verify-phase4-features.mjs runs it offline, against stand-ins for both, so that it cannot rot.
//
// Exit code: 0 every SKILL.md can be read, 1 at least one cannot, 2 a bad use or a catalog that could not be listed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSkillManifest } from '../../lib/plugins.mjs';
import { GitHubSkillRegistry } from '../../lib/skill-registry.mjs';

/** What Install allows for a SKILL.md (GitHubSkillRegistry, the pinned-tree install). */
export const MAX_SKILL_BYTES = 128 * 1024;
/** What a UTF-8 decoder puts in place of bytes that are not UTF-8; Install refuses a SKILL.md that holds one (a SKILL.md that really contains the character is refused too). */
const REPLACEMENT = String.fromCodePoint(0xfffd);

const rawUrl = (entry) => `https://raw.githubusercontent.com/${entry.repo}/${entry.revision}/${entry.manifestPath}`;

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]); }
  }));
  return results;
}

/** Reads one SKILL.md the way Install does and says what became of it: ok, unreadable, too_large, not_utf8 or download_failed. */
export async function readManifest(entry, binaryTransport) {
  const base = { key: entry.key, folder: entry.folder, bytes: null };
  let bytes;
  try {
    ({ bytes } = await binaryTransport(rawUrl(entry), { maxBytes: MAX_SKILL_BYTES }));
  } catch (error) {
    const tooLarge = error?.code === 'asset_too_large';
    return { ...base, status: tooLarge ? 'too_large' : 'download_failed', detail: `${error?.code ?? 'error'}: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}` };
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  base.bytes = buffer.length;
  if (buffer.length > MAX_SKILL_BYTES) return { ...base, status: 'too_large', detail: `${buffer.length} bytes, Install allows ${MAX_SKILL_BYTES}` };
  const text = buffer.toString('utf8');
  if (text.includes(REPLACEMENT)) return { ...base, status: 'not_utf8', detail: 'SKILL.md is not valid UTF-8' };
  try {
    const manifest = parseSkillManifest(text, entry.manifestPath);
    return { ...base, status: 'ok', detail: `name ${manifest.name}` };
  } catch (error) {
    return { ...base, status: 'unreadable', detail: `${error?.code ?? 'error'}: ${String(error?.message ?? error).split('\n')[0]}` };
  }
}

/** Lists one catalog like the Skills card does (a refresh into a temporary folder) and reads every SKILL.md of it. Both transports can be replaced (the tests do). */
export async function checkSource(sourceId, { transport, binaryTransport, concurrency = 6 } = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'datgold-live-skills-'));
  try {
    const registry = new GitHubSkillRegistry({ pluginManager: null, stateDir, ...(transport ? { transport } : {}), ...(binaryTransport ? { binaryTransport } : {}) });
    const refreshed = await registry.refresh({ sourceId });
    if (refreshed.failures.length) throw new Error(`the catalog could not be listed: ${refreshed.failures.map((failure) => failure.error).join('; ')}`);
    const entries = registry.entries.filter((entry) => entry.sourceId === sourceId);
    const results = await mapLimit(entries, concurrency, (entry) => readManifest(entry, registry.binaryTransport));
    const source = registry.sources().find((candidate) => candidate.id === sourceId);
    return { sourceId, repo: source.repo, revision: entries[0]?.revision ?? null, listed: entries.length, results };
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

const HELP = 'usage: node tests/live/check-skill-manifests.mjs [--source anthropic|openai|vercel|github|cloudflare|all] [--verbose]';

export async function main(argv = process.argv.slice(2), { transport, binaryTransport, log = console.log, logError = console.error } = {}) {
  const options = { source: 'anthropic', verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source' && argv[i + 1]) options.source = argv[++i];
    else if (argv[i] === '--verbose') options.verbose = true;
    else if (argv[i] === '--help') { log(HELP); return 0; }
    else { logError(`unknown argument ${argv[i]}\n${HELP}`); return 2; }
  }
  const known = new GitHubSkillRegistry({ pluginManager: null, stateDir: os.tmpdir() }).sources().map((source) => source.id);
  const sources = options.source === 'all' ? known : [options.source];
  if (sources.some((id) => !known.includes(id))) { logError(`unknown catalog "${options.source}" (${known.join(', ')})\n${HELP}`); return 2; }

  let unreadable = 0;
  let total = 0;
  for (const sourceId of sources) {
    let checked;
    try { checked = await checkSource(sourceId, { transport, binaryTransport }); }
    catch (error) { logError(`${sourceId}: ${String(error?.message ?? error).split('\n')[0]}`); return 2; }
    log(`${sourceId} = ${checked.repo}${checked.revision ? ` at ${checked.revision.slice(0, 7)}` : ''}: ${checked.listed} SKILL.md listed (what the Skills card shows), each downloaded like Install does and parsed`);
    for (const result of checked.results) {
      if (result.status !== 'ok' || options.verbose) log(`  ${(result.status === 'ok' ? 'ok' : result.status.toUpperCase()).padEnd(16)}${result.folder}${result.bytes === null ? '' : `  (${result.bytes} bytes)`}  ${result.detail}`);
    }
    const bad = checked.results.filter((result) => result.status !== 'ok');
    log(`  ${checked.listed - bad.length} of ${checked.listed} can be read${bad.length ? `; ${bad.length} cannot: ${bad.map((result) => result.folder.split('/').at(-1)).join(', ')}` : ''}`);
    unreadable += bad.length;
    total += checked.listed;
  }
  log(unreadable ? `FAIL: ${unreadable} of ${total} SKILL.md cannot be read by the Hub.` : `OK: the Hub can read all ${total} SKILL.md.`);
  return unreadable ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (error) => { console.error(error?.stack ?? error); process.exit(2); });
}
