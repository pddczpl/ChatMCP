// Phase 3: explicit dependency ordering for trusted, managed coding worktrees.
//
// This never runs tools, grants capabilities or publishes Git changes.
// Dependencies are declared by the OWNER, not inferred from model prose.
// A dependent worktree may inherit only reviewed/committed predecessor code
// through the trusted GitRunner; the model has no merge/push tool access.
import path from 'node:path';

const SLUG=/^[a-z][a-z0-9-]{0,30}$/;
const TERMINAL_BAD=new Set(['failed','blocked','cancelled','needs_attention','interrupted']);
const SUCCESS=new Set(['ready_for_review','no_changes']);

const reject=(code,message)=>Object.assign(new Error(message),{code,statusCode:400});

/** Parse explicit user work items into a read-only coding task proposal.
 * No model call, file write, permission grant or automatic Git operation.
 * Plain goals remain single-worker tasks; explicit bullets map to 2-4 workers.
 */
export function proposeCodingTaskGraph(prompt) {
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)
    throw reject('invalid_coding_prompt','Coding goal must be 1-12000 characters.');
  const bullets=[];
  for(const line of prompt.split(/\r?\n/)) {
    const match=line.match(/^\s*(?:[-*]\s+|\d{1,2}[.)]\s+)(.{12,3000})\s*$/);
    if(match)bullets.push(match[1].trim());
  }
  if(bullets.length>4)
    throw reject('too_many_coding_tasks','More than four tasks requested; split into multiple runs.');
  const items=bullets.length>=2?bullets:[prompt.trim()];
  const tasks=items.map((input,i)=>{
    const marker=/\[(?:after|depends on|sau)\s*:\s*([1-4](?:\s*,\s*[1-4])*)\s*\]/i.exec(input);
    const dependsOn=marker?[...new Set(marker[1].split(',').map(x=>'task-'+Number(x.trim())))]:[];
    const workerPrompt=marker?input.replace(marker[0],'').trim():input;
    if(!workerPrompt||workerPrompt.length>3000)
      throw reject('invalid_coding_prompt','Worker instruction must be 1-3000 characters.');
    return {id:'task-'+(i+1),prompt:workerPrompt,dependsOn,verify:false};
  });
  validateCodingTaskGraph(tasks);
  return {origin:'owner-prompt-deterministic',previewOnly:true,
    requiresConfirmation:'CREATE WORKTREES',taskCount:tasks.length,tasks,
    note:'Review/edit before running. No changes have been made.'};
}

export function validateCodingTaskGraph(tasks) {
  if(!Array.isArray(tasks)||tasks.length<1||tasks.length>4)
    throw reject('invalid_coding_graph','Coding graph requires 1–4 owner-defined tasks.');
  const map=new Map();
  for(const node of tasks){
    if(!SLUG.test(node?.id||'')||map.has(node.id))
      throw reject('invalid_coding_graph','Task IDs must be unique safe slugs.');
    const deps=node.dependsOn??[];
    if(!Array.isArray(deps)||deps.length>3||new Set(deps).size!==deps.length||
       deps.some(id=>typeof id!=='string'||!SLUG.test(id)||id===node.id))
      throw reject('invalid_coding_graph','Dependency IDs must be distinct known tasks.');
    map.set(node.id,deps.slice());
  }
  for(const [id,deps] of map){
    for(const dep of deps)if(!map.has(dep))
      throw reject('unknown_coding_dependency','Task '+id+' depends on an unknown worker.');
  }
  const visiting=new Set(),done=new Set();
  const visit=(id)=>{
    if(visiting.has(id))throw reject('cyclic_coding_dependency','Cyclic worker graph rejected.');
    if(done.has(id))return;
    visiting.add(id);
    for(const dep of map.get(id))visit(dep);
    visiting.delete(id);done.add(id);
  };
  for(const id of map.keys())visit(id);
  return Object.freeze([...map].map(([id,deps])=>
    Object.freeze({id,dependsOn:Object.freeze(deps)})));
}

