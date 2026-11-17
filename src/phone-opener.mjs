// A placed call's fixed first line, pre-rendered (a line's `greetingFile` on a Deepgram line, outbound). The model-written greeting
// waits for the callee's hello, the provider's end of turn, a language-model request and the voice: 2 to 3 s on the phone (lab calls,
// 2026-11-17). Rendered once per voice, model, speed and text in the line's ElevenLabs voice, the line is played to Twilio as soon as
// the callee's hello ends, and the session starts with it in its history, so the model goes on from there.
import {Pronouncer} from './phone-speech.mjs';

const cache = new Map();
const FRAME = 160; // 20 ms of G.711 mu-law at 8 kHz

// The clip as base64 mu-law frames. A failed render is not cached, so the next call tries again.
export function renderOpener(config, text, fetchImpl = fetch) {
  const said = config.pronunciations ? new Pronouncer(config.pronunciations).say(text) : text;
  const key = JSON.stringify([config.voice, config.ttsModel, config.ttsSpeed, said]);
  if (!cache.has(key)) cache.set(key, (async () => {
    const response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voice)}?output_format=ulaw_8000`, {
      method: 'POST', signal: AbortSignal.timeout(8000), headers: {'xi-api-key': config.ttsApiKey, 'Content-Type': 'application/json'},
      body: JSON.stringify({text: said, model_id: config.ttsModel ?? 'eleven_flash_v2_5', ...(config.ttsSpeed !== undefined && {voice_settings: {speed: config.ttsSpeed}})})});
    if (!response.ok) throw Error(`opener render failed (HTTP ${response.status})`);
    const audio = Buffer.from(await response.arrayBuffer());
    const frames = [];
    for (let i = 0; i < audio.length; i += FRAME) frames.push(audio.subarray(i, i + FRAME).toString('base64'));
    return frames;
  })().catch(error => { cache.delete(key); throw error; }));
  return cache.get(key);
}
