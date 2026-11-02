import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket, {WebSocketServer} from 'ws';
import {validatePhoneConfig, phoneCommand, servePhone, twilioSignature} from '../src/phone.mjs';
import {PhoneNumber} from '../src/phone-provider.mjs';
import {createAdapter} from '../src/phone-providers/index.mjs';
import {speechMessage, relaySpeech} from '../src/phone-speech.mjs';

const base = {accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com',
  instructions: 'Synthetic call', provider: 'deepgram', apiKey: 'd'.repeat(40), llmApiKey: 'AIza' + 'b'.repeat(35), ttsApiKey: 'sk_' + 'a'.repeat(24)};
const wait = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('Timed out'); };
class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; events = [];
  send(raw) { this.events.push(JSON.parse(raw)); }
  receive(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1000); }
  terminate() { this.close(); }
}

test('speech rate is a bounded per-line Deepgram setting and doctor exposes no credentials', async () => {
  const valid = validatePhoneConfig({...base, ttsSpeed: 0.95});
  assert.equal(valid.lines[0].ttsSpeed, 0.95);
  for (const ttsSpeed of [null, false, '0.95', NaN, Infinity, 0.69, 1.21]) assert.throws(() => validatePhoneConfig({...base, ttsSpeed}), /ttsSpeed/);
  assert.throws(() => validatePhoneConfig({...base, provider: 'openai', apiKey: 'sk-synthetic123456789', llmApiKey: undefined, ttsApiKey: undefined, ttsSpeed: 0.95}), /deepgram only/);
  assert.throws(() => createAdapter({...valid, speech: undefined}).settings(), /call-bound speech relay/);
  const directory = await mkdtemp(join(tmpdir(), 'ez-voice-speed-'));
  try {
    await mkdir(join(directory, 'phone'));
    await writeFile(join(directory, 'phone/config.json'), JSON.stringify({...base, ttsSpeed: 0.95}));
    const doctor = await phoneCommand(directory, ['doctor']);
    assert.equal(doctor.lines[0].ttsSpeed, 0.95);
    for (const key of [base.apiKey, base.llmApiKey, base.ttsApiKey]) assert(!JSON.stringify(doctor).includes(key));
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('each speech context gets its own rate at initialization, without rewriting later text frames', () => {
  const a = new Set(), b = new Set();
  const initial = {context_id: 'same-id', text: ' ', xi_api_key: 'must-not-forward', voice_settings: {stability: 0.5, speed: 1.2}};
  const first = JSON.parse(speechMessage(Buffer.from(JSON.stringify(initial)), 0.95, a));
  assert.deepEqual(first.voice_settings, {stability: 0.5, speed: 0.95});
  assert(!('xi_api_key' in first));
  assert.equal(JSON.parse(speechMessage(Buffer.from(JSON.stringify(initial)), 1.1, b)).voice_settings.speed, 1.1);
  const later = JSON.stringify({context_id: 'same-id', text: 'Hello.', flush: true});
  assert.equal(speechMessage(Buffer.from(later), 0.95, a), later);
  speechMessage(Buffer.from('{"close_context":"same-id"}'), 0.95, a);
  assert.equal(JSON.parse(speechMessage(Buffer.from(later), 0.95, a)).voice_settings.speed, 0.95);
  for (const raw of ['[]', 'null', '{"text":"hello"}', '{"context_id":"x","text":"hi","voice_settings":[]}']) assert.throws(() => speechMessage(Buffer.from(raw), 0.95, new Set()));
});

test('the TTS relay applies the rate over WebSockets and passes audio back without retaining it', async t => {
  const upstream = new WebSocketServer({port: 0, host: '127.0.0.1'});
  await once(upstream, 'listening');
  const seen = [];
  upstream.on('connection', (ws, request) => {
    assert.equal(request.headers['xi-api-key'], 'private-key');
    ws.on('message', raw => { seen.push(JSON.parse(raw)); ws.send(JSON.stringify({audio: 'AQID', context_id: 'ctx'})); });
  });
  const bridge = {config: {ttsSpeed: 0.95}, stats: {}, adapter: {speechTarget: () => ({url: `ws://127.0.0.1:${upstream.address().port}`, headers: {'xi-api-key': 'private-key'}})}, close() {}};
  const local = new WebSocketServer({port: 0, host: '127.0.0.1'}); await once(local, 'listening');
  let relay;
  local.on('connection', ws => { relay = relaySpeech(ws, bridge); });
  t.after(() => { relay?.close(); for (const ws of upstream.clients) ws.terminate(); upstream.close(); for (const ws of local.clients) ws.terminate(); local.close(); });
  const client = new WebSocket(`ws://127.0.0.1:${local.address().port}`); await once(client, 'open');
  const audio = once(client, 'message');
  client.send(JSON.stringify({context_id: 'ctx', text: 'Hi.', flush: true}));
  assert.equal(JSON.parse((await audio)[0]).audio, 'AQID');
  assert.equal(seen[0].voice_settings.speed, 0.95);
  assert.deepEqual(bridge.stats, {tts: {speed: 0.95, contexts: 1}});
  assert(!JSON.stringify(bridge.stats).includes('private-key'));
});

test('the speech endpoint requires its live call token and closes with that call', async () => {
  const config = validatePhoneConfig({...base, ttsSpeed: 0.95, pathPrefix: '/voice'});
  let socket, ttsSocket; const receipts = [];
  const server = await servePhone(config, {port: 0, host: '127.0.0.1', record: async receipt => receipts.push(receipt),
    provider: new PhoneNumber(config, async () => new Response(JSON.stringify({sid: 'RE' + '8'.repeat(32)}), {status: 201})),
    socketFactory: () => socket = new FakeSocket(), speechSocketFactory: (url, options) => {
      assert.match(url, /^wss:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\//);
      assert.equal(new URL(url).searchParams.get('output_format'), 'ulaw_8000');
      assert.equal(options.headers['xi-api-key'], base.ttsApiKey);
      ttsSocket = new FakeSocket(); setImmediate(() => ttsSocket.emit('open')); return ttsSocket;
    }});
  const speech = token => new WebSocket(`ws://127.0.0.1:${server.port}/voice/speak/multi-stream-input`, {headers: {'xi-api-key': token}});
  const refused = token => new Promise(resolve => { const ws = speech(token); ws.on('error', () => resolve(true)); ws.on('open', () => { ws.close(); resolve(false); }); });
  try {
    assert(await refused('x'.repeat(43)));
    const id = 'CA' + '5'.repeat(32), params = new URLSearchParams({AccountSid: config.accountSid, To: config.number, CallSid: id, From: '+15551230009'});
    const ticket = (await (await fetch(`http://127.0.0.1:${server.port}/incoming`, {method: 'POST', body: params,
      headers: {'x-twilio-signature': twilioSignature(config.authToken, config.origin + '/incoming', params)}})).text()).match(/value="([a-f0-9]+)"/)[1];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/voice/media`, {headers: {'x-twilio-signature': twilioSignature(config.authToken, config.origin + '/voice/media')}}); await once(ws, 'open');
    ws.send(JSON.stringify({event: 'start', start: {accountSid: config.accountSid, callSid: id, streamSid: 'MZ' + '4'.repeat(32), customParameters: {ticket}, mediaFormat: {encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1}}}));
    await wait(() => socket); socket.receive({type: 'Welcome'});
    const endpoint = socket.events.find(e => e.type === 'Settings').agent.speak.endpoint;
    assert.equal(endpoint.url, 'wss://phone.example.com/voice/speak/multi-stream-input');
    assert(!JSON.stringify(endpoint).includes(base.ttsApiKey));
    const token = endpoint.headers['xi-api-key'], spoken = speech(token); await once(spoken, 'open');
    assert(await refused(token)); // one upstream socket at a time for the call
    spoken.send(JSON.stringify({context_id: 'ctx', text: 'Hello.'}));
    await wait(() => ttsSocket?.events.length);
    assert.equal(ttsSocket.events[0].voice_settings.speed, 0.95);
    ws.close(); await wait(() => server.capacity().calls === 0);
    assert(await refused(token));
    assert.equal(receipts[0].ttsSpeed, 0.95); assert.equal(receipts[0].tts.contexts, 1);
    assert.equal(spoken.readyState, WebSocket.CLOSED);
  } finally { await server.close(); }
});

test('malformed, binary and oversized TTS frames fail closed without echoing their content', () => {
  for (const [raw, binary] of [[Buffer.from('not-json private-secret'), false], [Buffer.from('private-secret'), true], [Buffer.alloc(256001, 65), false]]) {
    const client = new FakeSocket(), upstream = new FakeSocket(); upstream.readyState = WebSocket.CONNECTING;
    let closed = 0, finished = 0;
    const bridge = {config: {ttsSpeed: 0.95}, stats: {}, adapter: {speechTarget: () => ({url: 'wss://api.elevenlabs.io/fixed', headers: {}})}, close() { closed++; }};
    relaySpeech(client, bridge, {socketFactory: () => upstream, finished: () => finished++});
    client.emit('message', raw, binary);
    assert.equal(closed, 1); assert.equal(finished, 1);
    assert.equal(bridge.stats.providerError, 'TTS_CONNECTION_FAILED');
    assert.equal(upstream.events.length, 0);
    assert(!JSON.stringify(bridge.stats).includes('private-secret'));
  }
});
