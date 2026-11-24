import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {servePhone, twilioSignature, validatePhoneConfig} from '../src/phone.mjs';
import {PhoneNumber} from '../src/phone-provider.mjs';
import {PhoneCalls, callOptions} from '../src/phone-calls.mjs';
import {httpTransfer} from '../src/phone-plugin-tools.mjs';
import {NOTES} from '../src/phone-transfer.mjs';
import {createAdapter} from '../src/phone-providers/index.mjs';

const accountSid = 'AC' + '1'.repeat(32), authToken = '2'.repeat(32), origin = 'https://phone.example.com', number = '+15551230001';
const caller = '+15551230002', personNumber = '+15551230009', callerId = '+15551230008', party = '+15551230007';
const callerSid = 'CA' + '5'.repeat(32), personSid = 'CA' + '6'.repeat(32), streamSid = 'MZ' + '4'.repeat(32);
const line = {accountSid, authToken, origin, number, instructions: 'Synthetic line', provider: 'deepgram', apiKey: 'c'.repeat(40),
  llmApiKey: 'AIza' + 'b'.repeat(35), ttsApiKey: 'sk_' + 'a'.repeat(24), idleSeconds: 0, answerTone: 'none', handoverMaxMs: 2000};
const binding = {url: 'https://ops.example.com/transfer', token: 't'.repeat(24), deadlineMs: 1000};
const wait = async fn => {for (let i = 0; i < 300; i++) {if (fn()) return; await new Promise(r => setTimeout(r, 10));} throw Error('Timed out');};
const conferenceSid = name => 'CF' + Buffer.from(name).toString('hex').padEnd(32, '0').slice(0, 32);
const available = {status: 'available', claim_id: 'claim-1', person: 'Juan', number: personNumber, caller_id: callerId};

class Deepgram extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; events = [];
  constructor() {super(); setImmediate(() => this.emit('open'));}
  send(raw) {this.events.push(Buffer.isBuffer(raw) ? raw : JSON.parse(raw));}
  receive(event) {this.emit('message', Buffer.from(JSON.stringify(event)), false);}
  close() {this.readyState = WebSocket.CLOSED; this.emit('close', 1000);}
  terminate() {this.close();}
}

