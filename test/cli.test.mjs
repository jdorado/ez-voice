import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const bin=new URL('../bin/ez-voice.mjs',import.meta.url);

test('configure accepts only gpt-live-1 and stores both credentials privately',async()=>{
  const state=await mkdtemp(join(tmpdir(),'voice-cli-'));
  try{
    const input=JSON.stringify({apiKey:'sk-private-fixture-key',agentUrl:'http://relay:8787',agentToken:'x'.repeat(48),model:'gpt-live-1',voice:'marin'});
    const result=spawnSync(process.execPath,[bin.pathname,'configure'],{env:{...process.env,EZ_VOICE_STATE:state},input,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).model,'gpt-live-1');
    assert.equal((await stat(join(state,'config.json'))).mode&0o777,0o600);
    assert.equal(JSON.parse(await readFile(join(state,'config.json'),'utf8')).agentUrl,'http://relay:8787');
    const rejected=spawnSync(process.execPath,[bin.pathname,'configure'],{env:{...process.env,EZ_VOICE_STATE:state},input:JSON.stringify({...JSON.parse(input),model:'gpt-realtime-2.1'}),encoding:'utf8'});
    assert.equal(rejected.status,2);assert.match(rejected.stderr,/Voice requires gpt-live-1/);
  }finally{await rm(state,{recursive:true,force:true});}
});

test('phone doctor and help work before configuration without creating private state',async()=>{
  const state=await mkdtemp(join(tmpdir(),'voice-phone-doctor-'));
  try {
    for (const command of ['doctor','--help']) {
      const result=spawnSync(process.execPath,[bin.pathname,'phone',command],{env:{...process.env,EZ_VOICE_STATE:state},encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      const value=JSON.parse(result.stdout);
      if(command==='doctor')assert.equal(value.configured,false);
      else assert(value.commands.includes('phone doctor'));
    }
    await assert.rejects(stat(join(state,'phone')),{code:'ENOENT'});
  } finally {await rm(state,{recursive:true,force:true});}
});
