import { setTimeout as delay } from 'node:timers/promises';

function endpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid Ez agent endpoint');
  return url;
}

async function call(path, body, { url, token, signal, fetchImpl }) {
  if (!/^[A-Za-z0-9_-]{43,200}$/.test(token || '')) throw new Error('Ez agent credential is missing');
  const response = await fetchImpl(new URL(path, endpoint(url)), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Ez agent returned HTTP ${response.status}`);
  return response.json().catch(() => { throw new Error('Ez agent response is invalid'); });
}

export async function runAgentTurn(input, connection, { fetchImpl = fetch, pollMs = 750, onAdmitted } = {}) {
  let run = await call('/v1/runs', input, { ...connection, fetchImpl });
  await onAdmitted?.(run.id);
  while (['queued', 'running'].includes(run.status)) {
    await delay(pollMs, undefined, { signal: connection.signal });
    run = await call(`/v1/runs/${encodeURIComponent(run.id)}`, undefined, { ...connection, fetchImpl });
  }
  if (run.status !== 'completed') throw new Error(`Ez agent run ${run.status || 'failed'}`);
  const reply = run.messages?.filter(message => typeof message.text === 'string' && message.text.trim()).at(-1)?.text;
  if (!reply) throw new Error('Ez agent completed without a reply');
  return { runId: run.id, reply };
}

export async function cancelAgentTurn(runId, connection, { fetchImpl = fetch } = {}) {
  if (!/^r_app_[a-f0-9]{64}$/.test(runId || '')) throw new Error('Invalid Ez agent run');
  return call(`/v1/runs/${runId}/cancel`, {}, { ...connection, signal: AbortSignal.timeout(10_000), fetchImpl });
}
