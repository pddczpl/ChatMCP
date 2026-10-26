// THROWAWAY (proof branch only). Reads a Playwright JSON report of a --repeat-each loop and prints what was measured, as Markdown.
// Usage: node tmp-summarize.mjs <report.json> <label>      Exit code 1 when a repeat did not pass.
import fs from 'node:fs';

const [file, label = ''] = process.argv.slice(2);
if (!fs.existsSync(file)) { console.log(`### ${label}: no report was written (${file})`); process.exit(1); }
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const results = [];
const walk = (suites) => { for (const suite of suites ?? []) { for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) for (const result of test.results ?? []) results.push({ title: spec.title, repeat: test.repeatEachIndex ?? 0, ...result }); walk(suite.suites); } };
walk(report.suites);

const seconds = (ms) => (ms / 1000).toFixed(2);
const sorted = (values) => [...values].sort((a, b) => a - b);
const stats = (values) => {
  if (!values.length) return 'n/a';
  const s = sorted(values);
  return `min ${seconds(s[0])} s, median ${seconds(s[Math.floor(s.length / 2)])} s, p90 ${seconds(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))])} s, max ${seconds(s.at(-1))} s`;
};
const find = (steps, title) => { for (const step of steps ?? []) { if (step.title === title) return step; const deep = find(step.steps, title); if (deep) return deep; } return null; };

const failed = results.filter((result) => result.status !== 'passed');
const signatures = new Map();
for (const result of failed) {
  const first = String(result.errors?.[0]?.message ?? result.status).replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 140);
  signatures.set(first, (signatures.get(first) ?? 0) + 1);
}
const teardown = results.map((result) => find(result.steps, 'After Hooks')?.duration).filter((value) => typeof value === 'number');
const appTeardown = results.map((result) => find(result.steps, 'Fixture "app"')).filter(Boolean).map((step) => step.duration).filter((value) => typeof value === 'number');

console.log(`### ${label}: ${results.length} repeats of "${results[0]?.title ?? '?'}"`);
console.log('');
console.log(`- passed ${results.length - failed.length}, not passed ${failed.length}`);
console.log(`- the test, whole (body + teardown): ${stats(results.map((result) => result.duration))}`);
if (teardown.length) console.log(`- After Hooks (the teardown of the fixtures), ${teardown.length} measured: ${stats(teardown)}`);
if (appTeardown.length) console.log(`- the \`app\` fixture, its teardown included, ${appTeardown.length} measured: ${stats(appTeardown)}`);
for (const [signature, count] of signatures) console.log(`- ${count} x ${signature}`);
if (failed.length) console.log(`- repeats that did not pass: ${failed.map((result) => `#${result.repeat} (${result.status}, ${seconds(result.duration)} s)`).join(', ')}`);
process.exit(failed.length ? 1 : 0);
