// The information tools: the operator's backend over HTTP, the model supplying only arguments and the call ticket the identity.
// GET url answers {tools: [Responses function definitions]} once, as the listener starts; each read is one POST of
// {call, turn, name, arguments} with a bearer token, answering JSON that echoes call_id and turn. No installed command: Ez starts a
// container for each one (about 2.5 s on a live host), and a speech provider gives up on a turn that waits for a few.
import {CoreTools} from './plugin-tools.mjs';
import {frames} from './protocol.mjs';
import {sid} from './phone-provider.mjs';

function validateHttpBinding(value, name, maxMs) { // name: contextBinding or toolBinding
  const invalid = `Invalid phone ${name.replace('Binding', '')} binding`;
  if (value && typeof value === 'object' && ('alias' in value || 'invoke' in value)) {
    throw Error(`${name} is now {url, token, deadlineMs}: the alias/invoke form was removed`);
  }
  if (!value || Object.keys(value).sort().join() !== 'deadlineMs,token,url' || typeof value.url !== 'string'
      || typeof value.token !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(value.token)
      || !Number.isInteger(value.deadlineMs) || value.deadlineMs < 500 || value.deadlineMs > maxMs) throw Error(invalid);
  let url;
  try { url = new URL(value.url); } catch { throw Error(invalid); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw Error(invalid);
  return value;
}

export const validateBinding = value => validateHttpBinding(value, 'toolBinding', 15000);

// One bounded JSON exchange with the backend: a non-2xx answer, a redirect or more than the cap is a failure.
async function exchange(binding, fetchImpl, init, signal) {
  const response = await fetchImpl(binding.url, {...init, redirect: 'error', signal,
    headers: {authorization: 'Bearer ' + binding.token, ...(init.body && {'content-type': 'application/json'})}});
  if (!response.ok) { await response.body?.cancel(); throw Error('Backend unavailable'); }
  const raw = await boundedText(response);
  if (raw.length > 40000) throw Error('Backend unavailable');
  return JSON.parse(raw);
}

export async function httpTools(binding, fetchImpl = fetch) {
  validateBinding(binding);
  const {tools} = await exchange(binding, fetchImpl, {method: 'GET'}, AbortSignal.timeout(binding.deadlineMs));
  if (!Array.isArray(tools) || tools.length > 12 || !tools.length
      || new Set(tools.map(t => t.name)).size !== tools.length
      || tools.some(t => t.type !== 'function' || !/^[a-z][a-z0-9_]{0,63}$/.test(t.name)
        || ['end_call', 'transfer_call'].includes(t.name) || typeof t.description !== 'string'
        || t.description.length > 2000 || t.parameters?.type !== 'object')) throw Error('Invalid phone tool schemas');
  return {tools, deadlineMs: binding.deadlineMs, async run(call, turn, name, args, signal) {
    if (!tools.some(t => t.name === name)) return {status: 'unavailable', error: 'unknown_tool'};
    const out = await exchange(binding, fetchImpl, {method: 'POST', body: JSON.stringify({call, turn, name, arguments: args})}, signal);
    if (out?.call_id !== call.id || out.turn !== turn) throw Error('Information result binding mismatch');
    return out;
  }};
}

// The side coach's installed capability (src/phone-advice.mjs): one literal command, given each finished caller utterance
// on stdin, and how long its answer may take before it is dropped (it never delays a reply).
export function validateAdviceBinding(value) {
  if (!value || Object.keys(value).sort().join() !== 'alias,deadlineMs,invoke'
      || !/^[a-z][a-z0-9-]{0,63}$/.test(value.alias) || !Array.isArray(value.invoke) || !value.invoke.length || value.invoke.length > 8
      || value.invoke.some(a => typeof a !== 'string' || !a || a.length > 100 || a.includes('\0'))
      || !Number.isInteger(value.deadlineMs) || value.deadlineMs < 500 || value.deadlineMs > 5000) throw Error('Invalid phone advice binding');
  return value;
}

// What a result may ask of the call besides its note (an ElevenLabs advice line): end it once the model's next reply has played.
export const ADVICE_ENDS = ['lead_goodbye', 'opt_out', 'booked'];
export function installedAdvice(binding, core) {
  validateAdviceBinding(binding);
  return {deadlineMs: binding.deadlineMs, async run(request, signal) {
    const result = await core.request('tools.invoke', {alias: binding.alias, args: binding.invoke, stdin: JSON.stringify(request)}, signal);
    if (result.code !== 0 || typeof result.stdout !== 'string' || result.stdout.length > 16000) throw Error('Advice unavailable');
    const out = JSON.parse(result.stdout);
    if (out.call_id !== request.call.id || out.turn !== request.turn
        || !['available','unavailable','no_match'].includes(out.status)) throw Error('Advice result binding mismatch');
    if (out.status === 'available') {
      const a = out.advice;
      if (!a || typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(a.id) || typeof a.text !== 'string' || !a.text.trim() || a.text.length > 6000
          || typeof a.source !== 'string' || !a.source.startsWith('https://') || a.source.length > 500
          || !/^[a-f0-9]{64}$/.test(a.source_revision) || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1
          || (a.end !== undefined && !ADVICE_ENDS.includes(a.end))) throw Error('Invalid advice result');
      return {status: out.status, advice: {id: a.id, text: a.text, source: a.source, source_revision: a.source_revision, confidence: a.confidence, ...(a.end && {end: a.end})}};
    }
    return {status: out.status};
  }};
}

// The caller context: the operator's backend is asked over HTTP as an inbound call arrives, with the call's identity (never a
// model's words), for what it knows of this caller now. One POST of {call} with a bearer token answers {call_id, status,
// context?: {text}}. It never fails or holds up a call: a slow, failed or invalid answer is `timeout` or `unavailable`, and the
// call goes on with the line's instructions alone.
export const validateContextBinding = value => validateHttpBinding(value, 'contextBinding', 10000);

// The answer is read up to a cap and no further: a backend that streams forever costs the cap, not the listener's memory (the
// service has 256 MiB for every live call). 40,000 characters can be 120,000 bytes of UTF-8.
const MAX_ANSWER_BYTES = 120000;
async function boundedText(response) {
  if (Number(response.headers?.get('content-length')) > MAX_ANSWER_BYTES) { await response.body?.cancel(); throw Error('Backend unavailable'); }
  if (!response.body) return response.text();
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) { // leaving the loop cancels the stream and closes the connection
    size += chunk.length;
    if (size > MAX_ANSWER_BYTES) throw Error('Backend unavailable');
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks)); // like response.text(): a UTF-8 BOM is dropped
}

