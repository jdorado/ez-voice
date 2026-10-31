// A side coach. Each finished caller utterance goes to an operator-installed advisory capability; its note joins the
// model's context when the caller next starts to speak, so it shapes the reply to that utterance. Nothing waits for it,
// and a note never lands while the model is forming a reply or a hang-up: a mid-reply addition derailed Deepgram turns
// into repeated lookups and cost GPT-Live its end_call. A note a newer utterance overtook is dropped. The installed
// plugin owns what a note means; this only times and delivers it.
export const MAX_NOTES = 8; // notes a call can add: each one stays in the provider's context until the call ends
const MAX_LOOKUPS = 64;

export class PhoneAdvice {
  constructor({call, run, deadlineMs, adapter, send, receipts, now = Date.now}) {
    Object.assign(this, {call, run, deadlineMs, adapter, send, receipts, now});
    this.room = adapter.adviceRoom(); this.turn = 0; this.notes = 0; this.closed = new AbortController(); this.sent = [];
  }
  // The caller finished an utterance; `history` is what was said before it.
  heard(text, history) {
    if (this.closed.signal.aborted || typeof text !== 'string' || !text.trim() || this.turn >= MAX_LOOKUPS) return;
    this.speaking = false;
    if (this.ready) { this.ready.receipt.status = 'superseded'; this.ready = undefined; }
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
      if (a.id === this.applied) return void (receipt.status = 'unchanged');
      this.ready = {receipt, text: a.text};
      if (this.speaking) this.deliver();
    }, () => {
      if (receipt.status === 'pending') Object.assign(receipt, {status: signal.aborted && !this.closed.signal.aborted ? 'timeout' : 'unavailable', milliseconds: this.now() - began});
    });
  }
  // The caller started to speak: the model is listening, so a ready note can join its context.
  callerStarted() { this.speaking = true; this.deliver(); }
  deliver() {
    const ready = this.ready; if (!ready || this.closed.signal.aborted) return;
    this.ready = undefined;
    const note = `Coach note ${this.notes + 1}, replacing any earlier coach note: a private reference for your next replies, not the caller's words and not to be read out.\n${ready.text}`;
    if (note.length > this.adapter.constructor.maxAdviceNote) return void (ready.receipt.status = 'too_long');
    if (this.notes >= MAX_NOTES || note.length > this.room) return void (ready.receipt.status = 'no_room');
    this.room -= note.length; this.notes++; this.applied = ready.receipt.id;
    for (const message of this.adapter.adviceMessages(note)) this.send(message);
    ready.receipt.status = 'sent'; this.sent.push(ready.receipt);
  }
  // The provider confirmed the oldest note it had not yet confirmed.
  acknowledged() { const receipt = this.sent.shift(); if (receipt) receipt.acknowledged = true; }
  close() {
    this.closed.abort();
    if (this.ready) { this.ready.receipt.status = 'undelivered'; this.ready = undefined; }
    for (const receipt of this.receipts) if (receipt.status === 'pending') receipt.status = 'closed';
  }
}
