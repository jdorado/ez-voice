import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import WebSocket from 'ws';
import {PhoneAudio} from '../src/phone-audio.mjs';
import {PhoneAdvice, FULL_HISTORY} from '../src/phone-advice.mjs';
import {installedAdvice} from '../src/phone-plugin-tools.mjs';
import {validatePhoneConfig} from '../src/phone.mjs';
import {createAdapter} from '../src/phone-providers/index.mjs';
import {pcmToUlaw} from '../src/phone-providers/g711.mjs';
import {realtimeCatch} from '../src/phone-voicemail.mjs';

// ElevenLabs Realtime lines with the opt-in options: early and immediate coach notes, the Flux sidecar, the guards on the model's
// words, the machine screen, advice ends and the session settings. Synthetic sockets and data only.
const base = {accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com', instructions: 'Synthetic arm test',
  provider: 'elevenlabs', model: 'eleven_realtime_v1_max', apiKey: 'sk_' + 'a'.repeat(24)};
const deepgramKey = 'd'.repeat(40);
const streamSid = 'MZ' + '4'.repeat(32);
const REALTIME = 'wss://api.elevenlabs.io/v1/convai/realtime';
const HINT = 'he did not ask whether you are an AI: do not say you are an assistant or an AI; say who you are and go on';
const wait = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('Timed out'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const note = (id, text = `Approved note ${id}.`, extra = {}) => ({status: 'available', advice: {id, text, source: 'https://example.com/source', source_revision: 'a'.repeat(64), confidence: 0.9, ...extra}});
const loud = () => pcmToUlaw(Int16Array.from({length: 160}, (_, i) => Math.round(12000 * Math.sin(2 * Math.PI * 300 * i / 8000)))).toString('base64');
const mint = async () => new Response(JSON.stringify({value: 'client_secret_synthetic', expires_at: 1}), {status: 200});

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING; bufferedAmount = 0; events = [];
  constructor(url, options) { super(); this.url = url; this.options = options; setImmediate(() => { this.readyState = WebSocket.OPEN; this.emit('open'); }); }
  send(raw) { this.events.push(Buffer.isBuffer(raw) ? raw : JSON.parse(raw)); }
  receive(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1000); }
  terminate() { this.close(); }
}

// One ElevenLabs call, its session ready; `run` answers the side coach (advice lines).
async function call(settings = {}, {run} = {}) {
  const sockets = [], finished = [];
  const twilio = Object.assign(new EventEmitter(), {readyState: WebSocket.OPEN, bufferedAmount: 0, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { this.readyState = WebSocket.CLOSED; }});
  const audio = new PhoneAudio(twilio, {...base, streamSid, idleSeconds: 0, call: {id: 'CA' + '9'.repeat(32), direction: 'in'}, ...settings, ...(run && {advisor: {deadlineMs: 2000, run}})},
    async stats => { finished.push(stats); }, {socketFactory: (url, options) => { const s = new FakeSocket(url, options); sockets.push(s); return s; }, fetch: mint});
  const rt = () => sockets.find(s => s.url === REALTIME), side = () => sockets.find(s => s.url.startsWith('wss://api.deepgram.com/'));
  await wait(() => rt()?.readyState === WebSocket.OPEN);
  rt().receive({type: 'session.created'}); rt().receive({type: 'session.updated'});
  const sent = type => rt().events.filter(e => e.type === type);
  const said = transcript => rt().receive({type: 'conversation.item.input_audio_transcription.completed', transcript});
  const heard = (transcript, event = 'Update') => side().receive({type: 'TurnInfo', event, transcript});
  const reply = (id, item = `item_${id}`) => { rt().receive({type: 'response.created', response: {id}}); rt().receive({type: 'response.output_audio.delta', response_id: id, item_id: item, delta: Buffer.alloc(800, 0x55).toString('base64')}); };
  const words = (id, delta) => rt().receive({type: 'response.output_audio_transcript.delta', response_id: id, delta});
  const end = async () => { audio.close('test'); return audio.done; };
  return {audio, twilio, sockets, finished, rt, side, sent, said, heard, reply, words, end};
}

