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
  first.observe({type:'input_audio_buffer.committed',item_id:'user1'});
  first.observe({type:'response.output_audio_transcript.done',item_id:'agent1',transcript:'We can plan the orchard.'});
  first.observe({type:'conversation.item.input_audio_transcription.completed',item_id:'user1',transcript:'My code word is orchard.'});
  await first.flush();const id=first.value.id;
  const next=new VoiceHistory(root);const recent=await next.begin();
  assert.deepEqual(recent.map(m=>m.id),['user1','agent1']);assert.match(recent[0].text,/orchard/);
  assert.equal((await stat(join(root,'conversations',id+'.json'))).mode&0o777,0o600);
  next.observe({type:'conversation.item.truncated',item_id:'agent1'});await next.flush();
  assert.deepEqual((await next.load()).messages.map(m=>m.id),['user1']);
  assert.deepEqual(await next.begin(false),[]);assert.notEqual(next.value.id,id);
  assert.equal(JSON.parse(await readFile(join(root,'conversations',id+'.json'))).messages.length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('resume window is bounded and contains only conversation text',()=>{
 const items=Array.from({length:100},(_,i)=>({id:`m${i}`,role:i%2?'assistant':'user',text:'x'.repeat(1000)}));
 const recent=recentMessages(items);assert.equal(recent.length,12);assert.equal(recent.at(-1).id,'m99');
 assert.deepEqual(recentMessages([{id:'t',role:'tool',text:'do something'}]),[]);
});
