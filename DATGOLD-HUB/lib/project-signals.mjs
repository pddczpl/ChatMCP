// What kind of project a workspace is, so that skill selection (lib/plugins.mjs) can prefer the skills that are about it. A request that says something about Docker
// is more likely to want the Docker skill in a folder that has a Dockerfile. What is read is only the file names of the workspace's root, the names of the dependencies in its
// package.json / pyproject.toml / requirements files, and nothing of the code. Nothing outside the root is looked at, a link is never followed, a file over the size
// limit is not read, and a folder that cannot be read has no signals (never an error): this runs at the start of every run and must not be able to stop one.
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_JSON_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_NAMES = 2000;
const MAX_LABEL = 64;
const DOCKER_FILES = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const PYTHON_FILES = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'];
const REQUIREMENTS = /^requirements[\w.-]*\.txt$/;
const SQLITE_FILE = /\.(sqlite3?|db3)$/i;
const FASTAPI = /(^|[\s"'[,])fastapi(?![\w-])/im;

// A name from the file system as a label: no control characters, and short.
const label = (text) => String(text).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_LABEL);
const lstatOf = (file) => fs.lstat(file).catch(() => null);

async function isFile(root, ...parts) {
  const stat = await lstatOf(path.join(root, ...parts));
  return Boolean(stat?.isFile());
}

// The first `limit` bytes of a regular file, or null when it is not one, is bigger than the limit, or cannot be read. A link is not a regular file.
async function readSmall(file, limit) {
  const stat = await lstatOf(file);
  if (!stat?.isFile() || stat.size > limit) return null;
  let handle;
  try {
    handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0);
    return bytesRead > limit ? null : buffer.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

const withoutComments = (text) => text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');

/**
 * The kinds of project a workspace is: [{ id, label, tokens }]. `tokens` are the words a skill is called (a word of its id or name) for the skill to count as being about the
 * kind. In this order: docker, github-actions, python, fastapi, react, sqlite; each at most once. Never throws.
 */
export async function detectProjectSignals(workspacePath) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) return [];
  const root = path.resolve(workspacePath);
  let names;
  try {
    names = (await fs.readdir(root)).slice(0, MAX_NAMES);
  } catch {
    return [];
  }
  const present = new Set(names);
  const signals = [];

  const dockerFile = DOCKER_FILES.find((name) => present.has(name));
  if (dockerFile && await isFile(root, dockerFile)) signals.push({ id: 'docker', label: label(dockerFile), tokens: ['docker'] });

  if (present.has('.github')) {
    const workflows = path.join(root, '.github', 'workflows');
    const github = await lstatOf(path.join(root, '.github'));
    const stat = github?.isDirectory() ? await lstatOf(workflows) : null;
    if (stat?.isDirectory()) {
      const files = await fs.readdir(workflows).catch(() => []);
      let found = false;
      for (const name of files.slice(0, MAX_NAMES)) {
        if (/\.ya?ml$/i.test(name) && await isFile(workflows, name)) { found = true; break; }
      }
      if (found) signals.push({ id: 'github-actions', label: '.github/workflows', tokens: ['github', 'actions'] });
    }
  }

  const requirements = names.filter((name) => REQUIREMENTS.test(name)).sort();
  const pythonFile = PYTHON_FILES.find((name) => present.has(name)) ?? requirements[0];
  if (pythonFile && await isFile(root, pythonFile)) {
    signals.push({ id: 'python', label: label(pythonFile), tokens: ['python', 'pytest'] });
    for (const name of [...(present.has('pyproject.toml') ? ['pyproject.toml'] : []), ...requirements.slice(0, 5)]) {
      const text = await readSmall(path.join(root, name), MAX_TEXT_BYTES);
      if (text !== null && FASTAPI.test(withoutComments(text))) { signals.push({ id: 'fastapi', label: label(`${name}: fastapi`), tokens: ['fastapi'] }); break; }
    }
  }

  if (present.has('package.json')) {
    const text = await readSmall(path.join(root, 'package.json'), MAX_JSON_BYTES);
    let manifest = null;
    try { manifest = text === null ? null : JSON.parse(text); } catch { manifest = null; }
    const uses = (section) => manifest !== null && typeof manifest === 'object' && typeof manifest[section] === 'object' && manifest[section] !== null && Object.hasOwn(manifest[section], 'react');
    if (['dependencies', 'devDependencies', 'peerDependencies'].some(uses)) signals.push({ id: 'react', label: 'package.json: react', tokens: ['react'] });
  }

  const database = names.filter((name) => SQLITE_FILE.test(name)).sort()[0];
  if (database && await isFile(root, database)) signals.push({ id: 'sqlite', label: label(database), tokens: ['sqlite'] });

  return signals;
}

/**
 * The first signal of `project` that a skill is about, or null: one of the skill's id or name words is one of the signal's tokens. A list that is not a list of signals, and
 * an entry that is not a signal, count for nothing.
 */
export function projectSignalFor(skill, project) {
  if (!Array.isArray(project) || !skill) return null;
  const called = new Set(`${skill.id ?? ''} ${skill.name ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  for (const signal of project) {
    if (signal === null || typeof signal !== 'object' || typeof signal.label !== 'string' || !Array.isArray(signal.tokens)) continue;
    if (signal.tokens.some((token) => typeof token === 'string' && called.has(token))) return signal;
  }
  return null;
}
