// `chatmcp verify check` and `chatmcp verify reproduce` (P5 pod-32, docs/PROOF-CLI.md, "check", "reproduce" and "The pack file"): a third
// party checks a proof pack and reproduces its checks.
//
// The real CLI (`node bin/chatmcp.mjs`) is spawned in temporary Git repositories, with its state folders and its temporary folder in a
// temporary folder: the maker's state folder, and a second one for the third party who trusts nothing yet. What it proves:
//   1. the doc and the tables: the pack file format, the two commands, their codes and reasons are documented;
//   2. usage: every wrong check / reproduce / trust --pack command line exits 2 and writes nothing;
//   3. the pack file `pack` writes beside the statement: canonical JSON, the statement and its digest, the patch, the ledger and the
//      acceptance file; check verifies the schema, the digest, every file, the ledger's chain and the receipts against it (exit 0), and the
//      workspace's tree with --tree; a pack whose criteria are not evidenced is exit 1;
//   4. tampering: one changed byte anywhere in the pack is exit 3 (every byte of a pack, in process; a few through the CLI), a statement
//      alone, a pretty-printed pack, a pack rewritten with its digest recomputed (caught by the ledger), a swapped file;
//   5. trust --pack: the preview lists the setup and the checks, the approval names the bytes;
//   6. reproduce: nothing runs without trust (the trust command and the commands are listed, no temporary worktree is made); a base folder
//      and a base commit reproduce every receipt (exit 0), the share is printed, the person's workspace, its .git and the base folder are
//      never written, the temporary worktree is removed; a base that is not the pack's before tree, a patch that does not apply or does
//      not give the after tree, a setup that fails, a check whose outcome changes (flaky), a variable missing here, a pack with nothing to
//      reproduce; the divergence reasons one by one;
//   7. Ctrl-C: injected through main() on every platform, a real SIGINT on Linux and macOS: the check is stopped and the temporary worktree
//      is removed;
//   8. the cross-system fixture: every committed pack (tests/fixtures/proof-reproduce/) checks and reproduces on this system, from a folder
//      and from a commit;
//   9. no network: every CLI process runs under a guard that refuses and records any socket, DNS, HTTP or fetch use.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSchema } from '../lib/proof/schema-validate.mjs';
import { canonicalJson, statementDigest, validateStatement } from '../lib/proof/pack.mjs';
import { CLI_DATA_SCHEMAS, CLI_FORMAT, CLI_OUTPUT_SCHEMA, CODES, COMMANDS, EXIT, MESSAGES, main } from '../lib/proof/cli/index.mjs';
import { PACK_FILE_FORMAT, PACK_FILE_MAX_BYTES, PACK_FILE_NAMES, encodePackFile, readPackFile } from '../lib/proof/cli/check.mjs';
import { NOT_COMPARED, REPRODUCE_PASSES, REPRODUCE_REASONS, variablesNamed, verdictOf } from '../lib/proof/cli/reproduce.mjs';
import { CliStop } from '../lib/proof/cli/codes.mjs';
import { git, newRepo } from './support/proof-tree-fixtures.mjs';
import { ACCEPTANCE as FIXTURE_ACCEPTANCE, BASE as FIXTURE_BASE, applyChange as fixtureChange, committedPacks, writeFiles } from './fixtures/proof-reproduce/fixture.mjs';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Under the mutation runner the Hub is a copy without the repository around it; the runner says where it came from.
const REPO = path.resolve(process.env.CHATMCP_MUTATION_SOURCE ? path.resolve(process.env.CHATMCP_MUTATION_SOURCE) : HUB, '..');
const BIN = path.join(HUB, 'bin', 'chatmcp.mjs');

let checks = 0;
const suiteStart = performance.now();
const elapsed = () => `${((performance.now() - suiteStart) / 1000).toFixed(1)} s`;
const ok = (label) => { checks += 1; console.log(`  ok - ${label} [${elapsed()}]`); };
setTimeout(() => { console.error('FAIL: the proof reproduce suite exceeded its own time budget'); process.exit(2); }, 290_000).unref();

const sha256 = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
const SCRATCH = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-repro-')));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });
const STATE = path.join(SCRATCH, 'state'); // the maker's state folder
const THIRD = path.join(SCRATCH, 'third'); // the third party's: trusts nothing until it is told to
const TMP = path.join(SCRATCH, 'tmp'); // the CLI's temporary folder: where reproduce makes its worktree
const NETLOG = path.join(SCRATCH, 'network.log');
const GUARD = path.join(SCRATCH, 'deny-network.mjs');
const RUNLOG = path.join(SCRATCH, 'ran.log'); // every setup and check script of this suite appends its name here
fs.mkdirSync(TMP, { recursive: true });
let folders = 0;
const folder = (label) => { const dir = path.join(SCRATCH, `${label}-${(folders += 1)}`); fs.mkdirSync(dir, { recursive: true }); return fs.realpathSync.native(dir); };
const real = (dir) => fs.realpathSync.native(dir);

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

// The environment of the CLI: nothing of this process's Git or Hub variables, the state folder and the temporary folder in the scratch folder.
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|CHATMCP_)/i.test(key)));
Object.assign(BASE_ENV, { CHATMCP_STATE_DIR: STATE, PROOF_CLI_NETLOG: NETLOG, PROOF_REPRO_LOG: RUNLOG, TMP, TEMP: TMP, TMPDIR: TMP });

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
  return answer;
}
const withJson = (args) => [...args, '--json'];
const ask = async (args, options = {}) => answerOf(await cli(withJson(args), options), `chatmcp ${args.join(' ')}`);
const expectAnswer = (answer, exitCode, code, label) => {
  assert.equal(answer.code, code, `${label}: code ${answer.code} (${answer.message}), expected ${code}\n${JSON.stringify(answer.detail ?? answer.data?.receipts ?? null).slice(0, 2000)}`);
  assert.equal(answer.exitCode, exitCode, `${label}: exit ${answer.exitCode}, expected ${exitCode}`);
};
const third = { CHATMCP_STATE_DIR: THIRD };

/** Every file and folder under `dir`, .git included, with the sha256 of each file: what "nothing was written" is compared on. */
function fingerprint(dir) {
  const rows = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      const rel = path.relative(dir, full).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) rows[rel] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) { rows[rel] = 'dir'; walk(full); } else rows[rel] = `${fs.statSync(full).size}:${sha256(fs.readFileSync(full))}`;
    }
  };
  walk(dir);
  return rows;
}
/** The temporary worktrees reproduce left in its temporary folder: none, ever. */
const leftovers = () => fs.readdirSync(TMP).filter((name) => name.startsWith('chatmcp-reproduce-'));
const ran = () => (fs.existsSync(RUNLOG) ? fs.readFileSync(RUNLOG, 'utf8').split('\n').filter(Boolean) : []);
const clearRan = () => fs.rmSync(RUNLOG, { force: true });

