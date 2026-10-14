// Includes the owner's focused compaction suite and checks actual AgentRunner
// wiring. The canonical transcript and newest receipts must never be lost.
import './context-compaction.test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { compactConversationHistory } from '../lib/context-compaction.mjs';

const big='output: '+('abcdefghijklmno'.repeat(950));
const sameCall={type:'function_call',call_id:'a',name:'git_status',arguments:'{}'};
const differing=[
  {role:'user',content:[{type:'input_text',text:'Check status'}]},
  sameCall,
  {type:'function_call_output',call_id:'a',output:big+' first'},
  {...sameCall,call_id:'b'},
  {type:'function_call_output',call_id:'b',output:big+' changed'},
];
const differ=compactConversationHistory(differing,{maxHistoryTokens:500,preserveRecentOutputs:1});
assert.equal(differ.stats.deduplicatedCount,0,
  'identical command args but changed Git output must NOT be deduplicated');
assert.equal(differing[4].output,big+' changed','latest receipt must be preserved');
assert.deepEqual(differing.filter(x=>x.type==='function_call_output').map(x=>x.call_id),['a','b']);

const image=[{type:'input_text',text:'Image inspection'},{type:'input_image',image_url:'data:image/png;base64,AA=='}];
const multimodal=[
  {type:'function_call',call_id:'i',name:'read_file',arguments:'{}'},
  {type:'function_call_output',call_id:'i',output:image},
  {type:'function_call',call_id:'s',name:'read_file',arguments:'{"path":"other"}'},
  {type:'function_call_output',call_id:'s',output:big},
];
compactConversationHistory(multimodal,{maxHistoryTokens:100,preserveRecentOutputs:0});
assert.deepEqual(multimodal[1].output,image,'multimodal arrays must never be converted to plain text');

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-context-wiring-'));
try{
  await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'src','core.mjs'),'export function startTask(){ return 1; }\n');
  let locked=false,steps=0,sawMap=false,sawCompact=false;
  const prompt='Inspect src/core.mjs and report the available function.';
  const manager={
    backend:'local',workspace:root,generation:1,instanceId:'smart-context-test',secrets:[],
    state(){return {workspace:{path:root},generation:1,instanceId:'smart-context-test'};},
    acquireTask(){if(locked)return false;locked=true;return true;},
    releaseTask(){locked=false;},
    async createAgentSession(){return {
      catalog:{tools:[{name:'local.read_file',originalName:'read_file',server:'local',
        inputSchema:{type:'object',properties:{path:{type:'string'}}}}],
        prompts:[],resources:[],resourceTemplates:[],servers:{}},
      async close(){},
      async callTool(name){
        assert.equal(name,'local.read_file');
        return {isError:false,content:[{type:'text',text:big}],structuredContent:{notVerified:true}};
      },
    };},
  };
  manager.studio=new StudioWorkspace({manager,directory:path.join(root,'state')});
  const provider={
    ready:()=>true,snapshot:()=>({provider:'fixture',model:'fixture'}),
    async respond({input}){
      steps++;
      const user=input.find(x=>x.role==='user');
      if(steps===1){
        assert.equal(user?.content?.[0]?.text,prompt);
        assert.ok(user.content[1].text.includes('WORKSPACE REPO MAP (AUTO-GENERATED)'));
        assert.ok(user.content[1].text.includes('src/core.mjs'));
        sawMap=true;
      }
      const received=input.filter(x=>x.type==='function_call_output');
      assert.equal(received.length,steps-1,'all call_id receipts remain paired in the provider request');
      if(steps>9){
        if(received[0].output.length < big.length)sawCompact=true;
        assert.equal(received.at(-1).output.includes(big.slice(0,90)),true,
          'newest tool output must remain available to model');
      }
      if(steps<=12)return {status:'completed',output:[{
        type:'function_call',call_id:'call-'+steps,name:'read_file',status:'completed',
        arguments:JSON.stringify({path:'src/'+steps+'.mjs'}),
      }]};
      return {status:'completed',output:[{type:'message',role:'assistant',phase:'final',
        content:[{type:'output_text',text:'Inspected, no edit requested.'}]}]};
    },
  };
  const runner=new AgentRunner({manager,provider,taskDirectory:path.join(root,'tasks')});
  await runner.load();
  const started=await runner.start({prompt,maxSteps:20});
  const finish=await Promise.race([runner.context.done.promise,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('smart context integration timed out')),15000))]);
  assert.equal(finish.status,'completed',finish.error);
  assert.equal(sawMap,true);
  assert.equal(sawCompact,true,'long history must compact a COPY before model request');
  assert.ok(finish.events.some(e=>e.type==='repo_map_injected'));
  assert.ok(finish.events.some(e=>e.type==='context_compaction'));
  const log=await fs.readFile(path.join(root,'tasks',started.id,'transcript.jsonl'),'utf8');
  assert.ok(log.includes(big.slice(100,180)),'full original tool output stays in durable transcript');
  await runner.shutdown();
  console.log('PASS Smart Context Compaction wired to AgentRunner, safe Repo Map, paired call IDs, durable full transcript');
}finally{await fs.rm(root,{recursive:true,force:true});}
