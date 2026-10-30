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
  assert.equal(validatePhoneConfig({...base, apiKey: 'AQ.' + 'Ab8-x_y'.repeat(7), provider: 'gemini'}).provider, 'gemini', 'the newer AQ. key shape is accepted');
  assert.equal(validatePhoneConfig({...base, apiKey: keys.elevenlabs, provider: 'elevenlabs', model: 'eleven_realtime_v1_max', voice: 'vOZtmBu4RanHWgj2KUOY'}).model, 'eleven_realtime_v1_max');
  assert.equal(validatePhoneConfig({...base, apiKey: keys.gemini, provider: 'gemini', model: 'gemini-3.8-live-extended-thinking'}).model, 'gemini-3.8-live-extended-thinking');
  for (const [provider, apiKey] of [['openai', keys.gemini], ['elevenlabs', keys.openai], ['gemini', keys.elevenlabs]])
    assert.throws(() => validatePhoneConfig({...base, provider, apiKey}), error => /Supply the .* key/.test(error.message) && !error.message.includes(apiKey));
  assert.equal(validatePhoneConfig({...base, apiKey: keys.elevenlabs, provider: 'elevenlabs', voice: '21m00Tcm4TlvDq8ikWAM'}).voice, '21m00Tcm4TlvDq8ikWAM');
  for (const bad of [{provider: 'grok'}, {provider: 'elevenlabs', model: 'gpt-live-1'}, {provider: 'gemini', voice: 'no spaces'}, {provider: 'gemini', language: 'english'},
    {provider: 'gemini', toolModel: 'gpt-6-sol'}, {provider: 'gemini', thinking: 'high'}, {provider: 'gemini', model: 'gemini-3.8-live-extended-thinking', thinking: 'extreme'}, {provider: 'elevenlabs', toolEffort: 'low'}])
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

test('GPT-Live exposes backend hang-up delegation to the voice model only with tools enabled', () => {
  const config = {...base, provider: 'openai', apiKey: keys.openai};
  const session = createAdapter(config).start()[0].session;
  assert(session.instructions.startsWith(base.instructions + '\n\n'));
  assert.match(session.instructions, /Generate <\|SpawnThinking\|> when:/);
  for (const tool of session.delegation.responses.tools) assert(session.instructions.includes(tool.name));
  assert.match(session.instructions, /Do not generate <\|SpawnThinking\|> when:/);
  const disabled = createAdapter({...config, tools: false}).start()[0].session;
  assert.equal(disabled.instructions, base.instructions);
  assert.deepEqual(disabled.delegation, {type: 'client'});
});

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
  const {audio, socket} = await call('elevenlabs', {model: 'eleven_realtime_v1_max', idleSeconds: 0, endCallGraceMs: 50, endCallQuietMs: 100, endCallMaxMs: 3000, endCallDrainMs: 100}, {fetch: mintOk().fetch});
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
  assert.deepEqual(thinking.socket().events[0].setup.generationConfig.thinkingConfig, {thinkingLevel: 'low'});
  assert.equal('thinkingConfig' in (await call('gemini', {}).then(async c => {await wait(() => c.socket()?.events.length); await c.audio.close('test_done'); return c.socket().events[0].setup.generationConfig;})), false, 'the plain model refuses a thinking level');
  await thinking.audio.close('test_done');
  const high = await call('gemini', {model: 'gemini-3.8-live-extended-thinking', thinking: 'high'});
  await wait(() => high.socket()?.events.length);
  assert.deepEqual(high.socket().events[0].setup.generationConfig.thinkingConfig, {thinkingLevel: 'high'}); await high.audio.close('test_done');
});

