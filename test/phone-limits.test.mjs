// Configuration, call and caller-context limits: what is refused, and what one line, call or context cannot reach.
// Synthetic numbers and keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validatePhoneConfig, lineConfig, withCaller, contextRoom} from '../src/phone.mjs';
import {PhoneCalls, callOptions} from '../src/phone-calls.mjs';
import {PROVIDERS, limitsFor} from '../src/phone-providers/index.mjs';

const SESSION = limitsFor('openai').session; // the default provider's, which the lines below run

const shared = {accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), origin: 'https://phone.example.com'};
const openai = {number: '+15551230001', apiKey: 'sk-synthetic123456789', provider: 'openai', tools: false, language: 'es', answerTone: 'none', toolEffort: 'high'};
const eleven = {number: '+15551230002', apiKey: 'sk_' + 'a'.repeat(24), provider: 'elevenlabs', model: 'eleven_realtime_v1_max'};

test('a line runs with the shared fields and its own fields only: the first line never leaks into another', () => {
  const config = validatePhoneConfig({...shared, lines: [openai, eleven]});
  const second = lineConfig(config, eleven.number);
  for (const key of ['tools', 'language', 'answerTone', 'toolEffort']) assert.equal(second[key], undefined, key);
  assert.equal(second.provider, 'elevenlabs'); assert.equal(second.accountSid, shared.accountSid);
  assert.equal(lineConfig(config, openai.number).answerTone, 'none');
  assert.equal(lineConfig(config, '+15551239999'), undefined);
});

test('configuration refuses what it does not know or cannot keep', () => {
  const refused = (config, pattern) => assert.throws(() => validatePhoneConfig({...shared, ...config}), pattern);
  refused({lines: [{...eleven, answerTone: 'music'}]}, /answerTone/);
  refused({lines: []}, /1\.\.8/);
  refused({lines: Array.from({length: 9}, (_, i) => ({...eleven, number: `+1555123001${i}`}))}, /1\.\.8/);
  refused({lines: [{...eleven, color: 'red'}]}, /Invalid phone line fields/);
  refused({lines: [eleven], number: '+15551230009'}, /Invalid phone configuration fields/); // a top-level line field that disagrees
  refused({lines: [eleven, {...eleven}]}, /own number/);
  for (const maxCalls of [0, 9, 1.5, '2']) refused({lines: [eleven], maxCalls}, /maxCalls/);
});

test('the call CLI takes only E.164 numbers for its destination and line', () => {
  assert.throws(() => callOptions('call', ['--to', '+15551230005', '--request-id', 'r1', '--from', '5551230001']), /E\.164/);
  assert.throws(() => callOptions('call', ['--to', '5551230005', '--request-id', 'r1']), /E\.164/);
  assert.deepEqual(callOptions('call', ['--to', '+15551230005', '--request-id', 'r1', '--from', '+15551230001']), {to: '+15551230005', requestId: 'r1', from: '+15551230001'});
});

class Twilio {
  calls = 0; ends = []; made = new Map();
  async createCall(to, id, from) {
    this.calls++; const call = {sid: 'CA' + String(this.calls).padStart(32, '0'), account_sid: shared.accountSid, from, to, direction: 'outbound-api', status: 'queued'};
    this.made.set(call.sid, call); return {...call};
  }
  async getCall(callSid) { return {...this.made.get(callSid), status: 'ringing'}; }
  async endCall(callSid, status) { this.ends.push(callSid); if (this.ends.length === 1) throw Error('provider down'); return {...this.made.get(callSid), status}; }
}
async function journal(t, config) {
  const directory = await mkdtemp(join(tmpdir(), 'voice-limits-')), provider = new Twilio(), calls = new PhoneCalls(directory, config, provider);
  t.after(async () => { calls.close(); await rm(directory, {recursive: true, force: true}); });
  return {provider, calls};
}

test('a call never starts with more instructions than a session takes, and a request ID keeps its line', async t => {
  const config = validatePhoneConfig({...shared, maxCalls: 3, lines: [{...openai, instructions: 'x'.repeat(12000)}, eleven]});
  const {provider, calls} = await journal(t, config);
  await assert.rejects(() => calls.call({to: '+15551230005', requestId: 'big', from: openai.number, instructions: 'y'.repeat(4000)}, () => false), /shorten the brief/);
  assert.equal(provider.calls, 0, 'refused before dialing');
  await calls.call({to: '+15551230005', requestId: 'one', from: eleven.number}, () => false);
  await assert.rejects(() => calls.call({to: '+15551230005', requestId: 'one', from: openai.number}, () => false), /different destination or line/);
  assert.equal(provider.calls, 1);
});

test('stopping tries every pending call and reports the ones that failed', async t => {
  const config = validatePhoneConfig({...shared, maxCalls: 3, lines: [openai]});
  const {provider, calls} = await journal(t, config);
  await calls.call({to: '+15551230005', requestId: 'a'}, () => false);
  await calls.call({to: '+15551230006', requestId: 'b'}, () => false);
  await assert.rejects(() => calls.stop(), /could not be settled \(1\)/);
  assert.equal(provider.ends.length, 2, 'the second call was canceled although the first failed');
});

test('an inbound context is cut to what a session takes rather than failing the answered call', () => {
  const text = withCaller('x'.repeat(12000), 'y'.repeat(6000), SESSION);
  assert(text.length <= SESSION, text.length);
  assert(text.includes(' …')); assert(text.endsWith('do not continue an earlier answer.')); assert.match(withCaller('line', 'short case', SESSION), /short case\nEND OF HISTORICAL RECORDS/);
});

test('the limits are the provider\'s: ElevenLabs takes a larger prompt than the others, which still refuse', async t => {
  for (const [id, Adapter] of Object.entries(PROVIDERS)) assert.deepEqual(limitsFor(id), Adapter.limits, id); // every adapter declares its own
  assert.deepEqual(limitsFor(), limitsFor('openai')); // an unset provider is the default one
  assert.deepEqual(limitsFor('elevenlabs'), {instructions: 100000, session: 120000}); // measured on the phone path, 2026-11-06
  const big = 'x'.repeat(20000);
  assert.equal(validatePhoneConfig({...shared, lines: [{...eleven, instructions: big}]}).lines[0].instructions.length, 20000);
  assert.throws(() => validatePhoneConfig({...shared, lines: [{...openai, instructions: big}]}), /1\.\.13500/); // another provider still refuses
  // a call's brief and its session are held to the line's own provider
  const config = validatePhoneConfig({...shared, maxCalls: 3, lines: [{...openai, instructions: 'x'.repeat(12000)}, {...eleven, instructions: 'x'.repeat(12000)}]});
  const {provider, calls} = await journal(t, config);
  await assert.rejects(() => calls.call({to: '+15551230005', requestId: 'o', from: openai.number, instructions: 'y'.repeat(4500)}, () => false), /exceed 16000/);
  assert.equal(provider.calls, 0, 'refused before dialing');
  await calls.call({to: '+15551230005', requestId: 'e', from: eleven.number, instructions: 'y'.repeat(4500)}, () => false);
  assert.equal(provider.calls, 1);
  // the caller context room follows the session limit
  const text = 'x'.repeat(13000);
  assert(contextRoom(text, 16000) < 3000 && contextRoom(text, limitsFor('elevenlabs').session) === 6000);
  assert(withCaller(text, 'c'.repeat(20000), 42000).length <= 42000);
});
