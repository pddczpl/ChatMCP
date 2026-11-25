// Hostile plan mode, part 4 of 4: every way to act (P9 ac-12, docs/PLAN-MODE.md "Hostile scenarios"), on a real Hub process with the strict scripted model.
//
//  A. the tool catalogue. The list is the Hub's own (GET /api/catalog) and the functions it offers the model, never a list kept here: every entry needs a
//     decision in DECISIONS below (`runs` or `refused`), a tool without one fails the suite, and so does a decision about a tool that is gone. Each tool is
//     called with arguments that would really do something (a push has a remote, a command and a build leave a mark), in Review, Autonomous, Full Access and
//     Read Only, through its direct function and through mcp_call: a refused one is a `policy` row of the permission history whose reason names plan mode, a
//     call that runs is no row; every file, Git and the bare remote are unchanged, nothing was asked, no marked program was started.
//  B. an external MCP server: its tools, trusted, annotated read-only and allowed by the owner; its prompts and resources; nothing reaches the server.
//  C. children: spawn_agent and spawn_workflow are not offered and are refused when called in every spelling; agent_results runs; the owner's routes that
//     start workers answer 409 while the plan waits, and an agent the chat had started before it entered plan mode keeps to its own worktree.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runScenario } from './e2e/harness.mjs';
import { connectModel, waitFor } from './e2e/hub-process.mjs';
import { call, calls, say, toolText } from './e2e/scenarios.mjs';
import {
  decide, differences, fingerprint, git, hold, makeMarkingProgram, makeRepo, markers, pendingOf, permissions, processesNaming, resume, scriptedModel, start, tryMode, waitPlan, waitRest, writeFiles,
} from './e2e/plan-mode-rig.mjs';
import { HUB, missingReason, runtimeRoot } from './support/mcp-tools.mjs';

const WIN = process.platform === 'win32';
const SEAM = path.join(HUB, 'tests', 'fixtures', 'mcp-seam-server.mjs');
const MODES = [
  ['review', { mode: 'review' }],
  ['autonomous', { mode: 'autonomous' }],
  ['full-access', { mode: 'full-access', confirmation: 'FULL ACCESS' }],
  ['readonly', { mode: 'readonly', leaveFullAccess: true }],
];

