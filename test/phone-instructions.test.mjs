import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import WebSocket from 'ws';
import {PhoneCalls, MAX_CALL_INSTRUCTIONS} from '../src/phone-calls.mjs';
import {PhoneNumber} from '../src/phone-provider.mjs';
import {InstructionsError, instructionsFromFiles} from '../src/phone-instructions.mjs';
import {phoneCommand, servePhone, twilioSignature, validatePhoneConfig} from '../src/phone.mjs';

const base = {apiKey: 'sk-synthetic123456789', accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001', origin: 'https://phone.example.com', answerTone: 'none'};
// File identity uses /proc/self/fd in the supported Docker runtime. These stories
// run in packed Linux Docker/CI; native macOS still runs the other provider tests.
const test = (name, fn) => nodeTest(name, {skip: process.platform !== 'linux'}, fn);
const to = '+15551230002', callSid = 'CA' + '3'.repeat(32);
const sha = text => createHash('sha256').update(text).digest('hex');
const wait = async fn => {for (let i = 0; i < 100; i++) {if (fn()) return; await new Promise(r => setTimeout(r, 10));} throw Error('Timed out');};
async function put(root, path, text) {await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), text);}
async function folder(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'voice-instructions-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const [path, text] of Object.entries(files)) await put(root, path, text);
  return root;
}
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
const started = session => session.events.find(e => e.type === 'session.start').session.instructions;
// A listener over synthetic providers; its calls and the sockets it opened end with the test.
async function listener(t, config, {calls} = {}) {
  const sessions = [], receipts = [], sockets = [];
  const server = await servePhone(config, {port: 0, host: '127.0.0.1', calls, provider: new PhoneNumber(config, async () => new Response('{}', {status: 201})),
    socketFactory: () => sessions[sessions.length] = new ProviderSocket(), record: async r => {receipts.push(r);}});
  t.after(async () => {for (const ws of sockets) ws.terminate(); await server.close();});
  return {server, sessions, receipts, sockets, config};
}
const post = (fx, path, params) => fetch(`http://127.0.0.1:${fx.server.port}${path}`, {method: 'POST', body: params, headers: {'x-twilio-signature': twilioSignature(base.authToken, base.origin + path, params)}});
let counter = 0;
// Twilio asks for the TwiML of a call (inbound, or an answered outbound call with `outbound`), and a media stream starts on a ticket.
async function ring(fx, {outbound, sid} = {}) {
  const prefix = fx.config.pathPrefix ?? '', id = sid ?? 'CA' + String(++counter).padStart(32, '0');
  const params = outbound ? new URLSearchParams({AccountSid: base.accountSid, CallSid: id, From: base.number, To: to, Direction: 'outbound-api', CallStatus: 'in-progress'})
    : new URLSearchParams({AccountSid: base.accountSid, CallSid: id, To: base.number, From: '+15551230009'});
  const response = await post(fx, prefix + '/incoming' + (outbound ? '?outbound=' + outbound : ''), params);
  const xml = await response.text(), ticket = xml.match(/value="([a-f0-9]+)"/)?.[1];
  if (!ticket) return {callSid: id, xml, status: response.status};
  const ws = new WebSocket(`ws://127.0.0.1:${fx.server.port}${prefix}/media`, {headers: {'x-twilio-signature': twilioSignature(base.authToken, base.origin + prefix + '/media')}});
  fx.sockets.push(ws);
  await new Promise((resolve, reject) => {ws.once('open', resolve); ws.once('error', reject);});
  ws.send(JSON.stringify({event: 'start', start: {accountSid: base.accountSid, callSid: id, streamSid: 'MZ' + String(counter).padStart(32, '0'), customParameters: {ticket},
    mediaFormat: {encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1}}}));
  return {callSid: id, xml, ws};
}
async function hangUp(fx, call) {const before = fx.receipts.length; call.ws.close(); await wait(() => fx.receipts.length > before); return fx.receipts[fx.receipts.length - 1];}

