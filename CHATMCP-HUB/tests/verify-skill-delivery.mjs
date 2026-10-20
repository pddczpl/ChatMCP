// Skill delivery: an installed, enabled SKILL.md must reach the model.
//
// v3.9.0 shipped with every installed skill silently dropped: one physical line of lib/agent.mjs contained the literal two characters
// backslash + n, so the statement that builds context.skillContext sat inside a // comment and the history push never fired. The old
// tests used fakes in front of AgentRunner and stayed green. This suite runs the REAL AgentRunner, the REAL PluginManager and the REAL
// GitHubSkillRegistry install path; only the model (a capturing provider) and the GitHub HTTP transport are scripted.
//
// Negative control: the same scenario is run against a temporary copy of lib/ in which the defect is put back. That run must FAIL,
// otherwise this suite could not have caught the original bug.
//
// Which skills a run is given (the conversation's, and the scorer that picks them from a prompt) is checked in the blocks after the negative control.
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
  // A fresh state provisions three skills whose words ("git", "commit", "secret" ...) match ordinary prompts; only the skills of this test are on.
  for (const installed of plugins.installed()) await plugins.toggle(installed.id, false);
  // Installed in this order: a tie in score is broken by it, and tinydot comes after the bulky ones that a prompt names beside it.
  for (const [word, padding] of [...WORDS.map((word) => [word, 0]), ...Object.entries(BULK), ['tinydot', 0]]) {
    await plugins.install(word, { name: word, description: word, tools: [], systemPrompt: `Reference text for ${word}. ${skillTextOf(word)} ${'x'.repeat(padding)}` });
  }

  const finalAnswer = (text) => ({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] }] });
  const readFile = (callId) => ({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'function_call', call_id: callId, name: 'read_file', status: 'completed', arguments: JSON.stringify({ path: 'package.json' }) }] });
  const READ_FILE = { name: 'local.read_file', originalName: 'read_file', server: 'local', inputSchema: { type: 'object' } };
  let chats = 0;
  // script({requests, runner}) answers the model; onSession({runner}) runs while a run is preparing: the task is running and its skills are not selected yet.
  // pluginManager, tools (the catalog the scripted tool session offers) and toolSelectionMode are the skills above, read_file alone and the runner's default.
  const chat = async ({ script = () => finalAnswer('Done.'), onSession = null, pluginManager = plugins, tools = [READ_FILE], toolSelectionMode = null } = {}) => {
    const requests = [];
    let locked = false;
    let id = null;
    const manager = {
      backend: 'local', secrets: [], instanceId: 'skill-conversation', generation: 1,
      pluginManager,
      state() { return { workspace: { path: conversationRoot }, generation: this.generation, instanceId: this.instanceId }; },
      acquireTask() { if (locked) return false; locked = true; return true; },
      releaseTask() { locked = false; },
      studio: { async checks() { return { suggested: [] }; } },
      async createAgentSession() {
        await onSession?.({ runner });
        return {
          catalog: { tools, prompts: [], resources: [], resourceTemplates: [], servers: {} },
          async close() {},
          async callTool() { return { isError: false, content: [{ type: 'text', text: '{"version":"1.0.0"}' }], structuredContent: { notVerified: true } }; },
        };
      },
    };
    const provider = {
      ready: () => true,
      snapshot: () => ({ provider: 'fixture', model: 'capture' }),
      async respond({ input, instructions, tools: offered, beforeModelRequest }) {
        beforeModelRequest?.();
        requests.push({ input: structuredClone(input), instructions: String(instructions ?? ''), tools: (offered ?? []).map((tool) => tool.name) });
        return script({ requests, runner });
      },
    };
    const taskDirectory = path.join(conversationRoot, `tasks-${(chats += 1)}`);
    const runner = new AgentRunner({ manager, provider, taskDirectory, toolSelectionMode });
    await runner.load();
    // One message of the conversation: the first starts it, the others continue it. Resolves with the model requests that run made. `options` are
    // more arguments of runner.start() for the message that starts the conversation.
    const say = async (prompt, options = {}) => {
      const before = requests.length;
      id = (id === null ? await runner.start({ prompt, ...options, maxSteps: 6 }) : await runner.continue({ id, prompt, maxSteps: 6 })).id;
      for (let i = 0; i < 1500 && runner.get(id).status === 'running'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(runner.get(id).status, 'completed', runner.get(id).error);
      return requests.slice(before);
    };
    return { runner, requests, say, manager, provider, taskDirectory, get id() { return id; } };
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

  // The scorer. selectSkillsForTask gave a prompt word +3 when it was a substring of one of a skill's tool names, which is the whole threshold: "file", "read"
  // and "run" selected most of the nine skills the Hub ships on their own, "and" selected four because it sits inside "command", and every word a description
  // shares added +1, "the" and "for" included. A prompt in ordinary words filled the limit of 4 skills by itself, and the Hub's own auto-resume and repair
  // prompts, which select first as the run's own prompt, took the places of the skills the conversation had been using. The real PluginManager with the
  // nine shipped skills enabled, the prompts of the tool-selector corpus, and the texts the Hub writes itself.
  {
    const { MARKETPLACE_CATALOG } = await import('../lib/plugins.mjs');
    const { selectConversationSkills } = await import('../lib/agent.mjs');
    const shipped = new PluginManager({ stateDir: path.join(conversationRoot, 'shipped-state') });
    await shipped.load();
    for (const item of MARKETPLACE_CATALOG) {
      if (!shipped.installed().some((installed) => installed.id === item.id)) await shipped.install(item.id);
    }
    assert.equal(MARKETPLACE_CATALOG.length, 9, 'the numbers below are about the nine skills the Hub ships');
    assert.deepEqual(shipped.activeSkills().map((skill) => skill.id).sort(), MARKETPLACE_CATALOG.map((item) => item.id).sort(), 'all of them enabled');
    const idsOf = (skills) => skills.map((skill) => skill.id);
    // Every skill the scorer finds relevant, not only the best 4.
    const pick = (prompt, manager = shipped) => idsOf(manager.selectSkillsForTask({ prompt, limit: 99, tokenBudget: 10_000_000 }));

    // One ordinary word selects nothing: the words that selected 7, 7, 5, 4, 4, 4 and 2 of the nine skills, the function words, the words of the
    // descriptions' boilerplate, and the other words of a tool name that a request for code is written in. Several of them together select nothing either.
    for (const word of ['file', 'read', 'run', 'edit', 'and', 'command', 'write', 'files', 'the', 'for', 'with', 'status', 'diff', 'log', 'tasks', 'search', 'test', 'tests', 'testing', 'code', 'data', 'prompt', 'guidance', 'use', 'user', 'tools']) {
      assert.deepEqual(pick(word), [], `the word "${word}" alone selects no skill`);
    }
    for (const text of ['read the file and run the command', 'Read the file, edit it, write the result and run the command.', 'search the files and list the tasks with their status']) {
      assert.deepEqual(pick(text), [], `"${text}" selects no skill`);
    }
    // What still selects, alone: an explicit trigger word, or a word of the skill's own id or name. (git, commit and branch also select the GitHub Actions
    // skill, whose id contains "git": the lists are checked with includes.)
    const selects = {
      git: 'git-workflow-pro', commit: 'git-workflow-pro', branch: 'git-workflow-pro', docker: 'docker-devops', react: 'react-typescript-expert', pytest: 'python-architect',
      sqlite: 'sqlite-explorer', secret: 'security-compliance-guard', security: 'security-compliance-guard',
      python: 'python-architect', architect: 'python-architect', fastapi: 'fastapi-backend-developer', backend: 'fastapi-backend-developer', developer: 'fastapi-backend-developer',
      typescript: 'react-typescript-expert', expert: 'react-typescript-expert', github: 'github-actions-ci-cd', actions: 'github-actions-ci-cd', hardener: 'github-actions-ci-cd',
      devops: 'docker-devops', engine: 'docker-devops', explorer: 'sqlite-explorer', web: 'web-researcher', docs: 'web-researcher', researcher: 'web-researcher',
      compliance: 'security-compliance-guard', guard: 'security-compliance-guard', workflow: 'git-workflow-pro', pro: 'git-workflow-pro',
    };
    for (const [word, id] of Object.entries(selects)) assert.ok(pick(word).includes(id), `the word "${word}" alone selects ${id}, got ${JSON.stringify(pick(word))}`);
    assert.equal(pick('Please commit my changes using git')[0], 'git-workflow-pro', 'and a sentence that asks for it');

    // The tools a skill lists say which tools it would use, not what it is about (and most skills list read_file): they are no evidence, whole or in part.
    // The function words of a skill's name are no trigger (the skill "Search and Replace" would be selected by every "and"). The words every description is
    // written in are no evidence either, while three distinct words of a description still are.
    const custom = new PluginManager({ stateDir: path.join(conversationRoot, 'custom-state') });
    await custom.load();
    for (const installed of custom.installed()) await custom.toggle(installed.id, false);
    await custom.install('lumenwick', { name: 'lumenwick', description: 'lumenwick', tools: ['frobnicate_widget', 'emboss_widget', 'widget_probe'], systemPrompt: 'Reference text for lumenwick.' });
    await custom.install('search-and-replace', { name: 'Search and Replace', description: 'Find text and swap it for other text', tools: [], systemPrompt: 'Reference text for search-and-replace.' });
    await custom.install('wordsmith', { name: 'wordsmith', description: 'Use this skill when the user wants prompt guidance and tools also limerick sonnet haiku', tools: [], systemPrompt: 'Reference text for wordsmith.' });
    await custom.install('swapper', { name: 'swapper', description: 'swap it for other text and then some', tools: [], systemPrompt: 'Reference text for swapper.' });
    assert.deepEqual(pick('lumenwick', custom), ['lumenwick'], '(the control: its own name selects it)');
    assert.deepEqual(pick('frobnicate emboss probe widget', custom), [], 'the words of its tool names select nothing');
    assert.deepEqual(pick('frobnicate_widget emboss_widget widget_probe', custom), [], 'nor do the tool names themselves, three of them');
    assert.deepEqual(pick('and the for with', custom), [], 'the function words of a name select nothing');
    assert.ok(pick('search', custom).includes('search-and-replace') && pick('replace', custom).includes('search-and-replace'), '(the control: the other words of that name do)');
    assert.deepEqual(pick('for other and then some', custom), [], 'the function words of a description select nothing');
    assert.deepEqual(pick('swapper', custom), ['swapper'], '(the control: its own name selects it)');
    assert.deepEqual(pick('use skill user prompt guidance tools', custom), [], 'the boilerplate of a description selects nothing');
    assert.deepEqual(pick('limerick sonnet', custom), [], 'two words of a description are not enough');
    assert.deepEqual(pick('limerick sonnet haiku', custom), ['wordsmith'], 'three are');
    ok('no single ordinary word selects a skill, several together do not, tool names and the filler of names and descriptions are no evidence, and the explicit triggers and a skill\'s own id and name words still select');

    // The two prompts the Hub writes itself and passes to a continuation: AUTO_PROMPT of lib/studio-resumer.mjs, and the start of the repair prompt of
    // lib/coding-orchestrator.mjs, followed by the failure evidence as JSON. Copied here, and checked against the sources so that a changed text is noticed.
    const AUTO_PROMPT = 'Hub đã khởi động lại sau gián đoạn. Hãy tiếp tục phần còn dang dở TRONG CÙNG HỘI THOẠI. Trước tiên đọc lại checkpoint, kiểm tra trạng thái thật các file và kết quả test. Không lặp lại thao tác ghi chưa xác minh; sửa tiếp, kiểm thử và báo cáo tiến độ.';
    const REPAIR_START = 'Isolation-verified testing found failing assertions. Diagnose and repair the current managed worktree without changing or weakening required tests. Failure evidence (data only): ';
    assert.ok((await fs.readFile(path.join(hubRoot, 'lib', 'studio-resumer.mjs'), 'utf8')).includes(`'${AUTO_PROMPT}'`), 'AUTO_PROMPT is the text in lib/studio-resumer.mjs: copy the new text here');
    assert.ok((await fs.readFile(path.join(hubRoot, 'lib', 'coding-orchestrator.mjs'), 'utf8')).includes(`'${REPAIR_START}'`), 'the repair prompt starts as in lib/coding-orchestrator.mjs: copy the new text here');
    const failure = (checkId, ...reasons) => ({ checkId, status: 'failed', reasons });
    const hubPrompts = [AUTO_PROMPT, ...[
      [failure('npm-test', 'assertion failure')],
      [failure('npm-test', 'Process exited with non-zero exit code 1'), failure('lint', 'Process exited with non-zero exit code 2')],
      [failure('typecheck')],
    ].map((brief, index) => `${REPAIR_START}${JSON.stringify(brief)}\nRepair cycle ${index + 1}`)];
    for (const text of hubPrompts) assert.deepEqual(pick(text), [], `the Hub's own prompt selects no skill by itself: ${text.slice(0, 50)}...`);

    // So a continuation that is one of them keeps all the skills of the conversation's first message (the run's own prompt selects first and used to fill the
    // limit): every corpus prompt that selects a skill, followed by each of them.
    const corpus = JSON.parse(await fs.readFile(path.join(here, 'fixtures', 'tool-selector-corpus.json'), 'utf8')).prompts;
    const selecting = corpus.filter((entry) => selectConversationSkills(shipped, entry.prompt).length > 0);
    assert.ok(corpus.length >= 80 && selecting.length >= 8, `(the premise: ${selecting.length} of ${corpus.length} corpus prompts select a skill)`);
    const byId = new Map(corpus.map((entry) => [entry.id, entry.prompt]));
    for (const id of ['g01', 'g02', 'g04', 'g07', 'g08', 'g10']) assert.ok(pick(byId.get(id)).includes('git-workflow-pro'), `${id} still selects the Git skill`);
    for (const entry of selecting) {
      const own = idsOf(selectConversationSkills(shipped, entry.prompt));
      for (const text of hubPrompts) {
        const kept = idsOf(selectConversationSkills(shipped, text, [entry.prompt]));
        assert.ok(own.every((id) => kept.includes(id)), `${entry.id}: after "${text.slice(0, 40)}..." the conversation of "${entry.prompt}" keeps ${JSON.stringify(own)}, got ${JSON.stringify(kept)}`);
      }
    }
    ok(`the Hub's auto-resume and repair prompts select no skill, and a continuation keeps all the skills of the first message (${selecting.length} of ${corpus.length} corpus prompts select one)`);

    // Over the whole corpus a skill is selected because the prompt names it or asks for what it is about, never because of the ordinary words around that.
    const triggerWords = ['git', 'commit', 'branch', 'pytest', 'docker', 'react', 'security', 'secret', 'sqlite'];
    for (const entry of corpus) {
      const words = new Set(entry.prompt.toLowerCase().match(/\b[a-z0-9_-]{3,}\b/g) ?? []);
      for (const skill of shipped.selectSkillsForTask({ prompt: entry.prompt, limit: 99, tokenBudget: 10_000_000 })) {
        const own = [...skill.id.split(/[-_]/), ...skill.name.toLowerCase().split(/\s+/)];
        assert.ok(own.some((word) => words.has(word)) || triggerWords.some((word) => words.has(word)), `${entry.id}: ${skill.id} is selected on ordinary words ("${entry.prompt}")`);
      }
    }
    ok('over the corpus a skill is selected by a word of its id or name or by an explicit trigger, never by the ordinary words around it');
  }

  // A delegated worker's first prompt is composed by the Hub: the worker's goal, then (when its workflow has predecessors) a handoff of branch names, worktree
  // paths, the predecessors' results (another model's output) and the Hub's own instructions. The model reads all of it; what selects skills is the goal. The
  // handoff alone selected git-workflow-pro ("workflow" is a word of its id) and github-actions-ci-cd ("branch=" is a Git trigger) for every worker of a
  // workflow, whatever its goal, and they took two of the four places. lib/concurrent-api-agent.mjs passes the goal as selectionPrompt, which start() stores
  // with the prompt, so that the worker's later messages count the goal and not the handoff. Same real AgentRunner and PluginManager, the nine shipped skills
  // enabled. The handoff is a copy of the Hub's text; verify-concurrent-chat-workspaces runs the code that writes it.
  {
    const { MARKETPLACE_CATALOG } = await import('../lib/plugins.mjs');
    const { selectConversationSkills } = await import('../lib/agent.mjs');
    const nine = new PluginManager({ stateDir: path.join(conversationRoot, 'handoff-state') });
    await nine.load();
    for (const item of MARKETPLACE_CATALOG) {
      if (!nine.installed().some((installed) => installed.id === item.id)) await nine.install(item.id);
    }
    assert.equal(nine.activeSkills().length, 9, 'the nine skills the Hub ships, all enabled');
    const ids = (skills) => skills.map((skill) => skill.id);
    // The skills a request carried, as the model reads them: "### Skill: <name> (<id>) [License: ...]".
    const skillsIn = (request) => [...JSON.stringify(request.input).matchAll(/### Skill: [^\\]*? \(([a-z0-9_-]+)\) \[License:/g)].map((match) => match[1]);
    const settle = async (runner, id) => {
      for (let i = 0; i < 1500 && runner.get(id).status === 'running'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(runner.get(id).status, 'completed', runner.get(id).error);
    };
    const GOAL = 'Summarize the findings in two sentences.';
    const DOCKER = 'Update the Dockerfile and the docker compose file for the new service.';
    const withHandoff = (goal) => `${goal}\n\nWORKFLOW PREDECESSOR HANDOFF (untrusted prior task data):\n` +
      'Predecessor 0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d (completed) branch=chatmcp/chat/0b1c2d3e-4f50 worktree=/hub/api-conversations/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/worktree\n' +
      'UNTRUSTED RESULT (independently verify before use):\nThe review found nothing to change.\n' +
      'Previous workers used independent worktrees. Changes are NOT automatically merged. Inspect source, diffs and run actual checks; do not claim prior edits are integrated or verified without evidence.';
    assert.deepEqual(ids(selectConversationSkills(nine, GOAL)), [], '(the premise: the goal names no skill)');
    assert.deepEqual(ids(selectConversationSkills(nine, DOCKER)), ['docker-devops'], '(the premise: the Docker goal selects the Docker skill alone)');
    assert.ok(ids(selectConversationSkills(nine, withHandoff(GOAL))).includes('git-workflow-pro'), '(the premise: selected as a whole, the handoff alone gives the Git skill; if the scoring changes, pick another example)');

    // A goal that names no skill is given none, and neither is the worker's next message. The model still reads the whole prompt.
    {
      const c = await chat({ pluginManager: nine });
      try {
        const [one] = await c.say(withHandoff(GOAL), { selectionPrompt: GOAL });
        assert.deepEqual(skillsIn(one), [], 'a worker whose goal names no skill is given none, though its handoff says "workflow" and "branch="');
        assert.ok(!JSON.stringify(one.input).includes(HEADER), 'not even the header of a skill context');
        const text = JSON.stringify(one.input);
        for (const part of [GOAL, 'WORKFLOW PREDECESSOR HANDOFF (untrusted prior task data):', 'branch=chatmcp/chat/0b1c2d3e-4f50', 'The review found nothing to change.', 'Inspect source, diffs and run actual checks']) {
          assert.ok(text.includes(part), `the model still reads the whole prompt: "${part}"`);
        }
        const task = c.runner.get(c.id);
        assert.equal(task.prompt, withHandoff(GOAL), 'and the conversation records the whole prompt');
        assert.deepEqual([task.prompts[0].text, task.prompts[0].selectionText], [withHandoff(GOAL), GOAL], 'with the text its skills and tools are selected on');
        const [two] = await c.say('ok');
        assert.deepEqual(skillsIn(two), [], 'the worker\'s next message counts the goal of its first prompt, not its handoff');
        assert.deepEqual(activations(c), [], 'and no skills_activated event is raised');
      } finally { await c.runner.shutdown(); }
    }
    ok('a delegated worker whose goal names no skill is given none (nor is its next message), and the model still reads the whole handoff');

    // A goal that names docker still is given the Docker skill, and only what the goal asks for.
    {
      const c = await chat({ pluginManager: nine });
      try {
        const [one] = await c.say(withHandoff(DOCKER), { selectionPrompt: DOCKER });
        assert.deepEqual(skillsIn(one), ['docker-devops'], 'the Docker skill, and not the two Git skills of the handoff');
        const [two] = await c.say('ok');
        assert.deepEqual(skillsIn(two), ['docker-devops'], 'and the worker\'s next message keeps it');
        assert.deepEqual(activations(c), [['docker-devops'], ['docker-devops']], 'the skills_activated events say the same');
        assert.ok(JSON.stringify(one.input).includes('WORKFLOW PREDECESSOR HANDOFF (untrusted prior task data):'), 'the handoff reaches the model');
      } finally { await c.runner.shutdown(); }
    }
    ok('a delegated worker whose goal names docker is given the Docker skill and nothing the handoff says');

    // Without selectionPrompt start() selects on the prompt as a whole, as it always did: what a worker without predecessors gets (its prompt is its goal), and
    // what a caller that composes text of its own gets. A selectionPrompt that is the prompt itself, or none, is no change either, and stores nothing.
    {
      const whole = withHandoff(DOCKER);
      const expected = ids(selectConversationSkills(nine, whole));
      assert.ok(expected.includes('docker-devops') && expected.includes('git-workflow-pro'), '(the premise: the whole text selects the Docker and the Git skill)');
      for (const [label, options] of [['no selectionPrompt', {}], ['a selectionPrompt that is the prompt', { selectionPrompt: whole }], ['a null one', { selectionPrompt: null }], ['a blank one', { selectionPrompt: '  \n ' }]]) {
        const c = await chat({ pluginManager: nine });
        try {
          const [one] = await c.say(whole, options);
          assert.deepEqual(skillsIn(one), expected, `${label}: the skills of the whole prompt, as before`);
          assert.ok(!('selectionText' in c.runner.get(c.id).prompts[0]), `${label}: nothing is stored beside the prompt`);
          const [two] = await c.say('ok');
          assert.deepEqual(skillsIn(two), ids(selectConversationSkills(nine, 'ok', [whole])), `${label}: and the next message reads the first prompt as a whole`);
        } finally { await c.runner.shutdown(); }
      }
      const alone = await chat({ pluginManager: nine });
      try {
        const [one] = await alone.say(DOCKER);
        assert.deepEqual(skillsIn(one), ['docker-devops'], 'a worker without predecessors is given the skills of its goal, as before');
      } finally { await alone.runner.shutdown(); }
    }
    ok('without a selectionPrompt (or with one that is the prompt) start() selects on the whole prompt exactly as before, and stores nothing new');

    // The selection text is part of the stored conversation: after the Hub restarts, the worker continues with the same selection.
    {
      const c = await chat({ pluginManager: nine });
      try {
        await c.say(withHandoff(GOAL), { selectionPrompt: GOAL });
      } finally { await c.runner.shutdown(); }
      const file = JSON.parse(await fs.readFile(path.join(c.taskDirectory, c.id, 'task.json'), 'utf8'));
      assert.equal(file.prompts[0].selectionText, GOAL, 'the selection text is written to the task file');
      const restarted = new AgentRunner({ manager: c.manager, provider: c.provider, taskDirectory: c.taskDirectory });
      await restarted.load();
      try {
        assert.equal(restarted.get(c.id).prompts[0].selectionText, GOAL, 'and read back');
        await restarted.continue({ id: c.id, prompt: 'ok', maxSteps: 6 });
        await settle(restarted, c.id);
        assert.deepEqual(skillsIn(c.requests.at(-1)), [], 'the continuation after a restart is selected on it: no Git skill');
      } finally { await restarted.shutdown(); }
    }
    ok('the selection text survives a restart of the Hub');

    // A selectionPrompt that is not text is refused before anything starts. On a runner that has run nothing: one that has just finished a run is still
    // releasing its workspace, and answers task_running first.
    {
      const c = await chat({ pluginManager: nine });
      try {
        for (const bad of [42, {}, ['x'], true, 'x'.repeat(100_001)]) {
          await assert.rejects(c.runner.start({ prompt: GOAL, selectionPrompt: bad }), { code: 'invalid_prompt' }, `a selectionPrompt of ${typeof bad} ${String(JSON.stringify(bad)).slice(0, 12)} is refused`);
        }
        assert.equal(c.runner.activeTaskId, null, 'a refused start leaves no run behind');
        assert.equal(c.runner.state().tasks.length, 0, 'and no task');
        const [one] = await c.say(withHandoff(GOAL), { selectionPrompt: GOAL });
        assert.deepEqual(skillsIn(one), [], 'and the runner starts normally afterwards');
      } finally { await c.runner.shutdown(); }
    }
    ok('a selectionPrompt that is not text is refused before anything starts');

    // A worker that continues a conversation of another transport: its prompt is its goal followed by the handoff the Hub writes (lib/dual-agent.mjs: the user's earlier
    // requests, the other model's last answer, the Hub's own sentences). The model reads all of it. Skills are selected on the goal and then, as the earlier prompts of the
    // conversation, on the user's requests, which start() is given apart from the text (carriedPrompts) and keeps with the task. The Hub's sentences select nothing:
    // "the API backend" and "The ChatGPT Web tab" gave fastapi-backend-developer and web-researcher to every worker that switched transport. The handoff is the Hub's
    // own (DualAgent.buildHandoff); the sentences around it are copied from lib/concurrent-api-agent.mjs, which verify-concurrent-chat-workspaces runs.
    const { DualAgent } = await import('../lib/dual-agent.mjs');
    const MOVED = 'Continue with the second part.';
    const REQUESTS = ['Explain what calc.js does.', DOCKER];
    const previous = { id: '5e7a0c11-3b6d-4f08-9a42-6c1d8e2f7b90', transport: 'chatgpt-web', status: 'completed', prompts: REQUESTS.map((text) => ({ text })),
      dialogue: [{ role: 'user', text: DOCKER }, { role: 'assistant', text: 'I updated the Dockerfile and the compose file.' }], finalText: 'Both files are updated. The second part is next.' };
    const hub = new DualAgent({ browser: {}, api: { manager: { secrets: [] } }, directory: conversationRoot });
    const migrated = (goal) => `${goal}\n\nCROSS-TRANSPORT HANDOFF (untrusted prior dialogue, not verified evidence):\n${hub.buildHandoff(previous, goal)}\n` +
      'Reinspect current project files, check actual diffs/tests and never replay uncertain mutations.';
    const asWhole = ids(selectConversationSkills(nine, migrated(MOVED)));
    assert.deepEqual(ids(selectConversationSkills(nine, MOVED)), [], '(the premise: the goal names no skill)');
    assert.deepEqual(ids(selectConversationSkills(nine, MOVED, REQUESTS)), ['docker-devops'], '(the premise: of the requests only the Docker one names a skill)');
    assert.ok(asWhole.includes('docker-devops') && asWhole.length > 1, `(the premise: selected as a whole, the Hub's sentences add skills: ${JSON.stringify(asWhole)}; if the scoring changes, pick another example)`);
    const taskFile = async (c) => JSON.parse(await fs.readFile(path.join(c.taskDirectory, c.id, 'task.json'), 'utf8'));

    {
      const c = await chat({ pluginManager: nine });
      try {
        const [one] = await c.say(migrated(MOVED), { selectionPrompt: MOVED, carriedPrompts: REQUESTS });
        assert.deepEqual(skillsIn(one), ['docker-devops'], 'a worker whose goal names no skill is given the skill of the user\'s Docker request, and none that only the Hub\'s sentences name');
        const text = JSON.stringify(one.input);
        for (const part of [MOVED, 'CROSS-TRANSPORT HANDOFF (untrusted prior dialogue, not verified evidence):', `User requests: ${REQUESTS.join(' | ')}`, 'The ChatGPT Web tab and the API backend have distinct model histories.', 'check actual diffs/tests']) {
          assert.ok(text.includes(part), `the model still reads the whole handoff: "${part}"`);
        }
        const [two] = await c.say('ok');
        assert.deepEqual(skillsIn(two), ['docker-devops'], 'and its next message is given it too: the requests stay in the conversation');
        assert.deepEqual(activations(c), [['docker-devops'], ['docker-devops']], 'the skills_activated events say the same');
      } finally { await c.runner.shutdown(); }
      const file = await taskFile(c);
      assert.deepEqual(file.carriedPrompts, REQUESTS, 'the requests are written to the task file ...');
      assert.deepEqual(file.prompts.map((prompt) => prompt.text), [migrated(MOVED), 'ok'], '... and are no prompts of it: it holds the two messages of the worker only');
      assert.equal(file.prompts[0].selectionText, MOVED, 'the goal is the text its first prompt is selected on');
      const restarted = new AgentRunner({ manager: c.manager, provider: c.provider, taskDirectory: c.taskDirectory });
      await restarted.load();
      try {
        await restarted.continue({ id: c.id, prompt: 'ok', maxSteps: 6 });
        await settle(restarted, c.id);
        assert.deepEqual(skillsIn(c.requests.at(-1)), ['docker-devops'], 'after a restart of the Hub the next message is still given it');
      } finally { await restarted.shutdown(); }
    }
    ok('a worker moved from another transport is given the skills of the user\'s earlier requests and none of the Hub\'s sentences; the model reads it all; the requests outlast a restart');

    // What a task file holds as carriedPrompts that is not a list (edited by hand, or written by another version of the Hub) counts as none: the conversation goes on.
    // A list with entries that are not text is read for the texts it has.
    {
      const c = await chat({ pluginManager: nine });
      try { await c.say(migrated(MOVED), { selectionPrompt: MOVED, carriedPrompts: REQUESTS }); } finally { await c.runner.shutdown(); }
      for (const [label, damaged, expected] of [['a text', DOCKER, []], ['a number', 42, []], ['an object', { 0: DOCKER }, []], ['a list with a number and null in it', [7, null, DOCKER], ['docker-devops']]]) {
        const file = await taskFile(c);
        file.carriedPrompts = damaged;
        await fs.writeFile(path.join(c.taskDirectory, c.id, 'task.json'), JSON.stringify(file));
        const restarted = new AgentRunner({ manager: c.manager, provider: c.provider, taskDirectory: c.taskDirectory });
        await restarted.load();
        try {
          await restarted.continue({ id: c.id, prompt: 'ok', maxSteps: 6 });
          await settle(restarted, c.id);
          assert.deepEqual(skillsIn(c.requests.at(-1)), expected, `carriedPrompts that are ${label}: the conversation goes on with ${expected.length ? 'the texts of the list' : 'none'}`);
        } finally { await restarted.shutdown(); }
      }
    }
    ok('a carriedPrompts in a task file that is not a list counts as none, and the conversation goes on');

    // The requests are the oldest prompts of the conversation: behind everything the worker is asked itself, and the first to be dropped at 4 skills.
    {
      const c = await chat();
      try {
        const [one] = await c.say('Use brontide.', { carriedPrompts: ['Use zephyrflux.', 'Use quillmark.'] });
        assert.deepEqual(delivered(one), ['brontide', 'quillmark', 'zephyrflux'], 'the prompt of the run first, then the requests, newest first');
        await c.say('Use cobaltreef.');
        await c.say('Use ambergate.');
        const [four] = await c.say('ok');
        assert.deepEqual(delivered(four), ['ambergate', 'cobaltreef', 'brontide', 'quillmark'], 'the requests are older than the prompts of the worker itself: the oldest of them is dropped');
      } finally { await c.runner.shutdown(); }
    }
    ok('the carried requests are the oldest prompts of the conversation, read newest first behind the prompt of the run');

    // Without requests start() selects exactly as it did, and writes nothing to the task.
    for (const [label, options] of [['no carriedPrompts', {}], ['null', { carriedPrompts: null }], ['an empty list', { carriedPrompts: [] }], ['blank requests', { carriedPrompts: ['', ' \n '] }]]) {
      const c = await chat({ pluginManager: nine });
      try {
        const [one] = await c.say(migrated(MOVED), options);
        assert.deepEqual(skillsIn(one), asWhole, `${label}: the skills of the whole prompt, as before`);
        const [two] = await c.say('ok');
        assert.deepEqual(skillsIn(two), ids(selectConversationSkills(nine, 'ok', [migrated(MOVED)])), `${label}: and the next message reads the first prompt as a whole`);
      } finally { await c.runner.shutdown(); }
      assert.ok(!('carriedPrompts' in await taskFile(c)), `${label}: nothing is written beside the prompts`);
    }
    ok('without carried requests start() selects on the whole prompt exactly as before, and writes nothing new');

    // Requests that are not up to 20 texts of at most 100,000 characters are refused before anything starts (on a runner that has run nothing, as above).
    {
      const c = await chat({ pluginManager: nine });
      try {
        for (const bad of ['Use zephyrflux.', {}, 42, true, [42], [null], [['x']], ['x'.repeat(100_001)], Array(21).fill('x')]) {
          await assert.rejects(c.runner.start({ prompt: MOVED, carriedPrompts: bad }), { code: 'invalid_prompt' }, `carriedPrompts of ${JSON.stringify(bad).slice(0, 20)} are refused`);
        }
        assert.equal(c.runner.activeTaskId, null, 'a refused start leaves no run behind');
        assert.equal(c.runner.state().tasks.length, 0, 'and no task');
        const [one] = await c.say(MOVED, { carriedPrompts: [...Array(19).fill('ok'), DOCKER] });
        assert.deepEqual(skillsIn(one), ['docker-devops'], 'and 20 requests are accepted');
      } finally { await c.runner.shutdown(); }
    }
    ok('carried requests that are not up to 20 texts are refused before anything starts');

    // They are written to the task file, which is redacted as a whole, as its prompts are.
    {
      const key = 'sk-proj-abcdefghijklmnopqrstuvwx';
      const c = await chat();
      try {
        const [one] = await c.say('ok', { carriedPrompts: [`Use zephyrflux with the key ${key}.`] });
        assert.deepEqual(delivered(one), ['zephyrflux'], 'a redacted request still selects');
      } finally { await c.runner.shutdown(); }
      assert.deepEqual((await taskFile(c)).carriedPrompts, ['Use zephyrflux with the key [REDACTED].'], 'and the key is not stored');
    }
    ok('carried requests are redacted when they are written to the task file');
  }
} finally {
  await fs.rm(conversationRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(`PASS: ${checks} skill delivery checks`);
