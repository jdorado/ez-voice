import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import net from 'node:net';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import WebSocket from 'ws';
import {PhoneCalls,phoneControl,servePhoneControl,callOptions,LAST_CALL} from '../src/phone-calls.mjs';
import {PhoneNumber} from '../src/phone-provider.mjs';
import {servePhone,twilioSignature} from '../src/phone.mjs';

const config={apiKey:'sk-synthetic123456789',accountSid:'AC'+'1'.repeat(32),authToken:'2'.repeat(32),number:'+15551230001',origin:'https://phone.example.com',instructions:'Synthetic test'};
const id='outbound-synthetic',to='+15551230002',callSid='CA'+'3'.repeat(32),streamSid='MZ'+'4'.repeat(32),recordingSid='RE'+'8'.repeat(32);
const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out');};
class AudioProvider extends EventEmitter {
  readyState=WebSocket.OPEN;bufferedAmount=0;events=[];
  constructor(){super();setImmediate(()=>this.emit('open'));}
  send(raw){const event=JSON.parse(raw);this.events.push(event);if(event.type==='session.start')setImmediate(()=>this.emit('message',Buffer.from(JSON.stringify({type:'session.started',session:{id:'live_synthetic'}}))));if(event.type==='session.close')setImmediate(()=>this.emit('message',Buffer.from(JSON.stringify({type:'session.closed',usage:{seconds:1}}))));}
  close(){this.readyState=WebSocket.CLOSED;this.emit('close');}
  terminate(){this.close();}
}
class TwilioProvider {
  creates=0;ends=[];
  value={sid:callSid,account_sid:config.accountSid,from:config.number,to,direction:'outbound-api',status:'queued'};
  async createCall(){this.creates++;return {...this.value};}
  async getCall(){return {...this.value};}
  async endCall(_sid,status){this.ends.push(status);this.value.status=status;return {...this.value};}
}
// Synthetic Twilio REST client: the tests never reach api.twilio.com.
function recorder(){const requests=[];return {requests,provider:new PhoneNumber(config,async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({sid:recordingSid}),{status:201});})};}
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'voice-outbound-'));
  const provider=new TwilioProvider(),calls=new PhoneCalls(directory,config,provider);
  t.after(async()=>{calls.close();await rm(directory,{recursive:true,force:true});});
  return {directory,provider,calls};
}
function params(status='in-progress'){return new URLSearchParams({AccountSid:config.accountSid,CallSid:callSid,From:config.number,To:to,Direction:'outbound-api',CallStatus:status});}
async function post(port,path,body){return fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',body,headers:{'x-twilio-signature':twilioSignature(config.authToken,config.origin+path,body)}});}

test('private call command dials once, signed answer streams audio, and terminal callback releases the line',async t=>{
  const {directory,provider,calls}=await fixture(t);let audio,receipt,ws;
  const web=await servePhone(config,{port:0,host:'127.0.0.1',calls,provider:recorder().provider,socketFactory:()=>audio=new AudioProvider(),record:async value=>{receipt=value;}});
  const control=await servePhoneControl(directory,frame=>frame.action==='call'?calls.call({requestId:frame.requestId,to:frame.to},web.busy):calls.status(frame.requestId));
  try {
    assert.equal((await stat(join(directory,'phone.sock'))).mode&0o777,0o600);
    assert.equal((await stat(join(directory,'calls.sqlite'))).mode&0o777,0o600);
    const created=await phoneControl(directory,'call',{requestId:id,to});assert.equal(created.created,true);assert.equal(created.callSid,callSid);
    await assert.rejects(()=>phoneControl(directory,'call',{requestId:'second',to}),/busy/);
    assert.equal((await phoneControl(directory,'call',{requestId:id,to})).created,false);assert.equal(provider.creates,1);
    const inbound=new URLSearchParams({AccountSid:config.accountSid,CallSid:'CA'+'5'.repeat(32),To:config.number});
    assert.match(await (await post(web.port,'/incoming',inbound)).text(),/Reject reason="busy"/);
    const path='/incoming?outbound='+id;
    const wrong=params();wrong.set('To','+15551230003');assert.equal((await post(web.port,path,wrong)).status,403);
    const response=await post(web.port,path,params());assert.equal(response.status,200);
    const ticket=(await response.text()).match(/value="([a-f0-9]+)"/)[1];
    provider.value.status='in-progress';
    ws=new WebSocket(`ws://127.0.0.1:${web.port}/media`,{headers:{'x-twilio-signature':twilioSignature(config.authToken,config.origin+'/media')}});
    const output=[];ws.on('message',raw=>output.push(JSON.parse(raw.toString())));
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    ws.send(JSON.stringify({event:'start',start:{accountSid:config.accountSid,callSid,streamSid,customParameters:{ticket},mediaFormat:{encoding:'audio/x-mulaw',sampleRate:8000,channels:1}}}));
    await wait(()=>audio?.events.some(event=>event.type==='session.start'));
    ws.send(JSON.stringify({event:'media',media:{payload:'//8='}}));await wait(()=>audio.events.some(event=>event.type==='session.input_audio.append'));
    audio.emit('message',Buffer.from(JSON.stringify({type:'session.output_audio.delta',delta:'//8='})));await wait(()=>output.length);
    assert.equal(output[0].media.payload,'//8=');ws.close();await wait(()=>receipt);
    assert.equal(receipt.callSid,callSid);assert.equal(receipt.finalized,true);assert.equal(receipt.inputBytes,2);assert.equal(receipt.outputBytes,2);
    provider.value.status='completed';assert.equal((await post(web.port,path+'&status=1',params('completed'))).status,204);
    assert.equal(calls.pending(),undefined);assert.equal((await phoneControl(directory,'call-status',{requestId:id})).status,'completed');
    assert.equal((await post(web.port,path,params())).status,403);
    assert.equal((await phoneControl(directory,'call',{requestId:id,to})).created,false);assert.equal(provider.creates,1);
  } finally {ws?.terminate();await control.close();await web.close();}
});

test('an outbound answer starts exactly one recording for its Call SID and call-status reports its outcome',async t=>{
  const {directory,provider,calls}=await fixture(t),{requests,provider:twilio}=recorder();let audio,receipt,ws;
  const web=await servePhone(config,{port:0,host:'127.0.0.1',calls,provider:twilio,socketFactory:()=>audio=new AudioProvider(),
    record:async value=>{await writeFile(join(directory,LAST_CALL),JSON.stringify(value));receipt=value;}});
  try {
    await calls.call({requestId:id,to},web.busy);provider.value.status='in-progress';
    const path='/incoming?outbound='+id;
    const ticket=(await (await post(web.port,path,params())).text()).match(/value="([a-f0-9]+)"/)[1];
    ws=new WebSocket(`ws://127.0.0.1:${web.port}/media`,{headers:{'x-twilio-signature':twilioSignature(config.authToken,config.origin+'/media')}});
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    ws.send(JSON.stringify({event:'start',start:{accountSid:config.accountSid,callSid,streamSid,customParameters:{ticket},mediaFormat:{encoding:'audio/x-mulaw',sampleRate:8000,channels:1}}}));
    await wait(()=>audio?.events.some(event=>event.type==='session.start'));
    assert.equal((await calls.status(id)).recording,undefined);
    ws.close();await wait(()=>receipt);
    assert.equal(requests.length,1);assert.equal(requests[0].url,`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls/${callSid}/Recordings.json`);
    assert.equal(requests[0].options.body,'RecordingChannels=dual&RecordingTrack=both');
    assert.deepEqual(receipt.recording,{state:'started',sid:recordingSid});
    assert.deepEqual((await calls.status(id)).recording,{state:'started',sid:recordingSid});
    await writeFile(join(directory,LAST_CALL),JSON.stringify({...receipt,callSid:'CA'+'9'.repeat(32)}));
    assert.equal((await calls.status(id)).recording,undefined);
  } finally {ws?.terminate();await web.close();}
});

test('uncertain creation survives restart and cannot redial under the same or another request ID',async t=>{
  const {directory,provider,calls}=await fixture(t);
  provider.createCall=async()=>{provider.creates++;throw Error('synthetic network loss');};
  await assert.rejects(()=>calls.call({requestId:id,to},()=>false),/unconfirmed/);
  const restarted=new PhoneCalls(directory,config,provider);
  try {
    assert.equal((await restarted.call({requestId:id,to},()=>false)).status,'uncertain');
    await assert.rejects(()=>restarted.call({requestId:'another',to},()=>false),/busy/);
    await assert.rejects(()=>restarted.call({requestId:id,to:'+15551230003'},()=>false),/different destination/);
    assert.equal(provider.creates,1);
    await assert.rejects(()=>restarted.hangup(id),/uncertain/);
  } finally {restarted.close();}
});

test('an abandoned inbound ticket expires without blocking later outbound dialing',async t=>{
  const {provider,calls}=await fixture(t);
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const web=await servePhone(config,{port:0,host:'127.0.0.1',calls});
  try {
    const inbound=new URLSearchParams({AccountSid:config.accountSid,CallSid:callSid,To:config.number});
    assert.equal((await post(web.port,'/incoming',inbound)).status,200);
    await assert.rejects(()=>calls.call({requestId:id,to},web.busy),/busy/);
    now+=61000;
    assert.equal((await calls.call({requestId:id,to},web.busy)).created,true);
    assert.equal(provider.creates,1);
  } finally {await web.close();}
});

test('a signed answer before the create response binds the call without regressing its status',async t=>{
  const {provider,calls}=await fixture(t);let release;
  provider.createCall=()=>{provider.creates++;return new Promise(resolve=>{release=resolve;});};
  const pending=calls.call({requestId:id,to},()=>false);
  assert.equal(calls.accept(id,params(),false),true);
  release(provider.value);assert.equal((await pending).status,'in-progress');assert.equal(provider.creates,1);
  provider.value.status='in-progress';const ended=await calls.hangup(id);
  assert.equal(ended.status,'completed');assert.deepEqual(provider.ends,['completed']);
  assert.equal(calls.pending(),undefined);
});

test('ringing calls cancel explicitly; wrong provider identity never becomes a successful receipt',async t=>{
  const {provider,calls}=await fixture(t);
  await calls.call({requestId:id,to},()=>false);provider.value.status='ringing';
  assert.equal((await calls.hangup(id)).status,'canceled');assert.deepEqual(provider.ends,['canceled']);
  provider.value.account_sid='AC'+'9'.repeat(32);
  await assert.rejects(()=>calls.status(id),/identity/);
  assert.throws(()=>callOptions('call',['--to',to,'--request-id',id,'--to',to]),/Use phone call/);
  assert.throws(()=>callOptions('call',['--to',to,'--request-id','../bad']),/stable request ID/);
});

test('running control socket cannot be replaced, and repeated request remains deduplicated after restart',async t=>{
  const {directory,provider,calls}=await fixture(t);
  const control=await servePhoneControl(directory,frame=>calls.call(frame.options,()=>false));
  try {await assert.rejects(()=>servePhoneControl(directory,()=>{}),/already running/);}
  finally {await control.close();}
  await calls.call({requestId:id,to},()=>false);provider.value.status='completed';await calls.status(id);
  const restarted=new PhoneCalls(directory,config,provider);
  try {assert.equal((await restarted.call({requestId:id,to},()=>false)).created,false);assert.equal(provider.creates,1);}
  finally {restarted.close();}
  await assert.rejects(()=>phoneControl(directory,'call',{requestId:'offline',to}),/unavailable/);
});

test('Twilio create request pins caller ID, existing signed endpoint, Record=false (recording starts on the media stream) and bounded duration',async()=>{
  const requests=[];
  const number=new PhoneNumber(config,async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({sid:callSid}));});
  await number.createCall(to,id);
  const form=new URLSearchParams(requests[0].options.body);
  assert.equal(requests[0].url,`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`);
  assert.equal(form.get('To'),to);assert.equal(form.get('From'),config.number);assert.equal(form.get('Url'),config.origin+'/incoming?outbound='+id);
  assert.equal(form.get('StatusCallback'),form.get('Url')+'&status=1');assert.equal(form.get('TimeLimit'),'180');assert.equal(form.get('Timeout'),'45');assert.equal(form.get('Record'),'false');
  assert.equal(form.has('SmsUrl'),false);
});

