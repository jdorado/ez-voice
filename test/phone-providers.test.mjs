import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {PhoneAudio} from '../src/phone-audio.mjs';
import {validatePhoneConfig, phoneCommand} from '../src/phone.mjs';
import {PROVIDERS, createAdapter} from '../src/phone-providers/index.mjs';
import {ulawToPcm, pcmToUlaw, pcmFromBytes, pcmBytes, Upsampler, Downsampler, Framer, FRAME} from '../src/phone-providers/g711.mjs';

const base = {accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com', instructions: 'Synthetic audio test'};
const keys = {openai: 'sk-synthetic123456789', elevenlabs: 'sk_' + 'a'.repeat(24), gemini: 'AIza' + 'b'.repeat(35)};
const streamSid = 'MZ' + '4'.repeat(32);
const wait = async fn => {for (let i = 0; i < 100; i++) {if (fn()) return; await new Promise(r => setTimeout(r, 10));} throw Error('Timed out');};

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; events = [];
  constructor(url, options) {super(); this.url = url; this.options = options; setImmediate(() => this.emit('open'));}
  send(raw) {this.events.push(JSON.parse(raw));}
  receive(event) {this.emit('message', Buffer.from(JSON.stringify(event)));}
  close() {this.readyState = WebSocket.CLOSED; this.emit('close', 1000);}
  terminate() {this.close();}
}
async function call(provider, settings = {}, {fetch} = {}) {
  const sockets = [], finished = [];
  const twilio = Object.assign(new EventEmitter(), {readyState: WebSocket.OPEN, bufferedAmount: 0, sent: [], send(raw) {this.sent.push(JSON.parse(raw));}, close() {this.readyState = WebSocket.CLOSED;}});
  let ready = 0;
  const audio = new PhoneAudio(twilio, {...base, apiKey: keys[provider], provider, streamSid, ...settings}, async stats => {finished.push(stats);},
    {socketFactory: (url, options) => {const socket = new FakeSocket(url, options); sockets.push(socket); return socket;}, fetch, onReady: () => ready++});
  return {audio, twilio, sockets, finished, ready: () => ready, socket: () => sockets[0]};
}
const tone = (hz, rate, ms) => Int16Array.from({length: rate * ms / 1000}, (_, i) => Math.round(12000 * Math.sin(2 * Math.PI * hz * i / rate)));
const rms = samples => Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);

test('G.711 mu-law round-trips within its quantization error', () => {
  const samples = Int16Array.from([-32000, -8000, -1000, -100, -1, 0, 1, 100, 1000, 8000, 32000]);
  const back = ulawToPcm(pcmToUlaw(samples));
  samples.forEach((x, i) => assert(Math.abs(back[i] - x) <= Math.max(64, Math.abs(x) * 0.04), `${x} became ${back[i]}`));
  assert.equal(ulawToPcm(Buffer.from([0xff]))[0], 0);
});

test('resampling keeps speech-band tones and removes what 8 kHz cannot carry', () => {
  const up = new Upsampler().push(tone(1000, 8000, 100));
  assert.equal(up.length, 1600);
  const down = new Downsampler(24000);
  const kept = down.push(tone(1000, 24000, 200)), cut = new Downsampler(24000).push(tone(6000, 24000, 200));
  assert(kept.length >= 1560 && kept.length <= 1600, 'a third of 4800 samples remain');
  assert(Math.abs(rms(kept.slice(20)) / 12000 - Math.SQRT1_2) < 0.05, 'a 1 kHz tone passes');
  assert(rms(cut.slice(20)) / 12000 < 0.05, 'a 6 kHz tone is filtered out, not aliased');
  assert.throws(() => new Downsampler(12345), /Unsupported/);
  assert.equal(new Downsampler(8000).push(tone(500, 8000, 20)).length, 160);
});

test('streaming resampling matches one-shot resampling however the audio is chunked', () => {
  const all = tone(700, 24000, 120), whole = new Downsampler(24000).push(all);
  const parts = new Downsampler(24000), pieces = [];
  for (let i = 0; i < all.length; i += 331) pieces.push(...parts.push(all.slice(i, i + 331)));
  assert.deepEqual(Int16Array.from(pieces), whole);
  const {samples, carry} = pcmFromBytes(Buffer.from([1, 0, 2]));
  assert.deepEqual([...samples], [1]); assert.deepEqual([...carry], [2]);
  assert.deepEqual([...pcmFromBytes(Buffer.from([0]), carry).samples], [2]);
});

