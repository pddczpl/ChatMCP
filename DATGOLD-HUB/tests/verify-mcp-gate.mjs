// The permission gate and the tools of external MCP servers (phase P2, plan task ext-12).
//
// Every name that is not `local.*` or `studio.*` is an external tool: category `external`, read as `<server>.<tool>` (the text before the
// first dot is the server). What the gate does with one comes from the owner's policy for that server or tool (`policyFor`, ask | allow |
// deny, ask when nothing is set), the owner's trust in the annotations of that server (`trustAnnotations`, false by default) and the mode:
//
//   readonly                      refused, unless the tool is `allow` AND carries readOnlyHint: true AND its server is trusted
//   review, autonomous            ask; `allow` runs; `deny` refuses
//   executionPolicy sandbox-only  refused (an external server is not confined by the sandbox)
//   executionPolicy full-access   runs without a question (the owner's decision of 2026-11-20), but an explicit `deny` still refuses
//
// A tool whose server marks it destructiveHint: true (the boolean true only; a missing hint is not read with the MCP default) is asked
// wherever it would otherwise run, Full Access and `allow` included, whether or not the owner trusts that server's annotations: a hint
// that can only ADD a question is safe from any server (the owner's decision of 2026-11-20, "Có, vẫn hỏi"). `deny` still refuses first.
//
// The workspace path inspection is not applied to an external tool (what a path means is the server's business; the owner reads the
// arguments on the card instead), the card is `detail.kind = 'mcp'` with the arguments masked by the masker every card uses, the audit
// history records the server and the tool, and the owner's hooks fire for an external call whatever the gate decided.
//
// The suite collects every mismatch and fails at the end with the whole list, so that a run on a gate that does not do this says how
// many rows are wrong, not only the first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { delay } from '../lib/runtime.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import * as permissions from '../lib/permissions.mjs';
import { toolNames } from '../lib/hooks.mjs';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';

const { PermissionGate } = permissions;
let checks = 0;
const failures = [];
/** One check: a failure is collected (with what was seen), the suite goes on and fails at the end. */
const expect = (label, condition, seen = '') => { checks += 1; if (!condition) failures.push(`${label}${seen === '' ? '' : ` (seen: ${typeof seen === 'string' ? seen : JSON.stringify(seen)})`}`); };
const section = (label) => console.log(`  ${failures.length ? '..' : 'ok'} - ${label}`);
setTimeout(() => { console.error('FAIL: the MCP gate suite exceeded its own time budget'); process.exit(2); }, 240_000).unref();

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-mcp-gate-')));
const work = path.join(root, 'work');
const state = path.join(root, 'state');
await fs.mkdir(path.join(work, 'src'), { recursive: true });
await fs.mkdir(state);
await fs.writeFile(path.join(work, 'src', 'app.py'), 'print("hi")\n');
const OUTSIDE = path.resolve(root, '..', `chatmcp-mcp-gate-outside-${process.pid}.txt`);
const REGISTERED = 'registered-secret-value-9f3k';
const manager = { workspace: work, secrets: [REGISTERED] };
const studio = new StudioWorkspace({ manager, directory: path.join(state, 'studio') });
const localTools = new LocalTools({ workspace: studio, stateDirectory: state });
const hasPolicyHook = typeof PermissionGate.prototype.attachExternalPolicy === 'function';

/**
 * A gate in a mode and an execution policy, with the owner's external policy: `rule` is what policyFor answers (undefined = nothing set),
 * `trusted` whether the annotations of the server are trusted, `describe` what the caller knows of the server. `attach: false` leaves the
 * gate as it is built (nothing injected).
 */
function newGate({ mode = 'review', exec = 'host-review', rule, trusted = false, describe, attach = true, timeout = 60_000 } = {}) {
  const gate = new PermissionGate({ manager, workspace: studio, timeout });
  gate.attachLocalTools(localTools);
  const asked = [];
  if (attach && hasPolicyHook) {
    gate.attachExternalPolicy({
      policyFor: (who) => { asked.push(who); return typeof rule === 'function' ? rule(who) : rule; },
      trustAnnotations: (who) => (typeof trusted === 'function' ? trusted(who) : trusted),
      ...(describe ? { describeServer: describe } : {}),
    });
  }
  gate.configure(exec === 'full-access' ? { mode, executionPolicy: exec, confirmation: 'FULL ACCESS' } : { mode, executionPolicy: exec });
  return { gate, asked };
}

/** authorize() and what came of it: runs (no question), asks (one question, answered with `approve`), refused (no question), or throws. */
async function outcome(gate, name, args = {}, { definition = {}, approve = true, forceAsk = false, taskId = 'task-1' } = {}) {
  const events = [];
  const stop = gate.subscribe((event) => events.push(event));
  const run = gate.authorize({ name, args, definition, taskId, forceAsk, askReason: forceAsk ? 'a hook asked' : '' });
  let settled = null;
  run.then((value) => { settled = { value }; }, (thrown) => { settled = { thrown }; });
  for (let i = 0; i < 200 && !settled && gate.state().pending.length === 0; i += 1) await delay(5);
  try {
    if (settled?.thrown) return { kind: 'throws', error: settled.thrown, events, pending: 0 };
    if (settled) return { kind: settled.value.allowed ? 'runs' : 'refused', result: settled.value, events, pending: 0, row: gate.state().recent.at(-1) };
    const pending = gate.state().pending;
    const request = pending[0];
    gate.decide(request.id, approve);
    const result = await run;
    return { kind: 'asks', result, request, events, pending: pending.length, row: gate.state().recent.at(-1) };
  } finally { stop(); }
}
const definitionOf = (name, annotations = { readOnlyHint: true }) => {
  const dot = name.indexOf('.');
  return { name, server: name.slice(0, dot), originalName: name.slice(dot + 1), description: 'a tool of an external server', inputSchema: { type: 'object' }, annotations };
};

