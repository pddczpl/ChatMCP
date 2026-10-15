// Semantic refactoring on the existing bundled LSP. No second parser or external MCP client.
// Preview is default. Single-file mutations require PermissionGate approval, SHA, and a host checkpoint.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isProtectedPath } from './protected-paths.mjs';
import { writeFileAtomic } from './fs-safe.mjs';
const O=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const S=(description,extra={})=>({type:'string',description,...extra});
const I=(description,extra={})=>({type:'integer',description,...extra});
const B=description=>({type:'boolean',description});
const fail=(code,message)=>Object.assign(new Error(message),{code});
const ok=(structured)=>({isError:false,content:[{type:'text',text:JSON.stringify(structured).slice(0,28000)}],structuredContent:structured});
function lineOffset(content,pos) {
  const line=pos?.line,character=pos?.character;
  if(!Number.isInteger(line)||line<0||!Number.isInteger(character)||character<0)throw fail('bad_lsp_range','Invalid LSP UTF-16 position.');
  let base=0;
  for(let i=0;i<line;i++){const end=content.indexOf('\n',base);if(end<0)throw fail('bad_lsp_range','LSP line beyond document.');base=end+1;}
  const end=content.indexOf('\n',base),row=content.slice(base,end<0?content.length:end).replace(/\r$/,'');
  if(character>row.length)throw fail('bad_lsp_range','LSP column beyond line.');
  return base+character;
}
export function applyLspTextEdits(source,edits) {
  if(!Array.isArray(edits)||edits.length>500)throw fail('bad_lsp_edit','Expected at most 500 LSP text edits.');
  const patches=edits.map(e=>{
    if(typeof e.newText!=='string'||!e.range)throw fail('bad_lsp_edit','Unsupported LSP edit type.');
    const start=lineOffset(source,e.range.start),end=lineOffset(source,e.range.end);
    if(end<start)throw fail('bad_lsp_edit','Reversed LSP range.');
    return {start,end,newText:e.newText};
  }).sort((a,b)=>b.start-a.start);
  for(let i=1;i<patches.length;i++)if(patches[i].end>patches[i-1].start)throw fail('overlapping_lsp_edit','Overlapping edits refused.');
  let text=source;
  for(const p of patches)text=text.slice(0,p.start)+p.newText+text.slice(p.end);
  return text;
}
function normalizeEdits(response,uri) {
  if(!response)return {files:[],edits:[]};
  if(Array.isArray(response))return {files:[uri],edits:response};
  if(response.changes) {
    const uris=Object.keys(response.changes);
    return {files:uris,edits:uris.length===1&&uris[0]===uri?response.changes[uri]:[]};
  }
  if(response.documentChanges) {
    const changes=response.documentChanges;
    return {files:changes.map(x=>x.textDocument?.uri||x.uri||'<resource-operation>'),edits:changes.length===1&&changes[0].textDocument?.uri===uri?changes[0].edits:[]};
  }
  throw fail('unsupported_workspace_edit','Unsupported LSP WorkspaceEdit shape.');
}
// Multi-file LSP rename previews are proof-bearing and read-only. Reject all
// resource operations and outside-workspace URIs: permission and checkpoint
// enforcement for a later atomic multi-file apply are intentionally separate.
export async function previewLspWorkspaceEdits(workspace, response) {
  let entries;
  if(response?.changes && typeof response.changes==='object' && !Array.isArray(response.changes))
    entries=Object.entries(response.changes).map(([uri,edits])=>({uri,edits}));
  else if(Array.isArray(response?.documentChanges))
    entries=response.documentChanges.map(change=>{
      if(!change?.textDocument?.uri||!Array.isArray(change.edits))
        throw fail('unsupported_workspace_edit','Resource operations are not previewed as file edits.');
      return {uri:change.textDocument.uri,edits:change.edits};
    });
  else throw fail('unsupported_workspace_edit','Expected changes or documentChanges in LSP rename result.');
  if(entries.length>12)throw fail('too_many_lsp_files','WorkspaceEdit exceeds 12 files; narrow the operation.');
  const seen=new Set(),results=[];
  for(const {uri,edits} of entries) {
    if(typeof uri!=='string'||!uri.startsWith('file://')||seen.has(uri))
      throw fail('unsafe_lsp_uri','Duplicate or non-file URI in WorkspaceEdit.');
    seen.add(uri);
    let absolute;
    try{absolute=fileURLToPath(uri);}catch{throw fail('unsafe_lsp_uri','Invalid LSP file URI.');}
    const target=await workspace.resolve(absolute);
    if(!target.relative||isProtectedPath(target.relative))
      throw fail('protected_path','LSP WorkspaceEdit targets a protected or outside-workspace file.');
    const stat=await fs.lstat(target.absolute);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>300000)
      throw fail('bad_source','WorkspaceEdit source must be a regular unlinked file under 300KB.');
    const original=await fs.readFile(target.absolute,'utf8');
    const preview=applyLspTextEdits(original,edits);
    results.push({file:target.relative,edits:edits.length,
      beforeSha256:createHash('sha256').update(original).digest('hex'),
      afterSha256:createHash('sha256').update(preview).digest('hex'),
      changed:original!==preview,preview:preview.slice(0,1400)});
  }
  return {previewOnly:true,multiFile:results.length>1,files:results,fileCount:results.length,changesApplied:0};
}
/** Approved multi-file LSP rename: exact reviewed source revisions, scoped
 * host checkpoint, ordered writes and conflict-aware rollback. Never execute
 * LSP resource operations (rename/create/delete files) as text edits.
 * This is not an OS transaction: another process may change a file between
 * writes, in which case we stop with an explicit manual-recovery error. */
