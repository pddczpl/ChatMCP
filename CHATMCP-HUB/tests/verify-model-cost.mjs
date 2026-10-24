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

// ---- Rates from the model catalog: only when the owner supplied none, always an estimate, and said so.
const catalog={source:'catalog@2026-10-19',rates:{input:2,output:10,cacheRead:0.1,cacheWrite:2.5},tiers:[]};
const estimate=priceModelResponse({input_tokens:1000,output_tokens:500},null,{catalog});
assert.deepEqual([estimate.status,estimate.usd,estimate.approximate,estimate.ratesSource,estimate.tier],['priced',0.007,true,'catalog@2026-10-19',null],'1,000 in and 500 out on claude-sonnet-5-5 is USD 0.007, as an estimate');
assert.equal(priceModelResponse({input_tokens:1000,output_tokens:200,cache_read_tokens:250,cache_creation_tokens:100},undefined,{catalog}).usd,0.003575,'cache read and write at the catalog\'s cache rates');
const owner=priceModelResponse(usage,rates,{catalog});
assert.deepEqual([owner.usd,owner.approximate,owner.ratesSource],[0.003275,false,'owner'],'the owner\'s rates win, and are not an estimate');
assert.equal(priced.ratesSource,'owner','a price without a catalog says its rates are the owner\'s');
// no cache split reported: the owner\'s cache rates cannot be applied (unknown), the catalog\'s estimate takes every input token at the input rate (an upper bound)
assert.equal(priceModelResponse({input_tokens:1000,output_tokens:10},{input:2,output:8,cacheRead:0.5},{catalog}).reason,'cache_breakdown_missing');
const upper=priceModelResponse({input_tokens:1000,output_tokens:10},null,{catalog});
assert.deepEqual([upper.status,upper.usd,upper.approximate],['priced',0.0021,true],'without a cache split the estimate cannot be lower than the truth');
assert.equal(priceModelResponse({input_tokens:10,output_tokens:3,cache_read_tokens:11,cache_creation_tokens:0},null,{catalog}).reason,'inconsistent_cache_usage','an impossible usage is not priced, estimate or not');
assert.equal(priceModelResponse({input_tokens:null,output_tokens:null},null,{catalog}).status,'unknown');
for(const none of [undefined,null,{},{source:'catalog@x',rates:null,tiers:[]},{source:'catalog@x',rates:{input:2,output:null},tiers:[]},{source:'catalog@x',rates:{input:null,output:2},tiers:[]},
  {source:'catalog@x',rates:{input:20000,output:2},tiers:[]},{source:'catalog@x',rates:{input:2,output:-1},tiers:[]}])
  assert.deepEqual([priceModelResponse(usage,null,{catalog:none}).status,priceModelResponse(usage,null,{catalog:none}).reason],['unpriced','no_owner_supplied_rates'],'nothing to price with: '+JSON.stringify(none));
