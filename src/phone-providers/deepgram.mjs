import {toolDefinitions} from '../phone-tools.mjs';
import {words} from './transcript.mjs';
import {geminiParameters} from './gemini-schema.mjs';

// Deepgram owns the cascaded speech session and turn detection. This adapter only translates
// its wire protocol; the existing bridge still owns admission, installed tools and cancellation.
const SOCKET_URL = 'wss://agent.deepgram.com/v1/agent/converse';
const CONNECTED = '(The call has connected: answer it.)';
// Upstream descriptions can contain request content and credentials. Retain only
// known categories/statuses, never the description or arbitrary provider fields.
function diagnostic(event) {
  const description = typeof event.description === 'string' ? event.description.slice(0, 16000) : '';
  const status = description.match(/(?:status(?:_code)?[\s"':=]*|HTTP\D{0,5})([45]\d\d)\b/i)?.[1];
  const categories = [
    ['invalid_key', /API_KEY_INVALID|invalid.{0,20}api.?key|api.?key.{0,20}(invalid|expired)/i],
    ['quota', /RESOURCE_EXHAUSTED|quota|rate.?limit/i],
    ['permission', /PERMISSION_DENIED|permission|unauthorized|authentication/i],
    ['model_unavailable', /NOT_FOUND|model.{0,60}(not found|not supported|not available)/i],
    ['invalid_arguments', /INVALID_ARGUMENT|invalid json|unknown name|invalid schema/i],
  ];
  const category = categories.find(([, pattern]) => pattern.test(description))?.[0];
  return {code: typeof event.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(event.code) ? event.code : 'PROVIDER_ERROR',
    ...(status && {upstreamStatus: Number(status)}), ...(category && {category})};
}

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
  static expectsFinalResponse = true;
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
          ({name, description, parameters: geminiParameters(parameters), defer_until_eot: true}))}),
      },
      speak: {provider: {type: 'eleven_labs', model_id: c.ttsModel ?? DeepgramAdapter.defaultTtsModel},
        endpoint: {url: `wss://api.elevenlabs.io/v1/text-to-speech/${c.voice}/multi-stream-input`,
          headers: {'xi-api-key': c.ttsApiKey}}},
    }};
  }
  greet() { this.greetingInjected = true; return [{type: 'InjectUserMessage', content: CONNECTED}]; }
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
      case 'AgentAudioDone': return [{type: 'output_done'}];
      case 'ConversationText':
        if (this.greetingInjected && event.role === 'user' && event.content === CONNECTED) {this.greetingInjected = false; return [];}
        return ['user', 'assistant'].includes(event.role) && typeof event.content === 'string'
          ? [{type: 'speech', who: event.role === 'user' ? 'caller' : 'model',
            ...(event.role === 'user' ? {text: words(event.content)} : {delta: words(event.content)})}] : [];
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
      case 'Warning': return [{type: 'warning', ...diagnostic(event)}];
      case 'Error': return [{type: 'warning', ...diagnostic(event)}, {type: 'error', code: diagnostic(event).code}];
      default: return [];
    }
  }
  toolResult(id, name, output, {final = false} = {}) {
    const signature = this.signatures.get(id); this.signatures.delete(id);
    // Every admitted client-side function needs a response, including end_call, so
    // the managed agent can produce its final words. Cancelled calls get no response.
    if (output?.status === 'cancelled') return [];
    return [{type: 'FunctionCallResponse', id, name, content: JSON.stringify(output),
      ...(signature ? {thought_signature: signature} : {})}];
  }
  closeMessages() { this.signatures.clear(); return []; }
}
