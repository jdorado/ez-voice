// Generic phone -> installed plugin transport through the existing Ez connection.
// A model supplies only arguments. The operator binds literal commands; the call ticket supplies identity.
import {CoreTools} from './plugin-tools.mjs';
import {frames} from './protocol.mjs';

export function validateBinding(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== 'alias,invoke,schemas'
      || !/^[a-z][a-z0-9-]{0,63}$/.test(value.alias)
      || ['schemas','invoke'].some(k => !Array.isArray(value[k]) || !value[k].length || value[k].length > 8
        || value[k].some(a => typeof a !== 'string' || a.length > 100 || a.includes('\0')))) throw Error('Invalid phone tool binding');
  return value;
}

export async function installedTools(binding, core) {
  validateBinding(binding);
  const invoke = async (args, stdin, signal) => {
    const result = await core.request('tools.invoke', {alias: binding.alias, args, ...(stdin && {stdin})}, signal);
    if (result.code !== 0) throw Error('Information read unavailable');
    return JSON.parse(result.stdout);
  };
  const {tools} = await invoke(binding.schemas);
  if (!Array.isArray(tools) || tools.length > 12 || !tools.length
      || new Set(tools.map(t => t.name)).size !== tools.length
      || tools.some(t => t.type !== 'function' || !/^[a-z][a-z0-9_]{0,63}$/.test(t.name)
        || ['end_call','find_case'].includes(t.name) || typeof t.description !== 'string'
        || t.description.length > 2000 || t.parameters?.type !== 'object')) throw Error('Invalid phone tool schemas');
  return {tools, async run(call, turn, name, args, signal) {
    if (!tools.some(t => t.name === name)) return {status: 'unavailable', error: 'unknown_tool'};
    const out = await invoke(binding.invoke, JSON.stringify({call, turn, name, arguments: args}), signal);
    if (out.call_id !== call.id || out.turn !== turn) throw Error('Information result binding mismatch');
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

// The caller context's installed capability: one literal command, asked as an inbound call arrives with the call's identity (never
// a model's words), for what the operator's backend knows of this caller now. It never fails or holds up a call: a slow, failed or
// invalid answer is `timeout` or `unavailable`, and the prepared table (if any) answers instead.
export function validateContextBinding(value) {
  if (!value || Object.keys(value).sort().join() !== 'alias,deadlineMs,invoke'
      || !/^[a-z][a-z0-9-]{0,63}$/.test(value.alias) || !Array.isArray(value.invoke) || !value.invoke.length || value.invoke.length > 8
      || value.invoke.some(a => typeof a !== 'string' || !a || a.length > 100 || a.includes('\0'))
      || !Number.isInteger(value.deadlineMs) || value.deadlineMs < 500 || value.deadlineMs > 10000) throw Error('Invalid phone context binding');
  return value;
}

export function installedContext(binding, core) {
  validateContextBinding(binding);
  return {deadlineMs: binding.deadlineMs, async run(call, signal) {
    const result = await core.request('tools.invoke', {alias: binding.alias, args: binding.invoke, stdin: JSON.stringify({call})}, signal);
    if (result.code !== 0 || typeof result.stdout !== 'string' || result.stdout.length > 12000) throw Error('Context unavailable');
    const out = JSON.parse(result.stdout);
    if (out.call_id !== call.id || !['available', 'no_match', 'unavailable'].includes(out.status)) throw Error('Context result binding mismatch');
    if (out.status !== 'available') return {status: out.status};
    const text = out.context?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) throw Error('Invalid context result');
    return {status: 'available', text};
  }};
}

// Ask now, answer later: the promise never rejects and is settled by the provider's deadline at the latest.
export function liveContext(provider, call) {
  const abort = new AbortController(), began = Date.now();
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => { abort.abort(); resolve({status: 'timeout'}); }, provider.deadlineMs); });
  const attempt = Promise.resolve().then(() => provider.run(call, abort.signal)).catch(() => ({status: 'unavailable'}));
  return Promise.race([attempt, timeout]).then(answer => ({...answer, ms: Date.now() - began})).finally(() => clearTimeout(timer));
}

export async function phonePlugins(binding, adviceBinding, contextBinding) {
  if (!binding && !adviceBinding && !contextBinding) return {};
  const core = new CoreTools(process.stdout);
  frames(process.stdin, frame => core.receive(frame), () => core.close());
  process.stdin.on('end', () => core.close());
  return {information: binding ? await installedTools(binding, core) : undefined,
    advisor: adviceBinding ? installedAdvice(adviceBinding, core) : undefined,
    contextProvider: contextBinding ? installedContext(contextBinding, core) : undefined};
}
