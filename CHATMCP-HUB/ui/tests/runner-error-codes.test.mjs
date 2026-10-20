import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundleTsx } from './support/bundle.mjs';

// The AgentRunner ends a worker's run with a code (`task.errorCode`) and a sentence of its own, mostly Vietnamese. The Hub passes both on (`runnerErrorCode`,
// `runnerError`) and the page tells the code in the language on screen with the sentence `agent_error_<code>`, above the Hub's sentence as written.
// This pins the page's sentences against what the runner can really send, in both directions: a sentence for a code that nothing sends is as wrong as a code
// that ends runs and has no sentence without anybody having decided so.
const { loaded, dispose } = await bundleTsx(`
  export { translations } from './src/lib/i18n';
`, 'chatmcp-runner-codes-');
after(dispose);
const { translations } = loaded;

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (file) => fs.readFileSync(root + file, 'utf8');
const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;

/**
 * The codes the page tells when a worker's run ends with them, and the files that send each one (quoted exactly, as `'code'`). The runner's own are raised by
 * `fault('...')` in lib/agent.mjs; the others come from the model adapters, whatever the provider or the protocol.
 */
const TOLD = {
  // the AgentRunner itself
  user_cancelled: ['lib/agent.mjs'],
  shutdown: ['lib/agent.mjs'],
  time_limit: ['lib/agent.mjs'],
  step_limit: ['lib/agent.mjs'],
  context_limit: ['lib/agent.mjs'],
  output_limit: ['lib/agent.mjs'],
  model_response_failed: ['lib/agent.mjs'],
  model_refusal: ['lib/agent.mjs'],
  empty_final: ['lib/agent.mjs'],
  progress_stalled: ['lib/agent.mjs'],
  tool_transport_failed: ['lib/agent.mjs'],
  persistence_failed: ['lib/agent.mjs'],
  task_failed: ['lib/agent.mjs'],
  provider_changed: ['lib/agent.mjs'],
  workspace_changed: ['lib/agent.mjs'],
  // the model adapters
  model_empty: ['lib/openai-chat-api.mjs', 'lib/anthropic-api.mjs', 'lib/gateway-provider.mjs'],
  gateway_auth: ['lib/model-http.mjs', 'lib/gateway-provider.mjs'],
  gateway_quota: ['lib/model-http.mjs'],
  gateway_rate_limit: ['lib/model-http.mjs', 'lib/gateway-provider.mjs'],
  gateway_overloaded: ['lib/model-http.mjs'],
  gateway_model_not_found: ['lib/model-http.mjs'],
  gateway_context_length: ['lib/model-http.mjs', 'lib/standard-adapter.mjs'],
  gateway_network: ['lib/standard-adapter.mjs'],
  gateway_timeout: ['lib/standard-adapter.mjs'],
  gateway_http_error: ['lib/model-http.mjs', 'lib/gateway-provider.mjs'],
  // the OpenAI Responses protocol: the same two failures as above, which are the ones a worker meets (a model that says nothing, a stream that is cut)
  empty_responses_output: ['lib/openai-responses-api.mjs'],
  responses_stream_interrupted: ['lib/openai-responses-api.mjs'],
};

/**
 * Codes that can end a worker's run and that the page deliberately shows as the Hub wrote them: rare faults of a protocol (said once, in full, in the record), checks of a
 * request that a worker's request does not trip (an attachment an adapter cannot carry: a worker has none), and the Gemini text dialect, which few workers use. The Responses
 * adapter words its own in English, which an English reader needs no line for.
 */
