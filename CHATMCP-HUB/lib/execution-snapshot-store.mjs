// Trusted, run-owned immutable snapshots. No host execution or retries.
// Only the Hub may create/lookup/release entries; models see opaque IDs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createExecutionSnapshot, verifyExecutionSnapshot } from './execution-snapshots.mjs';
import { fault } from './execution-contract.mjs';

export class ExecutionSnapshotStore {
  constructor({directory}={}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw fault('invalid_snapshot_store','Snapshot staging directory must be an absolute trusted Hub path.');
    }
    this.directory=path.resolve(directory);
    this.owned=new Map();
  }
  async create(options={}) {
    const snapshot=await createExecutionSnapshot({...options,outputRoot:this.directory});
    if (this.owned.has(snapshot.snapshotId)) throw fault('duplicate_snapshot','Snapshot UUID is already active.');
    this.owned.set(snapshot.snapshotId,snapshot);
    return snapshot;
  }
  async lookup(id) {
    if (typeof id!=='string' || !this.owned.has(id)) {
      throw fault('unknown_snapshot','Unknown or interrupted snapshot; automatic replay forbidden.',404);
    }
    const snapshot=this.owned.get(id);
    await verifyExecutionSnapshot(snapshot);
    return snapshot;
  }
  async release(id) {
    const snapshot=this.owned.get(id);
    if (!snapshot) return false;
    const dir=path.resolve(snapshot.directory);
    const relative=path.relative(this.directory,dir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw fault('unsafe_cleanup','Snapshot deletion escaped the private staging root.');
    }
    const stat=await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw fault('unsafe_cleanup','Snapshot directory was replaced by a reparse entry.');
    }
    await fs.rm(dir,{recursive:true,force:true});
    this.owned.delete(id);
    return true;
  }
}
