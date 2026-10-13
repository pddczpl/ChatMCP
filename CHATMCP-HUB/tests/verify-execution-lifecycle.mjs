import assert from 'node:assert/strict';
import { WindowsSandboxBackend } from '../lib/windows-sandbox-backend.mjs';
const calls = [];
const driver = { async start() { calls.push('start'); return { instanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }; },
  async execute() { calls.push('execute'); return { output: 'fixture' }; },
  async stop() { calls.push('stop'); } };
const noAttestation = new WindowsSandboxBackend({ preflight: async () => ({ available: true, blockers: [] }), driver });
assert.equal((await noAttestation.probe()).available, false);
const response = await noAttestation.execute({ runId:'no-trust',isolationRequired:true,snapshotHash:'x' });
assert.equal(response.status, 'isolation_unavailable');
assert.deepEqual(calls, [], 'guest may not launch without authenticated publisher');
const failed = new WindowsSandboxBackend({ preflight: async () => { throw new Error('probe failed'); } });
assert.equal((await failed.probe()).available, false);
assert.equal(await failed.cancel('missing'), false);
// Inject a pre-registered publisher and driver to exercise the cleanup gate.
 // This cannot certify Windows guest isolation; it proves that an ambiguous
 // stop result cannot be reported as an authenticated successful execution.
const fs = await import('node:fs/promises');
const os = await import('node:os');
const path = await import('node:path');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-backend-exec-'));
const snapshot = { contentHash: 'a'.repeat(64), directory: scratch,
  manifest: { baseSha: null, files: [], contentHash: '' } };
try {
  const { createHash } = await import('node:crypto');
  snapshot.manifest.contentHash = createHash('sha256').update(JSON.stringify({baseSha:null,files:[]})).digest('hex');
  snapshot.contentHash = snapshot.manifest.contentHash;
  await fs.writeFile(path.join(scratch, '.snapshot.json'), JSON.stringify(snapshot.manifest));
  const protectedDriver = {
    async start() { return {instanceId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}; },
    async execute() { return {fixture:true}; },
    async stop() { return {stopped:false}; },
  };
  const backend = new WindowsSandboxBackend({
    stateDirectory:path.join(scratch,'state'),
    preflight:async()=>({available:true,blockers:[]}),
    driver:protectedDriver,
    snapshotLookup:async()=>snapshot,
    publisher:{
      productionAuthenticated:true,
      async verify({request}) {
        const at=new Date().toISOString();
        return {publisherAuthenticated:true,receipt:{
          runId:request.runId,status:'completed',exitCode:0,backend:'windows-sandbox',
          snapshotHash:request.snapshotHash,checkHash:request.checkHash,
          stdout:'ok',stderr:'',startedAt:at,completedAt:at,durationMs:0,truncated:false,reasons:[],
        }};
      }
    },
  });
  const response = await backend.execute({runId:'cleanup-failure',isolationRequired:true,
    snapshotId:'s',snapshotHash:snapshot.contentHash,checkHash:'b'.repeat(64),checkId:'c',
    requiredLimits:[],limits:{timeoutSeconds:2}});
  assert.equal(response.status,'error','unconfirmed stop may not release a previously successful receipt');
  assert.equal(backend.quarantined,true);
  assert.equal((await backend.probe()).available,false);
} finally {
  await fs.rm(scratch,{recursive:true,force:true});
}
// A concurrent status/probe while a valid managed guest is executing must
// report 'busy' without permanently quarantining a successfully stopped run.
const healthyRoot=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-backend-busy-'));
try {
  const contentHash=(await import('node:crypto')).createHash('sha256')
    .update(JSON.stringify({baseSha:null,files:[]})).digest('hex');
  const manifest={schema:1,baseSha:null,files:[],contentHash};
  await fs.writeFile(path.join(healthyRoot,'.snapshot.json'),JSON.stringify(manifest));
  const goodSnapshot={directory:healthyRoot,manifest,contentHash};
  let backend;
  let probeDuringRun=null;
  const instanceId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  backend=new WindowsSandboxBackend({
    stateDirectory:path.join(healthyRoot,'state'),
    preflight:async()=>({available:true,blockers:[]}),
    snapshotLookup:async()=>goodSnapshot,
    driver:{
      async start(){return {instanceId};},
      async execute(){
        probeDuringRun=await backend.probe();
        return {guest:'synthetic fixture'};
      },
      async stop(){return {instanceId,stopped:true};},
    },
    publisher:{productionAuthenticated:true,async verify({request}){
      const now=new Date().toISOString();
      return {publisherAuthenticated:true,receipt:{
        runId:request.runId,backend:'windows-sandbox',status:'completed',exitCode:0,
        stdout:'ok',stderr:'',startedAt:now,completedAt:now,durationMs:1,
        snapshotHash:request.snapshotHash,checkHash:request.checkHash,
        truncated:false,reasons:[],
      }};
    }},
  });
  const result=await backend.execute({
    runId:'healthy-probe',backend:'windows-sandbox',snapshotId:'id',
    snapshotHash:contentHash,checkHash:'c'.repeat(64),isolationRequired:true,
  });
  assert.equal(result.status,'completed','Healthy synthetic cleanup returns a completed receipt.');
  assert.equal(probeDuringRun.available,false,'Shared OS slot is busy while run owns it.');
  assert.equal(backend.quarantined,false,'Active-lock probe must not quarantine a known owner.');
  assert.equal((await backend.probe()).available,true,'Verified slot is available again after cleanup.');
} finally {await fs.rm(healthyRoot,{recursive:true,force:true});}
console.log('PASS: fail-closed unknown publisher/cleanup and healthy active-lock probe without false quarantine');
