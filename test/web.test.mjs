import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {telegramUser,WebAuth,webOrigin} from '../src/web-auth.mjs';
import {serveWeb} from '../src/web-server.mjs';
const {publicKey,privateKey}=generateKeyPairSync('ed25519'),botId='12345';
const now=Date.now();
function launch({id=42,date=Math.floor(now/1000),bot=botId}={}) {
  const data=new URLSearchParams({auth_date:String(date),user:JSON.stringify({id,first_name:'Owner'}),query_id:'fixture'});
  const check=[...data].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
  data.set('signature',sign(null,Buffer.from(`${bot}:WebAppData\n${check}`),privateKey).toString('base64url'));return data.toString();
}
const verifyUser=(data,id,options)=>telegramUser(data,id,{...options,key:publicKey});
test('Telegram signature binds user, bot and launch age; rejects duplicates and tampering',()=>{
  const data=launch();assert.equal(verifyUser(data,botId,{now}),42);
  for(const invalid of [data+'&user=x',data.replace('fixture','tampered'),launch({date:Math.floor(now/1000)-301}),launch({date:Math.floor(now/1000)+31}),launch({id:-1}),launch({id:1.5}),launch({bot:'999'})])assert.throws(()=>verifyUser(invalid,botId,{now}));
  assert.throws(()=>telegramUser(data,botId,{now})); // Production key cannot accept a synthetic signature.
  assert.throws(()=>verifyUser('',botId,{now}));
  for(const origin of ['http://example.com','https://user:pass@example.com','https://example.com/path'])assert.throws(()=>webOrigin(origin));
});
test('owner-only login, replay protection, expiry and live revocation',async()=>{
  let owner={telegramUserId:42,pairedAt:'epoch'},clock=now;
  const auth=new WebAuth({origin:'https://voice.example',botId,readOwner:async()=>owner,now:()=>clock,verifyUser});
  await assert.rejects(auth.login({initData:launch({id:43})}),/paired owner/);
  await assert.rejects(auth.login({token:'a'.repeat(64)}));
  const {token}=await auth.login({initData:launch()});assert.equal(await auth.authorize(token),token);
  await assert.rejects(auth.login({initData:launch()}),/already used/);
  await assert.rejects(auth.login({initData:launch()+'&hash=changed'}),/already used/);
  owner={...owner,pairedAt:'new epoch'};await assert.rejects(auth.authorize(token),/revoked/);
  owner=null;await assert.rejects(auth.login({initData:launch()}),/paired owner/);
  const local=new WebAuth({origin:'http://127.0.0.1:8791',readOwner:async()=>null,now:()=>clock});
  const secret=local.localToken,{token:localSession}=await local.login({token:secret});
  await assert.rejects(local.login({token:secret}));clock+=1200001;await assert.rejects(local.authorize(localSession),/expired/);
});
test('HTTP protects history and controls; expiry stops active voice; no browser tool passthrough',async t=>{
  let clock=now;const origin='http://127.0.0.1:8791';
  const auth=new WebAuth({origin,now:()=>clock,readOwner:async()=>null});
  const calls=[];
  const web=await serveWeb({origin,auth,port:0,host:'127.0.0.1',request:async(method,params)=>{
    calls.push([method,params]);if(method==='context')return {agent:'Fixture',tools:[]};if(method==='history')return {messages:[]};if(method==='start')return {sessionId:'one',sdp:'answer'};return {stopped:true};
  }});t.after(()=>web.close());
  const base=`http://127.0.0.1:${web.server.address().port}`;
  const request=(path,{body,token,originHeader=origin,host='127.0.0.1:8791'}={})=>new Promise((resolve,reject)=>{
    const req=http.request(base+path,{method:body===undefined?'GET':'POST',headers:{host,origin:originHeader,...(token?{authorization:`Bearer ${token}`}:{})}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,json:()=>JSON.parse(text)}));});
    req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  assert.equal((await request('/')).status,200);
  assert.equal((await request('/status')).status,401);
  assert.equal((await request('/session',{body:{sdp:'x'}})).status,401);
  assert.equal((await request('/auth',{body:{token:auth.localToken},originHeader:'https://evil.example'})).status,403);
  assert.equal((await request('/auth',{body:{token:auth.localToken},host:'evil.example'})).status,403);
  const logged=await request('/auth',{body:{token:auth.localToken}});assert.equal(logged.status,200);const {token}=await logged.json();
  assert.equal((await request('/status',{token})).status,200);
  assert.equal((await request('/session',{token,body:{sdp:'offer',tools:['forged'],owner:'forged'}})).status,201);
  assert.deepEqual(calls.find(([method])=>method==='start')[1],{sdp:'offer',resume:true});
  assert.equal((await request('/tools',{token,body:{coreRequest:{}}})).status,404);
  assert.equal((await request('/stop',{body:{}})).status,401);
  clock+=1200001;assert.equal((await request('/status',{token})).status,401);
  await new Promise(resolve=>setTimeout(resolve,5100));assert(calls.some(([method])=>method==='stop'));
});

test('occupied web port rejects startup without leaving a lease timer',async()=>{
  const occupied=http.createServer();await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));
  try {
    await assert.rejects(serveWeb({origin:'http://127.0.0.1:8791',port:occupied.address().port,host:'127.0.0.1',auth:{},request:async method=>method==='context'?{agent:'fixture',tools:[]}:{messages:[]}}),{code:'EADDRINUSE'});
  }finally{await new Promise(resolve=>occupied.close(resolve));}
});
