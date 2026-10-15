// Provider-native image wiring: Ctrl+V screenshots must become real vision inputs.
import assert from 'node:assert/strict';
import { asChatMessages, openAiUserContent } from '../lib/openai-chat-api.mjs';
import { asAnthropicMessages, anthropicUserBlocks } from '../lib/anthropic-api.mjs';
import { geminiTextEnvelope } from '../lib/gemini-compat.mjs';

const png='data:image/png;base64,AA==';
const history=[{role:'user',content:[
  {type:'input_text',text:'Describe this screenshot precisely.'},
  {type:'input_image',image_url:png,detail:'auto'},
]}];
const chat=asChatMessages(history,'Be truthful');
assert.equal(chat[1].role,'user');
assert.ok(Array.isArray(chat[1].content));
assert.deepEqual(chat[1].content[1],{type:'image_url',image_url:{url:png,detail:'auto'}});
assert.deepEqual(openAiUserContent([{type:'input_text',text:'hello'}]),'hello');
const anthropic=asAnthropicMessages(history);
assert.equal(anthropic[0].role,'user');
assert.deepEqual(anthropic[0].content[1],{
  type:'image',source:{type:'base64',media_type:'image/png',data:'AA=='},
});
assert.equal(anthropicUserBlocks([{type:'input_text',text:'x'}])[0].text,'x');
assert.throws(()=>asAnthropicMessages([{role:'user',content:[{type:'input_image',image_url:'data:image/gif;base64,AA=='}]}]),/GIF/);
assert.throws(()=>asChatMessages([{role:'user',content:[{type:'input_image',image_url:'https://evil.invalid/image'}]}],'instructions'),/validated data URI/);
assert.throws(()=>geminiTextEnvelope(history,'Be truthful',[]),/không hỗ trợ phân tích ảnh/);
console.log('PASS OpenAI/Anthropic provider image forwarding and explicit Gemini vision refusal');
