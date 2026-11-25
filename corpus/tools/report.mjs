#!/usr/bin/env node
// The report of the benchmark corpus (plan task P7 pod-39, corpus/REPORT.md): the corpus, the folder of run packs and results.jsonl in; one
// Markdown report and one static HTML site out, each in English and in Vietnamese.
//
//   generateReport({corpus, packs, results, out, preregistration?, tag?, responses?, date?})  writes the report to the new folder `out`
//   readData({tasks, jsonl, packs, registration, responses, date}) / renderFiles(data)        the same without a folder: a Map of path to text
//
// The results are scored again from the packs, and a results.jsonl that is not those bytes is refused; the metrics are computeMetrics of
// metrics.mjs and nothing else. What is missing, unreadable or inconsistent is a refusal with a code and nothing is written: never a report
// of a part. The report is a function of its inputs alone: no clock, no locale, no file name of a pack, no order.
//
//   node corpus/tools/report.mjs --corpus <dir> --packs <dir> --results <results.jsonl> --out <new folder>
//                                [--preregistration <file> [--tag <name>]] [--responses <dir>] [--date YYYY-MM-DD]
// exit 0 written, 2 a usage error, 3 a refusal (nothing is written). It contacts no network; with --tag it reads the tag with Git.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENT_ID, FORMAT, FORMAT_VERSION } from './freeze.mjs';
import { runGit } from './hub-process.mjs';
import { CorpusError, SCHEMA_FILE, byName, loadCorpus } from './load.mjs';
import { MARKER_CONTRACT, MARKER_CONTRACT_VERSION, finalLine } from './marker.mjs';
import { MetricsError, computeMetrics, readResults } from './metrics.mjs';
import { KILL_RULE, METRICS, PROTOCOL, THRESHOLDS } from './protocol.mjs';
import { LANGS, RATE_RULES } from './render.mjs';
import { renderHtml } from './report-html.mjs';
import { renderMarkdown } from './report-md.mjs';
import { PATHS_LISTED, bannerReasons, buildReport, packFile } from './report-model.mjs';
import { ReportError, refuse } from './report-text.mjs';
import { ScoreError, readRunPack, resultKey, scoreFolder } from './score.mjs';

export { ReportError } from './report-text.mjs';

/** The largest response of a vendor. */
export const RESPONSE_MAX_BYTES = 64 * 1024;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RESPONSE_NAME = /^agent-([a-z0-9][a-z0-9-]{0,39})\.txt$/;
// The keys of an agent of the freeze config, in the order freeze.mjs writes them, with the most characters of each.
const AGENT_KEYS = Object.freeze({ id: 40, cli: 200, version: 200, model: 200, notes: 1000 });
const REQUIRED = ['corpus', 'packs', 'results', 'out'];
const OPTIONAL = ['preregistration', 'tag', 'responses', 'date'];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (error) => ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error?.code);
/** What `work` gives; an error of the file system in it is the refusal `code`, any other error is a mistake and stays one. */
async function within(code, what, work) {
  try { return await work(); } catch (error) {
    if (typeof error?.syscall === 'string') refuse(code, `${what}: ${error.message}`);
    throw error;
  }
}
const reading = (work) => within('input_unreadable', 'an input cannot be read', work);
const writing = (work) => within('write_failed', 'the report cannot be written', work);

// ---- the registration -----------------------------------------------------------------------------------------------------------------

const corpusHash = (tasks) => sha256(tasks.map((task) => `${task.sha256}  ${task.id}\n`).join(''));