// A listener on a deepgram line with a transfer backend (`answer` decides each backend reply) and a synthetic Twilio REST API.
async function listener(t, {answer = () => ({ok: true}), calls, settings = {}, callStatus = {}, bound = true} = {}) {
  const backend = [], twilio = [], receipts = [], sockets = [];
  const transfer = httpTransfer(binding, async (url, init) => {
    assert.equal(url, binding.url); assert.equal(init.headers.authorization, 'Bearer ' + binding.token);
    const body = JSON.parse(init.body); backend.push(body);
    return new Response(JSON.stringify(await answer(body)));
  });
  const provider = new PhoneNumber(line, async (url, options) => {
    const form = Object.fromEntries(new URLSearchParams(options.body ?? ''));
    twilio.push({path: url.replace(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}`, ''), form});
    if (url.endsWith('/Recordings.json')) return new Response(JSON.stringify({sid: 'RE' + '8'.repeat(32)}), {status: 201});
    if (url.includes('/Conferences.json?')) { const name = new URL(url).searchParams.get('FriendlyName'); return new Response(JSON.stringify({conferences: [{sid: conferenceSid(name), friendly_name: name}]})); }
    const call = url.match(/\/Calls\/(CA[0-9a-f]{32})\.json$/)?.[1];
    if (call && !options.body) return new Response(JSON.stringify({sid: call, status: callStatus[call] ?? 'in-progress'}));
    return new Response(JSON.stringify({sid: url.endsWith('/Calls.json') ? personSid : url.match(/(CA[0-9a-f]{32})/)[1]}), {status: 201});
  });
  const web = await servePhone({...line, ...settings, ...(bound && {transfer})}, {port: 0, host: '127.0.0.1', provider, calls,
    socketFactory: () => sockets[sockets.length] = new Deepgram(), record: async r => {receipts.push(r);}});
  t.after(() => web.close());
  return {web, backend, twilio, receipts, sockets};
}
const signed = (port, path, params) => fetch(`http://127.0.0.1:${port}${path}`, {method: 'POST', body: params,
  headers: {'x-twilio-signature': twilioSignature(authToken, origin + path, params)}});
// One answered inbound call with its Deepgram session ready; resolves to the Twilio media socket and what it received.
async function answered(heard) {
  const params = new URLSearchParams({AccountSid: accountSid, To: number, From: caller, CallSid: callerSid});
  const ticket = (await (await signed(heard.web.port, '/incoming', params)).text()).match(/value="([a-f0-9]+)"/)[1];
  const ws = new WebSocket(`ws://127.0.0.1:${heard.web.port}/media`, {headers: {'x-twilio-signature': twilioSignature(authToken, origin + '/media')}});
  const media = []; ws.on('message', raw => media.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {ws.once('open', resolve); ws.once('error', reject);});
  ws.send(JSON.stringify({event: 'start', start: {accountSid, callSid: callerSid, streamSid, customParameters: {ticket}, mediaFormat: {encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1}}}));
  await wait(() => heard.sockets[0]);
  const dg = heard.sockets[0];
  dg.receive({type: 'Welcome', request_id: 'dg'}); dg.receive({type: 'SettingsApplied'});
  await wait(() => dg.events.some(e => e.type === 'InjectUserMessage'));
  return {ws, media, dg};
}
const askTransfer = (dg, whisper = '12 Main St: the owner <Ann> wants to talk price.') =>
  dg.receive({type: 'FunctionCallRequest', functions: [{id: 'xfer', name: 'transfer_call', arguments: JSON.stringify({whisper}), client_side: true}]});
const notes = dg => dg.events.filter(e => e.type === 'InjectUserMessage').map(e => e.content).slice(1); // after the greeting
const personToken = twilio => new URL(twilio.find(r => r.path === '/Calls.json').form.Url).searchParams.get('t');
const personParams = (extra = {}) => new URLSearchParams({AccountSid: accountSid, CallSid: personSid, From: callerId, To: personNumber, ...extra});
const personDial = (room, token) => `<Dial action="https://phone.example.com/transfer/after?t=${token}" method="POST"><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="false" waitUrl="">${room}</Conference></Dial>`;
const ownerDial = room => `<Response><Dial><Conference beep="false" endConferenceOnExit="true">${room}</Conference></Dial></Response>`;
const callback = (heard, kind, extra) => signed(heard.web.port, `/transfer/${kind}?t=${personToken(heard.twilio)}`, personParams(extra));

test('transferBinding is a validated shared setting, and only a deepgram line with it declares transfer_call', () => {
  const {handoverMaxMs, ...stored} = line;
  const valid = validatePhoneConfig({...stored, transferBinding: binding});
  assert.deepEqual(valid.transferBinding, binding);
  assert.throws(() => validatePhoneConfig({...stored, transferBinding: {...binding, deadlineMs: 5001}}), /Invalid phone transfer binding/);
  assert.throws(() => validatePhoneConfig({...stored, transferBinding: {...binding, url: 'ftp://x'}}), /Invalid phone transfer binding/);
  const declared = config => createAdapter(config).settings().agent.think.functions.map(f => f.name);
  assert.deepEqual(declared(line), ['end_call']);
  const fn = createAdapter({...line, transfer: {}}).settings().agent.think.functions.find(f => f.name === 'transfer_call');
  assert.equal(fn.parameters.properties.whisper.maxLength, 300); assert.deepEqual(fn.parameters.required, ['whisper']);
  assert.deepEqual(callOptions('connect', ['--to', party, '--from', number, '--request-id', 'c1', '--whisper', '-']), {to: party, from: number, requestId: 'c1', whisper: '-'});
  assert.throws(() => callOptions('connect', ['--to', party, '--request-id', 'c1', '--whisper', '-']), /--from LINE/);
  assert.throws(() => callOptions('call', ['--to', party, '--request-id', 'c1', '--whisper', '-']), /Use phone call/);
});

test('a refused claim answers the model at once, rings nobody, and tells the model the colleague cannot join', async t => {
  const heard = await listener(t, {answer: () => ({status: 'busy'})});
  const {ws, dg} = await answered(heard);
  try {
    assert(dg.events.find(e => e.type === 'Settings').agent.think.functions.some(f => f.name === 'transfer_call'));
    askTransfer(dg);
    const result = dg.events.find(e => e.type === 'FunctionCallResponse' && e.id === 'xfer');
    assert.deepEqual(JSON.parse(result.content), {status: 'ringing', note: 'Ringing your colleague now. Keep the caller company; do not say goodbye.'});
    await wait(() => notes(dg).length === 1);
    assert.equal(notes(dg)[0], `(${NOTES.unavailable('busy')})`);
    assert.deepEqual(heard.backend, [{action: 'claim', call: {id: callerSid, call_sid: callerSid, line: number, number: caller, direction: 'inbound'}, whisper: '12 Main St: the owner <Ann> wants to talk price.'}]);
    assert(!heard.twilio.some(r => r.path === '/Calls.json'));
    // the note never shows as caller speech
    dg.receive({type: 'ConversationText', role: 'user', content: notes(dg)[0]});
    ws.close(); await wait(() => heard.receipts.length);
    assert.deepEqual(heard.receipts[0].transcript ?? [], []);
    assert.deepEqual(heard.receipts[0].transfers, [{status: 'busy'}]);
  } finally {ws.terminate();}
});

const said = (dg, role, content) => dg.receive({type: 'ConversationText', role, content});
const wordsPosts = heard => heard.backend.filter(b => b.action === 'words');

test('the call\'s words stream to the backend throttled, with one final ended post when the call closes', async t => {
  const heard = await listener(t);
  const {ws, dg} = await answered(heard);
  try {
    said(dg, 'user', 'Hi, who is this?');
    await wait(() => wordsPosts(heard).length === 1);
    const call = {call_sid: callerSid, line: number, number: caller};
    const first = wordsPosts(heard)[0];
    assert.deepEqual({...first, turns: first.turns.map(({who, text}) => ({who, text}))}, {action: 'words', call, turns: [{who: 'caller', text: 'Hi, who is this?'}], ended: false});
    assert(Number.isInteger(first.turns[0].atMs));
    said(dg, 'assistant', 'This is Quarre.'); said(dg, 'user', 'Okay.'); // inside the window: one trailing post carries both
    await new Promise(r => setTimeout(r, 300));
    assert.equal(wordsPosts(heard).length, 1);
    await wait(() => wordsPosts(heard).length === 2);
    assert.deepEqual(wordsPosts(heard)[1].turns.map(x => x.text), ['Hi, who is this?', 'This is Quarre.', 'Okay.']); assert.equal(wordsPosts(heard)[1].ended, false);
    said(dg, 'assistant', 'Let me connect you.');
    ws.close(); await wait(() => heard.receipts.length);
    await wait(() => wordsPosts(heard).at(-1).ended);
    assert.equal(wordsPosts(heard).length, 3);
    assert.equal(wordsPosts(heard)[2].turns.at(-1).text, 'Let me connect you.');
  } finally {ws.terminate();}
});

test('the words post keeps the last 40 turns', async t => {
  const heard = await listener(t);
  const {ws, dg} = await answered(heard);
  try {
    for (let i = 0; i < 25; i++) { said(dg, 'user', `caller ${i}`); said(dg, 'assistant', `model ${i}`); }
    ws.close(); await wait(() => wordsPosts(heard).some(b => b.ended));
    const turns = wordsPosts(heard).at(-1).turns;
    assert.equal(turns.length, 40); assert.equal(turns.at(-1).text, 'model 24');
  } finally {ws.terminate();}
});

test('nothing is streamed without a transfer binding, and a failing backend does not touch the call', async t => {
  const unbound = await listener(t, {bound: false});
  const a = await answered(unbound);
  try {
    said(a.dg, 'user', 'Hello'); a.ws.close(); await wait(() => unbound.receipts.length);
    assert.deepEqual(unbound.backend, []); assert.equal(unbound.receipts[0].transcript[0].text, 'Hello');
  } finally {a.ws.terminate();}
  const failing = await listener(t, {answer: body => { if (body.action === 'words') throw Error('down'); return {ok: true}; }});
  const b = await answered(failing);
  try {
    said(b.dg, 'user', 'Hello'); said(b.dg, 'assistant', 'Hi there.');
    await wait(() => wordsPosts(failing).length === 1);
    b.ws.close(); await wait(() => failing.receipts.length);
    await wait(() => wordsPosts(failing).at(-1).ended);
    assert.equal(failing.receipts[0].reason, 'caller_hangup'); assert.deepEqual(failing.receipts[0].transcript.map(x => x.text), ['Hello', 'Hi there.']);
  } finally {b.ws.terminate();}
});

test('a person who does not answer is released no_answer and the model is told they did not pick up', async t => {
  const heard = await listener(t, {answer: body => body.action === 'claim' ? available : {ok: true}});
  const {ws, dg} = await answered(heard);
  try {
    askTransfer(dg);
    await wait(() => heard.twilio.some(r => r.path === '/Calls.json'));
    const create = heard.twilio.find(r => r.path === '/Calls.json').form;
    assert.equal(create.To, personNumber); assert.equal(create.From, callerId); assert.equal(create.Timeout, '20');
    assert.equal(create.Record, 'true'); assert.equal(create.RecordingChannels, 'dual');
    assert.match(create.Url, /^https:\/\/phone\.example\.com\/transfer\/whisper\?t=[a-f0-9]{48}$/);
    assert.match(create.StatusCallback, /^https:\/\/phone\.example\.com\/transfer\/status\?t=[a-f0-9]{48}$/);
    // a second transfer while the first rings is refused
    dg.receive({type: 'FunctionCallRequest', functions: [{id: 'xfer2', name: 'transfer_call', arguments: '{"whisper":"again"}', client_side: true}]});
    assert.equal(JSON.parse(dg.events.find(e => e.id === 'xfer2').content).error, 'transfer_in_progress');
    // an unsigned or foreign callback is refused
    assert.equal((await fetch(`http://127.0.0.1:${heard.web.port}/transfer/status?t=${personToken(heard.twilio)}`, {method: 'POST', body: personParams({CallStatus: 'no-answer'})})).status, 403);
    assert.equal((await signed(heard.web.port, `/transfer/status?t=${'a'.repeat(48)}`, personParams({CallStatus: 'no-answer'}))).status, 403);
    assert.equal((await callback(heard, 'status', {CallStatus: 'no-answer'})).status, 204);
    await wait(() => notes(dg).length === 1);
    assert.equal(notes(dg)[0], `(${NOTES.missed})`);
    assert.deepEqual(heard.backend.at(-1), {action: 'release', claim_id: 'claim-1', result: 'no_answer', person_call_sid: personSid, person_ended: true});
    assert.equal((await callback(heard, 'status', {CallStatus: 'no-answer'})).status, 403); // settled and forgotten
    assert.equal(heard.backend.filter(b => b.action === 'release').length, 1);
  } finally {ws.terminate();}
});

test('a person who hears the whisper and presses another key declined', async t => {
  const heard = await listener(t, {answer: body => body.action === 'claim' ? available : {ok: true}});
  const {ws, dg} = await answered(heard);
  try {
    askTransfer(dg);
    await wait(() => heard.twilio.some(r => r.path === '/Calls.json'));
    const whisper = await (await callback(heard, 'whisper', {CallStatus: 'in-progress'})).text();
    assert.match(whisper, /^<Response><Gather input="dtmf" numDigits="1" timeout="8" method="POST" action="https:\/\/phone\.example\.com\/transfer\/confirm\?t=[a-f0-9]{48}"><Say>Quarre call for you\. Press 1 to join\.<\/Say><\/Gather><Hangup\/><\/Response>$/);
    assert.equal(await (await callback(heard, 'confirm', {Digits: '2'})).text(), '<Response><Hangup/></Response>');
    await callback(heard, 'status', {CallStatus: 'completed', CallDuration: '9'});
    await wait(() => heard.backend.some(b => b.action === 'release'));
    assert.equal(heard.backend.find(b => b.action === 'release').result, 'declined');
    assert(!heard.backend.some(b => b.action === 'joined'));
    await wait(() => notes(dg).length === 1);
  } finally {ws.terminate();}
});

test('a person who presses 1 joins a conference, the model hands over, and the caller is moved there and leaves the listener', async t => {
  const heard = await listener(t, {answer: body => body.action === 'claim' ? available : {ok: true}});
  const {ws, media, dg} = await answered(heard);
  try {
    askTransfer(dg);
    await wait(() => heard.twilio.some(r => r.path === '/Calls.json'));
    await callback(heard, 'whisper', {CallStatus: 'in-progress'});
    const joined = await (await callback(heard, 'confirm', {Digits: '1'})).text();
    const room = joined.match(/>(transfer-[a-f0-9]{24})</)[1];
    assert.equal(joined, `<Response>${personDial(room, personToken(heard.twilio))}</Response>`);
    await wait(() => heard.backend.some(b => b.action === 'joined'));
    assert.deepEqual(heard.backend.find(b => b.action === 'joined'), {action: 'joined', claim_id: 'claim-1', person_call_sid: personSid, room});
    await wait(() => notes(dg).length === 1);
    assert.equal(notes(dg)[0], `(${NOTES.joined})`);
    // the model's earlier reply finishing is not the handover; its reply to the note is
    dg.receive({type: 'AgentAudioDone'});
    assert(!media.some(m => m.event === 'mark'));
    dg.receive({type: 'ConversationText', role: 'user', content: notes(dg)[0]});
    dg.receive({type: 'ConversationText', role: 'assistant', content: 'Connecting you with Juan now.'});
    dg.emit('message', Buffer.alloc(160, 10), true);
    dg.receive({type: 'AgentAudioDone'});
    await wait(() => media.some(m => m.event === 'mark' && m.mark.name === 'transfer'));
    assert(!heard.twilio.some(r => r.path === `/Calls/${callerSid}.json`), 'the caller stays on the stream until the handover has played');
    ws.send(JSON.stringify({event: 'mark', mark: {name: 'transfer'}}));
    await wait(() => heard.receipts.length);
    const redirect = heard.twilio.find(r => r.path === `/Calls/${callerSid}.json`).form;
    assert.deepEqual(redirect, {Twiml: ownerDial(room), TimeLimit: '14400'});
    const receipt = heard.receipts[0];
    assert.equal(receipt.reason, 'transferred'); assert.equal(receipt.handover, 'played');
    assert.equal(receipt.transfer.person, 'Juan'); assert.equal(receipt.transfer.personCallSid, personSid); assert.ok(Date.parse(receipt.transfer.at));
    assert.deepEqual(receipt.transcript.map(x => x.text), ['Connecting you with Juan now.']);
    assert.equal(heard.web.capacity().calls, 0); // the listener's call slot is free
    assert(!heard.backend.some(b => b.action === 'release'));
    await callback(heard, 'status', {CallStatus: 'completed', CallDuration: '42'});
    await wait(() => heard.backend.some(b => b.action === 'release'));
    assert.deepEqual(heard.backend.find(b => b.action === 'release'), {action: 'release', claim_id: 'claim-1', result: 'completed', person_call_sid: personSid, seconds: 42, person_ended: true});
  } finally {ws.terminate();}
});

test('a caller who hangs up while the person rings cancels the person\'s call and releases the claim once, abandoned', async t => {
  const heard = await listener(t, {answer: body => body.action === 'claim' ? available : {ok: true}});
  const {ws, dg} = await answered(heard);
  askTransfer(dg);
  await wait(() => heard.twilio.some(r => r.path === '/Calls.json'));
  ws.close();
  await wait(() => heard.backend.some(b => b.action === 'release') && heard.twilio.some(r => r.path === `/Calls/${personSid}.json`));
  assert.deepEqual(heard.twilio.find(r => r.path === `/Calls/${personSid}.json`).form, {Status: 'canceled'});
  assert.deepEqual(heard.backend.find(b => b.action === 'release'), {action: 'release', claim_id: 'claim-1', result: 'abandoned', person_call_sid: personSid});
  assert.equal(await (await callback(heard, 'whisper', {CallStatus: 'in-progress'})).text(), '<Response><Hangup/></Response>');
  await callback(heard, 'status', {CallStatus: 'canceled'});
  await new Promise(r => setTimeout(r, 50));
  assert.equal(heard.backend.filter(b => b.action === 'release').length, 1);
  assert.equal(heard.receipts[0].reason, 'caller_hangup');
});

test('a placed call handed to a person reports transferred to call-status, over Twilio\'s later completed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-transfer-calls-'));
  const value = {sid: callerSid, account_sid: accountSid, from: number, to: caller, direction: 'outbound-api', status: 'queued'};
  const calls = new PhoneCalls(directory, line, {createCall: async () => ({...value}), getCall: async () => ({...value})});
  t.after(async () => {calls.close(); await rm(directory, {recursive: true, force: true});});
  await calls.call({requestId: 'placed', to: caller}, () => false);
  const transfer = {person: 'Juan', personCallSid: personSid, at: new Date().toISOString()};
  calls.transferred(callerSid, transfer);
  value.status = 'completed';
  assert.deepEqual(await calls.status('placed'), {requestId: 'placed', to: caller, from: number, callSid: callerSid, status: 'transferred', at: calls.row('placed').at, brief: false, transfer});
  assert.equal(calls.pendingCount(), 0);
});

