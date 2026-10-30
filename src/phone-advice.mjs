// One bounded advisory operation per finalized caller utterance. The installed plugin owns its meaning.
import {randomBytes} from 'node:crypto';

export class PhoneAdvice {
  constructor({call, run, deadlineMs, adapter, send, history, receipts, now = Date.now}) {
    Object.assign(this, {call, run, deadlineMs, adapter, send, history, receipts, now}); this.turn = 0;
  }
  begin(itemId) {
    if (!itemId || this.current?.itemId === itemId) return;
    this.cancel('superseded'); this.current = {itemId, turn: ++this.turn, revision: 0};
  }
  stop(itemId) {
    if (!this.current) this.begin(itemId);
    const c = this.current;
    if (!c || itemId !== c.itemId || c.deadline || c.responded) return;
    c.began = this.now(); c.deadline = c.began + this.deadlineMs;
    c.timer = setTimeout(() => this.finish(c, c.note ? 'ack_timeout' : 'deadline'), this.deadlineMs);
  }
  final(itemId, text) {
    const c = this.current;
    if (!c || c.itemId !== itemId || c.responded || !text?.trim() || c.text === text) return;
    this.stop(itemId); c.abort?.abort(); this.clearNote(c); c.advice = undefined; c.text = text;
    const revision = ++c.revision, abort = c.abort = new AbortController();
    const request = {call: this.call, turn: c.turn, revision, text: text.slice(0, 2000),
      history: this.history().slice(-6).map(t => ({who: t.who, text: t.text.slice(-1000)})), deadline_at: c.deadline};
    Promise.resolve().then(() => { abort.signal.throwIfAborted(); return this.run(request, abort.signal); }).then(result => {
      if (this.current !== c || c.revision !== revision || c.responded || abort.signal.aborted || this.now() >= c.deadline) return;
      if (result.status !== 'available') return this.finish(c, result.status);
      c.advice = result.advice; c.note = 'adv_' + randomBytes(12).toString('hex');
      for (const message of this.adapter.adviceItem(c.note, result.advice.text)) this.send(message);
    }).catch(() => {
      if (this.current === c && c.revision === revision && !c.responded && !abort.signal.aborted) this.finish(c, 'unavailable');
    });
  }
  acknowledged(id) {
    const c = this.current;
    if (c && id === c.note && !c.responded && this.now() < c.deadline) this.finish(c, 'accepted_before_response');
  }
  responseStarted(id) {
    const c = this.current;
    if (c?.responded && c.awaitingResponse) { c.responseId = id; c.awaitingResponse = false; }
    if (c && !c.responded && c.deadline) this.finish(c, 'provider_started_early', false);
  }
  responseDone(id) { if (id && id === this.current?.responseId) this.clearNote(this.current); }
  clearNote(c) {
    if (!c?.note) return;
    for (const message of this.adapter.clearAdvice(c.note)) this.send(message);
    c.note = undefined;
  }
  finish(c, status, respond = true) {
    if (this.current !== c || c.responded) return;
    c.responded = true; clearTimeout(c.timer); c.abort?.abort();
    if (status !== 'accepted_before_response') this.clearNote(c);
    this.receipts.push({turn: c.turn, revision: c.revision, status, milliseconds: Math.max(0, this.now() - c.began),
      ...(c.advice && {id: c.advice.id, source: c.advice.source, source_revision: c.advice.source_revision})});
    if (respond) { c.awaitingResponse = true; for (const message of this.adapter.respond()) this.send(message); }
  }
  cancel(reason = 'closed') {
    const c = this.current; if (!c) return;
    clearTimeout(c.timer); c.abort?.abort(); this.clearNote(c);
    if (c.deadline && !c.responded) this.receipts.push({turn: c.turn, revision: c.revision, status: reason});
    this.current = undefined;
  }
}
