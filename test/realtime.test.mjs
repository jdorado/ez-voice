import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RealtimeSession } from '../src/realtime.mjs';

class Socket extends EventEmitter {
  constructor(){super();this.readyState=1;this.sent=[];queueMicrotask(()=>this.emit('open'));}
  send(value){this.sent.push(JSON.parse(value));}
  close(){this.readyState=3;this.emit('close');}
}
const config={apiKey:'private-key',agentUrl:'http://agent:8787',agentToken:'x'.repeat(48),voice:'marin'};
const liveResponse=()=>new Response(JSON.stringify({session:{id:'live_fixture'},transport:{type:'webrtc',sdp:'v=0\r\nanswer'}}),{status:201,headers:{'content-type':'application/json'}});
function fixture(options={}){
  const events=[],sockets=[],requests=[];
  const socketFactory=(url,socketOptions)=>{const socket=new Socket();sockets.push({url,options:socketOptions,socket});return socket;};
  const fetchImpl=options.fetchImpl||(async(url,request)=>{requests.push({url:String(url),request});return liveResponse();});
  const session=new RealtimeSession(config,event=>events.push(event),undefined,{fetchImpl,socketFactory,runAgent:options.runAgent,cancelAgent:options.cancelAgent,observe:options.observe});
  return {session,events,sockets,requests};
}

test('creates exact GPT-Live WebRTC client-delegation session and seeds retained text',async()=>{
  const f=fixture();
  const result=await f.session.start({sdp:'v=0\r\noffer',instructions:'Short voice prompt',history:[{role:'user',text:'Earlier question'}]});
  assert.equal(result.model,'gpt-live-1');assert.equal(result.sdp,'v=0\r\nanswer');
  assert.equal(f.requests[0].url,'https://api.openai.com/v1/live/sessions');
  const body=JSON.parse(f.requests[0].request.body);
  assert.equal(body.session.model,'gpt-live-1');assert.deepEqual(body.session.delegation,{type:'client'});
  assert.deepEqual(body.session.audio,{output:{voice:'marin'}});assert.equal(body.session.audio.format,undefined);
  assert.equal(body.session.input[0].content[0].text,'Earlier question');
  assert.equal(f.sockets[0].url,'wss://api.openai.com/v1/live/sessions/live_fixture/attach');
  f.session.onEvent({type:'session.closed',reason:'close_requested',usage:{seconds:1}});await f.session.stop();
});

test('provider errors omit credentials and response body',async()=>{
  const f=fixture({fetchImpl:async()=>new Response('sensitive details',{status:401})});
  await assert.rejects(f.session.start({sdp:'v=0\r\n'}),{message:'OpenAI session creation failed (401)'});
});

test('invalid Live response is rejected without trusting IDs or SDP',async()=>{
  const f=fixture({fetchImpl:async()=>Response.json({session:{id:''},transport:{type:'webrtc',sdp:'v=0'}})});
  await assert.rejects(f.session.start({sdp:'v=0\r\n'}),/Invalid OpenAI Live session response/);
});

test('preserves an opaque bounded Live session ID when attaching',async()=>{
  const f=fixture({fetchImpl:async()=>Response.json({session:{id:'provider/session opaque'},transport:{type:'webrtc',sdp:'v=0\r\nanswer'}})});
  await f.session.start({sdp:'v=0\r\n',instructions:'prompt'});
  assert.equal(f.sockets[0].url,'wss://api.openai.com/v1/live/sessions/provider%2Fsession%20opaque/attach');
  f.session.onEvent({type:'session.closed'});await f.session.stop();
});

test('client delegation sends accumulated transcript through the native agent once',async()=>{
  let resolveAgent,calls=0;const observed=[];
  const f=fixture({observe:event=>observed.push(event),runAgent:async(input,options)=>{calls++;options.onAdmitted('r_app_'+'b'.repeat(64));assert.match(input.text,/Owner: Find my orchard note/);assert.equal(input.scope,'voice');assert.equal(options.url,config.agentUrl);return new Promise(resolve=>{resolveAgent=resolve;});}});
  await f.session.start({sdp:'v=0\r\n',instructions:'prompt'});
  f.session.onEvent({type:'session.input_transcript.delta',delta:'Find my orchard note',start_ms:1,end_ms:10});
  const event={type:'session.delegation.created',delegation:{id:'item_one',target:'client'}};
  f.session.onEvent(event);f.session.onEvent(event);await Promise.resolve();assert.equal(calls,1);assert.equal(observed.length,1);
  resolveAgent({runId:'r_app_'+'b'.repeat(64),reply:'The note says blue.'});
  await f.session.delegations.get('item_one').promise;
  const sent=f.sockets[0].socket.sent.find(item=>item.type==='session.commentary.append');
  assert.equal(sent.delegation_id,'item_one');assert.equal(sent.content,'The note says blue.');
  f.session.onEvent({type:'session.closed'});await f.session.stop();
});

test('graceful stop cancels admitted native work and waits for session.closed',async()=>{
  let cancelled,resolveAgent;
  const f=fixture({runAgent:async(_input,options)=>{options.onAdmitted('r_app_'+'c'.repeat(64));return new Promise(resolve=>{resolveAgent=resolve;});},cancelAgent:async runId=>{cancelled=runId;}});
  await f.session.start({sdp:'v=0\r\n',instructions:'prompt'});
  f.session.onEvent({type:'session.delegation.created',delegation:{id:'item_two',target:'client'}});await Promise.resolve();
  const stopping=f.session.stop();
  while(!f.sockets[0].socket.sent.some(item=>item.type==='session.close'))await Promise.resolve();
  f.session.onEvent({type:'session.closed',reason:'close_requested',usage:{seconds:2}});
  const result=await stopping;resolveAgent({runId:cancelled,reply:'late'});
  assert.equal(result.hangupConfirmed,true);assert.equal(cancelled,'r_app_'+'c'.repeat(64));
});

test('graceful stop does not cancel native work that already completed',async()=>{
  let cancellations=0;
  const f=fixture({runAgent:async(_input,options)=>{options.onAdmitted('r_app_'+'d'.repeat(64));return {runId:'r_app_'+'d'.repeat(64),reply:'done'};},cancelAgent:async()=>{cancellations++;}});
  await f.session.start({sdp:'v=0\r\n',instructions:'prompt'});
  f.session.onEvent({type:'session.delegation.created',delegation:{id:'item_done',target:'client'}});
  await f.session.delegations.get('item_done').promise;
  const stopping=f.session.stop();f.session.onEvent({type:'session.closed',reason:'close_requested'});
  await stopping;assert.equal(cancellations,0);
});

test('stop during delayed creation attaches and finalizes the created session',async()=>{
  let finishCreation;
  const f=fixture({fetchImpl:async()=>new Promise(resolve=>{finishCreation=resolve;})});
  const starting=f.session.start({sdp:'v=0\r\n',instructions:'prompt'});
  const stopping=f.session.stop();await Promise.resolve();finishCreation(liveResponse());
  while(!f.sockets.length)await Promise.resolve();
  while(!f.sockets[0].socket.sent.some(item=>item.type==='session.close'))await Promise.resolve();
  f.session.onEvent({type:'session.closed',reason:'close_requested'});
  const stopped=await stopping;await assert.rejects(starting,/closed during startup/);
  assert.equal(stopped.hangupConfirmed,true);
});
