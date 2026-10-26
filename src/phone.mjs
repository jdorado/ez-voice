import {createServer} from 'node:http';
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {WebSocketServer} from 'ws';
import {DatabaseSync} from 'node:sqlite';
import {PhoneAudio} from './phone-audio.mjs';

import {PhoneNumber, sid, phone} from './phone-provider.mjs';
import {PhoneCalls, callOptions, servePhoneControl, phoneControl, LAST_CALL} from './phone-calls.mjs';
const DEFAULT_INSTRUCTIONS = 'You are a friendly AI assistant on a phone call. Say hello, identify yourself as an AI, and have a short conversation. You have no private context, tools or ability to take actions.';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
async function save(path, value) {
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
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


export async function phoneRoute(directory, config, command, {provider = new PhoneNumber(config)} = {}) {
  if (['preview','status'].includes(command)) return routeOperation(directory, config, command, provider);
  const lock = new DatabaseSync(join(directory, 'route-lock.sqlite'), {timeout: 0});
  try { lock.exec('BEGIN EXCLUSIVE'); } catch { lock.close(); throw Error('A phone route operation is already in progress'); }
  try { return await routeOperation(directory, config, command, provider); }
  finally { lock.exec('ROLLBACK'); lock.close(); }
}
async function routeOperation(directory, config, command, provider) {
  const current = await provider.get(), receiptPath = join(directory, 'route.json');
  const prior = await read(receiptPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (command === 'status') return {...current, receipt: prior};
  if (command === 'restore' && ['uncertain','restore_uncertain'].includes(prior?.state) && prior.numberSid === current.numberSid && JSON.stringify(current.route) === JSON.stringify(prior.before)) {
    const reconciled = {...prior, state: 'restored'}; await save(receiptPath, reconciled);
    return {...current, receipt: reconciled};
  }
  const target = command === 'restore' ? prior?.before : {VoiceUrl: config.origin + '/incoming', VoiceMethod: 'POST',
    VoiceFallbackUrl: '', VoiceFallbackMethod: 'POST', VoiceApplicationSid: '', TrunkSid: ''};
  if (command === 'preview') return {...current, target};
  if (command === 'restore' && (!prior || prior.numberSid !== current.numberSid || !['applied','uncertain','restore_uncertain'].includes(prior.state))) throw Error('No matching active phone route receipt to restore');
  if (command === 'restore' && JSON.stringify(current.route) !== JSON.stringify(prior.target)) throw Error('Phone routing changed outside Voice; refusing to overwrite it');
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

// One attempt per admitted call, never awaited by the audio path. The receipt keeps only a SID or a code.
const startRecording = (provider, callSid) => Promise.resolve().then(() => provider.startRecording(callSid)).then(
  recording => ({state: 'started', sid: recording.sid}),
  error => ({state: 'failed', code: Number.isInteger(error?.status) ? `HTTP_${error.status}` : 'ERROR'}));

export async function servePhone(config, {port = 8080, host = '0.0.0.0', record = async () => {}, socketFactory, calls, provider = new PhoneNumber(config)} = {}) {
  const tickets = new Map(); let active, admitted = 0, unavailable = false, receiptError = false, closing;
  const pruneTickets=()=>{for(const [token,ticket] of tickets)if(ticket.expires<Date.now())tickets.delete(token);};
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (request.method === 'GET' && request.url === '/health') { response.statusCode = unavailable ? 503 : 200; response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({ready: !unavailable, active: Boolean(active), admitted, model: 'gpt-live-1', ...(calls && {outboundPending:Boolean(calls.pending())})})); }
      const url=new URL(request.url,config.origin);
      if (request.method !== 'POST' || url.origin!==config.origin || url.pathname!=='/incoming' || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) { response.writeHead(404); return response.end(); }
      const params = new URLSearchParams(await body(request));
      if (!authentic(config, request.headers['x-twilio-signature'], request.url, params) || params.get('AccountSid') !== config.accountSid || !sid(params.get('CallSid'), 'CA')) { response.writeHead(403); return response.end(); }
      const outbound=url.searchParams.get('outbound'), isStatus=url.searchParams.get('status')==='1';
      if (outbound) {
        if (!calls || [...url.searchParams.keys()].some(key=>!['outbound','status'].includes(key)) || [...url.searchParams.keys()].length!==(isStatus?2:1) || !calls.accept(outbound,params,isStatus)) { response.writeHead(403); return response.end(); }
        if (isStatus) { response.writeHead(204);return response.end(); }
      } else if (url.search || params.get('To')!==config.number) { response.writeHead(403);return response.end(); }
      response.setHeader('Content-Type', 'text/xml');
      pruneTickets();
      const existing = [...tickets].find(([, ticket]) => ticket.callSid === params.get('CallSid'))?.[0];
      if (unavailable || active || (!existing && tickets.size) || (!outbound && calls?.pending())) return response.end('<Response><Reject reason="busy"/></Response>');
      const token = existing || randomBytes(32).toString('hex');
      tickets.set(token, {callSid: params.get('CallSid'), expires: Date.now() + 60000});
      response.end(`<Response><Connect><Stream url="${config.origin.replace('https:', 'wss:')}/media"><Parameter name="ticket" value="${token}"/></Stream></Connect><Hangup/></Response>`);
    } catch { response.writeHead(400); response.end(); }
  });
  const sockets = new WebSocketServer({noServer: true, maxPayload: 32000});
  server.on('upgrade', (request, socket, head) => {
    if (unavailable || active || request.url !== '/media' || !authentic(config, request.headers['x-twilio-signature'], '/media')) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    let bridge, recording, started = false;
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
          bridge = new PhoneAudio(ws, {...config, streamSid: start.streamSid}, async stats => {
            try { await record({callSid: start.callSid, ...stats, recording: await recording, at: new Date().toISOString()}); }
            catch (error) { unavailable = true; receiptError = true; throw error; }
            finally { if (active === bridge) active = undefined; }
          }, {socketFactory}); active = bridge;
          recording = startRecording(provider, start.callSid);
        } else if (message.event === 'media' && bridge) bridge.input(message.media?.payload);
        else if (message.event === 'stop') bridge?.close();
      } catch { ws.close(); bridge?.close('invalid_twilio_event'); }
    });
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port, host, resolve); });
  return {port: server.address().port, busy:()=>{pruneTickets();return unavailable || Boolean(active) || tickets.size>0;}, close: () => closing ??= (async () => {
    unavailable = true;
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await active?.close('service_stopped');
    for (const ws of sockets.clients) ws.terminate(); sockets.close();
    await stopped;
    if (receiptError) throw Error('Phone call receipt could not be persisted');
  })()};
}

