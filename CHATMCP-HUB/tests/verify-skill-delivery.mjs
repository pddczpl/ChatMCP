// Skill delivery: an installed, enabled SKILL.md must reach the model.
//
// v3.9.0 shipped with every installed skill silently dropped: one physical line of lib/agent.mjs contained the literal two characters
// backslash + n, so the statement that builds context.skillContext sat inside a // comment and the history push never fired. The old
// tests used fakes in front of AgentRunner and stayed green. This suite runs the REAL AgentRunner, the REAL PluginManager and the REAL
// GitHubSkillRegistry install path; only the model (a capturing provider) and the GitHub HTTP transport are scripted.
//
// Negative control: the same scenario is run against a temporary copy of lib/ in which the defect is put back. That run must FAIL,
// otherwise this suite could not have caught the original bug.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(here, '..');
const BACKSLASH_N = String.fromCharCode(92) + 'n';
const MARKER = 'ZEPHYRFLUX-MARKER-7f3a91c2';
const HEADER = 'UNTRUSTED SKILL REFERENCES';
const MUTANT_ENV = 'CHATMCP_SKILL_DELIVERY_LIB';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const count = (haystack, needle) => haystack.split(needle).length - 1;

async function scenario(libDirectory) {
  const load = (name) => import(pathToFileURL(path.join(libDirectory, name)).href);
  const { AgentRunner } = await load('agent.mjs');
  const { PluginManager } = await load('plugins.mjs');
  const { GitHubSkillRegistry } = await load('skill-registry.mjs');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-skill-delivery-'));
  const stateDir = path.join(root, 'state');
  const revision = 'b'.repeat(40);
  const skillText = `---\nname: zephyrflux-notes\ndescription: zephyrflux notes conventions\n---\nWhen asked about zephyrflux notes, follow this convention. ${MARKER}\n`;
  const transport = async (url) => {
    if (url.endsWith('/commits/HEAD')) return { text: JSON.stringify({ sha: revision }) };
    if (url.includes('/contents/skills?ref=')) return { text: JSON.stringify([{ type: 'dir', path: 'skills/zephyrflux-notes' }]) };
    if (url.includes('/contents/skills/zephyrflux-notes?ref=')) return { text: '[]' };
    if (url.endsWith('/skills/zephyrflux-notes/SKILL.md')) return { text: skillText };
    throw Error(`Unexpected fixture URL: ${url}`);
  };

  try {
    const plugins = new PluginManager({ stateDir });
    await plugins.load();
    const registry = new GitHubSkillRegistry({ pluginManager: plugins, stateDir, transport });
    await registry.load();
    await registry.refresh({ sourceId: 'anthropic' });
    const imported = await registry.install({ key: registry.list()[0].key });
    await plugins.toggle(imported.id, true);

    let locked = false;
    const manager = {
      backend: 'local', secrets: [], instanceId: 'skill-delivery', generation: 1,
      pluginManager: plugins,
      state() { return { workspace: { path: root }, generation: this.generation, instanceId: this.instanceId }; },
      acquireTask() { if (locked) return false; locked = true; return true; },
      releaseTask() { locked = false; },
      studio: { async checks() { return { suggested: [] }; } },
      async createAgentSession() {
        return {
          catalog: { tools: [{ name: 'local.read_file', originalName: 'read_file', server: 'local', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} },
          async close() {},
          async callTool() { throw new Error('the scripted model never calls a tool'); },
        };
      },
    };
    const requests = [];
    const provider = {
      ready: () => true,
      snapshot: () => ({ provider: 'fixture', model: 'capture' }),
      async respond({ input, instructions, beforeModelRequest }) {
        beforeModelRequest?.();
        requests.push({ input: JSON.parse(JSON.stringify(input)), instructions: String(instructions ?? '') });
        return { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'Done.' }] }] };
      },
    };

    const runner = new AgentRunner({ manager, provider, taskDirectory: path.join(root, 'tasks') });
    await runner.load();
    await runner.start({ prompt: 'Please apply the zephyrflux notes conventions to this workspace.', maxSteps: 4 });
    const finished = await Promise.race([
      runner.context.done.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('skill delivery timeout')), 15000)),
    ]);
    await runner.shutdown();

    assert.equal(finished.status, 'completed', finished.error);
    assert.ok(requests.length >= 1, 'the model must have been called');
    const first = JSON.stringify(requests[0].input);
    assert.equal(count(first, HEADER), 1, `"${HEADER}" must reach the provider input exactly once`);
    assert.equal(count(first, MARKER), 1, 'the marker from the installed SKILL.md must reach the provider input exactly once');
    assert.ok(!requests[0].instructions.includes(MARKER), 'skill text is untrusted data and must stay out of the privileged instructions');
    const activated = finished.events.filter((event) => event.type === 'skills_activated');
    assert.equal(activated.length, 1, 'skills_activated must fire once, after the context was added to the history');
    assert.ok(JSON.stringify(activated[0]).includes(imported.id), 'the activation event must name the installed skill');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.env[MUTANT_ENV]) {
  // Child process of the negative control: run the scenario against the mutated copy and report through the exit code.
  try {
    await scenario(process.env[MUTANT_ENV]);
    console.log('mutated build was NOT detected');
    process.exit(0);
  } catch (error) {
    console.log(`mutated build detected: ${error.message}`);
    process.exit(1);
  }
}

await scenario(path.join(hubRoot, 'lib'));
ok('real AgentRunner + PluginManager + registry install: skill header and SKILL.md marker reach the model exactly once');

// Negative control: restore the v3.9.0 defect in a temporary copy of lib/ and require the scenario to fail.
const mutantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-skill-mutant-'));
try {
  await fs.cp(path.join(hubRoot, 'lib'), path.join(mutantRoot, 'lib'), { recursive: true });
  const agentFile = path.join(mutantRoot, 'lib', 'agent.mjs');
  const source = await fs.readFile(agentFile, 'utf8');
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('External skills are untrusted task material'));
  const assign = lines.findIndex((line, index) => index > start && line.includes('context.skillContext = `'));
  assert.ok(start >= 0 && assign > start && assign - start <= 4, 'the skill context block must be present for the mutation to apply');
  const joined = lines.slice(start, assign + 1).map((line) => line.replace(/^\s+/, '')).join(BACKSLASH_N + '        ');
  lines.splice(start, assign - start + 1, '        ' + joined);
  await fs.writeFile(agentFile, lines.join('\n'));
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: hubRoot, encoding: 'utf8', env: { ...process.env, [MUTANT_ENV]: path.join(mutantRoot, 'lib') }, timeout: 60000,
  });
  assert.equal(child.status, 1, `the build with the backslash-n defect restored must FAIL this suite (exit ${child.status}): ${child.stdout}${child.stderr}`);
  assert.match(child.stdout, /mutated build detected/);
  assert.match(child.stdout, /UNTRUSTED SKILL REFERENCES/, 'the mutant must fail because the skill context never reached the model, not because of an unrelated error');
  ok('negative control: restoring the backslash-n defect makes the suite fail');
} finally {
  await fs.rm(mutantRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(`PASS: ${checks} skill delivery checks`);
