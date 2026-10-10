import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AgentRunner, ROUTER_TOOLS } from '../lib/agent.mjs';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { geminiTextEnvelope } from '../lib/gemini-compat.mjs';

const results=[];
const fakeDoc=(tag,n=48000)=> `${tag}\n` + ('RUBRIC | Training backbone, test-once-per-seed, keep log.\n'.repeat(Math.ceil(n/55)));
const history=[{role:'user',content:[{text:'Read the guide, rubric and source files; finish task, preserving existing changes.'}]}];
for(let i=0;i<9;i++) {
  history.push({type:'function_call',name:'mcp_call',call_id:`call-${i}`,arguments:JSON.stringify({name:'desktop-commander.read_file',arguments_json:JSON.stringify({path:`C:\\lab\\file${i}.md`})})});
  history.push({type:'function_call_output',call_id:`call-${i}`,output:JSON.stringify({content:[{type:'text',text:fakeDoc(`file-${i}`)}]})});
}
const budgets=[96,64,32].map(kb=>kb*1024);
const payloads=budgets.map(maxRequestBytes=>geminiTextEnvelope(history,'Read project files. Use MCP only with precise schemas, do not repeat writes.',ROUTER_TOOLS,{maxRequestBytes}));
const bytes=payloads.map(p=>Buffer.byteLength(JSON.stringify(p),'utf8'));
assert.ok(bytes.every((b,i)=>b<=budgets[i]),`wire body must fit requested budgets: ${bytes}`);
assert.ok(bytes[0]<128*1024);
assert.ok(bytes[2]<bytes[0],`smaller cap must compact further: ${bytes}`);
for(let i=0;i<payloads.length;i++){
  assert.deepEqual(Object.keys(payloads[i]),['contents']);
  const prompt=payloads[i].contents[0].parts[0].text;
  assert.match(prompt,/CONTEXT COMPACTION/);
  assert.match(prompt,/Partial excerpts are NOT evidence/);
  assert.match(prompt,/file-8/,'last tool output retained');
  assert.match(prompt,/OUTPUT CONTRACT FOR THIS TURN/);
}
assert.ok(JSON.stringify(history).includes('file-0'),'original transcript remains full in memory');
assert.ok(JSON.stringify(history).includes('file-8'));