test('a call reads its instruction files fresh at its start, joins them with a blank line and records their digest', async t => {
  const root = await folder(t, {'persona/main.md': 'You are Alice.\n', 'rules.md': 'Be brief.'});
  const fx = await listener(t, validatePhoneConfig({...base, instructionsRoot: root, instructionsFiles: ['persona/main.md', 'rules.md']}));
  const first = 'You are Alice.\n\n\nBe brief.';
  let call = await ring(fx); await wait(() => fx.sessions[0]?.events.some(e => e.type === 'session.start'));
  assert(started(fx.sessions[0]).startsWith(first + '\n\nThis is an incoming call'));
  let receipt = await hangUp(fx, call);
  assert.equal(receipt.instructionsSha256, sha(first));
  assert.equal(JSON.stringify(receipt).includes('Alice'), false); // the digest is kept, never the text
  // the next call uses what the file says now, with no restart
  await put(root, 'rules.md', 'Be brief and kind.');
  call = await ring(fx); await wait(() => fx.sessions[1]?.events.some(e => e.type === 'session.start'));
  const second = 'You are Alice.\n\n\nBe brief and kind.';
  assert(started(fx.sessions[1]).startsWith(second + '\n\nThis is an incoming call'));
  receipt = await hangUp(fx, call);
  assert.equal(receipt.instructionsSha256, sha(second)); assert.notEqual(sha(first), sha(second));
});

test('an unreadable file refuses an inbound call like a full line, records the failure and holds no place', async t => {
  const root = await folder(t, {'a.md': 'Persona A', 'b.md': 'Persona B'});
  const fx = await listener(t, validatePhoneConfig({...base, pathPrefix: '/voice-a', instructionsRoot: root, instructionsFiles: ['a.md', 'b.md']}));
  await unlink(join(root, 'b.md'));
  const refused = await ring(fx);
  assert.match(refused.xml, /Reject reason="busy"/); assert.equal(refused.status, 503); assert.equal(refused.ws, undefined);
  assert.equal(fx.sessions.length, 0); // no speech session, no fallback instructions
  assert.equal(fx.receipts.length, 1);
  assert.deepEqual({...fx.receipts[0], at: undefined}, {callSid: refused.callSid, line: base.number, direction: 'in', reason: 'instructions_unavailable', instructionsError: {path: 'b.md', reason: 'missing'}, at: undefined});
  assert.equal(JSON.stringify(fx.receipts[0]).includes('Persona'), false);
  assert.equal(fx.server.capacity().tickets, 0); assert.equal(fx.server.capacity().idle, true);
  // an empty file refuses it too, and a repaired file is read by the next call
  await put(root, 'b.md', ' \n');
  assert.match((await ring(fx)).xml, /Reject/); assert.equal(fx.receipts[1].instructionsError.reason, 'empty');
  await put(root, 'b.md', 'Persona B');
  const call = await ring(fx); await wait(() => fx.sessions[0]?.events.some(e => e.type === 'session.start'));
  assert(started(fx.sessions[0]).startsWith('Persona A\n\nPersona B'));
  assert.equal((await hangUp(fx, call)).instructionsSha256, sha('Persona A\n\nPersona B'));
});

test('a line with a string keeps its instructions as they were, and its receipt names their digest', async t => {
  const fx = await listener(t, validatePhoneConfig({...base, instructions: 'Legacy persona'}));
  const call = await ring(fx); await wait(() => fx.sessions[0]?.events.some(e => e.type === 'session.start'));
  assert(started(fx.sessions[0]).startsWith('Legacy persona\n\nThis is an incoming call'));
  assert.equal((await hangUp(fx, call)).instructionsSha256, sha('Legacy persona'));
});

async function outbound(t, files, lines = {}) {
  const root = await folder(t, files), directory = await mkdtemp(join(tmpdir(), 'voice-instructions-calls-'));
  const config = validatePhoneConfig({...base, instructionsRoot: root, instructionsFiles: Object.keys(files), ...lines});
  const twilio = {creates: 0, value: {sid: callSid, account_sid: base.accountSid, from: base.number, to, direction: 'outbound-api', status: 'queued'},
    async createCall() {this.creates++; return {...this.value};}, async getCall() {return {...this.value};}};
  const calls = new PhoneCalls(directory, config, twilio);
  t.after(async () => {calls.close(); await rm(directory, {recursive: true, force: true});});
  return {root, config, twilio, calls};
}

