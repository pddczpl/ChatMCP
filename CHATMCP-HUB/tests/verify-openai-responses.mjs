// CLAIM: responses-adapter

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {GatewayProvider, buildEndpoint} from '../lib/gateway-provider.mjs';

import {
  asResponsesInput,buildResponsesBody,normalizeResponsesResponse,readResponsesStream,respondOpenAIResponses
} from '../lib/openai-responses-api.mjs';

const history=[
  {role:'user',content:[{type:'input_text',text:'Check A'}]},
  {type:'function_call',name:'read_file',call_id:'f1',arguments:'{"path":"a.txt"}'},
  {type:'function_call_output',call_id:'f1',output:'file contents'},
  {role:'user',content:[{type:'input_text',text:'Continue'}]},
];
const mapped=asResponsesInput(history);
assert.equal(mapped[1].type,'function_call');
assert.equal(mapped[2].type,'function_call_output');
assert.equal(mapped[2].call_id,'f1');
assert.equal(mapped[3].role,'user');
const tool={name:'read_file',description:'Read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']},strict:false};
const body=buildResponsesBody({model:'gpt-test',input:history,instructions:'Do the task',tools:[tool],maxOutputTokens:1000});
assert.equal(body.store,false);
assert.equal(body.truncation,'disabled');
assert.equal(body.stream,false);
assert.equal(body.tools[0].type,'function');
assert.equal(body.parallel_tool_calls,false);
assert.equal(body.input.length,4);
const assistant={id:'resp_1',status:'completed',output:[
  {type:'message',role:'assistant',content:[{type:'output_text',text:'Checking.'}]},
  {type:'function_call',name:'read_file',call_id:'c1',arguments:'{"path":"next.txt"}',status:'completed'}
],usage:{input_tokens:19,output_tokens:7,input_tokens_details:{cached_tokens:10},output_tokens_details:{reasoning_tokens:2}}};
const normalized=normalizeResponsesResponse(assistant);
assert.equal(normalized.status,'completed');
assert.deepEqual(normalized.output.map(x=>x.type),['message','function_call']);
assert.equal(normalized.output[0].phase,'commentary');
assert.equal(normalized.output[1].call_id,'c1');
assert.equal(normalized.usage.cache_read_tokens,10);
assert.equal(normalized.usage.reasoning_tokens,2);
assert.equal(normalizeResponsesResponse({...assistant,usage:null}).usage.input_tokens,null);
const incomplete=normalizeResponsesResponse({...assistant,status:'incomplete',incomplete_details:{reason:'max_output_tokens'}});
assert.equal(incomplete.status,'incomplete');
assert.equal(incomplete.output.length,0,'partial function calls must not execute');
assert.throws(()=>normalizeResponsesResponse({...assistant,output:[{...assistant.output[1],status:'incomplete'}]}),{code:'incomplete_responses_tool'});
assert.throws(()=>asResponsesInput([{type:'function_call_output',call_id:'missing',output:'x'}]),{code:'unbound_responses_tool_result'});
assert.throws(()=>asResponsesInput([
  {type:'function_call_output',call_id:'late',output:'x'},
  {type:'function_call',call_id:'late',name:'read_file',arguments:'{}'},
]),{code:'unbound_responses_tool_result'},'a later call cannot authenticate an earlier result');
assert.throws(()=>asResponsesInput([
  {type:'function_call',call_id:'duplicate',name:'read_file',arguments:'{}'},
  {type:'function_call',call_id:'duplicate',name:'read_file',arguments:'{}'},
]),{code:'duplicate_responses_call'},'duplicate historical call IDs fail closed');
const subsequent=[...history,{...normalized.output[1]},{type:'function_call_output',call_id:'c1',output:'read result'}];
assert.equal(asResponsesInput(subsequent).at(-1).call_id,'c1','multi-turn tool results bind to their call');
const textFinal={status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'All done.'}]}]};
const jsonBody={ok:true,status:200,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(textFinal)};
let attempts=0;
const result=await respondOpenAIResponses({
  model:'gpt-test',endpoint:'https://example.test/v1/responses',
  headers:{Authorization:'Bearer fixture'},fetch:async(url,init)=>{
    attempts++;assert.equal(url,'https://example.test/v1/responses');
    assert.equal(init.redirect,'error');
    assert.equal(JSON.parse(init.body).input[2].type,'function_call_output');
    return jsonBody;
  }
},{input:history,instructions:'Test',tools:[tool],beforeModelRequest:()=>{}});
assert.equal(attempts,1);
assert.equal(result.output[0].content[0].text,'All done.');

