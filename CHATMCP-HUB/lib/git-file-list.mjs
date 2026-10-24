// The files of the workspace as Git lists them: the tracked files and the untracked ones that .gitignore (and the other standard exclusion rules) does not exclude. It is how the
// repository map and the file search leave out what the project itself calls generated or private, which a walk of the tree cannot know.
//
// It goes through the hardened GitRunner of the Hub (a repository can carry settings that make an ordinary read-only command run a program; the runner switches them off, scrubs the
// environment and refuses a repository whose own configuration names such a program), and asks for nothing that writes. When Git cannot answer, the answer is `null` and the
// caller walks the tree as it always did: no Git runner, a folder that is not a repository, a refusal, a time-out, or more output than a map of files should ever need.

import fs from 'node:fs/promises';
import path from 'node:path';

/** @typedef {{text: (args: string[], options?: object) => Promise<{code: number, stdout: string, truncated?: boolean, timedOut?: boolean}>}} GitLike */

/**
 * A check for the paths Git lists: true for a regular file that can be reached from `root` without crossing a link. Git for Windows lists what a junction points to as if it were a
 * folder of the workspace (so a folder outside it, or a second copy of one inside it, would be listed), and lstat of `link/file` follows the link; so every folder on the way is
 * lstat'ed too and must be a real folder. The files themselves are not lstat'ed one by one (48,000 of them cost seconds on Windows): each folder is read once, and its entries say
 * which names are regular files (a link, a folder and anything else is not one). A file that Git still lists after it was deleted is false too.
 * @returns {(relPath: string) => Promise<boolean>}
 */
export function createPlainFileChecker(root) {
  const folders = new Map();
  // the file systems of Windows and macOS do not tell `A.js` from `a.js`, and Git lists the name it has in its index
  const fold = process.platform === 'win32' || process.platform === 'darwin' ? (name) => name.toLowerCase() : (name) => name;
  const folder = (relative) => {
    let known = folders.get(relative);
    if (!known) {
      known = (async () => {
        if (relative !== '') {
          const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
          if (!(await folder(parent)).plain) return { plain: false, files: null };
          const stats = await fs.lstat(path.join(root, relative)).catch(() => null);
          if (!stats?.isDirectory() || stats.isSymbolicLink()) return { plain: false, files: null };
        }
        const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(() => null);
        if (!entries) return { plain: false, files: null };
        return { plain: true, files: new Set(entries.filter((entry) => entry.isFile()).map((entry) => fold(entry.name))) };
      })();
      folders.set(relative, known);
    }
    return known;
  };
  return async (relPath) => {
    const slash = relPath.lastIndexOf('/');
    const { plain, files } = await folder(slash < 0 ? '' : relPath.slice(0, slash));
    return plain && files.has(fold(slash < 0 ? relPath : relPath.slice(slash + 1)));
  };
}

/**
 * @param {GitLike|null|undefined} git
 * @param {{directory?: string, signal?: AbortSignal|null, timeoutMs?: number, maxBytes?: number}} [options] `directory`: a folder of the workspace, relative to its root ('' is the root)
 * @returns {Promise<string[]|null>} POSIX paths relative to the workspace root, each once, in the order Git gives them; null when Git cannot answer
 */
export async function listFilesWithGit(git, { directory = '', signal = null, timeoutMs = 15_000, maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!git || typeof git.text !== 'function') return null;
  signal?.throwIfAborted();
  // A pathspec is literal (a folder named ":(glob)x" or "*" is a folder), and a path after "--" is never an option.
  const spec = directory && directory !== '.' ? [`:(literal)${directory.replaceAll('\\', '/')}`] : [];
  let result;
  try {
    result = await git.text(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...spec], { signal, timeoutMs, maxBytes });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return null;
  }
  if (!result || result.code !== 0 || result.truncated || result.timedOut || typeof result.stdout !== 'string') return null;
  return [...new Set(result.stdout.split('\0').filter(Boolean))];
}
