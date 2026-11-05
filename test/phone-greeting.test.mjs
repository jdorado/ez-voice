import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import WebSocket from 'ws';
import {servePhone, twilioSignature, validatePhoneConfig} from '../src/phone.mjs';
import {PhoneNumber} from '../src/phone-provider.mjs';
import {createAdapter} from '../src/phone-providers/index.mjs';
import {InstructionsError, greetingFromFile} from '../src/phone-instructions.mjs';

const keys = {deepgram: 'c'.repeat(40), llmApiKey: 'AIza' + 'b'.repeat(35), ttsApiKey: 'sk_' + 'a'.repeat(24)};
const base = {accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com', answerTone: 'none',
  provider: 'deepgram', apiKey: keys.deepgram, llmApiKey: keys.llmApiKey, ttsApiKey: keys.ttsApiKey, instructionsFiles: ['persona.md'], instructionsRoot: '/state/agent'};
// The file reader uses /proc/self/fd, so its stories run on Linux (CI, Docker) like the instruction files'.
const linux = (name, fn) => nodeTest(name, {skip: process.platform !== 'linux'}, fn);
const wait = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('Timed out'); };
const tick = () => new Promise(r => setImmediate(r));
class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; events = [];
  send(raw) { this.events.push(Buffer.isBuffer(raw) ? raw : JSON.parse(raw)); }
  receive(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1000); }
  terminate() { this.close(); }
}

nodeTest('greetingFile is a Deepgram line setting that needs instruction files', () => {
  assert.equal(validatePhoneConfig({...base, greetingFile: 'agent/greeting.txt'}).lines[0].greetingFile, 'agent/greeting.txt');
  for (const bad of ['/etc/passwd', '../x', 'a//b', '', 7, 'a\\b']) assert.throws(() => validatePhoneConfig({...base, greetingFile: bad}), /greetingFile/);
  assert.throws(() => validatePhoneConfig({...base, instructionsFiles: undefined, instructionsRoot: undefined, instructions: 'x', greetingFile: 'g.txt'}), /greetingFile/);
  assert.throws(() => validatePhoneConfig({...base, provider: 'openai', apiKey: 'sk-synthetic123456789', llmApiKey: undefined, ttsApiKey: undefined, greetingFile: 'g.txt'}), /deepgram only/);
});

nodeTest('a line with a fixed greeting has Deepgram speak it at once, with no model-written greeting', () => {
  const fixed = createAdapter({...validatePhoneConfig(base).lines[0], greeting: 'Hi, this is Sharon with Quarre.'});
  assert.deepEqual(fixed.greet(), [{type: 'InjectAgentMessage', message: 'Hi, this is Sharon with Quarre.'}]);
  // what Deepgram says of its own greeting is the model's words in the transcript, not a transport turn to hide
  assert.deepEqual(fixed.parse({type: 'ConversationText', role: 'assistant', content: 'Hi, this is Sharon with Quarre.'}).map(i => i.type), ['speech']);
  const written = createAdapter(validatePhoneConfig(base).lines[0]);
  assert.equal(written.greet()[0].type, 'InjectUserMessage');
});

async function folder(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'voice-greeting-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), text); }
  return root;
}

linux('the greeting file is read fresh, trimmed, and an unreadable or oversized one fails naming it', async t => {
  const root = await folder(t, {'agent/greeting.txt': ' Hi, this is Sharon with Quarre. How can I help you today?\n', 'agent/long.txt': 'x'.repeat(301), 'agent/empty.txt': '  \n'});
  const read = path => greetingFromFile({instructionsRoot: root, greetingFile: path}, 300);
  assert.equal(await read('agent/greeting.txt'), 'Hi, this is Sharon with Quarre. How can I help you today?');
  await writeFile(join(root, 'agent/greeting.txt'), 'Hello there.');
  assert.equal(await read('agent/greeting.txt'), 'Hello there.');
  for (const [path, reason] of [['agent/missing.txt', 'missing'], ['agent/long.txt', 'too_large'], ['agent/empty.txt', 'empty']])
    await assert.rejects(read(path), error => error instanceof InstructionsError && error.reason === reason && error.path === path);
  await assert.rejects(greetingFromFile({instructionsRoot: root + '-gone', greetingFile: 'g.txt'}, 300), /root_unavailable/);
});

linux('an inbound call is greeted from the file at once; an outbound call and a line without the file are not', async t => {
  const root = await folder(t, {'persona.md': 'You are Sharon.', 'agent/greeting.txt': 'Hi, this is Sharon with Quarre. How can I help you today?'});
  const config = validatePhoneConfig({...base, instructionsRoot: root, greetingFile: 'agent/greeting.txt'});
  const sockets = [], receipts = [];
  const server = await servePhone(config, {port: 0, host: '127.0.0.1', provider: new PhoneNumber(config, async () => new Response('{}', {status: 201})),
    socketFactory: () => { const s = new FakeSocket(); sockets.push(s); setImmediate(() => s.emit('open')); return s; }, record: async r => { receipts.push(r); }});
  const open = [];
  t.after(async () => { for (const ws of open) ws.terminate(); await server.close(); });
  let n = 0;
  const ring = async () => {
    const id = 'CA' + String(++n).padStart(32, '0'), params = new URLSearchParams({AccountSid: base.accountSid, CallSid: id, To: base.number, From: '+15551230009'});
    const xml = await (await fetch(`http://127.0.0.1:${server.port}/incoming`, {method: 'POST', body: params, headers: {'x-twilio-signature': twilioSignature(base.authToken, base.origin + '/incoming', params)}})).text();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/media`, {headers: {'x-twilio-signature': twilioSignature(base.authToken, base.origin + '/media')}}); open.push(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({event: 'start', start: {accountSid: base.accountSid, callSid: id, streamSid: 'MZ' + String(n).padStart(32, '0'), customParameters: {ticket: xml.match(/value="([a-f0-9]+)"/)[1]}, mediaFormat: {encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1}}}));
    await wait(() => sockets[n - 1]); await tick(); sockets[n - 1].receive({type: 'Welcome'});
    await wait(() => sockets[n - 1].events.some(e => e.type === 'Settings')); sockets[n - 1].receive({type: 'SettingsApplied'});
    return {ws, socket: sockets[n - 1]};
  };
  const call = await ring();
  await wait(() => call.socket.events.some(e => e.type === 'InjectAgentMessage'));
  assert.equal(call.socket.events.find(e => e.type === 'InjectAgentMessage').message, 'Hi, this is Sharon with Quarre. How can I help you today?');
  assert(!call.socket.events.some(e => e.type === 'InjectUserMessage'));
  const before = receipts.length; call.ws.close(); await wait(() => receipts.length > before);
  assert.equal(receipts.at(-1).greetingFixed, true);
});
