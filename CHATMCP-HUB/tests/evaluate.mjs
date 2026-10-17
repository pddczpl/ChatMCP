#!/usr/bin/env node
// Reproducible deterministic contract evaluations. These execute real local
// test processes and inspect exit receipts; they DO NOT grade model capability
// or claim parity with commercial coding agents. No live API call is made.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hub=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repo=path.resolve(hub,'..');
const FIXTURE_VERSION='chatmcp-deterministic-v1';
export const CASES=Object.freeze([
  {id:'repository-exploration',suite:'verify-e2e-git.mjs',coverage:'behavioral-local-git'},
  {id:'targeted-bugfix',suite:'verify-e2e-bugfix.mjs',coverage:'behavioral-scripted-model'},
  {id:'multi-file-implementation',suite:'verify-e2e-fastapi.mjs',coverage:'behavioral-scripted-model'},
  {id:'refactoring',suite:'verify-lsp-refactor.mjs',coverage:'behavioral-real-fixture'},
  {id:'failed-test-repair',suite:'verify-coding-loop.mjs',coverage:'scripted-broker-partial'},
  {id:'long-context',suite:'verify-smart-context-compaction.mjs',coverage:'behavioral-fixture'},
  {id:'interrupted-recovery',suite:'verify-e2e-recovery.mjs',coverage:'behavioral-local-hub'},
  {id:'multiagent-code-dependencies',suite:'verify-phase3-worktrees.mjs',coverage:'scripted-worktree-partial'},
  {id:'browser-verification',suite:'verify-browser-web-workspaces.mjs',coverage:'scripted-browser-partial'},
  {id:'provider-telemetry',suite:'verify-request-budget.mjs',coverage:'fixture-http-retries'},
]);

const checksum=value=>createHash('sha256').update(value).digest('hex');
const git=(...args)=>{
  const r=spawnSync('git',args,{cwd:repo,encoding:'utf8',timeout:10000,windowsHide:true});
  return r.status===0?r.stdout.trim():null;
};
function argumentsOf(argv){
  const o={ids:[],all:false,list:false,output:null};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];
    if(key==='--all')o.all=true;
    else if(key==='--list')o.list=true;
    else if(key==='--case'){
      const id=argv[++i];if(!id)throw Error('--case requires an evaluation ID');
      o.ids.push(id);
    }else if(key==='--output'){
      const dest=argv[++i];if(!dest)throw Error('--output needs a file path');
      o.output=path.resolve(dest);
    }else if(key==='--live'){
      throw Error('Live evaluation is not enabled by this deterministic harness. Authorized provider access and an explicit monetary budget need a separate live runner.');
    }else throw Error('Unknown argument: '+key);
  }
  if(!o.list && !o.all && !o.ids.length)throw Error('Select --case <id> or --all; use --list to inspect fixtures.');
  if(o.all && o.ids.length)throw Error('Use --all or --case, not both.');
  const ids=o.all?CASES.map(c=>c.id):[...new Set(o.ids)];
  for(const id of ids)if(!CASES.some(c=>c.id===id))throw Error('Unknown evaluation ID: '+id);
  return {...o,ids};
}

async function executeFixture(item) {
  const started=Date.now();
  const tmp=await mkdtemp(path.join(tmpdir(),'chatmcp-eval-'));
  const evidence=path.join(tmp,'suite.json');
  const args=['tests/run-all.mjs','--filter',item.suite,'--timeout','240',
    '--no-skip','all','--json',evidence];
  let tail='', exit=null, signal=null, spawnError=null, elapsed=0;
  try{
    await new Promise(resolve=>{
      const child=spawn(process.execPath,args,{cwd:hub,windowsHide:true,
        env:{...process.env,CHATMCP_EVAL_FIXTURE:'1'},
        stdio:['ignore','pipe','pipe']});
      let ended=false;
      const finish=()=>{if(!ended){ended=true;resolve();}};
      const collect=data=>{tail=(tail+String(data)).slice(-20000);};
      child.stdout.on('data',collect);child.stderr.on('data',collect);
      child.on('error',e=>{spawnError=e.message;finish();});
      child.on('close',(code,sig)=>{exit=code;signal=sig;finish();});
    });
    let parsed=null;
    try{parsed=JSON.parse(await readFile(evidence,'utf8'));}catch{}
    const record=parsed?.results?.find(r=>r.name===item.suite);
    const exact=Array.isArray(parsed?.results)&&parsed.results.length===1&&record;
    const outcome=!exact?'unknown':record.status==='PASS'&&exit===0?'pass':
      record.status==='SKIP'?'not-run':'fail';
    elapsed=Date.now()-started;
    return {
      evaluationId:item.id,fixtureVersion:FIXTURE_VERSION,scope:item.coverage,
      taskId:null, // fixture suites may create several internal task IDs
      outcome,grading:'external_test_process_exit_and_assertions',
      durationMs:elapsed,
      model:{kind:'fixture',provider:null,model:null,profile:null,liveRequests:false},
      tokenUsage:null,costUsd:null,
      verification:{suite:item.suite,command:[process.execPath,...args],
        cwd:hub,exitCode:exit,signal,reportedStatus:record?.status??null,
        testDurationMs:record?.milliseconds??null,
        skipped:record?.status==='SKIP',evidenceDigest:parsed?checksum(JSON.stringify(parsed)):null},
      failureReason:spawnError??(!exact?'missing_or_ambiguous_suite_receipt':
        outcome==='pass'?null:record.note||('process_exit_'+String(exit))),
    };
  }finally{await rm(tmp,{recursive:true,force:true});}
}
export async function evaluate(ids) {
  const startedAt=new Date().toISOString();
  const outcomes=[];
  for(const id of ids)outcomes.push(await executeFixture(CASES.find(c=>c.id===id)));
  return {
    schema:'chatmcp-deterministic-evaluation-v1',
    fixtureVersion:FIXTURE_VERSION,
    source:{commit:git('rev-parse','HEAD'),dirty:(git('status','--porcelain')||'').length>0},
    runtime:{node:process.version,platform:process.platform,arch:process.arch},
    startedAt,completedAt:new Date().toISOString(),
    kind:'deterministic-regression-not-live-model',
    cases:outcomes,
    liveModelEvaluation:{outcome:'not-run',reason:'no authorized live-model evaluation or explicit budget'},
    warning:'PASS means the named external regression suite passed; it is not proof of broad coding-agent quality or parity.',
  };
}
async function main(){
  let o;
  try{o=argumentsOf(process.argv.slice(2));}
  catch(e){console.error(e.message);return 2;}
  if(o.list){for(const c of CASES)console.log(c.id+'\t'+c.suite+'\t'+c.coverage);return 0;}
  const report=await evaluate(o.ids);
  if(o.output){
    await mkdir(path.dirname(o.output),{recursive:true});
    await writeFile(o.output,JSON.stringify(report,null,2)+'\n','utf8');
    console.log('Evaluation report: '+o.output);
  }
  for(const x of report.cases)console.log(x.outcome.toUpperCase()+' '+x.evaluationId+' '+x.durationMs+' ms ('+x.verification.suite+')');
  return report.cases.every(x=>x.outcome==='pass')?0:1;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.exitCode=await main();
}
