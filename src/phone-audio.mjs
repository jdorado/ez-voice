import WebSocket from 'ws';
import {PHONE_TOOLS} from './phone-tools.mjs';

// A tool call's arguments arrive as a JSON string (ElevenLabs, GPT-Live) or an object (Gemini).
const parseArgs = value => { try { const args = typeof value === 'string' ? JSON.parse(value) : value; return args && typeof args === 'object' && !Array.isArray(args) ? args : {}; } catch { return {}; } };
import {createAdapter} from './phone-providers/index.mjs';
import {Transcript} from './phone-providers/transcript.mjs';
import {RING_CYCLE, audible} from './phone-providers/ringback.mjs';
import {PhoneAdvice} from './phone-advice.mjs';

// The greeting should sound within this of the session being ready; past it the line goes quiet rather than ring on.
const RING_AFTER_READY_MS = 5000;
const RING_LEAD_FRAMES = 15; // 300 ms of ring queued ahead at Twilio, so a late timer never leaves a gap
// After an early caller sound has been forwarded, how long the provider has to acknowledge it before the greeting is requested.
const STARTUP_SPEECH_ACK_MS = 250;

// A session opened before the call's media stream exists (outbound, while the phone rings) has no Twilio socket yet: it sends nothing
// until `adopt` hands it one.
const DETACHED = {readyState: WebSocket.CONNECTING, bufferedAmount: 0, send() {}, close() {}};

