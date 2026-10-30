import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep, setImmediate as tick} from 'node:timers/promises';
import {PhoneAdvice} from '../src/phone-advice.mjs';
import {installedAdvice} from '../src/phone-plugin-tools.mjs';
import {ElevenLabsAdapter} from '../src/phone-providers/elevenlabs.mjs';
import {validatePhoneConfig} from '../src/phone.mjs';
import {EventEmitter} from 'node:events';
import {PhoneAudio} from '../src/phone-audio.mjs';

const advice = {id: 'approved', text: 'Approved example only.', source: 'https://example.com/source', source_revision: 'a'.repeat(64), confidence: 0.9};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
function setup(run, deadlineMs = 100) {
  const sent = [], receipts = [], requests = [];
  const adapter = new ElevenLabsAdapter({advice: true});
  const hook = new PhoneAdvice({call: {id: 'call'}, deadlineMs, adapter, run: (request, signal) => {requests.push({request, signal}); return run(request, signal);},
    send: message => {sent.push(message); return true;}, history: () => [], receipts});
  return {hook, sent, receipts, requests};
}

test('only provider-acknowledged advice precedes the explicit response, then is removed', async () => {
  const s = setup(async () => ({status: 'available', advice}));
  s.hook.begin('utterance'); s.hook.stop('utterance'); s.hook.final('utterance', 'I am not ready yet.');
  await tick();
  assert.equal(s.sent.length, 1); assert.equal(s.sent[0].type, 'conversation.item.create');
  s.hook.acknowledged(s.sent[0].item.id);
  assert.equal(s.sent[1].type, 'response.create');
  assert.equal(s.receipts[0].status, 'accepted_before_response');
  assert.equal(s.receipts[0].source_revision, advice.source_revision);
  assert.ok(!JSON.stringify(s.receipts).includes(advice.text));
  s.hook.responseStarted('response-current');
  s.hook.responseDone('response-old'); assert.equal(s.sent.length, 2);
  s.hook.responseDone('response-current'); assert.equal(s.sent.at(-1).type, 'conversation.item.delete'); s.hook.cancel();
});

test('late A cannot overwrite B or send advice to another call', async () => {
  const a = deferred(), b = deferred();
  const s = setup(r => r.text === 'A' ? a.promise : b.promise);
  s.hook.begin('a'); s.hook.final('a', 'A'); await tick();
  s.hook.begin('b'); s.hook.final('b', 'B'); await tick();
  assert.equal(s.requests[0].signal.aborted, true);
  b.resolve({status: 'available', advice: {...advice, id: 'B'}}); await tick();
  a.resolve({status: 'available', advice: {...advice, id: 'A'}}); await tick();
  assert.equal(s.sent.filter(m => m.type === 'conversation.item.create').length, 1);
  s.hook.acknowledged(s.sent[0].item.id); assert.equal(s.receipts.at(-1).id, 'B');
  const other = setup(async () => ({status: 'no_match'})); other.hook.begin('other'); other.hook.final('other', 'other'); await tick();
  assert.equal(other.receipts.at(-1).status, 'no_match'); assert.equal(s.receipts.at(-1).id, 'B');
  s.hook.cancel(); other.hook.cancel();
});

test('a corrected final transcript invalidates its earlier classifier result', async () => {
  const first = deferred(); const s = setup(r => r.revision === 1 ? first.promise : Promise.resolve({status: 'available', advice}));
  s.hook.begin('a'); s.hook.final('a', 'I am selling'); await tick();
  s.hook.final('a', 'I am NOT selling'); await tick();
  first.resolve({status: 'available', advice: {...advice, id: 'obsolete'}}); await tick();
  assert.equal(s.requests[1].request.text, 'I am NOT selling');
  assert.equal(s.sent.length, 1); s.hook.acknowledged(s.sent[0].item.id);
  assert.equal(s.receipts.at(-1).revision, 2); s.hook.cancel();
});

test('deadline and missing acknowledgement resume speech once, never inject late', async () => {
  const waiting = deferred(); const s = setup(() => waiting.promise, 15);
  s.hook.begin('a'); s.hook.stop('a'); s.hook.final('a', 'hello');
  await sleep(30); assert.deepEqual(s.sent.map(m => m.type), ['response.create']);
  waiting.resolve({status: 'available', advice}); await tick(); assert.equal(s.sent.length, 1);
  const ack = setup(async () => ({status: 'available', advice}), 15);
  ack.hook.begin('a'); ack.hook.final('a', 'hello'); await sleep(30);
  assert.deepEqual(ack.sent.map(m => m.type), ['conversation.item.create','conversation.item.delete','response.create']);
  ack.hook.acknowledged(ack.sent[0].item.id); assert.equal(ack.sent.length, 3);
  s.hook.cancel(); ack.hook.cancel();
});

