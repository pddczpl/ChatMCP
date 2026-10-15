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
  async request({op,file,language,line=1,column=1,new_name:newName,apply=false,expected_sha256:expectedSha,tab_size:tabSize=2,insert_spaces:insertSpaces=true,direction='subtypes'}){
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
    if(apply&&extra)throw fail('cross_file_preview_only','LSP proposed a multi-file edit; preview it and apply with a reviewable patch. Automatic multi-file edits are refused.');
    if(extra&&!apply)return ok({operation:op,uri,...await previewLspWorkspaceEdits(this.workspace,workspaceEdit)});
    const preview=normalized.edits.length?applyLspTextEdits(ctx.source,normalized.edits):ctx.source;
    if(!apply)return ok({operation:op,uri,previewOnly:true,files:normalized.files,edits:normalized.edits.length,
      beforeSha256:ctx.sha256,afterSha256:createHash('sha256').update(preview).digest('hex'),
      preview:preview.slice(0,12000),multiFile:extra});
    if(expectedSha!==ctx.sha256)throw fail('stale_source','File SHA changed since read; apply requires exact expected_sha256.');
    if(preview===ctx.source)return ok({operation:op,changed:false,sha256:ctx.sha256});
    const current=await fs.readFile(ctx.target.absolute,'utf8');
    if(current!==ctx.source)throw fail('concurrent_change','Source changed during LSP operation.');
    await writeFileAtomic(ctx.target.absolute,Buffer.from(preview,'utf8'));
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
    const edit={apply:B('Apply a single-file edit after human approval. Default false.'),
      expected_sha256:S('Expected SHA-256 from source read. Required when applying.',{minLength:64,maxLength:64})};
    build('rename_symbol','Rename an identifier with textDocument/rename; cross-file transformations are preview-only.',
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
