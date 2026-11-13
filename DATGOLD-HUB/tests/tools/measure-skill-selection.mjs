#!/usr/bin/env node
// How well does the keyword selector pick skills? The report over tests/fixtures/skill-selection-corpus.json.
//
// Usage (from DATGOLD-HUB):
//   node tests/tools/measure-skill-selection.mjs [--json file] [--failures n] [--markdown] [--write-baseline]
//
// It runs the product's own selection code in this process (see tests/support/skill-selection-measure.mjs): no Hub, no network, no model. The output is the same on every run.
//   --json file        also write everything (every row's outcome, every failure) to a file
//   --failures n       how many failures of each kind to print (default 20)
//   --markdown         print the tables as Markdown (for docs/SKILL-SELECTION.md and a pull request)
//   --write-baseline   write tests/fixtures/skill-selection-baseline.json from this run (the ratchet of tests/verify-skill-selection-baseline.mjs)
//
// The columns:
//   exact      rows where every expected skill was selected and nothing was selected that is neither expected nor acceptable
//   recall     expected skills that were selected / expected skills (two skills that do the same job count as one expectation)
//   precision  selected skills that are expected or acceptable / selected skills
//   over       rows that expect NOTHING where something that is not acceptable was selected / rows that expect nothing
//   silent     rows that expect a skill where NOTHING was selected / rows that expect a skill
//   missed -> catalog   for each expected skill that was not selected: does the skill index still name it to the model, so that the model could read it with skill_load?
//              "described" = id, name and the first 110 bytes of the description; "id only"; "absent" = the model is told nothing of it
import fs from 'node:fs/promises';
import path from 'node:path';
import { BASELINE_FILE, CATEGORIES, LANGUAGES, SETS, baselineOf, measureSkillSelection } from '../support/skill-selection-measure.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const known = new Set(['--json', '--failures', '--markdown', '--write-baseline']);
for (const [at, arg] of args.entries()) {
  if (arg.startsWith('--') ? !known.has(arg) : !['--json', '--failures'].includes(args[at - 1])) { console.error(`unknown argument: ${arg}`); process.exit(2); }
}
const shown = Number.parseInt(valueOf('--failures', '20'), 10);
if (!Number.isInteger(shown) || shown < 0) { console.error('--failures takes a number'); process.exit(2); }
const markdown = flag('--markdown');

const result = await measureSkillSelection();

const percent = (part, whole) => (whole ? `${(100 * part / whole).toFixed(1)}% (${part}/${whole})` : `n/a (0/0)`);
const HEAD = ['', 'rows', 'exact', 'recall', 'precision', 'over', 'silent', 'missed -> catalog: described / id only / absent'];
const line = (name, c) => [name, String(c.rows), percent(c.exact, c.rows), percent(c.groupsSelected, c.groups), percent(c.selectedAllowed, c.selected),
  percent(c.overSelected, c.expectNothing), percent(c.nothingSelected, c.expectSomething), `${c.missed}: ${c.missedDescribed} / ${c.missedIdOnly} / ${c.missedAbsent}`];

function table(title, head, lines) {
  console.log(`\n${markdown ? '### ' : ''}${title}\n`);
  if (markdown) {
    console.log(`| ${head.join(' | ')} |`);
    console.log(`|${head.map((_, at) => (at === 0 ? ' --- ' : ' ---: ')).join('|')}|`);
    for (const cells of lines) console.log(`| ${cells.join(' | ')} |`);
    return;
  }
  const widths = head.map((cell, at) => Math.max(cell.length, ...lines.map((cells) => cells[at].length)));
  const row = (cells) => cells.map((cell, at) => (at === 0 ? cell.padEnd(widths[at]) : cell.padStart(widths[at]))).join('  ');
  console.log(row(head));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const cells of lines) console.log(row(cells));
}

