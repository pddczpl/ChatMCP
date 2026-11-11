// Measures skill selection as it is, over the labelled corpus (tests/fixtures/skill-selection-corpus.json).
//
// Everything that decides is the product's own code, run in this process: the real PluginManager (lib/plugins.mjs) with the skills of a set installed in a temporary state
// folder, the real detectProjectSignals (lib/project-signals.mjs) over a temporary workspace that holds the files of a row's project kinds, selectConversationSkills
// (lib/agent.mjs) called with the options the runner passes (limit 4, no character budget, the earlier prompts of the conversation), and for what was not selected
// otherEnabledSkills and fitSkillIndex (lib/skill-index.mjs) with the default allowance, the one a run with a large context window has. No Hub process, no network, no model.
//
// This file only counts. It is shared by tests/tools/measure-skill-selection.mjs (the report) and tests/verify-skill-selection-baseline.mjs (the ratchet).
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const HUB_ROOT = path.resolve(here, '..', '..');
export const CORPUS_FILE = path.join(HUB_ROOT, 'tests', 'fixtures', 'skill-selection-corpus.json');
export const THIRD_PARTY_FILE = path.join(HUB_ROOT, 'tests', 'fixtures', 'skill-selection-third-party.json');
export const BASELINE_FILE = path.join(HUB_ROOT, 'tests', 'fixtures', 'skill-selection-baseline.json');

export const SETS = Object.freeze(['fresh', 'shipped', 'large']);
export const LANGUAGES = Object.freeze(['en', 'vi', 'vi-plain', 'mixed']);
export const CATEGORIES = Object.freeze(['one', 'two', 'none', 'followup', 'mention', 'project']);

// The files that make a temporary workspace a project of a kind, as detectProjectSignals reads them.
const PROJECT_FILES = Object.freeze({
  docker: [['Dockerfile', 'FROM scratch\n']],
  python: [['pyproject.toml', '[project]\nname = "sample"\n']],
  fastapi: [['requirements.txt', 'fastapi==0.110.0\n']],
  react: [['package.json', '{ "name": "sample", "dependencies": { "react": "^19.0.0" } }\n']],
  sqlite: [['app.sqlite3', '']],
  'github-actions': [['.github/workflows/ci.yml', 'on: push\n']],
});
export const PROJECT_KINDS = Object.freeze(Object.keys(PROJECT_FILES));

export async function readCorpus() {
  const corpus = JSON.parse(await fs.readFile(CORPUS_FILE, 'utf8'));
  const thirdParty = JSON.parse(await fs.readFile(THIRD_PARTY_FILE, 'utf8'));
  return { corpus, thirdParty };
}

/** What the numbers are about: the rows and the stand-in skills, as parsed (so that line endings do not matter). */
export function corpusFingerprint({ corpus, thirdParty }) {
  return createHash('sha256').update(JSON.stringify({ rows: corpus.rows, skills: thirdParty.skills })).digest('hex');
}

const groupsOf = (row) => row.must.map((entry) => (Array.isArray(entry) ? entry : [entry]));

/** The ids each set has enabled, in the order they are installed. */
export async function skillSetIds({ thirdParty }, hubRoot = HUB_ROOT) {
  const { MARKETPLACE_CATALOG } = await import(pathToFileURL(path.join(hubRoot, 'lib', 'plugins.mjs')).href);
  const builtin = MARKETPLACE_CATALOG.map((item) => item.id);
  return {
    fresh: MARKETPLACE_CATALOG.filter((item) => item.installedByDefault).map((item) => item.id),
    shipped: builtin,
    large: [...builtin, ...thirdParty.skills.map((skill) => skill.id)],
  };
}

async function buildManagers(root, { thirdParty }, hubRoot) {
  const { PluginManager, MARKETPLACE_CATALOG } = await import(pathToFileURL(path.join(hubRoot, 'lib', 'plugins.mjs')).href);
  const managers = {};
  for (const set of SETS) {
    // A first start: the manager installs and enables the default skills itself.
    const manager = new PluginManager({ stateDir: path.join(root, `state-${set}`) });
    await manager.load();
    if (set !== 'fresh') {
      for (const item of MARKETPLACE_CATALOG) if (!manager.installed().some((installed) => installed.id === item.id)) await manager.install(item.id);
    }
    if (set === 'large') {
      for (const skill of thirdParty.skills) {
        await manager.install(skill.id, { name: skill.name, description: skill.description, tools: [], license: 'unknown', systemPrompt: `Stand-in text of the skill ${skill.id}.` });
      }
    }
    managers[set] = manager;
  }
  return managers;
}

