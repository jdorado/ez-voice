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
//
// One person can hold several owners. A claim the backend answers `queued` (the person is on another call) waits with the model
// keeping the caller company, and is polled: `ring` turns it into the flow above, `take` moves the person's existing leg out of their
// current room (that owner put on hold) into a new room with this caller, `drop` ends it with a callback. Joined and taken claims are
// polled too, because a held owner's `back` arrives that way. The person always joins with endConferenceOnExit false (they move
// between rooms) and their <Dial> carries an `after` action: when the owner they talk to hangs up, the backend says whether a held
// owner gets them back. A person on a call can pass it: the backend answers a joined or taken claim's poll `pass` with another person
// it claimed, who is rung (the same "call for you, press 1") into the same room; the first stays until they hang up, and the owner
// stays with whoever is left. The backend owns the person's session; this file only moves calls and reports.
const CALLBACK = 'the colleague was pulled into another call; agree a time for them to call the caller back from this number.';
export const NOTES = {
  unavailable: status => `Your colleague cannot join right now (${status}). Tell the caller ${CALLBACK}`,
  missed: `Your colleague did not pick up. Tell the caller ${CALLBACK}`,
  joined: 'Your colleague is on the line. Say one short sentence handing the caller over, then stop.',
  queued: 'Your colleague is finishing another call. Tell the caller so plainly and ask whether they can hold a minute; keep them company, never silence and never a goodbye, until you are told they joined or cannot.',
};
const xml = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'})[c]);
const HANGUP = '<Response><Hangup/></Response>';
const ENDED = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
// An owner on hold hears one sentence, then quiet (Twilio refetches a hold URL whose TwiML ran out, so the quiet part redirects to itself).
const HOLD_SAY = 'One moment please, they will be right back.';
// The owner's leg ends its room when it leaves; the person's never does, and their `after` action brings them back to a held owner.
const ownerDial = room => `<Response><Dial><Conference beep="false" endConferenceOnExit="true">${room}</Conference></Dial></Response>`;
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const TOKEN = /^[a-f0-9]{48}$/;
// The person's call ended before they joined: what the backend is told. A person who answered and pressed another digit declined;
// one who answered and pressed nothing (a mailbox never presses 1) did not answer.
const missedResult = (status, entry) => status === 'no-answer' ? 'no_answer' : status === 'busy' || entry.declined ? 'declined'
  : status === 'completed' ? 'no_answer' : 'failed';
// `phone call-status` for a connect request: its row's status while ringing or joined, the release result once it ended.
const STATUS = {ringing: 'ringing_person', joined: 'joined'};
// The person's phone says only who calls: the brief is on their panel. A connect request has no panel, so it still says its whisper.
const JOIN_LIVE = 'Quarre call for you. Press 1 to join.';
// The call's words go to the backend at most this often, the last WORDS_TURNS turns each time.
const WORDS_MS = 1500, WORDS_TURNS = 40;

