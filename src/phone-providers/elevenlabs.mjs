import {toolDefinitions} from '../phone-tools.mjs';

// ElevenLabs Realtime: the OpenAI Realtime protocol over WebSocket, behind a cascaded speech stack (ElevenLabs documents it as
// separate speech-to-text, language and text-to-speech models). It takes G.711 mu-law directly and calls tools natively.
// The socket refuses the account key (close 4001); it wants a short-lived client secret, so each call mints one first.
const SECRET_URL = 'https://api.elevenlabs.io/v1/convai/realtime/client_secrets';
const SOCKET_URL = 'wss://api.elevenlabs.io/v1/convai/realtime';

export class ElevenLabsAdapter {
  static id = 'elevenlabs';
  static label = 'ElevenLabs';
  static models = ['eleven_realtime_v1_mini', 'eleven_realtime_v1_max'];
  static defaultModel = 'eleven_realtime_v1_mini';
  static defaultVoice = 'brian';
  static keyPattern = /^sk_[A-Za-z0-9]{20,100}$/;
  static confirmsClose = false;
  // Mini does not call tools: given end_call it writes "[end_call]" into its speech instead, while Max issues real function calls.
  static toolModels = ['eleven_realtime_v1_max'];

  constructor(config, {fetch: fetchImpl = fetch} = {}) { this.config = config; this.fetch = fetchImpl; }

  async connection() {
    const response = await this.fetch(SECRET_URL, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: {'xi-api-key': this.config.apiKey, 'Content-Type': 'application/json'},
      body: JSON.stringify({expires_after: {anchor: 'created_at', seconds: 120}})});
    if (!response.ok) { const error = Error(`ElevenLabs client secret request failed (HTTP ${response.status})`); error.status = response.status; throw error; }
    const secret = (await response.json())?.value;
    if (typeof secret !== 'string' || !secret) throw Error('ElevenLabs returned no client secret');
    return {url: SOCKET_URL, headers: {Authorization: `Bearer ${secret}`}};
  }
  // The server greets with session.created; the session is configured in answer to it.
  start() { return []; }
  configure() {
    const c = this.config;
    return {type: 'session.update', session: {type: 'realtime', model: c.model, instructions: c.instructions, output_modalities: ['audio'],
      ...(c.tools === false || !ElevenLabsAdapter.toolModels.includes(c.model) ? {} : {tools: toolDefinitions(), tool_choice: 'auto'}),
      audio: {input: {format: {type: 'audio/pcmu'}, transcription: {language: c.language ?? 'en'}}, output: {format: {type: 'audio/pcmu'}, voice: c.voice}}}};
  }
  audioIn(audio) { return [{type: 'input_audio_buffer.append', audio}]; }
  parse(event) {
    switch (event.type) {
      case 'conversation.created': this.conversationId = event.conversation?.id; return [];
      case 'session.created': return [{type: 'send', message: this.configure()}];
      case 'session.updated': return this.ready ? [] : (this.ready = true, [{type: 'ready', id: this.conversationId}]);
      case 'response.output_audio.delta':
        if (typeof event.delta !== 'string' || event.delta.length > 1000000) return [{type: 'fatal', reason: 'invalid_provider_audio'}];
        return [{type: 'audio', audio: event.delta}];
      // Server-side voice activity says at once when the caller starts talking (a barge-in also stops what is queued at Twilio).
      case 'input_audio_buffer.speech_started': return [{type: 'speech', who: 'caller'}, {type: 'interrupted'}];
      case 'input_audio_buffer.speech_stopped':
      case 'conversation.item.input_audio_transcription.completed': return [{type: 'speech', who: 'caller'}];
      case 'response.output_audio_transcript.delta': return [{type: 'speech', who: 'model'}];
      case 'response.output_item.done':
        return event.item?.type === 'function_call' ? [{type: 'tool', id: event.item.call_id, name: event.item.name}] : [];
      case 'error': return [{type: 'error', code: typeof event.error?.code === 'string' ? event.error.code.slice(0, 100) : 'provider_error'}];
      default: return [];
    }
  }
  toolResult(id, name, output) {
    return [{type: 'conversation.item.create', item: {type: 'function_call_output', call_id: id, output: JSON.stringify(output)}}, {type: 'response.create'}];
  }
  // No close handshake: closing the socket ends the session, and no usage is reported.
  closeMessages() { return []; }
}
