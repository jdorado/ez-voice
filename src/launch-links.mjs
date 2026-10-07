import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { webOrigin } from './web-auth.mjs';

const lifetime = 5 * 60 * 1000;
// The web service refreshes its heartbeat; a launch command only trusts a recent one.
export const heartbeatInterval = 15 * 1000, heartbeatLifetime = 60 * 1000;
const maxOutstanding = 32, litterAge = 60 * 1000;
const ticketName = /^[a-f0-9]{64}\.json$/;
const ignoreMissing = e => { if (e.code !== 'ENOENT') throw e; };
const ownerKey = owner => {
  if (!owner || !Number.isSafeInteger(owner.telegramUserId) || owner.telegramUserId <= 0 || typeof owner.pairedAt !== 'string' || !owner.pairedAt) throw Error('Paired owner unavailable');
  return JSON.stringify([owner.telegramUserId, owner.pairedAt]);
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Shared private state across the command and web containers. No raw ticket is stored.
export class LaunchLinks {
  constructor(state, { now = Date.now } = {}) { this.root = join(state, 'launch-links'); this.now = now; }
  async #writeOrigin(origin) {
    const tmp = join(this.root, randomUUID() + '.tmp');
    await writeFile(tmp, JSON.stringify({ origin, heartbeat: this.now() }), { mode: 0o600, flag: 'wx' });
    await rename(tmp, join(this.root, 'origin.json'));
  }
  // Remove expired/unusable tickets and (when old enough not to be in flight) leftover temp/consumed files.
  // A ticket file that cannot be parsed is skipped, never unlinked: it may be mid-write by another process.
  async #sweep(origin) {
    let outstanding = 0;
    for (const name of await readdir(this.root)) {
      const path = join(this.root, name);
      if (/\.(tmp|used)$/.test(name)) {
        const info = await stat(path).catch(e => ignoreMissing(e));
        if (info && Date.now() - info.mtimeMs > litterAge) await unlink(path).catch(ignoreMissing);
        continue;
      }
      if (!ticketName.test(name)) continue;
      const raw = await readFile(path, 'utf8').catch(e => ignoreMissing(e));
      if (raw === undefined) continue;
      let record;
      try { record = JSON.parse(raw); } catch { continue; }
      if (record && !this.#dead(record) && (origin === undefined || record.origin === origin)) outstanding++;
      else await unlink(path).catch(ignoreMissing);
    }
    return outstanding;
  }
  // A discussion ticket stores a bearer task token, so it dies with its own grant too.
  #dead(record) { return !(record.expiresAt > this.now()) || (record.task && !(record.task.expiresAt > this.now())); }
  async bind(origin) {
    if (webOrigin(origin).protocol !== 'https:') throw Error('Owner links require HTTPS');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.#writeOrigin(origin);
    // A (re)started web service invalidates tickets for expired lifetimes or any other origin.
    await this.#sweep(origin);
  }
  async heartbeat(origin) { await this.#writeOrigin(origin); }
  async unbind() { await unlink(join(this.root, 'origin.json')).catch(ignoreMissing); }
  async #locked(work) {
    const lock = join(this.root, 'issue.lock');
    for (let attempt = 0; ; attempt++) {
      try { await writeFile(lock, String(process.pid), { mode: 0o600, flag: 'wx' }); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const info = await stat(lock).catch(e => ignoreMissing(e));
        if (info && Date.now() - info.mtimeMs > 10000) await unlink(lock).catch(ignoreMissing);
        else if (attempt >= 200) throw Error('Launch link state is busy; retry');
        else await pause(10);
      }
    }
    try { return await work(); } finally { await unlink(lock).catch(ignoreMissing); }
  }
  async issue(owner, task) {
    const key = task ? undefined : ownerKey(owner);
    const bound = await readFile(join(this.root, 'origin.json'), 'utf8').then(JSON.parse).catch(e => {
      if (e.code === 'ENOENT') throw Error('Voice web service is not running; start it with ez plugins before requesting a launch link');
      throw e;
    });
    const { origin } = bound;
    if (webOrigin(origin).protocol !== 'https:') throw Error('Owner links require HTTPS');
    if (!Number.isFinite(bound.heartbeat) || this.now() - bound.heartbeat > heartbeatLifetime)
      throw Error('Voice web service is not running (no recent heartbeat); start it with ez plugins before requesting a launch link');
    return this.#locked(async () => {
      if (await this.#sweep(origin) >= maxOutstanding) throw Error('Too many outstanding links; wait for expiry');
      const ticket = randomBytes(32).toString('hex'), expiresAt = this.now() + lifetime;
      const hash = createHash('sha256').update(ticket).digest('hex');
      const tmp = join(this.root, randomUUID() + '.tmp');
      await writeFile(tmp, JSON.stringify({ key, origin, expiresAt, ...(task ? { task } : {}) }), { mode: 0o600, flag: 'wx' });
      await rename(tmp, join(this.root, hash + '.json'));
      return { url: origin + '/#launch=' + ticket, expiresAt };
    });
  }
  // `owner` is the current owner or a function returning it; it is read only for owner tickets.
  async redeem(ticket, owner, origin, validateTask) {
    if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) throw Error('Invalid owner link');
    const path = join(this.root, createHash('sha256').update(ticket).digest('hex') + '.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    await this.#sweep(); // expired tickets, including a stored bearer, do not outlive a redemption attempt
    // Establish the ticket type before consuming it; a task ticket never consults the owner.
    const isTask = record.task !== undefined;
    if (isTask ? record.key !== undefined : typeof record.key !== 'string') throw Error('Expired or revoked owner link');
    if (this.#dead(record) || record.origin !== origin) throw Error('Expired or revoked owner link');
    let current;
    if (!isTask) {
      current = typeof owner === 'function' ? await owner() : owner;
      if (record.key !== ownerKey(current)) throw Error('Expired or revoked owner link');
    } else {
      if (!validateTask) throw Error('Discussion access unavailable');
      await validateTask(record.task);
    }
    // rename is the cross-process single-use admission point; only one redeemer wins.
    const consumed = join(this.root, randomUUID() + '.used');
    await rename(path, consumed);
    await unlink(consumed);
    if (this.#dead(record)) throw Error('Expired owner link');
    return isTask ? { task: record.task } : { owner: current };
  }
}
