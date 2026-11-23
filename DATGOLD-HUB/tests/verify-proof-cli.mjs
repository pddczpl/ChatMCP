// bin/chatmcp.mjs and lib/proof/cli/: the `chatmcp verify` command line of Proof-of-Done (P4 pod-24, docs/PROOF-CLI.md).
//
// The real CLI is spawned as a subprocess, in temporary Git repositories and plain folders, with its state folder in a temporary folder.
// What it proves:
//   1. the package: `bin` and `files` in package.json, the shebang, every module the CLI loads inside `files`; the doc names every
//      command, every exit code and every answer code with its exit code, and docs/INDEX.md links it; every answer code has a message in
//      English and in Vietnamese;
//   2. usage: every mistake on the command line exits 2 with its own code, help and --version exit 0, and every --json output is exactly
//      one JSON object that validates against the CLI's output schema; English and Vietnamese give the same JSON but for the message;
//   3. every command is built: check and reproduce (pod-32, tests/verify-proof-reproduce.mjs is their suite) refuse a command line without
//      a pack (exit 2) in both languages and write nothing anywhere; exec (pod-26) refuses a folder without an acceptance file
//      (tests/verify-proof-cli-exec.mjs is its suite);
//   4. a plain folder: init --print writes nothing, init writes .chatmcp/acceptance.yml and never overwrites it, trust previews (exit 1),
//      refuses a sha256 that is not the file's (exit 3), trusts the right one and revokes; snapshot, run, show work; pack is refused with
//      exit 4 (no Git repository); nothing but .chatmcp/acceptance.yml is ever written into the folder;
//   5. a Git repository: snapshot, an edit, run of the criterion's check, pack exit 0 with an evidenced criterion and a statement that
//      validates against the published schema and validateStatement, written canonically to the state folder; a later edit makes the
//      evidence stale (exit 1), a revoked trust makes the criterion unverified (exit 1), an edited check file makes it checks_modified
//      (exit 1); the repository's files and its .git are never written by the CLI;
//   6. integrity: an edited ledger, a deleted ledger, an edited baseline record and an edited session copy of the acceptance file are
//      exit 3, and run does not run the command on a broken ledger;
//   7. environment: a state folder inside the workspace is refused (exit 4) before anything is written;
//   8. the words after `--`: one word is the command text unchanged, several are joined with the shell's own quoting (bash and sh:
//      single quotes; PowerShell: single quotes, and a word Windows PowerShell 5.1 would change on its way to a program is refused), and
//      typed command lines (cmd.exe and powershell.exe on Windows, sh elsewhere) reach the check unchanged;
//   9. no network: every CLI process of this suite runs under a guard that refuses and records any socket, DNS, HTTP or fetch use, the
//      guard is shown to work, and the CLI's own files import no network module.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSchema } from '../lib/proof/schema-validate.mjs';
import { AGENT_CHANGE_SCHEMA, canonicalJson, statementDigest, validateStatement } from '../lib/proof/pack.mjs';
import { workspaceKey } from '../lib/proof/baseline.mjs';
import { VERSION } from '../lib/manager.mjs';
import { CLI_DATA_SCHEMAS, CLI_FORMAT, CLI_OUTPUT_SCHEMA, CODES, COMMANDS, EXIT, MESSAGES, joinCommand } from '../lib/proof/cli/index.mjs';
import zlib from 'node:zlib';
import { blobId, findGit } from '../lib/proof/git-plumbing.mjs';
import { storeSide } from '../lib/proof/cli/store-side.mjs';
import { commitAll, git, newRepo, write } from './support/proof-tree-fixtures.mjs';
import { powerShellChildEnvironment, windowsPowerShellPath } from './support/powershell-environment.mjs';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Under the mutation runner the Hub is a copy without the repository around it; the runner says where it came from.
const REPO = path.resolve(process.env.CHATMCP_MUTATION_SOURCE ? path.resolve(process.env.CHATMCP_MUTATION_SOURCE) : HUB, '..');
const BIN = path.join(HUB, 'bin', 'chatmcp.mjs');

