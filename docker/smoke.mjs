import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const name='ez-voice-smoke-'+randomUUID();const image=process.env.EZ_VOICE_IMAGE||'ez-voice:local';
const docker=(args)=>execFileSync('docker',args,{encoding:'utf8'});
try{
  docker(['run','-d','--name',name,'--cap-drop=ALL',image]);
  let healthy=false;
  for(let i=0;i<20;i++){try{const v=JSON.parse(docker(['exec',name,'node','bin/ez-voice.mjs','health']));healthy=v.healthy;if(healthy)break;}catch{}await new Promise(r=>setTimeout(r,250));}
  assert(healthy);const doc=JSON.parse(docker(['exec',name,'node','bin/ez-voice.mjs','doctor']));assert.equal(doc.configured,false);
  docker(['restart',name]);
  console.log(JSON.stringify({healthy,configured:false,restart:true}));
}finally{docker(['rm','-f',name]);}
