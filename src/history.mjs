import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const validId = id => typeof id==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
const atomic=async(file,value)=>{const tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(tmp,file);};
export function recentMessages(messages,maxChars=12000,maxItems=30){
  const result=[];let chars=0;
  for(const message of [...messages].reverse()){
    if(!message.text||!['user','assistant'].includes(message.role))continue;
    if(result.length>=maxItems||chars+message.text.length>maxChars)break;
    result.unshift({id:message.id,role:message.role,text:message.text});chars+=message.text.length;
  }
  return result;
}
export class VoiceHistory {
  constructor(state){this.directory=join(state,'conversations');this.index=join(state,'latest-conversation.json');this.chain=Promise.resolve();this.value=null;this.row=null;}
  async load(){
    await this.chain;
    try{
      const {id}=JSON.parse(await readFile(this.index,'utf8'));if(!validId(id))throw Error('Invalid retained conversation');
      const value=JSON.parse(await readFile(join(this.directory,id+'.json'),'utf8'));
      if(value.id!==id||!Array.isArray(value.messages)||value.messages.some(m=>!validId(m.id)||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>12000))throw Error('Invalid retained conversation');
      return value;
    }catch(e){if(e.code==='ENOENT')return null;throw e;}
  }
  async begin(resume=true){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    this.value=resume?await this.load():null;
    if(!this.value){this.value={id:randomUUID(),createdAt:new Date().toISOString(),messages:[]};await atomic(join(this.directory,this.value.id+'.json'),this.value);await atomic(this.index,{id:this.value.id});}
    this.row=null;return recentMessages(this.value.messages);
  }
  observe(event){
    if(!this.value)return;
    if(event.type==='session.input_transcript.delta'||event.type==='session.output_transcript.delta'){
      const role=event.type.includes('input_')?'user':'assistant';
      if(typeof event.delta!=='string'||!Number.isFinite(event.start_ms)||!Number.isFinite(event.end_ms)||event.end_ms<event.start_ms)return;
      let row=this.row,item=row&&this.value.messages.find(message=>message.id===row.id);
      if(!row||!item||row.role!==role||event.start_ms-row.end>1500){item={id:'live_'+randomUUID().replaceAll('-',''),role,text:''};row={id:item.id,role,end:event.end_ms};this.row=row;this.value.messages.push(item);}
      item.text=(item.text+event.delta).slice(-12000);row.end=Math.max(row.end,event.end_ms);
      this.value.messages=this.value.messages.slice(-500);
      this.save();return;
    }
  }
  save(){const snapshot=structuredClone(this.value);this.chain=this.chain.then(()=>atomic(join(this.directory,snapshot.id+'.json'),snapshot));this.chain.catch(()=>{});}
  async flush(){await this.chain;}
}
