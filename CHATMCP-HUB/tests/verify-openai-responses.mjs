import assert from 'node:assert/strict';
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
