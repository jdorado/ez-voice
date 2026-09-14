import { randomUUID } from 'node:crypto';
import { send } from './protocol.mjs';

export class CoreTools {
  constructor(socket){this.socket=socket;this.pending=new Map();}
  receive(frame){
    if(!frame.coreResponse)return false;
    const {id,result,error}=frame.coreResponse,pending=this.pending.get(id);if(!pending)return true;
    this.pending.delete(id);pending.finish(error?new Error(error):null,result);return true;
  }
  request(method,params,signal){
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const id=randomUUID();
      const finish=(error,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>{this.pending.delete(id);send(this.socket,{coreCancel:{id}});finish(new Error('Core request cancelled'))};
      const timer=setTimeout(()=>{this.pending.delete(id);send(this.socket,{coreCancel:{id}});finish(new Error('Core request timed out'))},100000);
      this.pending.set(id,{finish});signal?.addEventListener('abort',abort,{once:true});send(this.socket,{coreRequest:{id,method,params}});
    });
  }
  close(){for(const pending of this.pending.values())pending.finish(new Error('Core connection closed'));this.pending.clear();}
}
