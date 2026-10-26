export const sid = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}[a-fA-F0-9]{32}$`).test(value);
export const phone = value => typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);

const routeFields = number => ({VoiceUrl: number.voice_url || '', VoiceMethod: number.voice_method || 'POST',
  VoiceFallbackUrl: number.voice_fallback_url || '', VoiceFallbackMethod: number.voice_fallback_method || 'POST',
  VoiceApplicationSid: number.voice_application_sid || '', TrunkSid: number.trunk_sid || ''});

export class PhoneNumber {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; this.root = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}`; }
  async request(path, form) {
    const response = await this.fetch(this.root + path, {method: form ? 'POST' : 'GET', redirect: 'error',
      headers: {Authorization: 'Basic ' + Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64'),
        ...(form ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})},
      ...(form ? {body: new URLSearchParams(form).toString()} : {}), signal: AbortSignal.timeout(12000)});
    if (!response.ok) { const error = Error(`Twilio phone request failed (HTTP ${response.status}); inspect the receipt before retrying`); error.status = response.status; throw error; }
    const value = await response.text(); if (value.length > 100000) throw Error('Phone response too large');
    return JSON.parse(value);
  }
  async get() {
    const result = await this.request('/IncomingPhoneNumbers.json?' + new URLSearchParams({PhoneNumber: this.config.number, PageSize: '20'}));
    const row = result.incoming_phone_numbers?.find(row => row.phone_number === this.config.number && row.account_sid === this.config.accountSid);
    if (!row || !sid(row.sid, 'PN') || row.capabilities?.voice !== true) throw Error('Configured number is not voice-capable in this Twilio account');
    return {numberSid: row.sid, number: row.phone_number, route: routeFields(row)};
  }
  async createCall(to, requestId) {
    const url = this.config.origin + '/incoming?' + new URLSearchParams({outbound: requestId});
    return this.request('/Calls.json', {To: to, From: this.config.number, Url: url, Method: 'POST',
      StatusCallback: url + '&status=1', StatusCallbackMethod: 'POST', Timeout: '45', TimeLimit: '180', Record: 'false'});
  }
  async getCall(callSid) {
    if (!sid(callSid, 'CA')) throw Error('Invalid Call SID');
    return this.request(`/Calls/${callSid}.json`);
  }
  async startRecording(callSid) {
    if (!sid(callSid, 'CA')) throw Error('Invalid Call SID');
    const recording = await this.request(`/Calls/${callSid}/Recordings.json`, {RecordingChannels: 'dual', RecordingTrack: 'both'});
    if (!sid(recording?.sid, 'RE')) throw Error('Twilio recording response has no Recording SID');
    return recording;
  }
  async endCall(callSid, status) {
    if (!sid(callSid, 'CA') || !['canceled','completed'].includes(status)) throw Error('Invalid call termination');
    return this.request(`/Calls/${callSid}.json`, {Status: status});
  }
  async set(numberSid, form) {
    if (!sid(numberSid, 'PN')) throw Error('Invalid phone number SID');
    await this.request(`/IncomingPhoneNumbers/${numberSid}.json`, form);
  }
}
