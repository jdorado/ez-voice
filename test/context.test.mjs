import test from 'node:test';
import assert from 'node:assert/strict';
import { agentContext } from '../src/context.mjs';

test('bound identity yields a short Live frontend prompt with native delegation',()=>{
  const value=agentContext({name:'test-agent',purpose:'Project assistant'});
  assert.equal(value.agent,'test-agent');assert.match(value.instructions,/native agent backend/);assert(value.instructions.length<1000);
  assert.throws(()=>agentContext({name:'',purpose:'x'}),/Bind/);
});
