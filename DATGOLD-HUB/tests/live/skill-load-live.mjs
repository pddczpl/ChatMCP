#!/usr/bin/env node
// LIVE CHECK, COSTS MONEY: does a REAL model call skill_load by itself?
//
// Everything the Hub does for skills is tested with scripted models (tests/verify-skill-on-demand.mjs): the index that names every enabled skill, skill_load, what it hands back. What no test
// has shown is that a real model, offered that index and that tool, reads a skill nobody preloaded for it. This runs the real Hub (a child process with its own state folder, a throwaway
// project and nothing of yours) against the model you name, installs one custom skill whose text holds a code word that only that text has, and asks a question in Vietnamese that only the
// skill can answer, with none of the skill's words in it, so that the keywords preload nothing. It passes when the model asked for the skill (an event skill_loaded), the Hub had not preloaded
// it, and the answer holds the code word.
//
//   node DATGOLD-HUB/tests/live/skill-load-live.mjs --preset anthropic [--model claude-sonnet-5-5] [--runs 1] [--max-steps 6] [--base-url URL] [--keep]
//
// The key is read from the environment variable of the preset (ANTHROPIC_API_KEY, OPENAI_API_KEY ...); without one the command asks for it on the terminal, hidden. It is given to the Hub of
// this run only, over the loopback address, and nothing is written outside a temporary folder that is deleted at the end. A run is a few requests of a few thousand tokens: the cost is printed
// from the catalog's price and the usage the provider reported. Exit code: 0 passed, 1 the model did not (or the Hub preloaded the skill: nothing is proven), 2 it could not be run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { answerApprovals, startHub, startTask } from '../e2e/hub-process.mjs';
import { gitInit, makeCalcProject } from '../e2e/fixtures.mjs';
import { lookup } from '../../lib/model-catalog.mjs';
import { PRESETS } from '../../lib/provider-presets.mjs';

export const SKILL = Object.freeze({
  id: 'zephyr-handbook',
  name: 'Zephyr Handbook',
  // English on purpose, and none of these words is in the question (which is Vietnamese): the keyword scorer must select nothing, so that only the model's own reading of the index can bring the skill in.
  description: 'Conventions of the Zephyr team: how a change is signed off, the code word that every report must end with, and who to call when something breaks. Read it when a question is about what the team requires.',
  code: 'violet-otter-4217',
});
export const SKILL_TEXT = `# Zephyr Handbook\n\nConventions of the Zephyr team.\n\n- Every report ends with the code word: ${SKILL.code}\n- A change is signed off by two people.\n- When something breaks, call the on-call engineer before anyone else.\n`;
export const QUESTION = 'Theo quy ước của nhóm trong dự án này, mọi báo cáo phải kết thúc bằng mật hiệu gì? Chỉ trả lời đúng mật hiệu đó, không làm gì khác.';

