import {toolDefinitions} from '../phone-tools.mjs';
import {words} from './transcript.mjs';

// Deepgram owns the cascaded speech session and turn detection. This adapter only translates
// its wire protocol; the existing bridge still owns admission, installed tools and cancellation.
const SOCKET_URL = 'wss://agent.deepgram.com/v1/agent/converse';

export class DeepgramAdapter {
  static id = 'deepgram';
  static label = 'Deepgram';
  static models = ['gemini-3.8-flash'];
  static defaultModel = 'gemini-3.8-flash';
  static defaultVoice = 'JBFqnCBsd6RMkjVDRZzb';
  static ttsModels = ['eleven_flash_v2_5'];
  static defaultTtsModel = 'eleven_flash_v2_5';
  static keyPattern = /^[A-Za-z0-9_-]{20,200}$/;
  static confirmsClose = false;
  static audioMeansSpeech = true;
  static binaryAudio = true;
  static supportsTools() { return true; }

  constructor(config) { this.config = config; this.signatures = new Map(); }
  connection() { return {url: SOCKET_URL, headers: {Authorization: `Token ${this.config.apiKey}`}}; }
  start() { return []; } // Welcome precedes Settings; SettingsApplied precedes audio.
  settings() {
    const c = this.config;
    return {type: 'Settings', audio: {
      input: {encoding: 'mulaw', sample_rate: 8000},
      output: {encoding: 'mulaw', sample_rate: 8000, container: 'none'},
    }, agent: {
      listen: {provider: {type: 'deepgram', model: 'flux-general-en', version: 'v2'}},
      think: {
        provider: {type: 'google'},
        endpoint: {url: `https://generativelanguage.googleapis.com/v1beta/models/${c.model}:streamGenerateContent?alt=sse`,
          headers: {'x-goog-api-key': c.llmApiKey}},
        prompt: c.instructions,
        ...(c.tools === false ? {} : {functions: toolDefinitions(c).map(({name, description, parameters}) =>
          ({name, description, parameters, defer_until_eot: true}))}),
      },
      speak: {provider: {type: 'eleven_labs', model_id: c.ttsModel ?? DeepgramAdapter.defaultTtsModel},
        endpoint: {url: `wss://api.elevenlabs.io/v1/text-to-speech/${c.voice}/multi-stream-input`,
          headers: {'xi-api-key': c.ttsApiKey}}},
    }};
  }
  greet() { return [{type: 'InjectUserMessage', content: '(The call has connected: answer it.)'}]; }
  audioIn(payload) { return [Buffer.from(payload, 'base64')]; }
  parse(event) {
    if (Buffer.isBuffer(event)) return event.length ? [{type: 'audio', audio: event.toString('base64')}] : [];
    switch (event.type) {
      case 'Welcome':
        if (this.welcomed) return [];
        this.welcomed = true;
        this.id = typeof event.request_id === 'string' ? event.request_id.slice(0, 100) : undefined;
        return [{type: 'send', message: this.settings()}];
      case 'SettingsApplied':
        if (this.ready) return [];
        this.ready = true; return [{type: 'ready', id: this.id}];
      case 'UserStartedSpeaking': return [{type: 'speech', who: 'caller', start: true}, {type: 'interrupted'}];
      case 'ConversationText':
        return ['user', 'assistant'].includes(event.role) && typeof event.content === 'string'
          ? [{type: 'speech', who: event.role === 'user' ? 'caller' : 'model', text: words(event.content)}] : [];
      case 'FunctionCallRequest': {
        if (!Array.isArray(event.functions)) return [{type: 'fatal', reason: 'invalid_provider_event'}];
        const items = [];
        for (const call of event.functions) {
          if (call?.client_side !== true) continue;
          if (typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(call.id)) continue;
          if (this.signatures.size >= 64) return [{type: 'fatal', reason: 'provider_tool_limit'}];
          if (call.thought_signature !== undefined) {
            if (typeof call.thought_signature !== 'string' || call.thought_signature.length > 65536)
              return [{type: 'fatal', reason: 'invalid_provider_event'}];
            this.signatures.set(call.id, call.thought_signature);
          }
          items.push({type: 'tool', id: call.id, name: call.name, args: call.arguments});
        }
        return items;
      }
      case 'FunctionCallCancelled':
        return (Array.isArray(event.functions) ? event.functions : []).flatMap(call => {
          if (typeof call?.id !== 'string') return [];
          this.signatures.delete(call.id); return [{type: 'cancelled', id: call.id}];
        });
      case 'Error': return [{type: 'error', code: typeof event.code === 'string' ? event.code.slice(0, 100) : 'provider_error'}];
      default: return [];
    }
  }
  toolResult(id, name, output, {final = false} = {}) {
    const signature = this.signatures.get(id); this.signatures.delete(id);
    // Deepgram explicitly requires no response for cancelled calls. Final hang-up needs no
    // additional model turn; the bridge waits for the queued goodbye before closing.
    if (final || output?.status === 'cancelled') return [];
    return [{type: 'FunctionCallResponse', id, name, content: JSON.stringify(output),
      ...(signature ? {thought_signature: signature} : {})}];
  }
  closeMessages() { this.signatures.clear(); return []; }
}
