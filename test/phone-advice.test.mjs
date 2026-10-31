import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import WebSocket from 'ws';
import {PhoneAudio} from '../src/phone-audio.mjs';
import {PhoneAdvice, MAX_NOTES} from '../src/phone-advice.mjs';
import {relayThink} from '../src/phone-think.mjs';
import {installedAdvice} from '../src/phone-plugin-tools.mjs';
import {servePhone, twilioSignature, validatePhoneConfig} from '../src/phone.mjs';
import {PhoneNumber} from '../src/phone-provider.mjs';
import {createAdapter} from '../src/phone-providers/index.mjs';

const keys = {deepgram: 'c'.repeat(40), llmApiKey: 'AIza' + 'b'.repeat(35), ttsApiKey: 'sk_' + 'a'.repeat(24)};
const base = {accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com',
  instructions: 'Synthetic coach test', provider: 'deepgram', apiKey: keys.deepgram, llmApiKey: keys.llmApiKey, ttsApiKey: keys.ttsApiKey};
const advice = (id = 'timing') => ({id, text: `Approved example ${id}.`, source: 'https://example.com/source', source_revision: 'a'.repeat(64), confidence: 0.9});
const binding = {alias: 'advice', invoke: ['evaluate', '-'], deadlineMs: 2000};
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const wait = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('Timed out'); };
const request = text => ({systemInstruction: {parts: [{text: 'Persona.'}]}, contents: [{role: 'model', parts: [{text: 'Hi.'}]}, {role: 'user', parts: [{text}]}]});

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; events = [];
  constructor() {super(); setImmediate(() => this.emit('open'));}
  send(raw) {this.events.push(Buffer.isBuffer(raw) ? raw : JSON.parse(raw));}
  receive(event) {this.emit('message', Buffer.from(JSON.stringify(event)));}
  close() {this.readyState = WebSocket.CLOSED; this.emit('close', 1000);}
  terminate() {this.close();}
}

test('a coached Deepgram line relays its model requests and the latest note rides on each, never its prompt', async () => {
  let socket; const finished = [], requests = [];
  const twilio = {readyState: WebSocket.OPEN, bufferedAmount: 0, send() {}, close() {this.readyState = WebSocket.CLOSED;}};
  const think = {url: 'https://phone.example.com/think/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse', token: 't'.repeat(43)};
  const audio = new PhoneAudio(twilio, {...base, think, streamSid: 'MZ' + '4'.repeat(32), call: {id: 'CA' + '9'.repeat(32)},
    advisor: {deadlineMs: 2000, run: async r => { requests.push(r); return {status: 'available', advice: advice()}; }}}, async s => { finished.push(s); },
    {socketFactory: () => socket = new FakeSocket()});
  try {
    await tick(); socket.receive({type: 'Welcome'});
    const settings = socket.events.find(e => e.type === 'Settings');
    assert.deepEqual(settings.agent.think.endpoint, {url: think.url, headers: {authorization: `Bearer ${think.token}`}});
    assert(!JSON.stringify(settings).includes(keys.llmApiKey)); // the language-model key stays with the relay
    assert.deepEqual(audio.adapter.thinkTarget().headers, {'x-goog-api-key': keys.llmApiKey});
    assert.deepEqual(audio.think(request('Hello?')), request('Hello?')); // no pick yet
    socket.receive({type: 'ConversationText', role: 'user', content: 'Not now, maybe next year.'});
    await tick(); await tick();
    assert.equal(requests[0].text, 'Not now, maybe next year.');
    const sent = audio.think(request('What would you pay?'));
    assert.deepEqual(sent.contents.at(-1).parts[0], {text: 'What would you pay?'});
    assert.match(sent.contents.at(-1).parts[1].text, /^Coach note, a private reference[^]*Approved example timing\./);
    assert.deepEqual(sent.systemInstruction, {parts: [{text: 'Persona.'}]});
    // A request that continues after a tool call carries no note.
    const followUp = {contents: [...request('x').contents, {role: 'model', parts: [{functionCall: {name: 'read_record'}}]}, {role: 'user', parts: [{functionResponse: {name: 'read_record'}}]}]};
    assert.equal(audio.think(followUp), followUp);
    // Nothing went over the speech socket: no prompt update, injected turn or reply request.
    assert(!socket.events.some(e => ['UpdatePrompt', 'InjectUserMessage', 'InjectAgentMessage'].includes(e.type)));
    await audio.close();
    assert.equal(finished[0].advice[0].status, 'sent'); assert.equal(finished[0].advice[0].requests, 1);
    assert(!JSON.stringify(finished[0].advice).includes('Approved example'));
  } finally { await audio.close(); }
});

