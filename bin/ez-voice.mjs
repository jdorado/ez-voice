#!/usr/bin/env node
import net from 'node:net';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { frames, send } from '../src/protocol.mjs';

const state = resolve(process.env.EZ_VOICE_STATE || '/state');
const command = process.argv[2] || '--help';
try {
  if (command === '--version') console.log('ez-voice 0.1.0-beta.2');
  else if (command === '--help') console.log(`ez-voice 0.1.0-beta.2
  doctor              Read configuration and provider readiness (no provider request)
  health              Check the resident service
  configure           Read {apiKey, agentUrl, agentToken, model?, voice?} JSON from stdin; private atomic storage
  bind                Read {name, purpose} owning-agent identity from private stdin
  exchange            One JSON request on stdin; one response from the resident service
  connect             Persistent JSONL connection (use ez tools connect voice connect)
Use the agent-bound ez voice command. Start/stop through ez plugins.
Credentials live in /state/config.json (0600), never browser or model context.
Exit 0 success, 2 invalid input/unavailable. No automatic provider retries.
Web: ez tools serve 8791:8080 voice web --origin http://127.0.0.1:8791
For HTTPS Telegram access add --bot-id ID; see README.`);
  else if (command === 'configure') {
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 16000) throw new Error('Input too large'); }
    const config = JSON.parse(raw);
    if (Object.keys(config).some(k => !['apiKey', 'agentUrl', 'agentToken', 'model', 'voice'].includes(k))) throw new Error('Unknown configuration field');
    if (typeof config.apiKey !== 'string' || !/^sk-[A-Za-z0-9_-]{10,}$/.test(config.apiKey)) throw new Error('Expected an OpenAI API key');
    if (config.model && config.model !== 'gpt-live-1') throw new Error('Voice requires gpt-live-1');
    if (config.voice && !['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'].includes(config.voice)) throw new Error('Unknown voice');
    if (typeof config.agentUrl !== 'string') throw new Error('Expected the native Ez agent URL');
    const agentUrl=new URL(config.agentUrl);
    if(!['http:','https:'].includes(agentUrl.protocol)||agentUrl.username||agentUrl.password||agentUrl.pathname!=='/'||agentUrl.search||agentUrl.hash)throw Error('Invalid native Ez agent URL');
    if(typeof config.agentToken!=='string'||!/^[A-Za-z0-9_-]{43,200}$/.test(config.agentToken))throw Error('Expected the native Ez agent token');
    await mkdir(state, { recursive: true, mode: 0o700 });
    const target = join(state, 'config.json');
    const tmp = target + '.' + process.pid + '.tmp';
    await writeFile(tmp, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    await rename(tmp, target);
    console.log(JSON.stringify({ configured: true, model: 'gpt-live-1' }));
  } else if(command === 'bind') {
    let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>4000)throw Error('Binding too large');}
    const agent=JSON.parse(raw);
    if(Object.keys(agent).some(k=>!['name','purpose'].includes(k))||typeof agent.name!=='string'||!agent.name||agent.name.length>100||typeof agent.purpose!=='string'||agent.purpose.length>2000)throw Error('Expected agent name and purpose');
    const tmp=join(state,`agent.${process.pid}.tmp`);await writeFile(tmp,JSON.stringify(agent),{mode:0o600,flag:'wx'});await rename(tmp,join(state,'agent.json'));
    console.log(JSON.stringify({bound:true,agent:agent.name}));
  } else if (command === 'doctor') {
    const config = await readFile(join(state, 'config.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
    console.log(JSON.stringify({ version: '0.1.0-beta.2', configured: Boolean(config.apiKey&&config.agentUrl&&config.agentToken), providerConfigured:Boolean(config.apiKey), agentConfigured:Boolean(config.agentUrl&&config.agentToken), model: 'gpt-live-1', voice: config.voice || 'marin', transport: 'webrtc', toolMode: 'client-delegation', liveVerified: false }));
  } else if(command==='web') {
    await (await import('../src/web-connect.mjs')).webConnect(state,process.argv.slice(3));
  } else if(command==='connect') {
    const socket=net.connect(join(state,'voice.sock'));
    socket.on('error',()=>{console.error('Voice service unavailable');process.exitCode=2;});
    socket.on('connect',()=>{process.stdin.pipe(socket);socket.pipe(process.stdout);});
    socket.on('close',()=>{process.stdin.destroy();});
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>socket.destroy());
  } else if (command === 'exchange' || command === 'health') {
    let input;
    if(command === 'exchange') {
      let raw=''; for await(const chunk of process.stdin) { raw+=chunk; if(raw.length>256*1024)throw new Error('Input too large'); }
      input=JSON.parse(raw);
    }
    const socket = net.connect(join(state, 'voice.sock'));
    socket.on('error', () => { console.error('Voice service unavailable; use ez plugins start voice'); process.exitCode = 2; });
    socket.setTimeout(command==='health'?3000:35000, () => socket.destroy(new Error('Timeout')));
    socket.on('connect', () => send(socket, input || { id:'health',method:'health' }));
    frames(socket, frame => { console.log(JSON.stringify(command==='health'?frame.result:frame));socket.end(); }, () => socket.destroy());
  } else throw new Error('Unknown command; use --help');
} catch (error) { console.error(error.message); process.exitCode = 2; }
