import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DynamicDelegates } from '../lib/dynamic-delegates.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-dynamic-'));
try{
  const workspace={root:path.join(root,'project'),async search(){
    return {matches:[{path:'src/app.js',line:4,text:'export function main() {}'}]};
  }};
  await fs.mkdir(workspace.root);
  let modelCalls=0;
  const provider={ready:()=>true,async respond({tools,signal}){
    signal?.throwIfAborted();
    assert.deepEqual(tools,[],'Dynamic subagents have no host tools');
    modelCalls++;
    if(modelCalls===1)return {output:[{type:'message',content:[{type:'output_text',
      text:JSON.stringify({workers:[
        {id:'research',role:'researcher',goal:'Find matching code',dependsOn:[]},
        {id:'review',role:'reviewer',goal:'Review changes',dependsOn:['research']},
      ]})
    }]}]};
    return {output:[{type:'message',content:[{type:'output_text',text:'Review actual src/app.js:4; no files were changed.'}]}]};
  }};
  const delegates=new DynamicDelegates({workspace,provider,directory:path.join(root,'state')});
  await assert.rejects(delegates.run({goal:'Inspect project'}),{code:'confirmation_required'});
  const outcome=await delegates.run({goal:'Inspect project',confirmation:'AUTHORIZE READONLY DELEGATION'});
  assert.equal(outcome.status,'completed',JSON.stringify(outcome));
  assert.equal(outcome.workers.length,2);
  assert.equal(modelCalls,3);
  assert.equal(Object.hasOwn(outcome,'budget'),false);
  assert.equal(Object.hasOwn(outcome,'maxTokens'),false);
  assert.equal(await delegates.cancel().then(x=>x.cancelled),false);
  const reopened=new DynamicDelegates({workspace,provider,directory:path.join(root,'state')});
  await reopened.load();
  assert.equal(reopened.state().last.status,'completed');
  assert.equal(reopened.state().last.workers.length,2);
  console.log('PASS: user-triggered dynamic read-only planning, dependencies, no tool escalation, no cost/token quotas, persistence');
}finally{await fs.rm(root,{recursive:true,force:true});}
