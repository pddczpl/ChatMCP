// Actual ConcurrentApiAgent routing contracts with a fake primary runner.
// No model network request or mutating Git operation is performed here.
// Provider HTTP semantics are tested separately by verify-model-adapters.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { createHubServer } from '../hub.mjs';

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
    roleProfiles:{Reviewer:'review',tester:'coding','Independent verifier':'review'}});
  assert.equal(task.effectiveProfile.id,'coding');
  assert.equal(task.providerUsed,'coding');
  assert.equal(primary.provider.name,'coding');
  assert.deepEqual(task.roleProfiles,{reviewer:'review',tester:'coding',independent_verifier:'review'});
  const review=await pool.spawnAgent(task.id,{goal:'Review this change',role:'Reviewer'});
  assert.equal(review.effectiveProfile.id,'review');
  assert.equal(review.role,'Reviewer');
  assert.equal(review.parentTaskId,task.id);
  const independently=await pool.spawnAgent(task.id,{goal:'Independent review',role:'Independent verifier'});
  assert.equal(independently.effectiveProfile.id,'review');
  const tests=await pool.spawnAgent(task.id,{goal:'Test the code',role:'tester'});
  assert.equal(tests.effectiveProfile.id,'coding');
  const unknownRole=await pool.spawnAgent(task.id,{goal:'Other review',role:'security'});
  assert.equal(unknownRole.effectiveProfile.id,'coding','unmapped roles inherit parent model');
  const sent=JSON.stringify(await fs.readFile(path.join(directory,'sessions.json'),'utf8'));
  assert.ok(!sent.includes('PROTECTED-KEY-NEVER-PERSIST'),'worker metadata must never contain profile credentials');
  assert.ok(sent.includes('review-r1'),'revision recorded for restart binding');
  // A persisted terminal state can precede workspace-lock cleanup. It must
  // start a new run rather than incorrectly attempting to enqueue a message.
  let finishLock;
  primary.activeTaskId=task.id;
  primary.context={done:{promise:new Promise(resolve=>{finishLock=resolve;})}};
  const follow=pool.continue({id:task.id,prompt:'Check the implementation'});
  finishLock();
  await follow;
  primary.activeTaskId=null;
  primary.context=null;
  assert.equal(primary.provider.name,'coding','follow-up uses the original task profile');
  assert.ok(calls.some(x=>x.profileId==='coding'&&x.expectedRevision==='coding-r1'));
  profiles.set('coding',{...profiles.get('coding'),revision:'coding-r2'});
  await assert.rejects(pool.continue({id:task.id,prompt:'Continue'}),{code:'profile_revision_changed'},
    'edited model credentials require an explicit new review instead of silent resume');
  await assert.rejects(pool.start({prompt:'Unknown',profileId:'missing'}),{code:'profile_not_found'});
  await assert.rejects(pool.start({prompt:'Invalid roles',roleProfiles:{'bad/role':'review'}}),
    {code:'invalid_role_profiles'},'invalid role maps are rejected before task creation');
  const direct=await pool.start({prompt:'Use global explicitly',profileId:'__global__'});
  assert.equal(direct.effectiveProfile,null);
  assert.equal(direct.providerUsed,'global');
  assert.ok(calls.some(x=>x.profileId==='__global__'));
  assert.ok(!JSON.stringify(direct).includes('PROTECTED-KEY-NEVER-PERSIST'));
  console.log('PASS task/role profile routing, immutable resume revision, global fallback and secret-free session metadata');

  // -------------------------------------------------------------------------------------------------------------
  // The REAL seam. Everything above routes through a hand-written resolver; this part uses hub.mjs's own
  // resolveAiProfileProvider, the sealed AiProfiles store and GatewayProvider.forkForTask, and replaces only the network.
  // A fork used to be built as preset 'profile' with an empty path and no headers: it lost prompt caching, the custom
  // path and the custom headers of the profile, and a profile edit could not be told apart from the global connection.
  // -------------------------------------------------------------------------------------------------------------
  const wire=[];
  const okAnthropic={type:'message',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'done'}],usage:{input_tokens:12,output_tokens:2}};
  const network=async(url,options)=>{
    wire.push({url,headers:options.headers,body:JSON.parse(options.body)});
    return {ok:true,status:200,headers:{get:()=>null},async text(){return JSON.stringify(okAnthropic);}};
  };
  const realProvider=new GatewayProvider({directory:path.join(root,'gateway'),bundleRoot:path.resolve(import.meta.dirname,'..'),
    manager:{secrets:[]},env:{},fetchImpl:network,platform:'linux',sleep:async()=>{}});
  await realProvider.load();
  await realProvider.configure({preset:'custom-anthropic',apiBaseUrl:'https://global.example',model:'claude-global',
    apiKey:'sk-global-key-0123456789abcdef',customHeaders:[{name:'X-Global-Tenant',value:'global-tenant-secret'}]});
  const hubManager={secrets:realProvider.manager.secrets,log:()=>{},hubDirectory:path.join(root,'hub'),workspace:root,
    permissions:{mode:'review',executionPolicy:'host-review'},
    state:()=>({version:'test',workspace:{path:root},generation:1,instanceId:'profile-seam',busy:false,services:{}}),
    catalog:{ready:true,tools:[]}};
  createHubServer(hubManager,{port:39007,secret:'profile-seam-secret-0123456789abcdef',provider:realProvider,
    agent:{state:()=>({activeTaskId:null,tasks:[]}),get:()=>null,shutdown:async()=>{}},
    browser:{browserState:()=>({paired:false}),shutdown:async()=>{}}});
  assert.equal(typeof hubManager.resolveAiProfileProvider,'function','hub.mjs installs the resolver');
  const profileKey='sk-ant-profile-key-0123456789abcdef';
  const base={provider:'anthropic',protocol:'anthropic',apiKey:profileKey};
  await hubManager.aiProfiles.upsert({...base,id:'direct',model:'claude-direct',apiBaseUrl:'https://api.anthropic.com',
    customHeaders:[{name:'X-Profile-Tenant',value:'profile-tenant-secret'}]});
  await hubManager.aiProfiles.upsert({...base,id:'gateway',model:'claude-gw',apiBaseUrl:'https://llm-gateway.example',
    customPath:'/proxy/{model}/messages'});
  const ask=(taskProvider)=>taskProvider.respond({input:[{role:'user',content:[{type:'input_text',text:'Hello'}]}],
    instructions:'Task instructions',tools:[],maxOutputTokens:2048});

  const direct1=await hubManager.resolveAiProfileProvider({profileId:'direct'});
  await ask(direct1.provider);
  const aimedAtAnthropic=wire.at(-1);
  assert.equal(aimedAtAnthropic.url,'https://api.anthropic.com/v1/messages');
  assert.deepEqual(aimedAtAnthropic.body.system[0].cache_control,{type:'ephemeral'},
    'a profile aimed at api.anthropic.com keeps system[0].cache_control');
  assert.equal(aimedAtAnthropic.headers['X-Profile-Tenant'],'profile-tenant-secret','and sends the header saved with the profile');
  assert.ok(!('X-Global-Tenant' in aimedAtAnthropic.headers),'but not the header of the global connection');
  assert.equal(aimedAtAnthropic.headers['x-api-key'],profileKey);
  assert.equal(direct1.effectiveProfile.promptCaching,true,'the task shows that it caches');
  assert.deepEqual(direct1.effectiveProfile.customHeaderNames,['X-Profile-Tenant'],'the task record carries header NAMES only');
  assert.ok(!JSON.stringify(direct1.effectiveProfile).includes('profile-tenant-secret'));
  assert.ok(!JSON.stringify(direct1.effectiveProfile).includes(profileKey));

  const gateway=await hubManager.resolveAiProfileProvider({profileId:'gateway'});
  await ask(gateway.provider);
  const aimedAtGateway=wire.at(-1);
  assert.equal(aimedAtGateway.url,'https://llm-gateway.example/proxy/claude-gw/messages','the custom path of the profile is used');
  assert.equal(aimedAtGateway.body.system[0].cache_control,undefined,'another origin: no cache_control (the gateway may reject it)');
  assert.ok(!('X-Global-Tenant' in aimedAtGateway.headers)&&!('X-Profile-Tenant' in aimedAtGateway.headers),
    'and neither the global header nor the header of another profile');
  assert.equal(gateway.effectiveProfile.promptCaching,false);
  assert.equal(gateway.effectiveProfile.customPath,'/proxy/{model}/messages');
  assert.deepEqual(gateway.effectiveProfile.customHeaderNames,[]);

  // The global connection is untouched by all of this.
  await ask(realProvider);
  assert.equal(wire.at(-1).headers['X-Global-Tenant'],'global-tenant-secret');
  assert.equal(wire.at(-1).body.system[0].cache_control,undefined,'a custom connection to an unknown host does not cache');

  // A task that resumes with the revision it started with, a sequential chat and a background chat alike.
  const savedReal=new Map();
  const realPrimary={
    activeTaskId:null,provider:realProvider,manager:hubManager,subscribe:()=>()=>{},
    state:()=>({activeTaskId:null,tasks:[...savedReal.values()]}),get:id=>savedReal.get(id)||null,
    async shutdown(){},
    async start(args){
      const id=randomUUID();
      await ask(this.provider);
      const record={id,prompt:args.prompt,workspace:{path:root},status:'completed',state:'completed',
        effectiveProfile:args.effectiveProfile??null,roleProfiles:args.roleProfiles||{}};
      savedReal.set(id,record);
      return record;
    },
    async continue(args){
      await ask(this.provider);
      const record=savedReal.get(args.id);
      record.effectiveProfile=args.effectiveProfile??null;
      return record;
    },
  };
  let realPool;
  try{
    const realDirectory=path.join(root,'real-pool');
    await fs.mkdir(realDirectory,{recursive:true});
    realPool=new ConcurrentApiAgent({primary:realPrimary,manager:hubManager,provider:realProvider,bundleRoot:root,
      directory:realDirectory,maxConcurrent:0,log:()=>{}});
    const started=await realPool.start({prompt:'Use the direct profile',profileId:'direct'});
    assert.equal(wire.at(-1).headers['X-Profile-Tenant'],'profile-tenant-secret','a started task reaches the provider through its profile');
    assert.deepEqual(wire.at(-1).body.system[0].cache_control,{type:'ephemeral'});
    const revisionAtStart=started.effectiveProfile.revision;
    await realPool.continue({id:started.id,prompt:'Next step'});
    assert.equal(wire.at(-1).headers['X-Profile-Tenant'],'profile-tenant-secret','a resumed task keeps the headers of its profile');
    assert.deepEqual(wire.at(-1).body.system[0].cache_control,{type:'ephemeral'},'and its prompt caching');

    const edited=await hubManager.aiProfiles.upsert({...base,id:'direct',model:'claude-direct',apiBaseUrl:'https://api.anthropic.com',
      customHeaders:[{name:'X-Profile-Tenant',value:'rotated-tenant-secret'}]});
    assert.notEqual(edited.revision,revisionAtStart,'editing a header is a new revision');
    const before=wire.length;
    await assert.rejects(realPool.continue({id:started.id,prompt:'Continue after the edit'}),
      {code:'profile_revision_changed',statusCode:409},'a task bound to the old header cannot resume on the new one');
    await assert.rejects(hubManager.resolveAiProfileProvider({profileId:'direct',expectedRevision:revisionAtStart}),
      {code:'profile_revision_changed',statusCode:409});
    assert.equal(wire.length,before,'and nothing was sent');
    const renewed=await hubManager.resolveAiProfileProvider({profileId:'direct',expectedRevision:edited.revision});
    await ask(renewed.provider);
    assert.equal(wire.at(-1).headers['X-Profile-Tenant'],'rotated-tenant-secret','a new task gets the edited header');
    // What the Hub keeps on disk and what it hands to the task record: sealed values and names, never a secret.
    const everything=await fs.readFile(path.join(root,'hub','ai-profiles.json'),'utf8')+JSON.stringify([...savedReal.values()])+JSON.stringify(realPool.state());
    for(const secret of ['profile-tenant-secret','rotated-tenant-secret',profileKey,'global-tenant-secret'])
      assert.ok(!everything.includes(secret),'no secret in ai-profiles.json or in the task records');
    // A profile file written by an older build holds a window that build accepted (2,000..4,095). The new bound refuses it, and the person
    // who starts a task with that profile must be told which window, which range and where to fix it. A hand-written file on disk, a second
    // Hub that loads it, the real resolver.
    const legacyHub = path.join(root, 'legacy-hub');
    await fs.mkdir(legacyHub, { recursive: true });
    process.env.CHATMCP_LEGACY_PROFILE_KEY = 'sk-legacy-profile-key-0123456789';
    await fs.writeFile(path.join(legacyHub, 'ai-profiles.json'), JSON.stringify({ defaultProfileId: 'old-window', profiles: [{
      id: 'old-window', name: 'Old window', provider: 'openai-chat', protocol: 'openai-chat', model: 'gpt-old', apiBaseUrl: 'https://old.example/v1',
      authMode: 'auto', contextWindow: 3000, revision: 'legacy-revision', envKeyName: 'CHATMCP_LEGACY_PROFILE_KEY' }] }));
    const legacyManager = { secrets: [], log: () => {}, hubDirectory: legacyHub, workspace: root, permissions: { mode: 'review', executionPolicy: 'host-review' },
      state: () => ({ version: 'test', workspace: { path: root }, generation: 1, instanceId: 'legacy-profile', busy: false, services: {} }), catalog: { ready: true, tools: [] } };
    createHubServer(legacyManager, { port: 39008, secret: 'legacy-profile-secret-0123456789abcdef', provider: realProvider,
      agent: { state: () => ({ activeTaskId: null, tasks: [] }), get: () => null, shutdown: async () => {} }, browser: { browserState: () => ({ paired: false }), shutdown: async () => {} } });
    await assert.rejects(legacyManager.resolveAiProfileProvider({ profileId: 'old-window' }), (error) => {
      assert.equal(error.code, 'invalid_context_window');
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /old-window/, 'it names the profile');
      assert.match(error.message, /3,000/, 'and the window it holds');
      assert.match(error.message, /4,096.*2,000,000/, 'and the range');
      assert.match(error.message, /AI Model/, 'and where to change it');
      return true;
    });
    console.log('PASS real seam: a profile fork keeps prompt caching, custom path and custom headers; another origin gets none of the global ones; a header edit refuses resume');
  }finally{
    delete process.env.CHATMCP_LEGACY_PROFILE_KEY;
    await realPool?.shutdown?.();
  }
}finally{
  // The Hub's plugin and skill stores finish a background read as the test ends; give them a moment instead of failing the cleanup.
  await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});
}
