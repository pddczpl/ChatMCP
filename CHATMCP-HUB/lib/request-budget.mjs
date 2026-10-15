// Task-owned HTTP request budget. Count ATTEMPTS at the actual provider fetch
// boundary (not AgentRunner steps) so retries, 413 dialect fallbacks and repairs
// cannot hide quota consumption. A rejection occurs BEFORE network I/O.
const parse = (value, fallback, max) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  if (!/^(?:0|[1-9][0-9]{0,8})$/.test(String(value).trim())) return fallback;
  return Math.min(max, Number(value));
};
export function requestLimits(env = process.env) {
  return Object.freeze({
    maxRequests: parse(env.CHATMCP_MAX_HTTP_REQUESTS, 80, 10000),
    maxInputTokens: parse(env.CHATMCP_MAX_INPUT_TOKENS, 0, 10000000),
    maxOutputTokens: parse(env.CHATMCP_MAX_OUTPUT_TOKENS, 0, 10000000),
  });
}
const fault = (key, detail) => Object.assign(new Error(detail), {code:key, statusCode:429});
export class RequestBudget {
  constructor({limits=requestLimits(),used={}}={}) {
    this.limits=limits;
    this.requests=Number.isSafeInteger(used.httpRequests)&&used.httpRequests>=0?used.httpRequests:0;
    this.inputTokens=Number.isSafeInteger(used.inputTokens)&&used.inputTokens>=0?used.inputTokens:0;
    this.outputTokens=Number.isSafeInteger(used.outputTokens)&&used.outputTokens>=0?used.outputTokens:0;
  }
  snapshot() {
    return {httpRequests:this.requests,inputTokens:this.inputTokens,outputTokens:this.outputTokens,limits:this.limits};
  }
  assertCanRequest() {
    if(this.limits.maxRequests && this.requests>=this.limits.maxRequests)
      throw fault('request_budget_exceeded','HTTP model request budget exhausted. No request was sent; resume with a larger explicit budget if appropriate.');
    if(this.limits.maxInputTokens && this.inputTokens>=this.limits.maxInputTokens)
      throw fault('input_budget_exceeded','Input token budget reached; no additional model request sent.');
    if(this.limits.maxOutputTokens && this.outputTokens>=this.limits.maxOutputTokens)
      throw fault('output_budget_exceeded','Output token budget reached; no additional model request sent.');
    return true;
  }
  beforeRequest() {
    this.assertCanRequest();
    this.requests++;
    return this.snapshot();
  }
  recordUsage(input=0,output=0) {
    for(const [name,value] of [['input',input],['output',output]])
      if(!Number.isFinite(value)||value<0)throw new TypeError('Invalid '+name+' model usage');
    this.inputTokens+=Math.floor(input);
    this.outputTokens+=Math.floor(output);
    return this.snapshot();
  }
}
