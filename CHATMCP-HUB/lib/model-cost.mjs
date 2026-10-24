// Model pricing and conservative task cost accounting.
// Price units: USD per one million provider-reported tokens, never per HTTP
// request. Cache read/write are SUBSETS of input; reasoning is part of output.
// No API call or provider billing schedule is inferred by this module. The rates are the owner's; when the owner supplied none, they
// are the model catalog's (lib/model-catalog.mjs), a dated snapshot of a public price list, and then every price is an ESTIMATE that
// says where it comes from (`approximate: true`, `ratesSource: 'catalog@2026-10-19'`): never a total that looks like a bill.
import { reportedTokenCount } from './request-budget.mjs';

const rateKeys=['input','output','cacheRead','cacheWrite'];
const error=(code,message)=>Object.assign(new Error(message),{code,statusCode:400});
const money=value=>Number(value.toFixed(8));
const RATE_MAX=10000;
const sane=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=RATE_MAX;

export function parseModelRates(raw) {
  if(raw===null||raw===undefined)return null;
  if(!raw||typeof raw!=='object'||Array.isArray(raw) ||
    Object.keys(raw).some(key=>!rateKeys.includes(key)))
    throw error('invalid_model_rates','Model rates must be a pricing object with input, output, cacheRead and cacheWrite.');
  const rates={};
  for(const key of rateKeys){
    const value=raw[key];
    if(value===undefined || value===null || value==='')continue;
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>RATE_MAX)
      throw error('invalid_model_rates','All explicit model rates must be finite USD per 1M tokens in range 0..10000.');
    rates[key]=value;
  }
  if(!Object.keys(rates).length)return null;
  if(!Object.hasOwn(rates,'input') || !Object.hasOwn(rates,'output'))
    throw error('invalid_model_rates','Input and output rates are required to calculate any cost.');
  return Object.freeze(rates);
}

/**
 * The catalog's rates for a response whose prompt had `promptTokens` tokens, or null when the catalog gives none to price with. A prompt of MORE than the size of a tier is priced at
 * the tier's rates for the whole request (the vendors' rule), the highest tier it is over; a rate the catalog does not list stays missing here (the caller prices it as input).
 * @param {{source?: string, rates?: object|null, tiers?: object[]}|null|undefined} catalog
 */
function catalogRates(catalog,promptTokens) {
  const base=catalog?.rates;
  if(!base||typeof base!=='object'||!sane(base.input)||!sane(base.output))return null;
  let chosen=base,tier=null;
  const tiers=Array.isArray(catalog.tiers)?catalog.tiers:[];
  tiers.forEach((entry,index)=>{
    const rates=entry?.rates;
    if(!Number.isFinite(entry?.aboveTokens)||promptTokens<=entry.aboveTokens||!rates||!sane(rates.input)||!sane(rates.output))return;
    if(tier===null||entry.aboveTokens>=tiers[tier].aboveTokens){chosen=rates;tier=index;}
  });
  const optional=value=>sane(value)?value:undefined;
  const rates={input:chosen.input,output:chosen.output};
  if(optional(chosen.cacheRead)!==undefined)rates.cacheRead=chosen.cacheRead;
  if(optional(chosen.cacheWrite)!==undefined)rates.cacheWrite=chosen.cacheWrite;
  return {rates,tier,source:typeof catalog.source==='string'&&catalog.source?catalog.source:'catalog'};
}

/**
 * Price one provider response.
 * @param {object} usage provider-reported tokens (input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
 * @param {object|null} rawRates the owner's rates (a task's model profile), if any
 * @param {{catalog?: {source: string, rates: object|null, tiers?: object[]}|null}} [options] what the model catalog knows about the model, used only when the owner supplied no rates
 */
