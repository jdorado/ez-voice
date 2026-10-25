import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {servePhone, twilioSignature, phoneRoute, validatePhoneConfig} from '../src/phone.mjs';

const config = {apiKey: 'sk-synthetic123456789', accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com', instructions: 'Synthetic audio test'};
const callSid = 'CA' + '3'.repeat(32), streamSid = 'MZ' + '4'.repeat(32);
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
test('signed inbound HTTP + real media socket relays mu-law both ways and finalizes without native tools', async () => {
  let provider, receipt;
  const server = await servePhone(config, {port:0, host:'127.0.0.1', socketFactory:()=>provider=new ProviderSocket(), record:async r=>{receipt=r;}});
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
