// End-to-end scenario: the real result of a background agent reaches the agent that started it (P1-F).
//
// A real Hub (hub.mjs, local backend, real Git worktrees for the agents) and a scripted model server that speaks Chat Completions in strict mode, so a notice
// in the wrong place of a conversation would be refused with HTTP 400 like the real API does. The person is in Autonomous mode: the agents run in the
// background and nobody is there to approve their worktrees.
//
//   A. a parent spawns two agents with spawn_agent; both stop while the parent is still working; its next request carries ONE notice (written by the Hub, no
//      output of the agents in it), it reads their results with agent_results and its final answer is built from what that tool returned. A credential that one
//      agent printed never reaches a model request nor a file of the parent. The Hub is then stopped and started again: the state is as it was and nothing is
//      told again.
//   B. a parent spawns two agents and finishes first. They stop later (the Hub only records it: no request, nothing running). The Hub is KILLED. After the restart
//      the endings are still recorded; when the person comes back the model is told before the prompt, reads the results of agents that finished before the
//      crash, and answers. A further restart does not tell it again.
//
// What this proves is the Hub: the tool, the notices, the ledger order and the state on disk. It does not prove that a real model reads a notice well.
// CLAIM: subagent-results-reach-parent
import path from 'node:path';
import { eventually, findNeedles, runScenario } from './e2e/harness.mjs';
import { connectModel, continueTask, setMode, sleep, startTask, waitForState } from './e2e/hub-process.mjs';
import { gitInit, makeCalcProject } from './e2e/fixtures.mjs';
import { call, calls, say } from './e2e/scenarios.mjs';

// Assembled at run time: no credential-shaped literal sits in the source.
const GITHUB = ['gh', 'p_', 'Qw3rTy5uIo7pAs9dFg1hJk3lZx5cVb7nM9qW'].join('');
const AWS = ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join('');