/** The bytes freeze.mjs writes for `tasks` and these agents: a registration is this text or it is refused. */
export function registrationText({ tasks, agents, corpus, scoringCode }) {
  const document = {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    corpus: { path: corpus.path, commit: corpus.commit, tasks: tasks.length, sha256: corpusHash(tasks), schema_sha256: sha256(readFileSync(SCHEMA_FILE)) },
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
    agents: agents.map((agent) => Object.fromEntries(Object.keys(AGENT_KEYS).filter((key) => agent[key] !== undefined).map((key) => [key, agent[key]]))),
    protocol: PROTOCOL,
    metrics: METRICS,
    thresholds: THRESHOLDS,
    kill_rule: KILL_RULE,
    scoring_code: scoringCode ?? { commit: corpus.commit, repository: null },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * The preregistration file `bytes`, checked against the corpus and this code: {sha256, document, tag: null}. The corpus, the protocol, the
 * metrics, the thresholds, the kill rule and the marker contract it names are the ones here, or it is refused; what only the owner knows, the
 * agents and the commits, has its shape checked.
 */
export function readRegistration({ bytes, tasks }) {
  const bad = (message) => refuse('preregistration_invalid', `the preregistration file ${message}`);
  let text;
  let document;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { bad('is not UTF-8'); }
  try { document = JSON.parse(text); } catch { bad('is not JSON'); }
  if (!isObject(document)) bad('is not a JSON object');
  const { agents, corpus, scoring_code: scoring } = document;
  if (!isObject(corpus) || typeof corpus.path !== 'string' || typeof corpus.commit !== 'string' || !COMMIT.test(corpus.commit)) bad('does not name the folder and the commit of the corpus');
  if (!isObject(scoring) || typeof scoring.commit !== 'string' || !COMMIT.test(scoring.commit) || !(scoring.repository === null || typeof scoring.repository === 'string')) bad('does not name the commit of the scoring code');
  if (!Array.isArray(agents) || agents.length < 1 || agents.length > 20) bad('does not list 1 to 20 agents');
  for (const agent of agents) {
    if (!isObject(agent) || Object.keys(agent).some((key) => !Object.hasOwn(AGENT_KEYS, key))) bad('lists an agent with an unknown key');
    for (const key of ['id', 'cli', 'version']) if (agent[key] === undefined) bad(`lists an agent without its ${key}`);
    for (const [key, value] of Object.entries(agent)) if (typeof value !== 'string' || value.length < 1 || value.length > AGENT_KEYS[key]) bad(`lists an agent whose ${key} is not a text of 1 to ${AGENT_KEYS[key]} characters`);
    if (!AGENT_ID.test(agent.id)) bad(`lists an agent with the id ${JSON.stringify(agent.id)}`);
  }
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length) bad('lists an agent twice');
  const expected = registrationText({ tasks, agents, corpus, scoringCode: scoring });
  if (text !== expected) {
    const wanted = JSON.parse(expected);
    const key = [...new Set([...Object.keys(wanted), ...Object.keys(document)])].find((name) => JSON.stringify(wanted[name]) !== JSON.stringify(document[name]));
    refuse('preregistration_mismatch', key === undefined ? 'the preregistration file is not written as freeze.mjs writes it' : `the preregistration file is of another corpus or protocol: its ${key} is not this one's`);
  }
  return { sha256: sha256(bytes), document, tag: null };
}

/** The tag `name` of the repository that holds `corpus`, checked: the annotated tag that freeze.mjs made of this preregistration file. */
async function readTag({ corpus, name, bytes, registration }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANGUAGE: 'en' });
  const git = async (args) => {
    try { return await runGit('git', args, { cwd: corpus, env, maxBytes: 64 * 1024 * 1024 }); } catch (error) { return refuse('tag_missing', `Git could not read the tag ${name}: ${error.message}`); }
  };
  const found = await git(['rev-parse', '--verify', '--quiet', `refs/tags/${name}`]);
  if (found.code !== 0) refuse('tag_missing', `the repository of ${corpus} has no tag ${name}`);
  const object = found.stdout.toString('utf8').trim();
  const bad = (message) => refuse('tag_mismatch', `the tag ${name} is not the one freeze.mjs made of this preregistration file: ${message}`);
  const raw = await git(['cat-file', 'tag', object]);
  if (raw.code !== 0) bad('it is not an annotated tag');
  const at = raw.stdout.indexOf('\n\n');
  const header = /^object ([0-9a-f]+)\ntype ([a-z]+)\ntag (.+)\ntagger .* ([0-9]{1,12}) [+-][0-9]{4}$/.exec(raw.stdout.subarray(0, Math.max(at, 0)).toString('utf8'));
  if (!header) bad('its header is not that of an annotated tag with a time');
  const [, target, type, tagName, seconds] = header;
  const { document } = registration;
  if (tagName !== name) bad(`its own name is ${JSON.stringify(tagName)}`);
  if (type !== 'commit' || target !== document.corpus.commit) bad(`it is on the ${type} ${target}, the file names the commit ${document.corpus.commit}`);
  const lead = ['Pre-registration of the Proof-of-Done benchmark corpus', '', `preregistration.json sha256 ${registration.sha256}`, `corpus sha256 ${document.corpus.sha256}`, `tasks ${document.corpus.tasks}`, '', ''].join('\n');
  const message = Buffer.concat([Buffer.from(lead, 'utf8'), bytes]);
  const given = raw.stdout.subarray(at + 2);
  const rest = given.subarray(message.length).toString('latin1');
  if (!given.subarray(0, message.length).equals(message) || !(rest === '' || rest.startsWith('-----BEGIN '))) bad('its message does not hold the file');
  return { name, object, time: Number(seconds), signed: rest !== '' };
}

