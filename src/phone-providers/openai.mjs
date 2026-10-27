import {toolDefinitions, BACKEND_INSTRUCTIONS, DEFAULT_TOOL_MODEL, DEFAULT_TOOL_EFFORT} from '../phone-tools.mjs';

// GPT-Live (OpenAI /v1/live/sessions). It carries mu-law 8 kHz both ways and has no direct function calling: tools run on
// its Responses backend (delegation), which hands finished calls back to the plugin.
export class OpenAIAdapter {
  static id = 'openai';
  static label = 'OpenAI';
  static models = ['gpt-live-1'];
  static defaultModel = 'gpt-live-1';
  static defaultVoice = 'marin';
  static keyPattern = /^sk-[A-Za-z0-9_-]{10,}$/;
  static confirmsClose = true;

  constructor(config) { this.config = config; }

  connection() {
    return {url: 'wss://api.openai.com/v1/live/sessions', headers: {Authorization: `Bearer ${this.config.apiKey}`}};
  }
  start() {
    const c = this.config;
    return [{type: 'session.start', session: {
      model: c.model, instructions: c.instructions,
      audio: {format: {type: 'audio/pcmu', rate: 8000}, output: {voice: c.voice}},
      delegation: c.tools === false ? {type: 'client'} : {type: 'responses', responses: {model: c.toolModel ?? DEFAULT_TOOL_MODEL,
        instructions: BACKEND_INSTRUCTIONS, tools: toolDefinitions(), tool_choice: 'auto', reasoning: {effort: c.toolEffort ?? DEFAULT_TOOL_EFFORT}}}, store: false,
    }}];
  }
  audioIn(audio) { return [{type: 'session.input_audio.append', audio}]; }
  parse(event) {
    switch (event.type) {
      case 'session.closed': return [{type: 'closed', usage: event.usage, reason: event.reason}];
      case 'session.started': return [{type: 'ready', id: event.session.id}];
      case 'session.output_audio.delta':
        if (typeof event.delta !== 'string' || event.delta.length > 1000000) return [{type: 'fatal', reason: 'invalid_provider_audio'}];
        return [{type: 'audio', audio: event.delta}];
      // Output audio flows nonstop, silence included, so only the transcripts say who is speaking.
      case 'session.input_transcript.delta': return [{type: 'speech', who: 'caller'}];
      case 'session.output_transcript.delta': return [{type: 'speech', who: 'model'}];
      case 'response.event': {
        const item = event.event?.type === 'response.output_item.done' ? event.event.item : null;
        return item?.type === 'function_call' ? [{type: 'tool', id: item.call_id, name: item.name}] : [];
      }
      case 'session.delegation.created': {
        // Public phone callers have no owner identity, workspace or tool grants.
        const id = event.delegation?.id;
        return event.delegation?.target !== 'responses' && typeof id === 'string' ? [{type: 'send', message: {type: 'session.commentary.append', delegation_id: id,
          content: 'This is an audio-only phone call. No backend, tools, private information or actions are connected.'}}] : [];
      }
      case 'error': return [{type: 'error', code: typeof event.error?.code === 'string' ? event.error.code.slice(0, 100) : 'provider_error'}];
      default: return [];
    }
  }
  toolResult(id, name, output) {
    return [{type: 'response.item.create', item: {type: 'function_call_output', call_id: id, output: JSON.stringify(output)}}, {type: 'response.create'}];
  }
  closeMessages() { return [{type: 'session.close'}]; }
}
