// Temporary owner-only HTTP/stdio transport. Voice/provider implementation runs in Docker.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { frames, send } from '../src/protocol.mjs';
import { loadBindings, executeBinding } from './bindings.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i+1]; };
if (!option('--ez') || !option('--profile')) {
  console.error('Usage: node examples/local-bridge.mjs --ez /agent/tools/bin/ez --profile /private/voice-profile.json [--port 8787]'); process.exit(2);
}
const port = Number(option('--port', '8787'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
const profile = await loadBindings(option('--profile'), option('--ez'));
const context = option('--context-file') ? await readFile(option('--context-file'), 'utf8') : '';
if (context.length > 12000) throw new Error('Keep startup context below 12,000 characters');
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
const equal = value => typeof value === 'string' && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
const pending = new Map(); const events = []; const toolControllers = new Map();
let sessionId; let starting = false; let ready = true; let sequence = 0;
const child = spawn(profile.ez, ['voice','bridge'], { stdio: ['pipe','pipe','pipe'] });
child.stderr.on('data', chunk => process.stderr.write(chunk));
const request = (method, params = {}) => new Promise((resolve, reject) => {
  if (!ready) return reject(new Error('Voice service disconnected'));
  const id = randomUUID();
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Voice request timed out')); }, 40000);
  pending.set(id, frame => { clearTimeout(timer); frame.error ? reject(new Error(frame.error)) : resolve(frame.result); });
  send(child.stdin, { id, method, params });
});
function append(event) { events.push({ ...event, seq: ++sequence }); if (events.length > 300) events.shift(); }
frames(child.stdout, async frame => {
  if (frame.id) { pending.get(frame.id)?.(frame); pending.delete(frame.id); }
  if (frame.event) { append(frame.event); if (frame.event.type === 'closed') sessionId = undefined; }
  if (frame.cancelTool) toolControllers.get(frame.cancelTool)?.abort();
  if (frame.tool) {
    const call = frame.tool; const controller = new AbortController();
    toolControllers.set(call.requestId, controller);
    let output;
    try { output = await executeBinding(profile, call, controller.signal); }
    catch (error) { output = JSON.stringify({ error: error.message }); }
    finally { toolControllers.delete(call.requestId); }
    send(child.stdin, { toolResult: { requestId: call.requestId, output } });
  }
}, () => child.kill('SIGTERM'));
child.on('error', () => { ready = false; });
child.on('close', () => {
  ready = false; for (const controller of toolControllers.values()) controller.abort();
  for (const complete of pending.values()) complete({ error: 'Voice service disconnected' }); pending.clear();
  append({ type: 'closed', reason: 'bridge_disconnected', hangupConfirmed: false });
});
const server = http.createServer(async (req, res) => {
  const reply = (status, value, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'" });
    res.end(type === 'application/json' ? JSON.stringify(value) : value);
  };
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) return reply(403, { error: 'Invalid host' });
    const url = new URL(req.url, origin);
    const assets = { '/': ['../web/index.html','text/html'], '/app.js': ['../web/app.js','text/javascript'], '/style.css': ['../web/style.css','text/css'] };
    if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
      const [path, type] = assets[url.pathname]; return reply(200, await readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8'), type);
    }
    if (!equal(req.headers.authorization?.replace(/^Bearer /,''))) return reply(401, { error: 'Open the private link printed by your local bridge' });
    if (req.headers.origin && req.headers.origin !== origin) return reply(403, { error: 'Invalid origin' });
    if (req.method === 'GET' && url.pathname === '/status') return reply(200, { agent: profile.agent, ready, sessionId, tools: profile.tools.map(t=>({name:t.name,description:t.description})), events: events.filter(e => e.seq > Number(url.searchParams.get('after') || 0)) });
    if (req.method !== 'POST' || req.headers.origin !== origin) return reply(403, { error: 'Expected same-origin POST' });
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 110000) return reply(413, {error:'Request too large'}); }
    const input = JSON.parse(body || '{}');
    if (url.pathname === '/session') {
      if (sessionId || starting) return reply(409, { error: 'A session is already active' });
      starting = true;
      try {
        const result = await request('start', { sdp: input.sdp, instructions: `Agent: ${profile.agent}. ${profile.instructions || ''}\n${context}`, tools: profile.tools });
        sessionId = result.sessionId; return reply(201, result);
      } finally { starting = false; }
    }
    if (url.pathname === '/stop') { const result = await request('stop'); sessionId = undefined; return reply(200, result); }
    return reply(404, { error: 'Not found' });
  } catch (error) { reply(400, { error: error.message }); }
});
server.listen(port, '127.0.0.1', () => console.log(`${origin}/#${token}`));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, async () => {
  await request('stop').catch(()=>{}); child.kill('SIGTERM'); server.close(()=>process.exit());
});
