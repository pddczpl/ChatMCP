// Phase 2 owner-only, read-only context PREVIEW for a managed Git worktree.
// This never injects content into an AI model, starts a tool or attests tests.
// Caller supplies trusted COMMITTED changed paths, not a model/user path query.
// Explicitly avoid secrets, binary files, reparse links and giant payloads.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const BAD=(code,message)=>Object.assign(new Error(message),{code,statusCode:409});
const CONTROL=/[\u0000-\u001f\u007f]/u;
const RESTRICTED=/(^|\/)(?:\.git|\.ssh|node_modules|\.venv|\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials?|secrets?)(?:\/|$)/i;
const SECRET_EXT=/\.(?:pem|p12|pfx|key|keystore|kdbx)$/i;
const DEVICE=/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

function safeRelative(p){
  if(typeof p!=='string'||p.length<1||p.length>1024||CONTROL.test(p))
    throw BAD('context_bad_path','Changed file path is empty, unbounded or contains controls.');
  const normalized=p.replaceAll('\\','/');
  if(normalized.startsWith('/')||/^[a-z]:/i.test(normalized))
    throw BAD('context_bad_path','Absolute file paths are not allowed.');
  const segments=normalized.split('/');
  if(segments.some(s=>!s||s==='.'||s==='..'||s.includes(':')||/[. ]$/u.test(s)||DEVICE.test(s)))
    throw BAD('context_bad_path','Ambiguous or traversing relative file path.');
  return normalized;
}
function secretLike(p){return RESTRICTED.test(p)||SECRET_EXT.test(p);}

export async function previewManagedCodingContext({worktree,changedFiles,maxFiles=6}={}){
  if(typeof worktree!=='string'||!path.isAbsolute(worktree)||
     !Array.isArray(changedFiles)||changedFiles.length>250||
     !Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>8)
    throw BAD('context_bad_input','Trusted absolute worktree, bounded change list and limit required.');
  const root=path.resolve(worktree);
  const realRoot=await fs.realpath(root);
  if(path.resolve(realRoot)!==root)
    throw BAD('context_unsafe_root','Managed worktree root is an alias or reparse point.');
  const result=[],skipped=[],seen=new Set();
  for(const file of changedFiles){
    const rel=safeRelative(file);
    const key=rel.normalize('NFC').toLowerCase();
    if(seen.has(key))continue;
    seen.add(key);
    if(secretLike(rel)){skipped.push({path:rel,reason:'sensitive_path'});continue;}
    if(result.length>=maxFiles){skipped.push({path:rel,reason:'file_limit'});continue;}
    const absolute=path.resolve(root,...rel.split('/'));
    if(path.relative(root,absolute).startsWith('..')||path.isAbsolute(path.relative(root,absolute)))
      throw BAD('context_bad_path','Changed file escaped worktree.');
    // Disallow symlink/junction ancestors even if their final canonical
    // target stays below root. This is a best-effort preview guard, NOT an
    // OS trust boundary against a concurrent hostile host process.
    let cursor=root;
    for(const segment of rel.split('/').slice(0,-1)){
      cursor=path.join(cursor,segment);
      const parent=await fs.lstat(cursor);
      if(parent.isSymbolicLink()||!parent.isDirectory())
        throw BAD('context_unsafe_path','Changed file traverses an unsafe directory link.');
    }
    let st;
    try{st=await fs.lstat(absolute);}
    catch(error){
      if(error?.code==='ENOENT'){skipped.push({path:rel,reason:'deleted'});continue;}
      throw error;
    }
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)
      throw BAD('context_unsafe_path','Changed file is not a private ordinary file.');
    if(st.size>8192){skipped.push({path:rel,reason:'too_large'});continue;}
    const handle=await fs.open(absolute,'r');
    let bytes,after;
    try{
      const before=await handle.stat();
      if(!before.isFile()||before.size>8192||before.nlink!==1)
        throw BAD('context_unsafe_path','Changed file altered before bounded read.');
      bytes=await handle.readFile();
      after=await handle.stat();
      if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||
         after.ino!==before.ino||bytes.length>8192)
        throw BAD('context_changed','Changed file modified while reading.');
    }finally{await handle.close();}
    if(bytes.includes(0)){skipped.push({path:rel,reason:'binary'});continue;}
    const text=bytes.toString('utf8');
    // A replacement character indicates undecodable bytes; never place
    // ambiguous binary content into a model-shaped context preview.
    if(text.includes('\ufffd')){skipped.push({path:rel,reason:'invalid_utf8'});continue;}
    const lines=text.split(/\r?\n/).slice(0,100).map((line,i)=>({
      line:i+1,text:line.slice(0,300),
    }));
    result.push(Object.freeze({
      path:rel,sha256:createHash('sha256').update(bytes).digest('hex'),
      byteLength:bytes.length,lines:Object.freeze(lines),
      truncated:text.split(/\r?\n/).length>100||lines.some(x=>x.text.length===300),
    }));
  }
  return Object.freeze({
    files:Object.freeze(result),skipped:Object.freeze(skipped),
    fileCount:result.length,manualPreviewOnly:true,
    sentToModel:false,testOutcomeAuthenticated:false,
  });
}
