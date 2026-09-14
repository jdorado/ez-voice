const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('ez-voice-token') || '';
const loginToken=/^#[a-f0-9]{64}$/.test(location.hash)?location.hash.slice(1):'';
history.replaceState(null, '', '/');
let pc, dc, mic, seq = 0, running = false, starting = false, historyId;
const rows = new Map();
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed'); return value;
}
function caption(key, who, delta, replace = false) {
  let row = rows.get(key);
  if (!row) { row = document.createElement('div'); row.className='entry'; const label=document.createElement('small');label.textContent=who;const content=document.createElement('span');row.append(label,content);$('transcript').append(row);rows.set(key,row); }
  const content=row.lastChild; content.textContent=replace?delta:content.textContent+delta;
}
function cleanup() { mic?.getTracks().forEach(t=>t.stop());dc?.close();pc?.close();pc=dc=mic=undefined;running=false;starting=false;$('audio').srcObject=null;$('start').disabled=false;$('new').disabled=false;$('mute').disabled=true;$('stop').disabled=true;$('orb').classList.remove('active');$('mute').textContent='Mute'; }
async function start(resume=true){
  if(starting||running)return;starting=true;$('start').disabled=true;$('new').disabled=true;$('status').textContent='Connecting…';
  try {
    mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    pc=new RTCPeerConnection();
    pc.ontrack=e=>{$('audio').srcObject=e.streams[0];$('audio').play().catch(()=>{$('status').textContent='Press play below to hear your agent.';});};
    pc.onconnectionstatechange=()=>{if(pc&&['failed','closed'].includes(pc.connectionState)&&running)void end('Connection ended.');};
    mic.getTracks().forEach(t=>pc.addTrack(t,mic));dc=pc.createDataChannel('oai-events');
    dc.onmessage=({data})=>{const e=JSON.parse(data);if(e.type==='response.output_audio_transcript.delta')caption(e.item_id,'Agent',e.delta);if(e.type==='conversation.item.input_audio_transcription.completed')caption(e.item_id,'You',e.transcript,true);if(e.type==='error')$('status').textContent='The voice provider reported an error.';};
    dc.onopen=()=>{running=true;starting=false;$('stop').disabled=false;$('mute').disabled=false;$('orb').classList.add('active');$('status').textContent='Listening. Ask about your notes or projects.';};
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);
    const result=await api('/session',{sdp:offer.sdp,resume});
    if(!resume){rows.clear();$('transcript').replaceChildren();}historyId=result.conversationId;
    await pc.setRemoteDescription({type:'answer',sdp:result.sdp});
  }catch(error){await api('/stop',{}).catch(()=>{});cleanup();$('status').textContent=error.message;}
}
$('start').onclick=()=>void start(true);
$('new').onclick=()=>void start(false);
async function end(message='Conversation ended.') { $('stop').disabled=true;cleanup();try{const r=await api('/stop',{});$('status').textContent=r?.hangupConfirmed===false?'Disconnected; provider hangup unconfirmed.':message;}catch(error){$('status').textContent=error.message;} }
$('stop').onclick=()=>void end();
$('mute').onclick=()=>{if(!mic)return;const mute=mic.getAudioTracks()[0].enabled;mic.getAudioTracks().forEach(t=>t.enabled=!mute);$('mute').textContent=mute?'Unmute':'Mute';$('status').textContent=mute?'Microphone muted.':'Listening.';};
window.addEventListener('pagehide',()=>{mic?.getTracks().forEach(t=>t.stop());fetch('/stop',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}',keepalive:true}).catch(()=>{});});
async function poll(){
  try{const data=await api(`/status?after=${seq}`);$('identity').textContent=`${data.agent} · Realtime voice · Direct plugin access`;$('tools').replaceChildren(...data.tools.map(t=>{const el=document.createElement('span');el.className='tool';el.textContent=t.name;el.title=t.description;return el;}));
    if(!running&&!starting){$('start').textContent=data.history?.messages?.length?'Resume talking':'Start talking';
      if(historyId!==data.history?.conversationId){rows.clear();$('transcript').replaceChildren();historyId=data.history?.conversationId;}
      for(const m of data.history?.messages||[])caption(m.id,m.role==='user'?'You':'Agent',m.text,true);
    }
    for(const e of data.events){seq=Math.max(seq,e.seq);if(e.type==='tool_started'||e.type==='tool_completed'){const row=document.createElement('div');row.className='entry';row.textContent=e.type==='tool_started'?`${e.name} · running`:`${e.name} · ${e.elapsedMs} ms`;$('activity').prepend(row);}if(e.type==='closed'&&running){cleanup();$('status').textContent=e.hangupConfirmed===false?'Disconnected; provider hangup unconfirmed.':`Conversation ended: ${e.reason}`;}if(e.type==='error')$('status').textContent=e.message;}
  }catch(error){$('status').textContent=error.message;}finally{setTimeout(poll,1000);}
}
async function authenticate(){
  $('start').disabled=$('new').disabled=true;
  try {
    if(token){try{await api('/status');}catch{token='';sessionStorage.removeItem('ez-voice-token');}}
    if(!token){const result=await api('/auth',loginToken?{token:loginToken}:{initData:window.Telegram?.WebApp?.initData||''});token=result.token;sessionStorage.setItem('ez-voice-token',token);}
    await api('/status');
    $('start').disabled=$('new').disabled=false;
    window.Telegram?.WebApp?.ready();void poll();
  }catch{sessionStorage.removeItem('ez-voice-token');$('status').textContent='Access denied or expired. Reopen Voice from your agent.';}
}
void authenticate();
