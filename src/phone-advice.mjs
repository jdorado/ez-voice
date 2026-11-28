// A side coach. Each finished caller utterance goes to an operator-installed advisory capability. Where the listener
// relays the model's requests (src/phone-think.mjs), the latest note rides on each of them until a newer one replaces
// it and never joins the standing instructions: an added prompt sent Deepgram's Gemini into lookups on every call,
// whatever the note said. A speech-to-speech session (GPT-Live) takes the note as session instructions instead, in a
// quiet moment after the model's reply has played (src/phone-audio.mjs), never while either side speaks. Nothing waits for it, and a note a
// newer utterance overtook is dropped. The installed plugin owns what a note means; this only times and attaches it.
// A session that takes a system item mid-call (ElevenLabs Realtime, `full`) gets each note as it is ready (src/phone-audio.mjs), may be
// sent a provisional utterance before the final one (`partial`), and its command is sent the whole call so far so it can rebuild its
// own per-call state from it; its result may end the call after the model's next reply (`end`).
export const MAX_NOTES = 8; // session notes a call can add: each stays in the session's context until the call ends
const MAX_LOOKUPS = 64, MAX_FULL_LOOKUPS = 160; // a full line asks up to twice a caller turn (provisional and final)
// The whole call for a full line: the last 80 turns of at most 1,000 characters each, the oldest dropped until the request fits
// 56,000 bytes (the command reads up to 64 KB on stdin).
export const FULL_HISTORY = {turns: 80, chars: 1000, bytes: 56000};

export class PhoneAdvice {
  constructor({call, run, deadlineMs, receipts, onReady = () => {}, onEnd = () => {}, full = false, now = Date.now}) {
    Object.assign(this, {call, run, deadlineMs, receipts, onReady, onEnd, full, now});
    this.turn = 0; this.pushed = 0; this.unacknowledged = []; this.closed = new AbortController();
  }
  // The caller finished an utterance (`partial`: is still speaking it, a full line only); `history` is what was said before it and
  // `since` when the utterance ended, the moment an end action counts the model's next reply from.
  heard(text, history, {partial = false, since} = {}) {
    if (this.closed.signal.aborted || typeof text !== 'string' || !text.trim() || this.turn >= (this.full ? MAX_FULL_LOOKUPS : MAX_LOOKUPS)) return;
    const turn = ++this.turn, began = this.now(), receipt = {turn, status: 'pending', ...(partial && {partial: true})};
    // the note already sent on this caller turn's provisional words: the final's note goes in only when it differs
    const early = partial ? undefined : this.early; if (!partial) this.early = undefined;
    const signal = AbortSignal.any([this.closed.signal, AbortSignal.timeout(this.deadlineMs)]);
    const request = {call: this.call, turn, text: text.slice(0, 2000), deadline_at: began + this.deadlineMs, ...(partial && {partial: true}),
      history: history.slice(this.full ? -FULL_HISTORY.turns : -6).map(t => ({who: t.who, text: t.text.slice(-(this.full ? FULL_HISTORY.chars : 1000))}))};
    while (this.full && request.history.length && Buffer.byteLength(JSON.stringify(request)) > FULL_HISTORY.bytes) request.history.shift();
    this.receipts.push(receipt);
    Promise.resolve().then(() => this.run(request, signal)).then(result => {
      if (receipt.status !== 'pending') return;
      receipt.milliseconds = this.now() - began;
      if (result.status !== 'available') return void (receipt.status = result.status);
      const a = result.advice;
      Object.assign(receipt, {id: a.id, source: a.source, source_revision: a.source_revision, confidence: a.confidence, ...(a.end && {end: a.end})});
      // an end is the command's read of a finished utterance: honoured on a full line, also when a newer utterance overtook its note
      if (a.end && this.full && !partial) this.onEnd(a.end, since ?? began);
      if (turn !== this.turn) return void (receipt.status = 'superseded');
      if (this.full ? a.text === early : a.id === this.current?.receipt.id) return void (receipt.status = 'unchanged');
      if (partial) this.early = a.text;
      if (this.current?.receipt.status === 'ready') this.current.receipt.status = 'unused';
      this.current = {receipt, text: a.text}; receipt.status = 'ready'; this.onReady();
    }, error => {
      // the reason a lookup failed (the core's or the command's message, never the note), so a receipt explains an unavailable coach
      if (receipt.status === 'pending') Object.assign(receipt, {status: signal.aborted && !this.closed.signal.aborted ? 'timeout' : 'unavailable', milliseconds: this.now() - began,
        error: String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 200)});
    });
  }
  // The note for the model's next request, if a pick is ready; `attached` once a request carries it.
  note() {
    const current = this.current; if (!current || this.closed.signal.aborted) return;
    return {receipt: current.receipt, text: `Coach note, a private reference for your reply, not the caller's words and not to be read out:\n${current.text}`};
  }
  attached({receipt}) {
    if (receipt.status === 'ready') receipt.status = 'sent';
    receipt.requests = (receipt.requests ?? 0) + 1;
  }
  // A full line's ready note, as it is: the command writes the whole system item.
  deliver() {
    const current = this.current;
    if (!current || current.receipt.status !== 'ready' || this.closed.signal.aborted) return;
    current.receipt.status = 'sent'; return current.text;
  }
  ready() { return this.current?.receipt.status === 'ready' && !this.closed.signal.aborted; }
  // The latest note as session context, once, in a quiet moment. `maxNote` is the provider's limit.
  push(maxNote) {
    const current = this.current;
    if (!current || current.receipt.status !== 'ready' || this.closed.signal.aborted) return;
    const text = `Coach note ${this.pushed + 1}, replacing any earlier coach note: a private reference for your next replies, not the caller's words and not to be read out:\n${current.text}`;
    if (this.pushed >= MAX_NOTES) return void (current.receipt.status = 'no_room');
    if (text.length > maxNote) return void (current.receipt.status = 'too_long');
    this.pushed++; current.receipt.status = 'sent'; this.unacknowledged.push(current.receipt);
    return text;
  }
  // The provider confirmed the oldest pushed note it had not confirmed yet.
  acknowledged() { const receipt = this.unacknowledged.shift(); if (receipt) receipt.acknowledged = true; }
  close() {
    this.closed.abort();
    for (const receipt of this.receipts) {
      if (receipt.status === 'pending') receipt.status = 'closed';
      else if (receipt.status === 'ready') receipt.status = 'unused';
    }
  }
}