/** The arguments of a call that would do its work if it were let through, for every tool the Hub has. `network` goes last: a Hub that let it run would leave the machine. */
function decisions({ mark }) {
  const FILE = { file: 'src/app.js', language: 'typescript', line: 1, column: 14 };
  return {
    // ---- reads and the Hub's own records: these run
    'local.repo_map': ['runs', {}], 'local.code_symbols': ['runs', { query: 'answer' }], 'local.find_definition': ['runs', { symbol: 'answer' }], 'local.find_references': ['runs', { symbol: 'answer' }],
    'local.dependency_graph': ['runs', {}], 'local.code_diagnostics': ['runs', { path: 'src/app.js' }], 'local.read_file': ['runs', { path: 'src/app.js' }], 'local.list_directory': ['runs', {}],
    'local.find_files': ['runs', { pattern: '*.js' }], 'local.search_files': ['runs', { pattern: 'answer' }], 'local.git_status': ['runs', {}], 'local.git_diff': ['runs', {}], 'local.git_log': ['runs', {}],
    'local.get_plan': ['runs', {}], 'local.update_plan': ['runs', { title: 'Plan', items: [{ text: 'Step', status: 'todo' }] }], 'local.symbols_search': ['runs', { query: 'answer' }],
    'local.symbols_references': ['runs', { symbol: 'answer' }], 'local.tasks_list': ['runs', {}], 'local.tasks_status': ['runs', { taskId: 'none' }], 'local.worktrees_list': ['runs', {}],
    'local.knowledge_search': ['runs', { query: 'x' }], 'local.knowledge_list': ['runs', {}], 'local.token_stats': ['runs', {}], 'local.token_restore': ['runs', { id: 'none' }], 'local.token_profile': ['runs', { mode: 'safe' }],
    'local.test_discover': ['runs', {}], 'local.test_results': ['runs', {}], 'local.test_coverage': ['runs', {}], 'local.git_conflict_inspect': ['runs', {}], 'local.build_detect': ['runs', {}],
    'local.test_impact_analysis': ['runs', {}], 'local.binary_inspect': ['runs', { path: 'src/app.js' }], 'local.skills_discover': ['runs', {}],
    // the language-server reads: code_actions and the two below have no way to write; the three edits are previews unless `apply` is given (see EXTRA)
    'local.code_actions': ['runs', FILE], 'local.find_implementations': ['runs', FILE], 'local.type_hierarchy': ['runs', FILE],
    'local.rename_symbol': ['runs', { ...FILE, new_name: 'theAnswer' }], 'local.format_document': ['runs', FILE], 'local.organize_imports': ['runs', FILE],
    // reads of something an approved call must have started first (a browser, a debugger): they run, and find nothing
    'local.browser_console': ['runs', {}], 'local.browser_network': ['runs', {}], 'local.screenshot_compare': ['runs', { before: 'a', after: 'b' }], 'local.visual_diff': ['runs', { before: 'a', after: 'b' }],
    'local.browser_dom_snapshot': ['runs', {}], 'local.browser_assert': ['runs', { selector: 'body' }], 'local.accessibility_audit': ['runs', {}],
    'local.debug_stack': ['runs', {}], 'local.debug_variables': ['runs', {}], 'local.debug_breakpoint': ['runs', { file: 'src/app.js', line: 1 }],
    // GitHub reads (a stand-in answers here)
    'local.github_read': ['runs', { action: 'pr_list' }], 'local.github_workflow_runs': ['runs', {}], 'local.github_workflow_status': ['runs', { run_id: 1 }], 'local.github_job_logs': ['runs', { run_id: 1 }], 'local.github_pr_review': ['runs', { number: 1 }],
    'studio.diff_check': ['runs', {}], 'studio.checks': ['runs', {}], 'studio.symbols': ['runs', { query: 'answer', limit: 5 }], 'studio.references': ['runs', { symbol: 'answer' }], 'studio.definitions': ['runs', { symbol: 'answer' }],
    'studio.index_status': ['runs', {}], 'studio.skills': ['runs', {}], 'studio.checkpoints': ['runs', {}], 'studio.checkpoint': ['runs', { label: 'plan' }], 'studio.review': ['runs', { checkpointId: 'none', file: 'src/app.js' }],
    // offered by the catalogue only where the Hub has no local tool for the same thing: decided all the same
    'studio.tree': ['runs', { directory: '', limit: 10 }, { optional: true }], 'studio.read': ['runs', { file: 'src/app.js', maxBytes: 100 }, { optional: true }], 'studio.search': ['runs', { query: 'answer', mode: 'text', limit: 5 }, { optional: true }],
    'studio.status': ['runs', {}, { optional: true }], 'studio.diff': ['runs', { file: '', staged: false }, { optional: true }], 'studio.plan_get': ['runs', {}, { optional: true }],
    'studio.plan_set': ['runs', { title: 'P', items: [] }, { optional: true }],
    // ---- files
    'local.write_file': ['refused', { path: 'plan-wrote.txt', content: 'x' }], 'local.edit_file': ['refused', { path: 'src/app.js', old_string: '42', new_string: '43' }], 'local.make_directory': ['refused', { path: 'made' }],
    'local.move_path': ['refused', { source: 'README.md', destination: 'MOVED.md' }], 'local.delete_path': ['refused', { path: 'README.md' }], 'local.files_write_batch': ['refused', { files: [{ path: 'b1.txt', content: 'x' }, { path: 'b2.txt', content: 'y' }] }],
    'local.files_apply_patch': ['refused', { path: 'src/app.js', old_text: '42', new_text: '44' }], 'local.knowledge_create': ['refused', { title: 'Note', content: 'x' }],
    // ---- Git
    'local.git_add': ['refused', { paths: ['dirty.txt'] }], 'local.git_commit': ['refused', { message: 'plan commit', all: true }], 'local.git_branch': ['refused', { action: 'create', name: 'plan-branch' }],
    'local.git_checkout': ['refused', { ref: 'feature' }], 'local.git_merge': ['refused', { branch: 'feature' }], 'local.git_push': ['refused', { remote: 'origin', branch: 'feature' }],
    'local.worktrees_create': ['refused', { path: 'wt', branch: 'plan-worktree' }], 'local.worktrees_remove': ['refused', { path: 'wt' }],
    // ---- programs
    'local.run_command': ['refused', { command: mark('run_command'), description: 'x' }], 'local.tasks_run': ['refused', { command: mark('tasks_run') }], 'local.tasks_cancel': ['refused', { taskId: 'none' }],
    'local.test_run': ['refused', { framework: 'npm' }], 'local.build_run': ['refused', { runner: 'npm' }], 'local.debug_start': ['refused', { program: 'debug-target.js' }], 'local.debug_continue': ['refused', {}], 'local.debug_step': ['refused', { mode: 'into' }],
    'local.debug_evaluate': ['refused', { expression: '1' }], 'local.debug_stop': ['refused', {}],
    'local.github_action': ['refused', { action: 'issue_create', title: 'plan' }], 'local.github_rerun_failed': ['refused', { run_id: 1 }], 'local.github_pr_merge': ['refused', { number: 1 }], 'local.github_release_create': ['refused', { tag: 'v0.0.1', notes: 'x' }],
    // ---- the browser
    'local.browser_launch': ['refused', {}], 'local.browser_navigate': ['refused', { url: 'http://localhost:9/' }], 'local.browser_click': ['refused', { selector: 'body' }], 'local.browser_fill': ['refused', { selector: 'input', text: 'x' }],
    'local.browser_screenshot': ['refused', {}], 'local.browser_close': ['refused', {}], 'local.screenshot_capture': ['refused', {}], 'local.browser_trace_start': ['refused', {}], 'local.browser_trace_stop': ['refused', {}], 'local.responsive_check': ['refused', {}],
    // ---- the network
    'local.web_fetch': ['refused', { url: 'https://plan-mode.invalid/' }, { network: true }], 'local.web_extract': ['refused', { url: 'https://plan-mode.invalid/' }, { network: true }], 'local.web_search': ['refused', { query: 'x' }, { network: true }],
    'local.docs_search': ['refused', { query: 'x' }, { network: true }], 'local.dependency_lookup': ['refused', { ecosystem: 'npm', name: 'x' }, { network: true }], 'local.github_code_search': ['refused', { query: 'x' }, { network: true }],
  };
}
// The functions the Hub answers itself, offered beside the tools of the catalogue. `refused` ones are not offered to a plan-mode run at all (section C calls them anyway).
const HOST_FUNCTIONS = {
  mcp_catalog: 'runs', mcp_describe: 'runs', mcp_call: 'the decision of the tool it names', mcp_capabilities: 'list runs, the rest is refused (section B)',
  exit_plan_mode: 'asks the owner', skill_load: 'runs', agent_results: 'runs', spawn_agent: 'refused', spawn_workflow: 'refused',
};
/** Calls that are one tool with other arguments: the same tool must be decided by what the call would do. */
const extra = ({ mark }) => [
  ['local.git_branch', { action: 'list' }, 'runs'], ['local.git_branch', { action: 'list', name: 'made-by-list', start_point: 'HEAD' }, 'runs'], ['local.git_branch', { action: 'switch', name: 'feature' }, 'refused'], ['local.git_branch', { action: 'create', name: 'x2', start_point: 'HEAD' }, 'refused'],
  ['local.git_commit', { message: 'm', run_hooks: true }, 'refused'], ['local.git_commit', { message: 'm', run_hooks: 'true' }, 'refused'],
  ['local.rename_symbol', { file: 'src/app.js', language: 'typescript', line: 1, column: 14, new_name: 'q', apply: true, expected_sha256: '0'.repeat(64) }, 'refused'],
  ['local.rename_symbol', { file: 'src/app.js', language: 'typescript', line: 1, column: 14, new_name: 'q', apply: 'true' }, 'refused'],
  ['local.format_document', { file: 'src/app.js', language: 'typescript', apply: true }, 'refused'], ['local.organize_imports', { file: 'src/app.js', language: 'typescript', apply: 'true' }, 'refused'],
  // A command that only reads is a command: plan mode does not depend on the command classifier.
  ['local.run_command', { command: 'git status', description: 'x' }, 'refused'], ['local.run_command', { command: 'echo hi', description: 'x' }, 'refused'], ['local.run_command', { command: 'git --version', description: 'x' }, 'refused'],
  ['local.tasks_run', { command: 'git status' }, 'refused'], ['local.run_command', { command: mark('powershell'), shell: 'powershell' }, 'refused'],
];

