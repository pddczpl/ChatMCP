// How fast is search_files on a big tree? (multi-agent-tools-19: "48k files in under 1000 ms, finds src/d0/needle.js and never generated/")
//
//   node tests/probe-search-scale.mjs [--files 48000] [--runs 3] [--budget-ms 1000] [--tree <folder>] [--keep] [--enforce]
//
// It builds (or reuses, with --tree) a workspace of N small source files in folders of 100, one needle in src/d0/needle.js and another in generated/needle.js, which the
// .gitignore of the repository excludes; then it times search_files and find_files through LocalTools with every engine this machine has:
//   ripgrep  the Ripgrep class (bundled, CHATMCP_RIPGREP, or rg on PATH)
//   git      the built-in search over the file list of Git (.gitignore honoured)
//   walk     the built-in search over a walk of the tree (what every release before ripgrep did; it gives up after 40,000 entries or 10 s)
// and checks that each result holds src/d0/needle.js and not generated/needle.js. The numbers belong to the machine: file systems that scan every file that is opened (Windows
// with a real-time antivirus) make 48,000 opens cost seconds whatever the engine is. Not run by tests/run-all.mjs (the name does not start with verify-); --enforce makes the
// exit code say whether ripgrep met the budget.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalTools } from '../lib/local-tools.mjs';
import { Ripgrep } from '../lib/ripgrep.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';

const options = { files: 48000, runs: 3, budgetMs: 1000, tree: '', keep: false, enforce: false };
for (let at = 2; at < process.argv.length; at += 1) {
  const arg = process.argv[at];
  if (arg === '--files') options.files = Number(process.argv[++at]);
  else if (arg === '--runs') options.runs = Number(process.argv[++at]);
  else if (arg === '--budget-ms') options.budgetMs = Number(process.argv[++at]);
  else if (arg === '--tree') options.tree = path.resolve(process.argv[++at]);
  else if (arg === '--keep') options.keep = true;
  else if (arg === '--enforce') options.enforce = true;
  else { console.error(`unknown option ${arg}`); process.exit(2); }
}

const created = !options.tree;
const tree = options.tree || await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-scale-'));
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-scale-state-'));
const marker = path.join(tree, '.scale-tree');
try {
  const reuse = await fs.readFile(marker, 'utf8').then((text) => text.trim() === String(options.files), () => false);
  if (!reuse) {
    const started = Date.now();
    await fs.mkdir(tree, { recursive: true });
    await fs.writeFile(path.join(tree, '.gitignore'), 'generated/\n.scale-tree\n');
    const filler = 'export function value() {\n  return 42;\n}\nexport const name = "file";\n// lorem ipsum dolor sit amet consectetur\n';
    for (let directory = 0; directory * 100 < options.files; directory += 1) {
      const folder = path.join(tree, 'src', `d${directory}`);
      await fs.mkdir(folder, { recursive: true });
      await Promise.all(Array.from({ length: Math.min(100, options.files - directory * 100) }, (_, at) => fs.writeFile(path.join(folder, `f${at}.js`), `// file ${directory}/${at}\n${filler}`)));
    }
    await fs.writeFile(path.join(tree, 'src', 'd0', 'needle.js'), 'export const needle = "the-one-needle";\n');
    await fs.mkdir(path.join(tree, 'generated'), { recursive: true });
    await fs.writeFile(path.join(tree, 'generated', 'needle.js'), 'export const needle = "the-one-needle";\n');
    execFileSync('git', ['init', '-q'], { cwd: tree });
    await fs.writeFile(marker, String(options.files));
    console.log(`built ${options.files} files in ${Math.round((Date.now() - started) / 1000)} s: ${tree}`);
  } else console.log(`reusing ${options.files} files in ${tree}`);

  const workspace = new StudioWorkspace({ manager: { workspace: tree, secrets: [] }, directory: state });
  const ripgrep = new Ripgrep();
  const info = await ripgrep.info();
  console.log(info ? `ripgrep ${info.version} from ${info.source} (${info.path}), PCRE2 ${info.pcre2 ? 'yes' : 'no'}` : `no ripgrep (${ripgrep.problem}): only the built-in engines are measured`);
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
  const engines = [
    ...(info ? [['ripgrep', new LocalTools({ workspace, stateDirectory: state, ripgrep })]] : []),
    ['git', new LocalTools({ workspace, stateDirectory: state })],
    ['walk', new LocalTools({ workspace, stateDirectory: state }), { include_ignored: true }],
  ];
  const rows = [];
  for (const [engine, tools, extra = {}] of engines) {
    for (const [tool, args] of [['search_files', { pattern: 'the-one-needle', ...extra }], ['search_files', { pattern: 'the-one-\\w+', regex: true, ...extra }], ['find_files', { pattern: '**/needle.js', ...extra }]]) {
      const times = [];
      let last = null;
      // the walk takes up to 10 s a time, and once is enough to show it
      for (let run = 0; run < (engine === 'walk' ? 1 : options.runs); run += 1) {
        const started = process.hrtime.bigint();
        last = await tools.call(tool, args);
        times.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      const text = last.content.map((part) => part.text).join('\n');
      const found = text.includes('src/d0/needle.js');
      const leaked = text.includes('generated/needle.js');
      // the walk is asked with include_ignored (it cannot know .gitignore), so generated/ is expected there
      const correct = last.isError === false && found && (extra.include_ignored ? true : !leaked);
      rows.push({ engine, tool: `${tool}${args.regex ? ' (regex)' : ''}`, engineSaid: last.structuredContent?.engine, p50: percentile(times, 0.5), p95: percentile(times, 0.95), correct, truncated: Boolean(last.structuredContent?.truncated) });
    }
  }
  console.log(`\n${'engine'.padEnd(9)}${'tool'.padEnd(22)}${'p50 ms'.padStart(9)}${'p95 ms'.padStart(9)}  result`);
  for (const row of rows) {
    console.log(`${row.engine.padEnd(9)}${row.tool.padEnd(22)}${row.p50.toFixed(0).padStart(9)}${row.p95.toFixed(0).padStart(9)}  ${row.correct ? 'src/d0/needle.js found, generated/ not' : 'WRONG'}${row.truncated ? ' (truncated: the engine gave up)' : ''}${row.engineSaid && row.engineSaid !== row.engine ? ` [answered by ${row.engineSaid}]` : ''}`);
  }
  const wrong = rows.filter((row) => !row.correct && !row.truncated);
  const ripgrepRows = rows.filter((row) => row.engine === 'ripgrep');
  const slow = ripgrepRows.filter((row) => row.p95 > options.budgetMs);
  console.log(`\n${wrong.length ? `WRONG results: ${wrong.map((row) => `${row.engine} ${row.tool}`).join(', ')}\n` : ''}${ripgrepRows.length ? (slow.length ? `ripgrep p95 over the budget of ${options.budgetMs} ms: ${slow.map((row) => `${row.tool} ${row.p95.toFixed(0)} ms`).join(', ')}` : `ripgrep p95 within the budget of ${options.budgetMs} ms`) : 'no ripgrep, nothing to compare with the budget'}`);
  process.exitCode = wrong.length || (options.enforce && (slow.length || !ripgrepRows.length)) ? 1 : 0;
} finally {
  if (created && !options.keep) await fs.rm(tree, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
  await fs.rm(state, { recursive: true, force: true }).catch(() => {});
}
