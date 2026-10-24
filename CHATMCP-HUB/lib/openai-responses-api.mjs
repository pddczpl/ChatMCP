// OpenAI Responses protocol adapter. No hosted state is required: with
// store:false, every step supplies the canonical user/assistant/tool history.
// Only completed provider responses may authorize tool calls.
import { randomUUID } from 'node:crypto';
import { reportedTokenCount } from './request-budget.mjs';
import { pairToolCalls } from './model-history.mjs';
import { classifyHttpError, errorDetail, readBodyText } from './model-http.mjs';
import { applyReasoning, refusesReasoning } from './reasoning-effort.mjs';
import { readSse } from './sse.mjs';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (code,message) => Object.assign(new Error(message),{code,statusCode:502});
// The connection or a clock failed, not the model: reported like the network failures of the standard adapter.
const networkFail = (code,message) => Object.assign(fail(code,message),{kind:'network'});
const lapse = ms => (ms>=1000?`${Math.round(ms/1000)} s`:`${ms} ms`);
const messageText = parts => (Array.isArray(parts) ? parts.filter(p=>p?.type==='output_text'&&typeof p.text==='string').map(p=>p.text).join('\n') : '');

// A stream that sends no byte for this long is given up. ctx.timeoutMs, the whole call, is the other clock. Reasoning models can be
// silent for a while between events, so this is well above a healthy pause and well below the whole call.
const IDLE_TIMEOUT_MS = 120000;

