// Honest coding-parity benchmark aggregation. This consumes results graded
// outside the model/agent and performs NO tool execution, model calls or
// hidden-test mutation. An external grading *label* is not an attestation.
const bad=(message)=>Object.assign(new Error(message),{code:'invalid_parity_benchmark'});
const finite=(n)=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const grade=(v)=>['pass','fail','unknown'].includes(v)?v:'unknown';
const safeRatio=(n,d)=>d>0?Number((n/d).toFixed(4)):null;
const mean=(n,d)=>d>0?Number((n/d).toFixed(2)):null;
function summarizeOne(items,which) {
  const counts={passed:0,failed:0,unknown:0}, totals={httpRequests:0,inputTokens:0,outputTokens:0,durationMs:0};
  for(const item of items) {
    const result=item[which],verdict=grade(result.grade);
    counts[verdict==='pass'?'passed':verdict==='fail'?'failed':'unknown']++;
    for(const k of Object.keys(totals)) {
      if(!finite(result[k]))throw bad("Invalid "+which+"."+k+" for "+item.id);
      totals[k]+=result[k];
    }
  }
  return {counts,totals,passRate:safeRatio(counts.passed,items.length),
    tokensPerSuccess:mean(totals.inputTokens+totals.outputTokens,counts.passed),
    httpRequestsPerSuccess:mean(totals.httpRequests,counts.passed),
    durationMinutesPerSuccess:mean(totals.durationMs/60000,counts.passed)};
}
export function summarizeParityBenchmark(input) {
  if(input?.schema!==1||!Array.isArray(input.cases)||input.cases.length<1||input.cases.length>1000)
    throw bad('Expected schema 1 with 1-1000 cases.');
  const seen=new Set();
  for(const row of input.cases) {
    if(typeof row?.id!=='string'||!(/^[A-Za-z0-9_.-]{1,100}$/).test(row.id)||seen.has(row.id))
      throw bad('Missing, unsafe or duplicate benchmark case ID.');
    seen.add(row.id);
    for(const who of ['baseline','candidate']){
      if(!row[who]||!['pass','fail','unknown'].includes(row[who].grade))
        throw bad('Missing explicit pass/fail/unknown grade for '+who+' in '+row.id);
    }
  }
  const baseline=summarizeOne(input.cases,'baseline');
  const candidate=summarizeOne(input.cases,'candidate');
  return {
    schema:1,total:input.cases.length,
    baseline,candidate,
    relativeSuccessRate:safeRatio(candidate.passRate,baseline.passRate),
    relativeTokensPerSuccessfulTask:safeRatio(candidate.tokensPerSuccess,baseline.tokensPerSuccess),
    relativeRequestsPerSuccessfulTask:safeRatio(candidate.httpRequestsPerSuccess,baseline.httpRequestsPerSuccess),
    unknownVerdicts:baseline.counts.unknown+candidate.counts.unknown,
    comparisonAdequacy:input.cases.length>=100?'sample-count-only':'insufficient-sample-size',
    independentValidation:false,
    note:'Input grades are supplied assertions, NOT cryptographic independent test receipts. Compare only identical task/model/hardware/seed cohorts. This report does not prove parity with any commercial coding agent.',
  };
}