const decoder=new TextEncoder();
const frames=[
  'data: '+JSON.stringify({type:'response.output_text.delta',delta:'All '})+'\n\n',
  'data: '+JSON.stringify({type:'response.output_text.delta',delta:'done.'})+'\n\n',
  'data: '+JSON.stringify({type:'response.completed',response:textFinal})+'\n\n',
];
const makeStream=blocks=>new ReadableStream({
  start(c){for(const block of blocks)c.enqueue(decoder.encode(block));c.close();}
});
let streamed='';
const terminal=await readResponsesStream(makeStream(frames),{onToken:x=>{streamed+=x;}});
assert.equal(streamed,'All done.');
assert.equal(terminal.status,'completed');
await assert.rejects(readResponsesStream(makeStream([frames[0]])),{code:'responses_stream_interrupted'});
const sse=await respondOpenAIResponses({
  model:'gpt-test',endpoint:'https://example.test/v1/responses',
  headers:{},stream:true,fetch:async()=>({
    ok:true,headers:{get:()=> 'text/event-stream'},body:makeStream(frames)
  })
},{input:history,instructions:'Test'});
assert.equal(sse.status,'completed');
console.log('PASS OpenAI Responses text, function calls, paired tool results, completion, SSE, missing usage and fail-closed incomplete streams');

