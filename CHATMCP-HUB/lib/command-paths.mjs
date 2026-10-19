// The real places that the words of a shell command point to.
//
// The command analyser reads text. It can see that `cat notes.txt` takes a plain relative word and call the command harmless,
// but it cannot see that notes.txt is a symlink to ~/.ssh/id_rsa, a junction to another drive, a Windows 8.3 alias of .env, or
// that `echo x > build/out.txt` writes through a symlinked folder to somewhere outside the project. Those are decided by the
// file system, so a command that the analyser is willing to run unasked gets one more look here: every word that could be a
// path is followed to where it really lands, and a command whose words land outside the workspace, or on a secret, is
// put in front of the person instead of running by itself.
//
// PowerShell reaches further than files: Env:, HKCU:, HKLM:, Cert:, Variable: are "drives" whose items are environment variables
// (where API keys live), the registry and certificates. `Get-Content Env:OPENAI_API_KEY` reads a secret that no file path shows,
// and `FileSystem::C:\Users\me\.ssh\id_rsa` is a file path spelled so that it does not look like one.
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalRelative } from './fs-safe.mjs';
import { isProtectedPath } from './protected-paths.mjs';

// A wildcard is expanded by the shell AFTER the command was approved, so `cat ./*.json` also prints secrets.json and `cat ./*/x` follows
// a junction out of the project, while the text `./*.json` looks like one ordinary in-project file. The words with a wildcard are
// therefore expanded here against the real directory (the way a shell does it) and every match is judged like a word of its own.
const EXPANSION_LIMIT = 4000;
const hasWildcard = (value) => /[*?[]/.test(value);

function segmentPattern(segment) {
  let source = '';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if (ch === '[' && segment.indexOf(']', i + 2) !== -1) {
      const close = segment.indexOf(']', i + 2);
      let body = segment.slice(i + 1, close).replaceAll('\\', '\\\\');
      if (body[0] === '!') body = `^${body.slice(1)}`;
      source += `[${body}]`;
      i = close;
    } else source += ch.replace(/[\\^$.|+(){}[\]]/g, '\\$&');
  }
  try { return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : ''); } catch { return /^.*$/s; }
}

/** Absolute paths that `word` can expand to inside `cwd`, or null when there are too many to look at. A literal tail need not exist. */
async function expandWildcards(cwd, word) {
  const normalized = word.replaceAll('\\', '/');
  const rooted = path.isAbsolute(word);
  const rootPart = rooted ? path.parse(path.resolve(word)).root : '';
  const parts = (rooted ? normalized.slice(rootPart.length) : normalized).split('/').filter((part) => part !== '' && part !== '.');
  let bases = [rooted ? rootPart : cwd];
  let visited = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!hasWildcard(part)) { bases = bases.map((base) => path.join(base, part)); continue; }
    const pattern = segmentPattern(part);
    const next = [];
    for (const base of bases) {
      let entries;
      try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        visited += 1;
        if (visited > EXPANSION_LIMIT) return null;
        if (entry.name.startsWith('.') && !part.startsWith('.')) continue;
        if (!pattern.test(entry.name)) continue;
        if (i < parts.length - 1 && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        next.push(path.join(base, entry.name));
      }
    }
    bases = next;
    if (bases.length > EXPANSION_LIMIT) return null;
  }
  return bases;
}

// Programs that read the CONTENT of every file below a directory when given no file: `rg token` searches the whole tree, `diff a b` on two
// folders compares the files that have the same name in both. The text `rg token` names no secret, but secrets.json, credentials.json,
// id_rsa and *.pem are not hidden files, so a default recursive search prints them. Hidden entries are skipped (ripgrep skips them too, and
// every flag that would include them is not on the allowlist); noise folders are skipped; the walk is bounded.
const WALK_LIMIT = 20000;
const WALK_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv', 'coverage', '.next']);

async function protectedBelow(directory, root, state) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    state.visited += 1;
    if (state.visited > WALK_LIMIT) { state.exceeded = true; return null; }
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (WALK_SKIP.has(entry.name)) continue;
      const found = await protectedBelow(full, root, state);
      if (found || state.exceeded) return found;
    } else {
      let canonical;
      try { canonical = await canonicalRelative(root, full); } catch { continue; }
      if (canonical.inside && isProtectedPath(canonical.relative)) return canonical.relative;
    }
  }
  return null;
}

async function isDirectory(absolute) {
  try { return (await fs.lstat(absolute)).isDirectory(); } catch { return false; }
}

