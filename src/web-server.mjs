import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export async function serveWeb({request,auth,origin,port=8080,host='0.0.0.0'}) {
const events=[];let seq=0,sessionId,sessionToken,starting=false,lastBrowserSeen=Date.now(),saved={messages:[]};
const append=event=>{events.push({...event,seq:++seq});if(events.length>300)events.shift();if(event.type==='closed'){sessionId=undefined;void request('history').then(r=>{saved=r;}).catch(()=>{});}};
const profile=await request('context');saved=await request('history');
const server=http.createServer(async(req,res)=>{
  const reply=(status,value,type='application/json')=>{
    res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors https://web.telegram.org"});
    res.end(type==='application/json'?JSON.stringify(value):value);
  };
  try{
    if(req.headers.host!==new URL(origin).host)return reply(403,{error:'Invalid host'});
    const url=new URL(req.url,origin);
    const assets={'/':['../web/index.html','text/html'],'/app.js':['../web/app.js','text/javascript'],'/style.css':['../web/style.css','text/css']};
    if(req.method==='GET'&&Object.hasOwn(assets,url.pathname)){const [path,type]=assets[url.pathname];return reply(200,await readFile(fileURLToPath(new URL(path,import.meta.url)),'utf8'),type);}
    if(req.headers.origin&&req.headers.origin!==origin)return reply(403,{error:'Invalid origin'});
    const token=req.headers.authorization?.replace(/^Bearer /,'');
    if(url.pathname!=='/auth'){
      try{await auth.authorize(token);}catch{return reply(401,{error:'Access denied; reopen Voice'});}
      if((sessionId||starting)&&sessionToken!==token)return reply(409,{error:'Voice is active in another tab'});
    }
    if(req.method==='GET'&&url.pathname==='/status'){
      lastBrowserSeen=Date.now();return reply(200,{agent:profile.agent,ready:true,sessionId,tools:profile.tools,history:saved,events:events.filter(e=>e.seq>Number(url.searchParams.get('after')||0))});
    }
    if(req.method!=='POST'||req.headers.origin!==origin)return reply(403,{error:'Expected same-origin POST'});
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>110000)return reply(413,{error:'Request too large'});}
    const input=JSON.parse(raw||'{}');
    if(url.pathname==='/auth'){try{return reply(200,await auth.login(input));}catch{return reply(401,{error:'Access denied; reopen Voice'});}}
    if(url.pathname==='/session'){
      if(sessionId||starting)return reply(409,{error:'A session is already active'});
      starting=true;sessionToken=token;lastBrowserSeen=Date.now();
      try{const result=await request('start',{sdp:input.sdp,resume:input.resume!==false});sessionId=result.sessionId;saved=await request('history');return reply(201,result);}finally{starting=false;}
    }
    if(url.pathname==='/stop'){
      const result=sessionId||starting?await request('stop'):{stopped:true};sessionId=undefined;saved=await request('history');return reply(200,result);
    }
    return reply(404,{error:'Not found'});
  }catch{reply(400,{error:'Voice request failed'});}
});
server.requestTimeout=10000;server.headersTimeout=10000;
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
const lease=setInterval(()=>{
  if(!sessionId)return;
  void (async()=>{let method='ping';try{await auth.authorize(sessionToken);}catch{method='stop';}if(Date.now()-lastBrowserSeen>15000)method='stop';await request(method);if(method==='stop')sessionId=undefined;})().catch(()=>append({type:'error',message:'Voice connection unavailable'}));
},5000);
return {server,append,authorizeActive:()=>auth.authorize(sessionToken),close:async()=>{clearInterval(lease);if(sessionId||starting)await request('stop').catch(()=>{});await new Promise(resolve=>server.close(resolve));}};
}
