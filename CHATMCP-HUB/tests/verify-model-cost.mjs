// CLAIM: usage-and-cost

import assert from 'node:assert/strict';
import {parseModelRates,priceModelResponse,createCostLedger,updateCostLedger,summarizeCostLedgers} from '../lib/model-cost.mjs';
const rates={input:2,output:8,cacheRead:0.5,cacheWrite:2.5};
assert.deepEqual(parseModelRates(null),null);
assert.deepEqual(parseModelRates({}),null);
for(const invalid of [
 {input:2},{output:2},{input:1,output:-1},{input:Infinity,output:2},
 {input:'2',output:3},{input:1,output:3,unexpected:1},
])assert.throws(()=>parseModelRates(invalid),{code:'invalid_model_rates'});
assert.equal(priceModelResponse(null,rates).status,'unknown');
assert.equal(priceModelResponse({input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_creation_tokens:0},rates).usd,0);
const usage={input_tokens:1000,output_tokens:200,cache_read_tokens:250,cache_creation_tokens:100,reasoning_tokens:90};
const priced=priceModelResponse(usage,rates);
assert.equal(priced.status,'priced');
assert.deepEqual(priced.breakdown,{input:650,cacheRead:250,cacheWrite:100,output:200});
assert.equal(priced.usd,0.003275);
assert.equal(priceModelResponse({input_tokens:500,output_tokens:10},rates).reason,'cache_breakdown_missing');
assert.equal(priceModelResponse({input_tokens:10,output_tokens:3,cache_read_tokens:11,cache_creation_tokens:0},rates).reason,'inconsistent_cache_usage');
assert.equal(priceModelResponse(usage,null).status,'unpriced');
assert.equal(priceModelResponse({input_tokens:1000,output_tokens:200},{input:2,output:8}).usd,0.0036);
let ledger=createCostLedger();
ledger=updateCostLedger(ledger,usage,rates);
assert.equal(ledger.complete,true);
assert.equal(ledger.totalUsd,0.003275);
ledger=updateCostLedger(ledger,{input_tokens:null,output_tokens:null},rates);
assert.equal(ledger.complete,false);
assert.equal(ledger.totalUsd,null,'no invented total for missing provider token usage');
assert.equal(ledger.knownSubtotalUsd,0.003275);
const resumed=updateCostLedger(JSON.parse(JSON.stringify(ledger)),usage,rates);
assert.equal(resumed.pricedResponses,2);
assert.equal(resumed.unknownResponses,1);
const agg=summarizeCostLedgers([resumed,updateCostLedger(null,usage,null)]);
assert.equal(agg.totalUsd,null);
assert.equal(agg.pricedResponses,2);
assert.equal(agg.unpricedResponses,1);
assert.match(agg.note,/Retries/);
assert.equal(summarizeCostLedgers([createCostLedger()]).totalUsd,null);
console.log('PASS owner-supplied provider rates, cached/reasoning subsets, unknown usage and worker aggregation');