export function chooseReadyCodingBatch(workers,limit=2) {
  if(!Array.isArray(workers)||!Number.isSafeInteger(limit)||limit<1||limit>4)
    throw reject('invalid_coding_batch','Invalid managed worker batch size.');
  const map=new Map(workers.map(w=>[w.id,w]));
  if(map.size!==workers.length)throw reject('invalid_coding_batch','Duplicate worker records.');
  const ready=[],blocked=[],waiting=[];
  for(const worker of workers.filter(w=>w.status==='queued')){
    const deps=worker.dependsOn??[];
    if(!Array.isArray(deps)||deps.some(id=>!map.has(id)))
      throw reject('invalid_coding_batch','Trusted dependency graph was replaced.');
    if(deps.some(id=>TERMINAL_BAD.has(map.get(id).status))){
      blocked.push(worker.id);continue;
    }
    if(deps.every(id=>SUCCESS.has(map.get(id).status))){
      ready.push(worker.id);continue;
    }
    waiting.push(worker.id);
  }
  return Object.freeze({
    ready:Object.freeze(ready.slice(0,limit)),
    blocked:Object.freeze(blocked),
    waiting:Object.freeze(waiting),
  });
}

// Be conservative: Git can store file names that alias or change identity
// when checked out on Windows. Conflict safety must use *complete* raw Git
// -z filenames, not shell-formatted text or newline-split output.
function safeGitPath(value){
  if(typeof value!=='string'||!value||value.length>1024||
     /[\u0000-\u001f\u007f]/u.test(value))
    throw reject('invalid_worker_file','Worker changed-file path contains a control character or is oversized.');
  const winPath=value.replaceAll('\\','/');
  if(winPath.startsWith('/')||/^[a-zA-Z]:/.test(winPath))
    throw reject('invalid_worker_file','Worker file path must be repo-relative.');
  const parts=winPath.split('/');
  const reserved=/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
  if(parts.some(part=>!part||part==='.'||part==='..'||part.includes(':')||
     /[. ]$/u.test(part)||reserved.test(part)))
    throw reject('invalid_worker_file','Ambiguous Windows path, stream or device name is prohibited.');
  const normalized=path.posix.normalize(winPath);
  if(normalized==='.'||normalized==='..'||normalized.startsWith('../')||
     normalized.startsWith('/'))
    throw reject('invalid_worker_file','Worker changed-file path escaped repository.');
  return normalized.normalize('NFC').toLowerCase();
}

/**
 * Same-file edits from two independent branches are rejected BEFORE any
 * trusted integration worktree mutates Git metadata. Even a nonconflicting
 * textual merge must be explicitly reviewed in a separate integration.
 */
export function detectCodingFileConflicts(workers) {
  if(!Array.isArray(workers)||workers.length<1||workers.length>4)
    throw reject('invalid_worker_selection','Select 1–4 known worker commits.');
  const files=new Map();
  for(const worker of workers){
    if(!SLUG.test(worker?.id||'')||!Array.isArray(worker.changedFiles)||
       worker.changedFiles.length>250)
      throw reject('invalid_worker_selection','Trusted worker/file records are required.');
    for(const pathname of new Set(worker.changedFiles.map(safeGitPath))){
      if(!files.has(pathname))files.set(pathname,[]);
      files.get(pathname).push(worker.id);
    }
  }
  // Reject file-versus-directory collisions across independently edited
  // branches, too. For example, one worker may create "src/cache" as a file
  // while another creates "src/cache/index.js". Exact-file-only checks miss
  // this case and would postpone a known structural conflict until Git merge.
  // All names were normalized/case-folded above to match Windows checkout.
  const conflicting=new Map();
  const add=(file,ownerIds)=>{
    const current=conflicting.get(file)??new Set();
    for(const id of ownerIds)current.add(id);
    if(current.size>1)conflicting.set(file,current);
  };
  for(const [file,ids] of files) {
    if(ids.length>1)add(file,ids);
    const parts=file.split('/');
    for(let n=1;n<parts.length;n++){
      const ancestor=parts.slice(0,n).join('/');
      const ancestorOwners=files.get(ancestor);
      if(ancestorOwners)add(ancestor,[...ancestorOwners,...ids]);
    }
  }
  return Object.freeze([...conflicting]
    .map(([file,ids])=>Object.freeze({
      file,workerIds:Object.freeze([...ids]),
    }))
    .sort((a,b)=>a.file.localeCompare(b.file)));
}
