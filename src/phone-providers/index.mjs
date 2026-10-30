import {OpenAIAdapter} from './openai.mjs';
import {ElevenLabsAdapter} from './elevenlabs.mjs';
import {GeminiAdapter} from './gemini.mjs';

// A phone provider is one speech-to-speech (or cascaded speech) service behind a WebSocket. PhoneAudio owns the Twilio bridge,
// the timers, the tool registry and the receipt; an adapter owns one provider's wire protocol and nothing else. Each call gets a
// fresh adapter (they hold stream state). The adapter has static `id`, `label`, `models`, `defaultModel`, `defaultVoice`,
// `keyPattern`, `confirmsClose` (true when the provider reports a final session.closed with usage), `audioMeansSpeech` (true when
// its output audio only flows while the model speaks) and `supportsTools(model)`;
// its constructor keeps the validated `config` (model and voice resolved) as `this.config`; and:
//   connection()                 -> {url, headers}, or a promise of it (ElevenLabs mints a client secret first)
//   start()                      -> messages sent as soon as the socket opens
//   greet()                      -> messages that ask the model to speak first on an answered call ([] when unsupported)
//   audioIn(base64 mu-law 8 kHz) -> messages carrying one chunk of the caller's audio
//   parse(providerEvent)         -> normalized items:
//     {type: 'ready', id}        the session accepts audio
//     {type: 'audio', audio}     base64 mu-law 8 kHz for the caller (whole 20 ms frames are best)
//     {type: 'speech', who, delta?, text?, start?}   'caller' or 'model' is speaking (idle hang-up uses it); `delta`
//                                continues the speaker's words, `text` is a whole utterance, `start` marks the caller
//                                beginning to speak (the receipt's transcript)
//     {type: 'interrupted'}      the caller barged in: drop audio queued at Twilio
//     {type: 'tool', id, name, args}   the model called a registered tool
//     {type: 'send', message}    a message to send back now
//     {type: 'closed', usage}    the provider confirmed the end of the session
//     {type: 'error', code} / {type: 'fatal', reason}   a provider error / end the call
//   toolResult(id, name, output, {final}) -> messages that hand a tool's output back (`final`: the call ends, no follow-up needed)
//   closeMessages()              -> messages that ask the provider to finish ([] when the socket close is the end)
export const PROVIDERS = {
  [OpenAIAdapter.id]: OpenAIAdapter,
  [ElevenLabsAdapter.id]: ElevenLabsAdapter,
  [GeminiAdapter.id]: GeminiAdapter,
};
export const DEFAULT_PROVIDER = OpenAIAdapter.id;

export function providerClass(config) {
  const Adapter = PROVIDERS[config.provider ?? DEFAULT_PROVIDER];
  if (!Adapter) throw Error(`provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
  return Adapter;
}
export function createAdapter(config, options) {
  const Adapter = providerClass(config);
  return new Adapter({...config, provider: Adapter.id, model: config.model ?? Adapter.defaultModel, voice: config.voice ?? Adapter.defaultVoice}, options);
}
