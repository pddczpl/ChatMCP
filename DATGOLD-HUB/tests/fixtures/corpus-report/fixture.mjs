// The synthetic run packs the benchmark report is tested with (plan task P7 pod-39, corpus/REPORT.md), and the golden report made of them.
//
// EVERY NUMBER HERE IS MADE UP. No agent, no model and no paid call ran: the agents are agent-a, agent-b and agent-c, the tasks are the two
// example tasks of the corpus, and the golden report says on every page that it is synthetic data.
//
// The packs are built with buildRunPack of corpus/tools/score.mjs, so each one is a pack the scoring accepts. The proof pack inside one is a
// stub that holds what the scoring reads (type, predicate, acceptance hash, criteria, check changes) and nothing else: a golden report made
// from the pack builder's own statements would change with every change of that builder.
//
// To make the golden report again (after an intended change of the report):
//   node tests/fixtures/corpus-report/fixture.mjs --write
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HUB = path.resolve(HERE, '..', '..', '..');
export const CORPUS = path.resolve(HUB, '..', 'corpus');
export const EXAMPLES = path.join(CORPUS, 'examples');
export const GOLDEN = path.join(HERE, 'golden');
export const importTool = (name) => import(pathToFileURL(path.join(CORPUS, 'tools', name)).href);
const { buildRunPack, runPackBytes, scoreRuns } = await importTool('score.mjs');

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const BASE_TREE = '1'.repeat(40);
export const FINAL_TREE = '2'.repeat(40);

/** What the scoring reads of an agent-change statement of `task`; `results` are the results of its checks, in order. */
export function proofPack(task, { results = null, tamper = false, reported = true } = {}) {
  let at = 0;
  const criteria = task.acceptance.criteria.map((criterion) => ({ id: criterion.id, checks: (criterion.checks ?? []).map(() => ({ result: results?.[at++] ?? 'passed' })) }));
  return {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://github.com/pddczpl/ChatMCP/blob/main/docs/spec/agent-change-v0.1.md',
    predicate: {
      acceptance: { baselineSha256: task.files.find((file) => file.name === task.task.acceptance).sha256 },
      criteria,
      checkChanges: { reported, checksModified: tamper },
    },
  };
}

function scoreOf(task, { patch, passes = 3, outcome = null, outOfScope = [], overwritten = [] }) {
  const ran = outcome === 'patch_does_not_apply' || outcome === 'setup_failed' ? [] : [1, 2, 3].map((run) => ({ run, pass: run <= passes }));
  const counted = ran.filter((run) => run.pass).length;
  const decided = outcome ?? (counted === 3 ? 'pass' : counted === 0 ? 'fail' : 'flaky');
  return {
    format: 'datgold.corpus-score/1', taskId: task.id, baseTree: BASE_TREE, patchSha256: sha256(patch), patchBytes: Buffer.byteLength(patch), hiddenSha256: task.task.hidden_tests.sha256,
    outcome: decided, hiddenPass: decided === 'pass', passes: counted, requiredRuns: 3, runs: ran, outOfScope, overwritten,
  };
}

const USD = (amount) => ({ currency: 'USD', knownSubtotal: amount, complete: true });
/** The run pack of a run of an agent. */
export function agentPack(task, { agent = 'agent-a', repeat = 1, message = 'Finished.\nDONE\n', cost = USD(0.5), proof = proofPack(task), wallMs = 4000, timedOut = false, exitCode = 0, signal = null, ...score } = {}) {
  const patch = `diff of ${task.id}\n`;
  return buildRunPack({
    task, agent, repeat, finalMessage: message, cost, proofPack: proof,
    run: { format: 'datgold.corpus-run/1', baseTree: BASE_TREE, finalTree: FINAL_TREE, patchSha256: sha256(patch), patchBytes: Buffer.byteLength(patch), agent: { exitCode, signal, timedOut, cancelled: false, wallMs } },
    score: scoreOf(task, { patch, ...score }),
  });
}
/** The run pack of a control: the oracle passes and the null agent fails unless the caller says otherwise. */
export function controlPack(task, control, { repeat = 1, passes = control === 'oracle' ? 3 : 0, ...score } = {}) {
  const patch = control === 'oracle' ? fs.readFileSync(path.join(task.dir, task.task.oracle)) : Buffer.alloc(0);
  return buildRunPack({ task, control, repeat, score: scoreOf(task, { patch, passes, ...score }) });
}
export const controlsOf = (tasks) => tasks.flatMap((task) => [controlPack(task, 'oracle'), controlPack(task, 'null')]);
/** Every run of the protocol of `agent`: 3 repeats of each task, each made with `make(task, repeat)`. */
export const fullRuns = (tasks, agent, make = () => ({})) => tasks.flatMap((task) => [1, 2, 3].map((repeat) => agentPack(task, { agent, repeat, ...make(task, repeat) })));
export const packFiles = (packs) => packs.map((pack, index) => ({ name: `run-${String(index).padStart(4, '0')}.json`, bytes: runPackBytes(pack) }));
export const scored = (tasks, packs) => scoreRuns({ tasks, packs: packFiles(packs) });

