// Listening in: while the operator's backend says someone listens (the `words` answer {listen: true}), the call's two sides are
// mixed into one 8 kHz mu-law track and sent with the call's words (`audio`, base64, in order, one POST in flight). The caller's
// frames arrive from Twilio in real time; what we send Twilio is queued as Twilio queues it (it plays ahead of the clock in bursts,
// and a `clear` drops what was not played), so each caller frame is mixed with the same span of our queued audio. Nothing is kept
// while nobody listens, and this plugin still stores no audio.
import {pcmToUlaw, ulawToPcm} from './phone-providers/g711.mjs';

const MAX_PENDING = 8000 * 30; // our queued audio Twilio has not played yet, at most 30 s
const MAX_HEARD = 8000 * 10; // mixed audio waiting for the next POST, at most 10 s (older is dropped)

export class ListenTap {
  queued = Buffer.alloc(0);
  heard = [];
  heardBytes = 0;
  listening = false;
  // What we send the caller (a Twilio `media` payload), queued as Twilio plays it.
  out(base64) {
    const bytes = Buffer.from(base64, 'base64');
    this.queued = Buffer.concat([this.queued, bytes]);
    if (this.queued.length > MAX_PENDING) this.queued = this.queued.subarray(this.queued.length - MAX_PENDING);
  }
  clear() { this.queued = Buffer.alloc(0); }
  // One caller frame: Twilio played the same span of our queue meanwhile.
  caller(base64) {
    const theirs = Buffer.from(base64, 'base64'), ours = this.queued.subarray(0, theirs.length);
    this.queued = this.queued.subarray(ours.length);
    if (!this.listening) return;
    const a = ulawToPcm(theirs), b = ulawToPcm(ours), mixed = new Int16Array(a.length);
    for (let i = 0; i < a.length; i++) mixed[i] = Math.max(-32768, Math.min(32767, a[i] + (b[i] ?? 0)));
    this.heard.push(pcmToUlaw(mixed)); this.heardBytes += mixed.length;
    while (this.heardBytes > MAX_HEARD) this.heardBytes -= this.heard.shift().length;
  }
  // The mixed audio since the last call, base64, or undefined when there is none.
  take() {
    if (!this.heardBytes) return undefined;
    const all = Buffer.concat(this.heard); this.heard = []; this.heardBytes = 0;
    return all.toString('base64');
  }
  set(listening) { if (!listening) { this.heard = []; this.heardBytes = 0; } this.listening = listening; }
}

// The Twilio socket as the call sees it, with every `media` and `clear` we send passed to the tap first.
export function tapped(socket, tap) {
  const send = raw => {
    try {
      const message = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (message?.event === 'media' && typeof message.media?.payload === 'string') tap.out(message.media.payload);
      else if (message?.event === 'clear') tap.clear();
    } catch {}
    return socket.send(raw);
  };
  return new Proxy(socket, {get: (target, key) => key === 'send' ? send : typeof target[key] === 'function' ? target[key].bind(target) : target[key]});
}
