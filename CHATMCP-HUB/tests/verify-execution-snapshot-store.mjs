import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionSnapshotStore } from '../lib/execution-snapshot-store.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-snapshot-store-'));
try {
  const project=path.join(root,'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project,'app.js'),'export const n=1;\n');
  const store=new ExecutionSnapshotStore({directory:path.join(root,'private')});
  const snapshot=await store.create({workspace:project,files:['app.js'],baseSha:'a'.repeat(40)});
  assert.equal((await store.lookup(snapshot.snapshotId)).contentHash,snapshot.contentHash);
  assert.equal(store.owned.size,1);
  assert.equal(await store.release(snapshot.snapshotId),true);
  assert.equal(store.owned.size,0);
  await assert.rejects(store.lookup(snapshot.snapshotId),{code:'unknown_snapshot'});
  assert.equal(await store.release(snapshot.snapshotId),false);
  const corrupted=await store.create({workspace:project,files:['app.js']});
  await fs.writeFile(path.join(corrupted.directory,'app.js'),'tampered');
  await assert.rejects(store.lookup(corrupted.snapshotId),/snapshot|changed|stale/i);
  await store.release(corrupted.snapshotId);
  console.log('PASS: private immutable snapshot ownership, stale detection, no-replay, bounded cleanup');
} finally {await fs.rm(root,{recursive:true,force:true});}
