import {toolDefinitions} from '../phone-tools.mjs';
import {words} from './transcript.mjs';

// ElevenLabs Realtime: the OpenAI Realtime protocol over WebSocket, behind a cascaded speech stack (ElevenLabs documents it as
// separate speech-to-text, language and text-to-speech models). It takes G.711 mu-law directly and calls tools natively.
// The socket refuses the account key (close 4001); it wants a short-lived client secret, so each call mints one first.
const SECRET_URL = 'https://api.elevenlabs.io/v1/convai/realtime/client_secrets';
const SOCKET_URL = 'wss://api.elevenlabs.io/v1/convai/realtime';

export class ElevenLabsAdapter {
  static id = 'elevenlabs';
  // Characters a session takes: `instructions` for a line's instruction files joined or a call's brief, `session` for the whole starting
  // text (the instructions with a brief or a caller context). A property of this provider's model, never of a persona.
  // ElevenLabs documents no limit for Realtime instructions. Measured on the phone path (2026-11-06, `eleven_realtime_v1_max`, scripted
  // calls at 12K, 20K, 40K, 80K and 150K characters of instructions): every session started and ended normally and the reply gap did not
  // move (median 0.6 to 0.9 s at each size); credits per call grow with size. 100,000 and 120,000 stay well inside what was measured.
  static limits = {instructions: 100000, session: 120000};
  static label = 'ElevenLabs';
  static models = ['eleven_realtime_v1_mini', 'eleven_realtime_v1_max'];
  static defaultModel = 'eleven_realtime_v1_mini';
  static defaultVoice = 'brian';
  static keyPattern = /^sk_[A-Za-z0-9]{20,100}$/;
  static confirmsClose = false;
  static audioMeansSpeech = true;
  // The provider's own barge-in cancels a reply on any sound it takes for speech: a click, a breath, the model's own voice echoed back by
  // the callee's handset (five live calls on 2026-11-16: three replies cut with no word on the caller's line, then 6 to 14 s of silence).
  // Its sessions take `interrupt_response: false` and keep reporting `speech_started`, so the bridge decides: it cancels only on sustained
  // caller sound (`interrupt`).
  static bridgeTurns = true;
  // Mini does not call tools: given end_call it writes "[end_call]" into its speech instead, while Max issues real function calls.
  static toolModels = ['eleven_realtime_v1_max'];
  // A session can be opened while an outbound call rings and wait for its media stream (see `warmSeconds` in `configure`).
  static warm = true;
  // A side-coach note goes in as a system item the moment it is ready, with no response asked for: context for the model's next reply
  // and nobody's turn (a user item was answered as one, and voiced). See src/phone-advice.mjs.
  static adviceNow = true;
  static supportsTools(model) { return ElevenLabsAdapter.toolModels.includes(model); }

  constructor(config, {fetch: fetchImpl = fetch} = {}) {
    this.config = config; this.fetch = fetchImpl; this.cancelled = new Set();
    // A line that watches the model's words (toolGuard, aiGuard) is told where each reply starts, and hears no words of a reply it dropped.
    this.guarded = Boolean(config.toolGuard || config.aiGuard);
  }

