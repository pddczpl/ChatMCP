// Hooks core (phase P1, task ext-5): the owner-level hooks.json, the Claude Code compatible schema and the command runner, on REAL child
// processes. Nothing between the runner and the operating system is replaced: every hook below is a program that this suite starts.
//
//   1. the schema subset: events, tool-name aliases, matchers, `if` conditions, validation, and the schema file against the loader
//   2. what a hook receives: the JSON on stdin, the working directory and a scrubbed environment (the parent's OPENAI_API_KEY is absent)
//   3. the exit-code contract: 0 parses stdout, 2 blocks with stderr as the reason, anything else does not block unless onFailure=block
//   4. a timeout and a cancel kill the whole process tree; stdout is capped at 64 KB and never parsed when it was cut
//   5. hostile output: escape sequences, control characters, secrets, prototype keys and fields this build does not act on
//   6. several hooks run in parallel and the strictest decision wins; Post events can give feedback but never block
//   7. Stop / TaskCompleted / SubagentStop are accepted and run by the runner (the agent loop asks them: tests/verify-hooks-lifecycle.mjs) and keep a retry counter that survives a hard kill
//   8. a project hooks file is inert until the owner approves its sha256 and inert again after a one-byte edit
//   9. an invalid owner file fails closed; shell forms; a hook that never reads stdin; the protected-path rule; the per-task ledger
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { delay } from '../lib/runtime.mjs';
import { ShellRunner } from '../lib/shell-runner.mjs';
import { isProtectedPath, mayExpandToProtected } from '../lib/protected-paths.mjs';
import { globMatches } from '../lib/glob-match.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import {
  BLOCK_RETRY_LIMIT, DEFAULT_TIMEOUT_SECONDS, HOOK_EVENTS, HookRunner, LIFECYCLE_EVENTS, MAX_STDOUT_BYTES, TOOL_EVENTS,
  claudePermissionMode, conditionMatches, matcherMatches, toolNames, validateHooksConfig,
} from '../lib/hooks.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
setTimeout(() => { console.error('FAIL: the hooks core suite exceeded its own time budget'); process.exit(2); }, 280_000).unref();

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASK = '3c2f9c78-436d-4b2e-bd8d-2e803d8695cf';
const SECRET = 'registered-secret-value-1234';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-hooks-core-'));
const hub = path.join(root, 'hub');
await fs.mkdir(hub, { recursive: true });
await fs.mkdir(path.join(root, 'work'), { recursive: true });
const work = await fs.realpath(path.join(root, 'work'));
const realDirectory = async (name) => { await fs.mkdir(path.join(root, name), { recursive: true }); return fs.realpath(path.join(root, name)); };

// ---- the hook program every case uses: tests/fixtures/hook-program.mjs behaves as the JSON in argv[2] says -------------------------------------
const HOOK = path.join(HUB, 'tests', 'fixtures', 'hook-program.mjs');

const handler = (spec = {}, extra = {}) => ({ type: 'command', command: process.execPath, args: [HOOK, JSON.stringify(spec)], ...extra });
const group = (matcher, ...hooks) => (matcher === undefined ? { hooks } : { matcher, hooks });
const config = (events) => ({ hooks: events });
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const ownerFile = path.join(hub, 'hooks.json');
const projectFile = (dir) => path.join(dir, '.chatmcp', 'hooks.json');
async function writeOwner(events) { await fs.writeFile(ownerFile, JSON.stringify(config(events), null, 2)); }
async function removeOwner() { await fs.rm(ownerFile, { force: true }); }
async function writeProject(dir, events, raw = null) {
  await fs.mkdir(path.join(dir, '.chatmcp'), { recursive: true });
  const text = raw ?? JSON.stringify(config(events), null, 2);
  await fs.writeFile(projectFile(dir), text);
  return sha256(Buffer.from(text));
}
let counter = 0;
const scratchFile = (label) => path.join(root, `${label}-${counter += 1}.txt`);
const readLines = (file) => (fsSync.existsSync(file) ? fsSync.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
// A process that was killed can stay visible for a moment: on Linux a zombie answers kill(pid, 0) until its parent or init collects it.
// So "alive" reads /proc where it can, and "gone" is waited for (a few seconds at most) instead of asserted at one instant.
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === 'linux') { try { return !/^\d+ \(.*\) Z /.test(fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } }
  return true;
};
const gone = async (...pids) => { try { await until(() => pids.every((pid) => !alive(pid)), 'the processes to be gone', 5000); return true; } catch { return false; } };
// every process a hook reported is remembered, so that a failing run does not leave a sleeping process behind
const strays = new Set();
const readPids = (text) => { const pids = JSON.parse(text); strays.add(pids.hook); strays.add(pids.grandchild); return pids; };
async function until(test, label, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await test(); if (value) return value; await delay(20); }
  throw new Error(`timed out waiting for ${label}`);
}

const runner = new HookRunner({ hubDirectory: hub, secrets: () => [SECRET], log: () => {} });
const base = { taskId: TASK, projectRoot: work, cwd: work, permissionMode: 'review', executionPolicy: 'host-review' };
const pre = (extra = {}) => runner.run({ ...base, event: 'PreToolUse', toolName: 'local.run_command', toolInput: { command: 'echo hi' }, toolUseId: 'tu-1', ...extra });
const post = (extra = {}) => runner.run({ ...base, event: 'PostToolUse', toolName: 'local.run_command', toolInput: { command: 'echo hi' }, toolResponse: { isError: false, content: [{ type: 'text', text: 'hi' }] }, toolUseId: 'tu-1', ...extra });

