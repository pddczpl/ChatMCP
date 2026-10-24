import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GatewayProvider, validateBaseUrl, buildEndpoint, asGeminiContents, asChatMessages, normalizeGemini, normalizeChatCompletion } from '../lib/gateway-provider.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { DualAgent } from '../lib/dual-agent.mjs';
import { createHubServer } from '../hub.mjs';

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-agent-test-'));
let passes = 0;
function ok(value, label) { assert.ok(value, label); passes++; }
function equal(actual, expected, label) { assert.deepEqual(actual, expected, label); passes++; }
try {
  equal(validateBaseUrl('https://gateway.example.net/'), 'https://gateway.example.net', 'strip trailing slash');
  equal(buildEndpoint('https://gateway.example.net', 'gemini', 'gemini-3.8-flash'), 'https://gateway.example.net/v1beta/models/gemini-3.8-flash:generateContent');
  equal(buildEndpoint('https://gateway.example.net/v1beta/', 'gemini', 'gemini-3.8-flash'), 'https://gateway.example.net/v1beta/models/gemini-3.8-flash:generateContent');
  // A version in the address is the version, whatever its number (Z.ai ends in /v4): "/v1" is appended only when there is none.
  equal(buildEndpoint('https://api.z.ai/api/paas/v4', 'openai-chat', 'glm-5.3'), 'https://api.z.ai/api/paas/v4/chat/completions');
  equal(buildEndpoint('https://api.z.ai/api/paas/v4/', 'openai-responses', 'glm-5.3'), 'https://api.z.ai/api/paas/v4/responses');
  equal(buildEndpoint('https://gateway.example.net/v10', 'openai-chat', 'm'), 'https://gateway.example.net/v10/chat/completions');
  equal(buildEndpoint('https://gateway.example.net/rev2', 'openai-chat', 'm'), 'https://gateway.example.net/rev2/v1/chat/completions', 'a segment that only ends in a number is not a version');
  equal(buildEndpoint('https://gateway.example.net/v1beta', 'openai-chat', 'm'), 'https://gateway.example.net/v1beta/v1/chat/completions', 'nor is a version with a word after it');
  equal(buildEndpoint('https://gateway.example.net/v1', 'openai-chat', 'gemini-3.8-flash'), 'https://gateway.example.net/v1/chat/completions');
  assert.throws(()=>buildEndpoint('https://gateway.example.net','gemini','demo','//evil.example/path')); passes++;
  for (const url of ['http://host.example.net','http://127.0.0.2:9000','https://username:pass@example.com','https://example.com/?key=abc']) {
    assert.throws(() => validateBaseUrl(url)); passes++;
  }
  const provider = new GatewayProvider({ directory: path.join(base,'gateway'), bundleRoot: path.dirname(base), manager: { secrets: [] }, env: {}, protect: async s => 'fake-cipher-' + Buffer.from(s).toString('base64'), unprotect: async s => Buffer.from(s.slice(12), 'base64').toString() });
  await provider.load();
  equal(provider.ready(), false);
  const key = 'mock-only-not-a-real-api-key';
  await provider.configure({protocol:'gemini',apiBaseUrl:'https://gateway.example.net',model:'gemini-3.8-flash',apiKey:key,remember:true});
  equal(provider.ready(),true);
  equal(provider.state().keySource,'saved');
  ok(!JSON.stringify(provider.state()).includes(key),'state hides key');
  const configuration = await fs.readFile(path.join(base,'gateway','gateway-config.json'),'utf8');
  ok(!configuration.includes(key),'configuration hides key');
  const encrypted = await fs.readFile(path.join(base,'gateway','gateway-key.dpapi'),'utf8');
  ok(!encrypted.includes(key),'keyfile ciphertext only');
  const restored = new GatewayProvider({ directory: path.join(base,'gateway'), bundleRoot: path.dirname(base), manager: { secrets: [] }, env: {}, unprotect: async s => Buffer.from(s.slice(12),'base64').toString() });
  await restored.load();
  equal(restored.state().keySource,'saved');
  equal(restored.ready(),true);
  ok(!provider.redact(key + ' hi').includes(key),'redaction');
  await provider.configure({ remember: false });
  equal(provider.state().keySource, 'session');
  await assert.rejects(fs.stat(path.join(base,'gateway','gateway-key.dpapi')), {code:'ENOENT'}); passes++;
  const toolOutput = {type:'function_call_output',call_id:'call-1',output:'{"success":true}'};
  const history = [{role:'user',content:[{type:'input_text',text:'Inspect files'}]},{type:'function_call',name:'mcp_call',call_id:'call-1',arguments:'{"name":"demo","arguments_json":"{}"}'},toolOutput];
  const contents = asGeminiContents(history);
  equal(contents.map(c=>c.role),['user','model','user']);
  equal(contents[2].parts[0].functionResponse.name,'mcp_call');
  const idHistory = structuredClone(history);
  idHistory[1].providerCallId = 'gemini-call-42';
  equal(asGeminiContents(idHistory)[2].parts[0].functionResponse.id, 'gemini-call-42', 'Gemini function response retains original provider ID');
  const messages = asChatMessages(history, 'system');
  equal(messages.map(c=>c.role),['system','user','assistant','tool']);
  equal(messages[2].tool_calls[0].id,'call-1');
  equal(normalizeGemini({candidates:[{content:{parts:[{text:'done'}]},finishReason:'STOP'}]}).output[0].phase,'final');
  equal(normalizeChatCompletion({choices:[{finish_reason:'stop',message:{content:'done'}}]}).output[0].phase,'final');
  assert.throws(()=>normalizeGemini({candidates:[{content:{parts:[{text:'partial'}]},finishReason:'MAX_TOKENS'}]})); passes++;

  const manager = {
    secrets: [],
    locked: false,
    state: () => ({workspace:{path:'C:\\MockWorkspace'},generation:1,instanceId:'unit',services:{desktop:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'},docker:{state:'ready'}}}),
    acquireTask() { if (this.locked) return false; this.locked=true; return true; },
    releaseTask() { this.locked=false; },
    async createAgentSession() {return { catalog:{tools:[{name:'desktop-commander.list_directory',description:'list local files',server:'desktop-commander',inputSchema:{type:'object'}}],prompts:[],resources:[],resourceTemplates:[],servers:{}}, async callTool(name,args) { assert.equal(name,'desktop-commander.list_directory'); return {content:[{type:'text',text:'[FILE] README.md'}]}; }, async close(){}}},
  };
  let requestNumber = 0, seenResult = false;
  const dummyFetcher = async (url, opts) => {
    equal(url, 'https://gateway.example.net/v1beta/models/gemini-3.8-flash:generateContent');
    equal(opts.headers['x-goog-api-key'], key);
    const body = JSON.parse(opts.body);
    requestNumber++;
    if (requestNumber === 1) {
      equal(body.tools[0].functionDeclarations.length,4);
      equal(body.contents[0].parts[0].text,'Liệt kê file.');
      return {ok:true,status:200,async text(){return JSON.stringify({candidates:[{content:{parts:[{text:'Đang xem tên công cụ trong workspace.'},{functionCall:{name:'mcp_call',id:'gemini-remote-call-1',args:{name:'desktop-commander.list_directory',arguments_json:'{}'}},thoughtSignature:'opaque-signature-fixture'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:25}})}};
    }
    seenResult = JSON.stringify(body.contents).includes('README.md');
    equal(body.contents[1].parts.find(p=>p.functionCall)?.thoughtSignature, 'opaque-signature-fixture', 'Gemini tool-call signature round-trip');
    equal(body.contents[2].parts.find(p=>p.functionResponse)?.functionResponse?.id, 'gemini-remote-call-1', 'Gemini function-call response ID round-trip');
    return {ok:true,status:200,async text(){return JSON.stringify({candidates:[{content:{parts:[{text:'Đã thấy README.md. Chưa sửa file.'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:26,candidatesTokenCount:14}})}};
  };
  const engineProvider = new GatewayProvider({directory:path.join(base,'mock-model'),bundleRoot:base,manager,env:{},fetchImpl:dummyFetcher});
  await engineProvider.load();
  await engineProvider.configure({protocol:'gemini',apiBaseUrl:'https://gateway.example.net',model:'gemini-3.8-flash',apiKey:key});
  let chatCall=0;
  const openaiGateway = new GatewayProvider({directory:path.join(base,'openai-chat'),bundleRoot:base,manager,env:{},fetchImpl:async(url,opt)=>{
    equal(url,'https://gateway.example.net/v1/chat/completions');
    equal(opt.headers.Authorization,`Bearer ${key}`);
    const data=JSON.parse(opt.body);
    chatCall++;
    if (chatCall===1) {
      equal(data.messages[0].role,'system');
      equal(data.tools[0].function.name,'mcp_call');
      return {ok:true,status:200,async text(){return JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:'Đang tìm file.',tool_calls:[{id:'chatcall1',type:'function',function:{name:'mcp_catalog',arguments:'{"filter":null,"offset":0,"limit":10}'}}]}}]})}};
    }
    equal(data.messages.at(-1).role,'tool');
    return {ok:true,status:200,async text(){return JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Đã nhận danh sách công cụ.'}}]})}};
  }});
  await openaiGateway.load();
  await openaiGateway.configure({protocol:'openai-chat',apiBaseUrl:'https://gateway.example.net/v1',model:'gemini-3.8-flash',apiKey:key});
  const firstChat = await openaiGateway.respond({input:[{role:'user',content:[{type:'input_text',text:'Danh sách'}]}],instructions:'test',tools:[{name:'mcp_call',description:'call',parameters:{type:'object'}}]});
  equal(firstChat.output.some(x=>x.type==='function_call'),true);
  const secondChat = await openaiGateway.respond({input:[{role:'user',content:[{type:'input_text',text:'Danh sách'}]},...firstChat.output,{type:'function_call_output',call_id:'chatcall1',output:'{"tools":[]}'}],instructions:'test',tools:[{name:'mcp_call',description:'call',parameters:{type:'object'}}]});
  equal(secondChat.output[0].content[0].text,'Đã nhận danh sách công cụ.');
  // A dropped model response must retry only the model call, never an already
  // committed MCP side effect. This is a short integration retry fixture.
  let lost=0, waited=0;
  const recovering = new GatewayProvider({directory:path.join(base,'recover'),bundleRoot:base,manager,env:{},fetchImpl: async()=>{
    lost++;
    if (lost===1) throw new TypeError('offline');
    return {ok:true,status:200,async text(){return JSON.stringify({candidates:[{content:{parts:[{text:'Recovered'}]},finishReason:'STOP'}]})}};
  }});
  await recovering.load();
  await recovering.configure({protocol:'gemini',apiBaseUrl:'https://gateway.example.net',model:'gemini-3.8-flash',apiKey:key});
  const recovered = await recovering.respond({input:[{role:'user',content:[{type:'input_text',text:'Ping'}]}],instructions:'Reply.',tools:[],onStatus:async()=>{waited++}});
  equal(recovered.output[0].content[0].text,'Recovered');
  equal(lost,2);
  equal(waited,2);
  const engine = new AgentRunner({manager,provider:engineProvider,taskDirectory:path.join(base,'api-tasks')});
  await engine.load();
  const task = await engine.start({prompt:'Liệt kê file.',maxSteps:5,maxMinutes:1});
  let result;
  for(let i=0;i<500;i++) {
    result = engine.get(task.id);
    if (result.status!=='running') break;
    await new Promise(r=>setTimeout(r,20));
  }
  equal(result.status, 'completed');
  equal(result.steps,2);
  equal(result.toolCalls,1);
  ok(seenResult, 'Gemini received real MCP result');
  ok(result.events.some(e=>e.type==='assistant' && e.message.includes('Đang xem')),'progress note displayed');
  ok(result.events.some(e=>e.type==='tool_start' && e.message.includes('desktop-commander')),'tool call visible');
  equal(result.finalText,'Đã thấy README.md. Chưa sửa file.');
  const report = await engine.report(task.id);
  ok(report.includes('README.md'),'report');
  ok(!report.includes(key),'report has no API key');
  const driver = new DualAgent({ browser: {state:()=>({tasks:[{id:'web-historic',startedAt:'2000-01-01',status:'completed',prompt:'past'}],active:null}),get:(id)=> id==='web-historic'?{id,status:'completed'}:null, report:async()=> 'web report',start:async()=>({id:'web-task'}),cancel:async()=>({}),shutdown:async()=>{}}, api:engine,directory:base });
  await driver.load();
  equal(driver.mode,'chatgpt-web');
  // The thinking effort of a task is a Model API setting: through the ChatGPT Web Companion it is refused, not dropped without a word.
  {
    const manager=engine.manager, kept=manager.workspace;
    manager.workspace=base;
    try {
      await assert.rejects(() => driver.start({prompt:'p',reasoningEffort:'high'}),error=>error.statusCode===400&&/thinking effort/i.test(error.message)&&/Companion/.test(error.message)); passes++;
    } finally { manager.workspace=kept; }
  }
  await driver.configure({mode:'api'});
  equal(driver.state().mode,'api');
  ok(driver.state().tasks.some(t=>t.transport==='api'),'merged task history');
  equal(driver.get(task.id).transport,'api');
  equal(driver.get('web-historic').transport,'chatgpt-web');
  ok((await driver.report(task.id)).includes('README.md'),'api report dispatch');
  const reload = new DualAgent({browser:driver.browser,api:engine,directory:base});
  await reload.load();
  equal(reload.mode,'api');
  await engine.shutdown();
  process.stdout.write(`PASS: ${passes} assertions; Gemini 2-turn agent/MCP real loop via mocked HTTP, DPAPI fixture, two-mode routing.\n`);
} finally { await fs.rm(base,{recursive:true,force:true}); }
