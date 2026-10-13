import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner, ROUTER_TOOLS, createAgentInstructions, createLocalAgentInstructions, directToolsFor } from '../lib/agent.mjs';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { geminiTextEnvelope, normalizeGeminiTextReply } from '../lib/gemini-compat.mjs';

const catalog = {
  tools: [{ server:'local', originalName:'read_file', name:'local.read_file', description:'Read a project file',
    inputSchema:{type:'object', properties:{path:{type:'string'}}, required:['path']} }],
  prompts:[], resources:[], resourceTemplates:[], servers:{},
};
const tools = [...ROUTER_TOOLS, ...directToolsFor(catalog).functions];
const workspace = {path:'C:\\fixture'};
const wrap = text => ({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]});
const envelopeText = (history, instructions, availableTools = tools) =>
  geminiTextEnvelope(history, instructions, availableTools).contents[0].parts[0].text;

test('a turn with no tools requests only a final action', () => {
  const prompt = envelopeText([{role:'user',content:'Summarize the supplied facts'}], 'Use supplied evidence only', []);
  assert.doesNotMatch(prompt, /mcp_catalog|mcp_call|"chatmcp_action":"tool"/);
  assert.match(prompt, /No tool actions are available/);
  assert.match(prompt, /"chatmcp_action":"final"/);
});

for (const [kind, instructions] of [
  ['legacy', createAgentInstructions(catalog, workspace)],
  ['local', createLocalAgentInstructions(catalog, workspace)],
]) {
  // A regression here sends mutually exclusive instructions to the model:
  // free-standing commentary before a tool call versus one JSON object only.
  test(`${kind} instructions place progress inside the JSON action`, () => {
    const prompt = envelopeText([{role:'user', content:'Read README.md'}], instructions);
    assert.doesNotMatch(prompt, /Before (?:a|each) tool call(?:, provide| write)/);
    assert.match(prompt, /progress[^\n]*inside[^\n]*JSON/i);
    assert.doesNotMatch(prompt, /You call these directly/);
    assert.doesNotMatch(prompt, /four approved MCP router names/);
    assert.match(prompt, /"name":"read_file"/);
    // Rewriting the transport instructions must preserve project and safety rules.
    assert.match(prompt, /Read.*README/);
    assert.match(prompt, /untrusted DATA|untrusted task data/);
    assert.match(prompt, /(?:unknown|ambigui)[^\n]*|[^\n]*(?:unknown|ambigui)/i);
    assert.match(prompt, /(?:Do not bypass an approval|do not retry the same action)/);
  });
}

test('historical tool examples retain the complete parseable action contract', () => {
  const prompt = envelopeText([
    {role:'user', content:'Read a file'},
    {type:'message',role:'assistant',phase:'commentary',content:[{text:'Đang đọc README.md.'}]},
    {type:'function_call',call_id:'direct',name:'read_file',arguments:'{"path":"README.md"}'},
    {type:'function_call_output',call_id:'direct',output:'Verified file content'},
    {type:'function_call',call_id:'router',name:'mcp_call',arguments:{name:'local.read_file',arguments_json:'{"path":"GUIDE.md"}'}},
    {type:'message',role:'assistant',phase:'final',content:[{text:'Đã đọc file.'}]},
  ], 'Preserve safety rules');
  const records = [...prompt.matchAll(/^PREVIOUS JSON TOOL ACTION: (.*)$/gm)].map((match) => JSON.parse(match[1]));
  assert.deepEqual(records, [
    {chatmcp_action:'tool', name:'read_file', arguments:{path:'README.md'}},
    {chatmcp_action:'tool', name:'mcp_call', arguments:{name:'local.read_file',arguments_json:'{"path":"GUIDE.md"}'}},
  ]);
  for (const record of records) {
    const normalized = normalizeGeminiTextReply(wrap(JSON.stringify(record)), tools);
    assert.equal(normalized.output.at(-1).name, record.name);
    assert.deepEqual(JSON.parse(normalized.output.at(-1).arguments), record.arguments);
  }
  assert.match(prompt, /PREVIOUS ASSISTANT PROGRESS[^\n]*Đang đọc README.md/);
  assert.match(prompt, /PREVIOUS JSON FINAL ACTION: \{"chatmcp_action":"final","text":"Đã đọc file\."\}/);
  assert.match(prompt, /MCP TOOL RESULT \(for read_file\): Verified file content/);
});