try {
  // ------------------------------------------------------------------------------------------------------------------ 1. the schema subset
  {
    assert.deepEqual([...HOOK_EVENTS], ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'TaskCompleted', 'SubagentStop']);
    assert.deepEqual([...TOOL_EVENTS], ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
    assert.deepEqual([...LIFECYCLE_EVENTS], ['Stop', 'TaskCompleted', 'SubagentStop']);
    assert.equal(MAX_STDOUT_BYTES, 64 * 1024, 'stdout is capped at 64 KB');
    assert.equal(DEFAULT_TIMEOUT_SECONDS, 600, "Claude Code's documented default for a command hook");
    assert.equal(BLOCK_RETRY_LIMIT, 8, "Claude Code's cap on consecutive Stop-hook continuations");
    ok('six events (three tool events, three lifecycle events), 64 KB stdout cap, 600 s default timeout, 8 consecutive blocks');

    assert.deepEqual(toolNames('local.run_command'), ['local.run_command', 'Bash']);
    assert.deepEqual(toolNames('local.edit_file'), ['local.edit_file', 'Edit']);
    assert.ok(toolNames('local.write_file').includes('Write') && toolNames('local.read_file').includes('Read'));
    assert.ok(toolNames('local.files_write_batch').includes('Write') && toolNames('local.files_apply_patch').includes('Edit'), 'the batch writers answer to Write and Edit');
    assert.deepEqual(toolNames('github.create_issue'), ['github.create_issue', 'mcp__github__create_issue'], 'an external server tool answers to mcp__server__tool');
    assert.deepEqual(toolNames('desktop-commander.read_file'), ['desktop-commander.read_file', 'mcp__desktop-commander__read_file']);
    assert.deepEqual(toolNames('studio.tree'), ['studio.tree']);
    assert.deepEqual(toolNames('local.git_status'), ['local.git_status']);
    ok('tool-name aliases: Bash, Edit, Write, Read, mcp__server__tool; a tool with no Claude Code counterpart keeps its own name');

    const matcherTable = [
      [undefined, 'local.git_status', true], ['', 'local.git_status', true], ['*', 'studio.tree', true],
      ['Bash', 'local.run_command', true], ['Bash', 'local.write_file', false], ['Bash', 'local.git_status', false],
      ['Edit|Write', 'local.write_file', true], ['Edit|Write', 'local.edit_file', true], ['Edit|Write', 'local.files_write_batch', true], ['Edit|Write', 'local.read_file', false],
      ['Edit, Write', 'local.edit_file', true], ['Read', 'local.read_file', true], ['Write', 'local.edit_file', false],
      ['local.run_command', 'local.run_command', true], ['local.write_file|local.edit_file', 'local.edit_file', true], ['local.write_file|local.edit_file', 'local.read_file', false],
      ['local.*', 'local.git_status', true], ['local.*', 'studio.tree', false],
      ['mcp__github__.*', 'github.create_issue', true], ['mcp__github', 'github.create_issue', false], ['mcp__.*__create.*', 'github.create_issue', true],
      ['^Bash$', 'local.run_command', true], ['^Bash$', 'local.run_command_x', false], ['Edit.*', 'local.edit_file', true],
    ];
    for (const [matcher, tool, expected] of matcherTable) assert.equal(matcherMatches(matcher, toolNames(tool)), expected, `matcher ${JSON.stringify(matcher)} on ${tool}`);
    ok(`${matcherTable.length} matcher cases: empty and * match everything, a plain list is exact, anything else is an unanchored regular expression, the Claude Code names reach the ChatMCP tools`);

    const conditionTable = [
      ['Bash(git *)', 'local.run_command', { command: 'git status' }, true], ['Bash(git *)', 'local.run_command', { command: 'npm test && git push' }, true],
      ['Bash(git *)', 'local.run_command', { command: 'FOO=1 git log' }, true], ['Bash(git *)', 'local.run_command', { command: 'echo $(git rev-parse HEAD)' }, true],
      ['Bash(git *)', 'local.run_command', { command: 'echo `git rev-parse HEAD`' }, true], ['Bash(git *)', 'local.run_command', { command: 'npm test' }, false],
      ['Bash(git *)', 'local.run_command', { command: 'gitk' }, false], ['Bash(npm test)', 'local.run_command', { command: 'npm test' }, true],
      ['Bash(npm test)', 'local.run_command', { command: 'npm test --silent' }, false], ['Bash', 'local.run_command', { command: 'anything' }, true],
      ['Bash', 'local.write_file', { path: 'a' }, false], ['Edit(*.ts)', 'local.edit_file', { path: 'src/a.ts' }, true], ['Edit(*.ts)', 'local.edit_file', { path: 'src/a.js' }, false],
      ['Edit(src/**)', 'local.edit_file', { path: 'src/deep/x.ts' }, true], ['Edit(src/**)', 'local.edit_file', { path: 'lib/x.ts' }, false],
      ['Write(.env*)', 'local.write_file', { path: '.env.local' }, true], ['Write(.env*)', 'local.write_file', { path: 'notes.txt' }, false],
      ['local.write_file(docs/*)', 'local.write_file', { path: 'docs/a.md' }, true],
      // what cannot be evaluated runs the hook: skipping would silently disable a deny hook
      ['WebFetch(domain:example.com)', 'local.run_command', { command: 'curl x' }, true], ['Bash(', 'local.run_command', { command: 'x' }, true],
      ['Read(src/**)', 'local.search_files', { pattern: 'x' }, false], ['Edit(*.ts)', 'local.edit_file', { path: 42 }, true],
    ];
    for (const [condition, tool, input, expected] of conditionTable) assert.equal(conditionMatches(condition, { toolName: tool, toolInput: input, workspace: work }), expected, `if ${condition} on ${tool} ${JSON.stringify(input)}`);
    ok(`${conditionTable.length} \`if\` cases: Bash(git *) sees every sub-command, file patterns are rooted, and a condition that cannot be evaluated lets the hook run`);

    assert.equal(claudePermissionMode({ mode: 'review', executionPolicy: 'host-review' }), 'default');
    assert.equal(claudePermissionMode({ mode: 'readonly', executionPolicy: 'host-review' }), 'plan');
    assert.equal(claudePermissionMode({ mode: 'autonomous', executionPolicy: 'host-review' }), 'acceptEdits');
    assert.equal(claudePermissionMode({ mode: 'autonomous', executionPolicy: 'full-access' }), 'bypassPermissions');
    assert.equal(claudePermissionMode({ mode: 'readonly', executionPolicy: 'full-access' }), 'plan', 'Read Only wins over Full Access, as in the gate');
    assert.equal(claudePermissionMode({ mode: 'weird' }), 'default');
    ok('permission_mode: review -> default, readonly -> plan, autonomous -> acceptEdits, Full Access -> bypassPermissions (Read Only still wins)');
  }

  // ------------------------------------------------------------------------------------------------------------------ 1b. validation and the schema file
  {
    const cmd = (extra = {}) => ({ type: 'command', command: 'node', ...extra });
    const wrap = (event, value) => ({ hooks: { [event]: value } });
    // [label, config, valid]  -- structural cases: the JSON Schema file and the loader must agree on every one of them
    const FIXTURES = [
      ['empty object', {}, true], ['empty hooks', { hooks: {} }, true], ['$schema key', { $schema: './schemas/hooks.schema.json', hooks: {} }, true],
      ['minimal command', wrap('PreToolUse', [{ matcher: 'Bash', hooks: [cmd()] }]), true], ['matcher omitted', wrap('PostToolUse', [{ hooks: [cmd()] }]), true],
      ['exec form with args', wrap('PreToolUse', [{ hooks: [cmd({ args: ['--flag', 'a b'] })] }]), true],
      ['every field', wrap('PreToolUse', [{ matcher: 'Edit|Write', hooks: [cmd({ args: [], shell: 'bash', timeout: 30, onFailure: 'block', if: 'Edit(*.ts)', async: false, asyncRewake: false, statusMessage: 'checking', once: false })] }]), true],
      ['Stop without matcher', wrap('Stop', [{ hooks: [cmd()] }]), true], ['TaskCompleted', wrap('TaskCompleted', [{ hooks: [cmd()] }]), true], ['SubagentStop', wrap('SubagentStop', [{ hooks: [cmd()] }]), true],
      ['Claude Code event this build does not fire', wrap('SessionStart', [{ hooks: [cmd()] }]), true],
      ['http handler (not supported)', wrap('PreToolUse', [{ hooks: [{ type: 'http', url: 'https://example.invalid/h' }] }]), true],
      ['prompt handler (not supported)', wrap('PreToolUse', [{ hooks: [{ type: 'prompt', prompt: 'is this safe?' }] }]), true],
      ['unknown event', wrap('PreToolUsse', [{ hooks: [cmd()] }]), false], ['groups not an array', wrap('PreToolUse', {}), false], ['group not an object', wrap('PreToolUse', ['x']), false],
      ['hooks array empty', wrap('PreToolUse', [{ matcher: 'x', hooks: [] }]), false], ['hooks missing', wrap('PreToolUse', [{ matcher: 'x' }]), false],
      ['command missing', wrap('PreToolUse', [{ hooks: [{ type: 'command' }] }]), false], ['command empty', wrap('PreToolUse', [{ hooks: [cmd({ command: '' })] }]), false],
      ['unknown handler type', wrap('PreToolUse', [{ hooks: [{ type: 'telnet', command: 'x' }] }]), false], ['type missing', wrap('PreToolUse', [{ hooks: [{ command: 'x' }] }]), false],
      ['args not strings', wrap('PreToolUse', [{ hooks: [cmd({ args: [1] })] }]), false], ['args not an array', wrap('PreToolUse', [{ hooks: [cmd({ args: 'x' })] }]), false],
      ['timeout 0', wrap('PreToolUse', [{ hooks: [cmd({ timeout: 0 })] }]), false], ['timeout 3601', wrap('PreToolUse', [{ hooks: [cmd({ timeout: 3601 })] }]), false],
      ['timeout 1.5', wrap('PreToolUse', [{ hooks: [cmd({ timeout: 1.5 })] }]), false], ['timeout as text', wrap('PreToolUse', [{ hooks: [cmd({ timeout: '5' })] }]), false],
      ['onFailure unknown', wrap('PreToolUse', [{ hooks: [cmd({ onFailure: 'explode' })] }]), false], ['shell unknown', wrap('PreToolUse', [{ hooks: [cmd({ shell: 'zsh' })] }]), false],
      ['a typo in a command handler field', wrap('PreToolUse', [{ hooks: [cmd({ onFailur: 'block' })] }]), false],
      ['if not a string', wrap('PreToolUse', [{ hooks: [cmd({ if: 3 })] }]), false], ['matcher not a string', wrap('PreToolUse', [{ matcher: 3, hooks: [cmd()] }]), false],
      ['extra key in a group', wrap('PreToolUse', [{ matcher: 'x', hooks: [cmd()], extra: 1 }]), false], ['top level array', [], false], ['top level text', 'hooks', false],
      ['hooks is an array', { hooks: [] }, false],
      ['seventeen handlers in a group', wrap('PreToolUse', [{ hooks: Array.from({ length: 17 }, () => cmd()) }]), false],
    ];
    const schema = JSON.parse(await fs.readFile(path.join(HUB, 'schemas', 'hooks.schema.json'), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    const refs = (value) => (value && typeof value === 'object' ? Object.values(value).flatMap((item) => (typeof item === 'string' && value.$ref === item ? [item] : refs(item))) : []);
    for (const ref of refs(schema)) assert.ok(ref.startsWith('#/$defs/') && schema.$defs[ref.slice(8)], `schema $ref ${ref} resolves`);
    /** The part of JSON Schema the file uses: enough to check the file against the loader without a dependency. */
    function schemaErrors(value, node = schema, at = '$') {
      if (node.$ref) return schemaErrors(value, schema.$defs[node.$ref.slice(8)], at);
      const errors = [];
      const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
      if (node.type) {
        const wanted = Array.isArray(node.type) ? node.type : [node.type];
        const fits = wanted.some((type) => type === kind || (type === 'number' && (kind === 'integer' || kind === 'number')));
        if (!fits) return [`${at}: expected ${wanted.join('|')}, got ${kind}`];
      }
      if ('const' in node && value !== node.const) errors.push(`${at}: must equal ${node.const}`);
      if (node.enum && !node.enum.includes(value)) errors.push(`${at}: not one of ${node.enum.join(', ')}`);
      if (typeof value === 'string') {
        if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${at}: too short`);
        if (node.maxLength !== undefined && value.length > node.maxLength) errors.push(`${at}: too long`);
      }
      if (typeof value === 'number') {
        if (node.minimum !== undefined && value < node.minimum) errors.push(`${at}: below ${node.minimum}`);
        if (node.maximum !== undefined && value > node.maximum) errors.push(`${at}: above ${node.maximum}`);
      }
      if (Array.isArray(value)) {
        if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${at}: fewer than ${node.minItems} items`);
        if (node.maxItems !== undefined && value.length > node.maxItems) errors.push(`${at}: more than ${node.maxItems} items`);
        if (node.items) value.forEach((item, index) => errors.push(...schemaErrors(item, node.items, `${at}[${index}]`)));
      }
      if (kind === 'object') {
        for (const key of node.required ?? []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
        for (const [key, item] of Object.entries(value)) {
          if (node.propertyNames?.enum && !node.propertyNames.enum.includes(key)) errors.push(`${at}: property name ${key} is not allowed`);
          if (node.properties && key in node.properties) errors.push(...schemaErrors(item, node.properties[key], `${at}.${key}`));
          else if (node.additionalProperties === false) errors.push(`${at}: unknown property ${key}`);
          else if (node.additionalProperties && typeof node.additionalProperties === 'object') errors.push(...schemaErrors(item, node.additionalProperties, `${at}.${key}`));
        }
      }
      if (node.if && !schemaErrors(value, node.if, at).length && node.then) errors.push(...schemaErrors(value, node.then, at));
      for (const part of node.allOf ?? []) errors.push(...schemaErrors(value, part, at));
      return errors;
    }
    for (const [label, candidate, valid] of FIXTURES) {
      const code = validateHooksConfig(candidate);
      const byFile = schemaErrors(candidate);
      assert.equal(code.ok, valid, `loader on "${label}": ${JSON.stringify(code.errors)}`);
      assert.equal(byFile.length === 0, valid, `schema file on "${label}": ${JSON.stringify(byFile)}`);
    }
    ok(`${FIXTURES.length} configurations: the loader (validateHooksConfig) and schemas/hooks.schema.json accept and refuse exactly the same ones`);

    const unsupported = validateHooksConfig(wrap('SessionStart', [{ hooks: [cmd()] }]));
    assert.ok(unsupported.ok && unsupported.warnings.some((line) => /SessionStart/.test(line) && /does not fire/.test(line)), 'an event this build does not fire is named in a warning');
    const asyncCfg = validateHooksConfig(wrap('PostToolUse', [{ hooks: [cmd({ async: true })] }]));
    assert.ok(asyncCfg.ok && asyncCfg.warnings.some((line) => /async/.test(line)), 'async is accepted for compatibility and runs synchronously, with a warning');
    const typeCfg = validateHooksConfig(wrap('PreToolUse', [{ hooks: [{ type: 'http', url: 'https://example.invalid' }, cmd()] }]));
    assert.ok(typeCfg.ok && typeCfg.warnings.some((line) => /http/.test(line)) && typeCfg.config.hooks.PreToolUse[0].hooks.length === 1, 'a handler type this build cannot run is dropped with a warning, the command beside it stays');
    const regexCfg = validateHooksConfig(wrap('PreToolUse', [{ matcher: '(', hooks: [cmd()] }]));
    assert.ok(!regexCfg.ok && regexCfg.errors.some((line) => /matcher/.test(line)), 'a matcher that is not a regular expression is an error, not an inert hook');
    const bashIf = validateHooksConfig(wrap('PreToolUse', [{ hooks: [cmd({ if: 'Bash(' })] }]));
    assert.ok(bashIf.ok && bashIf.warnings.some((line) => /if/.test(line)), 'an `if` that cannot be read is a warning; the hook then runs');
    ok('warnings: an event that is not fired, async, a handler type that cannot run, an unreadable `if`; errors: a matcher that is not a regular expression');
  }

  // ------------------------------------------------------------------------------------------------------------------ 1c. matching cannot be made slow
  {
    // The pattern of an `if` rule is the owner's, but the command it is tried on is chosen by the model, and the operands of a shell command are
    // looked at for protected names before the command is even judged. A glob turned into a regular expression backtracks without a bound,
    // so each case runs in a child process with a deadline: a regression fails here instead of freezing this suite (and the Hub).
    const timedCall = (module, name, args) => {
      const url = pathToFileURL(path.join(HUB, 'lib', module)).href;
      const code = `import { ${name} as f } from ${JSON.stringify(url)}; const args = [${args}]; const started = performance.now(); const result = f(...args); console.log(JSON.stringify({ result, ms: Math.round(performance.now() - started) }));`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      assert.notEqual(run.error?.code, 'ETIMEDOUT', `${name}(${args.slice(0, 70)}) did not finish in 8 s`);
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout);
    };
    const hostile = [
      ['hooks.mjs', 'conditionMatches', "'Bash(*a*a*a*a*a*a*b)', { toolName: 'local.run_command', toolInput: { command: 'a'.repeat(60000) }, workspace: '.' }", false, 'a 60,000 character command against six stars'],
      ['hooks.mjs', 'conditionMatches', "'Bash(git *)', { toolName: 'local.run_command', toolInput: { command: Array.from({ length: 30000 }, (_, i) => 'c' + i).join(';') }, workspace: '.' }", true, '30,000 sub-commands are more than can be judged in bounded time: the hook runs'],
      ['hooks.mjs', 'conditionMatches', "'Edit(**/*a*a*a*a*a*b)', { toolName: 'local.edit_file', toolInput: { path: 'a'.repeat(3000) }, workspace: '.' }", false, 'a 3,000 character path against a rule with a folder wildcard'],
      ['protected-paths.mjs', 'mayExpandToProtected', "'.chatmcp/' + '*'.repeat(4000) + 'x'", false, 'a long run of stars in the file segment of a command operand'],
      ['protected-paths.mjs', 'mayExpandToProtected', "'.' + '*'.repeat(4000) + 'x/hooks.json'", false, 'a long run of stars in the folder segment'],
      ['protected-paths.mjs', 'mayExpandToProtected', "'.chatmcp/' + '*'.repeat(4000)", true, 'stars that can stand for hooks.json still count'],
      ['protected-paths.mjs', 'mayExpandToProtected', "'.chatmcp/' + '[a-z]'.repeat(2000) + 'x'", false, 'a long run of bracket expressions'],
      // the trailing-dot and stream-suffix handling of a name: an end-anchored regular expression over a name the model chose is quadratic
      ['protected-paths.mjs', 'isProtectedPath', "'a/' + '.'.repeat(300000) + 'x'", false, 'a path whose last name is 300,000 dots and an x'],
      ['protected-paths.mjs', 'isProtectedPath', "'a/' + ' '.repeat(300000) + 'x'", false, 'a path whose last name is 300,000 spaces and an x'],
      ['protected-paths.mjs', 'isProtectedPath', "'a/' + ':'.repeat(300000) + '\\n'", false, 'a path whose last name is 300,000 colons and a line break'],
      ['protected-paths.mjs', 'mayExpandToProtected', "'.chatmcp/' + '.'.repeat(300000) + 'x'", false, 'a command operand with a 300,000 dot segment'],
      ['protected-paths.mjs', 'isProtectedPath', "'.chatmcp/hooks.json' + '.'.repeat(1000)", true, 'trailing dots on the hooks file name still name the hooks file'],
      ['protected-paths.mjs', 'isProtectedPath', "'.chatmcp/hooks.json::$DATA'", true, 'an NTFS stream suffix still names the hooks file'],
    ];
    for (const [module, name, args, expected, label] of hostile) {
      const outcome = timedCall(module, name, args);
      assert.equal(outcome.result, expected, label);
      assert.ok(outcome.ms < 1000, `${label}: ${outcome.ms} ms`);
    }
    ok(`${hostile.length} hostile inputs (60,000 characters against six stars, 30,000 sub-commands, 4,000 stars in a command operand, 300,000 dots, spaces or colons in a path ...) are judged in under a second each, in a child process with an 8 s deadline`);

    // the table matcher against the straightforward regular expression, on short random inputs
    const mulberry32 = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const reference = (glob, subject, { path: pathMode, ignoreCase }) => {
      let source = '';
      for (let index = 0; index < glob.length; index += 1) {
        const char = glob[index];
        if (char === '*' && pathMode && glob[index + 1] === '*') { if (glob[index + 2] === '/') { source += '(?:.*/)?'; index += 2; } else { source += '.*'; index += 1; } } else if (char === '*') source += pathMode ? '[^/]*' : '.*';
        else if (char === '?' && pathMode) source += '[^/]';
        else source += char.replace(/[.+^${}()|[\]\\?*]/g, '\\$&');
      }
      return new RegExp(`^${source}$`, ignoreCase ? 'is' : 's').test(subject);
    };
    const random = mulberry32(20261020);
    const pick = (alphabet, maximum) => Array.from({ length: Math.floor(random() * maximum) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    let compared = 0;
    for (const pathMode of [false, true]) {
      for (let round = 0; round < 15000; round += 1) {
        const glob = pick('aAb/*?.', 7);
        const subject = pick('aAbB/.', 8);
        const options = { path: pathMode, ignoreCase: round % 2 === 0 };
        assert.equal(globMatches(glob, subject, options), reference(glob, subject, options), `${JSON.stringify(glob)} on ${JSON.stringify(subject)} ${JSON.stringify(options)}`);
        compared += 1;
      }
    }
    for (const [glob, subject, options, expected] of [['', '', {}, true], ['', 'a', {}, false], ['*', '', {}, true], ['a*', 'a', {}, true], ['**/src/**', 'src/a.ts', { path: true }, true], ['**/src/**', 'x/y/src/a.ts', { path: true }, true], ['*.ts', 'a/b.ts', { path: true }, false], ['**/*.ts', 'a/b.ts', { path: true }, true], ['?x', '/x', { path: true }, false]]) {
      assert.equal(globMatches(glob, subject, options), expected, `${JSON.stringify(glob)} on ${JSON.stringify(subject)}`);
    }
    ok(`the table matcher (lib/glob-match.mjs) agrees with the regular expression it replaces on ${compared} random pattern / text pairs, in default and in path mode, with and without case folding`);
  }

  // ------------------------------------------------------------------------------------------------------------------ 2. what a hook receives
  {
    await removeOwner();
    const quiet = await pre();
    assert.equal(quiet.matched, 0);
    assert.equal(quiet.permission, null);
    assert.equal(quiet.blocked, false);
    assert.deepEqual(quiet.fired, []);
    assert.equal(fsSync.existsSync(path.join(hub, 'hooks')), false, 'with no hooks configured nothing is written');
    ok('no hooks.json and no project file: nothing runs and nothing is written to the Hub folder');

    const dump = scratchFile('dump'); const env = scratchFile('env'); const where = scratchFile('where');
    await writeOwner({ PreToolUse: [group('Bash', handler({ dump, env, where }))] });
    const outcome = await pre({ toolInput: { command: 'echo hi', description: 'say hi' } });
    assert.equal(outcome.matched, 1);
    const sent = JSON.parse(await fs.readFile(dump, 'utf8'));
    assert.equal(sent.session_id, TASK);
    assert.equal(sent.cwd, work);
    assert.equal(sent.permission_mode, 'default');
    assert.equal(sent.hook_event_name, 'PreToolUse');
    assert.equal(sent.tool_name, 'local.run_command');
    assert.deepEqual(sent.tool_input, { command: 'echo hi', description: 'say hi' });
    assert.equal(sent.tool_use_id, 'tu-1');
    assert.deepEqual(sent.tool_aliases, ['Bash']);
    assert.equal(sent.chatmcp_permission_mode, 'review');
    assert.equal(sent.chatmcp_execution_policy, 'host-review');
    assert.equal(await fs.realpath(await fs.readFile(where, 'utf8')), work, 'the hook runs in the workspace');
    const environment = JSON.parse(await fs.readFile(env, 'utf8'));
    assert.equal(environment.CLAUDE_PROJECT_DIR, work);
    assert.equal(environment.CHATMCP_PROJECT_DIR, work);
    assert.ok(Object.keys(environment).some((name) => name.toUpperCase() === 'PATH'), 'the ordinary environment (PATH) is still there');
    ok('stdin carries session_id, cwd, permission_mode, hook_event_name, tool_name, tool_input and tool_use_id; the hook runs in the workspace with CLAUDE_PROJECT_DIR set');

    const fileInput = scratchFile('dump');
    await writeOwner({ PreToolUse: [group('Write', handler({ dump: fileInput }))] });
    await pre({ toolName: 'local.write_file', toolInput: { path: 'src/a.txt', content: 'x' } });
    const written = JSON.parse(await fs.readFile(fileInput, 'utf8'));
    assert.equal(written.tool_input.file_path, path.resolve(work, 'src', 'a.txt'), 'Claude Code scripts read an absolute file_path');
    assert.equal(written.tool_input.path, 'src/a.txt', 'and the ChatMCP field stays beside it');
    for (const [mode, policy, expected] of [['readonly', 'host-review', 'plan'], ['autonomous', 'host-review', 'acceptEdits'], ['autonomous', 'full-access', 'bypassPermissions']]) {
      await pre({ toolName: 'local.write_file', toolInput: { path: 'a' }, permissionMode: mode, executionPolicy: policy });
      assert.equal(JSON.parse(await fs.readFile(fileInput, 'utf8')).permission_mode, expected);
    }
    ok('file tools also get an absolute file_path (Claude Code scripts read it); permission_mode follows the gate: plan, acceptEdits, bypassPermissions');

    // the exec form passes arguments exactly, and the project directory placeholder is expanded
    const argvFile = scratchFile('argv');
    await writeOwner({ PreToolUse: [group(undefined, { type: 'command', command: process.execPath, args: [HOOK, JSON.stringify({ argv: argvFile }), 'two words', 'quote"inside', '${CLAUDE_PROJECT_DIR}/x'] })] });
    await pre();
    assert.deepEqual(JSON.parse(await fs.readFile(argvFile, 'utf8')), ['two words', 'quote"inside', `${work}/x`]);
    ok('exec form: arguments reach the program exactly (spaces, quotes) and ${CLAUDE_PROJECT_DIR} is expanded');
  }

  // ------------------------------------------------------------------------------------------------------------------ 3. the exit-code contract
  {
    const one = async (spec, extra = {}) => {
      await writeOwner({ PreToolUse: [group(undefined, handler(spec, extra))] });
      return pre();
    };
    let outcome = await one({ exit: 0 });
    assert.equal(outcome.permission, null); assert.equal(outcome.blocked, false); assert.equal(outcome.fired[0].exitCode, 0); assert.equal(outcome.fired[0].decision, 'none');

    outcome = await one({ exit: 2, stderr: 'nope: that command is not allowed' });
    assert.equal(outcome.blocked, true); assert.equal(outcome.permission, 'deny'); assert.equal(outcome.reason, 'nope: that command is not allowed');
    assert.equal(outcome.fired[0].exitCode, 2); assert.equal(outcome.fired[0].decision, 'deny');
    ok('exit 2 blocks and its stderr is the reason');

    outcome = await one({ exit: 2, stderr: 'still blocked', stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } } });
    assert.equal(outcome.permission, 'deny', 'JSON on stdout cannot override exit 2');
    ok('exit 2 wins over a JSON allow on stdout');

    outcome = await one({ exit: 1, stderr: 'boom' });
    assert.equal(outcome.blocked, false); assert.equal(outcome.permission, null);
    assert.equal(outcome.fired[0].failure, 'exit'); assert.equal(outcome.fired[0].exitCode, 1);
    outcome = await one({ exit: 3, stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } } });
    assert.equal(outcome.blocked, false, 'the JSON of a failed hook (exit 3) is not read');
    ok('exit 1 and any other code do not block, and their stdout is not read');

    outcome = await one({ exit: 1, stderr: 'boom' }, { onFailure: 'block' });
    assert.equal(outcome.blocked, true); assert.equal(outcome.permission, 'deny'); assert.match(outcome.reason, /exit(?:ed)? (?:with )?(?:code )?1|exit 1/i);
    outcome = await one({ exit: 0 }, { onFailure: 'block' });
    assert.equal(outcome.blocked, false, 'onFailure=block changes nothing for a hook that succeeds');
    outcome = await one({ exit: 1 }, { onFailure: 'continue' });
    assert.equal(outcome.blocked, false);
    ok('onFailure=block turns exit 1 into a block; onFailure=continue (the default) does not');

    const decisions = [
      ['permissionDecision deny', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'database writes are off limits' } }, 'deny', 'database writes are off limits'],
      ['permissionDecision ask', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'looks risky' } }, 'ask', 'looks risky'],
      ['permissionDecision allow', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'fine' } }, 'allow', null],
      ['defer is read as ask', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } }, 'ask', null],
      ['decision block', { decision: 'block', reason: 'blocked by policy' }, 'deny', 'blocked by policy'],
      ['decision approve (the old spelling of allow)', { decision: 'approve' }, 'allow', null],
      ['continue false', { continue: false, stopReason: 'stop everything' }, 'deny', 'stop everything'],
      ['no decision', { systemMessage: 'just a note' }, null, null],
    ];
    for (const [label, stdout, permission, reason] of decisions) {
      outcome = await one({ stdout });
      assert.equal(outcome.permission, permission, label);
      assert.equal(outcome.blocked, permission === 'deny', `${label}: blocked`);
      if (reason) assert.equal(outcome.reason, reason, `${label}: reason`);
    }
    ok(`${decisions.length} JSON outputs on exit 0: permissionDecision allow / deny / ask (defer reads as ask), decision block, the old approve, continue:false`);

    outcome = await one({ stdout: { hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'deny' } } });
    assert.equal(outcome.permission, null, 'a hookSpecificOutput for another event is not read');
    assert.ok(outcome.ignored.some((item) => item.reason === 'wrong_event'));
    ok('hookSpecificOutput must name the event it answers');
  }

  // ------------------------------------------------------------------------------------------------------------------ 4. timeout, cancel, output size
  {
    // a hook that starts a grandchild and then sleeps for 30 s, with a one second limit
    const probe = async (onFailure) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const pids = scratchFile('pids');
        await writeOwner({ PreToolUse: [group(undefined, handler({ pids, sleepMs: 30_000 }, { timeout: 1, ...(onFailure ? { onFailure } : {}) }))] });
        const started = Date.now();
        const outcome = await pre();
        const elapsed = Date.now() - started;
        if (!fsSync.existsSync(pids)) continue; // the machine was too slow to start the hook inside one second: try again
        return { outcome, elapsed, ...readPids(await fs.readFile(pids, 'utf8')) };
      }
      throw new Error('the hook never started within its one second limit (3 attempts)');
    };
    const fast = await probe(null);
    assert.equal(fast.outcome.fired[0].timedOut, true);
    assert.equal(fast.outcome.fired[0].failure, 'timeout');
    assert.ok(fast.elapsed < 9000, `the one second limit took ${fast.elapsed} ms`);
    assert.ok(await gone(fast.hook), 'the hook process is gone');
    assert.ok(await gone(fast.grandchild), 'and so is the process it started');
    assert.equal(fast.outcome.blocked, false, 'a timeout alone does not block');
    const strict = await probe('block');
    assert.equal(strict.outcome.blocked, true); assert.equal(strict.outcome.permission, 'deny'); assert.match(strict.outcome.reason, /time/i);
    assert.ok(await gone(strict.hook, strict.grandchild), 'the second run left nothing behind either');
    ok('a 1 s timeout kills the hook and the process it started (2 live before the kill, 0 after); onFailure=block turns the timeout into a block');

    const pids = scratchFile('pids');
    await writeOwner({ PreToolUse: [group(undefined, handler({ pids, sleepMs: 30_000 }))] });
    const controller = new AbortController();
    const running = pre({ signal: controller.signal });
    const seen = readPids(await until(() => fsSync.existsSync(pids) && fsSync.readFileSync(pids, 'utf8'), 'the hook to report its processes'));
    assert.ok(alive(seen.hook) && alive(seen.grandchild), 'both processes are running before the cancel');
    controller.abort(Object.assign(new Error('task cancelled'), { code: 'cancelled' }));
    await assert.rejects(running, { code: 'cancelled' });
    assert.ok(await gone(seen.hook, seen.grandchild), 'a cancel kills the whole tree before run() returns');
    ok('a cancelled task kills the hook tree and run() rejects with the reason of the cancel');

    const second = scratchFile('pids');
    await writeOwner({ PreToolUse: [group(undefined, handler({ pids: second, sleepMs: 30_000 }))] });
    const closing = pre();
    const mine = readPids(await until(() => fsSync.existsSync(second) && fsSync.readFileSync(second, 'utf8'), 'the second hook'));
    await runner.close();
    await closing.catch(() => {});
    assert.ok(await gone(mine.hook, mine.grandchild), 'close() stops hooks that are still running');
    ok('close() (Hub shutdown) kills hooks that are still running');
  }
  {
    await writeOwner({ PreToolUse: [group(undefined, handler({ stdout: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}`, stdoutRepeat: { text: ' '.repeat(1024), times: 200 } }))] });
    const outcome = await pre();
    const record = outcome.fired[0];
    assert.equal(record.stdoutTruncated, true);
    assert.ok(record.stdoutBytes > 200 * 1024, `the whole output was counted (${record.stdoutBytes})`);
    assert.equal(record.stdoutKept, MAX_STDOUT_BYTES, 'and only 64 KB were kept');
    assert.equal(outcome.permission, null, 'a cut stdout is never parsed, even when what was kept is a valid deny');
    assert.ok(outcome.ignored.some((item) => item.reason === 'stdout_truncated'));
    ok('stdout above 64 KB is truncated to 64 KB, counted, and never parsed');

    await writeOwner({ PreToolUse: [group(undefined, handler({ exit: 2, stderrRepeat: { text: 'e'.repeat(1024), times: 300 } }))] });
    const loud = await pre();
    assert.equal(loud.blocked, true, 'exit 2 still blocks');
    assert.ok(loud.reason.length <= 4000, `the reason is capped (${loud.reason.length})`);
    assert.ok(loud.fired[0].stderrBytes >= 300 * 1024, `the whole stderr was counted (${loud.fired[0].stderrBytes})`);
    ok('a 300 KB stderr still blocks and the reason handed to the model is capped at 4000 characters');

    for (const [label, stdout] of [['truncated JSON', '{"hookSpecificOutput":'], ['text after the object', '{"decision":"block","reason":"x"} trailing'], ['an array', '[{"decision":"block"}]'], ['plain text', 'all good here']]) {
      await writeOwner({ PreToolUse: [group(undefined, handler({ stdout }))] });
      const result = await pre();
      assert.equal(result.blocked, false, label); assert.equal(result.permission, null, label);
      if (label !== 'plain text') assert.ok(result.ignored.some((item) => item.reason === 'invalid_json'), `${label} is reported as ignored`);
    }
    ok('stdout that is not one JSON object (truncated, trailing text, an array, plain text) is ignored; the call is not blocked');
  }

  // ------------------------------------------------------------------------------------------------------------------ 5. the environment is scrubbed
  {
    process.env.OPENAI_API_KEY = 'sk-hooks-core-test-0123456789abcdefghijklmnop';
    process.env.MY_SERVICE_PASSWORD = 'hunter2-hunter2';
    process.env.INNOCENT_NAME = `prefix-${SECRET}-suffix`;
    process.env.HARMLESS_SETTING = 'visible';
    const env = scratchFile('env');
    await writeOwner({ PreToolUse: [group(undefined, handler({ env }))] });
    await pre();
    const seen = JSON.parse(await fs.readFile(env, 'utf8'));
    assert.equal(seen.OPENAI_API_KEY, undefined, "the parent's OPENAI_API_KEY is invisible to the hook");
    assert.equal(seen.MY_SERVICE_PASSWORD, undefined);
    assert.equal(seen.INNOCENT_NAME, undefined, 'a variable that holds a registered secret is dropped whatever its name');
    assert.equal(seen.HARMLESS_SETTING, 'visible');
    assert.ok(!JSON.stringify(seen).includes('sk-hooks-core-test'), 'the key appears nowhere in the hook environment');
    delete process.env.OPENAI_API_KEY; delete process.env.MY_SERVICE_PASSWORD; delete process.env.INNOCENT_NAME; delete process.env.HARMLESS_SETTING;
    ok('the hook environment is scrubbed: OPENAI_API_KEY, a password variable and a variable holding a registered secret are gone, ordinary variables stay');
  }

  // ------------------------------------------------------------------------------------------------------------------ 6. hostile output
  {
    const dirty = `\u001b[31mred\u001b[0m \u001b]0;window title\u0007 \u001b[2J bell\u0007\u0000\u0008 kept ‮evil‬ done registered ${SECRET} and sk-abcdefghijklmnopqrstuvwxyz123456 end`;
    await writeOwner({ PreToolUse: [group(undefined, handler({ exit: 2, stderr: dirty }))] });
    const outcome = await pre();
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(outcome.reason, /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/, 'no escape or control character reaches the model or the UI');
    assert.match(outcome.reason, /red/); assert.match(outcome.reason, /kept/); assert.match(outcome.reason, /done/);
    assert.doesNotMatch(outcome.reason, /\[\d+(?:;\d+)*[A-Za-z]/, 'the parameters of a colour or cursor sequence do not stay behind as text');
    assert.doesNotMatch(outcome.reason, /window title/, 'the text of a terminal-title sequence is gone');
    assert.ok(!outcome.reason.includes(SECRET), 'a registered secret is masked');
    assert.ok(!outcome.reason.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), 'and so is a token-shaped string');
    assert.ok(!JSON.stringify(outcome).includes(SECRET), 'the secret is nowhere in the outcome');
    ok('hostile stderr: ANSI sequences, OSC titles, control and bidi characters are stripped; registered and token-shaped secrets are masked');

    const poison = '{"__proto__":{"polluted":true},"permissionMode":"bypassPermissions","permissions":{"allow":["*"]},"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"rm -rf /"},"updatedPermissions":[{"mode":"bypassPermissions"}],"__proto__":{"x":1},"permissionMode":"full-access"}}';
    await writeOwner({ PreToolUse: [group(undefined, handler({ stdout: poison }))] });
    const result = await pre();
    assert.equal(result.permission, 'allow', 'the one field this build reads is read');
    assert.equal({}.polluted, undefined); assert.equal({}.x, undefined); assert.equal(Object.prototype.polluted, undefined);
    assert.deepEqual(Object.keys(result).filter((key) => /permissionMode|permissions|updated/i.test(key)), [], 'nothing else of the hook output is copied into the outcome');
    const names = result.ignored.filter((item) => item.reason === 'unsupported_field').map((item) => item.field).sort();
    assert.ok(names.includes('updatedInput') && names.includes('updatedPermissions') && names.includes('permissionMode') && names.includes('permissions'), `unsupported fields are listed by name: ${names.join(', ')}`);
    ok('JSON that tries to rewrite the input or set permissions: only the decision is read, __proto__ pollutes nothing, the other fields are listed as ignored');
  }

  // ------------------------------------------------------------------------------------------------------------------ 7. parallel hooks, strictest wins, Post events
  {
    const allow = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    const ask = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'ask me' } };
    const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'deny wins' } };
    await writeOwner({ PreToolUse: [group(undefined, handler({ sleepMs: 1200, stdout: allow }), handler({ sleepMs: 1200, stdout: ask }), handler({ sleepMs: 1200, stdout: deny }))] });
    const started = Date.now();
    let outcome = await pre();
    const elapsed = Date.now() - started;
    assert.equal(outcome.fired.length, 3);
    assert.equal(outcome.permission, 'deny'); assert.equal(outcome.reason, 'deny wins');
    assert.ok(elapsed < 3000, `three 1200 ms hooks took ${elapsed} ms: they run in parallel (one after the other they need over 3600 ms)`);
    await writeOwner({ PreToolUse: [group(undefined, handler({ stdout: allow }), handler({ stdout: ask }))] });
    outcome = await pre();
    assert.equal(outcome.permission, 'ask'); assert.equal(outcome.reason, 'ask me');
    await writeOwner({ PreToolUse: [group(undefined, handler({ stdout: allow }), handler({ exit: 0 }))] });
    outcome = await pre();
    assert.equal(outcome.permission, 'allow');
    ok('matching hooks run in parallel (3 x 1200 ms in under 3 s) and deny beats ask beats allow');

    // the same handler written in two files runs once
    const log = scratchFile('log');
    const same = handler({ log });
    await writeOwner({ PreToolUse: [group('Bash', same), group('Bash', same)] });
    await pre();
    assert.equal(readLines(log).length, 1, 'an identical handler is run once');
    ok('an identical handler listed twice runs once');

    // a hook that matches nothing is not started
    const untouched = scratchFile('log');
    await writeOwner({ PreToolUse: [group('Edit', handler({ log: untouched })), group('Bash', handler({ log: untouched }, { if: 'Bash(git *)' }))] });
    await pre({ toolInput: { command: 'npm test' } });
    assert.equal(readLines(untouched).length, 0, 'neither the matcher nor the `if` matched: no process was started');
    await pre({ toolInput: { command: 'git push' } });
    assert.equal(readLines(untouched).length, 1, 'the `if` matches a git command');
    ok('a hook whose matcher or `if` does not match starts no process');

    // Post events: feedback and context, never a block
    const feedback = await (async () => { await writeOwner({ PostToolUse: [group(undefined, handler({ exit: 2, stderr: 'lint failed: 3 errors' }))] }); return post(); })();
    assert.equal(feedback.blocked, false, 'the tool already ran: a Post hook cannot block');
    assert.deepEqual(feedback.feedback, ['lint failed: 3 errors']);
    await writeOwner({ PostToolUse: [group(undefined, handler({ stdout: { decision: 'block', reason: 'the output looks wrong', hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'remember the style guide' } } }))] });
    const context = await post();
    assert.equal(context.blocked, false);
    assert.deepEqual(context.feedback, ['the output looks wrong']);
    assert.deepEqual(context.additionalContext, ['remember the style guide']);
    await writeOwner({ PostToolUse: [group(undefined, handler({ stdout: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '' } }, fill: { path: ['hookSpecificOutput', 'additionalContext'], text: 'c', times: 30_000 } }))] });
    const long = await post();
    assert.ok(long.additionalContext[0].length <= 10_000, `additionalContext is capped at 10,000 characters (${long.additionalContext[0].length})`);

    const dump = scratchFile('dump');
    await writeOwner({ PostToolUse: [group(undefined, handler({ dump }))], PostToolUseFailure: [group(undefined, handler({ dump: `${dump}.failure`, stdout: { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'try the other path' } } }))] });
    await post({ toolResponse: { isError: false, content: [{ type: 'text', text: 'fine' }] } });
    const sentPost = JSON.parse(await fs.readFile(dump, 'utf8'));
    assert.equal(sentPost.hook_event_name, 'PostToolUse'); assert.deepEqual(sentPost.tool_response.content, [{ type: 'text', text: 'fine' }]);
    const failure = await runner.run({ ...base, event: 'PostToolUseFailure', toolName: 'local.run_command', toolInput: { command: 'x' }, error: 'Exit code 1', toolUseId: 'tu-2' });
    const sentFailure = JSON.parse(await fs.readFile(`${dump}.failure`, 'utf8'));
    assert.equal(sentFailure.hook_event_name, 'PostToolUseFailure'); assert.equal(sentFailure.error, 'Exit code 1'); assert.equal(sentFailure.tool_use_id, 'tu-2');
    assert.deepEqual(failure.additionalContext, ['try the other path']);
    ok('PostToolUse / PostToolUseFailure: stderr of exit 2 and a block reason become feedback, additionalContext is capped, tool_response and error reach the hook; nothing can block');

    const hugeResponse = await (async () => { await writeOwner({ PostToolUse: [group(undefined, handler({ dump }))] }); return post({ toolResponse: { isError: false, content: [{ type: 'text', text: 'z'.repeat(3_000_000) }] } }); })();
    assert.equal(hugeResponse.blocked, false);
    assert.ok(Buffer.byteLength(await fs.readFile(dump, 'utf8')) <= 1_048_576 + 4096, 'a 3 MB tool result reaches the hook cut to about 1 MiB');
    ok('the JSON handed to a hook is bounded (a 3 MB tool result is cut)');
  }

  // ------------------------------------------------------------------------------------------------------------------ 8. Stop / TaskCompleted / SubagentStop and the retry counter
  {
    for (const event of LIFECYCLE_EVENTS) {
      const dump = scratchFile('dump');
      await writeOwner({ [event]: [group('ignored-because-this-event-has-no-matcher', handler({ dump, exit: 2, stderr: 'keep working' }))] });
      const outcome = await runner.run({ ...base, event, payloadExtra: { stop_hook_active: false, last_assistant_message: 'done?' } });
      assert.equal(outcome.matched, 1, `${event}: a matcher is ignored on an event that has none`);
      assert.equal(outcome.blocked, true, `${event}: exit 2 blocks`);
      assert.equal(outcome.reason, 'keep working');
      const sent = JSON.parse(await fs.readFile(dump, 'utf8'));
      assert.equal(sent.hook_event_name, event); assert.equal(sent.last_assistant_message, 'done?'); assert.equal(sent.stop_hook_active, false);
    }
    const withIf = scratchFile('log');
    await writeOwner({ Stop: [group(undefined, handler({ log: withIf }, { if: 'Bash(git *)' }))] });
    await runner.run({ ...base, event: 'Stop' });
    assert.equal(readLines(withIf).length, 0, 'on an event that is not a tool event a hook with `if` never runs (Claude Code)');
    ok('Stop, TaskCompleted and SubagentStop are accepted and run: exit 2 blocks with stderr as the reason, extra payload fields arrive, a matcher is ignored, an `if` never runs');

    const task = '11111111-2222-4333-8444-555555555555';
    await writeOwner({ Stop: [group(undefined, handler({ exit: 2, stderr: 'again' }))] });
    const counts = [];
    for (let i = 0; i < BLOCK_RETRY_LIMIT; i += 1) counts.push((await runner.run({ ...base, taskId: task, event: 'Stop' })).retries);
    assert.deepEqual(counts.map((item) => item.consecutive), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(counts.map((item) => item.exhausted), [false, false, false, false, false, false, false, true], 'the counter reports exhaustion at the cap');
    assert.equal(counts.at(-1).limit, BLOCK_RETRY_LIMIT);
    await writeOwner({ Stop: [group(undefined, handler({ exit: 0 }))] });
    const reset = (await runner.run({ ...base, taskId: task, event: 'Stop' })).retries;
    assert.deepEqual([reset.consecutive, reset.total, reset.exhausted], [0, 8, false], 'a stop that nothing blocks resets the consecutive count and keeps the total');
    const other = (await runner.run({ ...base, taskId: '99999999-2222-4333-8444-555555555555', event: 'Stop' })).retries;
    assert.deepEqual([other.consecutive, other.total], [0, 0], 'counters belong to one task');
    ok('retry counter: 1..8 consecutive blocks, exhausted at 8, reset by a stop that is not blocked, total kept, one counter per task and event');

    // the hard kill: a runner in its own process is killed without a chance to clean up, then a fresh process loads what it left
    const killTask = '22222222-3333-4444-8555-666666666666';
    await writeOwner({ Stop: [group(undefined, handler({ exit: 2, stderr: 'blocked by the stop hook' }))] });
    const childScript = path.join(HUB, 'tests', 'fixtures', 'hooks-runner-child.mjs');
    async function runChild(mode, enough) {
      const child = spawn(process.execPath, [childScript, hub, work, killTask, 'Stop', mode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let text = ''; let errors = '';
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.stderr.on('data', (chunk) => { errors += chunk; });
      await until(() => enough(text) || child.exitCode !== null, `the runner process to report (${errors.slice(0, 300)})`, 60_000);
      assert.equal(child.exitCode, null, `the runner process is still alive: ${errors.slice(0, 400)}`);
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL'); // TerminateProcess on Windows: no handler runs
      await exited;
      return text.split('\n').filter((line) => line.startsWith('COUNT ')).map((line) => line.split(' ').slice(1).map(Number));
    }
    const reported = await runChild('5', (text) => text.includes('IDLE'));
    assert.equal(reported.length, 5);
    const lastReported = reported.at(-1);
    assert.deepEqual(lastReported, [5, 5]);
    const reloaded = new HookRunner({ hubDirectory: hub });
    const after = await reloaded.retryState({ taskId: killTask, event: 'Stop' });
    assert.deepEqual([after.consecutive, after.total], lastReported, 'the retry counter is identical after the runner was killed and reloaded');
    ok('the retry counter is identical (5 consecutive / 5 total) after the runner process was killed with SIGKILL and a fresh process loaded the state');

    const racing = await runChild('loop', (text) => (text.match(/^COUNT /gm) ?? []).length >= 4);
    const lastRacing = racing.at(-1);
    const afterRace = await new HookRunner({ hubDirectory: hub }).retryState({ taskId: killTask, event: 'Stop' });
    assert.ok(afterRace.total >= lastRacing[1] && afterRace.total <= lastRacing[1] + 3, `killed in the middle of a run: the counter is at least the last one reported and a few runs ahead at most, which are the runs that finished while the parent was reading the pipe (${afterRace.total} vs ${lastRacing[1]})`);
    assert.ok(afterRace.total >= 6, 'and it continued from the persisted value (5) of the previous process');
    JSON.parse(await fs.readFile(path.join(hub, 'hooks', 'state.json'), 'utf8'));
    ok('a runner killed while it was looping leaves a state file that parses and a counter that continues from the persisted value');
  }

  // ------------------------------------------------------------------------------------------------------------------ 9. a project hooks file needs the owner's approval of its sha256
  {
    const project = await realDirectory('project');
    const log = scratchFile('log');
    const events = { PreToolUse: [group('Bash', handler({ log }))] };
    await removeOwner();
    const sha = await writeProject(project, events);
    const run = () => pre({ projectRoot: project, cwd: project });
    const states = async () => (await runner.status({ projectRoot: project })).project;

    assert.equal((await states()).state, 'unapproved');
    assert.equal((await states()).sha256, sha);
    await run();
    assert.equal(readLines(log).length, 0, 'a project hooks file is inert until the owner approves its sha256');
    await assert.rejects(runner.approveProject({ projectRoot: project, sha256: sha256(Buffer.from('something else')) }), { code: 'hooks_project_changed', statusCode: 409 });
    await run();
    assert.equal(readLines(log).length, 0, 'an approval of a different sha256 is refused and changes nothing');
    ok('a project hooks file is inert until approved; approving a sha256 that is not the file\'s is refused (409)');

    const approved = await runner.approveProject({ projectRoot: project, sha256: sha });
    assert.equal(approved.state, 'approved');
    await run();
    assert.equal(readLines(log).length, 1, 'after the approval the project hooks run');
    assert.equal((await run()).config.projectSha256, sha, 'and the outcome says which file ran');
    assert.ok(JSON.parse(await fs.readFile(path.join(hub, 'hooks', 'state.json'), 'utf8')).approvals.some((entry) => entry.sha256 === sha), 'the approval is stored in the Hub state');
    const restarted = new HookRunner({ hubDirectory: hub, log: () => {} });
    const before = readLines(log).length;
    await restarted.run({ ...base, projectRoot: project, cwd: project, event: 'PreToolUse', toolName: 'local.run_command', toolInput: { command: 'x' } });
    assert.equal(readLines(log).length, before + 1, 'the approval survives a restart');
    ok('after approval the project hooks run, the outcome names the file by sha256, the approval is in the Hub state and survives a restart');

    // a one-byte edit
    const edited = (await fs.readFile(projectFile(project), 'utf8')).replace('"Bash"', '"Bush"');
    assert.equal(Buffer.byteLength(edited), Buffer.byteLength(await fs.readFile(projectFile(project), 'utf8')), 'the edit keeps the size: one character');
    await fs.writeFile(projectFile(project), edited);
    const count = readLines(log).length;
    await run();
    assert.equal(readLines(log).length, count, 'after a one-byte edit the file is inert again');
    assert.equal((await states()).state, 'changed');
    ok('a one-byte edit disables the project hooks until the owner approves the new sha256');

    await fs.writeFile(projectFile(project), JSON.stringify(config(events), null, 2)); // put it back
    assert.equal((await states()).state, 'approved', 'the original bytes are approved again (the approval is of the content)');
    const copyDir = await realDirectory('copy');
    await writeProject(copyDir, events);
    assert.equal((await runner.status({ projectRoot: copyDir })).project.state, 'unapproved', 'the same bytes in another project are not approved there');
    await runner.run({ ...base, projectRoot: copyDir, cwd: copyDir, event: 'PreToolUse', toolName: 'local.run_command', toolInput: { command: 'x' } });
    assert.equal(readLines(log).length, count, 'an approval is for one project folder');
    ok('an approval belongs to one project folder and one content: the same file in another folder is inert');

    await assert.rejects(runner.approveProject({ projectRoot: path.join(root, 'no-such-folder'), sha256: sha }), { code: 'hooks_project_missing', statusCode: 404 });
    await assert.rejects(runner.approveProject({ projectRoot: await realDirectory('empty'), sha256: sha }), { code: 'hooks_project_missing', statusCode: 404 });
    await runner.revokeProject({ projectRoot: project });
    assert.equal((await states()).state, 'unapproved', 'revoking removes the approval');
    const invalidSha = await writeProject(project, null, '{ "hooks": { "PreToolUse": [ { "hooks": [ { "type": "command" } ] } ] } }');
    await assert.rejects(runner.approveProject({ projectRoot: project, sha256: invalidSha }), { code: 'hooks_project_invalid', statusCode: 400 });
    const oversize = await writeProject(project, null, `{"hooks":{},"pad":"${'x'.repeat(300_000)}"}`);
    await assert.rejects(runner.approveProject({ projectRoot: project, sha256: oversize }), (error) => ['hooks_project_invalid', 'hooks_project_unreadable'].includes(error.code));
    ok('revoking removes the approval; a file that does not validate or is over 256 KB cannot be approved; an approval for a folder without a file is 404');

    // the project file adds hooks; it never removes the owner's
    const ownerLog = scratchFile('log'); const projectLog = scratchFile('log');
    await writeOwner({ PreToolUse: [group(undefined, handler({ log: ownerLog }))] });
    const both = await writeProject(project, { PreToolUse: [group(undefined, handler({ log: projectLog }))] });
    await runner.approveProject({ projectRoot: project, sha256: both });
    await run();
    assert.equal(readLines(ownerLog).length, 1); assert.equal(readLines(projectLog).length, 1);
    await writeProject(project, null, JSON.stringify({ disableAllHooks: true, hooks: {} }));
    await runner.approveProject({ projectRoot: project, sha256: sha256(await fs.readFile(projectFile(project))) });
    await run();
    assert.equal(readLines(ownerLog).length, 2, 'a project file cannot switch the owner\'s hooks off');
    ok('owner and project hooks both run; a project file cannot disable or replace the owner\'s hooks');
    await removeOwner();
  }

  // ------------------------------------------------------------------------------------------------------------------ 10. an invalid owner file fails closed
  {
    await fs.writeFile(ownerFile, '{ "hooks": { "PreToolUse": [ ');
    let outcome = await pre();
    assert.equal(outcome.blocked, true); assert.equal(outcome.permission, 'deny'); assert.equal(outcome.code, 'hooks_config_invalid');
    assert.match(outcome.reason, /hooks\.json/);
    assert.equal(outcome.config.ownerValid, false);
    outcome = await post();
    assert.equal(outcome.blocked, false, 'a Post event cannot block');
    assert.ok(outcome.feedback.some((line) => /hooks\.json/.test(line)), 'but the model is told');
    await fs.writeFile(ownerFile, JSON.stringify(config({ PreToolUse: [group(undefined, { type: 'command' })] })));
    outcome = await pre();
    assert.equal(outcome.code, 'hooks_config_invalid', 'a file that does not validate fails closed as well');
    const status = await runner.status({ projectRoot: work });
    assert.equal(status.owner.valid, false); assert.ok(status.owner.errors.length >= 1);
    const log = scratchFile('log');
    await writeOwner({ PreToolUse: [group(undefined, handler({ log }))] });
    outcome = await pre();
    assert.equal(outcome.code, undefined); assert.equal(readLines(log).length, 1, 'the next call uses the corrected file without a restart');
    ok('an owner hooks.json that does not parse or validate refuses PreToolUse calls (hooks_config_invalid) instead of silently running without its guards; fixing the file takes effect on the next call');
    await removeOwner();
  }

  // ------------------------------------------------------------------------------------------------------------------ 11. shell forms, stdin that is never read
  {
    const info = await new ShellRunner({ workspace: { resolve: async () => ({ absolute: work, relative: '' }) } }).info();
    const shellCases = [];
    if (info.shells.bash) shellCases.push(['bash', 'echo "from bash" >&2; exit 2', 'from bash']);
    if (process.platform === 'win32' && info.shells.powershell) shellCases.push(['powershell', "[Console]::Error.WriteLine('from powershell'); exit 2", 'from powershell']);
    if (process.platform === 'win32') shellCases.push(['cmd', 'echo from cmd 1>&2 & exit /b 2', 'from cmd']);
    assert.ok(shellCases.length >= 1, 'at least one shell is available');
    for (const [shell, command, expected] of shellCases) {
      await writeOwner({ PreToolUse: [group(undefined, { type: 'command', shell, command })] });
      const outcome = await pre();
      assert.equal(outcome.permission, 'deny', `${shell}: exit 2 blocks`);
      assert.equal(outcome.reason.trim(), expected, `${shell}: stderr is the reason`);
      assert.equal(outcome.fired[0].kind, 'shell'); assert.equal(outcome.fired[0].shell, shell);
    }
    if (info.shells.bash) {
      const dump = scratchFile('dump').replaceAll('\\', '/');
      await writeOwner({ PreToolUse: [group(undefined, { type: 'command', shell: 'bash', command: `cat > "${dump}"; echo "$CLAUDE_PROJECT_DIR" > "${dump}.dir"; exit 0` })] });
      await pre();
      assert.equal(JSON.parse(await fs.readFile(dump, 'utf8')).hook_event_name, 'PreToolUse', 'a shell hook reads the JSON on its stdin');
      assert.ok((await fs.readFile(`${dump}.dir`, 'utf8')).trim().length > 0, 'and sees CLAUDE_PROJECT_DIR');
    }
    ok(`shell form through ${shellCases.map(([shell]) => shell).join(', ')}: exit 2 blocks with the stderr of the shell, stdin carries the JSON, the project directory variable is set`);

    await writeOwner({ PreToolUse: [group(undefined, handler({ ignoreStdin: true, exit: 2, stderr: 'did not wait for input' }))] });
    const outcome = await pre({ toolInput: { command: 'x'.repeat(900_000) } });
    assert.equal(outcome.blocked, true, 'a hook that exits without reading 900 KB of stdin still blocks (no EPIPE crash)');
    assert.equal(outcome.reason, 'did not wait for input');
    await writeOwner({ PreToolUse: [group(undefined, { type: 'command', command: 'this-program-does-not-exist-chatmcp', args: [] })] });
    const missing = await pre();
    assert.equal(missing.blocked, false); assert.equal(missing.fired[0].failure, 'spawn');
    await writeOwner({ PreToolUse: [group(undefined, { type: 'command', command: 'this-program-does-not-exist-chatmcp', args: [], onFailure: 'block' })] });
    assert.equal((await pre()).permission, 'deny', 'a program that cannot be started is a failure like any other: onFailure decides');
    ok('a hook that never reads stdin does not crash the runner; a program that cannot be started is a failure and onFailure decides');
    await removeOwner();
  }

  // ------------------------------------------------------------------------------------------------------------------ 12. protected paths, the per-task ledger
  {
    for (const protectedPath of ['.chatmcp/hooks.json', 'sub/.chatmcp/hooks.json', '.CHATMCP/HOOKS.JSON', '.chatmcp\\hooks.json', './.chatmcp/hooks.json']) assert.equal(isProtectedPath(protectedPath), true, `${protectedPath} is protected`);
    for (const fine of ['hooks.json', '.chatmcp/settings.json', '.chatmcp', 'chatmcp/hooks.json', 'src/hooks.json', '.chatmcp-hooks.json']) assert.equal(isProtectedPath(fine), false, `${fine} is not`);
    for (const word of ['.chatmcp/*', '.chatmcp/hook*', '.chatmcp/h?oks.json', '.chatmcp/hooks.json', 'x/.chatmcp/*.json']) assert.equal(mayExpandToProtected(word), true, `${word} may expand to the hooks file`);
    assert.equal(mayExpandToProtected('.chatmcp/notes.txt'), false);
    const workspace = new StudioWorkspace({ manager: { workspace: work, secrets: [] }, directory: path.join(root, 'studio') });
    const tools = new LocalTools({ workspace, stateDirectory: path.join(root, 'local') });
    const refused = await tools.call('local.write_file', { path: '.chatmcp/hooks.json', content: '{"hooks":{}}' });
    assert.equal(refused.isError, true); assert.equal(refused.structuredContent.error.code, 'protected_path');
    assert.equal(fsSync.existsSync(path.join(work, '.chatmcp', 'hooks.json')), false, 'the write tool did not create the file');
    const assessed = await tools.assess('local.write_file', { path: '.chatmcp/hooks.json', content: 'x' });
    assert.equal(assessed.category, 'blocked');
    assert.equal((await tools.assess('local.write_file', { path: '.chatmcp/settings.json', content: 'x' })).category, 'workspace_edit', 'the rule names the hooks file, not the whole folder');
    ok('.chatmcp/hooks.json is a protected path (any depth, any case, wildcards): the write tool refuses it and the gate classifies it as blocked; the rest of .chatmcp is not protected');

    const ledgerTask = '44444444-5555-4666-8777-888888888888';
    const secretText = 'unique-tool-input-text-that-must-not-be-stored';
    await writeOwner({ PreToolUse: [group('Bash', handler({ exit: 2, stderr: 'ledger deny' }))], PostToolUse: [group(undefined, handler({}))] });
    const ownerSha = sha256(await fs.readFile(ownerFile));
    await pre({ taskId: ledgerTask, toolInput: { command: secretText }, toolUseId: 'tu-ledger-1' });
    await post({ taskId: ledgerTask, toolInput: { command: secretText }, toolUseId: 'tu-ledger-1' });
    let record = await runner.taskRecord(ledgerTask);
    assert.equal(record.taskId, ledgerTask);
    assert.equal(record.configHistory.length, 1);
    assert.equal(record.configHistory[0].ownerSha256, ownerSha, 'the ledger names the hooks file of the task by sha256');
    assert.deepEqual(record.fired.map((row) => [row.event, row.tool, row.decision, row.toolUseId]), [['PreToolUse', 'local.run_command', 'deny', 'tu-ledger-1'], ['PostToolUse', 'local.run_command', 'none', 'tu-ledger-1']]);
    assert.equal(record.counts.PreToolUse.fired, 1); assert.equal(record.counts.PreToolUse.blocked, 1);
    assert.ok(!JSON.stringify(record).includes(secretText), 'the ledger keeps no tool input');
    await writeOwner({ PreToolUse: [group('Bash', handler({ exit: 0 }))] });
    await pre({ taskId: ledgerTask, toolUseId: 'tu-ledger-2' });
    record = await runner.taskRecord(ledgerTask);
    assert.equal(record.configHistory.length, 2, 'a change of the hooks file during the task is recorded');
    assert.equal(record.configHistory[1].ownerSha256, sha256(await fs.readFile(ownerFile)));
    assert.equal(record.configHistory[1].changed, true);
    assert.equal(record.fired.length, 3);
    const reloaded = new HookRunner({ hubDirectory: hub });
    assert.deepEqual((await reloaded.taskRecord(ledgerTask)).configHistory, record.configHistory, 'the ledger survives a restart');
    ok('per-task ledger: the sha256 of the hooks file at the first call and at every change, each hook that fired with its decision, counts; no tool input is stored; it survives a restart');
    await removeOwner();
  }
} finally {
  for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone: the point of the test */ } }
  await runner.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => {});
}

console.log(`PASS: ${checks} hooks core checks`);
process.exit(0);