// ------------------------------------------------------------------ the name rule
{
  const read = permissions.externalToolName;
  expect('externalToolName is exported (the one place that reads a server and a tool from a name)', typeof read === 'function', typeof read);
  if (typeof read === 'function') {
    const rows = [
      ['github.create_issue', { server: 'github', tool: 'create_issue' }],
      ['mcp.shell.start_process', { server: 'mcp', tool: 'shell.start_process' }],
      ['desktop-commander.read_file', { server: 'desktop-commander', tool: 'read_file' }],
      ['Local.write_file', { server: 'Local', tool: 'write_file' }],
      ['STUDIO.tree', { server: 'STUDIO', tool: 'tree' }],
      ['nodot', { server: '', tool: 'nodot' }],
      ['.leading', { server: '', tool: '.leading' }],
      ['trailing.', { server: '', tool: 'trailing.' }],
      ['local.write_file', null],
      ['local.mystery', null],
      ['studio.tree', null],
    ];
    for (const [name, wanted] of rows) expect(`externalToolName(${name})`, JSON.stringify(read(name)) === JSON.stringify(wanted), read(name));
  }
  // the hooks read the same rule: the alias mcp__<server>__<tool> of an external tool, and none for the Hub's own tools or a name without a server
  for (const [name, alias] of [['github.create_issue', 'mcp__github__create_issue'], ['mcp.shell.start_process', 'mcp__mcp__shell.start_process'], ['Local.write_file', 'mcp__Local__write_file']]) {
    expect(`hooks: ${name} answers to ${alias}`, toolNames(name).includes(alias), toolNames(name));
  }
  for (const name of ['local.write_file', 'studio.tree', 'nodot', '.leading', 'trailing.']) expect(`hooks: ${name} has no mcp__ alias`, !toolNames(name).some((item) => item.startsWith('mcp__')), toolNames(name));

  const { gate } = newGate({ mode: 'autonomous' });
  const verdict = await gate.assess('github.create_issue', { title: 'x' }, definitionOf('github.create_issue', { readOnlyHint: true, destructiveHint: false, idempotentHint: 'yes', openWorldHint: 1, title: 'Create', bogus: 'x' }));
  expect('assess: an external tool has the category external', verdict.category === 'external', verdict);
  expect('assess: with its server and tool', verdict.server === 'github' && verdict.tool === 'create_issue', verdict);
  expect('assess: and its annotations (the hints only, as booleans)', JSON.stringify(verdict.annotations) === JSON.stringify({ readOnlyHint: true, destructiveHint: false }), verdict.annotations);
  for (const name of ['github.update_page', 'slack.send_message', 'db.execute_sql', 'memory.search_nodes', 'fs.write_file', 'desktop-commander.start_process', 'mcp.shell.start_process', 'cloud.delete_everything', 'Local.write_file']) {
    expect(`assess: ${name} is external`, (await gate.assess(name, {}, {})).category === 'external');
  }
  expect('assess: local.write_file keeps its own category', (await gate.assess('local.write_file', { path: 'src/a.py', content: 'x' }, {})).category === 'workspace_edit');
  expect('assess: studio.tree keeps its own category', (await gate.assess('studio.tree', {}, {})).category === 'read');
  expect('assess: local.mystery (no such local tool) is not external', (await gate.assess('local.mystery', {}, {})).category === 'unknown');
  section('the name rule: <server>.<tool> (first dot), local.* and studio.* are the Hub\'s own, hooks use the same rule');
}

// ------------------------------------------------------------------ the key rows
{
  const { gate } = newGate({ mode: 'autonomous' });
  const got = await outcome(gate, 'github.create_issue', { owner: 'o', repo: 'r', title: 't', body: 'b' }, { definition: definitionOf('github.create_issue', {}) });
  expect('autonomous + external create_issue: approval_requested and pending == 1', got.kind === 'asks' && got.pending === 1 && got.events.some((event) => event.type === 'approval_requested'), { kind: got.kind, pending: got.pending, events: got.events.map((event) => event.type) });
  const notion = await outcome(gate, 'notion.update_page', { page_id: 'p' }, { definition: definitionOf('notion.update_page', {}) });
  expect('autonomous + external update_page: asks', notion.kind === 'asks', notion.kind);
  for (const name of ['slack.send_message', 'db.execute_sql']) {
    const asked = await outcome(gate, name, { text: 'hi' }, { definition: definitionOf(name, {}) });
    expect(`autonomous + ${name}: asked, not refused`, asked.kind === 'asks', asked.kind);
  }
  {
    const full = newGate({ mode: 'autonomous', exec: 'full-access', rule: 'deny' });
    const denied = await outcome(full.gate, 'github.create_issue', { title: 't' }, { definition: definitionOf('github.create_issue', {}) });
    expect('full-access + deny: refused', denied.kind === 'refused', denied.kind);
    expect('full-access + deny: no question', denied.pending === 0 && !denied.events.some((event) => event.type === 'approval_requested'));
  }
  {
    const full = newGate({ mode: 'autonomous', exec: 'full-access' });
    const runs = await outcome(full.gate, 'github.create_issue', { title: 't' }, { definition: definitionOf('github.create_issue', {}) });
    expect('full-access + unset: runs', runs.kind === 'runs', runs.kind);
    expect('full-access + unset: announced as a Full Access call', runs.events.some((event) => event.type === 'full_access_tool' && event.toolName === 'github.create_issue'), runs.events.map((event) => event.type));
  }
  {
    const readonly = newGate({ mode: 'readonly', rule: 'allow', trusted: false });
    const refused = await outcome(readonly.gate, 'memory.search_nodes', { query: 'x' }, { definition: definitionOf('memory.search_nodes', { readOnlyHint: true }) });
    expect('readonly + allow + untrusted readOnlyHint: refused', refused.kind === 'refused', refused.kind);
  }
  for (const mode of ['review', 'autonomous']) {
    const { gate: g } = newGate({ mode });
    const asked = await outcome(g, 'fs.write_file', { path: OUTSIDE, content: 'x' }, { definition: definitionOf('fs.write_file', {}) });
    expect(`out-of-workspace path: no exception (${mode})`, asked.kind !== 'throws', asked.error?.code ?? asked.kind);
    expect(`out-of-workspace path: asked (${mode})`, asked.kind === 'asks', asked.kind);
    expect(`out-of-workspace path: the path is on the card (${mode})`, String(asked.request?.detail?.arguments ?? '').includes(JSON.stringify(OUTSIDE).slice(1, -1)), asked.request?.detail);
    for (const key of ['cwd', 'working_directory', 'directory', 'source', 'destination']) {
      const other = await outcome(g, 'desktop-commander.start_process', { command: 'dir', [key]: OUTSIDE }, { definition: definitionOf('desktop-commander.start_process', {}) });
      expect(`out-of-workspace ${key}: no exception (${mode})`, other.kind === 'asks', other.error?.code ?? other.kind);
    }
  }
  expect('no file was created outside the workspace by the gate', !fsSync.existsSync(OUTSIDE));
  section('key rows: autonomous asks, full-access + deny refuses, full-access + unset runs, readonly needs allow + trusted readOnlyHint, an outside path does not throw');
}

