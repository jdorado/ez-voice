import WebSocket from 'ws';
import {PHONE_TOOLS} from './phone-tools.mjs';
import {createAdapter} from './phone-providers/index.mjs';

// Twilio carries raw mono G.711 mu-law at 8 kHz. This is the bridge between that stream and one speech provider: the
// timers, the tool registry, the receipt and the hang-up rules are here, and each provider's wire protocol lives in an
// adapter (src/phone-providers). The model owns the spoken conversation.
export class PhoneAudio {
  constructor(twilio, config, finish, {socketFactory = (url, options) => new WebSocket(url, options), onReady = () => {}, adapter, fetch: fetchImpl} = {}) {
    this.twilio = twilio; this.finish = finish; this.config = config; this.onReady = onReady; this.socketFactory = socketFactory;
    this.adapter = adapter ?? createAdapter(config, fetchImpl && {fetch: fetchImpl});
    this.startedAt = Date.now();
    this.stats = {provider: this.adapter.constructor.id, model: this.adapter.config.model, inputBytes: 0, outputBytes: 0, inputTranscriptEvents: 0, finalized: false};
    // Nobody speaking for `idleMs` ends the call (a mailbox that stays open after the message, a dead line). It arms only
    // once the provider has signalled that somebody spoke, so a session without such signals is never cut short by it.
    this.idleMs = (config.idleSeconds ?? 20) * 1000; this.activeAt = Date.now();
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.queued = []; this.queuedBytes = 0;
    this.startTimer = setTimeout(() => this.close('provider_start_timeout'), 15000);
    this.duration = setTimeout(() => this.close('duration_limit'), (config.maxCallSeconds ?? 180) * 1000);
    this.idle = setInterval(() => {
      const now = Date.now();
      if (this.endingAt) { // end_call was called: let the model finish any goodbye, then hang up
        if (now - this.endingAt > (config.endCallMaxMs ?? 12000) || (now - this.endingAt > (config.endCallGraceMs ?? 1500) && now - this.activeAt > (config.endCallQuietMs ?? 2000))) this.close('end_call');
      } else if (this.idleMs > 0 && this.stats.inputTranscriptEvents && now - this.activeAt > this.idleMs) this.close('idle_timeout');
    }, Math.min(1000, this.idleMs > 0 ? this.idleMs / 4 : 1000, (config.endCallQuietMs ?? 2000) / 2));
    // Some providers need a request before the socket (ElevenLabs mints a client secret); the rest connect at once.
    try {
      const connection = this.adapter.connection();
      if (typeof connection?.then === 'function') connection.then(value => this.attach(value), error => {
        this.stats.providerError = Number.isInteger(error?.status) ? `HTTP_${error.status}` : 'connection_failed';
        this.close('provider_connection_failed');
      }); else this.attach(connection);
    } catch { this.close('provider_connection_failed'); }
  }
  attach({url, headers}) {
    if (this.closing || this.completed) return;
    this.provider = this.socketFactory(url, {headers, maxPayload: 1024 * 1024});
    this.provider.on('open', () => { for (const message of this.adapter.start()) this.send(message); });
    this.provider.on('message', raw => {
      try { this.event(JSON.parse(raw.toString())); } catch { this.close('invalid_provider_event'); }
    });
    this.provider.on('error', () => this.close('provider_connection_failed'));
    this.provider.on('close', code => {
      // A provider that ends the session by closing the socket says why in the close code only (never keep its text).
      if (!this.closing && !this.completed) {
        this.stats.reason ??= 'provider_closed';
        if (Number.isInteger(code) && ![1000, 1005].includes(code)) this.stats.providerError ??= `WS_${code}`;
      }
      this.complete();
    });
  }
  send(message) {
    if (this.provider?.readyState !== WebSocket.OPEN) return false;
    if (this.provider.bufferedAmount > 256000) { this.close('provider_backpressure'); return false; }
    this.provider.send(JSON.stringify(message)); return true;
  }
  input(payload) {
    if (this.closing) return;
    if (typeof payload !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length > 16000) return this.close('invalid_audio');
    this.stats.inputBytes += Buffer.from(payload, 'base64').length;
    if (this.ready) this.forward(payload);
    else {
      this.queuedBytes += payload.length;
      if (this.queuedBytes > 64000) return this.close('startup_audio_limit');
      this.queued.push(payload);
    }
  }
  forward(payload) { for (const message of this.adapter.audioIn(payload)) this.send(message); }
  event(event) { for (const item of this.adapter.parse(event)) this.handle(item); }
  handle(item) {
    if (item.type === 'closed') {
      this.stats.finalized = true; this.stats.usage = item.usage;
      this.stats.reason ??= item.reason || 'provider_closed';
      this.provider.close(); this.complete(); return;
    }
    if (this.closing) return;
    switch (item.type) {
      case 'send': this.send(item.message); break;
      case 'ready':
        clearTimeout(this.startTimer); this.ready = true; this.stats.providerSessionId = item.id;
        this.stats.ready = true; this.stats.readyMs = Date.now() - this.startedAt;
        for (const payload of this.queued) this.forward(payload);
        this.queued = []; this.queuedBytes = 0;
        this.onReady();
        break;
      case 'audio':
        if (typeof item.audio !== 'string' || item.audio.length > 1000000) return this.close('invalid_provider_audio');
        this.stats.outputBytes += Buffer.from(item.audio, 'base64').length;
        this.stats.firstAudioMs ??= Date.now() - this.startedAt;
        if (this.twilio.readyState === WebSocket.OPEN) {
          if (this.twilio.bufferedAmount > 256000) return this.close('twilio_backpressure');
          this.twilio.send(JSON.stringify({event: 'media', streamSid: this.config.streamSid, media: {payload: item.audio}}));
        }
        break;
      case 'speech':
        // Output audio flows nonstop on some providers, silence included, so only these signals say who is speaking.
        if (item.who === 'caller') this.stats.inputTranscriptEvents++;
        this.activeAt = Date.now();
        break;
      case 'interrupted':
        // The caller talked over the model: what Twilio has queued would play after they stopped.
        if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify({event: 'clear', streamSid: this.config.streamSid}));
        break;
      case 'tool': this.tool(item); break;
      case 'error':
        this.stats.providerError = item.code;
        this.close('provider_rejected');
        break;
      case 'fatal': this.close(item.reason); break;
    }
  }
  // A finished tool call from the model: run it here and hand its output back so the model can resume.
  tool(item) {
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(item.id) || typeof item.name !== 'string') return;
    const tool = Object.hasOwn(PHONE_TOOLS, item.name) ? PHONE_TOOLS[item.name] : null;
    let output;
    try { output = tool ? tool.run(this) : {error: 'unknown_tool'}; } catch { output = {error: 'tool_failed'}; }
    (this.stats.tools ??= []).length < 20 && this.stats.tools.push(tool ? item.name : 'unknown');
    for (const message of this.adapter.toolResult(item.id, item.name, output, {final: Boolean(tool?.final)})) this.send(message);
  }
  endSoon() { this.endingAt ??= Date.now(); return {status: 'ending'}; }
  close(reason = 'caller_hangup') {
    if (this.closing || this.completed) return this.done;
    this.closing = true; this.stats.reason = reason;
    clearTimeout(this.startTimer); clearTimeout(this.duration); clearInterval(this.idle);
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.close();
    if (this.provider?.readyState === WebSocket.OPEN) {
      const messages = this.adapter.closeMessages();
      // A provider with a close handshake gets time to confirm and report usage; the others end with the socket.
      this.closeTimer = setTimeout(() => { this.provider.terminate(); this.complete(); }, messages.length ? 15000 : 2000);
      if (messages.length) for (const message of messages) this.provider.send(JSON.stringify(message)); else this.provider.close();
    } else { this.provider?.terminate(); this.complete(); }
    return this.done;
  }
  complete() {
    if (this.completed) return this.done;
    this.completed = true; clearTimeout(this.startTimer); clearTimeout(this.duration); clearInterval(this.idle); clearTimeout(this.closeTimer);
    // A provider with no close handshake may still have reported usage along the way.
    if (this.stats.usage === undefined && this.adapter.usage !== undefined) this.stats.usage = this.adapter.usage;
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.close();
    Promise.resolve().then(() => this.finish(this.stats)).catch(() => {
      this.stats.receiptError = true;
      console.error('Phone call receipt could not be persisted');
    }).finally(() => this.resolveDone(this.stats));
    return this.done;
  }
}
