import assert from 'node:assert/strict';
import net from 'node:net';
import { createHubServer } from '../hub.mjs';
import { VERSION } from '../lib/manager.mjs';

async function freePort() { const server=net.createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;await new Promise(r=>server.close(r));return port; }
const port=await freePort();
const origin=`http://127.0.0.1:${port}`;
let mode='chatgpt-web', key='', active=null, requests=0, resumes=0, deletes=0;
const taskId='123e4567-e89b-42d3-a456-426614174000';
const manager={secrets:[],log:()=>{},catalog:{ready:true,tools:[]},state:()=>({version:'1.3.0',workspace:{path:'C:\\Example'},generation:1,instanceId:'mock',busy:false,services:{docker:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'},desktop:{state:'ready'}}})};
const apiAgent={state:()=>({mode,activeTaskId:active?.id || null,active,tasks:active?[active]:[]}),get:(id)=>id===taskId?active:null,report:async()=> 'mock report',subscribe:()=>()=> {},configure:async({mode:next})=>{if(active)throw Object.assign(new Error('Running'),{statusCode:409}); mode=next; return {mode}},start:async()=>{active={id:taskId,status:'running',provider:mode,steps:0,toolCalls:0,events:[]};return active},continue:async({id,prompt})=>{assert.equal(id,taskId);assert.equal(prompt,'Continue lab');resumes++;active={id,status:'running',provider:mode,prompt,steps:3,toolCalls:1,events:[]};return active},delete:async(id)=>{assert.equal(id,taskId);deletes++;active=null;return {ok:true,deletedId:id}},cancel:async()=>{active=null;return {id:taskId,status:'cancelled'}}};
const browser={browserState:()=>({paired:false,mode:'chatgpt-web'}),createPairCode:async()=>({code:'12345678'}),unpair:async()=>{},shutdown:async()=>{}};
const provider={state:()=>({provider:'gateway',model:'gemini-3.8-flash',apiBaseUrl:'https://gw.example',protocol:'gemini',configured:Boolean(key),keySource:key?'session':'none'}),ready:()=>Boolean(key),snapshot:()=>({model:'gemini-3.8-flash'}),configure:async(data)=>{key=data.apiKey;return {}},clearKey:async()=>{key='';return {}},respond:async()=>{requests++;return {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]}}};
const server=createHubServer(manager,{port,browser,agent:apiAgent,provider});
await new Promise(r=>server.listen(port,'127.0.0.1',r));
let assertions=0;
const check=(bool,label)=>{assert.ok(bool,label);assertions++};
const post=(route,body={},csrf=null)=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-ChatMCP-Request':'local-dashboard',...(csrf?{'X-ChatMCP-CSRF':csrf}:{})},body:JSON.stringify(body)});
try {
  const state=await fetch(origin+'/api/state').then(r=>r.json());
  check(state.agent.mode==='chatgpt-web','default web');
  check(state.ai?.configured===false,'api key not configured');
  check(JSON.stringify(state).indexOf('mock-secret-token')===-1,'state clean');
  check((await post('/api/agent/mode',{mode:'api'})).status===403,'CSRF required');
  let response=await post('/api/agent/mode',{mode:'api'},state.csrfToken);check(response.status===200,'mode switch');
  check((await response.json()).agent.mode==='api','mode observed');
  response=await post('/api/ai/config',{protocol:'gemini',apiBaseUrl:'https://gw.example',model:'gemini-3.8-flash',apiKey:'mock-secret-token'},state.csrfToken);
  check(response.ok,'api configured');
  check(!JSON.stringify(await response.json()).includes('mock-secret-token'),'api key not returned');
  response=await post('/api/ai/test',{},state.csrfToken);check(response.ok,'test call');
  check((await response.json()).responsePresent===true,'test response present');
  check(requests===1,'exactly one model request for test');
  response=await post('/api/tasks/start',{prompt:'hello'},state.csrfToken);check(response.ok,'task start');
  check((await response.json()).task.id===taskId,'task handle');
  response=await post('/api/agent/mode',{mode:'chatgpt-web'},state.csrfToken);check(response.status===409,'switch locked');
  response=await post('/api/ai/clear-key',{},state.csrfToken);check(response.status===409,'clear key locked');
  response=await post('/api/tasks/cancel',{id:taskId},state.csrfToken);check(response.ok,'cancel works');
  // A new prompt in a selected session MUST target the same task ID.
  check((await post('/api/tasks/continue',{id:taskId,prompt:'Continue lab'})).status===403,'resume requires CSRF');
  response=await post('/api/tasks/continue',{id:taskId,prompt:'Continue lab'},state.csrfToken);
  check(response.ok,'resume HTTP route');check((await response.json()).task.id===taskId,'resume preserved conversation ID');
  check(resumes===1,'resume executed once');

  // Verify SSE stream connection
  const streamRes = await fetch(origin + `/api/tasks/${taskId}/stream`);
  check(streamRes.status === 200 && streamRes.headers.get('content-type')?.includes('text/event-stream'), 'task SSE stream route');
  const streamReader = streamRes.body.getReader();
  const firstChunk = await streamReader.read();
  check(new TextDecoder().decode(firstChunk.value).includes('connected'), 'stream connects');
  await streamReader.cancel();

  response=await post('/api/tasks/delete',{id:taskId},state.csrfToken);
  check(response.ok,'explicit delete route');check(deletes===1,'delete dispatched once');
  response=await post('/api/ai/clear-key',{},state.csrfToken);check(response.ok,'clear key');
  check((await response.json()).ai.configured===false,'key cleared');
  check((await fetch(origin+'/api/health').then(r=>r.json())).version===VERSION,'health');
  const homepage = await fetch(origin+'/').then(r=>r.text());
  check(homepage.includes('id="root"') && homepage.includes('react-app.js'), 'dual-mode dashboard settings rendered');
  check(homepage.includes('React and ReactDOM are vendored'), 'agent progress + live timeline visible');
  check(homepage.includes('/vendor/react.production.min.js'), 'persistent session sidebar and dialogue present');
  const browserUi = await fetch(origin+'/react-app.js').then(r=>r.text());
  check(browserUi.includes('/api/ai/config') && browserUi.includes('/api/agent/mode'), 'dashboard actions wired to API and mode endpoints');
  check(browserUi.includes('/api/tasks/continue') && browserUi.includes('/api/tasks/delete'), 'resume and explicit delete actions connected');
  check(!homepage.includes('mock-secret-token') && !browserUi.includes('mock-secret-token'), 'static assets contain no API secrets');
  console.log('PASS:',assertions,'HTTP integration checks: mode selection, key config, test model, routing, locking, CSRF, key redaction, task SSE streaming');
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
