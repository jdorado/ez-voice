import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentContext,executeContext} from '../src/context.mjs';

test('bound identity and Markdown search/read; rejects escape, hidden files and symlinks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'voice-context-'));
 try{
  await writeFile(join(root,'SOUL.md'),'I help the owner with projects.');
  await mkdir(join(root,'notes'));
  await writeFile(join(root,'notes','plan.md'),'# Orchard\nThe greenhouse is blue.');
  await writeFile(join(root,'.private.md'),'hidden');
  await symlink(join(root,'notes','plan.md'),join(root,'linked.md'));
  const identity=await agentContext(root,{name:'test-agent',purpose:'Project assistant'});
  assert.match(identity.instructions,/test-agent/);assert.match(identity.instructions,/I help the owner/);
  const execute=(name,args)=>executeContext(root,{name,arguments:args},new AbortController().signal);
  const found=JSON.parse(await execute('context_search',{query:'greenhouse',prefix:'notes'}));
  assert.equal(found.results[0].path,'notes/plan.md');
  assert.match(await execute('context_read',{path:found.results[0].path,line:1}),/greenhouse is blue/);
  for(const path of ['../outside.md','/etc/passwd','.private.md','linked.md','notes/plan.txt'])await assert.rejects(execute('context_read',{path,line:1}));
  await assert.rejects(execute('context_search',{query:'x',prefix:'../'}));
  await assert.rejects(execute('context_search',{query:'x',prefix:'',command:'shell'}));
  await assert.rejects(execute('library_search',{query:'x'}));
  const controller=new AbortController();controller.abort();await assert.rejects(executeContext(root,{name:'context_search',arguments:{query:'',prefix:''}},controller.signal));
 }finally{await rm(root,{recursive:true,force:true});}
});
