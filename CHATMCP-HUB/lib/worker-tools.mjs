// Attach only two narrowly brokered check tools to a managed coding worker.
// The raw host command and arbitrary shell catalog remain revoked.
const noSideEffect = { readOnlyHint: true };
export function attachWorkerTestTools({ localTools, permissionGate, broker, workerId }) {
  if (!localTools?.tools || !permissionGate || !broker || !workerId) throw new TypeError('Managed worker test tool context is required.');
  const schema = properties => ({ type:'object', additionalProperties:false, properties, required: Object.keys(properties) });
  const str = description => ({ type:'string',description,minLength:1,maxLength:128 });
  localTools.tools.set('checks_list', {
    name:'checks_list',description:'List only registered test IDs for your managed worktree (no execution).',
    schema:{type:'object',properties:{},additionalProperties:false},
    annotations:noSideEffect,category:'read',reason:'Discover immutable isolated test descriptors',
    summary:()=>'List discovered test checks',
    run:async()=>{
      const checks=await broker.discoverChecks({workerId});
      return {isError:false,content:[{type:'text',text:JSON.stringify(checks).slice(0,18000)}],structuredContent:{checks}};
    },
  });
  localTools.tools.set('checks_run', {
    name:'checks_run',description:'Run an exact check ID only with a previously approved immutable grant inside verified Windows Sandbox. No host fallback.',
    schema:schema({ checkId:str('Discovered immutable check ID.'), grantId:str('Owner-approved check grant UUID.') }),
    annotations:{readOnlyHint:false,openWorldHint:false},category:'execute',reason:'Execute a brokered check in isolated guest only',
    summary:a=>'Isolated check ID '+String(a.checkId||'').slice(0,32),
    run:async(a,ctx)=>{
      const evidence=await broker.requestCheck({workerId,checkId:a.checkId,grantId:a.grantId,signal:ctx.signal});
      return {isError:evidence.status!=='completed',content:[{type:'text',text:JSON.stringify(evidence).slice(0,10000)}],structuredContent:{evidence}};
    },
  });
  // This is the ONLY execution permission exception for a child: the trusted
  // human-granted check ID is prevalidated, then the broker validates it again
  // immediately before dispatch, including parent revocation and test hashes.
  const originalAuthorize=permissionGate.authorize.bind(permissionGate);
  permissionGate.authorize=async function checkGate(args={}) {
    if (args.name!=='local.checks_run') return originalAuthorize(args);
    const g=broker.grants.get(args.args?.grantId);
    const d=(broker.descriptors.get(workerId)||[]).find(x=>x.id===args.args?.checkId);
    const valid=Boolean(g && d && !g.revoked && g.workerId===workerId &&
      g.checkId===d.id && g.checkHash===d.checkHash &&
      g.expiresAt>broker.clock() && g.attempts<g.maxAttempts);
    return valid
      ? {allowed:true,category:'execute',local:true,reason:'Preapproved immutable isolated check grant'}
      : {allowed:false,category:'blocked',local:true,reason:'No current owner-approved check grant'};
  };
}
