// Transactional WorkspaceEdit for trusted LSP responses. No resource operations,
// cross-workspace writes, hidden paths, or unaudited shell commands are allowed.
// The existing PermissionGate must still approve the parent rename operation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isProtectedPath } from './protected-paths.mjs';
import { writeFileAtomic } from './fs-safe.mjs';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const sha=text=>createHash('sha256').update(text).digest('hex');
const SOURCE=/\.(?:[cm]?[jt]sx?|py)$/i;

export function normalizeWorkspaceEdits(edit,primaryUri) {
  let list=[];
  if(Array.isArray(edit))list=[{uri:primaryUri,edits:edit}];
  else if(edit&&typeof edit==='object'&&edit.changes&&!Array.isArray(edit.changes)) {
    list=Object.entries(edit.changes).map(([uri,edits])=>({uri,edits}));
  } else if(edit&&Array.isArray(edit.documentChanges)) {
    list=edit.documentChanges.map(change=>{
      if(!change?.textDocument?.uri||!Array.isArray(change.edits))
        throw fail('resource_operation_refused','LSP create/rename/delete resource operations require separate review.');
      return {uri:change.textDocument.uri,edits:change.edits};
    });
  } else if(edit == null)return [];
  else throw fail('unsupported_workspace_edit','Unsupported WorkspaceEdit response.');
  if(list.length>32)throw fail('too_many_lsp_files','WorkspaceEdit affects over 32 files; split into smaller reviewed operations.');
  const seen=new Set();let edits=0;
  for(const file of list){
    if(typeof file.uri!=='string'||!file.uri.startsWith('file:')||!Array.isArray(file.edits)||seen.has(file.uri))
      throw fail('invalid_lsp_edit','WorkspaceEdit has invalid, non-file or repeated URI.');
    seen.add(file.uri);edits+=file.edits.length;
  }
  if(edits>500)throw fail('too_many_lsp_edits','WorkspaceEdit contains over 500 edits.');
  return list;
}

export async function prepareWorkspaceTransaction({
  workspace,edit,primaryUri,operation,applyEdits,revisionArgs={}
}={}){
  if(!workspace||typeof applyEdits!=='function'||typeof primaryUri!=='string')
    throw fail('invalid_transaction','A trusted workspace and primary LSP source are required.');
  const changes=normalizeWorkspaceEdits(edit,primaryUri);
  if(!changes.length)throw fail('empty_workspace_edit','LSP returned no edits.');
  const files=[];
  for(const change of changes){
    let absolute;
    try{absolute=fileURLToPath(change.uri);}catch{throw fail('invalid_lsp_uri','LSP URI must be a local file URL.');}
    const target=await workspace.resolve(absolute);
    if(!target.relative||isProtectedPath(target.relative)||!SOURCE.test(target.relative)||
       pathToFileURL(target.absolute).href!==change.uri)
      throw fail('unsafe_lsp_target','WorkspaceEdit targets a protected, non-source, or noncanonical file.');
    // Resolve junctions/symlinks: aliases must not reach Git metadata or
    // credentials, even if their source-looking relative path seems safe.
    const realRoot=await fs.realpath(target.root);
    const realFile=await fs.realpath(target.absolute);
    const canonical=path.relative(realRoot,realFile);
    if(!canonical||canonical==='..'||canonical.startsWith('..'+path.sep)||
       path.isAbsolute(canonical)||isProtectedPath(canonical.replaceAll('\\','/')))
      throw fail('unsafe_lsp_target','WorkspaceEdit target resolves outside its permitted source tree.');
    const stat=await fs.lstat(target.absolute);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>300000||stat.nlink!==1)
      throw fail('unsafe_lsp_target','WorkspaceEdit target must be an owned regular source file <=300KB.');
    const source=await fs.readFile(target.absolute,'utf8');
    if(source.includes('\uFFFD'))throw fail('bad_encoding','Unsafe UTF-8 source decoding.');
    const after=applyEdits(source,change.edits);
    files.push({uri:change.uri,file:target.relative,absolute:target.absolute,
      beforeSha256:sha(source),afterSha256:sha(after),editCount:change.edits.length,source,after});
  }
  files.sort((a,b)=>a.file.localeCompare(b.file));
  const token=sha(JSON.stringify({operation,primaryUri,revisionArgs,
    files:files.map(f=>({file:f.file,before:f.beforeSha256,after:f.afterSha256,edits:f.editCount}))}));
  return {files,token,operation,primaryUri};
}

export function transactionPreview(plan) {
  return {previewOnly:true,multiFile:plan.files.length>1,reviewToken:plan.token,
    files:plan.files.map(({uri,file,beforeSha256,afterSha256,editCount,source,after})=>({
      uri,file,beforeSha256,afterSha256,editCount,changed:source!==after,
      preview:after===source?'':after.slice(0,500),
    }))};
}

export async function applyWorkspaceTransaction(plan,{reviewToken,expectedPrimarySha}={}){
  if(!plan?.files?.length||reviewToken!==plan.token)
    throw fail('stale_review','Review the exact multi-file refactor preview before applying.');
  const primary=plan.files.find(f=>f.uri===plan.primaryUri);
  if(!primary||primary.beforeSha256!==expectedPrimarySha)
    throw fail('stale_source','The primary source SHA is missing or changed after review.');
  // Preflight every source before the first mutation.
  for(const file of plan.files) {
    const current=await fs.readFile(file.absolute,'utf8');
    if(sha(current)!==file.beforeSha256)
      throw fail('stale_lsp_workspace','A WorkspaceEdit source changed after preview; no file was written.');
  }
  const written=[];
  try{
    for(const file of plan.files.filter(f=>f.after!==f.source)){
      if((await fs.readFile(file.absolute,'utf8'))!==file.source)
        throw fail('concurrent_change','Source changed while applying the reviewed WorkspaceEdit.');
      await writeFileAtomic(file.absolute,Buffer.from(file.after,'utf8'));
      written.push(file);
      if(sha(await fs.readFile(file.absolute,'utf8'))!==file.afterSha256)
        throw fail('write_verification_failed','WorkspaceEdit output could not be verified.');
    }
  }catch(error){
    const pending=[];
    for(const file of written.reverse()){
      try{
        if(sha(await fs.readFile(file.absolute,'utf8'))!==file.afterSha256) {
          pending.push(file.file);continue; // Never overwrite a concurrent user edit.
        }
        await writeFileAtomic(file.absolute,Buffer.from(file.source,'utf8'));
        if(sha(await fs.readFile(file.absolute,'utf8'))!==file.beforeSha256)pending.push(file.file);
      }catch{pending.push(file.file);}
    }
    if(pending.length)throw fail('partial_rollback_required',
      'WorkspaceEdit was interrupted and some files could not be rolled back safely: '+pending.join(', '));
    throw error;
  }
  return {changedFiles:plan.files.filter(f=>f.after!==f.source)
    .map(({file,beforeSha256,afterSha256})=>({file,beforeSha256,afterSha256})),
    transactionVerified:true,rollbackRequired:false,reviewToken:plan.token};
}
