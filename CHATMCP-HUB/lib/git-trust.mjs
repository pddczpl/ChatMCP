// What a repository's own configuration can make Git do.
//
// Git runs programs that the repository names: core.fsmonitor on `git status`, a clean filter when it compares a file, a
// textconv driver on `git diff`, a hook on `git commit`, a credential helper on `git push`. A folder that was downloaded or
// copied carries somebody else's .git/config and hooks, so "git status" is not always a harmless read.
//
// The Hub's own Git tools switch off what they can on the command line (git-runner.mjs) and refuse the rest. A command that the
// agent types into the shell cannot be rewritten, so this module reads the configuration and tells the permission check which
// Git commands would run the repository's programs; those are put in front of the person instead of running by themselves.
//
// Only the repository's own files are read (.git/config, .git/config.worktree, the hooks folder). The person's global and system
// configuration is theirs and trusted. Values are never returned, only the names of the settings: they may hold credentials.
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_CONFIG_BYTES = 512 * 1024;
const BOOLEANS = new Set(['', 'true', 'false', 'yes', 'no', 'on', 'off', '0', '1']);

/** Git LFS writes exactly these filter settings (the "--skip" forms are `git lfs install --skip-smudge`); they run the installed git-lfs and nothing else. */
const LFS_FILTER = Object.freeze({
  clean: ['git-lfs clean -- %f'],
  smudge: ['git-lfs smudge -- %f', 'git-lfs smudge --skip -- %f'],
  process: ['git-lfs filter-process', 'git-lfs filter-process --skip'],
});

// ---------------------------------------------------------------------------------------------------------------------
// Parsing (git-config(1) syntax, as far as detection needs it)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Reads the text of a git config file into entries { section, subsection, key, value }. Section and key names are lower-cased
 * (Git compares them case-insensitively); a subsection keeps its spelling. A key with no "=" has the value null (boolean true).
 * Lines that cannot be understood are skipped.
 */
export function parseGitConfig(text) {
  const entries = [];
  let section = '';
  let subsection = null;
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].replace(/^[\s﻿]+/, '');
    if (!line || line[0] === '#' || line[0] === ';') continue;
    if (line[0] === '[') {
      const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/.exec(line);
      if (!header) continue;
      const [, name, quoted, rest] = header;
      if (quoted !== undefined) { section = name.toLowerCase(); subsection = quoted.replace(/\\(.)/g, '$1'); }
      else if (name.includes('.')) { const at = name.indexOf('.'); section = name.slice(0, at).toLowerCase(); subsection = name.slice(at + 1).toLowerCase(); }
      else { section = name.toLowerCase(); subsection = null; }
      line = rest.replace(/^\s+/, '');
      if (!line || line[0] === '#' || line[0] === ';') continue;
    }
    // A value may continue on the next line after a trailing backslash.
    while (line.endsWith('\\') && !line.endsWith('\\\\') && index + 1 < lines.length) { index += 1; line = `${line.slice(0, -1)}${lines[index]}`; }
    const variable = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:(=)\s*(.*))?$/.exec(line);
    if (!variable || !section) continue;
    const [, key, equals, raw = ''] = variable;
    entries.push({ section, subsection, key: key.toLowerCase(), value: equals ? unquoteValue(raw) : null });
  }
  return entries;
}

function unquoteValue(raw) {
  let out = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'b' ? '\b' : next;
      i += 1;
    } else if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '#' || ch === ';')) break;
    else out += ch;
  }
  return out.replace(/\s+$/, '');
}

// ---------------------------------------------------------------------------------------------------------------------
// What the settings can do
// ---------------------------------------------------------------------------------------------------------------------

/**
 * How a Git command is affected by a setting that names a program:
 *   all      - any command may run it (index refresh, content comparison, diff, merge...)
 *   hooks    - only commands that run hooks (commit, checkout, switch, merge, rebase, push...)
 *   network  - only commands that talk to a remote (they already need approval)
 * `runner` says what the Hub's own Git tools do: 'neutralized' (switched off on the command line), 'refuse' (the tools stop), or
 * 'ignore' (they never reach the setting).
 */
