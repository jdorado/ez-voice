import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {httpTools, phonePlugins, validateBinding} from '../src/phone-plugin-tools.mjs';
import {validatePhoneConfig} from '../src/phone.mjs';

const TOKEN = 'tok-' + 'r'.repeat(28);
const SCHEMAS = {tools: [{type: 'function', name: 'read_record', description: 'Read', parameters: {type: 'object'}}]};
const call = {id: 'CA' + '7'.repeat(32), remote: '+15551230002', line: '+15551230001', direction: 'in', started_at: '2026-11-05T12:00:00.000Z'};

// A real backend: GET answers the schemas, POST answers `read(body)` (undefined: never answers); every request is kept.
async function backend(t, read = body => ({call_id: body.call.id, turn: body.turn, record: 'data'}), schemas = SCHEMAS) {
  const seen = [];
  const server = createServer((request, response) => { let body = ''; request.on('data', c => body += c).on('end', async () => {
    const parsed = body ? JSON.parse(body) : undefined;
    seen.push({method: request.method, authorization: request.headers.authorization, body: parsed});
    const out = request.method === 'GET' ? schemas : await read(parsed);
    if (out === undefined) return;
    response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify(out));
  }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return {seen, binding: {url: `http://127.0.0.1:${server.address().port}/agent/call/read`, token: TOKEN, deadlineMs: 1500}};
}

test('the schemas and each read go to the backend with the bearer token, the identity from the call, never the model', async t => {
  const {seen, binding} = await backend(t);
  const info = await httpTools(binding);
  assert.deepEqual(info.tools, SCHEMAS.tools); assert.equal(info.deadlineMs, 1500);
  const out = await info.run(call, 4, 'read_record', {ref: 'other', call: {id: 'FORGED'}, argv: ['send']});
  assert.equal(out.record, 'data');
  assert.deepEqual(seen.map(s => [s.method, s.authorization]), [['GET', 'Bearer ' + TOKEN], ['POST', 'Bearer ' + TOKEN]]);
  // the domain schema rejects the forged field; it cannot alter the transport's identity
  assert.deepEqual(seen[1].body, {call, turn: 4, name: 'read_record', arguments: {ref: 'other', call: {id: 'FORGED'}, argv: ['send']}});
  assert.deepEqual(await info.run(call, 4, 'send_sms', {}), {status: 'unavailable', error: 'unknown_tool'});
  assert.equal(seen.length, 2); // an unknown tool is never sent
});

test('an answer bound to a different call or turn is refused', async t => {
  const {binding} = await backend(t, body => ({call_id: 'other', turn: body.turn}));
  const info = await httpTools(binding);
  await assert.rejects(info.run(call, 1, 'read_record', {}), /binding mismatch/);
});

test('a failed, oversized or redirecting backend is a failure, and a read stops when its signal aborts', async t => {
  for (const [status, headers] of [[500, {}], [302, {location: 'http://127.0.0.1:9/'}]]) {
    const server = createServer((request, response) => {
      if (request.method === 'GET') { response.writeHead(200); response.end(JSON.stringify(SCHEMAS)); } else { response.writeHead(status, headers); response.end('{}'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const info = await httpTools({url: `http://127.0.0.1:${server.address().port}/r`, token: TOKEN, deadlineMs: 1500});
    await assert.rejects(info.run(call, 1, 'read_record', {}));
  }
  const big = await backend(t, body => ({call_id: body.call.id, turn: body.turn, record: 'x'.repeat(130000)}));
  await assert.rejects((await httpTools(big.binding)).run(call, 1, 'read_record', {}));
  const hung = await backend(t, () => undefined);
  const info = await httpTools(hung.binding), abort = new AbortController();
  setTimeout(() => abort.abort(), 50);
  const began = Date.now();
  await assert.rejects(info.run(call, 1, 'read_record', {}, abort.signal));
  assert.ok(Date.now() - began < 1000);
});

test('invalid schemas, an unreachable backend at start, and the removed alias form are refused', async t => {
  const bad = await backend(t, undefined, {tools: [{type: 'function', name: 'end_call', description: 'x', parameters: {type: 'object'}}]});
  await assert.rejects(httpTools(bad.binding), /Invalid phone tool schemas/);
  await assert.rejects(httpTools({url: 'http://127.0.0.1:9/r', token: TOKEN, deadlineMs: 500}));
  assert.throws(() => validateBinding({alias: 'quarre', schemas: ['call', 'tools'], invoke: ['call', 'read', '-']}), /toolBinding is now \{url, token, deadlineMs\}.*alias\/invoke/);
  for (const value of [{url: 'ftp://x/', token: TOKEN, deadlineMs: 1500}, {url: 'http://u:p@x/', token: TOKEN, deadlineMs: 1500},
    {url: 'http://x/', token: 'short', deadlineMs: 1500}, {url: 'http://x/', token: TOKEN, deadlineMs: 20000}, {url: 'http://x/', token: TOKEN, deadlineMs: 1500, shell: 'send'}]) {
    assert.throws(() => validateBinding(value), /Invalid phone tool binding/);
  }
  assert.throws(() => validatePhoneConfig({apiKey: 'sk-synthetic123456789', accountSid: 'AC' + '1'.repeat(32), authToken: '2'.repeat(32), number: '+15551230001',
    origin: 'https://phone.example.com', instructions: 'x', toolBinding: {alias: 'quarre', schemas: ['tools'], invoke: ['read']}}), /toolBinding is now/);
});

test('the information tools need no Ez connection', async t => {
  const {binding} = await backend(t);
  const before = ['data', 'end', 'readable'].map(event => process.stdin.listenerCount(event));
  const out = await phonePlugins(binding, null, null);
  assert.deepEqual(['data', 'end', 'readable'].map(event => process.stdin.listenerCount(event)), before);
  assert.deepEqual(out.information.tools, SCHEMAS.tools); assert.equal(out.advisor, undefined);
});
