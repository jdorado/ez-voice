// Temporary audio client. Core owns the persistent connection and plugin dispatch.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {frames,send} from '../src/protocol.mjs';

const args=process.argv.slice(2);
const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
if(!option('--ez'))throw Error('Usage: node examples/local-bridge.mjs --ez /agent/tools/bin/ez [--port 8791]');
const port=Number(option('--port','8791'));
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
const origin=`http://127.0.0.1:${port}`,token=randomBytes(32).toString('hex'),owner=randomBytes(32).toString('hex');
const equal=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&timingSafeEqual(Buffer.from(value),Buffer.from(token));
const env={};for(const key of ['PATH','HOME','USER','TMPDIR','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','XDG_RUNTIME_DIR'])if(process.env[key])env[key]=process.env[key];
const child=spawn(option('--ez'),['tools','connect','voice','connect'],{env,stdio:['pipe','pipe','pipe']});
const pending=new Map(),events=[];
let seq=0,ready=true,sessionId,starting=false,lastBrowserSeen=Date.now(),saved={messages:[]};
const append=event=>{events.push({...event,seq:++seq});if(events.length>300)events.shift();};
function disconnected(){ready=false;for(const p of pending.values())p.finish(Error('Core connection closed'));pending.clear();append({type:'error',message:'Core connection closed; restart the local client.'});}
child.on('error',disconnected);child.on('close',disconnected);child.stdin.on('error',()=>{});
child.stderr.on('data',()=>{}); // Never forward provider/host diagnostics to the browser.
function request(method,params={}){
  if(!ready)return Promise.reject(Error('Core connection unavailable'));
  return new Promise((resolve,reject)=>{
    const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(Error('Session request timed out'));},60000);
    pending.set(id,{finish:(error,result)=>{clearTimeout(timer);error?reject(error):resolve(result);}});
    send(child.stdin,{id,owner,method,params});
  });
}
frames(child.stdout,frame=>{
  if(frame.event){
    append(frame.event);
    if(frame.event.type==='closed'){sessionId=undefined;void request('history').then(r=>{saved=r;}).catch(()=>{});}
    return;
  }
  const p=pending.get(frame.id);if(p){pending.delete(frame.id);p.finish(frame.error?Error(frame.error):null,frame.result);}
},()=>{child.kill('SIGTERM');disconnected();});
const profile=await request('context');saved=await request('history');
const lease=setInterval(()=>{
  if(!sessionId)return;
  const method=Date.now()-lastBrowserSeen>15000?'stop':'ping';
  void request(method).then(()=>{if(method==='stop')sessionId=undefined;}).catch(error=>append({type:'error',message:error.message}));
},5000);
const server=http.createServer(async(req,res)=>{
  const reply=(status,value,type='application/json')=>{
    res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'"});
    res.end(type==='application/json'?JSON.stringify(value):value);
  };
  try{
    if(req.headers.host!==`127.0.0.1:${port}`)return reply(403,{error:'Invalid host'});
    const url=new URL(req.url,origin);
    const assets={'/':['../web/index.html','text/html'],'/app.js':['../web/app.js','text/javascript'],'/style.css':['../web/style.css','text/css']};
    if(req.method==='GET'&&Object.hasOwn(assets,url.pathname)){const [path,type]=assets[url.pathname];return reply(200,await readFile(fileURLToPath(new URL(path,import.meta.url)),'utf8'),type);}
    if(!equal(req.headers.authorization?.replace(/^Bearer /,'')))return reply(401,{error:'Open the private link printed by your local client'});
    if(req.headers.origin&&req.headers.origin!==origin)return reply(403,{error:'Invalid origin'});
    if(req.method==='GET'&&url.pathname==='/status'){
      lastBrowserSeen=Date.now();return reply(200,{agent:profile.agent,ready,sessionId,tools:profile.tools,history:saved,events:events.filter(e=>e.seq>Number(url.searchParams.get('after')||0))});
    }
    if(req.method!=='POST'||req.headers.origin!==origin)return reply(403,{error:'Expected same-origin POST'});
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>110000)return reply(413,{error:'Request too large'});}
    const input=JSON.parse(raw||'{}');
    if(url.pathname==='/session'){
      if(sessionId||starting)return reply(409,{error:'A session is already active'});
      starting=true;lastBrowserSeen=Date.now();
      try{const result=await request('start',{sdp:input.sdp,resume:input.resume!==false});sessionId=result.sessionId;saved=await request('history');return reply(201,result);}finally{starting=false;}
    }
    if(url.pathname==='/stop'){
      const result=sessionId||starting?await request('stop'):{stopped:true};sessionId=undefined;saved=await request('history');return reply(200,result);
    }
    return reply(404,{error:'Not found'});
  }catch(error){reply(400,{error:error.message});}
});
server.listen(port,'127.0.0.1',()=>console.log(`${origin}/#${token}`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{
  clearInterval(lease);if(sessionId||starting)await request('stop').catch(()=>{});child.stdin.end();server.close(()=>{});setTimeout(()=>child.kill('SIGTERM'),2000).unref();
});
