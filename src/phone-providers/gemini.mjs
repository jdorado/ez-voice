import {toolDefinitions} from '../phone-tools.mjs';
import {ulawToPcm, pcmToUlaw, pcmBytes, pcmFromBytes, Upsampler, Downsampler, Framer} from './g711.mjs';

// Gemini Live (BidiGenerateContent). It takes 16-bit PCM at 16 kHz and answers with 16-bit PCM (24 kHz), never G.711, so the
// adapter converts both ways. The API key travels in the URL (the documented form): it must never reach a log or an error text.
const SOCKET_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Gemini rejects JSON Schema keywords it does not know; a tool without parameters declares none.
const declaration = (tool, model) => {
  const {name, description, parameters} = tool;
  const {additionalProperties, ...schema} = parameters ?? {};
  // gemini-3.8-live calls tools without waiting unless told to; the thinking variant only supports that mode.
  return {name, description, ...(Object.keys(schema.properties ?? {}).length ? {parameters: schema} : {}),
    ...(model.endsWith('-extended-thinking') ? {} : {behavior: 'BLOCKING'})};
};

export class GeminiAdapter {
  static id = 'gemini';
  static label = 'Gemini';
  static models = ['gemini-3.8-live', 'gemini-3.8-live-extended-thinking'];
  static defaultModel = 'gemini-3.8-live';
  static defaultVoice = 'Kore';
  // Google issues two key shapes: the classic AIza... and the newer AQ.... (the one Quarre's production key has).
  static keyPattern = /^(AIza[A-Za-z0-9_-]{30,60}|AQ\.[A-Za-z0-9_.-]{30,100})$/;
  static confirmsClose = false;
  static supportsTools() { return true; }

  constructor(config) {
    this.config = config;
    this.upsampler = new Upsampler(); this.framer = new Framer(); this.downsamplers = new Map(); this.carry = Buffer.alloc(0);
  }

  connection() { return {url: `${SOCKET_URL}?key=${encodeURIComponent(this.config.apiKey)}`, headers: {}}; }
  start() {
    const c = this.config;
    return [{setup: {model: `models/${c.model}`,
      generationConfig: {responseModalities: ['AUDIO'], speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: c.voice}}},
        // The thinking variant refuses a session without a level (close 1007); the plain model refuses one with it.
        ...(c.model.endsWith('-extended-thinking') ? {thinkingConfig: {thinkingLevel: c.thinking ?? 'low'}} : {})},
      systemInstruction: {parts: [{text: c.instructions}]},
      ...(c.tools === false ? {} : {tools: [{functionDeclarations: toolDefinitions().map(tool => declaration(tool, c.model))}]}),
      // Transcripts of both sides are what the idle hang-up and the receipt use to tell who is speaking.
      inputAudioTranscription: {}, outputAudioTranscription: {}}}];
  }
  audioIn(payload) {
    const samples = this.upsampler.push(ulawToPcm(Buffer.from(payload, 'base64')));
    return [{realtimeInput: {audio: {data: pcmBytes(samples).toString('base64'), mimeType: 'audio/pcm;rate=16000'}}}];
  }
  // PCM from the model (the sample rate is in its MIME type) down to 8 kHz mu-law in whole 20 ms frames.
  audioOut(part) {
    const rate = Number(/rate=(\d+)/.exec(part.mimeType ?? '')?.[1] ?? 24000);
    let down = this.downsamplers.get(rate);
    if (!down) { try { down = new Downsampler(rate); } catch { return null; } this.downsamplers.set(rate, down); }
    const {samples, carry} = pcmFromBytes(Buffer.from(part.data, 'base64'), this.carry); this.carry = carry;
    return this.framer.push(pcmToUlaw(down.push(samples)));
  }
  interrupt() { this.framer.reset(); this.carry = Buffer.alloc(0); for (const down of this.downsamplers.values()) down.reset(); }
  parse(message) {
    const items = [];
    if (message.setupComplete) items.push({type: 'ready', id: undefined});
    if (message.usageMetadata) this.usage = message.usageMetadata;
    const content = message.serverContent;
    if (content) {
      if (content.interrupted) { this.interrupt(); items.push({type: 'interrupted'}); }
      if (content.inputTranscription) items.push({type: 'speech', who: 'caller'});
      if (content.outputTranscription) items.push({type: 'speech', who: 'model'});
      for (const part of content.modelTurn?.parts ?? []) {
        if (typeof part.inlineData?.data !== 'string' || !String(part.inlineData.mimeType).startsWith('audio/pcm')) continue;
        if (part.inlineData.data.length > 1000000) { items.push({type: 'fatal', reason: 'invalid_provider_audio'}); continue; }
        const audio = this.audioOut(part.inlineData);
        if (audio === null) items.push({type: 'fatal', reason: 'unsupported_provider_audio'});
        else if (audio.length) items.push({type: 'audio', audio: audio.toString('base64')});
      }
      if (content.turnComplete) { for (const down of this.downsamplers.values()) down.reset(); const tail = this.framer.flush(); if (tail.length) items.push({type: 'audio', audio: tail.toString('base64')}); }
    }
    for (const call of message.toolCall?.functionCalls ?? []) items.push({type: 'tool', id: call.id, name: call.name});
    if (message.goAway) items.push({type: 'fatal', reason: 'provider_go_away'});
    return items;
  }
  // A final tool (end_call) gets no answer: with one, the model narrates it ("The call has ended") after its goodbye.
  toolResult(id, name, output, {final = false} = {}) {
    return final ? [] : [{toolResponse: {functionResponses: [{id, name, response: {result: output}}]}}];
  }
  // No close handshake: closing the socket ends the session. The last usage the model reported stands in for final usage.
  closeMessages() { return []; }
}
