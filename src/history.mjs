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
  constructor(state){this.directory=join(state,'conversations');this.index=join(state,'latest-conversation.json');this.chain=Promise.resolve();this.value=null;}
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
    return recentMessages(this.value.messages);
  }
  observe(event){
    if(!this.value)return;
    let id,role,content,previous;
    if(['conversation.item.added','conversation.item.created','conversation.item.done'].includes(event.type)&&event.item?.type==='message'){
      ({id,role}=event.item);previous=event.previous_item_id;
      if(role==='user')content=event.item.content?.map(c=>c.text||c.transcript||'').join('\n')||undefined;
    }else if(event.type==='input_audio_buffer.committed'){id=event.item_id;role='user';previous=event.previous_item_id;}
    else if(event.type==='conversation.item.input_audio_transcription.completed'){id=event.item_id;role='user';content=event.transcript;}
    else if(event.type==='response.output_audio_transcript.done'||event.type==='response.output_text.done'){id=event.item_id;role='assistant';content=event.transcript??event.text;}
    else if(event.type==='conversation.item.truncated'||event.type==='conversation.item.deleted'){
      // The provider cannot give a word-aligned transcript of interrupted speech.
      // Remove it rather than resume words the owner may never have heard.
      this.value.messages=this.value.messages.filter(m=>m.id!==event.item_id);this.save();return;
    }else return;
    if(!validId(id)||!['user','assistant'].includes(role))return;
    let item=this.value.messages.find(m=>m.id===id);
    if(!item){
      item={id,role,text:''};const index=this.value.messages.findIndex(m=>m.id===previous);
      if(index>=0)this.value.messages.splice(index+1,0,item);else this.value.messages.push(item);
    }
    if(typeof content==='string')item.text=content.slice(0,12000);
    // Bound each retained voice conversation; older-history retrieval is not exposed.
    this.value.messages=this.value.messages.slice(-500);
    this.save();
  }
  save(){const snapshot=structuredClone(this.value);this.chain=this.chain.then(()=>atomic(join(this.directory,snapshot.id+'.json'),snapshot));this.chain.catch(()=>{});}
  async flush(){await this.chain;}
}
