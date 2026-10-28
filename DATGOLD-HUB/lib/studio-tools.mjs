// Built-in coding tools. They are returned through the same vetted MCP router
// as external tools, and cannot execute shell commands behind an approval gate.
const obj=(props,required=Object.keys(props))=>({type:'object',properties:props,required,additionalProperties:false});
const str={type:'string'};const num={type:'integer'};
const entry=(name,description,inputSchema,annotations={readOnlyHint:true})=>({name:`studio.${name}`,originalName:name,server:'studio',description,inputSchema,annotations});
export const STUDIO_TOOLS=[
  entry('tree','List files in selected workspace. No .git internals, no symlink traversal.',obj({directory:str,limit:num})),
  entry('read','Read a small UTF-8 source file, constrained to workspace.',obj({file:str,maxBytes:num})),
  entry('search','Search text, symbols or filenames in bounded local code index.',obj({query:str,mode:{type:'string',enum:['text','symbol','filename']},limit:num})),
  entry('status','Get git status and HEAD for selected workspace.',obj({})),
  entry('diff','Get git diff for selected workspace or a relative file.',obj({file:str,staged:{type:'boolean'}})),
  entry('diff_check','Run safe read-only git diff --check.',obj({})),
  entry('checks','Discover likely repository test commands without running them.',obj({})),
  entry('symbols','Search indexed classes, functions and interfaces (AST where supported; indexed locally).',obj({query:str,limit:num})),
  entry('references','Find Python AST name references; may lack type resolution.',obj({symbol:str})),
  entry('definitions','Find source definitions by exact symbol name.',obj({symbol:str})),
  entry('index_status','Return local code index status and available language servers.',obj({})),
  entry('skills','Read instruction file candidates as untrusted project data.',obj({})),
  entry('checkpoints','List saved pre-change snapshots.',obj({})),
  entry('checkpoint','Create bounded local pre-change snapshot for Git review/restore.',obj({label:str}),{readOnlyHint:false}),
  entry('review','Compare current files against checkpoint without modifying files.',obj({checkpointId:str,file:str})),
  entry('plan_get','Load durable plan for current conversation.',obj({})),
  entry('plan_set','Persist a structured plan. Status: todo, doing, done, blocked.',obj({title:str,items:{type:'array',items:{type:'object',properties:{text:str,status:{type:'string',enum:['todo','doing','done','blocked']},evidence:str},required:['text','status','evidence'],additionalProperties:false}}}),{readOnlyHint:false}),
];
export class StudioTools {
  constructor({workspace,gate,intelligence}){this.workspace=workspace;this.gate=gate;this.intelligence=intelligence;}
  definitions(){return STUDIO_TOOLS.map(x=>structuredClone(x));}
  async call(name,args,{taskId,signal}={}){
    signal?.throwIfAborted();
    const op=name.replace(/^studio\./,'');
    const handle={
      tree:()=>this.workspace.tree(args),read:()=>this.workspace.read(args),search:()=>this.workspace.search(args),
      status:()=>this.workspace.gitStatus(),diff:()=>this.workspace.gitDiff(args),diff_check:()=>this.workspace.gitDiffCheck(),
      checks:()=>this.workspace.checks(),skills:()=>this.workspace.skills(),checkpoints:()=>this.workspace.checkpoints(),
      symbols:()=>this.intelligence?.symbols(args),references:()=>this.intelligence?.references(args),
      definitions:()=>this.intelligence?.definitions(args),index_status:()=>this.intelligence?.status(),
      checkpoint:()=>this.workspace.checkpoint(args),review:()=>this.workspace.review(args),
      plan_get:()=>this.workspace.plan({taskId,operation:'get'}),
      plan_set:()=>this.workspace.plan({taskId,operation:'set',title:args.title,items:args.items}),
    }[op];
    if(!handle)return {isError:true,content:[{type:'text',text:'Unknown Studio tool'}]};
    try {const result=await handle();return {isError:false,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
    catch(error){return {isError:true,content:[{type:'text',text:`${error.code||'studio_error'}: ${error.message}`} ]};}
  }
}
