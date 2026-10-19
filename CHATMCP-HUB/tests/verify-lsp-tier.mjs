// LSP tier on the production seam.
//
// v3.9.0 read this.workspace.path inside the code-intelligence engine. StudioWorkspace has get root() and no path, so every LSP answer
// was thrown away and find_definition / find_references silently fell back to heuristics, while the tests (hand-written workspace
// doubles that carried .path) stayed green. The same method also reset the circuit-breaker counter before the code that could throw.
//
// Everything here goes through the real StudioWorkspace -> LocalTools -> CodeIntelligenceEngine -> CodeIntelligence (studio-intelligence)
// -> LspProcess chain; only the language-server child process differs:
//   * always:   tests/fixtures/stub-lsp-server.mjs, a protocol-faithful stdio LSP that answers from the real workspace files,
//               installed in a temporary bundle with the layout of the staged runtime (runtimes/lsp/node_modules/...).
//   * when found: the real typescript-language-server and pyright from the node_modules folder named by CHATMCP_LSP_NODE_MODULES (the
//               staged runtime's runtimes/lsp/node_modules, or an `npm ci --ignore-scripts` of scripts/intelligence-runtime) or, failing
//               that, from a global npm install, linked into the same bundle layout.
//
// CHATMCP_REQUIRE_REAL_LSP=1 turns "a real server was not found" from a skip line into a failure (the CI job that stages the runtime sets
// it, like CHATMCP_REQUIRE_HOST_SUPERVISOR for the Windows host fixture). With CHATMCP_LSP_NODE_MODULES also set, only that folder counts,
// so a global install cannot stand in for a runtime that lacks a package. tests/verify-lsp-real-gate.mjs tests this gate.
// CLAIM: lsp-tier
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { CodeIntelligence } from '../lib/studio-intelligence.mjs';
import { CodeIntelligenceEngine } from '../lib/code-intelligence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(here, 'fixtures', 'stub-lsp-server.mjs');
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

