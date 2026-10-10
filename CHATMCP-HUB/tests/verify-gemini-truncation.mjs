import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { AgentRunner, ROUTER_TOOLS } from '../lib/agent.mjs';
import { geminiTextEnvelope, normalizeGeminiTextReply } from '../lib/gemini-compat.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-gemini-truncation-'));
const workspace = path.join(root,'workspace');
await fs.mkdir(workspace);
const secret='test-secret-not-to-log';
const response = (status,payload) => ({status,ok:status<400,async text(){return JSON.stringify(payload)}});
const stop = text => response(200,{candidates:[{finishReason:'STOP',content:{parts:[{text}]}}],usageMetadata:{candidatesTokenCount:60}});
const partial = () => response(200,{candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{"chatmcp_action":"tool","name":"mcp_call"'}]}}],usageMetadata:{promptTokenCount:1024,candidatesTokenCount:2048,thoughtsTokenCount:1800}});
const nativeReject = () => response(400,{error:{message:'Unsupported request fields'}});
const getGateway = (dir,fetchImpl,manager) => new GatewayProvider({directory:path.join(dir,'gateway'),bundleRoot:dir,manager,fetchImpl,env:{}});
let assertions=0;
const count = (condition,label)=>{assert.ok(condition,label);assertions++;};
const manager={secrets:[],locked:false,
  state(){return {workspace:{path:workspace},generation:1,instanceId:'gateway-truncation',services:{desktop:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'}}}},
  acquireTask(){if(this.locked)return false;this.locked=true;return true},
  releaseTask(){this.locked=false},
  async createAgentSession(){return {catalog:{tools:[{name:'desktop-commander.list_directory',inputSchema:{type:'object',properties:{path:{type:'string'}}}}],prompts:[],resources:[],resourceTemplates:[],servers:{}},
    async callTool(name,args){count(name==='desktop-commander.list_directory','actual tool name');count(args.path===workspace,'actual tool path');realMcpCalls++;return {content:[{type:'text',text:'[FILE] README.md'}]}},async close(){}};}
};
let realMcpCalls=0, modelRequests=0, nativeFailures=0,repairRequests=0;
try {
  const gateway=getGateway(path.join(root,'a'),async(url,opt)=>{
    count(opt.headers['x-goog-api-key']===secret,'key sent only to configured endpoint');
    count(url==='https://gateway.example.invalid/v1beta/models/gemini-test:generateContent','correct gateway');
    const body=JSON.parse(opt.body);
    if(Object.keys(body).join(',')!=='contents') {nativeFailures++;return nativeReject();}
    modelRequests++;
    if(modelRequests===1)return partial();
    if(modelRequests===2) {
      repairRequests++;
      count(opt.body.includes('FORMAT RECOVERY 1/2'),'repair prompt present');
      return stop(JSON.stringify({chatmcp_action:'tool',name:'mcp_call',arguments:{name:'desktop-commander.list_directory',arguments_json:JSON.stringify({path:workspace})}}));
    }
    count(opt.body.includes('[FILE] README.md'),'tool result present in next turn');
    return stop(JSON.stringify({chatmcp_action:'final',text:'Đã kiểm tra README.md'}));
  },manager);
  await gateway.load();await gateway.configure({apiBaseUrl:'https://gateway.example.invalid',protocol:'gemini',model:'gemini-test',apiKey:secret,authMode:'google-key'});
  const engine=new AgentRunner({manager,provider:gateway,taskDirectory:path.join(root,'tasks')});await engine.load();
  const taskStart=await engine.start({prompt:'Đọc thư mục rồi báo cáo'});
  let task;
  for(let i=0;i<400;i++){ task=engine.get(taskStart.id); if(task.status!=='running')break;await new Promise(r=>setTimeout(r,20));}
  count(task.status==='completed',`agent completed, not ${task.status} (${task.error})`);
  count(task.toolCalls===1 && realMcpCalls===1,'MCP mutation-free tool only executed once');
  count(nativeFailures===3,'native, no-config, inline each rejected exactly once');
  count(modelRequests===3 && repairRequests===1,'MAX_TOKENS repair only regenerates model once');
  count(task.events.some(e=>e.type==='model_repair' && /MAX_TOKENS/.test(e.message||'')),'progress shows model_repair / MAX_TOKENS');
  count(!JSON.stringify(task).includes(secret),'no secret in journal');
  count(gateway.geminiDialect==='text-protocol','dialect cached');
  await engine.shutdown();

  // Repeated truncations: cap retries and preserve a specific diagnostic.
  let retries=0;
  const broken=getGateway(path.join(root,'b'),async(url,opt)=>{retries++;return partial();},manager);
  await broken.load();await broken.configure({apiBaseUrl:'https://gateway.example.invalid',model:'gemini-test',apiKey:secret,protocol:'gemini'});
  broken.geminiDialect='text-protocol';broken.dialectConfirmed=true;
  await assert.rejects(broken.respond({input:[{role:'user',content:[{text:'Hi'}]}],instructions:'Stay safe',tools:ROUTER_TOOLS}),error=>{
    count(error.code==='gateway_text_incomplete','correct truncated code');
    count(error.message.includes('MAX_TOKENS') && error.message.includes('2 lần'),'reason + attempt count');
    count(error.message.includes('thinking=1800'),'thinking token count');
    return true;
  });
  count(retries===3,'exactly 2 recovery requests then fail closed');

  // SAFETY is not a repairable JSON formatting error. Never retry it.
  let safetyRequests=0;
  const safety=getGateway(path.join(root,'c'),async()=>{safetyRequests++;return response(200,{candidates:[{finishReason:'SAFETY',content:{parts:[]}}]});},manager);
  await safety.load();await safety.configure({apiBaseUrl:'https://gateway.example.invalid',model:'gemini-test',apiKey:secret,protocol:'gemini'});
  safety.geminiDialect='text-protocol';safety.dialectConfirmed=true;
  await assert.rejects(safety.respond({input:[{role:'user',content:[{text:'Hi'}]}],instructions:'Stay safe',tools:ROUTER_TOOLS}),error=>{
    count(error.code==='gateway_text_finish_reason','safety-specific code');
    count(error.message.includes('SAFETY'),'safety reason visible');return true;
  });
  count(safetyRequests===1,'SAFETY not retried');

  // Formatting errors are retryable but an invalid tool selection is not.
  let malformedRequests=0;
  const malformed=getGateway(path.join(root,'d'),async()=>{
    malformedRequests++;
    return malformedRequests===1?stop('not JSON'):stop(JSON.stringify({chatmcp_action:'final',text:'OK'}));
  },manager);
  await malformed.load();await malformed.configure({apiBaseUrl:'https://gateway.example.invalid',model:'gemini-test',apiKey:secret,protocol:'gemini'});
  malformed.geminiDialect='text-protocol';malformed.dialectConfirmed=true;
  const fixed=await malformed.respond({input:[{role:'user',content:[{text:'Hi'}]}],instructions:'Stay safe',tools:ROUTER_TOOLS});
  count(malformedRequests===2 && fixed.output[0].phase==='final','plain text repaired to valid JSON');

  assert.throws(()=>normalizeGeminiTextReply({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({chatmcp_action:'tool',name:'non_allowlisted',arguments:{}})}]}}]},ROUTER_TOOLS), e=>e.retryable!==true);
  assertions++;

  const hugeNames=Array.from({length:500},(_,n)=>`- example_tool_${n}`).join('\n');
  const envelope=geminiTextEnvelope([{role:'user',content:[{text:'Work'}]}],`Safe instructions\nCOMPLETE TOOL NAME LIST\n${hugeNames}\nAUTOMATIC PROJECT CHECK DISCOVERY: pytest -q`,ROUTER_TOOLS);
  count(!JSON.stringify(envelope).includes('example_tool_499'),'redundant inventory stripped');
  count(JSON.stringify(envelope).includes('AUTOMATIC PROJECT CHECK DISCOVERY'),'automatic project hints preserved');
  count(Object.keys(envelope).join(',')==='contents','only minimal contents sent');
  console.log(`PASS ${assertions} checks: real agent execution after MAX_TOKENS, no MCP replay, retries bounded, safety stop, malformed JSON recovery, concise prompt, no leaked key`);
}finally{await fs.rm(root,{recursive:true,force:true})}
