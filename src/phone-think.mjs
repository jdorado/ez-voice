// The think relay of a line with a side coach: the managed speech provider sends its language-model requests to the
// listener, which adds the call's latest coach note to that one request and streams the model's answer straight back.
// The note never joins the standing prompt, nothing waits for a lookup, and the language-model key stays here.
import {once} from 'node:events';

export const MAX_THINK_REQUEST = 4 * 1024 * 1024;

async function json(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > MAX_THINK_REQUEST) throw Error('Think request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// `bridge` is the call's PhoneAudio: `think(body)` returns the request to send, `adapter.thinkTarget()` where to send it.
export async function relayThink(request, response, bridge, {fetch: fetchImpl = fetch} = {}) {
  const abort = new AbortController();
  response.on('close', () => { if (!response.writableFinished) abort.abort(); });
  let upstream;
  try {
    const body = bridge.think(await json(request)), target = bridge.adapter.thinkTarget();
    upstream = await fetchImpl(target.url, {method: 'POST', redirect: 'error', signal: abort.signal,
      headers: {...target.headers, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  } catch { if (!response.headersSent) { response.writeHead(abort.signal.aborted ? 499 : 502); response.end(); } return; }
  response.writeHead(upstream.status, {'Content-Type': upstream.headers.get('content-type') ?? 'application/json'});
  try {
    if (upstream.body) for await (const chunk of upstream.body) if (!response.write(chunk)) await once(response, 'drain');
    response.end();
  } catch { response.destroy(); }
}