// ------------------------------------------------------------------ destructiveHint: a question added where the call would run
{
  const call = (gate, annotations, extra = {}) => outcome(gate, 'db.drop_table', { table: 'users' }, { definition: definitionOf('db.drop_table', annotations), ...extra });
  {
    const full = newGate({ mode: 'autonomous', exec: 'full-access' });
    const asked = await call(full.gate, { destructiveHint: true });
    expect('full-access + destructiveHint true: asks (pending 1)', asked.kind === 'asks' && asked.pending === 1 && asked.events.some((event) => event.type === 'approval_requested'), { kind: asked.kind, pending: asked.pending });
    expect('full-access + destructiveHint true: not announced as a Full Access call', !asked.events.some((event) => event.type === 'full_access_tool'), asked.events.map((event) => event.type));
    expect('full-access + destructiveHint true: the card is the mcp card', asked.request?.detail?.kind === 'mcp', asked.request?.detail);
    expect('full-access + destructiveHint true: the reason says the server marked the tool destructive', /destructiveHint/.test(asked.request?.reason ?? '') && /phá huỷ/.test(asked.request?.reason ?? ''), asked.request?.reason);
    expect('full-access + destructiveHint true: the history row keeps that reason', /destructiveHint/.test(asked.row?.reason ?? ''), asked.row?.reason);
    expect('full-access + destructiveHint false: runs', (await call(full.gate, { destructiveHint: false })).kind === 'runs');
    expect('full-access + destructiveHint absent: runs (the MCP default true is not read into a missing hint)', (await call(full.gate, {})).kind === 'runs');
    expect('full-access + no annotations at all: runs', (await outcome(full.gate, 'db.drop_table', { table: 'users' }, { definition: { name: 'db.drop_table' } })).kind === 'runs');
    for (const [label, value] of [['"true" as a string', 'true'], ['1', 1], ['null', null], ['an object', { value: true }]]) {
      expect(`full-access + destructiveHint ${label}: runs (only the boolean true counts)`, (await call(full.gate, { destructiveHint: value })).kind === 'runs');
    }
    expect('full-access + destructiveHint true + readOnlyHint true: asks (a read-only claim does not take the question away)', (await call(full.gate, { destructiveHint: true, readOnlyHint: true })).kind === 'asks');
    expect('full-access + destructiveHint true + a hook asks: one question', (await call(full.gate, { destructiveHint: true }, { forceAsk: true })).pending === 1);
  }
  for (const trusted of [false, true]) {
    const full = newGate({ mode: 'autonomous', exec: 'full-access', trusted });
    expect(`full-access + destructiveHint true, ${trusted ? 'trusted' : 'untrusted'} server: asks (trustAnnotations does not matter)`, (await call(full.gate, { destructiveHint: true })).kind === 'asks');
  }
  for (const exec of ['host-review', 'full-access']) {
    const allow = newGate({ mode: 'autonomous', exec, rule: 'allow' });
    expect(`allow + destructiveHint true (${exec}): asks`, (await call(allow.gate, { destructiveHint: true })).kind === 'asks');
    expect(`allow + destructiveHint false (${exec}): runs`, (await call(allow.gate, { destructiveHint: false })).kind === 'runs');
    const deny = newGate({ mode: 'autonomous', exec, rule: 'deny' });
    const refused = await call(deny.gate, { destructiveHint: true });
    expect(`deny + destructiveHint true (${exec}): refused, no question`, refused.kind === 'refused' && refused.pending === 0 && !refused.events.some((event) => event.type === 'approval_requested'), refused.kind);
    expect(`deny + destructiveHint true (${exec}): the reason is the owner's deny`, /deny/.test(refused.result?.reason ?? ''), refused.result?.reason);
  }
  {
    const review = newGate({ mode: 'review' });
    expect('review + unset + destructiveHint true: asks (as without it)', (await call(review.gate, { destructiveHint: true })).kind === 'asks');
    const sandbox = newGate({ mode: 'autonomous', exec: 'sandbox-only', rule: 'allow' });
    expect('sandbox-only + allow + destructiveHint true: refused', (await call(sandbox.gate, { destructiveHint: true })).kind === 'refused');
  }
  {
    // Read Only is unchanged: refused unless allow + trusted readOnlyHint; such a call that is also marked destructive asks, like a destructive name
    const readonly = newGate({ mode: 'readonly', rule: 'allow', trusted: true });
    expect('readonly + allow + trusted readOnlyHint + destructiveHint true: asks', (await call(readonly.gate, { readOnlyHint: true, destructiveHint: true })).kind === 'asks');
    expect('readonly + allow + trusted readOnlyHint + destructiveHint false: runs', (await call(readonly.gate, { readOnlyHint: true, destructiveHint: false })).kind === 'runs');
    expect('readonly + allow + trusted + destructiveHint true without readOnlyHint: refused', (await call(readonly.gate, { destructiveHint: true })).kind === 'refused');
    const unset = newGate({ mode: 'readonly', trusted: true });
    expect('readonly + unset + destructiveHint true: refused', (await call(unset.gate, { readOnlyHint: true, destructiveHint: true })).kind === 'refused');
  }
  {
    // nobody to ask: what would be asked is refused at once
    const worker = newGate({ mode: 'autonomous', exec: 'full-access' });
    worker.gate.interactive = false;
    const started = Date.now();
    const refused = await call(worker.gate, { destructiveHint: true });
    expect('worker (not interactive) + full-access + destructiveHint true: refused at once', refused.kind === 'refused' && refused.pending === 0 && Date.now() - started < 1000, refused.kind);
    expect('worker + full-access + destructiveHint true: recorded with server and tool', refused.row?.decision === 'policy' && refused.row?.server === 'db' && refused.row?.tool === 'drop_table', refused.row);
    expect('worker + full-access + destructiveHint false: runs', (await call(worker.gate, { destructiveHint: false })).kind === 'runs');
    const background = newGate({ mode: 'autonomous', exec: 'full-access' });
    background.gate.backgroundAgent = true;
    expect('background agent + full-access + destructiveHint true: refused at once', (await call(background.gate, { destructiveHint: true })).kind === 'refused');
  }
  {
    // the reason says it only where the server said it
    const review = newGate({ mode: 'review' });
    const plain = await call(review.gate, { destructiveHint: false }, { approve: false });
    expect('destructiveHint false: the reason does not call the tool destructive', plain.kind === 'asks' && !/destructiveHint/.test(plain.request?.reason ?? ''), plain.request?.reason);
  }
  section('destructiveHint: true (the boolean only) asks under Full Access and allow, from any server; false, absent or another type runs; deny refuses first; Read Only unchanged; nobody to ask refuses');
}