// ---- responses and runs ---------------------------------------------------------------------------------------------------------------

/** A vendor's response: {sha256, bytes, text}. */
export function readResponse(bytes, name = 'the response') {
  if (bytes.length > RESPONSE_MAX_BYTES) refuse('response_too_large', `${name} has ${bytes.length} bytes, the limit is ${RESPONSE_MAX_BYTES}`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { refuse('response_not_text', `${name} is not UTF-8 text`); }
  if (text.trim() === '') refuse('response_empty', `${name} is empty: without a response there is no file`);
  return { sha256: sha256(bytes), bytes: bytes.length, text };
}

async function readResponses(folder) {
  let entries;
  try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch (error) {
    if (missing(error)) refuse('responses_missing', `there is no folder ${folder}`);
    throw error;
  }
  const responses = [];
  for (const entry of entries.sort((a, b) => byName(a.name, b.name))) {
    const name = RESPONSE_NAME.exec(entry.name);
    if (!entry.isFile() || !name) refuse('unexpected_file', `${entry.name} in the responses folder is not a response (agent-<id>.txt)`);
    const bytes = await fs.readFile(path.join(folder, entry.name));
    responses.push({ agent: name[1], file: entry.name, bytes, response: readResponse(bytes, entry.name) });
  }
  return responses;
}

/** What the report shows of a run beside its result line: where its pack is, and the texts it left. */
function runFacts(bytes, result) {
  const pack = readRunPack(bytes);
  const listed = (items) => ({ items: items.slice(0, PATHS_LISTED), total: items.length });
  return {
    file: packFile(result),
    exitCode: pack.run?.agent.exitCode ?? null,
    signal: pack.run?.agent.signal ?? null,
    finalLine: pack.finalMessage === null ? null : finalLine(pack.finalMessage),
    outOfScope: listed(pack.score.outOfScope),
    overwritten: listed(pack.score.overwritten),
  };
}

// ---- the data and the files -----------------------------------------------------------------------------------------------------------

/** The runs of `results` as they are read: `add(bytes)` takes the bytes of one pack, `done()` the Map of every run's facts. */
function runReader(results) {
  const bySha = new Map(results.map((result) => [result.pack_sha256, result]));
  const runs = new Map();
  return {
    add(bytes, name = 'a pack') {
      const result = bySha.get(sha256(bytes));
      if (!result) refuse('packs_changed', `${name} is not one of the packs that were scored: it changed while the report was made`);
      const facts = runFacts(bytes, result);
      runs.set(resultKey(result), facts);
      return facts;
    },
    done() {
      if (runs.size !== results.length) refuse('packs_changed', `${results.length} packs were scored and ${runs.size} were read: the folder changed while the report was made`);
      return runs;
    },
  };
}

/** The checks across the inputs, and everything a report is made of. */
function makeData({ tasks, jsonl, results, runs, registration, responses, date }) {
  const sorted = [...tasks].sort((a, b) => byName(a.id, b.id));
  const metrics = computeMetrics(results);
  const known = new Map(sorted.map((task) => [task.id, task.sha256]));
  for (const result of results) if (known.get(result.task) !== result.task_sha256) refuse('corpus_changed', `the task ${result.task} changed while the report was made`);
  const agents = new Set(metrics.agents.map((agent) => agent.agent));
  if (registration !== null) {
    const registered = new Set(registration.document.agents.map((agent) => agent.id));
    for (const agent of agents) if (!registered.has(agent)) refuse('agent_not_registered', `there are runs of ${agent}, which the preregistration file does not list`);
    for (const agent of registered) agents.add(agent);
  }
  for (const agent of responses.keys()) if (!agents.has(agent)) refuse('response_unknown_agent', `there is a response of ${agent}, which is not an agent of this report`);
  return { tasks: sorted, results, metrics, runs, registration, responses, date, corpusSha256: corpusHash(sorted), resultsSha256: sha256(jsonl) };
}

/** The data of a report: the loaded tasks of a corpus, the text of results.jsonl and the bytes of every pack it was scored from. */
export function readData({ tasks, jsonl, packs, registration = null, responses = new Map(), date = null }) {
  const results = readResults(jsonl);
  const reader = runReader(results);
  for (const bytes of packs) reader.add(bytes);
  return makeData({ tasks, jsonl, results, runs: reader.done(), registration, responses, date });
}

/** Every page and report of `data`: a Map of path (from the report's folder) to text. */
export function renderFiles(data) {
  const files = new Map();
  for (const lang of LANGS) {
    const report = buildReport(data, lang);
    for (const [name, text] of renderHtml(report)) files.set(name, text);
    files.set(`report.${lang}.md`, renderMarkdown(report));
  }
  return files;
}

// ---- reading and writing --------------------------------------------------------------------------------------------------------------

function checkOptions(options) {
  for (const key of Object.keys(options)) if (!REQUIRED.includes(key) && !OPTIONAL.includes(key)) refuse('bad_argument', `generateReport does not take ${JSON.stringify(key)}`);
  const given = (key) => options[key] !== undefined && options[key] !== null;
  const paths = ['corpus', 'packs', 'results', 'out', 'preregistration', 'responses'];
  for (const key of paths) if ((REQUIRED.includes(key) || given(key)) && (typeof options[key] !== 'string' || options[key] === '' || options[key].includes('\u0000'))) refuse('bad_argument', `${key} is a path`);
  if (given('tag') && (typeof options.tag !== 'string' || !TAG_NAME.test(options.tag))) refuse('bad_argument', 'tag is the name of a tag: letters, digits, ., _ and -, starting with a letter or digit');
  if (given('tag') && !given('preregistration')) refuse('bad_argument', 'a tag is checked against the preregistration file it was made of: give both');
  if (given('date') && (typeof options.date !== 'string' || !RATE_RULES.date.holds(options.date))) refuse('bad_date', 'date is a day of the calendar, YYYY-MM-DD');
  return Object.fromEntries([...REQUIRED, ...OPTIONAL].map((key) => [key, !given(key) ? null : paths.includes(key) ? path.resolve(options[key]) : options[key]]));
}

const exists = async (target) => { try { await fs.lstat(target); return true; } catch (error) { if (missing(error)) return false; throw error; } };

/** The folder the report is written to does not exist, its parent does, and it is not inside a folder the report reads. */
async function checkOut({ out, corpus, packs, responses }) {
  if (await exists(out)) refuse('out_exists', `${out} exists already: a report is written to a new folder only`);
  const parent = path.dirname(out);
  let real;
  try { real = await fs.realpath(parent); if (!(await fs.stat(real)).isDirectory()) real = null; } catch (error) { if (!missing(error)) throw error; }
  if (!real) refuse('out_parent_missing', `${parent} is not a folder`);
  const target = path.join(real, path.basename(out));
  for (const input of [corpus, packs, responses]) {
    if (input === null) continue;
    let folder;
    try { folder = await fs.realpath(input); } catch (error) { if (missing(error)) continue; throw error; }
    const relative = path.relative(folder, target);
    if (relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative))) refuse('out_inside_input', `${out} is inside ${input}, which the report is made from`);
  }
  return parent;
}

