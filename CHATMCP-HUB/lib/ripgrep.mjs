// The search the Hub does with ripgrep for search_files and find_files: which binary, the command line, what is read from its JSON and how its process ends.
//
// ripgrep is fast on a big tree and it knows .gitignore, which a walk of the tree in JavaScript does not. It is a helper with a fixed command line, not a tool the model can
// aim: the pattern is the value of -e, the folder is the one the Hub chose, there is no preprocessor, no configuration file, no shell and a scrubbed environment. It never
// writes anything. When it is missing, too old or fails, the caller searches as it always did; nothing here is needed for the tools to work.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVATE_DIRECTORIES } from './protected-paths.mjs';
import { scrubEnv } from './shell-runner.mjs';

/** Set to the absolute path of a binary to use that one. Anything else (off, 0, no ...) switches ripgrep off: there is no file such a value could name. */
export const RIPGREP_ENV = 'CHATMCP_RIPGREP';
/** Files above this size are not searched (the built-in search has the same limit). */
export const RIPGREP_FILE_BYTES = 1024 * 1024;
const MINIMUM_MAJOR_VERSION = 11;
const HUB_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEPT_LINE_CHARS = 400;
const PROBE_RETRY_MILLIS = 60_000;
const GLOB_NAME = /^[A-Za-z0-9._ -]+$/;

const fault = (code, message, statusCode = 500) => Object.assign(new Error(message), { code, statusCode });
const defaultIsFile = async (file) => { try { return (await fs.stat(file)).isFile(); } catch { return false; } };

// ------------------------------------------------------------------------------------------------------------------------------- which binary
export const ripgrepProgramName = (platform = process.platform) => (platform === 'win32' ? 'rg.exe' : 'rg');

/** Where the installer puts it: <hub>/runtimes/ripgrep. */
export const bundledRipgrepPath = (hubDirectory = HUB_DIRECTORY, platform = process.platform) => path.join(hubDirectory, 'runtimes', 'ripgrep', ripgrepProgramName(platform));

/**
 * The binary to use: the owner's own choice (CHATMCP_RIPGREP), else the one the installer bundles, else one on PATH; null when there is none. A choice that is not the absolute
 * path of a file (`off`, `0`, a path that does not exist ...) switches ripgrep off and is not replaced by another binary behind the owner's back. A PATH entry that is not an
 * absolute folder (the folder the Hub was started in, say) is never looked in.
 * @returns {Promise<{path: string, source: 'env'|'bundled'|'path'}|null>}
 */
export async function resolveRipgrep({ hubDirectory = HUB_DIRECTORY, env = process.env, platform = process.platform, isFile = defaultIsFile } = {}) {
  const choice = typeof env?.[RIPGREP_ENV] === 'string' ? env[RIPGREP_ENV].trim() : '';
  if (choice) return path.isAbsolute(choice) && await isFile(choice) ? { path: choice, source: 'env' } : null;
  const bundled = bundledRipgrepPath(hubDirectory, platform);
  if (await isFile(bundled)) return { path: bundled, source: 'bundled' };
  const name = ripgrepProgramName(platform);
  for (const raw of String(env?.PATH ?? env?.Path ?? '').split(path.delimiter)) {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!entry || !path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, name);
    if (await isFile(candidate)) return { path: candidate, source: 'path' };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------------------------------- the patterns
/**
 * Whether a regular expression (as written for JavaScript) uses what only PCRE2 has in ripgrep: lookahead, lookbehind, backreferences. An escaped parenthesis, a character class and
 * a named group alone do not.
 */
export function patternNeedsPcre2(pattern) {
  const text = String(pattern ?? '');
  let inClass = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '\\') {
      const next = text[at + 1];
      if (!inClass && ((next >= '1' && next <= '9') || (next === 'k' && text[at + 2] === '<'))) return true;
      at += 1;
      continue;
    }
    if (inClass) { if (char === ']') inClass = false; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === '(' && text[at + 1] === '?') {
      const kind = text[at + 2];
      if (kind === '=' || kind === '!') return true;
      if (kind === '<' && (text[at + 3] === '=' || text[at + 3] === '!')) return true;
    }
  }
  return false;
}