test('an outbound call with an unreadable file fails naming it and never dials; the answered call reads the file again', async t => {
  const {root, config, twilio, calls} = await outbound(t, {'persona.md': 'Persona v1'});
  await unlink(join(root, 'persona.md'));
  await assert.rejects(() => calls.call({requestId: 'o1', to}, () => false), error => /instructions file persona\.md is unavailable \(missing\)/.test(error.message));
  assert.equal(twilio.creates, 0); assert.equal(calls.pendingCount(), 0); assert.equal(calls.row('o1'), undefined); // nothing is saved, so the same request can be made again
  await put(root, 'persona.md', 'SECRET'.repeat(3000)); // oversized
  await assert.rejects(() => calls.call({requestId: 'o1', to}, () => false), error => /persona\.md is unavailable \(too_large\)/.test(error.message) && !error.message.includes('SECRET'));
  assert.equal(twilio.creates, 0);
  await put(root, 'persona.md', 'Persona v1');
  assert.equal((await calls.call({requestId: 'o1', to, instructions: 'Brief text'}, () => false)).created, true); assert.equal(twilio.creates, 1);
  await put(root, 'persona.md', 'Persona v2'); // edited while it rang
  const fx = await listener(t, config, {calls});
  const answered = await ring(fx, {outbound: 'o1', sid: callSid}); await wait(() => fx.sessions[0]?.events.some(e => e.type === 'session.start'));
  assert(started(fx.sessions[0]).startsWith('Persona v2\n\nBrief for this call'));
  assert(started(fx.sessions[0]).includes('Brief text'));
  assert.equal((await hangUp(fx, answered)).instructionsSha256, sha('Persona v2'));
});

test('an outbound answer finding the file gone is refused and recorded, and starts no session', async t => {
  const {root, config, calls} = await outbound(t, {'persona.md': 'Persona v1'});
  await calls.call({requestId: 'o2', to}, () => false);
  await unlink(join(root, 'persona.md'));
  const fx = await listener(t, config, {calls});
  const answered = await ring(fx, {outbound: 'o2', sid: callSid});
  assert.match(answered.xml, /Reject reason="busy"/); assert.equal(fx.sessions.length, 0);
  assert.deepEqual(fx.receipts.map(r => [r.callSid, r.direction, r.reason, r.instructionsError]), [[callSid, 'out', 'instructions_unavailable', {path: 'persona.md', reason: 'missing'}]]);
});

test('the line instructions and a brief together stay within the session budget, files included', async t => {
  const {twilio, calls} = await outbound(t, {'persona.md': 'x'.repeat(MAX_CALL_INSTRUCTIONS)});
  await assert.rejects(() => calls.call({requestId: 'big', to, instructions: 'y'.repeat(4000)}, () => false), /shorten the brief/);
  assert.equal(twilio.creates, 0);
  assert.equal((await calls.call({requestId: 'fits', to, instructions: 'y'.repeat(100)}, () => false)).created, true);
});

