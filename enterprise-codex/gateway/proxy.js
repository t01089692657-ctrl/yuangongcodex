// Reverse proxy to the upstream model provider (your own OpenAI/Azure key),
// with token metering. Supports both plain JSON and SSE streaming responses.
import { config } from './config.js';

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  // Responses API uses input/output_tokens; Chat Completions uses prompt/completion_tokens.
  const promptTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

// Extract usage from a full SSE body (best effort): scan data: lines for a
// JSON object carrying a usage field (response.completed / final chunk).
function usageFromSSE(text) {
  let found = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      const u = obj.usage || obj.response?.usage;
      if (u) found = normalizeUsage(u);
    } catch { /* partial/non-JSON event, ignore */ }
  }
  return found;
}

// pathSuffix is everything after the gateway's /v1 (e.g. "/responses").
export async function proxyRequest({ pathSuffix, search = '', method, headers, bodyBuffer, identity, store, res }) {
  const url = config.upstreamBaseUrl.replace(/\/$/, '') + pathSuffix + (search || '');

  const upstreamHeaders = {
    'content-type': headers['content-type'] || 'application/json',
    accept: headers['accept'] || 'application/json',
    authorization: `Bearer ${config.upstreamApiKey}`,
  };
  // Preserve Codex sticky-session hint so multi-account upstreams pin correctly.
  if (headers['session_id']) upstreamHeaders['session_id'] = headers['session_id'];

  let upstream;
  try {
    upstream = await fetch(url, {
      method,
      headers: upstreamHeaders,
      body: method === 'GET' || method === 'HEAD' ? undefined : bodyBuffer,
    });
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `upstream unreachable: ${err.message}` } }));
    return;
  }

  let model = 'unknown';
  try { model = JSON.parse(bodyBuffer.toString('utf8') || '{}').model || 'unknown'; } catch { /* ignore */ }

  const ct = upstream.headers.get('content-type') || '';
  const meter = (usage, path) => {
    if (!usage) return;
    store.recordUsage({
      ts: new Date().toISOString(),
      email: identity.email,
      model,
      path,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    });
  };

  if (ct.includes('text/event-stream') && upstream.body) {
    // Stream to the client while teeing the text for usage extraction. A
    // mid-stream upstream reset must not crash the gateway, so guard the loop
    // and honor client backpressure instead of buffering unboundedly.
    res.writeHead(upstream.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let buffered = '';
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        if (!res.write(value)) await new Promise((r) => res.once('drain', r));
      }
    } catch (err) {
      console.error('[proxy] stream error:', err?.message || err);
    } finally {
      try { res.end(); } catch { /* client gone */ }
    }
    meter(usageFromSSE(buffered), pathSuffix);
    return;
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, { 'content-type': ct || 'application/json' });
  res.end(buf);
  try { meter(normalizeUsage(JSON.parse(buf.toString('utf8')).usage), pathSuffix); } catch { /* non-JSON */ }
}
