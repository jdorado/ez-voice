import net from 'node:net';
import { mkdir, readFile, chmod, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { frames, send, text } from './protocol.mjs';
import { RealtimeSession } from './realtime.mjs';

const state = resolve(process.env.EZ_VOICE_STATE || '/state');
await mkdir(state, { recursive: true, mode: 0o700 });
const socketPath = join(state, 'voice.sock');
// The manager owns one persistent service per private volume.
await unlink(socketPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
let active;
const connections = new Set();
const server = net.createServer(socket => {
  connections.add(socket);
  let session;
  const pending = new Map();
  const emit = event => send(socket, { event });
  const execute = (call, signal) => new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const finish = (error, value) => { clearTimeout(timer); signal.removeEventListener('abort', abort); pending.delete(requestId); error ? reject(error) : resolve(value); };
    const abort = () => { send(socket, { cancelTool: requestId }); finish(new Error('Tool cancelled')); };
    const timer = setTimeout(() => { send(socket, { cancelTool: requestId }); finish(new Error('Tool timed out; outcome unconfirmed')); }, 30000);
    pending.set(requestId, value => finish(null, value));
    signal.addEventListener('abort', abort, { once: true });
    send(socket, { tool: { requestId, ...call } });
  });
  frames(socket, async frame => {
    if (frame.toolResult) {
      const result = frame.toolResult;
      text(result.output, 16000);
      pending.get(result.requestId)?.(result.output);
      return;
    }
    const { id, method, params = {} } = frame;
    if (typeof id !== 'string' || id.length > 100) throw new Error('Invalid request ID');
    try {
      let result;
      if (method === 'health') result = { healthy: true, active: Boolean(active && !active.closed) };
      else if (method === 'start') {
        if (active && !active.closed) throw new Error('A voice session is already active');
        const config = JSON.parse(await readFile(join(state, 'config.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e; }));
        session = new RealtimeSession(config, emit, execute); active = session;
        try { result = await session.start(params); }
        catch (error) { await session.stop('startup_failed'); throw error; }
      } else if (method === 'stop') result = await session?.stop();
      else throw new Error('Unknown method');
      send(socket, { id, result: result ?? { stopped: true } });
    } catch (error) { send(socket, { id, error: error.message }); }
  }, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('close', () => { connections.delete(socket); void session?.stop('bridge_disconnected'); });
});
server.listen(socketPath, async () => { await chmod(socketPath, 0o600); console.log('Voice service ready'); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  await active?.stop('service_stopped');
  for (const connection of connections) connection.destroy();
  server.close(() => process.exit());
});
