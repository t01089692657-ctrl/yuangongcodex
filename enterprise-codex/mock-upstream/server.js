// Fake OpenAI-compatible upstream for the demo, so the full flow runs without
// calling (or paying for) a real provider. Implements the two endpoints Codex
// and OpenAI clients use, returning a canned answer plus a realistic `usage`
// block. Supports both JSON and SSE (?stream / "stream":true).
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8091);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
// Rough token estimate so the leaderboard varies by real request size.
const estTokens = (s) => Math.max(1, Math.ceil((s || '').length / 4));

const server = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
  const promptText = JSON.stringify(body.input ?? body.messages ?? body.prompt ?? '');
  const promptTokens = estTokens(promptText);
  const answer = 'Mock upstream OK — request reached the model provider through the gateway.';
  const completionTokens = estTokens(answer);
  const usage = {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
  };

  const wantsStream = body.stream === true || req.url.includes('stream');
  if (wantsStream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: answer })}\n\n`);
    res.write(`event: response.completed\ndata: ${JSON.stringify({ response: { usage } })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'resp_mock_' + Date.now(),
    object: req.url.includes('responses') ? 'response' : 'chat.completion',
    model: body.model || 'gpt-5-codex',
    output_text: answer,
    choices: [{ message: { role: 'assistant', content: answer } }],
    usage,
  }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-upstream] listening on http://127.0.0.1:${PORT}`));
