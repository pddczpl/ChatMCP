// WebView2's trusted native modal is the preferred folder picker for the
// packaged ChatMCP Windows desktop. Ordinary Edge/Chrome tabs use the legacy
// localhost Hub fallback. Never send arbitrary executable commands to C#.
type NativeFolderReply={type:string;id:string;path?:string|null;error?:string|null};
type NativeWebview={
  postMessage:(data:unknown)=>void;
  addEventListener:(name:'message',callback:(event:{data:NativeFolderReply})=>void)=>void;
  removeEventListener:(name:'message',callback:(event:{data:NativeFolderReply})=>void)=>void;
};
const desktop=():NativeWebview|null=>{
  if(typeof window==='undefined')return null;
  const host=window as Window & {chrome?:{webview?:NativeWebview}};
  return host.chrome?.webview??null;
};
export function hasDesktopPicker():boolean{return !!desktop();}
export async function browseNativeWorkspace(initialPath?:string|null):Promise<{path?:string|null}|null>{
  const webview=desktop();
  if(!webview)return null;
  const id=crypto.randomUUID();
  return await new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error:Error|null,result?:{path?:string|null})=>{
      if(settled)return;settled=true;
      clearTimeout(timeout);
      webview.removeEventListener('message',onMessage);
      if(error)reject(error);else resolve(result??{path:null});
    };
    const onMessage=(event:{data:NativeFolderReply})=>{
      const message=event.data;
      if(!message||message.type!=='chatmcp.folder-result'||message.id!==id)return;
      if(message.error)return finish(new Error(message.error));
      finish(null,{path:typeof message.path==='string'?message.path:null});
    };
    const timeout=setTimeout(()=>finish(new Error('Hộp chọn thư mục Windows không phản hồi trong 3 phút. Hãy mở Cài đặt và nhập đường dẫn thủ công.')),180_000);
    webview.addEventListener('message',onMessage);
    try{webview.postMessage({type:'chatmcp.pick-folder',id,initialPath:initialPath||null});}
    catch(error){finish(error instanceof Error?error:new Error('Không mở được hộp thoại Windows.'));}
  });
}
