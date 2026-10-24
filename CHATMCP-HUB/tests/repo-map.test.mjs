// The repository map says what it does (multi-agent-tools-18):
//   1. Python imports are edges: absolute (`import pkg.core`, `from pkg import util`) and relative (`from .core import x`, `from .. import core`) resolve to the .py or
//      __init__.py file inside the workspace; the standard library and third-party packages resolve to nothing; JS/TS resolution is what it was.
//   2. Files are ranked by PageRank over those edges (damping 0.85, iterated to convergence), not by counting importers: a file that only an important file imports outranks
//      a file that two leaves import. The filename boosts that belonged to this repository (index, main, server, agent, ...) are gone; focus files and the query still boost.
//   3. A file the repository's .gitignore excludes is not in the map: the list of source files comes from Git when the workspace is a repository (tracked and untracked files
//      that are not ignored), and from a walk of the tree when Git cannot answer.
//   4. The description of the tool says exactly this.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitRunner } from '../lib/git-runner.mjs';
import { CodeIntelligenceEngine, parseSourceStructure, registerCodeIntelligenceTools } from '../lib/code-intelligence.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { exactPagerank } from './support/pagerank-reference.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-repo-map-'));
let haveGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { haveGit = false; }
let numbered = 0;

/** A workspace of the files given ({ relative path: content }); `git` is false (no runner), true (a runner), or an object (the runner itself). */
async function project(files, { git = false, initGit = false } = {}) {
  numbered += 1;
  const directory = path.join(root, `project-${numbered}`);
  const state = path.join(root, `state-${numbered}`);
  await fs.mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  if (initGit) {
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: directory });
  }
  const workspace = new StudioWorkspace({ manager: { workspace: directory, secrets: [] }, directory: state });
  const runner = git === true ? new GitRunner({ workspace, hooksDirectory: path.join(state, 'no-hooks') }) : (git || null);
  const engine = new CodeIntelligenceEngine({ workspace, enablePythonAst: false, git: runner });
  return { directory, workspace, engine, git: runner };
}
const importsOf = (rel, source) => parseSourceStructure(source, rel).imports;
const targets = (engine, known, rel, source) => importsOf(rel, source).map((imp) => engine.resolveImportTargets(rel, imp, known));