// Twilio carries raw mono G.711 mu-law at 8 kHz. This is the bridge between that stream and one speech provider: the
// timers, the tool registry, the receipt and the hang-up rules are here, and each provider's wire protocol lives in an
// adapter (src/phone-providers). The model owns the spoken conversation.
export class PhoneAudio {
  constructor(twilio, config, finish, {socketFactory = (url, options) => new WebSocket(url, options), onReady = () => {}, adapter, fetch: fetchImpl, ringAfterReadyMs = RING_AFTER_READY_MS} = {}) {
    this.twilio = twilio ?? DETACHED; this.finish = finish; this.config = config; this.onReady = onReady; this.socketFactory = socketFactory;
    this.ringAfterReadyMs = ringAfterReadyMs;
    this.adapter = adapter ?? createAdapter(config, fetchImpl && {fetch: fetchImpl});
    this.turn = 0; this.pendingTools = new Map(); this.seenTools = new Set();
    this.createdAt = this.startedAt = Date.now(); this.transcript = new Transcript(this.startedAt);
    this.stats = {provider: this.adapter.constructor.id, model: this.adapter.config.model, ...(this.adapter.config.ttsModel && {ttsModel: this.adapter.config.ttsModel}), inputBytes: 0, outputBytes: 0, inputTranscriptEvents: 0, finalized: false};
    if (config.ttsSpeed !== undefined) this.stats.ttsSpeed = config.ttsSpeed;
    if (config.greeting) this.stats.greetingFixed = true;
    if (config.advisor) this.advice = new PhoneAdvice({call: config.call, run: config.advisor.run, deadlineMs: config.advisor.deadlineMs, onReady: () => this.pushAdvice(),
      receipts: this.stats.advice = []});
    // Nobody speaking for `idleMs` ends the call (a mailbox that stays open after the message, a dead line). It arms only
    // once the provider has signalled that somebody spoke, so a session without such signals is never cut short by it.
    this.idleMs = (config.idleSeconds ?? 20) * 1000; this.activeAt = Date.now();
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    // An answered call rings on until the model's first words (`answerTone`, default ringback; `none` is a silent start).
    if (config.greet && (config.answerTone ?? 'ringback') === 'ringback') this.ring();
    this.queued = []; this.queuedBytes = 0;
    this.startTimer = setTimeout(() => this.close('provider_start_timeout'), 15000);
    if (twilio) this.duration = setTimeout(() => this.close('duration_limit'), (config.maxCallSeconds ?? 180) * 1000); // a pre-opened session's call has not begun
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
      if (typeof connection?.then === 'function') connection.then(value => { this.startup('connectionMs'); this.attach(value); }, error => {
        this.stats.providerError = Number.isInteger(error?.status) ? `HTTP_${error.status}` : 'connection_failed';
        this.close('provider_connection_failed');
      }); else this.attach(connection);
    } catch { this.close('provider_connection_failed'); }
  }
  attach({url, headers}) {
    if (this.closing || this.completed) return;
    this.provider = this.socketFactory(url, {headers, maxPayload: 1024 * 1024});
    this.provider.on('open', () => { this.startup('openMs'); for (const message of this.adapter.start()) this.send(message); });
    this.provider.on('message', (raw, binary) => {
      this.startup('firstEventMs');
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
  // Where the time to a ready session goes, in ms from the call's start: the provider request before its socket (connectionMs),
  // the socket open (openMs), its first message (firstEventMs); readyMs is the session accepting audio.
  startup(phase) { const startup = this.stats.startup ??= {}; startup[phase] ??= Date.now() - this.createdAt; }
  // The call's media stream has arrived for a session opened before it: from here it is the call. `readyMs` counts from now (0 when
  // the session was already ready), `preopenMs` is how long it was open before.
  adopt(twilio, {streamSid, call, finish}) {
    const now = Date.now();
    this.twilio = twilio; this.finish = finish; this.config.streamSid = streamSid; this.config.call = call;
    this.stats.preopenMs = now - this.startedAt;
    this.startedAt = this.activeAt = now; this.transcript = new Transcript(now);
    if (this.ready) this.stats.readyMs = 0;
    else { clearTimeout(this.startTimer); this.startTimer = setTimeout(() => this.close('provider_start_timeout'), 15000); } // the call's own start allowance
    clearTimeout(this.duration); this.duration = setTimeout(() => this.close('duration_limit'), (this.config.maxCallSeconds ?? 180) * 1000);
  }
  get usable() { return !this.closing && !this.completed; }
  send(message) {
    if (this.provider?.readyState !== WebSocket.OPEN) return false;
    if (this.provider.bufferedAmount > 256000) { this.close('provider_backpressure'); return false; }
    this.provider.send(Buffer.isBuffer(message) ? message : JSON.stringify(message)); return true;
  }
  input(payload) {
    if (this.closing) return;
    if (typeof payload !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length > 16000) return this.close('invalid_audio');
    this.stats.inputBytes += Buffer.from(payload, 'base64').length;
    const sound = audible(payload);
    if (sound) this.soundHeardAt = Date.now();
    // Twilio has already answered. Ringback is output only: dropping input here clips an
    // early hello and can turn its remaining syllable into an unrelated caller utterance.
    if (this.ready && !this.flushingInput) this.forward(payload);
    else {
      if (sound) this.startupSound = true;
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
        const greet = () => {
          if (this.closing || this.completed || !this.config.greet || this.conversationStarted) return;
          const messages = this.adapter.greet();
          if (messages.length) this.stats.greetingMs = Date.now() - this.startedAt;
          for (const message of messages) this.send(message);
        };
        // Preserve and forward an early hello first, then give the provider one short window to acknowledge it. Raw line energy
        // cannot tell speech from noise, so it never extends the wait: the provider owns turn-taking. Words the provider recognized
        // in the window (`conversationStarted`) suppress the greeting, and ElevenLabs also withholds it once a reply is in flight
        // (its `greet`); the other adapters send it as asked. Quiet starts wait nothing.
        if (this.startupSound) this.greetingTimer = setTimeout(greet, STARTUP_SPEECH_ACK_MS);
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
        this.stats.ready = true; this.stats.readyMs = Date.now() - this.startedAt; this.startup('readyMs');
        this.flushInput();
        if (this.ringing) this.ringCap = setTimeout(() => this.stopRing('timeout'), this.ringAfterReadyMs);
        this.onReady();
        break;
      case 'audio':
        if (typeof item.audio !== 'string' || item.audio.length > 1000000) return this.close('invalid_provider_audio');
        const sound = audible(item.audio), now = Date.now();
        if (sound) {this.conversationStarted = true; this.activeAt = now; this.stats.firstSpeechMs ??= now - this.startedAt;}
        // The provider's share of the reply gap: the caller's turn ending (as the provider says it) to the model's first sound.
        // The Twilio recording adds the network on both sides.
        if (sound && this.callerStoppedAt !== undefined) {
          const replies = this.stats.replyMs ??= [];
          if (replies.length < 64 && now - this.callerStoppedAt < 15000) replies.push(now - this.callerStoppedAt); // a later, unrelated sound is no reply
          this.callerStoppedAt = undefined;
        }
        const bytes = Buffer.from(item.audio, 'base64').length; this.stats.outputBytes += bytes;
        this.stats.firstAudioMs ??= now - this.startedAt;
        if (this.ringing) {
          if (!sound) break; // the silence some providers stream while the line still rings
          this.stopRing('speech');
        }
        // Twilio plays what it is sent in order at realtime speed (8 bytes a millisecond), so audio a provider sends faster than
        // that is still playing after it arrived: `playedUntil` is when Twilio's queue runs out, `soundUntil` when its last speech does.
        this.playedUntil = Math.max(this.playedUntil ?? 0, now) + bytes / 8;
        if (sound) this.soundUntil = this.playedUntil;
        // Where output audio only flows while the model speaks, its arrival is the model speaking (GPT-Live streams silence):
        // the idle hang-up must not fire while it is still being played.
        if (this.adapter.constructor.audioMeansSpeech) { this.activeAt = now; this.speakingUntil = this.playedUntil; }
        if (this.twilio.readyState === WebSocket.OPEN) {
          if (this.twilio.bufferedAmount > 256000) return this.close('twilio_backpressure');
          this.twilio.send(JSON.stringify({event: 'media', streamSid: this.config.streamSid, media: {payload: item.audio}}));
        }
        break;
      case 'speech':
        if (String(item.text ?? item.delta ?? '').trim()) this.conversationStarted = true;
        // Output audio flows nonstop on some providers, silence included, so only these signals say who is speaking.
        if (item.who === 'caller') {
          if (item.start) this.callerStoppedAt = undefined;
          else if (item.stop) {
            this.callerStoppedAt = Date.now();
            // the provider's share before the model can answer: the caller's last audible frame to the provider ending their turn
            if (this.soundHeardAt !== undefined && (this.stats.turnEndMs ??= []).length < 64) this.stats.turnEndMs.push(this.callerStoppedAt - this.soundHeardAt);
          }
          if (item.start) { this.cancelTools(true); this.turn++; }
          this.callerSpeaking = true; this.stats.inputTranscriptEvents++; this.stopRing('caller');
        } else this.callerSpeaking = false;
        this.activeAt = Date.now();
        if (this.advice) this.coach(item);
        this.transcript.add(item.who, item);
        break;
      case 'advice_ack': this.advice?.acknowledged(); break;
      case 'turn':
        if (item.request !== this.request) { this.cancelTools(true); this.turn++; this.request = item.request; this.stats.delegations = (this.stats.delegations ?? 0) + 1; }
        this.delegating = item.request; this.delegatingAt = Date.now();
        break;
      case 'settled': case 'cancelled':
        if (item.request === this.delegating) { this.delegating = null; this.wordsAt = Date.now(); if (this.advice) this.pushAdvice(); }
        if (item.type === 'settled') break;
        if (item.id || item.request) this.cancelTools(false, item.request, item.id);
        break;
      case 'interrupted':
        this.cancelTools(true); this.turn++;
        // The caller talked over the model: what Twilio has queued would play after they stopped.
        this.speakingUntil = this.playedUntil = this.soundUntil = 0;
        if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify({event: 'clear', streamSid: this.config.streamSid}));
        break;
      case 'tool': this.tool(item); break;
      case 'warning':
        if ((this.stats.providerWarnings ??= []).length < 8) this.stats.providerWarnings.push({code: item.code,
          ...(item.upstreamStatus && {upstreamStatus: item.upstreamStatus}), ...(item.category && {category: item.category}), ...(item.endpointHints && {endpointHints: item.endpointHints})});
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
    const tool = Object.hasOwn(PHONE_TOOLS, item.name) ? PHONE_TOOLS[item.name] : null;
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
    const timer = setTimeout(() => abort.abort(), this.config.information.deadlineMs); // the operator's toolBinding deadline
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
  // The side coach hears each finished caller utterance: whole from a provider that sends it so, otherwise once the
  // model starts to answer it.
  coach(item) {
    this.wordsAt = Date.now();
    if (item.who === 'caller') {
      if (item.text) this.advice.heard(item.text, this.transcript.receipt().transcript ?? []);
      else if (item.delta) this.callerOpen = true;
      return;
    }
    if (this.callerOpen) {
      this.callerOpen = false;
      const said = this.transcript.receipt().transcript ?? [], last = said.at(-1);
      if (last?.who === 'caller') this.advice.heard(last.text, said.slice(0, -1));
    }
    this.pushAdvice();
  }
  // A session-context provider takes a ready note only once the line has been quiet for adviceQuietMs, counted from the
  // last words and from the end of the model's audible audio at Twilio, with the caller's words answered, no delegated
  // work in flight (held at most adviceDelegationMs, so an event that never arrives cannot block notes for good) and the
  // call not ending. In real-provider runs an addition as the caller began garbled their words,
  // and one timed from the model's words alone (they run ahead of its audio) cut replies and goodbyes short.
  pushAdvice() {
    clearTimeout(this.adviceTimer);
    if (!this.adapter.adviceMessages || !this.advice.ready() || this.callerOpen || this.pendingTools.size
        || this.endingAt || this.closing || this.completed) return;
    const now = Date.now(), quiet = Math.max(this.wordsAt ?? 0, this.soundUntil ?? 0) + (this.config.adviceQuietMs ?? 1200) - now;
    const held = this.delegating ? this.delegatingAt + (this.config.adviceDelegationMs ?? 20000) - now : 0;
    if (Math.max(quiet, held) > 0) return void (this.adviceTimer = setTimeout(() => this.pushAdvice(), Math.max(quiet, held)));
    const note = this.advice.push(this.adapter.constructor.maxAdviceNote);
    if (note) for (const message of this.adapter.adviceMessages(note)) this.send(message);
  }
  // One language-model request relayed through the listener (src/phone-think.mjs): the line's thinking level is set on it and the latest coach note rides on it.
  think(body) {
    const thinking = this.config.thinking !== undefined && this.adapter.withThinking ? this.adapter.withThinking(body, this.config.thinking) : body;
    const note = this.advice?.note(), out = note ? this.adapter.withAdvice(thinking, note.text) : thinking;
    if (out !== thinking) this.advice.attached(note);
    return out;
  }
  endSoon() { this.endingAt ??= Date.now(); return {status: 'ending'}; }
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
    this.advice?.close(); clearTimeout(this.adviceTimer);
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
    this.advice?.close(); clearTimeout(this.adviceTimer);
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