// A script of a project here appends its name to RUNLOG (when the variable is set), so the suite sees what ran.
const logged = (name, body) => `import fs from 'node:fs';\nif (process.env.PROOF_REPRO_LOG) fs.appendFileSync(process.env.PROOF_REPRO_LOG, '${name}\\n');\n${body}`;
const PROJECT = {
  '.gitignore': 'build/\n',
  'src/add.mjs': 'export const add = (a, b) => a - b;\n',
  'setup.mjs': logged('setup', "fs.mkdirSync('build', { recursive: true });\nfs.writeFileSync('build/ready.txt', 'ready\\n');\n"),
  'test.mjs': logged('test', "import { add } from './src/add.mjs';\nif (!fs.existsSync('build/ready.txt')) process.exit(2);\nif (add(2, 3) !== 5) { console.error('add is wrong'); process.exit(1); }\nconsole.log('1 test passed');\n"),
  'fails.mjs': logged('fails', "console.error('a known failure');\nprocess.exit(1);\n"),
  'env-check.mjs': logged('env-check', "process.exit(process.argv[2] === 'on' ? 0 : 5);\n"),
  'flaky.mjs': logged('flaky', "const file = process.env.PROOF_FLAKY_FILE;\nconst n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;\nfs.writeFileSync(file, String(n + 1));\nprocess.exit(n % 2);\n"),
  'slow.mjs': logged('slow', "fs.writeFileSync(process.env.PROOF_SLOW_MARK, String(process.pid));\nsetTimeout(() => {}, 120_000);\n"),
};
const FIX = { 'src/add.mjs': 'export const add = (a, b) => a + b;\n', 'src/new.mjs': 'export const fresh = 1;\n' };
const acceptanceOf = (criteria, setup = ['node setup.mjs']) => [
  'version: 1', 'criteria:',
  ...criteria.flatMap(([id, run, exit]) => [`  - id: ${id}`, `    text: ${id}`, '    checks:', `      - run: ${JSON.stringify(run)}`, ...(exit === undefined ? [] : ['        expect:', `          exit: ${exit}`])]),
  ...(setup.length ? ['reproduce:', '  setup:', ...setup.map((command) => `    - ${JSON.stringify(command)}`)] : []), '',
].join('\n');

/**
 * A real session of the maker: a repository of `files` and `acceptance`, committed; trusted, snapshot, a copy of the base folder; the
 * `before` checks on the base tree, the agent's `change`, the `after` checks; then pack. Resolves {repo, base, packFile, pack, statement}.
 */
async function makePack(label, { files = PROJECT, acceptance, before = [], change = FIX, after = [], env = {}, setup = true } = {}) {
  const repo = real(newRepo(label));
  writeFiles(repo, files);
  if (acceptance !== null) writeFiles(repo, { '.chatmcp/acceptance.yml': acceptance });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  if (acceptance !== null) expectAnswer(await ask(['verify', 'trust', '--sha256', sha256(acceptance)], { cwd: repo }), 0, 'trusted', `${label}: trust`);
  expectAnswer(await ask(['verify', 'snapshot'], { cwd: repo }), 0, 'snapshot_taken', `${label}: snapshot`);
  const base = folder(`${label}-base`);
  writeFiles(base, files);
  if (acceptance !== null) writeFiles(base, { '.chatmcp/acceptance.yml': acceptance });
  if (setup) writeFiles(repo, { 'build/ready.txt': 'ready\n' }); // the maker ran the setup by hand; build/ is ignored
  for (const command of before) await ask(['verify', 'run', '--', command], { cwd: repo, env });
  writeFiles(repo, change);
  for (const command of after) await ask(['verify', 'run', '--', command], { cwd: repo, env });
  const pack = await ask(['verify', 'pack'], { cwd: repo });
  assert.ok([0, 1].includes(pack.exitCode), `${label}: pack ${pack.code} ${pack.message}`);
  return { repo, base, packFile: pack.data.packFile, pack, statement: pack.data.statement };
}
const isIntegrity = (error) => error instanceof CliStop && CODES[error.code] === 'integrity';

// ------------------------------------------------------------------------------------------------------------------------- 1. doc and tables
{
  assert.ok(COMMANDS.includes('check') && COMMANDS.includes('reproduce'), 'check and reproduce are commands of the CLI');
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'PROOF-CLI.md'), 'utf8').replace(/\r\n/g, '\n');
  for (const heading of ['### `check`', '### `reproduce`', '## The pack file']) assert.ok(doc.includes(heading), `the doc has ${heading}`);
  for (const phrase of [PACK_FILE_FORMAT, 'pod-32', '--tree', '--base <commit|folder>', 'trust --pack', 'reproduce.setup', 'statementDigest', '256 MiB',
    ...PACK_FILE_NAMES, ...REPRODUCE_REASONS.map((reason) => `\`${reason}\``), ...NOT_COMPARED.map((why) => `\`${why}\``)]) {
    assert.ok(doc.includes(phrase), `the doc mentions ${phrase}`);
  }
  assert.doesNotMatch(doc, /not_built|not built yet/, 'nothing is left unbuilt');
  assert.equal(Object.hasOwn(CODES, 'not_built'), false, 'not_built is gone with the last command it answered');
  for (const code of ['pack_verified', 'reproduced']) assert.equal(CODES[code], 'pass', `${code} is exit 0`);
  for (const code of ['pack_not_evidenced', 'tree_mismatch', 'reproduce_divergent', 'nothing_to_reproduce', 'base_mismatch', 'reproduce_interrupted']) assert.equal(CODES[code], 'unverified', `${code} is exit 1`);
  for (const code of ['missing_argument', 'bad_pack', 'bad_base']) assert.equal(CODES[code], 'usage', `${code} is exit 2`);
  for (const code of ['pack_unreadable', 'pack_invalid', 'pack_digest_mismatch', 'pack_file_mismatch', 'pack_ledger_broken']) assert.equal(CODES[code], 'integrity', `${code} is exit 3`);
  assert.equal(CODES.pack_too_large, 'environment', 'pack_too_large is exit 4');
  assert.deepEqual(PACK_FILE_NAMES, ['change.diff', 'ledger.jsonl', 'acceptance.yml']);
  assert.equal(PACK_FILE_MAX_BYTES, 256 * 1024 * 1024);
  assert.equal(REPRODUCE_PASSES, 2, 'one more pass only after a divergence');
  // the pack file format is a part of the spec's neighbourhood: the spec names where a pack file is described
  assert.match(fs.readFileSync(path.join(REPO, 'docs', 'spec', 'agent-change-v0.1.md'), 'utf8'), /PROOF-CLI\.md/, 'the spec points at the pack file');
  ok(`the doc documents check, reproduce and the pack file (${PACK_FILE_NAMES.length} files, ${REPRODUCE_REASONS.length} divergence reasons, ${NOT_COMPARED.length} kinds of receipt not compared)`);
}