test('phone connect rings the person, dials the party on 1, reports each status, and is idempotent; a refused claim keeps nothing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-connect-'));
  const calls = new PhoneCalls(directory, line, {});
  t.after(async () => {calls.close(); await rm(directory, {recursive: true, force: true});});
  let refuse = true;
  const heard = await listener(t, {calls, answer: body => body.action === 'claim' ? (refuse ? {status: 'off'} : available) : {ok: true}});
  const whisper = 'Owner of 12 Main St, wants an offer.';
  assert.deepEqual(await heard.web.transfers.connect({requestId: 'c1', to: party, from: number, whisper}), {requestId: 'c1', status: 'off', refused: true});
  assert.equal(heard.web.transfers.row('c1'), undefined);
  assert.deepEqual(heard.backend[0], {action: 'claim', call: {id: 'c1', call_sid: null, line: number, number: party, direction: 'connect'}, whisper});
  refuse = false;
  const created = await heard.web.transfers.connect({requestId: 'c1', to: party, from: number, whisper});
  assert.equal(created.created, true); assert.equal(created.status, 'ringing_person'); assert.equal(created.personCallSid, personSid); assert.equal(created.person, 'Juan');
  assert.equal((await heard.web.transfers.connect({requestId: 'c1', to: party, from: number, whisper})).created, false);
  await assert.rejects(() => heard.web.transfers.connect({requestId: 'c1', to: '+15551230006', from: number, whisper}), /different destination/);
  assert.equal(heard.twilio.filter(r => r.path === '/Calls.json').length, 1);
  assert.match(await (await callback(heard, 'whisper', {CallStatus: 'in-progress'})).text(), /<Say>Owner of 12 Main St, wants an offer\. Press 1 to join\.<\/Say>/);
  assert.equal(await (await callback(heard, 'confirm', {Digits: '1'})).text(), `<Response><Dial callerId="${number}" record="record-from-answer-dual" timeout="30"><Number>${party}</Number></Dial></Response>`);
  assert.equal(heard.web.transfers.status('c1').status, 'joined');
  await wait(() => heard.backend.some(b => b.action === 'joined'));
  await callback(heard, 'status', {CallStatus: 'completed', CallDuration: '120'});
  await wait(() => heard.backend.some(b => b.action === 'release'));
  assert.deepEqual(heard.backend.find(b => b.action === 'release'), {action: 'release', claim_id: 'claim-1', result: 'completed', person_call_sid: personSid, seconds: 120, person_ended: true});
  const done = heard.web.transfers.status('c1');
  assert.equal(done.status, 'completed'); assert.equal(done.seconds, 120);
  await assert.rejects(() => heard.web.transfers.connect({requestId: 'c2', to: party, from: '+15551230005', whisper}), /--from one of the configured lines/);
  await assert.rejects(() => heard.web.transfers.connect({requestId: 'c2', to: party, from: number, whisper: 'x'.repeat(301)}), /1\.\.300/);
});

