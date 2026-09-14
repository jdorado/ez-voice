import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelAgentTurn, runAgentTurn } from '../src/agent-client.mjs';

const runId='r_app_'+'a'.repeat(64);
test('native agent turn admits once, polls reads and returns its final reply',async()=>{
  const seen=[];let polls=0;
  const fetchImpl=async(url,options)=>{
    seen.push([String(url),options.method]);
    if(options.method==='POST')return Response.json({id:runId,status:'queued'});
    polls++;return Response.json(polls===1?{id:runId,status:'running'}:{id:runId,status:'completed',messages:[{text:'Verified result'}]});
  };
  const admitted=[];
  const result=await runAgentTurn({requestId:'voice-one',scope:'voice',text:'hello'},{url:'http://agent:8787',token:'x'.repeat(48)},{fetchImpl,pollMs:1,onAdmitted:id=>admitted.push(id)});
  assert.equal(result.reply,'Verified result');assert.deepEqual(admitted,[runId]);assert.equal(seen.filter(([,method])=>method==='POST').length,1);
});

test('agent transport rejects credentials in URLs and invalid cancellation IDs',async()=>{
  await assert.rejects(runAgentTurn({}, {url:'http://user:pass@agent:8787',token:'x'.repeat(48)}, {fetchImpl:async()=>Response.json({})}),/Invalid/);
  await assert.rejects(cancelAgentTurn('../bad',{url:'http://agent:8787',token:'x'.repeat(48)}),/Invalid/);
});