const SHOWN_AS_WRITTEN = {
  invalid_response: ['lib/agent.mjs'],
  invalid_response_role: ['lib/agent.mjs'],
  invalid_call_id: ['lib/agent.mjs'],
  model_incomplete: ['lib/openai-chat-api.mjs', 'lib/gateway-provider.mjs'],
  model_invalid_function: ['lib/openai-chat-api.mjs', 'lib/anthropic-api.mjs', 'lib/gateway-provider.mjs'],
  gateway_invalid_json: ['lib/standard-adapter.mjs', 'lib/gateway-provider.mjs'],
  gateway_too_large: ['lib/model-http.mjs', 'lib/gateway-provider.mjs'],
  gateway_context_budget: ['lib/gateway-provider.mjs', 'lib/gemini-compat.mjs'],
  unsupported_image: ['lib/openai-chat-api.mjs', 'lib/anthropic-api.mjs'],
  unsupported_media: ['lib/openai-chat-api.mjs', 'lib/anthropic-api.mjs'],
  invalid_responses_history: ['lib/openai-responses-api.mjs'],
  duplicate_responses_call: ['lib/openai-responses-api.mjs'],
  unbound_responses_tool_result: ['lib/openai-responses-api.mjs'],
  unsupported_responses_media: ['lib/openai-responses-api.mjs'],
  invalid_responses_call: ['lib/openai-responses-api.mjs'],
  invalid_responses_arguments: ['lib/openai-responses-api.mjs'],
  invalid_responses_model: ['lib/openai-responses-api.mjs'],
  invalid_responses_tool: ['lib/openai-responses-api.mjs'],
  invalid_responses_json: ['lib/openai-responses-api.mjs'],
  incomplete_responses_tool: ['lib/openai-responses-api.mjs'],
  unsupported_responses_tool: ['lib/openai-responses-api.mjs'],
  invalid_responses_stream: ['lib/openai-responses-api.mjs'],
  duplicate_responses_terminal: ['lib/openai-responses-api.mjs'],
  responses_stream_too_large: ['lib/openai-responses-api.mjs'],
  gateway_text_no_candidate: ['lib/gemini-compat.mjs'],
  gateway_text_incomplete: ['lib/gemini-compat.mjs'],
  gateway_text_malformed_function: ['lib/gemini-compat.mjs'],
  gateway_text_finish_reason: ['lib/gemini-compat.mjs'],
  gateway_text_protocol_invalid: ['lib/gemini-compat.mjs'],
};

/**
 * `fault('...')` of lib/agent.mjs that never end a run: they refuse a request or fail the start (before a run exists, so a worker never has them as its record), or
 * they are a tool call that the model is told about and corrects (`invalid_arguments`, `unknown_*`: lib/agent.mjs lets only an `upstream` fault out of a call).
 */
const NEVER_A_RUN_RECORD = [
  'invalid_attachments', 'invalid_attachment', 'protected_attachment', 'attachments_too_large', 'image_too_large', 'unsupported_attachment',
  'empty_catalog', 'invalid_catalog', 'invalid_task_id', 'task_running', 'task_not_found', 'task_not_running', 'invalid_auto_resume', 'invalid_prompt', 'pending_messages_full',
  'shutting_down', 'invalid_limits', 'hub_busy', 'preflight_timeout', 'workspace_missing', 'provider_not_ready',
  'invalid_arguments', 'unknown_function', 'unknown_tool', 'unknown_capability',
];

/**
 * Where the model adapters raise the errors a worker's run can end with, and how each file writes its codes: a local `fail('code'` helper, or (model-http, which names an HTTP
 * answer) the `gateway_*` literals, or (the Gemini text protocol) `gateway_text_*`. gateway-provider.mjs is not read this way: most of its `bad('code'` are about the settings
 * (a bad URL, a missing key) and end no run; the codes of it that do are the ones above, which these files raise as well.
 */
