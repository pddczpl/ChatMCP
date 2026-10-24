// The files of the workspace as Git lists them: the tracked files and the untracked ones that .gitignore (and the other standard exclusion rules) does not exclude. It is how the
// repository map and the file search leave out what the project itself calls generated or private, which a walk of the tree cannot know.
//
// It goes through the hardened GitRunner of the Hub (a repository can carry settings that make an ordinary read-only command run a program; the runner switches them off, scrubs the
// environment and refuses a repository whose own configuration names such a program), and asks for nothing that writes. When Git cannot answer, the answer is `null` and the
// caller walks the tree as it always did: no Git runner, a folder that is not a repository, a refusal, a time-out, or more output than a map of files should ever need.

/** @typedef {{text: (args: string[], options?: object) => Promise<{code: number, stdout: string, truncated?: boolean, timedOut?: boolean}>}} GitLike */

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
