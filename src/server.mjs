import net from 'node:net';
import {mkdir,readFile,chmod,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {frames,send} from './protocol.mjs';
import {RealtimeSession} from './realtime.mjs';
import {agentContext,executeContext} from './context.mjs';
import {CoreTools,pluginTools} from './plugin-tools.mjs';
import {VoiceHistory,recentMessages} from './history.mjs';

const state=resolve(process.env.EZ_VOICE_STATE||'/state'),contextRoot=join(state,'context');
const context=async()=>agentContext(contextRoot,JSON.parse(await readFile(join(state,'agent.json'),'utf8')));
await mkdir(state,{recursive:true,mode:0o700});
const socketPath=join(state,'voice.sock');await unlink(socketPath).catch(e=>{if(e.code!=='ENOENT')throw e;});
const history=new VoiceHistory(state);
let active;
const connections=new Set();
async function stop(holder,reason='ended'){
  holder.cancelled=true;
  if(!holder.stopPromise)holder.stopPromise=(async()=>{
    await holder.startup?.catch(()=>{});
    const result=await holder.session?.stop(reason)||{reason,hangupConfirmed:true};
    await history.flush();
    if(active===holder)active=undefined;
    return result;
  })();
  return holder.stopPromise;
}
const server=net.createServer(socket=>{
  connections.add(socket);const core=new CoreTools(socket);
  frames(socket,async frame=>{
    if(core.receive(frame))return;
    const {id,method,params={}}=frame;
    try{
      if(typeof id!=='string'||id.length>100)throw Error('Invalid request ID');
      let result;
      if(method==='health')result={healthy:true,active:Boolean(active),transport:'persistent',history:'retained'};
      else if(method==='context'){const c=await context();result={agent:c.agent,tools:[...c.tools,...pluginTools]};}
      else if(method==='history'){const saved=await history.load();result={conversationId:saved?.id,messages:recentMessages(saved?.messages||[],50000,100)};}
      else{
        if(!/^[a-f0-9]{64}$/.test(frame.owner||''))throw Error('Invalid client owner');
        if(method==='start'){
          if(active)throw Error('A voice session is already active');
          if(params.resume!==undefined&&typeof params.resume!=='boolean')throw Error('Invalid resume option');
          const holder={owner:frame.owner,socket,session:null,cancelled:false,isStarting:true,lastSeen:Date.now()};active=holder;
          holder.startup=(async()=>{
            const config=JSON.parse(await readFile(join(state,'config.json'),'utf8'));
            const bound=await context();const capabilities=await core.capabilityContext();const retained=await history.begin(params.resume!==false);
            if(holder.cancelled)throw Error('Startup cancelled');
            const emit=event=>{send(socket,{event});if(event.type==='closed'&&!holder.isStarting)void stop(holder,event.reason).catch(()=>{});};
            const execute=(call,signal)=>call.name.startsWith('context_')?executeContext(contextRoot,call,signal):core.execute(call,signal);
            holder.session=new RealtimeSession(config,emit,execute,{observe:event=>history.observe(event)});
            const started=await holder.session.start({sdp:params.sdp,instructions:bound.instructions+'\n'+capabilities,tools:[...bound.tools,...pluginTools],history:retained});
            if(holder.cancelled)throw Error('Startup cancelled');
            return {...started,conversationId:history.value.id};
          })();
          try{result=await holder.startup;}catch(error){const cleanup=await stop(holder,'startup_failed');if(cleanup.hangupConfirmed===false)throw Error('Startup failed; provider hangup unconfirmed');throw error;}finally{holder.isStarting=false;}
        }else{
          if(!active||active.owner!==frame.owner||active.socket!==socket)throw Error('No session for this client');
          active.lastSeen=Date.now();
          if(method==='ping')result={active:true};
          else if(method==='stop')result=await stop(active);
          else throw Error('Unknown method');
        }
      }
      send(socket,{id,result});
    }catch(error){send(socket,{id,error:error.message});}
  },()=>socket.destroy());
  socket.on('error',()=>{});
  socket.on('close',()=>{connections.delete(socket);core.close();if(active?.socket===socket)void stop(active,'client_disconnected').catch(()=>{});});
});
const lease=setInterval(()=>{if(active&&Date.now()-active.lastSeen>60000)void stop(active,'client_lease_expired').catch(()=>{});},1000);
server.listen(socketPath,async()=>{await chmod(socketPath,0o600);console.log('Voice service ready');});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{clearInterval(lease);if(active)await stop(active,'service_stopped');for(const c of connections)c.destroy();server.close(()=>process.exit());});