// A person holding several owners: queued claims, take, back and the `after` return (src/phone-transfer.mjs).
const legSid = 'CA' + '9'.repeat(32), heldSid = 'CA' + '7'.repeat(32), otherSid = 'CA' + '3'.repeat(32);
const queued = {status: 'queued', claim_id: 'claim-1'};
const settle = ms => new Promise(r => setTimeout(r, ms));
// The model's reply to the handover note plays at Twilio and its mark comes back.
async function handOverPlayed({ws, media, dg}) {
  await wait(() => notes(dg).at(-1) === `(${NOTES.joined})`);
  dg.receive({type: 'ConversationText', role: 'user', content: notes(dg).at(-1)});
  dg.receive({type: 'ConversationText', role: 'assistant', content: 'Here is Juan now.'});
  dg.emit('message', Buffer.alloc(160, 10), true);
  dg.receive({type: 'AgentAudioDone'});
  await wait(() => media.some(m => m.event === 'mark' && m.mark.name === 'transfer'));
  ws.send(JSON.stringify({event: 'mark', mark: {name: 'transfer'}}));
}
// An available claim through 1 and the handover: the caller sits in the person's room; resolves to that room.
async function transferredCall(heard, call) {
  askTransfer(call.dg);
  await wait(() => heard.twilio.some(r => r.path === '/Calls.json'));
  await callback(heard, 'whisper', {CallStatus: 'in-progress'});
  const room = (await (await callback(heard, 'confirm', {Digits: '1'})).text()).match(/>(transfer-[a-f0-9]{24})</)[1];
  await handOverPlayed(call);
  await wait(() => heard.receipts.length);
  return room;
}
const participant = (heard, room, callSid) => heard.twilio.filter(r => r.path === `/Conferences/${conferenceSid(room)}/Participants/${callSid}.json`).map(r => r.form);
const redirectOf = (heard, callSid) => heard.twilio.find(r => r.path === `/Calls/${callSid}.json` && r.form.Twiml)?.form;