test('the ElevenLabs options are validated, apply to elevenlabs only and keep today\'s session unless set', () => {
  const binding = {alias: 'advice', invoke: ['evaluate', '-'], deadlineMs: 2000};
  const arm = {...base, advice: true, adviceBinding: binding, adviceEarly: true, sidecar: 'flux-general-en', sidecarApiKey: deepgramKey, toolGuard: true,
    voicemailCatch: true, aiGuard: HINT, speed: 0.88, turnDetection: 'server'};
  const ok = validatePhoneConfig(arm);
  for (const k of ['adviceEarly', 'sidecar', 'toolGuard', 'voicemailCatch', 'aiGuard', 'speed', 'turnDetection']) assert.deepEqual(ok[k], arm[k]);
  for (const bad of [{sidecar: 'nova-3'}, {sidecarApiKey: undefined}, {sidecar: undefined, adviceEarly: false}, {sidecarApiKey: 'short'}, {adviceEarly: 'yes'},
    {advice: false}, {toolGuard: 1}, {voicemailCatch: 'on'}, {aiGuard: ''}, {aiGuard: 'line\nbreak'}, {aiGuard: 'x'.repeat(501)}, {speed: 0.5}, {speed: 1.3}, {speed: '0.9'}, {turnDetection: 'none'}])
    assert.throws(() => validatePhoneConfig({...arm, ...bad}), undefined, JSON.stringify(bad));
  assert.throws(() => validatePhoneConfig({...arm, adviceEarly: true, sidecar: undefined, sidecarApiKey: undefined}), /adviceEarly needs advice and a sidecar/);
  const deepgram = {...base, provider: 'deepgram', model: undefined, apiKey: deepgramKey, llmApiKey: 'AIza' + 'b'.repeat(35), ttsApiKey: 'sk_' + 'a'.repeat(24)};
  for (const k of [{toolGuard: true}, {speed: 1}, {turnDetection: 'server'}, {voicemailCatch: true}, {aiGuard: HINT}])
    assert.throws(() => validatePhoneConfig({...deepgram, ...k}), /apply to provider elevenlabs only/);
  // the session: today's turn detection and no speed unless the line sets them
  const today = createAdapter(base).configure().session.audio;
  assert.deepEqual(today.input.turn_detection, {type: 'semantic_vad', interrupt_response: false}); assert.equal(today.output.speed, undefined);
  const set = createAdapter({...base, speed: 0.88, turnDetection: 'server'}).configure().session.audio;
  assert.equal('turn_detection' in set.input, false); assert.equal(set.output.speed, 0.88);
  assert.deepEqual(createAdapter(base).parse({type: 'response.created', response: {id: 'r1'}}), [], 'an unguarded line is told nothing new');
});

test('a coach note goes in as a system item the moment it is ready, with no reply asked for, and waits for a pending tool', async () => {
  const requests = [];
  let release;
  const information = {deadlineMs: 2000, tools: [{name: 'read_record'}], run: () => new Promise(r => { release = r; })};
  const c = await call({information}, {run: async r => { requests.push(r); return note(`n${r.turn}`); }});
  try {
    c.said('Not now, maybe next year.');
    await wait(() => c.sent('conversation.item.create').length === 1);
    assert.deepEqual(c.sent('conversation.item.create')[0].item, {type: 'message', role: 'system', content: [{type: 'input_text', text: 'Approved note n1.'}]});
    assert.equal(c.sent('response.create').length, 0, 'the note is context for the next reply, nobody\'s turn');
    assert.equal(requests[0].text, 'Not now, maybe next year.'); assert.equal(requests[0].partial, undefined);
    // a tool call is pending: the next note waits for its end
    c.rt().receive({type: 'response.output_item.done', item: {type: 'function_call', call_id: 'call_1', name: 'read_record', arguments: '{}'}});
    c.said('What would you pay?');
    await wait(() => requests.length === 2); await sleep(20);
    assert.equal(c.sent('conversation.item.create').length, 1, 'held while the tool runs');
    release({call_id: c.audio.config.call.id, turn: c.audio.turn, status: 'ok'});
    await wait(() => c.sent('conversation.item.create').length === 3); // the tool's output, then the held note
    assert.equal(c.sent('conversation.item.create').at(-1).item.content[0].text, 'Approved note n2.');
    const receipt = await c.end();
    assert.deepEqual(receipt.advice.map(a => a.status), ['sent', 'sent']);
    assert(!JSON.stringify(receipt.advice).includes('Approved note'));
  } finally { await c.end(); }
});

