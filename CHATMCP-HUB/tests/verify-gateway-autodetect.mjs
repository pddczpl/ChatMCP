import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GatewayProvider, gatewayErrorDetail } from '../lib/gateway-provider.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-gateway-auto-'));
const key='test-private-secret-DO-NOT-SHARE';
const manager={secrets:[]};
const protect=async x=>'ENC:'+Buffer.from(x).toString('base64');
const unprotect=async x=>Buffer.from(x.slice(4),'base64').toString();
const fixture=(status,body)=>({ok:status>=200&&status<300,status,async text(){return JSON.stringify(body);}});
const successGemini={candidates:[{content:{parts:[{text:'OK'}]},finishReason:'STOP'}]};
const successOpenai={choices:[{message:{content:'OK'},finish_reason:'stop'}]};
let checks=0;
try{
  assert.equal(gatewayErrorDetail({error:{message:'  invalid model  '}}),'invalid model'); checks++;
  assert.equal(gatewayErrorDetail({error:'wrong route'}),'wrong route'); checks++;
  const allCalls=[];
  const probe=new GatewayProvider({directory:dir,bundleRoot:dir,manager,protect,unprotect,env:{},fetchImpl:async(url,opts)=>{
    const payload=JSON.parse(opts.body);allCalls.push({url,headers:opts.headers,payload});
    // The gateway expects Bearer, not the default x-goog-api-key for Gemini.
    if(opts.headers.Authorization===`Bearer ${key}` && url.includes(':generateContent'))return fixture(200,successGemini);
    return fixture(400,{error:{message:`Expected Bearer instead of ${key}`}});
  }});
  await probe.load();
  await probe.configure({apiBaseUrl:'https://example.invalid/',protocol:'gemini',model:'gemini-3.8-flash',apiKey:key,remember:true});
  const detected=await probe.diagnoseConnection();
  assert.equal(detected.ok,true);checks++;
  assert.equal(detected.protocol,'gemini');checks++;
  assert.equal(detected.authMode,'bearer');checks++;
  assert.equal(detected.autoSelected,true);checks++;
  assert.equal(allCalls.length,2,'probe stops immediately on first success');checks++;
  assert.equal(allCalls[0].headers['x-goog-api-key'],key);checks++;
  assert.equal(allCalls[1].headers.Authorization,`Bearer ${key}`);checks++;
  assert.ok(allCalls.every(x=>!JSON.stringify(x.payload).includes('tools') && !JSON.stringify(x.payload).includes('workspace')));checks++;
  assert.ok(!JSON.stringify(detected).includes(key),'diagnostics redact credentials');checks++;
  assert.equal(probe.state().authMode,'bearer');checks++;
  assert.equal(probe.state().keySource,'saved','DPAPI key survives auto-detection');checks++;
  const stored=await fs.readFile(path.join(dir,'gateway-config.json'),'utf8');
  assert.ok(!stored.includes(key));checks++;

  const openaiCalls=[];
  const alt=new GatewayProvider({directory:path.join(dir,'alternate'),bundleRoot:dir,manager,env:{},fetchImpl:async(url,opt)=>{
    openaiCalls.push({url,auth:opt.headers.Authorization,tools:Boolean(JSON.parse(opt.body).tools)});
    if(url.endsWith('/v1/chat/completions') && opt.headers.Authorization===`Bearer ${key}`) return fixture(200,successOpenai);
    return fixture(400,{error:{message:'Bad request: native Gemini route unsupported'}});
  }});
  await alt.load();await alt.configure({apiBaseUrl:'https://example.invalid/v1beta',protocol:'gemini',model:'gemini-3.8-flash',apiKey:key});
  const variant=await alt.diagnoseConnection();
  assert.equal(variant.protocol,'openai-chat');checks++;
  assert.equal(alt.state().protocol,'openai-chat');checks++;
  assert.equal(alt.state().apiBaseUrl,'https://example.invalid');checks++;
  assert.equal(openaiCalls.filter(x=>!x.tools).length,3,'Gemini Google, Gemini Bearer, OpenAI Bearer');checks++;
  assert.equal(openaiCalls.filter(x=>x.tools).length,1,'one extra tool-calling probe once the protocol is found');checks++;
  assert.equal(variant.toolCalling,'unreliable','a model that answers in text instead of calling the probe function is flagged');checks++;
  assert.ok(openaiCalls.every(x=>new URL(x.url).origin==='https://example.invalid'));checks++;

  const failProvider=new GatewayProvider({directory:path.join(dir,'fail'),bundleRoot:dir,manager,env:{},fetchImpl:async()=>fixture(400,{error:{message:`The model path is invalid; token=${key}`}})});
  await failProvider.load();await failProvider.configure({apiBaseUrl:'https://example.invalid',protocol:'gemini',model:'gemini-3.8-flash',apiKey:key});
  await assert.rejects(failProvider.respond({input:[{role:'user',content:[{text:'Ping'}]}],instructions:'Ping'}),e=>{
    assert.match(e.message,/model path is invalid/);assert.ok(!e.message.includes(key));return true;
  });checks++;
  await assert.rejects(failProvider.diagnoseConnection(),e=>{
    assert.equal(e.code,'gateway_probe_failed');assert.ok(!e.message.includes(key));return true;
  });checks++;
  assert.equal(failProvider.state().protocol,'gemini','failed probes do not silently change config');checks++;
  // A 9Router-style gateway can be configured with a custom Gemini dialect
  // and then corrected to OpenAI Chat Completions on the SAME HTTPS origin.
  // The user's existing DPAPI key must stay saved without touching another host.
  const strictCalls=[];
  const sameGateway=new GatewayProvider({
    directory:path.join(dir,'same-gateway'),bundleRoot:dir,manager,protect,unprotect,env:{},
    fetchImpl:async(url,opts)=>{
      strictCalls.push({url,auth:opts.headers.Authorization,body:JSON.parse(opts.body)});
      if(url==='https://router.example/v1/chat/completions' && opts.headers.Authorization===`Bearer ${key}`)
        return fixture(200,successOpenai);
      return fixture(200,successGemini);
    },
  });
  await sameGateway.load();
  await sameGateway.configure({
    preset:'custom-gemini',protocol:'gemini',apiBaseUrl:'https://router.example',
    model:'cx/gpt-6-astra',authMode:'bearer',apiKey:key,remember:true,
  });
  const upgraded=await sameGateway.configure({
    preset:'custom-openai',protocol:'openai-chat',
    apiBaseUrl:'https://router.example/v1',model:'cx/gpt-6-astra',
    authMode:'bearer',remember:true,
  });
  assert.equal(upgraded.preset,'custom-openai');checks++;
  assert.equal(upgraded.protocol,'openai-chat');checks++;
  assert.equal(upgraded.keySource,'saved');checks++;
  assert.equal(upgraded.configured,true);checks++;
  const strictChecked=await sameGateway.diagnoseConnection({strictProtocol:true});
  assert.equal(strictChecked.protocol,'openai-chat');checks++;
  assert.ok(strictCalls.every(x=>x.url.endsWith('/v1/chat/completions')));checks++;
  assert.ok(strictCalls.every(x=>x.auth===`Bearer ${key}`));checks++;
  assert.equal(sameGateway.state().protocol,'openai-chat');checks++;
  await assert.rejects(
    sameGateway.configure({preset:'custom-openai',apiBaseUrl:'https://other.example/v1',remember:true}),
    {code:'missing_key'},
  );checks++;
  assert.equal(sameGateway.state().apiBaseUrl,'https://router.example/v1');checks++;
  await assert.rejects(
    sameGateway.configure({preset:'openai',apiBaseUrl:'https://router.example/v1',remember:true}),
    {code:'missing_key'},
  );checks++;

  // Even if Gemini could answer at this same domain, testing an explicit
  // OpenAI selection must not silently switch the saved config to Gemini.
  const strictRejectCalls=[];
  const rejectingDialect=new GatewayProvider({
    directory:path.join(dir,'strict-reject'),bundleRoot:dir,manager,protect,unprotect,env:{},
    fetchImpl:async(url,opts)=>{
      strictRejectCalls.push(url);
      return url.includes(':generateContent')?fixture(200,successGemini)
        :fixture(404,{error:{message:'OpenAI route missing'}});
    },
  });
  await rejectingDialect.load();
  await rejectingDialect.configure({
    preset:'custom-openai',apiBaseUrl:'https://router.example/v1',
    model:'cx/gpt-6-astra',authMode:'bearer',apiKey:key,remember:true,
  });
  await assert.rejects(rejectingDialect.diagnoseConnection({strictProtocol:true}),{code:'gateway_probe_failed'});checks++;
  assert.equal(rejectingDialect.state().protocol,'openai-chat');checks++;
  assert.ok(strictRejectCalls.every(url=>url.endsWith('/v1/chat/completions')));checks++;
  console.log(`PASS ${checks} gateway API diagnostics/auto-probe assertions, same-origin, secret redaction, DPAPI preservation`);
}finally{await fs.rm(dir,{recursive:true,force:true});}
