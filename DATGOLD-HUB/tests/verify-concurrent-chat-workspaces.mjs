// Regression: two local coding conversations do not share a Hub-wide run lock;
// dependency tasks do not start early; Stop and provider callbacks are scoped.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { AgentRunner, buildUserAttachmentParts } from '../lib/agent.mjs';
import { ATTACHMENT_LIMITS, ATTACHMENT_BODY_LIMIT, limitLabel as attachmentLimitLabel } from '../lib/attachment-limits.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { WorkspaceRegistry } from '../lib/workspace-registry.mjs';
import { DualAgent } from '../lib/dual-agent.mjs';
import { compactRollingContext, estimateTokens } from '../lib/context-compaction.mjs';

const bundleRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-concurrent-'));
const repo=path.join(temp,'project');
const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(test,label)=>{
  for(let tries=0;tries<300;tries++){if(test())return;await wait(100);}
  throw new Error('Timed out: '+label);
};
const release=new Map();
const arrived=new Set();
// What each model request was given: the text of the prompt it starts from and the names of the tools it was offered.
const seen=[];
const hold=(name)=>new Promise(resolve=>{release.set(name,resolve);arrived.add(name);});
let pool;
try {
  await fs.mkdir(repo,{recursive:true});
  execFileSync('git',['init','-b','main'],{cwd:repo,stdio:'ignore'});
  execFileSync('git',['config','user.email','chatmcp-ci@example.invalid'],{cwd:repo});
  execFileSync('git',['config','user.name','ChatMCP CI'],{cwd:repo});
  await fs.writeFile(path.join(repo,'README.md'),'# Concurrent agent fixture\n');
  execFileSync('git',['add','.'],{cwd:repo});
  execFileSync('git',['commit','-m','fixture'],{cwd:repo,stdio:'ignore'});
  const manager=new HubManager({bundleRoot:bundleRoot,dataDirectory:path.join(temp,'hub'),log:()=>{}});
  await manager.load(repo);
  assembleStudio(manager,{bundleRoot:bundleRoot});
  await manager.permissions.load();
  manager.permissions.mode='autonomous';
  await manager.startLocal(repo);
  const secondRepo=path.join(temp,'another-project');
  await fs.mkdir(secondRepo,{recursive:true});
  execFileSync('git',['init','-b','main'],{cwd:secondRepo,stdio:'ignore'});
  await fs.writeFile(path.join(secondRepo,'README.md'),'# Independent repository\n');
  execFileSync('git',['add','.'],{cwd:secondRepo});
  execFileSync('git',['commit','-m','second fixture'],{cwd:secondRepo,stdio:'ignore'});
  const registry=new WorkspaceRegistry({manager,directory:path.join(temp,'hub')});
  await registry.load();
  await registry.add(secondRepo);
  // Detaching a workspace changes only ChatMCP's registry, NEVER files,
  // conversation transcripts, worktrees or Git metadata.
  await registry.remove(repo);
  const restoredPrimary=new WorkspaceRegistry({manager,directory:path.join(temp,'hub')});
  await restoredPrimary.load();
  const canonicalRepo=await fs.realpath(repo);
  assert.equal(restoredPrimary.state().items.some(x=>x.path===canonicalRepo),false);
  await assert.rejects(restoredPrimary.resolve(repo),{code:'unregistered_workspace'},
    'removed primary checkout must not be implicitly restored after restart');
  assert.ok((await fs.stat(path.join(repo,'README.md'))).isFile());
  await restoredPrimary.add(repo);
  await restoredPrimary.remove(secondRepo);
  const restoredSecond=new WorkspaceRegistry({manager,directory:path.join(temp,'hub')});
  await restoredSecond.load();
  const canonicalSecond=await fs.realpath(secondRepo);
  assert.equal(restoredSecond.state().items.some(x=>x.path===canonicalSecond),false,
    'explicitly removed secondary root stays hidden after restart');
  await assert.rejects(restoredSecond.resolve(secondRepo),{code:'unregistered_workspace'});
  assert.ok((await fs.stat(path.join(secondRepo,'README.md'))).isFile());
  await restoredSecond.add(secondRepo);
  manager.workspaceRegistry=restoredSecond;
  const rejected=path.join(temp,'unregistered');
  await fs.mkdir(rejected);
  await assert.rejects(registry.resolve(rejected),{code:'unregistered_workspace'});
  const provider={
    ready:()=>true,snapshot:()=>({provider:'fake',model:'mock'}),
    async respond({input,instructions,tools=[]}){
      // Installed skills now reach the model as a leading user message (UNTRUSTED SKILL REFERENCES); the task prompt is the first message after it.
      const firstUser=input.find(x=>x?.role==='user'&&Array.isArray(x.content)&&!String(x.content[0]?.text||'').startsWith('UNTRUSTED SKILL REFERENCES'));
      const contents=(firstUser?.content||[]).map(x=>x?.text||'').join(' ');
      seen.push({prompt:String(firstUser?.content?.[0]?.text||''),tools:tools.map(tool=>tool.name),instructions:String(instructions||''),map:String(firstUser?.content?.[1]?.text||'')});
      const name=contents.includes('Task A')?'A':contents.includes('Task B')?'B':
        contents.includes('Task E')?'E':
        contents.includes('Workflow Review One')?'R1':
        contents.includes('Workflow Review Two')?'R2':
        contents.includes('Workflow Review Cancel')?'RC':
        contents.includes('Workflow Verify')?'V':'C';
      if(contents.includes('Workflow W')&&!input.some(item=>item?.type==='function_call_output')){
        assert.ok(tools.some(tool=>tool.name==='spawn_workflow'),
          'ordinary chat must offer spawn_workflow tool to the model');
        return {status:'completed',output:[{type:'function_call',status:'completed',
          name:'spawn_workflow',call_id:'workflow-fixture',
          arguments:JSON.stringify({
            name:'Independent two-pass audit',
            phases:[
              {name:'Review',agents:[
                {role:'Security',goal:'Workflow Review One: inspect security'},
                {role:'Correctness',goal:'Workflow Review Two: inspect correctness'},
              ]},
              {name:'Verify',agents:[
                {role:'Independent verifier',goal:'Workflow Verify: check review claims'},
              ]},
            ],
          })}]};
      }
      if(contents.includes('Delegate D') &&
        !input.some(item=>item?.type==='function_call_output')) {
        assert.ok(tools.some(tool=>tool.name==='spawn_agent'),
          'main agent must advertise spawn_agent as a callable tool');
        return {status:'completed',output:[{type:'function_call',status:'completed',
          name:'spawn_agent',call_id:'auto-spawn-fixture',
          arguments:JSON.stringify({goal:'Task D: inspect README as an independent child'})}]};
      }
      if(['A','B','E','R1','R2','RC'].includes(name)&&!arrived.has(name))await hold(name);
      // The predecessor of the plan and Repo Map test: a result that names two files of the project.
      if(contents.includes('Task F:'))return {status:'completed',output:[{type:'message',role:'assistant',phase:'final',
        content:[{type:'output_text',text:'Task F found two problems in src/auth.mjs and src/session.mjs.'}]}]};
      return {status:'completed',output:[{type:'message',role:'assistant',phase:'final',
        content:[{type:'output_text',text:'Task '+name+' completed.'}]}]};
    },
  };
  const primary=new AgentRunner({manager,provider,taskDirectory:path.join(temp,'hub','api-tasks'),log:()=>{}});
  await primary.load();
  pool=new ConcurrentApiAgent({primary,manager,provider,bundleRoot:bundleRoot,
    directory:path.join(temp,'hub','api-conversations'),log:()=>{}});
  manager.spawnBackgroundAgent=(parentId,request)=>pool.spawnAgent(parentId,request);
  manager.spawnWorkflow=(parentId,request)=>pool.spawnWorkflow(parentId,request);
  const first=await pool.start({prompt:'Task A: inspect README'});
  await until(()=>arrived.has('A'),'primary running');
  // Another selected workspace gets its own writable checkout WITHOUT
  // switching the primary Hub manager or waiting for Task A.
  const crossProject=await pool.start({prompt:'Task E: other workspace',workspacePath:secondRepo});
  await until(()=>arrived.has('E'),'secondary workspace running alongside the primary');
  assert.equal(pool.get(crossProject.id).workspace?.path,await fs.realpath(secondRepo));
  assert.equal(pool.get(crossProject.id).workspacePath,await fs.realpath(secondRepo));
  assert.equal(manager.workspace,await fs.realpath(repo),'secondary task cannot switch the primary workspace');
  const second=await pool.start({prompt:'Task B: inspect README'});
  await until(()=>arrived.has('B'),'independent child running');
  assert.equal(pool.state().activeTaskIds.length,3,'three independent conversations across two workspace roots must run concurrently');
  await assert.rejects(pool.delete(first.id),{code:'task_running'},
    'active chat cannot be deleted');
  await assert.rejects(pool.delete(second.id),{code:'task_running'},
    'active worker cannot be deleted');
  const third=await pool.start({prompt:'Task C: summarize B',dependsOn:[second.id]});
  assert.equal(pool.get(third.id).status,'queued');
  assert.deepEqual(pool.get(third.id).dependsOn,[second.id]);
  const newMessage=await pool.continue({id:first.id,prompt:'Please also include a tiny status report.'});
  assert.equal(newMessage.queuedMessagesCount,1,'in-flight message must be accepted, not rejected with 409');
  release.get('B')();
  release.get('E')();
  await until(()=>pool.get(crossProject.id)?.status==='completed','other workspace completed');
  await until(()=>pool.get(second.id)?.status==='completed','B complete');
  await until(()=>pool.get(third.id)?.status==='completed','C complete after B');
  release.get('A')();
  await until(()=>pool.get(first.id)?.status==='completed','A complete with extra message');
  assert.ok(pool.get(first.id).events.some(x=>x.type==='user_message_delivered'));
  // Same workspace, same conversation, two separate execution/task runs.
  // A completed first task must not turn the follow-up into a new chat.
  const beforeFollowup=pool.backgroundTasks().filter(x=>x.conversationId===first.id);
  assert.equal(beforeFollowup.length,1);
  await pool.continue({id:first.id,prompt:'Follow up in the same conversation.'});
  await until(()=>pool.get(first.id)?.runs?.length===2&&pool.get(first.id)?.status==='completed',
    'separate second run in the same conversation');
  const afterFollowup=pool.backgroundTasks().filter(x=>x.conversationId===first.id);
  assert.equal(afterFollowup.length,2,'one conversation contains multiple task runs');
  assert.notEqual(afterFollowup[0].id,afterFollowup[1].id,'task/run IDs must remain distinct');
  assert.ok(afterFollowup.some(run=>run.title==='Follow up in the same conversation.'),
    'background run must use its actual per-run prompt, not previous in-flight messages');

  const worktrees=pool.state().tasks.filter(x=>x.worktree && x.workspace?.path!==repo);
  assert.ok(worktrees.length>=2,'child conversations must have their own worktree paths');
  const unique=new Set(worktrees.map(x=>x.workspace.path));
  assert.equal(unique.size,worktrees.length,'each child gets a distinct worktree');

  // Review mode: approval for a new worktree is explicitly pending and can
  // be cancelled without the worktree appearing later.
  manager.permissions.mode='review';
  const cancelled=await pool.start({prompt:'Task D: cancel while awaiting worktree approval',baseRef:'refs/heads/main'});
  await until(()=>manager.permissions.state().pending.some(p=>p.taskId===cancelled.id),'worktree permission pending');
  assert.equal(pool.get(cancelled.id).state,'queued');
  await pool.cancel(cancelled.id);
  await until(()=>!manager.permissions.state().pending.some(p=>p.taskId===cancelled.id),'approval revoked on Stop');
  assert.equal(pool.get(cancelled.id).status,'cancelled');
  const cancelledBranch=execFileSync('git',['branch','--list','chatmcp/chat/'+cancelled.id.slice(0,12)],{cwd:repo,encoding:'utf8'});
  assert.equal(cancelledBranch.trim(),'','cancelled preflight must not create a worktree branch');

  const accepted=await pool.start({prompt:'Task D: allowed worktree after approval',baseRef:'refs/heads/main'});
  await until(()=>manager.permissions.state().pending.some(p=>p.taskId===accepted.id),'second worktree permission pending');
  const approval=manager.permissions.state().pending.find(p=>p.taskId===accepted.id);
  assert.equal(approval.toolName,'local.worktrees_create');
  manager.permissions.decide(approval.id,true);
  await until(()=>pool.get(accepted.id)?.status==='completed','review-approved child completes');
  assert.ok(pool.get(accepted.id).worktree,'approved task owns a separate worktree');

  // Model-driven delegation from an ordinary chat: no separate assistant form.
  manager.permissions.mode='autonomous';
  const parent=await pool.start({prompt:'Delegate D: create an independent background agent.'});
  await until(()=>pool.state().tasks.some(t=>t.parentTaskId===parent.id),'model spawned child task');
  const delegated=pool.state().tasks.find(t=>t.parentTaskId===parent.id);
  assert.ok(delegated,'spawn tool must create a visible parent-linked task');
  assert.equal(delegated.parentRunId,pool.get(parent.id)?.runs?.at(-1)?.id,
    'delegated agent must be linked to its originating parent task run');
  await until(()=>pool.get(parent.id)?.status==='completed','delegating parent completes');
  await until(()=>pool.get(delegated.id)?.status==='completed','delegated child completes');
  assert.notEqual(pool.get(delegated.id)?.workspace?.path,await fs.realpath(repo),
    'delegated child must not modify the main checkout');
  const background=pool.backgroundTasks();
  assert.ok(background.some(entry=>entry.conversationId===first.id),'main conversation run appears as a background task');
  assert.ok(background.some(entry=>entry.conversationId===parent.id&&entry.subagents.some(a=>a.id===delegated.id)),
    'subagent appears NESTED under the parent conversation, not as a chat');
  assert.ok(background.every(entry=>entry.conversationId&&entry.taskId),
    'background projections carry conversation and task IDs independently');
  await until(()=>!pool.state().activeTaskIds.includes(parent.id)&&
    !pool.state().activeTaskIds.includes(delegated.id),'delegated agents released their locks');
  const childWorktree=pool.get(delegated.id).worktree;
  const deleted=await pool.delete(parent.id);
  assert.ok(deleted.deletedIds.includes(delegated.id),
    'deleting a conversation must cascade to its subagents');
  assert.equal(pool.get(parent.id),null);
  assert.equal(pool.get(delegated.id),null);
  assert.equal(pool.backgroundTasks().some(x=>x.conversationId===parent.id),false,
    'deleted chat and child must disappear from Background Tasks');
  assert.ok((await fs.stat(childWorktree)).isDirectory(),
    'removing a chat may not delete Git worktrees on disk');
  // A single chat creates one real workflow with Review -> Verify phases.
  // The chat turn may finish while its independent reviewers still run.
  const reviewParent=await pool.start({prompt:'Workflow W: review from independent perspectives then verify.'});
  await until(()=>pool.workflows.forConversation(reviewParent.id).length===1,
    'model called the real spawn_workflow tool');
  const workflowId=pool.workflows.forConversation(reviewParent.id)[0].id;
  await until(()=>arrived.has('R1')&&arrived.has('R2'),
    'both independent reviewers started without waiting for each other');
  assert.equal(pool.workflows.get(workflowId).total,3);
  assert.equal(pool.workflows.get(workflowId).phases[0].agents.length,2);
  assert.equal(pool.workflows.get(workflowId).phases[1].agents.length,1);
  assert.equal(pool.workflows.get(workflowId).phases[1].status,'waiting');
  assert.equal(arrived.has('V'),false,'verification must wait for both reviewers');
  const verifierId=pool.workflows.get(workflowId).phases[1].agents[0].taskId;
  assert.equal(pool.get(verifierId).status,'queued');
  await until(()=>pool.get(reviewParent.id)?.status==='completed',
    'parent chat finishes while workflow remains running');
  assert.equal(pool.workflows.get(workflowId).status,'running',
    'workflow continues in background after parent replied');
  // Release reviewer one; verifier must still wait for reviewer two.
  release.get('R1')();
  await until(()=>pool.workflows.get(workflowId).phases[0].completed===1,
    'one reviewer completed');
  assert.equal(pool.workflows.get(workflowId).phases[0].completed,1);
  assert.equal(pool.workflows.get(workflowId).phases[1].status,'waiting');
  assert.equal(pool.get(verifierId).status,'queued');
  release.get('R2')();
  await until(()=>pool.workflows.get(workflowId).status==='completed',
    'verifier finished after both reviewers');
  assert.equal(pool.workflows.get(workflowId).completed,3);
  const durable=JSON.parse(await fs.readFile(path.join(temp,'hub','api-conversations','sessions.json'),'utf8'));
  assert.ok(durable.workflows.some(w=>w.id===workflowId),
    'workflow phases/child IDs must persist in sessions.json');
  assert.equal(durable.workflows.find(w=>w.id===workflowId).phases[1].agents.length,1);
  const displayed=pool.workflows.forConversation(reviewParent.id)[0];
  assert.equal(displayed.parentRunId,pool.get(reviewParent.id).runs.at(-1).id,
    'workflow belongs to exact parent run');
  assert.ok(displayed.phases[0].agents.every(a=>a.worktree),
    'all real reviewers have separate Git worktrees');
  const outcomes=pool.workflows.serialize();
  pool.workflows.load(outcomes);
  assert.equal(pool.workflows.get(workflowId).status,'completed',
    'reload must preserve completed workflow without re-dispatching agents');
  // Stop a second workflow while its reviewer is really blocked inside the
  // model request. Its task is cancelled, not misreported as completed.
  const cancelledWorkflow=await pool.spawnWorkflow(reviewParent.id,{
    name:'Cancel a running review',
    phases:[{name:'Review',agents:[{role:'Reviewer',goal:'Workflow Review Cancel: stop safely'}]}],
  });
  await until(()=>arrived.has('RC'),'cancelled workflow reviewer running');
  const halted=await pool.workflows.cancel(cancelledWorkflow.id);
  assert.equal(halted.status,'cancelled');
  await until(()=>pool.get(halted.phases[0].agents[0].taskId)?.status==='cancelled',
    'cancel propagated to actual child agent');
  assert.equal(pool.workflows.get(cancelledWorkflow.id).status,'cancelled');
  release.get('RC')(); // the scripted provider must not keep an unresolved test promise.
  await until(()=>!pool.state().activeTaskIds.includes(halted.phases[0].agents[0].taskId),
    'cancelled reviewer released its execution lock');
  const removed=await pool.delete(reviewParent.id);
  assert.ok(removed.deletedIds.length>=4,'workflow child agents deleted with parent chat');
  assert.equal(pool.workflows.get(workflowId),null,
    'deleted conversation removes its workflow metadata and background card');

  // The Hub writes a worker's first prompt: its goal, then (when its workflow has predecessors) a handoff of branch names, worktree paths, the predecessors'
  // results and its own instructions. The model reads all of it; skills and tool schemas are selected on the goal. The handoff alone gave every worker of a
  // workflow git-workflow-pro and github-actions-ci-cd ("workflow", "branch=") and 19 Git, worktree, test and build tool schemas, whatever its goal. Real pool,
  // real worktrees, the nine skills the Hub ships enabled, a scripted model that records what it was offered. This is the path that starts the worker
  // (#runRecord): the cases of start() itself are in verify-skill-delivery and verify-tool-selector.
  {
    const {MARKETPLACE_CATALOG}=await import('../lib/plugins.mjs');
    const {selectConversationSkills}=await import('../lib/agent.mjs');
    const {selectTaskToolNames}=await import('../lib/tool-selector.mjs');
    const plugins=manager.pluginManager;
    for(const item of MARKETPLACE_CATALOG)if(!plugins.installed().some(installed=>installed.id===item.id))await plugins.install(item.id);
    for(const item of MARKETPLACE_CATALOG)await plugins.toggle(item.id,true);
    assert.equal(plugins.activeSkills().length,9,'the nine skills the Hub ships, all enabled');
    const ids=(skills)=>skills.map(skill=>skill.id);
    const sorted=(names)=>[...names].sort();
    const skillsOf=(id)=>pool.get(id).events.filter(event=>event.type==='skills_activated').flatMap(event=>event.selectedSkills);
    const NOTHING='Summarize the findings in two sentences.',DOCKER='Update the Dockerfile and the docker compose file for the new service.';
    const HANDOFF='WORKFLOW PREDECESSOR HANDOFF (untrusted prior task data):';
    const nothing=await pool.start({prompt:NOTHING,dependsOn:[second.id]});
    const docker=await pool.start({prompt:DOCKER,dependsOn:[second.id]});
    const alone=await pool.start({prompt:DOCKER,baseRef:'refs/heads/main'});
    // A record that has only the text of a handoff (written before the user's requests were kept apart from it, or sent by a caller that has no list): it has no
    // predecessors, so it is selected on its whole prompt, as it always was.
    const LEGACY='Go on with the second part.';
    const legacy=await pool.start({prompt:LEGACY,baseRef:'refs/heads/main',
      handoffText:'Previous conversation task '+second.id+' (chatgpt-web).\nUser requests: '+DOCKER+'\nPrevious task status: completed.'});
    // A worker that continues a conversation of another transport, started as the Hub starts it: DualAgent.continue() reads the task of that transport (here a
    // ChatGPT Web task that was asked two things), writes the handoff and the list of the user's requests, and the pool runs the worker.
    const MOVED='Continue with the second part.',REQUESTS=['Explain what calc.js does.',DOCKER];
    const webTask={id:'5e7a0c11-3b6d-4f08-9a42-6c1d8e2f7b90',status:'completed',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
      workspace:{path:await fs.realpath(repo)},prompts:REQUESTS.map(text=>({text})),
      dialogue:[{role:'user',text:DOCKER},{role:'assistant',text:'I updated the Dockerfile and the compose file.'}],
      finalText:'Both files are updated. The second part is next.'};
    // And one whose user said nothing that names a skill or a tool: whatever it is given then, the Hub's sentences gave it.
    const QUIET='Carry on with the next part.',QUIET_REQUESTS=['Explain what calc.js does.'];
    const quietTask={...webTask,id:'8d3f5b72-6a1e-4c90-b4d8-2e7f9a0c1b36',prompts:QUIET_REQUESTS.map(text=>({text})),
      dialogue:[{role:'user',text:QUIET_REQUESTS[0]},{role:'assistant',text:'It adds two numbers.'}],finalText:'It adds two numbers. The next part is the same.'};
    const webTasks=[webTask,quietTask];
    const dual=new DualAgent({browser:{state:()=>({tasks:webTasks,active:null}),get:id=>webTasks.find(task=>task.id===id)||null,settle:async()=>{}},
      api:pool,directory:path.join(temp,'hub','dual-agent'),defaultMode:'api'});
    const handoff=dual.buildHandoff(dual.get(webTask.id),MOVED);
    const moved=await dual.continue({id:webTask.id,prompt:MOVED});
    const quiet=await dual.continue({id:quietTask.id,prompt:QUIET});
    for(const worker of [nothing,docker,alone,legacy,moved,quiet])await until(()=>pool.get(worker.id)?.status==='completed','worker '+worker.id+' of the handoff test completed');
    const nothingRequest=seen.find(request=>request.prompt.startsWith(NOTHING));
    const dockerRequest=seen.find(request=>request.prompt.startsWith(DOCKER)&&request.prompt.includes(HANDOFF));
    const aloneRequest=seen.find(request=>request.prompt===DOCKER);

    // The model reads the whole prompt, as the Hub writes it: the goal, the handoff of the predecessor, the Hub's instructions.
    assert.ok(nothingRequest.prompt.startsWith(NOTHING+'\n\n'+HANDOFF+'\nPredecessor '+second.id+' (completed) branch=chatmcp/chat/'),'the model reads the goal and then the handoff');
    assert.ok(nothingRequest.prompt.includes('UNTRUSTED RESULT (independently verify before use):\nTask B completed.'),'with the result of the predecessor');
    assert.ok(nothingRequest.prompt.endsWith('Inspect source, diffs and run actual checks; do not claim prior edits are integrated or verified without evidence.'),'and the Hub\'s instructions');
    assert.ok(dockerRequest.prompt.startsWith(DOCKER+'\n\n'+HANDOFF)&&aloneRequest.prompt===DOCKER,'a worker without predecessors reads its goal alone');
    // The premises, on the text the model actually read: selected as a whole it would have been given the Git skills and the tools below.
    const extra=selectTaskToolNames(nothingRequest.prompt).filter(name=>!selectTaskToolNames(NOTHING).includes(name));
    assert.deepEqual(ids(selectConversationSkills(plugins,NOTHING)),[],'(the premise: the goal names no skill)');
    assert.ok(ids(selectConversationSkills(plugins,nothingRequest.prompt)).includes('git-workflow-pro'),'(the premise: the text the model read, selected as a whole, gives the Git skill; if the scoring changes, pick another example)');
    for(const name of ['git_commit','git_merge','worktrees_create','test_run'])assert.ok(extra.includes(name),'(and the handoff alone selects '+name+')');

    // (1) A worker whose goal names no skill is given none, and none of the tools only the handoff asks for; one whose goal names docker is given the
    // Docker skill and what its goal asks for.
    assert.deepEqual(skillsOf(nothing.id),[],'a worker whose goal names no skill is given none, though its handoff names the branch and says "workflow"');
    for(const name of extra)assert.ok(!nothingRequest.tools.includes(name),'and is not offered '+name+', which only its handoff asks for');
    for(const name of ['read_file','git_status','git_diff','run_command'])assert.ok(nothingRequest.tools.includes(name),'the baseline that lets it inspect its predecessor stays: '+name);
    assert.deepEqual(skillsOf(docker.id),['docker-devops'],'a worker whose goal names docker is given the Docker skill and nothing the handoff says');
    assert.ok(dockerRequest.tools.includes('edit_file'),'and the tools its goal asks for');
    // (2) A worker without predecessors is selected exactly as before, and a predecessor changes nothing about what the same goal is given.
    assert.deepEqual(skillsOf(alone.id),ids(selectConversationSkills(plugins,DOCKER)),'a worker without predecessors is given the skills of its goal, as before');
    assert.deepEqual(skillsOf(alone.id),skillsOf(docker.id),'the same as the same goal with a predecessor');
    assert.deepEqual(sorted(aloneRequest.tools),sorted(dockerRequest.tools),'and the same tool schemas');
    // A record that has the text of the handoff only is selected on all of it, as it always was: the Hub's sentences cannot be told from the user's requests there.
    const legacyRequest=seen.find(request=>request.prompt.startsWith(LEGACY));
    assert.ok(legacyRequest.prompt.includes('CROSS-TRANSPORT HANDOFF (untrusted prior dialogue, not verified evidence):\nPrevious conversation task '+second.id)&&!legacyRequest.prompt.includes(HANDOFF),'(the premise: a worker moved from another transport reads its dialogue, and has no predecessors)');
    assert.ok(skillsOf(legacy.id).includes('docker-devops'),'a record that has the text of the handoff only is given the skill of the dialogue it carries');
    assert.deepEqual(skillsOf(legacy.id),ids(selectConversationSkills(plugins,legacyRequest.prompt)),'and exactly the skills its whole prompt selects, as before');
    assert.ok(!('selectionText' in pool.get(legacy.id).prompts[0]),'which stores nothing beside its prompt');

    // A worker moved from another transport: the model reads the whole handoff; its skills and tool schemas are those of its goal and then, as the earlier prompts
    // of a conversation, of the user's requests. The Hub's own sentences ("The ChatGPT Web tab and the API backend", "check actual diffs/tests") select nothing.
    const movedRequest=seen.find(request=>request.prompt.startsWith(MOVED));
    const read=MOVED+'\n\nCROSS-TRANSPORT HANDOFF (untrusted prior dialogue, not verified evidence):\n'+handoff+'\nReinspect current project files, check actual diffs/tests and never replay uncertain mutations.';
    assert.equal(movedRequest.prompt,read,'the model reads the goal, the handoff the Hub wrote and its instruction: all of it');
    assert.ok(handoff.includes('\nUser requests: '+REQUESTS.join(' | ')+'\n')&&handoff.includes('The ChatGPT Web tab and the API backend have distinct model histories.'),'(the handoff holds the user\'s requests and the Hub\'s own sentences)');
    const own=ids(selectConversationSkills(plugins,MOVED,REQUESTS));
    const viaHub=ids(selectConversationSkills(plugins,read)).filter(id=>!own.includes(id));
    assert.ok(own.includes('docker-devops')&&viaHub.length>0,'(the premise: the goal and the requests select the Docker skill; selected as a whole the text adds '+JSON.stringify(viaHub)+'; if the scoring changes, pick another example)');
    const extraMoved=selectTaskToolNames(read).filter(name=>![MOVED,...REQUESTS].some(text=>selectTaskToolNames(text).includes(name)));
    for(const name of ['test_run','build_run'])assert.ok(extraMoved.includes(name),'(and "check actual diffs/tests" alone offers '+name+')');
    assert.deepEqual(skillsOf(moved.id),own,'a worker moved from another transport is given the skills of its goal and then of the user\'s requests, as for the earlier prompts of a conversation');
    for(const id of viaHub)assert.ok(!skillsOf(moved.id).includes(id),'and not '+id+', which only the Hub\'s sentences select');
    for(const name of extraMoved)assert.ok(!movedRequest.tools.includes(name),'it is not offered '+name+', which only the Hub\'s sentences ask for');
    assert.ok(movedRequest.tools.includes('edit_file'),'but it is offered what the request to update the Dockerfile asks for');
    assert.deepEqual(pool.get(moved.id).prompts.map(prompt=>prompt.selectionText),[MOVED],'the goal is the text its first prompt is selected on');

    // The purest case: neither the goal nor the request names a skill or a tool, and the Hub's sentences and the other model's answer alone gave a worker skills
    // and tool schemas. It is given none of them.
    const quietRequest=seen.find(request=>request.prompt.startsWith(QUIET));
    const quietOwn=[QUIET,...QUIET_REQUESTS];
    const quietViaHub=ids(selectConversationSkills(plugins,quietRequest.prompt));
    assert.deepEqual(ids(selectConversationSkills(plugins,QUIET,QUIET_REQUESTS)),[],'(the premise: neither the goal nor the request names a skill)');
    assert.ok(quietViaHub.length>0,'(and the text the model read, selected as a whole, gives the worker skills; if the scoring changes, pick another example)');
    const extraQuiet=selectTaskToolNames(quietRequest.prompt).filter(name=>!quietOwn.some(text=>selectTaskToolNames(text).includes(name)));
    for(const name of ['test_run','build_run'])assert.ok(extraQuiet.includes(name),'(and tools: "check actual diffs/tests" alone offers '+name+')');
    assert.deepEqual(skillsOf(quiet.id),[],'a moved worker whose user said nothing that names a skill is given none, though the text names '+JSON.stringify(quietViaHub));
    for(const name of extraQuiet)assert.ok(!quietRequest.tools.includes(name),'and is not offered '+name);
    // What the selection read is stored with the prompt, for the worker's later messages; a worker without a handoff stores nothing new.
    assert.deepEqual(pool.get(nothing.id).prompts.map(prompt=>prompt.selectionText),[NOTHING]);
    assert.deepEqual(pool.get(docker.id).prompts.map(prompt=>prompt.selectionText),[DOCKER]);
    assert.ok(!('selectionText' in pool.get(alone.id).prompts[0]),'a worker without predecessors stores nothing beside its prompt');

    // The worker's next message reads the goal of its first prompt, not the handoff.
    const before=seen.length;
    await pool.continue({id:nothing.id,prompt:'ok'});
    await until(()=>seen.length>before&&pool.get(nothing.id)?.status==='completed','the next message of the worker ran');
    assert.deepEqual(skillsOf(nothing.id),[],'the worker\'s next message is given no skill either');
    for(const name of extra)assert.ok(!seen[before].tools.includes(name),'nor '+name);

    // The moved worker's next message reads the same requests: they stay in its conversation, behind its goal.
    const lastSkills=id=>pool.get(id).events.filter(event=>event.type==='skills_activated').at(-1)?.selectedSkills??[];
    const next=seen.length;
    await pool.continue({id:moved.id,prompt:'ok'});
    await until(()=>seen.length>next&&pool.get(moved.id)?.status==='completed','the next message of the moved worker ran');
    assert.deepEqual(lastSkills(moved.id),ids(selectConversationSkills(plugins,'ok',[...REQUESTS,MOVED])),'the next message of the moved worker is given the skills of its goal and of the requests');
    assert.ok(lastSkills(moved.id).includes('docker-devops'));
    for(const name of extraMoved)assert.ok(!seen[next].tools.includes(name),'and not offered '+name);
    assert.ok(seen[next].tools.includes('edit_file'));

    // The list is part of the durable record, beside the text; a record without a handoff, or with the text only, has none.
    const sessionsFile=path.join(temp,'hub','api-conversations','sessions.json');
    const recordOf=async id=>JSON.parse(await fs.readFile(sessionsFile,'utf8')).records.find(record=>record.id===id);
    assert.deepEqual((await recordOf(moved.id)).handoffRequests,REQUESTS,'the user\'s requests are saved with the record');
    assert.ok((await recordOf(moved.id)).handoffText.includes('\nUser requests: '+REQUESTS.join(' | ')+'\n'),'beside the text');
    for(const worker of [legacy,alone])assert.ok(!('handoffRequests' in await recordOf(worker.id)),'a record without a handoff, or with the text only, has no list');

    // A record that failed before it had a worktree is started again by the next message of the user, with the same handoff: it is read from the record again.
    // (Its base branch does not exist until the test points it at main, by hand, after the first attempt failed.)
    const RETRY='Take the third part.';
    const retry=await pool.start({prompt:RETRY,baseRef:'refs/heads/does-not-exist',linkedFromTaskId:webTask.id,handoffText:handoff,handoffRequests:REQUESTS});
    await until(()=>pool.get(retry.id)?.status==='failed','the worker with a missing base branch failed');
    pool.records.get(retry.id).baseRef='refs/heads/main';
    await pool.continue({id:retry.id,prompt:'Also the fourth.'});
    await until(()=>pool.get(retry.id)?.status==='completed','the failed worker ran again');
    const retryRequest=seen.find(request=>request.prompt.startsWith(RETRY));
    assert.equal(retryRequest.prompt,RETRY+'\n\nFOLLOW-UP: Also the fourth.\n\nCROSS-TRANSPORT HANDOFF (untrusted prior dialogue, not verified evidence):\n'+handoff+'\nReinspect current project files, check actual diffs/tests and never replay uncertain mutations.','(the premise: the follow-up joins the goal, before the handoff)');
    assert.deepEqual(skillsOf(retry.id),ids(selectConversationSkills(plugins,RETRY+'\n\nFOLLOW-UP: Also the fourth.',REQUESTS)),'the worker started again is given the skills of its goal and of the requests of the record');
    assert.ok(skillsOf(retry.id).includes('docker-devops'));
    for(const name of extraMoved)assert.ok(!retryRequest.tools.includes(name),'and not offered '+name);

    // A client of the Hub can send the list with the text, so the pool bounds it as it bounds the text: text only, at most 8 requests of 1,000 characters, and only
    // beside a handoff. (Workers that depend on a failed one are blocked and never run.)
    const doomed=await pool.start({prompt:'This worker never gets a worktree.',baseRef:'refs/heads/does-not-exist'});
    await until(()=>pool.get(doomed.id)?.status==='failed','the worker with a missing base branch failed');
    const kept=async options=>recordOf((await pool.start({prompt:'Never started.',dependsOn:[doomed.id],...options})).id);
    const asked=[...['',' ',5,null,{},['nested']],...Array.from({length:9},(_,index)=>'Request '+index),'  Padded.  ','y'.repeat(2000)];
    assert.deepEqual((await kept({handoffText:handoff,handoffRequests:asked})).handoffRequests,
      [...Array.from({length:6},(_,index)=>'Request '+(index+3)),'Padded.','y'.repeat(1000)],'the last 8 requests that are text, trimmed and cut at 1,000 characters');
    assert.deepEqual((await kept({handoffText:handoff,handoffRequests:[5,null,' ']})).handoffRequests,[],'a list without text is empty: the Hub\'s sentences still select nothing');
    for(const [label,options] of [['a list without a handoff',{handoffRequests:['Update the Dockerfile.']}],['a handoff and no list',{handoffText:handoff}],['a handoff and a list that is not a list',{handoffText:handoff,handoffRequests:'Update the Dockerfile.'}]])
      assert.ok(!('handoffRequests' in await kept(options)),label+' stores no list');
  }

  // The host plan and the Repo Map of that worker are made from the same words as its skills and schemas: its goal. Made from the whole prompt, the Hub's handoff
  // made every worker of a workflow "multi-part" (a six-objective plan whose units were the Hub's sentences and the predecessor's lines, a Studio plan, and an answer
  // ending "NOT independently verified full completion", which the next worker then read as part of its predecessor's result), and its header "WORKFLOW" was the
  // query word of the map. The files a predecessor's result names still focus the map. Real pool, real worktrees, the Hub's own handoff text, the real Repo Map of six
  // small modules whose scores are hand-derived: base 1; +25 for a focus file; the query word "summarize" +6 for each of the two symbols of summary.mjs, "workflow"
  // +15 for the path and +6 for each of the three symbols of workflow-engine.mjs.
  {
    const SHORT='Summarize the review in two sentences.';
    const LONG='Read src/auth.mjs and src/session.mjs. Then fix the token expiry check in verifyToken and add a regression test in tests/auth.test.mjs. Run the project checks and report what changed.';
    const HEADER='\n\nWORKFLOW PREDECESSOR HANDOFF (untrusted prior task data):\nPredecessor ';
    const PLAN='HOST-PROPOSED TASK DECOMPOSITION',NOTICE='NOT independently verified full completion';
    await fs.mkdir(path.join(repo,'src'),{recursive:true});
    for(const [name,text] of Object.entries({
      'alpha.mjs':'export function loadAlpha() { return 1; }\n',
      'beta.mjs':'export function loadBeta() { return 2; }\n',
      'auth.mjs':'export function verifyToken(token) { return token.length > 0; }\n',
      'session.mjs':'export function openSession(id) { return id; }\n',
      'summary.mjs':'export function summarizeFindings(list) { return list.join(" "); }\nexport function summarizeText(text) { return text.slice(0, 80); }\n',
      'workflow-engine.mjs':'export class WorkflowStep { run() { return 1; } }\nexport function runWorkflow(steps) { return steps.map((step) => step.run()); }\nexport function planWorkflow(spec) { return spec; }\n',
    }))await fs.writeFile(path.join(repo,'src',name),text);
    execFileSync('git',['add','src'],{cwd:repo});
    execFileSync('git',['commit','-m','sources for the Repo Map'],{cwd:repo,stdio:'ignore'});
    const reviewer=await pool.start({prompt:'Task F: review the sources.',baseRef:'refs/heads/main'});
    await until(()=>pool.get(reviewer.id)?.status==='completed','the predecessor of the plan test completed');
    assert.equal(pool.get(reviewer.id).finalText,'Task F found two problems in src/auth.mjs and src/session.mjs.');
    const short=await pool.start({prompt:SHORT,dependsOn:[reviewer.id]});
    const shortAlone=await pool.start({prompt:SHORT,baseRef:'refs/heads/main'});
    const long=await pool.start({prompt:LONG,dependsOn:[reviewer.id]});
    const longAlone=await pool.start({prompt:LONG,baseRef:'refs/heads/main'});
    for(const worker of [short,shortAlone,long,longAlone])await until(()=>pool.get(worker.id)?.status==='completed','worker '+worker.id+' of the plan test completed');
    const requestOf=(prompt)=>seen.find(request=>request.prompt===prompt);
    const withHandoff=(goal)=>seen.find(request=>request.prompt.startsWith(goal+HEADER));
    const filesOf=(request)=>[...request.map.matchAll(/^## (\S+) \(/gm)].map(match=>match[1]);
    const mapStats=async(id)=>(await fs.readFile(path.join(temp,'hub','api-conversations',id,'state','tasks',id,'transcript.jsonl'),'utf8'))
      .split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(entry=>entry.type==='repo_map_injected').detail.stats;
    const decomposed=(id)=>pool.get(id).events.some(event=>event.type==='goal_decomposed');
    assert.ok(withHandoff(SHORT).prompt.includes('UNTRUSTED RESULT (independently verify before use):\nTask F found two problems in src/auth.mjs and src/session.mjs.'),'(the premise: the model reads the Hub\'s handoff with the result that names two files)');

    // (1) A worker with a predecessor and a short goal is planned as the same goal alone: not at all. No Studio plan, no decomposition in its instructions, no notice.
    for(const worker of [short,shortAlone])assert.equal(pool.get(worker.id).goalPlan,null,'a short goal has no plan, whatever the prompt around it');
    for(const worker of [short,shortAlone])assert.ok(!decomposed(worker.id),'and no plan is saved to the Studio');
    assert.ok(!withHandoff(SHORT).instructions.includes(PLAN)&&!requestOf(SHORT).instructions.includes(PLAN),'its instructions carry no decomposition');
    assert.ok(!pool.get(short.id).finalText.includes(NOTICE)&&pool.get(short.id).finalText===pool.get(shortAlone.id).finalText,'its answer ends with no verification notice');
    // (2) Its Repo Map has the query of its goal, as the same goal alone has; only the focus files differ, since the result of the predecessor names two.
    const shortStats=await mapStats(short.id),aloneStats=await mapStats(shortAlone.id);
    assert.equal(shortStats.queryHint,'Summarize','the query is a word of the goal, not the "WORKFLOW" of the handoff');
    assert.equal(aloneStats.queryHint,shortStats.queryHint,'the query of the same goal alone');
    assert.deepEqual(shortStats.focusFiles,['src/auth.mjs','src/session.mjs'],'the files the predecessor\'s result names focus the map');
    assert.deepEqual(aloneStats.focusFiles,[]);
    assert.deepEqual(filesOf(withHandoff(SHORT)),['src/auth.mjs','src/session.mjs','src/summary.mjs','src/alpha.mjs','src/beta.mjs','src/workflow-engine.mjs'],
      'the focus files first (26), then summary.mjs by its query (13), then the rest by name');
    assert.deepEqual(filesOf(requestOf(SHORT)),['src/summary.mjs','src/alpha.mjs','src/auth.mjs','src/beta.mjs','src/session.mjs','src/workflow-engine.mjs'],'the same goal alone: summary.mjs by its query (13), the rest by name');
    // (3) A long goal is planned as the same goal alone, without the handoff's sentences among its objectives, and has the query of its own identifier.
    const clauses=['Read src/auth.mjs and src/session.mjs.','fix the token expiry check in verifyToken and add a regression test in tests/auth.test.mjs.','Run the project checks and report what changed.'];
    assert.deepEqual(pool.get(long.id).goalPlan.objectives.map(objective=>objective.text),clauses,'the objectives are the clauses of the goal');
    assert.deepEqual(pool.get(long.id).goalPlan,pool.get(longAlone.id).goalPlan,'the plan of the same goal alone');
    assert.ok(decomposed(long.id)&&decomposed(longAlone.id)&&withHandoff(LONG).instructions.includes(PLAN),'which is saved, and told to the model');
    assert.equal((await mapStats(long.id)).queryHint,'verifyToken');
    assert.deepEqual(await mapStats(long.id),await mapStats(longAlone.id),'and its Repo Map is that of the same goal alone: the goal names the same three files');
    assert.deepEqual((await mapStats(longAlone.id)).focusFiles,['src/auth.mjs','src/session.mjs','tests/auth.test.mjs']);
    // (4) The next worker is not told what the Hub appended to the last one's answer, and the worker's next message is not decomposed from its stored prompt either.
    const next=await pool.start({prompt:'List the open questions.',dependsOn:[short.id]});
    await until(()=>pool.get(next.id)?.status==='completed','the worker after the short one completed');
    const nextPrompt=withHandoff('List the open questions.').prompt;
    assert.ok(nextPrompt.includes('UNTRUSTED RESULT (independently verify before use):\n'+pool.get(short.id).finalText),'(the premise: it reads the answer of the short worker)');
    assert.ok(!nextPrompt.includes('Verification notice'),'which ends with no notice of the Hub\'s');
    assert.equal(pool.get(next.id).goalPlan,null,'a worker after the short one has no plan either');
    const before=seen.length;
    await pool.continue({id:short.id,prompt:'ok'});
    await until(()=>seen.length>before&&pool.get(short.id)?.status==='completed','the next message of the short worker ran');
    assert.equal(pool.get(short.id).goalPlan,null,'the next message of the worker does not decompose its stored prompt');
    assert.ok(!seen[before].instructions.includes(PLAN),'and its instructions carry no decomposition');
    // (5) A predecessor that did end with sentences of the Hub's (the runner records where its words end): the next worker reads the words as its result, and the Hub's
    // sentences apart, under a line that says whose they are. A predecessor with no such record (a task saved before it existed) hands over its text whole, as it always did.
    {
      const WORDS='The fix is in src/auth.mjs.',VERIFICATION='DatGold has NOT independently verified full completion: no check was run.',HOOK='The Stop hook blocked 8 times; the last said Not yet. What that hook checks may not hold.';
      const RECORDED='11111111-1111-4111-8111-111111111111',OLDER='22222222-2222-4222-8222-222222222222';
      const text=WORDS+'\n\n[Verification notice] '+VERIFICATION+'\n\n[Hook notice] '+HOOK;
      const real=pool.get.bind(pool);
      pool.get=(id)=>id===RECORDED?{id:RECORDED,status:'completed',branch:'chatmcp/recorded',worktree:'/w/recorded',finalText:text,finalParts:{words:WORDS,verificationNotice:VERIFICATION,hookNotice:HOOK}}
        :id===OLDER?{id:OLDER,status:'completed',branch:'chatmcp/older',worktree:'/w/older',finalText:text}:real(id);
      let after,older;
      try{
        after=await pool.start({prompt:'List what is left.',dependsOn:[RECORDED]});
        older=await pool.start({prompt:'List what is next.',dependsOn:[OLDER]});
        for(const worker of [after,older])await until(()=>real(worker.id)?.status==='completed','worker '+worker.id+' after a predecessor with sentences of the Hub\'s completed');
      }finally{delete pool.get;}
      const RESULT='UNTRUSTED RESULT (independently verify before use):\n';
      const read=(goal)=>seen.find(request=>request.prompt.startsWith(goal+HEADER)).prompt;
      assert.ok(read('List what is left.').includes('Predecessor '+RECORDED+' (completed) branch=chatmcp/recorded worktree=/w/recorded\n'+RESULT+WORDS+'\nCHATMCP\'S OWN NOTES ABOUT THIS PREDECESSOR (written by the Hub after its run, not its words):\n- '+VERIFICATION+'\n- '+HOOK+'\nPrevious workers used independent worktrees.'),'the result is the predecessor\'s words, and the Hub\'s sentences follow under a line that says whose they are');
      assert.ok(!read('List what is left.').includes('[Verification notice]')&&!read('List what is left.').includes('[Hook notice]'),'the marks the runner joins the sentences with are not in what the worker reads');
      assert.ok(read('List what is next.').includes('Predecessor '+OLDER+' (completed) branch=chatmcp/older worktree=/w/older\n'+RESULT+text+'\nPrevious workers used independent worktrees.'),'a predecessor with no record hands over its text whole, as it always did');
    }
  }

  await pool.shutdown();

  assert.equal(buildUserAttachmentParts([{name:'hello.md',mimeType:'text/markdown',dataBase64:Buffer.from('A text file').toString('base64')}]).parts[0].type,'input_text');
  assert.equal(buildUserAttachmentParts([{name:'photo.png',mimeType:'image/png',dataBase64:'AA=='}]).parts[0].type,'input_image');
  assert.throws(()=>buildUserAttachmentParts([{name:'.env',mimeType:'text/plain',dataBase64:'AA=='}]),/môi trường|khóa/i);

  // What one message may carry is written once (lib/attachment-limits.mjs): a picture up to what the strictest provider takes for one (Amazon Bedrock: 5 MB of base64, which is 3.75 MiB of
  // picture), ten files, 12 MiB in all so that a request with the text and the turns before stays under the 20 MB that Gemini takes inline. A text file keeps 200,000 bytes: its limit is
  // the context window, not the provider's request size. What is refused is answered with the way around it: the project folder, where the agent reads the file with its tools.
  {
    const MiB=1024*1024,advice=/thư mục dự án/;
    const file=(bytes,name='p.png',mimeType='image/png')=>({name,mimeType,dataBase64:Buffer.alloc(bytes,1).toString('base64')});
    assert.deepEqual({...ATTACHMENT_LIMITS},{files:10,imageBytes:3.75*MiB,textBytes:200000,totalBytes:12*MiB},'the limits, in one place');
    assert.equal(ATTACHMENT_BODY_LIMIT>=Math.ceil(ATTACHMENT_LIMITS.totalBytes/3)*4+100000,true,'the body of the request holds the base64 of all the files and a prompt of 100,000 characters');
    assert.deepEqual([3.75*MiB,12*MiB,200000].map(attachmentLimitLabel),['3.75 MB','12 MB','200 KB'],'a limit is written as a person reads it');
    assert.equal(buildUserAttachmentParts([file(3.75*MiB)]).metadata[0].size,3.75*MiB,'a picture of 3.75 MiB is taken');
    assert.throws(()=>buildUserAttachmentParts([file(3.75*MiB+1)]),(error)=>/3\.75 MB/.test(error.message)&&advice.test(error.message)&&error.statusCode===413&&error.code==='image_too_large','one byte more is not, and the message says the limit and the project folder');
    assert.equal(buildUserAttachmentParts(Array.from({length:10},(_,i)=>file(1000,`p${i}.png`))).parts.length,10,'ten files are taken');
    assert.throws(()=>buildUserAttachmentParts(Array.from({length:11},(_,i)=>file(10,`p${i}.png`))),(error)=>/10 tệp/.test(error.message)&&advice.test(error.message)&&error.statusCode===413,'the eleventh is not');
    assert.equal(buildUserAttachmentParts([file(3.75*MiB,'a.png'),file(3.75*MiB,'b.png'),file(3.75*MiB,'c.png'),file(0.75*MiB,'d.png')]).metadata.length,4,'12 MiB in all are taken');
    assert.throws(()=>buildUserAttachmentParts([file(3.75*MiB,'a.png'),file(3.75*MiB,'b.png'),file(3.75*MiB,'c.png'),file(0.75*MiB+1,'d.png')]),(error)=>/12 MB/.test(error.message)&&advice.test(error.message)&&error.code==='attachments_too_large','a byte more than 12 MiB in all is not');
    assert.equal(buildUserAttachmentParts([file(200000,'a.md','text/markdown')]).parts[0].type,'input_text','a text file of 200,000 bytes is taken');
    assert.throws(()=>buildUserAttachmentParts([file(200001,'a.md','text/markdown')]),(error)=>/200 KB/.test(error.message)&&advice.test(error.message)&&error.statusCode===415,'a text file of one byte more is not, and a text file is not given the room of a picture');
    assert.throws(()=>buildUserAttachmentParts([file(13*MiB)]),(error)=>error.code==='attachments_too_large'&&/lớn hơn 12 MB/.test(error.message)&&advice.test(error.message),'a file longer than a whole message is refused before it is decoded, with the way around it');
    // What is base64: whole groups of four, the alphabet, at most two = at the end. (The check that stood here before ran out of stack on a picture of about 4 MB.)
    const named=(dataBase64)=>[{name:'x.png',mimeType:'image/png',dataBase64}];
    for(const bad of ['AAA','A===','AA=A','@@@@','AAAAA','====','AA==AA=='])assert.throws(()=>buildUserAttachmentParts(named(bad)),(error)=>error.code==='invalid_attachment',`${bad} is not base64`);
    for(const good of ['AAAA','AAA=','AA==','QUJD'])assert.equal(buildUserAttachmentParts(named(good)).parts.length,1,`${good} is`);
  }

  const records=[{role:'user',content:[{type:'input_text',text:'Implement API'}]}];
  for(let i=0;i<15;i++){
    const id='f'+i;
    records.push({type:'function_call',name:'read_file',call_id:id,arguments:'{"file":"x"}'});
    records.push({type:'function_call_output',call_id:id,output:'tool report '+i+': '+'x'.repeat(5000)});
  }
  records.push({role:'user',content:[{type:'input_text',text:'Final user instruction'}]});
  assert.ok(estimateTokens(records)>10000);
  const snapshot=structuredClone(records);
  const compacted=compactRollingContext(records,{maxTokens:10000,tailTokens:6000,taskCheckpoint:'Keep API plan'});
  assert.ok(compacted.compacted,'long session should compact');
  assert.deepEqual(records,snapshot,'canonical transcript must not be mutated');
  assert.ok(compacted.history[0].content[0].text.includes('Keep API plan'));
  const calls=new Set(compacted.history.filter(e=>e.type==='function_call').map(e=>e.call_id));
  const results=new Set(compacted.history.filter(e=>e.type==='function_call_output').map(e=>e.call_id));
  assert.deepEqual(calls,results,'all preserved calls have paired results');
  assert.ok(compacted.history.at(-1).content[0].text.includes('Final user instruction'));
  console.log('PASS concurrent worktree chats, dependency gating, live instructions, attachments, paired compact context');
}finally{
  for(const cb of release.values())cb();
  await pool?.shutdown().catch(()=>{});
  await fs.rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:200}).catch(()=>{});
}
