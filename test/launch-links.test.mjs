import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchLinks } from '../src/launch-links.mjs';
import { WebAuth } from '../src/web-auth.mjs';

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

test('discussion ticket selects only its server principal and rechecks grant revocation',async t=>{
  const f=await fixture(t);let active=true;
  const task={taskId:'task_'+'a'.repeat(32),taskToken:'b'.repeat(64),expiresAt:1201000};
  const validateTask=async value=>{assert.deepEqual(value,task);if(!active)throw Error('Discussion revoked');};
  const auth=new WebAuth({origin:f.origin,links:f.links,readOwner:async()=>null,now:()=>1000,validateTask});
  const ticket=ticketOf(await f.links.issue(null,task));
  const session=await auth.login({ticket});
  assert.deepEqual(auth.principal(session.token),{task});
  assert(!JSON.stringify(session).includes(task.taskToken));
  assert.equal(await auth.authorize(session.token),session.token);
  await assert.rejects(auth.login({ticket}));
  active=false;await assert.rejects(auth.authorize(session.token),/revoked/);
});

test('browser history and events never cross discussion principals or owner',async t=>{
  const {serveWeb}=await import('../src/web-server.mjs');const http=await import('node:http');
  const f=await fixture(t), task={taskId:'task_'+'c'.repeat(32),taskToken:'d'.repeat(64),expiresAt:1201000};
  const auth=new WebAuth({origin:f.origin,links:f.links,readOwner:async()=>f.owner,now:()=>1000,validateTask:async()=>{}});
  const own=await auth.login({ticket:ticketOf(await f.links.issue(f.owner))});
  const discussion=await auth.login({ticket:ticketOf(await f.links.issue(null,task))});
  const web=await serveWeb({origin:f.origin,auth,port:0,host:'127.0.0.1',request:async(method,params)=>method==='context'?{agent:'Fixture',tools:[]}:method==='history'?{messages:[{text:params?.task?'discussion':'private owner'}]}:{sessionId:'test'}});
  t.after(()=>web.close());
  const status=token=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:web.server.address().port,path:'/status',headers:{host:'voice.example',authorization:'Bearer '+token}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve(JSON.parse(raw)));});req.on('error',reject);req.end();});
  web.append({type:'transcript',text:'old private voice'});
  assert.deepEqual((await status(discussion.token)).history.messages,[{text:'discussion'}]);
  assert.deepEqual((await status(discussion.token)).events,[]);
  assert.deepEqual((await status(own.token)).history.messages,[{text:'private owner'}]);
});
