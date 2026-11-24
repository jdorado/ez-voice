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
async function listener(t, {answer = () => ({ok: true}), calls, settings = {}} = {}) {
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
    return new Response(JSON.stringify({sid: url.endsWith('/Calls.json') ? personSid : url.match(/(CA[0-9a-f]{32})/)[1]}), {status: 201});
  });
  const web = await servePhone({...line, ...settings, transfer}, {port: 0, host: '127.0.0.1', provider, calls,
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
    assert.deepEqual(heard.backend.at(-1), {action: 'release', claim_id: 'claim-1', result: 'no_answer', person_call_sid: personSid});
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
    assert.match(whisper, /^<Response><Gather input="dtmf" numDigits="1" timeout="8" method="POST" action="https:\/\/phone\.example\.com\/transfer\/confirm\?t=[a-f0-9]{48}"><Say>12 Main St: the owner &lt;Ann&gt; wants to talk price\. Press 1 to join\.<\/Say><\/Gather><Hangup\/><\/Response>$/);
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
    assert.equal(joined, `<Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="">${room}</Conference></Dial></Response>`);
    await wait(() => heard.backend.some(b => b.action === 'joined'));
    assert.deepEqual(heard.backend.find(b => b.action === 'joined'), {action: 'joined', claim_id: 'claim-1', person_call_sid: personSid});
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
    assert.deepEqual(redirect, {Twiml: `<Response><Dial><Conference beep="false" endConferenceOnExit="true">${room}</Conference></Dial></Response>`, TimeLimit: '14400'});
    const receipt = heard.receipts[0];
    assert.equal(receipt.reason, 'transferred'); assert.equal(receipt.handover, 'played');
    assert.equal(receipt.transfer.person, 'Juan'); assert.equal(receipt.transfer.personCallSid, personSid); assert.ok(Date.parse(receipt.transfer.at));
    assert.deepEqual(receipt.transcript.map(x => x.text), ['Connecting you with Juan now.']);
    assert.equal(heard.web.capacity().calls, 0); // the listener's call slot is free
    assert(!heard.backend.some(b => b.action === 'release'));
    await callback(heard, 'status', {CallStatus: 'completed', CallDuration: '42'});
    await wait(() => heard.backend.some(b => b.action === 'release'));
    assert.deepEqual(heard.backend.find(b => b.action === 'release'), {action: 'release', claim_id: 'claim-1', result: 'completed', person_call_sid: personSid, seconds: 42});
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
  assert.deepEqual(heard.backend.find(b => b.action === 'release'), {action: 'release', claim_id: 'claim-1', result: 'completed', person_call_sid: personSid, seconds: 120});
  const done = heard.web.transfers.status('c1');
  assert.equal(done.status, 'completed'); assert.equal(done.seconds, 120);
  await assert.rejects(() => heard.web.transfers.connect({requestId: 'c2', to: party, from: '+15551230005', whisper}), /--from one of the configured lines/);
  await assert.rejects(() => heard.web.transfers.connect({requestId: 'c2', to: party, from: number, whisper: 'x'.repeat(301)}), /1\.\.300/);
});
