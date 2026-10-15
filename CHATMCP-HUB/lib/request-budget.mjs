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
