// Draft-only role routing validation. Valid roles and IDs match the Hub's
// ConcurrentApiAgent contract. The browser never accesses profile API keys.
export type ModelProfileChoice = { id: string; name?: string; model?: string };

export function parseRoleProfileOverrides(raw: string, available: ModelProfileChoice[]): Record<string,string> {
  if(!raw.trim())return {};
  let value: unknown;
  try { value=JSON.parse(raw); }
  catch { throw new Error('Role profile overrides phải là JSON object hợp lệ.'); }
  if(!value || typeof value!=='object' || Array.isArray(value))
    throw new Error('Role profile overrides phải là JSON object dạng {"reviewer":"profile-id"}.');
  const entries=Object.entries(value);
  if(entries.length>12)throw new Error('Chỉ hỗ trợ tối đa 12 role profile overrides.');
  const allowed=new Set(available.map(p=>p.id));
  for(const [role,id] of entries){
    if(!/^[a-z][a-z0-9_-]{0,40}$/i.test(role) || typeof id!=='string' ||
       !/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(id))
      throw new Error('Tên role hoặc ID model profile không hợp lệ.');
    if(!allowed.has(id))throw new Error('Model profile cho vai trò '+role+' không còn tồn tại.');
  }
  return Object.fromEntries(entries) as Record<string,string>;
}
