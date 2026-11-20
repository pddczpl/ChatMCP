// Rebuilds tests/fixtures/patches/git-corpus.json: real unified diffs mined from THIS repository's own history (Apache-2.0), the oracle corpus of
// tests/verify-patch-apply.mjs. Each case is `git diff -U3 -M <parent> <commit> -- <paths>` with the blobs before and after, so the suite can apply the
// diff to the old blobs with lib/patch-apply.mjs and with `git apply` in a temp folder and compare both, byte for byte, with the blobs of the commit.
//
//   node tests/support/mine-patch-corpus.mjs            # from the pinned commit below
//   node tests/support/mine-patch-corpus.mjs --to <ref> # from another commit (the output names it)
//
// The walk is deterministic: first-parent history of the pinned commit, newest first, every non-merge commit, each changed file put in the first
// category whose quota is not full. Nothing of git's own test suite is used (git is GPL-2.0).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = path.resolve(HUB, '..');
const OUT = path.join(HUB, 'tests', 'fixtures', 'patches', 'git-corpus.json');
const PINNED = 'ea49701a';
const toIndex = process.argv.indexOf('--to');
const TO = toIndex > 0 ? process.argv[toIndex + 1] : PINNED;

const MAX_BLOB = 24 * 1024;
const MAX_PATCH = 16 * 1024;
const MAX_COMMITS = 1300;

// Quotas, in the order a changed file is offered to them. A file goes to the first category whose test accepts it and whose quota is not full.
const CATEGORIES = [
  { name: 'crlf', quota: 5, test: (c) => c.status === 'M' && c.oldCrlf },
  { name: 'no-final-newline', quota: 3, test: (c) => c.status === 'M' && (c.oldNoEol || c.newNoEol) },
  { name: 'rename-edit', quota: 4, test: (c) => c.status === 'R' && c.score < 100 },
  { name: 'rename', quota: 3, test: (c) => c.status === 'R' && c.score === 100 },
  { name: 'delete', quota: 4, test: (c) => c.status === 'D' },
  { name: 'add', quota: 4, test: (c) => c.status === 'A' },
  { name: 'mjs', quota: 10, test: (c) => c.status === 'M' && /\.m?js$/.test(c.path) },
  { name: 'md', quota: 7, test: (c) => c.status === 'M' && /\.md$/.test(c.path) },
  { name: 'json', quota: 4, test: (c) => c.status === 'M' && /\.json$/.test(c.path) },
  { name: 'ts', quota: 6, test: (c) => c.status === 'M' && /\.tsx?$/.test(c.path) },
  { name: 'cs', quota: 4, test: (c) => c.status === 'M' && /\.cs$/.test(c.path) },
  { name: 'ps1', quota: 3, test: (c) => c.status === 'M' && /\.(ps1|cmd)$/.test(c.path) },
  { name: 'yml', quota: 3, test: (c) => c.status === 'M' && /\.ya?ml$/.test(c.path) },
  { name: 'css-html', quota: 3, test: (c) => c.status === 'M' && /\.(css|html)$/.test(c.path) },
  { name: 'other', quota: 3, test: (c) => c.status === 'M' && /\.(txt|py|xml|csproj|iss|wxs|gitattributes)$/.test(c.path) },
];
const MULTI_QUOTA = 6; // whole commits with 2-4 small text files, all kinds mixed

function git(args, { allowFail = false } = {}) {
  const result = spawnSync('git', ['-c', 'core.quotePath=true', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'core.autocrlf=false', ...args], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  }
  return result.stdout;
}

