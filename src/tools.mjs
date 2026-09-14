import { text } from './protocol.mjs';

// Bindings are operator configuration, never generated from model arguments.
export function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length > 64) throw new Error('Expected at most 64 tools');
  const names = new Set();
  for (const tool of tools) {
    if (!tool || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || names.has(tool.name)) throw new Error('Invalid/duplicate tool name');
    names.add(tool.name);
    text(tool.description, 2000);
    if (tool.parameters?.type !== 'object' || !tool.parameters.properties || Array.isArray(tool.parameters.properties)) throw new Error('Tool needs object parameters');
    if (tool.parameters.additionalProperties !== false) throw new Error('Unknown arguments must be rejected');
    for (const [name, spec] of Object.entries(tool.parameters.properties)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !['string', 'integer', 'boolean'].includes(spec.type)) throw new Error('Unsupported parameter');
      if (spec.type === 'string' && (!Number.isInteger(spec.maxLength) || spec.maxLength < 1 || spec.maxLength > 16000)) throw new Error('String parameter needs maxLength');
      if (spec.type === 'integer' && (!Number.isSafeInteger(spec.minimum) || !Number.isSafeInteger(spec.maximum) || spec.minimum > spec.maximum)) throw new Error('Integer parameter needs bounds');
      if (spec.enum && (!Array.isArray(spec.enum) || spec.enum.length > 100)) throw new Error('Invalid enum');
    }
    if (!Array.isArray(tool.parameters.required) || tool.parameters.required.some(k => !Object.hasOwn(tool.parameters.properties, k))) throw new Error('Invalid required fields');
  }
  return tools;
}
export function validateArguments(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  for (const name of tool.parameters.required) if (!Object.hasOwn(args, name)) throw new Error(`Missing ${name}`);
  for (const [name, value] of Object.entries(args)) {
    if (!Object.hasOwn(tool.parameters.properties, name)) throw new Error('Unknown argument');
    const spec = tool.parameters.properties[name];
    if (spec.type === 'string') text(value, spec.maxLength);
    else if (spec.type === 'integer' && (!Number.isSafeInteger(value) || value < spec.minimum || value > spec.maximum)) throw new Error('Integer outside bounds');
    else if (spec.type === 'boolean' && typeof value !== 'boolean') throw new Error('Expected boolean');
    if (spec.enum && !spec.enum.includes(value)) throw new Error('Value outside enum');
  }
  return args;
}
export function definitions(tools) {
  return validateTools(tools).map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters }));
}
