// Task-owned, provider-agnostic model request and token accounting.
// Counts actual HTTP attempts, including retries and Gemini compatibility repairs.
// No remote telemetry and no estimated prices unless the operator configures them.
const fail = (code, message) => Object.assign(new Error(message), { code, statusCode: 429 });
const INT_LIMIT = 1_000_000_000;

function integerSetting(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(String(raw))) throw new Error(name + ' must be a nonnegative integer');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n > INT_LIMIT) throw new Error(name + ' is out of range');
  return n;
}

function moneySetting(env, name, fallback = null) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(String(raw))) throw new Error(name + ' must be a nonnegative USD value');
  const n = Number(raw);
  if (!Number.isFinite(n) || n > 10_000) throw new Error(name + ' is out of range');
  return n;
}

export function requestBudgetConfig(env = process.env) {
  const limits = {
    maxRequests: integerSetting(env, 'CHATMCP_MAX_MODEL_REQUESTS_PER_TASK', 60),
    maxRetries: integerSetting(env, 'CHATMCP_MAX_MODEL_RETRIES_PER_TASK', 8),
    maxInputTokens: integerSetting(env, 'CHATMCP_MAX_INPUT_TOKENS_PER_TASK', 0),
    maxOutputTokens: integerSetting(env, 'CHATMCP_MAX_OUTPUT_TOKENS_PER_TASK', 0),
    maxCostUSD: moneySetting(env, 'CHATMCP_MAX_TASK_COST_USD', 0),
  };
  const prices = {
    input: moneySetting(env, 'CHATMCP_INPUT_USD_PER_MTOKENS'),
    output: moneySetting(env, 'CHATMCP_OUTPUT_USD_PER_MTOKENS'),
    cached: moneySetting(env, 'CHATMCP_CACHED_USD_PER_MTOKENS'),
  };
  if (limits.maxCostUSD > 0 && (prices.input === null || prices.output === null))
    throw new Error('A USD task limit requires explicit input and output price configuration; never guess provider pricing');
  return Object.freeze({ limits: Object.freeze(limits), prices: Object.freeze(prices) });
}

export function codingRunBudgetConfig(env = process.env) {
  const config = requestBudgetConfig(env);
  return { ...config,limits:{
    ...config.limits,
    maxRequests:integerSetting(env,'CHATMCP_MAX_CODING_RUN_REQUESTS',120),
    maxRetries:integerSetting(env,'CHATMCP_MAX_CODING_RUN_RETRIES',20),
  } };
}

function count(n) { return Number.isSafeInteger(n) && n >= 0 ? n : 0; }

export class RequestBudget {
  constructor({ usage = {}, config = requestBudgetConfig() } = {}) {
    this.usage = usage;
    this.config = config;
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'apiRequests', 'retryRequests', 'requestBytes']) {
      usage[field] = count(usage[field]);
    }
  }

  estimatedCostUSD() {
    const { input, output, cached } = this.config.prices;
    if (input === null || output === null) return null;
    const paidInput = Math.max(0, this.usage.inputTokens - this.usage.cacheReadTokens);
    return (paidInput * input + this.usage.cacheReadTokens * (cached ?? input) +
      this.usage.outputTokens * output) / 1_000_000;
  }

  // Preflight is read-only: multiple worker budgets can be checked before any
  // one of them consumes a request credit. All reservations are synchronous.
  canReserve({retry=false}={}) {
    const { limits } = this.config;
    if (limits.maxRequests && this.usage.apiRequests >= limits.maxRequests)
      throw fail('request_budget_exhausted', 'Task reached its HTTP model-request limit. Review usage and explicitly continue with a higher limit.');
    if (retry && limits.maxRetries && this.usage.retryRequests >= limits.maxRetries)
      throw fail('retry_budget_exhausted', 'Task reached its model retry limit. Investigate the provider or network before continuing.');
    if (limits.maxInputTokens && this.usage.inputTokens >= limits.maxInputTokens)
      throw fail('input_budget_exhausted', 'Task reached its observed input-token limit.');
    if (limits.maxOutputTokens && this.usage.outputTokens >= limits.maxOutputTokens)
      throw fail('output_budget_exhausted', 'Task reached its observed output-token limit.');
    const cost = this.estimatedCostUSD();
    if (limits.maxCostUSD && cost !== null && cost >= limits.maxCostUSD)
      throw fail('cost_budget_exhausted', 'Task reached its estimated model spending limit; no further model requests were issued.');
    return true;
  }

  // Called immediately before each HTTP POST, never after it.
  reserve({ retry = false, requestBytes = 0 } = {}) {
    this.canReserve({retry});
    this.usage.apiRequests += 1;
    if (retry) this.usage.retryRequests += 1;
    this.usage.requestBytes += Number.isSafeInteger(requestBytes) && requestBytes > 0 ? requestBytes : 0;
    return this.snapshot();
  }

  recordUsage(tokens = {}) {
    this.usage.inputTokens += count(tokens.input_tokens);
    this.usage.outputTokens += count(tokens.output_tokens);
    this.usage.cacheReadTokens += Math.min(count(tokens.cache_read_tokens), count(tokens.input_tokens));
    return this.snapshot();
  }

  snapshot() {
    const {limits} = this.config;
    const estimatedCostUSD = this.estimatedCostUSD();
    return {
      apiRequests: this.usage.apiRequests,
      retryRequests: this.usage.retryRequests,
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens,
      estimatedCostUSD,
      estimationOnly: estimatedCostUSD !== null,
      limits,
      remainingRequests: limits.maxRequests ? Math.max(0, limits.maxRequests - this.usage.apiRequests) : null,
    };
  }
}