export function httpContext(binding, fetchImpl = fetch) {
  validateContextBinding(binding);
  return {deadlineMs: binding.deadlineMs, async run(call, signal, maxChars) {
    const out = await exchange(binding, fetchImpl, {method: 'POST', body: JSON.stringify({call, ...(maxChars && {max_chars: maxChars})})}, signal);
    if (out.call_id !== call.id || !['available', 'no_match', 'unavailable'].includes(out.status)) throw Error('Context result binding mismatch');
    if (out.status !== 'available') return {status: out.status};
    const text = out.context?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) throw Error('Invalid context result');
    return {status: 'available', text};
  }};
}

// Ask now, answer later: the promise never rejects and is settled by the provider's deadline at the latest.
// `maxChars` is the room the session has left for the answer's text (contextRoom in phone.mjs), told to the backend so it
// answers with the fullest text that fits instead of one the session cuts off in the middle.
export function liveContext(provider, call, maxChars) {
  const abort = new AbortController(), began = Date.now();
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => { abort.abort(); resolve({status: 'timeout'}); }, provider.deadlineMs); });
  const attempt = Promise.resolve().then(() => provider.run(call, abort.signal, maxChars)).catch(() => ({status: 'unavailable'}));
  return Promise.race([attempt, timeout]).then(answer => ({...answer, ms: Date.now() - began})).finally(() => clearTimeout(timer));
}

