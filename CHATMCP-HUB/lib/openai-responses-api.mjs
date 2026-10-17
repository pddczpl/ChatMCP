// OpenAI Responses protocol adapter. No hosted state is required: with
// store:false, every step supplies the canonical user/assistant/tool history.
// Only completed provider responses may authorize tool calls.
import { randomUUID } from 'node:crypto';
import { reportedTokenCount } from './request-budget.mjs';
import { pairToolCalls } from './model-history.mjs';
import { classifyHttpError, readBodyText } from './model-http.mjs';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (code,message) => Object.assign(new Error(message),{code,statusCode:502});
const messageText = parts => (Array.isArray(parts) ? parts.filter(p=>p?.type==='output_text'&&typeof p.text==='string').map(p=>p.text).join('\n') : '');

export function asResponsesInput(history=[]) {
  const result=[], called=new Set();
  for(const item of pairToolCalls(history)){
    if(item?.role==='user'){
      if(!Array.isArray(item.content)) {
        result.push({role:'user',content:String(item.content??'')});
        continue;
      }
      const parts=item.content.map(part=>{
        if(part?.type==='input_text')return {type:'input_text',text:String(part.text??'')};
        if(part?.type==='input_image' && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(String(part.image_url||'')))
          return {type:'input_image',image_url:part.image_url,detail:part.detail||'auto'};
        if(part?.type==='input_file' && typeof part.file_id==='string')
          return {type:'input_file',file_id:part.file_id};
        throw fail('unsupported_responses_media','A selected attachment is unsupported by Responses API.');
      });
      result.push({role:'user',content:parts});
    }else if(item?.type==='message' && item.role==='assistant'){
      const value=messageText(item.content);
      if(value.trim())result.push({role:'assistant',content:value});
    }else if(item?.type==='function_call'){
      if(typeof item.name!=='string'||typeof item.call_id!=='string'||!item.call_id)
        throw fail('invalid_responses_call','Malformed historical function call.');
      const argumentsText=typeof item.arguments==='string'?item.arguments:JSON.stringify(item.arguments??{});
      try{if(!object(JSON.parse(argumentsText)))throw Error('not object');}
      catch{throw fail('invalid_responses_arguments','Historical function arguments are invalid JSON.');}
      if(called.has(item.call_id))throw fail('duplicate_responses_call','Duplicate historical function call ID.');
      called.add(item.call_id);
      result.push({type:'function_call',call_id:item.call_id,name:item.name,arguments:argumentsText});
    }else if(item?.type==='function_call_output'){
      if(!called.has(item.call_id))throw fail('unbound_responses_tool_result','Tool result lacks its original function call.');
      const output=typeof item.output==='string'?item.output:JSON.stringify(item.output??null);
      result.push({type:'function_call_output',call_id:item.call_id,output});
    }else if(item?.type==='reasoning' && typeof item.encrypted_content==='string'){
      // Never reconstruct or display private reasoning. Reuse only the
      // encrypted reasoning continuation returned by the provider.
      result.push({type:'reasoning',encrypted_content:item.encrypted_content,
        ...(typeof item.id==='string'?{id:item.id}:{})});
    }
  }
  return result;
}

export function buildResponsesBody({model,input,instructions,tools=[],maxOutputTokens=16384,stream=false}={}){
  if(typeof model!=='string'||!model)throw fail('invalid_responses_model','Missing model.');
  const body={
    model, instructions:String(instructions||''), input:asResponsesInput(input),
    store:false, truncation:'disabled',
    max_output_tokens:Math.max(256,Math.floor(maxOutputTokens)),
    stream:Boolean(stream),
  };
  if(tools.length){
    body.tools=tools.map(tool=>{
      if(typeof tool.name!=='string'||!object(tool.parameters))throw fail('invalid_responses_tool','Invalid function schema.');
      return {type:'function',name:tool.name,description:String(tool.description||''),
        parameters:tool.parameters,strict:tool.strict===true};
    });
    body.tool_choice='auto';
    body.parallel_tool_calls=false;
  }
  // Only request encrypted reasoning; no chain-of-thought is displayed.
  body.include=['reasoning.encrypted_content'];
  return body;
}

