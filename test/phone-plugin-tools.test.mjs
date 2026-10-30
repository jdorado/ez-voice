import test from 'node:test';
import assert from 'node:assert/strict';
import {installedTools, validateBinding} from '../src/phone-plugin-tools.mjs';

test('installed transport uses fixed literal command and trusted call outside model arguments', async () => {
  const requests = [];
  const core = {request: async (method, params) => {
    requests.push({method, params});
    return {code: 0, stdout: JSON.stringify(params.stdin ? {call_id: 'origin', turn: 4, record: 'data'} : {tools: [{type: 'function', name: 'read_record', description: 'Read', parameters: {type: 'object'}}]})};
  }};
  const binding = {alias: 'records', schemas: ['call','tools'], invoke: ['call','read','-']};
  const info = await installedTools(binding, core);
  await info.run({id: 'origin'}, 4, 'read_record', {ref: 'other', call: {id: 'FORGED'}, argv: ['send']});
  const req = requests[1]; assert.equal(req.method, 'tools.invoke'); assert.deepEqual(req.params.args, binding.invoke);
  const envelope = JSON.parse(req.params.stdin); assert.equal(envelope.call.id, 'origin'); assert.equal(envelope.turn, 4);
  assert.equal(envelope.arguments.call.id, 'FORGED'); // domain schema rejects this; it cannot alter transport identity
  assert.throws(() => validateBinding({...binding, shell: 'send'}));
});

test('a response bound to a different call or turn is refused', async () => {
  const core = {request: async (_, params) => ({code: 0, stdout: JSON.stringify(params.stdin ? {call_id: 'other', turn: 9} : {tools: [{type:'function',name:'read_record',description:'Read',parameters:{type:'object'}}]})})};
  const info = await installedTools({alias:'records',schemas:['tools'],invoke:['read','-']}, core);
  await assert.rejects(info.run({id:'origin'}, 1, 'read_record', {}), /binding mismatch/);
});