// ------------------------------------------------------------------ the matrix
{
  const MODES = ['readonly', 'review', 'autonomous'];
  const POLICIES = ['host-review', 'sandbox-only', 'full-access'];
  const TOOLS = [
    ['github.create_issue', { owner: 'o', repo: 'r', title: 'Bug', body: 'text' }],
    ['memory.search_nodes', { query: 'architecture' }],
    ['slack.send_message', { channel: 'C1', text: 'hello' }],
    ['fs.write_file', { path: OUTSIDE, content: 'x' }],
  ];
  const TRUST = [['untrusted', false], ['trusted', true]];
  const RULES = [['unset', undefined], ['allow', 'allow'], ['deny', 'deny']];
  // what the server says of destruction: nothing, false, true, and the word "true" (not a boolean, so not a hint)
  const DESTRUCTIVE = [['no destructiveHint', undefined], ['destructiveHint false', false], ['destructiveHint true', true], ['destructiveHint "true"', 'true']];
  /** What the owner decided, written plainly and apart from the gate. Every tool here carries readOnlyHint: true. */
  const oracle = (mode, exec, trusted, rule, destructive) => {
    if (rule === 'deny') return 'refused';
    if (mode === 'readonly') {
      if (!(rule === 'allow' && trusted && exec !== 'sandbox-only')) return 'refused';
      return destructive ? 'asks' : 'runs';
    }
    if (exec === 'sandbox-only') return 'refused';
    if (destructive) return 'asks';
    if (exec === 'full-access') return 'runs';
    return rule === 'allow' ? 'runs' : 'asks';
  };
  const rows = [];
  const counts = { runs: 0, asks: 0, refused: 0, throws: 0 };
  let decisionsWrong = 0;
  for (const mode of MODES) for (const exec of POLICIES) for (const [name, args] of TOOLS) for (const [trustLabel, trusted] of TRUST) for (const [ruleLabel, rule] of RULES) for (const [hintLabel, hint] of DESTRUCTIVE) {
    const { gate, asked } = newGate({ mode, exec, rule, trusted });
    const label = `${mode} + ${exec} + ${name} + ${trustLabel} readOnlyHint + ${ruleLabel} + ${hintLabel}`;
    const destructive = hint === true;
    const wanted = oracle(mode, exec, trusted, rule, destructive);
    const got = await outcome(gate, name, args, { definition: definitionOf(name, { readOnlyHint: true, ...(hint === undefined ? {} : { destructiveHint: hint }) }) });
    counts[got.kind] += 1;
    if (got.kind !== wanted) decisionsWrong += 1;
    const [server, tool] = [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)];
    let right = got.kind === wanted;
    if (right && wanted === 'asks') right = got.pending === 1 && got.events.some((event) => event.type === 'approval_requested') && got.request?.detail?.kind === 'mcp' && got.result.allowed === true;
    if (right && wanted === 'refused') right = got.row?.decision === 'policy' && got.row?.server === server && got.row?.tool === tool && got.result.category === 'external';
    if (right && wanted === 'asks') right = got.row?.decision === 'approved' && got.row?.server === server && got.row?.tool === tool;
    // the card says the server marked the tool destructive exactly when it did
    if (right && wanted === 'asks') right = /destructiveHint/.test(got.request?.reason ?? '') === destructive;
    if (right && wanted === 'runs') right = got.result.category === 'external' && !got.events.some((event) => event.type === 'approval_requested');
    if (right && rule !== undefined && wanted !== 'refused' && hasPolicyHook) right = asked.some((who) => who.server === server && who.tool === tool);
    rows.push(label);
    expect(`matrix: ${label} -> ${wanted}`, right, got.kind === 'throws' ? `throws ${got.error?.code}: ${got.error?.message}` : `${got.kind}${got.row ? ` / row ${got.row.decision} ${got.row.server ?? '-'} ${got.row.tool ?? '-'}` : ''}`);
    gate.shutdown();
  }
  expect('matrix: 3 modes x 3 execution policies x 4 tools x 2 annotation trusts x 3 policies x 4 destructiveHint values = 864 rows', rows.length === 864, rows.length);
  section(`matrix: ${rows.length} rows (${counts.runs} run, ${counts.asks} ask, ${counts.refused} refused, ${counts.throws} threw; the decision itself differs from the owner's table in ${decisionsWrong})`);
}