test('files are read only from inside their root: links, directories, pipes, bad bytes, empty and oversized files refuse', async t => {
  const outside = await folder(t, {'secret.md': 'SECRET'});
  const root = await folder(t, {'ok.md': 'fine', 'real/inner.md': 'inner', 'empty.md': '', 'blank.md': ' \n\t', 'a.md': 'a'.repeat(6000), 'b.md': 'b'.repeat(6001), 'big.md': 'z'.repeat(MAX_CALL_INSTRUCTIONS + 1), 'full.md': 'f'.repeat(MAX_CALL_INSTRUCTIONS)});
  await writeFile(join(root, 'bad.md'), Buffer.from([0x41, 0xff, 0xfe]));
  await symlink(join(outside, 'secret.md'), join(root, 'link.md'));
  await symlink(outside, join(root, 'dir-link'));
  await symlink(join(root, 'real'), join(root, 'inner-link'));
  const pipe = join(root, 'pipe'), fifo = spawnSync('mkfifo', [pipe]).status === 0;
  const read = (files, dir = root) => instructionsFromFiles({instructionsRoot: dir, instructionsFiles: files}, MAX_CALL_INSTRUCTIONS);
  const refuses = (files, path, reason, dir) => assert.rejects(() => read(files, dir),
    error => error instanceof InstructionsError && error.path === path && error.reason === reason && !/SECRET|inner/.test(error.message));
  assert.equal(await read(['ok.md', 'inner-link/inner.md']), 'fine\n\ninner'); // a link that stays inside the root is fine
  assert.equal((await read(['full.md'])).length, MAX_CALL_INSTRUCTIONS);
  await refuses(['link.md'], 'link.md', 'outside_root');
  await refuses(['dir-link/secret.md'], 'dir-link/secret.md', 'outside_root');
  await refuses(['ok.md', '../' + outside.split('/').pop() + '/secret.md'], '../' + outside.split('/').pop() + '/secret.md', 'outside_root'); // never reached through configuration, which refuses it
  await refuses(['nope.md'], 'nope.md', 'missing');
  await refuses(['ok.md/more'], 'ok.md/more', 'missing');
  await refuses(['real'], 'real', 'not_a_file');
  if (fifo) await refuses(['pipe'], 'pipe', 'not_a_file');
  await refuses(['bad.md'], 'bad.md', 'not_utf8');
  await refuses(['empty.md'], 'empty.md', 'empty');
  await refuses(['blank.md'], 'blank.md', 'empty');
  await refuses(['big.md'], 'big.md', 'too_large');
  await refuses(['a.md', 'b.md'], 'b.md', 'too_large'); // 6000 + 2 + 6001 characters together
  await refuses(['ok.md'], 'ok.md', 'root_unavailable', join(root, 'gone'));
  assert.equal((await read(['a.md'])).length, 6000);
});

test('configuration takes instructionsFiles or instructions, never both, and only plain relative paths under an absolute root', () => {
  const root = '/state/agent', files = ['persona/main.md', 'rules.md'];
  const refused = (settings, pattern) => assert.throws(() => validatePhoneConfig({...base, ...settings}), pattern);
  refused({instructions: 'x', instructionsFiles: files, instructionsRoot: root}, /not both/);
  refused({instructionsFiles: files}, /requires instructionsRoot/);
  refused({instructions: 'x', instructionsRoot: root}, /applies to instructionsFiles only/);
  refused({instructionsRoot: root}, /applies to instructionsFiles only/);
  for (const bad of [[], 'rules.md', ['/etc/passwd'], ['../x.md'], ['a/../x.md'], ['a/./x.md'], ['a//x.md'], ['a/'], ['a\\b.md'], [''], [7], ['x'.repeat(257)], Array.from({length: 9}, (_, i) => `f${i}.md`)])
    refused({instructionsFiles: bad, instructionsRoot: root}, /instructionsFiles must list 1\.\.8 relative file paths/);
  for (const bad of ['agent', './agent', '/', '/state/agent/', '/state//agent', '/state/../agent', '/state\\agent', 7]) refused({instructionsFiles: files, instructionsRoot: bad}, /instructionsRoot must be an absolute/);
  assert.equal(validatePhoneConfig({...base, instructionsFiles: Array.from({length: 8}, (_, i) => `f${i}.md`), instructionsRoot: root}).instructionsFiles.length, 8);
  // the root may be set once for the install and per line; a line's own wins; a line with a string needs none
  const second = '+15551230009', third = '+15551230008', {apiKey, number, answerTone, ...shared} = base;
  const config = validatePhoneConfig({...shared, instructionsRoot: root, lines: [{apiKey, number, instructionsFiles: files},
    {apiKey, number: second, instructionsFiles: ['x.md'], instructionsRoot: '/state/other'}, {apiKey, number: third, instructions: 'A string'}]});
  assert.deepEqual(config.lines.map(l => [l.instructionsRoot, l.instructionsFiles, l.instructions]), [[root, files, undefined], ['/state/other', ['x.md'], undefined], [undefined, undefined, 'A string']]);
  assert.deepEqual(validatePhoneConfig(config).lines, config.lines);
  const lineRefused = (settings, pattern) => assert.throws(() => validatePhoneConfig({...shared, ...settings}), pattern);
  lineRefused({instructionsRoot: root, lines: [{apiKey, number, instructionsFiles: files, instructions: 'x'}]}, /not both/);
  lineRefused({lines: [{apiKey, number, instructionsFiles: files}]}, /requires instructionsRoot/);
});

