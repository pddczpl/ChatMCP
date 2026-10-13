// Phase 2: crash-consistent, append-only coding progress journal.
//
// This records ONLY bounded Hub-owned workflow metadata, never prompts,
// credentials, model text, shell commands, project files or test assertions.
// SHA-256 detects accidental disk corruption and inconsistent history. It is
// NOT a signature, a Windows Sandbox security boundary, or test attestation.
// Unfinished jobs require human review; never automatically replay tools.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const RUN=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const WORKER=/^[a-z][a-z0-9-]{0,30}$/;
const STATUS=/^[a-z][a-z0-9_]{0,39}$/;
const SHA=/^[a-f0-9]{40}$/i;
const HASH=/^[a-f0-9]{64}$/i;
const ZEROS='0'.repeat(64);
const FILE=(i)=>String(i).padStart(6,'0')+'.json';

function invalid(code,message){
  return Object.assign(new Error(message),{code});
}
function validateRun(id) {
  if(typeof id!=='string'||!RUN.test(id))
    throw invalid('recovery_bad_run','A trusted canonical UUID is required.');
  return id.toLowerCase();
}

// Fail closed on symlink/junction ancestors of the trusted journal root,
// not only at the final per-run directory. This prevents an unexpected
// pre-existing reparse path from redirecting recovery metadata elsewhere.
// As with all host path checks, this is not an OS race/isolation boundary
// against an attacker with concurrent host-account filesystem access.
async function checkJournalAncestors(destination) {
  const root=path.parse(destination).root;
  let cursor=root;
  for(const part of path.relative(root,destination).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);
    let entry;
    try{entry=await fs.lstat(cursor);}
    catch(error){
      if(error?.code==='ENOENT')continue;
      throw error;
    }
    if(entry.isSymbolicLink()||!entry.isDirectory())
      throw invalid('recovery_unsafe_directory',
        'Recovery journal directory ancestor is a reparse link or not a directory.');
  }
}

function sanitizeJob(data) {
  if(!data||typeof data!=='object'||Array.isArray(data)||
     Object.keys(data).some(key=>!['status','baseSha','workers'].includes(key))||
     !STATUS.test(data.status||'')||
     typeof data.baseSha!=='string'||!SHA.test(data.baseSha)||
     !Array.isArray(data.workers)||data.workers.length>32)
    throw invalid('recovery_bad_snapshot','Only bounded trusted job status metadata can be recorded.');
  const seen=new Set();
  const workers=data.workers.map(w=>{
    if(!w||typeof w!=='object'||Array.isArray(w)||
      Object.keys(w).some(key=>!['id','status','commitSha'].includes(key))||
      !WORKER.test(w.id||'')||!STATUS.test(w.status||'')||
      (w.commitSha!=null&&(!SHA.test(w.commitSha)))||seen.has(w.id))
      throw invalid('recovery_bad_worker','Invalid or repeated worker checkpoint.');
    seen.add(w.id);
    return {id:w.id,status:w.status,commitSha:w.commitSha??null};
  });
  return {status:data.status,baseSha:data.baseSha.toLowerCase(),workers};
}
const digest=(data)=>createHash('sha256').update(JSON.stringify(data)).digest('hex');

export class CodingRecoveryJournal {
  constructor({directory,maxEntries=1024}={}) {
    if(typeof directory!=='string'||!path.isAbsolute(directory)||
      !Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>4096)
      throw invalid('recovery_bad_config','A trusted absolute directory and bounded journal are required.');
    this.directory=path.resolve(directory);
    this.maxEntries=maxEntries;
  }

