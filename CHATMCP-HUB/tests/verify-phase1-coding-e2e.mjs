// Full local worktree AgentRunner -> check grants -> signed fake receipt
// -> model repair -> recheck. This is a SCRIPTED backend fixture, not OS proof.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { CodingWorktreeOrchestrator } from '../lib/coding-orchestrator.mjs';
import { ExecutionBackend, validateCapabilityReport, validateExecutionReceipt } from '../lib/execution-contract.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-phase1-autocoding-'));
const work=path.join(root,'project');
const state=path.join(root,'state');
const git=args=>execFileSync('git',args,{cwd:work,encoding:'utf8',timeout:15000,windowsHide:true});
const TAP='TAP version 13\n# Subtest: repaired\nok 1 - repaired\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 3\n';
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
      stdout:failure?'TAP version 13\nnot ok 1 - broken\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n':TAP,
      stderr:'',startedAt:stamp,completedAt:stamp,durationMs:1,
      backend:'windows-sandbox',snapshotHash:request.snapshotHash,checkHash:request.checkHash,
      truncated:false,evidencePath:null,reasons:failure?['Assertion failed']:[],
    });
    return Object.freeze({...receipt,publisherAuthenticated:true,provenance:'publisher_authenticated'});
  }
  async cancel(){return true;}
}
try {
  await fs.mkdir(work);
  git(['init','-b','main']);
  git(['config','user.name','Phase1 CI']);
  git(['config','user.email','phase1@example.invalid']);
  await fs.writeFile(path.join(work,'package.json'),JSON.stringify({
    name:'chatmcp-test-project',version:'0.0.1',type:'module',scripts:{test:'node --test'}
  }));
  await fs.writeFile(path.join(work,'example.test.mjs'),"import {test} from 'node:test'; test('placeholder',()=>{});\n");
  git(['add','.']);git(['commit','-m','baseline']);
  const parent=new HubManager({bundleRoot:path.resolve('.'),dataDirectory:state,backend:'local',log:()=>{}});
  await parent.load(work);
  assembleStudio(parent,{bundleRoot:path.resolve('.')});
  parent.permissions.mode='autonomous';
  await parent.startLocal();
  const backend=new FakeIsolatedBackend();
  parent.executionRegistry.register(backend);
  let calls=0;
  const provider={
    ready:()=>true,snapshot:()=>({provider:'fake',model:'fixture'}),
    async respond({tools}) {
      calls++;
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
    tasks:[{id:'coder',prompt:'Produce one small JS change, then repair when the broker test fails.',verify:true}],
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
  assert.equal(checks.length,1,'Pinned node --test from package.json');
  assert.equal(checks[0].command,'node --test');
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
  await parent.shutdown();
  console.log('PASS: scripted real AgentRunner edited, approved immutable checks ran, failed, repaired and passed; no host commands or merge.');
} finally {
  await fs.rm(root,{recursive:true,force:true});
}
