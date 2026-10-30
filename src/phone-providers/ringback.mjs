// The line rings on while the speech session starts: an answered call hears the North American ringback (440 + 480 Hz,
// two seconds on, four off) until the model's first audible words, so the seconds a provider takes to start sound like the
// phone still ringing, not a silent pickup a caller talks into. Mu-law frames of 20 ms, as Twilio Media Streams carry them.
import {pcmToUlaw, ulawToPcm, FRAME} from './g711.mjs';

const RATE = 8000, ON = 100, OFF = 200; // frames of 20 ms: 2 s of tone, 4 s of quiet
const AMPLITUDE = 4000; // each of the two tones, about -18 dBFS together: a ring, not a blast
const AUDIBLE = 400; // RMS of a frame above which provider audio is speech, not the silence some providers stream

const tone = Int16Array.from({length: ON * FRAME}, (_, i) =>
  Math.round(AMPLITUDE * (Math.sin(2 * Math.PI * 440 * i / RATE) + Math.sin(2 * Math.PI * 480 * i / RATE))));
const toneFrames = Array.from({length: ON}, (_, f) => pcmToUlaw(tone.subarray(f * FRAME, (f + 1) * FRAME)).toString('base64'));
const quiet = Buffer.alloc(FRAME, 0xff).toString('base64'); // mu-law silence
export const RING_CYCLE = [...toneFrames, ...Array(OFF).fill(quiet)];

// Whether a chunk of mu-law audio (base64) carries speech: any 20 ms frame of it above the silence level.
export function audible(base64) {
  const samples = ulawToPcm(Buffer.from(base64, 'base64'));
  for (let start = 0; start < samples.length; start += FRAME) {
    const frame = samples.subarray(start, start + FRAME);
    let sum = 0;
    for (const s of frame) sum += s * s;
    if (frame.length && Math.sqrt(sum / frame.length) > AUDIBLE) return true;
  }
  return false;
}
