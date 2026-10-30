// Configuration, call and caller-context limits: what is refused, and what one line, call or context cannot reach.
// Synthetic numbers and keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validatePhoneConfig, lineConfig, withCaller} from '../src/phone.mjs';
import {PhoneCalls, callOptions, MAX_SESSION_INSTRUCTIONS} from '../src/phone-calls.mjs';
import {PhoneContexts, MAX_CONTEXTS} from '../src/phone-contexts.mjs';

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

const entry = (number, find, extra = {}) => ({number, text: 'Synthetic case', claim: 'We have a conversation on record about that property.', find, ...extra});

test('a property is found by its house number and every word of its street name, and nothing else', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-find-'));
  const contexts = new PhoneContexts(directory);
  t.after(async () => { contexts.close(); await rm(directory, {recursive: true, force: true}); });
  contexts.replace([entry('+15551230002', '88-10 Hillside Avenue'), entry('+15551230003', '25 Court Street'),
    entry('+15551230004', '100 Queens Blvd'), entry('+15551230005', '500 New York Ave'), entry('+15551230006', '1450 East 102nd Street')]);
  const found = query => contexts.search(query).length;
  assert.equal(found('88-10 Queens Boulevard'), 0, 'another street at the same house number');
  assert.equal(found('88-10 Hillside Ave'), 1);
  assert.equal(found('88 Hillside Avenue'), 0, 'a hyphenated house number is one number');
  assert.equal(found('100 Queens Boulevard'), 1);
  assert.equal(found('25 Court St, Apt 4B, Brooklyn NY 11201'), 1, 'a unit, a city and a ZIP only add words');
  assert.equal(found('500 New York Avenue'), 1);
  assert.equal(found('1450 East 102nd'), 1);
  assert.equal(found('1450 West 102nd Street'), 1, 'the direction is not the name');
  assert.equal(found('1450 East 103rd Street'), 0);
  assert.equal(found('Queens Boulevard'), 0, 'no house number');
});

test('caller contexts refuse what they cannot keep, and a malformed file never echoes its text', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-limits-ctx-'));
  const contexts = new PhoneContexts(directory);
  t.after(async () => { contexts.close(); await rm(directory, {recursive: true, force: true}); });
  const many = Array.from({length: MAX_CONTEXTS + 1}, (_, i) => entry(`+1555${String(1000000 + i).slice(1)}`, `${i + 1} Main Street`));
  assert.throws(() => contexts.replace(many), /at most/);
  assert.throws(() => contexts.replace([entry('+15551230002', '1 Main St', {text: 'x'.repeat(6001)})]), /Invalid caller context/);
  assert.throws(() => contexts.replace([entry('+15551230002', '1 Main St', {at: 1730000000000})]), /Invalid caller context/);
  assert.throws(() => contexts.replace([entry('+15551230002', '1 Main St', {at: 'yesterday'})]), /Invalid caller context/);
  contexts.replace([entry('+15551230002', '1 Main St', {at: '2026-10-30T10:00:00+02:00'})]);
  assert.equal(contexts.status().latest, '2026-10-30T08:00:00.000Z', 'kept in UTC, so the latest is the latest');
  const {phoneCommand} = await import('../src/phone.mjs');
  const stdin = async function* () { yield '[{"number":"+15551230002","text":"PRIVATE GARY'; };
  await assert.rejects(() => phoneCommand(directory, ['context', 'replace'], {stdin: stdin()}), error => !error.message.includes('PRIVATE'));
});

test('an inbound context is cut to what a session takes rather than failing the answered call', () => {
  const text = withCaller('x'.repeat(12000), 'y'.repeat(6000));
  assert(text.length <= MAX_SESSION_INSTRUCTIONS, text.length);
  assert(text.includes(' …')); assert(text.endsWith('do not continue an earlier answer.')); assert.match(withCaller('line', 'short case'), /short case\nEND OF HISTORICAL RECORDS/);
});