const DIFF = ['diff', '-U3', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

function blob(commit, file) {
  const bytes = git(['cat-file', 'blob', `${commit}:${file}`], { allowFail: true });
  if (!bytes || bytes.length > MAX_BLOB || bytes.includes(0)) return null;
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null; // not UTF-8: the engine works on strings
  return text;
}

function changes(commit) {
  const out = git(['diff', '--name-status', '-z', '-M', `${commit}^`, commit], { allowFail: true });
  if (!out) return [];
  const fields = out.toString('utf8').split('\0').filter((field) => field !== '');
  const list = [];
  for (let i = 0; i < fields.length;) {
    const code = fields[i++];
    const status = code[0];
    if (status === 'R' || status === 'C') list.push({ status, score: Number(code.slice(1)), oldPath: fields[i++], path: fields[i++] });
    else { const file = fields[i++]; list.push({ status, oldPath: file, path: file }); }
  }
  return list;
}

function describe(commit, change) {
  const before = change.status === 'A' ? null : blob(`${commit}^`, change.oldPath);
  const after = change.status === 'D' ? null : blob(commit, change.path);
  if ((change.status !== 'A' && before === null) || (change.status !== 'D' && after === null)) return null;
  return {
    ...change, before, after,
    oldCrlf: before !== null && before.includes('\r\n'),
    oldNoEol: before !== null && before.length > 0 && !before.endsWith('\n'),
    newNoEol: after !== null && after.length > 0 && !after.endsWith('\n'),
  };
}

function makeCase(commit, list, category) {
  const paths = [...new Set(list.flatMap((c) => [c.oldPath, c.path]))];
  const patch = git([...DIFF, `${commit}^`, commit, '--', ...paths]).toString('utf8');
  if (patch.length === 0 || patch.length > MAX_PATCH || /^(Binary files|GIT binary patch)/m.test(patch)) return null;
  const before = {};
  const after = {};
  for (const c of list) {
    if (c.before !== null) before[c.oldPath] = c.before;
    if (c.status === 'R') after[c.oldPath] = null;
    if (c.status === 'D') after[c.path] = null; else after[c.path] = c.after;
  }
  return { id: '', category, commit, parent: `${commit}^`, paths, patch, before, after };
}

const commits = git(['rev-list', '--first-parent', '--no-merges', `--max-count=${MAX_COMMITS}`, TO]).toString('utf8').trim().split('\n');
const resolvedTo = git(['rev-parse', TO]).toString('utf8').trim();
const counts = Object.fromEntries(CATEGORIES.map((c) => [c.name, 0]));
let multi = 0;
const cases = [];
const seenPaths = new Set();

for (const commit of commits) {
  const all = changes(commit);
  if (multi < MULTI_QUOTA && all.length >= 2 && all.length <= 4 && all.every((c) => c.status !== 'C')) {
    const described = all.map((c) => describe(commit, c));
    if (described.every(Boolean)) {
      const made = makeCase(commit, described, 'multi-file');
      if (made) { cases.push(made); multi += 1; continue; }
    }
  }
  for (const change of all) {
    if (change.status === 'C' || seenPaths.has(change.path)) continue;
    if (CATEGORIES.every((c) => counts[c.name] >= c.quota)) break;
    const described = describe(commit, change);
    if (!described) continue;
    const target = CATEGORIES.find((c) => counts[c.name] < c.quota && c.test(described));
    if (!target) continue;
    const made = makeCase(commit, [described], target.name);
    if (!made) continue;
    counts[target.name] += 1;
    seenPaths.add(change.path);
    cases.push(made);
  }
  if (multi >= MULTI_QUOTA && CATEGORIES.every((c) => counts[c.name] >= c.quota)) break;
}

cases.forEach((c, index) => { c.id = `${String(index + 1).padStart(3, '0')}-${c.category}`; });
const corpus = {
  what: 'Unified diffs mined from this repository\'s own git history (Apache-2.0) by tests/support/mine-patch-corpus.mjs; the oracle corpus of tests/verify-patch-apply.mjs.',
  minedFrom: resolvedTo,
  command: DIFF.join(' ') + ' <parent> <commit> -- <paths>',
  counts: { ...counts, 'multi-file': multi, total: cases.length },
  cases,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(corpus, null, 1) + '\n', 'utf8');
console.log(`wrote ${cases.length} cases to ${path.relative(HUB, OUT)}`, corpus.counts);
