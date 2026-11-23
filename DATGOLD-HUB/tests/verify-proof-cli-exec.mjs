// `chatmcp verify exec`: the exec wrapper for any external agent (P5 pod-26, docs/PROOF-CLI.md, "exec"), and its output adapters
// (lib/proof/adapters/index.mjs).
//
// The real CLI (`node bin/chatmcp.mjs verify exec ... -- node <fake agent>`) is spawned in temporary Git repositories, with its state
// folder in a temporary folder. The agents are small Node scripts written here; no vendor CLI runs and no model is called. What it proves:
//   1. the doc and the tables: exec's options, codes and answer shape are documented; the adapters are stamped (their own version, the day
//      their documentation was read, the pages) and import nothing;
//   2. the claim: the text it is read from (the whole stream, or the lines that lie wholly inside the last 64 KiB), the contract's reading,
//      a custom DONE marker (--claim-marker) that never shadows BLOCKED, a pattern that runs too long is stopped; the corpus reads the
//      claim with the same function;
//   3. the adapters on documented output: Claude Code (json and stream-json), Codex (exec --json), opencode (documents none);
//   4. usage: every wrong exec command line exits 2 and writes nothing;
//   5. refusals before the agent runs: no acceptance file, an untrusted or unreadable one, a plain folder, a state folder inside the
//      workspace; the agent never starts;
//   6. the fake agents of the plan through the real CLI: one that edits (exit 0), one that tampers with the test (checks_modified), one that
//      claims DONE falsely (a criterion failed, the claim recorded), one that crashes, one that hangs (killed with its tree at --timeout),
//      one that says BLOCKED, one that writes no marker; the adapters, a custom marker, --cost-usd, an output over the log limit and the
//      human output; every answer validates against the CLI's schemas and every pack against the published schema;
//   7. Ctrl-C: the injected interrupt on every platform, a real SIGINT where the platform can send one (not Windows);
//   8. no network: every CLI process runs under a guard that refuses and records any socket, DNS, HTTP or fetch use.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSchema } from '../lib/proof/schema-validate.mjs';
import { validateStatement } from '../lib/proof/pack.mjs';
import { verifyChain } from '../lib/proof/ledger.mjs';
import { parseFinalMarker } from '../lib/proof/marker.mjs';
import { CLI_DATA_SCHEMAS, CLI_FORMAT, CLI_OUTPUT_SCHEMA, CODES, EXIT, MESSAGES } from '../lib/proof/cli/index.mjs';
import { CLAIM_WINDOW_BYTES, LOG_MAX_BYTES, claimText, readClaim, runCriteria } from '../lib/proof/cli/exec.mjs';
import { compileClaimMarker } from '../lib/proof/cli/args.mjs';
import { ADAPTERS, ADAPTER_NAMES, readAgentOutput } from '../lib/proof/adapters/index.mjs';
import { commitAll, newRepo, write } from './support/proof-tree-fixtures.mjs';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Under the mutation runner the Hub is a copy without the repository around it; the runner says where it came from.
const REPO = path.resolve(process.env.CHATMCP_MUTATION_SOURCE ? path.resolve(process.env.CHATMCP_MUTATION_SOURCE) : HUB, '..');
const BIN = path.join(HUB, 'bin', 'chatmcp.mjs');

let checks = 0;
const suiteStart = performance.now();
const elapsed = () => `${((performance.now() - suiteStart) / 1000).toFixed(1)} s`;
const ok = (label) => { checks += 1; console.log(`  ok - ${label} [${elapsed()}]`); };
setTimeout(() => { console.error('FAIL: the proof CLI exec suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

const sha256 = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
const SCRATCH = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-exec-')));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });
const STATE = path.join(SCRATCH, 'state');
const NETLOG = path.join(SCRATCH, 'network.log');
const GUARD = path.join(SCRATCH, 'deny-network.mjs');
const AGENTS = path.join(SCRATCH, 'agents');
const MARKS = path.join(SCRATCH, 'marks');
fs.mkdirSync(AGENTS, { recursive: true });
fs.mkdirSync(MARKS, { recursive: true });
let folders = 0;
const folder = (label) => { const dir = path.join(SCRATCH, `${label}-${(folders += 1)}`); fs.mkdirSync(dir, { recursive: true }); return fs.realpathSync.native(dir); };

// The guard: loaded with --import into every CLI process of this suite (never into the agents the CLI runs). Any use of a socket, DNS,
// HTTP(S), HTTP/2, TLS, UDP, fetch or WebSocket is written to NETLOG and throws.
fs.writeFileSync(GUARD, `
import fs from 'node:fs';
import module from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
const log = process.env.PROOF_CLI_NETLOG;
const deny = (what) => function denied() { try { fs.appendFileSync(log, what + '\\n'); } catch {} throw new Error('network use refused by the test guard: ' + what); };
const table = [[net, 'net', ['connect', 'createConnection', 'createServer']], [tls, 'tls', ['connect', 'createServer']], [dgram, 'dgram', ['createSocket']],
  [dns, 'dns', ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']],
  [dns.promises, 'dns.promises', ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']],
  [http, 'http', ['request', 'get', 'createServer']], [https, 'https', ['request', 'get', 'createServer']], [http2, 'http2', ['connect', 'createServer', 'createSecureServer']]];
for (const [target, label, names] of table) for (const name of names) target[name] = deny(label + '.' + name);
net.Socket.prototype.connect = deny('net.Socket.prototype.connect');
globalThis.fetch = deny('fetch');
if (globalThis.WebSocket) globalThis.WebSocket = deny('WebSocket');
module.syncBuiltinESMExports();
`);
const GUARD_ARGS = ['--import', pathToFileURL(GUARD).href];

// The environment of the CLI: nothing of this process's Git or Hub variables, the state folder in the scratch folder.
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|CHATMCP_)/i.test(key)));
Object.assign(BASE_ENV, { CHATMCP_STATE_DIR: STATE, PROOF_CLI_NETLOG: NETLOG });

function spawnCollect(file, args, { cwd, env, onSpawn = null }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    onSpawn?.(child);
  });
}
/** The CLI as a person runs it: `node bin/chatmcp.mjs <args>` in `cwd`. */
const cli = (args, { cwd = SCRATCH, env = {}, onSpawn } = {}) => spawnCollect(process.execPath, [...GUARD_ARGS, BIN, ...args], { cwd, env: { ...BASE_ENV, ...env }, onSpawn });