let checks = 0;
const suiteStart = performance.now();
const elapsed = () => `${((performance.now() - suiteStart) / 1000).toFixed(1)} s`;
const ok = (label) => { checks += 1; console.log(`  ok - ${label} [${elapsed()}]`); };
setTimeout(() => { console.error('FAIL: the proof CLI suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

const sha256 = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
const SCRATCH = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-cli-')));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });
const STATE = path.join(SCRATCH, 'state');
const NETLOG = path.join(SCRATCH, 'network.log');
const GUARD = path.join(SCRATCH, 'deny-network.mjs');
let folders = 0;
const folder = (label) => { const dir = path.join(SCRATCH, `${label}-${(folders += 1)}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
const real = (dir) => fs.realpathSync.native(dir);

// The guard: loaded with --import into every CLI process of this suite (never into the commands the CLI runs). Any use of a socket,
// DNS, HTTP(S), HTTP/2, TLS, UDP, fetch or WebSocket is written to NETLOG and throws.
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

// The environment of the CLI: nothing of this process's Git or Hub variables, the state folder in the scratch folder.
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|CHATMCP_)/i.test(key)));
Object.assign(BASE_ENV, { CHATMCP_STATE_DIR: STATE, PROOF_CLI_NETLOG: NETLOG });

function spawnCollect(file, args, { cwd, env, verbatim = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: verbatim });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}
const GUARD_ARGS = ['--import', pathToFileURL(GUARD).href];
/** The CLI as a person runs it: `node bin/chatmcp.mjs <args>` in `cwd`. */
const cli = (args, { cwd = SCRATCH, env = {} } = {}) => spawnCollect(process.execPath, [...GUARD_ARGS, BIN, ...args], { cwd, env: { ...BASE_ENV, ...env } });

const outputSchema = compileSchema(CLI_OUTPUT_SCHEMA);
const dataSchemas = Object.fromEntries(Object.entries(CLI_DATA_SCHEMAS).map(([name, schema]) => [name, compileSchema(schema)]));
const publishedSchema = compileSchema(JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'spec', 'agent-change-v0.1.schema.json'), 'utf8')));

/** The JSON answer of a run: exactly one JSON object on one line, nothing on stderr, valid against the schema, its exit code its code's. */
function answerOf(result, label) {
  const where = `${label}: exit ${result.status}\nstdout: ${result.stdout.slice(0, 2000)}\nstderr: ${result.stderr.slice(0, 2000)}`;
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
  if (answer.command === 'pack' && answer.data) {
    assert.deepEqual(validateStatement(answer.data.statement), { valid: true, errors: [] }, `${where}\nthe statement passes validateStatement`);
    const published = publishedSchema.validate(answer.data.statement);
    assert.ok(published.valid, `${where}\nthe statement validates against docs/spec/agent-change-v0.1.schema.json: ${JSON.stringify(published.errors.slice(0, 5))}`);
  }
  return answer;
}
const withJson = (args) => { const at = args.indexOf('--'); return at < 0 ? [...args, '--json'] : [...args.slice(0, at), '--json', ...args.slice(at)]; };
const ask = async (args, options = {}) => answerOf(await cli(withJson(args), options), `chatmcp ${args.join(' ')}`);
const expectAnswer = (answer, exitCode, code, label) => {
  assert.equal(answer.code, code, `${label}: code ${answer.code} (${answer.message}), expected ${code}`);
  assert.equal(answer.exitCode, exitCode, `${label}: exit ${answer.exitCode}, expected ${exitCode}`);
};

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
const listing = (dir) => (fs.existsSync(dir) ? Object.keys(fingerprint(dir)).sort() : null);

// ------------------------------------------------------------------------------------------------------------------------- 1. package, doc, tables
{
  const pkg = JSON.parse(fs.readFileSync(path.join(HUB, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.bin, { chatmcp: 'bin/chatmcp.mjs' }, 'package.json names the CLI in bin');
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('bin/') && pkg.files.includes('lib/'), `package.json files holds bin/ and lib/: ${JSON.stringify(pkg.files)}`);
  const bin = fs.readFileSync(BIN, 'utf8');
  assert.ok(bin.startsWith('#!/usr/bin/env node\n'), 'the CLI starts with the node shebang (LF)');
  // every module the CLI loads, followed from bin/chatmcp.mjs through relative imports, lies inside an entry of `files`
  const seen = new Set();
  const network = new Map();
  const IMPORT = /(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  const NETWORK_MODULES = /^(?:node:)?(?:net|tls|dgram|dns|dns\/promises|http|https|http2|undici)$/;
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
      else if (NETWORK_MODULES.test(spec)) network.set(path.relative(HUB, file).replaceAll('\\', '/'), spec);
    }
  };
  walk(BIN);
  const modules = [...seen].map((file) => path.relative(HUB, file).replaceAll('\\', '/'));
  const outside = modules.filter((file) => !pkg.files.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry)));
  assert.deepEqual(outside, [], 'every module the CLI loads is inside package.json files');
  assert.ok(modules.includes('lib/proof/cli/index.mjs') && modules.length > 20, `(premise) the import graph was followed: ${modules.length} modules`);
  // the CLI's own files import no network module and call no fetch; the only network module in the whole graph is the port probe of
  // lib/runtime.mjs, which the CLI never calls (section 9 proves it at run time)
  const own = modules.filter((file) => file === 'bin/chatmcp.mjs' || file.startsWith('lib/proof/cli/'));
  assert.ok(own.length >= 3, `(premise) the CLI's own files: ${own.join(', ')}`);
  for (const file of own) {
    const text = fs.readFileSync(path.join(HUB, file), 'utf8');
    assert.ok(!network.has(file), `${file} imports no network module`);
    assert.doesNotMatch(text, /\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b/, `${file} uses no fetch or WebSocket`);
  }
  assert.deepEqual(Object.fromEntries(network), { 'lib/runtime.mjs': 'node:net' }, 'the network modules in the CLI\'s import graph');

  // the tables: commands, exit codes, codes, messages
  assert.deepEqual(COMMANDS, ['init', 'trust', 'snapshot', 'run', 'exec', 'check', 'reproduce', 'show', 'pack'], 'the commands of the plan');
  assert.deepEqual(EXIT, { pass: 0, unverified: 1, usage: 2, integrity: 3, environment: 4 }, 'the exit codes of the plan');
  for (const [code, outcome] of Object.entries(CODES)) {
    assert.match(code, /^[a-z][a-z0-9_]*$/, `code ${code} is snake_case`);
    assert.ok(Object.hasOwn(EXIT, outcome), `code ${code} has a known outcome (${outcome})`);
    const texts = MESSAGES[code];
    assert.ok(texts && typeof texts.en === 'function' && typeof texts.vi === 'function', `code ${code} has a message in English and in Vietnamese`);
  }
  assert.deepEqual(Object.keys(MESSAGES).sort(), Object.keys(CODES).sort(), 'every message belongs to a code and every code has a message');
  assert.equal(Object.hasOwn(CODES, 'not_built'), false, 'every command of the plan is built: there is no not_built answer');
  // the doc
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'PROOF-CLI.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(fs.readFileSync(path.join(REPO, 'docs', 'INDEX.md'), 'utf8'), /\]\(PROOF-CLI\.md\)/, 'docs/INDEX.md links docs/PROOF-CLI.md');
  for (const command of COMMANDS) assert.ok(doc.includes(`### \`${command}\``), `the doc has a section for ${command}`);
  for (const [outcome, exitCode] of Object.entries(EXIT)) assert.match(doc, new RegExp(`^\\| ${exitCode} \\| \`${outcome}\` \\|`, 'm'), `the doc's exit table names ${exitCode} ${outcome}`);
  const documented = Object.fromEntries([...doc.matchAll(/^\| `([a-z][a-z0-9_]*)` \| ([0-4]) \|/gm)].map((match) => [match[1], Number(match[2])]));
  assert.deepEqual(documented, Object.fromEntries(Object.entries(CODES).map(([code, outcome]) => [code, EXIT[outcome]])), 'the doc lists every code with its exit code, and no other');
  for (const phrase of [CLI_FORMAT, '--json', '--lang', 'pod-26', 'pod-32', '.chatmcp/acceptance.yml', 'CHATMCP_STATE_DIR', 'no network', 'Windows PowerShell 5.1', 'cmd.exe']) {
    assert.ok(doc.includes(phrase), `the doc mentions ${phrase}`);
  }
  assert.match(doc, /never writes into the workspace/i, 'the doc says where the CLI writes');
  ok(`package.json bin and files (${modules.length} modules inside), the shebang, ${COMMANDS.length} commands, ${Object.keys(CODES).length} codes with messages in two languages, the doc and its tables`);
}

// ------------------------------------------------------------------------------------------------------------------------- 9a. the guard works
{
  const probe = path.join(SCRATCH, 'probe.mjs');
  fs.writeFileSync(probe, "import net from 'node:net';\ntry { net.connect(9, '127.0.0.1'); } catch { process.exitCode = 7; }\ntry { await fetch('http://127.0.0.1:9/'); } catch { process.exitCode = 7; }\n");
  const result = await spawnCollect(process.execPath, [...GUARD_ARGS, probe], { cwd: SCRATCH, env: { ...BASE_ENV, PROOF_CLI_NETLOG: path.join(SCRATCH, 'probe.log') } });
  assert.equal(result.status, 7, `the guard refuses: ${result.stderr}`);
  assert.deepEqual(fs.readFileSync(path.join(SCRATCH, 'probe.log'), 'utf8').trim().split('\n'), ['net.connect', 'fetch'], 'the guard records each use');
  ok('the network guard refuses and records net.connect and fetch');
}

// ------------------------------------------------------------------------------------------------------------------------- 8a. joining the words
{
  const posix = joinCommand(['node', '-e', 'process.stdout.write("x")', 'a b', "it's", '$HOME', '*', '', 'C:\\x', '--flag=1', 'a,b@c%d+e:f/g.h'], 'bash');
  assert.equal(posix, "node -e 'process.stdout.write(\"x\")' 'a b' 'it'\\''s' '$HOME' '*' '' 'C:\\x' --flag=1 a,b@c%d+e:f/g.h", 'bash: words outside the safe set are single-quoted');
  assert.equal(joinCommand(['node', 'x'], 'sh'), 'node x', 'sh: safe words stay as they are');
  assert.equal(joinCommand(['node -e "1"'], 'bash'), 'node -e "1"', 'one word is the command text, unchanged');
  assert.equal(joinCommand(['node -e "1"'], 'powershell'), 'node -e "1"', 'one word is the command text, unchanged, for PowerShell too');
  const ps = joinCommand(['node', '-e', 'process.exit(0)', 'a b', "it's", '$HOME', 'a,b', '@x', 'x--%', 'C:\\x', 'C:\\Program Files\\x', 'trail\\', 'one\u2019s'], 'powershell');
  assert.equal(ps, "node -e 'process.exit(0)' 'a b' 'it''s' '$HOME' 'a,b' '@x' 'x--%' C:\\x 'C:\\Program Files\\x' trail\\ 'one\u2019\u2019s'", 'powershell: single quotes, a quote doubled (curly ones too)');
  // what Windows PowerShell 5.1 was measured to change on the way to a program (tests/verify-proof-cli.mjs probes, docs/PROOF-CLI.md)
  for (const [word, why] of [['say "hi"', 'double_quote'], ['', 'empty'], ['--%', 'stop_parsing'], ['a b\\', 'trailing_backslash'], ['C:\\Program Files\\', 'trailing_backslash'],
    ['tab\t\\\\', 'trailing_backslash'], ['a\u00a0b\\', 'trailing_backslash']]) {
    assert.throws(() => joinCommand(['node', word], 'powershell'), (error) => error.code === 'unsafe_argument' && error.detail.why === why, `powershell refuses ${JSON.stringify(word)} (${why})`);
    if (why !== 'double_quote' && why !== 'empty') assert.equal(joinCommand(['node', word], 'bash'), word === '--%' ? 'node --%' : `node '${word}'`, `bash takes ${JSON.stringify(word)}`);
  }
  for (const words of [[], [''], ['   ']]) assert.throws(() => joinCommand(words, 'bash'), (error) => error.code === 'missing_command_text', `no command text: ${JSON.stringify(words)}`);
  ok('joinCommand: one word unchanged; several joined with bash/sh or PowerShell quoting; what PowerShell 5.1 would change is refused');
}

// ------------------------------------------------------------------------------------------------------------------------- 5c. the baseline store side
{
  // pack reads the baseline side of the check-changes report from the baseline's private store: a bare repository, like this one
  const bare = folder('store');
  git(bare, ['init', '-q', '--bare']);
  const put = (text) => git(bare, ['hash-object', '-w', '--stdin'], { input: text }).stdout.trim();
  const alpha = put('alpha\n'); // 6 bytes
  const beta = put('beta-beta\n'); // 10 bytes
  // a loose object written by hand under the id of other content: cat-file hands it out without checking it
  const forgedId = blobId(Buffer.from('original\n'));
  fs.mkdirSync(path.join(bare, 'objects', forgedId.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(bare, 'objects', forgedId.slice(0, 2), forgedId.slice(2)), zlib.deflateSync(Buffer.from('blob 7\0forged\n')));
  const entries = [
    { path: 'a.txt', mode: '100644', oid: alpha }, { path: 'b.txt', mode: '100644', oid: beta }, { path: 'forged.txt', mode: '100644', oid: forgedId },
    { path: 'sub', mode: '160000', oid: alpha }, { path: 'gone.txt', mode: '100644', oid: 'c'.repeat(40) },
  ];
  const side = await storeSide({ git: await findGit(), storeDir: bare, entries, objectFormat: 'sha1', scratch: folder('store-scratch') });
  assert.equal(side.entries, entries, 'the rows are the manifest\'s');
  const text = (map) => Object.fromEntries([...map].map(([file, value]) => [file, Buffer.isBuffer(value) ? value.toString('utf8') : value]));
  assert.deepEqual(text(await side.read(['a.txt', 'b.txt', 'sub', 'gone.txt', 'nowhere.txt'])),
    { 'a.txt': 'alpha\n', 'b.txt': 'beta-beta\n', sub: null, 'gone.txt': null, 'nowhere.txt': null }, 'blobs read, a submodule and what the store lacks are null');
  assert.deepEqual(text(await side.read(['a.txt', 'b.txt'], { maxBytes: 6 })), { 'a.txt': 'alpha\n', 'b.txt': { skipped: 'too_large', size: 10 } }, 'maxBytes, its edge included');
  assert.deepEqual(text(await side.read(['a.txt', 'b.txt'], { budget: 15 })), { 'a.txt': 'alpha\n', 'b.txt': { skipped: 'read_budget', size: 10 } }, 'the budget');
  assert.deepEqual(text(await side.read(['a.txt', 'b.txt'], { budget: 16 })), { 'a.txt': 'alpha\n', 'b.txt': 'beta-beta\n' }, 'the budget, its edge included');
  await assert.rejects(side.read(['a.txt', 'forged.txt']), (error) => error.code === 'store_object_mismatch' && error.detail.path === 'forged.txt', 'a blob that does not hash to its id');
  ok('the baseline store side: blobs, null for a submodule and a missing object, maxBytes and the budget at their edges, a forged blob refused');
}

// ------------------------------------------------------------------------------------------------------------------------- 2. usage, help, version, languages
{
  const plain = folder('usage');
  const cases = [
    [[], 'no_command'],
    [['verify'], 'no_command'],
    [['verify', 'bogus'], 'unknown_command'],
    [['init'], 'unknown_command'],
    [['verify', 'show', '--bogus'], 'unknown_option'],
    [['verify', 'show', 'extra'], 'unexpected_argument'],
    [['verify', 'show', '--lang', 'fr'], 'bad_value'],
    [['verify', 'show', '--lang'], 'missing_value'],
    [['verify', 'show', '--lang', 'en', '--lang', 'vi'], 'repeated_option'],
    [['verify', 'run'], 'missing_command_text'],
    [['verify', 'run', '--'], 'missing_command_text'],
    [['verify', 'run', '--timeout', 'abc', '--', 'node', '-v'], 'bad_value'],
    [['verify', 'run', '--timeout', '901', '--', 'node', '-v'], 'bad_value'],
    [['verify', 'run', '--shell', 'cmd', '--', 'node', '-v'], 'bad_value'],
    [['verify', 'show', '--', 'x'], 'unexpected_argument'],
    [['verify', 'trust', '--sha256', 'abc'], 'bad_value'],
    [['verify', 'init', '--print=1'], 'bad_value'],
    [['verify', 'show', '--print'], 'unknown_option'],
    [['verify', 'run', '--timeout', '0', '--', 'node', '-v'], 'bad_value'],
    [['verify', 'pack', '--agent', ''], 'bad_value'],
    [['verify', 'show', '--workspace', path.join(plain, 'missing')], 'bad_workspace'],
    [['verify', 'show'], 'no_session'],
    [['verify', 'run', '--', 'node', '-v'], 'no_session'],
    [['verify', 'pack'], 'no_session'],
  ];
  const answers = await Promise.all(cases.map(([args]) => ask(args, { cwd: plain })));
  cases.forEach(([args, code], index) => expectAnswer(answers[index], 2, code, `chatmcp ${args.join(' ')}`));
  assert.equal(answers[2].detail.command, 'bogus', 'the unknown command is named');
  assert.equal(answers[4].detail.option, '--bogus', 'the unknown option is named');

  // help and version
  const [help, verifyHelp, runHelp, version, humanUsage] = await Promise.all([
    cli(['--help'], { cwd: plain }), cli(['verify', '--help'], { cwd: plain }), cli(['verify', 'run', '--help'], { cwd: plain }), cli(['--version'], { cwd: plain }),
    cli(['verify', 'bogus'], { cwd: plain }),
  ]);
  for (const [result, what] of [[help, 'chatmcp --help'], [verifyHelp, 'chatmcp verify --help'], [runHelp, 'chatmcp verify run --help']]) {
    assert.equal(result.status, 0, `${what} exits 0: ${result.stderr}`);
    for (const command of COMMANDS) assert.ok(what.includes('run --help') || result.stdout.includes(command), `${what} names ${command}`);
  }
  assert.match(runHelp.stdout, /--shell/, 'the help of run names its options');
  assert.equal(version.status, 0, 'chatmcp --version exits 0');
  assert.equal(version.stdout.trim(), VERSION, 'chatmcp --version prints the Hub version');
  assert.equal(humanUsage.status, 2, 'a usage error exits 2 without --json too');
  assert.equal(humanUsage.stdout, '', 'a usage error writes nothing to stdout');
  assert.match(humanUsage.stderr, /bogus/, 'and says what was wrong on stderr');
  const helpJson = await ask(['verify', '--help'], { cwd: plain });
  expectAnswer(helpJson, 0, 'help', 'chatmcp verify --help --json');
  const helpVi = await cli(['verify', '--help', '--lang', 'vi'], { cwd: plain });
  assert.equal(helpVi.status, 0);
  assert.notEqual(helpVi.stdout, verifyHelp.stdout, 'the help in Vietnamese is not the English one');
  assert.match(helpVi.stdout, /^Các lệnh:$/m, 'the Vietnamese help');

  // English and Vietnamese: the same answer but for the message and the language; global options before `verify` too
  const [en, vi, viFirst] = await Promise.all([
    ask(['verify', 'run', '--timeout', 'abc', '--lang', 'en', '--', 'node'], { cwd: plain }),
    ask(['verify', 'run', '--timeout', 'abc', '--lang', 'vi', '--', 'node'], { cwd: plain }),
    ask(['--lang=vi', 'verify', 'run', '--timeout=abc', '--', 'node'], { cwd: plain }),
  ]);
  assert.equal(en.lang, 'en');
  assert.equal(vi.lang, 'vi');
  assert.notEqual(en.message, vi.message, 'the two languages say it differently');
  assert.match(vi.message, /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i, 'the Vietnamese message is written in Vietnamese');
  assert.deepEqual({ ...en, lang: null, message: null }, { ...vi, lang: null, message: null }, 'everything else is the same');
  assert.deepEqual(viFirst, vi, 'global options and --name=value work before the command too');
  const viHuman = await cli(['verify', 'bogus', '--lang', 'vi'], { cwd: plain });
  assert.equal(viHuman.status, 2);
  assert.ok(viHuman.stderr.includes(MESSAGES.unknown_command.vi({ command: 'bogus' })), `the human answer in Vietnamese: ${viHuman.stderr}`);
  assert.deepEqual(listing(plain), [], 'none of these wrote into the folder');
  assert.equal(fs.existsSync(STATE), false, 'nor created the state folder');
  ok(`${cases.length} usage errors exit 2 with their codes; help and --version exit 0; en and vi give the same JSON but the message`);
}

// ------------------------------------------------------------------------------------------------------------------------- 3. every command is built
{
  const plain = folder('built');
  write(plain, 'a.txt', 'a\n');
  const before = fingerprint(plain);
  const runs = await Promise.all([
    ask(['verify', 'check'], { cwd: plain }),
    ask(['verify', 'reproduce', '--lang', 'vi'], { cwd: plain }),
    ask(['verify', 'check', 'pack.json'], { cwd: plain }),
  ]);
  expectAnswer(runs[0], 2, 'missing_argument', 'check without a pack');
  expectAnswer(runs[1], 2, 'missing_argument', 'reproduce without a pack');
  expectAnswer(runs[2], 2, 'bad_pack', 'check of a file that is not there');
  for (const answer of runs) assert.equal(answer.data, null);
  assert.deepEqual([runs[0].detail, runs[1].detail], [{ command: 'check', argument: '<pack>' }, { command: 'reproduce', argument: '<pack>' }]);
  assert.equal(runs[1].message, MESSAGES.missing_argument.vi({ command: 'reproduce', argument: '<pack>' }), 'in Vietnamese');
  const human = await cli(['verify', 'check'], { cwd: plain });
  assert.equal(human.status, 2, 'exit 2 without --json too');
  assert.match(human.stderr, /check/, 'and the human answer names the command');
  // exec is built (pod-26, tests/verify-proof-cli-exec.mjs): a folder without an acceptance file is refused before anything runs
  const exec = await ask(['verify', 'exec', '--', 'some-agent', '-p', 'fix it'], { cwd: plain });
  expectAnswer(exec, 1, 'acceptance_missing', 'exec in a folder without an acceptance file');
  assert.deepEqual(fingerprint(plain), before, 'check and exec write nothing into the folder');
  assert.equal(fs.existsSync(STATE), false, 'nor anything into the state folder');
  ok('check and reproduce (pod-32) refuse a command line without a pack (exit 2), in both languages; exec (pod-26) refuses a folder without an acceptance file; none writes anything');
}

// ------------------------------------------------------------------------------------------------------------------------- 4. a plain folder
let plainFolder;
{
  const plain = real(folder('plain'));
  plainFolder = plain;
  write(plain, 'notes.txt', 'hello\n');
  const untouched = fingerprint(plain);
  // init --print: the proposal, nothing written
  const printed = await ask(['verify', 'init', '--print'], { cwd: plain });
  expectAnswer(printed, 0, 'acceptance_printed', 'init --print');
  assert.equal(printed.data.written, false);
  assert.equal(printed.data.file, '.chatmcp/acceptance.yml');
  assert.match(printed.data.text, /^version: 1$/m, 'the proposal is an acceptance file');
  assert.equal(printed.data.sha256, sha256(printed.data.text));
  assert.deepEqual(fingerprint(plain), untouched, 'init --print writes nothing');
  const printedHuman = await cli(['verify', 'init', '--print'], { cwd: plain });
  assert.equal(printedHuman.status, 0);
  assert.equal(printedHuman.stdout, printed.data.text, 'init --print without --json prints the file itself, ready to redirect');
  // init: writes the file, never overwrites it
  const written = await ask(['verify', 'init'], { cwd: plain });
  expectAnswer(written, 0, 'acceptance_written', 'init');
  const file = path.join(plain, '.chatmcp', 'acceptance.yml');
  assert.equal(fs.readFileSync(file, 'utf8'), printed.data.text, 'init writes the proposal');
  assert.deepEqual(Object.keys(fingerprint(plain)).sort(), ['.chatmcp', '.chatmcp/acceptance.yml', 'notes.txt'], 'and nothing else');
  fs.writeFileSync(file, `${printed.data.text}# edited by the owner\n`);
  const edited = fingerprint(plain);
  const again = await ask(['verify', 'init'], { cwd: plain });
  expectAnswer(again, 1, 'acceptance_exists', 'init when the file is there');
  expectAnswer(await ask(['verify', 'init', '--print'], { cwd: plain }), 1, 'acceptance_exists', 'init --print when the file is there');
  assert.deepEqual(fingerprint(plain), edited, 'the owner\'s file is left as it is');
  // trust: preview, a wrong digest, the right one, revoke
  const bytes = fs.readFileSync(file);
  const preview = await ask(['verify', 'trust'], { cwd: plain });
  expectAnswer(preview, 1, 'not_trusted', 'trust without --sha256');
  assert.equal(preview.data.sha256, sha256(bytes), 'the digest of the exact bytes on disk');
  assert.equal(preview.data.trusted, false);
  assert.ok(preview.data.trustCommand.includes(`--sha256 ${sha256(bytes)}`), `the preview says how to trust: ${preview.data.trustCommand}`);
  const wrong = await ask(['verify', 'trust', '--sha256', 'f'.repeat(64)], { cwd: plain });
  expectAnswer(wrong, 3, 'sha256_mismatch', 'trust with another digest');
  assert.equal(wrong.detail.actual, sha256(bytes));
  const trusted = await ask(['verify', 'trust', '--sha256', sha256(bytes).toUpperCase()], { cwd: plain });
  expectAnswer(trusted, 0, 'trusted', 'trust with the digest');
  assert.equal(trusted.data.trusted, true);
  const store = JSON.parse(fs.readFileSync(path.join(STATE, 'proof', 'trusted-acceptance.json'), 'utf8'));
  assert.ok(store.trusted[sha256(bytes)], 'the trust store of pod-20 holds the digest');
  expectAnswer(await ask(['verify', 'trust'], { cwd: plain }), 0, 'trusted', 'trust preview of a trusted file');
  expectAnswer(await ask(['verify', 'trust', '--revoke'], { cwd: plain }), 0, 'revoked', 'trust --revoke');
  expectAnswer(await ask(['verify', 'trust', '--revoke'], { cwd: plain }), 0, 'already_untrusted', 'trust --revoke again');
  expectAnswer(await ask(['verify', 'trust'], { cwd: plain }), 1, 'not_trusted', 'trust preview after the revoke');
  fs.writeFileSync(file, 'version: 1\ncriteria: [\n');
  const broken = await ask(['verify', 'trust'], { cwd: plain });
  expectAnswer(broken, 1, 'acceptance_invalid', 'trust of a file that does not read');
  assert.equal(broken.detail.line, 2, 'the line of the problem');
  fs.writeFileSync(file, bytes);
  // snapshot, run, show; pack refused
  const afterInit = fingerprint(plain);
  const snap = await ask(['verify', 'snapshot'], { cwd: plain });
  expectAnswer(snap, 0, 'snapshot_taken', 'snapshot of a plain folder');
  assert.equal(snap.data.repository, false);
  assert.equal(snap.data.patchAvailable, false);
  assert.equal(snap.data.patchReason, 'not_a_repository');
  assert.deepEqual(snap.data.acceptance, { present: true, sha256: sha256(bytes), trusted: false });
  const run = await ask(['verify', 'run', '--', 'node', '-e', "process.stdout.write('plain run')"], { cwd: plain });
  expectAnswer(run, 0, 'check_passed', 'run in a plain folder');
  assert.equal(run.data.receipt.stdout.preview, 'plain run');
  const failed = await ask(['verify', 'run', '--', 'node', '-e', 'process.exit(3)'], { cwd: plain });
  expectAnswer(failed, 1, 'check_failed', 'run of a command that fails');
  assert.equal(failed.data.receipt.exit, 3);
  assert.equal(failed.data.receipt.passed, false);
  const shown = await ask(['verify', 'show'], { cwd: plain });
  expectAnswer(shown, 0, 'session_intact', 'show');
  assert.equal(shown.data.taskId, snap.data.taskId);
  assert.deepEqual(shown.data.receipts.map((receipt) => [receipt.seq, receipt.exit, receipt.passed]), [[2, 0, true], [3, 3, false]], 'show lists the receipts');
  const pack = await ask(['verify', 'pack'], { cwd: plain });
  expectAnswer(pack, 4, 'not_a_repository', 'pack of a plain folder');
  const outside = await ask(['verify', 'run', '--cwd', '..', '--', 'node', '-v'], { cwd: plain });
  expectAnswer(outside, 2, 'bad_cwd', 'run --cwd outside the workspace');
  expectAnswer(await ask(['verify', 'run', '--cwd', 'notes.txt', '--', 'node', '-v'], { cwd: plain }), 2, 'bad_cwd', 'run --cwd naming a file');
  expectAnswer(await ask(['verify', 'run', '--cwd', 'missing', '--', 'node', '-v'], { cwd: plain }), 2, 'bad_cwd', 'run --cwd naming nothing');
  assert.deepEqual(fingerprint(plain), afterInit, 'snapshot, run, show and pack write nothing into the folder');
  ok('a plain folder: init --print, init (never overwrites), trust preview / wrong digest (3) / trust / revoke, snapshot, run, show; pack exit 4');
}

// ------------------------------------------------------------------------------------------------------------------------- 4b. odd acceptance files
{
  // .chatmcp is a link (a junction on Windows, which needs no privilege) to a folder outside the workspace
  const away = folder('away');
  write(away, 'acceptance.yml', 'version: 1\ncriteria:\n  - id: x\n    text: x\n    checks:\n      - run: node -v\n');
  const awayBefore = fingerprint(away);
  const linked = real(folder('linked'));
  fs.symlinkSync(away, path.join(linked, '.chatmcp'), 'junction');
  const linkedBefore = fingerprint(linked);
  for (const args of [['verify', 'init'], ['verify', 'init', '--print'], ['verify', 'trust'], ['verify', 'snapshot']]) {
    expectAnswer(await ask(args, { cwd: linked }), 4, 'acceptance_outside', `${args.join(' ')} through a link out of the workspace`);
  }
  assert.deepEqual(fingerprint(away), awayBefore, 'nothing was written through the link');
  assert.deepEqual(fingerprint(linked), linkedBefore, 'nor into the workspace');
  // a folder where the file should be
  const odd = real(folder('odd'));
  fs.mkdirSync(path.join(odd, '.chatmcp', 'acceptance.yml'), { recursive: true });
  expectAnswer(await ask(['verify', 'trust'], { cwd: odd }), 1, 'acceptance_missing', 'trust of a folder named acceptance.yml');
  expectAnswer(await ask(['verify', 'init'], { cwd: odd }), 1, 'acceptance_exists', 'init where a folder holds the name');
  ok('odd acceptance files: .chatmcp linked out of the workspace is exit 4 for init, trust and snapshot (nothing written); a folder in its place is no file');
}

// ------------------------------------------------------------------------------------------------------------------------- 5. a Git repository
const ACCEPTANCE = 'version: 1\ncriteria:\n  - id: unit\n    text: The unit test passes\n    checks:\n      - run: node test.mjs\nprotected:\n  - ".chatmcp/**"\n';
const TEST = "import { add } from './src/add.mjs';\nif (add(2, 3) !== 5) { console.error('add is wrong'); process.exit(1); }\nconsole.log('1 test passed');\n";
function gitRepository(label) {
  const repo = real(newRepo(label));
  write(repo, 'src/add.mjs', 'export const add = (a, b) => a + b;\n');
  write(repo, 'test.mjs', TEST);
  write(repo, '.chatmcp/acceptance.yml', ACCEPTANCE);
  commitAll(repo);
  write(repo, '.env', 'API_TOKEN=not-a-real-token\n'); // protected: never in a tree, counted in excludedPaths
  return repo;
}
const head = (repo) => fs.readFileSync(path.join(repo, '.git', fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim().replace(/^ref: /, '')), 'utf8').trim();
{
  const repo = gitRepository('git-flow');
  const acceptanceSha = sha256(ACCEPTANCE);
  const preview = await ask(['verify', 'trust'], { cwd: repo });
  expectAnswer(preview, 1, 'not_trusted', 'trust preview in the repository');
  assert.deepEqual(preview.data.checks, [{ criterion: 'unit', run: 'node test.mjs', cwd: '.' }], 'the preview lists the commands that would be trusted');
  expectAnswer(await ask(['verify', 'trust', '--sha256', acceptanceSha], { cwd: repo }), 0, 'trusted', 'trust');
  const clean = fingerprint(repo);
  const snap = await ask(['verify', 'snapshot'], { cwd: repo });
  expectAnswer(snap, 0, 'snapshot_taken', 'snapshot of a repository');
  assert.match(snap.data.taskId, /^cli-\d{8}T\d{9}Z-[0-9a-f]{8}$/, 'the task id is named after the baseline');
  assert.equal(snap.data.taskId, `cli-${snap.data.baselineId}`);
  assert.equal(snap.data.repository, true);
  assert.equal(snap.data.patchAvailable, true);
  assert.deepEqual(snap.data.acceptance, { present: true, sha256: acceptanceSha, trusted: true });
  assert.ok(fs.existsSync(snap.data.paths.ledger) && fs.existsSync(snap.data.paths.baseline), 'the ledger and the baseline record exist');
  assert.ok(snap.data.paths.ledger.startsWith(STATE) && snap.data.paths.baseline.startsWith(STATE), 'both in the state folder');
  assert.deepEqual(fingerprint(repo), clean, 'snapshot writes nothing into the repository, .git included');

  // the agent's edit, then the check, through both spellings of the command
  write(repo, 'src/add.mjs', '// the agent was here\nexport const add = (a, b) => a + b;\n');
  const edited = fingerprint(repo);
  const one = await ask(['verify', 'run', '--', 'node test.mjs'], { cwd: repo });
  const two = await ask(['verify', 'run', '--', 'node', 'test.mjs'], { cwd: repo });
  for (const answer of [one, two]) {
    expectAnswer(answer, 0, 'check_passed', 'run of the criterion\'s check');
    assert.equal(answer.data.command, 'node test.mjs', 'one word and two safe words give the same command text');
    assert.equal(answer.data.receipt.commandSha256, sha256('node test.mjs'));
    assert.match(answer.data.receipt.stdout.preview, /1 test passed/);
  }
  assert.deepEqual(fingerprint(repo), edited, 'run writes nothing into the repository');
  const shown = await ask(['verify', 'show'], { cwd: repo });
  expectAnswer(shown, 0, 'session_intact', 'show');
  assert.deepEqual([shown.data.ledger.records, shown.data.ledger.verified, shown.data.receipts.length], [3, true, 2]);
  assert.equal(shown.data.baseline.verifiedAgainst, 'anchor', 'show checks the baseline against the anchor in the ledger');
  const [showEn, showVi] = await Promise.all([ask(['verify', 'show', '--lang', 'en'], { cwd: repo }), ask(['verify', 'show', '--lang', 'vi'], { cwd: repo })]);
  assert.deepEqual({ ...showEn, lang: null, message: null }, { ...showVi, lang: null, message: null }, 'show: the same JSON in both languages');
  const humanShow = await cli(['verify', 'show', '--lang', 'vi'], { cwd: repo });
  assert.equal(humanShow.status, 0);
  assert.ok(humanShow.stdout.includes(snap.data.taskId) && humanShow.stdout.includes(MESSAGES.session_intact.vi({ taskId: snap.data.taskId })), `show in Vietnamese: ${humanShow.stdout}`);

  // pack: evidenced
  const pack = await ask(['verify', 'pack', '--agent', 'some-agent', '--agent-version', '9.9.9'], { cwd: repo });
  expectAnswer(pack, 0, 'pack_evidenced', 'pack after a passing check on the final tree');
  const statement = pack.data.statement;
  assert.deepEqual(pack.data.criteria, [{ id: 'unit', status: 'evidenced' }]);
  assert.deepEqual(statement.predicate.criteria.map((criterion) => [criterion.id, criterion.status]), [['unit', 'evidenced']]);
  assert.equal(statement.subject[0].digest.gitTree, snap.data.tree, 'the before subject is the baseline tree');
  assert.notEqual(statement.subject[1].digest.gitTree, snap.data.tree, 'the after subject is the edited tree');
  assert.equal(one.data.receipt.treeBefore, statement.subject[1].digest.gitTree, 'the receipt was taken on the tree the pack calls final');
  assert.equal(one.data.receipt.treeAfter, one.data.receipt.treeBefore, 'and the check did not change it');
  assert.notEqual(statement.subject[2].digest.sha256, sha256(''), 'the diff subject is the hash of a patch that is not empty');
  assert.deepEqual(statement.predicate.agent, { name: 'some-agent', version: '9.9.9' });
  assert.equal(statement.predicate.baseCommit, head(repo), 'baseCommit is the commit the baseline was taken on');
  assert.equal(statement.predicate.acceptance.trusted, true);
  assert.equal(statement.predicate.checkChanges.reported, true, 'the check-changes report of pod-22 is in the pack');
  assert.equal(statement.predicate.checkChanges.checksModified, false);
  assert.equal(statement.predicate.ledger.verified, true);
  assert.equal(statement.predicate.receipts.length, 2);
  assert.ok(statement.predicate.excludedPaths.protected >= 1, `the protected .env is counted: ${JSON.stringify(statement.predicate.excludedPaths)}`);
  assert.equal(pack.data.digest, statementDigest(statement));
  assert.deepEqual(pack.data.changes, { added: 0, modified: 1, deleted: 0 });
  assert.equal(fs.readFileSync(pack.data.file, 'utf8'), `${canonicalJson(statement)}\n`, 'the statement is written canonically to the state folder');
  assert.ok(pack.data.file.startsWith(STATE));
  assert.ok(!JSON.stringify(statement).includes('not-a-real-token'), 'nothing of the protected file is in the pack');
  assert.deepEqual(fingerprint(repo), edited, 'pack writes nothing into the repository');
  const defaultAgent = await ask(['verify', 'pack'], { cwd: repo });
  assert.deepEqual(defaultAgent.data.statement.predicate.agent, { name: 'unknown', version: 'unknown' }, 'the agent is unknown unless named');

  // stale, then evidenced again; untrusted; checks modified
  write(repo, 'src/add.mjs', '// the agent was here twice\nexport const add = (a, b) => a + b;\n');
  const stale = await ask(['verify', 'pack'], { cwd: repo });
  expectAnswer(stale, 1, 'pack_unverified', 'pack after an edit that came after the check');
  assert.deepEqual(stale.data.criteria, [{ id: 'unit', status: 'stale' }]);
  expectAnswer(await ask(['verify', 'run', '--', 'node', 'test.mjs'], { cwd: repo }), 0, 'check_passed', 'run again');
  expectAnswer(await ask(['verify', 'pack'], { cwd: repo }), 0, 'pack_evidenced', 'pack after the check ran on the final tree');
  expectAnswer(await ask(['verify', 'trust', '--revoke'], { cwd: repo }), 0, 'revoked', 'revoke');
  const untrusted = await ask(['verify', 'pack'], { cwd: repo });
  expectAnswer(untrusted, 1, 'pack_unverified', 'pack of an untrusted acceptance file');
  assert.deepEqual(untrusted.data.criteria, [{ id: 'unit', status: 'unverified' }]);
  assert.ok(untrusted.data.statement.predicate.criteria[0].reasons.some((reason) => reason.code === 'acceptance_untrusted'));
  expectAnswer(await ask(['verify', 'trust', '--sha256', acceptanceSha], { cwd: repo }), 0, 'trusted', 'trust again');
  write(repo, 'test.mjs', "import { add } from './src/add.mjs';\nconsole.log('1 test passed');\n");
  expectAnswer(await ask(['verify', 'run', '--', 'node', 'test.mjs'], { cwd: repo }), 0, 'check_passed', 'run of the weakened test');
  const modified = await ask(['verify', 'pack'], { cwd: repo });
  expectAnswer(modified, 1, 'pack_unverified', 'pack after the check file was changed');
  assert.deepEqual(modified.data.criteria, [{ id: 'unit', status: 'checks_modified' }]);
  assert.equal(modified.data.statement.predicate.checkChanges.checksModified, true);
  // the criteria are the baseline's: an acceptance file rewritten (and trusted) after the snapshot does not replace them
  const rewritten = 'version: 1\ncriteria:\n  - id: easier\n    text: Anything passes\n    checks:\n      - run: node -v\n';
  write(repo, '.chatmcp/acceptance.yml', rewritten);
  expectAnswer(await ask(['verify', 'trust', '--sha256', sha256(rewritten)], { cwd: repo }), 0, 'trusted', 'trust of the rewritten file');
  expectAnswer(await ask(['verify', 'run', '--', 'node', '-v'], { cwd: repo }), 0, 'check_passed', 'run of the rewritten check');
  const rewrittenPack = await ask(['verify', 'pack'], { cwd: repo });
  expectAnswer(rewrittenPack, 1, 'pack_unverified', 'pack after the acceptance file was rewritten');
  assert.deepEqual(rewrittenPack.data.criteria.map((criterion) => criterion.id), ['unit'], 'the criteria stay the baseline\'s');
  assert.equal(rewrittenPack.data.statement.predicate.acceptance.edited, true, 'and the pack says the file was edited');
  assert.equal(rewrittenPack.data.statement.predicate.acceptance.baselineSha256, acceptanceSha, 'the baseline file is the one of the snapshot');
  ok('a Git repository: snapshot, edit, run, pack exit 0 (evidenced, both schemas, canonical file); stale, untrusted, checks_modified and a rewritten acceptance file exit 1; the repository never written');
}

// ------------------------------------------------------------------------------------------------------------------------- 5b. no acceptance file
{
  const repo = real(newRepo('no-acceptance'));
  write(repo, 'a.txt', 'a\n');
  commitAll(repo);
  const snap = await ask(['verify', 'snapshot'], { cwd: repo });
  expectAnswer(snap, 0, 'snapshot_taken', 'snapshot without an acceptance file');
  assert.deepEqual(snap.data.acceptance, { present: false, sha256: null, trusted: false });
  assert.equal(snap.data.paths.acceptanceCopy, null);
  const pack = await ask(['verify', 'pack'], { cwd: repo });
  expectAnswer(pack, 1, 'pack_unverified', 'a pack with no criterion is not a pass');
  assert.deepEqual(pack.data.criteria, []);
  ok('a repository without an acceptance file: snapshot works, the pack has no criterion and is exit 1');
}

// ------------------------------------------------------------------------------------------------------------------------- 6. integrity
{
  const repo = gitRepository('integrity');
  expectAnswer(await ask(['verify', 'trust', '--sha256', sha256(ACCEPTANCE)], { cwd: repo }), 0, 'trusted', 'trust');
  const key = workspaceKey(repo);
  const flip = (file, from, to) => {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes(from), `(premise) ${file} holds ${from}`);
    fs.writeFileSync(file, text.replace(from, to));
  };
  // an edited ledger: show, run (the command does not run) and pack refuse
  const first = await ask(['verify', 'snapshot'], { cwd: repo });
  flip(first.data.paths.ledger, '"task_start"', '"task_start" ');
  const [show, pack] = await Promise.all([ask(['verify', 'show'], { cwd: repo }), ask(['verify', 'pack'], { cwd: repo })]);
  expectAnswer(show, 3, 'ledger_broken', 'show of an edited ledger');
  assert.equal(show.detail.brokenAt, 1, 'the line that was edited');
  expectAnswer(pack, 3, 'ledger_broken', 'pack of an edited ledger');
  const run = await ask(['verify', 'run', '--', 'node', '-e', "require('fs').writeFileSync('ran.txt', 'x')"], { cwd: repo });
  expectAnswer(run, 3, 'ledger_broken', 'run on an edited ledger');
  assert.equal(fs.existsSync(path.join(repo, 'ran.txt')), false, 'the command did not run');
  // a deleted ledger
  fs.rmSync(first.data.paths.ledger);
  expectAnswer(await ask(['verify', 'show'], { cwd: repo }), 3, 'session_broken', 'show without the ledger');
  expectAnswer(await ask(['verify', 'run', '--', 'node', '-v'], { cwd: repo }), 3, 'session_broken', 'run without the ledger');
  assert.equal(fs.existsSync(first.data.paths.ledger), false, 'run did not start a ledger without its task_start');
  // an edited baseline record
  const second = await ask(['verify', 'snapshot'], { cwd: repo });
  assert.ok(second.data.paths.baseline.includes(key), 'the baseline folder is named by the workspace key');
  flip(second.data.paths.baseline, second.data.tree, second.data.tree.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')));
  expectAnswer(await ask(['verify', 'show'], { cwd: repo }), 3, 'baseline_edited', 'show of an edited baseline');
  expectAnswer(await ask(['verify', 'pack'], { cwd: repo }), 3, 'baseline_edited', 'pack of an edited baseline');
  // an edited session copy of the acceptance file
  const third = await ask(['verify', 'snapshot'], { cwd: repo });
  assert.ok(third.data.paths.acceptanceCopy && fs.existsSync(third.data.paths.acceptanceCopy), 'the session keeps the raw bytes of the acceptance file');
  fs.appendFileSync(third.data.paths.acceptanceCopy, '# changed\n');
  expectAnswer(await ask(['verify', 'show'], { cwd: repo }), 3, 'session_edited', 'show of an edited session copy');
  expectAnswer(await ask(['verify', 'pack'], { cwd: repo }), 3, 'session_edited', 'pack of an edited session copy');
  // a baseline record rewritten with its own sha256 recomputed passes alone, not against the anchor the ledger holds
  const fourth = await ask(['verify', 'snapshot'], { cwd: repo });
  const line = fs.readFileSync(fourth.data.paths.baseline, 'utf8');
  const body = `${line.slice(0, line.indexOf(',"recordSha256":"'))}}`;
  assert.equal(sha256(body), fourth.data.baselineSha256, '(premise) the record is its text and that text\'s sha256');
  const forged = JSON.parse(body);
  forged.snapshot.durationMs += 1;
  const forgedBody = JSON.stringify(forged);
  fs.writeFileSync(fourth.data.paths.baseline, `${forgedBody.slice(0, -1)},"recordSha256":"${sha256(forgedBody)}"}\n`);
  expectAnswer(await ask(['verify', 'show'], { cwd: repo }), 3, 'baseline_mismatch', 'show of a re-hashed baseline');
  expectAnswer(await ask(['verify', 'pack'], { cwd: repo }), 3, 'baseline_mismatch', 'pack of a re-hashed baseline');
  // a torn last line (a write cut by a crash): show and pack refuse it, run repairs it the ledger's way and goes on
  const fifth = await ask(['verify', 'snapshot'], { cwd: repo });
  expectAnswer(await ask(['verify', 'run', '--', 'node', '-v'], { cwd: repo }), 0, 'check_passed', 'a receipt to tear');
  fs.writeFileSync(fifth.data.paths.ledger, fs.readFileSync(fifth.data.paths.ledger).subarray(0, -1));
  const torn = await ask(['verify', 'show'], { cwd: repo });
  expectAnswer(torn, 3, 'ledger_broken', 'show of a torn ledger');
  assert.deepEqual([torn.detail.reason, torn.detail.brokenAt], ['torn_tail', 2]);
  expectAnswer(await ask(['verify', 'run', '--', 'node', '-v'], { cwd: repo }), 0, 'check_passed', 'run on a torn ledger');
  const repaired = await ask(['verify', 'show'], { cwd: repo });
  expectAnswer(repaired, 0, 'session_intact', 'show after the repair');
  assert.deepEqual(repaired.data.receipts.map((receipt) => receipt.seq), [3], 'the torn receipt was replaced by an uncertain record');
  assert.equal(repaired.data.ledger.records, 3);
  // session.json that is not a session
  fs.writeFileSync(fifth.data.paths.session, 'not json\n');
  const pointer = await ask(['verify', 'show'], { cwd: repo });
  expectAnswer(pointer, 3, 'session_broken', 'show with a broken session.json');
  assert.equal(pointer.detail.why, 'session_file_not_json');
  const pointTo = (fields) => fs.writeFileSync(fifth.data.paths.session, `${JSON.stringify({ format: 'chatmcp.verify-session/1', taskId: fifth.data.taskId, baselineId: fifth.data.baselineId, workspace: repo, ...fields })}\n`);
  for (const [fields, why] of [[{ baselineId: fourth.data.baselineId }, 'session_file_not_a_session'], [{ format: 'chatmcp.verify-session/2' }, 'session_file_not_a_session'],
    [{ taskId: `x${fifth.data.taskId}` }, 'session_file_not_a_session']]) {
    pointTo(fields);
    const answer = await ask(['verify', 'show'], { cwd: repo });
    expectAnswer(answer, 3, 'session_broken', `show with a session.json that is not this session (${JSON.stringify(fields)})`);
    assert.equal(answer.detail.why, why);
  }
  // the ledger of another session under this session's name: a whole chain, but its task_start is not this session's
  pointTo({});
  expectAnswer(await ask(['verify', 'show'], { cwd: repo }), 0, 'session_intact', '(premise) the session is whole again');
  fs.copyFileSync(fourth.data.paths.ledger, fifth.data.paths.ledger);
  const swapped = await ask(['verify', 'show'], { cwd: repo });
  expectAnswer(swapped, 3, 'session_broken', 'show with the ledger of another session');
  assert.equal(swapped.detail.why, 'ledger_does_not_start_this_session');
  ok('integrity: an edited, deleted or torn ledger, an edited or re-hashed baseline, an edited session copy and a broken session.json are exit 3; run does not run on a broken ledger and repairs a torn one');
}

// ------------------------------------------------------------------------------------------------------------------------- 7. environment
{
  const repo = gitRepository('state-inside');
  const before = fingerprint(repo);
  const inside = { CHATMCP_STATE_DIR: path.join(repo, '.datgold-state') };
  const insideState = path.join(STATE, 'inside');
  fs.mkdirSync(insideState, { recursive: true });
  const answers = await Promise.all([
    ask(['verify', 'snapshot'], { cwd: repo, env: inside }),
    ask(['verify', 'trust', '--sha256', sha256(ACCEPTANCE)], { cwd: repo, env: inside }),
    ask(['verify', 'snapshot'], { cwd: path.join(STATE), env: { CHATMCP_STATE_DIR: STATE } }),
    ask(['verify', 'snapshot'], { cwd: insideState, env: { CHATMCP_STATE_DIR: STATE } }),
  ]);
  for (const answer of answers) expectAnswer(answer, 4, 'state_inside_workspace', 'a state folder inside the workspace, or the workspace inside it');
  assert.deepEqual(fingerprint(repo), before, 'nothing was written into the repository');
  ok('a state folder inside the workspace (or the workspace inside the state folder) is refused with exit 4 before anything is written');
}

// ------------------------------------------------------------------------------------------------------------------------- 8b. the words after --, for real
{
  const plain = plainFolder; // its session is still open (section 4)
  const PRINT = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const words = ['a b', "it's", 'x"y', '$HOME', '*', '', '$(echo hi)', '`id`', 'a;b|c&d', '~', 'multi\nline', 'Tiếng Việt', 'C:\\Program Files\\', '--%'];
  const bash = await ask(['verify', 'run', '--', 'node', '-e', PRINT, ...words], { cwd: plain });
  expectAnswer(bash, 0, 'check_passed', 'run with several words through the default shell');
  assert.equal(bash.data.command, joinCommand(['node', '-e', PRINT, ...words], bash.data.shell), 'the command text is the join of the words');
  assert.equal(bash.data.receipt.stdout.preview, JSON.stringify(words), `every word reached the program unchanged (${bash.data.shell})`);
  const single = await ask(['verify', 'run', '--', "node -e \"process.stdout.write('one')\""], { cwd: plain });
  expectAnswer(single, 0, 'check_passed', 'run with the command as one word');
  assert.equal(single.data.command, "node -e \"process.stdout.write('one')\"", 'one word is the command text, unchanged');
  assert.equal(single.data.receipt.stdout.preview, 'one');
  // PowerShell: where there is one, the join reaches the program; a word PowerShell 5.1 would change is refused before anything runs
  const psWords = ['a b', "it's", '$HOME', 'a,b', '$(echo hi)', '`n', 'a;b|c&d', 'Tiếng Việt', 'C:\\Program Files\\x', 'trail\\', 'x--%'];
  const ps = await ask(['verify', 'run', '--shell', 'powershell', '--', 'node', '-e', PRINT, ...psWords], { cwd: plain });
  const unsafe = await Promise.all(['say "hi"', 'C:\\Program Files\\', '--%'].map((word) => ask(['verify', 'run', '--shell', 'powershell', '--', 'node', '-e', PRINT, word], { cwd: plain })));
  if (ps.code === 'shell_unavailable') {
    expectAnswer(ps, 4, 'shell_unavailable', 'run --shell powershell where there is none');
    for (const answer of unsafe) expectAnswer(answer, 4, 'shell_unavailable', 'the same answer before any quoting');
    assert.notEqual(process.platform, 'win32', 'Windows always has Windows PowerShell');
  } else {
    expectAnswer(ps, 0, 'check_passed', 'run --shell powershell with several words');
    assert.equal(ps.data.shell, 'powershell');
    assert.equal(ps.data.receipt.stdout.preview, JSON.stringify(psWords), 'every word reached the program unchanged (powershell)');
    for (const answer of unsafe) expectAnswer(answer, 2, 'unsafe_argument', `a word PowerShell 5.1 would change: ${answer.detail?.argument}`);
  }
  // typed command lines: cmd.exe and powershell.exe on Windows, sh elsewhere
  const node = process.execPath;
  const guardUrl = pathToFileURL(GUARD).href;
  const env = { ...BASE_ENV };
  const typed = [];
  if (process.platform === 'win32') {
    const line = `"${node}" --import "${guardUrl}" "${BIN}" verify run --json -- node -e "${PRINT}" "a b" "it's" x\\"y`;
    typed.push(['cmd.exe', await spawnCollect(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd: plain, env, verbatim: true }), ['a b', "it's", 'x"y']]);
    const script = `& '${node}' --import '${guardUrl}' '${BIN}' verify run --json -- node -e '${PRINT}' 'a b' "it's"`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const powershell = windowsPowerShellPath();
    const psEnv = powerShellChildEnvironment({}, env);
    typed.push(['powershell.exe', await spawnCollect(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd: plain, env: psEnv }), ['a b', "it's"]]);
    // the recipe the doc gives for Windows PowerShell 5.1: the whole command as one word, single quotes inside
    const recipe = `& '${node}' --import '${guardUrl}' '${BIN}' verify run --json -- "node -e 'process.stdout.write(String(1+1))'"`;
    const recipeRun = await spawnCollect(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(recipe, 'utf16le').toString('base64')], { cwd: plain, env: psEnv });
    const recipeAnswer = answerOf(recipeRun, 'the PowerShell recipe');
    expectAnswer(recipeAnswer, 0, 'check_passed', 'the PowerShell recipe');
    assert.equal(recipeAnswer.data.command, "node -e 'process.stdout.write(String(1+1))'");
    assert.equal(recipeAnswer.data.receipt.stdout.preview, '2');
  } else {
    const q = (text) => `'${text.replaceAll("'", "'\\''")}'`;
    const line = `${q(node)} --import ${q(guardUrl)} ${q(BIN)} verify run --json -- node -e ${q(PRINT)} 'a b' "it's" 'x"y'`;
    typed.push(['sh', await spawnCollect('/bin/sh', ['-c', line], { cwd: plain, env }), ['a b', "it's", 'x"y']]);
  }
  for (const [shell, result, expected] of typed) {
    const answer = answerOf(result, `a command line typed into ${shell}`);
    expectAnswer(answer, 0, 'check_passed', `a command line typed into ${shell}`);
    assert.equal(answer.data.receipt.stdout.preview, JSON.stringify(expected), `${shell}: the words reached the check unchanged`);
  }
  ok(`the words after --: one word unchanged, several joined for ${bash.data.shell}${ps.code === 'shell_unavailable' ? '' : ' and powershell'}; typed lines through ${typed.map(([shell]) => shell).join(', ')}`);
}

// ------------------------------------------------------------------------------------------------------------------------- 9b. no network, at the end
{
  assert.equal(fs.existsSync(NETLOG) ? fs.readFileSync(NETLOG, 'utf8') : '', '', 'no CLI process of this suite used the network');
  ok('no CLI process of this suite opened a socket, looked up a name, made an HTTP request or called fetch');
}

console.log(`verify-proof-cli: ${checks} checks passed in ${elapsed()}`);
