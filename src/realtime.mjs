import WebSocket from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { applicationCall, runApplication } from '@jc_stack/ez-agents/application-client';
import { text } from './protocol.mjs';

const BASE = 'https://api.openai.com/v1/live/sessions';
const id = prefix => prefix + randomUUID().replaceAll('-', '');
const boundedResult = value => {
  const result = String(value).trim();
  if (!result) return 'The backend completed without a result.';
  return result.length <= 1600 ? result : result.slice(0, 1550) + '\n[Result shortened for voice.]';
};

export class RealtimeSession {
  constructor(config, emit, _execute, { fetchImpl = fetch, socketFactory = (url, options) => new WebSocket(url, options), observe = () => {}, runAgent = runApplication, cancelAgent = (runId, connection) => applicationCall(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {}, connection) } = {}) {
    this.config = config; this.emit = emit; this.fetch = fetchImpl; this.socketFactory = socketFactory;
    this.observe = observe; this.runAgent = runAgent; this.cancelAgent = cancelAgent;
    this.id = randomUUID(); this.delegations = new Map(); this.fragments = []; this.closed = false;
    this.controllers = new Set(); this.finalized = false;
  }
  async start({ sdp, instructions = '', history = [] }) {
    text(sdp, 100000); text(instructions, 8000);
    if (!sdp.startsWith('v=0')) throw new Error('Invalid SDP offer');
    if (!this.config.apiKey) throw new Error('Configure an OpenAI API key first');
    if (!this.config.agentUrl || !this.config.agentToken) throw new Error('Configure the native Ez agent backend first');
    const input = history.map(message => ({
      type: 'message', role: message.role,
      content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.text }],
    }));
    this.fragments = history.map(message => ({ role: message.role, delta: message.text, start: 0, end: 0 }));
    const body = {
      session: {
        model: 'gpt-live-1', instructions,
        audio: { output: { voice: this.config.voice || 'marin' } },
        delegation: { type: 'client' },
        ...(input.length ? { input } : {}),
      },
      transport: { type: 'webrtc', sdp },
    };
    this.creation = (async () => {
      const response = await this.fetch(BASE, {
        method: 'POST', headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`OpenAI session creation failed (${response.status})`);
      const raw = await response.text();
      if (raw.length > 220000) throw new Error('OpenAI session response too large');
      let result; try { result = JSON.parse(raw); } catch { throw new Error('Invalid OpenAI Live session response'); }
      if (typeof result?.session?.id !== 'string' || !result.session.id || result.session.id.length > 200 || result.session.id.includes('\0') ||
          result?.transport?.type !== 'webrtc' ||
          typeof result.transport.sdp !== 'string' || !result.transport.sdp.startsWith('v=0') || result.transport.sdp.length > 100000)
        throw new Error('Invalid OpenAI Live session response');
      this.providerId = result.session.id;
      return result;
    })();
    const result = await this.creation;
    try {
      await this.attach();
      if (this.closed) {
        const stopped = await this.finishProvider();
        throw new Error(stopped ? 'Session closed during startup' : 'Session closed during startup; provider finalization unconfirmed');
      }
      this.timer = setTimeout(() => void this.stop('duration_limit'), 20 * 60 * 1000);
      this.emit({ type: 'connected', sessionId: this.id, providerSessionId: this.providerId, resumedMessages: history.length });
      return { sessionId: this.id, sdp: result.transport.sdp, model: 'gpt-live-1', resumedMessages: history.length };
    } catch (error) {
      const stopped = await this.stop('startup_failed');
      if (!stopped.hangupConfirmed && !/finalization unconfirmed/.test(error.message)) throw new Error(`${error.message}; provider finalization unconfirmed`);
      throw error;
    }
  }
  async attach() {
    if (this.attachPromise) return this.attachPromise;
    this.attachPromise = this.openAttachment();
    return this.attachPromise;
  }
  async openAttachment() {
    this.socket = this.socketFactory(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(this.providerId)}/attach`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` }, maxPayload: 1024 * 1024,
    });
    this.socket.on('message', raw => {
      try { this.onEvent(JSON.parse(raw.toString())); }
      catch { this.emit({ type: 'error', message: 'Invalid provider event' }); }
    });
    this.socket.on('error', () => { this.emit({ type: 'error', message: 'Voice control connection failed' }); });
    this.socket.on('close', () => {
      if (!this.finalized && !this.closed) void this.stop('control_disconnected');
      this.finishClosed?.(false);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Voice control connection timed out')), 10000);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', () => { clearTimeout(timer); reject(new Error('Voice control connection failed')); });
      this.socket.once('close', () => { clearTimeout(timer); reject(new Error('Voice control connection closed')); });
    });
  }
  send(event) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(event)); return true;
  }
  transcript() {
    const rows = [];
    for (const fragment of this.fragments) {
      const previous = rows.at(-1);
      if (previous?.role === fragment.role) previous.text += fragment.delta;
      else rows.push({ role: fragment.role, text: fragment.delta });
    }
    const value = rows.map(row => `${row.role === 'user' ? 'Owner' : 'Voice'}: ${row.text}`).join('\n');
    return value.length <= 12000 ? value : value.slice(-12000);
  }
  onEvent(event) {
    if (event.type === 'session.closed') {
      this.finalized = true; this.finalUsage = event.usage; this.finishClosed?.(true);
      if (!this.closed) void this.stop(event.reason || 'provider_closed');
      return;
    }
    if (this.closed) return;
    if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      const role = event.type.includes('input_') ? 'user' : 'assistant';
      if (typeof event.delta === 'string' && Number.isFinite(event.start_ms) && Number.isFinite(event.end_ms)) {
        this.fragments.push({ role, delta: event.delta, start: event.start_ms, end: event.end_ms });
        let size = this.fragments.reduce((n, item) => n + item.delta.length, 0);
        while (size > 16000 && this.fragments.length) size -= this.fragments.shift().delta.length;
        this.observe(event);
      }
    }
    if (event.type === 'session.delegation.created') this.handleDelegation(event);
    if (event.type === 'session.usage.updated') this.emit({ type: 'usage', usage: event.usage });
    if (event.type === 'error') this.emit({ type: 'error', message: 'Provider rejected a session command', code: event.error?.code });
  }
  handleDelegation(event) {
    const delegationId = event.delegation?.id;
    if (event.delegation?.target !== 'client' || !/^[A-Za-z0-9_-]{1,200}$/.test(delegationId || '') || this.delegations.has(delegationId)) return;
    if (this.delegations.size >= 100) { void this.stop('delegation_limit'); return; }
    const controller = new AbortController(); this.controllers.add(controller);
    const requestId = 'voice-' + createHash('sha256').update(JSON.stringify([this.id, delegationId])).digest('hex').slice(0, 48);
    const prompt = `Live voice transcript (fragments can overlap and contain recognition errors):\n${this.transcript()}\n\nHandle the owner's latest delegated request. Use the native agent's workspace, tools, permissions, and confirmation rules. Return concise verified facts, completion state, and the next needed step for the voice frontend. Do not claim an external action succeeded without its receipt.`;
    const state = { controller, runId: undefined, terminal: false }; this.delegations.set(delegationId, state);
    this.emit({ type: 'delegation_started', delegationId });
    state.promise = this.runAgent({ requestId, scope: 'voice', text: prompt }, {
      url: this.config.agentUrl, token: this.config.agentToken, signal: controller.signal,
      fetchImpl: this.fetch, onAdmitted: runId => { state.runId = runId; },
    }).then(result => {
      state.terminal = true;
      if (this.closed) return;
      this.send({ type: 'session.commentary.append', event_id: id('result_'), delegation_id: delegationId, content: boundedResult(result.reply) });
      this.emit({ type: 'delegation_completed', delegationId, runId: result.runId });
    }).catch(() => {
      state.terminal = true;
      if (this.closed || controller.signal.aborted) return;
      this.send({ type: 'session.commentary.append', event_id: id('error_'), delegation_id: delegationId, content: 'The native agent could not complete that request. Ask the owner to try again or continue with a different question.' });
      this.emit({ type: 'error', message: 'Native agent delegation failed' });
    }).finally(() => this.controllers.delete(controller));
  }
  async finishProvider() {
    if (this.finalized || !this.providerId) return true;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; clearTimeout(timer); this.finishClosed = undefined; resolve(value); };
      this.finishClosed = finish;
      const timer = setTimeout(() => finish(false), 15000);
      if (!this.send({ type: 'session.close', event_id: id('close_') })) finish(false);
    });
  }
  stop(reason = 'ended') {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true; clearTimeout(this.timer);
    this.stopPromise = (async () => {
      await this.creation?.catch(() => {});
      if (this.providerId && !this.socket) await this.attach().catch(() => {});
      const cancellations = [];
      for (const state of this.delegations.values()) {
        state.controller.abort();
        if (state.runId && !state.terminal) cancellations.push(this.cancelAgent(state.runId, {
          url: this.config.agentUrl, token: this.config.agentToken,
          fetchImpl: this.fetch, signal: AbortSignal.timeout(10_000),
        }).catch(() => null));
      }
      await Promise.allSettled(cancellations);
      const hangupConfirmed = await this.finishProvider();
      this.socket?.close();
      const result = this.stopResult = { reason, hangupConfirmed };
      this.emit({ type: 'closed', ...result });
      return result;
    })();
    return this.stopPromise;
  }
}
