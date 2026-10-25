import WebSocket from 'ws';

// Twilio and GPT-Live both carry raw mono G.711 mu-law at 8 kHz.
// Voice relays bytes; the model owns the spoken conversation.
export class PhoneAudio {
  constructor(twilio, config, finish, {socketFactory = (url, options) => new WebSocket(url, options), onReady = () => {}} = {}) {
    this.twilio = twilio; this.finish = finish; this.config = config;
    this.stats = {inputBytes: 0, outputBytes: 0, finalized: false}; this.onReady = onReady;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.queued = []; this.queuedBytes = 0;
    this.provider = socketFactory('wss://api.openai.com/v1/live/sessions', {
      headers: {Authorization: `Bearer ${config.apiKey}`}, maxPayload: 1024 * 1024,
    });
    this.provider.on('open', () => this.send({type: 'session.start', session: {
      model: 'gpt-live-1', instructions: config.instructions,
      audio: {format: {type: 'audio/pcmu', rate: 8000}, output: {voice: 'marin'}},
      delegation: {type: 'client'}, store: false,
    }}));
    this.provider.on('message', raw => {
      try { this.event(JSON.parse(raw.toString())); } catch { this.close('invalid_provider_event'); }
    });
    this.provider.on('error', () => this.close('provider_connection_failed'));
    this.provider.on('close', () => this.complete());
    this.startTimer = setTimeout(() => this.close('provider_start_timeout'), 15000);
    this.duration = setTimeout(() => this.close('duration_limit'), 180000);
  }
  send(event) {
    if (this.provider.readyState !== WebSocket.OPEN) return false;
    if (this.provider.bufferedAmount > 256000) { this.close('provider_backpressure'); return false; }
    this.provider.send(JSON.stringify(event)); return true;
  }
  input(payload) {
    if (this.closing) return;
    if (typeof payload !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length > 16000) return this.close('invalid_audio');
    this.stats.inputBytes += Buffer.from(payload, 'base64').length;
    if (this.ready) this.send({type: 'session.input_audio.append', audio: payload});
    else {
      this.queuedBytes += payload.length;
      if (this.queuedBytes > 64000) return this.close('startup_audio_limit');
      this.queued.push(payload);
    }
  }
  event(event) {
    if (event.type === 'session.closed') {
      this.stats.finalized = true; this.stats.usage = event.usage;
      this.stats.reason ??= event.reason || 'provider_closed';
      this.provider.close(); this.complete(); return;
    }
    if (this.closing) return;
    if (event.type === 'session.started') {
      clearTimeout(this.startTimer); this.ready = true; this.stats.providerSessionId = event.session.id;
      this.stats.ready = true;
      for (const audio of this.queued) this.send({type: 'session.input_audio.append', audio});
      this.queued = []; this.queuedBytes = 0;
      this.onReady();
    } else if (event.type === 'session.output_audio.delta') {
      if (typeof event.delta !== 'string' || event.delta.length > 1000000) return this.close('invalid_provider_audio');
      this.stats.outputBytes += Buffer.from(event.delta, 'base64').length;
      if (this.twilio.readyState === WebSocket.OPEN) {
        if (this.twilio.bufferedAmount > 256000) return this.close('twilio_backpressure');
        this.twilio.send(JSON.stringify({event: 'media', streamSid: this.config.streamSid, media: {payload: event.delta}}));
      }
    } else if (event.type === 'session.delegation.created') {
      // Public phone callers have no owner identity, workspace or tool grants.
      const id = event.delegation?.id;
      if (typeof id === 'string') this.send({type: 'session.commentary.append', delegation_id: id,
        content: 'This is an audio-only phone call. No backend, tools, private information or actions are connected.'});
    } else if (event.type === 'error') {
      this.stats.providerError = typeof event.error?.code === 'string' ? event.error.code.slice(0,100) : 'provider_error';
      this.close('provider_rejected');
    }
  }
  close(reason = 'caller_hangup') {
    if (this.closing || this.completed) return this.done;
    this.closing = true; this.stats.reason = reason;
    clearTimeout(this.startTimer); clearTimeout(this.duration);
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.close();
    if (this.provider.readyState === WebSocket.OPEN) {
      this.closeTimer = setTimeout(() => { this.provider.terminate(); this.complete(); }, 15000);
      this.provider.send(JSON.stringify({type: 'session.close'}));
    } else { this.provider.terminate(); this.complete(); }
    return this.done;
  }
  complete() {
    if (this.completed) return this.done;
    this.completed = true; clearTimeout(this.startTimer); clearTimeout(this.duration); clearTimeout(this.closeTimer);
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.close();
    Promise.resolve().then(() => this.finish(this.stats)).catch(() => {
      this.stats.receiptError = true;
      console.error('Phone call receipt could not be persisted');
    }).finally(() => this.resolveDone(this.stats));
    return this.done;
  }
}
