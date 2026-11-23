import path from 'node:path';
import { readJson, writeJson } from './runtime.mjs';
import { FRESHNESS, receiptFreshness, treeKey } from './agent-progress.mjs';
const idOk = id => typeof id==='string' && /^[0-9a-f-]{36}$/i.test(id);
const PASSES = 24;
/**
 * Whether the timeline's checks verify the files as they are now (pod-18, docs/PROOF-RECEIPTS.md): `verified` is a passing check FRESH on the latest tree the timeline
 * knows, computed every time, never a flag kept from an earlier check. `freshness`: none (no passing check yet), fresh, stale (every pass is of a tree that is gone)
 * or unknown (the current tree, or the tree of a pass, is not known: unknown is never fresh). A timeline saved before passes had trees is unknown.
 */
export function workflowVerification(data) {
  const passes = Array.isArray(data?.passes) ? data.passes : [];
  if (!(data?.checksObserved > 0)) return { verified: false, freshness: 'none' };
  const seen = new Set(passes.map((tree) => receiptFreshness({ tree }, data.tree ?? null)));
  if (seen.has(FRESHNESS.fresh)) return { verified: true, freshness: FRESHNESS.fresh };
  return { verified: false, freshness: seen.has(FRESHNESS.stale) && !seen.has(FRESHNESS.unknown) ? FRESHNESS.stale : FRESHNESS.unknown };
}
/** A durable, observable *activity* timeline, not the model's hidden reasoning. */
export class StudioWorkflow {
  constructor({directory}) {this.directory=directory;this.cache=new Map();this.writes=new Map();}
  async load(id){
    if(!idOk(id))throw new Error('Bad task ID');
    if(this.cache.has(id))return this.cache.get(id);
    const data=await readJson(path.join(this.directory,`${id}.json`))??{taskId:id,steps:[],phase:'discovery',editsObserved:0,checksObserved:0,tree:null,passes:[]};
    // The flag an older version kept: never read, `verified` is computed (workflowVerification).
    delete data.verified;
    this.cache.set(id,data);return data;
  }
  /**
   * The tree after a call (`proof`: what the proof service gave the guard about it): the tree after it is the latest tree; a call that may change files
   * (`mayChangeFiles`, a category the service scans) and came back without trees leaves it unknown. Returns the tree before the call.
   */
  #observeTree(data,{proof=null,mayChangeFiles=false}={}){
    const before=typeof data.tree==='string'?data.tree:null;
    if(proof)data.tree=treeKey(proof.treeAfter);
    else if(mayChangeFiles===true)data.tree=null;
    return before;
  }
  async mark(taskId,type,{toolName='',category='',isError=false,checkpoint=null,verified=false,fileEdit,commandKind='',proof=null,mayChangeFiles=false}={}){
    const data=await this.load(taskId);const t=new Date().toISOString();
    const safeTool=String(toolName).slice(0,200);
    const phase=type==='tool_start'?(category==='workspace_edit'||category==='dangerous'?'editing':category==='execute'?'running':'discovery'):
      type==='checkpoint'?'checkpoint':type==='tool_result'?(verified?'verification':data.phase):data.phase;
    data.phase=phase;
    if(type==='tool_result'){
      const current=this.#observeTree(data,{proof,mayChangeFiles});
      if(!isError){
        // An edit is a call that changed files. The caller says so with `fileEdit`: a test run passes the same gate as an edit
        // (it may write caches or build output) but is not one. Without that information the category decides, as before.
        if(fileEdit??(category==='workspace_edit'))data.editsObserved++;
        // A shell command that is not a plain read or a known check may have changed anything: counted apart, never as an edit.
        if(['edit','exec','dangerous'].includes(commandKind))data.commandsObserved=(data.commandsObserved||0)+1;
        if(verified){
          data.checksObserved++;
          // The tree the pass is of: its own trees, when they are one tree and no other call ran beside it; for a check that is not scanned, the latest tree.
          // A check whose trees differ changed the files it checked (the strict pass rule, docs/PROOF-CHECKS.md): counted, never a pass of a tree.
          const before=treeKey(proof?.treeBefore),after=treeKey(proof?.treeAfter);
          const changed=before!==null&&after!==null&&before!==after;
          if(!changed){
            const tree=proof?(proof.overlapped!==true&&before!==null?after:null):(mayChangeFiles===true?null:current);
            data.passes=[...(Array.isArray(data.passes)?data.passes:[]),tree].slice(-PASSES);
          }
        }
      }
    }
    const item={at:t,type,toolName:safeTool,category,isError,checkpoint,verified};data.steps.push(item);
    if(data.steps.length>250)data.steps.splice(0,data.steps.length-250);
    await this.#save(taskId,data);return {...data,...workflowVerification(data)};
  }
  /** A call that threw: no result to mark, but what its trees say of the files still holds (manager.#guardCalls). */
  async noteTree(taskId,observed={}){
    const data=await this.load(taskId);
    this.#observeTree(data,observed);
    await this.#save(taskId,data);
  }
  async #save(taskId,data){
    const previous=this.writes.get(taskId)||Promise.resolve();
    const next=previous.catch(()=>{}).then(()=>writeJson(path.join(this.directory,`${taskId}.json`),data));
    this.writes.set(taskId,next);await next;
  }
  async state(taskId){if(!taskId)return null;const data=await this.load(taskId);return {...data,...workflowVerification(data),steps:data.steps.slice(-70)};}
}