// ------------------------------------------------------------------ the policy function and the trust flag
{
  // nothing injected at all: every external call asks in review and autonomous, and readonly refuses
  for (const mode of ['review', 'autonomous']) {
    const { gate } = newGate({ mode, attach: false });
    expect(`no policy injected, ${mode}: asks`, (await outcome(gate, 'github.create_issue', { title: 't' })).kind === 'asks');
  }
  {
    const { gate } = newGate({ mode: 'readonly', attach: false });
    expect('no policy injected, readonly: refused even with readOnlyHint', (await outcome(gate, 'memory.search_nodes', { query: 'x' }, { definition: definitionOf('memory.search_nodes') })).kind === 'refused');
  }
  // an injection that leaves a function out gets the default for it: ask, no trust, no description
  for (const given of [undefined, {}, { policyFor: 'allow', trustAnnotations: true, describeServer: 'x' }]) {
    const gate = new PermissionGate({ manager, workspace: studio, timeout: 60_000 });
    gate.attachExternalPolicy?.(given);
    gate.configure({ mode: 'autonomous' });
    const asked = await outcome(gate, 'memory.search_nodes', {}, { definition: definitionOf('memory.search_nodes'), approve: false });
    expect(`attachExternalPolicy(${JSON.stringify(given)}): asks, with no description of the server`, asked.kind === 'asks' && asked.request?.detail?.launch === null, asked.kind);
    gate.configure({ mode: 'readonly' });
    expect(`attachExternalPolicy(${JSON.stringify(given)}): readonly refuses (no allow, no trust)`, (await outcome(gate, 'memory.search_nodes', {}, { definition: definitionOf('memory.search_nodes') })).kind === 'refused');
    gate.shutdown();
  }
  {
    // trust left out while allow is given: a readOnlyHint still counts for nothing
    const gate = new PermissionGate({ manager, workspace: studio, timeout: 60_000 });
    gate.attachExternalPolicy?.({ policyFor: () => 'allow' });
    gate.configure({ mode: 'readonly' });
    expect('allow without trustAnnotations: readonly refuses even with readOnlyHint', (await outcome(gate, 'memory.search_nodes', {}, { definition: definitionOf('memory.search_nodes') })).kind === 'refused');
  }
  // allow is only ever the exact word: anything else the policy answers is not allow (and what cannot be read refuses)
  for (const odd of ['ALLOW', 'Allow', 'yes', true, 1, {}, ['allow'], 'allow ']) {
    const { gate } = newGate({ mode: 'autonomous', rule: odd });
    const got = await outcome(gate, 'github.create_issue', { title: 't' });
    expect(`policy answer ${JSON.stringify(odd)} does not run the call`, got.kind !== 'runs', got.kind);
    expect(`policy answer ${JSON.stringify(odd)} is refused (a policy the gate cannot read fails closed)`, got.kind === 'refused', got.kind);
  }
  for (const nothing of [undefined, null, 'ask']) {
    const { gate } = newGate({ mode: 'autonomous', rule: nothing });
    expect(`policy answer ${JSON.stringify(nothing)} asks`, (await outcome(gate, 'github.create_issue', { title: 't' })).kind === 'asks');
  }
  {
    const { gate } = newGate({ mode: 'autonomous', rule: () => { throw new Error('the policy file is broken'); } });
    const got = await outcome(gate, 'github.create_issue', { title: 't' });
    expect('a policy that throws refuses the call (no exception, no question)', got.kind === 'refused', got.kind);
  }
  {
    const { gate } = newGate({ mode: 'autonomous', exec: 'full-access', rule: () => { throw new Error('broken'); } });
    expect('a policy that throws refuses in Full Access too', (await outcome(gate, 'github.create_issue', { title: 't' })).kind === 'refused');
  }
  {
    // an async policy is awaited
    const { gate } = newGate({ mode: 'autonomous', rule: async () => 'deny' });
    expect('an async policy is awaited (deny)', (await outcome(gate, 'github.create_issue', { title: 't' })).kind === 'refused');
    const allow = newGate({ mode: 'autonomous', rule: async () => 'allow' });
    expect('an async policy is awaited (allow)', (await outcome(allow.gate, 'github.create_issue', { title: 't' })).kind === 'runs');
  }
  {
    // the policy is asked about this server and this tool, per call
    const { gate, asked } = newGate({ mode: 'autonomous', rule: ({ server, tool }) => (server === 'github' && tool === 'list_issues' ? 'allow' : server === 'slack' ? 'deny' : undefined) });
    expect('per tool: github.list_issues allowed', (await outcome(gate, 'github.list_issues', {})).kind === 'runs');
    expect('per tool: github.create_issue still asks', (await outcome(gate, 'github.create_issue', {})).kind === 'asks');
    expect('per server: slack.* denied', (await outcome(gate, 'slack.send_message', {})).kind === 'refused');
    expect('the policy got {server, tool}', JSON.stringify(asked.slice(0, 3)) === JSON.stringify([{ server: 'github', tool: 'list_issues' }, { server: 'github', tool: 'create_issue' }, { server: 'slack', tool: 'send_message' }]), asked);
  }
  // trust: only `true` trusts, and a trusted hint is only a readOnlyHint that is exactly true
  for (const odd of ['true', 1, 'yes', {}]) {
    const { gate } = newGate({ mode: 'readonly', rule: 'allow', trusted: odd });
    expect(`trustAnnotations ${JSON.stringify(odd)} is not trust`, (await outcome(gate, 'memory.search_nodes', {}, { definition: definitionOf('memory.search_nodes') })).kind === 'refused');
  }
  for (const odd of ['true', 1, 'yes', {}, false, undefined]) {
    const { gate } = newGate({ mode: 'readonly', rule: 'allow', trusted: true });
    expect(`readOnlyHint ${JSON.stringify(odd)} is not read-only`, (await outcome(gate, 'memory.search_nodes', {}, { definition: definitionOf('memory.search_nodes', { readOnlyHint: odd }) })).kind === 'refused');
  }
  {
    const { gate } = newGate({ mode: 'readonly', rule: 'allow', trusted: true });
    expect('readonly + allow + trusted readOnlyHint: runs', (await outcome(gate, 'memory.search_nodes', {}, { definition: definitionOf('memory.search_nodes') })).kind === 'runs');
    expect('readonly + allow + trusted, no annotations: refused', (await outcome(gate, 'memory.search_nodes', {}, { definition: { name: 'memory.search_nodes' } })).kind === 'refused');
    expect('readonly + allow + trusted, annotations not an object: refused', (await outcome(gate, 'memory.search_nodes', {}, { definition: { annotations: 'readOnlyHint' } })).kind === 'refused');
  }
  {
    const { gate } = newGate({ mode: 'readonly', rule: undefined, trusted: true });
    expect('readonly + unset + trusted readOnlyHint: refused (a hint is no allow)', (await outcome(gate, 'memory.search_nodes', {}, { definition: definitionOf('memory.search_nodes') })).kind === 'refused');
  }
  for (const mode of ['review', 'autonomous']) {
    const { gate } = newGate({ mode, rule: undefined, trusted: true });
    expect(`${mode} + unset + trusted readOnlyHint: asks (a hint is no allow)`, (await outcome(gate, 'memory.search_nodes', {}, { definition: definitionOf('memory.search_nodes') })).kind === 'asks');
  }
  {
    // the trust is per server
    const { gate } = newGate({ mode: 'readonly', rule: 'allow', trusted: ({ server }) => server === 'memory' });
    expect('trust per server: memory trusted', (await outcome(gate, 'memory.search_nodes', {}, { definition: definitionOf('memory.search_nodes') })).kind === 'runs');
    expect('trust per server: notes not trusted', (await outcome(gate, 'notes.search', {}, { definition: definitionOf('notes.search') })).kind === 'refused');
  }
  {
    const { gate } = newGate({ mode: 'readonly', rule: 'allow', trusted: () => { throw new Error('broken'); } });
    expect('a trust function that throws trusts nothing', (await outcome(gate, 'memory.search_nodes', {}, { definition: definitionOf('memory.search_nodes') })).kind === 'refused');
  }
  section('policyFor (default ask, exact words, fails closed, async, per server and tool) and trustAnnotations (only true, per server)');
}

