import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {servePhone, twilioSignature, validatePhoneConfig, withCaller, contextRoom} from '../src/phone.mjs';
import {PhoneNumber} from '../src/phone-provider.mjs';
import {httpContext, liveContext, phonePlugins, validateContextBinding} from '../src/phone-plugin-tools.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';

const config = {apiKey: 'sk-synthetic123456789', accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com', instructions: 'Synthetic line'};
const streamSid = 'MZ' + '4'.repeat(32), caller = '+15551230002';
const wait = async fn => {for (let i = 0; i < 200; i++) {if (fn()) return; await new Promise(r => setTimeout(r, 10));} throw Error('Timed out');};

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

// A listener with, unless `noProvider`, a context provider `run` that is asked with each call.
async function listener(t, {run, deadlineMs = 400, noProvider = false, line = {}} = {}) {
  const sockets = [], receipts = [], asked = [];
  const contextProvider = noProvider ? undefined : {deadlineMs, run: async (call, signal) => {asked.push(call); return run(call, signal);}};
  const server = await servePhone({...config, ...line, contextProvider}, {port: 0, host: '127.0.0.1', provider: new PhoneNumber(config, async () => new Response('{}', {status: 201})),
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

test('the caller context is asked as the call arrives, from the call itself, and its answer is what the model is told', async t => {
  const {session, receipts, asked} = await answered(t, {run: async () => ({status: 'available', text: 'FRESH: 1 Dummy Lane; the owner named about $850,000.'})});
  assert.equal(asked.length, 1);
  assert.deepEqual(Object.keys(asked[0]).sort(), ['direction', 'id', 'line', 'remote', 'started_at']);
  assert.equal(asked[0].remote, caller); assert.equal(asked[0].line, config.number); assert.equal(asked[0].direction, 'in');
  assert.match(session.instructions, /matches a conversation we had[^]*FRESH: 1 Dummy Lane/);
  assert.equal(receipts[0].callerContext, true);
  assert.equal(receipts[0].callerContextLive.status, 'available'); assert.ok(Number.isInteger(receipts[0].callerContextLive.milliseconds));
  assert.equal(JSON.stringify(receipts).includes('FRESH'), false); // a receipt never holds the context's text
  assert.equal(receipts[0].inputBytes, 160); // the audio sent right behind the start was held, then reached the call
});

test('no_match, a failure or a late answer leaves the call with the line\'s instructions alone, and the receipt says which', async t => {
  for (const [name, run, status] of [['no match', async () => ({status: 'no_match'}), 'no_match'], ['an error', async () => {throw Error('down');}, 'unavailable'],
    ['an unavailable answer', async () => ({status: 'unavailable'}), 'unavailable'], ['a late answer', () => new Promise(() => {}), 'timeout']]) {
    const heard = await answered(t, {run, deadlineMs: 120});
    assert.match(heard.session.instructions, /matches nothing we have on record/, name);
    assert.equal(heard.receipts[0].callerContext, false, name); assert.equal(heard.receipts[0].callerContextLive.status, status, name);
  }
});

test('the live answer alone is the context, and the only tool is end_call', async t => {
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

test('a context binding is an HTTP(S) endpoint with a token and a deadline, and the config carries it', () => {
  const binding = {url: 'http://172.17.0.1:18182/agent/call/context', token: 'a'.repeat(32), deadlineMs: 3000};
  assert.deepEqual(validateContextBinding(binding), binding);
  assert.deepEqual(validateContextBinding({...binding, url: 'https://backend.example.com/context'}).url, 'https://backend.example.com/context');
  for (const bad of [undefined, {...binding, deadlineMs: 100}, {...binding, deadlineMs: 20000}, {...binding, token: 'short'}, {...binding, token: 'has space ' + 'a'.repeat(20)},
    {...binding, url: 'ftp://x/y'}, {...binding, url: 'not a url'}, {...binding, url: 'https://user:pw@host/x'}, {...binding, extra: 1}, {url: binding.url, token: binding.token},
    {...binding, url: ['http://172.17.0.1:18182/agent/call/context']}]) {
    assert.throws(() => validateContextBinding(bad), /Invalid phone context binding/);
  }
  const base = {apiKey: 'sk-synthetic123456789', accountSid: config.accountSid, authToken: config.authToken, number: config.number, origin: config.origin};
  assert.deepEqual(validatePhoneConfig({...base, contextBinding: binding}).contextBinding, binding);
  assert.throws(() => validatePhoneConfig({...base, contextBinding: {...binding, deadlineMs: 1}}), /Invalid phone context binding/);
});

test('the backend is posted the call and its answer is bound to it', async () => {
  const call = {id: 'CA' + '7'.repeat(32), remote: caller, line: config.number, direction: 'in', started_at: '2026-11-04T12:00:00.000Z'};
  const binding = {url: 'http://172.17.0.1:18182/agent/call/context', token: 'a'.repeat(32), deadlineMs: 3000};
  const seen = [];
  const backend = (status, body) => httpContext(binding, async (url, init) => {seen.push({url, init}); return new Response(typeof body === 'string' ? body : JSON.stringify(body), {status});});
  const ok = backend(200, {call_id: call.id, status: 'available', context: {text: 'known'}});
  assert.deepEqual(await ok.run(call), {status: 'available', text: 'known'});
  assert.equal(seen[0].url, binding.url); assert.equal(seen[0].init.method, 'POST'); assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.authorization, 'Bearer ' + binding.token); assert.deepEqual(JSON.parse(seen[0].init.body), {call});
  // The ask tells the backend how much room the session has left, so it answers with the fullest text that fits.
  assert.deepEqual(await ok.run(call, undefined, 1600), {status: 'available', text: 'known'});
  assert.deepEqual(JSON.parse(seen.at(-1).init.body), {call, max_chars: 1600});
  assert.deepEqual(await backend(200, '\uFEFF' + JSON.stringify({call_id: call.id, status: 'available', context: {text: 'bom'}})).run(call), {status: 'available', text: 'bom'});
  assert.deepEqual(await backend(200, {call_id: call.id, status: 'no_match'}).run(call), {status: 'no_match'});
  assert.deepEqual(await backend(200, {call_id: call.id, status: 'unavailable', error: 'unknown_call_line'}).run(call), {status: 'unavailable'});
  const accents = 'é'.repeat(2500);
  assert.deepEqual(await backend(200, {call_id: call.id, status: 'available', context: {text: accents}}).run(call), {status: 'available', text: accents});
  for (const [status, body] of [[503, {error: 'database_unavailable'}], [401, {error: 'unauthorized'}], [200, {call_id: 'CA' + '8'.repeat(32), status: 'available', context: {text: 'x'}}],
    [200, {call_id: call.id, status: 'available', context: {text: ''}}], [200, {call_id: call.id, status: 'available', context: {text: 'x'.repeat(6001)}}],
    [200, {call_id: call.id, status: 'maybe'}], [200, 'not json'], [200, 'x'.repeat(40001)]]) {
    await assert.rejects(backend(status, body).run(call), String(status) + JSON.stringify(body).slice(0, 40));
  }
});

test('the room a call leaves for the caller context is what its line\'s instructions do not take of the session', () => {
  const text = 'x'.repeat(13000);
  const room = contextRoom(text, 16000);
  assert(room >= 400 && room < 3000);
  // a context of exactly that size reaches the model whole; one more character is cut
  assert(withCaller(text, 'c'.repeat(room), 16000).includes('c'.repeat(room)));
  assert(withCaller(text, 'c'.repeat(room), 16000).length <= 16000);
  assert.equal(contextRoom('x'.repeat(15900), 16000), undefined); // no room worth asking for
  assert.equal(contextRoom('short', 16000), 6000); // never more than the backend takes
});

test('a live ask settles by its deadline whatever the backend does, and never rejects', async () => {
  const began = Date.now();
  const hung = await liveContext({deadlineMs: 100, run: () => new Promise(() => {})}, {id: 'CA' + '9'.repeat(32)});
  assert.equal(hung.status, 'timeout'); assert.ok(Date.now() - began < 1000);
  assert.equal((await liveContext({deadlineMs: 100, run: async () => {throw Error('x');}}, {})).status, 'unavailable');
  assert.equal((await liveContext({deadlineMs: 100, run: async () => ({status: 'available', text: 'ok'})}, {})).status, 'available');
});

// The ask against real servers: what a mock that ignores the abort signal cannot show.
const serve = async (t, handler) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/context`;
};
const realCall = {id: 'CA' + '6'.repeat(32), remote: caller, line: config.number, direction: 'in', started_at: '2026-11-04T12:00:00.000Z'};
const TOKEN = 'tok-' + 'z'.repeat(28);
const bound = (url, deadlineMs = 3000) => ({url, token: TOKEN, deadlineMs});
const ask = (url, deadlineMs) => liveContext(httpContext(bound(url, deadlineMs)), realCall);

test('a real backend is posted the call with the bearer token and its answer is used', async t => {
  let seen;
  const url = await serve(t, (request, response) => { let body = ''; request.on('data', c => body += c).on('end', () => {
    seen = {method: request.method, authorization: request.headers.authorization, body: JSON.parse(body)};
    response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({call_id: realCall.id, status: 'available', context: {text: 'known'}}));
  }); });
  const answer = await ask(url);
  assert.equal(answer.status, 'available'); assert.equal(answer.text, 'known');
  assert.deepEqual(seen, {method: 'POST', authorization: 'Bearer ' + TOKEN, body: {call: realCall}});
});

test('a refused connection leaves the call without context at once', async () => {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const url = `http://127.0.0.1:${probe.address().port}/context`; probe.close(); await once(probe, 'close');
  const answer = await ask(url, 5000);
  assert.equal(answer.status, 'unavailable'); assert.ok(answer.ms < 1500, String(answer.ms));
});

test('a redirect is not followed: the other host sees no request and no token', async t => {
  const hits = [];
  const other = await serve(t, (request, response) => { hits.push(request.headers); response.end('{}'); });
  const url = await serve(t, (request, response) => { response.writeHead(302, {location: other}); response.end(); });
  const answer = await ask(url);
  assert.equal(answer.status, 'unavailable'); assert.deepEqual(hits, []);
});

test('a backend that never stops sending costs the cap, not memory, and the connection is closed early', async t => {
  let written = 0, closed;
  const closedPromise = new Promise(resolve => { closed = resolve; });
  const url = await serve(t, async (request, response) => {
    request.resume(); response.writeHead(200, {'content-type': 'application/json'});
    response.on('close', closed);
    const chunk = Buffer.alloc(65536, 0x20);
    while (!response.destroyed) { written += chunk.length; if (!response.write(chunk)) await Promise.race([once(response, 'drain'), closedPromise]); }
  });
  const answer = await ask(url, 5000);
  assert.equal(answer.status, 'unavailable'); assert.ok(answer.ms < 2500, `settled at ${answer.ms} ms, not by the 5000 ms deadline`);
  await Promise.race([closedPromise, new Promise((_, reject) => setTimeout(() => reject(Error('connection left open')), 2000))]);
  assert.ok(written < 16 * 1024 * 1024, `the backend sent ${written} bytes before the connection closed`);
});

test('an answer that declares more than the cap is refused before it is read', async t => {
  const url = await serve(t, (request, response) => { request.resume(); response.writeHead(200, {'content-length': 500000}); response.write('{'); });
  const answer = await ask(url, 5000);
  assert.equal(answer.status, 'unavailable'); assert.ok(answer.ms < 1500, String(answer.ms));
});

test('a body that stalls is cut at the deadline', async t => {
  const url = await serve(t, (request, response) => { request.resume(); response.writeHead(200, {'content-type': 'application/json'}); response.write('{"call_id":'); });
  const answer = await ask(url, 500);
  assert.equal(answer.status, 'timeout'); assert.ok(answer.ms >= 450 && answer.ms < 1500, String(answer.ms));
});

test('the token is in no answer and no error', async t => {
  for (const respond of [r => { r.writeHead(500); r.end(TOKEN); }, r => { r.writeHead(200); r.end('not json ' + TOKEN); }]) {
    const url = await serve(t, (request, response) => { request.resume(); respond(response); });
    assert.ok(!JSON.stringify(await ask(url)).includes(TOKEN));
  }
  for (const bad of [{...bound('http://x/y'), deadlineMs: 1}, {...bound('ftp://x/y')}, {alias: 'a', invoke: ['b'], token: TOKEN, deadlineMs: 3000}]) {
    assert.throws(() => validateContextBinding(bad), error => !String(error.message).includes(TOKEN));
  }
});

test('an old alias/invoke binding is refused with a message that names the new form', () => {
  assert.throws(() => validateContextBinding({alias: 'quarre', invoke: ['call', 'context', '-'], deadlineMs: 3000}), /contextBinding is now \{url, token, deadlineMs\}.*alias\/invoke/);
  assert.throws(() => validatePhoneConfig({apiKey: 'sk-synthetic123456789', accountSid: config.accountSid, authToken: config.authToken, number: config.number, origin: config.origin,
    contextBinding: {alias: 'quarre', invoke: ['call', 'context', '-'], deadlineMs: 3000}}), /contextBinding is now/);
});

test('a context binding alone builds the provider without attaching to the Ez connection', async () => {
  const before = ['data', 'end', 'readable'].map(event => process.stdin.listenerCount(event));
  const out = await phonePlugins(null, null, bound('http://127.0.0.1:9/context'));
  assert.deepEqual(['data', 'end', 'readable'].map(event => process.stdin.listenerCount(event)), before);
  assert.equal(out.contextProvider.deadlineMs, 3000); assert.equal(out.information, undefined); assert.equal(out.advisor, undefined);
});
