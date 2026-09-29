// warrants.ts — three typed, separately-keyed warrants. A warrant = base64url(claims)."."base64url(HMAC(claims,key_for_typ)).
// typ is inside the claims AND selects the key, so a cap can never verify as an inv or wf warrant.
import { createHmac, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
const D = process.env.INQ_DIR || import.meta.dir;
const K = `${D}/.keys`;
const KEYS: Record<string,string> = {
  cap: readFileSync(`${K}/cap.key`,'utf8').trim(),
  inv: readFileSync(`${K}/inv.key`,'utf8').trim(),
  wf:  readFileSync(`${K}/wf.key`,'utf8').trim(),
  permit: readFileSync(`${K}/permit.key`,'utf8').trim(),
  state: readFileSync(`${K}/state.key`,'utf8').trim(), // seals pbxd's persisted {state,epoch} pair (issue #1)
};
const b64u = (s:string)=>Buffer.from(s).toString('base64url');
const unb64u = (s:string)=>Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');
export function mint(typ:'cap'|'inv'|'wf'|'permit', claims:object):string { const p=b64u(JSON.stringify({...claims,typ})); return `${p}.${createHmac('sha256',KEYS[typ]).update(p).digest('base64url')}`; }
// seal/sealOk: bare HMAC over a payload string with the dedicated `state` key. Not a warrant: no typ, no expiry.
export function seal(payload:string):string { return createHmac('sha256',KEYS.state).update(payload).digest('base64url'); }
export function sealOk(payload:string, sig:string):boolean { const a=Buffer.from(String(sig)),b=Buffer.from(seal(payload)); return a.length===b.length&&timingSafeEqual(a,b); }
export function verify(typ:'cap'|'inv'|'wf'|'permit', tok:string):{ok:boolean;why:string;claims:any}{
  if(typeof tok!=='string'||!tok) return {ok:false,why:`no ${typ} warrant`,claims:null};
  const parts=tok.split('.'); if(parts.length!==2) return {ok:false,why:`malformed ${typ} warrant`,claims:null};
  const [p,sig]=parts; const exp=createHmac('sha256',KEYS[typ]).update(p).digest('base64url');
  const a=Buffer.from(sig),b=Buffer.from(exp); if(a.length!==b.length||!timingSafeEqual(a,b)) return {ok:false,why:`bad ${typ} signature`,claims:null};
  let c:any; try{c=JSON.parse(unb64u(p));}catch{return {ok:false,why:`unparseable ${typ} claims`,claims:null};}
  if(c.typ!==typ) return {ok:false,why:`warrant typ ${c.typ} presented as ${typ}`,claims:c};
  if(!c.expires||Date.parse(c.expires)<=Date.now()) return {ok:false,why:`${typ} warrant expired`,claims:c};
  return {ok:true,why:'ok',claims:c};
}
