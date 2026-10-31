import WebSocket from 'ws';
import {PHONE_TOOLS} from './phone-tools.mjs';
import {MAX_LOOKUPS} from './phone-contexts.mjs';

// A tool call's arguments arrive as a JSON string (ElevenLabs, GPT-Live) or an object (Gemini).
const parseArgs = value => { try { const args = typeof value === 'string' ? JSON.parse(value) : value; return args && typeof args === 'object' && !Array.isArray(args) ? args : {}; } catch { return {}; } };
import {createAdapter} from './phone-providers/index.mjs';
import {Transcript} from './phone-providers/transcript.mjs';
import {RING_CYCLE, audible} from './phone-providers/ringback.mjs';

// The greeting should sound within this of the session being ready; past it the line goes quiet rather than ring on.
const RING_AFTER_READY_MS = 5000;
const RING_LEAD_FRAMES = 15; // 300 ms of ring queued ahead at Twilio, so a late timer never leaves a gap

// Twilio carries raw mono G.711 mu-law at 8 kHz. This is the bridge between that stream and one speech provider: the
// timers, the tool registry, the receipt and the hang-up rules are here, and each provider's wire protocol lives in an
// adapter (src/phone-providers). The model owns the spoken conversation.
export class PhoneAudio {
  constructor(twilio, config, finish, {socketFactory = (url, options) => new WebSocket(url, options), onReady = () => {}, adapter, fetch: fetchImpl, ringAfterReadyMs = RING_AFTER_READY_MS} = {}) {
    this.twilio = twilio; this.finish = finish; this.config = config; this.onReady = onReady; this.socketFactory = socketFactory;
    this.ringAfterReadyMs = ringAfterReadyMs;
    this.adapter = adapter ?? createAdapter(config, fetchImpl && {fetch: fetchImpl});
    this.turn = 0; this.pendingTools = new Map(); this.seenTools = new Set();
    this.startedAt = Date.now(); this.transcript = new Transcript(this.startedAt);
    this.stats = {provider: this.adapter.constructor.id, model: this.adapter.config.model, ...(this.adapter.config.ttsModel && {ttsModel: this.adapter.config.ttsModel}), inputBytes: 0, outputBytes: 0, inputTranscriptEvents: 0, finalized: false};
    // Nobody speaking for `idleMs` ends the call (a mailbox that stays open after the message, a dead line). It arms only
    // once the provider has signalled that somebody spoke, so a session without such signals is never cut short by it.
    this.idleMs = (config.idleSeconds ?? 20) * 1000; this.activeAt = Date.now();
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    // An answered call rings on until the model's first words (`answerTone`, default ringback; `none` is a silent start).
    if (config.greet && (config.answerTone ?? 'ringback') === 'ringback') this.ring();
    this.queued = []; this.queuedBytes = 0;
    this.startTimer = setTimeout(() => this.close('provider_start_timeout'), 15000);
    this.duration = setTimeout(() => this.close('duration_limit'), (config.maxCallSeconds ?? 180) * 1000);
    this.idle = setInterval(() => {
      const now = Date.now();
      if (this.endingAt) { // end_call was called: let the model finish any goodbye, then hang up once Twilio has played it
        if (this.drainingAt) { if (now - this.drainingAt > (config.endCallDrainMs ?? 15000)) this.close('end_call'); }
        // A managed final response has no correlated audio-completion ID. An earlier
        // utterance's AudioDone cannot end that wait; use the existing bounded window.
        else if (now - this.endingAt > (config.endCallMaxMs ?? 12000) || (!this.adapter.constructor.expectsFinalResponse && now - this.endingAt > (config.endCallGraceMs ?? 1500) && now - this.activeAt > (config.endCallQuietMs ?? 2000))) this.drain();
      } else if (!this.pendingTools.size && this.idleMs > 0 && (this.stats.inputTranscriptEvents || this.conversationStarted) && now - Math.max(this.activeAt, this.speakingUntil ?? 0) > this.idleMs) this.close('idle_timeout');
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
    this.provider.on('message', (raw, binary) => {
      try {
        this.event(binary && this.adapter.constructor.binaryAudio ? Buffer.from(raw) : JSON.parse(raw.toString()));
      } catch { this.close('invalid_provider_event'); }
    });
    this.provider.on('error', () => this.close('provider_connection_failed'));
    this.provider.on('unexpected-response', (_request, response) => {
      this.stats.providerError = Number.isInteger(response.statusCode) ? `HTTP_${response.statusCode}` : 'upgrade_failed';
      response.resume();
      this.close('provider_connection_failed');
    });
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
    this.provider.send(Buffer.isBuffer(message) ? message : JSON.stringify(message)); return true;
  }
  input(payload) {
    if (this.closing) return;
    if (typeof payload !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length > 16000) return this.close('invalid_audio');
    this.stats.inputBytes += Buffer.from(payload, 'base64').length;
    if (this.config.greet && !this.conversationStarted && audible(payload)) this.lastInputSoundAt = Date.now();
    // Twilio has already answered. Ringback is output only: dropping input here clips an
    // early hello and can turn its remaining syllable into an unrelated caller utterance.
    if (this.ready && !this.flushingInput) this.forward(payload);
    else {
      if (audible(payload)) this.startupSound = true;
      this.queuedBytes += payload.length;
      // Twilio streams the caller's line nonstop (about 10,700 base64 characters a second): hold what arrives until the provider is
      // ready, as long as the start timeout (15 s) allows; that timeout, not this, ends a call whose provider never comes up.
      if (this.queuedBytes > 200000) return this.close('startup_audio_limit');
      this.queued.push(payload);
    }
  }
  forward(payload) { for (const message of this.adapter.audioIn(payload)) this.send(message); }
  flushInput() {
    this.flushingInput = true;
    const pump = () => {
      if (this.closing || this.completed) return;
      // PCM providers expand G.711 frames. Yield between bounded batches so a delayed
      // startup cannot fill the WebSocket buffer and drop the whole call.
      for (let n = 0; n < 16 && this.queued.length && this.provider.bufferedAmount < 64000; n++) {
        const payload = this.queued.shift(); this.queuedBytes -= payload.length;
        this.forward(payload);
      }
      if (this.queued.length) this.inputFlush = setTimeout(pump, 5);
      else {
        this.flushingInput = false;
        // Earlier caller frames must reach the provider before this transport turn.
        const drainedAt = Date.now();
        const greet = () => {
          if (this.closing || this.completed || !this.config.greet || this.conversationStarted) return;
          // A timeout is not evidence that a caller stopped. Defer until a quiet gap;
          // a raw VAD event alone (cough/noise) does not permanently cancel the opener.
          // Without recognized words, energy alone cannot distinguish noise from
          // speech. After five seconds prefer a greeting to an indefinitely silent
          // answered call; normal provider barge-in still applies after it starts.
          if (Date.now() - (this.lastInputSoundAt ?? 0) < 500 && Date.now() - drainedAt < 5000) {
            this.greetingTimer = setTimeout(greet, 250); return;
          }
          for (const message of this.adapter.greet()) this.send(message);
        };
        // Sending audio is not an acknowledgement that server VAD processed it. Give
        // audible startup input a bounded detection window; background noise must not
        // leave an answered call silent forever. Quiet starts need no extra delay.
        if (this.startupSound) this.greetingTimer = setTimeout(greet, 1200);
        else greet();
      }
    };
    pump();
  }
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
        this.flushInput();
        if (this.ringing) this.ringCap = setTimeout(() => this.stopRing('timeout'), this.ringAfterReadyMs);
        this.onReady();
        break;
      case 'audio':
        if (typeof item.audio !== 'string' || item.audio.length > 1000000) return this.close('invalid_provider_audio');
        if (audible(item.audio)) {this.conversationStarted = true; this.activeAt = Date.now();}
        const bytes = Buffer.from(item.audio, 'base64').length; this.stats.outputBytes += bytes;
        this.stats.firstAudioMs ??= Date.now() - this.startedAt;
        if (this.ringing) {
          if (!audible(item.audio)) break; // the silence some providers stream while the line still rings
          this.stopRing('speech');
        }
        // Where output audio only flows while the model speaks, its arrival is the model speaking (GPT-Live streams silence).
        // Twilio plays what it is sent in order at realtime speed (8 bytes a millisecond), so a provider that sends speech faster than
        // that has the model speaking until the queue is empty: the idle hang-up must not fire while it is still being played.
        if (this.adapter.constructor.audioMeansSpeech) { const now = Date.now(); this.activeAt = now; this.speakingUntil = Math.max(this.speakingUntil ?? 0, now) + bytes / 8; }
        if (this.twilio.readyState === WebSocket.OPEN) {
          if (this.twilio.bufferedAmount > 256000) return this.close('twilio_backpressure');
          this.twilio.send(JSON.stringify({event: 'media', streamSid: this.config.streamSid, media: {payload: item.audio}}));
        }
        break;
      case 'speech':
        if (String(item.text ?? item.delta ?? '').trim()) this.conversationStarted = true;
        // Output audio flows nonstop on some providers, silence included, so only these signals say who is speaking.
        if (item.who === 'caller') {
          if (item.start) { this.cancelTools(true); this.turn++; }
          this.callerSpeaking = true; this.stats.inputTranscriptEvents++; this.stopRing('caller');
        } else this.callerSpeaking = false;
        this.activeAt = Date.now();
        this.transcript.add(item.who, item);
        break;
      case 'turn':
        if (item.request !== this.request) { this.cancelTools(true); this.turn++; this.request = item.request; }
        break;
      case 'cancelled':
        if (item.id || item.request) this.cancelTools(false, item.request, item.id);
        break;
      case 'interrupted':
        this.cancelTools(true); this.turn++;
        // The caller talked over the model: what Twilio has queued would play after they stopped.
        this.speakingUntil = 0;
        if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify({event: 'clear', streamSid: this.config.streamSid}));
        break;
      case 'tool': this.tool(item); break;
      case 'warning':
        if ((this.stats.providerWarnings ??= []).length < 8) this.stats.providerWarnings.push({code: item.code,
          ...(item.upstreamStatus && {upstreamStatus: item.upstreamStatus}), ...(item.category && {category: item.category})});
        break;
      case 'error':
        this.stats.providerError = item.code;
        this.close('provider_rejected');
        break;
      case 'fatal': this.close(item.reason); break;
    }
  }
  // A finished tool call from the model: run it here and hand its output back so the model can resume.
  tool(item) {
    if (this.config.tools === false || this.closing || this.completed || typeof item.id !== 'string'
        || !/^[A-Za-z0-9_-]{1,200}$/.test(item.id) || typeof item.name !== 'string'
        || this.seenTools.has(item.id) || this.seenTools.size >= 64) return;
    this.seenTools.add(item.id);
    if (item.request && this.request && item.request !== this.request) return;
    const tool = Object.hasOwn(PHONE_TOOLS, item.name) && (!PHONE_TOOLS[item.name].lookup || this.config.lookup) ? PHONE_TOOLS[item.name] : null;
    const external = !tool && this.config.information?.tools.some(t => t.name === item.name);
    (this.stats.tools ??= []).length < 64 && this.stats.tools.push(tool || external ? item.name : 'unknown');
    if (!external) {
      let output;
      try { output = tool ? tool.run(this, parseArgs(item.args)) : {error: 'unknown_tool'}; } catch { output = {error: 'tool_failed'}; }
      for (const message of this.adapter.toolResult(item.id, item.name, output, {final: Boolean(tool?.final)})) this.send(message);
      return;
    }
    // Each asynchronous request belongs to this bridge and this caller turn, never a shared result slot.
    const turn = this.turn, began = Date.now(), abort = new AbortController();
    this.callerSpeaking = false;
    abort.tool = item;
    this.pendingTools.set(item.id, abort);
    const timer = setTimeout(() => abort.abort(), 15000);
    Promise.resolve().then(() => this.config.information.run(this.config.call, turn, item.name, parseArgs(item.args), abort.signal))
      .catch(() => ({status: 'unavailable', error: 'information_unavailable'}))
      .then(output => {
        if (this.closing || this.completed || turn !== this.turn || !this.pendingTools.has(item.id)) return;
        if (abort.signal.aborted) output = {status: 'unavailable', error: 'information_timeout'};
        this.activeAt = Date.now();
        (this.stats.informationReads ??= []).push({name: item.name, turn, milliseconds: Date.now() - began,
          status: typeof output?.status === 'string' ? output.status.slice(0, 40) : 'returned'});
        for (const message of this.adapter.toolResult(item.id, item.name, output)) this.send(message);
      }).finally(() => { clearTimeout(timer); this.pendingTools.delete(item.id); });
  }
  cancelTools(notify = false, request, callId) {
    for (const [id, abort] of this.pendingTools) {
      if (callId && id !== callId) continue;
      if (request && abort.tool.request !== request) continue;
      abort.abort();
      this.pendingTools.delete(id);
      this.stats.cancelledTools = (this.stats.cancelledTools ?? 0) + 1;
      // Resolve the backend's pending function with cancellation, never its stale contents.
      // Otherwise a Responses backend can wait forever for the discarded function output.
      if (notify && !this.closing && !this.completed) for (const message of this.adapter.toolResult(
        abort.tool.id, abort.tool.name, {status: 'cancelled', error: 'caller_turn_changed'})) this.send(message);
    }

  }
  endSoon() { this.endingAt ??= Date.now(); return {status: 'ending'}; }
  // find_case: what the prepared contexts say to a stranger who names a property, a few tries a call (an address cannot be
  // guessed one after another).
  lookup(query) {
    if ((this.lookups = (this.lookups ?? 0) + 1) > MAX_LOOKUPS) return {error: 'too_many_lookups'};
    const claims = this.config.lookup(query);
    this.stats.lookups = this.lookups;
    return claims.length ? {found: true, matches: claims} : {found: false};
  }
  // Audio a provider sent faster than realtime is still queued at Twilio, and closing the stream drops it (a voicemail message
  // was cut after one sentence). A mark queued behind that audio comes back from Twilio once everything before it has played.
  drain() {
    this.drainingAt = Date.now();
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify({event: 'mark', streamSid: this.config.streamSid, mark: {name: 'end_call'}}));
    else this.close('end_call');
  }
  mark(name) { if (name === 'end_call' && this.drainingAt) this.close('end_call'); }
  // Paced by elapsed time and kept a little ahead: Twilio plays what it is sent in order, and a clear drops what is queued.
  ring() {
    const began = Date.now(); let sent = 0;
    const tick = () => {
      if (this.twilio.readyState !== WebSocket.OPEN || this.twilio.bufferedAmount > 64000) return;
      for (const due = Math.floor((Date.now() - began) / 20) + RING_LEAD_FRAMES; sent < due; sent++) {
        this.twilio.send(JSON.stringify({event: 'media', streamSid: this.config.streamSid, media: {payload: RING_CYCLE[sent % RING_CYCLE.length]}}));
      }
    };
    this.ringing = setInterval(tick, 100); tick();
  }
  // Why the ring stopped is kept: `speech` (the model's first audible words), `caller` (they spoke first), `timeout`
  // (nothing audible within RING_AFTER_READY_MS of the session being ready) or `close`.
  stopRing(reason) {
    if (!this.ringing) return;
    clearInterval(this.ringing); clearTimeout(this.ringCap); this.ringing = undefined;
    this.stats.ringMs = Date.now() - this.startedAt; this.stats.ringStop = reason;
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify({event: 'clear', streamSid: this.config.streamSid}));
  }
  close(reason = 'caller_hangup') {
    if (this.closing || this.completed) return this.done;
    this.stopRing('close');
    this.cancelTools();
    this.closing = true; this.stats.reason = reason;
    clearTimeout(this.inputFlush); clearTimeout(this.greetingTimer);
    clearTimeout(this.startTimer); clearTimeout(this.duration); clearInterval(this.idle); clearInterval(this.ringing);
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
    this.cancelTools();
    this.completed = true; clearTimeout(this.startTimer); clearTimeout(this.duration); clearInterval(this.idle); clearTimeout(this.closeTimer); clearInterval(this.ringing);
    clearTimeout(this.inputFlush); clearTimeout(this.greetingTimer);
    // A provider with no close handshake may still have reported usage along the way.
    if (this.stats.usage === undefined && this.adapter.usage !== undefined) this.stats.usage = this.adapter.usage;
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.close();
    Object.assign(this.stats, this.transcript.receipt()); // what was said, kept with the receipt
    Promise.resolve().then(() => this.finish(this.stats)).catch(() => {
      this.stats.receiptError = true;
      console.error('Phone call receipt could not be persisted');
    }).finally(() => this.resolveDone(this.stats));
    return this.done;
  }
}
