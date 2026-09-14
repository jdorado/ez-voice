import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { validateTools, validateArguments } from '../src/tools.mjs';

export async function loadBindings(path, ez) {
  const profile = JSON.parse(await readFile(path, 'utf8'));
  validateTools(profile.tools);
  if (typeof profile.agent !== 'string' || profile.agent.length > 100) throw new Error('Expected agent label');
  const launcher = await realpath(ez);
  const registryPath = resolve(dirname(launcher), '..', 'registry.json');
  // Verify against the supplied agent-bound registry, not a global executable.
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  for (const tool of profile.tools) {
    if (!Object.hasOwn(registry.commands, tool.command) || tool.command === 'voice') throw new Error(`Unsupported tool binding ${tool.name}`);
    if (tool.effect !== 'read') throw new Error('This pilot supports read operations only');
    if (!Array.isArray(tool.args) || tool.args.length > 32 || !tool.args.length) throw new Error('Expected bounded literal argv template');
    for (const arg of tool.args) {
      if (typeof arg === 'string') { if (arg.length > 2000 || arg.includes('\0')) throw new Error('Invalid literal argument'); }
      else if (!arg || Object.keys(arg).length !== 1 || !Object.hasOwn(tool.parameters.properties, arg.parameter)) throw new Error('Invalid parameter binding');
    }
  }
  return { ...profile, ez: launcher, registryPath };
}
export function argvFor(tool, args) {
  validateArguments(tool, args);
  return [tool.command, ...tool.args.map(arg => {
    if (typeof arg === 'string') return arg;
    if (!Object.hasOwn(args, arg.parameter)) throw new Error('Missing bound argument');
    const value = String(args[arg.parameter]);
    if (value.startsWith('-')) throw new Error('Parameter cannot inject a CLI option');
    return value;
  })];
}
export async function executeBinding(profile, call, signal) {
  const tool = profile.tools.find(t => t.name === call.name);
  if (!tool) throw new Error('Tool not bound');
  const registry = JSON.parse(await readFile(profile.registryPath, 'utf8'));
  if (!Object.hasOwn(registry.commands, tool.command)) throw new Error('Plugin was removed');
  const args = argvFor(tool, call.arguments);
  const env = {};
  for (const key of ['PATH','HOME','USER','TMPDIR','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','XDG_RUNTIME_DIR']) if (process.env[key]) env[key] = process.env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(profile.ez, args, { env, stdio: ['ignore','pipe','pipe'], signal });
    let output = ''; let bytes = 0; let exceeded = false;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 64000) { exceeded = true; child.kill('SIGTERM'); } else output += chunk; });
    child.stderr.resume(); // Provider diagnostics may contain private data; do not forward.
    const timer = setTimeout(() => child.kill('SIGTERM'), 25000);
    child.on('error', error => { clearTimeout(timer); reject(error.name === 'AbortError' ? new Error('Tool cancelled') : new Error('Tool launch failed')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (exceeded) reject(new Error('Tool output too large; request fewer results'));
      else if (code !== 0) reject(new Error(`Plugin command failed (${code}); inspect its CLI privately`));
      else resolve(output.length > 15000 ? output.slice(0,15000) + '\n[truncated: narrow the query]' : output);
    });
  });
}
