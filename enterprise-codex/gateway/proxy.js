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

// Pull a short, human-readable summary of what the employee asked Codex, from
// either the Responses API (`input`) or Chat Completions (`messages`) shape.
// Controlled by ACTIVITY_CAPTURE: 'summary' (truncated, default), 'full', 'off'.
function summarizePrompt(body) {
  if (config.activityCapture === 'off') return null;
  let text = '';
  try {
    if (typeof body.input === 'string') {
      text = body.input;
    } else if (Array.isArray(body.input)) {
      // Responses API: last user message's text parts.
      const userMsgs = body.input.filter((m) => !m.role || m.role === 'user');
      const last = userMsgs[userMsgs.length - 1] || body.input[body.input.length - 1];
      text = partsToText(last);
    } else if (Array.isArray(body.messages)) {
      const userMsgs = body.messages.filter((m) => m.role === 'user');
      text = partsToText(userMsgs[userMsgs.length - 1]);
    }
  } catch { /* best effort */ }
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (config.activityCapture === 'full') return text.slice(0, 4000);
  return text.length > config.activitySummaryChars ? text.slice(0, config.activitySummaryChars) + '…' : text;
}
function partsToText(msg) {
  if (!msg) return '';
  const c = msg.content ?? msg.text ?? '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p.text || p.input_text || '')).join(' ');
  return '';
}

// Choose an upstream for this request. Admin-added pool upstreams take priority
// (weighted round-robin, skipping ones marked 'down'); if the pool is empty we
// fall back to the single UPSTREAM_* configured at setup.
let rrCounter = 0;
function pickUpstream(store) {
  const enabled = store.listUpstreams().filter((u) => u.enabled && u.baseUrl);
  let candidates = enabled.filter((u) => u.health?.status !== 'down');
  if (!candidates.length) candidates = enabled; // all down -> try anyway rather than fail
  if (!candidates.length) {
    if (!config.upstreamBaseUrl) return null;
    return { id: null, baseUrl: config.upstreamBaseUrl, apiKey: config.upstreamApiKey, name: 'default (config)' };
  }
  const rotation = [];
  for (const u of candidates) for (let i = 0; i < (u.weight || 1); i++) rotation.push(u);
  const chosen = rotation[rrCounter % rotation.length];
  rrCounter = (rrCounter + 1) % 1_000_000_000;
  return chosen;
}

// pathSuffix is everything after the gateway's /v1 (e.g. "/responses").
export async function proxyRequest({ pathSuffix, search = '', method, headers, bodyBuffer, identity, store, res }) {
  const up = pickUpstream(store);
  if (!up) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no upstream configured — add one in the admin console' } }));
    return;
  }
  const url = up.baseUrl.replace(/\/$/, '') + pathSuffix + (search || '');

  const upstreamHeaders = {
    'content-type': headers['content-type'] || 'application/json',
    accept: headers['accept'] || 'application/json',
    authorization: `Bearer ${up.apiKey}`,
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
    store.markUpstreamHealth(up.id, false, `unreachable: ${err.message}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `upstream unreachable: ${err.message}` } }));
    return;
  }
  // Key/limit failures count against the upstream's health; ordinary 4xx don't.
  const healthy = upstream.status < 500 && ![401, 403, 429].includes(upstream.status);
  store.markUpstreamHealth(up.id, healthy, healthy ? null : `status ${upstream.status}`);

  let model = 'unknown';
  let reqBody = {};
  try { reqBody = JSON.parse(bodyBuffer.toString('utf8') || '{}'); model = reqBody.model || 'unknown'; } catch { /* ignore */ }
  const promptSummary = summarizePrompt(reqBody); // what the employee asked Codex

  const ct = upstream.headers.get('content-type') || '';
  const meter = (usage, path) => {
    if (!usage) return;
    store.recordUsage({
      ts: new Date().toISOString(),
      email: identity.email,
      model,
      path,
      upstream: up.name,
      prompt: promptSummary,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    });
  };

  if (ct.includes('text/event-stream') && upstream.body) {
    // Stream to the client while teeing the text for usage extraction. Guard the
    // loop so a mid-stream upstream reset can't crash the gateway, and if the
    // CLIENT disconnects, cancel the upstream reader so we don't hang/leak it.
    res.writeHead(upstream.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let buffered = '';
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let clientGone = false;
    const onClose = () => { clientGone = true; reader.cancel().catch(() => {}); };
    res.once('close', onClose);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || clientGone) break;
        buffered += decoder.decode(value, { stream: true });
        if (!res.write(value)) {
          // Wait for drain OR client close — never block forever on a gone client.
          await new Promise((resolve) => {
            const finish = () => { res.off('drain', finish); res.off('close', finish); resolve(); };
            res.once('drain', finish);
            res.once('close', finish);
          });
        }
      }
    } catch (err) {
      console.error('[proxy] stream error:', err?.message || err);
    } finally {
      res.off('close', onClose);
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
