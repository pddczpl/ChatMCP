import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodingRecoveryJournal} from '../lib/coding-recovery-journal.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-phase2-recovery-'));
const runId=randomUUID();
const baseSha='a'.repeat(40);
const journal=new CodingRecoveryJournal({directory:path.join(root,'journal')});
const record=(status,workerStatus='queued')=>({
  status,baseSha,workers:[{id:'alpha',status:workerStatus,commitSha:null}],
});
try {
  const missing=await journal.inspect(runId);
  assert.equal(missing.found,false);
  assert.equal(missing.autoResume,false);

  const first=await journal.append({runId,job:record('preparing')});
  assert.equal(first.seq,0);
  const next=await journal.append({runId,job:record('running','testing')});
  assert.equal(next.seq,1);
  const last=await journal.inspect(runId);
  assert.equal(last.status,'running');
  assert.equal(last.interrupted,true);
  assert.equal(last.requiresReview,true);
  assert.equal(last.authenticated,false);
  assert.equal(last.workers[0].status,'testing');
  assert.notEqual(first.integrityDigest,next.integrityDigest);

  await assert.rejects(journal.append({runId:'../secret',job:record('running')}),
    {code:'recovery_bad_run'});
  await assert.rejects(journal.append({
    runId,job:{...record('running'),apiKey:'must-never-be-written',
      workers:[{id:'alpha',status:'running',commitSha:null,token:'private'}]},
  }),{code:'recovery_bad_worker'});

  const runDir=path.join(root,'journal',runId);
  await fs.writeFile(path.join(runDir,'write.lock'),'stale',{flag:'wx'});
  await assert.rejects(journal.inspect(runId),{code:'recovery_locked'});
  await assert.rejects(journal.append({runId,job:record('running')}),
    {code:'recovery_locked'});
  await fs.unlink(path.join(runDir,'write.lock'));

  const oldFile=path.join(runDir,'000001.json');
  const original=await fs.readFile(oldFile,'utf8');
  const corrupt=original.replace('"running"','"completed"');
  await fs.writeFile(oldFile,corrupt);
  await assert.rejects(journal.inspect(runId),{code:'recovery_corrupt'});
  await fs.writeFile(oldFile,original);
  assert.equal((await journal.inspect(runId)).seq,1);
  assert.equal((await fs.readFile(oldFile,'utf8')).includes('must-never-be-written'),false);

  const newRun=randomUUID();
  const linkPath=path.join(root,'journal',newRun);
  let linkReady=false;
  try{
    await fs.symlink(runDir,linkPath,'dir');
    linkReady=true;
  }catch(error){
    // Windows CI may require Developer Mode / SeCreateSymbolicLinkPrivilege.
    // Do not skip the other mandatory security and recovery regressions.
    if(!['EPERM','EACCES','ENOSYS'].includes(error.code))throw error;
  }
  if(linkReady)await assert.rejects(
    journal.append({runId:newRun,job:record('running')}),
    {code:'recovery_unsafe_directory'});
  const newSafeRun=randomUUID();
  const special=new CodingRecoveryJournal({directory:path.join(root,'journal'),maxEntries:1});
  await special.append({runId:newSafeRun,job:record('preparing')});
  await assert.rejects(special.append({runId:newSafeRun,job:record('running')}),
    {code:'recovery_capacity'});

  console.log('PASS: Phase2 durable hash-chained checkpoints, crash locks, no secret payload and NO automatic replay');
}finally{
  await fs.rm(root,{recursive:true,force:true});
}