// The live transfer: the operator's backend decides who the person is. One POST per step with a bearer token, bounded like the
// context ask: `claim` {call, whisper} answers {status: available, claim_id, person, number, caller_id}, {status: queued, claim_id}
// (the person is on another call) or busy|off|none|unavailable; `poll` {claim_id} answers what a queued, joined or held claim does
// next (wait|ring|take|back|drop|ended); `after` {person_call_sid} answers whether the person goes back to a held owner once their
// conference ended; `joined`, `taken`, `returned` answer {ok: true}; `release` answers {ok: true, end?: [Call SID]}, the owner calls
// to hang up; `words` {call: {call_sid, line, number}, turns: [{who: caller|model, text, atMs}] (the last 40), ended} streams the call's
// words to the person's panel while it runs, and once more with ended: true when it closes (answers {ok: true}); an answer
// {ok: true, listen: true} says someone listens in, and the next posts carry `audio`, the call's two sides mixed since the last post
// (8 kHz mu-law, base64), about one a second until an answer drops listen. A failed, late or invalid claim is `unavailable`, a failed poll is `wait`; a failed report is never repeated.
export const validateTransferBinding = value => validateHttpBinding(value, 'transferBinding', 5000);
export const TRANSFER_RESULTS = ['no_answer', 'declined', 'failed', 'abandoned', 'completed'];
const claimId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const e164 = value => typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
const person = value => typeof value === 'string' && /^[^\u0000-\u001f]{1,200}$/.test(value);
const room = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const callSids = value => Array.isArray(value) ? value.filter(v => sid(v, 'CA')).slice(0, 50) : [];
export function httpTransfer(binding, fetchImpl = fetch) {
  validateTransferBinding(binding);
  const post = body => exchange(binding, fetchImpl, {method: 'POST', body: JSON.stringify(body)}, AbortSignal.timeout(binding.deadlineMs));
  const acknowledged = async body => { try { return (await post(body))?.ok === true; } catch { return false; } };
  return {deadlineMs: binding.deadlineMs,
    async claim(call, whisper) {
      let out;
      try { out = await post({action: 'claim', call, whisper}); } catch { return {status: 'unavailable'}; }
      if (['busy', 'off', 'none', 'unavailable'].includes(out?.status)) return {status: out.status};
      if (out?.status === 'queued' && claimId(out.claim_id)) return {status: 'queued', claim_id: out.claim_id};
      if (out?.status !== 'available' || !claimId(out.claim_id) || !person(out.person)
          || !e164(out.number) || !e164(out.caller_id)) return {status: 'unavailable'};
      return {status: 'available', claim_id: out.claim_id, person: out.person, number: out.number, caller_id: out.caller_id};
    },
    joined: (claim_id, person_call_sid, room) => acknowledged({action: 'joined', claim_id, person_call_sid, room}),
    taken: (claim_id, room, person_call_sid) => acknowledged({action: 'taken', claim_id, room, person_call_sid}),
    returned: claim_id => acknowledged({action: 'returned', claim_id}),
    async words(call, turns, ended, audio) {
      let out;
      try { out = await post({action: 'words', call, turns, ended, ...(audio && {audio})}); } catch { return {ok: false, listen: false}; }
      return {ok: out?.ok === true, listen: out?.listen === true};
    },
    async release(claim_id, result, extra = {}) {
      let out;
      try { out = await post({action: 'release', claim_id, result, ...extra}); } catch { return {ok: false, end: []}; }
      return {ok: out?.ok === true, end: callSids(out?.end)};
    },
    async poll(claim_id) {
      let out;
      try { out = await post({action: 'poll', claim_id}); } catch { return {status: 'wait'}; }
      if (['drop', 'ended'].includes(out?.status)) return {status: out.status};
      if (out?.status === 'ring' && person(out.person) && e164(out.number) && e164(out.caller_id)) return {status: 'ring', person: out.person, number: out.number, caller_id: out.caller_id};
      if (out?.status === 'take' && person(out.person) && sid(out.person_call_sid, 'CA') && (out.hold === null || out.hold === undefined || (room(out.hold?.room) && sid(out.hold?.call_sid, 'CA'))))
        return {status: 'take', person: out.person, person_call_sid: out.person_call_sid, hold: out.hold ? {room: out.hold.room, call_sid: out.hold.call_sid} : null};
      if (out?.status === 'back' && sid(out.person_call_sid, 'CA')) return {status: 'back', person_call_sid: out.person_call_sid, end: callSids(out.end)};
      if (out?.status === 'pass' && claimId(out.claim_id) && person(out.person) && e164(out.number) && e164(out.caller_id) && room(out.room))
        return {status: 'pass', claim_id: out.claim_id, person: out.person, number: out.number, caller_id: out.caller_id, room: out.room};
      return {status: 'wait'};
    },
    async after(person_call_sid) {
      let out;
      try { out = await post({action: 'after', person_call_sid}); } catch { return {status: 'none'}; }
      return out?.status === 'back' && claimId(out.claim_id) && room(out.room) && sid(out.call_sid, 'CA') ? {status: 'back', claim_id: out.claim_id, room: out.room, call_sid: out.call_sid} : {status: 'none'};
    },
  };
}

export async function phonePlugins(binding, adviceBinding, contextBinding, transferBinding, fetchImpl = fetch) {
  // the context, the information tools and the transfer ask the backend directly; only the side coach goes through the Ez connection
  const contextProvider = contextBinding ? httpContext(contextBinding, fetchImpl) : undefined;
  const transfer = transferBinding ? httpTransfer(transferBinding, fetchImpl) : undefined;
  const information = binding ? await httpTools(binding, fetchImpl) : undefined;
  if (!adviceBinding) return {information, contextProvider, transfer};
  const core = new CoreTools(process.stdout);
  frames(process.stdin, frame => core.receive(frame), () => core.close());
  process.stdin.on('end', () => core.close());
  return {information, advisor: installedAdvice(adviceBinding, core), contextProvider, transfer};
}
