import {createServer} from 'node:http';
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {WebSocketServer} from 'ws';
import {PhoneAudio} from './phone-audio.mjs';

const sid = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}[a-fA-F0-9]{32}$`).test(value);
const phone = value => typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
const DEFAULT_INSTRUCTIONS = 'You are a friendly AI assistant on a phone audio test. Say hello, identify yourself as an AI, and have a short conversation. You have no private context, tools or ability to take actions.';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
async function save(path, value) {
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  await writeFile(temp, JSON.stringify(value), {mode: 0o600, flag: 'wx'}); await rename(temp, path);
}
export function validatePhoneConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(k => !['apiKey','accountSid','authToken','number','origin','instructions'].includes(k))) throw Error('Invalid phone configuration fields');
  if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(config.apiKey || '') || !sid(config.accountSid, 'AC') ||
      !/^[a-fA-F0-9]{32}$/.test(config.authToken || '') || !phone(config.number)) throw Error('Supply the OpenAI key, Twilio account auth token and configured E.164 number privately');
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('Use an HTTPS origin without a path');
  const instructions = config.instructions ?? DEFAULT_INSTRUCTIONS;
  if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 4000) throw Error('Phone instructions must contain 1..4000 characters');
  return {...config, origin: origin.origin, instructions};
}
export function twilioSignature(token, url, params = new URLSearchParams()) {
  let data = url;
  for (const key of [...new Set(params.keys())].sort()) for (const value of [...new Set(params.getAll(key))].sort()) data += key + value;
  return createHmac('sha1', token).update(data).digest('base64');
}
function authentic(config, signature, path, params) {
  if (typeof signature !== 'string' || signature.length > 100) return false;
  // Twilio's HTTP upgrade signature uses its externally visible URL. Accept
  // either spelling of that fixed TLS endpoint, never request-supplied Host.
  return [config.origin + path, ...(path === '/media' ? [config.origin.replace('https:', 'wss:') + path] : [])].some(url => {
    const expected = Buffer.from(twilioSignature(config.authToken, url, params)); const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}
async function body(request) {
  let value = ''; for await (const chunk of request) { value += chunk; if (Buffer.byteLength(value) > 32000) throw Error('Request too large'); }
  return value;
}
const routeFields = number => ({VoiceUrl: number.voice_url || '', VoiceMethod: number.voice_method || 'POST',
  VoiceFallbackUrl: number.voice_fallback_url || '', VoiceFallbackMethod: number.voice_fallback_method || 'POST',
  VoiceApplicationSid: number.voice_application_sid || '', TrunkSid: number.trunk_sid || ''});
export class PhoneNumber {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; this.root = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}`; }
  async request(path, form) {
    const response = await this.fetch(this.root + path, {method: form ? 'POST' : 'GET', redirect: 'error',
      headers: {Authorization: 'Basic ' + Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64'),
        ...(form ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})},
      ...(form ? {body: new URLSearchParams(form).toString()} : {}), signal: AbortSignal.timeout(12000)});
    if (!response.ok) throw Error(`Twilio phone request failed (HTTP ${response.status}); inspect routing before retrying`);
    const value = await response.text(); if (value.length > 100000) throw Error('Phone response too large');
    return JSON.parse(value);
  }
  async get() {
    const result = await this.request('/IncomingPhoneNumbers.json?' + new URLSearchParams({PhoneNumber: this.config.number, PageSize: '20'}));
    const row = result.incoming_phone_numbers?.find(row => row.phone_number === this.config.number && row.account_sid === this.config.accountSid);
    if (!row || !sid(row.sid, 'PN') || row.capabilities?.voice !== true) throw Error('Configured number is not voice-capable in this Twilio account');
    return {numberSid: row.sid, number: row.phone_number, route: routeFields(row)};
  }
  async set(numberSid, form) {
    if (!sid(numberSid, 'PN')) throw Error('Invalid phone number SID');
    await this.request(`/IncomingPhoneNumbers/${numberSid}.json`, form);
  }
}
export async function phoneRoute(directory, config, command, {provider = new PhoneNumber(config)} = {}) {
  const current = await provider.get(), receiptPath = join(directory, 'route.json');
  const prior = await read(receiptPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (command === 'status') return {...current, receipt: prior};
  const target = command === 'restore' ? prior?.before : {VoiceUrl: config.origin + '/incoming', VoiceMethod: 'POST',
    VoiceFallbackUrl: '', VoiceFallbackMethod: 'POST', VoiceApplicationSid: '', TrunkSid: ''};
  if (command === 'preview') return {...current, target};
  if (command === 'restore' && (!prior || prior.numberSid !== current.numberSid || !['applied','uncertain'].includes(prior.state))) throw Error('No matching active phone route receipt to restore');
  if (command === 'restore' && JSON.stringify(current.route) !== JSON.stringify(prior.target)) throw Error('Phone routing changed outside this POC; refusing to overwrite it');
  if (command === 'route' && prior && prior.state !== 'restored') throw Error('A phone route receipt already exists; inspect status and restore it first');
  const receipt = {numberSid: current.numberSid, number: current.number, before: current.route, target, state: 'uncertain', at: new Date().toISOString()};
  // Save recovery information before making the external write. Never redial or
  // automatically retry a provider operation after an ambiguous response.
  await save(receiptPath, {...receipt, ...(command === 'restore' ? {before: prior.before, target: prior.target, state: 'restore_uncertain'} : {})});
  await provider.set(current.numberSid, target);
  const observed = await provider.get();
  if (JSON.stringify(observed.route) !== JSON.stringify(target)) throw Error('Twilio phone routing readback does not match; inspect status');
  const final = command === 'restore' ? {...prior, state: 'restored'} : {...receipt, state: 'applied'};
  await save(receiptPath, final); return {...observed, receipt: final};
}

export async function servePhone(config, {port = 8080, host = '0.0.0.0', record = async () => {}, socketFactory} = {}) {
  const tickets = new Map(); let active, admitted = 0, expired = false;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (request.method === 'GET' && request.url === '/health') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({ready: !expired, active: Boolean(active), admitted, model: 'gpt-live-1'})); }
      if (request.method !== 'POST' || request.url !== '/incoming' || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) { response.writeHead(404); return response.end(); }
      const params = new URLSearchParams(await body(request));
      if (!authentic(config, request.headers['x-twilio-signature'], '/incoming', params) || params.get('AccountSid') !== config.accountSid || params.get('To') !== config.number || !sid(params.get('CallSid'), 'CA')) { response.writeHead(403); return response.end(); }
      response.setHeader('Content-Type', 'text/xml');
      for (const [token, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(token);
      if (expired || active || tickets.size || admitted >= 5) return response.end('<Response><Reject reason="busy"/></Response>');
      const token = randomBytes(32).toString('hex');
      tickets.set(token, {callSid: params.get('CallSid'), expires: Date.now() + 60000});
      response.end(`<Response><Connect><Stream url="${config.origin.replace('https:', 'wss:')}/media"><Parameter name="ticket" value="${token}"/></Stream></Connect><Hangup/></Response>`);
    } catch { response.writeHead(400); response.end(); }
  });
  const sockets = new WebSocketServer({noServer: true, maxPayload: 32000});
  server.on('upgrade', (request, socket, head) => {
    if (expired || active || request.url !== '/media' || !authentic(config, request.headers['x-twilio-signature'], '/media')) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    let bridge, started = false;
    const timeout = setTimeout(() => ws.close(), 10000);
    ws.on('error', () => bridge?.close('twilio_connection_failed'));
    ws.on('close', () => { clearTimeout(timeout); bridge?.close(); });
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.event === 'connected') return;
        if (message.event === 'start' && !started) {
          started = true; clearTimeout(timeout);
          const start = message.start, ticket = tickets.get(start?.customParameters?.ticket);
          if (!ticket || ticket.expires < Date.now() || ticket.callSid !== start.callSid || start.accountSid !== config.accountSid ||
              active || !sid(start.streamSid, 'MZ') || start.mediaFormat?.encoding !== 'audio/x-mulaw' || start.mediaFormat?.sampleRate !== 8000 || start.mediaFormat?.channels !== 1) return ws.close();
          tickets.delete(start.customParameters.ticket); admitted++;
          bridge = new PhoneAudio(ws, {...config, streamSid: start.streamSid}, stats => {
            if (active === bridge) active = undefined;
            void record({callSid: start.callSid, ...stats, at: new Date().toISOString()});
          }, {socketFactory}); active = bridge;
        } else if (message.event === 'media' && bridge) bridge.input(message.media?.payload);
        else if (message.event === 'stop') bridge?.close();
      } catch { ws.close(); bridge?.close('invalid_twilio_event'); }
    });
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port, host, resolve); });
  const expiry = setTimeout(() => { expired = true; active?.close('poc_expired'); }, 30 * 60000); expiry.unref();
  return {port: server.address().port, close: async () => {
    expired = true; clearTimeout(expiry); active?.close('service_stopped');
    for (const ws of sockets.clients) ws.close(); sockets.close();
    await new Promise(resolve => server.close(resolve));
  }};
}