test('invalid historical arguments remain data rather than a valid action example', () => {
  const prompt = envelopeText([{type:'function_call',name:'read_file',call_id:'bad',arguments:'{unfinished'}], 'Safety');
  assert.doesNotMatch(prompt, /PREVIOUS JSON TOOL ACTION/);
  assert.match(prompt, /PREVIOUS TOOL RECORD[^\n]*unfinished/);
});

test('local direct tool survives a model-only repair with progress and no duplicate execution', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-text-contract-'));
  const project = path.join(directory, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'README.md'), 'Verified direct file content');
  let requests = 0, reads = 0, engine;
  const manager = {
    secrets:[], locked:false,
    state(){return {workspace:{path:project},generation:1,instanceId:'text-contract',services:{desktop:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'}}};},
    acquireTask(){if(this.locked)return false;this.locked=true;return true;},
    releaseTask(){this.locked=false;},
    async createAgentSession(){return {catalog,
      async callTool(name,args){
        assert.equal(name,'local.read_file');assert.deepEqual(args,{path:'README.md'});reads++;
        return {content:[{type:'text',text:await fs.readFile(path.join(project,args.path),'utf8')}]};
      },async close(){}};},
  };
  const provider = new GatewayProvider({directory:path.join(directory,'gateway'),bundleRoot:directory,manager,env:{},fetchImpl:async (_url,opts)=>{
    requests++;
    const body = JSON.parse(opts.body);
    assert.deepEqual(Object.keys(body),['contents']);
    const prompt = body.contents[0].parts[0].text;
    assert.doesNotMatch(prompt, /Before each tool call write|four approved MCP router names|You call these directly/);
    let result;
    if(requests===1) {
      result = wrap(JSON.stringify({chatmcp_action:'tool',name:'read_file',arguments:{path:'README.md'},progress:'Đang đọc README.md.'}));
    } else if(requests===2) {
      assert.match(prompt, /Verified direct file content/);
      result = {candidates:[{finishReason:'MALFORMED_FUNCTION_CALL',content:{parts:[]}}]};
    } else if(requests===3) {
      assert.match(prompt, /PLAIN TEXT RECOVERY 1\/2/);
      assert.doesNotMatch(prompt, /with chatmcp_action="tool" and a listed router name/);
      assert.match(prompt, /progress[^\n]*inside[^\n]*JSON/i);
      assert.match(prompt, /Verified direct file content/);
      assert.equal(reads,1,'repair must reuse the completed tool result');
      result = wrap(JSON.stringify({chatmcp_action:'final',text:'Đã đọc README.md: Verified direct file content'}));
    } else throw Error('Unexpected model request');
    return {status:200,ok:true,async text(){return JSON.stringify(result);}};
  }});
  try {
    await provider.load();
    await provider.configure({apiBaseUrl:'https://text-contract.example.invalid',protocol:'gemini',model:'gemini-fixture',apiKey:'TEST_ONLY_NO_REAL_KEY'});
    provider.geminiDialect='text-protocol';provider.dialectConfirmed=true;
    engine = new AgentRunner({manager,provider,taskDirectory:path.join(directory,'tasks')});
    await engine.load();
    const {id} = await engine.start({prompt:'Read README.md and report its contents'});
    let task;
    for(let i=0;i<400;i++) {
      task=engine.get(id);if(task.status!=='running')break;
      await new Promise(resolve=>setTimeout(resolve,15));
    }
    assert.equal(task.status,'completed',task.error);
    assert.equal(task.toolCalls,1);
    assert.equal(reads,1);
    assert.equal(requests,3);
    assert.match(task.finalText,/Verified direct file content/);
    assert.ok(task.events.some(event=>event.type==='assistant' && /Đang đọc README.md/.test(event.message)));
    assert.ok(task.events.some(event=>event.type==='model_repair'));
  } finally {
    await engine?.shutdown();
    await fs.rm(directory,{recursive:true,force:true});
  }
});
