// The Hub session of the opt-in live runner (tests/evaluate-live.mjs, docs/EVALUATION.md).
//
// It is tests/e2e/hub-process.mjs (a real Hub as a child process, its own port and state folder, a scrubbed environment) plus the one thing a live run
// needs that a scripted one does not: the key of the provider. Exactly one variable is forwarded, the allow-listed key variable of the chosen provider;
// everything else that looks like a credential stays stripped, as cleanEnvironment() does for every test Hub. The key is never written anywhere by this
// module: the Hub reads it from its own environment (the profile names the variable, `envKeyName`), and the global connection gets it in the body of
// one loopback request, without `remember`, so it is not saved either.
import { answerApprovals, cleanEnvironment, setMode, settledTask, startHub, startTask, waitFor } from '../../e2e/hub-process.mjs';

export { answerApprovals, setMode, settledTask, startTask, waitFor };

/** The only variables a live run may forward to its Hub: the key variables of the hosted providers of tests/live/providers.json. */
export const ALLOWED_KEY_ENVS = Object.freeze(new Set(['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']));

function checkKeyEnv(keyEnv) {
  if (keyEnv === null || keyEnv === undefined) return null;
  if (!ALLOWED_KEY_ENVS.has(keyEnv)) throw new Error(`the key variable ${JSON.stringify(keyEnv)} is not on the allow-list of the live runner (${[...ALLOWED_KEY_ENVS].join(', ')})`);
  return keyEnv;
}

/** What is forwarded on top of cleanEnvironment(): `{ [keyEnv]: value }`, or nothing for a provider without a key. */
export function forwardedKey({ keyEnv, env = process.env }) {
  const name = checkKeyEnv(keyEnv);
  if (name === null) return {};
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (!value) throw new Error(`${name} is not set (or is empty)`);
  return { [name]: value };
}

/**
 * The environment of the Hub of a live run: cleanEnvironment(home) (no credential, no proxy, no GIT_*, HOME in the scratch folder) plus exactly the
 * allow-listed key variable of the provider. startHub() builds its environment the same way (cleanEnvironment with the forwarded variable as extra).
 */
export function liveEnvironment(home, { keyEnv, env = process.env } = {}) {
  return cleanEnvironment(home, forwardedKey({ keyEnv, env }));
}

/** Starts the Hub of a live run with the provider's key variable, and only that one, in its environment. */
export function startLiveHub({ scratch, project, keyEnv, env = process.env, timeoutMs }) {
  return startHub({ scratch, project, env: forwardedKey({ keyEnv, env }), logName: 'hub.log', ...(timeoutMs ? { timeoutMs } : {}) });
}

/** The global connection, so that the Hub's own "Test API" check (tool calling included) runs against the chosen provider. */
export async function configureConnection(hub, entry, key) {
  await hub.post('/api/ai/config', {
    preset: entry.preset, apiBaseUrl: entry.apiBaseUrl, protocol: entry.protocol, model: entry.model,
    ...(entry.contextWindow ? { contextWindowTokens: entry.contextWindow } : {}),
    ...(key ? { apiKey: key } : {}),
  });
  return hub.post('/api/ai/test', {});
}

/** The profile every task of the run uses: it carries the rates, without which the cost ledger has nothing to price with. */
export async function upsertProfile(hub, id, entry, rates) {
  const { profile } = await hub.post('/api/ai/profiles/upsert', {
    id, name: `live ${entry.model}`, provider: entry.local ? 'ollama' : entry.protocol, protocol: entry.protocol, model: entry.model,
    apiBaseUrl: entry.apiBaseUrl, ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
    ratesUsdPerMillion: rates, envKeyName: entry.keyEnv ?? '', isDefault: true,
  });
  return profile;
}

/** Full Access, because the tasks run the model's commands (tests and builds) without a person to approve them: why the runner demands a sandbox. */
export const fullAccess = (hub) => hub.post('/api/studio/permissions/config', { mode: 'full-access', confirmation: 'FULL ACCESS' });

/** Names (never values) of the provider key variables the Hub itself sees in its environment. */
export async function providerKeyVariables(hub) {
  const presets = (await hub.get('/api/ai/presets')).json;
  return [...new Set((presets?.envKeys ?? []).map((item) => item.env))].sort();
}
