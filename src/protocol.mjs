import { createInterface } from 'node:readline';

export const MAX_FRAME = 1024 * 1024;
export function frames(stream, onFrame, onError) {
  // Bound a partial line as well as completed frames.
  let pending = 0;
  stream.on('data', chunk => {
    for (const byte of Buffer.from(chunk)) {
      if (byte === 10) pending = 0;
      else if (++pending > MAX_FRAME) { onError(new Error('Frame too large')); return; }
    }
  });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  reader.on('line', line => {
    try {
      if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('Frame too large');
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid frame');
      Promise.resolve(onFrame(value)).catch(onError);
    } catch (error) { onError(error); }
  });
  return reader;
}
export function send(stream, value) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('Frame too large');
  if (!stream.destroyed && stream.writable) stream.write(line + '\n');
}
export function text(value, max = 16000) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid text');
  return value;
}
