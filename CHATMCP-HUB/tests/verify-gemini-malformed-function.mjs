import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { AgentRunner, ROUTER_TOOLS } from '../lib/agent.mjs';
import { geminiTextEnvelope, normalizeGeminiTextReply } from '../lib/gemini-compat.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-malformed-225-'));
const workspace = path.join(root, 'workspace');
await fs.mkdir(workspace);
const secret = 'TEST_ONLY_NO_REAL_KEY';
const malformed = () => ({candidates:[{finishReason:'MALFORMED_FUNCTION_CALL',content:{parts:[]}}],usageMetadata:{promptTokenCount:1670,candidatesTokenCount:50,thoughtsTokenCount:76}});
const completed = action => ({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(action)}]}}]});
const res = (status, body) => ({status,ok:status<400,async text(){return JSON.stringify(body)}});
let toolCalls=0, requests=0, nativeRejects=0, repairRequests=0;
const manager={secrets:[],locked:false,
  state(){return {workspace:{path:workspace},generation:1,instanceId:'malformed-fixture',services:{desktop:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'}}};},
  acquireTask(){if(this.locked) return false; this.locked=true; return true;},
  releaseTask(){this.locked=false;},
  async createAgentSession(){return {catalog:{tools:[{name:'desktop-commander.list_directory',inputSchema:{type:'object',properties:{path:{type:'string'}}}}],prompts:[],resources:[],resourceTemplates:[],servers:{}},
    async callTool(name,args){assert.equal(name,'desktop-commander.list_directory');assert.equal(args.path,workspace);toolCalls++;return {content:[{type:'text',text:'[FILE] README.md'}]};},async close(){}};}
};
const makeProvider = (dir, impl) => new GatewayProvider({directory:path.join(root,dir),bundleRoot:root,manager,env:{},fetchImpl:impl});
const poll = async (engine,id) => {for(let i=0;i<500;i++){const t=engine.get(id);if(t.status!=='running')return t;await new Promise(r=>setTimeout(r,15));}throw Error('timed out');};
try {
  const p=makeProvider('success',async (url,opts)=>{
    // AgentRunner shows the text, so the first request of a run goes to the stream twin of the route (:streamGenerateContent?alt=sse): the same gateway and model.
    assert.equal(url.replace(':streamGenerateContent?alt=sse',':generateContent'),'https://example.invalid/v1beta/models/gemini-fixture:generateContent');
    assert.equal(opts.headers['x-goog-api-key'],secret);
    const body=JSON.parse(opts.body);
    if (Object.keys(body).join(',')!=='contents') {nativeRejects++; return res(400,{error:{message:'Unsupported request fields'}});}
    assert.equal(body.contents.length,1,'single user transcript, not simulated function-call roles');
    assert.equal(body.contents[0].role,'user');
    assert.equal(body.contents[0].parts.length,1);
    assert.ok(!('tools' in body) && !('toolConfig' in body) && !('generationConfig' in body),'no unsupported model function calling fields');
    assert.ok(!body.contents[0].parts[0].functionCall,'no native functionCall in text-only payload');
    requests++;
    if(requests===1) return res(200,malformed());
    if(requests===2) {
      assert.match(opts.body,/PLAIN TEXT RECOVERY 1\/2/);
      assert.match(opts.body,/MALFORMED_FUNCTION_CALL/);
      repairRequests++;
      return res(200,completed({chatmcp_action:'tool',name:'mcp_call',arguments:{name:'desktop-commander.list_directory',arguments_json:JSON.stringify({path:workspace})}}));
    }
    assert.match(opts.body,/\[FILE\] README\.md/,'real tool output is present next turn');
    return res(200,completed({chatmcp_action:'final',text:'Đã kiểm tra thư mục'}));
  });
  await p.load();await p.configure({apiBaseUrl:'https://example.invalid',model:'gemini-fixture',protocol:'gemini',authMode:'google-key',apiKey:secret});
  const agent=new AgentRunner({manager,provider:p,taskDirectory:path.join(root,'tasks')});await agent.load();
  const id=(await agent.start({prompt:'Đọc workspace'})).id;
  const task=await poll(agent,id);
  assert.equal(task.status,'completed',task.error);
  assert.equal(toolCalls,1,'MCP action must execute only once despite generation retry');
  assert.equal(task.toolCalls,1);
  assert.equal(nativeRejects,3);
  assert.equal(requests,3);
  assert.equal(repairRequests,1);
  assert.ok(task.events.some(e=>e.type==='model_repair' && /MALFORMED_FUNCTION_CALL/.test(e.message||'')));
  assert.ok(!JSON.stringify(task).includes(secret),'never put API key in task history');
  await agent.shutdown();
  // A permanently malformed model/gateway must fail closed after two model-only retries.
  let persistentRequests=0;
  const broken=makeProvider('broken',async()=>{persistentRequests++;return res(200,malformed());});
  await broken.load();await broken.configure({apiBaseUrl:'https://example.invalid',model:'gemini-fixture',protocol:'gemini',apiKey:secret});
  broken.geminiDialect='text-protocol';broken.dialectConfirmed=true;
  await assert.rejects(broken.respond({input:[{role:'user',content:[{text:'Hello'}]}],instructions:'Safety first',tools:ROUTER_TOOLS}), e=> {
    assert.equal(e.code,'gateway_text_malformed_function');
    assert.equal(e.finishReason,'MALFORMED_FUNCTION_CALL');
    assert.match(e.message,/1670/);
    assert.match(e.message,/output=50/);
    assert.match(e.message,/thinking=76/);
    assert.match(e.message,/2 lần/);
    return true;
  });
  assert.equal(persistentRequests,3,'no infinite requests or tool execution');
  assert.equal(toolCalls,1,'the failing second task must not execute any MCP call');
  const envelope=geminiTextEnvelope([{role:'user',content:[{text:'inspect code'}]}],
    'TOOL USE\nNative stuff\nCODING WORKFLOW\nCheck tests\nCOMPLETE TOOL NAME LIST\n- huge_name\n', ROUTER_TOOLS);
  assert.deepEqual(Object.keys(envelope),['contents']);
  assert.equal(envelope.contents.length,1);
  assert.ok(!JSON.stringify(envelope).includes('huge_name'));
  assert.match(JSON.stringify(envelope),/PLAIN TEXT ONLY/);
  assert.throws(()=>normalizeGeminiTextReply({candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:'mcp_call',args:{name:'rm'}}}]}}]},ROUTER_TOOLS), e=>e.code==='gateway_text_protocol_invalid' && e.retryable===true);
  console.log('PASS MALFORMED_FUNCTION_CALL: 200 response, model-only recovery, literal-JSON single turn, one MCP call, retry cap, strict fail-closed, key redaction');
}finally { await fs.rm(root,{recursive:true,force:true}); }