test('a queued claim keeps the caller company, polls, and rings the person with the whisper once they are free', async t => {
  let next = {status: 'wait'};
  const heard = await listener(t, {settings: {transferPollMs: 20}, answer: body => body.action === 'claim' ? queued : body.action === 'poll' ? next : {ok: true}});
  const call = await answered(heard);
  try {
    askTransfer(call.dg);
    await wait(() => notes(call.dg).length === 1);
    assert.equal(notes(call.dg)[0], `(${NOTES.queued})`);
    await wait(() => heard.backend.filter(b => b.action === 'poll').length >= 2);
    assert.deepEqual(heard.backend.find(b => b.action === 'poll'), {action: 'poll', claim_id: 'claim-1'});
    assert(!heard.twilio.some(r => r.path === '/Calls.json'));
    next = {status: 'ring', person: 'Juan', number: personNumber, caller_id: callerId};
    await wait(() => heard.twilio.some(r => r.path === '/Calls.json'));
    const create = heard.twilio.find(r => r.path === '/Calls.json').form;
    assert.equal(create.To, personNumber); assert.equal(create.From, callerId);
    const polls = heard.backend.filter(b => b.action === 'poll').length;
    await settle(100);
    assert.equal(heard.backend.filter(b => b.action === 'poll').length, polls, 'a ringing claim stops polling');
    assert.match(await (await callback(heard, 'whisper', {CallStatus: 'in-progress'})).text(), /Press 1 to join\./);
    await callback(heard, 'confirm', {Digits: '1'});
    await wait(() => heard.backend.some(b => b.action === 'joined'));
    assert.equal(heard.backend.find(b => b.action === 'joined').claim_id, 'claim-1');
  } finally {call.ws.terminate();}
});

