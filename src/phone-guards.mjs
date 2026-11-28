// Guards on what a speech-to-speech model says, read from its transcript as it streams: the audio is generated faster than it
// plays, so the words reach the bridge before the caller hears them. Ported from a reference bench (Python, Realtime arm
// "tool_guard" and stream guard mode "ai"); the patterns are kept as they were measured there. Pure: no sockets, no timers.

// A tool call written into speech ("Have a great day. [end_call]", '<call_tool:handoff_to_human .../>', 'reason="VM_IVR_detected"'):
// names, markup and reason codes, as markup or as words. The reference gate's token set, unchanged.
export const TOOL_TOKEN = new RegExp(
  String.raw`\bend[_ ]call\b|\bhandoff[_ ]to[_ ]human\b|\bsend[_ ]contact[_ ]info\b|\bbook[_ ]call\b|\bnext[_ ]contact\b|\bschedule[_ ]call\b|\bcheck[_ ]availability\b` +
  String.raw`|<\s*call[_ ]?tool|\[\s*tool[_ ]?call\s*\]|\bcall_tool\b|\btool_call\b` +
  String.raw`|\bVM_IVR_detected\b|\bgoogle_screening_detected\b|\bhanded_off\b|\bwrong_number\b` +
  String.raw`|"reason"\s*:|\breason\s*[=:(]\s*"?[a-z]+_[a-z_]+|\breason\s*=\s*"`, 'i');

// Fires once per reply, at the first complete tool token in the reply's transcript so far (a token split across deltas is joined).
export class ToolTokenGate {
  constructor() { this.reset(); }
  reset() { this.text = ''; this.fired = false; }
  feed(delta) {
    if (this.fired || !delta) return false;
    this.text += delta;
    return this.fired = TOOL_TOKEN.test(this.text);
  }
}

// Delivery tags the model copies into its speech ("[calm]", "[warmly]"): one or two lowercase words in brackets, never "[Apt 4B]" or "[2]".
const BRACKET_TAG = /\s?\[[a-z]{3,12}(?: [a-z]{3,12})?\]/;
const TAG_ONLY = new RegExp(`^(?:${BRACKET_TAG.source})$`);
// Streaming: a tag split across deltas ("[ca" + "lm]") is held and dropped; a bracket that turns out not to be a tag passes unchanged.
export class TagStripper {
  static MAXLEN = 28;
  constructor() { this.buf = ''; this.removed = 0; }
  feed(delta) {
    let out = '';
    for (const ch of delta ?? '') {
      if (this.buf) {
        this.buf += ch;
        if (ch === ']') { const b = this.buf, tag = TAG_ONLY.test(' ' + b) || TAG_ONLY.test(b); this.buf = ''; out += tag ? '' : b; this.removed += tag; }
        else if (this.buf.length > TagStripper.MAXLEN || ch === '[') {
          const b = this.buf; this.buf = '';
          out += ch === '[' ? b.slice(0, -1) : b;
          if (ch === '[') this.buf = '[';
        }
      } else if (ch === '[') this.buf = '[';
      else out += ch;
    }
    return out;
  }
  flush() { const b = this.buf; this.buf = ''; return b; }
}

// The model saying it is an AI when the caller never asked. Both patterns are the reference judge's.
export const AI_ADMIT = /\b(digital assistant|virtual assistant|ai assistant|i'?m an? ai|automated assistant)\b/i;
export const AI_ASK = new RegExp(String.raw`\b(are you (a |an )?(real|human|person|robot|bot|ai|machine|recording|computer)|` +
  String.raw`(?:are )?you (?:some (?:kind|sort) of |a )(?:robot|bot|ai|machine|computer)\b|` +
  String.raw`is this (a |an )?(robot|bot|recording|ai|machine|computer|real person)|` +
  String.raw`am i (talking|speaking) (to|with) (a |an )?(real|person|human|robot|machine|computer|ai))`, 'i');

// The start of the sentence holding index `at` (0 in the first sentence).
const sentenceStart = (text, at) => { if (at <= 0) return 0; const cut = Math.max(text.lastIndexOf('.', at - 1), text.lastIndexOf('!', at - 1), text.lastIndexOf('?', at - 1)); return cut < 0 ? 0 : cut + 1; };

// One reply's watch for a volunteered AI admission: `feed` answers the clean part said before it (the reply is cancelled and the model
// asked again), at most once per caller turn: the re-asked reply is not watched again.
export class AiGuard {
  constructor(hint) { this.hint = hint; this.text = ''; this.fired = false; this.reasking = false; }
  reply() {
    if (this.reasking) { this.reasking = false; return; } // the re-ask's own reply: same turn, one re-ask
    this.text = ''; this.fired = false;
  }
  feed(delta, callerSaid) {
    if (this.fired || !delta) return;
    this.text += delta;
    const admit = AI_ADMIT.exec(this.text);
    if (!admit || AI_ASK.test(callerSaid ?? '')) return;
    this.fired = this.reasking = true;
    return this.text.slice(0, sentenceStart(this.text, admit.index)).trimEnd();
  }
  // The system item for the model: what went wrong, and what it already said.
  note(said) {
    const kept = said.trim();
    return `System: ${this.hint}. Say it in your own words.` + (kept ? ` You already said: "${kept.slice(0, 200)}". Continue from there in one short line; never repeat what you already said.` : '');
  }
}
