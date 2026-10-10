window.__requests=[];window.__verificationRuns=[];
window.confirm=()=>true;
window.prompt=()=> 'Checkpoint test';
const taskId='123e4567-e89b-42d3-a456-426614174000';
const task={id:taskId,prompt:'Rà soát mã nguồn demo',status:'completed',steps:3,toolCalls:2,updatedAt:new Date().toISOString(),startedAt:new Date().toISOString(),workspace:{path:'C:\\Projects\\sensor-fusion'},prompts:[{text:'Rà soát mã nguồn demo',at:new Date().toISOString()}],runs:[{status:'completed',finalText:'Đã đọc README.md và kiểm tra main.py.'}],finalText:'Đã đọc README.md và kiểm tra main.py.',events:[{type:'tool',toolName:'studio.read',message:'Đã đọc README.md',at:new Date().toISOString()}],transport:'chatgpt-web',autoResume:false};
window.__apiState={version:'2.3.0',csrfToken:'x'.repeat(64),workspace:{path:'C:\\Projects\\sensor-fusion'},services:Object.fromEntries(['docker','cloud','proxy','desktop'].map(x=>[x,{state:'ready',detail:'ready'}])),agent:{mode:'chatgpt-web',active:null,activeTaskId:null,tasks:[task]},ai:{configured:true,protocol:'gemini',model:'gemini-demo',apiBaseUrl:'https://example.invalid'},browser:{paired:true,connected:true},studio:{workspace:'C:\\Projects\\sensor-fusion',permissions:{mode:'review',pending:[]},terminals:[]},logs:['Mock Hub ready']};
const base={
 '/api/health':()=>({app:'chatmcp-local-hub',version:'2.3.0',uiBuild:'2.3.0-react-agent',initialized:true}),
 '/api/state':()=>window.__apiState,
 '/api/studio/tree':()=>({workspace:'C:\\Projects\\sensor-fusion',directory:'',entries:[{name:'README.md',kind:'file',path:'README.md'},{name:'main.py',kind:'file',path:'main.py'}]}),
 '/api/studio/intelligence/status':()=>({indexedAt:null,fileCount:0,symbolCount:0,parser:'not-indexed',capabilities:{index:true},lsp:[]}),
 '/api/studio/intelligence/symbols':()=>({matches:[{name:'calculate',kind:'function',path:'main.py',line:4,precision:'ast'}]}),
 '/api/studio/intelligence/references':()=>({matches:[{name:'calculate',path:'main.py',line:7}]}),
 '/api/studio/sandbox':()=>({ready:false,detail:'Docker not installed',scope:'Docker sandbox'}),
 '/api/studio/terminal/capabilities':()=>({platform:'win32',interactivePipes:true,nativeConPTY:false,ansiTerminalEmulator:false}),
 '/api/studio/preview':()=>({url:'http://127.0.0.1:5173/',ready:false,detail:'Connection refused'}),
 '/api/studio/file':()=>({path:'README.md',size:30,sha256:'a'.repeat(64),content:'# Example task\nRead this project.\n'}),
 '/api/studio/git/status':()=>({head:'a'.repeat(40),entries:[' M main.py']}),
 '/api/studio/checkpoints':()=>[],
 '/api/studio/plan':()=>({taskId,workspace:'C:\\Projects\\sensor-fusion',title:'Check plan',items:[]}),
 '/api/studio/terminal':()=>[],
 '/api/studio/checks':()=>({suggested:[{from:'pyproject.toml',command:'python -m pytest -q'}]}),
 '/api/studio/verifications':()=>({runs:window.__verificationRuns,total:window.__verificationRuns.length}),
 '/api/studio/skills':()=>({skills:[]}),
 ['/api/tasks/'+taskId]:()=>task,
};
window.fetch=async(input,options={})=>{
 const url=typeof input==='string'?input:input.url;
 const path=url.split('?')[0]; const method=options.method||'GET';
 window.__requests.push({path,method,headers:options.headers,body:options.body});
 await new Promise(resolve=>setTimeout(resolve,12));
 let payload,status=200;
 if(method==='GET'&&base[path])payload=base[path]();
 else if(path==='/api/agent/mode'&&method==='POST'){
   const {mode}=JSON.parse(options.body);window.__apiState.agent.mode=mode;payload=window.__apiState;
 }
 else if(path==='/api/tasks/delete'&&method==='POST'){
   const {id}=JSON.parse(options.body);window.__apiState.agent.tasks=window.__apiState.agent.tasks.filter(x=>x.id!==id);payload={ok:true,removed:id};
 }
 else if(path==='/api/services/start'&&method==='POST'){
   for(const service of Object.values(window.__apiState.services))service.state='ready';
   payload=window.__apiState;
 }
 else if(path==='/api/tasks/start'&&method==='POST'){
   const {prompt}=JSON.parse(options.body);
   const next={...task,id:'b2345678-e89b-42d3-a456-426614174999',prompt,status:'running',steps:0,toolCalls:0,
     prompts:[{text:prompt,at:new Date().toISOString()}],transport:window.__apiState.agent.mode};
   window.__apiState.agent.tasks.unshift(next);window.__apiState.agent.activeTaskId=next.id;window.__apiState.agent.active=next;
   base['/api/tasks/'+next.id]=()=>next;
   payload={task:next};
 }
 else if(path==='/api/ai/test'&&method==='POST'){
   window.__apiState.ai.authMode='bearer';
   payload={ok:true,responsePresent:true,model:'gemini-demo',protocol:'gemini',authMode:'bearer',autoSelected:true,
       attempts:[{protocol:'gemini',authMode:'google-key',status:400},{protocol:'gemini',authMode:'bearer',status:200}]};
 }
 else if(path==='/api/tasks/auto-resume'&&method==='POST'){
  const {enabled}=JSON.parse(options.body);task.autoResume=enabled;payload={task};
 }
 else if(path==='/api/studio/permissions/config'&&method==='POST'){
  const {mode,executionPolicy}=JSON.parse(options.body);if(mode)window.__apiState.studio.permissions.mode=mode;if(executionPolicy)window.__apiState.studio.permissions.executionPolicy=executionPolicy;payload=window.__apiState.studio.permissions;
 }
 else if(path==='/api/studio/verify/run'&&method==='POST'){
   const command=JSON.parse(options.body).command;const run={id:'test-run-1',terminalId:'test-terminal-1',command,status:'completed',exitCode:0,startedAt:new Date().toISOString(),outputPreview:'2 passed'};window.__verificationRuns.unshift(run);payload=run;
 }
 else if(path==='/api/studio/intelligence/index'&&method==='POST')payload={fileCount:2,symbolCount:4,indexedAt:new Date().toISOString()};
 else if(path==='/api/studio/intelligence/lsp/start'&&method==='POST')payload={ready:true};
 else if(path==='/api/studio/search')payload={matches:[],scannedFiles:2};
 else if(path==='/api/studio/git/diff')payload={diff:'diff --git a/main.py b/main.py\n+ hello',staged:false};
 else if(path==='/api/studio/git/check')payload={ok:true,code:0};
 else if(path==='/api/studio/file/save'&&method==='POST')payload={ok:true,path:'README.md'};
 else {status=404;payload={error:'Không tìm thấy thao tác '+path,code:'unknown_action',path};}
 return new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});
};
