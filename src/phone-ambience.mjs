// A quiet office under the persona's voice (a line's `ambienceDb`), ported from Quarre's phone bench (quarre_v2 bench/ambience.py,
// Milan's "office bed"): band-limited 1/f room tone plus soft keyboard clicks, no voices, synthetic and deterministic, looped. Under the
// voice it hides the hard onset and offset of synthetic speech, and between lines the call never goes dead, so the persona sounds like
// a person in a room. At the default -46 dBFS no 20 ms frame of it reaches speech level (about -38 dBFS).
import {pcmToUlaw, ulawToPcm} from './phone-providers/g711.mjs';

const RATE = 8000, LOOP_S = 20, FRAME = 160;
const beds = new Map();

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const gauss = random => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
const rmsTo = (x, db) => { const r = Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length) || 1, g = 32768 * 10 ** (db / 20) / r; return x.map(v => v * g); };

// One loop of the bed as 16-bit samples at 8 kHz.
export function officeBed(db = -46, seed = 7) {
  const key = `${db}:${seed}`;
  if (beds.has(key)) return beds.get(key);
  const random = rng(seed), n = RATE * LOOP_S;
  // 1/f room tone (Paul Kellet's pink filter), high-passed at about 120 Hz
  let b0 = 0, b1 = 0, b2 = 0, hp = 0, last = 0;
  const room = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = gauss(random);
    b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
    const pink = b0 + b1 + b2 + w * 0.1848;
    hp = 0.91 * (hp + pink - last); last = pink; room[i] = hp;
  }
  // soft keyboard clicks: short decaying bursts every 0.15 to 1.4 s
  const clicks = new Float64Array(n);
  for (let t = Math.floor(random() * RATE); t < n - RATE / 20; t += Math.floor((0.15 + random() * 1.25) * RATE))
    for (let k = 0; k < RATE / 50 && t + k < n; k++) clicks[t + k] += gauss(random) * Math.exp(-k / (RATE * 0.003));
  const tone = rmsTo(Array.from(room), db), taps = rmsTo(Array.from(clicks), db - 12), mix = tone.map((v, i) => v + taps[i]);
  const ramp = RATE / 20; // a seamless loop: the end fades into the start
  for (let i = 0; i < ramp; i++) mix[i] = mix[i] * (i / ramp) + mix[n - ramp + i] * (1 - i / ramp);
  const bed = Int16Array.from(mix.slice(0, n - ramp), v => Math.max(-32768, Math.min(32767, Math.round(v))));
  beds.set(key, bed);
  return bed;
}

// The bed as a running stream: `under(base64)` mixes it under mu-law audio, `frame()` is 20 ms of the bed alone.
export class Ambience {
  constructor(db) { this.bed = officeBed(db); this.at = 0; }
  take(n) { const out = new Int16Array(n); for (let i = 0; i < n; i++) { out[i] = this.bed[this.at]; this.at = (this.at + 1) % this.bed.length; } return out; }
  under(base64) {
    const voice = ulawToPcm(Buffer.from(base64, 'base64')), bed = this.take(voice.length);
    return pcmToUlaw(Int16Array.from(voice, (v, i) => Math.max(-32768, Math.min(32767, v + bed[i])))).toString('base64');
  }
  frame() { return pcmToUlaw(this.take(FRAME)).toString('base64'); }
}
