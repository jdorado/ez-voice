// Use phrases specific to a mailbox. A name, a long greeting, a pause or "leave a message"
// by itself can come from a live person. The line's instructions handle ambiguous greetings.
const MAILBOX = [
  /\b(?:your |this )?call (?:has been |is being )forwarded to (?:the |an? )?(?:automatic |automated )?(?:voice ?mail|voice messag(?:e|ing) system)\b/,
  /\b(?:voice ?mail(?: box)?|mailbox) (?:is (?:currently |now )?|has been )(?:full|not (?:yet )?set up)\b/,
  /\b(?:leave|record) (?:a |your )(?:(?:voice |recorded )?message|name and number) (?:after|at|following) (?:the )?(?:beep|tone|signal)\b/,
  /\b(?:after|at|following) the (?:beep|tone|signal) (?:please )?(?:leave|record) (?:a |your )?message\b/,
  /\b(?:please leave|leave me) (?:a |your )?message (?:and i(?:'ll| will) (?:call|get) (?:you )?back|and i(?:'ll| will) return your call)\b/,
  /\b(?:deje|deja|grabe|graba) (?:su |tu |un )mensaje (?:de voz )?(?:por favor )?(?:despues del|tras el|al oir el) (?:tono|pitido)\b/,
  /\b(?:su|esta) llamada (?:ha sido|fue|se ha) (?:transferida|enviada|desviada) al buzon de voz\b/,
];

export function mailboxGreeting(text) {
  if (typeof text !== 'string') return false;
  const words = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ');
  return MAILBOX.some(pattern => pattern.test(words));
}

export function latestCallerText(body) {
  const last = Array.isArray(body?.contents) ? body.contents.at(-1) : undefined;
  if (last?.role !== 'user' || !Array.isArray(last.parts) || !last.parts.every(part => typeof part?.text === 'string')) return;
  return last.parts.map(part => part.text).join(' ').slice(0, 20000);
}
