import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {servePhone, twilioSignature, phoneRoute, phoneCommand, validatePhoneConfig} from '../src/phone.mjs';
import {PhoneNumber} from '../src/phone-provider.mjs';

const config = {apiKey: 'sk-synthetic123456789', accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com', instructions: 'Synthetic audio test'};
const callSid = 'CA' + '3'.repeat(32), streamSid = 'MZ' + '4'.repeat(32), recordingSid = 'RE' + '8'.repeat(32);
const wait = async fn => {for (let i=0; i<100; i++) {if (fn()) return; await new Promise(r=>setTimeout(r,10));} throw Error('Timed out');};
class ProviderSocket extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; events = [];
  constructor() {super(); setImmediate(()=>this.emit('open'));}
  send(raw) {
    const event = JSON.parse(raw); this.events.push(event);
    if (event.type === 'session.start') setImmediate(()=>this.emit('message', Buffer.from(JSON.stringify({type:'session.started', session:{id:'live_synthetic'}}))));
    if (event.type === 'session.close') setImmediate(()=>this.emit('message', Buffer.from(JSON.stringify({type:'session.closed', usage:{seconds:1}}))));
  }
  close() {this.readyState = WebSocket.CLOSED; this.emit('close');}
  terminate() {this.close();}
}
// A Twilio REST client whose fetch is synthetic: the tests never reach api.twilio.com.
function twilio(respond = async () => new Response(JSON.stringify({sid: recordingSid}), {status: 201})) {
  const requests = [];
  return {requests, provider: new PhoneNumber(config, async (url, options) => {requests.push({url, options}); return respond();})};
}
const startEvent = (ticket, id = callSid) => JSON.stringify({event:'start', start:{accountSid:config.accountSid,callSid:id,streamSid,
  customParameters:{ticket},mediaFormat:{encoding:'audio/x-mulaw',sampleRate:8000,channels:1}}});