test('a queued claim the person takes holds their current owner, hands over, and moves the caller and the person into a new room', async t => {
  let next = {status: 'wait'};
  const heard = await listener(t, {settings: {transferPollMs: 20}, answer: body => body.action === 'claim' ? queued : body.action === 'poll' ? next : {ok: true}});
  const call = await answered(heard);
  try {
    askTransfer(call.dg);
    await wait(() => heard.backend.some(b => b.action === 'poll'));
    next = {status: 'take', person: 'Juan', person_call_sid: legSid, hold: {room: 'transfer-held', call_sid: heldSid}};
    await wait(() => participant(heard, 'transfer-held', heldSid).length);
    next = {status: 'wait'};
    const hold = participant(heard, 'transfer-held', heldSid)[0];
    assert.equal(hold.Hold, 'true'); assert.equal(hold.HoldMethod, 'POST');
    const token = new URL(hold.HoldUrl).searchParams.get('t');
    assert.equal(hold.HoldUrl, `https://phone.example.com/transfer/hold?t=${token}`);
    const heldParams = new URLSearchParams({AccountSid: accountSid, CallSid: heldSid});
    const music = await (await signed(heard.web.port, `/transfer/hold?t=${token}`, heldParams)).text();
    assert.equal(music, `<Response><Say>One moment please, they will be right back.</Say><Redirect method="POST">https://phone.example.com/transfer/quiet?t=${token}</Redirect></Response>`);
    assert.match(await (await signed(heard.web.port, `/transfer/quiet?t=${token}`, heldParams)).text(), /^<Response><Pause length="30"\/><Redirect/);
    assert(!redirectOf(heard, callerSid), 'the caller stays with the model until the handover played');
    await handOverPlayed(call);
    await wait(() => heard.backend.some(b => b.action === 'taken'));
    const room = redirectOf(heard, callerSid).Twiml.match(/>(transfer-[a-f0-9]{24})</)[1];
    assert.notEqual(room, 'transfer-held');
    assert.equal(redirectOf(heard, callerSid).Twiml, ownerDial(room));
    assert.equal(redirectOf(heard, legSid).Twiml, `<Response>${personDial(room, token)}</Response>`);
    assert.deepEqual(heard.backend.find(b => b.action === 'taken'), {action: 'taken', claim_id: 'claim-1', room, person_call_sid: legSid});
    await wait(() => heard.receipts.length);
    assert.equal(heard.receipts[0].reason, 'transferred'); assert.equal(heard.receipts[0].transfer.personCallSid, legSid);
    assert(!heard.twilio.some(r => r.path === '/Calls.json'), 'nobody is rung: the person is already on the line');
    assert(!heard.twilio.some(r => r.path === `/Calls/${legSid}.json` && r.form.Status), 'the person\'s leg is never hung up from here');
  } finally {call.ws.terminate();}
});