test('the framer emits whole 20 ms frames and pads the last one with silence', () => {
  const framer = new Framer();
  assert.equal(framer.push(Buffer.alloc(100, 7)).length, 0);
  assert.equal(framer.push(Buffer.alloc(300, 7)).length, 2 * FRAME);
  const tail = framer.flush(); assert.equal(tail.length, FRAME); assert.equal(tail[79], 7); assert.equal(tail[80], 0xff);
  assert.equal(framer.flush().length, 0);
});

test('provider, model, voice and key shape are validated per provider', () => {
  const ok = provider => validatePhoneConfig({...base, apiKey: keys[provider], provider});
  assert.deepEqual(Object.keys(PROVIDERS), ['openai', 'elevenlabs', 'gemini']);
  assert.equal(validatePhoneConfig({...base, apiKey: keys.openai}).provider, 'openai');
  assert.equal(ok('openai').model, 'gpt-live-1'); assert.equal(ok('openai').voice, 'marin');
  assert.equal(ok('elevenlabs').model, 'eleven_realtime_v1_mini'); assert.equal(ok('elevenlabs').voice, 'brian');
  assert.equal(ok('gemini').model, 'gemini-3.8-live'); assert.equal(ok('gemini').voice, 'Kore');
  assert.equal(validatePhoneConfig({...base, apiKey: keys.elevenlabs, provider: 'elevenlabs', model: 'eleven_realtime_v1_max', voice: 'vOZtmBu4RanHWgj2KUOY'}).model, 'eleven_realtime_v1_max');
  assert.equal(validatePhoneConfig({...base, apiKey: keys.gemini, provider: 'gemini', model: 'gemini-3.8-live-extended-thinking'}).model, 'gemini-3.8-live-extended-thinking');
  for (const [provider, apiKey] of [['openai', keys.gemini], ['elevenlabs', keys.openai], ['gemini', keys.elevenlabs]])
    assert.throws(() => validatePhoneConfig({...base, provider, apiKey}), error => /Supply the .* key/.test(error.message) && !error.message.includes(apiKey));
  assert.equal(validatePhoneConfig({...base, apiKey: keys.elevenlabs, provider: 'elevenlabs', voice: '21m00Tcm4TlvDq8ikWAM'}).voice, '21m00Tcm4TlvDq8ikWAM');
  for (const bad of [{provider: 'grok'}, {provider: 'elevenlabs', model: 'gpt-live-1'}, {provider: 'gemini', voice: 'no spaces'}, {provider: 'gemini', language: 'english'},
    {provider: 'gemini', toolModel: 'gpt-6-sol'}, {provider: 'elevenlabs', toolEffort: 'low'}])
    assert.throws(() => validatePhoneConfig({...base, apiKey: keys[bad.provider] ?? keys.openai, ...bad}), /must be|apply to/);
  assert.equal(validatePhoneConfig({...base, apiKey: keys.openai, toolModel: 'gpt-6-sol'}).toolModel, 'gpt-6-sol');
});

test('doctor reports the configured provider and model', async () => {
  const state = await mkdtemp(join(tmpdir(), 'ez-voice-providers-'));
  try {
    await mkdir(join(state, 'phone'), {recursive: true});
    await writeFile(join(state, 'phone', 'config.json'), JSON.stringify({...base, apiKey: keys.gemini, provider: 'gemini'}));
    const doctor = await phoneCommand(state, ['doctor']);
    assert.equal(doctor.provider, 'gemini'); assert.equal(doctor.model, 'gemini-3.8-live'); assert(!JSON.stringify(doctor).includes(keys.gemini));
    assert.deepEqual((await phoneCommand(await mkdtemp(join(tmpdir(), 'ez-voice-empty-')), ['doctor'])).providers, ['openai', 'elevenlabs', 'gemini']);
  } finally {await rm(state, {recursive: true, force: true});}
});

