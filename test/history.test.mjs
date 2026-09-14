import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {VoiceHistory,recentMessages} from '../src/history.mjs';

test('retains ordered transcripts across runtime instances; new conversation preserves prior file',async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-history-'));
 try{
  const first=new VoiceHistory(root);assert.deepEqual(await first.begin(),[]);
  first.observe({type:'session.input_transcript.delta',delta:'My code word is orchard.',start_ms:0,end_ms:200});
  first.observe({type:'session.output_transcript.delta',delta:'We can plan the orchard.',start_ms:200,end_ms:400});
  await first.flush();const id=first.value.id;
  const next=new VoiceHistory(root);const recent=await next.begin();
  assert.deepEqual(recent.map(m=>m.role),['user','assistant']);assert.match(recent[0].text,/orchard/);
  assert.equal((await stat(join(root,'conversations',id+'.json'))).mode&0o777,0o600);
  assert.deepEqual(await next.begin(false),[]);assert.notEqual(next.value.id,id);
  assert.equal(JSON.parse(await readFile(join(root,'conversations',id+'.json'))).messages.length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('resume window is bounded and contains only conversation text',()=>{
 const items=Array.from({length:100},(_,i)=>({id:`m${i}`,role:i%2?'assistant':'user',text:'x'.repeat(1000)}));
 const recent=recentMessages(items);assert.equal(recent.length,12);assert.equal(recent.at(-1).id,'m99');
 assert.deepEqual(recentMessages([{id:'t',role:'tool',text:'do something'}]),[]);
});
test('GPT-Live transcript deltas retain bounded speaker rows without inventing spaces',async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-live-history-'));
 try{
  const history=new VoiceHistory(root);await history.begin(false);
  history.observe({type:'session.input_transcript.delta',delta:'Hello ',start_ms:100,end_ms:200});
  history.observe({type:'session.input_transcript.delta',delta:'there',start_ms:200,end_ms:300});
  history.observe({type:'session.output_transcript.delta',delta:'Hi.',start_ms:250,end_ms:400});
  await history.flush();
  const saved=await history.load();assert.deepEqual(saved.messages.map(({role,text})=>({role,text})),[{role:'user',text:'Hello there'},{role:'assistant',text:'Hi.'}]);
 }finally{await rm(root,{recursive:true,force:true});}
});
