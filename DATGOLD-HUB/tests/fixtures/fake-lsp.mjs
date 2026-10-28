// Minimal stdio Language Server Protocol fixture: never touches a network or project.
let buf=Buffer.alloc(0);
function send(data){const payload=Buffer.from(JSON.stringify(data));process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);process.stdout.write(payload);}
process.stdin.on('data',chunk=>{
  buf=Buffer.concat([buf,chunk]);
  while(buf.length){const idx=buf.indexOf('\r\n\r\n');if(idx<0)return;
    const match=/Content-Length:\s*(\d+)/i.exec(buf.subarray(0,idx).toString());if(!match){buf=buf.subarray(idx+4);continue;}
    const size=Number(match[1]);if(buf.length<idx+4+size)return;
    const obj=JSON.parse(buf.subarray(idx+4,idx+4+size).toString());buf=buf.subarray(idx+4+size);
    if(obj.method==='initialize')send({jsonrpc:'2.0',id:obj.id,result:{capabilities:{definitionProvider:true,referencesProvider:true,hoverProvider:true}}});
    if(obj.method==='textDocument/didOpen')send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:obj.params.textDocument.uri,diagnostics:[{message:'fixture diagnostic',severity:3}]}});
    if(obj.method==='textDocument/definition')send({jsonrpc:'2.0',id:obj.id,result:[{uri:obj.params.textDocument.uri,range:{start:{line:0,character:0},end:{line:0,character:3}}}]});
    if(obj.method==='textDocument/references')send({jsonrpc:'2.0',id:obj.id,result:[]});
    if(obj.method==='textDocument/hover')send({jsonrpc:'2.0',id:obj.id,result:{contents:'fake hover'}});
  }
});