async function readFile(file, code, what) {
  try { return await fs.readFile(file); } catch (error) {
    if (missing(error)) refuse(code, `there is no ${what} ${file}`);
    throw error;
  }
}

/** The whole folder at once: `staging` becomes `out`, which is never written over. Windows can hold a folder for a moment after its files closed. */
async function publish(staging, out) {
  for (let attempt = 1; ; attempt += 1) {
    if (await exists(out)) refuse('out_exists', `${out} appeared while the report was made: a report is written to a new folder only`);
    try { await fs.rename(staging, out); return; } catch (error) {
      if (await exists(out)) refuse('out_exists', `${out} appeared while the report was made: a report is written to a new folder only`);
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      await new Promise((resolve) => { setTimeout(resolve, 50 * attempt); });
    }
  }
}

/**
 * Makes the report of a set of runs and writes it to the new folder `out`: the pages, the Markdown reports, and beside them the packs, the
 * results and what else was given, so that the folder holds everything the report is made of but the corpus. Returns {out, pages, packs,
 * registered}. A refusal (ReportError, ScoreError, MetricsError) or any other error leaves nothing behind.
 */
export async function generateReport(options = {}) {
  const { corpus, packs, results: resultsFile, out, preregistration, tag, responses: responsesFolder, date } = checkOptions(options);
  const parent = await writing(() => checkOut({ out, corpus, packs, responses: responsesFolder }));

  // the results, again, from the packs: the metrics are of these bytes and of no others
  const { jsonl } = await reading(() => scoreFolder({ corpus, packs }));
  const stored = await reading(() => readFile(resultsFile, 'results_missing', 'results file'));
  const bytes = Buffer.from(jsonl, 'utf8');
  if (!stored.equals(bytes)) {
    let at = 0;
    while (at < stored.length && at < bytes.length && stored[at] === bytes[at]) at += 1;
    const line = bytes.subarray(0, at).toString('latin1').split('\n').length;
    refuse('results_differ', `line ${line} of ${resultsFile} is not what the packs give (sha256 ${sha256(stored)}, from the packs ${sha256(bytes)})`);
  }
  const results = readResults(jsonl);

  const loaded = await reading(() => loadCorpus(corpus));
  if (loaded.errors.length) refuse('corpus_changed', `the corpus changed while the report was made: ${loaded.errors[0].message}`);
  const { tasks } = loaded;
  let registration = null;
  let registered = null;
  if (preregistration !== null) {
    registered = await reading(() => readFile(preregistration, 'preregistration_missing', 'preregistration file'));
    registration = readRegistration({ bytes: registered, tasks });
    if (tag !== null) registration.tag = await readTag({ corpus, name: tag, bytes: registered, registration });
  }
  const responses = responsesFolder === null ? [] : await reading(() => readResponses(responsesFolder));

  const staging = path.join(parent, `.report-partial-${randomBytes(6).toString('hex')}`);
  await writing(() => fs.mkdir(staging));
  try {
    const write = (name, content) => writing(async () => {
      await fs.mkdir(path.dirname(path.join(staging, name)), { recursive: true });
      await fs.writeFile(path.join(staging, name), content, { flag: 'wx' });
    });
    const reader = runReader(results);
    for (const name of (await reading(() => fs.readdir(packs))).sort(byName)) {
      const content = await reading(() => fs.readFile(path.join(packs, name)));
      await write(reader.add(content, name).file, content);
    }
    const data = makeData({ tasks, jsonl, results, runs: reader.done(), registration, responses: new Map(responses.map(({ agent, response }) => [agent, response])), date });
    const files = renderFiles(data);
    await write('results.jsonl', bytes);
    if (registered !== null) await write('preregistration.json', registered);
    for (const { file, bytes: content } of responses) await write(`responses/${file}`, content);
    for (const [name, text] of files) await write(name, Buffer.from(text, 'utf8'));
    await writing(() => publish(staging, out));
    return { out, pages: files.size, packs: results.length, registered: bannerReasons(data).length === 0 };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    throw error;
  }
}

// ---- the command line -----------------------------------------------------------------------------------------------------------------

const USAGE = 'usage: node corpus/tools/report.mjs --corpus <dir> --packs <dir> --results <results.jsonl> --out <new folder> [--preregistration <file> [--tag <name>]] [--responses <dir>] [--date YYYY-MM-DD]';

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = {};
  const usage = () => { stderr.write(`${USAGE}\n`); return 2; };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].startsWith('--') ? argv[index].slice(2) : '';
    if (![...REQUIRED, ...OPTIONAL].includes(key) || !argv[index + 1] || options[key] !== undefined) return usage();
    options[key] = argv[index + 1];
  }
  if (REQUIRED.some((key) => options[key] === undefined) || (options.tag !== undefined && options.preregistration === undefined)) return usage();
  try {
    const { out, pages, packs, registered } = await generateReport(options);
    stdout.write(`report written to ${out} (${pages} pages, ${packs} run packs): ${registered ? 'of a registered run set' : 'not registered, synthetic data'}\n`);
    return 0;
  } catch (error) {
    if (![ReportError, ScoreError, MetricsError, CorpusError].some((kind) => error instanceof kind)) throw error;
    stderr.write(`refused: ${error.code}: ${error.message}\n`);
    return 3;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
