// User-supplied model pricing and conservative task cost accounting.
// Price units: USD per one million provider-reported tokens, never per HTTP
// request. Cache read/write are SUBSETS of input; reasoning is part of output.
// No API call or provider billing schedule is inferred by this module.
import { reportedTokenCount } from './request-budget.mjs';

const rateKeys=['input','output','cacheRead','cacheWrite'];
const error=(code,message)=>Object.assign(new Error(message),{code,statusCode:400});
const money=value=>Number(value.toFixed(8));

export function parseModelRates(raw) {
  if(raw===null||raw===undefined)return null;
  if(!raw||typeof raw!=='object'||Array.isArray(raw) ||
    Object.keys(raw).some(key=>!rateKeys.includes(key)))
    throw error('invalid_model_rates','Model rates must be a pricing object with input, output, cacheRead and cacheWrite.');
  const rates={};
  for(const key of rateKeys){
    const value=raw[key];
    if(value===undefined || value===null || value==='')continue;
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>10000)
      throw error('invalid_model_rates','All explicit model rates must be finite USD per 1M tokens in range 0..10000.');
    rates[key]=value;
  }
  if(!Object.keys(rates).length)return null;
  if(!Object.hasOwn(rates,'input') || !Object.hasOwn(rates,'output'))
    throw error('invalid_model_rates','Input and output rates are required to calculate any cost.');
  return Object.freeze(rates);
}

export function priceModelResponse(usage, rawRates) {
  const rates=parseModelRates(rawRates);
  if(!rates)return {status:'unpriced',usd:null,reason:'no_owner_supplied_rates'};
  const input=reportedTokenCount(usage?.input_tokens);
  const output=reportedTokenCount(usage?.output_tokens);
  if(input===null||output===null)return {status:'unknown',usd:null,reason:'provider_usage_missing'};
  const read=reportedTokenCount(usage?.cache_read_tokens);
  const write=reportedTokenCount(usage?.cache_creation_tokens);
  if((read!==null&&read>input)||(write!==null&&write>input) ||
     (read!==null&&write!==null&&read+write>input))
    return {status:'unknown',usd:null,reason:'inconsistent_cache_usage'};
  const cacheReadRate=rates.cacheRead??rates.input;
  const cacheWriteRate=rates.cacheWrite??rates.input;
  if((read===null&&cacheReadRate!==rates.input)||(write===null&&cacheWriteRate!==rates.input))
    return {status:'unknown',usd:null,reason:'cache_breakdown_missing'};
  const readTokens=read??0,writeTokens=write??0;
  const baseInput=input-readTokens-writeTokens;
  const value=(baseInput*rates.input+readTokens*cacheReadRate+
    writeTokens*cacheWriteRate+output*rates.output)/1e6;
  return {status:'priced',usd:money(value),reason:null,
    breakdown:{input:baseInput,cacheRead:readTokens,cacheWrite:writeTokens,output},
    approximate:false};
}

export function createCostLedger(raw=null) {
  const saved=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
  return {
    schema:1,knownSubtotalUsd:Number.isFinite(saved.knownSubtotalUsd) ? saved.knownSubtotalUsd:0,
    pricedResponses:Number.isSafeInteger(saved.pricedResponses)?saved.pricedResponses:0,
    unpricedResponses:Number.isSafeInteger(saved.unpricedResponses)?saved.unpricedResponses:0,
    unknownResponses:Number.isSafeInteger(saved.unknownResponses)?saved.unknownResponses:0,
    lastPriceStatus:typeof saved.lastPriceStatus==='string'?saved.lastPriceStatus:'not_recorded',
    totalUsd:null,complete:false,
  };
}

export function updateCostLedger(ledger,usage,rates) {
  const state=createCostLedger(ledger);
  const priced=priceModelResponse(usage,rates);
  if(priced.status==='priced'){
    state.pricedResponses++;
    state.knownSubtotalUsd=money(state.knownSubtotalUsd+priced.usd);
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
  }),{knownSubtotalUsd:0,pricedResponses:0,unpricedResponses:0,unknownResponses:0});
  const total=aggregate.pricedResponses+aggregate.unpricedResponses+aggregate.unknownResponses;
  const complete=total>0 && aggregate.unpricedResponses===0 && aggregate.unknownResponses===0;
  return Object.freeze({schema:1,...aggregate,complete,
    totalUsd:complete?aggregate.knownSubtotalUsd:null,
    attribution:'provider-reported-successful-responses-only',
    note:'Retries and failed/timeout HTTP sends may incur charges not covered by provider response usage.'});
}
