import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {applicationCall} from '@jc_stack/ez-agents/application-client';
export function validTask(task) {
  return !!task && Object.keys(task).every(k=>['taskId','taskToken','expiresAt'].includes(k)) && /^task_[a-f0-9]{32}$/.test(task.taskId) && /^[a-f0-9]{64}$/.test(task.taskToken) && Number.isSafeInteger(task.expiresAt) && task.expiresAt>Date.now();
}
export async function authorizeTask(state,task,call=applicationCall) {
  if(!validTask(task))throw Error('Discussion access expired');
  const config=JSON.parse(await readFile(join(state,'config.json'),'utf8'));
  const result=await call('/v1/registration',{taskToken:task.taskToken},{url:config.agentUrl,token:config.agentToken,signal:AbortSignal.timeout(3000)});
  if(result.taskId!==task.taskId || result.expiresAt!==task.expiresAt)throw Error('Discussion access mismatch');
  return result;
}