async function mediaSocket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/media`, {
    headers:{'x-twilio-signature':twilioSignature(config.authToken,config.origin+'/media')}});
  await new Promise((resolve,reject) => {ws.once('open',resolve);ws.once('error',reject);});
  return ws;
}
async function connectCall(port, id = callSid) {
  const params = new URLSearchParams({AccountSid:config.accountSid, To:config.number, CallSid:id});
  const response = await fetch(`http://127.0.0.1:${port}/incoming`, {method:'POST', body:params,
    headers:{'x-twilio-signature':twilioSignature(config.authToken,config.origin+'/incoming',params)}});
  const ticket = (await response.text()).match(/value="([a-f0-9]+)"/)[1];
  const ws = await mediaSocket(port);
  ws.ticket = ticket; ws.send(startEvent(ticket, id));
  return ws;
}
test('inbound listener admits calls after thirty minutes and more than five completed calls', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const receipts=[], providers=[];
  const server=await servePhone(config,{port:0,host:'127.0.0.1',provider:twilio().provider,socketFactory:()=>{const provider=new ProviderSocket();providers.push(provider);return provider;},record:async value=>{receipts.push(value);}});
  t.mock.timers.tick(31*60000);
  t.mock.timers.reset();
  try {
    for(let i=0;i<7;i++) {
      const ws=await connectCall(server.port,'CA'+String(i).padStart(32,'0'));
      await wait(()=>providers[i]?.events.some(event=>event.type==='session.start'));
      await new Promise(resolve=>setImmediate(resolve));
      ws.close();
      await wait(()=>receipts.length===i+1);
      assert.equal(receipts[i].finalized,true);
    }
    const health=await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(health.status,200);
    assert.deepEqual(await health.json(),{ready:true,active:false,admitted:7,model:'gpt-live-1'});
  } finally {await server.close();}
});
test('signed inbound HTTP + real media socket relays mu-law both ways and finalizes without native tools', async () => {
  let provider, receipt;
  const server = await servePhone(config, {port:0, host:'127.0.0.1', provider:twilio().provider, socketFactory:()=>provider=new ProviderSocket(), record:async r=>{receipt=r;}});
  const base = `http://127.0.0.1:${server.port}`; let ws;
  try {
    const params = new URLSearchParams({AccountSid:config.accountSid, To:config.number, CallSid:callSid});
    assert.equal((await fetch(base+'/incoming',{method:'POST', body:params})).status,403);
    const headers = {'x-twilio-signature':twilioSignature(config.authToken,config.origin+'/incoming',params)};
    const response = await fetch(base+'/incoming',{method:'POST',headers,body:params}); assert.equal(response.status,200);
    const xml=await response.text(), ticket=xml.match(/value="([a-f0-9]+)"/)[1]; assert(xml.includes('wss://phone.example.com/media'));
    ws=new WebSocket(base.replace('http:','ws:')+'/media',{headers:{'x-twilio-signature':twilioSignature(config.authToken,config.origin+'/media')}});
    const output=[]; ws.on('message',raw=>output.push(JSON.parse(raw.toString())));
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    ws.send(JSON.stringify({event:'start', start:{accountSid:config.accountSid,callSid,streamSid,customParameters:{ticket},mediaFormat:{encoding:'audio/x-mulaw',sampleRate:8000,channels:1}}}));
    await wait(()=>provider?.events[0]); assert.equal(provider.events[0].session.audio.format.type,'audio/pcmu');
    assert.equal(provider.events[0].session.model,'gpt-live-1'); assert.equal(provider.events[0].session.store,false);
    ws.send(JSON.stringify({event:'media',media:{payload:'//8='}}));
    await wait(()=>provider.events.some(e=>e.type==='session.input_audio.append'));
    assert.equal(provider.events.find(e=>e.type==='session.input_audio.append').audio,'//8=');
    provider.emit('message',Buffer.from(JSON.stringify({type:'session.output_audio.delta',delta:'//8='})));
    await wait(()=>output.length); assert.deepEqual(output[0],{event:'media',streamSid,media:{payload:'//8='}});
    provider.emit('message',Buffer.from(JSON.stringify({type:'session.delegation.created',delegation:{id:'delegation_test'}})));
    assert(provider.events.find(e=>e.type==='session.commentary.append').content.includes('No backend'));
    ws.close(); await wait(()=>receipt); assert.equal(receipt.finalized,true); assert.equal(receipt.inputBytes,2); assert.equal(receipt.outputBytes,2);
    assert.equal(JSON.stringify(receipt).includes(config.apiKey),false);
  } finally {ws?.terminate(); await server.close();}
});
test('unsigned media handshake cannot reach the model', async () => {
  let called=false; const server=await servePhone(config,{port:0,host:'127.0.0.1',socketFactory:()=>{called=true;}});
  try {
    const ws=new WebSocket(`ws://127.0.0.1:${server.port}/media`);
    const error=await new Promise(resolve=>ws.once('error',resolve)); assert.match(error.message,/403/); assert.equal(called,false);
  } finally {await server.close();}
});
test('voice routing saves restoration data, changes only voice fields, and refuses outside changes', async () => {
  const directory=await mkdtemp(join(tmpdir(),'voice-phone-test-'));
  const before={VoiceUrl:'https://old.example.com/voice',VoiceMethod:'POST',VoiceFallbackUrl:'',VoiceFallbackMethod:'POST',VoiceApplicationSid:'',TrunkSid:''};
  let route={...before}, writes=0;
  const provider={get:async()=>({numberSid:'PN'+'5'.repeat(32),number:config.number,route:{...route}}),set:async(_id,value)=>{writes++;route={...value};}};
  try {
    await phoneRoute(directory,config,'preview',{provider}); assert.equal(writes,0);
    const applied=await phoneRoute(directory,config,'route',{provider}); assert.equal(applied.receipt.state,'applied'); assert.deepEqual(applied.receipt.before,before);
    assert(Object.keys(route).every(k=>!k.startsWith('Sms')));
    await assert.rejects(()=>phoneRoute(directory,config,'route',{provider}),/already exists/);
    route.VoiceUrl='https://other.example.com'; await assert.rejects(()=>phoneRoute(directory,config,'restore',{provider}),/outside/);
    route={...applied.receipt.target}; await phoneRoute(directory,config,'restore',{provider}); assert.deepEqual(route,before);
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('phone configuration rejects transport downgrade and unknown authority fields', () => {
  assert.throws(()=>validatePhoneConfig({...config,origin:'http://phone.example.com'}),/HTTPS/);
  assert.throws(()=>validatePhoneConfig({...config,followOwner:true}),/fields/);
});
test('interrupted route and restore remain recoverable by canonical readback without another write', async () => {
  const directory=await mkdtemp(join(tmpdir(),'voice-phone-recovery-'));
  const before={VoiceUrl:'https://old.example.com/voice',VoiceMethod:'POST',VoiceFallbackUrl:'',VoiceFallbackMethod:'POST',VoiceApplicationSid:'',TrunkSid:''};
  let route={...before},writes=0;
  const provider={get:async()=>({numberSid:'PN'+'5'.repeat(32),number:config.number,route:{...route}}),set:async(_id,value)=>{writes++;route={...value};throw Error('Interrupted response');}};
  try {
    await assert.rejects(()=>phoneRoute(directory,config,'route',{provider}),/Interrupted/);
    assert.equal((await phoneRoute(directory,config,'status',{provider})).receipt.state,'uncertain');
    await assert.rejects(()=>phoneRoute(directory,config,'restore',{provider}),/Interrupted/);
    assert.equal((await phoneRoute(directory,config,'status',{provider})).receipt.state,'restore_uncertain');
    assert.equal((await phoneRoute(directory,config,'restore',{provider})).receipt.state,'restored');
    assert.equal(writes,2); assert.deepEqual(route,before);
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('signed media with a ticket for another Call SID never opens a model session', async () => {
  let called=false; const server=await servePhone(config,{port:0,host:'127.0.0.1',socketFactory:()=>{called=true;}}); let ws;
  try {
    const base=`http://127.0.0.1:${server.port}`,params=new URLSearchParams({AccountSid:config.accountSid,To:config.number,CallSid:callSid});
    const headers={'x-twilio-signature':twilioSignature(config.authToken,config.origin+'/incoming',params)};
    const xml=await (await fetch(base+'/incoming',{method:'POST',headers,body:params})).text();
    const ticket=xml.match(/value="([a-f0-9]+)"/)[1];
    assert.equal(await (await fetch(base+'/incoming',{method:'POST',headers,body:params})).text(),xml);
    ws=new WebSocket(base.replace('http:','ws:')+'/media',{headers:{'x-twilio-signature':twilioSignature(config.authToken,config.origin+'/media')}});
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    const closed=new Promise(resolve=>ws.once('close',resolve));
    ws.send(JSON.stringify({event:'start',start:{accountSid:config.accountSid,callSid:'CA'+'6'.repeat(32),streamSid,customParameters:{ticket},mediaFormat:{encoding:'audio/x-mulaw',sampleRate:8000,channels:1}}}));
    await closed; assert.equal(called,false);
  } finally {ws?.terminate();await server.close();}
});
test('shutdown waits for the provider terminal event and durable receipt before completing', async () => {
  class DelayedClose extends ProviderSocket {
    send(raw) {if (JSON.parse(raw).type === 'session.close') this.events.push(JSON.parse(raw)); else super.send(raw);}
  }
  let provider, receipt, writing = false, allowWrite;
  const saved = new Promise(resolve => {allowWrite=resolve;});
  const server = await servePhone(config, {port:0,host:'127.0.0.1',provider:twilio().provider,socketFactory:()=>provider=new DelayedClose(),
    record:async value=>{writing=true;await saved;receipt=value;}});
  const ws = await connectCall(server.port);
  try {
    await wait(()=>provider?.events.some(event=>event.type==='session.start'));
    let stopped=false;
    const closing=server.close().then(()=>{stopped=true;});
    await wait(()=>provider.events.some(event=>event.type==='session.close'));
    assert.equal(stopped,false); assert.equal(receipt,undefined);
    provider.emit('message',Buffer.from(JSON.stringify({type:'session.closed',usage:{seconds:1}})));
    await wait(()=>writing); assert.equal(stopped,false);
    allowWrite(); await closing;
    assert.equal(receipt.finalized,true); assert.equal(receipt.reason,'service_stopped');
  } finally {allowWrite();ws.terminate();await server.close();}
});
test('a receipt write failure is reported during shutdown without exposing its error content', async () => {
  let provider; const messages=[], original=console.error; console.error=value=>messages.push(value);
  const server=await servePhone(config,{port:0,host:'127.0.0.1',provider:twilio().provider,socketFactory:()=>provider=new ProviderSocket(),
    record:async()=>{throw Error('private fixture must not be logged');}});
  const ws=await connectCall(server.port);
  try {
    await wait(()=>provider?.events.some(event=>event.type==='session.start'));
    ws.close();
    await wait(()=>messages.length===1);
    const health=await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(health.status,503);
    assert.equal((await health.json()).ready,false);
    const params=new URLSearchParams({AccountSid:config.accountSid,To:config.number,CallSid:'CA'+'7'.repeat(32)});
    const rejected=await fetch(`http://127.0.0.1:${server.port}/incoming`,{method:'POST',body:params,
      headers:{'x-twilio-signature':twilioSignature(config.authToken,config.origin+'/incoming',params)}});
    assert.match(await rejected.text(),/Reject reason="busy"/);
    await assert.rejects(server.close(),/receipt could not be persisted/);
    assert.equal(messages.length,1); assert.equal(messages[0].includes('private fixture'),false);
  } finally {ws.terminate();await server.close().catch(()=>{});console.error=original;}
});
test('a route rejected before applying is reconciled as restored without a second provider write', async () => {
  const directory=await mkdtemp(join(tmpdir(),'voice-phone-before-apply-'));
  const before={VoiceUrl:'https://old.example.com/voice',VoiceMethod:'POST',VoiceFallbackUrl:'',VoiceFallbackMethod:'POST',VoiceApplicationSid:'',TrunkSid:''};
  let writes=0;
  const provider={get:async()=>({numberSid:'PN'+'5'.repeat(32),number:config.number,route:{...before}}),
    set:async()=>{writes++;throw Error('Rejected before apply');}};
  try {
    await assert.rejects(()=>phoneRoute(directory,config,'route',{provider}),/Rejected before apply/);
    const restored=await phoneRoute(directory,config,'restore',{provider});
    assert.equal(restored.receipt.state,'restored');assert.deepEqual(restored.route,before);assert.equal(writes,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('an admitted inbound call starts exactly one dual-channel Twilio recording without blocking audio; a replayed start starts none', async () => {
  let provider, receipt, release;
  const gate = new Promise(resolve => {release = resolve;});
  const {requests, provider: recorder} = twilio(async () => {await gate; return new Response(JSON.stringify({sid: recordingSid}), {status: 201});});
  const server = await servePhone(config, {port:0, host:'127.0.0.1', provider:recorder, socketFactory:()=>provider=new ProviderSocket(), record:async value=>{receipt=value;}});
  let ws, replay;
  try {
    await assert.rejects(()=>recorder.startRecording('CA/../x'), /Invalid Call SID/); assert.equal(requests.length,0);
    ws = await connectCall(server.port);
    const output = []; ws.on('message', raw => output.push(JSON.parse(raw.toString())));
    await wait(()=>requests.length===1);
    // The recording request is still pending: the audio bridge already relays both ways.
    ws.send(JSON.stringify({event:'media',media:{payload:'//8='}}));
    await wait(()=>provider.events.some(event=>event.type==='session.input_audio.append'));
    provider.emit('message',Buffer.from(JSON.stringify({type:'session.output_audio.delta',delta:'//8='})));
    await wait(()=>output.length);
    ws.send(startEvent(ws.ticket));
    const {url, options} = requests[0];
    assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls/${callSid}/Recordings.json`);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.body, 'RecordingChannels=dual&RecordingTrack=both');
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64'));
    ws.close();
    await new Promise(resolve=>setTimeout(resolve,50)); assert.equal(receipt,undefined);
    release(); await wait(()=>receipt);
    assert.equal(receipt.finalized,true); assert.equal(receipt.callSid,callSid);
    assert.deepEqual(receipt.recording,{state:'started',sid:recordingSid});
    const text = JSON.stringify(receipt);
    for (const secret of [config.authToken, config.apiKey, Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')]) assert.equal(text.includes(secret),false);
    replay = await mediaSocket(server.port);
    const closed = new Promise(resolve=>replay.once('close',resolve));
    replay.send(startEvent(ws.ticket)); await closed;
    assert.equal(requests.length,1);
  } finally {ws?.terminate(); replay?.terminate(); release(); await server.close();}
});
test('a rejected, failed or malformed Twilio recording start never degrades the call and is receipted by code only', async () => {
  let provider, respond; const receipts = [];
  const {requests, provider: recorder} = twilio(()=>respond());
  const server = await servePhone(config, {port:0, host:'127.0.0.1', provider:recorder, socketFactory:()=>provider=new ProviderSocket(), record:async value=>{receipts.push(value);}});
  const cases = [
    [async()=>new Response('secret-twilio-body',{status:403}), {state:'failed',code:'HTTP_403'}],
    [async()=>new Response('secret-twilio-body',{status:500}), {state:'failed',code:'HTTP_500'}],
    [async()=>{throw Error('secret-network-error');}, {state:'failed',code:'ERROR'}],
    [async()=>new Response('{}',{status:201}), {state:'failed',code:'ERROR'}],
  ];
  try {
    for (const [index, [answer, expected]] of cases.entries()) {
      respond = answer;
      const ws = await connectCall(server.port, 'CA' + String(index + 1).repeat(32)), output = [];
      ws.on('message', raw => output.push(JSON.parse(raw.toString())));
      await wait(()=>requests.length===index+1 && provider.events.some(event=>event.type==='session.start'));
      ws.send(JSON.stringify({event:'media',media:{payload:'//8='}}));
      await wait(()=>provider.events.some(event=>event.type==='session.input_audio.append'));
      provider.emit('message',Buffer.from(JSON.stringify({type:'session.output_audio.delta',delta:'//8='})));
      await wait(()=>output.length);
      ws.close(); await wait(()=>receipts.length===index+1);
      const receipt = receipts[index];
      assert.equal(receipt.finalized,true); assert.equal(receipt.inputBytes,2); assert.equal(receipt.outputBytes,2);
      assert.deepEqual(receipt.recording,expected);
      assert.equal(/secret|authToken|sk-/.test(JSON.stringify(receipt)),false);
    }
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(health.status,200); assert.equal((await health.json()).admitted,cases.length);
  } finally {await server.close();}
});
test('phone help states that calls are recorded at Twilio and receipt readback shows the recording outcome', async () => {
  const state = await mkdtemp(join(tmpdir(),'voice-phone-help-'));
  try {
    await phoneCommand(state,['configure'],{stdin:Readable.from([JSON.stringify(config)])});
    const {limits} = await phoneCommand(state,['--help']);
    assert.match(limits,/every call is recorded at Twilio/); assert.match(limits,/stores no audio/); assert.match(limits,/operator is responsible/);
    assert.doesNotMatch(limits,/no [^;]*recording/);
    const receipt = {callSid, finalized:true, recording:{state:'failed',code:'HTTP_403'}};
    await writeFile(join(state,'phone','last-call.json'),JSON.stringify(receipt));
    assert.deepEqual(await phoneCommand(state,['receipt']),receipt);
  } finally {await rm(state,{recursive:true,force:true});}
});