export async function phoneCommand(state, args, {stdin = process.stdin} = {}) {
  const directory = join(state, 'phone'); await mkdir(directory, {recursive: true, mode: 0o700});
  const path = join(directory, 'config.json'), [command, ...rest] = args;
  if (rest.length) throw Error('Phone commands accept no flags; credentials and configuration use private stdin');
  if (!command || command === '--help') return {commands: ['phone configure < private-phone.json', 'phone doctor', 'phone probe', 'phone preview',
    'phone route', 'phone status', 'phone restore', 'phone receipt', 'tools serve 8793:8080 voice phone serve'],
    configuration: {required: ['apiKey','accountSid','authToken','number','origin'], optional: ['instructions']},
    limits: 'Direct Twilio Media Streams to gpt-live-1; no native tools, history, recording or Retell/Vapi; 5 inbound calls, 3 minutes each, 30-minute window',
    routing: 'preview is read-only; route saves the prior voice route before changing it; status reads Twilio; restore refuses unrelated route changes; SMS routing is never updated'};
  if (command === 'configure') {
    let raw = ''; for await (const chunk of stdin) { raw += chunk; if (raw.length > 16000) throw Error('Phone configuration too large'); }
    const config = validatePhoneConfig(JSON.parse(raw)); await save(path, config);
    return {configured: true, model: 'gpt-live-1', origin: config.origin, number: config.number};
  }
  const config = validatePhoneConfig(await read(path));
  if (command === 'doctor') return {configured: true, model: 'gpt-live-1', origin: config.origin, number: config.number, nativeTools: false, liveVerified: false};
  if (command === 'probe') {
    const result = await new Promise(resolve => {
      const audio = new PhoneAudio({readyState: 1, close() {}, send() {}}, config, resolve, {onReady: () => audio.close('probe_complete')});
    });
    if (!result.ready || !result.finalized) throw Error(`Direct GPT-Live audio probe failed (${result.providerError || result.reason || 'unconfirmed finalization'})`);
    return {model: 'gpt-live-1', audio: 'pcmu/8000', ready: true, finalized: true, usage: result.usage, phoneCallVerified: false};
  }
  if (['preview','route','restore','status'].includes(command)) return phoneRoute(directory, config, command);
  if (command === 'serve') {
    const web = await servePhone(config, {record: value => save(join(directory, 'last-call.json'), value)});
    console.log(JSON.stringify({web: {url: config.origin, model: 'gpt-live-1', limits: '5 inbound calls; 3 minutes each; 30-minute test window', nativeTools: false}}));
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => void web.close().then(() => process.exit(0)));
    return;
  }
  if (command === 'receipt') return read(join(directory, 'last-call.json'));
  throw Error('Use phone configure|doctor|probe|preview|route|status|restore|serve|receipt');
}
