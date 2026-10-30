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

export async function phonePluginTools(binding) {
  if (!binding) return undefined;
  const core = new CoreTools(process.stdout);
  frames(process.stdin, frame => core.receive(frame), () => core.close());
  process.stdin.on('end', () => core.close());
  return installedTools(binding, core);
}