await runScenario({
  name: 'plan-mode-tools',
  summary: 'the whole tool catalogue in four gate modes, an external MCP server, children and the owner\'s worker routes',
  budgetMs: 170_000,
}, async (t) => {
  const missing = missingReason();
  if (missing) t.skip(missing);
  const since = [];
  const marks = markers(t.scratch);
  const shim = t.dir('shim');
  // A stand-in for the GitHub command line: no call of this suite can reach GitHub, whoever runs it.
  await makeMarkingProgram(t.scratch, marks.directory, path.join(shim, `gh${WIN ? '.exe' : ''}`));
  const env = { PATH: `${shim}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`, CHATMCP_MCP_RUNTIME_DIR: runtimeRoot() };
  if (WIN) env.Path = undefined;

  const project = makeRepo(t.scratch, 'project', {
    '.gitignore': 'ignored/\n',
    'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: { test: marks.command('test_run'), build: marks.command('build_run') } }),
    'debug-target.js': marks.source('debug_start'),
    'coverage/coverage-summary.json': '{"total":{"lines":{"pct":1}}}',
  });
  // A remote that a push would really reach, a Git hook a commit would really run, and an uncommitted file that a commit would really take.
  const origin = t.dir('origin.git');
  git(origin, t.scratch, 'init', '-q', '--bare', '-b', 'main');
  git(project, t.scratch, 'remote', 'add', 'origin', origin);
  fs.mkdirSync(path.join(project, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(project, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${marks.command('git-hook')}\n`, { mode: 0o755 });
  writeFiles(project, { 'dirty.txt': 'not committed\n' });
  const originRefs = () => git(origin, t.scratch, 'for-each-ref');

  const model = scriptedModel();
  const mock = await t.mock({ scenario: 'script', scenarios: { script: model.scenario } });
  const hub = await t.hub({ project, env });
  since.push(...await processesNaming(path.basename(t.scratch)));
  t.must(hub.port !== 3007, 'the test Hub never takes the owner\'s port');
  await connectModel(hub, mock);
  const post = (route, body) => hub.request('POST', route, body);

  // ---- the external server of section B, approved and allowed before anything else (its tools are in the catalogue from then on)
  const log = path.join(t.scratch, 'seam-requests.log');
  const wrapper = path.join(t.scratch, 'seam-logged.mjs');
  fs.writeFileSync(log, '');
  fs.writeFileSync(wrapper, `import fs from 'node:fs';\nawait import(${JSON.stringify(pathToFileURL(SEAM).href)});\nprocess.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(log)}, chunk));\n`);
  const seamMethods = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).map((message) => (message.method === 'tools/call' ? `tools/call ${message.params?.name}` : message.method))
    .filter((method) => ['prompts/get', 'resources/read'].includes(method) || method?.startsWith('tools/call'));
  const server = { transport: 'stdio', command: process.execPath, args: [wrapper, '--workdir', project], trust: { annotations: true }, timeouts: { connectMs: 25_000, callMs: 30_000 } };
  t.equal((await post('/api/mcp/server/upsert', { id: 'seam', server })).status, 200, 'the owner adds an MCP server that trusts its annotations');
  t.equal((await post('/api/mcp/server/approve-launch', { id: 'seam', expectedFingerprint: (await post('/api/mcp/server/launch-record', { id: 'seam' })).json.fingerprint })).status, 200, 'and approves its launch');
  t.equal((await post('/api/mcp/server/test', { id: 'seam' })).json?.ok, true, 'it connects');
  t.equal((await post('/api/mcp/server/approve-tools', { id: 'seam', expectedFingerprint: (await post('/api/mcp/server/tool-review', { id: 'seam' })).json.fingerprint })).status, 200, 'and approves its tools');
  t.equal((await post('/api/mcp/server/tool-policy', { id: 'seam', default: 'allow', tools: { echo: 'allow', write_note: 'allow', wipe_cache: 'allow' } })).status, 200, 'and allows every one of them without a question');

  // ---------------------------------------------------------------------------------------------------------------- A. the catalogue
  const catalogue = (await hub.get('/api/catalog')).json.tools;
  const internal = catalogue.filter((tool) => ['local', 'studio'].includes(tool.server));
  const DECISIONS = decisions({ mark: (label) => marks.command(label) });
  const undecided = internal.map((tool) => tool.name).filter((name) => !Object.hasOwn(DECISIONS, name));
  t.equal(undecided, [], `every one of the ${internal.length} tools of the catalogue has a plan-mode decision in this suite (a tool without one is a decision nobody made)`);
  const gone = Object.entries(DECISIONS).filter(([name, [, , options]]) => !options?.optional && !internal.some((tool) => tool.name === name)).map(([name]) => name);
  t.equal(gone, [], 'and every decision is about a tool the Hub has');

  const before = fingerprint(project, t.scratch);
  const order = internal.map((tool) => tool.name).sort((a, b) => Number(Boolean(DECISIONS[a]?.[2]?.network)) - Number(Boolean(DECISIONS[b]?.[2]?.network)));
  /** Batches of calls of one conversation, each a model turn; `rows` are the gate's history rows of that task after each batch. */
  async function sweep(name, list, { planMode = true } = {}) {
    const batches = [];
    for (let at = 0; at < list.length; at += 30) batches.push(list.slice(at, at + 30));
    const outcomes = [];
    const rowProblems = [];
    let done = 0;
    const collect = async (ctx) => {
      // The results of the last batch are the last ones of the conversation; its history rows are the ones the earlier batches did not have (the state
      // route shows the last 60 rows of the gate and a batch is 30 calls, so they are all there).
      const batch = batches[done];
      const fresh = (await permissions(hub)).recent.filter((row) => !seen.has(row.id));
      for (const row of fresh) seen.add(row.id);
      const expected = batch.filter((entry) => entry.decision === 'refused').map((entry) => entry.tool);
      if (JSON.stringify(fresh.map((row) => row.toolName)) !== JSON.stringify(expected)) rowProblems.push(`batch ${done}: expected rows ${expected.join(' ')}, got ${fresh.map((row) => row.toolName).join(' ')}`);
      for (const row of fresh) if (row.decision !== 'policy' || !/Plan mode/.test(row.reason)) rowProblems.push(`${row.toolName}: ${row.decision} ${row.reason.slice(0, 80)}`);
      const results = ctx.allResults.slice(-batch.length);
      batch.forEach((entry, index) => outcomes.push({ ...entry, result: String(results[index] ?? '(none)') }));
      done += 1;
    };
    const seen = new Set((await permissions(hub)).recent.map((row) => row.id));
    const turnOf = (batch) => calls(...batch.map((entry) => (entry.direct ? [entry.direct, entry.args] : ['mcp_call', { name: entry.tool, arguments_json: JSON.stringify(entry.args) }])));
    model.script(name, [turnOf(batches[0]), ...batches.slice(1).map((batch) => async (ctx) => { await collect(ctx); return turnOf(batch); }), async (ctx) => { await collect(ctx); return say('Swept.'); }]);
    const task = await start(hub, `[[${name}]] Look at the project and plan.`, { planMode });
    const rest = await waitRest(hub, task.id, { timeoutMs: 120_000 });
    return { outcomes, rest, task, rowProblems };
  }
  const refusedByPlan = (outcome) => /permission_denied/.test(outcome.result) && /Plan mode/.test(outcome.result);
  const ran = (outcome) => !/permission_denied|Plan mode|unknown_tool|unknown_function|invalid_arguments/.test(outcome.result) && outcome.result !== '(none)';
  const judged = (list) => list.filter((outcome) => (outcome.decision === 'refused' ? !refusedByPlan(outcome) : !ran(outcome))).map((outcome) => `${outcome.direct ?? `mcp_call ${outcome.tool}`} ${JSON.stringify(outcome.args).slice(0, 80)}: expected ${outcome.decision}, ${outcome.result.slice(0, 160)}`);

  let offered = [];
  for (const [mode, body] of MODES) {
    t.equal((await tryMode(hub, body)).status, 200, `the gate is in ${mode}`);
    marks.clear();
    // In Review a tool is called by its own function, in the other modes through mcp_call where that is the same call; the extra spellings in every mode.
    const viaDirect = mode === 'review' || mode === 'full-access';
    const list = [
      ...order.filter((name) => DECISIONS[name]).map((name) => ({ tool: name, args: DECISIONS[name][1], decision: DECISIONS[name][0], ...(viaDirect && name.startsWith('local.') ? { direct: name.slice('local.'.length) } : {}) })),
      ...extra({ mark: (label) => marks.command(label) }).map(([tool, args, decision]) => ({ tool, args, decision, direct: tool.slice('local.'.length) })),
    ];
    const { outcomes, rest, task, rowProblems } = await sweep(`sweep-${mode}`, list);
    offered = model.asked(`sweep-${mode}`)[0].tools;
    t.equal(outcomes.length, list.length, `${mode}: ${list.length} calls were made`);
    t.equal(judged(outcomes), [], `${mode}: ${list.filter((entry) => entry.decision === 'refused').length} calls are refused as plan mode, ${list.filter((entry) => entry.decision === 'runs').length} read calls run`);
    t.equal(rowProblems, [], `${mode}: the permission history has one policy row that names plan mode for every refused call, in order, and none for a call that ran`);
    t.equal(marks.seen().filter((label) => label !== 'gh'), [], `${mode}: no command, test, build, debugger or Git hook was started`);
    t.equal(await pendingOf(hub, task.id), [], `${mode}: nothing was asked`);
    t.equal(differences(before, fingerprint(project, t.scratch)), [], `${mode}: every file and Git are as they were`);
    t.equal(originRefs(), '', `${mode}: nothing was pushed`);
    t.equal([rest.state, rest.planOnly, rest.planApproval], ['completed', true, null], `${mode}: the task ends held read-only, with no approval`);
    // A Hub that let a write through fails here, before the network calls of the later modes.
    t.must(judged(outcomes).length === 0 && rowProblems.length === 0, `${mode}: go on`);
  }
  // The Hub connects an external server when a task starts, so its tools are in the catalogue from the first task on.
  const external = (await hub.get('/api/catalog')).json.tools.filter((tool) => !['local', 'studio'].includes(tool.server));
  const undecidedFunctions = offered.filter((name) => !Object.hasOwn(HOST_FUNCTIONS, name) && !Object.hasOwn(DECISIONS, `local.${name}`) && !external.some((tool) => name.includes(tool.originalName)));
  t.equal(undecidedFunctions, [], 'every function the model is offered is a decided tool, one of the Hub\'s own functions, or a tool of the external server');
  t.equal([offered.includes('exit_plan_mode'), offered.includes('spawn_agent'), offered.includes('spawn_workflow')], [true, false, false], 'a plan-mode run is offered exit_plan_mode and neither of the spawn functions');
  // The control of section A: the same sweep would mean nothing if these arguments were refused by everybody. Outside plan mode, in Review, a write asks.
  t.equal((await tryMode(hub, { mode: 'review' })).status, 200, 'back in Review');
  model.script('control', [call('write_file', DECISIONS['local.write_file'][1]), say('Control done.')]);
  const control = await start(hub, '[[control]] Write the file.');
  const asked = await waitFor(async () => (await pendingOf(hub, control.id))[0], { label: 'the question of the control' });
  t.equal([asked.toolName, asked.category], ['local.write_file', 'workspace_edit'], 'control: outside plan mode the same write is a question');
  await hub.post('/api/studio/permissions/decide', { id: asked.id, approved: false });
  await waitRest(hub, control.id);

  // ---- spellings of a write that are no tool of the catalogue
  const SPELLINGS = ['LOCAL.write_file', 'Local.Write_File', 'local.write_file ', ' local.write_file', 'local..write_file', 'local.local.write_file', 'studio.write', 'studio.save', 'studio.restore', 'Studio.plan_set', 'chatmcp.exit_plan_mode', 'chatmcp.spawn_agent', 'mcp.local.write_file', 'local.write_file\u0000', '__proto__', 'constructor', 'toString'];
  const writeArgs = JSON.stringify({ path: 'spelled.txt', content: 'x', planOnly: false });
  let spelled = [];
  model.script('spellings', [calls(...SPELLINGS.map((name) => ['mcp_call', { name, arguments_json: writeArgs }]), ...['WRITE_FILE', 'local.write_file', 'local_write_file'].map((name) => [name, { path: 'spelled.txt', content: 'x' }])), (ctx) => { spelled = ctx.allResults; return say('Tried.'); }]);
  const seenSpellings = new Set((await permissions(hub)).recent.map((row) => row.id));
  const spelling = await start(hub, '[[spellings]] Plan.', { planMode: true });
  await waitRest(hub, spelling.id);
  t.equal(spelled.length, SPELLINGS.length + 3, 'every spelling was answered');
  t.check(spelled.every((result) => /unknown_tool|unknown_function/.test(result)), 'a name that is not exactly a tool of the catalogue is no tool', spelled.find((result) => !/unknown_tool|unknown_function/.test(result)));
  t.equal((await permissions(hub)).recent.filter((row) => row.taskId === spelling.id && !seenSpellings.has(row.id)), [], 'and it does not reach the permission gate');
  t.equal(differences(before, fingerprint(project, t.scratch)), [], 'and nothing changed');

  // ---------------------------------------------------------------------------------------------------------------- B. the external server
  t.equal(external.map((tool) => tool.originalName).sort(), ['bad_params', 'crash', 'create_issue', 'echo', 'forbidden', 'images', 'wipe_cache', 'write_note'], 'the external server\'s tools are in the catalogue');
  for (const [mode, body] of MODES) {
    t.equal((await tryMode(hub, body)).status, 200, `the gate is in ${mode}`);
    fs.writeFileSync(log, '');
    let answers = [];
    const tools = external.map((tool) => ['mcp_call', { name: tool.name, arguments_json: '{"text":"x","title":"x"}' }]);
    const capability = (action, fields = {}) => ['mcp_capabilities', { action, server: 'seam', name: null, arguments_json: null, uri: null, filter: null, offset: 0, limit: 50, ...fields }];
    const capabilities = [capability('list'), capability('get_prompt', { name: 'greet', arguments_json: '{"name":"x"}' }), capability('read_resource', { uri: 'mem://seam/notes' })];
    model.script(`mcp-${mode}`, [calls(...tools), calls(...capabilities), (ctx) => { answers = ctx.allResults; return say('Tried.'); }]);
    const task = await start(hub, `[[mcp-${mode}]] Plan.`, { planMode: true });
    await waitRest(hub, task.id);
    const rows = (await permissions(hub)).recent.filter((row) => row.taskId === task.id);
    t.equal(rows.map((row) => [row.toolName, row.decision]), external.map((tool) => [tool.name, 'policy']), `${mode}: each of the ${external.length} external tools (allowed, trusted, readOnlyHint) is refused by the plan policy`);
    t.check(answers.slice(0, external.length).every((result) => /Plan mode/.test(result)), `${mode}: the model is told why`);
    const [list, prompt, resource] = answers.slice(external.length);
    t.check(/greet/.test(list) && !/plan_mode/.test(list), `${mode}: mcp_capabilities list (the Hub's own memory) runs`, String(list).slice(0, 200));
    t.check([prompt, resource].every((result) => /plan_mode/.test(result)), `${mode}: a prompt and a resource are not read`, `${prompt} ${resource}`.slice(0, 200));
    t.equal(seamMethods(), [], `${mode}: no tool call, prompt or resource request reached the server`);
  }
  t.equal((await tryMode(hub, { mode: 'review' })).status, 200, 'back in Review');
  // The control: outside plan mode the same server is reached.
  fs.writeFileSync(log, '');
  model.script('mcp-control', [call('mcp_call', { name: external.find((tool) => tool.originalName === 'echo').name, arguments_json: '{"text":"x"}' }), say('Reached.')]);
  const reached = await start(hub, '[[mcp-control]] Echo.');
  await waitRest(hub, reached.id);
  t.equal(seamMethods(), ['tools/call echo'], 'control: outside plan mode the owner\'s `allow` runs the tool unasked, so it was the plan policy that held it');
  t.equal(differences(before, fingerprint(project, t.scratch)), [], 'the workspace is unchanged (the server could have written note.txt in it)');

  // ---------------------------------------------------------------------------------------------------------------- C. children
  let childAnswers = [];
  const goal = 'Write child.txt in the project.';
  const workflow = { name: 'w', phases: [{ name: 'one', agents: [{ goal }] }] };
  model.script('children', [
    calls(['spawn_agent', { goal }], ['spawn_agent', { goal, dependsOn: [] }], ['spawn_workflow', workflow], ['spawn_agent', {}], ['spawn_workflow', {}], ['agent_results', {}],
      ['mcp_call', { name: 'chatmcp.spawn_agent', arguments_json: JSON.stringify({ goal }) }], ['mcp_call', { name: 'spawn_agent', arguments_json: JSON.stringify({ goal }) }], ['Spawn_Agent', { goal }]),
    (ctx) => { childAnswers = ctx.allResults; return call('exit_plan_mode', { plan: 'Spawn nobody.' }); },
  ]);
  const parent = await start(hub, '[[children]] Plan with helpers.', { planMode: true });
  const card = await waitPlan(hub, parent.id);
  t.check(childAnswers.slice(0, 5).every((result) => /plan_mode/.test(result)), 'spawn_agent and spawn_workflow are refused as plan mode, whatever their arguments', childAnswers.slice(0, 5).join('\n').slice(0, 400));
  t.check(childAnswers.slice(6).every((result) => /unknown_tool|unknown_function/.test(result)), 'and no other spelling of them is a function', childAnswers.slice(6).join('\n').slice(0, 400));
  const tasks = async () => (await hub.state()).agent.tasks;
  t.equal((await tasks()).filter((task) => task.parentTaskId), [], 'no agent was started');
  const worktreesBefore = git(project, t.scratch, 'worktree', 'list', '--porcelain');

  // ---- the owner's routes that start workers or change files, while the plan waits
  const busy = [
    ['/api/studio/delegates/research', { goal: 'x' }], ['/api/studio/delegates/orchestrate', { goal: 'x' }], ['/api/studio/dynamic-delegates/run', { goal: 'x' }], ['/api/studio/coding/run', { goal: 'x' }],
    ['/api/studio/terminal/start', {}], ['/api/studio/terminal/input', { id: 'x', text: marks.command('terminal') }], ['/api/studio/verify/run', { command: 'npm test' }], ['/api/studio/file/save', { file: 'src/app.js', content: 'x', expectedSha256: 'x' }],
    ['/api/studio/restore-checkpoint', { checkpointId: 'x' }], ['/api/studio/review/reject-created', { taskId: parent.id, file: 'README.md' }], ['/api/plugins/registry/install', { key: 'x' }], ['/api/mcp/server/tool-policy', { id: 'seam', default: 'allow' }],
    ['/api/studio/permissions/config', { mode: 'full-access', confirmation: 'FULL ACCESS' }], ['/api/workspace/select', { path: t.scratch }], ['/api/tasks/delete', { id: parent.id }],
  ];
  for (const [route, body] of busy) {
    const response = await post(route, body);
    t.equal(response.status, 409, `${route} while the plan waits: 409`);
  }
  const grant = await post('/api/studio/coding/check-grant', { workerId: 'w', checkId: 'c', confirmation: 'AUTHORIZE ISOLATED CHECK' });
  t.check([403, 404].includes(grant.status), 'a check grant has no worker to be about', `${grant.status} ${grant.text.slice(0, 120)}`);
  t.equal((await pendingOf(hub, parent.id)).map((item) => [item.id, item.category]), [[card.id, 'plan']], 'the plan request still waits, alone');
  t.equal((await decide(hub, { taskId: parent.id, revision: card.detail.revision, decision: 'request_changes', feedback: 'No.' })).status, 200, 'the owner asks for changes');
  await waitRest(hub, parent.id);
  t.equal(marks.seen().filter((label) => label !== 'gh'), [], 'nothing was started by any of it');
  t.equal(differences(before, fingerprint(project, t.scratch)), [], 'the workspace is unchanged');
  t.equal(git(project, t.scratch, 'worktree', 'list', '--porcelain'), worktreesBefore, 'and no worktree was made');

  // ---- an agent the chat started BEFORE it entered plan mode: documented (it is not a child of the plan-mode run), it keeps to its worktree, and the chat itself is held
  t.equal((await tryMode(hub, { mode: 'autonomous' })).status, 200, 'the gate is in Autonomous');
  const held = hold();
  let early = null;
  model.script('early', [call('spawn_agent', { goal: '[[early-child]] Write child.txt.' }), (ctx) => { early = ctx.allResults[0]; return say('The helper works.'); }]);
  model.script('early-child', [async () => { await held.promise; return call('write_file', { path: 'child.txt', content: 'child\n' }); }, say('Child done.')]);
  model.script('early-plan', [call('spawn_agent', { goal: 'Another.' }), call('write_file', { path: 'parent.txt', content: 'x' }), say('Held.')]);
  const chat = await start(hub, '[[early]] Start a helper.');
  await waitRest(hub, chat.id);
  const childId = JSON.parse(toolText(early)).taskId;
  await waitFor(() => model.requests('early-child') === 1, { timeoutMs: 40_000, label: 'the helper to ask its model' });
  await resume(hub, chat.id, '[[early-plan]] Now plan only.', { planMode: true });
  const planned = await waitRest(hub, chat.id);
  t.equal([planned.planOnly, (await permissions(hub)).recent.filter((row) => row.taskId === chat.id).map((row) => [row.toolName, row.decision])], [true, [['local.write_file', 'policy']]], 'the chat is held although its helper is at work: its own write is refused');
  t.equal((await tasks()).filter((task) => task.parentTaskId).map((task) => task.id), [childId], 'and it starts no other agent');
  held.release();
  const child = await waitRest(hub, childId);
  t.equal(child.planOnly, false, 'the helper was started before plan mode and is not held by it (docs/PLAN-MODE.md)');
  t.check(fs.existsSync(path.join(child.worktree, 'child.txt')), 'it writes in the worktree the Hub made for it');
  t.equal(differences(before, fingerprint(project, t.scratch, { ignore: ['.git/worktrees', '.git/refs/heads/chatmcp', '.git/logs/refs/heads/chatmcp', '.git/config', '.git/packed-refs'], refs: (line) => !line.startsWith('refs/heads/chatmcp/') })).filter((line) => !line.startsWith('changed .git/') && !line.startsWith('deleted .git/config') && !line.startsWith('deleted .git/packed-refs')), [], 'and never in the workspace of the chat');
  t.equal((await tryMode(hub, { mode: 'review' })).status, 200, 'back in Review');
  await hub.stop();

  // ---------------------------------------------------------------------------------------------------------------- nothing is left running
  await waitFor(async () => (await processesNaming(path.basename(t.scratch))).length === 0, { timeoutMs: 20_000, intervalMs: 400, label: 'every process of this suite to end' });
  t.check(since.length >= 1, 'the Hub was in the process table, with the time it was created, while it ran');
});
