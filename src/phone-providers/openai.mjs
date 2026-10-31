import {randomBytes} from 'node:crypto';
import {toolDefinitions, backendInstructions, DEFAULT_TOOL_MODEL, DEFAULT_TOOL_EFFORT} from '../phone-tools.mjs';
import {words} from './transcript.mjs';

// Live must be told when to delegate; registering tools on its Responses backend
// alone does not expose them to the voice model. This is provider capability wiring.
const endCallDelegation = '- The caller asks you to hang up, the conversation has finished, you have said goodbye, or you have left a voicemail message. Ask the backend to run end_call as soon as your goodbye is said: a goodbye that is not followed by end_call leaves the line open.';
const delegationPolicy = (lookup, information) => `Delegation policy:
Backend tools:
- end_call: hang up this phone call after your goodbye.${lookup ? `
- find_case: look up whether we have a conversation on record about a property address the caller named.` : ''}${information ? '\n' + information.tools.map(t => '- ' + t.name + ': ' + t.description).join('\n') : ''}
Generate <|SpawnThinking|> when:
${endCallDelegation}${information ? `
- The request needs a listed backend capability or facts missing from the supplied context. Ask the backend to use the appropriate listed tools; never substitute a guess for a read.` : lookup ? `
- The caller names a property address and you need to know whether a conversation is on record. Ask the backend to run find_case with that address.` : ''}
Do not generate <|SpawnThinking|> when:
- Having ordinary conversation, answering from already supplied current information, or asking a brief clarification.
Generate <|SpawnThinking|> before giving an answer that depends on backend work. Wait for the result and say plainly when it is unavailable.`;

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
  static audioMeansSpeech = false; // GPT-Live streams output audio nonstop, silence included
  static maxAdviceNote = 1800; // an append takes at most 500 tokens
  static supportsTools() { return true; }

  constructor(config) { this.config = config; }
  // A side-coach note as trusted application instructions for the session
  // (https://developers.openai.com/api/docs/guides/live-conversations). Thinking context cost end_call delegation in
  // real-provider runs (0 of 6 hang-ups against 4 of 6); an instruction can interrupt speech, so it goes in only in a
  // quiet moment (src/phone-audio.mjs).
  adviceMessages(note) { return [{type: 'session.instructions.append', event_id: `adv_${randomBytes(12).toString('hex')}`, delegation_id: null, content: note}]; }

  connection() {
    return {url: 'wss://api.openai.com/v1/live/sessions', headers: {Authorization: `Bearer ${this.config.apiKey}`}};
  }
  start() {
    const c = this.config;
    return [{type: 'session.start', session: {
      model: c.model, instructions: c.tools === false ? c.instructions : `${c.instructions}\n\n${delegationPolicy(c.lookup, c.information)}`,
      audio: {format: {type: 'audio/pcmu', rate: 8000}, output: {voice: c.voice}},
      delegation: c.tools === false ? {type: 'client'} : {type: 'responses', responses: {model: c.toolModel ?? DEFAULT_TOOL_MODEL,
        instructions: backendInstructions(c), tools: toolDefinitions(c), tool_choice: 'auto', parallel_tool_calls: false, reasoning: {effort: c.toolEffort ?? DEFAULT_TOOL_EFFORT}}}, store: false,
    }}];
  }
  // The model speaks first: a response with no caller turn yet is the greeting (verified live with Responses delegation).
  // A client-delegation session (tools false) is not verified to accept it: it gets no greeting request, and the ring
  // stops RING_AFTER_READY_MS after the session is ready.
  greet() { return this.config.tools === false ? [] : [{type: 'response.create'}]; }
  audioIn(audio) { return [{type: 'session.input_audio.append', audio}]; }
  parse(event) {
    switch (event.type) {
      case 'session.closed': return [{type: 'closed', usage: event.usage, reason: event.reason}];
      case 'session.started': return [{type: 'ready', id: event.session.id}];
      case 'session.output_audio.delta':
        if (typeof event.delta !== 'string' || event.delta.length > 1000000) return [{type: 'fatal', reason: 'invalid_provider_audio'}];
        return [{type: 'audio', audio: event.delta}];
      // Output audio flows nonstop, silence included, so only the transcripts say who is speaking.
      case 'session.input_transcript.delta': return [{type: 'speech', who: 'caller', delta: words(event.delta)}];
      case 'session.output_transcript.delta': return [{type: 'speech', who: 'model', delta: words(event.delta)}];
      case 'session.instructions.appended': return [{type: 'advice_ack'}];
      case 'session.delegation.cancelled': return [{type: 'cancelled', request: event.delegation_id ?? event.delegation?.id}];
      case 'response.event': {
        if (event.event?.type === 'response.done' && ['cancelled','failed'].includes(event.event.response?.status)) return [{type: 'cancelled', request: event.delegation_id}];
        const item = event.event?.type === 'response.output_item.done' ? event.event.item : null;
        return item?.type === 'function_call' ? [{type: 'tool', id: item.call_id, name: item.name, args: item.arguments, request: event.delegation_id}] : [];
      }
      case 'session.delegation.created': {
        // Public phone callers have no owner identity, workspace or tool grants.
        const id = event.delegation?.id;
        if (event.delegation?.target === 'responses' && typeof id === 'string') return [{type: 'turn', request: id}];
        return event.delegation?.target !== 'responses' && typeof id === 'string' ? [{type: 'send', message: {type: 'session.commentary.append', delegation_id: id,
          content: 'This is an audio-only phone call. No backend tool or action is connected; answer from your instructions.'}}] : [];
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