export async function phoneCommand(state, args, {stdin = process.stdin} = {}) {
  const directory = join(state, 'phone');
  const path = join(directory, 'config.json'), [command, ...rest] = args;
  if (['call','call-status','hangup'].includes(command)) return phoneControl(directory,command,callOptions(command,rest));
  if (rest.length) throw Error('Only call, call-status and hangup accept flags; credentials and configuration use private stdin');
  if (!command || command === '--help') return {commands: ['phone configure < private-phone.json', 'phone doctor', 'phone probe', 'phone preview',
    'phone route', 'phone status', 'phone restore', 'phone receipt', 'phone call --to +15551230002 --request-id UNIQUE_ID',
    'phone call-status --request-id ID', 'phone hangup --request-id ID', 'tools serve 8793:8080 voice phone serve'],
    configuration: {required: ['apiKey','accountSid','authToken','number','origin'], optional: ['instructions']},
    limits: 'Direct Twilio Media Streams to gpt-live-1; no native tools, history or Retell/Vapi; every call is recorded at Twilio (dual-channel, retrievable by Call SID through the account) and this plugin stores no audio; the operator is responsible for any recording notice to callers; one call at a time, 3 minutes each; listener stays available until stopped',
    outbound: 'Requires the running phone service and owner-authorized recipient; caller ID is the configured number. Reuse the same request ID to inspect an attempt without redialing. Never automatically retry an uncertain creation.',
    routing: 'preview is read-only; route saves the prior voice route before changing it; status reads Twilio; restore refuses unrelated route changes; SMS routing is never updated'};
  if (command === 'configure') {
    let raw = ''; for await (const chunk of stdin) { raw += chunk; if (raw.length > 16000) throw Error('Phone configuration too large'); }
    const config = validatePhoneConfig(JSON.parse(raw));
    await mkdir(directory, {recursive: true, mode: 0o700}); await save(path, config);
    return {configured: true, model: 'gpt-live-1', origin: config.origin, number: config.number};
  }
  const stored = await read(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stored && command === 'doctor') return {configured: false, model: 'gpt-live-1', nativeTools: false, liveVerified: false};
  if (!stored) throw Error('Phone is not configured; use phone configure with private stdin');
  const config = validatePhoneConfig(stored);
  if (command === 'doctor') return {configured: true, model: 'gpt-live-1', origin: config.origin, number: config.number, outbound: true, nativeTools: false, liveVerified: false};
  if (command === 'probe') {
    const result = await new Promise(resolve => {
      const audio = new PhoneAudio({readyState: 1, close() {}, send() {}}, config, resolve, {onReady: () => audio.close('probe_complete')});
    });
    if (!result.ready || !result.finalized) throw Error(`Direct GPT-Live audio probe failed (${result.providerError || result.reason || 'unconfirmed finalization'})`);
    return {model: 'gpt-live-1', audio: 'pcmu/8000', ready: true, finalized: true, usage: result.usage, phoneCallVerified: false};
  }
  if (['preview','route','restore','status'].includes(command)) return phoneRoute(directory, config, command);
  if (command === 'serve') {
    const provider=new PhoneNumber(config),calls=new PhoneCalls(directory,config,provider);let web,control;
    try {
      await calls.recover();
      web=await servePhone(config, {calls,provider,record: value => save(join(directory, LAST_CALL), value)});
      control=await servePhoneControl(directory,frame=>{
        const {action,...options}=frame;
        if (!['call','call-status','hangup'].includes(action) || Object.keys(options).some(key=>!['requestId',...(action==='call'?['to']:[])].includes(key))) throw Error('Invalid phone control command');
        return action==='call'?calls.call(options,web.busy):action==='call-status'?calls.status(options.requestId):calls.hangup(options.requestId);
      });
    } catch (error) { await web?.close();calls.close();throw error; }
    console.log(JSON.stringify({web: {url: config.origin, model: 'gpt-live-1', limits: 'one inbound or outbound call at a time; 3 minutes each; available until stopped; every call recorded at Twilio', nativeTools: false}}));
    let stopping;
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => {stopping??=(async()=>{
      const stopped=await Promise.allSettled([web.close(),control.close()]);
      try { await calls.stop();if(stopped.some(result=>result.status==='rejected'))throw Error('Unconfirmed shutdown');calls.close();process.exit(0); }
      catch { console.error('Phone service stopped with unconfirmed call cleanup or receipt storage');calls.close();process.exit(2); }
    })();});
    return;
  }
  if (command === 'receipt') return read(join(directory, LAST_CALL));
  throw Error('Use phone configure|doctor|probe|preview|route|status|restore|serve|receipt|call|call-status|hangup');
}