const secret = 'client_secret_synthetic';
const mintOk = () => { const requests = []; return {requests, fetch: async (url, options) => {requests.push({url, options}); return new Response(JSON.stringify({value: secret, expires_at: 1}), {status: 200});}}; };

test('elevenlabs mints a client secret, configures the session natively and passes mu-law straight through', async () => {
  const mint = mintOk();
  const {audio, twilio, socket, finished, ready} = await call('elevenlabs', {model: 'eleven_realtime_v1_max', voice: 'vOZtmBu4RanHWgj2KUOY', idleSeconds: 0.4, language: 'es'}, {fetch: mint.fetch});
  audio.input('//8='); // before ready: queued
  await wait(() => socket());
  assert.equal(mint.requests[0].url, 'https://api.elevenlabs.io/v1/convai/realtime/client_secrets');
  assert.equal(mint.requests[0].options.headers['xi-api-key'], keys.elevenlabs);
  assert.equal(socket().url, 'wss://api.elevenlabs.io/v1/convai/realtime');
  assert.deepEqual(socket().options.headers, {Authorization: `Bearer ${secret}`});
  assert(!socket().url.includes(keys.elevenlabs) && !JSON.stringify(socket().options).includes(keys.elevenlabs), 'the account key never reaches the socket');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(socket().events, [], 'it waits for session.created');
  socket().receive({type: 'session.created', session: {}});
  await wait(() => socket().events.length);
  const update = socket().events[0];
  assert.equal(update.type, 'session.update'); assert.equal(update.session.model, 'eleven_realtime_v1_max'); assert.equal(update.session.audio.output.voice, 'vOZtmBu4RanHWgj2KUOY');
  assert.deepEqual([update.session.audio.input.format, update.session.audio.output.format], [{type: 'audio/pcmu'}, {type: 'audio/pcmu'}]);
  assert.deepEqual(update.session.audio.input.transcription, {language: 'es'});
  assert.deepEqual(update.session.tools.map(t => [t.type, t.name]), [['function', 'end_call']]);
  assert.equal(ready(), 0);
  socket().receive({type: 'conversation.created', conversation: {id: 'conv_1'}}); socket().receive({type: 'session.updated', session: {}});
  await wait(() => ready() === 1);
  assert.deepEqual(socket().events.slice(1), [{type: 'input_audio_buffer.append', audio: '//8='}], 'queued caller audio is flushed as it came');
  socket().receive({type: 'session.updated', session: {}}); assert.equal(ready(), 1);
  socket().receive({type: 'response.output_audio.delta', delta: '//8='});
  assert.deepEqual(twilio.sent.at(-1), {event: 'media', streamSid, media: {payload: '//8='}});
  // the caller starting to talk is a who-spoke signal and a barge-in: Twilio's queued playback is cleared
  socket().receive({type: 'input_audio_buffer.speech_started', audio_start_ms: 1});
  assert.deepEqual(twilio.sent.at(-1), {event: 'clear', streamSid});
  for (let i = 0; i < 300 && !audio.closing; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(audio.stats.reason, 'idle_timeout');
  const stats = await audio.done;
  assert.equal(stats.provider, 'elevenlabs'); assert.equal(stats.model, 'eleven_realtime_v1_max'); assert.equal(stats.providerSessionId, 'conv_1');
  assert.equal(stats.finalized, false); assert.equal(typeof stats.readyMs, 'number'); assert.equal(typeof stats.firstAudioMs, 'number');
  assert.equal(finished.length, 1); assert(!JSON.stringify(stats).includes(keys.elevenlabs));
  assert(!socket().events.some(e => e.type === 'session.close'), 'there is no close handshake');
});

test('elevenlabs runs end_call natively and answers the function call', async () => {
  const {audio, socket} = await call('elevenlabs', {model: 'eleven_realtime_v1_max', idleSeconds: 0, endCallGraceMs: 50, endCallQuietMs: 100, endCallMaxMs: 3000}, {fetch: mintOk().fetch});
  await wait(() => socket()); socket().receive({type: 'session.created'}); socket().receive({type: 'session.updated'});
  const done = (call_id, name) => ({type: 'response.output_item.done', item: {type: 'function_call', call_id, name, arguments: '{}'}});
  socket().receive(done('end_call_1', 'search_library')); socket().receive(done('bad id!', 'end_call')); socket().receive({type: 'response.output_item.done', item: {type: 'message'}});
  assert.equal(audio.endingAt, undefined);
  socket().receive(done('end_call_2', 'end_call'));
  const outputs = socket().events.filter(e => e.type === 'conversation.item.create').map(e => [e.item.call_id, JSON.parse(e.item.output)]);
  assert.deepEqual(outputs, [['end_call_1', {error: 'unknown_tool'}], ['end_call_2', {status: 'ending'}]]);
  assert.equal(socket().events.filter(e => e.type === 'response.create').length, 1, 'only the unknown tool asks the model to continue; end_call is final');
  for (let i = 0; i < 300 && !audio.closing; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(audio.stats.reason, 'end_call'); assert.deepEqual(audio.stats.tools, ['unknown', 'end_call']);
  await audio.done;
});

test('tools false declares no tools at elevenlabs and gemini, and elevenlabs Mini never gets tools', async () => {
  const eleven = await call('elevenlabs', {model: 'eleven_realtime_v1_max', tools: false}, {fetch: mintOk().fetch});
  await wait(() => eleven.socket()); eleven.socket().receive({type: 'session.created'});
  assert.equal('tools' in eleven.socket().events[0].session, false);
  const mini = await call('elevenlabs', {model: 'eleven_realtime_v1_mini'}, {fetch: mintOk().fetch});
  await wait(() => mini.socket()); mini.socket().receive({type: 'session.created'});
  assert.equal('tools' in mini.socket().events[0].session, false, 'Mini writes the tool name into its speech instead of calling it');
  await mini.audio.close('test_done');
  const gemini = await call('gemini', {tools: false});
  await wait(() => gemini.socket()?.events.length);
  assert.equal('tools' in gemini.socket().events[0].setup, false);
  await eleven.audio.close('test_done'); await gemini.audio.close('test_done');
});

test('a refused client secret ends the call with a code, no socket and no key in the receipt', async () => {
  const {audio, sockets, finished} = await call('elevenlabs', {}, {fetch: async () => new Response('{"detail":"nope"}', {status: 401})});
  const stats = await audio.done;
  assert.equal(sockets.length, 0); assert.equal(stats.reason, 'provider_connection_failed'); assert.equal(stats.providerError, 'HTTP_401');
  assert.equal(finished.length, 1); assert(!JSON.stringify(stats).includes(keys.elevenlabs));
  const broken = await call('elevenlabs', {}, {fetch: async () => {throw Error('network down ' + keys.elevenlabs);}});
  const brokenStats = await broken.audio.done;
  assert.equal(brokenStats.providerError, 'connection_failed'); assert(!JSON.stringify(brokenStats).includes(keys.elevenlabs));
  const empty = await call('elevenlabs', {}, {fetch: async () => new Response('{}', {status: 200})});
  assert.equal((await empty.audio.done).reason, 'provider_connection_failed');
});

test('gemini sets up native tools and converts caller audio to 16 kHz PCM', async () => {
  const {audio, socket, ready} = await call('gemini', {voice: 'Puck', idleSeconds: 0});
  await wait(() => socket()?.events.length);
  const url = new URL(socket().url);
  assert.equal(url.origin + url.pathname, 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent');
  assert.equal(url.searchParams.get('key'), keys.gemini);
  const {setup} = socket().events[0];
  assert.equal(setup.model, 'models/gemini-3.8-live'); assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.equal(setup.systemInstruction.parts[0].text, 'Synthetic audio test');
  assert.deepEqual(setup.tools, [{functionDeclarations: [{name: 'end_call', description: setup.tools[0].functionDeclarations[0].description, behavior: 'BLOCKING'}]}]);
  assert.deepEqual([setup.inputAudioTranscription, setup.outputAudioTranscription], [{}, {}]);
  audio.input(Buffer.alloc(160, 0xff).toString('base64')); // 20 ms of silence, queued until setupComplete
  socket().receive({setupComplete: {}});
  await wait(() => ready() === 1);
  const sent = socket().events.at(-1).realtimeInput.audio;
  assert.equal(sent.mimeType, 'audio/pcm;rate=16000'); assert.equal(Buffer.from(sent.data, 'base64').length, 640);
  await audio.close('test_done');
  // the thinking variant only supports asynchronous tools, so it declares no blocking behavior
  const thinking = await call('gemini', {model: 'gemini-3.8-live-extended-thinking'});
  await wait(() => thinking.socket()?.events.length);
  assert.equal(thinking.socket().events[0].setup.tools[0].functionDeclarations[0].behavior, undefined);
  await thinking.audio.close('test_done');
});

test('gemini model audio becomes whole 20 ms mu-law frames, a barge-in clears Twilio, and tools answer by id', async () => {
  const {audio, twilio, socket, ready} = await call('gemini', {idleSeconds: 0, endCallGraceMs: 50, endCallQuietMs: 100, endCallMaxMs: 3000});
  await wait(() => socket()?.events.length); socket().receive({setupComplete: {}}); await wait(() => ready() === 1);
  const chunk = pcm => ({serverContent: {modelTurn: {parts: [{inlineData: {mimeType: 'audio/pcm;rate=24000', data: pcmBytes(pcm).toString('base64')}}]}}});
  for (let i = 0; i < 10; i++) socket().receive(chunk(tone(500, 24000, 20)));
  const media = () => twilio.sent.filter(m => m.event === 'media').map(m => Buffer.from(m.media.payload, 'base64'));
  assert(media().length > 0 && media().every(b => b.length % FRAME === 0), 'whole frames only');
  const before = media().reduce((n, b) => n + b.length, 0);
  assert(before >= 8 * FRAME && before <= 10 * FRAME, `200 ms of speech is about 10 frames (got ${before / FRAME})`);
  socket().receive(chunk(tone(500, 24000, 10))); socket().receive({serverContent: {turnComplete: true}});
  assert.equal(media().at(-1).length, FRAME, 'the turn end flushes the partial frame');
  socket().receive({serverContent: {interrupted: true}});
  assert.deepEqual(twilio.sent.at(-1), {event: 'clear', streamSid});
  socket().receive({serverContent: {inputTranscription: {text: 'hi'}}}); assert.equal(audio.stats.inputTranscriptEvents, 1);
  socket().receive({serverContent: {outputTranscription: {text: 'hello'}}});
  socket().receive({usageMetadata: {totalTokenCount: 42}});
  socket().receive({toolCall: {functionCalls: [{id: 'fc-1', name: 'search_library', args: {}}, {id: 'fc-2', name: 'end_call', args: {}}]}});
  assert.deepEqual(socket().events.filter(e => e.toolResponse).map(e => e.toolResponse.functionResponses[0]),
    [{id: 'fc-1', name: 'search_library', response: {result: {error: 'unknown_tool'}}}, {id: 'fc-2', name: 'end_call', response: {result: {status: 'ending'}}}]);
  for (let i = 0; i < 300 && !audio.closing; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(audio.stats.reason, 'end_call');
  const stats = await audio.done;
  assert.deepEqual(stats.usage, {totalTokenCount: 42}); assert.equal(stats.finalized, false); assert.equal(stats.provider, 'gemini');
  assert(!JSON.stringify(stats).includes(keys.gemini));
});

test('gemini audio at an unsupported rate, a goAway and a provider close code end the call without leaking the key', async () => {
  const strange = await call('gemini', {idleSeconds: 0});
  await wait(() => strange.socket()?.events.length); strange.socket().receive({setupComplete: {}});
  strange.socket().receive({serverContent: {modelTurn: {parts: [{inlineData: {mimeType: 'audio/pcm;rate=12345', data: 'AAAA'}}]}}});
  assert.equal((await strange.audio.done).reason, 'unsupported_provider_audio');
  const away = await call('gemini', {idleSeconds: 0});
  await wait(() => away.socket()?.events.length); away.socket().receive({goAway: {timeLeft: '10s'}});
  assert.equal((await away.audio.done).reason, 'provider_go_away');
  const rejected = await call('gemini', {idleSeconds: 0});
  await wait(() => rejected.socket()?.events.length);
  rejected.socket().emit('close', 1007, Buffer.from('Invalid key ' + keys.gemini));
  const stats = await rejected.audio.done;
  assert.equal(stats.providerError, 'WS_1007'); assert(!JSON.stringify(stats).includes(keys.gemini));
  const failed = await call('gemini', {idleSeconds: 0});
  await wait(() => failed.socket()?.events.length);
  failed.socket().emit('error', Error('connect failed wss://example/?key=' + keys.gemini));
  const failedStats = await failed.audio.done;
  assert.equal(failedStats.reason, 'provider_connection_failed'); assert(!JSON.stringify(failedStats).includes(keys.gemini));
});

test('createAdapter fills the model and voice defaults and rejects an unknown provider', () => {
  const adapter = createAdapter({apiKey: keys.openai}, {});
  assert.equal(adapter.config.model, 'gpt-live-1'); assert.equal(adapter.config.voice, 'marin');
  assert.throws(() => createAdapter({provider: 'grok'}), /provider must be one of/);
});

test('doctor shows whether tools are declared, and elevenlabs sizes its session to the call', async () => {
  const state = await mkdtemp(join(tmpdir(), 'ez-voice-tools-'));
  try {
    await mkdir(join(state, 'phone'), {recursive: true});
    const doctor = async config => {await writeFile(join(state, 'phone', 'config.json'), JSON.stringify({...base, ...config})); return phoneCommand(state, ['doctor']);};
    assert.equal((await doctor({apiKey: keys.elevenlabs, provider: 'elevenlabs'})).tools, false);
    assert.equal((await doctor({apiKey: keys.elevenlabs, provider: 'elevenlabs', model: 'eleven_realtime_v1_max'})).tools, true);
    assert.equal((await doctor({apiKey: keys.elevenlabs, provider: 'elevenlabs', model: 'eleven_realtime_v1_max', tools: false})).tools, false);
    assert.equal((await doctor({apiKey: keys.openai})).tools, true);
  } finally {await rm(state, {recursive: true, force: true});}
  const long = await call('elevenlabs', {maxCallSeconds: 900}, {fetch: mintOk().fetch}), short = await call('elevenlabs', {maxCallSeconds: 30}, {fetch: mintOk().fetch}), huge = await call('elevenlabs', {maxCallSeconds: 3600}, {fetch: mintOk().fetch});
  for (const [c, seconds] of [[long, 915], [short, 60], [huge, 3615]]) {
    await wait(() => c.socket()); c.socket().receive({type: 'session.created'});
    assert.equal(c.socket().events[0].session.max_duration_seconds, seconds); await c.audio.close('test_done');
  }
});

test('a call closed while the client secret is pending never opens a socket', async () => {
  let release; const gate = new Promise(resolve => {release = resolve;});
  const {audio, sockets} = await call('elevenlabs', {}, {fetch: async () => {await gate; return new Response(JSON.stringify({value: secret}), {status: 200});}});
  await audio.close('caller_hangup');
  release(); await new Promise(r => setTimeout(r, 30));
  assert.equal(sockets.length, 0); assert.equal(audio.stats.reason, 'caller_hangup');
});

test('a provider that closes the session by itself leaves a reason, and duplicate end_call answers are harmless', async () => {
  const {audio, socket} = await call('elevenlabs', {model: 'eleven_realtime_v1_max', idleSeconds: 0}, {fetch: mintOk().fetch});
  await wait(() => socket()); socket().receive({type: 'session.created'}); socket().receive({type: 'session.updated'});
  const done = id => ({type: 'response.output_item.done', item: {type: 'function_call', call_id: id, name: 'end_call', arguments: '{}'}});
  socket().receive(done('end_call_a')); socket().receive(done('end_call_b'));
  assert.deepEqual(audio.stats.tools, ['end_call', 'end_call']); assert.equal(audio.endingAt > 0, true);
  socket().emit('close', 1000, Buffer.from(''));
  const stats = await audio.done;
  assert.equal(stats.reason, 'provider_closed'); assert.equal(stats.providerError, undefined); assert.equal(stats.finalized, false);
});
