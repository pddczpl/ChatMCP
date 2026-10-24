// Thinking effort: the one setting ("auto" or a level) that says how much a model is asked to think, and what the Hub does with it on each wire protocol.
//
//   1. The setting: which words are levels, and 'auto' for nothing (the default: the Hub sends nothing and the model decides).
//   2. The decision, from the setting, the protocol and the catalog's answer for the model: what is sent, or why nothing is. Table test over protocols x models, on the real catalog.
//   3. On the wire, through the real adapters against the strict mock servers (tests/e2e): the field is where the vendor documents it (Chat reasoning_effort, OpenRouter
//      reasoning.effort, Responses reasoning.effort, Messages output_config.effort), the strict server accepts it, and 'auto' sends nothing.
//   4. A provider that refuses the setting (HTTP 400 naming it): the same model request is repeated ONCE without it, the task goes on, the refusal is remembered for that
//      endpoint and model (the next request does not send it), and a refusal about something else (the output cap, the context) is never taken for it.
//   5. Where the setting lives: the global connection (gateway-config.json) and the model profiles (ai-profiles.json): saved, loaded, validated, kept when omitted, cleared by 'auto'.
//   6. Negative controls: the decision table and the refusal test fail on a changed table.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockModel } from './e2e/mock-model-server.mjs';
import { validateAnthropicRequest, validateChatRequest, validateGeminiRequest, validateResponsesRequest } from './e2e/protocol-validators.mjs';
import { AiProfiles } from '../lib/ai-profiles.mjs';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { createCatalog, lookup } from '../lib/model-catalog.mjs';
import { AUTO, EFFORT_LEVELS, applyReasoning, offeredLevels, parseReasoningEffort, reasoningDecision, refusesReasoning } from '../lib/reasoning-effort.mjs';
import { classifyHttpError } from '../lib/model-http.mjs';
import { modelInfo, modelInfoQuery } from '../lib/model-info.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const snapshot = JSON.parse(await fs.readFile(new URL('../lib/model-catalog.data.json', import.meta.url), 'utf8'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-reasoning-'));
const closers = [];