test('GPT-Live: the note joins the session context when the caller next speaks, never mid-reply', async () => {
  let socket; const finished = [], requests = [];
  const twilio = {readyState: WebSocket.OPEN, bufferedAmount: 0, send() {}, close() {this.readyState = WebSocket.CLOSED;}};
  const audio = new PhoneAudio(twilio, {...base, provider: 'openai', apiKey: 'sk-synthetic123456789', llmApiKey: undefined, ttsApiKey: undefined,
    streamSid: 'MZ' + '4'.repeat(32), call: {id: 'CA' + '9'.repeat(32)},
    advisor: {deadlineMs: 2000, run: async r => { requests.push(r); return {status: 'available', advice: advice()}; }}}, async s => { finished.push(s); },
    {socketFactory: () => socket = new FakeSocket()});
  try {
    await tick();
    socket.receive({type: 'session.input_transcript.delta', delta: 'I already have '});
    socket.receive({type: 'session.input_transcript.delta', delta: 'a broker.'});
    socket.receive({type: 'session.output_transcript.delta', delta: 'Understood.'});
    await tick(); await tick(); await tick();
    assert.equal(requests[0].text, 'I already have a broker.');
    assert(!socket.events.some(e => e.type === 'session.instructions.append')); // the model is answering
    socket.receive({type: 'session.output_transcript.delta', delta: ' Goodbye.'});
    socket.receive({type: 'session.input_transcript.delta', delta: 'Wait, what would you pay?'});
    const notes = socket.events.filter(e => e.type === 'session.instructions.append');
    assert.equal(notes.length, 1); assert.equal(notes[0].delegation_id, null); assert.match(notes[0].event_id, /^adv_[a-f0-9]{24}$/);
    assert.match(notes[0].content, /^Coach note 1, replacing any earlier coach note[^]*Approved example timing\./);
    socket.receive({type: 'session.input_transcript.delta', delta: ' Seriously.'});
    assert.equal(socket.events.filter(e => e.type === 'session.instructions.append').length, 1); // once per note
    socket.receive({type: 'session.instructions.appended', client_event_id: notes[0].event_id});
    const closed = audio.close(); socket.receive({type: 'session.closed'}); await closed;
    assert.deepEqual([finished[0].advice[0].status, finished[0].advice[0].acknowledged], ['sent', true]);
    assert(!JSON.stringify(finished[0].advice).includes('Approved example'));
  } finally { await audio.close(); }
});

test('session notes stay within the provider limit and the call budget', async () => {
  let n = 0; const s = coach(async () => ({status: 'available', advice: advice(`pick${n++}`)}));
  for (let i = 0; i <= MAX_NOTES; i++) { s.hook.heard(`turn ${i}`, []); await tick(); await tick(); s.hook.push(1800); }
  assert.equal(s.receipts.filter(r => r.status === 'sent').length, MAX_NOTES); assert.equal(s.receipts.at(-1).status, 'no_room');
  const long = coach(async () => ({status: 'available', advice: advice()}));
  long.hook.heard('hello', []); await tick(); await tick();
  assert.equal(long.hook.push(50), undefined); assert.equal(long.receipts[0].status, 'too_long');
});

