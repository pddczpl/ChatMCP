// Skill delivery: an installed, enabled SKILL.md must reach the model.
//
// v3.9.0 shipped with every installed skill silently dropped: one physical line of lib/agent.mjs contained the literal two characters
// backslash + n, so the statement that builds context.skillContext sat inside a // comment and the history push never fired. The old
// tests used fakes in front of AgentRunner and stayed green. This suite runs the REAL AgentRunner, the REAL PluginManager and the REAL
// GitHubSkillRegistry install path; only the model (a capturing provider) and the GitHub HTTP transport are scripted.
//
// Negative control: the same scenario is run against a temporary copy of lib/ in which the defect is put back. That run must FAIL,
// otherwise this suite could not have caught the original bug.
// CLAIM: skills-reach-model
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

// Skills follow the conversation. start() selected them on task.prompt, the FIRST prompt of the conversation, in every run: a continuation was given
// the skills of its first message and never those of the message it answers, and a message queued during a run influenced nothing. The history of a
// run is built again from the conversation checkpoint (the earlier prompts and events, no skill text), so what a run is given is what its own
// selection says. Same real AgentRunner and real PluginManager; five small skills with one made-up word each (a prompt names a skill or it does not)
// and bulky ones for the character budget; the capturing provider records what each request carried.
const WORDS = ['zephyrflux', 'quillmark', 'brontide', 'cobaltreef', 'ambergate'];
const BULK = { bulkalpha: 5000, bulkbeta: 4000 };
const ALL = [...WORDS, ...Object.keys(BULK), 'tinydot'];
const skillTextOf = (word) => `${word.toUpperCase()}-SKILL-TEXT-9b2e41`;
const conversationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-skill-conversation-'));
try {
  const { AgentRunner } = await import('../lib/agent.mjs');
  const { PluginManager } = await import('../lib/plugins.mjs');
  const plugins = new PluginManager({ stateDir: path.join(conversationRoot, 'state') });
  await plugins.load();
  // A fresh state provisions three skills whose words ("test", "file", "commit" ...) match ordinary prompts; only the skills of this test are on.
  for (const installed of plugins.installed()) await plugins.toggle(installed.id, false);
  // Installed in this order: a tie in score is broken by it, and tinydot comes after the bulky ones that a prompt names beside it.
  for (const [word, padding] of [...WORDS.map((word) => [word, 0]), ...Object.entries(BULK), ['tinydot', 0]]) {
    await plugins.install(word, { name: word, description: word, tools: [], systemPrompt: `Reference text for ${word}. ${skillTextOf(word)} ${'x'.repeat(padding)}` });
  }

  const finalAnswer = (text) => ({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] }] });
  const readFile = (callId) => ({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'function_call', call_id: callId, name: 'read_file', status: 'completed', arguments: JSON.stringify({ path: 'package.json' }) }] });
  let chats = 0;
  // script({requests, runner}) answers the model; onSession({runner}) runs while a run is preparing: the task is running and its skills are not selected yet.
  const chat = async ({ script = () => finalAnswer('Done.'), onSession = null } = {}) => {
    const requests = [];
    let locked = false;
    let id = null;
    const manager = {
      backend: 'local', secrets: [], instanceId: 'skill-conversation', generation: 1,
      pluginManager: plugins,
      state() { return { workspace: { path: conversationRoot }, generation: this.generation, instanceId: this.instanceId }; },
      acquireTask() { if (locked) return false; locked = true; return true; },
      releaseTask() { locked = false; },
      studio: { async checks() { return { suggested: [] }; } },
      async createAgentSession() {
        await onSession?.({ runner });
        return {
          catalog: { tools: [{ name: 'local.read_file', originalName: 'read_file', server: 'local', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} },
          async close() {},
          async callTool() { return { isError: false, content: [{ type: 'text', text: '{"version":"1.0.0"}' }], structuredContent: { notVerified: true } }; },
        };
      },
    };
    const provider = {
      ready: () => true,
      snapshot: () => ({ provider: 'fixture', model: 'capture' }),
      async respond({ input, instructions, beforeModelRequest }) {
        beforeModelRequest?.();
        requests.push({ input: structuredClone(input), instructions: String(instructions ?? '') });
        return script({ requests, runner });
      },
    };
    const runner = new AgentRunner({ manager, provider, taskDirectory: path.join(conversationRoot, `tasks-${(chats += 1)}`) });
    await runner.load();
    // One message of the conversation: the first starts it, the others continue it. Resolves with the model requests that run made.
    const say = async (prompt) => {
      const before = requests.length;
      id = (id === null ? await runner.start({ prompt, maxSteps: 6 }) : await runner.continue({ id, prompt, maxSteps: 6 })).id;
      for (let i = 0; i < 1500 && runner.get(id).status === 'running'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(runner.get(id).status, 'completed', runner.get(id).error);
      return requests.slice(before);
    };
    return { runner, requests, say, get id() { return id; } };
  };
  // The skills a request carried, in the order they appear; each exactly once and none of them in the privileged instructions.
  const delivered = (request) => {
    const input = JSON.stringify(request.input);
    const words = ALL.filter((word) => input.includes(skillTextOf(word)));
    for (const word of words) assert.equal(count(input, skillTextOf(word)), 1, `the text of ${word} must reach the model exactly once`);
    assert.ok(!words.some((word) => request.instructions.includes(skillTextOf(word))), 'skill text is untrusted data and must stay out of the privileged instructions');
    return words.sort((a, b) => input.indexOf(skillTextOf(a)) - input.indexOf(skillTextOf(b)));
  };
  const activations = (c) => c.runner.get(c.id).events.filter((event) => event.type === 'skills_activated').map((event) => event.selectedSkills);

  // The problem as it was reported: the continuation names another skill than the first message.
  {
    const c = await chat();
    try {
      const [one] = await c.say('Please apply the zephyrflux conventions to this workspace.');
      const [two] = await c.say('Now export the report with quillmark.');
      assert.deepEqual(delivered(one), ['zephyrflux'], 'the first message is given the skill it names');
      assert.deepEqual(delivered(two), ['quillmark', 'zephyrflux'], 'the continuation is given the skill its own message names, then the one the conversation has been using');
      assert.deepEqual(activations(c), [['zephyrflux'], ['quillmark', 'zephyrflux']], 'and the skills_activated event of each run names what that run was given');
    } finally { await c.runner.shutdown(); }
  }
  ok('a continuation is given the skills its own message names, the conversation\'s after them');

  // A follow-up that names nothing keeps the skills of the messages it answers, newest first.
  {
    const c = await chat();
    try {
      await c.say('Please apply the zephyrflux conventions to this workspace.');
      const [two] = await c.say('yes, go ahead');
      assert.deepEqual(delivered(two), ['zephyrflux'], '"yes, go ahead" is still given the skill of the request it answers');
      await c.say('Now export the report with quillmark.');
      const [four] = await c.say('ok');
      assert.deepEqual(delivered(four), ['quillmark', 'zephyrflux'], 'and "ok" after two requests both, newest first');
    } finally { await c.runner.shutdown(); }
  }
  ok('a follow-up that names no skill keeps the skills of the conversation, newest first');

  // A message queued while a run is going is delivered to that run, which keeps the skills it started with (the skill text sits in front of the
  // prompt, where a later message cannot go); the next run of the conversation selects on the queued message too, though "ok" names nothing.
  {
    const queued = 'Also export the report with quillmark.';
    const c = await chat({ script: async ({ requests, runner }) => {
      if (requests.length > 1) return finalAnswer('Done.');
      await runner.enqueueMessage({ id: runner.activeTaskId, prompt: queued });
      return readFile('call-1');
    } });
    try {
      const [one, two] = await c.say('Please apply the zephyrflux conventions to this workspace.');
      assert.equal(c.requests.length, 2);
      assert.ok(!JSON.stringify(one.input).includes(queued) && JSON.stringify(two.input).includes(queued), 'the message reaches the model, in the same run');
      assert.deepEqual([delivered(one), delivered(two)], [['zephyrflux'], ['zephyrflux']], 'the run keeps the skills it started with');
      const [next] = await c.say('ok');
      assert.deepEqual(delivered(next), ['quillmark', 'zephyrflux'], 'the next run is given the skill the queued message names');
    } finally { await c.runner.shutdown(); }
  }
  ok('a message queued during a run counts when the next run selects, and the run keeps its skills');

  // A message queued while the run is still preparing (the task is running, the skills are not selected yet) is part of the conversation when they
  // are, and the run's own prompt is not counted twice or taken for an earlier one.
  {
    const first = 'Please apply the zephyrflux conventions to this workspace.';
    const queued = 'Also export the report with quillmark.';
    let queuedYet = false;
    const c = await chat({ onSession: async ({ runner }) => {
      if (queuedYet) return;
      queuedYet = true;
      await runner.enqueueMessage({ id: runner.activeTaskId, prompt: queued });
    } });
    // The selector itself is the real one; this only records what it is asked about.
    const asked = [];
    plugins.selectSkillsForTask = (options) => { asked.push(options.prompt); return PluginManager.prototype.selectSkillsForTask.call(plugins, options); };
    try {
      const [one] = await c.say(first);
      assert.deepEqual(delivered(one), ['zephyrflux', 'quillmark'], 'the run\'s own prompt first, then the message queued while it was preparing');
      assert.deepEqual(asked, [first, queued], 'one pass for the run\'s own prompt and one for each earlier prompt: the run\'s own entry is not among the earlier ones');
    } finally { delete plugins.selectSkillsForTask; await c.runner.shutdown(); }
  }
  ok('a message queued while the run is preparing counts in that run, behind the run\'s own prompt');

  // The list holds 4 skills. The newest prompts take the places, so the skill of the first of five requests is dropped, and its text from the run
  // that was given it does not ride along in the checkpoint.
  {
    const c = await chat();
    try {
      for (const word of WORDS) await c.say(`Use ${word}.`);
      const [six] = await c.say('ok');
      assert.deepEqual(delivered(six), ['ambergate', 'cobaltreef', 'brontide', 'quillmark'], 'at most 4 skills, the newest prompts first');
      assert.ok(!JSON.stringify(six.input).includes(skillTextOf('zephyrflux')), 'the skill no run selects now is not in the history (it starts from the checkpoint, which has no skill text)');
      assert.ok(JSON.stringify(six.input).includes('zephyrflux'), '(but the checkpoint does show the first prompt, by name)');
    } finally { await c.runner.shutdown(); }
  }
  ok('a run is given at most 4 skills, newest prompts first, and no skill text of an earlier run');

  // The run's own prompt selects first. Joined, these prompts lose the skill the newest one names (the score of the four skills of the first prompt
  // ties with it and the limit cuts the last installed); a message is given at least what it is given as the first message of a conversation.
  {
    const earlier = 'Use zephyrflux, quillmark, brontide and cobaltreef.';
    const current = 'Now ambergate.';
    const idsOf = (skills) => skills.map((skill) => skill.id);
    assert.deepEqual(idsOf(plugins.selectSkillsForTask({ prompt: current })), ['ambergate']);
    assert.ok(!idsOf(plugins.selectSkillsForTask({ prompt: `${earlier}\n${current}` })).includes('ambergate'), '(and the prompts joined lose ambergate; if the scoring changes, pick another pair)');
    const alone = await chat();
    const c = await chat();
    try {
      const [first] = await alone.say(current);
      await c.say(earlier);
      const [two] = await c.say(current);
      assert.deepEqual(delivered(two).slice(0, delivered(first).length), delivered(first), 'the message is given what it is given alone, first');
      assert.deepEqual(delivered(two), ['ambergate', 'zephyrflux', 'quillmark', 'brontide'], 'and the skills of the request before fill the places that are left');
    } finally { await alone.runner.shutdown(); await c.runner.shutdown(); }
  }
  ok('the newest message is given at least what it is given alone, even where that evicts the conversation\'s skills');

  // The 8,000 characters hold across the prompts: a skill from an earlier prompt that no longer fits is skipped, the others still get in.
  {
    const c = await chat();
    try {
      await c.say('Use zephyrflux.');
      await c.say('Use bulkalpha.');
      await c.say('Use bulkbeta.');
      const [four] = await c.say('ok');
      assert.deepEqual(delivered(four), ['bulkbeta', 'zephyrflux'], 'bulkalpha (5,000 characters) does not fit beside bulkbeta (4,000) and is skipped; the older zephyrflux fits');
    } finally { await c.runner.shutdown(); }
    // Skipped, not the end of that prompt's list: tinydot, named after bulkalpha in the same prompt, still gets in.
    const d = await chat();
    try {
      await d.say('Use bulkalpha and tinydot.');
      await d.say('Use bulkbeta.');
      const [three] = await d.say('ok');
      assert.deepEqual(delivered(three), ['bulkbeta', 'tinydot'], 'bulkalpha is skipped, tinydot after it in the same prompt is carried');
    } finally { await d.runner.shutdown(); }
  }
  ok('the character budget holds across the prompts of the conversation');

  // The same selection as a pure function, over many histories.
  {
    // Imported here and not at the top: run against an agent.mjs without it, the blocks above fail first, on the behaviour they test.
    const { selectConversationSkills } = await import('../lib/agent.mjs');
    await plugins.install('bulkhuge', { name: 'bulkhuge', description: 'bulkhuge', tools: [], systemPrompt: 'h'.repeat(9000) });
    const vocabulary = [...WORDS, ...Object.keys(BULK), 'bulkhuge', 'ok', 'please', 'and', 'then', 'the'];
    let seed = 20241020;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const prompt = () => Array.from({ length: Math.floor(random() * 4) }, () => vocabulary[Math.floor(random() * vocabulary.length)]).join(' ');
    const alone = (text) => plugins.selectSkillsForTask({ prompt: text, limit: 4, tokenBudget: 8000 });
    const idsOf = (skills) => skills.map((skill) => skill.id);
    const characters = (skills) => skills.reduce((sum, skill) => sum + skill.systemPrompt.length, 0);
    for (let i = 0; i < 400; i += 1) {
      const run = prompt();
      assert.deepEqual(selectConversationSkills(plugins, run), alone(run), `"${run}": a conversation of one message is selected as before`);
      const history = Array.from({ length: Math.floor(random() * 26) }, prompt);
      const result = selectConversationSkills(plugins, run, history);
      const own = alone(run);
      assert.deepEqual(result.slice(0, own.length), own, `"${run}" after ${history.length} prompts is given what it is given alone, first`);
      assert.ok(result.length <= 4 && new Set(idsOf(result)).size === result.length, 'at most 4 skills, each once');
      assert.ok(characters(result) <= 8000, `within the 8,000 characters: ${characters(result)}`);
      const named = new Set([run, ...history.slice(-20)].flatMap((text) => idsOf(alone(text))));
      assert.ok(idsOf(result).every((id) => named.has(id)), 'and every skill is one that some prompt of the window selects by itself');
    }
    // Only the last 20 earlier prompts are read (the window the checkpoint shows the model) ...
    assert.deepEqual(idsOf(selectConversationSkills(plugins, 'ok', ['Use zephyrflux.', ...Array(20).fill('ok')])), [], 'the 21st prompt back is not read');
    assert.deepEqual(idsOf(selectConversationSkills(plugins, 'ok', ['Use zephyrflux.', ...Array(19).fill('ok')])), ['zephyrflux'], 'the 20th is');
    // ... newest first when there is room for one of two ...
    assert.deepEqual(idsOf(selectConversationSkills(plugins, 'ok', ['Use zephyrflux.', 'Use quillmark.'], { limit: 1 })), ['quillmark']);
    assert.deepEqual(idsOf(selectConversationSkills(plugins, 'ok', ['Use quillmark.', 'Use zephyrflux.'], { limit: 1 })), ['zephyrflux']);
    // ... a skill that two prompts select is given once ...
    assert.deepEqual(idsOf(selectConversationSkills(plugins, 'Use quillmark.', ['Use quillmark.', 'Use zephyrflux.'])), ['quillmark', 'zephyrflux']);
    // ... an oversized skill is cut to the budget and then stands alone, as selectSkillsForTask makes it: the run's own prompt keeps it, an earlier
    // prompt's is carried only when nothing else was chosen, and never in beside another skill.
    assert.deepEqual(selectConversationSkills(plugins, 'Use bulkhuge.', ['Use bulkbeta.']), alone('Use bulkhuge.'));
    assert.deepEqual(selectConversationSkills(plugins, 'ok', ['Use bulkhuge.']), alone('Use bulkhuge.'));
    assert.deepEqual(idsOf(selectConversationSkills(plugins, 'Use bulkbeta.', ['Use bulkhuge.'])), ['bulkbeta']);
    // The prompts joined would select a skill that no prompt selects: one point for each of the three words of its description, and 3 is the threshold.
    await plugins.install('threefold', { name: 'threefold', description: 'amberone ambertwo amberthree', tools: [], systemPrompt: 'Reference text for threefold.' });
    const spread = ['Mention amberone.', 'Mention ambertwo.', 'Mention amberthree.'];
    assert.deepEqual(spread.map((text) => idsOf(alone(text))), [[], [], []]);
    assert.deepEqual(idsOf(alone(spread.join('\n'))), ['threefold'], '(the premise: joined, the three messages pass the threshold; if the scoring changes, pick another example)');
    assert.deepEqual(selectConversationSkills(plugins, spread[2], spread.slice(0, 2)), [], 'no skill is selected on words spread over messages');
  }
  ok('the helper: one message as before, the run\'s own selection first, at most 4 skills and 8,000 characters, 20 earlier prompts, newest first');
} finally {
  await fs.rm(conversationRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(`PASS: ${checks} skill delivery checks`);