try {
  // --------------------------------------------------------------------------------------------------------------------------- 1. the setting
  {
    assert.deepEqual(EFFORT_LEVELS, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const empty of [undefined, null, '', '  ', 'auto', 'AUTO', ' Auto ']) assert.equal(parseReasoningEffort(empty), AUTO, JSON.stringify(empty));
    for (const level of EFFORT_LEVELS) assert.equal(parseReasoningEffort(level), level);
    assert.equal(parseReasoningEffort(' HIGH '), 'high');
    for (const bad of ['extreme', 'hi', 'budget', 7, {}, [], 'low;max', 'high ']) assert.equal(parseReasoningEffort(bad), bad === 'high ' ? 'high' : undefined, JSON.stringify(bad));
    ok('the setting is "auto" or one of seven levels; anything else is not a level');
  }

  // --------------------------------------------------------------------------------------------------------------------------- 2. the decision
  {
    const catalog = (presetId, model, apiBaseUrl = '') => lookup({ presetId, model, apiBaseUrl });
    const decide = (effort, protocol, info, apiBaseUrl = '') => reasoningDecision({ effort, protocol, apiBaseUrl, info });
    const sonnet = catalog('anthropic', 'claude-sonnet-5-5');
    const mini = catalog('openai', 'gpt-5-mini');
    const five1 = catalog('openai', 'gpt-5.1');
    const g38 = catalog('gemini', 'gemini-3.8-flash');
    const g36 = catalog('gemini', 'gemini-3.6-flash');
    const g25pro = catalog('gemini', 'gemini-2.5-pro');
    const g25flash = catalog('gemini', 'gemini-2.5-flash');
    const g25lite = catalog('gemini', 'gemini-2.5-flash-lite');
    const gemma = catalog('gemini', 'gemma-4-31b-it');
    const unknownGemini = catalog('custom-gemini', 'my-gemini', 'https://proxy.example.com');
    // a model whose budget range no rung of the ladder fits in on both sides (the catalog has none today, a model of tomorrow may)
    const narrow = { found: true, reasoning: { supported: true, toggle: false, budget: { min: 1024, max: 4096 }, efforts: [], levels: [] } };
    const geminiLevel = (thinkingLevel) => ({ field: 'generationConfig', value: { thinkingConfig: { thinkingLevel } } });
    const geminiBudget = (thinkingBudget) => ({ field: 'generationConfig', value: { thinkingConfig: { thinkingBudget } } });
    const rows = [
      // [label, effort, protocol, info, apiBaseUrl, expected send, expected why]
      ['auto sends nothing', AUTO, 'anthropic', sonnet, '', null, null],
      ['no setting sends nothing', undefined, 'openai-chat', mini, '', null, null],
      ['Messages: output_config.effort', 'high', 'anthropic', sonnet, '', { field: 'output_config', value: { effort: 'high' } }, null],
      ['Messages: the top level is offered', 'max', 'anthropic', sonnet, '', { field: 'output_config', value: { effort: 'max' } }, null],
      ['Messages: a level the model does not list', 'none', 'anthropic', sonnet, '', null, 'value_not_offered'],
      ['Messages: a model driven by a token budget', 'high', 'anthropic', catalog('anthropic', 'claude-sonnet-4-5-20250929'), '', null, 'no_effort_control'],
      ['Messages: an unknown model gets the level as chosen', 'medium', 'anthropic', catalog('anthropic', 'my-claude'), '', { field: 'output_config', value: { effort: 'medium' } }, null],
      ['Messages: but "minimal" and "none" are not Claude levels', 'minimal', 'anthropic', catalog('anthropic', 'my-claude'), '', null, 'value_not_valid_here'],
      ['Responses: reasoning.effort', 'low', 'openai-responses', mini, '', { field: 'reasoning', value: { effort: 'low' } }, null],
      ['Responses: minimal is a GPT-5 level', 'minimal', 'openai-responses', mini, '', { field: 'reasoning', value: { effort: 'minimal' } }, null],
      ['Responses: xhigh is not listed for GPT-5 mini', 'xhigh', 'openai-responses', mini, '', null, 'value_not_offered'],
      ['Responses: none, where the model allows no thinking', 'none', 'openai-responses', five1, '', { field: 'reasoning', value: { effort: 'none' } }, null],
      ['Chat: reasoning_effort', 'low', 'openai-chat', mini, '', { field: 'reasoning_effort', value: 'low' }, null],
      ['Chat on OpenRouter: reasoning.effort', 'high', 'openai-chat', catalog('openrouter', 'anthropic/claude-sonnet-5-5'), 'https://openrouter.ai/api/v1', { field: 'reasoning', value: { effort: 'high' } }, null],
      ['Chat: a model that does not think', 'low', 'openai-chat', (() => { for (const id of ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini']) { const info = catalog('openai', id); if (info.found && info.reasoning.supported === false) return info; } return null; })(), '', null, 'model_does_not_reason'],
      ['Chat: a model the catalog does not know gets the level', 'medium', 'openai-chat', catalog('custom-openai', 'my-alias', 'https://proxy.example.com'), 'https://proxy.example.com', { field: 'reasoning_effort', value: 'medium' }, null],
      // Gemini (generationConfig.thinkingConfig): Gemini 3 and 4 take a level, Gemini 2.5 a token budget, and the two are never sent together (the API answers 400).
      ['Gemini 3: thinkingLevel', 'high', 'gemini', g38, '', geminiLevel('high'), null],
      ['Gemini 3: a level the model does not list (minimal on 3.8 Flash)', 'minimal', 'gemini', g38, '', null, 'value_not_offered'],
      ['Gemini 3: minimal where the model lists it', 'minimal', 'gemini', g36, '', geminiLevel('minimal'), null],
      ['Gemini 3: the top levels of Claude are not Gemini levels', 'max', 'gemini', g38, '', null, 'value_not_offered'],
      ['Gemini 2.5 Pro: a level is a budget', 'high', 'gemini', g25pro, '', geminiBudget(24576), null],
      ['Gemini 2.5 Pro: the top level is the largest budget of the model', 'max', 'gemini', g25pro, '', geminiBudget(32768), null],
      ['Gemini 2.5 Pro: the smallest rung is above the floor of 128 the model has', 'minimal', 'gemini', g25pro, '', geminiBudget(512), null],
      ['Gemini 2.5 Pro: thinking cannot be switched off', 'none', 'gemini', g25pro, '', null, 'value_not_offered'],
      ['Gemini 2.5 Pro: xhigh is not a rung of the ladder', 'xhigh', 'gemini', g25pro, '', null, 'value_not_offered'],
      ['Gemini 2.5 Flash: none is a budget of 0', 'none', 'gemini', g25flash, '', geminiBudget(0), null],
      ['Gemini 2.5 Flash: medium', 'medium', 'gemini', g25flash, '', geminiBudget(8192), null],
      ['Gemini 2.5 Flash: high is held at the largest budget of the model', 'high', 'gemini', g25flash, '', geminiBudget(24576), null],
      ['Gemini 2.5 Flash-Lite: the budget starts at 512', 'minimal', 'gemini', g25lite, '', geminiBudget(512), null],
      ['Gemini 2.5 Flash-Lite: none is a budget of 0', 'none', 'gemini', g25lite, '', geminiBudget(0), null],
      ['Gemini: a rung below the range of the model is raised to its smallest budget', 'minimal', 'gemini', narrow, '', geminiBudget(1024), null],
      ['Gemini: a rung above the range is held at its largest budget', 'high', 'gemini', narrow, '', geminiBudget(4096), null],
      ['Gemma: a switch and no level', 'high', 'gemini', gemma, '', null, 'no_effort_control'],
      ['Gemini: a model the catalog does not know gets the level as chosen', 'high', 'gemini', unknownGemini, '', geminiLevel('high'), null],
      ['Gemini: but none and xhigh are not Gemini levels', 'xhigh', 'gemini', unknownGemini, '', null, 'value_not_valid_here'],
    ];
    for (const [label, effort, protocol, info, apiBaseUrl, send, why] of rows) {
      assert.ok(info !== null, `(premise) ${label}: the catalog has the model it is about`);
      assert.deepEqual(decide(effort, protocol, info, apiBaseUrl), { send, why }, label);
    }
    // applying a decision to a body
    const body = { model: 'm', output_config: { format: 'x' } };
    assert.deepEqual(applyReasoning({ ...body, output_config: { ...body.output_config } }, { field: 'output_config', value: { effort: 'high' } }), { model: 'm', output_config: { format: 'x', effort: 'high' } }, 'output_config keeps its other keys');
    assert.deepEqual(applyReasoning({ model: 'm' }, { field: 'reasoning_effort', value: 'low' }), { model: 'm', reasoning_effort: 'low' });
    assert.deepEqual(applyReasoning({ model: 'm' }, null), { model: 'm' });
    assert.deepEqual(applyReasoning({ model: 'm', generationConfig: { maxOutputTokens: 1024 } }, geminiLevel('low')), { model: 'm', generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'low' } } }, 'generationConfig keeps the output cap');
    ok(`${rows.length} cases of (setting x protocol x model) decide what is sent, or why nothing is`);

    // The levels a settings page offers are the levels the decision would send: from the catalog's list, or, for a model the catalog does not know, the three that every
    // provider that has the setting takes. When nothing can be offered, the reason is a code.
    const levelsOf = (protocol, info, apiBaseUrl = '') => offeredLevels({ protocol, apiBaseUrl, info });
    assert.deepEqual(levelsOf('anthropic', sonnet), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], known: true, why: null });
    assert.deepEqual(levelsOf('openai-responses', mini).levels, ['minimal', 'low', 'medium', 'high']);
    assert.deepEqual(levelsOf('openai-responses', five1).levels, ['none', 'low', 'medium', 'high'], 'none is offered where the model allows no thinking');
    assert.deepEqual(levelsOf('anthropic', catalog('anthropic', 'claude-sonnet-4-5-20250929')), { levels: [], known: true, why: 'no_effort_control' }, 'a model driven by a token budget');
    assert.deepEqual(levelsOf('openai-chat', rows[14][3]), { levels: [], known: true, why: 'model_does_not_reason' });
    assert.deepEqual(levelsOf('openai-chat', catalog('custom-openai', 'my-alias', 'https://proxy.example.com'), 'https://proxy.example.com'), { levels: ['low', 'medium', 'high'], known: false, why: null });
    assert.deepEqual(levelsOf('anthropic', catalog('anthropic', 'my-claude')), { levels: ['low', 'medium', 'high'], known: false, why: null });
    assert.deepEqual(levelsOf('gemini', g38), { levels: ['low', 'medium', 'high'], known: true, why: null }, 'Gemini 3: the levels the catalog lists');
    assert.deepEqual(levelsOf('gemini', g36).levels, ['minimal', 'low', 'medium', 'high']);
    assert.deepEqual(levelsOf('gemini', g25pro).levels, ['minimal', 'low', 'medium', 'high', 'max'], 'Gemini 2.5 Pro: the ladder of budgets, with no way to switch thinking off');
    assert.deepEqual(levelsOf('gemini', g25flash).levels, ['none', 'minimal', 'low', 'medium', 'high'], 'Gemini 2.5 Flash: none switches it off, and max is not offered because it is the same budget as high');
    assert.deepEqual(levelsOf('gemini', g25lite).levels, ['none', 'minimal', 'low', 'medium', 'high']);
    assert.deepEqual(levelsOf('gemini', gemma), { levels: [], known: true, why: 'no_effort_control' }, 'a switch and no budget');
    assert.deepEqual(levelsOf('gemini', unknownGemini), { levels: ['low', 'medium', 'high'], known: false, why: null });
    assert.deepEqual(levelsOf('openai-chat', catalog('openrouter', 'anthropic/claude-sonnet-5-5'), 'https://openrouter.ai/api/v1').levels, ['low', 'medium', 'high', 'xhigh', 'max']);
    // the invariant, over every model of the providers a person is most likely to use: nothing is offered that would not be sent
    const catalogs = [['anthropic', 'anthropic', 'anthropic'], ['openai', 'openai-responses', 'openai'], ['openai', 'openai-chat', 'openai'], ['openrouter', 'openai-chat', 'openrouter'], ['google', 'gemini', 'gemini'], ['mistral', 'openai-chat', 'mistral'], ['groq', 'openai-chat', 'groq']];
    let offered = 0;
    for (const [provider, protocol, presetId] of catalogs) {
      for (const model of createCatalog(snapshot).modelIds(provider)) {
        const info = lookup({ provider, presetId, model });
        const result = offeredLevels({ protocol, apiBaseUrl: presetId === 'openrouter' ? 'https://openrouter.ai/api/v1' : '', info });
        assert.ok(result.levels.every((level) => EFFORT_LEVELS.includes(level)), `${provider}/${model}`);
        for (const level of result.levels) {
          assert.notEqual(reasoningDecision({ effort: level, protocol, apiBaseUrl: presetId === 'openrouter' ? 'https://openrouter.ai/api/v1' : '', info }).send, null, `${provider}/${model}: ${level} is offered and would not be sent`);
          offered += 1;
        }
      }
    }
    assert.ok(offered > 500, `(premise) the invariant was checked on ${offered} offered levels`);
    ok(`the levels a settings page offers are exactly those that would be sent (${offered} offered levels over ${catalogs.length} provider listings), and the reason for none is a code`);
  }

  // --------------------------------------------------------------------------------------------------------------------------- the refusal test
  {
    const refused = (status, error, kind = 'request') => {
      const data = { error };
      const info = classifyHttpError({ status, data, headers: new Headers() });
      assert.equal(info.kind, kind, `(premise) the class of ${status} ${JSON.stringify(error)}`);
      return refusesReasoning({ status, data, info, sent: true });
    };
    // the provider refuses the setting
    assert.equal(refused(400, { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning_effort' }), true);
    assert.equal(refused(400, { message: "Unknown parameter: 'reasoning.effort'.", param: 'reasoning.effort' }), true);
    assert.equal(refused(400, { type: 'invalid_request_error', message: 'output_config.effort: Extra inputs are not permitted' }), true);
    assert.equal(refused(400, { type: 'invalid_request_error', message: 'This model does not support the effort parameter.' }), true);
    assert.equal(refused(400, { message: "'thinking' is not supported by this model" }), true);
    assert.equal(refused(422, { message: 'reasoning is not enabled for this model' }), true);
    // Gemini words it with its own field names (camel or snake case) inside a Google error envelope
    assert.equal(refused(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload received. Unknown name "thinkingConfig" at \'generation_config\': Cannot find field.' }), true);
    assert.equal(refused(400, { code: 400, status: 'INVALID_ARGUMENT', message: "Unable to submit request because thinking_budget is not supported by this model. Remove thinking_budget and try again." }), true);
    assert.equal(refused(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid value at \'generation_config.thinking_config.thinking_level\' (type.googleapis.com/google.ai.generativelanguage.v1beta.ThinkingConfig.ThinkingLevel), "extreme"' }), true);
    assert.equal(refused(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'Cannot set both thinkingBudget and thinkingLevel.' }), true);
    // something else: the context, the output cap, the quota, the model, a rate limit, a server error
    assert.equal(refused(400, { message: "This model's maximum context length is 8192 tokens." }, 'context'), false);
    assert.equal(refused(400, { message: 'max_tokens: 99999 > 8192, which is the maximum allowed number of output tokens for claude-x' }, 'max_tokens'), false);
    assert.equal(refused(400, { message: 'You exceeded your current quota' }, 'quota'), false);
    assert.equal(refused(400, { message: 'The model `x` does not exist' }, 'model'), false);
    assert.equal(refused(429, { message: 'effort exceeded the rate limit' }, 'rate_limit'), false);
    assert.equal(refused(500, { message: 'reasoning backend failed' }, 'server'), false);
    assert.equal(refused(400, { message: 'messages.0.content: Input should be a valid string' }), false, 'a plain 400 that does not name the setting');
    assert.equal(refusesReasoning({ status: 400, data: { error: { message: 'reasoning_effort is not supported' } }, info: { kind: 'request' }, sent: false }), false, 'nothing was sent, so nothing was refused');
    ok('a 400/422 that names the setting is its refusal; the context, the output cap, the quota, the model, a rate limit, a server error and an unrelated 400 are not');
  }

  // --------------------------------------------------------------------------------------------------------------------------- the answer the settings page asks for
  {
    const ask = (params) => modelInfo(modelInfoQuery(new URLSearchParams(params)));
    const sonnet = ask({ preset: 'anthropic', model: 'claude-sonnet-5-5' });
    assert.deepEqual([sonnet.found, sonnet.confidence, sonnet.provider, sonnet.protocol, sonnet.local], [true, 'exact', 'anthropic', 'anthropic', false], 'the protocol follows the preset');
    assert.deepEqual(sonnet.reasoning, { supported: true, toggle: false, budget: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], levels: ['low', 'medium', 'high', 'xhigh', 'max'], known: true, why: null });
    assert.deepEqual([sonnet.contextWindow, sonnet.maxOutput, sonnet.toolCall, sonnet.vision], [1000000, 128000, true, true]);
    assert.equal(sonnet.source, `catalog@${snapshot.generatedAt}`);
    assert.deepEqual(Object.keys(sonnet.catalog).sort(), ['ageDays', 'generatedAt']);
    // a "custom" connection: the endpoint says which provider it is, and the protocol is the one asked for
    const custom = ask({ preset: 'custom-openai', protocol: 'openai-responses', apiBaseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' });
    assert.deepEqual([custom.found, custom.provider, custom.protocol, custom.reasoning.levels], [true, 'openai', 'openai-responses', ['minimal', 'low', 'medium', 'high']]);
    // a model the catalog does not know: not found, the three common levels, and the page can say it is a guess
    const unknown = ask({ preset: 'custom-openai', apiBaseUrl: 'https://litellm.example.com', model: 'my-alias' });
    assert.deepEqual([unknown.found, unknown.confidence, unknown.source, unknown.contextWindow, unknown.reasoning.levels, unknown.reasoning.known, unknown.reasoning.why], [false, 'none', null, null, ['low', 'medium', 'high'], false, null]);
    // a local runtime: not found either, marked local
    const local = ask({ preset: 'ollama', model: 'qwen2.5-coder:7b' });
    assert.deepEqual([local.found, local.local, local.reasoning.levels], [false, true, ['low', 'medium', 'high']]);
    // Gemini 2.5: driven by a budget, which the levels are mapped onto (the ladder, with the top level the largest budget of the model)
    const gemini = ask({ preset: 'gemini', model: 'gemini-2.5-pro' });
    assert.deepEqual([gemini.reasoning.levels, gemini.reasoning.why, gemini.reasoning.budget], [['minimal', 'low', 'medium', 'high', 'max'], null, { min: 128, max: 32768 }]);
    // and a switch with no budget (Gemma) still has nothing to offer
    const gemma = ask({ preset: 'gemini', model: 'gemma-4-31b-it' });
    assert.deepEqual([gemma.reasoning.levels, gemma.reasoning.why], [[], 'no_effort_control']);
    // what is refused
    const refusal = (params, pattern) => assert.throws(() => modelInfoQuery(new URLSearchParams(params)), (error) => error.code === 'invalid_model_info_query' && error.statusCode === 400 && pattern.test(error.message), JSON.stringify(params));
    refusal({}, /model/);
    refusal({ preset: 'anthropic' }, /model/);
    refusal({ preset: 'anthropic', model: 'has space' }, /model/);
    refusal({ preset: 'anthropic', model: 'x'.repeat(200) }, /model/);
    refusal({ preset: 'nonsense', model: 'm' }, /preset/);
    refusal({ protocol: 'smtp', model: 'm' }, /protocol/);
    refusal({ model: 'm' }, /protocol|preset/);
    refusal({ preset: 'anthropic', model: 'm', apiBaseUrl: 'not a url' }, /apiBaseUrl/);
    refusal({ preset: 'anthropic', model: 'm', apiBaseUrl: 'ftp://example.com' }, /apiBaseUrl/);
    ok('the answer for the settings page: the limits of the model and its levels with their reason, the protocol from the preset, "not found" for an alias or a local runtime, and a refusal for a query that is not one');
  }

  // --------------------------------------------------------------------------------------------------------------------------- 3. on the wire
  const mock = async (options = {}) => { const server = await startMockModel({ scenario: 'canned-answer', keepBodies: true, strict: true, ...options }); closers.push(() => server.close()); return server; };
  const manager = { secrets: [] };
  const fork = (server, protocol, profile = {}) => new GatewayProvider({ directory: path.join(root, `gw-${protocol}`), bundleRoot: root, manager, env: {}, sleep: async () => {} })
    .forkForTask({ protocol, apiBaseUrl: server.origin, model: 'mock-coder', ...profile });
  const HI = () => [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }];
  const ask = (provider, options = {}) => provider.respond({ input: HI(), instructions: 'system', tools: [], maxOutputTokens: 1024, signal: AbortSignal.timeout(8000), ...options });
  const FIELDS = { 'openai-chat': (body) => body.reasoning_effort, 'openai-responses': (body) => body.reasoning, anthropic: (body) => body.output_config, gemini: (body) => body.generationConfig?.thinkingConfig };
  const EXPECTED = { 'openai-chat': 'high', 'openai-responses': { effort: 'high' }, anthropic: { effort: 'high' }, gemini: { thinkingLevel: 'high' } };
  const VALIDATORS = { 'openai-chat': validateChatRequest, 'openai-responses': validateResponsesRequest, anthropic: (body) => validateAnthropicRequest(body, {}), gemini: (body) => validateGeminiRequest(body) };
  {
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'gemini']) {
      const server = await mock({ strict: { chat: true, anthropic: true, responses: true, gemini: true } });
      const sent = await ask(fork(server, protocol, { reasoningEffort: 'high' }));
      assert.equal(sent.status, 'completed', protocol);
      assert.deepEqual(FIELDS[protocol](server.state.requests.at(-1).body), EXPECTED[protocol], `${protocol}: the setting is in the request`);
      if (protocol === 'anthropic') {
        // a Claude model asked to think hard spends output tokens before it writes the answer: the cap asked for (1,024) is raised to the default for it, and not for a light level
        assert.ok(server.state.requests.at(-1).body.max_tokens >= 16384, 'heavy thinking leaves room for the answer');
        await ask(fork(server, protocol, { reasoningEffort: 'low' }));
        assert.equal(server.state.requests.at(-1).body.max_tokens, 1024, 'a light level keeps the cap that was asked for');
        assert.deepEqual(server.state.requests.at(-1).body.output_config, { effort: 'low' });
      }
      assert.equal(server.state.requests.at(-1).rejected, null, `${protocol}: the strict server accepted it`);
      assert.deepEqual(VALIDATORS[protocol](server.state.requests.at(-1).body).errors, [], `${protocol}: and so does the validator`);
      // auto and nothing: no field
      for (const profile of [{}, { reasoningEffort: 'auto' }]) {
        await ask(fork(server, protocol, profile));
        assert.equal(FIELDS[protocol](server.state.requests.at(-1).body), undefined, `${protocol}: ${JSON.stringify(profile)} sends nothing`);
      }
    }
    ok('Chat reasoning_effort, Responses reasoning.effort, Messages output_config.effort and Gemini thinkingConfig reach a strict server; "auto" and no setting send nothing');
  }
  {
    // Gemini: the catalog decides between a level (Gemini 3 and 4) and a token budget (Gemini 2.5). The mock server is on loopback, where the catalog answers "a local
    // runtime", so the test brings a catalog that answers for Google whatever the address.
    const google = { lookup: (query) => lookup({ ...query, provider: 'google' }) };
    const geminiFork = (server, model, effort) => new GatewayProvider({ directory: path.join(root, `gw-gemini-${model}-${effort}`), bundleRoot: root, manager, env: {}, sleep: async () => {}, catalog: google })
      .forkForTask({ protocol: 'gemini', apiBaseUrl: server.origin, model, reasoningEffort: effort });
    const server = await mock({ strict: { chat: true, anthropic: true, responses: true, gemini: true } });
    const wireFor = async (model, effort) => {
      const provider = geminiFork(server, model, effort);
      assert.equal((await ask(provider)).status, 'completed', `${model} ${effort}`);
      const request = server.state.requests.at(-1);
      assert.equal(request.rejected, null, `${model} ${effort}: the strict server accepted it`);
      assert.deepEqual(validateGeminiRequest(request.body).errors, [], `${model} ${effort}: and so does the validator`);
      return { config: request.body.generationConfig, state: provider.state().reasoning };
    };
    const thinking = async (model, effort) => (await wireFor(model, effort)).config.thinkingConfig;
    assert.deepEqual(await thinking('gemini-3.8-flash', 'high'), { thinkingLevel: 'high' }, 'Gemini 3 and 4 take a level');
    assert.deepEqual(await thinking('gemini-3.6-flash', 'minimal'), { thinkingLevel: 'minimal' });
    assert.deepEqual(await thinking('gemini-2.5-pro', 'max'), { thinkingBudget: 32768 }, 'Gemini 2.5 takes a budget, never a level and a budget together');
    assert.deepEqual(await thinking('gemini-2.5-flash', 'medium'), { thinkingBudget: 8192 });
    assert.deepEqual(await thinking('gemini-2.5-flash', 'none'), { thinkingBudget: 0 }, 'none switches thinking off where the model allows it');
    const auto = await wireFor('gemini-3.8-flash', 'auto');
    assert.equal(auto.config.thinkingConfig, undefined, 'auto sends nothing');
    assert.equal(typeof auto.config.maxOutputTokens, 'number', 'and the output cap is still there');
    const kept = await wireFor('gemini-3.8-flash', 'high');
    assert.equal(typeof kept.config.maxOutputTokens, 'number', 'the thinking setting is added to the generation config, it does not replace it');
    // a level the model does not list is not sent, and the connection says why
    const notOffered = await wireFor('gemini-3.8-flash', 'minimal');
    assert.equal(notOffered.config.thinkingConfig, undefined);
    assert.deepEqual(notOffered.state, { effort: 'minimal', sent: false, why: 'value_not_offered', refused: false });
    ok('Gemini: a level for Gemini 3 and 4, a budget for 2.5 (never both), nothing for auto or for a level the model does not list, and the output cap stays');

    // The thoughts count against the output cap (asked for: 1,024): a budget leaves 4,096 for the answer above it, a heavy level gets the 16,384 of the Messages API, a light one nothing
    assert.equal((await wireFor('gemini-2.5-pro', 'max')).config.maxOutputTokens, 36864, 'a budget of 32,768 and room for the answer');
    assert.equal((await wireFor('gemini-2.5-flash', 'medium')).config.maxOutputTokens, 12288);
    assert.equal((await wireFor('gemini-3.8-flash', 'high')).config.maxOutputTokens, 16384);
    assert.equal((await wireFor('gemini-3.8-flash', 'medium')).config.maxOutputTokens, 16384);
    assert.equal((await wireFor('gemini-3.8-flash', 'low')).config.maxOutputTokens, 1024, 'a light level keeps the cap that was asked for');
    assert.equal((await wireFor('gemini-2.5-flash', 'none')).config.maxOutputTokens, 1024, 'and so does thinking switched off');
    // a model that takes less learns it from the 400 answer, and the raised cap follows it down: the thinking setting stays (the 400 is about the cap, not about it)
    const small = await mock({ strict: false });
    small.inject({ kind: 'status', status: 400, message: 'Unable to submit request: the maxOutputTokens value of 36864 is invalid, the supported range is from 1 (inclusive) to 8193 (exclusive).', times: 1, on: 'gemini' });
    const learner = geminiFork(small, 'gemini-2.5-pro', 'max');
    assert.equal((await ask(learner)).status, 'completed');
    assert.deepEqual(small.state.requests.map((request) => request.body.generationConfig.maxOutputTokens), [36864, 8192], 'the repeat asks for what the model takes');
    assert.deepEqual(small.state.requests[1].body.generationConfig.thinkingConfig, { thinkingBudget: 32768 }, 'and still carries the setting');
    assert.equal(learner.state().reasoning.refused, false, 'a 400 about the cap does not blame the setting');
    await ask(learner);
    assert.equal(small.state.requests.at(-1).body.generationConfig.maxOutputTokens, 8192, 'later requests keep the learned cap');
    ok('Gemini: the output cap is raised to leave room for the answer after the thoughts, and follows a cap the model turns out to have');
  }
  {
    // the Responses stream carries the field too (the agent always asks for a stream)
    const server = await mock();
    const tokens = [];
    const streamed = await new GatewayProvider({ directory: path.join(root, 'gw-stream'), bundleRoot: root, manager, env: {}, sleep: async () => {} })
      .forkForTask({ protocol: 'openai-responses', apiBaseUrl: server.origin, model: 'mock-coder', reasoningEffort: 'low' })
      .respond({ input: HI(), instructions: 'system', tools: [], maxOutputTokens: 1024, signal: AbortSignal.timeout(8000), onToken: (token) => tokens.push(token) });
    assert.equal(streamed.status, 'completed');
    assert.equal(server.state.requests.at(-1).stream, true);
    assert.deepEqual(server.state.requests.at(-1).body.reasoning, { effort: 'low' });
    ok('a streamed Responses request carries the setting');
  }

  // --------------------------------------------------------------------------------------------------------------------------- 4. a provider that refuses it
  {
    const REFUSALS = {
      'openai-chat': { param: 'reasoning_effort', message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." },
      'openai-responses': { param: 'reasoning', message: "Unsupported parameter: 'reasoning.effort' is not supported with this model." },
      anthropic: { param: 'output_config', message: 'output_config.effort: Extra inputs are not permitted' },
      // Gemini keeps the setting inside generationConfig: the server refuses that nested field and the Hub drops only it, not the output cap
      gemini: { param: 'generationConfig.thinkingConfig', message: 'Invalid JSON payload received. Unknown name "thinkingConfig" at \'generation_config\': Cannot find field.' },
    };
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'gemini']) {
      const server = await mock({ strict: false });
      const refusal = server.refuseParam(REFUSALS[protocol].param, { message: REFUSALS[protocol].message });
      const provider = fork(server, protocol, { reasoningEffort: 'high' });
      const said = [];
      assert.equal((await ask(provider, { onStatus: async (message) => said.push(message) })).status, 'completed', `${protocol}: the task goes on`);
      const requests = server.state.requests;
      assert.equal(requests.length, 2, `${protocol}: one refused request and its repeat`);
      assert.notEqual(FIELDS[protocol](requests[0].body), undefined, `${protocol}: the first request carried the setting`);
      assert.equal(FIELDS[protocol](requests[1].body), undefined, `${protocol}: the repeat did not`);
      assert.equal(refusal.used, 1);
      assert.equal(said.filter((message) => /thinking|reasoning|suy luận/i.test(message)).length, 1, `${protocol}: the person is told once that the setting was dropped`);
      // remembered: the next request does not carry it, and nothing is refused again
      assert.equal((await ask(provider)).status, 'completed');
      assert.equal(server.state.requests.length, 3, `${protocol}: one request, no refusal`);
      assert.equal(FIELDS[protocol](server.state.requests[2].body), undefined);
      assert.equal(refusal.used, 1, `${protocol}: the provider was not asked with the setting again`);
      assert.equal(provider.state().reasoning.refused, true, `${protocol}: the connection says so`);
      // another model of the same endpoint is another question
      const other = new GatewayProvider({ directory: path.join(root, 'gw-other'), bundleRoot: root, manager, env: {}, sleep: async () => {} })
        .forkForTask({ protocol, apiBaseUrl: server.origin, model: 'mock-coder-small', reasoningEffort: 'high' });
      const before = server.state.requests.length;
      await ask(other);
      assert.equal(server.state.requests.length - before, 2, `${protocol}: another model asks again, is refused again, and is repeated without the setting`);
      assert.notEqual(FIELDS[protocol](server.state.requests[before].body), undefined, `${protocol}: the first of the two carries the setting`);
      assert.equal(refusal.used, 2);
      if (protocol === 'gemini') assert.equal(typeof server.state.requests[1].body.generationConfig?.maxOutputTokens, 'number', 'gemini: the repeat keeps the output cap, and does not fall back to a dialect without a generation config');
    }
    ok('a provider that refuses the setting: the model request is repeated once without it, the task goes on, the person is told once, and the refusal is remembered for the connection');
  }
  {
    // saving the connection again gives the provider another chance: what was learned about a refusal belongs to the configuration it was learned under
    const server = await mock({ strict: false });
    const refusal = server.refuseParam('reasoning_effort', { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." });
    const gateway = new GatewayProvider({ directory: path.join(root, 'gw-reconfigured'), bundleRoot: root, manager, env: {}, sleep: async () => {} });
    await gateway.load();
    await gateway.configure({ preset: 'custom-openai', apiBaseUrl: server.origin, model: 'mock-coder', reasoningEffort: 'high' });
    await ask(gateway);
    await ask(gateway);
    assert.equal(refusal.used, 1, 'refused once, remembered');
    assert.equal(gateway.state().reasoning.refused, true);
    await gateway.configure({ reasoningEffort: 'high' });
    assert.equal(gateway.state().reasoning.refused, false, 'saving the configuration forgets the refusal');
    await ask(gateway);
    assert.equal(refusal.used, 2, 'and the provider is asked again');
    ok('saving the configuration again forgets a remembered refusal, and the provider is asked again');
  }
  {
    // a 400 about something else is not the setting's refusal: it surfaces, and nothing is repeated
    const server = await mock({ strict: false });
    server.inject({ kind: 'status', status: 400, message: 'max_tokens: 99999 > 8192, which is the maximum allowed number of output tokens for mock-coder', times: 1 });
    const provider = fork(server, 'anthropic', { reasoningEffort: 'high' });
    const outcome = await ask(provider).then(() => null, (error) => error);
    assert.ok(outcome === null || outcome instanceof Error);
    assert.equal(provider.state().reasoning.refused, false, 'a 400 about the output cap does not blame the setting');
    ok('a 400 about the output cap is not taken for a refusal of the setting');
  }

  // --------------------------------------------------------------------------------------------------------------------------- 5. where the setting lives
  {
    // the global connection
    const directory = path.join(root, 'global');
    const gateway = new GatewayProvider({ directory, bundleRoot: root, manager, env: {}, platform: 'linux' });
    await gateway.load();
    assert.equal(gateway.state().reasoningEffort, AUTO, 'the default is auto');
    await gateway.configure({ preset: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'medium', apiKey: 'sk-ant-test-0123456789', remember: true });
    assert.equal(gateway.state().reasoningEffort, 'medium');
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'gateway-config.json'), 'utf8'));
    assert.equal(saved.reasoningEffort, 'medium', 'it is in the saved configuration');
    const reloaded = new GatewayProvider({ directory, bundleRoot: root, manager, env: {}, platform: 'linux' });
    await reloaded.load();
    assert.equal(reloaded.state().reasoningEffort, 'medium', 'and survives a restart');
    await reloaded.configure({ model: 'claude-opus-5-5' });
    assert.equal(reloaded.state().reasoningEffort, 'medium', 'an omitted field keeps it');
    await reloaded.configure({ preset: 'openai' });
    assert.equal(reloaded.state().reasoningEffort, AUTO, 'another provider starts at auto: a level chosen for one model is not carried to another provider');
    await reloaded.configure({ reasoningEffort: 'auto' });
    assert.equal(reloaded.state().reasoningEffort, AUTO, 'auto clears it');
    await assert.rejects(() => reloaded.configure({ reasoningEffort: 'extreme' }), (error) => error.code === 'invalid_reasoning_effort' && error.statusCode === 400 && /auto|low|high/.test(error.message));
    assert.equal(reloaded.state().reasoningEffort, AUTO, 'a refused value changes nothing');
    // a hand-edited file with a word that is not a level is read as auto
    await fs.writeFile(path.join(directory, 'gateway-config.json'), JSON.stringify({ ...saved, reasoningEffort: 'extreme' }));
    const damaged = new GatewayProvider({ directory, bundleRoot: root, manager, env: {}, platform: 'linux' });
    await damaged.load();
    assert.equal(damaged.state().reasoningEffort, AUTO);
    // the model profiles
    const profiles = new AiProfiles({ stateDir: path.join(root, 'profiles'), keyStore: { encrypt: async (text) => `sealed:${text}`, decrypt: async (blob) => blob.replace(/^sealed:/, '') } });
    await profiles.load();
    const base = { id: 'work', provider: 'anthropic', model: 'claude-sonnet-5-5', apiBaseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test-0123456789' };
    assert.equal((await profiles.upsert(base)).reasoningEffort, AUTO, 'a new profile starts at auto');
    assert.equal((await profiles.upsert({ ...base, reasoningEffort: 'high' })).reasoningEffort, 'high');
    assert.equal((await profiles.upsert({ id: 'work', provider: 'anthropic', model: 'claude-opus-5-5', apiBaseUrl: 'https://api.anthropic.com' })).reasoningEffort, 'high', 'an omitted field keeps it');
    assert.equal(profiles.list().find((profile) => profile.id === 'work').reasoningEffort, 'high');
    assert.equal((await profiles.resolveConfig('work')).reasoningEffort, 'high', 'a task gets it with the rest of the profile');
    await assert.rejects(() => profiles.upsert({ ...base, reasoningEffort: 'extreme' }), (error) => error.code === 'invalid_reasoning_effort' && error.statusCode === 400);
    assert.equal(profiles.get('work').reasoningEffort, 'high', 'a refused value changes nothing');
    assert.equal((await profiles.upsert({ ...base, reasoningEffort: 'auto' })).reasoningEffort, AUTO, 'auto clears it');
    ok('the setting is saved with the global connection and with a profile, survives a restart, is kept when omitted, cleared by auto, refused when it is not a level, and read as auto from a damaged file');
  }

  // --------------------------------------------------------------------------------------------------------------------------- 6. negative controls
  {
    const server = await mock({ strict: false });
    const provider = fork(server, 'anthropic', { reasoningEffort: 'high' });
    await ask(provider);
    assert.deepEqual(server.state.requests.at(-1).body.output_config, { effort: 'high' }, '(premise) the real path sends it');
    // a decision table that is wrong would be caught: the same probe on a doctored catalog answer
    const wrong = { found: true, reasoning: { supported: true, efforts: ['low'], toggle: false, budget: null } };
    assert.deepEqual(reasoningDecision({ effort: 'high', protocol: 'anthropic', info: wrong }), { send: null, why: 'value_not_offered' });
    assert.deepEqual(reasoningDecision({ effort: 'low', protocol: 'anthropic', info: wrong }).send, { field: 'output_config', value: { effort: 'low' } });
    ok('negative controls: a catalog answer that lists fewer levels changes the decision');
  }
} finally {
  for (const close of closers) await close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}

console.log(`\nPASS: ${checks} reasoning effort checks`);