test('the relay streams the model answer back and the provider never sees the key', async t => {
  let received;
  const upstream = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', async () => {
      received = {body: JSON.parse(body), key: req.headers['x-goog-api-key']};
      res.writeHead(200, {'Content-Type': 'text/event-stream'}); res.write('data: {"a":1}\n\n'); await tick(); res.end('data: {"b":2}\n\n');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r)); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const bridge = {think: body => ({...body, note: true}), adapter: {thinkTarget: () => ({url: `http://127.0.0.1:${upstream.address().port}/model`, headers: {'x-goog-api-key': 'key'}})}};
  const relay = createServer((req, res) => relayThink(req, res, bridge));
  await new Promise(r => relay.listen(0, '127.0.0.1', r)); t.after(() => { relay.closeAllConnections(); relay.close(); });
  const response = await fetch(`http://127.0.0.1:${relay.address().port}/think`, {method: 'POST', body: JSON.stringify({contents: []})});
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(await response.text(), 'data: {"a":1}\n\ndata: {"b":2}\n\n');
  assert.deepEqual(received, {body: {contents: [], note: true}, key: 'key'});
  const failing = createServer((req, res) => relayThink(req, res, {...bridge, adapter: {thinkTarget: () => ({url: 'http://127.0.0.1:1/x', headers: {}})}}));
  await new Promise(r => failing.listen(0, '127.0.0.1', r)); t.after(() => { failing.closeAllConnections(); failing.close(); });
  assert.equal((await fetch(`http://127.0.0.1:${failing.address().port}/think`, {method: 'POST', body: '{}'})).status, 502);
});

