// Review-only coding worktree proposal: no branches, edits, execution, or
// implicit model request. Optional single model planning step is explicit.
import { RequestBudget, requestBudgetConfig } from './request-budget.mjs';
import { validateCodingTaskGraph } from './coding-task-dag.mjs';

const fail=(code,message)=>Object.assign(new Error(message),{code,statusCode:400});
const clean=s=>String(s??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
const ID=/^[a-z][a-z0-9-]{0,30}$/;

export function validateProposedCodingTasks(tasks) {
  if(!Array.isArray(tasks)||tasks.length<1||tasks.length>4)
    throw fail('invalid_plan','Plan must contain 1–4 tasks.');
  const ids=new Set();
  const validated=tasks.map((task,i)=>{
    const id=clean(task?.id||'task-'+(i+1));
    const prompt=clean(task?.prompt);
    if(!ID.test(id)||ids.has(id)||!prompt||prompt.length>3000)
      throw fail('invalid_plan','Every task requires a unique safe ID and prompt <=3000 characters.');
    if(task.verify!==undefined && typeof task.verify!=='boolean')
      throw fail('invalid_plan','verify must be a boolean.');
    if(!Array.isArray(task.dependsOn??[])||new Set(task.dependsOn??[]).size!==(task.dependsOn??[]).length)
      throw fail('invalid_plan','dependsOn must list distinct task IDs.');
    ids.add(id);
    return {id,prompt,dependsOn:task.dependsOn??[],verify:task.verify===true};
  });
  validateCodingTaskGraph(validated);
  return validated;
}

export function proposeCodingTasks(goal) {
  const text=clean(goal);
  if(text.length<8||text.length>3000)throw fail('invalid_goal','Describe a goal between 8 and 3000 characters.');
  const lines=String(goal).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const bullets=lines.filter(s=>/^(?:[-*]|\d+[.)])\s+/.test(s))
    .map(s=>s.replace(/^(?:[-*]|\d+[.)])\s+/,'').trim())
    .filter(s=>s.length>=12);
  // Never infer independent worktree/file ownership from arbitrary free text.
  // Explicit numbered/bulleted units become sequential dependent tasks;
  // otherwise prefer one worker over unnecessary parallel model calls.
  const items=bullets.length>=2&&bullets.length<=4?bullets:[text];
  const tasks=items.map((item,i)=>({
    id:'task-'+(i+1),prompt:item.slice(0,3000),
    dependsOn:i===0?[]:['task-'+i],verify:false,
  }));
  return {goal:text,tasks:validateProposedCodingTasks(tasks),source:'deterministic',modelRequests:0,
    reviewed:false,executable:false,note:'Editable proposal only. No branches or model calls created.'};
}

function jsonFromText(raw) {
  const fence=String.fromCharCode(96).repeat(3);
  const value=String(raw??'').trim().replace(new RegExp('^'+fence+'(?:json)?\\s*','i'),'')
    .replace(new RegExp('\\s*'+fence+'$'),'');
  let parsed;
  try{parsed=JSON.parse(value);}catch{throw fail('invalid_model_plan','Model did not return valid JSON for preview. Nothing was executed.');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
    throw fail('invalid_model_plan','Model plan must be an object.');
  return parsed.tasks;
}

export async function proposeModelCodingTasks({goal,provider}={}){
  const initial=proposeCodingTasks(goal);
  if(!provider?.ready?.())throw fail('provider_not_ready','Configure a model to request an AI planning preview.');
  const base=requestBudgetConfig();
  const budget=new RequestBudget({config:{
    ...base,limits:{...base.limits,maxRequests:3,maxRetries:1},
  }});
  const response=await provider.respond({
    input:[{role:'user',content:[{type:'input_text',text:initial.goal}]}],
    instructions:'You propose at most 4 coding tasks for a Git worktree coordinator. Return ONLY a strict JSON object {"tasks":[{"id":"task-1","prompt":"...","dependsOn":[],"verify":false}]}. IDs must use lowercase letters, digits and hyphens. Dependencies must form an acyclic graph. Split work only when independent file scopes are evident. Never ask for credentials, weaken tests, or assume sandbox results. This is a PREVIEW only; do not run tools. Reject scope expansion beyond the user goal.',
    tools:[],maxOutputTokens:1200,
    onHttpAttempt:attempt=>budget.reserve(attempt),
  });
  budget.recordUsage(response.usage);
  if(response.status!=='completed'||response.output?.some(item=>item.type==='function_call'))
    throw fail('invalid_model_plan','Planning model returned an incomplete response or a tool call. Nothing was executed.');
  const answer=response.output.filter(x=>x.type==='message')
    .flatMap(x=>x.content??[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n');
  return {goal:initial.goal,tasks:validateProposedCodingTasks(jsonFromText(answer)),
    source:'model-proposal',modelRequests:budget.snapshot().apiRequests,
    usage:budget.snapshot(),reviewed:false,executable:false,
    note:'Review and edit all tasks and dependency edges before authorizing CREATE WORKTREES.'};
}