// ------------------------------------------------------------------ what stays as it was, and what the hooks can add
{
  // a name without a server is refused everywhere, Full Access included
  for (const [mode, exec] of [['review', 'host-review'], ['autonomous', 'host-review'], ['autonomous', 'full-access']]) {
    const { gate } = newGate({ mode, exec, rule: 'allow' });
    for (const name of ['nodot', '.leading', 'trailing.']) expect(`${name} (${mode}/${exec}): refused, no server`, (await outcome(gate, name, {})).kind === 'refused');
  }
  // the operations that Full Access still asks about keep asking, for an external server too, and also under allow: the always-ask names, and a
  // name that says deletion, a reset, a push, a publication or an upload (what the name says only ever ADDS a question). An explicit deny still refuses.
  const IRREVERSIBLE = ['github.github_pr_merge', 'github.github_release_create', 'git.git_push', 'desktop-commander.delete_file', 'github.push_files', 'npm.publish_package',
    'fs.remove_directory', 'db.truncate_table', 'git.reset_hard', 'drive.upload_file', 'cloud.destroy_stack', 'git.force_checkout', 'FS.DELETE_FILE'];
  for (const [exec, rule] of [['full-access', undefined], ['host-review', 'allow'], ['full-access', 'allow']]) {
    const { gate } = newGate({ mode: 'autonomous', exec, rule });
    for (const name of IRREVERSIBLE) expect(`${name} (${exec}, ${rule ?? 'unset'}): asks`, (await outcome(gate, name, {})).kind === 'asks');
  }
  {
    const { gate } = newGate({ mode: 'autonomous', exec: 'full-access', rule: 'deny' });
    for (const name of IRREVERSIBLE.slice(0, 4)) expect(`${name} (full-access, deny): refused`, (await outcome(gate, name, {})).kind === 'refused');
    const readonly = newGate({ mode: 'readonly', rule: 'allow', trusted: true });
    expect('readonly + allow + trusted readOnlyHint, a name that says delete: asks', (await outcome(readonly.gate, 'cache.delete_entry', {}, { definition: definitionOf('cache.delete_entry') })).kind === 'asks');
    const full = newGate({ mode: 'autonomous', exec: 'full-access' });
    // what decides is the tool's name, not its server's: a server called pushover or reset-db says nothing of what each of its tools does
    for (const name of ['desktop-commander.start_process', 'github.create_issue', 'fs.write_file', 'slack.send_message', 'pushover.send_notification', 'reset-db.list_tables', 'upload-service.get_status']) {
      expect(`${name} (full-access, unset): runs`, (await outcome(full.gate, name, {})).kind === 'runs');
    }
    expect('a destructive tool of a server with a destructive name asks (full-access)', (await outcome(full.gate, 'reset-db.drop_and_reset', {})).kind === 'asks');
  }
  // a hook's question (forceAsk) is added on top of allow and of Full Access, never on top of deny
  {
    const allow = newGate({ mode: 'autonomous', rule: 'allow' });
    expect('allow + a hook asks: asks', (await outcome(allow.gate, 'github.create_issue', {}, { forceAsk: true })).kind === 'asks');
    const full = newGate({ mode: 'autonomous', exec: 'full-access' });
    expect('full-access + a hook asks: asks', (await outcome(full.gate, 'github.create_issue', {}, { forceAsk: true })).kind === 'asks');
    const deny = newGate({ mode: 'autonomous', exec: 'full-access', rule: 'deny' });
    expect('deny + a hook asks: refused, no question', (await outcome(deny.gate, 'github.create_issue', {}, { forceAsk: true })).kind === 'refused');
    const readonly = newGate({ mode: 'readonly', rule: 'allow', trusted: true });
    expect('readonly + allow + trusted hint + a hook asks: asks', (await outcome(readonly.gate, 'memory.search_nodes', {}, { forceAsk: true, definition: definitionOf('memory.search_nodes') })).kind === 'asks');
    const refused = newGate({ mode: 'readonly' });
    expect('readonly + unset + a hook asks: refused', (await outcome(refused.gate, 'memory.search_nodes', {}, { forceAsk: true, definition: definitionOf('memory.search_nodes') })).kind === 'refused');
  }
  // nobody to answer: refused at once and recorded; allow still runs (it needs nobody)
  {
    const { gate } = newGate({ mode: 'autonomous' });
    gate.backgroundAgent = true;
    const started = Date.now();
    const got = await outcome(gate, 'github.create_issue', {});
    expect('background agent + unset: refused at once', got.kind === 'refused' && Date.now() - started < 1000, got.kind);
    expect('background agent + unset: recorded with server and tool', got.row?.decision === 'policy' && got.row?.server === 'github' && got.row?.tool === 'create_issue', got.row);
    const allow = newGate({ mode: 'autonomous', rule: 'allow' });
    allow.gate.interactive = false;
    expect('worker + allow: runs', (await outcome(allow.gate, 'github.create_issue', {})).kind === 'runs');
  }
  {
    const { gate } = newGate({ mode: 'autonomous', exec: 'full-access' });
    expect('isolationRequired: refused, Full Access too', (await outcome(gate, 'github.create_issue', { isolationRequired: true })).kind === 'refused');
  }
  // sandbox-only keeps its words for an external server
  {
    const { gate } = newGate({ mode: 'autonomous', exec: 'sandbox-only', rule: 'allow' });
    const got = await outcome(gate, 'desktop-commander.read_file', { path: 'src/app.py' });
    expect('sandbox-only + allow: refused', got.kind === 'refused', got.kind);
    expect('sandbox-only: the reason names the sandbox', /Sandbox-only/.test(got.result?.reason ?? ''), got.result?.reason);
  }
  // the Hub's own tools are decided as before
  {
    const { gate } = newGate({ mode: 'autonomous', rule: 'deny' });
    expect('local.write_file in autonomous: runs (an external deny does not touch it)', (await outcome(gate, 'local.write_file', { path: 'src/new.py', content: 'x' })).kind === 'runs');
    expect('local.run_command rm -rf: asks', (await outcome(gate, 'local.run_command', { command: 'rm -rf build' })).kind === 'asks');
    expect('studio.tree: runs', (await outcome(gate, 'studio.tree', {})).kind === 'runs');
    expect('local.mystery: refused as unclassified', (await outcome(gate, 'local.mystery', {})).kind === 'refused');
    const readonly = newGate({ mode: 'readonly', rule: 'allow', trusted: true });
    expect('local.write_file in readonly: refused (allow is for external tools only)', (await outcome(readonly.gate, 'local.write_file', { path: 'src/n.py', content: 'x' })).kind === 'refused');
  }
  section('a name without a server, the always-ask names, a hook\'s question, nobody to ask, isolation, sandbox-only, the Hub\'s own tools');
}

