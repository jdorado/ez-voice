import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchLinks } from '../src/launch-links.mjs';
import { WebAuth } from '../src/web-auth.mjs';
import { serveWeb } from '../src/web-server.mjs';

const root = new URL('..', import.meta.url).pathname, bin = join(root, 'bin/ez-voice.mjs');
const origin = 'https://voice.example';
const owner = { telegramUserId: 42, pairedAt: 'epoch' };
const makeTask = (c, expiresAt = Date.now() + 600000) => ({ taskId: 'task_' + c.repeat(32), taskToken: c.repeat(64), expiresAt });
const ticketOf = value => value.url.split('#launch=')[1];
const tmp = async (t, prefix) => { const dir = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const ticketFiles = async state => (await readdir(join(state, 'launch-links'))).filter(n => /^[a-f0-9]{64}\.json$/.test(n));

// A registration endpoint standing in for the Ez application: it vouches for exactly the tasks it is given.
async function registry(t, tasks) {
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
      const task = tasks.find(x => x.taskToken === JSON.parse(raw || '{}').taskToken);
      res.writeHead(task ? 200 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(task ? { taskId: task.taskId, expiresAt: task.expiresAt } : { error: 'denied' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return 'http://127.0.0.1:' + server.address().port;
}
async function configured(t, agentUrl) {
  const state = await tmp(t, 'voice-disc-');
  await writeFile(join(state, 'config.json'), JSON.stringify({ apiKey: 'sk-private-fixture-key', agentUrl, agentToken: 'x'.repeat(48) }));
  return state;
}
// Async: the in-process registry must keep serving while the CLI runs.
const launch = (state, input, args = ['--task']) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [bin, 'launch', ...args], { env: { ...process.env, EZ_VOICE_STATE: state } });
  let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
  child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr })); child.stdin.end(input);
});

test('launch --task issues a discussion ticket only for a registered grant and stores no owner key', async t => {
  const task = makeTask('a'), url = await registry(t, [task]), state = await configured(t, url);
  const dead = await launch(state, JSON.stringify(task));
  assert.equal(dead.status, 2); assert.match(dead.stderr, /web service is not running/);
  await new LaunchLinks(state).bind(origin);
  const ok = await launch(state, JSON.stringify(task));
  assert.equal(ok.status, 0, ok.stderr);
  const { launch: link } = JSON.parse(ok.stdout);
  assert.match(link.url, new RegExp('^' + origin + '/#launch=[a-f0-9]{64}$'));
  const [file] = await ticketFiles(state), record = JSON.parse(await readFile(join(state, 'launch-links', file), 'utf8'));
  assert.deepEqual(record.task, task); assert.equal(record.key, undefined); assert.equal((await stat(join(state, 'launch-links', file))).mode & 0o777, 0o600);
  for (const bad of [{ ...task, taskToken: 'f'.repeat(64) }, { ...task, expiresAt: task.expiresAt + 1 }, { ...task, extra: 1 }, makeTask('b', Date.now() - 1), 'nope']) {
    const r = await launch(state, JSON.stringify(bad)); assert.equal(r.status, 2, JSON.stringify(bad));
  }
  assert.equal((await ticketFiles(state)).length, 1);
  const extra = await launch(state, JSON.stringify(task), ['--task', 'x']); assert.equal(extra.status, 2); assert.match(extra.stderr, /launch accepts no identity or origin arguments/);
});

