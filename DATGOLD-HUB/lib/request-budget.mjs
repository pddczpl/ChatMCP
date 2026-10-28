// Task-owned model-usage telemetry. Count genuine HTTP attempts, including
// retries and provider dialect repairs. No ChatMCP-imposed request, token,
// monetary, session-duration or multi-worker quota: the user/provider controls
// consumption. Counts are diagnostics, not billing statements.
export class RequestMeter {
  constructor({used={}}={}) {
    this.requests=Number.isSafeInteger(used.httpRequests)&&used.httpRequests>=0?used.httpRequests:0;
    this.inputTokens=Number.isSafeInteger(used.inputTokens)&&used.inputTokens>=0?used.inputTokens:0;
    this.outputTokens=Number.isSafeInteger(used.outputTokens)&&used.outputTokens>=0?used.outputTokens:0;
  }
  snapshot() {
    return {httpRequests:this.requests,inputTokens:this.inputTokens,outputTokens:this.outputTokens,estimatesOnly:false};
  }
  beforeRequest() {
    this.requests++;
    return this.snapshot();
  }
  recordUsage(input=0,output=0) {
    if(Number.isFinite(input)&&input>=0)this.inputTokens+=Math.floor(input);
    if(Number.isFinite(output)&&output>=0)this.outputTokens+=Math.floor(output);
    return this.snapshot();
  }
}

// Distinguish a measured zero from absent, malformed or unavailable telemetry.
export function reportedTokenCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    const count=Number(value);
    return Number.isSafeInteger(count) ? count : null;
  }
  return null;
}

// Provider cache and reasoning counts are subsets of input/output totals,
// not additional independent tokens. Never add them twice.
export function accumulateReportedUsage(saved = {}, providerUsage = null) {
  const next = {...saved, telemetrySchema:2};
  for(const [source,target,present,missing] of [
    ['input_tokens','inputTokens','inputUsageReported','inputUsageMissing'],
    ['output_tokens','outputTokens','outputUsageReported','outputUsageMissing'],
  ]) {
    const count=reportedTokenCount(providerUsage?.[source]);
    next[present]=(Number.isSafeInteger(next[present])?next[present]:0)+(count===null?0:1);
    next[missing]=(Number.isSafeInteger(next[missing])?next[missing]:0)+(count===null?1:0);
    if(count!==null)next[target]=(Number.isSafeInteger(next[target])?next[target]:0)+count;
  }
  for(const [source,target] of [
    ['cache_read_tokens','cachedInputTokens'],
    ['cache_creation_tokens','cacheWriteTokens'],
    ['reasoning_tokens','reasoningTokens'],
  ]) {
    const count=reportedTokenCount(providerUsage?.[source]);
    if(count!==null)next[target]=(Number.isSafeInteger(next[target])?next[target]:0)+count;
  }
  return next;
}