export async function applyLspWorkspaceEditsTransaction(workspace,response,expectedFiles) {
  if(!Array.isArray(expectedFiles)||expectedFiles.length<2||expectedFiles.length>12)
    throw fail('review_required','Multi-file apply requires the exact reviewed file list and SHA-256 hashes.');
  const preview=await previewLspWorkspaceEdits(workspace,response);
  if(preview.fileCount!==expectedFiles.length)
    throw fail('stale_review','Reviewed file set differs from current language-server edit.');
  const approved=new Map();
  for(const item of expectedFiles){
    if(typeof item?.file!=='string'||!(/^[a-f0-9]{64}$/i).test(item?.beforeSha256||''))
      throw fail('review_required','Every reviewed file requires file and beforeSha256.');
    if(approved.has(item.file.toLowerCase()))throw fail('duplicate_lsp_path','Duplicate reviewed paths are not allowed.');
    approved.set(item.file.toLowerCase(),item.beforeSha256.toLowerCase());
  }
  for(const entry of preview.files){
    if(approved.get(entry.file.toLowerCase())!==entry.beforeSha256)
      throw fail('stale_review','Reviewed source SHA or target differs from the proposed LSP patch.');
  }
  const raw=response?.changes?
    Object.entries(response.changes).map(([uri,edits])=>({uri,edits})):
    response?.documentChanges?.map(x=>({uri:x.textDocument.uri,edits:x.edits}));
  if(!Array.isArray(raw)||raw.length!==preview.fileCount)
    throw fail('unsupported_workspace_edit','Malformed multi-file LSP edit.');
  const prepared=[];
  for(const item of raw){
    const absolute=fileURLToPath(item.uri);
    const target=await workspace.resolve(absolute);
    const stat=await fs.lstat(target.absolute);
    if(!target.relative||isProtectedPath(target.relative)||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)
      throw fail('protected_path','Multi-file edit contains an unsafe source file.');
    const original=await fs.readFile(target.absolute,'utf8');
    const beforeSha256=createHash('sha256').update(original).digest('hex');
    if(approved.get(target.relative.toLowerCase())!==beforeSha256)
      throw fail('concurrent_change','Workspace changed since the preview; review changes again.');
    const next=applyLspTextEdits(original,item.edits);
    prepared.push({target,original,next,beforeSha256,mode:stat.mode&0o777,
      afterSha256:createHash('sha256').update(next).digest('hex')});
  }
  // Studio checkpoints are always flagged partial because they are scoped to
  // a file list. Verify the exact file coverage rather than trusting partial.
  if(typeof workspace.checkpoint!=='function')throw fail('checkpoint_unavailable','A workspace checkpoint is required.');
  const checkpoint=await workspace.checkpoint({label:'Before reviewed multi-file LSP edit',
    files:prepared.map(x=>x.target.relative),maxFiles:prepared.length,
    maxTotalBytes:5*1024*1024});
  if(!checkpoint?.targeted||checkpoint.fileCount!==prepared.length||checkpoint.skipped?.length)
    throw fail('checkpoint_incomplete','Checkpoint did not capture every LSP target. No files changed.');
  for(const p of prepared){
    const current=await fs.readFile(p.target.absolute,'utf8');
    if(createHash('sha256').update(current).digest('hex')!==p.beforeSha256)
      throw fail('concurrent_change','A source file changed while checkpointing; no files changed.');
  }
  const written=[];
  try{
    for(const p of prepared){
      // Concurrency-aware preflight on each write. No silently overwritten edits.
      const fresh=await fs.readFile(p.target.absolute,'utf8');
      if(createHash('sha256').update(fresh).digest('hex')!==p.beforeSha256)
        throw fail('concurrent_change','Source changed during multi-file apply.');
      if(p.next!==p.original){
        await writeFileAtomic(p.target.absolute,Buffer.from(p.next,'utf8'),{mode:p.mode,expectedSha:p.beforeSha256});
        written.push(p);
        const saved=await fs.readFile(p.target.absolute,'utf8');
        if(createHash('sha256').update(saved).digest('hex')!==p.afterSha256)
          throw fail('write_verification_failed','Written LSP file failed SHA-256 verification.');
      }
    }
  }catch(error){
    let rollbackFailed=false;
    for(const p of written.reverse()){
      try{
        const current=await fs.readFile(p.target.absolute,'utf8');
        if(createHash('sha256').update(current).digest('hex')!==p.afterSha256){rollbackFailed=true;continue;}
        await writeFileAtomic(p.target.absolute,Buffer.from(p.original,'utf8'),{mode:p.mode,expectedSha:p.afterSha256});
        const reverted=await fs.readFile(p.target.absolute,'utf8');
        if(createHash('sha256').update(reverted).digest('hex')!==p.beforeSha256)rollbackFailed=true;
      }catch{rollbackFailed=true;}
    }
    if(rollbackFailed)
      throw fail('manual_recovery_required','A concurrent file change prevented complete LSP rollback. Inspect checkpoint '+checkpoint.id+' and Git diff before proceeding.');
    throw error;
  }
  return {changed:prepared.some(x=>x.original!==x.next),transaction:true,
    checkpointId:checkpoint.id,files:prepared.map(x=>({file:x.target.relative,
      beforeSha256:x.beforeSha256,afterSha256:x.afterSha256,changed:x.original!==x.next})),
    rollbackOnFailure:true};
}

