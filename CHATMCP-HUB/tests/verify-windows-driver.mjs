import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WindowsSandboxCliDriver } from '../lib/windows-sandbox-driver.mjs';
import { createExecutionSnapshot } from '../lib/execution-snapshots.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-cli-driver-'));
const workspace=path.join(dir,'workspace');
const state=path.join(dir,'state');
const runtime=path.join(dir,'runtime');
const ownerId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const generation='11111111-2222-3333-4444-555555555555';
const calls=[];
try {
  await fs.mkdir(workspace);await fs.mkdir(runtime);
  await fs.writeFile(path.join(workspace,'test.js'),'console.log("synthetic");\n');
  const bytes=Buffer.from('synthetic exe');
  await fs.writeFile(path.join(runtime,'GuestSupervisor.exe'),bytes);
  await fs.writeFile(path.join(runtime,'GuestSupervisor.exe.sha256'),
    crypto.createHash('sha256').update(bytes).digest('hex')+'  GuestSupervisor.exe\n');
  const snapshot=await createExecutionSnapshot({workspace,files:['test.js'],outputRoot:path.join(dir,'snapshots')});
  const driver=new WindowsSandboxCliDriver({
    cliPath:path.join(dir,'wsb.exe'),runtimeDirectory:runtime,stateDirectory:state,
    runCli:async(args)=>{
      calls.push(args);
      if (args[0]==='list') return JSON.stringify({WindowsSandboxEnvironments:calls.some(x=>x[0]==='start')&&!calls.some(x=>x[0]==='stop')?[{Id:ownerId}]:[]});
      if (args[0]==='start') return JSON.stringify({Id:ownerId});
      if (args[0]==='stop') return JSON.stringify({Stopped:true});
      if (args[0]==='exec') return JSON.stringify({ExitCode:13});
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
  assert.ok(await fs.readFile(path.join(state,'run-'+generation,'input','request.json'),'utf8').then(x=>x.includes('cmd.exe')));
  await assert.rejects(driver.stop({instanceId:ownerId,generation:'33333333-2222-3333-4444-555555555555'}),/owned/i);
  const stopped=await driver.stop({instanceId:ownerId,generation});
  assert.deepEqual(stopped,{stopped:true,instanceId:ownerId});
  assert.equal(driver.owned.size,0);
  console.log('PASS: private staging, hardened guest mapping, owned CLI lifecycle, no trusted output claim');
} finally { await fs.rm(dir,{recursive:true,force:true}); }
