import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import WebSocket from 'ws';
import {PhoneAudio} from '../src/phone-audio.mjs';
import {PhoneAdvice, MAX_NOTES} from '../src/phone-advice.mjs';
import {installedAdvice} from '../src/phone-plugin-tools.mjs';
import {validatePhoneConfig} from '../src/phone.mjs';
import {createAdapter} from '../src/phone-providers/index.mjs';

const base = {accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com', instructions: 'Synthetic coach test'};
const keys = {openai: 'sk-synthetic123456789', deepgram: 'c'.repeat(40), llmApiKey: 'AIza' + 'b'.repeat(35), ttsApiKey: 'sk_' + 'a'.repeat(24)};
const advice = (id = 'timing') => ({id, text: `Approved example ${id}.`, source: 'https://example.com/source', source_revision: 'a'.repeat(64), confidence: 0.9});
const binding = {alias: 'advice', invoke: ['evaluate', '-'], deadlineMs: 2000};
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; events = [];
  constructor() {super(); setImmediate(() => this.emit('open'));}
  send(raw) {this.events.push(Buffer.isBuffer(raw) ? raw : JSON.parse(raw));}
  receive(event) {this.emit('message', Buffer.from(JSON.stringify(event)));}
  close() {this.readyState = WebSocket.CLOSED; this.emit('close', 1000);}
  terminate() {this.close();}
}
function bridge(provider, run, settings = {}) {
  let socket; const finished = [], requests = [];
  const twilio = {readyState: WebSocket.OPEN, bufferedAmount: 0, send() {}, close() {this.readyState = WebSocket.CLOSED;}};
  const audio = new PhoneAudio(twilio, {...base, provider, apiKey: keys[provider], ...(provider === 'deepgram' && {llmApiKey: keys.llmApiKey, ttsApiKey: keys.ttsApiKey}),
    streamSid: 'MZ' + '4'.repeat(32), call: {id: 'CA' + '9'.repeat(32)}, advisor: {deadlineMs: 2000, run: (request, signal) => { requests.push(request); return run(request, signal); }}, ...settings},
    async stats => { finished.push(stats); }, {socketFactory: () => socket = new FakeSocket()});
  return {audio, finished, requests, socket: () => socket};
}

test('Deepgram: a note for a finished caller utterance joins the prompt when the caller next speaks, never mid-reply', async () => {
  const c = bridge('deepgram', async () => ({status: 'available', advice: advice()}));
  try {
    await tick();
    c.socket().receive({type: 'ConversationText', role: 'user', content: 'Not now, maybe next year.'});
    await tick();
    assert.equal(c.requests[0].text, 'Not now, maybe next year.');
    assert.deepEqual(c.requests[0].history, []);
    await tick(); await tick();
    // The model is answering: the ready note waits for the caller's next turn.
    assert(!c.socket().events.some(e => e.type === 'UpdatePrompt'));
    c.socket().receive({type: 'ConversationText', role: 'assistant', content: 'No rush at all.'});
    c.socket().receive({type: 'UserStartedSpeaking'});
    const notes = c.socket().events.filter(e => e.type === 'UpdatePrompt');
    assert.equal(notes.length, 1);
    assert.match(notes[0].prompt, /Coach note 1, replacing any earlier coach note/);
    assert.match(notes[0].prompt, /Approved example timing\./);
    // The coach sends context only: no response, injected user turn or agent speech.
    assert(!c.socket().events.some(e => ['InjectUserMessage', 'InjectAgentMessage', 'response.create'].includes(e.type)));
    c.socket().receive({type: 'PromptUpdated'});
    c.socket().receive({type: 'ConversationText', role: 'user', content: 'What would you pay?'});
    await tick();
    assert.deepEqual(c.requests[1].history, [{who: 'caller', text: 'Not now, maybe next year.'}, {who: 'model', text: 'No rush at all.'}]);
    await c.audio.close();
    const [first] = c.finished[0].advice;
    assert.equal(first.status, 'sent'); assert.equal(first.acknowledged, true); assert.equal(first.source_revision, 'a'.repeat(64));
    assert(!JSON.stringify(c.finished[0].advice).includes('Approved example'));
  } finally { await c.audio.close(); }
});

