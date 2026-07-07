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
      prompt: promptSummary,
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
