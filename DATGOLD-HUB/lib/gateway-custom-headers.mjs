// Per-origin custom HTTP headers for model gateways. All literal values are
// secrets: never put them in public state, diagnostics or public config files.
const invalid=(detail)=>Object.assign(new Error(detail),{code:'invalid_custom_headers',statusCode:400});
const forbidden=new Set([
  'authorization','proxy-authorization','cookie','set-cookie','host','origin','referer',
  'content-type','content-length','transfer-encoding','connection','upgrade','te',
  'x-api-key','x-goog-api-key','anthropic-version','accept-encoding',
]);
export function normalizeCustomHeaders(input) {
  if(input==null)return [];
  if(!Array.isArray(input)||input.length>12)throw invalid('Custom headers must be an array of up to twelve entries.');
  const used=new Set(), out=[];
  for(const raw of input){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw invalid('Invalid custom header entry.');
    const name=String(raw.name??'').trim();
    const lower=name.toLowerCase();
    if(!/^[a-z][a-z0-9-]{0,63}$/i.test(name)||forbidden.has(lower)||
       /^(?:proxy-|sec-|x-forwarded-|x-original-|x-real-)/i.test(name))
      throw invalid('Disallowed custom HTTP header name.');
    if(used.has(lower))throw invalid('Custom header names must be unique (case-insensitive).');
    used.add(lower);
    const useEnv=raw.envKeyName!==undefined && raw.envKeyName!==null;
    const useValue=raw.value!==undefined && raw.value!==null;
    if(useEnv===useValue)throw invalid('Use exactly one of envKeyName and value per header.');
    if(useEnv){
      if(typeof raw.envKeyName!=='string'||!/^[A-Z_][A-Z0-9_]{0,95}$/.test(raw.envKeyName))
        throw invalid('Environment header reference must be an uppercase environment variable name.');
      out.push({name,envKeyName:raw.envKeyName});
    }else{
      if(typeof raw.value!=='string'||!raw.value||raw.value.length>2048||/[\x00-\x1f\x7f]/.test(raw.value))
        throw invalid('Custom header value must be nonempty, safe text (max 2048 characters).');
      out.push({name,value:raw.value});
    }
  }
  return out;
}
export function publicCustomHeaders(specs=[]) {
  return specs.map(({name,envKeyName})=>({name,source:envKeyName?'environment':'protected',
    ...(envKeyName?{envKeyName}:{})}));
}
export function applyCustomHeaders(base,specs=[],env={},registerSecret=()=>{}) {
  const result={...base};
  for(const h of specs){
    const value=h.envKeyName?env[h.envKeyName]:h.value;
    if(typeof value!=='string'||!value||value.length>2048||/[\x00-\x1f\x7f]/.test(value))
      throw Object.assign(new Error('Custom header environment value is missing or invalid.'),{
        code:'invalid_header_environment',statusCode:409});
    result[h.name]=value;
    registerSecret(value);
  }
  return result;
}
