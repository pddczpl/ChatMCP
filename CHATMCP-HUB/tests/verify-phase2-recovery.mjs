import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodingRecoveryJournal} from '../lib/coding-recovery-journal.mjs';
import {CodingWorktreeOrchestrator} from '../lib/coding-orchestrator.mjs';

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
    runId,job:{...record('running'),
      workers:[{id:'alpha',status:'running',commitSha:null,token:'private'}]},
  }),{code:'recovery_bad_worker'});
  await assert.rejects(journal.append({
    runId,job:{...record('running'),apiKey:'must-never-be-written'},
  }),{code:'recovery_bad_snapshot'});

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
  // A *parent* reparse link can be more dangerous than a leaf symlink:
  // mkdir(..., recursive:true) would otherwise follow it outside the
  // configured recovery root before the leaf's lstat check takes place.
  const linkedParent=path.join(root,'journal-parent-link');
  let parentLinkCreated=false;
  try{
    await fs.symlink(path.join(root,'journal'),linkedParent,'dir');
    parentLinkCreated=true;
  }catch(error){
    if(!['EPERM','EACCES','ENOSYS'].includes(error.code))throw error;
  }
  if(parentLinkCreated){
    const outsideJournal=new CodingRecoveryJournal({
      directory:path.join(linkedParent,'nested-recovery'),
    });
    await assert.rejects(outsideJournal.append({
      runId:randomUUID(),job:record('running'),
    }),{code:'recovery_unsafe_directory'});
    assert.equal((await fs.readdir(path.join(root,'journal'))).includes('nested-recovery'),false,
      'Reject reparse ancestor BEFORE recursive mkdir redirects a write');
  }

  const newSafeRun=randomUUID();
  const special=new CodingRecoveryJournal({directory:path.join(root,'journal'),maxEntries:1});
  await special.append({runId:newSafeRun,job:record('preparing')});
  await assert.rejects(special.append({runId:newSafeRun,job:record('running')}),
    {code:'recovery_capacity'});

  // Startup with corrupted jobs.json must remain usable for read-only UI,
  // but refuse NEW coding execution rather than silently losing history.
  const badDirectory=path.join(root,'invalid-coding-state');
  await fs.mkdir(badDirectory);
  await fs.writeFile(path.join(badDirectory,'jobs.json'),'{truncated');
  const makeOrchestrator=(directory)=>new CodingWorktreeOrchestrator({
    manager:{backend:'local',workspace:root},provider:{ready:()=>true},
    bundleRoot:root,directory,createWorker:async()=>({state:'completed'}),
  });
  const invalidState=makeOrchestrator(badDirectory);
  await invalidState.load();
  assert.match(invalidState.state().recoveryFault,/Unreadable saved coding jobs/);
  await assert.rejects(invalidState.run({
    confirmation:'CREATE WORKTREES',tasks:[{id:'coder',prompt:'do not run when unreconciled'}],
  }),{code:'recovery_unresolved'});
  assert.equal(invalidState.state().activeRunId,null);

  // An existing run must NEVER display a stale child as "testing" or
  // "running" after process restart. No model call or Git action is replayed.
  const resumableDir=path.join(root,'saved-coding-state');
  await fs.mkdir(resumableDir);
  const restoredRun=randomUUID();
  const restored={version:1,jobs:[{
    id:restoredRun,workspace:root,baseSha,baseBranch:'main',
    status:'running',workers:[
      {id:'coder',status:'testing',commitSha:null},
      {id:'reviewer',status:'awaiting_test_grant',commitSha:null},
    ],
  }]};
  await fs.writeFile(path.join(resumableDir,'jobs.json'),JSON.stringify(restored));
  // Keep a real checkpoint in the journal, not merely an untrusted UI
  // digest. A recovery acknowledgement must match the latest chain head.
  const realJournal=new CodingRecoveryJournal({
    directory:path.join(resumableDir,'recovery'),
  });
  await realJournal.append({runId:restoredRun,job:{
    status:'running',baseSha,workers:[
      {id:'coder',status:'testing',commitSha:null},
      {id:'reviewer',status:'awaiting_test_grant',commitSha:null},
    ],
  }});
  const restoredOrchestrator=makeOrchestrator(resumableDir);
  await restoredOrchestrator.load();
  const restoredState=restoredOrchestrator.state();
  assert.equal(restoredState.jobs[0].status,'interrupted');
  assert.deepEqual(restoredState.jobs[0].workers.map(w=>w.status),['interrupted','interrupted']);
  assert.equal(restoredState.jobs[0].workers[0].commitSha,null);
  assert.equal(restoredState.recoveryFault,null);
  await assert.rejects(restoredOrchestrator.run({
    confirmation:'CREATE WORKTREES',tasks:[{id:'coder',prompt:'must inspect interrupted job'}],
  }),{code:'recovery_review_required'});
  const proof=await restoredOrchestrator.recoveryStatus({runId:restoredRun});
  assert.match(proof.integrityDigest,/^[a-f0-9]{64}$/);
  assert.equal(proof.autoResume,false);
  await assert.rejects(restoredOrchestrator.acknowledgeRecovery({
    runId:restoredRun,expectedDigest:proof.integrityDigest,
    confirmation:'wrong confirmation',
  }),{code:'confirmation_required'});
  await assert.rejects(restoredOrchestrator.acknowledgeRecovery({
    runId:restoredRun,expectedDigest:'0'.repeat(64),
    confirmation:'REVIEW INTERRUPTED RUN',
  }),{code:'stale_recovery'});
  // If the owner's acknowledgement cannot be durably persisted, do not
  // clear the in-memory interrupted-state barrier or start further tools.
  const originalRename=fs.rename;
  fs.rename=async (source,destination)=>{
    if(destination===path.join(resumableDir,'jobs.json'))
      throw Object.assign(new Error('Injected acknowledgement write error'),{code:'EIO'});
    return originalRename(source,destination);
  };
  try{
    await assert.rejects(restoredOrchestrator.acknowledgeRecovery({
      runId:restoredRun,expectedDigest:proof.integrityDigest,
      confirmation:'REVIEW INTERRUPTED RUN',
    }),{code:'EIO'});
    assert.equal(restoredOrchestrator.state().jobs[0].status,'interrupted');
    await assert.rejects(restoredOrchestrator.run({
      confirmation:'CREATE WORKTREES',tasks:[{id:'coder',prompt:'must remain blocked'}],
    }),{code:'recovery_review_required'});
  }finally{fs.rename=originalRename;}
  // A failed jobs.json rename may advance the journal; fresh digest required.
  const afterFailedAck=await realJournal.inspect(restoredRun);
  assert.equal(afterFailedAck.status,'needs_attention');
  assert.notEqual(afterFailedAck.integrityDigest,proof.integrityDigest);
  await assert.rejects(restoredOrchestrator.acknowledgeRecovery({
    runId:restoredRun,expectedDigest:proof.integrityDigest,
    confirmation:'REVIEW INTERRUPTED RUN',
  }),{code:'stale_recovery'});
  const acknowledged=await restoredOrchestrator.acknowledgeRecovery({
    runId:restoredRun,expectedDigest:afterFailedAck.integrityDigest,
    confirmation:'REVIEW INTERRUPTED RUN',
  });
  assert.equal(acknowledged.status,'needs_attention');
  assert.equal(acknowledged.autoResume,false);
  assert.equal(acknowledged.verificationReceiptsTrusted,false);
  assert.equal(restoredOrchestrator.state().jobs[0].status,'needs_attention');
  await assert.rejects(restoredOrchestrator.acknowledgeRecovery({
    runId:restoredRun,expectedDigest:proof.integrityDigest,
    confirmation:'REVIEW INTERRUPTED RUN',
  }),{code:'recovery_not_interrupted'});
  assert.equal(JSON.parse(await fs.readFile(path.join(resumableDir,'jobs.json'),'utf8'))
    .jobs[0].status,'needs_attention');
  const restartedAcknowledged=makeOrchestrator(resumableDir);
  await restartedAcknowledged.load();
  assert.equal(restartedAcknowledged.state().recoveryFault,null);
  assert.equal(restartedAcknowledged.state().jobs[0].status,'needs_attention');
  assert.deepEqual(restartedAcknowledged.state().jobs[0].workers.map(w=>w.status),
    ['interrupted','interrupted']);
  const reconciled=await restartedAcknowledged.recoveryStatus({runId:restoredRun});
  assert.equal(reconciled.status,'needs_attention');
  assert.equal(reconciled.jobStatus,'needs_attention');
  assert.equal(reconciled.autoResume,false);

  // Crash after writing the journal but before replacing jobs.json:
  // the older jobs file can claim "ready_for_review" while its durable
  // checkpoint reports the opposite. Always invalidate the false PASS.
  const mismatchDir=path.join(root,'mismatched-checkpoint-state');
  await fs.mkdir(mismatchDir);
  const mismatchId=randomUUID();
  const mismatchedJob={
    id:mismatchId,workspace:root,baseSha,baseBranch:'main',
    status:'ready_for_review',
    workers:[{id:'coder',status:'ready_for_review',commitSha:'b'.repeat(40)}],
  };
  await fs.writeFile(path.join(mismatchDir,'jobs.json'),
    JSON.stringify({version:1,jobs:[mismatchedJob]}));
  const latestJournal=new CodingRecoveryJournal({
    directory:path.join(mismatchDir,'recovery'),
  });
  await latestJournal.append({runId:mismatchId,job:{
    status:'running',baseSha,
    workers:[{id:'coder',status:'testing',commitSha:null}],
  }});
  const mismatchController=makeOrchestrator(mismatchDir);
  await mismatchController.load();
  const mismatchedState=mismatchController.state();
  assert.equal(mismatchedState.recoveryFault,null);
  assert.equal(mismatchedState.jobs[0].status,'interrupted');
  assert.equal(mismatchedState.jobs[0].workers[0].status,'interrupted');
  assert.equal(mismatchedState.jobs[0].workers[0].commitSha,'b'.repeat(40));
  assert.match(mismatchedState.jobs[0].error,/Checkpoint and jobs.json disagree/);
  await assert.rejects(mismatchController.run({
    confirmation:'CREATE WORKTREES',
    tasks:[{id:'coder',prompt:'Cannot trust stale success from jobs.json'}],
  }),{code:'recovery_review_required'});
  const disagreementProof=await mismatchController.recoveryStatus({runId:mismatchId});
  assert.equal(disagreementProof.status,'running');
  assert.equal(disagreementProof.jobStatus,'interrupted');
  assert.equal(disagreementProof.autoResume,false);
  // Corrupt or locked checkpoint for a saved run cannot be silently
  // ignored, even if its jobs.json appears clean.
  await fs.writeFile(path.join(mismatchDir,'recovery',mismatchId,'write.lock'),
    'incomplete prior writer',{flag:'wx'});
  const unsafe=makeOrchestrator(mismatchDir);
  await unsafe.load();
  assert.match(unsafe.state().recoveryFault,/Recovery journal unreadable/);
  await assert.rejects(unsafe.run({
    confirmation:'CREATE WORKTREES',
    tasks:[{id:'coder',prompt:'Cannot run with unknown journal state'}],
  }),{code:'recovery_unresolved'});
  console.log('PASS: crash between journal/jobs.json invalidates stale verified worker state');

  const invalidWorkerDir=path.join(root,'invalid-worker-state');
  await fs.mkdir(invalidWorkerDir);
  await fs.writeFile(path.join(invalidWorkerDir,'jobs.json'),
    JSON.stringify({version:1,jobs:[{...restored.jobs[0],workers:[null]}]}));
  const blocked=makeOrchestrator(invalidWorkerDir);
  await blocked.load();
  assert.match(blocked.state().recoveryFault,/Invalid saved coding job schema/);
  await assert.rejects(blocked.run({
    confirmation:'CREATE WORKTREES',tasks:[{id:'coder',prompt:'no unsafe replay'}],
  }),{code:'recovery_unresolved'});
  console.log('PASS: Phase2 corrupt jobs quarantined; restored workers interrupted; no model/Git replay');

  console.log('PASS: Phase2 durable hash-chained checkpoints, crash locks, no secret payload and NO automatic replay');
}finally{
  await fs.rm(root,{recursive:true,force:true});
}
