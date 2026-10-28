// Full local worktree AgentRunner -> check grants -> signed fake receipt
// -> model repair -> recheck. This is a SCRIPTED backend fixture, not OS proof.
// It also records what the model of each worker is given: its skills and tool schemas are selected on its goal, not on the Hub's instructions around it.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { CodingWorktreeOrchestrator } from '../lib/coding-orchestrator.mjs';
import { ExecutionBackend, validateCapabilityReport, validateExecutionReceipt } from '../lib/execution-contract.mjs';
import { BLACKBOX_KIND, BLACKBOX_COMMAND } from '../lib/native-blackbox-contract.mjs';
import { AgentRunner, selectConversationSkills } from '../lib/agent.mjs';
import { MARKETPLACE_CATALOG } from '../lib/plugins.mjs';
import { selectTaskToolNames } from '../lib/tool-selector.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-phase1-autocoding-'));
const work=path.join(root,'project');
const state=path.join(root,'state');
const git=args=>execFileSync('git',args,{cwd:work,encoding:'utf8',timeout:15000,windowsHide:true});
class FakeIsolatedBackend extends ExecutionBackend {
  constructor(){super('windows-sandbox');this.executions=0;}
  async probe(){return validateCapabilityReport({
    backend:this.id,available:true,osIsolated:true,platform:'win32',networkPolicy:'denied',
    writeScope:'guest-ephemeral',concurrency:1,
    enforcedLimits:['timeoutSeconds','maxOutputBytes'],unsupportedLimits:['maxMemoryMb','maxCpuCores','customEnv'],
    reasons:[],observedAt:new Date().toISOString(),
  });}
  async execute(request) {
    const id=++this.executions;
    const stamp=new Date().toISOString();
    const failure=id===1;
    const receipt=validateExecutionReceipt({
      runId:request.runId,status:failure?'failed':'completed',exitCode:failure?1:0,
      stdout:failure?'Synthetic native comparison mismatch':'Synthetic native comparison matched',
      stderr:'',startedAt:stamp,completedAt:stamp,durationMs:1,
      backend:'windows-sandbox',snapshotHash:request.snapshotHash,checkHash:request.checkHash,
      truncated:false,evidencePath:null,reasons:failure?['Assertion failed']:[],
      grader:{version:1,kind:'native-blackbox',manifestSha256:request.grader.manifestSha256,
        cases:1,passed:failure?0:1,failed:failure?1:0,valid:!failure},
    });
    return Object.freeze({...receipt,publisherAuthenticated:true,provenance:'publisher_authenticated',
      graderAuthenticated:true,publicationProtocol:'system-sealed-exit-v1'});
  }
  async cancel(){return true;}
}
try {
  await fs.mkdir(work);
  git(['init','-b','main']);
  git(['config','user.name','Phase1 CI']);
  git(['config','user.email','phase1@example.invalid']);
  await fs.writeFile(path.join(work,'package.json'),JSON.stringify({
    name:'chatmcp-test-project',version:'0.0.1',type:'module'
  }));
  await fs.writeFile(path.join(work,'adapter.mjs'),'// Scripted backend does not execute this adapter.\n');
  await fs.mkdir(path.join(work,'chatmcp.checks'),{recursive:true});
  await fs.writeFile(path.join(work,'chatmcp.checks','basic.json'),JSON.stringify({
    version:1,kind:BLACKBOX_KIND,adapter:'adapter.mjs',cases:[{id:'basic',input:1,expected:2}],
  }));
  git(['add','.']);git(['commit','-m','baseline']);
  const parent=new HubManager({bundleRoot:path.resolve('.'),dataDirectory:state,backend:'local',log:()=>{}});
  await parent.load(work);
  assembleStudio(parent,{bundleRoot:path.resolve('.')});
  const productionSandbox=parent.executionRegistry.get('windows-sandbox');
  assert.equal(productionSandbox.publisher.diagnosticHostAttested,false);
  assert.equal(productionSandbox.publisher.supportsRequest({checkKind:BLACKBOX_KIND,command:BLACKBOX_COMMAND}),true);
  assert.equal(productionSandbox.publisher.supportsRequest({command:'node --test'}),false);
  assert.equal(productionSandbox.publisher.supportsRequest({checkKind:BLACKBOX_KIND,command:'node --test'}),false);
  if(process.platform==='win32')assert.equal(productionSandbox.driver.publicationProtocol,'system-sealed-exit-v1');
  parent.permissions.mode='autonomous';
  await parent.startLocal();
  // The nine skills the Hub ships, all enabled (the workers share this plugin manager), so that what each worker is given can be told apart.
  const plugins=parent.pluginManager;
  for(const item of MARKETPLACE_CATALOG)if(!plugins.installed().some(installed=>installed.id===item.id))await plugins.install(item.id);
  for(const item of MARKETPLACE_CATALOG)await plugins.toggle(item.id,true);
  assert.equal(plugins.activeSkills().length,9,'the nine skills the Hub ships, all enabled');
  const ids=(skills)=>skills.map(skill=>skill.id);
  // What the model was given on one call. It is recorded here and asserted after the run: a throw inside respond() is a model error that fails the worker.
  // Skills are read from the model's input the way it receives them: "### Skill: <name> (<id>) [License: ...]".
  const record=({input,tools})=>({
    prompt:input.findLast(item=>item.role==='user').content[0].text,
    skills:[...JSON.stringify(input).matchAll(/### Skill: [^\\]*? \(([a-z0-9_-]+)\) \[License:/g)].map(match=>match[1]),
    tools:tools.map(tool=>tool.name),
  });
  const seen=[];
  const FINAL={status:'completed',output:[{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Done.'}]}]};
  const GOAL='Produce one small JS change, then repair when the broker test fails.';
  const backend=new FakeIsolatedBackend();
  parent.executionRegistry.register(backend);
  let calls=0;
  const provider={
    ready:()=>true,snapshot:()=>({provider:'fake',model:'fixture'}),
    async respond({input,tools}) {
      calls++;
      seen.push(record({input,tools}));
      assert.ok(tools.some(x=>x.name==='write_file'));
      assert.ok(tools.some(x=>x.name==='checks_list'));
      assert.ok(tools.some(x=>x.name==='checks_run'));
      assert.ok(!tools.some(x=>x.name==='run_command'),'agent never gets host shell');
      if (calls===1 || calls===3) {
        return {status:'completed',output:[{type:'function_call',call_id:'phase1-call-'+calls,
          name:'write_file',arguments:JSON.stringify({
            path:calls===1?'initial.js':'repair.js',
            content:calls===1?'export const initial=true;\n':'export const repaired=true;\n'
          })}]};
      }
      return {status:'completed',output:[{type:'message',role:'assistant',phase:'final',
        content:[{type:'output_text',text:'File edited, verification must be checked independently.'}]}]};
    }
  };
  const agent=new CodingWorktreeOrchestrator({
    manager:parent,provider,bundleRoot:path.resolve('.'),
    directory:path.join(root,'coding-orchestrator'),
  });
  const running=agent.run({
    tasks:[{id:'coder',prompt:GOAL,verify:true}],
    confirmation:'CREATE WORKTREES',maxConcurrency:1,
  });
  let workerReady=false;
  for(let i=0;i<150;i++){
    const entry=[...agent.jobs.values()].at(-1)?.workers?.[0];
    if(entry?.status==='awaiting_test_grant'){workerReady=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(workerReady,true,'Verified worker must request a scoped test grant after editing.');
  const checks=(await agent.discoverWorkerChecks({workerId:'coder'})).checks;
  assert.equal(checks.length,1,'Immutable declarative black-box check discovered from worker files');
  assert.equal(checks[0].command,BLACKBOX_COMMAND);
  await agent.grantCheck({workerId:'coder',checkId:checks[0].id,confirmation:'AUTHORIZE ISOLATED CHECK'});
  const finished=await running;
  assert.equal(finished.status,'ready_for_review',JSON.stringify(finished));
  const worker=finished.workers[0];
  assert.equal(worker.verifyRequired,true);
  assert.equal(worker.verificationOutcome?.state,'ready_for_review');
  assert.equal(worker.verificationOutcome?.repairs,1);
  assert.equal(worker.verificationAttempts?.length,2);
  assert.equal(worker.verificationAttempts.at(-1).testOutcomeVerified,true);
  assert.equal(backend.executions,2);
  assert.ok(worker.changedFiles.includes('initial.js'));
  assert.ok(worker.changedFiles.includes('repair.js'));
  assert.equal(git(['rev-parse','HEAD']).trim(),finished.baseSha,'Coding still isolated to managed worktree');
  // The run reports the folder it belongs to, as the very string the Hub reports for its own folder (what a page compares with hub.workspace.path), and
  // that string is the real path of the project (the temp folder of this machine may be spelled with a short 8.3 name).
  assert.equal(finished.workspace,parent.state().workspace.path,'the run reports the Hub\'s own spelling of its folder');
  assert.equal(finished.workspace,await fs.realpath(work));
  // The summary is what the model said and nothing else. The Hub's sentence about the evidence is a field of its own, and the page reads it as the Hub's.
  assert.equal(worker.summary,'File edited, verification must be checked independently.','the summary is the model\'s own words');
  assert.deepEqual(worker.verificationNote,{code:'verified',text:'All registered pinned Node checks have fresh signed TAP evidence.'});
  const saved=JSON.parse(await fs.readFile(path.join(agent.directory,'jobs.json'),'utf8')).jobs.at(-1);
  assert.deepEqual(saved.workers[0].verificationNote,worker.verificationNote,'what is saved is what is reported');
  assert.equal(saved.workspace,finished.workspace);

  // The orchestrator writes the first prompt of every worker: "TASK: <goal>" and then its own instructions ("managed, isolated Git worktree", "Git publish
  // tools", "tests", "checks_list" ...). The model reads all of it; skills and tool schemas are selected on the goal. Selected on the whole text, the
  // instructions alone gave every worker both Git skills and the edit, file-shape and Git tool schemas, whatever its goal. This is the real #worker and
  // AgentRunner; the cases of start() itself are in verify-skill-delivery and verify-tool-selector.
  const HUB_START='\nYou are a coding worker on a managed, isolated Git worktree.';
  const HUB_END='Never request secrets.';
  const ROUTERS=['mcp_catalog','mcp_describe','mcp_call','mcp_capabilities'];
  const persisted=async(orchestrator,job,id)=>JSON.parse(await fs.readFile(path.join(orchestrator.directory,'runs',job.id,'state',id,'tasks',
    job.workers.find(entry=>entry.id===id).agentTaskId,'task.json'),'utf8'));
  const activations=(task)=>task.events.filter(event=>event.type==='skills_activated').map(event=>event.selectedSkills);
  // A call is given what the conversation's own words select: the prompt of its run first, then the earlier ones. Every direct tool it is offered is one of those.
  const onlyWhatItAsks=(call,label,prompt,earlier=[])=>{
    assert.deepEqual(call.skills,ids(selectConversationSkills(plugins,prompt,earlier)),label+': is given the skills its own words select');
    const asked=new Set([prompt,...earlier].flatMap(text=>selectTaskToolNames(text)));
    // (skill_load is a host function and no tool schema of the task: it is offered whenever a skill is turned on, because the index names the skills the model can read.)
    for(const name of call.tools)assert.ok(ROUTERS.includes(name)||name==='skill_load'||asked.has(name),label+': is offered '+name+', which none of its own words select');
  };

  // The worker of the verified loop: its first run (two model calls), then the repair run the orchestrator continues it with (two more).
  assert.equal(seen.length,calls,'every model call of the worker was recorded');
  assert.ok(seen[0].prompt.startsWith('TASK: '+GOAL+HUB_START)&&seen[0].prompt.endsWith(HUB_END),'the model still reads the goal and then the Hub\'s instructions');
  assert.ok(seen[2].prompt.startsWith('Isolation-verified testing found failing assertions.'),'(the third call is the repair run, which reads the Hub\'s repair prompt)');
  // The premises, on the text the model read: selected as a whole it was given the skills and tools below, and the goal names none of them.
  assert.deepEqual(ids(selectConversationSkills(plugins,GOAL)),[],'(the premise: the goal names no skill)');
  assert.deepEqual(ids(selectConversationSkills(plugins,seen[2].prompt)),[],'(the premise: the repair prompt, the Hub\'s own text, names no skill either)');
  for(const id of ['git-workflow-pro','github-actions-ci-cd'])assert.ok(ids(selectConversationSkills(plugins,seen[0].prompt)).includes(id),`(the premise: selected as a whole, the Hub's instructions give ${id})`);
  for(const name of ['files_write_batch','make_directory','move_path','git_log'])assert.ok(selectTaskToolNames(seen[0].prompt).includes(name)&&!selectTaskToolNames(GOAL).includes(name),`(the premise: the Hub's instructions alone select ${name})`);
  seen.slice(0,2).forEach((call,i)=>onlyWhatItAsks(call,'the worker\'s first run, call '+(i+1),GOAL));
  seen.slice(2).forEach((call,i)=>onlyWhatItAsks(call,'its repair run, call '+(i+1),call.prompt,[GOAL]));
  const verified=await persisted(agent,finished,'coder');
  assert.deepEqual(activations(verified),[],'no skills_activated event in either run');
  assert.deepEqual(verified.prompts.map(prompt=>prompt.selectionText),[GOAL,undefined],'the goal is stored with the first prompt as the text it is selected on; the repair prompt is selected as written');

  // Three workers of one job, each with a goal of its own: one that names no skill and no tool, one that names docker, one that names Git and file moves.
  const NEUTRAL='Summarize the findings in two sentences.';
  const DOCKER='Update the Dockerfile and the docker compose file for the new service.';
  const SHAPE='Move the helpers into a new src/lib directory and show the git log of the project.';
  const calls2=[];
  const selecting=new CodingWorktreeOrchestrator({
    manager:parent,bundleRoot:path.resolve('.'),directory:path.join(root,'coding-orchestrator-selection'),
    provider:{ready:()=>true,snapshot:()=>({provider:'fake',model:'fixture'}),async respond(request) {
      const call=record(request);
      calls2.push(call);
      // The worker whose goal names no tool writes a file through the router: a schema that is not offered directly is still a tool it can call.
      if(call.prompt.startsWith('TASK: '+NEUTRAL+'\n')&&!request.input.some(item=>item.type==='function_call_output'))
        return {status:'completed',output:[{type:'function_call',call_id:'via-router',name:'mcp_call',arguments:JSON.stringify({
          name:'local.write_file',arguments_json:JSON.stringify({path:'via-router.txt',content:'Written through mcp_call.\n'})})}]};
      return FINAL;
    }},
  });
  const selectionJob=await selecting.run({
    tasks:[{id:'nothing',prompt:NEUTRAL},{id:'docker',prompt:DOCKER},{id:'shape',prompt:SHAPE}],
    confirmation:'CREATE WORKTREES',maxConcurrency:1,
  });
  assert.equal(selectionJob.status,'ready_for_review',JSON.stringify(selectionJob));
  assert.equal(selectionJob.workspace,parent.state().workspace.path,'every run reports its folder');
  for(const entry of selectionJob.workers)assert.ok(!('verificationNote' in entry),'a worker that was not asked to verify has no verification note: '+entry.id);
  // The calls of each worker, told apart by the goal its prompt starts with: one, and two for the worker that writes through the router.
  const callsOf=(goal,count)=>{
    const found=calls2.filter(call=>call.prompt.startsWith('TASK: '+goal+'\n'));
    assert.equal(found.length,count,count+' model call(s) for the worker whose goal is "'+goal+'"');
    for(const call of found){
      assert.ok(call.prompt.startsWith('TASK: '+goal+HUB_START)&&call.prompt.endsWith(HUB_END),'the model still reads the goal and then the Hub\'s instructions: "'+goal+'"');
      onlyWhatItAsks(call,'the worker whose goal is "'+goal+'"',goal);
    }
    return found[0];
  };
  const [nothing,docker,shape]=[callsOf(NEUTRAL,2),callsOf(DOCKER,1),callsOf(SHAPE,1)];
  assert.equal(calls2.length,4,'and no other call was made');
  // A worker whose goal names no skill and no tool is given no skill, and none of the tool schemas only the Hub's instructions ask for. It keeps the baseline
  // that lets it read the project, see what changed and use the registered checks.
  assert.deepEqual(nothing.skills,[],'a worker whose goal names no skill is given none, though the Hub\'s instructions say "Git"');
  for(const name of ['edit_file','write_file','files_apply_patch','files_write_batch','make_directory','move_path','git_log'])assert.ok(!nothing.tools.includes(name),'and is not offered '+name+', which only the Hub\'s instructions select');
  for(const name of [...ROUTERS,'read_file','search_files','git_status','git_diff','checks_list','checks_run'])assert.ok(nothing.tools.includes(name),'but is still offered '+name);
  // A tool that is not offered directly is still a tool it can call: it wrote its file through mcp_call, which the worktree shows.
  assert.deepEqual(selectionJob.workers.find(entry=>entry.id==='nothing').changedFiles,['via-router.txt'],'it can still edit: write_file, which it is not offered, ran through mcp_call');
  // A goal that names docker is given the Docker skill, and the tools the goal itself selects.
  assert.deepEqual(docker.skills,['docker-devops'],'a worker whose goal names docker is given the Docker skill, and nothing else the Hub\'s instructions say');
  for(const name of ['edit_file','write_file','files_apply_patch'])assert.ok(docker.tools.includes(name),'and is offered '+name+', which its goal ("Update") selects');
  for(const name of ['files_write_batch','make_directory','move_path','git_log'])assert.ok(!docker.tools.includes(name),'and not '+name+', which only the Hub\'s instructions select');
  // These tools are in a worker's catalog and the Git skill is installed: a goal that names them is given them, so their absence above is the selection.
  for(const name of ['edit_file','write_file','files_write_batch','make_directory','move_path','git_log'])assert.ok(shape.tools.includes(name),'a worker whose goal names file moves and the git log is offered '+name);
  assert.ok(shape.skills.includes('git-workflow-pro'),'and a goal that names git is given the Git skill');
  // What each worker's conversation stored: the skills_activated events, and the goal as the text its prompt is selected on (also by its later messages).
  const [nothingTask,dockerTask,shapeTask]=[await persisted(selecting,selectionJob,'nothing'),await persisted(selecting,selectionJob,'docker'),await persisted(selecting,selectionJob,'shape')];
  assert.deepEqual(activations(nothingTask),[],'no skills_activated event for the goal that names no skill');
  assert.deepEqual(activations(dockerTask),[['docker-devops']],'one for the goal that names docker, for the Docker skill alone');
  assert.deepEqual(activations(shapeTask),[shape.skills],'and one for the goal that names git, for the skills the model was given');
  for(const [task,goal] of [[nothingTask,NEUTRAL],[dockerTask,DOCKER],[shapeTask,SHAPE]])assert.deepEqual(task.prompts.map(prompt=>prompt.selectionText),[goal],'the goal is stored as the text the prompt is selected on: "'+goal+'"');

  // A worker started without the option is selected exactly as before: the very text the orchestrator wrote, handed to a runner that is given no
  // selectionPrompt, is selected as a whole, and it is given the Git skills and the Git, test and file-shape tools of the Hub's instructions.
  const bareCalls=[];
  const bare=new AgentRunner({manager:parent,taskDirectory:path.join(root,'bare-tasks'),log:()=>{},toolSelectionMode:'auto',
    provider:{ready:()=>true,snapshot:()=>({provider:'fake',model:'fixture'}),async respond(request) {bareCalls.push(record(request));return FINAL;}}});
  try {
    const started=await bare.start({prompt:nothing.prompt});
    for(let i=0;i<1500&&bare.get(started.id).status==='running';i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(bare.get(started.id).status,'completed',bare.get(started.id).error);
  } finally {await bare.shutdown();}
  assert.equal(bareCalls.length,1);
  assert.deepEqual(bareCalls[0].skills,ids(selectConversationSkills(plugins,nothing.prompt)),'a runner started without a selectionPrompt is given the skills of the whole text, as before');
  for(const id of ['git-workflow-pro','github-actions-ci-cd'])assert.ok(bareCalls[0].skills.includes(id),'among them '+id);
  for(const name of ['git_commit','git_merge','worktrees_create','test_run'])assert.ok(bareCalls[0].tools.includes(name),'and it is offered '+name+', which only the Hub\'s instructions select');

  // A coding worker is a runner like any other (AgentRunner.start): when its goal names a skill that is too big to be carried in the index, it is offered skill_load, last in
  // its tool list, and is given the text once, after it asked. (The nine skills above are all small, so none of those workers needed the tool.)
  const BULK_MARK='BULK-WORKER-SKILL-TEXT-4d2a';
  await plugins.install('bulkworker',{name:'bulkworker',description:'Long reference for bulkworker work',tools:[],systemPrompt:'Bulk worker skill. '+BULK_MARK+'\n'+'Keep the changes small. '.repeat(120)});
  const loadCalls=[];
  const loading=new CodingWorktreeOrchestrator({
    manager:parent,bundleRoot:path.resolve('.'),directory:path.join(root,'coding-orchestrator-skill-load'),
    provider:{ready:()=>true,snapshot:()=>({provider:'fake',model:'fixture'}),async respond(request) {
      loadCalls.push({...record(request),text:JSON.stringify(request.input).split(BULK_MARK).length-1});
      if(!request.input.some(item=>item.type==='function_call_output'))
        return {status:'completed',output:[{type:'function_call',call_id:'worker-skill-load',name:'skill_load',arguments:JSON.stringify({id:'bulkworker'})}]};
      return FINAL;
    }},
  });
  const loadJob=await loading.run({tasks:[{id:'loader',prompt:'Review the notes of bulkworker.'}],confirmation:'CREATE WORKTREES',maxConcurrency:1});
  assert.equal(loadJob.status,'ready_for_review',JSON.stringify(loadJob));
  assert.equal(loadCalls.length,2,'the worker asked for the skill and then answered');
  assert.ok(loadCalls.every(call=>call.tools.at(-1)==='skill_load'),'a coding worker is offered skill_load, last in its list');
  assert.deepEqual(loadCalls[0].skills,['bulkworker'],'the index names the skill ...');
  assert.deepEqual(loadCalls.map(call=>call.text),[0,1],'... its text is not in the first request and is there once, after the worker asked');
  assert.equal((await persisted(loading,loadJob,'loader')).events.filter(event=>event.type==='skill_loaded').length,1,'with a receipt in the worker\'s own task');
  await parent.shutdown();
  console.log('PASS: scripted real AgentRunner edited, approved immutable checks ran, failed, repaired and passed; no host commands or merge; each worker is given the skills and tool schemas of its goal, not of the Hub\'s instructions.');
} finally {
  await fs.rm(root,{recursive:true,force:true});
}
