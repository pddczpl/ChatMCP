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
import path from 'node:path';
import { canonicalRelative } from './fs-safe.mjs';
import { isProtectedPath } from './protected-paths.mjs';

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
 * @param {{args?: string[], redirects?: {op: string, target: string}[]}[]} options.segments  from analyzeCommand()
 * @param {string} options.cwd   absolute directory the command will run in
 * @param {string} options.root  absolute workspace root
 * @param {boolean} [options.powershell]  the command runs in PowerShell, where provider drives exist
 * @returns {Promise<{word: string, problem: 'outside' | 'protected' | 'unresolvable' | 'provider'}[]>}
 */
export async function pathProblems({ segments = [], cwd, root, powershell = false }) {
  const words = [];
  for (const segment of segments) {
    for (const arg of segment.args ?? []) words.push(String(arg));
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
    const absolute = path.resolve(cwd, word);
    let canonical;
    try { canonical = await canonicalRelative(root, absolute); } catch { problems.push({ word, problem: 'unresolvable' }); continue; }
    if (!canonical.inside) problems.push({ word, problem: 'outside' });
    else if (isProtectedPath(canonical.relative)) problems.push({ word, problem: 'protected' });
  }
  return problems;
}

export const describeProblem = ({ word, problem }) => {
  const shown = word.length > 60 ? `${word.slice(0, 57)}...` : word;
  if (problem === 'outside') return `"${shown}" nằm ngoài workspace (qua symlink, junction hoặc tên rút gọn)`;
  if (problem === 'protected') return `"${shown}" thực chất là file bí mật hoặc metadata Git`;
  if (problem === 'provider') return `"${shown}" là ổ đĩa ảo của PowerShell (biến môi trường, registry, chứng chỉ), không phải file trong dự án`;
  return `không xác định được "${shown}" thật sự trỏ tới đâu`;
};
