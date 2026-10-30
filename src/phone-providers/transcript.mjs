// What each side said on a call, as the provider transcribed it while the call ran: the caller's words (the provider's
// speech-to-text) and the model's own words. Kept in the call's receipt, so whoever reads the receipt has the call's
// words without a second transcription. No audio is kept.
export const MAX_TRANSCRIPT = 100000; // characters across the call; past it the turns stop and the receipt says so

// A provider's transcript text, or undefined when it is not one.
export const words = value => typeof value === 'string' && value.length <= 20000 ? value : undefined;

export class Transcript {
  constructor(startedAt) { this.startedAt = startedAt; this.turns = []; this.chars = 0; this.truncated = false; }
  // `delta` continues the speaker's current turn as it streams; `text` is one whole utterance.
  add(who, {delta, text} = {}) {
    const part = delta ?? text;
    if (!part || (who !== 'caller' && who !== 'model')) return;
    if (this.chars + part.length > MAX_TRANSCRIPT) { this.truncated = true; return; }
    this.chars += part.length;
    const last = this.turns.at(-1);
    if (last?.who !== who) this.turns.push({who, text: part, atMs: Date.now() - this.startedAt});
    else last.text += delta !== undefined || /\s$/.test(last.text) ? part : ` ${part}`;
  }
  // The turns for the receipt, trimmed; empty when nothing was transcribed.
  receipt() {
    const turns = this.turns.map(t => ({...t, text: t.text.trim()})).filter(t => t.text);
    return turns.length ? {transcript: turns, ...(this.truncated ? {transcriptTruncated: true} : {})} : {};
  }
}
