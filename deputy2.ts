#!/usr/bin/env bun
const CAP = process.env.DEPUTY_CAP || '';
const R2 = (process.env.PROTECTED_DIR || `${process.env.INQ_DIR||import.meta.dir}/protected`) + '/deployments2.log';
Bun.serve({ port: 8789, hostname: '127.0.0.1', async fetch(req){
  const u=new URL(req.url);
  if(u.pathname==='/health') return new Response('{"ok":true}\n');
  if(u.pathname==='/deploy'&&req.method==='POST'){ let b:any={}; try{b=await req.json();}catch{}
    const attempt=`deputy-${String(b?.attempt_id??Date.now())}`;
    const r=await fetch('http://127.0.0.1:8790/act',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({ principal:'deputy', caller:String(b?.caller??'?'), action:'deploy-marker',
        resource:String(b?.resource??R2), attempt_id:attempt, capability:CAP,
        invocation_warrant:String(b?.invocation_warrant??''), invocation_nonce:String(b?.invocation_nonce??''),
        puzzle_id:b?.puzzle_id, workflow_warrant:b?.workflow_warrant, path_used:`deputy on behalf of ${b?.caller}` })});
    return new Response(await r.text(),{status:r.status});
  }
  return new Response('{"error":"nf"}\n',{status:404});
}}); console.log('deputy2 on 8789');