test('control shutdown rejects late frames from existing idle clients and waits for admitted work',async t=>{
  const {directory}=await fixture(t);let release;
  const gate=new Promise(resolve=>{release=resolve;}),actions=[];
  const control=await servePhoneControl(directory,async frame=>{actions.push(frame.action);await gate;return {ok:true};});
  const idle=net.connect(join(directory,'phone.sock'));idle.on('error',()=>{});
  await new Promise(resolve=>idle.once('connect',resolve));
  const first=phoneControl(directory,'first',{});await wait(()=>actions.length===1);
  let stopped=false;const closing=control.close().then(()=>{stopped=true;});
  try {
    idle.write(JSON.stringify({action:'late'})+'\n');
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.deepEqual(actions,['first']);assert.equal(stopped,false);
    release();await closing;await first;
    await control.close();assert.equal(stopped,true);
  } finally {release();idle.destroy();await control.close();}
});

test('real phone-number lookup retains inbound preview and restoration fields',async()=>{
  const row={sid:'PN'+'5'.repeat(32),account_sid:config.accountSid,phone_number:config.number,capabilities:{voice:true},voice_url:config.origin+'/incoming',voice_method:'POST',voice_fallback_url:'',voice_fallback_method:'POST',voice_application_sid:'',trunk_sid:''};
  const number=new PhoneNumber(config,async()=>new Response(JSON.stringify({incoming_phone_numbers:[row]})));
  const result=await number.get();
  assert.equal(result.numberSid,row.sid);assert.equal(result.number,config.number);
  assert.deepEqual(result.route,{VoiceUrl:row.voice_url,VoiceMethod:'POST',VoiceFallbackUrl:'',VoiceFallbackMethod:'POST',VoiceApplicationSid:'',TrunkSid:''});
});
