import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {CoreTools} from '../src/plugin-tools.mjs';
test('startup context reads the current core catalogue without hardcoded command names',async()=>{
 const socket=new PassThrough();let frame;socket.on('data',b=>{frame=JSON.parse(b.toString());});
 const core=new CoreTools(socket);
 for(const command of ['example_delivery','replacement_command']){
  const context=core.capabilityContext();assert.equal(frame.coreRequest.method,'tools.native.list');
  core.receive({coreResponse:{id:frame.coreRequest.id,result:[{command,description:'Current capability',available:true}]}});
  assert.match(await context,new RegExp(command));
 }
 const unavailable=core.capabilityContext();
 core.receive({coreResponse:{id:frame.coreRequest.id,error:'Core unavailable'}});
 assert.match(await unavailable,/Use core_tools/);
 const large=core.capabilityContext();
 core.receive({coreResponse:{id:frame.coreRequest.id,result:[{command:'example',description:'x'.repeat(10000)}]}});
 assert((await large).length<4000);
 core.close();
});
test('plugin adapter forwards generic core discovery/invocation; ignores unrelated results and cancels',async()=>{
 const socket=new PassThrough();const frames=[];socket.on('data',b=>frames.push(JSON.parse(b.toString())));
 const core=new CoreTools(socket);const controller=new AbortController();
 const result=core.execute({name:'plugins_list',arguments:{}},controller.signal);
 const request=frames[0].coreRequest;assert.equal(request.method,'tools.list');
 core.receive({coreResponse:{id:'not-pending',result:'wrong'}});
 core.receive({coreResponse:{id:request.id,result:[{alias:'example'}]}});
 assert.deepEqual(JSON.parse(await result),[{alias:'example'}]);
 const call=core.execute({name:'plugin_run',arguments:{alias:'example',args_json:'["search","hello $(whoami)"]',output_name:''}},controller.signal);
 const pending=frames.at(-1).coreRequest;assert.deepEqual(pending.params.args,['search','hello $(whoami)']);
 assert.equal(Object.hasOwn(pending.params,'output'),false);
 controller.abort();await assert.rejects(call,/cancelled/);assert.equal(frames.at(-1).coreCancel.id,pending.id);
 await assert.rejects(core.execute({name:'plugin_run',arguments:{alias:'example',args_json:'{"shell":"x"}',output_name:''}},new AbortController().signal),/array/);
});
test('native core discovery preserves availability; execution returns native receipts and errors',async()=>{
 const socket=new PassThrough();let frame;socket.on('data',b=>{frame=JSON.parse(b.toString());});
 const core=new CoreTools(socket);
 const discovery=core.execute({name:'core_tools',arguments:{}});
 assert.equal(frame.coreRequest.method,'tools.native.list');assert.deepEqual(frame.coreRequest.params,{});
 const commands=[{command:'schedule'},{command:'message',available:false,limitations:['No owner binding']}];
 core.receive({coreResponse:{id:frame.coreRequest.id,result:commands}});
 assert.deepEqual(JSON.parse(await discovery),commands);
 const result=core.execute({name:'core_run',arguments:{command:'schedule',args_json:JSON.stringify(['create','--now','--text','Process the source using native tools; $(literal)'])}});
 assert.equal(frame.coreRequest.method,'tools.native');
 assert.deepEqual(frame.coreRequest.params,{command:'schedule',args:['create','--now','--text','Process the source using native tools; $(literal)']});
 core.receive({coreResponse:{id:frame.coreRequest.id,result:{id:'s_test',enabled:true}}});
 assert.deepEqual(JSON.parse(await result),{id:'s_test',enabled:true});
 const message=core.execute({name:'core_run',arguments:{command:'message',args_json:'["--document","/returned/artifact.pdf"]'}});
 assert.deepEqual(frame.coreRequest.params,{command:'message',args:['--document','/returned/artifact.pdf']});
 core.receive({coreResponse:{id:frame.coreRequest.id,error:'Owner binding changed'}});
 await assert.rejects(message,/Owner binding changed/);
 await assert.rejects(core.execute({name:'core_run',arguments:{command:'schedule',args_json:'"shell"'}}),/array/);
});
test('binary stdout staging forwards only a simple filename and returns artifact metadata',async()=>{
 const socket=new PassThrough();const frames=[];socket.on('data',b=>frames.push(JSON.parse(b.toString())));
 const core=new CoreTools(socket);
 const result=core.execute({name:'plugin_run',arguments:{alias:'example',args_json:'["get","original.pdf","--raw"]',output_name:'original.pdf'}});
 const request=frames.at(-1).coreRequest;
 assert.deepEqual(request.params,{alias:'example',args:['get','original.pdf','--raw'],output:'original.pdf'});
 const receipt={code:0,stdout:'',stderr:'',artifact:{path:'artifacts/uuid_original.pdf',sha256:'abc',bytes:123}};
 core.receive({coreResponse:{id:request.id,result:receipt}});
 assert.deepEqual(JSON.parse(await result),receipt);
 for(const output_name of ['../secret','/secret','folder/name','bad\\name'])
  await assert.rejects(core.execute({name:'plugin_run',arguments:{alias:'example',args_json:'[]',output_name}}),/simple output filename/);
 assert.equal(frames.length,1);
});
