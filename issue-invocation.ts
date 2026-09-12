#!/usr/bin/env bun
// invocation warrant: caller is permitted to invoke deputy for exactly this action/resource/attempt.
import { mint } from './warrants.ts';
const a=(f:string,d='')=>{const i=process.argv.indexOf(f);return i>-1&&process.argv[i+1]?process.argv[i+1]:d;};
console.log(mint('inv',{caller:a('--caller','pbagent'),deputy:a('--deputy','deputy'),action:a('--action','deploy-marker'),resource:a('--resource',(process.env.PROTECTED_DIR||`${process.env.INQ_DIR||import.meta.dir}/protected`)+'/deployments2.log'),nonce:a('--nonce',`inv-${Date.now()}`),expires:new Date(Date.now()+Number(a('--ttl-seconds','300'))*1000).toISOString()}));
