// A side coach. Each finished caller utterance goes to an operator-installed advisory capability. Where the listener
// relays the model's requests (src/phone-think.mjs), the latest note rides on each of them until a newer one replaces
// it and never joins the standing instructions: an added prompt sent Deepgram's Gemini into lookups on every call,
// whatever the note said. A speech-to-speech session (GPT-Live) takes the note as session context instead, when the
// caller next starts to speak, never while the model forms a reply or a goodbye. Nothing waits for it, and a note a
// newer utterance overtook is dropped. The installed plugin owns what a note means; this only times and attaches it.
export const MAX_NOTES = 8; // session notes a call can add: each stays in the session's context until the call ends
const MAX_LOOKUPS = 64;

export class PhoneAdvice {
  constructor({call, run, deadlineMs, receipts, now = Date.now}) {
    Object.assign(this, {call, run, deadlineMs, receipts, now});
    this.turn = 0; this.pushed = 0; this.unacknowledged = []; this.closed = new AbortController();
  }
  // The caller finished an utterance; `history` is what was said before it.
  heard(text, history) {
    if (this.closed.signal.aborted || typeof text !== 'string' || !text.trim() || this.turn >= MAX_LOOKUPS) return;
    const turn = ++this.turn, began = this.now(), receipt = {turn, status: 'pending'};
    const signal = AbortSignal.any([this.closed.signal, AbortSignal.timeout(this.deadlineMs)]);
    const request = {call: this.call, turn, text: text.slice(0, 2000), deadline_at: began + this.deadlineMs,
      history: history.slice(-6).map(t => ({who: t.who, text: t.text.slice(-1000)}))};
    this.receipts.push(receipt);
    Promise.resolve().then(() => this.run(request, signal)).then(result => {
      if (receipt.status !== 'pending') return;
      receipt.milliseconds = this.now() - began;
      if (result.status !== 'available') return void (receipt.status = result.status);
      const a = result.advice;
      Object.assign(receipt, {id: a.id, source: a.source, source_revision: a.source_revision, confidence: a.confidence});
      if (turn !== this.turn) return void (receipt.status = 'superseded');
      if (a.id === this.current?.receipt.id) return void (receipt.status = 'unchanged');
      if (this.current?.receipt.status === 'ready') this.current.receipt.status = 'unused';
      this.current = {receipt, text: a.text}; receipt.status = 'ready';
    }, () => {
      if (receipt.status === 'pending') Object.assign(receipt, {status: signal.aborted && !this.closed.signal.aborted ? 'timeout' : 'unavailable', milliseconds: this.now() - began});
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
  // The latest note as session context, once: when the caller starts to speak. `maxNote` is the provider's limit.
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
