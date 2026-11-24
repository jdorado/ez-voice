import {randomBytes} from 'node:crypto';
import {closeSync, mkdirSync, openSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {phone, sid} from './phone-provider.mjs';
import {MAX_WHISPER} from './phone-tools.mjs';

// Handing a caller to a person, and ringing a person before dialing a party (`phone connect`). The operator's backend
// (transferBinding, phone-plugin-tools.mjs) decides who the person is; this file rings them, plays the whisper, and joins them.
//
// Twilio tears down a <Connect><Stream> the moment its call is redirected, so a live caller stays on the stream, talking with the
// model, until the person has pressed 1; only then, once the model's handover sentence has played, is the caller moved into the
// conference the person already waits in. The model's tool returns at once (a waiting tool call silences it); every outcome
// reaches it later as a note (PhoneAudio.note).
const CALLBACK = 'the colleague was pulled into another call; agree a time for them to call the caller back from this number.';
export const NOTES = {
  unavailable: status => `Your colleague cannot join right now (${status}). Tell the caller ${CALLBACK}`,
  missed: `Your colleague did not pick up. Tell the caller ${CALLBACK}`,
  joined: 'Your colleague is on the line. Say one short sentence handing the caller over, then stop.',
};
const xml = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'})[c]);
const HANGUP = '<Response><Hangup/></Response>';
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const TOKEN = /^[a-f0-9]{48}$/;
// The person's call ended before they joined: what the backend is told. A person who answered and pressed another digit declined;
// one who answered and pressed nothing (a mailbox never presses 1) did not answer.
const missedResult = (status, entry) => status === 'no-answer' ? 'no_answer' : status === 'busy' || entry.declined ? 'declined'
  : status === 'completed' ? 'no_answer' : 'failed';
// `phone call-status` for a connect request: its row's status while ringing or joined, the release result once it ended.
const STATUS = {ringing: 'ringing_person', joined: 'joined'};

export class Transfers {
  constructor(config, {provider, backend, calls, directory}) {
    this.config = config; this.provider = provider; this.backend = backend; this.calls = calls;
    this.entries = new Map(); this.work = new Set();
    this.base = config.origin + (config.pathPrefix || '') + '/transfer/';
    if (!directory) return; // connect requests are kept with the running service's calls
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const path = join(directory, 'transfers.sqlite'); closeSync(openSync(path, 'a', 0o600));
    this.db = new DatabaseSync(path, {timeout: 0});
    this.db.exec(`CREATE TABLE IF NOT EXISTS connects (id TEXT PRIMARY KEY, line TEXT NOT NULL, recipient TEXT NOT NULL, whisper TEXT NOT NULL,
      status TEXT NOT NULL, token TEXT UNIQUE, claim_id TEXT, person TEXT, person_number TEXT, caller_id TEXT, person_call_sid TEXT,
      seconds INTEGER, at TEXT NOT NULL)`);
  }
  url(kind, token) { return `${this.base}${kind}?t=${token}`; }
  track(promise) { const work = Promise.resolve(promise).catch(() => {}).finally(() => this.work.delete(work)); this.work.add(work); return work; }
  settled() { return Promise.allSettled([...this.work]); }
  close() { this.db?.close(); }

  // transfer_call on a live call (PhoneAudio.transferSoon).
  async start(bridge, whisper) {
    const call = bridge.config.call;
    const claim = await this.backend.claim({id: bridge.config.requestId ?? call.id, call_sid: call.id, line: call.line, number: call.remote,
      direction: call.direction === 'out' ? 'outbound' : 'inbound'}, whisper);
    if (claim.status !== 'available') {
      bridge.transferEnded({status: claim.status});
      bridge.note(NOTES.unavailable(claim.status));
      return;
    }
    const entry = {kind: 'live', token: randomBytes(24).toString('hex'), room: 'transfer-' + randomBytes(12).toString('hex'), claim, bridge, whisper, state: 'ringing'};
    if (!bridge.usable) return this.release(entry, 'abandoned'); // the call ended while the backend answered
    this.entries.set(entry.token, entry);
    bridge.done.then(() => this.track(this.abandon(entry)));
    await this.ring(entry);
  }
  // `phone connect`: idempotent on its request ID; a refused claim keeps nothing, so the same ID may ask again later.
  async connect({requestId: id, to, from, whisper}) {
    if (!this.db) throw Error('Phone connect needs the running phone service');
    const lines = (this.config.lines ?? [this.config]).map(line => line.number);
    if (!requestId(id) || !phone(to) || lines.includes(to) || !lines.includes(from)) throw Error('Supply a destination other than the configured numbers, --from one of the configured lines and a stable request ID');
    if (typeof whisper !== 'string' || !whisper.trim() || whisper.length > MAX_WHISPER) throw Error(`The whisper must contain 1..${MAX_WHISPER} characters`);
    const prior = this.row(id);
    if (prior) {
      if (prior.recipient !== to || prior.line !== from) throw Error('Request ID was already used for a different destination or line');
      return {...this.receipt(prior), created: false};
    }
    if (this.calls?.row(id)) throw Error('Request ID was already used for a phone call');
    try { this.db.prepare('INSERT INTO connects(id,line,recipient,whisper,status,at) VALUES(?,?,?,?,?,?)').run(id, from, to, whisper.trim(), 'claiming', new Date().toISOString()); }
    catch { return {...this.receipt(this.row(id)), created: false}; } // the same request, admitted a moment ago
    const claim = await this.backend.claim({id, call_sid: null, line: from, number: to, direction: 'connect'}, whisper.trim());
    if (claim.status !== 'available') { this.db.prepare('DELETE FROM connects WHERE id=?').run(id); return {requestId: id, status: claim.status, refused: true}; }
    const entry = {kind: 'connect', token: randomBytes(24).toString('hex'), requestId: id, line: from, to, whisper: whisper.trim(), claim, state: 'ringing'};
    this.db.prepare('UPDATE connects SET status=?,token=?,claim_id=?,person=?,person_number=?,caller_id=? WHERE id=?')
      .run('ringing_person', entry.token, claim.claim_id, claim.person, claim.number, claim.caller_id, id);
    this.entries.set(entry.token, entry);
    await this.ring(entry);
    return {...this.receipt(this.row(id)), created: true};
  }
  row(id) { return requestId(id) && this.db ? this.db.prepare('SELECT * FROM connects WHERE id=?').get(id) : undefined; }
  status(id) { const row = this.row(id); if (!row) throw Error('Unknown request ID'); return this.receipt(row); }
  receipt(row) {
    return {requestId: row.id, to: row.recipient, from: row.line, status: row.status, ...(row.person && {person: row.person}),
      personCallSid: row.person_call_sid ?? null, ...(row.seconds !== null && {seconds: row.seconds}), at: row.at};
  }
  persist(entry) {
    if (entry.kind !== 'connect') return;
    this.db.prepare('UPDATE connects SET status=?,person_call_sid=?,seconds=? WHERE id=?')
      .run(entry.result ?? STATUS[entry.state] ?? 'failed', entry.personCallSid ?? null, entry.seconds ?? null, entry.requestId);
  }
  // A connect request outlives a restart: its callbacks find it by token in its row.
  entry(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return;
    if (this.entries.has(token)) return this.entries.get(token);
    const row = this.db?.prepare('SELECT * FROM connects WHERE token=?').get(token);
    if (!row) return;
    const ended = !['ringing_person', 'joined'].includes(row.status);
    const entry = {kind: 'connect', token, requestId: row.id, line: row.line, to: row.recipient, whisper: row.whisper, personCallSid: row.person_call_sid ?? undefined,
      claim: {claim_id: row.claim_id, person: row.person, number: row.person_number, caller_id: row.caller_id},
      state: ended ? 'ended' : row.status === 'joined' ? 'joined' : 'ringing', ...(ended && {released: true, result: row.status})};
    this.entries.set(token, entry);
    return entry;
  }

  // The person's call: 20 s of ringing, then the whisper (Twilio fetches it when they answer), then their key.
  async ring(entry) {
    try {
      const created = await this.provider.createPersonCall({to: entry.claim.number, from: entry.claim.caller_id, url: this.url('whisper', entry.token), statusCallback: this.url('status', entry.token)});
      if (!sid(created?.sid, 'CA')) throw Error('Twilio call response has no Call SID');
      entry.personCallSid ??= created.sid; this.persist(entry);
    } catch {
      if (entry.state !== 'ringing') return; // abandoned meanwhile, and released
      entry.state = 'ended';
      await this.release(entry, 'failed');
      return this.missed(entry, 'failed');
    }
    if (entry.state === 'ended' && entry.result === 'abandoned') await this.hangUp(entry); // the caller left while the call was being created
  }
  // A Twilio callback for the person's call (servePhone has checked its signature and account): TwiML to answer, or null to refuse.
  route(kind, token, params) {
    const entry = this.entry(token), callSid = params.get('CallSid');
    if (!entry || (entry.personCallSid && entry.personCallSid !== callSid)) return null;
    if (!entry.personCallSid) { entry.personCallSid = callSid; this.persist(entry); } // the callback arrived before the REST answer
    if (kind === 'status') { this.track(this.ended(entry, params.get('CallStatus'), params.get('CallDuration'))); return ''; }
    if (entry.state !== 'ringing') return HANGUP;
    if (kind === 'whisper') {
      entry.answered = true;
      return `<Response><Gather input="dtmf" numDigits="1" timeout="8" method="POST" action="${xml(this.url('confirm', token))}"><Say>${xml(entry.whisper)} Press 1 to join.</Say></Gather><Hangup/></Response>`;
    }
    if (params.get('Digits') !== '1') { entry.declined = true; return HANGUP; }
    entry.state = 'joined'; this.persist(entry);
    this.track(this.backend.joined(entry.claim.claim_id, entry.personCallSid).then(ok => { entry.joinedAcknowledged = ok; }));
    if (entry.kind === 'connect') return `<Response><Dial callerId="${xml(entry.line)}" record="record-from-answer-dual" timeout="30"><Number>${xml(entry.to)}</Number></Dial></Response>`;
    this.track(this.handOver(entry));
    return `<Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="">${entry.room}</Conference></Dial></Response>`;
  }
  // The person is in the conference: the model hands over, then the caller is moved there and the model's call ends.
  async handOver(entry) {
    const bridge = entry.bridge;
    if (!await bridge.handOver(NOTES.joined) || entry.state !== 'joined') return; // the caller or the person left meanwhile
    const transfer = {person: entry.claim.person, personCallSid: entry.personCallSid, at: new Date().toISOString()};
    // Twilio ends the stream as soon as the redirect lands, possibly before its answer: the receipt says why from here on.
    entry.state = 'redirecting'; bridge.stats.transfer = transfer; bridge.closeReason = 'transferred';
    try { await this.provider.redirectCall(bridge.config.call.id, `<Response><Dial><Conference beep="false" endConferenceOnExit="true">${entry.room}</Conference></Dial></Response>`); }
    catch {
      if (bridge.usable) { delete bridge.stats.transfer; bridge.closeReason = undefined; }
      entry.state = 'ended';
      await this.hangUp(entry);
      await this.release(entry, 'failed');
      return this.missed(entry, 'failed');
    }
    entry.state = 'transferred';
    bridge.transferEnded({status: 'transferred', person: transfer.person, personCallSid: transfer.personCallSid});
    this.calls?.transferred(bridge.config.call.id, transfer);
    bridge.close('transferred');
  }
  // The person's call ended (Twilio's status callback).
  async ended(entry, status, duration) {
    const seconds = /^\d{1,6}$/.test(duration ?? '') ? Number(duration) : undefined;
    if (entry.state === 'transferred' || (entry.kind === 'connect' && entry.state === 'joined')) {
      entry.state = 'ended'; entry.seconds = seconds;
      await this.release(entry, 'completed', seconds);
    } else if (!entry.released) {
      // a person who pressed 1 and hung up before the caller arrived declined after all: the caller is not moved
      const result = entry.state === 'joined' ? 'declined' : missedResult(status, entry);
      entry.state = 'ended';
      await this.release(entry, result);
      this.missed(entry, result);
    }
    if (entry.released) this.entries.delete(entry.token);
  }
  // The model's call ended (the caller hung up, end_call, the time limit) before the person joined it.
  async abandon(entry) {
    if (entry.released || ['transferred', 'redirecting', 'ended'].includes(entry.state)) return;
    entry.state = 'ended';
    await this.release(entry, 'abandoned');
    await this.hangUp(entry);
  }
  async hangUp(entry) {
    if (!entry.personCallSid) return; // still being created: ring() cancels it once its Call SID is known
    await this.provider.endCall(entry.personCallSid, entry.answered ? 'completed' : 'canceled').catch(() => {});
  }
  missed(entry, result) {
    if (entry.kind !== 'live') return;
    entry.bridge.transferEnded({status: result, person: entry.claim.person, ...(entry.personCallSid && {personCallSid: entry.personCallSid})});
    entry.bridge.note(NOTES.missed);
  }
  // Exactly once per claim: a failed release is recorded, never repeated.
  async release(entry, result, seconds) {
    if (entry.released) return;
    entry.released = true; entry.result = result; this.persist(entry);
    const ok = await this.backend.release(entry.claim.claim_id, result, {...(entry.personCallSid && {person_call_sid: entry.personCallSid}), ...(seconds !== undefined && {seconds})});
    if (!ok && entry.kind === 'live') entry.bridge.stats.transferReleaseFailed = true;
  }
}
