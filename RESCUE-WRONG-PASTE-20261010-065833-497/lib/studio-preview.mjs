/** Safe local-only preview discovery. Browser renders content in a sandboxed iframe
 * with an opaque origin. The app server must be started separately by the user.
 */
import net from 'node:net';
const fault=(message,code=400)=>Object.assign(new Error(message),{statusCode:code});
export function validatePreview({port,pathname='/'}={}){
  port=Number(port);if(!Number.isInteger(port)||port<1024||port>65535)throw fault('Preview port phải từ 1024 đến 65535.');
  if(typeof pathname!=='string'||!pathname.startsWith('/')||pathname.length>500||/[\r\n\0\\]/.test(pathname)||pathname.startsWith('//'))throw fault('Preview path không hợp lệ.');
  return {port,url:`http://127.0.0.1:${port}${pathname}`,sandbox:'allow-scripts allow-forms'};
}
export async function previewStatus(options){const info=validatePreview(options);return await new Promise(resolve=>{
  const socket=net.connect({host:'127.0.0.1',port:info.port});let finished=false;
  const end=(ready,detail)=>{if(finished)return;finished=true;socket.destroy();resolve({...info,ready,detail});};
  socket.setTimeout(1500);socket.once('connect',()=>end(true,'Local service đang lắng nghe'));
  socket.once('error',e=>end(false,e.code||e.message));socket.once('timeout',()=>end(false,'timeout'));
});}