const tinyRepair='SCHEMA RECOVERY 1/2: Return a chatmcp_action tool or final JSON.';
const repaired=geminiTextEnvelope(history,'Follow project safety',ROUTER_TOOLS,{maxRequestBytes:32*1024,repairHint:tinyRepair});
assert.ok(Buffer.byteLength(JSON.stringify(repaired))<=32*1024,'repair text also must fit byte budget');
assert.ok(repaired.contents[0].parts[0].text.endsWith(tinyRepair));
// Multi-byte UTF-8 and JSON escaping must be measured AFTER serializing request.
const hugeVietnamese=[{role:'user',content:[{text:'Tiếng Việt 🌿\\\n'.repeat(30000)}]}];
const vi=geminiTextEnvelope(hugeVietnamese,'Không sửa dữ liệu bừa bãi.',ROUTER_TOOLS,{maxRequestBytes:32*1024});
assert.ok(Buffer.byteLength(JSON.stringify(vi))<=32*1024);
assert.match(vi.contents[0].parts[0].text,/CONTEXT COMPACTION/);
results.push('provider-side UTF-8 byte compaction 96/64/32 KiB, local history intact, reply hint within budget');

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-413-227-'));
try{
  const workspace=path.join(tmp,'workspace');await fs.mkdir(workspace);
  const apiKey='KEY_NOT_EXPORTED_227';
  const toolDocs=Array.from({length:7},(_,i)=>fakeDoc(`DOCUMENT ${i}: ${i===6?'RUBRIC FINAL': 'GUIDE'}`,65000));
  let successfulModels=0, toolCalls=0, http413Count=0;
  const outboundSizes=[];
  const mockResponse = (status,body) => ({status,ok:status>=200 && status<300,
    async text(){return JSON.stringify(body);}});
  const answer=action=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(action)}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:40}});
  const manager={
    secrets:[],busy:false,
    state(){return {workspace:{path:workspace},generation:1,instanceId:'413-e2e',services:{desktop:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'}}};},
    acquireTask(){if(this.busy)return false;this.busy=true;return true;},
    releaseTask(){this.busy=false;},
    async createAgentSession(){return {
      catalog:{tools:[{name:'desktop-commander.read_file',description:'Read file',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}}],prompts:[],resources:[],resourceTemplates:[],servers:{}},
      async callTool(name,args){
        assert.equal(name,'desktop-commander.read_file');
        assert.equal(args.path,path.join(workspace,`file${toolCalls}.md`));
        const data=toolDocs[toolCalls];toolCalls++;
        return {content:[{type:'text',text:data}]};
      },async close(){}
    };}
  };
  const provider=new GatewayProvider({directory:path.join(tmp,'gateway'),bundleRoot:tmp,manager,env:{},fetchImpl:async (url,opts)=>{
    assert.match(url,/^https:\/\/test-gateway\.invalid/);
    assert.equal(opts.headers['x-goog-api-key'],apiKey);
    const body=JSON.parse(opts.body);
    assert.deepEqual(Object.keys(body),['contents'],'minimal gateway only accepts contents');
    const wire=Buffer.byteLength(opts.body,'utf8'); outboundSizes.push(wire);
    if(wire>128*1024) throw Error('BUG: oversized request was transmitted');
    // Force 413 after multiple tool results, to verify the *model-only* retry.
    if(successfulModels===7 && wire>31000){
      http413Count++;
      // First rejection is a plain-text proxy error, the second is JSON.
      return http413Count===1 ? {status:413,ok:false,async text(){return 'Request body exceeds 128 KiB';}}
        : mockResponse(413,{error:{message:'Request body exceeds gateway cap'}});
    }
    const prompt=body.contents[0].parts[0].text;
    assert.match(prompt,/OUTPUT CONTRACT FOR THIS TURN/);
    successfulModels++;
    if(successfulModels<=7){
      return mockResponse(200,answer({chatmcp_action:'tool',name:'mcp_call',arguments:{name:'desktop-commander.read_file',arguments_json:JSON.stringify({path:path.join(workspace,`file${successfulModels-1}.md`)})}}));
    }
    assert.match(prompt,/DOCUMENT 6:/);
    return mockResponse(200,answer({chatmcp_action:'final',text:'Đã kiểm tra 7 tài liệu ở bản ghi địa phương; kết quả cần tiếp tục xác thực.'}));
  }});
  await provider.load(); await provider.configure({apiBaseUrl:'https://test-gateway.invalid',protocol:'gemini',model:'test-gemini',authMode:'google-key',apiKey});
  provider.geminiDialect='text-protocol';provider.dialectConfirmed=true;
  const agent=new AgentRunner({manager,provider,taskDirectory:path.join(tmp,'tasks')});await agent.load();
  const taskId=(await agent.start({prompt:'Read seven files and summarize.'})).id;
  let task;
  for(let i=0;i<400;i++){task=agent.get(taskId);if(task.status!=='running')break; await new Promise(r=>setTimeout(r,15));}
  assert.equal(task.status,'completed',task.error);
  assert.equal(toolCalls,7,'seven actual MCP reads (no tool replay during 413 fallback)');
  assert.equal(task.toolCalls,7);
  assert.equal(successfulModels,8);
  assert.ok(http413Count>=1,'gateway must reject at least one oversized model request');
  assert.ok(outboundSizes.at(-1)<31000,'after 413 the next model-only request must shrink');
  assert.ok(!JSON.stringify(task).includes(apiKey));
  assert.ok(task.events.some(e=>/HTTP 413/.test(e.message)),'timeline reports compaction');
  // Full evidence persists locally, regardless of the compacted model input.
  const journal=(await fs.readdir(path.join(tmp,'tasks'),{recursive:true})).filter(n=>n.endsWith('.jsonl'));
  let persisted='';
  const readAll=async dir=>{for(const ent of await fs.readdir(dir,{withFileTypes:true})){const location=path.join(dir,ent.name);if(ent.isDirectory())await readAll(location);else if(ent.name.endsWith('.jsonl')) persisted+=(await fs.readFile(location,'utf8'));}};
  await readAll(path.join(tmp,'tasks'));
  assert.ok(persisted.includes('DOCUMENT 0:'),'earliest full result persisted');
  assert.ok(persisted.includes('RUBRIC FINAL'),'latest full result persisted');
  const logged= persisted.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(entry=>entry?.type==='tool_result_full');
  assert.equal(logged.length,7,'one full journal entry per MCP call');
  assert.equal(logged[0].result.content[0].text,toolDocs[0],'full untruncated result remains on disk');
  await agent.shutdown();
  results.push(`e2e: 7 MCP reads, 8 successful model turns, ${http413Count} simulated HTTP 413 retries, local full-result journal retained`);
}finally{await fs.rm(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:60});}
for(const x of results)console.log('PASS',x);