// ------------------------------------------------------------------ the card and the audit row
{
  const describe = ({ server }) => (server === 'github'
    ? { transport: 'stdio', command: `npx -y @modelcontextprotocol/server-github --token ghp_abcdefghijklmnopqrstuvwxyz0123456789 --password hunter2hunter2` }
    : { transport: 'http', origin: 'https://user:s3cretpass@mcp.example.com:8443/v1/sse?api_key=leakme12345678' });
  const { gate } = newGate({ mode: 'review', describe });
  const args = { owner: 'o', repo: 'r', title: 'Bug', body: `token=supersecret123 ${REGISTERED} curl -u admin:abcdefghijklmnop1234 https://x.example`, password: 'hunter2hunter2', nested: { api_key: 'sk-abcdefghijklmnopqrstuv' } };
  const got = await outcome(gate, 'github.create_issue', args, { approve: false, definition: definitionOf('github.create_issue', {}) });
  const detail = got.request?.detail ?? {};
  expect('card: kind mcp', detail.kind === 'mcp', detail);
  expect('card: the server and the tool', detail.server === 'github' && detail.tool === 'create_issue', detail);
  expect('card: the transport and the command the caller supplied', detail.transport === 'stdio' && /server-github/.test(String(detail.launch)), detail);
  expect('card: the arguments as JSON text', typeof detail.arguments === 'string' && detail.arguments.includes('"title":"Bug"'), detail.arguments);
  const shown = JSON.stringify([got.request?.preview, got.request?.detail, got.request?.summary, got.request?.reason]);
  for (const leaked of ['supersecret123', REGISTERED, 'abcdefghijklmnop1234', 'hunter2hunter2', 'sk-abcdefghijklmnopqrstuv', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']) {
    expect(`card: ${leaked} is masked`, !shown.includes(leaked));
    expect(`history: ${leaked} is masked`, !JSON.stringify(gate.state().recent).includes(leaked));
  }
  expect('card: the request names the server and the tool', got.request?.server === 'github' && got.request?.tool === 'create_issue', got.request);
  expect('history: the row names the server and the tool, and the owner\'s no', got.row?.server === 'github' && got.row?.tool === 'create_issue' && got.row?.decision === 'denied', got.row);
  expect('history: no structured detail in the row', got.row?.detail === undefined);
  expect('history: the preview is bounded', String(got.row?.preview ?? '').length <= 2000);

  const bearer = await outcome(gate, 'github.create_issue', { body: 'Authorization: Bearer abcdefghijklmnop1234' }, { approve: false });
  expect('card: arguments that carry an Authorization header are hidden whole, as on every other card', bearer.request?.detail?.arguments === '[Đã ẩn thông tin xác thực]' && !JSON.stringify(bearer.request).includes('abcdefghijklmnop1234'), bearer.request?.detail?.arguments);

  const http = await outcome(gate, 'remote.search', { q: 'x' }, { approve: false });
  expect('card (http): the origin only, without the user, the password, the path and the query', http.request?.detail?.transport === 'http' && http.request?.detail?.origin === 'https://mcp.example.com:8443', http.request?.detail);
  expect('card (http): nothing of the URL\'s secrets anywhere', !JSON.stringify([http.request, gate.state().recent]).includes('s3cretpass') && !JSON.stringify([http.request, gate.state().recent]).includes('leakme12345678'));

  const bare = newGate({ mode: 'review' });
  const plain = await outcome(bare.gate, 'github.create_issue', { title: 'x' }, { approve: false });
  expect('card without a description of the server: transport, launch and origin are null', plain.request?.detail?.kind === 'mcp' && plain.request.detail.transport === null && plain.request.detail.launch === null && plain.request.detail.origin === null, plain.request?.detail);
  {
    // what the caller says of a server is bounded and read for what it is: a command given as a list is one line, a transport is a short word, an address
    // that is no URL or has no origin (file:) shows nothing, an async description is awaited
    const shapes = [
      [{ transport: 'stdio', command: ['node', 'server.js', '--api-key', 'sk-abcdefghijklmnopqrstuv'] }, (d) => d.launch === 'node server.js --api-key [REDACTED]', 'a command as a list, masked'],
      [{ transport: 'x'.repeat(100), command: `node ${'a'.repeat(5000)}` }, (d) => d.transport.length === 40 && d.launch.length <= 2000, 'a long transport and command are cut'],
      [{ transport: 'http', origin: 'file:///etc/passwd' }, (d) => d.origin === null, 'an address without an origin shows none'],
      [{ transport: 'http', origin: 'not a url' }, (d) => d.origin === null, 'an address that is no URL shows none'],
      [{ transport: 7, command: { run: 'x' }, origin: 5 }, (d) => d.transport === null && d.launch === null && d.origin === null, 'values of another type show nothing'],
      ['not an object', (d) => d.transport === null && d.launch === null && d.origin === null, 'a description that is not an object shows nothing'],
    ];
    for (const [info, test, label] of shapes) {
      const { gate: g } = newGate({ mode: 'review', describe: async () => info });
      const got = await outcome(g, 'github.create_issue', {}, { approve: false });
      expect(`card: ${label}`, got.request?.detail && test(got.request.detail), got.request?.detail);
    }
  }
  const broken = newGate({ mode: 'review', describe: () => { throw new Error('no such server'); } });
  const despite = await outcome(broken.gate, 'github.create_issue', { title: 'x' }, { approve: false });
  expect('a description that throws still draws the card', despite.kind === 'asks' && despite.request?.detail?.kind === 'mcp', despite.kind);
  const huge = await outcome(bare.gate, 'github.create_issue', { body: 'x'.repeat(20_000) }, { approve: false });
  expect('card: long arguments are cut (to the 1,800 characters of every other preview)', String(huge.request?.detail?.arguments ?? '').length <= 1800, String(huge.request?.detail?.arguments ?? '').length);
  expect('card: the arguments are the preview, one text', huge.request?.detail?.arguments === huge.request?.preview);
  {
    const { gate: g } = newGate({ mode: 'review' });
    const waiting = g.authorize({ name: 'github.create_issue', args: {}, taskId: 't' });
    for (let i = 0; i < 100 && g.state().pending.length === 0; i += 1) await delay(5);
    const pending = g.state().pending[0];
    expect('state().pending names the server and the tool', pending?.server === 'github' && pending?.tool === 'create_issue', pending);
    g.shutdown();
    await waiting;
  }
  {
    // a refusal is recorded with the server and the tool too (the owner's deny, readonly, sandbox-only)
    for (const [label, options] of [['deny', { mode: 'autonomous', rule: 'deny' }], ['readonly', { mode: 'readonly' }], ['sandbox-only', { mode: 'autonomous', exec: 'sandbox-only' }]]) {
      const { gate: g } = newGate(options);
      const events = [];
      g.subscribe((event) => events.push(event.type));
      const refused = await outcome(g, 'slack.send_message', { text: 'x' });
      expect(`${label}: refused and recorded with server and tool`, refused.kind === 'refused' && refused.row?.decision === 'policy' && refused.row?.server === 'slack' && refused.row?.tool === 'send_message', refused.row);
      expect(`${label}: tool_policy announced`, events.includes('tool_policy'), events);
    }
  }
  section('the card (kind mcp, server, tool, transport, launch or origin, masked arguments) and the audit row (server and tool)');
}

// ------------------------------------------------------------------ hooks: an external call fires them whatever the gate decided
{
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: repo, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'chatmcp-ci@example.invalid');
  git('config', 'user.name', 'ChatMCP CI');
  await fs.writeFile(path.join(repo, 'README.md'), '# repo\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  const hubDirectory = path.join(root, 'hub');
  const hub = new HubManager({ bundleRoot, dataDirectory: hubDirectory, log: () => {} });
  await hub.load(repo);
  assembleStudio(hub, { bundleRoot });
  await hub.permissions.load();
  await hub.startLocal(repo);
  const gate = hub.permissions;
  let rule;
  if (hasPolicyHook) gate.attachExternalPolicy({ policyFor: () => rule, trustAnnotations: () => false });
  const HOOK = path.join(bundleRoot, 'tests', 'fixtures', 'hook-program.mjs');
  const handler = (spec) => ({ type: 'command', command: process.execPath, args: [HOOK, JSON.stringify(spec)] });
  let logs = 0;
  const readLines = (file) => (fsSync.existsSync(file) ? fsSync.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  /** The hooks for this case: a PreToolUse and a PostToolUseFailure hook on the alias of the tool; `pre` adds what the PreToolUse hook answers. */
  async function hooks(pre = {}) {
    logs += 1;
    const files = { pre: path.join(root, `pre-${logs}.log`), post: path.join(root, `post-${logs}.log`) };
    await fs.writeFile(path.join(hubDirectory, 'hooks.json'), JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: 'mcp__github__create_issue', hooks: [handler({ log: files.pre, ...pre })] }],
      PostToolUseFailure: [{ matcher: 'mcp__github__create_issue', hooks: [handler({ log: files.post })] }],
    } }));
    return files;
  }
  const TASK = randomUUID();
  hub.acquireTask(TASK);
  const session = await hub.createAgentSession();
  session.catalog.tools.push(definitionOf('github.create_issue', {}));
  const NAME = 'github.create_issue';
  const text = (result) => (result?.content ?? []).map((part) => part.text ?? '').join('\n');
  /** One call through the guard; `answer` says yes or no to a question, or nothing when none is expected. */
  async function call(answer) {
    const decisions = [];
    let settled = null;
    const run = session.callTool(NAME, { title: 'from the model' }, { onDecision: (info) => decisions.push(info) });
    run.then((value) => { settled = { value }; }, (thrown) => { settled = { thrown }; });
    let asked = null;
    for (let i = 0; i < 400 && !settled && gate.state().pending.length === 0; i += 1) await delay(10);
    if (!settled && gate.state().pending.length) { asked = gate.state().pending[0]; gate.decide(asked.id, answer === true); }
    for (let i = 0; i < 1000 && !settled; i += 1) await delay(10);
    return { ...settled, asked, decisions };
  }
  const ran = (got) => /Không có công cụ github\.create_issue/.test(String(got.thrown?.message ?? ''));
  const cases = [
    ['asked and approved', { mode: 'review' }, undefined, true, { asked: true, ran: true, post: 1 }],
    ['asked and declined', { mode: 'review' }, undefined, false, { asked: true, ran: false, post: 0, code: 'permission_denied' }],
    ['allowed (allow, autonomous)', { mode: 'autonomous' }, 'allow', undefined, { asked: false, ran: true, post: 1 }],
    ['denied (deny, Full Access)', { mode: 'full-access', confirmation: 'FULL ACCESS' }, 'deny', undefined, { asked: false, ran: false, post: 0, code: 'permission_denied' }],
    ['refused (readonly)', { mode: 'readonly' }, undefined, undefined, { asked: false, ran: false, post: 0, code: 'permission_denied' }],
  ];
  for (const [label, configure, policy, answer, wanted] of cases) {
    gate.configure({ ...configure, leaveFullAccess: configure.mode !== 'full-access' });
    rule = policy;
    const files = await hooks();
    const got = await call(answer);
    const pre = readLines(files.pre);
    expect(`hooks, ${label}: PreToolUse fired once`, pre.length === 1, pre.length);
    expect(`hooks, ${label}: with the tool name github.create_issue`, pre[0]?.tool === NAME, pre[0]);
    expect(`hooks, ${label}: asked = ${wanted.asked}`, Boolean(got.asked) === wanted.asked, got.asked ? 'asked' : 'not asked');
    expect(`hooks, ${label}: reached the external backend = ${wanted.ran}`, ran(got) === wanted.ran, got.thrown?.message ?? text(got.value));
    if (wanted.code) expect(`hooks, ${label}: refused as ${wanted.code}`, got.value?.structuredContent?.error?.code === wanted.code, got.value?.structuredContent);
    expect(`hooks, ${label}: PostToolUseFailure fired ${wanted.post} time(s)`, readLines(files.post).length === wanted.post, readLines(files.post).length);
    expect(`hooks, ${label}: one onDecision`, got.decisions.length === 1 && got.decisions[0].allowed === wanted.ran && got.decisions[0].category === (hasPolicyHook ? 'external' : got.decisions[0].category), got.decisions);
  }
  {
    // a hook's veto on an allowed external call: nothing reaches the server
    gate.configure({ mode: 'autonomous', leaveFullAccess: true });
    rule = 'allow';
    const files = await hooks({ exit: 2, stderr: 'no issues today' });
    const got = await call();
    expect('hooks, veto: hook_denied', got.value?.structuredContent?.error?.code === 'hook_denied', got.value?.structuredContent ?? got.thrown?.message);
    expect('hooks, veto: the server was not reached', !ran(got) && readLines(files.post).length === 0);
  }
  {
    // a hook's question on an allowed external call: the owner is asked once, on the mcp card
    rule = 'allow';
    const files = await hooks({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'check the issue first' } }) });
    const got = await call(false);
    expect('hooks, question: the owner was asked', got.asked !== null, got);
    expect('hooks, question: on the mcp card with the hook\'s reason', got.asked?.detail?.kind === 'mcp' && /check the issue first/.test(got.asked?.reason ?? ''), got.asked);
    expect('hooks, question: declined, nothing reached the server', !ran(got) && got.value?.structuredContent?.error?.code === 'permission_denied');
    expect('hooks, question: PreToolUse fired once', readLines(files.pre).length === 1);
  }
  gate.shutdown();
  await hub.shutdown?.().catch?.(() => {});
  section('hooks: asked, approved, declined, allowed, denied and refused external calls fire PreToolUse once as github.create_issue (matched by mcp__github__create_issue); a veto and a question work on top of allow');
}

await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }).catch(() => {});
await fs.rm(OUTSIDE, { force: true }).catch(() => {});
if (failures.length) {
  console.error(`FAIL: ${failures.length} of ${checks} MCP gate checks failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS: ${checks} MCP gate checks`);