test('GPT-Live: the caller utterance is complete when the model answers; the note is silent thinking context', async () => {
  const c = bridge('openai', async () => ({status: 'available', advice: advice()}));
  try {
    await tick();
    c.socket().receive({type: 'session.input_transcript.delta', delta: 'I already have '});
    c.socket().receive({type: 'session.input_transcript.delta', delta: 'a broker.'});
    assert.equal(c.requests.length, 0);
    c.socket().receive({type: 'session.output_transcript.delta', delta: 'Understood.'});
    c.socket().receive({type: 'session.output_transcript.delta', delta: ' Thanks.'});
    await tick();
    assert.equal(c.requests.length, 1);
    assert.equal(c.requests[0].text, 'I already have a broker.');
    await tick(); await tick();
    assert(!c.socket().events.some(e => e.type === 'session.thinking.append'));
    c.socket().receive({type: 'session.input_transcript.delta', delta: 'So what now?'});
    const note = c.socket().events.find(e => e.type === 'session.thinking.append');
    assert.equal(note.delegation_id, null); assert.match(note.event_id, /^adv_[a-f0-9]{24}$/);
    assert.match(note.content, /Approved example timing\./);
    assert(!c.socket().events.some(e => e.type === 'response.create' && c.socket().events.indexOf(e) > c.socket().events.indexOf(note)));
    c.socket().receive({type: 'session.thinking.appended', client_event_id: note.event_id});
    const closed = c.audio.close(); c.socket().receive({type: 'session.closed'}); await closed;
    assert.equal(c.finished[0].advice[0].acknowledged, true);
  } finally { await c.audio.close(); }
});

function coach(run, {deadlineMs = 2000, room = Infinity, maxAdviceNote = 4000} = {}) {
  const sent = [], receipts = [];
  const adapter = {constructor: {maxAdviceNote}, adviceRoom: () => room, adviceMessages: note => [{note}]};
  return {hook: new PhoneAdvice({call: {id: 'call'}, run, deadlineMs, adapter, send: m => sent.push(m), receipts}), sent, receipts};
}

test('the latest utterance wins: a pick a newer one overtook is dropped and the same pick is not added twice', async () => {
  const a = deferred(), b = deferred(), c = deferred();
  const s = coach(r => ({A: a, B: b, C: c})[r.text].promise);
  s.hook.heard('A', []); s.hook.heard('B', []);
  b.resolve({status: 'available', advice: advice('broker')}); await tick(); await tick();
  a.resolve({status: 'available', advice: advice('timing')}); await tick(); await tick();
  assert.equal(s.sent.length, 0); // ready, waiting for the caller to speak
  s.hook.callerStarted();
  assert.equal(s.sent.length, 1); assert.match(s.sent[0].note, /broker/);
  assert.deepEqual(s.receipts.map(r => r.status), ['superseded', 'sent']);
  s.hook.heard('C', []); await tick(); // still pending
  const again = coach(async () => ({status: 'available', advice: advice('broker')}));
  again.hook.heard('one', []); await tick(); await tick(); again.hook.callerStarted();
  again.hook.heard('two', []); await tick(); await tick();
  assert.deepEqual(again.receipts.map(r => r.status), ['sent', 'unchanged']);
  // a ready note the caller never answered is replaced by the newer one, or left undelivered at the end
  const waiting = coach(async r => ({status: 'available', advice: advice(r.text)}));
  waiting.hook.heard('first', []); await tick(); await tick(); waiting.hook.heard('second', []); await tick(); await tick();
  waiting.hook.close();
  assert.deepEqual(waiting.receipts.map(r => r.status), ['superseded', 'undelivered']); assert.equal(waiting.sent.length, 0);
  // a note ready while the caller is already speaking goes at once
  const talking = coach(async () => ({status: 'available', advice: advice()}));
  talking.hook.heard('one', []); talking.hook.callerStarted(); await tick(); await tick();
  assert.equal(talking.sent.length, 1);
  s.hook.close(); assert.equal(s.receipts.at(-1).status, 'closed');
});

