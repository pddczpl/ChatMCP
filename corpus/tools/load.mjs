#!/usr/bin/env node
// The loader and validator of the benchmark corpus (corpus/README.md, "The task format").
//
//   loadTask(dir)       one task folder (tasks/<id>/): task.yml read in the strict YAML subset, checked against
//                       corpus/schema/task.schema.json and then against the rules a schema cannot say; acceptance.yml read by the pod-20
//                       parser; every file hashed. The first problem throws CorpusError {code, file, line, message}.
//   loadCorpus(root)    every task folder under <root>/tasks, plus the rules across tasks (one folder per id). Never throws for a bad
//                       task: returns {root, tasks, errors}, the tasks that loaded in id order and every problem found.
//
//   node corpus/tools/load.mjs [corpus root]    prints each task and each problem; exit 0 when there is none, 1 otherwise, 2 for usage.
//
// Reads files only: no network, no Git, nothing written.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AcceptanceError, YamlSubsetError, parseAcceptance, parseYamlSubset, toPlainValue } from './acceptance-parser.mjs';
import { MARKER_CONTRACT } from './marker.mjs';
import { checkNode, compileSchema } from './schema-check.mjs';

export const TASKS_FOLDER = 'tasks';
export const TASK_FILE = 'task.yml';
export const NOTES_FILE = 'README.md';
export const TEXT_MAX_BYTES = 64 * 1024;
export const ORACLE_MAX_BYTES = 1024 * 1024;
export const SCHEMA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'task.schema.json');
const SCHEMA = compileSchema(JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')));
const ID = new RegExp(SCHEMA.defs.id.pattern, 'u');
// The characters the acceptance reader refuses (docs/PROOF-ACCEPTANCE.md, "Hidden characters"), for the same reason: what a person
// reads in task.yml is what an agent receives. Control characters but TAB and LF, format characters (bidi controls, zero-width, tag
// characters), default-ignorable code points, line and paragraph separators, noncharacters and lone surrogates.
const HIDDEN = /(?![\t\n])\p{Cc}|\p{Cf}|\p{Default_Ignorable_Code_Point}|\p{Zl}|\p{Zp}|\p{Noncharacter_Code_Point}|\p{Cs}/u;
// Names Windows keeps for devices, with or without an extension: a task folder or file cannot be called that.
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

export class CorpusError extends Error {
  constructor(code, text, { file = null, line = null, taskId = null } = {}) {
    super(`${file ?? 'corpus'}${line ? ` line ${line}` : ''}: ${text} [${code}]`);
    this.name = 'CorpusError';
    this.code = code;
    this.file = file;
    this.line = line;
    this.taskId = taskId;
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Code-unit order: the same on every machine and in every locale. */
export const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hex = (character) => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

/** Every text value of the tree with its path in the schema's spelling (`limits.x`, `setup[0]`). */
function* textNodes(node, where) {
  if (node.kind === 'map') for (const entry of node.entries) yield* textNodes(entry.value, where ? `${where}.${entry.key}` : entry.key);
  else if (node.kind === 'seq') for (const [index, item] of node.items.entries()) yield* textNodes(item, `${where}[${index}]`);
  else if (typeof node.value === 'string') yield { node, where };
}

const entryOf = (root, key) => root.entries.find((entry) => entry.key === key);

/**
 * Loads the task in `dir` (its folder name is its id). Returns
 *   {id, dir, task, acceptance, files: [{name, sha256, size}], sha256}
 * where `task` is task.yml normalised (`setup` always a list, `allowed_paths` in the acceptance reader's one spelling), `acceptance` the
 * parsed acceptance file, `files` every file of the folder in name order, and `sha256` the task hash: the sha256 of the lines
 * "<sha256>  <name>\n" of those files, in that order.
 */
export async function loadTask(dir, { prefix = '' } = {}) {
  const folder = path.basename(path.resolve(dir));
  let taskId = null;
  const fail = (code, text, file = TASK_FILE, line = null) => { throw new CorpusError(code, text, { file: `${prefix}${folder}/${file}`, line, taskId }); };
  /** A text file of the task: at most 64 KiB, UTF-8 without a byte order mark, LF line ends (CRLF is refused: see the README). */
  const checkText = (bytes, name) => {
    if (bytes.length > TEXT_MAX_BYTES) fail('too_large', `${name} has ${bytes.length} bytes, the limit is ${TEXT_MAX_BYTES}`, name);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('bom', `${name} starts with a byte order mark; the corpus files are UTF-8 without one`, name, 1);
    const cr = bytes.indexOf(0x0d);
    if (cr >= 0) fail('crlf', `${name} has a carriage return; the corpus files use LF line ends only, so that every checkout hashes the same`, name, bytes.subarray(0, cr).toString('utf8').split('\n').length);
  };

  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { entries = []; }
  const present = new Map(entries.map((entry) => [entry.name, entry]));
  if (!present.get(TASK_FILE)?.isFile()) fail('task_file_missing', `the task folder has no ${TASK_FILE}`);
  const bytes = await fs.readFile(path.join(dir, TASK_FILE));
  checkText(bytes, TASK_FILE);
  let root;
  try { root = parseYamlSubset(bytes, { maxBytes: TEXT_MAX_BYTES }); } catch (error) {
    if (!(error instanceof YamlSubsetError)) throw error;
    fail('yaml_invalid', `not valid in the supported YAML subset: ${error.message.replace(/^line \d+: /, '')}`, TASK_FILE, error.line);
  }
  if (!root) fail('empty_file', `${TASK_FILE} has no content`);
  if (root.kind !== 'map') fail('not_a_mapping', `${TASK_FILE} must be a mapping (version, id, title, prompt ...)`, TASK_FILE, root.line);
  const idNode = entryOf(root, 'id')?.value;
  if (typeof idNode?.value === 'string') taskId = idNode.value;

  const problem = checkNode(SCHEMA, root);
  if (problem) fail(problem.code, problem.message, TASK_FILE, problem.line);
  for (const { node, where } of textNodes(root, '')) {
    const hidden = HIDDEN.exec(node.value);
    if (hidden) fail('hidden_character', `\`${where}\` holds ${hex(hidden[0])}, a hidden or control character (what a person reads must be what an agent gets)`, TASK_FILE, node.line);
    // A line break only where the file shows one: in a block scalar (a quoted "\n" would hide the second line).
    if (node.style !== 'block' && node.value.includes('\n')) fail('hidden_character', `\`${where}\` holds a line break outside a block scalar (| or >)`, TASK_FILE, node.line);
  }
  const task = JSON.parse(JSON.stringify(toPlainValue(root)));
  const lineOf = (key) => entryOf(root, key).line;

  if (DEVICE.test(task.id)) fail('bad_id', `\`id\` ${task.id} is a Windows device name, which cannot be a folder`, TASK_FILE, lineOf('id'));
  if (task.id !== folder) fail('id_folder_mismatch', `\`id\` is ${task.id} but the folder is ${folder}: the id is the name of the task's folder`, TASK_FILE, lineOf('id'));

  // The prompt ends with the marker contract, word for word, on lines of its own. Its final line breaks are dropped by walking back:
  // /\n+$/ rescans every run of line breaks from each of its positions, which is quadratic (a second for 64,000 of them).
  let promptEnd = task.prompt.length;
  while (promptEnd > 0 && task.prompt.charCodeAt(promptEnd - 1) === 0x0a) promptEnd -= 1;
  const prompt = task.prompt.slice(0, promptEnd);
  const at = prompt.lastIndexOf(MARKER_CONTRACT);
  if (at < 0 || (at > 0 && prompt[at - 1] !== '\n')) fail('marker_contract_missing', '`prompt` does not end with the marker contract; copy it word for word from corpus/README.md', TASK_FILE, lineOf('prompt'));
  if (at + MARKER_CONTRACT.length !== prompt.length) fail('marker_contract_not_last', '`prompt` goes on after the marker contract; the contract must be the end of the prompt', TASK_FILE, lineOf('prompt'));

  // One repository source. (A mapping with neither cannot be written: an empty `repo:` is null and the schema refuses it.)
  if (task.repo.git && task.repo.tarball) fail('repo_source_both', '`repo` has both `git` and `tarball`; give exactly one source', TASK_FILE, lineOf('repo'));

  // A setup command cut by a ` #` comment while it holds a quote is refused, as in acceptance.yml: the comment may be part of the command.
  for (const [index, node] of (entryOf(root, 'setup')?.value.items ?? []).entries()) {
    if (node.style === 'plain' && node.comment === true && /["'`]/.test(node.value)) {
      fail('ambiguous_comment', `\`setup[${index}]\` was cut at " #" (a comment) and holds a quote; quote the whole command or use a block scalar`, TASK_FILE, node.line);
    }
  }

  // allowed_paths follow the path rules of acceptance.yml exactly: each is read by the pod-20 parser as a `protected` glob.
  const pathNodes = entryOf(root, 'allowed_paths').value.items;
  const header = ['version: 1', 'criteria:', '  - id: allowed-paths', '    text: allowed paths', '    manual:', '      note: allowed paths', 'protected:'];
  let allowedPaths;
  try { allowedPaths = parseAcceptance([...header, ...pathNodes.map((node) => `  - ${JSON.stringify(node.value)}`), ''].join('\n')).protected; } catch (error) {
    if (!(error instanceof AcceptanceError)) throw error;
    const index = error.line - header.length - 1;
    fail(error.reason === 'path_outside_workspace' ? 'path_outside_repo' : 'bad_path',
      `\`allowed_paths[${index}]\` ${JSON.stringify(pathNodes[index].value)} must be a relative path inside the repository: no .. part, no absolute path, drive, UNC path, ~ or :`,
      TASK_FILE, pathNodes[index].line);
  }
  const firstOf = new Map();
  for (const [index, value] of allowedPaths.entries()) {
    if (firstOf.has(value)) fail('duplicate_item', `\`allowed_paths[${index}]\` is ${value} again, like \`allowed_paths[${firstOf.get(value)}]\``, TASK_FILE, pathNodes[index].line);
    firstOf.set(value, index);
  }

  // The files of the folder: each name used once, no device name, nothing else in the folder, never the hidden archive.
  const named = [['the task file', TASK_FILE], ['`acceptance`', task.acceptance], ['`oracle`', task.oracle], ['`hidden_tests.archive`', task.hidden_tests.archive], ['the notes file', NOTES_FILE]];
  if (task.repo.tarball) named.push(['`repo.tarball.file`', task.repo.tarball.file]);
  for (const [index, [what, name]] of named.entries()) {
    if (DEVICE.test(name)) fail('bad_file_name', `${what} ${name} is a Windows device name`, TASK_FILE);
    const same = named.slice(0, index).find(([, other]) => other.toLowerCase() === name.toLowerCase());
    if (same) fail('file_name_clash', `${what} is ${name}, the same file as ${same[0]}`, TASK_FILE);
  }
  const archive = task.hidden_tests.archive;
  if (entries.some((entry) => entry.name.toLowerCase() === archive.toLowerCase())) {
    fail('hidden_archive_committed', `${archive} is the hidden test archive: it never belongs in the corpus (freeze reads it from a private folder)`, archive);
  }
  const allowed = new Set(named.filter(([what]) => what !== '`hidden_tests.archive`').map(([, name]) => name));
  for (const entry of [...entries].sort((a, b) => byName(a.name, b.name))) {
    if (!entry.isFile() || !allowed.has(entry.name)) {
      fail('unexpected_file', `${entry.name}${entry.isDirectory() ? '/' : ''} is not a file of a task (task.yml, the acceptance and oracle files, the tarball, README.md)`, entry.name);
    }
  }
  if (!present.has(task.acceptance)) fail('acceptance_missing', `the acceptance file ${task.acceptance} is missing`, task.acceptance);
  if (!present.has(task.oracle)) fail('oracle_missing', `the oracle patch ${task.oracle} is missing`, task.oracle);
  if (task.repo.tarball && !present.has(task.repo.tarball.file)) fail('tarball_missing', `the repository tarball ${task.repo.tarball.file} is missing`, task.repo.tarball.file);

  const files = [];
  for (const name of [...present.keys()].sort(byName)) {
    const content = await fs.readFile(path.join(dir, name));
    files.push({ name, sha256: sha256(content), size: content.length, content });
  }
  const file = (name) => files.find((entry) => entry.name === name);
  const leaked = files.find((entry) => entry.sha256 === task.hidden_tests.sha256);
  if (leaked) fail('hidden_archive_committed', `${leaked.name} has the sha256 of the hidden test archive: the archive never belongs in the corpus`, leaked.name);

  const acceptanceFile = file(task.acceptance);
  checkText(acceptanceFile.content, task.acceptance);
  let acceptance;
  // The YAML layer is read first only for its words: the acceptance reader passes on a YAML problem by its reason code alone.
  try { parseYamlSubset(acceptanceFile.content); acceptance = parseAcceptance(acceptanceFile.content); } catch (error) {
    if (!(error instanceof AcceptanceError) && !(error instanceof YamlSubsetError)) throw error;
    fail('acceptance_invalid', `${task.acceptance} is not a valid acceptance file (docs/PROOF-ACCEPTANCE.md): ${error.message.replace(/^.*?line \d+: /, '')}`, task.acceptance, error.line);
  }
  const oracle = file(task.oracle);
  if (oracle.size > ORACLE_MAX_BYTES) fail('too_large', `${task.oracle} has ${oracle.size} bytes, the limit is ${ORACLE_MAX_BYTES}`, task.oracle);
  if (!/^(?:diff --git |\+\+\+ )/m.test(oracle.content.toString('utf8'))) fail('oracle_not_a_patch', `${task.oracle} is not a patch: it has no "diff --git" or "+++" line`, task.oracle);
  if (task.repo.tarball && file(task.repo.tarball.file).sha256 !== task.repo.tarball.sha256) {
    fail('tarball_mismatch', `${task.repo.tarball.file} has the sha256 ${file(task.repo.tarball.file).sha256}, task.yml says ${task.repo.tarball.sha256}`, task.repo.tarball.file);
  }

  const normalized = { ...task, setup: task.setup ?? [], allowed_paths: allowedPaths };
  const listed = files.map(({ name, sha256: hash, size }) => ({ name, sha256: hash, size }));
  return { id: task.id, dir: path.resolve(dir), task: normalized, acceptance, files: listed, sha256: sha256(listed.map((entry) => `${entry.sha256}  ${entry.name}\n`).join('')) };
}

/** Loads every task folder of `<root>/tasks`; returns {root, tasks (in id order), errors}. */
export async function loadCorpus(root) {
  const tasksFolder = path.join(root, TASKS_FOLDER);
  const result = { root: path.resolve(root), tasks: [], errors: [] };
  let entries;
  try { entries = await fs.readdir(tasksFolder, { withFileTypes: true }); } catch {
    result.errors.push(new CorpusError('no_tasks_folder', `there is no ${TASKS_FOLDER}/ folder in ${root}`, { file: TASKS_FOLDER }));
    return result;
  }
  if (entries.length === 0) result.errors.push(new CorpusError('empty_corpus', `${TASKS_FOLDER}/ holds no task`, { file: TASKS_FOLDER }));
  const owners = new Map();
  const own = (id, name) => owners.set(id, [...(owners.get(id) ?? []), name]);
  for (const entry of entries.sort((a, b) => byName(a.name, b.name))) {
    const file = `${TASKS_FOLDER}/${entry.name}`;
    if (!entry.isDirectory()) { result.errors.push(new CorpusError('unexpected_file', `${entry.name} is not a task folder`, { file })); continue; }
    if (!ID.test(entry.name) || DEVICE.test(entry.name)) {
      result.errors.push(new CorpusError('bad_id', `the folder name ${JSON.stringify(entry.name)} is not a task id: ${SCHEMA.defs.id.description}`, { file }));
      continue;
    }
    try {
      const task = await loadTask(path.join(tasksFolder, entry.name), { prefix: `${TASKS_FOLDER}/` });
      result.tasks.push(task);
      own(task.id, entry.name);
    } catch (error) {
      if (!(error instanceof CorpusError)) throw error;
      result.errors.push(error);
      if (error.taskId !== null) own(error.taskId, entry.name);
    }
  }
  for (const [id, folders] of owners) {
    if (folders.length > 1) result.errors.push(new CorpusError('duplicate_id', `the id ${id} is used by ${folders.map((name) => `${TASKS_FOLDER}/${name}`).join(' and ')}`, { file: TASKS_FOLDER }));
  }
  // The folders were read in name order and a task loads only when its id is its folder's name: the tasks are in id order.
  return result;
}

async function main(argv) {
  if (argv.length > 1 || argv.some((arg) => arg.startsWith('-'))) {
    console.error('usage: node corpus/tools/load.mjs [corpus root]   (default: the corpus folder that holds this tool)');
    return 2;
  }
  const { tasks, errors } = await loadCorpus(path.resolve(argv[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
  for (const task of tasks) console.log(`ok     ${task.id}  ${task.sha256}`);
  for (const error of errors) console.log(`error  ${error.message}`);
  console.log(`${tasks.length} task${tasks.length === 1 ? '' : 's'}, ${errors.length} error${errors.length === 1 ? '' : 's'}`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