/**
 * The file name part of a glob as a ripgrep "file type": a superset of what the glob matches that ripgrep can apply while it walks (a file type is applied after .gitignore, where
 * a plain -g glob would bring ignored files back). The exact glob is applied afterwards by the caller. Null when no safe narrowing exists. With `caseInsensitive` (Windows) every
 * ASCII letter becomes a class of both cases, because a file type is case-sensitive.
 */
export function basenameTypeGlob(glob, { caseInsensitive = false } = {}) {
  if (typeof glob !== 'string') return null;
  const text = glob.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!text || text.endsWith('/') || /\{[^}]*\//.test(text)) return null;
  const name = text.slice(text.lastIndexOf('/') + 1);
  if (!name || name.includes('**') || name.includes(':') || /[\u0000-\u001f]/.test(name)) return null;
  if (!caseInsensitive) return name;
  if (name.includes('[') || /[^\u0000-\u007f]/.test(name)) return null;
  return name.replace(/[A-Za-z]/g, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
}

// ------------------------------------------------------------------------------------------------------------------------------- the command line
const exclusionGlobs = ({ includeIgnored, noiseNames, privateNames }) => {
  const globs = [];
  for (const name of privateNames) if (GLOB_NAME.test(name)) globs.push('-g', `!${name}`);
  if (!includeIgnored) for (const name of noiseNames) if (GLOB_NAME.test(name)) globs.push('-g', `!${name}/`);
  return globs;
};
const sizeLimit = (bytes) => (bytes % 1048576 === 0 ? `${bytes / 1048576}M` : String(bytes));
const commonArguments = ({ includeIgnored, noiseNames, privateNames, typeGlob }) => [
  '--no-config', '--no-messages', '--color', 'never', '--hidden',
  ...(includeIgnored ? ['--no-ignore'] : []),
  ...exclusionGlobs({ includeIgnored, noiseNames, privateNames }),
  ...(typeGlob ? ['--type-add', `cmglob:${typeGlob}`, '-t', 'cmglob'] : []),
];

/**
 * The arguments of a search, before `-- <path>`. Hidden files are searched (as the built-in search does) and so are files that .gitignore excludes only with `includeIgnored`; the
 * private folders (.git, .ssh ...) are never searched and the noise folders (node_modules ...) only with `includeIgnored`. The user's glob is deliberately not here: a -g glob
 * that includes files brings back what .gitignore excluded, so the caller narrows with `typeGlob` and checks the exact glob on what comes back.
 */
export function searchArguments({ pattern, regex = false, pcre2 = false, ignoreCase = false, context = 0, includeIgnored = false, noiseNames = [], privateNames = [], typeGlob = null, maxFileBytes = RIPGREP_FILE_BYTES }) {
  return [
    '--json', '--crlf', '--max-filesize', sizeLimit(maxFileBytes),
    ...(regex ? (pcre2 ? ['--pcre2'] : []) : ['-F']),
    ignoreCase ? '-i' : '-s',
    ...(context > 0 ? ['-C', String(context)] : []),
    ...commonArguments({ includeIgnored, noiseNames, privateNames, typeGlob }),
    '-e', pattern,
  ];
}

/** The arguments of a listing of files (paths end in NUL, so a name with a newline in it is safe), before `-- <path>`. */
export function fileListArguments({ includeIgnored = false, noiseNames = [], privateNames = [], typeGlob = null }) {
  return ['--files', '--null', ...commonArguments({ includeIgnored, noiseNames, privateNames, typeGlob })];
}

// ------------------------------------------------------------------------------------------------------------------------------- order and paths
/**
 * The order the built-in walk of the tree gives files in, and so the order of results: the files of a folder (by name), then its folders (by name), each folder the same way.
 */
export function compareWalkOrder(a, b) {
  const left = a.split('/');
  const right = b.split('/');
  const shared = Math.min(left.length, right.length);
  for (let at = 0; at < shared; at += 1) {
    if (left[at] === right[at]) continue;
    const leftIsFile = at === left.length - 1;
    const rightIsFile = at === right.length - 1;
    if (leftIsFile !== rightIsFile) return leftIsFile ? -1 : 1;
    return left[at] < right[at] ? -1 : 1;
  }
  return left.length - right.length;
}

/** A path as ripgrep prints it (Windows: `.\src\a.js`, or `src/lib\a.js` when the folder was given with a slash) as the workspace's `src/a.js`. */
export function normalizeRipgrepPath(text, platform = process.platform) {
  const slashed = platform === 'win32' ? String(text).replaceAll('\\', '/') : String(text);
  return slashed.replace(/\/{2,}/g, '/').replace(/^(?:\.\/)+/, '');
}

// ------------------------------------------------------------------------------------------------------------------------------- lines of output
class ByteSplitter {
  constructor(separator) {
    this.separator = separator;
    this.character = String.fromCharCode(separator);
    this.pending = Buffer.alloc(0);
  }

  /** The complete lines in what has arrived so far. A line is cut at the separator byte only, so a chunk that ends inside a character changes nothing. */
  push(chunk) {
    const buffer = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const last = buffer.lastIndexOf(this.separator);
    if (last < 0) { this.pending = Buffer.from(buffer); return []; }
    this.pending = Buffer.from(buffer.subarray(last + 1));
    return buffer.subarray(0, last).toString('utf8').split(this.character).filter((line) => line.length > 0);
  }

  /** What is left when the output ends without a final separator. */
  flush() {
    const rest = this.pending.toString('utf8');
    this.pending = Buffer.alloc(0);
    return rest.length > 0 ? [rest] : [];
  }
}
export class NdjsonSplitter extends ByteSplitter { constructor() { super(0x0a); } }
export class NulSplitter extends ByteSplitter { constructor() { super(0x00); } }

/**
 * What ripgrep's --json output says, kept as it is needed: the files with their matching and context lines, the number of matches, and what was left out. `accept` is asked once
 * per file (path in the form of `normalizeRipgrepPath`) and a file it refuses is not a result and does not count. `push(event)` answers `stop` when ripgrep need not go on: the
 * limit is reached and so is the context after the last match.
 * @returns {{push: (event: object) => 'continue'|'stop', finish: () => object}}
 */
export function createSearchCollector({ limit = Infinity, context = 0, accept = () => true, platform = process.platform } = {}) {
  const files = [];
  let current = null;
  let matches = 0;
  let searched = null;
  let skippedBinary = 0;
  let skippedEncoding = 0;
  let limited = false;
  let limitLine = 0;

  const view = (number, raw, match) => {
    const text = raw.replace(/\r?\n$/, '');
    return { number, match, text: text.length > KEPT_LINE_CHARS ? text.slice(0, KEPT_LINE_CHARS) : text, length: text.length, blank: text.trim() === '' };
  };
  const commit = () => {
    const done = current;
    current = null;
    if (!done?.accepted) return;
    if (done.binary) { skippedBinary += 1; matches -= done.matches; return; }
    if (done.bad) { skippedEncoding += 1; matches -= done.matches; return; }
    if (done.lines.length) files.push({ path: done.path, lines: done.lines });
  };
  const open = (data) => {
    commit();
    const named = typeof data?.path?.text === 'string';
    const file = named ? normalizeRipgrepPath(data.path.text, platform) : '';
    // a name that is not text cannot be checked against the protected names or shown: it is counted as a file that was not UTF-8
    current = { raw: named ? data.path.text : null, path: file, accepted: named ? Boolean(accept(file)) : true, bad: !named, binary: false, lines: [], matches: 0 };
  };

  return {
    push(event) {
      const data = event?.data;
      switch (event?.type) {
        case 'begin':
          open(data);
          return 'continue';
        case 'end':
          if (current && data?.binary_offset !== null && data?.binary_offset !== undefined) current.binary = true;
          commit();
          return limited ? 'stop' : 'continue';
        case 'summary':
          if (Number.isFinite(data?.stats?.searches)) searched = data.stats.searches;
          return 'continue';
        case 'match':
        case 'context': {
          if (!data) return 'continue';
          const name = typeof data.path?.text === 'string' ? data.path.text : null;
          if (!current || current.raw !== name) open(data);
          if (!current.accepted || current.bad) return 'continue';
          if (typeof data.lines?.text !== 'string') { current.bad = true; return 'continue'; }
          if (!Number.isInteger(data.line_number)) return 'continue';
          if (limited) {
            if (data.line_number > limitLine + context) return 'stop';
            current.lines.push(view(data.line_number, data.lines.text, false));
            return data.line_number >= limitLine + context ? 'stop' : 'continue';
          }
          const isMatch = event.type === 'match';
          current.lines.push(view(data.line_number, data.lines.text, isMatch));
          if (isMatch) {
            current.matches += 1;
            matches += 1;
            if (matches >= limit) {
              limited = true;
              limitLine = data.line_number;
              if (context === 0) return 'stop';
            }
          }
          return 'continue';
        }
        default:
          return 'continue';
      }
    },
    finish() {
      commit();
      return { files, matches, searched, skippedBinary, skippedEncoding, limited };
    },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------- the process
/**
 * Runs the program and ends it when the caller says `onChunk` has seen enough (it returns true), when the time is up, when `signal` is aborted (the promise then rejects with the
 * reason) and when it prints more than `maxOutputBytes`. It is never left running. No shell, no window.
 * @returns {Promise<{code: number|null, signal: string|null, stderr: string, stopped: boolean, timedOut: boolean, outputTruncated: boolean, pid: number|null}>}
 */
export async function runRipgrepProcess({ command, args, cwd, env, timeoutMs = 10_000, maxOutputBytes = 64 * 1024 * 1024, signal = null, spawner = spawn, onChunk = null, onSpawn = null }) {
  signal?.throwIfAborted();
  let child;
  try {
    child = spawner(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw fault('ripgrep_unavailable', `Không chạy được ripgrep: ${error.message}`, 503);
  }
  onSpawn?.(child);
  const result = { code: null, signal: null, stderr: '', stopped: false, timedOut: false, outputTruncated: false, pid: child.pid ?? null };
  const errors = [];
  let errorBytes = 0;
  let total = 0;
  let aborted = false;
  let killed = false;
  let failure = null;
  let release = () => {};
  let grace = null;
  const stop = () => {
    if (killed) return;
    killed = true;
    try { child.kill(); } catch { /* already gone */ }
    // a program that was told to stop has a few seconds to close its pipes; after that the answer no longer waits for it
    grace = setTimeout(() => release(), 3000);
  };
  child.stdout.on('data', (chunk) => {
    if (killed) return;
    total += chunk.length;
    if (total > maxOutputBytes) { result.outputTruncated = true; stop(); return; }
    try {
      if (onChunk && onChunk(chunk) === true) { result.stopped = true; stop(); }
    } catch (error) { failure = error; stop(); }
  });
  child.stderr.on('data', (chunk) => { if (errorBytes < 65_536) { errors.push(chunk); errorBytes += chunk.length; } });
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  const timer = setTimeout(() => { result.timedOut = true; stop(); }, timeoutMs);
  const onAbort = () => { aborted = true; stop(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      release = resolve;
      child.once('error', reject);
      child.once('close', (code, terminatedBy) => { result.code = code; result.signal = terminatedBy; resolve(); });
    });
  } catch (error) {
    throw fault('ripgrep_unavailable', `Không chạy được ripgrep: ${error.message}`, 503);
  } finally {
    clearTimeout(timer);
    clearTimeout(grace);
    signal?.removeEventListener('abort', onAbort);
  }
  if (aborted) throw signal.reason ?? fault('cancelled', 'Tác vụ đã dừng.', 499);
  if (failure) throw failure;
  result.stderr = Buffer.concat(errors).toString('utf8');
  return result;
}

// ------------------------------------------------------------------------------------------------------------------------------- the helper
const PATTERN_ERROR = /regex parse error|error parsing regex|error compiling|PCRE2: error/i;
const firstLines = (text, limit = 600) => String(text).trim().slice(0, limit);

export class Ripgrep {
  #cache = null;

  /**
   * @param {object} options
   * @param {Function} [options.spawner]  child_process.spawn-compatible
   * @param {() => string[]} [options.secrets]  values that must not reach the environment of the program
   * @param {(file: string) => Promise<boolean>} [options.isFile]
   * @param {() => number} [options.now]  the clock (tests)
   */
  constructor({ hubDirectory = HUB_DIRECTORY, env = process.env, platform = process.platform, spawner = spawn, secrets = () => [], isFile = defaultIsFile, now = Date.now } = {}) {
    this.hubDirectory = hubDirectory;
    this.env = env;
    this.platform = platform;
    this.spawner = spawner;
    this.secrets = secrets;
    this.isFile = isFile;
    this.now = now;
    /** Why ripgrep is not used, when it is not (for a log line or a test). */
    this.problem = null;
  }

  /**
   * The program, its version and whether it has PCRE2; null when there is none or it does not work. The answer is remembered; a null is asked again after a minute (the binary may
   * have been installed or repaired since), and a program that fails to start while it is used is forgotten at once.
   */
  info() {
    const cached = this.#cache;
    if (cached && !(cached.missing && this.now() - cached.at >= PROBE_RETRY_MILLIS)) return cached.promise;
    const entry = { at: this.now(), missing: false, promise: null };
    entry.promise = this.#probe().then((info) => { entry.missing = info === null; return info; });
    this.#cache = entry;
    return entry.promise;
  }

  #environment() {
    const environment = scrubEnv(this.env, { secrets: this.secrets() ?? [] });
    for (const key of Object.keys(environment)) if (/^RIPGREP_/i.test(key)) delete environment[key];
    return environment;
  }

  async #probe() {
    const found = await resolveRipgrep({ hubDirectory: this.hubDirectory, env: this.env, platform: this.platform, isFile: this.isFile });
    if (!found) { this.problem = 'no ripgrep binary'; return null; }
    const chunks = [];
    let run;
    try {
      run = await runRipgrepProcess({ command: found.path, args: ['--version'], cwd: os.tmpdir(), env: this.#environment(), timeoutMs: 10_000, maxOutputBytes: 64 * 1024, spawner: this.spawner, onChunk: (chunk) => { chunks.push(chunk); return false; } });
    } catch (error) { this.problem = error.message; return null; }
    const text = Buffer.concat(chunks).toString('utf8');
    const version = /^ripgrep\s+(\d+)\.(\d+)\.(\d+)/m.exec(text);
    if (run.code !== 0 || !version) { this.problem = `${found.path} did not answer --version like ripgrep`; return null; }
    if (Number(version[1]) < MINIMUM_MAJOR_VERSION) { this.problem = `ripgrep ${version[1]}.${version[2]}.${version[3]} is older than ${MINIMUM_MAJOR_VERSION}`; return null; }
    return { path: found.path, source: found.source, version: `${version[1]}.${version[2]}.${version[3]}`, pcre2: /^features:.*\+pcre2/m.test(text) };
  }

  /** Runs the program; one that cannot be started is forgotten, so the next call asks again instead of failing from a stale answer. */
  async #run(options) {
    try {
      return await runRipgrepProcess(options);
    } catch (error) {
      if (error?.code === 'ripgrep_unavailable') { this.problem = error.message; this.#cache = null; }
      throw error;
    }
  }

  async #require() {
    const info = await this.info();
    if (!info) throw fault('ripgrep_unavailable', `ripgrep không dùng được (${this.problem ?? 'không rõ lý do'}).`, 503);
    return info;
  }

  /**
   * Searches `target` (a path relative to `directory`, where ripgrep runs). `accept(file)` decides per file, with the path relative to `directory`.
   * @returns {Promise<{files: {path: string, lines: object[]}[], matches: number, searched: number|null, skippedBinary: number, skippedEncoding: number, limited: boolean,
   *                    stopped: boolean, timedOut: boolean, outputTruncated: boolean}>}
   * @throws ripgrep_unavailable, ripgrep_pcre2_unavailable, ripgrep_pattern (ripgrep cannot read the pattern), ripgrep_failed, or the reason `signal` was aborted for
   */
  async search({ directory, target = '.', pattern, regex = false, ignoreCase = false, context = 0, includeIgnored = false, typeGlob = null, limit = 100, accept = () => true,
    signal = null, timeoutMs = 10_000, noiseNames = [], privateNames = [...PRIVATE_DIRECTORIES] }) {
    const info = await this.#require();
    const pcre2 = regex && patternNeedsPcre2(pattern);
    if (pcre2 && !info.pcre2) throw fault('ripgrep_pcre2_unavailable', 'ripgrep này không có PCRE2 (cần cho lookahead/lookbehind/backreference).', 501);
    const args = [...searchArguments({ pattern, regex, pcre2, ignoreCase, context, includeIgnored, noiseNames, privateNames, typeGlob }), '--', target];
    const collector = createSearchCollector({ limit, context, accept, platform: this.platform });
    const splitter = new NdjsonSplitter();
    const feed = (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return false; }
      return collector.push(event) === 'stop';
    };
    const run = await this.#run({
      command: info.path, args, cwd: directory, env: this.#environment(), timeoutMs, signal, spawner: this.spawner,
      onChunk: (chunk) => { for (const line of splitter.push(chunk)) if (feed(line)) return true; return false; },
    });
    if (!run.stopped) for (const line of splitter.flush()) feed(line);
    const result = collector.finish();
    const empty = result.files.length === 0 && result.matches === 0 && result.skippedBinary + result.skippedEncoding === 0;
    if (run.code === 2 && empty && !run.stopped && !run.timedOut && !run.outputTruncated) {
      throw fault(PATTERN_ERROR.test(run.stderr) ? 'ripgrep_pattern' : 'ripgrep_failed', firstLines(run.stderr) || 'ripgrep dừng với mã 2.', 400);
    }
    return { ...result, stopped: run.stopped, timedOut: run.timedOut, outputTruncated: run.outputTruncated };
  }

  /**
   * The files under `target` that ripgrep would search (.gitignore honoured unless `includeIgnored`), as paths relative to `directory`, each `accept`ed one, in no particular order.
   * @returns {Promise<{files: string[], truncated: boolean, timedOut: boolean, outputTruncated: boolean}>}
   */
  async files({ directory, target = '.', includeIgnored = false, typeGlob = null, accept = () => true, maxFiles = 200_000, signal = null, timeoutMs = 15_000,
    noiseNames = [], privateNames = [...PRIVATE_DIRECTORIES] }) {
    const info = await this.#require();
    const args = [...fileListArguments({ includeIgnored, noiseNames, privateNames, typeGlob }), '--', target];
    const splitter = new NulSplitter();
    const found = [];
    let truncated = false;
    const take = (name) => {
      const file = normalizeRipgrepPath(name, this.platform);
      if (!file || !accept(file)) return false;
      if (found.length >= maxFiles) { truncated = true; return true; }
      found.push(file);
      return false;
    };
    const run = await this.#run({
      command: info.path, args, cwd: directory, env: this.#environment(), timeoutMs, signal, spawner: this.spawner,
      onChunk: (chunk) => { for (const name of splitter.push(chunk)) if (take(name)) return true; return false; },
    });
    if (!run.stopped) for (const name of splitter.flush()) take(name);
    if (run.code === 2 && found.length === 0 && !run.stopped && !run.timedOut && !run.outputTruncated) throw fault('ripgrep_failed', firstLines(run.stderr) || 'ripgrep dừng với mã 2.', 400);
    return { files: found, truncated, timedOut: run.timedOut, outputTruncated: run.outputTruncated };
  }
}
