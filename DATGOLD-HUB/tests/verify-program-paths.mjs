// Helper programs are started by an absolute path (lib/runtime.mjs: resolveProgram, programOnPath, systemProgram).
//
//  1. resolveProgram on real folders: absolute entries of PATH only, a regular file (a link to one counts, a folder does not), nothing below the workspace.
//  2. the Hub's own code in this process, in a workspace that holds files named like the helpers: the GitHub, Git, Docker, Python and language-server helpers,
//     the end of a process tree and the stdio servers start the program of the machine, or say that it is not installed.
//  3. the search variable of Windows: set by the Hub and by the command line for themselves, kept for helper programs, and given to a shell as the owner had it.
//  4. a real Hub process: the read tools in Read Only, in plan mode and in Review; and the command line when it ends a process tree.
// The parts about the search order are about Windows; the others run everywhere. The search variable is removed from this process first, so that each layer is seen alone.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { CodingWorktreeOrchestrator } from '../lib/coding-orchestrator.mjs';
import { LspProcess } from '../lib/studio-intelligence.mjs';
import { StudioSandbox } from '../lib/studio-sandbox.mjs';
import { windowsProcessTree } from '../lib/studio-terminal.mjs';
import { ShellRunner, killTree } from '../lib/shell-runner.mjs';
import * as runtime from '../lib/runtime.mjs';
import { resolveExecutable } from '../lib/mcp/client-manager.mjs';
import { HUB_ROOT, cleanEnvironment, connectModel, setMode, startHub, settledTask, waitFor } from './e2e/hub-process.mjs';
import { startMockModel } from './e2e/mock-model-server.mjs';
import { calls, say } from './e2e/scenarios.mjs';
import { clearMarks, givenVariables, makeMarkingProgram, startedPrograms } from './support/marking-program.mjs';
import { RAW_SERVER, missingReason, runtimeRoot } from './support/mcp-tools.mjs';

const WIN = process.platform === 'win32';
const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';
const dropVariable = (env) => { for (const key of Object.keys(env)) if (key.toUpperCase() === VARIABLE.toUpperCase()) delete env[key]; return env; };
dropVariable(process.env);

let checks = 0;
let part = 'the setup'; // what is being looked at: a failure says it, and how far the suite came
const suiteStarted = Date.now();
const seconds = () => ((Date.now() - suiteStarted) / 1000).toFixed(1);
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
/** The last line of a run that failed: the part, the message and the line of this file. */
function failed(error) {
  const line = /verify-program-paths[^/]*\.mjs:(\d+)/.exec(String(error?.stack ?? ''))?.[1] ?? '?';
  console.error(error?.stack ?? error);
  console.error(`FAIL: program-paths, in ${part} (line ${line}, ${seconds()} s, after ${checks} checks): ${String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 400)}`);
}
/** Ends what the suite started and removes its folder. (The promise form: fs.rmSync does not wait between its tries on Windows.) A folder that cannot be removed is said, and is not the result of the suite. */
async function cleanUp() {
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(); } catch { /* best effort */ } }
  await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch((error) => console.log(`  (the scratch folder stays: ${error.code ?? error.message})`));
}
/** The end of a run that nothing caught: said at once, then at most 10 s to clean up. */
let givingUp = false;
function giveUp(error, code) {
  if (givingUp) return;
  givingUp = true;
  failed(error);
  setTimeout(() => process.exit(code), 10_000);
  cleanUp().finally(() => process.exit(code));
}
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, (error) => giveUp(error, 1));
setTimeout(() => giveUp(new Error('the suite exceeded its own time budget'), 2), 165_000).unref();

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-program-paths-')));
const marks = path.join(scratch, 'marks');
const cleanups = [];
const here = path.dirname(fileURLToPath(import.meta.url));
const exe = (name) => (WIN ? `${name}.exe` : name);
const same = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
/** The programs of `folder` that were started since the last look, by name. */
const startedIn = (folder) => startedPrograms(marks).filter((file) => same(path.dirname(file), folder)).map((file) => path.basename(file));

