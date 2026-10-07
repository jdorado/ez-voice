import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir, stat, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchLinks, heartbeatLifetime } from '../src/launch-links.mjs';
import { WebAuth } from '../src/web-auth.mjs';

const bin=new URL('../bin/ez-voice.mjs',import.meta.url).pathname;
async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), 'voice-link-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  let clock = 1000, owner = { telegramUserId: 42, pairedAt: 'epoch' };
  const origin = 'https://voice.example';
  const links = new LaunchLinks(state, { now: () => clock });
  await links.bind(origin);
  const auth = new WebAuth({ origin, links, readOwner: async () => owner, now: () => clock });
  return {state, links, auth, origin, get owner() { return owner; }, set owner(v) { owner = v; }, advance(ms) { clock += ms; }};
}
const ticketOf = value => value.url.split('#launch=')[1];
test('owner link remains out of HTTP URL; private hash-only state, current owner and single use', async t => {
  const f = await fixture(t), link = await f.links.issue(f.owner), ticket = ticketOf(link);
  assert.equal(new URL(link.url).pathname, '/');
  assert.equal(new URL(link.url).search, '');
  const file = (await readdir(join(f.state,'launch-links'))).find(n => /^[a-f0-9]{64}\.json$/.test(n));
  assert(!file.includes(ticket));
  assert(!(await readFile(join(f.state,'launch-links',file),'utf8')).includes(ticket));
  assert.equal((await stat(join(f.state,'launch-links',file))).mode & 0o777, 0o600);
  const { token } = await f.auth.login({ ticket });
  assert.equal(await f.auth.authorize(token), token);
  await assert.rejects(f.auth.login({ticket}));
  f.owner = {...f.owner, pairedAt:'revoked'};
  await assert.rejects(f.auth.authorize(token), /revoked/);
});
test('expired, wrong owner, wrong origin and invalid tickets fail closed', async t => {
  const f=await fixture(t), ticket=ticketOf(await f.links.issue(f.owner));
  await assert.rejects(f.links.issue(null));
  await assert.rejects(f.links.bind('http://127.0.0.1:8791'));
  await assert.rejects(f.links.redeem(ticket,{telegramUserId:43,pairedAt:'epoch'},f.origin));
  await assert.rejects(f.links.redeem(ticket,f.owner,'https://other.example'));
  await assert.rejects(f.auth.login({ticket:'bad'}));
  await assert.rejects(f.auth.login({token:ticket}));
  f.advance(300000);
  await assert.rejects(f.auth.login({ticket}));
});
test('concurrent redemption across separate auth instances admits exactly one session', async t => {
  const f=await fixture(t), ticket=ticketOf(await f.links.issue(f.owner));
  const second=new WebAuth({origin:f.origin,links:new LaunchLinks(f.state,{now:()=>1000}),readOwner:async()=>f.owner,now:()=>1000});
  const results=await Promise.allSettled([f.auth.login({ticket}),second.login({ticket})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
});
test('restart preserves outstanding tickets; relink revokes them; session expires after twenty minutes',async t=>{
  const f=await fixture(t), ticket=ticketOf(await f.links.issue(f.owner));
  f.owner={...f.owner,pairedAt:'new'};
  await assert.rejects(f.auth.login({ticket}));
  const fresh=ticketOf(await f.links.issue(f.owner));
  const {token}=await f.auth.login({ticket:fresh});
  f.advance(1200000);
  await assert.rejects(f.auth.authorize(token),/expired/);
});

test('link previews and unauthorized HTTP cannot redeem; same-origin explicit POST exchanges once', async t => {
  const {serveWeb}=await import('../src/web-server.mjs');
  const http=await import('node:http');
  const f=await fixture(t), ticket=ticketOf(await f.links.issue(f.owner));
  const web=await serveWeb({origin:f.origin,auth:f.auth,port:0,host:'127.0.0.1',request:async method=>method==='context'?{agent:'Fixture',tools:[]}:{messages:[]}});
  t.after(()=>web.close());
  const call=(path,method='GET',body,origin=f.origin)=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:web.server.address().port,path,method,headers:{host:'voice.example',origin}},res=>{
      let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,raw,headers:res.headers}));
    });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  const preview=await call('/');assert.equal(preview.status,200);
  assert.equal(preview.headers['referrer-policy'],'no-referrer');
  assert(!preview.raw.includes('telegram-web-app.js'));
  assert.equal((await call('/auth')).status,403);
  assert.equal((await call('/auth','POST',{ticket},'https://evil.example')).status,403);
  assert.equal((await call('/auth','POST',{ticket})).status,200);
  assert.equal((await call('/auth','POST',{ticket})).status,401);
});