test('closure and an early provider response prevent a second generation', async () => {
  const waiting = deferred(), s = setup(() => waiting.promise);
  s.hook.begin('a'); s.hook.final('a', 'hello'); await tick(); s.hook.cancel();
  waiting.resolve({status: 'available', advice}); await tick(); assert.equal(s.sent.length, 0);
  const early = setup(() => new Promise(() => {})); early.hook.begin('a'); early.hook.stop('a'); early.hook.responseStarted();
  assert.equal(early.sent.length, 0); assert.equal(early.receipts.at(-1).status, 'provider_started_early'); early.hook.cancel();
});

test('installed advice binds call, turn and transcript revision and accepts no arbitrary actions', async () => {
  const request = {call: {id: 'origin'}, turn: 2, revision: 3}; let params;
  const core = {request: async (_, p) => {params = p; return {code: 0, stdout: JSON.stringify({call_id: 'origin', turn: 2, revision: 3, status: 'available', advice, tools: ['send_sms']})};}};
  const binding = {alias: 'quarre-advice', invoke: ['evaluate','-'], deadlineMs: 500};
  const out = await installedAdvice(binding, core).run(request);
  assert.deepEqual(params.args, binding.invoke); assert.equal(JSON.parse(params.stdin).revision, 3); assert.equal(out.tools, undefined);
  await assert.rejects(installedAdvice(binding, core).run({...request, revision: 4}), /binding mismatch/);
});

test('advice is explicit per line and unsupported speech providers refuse activation', () => {
  const config = {accountSid: 'AC'+'a'.repeat(32), authToken: 'a'.repeat(32), origin: 'https://example.com',
    number: '+15551230002', apiKey: 'sk_'+'a'.repeat(32), provider: 'elevenlabs', advice: true};
  assert.throws(() => validatePhoneConfig(config), /adviceBinding/);
  config.adviceBinding = {alias: 'quarre-advice', invoke: ['evaluate','-'], deadlineMs: 500};
  assert.equal(validatePhoneConfig(config).advice, true);
  assert.equal(new ElevenLabsAdapter(config).configure().session.audio.input.turn_detection.create_response, false);
  assert.throws(() => validatePhoneConfig({...config, provider: 'openai', apiKey: 'sk-'+'a'.repeat(32)}), /ElevenLabs/);
});

test('the phone bridge carries finalized speech through advice acknowledgement into one provider response', async () => {
  let socket, mint;
  const events = [], finished = [];
  const twilio = {readyState: 1, bufferedAmount: 0, send() {}, close() {this.readyState = 3;}};
  const audio = new PhoneAudio(twilio, {provider: 'elevenlabs', apiKey: 'synthetic', model: 'eleven_realtime_v1_max',
    voice: 'brian', advice: true, call: {id:'call'}, streamSid: 'MZ'+'1'.repeat(32),
    advisor: {deadlineMs: 100, run: async () => ({status:'available',advice})}}, stats => finished.push(stats), {
    fetch: async (_, options) => {mint=JSON.parse(options.body);return new Response(JSON.stringify({value:'synthetic-session'}));},
    socketFactory: () => socket=Object.assign(new EventEmitter(), {readyState:1,bufferedAmount:0,
      send: raw => events.push(JSON.parse(raw)),close() {this.readyState=3;this.emit('close',1000);},terminate() {this.close();}}),
  });
  await tick(); assert.equal(mint.session.audio.input.turn_detection.create_response,false);
  const event=e=>socket.emit('message',Buffer.from(JSON.stringify(e)));
  event({type:'session.updated'});
  event({type:'input_audio_buffer.speech_started',item_id:'utterance'});
  event({type:'input_audio_buffer.speech_stopped',item_id:'utterance'});
  event({type:'conversation.item.input_audio_transcription.completed',item_id:'utterance',transcript:'Not now, maybe later.'});
  await tick(); const note=events.find(e=>e.type==='conversation.item.create');assert.ok(note);
  assert.equal(events.filter(e=>e.type==='response.create').length,0);
  event({type:'conversation.item.created',item:{id:note.item.id}});
  assert.equal(events.filter(e=>e.type==='response.create').length,1);
  event({type:'response.created',response:{id:'response-current'}});
  event({type:'response.done',response:{id:'older-response'}});
  assert.equal(events.filter(e=>e.type==='conversation.item.delete').length,0);
  event({type:'response.done',response:{id:'response-current'}});
  assert.equal(events.filter(e=>e.type==='conversation.item.delete').length,1);
  await audio.close();assert.equal(finished[0].advice[0].status,'accepted_before_response');
  assert.equal(finished[0].transcript[0].text,'Not now, maybe later.');
  assert.ok(!JSON.stringify(finished[0]).includes(advice.text));
});