function parse(argv) {
  const options = { preset: 'anthropic', runs: 1, maxSteps: 6, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`); i += 1; return argv[i]; };
    if (arg === '--preset') options.preset = value();
    else if (arg === '--model') options.model = value();
    else if (arg === '--base-url') options.baseUrl = value();
    else if (arg === '--runs') options.runs = Number(value());
    else if (arg === '--max-steps') options.maxSteps = Number(value());
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) throw new Error('--runs is a whole number from 1 to 10');
  if (!Number.isInteger(options.maxSteps) || options.maxSteps < 2 || options.maxSteps > 20) throw new Error('--max-steps is a whole number from 2 to 20');
  return options;
}

const HELP = `skill_load live check (costs money): does a real model read a skill by itself?
  node DATGOLD-HUB/tests/live/skill-load-live.mjs --preset <id> [--model <name>] [--runs 1] [--max-steps 6] [--base-url <url>] [--keep]
  presets: ${PRESETS.filter((preset) => !preset.id.startsWith('custom-')).map((preset) => preset.id).join(', ')}
  the key: the environment variable of the preset (for example ANTHROPIC_API_KEY), or typed (hidden) when there is none`;

/** A line typed on the terminal that is not shown (a key). */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { reject(new Error('there is no terminal to ask on')); return; }
    process.stderr.write(question);
    let text = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (action) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); action(); };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done(() => resolve(text.trim()));
        if (char === '\u0003') return done(() => process.exit(130));
        if (char === '\u007f' || char === '\b') text = text.slice(0, -1);
        else text += char;
      }
    };
    stdin.on('data', onData);
  });
}

/** What the run says, from the Hub's record of the task: nothing here is the model's own report. */
export function judge(detail) {
  const events = Array.isArray(detail?.events) ? detail.events : [];
  const loaded = events.filter((event) => event.type === 'skill_loaded').map((event) => event.skillLoad?.id).filter(Boolean);
  const preloaded = (detail?.skillSelection?.selected ?? []).map((item) => item.id);
  const answer = String(detail?.finalText ?? '');
  const asked = loaded.includes(SKILL.id);
  const knew = answer.includes(SKILL.code);
  let verdict;
  if (preloaded.includes(SKILL.id)) verdict = { passed: false, why: 'the Hub preloaded the skill by its keywords, so nothing is proven about the model (the question must not share words with the skill)' };
  else if (!asked && knew) verdict = { passed: false, why: 'the answer holds the code word but no skill_load was recorded' };
  else if (!asked) verdict = { passed: false, why: `the model did not call skill_load${detail?.error ? ` (the task ended with: ${String(detail.error).slice(0, 160)})` : ' (it answered without reading the skill)'}` };
  else if (!knew) verdict = { passed: false, why: 'the model called skill_load but its answer does not hold the code word' };
  else verdict = { passed: true, why: 'the model read the skill with skill_load and answered from it' };
  return { ...verdict, loaded, preloaded, answer };
}

function cost(detail, options, model) {
  const usage = detail?.usage ?? {};
  const found = lookup({ presetId: options.preset, apiBaseUrl: options.baseUrl, model });
  const rates = found?.found ? found.rates : null;
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const usd = rates && (input || output) ? (input * rates.input + output * rates.output) / 1e6 : null;
  return { requests: usage.httpRequests ?? null, input, output, usd };
}

async function oneRun(options, preset, model, key) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'datgold-live-skill-')));
  const project = path.join(scratch, 'workspace');
  let hub;
  try {
    makeCalcProject(project, {});
    gitInit(project, scratch);
    // The Hub chooses its tools as it does for a person (the harness' "full" list is for scripted models that call tools by name).
    hub = await startHub({ scratch, project, env: { CHATMCP_TOOL_SELECTION: '' } });
    await hub.post('/api/ai/config', { preset: preset.id, model, ...(key ? { apiKey: key } : {}), ...(options.baseUrl ? { apiBaseUrl: options.baseUrl } : {}) });
    try { await hub.post('/api/ai/test', {}); } catch (error) { return { setup: `the connection check failed: ${String(error.message).replace(/^POST [^:]+: /, '').slice(0, 300)}` }; }
    await hub.post('/api/plugins/install', { id: SKILL.id, custom: { name: SKILL.name, description: SKILL.description, systemPrompt: SKILL_TEXT } });
    const started = await startTask(hub, QUESTION, { maxSteps: options.maxSteps, maxMinutes: 4 });
    await answerApprovals(hub, started.id, () => false, { timeoutMs: 300_000 });
    const detail = await hub.task(started.id);
    return { detail, judged: judge(detail), cost: cost(detail, options, model), catalog: detail?.skillSelection?.catalog ?? null };
  } finally {
    await hub?.stop().catch(() => {});
    if (!options.keep && path.basename(scratch).startsWith('datgold-live-skill-')) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    else if (options.keep) console.log(`  kept: ${scratch}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parse(argv); } catch (error) { console.error(`${error.message}\n\n${HELP}`); return 2; }
  if (options.help) { console.log(HELP); return 0; }
  const preset = PRESETS.find((entry) => entry.id === options.preset);
  if (!preset) { console.error(`unknown preset "${options.preset}"\n\n${HELP}`); return 2; }
  const model = options.model ?? preset.defaultModel;
  let key = '';
  if (!preset.local) {
    key = preset.keyEnv.map((name) => process.env[name]).find((value) => value && value.trim()) ?? '';
    if (!key) {
      try { key = await askHidden(`${preset.keyEnv[0] ?? 'API key'} for ${preset.label} (typed here, not shown, used for this run only): `); } catch { key = ''; }
    }
    if (!key) { console.error(`no key: set ${preset.keyEnv.join(' or ')} or run this in a terminal and type it when asked`); return 2; }
  }
  console.log(`skill_load live check: ${preset.label}, model ${model}, ${options.runs} run(s) of at most ${options.maxSteps} model steps${preset.local ? '' : ' (this spends money, a few cents at most)'}`);
  let passed = 0;
  let spent = 0;
  let unknownCost = false;
  for (let run = 1; run <= options.runs; run += 1) {
    const result = await oneRun(options, preset, model, key);
    if (result.setup) { console.error(`  run ${run}: ${result.setup}`); return 2; }
    const { judged, cost: used, catalog } = result;
    console.log(`  run ${run}: ${judged.passed ? 'PASSED' : 'FAILED'}: ${judged.why}`);
    console.log(`    offered to the model: ${catalog ? `${catalog.listed.length + (catalog.omitted?.length ?? 0)} other skills in the form "${catalog.form}"` : 'the index of skills'}; preloaded by the Hub: ${judged.preloaded.length ? judged.preloaded.join(', ') : 'none'}; skill_load asked for: ${judged.loaded.length ? judged.loaded.join(', ') : 'nothing'}`);
    console.log(`    answer: ${JSON.stringify(judged.answer.slice(0, 160))}`);
    console.log(`    requests: ${used.requests ?? '?'}; tokens in/out as the provider reported: ${used.input}/${used.output}; cost about ${used.usd === null ? 'unknown (no price in the catalog or no usage reported)' : `$${used.usd.toFixed(4)}`}`);
    if (judged.passed) passed += 1;
    if (used.usd === null) unknownCost = true; else spent += used.usd;
  }
  console.log(`${passed === options.runs ? 'PASS' : 'FAIL'}: ${passed}/${options.runs} run(s) read the skill with skill_load${spent > 0 || !unknownCost ? `; about $${spent.toFixed(4)} spent${unknownCost ? ' (some runs unknown)' : ''}` : ''}`);
  return passed === options.runs ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (error) => { console.error(error?.stack ?? error); process.exit(2); });
}
