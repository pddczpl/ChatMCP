import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { AgentRunner, ROUTER_TOOLS } from '../lib/agent.mjs';
import { geminiTextEnvelope, normalizeGeminiTextReply } from '../lib/gemini-compat.mjs';

// Regression for a real-world pattern: list_directory succeeds, but a later
// contents-only Gemini response is a valid JSON object with an incorrect
// envelope ("action" instead of "chatmcp_action"). Repair MODEL output only.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-action-recovery-226-'));
const workspace = path.join(root, 'workspace');
await fs.mkdir(workspace);
const key = 'FAKE_SECRET_DO_NOT_LOG_226';
const reply = value => ({candidates:[{finishReason:'STOP', content:{parts:[{text:JSON.stringify(value)}]}}],usageMetadata:{promptTokenCount:1670,candidatesTokenCount:50,thoughtsTokenCount:76}});
const response = body => ({status:200,ok:true, async text(){return JSON.stringify(body);}});
let calls = 0, requests = 0;
const manager = {
  secrets:[],busy:false,
  state(){return {workspace:{path:workspace},generation:1,instanceId:'action-recovery',services:{desktop:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'}}};},
  acquireTask(){if(this.busy)return false;this.busy=true;return true;},
  releaseTask(){this.busy=false;},
  async createAgentSession(){return {
    catalog:{tools:[{name:'desktop-commander.list_directory',inputSchema:{type:'object',properties:{path:{type:'string'}}}}],prompts:[],resources:[],resourceTemplates:[],servers:{}},
    async callTool(name,args){calls++;assert.equal(name,'desktop-commander.list_directory');assert.equal(args.path,workspace);
      return {content:[{type:'text',text:'[FILE] README.md\n[DIR] starter\n[FILE] eval.py'}]};},
    async close(){}
  };}
};
const provider = new GatewayProvider({directory:path.join(root,'gateway'),bundleRoot:root,manager,env:{},fetchImpl:async (_url,opts)=>{
  assert.equal(opts.headers['x-goog-api-key'],key);
  const payload = JSON.parse(opts.body);
  assert.deepEqual(Object.keys(payload),['contents'],'minimal contents-only payload');
  const prompt=payload.contents[0].parts[0].text;
  assert.ok(prompt.includes('OUTPUT CONTRACT FOR THIS TURN'),'output contract appended');
  requests++;
  if(requests===1){
    return response(reply({chatmcp_action:'tool',name:'mcp_call',arguments:{name:'desktop-commander.list_directory',arguments_json:JSON.stringify({path:workspace})}}));
  }
  if(requests===2){
    assert.ok(prompt.includes('[FILE] README.md'),'successful tool result sent in following request');
    // Exactly what the earlier parser would reject without a retry:
    return response(reply({action:'final',message:'README.md is present'}));
  }
  if(requests===3){
    assert.ok(prompt.includes('SCHEMA RECOVERY 1/2'),'repair should name the format problem');
    assert.ok(prompt.includes('action, message'),'safe root-key diagnostic');
    assert.ok(prompt.includes('ALREADY BEEN EXECUTED'),'explicit instruction not to repeat MCP');
    return response(reply({chatmcp_action:'final',text:'Đã liệt kê 3 mục; README.md và eval.py hiện diện.'}));
  }
  throw Error('Unexpected request after verified final');
}});
const poll = async(agent,id)=>{for(let i=0;i<400;i++){let v=agent.get(id); if(v.status!=='running')return v; await new Promise(r=>setTimeout(r,15));} throw Error('Task timeout');};
try {
  await provider.load();
  await provider.configure({apiBaseUrl:'https://local-gateway.example.invalid',protocol:'gemini',model:'gemini-fixture',authMode:'google-key',apiKey:key});
  provider.geminiDialect='text-protocol'; provider.dialectConfirmed=true;
  const agent = new AgentRunner({manager,provider,taskDirectory:path.join(root,'tasks')});
  await agent.load();
  const id=(await agent.start({prompt:'Liệt kê file trong workspace'})).id;
  const task=await poll(agent,id);
  assert.equal(task.status,'completed',task.error);
  assert.equal(calls,1,'list_directory must never be repeated by formatting repair');
  assert.equal(task.toolCalls,1);
  assert.equal(requests,3,'one model-only recovery after successful MCP');
  assert.ok(task.finalText.includes('README.md'));
  assert.ok(task.events.some(event=>event.type==='model_repair' && /chatmcp_action/.test(event.message)));
  assert.ok(!JSON.stringify(task).includes(key),'secret must stay outside task journal');
  await agent.shutdown();

  const wrap=(text, other=[])=>({candidates:[{finishReason:'STOP',content:{parts:[...other,{text}]}}]});
  const badShape={action:'tool',name:'mcp_call',arguments:{name:'desktop-commander.list_directory',arguments_json:'{}'}};
  assert.throws(()=>normalizeGeminiTextReply(wrap(JSON.stringify(badShape)),ROUTER_TOOLS),e=>{
    assert.equal(e.code,'gateway_text_protocol_invalid');assert.equal(e.retryable,true);
    assert.equal(e.formatIssue,'action_shape');assert.deepEqual(e.observedKeys,['action','name','arguments']);return true;
  });
  // No execution can come from a candidate containing native function calls.
  assert.throws(()=>normalizeGeminiTextReply(wrap('{"chatmcp_action":"final","text":"OK"}',[{functionCall:{name:'mcp_call',args:{}}}]),ROUTER_TOOLS),e=>e.code==='gateway_text_protocol_invalid' && e.retryable===true);
  // Explicit final actions can use a natural-language alias without tool execution.
  assert.equal(normalizeGeminiTextReply(wrap('{"chatmcp_action":"final","answer":"Hoàn tất"}'),ROUTER_TOOLS).output[0].phase,'final');
  // Valid router + args alias should route ONLY to the known MCP router.
  assert.equal(normalizeGeminiTextReply(wrap('{"chatmcp_action":"tool","name":"mcp_catalog","args":{"filter":null,"offset":0,"limit":30}}'),ROUTER_TOOLS).output.at(-1).name,'mcp_catalog');
  assert.throws(()=>normalizeGeminiTextReply(wrap('{"chatmcp_action":"tool","name":"dangerous_unknown","arguments":{}}'),ROUTER_TOOLS),e=>e.retryable!==true);
  // JSON split through parts must be parsed without inserting a newline into a string.
  const split=JSON.stringify({chatmcp_action:'final',text:'Nội dung hợp lệ'});
  const splitResult={candidates:[{finishReason:'STOP',content:{parts:[{text:split.slice(0,28)},{text:split.slice(28)}]}}]};
  assert.equal(normalizeGeminiTextReply(splitResult,ROUTER_TOOLS).output[0].phase,'final');
  assert.throws(()=>normalizeGeminiTextReply(wrap('Some prose and {"chatmcp_action":"final","text":"unsafe"}'),ROUTER_TOOLS),e=>e.retryable===true);
  const prompt=geminiTextEnvelope([{role:'user',content:[{text:'Inspect docs'}]},{type:'function_call',name:'mcp_call',call_id:'abc',arguments:'{}'},{type:'function_call_output',call_id:'abc',output:'[FILE] README.md'}], 'Use MCP, follow safety rules',ROUTER_TOOLS).contents[0].parts[0].text;
  assert.ok(prompt.lastIndexOf('OUTPUT CONTRACT FOR THIS TURN') > prompt.indexOf('MCP TOOL RESULT'));
  assert.ok(prompt.includes('ALREADY EXECUTED'));

  // Exhausting two schema-only repairs must fail closed with a useful reason.
  let failedRequests=0;
  const broken=new GatewayProvider({directory:path.join(root,'broken'),bundleRoot:root,manager,env:{},fetchImpl:async()=>{failedRequests++;return response(reply({result:'looks done',status:'ok'}));}});
  await broken.load();await broken.configure({apiBaseUrl:'https://local-gateway.example.invalid',protocol:'gemini',model:'gemini-fixture',authMode:'google-key',apiKey:key});
  broken.geminiDialect='text-protocol';broken.dialectConfirmed=true;
  await assert.rejects(broken.respond({input:[{role:'user',content:[{text:'task'}]}],instructions:'Safety',tools:ROUTER_TOOLS}),e=>{
    assert.equal(e.code,'gateway_text_protocol_invalid');assert.equal(e.retryable,true);assert.equal(e.formatIssue,'action_shape');
    assert.match(e.message,/2 lần/);return true;
  });
  assert.equal(failedRequests,3);
  assert.equal(calls,1,'even after exhausted repairs, no repeated MCP execution');
  console.log('PASS action-schema recovery after MCP success, repair not replay, strict allowlist, multipart JSON, final alias, encrypted-secret redaction');
} finally {await fs.rm(root,{recursive:true,force:true});}