// ---- which real language servers an npm install can be found for (decided before anything is started) ------------------------------
const requireRealLsp = process.env.CHATMCP_REQUIRE_REAL_LSP === '1';
const candidates = [];
if (process.env.CHATMCP_LSP_NODE_MODULES) candidates.push(process.env.CHATMCP_LSP_NODE_MODULES);
if (!(requireRealLsp && process.env.CHATMCP_LSP_NODE_MODULES)) {
  if (process.platform === 'win32' && process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  else { try { candidates.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000 }).trim()); } catch { /* npm not on PATH */ } }
}
const findPackage = (name, entry) => candidates.find((candidate) => fsSync.existsSync(path.join(candidate, name, entry)));
const realTypeScript = findPackage('typescript-language-server', 'lib/cli.mjs') && findPackage('typescript', 'lib/tsserver.js');
const realPyright = findPackage('pyright', 'langserver.index.js');
if (requireRealLsp) {
  const missing = [];
  if (!findPackage('typescript-language-server', 'lib/cli.mjs')) missing.push('typescript-language-server (lib/cli.mjs)');
  if (!findPackage('typescript', 'lib/tsserver.js')) missing.push('typescript (lib/tsserver.js)');
  if (!findPackage('pyright', 'langserver.index.js')) missing.push('pyright (langserver.index.js)');
  if (missing.length) {
    console.error(`not ok - CHATMCP_REQUIRE_REAL_LSP=1: the real language servers must run, but ${missing.join(', ')} not found in ${candidates.join(' or ') || '(no folder to look in: set CHATMCP_LSP_NODE_MODULES)'}`);
    process.exit(1);
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-lsp-tier-'));
const spawnLog = path.join(root, 'spawns.log');
const crashFile = path.join(root, 'crash-now');
process.env.CHATMCP_STUB_LSP_SPAWN_LOG = spawnLog;
const coldFile = path.join(root, 'cold-now');
process.env.CHATMCP_STUB_LSP_CRASH_FILE = crashFile;
process.env.CHATMCP_STUB_LSP_COLD_FILE = coldFile;
const spawns = () => (fsSync.existsSync(spawnLog) ? fsSync.readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length : 0);
const toClose = [];
let realServersRan = 'real typescript-language-server: skipped, real pyright: skipped';

async function makeProject(name) {
  const project = path.join(root, name, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'math.mjs'), 'export function calculateSum(a, b) {\n  return a + b;\n}\n');
  await fs.writeFile(path.join(project, 'src', 'entry.mjs'), "import { calculateSum } from './math.mjs';\nexport const result = calculateSum(1, 2);\n");
  await fs.writeFile(path.join(project, 'src', 'calc.py'), 'def total(a, b):\n    return a + b\n');
  await fs.writeFile(path.join(project, 'src', 'use.py'), 'from calc import total\n\nvalue = total(1, 2)\n');
  return project;
}

/** A bundle laid out like the staged runtime: <bundle>/runtimes/lsp/node_modules/{typescript-language-server,pyright,typescript}. */
async function stubBundle(name) {
  const modules = path.join(root, name, 'bundle', 'runtimes', 'lsp', 'node_modules');
  await fs.mkdir(path.join(modules, 'typescript-language-server', 'lib'), { recursive: true });
  await fs.mkdir(path.join(modules, 'pyright'), { recursive: true });
  await fs.mkdir(path.join(modules, 'typescript', 'lib'), { recursive: true });
  await fs.copyFile(STUB, path.join(modules, 'typescript-language-server', 'lib', 'cli.mjs'));
  await fs.copyFile(STUB, path.join(modules, 'pyright', 'langserver.index.js'));
  await fs.writeFile(path.join(modules, 'typescript', 'lib', 'tsserver.js'), '// not used by the stub\n');
  return path.join(root, name, 'bundle');
}

/** The production wiring of lib/assemble.mjs, reduced to the pieces this seam needs. */
async function production(name, bundleRoot, projectRoot = null) {
  const project = projectRoot ?? await makeProject(name);
  const state = path.join(root, name, 'state');
  const workspace = new StudioWorkspace({ manager: { workspace: project, secrets: [] }, directory: state });
  assert.equal('path' in workspace, false, 'the production workspace has no path property; this test must not give it one');
  const intelligence = new CodeIntelligence({ workspace, directory: path.join(state, 'index'), bundleRoot });
  const requests = { count: 0 };
  const lspRequest = intelligence.lspRequest.bind(intelligence);
  intelligence.lspRequest = async (...args) => { requests.count += 1; return lspRequest(...args); };
  const local = new LocalTools({ workspace, stateDirectory: path.join(state, 'local'), studioIntelligence: intelligence });
  toClose.push(intelligence);
  return { project, workspace, intelligence, local, requests };
}

const call = async (local, name, args) => {
  const result = await local.call(name, args);
  assert.equal(result.isError, false, `${name} failed: ${JSON.stringify(result).slice(0, 400)}`);
  return result.structuredContent;
};

try {
  // ---- 1. LSP answers survive on the production seam (TypeScript and Python routes) ---------------------------------------------
  {
    const { local, requests } = await production('stub-main', await stubBundle('stub-main'));
    const definition = await call(local, 'find_definition', { symbol: 'calculateSum', context_path: 'src/entry.mjs' });
    assert.equal(definition.tier, 'lsp', `find_definition tier (fallbackReason=${definition.fallbackReason})`);
    assert.equal(definition.fallbackReason, null);
    assert.equal(definition.fallbackUsed, false);
    assert.equal(definition.engine, 'typescript-language-server');
    assert.equal(definition.definitions[0].file, 'src/math.mjs');
    assert.equal(definition.definitions[0].line, 1);
    assert.equal(definition.provenance.tier, 'lsp');
    ok('find_definition (TypeScript route) answers from the LSP: tier lsp, fallbackReason null, definition in src/math.mjs');

    const references = await call(local, 'find_references', { symbol: 'calculateSum', path: 'src/entry.mjs' });
    assert.equal(references.tier, 'lsp', `find_references tier (fallbackReason=${references.fallbackReason})`);
    assert.equal(references.fallbackReason, null);
    assert.ok(references.provenance.engine === 'typescript-language-server');
    const files = new Set(references.references.map((reference) => reference.file));
    assert.ok(files.has('src/entry.mjs') && files.has('src/math.mjs'), `references span both files: ${[...files]}`);
    ok('find_references (TypeScript route) answers from the LSP: tier lsp, fallbackReason null, both files referenced');

    const pythonDefinition = await call(local, 'find_definition', { symbol: 'total', context_path: 'src/use.py' });
    assert.equal(pythonDefinition.tier, 'lsp', `python tier (fallbackReason=${pythonDefinition.fallbackReason})`);
    assert.equal(pythonDefinition.engine, 'pyright-langserver');
    assert.equal(pythonDefinition.definitions[0].file, 'src/calc.py');
    ok('find_definition (Python route) answers from the LSP: engine pyright-langserver, definition in src/calc.py');

    assert.ok(requests.count >= 3, 'the answers must have come through CodeIntelligence.lspRequest');
    assert.ok(spawns() >= 2, 'a language-server process per language must really have been started');
    ok(`language-server child processes were really spawned (${spawns()}) and queried (${requests.count} requests)`);
  }

  // ---- 2. a killed server heals; a server that keeps dying opens the breaker after 3 failures -------------------------------------
  {
    const before = spawns();
    const { local, intelligence, requests } = await production('stub-kill', await stubBundle('stub-kill'));
    const healthy = await call(local, 'find_definition', { symbol: 'calculateSum', context_path: 'src/entry.mjs' });
    assert.equal(healthy.tier, 'lsp');

    intelligence.lsp.get('typescript').child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const healed = await call(local, 'find_definition', { symbol: 'calculateSum', context_path: 'src/entry.mjs' });
    assert.equal(healed.tier, 'lsp', `after one kill the server must restart transparently (fallbackReason=${healed.fallbackReason})`);
    ok('one killed server is restarted and the next query is answered by the LSP again');

    await fs.writeFile(crashFile, 'die');
    const fallbacks = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await call(local, 'find_definition', { symbol: 'calculateSum', context_path: 'src/entry.mjs' });
      assert.equal(result.fallbackUsed, true, `call ${attempt} with a dying server must fall back`);
      assert.notEqual(result.tier, 'lsp');
      assert.ok(result.fallbackReason, 'the fallback reason must be reported');
      assert.equal(result.definitions[0].file, 'src/math.mjs', 'the heuristic tier still answers');
      fallbacks.push(result.fallbackReason);
    }
    const requestsAfterThree = requests.count;
    const spawnsAfterThree = spawns();
    const fourth = await call(local, 'find_definition', { symbol: 'calculateSum', context_path: 'src/entry.mjs' });
    assert.equal(fourth.fallbackUsed, true);
    assert.equal(requests.count, requestsAfterThree, 'with the breaker open no request may reach the language server');
    assert.equal(spawns(), spawnsAfterThree, 'with the breaker open no new server process may be spawned');
    await fs.rm(crashFile, { force: true });
    const stillOpen = await call(local, 'find_definition', { symbol: 'calculateSum', context_path: 'src/entry.mjs' });
    assert.equal(stillOpen.fallbackUsed, true, 'the breaker stays open for its cooldown even if the server would work again');
    assert.equal(requests.count, requestsAfterThree);
    ok(`killing the server on 3 calls opens the breaker: call 4 and 5 never reach it (${spawns() - before} spawns in this scenario, reason "${fallbacks[2]}")`);
  }

  // ---- 3. a failure while translating the response counts against the breaker (counter was reset before the throw) ---------------
  {
    const project = await makeProject('translate');
    const state = path.join(root, 'translate', 'state');
    const workspace = new StudioWorkspace({ manager: { workspace: project, secrets: [] }, directory: state });
    let lspCalls = 0;
    const malformed = {
      async lspRequest() {
        lspCalls += 1;
        return { result: [{ uri: 'not a uri', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }] };
      },
    };
    const engine = new CodeIntelligenceEngine({ workspace, studioIntelligence: malformed });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await engine.findDefinition({ symbol: 'calculateSum', contextPath: 'src/entry.mjs' });
      assert.equal(result.structured.fallbackUsed, true);
    }
    assert.equal(lspCalls, 3);
    await engine.findDefinition({ symbol: 'calculateSum', contextPath: 'src/entry.mjs' });
    assert.equal(lspCalls, 3, 'three failed translations must open the breaker; the 4th call must not reach the server');
    ok('three responses that cannot be translated open the breaker (the success counter is only reset after translation)');
  }

  // ---- 4. a cold server first answers with the import binding of the queried file; that is not the definition ----------------------
  // Measured with typescript-language-server 4.3.4 / typescript 5.9.3 outside ChatMCP: the first answer on a call site AND on the import
  // specifier is src/entry.mjs:1:10 (the alias), the declaration in src/math.mjs follows after about a second. The stub reproduces that
  // (CHATMCP_STUB_LSP_COLD_FILE). The binding must not outrank a declaration the heuristic tier found in another file, and must not vanish.
  {
    const { project, workspace, local } = await production('stub-cold', await stubBundle('stub-cold'));
    await fs.writeFile(path.join(project, 'src', 'multi.mjs'), "import {\n  calculateSum,\n  other,\n} from './math.mjs';\nexport const total = calculateSum(3, 4);\n");
    await fs.writeFile(path.join(project, 'src', 'ghost.mjs'), "import { ghost } from 'ghost-package';\nghost();\n");
    const definitions = (context, symbol) => call(local, 'find_definition', { symbol, context_path: context });
    const at = (result, file, line) => result.definitions.findIndex((definition) => definition.file === file && definition.line === line);

    // The parser's import pattern runs lazily up to the first `from '...'`: a side-effect import followed, lines later, by a re-export
    // makes one match over all lines in between, and a declaration inside that span must not be taken for an import binding.
    await fs.writeFile(path.join(project, 'src', 'spanning.mjs'), "import './setup.mjs';\nexport function uniqueName() {}\nexport { other } from './other.mjs';\n");
    const spanning = await definitions('src/spanning.mjs', 'uniqueName');
    assert.deepEqual([spanning.definitions[0].file, spanning.definitions[0].line, spanning.definitions[0].tier], ['src/spanning.mjs', 2, 'lsp'], JSON.stringify(spanning.definitions.map((d) => [d.file, d.line, d.tier, d.kind])));
    assert.equal(spanning.tier, 'lsp');
    ok('a declaration between a side-effect import and a later re-export is the LSP answer and stays first (never taken for an import binding)');

    await fs.writeFile(coldFile, 'binding');

    const declarationFile = await definitions('src/math.mjs', 'calculateSum');
    assert.equal(declarationFile.tier, 'lsp', `a name that the queried file declares is answered by the LSP (fallbackReason=${declarationFile.fallbackReason})`);
    assert.deepEqual([declarationFile.definitions[0].file, declarationFile.definitions[0].line, declarationFile.definitions[0].tier], ['src/math.mjs', 1, 'lsp']);
    ok('cold server, query from the declaring file: the LSP answer is the declaration and stays first (same file as the query, not an import)');

    const cold = await definitions('src/entry.mjs', 'calculateSum');
    const bindingAt = at(cold, 'src/entry.mjs', 1);
    assert.ok(bindingAt >= 0, `the LSP import binding must stay in the list: ${JSON.stringify(cold.definitions.map((d) => [d.file, d.line, d.tier]))}`);
    assert.equal(cold.definitions[bindingAt].tier, 'lsp');
    assert.deepEqual([cold.definitions[0].file, cold.definitions[0].line], ['src/math.mjs', 1], 'the declaration found by the heuristic tier is the first answer');
    assert.notEqual(cold.definitions[0].tier, 'lsp');
    assert.ok(bindingAt > 0, 'the binding ranks behind the declaration');
    assert.equal(cold.tier, cold.definitions[0].tier);
    assert.equal(cold.fallbackUsed, true, 'the first answer comes from the fallback tier, and the result says so');
    assert.equal(cold.fallbackReason, 'lsp_import_binding_only');
    ok('cold server answers with the import binding only: the heuristic declaration (src/math.mjs) ranks first, the binding stays listed behind it, the result says why');

    await fs.writeFile(coldFile, 'binding-then-declaration');
    const both = await definitions('src/entry.mjs', 'calculateSum');
    assert.deepEqual([both.definitions[0].file, both.definitions[0].line, both.definitions[0].tier], ['src/math.mjs', 1, 'lsp'], 'the LSP declaration is first');
    assert.equal(both.tier, 'lsp');
    assert.equal(both.fallbackUsed, false);
    const lastDeclaration = Math.max(...both.definitions.map((d, index) => (d.file === 'src/math.mjs' ? index : -1)));
    assert.ok(at(both, 'src/entry.mjs', 1) > lastDeclaration, 'the import binding ranks behind every declaration');
    ok('cold server answers binding then declaration: the LSP declaration is first, the binding ranks behind all declarations');

    await fs.writeFile(coldFile, 'binding');
    const multi = await definitions('src/multi.mjs', 'calculateSum');
    assert.deepEqual([multi.definitions[0].file, multi.definitions[0].line], ['src/math.mjs', 1]);
    assert.ok(at(multi, 'src/multi.mjs', 2) > 0, `the binding inside a multi-line import statement is recognised and kept: ${JSON.stringify(multi.definitions.map((d) => [d.file, d.line, d.tier]))}`);
    ok('an import binding on the second line of a multi-line import statement is demoted like a one-line one');

    const ghost = await definitions('src/ghost.mjs', 'ghost');
    assert.deepEqual(ghost.definitions.map((d) => [d.file, d.line, d.tier]), [['src/ghost.mjs', 1, 'lsp']], 'with no declaration anywhere the binding is still the answer');
    assert.equal(ghost.tier, 'lsp');
    ok('an import binding with no declaration in the workspace is still returned (demoted, never hidden)');

    const python = await definitions('src/use.py', 'total');
    assert.deepEqual([python.definitions[0].file, python.definitions[0].line], ['src/calc.py', 1]);
    assert.notEqual(python.definitions[0].tier, 'lsp');
    assert.ok(at(python, 'src/use.py', 1) > 0, 'the Python import binding stays listed behind the declaration');
    ok('the same holds for a Python "from calc import total" binding');
    await fs.rm(coldFile, { force: true });

    // Only the queried file's own import statement is an alias binding. An answer in another file stays what the server said, even when
    // it sits on a re-export (the engine does not second-guess where a server points).
    await fs.writeFile(path.join(project, 'src', 'barrel.mjs'), "export { calculateSum } from './math.mjs';\n");
    const barrel = { async lspRequest() { return { result: [{ uri: pathToFileURL(path.join(project, 'src', 'barrel.mjs')).href, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } } }] }; } };
    const elsewhere = await new CodeIntelligenceEngine({ workspace, studioIntelligence: barrel }).findDefinition({ symbol: 'calculateSum', contextPath: 'src/entry.mjs' });
    assert.deepEqual([elsewhere.structured.definitions[0].file, elsewhere.structured.definitions[0].tier, elsewhere.structured.definitions[0].kind], ['src/barrel.mjs', 'lsp', 'definition']);
    assert.equal(elsewhere.structured.tier, 'lsp');
    ok('an LSP answer in another file than the query (a re-export in a barrel) is not treated as the query file\'s import binding');
  }

  // ---- 5. the real language servers, for each one an npm install was found for (all of them when CHATMCP_REQUIRE_REAL_LSP=1) -----
  let ranTypeScript = false;
  let ranPyright = false;
  if (!realTypeScript && !realPyright) {
    console.log('  skip - no real typescript-language-server (with typescript/lib/tsserver.js) or pyright found; the protocol-faithful stub covered the production seam');
  } else {
    const bundle = path.join(root, 'real', 'bundle');
    const modules = path.join(bundle, 'runtimes', 'lsp', 'node_modules');
    await fs.mkdir(modules, { recursive: true });
    const link = (name, from) => fs.symlink(path.join(from, name), path.join(modules, name), 'junction');
    if (realTypeScript) { await link('typescript-language-server', findPackage('typescript-language-server', 'lib/cli.mjs')); await link('typescript', findPackage('typescript', 'lib/tsserver.js')); }
    if (realPyright) await link('pyright', findPackage('pyright', 'langserver.index.js'));
    const { local, intelligence } = await production('real', bundle);
    // The first request of a real server waits for it to load the project; warm it up outside the 4.5 s engine budget. "Answered" is not
    // "ready": a cold typescript-language-server first answers a call site with the import binding (src/entry.mjs, the alias) and only
    // a few seconds later with the declaration (src/math.mjs). Measured with typescript-language-server 4.3.4 / typescript 5.9.3 on the
    // same files outside ChatMCP, so this is the server and not the client. The warm-up therefore waits for the answer it will assert.
    const warmUp = async (language, file, line, column, expectedFile = null) => {
      const deadline = Date.now() + 90000;
      const locations = (value) => (Array.isArray(value) ? value : value ? [value] : []);
      for (;;) {
        const warm = await intelligence.lspRequest({ language, method: 'definition', file, line, column }).catch(() => null);
        const found = locations(warm?.result);
        if (found.length && (!expectedFile || found.some((item) => String(item.uri ?? item.targetUri).endsWith(expectedFile)))) return;
        assert.ok(Date.now() < deadline, `the real ${language} language server did not answer${expectedFile ? ' with ' + expectedFile : ''} within 90 s`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    if (realTypeScript) {
      // Before the warm-up, on the cold server: whatever it answers first (the import binding in src/entry.mjs, or nothing within the
      // engine's budget), the first definition is the declaration in src/math.mjs.
      const first = await call(local, 'find_definition', { symbol: 'calculateSum', context_path: 'src/entry.mjs' });
      assert.deepEqual([first.definitions[0].file, first.definitions[0].line], ['src/math.mjs', 1], `cold real server: ${JSON.stringify(first.definitions.map((d) => [d.file, d.line, d.tier, d.kind]))}`);
      const coldBinding = first.definitions.find((definition) => definition.kind === 'import-binding');
      console.log(`  note - the real server's cold answer ${coldBinding ? `was the import binding ${coldBinding.file}:${coldBinding.line}, ranked behind the declaration` : 'was not an import binding (already warm, or no answer within the engine budget)'}`);
      await warmUp('typescript', 'src/entry.mjs', 2, 29, '/src/math.mjs');
      const definition = await call(local, 'find_definition', { symbol: 'calculateSum', context_path: 'src/entry.mjs' });
      assert.equal(definition.tier, 'lsp', `real typescript-language-server (fallbackReason=${definition.fallbackReason})`);
      assert.equal(definition.fallbackReason, null);
      assert.equal(definition.definitions[0].file, 'src/math.mjs');
      const references = await call(local, 'find_references', { symbol: 'calculateSum', path: 'src/entry.mjs' });
      assert.equal(references.tier, 'lsp', `real typescript-language-server references (fallbackReason=${references.fallbackReason})`);
      ok('real typescript-language-server answers find_definition and find_references on the production seam');
      ranTypeScript = true;
    } else {
      console.log('  skip - real typescript-language-server: no typescript package with lib/tsserver.js (a global typescript 7 ships none)');
    }
    if (realPyright) {
      await warmUp('python', 'src/use.py', 3, 10);
      const python = await call(local, 'find_definition', { symbol: 'total', context_path: 'src/use.py' });
      assert.equal(python.tier, 'lsp', `real pyright (fallbackReason=${python.fallbackReason})`);
      assert.equal(python.fallbackReason, null);
      assert.equal(python.definitions[0].file, 'src/calc.py');
      ok('real pyright-langserver answers find_definition on the production seam');
      ranPyright = true;
    }
  }
  // The gate above guarantees both ran when they are required; this is the same fact, stated where a CI log is read.
  if (requireRealLsp) assert.ok(ranTypeScript && ranPyright, 'CHATMCP_REQUIRE_REAL_LSP=1: both real servers must have run');
  realServersRan = `real typescript-language-server: ${ranTypeScript ? 'ran' : 'skipped'}, real pyright: ${ranPyright ? 'ran' : 'skipped'}`;
} finally {
  for (const intelligence of toClose) intelligence.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

console.log(`PASS: ${checks} LSP tier checks (${realServersRan})`);
process.exit(0);
