import net from 'node:net';
import {mkdirSync, openSync, closeSync, readFileSync} from 'node:fs';
import {chmod, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {frames, send} from './protocol.mjs';
import {phone, sid} from './phone-provider.mjs';
import {instructionsFromFiles} from './phone-instructions.mjs';

export const LAST_CALL = 'last-call.json';
const terminal = new Set(['completed','busy','failed','no-answer','canceled','rejected']);
const statuses = new Set(['queued','initiated','ringing','in-progress',...terminal]);
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
// A per-call brief is added to the configured instructions (the line's identity and conduct) for that
// outbound call only; where the two differ, the brief wins.
export const MAX_CALL_INSTRUCTIONS = 12000;
// What a session starts with: a line's instructions with a brief or a caller context. Providers were verified to accept
// 16000 characters at session start (GPT-Live adds its delegation policy on top), so a call never starts with more.
export const MAX_SESSION_INSTRUCTIONS = 15000;
export const withBrief = (instructions, brief) => brief ? `${instructions}\n\nBrief for this call (where it differs from the instructions above, it wins):\n${brief}` : instructions;
const brief = value => value === undefined || (typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_CALL_INSTRUCTIONS);
const rank = value => terminal.has(value) ? 4 : value === 'in-progress' ? 3 : value === 'ringing' ? 2 : value === 'queued' || value === 'initiated' ? 1 : 0;

export function callOptions(action, args) {
  const result = {};
  for (let i=0; i<args.length; i+=2) {
    const key = args[i] === '--request-id' ? 'requestId' : args[i] === '--to' && action === 'call' ? 'to' : args[i] === '--from' && action === 'call' ? 'from' : args[i] === '--instructions' && action === 'call' ? 'instructions' : null;
    if (!key || result[key] !== undefined || !args[i+1] || (key === 'instructions' && args[i+1] !== '-')) throw Error('Use phone call --to E.164 --request-id ID [--from LINE] [--instructions - < brief.txt]; call-status/hangup require --request-id ID');
    result[key] = args[i+1];
  }
  if (!requestId(result.requestId) || (action === 'call' && (!phone(result.to) || (result.from !== undefined && !phone(result.from))))) throw Error('Supply an E.164 destination (and line) and a stable request ID (1..100 letters, digits, _ or -)');
  return result;
}

export class PhoneCalls {
  constructor(directory, config, provider) {
    this.config = config; this.provider = provider; this.directory = directory;
    mkdirSync(directory, {recursive:true,mode:0o700});
    const path=join(directory,'calls.sqlite');closeSync(openSync(path,'a',0o600));
    this.db = new DatabaseSync(path, {timeout:0});
    this.db.exec('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, call_sid TEXT UNIQUE, status TEXT NOT NULL, at TEXT NOT NULL)');
    const columns=this.db.prepare('PRAGMA table_info(requests)').all().map(column=>column.name);
    if (!columns.includes('instructions')) this.db.exec('ALTER TABLE requests ADD COLUMN instructions TEXT');
    // the line a call went out from; a row from before several lines is the install's first line
    if (!columns.includes('sender')) this.db.exec('ALTER TABLE requests ADD COLUMN sender TEXT');
  }
  row(id) { if (!requestId(id)) throw Error('Invalid request ID'); return this.db.prepare('SELECT * FROM requests WHERE id=?').get(id); }
  receipt(row) { if (!row) throw Error('Unknown outbound request ID'); return {requestId:row.id,to:row.recipient,from:this.from(row),callSid:row.call_sid,status:row.status,at:row.at,brief:Boolean(row.instructions)}; }
  from(row) { return row.sender || this.config.number; }
  numbers() { return (this.config.lines ?? [this.config]).map(line=>line.number); }
  instructions(id) { return requestId(id) ? this.row(id)?.instructions ?? undefined : undefined; }
  sender(id) { const row=requestId(id) ? this.row(id) : undefined; return row ? this.from(row) : undefined; }
  pendingAll() { return this.db.prepare("SELECT * FROM requests WHERE status NOT IN ('completed','busy','failed','no-answer','canceled','rejected')").all(); }
  pending() { return this.pendingAll()[0]; }
  pendingCount() { return this.pendingAll().length; }
  update(row, callSid, status) {
    const current=this.row(row.id);
    if (!sid(callSid,'CA') || (current.call_sid && current.call_sid!==callSid) || !statuses.has(status)) throw Error('Call receipt does not match the outbound request');
    if (rank(status)<rank(current.status)) status=current.status;
    this.db.prepare('UPDATE requests SET call_sid=?,status=? WHERE id=?').run(callSid,status,row.id);
    return this.receipt(this.row(row.id));
  }
  observe(row, call) {
    if (call.account_sid!==this.config.accountSid || call.from!==this.from(row) || call.to!==row.recipient || call.direction!=='outbound-api') throw Error('Twilio call identity does not match the outbound request');
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
  // Every pending call is tried, and the failures are reported together: one unreadable call never blocks the others.
  async each(rows, act) {
    const failed = [];
    for (const row of rows) { try { await act(row); } catch (error) { failed.push(`${row.id}: ${error.message}`); } }
    if (failed.length) throw Error(`Phone calls could not be settled (${failed.length}): ${failed.join('; ')}`);
  }
  async recover() { await this.each(this.pendingAll().filter(row => row.call_sid), row => this.status(row.id)); }
  async call(options, isBusy) {
    const from = options?.from ?? this.config.number;
    if (!options || Object.keys(options).some(key=>!['to','from','requestId','instructions'].includes(key)) || !phone(options.to) || !requestId(options.requestId) || this.numbers().includes(options.to)) throw Error('Supply a destination other than the configured numbers and a stable request ID');
    if (!this.numbers().includes(from)) throw Error('--from must be one of the configured lines');
    if (!brief(options.instructions)) throw Error(`Call instructions must contain 1..${MAX_CALL_INSTRUCTIONS} characters`);
    const prior = this.row(options.requestId);
    if (prior) {
      if (prior.recipient !== options.to || this.from(prior) !== from) throw Error('Request ID was already used for a different destination or line');
      return {...await this.status(prior.id), created: false};
    }
    const line = (this.config.lines ?? [this.config]).find(l => l.number === from);
    // A line that reads its instructions from files reads them now, so a missing file stops the call before it is dialed
    // (the answered call reads them again, at its start).
    if (withBrief((line?.instructionsFiles ? await instructionsFromFiles(line, MAX_CALL_INSTRUCTIONS) : line?.instructions) ?? '', options.instructions).length > MAX_SESSION_INSTRUCTIONS)
      throw Error(`The line's instructions and this brief together exceed ${MAX_SESSION_INSTRUCTIONS} characters; shorten the brief`);
    this.db.exec('BEGIN IMMEDIATE');
    let existing;
    try {
      existing=this.row(options.requestId);
      if (existing && (existing.recipient!==options.to || this.from(existing)!==from)) throw Error('Request ID was already used for a different destination or line');
      if (!existing) {
        if (isBusy() || this.pendingCount() >= (this.config.maxCalls ?? 1)) throw Error('Phone line is busy; inspect the existing call before dialing');
        this.db.prepare('INSERT INTO requests(id,recipient,status,at,instructions,sender) VALUES(?,?,?,?,?,?)').run(options.requestId,options.to,'uncertain',new Date().toISOString(),options.instructions ?? null,from);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK');throw error; }
    if (existing) return {...await this.status(existing.id),created:false};
    const row=this.row(options.requestId);
    try { return {...this.observe(row,await this.provider.createCall(options.to,options.requestId,from)),created:true}; }
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
    if (!row || params.get('From')!==this.from(row) || params.get('To')!==row.recipient || params.get('Direction')!=='outbound-api' || !sid(callSid,'CA') || (row.call_sid && row.call_sid!==callSid) || (isStatus ? !terminal.has(status) || status==='rejected' : status!=='in-progress' || terminal.has(row.status))) return false;
    this.update(row,callSid,status);
    return true;
  }
  async hangup(id) {
    const current=await this.status(id);
    if (terminal.has(current.status)) return current;
    if (!current.callSid) throw Error('Call creation is uncertain; inspect Twilio before another mutation');
    return this.observe(this.row(id),await this.provider.endCall(current.callSid,['queued','initiated','ringing'].includes(current.status)?'canceled':'completed'));
  }
  async stop() { await this.each(this.pendingAll(), row => this.hangup(row.id)); }
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
    socket.on('connect',()=>{try{send(socket,{action,...options});}catch(error){done=true;socket.destroy();reject(error);}});
    frames(socket,frame=>{if(done)return;done=true;socket.end();frame.error?reject(Error(frame.error)):resolve(frame.result);},fail);
  });
}
