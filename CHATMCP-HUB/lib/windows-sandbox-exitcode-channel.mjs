// SECURITY NOTE — EXPERIMENTAL, NON-ATTESTING TRANSPORT CODEC.
//
// Windows Sandbox "wsb exec --raw" returns only ExitCode, not process IO.
// Nine *positive*, 31-bit exit codes can hypothetically carry all 256 bits
// of a SHA-256 digest from a trusted guest process to its owning host.
// Each code uses 01 as top-two bits, then 30 digest bits. The last chunk has
// 14 ZERO padding bits. This avoids signed int32 conversions and ordinary
// ExitCode=0 being confused with a successful digest word.
//
// Digest equality does NOT prove the codes originated with a pinned, OS-owned
// trusted GuestSupervisor, or that a guest-local seal cannot be overwritten.
// No native execution, no production authority, no signing key or host shell
// is exposed by this feasibility codec. DO NOT UNLOCK G4 FROM THIS MODULE.
import { createHash } from 'node:crypto';

const BAD=(message)=>{
  const error=new Error(message);
  error.code='untrusted_exitcode_channel';
  return error;
};
const BASE=0x40000000; // high bits 01: positive, nonzero, < 2^31
const MASK=(1n<<30n)-1n;
const PAD=(1n<<14n)-1n;
const COUNT=9;

function bytesOf(value) {
  if(typeof value!=='string' && !Buffer.isBuffer(value))
    throw BAD('Digest payload must be a string or Buffer from a trusted caller.');
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(value,'utf8');
  if(bytes.length<1||bytes.length>1024*1024)
    throw BAD('Digest payload must contain 1–1048576 bytes.');
  return bytes;
}

/** Offline candidate only; does NOT transmit anything to a real guest. */
export function candidateDigestExitCodes(payload) {
  const digest=createHash('sha256').update(bytesOf(payload)).digest('hex');
  const padded=BigInt('0x'+digest)<<14n; // 256 useful bits, 14 canonical zeros
  return Object.freeze(Array.from({length:COUNT},(_,i)=>{
    const shift=BigInt((COUNT-i-1)*30);
    return BASE+Number((padded>>shift)&MASK);
  }));
}

/** Observe nine WSB ExitCode-only responses. ALWAYS unauthenticated. */
export function observeUnattestedExitDigest({payload,rawResponses}={}) {
  const bytes=bytesOf(payload);
  if(!Array.isArray(rawResponses)||rawResponses.length!==COUNT)
    throw BAD('A complete 256-bit digest needs nine positive 30-bit exit-code words.');
  let bits=0n;
  for(const raw of rawResponses){
    let response=raw;
    if(typeof response==='string'){
      if(response.length>16384)throw BAD('WSB raw response too large.');
      try{response=JSON.parse(response);}catch{throw BAD('Malformed WSB JSON.');}
    }
    if(!response||typeof response!=='object'||Array.isArray(response)||
        !Object.hasOwn(response,'ExitCode'))
      throw BAD('WSB response missing ExitCode.');
    const code=response.ExitCode;
    if(!Number.isSafeInteger(code)||code<BASE||code>0x7fffffff)
      throw BAD('WSB returned no valid positive framed digest word.');
    bits=(bits<<30n)|BigInt(code-BASE);
  }
  if((bits&PAD)!==0n)throw BAD('Nonzero final digest padding bits.');
  const observed=(bits>>14n).toString(16).padStart(64,'0');
  const expected=createHash('sha256').update(bytes).digest('hex');
  return Object.freeze({
    status:observed===expected?'DIGEST_MATCHED_BUT_UNAUTHENTICATED':'DIGEST_MISMATCH',
    wordCount:COUNT,digestMatches:observed===expected,
    framedWordBits:30,
    sourceProven:false,productionAuthenticated:false,
  });
}
