#!/usr/bin/env bun
// workflow warrant: attests puzzle reached required_state AT ISSUANCE. Issuer checks pbxd live, then freezes the attestation.
import { mint } from './warrants.ts';
const a=(f:string,d='')=>{const i=process.argv.indexOf(f);return i>-1&&process.argv[i+1]?process.argv[i+1]:d;};
const puzzle=a('--puzzle','deploy-marker-puzzle'), need=a('--required-state','READY');
let live='UNKNOWN', epoch=-1; try{const j=await (await fetch('http://127.0.0.1:8788/state')).json();live=String(j?.currentState);epoch=Number(j?.epoch);}catch{}
if(a('--force','')!=='1' && live!==need){ console.error(`REFUSED: puzzle is ${live}, not ${need} (issuer verifies before minting)`); process.exit(2); }
console.log(mint('wf',{puzzle_id:puzzle,required_state:need,observed_state:live,epoch,action:a('--action','deploy-marker'),resource:a('--resource',(process.env.PROTECTED_DIR||`${process.env.INQ_DIR||import.meta.dir}/protected`)+'/deployments.log'),nonce:a('--nonce',`wf-${Date.now()}`),expires:new Date(Date.now()+Number(a('--ttl-seconds','300'))*1000).toISOString()}));
