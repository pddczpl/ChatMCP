// SECURITY NOTE — EXPERIMENTAL, NON-ATTESTING TRANSPORT CODEC.
//
// wsb exec --raw returns only an ExitCode (confirmed on Windows 11 and in
// Microsoft documentation); it cannot carry a normal JSON receipt in stdout.
// Eight 32-bit process exits could, in principle, transport a SHA-256 digest
// of a privileged supervisor-created receipt from guest to host WITHOUT
// sending a host HMAC bearer key into guest-writable mapped storage.
//
// WARNING: digest equality alone DOES NOT prove that trusted GuestSupervisor
// emitted those exit codes or that the child cannot replace a guest-local
// digest state. This module performs NO native guest invocation, has NO
// capability to enable the production backend, and is NOT release evidence.
import { createHash } from 'node:crypto';

const HEX64=/^[0-9a-f]{64}$/i;
const BAD=(message)=>{
  const err=new Error(message);
  err.code='untrusted_exitcode_channel';
  return err;
};

function getBytes(value) {
  if(typeof value!=='string' && !Buffer.isBuffer(value))
    throw BAD('Digest payload must be an explicit bounded string or Buffer.');
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(value,'utf8');
  if(!bytes.length||bytes.length>1024*1024)
    throw BAD('Digest payload must contain 1–1048576 bytes.');
  return bytes;
}

/**
 * Derive eight *signed* int32 exit-code candidates for an arbitrary payload.
 * Signed int32 values are not yet proved to round-trip through every wsb
 * version. This is an OFFLINE codec, not a process launch/attestation function.
 */
export function candidateDigestExitCodes(payload) {
  const digest=createHash('sha256').update(getBytes(payload)).digest();
  return Object.freeze(Array.from({length:8},(_,i)=>digest.readInt32BE(i*4)));
}

const signedWord=(value)=>{
  if(!Number.isInteger(value)||value<-2147483648||value>4294967295)
    throw BAD('Unexpected Windows process ExitCode (not int32/uint32).');
  return value>>>0;
};

/**
 * Parse eight raw WSB CLI responses and compare their 256-bit payload digest.
 *
 * Does NOT accept user-supplied "attestation" flags. Still not trusted: caller
 * must separately establish native OS provenance, protected guest-local state,
 * pinned binary, fresh launch generation, nonce and one-shot ownership.
 */
export function observeUnattestedExitDigest({payload,rawResponses}={}) {
  const bytes=getBytes(payload);
  if(!Array.isArray(rawResponses)||rawResponses.length!==8)
    throw BAD('A full 256-bit digest requires exactly eight owned OS exits.');
  const found=Buffer.alloc(32);
  for(const [i,raw] of rawResponses.entries()){
    // Only the documented ExitCode is read. Never copy "Stdout" or "signature"
    // from an untrusted plugin/guest response.
    let parsed=raw;
    if(typeof parsed==='string'){
      if(parsed.length>16384)throw BAD('Raw WSB response exceeds bounded JSON size.');
      try{parsed=JSON.parse(parsed);}catch{throw BAD('Invalid WSB JSON result.');}
    }
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||
        !Object.hasOwn(parsed,'ExitCode'))
      throw BAD('WSB response missing typed ExitCode.');
    found.writeUInt32BE(signedWord(parsed.ExitCode),i*4);
  }
  const expected=createHash('sha256').update(bytes).digest('hex');
  const observed=found.toString('hex');
  const digestMatches=observed===expected;
  // Deliberately NO publisherAuthenticated:true, not even on a full match.
  return Object.freeze({
    status:digestMatches?'DIGEST_MATCHED_BUT_UNAUTHENTICATED':'DIGEST_MISMATCH',
    wordCount:8,expectedWordBits:32,
    digestMatches,sourceProven:false,productionAuthenticated:false,
    // No full payload, digest or synthetic secret copied into tool output.
  });
}
