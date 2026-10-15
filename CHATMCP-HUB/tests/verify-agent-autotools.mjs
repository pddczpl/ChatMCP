import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-agent-autotools-'));
let prompts=[];
const manager={
  secrets:[],workspace:root,generation:1,instanceId:'test-agent',locked:false,
  studio:{checks:async()=>({suggested:[{from:'pyproject.toml',command:'python -m pytest -q'},{from:'package.json',command:'npm test'}]})},
  state(){return {workspace:{path:root},generation:1,instanceId:'test-agent',services:{desktop:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'}}};},
  acquireTask(){if(this.locked)return false;this.locked=true;return true;},
  releaseTask(){this.locked=false;},
  async createAgentSession(){return {catalog:{tools:[{name:'desktop-commander.list_directory',server:'desktop-commander',inputSchema:{type:'object'}}],prompts:[],resources:[],resourceTemplates:[],servers:{}},async close(){},async callTool(){throw new Error('Not required in this fixture');}};},
};
const provider={
  ready:()=>true,snapshot:()=>({provider:'fixture',model:'fixture'}),
  async respond(payload){prompts.push(payload.instructions);return {status:'completed',output:[{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Detected tests, no command executed.'}]}]};}
};
try{
  const runner=new AgentRunner({manager,provider,taskDirectory:path.join(root,'tasks')});await runner.load();
  const started=await runner.start({prompt:'Tự chọn công cụ, kiểm tra dự án.',maxSteps:4,maxMinutes:1});
  for(let i=0;i<50&&runner.get(started.id)?.status==='running';i++)await new Promise(r=>setTimeout(r,40));
  assert.equal(runner.get(started.id).status,'completed');
  assert.equal(prompts.length,1);
  assert.ok(prompts[0].includes('AUTOMATIC PROJECT CHECK DISCOVERY'));
  assert.ok(prompts[0].includes('python -m pytest -q'));
  assert.ok(prompts[0].includes('npm test'));
  assert.ok(prompts[0].includes('Select the appropriate tools autonomously'));
  assert.equal(runner.get(started.id).toolCalls,0,'discovery does not execute shell tools');
  assert.ok(runner.get(started.id).events.some(x=>x.type==='project_detected'));
  await runner.shutdown();
  console.log('PASS Agent preflight auto-discovers project check tools without manual selection or executing shell commands');

  // Router lookup must prefer an exact registered name over a local alias,
  // and must never invent aliases for remote-only tools with matching basenames.
  const invoked=[];
  const collisionManager={...manager,locked:false,studio:undefined,
    async createAgentSession(){return {catalog:{tools:[
      {name:'local.read_file',server:'local',originalName:'read_file',inputSchema:{type:'object'}},
      {name:'read_file',server:'fixture',originalName:'canonical_reader',inputSchema:{type:'object'}},
      {name:'remote.remote_only',server:'remote',originalName:'remote_only',inputSchema:{type:'object'}},
    ],prompts:[],resources:[],resourceTemplates:[],servers:{}},async close(){},
    async callTool(name,args){invoked.push(name);assert.deepEqual(args,{});return {content:[{type:'text',text:name}]};}};},
  };
  let turn=0;
  const collisionProvider={ready:()=>true,snapshot:()=>({provider:'fixture',model:'fixture'}),async respond({input}){
    const last=input.filter(item=>item.type==='function_call_output').at(-1);
    const result=last?JSON.parse(last.output):null;
    const call=(name,args)=>({status:'completed',output:[{type:'function_call',call_id:`alias-${turn}`,name,arguments:JSON.stringify(args),status:'completed'}]});
    turn++;
    if(turn===1)return call('mcp_describe',{name:'read_file'});
    if(turn===2){assert.equal(result.tool.server,'fixture','exact definition wins over local.read_file alias');return call('mcp_call',{name:'read_file',arguments_json:'{}'});}
    if(turn===3){assert.equal(result.content[0].text,'read_file','exact canonical tool executes');return call('mcp_call',{name:'remote_only',arguments_json:'{}'});}
    assert.deepEqual([result.error?.code,result.executed],['unknown_tool',false],'remote basename is not an approved local alias');
    if(turn===4)return call('mcp_describe',{name:'remote_only'});
    return {status:'completed',output:[{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Exact names preserved.'}]}]};
  }};
  const collisionRunner=new AgentRunner({manager:collisionManager,provider:collisionProvider,taskDirectory:path.join(root,'collision-tasks')});
  try {
    await collisionRunner.load();
    const {id}=await collisionRunner.start({prompt:'Check registered tool identities.'});
    // On a heavily loaded Node 24 runner, five router/tool transcript flushes
    // can legitimately exceed the previous fixed two-second polling window.
    // Await the actual runner completion signal instead of guessing its duration.
    if (collisionRunner.context?.done?.promise) {
      await Promise.race([
        collisionRunner.context.done.promise,
        new Promise((_,reject)=>{
          const timer=setTimeout(()=>reject(new Error('router identity fixture timed out')),15000);
          timer.unref?.();
        }),
      ]);
    }
    const task=collisionRunner.get(id);
    assert.equal(task.status,'completed',task.error);
    assert.deepEqual(invoked,['read_file'],'neither a colliding local alias nor remote basename can execute');
    assert.equal(task.toolCalls,1);
  } finally {await collisionRunner.shutdown();}
  console.log('PASS exact catalog names win local alias collisions; remote-only basenames remain unavailable to MCP routers');
} finally {await fs.rm(root,{recursive:true,force:true});}
