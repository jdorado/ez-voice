import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import {isAbsolute, join, relative} from 'node:path';

// A line's persona can live in files the operator keeps in a folder bound read-only into the container
// (`instructionsRoot`), instead of a string in the private phone profile. The files are read at the start of every
// call and never cached, so editing one changes the next call with no restart. A file that cannot be read in full
// refuses the call: there is no fallback to the default instructions or to an earlier read.
export const MAX_INSTRUCTIONS_FILES = 8;
const MAX_PATH = 256;
const segments = path => path.split('/').every(segment => segment && segment !== '.' && segment !== '..');
const relativePath = path => typeof path === 'string' && path.length <= MAX_PATH && !/[\\\0]/.test(path) && segments(path);
const rootPath = path => typeof path === 'string' && path.length <= 1024 && path.startsWith('/') && path !== '/' && !/[\\\0]/.test(path) && segments(path.slice(1));

export class InstructionsError extends Error {
  constructor(path, reason) { super(`Phone instructions file ${path} is unavailable (${reason}); no call can start without it`); this.path = path; this.reason = reason; }
}
export const instructionsDigest = text => createHash('sha256').update(text).digest('hex');

// Configuration time: the shape only. Whether the files exist is checked when a call starts (and by `phone doctor`).
export function validateInstructionsSource(line) {
  const {instructions, instructionsFiles: files, instructionsRoot: root} = line;
  if (files === undefined) { if (root !== undefined) throw Error('instructionsRoot applies to instructionsFiles only'); return; }
  if (instructions !== undefined) throw Error('Set instructions or instructionsFiles, not both');
  if (!Array.isArray(files) || !files.length || files.length > MAX_INSTRUCTIONS_FILES || !files.every(relativePath)) throw Error(`instructionsFiles must list 1..${MAX_INSTRUCTIONS_FILES} relative file paths (no absolute path, .., backslash or empty segment)`);
  if (root === undefined) throw Error('instructionsFiles requires instructionsRoot');
  if (!rootPath(root)) throw Error('instructionsRoot must be an absolute directory path other than / (no trailing slash, .., backslash or empty segment)');
}

// One file, read whole and fresh: {path, text} or {path, reason}. The text never reaches an error or a log.
async function readOne(root, path, limit) {
  let handle;
  try {
    let real;
    try { real = await realpath(join(root, path)); } catch (error) { return {path, reason: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unreadable'}; }
    const inside = relative(root, real);
    if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) return {path, reason: 'outside_root'};
    // The resolved path may not be swapped for a link or a pipe between the check and the read.
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) return {path, reason: 'not_a_file'};
    const cap = limit * 4; // a character is at most four bytes
    if (info.size > cap) return {path, reason: 'too_large'};
    const buffer = Buffer.allocUnsafe(cap + 1); let size = 0;
    while (size < buffer.length) { const {bytesRead} = await handle.read(buffer, size, buffer.length - size, size); if (!bytesRead) break; size += bytesRead; }
    if (size > cap) return {path, reason: 'too_large'};
    let text; try { text = new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, size)); } catch { return {path, reason: 'not_utf8'}; }
    return !text.trim() ? {path, reason: 'empty'} : text.length > limit ? {path, reason: 'too_large'} : {path, text};
  } catch { return {path, reason: 'unreadable'}; }
  finally { await handle?.close().catch(() => {}); }
}
// Every file of the line, in order: the entries, and the joined text when all are readable and fit `limit` together.
async function readAll(line, limit) {
  let root;
  try { root = await realpath(line.instructionsRoot); } catch { return {entries: line.instructionsFiles.map(path => ({path, reason: 'root_unavailable'}))}; }
  const entries = []; let length = 0;
  for (const path of line.instructionsFiles) {
    const entry = await readOne(root, path, limit);
    if (entry.text !== undefined && (length += entry.text.length + (entries.length ? 2 : 0)) > limit) entries.push({path, reason: 'too_large'}); else entries.push(entry);
  }
  return entries.every(entry => entry.text !== undefined) ? {entries, text: entries.map(entry => entry.text).join('\n\n')} : {entries};
}
// The instructions a call on a line with `instructionsFiles` starts with: the files read now, a blank line between them.
export async function instructionsFromFiles(line, limit) {
  const {entries, text} = await readAll(line, limit);
  const failed = entries.find(entry => entry.text === undefined);
  if (failed) throw new InstructionsError(failed.path, failed.reason);
  return text;
}
// For `phone doctor`: whether each file is readable now, and the digest of the text a call would start with.
export async function inspectInstructions(line, limit) {
  const {entries, text} = await readAll(line, limit);
  return {instructionsFiles: entries.map(entry => entry.text !== undefined ? {path: entry.path, ok: true} : {path: entry.path, ok: false, reason: entry.reason}), ...(text !== undefined && {instructionsSha256: instructionsDigest(text)})};
}