function classify({ section, subsection, key, value }) {
  const full = subsection ? `${section}.${subsection}.${key}` : `${section}.${key}`;
  const name = `${section}.${key}`;
  const risk = (kind, affects, runner) => ({ key: full, kind, affects, runner });
  const has = value !== null && value !== '';
  if (name === 'core.fsmonitor') return has && !BOOLEANS.has(String(value).toLowerCase()) ? risk('fsmonitor', 'all', 'neutralized') : null;
  if (name === 'core.hookspath') return has ? risk('hooks', 'hooks', 'neutralized') : null;
  if (name === 'core.pager' || name === 'core.editor' || name === 'diff.external') return has ? risk('program', 'all', 'neutralized') : null;
  if (name === 'core.worktree') return has ? risk('worktree', 'all', 'ignore') : null;
  if (name === 'core.alternaterefscommand') return has ? risk('program', 'all', 'refuse') : null;
  if (name === 'core.askpass' || name === 'core.sshcommand' || name === 'core.gitproxy') return has ? risk('program', 'network', 'ignore') : null;
  if (section === 'credential' && key === 'helper') return has ? risk('credential-helper', 'network', 'ignore') : null;
  if (section === 'remote' && ['vcs', 'uploadpack', 'receivepack', 'proxy'].includes(key)) return has ? risk('program', 'network', 'ignore') : null;
  if (section === 'gpg' && key === 'program') return has ? risk('gpg', 'all', 'refuse') : null;
  if (section === 'gpg' && subsection && key === 'program') return has ? risk('gpg', 'all', 'refuse') : null;
  if (section === 'diff' && subsection && (key === 'command' || key === 'textconv')) return has ? risk('diff-driver', 'all', 'refuse') : null;
  if (section === 'merge' && subsection && key === 'driver') return has ? risk('merge-driver', 'all', 'refuse') : null;
  if (section === 'include' && key === 'path') return risk('include', 'all', 'refuse');
  if (section === 'includeif' && key === 'path') return risk('include', 'all', 'refuse');
  if (section === 'filter' && subsection && ['clean', 'smudge', 'process'].includes(key)) {
    if (subsection.toLowerCase() === 'lfs' && LFS_FILTER[key].includes(value)) return null;
    return has ? risk('filter', 'all', 'refuse') : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the repository
// ---------------------------------------------------------------------------------------------------------------------

const readSmall = async (file) => {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return stat.isFile() ? { tooLarge: true } : null;
    return { text: await fs.readFile(file, 'utf8') };
  } catch { return null; }
};

/** Finds the directories that hold the repository's files. `.git` can be a folder, or a file that points at one (worktrees, submodules). */
export async function locateGitDirectories(root) {
  const dotGit = path.join(root, '.git');
  let stat;
  try { stat = await fs.lstat(dotGit); } catch { return null; }
  if (stat.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  if (!stat.isFile()) return null;
  const pointer = await readSmall(dotGit);
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(pointer?.text ?? '')?.[1];
  if (!target) return { gitDir: null, commonDir: null, unreadable: true };
  const gitDir = path.resolve(root, target);
  const common = await readSmall(path.join(gitDir, 'commondir'));
  const commonDir = common?.text?.trim() ? path.resolve(gitDir, common.text.trim()) : gitDir;
  return { gitDir, commonDir };
}

/**
 * Looks at the repository in `root` and reports what it could make Git run.
 *
 * @returns {Promise<{repository: boolean, risks: {key:string, kind:string, affects:string, runner:string}[], hooks: string[], unreadable: boolean}>}
 *   `risks` list setting names only. `hooks` are the hook files that are switched on (a hook named *.sample is inert).
 */
export async function inspectGitSafety(root, { hooks: wantHooks = true } = {}) {
  const found = await locateGitDirectories(root);
  if (!found) return { repository: false, risks: [], hooks: [], unreadable: false };
  if (found.unreadable || !found.commonDir) return { repository: true, risks: [], hooks: [], unreadable: true };
  const risks = [];
  let unreadable = false;
  for (const file of [path.join(found.commonDir, 'config'), path.join(found.gitDir, 'config.worktree')]) {
    const content = await readSmall(file);
    if (!content) continue;
    if (content.tooLarge) { unreadable = true; risks.push({ key: path.basename(file), kind: 'include', affects: 'all', runner: 'refuse' }); continue; }
    for (const entry of parseGitConfig(content.text)) {
      const risk = classify(entry);
      if (risk && !risks.some((existing) => existing.key === risk.key)) risks.push(risk);
    }
  }
  const hooks = [];
  if (wantHooks) {
    // core.hooksPath replaces the folder; either way a file that is not a ".sample" will run.
    const folder = path.join(found.commonDir, 'hooks');
    try {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) if (entry.isFile() && !entry.name.endsWith('.sample') && !entry.name.startsWith('.')) hooks.push(entry.name);
    } catch { /* no hooks folder */ }
  }
  return { repository: true, risks, hooks, unreadable };
}

// ---------------------------------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------------------------------

/** Commands that run repository hooks. */
const HOOKED = new Set(['commit', 'merge', 'checkout', 'switch', 'rebase', 'am', 'cherry-pick', 'revert', 'pull', 'push', 'gc', 'applypatch', 'worktree', 'clone']);
/** Commands that talk to a remote. */
const NETWORKED = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'remote', 'submodule', 'archive', 'bundle', 'request-pull', 'send-email']);
/** Commands that never read the repository's configuration for anything that runs a program. */
const INERT = new Set(['--version', 'version', 'help', 'config']);

/** The first word of a git command line that is not an option: the subcommand. */
export function gitSubcommand(args) {
  for (const arg of args ?? []) {
    const word = String(arg);
    if (!word.startsWith('-')) return word.toLowerCase();
    if (word === '--version' || word === '-v') return '--version';
  }
  return '';
}

/**
 * The settings (and hook files) that would run a program of the repository if `git <subcommand>` ran now.
 * @returns {string[]} names such as "core.fsmonitor" or "hooks/pre-commit"; empty when nothing would run.
 */
export function gitRisksFor(subcommand, safety) {
  if (!safety?.repository) return [];
  const sub = String(subcommand ?? '').toLowerCase();
  if (INERT.has(sub)) return [];
  const names = [];
  for (const risk of safety.risks) {
    const applies = risk.affects === 'all'
      || (risk.affects === 'hooks' && (sub === '' || HOOKED.has(sub)))
      || (risk.affects === 'network' && (sub === '' || NETWORKED.has(sub)));
    if (applies) names.push(risk.key);
  }
  if (safety.hooks.length && (sub === '' || HOOKED.has(sub))) names.push(...safety.hooks.map((hook) => `hooks/${hook}`));
  if (safety.unreadable && !names.length) names.push('.git (không đọc được cấu hình)');
  return [...new Set(names)];
}

/** What the Hub's own Git tools cannot neutralise: they refuse to run when this is not empty. */
export const refusalsForRunner = (safety) => (safety?.repository ? safety.risks.filter((risk) => risk.runner === 'refuse').map((risk) => risk.key) : []);
