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