test('issue writes tickets atomically via temp file and never leaves temp litter', async t => {
  const f=await fixture(t);
  await f.links.issue(f.owner);
  const names=await readdir(join(f.state,'launch-links'));
  assert(!names.some(n=>n.endsWith('.tmp')||n.endsWith('.used')));
  assert.equal(names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).length,1);
});
test('sweeper skips unparseable ticket files, drops expired ones and ages out stale tmp/used litter', async t => {
  const f=await fixture(t), root=join(f.state,'launch-links');
  const partial=join(root,'a'.repeat(64)+'.json'), expired=join(root,'b'.repeat(64)+'.json');
  const oldTmp=join(root,'old.tmp'), oldUsed=join(root,'old.used'), freshTmp=join(root,'fresh.tmp');
  await writeFile(partial,'{"key":'); await writeFile(expired,JSON.stringify({key:'k',origin:f.origin,expiresAt:1}));
  for(const p of [oldTmp,oldUsed,freshTmp]) await writeFile(p,'x');
  const old=new Date(Date.now()-120000);
  await utimes(oldTmp,old,old); await utimes(oldUsed,old,old);
  await f.links.issue(f.owner);
  assert.equal(await readFile(partial,'utf8'),'{"key":');
  await assert.rejects(stat(expired),{code:'ENOENT'});
  await assert.rejects(stat(oldTmp),{code:'ENOENT'});
  await assert.rejects(stat(oldUsed),{code:'ENOENT'});
  assert((await stat(freshTmp)).isFile());
});
test('bind clears expired tickets and tickets for another origin but keeps current ones', async t => {
  const f=await fixture(t), root=join(f.state,'launch-links');
  const keep=ticketOf(await f.links.issue(f.owner));
  const other=join(root,'c'.repeat(64)+'.json'), expired=join(root,'d'.repeat(64)+'.json');
  await writeFile(other,JSON.stringify({key:'k',origin:'https://other.example',expiresAt:99999999}));
  await writeFile(expired,JSON.stringify({key:'k',origin:f.origin,expiresAt:1}));
  await f.links.bind(f.origin);
  await assert.rejects(stat(other),{code:'ENOENT'});
  await assert.rejects(stat(expired),{code:'ENOENT'});
  assert((await f.auth.login({ticket:keep})).token);
});
test('issue refuses an unbound, stopped or heartbeat-stale web service and recovers on heartbeat', async t => {
  const state=await mkdtemp(join(tmpdir(),'voice-link-')); t.after(()=>rm(state,{recursive:true,force:true}));
  let clock=1000; const links=new LaunchLinks(state,{now:()=>clock}), owner={telegramUserId:42,pairedAt:'epoch'};
  await assert.rejects(links.issue(owner),/web service is not running/);
  await links.bind('https://voice.example'); await links.issue(owner);
  clock+=heartbeatLifetime+1;
  await assert.rejects(links.issue(owner),/no recent heartbeat/);
  await links.heartbeat('https://voice.example'); await links.issue(owner);
  await links.unbind();
  await assert.rejects(links.issue(owner),/web service is not running/);
});
test('outstanding links are capped at 32 and the cap holds under concurrent issue()', async t => {
  const f=await fixture(t);
  const results=await Promise.allSettled(Array.from({length:40},()=>f.links.issue(f.owner)));
  const ok=results.filter(r=>r.status==='fulfilled'), bad=results.filter(r=>r.status==='rejected');
  assert.equal(ok.length,32); assert.equal(bad.length,8);
  for(const r of bad) assert.match(r.reason.message,/Too many outstanding links/);
  assert.equal(new Set(ok.map(r=>ticketOf(r.value))).size,32);
  assert.equal((await readdir(join(f.state,'launch-links'))).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).length,32);
  f.advance(300001); await f.links.heartbeat(f.origin);
  assert((await f.links.issue(f.owner)).url);
});
test('launchConnect issues a link for the owner reported by core and surfaces a dead web service', async t => {
  const state=await mkdtemp(join(tmpdir(),'voice-launch-')); t.after(()=>rm(state,{recursive:true,force:true}));
  const origin='https://voice.example', owner={telegramUserId:42,pairedAt:'epoch'};
  const run=(answer=owner)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[bin,'launch'],{env:{...process.env,EZ_VOICE_STATE:state}});
    let out='',err='';child.stdout.on('data',d=>{out+=d;
      for(const line of out.split('\n').filter(Boolean)){const frame=JSON.parse(line);
        if(frame.coreRequest){assert.equal(frame.coreRequest.method,'tools.owner');out='';child.stdin.write(JSON.stringify({coreResponse:{id:frame.coreRequest.id,result:answer}})+'\n');}}});
    child.stderr.on('data',d=>err+=d);child.on('error',reject);
    child.on('close',code=>resolve({code,out,err}));
  });
  const dead=await run();
  assert.equal(dead.code,2);assert.match(dead.err,/web service is not running/);
  await new LaunchLinks(state).bind(origin);
  const live=await run();
  assert.equal(live.code,0,live.err);
  const {launch}=JSON.parse(live.out.trim().split('\n').pop());
  assert.match(launch.url,new RegExp('^'+origin+'/#launch=[a-f0-9]{64}$'));assert(launch.expiresAt>Date.now());
  const unpaired=await run(null);
  assert.equal(unpaired.code,2);assert.match(unpaired.err,/Paired owner unavailable/);
});
test('launch CLI rejects identity and origin arguments without issuing anything', async t => {
  const state=await mkdtemp(join(tmpdir(),'voice-launch-')); t.after(()=>rm(state,{recursive:true,force:true}));
  await new LaunchLinks(state).bind('https://voice.example');
  for(const args of [['--origin','https://evil.example'],['--owner','1'],['extra']]){
    const r=spawnSync(process.execPath,[bin,'launch',...args],{env:{...process.env,EZ_VOICE_STATE:state},encoding:'utf8',input:''});
    assert.equal(r.status,2);assert.match(r.stderr,/launch accepts no identity or origin arguments/);
  }
  assert.deepEqual((await readdir(join(state,'launch-links'))).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)),[]);
});
test('configure validates followOwner as a boolean and stores it only when boolean', async t => {
  const state=await mkdtemp(join(tmpdir(),'voice-cli-')); t.after(()=>rm(state,{recursive:true,force:true}));
  const base={apiKey:'sk-private-fixture-key',agentUrl:'http://relay:8787',agentToken:'x'.repeat(48)};
  const run=config=>spawnSync(process.execPath,[bin,'configure'],{env:{...process.env,EZ_VOICE_STATE:state},input:JSON.stringify(config),encoding:'utf8'});
  for(const bad of ['true','yes',1,null,{}]){
    const r=run({...base,followOwner:bad});assert.equal(r.status,2,String(bad));assert.match(r.stderr,/followOwner must be boolean/);
  }
  await assert.rejects(readFile(join(state,'config.json')),{code:'ENOENT'});
  assert.equal(run({...base,followOwner:true}).status,0);
  assert.equal(JSON.parse(await readFile(join(state,'config.json'),'utf8')).followOwner,true);
  assert.equal(run({...base,followOwner:false}).status,0);
  assert.equal(JSON.parse(await readFile(join(state,'config.json'),'utf8')).followOwner,false);
});