test('a full line sends the whole call, bounded to 80 turns of 1,000 characters and 56,000 bytes', async () => {
  const requests = [];
  const advice = new PhoneAdvice({call: {id: 'CA1'}, deadlineMs: 1000, receipts: [], full: true, run: async r => { requests.push(r); return {status: 'no_match'}; }});
  const history = Array.from({length: 120}, (_, i) => ({who: i % 2 ? 'model' : 'caller', text: `${i} `.padEnd(1500, 'é')}));
  advice.heard('And the roof?', history);
  advice.heard('Short call.', history.slice(-10));
  await wait(() => requests.length === 2);
  const [big, small] = requests;
  assert(big.history.length < 80 && Buffer.byteLength(JSON.stringify(big)) <= FULL_HISTORY.bytes, `${big.history.length} turns, ${Buffer.byteLength(JSON.stringify(big))} bytes`);
  assert(big.history.every(t => t.text.length === FULL_HISTORY.chars)); assert(big.history.at(-1).text.startsWith('é') && history.at(-1).text.endsWith(big.history.at(-1).text), 'the newest turns are kept');
  assert.equal(small.history.length, 10, 'a short call goes whole');
  advice.close();
  // an ordinary line keeps the last six turns
  const plain = []; const six = new PhoneAdvice({call: {id: 'CA1'}, deadlineMs: 1000, receipts: [], run: async r => { plain.push(r); return {status: 'no_match'}; }});
  six.heard('Hi.', history); await wait(() => plain.length); assert.equal(plain[0].history.length, 6); six.close();
});

test('early notes: the sidecar\'s provisional words go once a turn with partial, and the final\'s note goes in only when it differs', async () => {
  const requests = [], answers = {1: 'Note A.', 2: 'Note A.', 3: 'Note B.', 4: 'Note C.'};
  const c = await call({sidecar: 'flux-general-en', sidecarApiKey: deepgramKey, adviceEarly: true}, {run: async r => { requests.push(r); return note(`n${r.turn}`, answers[r.turn]); }});
  try {
    await wait(() => c.side()?.readyState === WebSocket.OPEN);
    c.heard('I might'); // under four words
    c.heard('I might sell next'); c.heard('I might sell next spring if');
    await wait(() => c.sent('conversation.item.create').length === 1);
    assert.equal(requests.length, 1); assert.deepEqual([requests[0].text, requests[0].partial], ['I might sell next', true]);
    c.said('I might sell next spring if the price is right.');
    await wait(() => requests.length === 2); await sleep(20);
    assert.equal(requests[1].partial, undefined);
    assert.equal(c.sent('conversation.item.create').length, 1, 'the same note is not sent twice');
    c.heard('What do you think it', 'EagerEndOfTurn'); // the next turn: a new early note
    await wait(() => c.sent('conversation.item.create').length === 2);
    c.said('What do you think it is worth?');
    await wait(() => c.sent('conversation.item.create').length === 3);
    assert.deepEqual(c.sent('conversation.item.create').map(e => e.item.content[0].text), ['Note A.', 'Note B.', 'Note C.']);
    const receipt = await c.end();
    assert.deepEqual(receipt.advice.map(a => [a.status, a.partial ?? false]), [['sent', true], ['unchanged', false], ['sent', true], ['sent', false]]);
  } finally { await c.end(); }
});