test('the listener relays only for a live coached call, by its own token', async () => {
  const config = validatePhoneConfig({...base, advice: true, adviceBinding: binding});
  const upstream = []; let socket;
  const server = await servePhone({...config, advisor: {deadlineMs: 2000, run: async () => ({status: 'no_match'})}}, {port: 0, host: '127.0.0.1',
    provider: new PhoneNumber(config, async () => new Response(JSON.stringify({sid: 'RE' + '8'.repeat(32)}), {status: 201})),
    socketFactory: () => socket = new FakeSocket(),
    fetch: async (url, options) => { upstream.push({url, key: options.headers['x-goog-api-key']}); return new Response('data: {}\n\n', {headers: {'Content-Type': 'text/event-stream'}}); }});
  const think = token => fetch(`http://127.0.0.1:${server.port}/think/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`,
    {method: 'POST', headers: {authorization: `Bearer ${token}`}, body: JSON.stringify(request('hi'))});
  try {
    assert.equal((await think('x'.repeat(43))).status, 403);
    const id = 'CA' + '5'.repeat(32), params = new URLSearchParams({AccountSid: config.accountSid, To: config.number, CallSid: id, From: '+15551230009'});
    const ticket = (await (await fetch(`http://127.0.0.1:${server.port}/incoming`, {method: 'POST', body: params,
      headers: {'x-twilio-signature': twilioSignature(config.authToken, config.origin + '/incoming', params)}})).text()).match(/value="([a-f0-9]+)"/)[1];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/media`, {headers: {'x-twilio-signature': twilioSignature(config.authToken, config.origin + '/media')}});
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({event: 'start', start: {accountSid: config.accountSid, callSid: id, streamSid: 'MZ' + '4'.repeat(32), customParameters: {ticket},
      mediaFormat: {encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1}}}));
    await wait(() => socket); await tick(); socket.receive({type: 'Welcome'});
    const endpoint = socket.events.find(e => e.type === 'Settings').agent.think.endpoint;
    assert.equal(endpoint.url, `${config.origin}/think/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`);
    const token = endpoint.headers.authorization.slice(7);
    const answered = await think(token);
    assert.equal(answered.status, 200); assert.equal(await answered.text(), 'data: {}\n\n');
    assert.deepEqual(upstream, [{url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse', key: keys.llmApiKey}]);
    ws.close(); await wait(() => server.capacity().calls === 0);
    assert.equal((await think(token)).status, 403); // the token ends with its call
  } finally { await server.close(); }
});

function coach(run, deadlineMs = 2000) {
  const receipts = [];
  return {hook: new PhoneAdvice({call: {id: 'call'}, run, deadlineMs, receipts}), receipts};
}

test('the latest pick wins: an overtaken or unused pick is never attached, the same pick is kept', async () => {
  const a = deferred(), b = deferred(), c = deferred();
  const s = coach(r => ({A: a, B: b, C: c})[r.text].promise);
  s.hook.heard('A', []); s.hook.heard('B', []);
  b.resolve({status: 'available', advice: advice('broker')}); await tick(); await tick();
  a.resolve({status: 'available', advice: advice('timing')}); await tick(); await tick();
  assert.match(s.hook.note().text, /broker/);
  s.hook.heard('C', []); c.resolve({status: 'available', advice: advice('price')}); await tick(); await tick();
  assert.deepEqual(s.receipts.map(r => r.status), ['superseded', 'unused', 'ready']);
  s.hook.attached(s.hook.note()); s.hook.attached(s.hook.note());
  assert.deepEqual([s.receipts[2].status, s.receipts[2].requests], ['sent', 2]);
  const same = coach(async () => ({status: 'available', advice: advice('broker')}));
  same.hook.heard('one', []); await tick(); await tick(); same.hook.heard('two', []); await tick(); await tick();
  assert.deepEqual(same.receipts.map(r => r.status), ['ready', 'unchanged']);
  same.hook.close(); assert.equal(same.receipts[0].status, 'unused'); assert.equal(same.hook.note(), undefined);
});

test('a slow, failed or closed lookup leaves no note', async () => {
  const slow = coach((_, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))), 20);
  slow.hook.heard('hello', []); await new Promise(r => setTimeout(r, 40));
  assert.equal(slow.receipts[0].status, 'timeout'); assert.equal(slow.hook.note(), undefined);
  const late = deferred(), closed = coach(() => late.promise);
  closed.hook.heard('hello', []); closed.hook.close();
  late.resolve({status: 'available', advice: advice()}); await tick(); await tick();
  assert.equal(closed.receipts[0].status, 'closed'); assert.equal(closed.hook.note(), undefined);
  const failed = coach(async () => { throw Error('down'); }); failed.hook.heard('hello', []); await tick(); await tick();
  assert.equal(failed.receipts[0].status, 'unavailable');
  const none = coach(async () => ({status: 'no_match'})); none.hook.heard('hello', []); await tick(); await tick();
  assert.equal(none.receipts[0].status, 'no_match'); assert.equal(none.hook.note(), undefined);
});

test('the installed command is bound to the call and turn and returns only an approved note', async () => {
  let params; const req = {call: {id: 'origin'}, turn: 2};
  const core = {request: async (_, p) => { params = p; return {code: 0, stdout: JSON.stringify({call_id: 'origin', turn: 2, status: 'available', advice: advice(), tools: ['send_sms']})}; }};
  const out = await installedAdvice(binding, core).run(req);
  assert.deepEqual(params.args, binding.invoke); assert.equal(JSON.parse(params.stdin).turn, 2);
  assert.deepEqual(Object.keys(out.advice).sort(), ['confidence', 'id', 'source', 'source_revision', 'text']); assert.equal(out.tools, undefined);
  await assert.rejects(installedAdvice(binding, core).run({...req, turn: 3}), /binding mismatch/);
  assert.throws(() => installedAdvice({...binding, deadlineMs: 100}, core), /advice binding/);
});

test('advice is explicit per line and needs the installed binding and a provider that takes a note', () => {
  const line = {...base, advice: true};
  assert.throws(() => validatePhoneConfig(line), /adviceBinding/);
  assert.equal(validatePhoneConfig({...line, adviceBinding: binding}).advice, true);
  assert.equal(validatePhoneConfig({...base, provider: 'openai', apiKey: 'sk-synthetic123456789', llmApiKey: undefined, ttsApiKey: undefined, advice: true, adviceBinding: binding}).advice, true);
  assert.throws(() => validatePhoneConfig({...base, provider: 'elevenlabs', apiKey: 'sk_' + 'a'.repeat(24), llmApiKey: undefined, ttsApiKey: undefined, advice: true, adviceBinding: binding}), /during a call \(openai, deepgram\)/);
  assert.equal(createAdapter({...base}).settings().agent.think.endpoint.headers['x-goog-api-key'], keys.llmApiKey); // an uncoached line calls Google
});
