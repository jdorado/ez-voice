import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { webOrigin } from './web-auth.mjs';

const lifetime = 5 * 60 * 1000;
const ownerKey = owner => {
  if (!owner || !Number.isSafeInteger(owner.telegramUserId) || owner.telegramUserId <= 0 || typeof owner.pairedAt !== 'string' || !owner.pairedAt) throw Error('Paired owner unavailable');
  return JSON.stringify([owner.telegramUserId, owner.pairedAt]);
};
// Shared private state across the command and web containers. No raw ticket is stored.
export class LaunchLinks {
  constructor(state, { now = Date.now } = {}) { this.root = join(state, 'launch-links'); this.now = now; }
  async bind(origin) {
    if (webOrigin(origin).protocol !== 'https:') throw Error('Owner links require HTTPS');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const tmp = join(this.root, randomUUID() + '.tmp');
    await writeFile(tmp, JSON.stringify({ origin }), { mode: 0o600, flag: 'wx' });
    await rename(tmp, join(this.root, 'origin.json'));
  }
  async issue(owner, task) {
    const key = task ? undefined : ownerKey(owner);
    const { origin } = JSON.parse(await readFile(join(this.root, 'origin.json'), 'utf8'));
    if (webOrigin(origin).protocol !== 'https:') throw Error('Owner links require HTTPS');
    let outstanding = 0;
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(this.root, name);
      const record = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
      if (record && record.expiresAt > this.now()) outstanding++;
      else await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
    if (outstanding >= 32) throw Error('Too many outstanding links; wait for expiry');
    const ticket = randomBytes(32).toString('hex'), expiresAt = this.now() + lifetime;
    const hash = createHash('sha256').update(ticket).digest('hex');
    await writeFile(join(this.root, hash + '.json'), JSON.stringify({ key, origin, expiresAt, ...(task ? {task} : {}) }), { mode: 0o600, flag: 'wx' });
    return { url: origin + '/#launch=' + ticket, expiresAt };
  }
  async redeem(ticket, owner, origin, validateTask) {
    if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) throw Error('Invalid owner link');
    const path = join(this.root, createHash('sha256').update(ticket).digest('hex') + '.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.expiresAt <= this.now() || record.origin !== origin || (!record.task && record.key !== ownerKey(owner))) throw Error('Expired or revoked owner link');
    if(record.task){if(!validateTask)throw Error("Discussion access unavailable");await validateTask(record.task);}
    // rename is the cross-process single-use admission point; only one redeemer wins.
    const consumed = join(this.root, randomUUID() + '.used');
    await rename(path, consumed);
    await unlink(consumed);
    if (record.expiresAt <= this.now()) throw Error('Expired owner link');
    return record.task ? {task:record.task} : {owner};
  }
}