test('phone doctor tells whether each instruction file is readable without printing it, and probe refuses an unreadable one', async t => {
  const outside = await folder(t, {'secret.md': 'SECRET'});
  const root = await folder(t, {'a.md': 'Persona A SECRET'});
  await symlink(join(outside, 'secret.md'), join(root, 'link.md'));
  const state = await mkdtemp(join(tmpdir(), 'voice-instructions-state-'));
  t.after(() => rm(state, {recursive: true, force: true}));
  const settings = {...base, instructionsRoot: root, instructionsFiles: ['a.md', 'b.md', 'link.md']};
  const configured = await phoneCommand(state, ['configure'], {stdin: Readable.from([JSON.stringify(settings)])});
  assert.equal(JSON.stringify(configured).includes('SECRET'), false);
  const stored = JSON.parse(await readFile(join(state, 'phone', 'config.json'), 'utf8')); // what is kept: the files and their root, no text and no default instructions
  assert.deepEqual([stored.lines[0].instructionsRoot, stored.lines[0].instructionsFiles, stored.lines[0].instructions, stored.instructionsFiles], [root, ['a.md', 'b.md', 'link.md'], undefined, undefined]);
  let doctor = await phoneCommand(state, ['doctor']);
  assert.deepEqual(doctor.lines[0].instructionsFiles, [{path: 'a.md', ok: true}, {path: 'b.md', ok: false, reason: 'missing'}, {path: 'link.md', ok: false, reason: 'outside_root'}]);
  assert.equal(doctor.lines[0].instructionsSha256, undefined); assert.equal(JSON.stringify(doctor).includes('SECRET'), false);
  await assert.rejects(() => phoneCommand(state, ['probe']), error => /b\.md is unavailable \(missing\)/.test(error.message) && !error.message.includes('SECRET'));
  await put(root, 'b.md', 'Persona B'); await unlink(join(root, 'link.md'));
  doctor = await phoneCommand(state, ['doctor']);
  assert.deepEqual(doctor.lines[0].instructionsFiles.map(f => f.ok), [true, true, false]);
  await put(root, 'link.md', 'Persona C'); doctor = await phoneCommand(state, ['doctor']);
  assert.equal(doctor.lines[0].instructionsSha256, sha('Persona A SECRET\n\nPersona B\n\nPersona C')); assert.equal(JSON.stringify(doctor).includes('SECRET'), false);
  const help = await phoneCommand(state, ['--help']);
  assert(help.configuration.optional.some(text => text.startsWith('instructionsFiles'))); assert(help.configuration.optional.some(text => text.startsWith('instructionsRoot')));
  // a configuration that sets both, or a file path that climbs, is refused at configure and nothing is saved over the good one
  for (const bad of [{...settings, instructions: 'x'}, {...settings, instructionsFiles: ['../x.md']}]) await assert.rejects(() => phoneCommand(state, ['configure'], {stdin: Readable.from([JSON.stringify(bad)])}), /not both|relative file paths/);
  assert.equal(JSON.parse(await readFile(join(state, 'phone', 'config.json'), 'utf8')).lines[0].instructionsFiles.length, 3);
});

test('an instruction parent replaced during open cannot disclose an outside file', async t => {
  const outside = await folder(t, {'phone.md': 'OUTSIDE PRIVATE CONTENT'});
  const root = await folder(t, {'persona/phone.md': 'Approved persona'});
  const original = fs.open, originalRealpath = fs.realpath;
  let opened = false;
  const redirect = async () => {await fs.rename(join(root, 'persona'), join(root, 'original')); await fs.symlink(outside, join(root, 'persona'));};
  const restore = async () => {await fs.unlink(join(root, 'persona')); await fs.rename(join(root, 'original'), join(root, 'persona'));};
  fs.open = async (path, ...args) => {
    if (!path.endsWith('/persona/phone.md')) return original(path, ...args);
    await redirect(); const handle = await original(path, ...args); await restore(); opened = true; return handle;
  };
  fs.realpath = async (path, ...args) => {
    const resolved = await originalRealpath(path, ...args);
    if (opened && path.endsWith('/persona/phone.md')) {opened = false; await redirect();}
    return resolved;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => instructionsFromFiles({instructionsRoot: root, instructionsFiles: ['persona/phone.md']}, MAX_CALL_INSTRUCTIONS),
      error => error.reason === 'outside_root' && !error.message.includes('PRIVATE'));
  } finally {fs.open = original; fs.realpath = originalRealpath; syncBuiltinESMExports();}
});

