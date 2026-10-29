import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {servePhone, twilioSignature, phoneCommand} from '../src/phone.mjs';
import {PhoneContexts, tokens} from '../src/phone-contexts.mjs';
import {PhoneAudio} from '../src/phone-audio.mjs';
import {PhoneNumber} from '../src/phone-provider.mjs';
import {servePhoneControl} from '../src/phone-calls.mjs';

const config = {apiKey: 'sk-synthetic123456789', accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com', instructions: 'Synthetic line'};
const streamSid = 'MZ' + '4'.repeat(32);
const wait = async fn => {for (let i = 0; i < 100; i++) {if (fn()) return; await new Promise(r => setTimeout(r, 10));} throw Error('Timed out');};
const entry = (number, extra = {}) => ({number, text: 'Gary owns 1450 East 102nd Street; we texted him on Oct 27.', claim: 'We have a conversation on record about that property.', find: '1450 East 102nd Street', ...extra});

class ProviderSocket extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; events = [];
  constructor() {super(); setImmediate(() => this.emit('open'));}
  send(raw) {
    const event = JSON.parse(raw); this.events.push(event);
    if (event.type === 'session.start') setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({type: 'session.started', session: {id: 'live_synthetic'}}))));
    if (event.type === 'session.close') setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({type: 'session.closed', usage: {seconds: 1}}))));
  }
  close() {this.readyState = WebSocket.CLOSED; this.emit('close');}
  terminate() {this.close();}
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'voice-contexts-'));
  const contexts = new PhoneContexts(directory);
  t.after(async () => {contexts.close(); await rm(directory, {recursive: true, force: true});});
  return {directory, contexts};
}

test('an address is compared by its words: abbreviations, ordinals and filler do not matter', () => {
  assert.deepEqual(tokens('the house at 1450 E. 102nd St, Brooklyn'), ['1450', 'east', '102', 'street']);
  assert.deepEqual(tokens('1450 East 102nd Street'), ['1450', 'east', '102', 'street']);
});

test('the prepared set is private, replaced whole, validated and read by number or by the address named', async t => {
  const {directory, contexts} = await fixture(t);
  assert.equal((await stat(join(directory, 'contexts.sqlite'))).mode & 0o777, 0o600);
  assert.deepEqual(contexts.status(), {count: 0, latest: null});
  contexts.replace([entry('+15551230002'), entry('+15551230003', {find: '88 Jay Street', text: 'Another case.'})]);
  assert.equal(contexts.status().count, 2);
  assert.match(contexts.byNumber('+15551230002'), /Gary owns/); assert.equal(contexts.byNumber('+15551230009'), undefined);
  assert.equal(contexts.byNumber('not a number'), undefined);
  // a street name alone, a house number alone, or a different house number name nothing
  assert.deepEqual(contexts.search('1450 East 102nd St'), ['We have a conversation on record about that property.']);
  assert.deepEqual(contexts.search('the house at 1450 e 102nd street in brooklyn').length, 1);
  assert.deepEqual(contexts.search('East 102nd Street'), []);
  assert.deepEqual(contexts.search('1450'), []);
  assert.deepEqual(contexts.search('1451 East 102nd Street'), []);
  assert.deepEqual(contexts.search(undefined), []);
  // a caller with two properties is found by either
  contexts.replace([entry('+15551230005', {find: '1450 East 102nd Street; 88 Jay Street, Brooklyn'})]);
  assert.equal(contexts.search('88 Jay St').length, 1); assert.equal(contexts.search('1450 East 102nd').length, 1);
  assert.equal(contexts.search('1450 Jay Street').length, 0);
  contexts.replace([entry('+15551230002'), entry('+15551230003', {find: '88 Jay Street', text: 'Another case.'})]);
  // the whole set is replaced atomically: an invalid entry changes nothing, a number left out is forgotten
  assert.throws(() => contexts.replace([entry('+15551230004'), {...entry('+15551230005'), text: ''}]), /Invalid caller context/);
  assert.equal(contexts.status().count, 2);
  assert.throws(() => contexts.replace([entry('+15551230004'), entry('+15551230004')]), /Invalid caller context/);
  assert.throws(() => contexts.replace([{...entry('+15551230004'), extra: 1}]), /Invalid caller context/);
  contexts.replace([entry('+15551230004')]);
  assert.equal(contexts.byNumber('+15551230002'), undefined); assert.equal(contexts.status().count, 1);
});

