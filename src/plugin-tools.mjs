import { randomUUID } from 'node:crypto';
import { send } from './protocol.mjs';
import { validateArguments } from './tools.mjs';

const string = maxLength => ({type:'string',maxLength});
const schema = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const pluginTools = [
  {name:'plugins_list',description:'Discover this agent’s currently installed plugins. Returns aliases, descriptions and skill counts. Installation alone does not authorize actions.',parameters:schema({})},
  {name:'plugin_help',description:'Read a registered plugin’s native CLI help before choosing arguments.',parameters:schema({alias:string(40)})},
  {name:'plugin_skill',description:'Read an installed plugin’s own skill instructions. Skill index starts at 0, line at 1. Follow nextLine for subsequent pages.',parameters:schema({alias:string(40),index:{type:'integer',minimum:0,maximum:99},line:{type:'integer',minimum:1,maximum:100000}})},
  {name:'plugin_run',description:'Run a native installed-plugin command using this agent’s existing permissions. args_json is a JSON array of literal CLI arguments, excluding ez and the alias. Set output_name to an empty string for normal text output, or a simple filename to stage binary stdout as an artifact. Only after code 0, use the returned artifact.path for subsequent file operations. Follow the owner’s request and plugin authorization rules. No extra voice approval or shell interpretation; do not repeat uncertain operations.',parameters:schema({alias:string(40),args_json:string(8000),output_name:string(100)})},
  {name:'core_tools',description:'Discover the native core commands available to this agent connection and their limitations. Use core_run with a returned command name and ["--help"] before choosing arguments.',parameters:schema({})},
  {name:'core_run',description:'Invoke a discovered native core command. args_json is a JSON array of literal CLI arguments, excluding the executable. Follow its help and the owner’s request; send messages/files only when explicitly requested. No repeat confirmation of that request. Require a delivery receipt before claiming sent; task admission is not completion. Do not retry uncertain operations.',parameters:schema({command:string(40),args_json:string(8000)})},
];
export class CoreTools {
  constructor(socket){this.socket=socket;this.pending=new Map();}
  receive(frame){
    if(!frame.coreResponse)return false;
    const {id,result,error}=frame.coreResponse;
    const p=this.pending.get(id);if(!p)return true;
    this.pending.delete(id);p.finish(error?new Error(error):null,result);return true;
  }
  request(method,params,signal){
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const id=randomUUID();
      const finish=(error,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>{this.pending.delete(id);send(this.socket,{coreCancel:{id}});finish(new Error('Plugin request cancelled; an operation already started may have an uncertain outcome'));};
      const timer=setTimeout(()=>{this.pending.delete(id);send(this.socket,{coreCancel:{id}});finish(new Error('Core tool request timed out; do not automatically retry'));},100000);
      this.pending.set(id,{finish});signal?.addEventListener('abort',abort,{once:true});
      send(this.socket,{coreRequest:{id,method,params}});
    });
  }
  async execute(call,signal){
    const tool=pluginTools.find(t=>t.name===call.name);if(!tool)throw Error('Unknown plugin tool');validateArguments(tool,call.arguments);
    let method,params=call.arguments;
    if(call.name==='plugins_list')method='tools.list';
    else if(call.name==='core_tools')method='tools.native.list';
    else if(call.name==='plugin_help')method='tools.help';
    else if(call.name==='plugin_skill')method='tools.skill';
    else {
      method=call.name==='core_run'?'tools.native':'tools.invoke';const args=JSON.parse(params.args_json);
      if(!Array.isArray(args)||args.length>32||args.some(a=>typeof a!=='string'||a.length>2000||a.includes('\0')))throw Error('Expected a bounded JSON array of CLI arguments');
      if(call.name==='plugin_run'&&params.output_name&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(params.output_name))throw Error('Expected a simple output filename');
      params=call.name==='core_run'?{command:params.command,args}:{alias:params.alias,args,...(params.output_name?{output:params.output_name}:{})};
    }
    const result=JSON.stringify(await this.request(method,params,signal));
    return result.length>15000?JSON.stringify({truncated:true,output:result.slice(0,14000),note:'Request a smaller result or narrower query.'}):result;
  }
  close(){for(const p of this.pending.values())p.finish(new Error('Core connection closed; outcome may be uncertain'));this.pending.clear();}
}