const outputSchema = compileSchema(CLI_OUTPUT_SCHEMA);
const dataSchemas = Object.fromEntries(Object.entries(CLI_DATA_SCHEMAS).map(([name, schema]) => [name, compileSchema(schema)]));
const publishedSchema = compileSchema(JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'spec', 'agent-change-v0.1.schema.json'), 'utf8')));

/** The JSON answer of a run: exactly one JSON object on one line, nothing on stderr, valid against the schemas, its exit code its code's. */
function answerOf(result, label) {
  const where = `${label}: exit ${result.status}\nstdout: ${result.stdout.slice(0, 3000)}\nstderr: ${result.stderr.slice(0, 2000)}`;
  assert.equal(result.stderr, '', `${where}\n--json writes nothing to stderr`);
  assert.ok(result.stdout.endsWith('\n') && result.stdout.indexOf('\n') === result.stdout.length - 1, `${where}\n--json writes exactly one line`);
  const answer = JSON.parse(result.stdout);
  const checked = outputSchema.validate(answer);
  assert.ok(checked.valid, `${where}\nthe answer validates against CLI_OUTPUT_SCHEMA: ${JSON.stringify(checked.errors.slice(0, 5))}`);
  if (answer.data !== null) {
    const schema = dataSchemas[answer.command];
    assert.ok(schema, `${where}\nthere is a data schema for ${answer.command}`);
    const data = schema.validate(answer.data);
    assert.ok(data.valid, `${where}\nthe data validates against CLI_DATA_SCHEMAS.${answer.command}: ${JSON.stringify(data.errors.slice(0, 5))}`);
  }
  assert.equal(answer.format, CLI_FORMAT, `${where}\nformat`);
  assert.equal(result.status, answer.exitCode, `${where}\nthe process exits with the answer's exitCode`);
  assert.equal(CODES[answer.code], answer.outcome, `${where}\nthe code ${answer.code} belongs to the outcome ${answer.outcome}`);
  assert.equal(EXIT[answer.outcome], answer.exitCode, `${where}\nthe outcome ${answer.outcome} is exit ${EXIT[answer.outcome]}`);
  if (answer.command === 'exec' && answer.data?.statement) {
    assert.deepEqual(validateStatement(answer.data.statement), { valid: true, errors: [] }, `${where}\nthe statement passes validateStatement`);
    const published = publishedSchema.validate(answer.data.statement);
    assert.ok(published.valid, `${where}\nthe statement validates against docs/spec/agent-change-v0.1.schema.json: ${JSON.stringify(published.errors.slice(0, 5))}`);
  }
  return answer;
}
const withJson = (args) => { const at = args.indexOf('--'); return at < 0 ? [...args, '--json'] : [...args.slice(0, at), '--json', ...args.slice(at)]; };
const ask = async (args, options = {}) => answerOf(await cli(withJson(args), options), `chatmcp ${args.join(' ')}`);
const expectAnswer = (answer, exitCode, code, label) => {
  assert.equal(answer.code, code, `${label}: code ${answer.code} (${answer.message}), expected ${code}\n${JSON.stringify(answer.data?.agent ?? answer.detail)}`);
  assert.equal(answer.exitCode, exitCode, `${label}: exit ${answer.exitCode}, expected ${exitCode}`);
};

/** Every file and folder under `dir`, .git included, with the sha256 of each file. */
function fingerprint(dir) {
  const rows = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      const rel = path.relative(dir, full).replaceAll('\\', '/');
      if (entry.isDirectory()) { rows[rel] = 'dir'; walk(full); } else rows[rel] = `${fs.statSync(full).size}:${sha256(fs.readFileSync(full))}`;
    }
  };
  walk(dir);
  return rows;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function goneWithin(pids, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!pids.some(alive)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !pids.some(alive);
}
const ledgerEntries = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

// ------------------------------------------------------------------------------------------------------------------------- the fake agents
// Each runs in the workspace (its cwd) as `node <file> [args]`, the way a person would wrap `claude -p ...`.
const FIXED = 'export const add = (a, b) => a + b;\n';
const agent = (name, source) => { const file = path.join(AGENTS, `${name}.mjs`); fs.writeFileSync(file, source); return file; };
const FIX = `fs.writeFileSync('src/add.mjs', ${JSON.stringify(FIXED)});`;
const EDIT_OUT = 'I fixed the sign in add().\nDONE\n';
const A = {
  edit: agent('edit', `import fs from 'node:fs';\n${FIX}\nprocess.stdout.write(${JSON.stringify(EDIT_OUT)});\n`),
  tamper: agent('tamper', `import fs from 'node:fs';\nfs.writeFileSync('test.mjs', "console.log('1 test passed');\\n");\nprocess.stdout.write('The tests pass now.\\nDONE\\n');\n`),
  falseDone: agent('false-done', `process.stdout.write('Everything is done.\\nDONE\\n');\n`),
  crash: agent('crash', `import fs from 'node:fs';\nfs.writeFileSync('src/add.mjs', '// half an edit\\n');\nprocess.stdout.write('starting\\n');\nthrow new Error('the agent crashed');\n`),
  hang: agent('hang', `import fs from 'node:fs';\nimport { spawn } from 'node:child_process';\nconst child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nfs.writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));\nprocess.stdout.write('working on it\\n');\nsetInterval(() => {}, 1000);\n`),
  blocked: agent('blocked', `process.stdout.write('I could not run the tests.\\nBLOCKED: the API key is missing\\n');\n`),
  silent: agent('silent', `import fs from 'node:fs';\n${FIX}\nprocess.stdout.write('I changed add(). It should work.\\n');\n`),
  custom: agent('custom', `import fs from 'node:fs';\n${FIX}\nprocess.stdout.write('Work finished.\\nTASK COMPLETE\\n');\n`),
  claude: agent('claude', `import fs from 'node:fs';\n${FIX}\nconst init = { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-test-model', claude_code_version: '2.9.9', cwd: process.cwd(), tools: [] };\nconst result = { type: 'result', subtype: 'success', is_error: false, result: 'Fixed add().\\nDONE', total_cost_usd: 0.0123, num_turns: 2, duration_ms: 1500, session_id: 's1', usage: {} };\nprocess.stdout.write(JSON.stringify(init) + '\\n' + JSON.stringify(result) + '\\n');\n`),
  codex: agent('codex', `const events = [{ type: 'thread.started', thread_id: 't1' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Looking.' } }, { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'I cannot reach the registry.\\nBLOCKED: no network access' } }, { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } }];\nprocess.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n');\n`),
  big: agent('big', `import fs from 'node:fs';\n${FIX}\nconst line = 'x'.repeat(1023) + '\\n';\nconst block = line.repeat(1024);\nfor (let i = 0; i < 17; i += 1) process.stdout.write(block);\nprocess.stdout.write('DONE\\n');\n`),
  interrupt: agent('interrupt', `import fs from 'node:fs';\nimport { spawn } from 'node:child_process';\nconst child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nfs.writeFileSync(process.argv[2] + '.tmp', JSON.stringify([process.pid, child.pid]));\nfs.renameSync(process.argv[2] + '.tmp', process.argv[2]);\nprocess.stdout.write('working\\n');\nsetInterval(() => {}, 1000);\n`),
  ran: agent('ran', `import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], 'the agent ran');\nprocess.stdout.write('DONE\\n');\n`),
};

