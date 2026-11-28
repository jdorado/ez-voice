// Use phrases specific to a mailbox. A name, a long greeting, a pause or "leave a message"
// by itself can come from a live person. The line's instructions handle ambiguous greetings.
const MAILBOX = [
  /\b(?:your |this )?call (?:has been |is being )forwarded to (?:the |an? )?(?:automatic |automated )?(?:voice ?mail|voice messag(?:e|ing) system)\b/,
  /^(?:we(?:'re| are) sorry )?(?:the |this )?(?:voice ?mail(?: box)?|mailbox) (?:is (?:currently |now )?|has been )(?:full|not (?:yet )?set up)\b/,
  /\b(?:leave|record) (?:a |your )(?:(?:voice |recorded )?message|name and number) (?:after|at|following) (?:the )?(?:beep|tone|signal)\b/,
  /\b(?:after|at|following) the (?:beep|tone|signal) (?:please )?(?:leave|record) (?:a |your )?message\b/,
  /\b(?:please leave|leave me) (?:a |your )?message (?:and i(?:'ll| will) (?:call|get) (?:you )?back|and i(?:'ll| will) return your call)\b/,
  /\b(?:deje|deja|grabe|graba) (?:su |tu |un )mensaje (?:de voz )?(?:por favor )?(?:despues del|tras el|al oir el) (?:tono|pitido)\b/,
  /\b(?:su|esta) llamada (?:ha sido|fue|se ha) (?:transferida|enviada|desviada) al buzon de voz\b/,
];
// The carrier test used this compact personal greeting with no mention of a tone.
const SHORT_GREETING = /^(?:this is|you(?:'ve| have) reached) (.{1,80})[,.:!]\s*please leave (?:a|your) message[.!]?$/iu;
const NAME_OR_ORGANIZATION = /^\p{Lu}[\p{L}\p{M}'-]*(?: (?:\p{Lu}[\p{L}\p{M}'-]*|and|of|the|&))*$/u;
const SHORT_GREETING_WITHOUT_PUNCTUATION = /^(?:this is|you(?:'ve| have) reached) (?:[a-z][a-z'-]* ){1,2}please leave your message$/;

export function mailboxGreeting(text) {
  if (typeof text !== 'string') return false;
  const words = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (MAILBOX.some(pattern => pattern.test(words))) return true;
  const greeting = text.trim().replace(/[’‘]/g, "'").replace(/^(?:hi|hello)[,.!\s]+/i, '');
  const identity = SHORT_GREETING.exec(greeting)?.[1].replace(/^(?:the|dr\.?|mr\.?|ms\.?|mrs\.?)\s+/i, '');
  if (identity && NAME_OR_ORGANIZATION.test(identity)) return true;
  if (/[,.!?;:]/.test(greeting.replace(/[.!]$/, ''))) return false;
  return SHORT_GREETING_WITHOUT_PUNCTUATION.test(words.replace(/^(?:hi|hello) /, ''));
}

export function latestCallerText(body) {
  const last = Array.isArray(body?.contents) ? body.contents.at(-1) : undefined;
  if (last?.role !== 'user' || !Array.isArray(last.parts) || !last.parts.every(part => typeof part?.text === 'string')) return;
  return last.parts.map(part => part.text).join(' ').slice(0, 20000);
}

// A machine on a placed call, from the callee's first words: the reference bench's Realtime backstop (voicemail.kind and
// realtime_catch, with the validator patterns they use), ported pattern for pattern. machineKind answers 'screener', 'carrier',
// 'ivr', 'voicemail' or undefined; a hold or connecting message alone, a live question or a person offering to take a message is
// never a machine. Telecom phrases only: what the line says to a screener or a person stays in its instructions.
const re = (source, flags = 'i') => new RegExp(source, flags);
// validator (harness/tool_decision_validator.py)
const LIVE_Q = re(String.raw`\bwho(?:'?s| is| are)\b[^.?!]*\?|\b(?:are you|you) still there\b|\bhello\s*\?|\bcan you hear me\b` +
  String.raw`|\bwhat(?:'?s| is) (?:this|it) (?:about|regarding|for)\b|\bwho (?:is )?(?:this|calling|speaking)\b` +
  String.raw`|\b(?:sorry|pardon|what)\s*\?`);
const LIVE_OFFER = re(String.raw`\b(?:leave|give) (?:a|your|him|her) message with me\b|\bcan i take (?:a|your) message\b` +
  String.raw`|\b(?:i can|i'?ll|let me) take (?:a|your) message\b|\b(?:want|like) to leave (?:a|him|her) (?:message|note)\b` +
  String.raw`|\b(?:i|she|he|we|they|someone) (?:can|could|'?ll|will|would) take (?:a |the |your )?(?:message|one)\b` +
  String.raw`|\bwant me to (?:take|pass along|give (?:him|her)) (?:a |the )?message\b`);
const VM_MARK = re(String.raw`\b(?:after|at) the (?:tone|beep)\b|\byou'?ve reached\b|\b(?:can'?t|cannot|unable to|not able to) (?:take|answer|come to) ` +
  String.raw`(?:your|the|my) (?:call|phone)\b|\brecord (?:your|a) (?:message|name)\b|\bleave (?:a|your) (?:message|name)\b(?! with me)` +
  String.raw`|\bmailbox\b|\bvoice ?mail (?:box|system)\b|\bforwarded to (?:an automated|voice ?mail|the voice)` +
  String.raw`|\bpress (?:\d|one|two|three|four|five|six|seven|eight|nine|zero|the pound|pound|star)\b` +
  String.raw`|\b(?:not|no longer) in service\b|\bhas been disconnected\b|\bdial again\b` +
  String.raw`|\bthe (?:number|person|party) (?:you'?ve |you have |you are |you'?re |you )(?:dialed|called|calling|trying)` +
  String.raw`|\bscreening service\b|\bsay your name and (?:why|the reason)\b|\bname and (?:the )?reason for calling\b` +
  String.raw`|\bsee if this person is available\b|\bstay on the line\b|\bplease hold\b|\bthis call (?:may|is being) recorded\b` +
  String.raw`|\ball (?:of )?(?:our )?(?:representatives|agents|associates) are (?:busy|currently (?:busy|assisting))|\bestimated wait time\b` +
  String.raw`|\byour call is important to us\b`);
const SCREENER_PROMPT = re(String.raw`\bscreening service\b|\bsay your name and (?:why|the reason)\b|\bname and (?:the )?reason for (?:your )?calling\b` +
  String.raw`|\brecord your name\b|\bstate your name\b`);
const HOLD_MSG = re(String.raw`\bplease hold\b|\bstay on the line\b|\bbeing connected\b|\bconnecting your call\b|\bsee if this person is available\b` +
  String.raw`|\bone moment,? please\b`);
const VM_TERMINAL = re(String.raw`\b(?:after|at) the (?:tone|beep)\b|\bleave (?:a|your) message\b(?! with me)|\bmailbox\b|\b(?:not|no longer) in service\b` +
  String.raw`|\bhas been disconnected\b|\bdial again\b|\bthe (?:number|person|party) (?:you'?ve |you have |you are |you'?re |you )(?:dialed|called)` +
  String.raw`|\b(?:can'?t|cannot|unable to|not able to) (?:take|answer|come to) (?:your|the|my) (?:call|phone)\b|\bpress (?:\d|one|two|three|four|` +
  String.raw`five|six|seven|eight|nine|zero|the pound|pound|star)\b|\bis not available\b|\bare(?:n'?t| not) available\b|\bvoice ?mail (?:box|system)\b` +
  String.raw`|\bforwarded to (?:an automated|voice ?mail|the voice)`);
const machineScript = t => VM_MARK.test(t) && !LIVE_Q.test(t) && !LIVE_OFFER.test(t);
// bench/voicemail.py
const FIX_D = re([String.raw`\bvoice\s?mail\b`, String.raw`forwarded to (?:an automated )?voice ?(?:mail|messaging)`, String.raw`at the (?:tone|beep)[, ]+(?:please )?(?:record|leave)`,
  String.raw`leave (?:a |your )?(?:brief )?message`, String.raw`leave (?:your )?name and (?:number|phone|message)`, String.raw`i'?m not available right now`,
  String.raw`can'?t (?:come to|take|answer) (?:the|your) (?:phone|call)`, String.raw`sorry i missed your call`, String.raw`please (?:leave|record) (?:a |your )?(?:message|name)`,
  String.raw`after the (?:beep|tone)`, String.raw`telephone number [\d\s]+can'?t take your call`, String.raw`to (?:review|rerecord|add to|listen to|erase|continue recording|mark)`,
  String.raw`press (?:1|2|3|4|5|6|7|8|9|0|pound|star|#|\*)`, String.raw`if you'?re satisfied with`, String.raw`your message has been sent`, String.raw`to send your message as is`,
  String.raw`google voice`, String.raw`calling (?:from )?[a-z0-9 ]+, (?:what is this call|may i ask)`, String.raw`the (?:person|number|subscriber) you (?:are trying to reach|have called)`,
  String.raw`the (?:person|number|subscriber) is (?:not available|unavailable)`, String.raw`this is the voicemail (?:for|of)`,
  String.raw`you have reached the (?:voicemail|voice mail) (?:of|for|box)`].join('|'));
const IVR = re(String.raw`\bpress (?:\d|one|two|three|four|five|six|seven|eight|nine|zero|the pound|pound|star|#|\*)\b|\bfor (?:english|spanish)\b` +
  String.raw`|\bmain menu\b|\bto (?:review|rerecord|erase|send your message)\b` +
  String.raw`|\bpara espa[ñn]ol\b|\boprima\b|\bmessage is too short\b|\bfor more options\b` +
  String.raw`|\bthank you for calling [^.?!]{1,40}[.,] to\b`);
const CARRIER = re(String.raw`\b(?:not|no longer) in service\b|\bhas been disconnected\b|\bdial again\b|\bmailbox (?:is )?full\b` +
  String.raw`|\bcannot accept (?:any )?(?:new )?messages\b|\bthe (?:number|person|party|subscriber) (?:you'?ve |you have |you are |` +
  String.raw`you'?re |you )?(?:dialed|called|calling|trying)|\bis (?:not available|unavailable)\b` +
  String.raw`|\bcannot be completed as dialed\b`);
const WEAK = re(String.raw`i'?m not available right now`, 'gi');
const SCREENER = re(String.raw`google voice|screening service|\bcall screen|\bcall assist\b|before i try to connect you` +
  String.raw`|\bi'?ll see if (?:this|the) person is available\b` +
  String.raw`|\bi'?ll let (?:this|the) person know\b|\bsmart call blocker\b|\b(?:this|your) call is being screened\b` +
  String.raw`|\bi'?m screening (?:calls|this call)\b` +
  String.raw`|\bby google,? recording this call\b|\brecording this call for the person you'?re trying to reach\b` +
  String.raw`|\bi'?ll see if (?:this|the) person\b|\btell me your name and reason\b|\bthis is google\b.*\bscreening\b`);
const GREETING = re(String.raw`\bleave (?:me |us )?(?:a |your )?(?:short |brief |detailed |quick )?(?:message|name)\b` +
  String.raw`|\byou have reached\b(?! the right)|\b(?:can'?t|cannot) (?:get to|answer) (?:the |my )?(?:phone|call) right now\b` +
  String.raw`|\bi'?m (?:not here|unavailable|away from (?:the|my) phone) right now\b|\bwe are not available\b` +
  String.raw`|\bplease call again\b|\bno longer accept calls\b`);
const GATE_HARD = re(String.raw`\b(?:automated )?voice messag(?:e|ing) system\b|\b(?:your )?call has been forwarded\b|^\W*please leave your\b` +
  String.raw`|\bleave a mess\b|\bnothing has been recorded\b|\bfor (?:delivery|further|more) options\b|\bpress any key\b` +
  String.raw`|\bsimply hang up\b|\bto schedule or cancel an appointment,? press\b` +
  String.raw`|\bsubscriber you are calling cannot be completed\b`);
const QUEUE = re(String.raw`\ball (?:of )?(?:our )?(?:representatives|agents|associates) are (?:busy|currently (?:busy|assisting))` +
  String.raw`|\bestimated wait time\b|\byour call is important to us\b`);
const OPENER_Q = re(String.raw`^\W*(?:(?:hello|hi|hey|yes|yeah)\W*\?\W*)+`);
const HARD = re(String.raw`\b(?:tone|beep|mailbox|voice ?mail|record (?:your|a)|press|not in service|disconnected|automated|forwarded)\b` +
  String.raw`|\d[ .,]+\d[ .,]+\d[ .,]+\d`);
const CARRIER_TIER0 = re(String.raw`\bcannot be completed as dialed\b|\b(?:wireless )?customer you are calling\b|\bnumber (?:you have dialed |you dialed )?has been changed\b`);
const CARRIER_NUM = re(String.raw`\d[\d .]{5,}\s*,?\s*is not available\b|\b(?:person|party|number) you have called is not available\b`);
const HANG_ON = re(String.raw`^\W*(?:hang|hold) on\b`);
const MACHINE_SCREEN = re(String.raw`google voice|screening service|\bcall screen|\bcall assist\b`);
const MORE_OPTIONS = re(String.raw`\bfor (?:delivery|further|more) options\b|\bpress any key\b`);

export function machineKind(text) {
  const t = typeof text === 'string' ? text : '';
  if (HANG_ON.test(t) && !(MACHINE_SCREEN.test(t) || GREETING.test(t) || VM_TERMINAL.test(t))) return;
  if ((SCREENER_PROMPT.test(t) || SCREENER.test(t)) && !(GREETING.test(t) || VM_TERMINAL.test(t))) return 'screener';
  if (CARRIER_NUM.test(t)) return 'carrier';
  if (QUEUE.test(t)) return 'ivr';
  const fixD = FIX_D.test(t.replace(WEAK, ' ')), greeting = GREETING.test(t), gate = GATE_HARD.test(t);
  if (!(fixD || machineScript(t) || greeting || gate || IVR.test(t) || CARRIER_TIER0.test(t))) return;
  // a person asks ("do you want to leave a message?"); a machine that asks carries a hard marker (tone, beep, record, press, a number)
  const asks = t.replace(OPENER_Q, '').includes('?');
  if (asks && !gate && !HARD.test(t) && !CARRIER_NUM.test(t) && !IVR.test(t)) return;
  const strong = greeting || gate || VM_TERMINAL.test(t);
  if (LIVE_Q.test(t) && !strong) return;
  if (HOLD_MSG.test(t) && !VM_TERMINAL.test(t)) return; // a hold or connecting message alone: a person may be next
  if (IVR.test(t) || MORE_OPTIONS.test(t)) return 'ivr';
  if (CARRIER.test(t)) return 'carrier';
  return 'voicemail';
}
// The callee's words of one utterance, screened only in the call's first `max` utterances.
export const realtimeCatch = (text, utterancesSoFar = 0, max = 2) => utterancesSoFar >= max ? undefined : machineKind(text);