test('a slow or failed lookup and a closed call add nothing; notes stay within the provider budget', async () => {
  const slow = coach((_, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))), {deadlineMs: 20});
  slow.hook.heard('hello', []); await new Promise(r => setTimeout(r, 40));
  assert.equal(slow.receipts[0].status, 'timeout'); assert.equal(slow.sent.length, 0);
  const late = deferred(), closed = coach(() => late.promise);
  closed.hook.heard('hello', []); closed.hook.close();
  late.resolve({status: 'available', advice: advice()}); await tick(); await tick();
  assert.equal(closed.sent.length, 0); assert.equal(closed.receipts[0].status, 'closed');
  const failed = coach(async () => { throw Error('down'); }); failed.hook.heard('hello', []); await tick(); await tick();
  assert.equal(failed.receipts[0].status, 'unavailable');
  const tight = coach(async () => ({status: 'available', advice: advice()}), {room: 50});
  tight.hook.heard('hello', []); await tick(); await tick(); tight.hook.callerStarted(); assert.equal(tight.receipts[0].status, 'no_room');
  const long = coach(async () => ({status: 'available', advice: advice()}), {maxAdviceNote: 50});
  long.hook.heard('hello', []); await tick(); await tick(); long.hook.callerStarted(); assert.equal(long.receipts[0].status, 'too_long');
  let n = 0; const many = coach(async () => ({status: 'available', advice: advice(`pick${n++}`)}));
  for (let i = 0; i <= MAX_NOTES; i++) { many.hook.heard(`turn ${i}`, []); await tick(); await tick(); many.hook.callerStarted(); }
  assert.equal(many.sent.length, MAX_NOTES); assert.equal(many.receipts.at(-1).status, 'no_room');
  assert.equal(createAdapter({...base, provider: 'deepgram', apiKey: keys.deepgram, ...keys, instructions: 'x'.repeat(24000)}).adviceRoom(), 1000);
});

test('the installed command is bound to the call and turn and returns only an approved note', async () => {
  let params; const request = {call: {id: 'origin'}, turn: 2};
  const core = {request: async (_, p) => { params = p; return {code: 0, stdout: JSON.stringify({call_id: 'origin', turn: 2, status: 'available', advice: advice(), tools: ['send_sms']})}; }};
  const out = await installedAdvice(binding, core).run(request);
  assert.deepEqual(params.args, binding.invoke); assert.equal(JSON.parse(params.stdin).turn, 2);
  assert.deepEqual(Object.keys(out.advice).sort(), ['confidence', 'id', 'source', 'source_revision', 'text']); assert.equal(out.tools, undefined);
  await assert.rejects(installedAdvice(binding, core).run({...request, turn: 3}), /binding mismatch/);
  assert.throws(() => installedAdvice({...binding, deadlineMs: 100}, core), /advice binding/);
});

test('advice is explicit per line, needs the installed binding and a provider that takes added context', () => {
  const line = {...base, provider: 'deepgram', apiKey: keys.deepgram, llmApiKey: keys.llmApiKey, ttsApiKey: keys.ttsApiKey, advice: true};
  assert.throws(() => validatePhoneConfig(line), /adviceBinding/);
  assert.equal(validatePhoneConfig({...line, adviceBinding: binding}).advice, true);
  assert.equal(validatePhoneConfig({...base, provider: 'openai', apiKey: keys.openai, advice: true, adviceBinding: binding}).advice, true);
  assert.throws(() => validatePhoneConfig({...base, provider: 'elevenlabs', apiKey: 'sk_' + 'a'.repeat(24), advice: true, adviceBinding: binding}), /openai, deepgram/);
  assert.equal(validatePhoneConfig({...line, advice: false, adviceBinding: binding}).advice, false);
});