const SKIPPED = new Error('skipped');
let failure = null;
try {
  const template = await makeMarkingProgram(scratch, marks, path.join(scratch, 'template', exe('template')));
  const put = (folder, ...names) => { fs.mkdirSync(folder, { recursive: true }); for (const name of names) { fs.copyFileSync(template, path.join(folder, exe(name))); if (!WIN) fs.chmodSync(path.join(folder, name), 0o755); } };
  const realPath = process.env.PATH ?? process.env.Path ?? '';
  const withPath = async (entries, work) => { process.env.PATH = entries.join(path.delimiter); try { return await work(); } finally { process.env.PATH = realPath; } };

  // ---------------------------------------------------------------------------------------------------------------- 1. resolveProgram
  {
    part = 'resolveProgram on real folders';
    const base = path.join(scratch, 'resolve');
    const [first, second, workspace] = ['first', 'second', 'workspace'].map((name) => path.join(base, name));
    put(second, 'tool');
    put(path.join(workspace, 'bin'), 'tool');
    fs.mkdirSync(path.join(first, exe('tool')), { recursive: true });
    const find = (entries, options) => withPath(entries, () => runtime.resolveProgram(exe('tool'), [], options));
    assert.equal(await find([first, second]), path.join(second, exe('tool')), 'a folder of that name is no program');
    const cwd = process.cwd();
    process.chdir(second);
    try {
      assert.equal(await find(['.', '', 'relative', path.join('..', 'second')]), null, 'an entry of PATH that is not absolute is not read');
      assert.equal(await find(['.', second]), path.join(second, exe('tool')));
      assert.equal(await find([`"${second}"`]), path.join(second, exe('tool')), 'an entry in quotes is the folder');
    } finally { process.chdir(cwd); }
    assert.equal(await find([path.join(workspace, 'bin'), second]), path.join(workspace, 'bin', exe('tool')), 'with no workspace known every absolute entry counts');
    assert.equal(await find([path.join(workspace, 'bin'), workspace, second], { outside: workspace }), path.join(second, exe('tool')), 'an entry below the workspace is not read');
    assert.equal(await find([path.join(workspace, 'bin')], { outside: workspace }), null);
    if (WIN) assert.equal(await find([path.join(workspace.toUpperCase(), 'BIN')], { outside: workspace.toLowerCase() }), null, 'whatever the case of its letters');
    // a folder or a file elsewhere that links into the workspace leads into the workspace
    const linked = path.join(base, 'linked');
    fs.symlinkSync(path.join(workspace, 'bin'), linked, WIN ? 'junction' : 'dir');
    assert.equal(await find([linked, second], { outside: workspace }), path.join(second, exe('tool')), 'a linked folder that leads into the workspace is not read');
    assert.equal(await find([linked], {}), path.join(linked, exe('tool')), 'a linked folder is read where no workspace is known');
    // and a link that stands in the workspace is in the workspace, wherever it leads, by the name the workspace was given and by its real one
    const within = path.join(workspace, 'leads-out');
    fs.symlinkSync(second, within, WIN ? 'junction' : 'dir');
    assert.equal(await find([within], { outside: workspace }), null, 'a linked folder of the workspace that leads out of it is not read');
    const alias = path.join(base, 'alias');
    fs.symlinkSync(workspace, alias, WIN ? 'junction' : 'dir');
    assert.equal(await find([path.join(alias, 'leads-out')], { outside: alias }), null);
    assert.equal(await find([path.join(workspace, 'leads-out')], { outside: alias }), null);
    assert.equal(await find([path.join(alias, 'bin')], { outside: workspace }), null);
    assert.equal(await find([within]), path.join(within, exe('tool')), '(control) it is read where no workspace is known');
    let links = 'file links not tried: this account may not make them';
    try {
      const tools = path.join(base, 'tools');
      fs.mkdirSync(tools);
      fs.symlinkSync(path.join(second, exe('tool')), path.join(tools, exe('tool')), 'file');
      assert.equal(await find([tools], { outside: workspace }), path.join(tools, exe('tool')), 'a link to a regular file is a program, under its own name');
      fs.rmSync(path.join(tools, exe('tool')));
      fs.symlinkSync(path.join(workspace, 'bin', exe('tool')), path.join(tools, exe('tool')), 'file');
      assert.equal(await find([tools], { outside: workspace }), null, 'a link to a file of the workspace is not');
      fs.rmSync(path.join(tools, exe('tool')));
      fs.symlinkSync(path.join(base, 'nowhere'), path.join(tools, exe('tool')), 'file');
      assert.equal(await find([tools]), null, 'and neither is a link to nothing');
      links = 'file links followed';
    } catch (error) { if (!['EPERM', 'ENOSYS'].includes(error.code)) throw error; }
    if (!WIN) { fs.chmodSync(path.join(second, 'tool'), 0o644); assert.equal(await find([second]), null, 'a file that may not be executed is no program'); fs.chmodSync(path.join(second, 'tool'), 0o755); }
    // A workspace that holds the person's own profile holds their programs too.
    assert.equal(await find([second], { outside: path.parse(scratch).root }), path.join(second, exe('tool')), 'a workspace above the home folder takes nothing away');
    assert.equal(await withPath([second], () => runtime.programOnPath('tool')), path.join(second, exe('tool')));
    assert.equal(await withPath([second], () => runtime.programOnPath('tool', { outside: second })), null);
    assert.equal(await withPath([second], () => runtime.programOnPath('no-such-tool')), null);
    assert.equal(runtime.systemProgram('taskkill.exe'), path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'));
    ok(`resolveProgram: absolute entries only, a regular file, nothing that is or leads below the workspace (${links}); programOnPath, systemProgram`);
  }

  // ---------------------------------------------------------------------------------------------------------------- 2. the Hub's own code, in this process
  const HELPERS = ['gh', 'git', 'docker', 'py', 'python', 'python3', 'taskkill', 'icacls', 'typescript-language-server', 'pyright-langserver', 'node', 'rg', 'bash', 'sh', 'powershell', 'cmd', 'whoami', 'where', 'npm', 'npx'];
  const bin = path.join(scratch, 'bin');
  put(bin, 'gh', 'docker');
  const gitOf = (cwd, ...args) => { const result = spawnSync('git', args, { cwd: cwd, env: cleanEnvironment(scratch), encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  function makeProject(name, names = HELPERS) {
    const root = path.join(scratch, name);
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib', 'a.py'), 'def f():\n    return 1\n');
    fs.writeFileSync(path.join(root, 'lib', 'b.ts'), 'export const answer: number = 42;\n');
    fs.writeFileSync(path.join(root, 'note.txt'), 'one\n');
    gitOf(root, 'init', '-q', '-b', 'main');
    for (const [key, value] of [['user.name', 'Tester'], ['user.email', 'tester@example.invalid'], ['core.autocrlf', 'false']]) gitOf(root, 'config', key, value);
    gitOf(root, 'add', '-A');
    gitOf(root, 'commit', '-q', '-m', 'first');
    put(root, ...names);
    return root;
  }
  part = 'the Hub in this process';
  // (ripgrep has a rule of its own, lib/ripgrep.mjs: an absolute entry of PATH counts wherever it is)
  const project = makeProject('project', HELPERS.filter((name) => name !== 'rg'));
  // The workspace itself is on PATH, and first: the machine's programs are taken all the same.
  const machine = [project, bin, ...realPath.split(path.delimiter)];
  const hub = new HubManager({ bundleRoot: HUB_ROOT, dataDirectory: path.join(scratch, 'in-process'), log: () => {} });
  cleanups.push(() => hub.shutdown());
  await hub.load(project);
  assembleStudio(hub, { bundleRoot: HUB_ROOT });
  await hub.startLocal(project);
  const tool = (name, args = {}) => hub.localTools.call(`local.${name}`, args, { taskId: '00000000-0000-4000-8000-000000000001' });
  const GITHUB = [['github_read', { action: 'pr_list' }], ['github_read', { action: 'issue_view', number: 1 }], ['github_action', { action: 'issue_create', title: 't' }], ['github_code_search', { query: 'x' }], ['github_workflow_runs', {}], ['github_workflow_status', { run_id: 1 }],
    ['github_job_logs', { run_id: 1 }], ['github_pr_review', { number: 1 }], ['github_rerun_failed', { run_id: 1 }], ['github_pr_merge', { number: 1 }], ['github_release_create', { tag: 'v1', notes: 'n' }]];
  const lastStarts = [];
  const publish = async () => {
    const orchestrator = new CodingWorktreeOrchestrator({
      manager: { workspace: project, secrets: [], studio: { gitRunner: { text: async (args) => ({ code: 0, stdout: args[0] === 'remote' ? 'https://github.com/o/r.git' : 'a'.repeat(40), stderr: '', truncated: false, timedOut: false }) } } },
      provider: {}, directory: path.join(scratch, 'orchestrator'), bundleRoot: HUB_ROOT,
    });
    orchestrator.jobs.set('run', { id: 'run-0000-0000', workspace: project, baseBranch: 'main', workers: [], integration: { status: 'ready_for_review', branch: 'b', sha: 'a'.repeat(40), merged: [] }, reviews: { integration: { token: 'b'.repeat(64), revision: 'a'.repeat(40) } } });
    return orchestrator.publish({ runId: 'run', confirmation: 'PUBLISH DRAFT PR', reviewToken: 'b'.repeat(64) });
  };
  part = 'GitHub, with gh on PATH';
  await withPath(machine, async () => {
    clearMarks(marks);
    for (const [name, args] of GITHUB) await tool(name, args);
    await publish().catch((error) => { if (!/gh_failed|GitHub/.test(`${error.code} ${error.message}`)) throw error; });
    assert.deepEqual(startedIn(project), [], 'no GitHub helper starts a file of the workspace');
    assert.deepEqual(startedIn(bin), Array(GITHUB.length + 1).fill(exe('gh')), 'each starts the gh of PATH, the draft pull request of the coding orchestrator included');
    if (WIN) assert.deepEqual(givenVariables(marks), ['1'], 'with the search variable set, for the programs gh starts by name');
    ok(`GitHub: ${GITHUB.length} calls and the draft pull request start the gh of PATH`);
  });
  // without the program on PATH (an empty folder is all there is on it, so that no real gh can answer): said so, nothing started
  const nothing = path.join(scratch, 'nothing');
  fs.mkdirSync(nothing);
  part = 'GitHub, without gh on PATH';
  await withPath([nothing], async () => {
    clearMarks(marks);
    const gone = [];
    for (const [name, args] of GITHUB) { const result = await tool(name, args); gone.push(result.isError === true && /missing_gh|gh_not_found/.test(JSON.stringify(result))); }
    assert.deepEqual(gone, Array(GITHUB.length).fill(true), 'each says that gh is not installed');
    await assert.rejects(publish(), /GitHub CLI gh is not installed/, 'and so does the draft pull request');
    assert.deepEqual(startedPrograms(marks), [], 'nothing was started');
    ok('GitHub: without gh on PATH every call says that it is not installed and starts nothing');
  });
  part = 'the end of a process tree';
  await withPath(machine, async () => {
    clearMarks(marks);
    const cwd = process.cwd();
    process.chdir(project);
    try {
      // the Hub's own folder can be the workspace too (the command line): the programs that end a process tree
      for (const end of [(child) => killTree(child), (child) => windowsProcessTree.kill(child.pid)]) {
        if (!WIN) break;
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
        const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
        await end(child);
        const gone = await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000, false).unref())]);
        if (!gone) child.kill();
        assert.equal(gone, true, 'the child has ended');
      }
      assert.deepEqual(startedIn(project), [], 'the end of a process tree starts no file of the folder it stands in');
      // Docker, as the sandboxed terminal starts it
      part = 'Docker';
      const sandbox = new StudioSandbox({ workspace: { requireRoot: () => project } });
      const status = await sandbox.status();
      assert.equal(status.ready, false, 'the stand-in prints nothing');
      const launched = await sandbox.launch({ command: 'true' });
      assert.equal(sandbox.stop(launched.name), true, 'a run that is going on is stopped');
      await new Promise((resolve) => { launched.child.once('close', resolve); launched.child.once('error', resolve); });
      await sandbox.close();
      assert.deepEqual([startedIn(project), startedIn(bin)], [[], [exe('docker'), exe('docker'), exe('docker')]], 'Docker is the docker of PATH, for its version, a run and the end of a run');
      if (WIN) assert.deepEqual(givenVariables(marks), ['1'], 'with the search variable set');
      // a run whose program has gone from PATH since is ended by the program that started it
      const pathNow = process.env.PATH;
      const last = new StudioSandbox({ workspace: { requireRoot: () => project }, spawnProcess: (file, args, options) => { lastStarts.push(file); return spawn(process.execPath, ['-e', args[0] === 'run' ? 'setTimeout(() => {}, 60000)' : ''], { ...options, stdio: 'ignore' }); } });
      const going = await last.launch({ command: 'true' });
      cleanups.push(() => going.child.kill());
      process.env.PATH = nothing;
      await last.status();
      assert.equal(last.stop(going.name), true);
      process.env.PATH = pathNow;
      await last.close();
      going.child.kill();
      assert.ok(lastStarts.length >= 2 && lastStarts.every((file) => file === path.join(bin, exe('docker'))), 'a run that goes on while Docker leaves PATH is ended by the docker that started it');
      // the textual diff of a review
      part = 'the diff of a review';
      fs.writeFileSync(path.join(project, 'note.txt'), 'one\n');
      const checkpoint = await hub.studio.checkpoint({ label: 'l', files: ['note.txt'] });
      fs.writeFileSync(path.join(project, 'note.txt'), 'two\n');
      const review = await hub.studio.review({ checkpointId: checkpoint.id, file: 'note.txt' });
      assert.match(review.changes[0].diff, /^\+two$/m, 'the review shows the diff Git made');
      assert.deepEqual(startedIn(project), [], 'the review starts no file of the folder');
      ok('the end of a process tree, Docker and the diff of a review start the program of the machine');
    } finally { process.chdir(cwd); }
    // Python and the language servers of a development build: the stand-ins of PATH, so that they are seen to be started at all
    part = 'Python, the language servers, Git and the search';
    clearMarks(marks);
    put(path.join(scratch, 'python'), 'py', 'python', 'python3', 'typescript-language-server', 'pyright-langserver');
    process.env.PATH = [project, path.join(scratch, 'python'), ...machine].join(path.delimiter);
    await hub.studioTools.call('studio.symbols', { query: 'f', limit: 5 }, { taskId: '00000000-0000-4000-8000-000000000001' });
    for (const [name, args] of [['symbols_search', { query: 'f' }], ['code_symbols', { query: 'f' }], ['find_definition', { symbol: 'f' }], ['find_references', { symbol: 'f' }], ['repo_map', {}], ['dependency_graph', {}], ['code_diagnostics', { path: 'lib/a.py' }],
      ['code_actions', { file: 'lib/b.ts', language: 'typescript', line: 1, column: 14 }], ['find_implementations', { file: 'lib/a.py', language: 'python', line: 1, column: 5 }], ['format_document', { file: 'lib/b.ts', language: 'typescript' }],
      ['git_status', {}], ['git_diff', {}], ['git_log', {}], ['search_files', { pattern: 'answer' }], ['find_files', { pattern: '*.py' }], ['worktrees_list', {}], ['git_conflict_inspect', {}], ['test_impact_analysis', {}]]) await tool(name, args);
    assert.deepEqual(startedIn(project), [], 'the code, Git and search tools start no file of the workspace');
    const helpers = new Set(startedIn(path.join(scratch, 'python')));
    const bundled = (file) => fs.existsSync(path.join(HUB_ROOT, 'runtimes', ...file));
    if (!bundled(['python', 'python.exe'])) assert.ok([exe('py'), exe('python'), exe('python3')].some((name) => helpers.has(name)), 'the Python of PATH was started');
    if (!bundled(['lsp', 'node_modules'])) assert.ok(helpers.has(exe('typescript-language-server')) && helpers.has(exe('pyright-langserver')), 'the language servers of PATH were started');
    if (WIN) assert.deepEqual(givenVariables(marks), ['1'], 'each with the search variable set');
    ok('Python, the language servers, Git and the search start the program of the machine');
    // A helper program looks for its own helpers: it is started with the search variable set (Windows), whatever this process has.
    if (WIN) {
      part = 'the variable of a language server';
      const probe = path.join(scratch, 'print-variable.mjs');
      const out = path.join(scratch, 'variable.txt');
      fs.writeFileSync(probe, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(out)}, String(process.env.${VARIABLE}));\n`);
      const server = new LspProcess({ root: project, exe: process.execPath, args: [probe] });
      await server.start().catch(() => {});
      server.close();
      assert.equal(await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8'), { timeoutMs: 10_000, intervalMs: 50, label: 'the language server to be started' }), '1', 'a language server is started with the search variable set');
      ok('a language server is started with the search variable set, so that what it starts by name is found on PATH');
    }
  });
  // a stdio server: the program of the launch record is the one that is started
  {
    part = 'the stdio servers';
    const missing = missingReason();
    if (missing) { console.log(`CHATMCP_TEST_SKIP: ${missing}`); throw SKIPPED; }
    put(path.join(scratch, 'servers'), 'server-tool');
    assert.equal(resolveExecutable('server-tool', { env: { PATH: ['.', path.join(scratch, 'servers')].join(path.delimiter), PATHEXT: '.EXE;.CMD' }, cwd: project }) !== null, true);
    fs.copyFileSync(template, path.join(project, exe('server-tool')));
    const cwd = process.cwd();
    process.chdir(project);
    try { assert.equal(resolveExecutable('server-tool', { env: { PATH: '.', PATHEXT: '.EXE;.CMD' }, cwd: project }), null, 'an entry of PATH that is not absolute is not read for a launch record either'); } finally { process.chdir(cwd); }
    const { McpClientManager } = await import('../lib/mcp/client-manager.mjs');
    const directory = path.join(scratch, 'mcp');
    fs.mkdirSync(directory, { recursive: true });
    const serverEnv = { ...process.env };
    for (const key of Object.keys(serverEnv)) if (key.toUpperCase() === 'PATH') delete serverEnv[key];
    const manager = new McpClientManager({ hubDirectory: directory, env: { ...serverEnv, PATH: [path.join(scratch, 'servers'), realPath].join(path.delimiter) }, runtimeRoots: [runtimeRoot()] });
    cleanups.push(() => manager.close());
    fs.writeFileSync(path.join(directory, 'mcp-servers.json'), JSON.stringify({ version: 1, servers: { probe: { transport: 'stdio', command: 'server-tool', args: [RAW_SERVER], cwd: project } } }));
    await manager.store.load();
    const record = await manager.launchRecord('probe');
    assert.ok(same(path.dirname(record.record.executable), path.join(scratch, 'servers')), 'the launch record names the program of PATH');
    await manager.approveLaunch('probe', { expectedFingerprint: record.fingerprint });
    clearMarks(marks);
    await manager.connect('probe').catch(() => {}); // the stand-in is no MCP server: what matters is which file was started
    await waitFor(() => startedPrograms(marks).length > 0, { timeoutMs: 15_000, intervalMs: 50, label: 'the server program to be started' });
    assert.deepEqual([startedIn(project), startedIn(path.join(scratch, 'servers')).length > 0], [[], true], 'a stdio server whose folder is the workspace is started from the file of its launch record');
    // a server whose file is a .cmd shim, in a folder that has a node of its own: the shim's node is the one of PATH, and the owner's value for the variable is kept
    if (WIN) {
      const told = path.join(scratch, 'shim.txt');
      fs.writeFileSync(path.join(scratch, 'servers', 'told.mjs'), `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(told)}, process.execPath + '|' + process.env.${VARIABLE});\n`);
      fs.writeFileSync(path.join(scratch, 'servers', 'shim-tool.cmd'), '@echo off\r\nnode "%~dp0told.mjs"\r\n');
      for (const [id, serverMap, expected] of [['shim', {}, '1'], ['shim-own', { [VARIABLE]: 'mine' }, 'mine']]) {
        await manager.store.save(id, { transport: 'stdio', command: 'shim-tool', args: [], cwd: project, env: serverMap });
        const shown = await manager.launchRecord(id);
        assert.deepEqual([shown.record.envKeys, shown.record.executable.toLowerCase().endsWith('shim-tool.cmd')], [Object.keys(serverMap), true], 'the launch record names the keys of the env map and nothing that is inherited');
        await manager.approveLaunch(id, { expectedFingerprint: shown.fingerprint });
        clearMarks(marks);
        fs.rmSync(told, { force: true });
        await manager.connect(id).catch(() => {});
        const [ran, variable] = (await waitFor(() => fs.existsSync(told) && fs.readFileSync(told, 'utf8'), { timeoutMs: 15_000, intervalMs: 50, label: 'the shim to be run' })).split('|');
        assert.deepEqual([startedIn(project), same(path.dirname(ran), project), variable], [[], false, expected], `${id}: the shim's node is the node of PATH`);
      }
    }
    ok('a stdio server is started from the file its approved launch record names, and a shim of it finds its program on PATH');
  }

  // ---------------------------------------------------------------------------------------------------------------- 3. the search variable
  if (WIN) {
    part = 'the search variable';
    const child = (script, env) => { const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: scratch, env: dropVariable({ ...process.env, ...env }), encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    const lib = pathToFileURL(path.join(HUB_ROOT, 'lib', 'runtime.mjs')).href;
    const start = `const { spawn } = await import('node:child_process'); await new Promise((resolve) => { const c = spawn('where', [], { cwd: ${JSON.stringify(project)}, stdio: 'ignore' }); c.once('error', resolve); c.once('close', resolve); });`;
    clearMarks(marks);
    child(start);
    assert.deepEqual(startedIn(project), ['where.exe'], '(control) Windows looks in the folder of the child first');
    clearMarks(marks);
    child(`const r = await import(${JSON.stringify(lib)}); r.searchProgramsOnPathOnly(); ${start}`);
    assert.deepEqual(startedIn(project), [], 'after searchProgramsOnPathOnly() it looks on PATH');
    const shells = (before) => child(`${before} const r = await import(${JSON.stringify(lib)}); r.searchProgramsOnPathOnly(); const s = await import(${JSON.stringify(pathToFileURL(path.join(HUB_ROOT, 'lib', 'shell-runner.mjs')).href)}); const shell = new s.ShellRunner({ workspace: { resolve: async () => ({ root: ${JSON.stringify(project)}, absolute: ${JSON.stringify(project)}, relative: '' }) } }); console.log(JSON.stringify([process.env.${VARIABLE}, shell.environment('bash').${VARIABLE} ?? null, shell.environment('powershell').${VARIABLE} ?? null, r.helperEnvironment({}).${VARIABLE}]));`);
    assert.equal(shells(''), JSON.stringify(['1', null, null, '1']), 'a shell gets the variable as the owner had it: not at all');
    assert.equal(shells(`process.env.${VARIABLE} = 'mine';`), JSON.stringify(['1', 'mine', 'mine', '1']), 'or with the owner\'s own value');
    // The Hub and the command line set it before they start anything (what the layers above already cover cannot show it).
    const source = (file) => fs.readFileSync(path.join(HUB_ROOT, file), 'utf8').replaceAll(String.fromCharCode(13), '');
    assert.match(source('hub.mjs'), /export async function main\([^\n]*\n  const options = parseArguments\(args, env\);\n  searchProgramsOnPathOnly\(\);/);
    assert.match(source('bin/chatmcp.mjs'), /\nsearchProgramsOnPathOnly\(\);[^\n]*\n\nconst code = await main\(/);
    assert.ok(ShellRunner && here);
    ok('the search variable: set by the process for itself, set for helper programs, and given to a shell as the owner had it');
  }

  // ---------------------------------------------------------------------------------------------------------------- 4. real processes
  if (WIN) {
    part = 'a real Hub process: its start';
    const trap = makeProject('hub-project');
    const results = [];
    const script = (ctx) => {
      if (ctx.turn === 0) return calls(...GITHUB.filter(([name]) => /read|workflow_runs|workflow_status|job_logs|pr_review/.test(name)));
      if (ctx.turn < 8) return calls(['mcp_call', { name: 'studio.symbols', arguments_json: '{"query":"f","limit":5}' }], ['symbols_search', { query: 'f' }], ['find_definition', { symbol: 'f' }], ['git_status', {}], ['code_actions', { file: 'lib/b.ts', language: 'typescript', line: 1, column: 14 }], ['find_implementations', { file: 'lib/a.py', language: 'python', line: 1, column: 5 }], ['find_files', { pattern: '*.py' }]);
      results.push(...ctx.results);
      return say('Read.');
    };
    const mock = await startMockModel({ scenario: 'read', scenarios: { read: script }, strict: true });
    cleanups.push(() => mock.close());
    const realHub = await startHub({ scratch: path.join(scratch, 'hub'), project: trap, env: { PATH: machine.slice(1).join(path.delimiter), Path: undefined, [VARIABLE]: undefined } });
    cleanups.push(() => realHub.stop());
    assert.notEqual(realHub.port, 3007);
    await connectModel(realHub, mock);
    for (const [label, mode, body] of [['Read Only', 'readonly', {}], ['plan mode', 'review', { planMode: true }], ['Review', 'review', {}]]) {
      part = `a real Hub process: ${label}`;
      await setMode(realHub, mode);
      clearMarks(marks);
      results.length = 0;
      const task = (await realHub.post('/api/tasks/start', { prompt: 'Read the project.', ...body })).task;
      const rest = await waitFor(async () => settledTask(await realHub.state(), task.id), { timeoutMs: 60_000, intervalMs: 50, label: 'the run to end' });
      assert.equal(rest.state, 'completed', `${label}: ${rest.error}`);
      assert.deepEqual(startedIn(trap), [], `${label}: no read tool starts a file of the workspace`);
      assert.deepEqual([startedIn(bin).length, results.length >= 13], [6, true], `${label}: the six GitHub reads start the gh of PATH, and the others answered`);
      assert.deepEqual((await realHub.state()).studio.permissions.recent.filter((row) => row.taskId === task.id && row.decision !== 'policy'), [], `${label}: nothing was asked`);
    }
    // a shell of the owner (a terminal, a hook) has the variable as the owner had it: not at all here
    part = 'a real Hub process: a hook';
    const dumped = path.join(scratch, 'hook-env.json');
    fs.writeFileSync(path.join(realHub.stateDir, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: process.execPath, args: [path.join(here, 'fixtures', 'hook-program.mjs'), JSON.stringify({ env: dumped })], timeout: 30 }] }] } }));
    const hooked = (await realHub.post('/api/tasks/start', { prompt: 'Read the project once more.' })).task;
    await waitFor(async () => settledTask(await realHub.state(), hooked.id), { timeoutMs: 60_000, intervalMs: 50, label: 'the hooked run to end' });
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(dumped, 'utf8'))).some((key) => key.toUpperCase() === VARIABLE.toUpperCase()), false, 'a hook is started without it');
    part = 'a real Hub process: a terminal';
    const session = await realHub.post('/api/studio/terminal/start', { command: `Write-Output "variable=[$env:${VARIABLE}]"` });
    const printed = await waitFor(async () => /variable=\[[^\]]*\]/.exec(JSON.stringify((await realHub.state()).studio.terminals.find((entry) => entry.id === session.id)?.logs ?? ''))?.[0], { timeoutMs: 30_000, intervalMs: 100, label: 'the terminal to answer' });
    assert.equal(printed, 'variable=[]', 'and so is a terminal');
    await realHub.stop();
    ok('a real Hub process: the read tools in Read Only, in plan mode and in Review start no file of the workspace');
    // the command line, whose folder is the workspace, ends an agent that hangs
    part = 'the command line and an agent that hangs';
    const cliProject = makeProject('cli-project');
    fs.mkdirSync(path.join(cliProject, '.chatmcp'));
    fs.writeFileSync(path.join(cliProject, '.chatmcp', 'acceptance.yml'), `version: 1\ncriteria:\n  - id: c\n    text: "c"\n    checks:\n      - run: "git --version"\n`);
    const hang = path.join(scratch, 'hang.mjs');
    // It listens on a pipe of its own for as long as it runs, ends when the pipe is told to, and by itself after two minutes.
    const pipe = `\\\\.\\pipe\\program-paths-${randomUUID()}`;
    const up = path.join(scratch, 'hang.up');
    fs.writeFileSync(hang, `import fs from 'node:fs';\nimport net from 'node:net';\nnet.createServer((socket) => socket.once('data', () => process.exit(0))).listen(${JSON.stringify(pipe)}, () => fs.writeFileSync(${JSON.stringify(up)}, 'up'));\nsetTimeout(() => process.exit(0), 120000);\n`);
    clearMarks(marks);
    const cliEnv = dropVariable(cleanEnvironment(scratch, { CHATMCP_STATE_DIR: path.join(scratch, 'cli-state') }));
    const cli = (...args) => spawnSync(process.execPath, [path.join(HUB_ROOT, 'bin', 'chatmcp.mjs'), 'verify', ...args], { cwd: cliProject, env: cliEnv, encoding: 'utf8', windowsHide: true, timeout: 90_000 });
    assert.equal(JSON.parse(cli('trust', '--json', '--sha256', JSON.parse(cli('trust', '--json').stdout).data.sha256).stdout).code, 'trusted');
    const ran = cli('exec', '--json', '--timeout', '4', '--', process.execPath.replaceAll(path.sep, '/'), hang.replaceAll(path.sep, '/'));
    assert.ok(fs.existsSync(up), `the agent ran: ${ran.error ?? ''} ${ran.stdout?.slice(0, 400)} ${ran.stderr?.slice(0, 400)}`);
    const still = await new Promise((resolve) => { const socket = net.connect(pipe, () => { socket.end('end'); resolve('running'); }); socket.once('error', (error) => resolve(error.code)); });
    assert.equal(still, 'ENOENT', 'the agent that hung has ended when the command line ends');
    assert.deepEqual(startedIn(cliProject), [], 'the command line starts no file of the folder it runs in');
    assert.match(ran.stdout, /agent_timed_out/);
    ok('the command line ends an agent that hangs with the program of the machine');
  }
} catch (error) { failure = { error, part }; }
if (givingUp) await new Promise(() => {}); // the run has been given up and said so: what fails after that is its clean-up
part = 'the clean-up';
await cleanUp();
if (failure?.error === SKIPPED) process.exit(0);
if (failure) { part = failure.part; failed(failure.error); process.exit(1); }
console.log(`PASS: ${checks} program-path checks`);
process.exit(0);
