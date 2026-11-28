import WebSocket from 'ws';
import {DeepgramAdapter} from './phone-providers/deepgram.mjs';

// A second listener on the caller's line beside a speech-to-speech session that sends the caller's words only once an utterance is
// finished (ElevenLabs Realtime): Deepgram Flux streaming speech-to-text, which gives the words as they come (interim), its predicted
// end of turn (eager) and the turn's final words. It only produces text, for the side coach's early note and the machine screen; it
// never feeds the speech session, and nothing it does ends the call (a sidecar that fails leaves the line as it would be without one).
export const SIDECAR_MODELS = ['flux-general-en'];
export const SIDECAR_KEY = DeepgramAdapter.keyPattern;
const SOCKET_URL = 'wss://api.deepgram.com/v2/listen';
const EAGER_EOT_THRESHOLD = 0.5; // eager end of turn on: Deepgram takes 0.3..0.9 and suggests starting at 0.5
const KINDS = {Update: 'interim', TurnResumed: 'interim', EagerEndOfTurn: 'eager', EndOfTurn: 'final'};
const QUEUE_BYTES = 64000; // caller audio held while the socket opens (8 s at 8 kB/s)

export class FluxSidecar {
  // `stats` is the receipt's `sidecar`: status (connecting, open, closed, failed), error (a code, never text) and how many texts came.
  constructor({apiKey, model, socketFactory, onText, stats}) {
    Object.assign(this, {onText, stats, queued: [], queuedBytes: 0});
    stats.status = 'connecting';
    const query = new URLSearchParams({model, encoding: 'mulaw', sample_rate: '8000', eager_eot_threshold: String(EAGER_EOT_THRESHOLD)});
    this.socket = socketFactory(`${SOCKET_URL}?${query}`, {headers: {Authorization: `Token ${apiKey}`}, maxPayload: 1024 * 1024});
    this.socket.on('open', () => {
      stats.status = 'open';
      for (const chunk of this.queued.splice(0)) this.socket.send(chunk);
      this.queuedBytes = 0;
    });
    this.socket.on('message', (raw, binary) => { if (!binary) try { this.event(JSON.parse(raw.toString())); } catch { stats.error ??= 'invalid_event'; } });
    this.socket.on('error', () => { stats.status = 'failed'; stats.error ??= 'connection_failed'; });
    this.socket.on('unexpected-response', (_request, response) => { stats.error ??= Number.isInteger(response.statusCode) ? `HTTP_${response.statusCode}` : 'upgrade_failed'; response.resume(); });
    this.socket.on('close', code => {
      if (stats.status !== 'failed') stats.status = this.closing ? 'closed' : 'failed';
      if (!this.closing && Number.isInteger(code) && ![1000, 1005].includes(code)) stats.error ??= `WS_${code}`;
    });
  }
  // One Twilio frame of the caller as heard (base64 mu-law 8 kHz).
  audio(payload) {
    if (this.closing) return;
    const chunk = Buffer.from(payload, 'base64');
    if (this.socket.readyState === WebSocket.OPEN) { if (this.socket.bufferedAmount < 256000) this.socket.send(chunk); }
    else if (this.socket.readyState === WebSocket.CONNECTING && this.queuedBytes + chunk.length <= QUEUE_BYTES) { this.queued.push(chunk); this.queuedBytes += chunk.length; }
  }
  event(event) {
    if (event?.type === 'Error') { this.stats.error ??= typeof event.code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(event.code) ? event.code : 'provider_error'; return; }
    const kind = event?.type === 'TurnInfo' && KINDS[event.event];
    const text = kind && typeof event.transcript === 'string' && event.transcript.length <= 20000 ? event.transcript.trim() : '';
    if (!text) return;
    this.stats[kind] = (this.stats[kind] ?? 0) + 1;
    this.onText({kind, text});
  }
  close() {
    if (this.closing) return;
    this.closing = true;
    if (this.socket.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify({type: 'CloseStream'})); this.socket.close(); }
    else this.socket.terminate?.();
  }
}
