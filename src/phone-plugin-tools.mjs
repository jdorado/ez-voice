// The information tools: the operator's backend over HTTP, the model supplying only arguments and the call ticket the identity.
// GET url answers {tools: [Responses function definitions]} once, as the listener starts; each read is one POST of
// {call, turn, name, arguments} with a bearer token, answering JSON that echoes call_id and turn. No installed command: Ez starts a
// container for each one (about 2.5 s on a live host), and a speech provider gives up on a turn that waits for a few.
import {CoreTools} from './plugin-tools.mjs';
import {frames} from './protocol.mjs';

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
        || t.name === 'end_call' || typeof t.description !== 'string'
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

export function installedAdvice(binding, core) {
  validateAdviceBinding(binding);
  return {deadlineMs: binding.deadlineMs, async run(request, signal) {
    const result = await core.request('tools.invoke', {alias: binding.alias, args: binding.invoke, stdin: JSON.stringify(request)}, signal);
    if (result.code !== 0 || typeof result.stdout !== 'string' || result.stdout.length > 8000) throw Error('Advice unavailable');
    const out = JSON.parse(result.stdout);
    if (out.call_id !== request.call.id || out.turn !== request.turn
        || !['available','unavailable','no_match'].includes(out.status)) throw Error('Advice result binding mismatch');
    if (out.status === 'available') {
      const a = out.advice;
      if (!a || typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(a.id) || typeof a.text !== 'string' || !a.text.trim() || a.text.length > 3000
          || typeof a.source !== 'string' || !a.source.startsWith('https://') || a.source.length > 500
          || !/^[a-f0-9]{64}$/.test(a.source_revision) || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) throw Error('Invalid advice result');
      return {status: out.status, advice: {id: a.id, text: a.text, source: a.source, source_revision: a.source_revision, confidence: a.confidence}};
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

export async function phonePlugins(binding, adviceBinding, contextBinding, fetchImpl = fetch) {
  // the context and the information tools ask the backend directly; only the side coach goes through the Ez connection
  const contextProvider = contextBinding ? httpContext(contextBinding, fetchImpl) : undefined;
  const information = binding ? await httpTools(binding, fetchImpl) : undefined;
  if (!adviceBinding) return {information, contextProvider};
  const core = new CoreTools(process.stdout);
  frames(process.stdin, frame => core.receive(frame), () => core.close());
  process.stdin.on('end', () => core.close());
  return {information, advisor: installedAdvice(adviceBinding, core), contextProvider};
}