test('the Flux sidecar hears the caller as Twilio sends them, never feeds the session, and its failure ends nothing', async () => {
  const c = await call({sidecar: 'flux-general-en', sidecarApiKey: deepgramKey});
  try {
    const url = new URL(c.side().url);
    assert.equal(url.origin + url.pathname, 'wss://api.deepgram.com/v2/listen');
    assert.deepEqual(Object.fromEntries(url.searchParams), {model: 'flux-general-en', encoding: 'mulaw', sample_rate: '8000', eager_eot_threshold: '0.5'});
    assert.deepEqual(c.side().options.headers, {Authorization: `Token ${deepgramKey}`});
    const frame = loud();
    c.audio.input(frame); c.audio.input(frame);
    await wait(() => c.side().events.length === 2);
    assert(c.side().events.every(e => Buffer.isBuffer(e) && e.equals(Buffer.from(frame, 'base64'))));
    c.heard('this is only for the sidecar'); c.heard('this is only for the sidecar', 'EndOfTurn');
    await sleep(10);
    assert(!JSON.stringify(c.rt().events).includes('only for the sidecar'), 'the session never gets the sidecar\'s words');
    c.side().emit('close', 1011);
    await sleep(10);
    assert.equal(c.audio.usable, true);
    const receipt = await c.end();
    assert.deepEqual(receipt.sidecar, {status: 'failed', error: 'WS_1011', interim: 1, final: 1});
  } finally { await c.end(); }
  const clean = await call({sidecar: 'flux-general-en', sidecarApiKey: deepgramKey});
  await wait(() => clean.side()?.readyState === WebSocket.OPEN);
  const receipt = await clean.end();
  assert.deepEqual(clean.side().events.at(-1), {type: 'CloseStream'}); assert.equal(receipt.sidecar.status, 'closed');
});

test('toolGuard: a reply that speaks a tool call loses its unplayed audio and words, uncancelled, and its function call still comes', async () => {
  const c = await call({toolGuard: true});
  try {
    c.reply('r1');
    assert.equal(c.twilio.sent.filter(m => m.event === 'media').length, 1);
    c.words('r1', 'Have a great day. [end'); c.words('r1', '_call]');
    assert.equal(c.twilio.sent.at(-1).event, 'clear', 'what Twilio still had queued is dropped');
    assert.equal(c.sent('response.cancel').length, 0, 'never cancelled');
    c.rt().receive({type: 'response.output_audio.delta', response_id: 'r1', item_id: 'item_r1', delta: Buffer.alloc(800, 0x55).toString('base64')});
    c.words('r1', ' Goodbye.');
    assert.equal(c.twilio.sent.filter(m => m.event === 'media').length, 1, 'no more of its audio plays');
    c.rt().receive({type: 'response.output_item.done', item: {type: 'function_call', call_id: 'call_1', name: 'end_call', arguments: '{}'}});
    assert.equal(c.sent('conversation.item.create').at(-1).item.type, 'function_call_output', 'end_call ran');
    // the next reply starts clean; delivery tags are cut from the words
    c.reply('r2'); c.words('r2', 'Sure [calm] thing, [ca'); c.words('r2', 'lm] bye.');
    const receipt = await c.end();
    assert.deepEqual(receipt.transcript.map(t => t.text), ['Have a great day. Sure  thing,  bye.']); // the streaming stripper leaves the spaces
    assert.equal(receipt.toolGuard.length, 1); assert.equal(receipt.tagsStripped, 2); assert.deepEqual(receipt.tools, ['end_call']);
  } finally { await c.end(); }
});