await runScenario({
  name: 'subagent-results',
  summary: 'a parent spawns two agents, is told when they stop, reads their results and answers from them; the same when it finished first, across a crash and a restart',
  budgetMs: 280_000,
}, async (t) => {
  const project = path.join(t.scratch, 'proj');
  makeCalcProject(project);
  gitInit(project, t.scratch);
  const stateDir = path.join(t.scratch, 'state');
  let hub1 = null;

  // ---- the scripted model: it sees only the conversation it was sent
  const seen = [];
  const tokens = new Map();
  const tokenOf = (name) => { if (!tokens.has(name)) tokens.set(name, `TOKEN-${Math.random().toString(36).slice(2, 10).toUpperCase()}`); return tokens.get(name); };
  const ids = {};
  const gates = new Map();
  const gate = (name) => { let open; const promise = new Promise((resolve) => { open = resolve; }); gates.set(name, { promise, open }); };
  const ownerOf = (ctx) => /(Parent|Child) E\w+:/.exec(ctx.users.filter((text) => !text.startsWith('UNTRUSTED SKILL')).join('\n'))?.[0].replace(/:$/, '') ?? 'unknown';
  const results = (ctx) => JSON.parse(ctx.last).structuredContent;
  const claimToken = (child) => /TOKEN-[A-Z0-9]+/.exec(child.claim?.text ?? '')?.[0] ?? 'none';

  const mock = await t.mock({
    scenario: 'subagents',
    scenarios: {
      subagents: async (ctx) => {
        const who = ownerOf(ctx);
        seen.push({ who, tools: ctx.tools, users: ctx.users, prompt: ctx.prompt, turn: ctx.turn, last: ctx.last });
        const mine = seen.filter((entry) => entry.who === who).length;
        if (who.startsWith('Child')) {
          if (gates.has(who)) await gates.get(who).promise;
          const credential = who === 'Child E1b' ? ` Its key is ${GITHUB}.` : who === 'Child E2b' ? ` Its key is ${AWS}.` : '';
          return say(`${who} report: ${tokenOf(who)}.${credential}`);
        }
        // ---- a parent that is still working when its agents stop
        if (who === 'Parent E1') {
          if (ctx.prompt.includes('any news')) return say('Nothing new to report.');
          if (mine === 1) return calls(['spawn_agent', { goal: 'Child E1a: summarize the readme' }], ['spawn_agent', { goal: 'Child E1b: summarize the license' }]);
          if (mine === 2) {
            await eventually(async () => (await hub1.get(`/api/tasks/${ids.E1}`)).json?.subagentNotices?.length === 2, { timeoutMs: 90_000, label: 'both agents to stop and be recorded on the parent' });
            return call('list_directory', {});
          }
          if (mine === 3) return call('agent_results', {});
          const out = results(ctx);
          return say(`Combined: ${out.children.map((child) => `${child.goal.split(':')[0]} -> ${claimToken(child)}`).join(' ; ')}`);
        }
        // ---- a parent that finishes first
        if (who === 'Parent E2') {
          if (ctx.prompt.includes('anything else')) return say('Nothing else.');
          if (ctx.prompt.includes('report what')) {
            if (ctx.turn === 0) return call('agent_results', {});
            const out = results(ctx);
            return say(`After the crash: ${out.children.map((child) => `${child.goal.split(':')[0]} -> ${claimToken(child)} (${child.status})`).join(' ; ')}`);
          }
          if (mine === 1) return calls(['spawn_agent', { goal: 'Child E2a: summarize the changelog' }], ['spawn_agent', { goal: 'Child E2b: summarize the notice file' }]);
          return say('Both agents are started; I have no result to report yet.');
        }
        return say('unexpected conversation');
      },
    },
  });
  await mock.watch([GITHUB, AWS]);

  // ---- the first Hub
  hub1 = await t.hub({ project, stateDir, logName: 'hub-1.log' });
  let hub2 = null; let hub3 = null;
  const model = await connectModel(hub1, mock);
  t.check(model?.ok !== false && model?.toolCalling !== false, 'the scripted model passes the tool-calling check', JSON.stringify(model)?.slice(0, 200));
  await setMode(hub1, 'autonomous');

  // ================================================================================================================= A. a parent that is still working
  const e1 = await startTask(hub1, 'Parent E1: start two agents, wait for them while you look around, then report what they found.');
  ids.E1 = e1.id;
  const doneE1 = await waitForState(hub1, e1.id, ['completed', 'failed', 'paused', 'uncertain'], { timeoutMs: 150_000 });
  t.equal(doneE1.state, 'completed', 'A: the parent finishes');
  const parentRequests = seen.filter((entry) => entry.who === 'Parent E1');
  t.equal(parentRequests.length, 4, 'A: the parent made four requests: spawn, a look around, agent_results, the answer (it did not poll)');
  t.check(parentRequests[0].tools.includes('agent_results') && parentRequests[0].tools.includes('spawn_agent'), 'A: it was offered agent_results next to the spawn tools');
  t.check(!parentRequests[1].users.some((text) => text.startsWith('HUB NOTICE')), 'A: its second request (the spawn results) carries no notice yet');
  const third = parentRequests[2];
  const notices = third.users.filter((text) => text.startsWith('HUB NOTICE'));
  t.equal(notices.length, 1, 'A: its third request carries exactly ONE notice, for both agents');
  t.check(third.users.at(-1) === notices[0] && third.prompt === notices[0], 'A: and the notice is the last thing in the conversation, after the results the parent already had');
  t.check(/2 background agents you started have stopped/.test(notices[0] ?? '') && notices[0].includes('Child E1a: summarize the readme') && notices[0].includes('Child E1b: summarize the license'), 'A: it names both agents and their goals', notices[0]?.slice(0, 400));
  t.check(!/TOKEN-/.test(notices[0] ?? '') && !notices[0].includes(GITHUB), 'A: and carries nothing the agents wrote');
  t.check(/not from the user/.test(notices[0] ?? ''), 'A: it says the Hub wrote it and the user did not');

  const parentE1 = await hub1.task(e1.id);
  const childIds = (await hub1.state()).agent.tasks.filter((task) => task.parentTaskId === e1.id).map((task) => task.id);
  t.equal(childIds.length, 2, 'A: the Hub has two agents of this parent');
  const childTasks = await Promise.all(childIds.map((id) => hub1.task(id)));
  t.check(childTasks.every((task) => task.state === 'completed' && /TOKEN-/.test(task.finalText)), 'A: both agents completed with a report of their own');
  const tokenA = tokenOf('Child E1a'); const tokenB = tokenOf('Child E1b');
  t.check(parentE1.finalText.includes(tokenA) && parentE1.finalText.includes(tokenB), 'A: the parent\'s output carries the real result of both agents', parentE1.finalText);
  t.check(childTasks.some((task) => task.finalText.includes(tokenA)) && childTasks.some((task) => task.finalText.includes(tokenB)), 'A: and those are the agents\' own final messages as the Hub holds them');
  t.equal(parentE1.subagentNotices.map((entry) => [entry.notice, entry.deliveredRun]), [['delivered', 1], ['delivered', 1]], 'A: the parent\'s state says both were told, in run 1');
  t.equal(parentE1.events.map((event) => event.type).filter((type) => type.startsWith('subagent_')), ['subagent_finished', 'subagent_finished', 'subagent_notice'], 'A: the events show the two endings and the one notice');
  t.equal([parentE1.promptCount, parentE1.dialogue.filter((entry) => entry.role === 'user').length], [1, 1], 'A: the notice is not something the user asked: one prompt, one user turn');
  const toolRequests = parentE1.events.filter((event) => event.type === 'tool_result' && event.toolName === 'chatmcp.agent_results');
  t.equal(toolRequests.length, 1, 'A: agent_results ran once');

  // ---- no secret in the parent's world
  const hit = mock.watchReport();
  t.check(hit.scanned >= parentRequests.length + 2 && hit.hits.length === 0, `A: neither credential an agent printed was in any of the ${hit.scanned} model requests (the parent's ${parentRequests.length} and both agents')`, JSON.stringify(hit.hits));
  const parentFiles = findNeedles(stateDir, [GITHUB, AWS], { skip: ['api-conversations'] });
  t.check(parentFiles.scanned > 5 && parentFiles.hits.length === 0, `A: nor in any of the ${parentFiles.scanned} files the Hub keeps outside its agents' own folders`, JSON.stringify(parentFiles.hits));
  t.check(!(JSON.stringify(parentE1)).includes(GITHUB), 'A: nor in the parent as the API shows it');
  const own = findNeedles(path.join(stateDir, 'api-conversations'), [GITHUB, AWS]);
  if (own.hits.length) t.note(`the agents' own task folders keep their final messages as the agents wrote them (${own.hits.length} file(s) hold a credential-shaped string); that is how the Hub already stored a final message. Only what the parent reads is filtered.`);

  // ---- the Hub is stopped and started again
  await hub1.stop();
  hub2 = await t.hub({ project, stateDir, logName: 'hub-2.log' });
  const reloaded = await hub2.task(e1.id);
  t.equal(reloaded.subagentNotices, parentE1.subagentNotices, 'A: after a restart the parent\'s entries are exactly as they were');
  t.equal(reloaded.events.length, parentE1.events.length, 'A: loading added no event');
  const before = seen.length;
  const again = await continueTask(hub2, e1.id, 'Parent E1: any news?');
  const doneAgain = await waitForState(hub2, again.id, ['completed', 'failed'], { timeoutMs: 60_000 });
  t.equal(doneAgain.state, 'completed', 'A: the conversation can be continued after the restart');
  const next = seen.slice(before).filter((entry) => entry.who === 'Parent E1');
  t.equal(next.length, 1, 'A: with one request');
  t.check(!next[0].users.some((text) => text.startsWith('HUB NOTICE')), 'A: that carries no notice: what was told before the restart is not told again');
  t.equal((await hub2.task(e1.id)).subagentNotices.map((entry) => entry.notice), ['delivered', 'delivered'], 'A: and the entries stay delivered');

  // ================================================================================================================= B. a parent that finishes first, a crash
  gate('Child E2a'); gate('Child E2b');
  const e2 = await startTask(hub2, 'Parent E2: start two agents and finish; they take their time.');
  ids.E2 = e2.id;
  const doneE2 = await waitForState(hub2, e2.id, ['completed', 'failed', 'paused', 'uncertain'], { timeoutMs: 120_000 });
  t.equal(doneE2.state, 'completed', 'B: the parent finishes first');
  t.equal(doneE2.finalText, 'Both agents are started; I have no result to report yet.', 'B: and says it has no result yet');
  await eventually(() => seen.filter((entry) => entry.who === 'Child E2a' || entry.who === 'Child E2b').length >= 2, { timeoutMs: 90_000, label: 'both agents to be waiting for the model' });
  const parentCountBefore = seen.filter((entry) => entry.who === 'Parent E2').length;
  gates.get('Child E2a').open(); gates.get('Child E2b').open();
  const recorded = await eventually(async () => {
    const task = await hub2.task(e2.id);
    return task.subagentNotices?.length === 2 ? task : null;
  }, { timeoutMs: 90_000, label: 'both endings to be recorded on the finished parent' });
  t.equal(recorded.subagentNotices.map((entry) => entry.notice), ['recorded', 'recorded'], 'B: the endings are recorded on the finished parent');
  t.equal(recorded.state, 'completed', 'B: which stays completed');
  t.equal((await hub2.state()).agent.activeTaskId === e2.id, false, 'B: nothing runs for it');
  t.equal(recorded.events.filter((event) => event.type === 'subagent_finished').length, 2, 'B: and its events show both endings');
  await sleep(1500);
  t.equal(seen.filter((entry) => entry.who === 'Parent E2').length, parentCountBefore, 'B: an ending does not start the parent: it made no further request');

  await hub2.kill();
  t.check(hub2.exitInfo?.signal === 'SIGKILL' || process.platform === 'win32', 'B: the Hub was killed without any chance to clean up', JSON.stringify(hub2.exitInfo));
  const requestsBeforeRestart = mock.state.requests.length;
  hub3 = await t.hub({ project, stateDir, logName: 'hub-3.log' });
  const survivor = await hub3.task(e2.id);
  t.equal(survivor.subagentNotices.map((entry) => entry.notice), ['recorded', 'recorded'], 'B: after the crash the endings are still recorded, still unread');
  t.equal(survivor.status, 'completed', 'B: the parent is as it was');
  await sleep(1000);
  t.equal(mock.state.requests.length, requestsBeforeRestart, 'B: loading made no model request');

  const back = await continueTask(hub3, e2.id, 'Parent E2: report what the agents found.');
  const doneBack = await waitForState(hub3, back.id, ['completed', 'failed', 'paused', 'uncertain'], { timeoutMs: 90_000 });
  t.equal(doneBack.state, 'completed', 'B: the person comes back and the run completes');
  const second = seen.filter((entry) => entry.who === 'Parent E2').slice(parentCountBefore);
  t.equal(second.length, 2, 'B: two requests: the call to agent_results, then the answer');
  const order = second[0].users.map((text) => (text.startsWith('HUB NOTICE') ? 'notice' : text.startsWith('CONVERSATION CHECKPOINT') ? 'checkpoint' : 'user'));
  t.equal(order.slice(-3), ['checkpoint', 'notice', 'user'], 'B: the model is told before the prompt, so the person\'s request is the last thing said');
  t.check(/2 background agents you started have stopped/.test(second[0].users.at(-2)), 'B: one notice for both');
  const final = (await hub3.task(e2.id)).finalText;
  t.check(final.includes(tokenOf('Child E2a')) && final.includes(tokenOf('Child E2b')) && (final.match(/completed/g) ?? []).length === 2, 'B: the answer is built from the results of agents that finished before the crash', final);
  t.equal((await hub3.task(e2.id)).subagentNotices.map((entry) => [entry.notice, entry.deliveredRun]), [['delivered', 2], ['delivered', 2]], 'B: the entries now say delivered in run 2');

  await hub3.stop();
  const hub4 = await t.hub({ project, stateDir, logName: 'hub-4.log' });
  const seenBefore = seen.length;
  await continueTask(hub4, e2.id, 'Parent E2: anything else?');
  await waitForState(hub4, e2.id, ['completed', 'failed'], { timeoutMs: 60_000 });
  const last = seen.slice(seenBefore).filter((entry) => entry.who === 'Parent E2');
  t.check(last.length === 1 && !last[0].users.some((text) => text.startsWith('HUB NOTICE')), 'B: after one more restart the model is not told again');

  const finalWatch = mock.watchReport();
  t.check(finalWatch.hits.length === 0, `B: still no credential in any of the ${finalWatch.scanned} model requests`, JSON.stringify(finalWatch.hits));
  t.equal(mock.state.rejections.length, 0, 'the strict Chat validator refused no request: every conversation the Hub sent was valid, notices included', JSON.stringify(mock.state.rejections).slice(0, 300));
});