export class Transfers {
  constructor(config, {provider, backend, calls, directory}) {
    this.config = config; this.provider = provider; this.backend = backend; this.calls = calls;
    this.streams = new WeakMap(); this.entries = new Map(); this.moving = new Set(); this.work = new Set(); this.timers = new Set(); this.pollMs = config.transferPollMs ?? 2000;
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
  close() { this.closed = true; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); this.db?.close(); }
  later(fn, ms) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); timer.unref?.(); this.timers.add(timer); }
  personDial(room, token) {
    return `<Dial action="${xml(this.url('after', token))}" method="POST"><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="false" waitUrl="">${room}</Conference></Dial>`;
  }

  // transfer_call on a live call (PhoneAudio.transferSoon).
  async start(bridge, whisper) {
    const call = bridge.config.call;
    const claim = await this.backend.claim({id: bridge.config.requestId ?? call.id, call_sid: call.id, line: call.line, number: call.remote,
      direction: call.direction === 'out' ? 'outbound' : 'inbound'}, whisper);
    if (!['available', 'queued'].includes(claim.status)) {
      bridge.transferEnded({status: claim.status});
      bridge.note(NOTES.unavailable(claim.status));
      return;
    }
    const entry = {kind: 'live', token: randomBytes(24).toString('hex'), room: 'transfer-' + randomBytes(12).toString('hex'), claim, bridge, whisper,
      state: claim.status === 'queued' ? 'queued' : 'ringing'};
    if (!bridge.usable) return this.release(entry, 'abandoned'); // the call ended while the backend answered
    this.entries.set(entry.token, entry);
    bridge.done.then(() => this.track(this.abandon(entry)));
    if (entry.state === 'ringing') return this.ring(entry);
    bridge.note(NOTES.queued);
    this.watch(entry);
  }
  // The call's words for the person's panel (PhoneAudio: each transcript change, and `ended` once when the bridge closes). One POST in flight
  // per call, at most one per WORDS_MS while the transcript changed (a trailing one sends the last words), a failed one never repeated.
  words(bridge, ended = false) {
    const call = bridge.config.call, stream = this.streams.get(bridge) ?? this.streams.set(bridge, {chars: -1, at: 0, final: false}).get(bridge);
    if (!call || stream.done || this.closed) return;
    if (ended) stream.final = true;
    this.pump(bridge, call, stream);
  }
  pump(bridge, call, stream) {
    if (stream.busy || stream.done || this.closed) return;
    const chars = bridge.transcript.chars;
    if (!stream.final && (stream.waiting || chars === stream.chars)) return;
    const wait = stream.final ? 0 : stream.at + WORDS_MS - Date.now();
    if (wait > 0) { stream.waiting = true; return this.later(() => { stream.waiting = false; this.pump(bridge, call, stream); }, wait); }
    stream.busy = true; stream.chars = chars; stream.at = Date.now(); stream.done = stream.final;
    const turns = (bridge.transcript.receipt().transcript ?? []).slice(-WORDS_TURNS);
    this.track(this.backend.words({call_sid: call.id, line: call.line, number: call.remote}, turns, stream.final)
      .finally(() => { stream.busy = false; this.pump(bridge, call, stream); }));
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
    if (claim.status === 'queued') await this.backend.release(claim.claim_id, 'abandoned'); // a connect does not wait for a busy person
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
    if (kind === 'hold' || kind === 'quiet') {
      // signed by Twilio for a held owner's call, which no entry of this listener may own: stateless
      if (!TOKEN.test(token)) return null;
      const quiet = `<Redirect method="POST">${xml(this.url('quiet', token))}</Redirect>`;
      return kind === 'hold' ? `<Response><Say>${HOLD_SAY}</Say>${quiet}</Response>` : `<Response><Pause length="30"/>${quiet}</Response>`;
    }
    const entry = this.entry(token), callSid = params.get('CallSid');
    if (!entry || (entry.personCallSid && entry.personCallSid !== callSid)) return null;
    if (!entry.personCallSid) { entry.personCallSid = callSid; this.persist(entry); } // the callback arrived before the REST answer
    if (kind === 'status') { this.track(this.ended(entry, params.get('CallStatus'), params.get('CallDuration'))); return ''; }
    if (kind === 'after') return this.after(token, callSid, params.get('CallStatus'));
    if (entry.state !== 'ringing') return HANGUP;
    if (kind === 'whisper') {
      entry.answered = true;
      const say = entry.kind === 'connect' ? `${entry.whisper} Press 1 to join.` : JOIN_LIVE;
      return `<Response><Gather input="dtmf" numDigits="1" timeout="8" method="POST" action="${xml(this.url('confirm', token))}"><Say>${xml(say)}</Say></Gather><Hangup/></Response>`;
    }
    if (params.get('Digits') !== '1') { entry.declined = true; return HANGUP; }
    entry.state = 'joined'; this.persist(entry);
    this.track(this.backend.joined(entry.claim.claim_id, entry.personCallSid, entry.room).then(ok => { entry.joinedAcknowledged = ok; }));
    if (entry.kind === 'connect') return `<Response><Dial callerId="${xml(entry.line)}" record="record-from-answer-dual" timeout="30"><Number>${xml(entry.to)}</Number></Dial></Response>`;
    if (entry.kind === 'pass') { entry.state = 'transferred'; this.watch(entry); return `<Response>${this.personDial(entry.room, token)}</Response>`; }
    this.track(this.handOver(entry));
    return `<Response>${this.personDial(entry.room, token)}</Response>`;
  }
  // The person's conference ended under them (the owner they talked to hung up): back to a held owner, or the end of their leg.
  async after(token, callSid, status) {
    if (this.moving.delete(callSid)) return '<Response/>'; // the callback of a move take()/back() made: the person is not leaving a conference
    if (status !== 'in-progress') return HANGUP; // the person hung up themselves; the status callback releases
    const next = await this.backend.after(callSid);
    if (next.status !== 'back') return HANGUP;
    try { await this.provider.holdParticipant(next.room, next.call_sid, false); } catch { return HANGUP; }
    this.track(this.backend.returned(next.claim_id));
    return `<Response>${this.personDial(next.room, token)}</Response>`;
  }
  // The person is in the conference: the model hands over, then the caller is moved there and the model's call ends.
  async handOver(entry) {
    const bridge = entry.bridge;
    if (!await bridge.handOver(NOTES.joined) || entry.state !== 'joined') return; // the caller or the person left meanwhile
    const transfer = {person: entry.claim.person, personCallSid: entry.personCallSid, at: new Date().toISOString()};
    // Twilio ends the stream as soon as the redirect lands, possibly before its answer: the receipt says why from here on.
    entry.state = 'redirecting'; bridge.stats.transfer = transfer; bridge.closeReason = 'transferred';
    try { await this.provider.redirectCall(bridge.config.call.id, ownerDial(entry.room)); }
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
    this.watch(entry);
  }

  // A queued claim polls while its caller is on the line; a joined or taken one while its claim is open (a held owner's `back`).
  polling(entry) {
    if (this.closed || entry.released) return false;
    return entry.state === 'queued' ? entry.bridge.usable : ['transferred', 'taken'].includes(entry.state);
  }
  watch(entry) {
    const tick = async () => {
      if (!this.polling(entry)) return;
      await this.pollOnce(entry).catch(() => {});
      if (this.polling(entry)) this.later(tick, this.pollMs);
    };
    this.later(tick, this.pollMs);
  }
  async pollOnce(entry) {
    if (entry.state !== 'queued') {
      // an owner who hung up (on hold, or talking) ends their claim; the person's leg, if ours, still reports its own end
      const owner = await this.provider.getCall(entry.bridge.config.call.id).catch(() => undefined);
      if (ENDED.has(owner?.status)) { await this.release(entry, 'completed'); if (entry.borrowed) this.forget(entry); return; }
    }
    const next = await this.backend.poll(entry.claim.claim_id);
    if (!this.polling(entry)) return;
    if (next.status === 'ring' && entry.state === 'queued') {
      entry.claim = {status: 'available', claim_id: entry.claim.claim_id, person: next.person, number: next.number, caller_id: next.caller_id};
      entry.state = 'ringing';
      return this.ring(entry);
    }
    if (next.status === 'take' && entry.state === 'queued') return this.take(entry, next);
    if (next.status === 'back' && entry.state !== 'queued') return this.back(entry, next);
    if (next.status === 'pass' && entry.state !== 'queued') return this.pass(entry, next);
    if (next.status === 'drop' || next.status === 'ended') {
      entry.released = true; entry.result = next.status; // the backend released it already
      if (entry.state === 'queued') { entry.state = 'ended'; this.entries.delete(entry.token); this.missed(entry, next.status === 'drop' ? 'dropped' : 'ended'); }
      else if (entry.borrowed) this.forget(entry);
    }
  }
  // The person tapped Take while on another call: that owner waits on hold, the model hands over, and both this caller and the
  // person's existing leg move into this entry's room (new: nobody joined it while queued).
  async take(entry, {person, person_call_sid, hold}) {
    const bridge = entry.bridge, owner = bridge.config.call.id;
    entry.state = 'taking'; entry.borrowed = true; entry.personCallSid = person_call_sid; entry.claim = {...entry.claim, person};
    const unhold = () => hold && this.provider.holdParticipant(hold.room, hold.call_sid, false).catch(() => {});
    const fail = async () => { await unhold(); entry.state = 'ended'; await this.release(entry, 'failed'); this.missed(entry, 'failed'); this.forget(entry); };
    if (hold) try { await this.provider.holdParticipant(hold.room, hold.call_sid, true, this.url('hold', entry.token)); } catch { return fail(); }
    if (!await bridge.handOver(NOTES.joined) || entry.state !== 'taking') { // the caller left meanwhile: the held owner gets the person back
      await unhold();
      if (!entry.released) { entry.state = 'ended'; await this.release(entry, 'abandoned'); }
      return this.forget(entry);
    }
    const transfer = {person, personCallSid: person_call_sid, at: new Date().toISOString()};
    entry.state = 'redirecting'; bridge.stats.transfer = transfer; bridge.closeReason = 'transferred';
    try { await this.provider.redirectCall(owner, ownerDial(entry.room)); }
    catch { if (bridge.usable) { delete bridge.stats.transfer; bridge.closeReason = undefined; } return fail(); }
    this.moving.add(person_call_sid); // added first: Twilio's `after` callback for the move may beat the REST answer
    try { await this.provider.redirectCall(person_call_sid, `<Response>${this.personDial(entry.room, entry.token)}</Response>`); }
    catch { // the caller already left the stream: nobody can talk with them now
      this.moving.delete(person_call_sid);
      await this.provider.endCall(owner, 'completed').catch(() => {});
      await unhold(); entry.state = 'ended'; await this.release(entry, 'failed'); return this.forget(entry);
    }
    entry.state = 'taken';
    this.track(this.backend.taken(entry.claim.claim_id, entry.room, person_call_sid));
    bridge.transferEnded({status: 'transferred', person, personCallSid: person_call_sid});
    this.calls?.transferred(owner, transfer);
    bridge.close('transferred');
    this.watch(entry);
  }
  // The person tapped Back for this held owner: resume them, bring the person's leg into their room, end what the backend lists.
  async back(entry, {person_call_sid, end}) {
    try {
      await this.provider.holdParticipant(entry.room, entry.bridge.config.call.id, false);
      this.moving.add(person_call_sid);
      await this.provider.redirectCall(person_call_sid, `<Response>${this.personDial(entry.room, entry.token)}</Response>`);
    } catch { this.moving.delete(person_call_sid); return; } // not reported: the backend still sees the person where they were
    await this.endCalls(end);
    this.track(this.backend.returned(entry.claim.claim_id));
  }
  // The person on this call asked to bring in another (the backend claimed them): ring them into this room. Their entry keeps the
  // owner's call (closed bridge, same call id) so it polls the owner's end and its own `back` or `pass` like any joined entry.
  async pass(entry, {claim_id, person, number, caller_id, room}) {
    const other = {kind: 'pass', token: randomBytes(24).toString('hex'), room, bridge: entry.bridge, whisper: '', state: 'ringing',
      claim: {status: 'available', claim_id, person, number, caller_id}};
    this.entries.set(other.token, other);
    await this.ring(other);
  }
  // A taken entry's leg reports to the entry that rang it; this one stays a minute for a late `after` callback, then goes.
  forget(entry) { this.later(() => this.entries.delete(entry.token), 60000); }
  endCalls(sids) { return Promise.all((sids ?? []).map(callSid => this.provider.endCall(callSid, 'completed').catch(() => {}))); }
  // The person's call ended (Twilio's status callback).
  async ended(entry, status, duration) {
    const seconds = /^\d{1,6}$/.test(duration ?? '') ? Number(duration) : undefined;
    if (entry.state === 'transferred' || (entry.kind === 'connect' && entry.state === 'joined')) {
      // said even when this claim closed earlier (its owner hung up first): the backend ends the person's other claims from it
      entry.state = 'ended'; entry.seconds = seconds;
      await this.release(entry, 'completed', seconds, true);
    } else if (!entry.released) {
      // a person who pressed 1 and hung up before the caller arrived declined after all: the caller is not moved
      const result = entry.state === 'joined' ? 'declined' : missedResult(status, entry);
      entry.state = 'ended';
      await this.release(entry, result, undefined, true);
      this.missed(entry, result);
    }
    if (entry.released) this.entries.delete(entry.token);
  }
  // The model's call ended (the caller hung up, end_call, the time limit) before the person joined it.
  async abandon(entry) {
    if (entry.released || ['transferred', 'redirecting', 'taken', 'ended'].includes(entry.state)) return;
    entry.state = 'ended';
    await this.release(entry, 'abandoned');
    await this.hangUp(entry);
  }
  async hangUp(entry) {
    if (!entry.personCallSid || entry.borrowed) return; // still being created, or another entry's leg (a take): ring() cancels it once its Call SID is known
    await this.provider.endCall(entry.personCallSid, entry.answered ? 'completed' : 'canceled').catch(() => {});
  }
  missed(entry, result) {
    if (entry.kind !== 'live') return;
    entry.bridge.transferEnded({status: result, person: entry.claim.person, ...(entry.personCallSid && {personCallSid: entry.personCallSid})});
    entry.bridge.note(NOTES.missed);
  }
  // Once per claim, a failed release recorded and never repeated; the one exception is the person's leg ending after its owner's
  // claim closed (personEnded), which the backend needs to end the person's other claims. Its `end` lists owner calls to hang up.
  async release(entry, result, seconds, personEnded = false) {
    if (entry.released && !personEnded) return;
    if (!entry.released) { entry.released = true; entry.result = result; this.persist(entry); }
    const {ok, end} = await this.backend.release(entry.claim.claim_id, result, {...(entry.personCallSid && {person_call_sid: entry.personCallSid}),
      ...(seconds !== undefined && {seconds}), ...(personEnded && {person_ended: true})});
    if (!ok && entry.kind === 'live') entry.bridge.stats.transferReleaseFailed = true;
    await this.endCalls(end);
  }
}