test('an existing outbound request stays readable after its persona disappears', async t => {
  const {root, calls, twilio} = await outbound(t, {'phone.md': 'Approved persona'});
  assert.equal((await calls.call({requestId: 'stable', to}, () => false)).created, true);
  await unlink(join(root, 'phone.md'));
  const repeated = await calls.call({requestId: 'stable', to}, () => true);
  assert.equal(repeated.created, false); assert.equal(repeated.status, 'queued'); assert.equal(twilio.creates, 1);
  await assert.rejects(() => calls.call({requestId: 'stable', to: '+15551230003'}, () => false), /different destination/);
});

test('persona growth while ringing cannot exceed the answered-call session budget', async t => {
  const {root, config, calls} = await outbound(t, {'phone.md': 'p'.repeat(1000)});
  await calls.call({requestId: 'growing', to, instructions: 'b'.repeat(10000)}, () => false);
  await put(root, 'phone.md', 'p'.repeat(MAX_CALL_INSTRUCTIONS));
  const fx = await listener(t, config, {calls});
  const answer = await ring(fx, {outbound: 'growing', sid: callSid});
  assert.match(answer.xml, /Reject/); assert.equal(fx.sessions.length, 0);
  assert.equal(fx.receipts[0].instructionsError.reason, 'session_too_large');
});

test('a webhook retry preserves the issued call snapshot and admits the original media ticket', async t => {
  const root = await folder(t, {'phone.md': 'Approved persona'});
  const fx = await listener(t, validatePhoneConfig({...base, instructionsRoot: root, instructionsFiles: ['phone.md']}));
  const id = 'CA' + '8'.repeat(32), params = new URLSearchParams({AccountSid: base.accountSid, CallSid: id, To: base.number, From: to});
  const original = await post(fx, '/incoming', params), xml = await original.text();
  const ticket = xml.match(/value="([a-f0-9]+)"/)[1];
  await unlink(join(root, 'phone.md'));
  const repeated = await post(fx, '/incoming', params);
  assert.equal(await repeated.text(), xml); assert.equal(fx.receipts.length, 0);
  const ws = new WebSocket(`ws://127.0.0.1:${fx.server.port}/media`, {headers: {'x-twilio-signature': twilioSignature(base.authToken, base.origin + '/media')}});
  fx.sockets.push(ws);
  await new Promise((resolve, reject) => {ws.once('open', resolve); ws.once('error', reject);});
  ws.send(JSON.stringify({event: 'start', start: {accountSid: base.accountSid, callSid: id, streamSid: 'MZ' + '9'.repeat(32), customParameters: {ticket}, mediaFormat: {encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1}}}));
  await wait(() => fx.sessions[0]?.events.some(e => e.type === 'session.start'));
  assert(started(fx.sessions[0]).startsWith('Approved persona'));
});

test('a refused call remains in drain and shutdown waits for its durable receipt', async t => {
  const root = await folder(t, {}), config = validatePhoneConfig({...base, instructionsRoot: root, instructionsFiles: ['missing.md']});
  let entered, release, persisted = false, stopped = false;
  const recording = new Promise(resolve => {entered = resolve;}), gate = new Promise(resolve => {release = resolve;});
  const web = await servePhone(config, {host: '127.0.0.1', port: 0, record: async () => {entered(); await gate; persisted = true;}});
  t.after(() => web.close());
  const params = new URLSearchParams({AccountSid: base.accountSid, CallSid: callSid, To: base.number, From: to});
  const request = post({server: web}, '/incoming', params).then(r => r.text(), () => 'closed');
  await recording;
  assert.equal(web.drain().idle, false);
  const closing = web.close().then(() => {stopped = true;});
  await new Promise(r => setImmediate(r));
  assert.equal(stopped, false); release();
  await closing; await request;
  assert(persisted); assert.equal(web.capacity().idle, true);
});
