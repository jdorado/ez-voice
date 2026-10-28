import net from 'node:net';
import {mkdirSync, openSync, closeSync, readFileSync} from 'node:fs';
import {chmod, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {frames, send} from './protocol.mjs';
import {phone, sid} from './phone-provider.mjs';

export const LAST_CALL = 'last-call.json';
const terminal = new Set(['completed','busy','failed','no-answer','canceled','rejected']);
const statuses = new Set(['queued','initiated','ringing','in-progress',...terminal]);
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
// A per-call brief is added to the configured instructions (the line's identity and conduct) for that
// outbound call only; where the two differ, the brief wins.
export const MAX_CALL_INSTRUCTIONS = 12000;
export const withBrief = (instructions, brief) => brief ? `${instructions}\n\nBrief for this call (where it differs from the instructions above, it wins):\n${brief}` : instructions;
const brief = value => value === undefined || (typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_CALL_INSTRUCTIONS);
const rank = value => terminal.has(value) ? 4 : value === 'in-progress' ? 3 : value === 'ringing' ? 2 : value === 'queued' || value === 'initiated' ? 1 : 0;

export function callOptions(action, args) {
  const result = {};
  for (let i=0; i<args.length; i+=2) {
    const key = args[i] === '--request-id' ? 'requestId' : args[i] === '--to' && action === 'call' ? 'to' : args[i] === '--instructions' && action === 'call' ? 'instructions' : null;
    if (!key || result[key] !== undefined || !args[i+1] || (key === 'instructions' && args[i+1] !== '-')) throw Error('Use phone call --to E.164 --request-id ID [--instructions - < brief.txt]; call-status/hangup require --request-id ID');
    result[key] = args[i+1];
  }
  if (!requestId(result.requestId) || (action === 'call' && !phone(result.to))) throw Error('Supply an E.164 destination and a stable request ID (1..100 letters, digits, _ or -)');
  return result;
}

export class PhoneCalls {
  constructor(directory, config, provider) {
    this.config = config; this.provider = provider; this.directory = directory;
    mkdirSync(directory, {recursive:true,mode:0o700});
    const path=join(directory,'calls.sqlite');closeSync(openSync(path,'a',0o600));
    this.db = new DatabaseSync(path, {timeout:0});
    this.db.exec('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, call_sid TEXT UNIQUE, status TEXT NOT NULL, at TEXT NOT NULL)');
    if (!this.db.prepare('PRAGMA table_info(requests)').all().some(column=>column.name==='instructions')) this.db.exec('ALTER TABLE requests ADD COLUMN instructions TEXT');
  }
  row(id) { if (!requestId(id)) throw Error('Invalid request ID'); return this.db.prepare('SELECT * FROM requests WHERE id=?').get(id); }
  receipt(row) { if (!row) throw Error('Unknown outbound request ID'); return {requestId:row.id,to:row.recipient,from:this.config.number,callSid:row.call_sid,status:row.status,at:row.at,brief:Boolean(row.instructions)}; }
  instructions(id) { return requestId(id) ? this.row(id)?.instructions ?? undefined : undefined; }
  pending() { return this.db.prepare("SELECT * FROM requests WHERE status NOT IN ('completed','busy','failed','no-answer','canceled','rejected') LIMIT 1").get(); }
  update(row, callSid, status) {
    const current=this.row(row.id);
    if (!sid(callSid,'CA') || (current.call_sid && current.call_sid!==callSid) || !statuses.has(status)) throw Error('Call receipt does not match the outbound request');
    if (rank(status)<rank(current.status)) status=current.status;
    this.db.prepare('UPDATE requests SET call_sid=?,status=? WHERE id=?').run(callSid,status,row.id);
    return this.receipt(this.row(row.id));
  }
  observe(row, call) {
    if (call.account_sid!==this.config.accountSid || call.from!==this.config.number || call.to!==row.recipient || call.direction!=='outbound-api') throw Error('Twilio call identity does not match the outbound request');
    return this.update(row,call.sid,call.status);
  }
  // The recording outcome comes from the private audio receipt of the same Call SID.
  recorded(receipt) {
    try {
      let raw;
      try { raw=readFileSync(join(this.directory,'receipts',receipt.callSid+'.json'),'utf8'); }
      catch { raw=readFileSync(join(this.directory,LAST_CALL),'utf8'); }
      const last=JSON.parse(raw);
      return last.callSid && last.callSid===receipt.callSid && last.recording ? {...receipt,recording:last.recording} : receipt;
    } catch { return receipt; }
  }
  async status(id) {
    const row=this.row(id);this.receipt(row);
    return this.recorded(row.call_sid ? this.observe(row,await this.provider.getCall(row.call_sid)) : this.receipt(row));
  }
  async recover() { const row=this.pending(); if (row?.call_sid) await this.status(row.id); }
  async call(options, isBusy) {
    if (!options || Object.keys(options).some(key=>!['to','requestId','instructions'].includes(key)) || !phone(options.to) || !requestId(options.requestId) || options.to===this.config.number) throw Error('Supply a destination other than the configured number and a stable request ID');
    if (!brief(options.instructions)) throw Error(`Call instructions must contain 1..${MAX_CALL_INSTRUCTIONS} characters`);
    this.db.exec('BEGIN IMMEDIATE');
    let existing;
    try {
      existing=this.row(options.requestId);
      if (existing && existing.recipient!==options.to) throw Error('Request ID was already used for a different destination');
      if (!existing) {
        if (isBusy() || this.pending()) throw Error('Phone line is busy; inspect the existing call before dialing');
        this.db.prepare('INSERT INTO requests(id,recipient,status,at,instructions) VALUES(?,?,?,?,?)').run(options.requestId,options.to,'uncertain',new Date().toISOString(),options.instructions ?? null);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK');throw error; }
    if (existing) return {...await this.status(existing.id),created:false};
    const row=this.row(options.requestId);
    try { return {...this.observe(row,await this.provider.createCall(options.to,options.requestId)),created:true}; }
    catch (error) {
      const observed=this.row(row.id);
      if (observed.call_sid) return {...this.receipt(observed),created:true};
      if (error.status>=400 && error.status<500 && error.status!==408) this.db.prepare('UPDATE requests SET status=? WHERE id=?').run('rejected',row.id);
      throw Error('Outbound call creation unconfirmed or rejected; inspect call-status with the same request ID. Do not redial automatically');
    }
  }
  accept(id, params, isStatus) {
    if (!requestId(id)) return false;
    const row=this.row(id);
    const callSid=params.get('CallSid'), status=params.get('CallStatus');
    if (!row || params.get('From')!==this.config.number || params.get('To')!==row.recipient || params.get('Direction')!=='outbound-api' || !sid(callSid,'CA') || (row.call_sid && row.call_sid!==callSid) || (isStatus ? !terminal.has(status) || status==='rejected' : status!=='in-progress' || terminal.has(row.status))) return false;
    this.update(row,callSid,status);
    return true;
  }
  async hangup(id) {
    const current=await this.status(id);
    if (terminal.has(current.status)) return current;
    if (!current.callSid) throw Error('Call creation is uncertain; inspect Twilio before another mutation');
    return this.observe(this.row(id),await this.provider.endCall(current.callSid,['queued','initiated','ringing'].includes(current.status)?'canceled':'completed'));
  }
  async stop() {
    const row=this.pending();
    if (row) await this.hangup(row.id);
  }
  close() { this.db.close(); }
}

export async function servePhoneControl(directory, handle) {
  const path=join(directory,'phone.sock'), clients=new Set(), pending=new Set();
  let closing=false,closePromise;
  const server=net.createServer(socket=>{
    clients.add(socket);socket.setTimeout(35000,()=>socket.destroy());socket.on('error',()=>{});socket.on('close',()=>clients.delete(socket));
    let used=false;
    frames(socket,frame=>{
      if (closing || used) return socket.destroy();used=true;
      const work=Promise.resolve().then(()=>handle(frame)).then(result=>send(socket,{result}),error=>send(socket,{error:error.message})).finally(()=>{pending.delete(work);socket.end();});
      pending.add(work);
    },()=>socket.destroy());
  });
  server.maxConnections=8;
  const listen=()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.removeListener('error',reject);resolve();});});
  try { await listen(); }
  catch (error) {
    if (error.code!=='EADDRINUSE') throw error;
    const live=await new Promise((resolve,reject)=>{const probe=net.connect(path);probe.once('connect',()=>{probe.destroy();resolve(true);});probe.once('error',e=>['ECONNREFUSED','ENOENT'].includes(e.code)?resolve(false):reject(e));});
    if (live) throw Error('Phone control is already running');
    await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});await listen();
  }
  await chmod(path,0o600);
  return {close:()=>closePromise??=(async()=>{closing=true;const closed=new Promise(resolve=>server.close(resolve));await Promise.allSettled([...pending]);for(const client of clients)client.destroy();await closed;})()};
}

export async function phoneControl(directory, action, options) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect(join(directory,'phone.sock'));let done=false;
    const fail=()=>{if(!done){done=true;reject(Error('Phone control unavailable or response unconfirmed; inspect the same request ID before retrying'));}socket.destroy();};
    socket.setTimeout(30000,fail);socket.on('error',fail);socket.on('close',()=>{if(!done)fail();});
    socket.on('connect',()=>send(socket,{action,...options}));
    frames(socket,frame=>{if(done)return;done=true;socket.end();frame.error?reject(Error(frame.error)):resolve(frame.result);},fail);
  });
}
