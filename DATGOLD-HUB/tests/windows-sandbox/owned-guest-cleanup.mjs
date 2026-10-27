// Test-only Windows Sandbox cleanup. Never stop an instance because it was
// returned by "wsb list"; only a recorded owned UUID + generation permits stop.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function reconcileOwnedGuestTestCleanup({driver,listRunning}={}){
  if(!driver || typeof driver.stop!=='function' || typeof listRunning!=='function')
    throw Object.assign(new Error('Missing positively owned driver/list function.'),{code:'cleanup_invalid_owner'});
  const owned=driver.delegate?.owned ?? new Map();
  if(!(owned instanceof Map))
    throw Object.assign(new Error('Owned guest registry is invalid.'),{code:'cleanup_invalid_owner'});
  const ownedIds=new Set(owned.keys()),failed=[];
  let stoppedOwned=0;
  for(const [instanceId,entry] of [...owned.entries()]){
    if(!UUID.test(instanceId)||!UUID.test(entry?.generation||'')){
      failed.push('malformed owner record');continue;
    }
    try {
      const result=await driver.stop({instanceId,generation:entry.generation});
      if(result?.stopped!==true||result.instanceId!==instanceId)
        throw new Error('Termination was not independently confirmed.');
      stoppedOwned++;
    }catch{
      // A failed stop could have partially succeeded. Do not blindly replay.
      failed.push('uncertain owner termination');
    }
  }
  let stillRunning;
  try{stillRunning=await listRunning();}
  catch{throw Object.assign(new Error('BLOCKED: Cannot verify guest cleanup; manual reconciliation required.'),{code:'sandbox_cleanup_blocked'});}
  if(!Array.isArray(stillRunning)||stillRunning.some(x=>!UUID.test(x?.Id||'')))
    throw Object.assign(new Error('BLOCKED: Unknown guest list format, no unowned guest stopped.'),{code:'sandbox_cleanup_blocked'});
  const remaining=stillRunning.map(x=>x.Id);
  if(failed.length||remaining.length){
    const ownLeft=remaining.filter(x=>ownedIds.has(x)).length;
    const foreign=remaining.length-ownLeft;
    throw Object.assign(new Error('BLOCKED: '+failed.length+' uncertain owned stops, '+ownLeft+
      ' owned and '+foreign+' unowned/unknown instances remain; no foreign Sandbox was stopped.'),{code:'sandbox_cleanup_blocked'});
  }
  return Object.freeze({verified:true,stoppedOwned,unownedStopped:0});
}
