import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { definitions, validateArguments } from '../src/tools.mjs';
import { argvFor } from '../examples/bindings.mjs';
const profile = JSON.parse(await readFile(new URL('../examples/library-profile.json', import.meta.url)));
test('exposes only schemas, never host commands or paths', () => {
  const tools = definitions(profile.tools);
  assert.equal(tools.length,3); assert.equal(tools[0].command,undefined); assert.equal(tools[0].args,undefined);
});
test('literal argv retains shell metacharacters as data', () => {
  const tool = profile.tools[0];
  assert.deepEqual(argvFor(tool,{query:'hello $(touch /tmp/bad); `whoami`'}), ['library','search','hello $(touch /tmp/bad); `whoami`','--library','default','--limit','5']);
  assert.throws(()=>argvFor(tool,{query:'--help'}));
});
test('rejects unknown, missing, oversized, null and prototype arguments', () => {
  const tool=profile.tools[0];
  for(const args of [{},{query:'a',command:'shell'},{query:'a'.repeat(501)},{query:null},JSON.parse('{"query":"a","__proto__":{}}')]) assert.throws(()=>validateArguments(tool,args));
});
test('duplicate tools and unbounded schemas rejected', () => {
  assert.throws(()=>definitions([profile.tools[0],profile.tools[0]]));
  assert.throws(()=>definitions([{...profile.tools[0],parameters:{type:'object',properties:{q:{type:'string'}},required:['q'],additionalProperties:false}}]));
});
