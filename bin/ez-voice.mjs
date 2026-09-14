#!/usr/bin/env node
import net from 'node:net';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { frames, send } from '../src/protocol.mjs';

const state = resolve(process.env.EZ_VOICE_STATE || '/state');
const command = process.argv[2] || '--help';
try {
  if (command === '--version') console.log('ez-voice 0.1.0-beta.1');
  else if (command === '--help') console.log(`ez-voice 0.1.0-beta.1
  doctor              Read configuration and provider readiness (no provider request)
  health              Check the resident service
  configure           Read {apiKey, model?, voice?} JSON from stdin; private atomic storage
  bridge              Authenticated local transport over JSON lines to the resident service
Use the agent-bound ez voice command. Start/stop through ez plugins.
Credentials live in /state/config.json (0600), never browser or model context.
Exit 0 success, 2 invalid input/unavailable. No automatic provider retries.
The temporary owner web bridge is examples/local-bridge.mjs; see README.`);
  else if (command === 'configure') {
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 16000) throw new Error('Input too large'); }
    const config = JSON.parse(raw);
    if (Object.keys(config).some(k => !['apiKey', 'model', 'voice'].includes(k))) throw new Error('Unknown configuration field');
    if (typeof config.apiKey !== 'string' || !/^sk-[A-Za-z0-9_-]{10,}$/.test(config.apiKey)) throw new Error('Expected an OpenAI API key');
    if (config.model && !/^gpt-realtime(?:-[a-zA-Z0-9.-]+)?$/.test(config.model)) throw new Error('Expected a Realtime model, not gpt-live');
    if (config.voice && !['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'].includes(config.voice)) throw new Error('Unknown voice');
    await mkdir(state, { recursive: true, mode: 0o700 });
    const target = join(state, 'config.json');
    const tmp = target + '.' + process.pid + '.tmp';
    await writeFile(tmp, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    await rename(tmp, target);
    console.log(JSON.stringify({ configured: true, model: config.model || 'gpt-realtime-2.1' }));
  } else if (command === 'doctor') {
    const config = await readFile(join(state, 'config.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
    console.log(JSON.stringify({ version: '0.1.0-beta.1', configured: Boolean(config.apiKey), model: config.model || 'gpt-realtime-2.1', voice: config.voice || 'marin', transport: 'webrtc', toolMode: 'direct', liveVerified: false }));
  } else if (command === 'bridge' || command === 'health') {
    const socket = net.connect(join(state, 'voice.sock'));
    socket.on('error', () => { console.error('Voice service unavailable; use ez plugins start voice'); process.exitCode = 2; });
    if (command === 'bridge') {
      process.stdin.pipe(socket); socket.pipe(process.stdout);
      socket.on('close', () => process.exit());
      for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => socket.destroy());
    } else {
      socket.setTimeout(3000, () => socket.destroy(new Error('Timeout')));
      socket.on('connect', () => send(socket, { id: 'health', method: 'health' }));
      frames(socket, frame => { if (frame.id === 'health') { console.log(JSON.stringify(frame.result)); socket.end(); } }, () => socket.destroy());
    }
  } else throw new Error('Unknown command; use --help');
} catch (error) { console.error(error.message); process.exitCode = 2; }
