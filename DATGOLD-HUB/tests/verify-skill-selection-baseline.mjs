// Skill selection: the labelled corpus and the baseline its numbers may only improve on.
//
// tests/fixtures/skill-selection-corpus.json holds requests a user types, each with the skills a person would expect to be selected (labelled from the skills' descriptions
// before the selector was run on them). tests/support/skill-selection-measure.mjs runs the real selector over it in this process. This suite pins:
//   1. the shape of the corpus: how many rows of each language and category, unique ids, every expected skill exists in the row's set, every row has a reason;
//   2. the stand-in third-party skills: 30, ids in the registry's source-folder form, descriptions of a realistic length, said to be stand-ins;
//   3. the measurement is the same on every run;
//   4. the ratchet: against tests/fixtures/skill-selection-baseline.json, no number may get worse (exact rows, recall, precision, over-selection, rows where nothing was
//      selected), for the whole corpus or for one set. A better number is printed, with the command that writes the new baseline. It does not fail because the selector is
//      weak today: the baseline is today's numbers.
//   5. negative control: the same measurement over a copy of lib/ whose pass mark is raised so that nothing is selected must fail the ratchet.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BASELINE_FILE, CATEGORIES, HUB_ROOT, LANGUAGES, PROJECT_KINDS, SETS, baselineOf, compareWithBaseline, corpusFingerprint, measureSkillSelection, readCorpus, skillSetIds,
} from './support/skill-selection-measure.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const data = await readCorpus();
const { corpus, thirdParty } = data;
const rows = corpus.rows;
const setIds = await skillSetIds(data);
const count = (predicate) => rows.filter(predicate).length;

// 1. The corpus.
{
  assert.ok(rows.length >= 240, `at least 240 rows (${rows.length})`);
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, 'row ids are unique');
  for (const row of rows) {
    assert.match(row.id, /^[FSL]-\d{3}$/, `${row.id}: an id like F-001`);
    assert.ok(SETS.includes(row.set), `${row.id}: a known set`);
    assert.equal(row.id[0], { fresh: 'F', shipped: 'S', large: 'L' }[row.set], `${row.id}: the id's letter is its set's`);
    assert.ok(LANGUAGES.includes(row.lang), `${row.id}: a known language`);
    assert.ok(CATEGORIES.includes(row.category), `${row.id}: a known category`);
    assert.ok(typeof row.prompt === 'string' && row.prompt.trim(), `${row.id}: a prompt`);
    assert.ok(typeof row.reason === 'string' && row.reason.trim().length >= 5, `${row.id}: a reason`);
    for (const field of ['must', 'acceptable', 'mustNot']) assert.ok(Array.isArray(row[field]), `${row.id}: ${field} is a list`);
    const known = new Set(setIds[row.set]);
    const named = [...row.must.flat(), ...row.acceptable, ...row.mustNot];
    for (const id of named) assert.ok(known.has(id), `${row.id}: "${id}" is a skill of the set "${row.set}"`);
    const must = new Set(row.must.flat());
    assert.ok([...row.acceptable, ...row.mustNot].every((id) => !must.has(id)), `${row.id}: an expected skill is not also acceptable or mustNot`);
    assert.ok(row.acceptable.every((id) => !row.mustNot.includes(id)), `${row.id}: acceptable and mustNot do not overlap`);
    assert.ok(row.must.every((entry) => !Array.isArray(entry) || entry.length >= 2), `${row.id}: a group of alternatives has two skills or more`);
    assert.equal(row.category === 'followup', Array.isArray(row.earlier) && row.earlier.length > 0, `${row.id}: earlier prompts exactly on a follow-up`);
    assert.equal(row.category === 'project', Array.isArray(row.project) && row.project.length > 0, `${row.id}: project kinds exactly on a project row`);
    for (const kind of row.project ?? []) assert.ok(PROJECT_KINDS.includes(kind), `${row.id}: a known project kind "${kind}"`);
    if (row.category === 'none') assert.equal(row.must.length, 0, `${row.id}: a row of the category none expects nothing`);
    if (row.category === 'one') assert.equal(row.must.length, 1, `${row.id}: a row of the category one expects one skill`);
    if (row.category === 'two') assert.equal(row.must.length, 2, `${row.id}: a row of the category two expects two`);
  }
  ok(`${rows.length} rows: unique ids, known sets, languages and categories, a reason each, every expected skill exists in its set`);

  const english = count((row) => row.lang === 'en');
  const vietnamese = count((row) => row.lang !== 'en');
  assert.ok(Math.abs(english - vietnamese) <= rows.length * 0.1, `about half English, half Vietnamese (${english} / ${vietnamese})`);
  for (const lang of LANGUAGES) assert.ok(count((row) => row.lang === lang) >= 20, `at least 20 rows of ${lang}`);
  assert.ok(count((row) => row.must.length === 0) >= rows.length / 4, 'at least a quarter of the rows expect nothing');
  for (const category of CATEGORIES) assert.ok(count((row) => row.category === category) >= 25, `at least 25 rows of the category ${category}`);
  for (const set of SETS) assert.ok(count((row) => row.set === set) >= 60, `at least 60 rows judged against the set ${set}`);
  ok(`${english} English and ${vietnamese} Vietnamese rows; ${count((row) => row.must.length === 0)} expect nothing; every category and set has its share`);

  // The numbers of the doc and the pull request are about this corpus: pinned, so that a row cannot come or go unnoticed (a change also changes the fingerprint).
  assert.deepEqual(Object.fromEntries(SETS.map((set) => [set, count((row) => row.set === set)])), { fresh: 83, shipped: 122, large: 142 });
  assert.deepEqual(Object.fromEntries(LANGUAGES.map((lang) => [lang, count((row) => row.lang === lang)])), { en: 172, vi: 113, 'vi-plain': 40, mixed: 22 });
  assert.deepEqual(Object.fromEntries(CATEGORIES.map((category) => [category, count((row) => row.category === category)])), { one: 125, two: 33, none: 88, followup: 36, mention: 33, project: 32 });
  ok('the counts per set, language and category are the ones the documents quote');
}

