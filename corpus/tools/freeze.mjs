#!/usr/bin/env node
// The freeze of the benchmark corpus (corpus/README.md, "Pre-registration"): it writes preregistration.json and then creates a LOCAL
// annotated Git tag on the commit whose corpus it hashed. The tag's time is the evidence that the tasks, the hidden test archives, the
// agent versions, the metrics and the thresholds were fixed before any run.
//
//   node corpus/tools/freeze.mjs --hidden <dir> --config <file> --out <file> (--tag <name> | --no-tag) [--corpus <dir>]
//
//   --corpus   the corpus root, the folder that holds tasks/ (default: the corpus folder that holds this tool); it must be in a Git
//              work tree, committed, with nothing changed or untracked under it
//   --hidden   the PRIVATE folder of the hidden test archives, <hidden>/<task id>/<archive>; it must be outside the repository
//   --config   a JSON file: {"version": 1, "agents": [{"id", "cli", "version", "model"?, "notes"?}], "scoring_code"?: {"repository", "commit"}}
//   --out      where preregistration.json is written; outside the corpus folder (a file there would make the corpus dirty)
//   --tag      the name of the annotated tag to create; refused when it exists.  --no-tag  writes the file only (a dry run).
//
// preregistration.json holds no time, no host, no absolute path and nothing random, so two runs on the same commit write the same bytes.
// The tool never pushes, fetches or otherwise contacts a network, and never runs an agent's CLI: the agent versions come from --config.
// Exit code: 0 frozen (or written, with --no-tag), 1 refused (the reason is printed), 2 usage error.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCHEMA_FILE, TASKS_FOLDER, loadCorpus } from './load.mjs';
import { MARKER_CONTRACT, MARKER_CONTRACT_VERSION } from './marker.mjs';
import { KILL_RULE, METRICS, PROTOCOL, THRESHOLDS } from './protocol.mjs';

export const FORMAT = 'pod-corpus-preregistration';
export const FORMAT_VERSION = 1;
const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const AGENT_KEYS = ['id', 'cli', 'version', 'model', 'notes'];
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// In the configuration every value is one line of visible text.
const INVISIBLE = /\p{Cc}|\p{Cf}|\p{Default_Ignorable_Code_Point}|\p{Zl}|\p{Zp}|\p{Noncharacter_Code_Point}|\p{Cs}/u;

export class FreezeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FreezeError';
    this.code = code;
  }
}
const refuse = (code, message) => { throw new FreezeError(code, message); };
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) refuse('git_unavailable', `git could not be started: ${result.error.message}`);
  return result;
}