test('aiGuard: a volunteered AI admission is cancelled and the model asked again in its own words, once a turn; a caller who asked is answered', async () => {
  const c = await call({aiGuard: HINT});
  try {
    c.said('Hi, who is this?');
    c.reply('r1'); c.words('r1', 'Hi, this is Sharon. I am calling about your'); c.words('r1', ' house. I\'m a digital assistant');
    assert.deepEqual(c.rt().events.slice(-4).map(e => e.type), ['response.cancel', 'conversation.item.truncate', 'conversation.item.create', 'response.create']);
    assert.deepEqual(c.sent('conversation.item.create').at(-1).item, {type: 'message', role: 'system', content: [{type: 'input_text',
      text: `System: ${HINT}. Say it in your own words. You already said: "Hi, this is Sharon. I am calling about your house.". Continue from there in one short line; never repeat what you already said.`}]});
    assert.equal(c.twilio.sent.at(-1).event, 'clear');
    c.words('r1', ' on the team.'); // the cancelled reply's last words are not kept
    c.reply('r2'); c.words('r2', 'I\'m a digital assistant, sorry.'); // the re-ask's own reply is not watched again
    assert.equal(c.sent('response.cancel').length, 1);
    c.reply('r3'); c.words('r3', 'As a virtual assistant I');
    assert.equal(c.sent('response.cancel').length, 2, 'the next turn is watched again');
    const receipt = await c.end();
    assert.equal(receipt.aiGuard.length, 2);
    assert(!receipt.transcript.some(t => t.text.includes('on the team')));
  } finally { await c.end(); }
  const asked = await call({aiGuard: HINT});
  asked.said('Wait, are you a robot?');
  asked.reply('r1'); asked.words('r1', 'I\'m Sharon, a digital assistant on the team.');
  assert.equal(asked.sent('response.cancel').length, 0);
  await asked.end();
});

test('voicemailCatch: a machine in the callee\'s first two utterances ends a placed call at once; later turns and inbound calls are not screened', async () => {
  const out = {call: {id: 'CA' + '8'.repeat(32), direction: 'out'}, voicemailCatch: true};
  const mail = await call({...out, sidecar: 'flux-general-en', sidecarApiKey: deepgramKey});
  mail.rt().receive({type: 'input_audio_buffer.speech_started'});
  mail.heard('Hello?'); mail.heard('Hello? You have reached the voicemail of John, please leave a message after the tone');
  let receipt = await mail.audio.done;
  assert.deepEqual([receipt.reason, receipt.machine], ['voicemail', 'voicemail']); assert(receipt.voicemailMs >= 0);
  const screen = await call(out); // no sidecar: the provider's transcript of each utterance
  screen.rt().receive({type: 'input_audio_buffer.speech_started'}); screen.said('Hi.');
  screen.rt().receive({type: 'input_audio_buffer.speech_started'});
  screen.said('The person you are calling is using a screening service. Go ahead and say your name and the reason for your call.');
  receipt = await screen.audio.done;
  assert.deepEqual([receipt.reason, receipt.machine], ['screener', 'screener']);
  const third = await call(out);
  for (const said of ['Hello?', 'Yes, this is Dave.']) { third.rt().receive({type: 'input_audio_buffer.speech_started'}); third.said(said); }
  third.rt().receive({type: 'input_audio_buffer.speech_started'}); third.said('Please leave a message after the tone.');
  await sleep(20); assert.equal(third.audio.usable, true); await third.end();
  const inbound = await call({voicemailCatch: true});
  inbound.said('You have reached the voicemail of John, please leave a message after the tone.');
  await sleep(20); assert.equal(inbound.audio.usable, true); await inbound.end();
  assert.equal(realtimeCatch('Please hold.'), undefined); assert.equal(realtimeCatch('Press 1 for English.', 1), 'ivr'); assert.equal(realtimeCatch('Press 1 for English.', 2), undefined);
});

