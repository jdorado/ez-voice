// What each side said on a call, as the provider transcribed it while the call ran: the caller's words (the provider's
// speech-to-text) and the model's own words. Kept in the call's receipt, so whoever reads the receipt has the call's
// words without a second transcription. No audio is kept.
export const MAX_TRANSCRIPT = 100000; // characters across the call; past it the turns stop and the receipt says so

// A provider's transcript text, or undefined when it is not one.
export const words = value => typeof value === 'string' && value.length <= 20000 ? value : undefined;

// Two pieces of one turn: a space between sentences the provider streamed back to back ("call?I can").
const join = (head, part) => /[.?!]$/.test(head) && /^\S/.test(part) ? `${head} ${part}` : head + part;

export class Transcript {
  constructor(startedAt) { this.startedAt = startedAt; this.turns = []; this.chars = 0; this.truncated = false; }
  // `start` marks when the caller began to speak (a provider that sends their words only once an utterance is finished
  // sends them after the model may have begun to answer: the turn belongs where the speech began). `delta` continues the
  // speaker's current turn as it streams; `text` is one whole utterance.
  add(who, {delta, text, start} = {}) {
    const now = Date.now() - this.startedAt;
    if (who === 'caller' && start) { this.callerSince = now; this.cut = true; } // what the model says next is a new turn
    const part = delta ?? text;
    if (!part || this.truncated || (who !== 'caller' && who !== 'model')) return; // once full, nothing later is kept
    if (this.chars + part.length > MAX_TRANSCRIPT) { this.truncated = true; return; }
    this.chars += part.length;
    const last = this.turns.at(-1);
    if (last?.who === who && !(who === 'model' && this.cut)) {
      last.text = delta !== undefined || /\s$/.test(last.text) ? join(last.text, part) : `${last.text} ${part}`; return;
    }
    if (who === 'model') this.cut = false;
    const atMs = who === 'caller' ? this.callerSince ?? now : now;
    if (who === 'caller') this.callerSince = undefined;
    this.turns.push({who, text: part, atMs});
  }
  // The turns for the receipt, in the order they were spoken, trimmed; empty when nothing was transcribed.
  receipt() {
    const turns = [];
    for (const turn of [...this.turns].sort((a, b) => a.atMs - b.atMs)) {
      const text = turn.text.trim(), last = turns.at(-1);
      if (!text) continue;
      if (last?.who === turn.who) last.text = `${last.text} ${text}`;
      else turns.push({...turn, text});
    }
    return turns.length ? {transcript: turns, ...(this.truncated ? {transcriptTruncated: true} : {})} : {};
  }
}