test('the person\'s own move into a taken owner\'s room is not their conference ending; the taken owner hanging up is', async t => {
  let next = {status: 'wait'};
  const heard = await listener(t, {settings: {transferPollMs: 20}, answer: body => body.action === 'claim' ? queued : body.action === 'poll' ? next
    : body.action === 'after' ? {status: 'back', claim_id: 'claim-0', room: 'transfer-held', call_sid: heldSid} : {ok: true}});
  const call = await answered(heard);
  try {
    askTransfer(call.dg);
    await wait(() => heard.backend.some(b => b.action === 'poll'));
    next = {status: 'take', person: 'Juan', person_call_sid: legSid, hold: {room: 'transfer-held', call_sid: heldSid}};
    await wait(() => participant(heard, 'transfer-held', heldSid).length);
    next = {status: 'wait'};
    const token = new URL(participant(heard, 'transfer-held', heldSid)[0].HoldUrl).searchParams.get('t');
    await handOverPlayed(call);
    await wait(() => heard.backend.some(b => b.action === 'taken'));
    const after = status => signed(heard.web.port, `/transfer/after?t=${token}`, new URLSearchParams({AccountSid: accountSid, CallSid: legSid, CallStatus: status}));
    assert.equal(await (await after('in-progress')).text(), '<Response/>'); // the redirect's own callback
    assert(!heard.backend.some(b => b.action === 'after' || b.action === 'returned'));
    assert.equal(participant(heard, 'transfer-held', heldSid).length, 1, 'the held owner stays on hold');
    // the taken owner hangs up: the person goes back to the held owner
    assert.equal(await (await after('in-progress')).text(), `<Response>${personDial('transfer-held', token)}</Response>`);
    assert.deepEqual(participant(heard, 'transfer-held', heldSid).at(-1), {Hold: 'false'});
    await wait(() => heard.backend.some(b => b.action === 'returned'));
    assert.deepEqual(heard.backend.find(b => b.action === 'returned'), {action: 'returned', claim_id: 'claim-0'});
  } finally {call.ws.terminate();}
});

test('a queued claim the backend drops tells the model to book a callback and stops polling', async t => {
  let next = {status: 'wait'};
  const heard = await listener(t, {settings: {transferPollMs: 20}, answer: body => body.action === 'claim' ? queued : body.action === 'poll' ? next : {ok: true}});
  const call = await answered(heard);
  try {
    askTransfer(call.dg);
    await wait(() => heard.backend.some(b => b.action === 'poll'));
    next = {status: 'drop'};
    await wait(() => notes(call.dg).length === 2);
    assert.equal(notes(call.dg)[1], `(${NOTES.missed})`);
    const polls = heard.backend.filter(b => b.action === 'poll').length;
    await settle(100);
    assert.equal(heard.backend.filter(b => b.action === 'poll').length, polls);
    assert(!heard.backend.some(b => b.action === 'release'), 'the backend released it already');
  } finally {call.ws.terminate();}
});

