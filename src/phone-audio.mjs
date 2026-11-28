import WebSocket from 'ws';
import {PHONE_TOOLS, TRANSFER_TOOL, MAX_WHISPER} from './phone-tools.mjs';

// A tool call's arguments arrive as a JSON string (ElevenLabs, GPT-Live) or an object (Gemini).
const parseArgs = value => { try { const args = typeof value === 'string' ? JSON.parse(value) : value; return args && typeof args === 'object' && !Array.isArray(args) ? args : {}; } catch { return {}; } };
import {createAdapter} from './phone-providers/index.mjs';
import {Transcript} from './phone-providers/transcript.mjs';
import {RING_CYCLE, audible, level} from './phone-providers/ringback.mjs';
import {PhoneAdvice} from './phone-advice.mjs';
import {renderOpener} from './phone-opener.mjs';
import {Ambience} from './phone-ambience.mjs';
import {latestCallerText, mailboxGreeting, realtimeCatch} from './phone-voicemail.mjs';
import {ListenTap, tapped} from './phone-listen.mjs';
import {FluxSidecar} from './phone-sidecar.mjs';
import {ToolTokenGate, TagStripper, AiGuard} from './phone-guards.mjs';

// The greeting should sound within this of the session being ready; past it the line goes quiet rather than ring on.
const RING_AFTER_READY_MS = 5000;
const RING_LEAD_FRAMES = 15; // 300 ms of ring queued ahead at Twilio, so a late timer never leaves a gap
// After an early caller sound has been forwarded, how long the provider has to acknowledge it before the greeting is requested.
const STARTUP_SPEECH_ACK_MS = 250;
// The longest an answered call waits for a greeting that an adapter keeps declining because the caller's speech is still open: a turn
// that never closes (a speech-like background) must not leave the line silent. A reply already in flight is never overridden.
const GREETING_BOUND_MS = 5000;
// A placed call waits for the callee's hello. One answered in silence (a screener, a cautious owner, a silent mailbox) would stay
// silent on both ends until a hang-up: after this long with no caller speech the model speaks first.
const SILENT_ANSWER_MS = 3000;
// Turn-taking the bridge owns for a provider that leaves it to it (`bridgeTurns`). The model is cut off only by caller sound loud enough to
// be a person talking (RMS about -33 dBFS) for BARGE_MS: a callee's handset echoed the model's own voice back at -39 to -45 dBFS, and a
// click or a breath lasts a frame or two (live calls, 2026-11-16). ECHO_TAIL_MS after the model's last audio its echo can still arrive.
// The end of the caller's turn stays the provider's: closing short turns from here (input_audio_buffer.commit after a quiet gap) was
// tried and dropped, because the provider then sometimes committed the same turn again and the model answered it twice (lab calls,
// 2026-11-17).
const BARGE_RMS = 700, BARGE_MS = 300, ECHO_TAIL_MS = 600;

const TRACED = new Set(['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.committed', 'input_audio_buffer.commit',
  'response.created', 'response.done', 'response.cancel', 'response.create', 'response.output_audio.delta', 'output_audio_buffer.cleared',
  'conversation.item.truncate', 'conversation.item.truncated', 'error']);
// A placed call's fixed opener follows the callee's hello or the silence timeout. Lines that screen for voicemail
// use the opening transcript. Other lines listen for OPENER_HELLO_MS at BARGE_RMS followed by OPENER_QUIET_MS
// of quiet to distinguish a hello from pickup noise. The provider hears silence during the opener and its echo.
const OPENER_HELLO_MS = 250, OPENER_QUIET_MS = 400, OPENER_ECHO_MS = 300;
const VOICEMAIL_SILENT_ANSWER_MS = 5000; // the lab's carrier mailbox began its greeting 3.4 s after connecting
const OPENER_MAX_WAIT_MS = 12000;
// A live transfer (src/phone-transfer.mjs): the immediate answer to transfer_call, and the longest the model's handover sentence may
// take, from the colleague confirming, before the caller is moved to the conference anyway. A note the provider refuses because
// somebody is speaking is sent again every NOTE_RETRY_MS, at most NOTE_TRIES times.
export const TRANSFER_RINGING = 'Ringing your colleague now. Keep the caller company; do not say goodbye.';
const HANDOVER_MAX_MS = 10000, NOTE_RETRY_MS = 500, NOTE_TRIES = 20;
// An advice end (src/phone-advice.mjs) waits for the model's next reply to play, this long at most.
const ADVICE_END_BACKSTOP_MS = 25000;
const EARLY_NOTE_WORDS = 4; // a caller turn's provisional words go to the side coach once, at this many
const silenceLike = payload => Buffer.alloc(Buffer.from(payload, 'base64').length, 0xff).toString('base64'); // mu-law silence, same length

// A session opened before the call's media stream exists (outbound, while the phone rings) has no Twilio socket yet: it sends nothing
// until `adopt` hands it one.
const DETACHED = {readyState: WebSocket.CONNECTING, bufferedAmount: 0, send() {}, close() {}};

