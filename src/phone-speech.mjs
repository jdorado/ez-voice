// Deepgram does not forward ElevenLabs voice_settings. This fixed-provider relay applies the operator's per-line speed to each
// TTS context and, when the line lists `pronunciations`, replaces those words in the text it speaks; the managed provider still
// owns speech and turns.
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
      if (speed !== undefined) message.voice_settings = {...message.voice_settings, speed};
      contexts.add(message.context_id);
    }
  }
  // ElevenLabs lets a closed context ID be initialized again.
  if (typeof message.close_context === 'string') contexts.delete(message.close_context);
  return JSON.stringify(message);
}

// The words a line says its own way: `{Quarre: 'Kwahr-ee'}`. A text frame has each listed word (whole word, any case) replaced by
// what to speak. The model writes the name in its ordinary spelling and the voice says it right; a word split between two frames
// of one context ('Qua' then 'rre') is held until the next frame, so it is still seen whole. What is held is released, in order,
// before a flush, a close or the end of the stream, and only a trailing fragment that could begin a listed word is ever held.
export class Pronouncer {
  constructor(words) {
    this.rules = Object.entries(words).map(([word, say]) => ({pattern: new RegExp(`\\b${word.replace(/[-']/g, '\\$&')}\\b`, 'gi'), say}));
    this.prefixes = new Set(Object.keys(words).flatMap(word => Array.from({length: word.length - 1}, (_, i) => word.slice(0, i + 1).toLowerCase())));
    this.held = new Map();
  }
  say(text) { return this.rules.reduce((out, {pattern, say}) => out.replace(pattern, () => say), text); }
  // One client frame in, the frames to forward out (none when it only added to the held fragment).
  apply(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return [raw]; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return [raw];
    const id = message.context_id ?? message.close_context, held = typeof id === 'string' ? this.held.get(id) ?? '' : '';
    if (typeof message.text !== 'string') { // a flush or a close: what was held goes first
      if (!held) return [raw];
      this.held.delete(id);
      return [JSON.stringify({context_id: id, text: this.say(held)}), raw];
    }
    const closing = message.flush === true || message.close_context !== undefined || message.text === '';
    let text = held + message.text;
    this.held.delete(id);
    const tail = closing ? undefined : /[A-Za-z'-]+$/.exec(text)?.[0];
    if (tail && this.prefixes.has(tail.toLowerCase())) { this.held.set(id, tail); text = text.slice(0, -tail.length); }
    if (!text && !closing) return [];
    return [JSON.stringify({...message, text: this.say(text)})];
  }
}

// ElevenLabs v4 speaks only on the Text-to-Dialogue socket. Deepgram speaks the TTS multi-context protocol to this relay; Dialogue
// turns each of its frames into the dialogue protocol (a context registers the line's voice on its first text, text goes as
// `inputs`, close_context is a boolean) and each dialogue reply back into the TTS shape Deepgram reads (`contextId`, `isFinal`,
// camel-case character timings).
// v4 takes stability only: speed and the other TTS settings are dropped.
export class Dialogue {
  constructor(voice) { this.voice = voice; this.open = new Set(); }
  // One TTS frame in: [frames to send upstream, frames to answer the client with directly].
  toUpstream(raw) {
    const m = JSON.parse(raw.toString());
    if (m.close_socket === true) return [[{close_socket: true}], []];
    const id = m.context_id ?? (typeof m.close_context === 'string' ? m.close_context : undefined);
    if (typeof id !== 'string') return [[], []];
    if (m.close_context !== undefined && m.close_context !== false) {
      if (!this.open.delete(id)) return [[], [{contextId: id, isFinal: true}]];
      return [[{context_id: id, close_context: true}], []];
    }
    const text = typeof m.text === 'string' && m.text.trim() ? m.text : undefined;
    const out = {context_id: id};
    if (text) {
      if (!this.open.has(id)) {
        this.open.add(id);
        Object.assign(out, {voices: [this.voice], ...(typeof m.voice_settings?.stability === 'number' && {voice_settings: {stability: m.voice_settings.stability}})});
      }
      out.inputs = [{text, voice_id: this.voice}];
    }
    if (m.flush === true && this.open.has(id)) out.flush = true;
    if (!out.inputs && !out.flush) return [[], []];
    return [[out], []];
  }
  toClient(raw) {
    const m = JSON.parse(raw.toString());
    // Deepgram tracks what was said from the character timings, so each chunk carries them in the TTS shape (the dialogue socket
    // sends them with sync_alignment=true, which the target always sets).
    const timing = a => a ? {chars: a.chars, charStartTimesMs: a.char_start_times_ms, charDurationsMs: a.char_durations_ms} : null;
    if (typeof m.audio === 'string') return {audio: m.audio, isFinal: null, normalizedAlignment: timing(m.normalized_alignment ?? m.alignment), alignment: timing(m.alignment), contextId: m.context_id};
    if (m.is_final === true) { this.open.delete(m.context_id); return {contextId: m.context_id, isFinal: true}; }
    if (m.error) throw Error('TTS dialogue error');
    return undefined; // is_final_audio_for_turn: the TTS protocol has no such message
  }
}

export function relaySpeech(client, bridge, {socketFactory = (url, options) => new WebSocket(url, options), finished = () => {}, query = new URLSearchParams()} = {}) {
  const contexts = new Set(), queued = [], pronouncer = bridge.config.pronunciations && new Pronouncer(bridge.config.pronunciations); let bytes = 0, stopped = false, upstream;
  const dialogue = bridge.adapter.constructor.dialogue?.(bridge.config.ttsModel) ? new Dialogue(bridge.config.voice) : undefined;
  bridge.stats.tts = {...(dialogue ? {model: bridge.config.ttsModel} : {speed: bridge.config.ttsSpeed}), contexts: 0, ...(pronouncer && {pronunciations: Object.keys(bridge.config.pronunciations).length})};
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
  const forward = raw => {
    const before = contexts.size, tts = speechMessage(raw, bridge.config.ttsSpeed, contexts), context = contexts.size > before;
    if (!dialogue) return send({message: tts, context});
    const [up, back] = dialogue.toUpstream(tts);
    for (const reply of back) client.send(JSON.stringify(reply));
    up.forEach((m, i) => send({message: JSON.stringify(m), context: context && i === 0}));
  };
  const send = item => {
    const {message} = item;
    if (upstream?.readyState === WebSocket.OPEN) {
      if (upstream.bufferedAmount + Buffer.byteLength(message) > MAX_BUFFER) throw Error('TTS backpressure');
      upstream.send(message);
      if (item.context) bridge.stats.tts.contexts++;
    } else {
      bytes += Buffer.byteLength(message);
      if (bytes > MAX_BUFFER) throw Error('TTS queue full');
      queued.push(item);
    }
  };
  client.on('message', (raw, binary) => {
    if (stopped) return;
    try {
      if (binary || raw.length > MAX_BUFFER) throw Error('Invalid TTS frame');
      for (const frame of pronouncer ? pronouncer.apply(raw) : [raw]) forward(frame);
    } catch (error) { fail(error); }
  });
  try {
    const target = bridge.adapter.speechTarget(query);
    bridge.stats.tts.streaming = Object.fromEntries(new URL(target.url).searchParams);
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
      try {
        if (!dialogue) return client.send(raw, {binary});
        const reply = dialogue.toClient(raw);
        if (reply) client.send(JSON.stringify(reply));
      } catch { fail(); }
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
