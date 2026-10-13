// Phase 2 deterministic reliability benchmark: real temporary journal/files,
// scripted source previews, NO AI provider, network, shell, Windows guest or Git.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodingRecoveryJournal} from '../../lib/coding-recovery-journal.mjs';
import {previewManagedCodingContext} from '../../lib/coding-context-preview.mjs';

const base=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-phase2-bench-'));
const results=[];
const test=async(id,expected,fn)=>{
  const observed=await fn();
  results.push({id,expected,observed,pass:observed===expected});
  assert.equal(observed,expected,'Phase2 reliability benchmark: '+id);
};
try{
  const journal=new CodingRecoveryJournal({directory:path.join(base,'journal')});
  const runId=randomUUID(),record={
    status:'running',baseSha:'a'.repeat(40),
    workers:[{id:'coder',status:'testing',commitSha:null}],
  };
  await test('missing-checkpoint','review_required',async()=>{
    const report=await journal.inspect(randomUUID());
    return !report.found&&report.autoResume===false?'review_required':'unsafe';
  });
  await journal.append({runId,job:record});
  await test('journal-hash-chain','readable',async()=>{
    const record=await journal.inspect(runId);
    return record.found&&record.entries===1&&record.integrityDigest.length===64?'readable':'corrupt';
  });
  await test('no-automatic-replay','blocked',async()=>{
    const state=await journal.inspect(runId);
    return state.autoResume||!state.requiresReview?'unsafe':'blocked';
  });
  const journalDir=path.join(base,'journal',runId);
  await fs.writeFile(path.join(journalDir,'write.lock'),'unfinished',{flag:'wx'});
  await test('unfinished-writer-lock','blocked',async()=>{
    try{await journal.inspect(runId);return 'unsafe';}
    catch(error){return error.code==='recovery_locked'?'blocked':'unexpected';}
  });
  await fs.unlink(path.join(journalDir,'write.lock'));
  const eventPath=path.join(journalDir,'000000.json');
  const unchanged=await fs.readFile(eventPath,'utf8');
  await fs.writeFile(eventPath,unchanged.replace('"running"','"completed"'));
  await test('tampered-event','rejected',async()=>{
    try{await journal.inspect(runId);return 'unsafe';}
    catch(error){return error.code==='recovery_corrupt'?'rejected':'unexpected';}
  });
  await fs.writeFile(eventPath,unchanged);
  await test('path-traversal-id','rejected',async()=>{
    try{await journal.inspect('../outside');return 'unsafe';}
    catch(error){return error.code==='recovery_bad_run'?'rejected':'unexpected';}
  });
  const capped=new CodingRecoveryJournal({directory:path.join(base,'capped'),maxEntries:1});
  const capId=randomUUID();
  await capped.append({runId:capId,job:record});
  await test('bounded-event-count','rejected',async()=>{
    try{await capped.append({runId:capId,job:record});return 'unsafe';}
    catch(error){return error.code==='recovery_capacity'?'rejected':'unexpected';}
  });
  const source=path.join(base,'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source,'code.ts'),'export const safe=1;\n');
  await fs.writeFile(path.join(source,'.env'),'SHOULD_NOT_APPEAR_IN_PREVIEW\n');
  const preview=await previewManagedCodingContext({
    worktree:source,changedFiles:['.env','code.ts'],
  });
  await test('context-sensitive-path','excluded',async()=>
    preview.files.length===1&&!JSON.stringify(preview).includes('SHOULD_NOT_APPEAR')&&
    preview.skipped.some(v=>v.reason==='sensitive_path')?'excluded':'unsafe');
  await test('context-not-sent-to-model','review_only',async()=>
    preview.sentToModel===false&&preview.testOutcomeAuthenticated===false?'review_only':'unsafe');
  const report={schema:1,phase:2,kind:'scripted-no-network',
    total:results.length,passed:results.filter(x=>x.pass).length,results,
    modelRequests:0,hostCommandExecutions:0,networkRequests:0,
    windowsGuestAttested:false,
    note:'Offline local reliability outcomes only. NOT verified OS publisher proof.',
  };
  console.log(JSON.stringify(report));
}finally{
  await fs.rm(base,{recursive:true,force:true});
}
