import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { geminiTextEnvelope, normalizeGeminiTextReply } from '../lib/gemini-compat.mjs';
import { AgentRunner } from '../lib/agent.mjs';

const base=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-compat-223-'));
const privateKey='fixture-secret-do-not-echo';
const workspace=path.join(base,'repo');await fs.mkdir(workspace);
const manager={
  secrets:[], locked:false,
  state(){return {workspace:{path:workspace},generation:1,instanceId:'compat-fixture',services:{desktop:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'}}};},
  acquireTask(){if(this.locked)return false;this.locked=true;return true;},
  releaseTask(){this.locked=false;},
  async createAgentSession(){return {catalog:{tools:[{name:'desktop-commander.list_directory',description:'List directory',server:'desktop-commander',inputSchema:{type:'object',properties:{path:{type:'string'}}}}],prompts:[],resources:[],resourceTemplates:[],servers:{}},
    async callTool(name,args){assert.equal(name,'desktop-commander.list_directory');actualCalls++;assert.equal(args.path,workspace);return {content:[{type:'text',text:'[FILE] README.md'}]};},
    async close(){}};}
};
let actualCalls=0,modelCalls=0,rejections=0,compatible=0;const seenUrls=[];const notices=[];
const fixture=(status,data)=>({status,ok:status<400,async text(){return JSON.stringify(data)}});
const gateway=new GatewayProvider({directory:path.join(base,'gateway'),bundleRoot:base,manager,env:{},fetchImpl:async(url,req)=>{
  seenUrls.push(url);
  assert.equal(req.headers['x-goog-api-key'],privateKey);
  assert.ok(!req.headers.Authorization);
  const body=JSON.parse(req.body);
  if(Object.keys(body).sort().join(',')!=='contents'){
    rejections++;
    return fixture(400,{error:{code:400,message:'Unsupported request fields'}});
  }
  compatible++;modelCalls++;
  const text=JSON.stringify(modelCalls===1?
    {chatmcp_action:'tool',name:'mcp_call',progress:'Reading workspace',arguments:{name:'desktop-commander.list_directory',arguments_json:JSON.stringify({path:workspace})}}:
    {chatmcp_action:'final',text:'Đã đọc README.md. Không sửa file.'});
  assert.ok(req.body.includes('chatmcp_action'));
  if(modelCalls===2)assert.ok(req.body.includes('[FILE] README.md'),'tool result supplied to model in text protocol');
  return fixture(200,{candidates:[{content:{parts:[{text}]},finishReason:'STOP'}]});
}});
try{
  await gateway.load();await gateway.configure({apiBaseUrl:'https://gateway.example.invalid',protocol:'gemini',model:'gemini-fixture',authMode:'google-key',apiKey:privateKey});
  const engine=new AgentRunner({manager,provider:gateway,taskDirectory:path.join(base,'tasks')});await engine.load();
  const started=await engine.start({prompt:'Đọc thư mục và báo cáo.'});
  assert.equal(started.maxSteps,null,'default has no turn cap');
  assert.equal(started.maxMinutes,null,'default has no total time cap');
  let task;
  for(let tries=0;tries<400;tries++){
    task=engine.get(started.id);
    if(task.status!=='running')break;
    await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(task.status,'completed',task.error);
  assert.equal(task.steps,2);
  assert.equal(task.toolCalls,1);
  assert.equal(actualCalls,1,'no repeated MCP side effects during fallback');
  assert.equal(modelCalls,2);
  assert.equal(rejections,3,'native fields rejected, then switched to strict text protocol');
  assert.equal(compatible,2,'subsequent turn cached working dialect');
  assert.equal(gateway.geminiDialect,'text-protocol');
  assert.ok(seenUrls.every(u=>u==='https://gateway.example.invalid/v1beta/models/gemini-fixture:generateContent'),'same gateway URL');
  assert.ok(task.events.some(e=>e.type==='network_wait'&&e.message.includes('tương thích')),'agent displays fallback status');
  assert.equal(task.finalText,'Đã đọc README.md. Không sửa file.');
  assert.ok(!JSON.stringify(task).includes(privateKey));
  await engine.shutdown();

  const tools=[{name:'mcp_call',description:'MCP',parameters:{type:'object'}}];
  const envelope=geminiTextEnvelope([{role:'user',content:[{text:'Hi'}]}],'Safe instructions',tools);
  assert.deepEqual(Object.keys(envelope),['contents'],'minimal gateway request');
  assert.ok(envelope.contents[0].parts[0].text.includes('Safe instructions'));
  assert.throws(()=>normalizeGeminiTextReply({candidates:[{content:{parts:[{text:JSON.stringify({chatmcp_action:'tool',name:'delete_everything',arguments:{}})}]}}]},tools),/công cụ/);
  assert.throws(()=>normalizeGeminiTextReply({candidates:[{content:{parts:[{text:'run rm -rf'}]}}]},tools),/JSON tool\/final/);

  const errors=[];
  const rejecting=new GatewayProvider({directory:path.join(base,'reject'),bundleRoot:base,manager,env:{},fetchImpl:async(url,opt)=>{errors.push(1);return fixture(400,{error:{message:'Unknown model'}})}});
  await rejecting.load();await rejecting.configure({apiBaseUrl:'https://gateway.example.invalid',model:'bad-model',protocol:'gemini',apiKey:privateKey});
  await assert.rejects(rejecting.respond({input:[{role:'user',content:[{text:'test'}]}],instructions:'test'}),/Unknown model/);
  assert.equal(errors.length,1,'model not found must NOT fall back/retry multiple times');
  console.log('PASS 2-turn API coding agent, Gemini contents-only gateway HTTP 400 fallback, unlimited defaults, one real MCP call, no secrets, fail-closed parsing');
}finally{await fs.rm(base,{recursive:true,force:true})}