  async connection() {
    // The mint scopes the authoritative initial session; do not connect with default
    // instructions/model/tools and rely on a later update to replace them.
    const response = await this.fetch(SECRET_URL, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: {'xi-api-key': this.config.apiKey, 'Content-Type': 'application/json'},
      body: JSON.stringify({session: this.configure().session, expires_after: {anchor: 'created_at', seconds: 120}})});
    if (!response.ok) { const error = Error(`ElevenLabs client secret request failed (HTTP ${response.status})`); error.status = response.status; throw error; }
    const secret = (await response.json())?.value;
    if (typeof secret !== 'string' || !secret) throw Error('ElevenLabs returned no client secret');
    return {url: SOCKET_URL, headers: {Authorization: `Bearer ${secret}`}};
  }
  // The server greets with session.created; the session is configured in answer to it.
  start() { return []; }
  configure() {
    const c = this.config;
    // ElevenLabs closes a session after max_duration_seconds (default 600, range 60..7200): follow the call length.
    // `turnDetection: 'server'` sends no turn_detection: the provider's default, its own barge-in included (see `bridgeTurns`).
    return {type: 'session.update', session: {type: 'realtime', model: c.model, instructions: c.instructions, output_modalities: ['audio'],
      max_duration_seconds: Math.min(7200, Math.max(60, (c.maxCallSeconds ?? 180) + 15 + (c.warmSeconds ?? 0))),
      ...(c.tools === false || !ElevenLabsAdapter.supportsTools(c.model) ? {} : {tools: toolDefinitions(c), tool_choice: 'auto'}),
      audio: {input: {format: {type: 'audio/pcmu'}, transcription: {language: c.language ?? 'en'}, ...(c.turnDetection !== 'server' && {turn_detection: {type: 'semantic_vad', interrupt_response: false}})},
        output: {format: {type: 'audio/pcmu'}, voice: c.voice, ...(c.speed !== undefined && {speed: c.speed})}}}};
  }
  // An empty response request can produce no turn. Supply the actual transport event,
  // just as Gemini requires, without inventing caller speech or a domain-specific greeting.
  // A caller who speaks as the call connects gets the provider's own reply to their turn: the greeting is not needed then, and a
  // greeting asked for while the caller's speech is still open leaves their turn unanswered until they repeat it. The bridge asks
  // again when the caller stops (nothing is left to answer if the provider has replied by then), and with `bounded` it greets anyway:
  // a caller turn that never closes (a speech-like background) must not leave the line silent. A reply in flight is never overridden.
  greet({bounded = false} = {}) { return this.response || (this.callerSpeaking && !bounded) ? [] : (this.greetedAt = Date.now(), [
    {type: 'conversation.item.create', item: {type: 'message', role: 'user', content: [{type: 'input_text', text: '(The call has connected: answer it.)'}]}},
    {type: 'response.create'},
  ]); }
  // A note to the model from the call itself (a transfer's outcome, the handover sentence): a user turn it answers, kept out of the
  // transcript. The provider refuses a response.create while a reply is active, so nothing is sent then or while the caller speaks (an
  // empty answer: the bridge asks again shortly). A refusal that still comes (a reply began as this went out) is the warning
  // `injection_refused` (see `parse`); the item is already in the conversation by then, so its retry asks for the response only.
  injectNote(text) {
    if (this.response || this.callerSpeaking) return [];
    const made = this.noteMade && this.noteText === text;
    this.noteText = text; this.noteMade = this.noteAsked = true; this.noteAt = Date.now();
    return [...made ? [] : [{type: 'conversation.item.create', item: {type: 'message', role: 'user', content: [{type: 'input_text', text: `(${text})`}]}}],
      {type: 'response.create'}];
  }
  audioIn(audio) { return [{type: 'input_audio_buffer.append', audio}]; }
  parse(event) {
    switch (event.type) {
      case 'conversation.created': this.conversationId = event.conversation?.id; return [];
      case 'session.created': return [{type: 'send', message: this.configure()}];
      case 'session.updated': return this.ready ? [] : (this.ready = true, [{type: 'ready', id: this.conversationId}]);
      // The first reply after a note was asked for is the provider taking it (the item alone is not: a refusal can still follow it, and
      // the bridge would stop asking while the reply in flight was taken for the answer).
      case 'response.created': {
        this.response = event.response?.id;
        const reply = this.guarded ? [{type: 'reply', id: this.response}] : [];
        if (!this.noteAsked) return reply;
        this.noteAsked = this.noteMade = false; return [...reply, {type: 'note_heard', text: this.noteText}];
      }
      case 'response.done': {
        const id = event.response?.id, mine = id === this.response;
        if (mine) this.response = undefined;
        return this.audioDone(id);
      }
      // All of a reply's audio has been sent (Twilio may still be playing it); `response.done` says it too for a reply with no audio event.
      case 'response.output_audio.done': return this.audioDone(event.response_id);
      case 'response.output_audio.delta':
        if (typeof event.delta !== 'string' || event.delta.length > 1000000) return [{type: 'fatal', reason: 'invalid_provider_audio'}];
        if (this.cancelled.has(event.response_id)) return []; // the reply the caller already talked over
        return [{type: 'audio', audio: event.delta, item: event.item_id}];
      // Server-side voice activity says when it hears the caller start; with `interrupt_response: false` that cancels nothing (see
      // `bridgeTurns`): the bridge decides whether it was speech and calls `interrupt`.
      case 'input_audio_buffer.speech_started':
        this.callerSpeaking = true;
        return [{type: 'speech', who: 'caller', start: true}];
      case 'input_audio_buffer.speech_stopped': this.callerSpeaking = false; return [{type: 'speech', who: 'caller', stop: true}];
      // The caller's words arrive whole per utterance, the model's as it speaks.
      case 'conversation.item.input_audio_transcription.completed': return [{type: 'speech', who: 'caller', text: words(event.transcript)}];
      case 'response.output_audio_transcript.delta':
        if (this.guarded && this.cancelled.has(event.response_id)) return []; // the rest of a reply a guard dropped
        return [{type: 'speech', who: 'model', delta: words(event.delta)}];
      case 'response.output_item.done':
        return event.item?.type === 'function_call' ? [{type: 'tool', id: event.item.call_id, name: event.item.name, args: event.item.arguments}] : [];
      case 'error':
        // A cancel the bridge sent can meet a reply that just ended: what it asked for is moot, so it ends nothing.
        if (Date.now() - (this.controlAt ?? -Infinity) < 1500 && /cancel|response/i.test(String(event.error?.code ?? ''))) return [{type: 'warning', code: String(event.error.code).slice(0, 100)}];
        // The provider answers a caller who speaks first on its own; a greeting asked for in the same instant meets that reply in flight.
        // What was asked for is happening, so this ends nothing (the receipt keeps a warning). The same error for anything else, such as
        // a tool result that asked the model to go on, still ends the call.
        if (event.error?.code === 'conversation_already_has_active_response' && Date.now() - (this.greetedAt ?? -Infinity) < 5000) return [{type: 'warning', code: 'greeting_met_active_response'}];
        // The same for a note: the reply that was in flight is not the note's, the bridge sends it again when that reply ends.
        if (event.error?.code === 'conversation_already_has_active_response' && this.noteAsked && Date.now() - this.noteAt < 5000) { this.noteAsked = false; return [{type: 'warning', code: 'injection_refused'}]; }
        return [{type: 'error', code: typeof event.error?.code === 'string' ? event.error.code.slice(0, 100) : 'provider_error'}];
      default: return [];
    }
  }
  audioDone(id) {
    if (!id || id === this.audioEnded || this.cancelled.has(id)) return []; // once per reply, and never for the one the caller talked over
    this.audioEnded = id; return [{type: 'audio_done'}];
  }
  // The caller talked over the reply: stop it, drop the audio it keeps streaming until it confirms (`output_audio_buffer.cleared`, seconds
  // of speech at its burst rate, which would play over the caller), and cut the model's record of it to what was heard (`playedMs` of
  // `item`), so its next turn follows on from there instead of assuming the whole reply was heard. Ids stay cancelled for the call:
  // `response.done` can come before the last stray audio, and ids are never reused.
  // With the provider's own turn detection (`turnDetection: 'server'`) it has cancelled the reply itself: only the record is cut.
  // A guard's correction cancels in either case (`cancel`).
  interrupt({item, playedMs, cancel = this.config.turnDetection !== 'server'}) {
    this.controlAt = Date.now();
    const messages = [];
    if (this.response) { this.cancelled.add(this.response); if (cancel) messages.push({type: 'response.cancel'}); }
    if (item) messages.push({type: 'conversation.item.truncate', item_id: item, content_index: 0, audio_end_ms: Math.max(0, Math.round(playedMs))});
    return messages;
  }
  // A reply the tool guard caught speaking a tool call: none of its audio or words are kept from here, and it is not cancelled, so a
  // function call in the same reply still comes.
  drop() { if (this.response) this.cancelled.add(this.response); }
  // A side-coach note (src/phone-advice.mjs), and the guard's correction of a cancelled reply with the reply asked for again.
  systemItem(text) { return {type: 'conversation.item.create', item: {type: 'message', role: 'system', content: [{type: 'input_text', text}]}}; }
  adviceMessages(note) { return [this.systemItem(note)]; }
  reask(note) { return [this.systemItem(note), {type: 'response.create'}]; }
  // A line the bridge already played (a placed call's pre-rendered opener): the model takes it as its own and goes on from there.
  history(text) { return [{type: 'conversation.item.create', item: {type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}}]; }
  toolResult(id, name, output, {final = false} = {}) {
    this.greetedAt = undefined;
    const answer = {type: 'conversation.item.create', item: {type: 'function_call_output', call_id: id, output: JSON.stringify(output)}};
    return final ? [answer] : [answer, {type: 'response.create'}];
  }
  // No close handshake: closing the socket ends the session, and no usage is reported.
  closeMessages() { return []; }
}
