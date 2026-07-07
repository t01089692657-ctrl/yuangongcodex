// Company MCP server (stdio, JSON-RPC 2.0) — the push-type "skills" channel.
// Codex connects to this; editing the server updates every employee at once.
// Zero deps. Implements initialize / tools/list / tools/call per the MCP spec
// (newline-delimited JSON messages over stdio).
import readline from 'node:readline';

const DEFAULT_PROTOCOL = '2025-06-18';

const TOOLS = {
  get_coding_standard: {
    description: 'Return the authoritative company coding standard for a topic.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'e.g. "tests", "secrets", "reviews"' } },
    },
    run: ({ topic }) => {
      const book = {
        tests: 'Write a test alongside any nontrivial change; run it before claiming it works.',
        secrets: 'No secrets in code, logs, or commits. Keys are provisioned by the client, never hardcoded.',
        reviews: 'Small focused diffs; explain why not what; flag auth/billing/PII for human review.',
      };
      return book[(topic || '').toLowerCase()] || 'See AGENTS.md for the full company standard.';
    },
  },
  scaffold_service: {
    description: 'Return a company-approved starter for a new internal HTTP service.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    run: ({ name }) =>
      `// ${name}: company service scaffold\n// - config via env, secrets from the platform, all egress via the gateway\nexport function start() { /* ... */ }\n`,
  },
};

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'company-mcp', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // notifications: no reply
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
    });
  }
  if (method === 'tools/call') {
    const tool = TOOLS[params?.name];
    if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const out = tool.run(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text: String(out) }], isError: false });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  if (typeof id !== 'undefined') return replyError(id, -32601, `method not found: ${method}`);
});