export function asResponsesInput(history=[]) {
  // Other legacy adapters tolerate orphan results by dropping them, but the
  // Responses wire format has explicit call_id correlation. Reject before
  // compatibility pairing so an unattested tool result cannot disappear.
  if(!Array.isArray(history))throw fail('invalid_responses_history','Conversation history must be a list.');
  const seenCallIds=new Set();
  for(const item of history){
    if(item?.type==='function_call'){
      if(typeof item.call_id!=='string'||!item.call_id||seenCallIds.has(item.call_id))
        throw fail('duplicate_responses_call','Historical tool call ID is missing or duplicated.');
      seenCallIds.add(item.call_id);
    }else if(item?.type==='function_call_output' && !seenCallIds.has(item.call_id)){
      throw fail('unbound_responses_tool_result','Tool result lacks an earlier matching function call.');
    }
  }
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
// onChunk runs whenever bytes arrived, of any kind: it is how the caller knows the stream is alive.
// The events come from the Hub's one SSE reader (lib/sse.mjs); what they mean, and which one ends the stream, is decided here.
export async function readResponsesStream(body,{signal,onToken=()=>{},onChunk=()=>{}}={}){
  if(!body||typeof body.getReader!=='function')throw fail('invalid_responses_stream','Provider returned no SSE stream.');
  let terminal=null;
  const handle=async ({data})=>{
    if(!data||data==='[DONE]')return;
    let event;
    try{event=JSON.parse(data);}catch{throw fail('invalid_responses_stream','Malformed SSE event.');}
    if(!object(event))throw fail('invalid_responses_stream','Malformed SSE event.');
    if(event.type==='response.output_text.delta'&&typeof event.delta==='string')await onToken(event.delta);
    if(['response.completed','response.incomplete','response.failed','response.cancelled'].includes(event.type)){
      if(terminal)throw fail('duplicate_responses_terminal','Multiple terminal SSE events.');
      terminal=event.response;
    }
  };
  try{
    await readSse(body,{signal,onChunk,onEvent:handle});
  }catch(error){
    if(error?.code==='sse_too_large')throw fail('responses_stream_too_large','Response stream exceeded 12 MiB.');
    throw error;
  }
  if(!terminal)throw fail('responses_stream_interrupted','Responses stream ended without terminal confirmation. No tool calls executed.');
  return terminal;
}

// The 400 of a gateway that cannot stream this model. It says so in the field it names or in its words ("Unsupported value: 'stream'
// does not support true with this model", "Your organization must be verified to stream this model"). A plain refusal only: a 400
// about the context, the output cap, the quota or the model is not about the stream.
const refusesStream=(status,data,info)=>status===400&&info.kind==='request'&&(data?.error?.param==='stream'||/\bstream/i.test(errorDetail(data)));

// The stream was refused, so the text did not arrive in pieces: hand it to onToken now, as the stream would have.
async function deliverText(result,onToken){
  if(result.status!=='completed')return;
  for(const item of result.output)
    if(item.type==='message')for(const part of item.content)if(part.type==='output_text')await onToken(part.text);
}

/**
 * One model request. At most two network attempts, each announced to the caller through beforeModelRequest, which counts them: a
 * gateway that answers 400 to stream: true is asked once more WITHOUT it. That is the same model request and never a tool call, so
 * nothing can be replayed. Everything else is one attempt with a fixed destination and credential snapshot; no retry can replay
 * filesystem effects.
 * @param {object} ctx fixed for the whole call
 * @param {string} ctx.model
 * @param {string} ctx.endpoint
 * @param {object} ctx.headers
 * @param {Function} ctx.fetch
 * @param {boolean} [ctx.stream] the caller wants the text as it arrives (onToken)
 * @param {number} [ctx.timeoutMs] the whole call, for each attempt (default 240 s)
 * @param {number} [ctx.idleTimeoutMs] a stream that sends no byte for this long is closed (default 120 s)
 * @param {boolean} [ctx.streamRefused] this gateway is known to refuse stream: true, so do not ask; onToken still gets the text, at the end
 * @param {() => void} [ctx.onStreamRefused] a refusal is confirmed: the repeat without a stream was accepted
 * @param {{field: string, value: unknown}|null} [ctx.reasoning] the thinking setting to put in the request (lib/reasoning-effort.mjs), or nothing
 * @param {boolean} [ctx.reasoningRefused] this endpoint and model are known to refuse it, so do not send it
 * @param {() => void} [ctx.onReasoningRefused] a refusal is confirmed: the repeat without the setting was accepted
 * @param {(text: string) => string} [ctx.redact] removes keys and other secrets from provider text
 */
export async function respondOpenAIResponses(ctx,{input,instructions,tools=[],signal,onToken=()=>{},onStatus=async()=>{},beforeModelRequest=()=>{},maxOutputTokens=16384}={}){
  const wantsStream=ctx.stream===true,redact=ctx.redact||(s=>s);
  let streaming=wantsStream&&ctx.streamRefused!==true,repeated=false;
  let reasoning=ctx.reasoning&&ctx.reasoningRefused!==true?ctx.reasoning:null,reasoningDropped=false;
  const usedCallIds=new Set((input||[]).filter(x=>x?.type==='function_call').map(x=>x.call_id));
  for(;;){
    const body=buildResponsesBody({model:ctx.model,input,instructions,tools,maxOutputTokens,stream:streaming});
    if(reasoning)applyReasoning(body,reasoning);
    const wholeMs=ctx.timeoutMs||240000,idleMs=ctx.idleTimeoutMs||IDLE_TIMEOUT_MS;
    const timeout=AbortSignal.timeout(wholeMs),idle=new AbortController();
    const effectiveSignal=AbortSignal.any(signal?[signal,timeout,idle.signal]:[timeout,idle.signal]);
    // Why a request stopped, when the caller or a clock stopped it. The caller comes first: its own reason is never replaced.
    const stopped=()=>signal?.aborted?signal.reason
      :timeout.aborted?networkFail('responses_timeout',`Responses model request did not finish within ${lapse(wholeMs)}. The provider may be overloaded or the request too large; try again later or choose a faster model. No tool was run for this step.`)
      :idle.signal.aborted?idle.signal.reason:null;
    // The idle clock runs while a stream is read and starts over with every byte. Aborting it closes the connection, as the other two do.
    let idleTimer;
    const watch=()=>{
      clearTimeout(idleTimer);
      idleTimer=setTimeout(()=>idle.abort(networkFail('responses_idle_timeout',`Responses stream sent no data for ${lapse(idleMs)} and was closed. The gateway or the network may have stalled; try again or check the gateway log. No tool was run for this step.`)),idleMs);
    };
    beforeModelRequest();
    let response;
    try{
      response=await ctx.fetch(ctx.endpoint,{
        method:'POST',headers:ctx.headers,body:JSON.stringify(body),
        signal:effectiveSignal,redirect:'error',
      });
    }catch{
      throw stopped()??networkFail('responses_network','Cannot connect to selected Responses API endpoint.');
    }
    if(!response.ok){
      let data=null;
      try{data=JSON.parse(await readBodyText(response));}catch{}
      const info=classifyHttpError({status:response.status,data:data||{},headers:response.headers,redact});
      if(streaming&&refusesStream(response.status,data,info)){
        streaming=false;repeated=true;
        const detail=redact(errorDetail(data)).slice(0,200);
        await onStatus(`Gateway từ chối stream: true (HTTP 400${detail?`: ${detail}`:''}). Gửi lại đúng yêu cầu model này một lần với stream: false; không chạy lại công cụ. Các bước sau không thử stream nữa, văn bản trả lời hiện khi model trả xong.`);
        signal?.throwIfAborted();
        continue;
      }
      // The provider does not take the thinking setting (for this model): the same model request once more without it, never a tool call.
      if(reasoning&&refusesReasoning({status:response.status,data,info,sent:true})){
        reasoning=null;reasoningDropped=true;
        const detail=redact(errorDetail(data)).slice(0,200);
        await onStatus(`Nhà cung cấp từ chối thiết lập mức suy luận (thinking effort) cho model này (HTTP ${response.status}${detail?`: ${detail}`:''}). Gửi lại đúng yêu cầu model này một lần, không kèm thiết lập đó; không chạy lại công cụ. Các yêu cầu sau không gửi nó cho model này nữa.`);
        signal?.throwIfAborted();
        continue;
      }
      throw Object.assign(fail(info.code,info.message),{kind:info.kind,upstreamStatus:response.status});
    }
    // The gateway refused a stream and accepted the same request without one.
    if(repeated)ctx.onStreamRefused?.();
    // ... or the thinking setting.
    if(reasoningDropped)ctx.onReasoningRefused?.();
    let data;
    try{
      if(streaming){
        const mime=response.headers?.get?.('content-type')||'';
        if(!mime.includes('text/event-stream'))throw fail('invalid_responses_stream','Endpoint did not return SSE content type.');
        watch();
        data=await readResponsesStream(response.body,{signal:effectiveSignal,onToken,onChunk:watch});
      }else{
        const raw=await readBodyText(response);
        try{data=JSON.parse(raw);}catch{throw fail('invalid_responses_json','Responses API did not return valid JSON.');}
      }
    }catch(error){
      throw stopped()??error;
    }finally{clearTimeout(idleTimer);}
    const result=normalizeResponsesResponse(data,{usedCallIds});
    if(wantsStream&&!streaming)await deliverText(result,onToken);
    return result;
  }
}