/** The packs of the golden report: every outcome, claim, proof pack and cost there is, in three synthetic agents. */
export function goldenPacks([T1, T2]) {
  return [
    // agent-a: claims 4 times; one claim held, one failed, one was flaky, one held without a proof pack; one BLOCKED, one without a marker
    agentPack(T1, { repeat: 1, cost: USD(0.5), wallMs: 100_000 }),
    agentPack(T1, {
      repeat: 2, passes: 0, cost: USD(0.25), wallMs: 20_000, proof: proofPack(T1, { tamper: true }), message: 'I rewrote `test/slugify.test.mjs` | <b>all</b> tests pass.\nDONE',
      outOfScope: [{ path: 'package.json', change: 'modified' }, { path: 'test/<img src=x>|`a`.mjs', change: 'added' }], overwritten: ['test/hidden/slugify.test.mjs'],
    }),
    agentPack(T1, { repeat: 3, passes: 2, cost: USD(1), wallMs: 30_000, proof: null }),
    agentPack(T2, { repeat: 1, cost: USD(0.125), wallMs: 40_000, proof: proofPack(T2, { reported: false }) }),
    agentPack(T2, { repeat: 2, message: 'BLOCKED: no network [x](javascript:alert(1)) @someone', passes: 0, cost: USD(2), wallMs: T2.task.limits.wall_seconds * 1000 + 250, timedOut: true, exitCode: null, signal: 'SIGKILL', proof: proofPack(T2, { results: ['failed'] }) }),
    agentPack(T2, { repeat: 3, message: 'Done.', cost: USD(0.125), wallMs: 60_500 }),
    // agent-b: never claims DONE, no cost is known in full, one setup failure
    ...fullRuns([T1, T2], 'agent-b', (task, repeat) => ({
      message: repeat === 1 ? null : 'I tried.', passes: 0, outcome: task === T2 && repeat === 3 ? 'setup_failed' : null, wallMs: 1000 * repeat, proof: null,
      cost: ['unknown', { currency: 'USD', knownSubtotal: 0.3, complete: false }, { currency: 'EUR', knownSubtotal: 0.3, complete: true }][repeat - 1],
    })),
    // agent-c: the first task only; every claim held but one, which is a scoring error
    agentPack(T1, { agent: 'agent-c', repeat: 1, wallMs: 5000 }),
    agentPack(T1, { agent: 'agent-c', repeat: 2, wallMs: 5000 }),
    agentPack(T1, { agent: 'agent-c', repeat: 3, wallMs: 5000, outcome: 'patch_does_not_apply' }),
    // the controls: the null agent of the second task passes, which is a problem
    controlPack(T1, 'oracle'), controlPack(T1, 'null'), controlPack(T2, 'oracle'), controlPack(T2, 'null', { passes: 3 }),
  ];
}

export const GOLDEN_AGENTS = Object.freeze([
  { id: 'agent-a', cli: 'agent-a run --yes', version: '0.0.0-synthetic', model: 'model-x', notes: 'SYNTHETIC: no such agent | `exists`' },
  { id: 'agent-b', cli: 'agent-b exec', version: '0.0.0-synthetic' },
  { id: 'agent-c', cli: 'agent-c', version: '0.0.0-synthetic' },
  { id: 'agent-d', cli: 'agent-d', version: '0.0.0-synthetic', notes: 'registered, never run' },
]);
export const GOLDEN_RESPONSE = [
  'SYNTHETIC response: no vendor wrote this.', '', 'Các số liệu trên là giả lập. <script>alert(1)</script>', '```', '# not a heading', '```', '| a | b |', '[x](javascript:alert(1)) @someone', '',
].join('\n');

/** Writes the packs and results.jsonl (and the response) of the golden report to `folder`; returns the options of generateReport. */
export async function goldenInput(folder) {
  const { loadCorpus } = await importTool('load.mjs');
  const { registrationText } = await importTool('report.mjs');
  const { tasks } = await loadCorpus(EXAMPLES);
  const packs = goldenPacks(tasks);
  fs.mkdirSync(path.join(folder, 'packs'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'responses'));
  for (const file of packFiles(packs)) fs.writeFileSync(path.join(folder, 'packs', file.name), file.bytes);
  fs.writeFileSync(path.join(folder, 'results.jsonl'), scored(tasks, packs).jsonl);
  fs.writeFileSync(path.join(folder, 'responses', 'agent-agent-b.txt'), GOLDEN_RESPONSE);
  fs.writeFileSync(path.join(folder, 'preregistration.json'), registrationText({ tasks, agents: GOLDEN_AGENTS, corpus: { path: 'corpus/examples', commit: '1'.repeat(40) }, scoringCode: null }));
  return {
    corpus: EXAMPLES, packs: path.join(folder, 'packs'), results: path.join(folder, 'results.jsonl'), responses: path.join(folder, 'responses'), preregistration: path.join(folder, 'preregistration.json'), date: '2026-11-25',
  };
}
/** The files of a folder, relative, with / between the parts, sorted by code units. */
export function listFiles(folder, prefix = '') {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? listFiles(path.join(folder, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])).sort();
}
/** The part of a report that is golden: what the report itself writes, not the packs and the files it copies. */
export const isGolden = (name) => /\.(?:html|md)$/.test(name);

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] !== '--write') throw new Error('usage: node tests/fixtures/corpus-report/fixture.mjs --write');
  const { generateReport } = await importTool('report.mjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-report-golden-'));
  try {
    const out = path.join(scratch, 'out');
    await generateReport({ ...await goldenInput(scratch), out });
    fs.rmSync(GOLDEN, { recursive: true, force: true });
    for (const name of listFiles(out).filter(isGolden)) {
      fs.mkdirSync(path.dirname(path.join(GOLDEN, name)), { recursive: true });
      fs.copyFileSync(path.join(out, name), path.join(GOLDEN, name));
    }
    console.log(`${listFiles(GOLDEN).length} golden files written`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