async function webFixture(t) {
  const state = await tmp(t, 'voice-disc-');
  let clock = Date.now(), ownerReads = 0;
  const A = makeTask('a', clock + 600000), B = makeTask('b', clock + 600000), links = new LaunchLinks(state, { now: () => clock });
  await links.bind(origin);
  const revoked = new Set();
  const auth = new WebAuth({ origin, links, now: () => clock,
    readOwner: async () => { ownerReads++; return owner; },
    validateTask: async task => { if (revoked.has(task.taskId)) throw Error('revoked'); } });
  // Mock core keyed on the task ID: a discussion principal only ever reaches its own history and starts.
  const histories = new Map([['owner', [{ text: 'private owner note' }]], [A.taskId, [{ text: 'discussion A' }]], [B.taskId, [{ text: 'discussion B' }]]]);
  const calls = [];
  const request = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'context') return { agent: 'Owner Agent Name', tools: [{ name: 'native_agent' }] };
    if (method === 'history') return { messages: histories.get(params.task ? params.task.taskId : 'owner') };
    if (method === 'start') return { sessionId: 'session-' + (params.task?.taskId ?? 'owner'), sdp: 'v=0' };
    return { stopped: true };
  };
  const web = await serveWeb({ origin, auth, request, port: 0, host: '127.0.0.1' });
  t.after(() => web.close());
  const call = (path, method = 'GET', body, token) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: web.server.address().port, path, method,
      headers: { host: 'voice.example', origin, ...(token ? { authorization: 'Bearer ' + token } : {}) } }, res => {
      let raw = ''; res.on('data', b => raw += b); res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const login = async value => { const r = await call('/auth', 'POST', { ticket: ticketOf(await links.issue(...value)) }); assert.equal(r.status, 200); return r.body.token; };
  return { state, links, A, B, auth, call, login, calls, revoked, advance: ms => { clock += ms; }, get ownerReads() { return ownerReads; } };
}

test('task links redeem over HTTP without reading the owner; /status shows generic Ez, never the owner agent name', async t => {
  const f = await webFixture(t);
  const ticket = ticketOf(await f.links.issue(null, f.A));
  const redeemed = await f.call('/auth', 'POST', { ticket });
  assert.equal(redeemed.status, 200); assert(!JSON.stringify(redeemed.body).includes(f.A.taskToken));
  assert.equal(f.ownerReads, 0);
  assert.equal((await f.call('/auth', 'POST', { ticket })).status, 401);
  const status = await f.call('/status', 'GET', undefined, redeemed.body.token);
  assert.equal(status.status, 200); assert.equal(status.body.agent, 'Ez'); assert.deepEqual(status.body.tools, [{ name: 'native_agent' }]);
  assert(!JSON.stringify(status.body).includes('Owner Agent Name'));
  const ownerToken = await f.login([owner]);
  assert.equal(f.ownerReads, 1); // owner tickets alone consult the owner
  assert.equal((await f.call('/status', 'GET', undefined, ownerToken)).body.agent, 'Owner Agent Name');
});

test('with a core keyed on task ID, discussion A cannot read B or the owner, and revocation cuts it off', async t => {
  const f = await webFixture(t);
  const a = await f.login([null, f.A]), ownerToken = await f.login([owner]);
  const text = async token => (await f.call('/status', 'GET', undefined, token)).body.history.messages[0].text;
  assert.equal(await text(a), 'discussion A');
  assert.equal(await text(ownerToken), 'private owner note');
  await f.call('/stop', 'POST', {}, ownerToken);
  const b = await f.login([null, f.B]);
  assert.equal(await text(b), 'discussion B');
  assert.equal(await text(a), 'discussion A');
  const status = f.calls.filter(c => c.method === 'history').map(c => c.params.task?.taskId ?? 'owner');
  assert(status.includes(f.A.taskId) && status.includes(f.B.taskId) && status.includes('owner'));
  // The browser cannot choose its principal: a task field in the request body is ignored.
  const started = await f.call('/session', 'POST', { sdp: 'v=0\r\n', task: f.B }, a);
  assert.equal(started.status, 201); assert.equal(started.body.sessionId, 'session-' + f.A.taskId);
  assert.deepEqual(f.calls.findLast(c => c.method === 'start').params.task, f.A);
  assert.equal((await f.call('/status', 'GET', undefined, b)).status, 409);
  f.revoked.add(f.A.taskId);
  assert.equal((await f.call('/status', 'GET', undefined, a)).status, 401);
});

