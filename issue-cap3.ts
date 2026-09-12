#!/usr/bin/env bun
// typed capability warrant (typ=cap) for the three-warrant monitor.
import { mint } from './warrants.ts';
const a=(f:string,d='')=>{const i=process.argv.indexOf(f);return i>-1&&process.argv[i+1]?process.argv[i+1]:d;};
console.log(mint('cap',{principal:a('--principal','pbagent'),action:a('--action','deploy-marker'),resource:a('--resource',(process.env.PROTECTED_DIR||`${process.env.INQ_DIR||import.meta.dir}/protected`)+'/deployments.log'),nonce:a('--nonce',`c-${Date.now()}`),expires:new Date(Date.now()+Number(a('--ttl-seconds','300'))*1000).toISOString()}));