// ------------------------------------------------------------------------------------------------------------------------- 2. usage
{
  const plain = folder('usage');
  fs.writeFileSync(path.join(plain, 'x.json'), '{}');
  const cases = [
    [['verify', 'check'], 'missing_argument', { command: 'check', argument: '<pack>' }],
    [['verify', 'reproduce'], 'missing_argument', { command: 'reproduce', argument: '<pack>' }],
    [['verify', 'reproduce', 'x.json'], 'missing_argument', { command: 'reproduce', argument: '--base' }],
    [['verify', 'check', 'x.json', 'y.json'], 'unexpected_argument', { argument: 'y.json' }],
    [['verify', 'check', 'x.json', '--', 'z'], 'unexpected_argument', { argument: '--' }],
    [['verify', 'check', 'x.json', '--base', 'HEAD'], 'unknown_option', { option: '--base', command: 'check' }],
    [['verify', 'reproduce', 'x.json', '--base', 'HEAD', '--tree'], 'unknown_option', { option: '--tree', command: 'reproduce' }],
    [['verify', 'check', 'x.json', '--tree=1'], 'bad_value', { option: '--tree', value: '1', expected: 'no value (a flag)' }],
    [['verify', 'reproduce', 'x.json', '--base='], 'bad_value', { option: '--base', value: '', expected: 'a commit or a folder' }],
    [['verify', 'trust', '--pack='], 'bad_value', { option: '--pack', value: '', expected: 'a pack file' }],
    [['verify', 'check', 'missing.json'], 'bad_pack', { path: path.join(plain, 'missing.json') }],
    [['verify', 'check', '.'], 'bad_pack', { path: plain }],
    [['verify', 'reproduce', 'missing.json', '--base', '.'], 'bad_pack', { path: path.join(plain, 'missing.json') }],
  ];
  const before = fingerprint(plain);
  for (const [args, code, detail] of cases) {
    const answer = await ask(args, { cwd: plain });
    expectAnswer(answer, 2, code, args.join(' '));
    assert.deepEqual(answer.detail, detail, `${args.join(' ')}: detail`);
    assert.equal(answer.data, null);
  }
  const vi = await ask(['verify', 'check', '--lang', 'vi'], { cwd: plain });
  assert.equal(vi.message, MESSAGES.missing_argument.vi({ command: 'check', argument: '<pack>' }), 'and in Vietnamese');
  const human = await cli(['verify', 'reproduce', 'x.json'], { cwd: plain });
  assert.equal(human.status, 2);
  assert.match(human.stderr, /--base/, 'the human answer names what is missing');
  const helped = await cli(['verify', 'reproduce', '--help'], { cwd: plain });
  assert.equal(helped.status, 0);
  assert.match(helped.stdout, /reproduce <pack> --base <commit\|folder>/, 'the usage names reproduce');
  assert.match(helped.stdout, /check <pack> \[--tree\]/, 'and check');
  assert.deepEqual(fingerprint(plain), before, 'nothing is written into the folder');
  assert.equal(fs.existsSync(STATE), false, 'nor into the state folder');
  assert.deepEqual(leftovers(), [], 'nor a temporary worktree');
  ok(`${cases.length} wrong check, reproduce and trust --pack command lines exit 2 with their codes and write nothing`);
}

// ------------------------------------------------------------------------------------------------------------------------- 3. the pack file and check
const GOOD_ACCEPTANCE = acceptanceOf([['unit', 'node test.mjs'], ['known-bug', 'node fails.mjs', 1]]);
const good = await makePack('good', { acceptance: GOOD_ACCEPTANCE, before: ['node test.mjs'], after: ['node test.mjs', 'node fails.mjs', 'node -e "0"'] });
let goodBytes;
{
  const { repo, packFile, pack, statement } = good;
  expectAnswer(pack, 0, 'pack_evidenced', 'the pack of the good session');
  assert.equal(path.dirname(packFile), path.dirname(pack.data.file), 'the pack file lies beside the statement, in the state folder');
  assert.ok(packFile.startsWith(STATE) && packFile.endsWith(`${pack.data.taskId}.pack.json`), packFile);
  goodBytes = fs.readFileSync(packFile);
  const text = goodBytes.toString('utf8');
  assert.ok(text.endsWith('}\n') && text.indexOf('\n') === text.length - 1, 'one line of JSON and a line end');
  const parsed = JSON.parse(text);
  assert.equal(text, `${canonicalJson(parsed)}\n`, 'the pack file is canonical JSON');
  assert.deepEqual(Object.keys(parsed).sort(), ['files', 'format', 'statement', 'statementDigest']);
  assert.equal(parsed.format, PACK_FILE_FORMAT);
  assert.deepEqual(parsed.statement, statement, 'the statement of the pack file is the one pack built');
  assert.equal(parsed.statementDigest, pack.data.digest, 'with its digest');
  assert.equal(parsed.statementDigest, statementDigest(statement));
  assert.deepEqual(Object.keys(parsed.files).sort(), ['acceptance.yml', 'change.diff', 'ledger.jsonl']);
  const decoded = Object.fromEntries(Object.entries(parsed.files).map(([name, file]) => [name, Buffer.from(file.base64, 'base64')]));
  assert.equal(decoded['acceptance.yml'].toString('utf8'), GOOD_ACCEPTANCE, 'the acceptance file as it was at the snapshot');
  assert.equal(sha256(decoded['change.diff']), statement.subject.find((subject) => subject.name === 'change.diff').digest.sha256, 'the patch the statement names');
  assert.match(decoded['change.diff'].toString('utf8'), /^diff --git a\/src\/add\.mjs b\/src\/add\.mjs/m);
  assert.equal(sha256(decoded['ledger.jsonl']), sha256(fs.readFileSync(path.join(STATE, 'proof', `${pack.data.taskId}.jsonl`))), 'the session\'s ledger, byte for byte');
  for (const [name, file] of Object.entries(parsed.files)) assert.deepEqual([file.sha256, file.bytes], [sha256(decoded[name]), decoded[name].length], `${name}: its sha256 and size`);

  const stateBefore = fingerprint(STATE);
  const repoBefore = fingerprint(repo);
  const checked = await ask(['verify', 'check', packFile], { cwd: repo });
  expectAnswer(checked, 0, 'pack_verified', 'check of a genuine, evidenced pack');
  const data = checked.data;
  assert.equal(checked.workspace, null, 'check without --tree has no workspace');
  assert.equal(data.file, packFile);
  assert.equal(data.digest, pack.data.digest);
  assert.equal(data.format, PACK_FILE_FORMAT);
  assert.deepEqual(data.criteria, [{ id: 'unit', status: 'evidenced' }, { id: 'known-bug', status: 'evidenced' }]);
  assert.equal(data.receipts, statement.predicate.receipts.length);
  assert.equal(data.receipts, 4, 'the receipts of the session: the base tree run, the two checks, a command of no check');
  assert.deepEqual(data.subjects, {
    before: statement.subject[0].digest.gitTree, after: statement.subject[1].digest.gitTree, diff: statement.subject[2].digest.sha256, commit: null,
  });
  assert.equal(data.baseCommit, statement.predicate.baseCommit);
  assert.deepEqual(data.acceptance, { sha256: sha256(GOOD_ACCEPTANCE), trusted: true, edited: false });
  assert.deepEqual(data.ledger, { records: statement.predicate.ledger.records, lastHash: statement.predicate.ledger.lastHash });
  assert.deepEqual(data.files.map((file) => file.name), ['acceptance.yml', 'change.diff', 'ledger.jsonl']);
  assert.equal(data.tree, null);
  assert.deepEqual(fingerprint(STATE), stateBefore, 'check writes nothing into the state folder');
  assert.deepEqual(fingerprint(repo), repoBefore, 'nor into the workspace');

  const treed = await ask(['verify', 'check', packFile, '--tree'], { cwd: repo });
  expectAnswer(treed, 0, 'pack_verified', 'check --tree in the workspace the pack was made of');
  assert.equal(treed.workspace, repo);
  assert.deepEqual(treed.data.tree, { treeAlgorithm: statement.predicate.trees.after.treeAlgorithm, objectFormat: statement.predicate.trees.after.objectFormat, tree: data.subjects.after, matches: true });
  assert.deepEqual(fingerprint(repo), repoBefore, 'check --tree writes nothing into the workspace');
  const human = await cli(['verify', 'check', packFile, '--lang', 'vi']);
  assert.equal(human.status, 0);
  assert.ok(human.stdout.includes(MESSAGES.pack_verified.vi({})) && human.stdout.includes('unit: evidenced'), human.stdout);
  ok(`pack writes a canonical pack file (${goodBytes.length} bytes: statement, digest, patch, ledger, acceptance file); check verifies it (exit 0), --tree matches the workspace, nothing is written`);
}
{
  // the workspace moved on: --tree says so (exit 1); the pack itself still verifies
  write1(good.repo, 'src/later.mjs', 'export const later = 1;\n');
  const moved = await ask(['verify', 'check', good.packFile, '--tree'], { cwd: good.repo });
  expectAnswer(moved, 1, 'tree_mismatch', 'check --tree after the workspace changed');
  assert.equal(moved.data.tree.matches, false);
  assert.notEqual(moved.data.tree.tree, moved.data.subjects.after);
  assert.equal(moved.message, MESSAGES.tree_mismatch.en({ actual: moved.data.tree.tree, expected: moved.data.subjects.after }));
  fs.rmSync(path.join(good.repo, 'src', 'later.mjs'));
  const plain = folder('plain-tree');
  writeFiles(plain, PROJECT);
  const unlike = await ask(['verify', 'check', good.packFile, '--tree', '--workspace', plain]);
  expectAnswer(unlike, 1, 'tree_mismatch', 'check --tree in a plain folder (another tree algorithm)');
  assert.equal(unlike.data.tree.treeAlgorithm, 'raw-v1');
  // a pack whose criteria are not all evidenced verifies, and says so (exit 1)
  const stale = await makePack('stale', { acceptance: acceptanceOf([['unit', 'node test.mjs']]), before: ['node test.mjs'] });
  expectAnswer(stale.pack, 1, 'pack_unverified', 'a pack whose only receipt ran on the base tree');
  const checkedStale = await ask(['verify', 'check', stale.packFile]);
  expectAnswer(checkedStale, 1, 'pack_not_evidenced', 'check of an intact pack that is not evidenced');
  assert.deepEqual(checkedStale.data.criteria, [{ id: 'unit', status: 'stale' }]);
  assert.equal(checkedStale.message, MESSAGES.pack_not_evidenced.en({ total: 1, notEvidenced: 1 }));
  ok('check --tree: a workspace that moved on and a plain folder are tree_mismatch (exit 1); an intact pack that is not evidenced is pack_not_evidenced (exit 1)');
}
function write1(root, relative, content) { writeFiles(root, { [relative]: content }); }