test('an inbound call from a known number is answered with its context; an unknown number gets the line alone', async t => {
  const {contexts} = await fixture(t);
  contexts.replace([entry('+15551230002')]);
  const sockets = [], receipts = [];
  const server = await servePhone(config, {port: 0, host: '127.0.0.1', contexts, provider: new PhoneNumber(config, async () => new Response('{}', {status: 201})),
    socketFactory: () => sockets[sockets.length] = new ProviderSocket(), record: async r => {receipts.push(r);}});
  try {
    for (const [n, [from, id]] of [['+15551230002', 'CA' + '5'.repeat(32)], ['+15551230099', 'CA' + '6'.repeat(32)]].entries()) {
      const params = new URLSearchParams({AccountSid: config.accountSid, To: config.number, From: from, CallSid: id});
      const response = await fetch(`http://127.0.0.1:${server.port}/incoming`, {method: 'POST', body: params,
        headers: {'x-twilio-signature': twilioSignature(config.authToken, config.origin + '/incoming', params)}});
      const ticket = (await response.text()).match(/value="([a-f0-9]+)"/)[1];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/media`, {headers: {'x-twilio-signature': twilioSignature(config.authToken, config.origin + '/media')}});
      await new Promise((resolve, reject) => {ws.once('open', resolve); ws.once('error', reject);});
      ws.send(JSON.stringify({event: 'start', start: {accountSid: config.accountSid, callSid: id, streamSid, customParameters: {ticket}, mediaFormat: {encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1}}}));
      await wait(() => sockets[n]?.events[0]);
      const last = sockets[n];
      if (from === '+15551230002') {
        const known = last.events[0].session;
        assert(known.instructions.startsWith('Synthetic line')); assert.match(known.instructions, /Caller context[^]*Gary owns 1450 East 102nd Street/);
        // the caller can also name a property, so the call declares the lookup
        assert.deepEqual(known.delegation.responses.tools.map(tool => tool.name), ['end_call', 'find_case']);
        assert.match(known.instructions, /find_case/);
      } else {
        assert.equal(last.events[0].session.instructions.includes('Gary'), false); assert.match(last.events[0].session.instructions, /find_case/);
      }
      ws.close(); await wait(() => receipts.length === (from === '+15551230002' ? 1 : 2));
    }
    assert.deepEqual(receipts.map(r => r.callerContext), [true, false]);
    assert.equal(JSON.stringify(receipts).includes('Gary'), false);
  } finally {await server.close();}
});

async function bridge(settings) {
  let provider; const twilioSocket = Object.assign(new EventEmitter(), {readyState: WebSocket.OPEN, bufferedAmount: 0, sent: [], send(raw) {this.sent.push(JSON.parse(raw));}, close() {this.readyState = WebSocket.CLOSED;}});
  const audio = new PhoneAudio(twilioSocket, {...config, streamSid, idleSeconds: 0, ...settings}, async () => {}, {socketFactory: () => provider = new ProviderSocket()});
  await wait(() => provider?.events.some(e => e.type === 'session.start')); await new Promise(r => setTimeout(r, 20));
  return {audio, emit: event => provider.emit('message', Buffer.from(JSON.stringify(event))), provider};
}
const call = (call_id, name, args) => ({type: 'response.event', delegation_id: 'item_1', event: {type: 'response.output_item.done', item: {type: 'function_call', call_id, name, arguments: JSON.stringify(args)}}});

test('find_case answers with the claims of the property named, a few tries a call, and only where the call can look cases up', async t => {
  const {contexts} = await fixture(t);
  contexts.replace([entry('+15551230002')]);
  const {audio, emit, provider} = await bridge({lookup: query => contexts.search(query)});
  const outputs = () => provider.events.filter(e => e.type === 'response.item.create').map(e => JSON.parse(e.item.output));
  try {
    emit(call('c1', 'find_case', {query: '1450 East 102nd Street'}));
    emit(call('c2', 'find_case', {query: '5 Main Street'}));
    emit(call('c3', 'find_case', {query: 'nothing'}));
    emit(call('c4', 'find_case', {query: '1450 East 102nd Street'}));
    await wait(() => outputs().length === 4);
    assert.deepEqual(outputs(), [{found: true, matches: ['We have a conversation on record about that property.']}, {found: false}, {found: false}, {error: 'too_many_lookups'}]);
    assert.equal(audio.stats.lookups, 3); assert.deepEqual(audio.stats.tools, ['find_case', 'find_case', 'find_case', 'find_case']);
  } finally {await audio.close('test_done');}
  // an outbound call (or a line without contexts) declares no lookup and refuses it
  const plain = await bridge({});
  try {
    assert.deepEqual(plain.provider.events.find(e => e.type === 'session.start').session.delegation.responses.tools.map(tool => tool.name), ['end_call']);
    plain.emit(call('c1', 'find_case', {query: '1450 East 102nd Street'}));
    await wait(() => plain.provider.events.some(e => e.type === 'response.item.create'));
    assert.deepEqual(JSON.parse(plain.provider.events.find(e => e.type === 'response.item.create').item.output), {error: 'unknown_tool'});
  } finally {await plain.audio.close('test_done');}
});

test('phone context replaces the set through the running service and reads its status', async t => {
  const state = await mkdtemp(join(tmpdir(), 'voice-state-'));
  t.after(() => rm(state, {recursive: true, force: true}));
  const store = new PhoneContexts(join(state, 'phone')); t.after(() => store.close());
  const served = await servePhoneControl(join(state, 'phone'), frame => frame.action === 'contexts-replace' ? store.replace(frame.entries) : store.status());
  try {
    const replaced = await phoneCommand(state, ['context', 'replace'], {stdin: Readable.from([JSON.stringify([entry('+15551230002'), entry('+15551230003')])])});
    assert.equal(replaced.count, 2);
    assert.equal((await phoneCommand(state, ['context', 'status'])).count, 2);
    await assert.rejects(() => phoneCommand(state, ['context', 'append']), /Use phone context/);
  } finally {await served.close();}
});

test('every provider hands a tool call\'s arguments to the bridge, and declares find_case only when the call can look cases up', async () => {
  const {createAdapter} = await import('../src/phone-providers/index.mjs');
  const make = (provider, model, voice, extra = {}) => createAdapter({...config, provider, model, voice, apiKey: provider === 'openai' ? config.apiKey : provider === 'gemini' ? 'AIza' + 'x'.repeat(35) : 'sk_' + 'x'.repeat(40), ...extra});
  const eleven = make('elevenlabs', 'eleven_realtime_v1_max', 'voice1');
  assert.deepEqual(eleven.parse({type: 'response.output_item.done', item: {type: 'function_call', call_id: 'c1', name: 'find_case', arguments: '{"query":"1450 East 102nd"}'}}),
    [{type: 'tool', id: 'c1', name: 'find_case', args: '{"query":"1450 East 102nd"}'}]);
  const gemini = make('gemini', 'gemini-3.8-live', 'Kore');
  assert.deepEqual(gemini.parse({toolCall: {functionCalls: [{id: 'g1', name: 'find_case', args: {query: '1450 East 102nd'}}]}}), [{type: 'tool', id: 'g1', name: 'find_case', args: {query: '1450 East 102nd'}}]);
  const names = adapter => JSON.stringify(adapter.start() ?? adapter.configure()).includes('find_case');
  assert.equal(names(make('gemini', 'gemini-3.8-live', 'Kore')), false);
  assert.equal(names(make('gemini', 'gemini-3.8-live', 'Kore', {lookup: () => []})), true);
  assert.equal(JSON.stringify(eleven.configure()).includes('find_case'), false);
  assert.equal(JSON.stringify(make('elevenlabs', 'eleven_realtime_v1_max', 'voice1', {lookup: () => []}).configure()).includes('find_case'), true);
});
