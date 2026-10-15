import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import {applyLspTextEdits} from '../lib/lsp-refactor-tools.mjs';
assert.equal(applyLspTextEdits('ab\ncd\n',[{range:{start:{line:0,character:1},end:{line:0,character:2}},newText:'X'}]),'aX\ncd\n');
assert.throws(()=>applyLspTextEdits('test',[{range:{start:{line:0,character:2},end:{line:0,character:1}},newText:'x'}]),/Reversed/);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-semantic-'));
try {
  await fs.writeFile(path.join(root,'test.ts'),'const broken=1;\n');
  const uri=pathToFileURL(path.join(root,'test.ts')).href;
  const client={
    ready:true,open:()=>{},
    request:async(method)=>method==='textDocument/formatting'?[{range:{start:{line:0,character:0},end:{line:0,character:15}},newText:'const fixed=1;'}]:
      method==='textDocument/rename'?{changes:{[uri]:[{range:{start:{line:0,character:6},end:{line:0,character:12}},newText:'updated'}]}}:
        method==='textDocument/prepareTypeHierarchy'?[]:[]
  };
  const fake={lsp:new Map([['typescript',client]]),lspStart:async()=>({ready:true})};
  const workspace=new StudioWorkspace({manager:{workspace:root},directory:root});
  const tools=new LocalTools({workspace,stateDirectory:root,studioIntelligence:fake});
  assert.equal((await tools.assess('format_document',{file:'test.ts',language:'typescript',apply:true})).category,'workspace_edit');
  assert.equal((await tools.assess('format_document',{file:'test.ts',language:'typescript'})).category,'read');
  const preview=await tools.call('format_document',{file:'test.ts',language:'typescript'});
  assert.equal(preview.isError,false);
  assert.equal(preview.structuredContent.previewOnly,true);
  assert.equal((await tools.call('format_document',{file:'test.ts',language:'typescript',apply:true,expected_sha256:'0'.repeat(64)})).isError,true);
  const sha=createHash('sha256').update(await fs.readFile(path.join(root,'test.ts'),'utf8')).digest('hex');
  const changed=await tools.call('format_document',{file:'test.ts',language:'typescript',apply:true,expected_sha256:sha});
  assert.equal(changed.isError,false,JSON.stringify(changed));
  assert.equal(await fs.readFile(path.join(root,'test.ts'),'utf8'),'const fixed=1;\n');
  const lookup=await tools.call('find_implementations',{file:'test.ts',language:'typescript',line:1,column:1});
  assert.equal(lookup.isError,false);

  // A cross-file LSP rename must publish a fully bound preview and require
  // an exact SHA/token/target list before any file is written. Stale previews
  // fail closed and do not change the primary source.
  const second=path.join(root,'other.ts');
  await fs.writeFile(second,'const fixed=2;\n');
  const otherUri=pathToFileURL(second).href;
  client.request=async(method)=>{
    if(method==='textDocument/rename')return {changes:{
      [uri]:[{range:{start:{line:0,character:6},end:{line:0,character:11}},newText:'total'}],
      [otherUri]:[{range:{start:{line:0,character:6},end:{line:0,character:11}},newText:'total'}]
    }};
    return [];
  };
  const opts={file:'test.ts',language:'typescript',line:1,column:7,new_name:'total'};
  const proposed=await tools.call('rename_symbol',opts);
  assert.equal(proposed.isError,false,JSON.stringify(proposed));
  assert.equal(proposed.structuredContent.multiFile,true);
  assert.equal(proposed.structuredContent.files.length,2);
  const token=proposed.structuredContent.reviewToken;
  const shaPrimary=createHash('sha256').update(await fs.readFile(path.join(root,'test.ts'))).digest('hex');
  const reviewed={...opts,apply:true,expected_sha256:shaPrimary,review_token:token,reviewed_files:['test.ts','other.ts']};
  assert.equal((await tools.call('rename_symbol',{...reviewed,review_token:'invalid'})).isError,true);
  assert.equal((await tools.call('rename_symbol',{...reviewed,reviewed_files:['test.ts']})).isError,true);
  await fs.writeFile(second,'const changed=2;\n');
  const stale=await tools.call('rename_symbol',reviewed);
  assert.equal(stale.isError,true,'stale cross-file preview must fail before writing');
  assert.equal(await fs.readFile(path.join(root,'test.ts'),'utf8'),'const fixed=1;\n');
  await fs.writeFile(second,'const fixed=2;\n');
  const changedTwo=await tools.call('rename_symbol',reviewed);
  assert.equal(changedTwo.isError,false,JSON.stringify(changedTwo));
  assert.equal(changedTwo.structuredContent.transactionVerified,true);
  assert.equal(changedTwo.structuredContent.changedFiles.length,2);
  assert.equal(await fs.readFile(path.join(root,'test.ts'),'utf8'),'const total=1;\n');
  assert.equal(await fs.readFile(second,'utf8'),'const total=2;\n');
  await tools.close();
  console.log('PASS LSP semantic tools: preview, guarded multi-file transaction, stale revision, single-file write and navigation');
}finally{await fs.rm(root,{recursive:true,force:true,maxRetries:3});}
