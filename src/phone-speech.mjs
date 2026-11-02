// Deepgram does not forward ElevenLabs voice_settings. This fixed-provider relay applies the
// operator's per-line speed to each TTS context; the managed provider still owns speech and turns.
import WebSocket from 'ws';

const MAX_BUFFER = 256000;

export function speechMessage(raw, speed, contexts) {
  const message = JSON.parse(raw.toString());
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('Invalid TTS message');
  // Authentication is the operator's upstream header, never a provider-supplied body field.
  delete message.xi_api_key;
  if (message.voice_settings !== undefined && (!message.voice_settings || typeof message.voice_settings !== 'object' || Array.isArray(message.voice_settings))) throw Error('Invalid voice settings');
  if (typeof message.text === 'string') {
    if (typeof message.context_id !== 'string' || !message.context_id || message.context_id.length > 200) throw Error('Invalid TTS context');
    if (!contexts.has(message.context_id) || message.voice_settings !== undefined) {
      if (contexts.size >= 256 && !contexts.has(message.context_id)) throw Error('Too many TTS contexts');
      message.voice_settings = {...message.voice_settings, speed};
      contexts.add(message.context_id);
    }
  }
  // ElevenLabs lets a closed context ID be initialized again.
  if (typeof message.close_context === 'string') contexts.delete(message.close_context);
  return JSON.stringify(message);
}

export function relaySpeech(client, bridge, {socketFactory = (url, options) => new WebSocket(url, options), finished = () => {}} = {}) {
  const contexts = new Set(), queued = []; let bytes = 0, stopped = false, upstream;
  bridge.stats.tts = {speed: bridge.config.ttsSpeed, contexts: 0};
  const close = () => {
    if (stopped) return;
    stopped = true; queued.length = 0; clearTimeout(timeout);
    client.terminate(); upstream?.terminate(); finished();
  };
  const fail = reason => {
    if (stopped) return;
    const reasons = {
      'Invalid TTS message': 'invalid_message', 'Invalid voice settings': 'invalid_settings',
      'Invalid TTS context': 'invalid_context', 'Too many TTS contexts': 'context_limit',
      'Invalid TTS frame': 'invalid_frame', 'TTS backpressure': 'backpressure', 'TTS queue full': 'queue_full',
    };
    bridge.stats.tts.error = reasons[reason?.message] ?? 'connection_failed';
    bridge.stats.providerError ??= 'TTS_CONNECTION_FAILED';
    close(); bridge.close('tts_connection_failed');
  };
  const timeout = setTimeout(fail, 10000);
  client.on('error', fail); client.on('close', close);
  client.on('message', (raw, binary) => {
    if (stopped) return;
    try {
      if (binary || raw.length > MAX_BUFFER) throw Error('Invalid TTS frame');
      const before = contexts.size, message = speechMessage(raw, bridge.config.ttsSpeed, contexts);
      const item = {message, context: contexts.size > before};
      if (upstream?.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount + Buffer.byteLength(message) > MAX_BUFFER) throw Error('TTS backpressure');
        upstream.send(message);
        if (item.context) bridge.stats.tts.contexts++;
      } else {
        bytes += Buffer.byteLength(message);
        if (bytes > MAX_BUFFER) throw Error('TTS queue full');
        queued.push(item);
      }
    } catch (error) { fail(error); }
  });
  try {
    const target = bridge.adapter.speechTarget();
    upstream = socketFactory(target.url, {headers: target.headers, maxPayload: 1024 * 1024, handshakeTimeout: 10000});
    upstream.on('open', () => {
      if (stopped) return upstream.terminate();
      clearTimeout(timeout);
      try {
        for (const item of queued) { upstream.send(item.message); if (item.context) bridge.stats.tts.contexts++; }
        queued.length = 0; bytes = 0;
      } catch { fail(); }
    });
    upstream.on('message', (raw, binary) => {
      if (stopped) return;
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > MAX_BUFFER) return fail();
      try { client.send(raw, {binary}); } catch { fail(); }
    });
    upstream.on('error', fail);
    upstream.on('unexpected-response', (_request, response) => { response.resume(); fail(); });
    upstream.on('close', code => {
      if (stopped) return;
      if (![1000, 1005].includes(code)) return fail();
      close();
    });
  } catch { fail(); }
  return {close};
}