test('expired task tickets, including the stored bearer, are swept by redeem and bind; task type is checked before consumption', async t => {
  const f = await webFixture(t), files = () => ticketFiles(f.state);
  const dead = ticketOf(await f.links.issue(null, f.A)), other = ticketOf(await f.links.issue(null, f.B));
  assert.equal((await files()).length, 2);
  f.advance(300001);
  await assert.rejects(f.links.redeem(dead, null, origin, async () => {}), /Expired or revoked/);
  assert.equal((await files()).length, 0); // redeem swept both expired tickets
  const shortGrant = { ...f.A, expiresAt: Date.now() + 1000 };
  await f.links.heartbeat(origin);
  await f.links.issue(null, shortGrant); // ticket lives 5 min but its grant ends sooner
  f.advance(299000); await f.links.heartbeat(origin);
  const ticket = ticketOf(await f.links.issue(null, f.B));
  await f.links.bind(origin);
  assert.equal((await files()).length, 1); // bind dropped the ticket whose bearer grant expired
  assert(!(await readFile(join(f.state, 'launch-links', (await files())[0]), 'utf8')).includes(shortGrant.taskToken));
  // A task ticket without a validator is refused before it is consumed, and an owner is never consulted.
  let consulted = false;
  await assert.rejects(f.links.redeem(ticket, () => { consulted = true; return owner; }, origin), /Discussion access unavailable/);
  assert.equal(consulted, false); assert.equal((await files()).length, 1);
  // An owner ticket with the wrong owner is refused before it is consumed.
  const ownerTicket = ticketOf(await f.links.issue(owner));
  await assert.rejects(f.links.redeem(ownerTicket, { telegramUserId: 43, pairedAt: 'epoch' }, origin), /Expired or revoked/);
  assert.equal((await f.links.redeem(ownerTicket, async () => owner, origin)).owner.telegramUserId, 42);
  void other;
});

// A real service process whose provider call never completes: an owner call is "active" while starting.
async function service(t) {
  const task = makeTask('c'), state = await configured(t, 'http://relay:8787');
  await writeFile(join(state, 'agent.json'), JSON.stringify({ name: 'Owner Agent', purpose: 'Test' }));
  const preload = join(state, 'preload.mjs');
  await writeFile(preload, `const real=globalThis.fetch;
globalThis.fetch=async(url,options)=>{url=String(url);
  if(url.endsWith('/v1/registration'))return Response.json({taskId:process.env.T_ID,expiresAt:Number(process.env.T_EXP)});
  if(url.startsWith('https://api.openai.com/'))return new Promise((_,reject)=>options.signal?.addEventListener('abort',()=>reject(options.signal.reason)));
  return real(url,options);};`);
  const child = spawn(process.execPath, ['--import', preload, join(root, 'src/server.mjs')], { env: { ...process.env, EZ_VOICE_STATE: state, T_ID: task.taskId, T_EXP: String(task.expiresAt) }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => { child.stdout.on('data', d => String(d).includes('ready') && resolve()); child.once('exit', () => reject(Error('service exited'))); });
  const rpc = (frame) => new Promise((resolve, reject) => {
    const socket = net.connect(join(state, 'voice.sock'), () => socket.write(JSON.stringify(frame) + '\n'));
    let raw = ''; socket.on('data', d => { raw += d; if (raw.includes('\n')) resolve(JSON.parse(raw.split('\n')[0])); });
    socket.on('error', reject); t.after(() => socket.destroy());
  });
  return { task, rpc };
}
test('no discussion starts while an owner call is active, and no owner starts while a discussion is', async t => {
  const f = await service(t), sdp = 'v=0\r\n';
  const ownerStart = f.rpc({ id: 'owner', owner: 'a'.repeat(64), method: 'start', params: { sdp } });
  await new Promise(resolve => setTimeout(resolve, 300)); // owner startup is now holding the provider call
  const discussion = await f.rpc({ id: 'disc', owner: 'b'.repeat(64), method: 'start', params: { sdp, task: f.task } });
  assert.match(discussion.error, /already active/);
  const health = await f.rpc({ id: 'h', method: 'health' }); assert.equal(health.result.active, true);
  ownerStart.catch(() => {});
});
test('no owner starts while a discussion call is active', async t => {
  const f = await service(t), sdp = 'v=0\r\n';
  const discussionStart = f.rpc({ id: 'disc', owner: 'b'.repeat(64), method: 'start', params: { sdp, task: f.task } });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.match((await f.rpc({ id: 'owner', owner: 'a'.repeat(64), method: 'start', params: { sdp } })).error, /already active/);
  discussionStart.catch(() => {});
});