test('gemini model audio becomes whole 20 ms mu-law frames, a barge-in clears Twilio, and tools answer by id', async () => {
  const {audio, twilio, socket, ready} = await call('gemini', {idleSeconds: 0, endCallGraceMs: 50, endCallQuietMs: 100, endCallMaxMs: 3000, endCallDrainMs: 100});
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
    [{id: 'fc-1', name: 'search_library', response: {result: {error: 'unknown_tool'}}}], 'end_call is final: it gets no answer to narrate');
  assert(audio.endingAt > 0);
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

const endCallItem = id => ({type: 'response.output_item.done', item: {type: 'function_call', call_id: id, name: 'end_call', arguments: '{}'}});
const markSent = twilio => twilio.sent.some(m => m.event === 'mark');

test('end_call waits for Twilio to play what was queued: a mark goes out, and only its echo hangs up', async () => {
  const {audio, twilio, socket} = await call('elevenlabs', {model: 'eleven_realtime_v1_max', idleSeconds: 0, endCallGraceMs: 50, endCallQuietMs: 100, endCallMaxMs: 5000, endCallDrainMs: 5000}, {fetch: mintOk().fetch});
  await wait(() => socket()); socket().receive({type: 'session.created'}); socket().receive({type: 'session.updated'});
  socket().receive({type: 'response.output_audio.delta', delta: '//8='}); socket().receive(endCallItem('end_call_a'));
  await wait(() => markSent(twilio));
  assert.deepEqual(twilio.sent.find(m => m.event === 'mark'), {event: 'mark', streamSid, mark: {name: 'end_call'}});
  await new Promise(r => setTimeout(r, 300));
  assert.equal(audio.closing, undefined, 'the call stays up until Twilio has played the audio');
  audio.mark('other'); assert.equal(audio.closing, undefined, 'another mark name does not count');
  audio.mark('end_call');
  assert.equal(audio.stats.reason, 'end_call'); await audio.done;
});

test('a Twilio that never echoes the mark cannot keep the call up past endCallDrainMs, and no mark before end_call hangs up', async () => {
  const {audio, twilio, socket} = await call('elevenlabs', {model: 'eleven_realtime_v1_max', idleSeconds: 0, endCallGraceMs: 50, endCallQuietMs: 100, endCallMaxMs: 5000, endCallDrainMs: 200}, {fetch: mintOk().fetch});
  await wait(() => socket()); socket().receive({type: 'session.created'}); socket().receive({type: 'session.updated'});
  audio.mark('end_call'); assert.equal(audio.closing, undefined, 'a stray mark echo before end_call does nothing');
  socket().receive(endCallItem('end_call_a'));
  for (let i = 0; i < 300 && !audio.closing; i++) await new Promise(r => setTimeout(r, 10));
  assert(markSent(twilio)); assert.equal(audio.stats.reason, 'end_call'); await audio.done;
});

test('where audio only flows while the model speaks, audio arriving after end_call keeps the hang-up waiting', async () => {
  const {audio, twilio, socket} = await call('elevenlabs', {model: 'eleven_realtime_v1_max', idleSeconds: 0, endCallGraceMs: 50, endCallQuietMs: 300, endCallMaxMs: 10000, endCallDrainMs: 5000}, {fetch: mintOk().fetch});
  await wait(() => socket()); socket().receive({type: 'session.created'}); socket().receive({type: 'session.updated'});
  socket().receive(endCallItem('end_call_a'));
  for (let i = 0; i < 12; i++) { socket().receive({type: 'response.output_audio.delta', delta: '//8='}); await new Promise(r => setTimeout(r, 100)); }
  assert.equal(markSent(twilio), false, 'the goodbye was still arriving, so no mark yet');
  await wait(() => markSent(twilio)); audio.mark('end_call'); await audio.done;
  assert.equal(audio.stats.reason, 'end_call');
});

test('the idle hang-up waits for queued speech to finish playing, and a barge-in drops what was queued', async () => {
  const burst = seconds => ({type: 'response.output_audio.delta', delta: Buffer.alloc(8000 * seconds, 0x55).toString('base64')});
  const {audio, socket} = await call('elevenlabs', {model: 'eleven_realtime_v1_max', idleSeconds: 0.4}, {fetch: mintOk().fetch});
  await wait(() => socket()); socket().receive({type: 'session.created'}); socket().receive({type: 'session.updated'});
  socket().receive({type: 'input_audio_buffer.speech_stopped'}); // somebody spoke: the idle rule is armed
  socket().receive(burst(3)); // 3 s of speech arrives at once, as a provider that runs faster than realtime sends it
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(audio.closing, undefined, 'still being played, so not idle (it arrived 1.5 s ago, played for 3 s)');
  for (let i = 0; i < 400 && !audio.closing; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(audio.stats.reason, 'idle_timeout'); await audio.done;
  const barge = await call('elevenlabs', {model: 'eleven_realtime_v1_max', idleSeconds: 0.4}, {fetch: mintOk().fetch});
  await wait(() => barge.socket()); barge.socket().receive({type: 'session.created'}); barge.socket().receive({type: 'session.updated'});
  barge.socket().receive(burst(30)); barge.socket().receive({type: 'input_audio_buffer.speech_started'});
  const started = Date.now();
  for (let i = 0; i < 400 && !barge.audio.closing; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(barge.audio.stats.reason, 'idle_timeout'); assert(Date.now() - started < 3000, 'the 30 s that were queued were cleared, not waited for');
  await barge.audio.done;
});

test('an answered call is greeted: once the session is ready each provider asks its model to speak first, and a placed call waits', async () => {
  const readyEvents = {openai: [{type: 'session.started', session: {id: 's1'}}], gemini: [{setupComplete: {}}],
    elevenlabs: [{type: 'session.created', session: {}}, {type: 'session.updated', session: {}}]};
  const greeting = {openai: [{type: 'response.create'}], elevenlabs: [{type: 'response.create'}],
    gemini: [{clientContent: {turns: [{role: 'user', parts: [{text: '(The call has connected: answer it.)'}]}], turnComplete: true}}]};
  for (const provider of ['openai', 'elevenlabs', 'gemini']) {
    for (const greet of [true, false]) {
      const {audio, socket, ready} = await call(provider, {greet, idleSeconds: 0}, {fetch: mintOk().fetch});
      await wait(() => socket());
      await wait(() => provider === 'elevenlabs' || socket().events.length);
      const before = socket().events.length;
      for (const event of readyEvents[provider]) socket().receive(event);
      await wait(() => ready() === 1);
      const sent = socket().events.slice(before).filter(e => e.type !== 'session.update');
      assert.deepEqual(sent, greet ? greeting[provider] : [], `${provider} greet=${greet}`);
      audio.close('test'); socket().close(); await audio.done;
    }
  }
});

test('the receipt keeps what each side said, as each provider transcribed it, in turns', async () => {
  const said = {
    openai: [{type: 'session.started', session: {id: 's1'}}, {type: 'session.output_transcript.delta', delta: 'Hi, this is '},
      {type: 'session.output_transcript.delta', delta: 'Sharon.'}, {type: 'session.input_transcript.delta', delta: 'Hello, '},
      {type: 'session.input_transcript.delta', delta: 'who is this?'}, {type: 'session.output_transcript.delta', delta: 'Sharon with Quarre.'}],
    elevenlabs: [{type: 'session.created'}, {type: 'session.updated'}, {type: 'response.output_audio_transcript.delta', delta: 'Hi, this is '},
      {type: 'response.output_audio_transcript.delta', delta: 'Sharon.'}, {type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello,'},
      {type: 'conversation.item.input_audio_transcription.completed', transcript: 'who is this?'}, {type: 'response.output_audio_transcript.delta', delta: 'Sharon with Quarre.'}],
    gemini: [{setupComplete: {}}, {serverContent: {outputTranscription: {text: 'Hi, this is '}}}, {serverContent: {outputTranscription: {text: 'Sharon.'}}},
      {serverContent: {inputTranscription: {text: 'Hello, '}}}, {serverContent: {inputTranscription: {text: 'who is this?'}}},
      {serverContent: {outputTranscription: {text: 'Sharon with Quarre.'}}}],
  };
  for (const [provider, events] of Object.entries(said)) {
    const {audio, socket} = await call(provider, {idleSeconds: 0}, {fetch: mintOk().fetch});
    await wait(() => socket());
    for (const event of events) socket().receive(event);
    audio.close('test'); socket().close();
    const stats = await audio.done;
    assert.deepEqual(stats.transcript.map(({who, text}) => [who, text]),
      [['model', 'Hi, this is Sharon.'], ['caller', 'Hello, who is this?'], ['model', 'Sharon with Quarre.']], provider);
    assert(stats.transcript.every(t => Number.isInteger(t.atMs)), provider);
    assert.equal(stats.transcriptTruncated, undefined, provider);
  }
});

test('a call nobody spoke on keeps no transcript, and a long one stops at the limit and says so', async () => {
  const {Transcript, MAX_TRANSCRIPT} = await import('../src/phone-providers/transcript.mjs');
  assert.deepEqual(new Transcript(Date.now()).receipt(), {});
  const long = new Transcript(Date.now());
  for (let i = 0; i < 30; i++) long.add(i % 2 ? 'caller' : 'model', {text: 'x'.repeat(5000)});
  const kept = long.receipt();
  assert.equal(kept.transcriptTruncated, true);
  assert(kept.transcript.reduce((n, t) => n + t.text.length, 0) <= MAX_TRANSCRIPT);
  long.add('narrator', {text: 'not a side of the call'}); // only the caller and the model are sides
  assert(!long.turns.some(t => t.who === 'narrator'));
});

test('a caller whose words arrive after the model began to answer is placed where they began to speak, and sentences keep a space', async () => {
  const {audio, socket} = await call('elevenlabs', {model: 'eleven_realtime_v1_max', idleSeconds: 0}, {fetch: mintOk().fetch});
  await wait(() => socket());
  const later = ms => new Promise(r => setTimeout(r, ms));
  for (const event of [{type: 'session.created'}, {type: 'session.updated'}]) socket().receive(event);
  socket().receive({type: 'response.output_audio_transcript.delta', delta: 'Hi, this is Sharon.'});
  await later(15);
  socket().receive({type: 'input_audio_buffer.speech_started', audio_start_ms: 1});
  await later(15);
  socket().receive({type: 'response.output_audio_transcript.delta', delta: 'How can I help?'}); // the model talks on
  await later(15);
  socket().receive({type: 'conversation.item.input_audio_transcription.completed', transcript: 'Do you remember me?'});
  socket().receive({type: 'response.output_audio_transcript.delta', delta: 'Yes.'});
  socket().receive({type: 'response.output_audio_transcript.delta', delta: 'We texted on the 28th.'});
  audio.close('test'); socket().close();
  const {transcript} = await audio.done;
  assert.deepEqual(transcript.map(({who, text}) => [who, text]), [
    ['model', 'Hi, this is Sharon.'], ['caller', 'Do you remember me?'], ['model', 'How can I help? Yes. We texted on the 28th.']]);
});

test('an answered call rings on while the session starts, through streamed silence, and stops at the first words', async () => {
  const {RING_CYCLE, audible} = await import('../src/phone-providers/ringback.mjs');
  const words = RING_CYCLE[0]; // a frame of tone: audible, as speech is
  assert.equal(audible(words), true); assert.equal(audible(RING_CYCLE.at(-1)), false); assert.equal(audible('//8='), false);
  const {audio, twilio, socket} = await call('openai', {greet: true, idleSeconds: 0});
  await wait(() => twilio.sent.length >= 5); // the ring, before the provider is even ready
  assert(twilio.sent.every(m => m.event === 'media' && RING_CYCLE.includes(m.media.payload)));
  socket().receive({type: 'session.started', session: {id: 's1'}});
  socket().receive({type: 'session.output_audio.delta', delta: '//8='}); // GPT-Live streams silence: it rings on
  assert(!twilio.sent.some(m => m.event === 'clear' || m.media?.payload === '//8='));
  const rang = twilio.sent.length;
  socket().receive({type: 'session.output_audio.delta', delta: words});
  const after = twilio.sent.slice(rang);
  assert.deepEqual(after.slice(0, 2).map(m => m.event), ['clear', 'media']); // the queued ring is dropped first
  assert.equal(after[1].media.payload, words);
  await new Promise(r => setTimeout(r, 250));
  assert.equal(twilio.sent.length, rang + 2, 'no ring after the first words');
  audio.close('test'); socket().close();
  const stats = await audio.done;
  assert.equal(typeof stats.ringMs, 'number');
  for (const settings of [{greet: false}, {greet: true, answerTone: 'none'}]) { // a placed call, or a line that opts out
    const quiet = await call('openai', {...settings, idleSeconds: 0});
    await new Promise(r => setTimeout(r, 250));
    assert.deepEqual(quiet.twilio.sent, [], JSON.stringify(settings));
    quiet.audio.close('test'); quiet.socket()?.close(); await quiet.audio.done;
  }
});

test('the ring is bounded: caller audio waits it out, it stops when nothing sounds after ready, on close, and records why', async () => {
  const twilio = () => Object.assign(new EventEmitter(), {readyState: WebSocket.OPEN, bufferedAmount: 0, sent: [], send(raw) {this.sent.push(JSON.parse(raw));}, close() {this.readyState = WebSocket.CLOSED;}});
  const bridge = (line, settings = {}) => {
    const sockets = [];
    const audio = new PhoneAudio(line, {...base, apiKey: keys.openai, provider: 'openai', streamSid, greet: true, idleSeconds: 0, ...settings}, async () => {},
      {socketFactory: (url, options) => {const s = new FakeSocket(url, options); sockets.push(s); return s;}, ringAfterReadyMs: 60});
    return {audio, socket: () => sockets[0]};
  };
  const quiet = twilio(), {audio, socket} = bridge(quiet);
  await wait(() => socket());
  audio.input('//8='); // the caller's line while it rings: not a turn for the model
  socket().receive({type: 'session.started', session: {id: 's1'}});
  await new Promise(r => setTimeout(r, 30));
  assert(!socket().events.some(e => e.type === 'session.input_audio.append'), 'nothing the line carried while ringing reached the model');
  await wait(() => audio.stats.ringStop);
  assert.equal(audio.stats.ringStop, 'timeout'); assert(quiet.sent.some(m => m.event === 'clear'));
  audio.input('//8='); // answered now: the caller is heard
  await wait(() => socket().events.some(e => e.type === 'session.input_audio.append'));
  audio.close('test'); socket().close(); await audio.done;
  const closing = twilio(), early = bridge(closing);
  await wait(() => early.socket());
  early.audio.close('caller_hangup'); early.socket().close();
  const stats = await early.audio.done;
  assert.equal(stats.ringStop, 'close'); assert.equal(typeof stats.ringMs, 'number');
});

test('GPT-Live without Responses delegation asks for no greeting (not verified there); with it, one', () => {
  const make = tools => createAdapter({...base, apiKey: keys.openai, provider: 'openai', tools});
  assert.deepEqual(make(false).greet(), []);
  assert.deepEqual(make(true).greet(), [{type: 'response.create'}]);
  assert.match(make(false).parse({type: 'session.delegation.created', delegation: {id: 'd1', target: 'client'}})[0].message.content, /answer from your instructions/);
});

test('once the transcript is full, nothing later is kept, not even a short turn', async () => {
  const {Transcript, MAX_TRANSCRIPT} = await import('../src/phone-providers/transcript.mjs');
  const t = new Transcript(Date.now());
  t.add('model', {delta: 'x'.repeat(MAX_TRANSCRIPT - 5)});
  t.add('caller', {text: 'y'.repeat(20)}); // over the budget: refused, and the transcript is full
  t.add('model', {delta: 'later'}); t.add('caller', {text: 'later'});
  const kept = t.receipt();
  assert.equal(kept.transcriptTruncated, true); assert.equal(kept.transcript.length, 1);
});


test('both speaking providers receive information tools and GPT-Live delegates missing facts', async () => {
  const information = {tools: [{type: 'function', name: 'read_record', description: 'Read current records', parameters: {type: 'object', properties: {ref: {type: 'string'}}}}]};
  const openai = createAdapter({...base, provider: 'openai', apiKey: keys.openai, information}).start()[0].session;
  assert(openai.instructions.includes('read_record')); assert(openai.instructions.includes('facts missing'));
  assert(openai.delegation.responses.tools.some(t => t.name === 'read_record'));
  const eleven = createAdapter({...base, provider: 'elevenlabs', model: 'eleven_realtime_v1_max', apiKey: keys.elevenlabs, information}).configure().session;
  assert(eleven.tools.some(t => t.name === 'read_record'));
});

test('overlapping calls keep their own result and a late old turn is discarded', async () => {
  const pending = [];
  const information = {tools: [{name: 'read_record'}], run: (call, turn, name, args, signal) => new Promise(resolve => pending.push({call, turn, args, signal, resolve}))};
  const a = await call('openai', {information, call: {id: 'call-a'}});
  const b = await call('openai', {information, call: {id: 'call-b'}});
  await wait(() => a.socket() && b.socket());
  a.audio.tool({id: 'a1', name: 'read_record', args: {ref: 'current'}});
  b.audio.tool({id: 'b1', name: 'read_record', args: {ref: 'current'}});
  await wait(() => pending.length === 2);
  a.audio.handle({type: 'speech', who: 'caller', start: true, delta: 'Different question now'});
  a.audio.tool({id: 'a2', name: 'read_record', args: {ref: 'new'}});
  await wait(() => pending.length === 3);
  assert(pending[0].signal.aborted);
  pending[1].resolve({value: 'b'}); pending[2].resolve({value: 'new-a'}); pending[0].resolve({value: 'STALE'});
  await wait(() => a.audio.pendingTools.size === 0 && b.audio.pendingTools.size === 0);
  const outputs = c => c.socket().events.filter(e => e.type === 'response.item.create').map(e => [e.item.call_id, JSON.parse(e.item.output)]);
  assert.deepEqual(outputs(a), [['a1', {status: 'cancelled', error: 'caller_turn_changed'}], ['a2', {value: 'new-a'}]]);
  assert.deepEqual(outputs(b), [['b1', {value: 'b'}]]);
  a.audio.tool({id: 'a3', name: 'read_record', args: {}});
  await wait(() => pending.length === 4);
  a.audio.close(); pending[3].resolve({value: 'AFTER CLOSE'});
  await new Promise(r => setTimeout(r, 20));
  assert.equal(outputs(a).length, 2);
  b.audio.close(); a.socket().receive({type: 'session.closed'}); b.socket().receive({type: 'session.closed'});
  await Promise.all([a.audio.done, b.audio.done]);
});

test('a failed information read is explicit and cannot invoke another command', async () => {
  let called = 0;
  const information = {tools: [{name: 'read_record'}], run: async () => {called++; throw Error('private failure');}};
  const c = await call('elevenlabs', {model: 'eleven_realtime_v1_max', information}, {fetch: mintOk().fetch});
  await wait(() => c.socket());
  c.audio.tool({id: 'one', name: 'read_record', args: '{}'});
  c.audio.tool({id: 'two', name: 'send_sms', args: '{}'});
  await wait(() => c.audio.pendingTools.size === 0);
  const outputs = c.socket().events.filter(e => e.type === 'conversation.item.create').map(e => JSON.parse(e.item.output));
  assert(outputs.some(o => o.status === 'unavailable')); assert(outputs.some(o => o.error === 'unknown_tool'));
  assert.equal(called, 1); assert(!JSON.stringify(outputs).includes('private failure'));
  await c.audio.close();
});


test('several valid line instructions fit the private configuration input contract', async () => {
  const state = await mkdtemp(join(tmpdir(), 'voice-profile-size-'));
  try {
    const config = {...base, lines: [
      {number: '+15551230001', apiKey: keys.openai, instructions: 'a'.repeat(10000)},
      {number: '+15551230002', apiKey: keys.openai, instructions: 'b'.repeat(10000)}]};
    delete config.number; delete config.instructions;
    async function* stdin() { yield JSON.stringify(config); }
    const result = await phoneCommand(state, ['configure'], {stdin: stdin()});
    assert.equal(result.lines.length, 2);
  } finally { await rm(state, {recursive: true, force: true}); }
});


test('GPT-Live transcript fragments do not become new turns when model speech interleaves', () => {
  const adapter = createAdapter({...base, provider: 'openai', apiKey: keys.openai});
  const fragment = (start_ms, end_ms) => adapter.parse({type: 'session.input_transcript.delta', delta: 'words', start_ms, end_ms})[0];
  assert.equal(fragment(1000, 1200).start, true);
  adapter.parse({type: 'session.output_transcript.delta', delta: 'Checking'});
  assert.equal(fragment(1200, 1400).start, false);
  assert.equal(fragment(1400, 1600).start, false);
  assert.equal(fragment(5000, 5200).start, true);
});


test('a bounded pending read is active work, then the ordinary idle timer resumes', async () => {
  let resolve;
  const information = {tools: [{name: 'read_record'}], run: () => new Promise(r => {resolve = r;})};
  const c = await call('openai', {idleSeconds: 0.08, information});
  await wait(() => c.socket());
  c.audio.handle({type: 'speech', who: 'caller', start: true, delta: 'Read'});
  c.audio.tool({id: 'pending-idle', name: 'read_record', args: {}});
  await wait(() => resolve);
  await new Promise(r => setTimeout(r, 140));
  assert.equal(c.audio.closing, undefined);
  resolve({status: 'available'});
  await wait(() => c.audio.pendingTools.size === 0);
  assert.equal(c.audio.stats.informationReads[0].status, 'available');
  await wait(() => c.audio.closing);
  c.socket().receive({type: 'session.closed'}); await c.audio.done;
});
