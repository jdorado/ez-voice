import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreTools } from '../src/plugin-tools.mjs';

test('core owner request is correlated and cancellation stays on the control channel',async()=>{
  const frames=[],socket={destroyed:false,writable:true,write:value=>frames.push(JSON.parse(value))},core=new CoreTools(socket);
  const result=core.request('tools.owner',{});const request=frames[0].coreRequest;
  core.receive({coreResponse:{id:'other',result:'ignored'}});core.receive({coreResponse:{id:request.id,result:{telegramUserId:42}}});
  assert.deepEqual(await result,{telegramUserId:42});
  const controller=new AbortController(),pending=core.request('tools.owner',{},controller.signal);controller.abort();
  await assert.rejects(pending,/cancelled/);assert.equal(frames.at(-1).coreCancel.id,frames.at(-2).coreRequest.id);
});
