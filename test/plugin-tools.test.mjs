import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {CoreTools} from '../src/plugin-tools.mjs';
test('plugin adapter forwards generic core discovery/invocation; ignores unrelated results and cancels',async()=>{
 const socket=new PassThrough();const frames=[];socket.on('data',b=>frames.push(JSON.parse(b.toString())));
 const core=new CoreTools(socket);const controller=new AbortController();
 const result=core.execute({name:'plugins_list',arguments:{}},controller.signal);
 const request=frames[0].coreRequest;assert.equal(request.method,'tools.list');
 core.receive({coreResponse:{id:'not-pending',result:'wrong'}});
 core.receive({coreResponse:{id:request.id,result:[{alias:'example'}]}});
 assert.deepEqual(JSON.parse(await result),[{alias:'example'}]);
 const call=core.execute({name:'plugin_run',arguments:{alias:'example',args_json:'["search","hello $(whoami)"]'}},controller.signal);
 const pending=frames.at(-1).coreRequest;assert.deepEqual(pending.params.args,['search','hello $(whoami)']);
 controller.abort();await assert.rejects(call,/cancelled/);assert.equal(frames.at(-1).coreCancel.id,pending.id);
 await assert.rejects(core.execute({name:'plugin_run',arguments:{alias:'example',args_json:'{"shell":"x"}'}},new AbortController().signal),/array/);
});
test('native task access forwards literal arguments and returns admission separately from completion',async()=>{
 const socket=new PassThrough();let frame;socket.on('data',b=>{frame=JSON.parse(b.toString());});
 const core=new CoreTools(socket);
 const result=core.execute({name:'agent_tasks',arguments:{args_json:JSON.stringify(['create','--now','--text','Process the source using native tools; $(literal)'])}});
 assert.equal(frame.coreRequest.method,'tools.native');
 assert.deepEqual(frame.coreRequest.params,{args:['create','--now','--text','Process the source using native tools; $(literal)']});
 core.receive({coreResponse:{id:frame.coreRequest.id,result:{id:'s_test',enabled:true}}});
 assert.deepEqual(JSON.parse(await result),{id:'s_test',enabled:true});
 await assert.rejects(core.execute({name:'agent_tasks',arguments:{args_json:'"shell"'}}),/array/);
});