// ------------------------------------------------------------------------------------------------------------------------- 4. tampering
{
  // every byte of the pack, changed one at a time, in process: each one is refused with an integrity code
  const sweepStart = performance.now();
  const codes = {};
  for (let at = 0; at < goodBytes.length; at += 1) {
    const changed = Buffer.from(goodBytes);
    changed[at] = changed[at] === 0x30 ? 0x31 : 0x30;
    let error = null;
    try { readPackFile(changed); } catch (caught) { error = caught; }
    assert.ok(isIntegrity(error), `byte ${at} (${JSON.stringify(String.fromCharCode(goodBytes[at]))}) changed: ${error?.code ?? 'accepted'} ${error?.message ?? ''}`);
    codes[error.code] = (codes[error.code] ?? 0) + 1;
  }
  assert.ok(readPackFile(goodBytes).statement, 'the untouched pack reads');
  for (const code of ['pack_unreadable', 'pack_invalid', 'pack_digest_mismatch', 'pack_file_mismatch']) assert.ok(codes[code] > 0, `${code} among the answers: ${JSON.stringify(codes)}`);
  ok(`every one of the ${goodBytes.length} bytes of a pack, changed, is refused with exit 3 (${JSON.stringify(codes)}) in ${((performance.now() - sweepStart) / 1000).toFixed(1)} s`);
}
{
  // through the CLI: a byte of the statement, of the digest, of each file, of a key, a non-UTF-8 byte
  const text = goodBytes.toString('utf8');
  const parsed = JSON.parse(text);
  const variant = (label, bytes) => { const file = path.join(folder('tampered'), `${label}.pack.json`); fs.writeFileSync(file, bytes); return file; };
  const swapAt = (index) => { const bytes = Buffer.from(goodBytes); bytes[index] = bytes[index] === 0x41 ? 0x42 : 0x41; return bytes; };
  const cases = [
    ['statement', swapAt(text.indexOf('"agent":{"name":"unknown"') + 18), 'pack_digest_mismatch', null],
    ['digest', swapAt(text.indexOf(parsed.statementDigest) + 5), 'pack_digest_mismatch', null],
    ['patch', swapAt(text.indexOf(parsed.files['change.diff'].base64) + 12), 'pack_file_mismatch', null],
    ['ledger', swapAt(text.indexOf(parsed.files['ledger.jsonl'].base64) + 40), 'pack_file_mismatch', null],
    ['acceptance', swapAt(text.indexOf(parsed.files['acceptance.yml'].base64) + 8), 'pack_file_mismatch', null],
    ['format', Buffer.from(text.replace('chatmcp.proof-pack/1', 'chatmcp.proof-pack/2')), 'pack_invalid', null],
    ['unknown-key', Buffer.from(text.replace('"statementDigest"', '"statementDigesT"')), 'pack_invalid', null],
    ['key-order', Buffer.from(text.replace('"files"', '"tiles"')), 'pack_unreadable', 'not_canonical'],
    ['not-utf8', Buffer.concat([goodBytes.subarray(0, 30), Buffer.from([0xff]), goodBytes.subarray(31)]), 'pack_unreadable', 'not_utf8'],
    ['pretty', Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`), 'pack_unreadable', 'not_canonical'],
    ['statement-only', Buffer.from(`${canonicalJson(parsed.statement)}\n`), 'pack_unreadable', 'statement_only'],
    ['not-json', Buffer.from('{"format":'), 'pack_unreadable', 'not_json'],
  ];
  for (const [label, bytes, code, why] of cases) {
    const answer = await ask(['verify', 'check', variant(label, bytes)]);
    expectAnswer(answer, 3, code, `check of a pack with a changed ${label}`);
    assert.equal(answer.data, null);
    if (why) assert.equal(answer.detail.why, why, `${label}: why`);
  }
  // a Windows checkout may end the line with CRLF, or the line end may be gone: the pack still verifies
  for (const [label, bytes] of [['crlf', Buffer.from(`${text.trimEnd()}\r\n`)], ['no-line-end', Buffer.from(text.trimEnd())]]) {
    expectAnswer(await ask(['verify', 'check', variant(label, bytes)]), 0, 'pack_verified', `a pack ending with ${label}`);
  }
  ok(`${cases.length} changed packs through the CLI are exit 3 with their codes; a statement alone, a pretty-printed pack and non-UTF-8 bytes are named; a CRLF ending verifies`);
}
{
  // a pack rewritten with its digest recomputed: the ledger still catches a changed receipt, the statement still names its files
  const parsed = JSON.parse(goodBytes.toString('utf8'));
  const remade = (edit) => {
    const copy = structuredClone(parsed);
    edit(copy);
    copy.statementDigest = statementDigest(copy.statement);
    return Buffer.from(`${canonicalJson(copy)}\n`);
  };
  const refusal = (bytes) => { try { readPackFile(bytes); } catch (error) { return error; } return null; };
  const forged = [
    ['a receipt\'s duration', (copy) => { copy.statement.predicate.receipts[0].durationMs += 1; }, 'pack_ledger_broken', 'receipt'],
    ['a receipt\'s hash', (copy) => { copy.statement.predicate.receipts[1].hash = 'f'.repeat(64); }, 'pack_ledger_broken', 'receipt'],
    ['the ledger summary', (copy) => { copy.statement.predicate.ledger.lastHash = 'a'.repeat(64); }, 'pack_ledger_broken', 'summary'],
    ['the patch subject', (copy) => { copy.statement.subject[2].digest.sha256 = sha256('another patch'); }, 'pack_file_mismatch', 'subject'],
    ['the acceptance file', (copy) => { delete copy.files['acceptance.yml']; }, 'pack_file_mismatch', 'presence'],
    ['the acceptance hash', (copy) => { copy.statement.predicate.acceptance.baselineSha256 = sha256('x'); }, 'pack_file_mismatch', 'statement'],
    ['a receipt the statement contradicts', (copy) => { copy.statement.predicate.criteria[1].checks[0].result = 'failed'; }, 'pack_invalid', null],
  ];
  for (const [label, edit, code, why] of forged) {
    const error = refusal(remade(edit));
    assert.equal(error?.code, code, `${label}: ${error?.code} ${JSON.stringify(error?.detail)}`);
    if (why) assert.equal(error.detail.why, why, `${label}: why`);
  }
  const consistent = remade((copy) => { copy.statement.predicate.agent.name = 'someone else'; });
  assert.equal(readPackFile(consistent).statement.predicate.agent.name, 'someone else', 'a pack re-made consistently verifies: a pack is not signed');
  // encodePackFile refuses a pack over its limit
  assert.throws(() => encodePackFile({ statement: parsed.statement, diff: Buffer.alloc(64), ledger: Buffer.alloc(64), acceptance: null, maxBytes: 1000 }), (error) => error.code === 'pack_too_large');
  ok(`${forged.length} packs re-made with their digest recomputed are refused by the ledger, the files or the spec's rules; a consistent one verifies (unsigned, as documented)`);
}

// ------------------------------------------------------------------------------------------------------------------------- 5. trust --pack
{
  const { packFile } = good;
  const preview = await ask(['verify', 'trust', '--pack', packFile], { env: third });
  expectAnswer(preview, 1, 'not_trusted', 'trust --pack preview by a third party');
  assert.equal(preview.data.pack, packFile);
  assert.equal(preview.data.sha256, sha256(GOOD_ACCEPTANCE));
  assert.deepEqual(preview.data.setup, ['node setup.mjs'], 'the preview lists the setup commands');
  assert.deepEqual(preview.data.checks, [{ criterion: 'unit', run: 'node test.mjs', cwd: '.' }, { criterion: 'known-bug', run: 'node fails.mjs', cwd: '.' }]);
  assert.equal(preview.data.trustCommand, `chatmcp verify trust --sha256 ${sha256(GOOD_ACCEPTANCE)} --pack ${JSON.stringify(packFile)}`);
  const humanPreview = await cli(['verify', 'trust', '--pack', packFile], { env: third });
  assert.equal(humanPreview.status, 1);
  assert.match(humanPreview.stdout, /setup: node setup\.mjs/, 'the human preview lists the setup');
  expectAnswer(await ask(['verify', 'trust', '--pack', packFile, '--sha256', sha256('other bytes')], { env: third }), 3, 'sha256_mismatch', 'trust --pack with the digest of other bytes');
  const tampered = path.join(folder('trust-tampered'), 'p.pack.json');
  fs.writeFileSync(tampered, Buffer.from(goodBytes.toString('utf8').replace('"unknown"', '"unknowN"')));
  expectAnswer(await ask(['verify', 'trust', '--pack', tampered], { env: third }), 3, 'pack_digest_mismatch', 'trust --pack of a tampered pack');
  assert.equal(fs.existsSync(path.join(THIRD, 'proof', 'trusted-acceptance.json')), false, 'nothing was trusted yet');
  ok('trust --pack: the preview lists the setup and the checks of the pack\'s acceptance file and the command that trusts it; a wrong digest and a tampered pack trust nothing');
}

// ------------------------------------------------------------------------------------------------------------------------- 6. reproduce
{
  const { packFile, base, repo } = good;
  clearRan();
  const refused = await ask(['verify', 'reproduce', packFile, '--base', base], { env: third });
  expectAnswer(refused, 1, 'not_trusted', 'reproduce by a third party who has not trusted the acceptance file');
  assert.equal(refused.detail.trustCommand, `chatmcp verify trust --sha256 ${sha256(GOOD_ACCEPTANCE)} --pack ${JSON.stringify(packFile)}`);
  assert.deepEqual(refused.detail.setup, ['node setup.mjs']);
  assert.deepEqual(refused.detail.checks.map((check) => check.run), ['node test.mjs', 'node fails.mjs'], 'the commands it would run are listed');
  assert.deepEqual(ran(), [], 'nothing ran');
  assert.deepEqual(leftovers(), [], 'no temporary worktree was made');
  const humanRefused = await cli(['verify', 'reproduce', packFile, '--base', base], { env: third });
  assert.equal(humanRefused.status, 1);
  assert.ok(humanRefused.stdout.includes('node fails.mjs') && humanRefused.stdout.includes('--pack'), `the human answer lists the commands and the trust command: ${humanRefused.stdout}`);
  expectAnswer(await ask(['verify', 'trust', '--pack', packFile, '--sha256', sha256(GOOD_ACCEPTANCE)], { env: third }), 0, 'trusted', 'the third party trusts the reviewed bytes');

  // from a folder
  const baseBefore = fingerprint(base);
  const repoBefore = fingerprint(repo);
  const fromFolder = await ask(['verify', 'reproduce', packFile, '--base', base], { env: third });
  expectAnswer(fromFolder, 0, 'reproduced', 'reproduce from a base folder');
  const data = fromFolder.data;
  assert.deepEqual([data.compared, data.reproduced, data.divergent, data.share], [2, 2, 0, 1]);
  assert.deepEqual(data.receipts.map((receipt) => [receipt.criterion, receipt.command, receipt.status, receipt.reason, receipt.pack]),
    [['unit', 'node test.mjs', 'reproduced', null, 'exit 0'], ['known-bug', 'node fails.mjs', 'reproduced', null, 'exit 1']], 'a pass and a failure, both reproduced');
  assert.deepEqual(data.receipts.map((receipt) => receipt.here), [['exit 0'], ['exit 1']]);
  assert.deepEqual(data.notCompared.map((row) => row.why).sort(), ['not_a_check', 'other_tree'], 'the base tree run and a command of no check are not compared');
  assert.deepEqual(data.setup.map((row) => [row.command, row.outcome, row.passed]), [['node setup.mjs', 'exit 0', true]]);
  assert.equal(data.passes, 1, 'everything reproduced: one pass');
  assert.deepEqual(data.base, { kind: 'folder', value: base, folder: base, commit: null });
  assert.deepEqual([data.trees.before, data.trees.after], [good.statement.subject[0].digest.gitTree, good.statement.subject[1].digest.gitTree]);
  assert.equal(data.trees.checksOnPackTree, true, 'the setup left the tree as the pack names it (build/ is ignored)');
  assert.equal(data.leftover, null);
  assert.deepEqual(ran(), ['setup', 'test', 'fails'], 'the setup, then the checks');
  assert.deepEqual(leftovers(), [], 'the temporary worktree is removed');
  assert.deepEqual(fingerprint(base), baseBefore, 'the base folder is not written');
  assert.deepEqual(fingerprint(repo), repoBefore, 'nor the workspace');
  assert.equal(fromFolder.message, MESSAGES.reproduced.en({ reproduced: 2, compared: 2, percent: '100%' }));

  // from a commit of the workspace's repository (the commit the session started from)
  clearRan();
  const fromCommit = await ask(['verify', 'reproduce', packFile, '--base', 'HEAD'], { cwd: repo, env: third });
  expectAnswer(fromCommit, 0, 'reproduced', 'reproduce from a base commit');
  assert.deepEqual(fromCommit.data.base, { kind: 'commit', value: 'HEAD', folder: null, commit: good.statement.predicate.baseCommit });
  assert.deepEqual([fromCommit.data.compared, fromCommit.data.reproduced], [2, 2]);
  assert.deepEqual(fingerprint(repo), repoBefore, 'the repository, its .git included, is not written');
  assert.deepEqual(leftovers(), [], 'the temporary clone is removed');
  const human = await cli(['verify', 'reproduce', packFile, '--base', base, '--lang', 'vi'], { env: third });
  assert.equal(human.status, 0);
  assert.ok(human.stdout.includes(MESSAGES.reproduced.vi({ reproduced: 2, compared: 2, percent: '100%' })) && /#\d+ .*node fails\.mjs/.test(human.stdout), human.stdout);
  ok('reproduce: nothing runs without trust; from a folder and from a commit every receipt of the final tree reproduces (a pass and a failure, 100%); nothing of the person is written; the temporary worktree is removed');
}
{
  // refusals before anything runs: a base that is not the pack's before tree, a base that is neither a folder nor a commit
  const { packFile, base, repo } = good;
  clearRan();
  const other = folder('other-base');
  fs.cpSync(base, other, { recursive: true });
  write1(other, 'src/add.mjs', 'export const add = (a, b) => b + a;\n');
  const mismatch = await ask(['verify', 'reproduce', packFile, '--base', other], { env: third });
  expectAnswer(mismatch, 1, 'base_mismatch', 'a base folder that is not the before tree');
  assert.equal(mismatch.detail.expected, good.statement.subject[0].digest.gitTree);
  assert.notEqual(mismatch.detail.actual, mismatch.detail.expected);
  expectAnswer(await ask(['verify', 'reproduce', packFile, '--base', 'no-such-ref'], { cwd: repo, env: third }), 2, 'bad_base', 'an unknown commit');
  const plain = folder('plain-workspace');
  const notRepo = await ask(['verify', 'reproduce', packFile, '--base', 'HEAD'], { cwd: plain, env: third });
  expectAnswer(notRepo, 2, 'bad_base', 'a commit outside a repository');
  assert.equal(notRepo.detail.why, 'no_repository');
  const dashed = await ask(['verify', 'reproduce', packFile, '--base=--upload-pack=x'], { cwd: repo, env: third });
  expectAnswer(dashed, 2, 'bad_value', 'a base that reads as an option');
  assert.equal(dashed.detail.option, '--base');
  assert.deepEqual(ran(), [], 'nothing ran');
  assert.deepEqual(leftovers(), [], 'no temporary worktree is left');
  ok('reproduce refuses a base that is not the pack\'s before tree (exit 1) and a base that is neither a folder nor a commit (exit 2); nothing runs, nothing is left');
}
{
  // a pack re-made around another patch (it verifies: packs are not signed) does not reproduce: the patch does not apply, or gives another tree
  const parsed = JSON.parse(goodBytes.toString('utf8'));
  const remade = (patch) => {
    const copy = structuredClone(parsed);
    copy.files['change.diff'] = { sha256: sha256(patch), bytes: patch.length, base64: patch.toString('base64') };
    copy.statement.subject[2].digest.sha256 = sha256(patch);
    copy.statementDigest = statementDigest(copy.statement);
    const file = path.join(folder('remade'), 'p.pack.json');
    fs.writeFileSync(file, `${canonicalJson(copy)}\n`);
    return file;
  };
  const patchText = Buffer.from(parsed.files['change.diff'].base64, 'base64').toString('utf8');
  assert.ok(patchText.includes('-export const add = (a, b) => a - b;'), 'the patch removes the wrong line');
  const broken = remade(Buffer.from(patchText.replace('-export const add = (a, b) => a - b;', '-export const add = (a, b) => a * b;')));
  const notApplied = await ask(['verify', 'reproduce', broken, '--base', good.base], { env: third });
  expectAnswer(notApplied, 3, 'patch_does_not_reproduce', 'a patch that does not apply to the base');
  assert.equal(notApplied.detail.why, 'apply_failed');
  const extra = Buffer.from(`${patchText}diff --git a/added.txt b/added.txt\nnew file mode 100644\nindex 0000000..e69de29\n`);
  const otherTree = await ask(['verify', 'reproduce', remade(extra), '--base', good.base], { env: third });
  expectAnswer(otherTree, 3, 'patch_does_not_reproduce', 'a patch that gives another tree');
  assert.equal(otherTree.detail.why, 'tree_differs');
  assert.deepEqual(leftovers(), [], 'no temporary worktree is left after a failure');
  ok('a pack re-made around another patch verifies (unsigned) but does not reproduce: patch_does_not_reproduce (exit 3), apply_failed and tree_differs; nothing is left');
}
{
  // divergence: a variable missing here, a flaky check (the second pass sees it), a failure reproduced; the share
  const flakyFile = path.join(SCRATCH, 'flaky-count');
  const acceptance = acceptanceOf([['unit', 'node test.mjs'], ['flag', 'node env-check.mjs "$PROOF_FLAG"'], ['flaky', 'node flaky.mjs'], ['known-bug', 'node fails.mjs', 1]]);
  const env = { PROOF_FLAG: 'on', PROOF_FLAKY_FILE: flakyFile };
  const made = await makePack('divergent', { acceptance, after: ['node test.mjs', 'node env-check.mjs "$PROOF_FLAG"', 'node flaky.mjs', 'node fails.mjs'], env });
  expectAnswer(made.pack, 0, 'pack_evidenced', 'the maker\'s pack');
  expectAnswer(await ask(['verify', 'trust', '--pack', made.packFile, '--sha256', sha256(acceptance)], { env: third }), 0, 'trusted', 'trust');
  clearRan();
  // here PROOF_FLAG is not set, and the flaky check's counter is at 1 (it failed once since): exit 1 then exit 0
  const answer = await ask(['verify', 'reproduce', made.packFile, '--base', made.base], { env: { ...third, PROOF_FLAKY_FILE: flakyFile } });
  expectAnswer(answer, 1, 'reproduce_divergent', 'a reproduction with divergent receipts');
  const byCriterion = Object.fromEntries(answer.data.receipts.map((receipt) => [receipt.criterion, receipt]));
  assert.deepEqual([byCriterion.unit.status, byCriterion['known-bug'].status], ['reproduced', 'reproduced']);
  assert.deepEqual([byCriterion.flag.status, byCriterion.flag.reason], ['divergent', 'missing_environment']);
  assert.match(byCriterion.flag.detail, /PROOF_FLAG/);
  assert.deepEqual([byCriterion.flaky.status, byCriterion.flaky.reason], ['divergent', 'flaky']);
  assert.deepEqual(byCriterion.flaky.here, ['exit 1', 'exit 0'], 'the second pass saw the other outcome');
  assert.equal(answer.data.passes, 2, 'a divergence starts the second pass');
  assert.deepEqual([answer.data.compared, answer.data.reproduced, answer.data.divergent, answer.data.share], [4, 2, 2, 0.5]);
  assert.equal(answer.message, MESSAGES.reproduce_divergent.en({ reproduced: 2, compared: 4, divergent: 2, percent: '50%' }));
  assert.equal(ran().filter((name) => name === 'setup').length, 1, 'the setup runs once');
  assert.deepEqual(leftovers(), []);
  ok('reproduce labels each receipt: reproduced, missing_environment (a variable the command names is not set here), flaky (the second pass saw another outcome); the share is 50% (exit 1)');
}
{
  // a setup that fails: no check runs, every receipt is divergent with the reason
  const acceptance = acceptanceOf([['unit', 'node test.mjs']], ['node -e "process.exit(4)"']);
  const made = await makePack('setup-fails', { acceptance, after: ['node test.mjs'] });
  expectAnswer(await ask(['verify', 'trust', '--pack', made.packFile, '--sha256', sha256(acceptance)], { env: third }), 0, 'trusted', 'trust');
  clearRan();
  const answer = await ask(['verify', 'reproduce', made.packFile, '--base', made.base], { env: third });
  expectAnswer(answer, 1, 'reproduce_divergent', 'a setup that fails');
  assert.deepEqual(answer.data.setup.map((row) => [row.outcome, row.passed]), [['exit 4', false]]);
  assert.deepEqual(answer.data.receipts.map((receipt) => [receipt.status, receipt.reason]), [['divergent', 'setup_failed']]);
  assert.deepEqual([answer.data.share, answer.data.passes], [0, 0], 'no check ran');
  assert.deepEqual(ran(), [], 'no check ran');
  // nothing to reproduce: no acceptance file in the pack, or no receipt on the final tree
  const none = await makePack('no-acceptance', { acceptance: null, setup: false });
  const empty = await ask(['verify', 'reproduce', none.packFile, '--base', none.base], { env: third });
  expectAnswer(empty, 1, 'nothing_to_reproduce', 'a pack without an acceptance file');
  const staleOnly = await makePack('stale-only', { acceptance: acceptanceOf([['unit', 'node test.mjs']]), before: ['node test.mjs'] });
  const nothing = await ask(['verify', 'reproduce', staleOnly.packFile, '--base', staleOnly.base], { env: third });
  expectAnswer(nothing, 1, 'nothing_to_reproduce', 'a pack whose receipts all ran on another tree');
  assert.deepEqual(nothing.detail.otherTree, 1);
  assert.deepEqual(leftovers(), []);
  ok('a failing setup makes every receipt divergent (setup_failed) and runs no check; a pack with nothing on its final tree has nothing to reproduce (exit 1)');
}
{
  // the reasons, one by one, in process
  const receipt = (over = {}) => ({ exit: 0, signal: null, timedOut: false, cancelled: false, shell: 'bash', toolchain: { node: '24.1.0', python: null, dotnet: null, git: '2.50.0' }, ...over });
  const attempt = (over = {}) => ({ exit: 0, signal: null, timedOut: false, toolchain: { node: '24.1.0', python: null, dotnet: null, git: '2.50.0' }, ...over });
  const base = { receipt: receipt(), attempts: [attempt()], packOutcomes: ['exit 0'], missing: [], shell: 'bash', setupFailed: null, error: null };
  const verdict = (over) => { const result = verdictOf({ ...base, ...over }); return [result.status, result.reason]; };
  assert.deepEqual(verdict({}), ['reproduced', null]);
  assert.deepEqual(verdict({ setupFailed: { command: 'npm ci', outcome: 'exit 1' } }), ['divergent', 'setup_failed']);
  assert.deepEqual(verdict({ attempts: [], error: 'bad_cwd' }), ['divergent', 'not_run']);
  assert.deepEqual(verdict({ attempts: [attempt(), attempt({ exit: 1 })] }), ['divergent', 'flaky']);
  assert.deepEqual(verdict({ attempts: [attempt({ exit: 1 })], packOutcomes: ['exit 0', 'exit 1'] }), ['divergent', 'flaky']);
  assert.deepEqual(verdict({ attempts: [attempt({ exit: null, timedOut: true })] }), ['divergent', 'timed_out']);
  assert.deepEqual(verdict({ receipt: receipt({ exit: null, timedOut: true }), packOutcomes: ['timed out'] }), ['divergent', 'timed_out']);
  assert.deepEqual(verdict({ attempts: [attempt({ exit: 1 })], missing: ['TOKEN_URL'] }), ['divergent', 'missing_environment']);
  assert.deepEqual(verdict({ attempts: [attempt({ exit: 1 })], shell: 'powershell' }), ['divergent', 'shell_differs']);
  assert.deepEqual(verdict({ attempts: [attempt({ exit: 1, toolchain: { node: '22.12.0', python: null, dotnet: null, git: '2.50.0' } })] }), ['divergent', 'toolchain_mismatch']);
  assert.match(verdictOf({ ...base, attempts: [attempt({ exit: 1, toolchain: { node: '22.12.0', python: null, dotnet: null, git: '2.50.0' } })] }).detail, /node 24\.1\.0 in the pack, 22\.12\.0 here/);
  assert.deepEqual(verdict({ attempts: [attempt({ exit: 2, toolchain: { node: '24.1.0', python: '3.12.0', dotnet: null, git: '2.50.0' } })] }), ['divergent', 'exit_differs'], 'a tool the pack did not see is no mismatch');
  assert.deepEqual(verdict({ attempts: [attempt({ exit: null, signal: 'SIGKILL' })] }), ['divergent', 'exit_differs']);
  assert.equal(verdictOf({ ...base, attempts: [attempt({ exit: 7 })] }).detail, 'exit 0 in the pack, exit 7 here');
  assert.deepEqual(variablesNamed('node a.mjs "$HOME_URL" ${API_BASE} $env:DB_NAME $1 $? "$@" \\$NOT_THIS'), ['HOME_URL', 'API_BASE', 'DB_NAME']);
  assert.deepEqual(variablesNamed('npm test'), []);
  ok(`the divergence reasons one by one: ${REPRODUCE_REASONS.join(', ')}; the variables a command names`);
}

// ------------------------------------------------------------------------------------------------------------------------- 7. Ctrl-C
{
  // the maker ran the slow check once with a short time limit: the pack has one receipt of it on its final tree
  const mark = path.join(SCRATCH, 'slow-started');
  const acceptance = acceptanceOf([['slow', 'node slow.mjs']], []);
  const timed = await makePack('slow', { acceptance, setup: false });
  const runSlow = await ask(['verify', 'run', '--timeout', '2', '--', 'node slow.mjs'], { cwd: timed.repo, env: { PROOF_SLOW_MARK: mark } });
  expectAnswer(runSlow, 1, 'check_failed', 'the slow check, cut by its time limit');
  const packFile = (await ask(['verify', 'pack'], { cwd: timed.repo })).data.packFile;
  expectAnswer(await ask(['verify', 'trust', '--pack', packFile, '--sha256', sha256(acceptance)], { env: third }), 0, 'trusted', 'trust');
  // injected: main() with an emitter as its signals, the interrupt fired once the check has started
  fs.rmSync(mark, { force: true });
  const signals = new EventEmitter();
  const out = [];
  const stream = { write: (text, done) => { out.push(String(text)); done?.(); return true; } };
  const watcher = setInterval(() => { if (fs.existsSync(mark)) { clearInterval(watcher); signals.emit('SIGINT'); } }, 50);
  const started = performance.now();
  const exitCode = await main(['verify', 'reproduce', packFile, '--base', timed.base, '--json'], {
    stdout: stream, stderr: stream, env: { ...BASE_ENV, ...third, PROOF_SLOW_MARK: mark }, cwd: SCRATCH, signals,
  });
  clearInterval(watcher);
  const answer = JSON.parse(out.join(''));
  assert.equal(exitCode, 1, JSON.stringify(answer));
  assert.equal(answer.code, 'reproduce_interrupted');
  assert.ok(performance.now() - started < 60_000, 'the slow check was stopped, not waited for');
  assert.deepEqual(leftovers(), [], 'the temporary worktree is removed after Ctrl-C');
  assert.equal(signals.listenerCount('SIGINT'), 0, 'the listeners are gone');
  if (process.platform !== 'win32') {
    fs.rmSync(mark, { force: true });
    const result = await cli(['verify', 'reproduce', packFile, '--base', timed.base, '--json'], {
      env: { ...third, PROOF_SLOW_MARK: mark },
      onSpawn: (child) => { const poll = setInterval(() => { if (fs.existsSync(mark)) { clearInterval(poll); child.kill('SIGINT'); } }, 50); child.once('close', () => clearInterval(poll)); },
    });
    const real = answerOf(result, 'reproduce with a real SIGINT');
    expectAnswer(real, 1, 'reproduce_interrupted', 'a real SIGINT');
    assert.deepEqual(leftovers(), [], 'the temporary worktree is removed after a real SIGINT');
  }
  ok(`Ctrl-C while a check runs: the check is stopped, the temporary worktree removed, reproduce_interrupted (exit 1)${process.platform === 'win32' ? ' (injected; Windows cannot send one process a Ctrl-C)' : ', injected and a real SIGINT'}`);
}

// ------------------------------------------------------------------------------------------------------------------------- 8. the cross-system fixture
{
  const packs = committedPacks();
  assert.ok(packs.length >= 1, 'at least one committed pack');
  const results = [];
  for (const { platform, file } of packs) {
    const state = folder(`fixture-state-${platform}`);
    const env = { CHATMCP_STATE_DIR: state };
    const checked = await ask(['verify', 'check', file], { env });
    expectAnswer(checked, 0, 'pack_verified', `the ${platform} pack checks here`);
    assert.equal(checked.data.acceptance.sha256, sha256(FIXTURE_ACCEPTANCE), 'the fixture\'s acceptance file');
    expectAnswer(await ask(['verify', 'trust', '--pack', file, '--sha256', sha256(FIXTURE_ACCEPTANCE)], { env }), 0, 'trusted', 'trust');
    const base = folder(`fixture-base-${platform}`);
    writeFiles(base, FIXTURE_BASE);
    const fromFolder = await ask(['verify', 'reproduce', file, '--base', base], { env });
    expectAnswer(fromFolder, 0, 'reproduced', `the ${platform} pack reproduces here from a folder`);
    assert.deepEqual([fromFolder.data.compared, fromFolder.data.reproduced, fromFolder.data.notCompared.map((row) => row.why)], [2, 2, ['other_tree']]);
    const repo = real(newRepo(`fixture-repo-${platform}`));
    writeFiles(repo, FIXTURE_BASE);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const fromCommit = await ask(['verify', 'reproduce', file, '--base', 'HEAD'], { cwd: repo, env });
    expectAnswer(fromCommit, 0, 'reproduced', `the ${platform} pack reproduces here from a commit`);
    // and the change of the fixture gives the pack's after tree here too
    const changed = folder(`fixture-after-${platform}`);
    writeFiles(changed, FIXTURE_BASE);
    fixtureChange(changed);
    git(changed, ['init', '-q']);
    const tree = await ask(['verify', 'check', file, '--tree', '--workspace', changed], { env });
    expectAnswer(tree, 0, 'pack_verified', `the ${platform} pack's after tree is the fixture's change here`);
    results.push(`${platform} -> ${process.platform}`);
  }
  assert.deepEqual(leftovers(), []);
  ok(`the committed packs check and reproduce on this system (${results.join(', ')}), from a folder and from a commit`);
}

// ------------------------------------------------------------------------------------------------------------------------- 9. no network
{
  assert.equal(fs.existsSync(NETLOG), false, `no CLI process used the network: ${fs.existsSync(NETLOG) ? fs.readFileSync(NETLOG, 'utf8') : ''}`);
  const statement = good.statement;
  assert.deepEqual(validateStatement(statement), { valid: true, errors: [] });
  assert.ok(publishedSchema.validate(statement).valid);
  ok('no CLI process of this suite used the network');
}

console.log(`verify-proof-reproduce: ${checks} checks passed in ${elapsed()}`);
