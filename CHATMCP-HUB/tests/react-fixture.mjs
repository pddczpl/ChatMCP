import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHubServer } from '../hub.mjs';
import { DualAgent } from '../lib/dual-agent.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { PermissionGate } from '../lib/permissions.mjs';
import { StudioTerminal } from '../lib/studio-terminal.mjs';
import { StudioWorkflow } from '../lib/studio-workflow.mjs';
import { StudioDelegates } from '../lib/studio-delegates.mjs';

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-react-fixture-'));
const repo=path.join(tmp,'test-project');await fs.mkdir(repo);
await fs.writeFile(path.join(repo,'README.md'),'# Example task\nRead this project.\n');
await fs.writeFile(path.join(repo,'main.py'),'def test():\n    return True\n');
const taskId='123e4567-e89b-42d3-a456-426614174000';
const task={id:taskId,prompt:'Rà soát mã nguồn demo',status:'completed',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),workspace:{path:repo},steps:3,toolCalls:2,autoResume:false,prompts:[{text:'Rà soát mã nguồn demo'}],runs:[{finalText:'Đã đọc README và xem main.py.',status:'completed'}],events:[{at:new Date().toISOString(),type:'tool',toolName:'studio.read',message:'Đã đọc README.md'}],finalText:'Đã đọc README và xem main.py.',chatUrl:'https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b',transport:'chatgpt-web'};
const map=new Map([[taskId,task]]);
const browser={state:()=>({tasks:[...map.values()],active:null}),get:id=>map.get(id)||null,delete:async id=>{map.delete(id);return {ok:true,removed:id};},report:async()=> 'Demo report',cancel:async()=>null,setAutoResume:async(id,enabled)=>{const t=map.get(id);t.autoResume=enabled;return t;},browserState:()=>({paired:true,connected:true}),createPairCode:async()=>({code:'45671234',expiresAt:new Date(Date.now()+200000).toISOString()}),unpair:async()=>{},shutdown:async()=>{}};
const api={state:()=>({tasks:[],active:null}),get:()=>null,delete:()=>null,report:async()=>'',cancel:async()=>null,setAutoResume:async()=>null,shutdown:async()=>{}};
const dual=new DualAgent({browser,api,directory:tmp});await dual.load();
const manager={workspace:repo,secrets:[],catalog:{ready:true,tools:[]},logs:[],log:s=>{},
  state:()=>({version:'2.1.0',workspace:{path:repo},logs:[],services:{docker:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'},desktop:{state:'ready'}}}),
  async browse(){return {path:repo}},async selectWorkspace(){return {workspace:{path:repo}}},async start(){},async stop(){},async openVsCode(){return {ok:true}}};
manager.studio=new StudioWorkspace({manager,directory:path.join(tmp,'state')});
manager.permissions=new PermissionGate({manager,workspace:manager.studio,directory:path.join(tmp,'policy')});
manager.terminal=new StudioTerminal({workspace:manager.studio});
manager.workflow=new StudioWorkflow({directory:path.join(tmp,'workflow')});
manager.delegates=new StudioDelegates({workspace:manager.studio,provider:{ready:()=>false},directory:path.join(tmp,'delegates')});
const provider={state:()=>({configured:true,model:'fixture-model',protocol:'gemini',apiBaseUrl:'https://fixture.invalid'}),listModels:async()=>[],ready:()=>true,snapshot:()=>({model:'fixture-model'}),configure:async()=>{},clearKey:async()=>{},respond:async()=>({output:[{type:'message'}]})};
const portSelector=net.createServer();await new Promise(r=>portSelector.listen(0,'127.0.0.1',r));const port=portSelector.address().port;await new Promise(r=>portSelector.close(r));
const server=createHubServer(manager,{port,agent:dual,browser,provider,bundleRoot:path.resolve(import.meta.dirname,'..')});
await new Promise(r=>server.listen(port,'127.0.0.1',r));
console.log(`FIXTURE_READY=${port}`);
async function stop(){await manager.terminal.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(tmp,{recursive:true,force:true});}
process.on('SIGINT',()=>void stop().then(()=>process.exit(0)));
process.on('SIGTERM',()=>void stop().then(()=>process.exit(0)));