function boundedResult(value) {
  const serialized=JSON.stringify(value);
  if(serialized?.length>60000)throw fail('large_lsp_result','LSP response over 60 KB, narrow your request.');
  return value;
}
export class SemanticTools {
  constructor({workspace,intelligence}) {this.workspace=workspace;this.intelligence=intelligence;}
  async context({file,language}) {
    if(!this.intelligence?.lspStart||!this.intelligence?.lsp)throw fail('lsp_unavailable','Language server is not configured.');
    if(!['typescript','python'].includes(language))throw fail('bad_language','Only bundled Python and TS/JS LSP supported.');
    const target=await this.workspace.resolve(file);
    if(!target.relative||isProtectedPath(target.relative))throw fail('protected_path','Protected source path.');
    const stat=await fs.stat(target.absolute);
    if(!stat.isFile()||stat.size>300000)throw fail('bad_source','Source must be a regular file under 300 KB.');
    const source=await fs.readFile(target.absolute,'utf8');
    const uri=pathToFileURL(target.absolute).href;
    await this.intelligence.lspStart({language});
    const client=this.intelligence.lsp.get(language);
    if(!client?.ready)throw fail('lsp_not_ready','LSP server not initialized.');
    const languageId=language==='python'?'python':/\.[cm]?jsx?$/.test(file)?'javascript':'typescript';
    client.open(uri,source,languageId);
    return {client,source,target,uri,sha256:createHash('sha256').update(source).digest('hex')};
  }
  async request({op,file,language,line=1,column=1,new_name:newName,apply=false,expected_sha256:expectedSha,tab_size:tabSize=2,insert_spaces:insertSpaces=true,direction='subtypes',expected_files:expectedFiles=null}){
    const ctx=await this.context({file,language});
    const {client,uri}=ctx;
    if(!Number.isInteger(line)||line<1||!Number.isInteger(column)||column<1)throw fail('bad_position','Line and column are 1-based positive integers.');
    const pos={line:line-1,character:column-1};
    let method,params,workspaceEdit=null;
    if(op==='rename_symbol'){
      if(!/^[A-Za-z_$][\w$]*$/.test(newName||''))throw fail('bad_symbol','Rename identifier invalid.');
      method='textDocument/rename';params={textDocument:{uri},position:pos,newName};
    }else if(op==='format_document'){
      method='textDocument/formatting';params={textDocument:{uri},options:{tabSize,insertSpaces}};
    }else if(op==='organize_imports'){
      method='textDocument/codeAction';params={textDocument:{uri},range:{start:pos,end:pos},context:{diagnostics:[],only:['source.organizeImports']}};
    }else if(op==='code_actions'){
      method='textDocument/codeAction';params={textDocument:{uri},range:{start:pos,end:pos},context:{diagnostics:[]}};
    }else if(op==='find_implementations'){
      method='textDocument/implementation';params={textDocument:{uri},position:pos};
    }else if(op==='type_hierarchy'){
      method='textDocument/prepareTypeHierarchy';params={textDocument:{uri},position:pos};
    }else throw fail('bad_action','Unknown semantic tool.');
    let response=boundedResult(await client.request(method,params,15000));
    if(op==='type_hierarchy'&&response?.length) {
      response=boundedResult(await client.request(direction==='supertypes'?'typeHierarchy/supertypes':'typeHierarchy/subtypes',{item:response[0]},15000));
    }
    if(op==='rename_symbol')workspaceEdit=response;
    if(op==='format_document')workspaceEdit=response;
    if(op==='organize_imports'){
      const options=Array.isArray(response)?response:[];
      workspaceEdit=options.find(x=>x.edit)?.edit??null;
    }
    if(workspaceEdit===null) {
      if(apply)throw fail('not_applicable','No applicable source transformation returned by LSP.');
      return ok({operation:op,uri,previewOnly:true,result:response,sha256:ctx.sha256});
    }
    const normalized=normalizeEdits(workspaceEdit,uri);
    const extra=normalized.files.some(f=>f!==uri);
    if(apply&&extra){
      const applied=await applyLspWorkspaceEditsTransaction(this.workspace,workspaceEdit,expectedFiles);
      return ok({operation:op,uri,...applied});
    }
    if(extra&&!apply)return ok({operation:op,uri,...await previewLspWorkspaceEdits(this.workspace,workspaceEdit)});
    const preview=normalized.edits.length?applyLspTextEdits(ctx.source,normalized.edits):ctx.source;
    if(!apply)return ok({operation:op,uri,previewOnly:true,files:normalized.files,edits:normalized.edits.length,
      beforeSha256:ctx.sha256,afterSha256:createHash('sha256').update(preview).digest('hex'),
      preview:preview.slice(0,12000),multiFile:extra});
    if(expectedSha!==ctx.sha256)throw fail('stale_source','File SHA changed since read; apply requires exact expected_sha256.');
    if(preview===ctx.source)return ok({operation:op,changed:false,sha256:ctx.sha256});
    const current=await fs.readFile(ctx.target.absolute,'utf8');
    if(current!==ctx.source)throw fail('concurrent_change','Source changed during LSP operation.');
    const stat=await fs.lstat(ctx.target.absolute);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)
      throw fail('unsafe_lsp_target','Cannot edit special, symlinked or hard-linked files.');
    await writeFileAtomic(ctx.target.absolute,Buffer.from(preview,'utf8'),
      {mode:stat.mode&0o777,expectedSha:ctx.sha256});
    const verify=await fs.readFile(ctx.target.absolute,'utf8');
    if(verify!==preview)throw fail('write_verification_failed','Could not verify file write.');
    return ok({operation:op,file:ctx.target.relative,changed:true,
      beforeSha256:ctx.sha256,afterSha256:createHash('sha256').update(verify).digest('hex')});
  }
  register(define) {
    const base={
      file:S('Workspace-relative source path.'),language:S('LSP language: typescript or python.',{enum:['typescript','python']}),
      line:I('1-based line.',{minimum:1}),column:I('1-based UTF-16 column.',{minimum:1})};
    const build=(name,description,params={},required=['file','language'],canApply=false)=>define(name,{
      description,schema:O({...base,...params},required),annotations:{readOnlyHint:!canApply,destructiveHint:false},
      category:canApply?(a)=>({category:a.apply?'workspace_edit':'read',reason:a.apply?'Apply reviewed one-file LSP edit':'Preview LSP edit'}):'read',
      reason:'Semantic source analysis using bundled LSP',summary:a=>name+' '+a.file,pathArgs:['file'],
      run:a=>this.request({op:name,...a}),
    });
    const edit={apply:B('Apply a reviewed single- or multi-file edit after PermissionGate approval. Default false.'),
      expected_sha256:S('Expected SHA-256 for single-file apply.',{minLength:64,maxLength:64}),
      expected_files:{type:'array',description:'For cross-file apply, exact preview.files (file,beforeSha256) reviewed and checkpointed by the host.',minItems:2,maxItems:12,
        items:O({file:S('Workspace-relative preview path.'),beforeSha256:S('Reviewed SHA-256.',{minLength:64,maxLength:64})},['file','beforeSha256'])}};
    build('rename_symbol','Rename an identifier with LSP. Multi-file apply requires exact SHA-reviewed targets, mandatory checkpoint and rollback.',
      {...edit,new_name:S('New valid identifier.'),},['file','language','new_name'],true);
    build('format_document','Format a source file through existing LSP; single-file writes require expected SHA.',
      {...edit,tab_size:I('Spaces per tab.',{minimum:1,maximum:16}),insert_spaces:B('Use spaces for indentation.')},['file','language'],true);
    build('organize_imports','Ask existing LSP for source.organizeImports; preview before applying.',
      edit,['file','language'],true);
    build('code_actions','Get LSP quick fixes available at a source position (untrusted descriptions only).',
      {},['file','language']);
    build('find_implementations','Find implementation locations through textDocument/implementation.',
      {},['file','language']);
    build('type_hierarchy','Get direct supertypes or subtypes via LSP type hierarchy.',
      {direction:S('Hierarchy direction.',{enum:['supertypes','subtypes']})},['file','language']);
  }
}
export function registerSemanticTools(define,context) {const group=new SemanticTools(context);group.register(define);return group;}