// 2. The stand-in third-party skills.
{
  const { normalizeSkillId } = await import('../lib/plugins.mjs');
  const registry = await fs.readFile(path.join(HUB_ROOT, 'lib', 'skill-registry.mjs'), 'utf8');
  const sources = [...registry.matchAll(/\{id:'([a-z0-9_-]+)',repo:/g)].map((match) => match[1]);
  assert.equal(sources.length, 5, 'the five default registry sources are read from lib/skill-registry.mjs');
  assert.equal(thirdParty.skills.length, 30, '30 stand-in skills');
  assert.match(thirdParty.description, /STAND-IN/, 'the fixture says they are stand-ins');
  assert.match(thirdParty.description, /not copies/, 'the fixture says they are not copies');
  const shipped = new Set(setIds.shipped);
  for (const skill of thirdParty.skills) {
    assert.equal(normalizeSkillId(skill.id), skill.id, `${skill.id}: a valid skill id`);
    assert.ok(!shipped.has(skill.id), `${skill.id}: not a shipped id`);
    const source = sources.find((id) => skill.id.startsWith(`${id}-`));
    assert.ok(source, `${skill.id}: begins with a registry source id`);
    assert.equal(skill.id, `${source}-${skill.name}`, `${skill.id}: <source>-<folder>, the folder being its name`);
    assert.ok(skill.description.length >= 200 && skill.description.length <= 900, `${skill.id}: a description of 200 to 900 characters (${skill.description.length})`);
  }
  assert.equal(new Set(thirdParty.skills.map((skill) => skill.id)).size, 30, 'their ids are unique');
  ok(`30 stand-in skills from ${sources.length} sources, in the source-folder id form, descriptions of 200 to 900 characters`);
}

// 3 and 4. The measurement and the ratchet.
const first = await measureSkillSelection();
{
  const second = await measureSkillSelection();
  assert.deepEqual(baselineOf(second), baselineOf(first), 'two runs give the same numbers');
  assert.deepEqual(second.failures, first.failures, 'and the same failures in the same order');
  assert.equal(first.fingerprint, corpusFingerprint(data));
  ok('the measurement is the same on every run');
}

const baseline = JSON.parse(await fs.readFile(BASELINE_FILE, 'utf8'));
const now = baselineOf(first);
const verdict = compareWithBaseline(baseline, now);
const o = now.overall;
const pct = (part, whole) => (whole ? `${(100 * part / whole).toFixed(1)}%` : 'n/a');
console.log(`  now: exact ${o.exact}/${o.rows} (${pct(o.exact, o.rows)}), recall ${o.groupsSelected}/${o.groups} (${pct(o.groupsSelected, o.groups)}), precision ${o.selectedAllowed}/${o.selected} (${pct(o.selectedAllowed, o.selected)}), ` +
  `over-selected ${o.overSelected}/${o.expectNothing} (${pct(o.overSelected, o.expectNothing)}), nothing selected ${o.nothingSelected}/${o.expectSomething} (${pct(o.nothingSelected, o.expectSomething)})`);
for (const line of verdict.better) console.log(`  BETTER - ${line}`);
if (verdict.better.length) console.log('  The numbers got better: write them with `node tests/tools/measure-skill-selection.mjs --write-baseline` in this change, so that the gain is kept.');
if (verdict.fixed?.length) console.log(`  rows exact now that were not: ${verdict.fixed.join(', ')}`);
if (verdict.broken?.length) console.log(`  rows no longer exact (the totals did not fall, but look at them): ${verdict.broken.join(', ')}`);
assert.deepEqual(verdict.worse, [], `skill selection got worse than tests/fixtures/skill-selection-baseline.json:\n  - ${verdict.worse.join('\n  - ')}\nRun node tests/tools/measure-skill-selection.mjs for the failures.`);
ok('no number is worse than the baseline, for the corpus or for any set');

// 5. Negative controls of the ratchet.
{
  const shift = (field, by) => ({ ...baseline, overall: { ...baseline.overall, [field]: baseline.overall[field] + by } });
  assert.ok(compareWithBaseline(shift('exact', 1), now).worse.some((line) => /exact rows fell/.test(line)), 'one exact row fewer than the baseline is worse');
  assert.ok(compareWithBaseline(shift('overSelected', -1), now).worse.some((line) => /expect nothing/.test(line)), 'one more over-selected row is worse');
  assert.ok(compareWithBaseline(shift('nothingSelected', -1), now).worse.some((line) => /expect a skill/.test(line)), 'one more row with nothing selected is worse');
  assert.ok(compareWithBaseline(shift('groupsSelected', 1), now).worse.some((line) => /recall fell/.test(line)), 'a lower recall is worse');
  assert.ok(compareWithBaseline(shift('selectedAllowed', 1), now).worse.some((line) => /precision fell/.test(line)), 'a lower precision is worse');
  assert.ok(compareWithBaseline(shift('exact', -1), now).better.some((line) => /exact rows rose/.test(line)), 'one exact row more is better, not a failure');
  assert.deepEqual(compareWithBaseline(shift('exact', -1), now).worse, []);
  const setOnly = { ...baseline, sets: { ...baseline.sets, large: { ...baseline.sets.large, exact: baseline.sets.large.exact + 1 } } };
  assert.ok(compareWithBaseline(setOnly, now).worse.some((line) => /set "large"/.test(line)), 'a set that gets worse fails even when the total would not');
  assert.ok(compareWithBaseline({ ...baseline, fingerprint: '0'.repeat(64) }, now).worse.some((line) => /fingerprint/.test(line)), 'another corpus needs a new baseline');
  ok('the ratchet fails on each kind of worse number and on another corpus, and only reports a better one');

  // A real regression, measured: a copy of lib/ whose pass mark nobody reaches. (Made inside the Hub folder, so that the copy resolves the packages of node_modules.)
  const copy = await fs.mkdtemp(path.join(HUB_ROOT, '.skill-selection-control-'));
  try {
    await fs.cp(path.join(HUB_ROOT, 'lib'), path.join(copy, 'lib'), { recursive: true });
    const record = path.join(copy, 'lib', 'skill-selection-record.mjs');
    const text = await fs.readFile(record, 'utf8');
    assert.ok(text.includes('export const SKILL_THRESHOLD = 3;'), 'the pass mark is where the control expects it');
    await fs.writeFile(record, text.replace('export const SKILL_THRESHOLD = 3;', 'export const SKILL_THRESHOLD = 1000;'));
    const broken = baselineOf(await measureSkillSelection({ hubRoot: copy }));
    assert.equal(broken.overall.selected, 0, 'the broken copy selects nothing');
    const control = compareWithBaseline(baseline, broken);
    assert.ok(control.worse.some((line) => /recall fell/.test(line)) && control.worse.some((line) => /expect a skill/.test(line)), `the ratchet fails on the broken copy:\n${control.worse.join('\n')}`);
  } finally {
    await fs.rm(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  ok('negative control: the same measurement over a copy of lib/ that selects nothing fails the ratchet');
}

console.log(`\nPASS: ${checks} skill-selection baseline checks`);
