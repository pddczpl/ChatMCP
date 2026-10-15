import assert from 'node:assert/strict';
import {RequestBudget,requestLimits} from '../lib/request-budget.mjs';
import {respondStandard} from '../lib/standard-adapter.mjs';

assert.deepEqual(requestLimits({CHATMCP_MAX_HTTP_REQUESTS:'3',CHATMCP_MAX_INPUT_TOKENS:'10',CHATMCP_MAX_OUTPUT_TOKENS:'8'}),
  {maxRequests:3,maxInputTokens:10,maxOutputTokens:8});
assert.equal(requestLimits({CHATMCP_MAX_HTTP_REQUESTS:'bogus'}).maxRequests,80);
assert.equal(requestLimits({CHATMCP_MAX_INPUT_TOKENS:'2500000'}).maxInputTokens,2500000);
assert.equal(requestLimits({CHATMCP_MAX_OUTPUT_TOKENS:'100000000'}).maxOutputTokens,10000000);
const gate=new RequestBudget({limits:requestLimits({CHATMCP_MAX_HTTP_REQUESTS:'2'})});
assert.equal(gate.beforeRequest().httpRequests,1);
assert.equal(gate.beforeRequest().httpRequests,2);
assert.throws(()=>gate.beforeRequest(),{code:'request_budget_exceeded'});
assert.equal(gate.requests,2);
const aggregate=new RequestBudget({limits:{maxRequests:1,maxInputTokens:0,maxOutputTokens:0}});
const individual=new RequestBudget({limits:{maxRequests:2,maxInputTokens:0,maxOutputTokens:0}});
const send=()=>{
  individual.assertCanRequest();
  aggregate.beforeRequest();
  individual.beforeRequest();
};
send();
assert.throws(send,{code:'request_budget_exceeded'});
assert.equal(individual.requests,1,'worker count must not advance when shared budget blocks the send');
const restored=new RequestBudget({limits:{maxRequests:2,maxInputTokens:0,maxOutputTokens:0},used:{httpRequests:2}});
assert.throws(()=>restored.beforeRequest(),{code:'request_budget_exceeded'});
const tokenGate=new RequestBudget({limits:{maxRequests:0,maxInputTokens:10,maxOutputTokens:5}});
tokenGate.recordUsage(10,1);
assert.throws(()=>tokenGate.beforeRequest(),{code:'input_budget_exceeded'});
assert.equal(tokenGate.requests,0);

// Verify the callback is invoked for every genuine HTTP request including retries.
// No mutation or tool call is replayed by the transport.
let calls=0,checks=0;
const ctx={
  protocol:'openai-chat',model:'mock',endpoint:'https://example.test/api',
  headers:{},contextWindowTokens:null,redact:x=>x,
  sleep:async()=>{},fetch:async()=>{calls++;return {
    status:calls===1?503:200,ok:calls!==1,headers:{get(){return null}},
    text:async()=>JSON.stringify(calls===1?{error:{message:'unavailable'}}:
      {id:'test',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'done'}}],usage:{prompt_tokens:3,completion_tokens:1}})
  };},
  limits:{maxHttpRetries:2,maxNetworkRetries:0,maxWaitMs:1}
};
const result=await respondStandard(ctx,{
  input:[{role:'user',content:[{type:'input_text',text:'hello'}]}],
  instructions:'Do task',tools:[],beforeModelRequest:()=>{checks++;},
});
assert.equal(result.status,'completed');
assert.equal(checks,2);
assert.equal(calls,2);
console.log('PASS request-budget: counts actual transport sends, preserves tokens and rejects before network on exhaustion');
