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
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { WorkspaceRegistry } from '../lib/workspace-registry.mjs';
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
    async respond({input,tools=[]}){
      // Installed skills now reach the model as a leading user message (UNTRUSTED SKILL REFERENCES); the task prompt is the first message after it.
      const firstUser=input.find(x=>x?.role==='user'&&Array.isArray(x.content)&&!String(x.content[0]?.text||'').startsWith('UNTRUSTED SKILL REFERENCES'));
      const contents=(firstUser?.content||[]).map(x=>x?.text||'').join(' ');
      seen.push({prompt:String(firstUser?.content?.[0]?.text||''),tools:tools.map(tool=>tool.name)});
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
    // A worker that continues a conversation of another transport has no predecessors: its prompt is its goal and the dialogue it carries.
    const MOVED='Continue with the second part.';
    const moved=await pool.start({prompt:MOVED,baseRef:'refs/heads/main',
      handoffText:'Previous conversation task '+second.id+' (chatgpt-web).\nUser requests: '+DOCKER+'\nPrevious task status: completed.'});
    for(const worker of [nothing,docker,alone,moved])await until(()=>pool.get(worker.id)?.status==='completed','worker '+worker.id+' of the handoff test completed');
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
    // The dialogue a worker carries from another transport is its own words: it is selected on, together with the goal, exactly as before.
    const movedRequest=seen.find(request=>request.prompt.startsWith(MOVED));
    assert.ok(movedRequest.prompt.includes('CROSS-TRANSPORT HANDOFF (untrusted prior dialogue, not verified evidence):\nPrevious conversation task '+second.id)&&!movedRequest.prompt.includes(HANDOFF),'(the premise: a worker moved from another transport reads its dialogue, and has no predecessors)');
    assert.ok(skillsOf(moved.id).includes('docker-devops'),'a worker moved from another transport is given the skill of the dialogue it carries');
    assert.deepEqual(skillsOf(moved.id),ids(selectConversationSkills(plugins,movedRequest.prompt)),'and exactly the skills its whole prompt selects, as before');
    assert.ok(!('selectionText' in pool.get(moved.id).prompts[0]),'which stores nothing beside its prompt');
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
  }

  await pool.shutdown();

  assert.equal(buildUserAttachmentParts([{name:'hello.md',mimeType:'text/markdown',dataBase64:Buffer.from('A text file').toString('base64')}]).parts[0].type,'input_text');
  assert.equal(buildUserAttachmentParts([{name:'photo.png',mimeType:'image/png',dataBase64:'AA=='}]).parts[0].type,'input_image');
  assert.throws(()=>buildUserAttachmentParts([{name:'.env',mimeType:'text/plain',dataBase64:'AA=='}]),/môi trường|khóa/i);

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
