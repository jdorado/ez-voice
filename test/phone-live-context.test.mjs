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

// A listener with a prepared table of `entries` and, unless `noProvider`, a live provider `run` that is asked with each call.
async function listener(t, {entries = [], run, deadlineMs = 400, noProvider = false, line = {}} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'voice-live-context-'));
  const contexts = new PhoneContexts(directory);
  if (entries.length) contexts.replace(entries);
  t.after(async () => {contexts.close(); await rm(directory, {recursive: true, force: true});});
  const sockets = [], receipts = [], asked = [];
  const contextProvider = noProvider ? undefined : {deadlineMs, run: async (call, signal) => {asked.push(call); return run(call, signal);}};
  const server = await servePhone({...config, ...line, contextProvider}, {port: 0, host: '127.0.0.1', contexts, provider: new PhoneNumber(config, async () => new Response('{}', {status: 201})),
    socketFactory: () => sockets[sockets.length] = new ProviderSocket(), record: async r => {receipts.push(r);}});
  t.after(() => server.close());
  return {server, sockets, receipts, asked};
}
// The Twilio webhook for one inbound call from `caller`; resolves to the call's ticket.
async function ring(server, id = 'CA' + '5'.repeat(32)) {
  const params = new URLSearchParams({AccountSid: config.accountSid, To: config.number, From: caller, CallSid: id});
  const response = await fetch(`http://127.0.0.1:${server.port}/incoming`, {method: 'POST', body: params,
    headers: {'x-twilio-signature': twilioSignature(config.authToken, config.origin + '/incoming', params)}});
  const text = await response.text();
  return {id, ticket: text.match(/value="([a-f0-9]+)"/)?.[1], status: response.status, text};
}
async function stream(server) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/media`, {headers: {'x-twilio-signature': twilioSignature(config.authToken, config.origin + '/media')}});
  await new Promise((resolve, reject) => {ws.once('open', resolve); ws.once('error', reject);});
  return ws;
}
const start = (ws, id, ticket) => ws.send(JSON.stringify({event: 'start', start: {accountSid: config.accountSid, callSid: id, streamSid, customParameters: {ticket}, mediaFormat: {encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1}}}));
const media = ws => ws.send(JSON.stringify({event: 'media', media: {payload: Buffer.alloc(160, 0xff).toString('base64')}}));
const pause = ms => new Promise(r => setTimeout(r, ms));

// One inbound call from `caller`: resolves to what the model was told, with the audio sent right behind the start.
async function answered(t, options) {
  const heard = await listener(t, options);
  const {id, ticket} = await ring(heard.server);
  const ws = await stream(heard.server);
  start(ws, id, ticket); media(ws);
  await wait(() => heard.sockets[0]?.events[0]);
  const session = heard.sockets[0].events[0].session;
  ws.close(); await wait(() => heard.receipts.length === 1);
  return {...heard, session};
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
  assert.equal(receipts[0].inputBytes, 160); // the audio sent right behind the start was held, then reached the call
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

test('a caller who hangs up while the live answer is pending gets no speech session, by closing or by a queued stop', async t => {
  const slow = () => new Promise(resolve => setTimeout(() => resolve({status: 'available', text: 'FRESH'}), 150));
  for (const how of ['close', 'stop']) {
    const heard = await listener(t, {run: slow, deadlineMs: 400});
    const {id, ticket} = await ring(heard.server);
    const ws = await stream(heard.server);
    start(ws, id, ticket); media(ws);
    if (how === 'close') ws.close(); else ws.send(JSON.stringify({event: 'stop'}));
    await pause(500);
    assert.equal(heard.sockets.length, 0, how); assert.equal(heard.receipts.length, 0, how);
    assert.equal(heard.server.capacity().tickets, 0, how); // the place is free again
    ws.close();
  }
});

test('a ticket starts one call, also while its live answer is pending', async t => {
  const heard = await listener(t, {run: () => new Promise(resolve => setTimeout(() => resolve({status: 'available', text: 'FRESH'}), 150))});
  const {id, ticket} = await ring(heard.server);
  const [first, second] = [await stream(heard.server), await stream(heard.server)];
  start(first, id, ticket); start(second, id, ticket);
  await wait(() => heard.sockets[0]?.events[0]); await pause(300);
  assert.equal(heard.sockets.length, 1);
  first.close(); second.close(); await wait(() => heard.receipts.length === 1); await pause(100);
  assert.equal(heard.receipts.length, 1);
});

test('without a context binding a start is handled the moment it arrives, even if the caller closes right behind it', async t => {
  const heard = await listener(t, {noProvider: true});
  const {id, ticket} = await ring(heard.server);
  const ws = await stream(heard.server);
  start(ws, id, ticket); ws.close();
  await wait(() => heard.receipts.length === 1);
  assert.equal(heard.sockets.length, 1);
});

test('a refused call asks the backend nothing', async t => {
  const heard = await listener(t, {run: async () => ({status: 'available', text: 'FRESH'}), line: {instructions: undefined, instructionsFiles: ['missing.md'], instructionsRoot: tmpdir()}});
  const refused = await ring(heard.server);
  assert.match(refused.text, /Reject/); assert.equal(heard.asked.length, 0);
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
  const accents = 'é'.repeat(2500); // within the text limit, but escaped as \u00e9 it is 15,000 characters of stdout
  assert.deepEqual(await installedContext(binding, core(() => ({code: 0, stdout: JSON.stringify({call_id: call.id, status: 'available', context: {text: accents}}).replace(/é/g, '\\u00e9')}))).run(call), {status: 'available', text: accents});
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