// A gateway that answers 400 to stream: true is asked once more without it, and only then; every other failure keeps its one attempt.
// A stream that goes quiet is ended by its idle timeout; both timeouts and the caller's cancel say what happened.
{
  const json=(status,data)=>({ok:status>=200&&status<300,status,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(data)});
  const streamRefusal=json(400,{error:{message:"Unsupported value: 'stream' does not support true with this model. Supported values are: false.",param:'stream',code:'unsupported_value'}});
  // What a fetch does with its signal: an abort errors the body that is still being read. With a generic AbortError, not with the
  // signal's reason (not every fetch passes it on), so what the adapter reports has to come from the adapter.
  const quietStream=init=>{
    let controller;
    const body=new ReadableStream({start(c){controller=c;c.enqueue(decoder.encode(frames[0]));}});
    init.signal.addEventListener('abort',()=>controller.error(new DOMException('This operation was aborted','AbortError')),{once:true});
    return {ok:true,headers:{get:()=> 'text/event-stream'},body};
  };
  const attempt=async(responses,{ctx={},options={}}={})=>{
    const sent=[],events=[],queue=[...responses];
    const outcome=await respondOpenAIResponses({
      model:'gpt-test',endpoint:'https://example.test/v1/responses',headers:{},stream:true,redact:text=>text,
      fetch:async(url,init)=>{
        sent.push(JSON.parse(init.body));events.push('fetch');
        const next=queue.shift();
        return typeof next==='function'?next(init):next;
      },
      onStreamRefused:()=>events.push('remembered'),
      ...ctx,
    },{input:history,instructions:'Test',beforeModelRequest:()=>events.push('before'),
      onStatus:async message=>events.push('status'),onToken:text=>events.push('token:'+text),...options})
      .then(value=>({value}),error=>({error}));
    return {...outcome,sent,events};
  };

  const recovered=await attempt([streamRefusal,json(200,textFinal)]);
  assert.equal(recovered.value?.status,'completed');
  assert.deepEqual(recovered.sent.map(x=>x.stream),[true,false],'the same request, once more, without the stream');
  assert.deepEqual({...recovered.sent[1],stream:true},recovered.sent[0],'nothing else in it changed');
  assert.deepEqual(recovered.events,['before','fetch','status','before','fetch','remembered','token:All done.'],
    'announced, both requests counted, remembered once the repeat is accepted, text at the end');
  for(const [label,data] of [
    ['only the parameter',{error:{message:'Invalid value.',param:'stream'}}],
    ['only the wording',{error:{message:'Streaming is not supported for this deployment.'}}],
    ['organization not verified',{error:{message:'Your organization must be verified to stream this model. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization.',param:'stream',code:'unsupported_value'}}],
  ]){
    const refused=await attempt([json(400,data),json(200,textFinal)]);
    assert.deepEqual(refused.sent.map(x=>x.stream),[true,false],label);
    assert.equal(refused.value?.status,'completed',label);
  }

  for(const [label,response,code] of [
    ['a 400 that does not mention the stream',json(400,{error:{message:'Invalid value: foo.'}}),'gateway_http_error'],
    ['a 400 about the context that mentions the stream',json(400,{error:{message:"This model's maximum context length is 8192 tokens. Reduce the length of the messages (stream).",code:'context_length_exceeded'}}),'gateway_context_length'],
    ['a 400 about the output cap that mentions the stream',json(400,{error:{message:'max_tokens: 16384 > 8192, which is the maximum allowed number of output tokens for this model (stream).'}}),'gateway_http_error'],
    ['a 401',json(401,{error:{message:'Invalid key for stream requests.'}}),'gateway_auth'],
    ['a 404',json(404,{error:{message:'No route for stream.'}}),'gateway_http_error'],
    ['a 429',json(429,{error:{message:'Rate limit for stream requests.'}}),'gateway_rate_limit'],
    ['a 500',json(500,{error:{message:'stream backend failed.'}}),'gateway_http_error'],
  ]){
    const only=await attempt([response]);
    assert.equal(only.sent.length,1,`${label}: no second attempt`);
    assert.equal(only.error?.code,code,label);
    assert.deepEqual(only.events,['before','fetch'],`${label}: nothing announced`);
  }
  const bothFail=await attempt([streamRefusal,json(500,{error:{message:'upstream broke'}})]);
  assert.equal(bothFail.sent.length,2,'a repeat that fails is not repeated again');
  assert.equal(bothFail.error?.upstreamStatus,500,'the error is the one of the repeat');
  assert.equal(bothFail.events.includes('remembered'),false,'a refusal is remembered only when the repeat was accepted');
  const twice=await attempt([streamRefusal,streamRefusal,json(200,textFinal)]);
  assert.equal(twice.sent.length,2,'once, even when the repeat is refused in the same words');
  assert.equal(twice.error?.upstreamStatus,400);

  const known=await attempt([json(200,textFinal)],{ctx:{streamRefused:true}});
  assert.deepEqual(known.sent.map(x=>x.stream),[false],'a refusal the caller already knows is not asked again');
  assert.deepEqual(known.events,['before','fetch','token:All done.'],'and the text still arrives at the end, without another announcement');
  const quiet=await attempt([json(200,textFinal)],{ctx:{stream:false}});
  assert.deepEqual(quiet.events,['before','fetch'],'a call that did not ask for a stream gets no tokens');
  assert.equal((await attempt([streamRefusal],{ctx:{stream:false}})).sent.length,1,'and has nothing to fall back from');
  const cutShort=await attempt([streamRefusal,json(200,{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'partial'}]}]})]);
  assert.equal(cutShort.value?.status,'incomplete');
  assert.equal(cutShort.events.some(x=>x.startsWith('token')),false,'an unfinished answer is not shown as text');

  // Timeouts. The idle clock starts when the headers arrive and restarts with every byte; the other two are the whole call and the caller.
  const idle=await attempt([quietStream],{ctx:{idleTimeoutMs:60,timeoutMs:5000}});
  assert.equal(idle.error?.code,'responses_idle_timeout');
  assert.equal(idle.error.kind,'network');
  assert.equal(idle.sent.length,1,'a stalled stream is not repeated');
  const whole=await attempt([quietStream],{ctx:{idleTimeoutMs:5000,timeoutMs:60}});
  assert.equal(whole.error?.code,'responses_timeout','the timeout of the whole call in the middle of a stream');
  assert.equal(whole.error.kind,'network');
  // No response yet. A real request has a socket that keeps the process alive (the signal's own timer does not); the fake needs a timer.
  const before=await attempt([init=>new Promise((_,reject)=>{
    const hold=setTimeout(()=>{},5000);
    init.signal.addEventListener('abort',()=>{clearTimeout(hold);reject(new DOMException('This operation was aborted','AbortError'));},{once:true});
  })],{ctx:{timeoutMs:60}});
  assert.equal(before.error?.code,'responses_timeout','and before the response');
  assert.equal(before.error.kind,'network');
  const offline=await attempt([()=>{throw new TypeError('fetch failed');}]);
  assert.deepEqual([offline.error?.code,offline.error?.kind],['responses_network','network']);
  const canceller=new AbortController();
  setTimeout(()=>canceller.abort(Object.assign(new Error('cancelled by the person'),{code:'user_cancelled'})),40);
  const cancelled=await attempt([quietStream],{ctx:{idleTimeoutMs:5000,timeoutMs:5000},options:{signal:canceller.signal}});
  assert.equal(cancelled.error?.code,'user_cancelled','the caller\'s own reason is not replaced by a timeout');
  const trickle=()=>{
    const all=[frames[0],': keepalive\n\n',': keepalive\n\n',': keepalive\n\n',frames[1],': keepalive\n\n',': keepalive\n\n',frames[2]];
    let next=0;
    return {ok:true,headers:{get:()=> 'text/event-stream'},body:new ReadableStream({async pull(controller){
      if(next>=all.length){controller.close();return;}
      await new Promise(resolve=>setTimeout(resolve,60));
      controller.enqueue(decoder.encode(all[next++]));
    }})};
  };
  const slow=await attempt([trickle()],{ctx:{idleTimeoutMs:300,timeoutMs:5000}});
  assert.equal(slow.value?.status,'completed','480 ms of stream with a byte every 60 ms, comments included, is not idle for 300 ms');
  console.log('PASS OpenAI Responses: a refused stream: true is repeated once without it (and nothing else is), the refusal is reported to the caller, stalled streams end with coded timeouts');
}

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-responses-gateway-'));
try{
  const requests=[];
  const provider=new GatewayProvider({
    directory:root,manager:{secrets:[]},env:{},platform:'linux',
    fetchImpl:async(url,init)=>{
      requests.push({url,init});
      return {ok:true,status:200,headers:{get:()=> 'application/json'},
        text:async()=>JSON.stringify(textFinal)};
    },
  });
  await provider.load();
  await provider.configure({preset:'custom-responses',apiBaseUrl:'http://127.0.0.1:7333/v1',
    protocol:'openai-responses',model:'gpt-test',authMode:'bearer'});
  assert.equal(provider.state().protocol,'openai-responses');
  assert.equal(buildEndpoint('https://api.openai.com/v1','openai-responses','gpt-test'),
    'https://api.openai.com/v1/responses');
  const done=await provider.respond({input:history,instructions:'Read files',tools:[tool],maxOutputTokens:2000});
  assert.equal(done.status,'completed');
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'http://127.0.0.1:7333/v1/responses');
  const emitted=JSON.parse(requests[0].init.body);
  assert.equal(emitted.model,'gpt-test');
  assert.equal(emitted.store,false);
  assert.equal(emitted.tools[0].name,'read_file');
  assert.equal(emitted.input[2].call_id,'f1');
  assert.equal(provider.state().agentRequestMode,'openai-responses-functions');
}finally{await fs.rm(root,{recursive:true,force:true});}
