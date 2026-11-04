import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {servePhone, twilioSignature, validatePhoneConfig} from '../src/phone.mjs';
import {PhoneContexts} from '../src/phone-contexts.mjs';
import {PhoneNumber} from '../src/phone-provider.mjs';
import {installedContext, liveContext, validateContextBinding} from '../src/phone-plugin-tools.mjs';

const config = {apiKey: 'sk-synthetic123456789', accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com', instructions: 'Synthetic line'};
const streamSid = 'MZ' + '4'.repeat(32), caller = '+15551230002';
const wait = async fn => {for (let i = 0; i < 200; i++) {if (fn()) return; await new Promise(r => setTimeout(r, 10));} throw Error('Timed out');};
const stale = {number: caller, text: 'STALE: Gary owns 1450 East 102nd Street.', claim: 'We have a conversation on record about that property.', find: '1450 East 102nd Street'};

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

// One inbound call from `caller`, with the live provider `run` and a prepared table of `entries`; resolves to what the model was told.
async function answered(t, {entries = [], run, deadlineMs = 400, hangUpEarly = false}) {
  const directory = await mkdtemp(join(tmpdir(), 'voice-live-context-'));
  const contexts = new PhoneContexts(directory);
  if (entries.length) contexts.replace(entries);
  t.after(async () => {contexts.close(); await rm(directory, {recursive: true, force: true});});
  const sockets = [], receipts = [], asked = [];
  const contextProvider = {deadlineMs, run: async (call, signal) => {asked.push(call); return run(call, signal);}};
  const server = await servePhone({...config, contextProvider}, {port: 0, host: '127.0.0.1', contexts, provider: new PhoneNumber(config, async () => new Response('{}', {status: 201})),
    socketFactory: () => sockets[sockets.length] = new ProviderSocket(), record: async r => {receipts.push(r);}});
  t.after(() => server.close());
  const id = 'CA' + '5'.repeat(32);
  const params = new URLSearchParams({AccountSid: config.accountSid, To: config.number, From: caller, CallSid: id});
  const response = await fetch(`http://127.0.0.1:${server.port}/incoming`, {method: 'POST', body: params,
    headers: {'x-twilio-signature': twilioSignature(config.authToken, config.origin + '/incoming', params)}});
  const ticket = (await response.text()).match(/value="([a-f0-9]+)"/)[1];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/media`, {headers: {'x-twilio-signature': twilioSignature(config.authToken, config.origin + '/media')}});
  await new Promise((resolve, reject) => {ws.once('open', resolve); ws.once('error', reject);});
  ws.send(JSON.stringify({event: 'start', start: {accountSid: config.accountSid, callSid: id, streamSid, customParameters: {ticket}, mediaFormat: {encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1}}}));
  // audio behind the start waits for it, in order
  ws.send(JSON.stringify({event: 'media', media: {payload: Buffer.alloc(160, 0xff).toString('base64')}}));
  if (hangUpEarly) {ws.close(); await new Promise(r => setTimeout(r, deadlineMs + 100)); return {sockets, receipts, asked, server};}
  await wait(() => sockets[0]?.events[0]);
  const session = sockets[0].events[0].session;
  ws.close(); await wait(() => receipts.length === 1);
  return {session, receipts, asked, sockets, server};
}

test('the caller context is asked as the call arrives, from the call itself, and its answer replaces a stale prepared one', async t => {
  const {session, receipts, asked} = await answered(t, {entries: [stale], run: async () => ({status: 'available', text: 'FRESH: 1 Dummy Lane; the owner named about $850,000.'})});
  assert.equal(asked.length, 1);
  assert.deepEqual(Object.keys(asked[0]).sort(), ['direction', 'id', 'line', 'remote', 'started_at']);
  assert.equal(asked[0].remote, caller); assert.equal(asked[0].line, config.number); assert.equal(asked[0].direction, 'in');
  assert.match(session.instructions, /matches a conversation we had[^]*FRESH: 1 Dummy Lane/);
  assert.equal(session.instructions.includes('STALE'), false);
  assert.equal(receipts[0].callerContext, true);
  assert.equal(receipts[0].callerContextLive.status, 'available'); assert.ok(Number.isInteger(receipts[0].callerContextLive.milliseconds));
  assert.equal(JSON.stringify(receipts).includes('FRESH'), false); // a receipt never holds the context's text
});

test('the live answer is the records\' own word: no_match drops a stale prepared text, a failure keeps it', async t => {
  const none = await answered(t, {entries: [stale], run: async () => ({status: 'no_match'})});
  assert.equal(none.session.instructions.includes('STALE'), false); assert.match(none.session.instructions, /matches nothing we have prepared/);
  assert.equal(none.receipts[0].callerContext, false); assert.equal(none.receipts[0].callerContextLive.status, 'no_match');
  for (const [name, run, status] of [['an error', async () => {throw Error('down');}, 'unavailable'], ['an unavailable answer', async () => ({status: 'unavailable'}), 'unavailable'],
    ['a late answer', () => new Promise(() => {}), 'timeout']]) {
    const kept = await answered(t, {entries: [stale], run, deadlineMs: 120});
    assert.match(kept.session.instructions, /STALE: Gary owns/, name); assert.equal(kept.receipts[0].callerContext, true, name);
    assert.equal(kept.receipts[0].callerContextLive.status, status, name);
  }
});

test('with no prepared table at all the live answer alone is the context, and find_case is not declared', async t => {
  const {session, receipts} = await answered(t, {run: async () => ({status: 'available', text: 'FRESH: only the live answer.'})});
  assert.match(session.instructions, /FRESH: only the live answer/);
  assert.deepEqual(session.delegation.responses.tools.map(tool => tool.name), ['end_call']);
  assert.equal(receipts[0].callerContext, true);
});

test('a caller who hangs up while the live answer is pending gets no speech session', async t => {
  const {sockets, receipts} = await answered(t, {run: () => new Promise(resolve => setTimeout(() => resolve({status: 'available', text: 'FRESH'}), 150)), deadlineMs: 400, hangUpEarly: true});
  assert.equal(sockets.length, 0); assert.equal(receipts.length, 0);
});

test('a context binding is one literal command with a deadline, and the config carries it', () => {
  const binding = {alias: 'quarre', invoke: ['call', 'context', '-'], deadlineMs: 3000};
  assert.deepEqual(validateContextBinding(binding), binding);
  for (const bad of [undefined, {...binding, deadlineMs: 100}, {...binding, deadlineMs: 20000}, {...binding, invoke: []}, {...binding, alias: 'Bad Alias'}, {...binding, extra: 1}, {alias: 'quarre', invoke: ['x']}]) {
    assert.throws(() => validateContextBinding(bad), /Invalid phone context binding/);
  }
  const base = {apiKey: 'sk-synthetic123456789', accountSid: config.accountSid, authToken: config.authToken, number: config.number, origin: config.origin};
  assert.deepEqual(validatePhoneConfig({...base, contextBinding: binding}).contextBinding, binding);
  assert.throws(() => validatePhoneConfig({...base, contextBinding: {...binding, deadlineMs: 1}}), /Invalid phone context binding/);
});

test('the installed command is given the call and its answer is bound to it', async () => {
  const call = {id: 'CA' + '7'.repeat(32), remote: caller, line: config.number, direction: 'in', started_at: '2026-11-04T12:00:00.000Z'};
  const seen = [];
  const core = reply => ({request: async (method, params) => {seen.push({method, params}); return reply(params);}});
  const binding = {alias: 'quarre', invoke: ['call', 'context', '-'], deadlineMs: 3000};
  const ok = installedContext(binding, core(() => ({code: 0, stdout: JSON.stringify({call_id: call.id, status: 'available', context: {text: 'known'}})})));
  assert.deepEqual(await ok.run(call), {status: 'available', text: 'known'});
  assert.equal(seen[0].method, 'tools.invoke'); assert.deepEqual(seen[0].params.args, ['call', 'context', '-']); assert.deepEqual(JSON.parse(seen[0].params.stdin), {call});
  assert.deepEqual(await installedContext(binding, core(() => ({code: 0, stdout: JSON.stringify({call_id: call.id, status: 'no_match'})}))).run(call), {status: 'no_match'});
  for (const reply of [() => ({code: 1, stdout: ''}), () => ({code: 0, stdout: JSON.stringify({call_id: 'CA' + '8'.repeat(32), status: 'available', context: {text: 'x'}})}),
    () => ({code: 0, stdout: JSON.stringify({call_id: call.id, status: 'available', context: {text: ''}})}), () => ({code: 0, stdout: JSON.stringify({call_id: call.id, status: 'available', context: {text: 'x'.repeat(6001)}})}),
    () => ({code: 0, stdout: JSON.stringify({call_id: call.id, status: 'maybe'})}), () => ({code: 0, stdout: 'not json'})]) {
    await assert.rejects(installedContext(binding, core(reply)).run(call));
  }
});

test('a live ask settles by its deadline whatever the command does, and never rejects', async () => {
  const began = Date.now();
  const hung = await liveContext({deadlineMs: 100, run: () => new Promise(() => {})}, {id: 'CA' + '9'.repeat(32)});
  assert.equal(hung.status, 'timeout'); assert.ok(Date.now() - began < 1000);
  assert.equal((await liveContext({deadlineMs: 100, run: async () => {throw Error('x');}}, {})).status, 'unavailable');
  assert.equal((await liveContext({deadlineMs: 100, run: async () => ({status: 'available', text: 'ok'})}, {})).status, 'available');
});
