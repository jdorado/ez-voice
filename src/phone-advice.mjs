// A side coach. Each finished caller utterance goes to an operator-installed advisory capability; when it answers, its
// note is added to the model's context for its later replies. Nothing waits for it: no reply is held, and a note a newer
// utterance overtook is dropped. The installed plugin owns what a note means; this only times and delivers it.
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
    const turn = ++this.turn, began = this.now(), receipt = {turn, status: 'pending'};
    const signal = AbortSignal.any([this.closed.signal, AbortSignal.timeout(this.deadlineMs)]);
    const request = {call: this.call, turn, text: text.slice(0, 2000), deadline_at: began + this.deadlineMs,
      history: history.slice(-6).map(t => ({who: t.who, text: t.text.slice(-1000)}))};
    this.receipts.push(receipt);
    const settle = status => { if (receipt.status === 'pending') Object.assign(receipt, {status, milliseconds: this.now() - began}); };
    Promise.resolve().then(() => this.run(request, signal)).then(result => {
      if (receipt.status !== 'pending') return;
      if (result.status !== 'available') return settle(result.status);
      const a = result.advice;
      Object.assign(receipt, {id: a.id, source: a.source, source_revision: a.source_revision, confidence: a.confidence});
      if (turn !== this.turn) return settle('superseded');
      if (a.id === this.applied) return settle('unchanged');
      const note = `Coach note ${this.notes + 1}, replacing any earlier coach note: a private reference for your next replies, not the caller's words and not to be read out.\n${a.text}`;
      if (note.length > this.adapter.constructor.maxAdviceNote) return settle('too_long');
      if (this.notes >= MAX_NOTES || note.length > this.room) return settle('no_room');
      this.room -= note.length; this.notes++; this.applied = a.id;
      for (const message of this.adapter.adviceMessages(note)) this.send(message);
      this.sent.push(receipt); settle('sent');
    }, () => settle(signal.aborted && !this.closed.signal.aborted ? 'timeout' : 'unavailable'));
  }
  // The provider confirmed the oldest note it had not yet confirmed.
  acknowledged() { const receipt = this.sent.shift(); if (receipt) receipt.acknowledged = true; }
  close() {
    this.closed.abort();
    for (const receipt of this.receipts) if (receipt.status === 'pending') receipt.status = 'closed';
  }
}
