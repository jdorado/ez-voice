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
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/; // an `at` is a time with its offset

// Words around an address in speech that are never part of it. Place names are not filler: a street is often named for
// one (Queens Boulevard, New York Avenue), so they stay, and a caller who adds a city only adds words.
const FILLER = new Set(['the', 'a', 'an', 'my', 'our', 'house', 'home', 'property', 'building', 'at', 'on', 'in', 'is', 'it', 'its', 'of', 'and', 'for', 'about', 'to', 'i', 'am', 'calling']);
// A street's type word and a leading direction are not its name; a unit or a ZIP ends the street address.
const TYPES = new Set(['street', 'avenue', 'road', 'boulevard', 'drive', 'lane', 'place', 'court', 'parkway', 'terrace', 'way']);
const DIRECTIONS = new Set(['east', 'west', 'north', 'south']);
const UNIT = new Set(['apt', 'apartment', 'unit', 'suite', 'ste', 'floor', 'fl']);
const ABBREVIATIONS = {st: 'street', ave: 'avenue', av: 'avenue', rd: 'road', blvd: 'boulevard', dr: 'drive', ln: 'lane', pl: 'place', ct: 'court', pkwy: 'parkway', ter: 'terrace', e: 'east', w: 'west', n: 'north', s: 'south'};
const HOUSE = /^\d+(-\d+)?$/; // a house number, a hyphenated one included (88-10)

// The words of an address: lower case, abbreviations spelled out, "102nd" as 102, a hyphenated house number kept whole,
// filler dropped.
export function tokens(value) {
  return String(value).toLowerCase().replace(/(\d+)(st|nd|rd|th)\b/g, '$1').replace(/(\d)\s*-\s*(\d)/g, '$1-$2')
    .replace(/[^a-z0-9-]+/g, ' ').replace(/(^|\s)-+|-+(\s|$)/g, ' ').split(' ')
    .filter(Boolean).map(word => ABBREVIATIONS[word] ?? word).filter(word => !FILLER.has(word));
}

// An address's house number and street name: the words between the house number and the street type (or the end), without
// a leading direction; a unit or a ZIP and anything after it is not the street. "1450 East 102 Street" is 1450 and [102].
export function street(words) {
  const end = words.findIndex((word, i) => i > 0 && (UNIT.has(word) || /^\d{5}$/.test(word)));
  const list = end > 0 ? words.slice(0, end) : words;
  if (!HOUSE.test(list[0] ?? '')) return null;
  const type = list.findIndex((word, i) => i > 1 && TYPES.has(word));
  const name = list.slice(1, type > 0 ? type : list.length);
  while (name.length > 1 && DIRECTIONS.has(name[0])) name.shift();
  return name.length ? {house: list[0], name} : null;
}

// Several properties of one caller are separated by ';' in `find`.
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');

export function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_CONTEXTS) throw Error(`Supply at most ${MAX_CONTEXTS} caller contexts`);
  const seen = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['number', 'text', 'claim', 'find', 'at'].includes(key))
      || !phone(entry.number) || seen.has(entry.number) || !text(entry.text, MAX_CONTEXT_TEXT) || !text(entry.claim, MAX_CLAIM_TEXT)
      || !text(entry.find, MAX_FIND) || (entry.at !== undefined && (typeof entry.at !== 'string' || !ISO.test(entry.at) || !Number.isFinite(Date.parse(entry.at))))) throw Error('Invalid caller context');
    seen.add(entry.number);
    return {number: entry.number, text: entry.text, claim: entry.claim, find: entry.find.split(';').map(address => tokens(address).join(' ')).filter(Boolean).join(';'), at: new Date(entry.at ?? Date.now()).toISOString()};
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
  // The claims of the contexts whose property the query names: the first number said is the address's house number, and
  // every word of the address's street name (a numbered street's number included, as the 102 of "1450 East 102nd") is in
  // the query. Other words (a city, a ZIP, an apartment) only add to it. A claim is the little a stranger who names the
  // property may be told.
  search(query) {
    const said = tokens(typeof query === 'string' ? query.slice(0, 200) : ''), wanted = new Set(said);
    const house = said.find(word => HOUSE.test(word));
    if (!house) return [];
    const found = [];
    for (const row of this.db.prepare('SELECT claim, find FROM contexts').all()) {
      const named = row.find.split(';').some(address => {
        const known = street(address.split(' '));
        return known !== null && known.house === house && known.name.every(word => wanted.has(word));
      });
      if (named) found.push(row.claim);
      if (found.length >= MAX_LOOKUPS) break;
    }
    return found;
  }
  close() { this.db.close(); }
}
