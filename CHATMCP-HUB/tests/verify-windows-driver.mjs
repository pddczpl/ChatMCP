import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WindowsSandboxCliDriver, LazyWindowsSandboxDriver } from '../lib/windows-sandbox-driver.mjs';
import { createExecutionSnapshot } from '../lib/execution-snapshots.mjs';
import { reconcileOwnedGuestTestCleanup } from './windows-sandbox/owned-guest-cleanup.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-cli-driver-'));
const workspace=path.join(dir,'workspace');
const state=path.join(dir,'state');
const runtime=path.join(dir,'runtime');
const ownerId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const generation='11111111-2222-3333-4444-555555555555';
const calls=[];
try {
  await fs.mkdir(workspace);await fs.mkdir(runtime);
  const nodeDir=path.join(dir,'node-toolchain');
  await fs.mkdir(nodeDir);
  const nodeBytes=Buffer.from('synthetic test runner');
  await fs.writeFile(path.join(nodeDir,'node.exe'),nodeBytes);
  await fs.writeFile(path.join(nodeDir,'node.exe.sha256'),
    crypto.createHash('sha256').update(nodeBytes).digest('hex')+'  node.exe\n');
  await fs.writeFile(path.join(workspace,'test.js'),'console.log("synthetic");\n');
  const bytes=Buffer.from('synthetic exe');
  await fs.writeFile(path.join(runtime,'GuestSupervisor.exe'),bytes);
  await fs.writeFile(path.join(runtime,'GuestSupervisor.exe.sha256'),
    crypto.createHash('sha256').update(bytes).digest('hex')+'  GuestSupervisor.exe\n');
  const snapshot=await createExecutionSnapshot({workspace,files:['test.js'],outputRoot:path.join(dir,'snapshots')});
  const driver=new WindowsSandboxCliDriver({
    cliPath:path.join(dir,'wsb.exe'),runtimeDirectory:runtime,nodeToolchainDirectory:nodeDir,stateDirectory:state,
    runCli:async(args)=>{
      calls.push(args);
      if (args[0]==='list') return JSON.stringify({WindowsSandboxEnvironments:calls.some(x=>x[0]==='start')&&!calls.some(x=>x[0]==='stop')?[{Id:ownerId}]:[]});
      if (args[0]==='start') return JSON.stringify({Id:ownerId});
      if (args[0]==='stop') return JSON.stringify({Stopped:true});
      if (args[0]==='exec') return JSON.stringify({ExitCode:args[args.indexOf('-c')+1]?.startsWith('robocopy.exe')?1:13});
      throw Error('Unexpected CLI verb');
    }
  });
  const request={runId:'case1',command:'node --test',limits:{timeoutSeconds:7,maxOutputBytes:2048}};
  const started=await driver.start({request,snapshot,generation});
  assert.equal(started.instanceId,ownerId);
  const startArgs=calls.find(x=>x[0]==='start');
  assert.ok(startArgs[2].includes('<Networking>Disable</Networking>'));
  assert.ok(startArgs[2].includes('<ReadOnly>true</ReadOnly>'));
  await assert.rejects(driver.execute({request,instanceId:'00000000-0000-0000-0000-000000000000',generation}),/owned/i);
  const raw=await driver.execute({request,instanceId:ownerId,generation});
  assert.equal(raw.cliExitCode,13);
  assert.equal(raw.publisherAuthenticated,false);
  assert.match(raw.expectedAuthKey,/^[0-9a-f]{64}$/);
  assert.match(raw.expectedNonce,/^[0-9a-f]{64}$/);
  const reqText=await fs.readFile(path.join(state,'run-'+generation,'input','request.json'),'utf8');
  assert.equal(reqText.includes(raw.expectedAuthKey),false,'Key must never appear in guest input');
  assert.equal(calls.at(-1)[calls.at(-1).indexOf('-c')+1].includes('--auth-key'), false, 'Key must never appear on GuestSupervisor command line');
  const stagedRequest=JSON.parse(await fs.readFile(path.join(state,'run-'+generation,'input','request.json'),'utf8'));
  assert.ok(stagedRequest.command.endsWith('\\toolchain\\node.exe'),'guest runs the pinned offline Node binary, never cmd.exe');
  assert.deepEqual(stagedRequest.args,['--test']);
  await assert.rejects(driver.stop({instanceId:ownerId,generation:'33333333-2222-3333-4444-555555555555'}), {code:'sandbox_not_owned'});
  const stopped=await driver.stop({instanceId:ownerId,generation});
  assert.deepEqual(stopped,{stopped:true,instanceId:ownerId});
  assert.equal(driver.owned.size,0);
  const lazyCalls=[];
  const lazy=new LazyWindowsSandboxDriver({
    runtimeDirectory:runtime,nodeToolchainDirectory:nodeDir,
    stateDirectory:path.join(dir,'lazy-state'),
    preflight:async()=>({available:true,details:{cliPath:path.join(dir,'wsb.exe')}}),
    runCli:async(args)=>{
      lazyCalls.push(args);
      if(args[0]==='list')return JSON.stringify({WindowsSandboxEnvironments:
        lazyCalls.some(x=>x[0]==='start')&&!lazyCalls.some(x=>x[0]==='stop')?[{Id:ownerId}]:[]});
      if(args[0]==='start')return JSON.stringify({Id:ownerId});
      if(args[0]==='stop')return JSON.stringify({Stopped:true});
      if(args[0]==='exec')return JSON.stringify({ExitCode:0});
      throw new Error('Unexpected CLI verb');
    },
  });
  const second=await lazy.start({request,snapshot,
    generation:'22222222-3333-4444-5555-666666666666'});
  assert.equal(second.instanceId,ownerId);
  await assert.rejects(lazy.start({request,snapshot,generation}),{code:'sandbox_busy'});
  const again=await lazy.execute({request,instanceId:ownerId,
    generation:'22222222-3333-4444-5555-666666666666'});
  assert.equal(again.publisherAuthenticated,false);
  assert.equal((await lazy.stop({instanceId:ownerId,
    generation:'22222222-3333-4444-5555-666666666666'})).stopped,true);
  // Test cleanup must never stop an unrelated user's Sandbox discovered
  // during diagnostic execution.
  const otherId='77777777-8888-4999-aaaa-bbbbbbbbbbbb';
  const stopCalls=[];
  const ownerMap=new Map([[ownerId,{generation}]]);
  const fakeOwner={delegate:{owned:ownerMap},async stop({instanceId}){
    stopCalls.push(instanceId);ownerMap.delete(instanceId);
    return {stopped:true,instanceId};
  }};
  await assert.rejects(
    reconcileOwnedGuestTestCleanup({driver:fakeOwner,listRunning:async()=>[{Id:otherId}]}),
    {code:'sandbox_cleanup_blocked'}
  );
  assert.deepEqual(stopCalls,[ownerId],
    'Only the positively owned instance may be stopped');
  assert.equal(stopCalls.includes(otherId),false,'Never stop unowned UUID');
  const healthyOwner={
    delegate:{owned:new Map([[ownerId,{generation}]])},
    async stop({instanceId,generation:gotGeneration}){
      assert.equal(instanceId,ownerId);assert.equal(gotGeneration,generation);
      this.delegate.owned.delete(instanceId);
      return {stopped:true,instanceId};
    }
  };
  const checked=await reconcileOwnedGuestTestCleanup({
    driver:healthyOwner,listRunning:async()=>[],
  });
  assert.equal(checked.verified,true);
  assert.equal(checked.unownedStopped,0);
  console.log('PASS: pinned runtime, lifecycle, and diagnostic cleanup never stops unowned Sandbox');
} finally { await fs.rm(dir,{recursive:true,force:true}); }