  async #runDir(runId,{create=false}={}){
    const dir=path.join(this.directory,validateRun(runId));
    await checkJournalAncestors(dir);
    if(create)await fs.mkdir(dir,{recursive:true,mode:0o700});
    await checkJournalAncestors(dir);
    const stat=await fs.lstat(dir).catch(error=>{
      if(error.code==='ENOENT')return null;
      throw error;
    });
    if(!stat)return null;
    if(!stat.isDirectory()||stat.isSymbolicLink())
      throw invalid('recovery_unsafe_directory','Refusing a replaced/reparse journal directory.');
    return dir;
  }

  async #scan(dir,{ignoreWriteLock=false}={}){
    const names=await fs.readdir(dir);
    if(names.includes('write.lock')&&!ignoreWriteLock)
      throw invalid('recovery_locked','Uncertain prior writer; manual reconciliation required.');
    const journals=names.filter(name=>name!== 'write.lock');
    if(journals.some(x=>!/^[0-9]{6}\.json$/.test(x))||
       journals.length>this.maxEntries)
      throw invalid('recovery_unknown_entry','Unknown or unbounded recovery journal entries.');
    journals.sort();
    const entries=[];
    let predecessor=ZEROS;
    for(let i=0;i<journals.length;i++){
      if(journals[i]!==FILE(i))
        throw invalid('recovery_gap','Recovery event sequence has a gap/reordering.');
      const file=path.join(dir,journals[i]);
      const st=await fs.lstat(file);
      if(!st.isFile()||st.isSymbolicLink()||st.size<1||st.size>16384||st.nlink!==1)
        throw invalid('recovery_unsafe_entry','Recovery event is a link or oversized/unreadable.');
      const raw=await fs.readFile(file,'utf8');
      let value;
      try{value=JSON.parse(raw);}catch{
        throw invalid('recovery_corrupt','Recovery entry JSON was truncated or corrupted.');
      }
      if(!value||typeof value!=='object'||Array.isArray(value)||
        Object.keys(value).sort().join(',')!==
          'at,baseSha,digest,prevDigest,runId,seq,status,v,workers' ||
        value.runId!==path.basename(dir)||
        value.v!==1||value.seq!==i||typeof value.at!=='string'||
        !STATUS.test(value.status||'')||!SHA.test(value.baseSha||'')||
        !HASH.test(value.prevDigest||'')||!HASH.test(value.digest||'')||
        value.prevDigest!==predecessor||!Array.isArray(value.workers))
        throw invalid('recovery_corrupt','Recovery event schema or chain mismatch.');
      const normalized=sanitizeJob({status:value.status,baseSha:value.baseSha,workers:value.workers});
      if(JSON.stringify(normalized.workers)!==JSON.stringify(value.workers))
        throw invalid('recovery_corrupt','Recovery event contained unexpected worker fields.');
      const {digest:received,...body}=value;
      if(digest(body)!==received)
        throw invalid('recovery_corrupt','Recovery event integrity mismatch.');
      predecessor=received;
      entries.push(value);
    }
    return entries;
  }

  async append({runId,job}={}){
    const id=validateRun(runId);
    const state=sanitizeJob(job);
    const dir=await this.#runDir(id,{create:true});
    let lock;
    try{
      lock=await fs.open(path.join(dir,'write.lock'),'wx',0o600);
    }catch(error){
      if(error.code==='EEXIST')
        throw invalid('recovery_locked','An unfinished or concurrent journal writer exists; do not auto-replay.');
      throw error;
    }
    try{
      const entries=await this.#scan(dir,{ignoreWriteLock:true});
      if(entries.length>=this.maxEntries)
        throw invalid('recovery_capacity','Recovery journal full; human review required.');
      const last=entries.at(-1);
      const body={
        v:1,seq:entries.length,at:new Date().toISOString(),
        runId:id,status:state.status,baseSha:state.baseSha,
        workers:state.workers,prevDigest:last?.digest??ZEROS,
      };
      const event={...body,digest:digest(body)};
      const output=path.join(dir,FILE(body.seq));
      const handle=await fs.open(output,'wx',0o600);
      try{
        await handle.writeFile(JSON.stringify(event)+'\n','utf8');
        await handle.sync();
      }finally{await handle.close();}
      return Object.freeze({runId:id,seq:body.seq,status:body.status,
        integrityDigest:event.digest,authenticated:false,replayAllowed:false});
    }finally{
      await lock.close();
      await fs.unlink(path.join(dir,'write.lock')).catch(()=>{
        // A stale lock makes all future writers fail-closed.
      });
    }
  }

  async inspect(runId){
    const id=validateRun(runId);
    const dir=await this.#runDir(id);
    if(!dir)return Object.freeze({runId:id,found:false,autoResume:false,requiresReview:true});
    const entries=await this.#scan(dir);
    if(!entries.length)
      return Object.freeze({runId:id,found:false,autoResume:false,requiresReview:true});
    const last=entries.at(-1);
    return Object.freeze({
      runId:id,found:true,seq:last.seq,entries:entries.length,
      status:last.status,baseSha:last.baseSha,
      workers:structuredClone(last.workers),
      integrityDigest:last.digest,
      // Journal metadata can be tampered by a party with host write access,
      // and cannot attest Windows test outcomes.
      authenticated:false,autoResume:false,requiresReview:true,
      interrupted:['running','preparing','testing'].includes(last.status),
    });
  }
}