// Twilio carries raw mono G.711 mu-law at 8 kHz. This is the bridge between that stream and one speech provider: the
// timers, the tool registry, the receipt and the hang-up rules are here, and each provider's wire protocol lives in an
// adapter (src/phone-providers). The model owns the spoken conversation.
export class PhoneAudio {
  constructor(twilio, config, finish, {socketFactory = (url, options) => new WebSocket(url, options), onReady = () => {}, adapter, fetch: fetchImpl, ringAfterReadyMs = RING_AFTER_READY_MS, silentAnswerMs = SILENT_ANSWER_MS} = {}) {
    this.listenTap = new ListenTap(); this.twilio = twilio ? tapped(twilio, this.listenTap) : DETACHED; this.finish = finish; this.config = config; this.onReady = onReady; this.socketFactory = socketFactory;
    this.ringAfterReadyMs = ringAfterReadyMs; this.silentAnswerMs = silentAnswerMs;
    this.adapter = adapter ?? createAdapter(config, fetchImpl && {fetch: fetchImpl});
    this.turn = 0; this.pendingTools = new Map(); this.seenTools = new Set();
    this.createdAt = this.startedAt = Date.now(); this.transcript = new Transcript(this.startedAt);
    this.stats = {provider: this.adapter.constructor.id, model: this.adapter.config.model, ...(this.adapter.config.ttsModel && {ttsModel: this.adapter.config.ttsModel}), inputBytes: 0, outputBytes: 0, inputTranscriptEvents: 0, finalized: false};
    // Deepgram screens before its first model request; a speech-to-speech line answers on its own, so it screens the callee's
    // first transcribed turn and ends the call on a mailbox greeting (its reply, if begun, is dropped with the stream).
    const screen = config.skipVoicemail && config.call?.direction === 'out';
    this.screenVoicemail = screen && this.adapter.constructor.id === 'deepgram';
    this.screenFirstTurn = screen && !this.screenVoicemail;
    if (this.screenVoicemail) this.stats.modelRequests = 0;
    if (config.ttsSpeed !== undefined) this.stats.ttsSpeed = config.ttsSpeed;
    if (config.greeting) this.stats.greetingFixed = true;
    // A quiet office under the voice and in its pauses (`ambienceDb`, phone-ambience.mjs): the queue at Twilio is kept about 60 ms
    // ahead with room tone whenever the persona is silent, and the tone runs on under what it says.
    if (config.ambienceDb !== undefined) { this.ambience = new Ambience(config.ambienceDb); this.ambienceTick = setInterval(() => this.fillAmbience(), 20); }
    if (config.opener && config.call?.direction === 'out') { // a placed call's first line only: an answered call keeps its own greeting
      this.opener = {state: 'waiting', heardMs: 0}; this.stats.openerFixed = true;
      this.openerClip = renderOpener(config, config.opener, fetchImpl); this.openerClip.catch(() => {});
      if (twilio) this.armOpener();
    }
    // Turn-taking: the bridge's (see BARGE_RMS) where the provider leaves it to it, unless the line keeps the provider's own (`turnDetection: 'server'`).
    this.bridgeTurns = Boolean(this.adapter.constructor.bridgeTurns) && config.turnDetection !== 'server';
    this.serverTurns = Boolean(this.adapter.constructor.bridgeTurns) && config.turnDetection === 'server';
    const adviceNow = Boolean(this.adapter.constructor.adviceNow);
    if (config.advisor) this.advice = new PhoneAdvice({call: config.call, run: config.advisor.run, deadlineMs: config.advisor.deadlineMs, onReady: () => this.pushAdvice(),
      receipts: this.stats.advice = [], ...(adviceNow && {full: true, onEnd: (end, since) => this.adviceEnd(end, since)})});
    // Guards on the model's words (src/phone-guards.mjs) and the machine screen of a placed call's first two utterances.
    if (config.toolGuard) { this.toolGate = new ToolTokenGate(); this.tagStripper = new TagStripper(); }
    if (config.aiGuard) this.aiGuard = new AiGuard(config.aiGuard);
    this.catchMachines = Boolean(config.voicemailCatch) && config.call?.direction === 'out'; this.callerUtterances = 0;
    if (twilio) this.startSidecar();
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
        if (this.drainingAt) { if (now - this.drainingAt > (config.endCallDrainMs ?? 15000)) this.close(this.drainReason ?? 'end_call'); }
        // A managed final response has no correlated audio-completion ID. An earlier
        // utterance's AudioDone cannot end that wait; use the existing bounded window.
        else if (now - this.endingAt > (config.endCallMaxMs ?? 12000) || (!this.adapter.constructor.expectsFinalResponse && now - this.endingAt > (config.endCallGraceMs ?? 1500) && now - this.activeAt > (config.endCallQuietMs ?? 2000))) this.drain();
      } else if (!this.pendingTools.size && !this.transfer && this.idleMs > 0 && (this.stats.inputTranscriptEvents || this.conversationStarted) && now - Math.max(this.activeAt, this.speakingUntil ?? 0) > this.idleMs) this.close('idle_timeout');
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
    this.twilio = tapped(twilio, this.listenTap); this.finish = finish; this.config.streamSid = streamSid; this.config.call = call;
    this.stats.preopenMs = now - this.startedAt;
    this.startedAt = this.activeAt = now; this.transcript = new Transcript(now);
    if (this.ready) this.stats.readyMs = 0;
    else { clearTimeout(this.startTimer); this.startTimer = setTimeout(() => this.close('provider_start_timeout'), 15000); } // the call's own start allowance
    clearTimeout(this.duration); this.duration = setTimeout(() => this.close('duration_limit'), (this.config.maxCallSeconds ?? 180) * 1000);
    this.armSilentAnswer();
    if (this.opener) this.armOpener();
    if (this.advice) this.advice.call = call;
    this.startSidecar();
  }
  // The Flux listener beside the session (src/phone-sidecar.mjs): from the call's media stream on.
  startSidecar() {
    if (!this.config.sidecar || this.sidecar) return;
    this.sidecar = new FluxSidecar({apiKey: this.config.sidecarApiKey, model: this.config.sidecar, socketFactory: this.socketFactory,
      onText: text => this.sidecarText(text), stats: this.stats.sidecar = {}});
  }
  // The sidecar's words of the caller's current turn: the machine screen, then the side coach's early note (provisional words only).
  sidecarText({kind, text}) {
    if (!this.usable) return;
    this.sidecarSaid = text;
    if (this.catchMachine(text)) return;
    if (this.advice && this.config.adviceEarly && kind !== 'final' && !this.earlyAsked && text.split(/\s+/).filter(Boolean).length >= EARLY_NOTE_WORDS) {
      this.earlyAsked = true;
      this.advice.heard(text, this.transcript.receipt().transcript ?? [], {partial: true});
    }
  }
  // A machine in the callee's first two utterances ends a placed call at once, nothing said (`voicemailCatch`): the sidecar's words where
  // the line has one, otherwise the provider's transcript of each utterance.
  catchMachine(text) {
    if (!this.catchMachines || !String(text ?? '').trim()) return false;
    const kind = realtimeCatch(text, Math.max(0, this.callerUtterances - 1));
    if (!kind) return false;
    this.catchMachines = false;
    this.transcript.add('caller', {text});
    Object.assign(this.stats, {voicemailMs: Date.now() - this.startedAt, machine: kind});
    this.close(kind === 'screener' ? 'screener' : 'voicemail');
    return true;
  }
  // A placed call, answered and ready, in which nobody has spoken after `silentAnswerMs` is greeted (`silentAnswer` in the receipt).
  armSilentAnswer() {
    if (this.config.greet || this.opener || this.config.call?.direction !== 'out' || !this.ready || this.twilio === DETACHED || this.silentAnswer) return;
    const armedAt = Date.now();
    const quietMs = this.screenVoicemail ? this.voicemailQuietMs : 800;
    const maxWaitMs = this.screenVoicemail ? OPENER_MAX_WAIT_MS : 2 * this.silentAnswerMs;
    const check = () => {
      if (this.stats.inputTranscriptEvents || this.conversationStarted) return; // the callee spoke: the provider answers them
      // Sound on the line may be a callee mid-hello that the provider has not called speech yet (an owner's "This is Dave" met the
      // greeting at 3 s): wait for a quiet moment, at most another silentAnswerMs, so a noisy line is still greeted.
      if (Date.now() - (this.soundHeardAt ?? -Infinity) < quietMs && Date.now() - armedAt < maxWaitMs) return void (this.silentAnswer = setTimeout(check, 200));
      this.greetSilent = true; this.stats.silentAnswer = true; this.greet();
    };
    this.silentAnswer = setTimeout(check, this.outboundSilenceMs);
  }
  get usable() { return !this.closing && !this.completed; }
  get outboundSilenceMs() { return this.screenVoicemail ? Math.max(this.silentAnswerMs, VOICEMAIL_SILENT_ANSWER_MS) : this.silentAnswerMs; }
  get voicemailQuietMs() { return (this.config.eotTimeoutMs ?? 1500) + 300; }
  send(message) {
    if (this.provider?.readyState !== WebSocket.OPEN) return false;
    if (this.provider.bufferedAmount > 256000) { this.close('provider_backpressure'); return false; }
    if (!Buffer.isBuffer(message)) this.trace(message, 'out');
    this.provider.send(Buffer.isBuffer(message) ? message : JSON.stringify(message)); return true;
  }
  input(payload) {
    if (this.closing) return;
    if (typeof payload !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length > 16000) return this.close('invalid_audio');
    this.stats.inputBytes += Buffer.from(payload, 'base64').length;
    this.listenTap.caller(payload); // the caller as heard, before any silencing for the provider
    this.sidecar?.audio(payload);
    const sound = audible(payload);
    if (sound) this.soundHeardAt = Date.now();
    if (this.opener && this.opener.state !== 'done' && !(this.screenVoicemail && this.opener.state === 'waiting')) {
      this.listenOpener(level(payload) >= BARGE_RMS); payload = silenceLike(payload);
    }
    // Twilio has already answered. Ringback is output only: dropping input here clips an
    // early hello and can turn its remaining syllable into an unrelated caller utterance.
    if (this.ready && !this.flushingInput) {
      if (!this.bridgeTurns) this.forward(payload);
      // Echo suppression: while the model's audio plays at the phone and its echo can still come back, only caller sound loud enough
      // to be a person reaches the provider; quieter sound goes as silence. Fed the echo, the provider took the model's own words for the
      // caller's ("Is this Juan?" came back as "Yes. This is Juan.") and answered itself (lab, -20 dB echo).
      else { this.forward(Date.now() - (this.soundUntil ?? 0) < ECHO_TAIL_MS && level(payload) < BARGE_RMS ? silenceLike(payload) : payload); this.listen(payload); }
    }
    else {
      if (sound) this.startupSound = true;
      this.queuedBytes += payload.length;
      // Twilio streams the caller's line nonstop (about 10,700 base64 characters a second): hold what arrives until the provider is
      // ready, as long as the start timeout (15 s) allows; that timeout, not this, ends a call whose provider never comes up.
      if (this.queuedBytes > 200000) return this.close('startup_audio_limit');
      this.queued.push(payload);
    }
  }
  // Caller sound against the bridge's turn rules (see BARGE_RMS): one Twilio frame (20 ms) at a time.
  listen(payload) {
    const now = Date.now(), rms = level(payload), modelSounding = now < (this.soundUntil ?? 0);
    if (rms >= BARGE_RMS) { this.loudMs = (this.loudMs ?? 0) + 20; this.quietMs = 0; }
    else if ((this.quietMs = (this.quietMs ?? 0) + 20) >= 200) this.loudMs = 0;
    if (this.loudMs >= BARGE_MS) {
      this.loudMs = 0;
      if (modelSounding) this.bargeIn(now);
    }
  }
  // Stop the model for the caller: the adapter cancels the reply and cuts the model's record of it to what Twilio had played.
  bargeIn(now) {
    const playedMs = this.item ? Math.max(0, Math.min(now - this.item.playFrom, this.item.bytes / 8)) : 0;
    for (const message of this.adapter.interrupt({item: this.item?.id, playedMs})) this.send(message);
    if ((this.stats.interruptions ??= []).length < 32) this.stats.interruptions.push({atMs: now - this.startedAt, playedMs: Math.round(playedMs)});
    this.item = undefined;
    this.handle({type: 'interrupted'});
  }
  armOpener() {
    clearTimeout(this.openerTimer);
    const check = () => {
      // When screening a greeting, give the speech provider time to finish a turn already in progress.
      const now = Date.now();
      if (this.screenVoicemail && now - this.startedAt < OPENER_MAX_WAIT_MS && now - (this.soundHeardAt ?? -Infinity) < this.voicemailQuietMs) {
        this.openerTimer = setTimeout(check, 200);
      } else this.playOpener('silence');
    };
    this.openerTimer = setTimeout(check, this.outboundSilenceMs);
  }
  // The callee's hello for a line without screening, or the echo window after the opener for either kind of line.
  listenOpener(sound) {
    const o = this.opener, now = Date.now();
    if (o.state === 'waiting') {
      if (sound) { o.heardMs += 20; o.lastSoundAt = now; }
      else if (o.heardMs >= OPENER_HELLO_MS && now - o.lastSoundAt >= OPENER_QUIET_MS) this.playOpener('hello');
    } else if (o.state === 'playing' && now > (this.soundUntil ?? 0) + OPENER_ECHO_MS) o.state = 'done';
  }
  playOpener(why) {
    if (!this.opener || this.opener.state !== 'waiting' || this.closing || this.completed) return;
    this.opener.state = 'rendering'; clearTimeout(this.openerTimer);
    const asked = Date.now(); this.stats.openerOn = why;
    this.openerClip.then(frames => {
      if (this.closing || this.completed) return;
      const now = Date.now(), bytes = frames.reduce((n, f) => n + Buffer.from(f, 'base64').length, 0);
      if (this.twilio.readyState === WebSocket.OPEN) for (const payload of frames) this.twilio.send(JSON.stringify({event: 'media', streamSid: this.config.streamSid, media: {payload: this.ambience ? this.ambience.under(payload) : payload}}));
      this.playedUntil = this.soundUntil = this.speakingUntil = Math.max(this.playedUntil ?? 0, now) + bytes / 8;
      this.conversationStarted = true; this.activeAt = now; this.stats.outputBytes += bytes;
      this.stats.firstSpeechMs ??= now - this.startedAt; this.stats.firstAudioMs ??= now - this.startedAt;
      Object.assign(this.stats, {openerMs: now - this.startedAt, openerWaitMs: now - asked});
      this.transcript.add('model', {text: this.config.opener}); this.config.transfer?.words(this);
      this.opener.state = 'playing';
    }, () => {
      // No clip (the render failed): the provider speaks the same line, which is already the first entry of its history.
      this.stats.openerError = 'render_failed'; this.opener.state = 'done';
      for (const message of this.adapter.injectAgentMessage?.(this.config.opener) ?? []) this.send(message);
    });
  }
  fillAmbience() {
    if (this.twilio.readyState !== WebSocket.OPEN || this.ringing || this.closing || this.completed) return;
    if (this.screenVoicemail && this.stats.firstSpeechMs === undefined) return;
    const now = Date.now();
    for (let n = 0; (this.playedUntil ?? 0) < now + 60 && n < 10; n++) {
      this.twilio.send(JSON.stringify({event: 'media', streamSid: this.config.streamSid, media: {payload: this.ambience.frame()}}));
      this.playedUntil = Math.max(this.playedUntil ?? 0, now) + 20;
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
        // Preserve and forward an early hello first, then give the provider one short window to acknowledge it. Raw line energy
        // cannot tell speech from noise, so it never extends the wait: the provider owns turn-taking. Once the provider has produced
        // words (the caller's transcript or the model's) or the model has sounded, no greeting is asked for (`conversationStarted`;
        // a bare speech start does not count), and an adapter may decline it (see `greet`). Quiet starts wait nothing.
        if (this.config.greet) this.greetingBound = setTimeout(() => this.greet(true), GREETING_BOUND_MS);
        if (this.startupSound) this.greetingTimer = setTimeout(() => this.greet(), STARTUP_SPEECH_ACK_MS);
        else this.greet();
      }
    };
    pump();
  }
  // Ask the model to speak first, once. An adapter that returns nothing declined for now (ElevenLabs: a reply is already on its way,
  // or the caller's speech is still open): it is asked again one acknowledgment window after each caller stop, and once more
  // GREETING_BOUND_MS after the caller's audio was flushed with `bounded`, which overrides an open caller turn but not a reply.
  greet(bounded = false) {
    if (this.closing || this.completed || !(this.config.greet || this.greetSilent) || this.conversationStarted || this.greeted) return;
    const messages = this.adapter.greet({bounded});
    this.greetingPending = !messages.length;
    if (!messages.length) return;
    this.greeted = true; this.stats.greetingMs = Date.now() - this.startedAt;
    for (const message of messages) this.send(message);
  }
  event(event) { this.trace(event, 'in'); for (const item of this.adapter.parse(event)) this.handle(item); }
  // A compact timeline of the turn-taking events on the receipt (`turns`, at most 400): when replies start and end and how, whether
  // their audio was played or dropped, and the cancels and commits the bridge sent. A reply that never reaches the phone shows here.
  trace(message, way) {
    const type = message?.type;
    if (typeof type !== 'string' || !TRACED.has(type)) return;
    const response = message.response?.id ?? message.response_id;
    if (type === 'response.output_audio.delta') { if (this.tracedAudio?.has(response)) return; (this.tracedAudio ??= new Set()).add(response); }
    const turns = this.stats.turns ??= [];
    if (turns.length < 400) turns.push({ms: Date.now() - this.startedAt, way, type, ...(response && {response}), ...(message.response?.status && {status: message.response.status}),
      ...(message.response?.status_details?.reason && {reason: message.response.status_details.reason}), ...(message.audio_end_ms !== undefined && {audioEndMs: message.audio_end_ms}),
      ...(type === 'response.output_audio.delta' && {dropped: this.adapter.cancelled?.has(response) ?? false}), ...(message.error?.code && {code: message.error.code})});
  }
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
        this.flushInput(); this.armSilentAnswer();
        if (this.opener) for (const message of this.adapter.history?.(this.config.opener) ?? []) this.send(message); // Deepgram: in its settings
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
        // the reply now playing, for an advice end: from its first audible audio until its audio is done
        if (sound && item.item && item.item !== this.reply?.item) this.reply = {item: item.item, at: now, done: false};
        // Twilio plays what it is sent in order at realtime speed (8 bytes a millisecond), so audio a provider sends faster than
        // that is still playing after it arrived: `playedUntil` is when Twilio's queue runs out, `soundUntil` when its last speech does.
        if (item.item && item.item !== this.item?.id) this.item = {id: item.item, playFrom: Math.max(this.playedUntil ?? 0, now), bytes: 0};
        if (this.item && item.item === this.item.id) this.item.bytes += bytes;
        this.playedUntil = Math.max(this.playedUntil ?? 0, now) + bytes / 8;
        if (sound) this.soundUntil = this.playedUntil;
        // Where output audio only flows while the model speaks, its arrival is the model speaking (GPT-Live streams silence):
        // the idle hang-up must not fire while it is still being played.
        if (this.adapter.constructor.audioMeansSpeech) { this.activeAt = now; this.speakingUntil = this.playedUntil; }
        if (this.twilio.readyState === WebSocket.OPEN) {
          if (this.twilio.bufferedAmount > 256000) return this.close('twilio_backpressure');
          this.twilio.send(JSON.stringify({event: 'media', streamSid: this.config.streamSid, media: {payload: this.ambience ? this.ambience.under(item.audio) : item.audio}}));
        }
        break;
      case 'reply': this.toolGate?.reset(); this.aiGuard?.reply(); break;
      case 'speech':
        if (item.who === 'model' && item.delta !== undefined && (this.toolGate || this.aiGuard) && this.guardModel(item)) break;
        if (String(item.text ?? item.delta ?? '').trim()) this.conversationStarted = true;
        // Output audio flows nonstop on some providers, silence included, so only these signals say who is speaking.
        if (item.who === 'caller') {
          if (item.start && Date.now() < (this.soundUntil ?? 0)) this.stats.speechOverModel = (this.stats.speechOverModel ?? 0) + 1;
          if (item.start) this.callerStoppedAt = undefined;
          else if (item.stop) {
            this.callerStoppedAt = Date.now();
            if (this.greetingPending) { clearTimeout(this.greetingTimer); this.greetingTimer = setTimeout(() => this.greet(), STARTUP_SPEECH_ACK_MS); }
            // the provider's share before the model can answer: the caller's last audible frame to the provider ending their turn
            if (this.soundHeardAt !== undefined && (this.stats.turnEndMs ??= []).length < 64) this.stats.turnEndMs.push(this.callerStoppedAt - this.soundHeardAt);
          }
          if (item.start) {
            this.cancelTools(true); this.turn++; this.callerUtterances++;
            // the provider keeps its own turn detection and has stopped its reply: drop what Twilio still has queued of it
            if (this.serverTurns && Date.now() < (this.soundUntil ?? 0)) this.bargeIn(Date.now());
          }
          if (item.stop) this.callerEndedAt = Date.now();
          this.callerSpeaking = true; this.stats.inputTranscriptEvents++; this.stopRing('caller');
        } else { this.callerSpeaking = false; if (this.handover?.heard && String(item.text ?? item.delta ?? '').trim()) this.handover.spoke = true; }
        this.activeAt = Date.now();
        if (item.who === 'caller' && (this.endOnMailbox(item.text) || this.endOnFirstTurnMailbox(item.text) || (!this.sidecar && this.catchMachine(item.text)))) break;
        if (this.advice) this.coach(item);
        this.transcript.add(item.who, item);
        this.config.transfer?.words(this);
        break;
      case 'advice_ack': this.advice?.acknowledged(); break;
      case 'note_heard':
        if (item.text === this.noteAwaiting?.text) { clearTimeout(this.noteAwaiting.timer); this.noteAwaiting = undefined; }
        if (this.handover && item.text === this.handover.text) this.handover.heard = true;
        break;
      case 'audio_done':
        if (this.reply) { this.reply.done = true; this.checkEnd(); }
        // the reply to the handover note has been sent: once Twilio has played it, the caller is moved
        if (this.handover?.spoke && !this.handover.marked) {
          this.handover.marked = true;
          if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify({event: 'mark', streamSid: this.config.streamSid, mark: {name: 'transfer'}}));
          else this.handedOver('played');
        }
        break;
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
      case 'latency': {
        const ms = x => typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) : undefined;
        if ((this.stats.replyLatency ??= []).length < 64) this.stats.replyLatency.push({totalMs: ms(item.total), thinkMs: ms(item.think), ttsMs: ms(item.tts)});
        break;
      }
      case 'tool': this.tool(item); break;
      case 'warning':
        if (item.code === 'injection_refused' && this.noteAwaiting) this.retryNote();
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
    const tool = Object.hasOwn(PHONE_TOOLS, item.name) ? PHONE_TOOLS[item.name] : item.name === 'transfer_call' && this.config.transfer ? TRANSFER_TOOL : null;
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
      }).finally(() => {
        clearTimeout(timer); this.pendingTools.delete(item.id);
        if (this.advice && this.adapter.constructor.adviceNow) this.pushAdvice(); // a note held while the tool ran
      });
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
      if (item.text) { this.earlyAsked = false; this.advice.heard(item.text, this.transcript.receipt().transcript ?? [], {since: this.callerEndedAt}); }
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
  // A provider that takes a note as a system item (`adviceNow`, ElevenLabs) takes it the moment it is ready, never while a tool call is
  // pending (the tool's end sends it) or once the call is ending.
  pushAdvice() {
    clearTimeout(this.adviceTimer);
    if (this.adapter.constructor.adviceNow) {
      if (this.pendingTools.size || this.endingAt || this.closing || this.completed) return;
      const note = this.advice.deliver();
      if (note) for (const message of this.adapter.adviceMessages(note)) this.send(message);
      return;
    }
    if (!this.adapter.adviceMessages || !this.advice.ready() || this.callerOpen || this.pendingTools.size
        || this.endingAt || this.closing || this.completed) return;
    const now = Date.now(), quiet = Math.max(this.wordsAt ?? 0, this.soundUntil ?? 0) + (this.config.adviceQuietMs ?? 1200) - now;
    const held = this.delegating ? this.delegatingAt + (this.config.adviceDelegationMs ?? 20000) - now : 0;
    if (Math.max(quiet, held) > 0) return void (this.adviceTimer = setTimeout(() => this.pushAdvice(), Math.max(quiet, held)));
    const note = this.advice.push(this.adapter.constructor.maxAdviceNote);
    if (note) for (const message of this.adapter.adviceMessages(note)) this.send(message);
  }
  // The model's words against the line's guards (src/phone-guards.mjs); true drops this piece of them. A tool call written into speech
  // (`toolGuard`) loses the reply's unplayed audio and the rest of its words, uncancelled so its function call still comes; delivery
  // tags are cut from the words. A volunteered AI admission (`aiGuard`, the caller never asked) cancels the reply, and the model is told
  // why and asked again, once a caller turn.
  guardModel(item) {
    if (this.tagStripper) {
      const clean = this.tagStripper.feed(item.delta);
      if (this.tagStripper.removed) this.stats.tagsStripped = this.tagStripper.removed;
      if (clean !== item.delta) { item.delta = clean; if (!clean) return true; }
    }
    const atMs = Date.now() - this.startedAt;
    if (this.toolGate?.feed(item.delta)) {
      this.cutReply(false);
      if ((this.stats.toolGuard ??= []).length < 16) this.stats.toolGuard.push({atMs});
      if (this.reply) { this.reply.done = true; this.checkEnd(); } // nothing more of it will play
      return true;
    }
    const said = this.aiGuard?.feed(item.delta, this.callerSaid());
    if (said === undefined) return false;
    this.cutReply(true);
    for (const message of this.adapter.reask(this.aiGuard.note(said))) this.send(message);
    if ((this.stats.aiGuard ??= []).length < 16) this.stats.aiGuard.push({atMs});
    return true;
  }
  // Everything the caller has said, for the AI guard: the transcript's caller turns and the sidecar's words of the current turn.
  callerSaid() { return [...this.transcript.turns.filter(t => t.who === 'caller').map(t => t.text), this.sidecarSaid ?? ''].join(' '); }
  // The reply in flight stops at the phone: what Twilio has queued is dropped, and the provider cancels it (`cancel`) or keeps it.
  cutReply(cancel) {
    const playedMs = this.item ? Math.max(0, Math.min(Date.now() - this.item.playFrom, this.item.bytes / 8)) : 0;
    if (cancel) for (const message of this.adapter.interrupt({item: this.item?.id, playedMs, cancel: true})) this.send(message);
    else this.adapter.drop();
    this.item = undefined; this.speakingUntil = this.playedUntil = this.soundUntil = 0;
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify({event: 'clear', streamSid: this.config.streamSid}));
  }
  // An advice end (lead_goodbye, opt_out, booked): the call ends once the model's next reply, the first to start after the caller's
  // utterance ended, has played at Twilio, or ADVICE_END_BACKSTOP_MS after the end came. The call's reason is the end.
  adviceEnd(end, since) {
    if (this.adviceEnding || !this.usable) return;
    this.adviceEnding = {end, since};
    this.stats.adviceEnd = {end, atMs: Date.now() - this.startedAt};
    this.adviceBackstop = setTimeout(() => { this.stats.adviceEnd.how ??= 'backstop'; this.close(end); }, this.config.adviceEndBackstopMs ?? ADVICE_END_BACKSTOP_MS);
    this.checkEnd();
  }
  checkEnd() {
    const ending = this.adviceEnding;
    if (!ending || ending.draining || !this.usable || !this.reply?.done || this.reply.at < ending.since) return;
    ending.draining = true; this.stats.adviceEnd.how = 'played';
    this.endingAt ??= Date.now(); this.drain(ending.end);
  }
  endOnFirstTurnMailbox(text) {
    if (!this.screenFirstTurn || !String(text ?? '').trim()) return false;
    this.screenFirstTurn = false;
    if (!mailboxGreeting(text)) return false;
    this.transcript.add('caller', {text});
    this.stats.voicemailMs = Date.now() - this.startedAt;
    this.close('voicemail');
    return true;
  }
  endOnMailbox(text) {
    if (!this.screenVoicemail || this.stats.modelRequests !== 0 || this.openingTurnAccepted || !mailboxGreeting(text)) return false;
    const last = this.transcript.turns.at(-1);
    if (last?.who !== 'caller' || !last.text.endsWith(text)) this.transcript.add('caller', {text});
    this.stats.voicemailMs = Date.now() - this.startedAt;
    this.close('voicemail');
    return true;
  }
  // Check the transcript in the request as well as on the socket: Deepgram can request a reply before delivering ConversationText.
  // The initial hello on a fixed-opener line needs playback only, so it need not reach the language model either.
  think(body) {
    if (this.screenVoicemail) {
      if (!this.usable) return;
      const text = latestCallerText(body);
      if (this.endOnMailbox(text)) return;
      if (this.opener && this.opener.state !== 'done') {
        if (text?.trim()) this.openingTurnAccepted = true;
        this.playOpener('hello');
        return;
      }
      this.stats.modelRequests++;
    }
    const thinking = this.config.thinking !== undefined && this.adapter.withThinking ? this.adapter.withThinking(body, this.config.thinking) : body;
    const note = this.advice?.note(), out = note ? this.adapter.withAdvice(thinking, note.text) : thinking;
    if (out !== thinking) this.advice.attached(note);
    return out;
  }
  endSoon() { this.endingAt ??= Date.now(); return {status: 'ending'}; }
  // transfer_call: one transfer at a time, handed to the install's transfers (src/phone-transfer.mjs), which report back through
  // note(), handOver() and transferEnded(). The model is answered at once so it keeps talking while the colleague's phone rings.
  transferSoon(args) {
    const whisper = typeof args.whisper === 'string' ? args.whisper.trim() : '';
    if (!whisper || whisper.length > MAX_WHISPER) return {status: 'invalid', error: `whisper must be 1..${MAX_WHISPER} characters`};
    if (this.transfer || this.endingAt) return {status: 'unavailable', error: this.transfer ? 'transfer_in_progress' : 'call_ending'};
    this.transfer = {at: Date.now()};
    Promise.resolve().then(() => this.config.transfer.start(this, whisper)).catch(() => this.transferEnded());
    return {status: 'ringing', note: TRANSFER_RINGING};
  }
  transferEnded(entry) {
    this.transfer = undefined;
    if (entry && (this.stats.transfers ??= []).length < 8) this.stats.transfers.push(entry);
  }
  // A message to the model from the call itself, answered like a caller's turn; a provider that refuses it while somebody speaks
  // gets it again shortly (the provider says only that an injection was refused, so the latest note is the one resent).
  note(text) {
    if (!this.usable || !this.adapter.injectNote) return;
    clearTimeout(this.noteAwaiting?.timer);
    this.noteAwaiting = {text, tries: 1};
    this.sendNote(this.noteAwaiting);
  }
  // A provider that sends nothing (a reply is in flight) has refused it as much as one that says so.
  sendNote(awaiting) {
    const messages = this.adapter.injectNote(awaiting.text);
    for (const message of messages) this.send(message);
    if (!messages.length) this.retryNote();
  }
  retryNote() {
    const awaiting = this.noteAwaiting;
    if (awaiting.timer || awaiting.tries >= NOTE_TRIES) return;
    awaiting.timer = setTimeout(() => {
      if (this.noteAwaiting !== awaiting || !this.usable) return;
      awaiting.timer = undefined; awaiting.tries++;
      this.sendNote(awaiting);
    }, NOTE_RETRY_MS);
  }
  // The colleague confirmed: the model says one handover sentence, and the promise resolves once Twilio has played it (its mark comes
  // back), or after handoverMaxMs at most; false when the call ended first.
  handOver(text) {
    return new Promise(resolve => {
      if (!this.usable) return resolve(false);
      this.handover = {text, resolve, cap: setTimeout(() => this.handedOver('cap'), this.config.handoverMaxMs ?? HANDOVER_MAX_MS)};
      this.note(text);
    });
  }
  handedOver(how) {
    const handover = this.handover; if (!handover) return;
    this.handover = undefined; clearTimeout(handover.cap);
    this.stats.handover = how;
    handover.resolve(this.usable);
  }
  // Audio a provider sent faster than realtime is still queued at Twilio, and closing the stream drops it (a voicemail message
  // was cut after one sentence). A mark queued behind that audio comes back from Twilio once everything before it has played.
  // `reason` is why the call ends once it has played (end_call by default).
  drain(reason) {
    this.drainingAt = Date.now(); this.drainReason ??= reason;
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify({event: 'mark', streamSid: this.config.streamSid, mark: {name: 'end_call'}}));
    else this.close(this.drainReason ?? 'end_call');
  }
  mark(name) {
    if (name === 'end_call' && this.drainingAt) this.close(this.drainReason ?? 'end_call');
    if (name === 'transfer' && this.handover?.marked) this.handedOver('played');
  }
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
    this.advice?.close(); clearTimeout(this.adviceTimer); clearTimeout(this.adviceBackstop); this.sidecar?.close();
    this.cancelTools();
    this.config.transfer?.words(this, true);
    this.closing = true; this.stats.reason = this.closeReason ?? reason; // closeReason: the call was moved on (a transfer) and its stream ends for that
    clearTimeout(this.noteAwaiting?.timer); this.handedOver('closed');
    clearTimeout(this.inputFlush); clearTimeout(this.greetingTimer); clearTimeout(this.greetingBound); clearTimeout(this.silentAnswer); clearTimeout(this.openerTimer); clearInterval(this.ambienceTick);
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
    this.advice?.close(); clearTimeout(this.adviceTimer); clearTimeout(this.adviceBackstop); this.sidecar?.close();
    this.cancelTools();
    this.config.transfer?.words(this, true); // a provider that closed its own socket never went through close()
    this.completed = true; clearTimeout(this.noteAwaiting?.timer); this.handedOver('closed'); clearTimeout(this.startTimer); clearTimeout(this.duration); clearInterval(this.idle); clearTimeout(this.closeTimer); clearInterval(this.ringing);
    clearTimeout(this.inputFlush); clearTimeout(this.greetingTimer); clearTimeout(this.greetingBound); clearTimeout(this.silentAnswer); clearTimeout(this.openerTimer); clearInterval(this.ambienceTick);
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
