// Enterprise Codex gateway (Plane A): identity -> key issuance -> metered
// proxy to your own upstream -> usage/leaderboard -> instant offboarding ->
// skill distribution. Zero external dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { Store } from './store.js';
import { issueKeyForEmployee, resolveKey, offboardEmployee, httpError } from './auth.js';
import { proxyRequest } from './proxy.js';

const store = new Store(config.dataDir, config.seedFile);

// --- helpers ----------------------------------------------------------
function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}
function requireAdmin(req) {
  if (bearer(req) !== config.adminToken) throw httpError(401, 'admin auth required');
}

// Verify Feishu/Lark webhook: HMAC-SHA256(secret, rawBody) in x-signature.
function verifyFeishu(req, rawBody) {
  const sig = req.headers['x-signature'] || '';
  const expected = crypto.createHmac('sha256', config.feishuWebhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Enumerate distributable skills: global AGENTS.md + prompts/*.md.
function buildSkillManifest() {
  const files = [];
  const add = (rel) => {
    const abs = path.join(config.skillsDir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      files.push({ path: rel, sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') });
    }
  };
  add('AGENTS.md');
  const promptsDir = path.join(config.skillsDir, 'prompts');
  if (fs.existsSync(promptsDir)) {
    for (const f of fs.readdirSync(promptsDir)) if (f.endsWith('.md')) add(path.join('prompts', f));
  }
  return {
    version: crypto.createHash('sha256').update(files.map((f) => f.sha256).join('')).digest('hex').slice(0, 12),
    files,
    // Push-type skills: point Codex at the company MCP. Prefer a remote URL in
    // prod; the demo ships a local stdio server bundled with the client.
    mcpServers: {
      company: {
        transport: 'stdio',
        command: 'node',
        args: ['<CLIENT_DIR>/skills/mcp/company-mcp.js'],
        description: 'Company tools & coding standards (edit server -> all employees update).',
      },
    },
  };
}
function serveSkillFile(res, rel) {
  const root = path.normalize(config.skillsDir);
  const abs = path.normalize(path.join(root, rel));
  // Contain within skillsDir; the trailing sep stops sibling-prefix escapes
  // (e.g. "<root>-evil/…" starts with "<root>" but is a different directory).
  if (abs !== root && !abs.startsWith(root + path.sep)) return send(res, 400, { error: 'bad path' });
  if (!fs.existsSync(abs)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
  res.end(fs.readFileSync(abs));
}

// --- router -----------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    // Health
    if (p === '/healthz') return send(res, 200, { ok: true });

    // 1) Client login: SSO already verified upstream -> issue a scoped key.
    //    Body: { email, provider }. In prod, verify an OIDC id_token here and
    //    take the email from its verified claims instead of trusting the body.
    if (p === '/auth/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const email = body.email;
      if (!email) return send(res, 400, { error: 'email required' });
      const { key, expiresAt } = issueKeyForEmployee(store, email, config, { label: body.provider || 'sso' });
      const emp = store.getEmployee(email);
      return send(res, 200, {
        api_key: key,
        base_url: `${config.publicUrl}/v1`,
        model: config.defaultModel,
        wire_api: 'responses',
        env_key: 'MYCOMPANY_CODEX_KEY',
        expires_at: expiresAt,
        employee: { email: email.toLowerCase(), name: emp.name, role: emp.role },
      });
    }

    // 2) Codex-facing proxy. Codex hits /v1/responses (wire_api=responses).
    if (p.startsWith('/v1/') && req.method === 'POST') {
      const identity = resolveKey(store, bearer(req));
      const bodyBuffer = await readBody(req);
      return proxyRequest({
        pathSuffix: p.slice('/v1'.length), // e.g. /responses
        method: req.method,
        headers: req.headers,
        bodyBuffer,
        identity,
        store,
        res,
      });
    }

    // 3) Skill distribution (pulled by the client on launch).
    if (p === '/skills/manifest' && req.method === 'GET') {
      resolveKey(store, bearer(req)); // employees only
      return send(res, 200, buildSkillManifest());
    }
    if (p === '/skills/file' && req.method === 'GET') {
      resolveKey(store, bearer(req));
      return serveSkillFile(res, url.searchParams.get('path') || '');
    }

    // 4) Admin: usage, leaderboard, manual revoke.
    if (p === '/admin/usage' && req.method === 'GET') {
      requireAdmin(req);
      return send(res, 200, { employees: store.listEmployees(), usage: store.usageByEmployee() });
    }
    if (p === '/admin/leaderboard' && req.method === 'GET') {
      requireAdmin(req);
      const rows = store.usageByEmployee().sort((a, b) => b.totalTokens - a.totalTokens);
      return send(res, 200, { leaderboard: rows });
    }
    if (p === '/admin/revoke' && req.method === 'POST') {
      requireAdmin(req);
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const r = offboardEmployee(store, body.email);
      return send(res, 200, { email: body.email, ...r });
    }

    // 5) Feishu/Lark offboarding webhook: 离职 status -> instant cutoff.
    if (p === '/webhooks/feishu/offboarding' && req.method === 'POST') {
      const raw = await readBody(req);
      if (!verifyFeishu(req, raw)) return send(res, 401, { error: 'bad signature' });
      const body = JSON.parse(raw.toString('utf8') || '{}');
      // Feishu employee-status events carry the person's email/status.
      const email = body.email || body.employee?.email;
      const status = body.status || body.employee?.status;
      if (status && !['离职', 'resigned', 'terminated', 'offboarded'].includes(status)) {
        return send(res, 200, { ignored: true, status });
      }
      const r = offboardEmployee(store, email);
      return send(res, 200, { email, offboarded: true, ...r });
    }

    // 6) Admin dashboard.
    if ((p === '/' || p === '/admin' || p === '/dashboard') && req.method === 'GET') {
      const f = path.join(config.adminDir, 'dashboard.html');
      if (fs.existsSync(f)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(f));
      }
    }

    return send(res, 404, { error: 'not found', path: p });
  } catch (err) {
    return send(res, err.status || 500, { error: { message: err.message } });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[gateway] listening on http://${config.host}:${config.port}`);
  console.log(`[gateway] upstream -> ${config.upstreamBaseUrl}`);
  console.log(`[gateway] employees seeded: ${store.listEmployees().length}`);
});
