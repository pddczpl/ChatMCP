// Actual ConcurrentApiAgent routing contracts with a fake primary runner.
// No model network request or mutating Git operation is performed here.
// Provider HTTP semantics are tested separately by verify-model-adapters.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-profile-routing-'));
const directory=path.join(root,'pool');
const globalProvider={name:'global',ready:()=>true,snapshot:()=>({model:'global-model',provider:'gateway:openai-chat'})};
const saved=new Map();
const calls=[];
const profiles=new Map([
  ['coding',{id:'coding',revision:'coding-r1',provider:'openai-chat',protocol:'openai-chat',
    model:'code-model',name:'Code model',endpointOrigin:'https://code.example',credentialSource:'protected_reference'}],
  ['review',{id:'review',revision:'review-r1',provider:'anthropic',protocol:'anthropic',
    model:'review-model',name:'Reviewer',endpointOrigin:'https://review.example',credentialSource:'protected_reference'}],
]);
const manager={
  workspace:root,
  permissions:{mode:'review',executionPolicy:'host-review'},
  resolveAiProfileProvider:async({profileId=null,expectedRevision=null}={})=>{
    calls.push({profileId,expectedRevision});
    if(profileId==='__global__')return {provider:globalProvider,effectiveProfile:null};
    const id=profileId||'coding';
    const meta=profiles.get(id);
    if(!meta)throw Object.assign(new Error('Unknown model profile'),{code:'profile_not_found',statusCode:404});
    if(expectedRevision && expectedRevision!==meta.revision)
      throw Object.assign(new Error('Profile revision changed'),{code:'profile_revision_changed',statusCode:409});
    return {provider:{
      name:id,
      apiKey:'PROTECTED-KEY-NEVER-PERSIST',
      ready:()=>true,snapshot:()=>({model:meta.model,provider:'gateway:'+meta.protocol}),
    },effectiveProfile:structuredClone(meta)};
  },
};
const primary={
  activeTaskId:null,provider:globalProvider,manager,
  subscribe:()=>()=>{},
  state:()=>({activeTaskId:null,tasks:[...saved.values()]}),
  get:id=>saved.get(id)||null,
  async start(args) {
    const id=randomUUID();
    const result={id,prompt:args.prompt,workspace:{path:root},status:'completed',state:'completed',
      effectiveProfile:args.effectiveProfile??null,roleProfiles:args.roleProfiles||{},
      providerUsed:this.provider.name};
    saved.set(id,result);
    return result;
  },
  async continue(args) {
    const record=saved.get(args.id);
    if(!record)throw Error('Missing conversation');
    record.effectiveProfile=args.effectiveProfile??null;
    record.providerUsed=this.provider.name;
    return record;
  },
};
let pool;
try {
  await fs.mkdir(directory,{recursive:true});
  // Keeping the queue stopped proves route selection and saved metadata before
  // any delegated worktree operations or tool execution can begin.
  pool=new ConcurrentApiAgent({primary,manager,provider:globalProvider,bundleRoot:root,
    directory,maxConcurrent:0,log:()=>{}});
  const task=await pool.start({prompt:'Implement code',profileId:'coding',
    roleProfiles:{reviewer:'review',tester:'coding'}});
  assert.equal(task.effectiveProfile.id,'coding');
  assert.equal(task.providerUsed,'coding');
  assert.equal(primary.provider.name,'coding');
  assert.deepEqual(task.roleProfiles,{reviewer:'review',tester:'coding'});
  const review=await pool.spawnAgent(task.id,{goal:'Review this change',role:'reviewer'});
  assert.equal(review.effectiveProfile.id,'review');
  assert.equal(review.role,'reviewer');
  assert.equal(review.parentTaskId,task.id);
  const tests=await pool.spawnAgent(task.id,{goal:'Test the code',role:'tester'});
  assert.equal(tests.effectiveProfile.id,'coding');
  const unknownRole=await pool.spawnAgent(task.id,{goal:'Other review',role:'security'});
  assert.equal(unknownRole.effectiveProfile.id,'coding','unmapped roles inherit parent model');
  const sent=JSON.stringify(await fs.readFile(path.join(directory,'sessions.json'),'utf8'));
  assert.ok(!sent.includes('PROTECTED-KEY-NEVER-PERSIST'),'worker metadata must never contain profile credentials');
  assert.ok(sent.includes('review-r1'),'revision recorded for restart binding');
  await pool.continue({id:task.id,prompt:'Check the implementation'});
  assert.equal(primary.provider.name,'coding','follow-up uses the original task profile');
  assert.ok(calls.some(x=>x.profileId==='coding'&&x.expectedRevision==='coding-r1'));
  profiles.set('coding',{...profiles.get('coding'),revision:'coding-r2'});
  await assert.rejects(pool.continue({id:task.id,prompt:'Continue'}),{code:'profile_revision_changed'},
    'edited model credentials require an explicit new review instead of silent resume');
  await assert.rejects(pool.start({prompt:'Unknown',profileId:'missing'}),{code:'profile_not_found'});
  await assert.rejects(pool.start({prompt:'Invalid roles',roleProfiles:{'bad role':'review'}}),
    {code:'invalid_role_profiles'},'invalid role maps are rejected before task creation');
  const direct=await pool.start({prompt:'Use global explicitly',profileId:'__global__'});
  assert.equal(direct.effectiveProfile,null);
  assert.equal(direct.providerUsed,'global');
  assert.ok(calls.some(x=>x.profileId==='__global__'));
  assert.ok(!JSON.stringify(direct).includes('PROTECTED-KEY-NEVER-PERSIST'));
  console.log('PASS task/role profile routing, immutable resume revision, global fallback and secret-free session metadata');
}finally{
  await fs.rm(root,{recursive:true,force:true});
}
