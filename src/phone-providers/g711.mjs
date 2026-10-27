// Pure-JS G.711 mu-law and PCM16 resampling, for providers that cannot take Twilio's 8 kHz mu-law directly.
// Everything is streaming: each class carries the state between chunks, so a call can be fed 20 ms at a time.

const BIAS = 0x84, CLIP = 32635;
const ULAW_TO_PCM = Int16Array.from({length: 256}, (_, byte) => {
  byte = ~byte & 0xff;
  const magnitude = (((byte & 0x0f) << 3) + BIAS) << ((byte & 0x70) >> 4);
  return byte & 0x80 ? BIAS - magnitude : magnitude - BIAS;
});

export const ulawToPcm = bytes => Int16Array.from(bytes, byte => ULAW_TO_PCM[byte]);

function encode(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  sample = Math.min(Math.abs(sample), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  return ~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 0x0f)) & 0xff;
}
export const pcmToUlaw = samples => Buffer.from(Uint8Array.from(samples, encode));

export const pcmBytes = samples => Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);

// 16-bit little-endian PCM bytes to samples. An odd trailing byte is returned for the next chunk.
export function pcmFromBytes(bytes, carry = Buffer.alloc(0)) {
  const data = carry.length ? Buffer.concat([carry, bytes]) : bytes;
  const even = data.length - (data.length % 2);
  const samples = new Int16Array(even / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return {samples, carry: data.subarray(even)};
}

// 8 kHz to 16 kHz: each input sample yields the midpoint with its predecessor, then itself.
export class Upsampler {
  last = 0;
  push(samples) {
    const out = new Int16Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      out[2 * i] = (this.last + samples[i]) >> 1; out[2 * i + 1] = samples[i]; this.last = samples[i];
    }
    return out;
  }
}

// N-to-1 decimation behind a Hamming-windowed sinc low-pass cut at the telephone band (3.4 kHz).
export class Downsampler {
  pending = new Float64Array(0);
  constructor(rate, to = 8000, taps = 31) {
    if (!Number.isInteger(rate / to) || rate < to) throw Error('Unsupported sample rate');
    this.factor = rate / to; this.taps = taps;
    const cutoff = Math.min(3400, to / 2) / rate, middle = (taps - 1) / 2;
    this.kernel = Float64Array.from({length: taps}, (_, i) => {
      const x = i - middle;
      return (x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1)));
    });
    const gain = this.kernel.reduce((a, b) => a + b, 0); this.kernel = this.kernel.map(k => k / gain);
  }
  push(samples) {
    if (this.factor === 1) return samples;
    const data = new Float64Array(this.pending.length + samples.length);
    data.set(this.pending); data.set(samples, this.pending.length);
    const out = []; let k = 0;
    for (; k + this.taps <= data.length; k += this.factor) {
      let sum = 0; for (let j = 0; j < this.taps; j++) sum += data[k + j] * this.kernel[j];
      out.push(Math.max(-32768, Math.min(32767, Math.round(sum))));
    }
    this.pending = data.slice(k);
    return Int16Array.from(out);
  }
  reset() { this.pending = new Float64Array(0); }
}

// Twilio plays what it is sent in order; whole 20 ms frames (160 bytes of mu-law) keep it simple.
export const FRAME = 160;
export class Framer {
  rest = Buffer.alloc(0);
  push(bytes) {
    const data = this.rest.length ? Buffer.concat([this.rest, bytes]) : bytes;
    const whole = data.length - (data.length % FRAME);
    this.rest = data.subarray(whole);
    return data.subarray(0, whole);
  }
  // The end of a model turn: pad the last partial frame with mu-law silence.
  flush() {
    if (!this.rest.length) return Buffer.alloc(0);
    const frame = Buffer.alloc(FRAME, 0xff); this.rest.copy(frame); this.rest = Buffer.alloc(0);
    return frame;
  }
  reset() { this.rest = Buffer.alloc(0); }
}