test('an advice end closes the call once the model\'s next reply has played, or after the backstop; a provisional one is ignored', async () => {
  const ends = {};
  const run = async r => note(`n${r.turn}`, `Note ${r.turn}.`, ends[r.turn] ? {end: ends[r.turn]} : {});
  const c = await call({}, {run});
  ends[1] = 'lead_goodbye';
  c.rt().receive({type: 'input_audio_buffer.speech_started'}); c.rt().receive({type: 'input_audio_buffer.speech_stopped'});
  c.said('Okay, thanks, bye.');
  await wait(() => c.audio.stats.adviceEnd);
  assert.equal(c.twilio.sent.some(m => m.event === 'mark'), false, 'waits for the reply');
  c.reply('r1'); c.rt().receive({type: 'response.output_audio.done', response_id: 'r1'});
  await wait(() => c.twilio.sent.some(m => m.event === 'mark'));
  c.audio.mark('end_call');
  let receipt = await c.audio.done;
  assert.equal(receipt.reason, 'lead_goodbye'); assert.equal(receipt.adviceEnd.how, 'played'); assert.equal(receipt.advice[0].end, 'lead_goodbye');
  // the goodbye already played when the end came: the call ends then
  let answer; const late = await call({}, {run: () => new Promise(r => { answer = r; })});
  late.rt().receive({type: 'input_audio_buffer.speech_stopped'}); late.said('Take me off your list.');
  late.reply('r1'); late.rt().receive({type: 'response.output_audio.done', response_id: 'r1'});
  await wait(() => answer); answer(note('n1', 'Note 1.', {end: 'opt_out'}));
  await wait(() => late.twilio.sent.some(m => m.event === 'mark')); late.audio.mark('end_call');
  assert.equal((await late.audio.done).reason, 'opt_out');
  // no reply comes: the backstop
  const silent = await call({adviceEndBackstopMs: 50}, {run: async () => note('n1', 'Note 1.', {end: 'booked'})});
  silent.said('Yes, two o\'clock works.');
  receipt = await silent.audio.done;
  assert.deepEqual([receipt.reason, receipt.adviceEnd.how], ['booked', 'backstop']);
  // a provisional result's end is not acted on
  const early = await call({sidecar: 'flux-general-en', sidecarApiKey: deepgramKey, adviceEarly: true, adviceEndBackstopMs: 50}, {run: async r => note('n', 'Note.', r.partial ? {end: 'opt_out'} : {})});
  await wait(() => early.side()?.readyState === WebSocket.OPEN);
  early.heard('please stop calling me now');
  await wait(() => early.sent('conversation.item.create').length); await sleep(80);
  assert.equal(early.audio.usable, true); assert.equal(early.audio.stats.adviceEnd, undefined);
  await early.end();
});

test('an advice result\'s end is validated strictly and passed through', async () => {
  const binding = {alias: 'advice', invoke: ['evaluate', '-'], deadlineMs: 2000}, req = {call: {id: 'CA1'}, turn: 1};
  const answer = end => ({request: async () => ({code: 0, stdout: JSON.stringify({call_id: 'CA1', turn: 1, ...note('n1', 'Say goodbye.', end === undefined ? {} : {end})})})});
  assert.equal((await installedAdvice(binding, answer('opt_out')).run(req)).advice.end, 'opt_out');
  assert.equal('end' in (await installedAdvice(binding, answer()).run(req)).advice, false);
  for (const bad of ['hang_up', '', null, 1]) await assert.rejects(installedAdvice(binding, answer(bad)).run(req), /Invalid advice result/);
});

test('turnDetection server: the provider\'s own barge-in; the bridge forwards every frame and only drops what Twilio still has queued', async () => {
  const c = await call({turnDetection: 'server'});
  try {
    c.reply('r1');
    const frame = loud();
    for (let i = 0; i < 20; i++) c.audio.input(frame); // a person talking over the reply: the bridge decides nothing
    assert.equal(c.sent('response.cancel').length, 0);
    assert(c.sent('input_audio_buffer.append').every(e => e.audio === frame), 'no echo silencing');
    c.rt().receive({type: 'input_audio_buffer.speech_started'});
    assert.equal(c.sent('response.cancel').length, 0, 'the provider cancelled its reply itself');
    assert.equal(c.sent('conversation.item.truncate').length, 1); assert.equal(c.twilio.sent.at(-1).event, 'clear');
  } finally { await c.end(); }
});