async function buildWorkspaces(root, rows, hubRoot) {
  const { detectProjectSignals } = await import(pathToFileURL(path.join(hubRoot, 'lib', 'project-signals.mjs')).href);
  const workspaces = new Map();
  const keyOf = (kinds) => [...kinds].sort().join('+');
  for (const row of rows) {
    const kinds = row.project ?? [];
    const key = keyOf(kinds);
    if (workspaces.has(key)) continue;
    const folder = path.join(root, `workspace-${key || 'plain'}`);
    await fs.mkdir(folder, { recursive: true });
    for (const kind of kinds) {
      for (const [name, text] of PROJECT_FILES[kind]) {
        await fs.mkdir(path.dirname(path.join(folder, name)), { recursive: true });
        await fs.writeFile(path.join(folder, name), text);
      }
    }
    const signals = await detectProjectSignals(folder);
    const detected = keyOf(signals.map((signal) => signal.id));
    if (detected !== key) throw new Error(`the workspace made for "${key}" is detected as "${detected}"`);
    workspaces.set(key, { folder, signals });
  }
  return (row) => workspaces.get(keyOf(row.project ?? []));
}

// How the catalog of the skill index names a skill that was not selected: with its description, as an id only, or not at all.
function catalogStatus(index, ids) {
  const listed = ids.some((id) => index.catalog.listed.includes(id));
  if (!listed) return 'absent';
  return index.catalog.form === 'lines' ? 'described' : 'id_only';
}

const emptyCounts = () => ({
  rows: 0, exact: 0, groups: 0, groupsSelected: 0, selected: 0, selectedAllowed: 0,
  expectNothing: 0, overSelected: 0, expectSomething: 0, nothingSelected: 0,
  mustNotRows: 0, mustNotSelected: 0, missed: 0, missedDescribed: 0, missedIdOnly: 0, missedAbsent: 0,
});

function add(counts, outcome) {
  counts.rows += 1;
  if (outcome.exact) counts.exact += 1;
  counts.groups += outcome.groups.length;
  counts.groupsSelected += outcome.groups.filter((group) => group.selected).length;
  counts.selected += outcome.selected.length;
  counts.selectedAllowed += outcome.selected.length - outcome.extra.length;
  if (!outcome.groups.length) { counts.expectNothing += 1; if (outcome.extra.length) counts.overSelected += 1; }
  else { counts.expectSomething += 1; if (!outcome.selected.length) counts.nothingSelected += 1; }
  if (outcome.hasMustNot) { counts.mustNotRows += 1; if (outcome.forbidden.length) counts.mustNotSelected += 1; }
  for (const group of outcome.groups) {
    if (group.selected) continue;
    counts.missed += 1;
    counts[{ described: 'missedDescribed', id_only: 'missedIdOnly', absent: 'missedAbsent' }[group.catalog]] += 1;
  }
}

/**
 * Runs the selector over every row. Returns `rows` (one outcome per row, in the order of the corpus), the counts `overall`, `bySet`, `byLanguage`, `byCategory`, `bySetLanguage`
 * and `bySetCategory`, `failures` ({ missed, overSelected }: every one, ranked) and `catalogScale` (what the index can name when nothing is selected, at several numbers of skills).
 */
