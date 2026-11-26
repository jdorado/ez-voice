import test from 'node:test';
import assert from 'node:assert/strict';
import {ListenTap, tapped} from '../src/phone-listen.mjs';
import {ulawToPcm, pcmToUlaw} from '../src/phone-providers/g711.mjs';

const tone = (value, n = 160) => pcmToUlaw(new Int16Array(n).fill(value)).toString('base64');

test('each caller frame is mixed with the same span of our queued audio; a clear drops what was not played', () => {
  const tap = new ListenTap(), sent = [];
  const socket = tapped({readyState: 1, send: raw => sent.push(raw)}, tap);
  assert.equal(socket.readyState, 1);
  tap.set(true);
  socket.send(JSON.stringify({event: 'media', media: {payload: tone(1000, 320)}})); // 40 ms of ours, sent ahead
  tap.caller(tone(2000));
  const first = ulawToPcm(Buffer.from(tap.take(), 'base64'));
  assert.equal(first.length, 160); assert(Math.abs(first[0] - 3000) < 200, `mixed ${first[0]}`);
  socket.send(JSON.stringify({event: 'clear'}));
  tap.caller(tone(2000));
  assert(Math.abs(ulawToPcm(Buffer.from(tap.take(), 'base64'))[0] - 2000) < 150); // ours was cleared
  assert.equal(sent.length, 2); // the socket still got both
  tap.set(false); tap.caller(tone(2000));
  assert.equal(tap.take(), undefined); // nothing kept while nobody listens
});