export function normalizeResponsesResponse(raw,{usedCallIds=new Set()}={}){
  if(!object(raw)||!Array.isArray(raw.output))throw fail('invalid_responses_json','Responses API returned malformed JSON.');
  const usage={
    input_tokens:reportedTokenCount(raw.usage?.input_tokens),
    output_tokens:reportedTokenCount(raw.usage?.output_tokens),
    cache_read_tokens:reportedTokenCount(raw.usage?.input_tokens_details?.cached_tokens),
    reasoning_tokens:reportedTokenCount(raw.usage?.output_tokens_details?.reasoning_tokens),
  };
  if(raw.status!=='completed'){
    const reason=String(raw.incomplete_details?.reason||raw.error?.code||raw.status||'unknown').slice(0,80);
    return {status:raw.status==='incomplete'?'incomplete':'failed',
      output:[],incomplete_details:{reason},usage};
  }
  const output=[], ids=new Set(usedCallIds);
  for(const item of raw.output){
    if(item?.type==='message'){
      for(const part of item.content||[]){
        if(part?.type==='output_text'&&typeof part.text==='string'&&part.text.trim())
          output.push({type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:part.text}]});
        else if(part?.type==='refusal'&&typeof part.refusal==='string')
          output.push({type:'message',role:'assistant',content:[{type:'refusal',refusal:part.refusal}]});
      }
    }else if(item?.type==='function_call'){
      if(item.status && item.status!=='completed')throw fail('incomplete_responses_tool','Responses API returned an unfinished tool call.');
      if(typeof item.name!=='string'||!item.name||typeof item.arguments!=='string')
        throw fail('invalid_responses_call','Responses API returned invalid function name/arguments.');
      let args;
      try{args=JSON.parse(item.arguments);}catch{throw fail('invalid_responses_arguments','Responses tool arguments are not valid JSON.');}
      if(!object(args))throw fail('invalid_responses_arguments','Responses tool arguments must be a JSON object.');
      const callId=typeof item.call_id==='string'&&item.call_id?item.call_id:'call_'+randomUUID().replaceAll('-','');
      if(ids.has(callId))throw fail('duplicate_responses_call','Responses function call ID was reused.');
      ids.add(callId);
      output.push({type:'function_call',name:item.name,call_id:callId,arguments:item.arguments,status:'completed'});
    }else if(item?.type==='reasoning'){
      if(typeof item.encrypted_content==='string')
        output.push({type:'reasoning',encrypted_content:item.encrypted_content,...(typeof item.id==='string'?{id:item.id}:{})});
    }else if(item?.type?.endsWith?.('_call')) {
      throw fail('unsupported_responses_tool','Unsupported built-in Responses tool. Only locally permission-gated functions are enabled.');
    }
  }
  if(!output.some(x=>x.type==='message'||x.type==='function_call'))
    throw fail('empty_responses_output','Responses API completed without supported text or tool calls.');
  // Earlier messages are commentary when the same response also calls tools.
  if(output.some(x=>x.type==='function_call'))
    for(const item of output)if(item.type==='message'&&item.phase==='final')item.phase='commentary';
  return {status:'completed',output,usage};
}

// Decode SSE without executing partial tool arguments. Only terminal
// response.completed provides authoritative final items and call IDs.
export async function readResponsesStream(body,{signal,onToken=()=>{}}={}){
  if(!body||typeof body.getReader!=='function')throw fail('invalid_responses_stream','Provider returned no SSE stream.');
  const reader=body.getReader(),decoder=new TextDecoder();
  let pending='',total=0,terminal=null;
  const handle=async block=>{
    const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data||data==='[DONE]')return;
    let event;
    try{event=JSON.parse(data);}catch{throw fail('invalid_responses_stream','Malformed SSE event.');}
    if(event.type==='response.output_text.delta'&&typeof event.delta==='string')await onToken(event.delta);
    if(['response.completed','response.incomplete','response.failed','response.cancelled'].includes(event.type)){
      if(terminal)throw fail('duplicate_responses_terminal','Multiple terminal SSE events.');
      terminal=event.response;
    }
  };
  try{
    for(;;){
      signal?.throwIfAborted?.();
      const {done,value}=await reader.read();
      if(done)break;
      total+=value?.byteLength||0;
      if(total>12*1024*1024)throw fail('responses_stream_too_large','Response stream exceeded 12 MiB.');
      pending+=decoder.decode(value,{stream:true});
      for(;;){
        const match=/\r?\n\r?\n/.exec(pending);
        if(!match)break;
        const block=pending.slice(0,match.index);
        pending=pending.slice(match.index+match[0].length);
        await handle(block);
      }
    }
    if(pending.trim())await handle(pending);
    if(!terminal)throw fail('responses_stream_interrupted','Responses stream ended without terminal confirmation. No tool calls executed.');
    return terminal;
  }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
}

// One network attempt per call, with a fixed destination/credential snapshot.
// The caller counts actual attempts. No retry can replay filesystem effects.
export async function respondOpenAIResponses(ctx,{input,instructions,tools=[],signal,onToken=()=>{},beforeModelRequest=()=>{},maxOutputTokens=16384}={}){
  const streaming=ctx.stream===true;
  const body=buildResponsesBody({model:ctx.model,input,instructions,tools,maxOutputTokens,stream:streaming});
  const timeout=AbortSignal.timeout(ctx.timeoutMs||240000);
  const effectiveSignal=signal?AbortSignal.any([signal,timeout]):timeout;
  beforeModelRequest();
  let response;
  try{
    response=await ctx.fetch(ctx.endpoint,{
      method:'POST',headers:ctx.headers,body:JSON.stringify(body),
      signal:effectiveSignal,redirect:'error',
    });
  }catch(error){
    if(signal?.aborted)throw signal.reason;
    if(timeout.aborted)throw fail('responses_timeout','Responses model request timed out.');
    throw fail('responses_network','Cannot connect to selected Responses API endpoint.');
  }
  if(!response.ok){
    let data=null;
    try{data=JSON.parse(await readBodyText(response));}catch{}
    const info=classifyHttpError({status:response.status,data:data||{},headers:response.headers,
      redact:ctx.redact||((s)=>s)});
    throw Object.assign(fail(info.code,info.message),{kind:info.kind,upstreamStatus:response.status});
  }
  let data;
  if(streaming){
    const mime=response.headers?.get?.('content-type')||'';
    if(!mime.includes('text/event-stream'))throw fail('invalid_responses_stream','Endpoint did not return SSE content type.');
    data=await readResponsesStream(response.body,{signal:effectiveSignal,onToken});
  }else{
    const raw=await readBodyText(response);
    try{data=JSON.parse(raw);}catch{throw fail('invalid_responses_json','Responses API did not return valid JSON.');}
  }
  return normalizeResponsesResponse(data,{
    usedCallIds:new Set((input||[]).filter(x=>x?.type==='function_call').map(x=>x.call_id)),
  });
}