const ACCEPTANCE = 'version: 1\ncriteria:\n  - id: unit\n    text: The unit test passes\n    checks:\n      - run: node test.mjs\nprotected:\n  - ".chatmcp/**"\n';
const TEST = "import { add } from './src/add.mjs';\nif (add(2, 3) !== 5) { console.error('add is wrong'); process.exit(1); }\nconsole.log('1 test passed');\n";
/** A repository whose add() has a bug that its trusted unit test finds. */
function buggyRepository(label, { acceptance = ACCEPTANCE } = {}) {
  const repo = fs.realpathSync.native(newRepo(label));
  write(repo, 'src/add.mjs', 'export const add = (a, b) => a - b;\n');
  write(repo, 'test.mjs', TEST);
  if (acceptance !== null) write(repo, '.chatmcp/acceptance.yml', acceptance);
  commitAll(repo);
  return repo;
}
const exec = (repo, words, options = [], extra = {}) => ask(['verify', 'exec', ...options, '--', 'node', ...words], { cwd: repo, ...extra });

// ------------------------------------------------------------------------------------------------------------------------- 1. doc, tables, adapters
{
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'PROOF-CLI.md'), 'utf8').replace(/\r\n/g, '\n');
  const section = doc.slice(doc.indexOf('### `exec`'), doc.indexOf('### `check`'));
  assert.ok(section.length > 2000, 'the doc has a full section for exec');
  for (const phrase of ['--claim-marker', '--cost-usd', '--adapter', '--timeout', '--shell', '--agent', 'standard input', 'Ctrl-C', 'evidence', '16 MiB', '64 KiB', 'killTree',
    'version', 'unknown', 'check-runner.mjs', 'lib/proof/marker.mjs', 'stdout.log', 'stderr.log']) {
    assert.ok(section.includes(phrase), `the exec section mentions ${phrase}`);
  }
  for (const code of ['exec_evidenced', 'claim_refuted', 'claim_unverified', 'agent_blocked', 'no_claim', 'agent_failed', 'agent_timed_out', 'exec_interrupted']) {
    assert.ok(Object.hasOwn(CODES, code), `${code} is an answer code`);
    assert.ok(section.includes(`\`${code}\``), `the exec section names ${code}`);
  }
  assert.equal(CODES.exec_evidenced, 'pass');
  for (const code of ['claim_refuted', 'claim_unverified', 'agent_blocked', 'no_claim', 'agent_failed', 'agent_timed_out', 'exec_interrupted']) assert.equal(CODES[code], 'unverified', `${code} is exit 1`);
  assert.ok(dataSchemas.exec, 'exec has a data schema');
  for (const name of ['claim', 'agent', 'checks', 'criteria', 'pack', 'statement', 'paths', 'adapter', 'cost']) assert.ok(CLI_DATA_SCHEMAS.exec.required.includes(name), `exec data holds ${name}`);
  // the adapters: optional, stamped, and they import nothing (they are given the text; they read no file and open no socket)
  assert.deepEqual([...ADAPTER_NAMES].sort(), ['claude', 'codex', 'opencode'], 'the adapters of the plan');
  for (const name of ADAPTER_NAMES) {
    const adapter = ADAPTERS[name];
    assert.ok(Number.isSafeInteger(adapter.version) && adapter.version >= 1, `${name}: its own version`);
    assert.match(adapter.checked, /^\d{4}-\d{2}-\d{2}$/, `${name}: the day its documentation was read`);
    assert.ok(adapter.documentation.length >= 1 && adapter.documentation.every((url) => /^https:\/\/\S+$/.test(url)), `${name}: the pages it follows`);
    assert.ok(adapter.reads.length > 20, `${name}: what it reads`);
    assert.ok(section.includes(adapter.documentation[0]), `the doc names the page the ${name} adapter follows`);
  }
  const adapterSource = fs.readFileSync(path.join(HUB, 'lib', 'proof', 'adapters', 'index.mjs'), 'utf8');
  assert.doesNotMatch(adapterSource, /^\s*import\b|\bimport\s*\(|\brequire\s*\(|\bfetch\s*\(/m, 'the adapters import nothing and fetch nothing');
  assert.match(fs.readFileSync(path.join(REPO, 'docs', 'DEVELOPMENT.md'), 'utf8'), /verify-proof-cli-exec/, 'docs/DEVELOPMENT.md lists this suite');
  ok('the doc documents exec (options, stdin, Ctrl-C, evidence, limits, codes), exec has a data schema, and the three adapters are stamped and import nothing');
}

// ------------------------------------------------------------------------------------------------------------------------- 2. the claim
{
  // the text the claim is read from: the whole stream when it fits the window, else only the lines that lie wholly inside it
  const window = (text) => Buffer.from(text, 'utf8');
  assert.equal(claimText(window('a\nDONE\n'), 7), 'a\nDONE\n', 'a stream inside the window is read whole');
  assert.equal(claimText(window('DONE'), 4), 'DONE', 'one line, no line end');
  assert.equal(claimText(window('xDONE\n'), 10), '', 'a cut stream without a whole line in the window: nothing to read');
  assert.equal(claimText(window('DONE'), 9), '', 'a cut stream with no line break in the window: its last line began before it');
  assert.equal(claimText(window('art\nDONE\n'), 100), 'DONE\n', 'a cut stream: what follows the first line break');
  assert.equal(claimText(window('\nBLOCKED: x'), 100), 'BLOCKED: x', 'a line break at the very start of the window');
  assert.equal(claimText(Buffer.from([0xa1, 0x0a, 0x44, 0x4f, 0x4e, 0x45]), 50), 'DONE', 'a window cut inside a UTF-8 sequence: the cut line is dropped, nothing is mis-decoded');
  assert.equal(claimText(Buffer.alloc(0), 0), '', 'an empty stream');
  assert.equal(CLAIM_WINDOW_BYTES, 64 * 1024);
  assert.equal(LOG_MAX_BYTES, 16 * 1024 * 1024);
  // no false DONE from a cut: the true last line is `zzz...DONE`, longer than the window
  const long = `${'z'.repeat(CLAIM_WINDOW_BYTES * 2)}DONE\n\n`;
  const tail = Buffer.from(long).subarray(-CLAIM_WINDOW_BYTES);
  assert.equal(parseFinalMarker(claimText(tail, long.length)).marker, null, 'a last line longer than the window is never read as DONE');
  assert.equal(parseFinalMarker(long).marker, null, '(premise) the whole text has no marker');

  // the contract's reading, and a custom DONE marker
  const contract = (text) => readClaim(text, { pattern: null });
  assert.deepEqual(contract('work\nDONE\n'), { marker: 'DONE', reason: null, rule: 'contract', pattern: null, line: 'DONE', markerTimedOut: false });
  assert.deepEqual(contract('BLOCKED: no key'), { marker: 'BLOCKED', reason: 'no key', rule: 'contract', pattern: null, line: 'BLOCKED: no key', markerTimedOut: false });
  assert.deepEqual(contract('done'), { marker: null, reason: null, rule: 'contract', pattern: null, line: 'done', markerTimedOut: false });
  assert.equal(contract('').line, null, 'an empty final line is recorded as null');
  assert.equal(contract(`x\n${'y'.repeat(5000)}`).line.length, 1000, 'the recorded line is cut to 1,000 characters');
  const custom = compileClaimMarker('TASK COMPLETE|All done\\.');
  assert.equal(custom.source, '^(?:TASK COMPLETE|All done\\.)$', 'the pattern is anchored to the whole line');
  assert.ok(custom.unicode, 'the pattern is read with the u flag');
  const withCustom = (text) => readClaim(text, { pattern: custom });
  assert.deepEqual(withCustom('x\nTASK COMPLETE\r\n'), { marker: 'DONE', reason: null, rule: 'claim-marker', pattern: 'TASK COMPLETE|All done\\.', line: 'TASK COMPLETE', markerTimedOut: false });
  assert.equal(withCustom('All done.').marker, 'DONE');
  assert.equal(withCustom('Not TASK COMPLETE').marker, null, 'the whole line must match');
  assert.equal(withCustom('DONE').marker, null, 'a custom marker replaces DONE');
  assert.deepEqual([withCustom('BLOCKED: stuck').marker, withCustom('BLOCKED: stuck').reason], ['BLOCKED', 'stuck'], 'BLOCKED stays the contract\'s');
  assert.equal(readClaim('BLOCKED: stuck', { pattern: compileClaimMarker('BLOCKED: .+') }).marker, 'BLOCKED', 'a custom marker never turns BLOCKED into DONE');
  assert.equal(withCustom(`${'TASK COMPLETE'.padEnd(1001, ' ')}x`).marker, null, 'a line over 1,000 characters is not tested');
  for (const bad of ['(', '', 'a'.repeat(201), '.*', 'x?', '\\', '[']) {
    assert.throws(() => compileClaimMarker(bad), (error) => error.code === 'bad_value' && error.detail.option === '--claim-marker', `--claim-marker ${JSON.stringify(bad.slice(0, 20))} is refused`);
  }
  // a pattern that backtracks without end is stopped, and the claim is then no claim
  const started = performance.now();
  const slow = readClaim(`${'a'.repeat(40)}!`, { pattern: compileClaimMarker('(a+)+') });
  assert.deepEqual([slow.marker, slow.markerTimedOut], [null, true], 'a pattern stopped at its time limit is no claim');
  assert.ok(performance.now() - started < 5000, 'and it is stopped within its limit');

  // the corpus reads the claim with the same function (corpus/tools/marker.mjs is a bridge), when the corpus is there
  const corpusMarker = path.join(REPO, 'corpus', 'tools', 'marker.mjs');
  if (fs.existsSync(corpusMarker)) {
    const bridged = await import(pathToFileURL(corpusMarker).href);
    assert.equal(bridged.parseFinalMarker, parseFinalMarker, 'corpus/tools/marker.mjs passes on the Hub\'s parseFinalMarker');
  }
  ok('the claim: the window rules (no false DONE from a cut), the contract, a custom DONE marker (anchored, never shadowing BLOCKED, refused when it matches nothing or everything), a runaway pattern stopped');
}

// ------------------------------------------------------------------------------------------------------------------------- 3. the adapters
{
  const read = (name, lines) => readAgentOutput(name, Array.isArray(lines) ? lines.map((line) => JSON.stringify(line)).join('\n') + '\n' : lines);
  // Claude Code: one result object (--output-format json)
  const single = read('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done it.\nDONE', total_cost_usd: 0.5, session_id: 's', num_turns: 1 }));
  assert.deepEqual(single, {
    adapter: 'claude', version: ADAPTERS.claude.version, checked: ADAPTERS.claude.checked, recognized: true, reason: null, finalMessage: 'Done it.\nDONE',
    cost: { currency: 'USD', knownSubtotal: 0.5, complete: false }, model: null, agentVersion: null, isError: false,
  });
  // stream-json: the init event names the model and the version, the last result event is the outcome
  const stream = read('claude', [{ type: 'system', subtype: 'init', model: 'm-1', claude_code_version: '2.1.0' }, { type: 'assistant', message: {} },
    { type: 'result', subtype: 'success', is_error: false, result: 'first', total_cost_usd: 1 }, { type: 'result', subtype: 'success', is_error: false, result: 'second\nDONE', total_cost_usd: 2 }]);
  assert.deepEqual([stream.recognized, stream.finalMessage, stream.cost.knownSubtotal, stream.model, stream.agentVersion], [true, 'second\nDONE', 2, 'm-1', '2.1.0']);
  const failed = read('claude', JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'], total_cost_usd: 0.1 }));
  assert.deepEqual([failed.recognized, failed.finalMessage, failed.isError, failed.cost.knownSubtotal], [true, null, true, 0.1], 'an error result has no final message');
  for (const [text, reason] of [['plain text\nDONE\n', 'not_json'], ['', 'empty'], [JSON.stringify({ type: 'assistant' }), 'no_result'], [`${JSON.stringify({ type: 'result', result: 'x' })}\nnot json`, 'not_json'],
    ['[1,2]', 'no_result']]) {
    const got = read('claude', text);
    assert.deepEqual([got.recognized, got.reason, got.finalMessage, got.cost], [false, reason, null, null], `claude: ${JSON.stringify(text.slice(0, 30))} is not recognized (${reason})`);
  }
  for (const cost of [-1, 'x', Number.NaN, 2e9, null]) assert.equal(read('claude', JSON.stringify({ type: 'result', result: 'x', total_cost_usd: cost })).cost, null, `a total_cost_usd of ${cost} is no cost`);
  assert.equal(read('claude', [{ type: 'system', subtype: 'init', model: 7, claude_code_version: 'v'.repeat(100) }, { type: 'result', result: 'x' }]).model, null, 'a model that is not text is none');
  assert.equal(read('claude', [{ type: 'system', subtype: 'init', claude_code_version: 'v'.repeat(100) }, { type: 'result', result: 'x' }]).agentVersion.length, 64, 'a version is cut to 64 characters');
  // Codex: JSON Lines; the last agent message is the final one; no cost is documented
  const codex = read('codex', [{ type: 'thread.started', thread_id: 't' }, { type: 'item.completed', item: { type: 'agent_message', text: 'one' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'ls' } }, { type: 'item.completed', item: { type: 'agent_message', text: 'two\nDONE' } }, { type: 'turn.completed', usage: {} }]);
  assert.deepEqual([codex.recognized, codex.finalMessage, codex.cost, codex.isError, codex.model], [true, 'two\nDONE', null, false, null]);
  assert.equal(read('codex', [{ type: 'turn.started' }, { type: 'turn.failed', error: {} }]).isError, true, 'turn.failed is an error');
  assert.equal(read('codex', [{ type: 'thread.started' }, { type: 'error', message: 'x' }]).isError, true, 'an error event is an error');
  assert.equal(read('codex', [{ type: 'thread.started' }]).isError, null, 'no turn end: not known');
  for (const [text, reason] of [['DONE\n', 'not_json'], [JSON.stringify({ hello: 1 }), 'not_json'], [JSON.stringify({ type: 'something.else' }), 'no_events']]) {
    const got = read('codex', text);
    assert.deepEqual([got.recognized, got.reason], [false, reason], `codex: ${JSON.stringify(text.slice(0, 30))} (${reason})`);
  }
  // opencode documents no machine-readable output: its adapter reads nothing and says why
  const opencode = read('opencode', '{"type":"text","part":{"text":"DONE"}}\n');
  assert.deepEqual([opencode.recognized, opencode.reason, opencode.finalMessage, opencode.cost], [false, 'format_not_documented', null, null]);
  assert.throws(() => readAgentOutput('aider', ''), TypeError, 'an unknown adapter is a programming error');
  ok('the adapters on documented output: Claude Code json and stream-json (result, cost as a known subtotal, model, version, errors), Codex JSON Lines (last agent message), opencode reads nothing');
}

// ------------------------------------------------------------------------------------------------------------------------- 4. usage
{
  const plain = folder('usage');
  const before = fingerprint(plain);
  const stateBefore = fs.existsSync(STATE);
  const cases = [
    [['verify', 'exec'], 'missing_command_text'],
    [['verify', 'exec', '--'], 'missing_command_text'],
    [['verify', 'exec', '--', '   '], 'missing_command_text'],
    [['verify', 'exec', '--timeout', '0', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--timeout', '86401', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--timeout', 'soon', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--cost-usd', '-1', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--cost-usd', 'abc', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--cost-usd', '1e3', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--cost-usd', '1000000001', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--cost-usd', '0.1234567', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--claim-marker', '(', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--claim-marker=.*', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--adapter', 'aider', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--shell', 'cmd', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--agent', '', '--', 'node'], 'bad_value'],
    [['verify', 'exec', '--print', '--', 'node'], 'unknown_option'],
    [['verify', 'exec', '--cwd', 'x', '--', 'node'], 'unknown_option'],
    [['verify', 'exec', 'extra', '--', 'node'], 'unexpected_argument'],
    [['verify', 'exec', '--adapter', 'claude', '--adapter', 'codex', '--', 'node'], 'repeated_option'],
  ];
  const answers = await Promise.all(cases.map(([args]) => ask(args, { cwd: plain })));
  cases.forEach(([args, code], index) => expectAnswer(answers[index], 2, code, `chatmcp ${args.join(' ')}`));
  assert.equal(answers[0].detail.command, 'exec', 'missing_command_text names exec');
  assert.match(answers[0].message, /exec/, 'and says so');
  assert.equal(answers[11].detail.option, '--claim-marker');
  assert.deepEqual(fingerprint(plain), before, 'no usage error wrote into the folder');
  assert.equal(fs.existsSync(STATE), stateBefore, 'nor created the state folder');
  ok(`${cases.length} wrong exec command lines exit 2 with their codes and write nothing`);
}

// ------------------------------------------------------------------------------------------------------------------------- 5. refusals before the agent runs
const trustedOnce = { done: false };
async function trustAcceptance(repo) {
  if (trustedOnce.done) return;
  const answer = await ask(['verify', 'trust', '--sha256', sha256(ACCEPTANCE)], { cwd: repo });
  expectAnswer(answer, 0, 'trusted', 'trust the shared acceptance file');
  trustedOnce.done = true;
}
{
  const missing = buggyRepository('no-acceptance', { acceptance: null });
  const untrusted = buggyRepository('untrusted', { acceptance: `${ACCEPTANCE}# not trusted\n` });
  const invalid = buggyRepository('invalid', { acceptance: 'version: 1\ncriteria: [\n' });
  const plain = folder('plain-exec');
  write(plain, '.chatmcp/acceptance.yml', ACCEPTANCE);
  const inside = buggyRepository('state-inside');
  await trustAcceptance(inside);
  const mark = (name) => path.join(MARKS, `${name}.ran`);
  const [noFile, notTrusted, unreadable, notRepo, stateInside, viMissing] = await Promise.all([
    exec(missing, [A.ran, mark('missing')]),
    exec(untrusted, [A.ran, mark('untrusted')]),
    exec(invalid, [A.ran, mark('invalid')]),
    exec(plain, [A.ran, mark('plain')]),
    exec(inside, [A.ran, mark('inside')], [], { env: { CHATMCP_STATE_DIR: path.join(inside, '.state') } }),
    ask(['verify', 'exec', '--lang', 'vi', '--', 'node', A.ran, mark('missing-vi')], { cwd: missing }),
  ]);
  expectAnswer(noFile, 1, 'acceptance_missing', 'exec without an acceptance file');
  expectAnswer(notTrusted, 1, 'not_trusted', 'exec with an untrusted acceptance file');
  assert.match(notTrusted.detail.trustCommand, /^chatmcp verify trust --sha256 [0-9a-f]{64}$/, 'the refusal says how to trust the file');
  expectAnswer(unreadable, 1, 'acceptance_invalid', 'exec with an acceptance file that does not read');
  expectAnswer(notRepo, 4, 'not_a_repository', 'exec in a plain folder');
  expectAnswer(stateInside, 4, 'state_inside_workspace', 'exec with the state folder inside the workspace');
  expectAnswer(viMissing, 1, 'acceptance_missing', 'the same refusal in Vietnamese');
  assert.notEqual(viMissing.message, noFile.message, 'in both languages');
  for (const name of ['missing', 'untrusted', 'invalid', 'plain', 'inside', 'missing-vi']) assert.equal(fs.existsSync(mark(name)), false, `the agent did not run (${name})`);
  assert.equal(fs.existsSync(path.join(inside, '.state')), false, 'nothing was written into the workspace');
  ok('exec refuses before the agent runs: no acceptance file, an untrusted or unreadable one (exit 1), a plain folder and a state folder inside the workspace (exit 4)');
}

// ------------------------------------------------------------------------------------------------------------------------- 6. the fake agents
{
  const repos = Object.fromEntries(['edit', 'tamper', 'falseDone', 'crash', 'hang', 'blocked', 'silent', 'claude', 'codex', 'custom', 'cost', 'big', 'human'].map((name) => [name, buggyRepository(`exec-${name}`)]));
  await trustAcceptance(repos.edit);
  const hangPids = path.join(MARKS, 'hang.pids');
  const editBefore = fingerprint(repos.edit);
  const started = performance.now();
  const [edit, tamper, falseDone, crash, hang, blocked, silent, claude, codex, custom, cost, big, human] = await Promise.all([
    exec(repos.edit, [A.edit], ['--agent', 'fake-edit', '--agent-version', '1.0.0']),
    exec(repos.tamper, [A.tamper]),
    exec(repos.falseDone, [A.falseDone]),
    exec(repos.crash, [A.crash]),
    exec(repos.hang, [A.hang, hangPids], ['--timeout', '4']),
    exec(repos.blocked, [A.blocked]),
    exec(repos.silent, [A.silent]),
    exec(repos.claude, [A.claude], ['--adapter', 'claude']),
    exec(repos.codex, [A.codex], ['--adapter', 'codex']),
    exec(repos.custom, [A.custom], ['--claim-marker', 'TASK COMPLETE']),
    exec(repos.cost, [A.edit], ['--cost-usd', '1.25']),
    exec(repos.big, [A.big]),
    cli(['verify', 'exec', '--', 'node', A.edit], { cwd: repos.human }),
  ]);
  const wall = performance.now() - started;

  // the agent that edits: every criterion evidenced, exit 0
  expectAnswer(edit, 0, 'exec_evidenced', 'the agent that edits');
  const { data } = edit;
  assert.deepEqual(data.claim, { marker: 'DONE', reason: null, from: 'stdout', rule: 'contract', pattern: null, line: 'DONE', markerTimedOut: false });
  assert.deepEqual([data.agent.exit, data.agent.signal, data.agent.timedOut, data.agent.interrupted], [0, null, false, false]);
  assert.deepEqual([data.agent.name, data.agent.version], ['fake-edit', '1.0.0']);
  assert.deepEqual(data.agent.stdout, { sha256: sha256(EDIT_OUT), bytes: Buffer.byteLength(EDIT_OUT), logged: Buffer.byteLength(EDIT_OUT), truncated: false }, 'the stdout hash is of the exact bytes the agent wrote');
  assert.equal(data.agent.stderr.bytes, 0);
  assert.equal(fs.readFileSync(data.paths.stdoutLog, 'utf8'), EDIT_OUT, 'the stdout log is in the evidence folder');
  assert.ok(data.paths.evidence.startsWith(STATE) && data.paths.stdoutLog.startsWith(data.paths.evidence) && data.paths.stderrLog.startsWith(data.paths.evidence), 'the evidence folder is in the state folder');
  assert.equal(fs.readFileSync(data.paths.stderrLog).length, 0);
  assert.deepEqual(data.criteria, [{ id: 'unit', status: 'evidenced' }]);
  assert.deepEqual(data.checks.map((check) => [check.criterion, check.run, check.cwd, check.exit, check.passed]), [['unit', 'node test.mjs', '.', 0, true]]);
  assert.equal(data.checksModified, false);
  assert.equal(data.cost, 'unknown', 'a cost nobody stated stays unknown');
  assert.equal(data.costSource, null);
  assert.equal(data.statement.predicate.cost, 'unknown');
  assert.deepEqual(data.statement.predicate.agent, { name: 'fake-edit', version: '1.0.0' });
  assert.deepEqual(data.pack.changes, { added: 0, modified: 1, deleted: 0 });
  assert.equal(fs.readFileSync(data.pack.file, 'utf8').trim().length > 0, true, 'the statement is written to the state folder');
  // the ledger: the session's start, the agent's run with its claim, then the receipt of the criterion's check
  const entries = ledgerEntries(data.paths.ledger);
  assert.equal(verifyChain(fs.readFileSync(data.paths.ledger)).ok, true, 'the ledger verifies');
  assert.deepEqual(entries.map((entry) => entry.type), ['task_start', 'call', 'check']);
  assert.equal(entries[0].record.source, 'chatmcp verify exec');
  const call = entries[1].record;
  assert.deepEqual([entries[1].seq, entries[1].hash], [data.record.seq, data.record.hash], 'the answer names the call record');
  assert.equal(call.kind, 'agent_exec');
  assert.equal(call.format, 'chatmcp.verify-exec/1');
  assert.equal(call.commandSha256, sha256(data.command), 'the record binds the exact command');
  assert.deepEqual(call.claim, data.claim, 'the claim is recorded in the ledger');
  assert.deepEqual(call.stdout, data.agent.stdout, 'with the digests of what the agent wrote');
  const touched = fingerprint(repos.edit);
  assert.deepEqual(Object.keys(touched).filter((file) => touched[file] !== editBefore[file]), ['src/add.mjs'], 'only the agent wrote into the repository');

  // the agent that tampers with the test: the check passes, but its file changed
  expectAnswer(tamper, 1, 'claim_refuted', 'the agent that tampers with the test');
  assert.deepEqual(tamper.data.criteria, [{ id: 'unit', status: 'checks_modified' }]);
  assert.equal(tamper.data.checksModified, true, 'checksModified');
  assert.equal(tamper.data.statement.predicate.checkChanges.checksModified, true);
  assert.equal(tamper.data.checks[0].passed, true, '(premise) the weakened test passed');
  // the agent that claims DONE falsely: the criterion failed, the claim is recorded
  expectAnswer(falseDone, 1, 'claim_refuted', 'the agent that claims DONE falsely');
  assert.deepEqual(falseDone.data.criteria, [{ id: 'unit', status: 'failed' }], 'a false DONE is a criterion failed');
  assert.equal(falseDone.data.claim.marker, 'DONE');
  assert.equal(ledgerEntries(falseDone.data.paths.ledger)[1].record.claim.marker, 'DONE', 'the false claim is in the ledger');
  // the agent that crashes: its exit code, its stderr logged, the criteria still run
  expectAnswer(crash, 1, 'agent_failed', 'the agent that crashes');
  assert.equal(crash.data.agent.exit, 1);
  assert.match(fs.readFileSync(crash.data.paths.stderrLog, 'utf8'), /the agent crashed/, 'its stderr is in the evidence folder');
  assert.deepEqual(crash.data.criteria, [{ id: 'unit', status: 'failed' }], 'the criteria ran on what it left');
  assert.equal(crash.data.claim.marker, null);
  // the agent that hangs: killed with its tree at the timeout
  expectAnswer(hang, 1, 'agent_timed_out', 'the agent that hangs');
  assert.equal(hang.data.agent.timedOut, true);
  assert.equal(hang.data.agent.timeoutMs, 4000);
  assert.ok(hang.data.agent.durationMs >= 3900 && hang.data.agent.durationMs < 20_000, `stopped at its timeout (${hang.data.agent.durationMs} ms)`);
  const pids = JSON.parse(fs.readFileSync(hangPids, 'utf8'));
  assert.ok(await goneWithin(pids, 10_000), `the agent and its child are gone (${pids.join(', ')})`);
  assert.deepEqual(hang.data.criteria, [{ id: 'unit', status: 'failed' }]);
  // BLOCKED
  expectAnswer(blocked, 1, 'agent_blocked', 'the agent that says BLOCKED');
  assert.deepEqual([blocked.data.claim.marker, blocked.data.claim.reason], ['BLOCKED', 'the API key is missing']);
  assert.match(blocked.message, /the API key is missing/, 'the message quotes the reason');
  // no final marker: no claim, even though the work is right
  expectAnswer(silent, 1, 'no_claim', 'the agent that writes no marker');
  assert.deepEqual(silent.data.criteria, [{ id: 'unit', status: 'evidenced' }], '(premise) its work is right');
  assert.deepEqual([silent.data.claim.marker, silent.data.claim.line], [null, 'I changed add(). It should work.']);
  // Claude Code's documented JSON: the claim from its result, the cost it states, its version and model
  expectAnswer(claude, 0, 'exec_evidenced', 'the Claude-like JSON output through --adapter claude');
  assert.deepEqual([claude.data.claim.marker, claude.data.claim.from], ['DONE', 'adapter']);
  assert.deepEqual(claude.data.adapter, { name: 'claude', version: ADAPTERS.claude.version, checked: ADAPTERS.claude.checked, recognized: true, reason: null, isError: false, model: 'claude-test-model', agentVersion: '2.9.9' });
  assert.deepEqual(claude.data.cost, { currency: 'USD', knownSubtotal: 0.0123, complete: false });
  assert.equal(claude.data.costSource, 'adapter');
  assert.deepEqual(claude.data.statement.predicate.cost, { currency: 'USD', knownSubtotal: 0.0123, complete: false }, 'the pack records the stated cost');
  assert.deepEqual(claude.data.statement.predicate.agent, { name: 'claude', version: '2.9.9' }, 'the agent is named by the adapter and the output');
  assert.equal(claude.data.statement.predicate.model.id, 'claude-test-model');
  // Codex's JSON Lines: BLOCKED in its last agent message
  expectAnswer(codex, 1, 'agent_blocked', 'the Codex-like JSON Lines through --adapter codex');
  assert.deepEqual([codex.data.claim.reason, codex.data.claim.from, codex.data.cost], ['no network access', 'adapter', 'unknown']);
  // a custom DONE marker
  expectAnswer(custom, 0, 'exec_evidenced', 'a custom marker through --claim-marker');
  assert.deepEqual([custom.data.claim.rule, custom.data.claim.pattern], ['claim-marker', 'TASK COMPLETE']);
  // --cost-usd: a cost the person states
  expectAnswer(cost, 0, 'exec_evidenced', 'exec --cost-usd');
  assert.deepEqual(cost.data.statement.predicate.cost, { currency: 'USD', knownSubtotal: 1.25, complete: true });
  assert.equal(cost.data.costSource, 'option');
  // an output over the log limit: hashed and counted whole, logged up to 16 MiB, the claim read from its end
  expectAnswer(big, 0, 'exec_evidenced', 'an agent that writes 17 MiB');
  const bigBytes = 17 * 1024 * 1024 + 5;
  assert.deepEqual([big.data.agent.stdout.bytes, big.data.agent.stdout.logged, big.data.agent.stdout.truncated], [bigBytes, LOG_MAX_BYTES, true]);
  assert.equal(fs.statSync(big.data.paths.stdoutLog).size, LOG_MAX_BYTES, 'the log holds the first 16 MiB');
  const line = `${'x'.repeat(1023)}\n`;
  assert.equal(big.data.agent.stdout.sha256, sha256(Buffer.concat([Buffer.from(line.repeat(1024 * 17)), Buffer.from('DONE\n')])), 'the hash covers every byte');
  // the human output: the agent's output as it runs, then the answer
  assert.equal(human.status, 0, `exec without --json exits 0: ${human.stderr}`);
  assert.ok(human.stdout.startsWith(EDIT_OUT), `the agent's output comes first: ${human.stdout.slice(0, 200)}`);
  assert.match(human.stdout.slice(EDIT_OUT.length), /DONE/, 'then the answer');
  assert.ok(wall < 120_000, `the agents ran in parallel within the budget (${Math.round(wall)} ms)`);
  ok('the fake agents through the real CLI: edit (0), tamper (checks_modified), false DONE (failed, claim recorded), crash, hang (tree killed at --timeout), BLOCKED, no marker; the Claude and Codex adapters, a custom marker, --cost-usd, 17 MiB of output, the human output');
}

// ------------------------------------------------------------------------------------------------------------------------- 6b. the criteria step alone
{
  const calls = [];
  const receipt = (exit) => ({ receipt: { exit, timedOut: false, cancelled: false, signal: null }, entry: { seq: calls.length + 1 } });
  const runnable = [{ criterionId: 'a', index: 0, run: 'one', cwd: '.', timeout: 1, expect: { exit: 0 }, repeat: 3 }, { criterionId: 'b', index: 0, run: 'two', cwd: '.', timeout: 1, expect: { exit: 2 }, repeat: 1 }];
  const exits = { one: [0, 1, 0], two: [2] };
  const result = await runCriteria({ runnable, recordOne: async (check) => { calls.push(check.run); return receipt(exits[check.run][calls.filter((run) => run === check.run).length - 1]); } });
  assert.deepEqual(calls, ['one', 'one', 'two'], 'a check is repeated as the file asks, and stops at its first failure');
  assert.deepEqual(result.results.map((row) => [row.criterion, row.attempt, row.passed]), [['a', 0, true], ['a', 1, false], ['b', 0, true]], 'a pass is the exit the file expects');
  assert.equal(result.interrupted, false);
  const controller = new AbortController();
  const stopped = await runCriteria({ runnable, signal: controller.signal, recordOne: async () => { controller.abort(); return receipt(0); } });
  assert.deepEqual([stopped.results.length, stopped.interrupted], [1, true], 'an interrupt stops before the next run');
  const refused = await runCriteria({ runnable: [runnable[1]], recordOne: async () => { throw Object.assign(new Error('gone'), { code: 'bad_cwd' }); } });
  assert.deepEqual(refused.results.map((row) => [row.seq, row.passed, row.error]), [[null, false, 'bad_cwd']], 'a check that cannot start has no receipt and names why');
  ok('the criteria step: repeats, the expected exit, a stop at the first failure, an interrupt, a check that cannot start');
}

// ------------------------------------------------------------------------------------------------------------------------- 7. Ctrl-C
{
  // The injected interrupt: a driver imports the CLI's main() and hands it an emitter in place of the process, which it fires once the
  // agent has started its child. It takes the same path as a real Ctrl-C, on every platform.
  const driver = path.join(SCRATCH, 'interrupt-driver.mjs');
  fs.writeFileSync(driver, `import fs from 'node:fs';
import { EventEmitter } from 'node:events';
const { main } = await import(process.env.CLI_URL);
const signals = new EventEmitter();
const ready = process.env.READY_FILE;
const timer = setInterval(() => { if (fs.existsSync(ready)) { clearInterval(timer); signals.emit('SIGINT'); } }, 50);
process.exitCode = await main(process.argv.slice(2), { signals });
clearInterval(timer);
`);
  const repo = buggyRepository('interrupt-injected');
  await trustAcceptance(repo);
  const ready = path.join(MARKS, 'injected.pids');
  const injected = answerOf(await spawnCollect(process.execPath, [...GUARD_ARGS, driver, 'verify', 'exec', '--json', '--', 'node', A.interrupt, ready], {
    cwd: repo, env: { ...BASE_ENV, CLI_URL: pathToFileURL(path.join(HUB, 'lib', 'proof', 'cli', 'index.mjs')).href, READY_FILE: ready },
  }), 'exec interrupted (injected)');
  expectAnswer(injected, 1, 'exec_interrupted', 'Ctrl-C while the agent runs (injected)');
  assert.equal(injected.data.agent.interrupted, true);
  assert.equal(injected.data.pack, null, 'no pack is built after a Ctrl-C');
  assert.deepEqual(injected.data.checks, [], 'no check runs after a Ctrl-C');
  const pids = JSON.parse(fs.readFileSync(ready, 'utf8'));
  assert.ok(await goneWithin(pids, 10_000), `the agent and its child are gone (${pids.join(', ')})`);
  const entries = ledgerEntries(injected.data.paths.ledger);
  assert.deepEqual(entries.map((entry) => entry.type), ['task_start', 'call'], 'the agent\'s run is recorded, nothing after it');
  assert.equal(entries[1].record.interrupted, true);
  let real = 'not run: Windows has no way to send a Ctrl-C to one process';
  if (process.platform !== 'win32') {
    // a real SIGINT, as a terminal sends it to the CLI
    const repo2 = buggyRepository('interrupt-real');
    const ready2 = path.join(MARKS, 'real.pids');
    let child;
    const waiting = cli(['verify', 'exec', '--json', '--', 'node', A.interrupt, ready2], { cwd: repo2, onSpawn: (spawned) => { child = spawned; } });
    const until = Date.now() + 30_000;
    while (!fs.existsSync(ready2) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(ready2), 'the agent started');
    child.kill('SIGINT');
    const answer = answerOf(await waiting, 'exec interrupted (SIGINT)');
    expectAnswer(answer, 1, 'exec_interrupted', 'a real SIGINT while the agent runs');
    const pids2 = JSON.parse(fs.readFileSync(ready2, 'utf8'));
    assert.ok(await goneWithin(pids2, 10_000), `the agent and its child are gone after SIGINT (${pids2.join(', ')})`);
    assert.ok(answer.data.agent.durationMs < 5000, `the SIGINT reached the agent's group, which stopped before the grace ran out (${answer.data.agent.durationMs} ms)`);
    real = 'a real SIGINT too';
  }
  ok(`Ctrl-C: the agent and its child are stopped, the run is recorded, no check and no pack follow (injected; ${real})`);
}

// ------------------------------------------------------------------------------------------------------------------------- 8. no network, at the end
{
  assert.equal(fs.existsSync(NETLOG) ? fs.readFileSync(NETLOG, 'utf8') : '', '', 'no CLI process of this suite used the network');
  assert.ok(MESSAGES.exec_interrupted.vi({}) !== MESSAGES.exec_interrupted.en({}), 'the messages exist in both languages');
  ok('no CLI process of this suite opened a socket, looked up a name, made an HTTP request or called fetch');
}

console.log(`verify-proof-cli-exec: ${checks} checks passed in ${elapsed()}`);
