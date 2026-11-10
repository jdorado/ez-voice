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
  // Mini does not call tools: given end_call it writes "[end_call]" into its speech instead, while Max issues real function calls.
  static toolModels = ['eleven_realtime_v1_max'];
  // A session can be opened while an outbound call rings and wait for its media stream (see `warmSeconds` in `configure`).
  static warm = true;
  static supportsTools(model) { return ElevenLabsAdapter.toolModels.includes(model); }

  constructor(config, {fetch: fetchImpl = fetch} = {}) { this.config = config; this.fetch = fetchImpl; this.cancelled = new Set(); }

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
    return {type: 'session.update', session: {type: 'realtime', model: c.model, instructions: c.instructions, output_modalities: ['audio'],
      max_duration_seconds: Math.min(7200, Math.max(60, (c.maxCallSeconds ?? 180) + 15 + (c.warmSeconds ?? 0))),
      ...(c.tools === false || !ElevenLabsAdapter.supportsTools(c.model) ? {} : {tools: toolDefinitions(c), tool_choice: 'auto'}),
      audio: {input: {format: {type: 'audio/pcmu'}, transcription: {language: c.language ?? 'en'}}, output: {format: {type: 'audio/pcmu'}, voice: c.voice}}}};
  }
  // An empty response request can produce no turn. Supply the actual transport event,
  // just as Gemini requires, without inventing caller speech or a domain-specific greeting.
  // A caller who speaks as the call connects gets the provider's own reply to their turn: the greeting is not needed then, and a
  // greeting asked for while the caller's speech is still open leaves their turn unanswered until they repeat it. The bridge asks
  // again when the caller stops (nothing is left to answer if the provider has replied by then).
  greet() { return this.response || this.callerSpeaking ? [] : (this.greetedAt = Date.now(), [
    {type: 'conversation.item.create', item: {type: 'message', role: 'user', content: [{type: 'input_text', text: '(The call has connected: answer it.)'}]}},
    {type: 'response.create'},
  ]); }
  audioIn(audio) { return [{type: 'input_audio_buffer.append', audio}]; }
  parse(event) {
    switch (event.type) {
      case 'conversation.created': this.conversationId = event.conversation?.id; return [];
      case 'session.created': return [{type: 'send', message: this.configure()}];
      case 'session.updated': return this.ready ? [] : (this.ready = true, [{type: 'ready', id: this.conversationId}]);
      case 'response.created': this.response = event.response?.id; return [];
      case 'response.done': if (event.response?.id === this.response) this.response = undefined; return [];
      case 'response.output_audio.delta':
        if (typeof event.delta !== 'string' || event.delta.length > 1000000) return [{type: 'fatal', reason: 'invalid_provider_audio'}];
        if (this.cancelled.has(event.response_id)) return []; // the reply the caller already talked over
        return [{type: 'audio', audio: event.delta}];
      // Server-side voice activity says at once when the caller starts talking (a barge-in also stops what is queued at Twilio).
      // The provider cancels the reply in flight but keeps streaming it, faster than realtime, until `output_audio_buffer.cleared`
      // (about 0.3 s later: seconds of speech). That audio would reach Twilio after the clear and play over the caller (a voicemail
      // greeting that paused mid-sentence was talked over for six seconds), so the cancelled reply's audio is dropped from here.
      // The id stays for the call: the provider may send `response.done` before its last stray audio, and ids are never reused.
      case 'input_audio_buffer.speech_started':
        if (this.response) this.cancelled.add(this.response);
        this.callerSpeaking = true;
        return [{type: 'speech', who: 'caller', start: true}, {type: 'interrupted'}];
      case 'input_audio_buffer.speech_stopped': this.callerSpeaking = false; return [{type: 'speech', who: 'caller', stop: true}];
      // The caller's words arrive whole per utterance, the model's as it speaks.
      case 'conversation.item.input_audio_transcription.completed': return [{type: 'speech', who: 'caller', text: words(event.transcript)}];
      case 'response.output_audio_transcript.delta': return [{type: 'speech', who: 'model', delta: words(event.delta)}];
      case 'response.output_item.done':
        return event.item?.type === 'function_call' ? [{type: 'tool', id: event.item.call_id, name: event.item.name, args: event.item.arguments}] : [];
      case 'error':
        // The provider answers a caller who speaks first on its own; a greeting asked for in the same instant meets that reply in flight.
        // What was asked for is happening, so this ends nothing (the receipt keeps a warning). The same error for anything else, such as
        // a tool result that asked the model to go on, still ends the call.
        if (event.error?.code === 'conversation_already_has_active_response' && Date.now() - (this.greetedAt ?? -Infinity) < 5000) return [{type: 'warning', code: 'greeting_met_active_response'}];
        return [{type: 'error', code: typeof event.error?.code === 'string' ? event.error.code.slice(0, 100) : 'provider_error'}];
      default: return [];
    }
  }
  toolResult(id, name, output, {final = false} = {}) {
    this.greetedAt = undefined;
    const answer = {type: 'conversation.item.create', item: {type: 'function_call_output', call_id: id, output: JSON.stringify(output)}};
    return final ? [answer] : [answer, {type: 'response.create'}];
  }
  // No close handshake: closing the socket ends the session, and no usage is reported.
  closeMessages() { return []; }
}
