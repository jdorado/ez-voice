import {mkdirSync, openSync, closeSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {phone} from './phone-provider.mjs';

// Prepared caller contexts, the call centre's "screen pop": text an operator prepares for a caller's number, kept
// here so an inbound call is answered already knowing who rings, with no lookup over the network and no model before
// the greeting. The operator replaces the whole set; this store reads it and decides nothing about what may be said.
export const MAX_CONTEXTS = 500;
export const MAX_CONTEXT_TEXT = 6000;
export const MAX_CLAIM_TEXT = 600;
const MAX_FIND = 400;
export const MAX_LOOKUPS = 3;

const FILLER = new Set(['the', 'a', 'an', 'my', 'our', 'house', 'home', 'property', 'building', 'apartment', 'at', 'on', 'in', 'is', 'it', 'its', 'of', 'and', 'for', 'about', 'to', 'i', 'am', 'calling', 'brooklyn', 'queens', 'bronx', 'manhattan', 'new', 'york', 'nyc', 'ny']);
const ABBREVIATIONS = {st: 'street', ave: 'avenue', av: 'avenue', rd: 'road', blvd: 'boulevard', dr: 'drive', ln: 'lane', pl: 'place', ct: 'court', pkwy: 'parkway', e: 'east', w: 'west', n: 'north', s: 'south'};

// The words of an address: lower case, abbreviations spelled out, "102nd" as 102, filler dropped.
export function tokens(value) {
  return String(value).toLowerCase().replace(/(\d+)(st|nd|rd|th)\b/g, '$1').replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(Boolean).map(word => ABBREVIATIONS[word] ?? word).filter(word => !FILLER.has(word));
}

const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');

export function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_CONTEXTS) throw Error(`Supply at most ${MAX_CONTEXTS} caller contexts`);
  const seen = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['number', 'text', 'claim', 'find', 'at'].includes(key))
      || !phone(entry.number) || seen.has(entry.number) || !text(entry.text, MAX_CONTEXT_TEXT) || !text(entry.claim, MAX_CLAIM_TEXT)
      || !text(entry.find, MAX_FIND) || (entry.at !== undefined && !Number.isFinite(Date.parse(entry.at)))) throw Error('Invalid caller context');
    seen.add(entry.number);
    return {number: entry.number, text: entry.text, claim: entry.claim, find: tokens(entry.find).join(' '), at: entry.at ?? new Date().toISOString()};
  });
}

export class PhoneContexts {
  constructor(directory) {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const path = join(directory, 'contexts.sqlite'); closeSync(openSync(path, 'a', 0o600));
    this.db = new DatabaseSync(path, {timeout: 0});
    this.db.exec('CREATE TABLE IF NOT EXISTS contexts (number TEXT PRIMARY KEY, text TEXT NOT NULL, claim TEXT NOT NULL, find TEXT NOT NULL, at TEXT NOT NULL)');
  }
  // The whole set at once, atomically: a number no longer in it is no longer known.
  replace(entries) {
    const rows = validateEntries(entries);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM contexts');
      const insert = this.db.prepare('INSERT INTO contexts(number,text,claim,find,at) VALUES(?,?,?,?,?)');
      for (const row of rows) insert.run(row.number, row.text, row.claim, row.find, row.at);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.status();
  }
  status() {
    const row = this.db.prepare('SELECT count(*) AS count, max(at) AS latest FROM contexts').get();
    return {count: Number(row.count), latest: row.latest ?? null};
  }
  byNumber(number) { return phone(number) ? this.db.prepare('SELECT text FROM contexts WHERE number=?').get(number)?.text : undefined; }
  // The claims of the contexts whose property the query names: every number in the query must be in the address (a house
  // number is required) and at least one street word. A claim is the little a stranger who names the property may be told.
  search(query) {
    const wanted = new Set(tokens(typeof query === 'string' ? query.slice(0, 200) : ''));
    const digits = [...wanted].filter(word => /^\d+$/.test(word)), words = [...wanted].filter(word => !/^\d+$/.test(word));
    if (!digits.length || !words.length) return [];
    const found = [];
    for (const row of this.db.prepare('SELECT claim, find FROM contexts').all()) {
      const have = new Set(row.find.split(' '));
      // the first number said is the house number, which must be the address's own
      if (digits[0] === row.find.split(' ')[0] && digits.every(word => have.has(word)) && words.some(word => have.has(word))) found.push(row.claim);
      if (found.length >= MAX_LOOKUPS) break;
    }
    return found;
  }
  close() { this.db.close(); }
}