// A prompt of MORE than the size of a tier is priced at the tier's rates for the whole request; one of exactly that size is not.
const tiered={source:'catalog@2026-10-19',rates:{input:2.5,output:15,cacheRead:0.25,cacheWrite:null},tiers:[{aboveTokens:272000,rates:{input:5,output:22.5,cacheRead:0.5,cacheWrite:null}}]};
const at=(input,output=1000,extra={})=>priceModelResponse({input_tokens:input,output_tokens:output,...extra},null,{catalog:tiered});
assert.deepEqual([at(272000).usd,at(272000).tier],[0.695,null],'exactly the size: the base price');
assert.deepEqual([at(272001).usd,at(272001).tier],[1.382505,0],'one token over: the whole request at the tier\'s rates');
assert.equal(at(300000).usd,1.5225,'300,000 in and 1,000 out on gpt-5.4');
assert.equal(at(300000,1000,{cache_read_tokens:100000,cache_creation_tokens:0}).usd,1.0725,'the tier\'s cache rate applies to cached tokens');
assert.equal(at(300000,0,{cache_read_tokens:0,cache_creation_tokens:50000}).usd,1.5,'a cache write rate the catalog does not list is the input rate, never lower');
const absurdTier={...tiered,tiers:[{aboveTokens:10,rates:{input:1e9,output:1,cacheRead:null,cacheWrite:null}}]};
assert.deepEqual([priceModelResponse({input_tokens:1000,output_tokens:0},null,{catalog:absurdTier}).usd,priceModelResponse({input_tokens:1000,output_tokens:0},null,{catalog:absurdTier}).tier],[0.0025,null],'a tier with an absurd rate is left out, the base price answers');
const twoTiers={source:'catalog@x',rates:{input:1,output:2,cacheRead:null,cacheWrite:null},tiers:[{aboveTokens:100000,rates:{input:2,output:3,cacheRead:null,cacheWrite:null}},{aboveTokens:500000,rates:{input:4,output:6,cacheRead:null,cacheWrite:null}}]};
assert.deepEqual([100000,100001,500000,500001].map(input=>priceModelResponse({input_tokens:input,output_tokens:0},null,{catalog:twoTiers}).tier),[null,0,0,1],'the highest tier the prompt is over');
assert.equal(priceModelResponse({input_tokens:200000,output_tokens:0,cache_read_tokens:100000,cache_creation_tokens:0},null,{catalog:twoTiers}).usd,0.4,'a rate the catalog does not list for cached tokens is the input rate, never lower');
// The ledger counts the estimates and says where they come from; a total made of estimates is still an estimate.
let estimated=updateCostLedger(createCostLedger(),{input_tokens:1000,output_tokens:500},null,{catalog});
assert.deepEqual([estimated.complete,estimated.totalUsd,estimated.pricedResponses,estimated.estimatedResponses,estimated.estimateSource,estimated.approximate],[true,0.007,1,1,'catalog@2026-10-19',true]);
estimated=updateCostLedger(estimated,usage,rates,{catalog});
assert.deepEqual([estimated.pricedResponses,estimated.estimatedResponses,estimated.approximate,estimated.totalUsd],[2,1,true,0.010275],'an owner-priced response next to an estimate: the total is still an estimate');
assert.equal(updateCostLedger(createCostLedger(),usage,rates,{catalog}).approximate,false,'only the owner\'s rates: exact');
const resumedEstimate=updateCostLedger(JSON.parse(JSON.stringify(estimated)),{input_tokens:1000,output_tokens:500},null,{catalog:{...catalog,source:'catalog@2026-11-02'}});
assert.deepEqual([resumedEstimate.estimatedResponses,resumedEstimate.estimateSource,resumedEstimate.approximate],[2,'catalog@2026-11-02',true],'a saved ledger keeps its estimates and names the snapshot of the latest');
assert.deepEqual([createCostLedger().estimatedResponses,createCostLedger().estimateSource,createCostLedger().approximate,createCostLedger().schema],[0,null,false,1]);
const old=createCostLedger({schema:1,knownSubtotalUsd:0.5,pricedResponses:3,unpricedResponses:0,unknownResponses:0,lastPriceStatus:'priced'});
assert.deepEqual([old.estimatedResponses,old.approximate,old.knownSubtotalUsd],[0,false,0.5],'a ledger saved before the catalog existed is read as it was');
const mixed=summarizeCostLedgers([estimated,updateCostLedger(createCostLedger(),usage,rates)]);
assert.deepEqual([mixed.estimatedResponses,mixed.approximate,mixed.complete],[1,true,true]);
assert.deepEqual([summarizeCostLedgers([updateCostLedger(createCostLedger(),usage,rates)]).approximate,summarizeCostLedgers([]).estimatedResponses],[false,0]);
console.log('PASS owner-supplied provider rates, catalog estimates with tiers (marked as estimates), cached/reasoning subsets, unknown usage and worker aggregation');