/** The real path of `target`, also when it does not exist yet (the real path of its nearest existing folder, then the rest). */
function realOf(target) {
  const rest = [];
  let current = path.resolve(target);
  while (!existsSync(current) && path.dirname(current) !== current) {
    rest.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(realpathSync.native(current), ...rest);
}
const inside = (folder, target) => {
  const relative = path.relative(folder, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** The configuration file, checked and in a fixed key order: {agents, scoring_code | null}. */
export function readConfig(file) {
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { refuse('config_invalid', `${file} is not a readable JSON file: ${error.message}`); }
  const bad = (text) => refuse('config_invalid', `the configuration ${text}`);
  const text = (value, where, limit) => {
    if (typeof value !== 'string' || value.length < 1 || value.length > limit) bad(`needs ${where} as text of 1 to ${limit} characters`);
    const hidden = INVISIBLE.exec(value);
    if (hidden) bad(`has an invisible or control character (U+${hidden[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) in ${where}`);
    return value;
  };
  if (!isObject(config)) bad('must be a JSON object');
  for (const key of Object.keys(config)) if (!['version', 'agents', 'scoring_code'].includes(key)) bad(`has an unknown key "${key}"`);
  if (config.version !== 1) bad('needs "version": 1');
  if (!Array.isArray(config.agents) || config.agents.length < 1 || config.agents.length > 20) bad('needs "agents": a list of 1 to 20 agents');
  const ids = new Set();
  const agents = config.agents.map((agent, index) => {
    if (!isObject(agent)) bad(`needs agents[${index}] to be an object`);
    for (const key of Object.keys(agent)) if (!AGENT_KEYS.includes(key)) bad(`has an unknown key "${key}" in agents[${index}]`);
    for (const key of ['id', 'cli', 'version']) if (agent[key] === undefined) bad(`needs agents[${index}].${key}`);
    for (const key of Object.keys(agent)) text(agent[key], `agents[${index}].${key}`, key === 'notes' ? 1000 : 200);
    if (!AGENT_ID.test(agent.id)) bad(`needs agents[${index}].id to be 1 to 40 lower-case letters, digits and hyphens`);
    if (ids.has(agent.id)) bad(`names the agent ${agent.id} twice`);
    ids.add(agent.id);
    return Object.fromEntries(AGENT_KEYS.filter((key) => agent[key] !== undefined).map((key) => [key, agent[key]]));
  });
  let scoring = null;
  if (config.scoring_code !== undefined) {
    const given = config.scoring_code;
    if (!isObject(given) || Object.keys(given).some((key) => key !== 'repository' && key !== 'commit')) bad('needs "scoring_code" as {"repository", "commit"}');
    text(given.repository, 'scoring_code.repository', 400);
    if (!/^https:\/\/[^\s@]+$/.test(given.repository)) bad('needs scoring_code.repository as an https:// URL without user name or password');
    if (typeof given.commit !== 'string' || !COMMIT.test(given.commit)) bad('needs scoring_code.commit as a full commit id (40 or 64 lower-case hex digits)');
    scoring = { commit: given.commit, repository: given.repository };
  }
  return { agents, scoring };
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** The id Git gives a blob of these bytes, in the repository's object format. */
const blobId = (bytes, format) => createHash(format === 'sha256' ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * Checks everything, writes the file and (with `tag`) creates the tag. Returns {out, sha256, commit, tag, tasks, corpusSha256}.
 * Throws FreezeError {code} for every refusal: nothing is written or tagged then, except after `tag_failed` (git itself could not make
 * the tag), when the file has been written already.
 */
export async function freeze({ corpus, hidden, config: configFile, out, tag = null }) {
  if (tag !== null && (!TAG_NAME.test(tag) || git(undefined, ['check-ref-format', `refs/tags/${tag}`]).status !== 0)) {
    refuse('bad_tag_name', `${JSON.stringify(tag)} is not a tag name this tool creates: letters, digits, ., _ and -, starting with a letter or digit, and valid for git check-ref-format`);
  }
  const config = readConfig(configFile);
  if (!existsSync(corpus) || !statSync(corpus).isDirectory()) refuse('corpus_invalid', `the corpus folder ${corpus} does not exist`);
  const corpusRoot = realpathSync.native(path.resolve(corpus));

  const top = git(corpusRoot, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) refuse('not_a_repository', `${corpusRoot} is not in a Git work tree: the tag on a commit is the evidence, so the corpus must be committed`);
  const repoRoot = realpathSync.native(path.resolve(top.stdout.trim()));
  const head = git(corpusRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.status !== 0) refuse('no_commit', 'the repository has no commit yet: commit the corpus first');
  const commit = head.stdout.trim();
  const status = git(corpusRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (status.status !== 0) refuse('dirty_tree', `git status failed: ${status.stderr.trim()}`);
  const changed = status.stdout.split('\0').filter(Boolean);
  if (changed.length) refuse('dirty_tree', `the corpus folder has changes that are not committed (${changed.slice(0, 5).map((line) => line.trim()).join(', ')}${changed.length > 5 ? ', ...' : ''}): only a committed corpus can be frozen`);
  if (tag !== null && git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).status === 0) {
    refuse('tag_exists', `the tag ${tag} exists already: a pre-registration is never moved; choose a new name`);
  }
  const hiddenRoot = realOf(hidden);
  if (inside(repoRoot, hiddenRoot)) refuse('hidden_inside_repository', `the hidden archives (${hiddenRoot}) are inside the repository ${repoRoot}; keep them outside it, where they cannot be committed`);
  const outFile = realOf(out);
  if (inside(corpusRoot, outFile)) refuse('out_inside_corpus', `${outFile} is inside the corpus folder; write the file outside it (and commit it later if it belongs in the repository)`);

  const { tasks, errors } = await loadCorpus(corpusRoot);
  if (errors.length) refuse('corpus_invalid', `the corpus does not load:\n${errors.map((error) => `  ${error.message}`).join('\n')}`);

  // The hashes must be the hashes of the commit the tag will name: a checkout that converted line ends hashes differently.
  const corpusPath = path.relative(repoRoot, corpusRoot).split(path.sep).join('/') || '.';
  const format = git(repoRoot, ['rev-parse', '--show-object-format']).stdout.trim();
  const listing = git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', corpusPath]);
  const blobs = new Map();
  for (const record of listing.stdout.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    blobs.set(record.slice(tab + 1), record.slice(0, tab).split(' ')[2]);
  }
  for (const task of tasks) {
    for (const file of task.files) {
      const repoPath = [...(corpusPath === '.' ? [] : [corpusPath]), TASKS_FOLDER, task.id, file.name].join('/');
      const bytes = await fs.readFile(path.join(corpusRoot, TASKS_FOLDER, task.id, file.name));
      if (blobs.get(repoPath) !== blobId(bytes, format)) {
        refuse('checkout_differs', `${repoPath} on disk is not the committed file (a line-end conversion at checkout?); the corpus needs "corpus/** -text" in .gitattributes and a fresh checkout`);
      }
    }
  }

  for (const task of tasks) {
    const { archive, sha256: expected } = task.task.hidden_tests;
    let digest;
    try { digest = await hashFile(path.join(hiddenRoot, task.id, archive)); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
      refuse('hidden_archive_missing', `the hidden archive of ${task.id} (${task.id}/${archive}) is not in ${hiddenRoot}`);
    }
    if (digest !== expected) refuse('hidden_archive_mismatch', `the hidden archive of ${task.id} (${task.id}/${archive}) has the sha256 ${digest}, task.yml says ${expected}: it was changed after the task was written`);
  }

  const corpusSha256 = sha256(tasks.map((task) => `${task.sha256}  ${task.id}\n`).join(''));
  const document = {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    corpus: { path: corpusPath, commit, tasks: tasks.length, sha256: corpusSha256, schema_sha256: sha256(readFileSync(SCHEMA_FILE)) },
    marker_contract: { version: MARKER_CONTRACT_VERSION, text: MARKER_CONTRACT, sha256: sha256(MARKER_CONTRACT) },
    tasks: tasks.map((task) => ({
      id: task.id,
      sha256: task.sha256,
      files: Object.fromEntries(task.files.map((file) => [file.name, file.sha256])),
      repo: task.task.repo,
      hidden_tests: { archive: task.task.hidden_tests.archive, sha256: task.task.hidden_tests.sha256 },
      limits: task.task.limits,
      tags: task.task.tags,
    })),
    agents: config.agents,
    protocol: PROTOCOL,
    metrics: METRICS,
    thresholds: THRESHOLDS,
    kill_rule: KILL_RULE,
    scoring_code: config.scoring ?? { commit, repository: null },
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const digest = sha256(text);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(`${outFile}.partial`, text, 'utf8');
  await fs.rename(`${outFile}.partial`, outFile);

  if (tag !== null) {
    const message = ['Pre-registration of the Proof-of-Done benchmark corpus', '', `preregistration.json sha256 ${digest}`, `corpus sha256 ${corpusSha256}`, `tasks ${tasks.length}`, '', text].join('\n');
    const made = git(repoRoot, ['tag', '-a', '--cleanup=verbatim', '-F', '-', tag, commit], message);
    if (made.status !== 0) refuse('tag_failed', `git tag failed: ${made.stderr.trim()}`);
    if (git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).stdout.trim() !== commit) refuse('tag_failed', `the tag ${tag} does not point at ${commit}`);
  }
  return { out: outFile, sha256: digest, commit, tag, tasks: tasks.length, corpusSha256 };
}

function parseOptions(argv) {
  const options = { corpus: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), hidden: null, config: null, out: null, tag: null, noTag: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next === '') throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--corpus') options.corpus = path.resolve(value());
    else if (arg === '--hidden') options.hidden = path.resolve(value());
    else if (arg === '--config') options.config = path.resolve(value());
    else if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--tag') options.tag = value();
    else if (arg === '--no-tag') options.noTag = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  for (const key of ['hidden', 'config', 'out']) if (options[key] === null) throw new Error(`--${key} is required`);
  if ((options.tag === null) === !options.noTag) throw new Error('give exactly one of --tag <name> and --no-tag');
  return options;
}

async function main(argv) {
  let options;
  try { options = parseOptions(argv); } catch (error) {
    console.error(`${error.message}\nusage: node corpus/tools/freeze.mjs --hidden <dir> --config <file> --out <file> (--tag <name> | --no-tag) [--corpus <dir>]`);
    return 2;
  }
  try {
    const result = await freeze(options);
    console.log(`preregistration.json written to ${result.out}`);
    console.log(`sha256 ${result.sha256}`);
    console.log(`${result.tasks} tasks, corpus sha256 ${result.corpusSha256}, commit ${result.commit}`);
    console.log(result.tag ? `tag ${result.tag} created on ${result.commit} (local only: nothing was pushed)` : 'no tag (--no-tag)');
    return 0;
  } catch (error) {
    if (!(error instanceof FreezeError)) throw error;
    console.error(`freeze refused [${error.code}]: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
