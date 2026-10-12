// Scripted offline acceptance manifest. Never invokes paid models, the
// host shell or Windows Sandbox. Counts are deterministic model-free evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runVerifiedCoding } from '../../lib/coding-verification-loop.mjs';
import { deriveChildCapabilities } from '../../lib/worker-capabilities.mjs';
import { WorkerBudget } from '../../lib/worker-budget.mjs';

const file=fileURLToPath(new URL('./manifest.json',import.meta.url));
const manifest=JSON.parse(await fs.readFile(file,'utf8'));
if(manifest.schema!==1||manifest.provider!=='scripted-no-network'||!Array.isArray(manifest.cases)) throw Error('Invalid offline benchmark manifest');
const results=[];
const workerId='bench-worker', checkId='bench-test', grants=['approved-grant'];
const execute=async row=>{
  let contentHash='hash-a';
  let attempts=0;
  const input={ workerId,checks:[checkId],grants,currentContentHash:async()=>contentHash };
  if(row.kind==='coding-loop'){
    const aborted=new AbortController();
    if(row.id==='explicit-cancel')aborted.abort('test stop');
    const repair=async()=>{
      if(row.id==='nonfixable-error') return {changed:false};
      contentHash='hash-b';return {changed:true};
    };
    const broker={
      requestCheck:async()=>{
        attempts++;
        const failed=(row.id==='fixable-repair'&&attempts===1)||row.id==='nonfixable-error';
        if(row.id==='blocked-isolation') return {
          workerId,checkId,id:'p-'+attempts,status:'isolation_unavailable',exitCode:null,
          snapshotHash:contentHash,testOutcomeVerified:false,
        };
        return {workerId,checkId,id:'p-'+attempts,status:failed?'failed':'completed',
          exitCode:failed?1:0,snapshotHash:contentHash,
          testOutcomeVerified:row.id!=='zero-exit-no-tests',
          reasons:failed?['test assertion failure']:[]};
      }
    };
    const value=await runVerifiedCoding({...input,repair,broker,signal:aborted.signal});
    return value.state;
  }
  if(row.id==='authority-escalation'){
    const parent={id:'parent',workspaceScope:process.cwd(),capabilities:{read:true,edit:false,spawn:false,checksRun:false}};
    const result=deriveChildCapabilities({parent,role:'coder',
      requested:['read','edit','checksRun'],workspaceScope:process.cwd()});
    return result.edit||result.checksRun||result.shell ? 'unsafe' : 'blocked';
  }
  if(row.id==='multi-worker-budget'){
    const budget=new WorkerBudget({maxTokens:100});
    budget.reserveWorkerBudget({parentId:'parent',requested:80});
    try{budget.reserveWorkerBudget({parentId:'parent',requested:30});return 'unsafe';}
    catch(e){return e.code==='budget_exceeded'?'blocked':'error';}
  }
  return 'unknown';
};
for(const row of manifest.cases){
  const actual=await execute(row);
  results.push({id:row.id,expected:row.expect,actual,passed:row.expect===actual});
  assert.equal(actual,row.expect,'Benchmark '+row.id+' outcome mismatch');
}
const report={schema:1,modelRequests:0,networkRequests:0,hostCommandExecutions:0,
  total:results.length,passed:results.filter(x=>x.passed).length,
  results,securityNote:'Scripted logic only; NOT guest isolation or real-model correctness evidence.'};
console.log(JSON.stringify(report,null,2));
