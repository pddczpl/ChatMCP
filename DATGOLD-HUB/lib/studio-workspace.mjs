import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, writeJson } from './runtime.mjs';
import { canonicalRelative, detectEol } from './fs-safe.mjs';
import { isProtectedPath } from './protected-paths.mjs';
import { GitRunner } from './git-runner.mjs';
import { scrubEnv } from './shell-runner.mjs';
import { discoverProjectChecks } from './project-check-discovery.mjs';

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', 'coverage', '.pytest_cache', '.mypy_cache', '.idea', '.vs', '.gradle', '.terraform']);
const EXTENSIONS = new Set(['.py','.js','.mjs','.cjs','.jsx','.ts','.tsx','.json','.md','.yaml','.yml','.toml','.sh','.ps1','.bat','.cmd','.c','.cc','.cpp','.h','.hpp','.java','.go','.rs','.rb','.php','.sql','.r','.ipynb','.css','.html','.xml']);
const PRIVATE = /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|p12|pfx|key)|credentials\.json|secrets?\.json)$/i;
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message),{code,statusCode});
const contained = (root,target) => { const relative=path.relative(root,target); return relative === '' || (!relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
const capped = (value,length=120000) => String(value).slice(0,length);
const TARGETED_FILE_BYTES = 8 * 1024 * 1024;
/** The most text the editor can open and save: 300,000 bytes of UTF-8 (not characters). The route that serves the file and save() both use this number. */
export const EDITABLE_FILE_BYTES = 300_000;
/** The body of a save request: room for EDITABLE_FILE_BYTES of text even if every byte had to be written as a six-character \u00XX escape. An ordinary POST takes 64 KB. */
export const EDITOR_BODY_LIMIT = 6 * EDITABLE_FILE_BYTES + 4096;
const BOM_CHAR = String.fromCharCode(0xfeff);
const UUID = /^[0-9a-f-]{36}$/i;
// What a task review hands out: each side of a file as text up to the editor's own limit, 8 MiB of text in all, 300 files.
const REVIEW_TEXT_BYTES = EDITABLE_FILE_BYTES;
const REVIEW_TOTAL_TEXT_BYTES = 8 * 1024 * 1024;
const REVIEW_MAX_FILES = 300;
const SNIFF_BYTES = 8000;

/**
 * The text of `bytes` when it IS text: no NUL byte and valid UTF-8, so Buffer.from(text) gives the same bytes back (a BOM stays as the first character, line endings as they
 * are). Otherwise why it is not: `binary` (a NUL byte), `not_utf8`, or `too_large` (more than `limit` bytes of it). A file longer than the limit is judged by its head alone (`bytes`
 * may be just the head; `size` is the whole length).
 */
function textOf(bytes, limit, size = bytes.length) {
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return { reason: 'binary' };
  if (size > limit) return { reason: 'too_large' };
  if (bytes.includes(0)) return { reason: 'binary' };
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? { text } : { reason: 'not_utf8' };
}

async function command(exe,args,{cwd,timeout=20000,max=350000,env=process.env}={}) {
  return await new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{cwd,windowsHide:true,shell:false,env,stdio:['ignore','pipe','pipe']});
    let out='';let err='';let stopped=false;
    const timer=setTimeout(()=>{ stopped=true; child.kill('SIGKILL'); },timeout);
    child.stdout.on('data',b=>{out+=b.toString('utf8'); if(out.length>max) { stopped=true; child.kill('SIGKILL'); }});
    child.stderr.on('data',b=>{err+=b.toString('utf8'); if(err.length>max) { stopped=true; child.kill('SIGKILL'); }});
    child.once('error',e=>{ clearTimeout(timer); reject(e); });
    child.once('close',code=>{ clearTimeout(timer); resolve({code,stdout:capped(out,max),stderr:capped(err,3000),truncated:stopped}); });
  });
}