console.log(`Skill selection over ${result.overall.rows} labelled requests (corpus fingerprint ${result.fingerprint.slice(0, 12)})`);
const present = (keys, counts) => keys.filter((key) => counts[key]).map((key) => line(key, counts[key]));
table('By set of enabled skills', HEAD, [...present(SETS, result.bySet), line('ALL', result.overall)]);
table('By language', HEAD, present(LANGUAGES, result.byLanguage));
table('By category', HEAD, present(CATEGORIES, result.byCategory));
table('By set and language', HEAD, present(SETS.flatMap((set) => LANGUAGES.map((lang) => `${set} / ${lang}`)), result.bySetLanguage));
table('By set and category', HEAD, present(SETS.flatMap((set) => CATEGORIES.map((category) => `${set} / ${category}`)), result.bySetCategory));

const o = result.overall;
table('Rows where a skill marked mustNot was selected', ['', 'rows with a mustNot', 'a mustNot skill selected'],
  [...SETS.map((set) => [set, String(result.bySet[set].mustNotRows), percent(result.bySet[set].mustNotSelected, result.bySet[set].mustNotRows)]), ['ALL', String(o.mustNotRows), percent(o.mustNotSelected, o.mustNotRows)]]);

table('What the catalog of the skill index names when NOTHING is selected (default allowance)', ['skills turned on', 'form', 'named', 'not named', 'index bytes', 'skill_load offered'],
  result.catalogScale.map((entry) => [String(entry.skills), entry.form === 'lines' ? 'id, name, description' : entry.form === 'names' ? 'ids only' : 'no catalog', String(entry.named), String(entry.notNamed), `${entry.bytes}/${entry.maxBytes}`, entry.tool ? 'yes' : 'no']));

const reasons = (why) => (why.length ? why.map((item) => (item.kind === 'project' ? `project(${item.label})` : `${item.kind}:${item.word}${item.via ? `<-"${item.via}"` : ''}`)).join(' ') : 'no word of the request matched');
const context = (entry) => `${entry.earlier ? ` [after: ${entry.earlier.map((text) => JSON.stringify(text)).join(', ')}]` : ''}${entry.project ? ` [project: ${entry.project.join(', ')}]` : ''}`;

console.log(`\n${markdown ? '### ' : ''}Missed: an expected skill was not selected (${result.failures.missed.length} in all; the first ${Math.min(shown, result.failures.missed.length)}, lowest score first)\n`);
for (const entry of result.failures.missed.slice(0, shown)) {
  console.log(`${markdown ? '- ' : '  '}${entry.id} (${entry.set}, ${entry.lang}, ${entry.category}) ${JSON.stringify(entry.prompt)}${context(entry)}`);
  console.log(`      expected ${entry.expected.join(' or ')}: score ${entry.score} of 3 (${reasons(entry.why)}); selected instead: ${entry.selected.join(', ') || 'nothing'}; in the catalog: ${entry.catalog.replace('_', ' ')}`);
}
console.log(`\n${markdown ? '### ' : ''}Over-selected: a skill that is neither expected nor acceptable was selected (${result.failures.overSelected.length} in all; the first ${Math.min(shown, result.failures.overSelected.length)}, highest score first)\n`);
for (const entry of result.failures.overSelected.slice(0, shown)) {
  console.log(`${markdown ? '- ' : '  '}${entry.id} (${entry.set}, ${entry.lang}, ${entry.category}) ${JSON.stringify(entry.prompt)}${context(entry)}`);
  console.log(`      selected ${entry.skill}${entry.mustNot ? ' (marked mustNot)' : ''}: score ${entry.score} (${reasons(entry.why)})${entry.from === 'earlier' ? ', taken from an earlier prompt' : ''}; expected: ${entry.expected.map((item) => (Array.isArray(item) ? item.join(' or ') : item)).join(', ') || 'nothing'}`);
}

const jsonFile = valueOf('--json', '');
if (jsonFile) {
  await fs.mkdir(path.dirname(path.resolve(jsonFile)), { recursive: true });
  await fs.writeFile(jsonFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nwrote ${jsonFile}`);
}
if (flag('--write-baseline')) {
  await fs.writeFile(BASELINE_FILE, `${JSON.stringify(baselineOf(result), null, 2)}\n`);
  console.log(`\nwrote ${path.relative(process.cwd(), BASELINE_FILE)}`);
}