export function priceModelResponse(usage, rawRates, {catalog=null}={}) {
  const owner=parseModelRates(rawRates);
  if(!owner&&!catalogRates(catalog,0))return {status:'unpriced',usd:null,reason:'no_owner_supplied_rates'};
  const input=reportedTokenCount(usage?.input_tokens);
  const output=reportedTokenCount(usage?.output_tokens);
  if(input===null||output===null)return {status:'unknown',usd:null,reason:'provider_usage_missing'};
  const read=reportedTokenCount(usage?.cache_read_tokens);
  const write=reportedTokenCount(usage?.cache_creation_tokens);
  if((read!==null&&read>input)||(write!==null&&write>input) ||
     (read!==null&&write!==null&&read+write>input))
    return {status:'unknown',usd:null,reason:'inconsistent_cache_usage'};
  const estimate=owner?null:catalogRates(catalog,input);
  const rates=owner??estimate.rates;
  const cacheReadRate=rates.cacheRead??rates.input;
  const cacheWriteRate=rates.cacheWrite??rates.input;
  // The owner's cache rates cannot be applied without the split of the prompt. An estimate takes the prompt as not cached at all, all of it at the input rate: for a cached prompt that is more than it costs, unless the cache write is dearer than the input (then it is less; the adapters that write a cache report that part, so this is only the estimate of an answer that does not).
  if(owner&&((read===null&&cacheReadRate!==rates.input)||(write===null&&cacheWriteRate!==rates.input)))
    return {status:'unknown',usd:null,reason:'cache_breakdown_missing'};
  const readTokens=read??0,writeTokens=write??0;
  const baseInput=input-readTokens-writeTokens;
  const value=(baseInput*rates.input+readTokens*cacheReadRate+
    writeTokens*cacheWriteRate+output*rates.output)/1e6;
  return {status:'priced',usd:money(value),reason:null,
    breakdown:{input:baseInput,cacheRead:readTokens,cacheWrite:writeTokens,output},
    approximate:!owner,ratesSource:owner?'owner':estimate.source,tier:estimate?.tier??null};
}

export function createCostLedger(raw=null) {
  const saved=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  const estimatedResponses=count(saved.estimatedResponses);
  return {
    schema:1,knownSubtotalUsd:Number.isFinite(saved.knownSubtotalUsd) ? saved.knownSubtotalUsd:0,
    pricedResponses:Number.isSafeInteger(saved.pricedResponses)?saved.pricedResponses:0,
    unpricedResponses:Number.isSafeInteger(saved.unpricedResponses)?saved.unpricedResponses:0,
    unknownResponses:Number.isSafeInteger(saved.unknownResponses)?saved.unknownResponses:0,
    // Responses priced from the catalog instead of the owner's rates (a subset of pricedResponses), and the snapshot the last of them was priced from.
    estimatedResponses,estimateSource:typeof saved.estimateSource==='string'&&saved.estimateSource?saved.estimateSource:null,approximate:estimatedResponses>0,
    lastPriceStatus:typeof saved.lastPriceStatus==='string'?saved.lastPriceStatus:'not_recorded',
    totalUsd:null,complete:false,
  };
}

export function updateCostLedger(ledger,usage,rates,options) {
  const state=createCostLedger(ledger);
  const priced=priceModelResponse(usage,rates,options);
  if(priced.status==='priced'){
    state.pricedResponses++;
    state.knownSubtotalUsd=money(state.knownSubtotalUsd+priced.usd);
    if(priced.approximate){state.estimatedResponses++;state.estimateSource=priced.ratesSource;state.approximate=true;}
  }else if(priced.status==='unpriced')state.unpricedResponses++;
  else state.unknownResponses++;
  state.lastPriceStatus=priced.status;
  state.complete=state.unpricedResponses===0&&state.unknownResponses===0 &&
    state.pricedResponses>0;
  state.totalUsd=state.complete?state.knownSubtotalUsd:null;
  return Object.freeze(state);
}

export function summarizeCostLedgers(ledgers=[]) {
  const all=ledgers.map(createCostLedger);
  const aggregate=all.reduce((acc,item)=>({
    knownSubtotalUsd:money(acc.knownSubtotalUsd+item.knownSubtotalUsd),
    pricedResponses:acc.pricedResponses+item.pricedResponses,
    unpricedResponses:acc.unpricedResponses+item.unpricedResponses,
    unknownResponses:acc.unknownResponses+item.unknownResponses,
    estimatedResponses:acc.estimatedResponses+item.estimatedResponses,
  }),{knownSubtotalUsd:0,pricedResponses:0,unpricedResponses:0,unknownResponses:0,estimatedResponses:0});
  const total=aggregate.pricedResponses+aggregate.unpricedResponses+aggregate.unknownResponses;
  const complete=total>0 && aggregate.unpricedResponses===0 && aggregate.unknownResponses===0;
  return Object.freeze({schema:1,...aggregate,approximate:aggregate.estimatedResponses>0,complete,
    totalUsd:complete?aggregate.knownSubtotalUsd:null,
    attribution:'provider-reported-successful-responses-only',
    note:'Retries and failed/timeout HTTP sends may incur charges not covered by provider response usage.'});
}