try {
  // ----------------------------------------------------------------------------------------------------------------------- 1. Python imports
  {
    const files = {
      'pkg/__init__.py': '',
      'pkg/core.py': 'def core_fn():\n    return 1\n',
      'pkg/util.py': 'from .core import core_fn\n',
      'pkg/sub/__init__.py': '',
      'pkg/sub/mod.py': 'from .. import core\nfrom ..core import core_fn\nfrom pkg.core import core_fn\nimport pkg.util\n',
      'app.py': 'import os\nimport requests\nimport pkg.core\nfrom pkg import util\nfrom pkg.sub import mod\n',
      'scripts/helper.py': '',
      'scripts/run.py': 'import helper\n',
      'src/shop/__init__.py': '',
      'src/shop/cart.py': '',
      'tools/build.py': 'import shop.cart\nfrom shop import cart\n',
      'pkg/deep.py': 'from ... import nothing\nfrom .missing import x\n',
    };
    const { engine } = await project(files);
    const known = new Set(Object.keys(files));
    const of = (rel) => targets(engine, known, rel, files[rel]);
    assert.deepEqual(of('pkg/util.py'), [['pkg/core.py']], 'from .core import x');
    assert.deepEqual(of('pkg/sub/mod.py'), [['pkg/__init__.py', 'pkg/core.py'], ['pkg/core.py'], ['pkg/core.py'], ['pkg/util.py']],
      'from .. import core is the package and the submodule it names; from ..core, from pkg.core and import pkg.util are the files');
    assert.deepEqual(of('app.py'), [[], [], ['pkg/core.py'], ['pkg/__init__.py', 'pkg/util.py'], ['pkg/sub/__init__.py', 'pkg/sub/mod.py']],
      'the standard library and a third-party package are nothing; from pkg import util is the package and the submodule');
    assert.deepEqual(of('scripts/run.py'), [['scripts/helper.py']], 'the directory of the script is an import root');
    assert.deepEqual(of('tools/build.py'), [['src/shop/cart.py'], ['src/shop/__init__.py', 'src/shop/cart.py']], 'and so is src/');
    assert.deepEqual(of('pkg/deep.py'), [[], []], 'a relative import that goes above the workspace, or to a module that is not there, is nothing');
    // the nearest root wins: a module of the same name next to the importer shadows the one at the top
    const shadow = { 'util.py': '', 'tools/util.py': '', 'tools/run.py': 'import util\n' };
    const shadowed = new Set(Object.keys(shadow));
    assert.deepEqual(targets(engine, shadowed, 'tools/run.py', shadow['tools/run.py']), [['tools/util.py']]);
    // JS and TS resolve as they did
    const js = new Set(['src/math.mjs', 'src/entry.mjs', 'src/lib/index.ts', 'src/a.ts']);
    assert.deepEqual(engine.resolveImportTargets('src/entry.mjs', { specifier: './math.mjs' }, js), ['src/math.mjs']);
    assert.deepEqual(engine.resolveImportTargets('src/entry.mjs', { specifier: './lib' }, js), ['src/lib/index.ts']);
    assert.deepEqual(engine.resolveImportTargets('src/entry.mjs', { specifier: './a.js' }, js), ['src/a.ts'], 'TypeScript ESM: ./a.js is a.ts');
    assert.deepEqual(engine.resolveImportTargets('src/entry.mjs', { specifier: 'react' }, js), []);
    assert.deepEqual(engine.resolveImportTargets('src/entry.mjs', { specifier: './missing' }, js), []);
    assert.equal(engine.resolveImportSpecifier('src/entry.mjs', './math.mjs', js), 'src/math.mjs', 'the old single-target function still answers for JS');
    ok('Python imports: absolute and relative resolve to .py and __init__.py (a package and the submodules a `from` names), the standard library and the missing resolve to nothing, the nearest root wins, JS and TS are as they were');
  }
  {
    // the same edges feed the dependency graph tool: blast radius of a module, the packages that are not in the workspace, and a relative import that goes nowhere
    const files = { 'pkg/__init__.py': '', 'pkg/core.py': 'import os\ndef core_fn():\n    return 1\n', 'pkg/util.py': 'from .core import core_fn\nimport json\n', 'app.py': 'import pkg.util\nfrom pkg.core import core_fn\nimport requests.adapters\nfrom .nowhere import x\n',
      'pkg/selfish.py': 'from pkg import selfish\n' };
    const { engine } = await project(files);
    const impact = await engine.analyzeDependencies({ path: 'pkg/core.py' });
    assert.deepEqual([...impact.structured.directDependents].sort(), ['app.py', 'pkg/util.py']);
    assert.deepEqual(impact.structured.directDependencies, [], 'core.py imports only the standard library');
    assert.deepEqual([...impact.structured.transitiveBlastRadius].sort(), ['app.py', 'pkg/util.py']);
    const whole = await engine.analyzeDependencies({ path: '.' });
    assert.deepEqual([...whole.structured.externalPackages].sort(), ['json', 'os', 'requests'], 'a Python module that is not in the workspace is a package of its own, by its first component');
    assert.deepEqual(whole.structured.unresolvedImports.map((item) => [item.file, item.specifier]), [['app.py', '.nowhere']], 'only a relative import that resolves to nothing is a problem');
    const selfish = await engine.analyzeDependencies({ path: 'pkg/selfish.py' });
    assert.deepEqual(selfish.structured.directDependencies, ['pkg/__init__.py'], 'a module is never its own dependency');
    ok('dependency_graph: Python imports are edges (blast radius of a module), what is not in the workspace is an external package, a missing relative import is the only unresolved one, a module is not its own dependency');
  }

  // ----------------------------------------------------------------------------------------------------------------------- 2. the ranking
  {
    // five leaves import the hub, the hub imports core, two others import x: x has more importers than core, and core is imported by the file everybody imports
    const files = { 'hub.js': "import { core } from './core.js';\nexport const hub = core;\n", 'core.js': 'export const core = 1;\n', 'x.js': 'export const x = 1;\n',
      'p.js': "import { x } from './x.js';\nexport const p = x;\n", 'q.js': "import { x } from './x.js';\nexport const q = x;\n" };
    for (let i = 1; i <= 5; i += 1) files[`l${i}.js`] = `import { hub } from './hub.js';\nexport const l${i} = hub;\n`;
    const { engine } = await project(files);
    const map = await engine.generateRepoMap({ maxTokens: 4000 });
    const top = map.structured.topFiles;
    // core.js is imported by one file only, but that file is the hub, which five files import and which imports nothing else: all of the hub's rank goes to core.js, so core.js
    // outranks even the hub; x.js, imported by two leaves, comes after both. Counting importers (the hub 5, x.js 2, core.js 1) would have ordered them hub, x, core.
    assert.deepEqual(top.slice(0, 3).map((file) => file.path), ['core.js', 'hub.js', 'x.js'], 'ranked by who imports a file, not by how many do');
    assert.deepEqual(top.slice(0, 3).map((file) => file.importedByCount), [1, 5, 2], '(premise) the counts of importers are the other way round');
    const names = Object.keys(files);
    const edges = [...names.filter((n) => n.startsWith('l')).map((n) => [n, 'hub.js']), ['hub.js', 'core.js'], ['p.js', 'x.js'], ['q.js', 'x.js']];
    const exact = exactPagerank(names, edges);
    for (const file of top) assert.ok(Math.abs(file.pagerank - exact.get(file.path)) < 1e-6, `${file.path}: ${file.pagerank} against the exact ${exact.get(file.path)}`);
    for (const file of top) assert.ok(Math.abs(file.rankScore - exact.get(file.path) * names.length) < 0.01, `${file.path}: the score is the rank times the number of files (1.00 is an average file)`);
    ok('repo_map: ranked by PageRank over the import graph, equal to the exact solution within 1e-6, and not by the number of importers');
  }
  {
    // nothing is imported by anything: all alike, so the names decide, and a file called main, index or agent gets no push
    const files = Object.fromEntries(['agent.js', 'index.js', 'main.js', 'orchestrator.js', 'server.js', 'zeta.js', 'a.js', 'local-tools.js'].map((name) => [name, `export const v = '${name}';\n`]));
    const { engine } = await project(files);
    const map = await engine.generateRepoMap({ maxTokens: 4000 });
    assert.deepEqual(map.structured.topFiles.map((file) => file.path), Object.keys(files).sort(), 'alphabetical: no file name earns a boost');
    assert.deepEqual(new Set(map.structured.topFiles.map((file) => file.rankScore)).size, 1, 'and every file has the same score');
    // the boosts that were asked for still work
    const focused = await engine.generateRepoMap({ maxTokens: 4000, focusFiles: ['zeta.js'] });
    assert.equal(focused.structured.topFiles[0].path, 'zeta.js', 'a focus file comes first');
    const queried = await engine.generateRepoMap({ maxTokens: 4000, query: 'orchestr' });
    assert.equal(queried.structured.topFiles[0].path, 'orchestrator.js', 'a query that names a file brings it first');
    ok('repo_map: no boost for the names of this repository, and focus files and the query still rank first');
  }
  {
    // the Python graph: three modules import pkg.core (absolute, relative, and as `import pkg.core`); it comes first
    const files = { 'pkg/__init__.py': '', 'pkg/core.py': 'def X():\n    pass\n', 'pkg/a.py': 'from pkg.core import X\n', 'pkg/b.py': 'from .core import X\n', 'pkg/c.py': 'import pkg.core\n',
      'other.py': 'import os\n' };
    const { engine } = await project(files);
    const map = await engine.generateRepoMap({ maxTokens: 4000 });
    assert.equal(map.structured.topFiles[0].path, 'pkg/core.py');
    assert.equal(map.structured.topFiles[0].importedByCount, 3);
    assert.match(map.text, /## pkg\/core\.py \(\d+ lines, imported by 3 files/);
    ok('repo_map: a Python module imported three ways (absolute, relative, import pkg.core) has three importers and comes first');
  }

  // ----------------------------------------------------------------------------------------------------------------------- 3. .gitignore
  if (haveGit) {
    const files = { '.gitignore': 'generated/\n*.min.js\n', 'src/app.js': 'export const a = 1;\n', 'src/lib.min.js': 'export const m = 1;\n', 'generated/out.js': 'export const g = 1;\n',
      'keep/readme.js': 'export const k = 1;\n', '.hidden/x.js': 'export const h = 1;\n', '.github/script.js': 'export const w = 1;\n', 'node_modules/pkg/index.js': 'export const n = 1;\n',
      'src/gone.js': 'export const gone = 1;\n' };
    const { directory, engine, git } = await project(files, { git: true, initGit: true });
    execFileSync('git', ['add', 'src/app.js', 'src/gone.js', '.gitignore'], { cwd: directory });
    execFileSync('git', ['add', '-f', 'node_modules/pkg/index.js'], { cwd: directory });
    await fs.rm(path.join(directory, 'src', 'gone.js'));
    const listed = (await engine.listSourceFiles('.')).map((file) => file.relPath).sort();
    assert.deepEqual(listed, ['.github/script.js', 'keep/readme.js', 'src/app.js'],
      'tracked and untracked files that are not ignored; not the ignored directory, not *.min.js, not a tracked file that was deleted, not dot directories (but .github), not node_modules even when forced in');
    const map = await engine.generateRepoMap({ maxTokens: 4000 });
    assert.equal(map.structured.totalFiles, 3);
    assert.ok(!/generated|lib\.min|node_modules|gone\.js/.test(map.text), 'and none of them is in the map');
    assert.deepEqual((await engine.listSourceFiles('src')).map((file) => file.relPath), ['src/app.js'], 'a sub-folder is listed the same way');
    // Git cannot answer (no runner, a runner that fails, not a repository): the walk of the tree, as before
    const noGit = await project(files);
    const walked = (await noGit.engine.listSourceFiles('.')).map((file) => file.relPath).sort();
    assert.ok(walked.includes('generated/out.js') && walked.includes('src/lib.min.js'), 'with no Git the walk does not know the .gitignore');
    assert.ok(!walked.includes('.hidden/x.js') && !walked.includes('node_modules/pkg/index.js'), 'but it still skips dot directories and node_modules');
    const broken = await project(files, { git: { text: async () => { throw new Error('git blew up'); } } });
    assert.deepEqual((await broken.engine.listSourceFiles('.')).map((file) => file.relPath).sort(), walked, 'a runner that throws: the walk');
    const nonRepo = await project(files, { git: true });
    assert.deepEqual((await nonRepo.engine.listSourceFiles('.')).map((file) => file.relPath).sort(), walked, 'a folder that is not a repository: the walk');
    // the map the agent is given before its first request is made the same way: with the runner it leaves out the ignored files, without one it cannot know them
    const { injectRepoMapIntoInstructions } = await import('../lib/context-compaction.mjs');
    const withGit = await injectRepoMapIntoInstructions('', engine.workspace, { prompt: 'Look at the app.', git });
    assert.equal(withGit.injected, true);
    assert.ok(!/generated\/|lib\.min/.test(withGit.instructions) && /src\/app\.js/.test(withGit.instructions), 'the automatic map leaves out what .gitignore excludes');
    assert.equal(withGit.stats.totalFiles, 3);
    const withoutGit = await injectRepoMapIntoInstructions('', engine.workspace, { prompt: 'Look at the app.' });
    assert.ok(/generated\/out\.js/.test(withoutGit.instructions), 'and without the runner the walk includes it, as before');
    // a folder is named, not matched: one called a[1].js is not the pattern "a1.js", which would list a file that is outside it
    const bracket = await project({ 'a[1].js/x.js': 'export const x = 1;\n', 'a1.js': 'export const y = 1;\n' }, { git: true, initGit: true });
    assert.deepEqual((await bracket.engine.listSourceFiles('a[1].js')).map((file) => file.relPath), ['a[1].js/x.js'], 'the folder is a literal path for Git');
    assert.deepEqual((await bracket.engine.listSourceFiles('.')).map((file) => file.relPath).sort(), ['a1.js', 'a[1].js/x.js'].sort(), '(premise) both files are listed from the root');
    // the bound still holds, and a limited list says it is limited
    const bounded = await engine.listSourceFiles('.', { maxFiles: 2 });
    assert.equal(bounded.length, 2);
    assert.equal(bounded.scanTruncated, true);
    assert.ok(git, '(premise) the runner is the hardened one');
    ok('listSourceFiles: from Git when the workspace is a repository (ignored, deleted, hidden and node_modules files are not in it), the walk of the tree when Git cannot answer, and the bound on the number of files still applies');
  } else console.log('  skip - Git is not installed: the .gitignore checks were not run');

  // ----------------------------------------------------------------------------------------------------------------------- 3b. the agent hands its Git runner to the map it is given
  {
    const { AgentRunner } = await import('../lib/agent.mjs');
    const { directory, workspace } = await project({ 'src/a.mjs': 'export const a = 1;\n', 'src/ignored.mjs': 'export const i = 1;\n' });
    const asked = [];
    const git = { async text(args) { asked.push(args); return { code: 0, stdout: 'src/a.mjs\0', truncated: false, timedOut: false }; } };
    let locked = false;
    let map = '';
    const manager = {
      backend: 'local', workspace: directory, generation: 1, instanceId: 'repo-map-git', secrets: [], localTools: { git }, studio: workspace,
      state() { return { workspace: { path: directory }, generation: 1, instanceId: 'repo-map-git' }; },
      acquireTask() { if (locked) return false; locked = true; return true; },
      releaseTask() { locked = false; },
      async createAgentSession() {
        return { catalog: { tools: [{ name: 'local.read_file', originalName: 'read_file', server: 'local', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} },
          async close() {}, async callTool() { throw new Error('the model calls no tool'); } };
      },
    };
    const provider = {
      ready: () => true, snapshot: () => ({ provider: 'fixture', model: 'fixture' }),
      async respond({ input }) {
        map = String(input.find((item) => item.role === 'user').content[1]?.text ?? '');
        return { status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'Done.' }] }] };
      },
    };
    const runner = new AgentRunner({ manager, provider, taskDirectory: path.join(root, 'agent-tasks') });
    await runner.load();
    let timer;
    try {
      await runner.start({ prompt: 'Look at src/a.mjs.', maxSteps: 4 });
      const finish = await Promise.race([runner.context.done.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the repo map task timed out')), 15000); })]);
      assert.equal(finish.status, 'completed', finish.error);
    } finally { clearTimeout(timer); await runner.shutdown(); }
    assert.ok(asked.some((args) => args[0] === 'ls-files'), 'the agent asked Git, through the runner of the local tools, for the files of its map');
    assert.ok(/src\/a\.mjs/.test(map) && !/ignored\.mjs/.test(map), 'and the map it was given holds what Git listed');
    ok('the agent builds its first map from the Git runner of the local tools');
  }

  // ----------------------------------------------------------------------------------------------------------------------- 4. the description
  {
    const definitions = new Map();
    registerCodeIntelligenceTools((name, spec) => definitions.set(name, spec), { resolve: async () => root, root }, {});
    const { description } = definitions.get('repo_map');
    assert.match(description, /PageRank/);
    assert.doesNotMatch(description, /not PageRank/i);
    assert.match(description, /Python/);
    assert.match(description, /\.gitignore/);
    assert.match(description, /focus/i);
    ok('the description of repo_map says what is implemented: PageRank over the import graph, Python imports, .gitignore, focus files and a query');
  }
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

console.log(`\nPASS: ${checks} repo map checks`);