const ADAPTERS = {
  'lib/openai-chat-api.mjs': /\bfail\(\s*'([a-z][a-z0-9_]*)'/g,
  'lib/openai-responses-api.mjs': /\bfail\(\s*'([a-z][a-z0-9_]*)'/g,
  'lib/anthropic-api.mjs': /\bfail\(\s*'([a-z][a-z0-9_]*)'/g,
  'lib/standard-adapter.mjs': /\bfail\(\s*'([a-z][a-z0-9_]*)'/g,
  'lib/model-http.mjs': /'(gateway_[a-z_]+)'/g,
  'lib/gemini-compat.mjs': /'(gateway_text_[a-z_]+)'/g,
};

const agentSource = read('lib/agent.mjs');
const faultsOfAgent = () => [...new Set([...agentSource.matchAll(/\bfault\(\s*'([a-z][a-z0-9_]*)'/g)].map((match) => match[1]))];
const told = () => Object.keys(translations.vi).filter((key) => key.startsWith('agent_error_')).map((key) => key.slice('agent_error_'.length));

test('every code the page tells for a run that ended is one that the runner or an adapter really sends, in the file named, in both languages', () => {
  for (const [code, files] of Object.entries(TOLD)) {
    for (const file of files) assert.ok(read(file).includes(`'${code}'`), `${code} is no longer sent by ${file}`);
    assert.ok(translations.vi[`agent_error_${code}`]?.trim(), `vi: no sentence for ${code}`);
    assert.ok(translations.en[`agent_error_${code}`]?.trim(), `en: no sentence for ${code}`);
    assert.doesNotMatch(translations.en[`agent_error_${code}`], VIETNAMESE, `en.${code} still reads Vietnamese`);
  }
});

test('a sentence is written for no code that nothing sends, and no sentence for a code of the runner is missing from the list above', () => {
  const route = ['hub.mjs', 'lib/coding-orchestrator.mjs', 'lib/worker-test-broker.mjs'].map(read).join('\n');
  const runner = [...new Set(Object.values(TOLD).flat())].map(read).join('\n');
  const stray = told().filter((code) => !route.includes(`'${code}'`) && !runner.includes(`'${code}'`));
  assert.deepEqual(stray, [], 'a sentence for a code that no file sends any more');
  // a sentence for a code that only the runner side sends must be on the list, so that the list is the whole record of what the page tells for a run
  const unlisted = told().filter((code) => !(code in TOLD) && !route.includes(`'${code}'`));
  assert.deepEqual(unlisted, [], 'a sentence for a code of the runner that TOLD does not list');
});

test('a code that ends runs and has no sentence is a decision written down here, not an accident', () => {
  for (const [code, files] of Object.entries(SHOWN_AS_WRITTEN)) {
    for (const file of files) assert.ok(read(file).includes(`'${code}'`), `${code} is no longer sent by ${file}: take it off the list`);
    assert.equal(translations.vi[`agent_error_${code}`], undefined, `${code} has a sentence now: move it to TOLD`);
    assert.equal(translations.en[`agent_error_${code}`], undefined, `${code} has an English sentence now: move it to TOLD`);
  }
});

test('every code lib/agent.mjs raises with fault() is told, shown as written, or known never to be a run’s record: a new one has to be put in one of the three', () => {
  const found = faultsOfAgent();
  // fault(reason === 'max_output_tokens' ? 'output_limit' : 'model_response_failed', ...) and the codes set by assignment, which fault('...') does not see
  const others = ['output_limit', 'model_response_failed', 'persistence_failed', 'task_failed'];
  for (const code of others) assert.ok(agentSource.includes(`'${code}'`), code);
  const known = [
    ...Object.keys(TOLD).filter((code) => TOLD[code].includes('lib/agent.mjs')),
    ...Object.keys(SHOWN_AS_WRITTEN).filter((code) => SHOWN_AS_WRITTEN[code].includes('lib/agent.mjs')),
    ...NEVER_A_RUN_RECORD,
  ];
  assert.deepEqual(found.filter((code) => !known.includes(code)), [], 'a code the runner raises that nobody has decided about: tell it (agent_error_<code> in both languages, then TOLD) or list it');
  assert.deepEqual(known.filter((code) => !found.includes(code) && !others.includes(code)), [], 'a code that lib/agent.mjs no longer raises with fault()');
});

test('every code the model adapters raise is told or shown as written on purpose: a new one, or one nobody has looked at, has to be put in one of the two', () => {
  const decided = new Set([...Object.keys(TOLD), ...Object.keys(SHOWN_AS_WRITTEN)]);
  const undecided = [];
  for (const [file, pattern] of Object.entries(ADAPTERS)) {
    const found = [...new Set([...read(file).matchAll(pattern)].map((match) => match[1]))];
    assert.ok(found.length >= 3, `${file}: ${found.length} codes found, so the pattern no longer reads this file`);
    for (const code of found) if (!decided.has(code)) undecided.push(`${code} (${file})`);
  }
  assert.deepEqual(undecided, [], 'a code that ends a worker’s run and that nobody has decided about: tell it (agent_error_<code> in both languages, then TOLD) or list it in SHOWN_AS_WRITTEN');
});

test('the Vietnamese sentence of a code the runner always says in the same words is the runner’s own sentence', () => {
  // Then the Vietnamese screen shows the Hub’s sentence once (the page leaves its own out when the Hub’s begins with it), as it did before the page told codes.
  const same = ['user_cancelled', 'shutdown', 'empty_final', 'progress_stalled', 'provider_changed', 'workspace_changed'];
  for (const code of same) {
    const written = [...agentSource.matchAll(new RegExp(`fault\\(\\s*'${code}',\\s*'([^']*)'`, 'g'))].map((match) => match[1]);
    assert.ok(written.length > 0, `${code}: the runner’s sentence was not found`);
    assert.ok(written.includes(translations.vi[`agent_error_${code}`]), `${code}: the Vietnamese sentence is not one of the runner’s: ${JSON.stringify(written)}`);
  }
});

test('the sentences are for people: no placeholder, no tag, a sentence or two, and the two languages are not the same text', () => {
  for (const code of Object.keys(TOLD)) {
    for (const lang of ['vi', 'en']) {
      const text = translations[lang][`agent_error_${code}`];
      assert.doesNotMatch(text, /[{}<>]/, `${lang}.${code}`);
      assert.ok(text.length >= 20 && text.length <= 240, `${lang}.${code} is ${text.length} characters`);
    }
    assert.notEqual(translations.en[`agent_error_${code}`], translations.vi[`agent_error_${code}`], code);
  }
});
