import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeSession } from '../src/realtime.mjs';
const tool={type:'function',name:'lookup',description:'Read',parameters:{type:'object',properties:{q:{type:'string',maxLength:100}},required:['q'],additionalProperties:false}};
function fixture(execute=async()=>'{"answer":42}') {
  const sent=[], events=[];
  const session=new RealtimeSession({apiKey:'secret'},e=>events.push(e),execute);
  session.tools=new Map([['lookup',tool]]);
  session.socket={readyState:1,send:e=>sent.push(JSON.parse(e)),close(){}};
  return {session,sent,events};
}
const call={type:'function_call',status:'completed',call_id:'call_1',name:'lookup',arguments:'{"q":"notes"}'};
test('direct call returns tool output, no backend LLM invocation',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return 'real result';});
  await f.session.runTool(call);await f.session.runTool(call);
  assert.equal(calls,1);assert.equal(f.sent.length,1);assert.equal(f.sent[0].item.output,'real result');
});
test('invalid/unknown arguments never execute',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return '';});
  await f.session.runTool({...call,name:'shell'});
  assert.equal(calls,0);assert.match(f.sent[0].item.output,/not exposed/);
});
test('closed sessions reject late tool results and abort execution',async()=>{
  let release;let aborted=false;
  const f=fixture((c,signal)=>new Promise(r=>{release=r;signal.addEventListener('abort',()=>{aborted=true;});}));
  const work=f.session.runTool(call);await f.session.stop();release('late');await work;
  assert.equal(aborted,true);assert.equal(f.sent.length,0);
});
test('only complete response function calls execute',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return 'ok';});
  f.session.onEvent({type:'response.function_call_arguments.delta',delta:'{}'});
  assert.equal(calls,0);
  f.session.onEvent({type:'response.done',response:{output:[call]}});await f.session.chain;
  assert.equal(calls,1);assert.equal(f.sent.at(-1).type,'response.create');
});
test('provider errors omit credentials and response body',async()=>{
  const f=new RealtimeSession({apiKey:'private-key'},()=>{},()=>{}, {fetchImpl:async()=>new Response('sensitive details',{status:401})});
  await assert.rejects(f.start({sdp:'v=0\r\n'}),{message:'OpenAI session creation failed (401)'});
});
test('call location cannot redirect authenticated requests',async()=>{
  const f=new RealtimeSession({apiKey:'private-key'},()=>{},()=>{}, {fetchImpl:async()=>new Response('sdp',{status:201,headers:{Location:'https://evil.example/v1/realtime/calls/rtc_1'}})});
  await assert.rejects(f.start({sdp:'v=0\r\n'}),/Invalid OpenAI call location/);
});
test('resume restores role-separated text with provider acknowledgement, without replaying tools',async()=>{
 const f=fixture();const history=[{id:'user_previous',role:'user',text:'Remember orchard.'},{id:'agent_previous',role:'assistant',text:'Orchard it is.'}];
 const restoring=f.session.restore(history);
 assert.equal(f.sent[0].item.role,'user');assert.equal(f.sent[0].item.content[0].type,'input_text');
 f.session.onEvent({type:'conversation.item.added',item:{id:'user_previous'}});await Promise.resolve();
 assert.equal(f.sent[1].item.role,'assistant');assert.equal(f.sent[1].item.content[0].type,'output_text');
 f.session.onEvent({type:'conversation.item.created',item:{id:'agent_previous'}});await restoring;
 assert.equal(f.sent.length,2);assert.equal(f.session.calls.size,0);
});
test('stop waits for delayed call creation and reports failed late hangup',async()=>{
 let finishCreation,hangups=0;
 const session=new RealtimeSession({apiKey:'test'},()=>{},()=>{}, {fetchImpl:async url=>{
   if(url.endsWith('/hangup')){hangups++;return new Response('',{status:503});}
   return new Promise(resolve=>{finishCreation=resolve;});
 }});
 const starting=session.start({sdp:'v=0\r\n'});const rejected=assert.rejects(starting,/hangup unconfirmed/);
 let finished=false;const stopping=session.stop().then(r=>{finished=true;return r;});await Promise.resolve();assert.equal(finished,false);
 finishCreation(new Response('sdp',{status:201,headers:{Location:'https://api.openai.com/v1/realtime/calls/rtc_delayed'}}));
 const stopped=await stopping;await rejected;assert.equal(stopped.hangupConfirmed,false);assert.equal(hangups,1);
});