test('a held owner\'s back resumes them, brings the person\'s leg into their room, and hangs up what the backend lists', async t => {
  let next = {status: 'wait'};
  const callStatus = {};
  const heard = await listener(t, {settings: {transferPollMs: 20}, callStatus, answer: body => body.action === 'claim' ? available : body.action === 'poll' ? next : {ok: true}});
  const call = await answered(heard);
  try {
    const room = await transferredCall(heard, call);
    await wait(() => heard.backend.some(b => b.action === 'poll'));
    next = {status: 'back', person_call_sid: personSid, end: [otherSid]};
    await wait(() => heard.backend.some(b => b.action === 'returned'));
    next = {status: 'wait'};
    assert.deepEqual(participant(heard, room, callerSid), [{Hold: 'false'}]);
    assert.equal(redirectOf(heard, personSid).Twiml, `<Response>${personDial(room, personToken(heard.twilio))}</Response>`);
    assert.deepEqual(heard.twilio.find(r => r.path === `/Calls/${otherSid}.json`).form, {Status: 'completed'});
    assert.deepEqual(heard.backend.find(b => b.action === 'returned'), {action: 'returned', claim_id: 'claim-1'});
    // Twilio's `after` callback for that very move is not the person's conference ending
    assert.equal(await (await callback(heard, 'after', {CallStatus: 'in-progress'})).text(), '<Response/>');
    assert(!heard.backend.some(b => b.action === 'after'));
    assert.equal(heard.backend.filter(b => b.action === 'returned').length, 1);
    // the owner hangs up (while held, say): their claim closes, without person_ended
    callStatus[callerSid] = 'completed';
    await wait(() => heard.backend.some(b => b.action === 'release'));
    assert.deepEqual(heard.backend.find(b => b.action === 'release'), {action: 'release', claim_id: 'claim-1', result: 'completed', person_call_sid: personSid});
    // the person's leg ends later: the backend hears it, to end the person's other claims
    await callback(heard, 'status', {CallStatus: 'completed', CallDuration: '80'});
    await wait(() => heard.backend.filter(b => b.action === 'release').length === 2);
    assert.equal(heard.backend.at(-1).person_ended, true);
  } finally {call.ws.terminate();}
});

test('the person\'s conference ending sends them back to a held owner when the backend says so, else hangs up', async t => {
  let after = {status: 'back', claim_id: 'claim-0', room: 'transfer-held', call_sid: heldSid};
  const heard = await listener(t, {answer: body => body.action === 'claim' ? available : body.action === 'after' ? after : {ok: true}});
  const call = await answered(heard);
  try {
    await transferredCall(heard, call);
    const token = personToken(heard.twilio);
    assert.equal(await (await callback(heard, 'after', {CallStatus: 'in-progress', DialCallStatus: 'completed'})).text(), `<Response>${personDial('transfer-held', token)}</Response>`);
    assert.deepEqual(heard.backend.find(b => b.action === 'after'), {action: 'after', person_call_sid: personSid});
    assert.deepEqual(participant(heard, 'transfer-held', heldSid), [{Hold: 'false'}]);
    await wait(() => heard.backend.some(b => b.action === 'returned'));
    assert.deepEqual(heard.backend.find(b => b.action === 'returned'), {action: 'returned', claim_id: 'claim-0'});
    after = {status: 'none'};
    assert.equal(await (await callback(heard, 'after', {CallStatus: 'in-progress'})).text(), '<Response><Hangup/></Response>');
    const asked = heard.backend.filter(b => b.action === 'after').length;
    assert.equal(await (await callback(heard, 'after', {CallStatus: 'completed'})).text(), '<Response><Hangup/></Response>');
    assert.equal(heard.backend.filter(b => b.action === 'after').length, asked, 'a person who hung up is not sent anywhere');
  } finally {call.ws.terminate();}
});

test('a release that lists owner calls hangs each of them up', async t => {
  const heard = await listener(t, {answer: body => body.action === 'claim' ? available : body.action === 'release' ? {ok: true, end: [otherSid, heldSid, 'nope']} : {ok: true}});
  const call = await answered(heard);
  try {
    askTransfer(call.dg);
    await wait(() => heard.twilio.some(r => r.path === '/Calls.json'));
    await callback(heard, 'status', {CallStatus: 'no-answer'});
    await wait(() => heard.twilio.some(r => r.path === `/Calls/${heldSid}.json`));
    assert.deepEqual(heard.twilio.find(r => r.path === `/Calls/${otherSid}.json`).form, {Status: 'completed'});
    assert.deepEqual(heard.twilio.find(r => r.path === `/Calls/${heldSid}.json`).form, {Status: 'completed'});
  } finally {call.ws.terminate();}
});
