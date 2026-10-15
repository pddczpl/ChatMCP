/** Incremental, persistent code index and optional true LSP (stdio JSON-RPC).
 * Index = Python AST + text JS/TS fallback. Precise cross-file navigation
 * requires an installed Pyright / TypeScript language server.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, writeJson } from './runtime.mjs';
import { scrubEnv } from './shell-runner.mjs';
const SKIP=new Set(['.git','node_modules','.venv','venv','__pycache__','dist','build','.next','coverage','.idea','.vs']);
const EXT=new Set(['.py','.js','.jsx','.ts','.tsx','.mjs','.cjs']);
const PRIVATE=/^(?:\.env(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|p12|pfx|key)|credentials\.json|secrets?\.json)$/i;
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const digest=s=>createHash('sha256').update(s).digest('hex');
const isFile = async p => await fs.stat(p).then(s=>s.isFile()).catch(()=>false);
function fallbackSymbols(filename,source){
  const lines=source.split(/\r?\n/),symbols=[],references=[];
  for(let i=0;i<lines.length;i++){
    const m=/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+|class\s+|interface\s+|type\s+|enum\s+|(?:const|let|var)\s+)([\w$]+)/.exec(lines[i]);
    if(m)symbols.push({name:m[1],kind:'symbol',line:i+1,column:Math.max(0,lines[i].indexOf(m[1])),container:''});
  }
  return {path:filename,symbols,references,imports:[],parseError:null,precision:'heuristic'};
}
async function spawnJson(exe,args,input,{cwd,timeout=12000,env=scrubEnv(process.env)}={}){
  return await new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{cwd,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env});let output='',stderr='',done=false;
    const finish=(err,val)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(val);};
    const timer=setTimeout(()=>{child.kill();finish(fail('Python AST index hết thời gian.'));},timeout);
    child.on('error',e=>finish(e));child.stdout.on('data',c=>{output+=String(c);if(output.length>12*1024*1024){child.kill();finish(fail('AST index quá lớn.'));}});
    child.stderr.on('data',c=>{stderr+=String(c).slice(0,500);});
    child.on('close',code=>{if(code!==0)return finish(fail('Python AST index failed: '+stderr.slice(0,200)));try{finish(null,JSON.parse(output));}catch{finish(fail('AST index không trả JSON hợp lệ.'));}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
  });
}
export class CodeIntelligence {
  constructor({workspace,directory,bundleRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')}={}){
    this.workspace=workspace;this.directory=directory;this.bundleRoot=bundleRoot;this.cache=null;this.pending=null;this.lsp=new Map();this.lspStarting=new Map();this.diagnostics=new Map();this.lastEngineHealth=null;
  }
  async root(){return await fs.realpath(this.workspace.requireRoot());}
  async files(max=1800){
    const root=await this.root(),out=[],stack=[root];
    while(stack.length&&out.length<max){const dir=stack.pop();let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{continue;}
      for(const e of entries){if(SKIP.has(e.name)||PRIVATE.test(e.name)||e.isSymbolicLink())continue;
        const full=path.join(dir,e.name);if(e.isDirectory()){if(path.relative(root,full).split(path.sep).length<12)stack.push(full);continue;}
        if(!e.isFile()||!EXT.has(path.extname(e.name).toLowerCase()))continue;
        const st=await fs.stat(full).catch(()=>null);if(!st||st.size>250000)continue;
        out.push({path:path.relative(root,full).replaceAll('\\','/'),absolute:full,size:st.size,mtimeMs:st.mtimeMs});
        if(out.length>=max)break;
      }
    }return {root,files:out,truncated:stack.length>0||out.length>=max};
  }
  #storePath(root){return path.join(this.directory,`${digest(root).slice(0,20)}.json`);}
  async #load(root){if(this.cache?.root===root)return this.cache;this.cache=await readJson(this.#storePath(root)).catch(()=>null);if(this.cache?.root!==root)this.cache=null;return this.cache;}
  async index({force=false}={}){
    if(this.pending)return this.pending;
    this.pending=this.#index(force);try{return await this.pending;}finally{this.pending=null;}
  }
  async #index(force){
    const {root,files,truncated}=await this.files(),before=await this.#load(root),old=new Map((before?.entries||[]).map(e=>[e.path,e]));
    const entries=[],python=[];let retained=0,totalBytes=0,hitMemoryLimit=false;
    for(const f of files){const prev=old.get(f.path);
      if(!force&&prev&&prev.size===f.size&&prev.mtimeMs===f.mtimeMs){entries.push(prev);retained++;continue;}
      if(totalBytes+f.size>40*1024*1024){hitMemoryLimit=true;continue;}
      const source=await fs.readFile(f.absolute,'utf8').catch(()=>null);if(source===null||source.includes('\0'))continue;totalBytes+=f.size;
      if(f.path.endsWith('.py'))python.push({...f,source});
      else entries.push({...fallbackSymbols(f.path,source),size:f.size,mtimeMs:f.mtimeMs,sha256:digest(source)});
    }
    // Python sources analyzed in a separate process using AST, never imported.
    // A missing Python executable results in explicit degraded heuristics.
    const embedded = path.join(this.bundleRoot, 'runtimes', 'python', 'python.exe');
    const installed = await isFile(path.join(this.bundleRoot, 'runtime-manifest.json'));
    const bundled = process.platform === 'win32' && await isFile(embedded);
    const pythonExe = bundled ? embedded : (installed ? null : (process.platform === 'win32' ? 'py' : 'python3'));
    let parser='python-ast';
    for(let i=0;i<python.length;i+=40){const batch=python.slice(i,i+40);
      try{
        // -I (isolated): no PYTHONPATH, no user site, and neither the script's folder nor the working directory (the project, which is
        // not trusted) is put on the import path, so a file named like a standard module cannot be picked up by the indexer.
        if (!pythonExe) throw fail('Bundled CPython missing from installed Code Intelligence Runtime.',503);
        const worker = path.join(this.bundleRoot, 'workers', 'python_index.py');
        const argv=bundled?['-I','-X','utf8',worker]:process.platform==='win32'?['-3.11','-I',worker]:['-I',worker];
        const result=await spawnJson(pythonExe,argv,{schemaVersion:1,files:batch.map(x=>({path:x.path,source:x.source}))},{cwd:root});
        for(const f of result.files){const src=batch.find(x=>x.path===f.path);entries.push({...f,size:src.size,mtimeMs:src.mtimeMs,sha256:digest(src.source),precision:'ast'});}
      }catch(error){parser='fallback';for(const src of batch)entries.push({...fallbackSymbols(src.path,src.source),size:src.size,mtimeMs:src.mtimeMs,sha256:digest(src.source)});}
    }
    const cache={root,version:1,indexedAt:new Date().toISOString(),truncated:truncated||hitMemoryLimit,entries:entries.sort((a,b)=>a.path.localeCompare(b.path)),parser};
    await fs.mkdir(this.directory,{recursive:true});await writeJson(this.#storePath(root),cache);this.cache=cache;
    return {root,indexedAt:cache.indexedAt,fileCount:entries.length,symbolCount:entries.reduce((n,x)=>n+x.symbols.length,0),reused:retained,partial:cache.truncated,parser};
  }
  async status(){const root=await this.root();const saved=await this.#load(root);
    return {indexedAt:saved?.indexedAt??null,fileCount:saved?.entries?.length||0,symbolCount:saved?.entries?.reduce((n,x)=>n+x.symbols.length,0)||0,parser:saved?.parser??'not-indexed',lsp:[...this.lsp].map(([language,client])=>({language,state:client.ready?'ready':client.state,executable:client.exe})),capabilities:{index:true,pythonAst:true,preciseNavigation:'bundled LSP available after successful initialization',supportedServers:['pyright-langserver','typescript-language-server']},engineHealth:this.lastEngineHealth ?? {checkedAt:null,engines:['typescript-lsp','python-lsp','tree-sitter','python-ast','heuristic'].map(id=>({id,status:'not_checked'}))}};
  }
  // Only an explicit, permission-checked POST requests a health probe. The
  // read-only status endpoint never starts host processes in the background.
  async engineHealth({probe=false}={}){
    if(!probe)return this.lastEngineHealth ?? {checkedAt:null,engines:[]};
    const root=await this.root();
    const runtime=path.join(this.bundleRoot,'runtimes');
    const packageRoot=path.join(runtime,'lsp','node_modules');
    const list=[];
    const versions={};
    for(const name of ['pyright','typescript-language-server','web-tree-sitter']){
      const filename=path.join(packageRoot,name,'package.json');
      versions[name]=await fs.readFile(filename,'utf8').then(s=>JSON.parse(s).version).catch(()=>null);
    }
    for(const [id,language,pkg] of [
      ['typescript-lsp','typescript','typescript-language-server'],
      ['python-lsp','python','pyright'],
    ]){
      try{
        const result=await this.lspStart({language});
        const client=this.lsp.get(language);
        if(!client?.ready)throw new Error('Initialize did not complete.');
        list.push({id,status:'ready',source:result.source||'bundled',version:versions[pkg],checked:true});
      }catch(error){
        list.push({id,status:'unavailable',source:'bundled',version:versions[pkg],
          detail:String(error.message).slice(0,140),checked:true});
      }
    }
    try{
      const modulePath=path.join(packageRoot,'web-tree-sitter','tree-sitter.js');
      const {Parser,Language}=await import(pathToFileURL(modulePath).href);
      await Parser.init();
      const probes=[
        ['javascript','function f() { return 1; }'],
        ['typescript','function f(): number { return 1; }'],
        ['tsx','const App = () => <div />;'],
        ['python','def f():\n    return 1\n'],
      ];
      for(const [language,source] of probes){
        const parser=new Parser();
        const grammar=await Language.load(path.join(this.bundleRoot,'grammars','tree-sitter-'+language+'.wasm'));
        try{
          parser.setLanguage(grammar);
          const tree=parser.parse(source);
          try{if(tree.rootNode.hasError)throw new Error('Grammar syntax probe failed: '+language);}
          finally{tree.delete();}
        }finally{parser.delete();}
      }
      list.push({id:'tree-sitter',status:'ready',version:versions['web-tree-sitter'],source:'bundled',detail:'4 WASM grammars parsed',checked:true});
    }catch(error){
      list.push({id:'tree-sitter',status:'unavailable',source:'bundled',
        detail:String(error.message).slice(0,140),checked:true});
    }
    try{
      const python=path.join(runtime,'python','python.exe');
      if(!await isFile(python))throw new Error('Embedded CPython missing.');
      const worker=path.join(this.bundleRoot,'workers','python_index.py');
      const result=await spawnJson(python,['-I','-X','utf8',worker],{
        schemaVersion:1,files:[{path:'health.py',source:'class Probe:\n    def work(self):\n        return 1\n'}],
      },{cwd:root,timeout:7000});
      if(!result.files?.[0]?.symbols?.some(x=>x.qualifiedName==='Probe.work'))throw new Error('AST worker smoke failed.');
      list.push({id:'python-ast',status:'ready',version:'3.11.9',source:'bundled',checked:true});
    }catch(error){
      list.push({id:'python-ast',status:'unavailable',source:'bundled',
        detail:String(error.message).slice(0,140),checked:true});
    }
    const fallback=fallbackSymbols('probe.js','export function probe() { return 1; }');
    list.push({id:'heuristic',status:fallback.symbols.length===1?'ready':'failed',source:'built-in',checked:true});
    this.lastEngineHealth={checkedAt:new Date().toISOString(),engines:list};
    return this.lastEngineHealth;
  }
  async symbols({query='',limit=100}={}){const root=await this.root();if(!await this.#load(root))await this.index();const q=String(query).toLowerCase().trim();
    return {matches:this.cache.entries.flatMap(f=>(f.symbols||[]).filter(s=>!q||s.name.toLowerCase().includes(q)).map(s=>({path:f.path,...s,precision:f.precision||'heuristic'}))).slice(0,Math.min(300,Number(limit)||100)),indexedAt:this.cache.indexedAt};
  }
  async references({symbol,limit=120}={}){if(typeof symbol!=='string'||!/^[_a-zA-Z][_a-zA-Z0-9]{0,100}$/.test(symbol))throw fail('Tên symbol không hợp lệ.');
    const root=await this.root();if(!await this.#load(root))await this.index();
    return {matches:this.cache.entries.flatMap(f=>(f.references||[]).filter(r=>r.name===symbol).map(r=>({path:f.path,...r,precision:f.precision||'heuristic'}))).slice(0,Math.min(300,Number(limit)||120)),confidence:'name-based (AST, not type resolved)'};
  }
  async definitions({symbol}={}){return await this.symbols({query:String(symbol||''),limit:300}).then(x=>({...x,matches:x.matches.filter(y=>y.name===symbol)}));}
  async lspStart({language='python'}={}){
    if (!['python','typescript'].includes(language)) throw fail('LSP language unsupported.');
    if (this.canSpawnLanguageServer && !this.canSpawnLanguageServer()) {
      throw fail('Host language servers are prohibited by sandbox-only execution policy.',403);
    }
    const existing=this.lsp.get(language);
    if (existing?.ready) return {ready:true,language,detail:'Already initialized',executable:existing.exe};
    if (this.lspStarting.has(language)) return await this.lspStarting.get(language);
    const running=(async()=>{
      existing?.close();
      const packaged=path.join(this.bundleRoot,'runtimes','lsp','node_modules');
      const entry=language==='python'
        ?path.join(packaged,'pyright','langserver.index.js')
        :path.join(packaged,'typescript-language-server','lib','cli.mjs');
      const installed=await isFile(path.join(this.bundleRoot,'runtime-manifest.json'));
      const hasBundled=await isFile(entry);
      if (installed && !hasBundled) throw fail('Installed bundled LSP executable is missing.',503);
      const node=path.resolve(this.bundleRoot,'..','runtimes','node','node.exe');
      if (installed && !await isFile(node)) throw fail('Installed bundled Node executable is missing.',503);
      const exe=hasBundled?(await isFile(node)?node:process.execPath)
        :(language==='python'?'pyright-langserver':'typescript-language-server');
      const args=hasBundled?[entry,'--stdio']:['--stdio'];
      const bundledTsserver=path.join(packaged,'typescript','lib','tsserver.js');
      if (language==='typescript' && hasBundled && !await isFile(bundledTsserver)) {
        throw fail('Bundled TypeScript tsserver.js is missing.',503);
      }
      const client=new LspProcess({
        root:await this.root(),exe,args,
        initializationOptions:language==='typescript' && hasBundled
          ? {disableAutomaticTypingAcquisition:true,tsserver:{path:bundledTsserver}}
          : undefined,
        onDiagnostics:(uri,diagnostics)=>this.diagnostics.set(uri,diagnostics),
      });
      this.lsp.set(language,client);
      try{
        await client.start();
        return {ready:true,language,executable:exe,source:hasBundled?'bundled':'developer-path'};
      }catch(error){
        client.close();
        this.lsp.delete(language);
        throw fail('Language server initialization failed: '+error.message,503);
      }
    })();
    this.lspStarting.set(language,running);
    try{return await running;}finally{this.lspStarting.delete(language);}
  }
  async lspRequest({language='python',method='definition',file,line=1,column=1}={}){
    if(!['python','typescript'].includes(language)||!['definition','references','hover','documentSymbol','diagnostics'].includes(method))throw fail('LSP method không hợp lệ.');
    const resolved=await this.workspace.resolve(file);
    const source=await this.workspace.read({file:resolved.relative,maxBytes:250000});
    const uri=pathToFileURL(resolved.absolute).href;
    if(method==='diagnostics')return {uri,diagnostics:this.diagnostics.get(uri)||[]};
    if (!this.lsp.get(language)?.ready) await this.lspStart({language});
    const client=this.lsp.get(language);
    if (!client?.ready) throw fail('Bundled LSP not ready.',503);
    client.open(uri,source.content,language==='python'?'python':/\.[cm]?jsx?$/.test(resolved.relative)?'javascript':'typescript');
    const pos={line:Math.max(0,Number(line)-1),character:Math.max(0,Number(column)-1)};
    const values={definition:['textDocument/definition',{textDocument:{uri},position:pos}],references:['textDocument/references',{textDocument:{uri},position:pos,context:{includeDeclaration:true}}],hover:['textDocument/hover',{textDocument:{uri},position:pos}],documentSymbol:['textDocument/documentSymbol',{textDocument:{uri}}]};
    const [op,params]=values[method];return {uri,method,result:await client.request(op,params)};
  }
  close(){for(const client of this.lsp.values())client.close();this.lsp.clear();}
}
export class LspProcess {
  constructor({root,exe,args=[],initializationOptions=null,onDiagnostics=()=>{},spawnProcess=spawn}={}){this.root=root;this.exe=exe;this.args=args;this.initializationOptions=initializationOptions;this.spawnProcess=spawnProcess;this.onDiagnostics=onDiagnostics;this.stderrTail='';this.serverMessages=[];this.pending=new Map();this.counter=0;this.buffer=Buffer.alloc(0);this.ready=false;this.state='stopped';this.openFiles=new Map();}
  async start(){this.state='starting';
    this.child=this.spawnProcess(this.exe,this.args,{cwd:this.root,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    this.child.stdout.on('data',chunk=>this.consume(chunk));
    this.child.stderr.on('data',chunk=>{this.stderrTail=(this.stderrTail+String(chunk)).slice(-1200);});
    this.child.stdin.on('error',()=>{});
    const died=e=>{this.state='stopped';this.ready=false;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(fail(`LSP process stopped: ${e?.message||''}`,503));}this.pending.clear();};
    this.child.once('error',died);this.child.once('close',()=>died());
    await this.request('initialize',{processId:process.pid,rootUri:pathToFileURL(this.root).href,rootPath:this.root,workspaceFolders:[{uri:pathToFileURL(this.root).href,name:path.basename(this.root)}],initializationOptions:this.initializationOptions||undefined,capabilities:{textDocument:{definition:{},references:{},hover:{},documentSymbol:{}}}},8000);
    this.notify('initialized',{});this.ready=true;this.state='ready';
  }
  send(data){if(!this.child?.stdin?.writable)throw fail('LSP stdin chưa sẵn sàng.',503);
    const body=Buffer.from(JSON.stringify(data),'utf8');this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);this.child.stdin.write(body);
  }
  notify(method,params){this.send({jsonrpc:'2.0',method,params});}
  request(method,params,timeout=12000){const id=++this.counter;return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.pending.delete(id);reject(fail(`LSP ${method} timed out`,504));},timeout);
    this.pending.set(id,{resolve,reject,timer});try{this.send({jsonrpc:'2.0',id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
  });}
  consume(chunk){this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length){const split=this.buffer.indexOf('\r\n\r\n');if(split<0){if(this.buffer.length>16384)this.buffer=Buffer.alloc(0);return;}
      const header=this.buffer.subarray(0,split).toString('ascii');const m=/Content-Length:\s*(\d+)/i.exec(header);
      if(!m){this.buffer=this.buffer.subarray(split+4);continue;}
      const size=Number(m[1]);if(size<0||size>8*1024*1024){this.close();return;}
      if(this.buffer.length<split+4+size)return;
      const payload=this.buffer.subarray(split+4,split+4+size);this.buffer=this.buffer.subarray(split+4+size);
      let value;try{value=JSON.parse(payload.toString('utf8'));}catch{continue;}
      // Language servers can request configuration/workspace data from client.
      // Reply without applying edits or executing commands on the host.
      if(value.method && value.id!==undefined){
        let result=null;
        if(value.method==='workspace/configuration')result=(value.params?.items||[]).map(()=>({}));
        else if(value.method==='workspace/workspaceFolders')result=[{uri:pathToFileURL(this.root).href,name:path.basename(this.root)}];
        else if(value.method==='workspace/applyEdit')result={applied:false,failureReason:'Host edits require explicit Studio review'};
        this.send({jsonrpc:'2.0',id:value.id,result});continue;
      }
      if(value.method==='window/logMessage'||value.method==='window/showMessage'){
        this.serverMessages.push(String(value.params?.message||'').slice(0,400));
        if(this.serverMessages.length>20)this.serverMessages.shift();
      }
      if(value.method==='textDocument/publishDiagnostics')this.onDiagnostics(value.params?.uri,value.params?.diagnostics||[]);
      if(value.id!==undefined){const waiting=this.pending.get(value.id);if(waiting){clearTimeout(waiting.timer);this.pending.delete(value.id);value.error?waiting.reject(fail(`LSP: ${value.error.message}`)):waiting.resolve(value.result);}}
    }
  }
  open(uri,text,languageId){const previous=this.openFiles.get(uri);
    if(previous){if(previous.text!==text){const version=previous.version+1;this.openFiles.set(uri,{version,text});this.notify('textDocument/didChange',{textDocument:{uri,version},contentChanges:[{text}]});}return;}
    this.openFiles.set(uri,{version:1,text});this.notify('textDocument/didOpen',{textDocument:{uri,languageId,version:1,text}});
  }
  closeDocument(uri){if(!this.openFiles.has(uri))return;this.openFiles.delete(uri);this.notify('textDocument/didClose',{textDocument:{uri}});}
  close(){this.ready=false;this.state='stopped';
    for(const uri of this.openFiles.keys()){try{this.notify('textDocument/didClose',{textDocument:{uri}});}catch{}}
    this.openFiles.clear();try{this.child?.kill();}catch{}
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(fail('LSP stopped',503));}this.pending.clear();}
}
