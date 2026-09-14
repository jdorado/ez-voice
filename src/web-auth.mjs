import {createPublicKey, randomBytes, verify, timingSafeEqual} from 'node:crypto';

const telegramKey = createPublicKey({key:Buffer.from('302a300506032b6570032100e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d','hex'),format:'der',type:'spki'});
export function telegramUser(initData, botId, {now=Date.now(),key=telegramKey}={}) {
  if(typeof initData!=='string'||initData.length>16000||!/^\d{1,20}$/.test(botId))throw Error('Invalid Telegram launch');
  const data=new URLSearchParams(initData),seen=new Set();
  for(const [name] of data){if(seen.has(name))throw Error('Duplicate launch field');seen.add(name);}
  const signature=data.get('signature');
  if(!signature||!/^[A-Za-z0-9_-]{86}={0,2}$/.test(signature))throw Error('Invalid Telegram signature');
  const check=[...data].filter(([name])=>!['hash','signature'].includes(name)).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,value])=>`${name}=${value}`).join('\n');
  if(!verify(null,Buffer.from(`${botId}:WebAppData\n${check}`),key,Buffer.from(signature,'base64url')))throw Error('Invalid Telegram signature');
  const date=Number(data.get('auth_date'))*1000;
  if(!Number.isSafeInteger(date)||date>now+30000||date<now-300000)throw Error('Expired Telegram launch');
  const user=JSON.parse(data.get('user'));
  if(!user||!Number.isSafeInteger(user.id)||user.id<=0||user.is_bot===true)throw Error('Invalid Telegram user');
  return user.id;
}
export function webOrigin(value) {
  const url=new URL(value);
  if(url.origin!==value||url.username||url.password||!(url.protocol==='https:'||(url.protocol==='http:'&&url.hostname==='127.0.0.1')))throw Error('Expected HTTPS origin, or local http://127.0.0.1:PORT');
  return url;
}
export class WebAuth {
  constructor({origin,botId,readOwner,now=Date.now,verifyUser=telegramUser}) {
    this.local=webOrigin(origin).protocol==='http:';this.botId=botId;this.readOwner=readOwner;this.now=now;this.verifyUser=verifyUser;
    if(!this.local&&!/^\d{1,20}$/.test(botId||''))throw Error('Public web access requires a Telegram bot ID');
    this.localToken=this.local?randomBytes(32).toString('hex'):undefined;
    this.sessions=new Map();this.used=new Map();
  }
  async login(input) {
    const now=this.now();
    for(const [key,value] of this.sessions)if(value.expires<=now)this.sessions.delete(key);
    for(const [key,expires] of this.used)if(expires<=now)this.used.delete(key);
    if(this.sessions.size>=8)throw Error('Too many sessions; wait for expiry');
    let owner=null;
    if(this.local&&typeof input.token==='string'&&this.localToken&&input.token.length===64&&timingSafeEqual(Buffer.from(input.token),Buffer.from(this.localToken)))this.localToken=undefined;
    else {
      const user=this.verifyUser(input.initData,this.botId,{now});
      owner=await this.readOwner();
      if(!owner||owner.telegramUserId!==user)throw Error('Only the paired owner can use Voice');
      if(this.used.has(input.initData))throw Error('Launch already used; reopen Voice');
      this.used.set(input.initData,now+330000);
    }
    const token=randomBytes(32).toString('hex');this.sessions.set(token,{owner,expires:now+20*60*1000});return {token,expiresAt:now+20*60*1000};
  }
  async authorize(token) {
    const session=typeof token==='string'&&this.sessions.get(token);
    if(!session||session.expires<=this.now()){this.sessions.delete(token);throw Error('Session expired; reopen Voice');}
    if(session.owner){const owner=await this.readOwner();if(!owner||owner.telegramUserId!==session.owner.telegramUserId||owner.pairedAt!==session.owner.pairedAt){this.sessions.delete(token);throw Error('Owner access revoked');}}
    return token;
  }
}