export async function measureSkillSelection({ hubRoot = HUB_ROOT } = {}) {
  const data = await readCorpus();
  const { corpus, thirdParty } = data;
  const { selectConversationSkills, otherEnabledSkills } = await import(pathToFileURL(path.join(hubRoot, 'lib', 'agent.mjs')).href);
  const { fitSkillIndex, SKILL_INDEX_MAX_BYTES } = await import(pathToFileURL(path.join(hubRoot, 'lib', 'skill-index.mjs')).href);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-selection-measure-'));
  try {
    const managers = await buildManagers(root, data, hubRoot);
    const workspaceOf = await buildWorkspaces(root, corpus.rows, hubRoot);

    const rows = [];
    const missed = [];
    const overSelected = [];
    for (const row of corpus.rows) {
      const manager = managers[row.set];
      const { folder, signals } = workspaceOf(row);
      const trace = {};
      // The call of the runner (lib/agent.mjs, "Select task-relevant skills dynamically").
      const selectedSkills = selectConversationSkills(manager, row.prompt, row.earlier ?? [], { workspacePath: folder, project: signals, tokenBudget: Infinity, trace });
      const selected = selectedSkills.map((skill) => skill.id);
      const index = fitSkillIndex(selectedSkills, { others: otherEnabledSkills(manager, selectedSkills, trace) });

      const allowed = new Set([...row.must.flat(), ...row.acceptable]);
      const extra = selected.filter((id) => !allowed.has(id));
      const forbidden = selected.filter((id) => row.mustNot.includes(id));
      const candidateOf = (id, call = 0) => (trace.calls[call]?.candidates ?? []).find((candidate) => candidate.id === id) ?? null;
      const groups = groupsOf(row).map((ids) => {
        const taken = ids.some((id) => selected.includes(id));
        return { ids, selected: taken, catalog: taken ? null : catalogStatus(index, ids) };
      });
      const outcome = {
        id: row.id, set: row.set, lang: row.lang, category: row.category, selected, groups, extra, forbidden, hasMustNot: row.mustNot.length > 0,
        exact: groups.every((group) => group.selected) && extra.length === 0,
        catalog: { form: index.catalog.form, listed: index.catalog.listed.length, omitted: index.catalog.omitted.length },
      };
      rows.push(outcome);

      const base = { id: row.id, set: row.set, lang: row.lang, category: row.category, prompt: row.prompt, ...(row.earlier ? { earlier: row.earlier } : {}), ...(row.project ? { project: row.project } : {}) };
      for (const group of groups) {
        if (group.selected) continue;
        // The scorer's own account of the run's prompt for each skill that would have done: its score and the words that counted, or nothing at all.
        const nearest = group.ids.map((id) => candidateOf(id)).filter(Boolean).sort((a, b) => b.score - a.score)[0] ?? null;
        missed.push({ ...base, expected: group.ids, score: nearest?.score ?? 0, why: nearest?.why ?? [], concepts: trace.calls[0]?.concepts ?? [], selected, catalog: group.catalog });
      }
      for (const id of extra) {
        const pick = trace.picks.find((entry) => entry.id === id);
        const candidate = candidateOf(id, pick?.call ?? 0);
        overSelected.push({ ...base, skill: id, score: candidate?.score ?? 0, why: candidate?.why ?? [], from: (pick?.call ?? 0) === 0 ? 'run' : 'earlier', mustNot: row.mustNot.includes(id), expected: row.must });
      }
    }

    const tally = (keyOf) => {
      const out = {};
      for (const outcome of rows) add(out[keyOf(outcome)] ??= emptyCounts(), outcome);
      return out;
    };
    const overall = emptyCounts();
    for (const outcome of rows) add(overall, outcome);

    // Ranked so that the first ones say the most: a miss the scorer had no word for at all first; an over-selection it was surest of first. Ties in the order of the corpus.
    const order = new Map(rows.map((outcome, at) => [outcome.id, at]));
    missed.sort((a, b) => a.score - b.score || order.get(a.id) - order.get(b.id));
    overSelected.sort((a, b) => b.score - a.score || order.get(a.id) - order.get(b.id));

    // What the catalog can tell the model when nothing is selected, by the number of skills that are turned on. The 150 are the large set and 111 more ids of the same shapes.
    const large = managers.large.activeSkills();
    const more = Array.from({ length: 111 }, (_, at) => {
      const model = thirdParty.skills[at % thirdParty.skills.length];
      return { id: `${['acme', 'contrib', 'team'][at % 3]}-${model.name}-${1 + Math.floor(at / thirdParty.skills.length)}`, name: model.name, description: model.description, systemPrompt: 'Stand-in text.' };
    });
    const catalogScale = [managers.fresh.activeSkills(), managers.shipped.activeSkills(), large, [...large, ...more]].map((skills) => {
      const index = fitSkillIndex([], { others: skills });
      return { skills: skills.length, form: index.catalog.form, named: index.catalog.listed.length, notNamed: index.catalog.omitted.length, bytes: index.bytes, maxBytes: SKILL_INDEX_MAX_BYTES, tool: index.tool };
    });

    return {
      fingerprint: corpusFingerprint(data),
      rows, overall,
      bySet: tally((outcome) => outcome.set), byLanguage: tally((outcome) => outcome.lang), byCategory: tally((outcome) => outcome.category),
      bySetLanguage: tally((outcome) => `${outcome.set} / ${outcome.lang}`), bySetCategory: tally((outcome) => `${outcome.set} / ${outcome.category}`),
      failures: { missed, overSelected }, catalogScale,
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** What the baseline keeps of a measurement: the counts of the whole corpus and of each set, and the rows that are not exact. */
export function baselineOf(result) {
  const keep = ({ rows, exact, groups, groupsSelected, selected, selectedAllowed, expectNothing, overSelected, expectSomething, nothingSelected }) =>
    ({ rows, exact, groups, groupsSelected, selected, selectedAllowed, expectNothing, overSelected, expectSomething, nothingSelected });
  return {
    version: 1,
    note: 'The numbers of tests/tools/measure-skill-selection.mjs for the corpus with this fingerprint. They may only get better: tests/verify-skill-selection-baseline.mjs fails when exact, recall or precision falls, or when overSelected or nothingSelected rises, for the whole corpus or for one set. When a change improves them, write the new numbers with `node tests/tools/measure-skill-selection.mjs --write-baseline` in the same change. A change of the corpus changes the fingerprint and needs a new baseline, and a reviewer who looks at the old and the new numbers.',
    fingerprint: result.fingerprint,
    overall: keep(result.overall),
    sets: Object.fromEntries(SETS.map((set) => [set, keep(result.bySet[set])])),
    notExact: result.rows.filter((outcome) => !outcome.exact).map((outcome) => outcome.id),
  };
}

// a/b compared with c/d without fractions. A ratio with nothing under it (nothing was selected at all) is the best a precision can be: nothing wrong was selected.
const ratio = (a, b, c, d) => (b === 0 ? 1 : a / b) - (d === 0 ? 1 : c / d);

/**
 * The ratchet: `now` against `before` (both as baselineOf gives them). `worse` and `better` are lists of sentences; the baseline holds when `worse` is empty.
 */
export function compareWithBaseline(before, now) {
  const worse = [];
  const better = [];
  if (before.fingerprint !== now.fingerprint) {
    return { worse: [`the corpus is not the one the baseline was measured on (fingerprint ${String(before.fingerprint).slice(0, 12)} in the baseline, ${now.fingerprint.slice(0, 12)} now): write a new baseline with --write-baseline and say in the commit what changed in the corpus`], better };
  }
  const scopes = [['the whole corpus', before.overall, now.overall], ...SETS.map((set) => [`the set "${set}"`, before.sets?.[set], now.sets[set]])];
  for (const [name, old, current] of scopes) {
    if (!old) { worse.push(`the baseline has no numbers for ${name}`); continue; }
    const judge = (label, delta, was, is) => {
      if (delta < 0) worse.push(`${name}: ${label} fell from ${was} to ${is}`);
      else if (delta > 0) better.push(`${name}: ${label} rose from ${was} to ${is}`);
    };
    judge('exact rows', current.exact - old.exact, `${old.exact}/${old.rows}`, `${current.exact}/${current.rows}`);
    judge('recall', ratio(current.groupsSelected, current.groups, old.groupsSelected, old.groups), `${old.groupsSelected}/${old.groups}`, `${current.groupsSelected}/${current.groups}`);
    judge('precision', ratio(current.selectedAllowed, current.selected, old.selectedAllowed, old.selected), `${old.selectedAllowed}/${old.selected}`, `${current.selectedAllowed}/${current.selected}`);
    judge('rows that expect nothing and got none (the opposite of over-selection)', old.overSelected - current.overSelected, `${old.expectNothing - old.overSelected}/${old.expectNothing}`, `${current.expectNothing - current.overSelected}/${current.expectNothing}`);
    judge('rows that expect a skill and got at least one', old.nothingSelected - current.nothingSelected, `${old.expectSomething - old.nothingSelected}/${old.expectSomething}`, `${current.expectSomething - current.nothingSelected}/${current.expectSomething}`);
  }
  const were = new Set(before.notExact ?? []);
  const are = new Set(now.notExact);
  const broken = now.notExact.filter((id) => !were.has(id));
  const fixed = [...were].filter((id) => !are.has(id));
  return { worse, better, broken, fixed };
}