/** Problems for the recursive readers among `segments`; same shape as the word problems. */
async function recursiveReadProblems({ segments, cwd, root }) {
  const problems = [];
  for (const segment of segments) {
    const operands = (segment.files ?? []).filter((word) => !hasWildcard(word));
    if (segment.program === 'rg') {
      const targets = operands.length ? operands : ['.'];
      for (const target of targets) {
        const absolute = path.resolve(cwd, target);
        if (!await isDirectory(absolute)) continue;
        const state = { visited: 0, exceeded: false };
        const found = await protectedBelow(absolute, root, state);
        if (found) problems.push({ word: target, problem: 'protected', via: found });
        else if (state.exceeded) problems.push({ word: target, problem: 'unresolvable' });
      }
    } else if (segment.program === 'diff' && operands.length === 2) {
      const [left, right] = operands.map((word) => path.resolve(cwd, word));
      if (await isDirectory(left) && await isDirectory(right)) {
        let names;
        try { names = await fs.readdir(left); } catch { names = []; }
        for (const name of names.slice(0, WALK_LIMIT)) {
          if (!isProtectedPath(name)) continue;
          if (await fs.lstat(path.join(right, name)).then(() => true, () => false)) problems.push({ word: operands[0], problem: 'protected', via: name });
        }
      }
    }
  }
  return problems;
}

const MAX_WORDS = 64;
const MAX_WORD_LENGTH = 400;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
// A PowerShell provider, as a drive (Env:) or as a qualified path (Registry::HKEY_..., Microsoft.PowerShell.Core\FileSystem::...),
// optionally after a parameter name written with a colon (-Path:Env:FOO). Only the built-in providers are listed, so an ordinary
// word such as the "fix:" of a commit message is not mistaken for one.
const PS_PROVIDERS = 'env|variable|function|alias|cert|hklm|hkcu|hkcr|hku|hkcc|wsman|registry|certificate|environment|temp|filesystem';
const PS_PROVIDER = new RegExp(`^(?:-[A-Za-z]+:)?(?:[\\w.]+\\\\)?(?:${PS_PROVIDERS}):`, 'i');

/**
 * @param {object} options
 * @param {{args?: string[], files?: string[], redirects?: {op: string, target: string}[]}[]} options.segments  from analyzeCommand()
 * @param {string} options.cwd   absolute directory the command will run in
 * @param {string} options.root  absolute workspace root
 * @param {boolean} [options.powershell]  the command runs in PowerShell, where provider drives exist
 * @returns {Promise<{word: string, problem: 'outside' | 'protected' | 'unresolvable' | 'provider'}[]>}
 */
export async function pathProblems({ segments = [], cwd, root, powershell = false }) {
  const words = [];
  for (const segment of segments) {
    // A program with an allowlist names its real file operands (`files`); patterns, scripts and option values are data and must not be
    // resolved as paths. Any other program is judged by all of its words, as before.
    for (const arg of segment.files ?? segment.args ?? []) words.push(String(arg));
    for (const redirect of segment.redirects ?? []) if (redirect?.target) words.push(String(redirect.target));
  }
  const problems = [];
  const seen = new Set();
  for (const word of words) {
    if (seen.size >= MAX_WORDS) break;
    if (!word || word.includes('\0') || word.length > MAX_WORD_LENGTH || seen.has(word)) continue;
    if (powershell && PS_PROVIDER.test(word)) { seen.add(word); problems.push({ word, problem: 'provider' }); continue; }
    if (word.startsWith('-') || URL_LIKE.test(word)) continue;
    seen.add(word);
    if (hasWildcard(word)) {
      const matches = await expandWildcards(cwd, word);
      if (matches === null) { problems.push({ word, problem: 'unresolvable' }); continue; }
      let flagged = null;
      for (const match of matches) {
        let canonical;
        try { canonical = await canonicalRelative(root, match); } catch { flagged = 'unresolvable'; break; }
        if (!canonical.inside) { flagged = 'outside'; break; }
        if (isProtectedPath(canonical.relative)) { flagged = 'protected'; break; }
      }
      if (flagged) { problems.push({ word, problem: flagged }); continue; }
      if (matches.length) continue;
    }
    const absolute = path.resolve(cwd, word);
    let canonical;
    try { canonical = await canonicalRelative(root, absolute); } catch { problems.push({ word, problem: 'unresolvable' }); continue; }
    if (!canonical.inside) problems.push({ word, problem: 'outside' });
    else if (isProtectedPath(canonical.relative)) problems.push({ word, problem: 'protected' });
  }
  problems.push(...await recursiveReadProblems({ segments, cwd, root }));
  return problems;
}

export const describeProblem = ({ word, problem, via }) => {
  const shown = word.length > 60 ? `${word.slice(0, 57)}...` : word;
  if (problem === 'outside') return `"${shown}" nằm ngoài workspace (qua symlink, junction hoặc tên rút gọn)`;
  if (problem === 'protected' && via) return `"${shown}" chứa file bí mật (${via}) mà lệnh đọc đệ quy sẽ in ra`;
  if (problem === 'protected') return `"${shown}" thực chất là file bí mật hoặc metadata Git`;
  if (problem === 'provider') return `"${shown}" là ổ đĩa ảo của PowerShell (biến môi trường, registry, chứng chỉ), không phải file trong dự án`;
  return `không xác định được "${shown}" thật sự trỏ tới đâu`;
};
