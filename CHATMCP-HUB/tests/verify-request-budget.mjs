import assert from 'node:assert/strict';
import {RequestMeter} from '../lib/request-budget.mjs';
import {respondStandard} from '../lib/standard-adapter.mjs';

const task=new RequestMeter();
for(let i=0;i<20000;i++)task.beforeRequest();
assert.equal(task.requests,20000,'no app-imposed request cap');
task.recordUsage(20000000,3000000);
assert.equal(task.snapshot().inputTokens,20000000);
assert.equal(task.snapshot().outputTokens,3000000);
assert.equal(new RequestMeter({used:task.snapshot()}).requests,20000,'resume telemetry retained');
const workers=new RequestMeter();
const first=new RequestMeter(),second=new RequestMeter();
for(let i=0;i<200;i++){workers.beforeRequest();(i%2?first:second).beforeRequest();}
assert.equal(workers.requests,200);
assert.equal(first.requests+second.requests,workers.requests);

// The callback counts each real model HTTP send (including retry), not tools.
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
console.log('PASS request-telemetry: no token/request caps, 20k sends, shared worker accounting, actual retry counting');