export class StudioWorkspace {
  // The number of the next checkpoint of this process: the clock of `at` has millisecond resolution, and two checkpoints of one task can share a millisecond.
  #checkpointSeq = 0;
  // checkpoint id -> { taskId, workspace }, so that finding the checkpoints of a task does not read every meta.json again (a meta is written once and never changes).
  #owners = new Map();
  // gitOptions: extra GitRunner options (the public server passes the command broker's spawner here).
  constructor({manager, directory, now=()=>new Date().toISOString(), gitOptions={}}) {
    this.manager=manager; this.directory=path.resolve(directory); this.now=now;
    this.indexCache=new Map(); this.indexRoot=null; this.planCache=new Map();
    this.lastCheckpoint=null;
    // A repository can make plain `git status` run a program (core.fsmonitor, hooks, diff drivers).
    // Every Git call of the workspace therefore goes through the hardened runner.
    this.gitRunner=new GitRunner({workspace:this,hooksDirectory:path.join(this.directory,'no-hooks'),secrets:()=>this.manager?.secrets??[],...gitOptions});
  }
  get root() { return this.manager.workspace ? path.resolve(this.manager.workspace) : null; }
  requireRoot() { if(!this.root) throw fail('workspace_missing','Chọn workspace trước.',409); return this.root; }
  async resolve(relative='') {
    const root=await fs.realpath(this.requireRoot());
    if(typeof relative!=='string' || relative.length>4096 || relative.includes('\0')) throw fail('bad_path','Đường dẫn không hợp lệ.');
    if(path.isAbsolute(relative) && !contained(root,path.resolve(relative))) throw fail('outside_workspace','Đường dẫn ngoài workspace.',403);
    if(process.platform==='win32' && /(^|[\\/])[^\\/]*:/.test(relative) && !path.isAbsolute(relative)) throw fail('alternate_stream','Không hỗ trợ luồng dữ liệu thay thế.',403);
    const target=path.resolve(root,relative || '.');
    if(!contained(root,target)) throw fail('outside_workspace','Không cho phép đường dẫn vượt workspace.',403);
    let probe=target;
    while (probe!==root) {
      try {
        const real=await fs.realpath(probe);
        if(!contained(root,real)) throw fail('symlink_escape','Symlink đi ra ngoài workspace.',403);
        break;
      } catch(e) { if(e.code!=='ENOENT') throw e; probe=path.dirname(probe); }
    }
    return { root,absolute:target,relative:path.relative(root,target).replaceAll('\\','/') };
  }
  async tree({directory='',limit=350}={}) {
    limit=Math.max(1,Math.min(600,Number(limit)||350)); const base=await this.resolve(directory);
    const st=await fs.stat(base.absolute); if(!st.isDirectory()) throw fail('not_directory','Đây không phải thư mục.');
    const entries=(await fs.readdir(base.absolute,{withFileTypes:true})).filter(e=>!SKIP.has(e.name)).sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name));
    return {workspace:base.root,directory:base.relative,entries:entries.slice(0,limit).map(e=>({name:e.name,path:path.posix.join(base.relative,e.name),kind:e.isSymbolicLink()?'symlink':e.isDirectory()?'directory':e.isFile()?'file':'other'})),total:entries.length,truncated:entries.length>limit};
  }
  async read({file,maxBytes=120000}={}) {
    const target=await this.resolve(file); if(!target.relative || target.relative.split('/').includes('.git') || PRIVATE.test(path.basename(target.relative))) throw fail('protected_path','Không cho phép đọc file bí mật/metadata Git qua trình đọc Studio.',403);
    const alias=await canonicalRelative(target.root,target.absolute); if(alias.inside && isProtectedPath(alias.relative)) throw fail('protected_path','Không cho phép đọc file bí mật/metadata Git (kể cả khi đi qua symlink hoặc tên rút gọn).',403);
    const stat=await fs.stat(target.absolute); if(!stat.isFile()) throw fail('not_file','Không phải file.');
    maxBytes=Math.max(1,Math.min(500000,Number(maxBytes)||120000));
    if(stat.size>maxBytes) throw fail('file_too_large',`File ${stat.size} byte vượt giới hạn xem ${maxBytes} byte.`,413);
    const bytes=await fs.readFile(target.absolute); if(bytes.includes(0)) throw fail('binary_file','Không mở file nhị phân dưới dạng text.',415);
    // toString('utf8') never fails: every byte sequence that is not UTF-8 (UTF-16 without NUL bytes, Windows-1252, ...) becomes U+FFFD. Text is only what goes back to the very same bytes,
    // and the BOM stays in `content` as its first character; a file that does not pass would be corrupted by the next save.
    const content=bytes.toString('utf8');
    if(!Buffer.from(content,'utf8').equals(bytes)) throw fail('not_utf8','File không phải UTF-8 hợp lệ (có thể là UTF-16 hoặc bảng mã cũ như Windows-1252). Không mở để sửa vì lưu lại sẽ làm hỏng nội dung.',415);
    return {path:target.relative,size:stat.size,sha256:sha(bytes),content,encoding:content.charCodeAt(0)===0xfeff?'utf8-bom':'utf8',eol:detectEol(content)};
  }
  /**
   * Writes text the editor sends back. The file must be UTF-8 (read() refuses anything else), the bytes written are exactly `content` encoded as UTF-8 (nothing is normalized: line
   * endings stay as sent), and the revision the person read (`expectedSha`) must still be the one on disk. A UTF-8 BOM belongs to the file: an editor that dropped the character does not
   * take it out of the file (`bomRestored`), and one that kept it does not double it. The file as it was is saved first, in a checkpoint that holds this file whatever its extension.
   */
  async save({file,content,expectedSha}={}){
    if(typeof content!=='string')throw fail('bad_content','Nội dung lưu phải là văn bản.');
    if(typeof expectedSha!=='string'||!/^[a-f0-9]{64}$/i.test(expectedSha))throw fail('bad_revision','Cần SHA-256 bản đã đọc để lưu.',409);
    // Buffer.from() would turn a lone surrogate into U+FFFD without a word; the person would find a different file than the one they edited.
    if(typeof content.isWellFormed==='function'&&!content.isWellFormed())throw fail('invalid_unicode','Nội dung chứa ký tự Unicode không hợp lệ (surrogate đơn lẻ), không ghi được dưới dạng UTF-8 mà không đổi nội dung.');
    const current=await this.read({file,maxBytes:EDITABLE_FILE_BYTES});
    if(current.sha256!==expectedSha)throw fail('stale_revision','File đã thay đổi; tải lại trước khi lưu.',409);
    const restoreBom=current.encoding==='utf8-bom'&&content.charCodeAt(0)!==0xfeff;
    const bytes=Buffer.from(restoreBom?BOM_CHAR+content:content,'utf8');
    if(bytes.length>EDITABLE_FILE_BYTES)throw fail('too_large',`Nội dung ${bytes.length} byte vượt giới hạn lưu ${EDITABLE_FILE_BYTES} byte (300 KB văn bản) của trình soạn thảo. Dùng agent hoặc terminal cho file lớn hơn.`,413);
    const target=await this.resolve(file);
    const lstat=await fs.lstat(target.absolute);
    if(!lstat.isFile()||lstat.isSymbolicLink())throw fail('file_type','Không chỉnh symlink hoặc file không thông thường.',403);
    if(sha(bytes)===expectedSha)return {ok:true,path:target.relative,unchanged:true,sha256:expectedSha};
    const checkpoint=await this.checkpoint({label:`Before manual edit ${target.relative}`,files:[target.relative],maxFiles:1,maxTotalBytes:10*1024*1024});
    // Check the original revision AGAIN after snapshotting. Another editor may
    // have modified it while the checkpoint was being written.
    const fresh=await fs.readFile(target.absolute);
    if(sha(fresh)!==expectedSha)throw fail('stale_revision','File thay đổi trong lúc tạo checkpoint; chưa ghi dữ liệu.',409);
    const temp=target.absolute+`.${randomUUID()}.tmp`;
    try{await fs.writeFile(temp,bytes,{flag:'wx',mode:lstat.mode});await fs.rename(temp,target.absolute);}
    finally{await fs.unlink(temp).catch(()=>{});}
    return {ok:true,path:target.relative,checkpointId:checkpoint.id,partialCheckpoint:checkpoint.partial,previousSha:expectedSha,sha256:sha(bytes),...(restoreBom?{bomRestored:true}:{})};
  }
  async #files({limit=4500,bytes=500000}={}) {
    const root=await fs.realpath(this.requireRoot()); const stack=[root],files=[];
    while(stack.length && files.length<limit) {
      const dir=stack.pop(); let list; try { list=await fs.readdir(dir,{withFileTypes:true}); } catch {continue;}
      for(const entry of list) {
        if(SKIP.has(entry.name)||entry.isSymbolicLink()||PRIVATE.test(entry.name)) continue;
        const p=path.join(dir,entry.name);
        if(entry.isDirectory()) { if((path.relative(root,p).split(path.sep).length<10)) stack.push(p); continue; }
        if(!entry.isFile()||!EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        try {const st=await fs.stat(p); if(st.size<=bytes) files.push({absolute:p,relative:path.relative(root,p).replaceAll('\\','/'),mtimeMs:st.mtimeMs,size:st.size});} catch{}
        if(files.length>=limit) break;
      }
    }
    return {files,exhausted:stack.length>0||files.length>=limit};
  }
  async search({query,mode='text',limit=60}={}) {
    if(typeof query!=='string'||!query.trim()||query.length>200) throw fail('bad_query','Nhập từ khóa (tối đa 200 ký tự).');
    if(!['text','symbol','filename'].includes(mode)) throw fail('bad_mode','mode phải là text, symbol hoặc filename.');
    limit=Math.max(1,Math.min(100,Number(limit)||60)); const root=await fs.realpath(this.requireRoot());
    if(this.indexRoot!==root) {this.indexCache.clear();this.indexRoot=root;}
    const {files,exhausted}=await this.#files({limit:5000}); const needle=query.toLocaleLowerCase(),matches=[];
    for(const file of files){
      if(mode==='filename'){if(file.relative.toLocaleLowerCase().includes(needle)) matches.push({path:file.relative,line:null,text:file.relative});if(matches.length>=limit)break;continue;}
      const old=this.indexCache.get(file.relative);let entry=old;
      if(!old||old.mtimeMs!==file.mtimeMs||old.size!==file.size) {
        const bytes=await fs.readFile(file.absolute); if(bytes.includes(0)) continue;
        const lines=bytes.toString('utf8').split(/\r?\n/).slice(0,16000);
        const symbols=[];
        for(let i=0;i<lines.length;i++)if(/^\s*(?:(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|def)\s+[\w$]+|(?:public|private|protected)\s+(?:static\s+)?[\w$]+\s*\()/.test(lines[i]))symbols.push({line:i+1,text:lines[i].trim().slice(0,260)});
        entry={...file,lines,symbols};this.indexCache.set(file.relative,entry);
      }
      const entries=mode==='symbol'?entry.symbols:entry.lines.map((text,i)=>({line:i+1,text}));
      for(const line of entries){if(line.text.toLocaleLowerCase().includes(needle)){matches.push({path:file.relative,line:line.line,text:line.text.slice(0,260)}); if(matches.length>=limit)break;}}
      if(matches.length>=limit)break;
    }
    return {query,mode,matches,limit,scannedFiles:files.length,partialScan:exhausted||matches.length===limit};
  }
  async #git(args,{timeout=15000,max=250000}={}) {
    // ensureRepo() refuses a workspace that is not itself the top level of a repository, so a parent
    // repository is never inspected or modified on behalf of a sub-folder.
    await this.gitRunner.ensureRepo();
    const result=await this.gitRunner.text(args,{timeoutMs:timeout,maxBytes:max});
    return {code:result.code,stdout:result.stdout,stderr:result.stderr.slice(0,3000),truncated:result.truncated||result.timedOut};
  }
  async gitStatus() {
    const {stdout,code,stderr}=await this.#git(['status','--short','--untracked-files=all']);
    if(code!==0) throw fail('git_error',stderr);
    const head=await this.#git(['rev-parse','--verify','HEAD']);
    const branchRes=await this.#git(['branch','--show-current']);
    const branch=branchRes.code===0 && branchRes.stdout.trim() ? branchRes.stdout.trim() : (head.code===0 ? head.stdout.trim().slice(0, 7) : 'HEAD');
    const rawEntries=stdout.split(/\r?\n/).filter(Boolean);
    return {
      branch,
      head:head.code===0?head.stdout.trim():null,
      dirty:rawEntries.length>0,
      entries:rawEntries.slice(0,1000),
      partial:rawEntries.length>1000,
    };
  }
  async gitDiff({file='',staged=false}={}) {
    const target=await this.resolve(file);
    const args=['diff','--no-ext-diff','--no-textconv',...(staged?['--cached']:[]),'--',...(target.relative?[target.relative]:[])];
    const result=await this.#git(args,{max:300000});
    if(result.code!==0) throw fail('git_diff_error',result.stderr);
    return {file:target.relative,staged,diff:result.stdout,truncated:result.truncated};
  }
  async gitDiffCheck() {const r=await this.#git(['diff','--check']);return {ok:r.code===0,output:(r.stdout+'\n'+r.stderr).trim(),code:r.code};}
  #checkpointDirectory(id) {if(!/^[0-9a-f-]{36}$/i.test(id))throw fail('bad_checkpoint','Mã checkpoint không hợp lệ.');return path.join(this.directory,'checkpoints',id);}
  async checkpoints({limit=40}={}){
    let dirs=[];try {dirs=await fs.readdir(path.join(this.directory,'checkpoints'),{withFileTypes:true});} catch(e){if(e.code!=='ENOENT')throw e;}
    const result=[];
    // checkpoint() stores the canonical (realpath) root, so compare against the same form;
    // a Windows 8.3 short path or a symlinked workspace path would otherwise never match.
    const root=this.root;const canonicalRoot=root?await fs.realpath(root).catch(()=>root):null;
    for(const dir of dirs){if(!dir.isDirectory()||!/^[0-9a-f-]{36}$/i.test(dir.name))continue;const data=await readJson(path.join(this.#checkpointDirectory(dir.name),'meta.json'));if(canonicalRoot&&data?.workspace===canonicalRoot)result.push({id:data.id,at:data.at,seq:data.seq??0,label:data.label,fileCount:data.files.length,absentCount:(data.absent??[]).length,taskId:data.taskId??null,partial:data.partial,targeted:data.targeted===true,limitations:data.limitations??[]});}
    // Newest first. Of two made in the same millisecond the later one (its number is higher) comes first. This list is capped: a task with more checkpoints than that is read with taskReview().
    return result.sort((a,b)=>b.at.localeCompare(a.at)||b.seq-a.seq).slice(0,Math.max(1,Math.min(limit,100)));
  }
  /**
   * Saves copies of files so a change can be reviewed or undone.
   *  - default: a bounded snapshot of the source files of the workspace (always reported as partial);
   *  - `files`: exactly those files, of any content type (a targeted snapshot taken just before a tool changes,
   *    deletes or creates them). The ones that exist are saved; the ones that do not exist yet are listed in
   *    `absent` (the review needs to know they were not there). Files that cannot be saved are listed in
   *    `skipped`, never hidden. Every path is stored as the file is really named (a Windows 8.3 short name, or
   *    another spelling of the case, is the same file);
   *  - `reuseIfUnchanged`: when no file changed since the previous bounded snapshot of the same task, that snapshot is returned;
   *  - `taskId`: the task the checkpoint was made for (only the Hub's own guard says so; a request over HTTP never does), so that
   *    taskReview() finds all of them, however many there are.
   */
  async checkpoint({label='Manual checkpoint',maxFiles=350,maxTotalBytes=30*1024*1024,files=null,reuseIfUnchanged=false,taskId=null}={}){
    const root=await fs.realpath(this.requireRoot());
    const targeted=Array.isArray(files);
    const owner=typeof taskId==='string'&&UUID.test(taskId)?taskId:null;
    const limitations=[];const skipped=[];const absent=[];let candidates;let exhausted=false;
    if(targeted){
      candidates=[];const seen=new Set();
      for(const requested of files.slice(0,Math.max(1,maxFiles))){
        let target;
        try{target=await this.resolve(String(requested));}catch(error){skipped.push({path:String(requested).slice(0,300),reason:error.code||'invalid_path'});continue;}
        if(!target.relative||isProtectedPath(target.relative)){skipped.push({path:target.relative||'.',reason:'protected'});continue;}
        let relative=null;
        try{const real=await canonicalRelative(target.root,target.absolute);if(real.inside)relative=real.relative;}catch{ /* reported below */ }
        if(!relative){skipped.push({path:target.relative,reason:'unresolvable'});continue;}
        if(isProtectedPath(relative)){skipped.push({path:target.relative,reason:'protected'});continue;} // an 8.3 name or a link to a secret
        const key=process.platform==='win32'?relative.toLowerCase():relative;
        if(seen.has(key))continue;seen.add(key);
        const stat=await fs.lstat(target.absolute).catch(error=>error);
        if(stat instanceof Error){
          if(['ENOENT','ENOTDIR'].includes(stat.code))absent.push(relative); // it does not exist yet: there is nothing to preserve, and the review must know it was not there
          else skipped.push({path:relative,reason:'unreadable'});
          continue;
        }
        if(!stat.isFile()){skipped.push({path:relative,reason:'not_a_regular_file'});continue;}
        if(stat.size>TARGETED_FILE_BYTES){skipped.push({path:relative,reason:'too_large'});continue;}
        candidates.push({absolute:target.absolute,relative,size:stat.size});
      }
      limitations.push('Checkpoint theo file: chỉ gồm các file được chỉ định trước thao tác (kể cả file nhị phân); không phải bản sao của cả workspace.');
    }else{
      ({files:candidates,exhausted}=await this.#files({limit:5000,bytes:2*1024*1024}));
    }
    let fingerprint=null;
    if(!targeted&&reuseIfUnchanged){
      fingerprint=sha(Buffer.from(JSON.stringify(candidates.map(item=>[item.relative,item.size,item.mtimeMs]))));
      // Only within one task: a snapshot belongs to the task that made it, and taskReview() finds a task's baseline by the checkpoints that carry its id.
      if(this.lastCheckpoint?.root===root&&this.lastCheckpoint.fingerprint===fingerprint&&this.lastCheckpoint.taskId===owner)return {...this.lastCheckpoint.result,reused:true};
    }
    const id=randomUUID(),dir=this.#checkpointDirectory(id);await fs.mkdir(path.join(dir,'files'),{recursive:true,mode:0o700});
    let total=0;const stored=[];
    for(let index=0;index<candidates.length;index+=1){
      const item=candidates[index];
      if(stored.length>=maxFiles||total+item.size>maxTotalBytes){
        limitations.push('Giới hạn số file hoặc tổng dung lượng; checkpoint chỉ là một phần.');
        if(targeted)for(const rest of candidates.slice(index))skipped.push({path:rest.relative,reason:'limit'});
        break;
      }
      const bytes=await fs.readFile(item.absolute);
      if(!targeted&&bytes.includes(0))continue;
      const dest=path.join(dir,'files',item.relative);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,bytes,{mode:0o600});
      total+=bytes.length;stored.push({path:item.relative,sha256:sha(bytes),bytes:bytes.length});
    }
    if(exhausted)limitations.push('Workspace vượt giới hạn quét 5000 file nguồn.');
    if(!targeted)limitations.push('Chỉ lưu file nguồn văn bản được hỗ trợ; không bao gồm binary, .env hoặc các thư mục bỏ qua.');
    const meta={id,at:this.now(),seq:++this.#checkpointSeq,label:capped(label,160),workspace:root,taskId:owner,files:stored,absent,partial:true,targeted,skipped,limitations,totalBytes:total};
    await writeJson(path.join(dir,'meta.json'),meta);
    this.#owners.set(id,{taskId:owner,workspace:root});
    const result={id:meta.id,at:meta.at,label:meta.label,fileCount:stored.length,partial:meta.partial,targeted,skipped,absent,limitations,totalBytes:total,taskId:owner,reused:false};
    if(fingerprint)this.lastCheckpoint={root,fingerprint,taskId:owner,result};
    return result;
  }
  async review({checkpointId,file='',limit=300000}={}){
    const meta=await readJson(path.join(this.#checkpointDirectory(checkpointId),'meta.json'));
    if(!meta||meta.workspace!==await fs.realpath(this.requireRoot()))throw fail('checkpoint_missing','Checkpoint không tồn tại cho workspace này.',404);
    const requested=file?(await this.resolve(file)).relative:null;
    const candidates=meta.files.filter(x=>!requested||x.path===requested),changes=[];
    for(const item of candidates){
      const target=await this.resolve(item.path);const before=await fs.readFile(path.join(this.#checkpointDirectory(checkpointId),'files',item.path));
      const after=await fs.readFile(target.absolute).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(after!==null&&sha(after)===item.sha256)continue;
      const current=after===null?null:sha(after);
      // git no-index is used strictly for reading a textual diff, not for restoring.
      let diff='';
      if(after!==null&&!after.includes(0)){
        const result=await command('git',['diff','--no-index','--no-ext-diff','--no-textconv','--',path.join(this.#checkpointDirectory(checkpointId),'files',item.path),target.absolute],{max:160000,timeout:8000,env:scrubEnv(process.env,{secrets:this.manager?.secrets??[]})});
        diff=result.stdout; if(![0,1].includes(result.code)) diff=`Không tạo được diff: ${result.stderr}`;
      } else diff=after===null?'File đã bị xóa.':'File sau hiện là nhị phân.';
      changes.push({path:item.path,baselineSha:item.sha256,currentSha:current,status:after===null?'deleted':'modified',diff:capped(diff,Math.min(Number(limit)||300000,300000))});
    }
    // Files absent from the bounded checkpoint cannot be classified as newly
    // created. Use Git status for additions; never offer to delete them.
    return {checkpointId,at:meta.at,label:meta.label,partial:meta.partial,limitations:meta.limitations,changes:changes.slice(0,300),truncated:changes.length>300};
  }

  /** The checkpoints made for a task in this workspace, oldest first. Found by the task id in each meta.json and not through checkpoints(), which stops at 100: a long task has more. */
  async #taskCheckpoints(taskId,root){
    let dirs=[];try{dirs=await fs.readdir(path.join(this.directory,'checkpoints'),{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    if(this.#owners.size>50000)this.#owners.clear();
    const metas=[];let unreadable=0;
    for(const dir of dirs){
      if(!dir.isDirectory()||!UUID.test(dir.name))continue;
      let owner=this.#owners.get(dir.name);let meta=null;
      if(!owner){
        try{meta=await readJson(path.join(this.#checkpointDirectory(dir.name),'meta.json'));}catch{unreadable+=1;continue;}
        if(!meta)continue; // its meta.json is the last thing a checkpoint writes: this one is still being made
        owner={taskId:typeof meta.taskId==='string'?meta.taskId:null,workspace:meta.workspace};
        this.#owners.set(dir.name,owner);
      }
      if(owner.taskId!==taskId||owner.workspace!==root)continue;
      try{meta??=await readJson(path.join(this.#checkpointDirectory(dir.name),'meta.json'));}catch{unreadable+=1;continue;}
      if(meta)metas.push(meta);
    }
    metas.sort((a,b)=>(a.at<b.at?-1:a.at>b.at?1:0)||(a.seq??0)-(b.seq??0));
    return {metas,unreadable};
  }
  /** The copy a checkpoint holds of a file, or null when it is missing or does not match the sha the checkpoint recorded for it. */
  async #storedCopy(meta,item){
    const base=path.join(this.#checkpointDirectory(meta.id),'files');const file=path.join(base,item.path);
    if(!contained(base,file))return null;
    const bytes=await fs.readFile(file).catch(()=>null);
    return bytes&&sha(bytes)===item.sha256?bytes:null;
  }
  async #storedHead(meta,item){
    const base=path.join(this.#checkpointDirectory(meta.id),'files');const file=path.join(base,item.path);
    if(!contained(base,file))return null;
    const handle=await fs.open(file,'r').catch(()=>null);if(!handle)return null;
    try{const head=Buffer.alloc(SNIFF_BYTES);const {bytesRead}=await handle.read(head,0,SNIFF_BYTES,0);return head.subarray(0,bytesRead);}finally{await handle.close();}
  }
  /** What is on disk now. A file that fits the review is read; a longer one is hashed as a stream and only its head is kept, to tell text from binary. */
  async #currentFile(absolute){
    const stat=await fs.lstat(absolute).catch(error=>{if(['ENOENT','ENOTDIR'].includes(error.code))return null;throw error;});
    if(!stat)return {state:'missing'};
    if(!stat.isFile())return {state:'other'}; // a link or a folder is not a file to review
    if(stat.size<=REVIEW_TEXT_BYTES){const bytes=await fs.readFile(absolute);return {state:'file',size:bytes.length,sha:sha(bytes),bytes,mtimeMs:stat.mtimeMs};}
    const hash=createHash('sha256');let head=Buffer.alloc(0);
    for await(const chunk of createReadStream(absolute)){hash.update(chunk);if(head.length<SNIFF_BYTES)head=Buffer.concat([head,chunk]).subarray(0,SNIFF_BYTES);}
    return {state:'file',size:stat.size,sha:hash.digest('hex'),head,mtimeMs:stat.mtimeMs};
  }
  /** The file as the last commit has it, in the form the working tree has (end-of-line conversion and the like applied: `cat-file --filters`), or null when the commit has no such file. */
  async #headFile(relative,context){
    context.gitReady??=this.gitRunner.ensureRepo().then(()=>true,()=>false);
    if(!await context.gitReady)return null;
    try{
      const result=await this.gitRunner.exec(['cat-file','--filters',`HEAD:${relative}`],{timeoutMs:15000,maxBytes:TARGETED_FILE_BYTES});
      return result.code===0&&!result.truncated&&!result.timedOut?result.stdout:null;
    }catch{return null;}
  }
  /**
   * Files that Git reports as changed or new and that were written between `sinceMs` (the first snapshot of the task) and `untilMs` (when the task stopped; none while it runs or when
   * that is not known): what a command may have left that no snapshot held (it keeps source files only, and only so many). A deletion is not listed (it cannot be told from one the
   * task did not make), nor is a file older than the task (it was the person's change). What the person writes while the task runs, or after it when its end is not known, cannot be told
   * apart: such a file is listed, and `partial` says that its baseline is only the last commit.
   */
  async #changedByGit(root,sinceMs,untilMs,context){
    context.gitReady??=this.gitRunner.ensureRepo().then(()=>true,()=>false);
    if(!await context.gitReady)return {paths:[],available:false};
    let output;
    try{
      const result=await this.gitRunner.exec(['status','--porcelain=v1','-z','--untracked-files=all','--no-renames'],{timeoutMs:15000,maxBytes:2_000_000});
      if(result.code!==0||result.truncated||result.timedOut)return {paths:[],available:false};
      output=result.stdout.toString('utf8');
    }catch{return {paths:[],available:false};}
    const paths=[];
    for(const entry of output.split('\0')){
      if(entry.length<4)continue;
      const status=entry.slice(0,2),relative=entry.slice(3);
      if(/[DU]/.test(status)||!relative)continue;
      const stat=await fs.lstat(path.join(root,relative)).catch(()=>null);
      if(stat?.isFile()&&stat.mtimeMs>=sinceMs&&(untilMs===null||stat.mtimeMs<=untilMs))paths.push(relative);
    }
    return {paths:paths.sort().slice(0,200),available:true};
  }
  /** key -> shas of the files the person accepted in a review of one of these checkpoints (accept() writes them). */
  async #acceptedFiles(metas,keyOf){
    const accepted=new Map();
    for(const meta of metas){
      let entry=null;try{entry=await readJson(path.join(this.directory,'reviews',`${meta.id}.json`));}catch{ /* an unreadable record accepts nothing */ }
      for(const item of entry?.accepted??[]){const key=keyOf(String(item.file));if(!accepted.has(key))accepted.set(key,new Set());accepted.get(key).add(item.sha256);}
    }
    return accepted;
  }

  /**
   * What a task changed, as full texts, for a review of the whole task (not of one checkpoint). For each file the EARLIEST checkpoint that knows it is the baseline: the file as it was
   * before the task first touched it, or a record that it did not exist (`absent`: a file the task created). The answer for a file is
   *   { path, status: modified|created|deleted|binary, change: modified|created|deleted, baselineText, currentText, baselineSha, currentSha, partial, accepted, baselineSource, checkpointId, rejectable }
   * and, when there is no text, `textUnavailable`: binary and not_utf8 (status is then `binary`), too_large (over 300 KB a side), checkpoint_corrupt, budget. A text is the file's bytes and
   * nothing else: Buffer.from(text) is the file (a BOM is the first character, line endings are as they are). `partial` is false only when the baseline is a copy made just before a tool
   * that named the file; it is true for a copy from a snapshot of the whole workspace (taken before a command), whose reach is bounded. `rejectable` is true only for a file that the
   * checkpoint of the call that created it recorded as absent: rejectCreated() never touches any other file.
   * The answer also says what it is made of (`checkpoints`) and what it cannot see (`limitations`): an empty list is not "no changes" when no checkpoint is on record.
   */
  async taskReview({taskId,file='',until=null}={}){
    if(typeof taskId!=='string'||!UUID.test(taskId))throw fail('bad_task_id','Cần ID nhiệm vụ hợp lệ.');
    const untilMs=typeof until==='string'&&Number.isFinite(Date.parse(until))?Date.parse(until):null;
    const root=await fs.realpath(this.requireRoot());
    const keyOf=(relative)=>process.platform==='win32'?relative.toLowerCase():relative;
    let wanted=null;
    if(file){const target=await this.resolve(file);const real=await canonicalRelative(target.root,target.absolute).catch(()=>({inside:false}));wanted=keyOf(real.inside?real.relative:target.relative);}
    const {metas,unreadable}=await this.#taskCheckpoints(taskId,root);
    const limitations=[];
    if(unreadable)limitations.push({code:'unreadable_checkpoints',message:`${unreadable} checkpoint không đọc được nên không nằm trong bản review.`});
    if(!metas.length)limitations.push({code:'no_checkpoints',message:'Không có checkpoint nào của nhiệm vụ này trong thư mục trạng thái của workspace này (nhiệm vụ không sửa file, chạy ở workspace hay agent khác, hoặc chạy trước khi checkpoint ghi mã nhiệm vụ). Danh sách rỗng KHÔNG có nghĩa là không có thay đổi.'});
    // Per path, the first thing a checkpoint of the task says about it.
    const evidence=new Map();
    // `explicit`: a checkpoint of a call that NAMED the file says something about it (a snapshot of the whole workspace does not name anything).
    const note=(relative,entry)=>{
      const key=keyOf(relative);const explicit=entry.meta.targeted===true&&entry.kind!=='git';
      if(!evidence.has(key))evidence.set(key,{path:relative,key,explicit,...entry});
      else if(explicit)evidence.get(key).explicit=true;
    };
    for(const meta of metas){
      for(const item of meta.files??[])note(item.path,{kind:'file',meta,item});
      for(const relative of meta.absent??[])note(relative,{kind:'absent',meta});
      for(const skip of meta.skipped??[])if(['too_large','limit'].includes(skip.reason))note(skip.path,{kind:'skipped',meta,skip});
    }
    const accepted=await this.#acceptedFiles(metas,keyOf);
    const context={accepted,budget:{left:REVIEW_TOTAL_TEXT_BYTES},gitReady:null,untilMs};
    // A command can write anywhere, and the snapshot taken before it holds source files only: ask Git what else changed since the first such snapshot.
    const broad=metas.find(meta=>meta.targeted!==true);
    if(broad&&!wanted){
      const found=await this.#changedByGit(root,Date.parse(broad.at),untilMs,context);
      if(!found.available)limitations.push({code:'git_unavailable',message:'Không hỏi được Git nên không thấy các file mà lệnh shell ghi ngoài ảnh chụp workspace.'});
      for(const relative of found.paths)note(relative,{kind:'git',meta:broad});
    }
    const files=[];let omittedProtected=0;let truncated=false;
    for(const ev of [...evidence.values()].sort((a,b)=>(a.path<b.path?-1:a.path>b.path?1:0))){
      if(wanted&&ev.key!==wanted)continue;
      // The same rule as read(): a secret or Git metadata is never handed out, not even when a checkpoint or Git has it.
      if(isProtectedPath(ev.path)||PRIVATE.test(path.basename(ev.path))||ev.path.split('/').includes('.git')){omittedProtected+=1;continue;}
      if(files.length>=REVIEW_MAX_FILES){truncated=true;break;}
      const entry=await this.#reviewFile(ev,context);
      if(entry)files.push(entry);
    }
    if(truncated)limitations.push({code:'truncated',message:`Chỉ trả ${REVIEW_MAX_FILES} file đầu tiên (theo đường dẫn).`});
    const targetedCount=metas.filter(meta=>meta.targeted===true).length;
    return {taskId,checkpoints:{total:metas.length,targeted:targetedCount,broad:metas.length-targetedCount},files,truncated,omitted:{protected:omittedProtected},limitations};
  }
  async #reviewFile(ev,context){
    const {accepted,budget}=context;
    const target=await this.resolve(ev.path).catch(()=>null);
    if(!target)return null; // it no longer resolves inside this workspace
    const now=await this.#currentFile(target.absolute);
    // A snapshot of the whole workspace holds every source file, so a file in it that no call of the task named is the task's only if it changed while the task was running: what was
    // written after the task stopped is somebody else's (the person's, a later task's).
    if(!ev.explicit&&ev.kind==='file'&&context.untilMs!==null&&now.state==='file'&&now.mtimeMs>context.untilMs)return null;
    let base;
    if(ev.kind==='absent')base={exists:false,source:'absent',partial:false};
    else if(ev.kind==='file')base={exists:true,sha:ev.item.sha256,size:ev.item.bytes,source:'checkpoint',partial:ev.meta.targeted!==true};
    else{
      // No checkpoint holds the file as it was (too large for one, or found only through Git): the last commit is the nearest thing. It may not be what the task found (the person could have
      // changed the file before), so it is never an exact baseline.
      const head=await this.#headFile(ev.path,context);
      if(head)base={exists:true,sha:sha(head),size:head.length,source:'git_head',partial:true,bytes:head};
      else if(ev.kind==='git')base={exists:false,source:'git_head',partial:true}; // the last commit has no such file: new, as far as it can tell
      else base={exists:false,unknown:true,source:'none',partial:true};
    }
    let change;
    if(!base.exists&&!base.unknown){if(now.state!=='file')return null;change='created';} // not there before, not a file now (or gone again): nothing to review
    else if(now.state==='missing')change='deleted';
    else if(now.state==='other')change='modified';
    else if(base.exists&&base.sha===now.sha)return null; // the task left it as it found it
    else change='modified';
    // Both sides, as text when they are text.
    let problem=null;let baseSide=null;
    if(base.exists){
      const bytes=base.bytes??(base.size<=REVIEW_TEXT_BYTES?await this.#storedCopy(ev.meta,ev.item):await this.#storedHead(ev.meta,ev.item));
      if(!bytes)problem='checkpoint_corrupt';else baseSide=textOf(bytes,REVIEW_TEXT_BYTES,base.size);
    }
    const nowSide=now.state==='file'?textOf(now.bytes??now.head,REVIEW_TEXT_BYTES,now.size):null;
    const reasons=[baseSide?.reason,nowSide?.reason].filter(Boolean);
    let status=change;let textUnavailable=problem;
    if(!textUnavailable){
      if(reasons.includes('binary')){status='binary';textUnavailable='binary';}
      else if(reasons.includes('not_utf8')){status='binary';textUnavailable='not_utf8';}
      else if(reasons.includes('too_large'))textUnavailable='too_large';
      else if(base.unknown)textUnavailable='baseline_unavailable';
    }
    let baselineText=null;let currentText=null;
    if(!textUnavailable){
      const cost=(baseSide?.text?.length??0)+(nowSide?.text?.length??0);
      if(cost>budget.left)textUnavailable='budget';
      else{budget.left-=cost;baselineText=baseSide?.text??null;currentText=nowSide?.text??null;}
    }
    const currentSha=now.state==='file'?now.sha:null;
    return {
      path:ev.path,status,change,baselineText,currentText,
      baselineSha:base.exists?base.sha:null,currentSha,
      partial:base.partial||problem!==null,
      accepted:currentSha!==null&&accepted.get(ev.key)?.has(currentSha)===true,
      baselineSource:base.source,checkpointId:ev.meta.id,
      rejectable:ev.kind==='absent'&&change==='created'&&now.state==='file',
      ...(textUnavailable?{textUnavailable}:{}),
    };
  }

  /**
   * Takes a file that a task created out of the workspace and puts it in the undo folder (undo/<id>/files/<path>, with a meta.json): the file is never deleted without a verified copy. Only a
   * file that the checkpoint of the call that created it recorded as absent can be rejected, and only while it is the very file that was reviewed (`expectedSha`). The file is first renamed
   * next to itself, so that what is checked and copied is exactly what leaves: an editor that saves meanwhile makes a new file at the old name and loses nothing.
   */
  async rejectCreated({taskId,file,expectedSha}={}){
    if(typeof expectedSha!=='string'||!/^[0-9a-f]{64}$/i.test(expectedSha))throw fail('revision_required','Cần SHA-256 của file hiện tại.',409);
    if(typeof file!=='string'||!file)throw fail('bad_path','Cần đường dẫn file.');
    const root=await fs.realpath(this.requireRoot());
    const review=await this.taskReview({taskId,file});
    const item=review.files[0];
    if(!item)throw fail('stale_review','File này không còn là file mà nhiệm vụ đã tạo; hãy tải lại review.',409);
    if(!item.rejectable)throw fail('not_rejectable','Chỉ từ chối được file mà chính nhiệm vụ này đã tạo và Hub đã ghi nhận là chưa tồn tại trước thao tác đó.',409);
    if(item.currentSha!==expectedSha.toLowerCase())throw fail('stale_review','File đã thay đổi kể từ khi xem; hãy tải lại review.',409);
    const target=await this.resolve(item.path);
    const aside=`${target.absolute}.${randomUUID()}.rejecting`;
    try{await fs.rename(target.absolute,aside);}
    catch(error){if(['EBUSY','EPERM','EACCES'].includes(error.code))throw fail('file_locked','File đang bị chương trình khác khóa; chưa chuyển đi.',423);throw error;}
    try{
      const bytes=await fs.readFile(aside);
      if(sha(bytes)!==item.currentSha)throw fail('stale_review','File đã thay đổi kể từ khi xem; hãy tải lại review.',409);
      const undoId=randomUUID(),undoDirectory=path.join(this.directory,'undo',undoId),backup=path.join(undoDirectory,'files',item.path);
      await fs.mkdir(path.dirname(backup),{recursive:true,mode:0o700});
      await fs.writeFile(backup,bytes,{mode:0o600});
      if(sha(await fs.readFile(backup))!==item.currentSha)throw fail('undo_backup_failed','Không ghi được bản sao lưu đúng nội dung; file được giữ nguyên.',500);
      await writeJson(path.join(undoDirectory,'meta.json'),{id:undoId,at:this.now(),kind:'reject_created',label:capped(`Rejected a file created by task ${taskId}: ${item.path}`,200),taskId,workspace:root,files:[{path:item.path,sha256:item.currentSha,bytes:bytes.length}]});
      await fs.unlink(aside);
      return {ok:true,path:item.path,sha256:item.currentSha,undoId,undoBackup:backup};
    }catch(error){
      // Back where it was, unless a file has appeared there meanwhile (then the moved one stays beside it under its new name, and the message says so).
      const free=await fs.lstat(target.absolute).then(()=>false,()=>true);
      if(free)await fs.rename(aside,target.absolute).catch(()=>{});
      throw error;
    }
  }

  async accept({checkpointId,file,expectedSha}={}){
    const target=await this.resolve(file);
    if(typeof expectedSha!=='string'||!/^[0-9a-f]{64}$/i.test(expectedSha))throw fail('revision_required','Cần SHA-256 của file hiện tại.',409);
    const review=await this.review({checkpointId,file:target.relative});
    const current=review.changes.find(x=>x.path===target.relative);
    let acceptable=Boolean(current)&&current.currentSha===expectedSha;
    if(!current){
      // A file the call created is not in the checkpoint's files, but the checkpoint recorded that it was not there: that is what is accepted.
      const meta=await readJson(path.join(this.#checkpointDirectory(checkpointId),'meta.json'));
      const real=await canonicalRelative(target.root,target.absolute).catch(()=>({inside:false}));
      const bytes=(meta?.absent??[]).includes(real.inside?real.relative:target.relative)?await fs.readFile(target.absolute).catch(()=>null):null;
      acceptable=Boolean(bytes)&&sha(bytes)===expectedSha;
    }
    if(!acceptable) throw fail('stale_review','File đã đổi hoặc không nằm trong bản review; hãy tải lại diff.',409);
    const fileOnDisk=path.join(this.directory,'reviews',`${checkpointId}.json`);
    const entry=await readJson(fileOnDisk)??{checkpointId,accepted:[]};
    entry.accepted=entry.accepted.filter(x=>x.file!==target.relative);
    entry.accepted.push({file:target.relative,sha256:expectedSha,at:this.now()});
    await writeJson(fileOnDisk,entry);
    return {ok:true,file:target.relative,sha256:expectedSha,acceptedAt:this.now()};
  }
  async restore({checkpointId,file,expectedSha}={}){
    const meta=await readJson(path.join(this.#checkpointDirectory(checkpointId),'meta.json'));
    if(!meta||meta.workspace!==await fs.realpath(this.requireRoot()))throw fail('checkpoint_missing','Checkpoint không hợp lệ.',404);
    const target=await this.resolve(file),item=meta.files.find(x=>x.path===target.relative);
    if(!item)throw fail('not_in_checkpoint','Không thể hoàn tác file không có trong bản checkpoint.',409);
    if(typeof expectedSha!=='string'||!/^[a-f0-9]{64}$/i.test(expectedSha))throw fail('revision_required','Cần mã SHA-256 của bản hiện tại để chống ghi đè thay đổi mới.',409);
    const current=await fs.readFile(target.absolute).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!current||sha(current)!==expectedSha)throw fail('stale_review','File đã thay đổi kể từ khi xem diff; tải lại review.',409);
    const original=await fs.readFile(path.join(this.#checkpointDirectory(checkpointId),'files',item.path));
    if(sha(original)!==item.sha256)throw fail('checkpoint_corrupt','File checkpoint sai checksum.',500);
    const undo=path.join(this.directory,'undo',`${randomUUID()}.backup`);
    await fs.mkdir(path.dirname(undo),{recursive:true,mode:0o700});await fs.writeFile(undo,current,{mode:0o600});
    const tmp=`${target.absolute}.${randomUUID()}.tmp`;
    try {await fs.writeFile(tmp,original,{flag:'wx',mode:0o600});await fs.rename(tmp,target.absolute);} finally {await fs.unlink(tmp).catch(()=>{});}
    return {ok:true,path:target.relative,restoredSha:item.sha256,previousSha:expectedSha,undoBackup:undo};
  }
  async previewCheckpoint({ checkpointId } = {}) {
    return this.restoreCheckpoint({ checkpointId, dryRun: true });
  }

  async restoreCheckpoint({ checkpointId, force = false, expectedShas = null, dryRun = false } = {}) {
    if (!dryRun && this._restoreBusy) throw fail('restore_busy', 'Checkpoint restoration already running.', 409);
    if (!dryRun) this._restoreBusy = true;
    try {
    if (!checkpointId || typeof checkpointId !== 'string') throw fail('bad_checkpoint_id', 'Cần ID checkpoint hợp lệ.');
    const activeTaskId = this.manager?.taskId
      || this.manager?.taskEngine?.state?.()?.activeTaskId
      || this.manager?.agent?.state?.()?.activeTaskId
      || (typeof this.manager?.state === 'function' ? this.manager.state()?.agent?.activeTaskId : null);
    if (activeTaskId) {
      throw fail('task_in_progress', 'Không thể khôi phục checkpoint khi agent đang thực thi tác vụ trên workspace.', 409);
    }
    const meta = await readJson(path.join(this.#checkpointDirectory(checkpointId), 'meta.json'));
    if (!meta || meta.workspace !== await fs.realpath(this.requireRoot())) {
      throw fail('checkpoint_missing', 'Checkpoint không tồn tại cho workspace này.', 404);
    }
    if (!Array.isArray(meta.files) || !meta.files.length) {
      throw fail('empty_checkpoint', 'Bản checkpoint không chứa file nào để khôi phục.', 400);
    }

    if (!dryRun) {
      if (!expectedShas || typeof expectedShas !== 'object') {
        throw fail('missing_expected_shas', 'Tham số expectedShas là bắt buộc cho tất cả các file bị ảnh hưởng khi khôi phục checkpoint.', 400);
      }
    }

    // Phase 1: Complete preflight validation across all files
    const preflight = [];
    const root = await fs.realpath(this.requireRoot());
    for (const item of meta.files) {
      const target = await this.resolve(item.path);
      // Path traversal & workspace containment check
      if (!contained(root, target.absolute) || !target.relative || isProtectedPath(target.relative)) {
        throw fail('path_escape', `Đường dẫn file "${item.path}" vượt ra ngoài thư mục workspace.`, 403);
      }
      // Symlink verification: neither target nor its realpath should escape
      const lstat = await fs.lstat(target.absolute).catch(() => null);
      if (lstat?.isSymbolicLink()) throw fail('symlink_escape', 'Checkpoint restore cannot follow symlinks.', 403);
      if (lstat && !lstat.isFile()) throw fail('file_type', 'Checkpoint target is not a regular file.', 403);

      // Checkpoint backup integrity verification
      const backupPath = path.join(this.#checkpointDirectory(checkpointId), 'files', item.path);
      const backupBytes = await fs.readFile(backupPath).catch(() => null);
      if (!backupBytes || sha(backupBytes) !== item.sha256) {
        throw fail('checkpoint_corrupt', `File "${item.path}" trong bản sao lưu checkpoint bị thiếu hoặc sai checksum SHA-256.`, 500);
      }

      // Read current disk content
      const currentBytes = await fs.readFile(target.absolute).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      const currentSha = currentBytes ? sha(currentBytes) : null;

      // Current content SHA verification / stale state rejection
      if (!dryRun) {
        if (!Object.hasOwn(expectedShas, item.path)) {
          throw fail('missing_expected_shas', `Thiếu expected_sha cho file "${item.path}". Hãy gọi previewCheckpoint trước khi khôi phục.`, 400);
        }
        if (currentSha !== expectedShas[item.path]) {
          throw fail('stale_state', `File "${item.path}" đã thay đổi kể từ lần xem preview (SHA hiện tại ${currentSha?.slice(0, 8) || 'deleted'} khác với SHA mong đợi ${expectedShas[item.path]?.slice(0, 8) || 'none'}). Hãy tải lại review trước khi khôi phục.`, 409);
        }
      }

      preflight.push({
        item,
        target,
        backupBytes,
        currentBytes,
        currentSha,
        isModified: currentSha !== item.sha256,
        willOverwriteNewer: currentBytes !== null && currentSha !== item.sha256,
        willRestoreDeleted: currentBytes === null,
      });
    }

    // Dry Run / Preview Mode
    if (dryRun) {
      return {
        ok: true,
        checkpointId,
        dryRun: true,
        partial: Boolean(meta.partial),
        limitations: meta.limitations || [],
        totalFiles: preflight.length,
        modifiedFilesCount: preflight.filter((p) => p.isModified).length,
        files: preflight.map((p) => ({
          path: p.item.path,
          baselineSha: p.item.sha256,
          currentSha: p.currentSha,
          status: p.currentBytes === null ? 'deleted_on_disk' : (p.currentSha === p.item.sha256 ? 'unmodified' : 'modified'),
          willOverwriteNewer: p.willOverwriteNewer,
        })),
      };
    }

    // Phase 2: Create undo backup before mutation
    const undoId = randomUUID();
    const undoDir = path.join(this.directory, 'undo', undoId);
    await fs.mkdir(path.join(undoDir, 'files'), { recursive: true, mode: 0o700 });
    const undoFiles = [];
    for (const p of preflight) {
      if (p.currentBytes) {
        const undoDest = path.join(undoDir, 'files', p.item.path);
        await fs.mkdir(path.dirname(undoDest), { recursive: true });
        await fs.writeFile(undoDest, p.currentBytes, { mode: 0o600 });
        undoFiles.push({ path: p.item.path, sha256: p.currentSha, bytes: p.currentBytes.length });
      }
    }
    await writeJson(path.join(undoDir, 'meta.json'), {
      id: undoId,
      at: this.now(),
      label: `Undo backup before restoring checkpoint ${checkpointId}`,
      checkpointId,
      workspace: meta.workspace,
      files: undoFiles,
    });

    // Phase 3: Transactional atomic restoration with safe rollback
    const written = [];
    try {
      for (const p of preflight) {
        if (p.currentSha === p.item.sha256) {
          // File already exactly matches checkpoint
          continue;
        }
        const fresh = await fs.readFile(p.target.absolute).catch((e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        });
        if ((fresh === null ? null : sha(fresh)) !== p.currentSha) {
          throw fail('stale_state', 'Checkpoint target changed after preflight.', 409);
        }
        await fs.mkdir(path.dirname(p.target.absolute), { recursive: true });
        const tmp = `${p.target.absolute}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(tmp, p.backupBytes, { flag: 'w', mode: 0o600 });
          await fs.rename(tmp, p.target.absolute);
          written.push(p);
        } finally {
          await fs.unlink(tmp).catch(() => {});
        }
      }
    } catch (writeErr) {
      // Transaction rollback
      const rolledBack = [];
      const failedRollback = [];
      for (const w of written) {
        try {
          const current = await fs.readFile(w.target.absolute).catch((e) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          });
          if (!current || sha(current) !== w.item.sha256) {
            throw fail('rollback_conflict', 'Restored file was modified concurrently; refusing to overwrite.', 409);
          }
          if (w.currentBytes !== null) {
            const backupTemp = `${w.target.absolute}.${randomUUID()}.rollback`;
            try {
              await fs.writeFile(backupTemp, w.currentBytes, { flag: 'wx', mode: 0o600 });
              await fs.rename(backupTemp, w.target.absolute);
            } finally { await fs.unlink(backupTemp).catch(() => {}); }
          } else {
            await fs.unlink(w.target.absolute);
          }
          rolledBack.push(w.item.path);
        } catch (rbErr) {
          failedRollback.push({ path: w.item.path, error: rbErr.message });
        }
      }
      if (failedRollback.length === 0) {
        throw fail('restore_failed_rolled_back', `Khôi phục checkpoint thất bại tại file: ${writeErr.message}. Toàn bộ ${rolledBack.length} file đã được hoàn tác về trạng thái ban đầu an toàn.`, 500);
      } else {
        throw Object.assign(fail('restore_partial_failure', `Khôi phục checkpoint thất bại: ${writeErr.message}. CẢNH BÁO: ${failedRollback.length} file không thể hoàn tác: ${failedRollback.map((f) => f.path).join(', ')}. Đã hoàn tác: ${rolledBack.join(', ') || 'không có'}.`, 500), {
          rolledBack,
          failedRollback,
          undoCheckpointId: undoId,
        });
      }
    }

    return {
      ok: true,
      checkpointId,
      restoredCount: preflight.length,
      filesModified: written.length,
      files: preflight.map((p) => p.item.path),
      undoCheckpointId: undoId,
      partial: Boolean(meta.partial),
      limitations: meta.limitations || [],
      warnings: meta.partial ? ['Bản checkpoint này là partial (chỉ chứa một phần file của workspace). Hãy kiểm tra kỹ sau khi khôi phục.'] : [],
    };
    } finally { if (!dryRun) this._restoreBusy = false; }
  }
  async plan({taskId,operation='get',items=[],title=''}={}){
    if(typeof taskId!=='string'||!/^[0-9a-f-]{36}$/i.test(taskId))throw fail('bad_task_id','Cần ID hội thoại hợp lệ.');
    const file=path.join(this.directory,'plans',`${taskId}.json`);
    let plan=await readJson(file)??{taskId,workspace:this.root,title:'',items:[],updatedAt:null};
    if(plan.workspace!==this.root)throw fail('wrong_workspace','Kế hoạch thuộc workspace khác.',409);
    if(operation==='get')return plan;
    if(operation==='set'){
      if(!Array.isArray(items)||items.length>100||items.some(i=>typeof i.text!=='string'||i.text.length>500||!['todo','doing','done','blocked'].includes(i.status)))throw fail('bad_plan','Danh sách phải có tối đa 100 mục với trạng thái todo/doing/done/blocked.');
      plan={taskId,workspace:this.root,title:capped(title,240),items:items.map(i=>({text:i.text,status:i.status,evidence:capped(i.evidence||'',600)})),updatedAt:this.now()};
      await writeJson(file,plan);return plan;
    }
    throw fail('bad_operation','operation phải là get hoặc set.');
  }
  async skills(){
    const root=this.requireRoot(); const locations=['AGENTS.md','SKILL.md','.github/copilot-instructions.md','.claude/CLAUDE.md','CLAUDE.md'];
    const list=[];
    for(const file of locations){try{const result=await this.read({file,maxBytes:75000});list.push({path:file,sha256:result.sha256,text:result.content.slice(0,15000)});}catch(e){if(!['ENOENT','not_file'].includes(e.code))continue;}}
    return {workspace:root,skills:list};
  }
  async checks(){
    const root=this.requireRoot();
    return discoverProjectChecks(root);
  }
}
