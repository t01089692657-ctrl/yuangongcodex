// Enterprise Codex gateway (Plane A): identity -> key issuance -> metered
// proxy to your own upstream -> usage/leaderboard -> instant offboarding ->
// skill distribution. Zero external dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, assertSecureConfig } from './config.js';
import { Store } from './store.js';
import { issueKeyForEmployee, resolveKey, offboardEmployee, httpError, safeEqual, verifySsoAssertion, signSsoAssertion, signSession, verifySession } from './auth.js';
import { proxyRequest } from './proxy.js';
import { feishuConfigured, signState, verifyState, buildAuthorizeUrl, exchangeCode, fetchUserInfo, createPending, resolvePending, claimPending } from './feishu.js';

const store = new Store(config.dataDir, config.seedFile);

// A stray async error must never take the whole gateway down.
process.on('unhandledRejection', (e) => console.error('[gateway] unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('[gateway] uncaughtException:', e?.message || e));

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
function cookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    // A malformed percent-sequence must not 500 — treat it as an invalid token
    // so the caller falls through to a clean 401.
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null;
}

// Authorize a MANAGER for /admin/*. Accepts either the static automation token
// or a valid manager session (cookie/bearer). A regular employee's session is
// rejected with 403 — this is what separates managers from ordinary staff.
function requireManager(req) {
  const b = bearer(req);
  if (b && safeEqual(b, config.adminToken)) return { email: 'automation', name: 'automation', role: 'automation', via: 'token' };
  const token = cookie(req, 'mgr_session') || (b && b.includes('.') ? b : null);
  if (!token) throw httpError(401, 'manager login required');
  const claims = verifySession(token, config.adminSessionSecret); // throws 401 on bad/expired
  const emp = store.getEmployee(claims.email);
  if (!emp || emp.status !== 'active') throw httpError(401, 'session revoked');
  if (!emp.isAdmin) throw httpError(403, 'manager role required'); // live re-check
  return { email: claims.email, name: emp.name, role: emp.role || 'manager', via: 'session' };
}

// Build the employee provisioning payload (issues a fresh scoped key). Shared
// by the HMAC-assertion /auth/login and the real Feishu OAuth callback.
function provisionEmployee(email) {
  const { key, expiresAt } = issueKeyForEmployee(store, email, config, { label: 'sso' });
  const emp = store.getEmployee(email);
  return {
    api_key: key,
    base_url: `${config.publicUrl}/v1`,
    model: config.defaultModel,
    wire_api: 'responses',
    env_key: 'MYCOMPANY_CODEX_KEY',
    expires_at: expiresAt,
    employee: { email: email.toLowerCase(), name: emp.name, role: emp.role },
  };
}

// Set the manager session cookie (used by the Feishu callback's redirect flow).
function setManagerCookie(res, email, sameSite = 'Strict') {
  const emp = store.getEmployee(email);
  const profile = { email: String(email).toLowerCase(), name: emp.name, role: emp.role || 'manager' };
  const token = signSession(profile, config.adminSessionSecret, config.adminSessionTtlSeconds);
  const flags = ['HttpOnly', 'Path=/', `SameSite=${sameSite}`, `Max-Age=${config.adminSessionTtlSeconds}`];
  if (config.cookieSecure) flags.push('Secure');
  res.setHeader('Set-Cookie', `mgr_session=${encodeURIComponent(token)}; ${flags.join('; ')}`);
  return profile;
}

function htmlPage(res, status, title, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset=utf-8><title>${title}</title>` +
    `<div style="font:16px system-ui;max-width:520px;margin:16vh auto;text-align:center;color:#222">` +
    `<h2>${title}</h2><p style="color:#666">${body}</p></div>`);
}

// Issue a manager session cookie for a verified manager identity.
function issueManagerSession(res, email) {
  const emp = store.getEmployee(email);
  if (!emp) throw httpError(404, 'unknown employee');
  if (emp.status !== 'active') throw httpError(403, 'employee is not active');
  if (!emp.isAdmin) throw httpError(403, 'not authorized: manager role required');
  const profile = { email: String(email).toLowerCase(), name: emp.name, role: emp.role || 'manager' };
  const token = signSession(profile, config.adminSessionSecret, config.adminSessionTtlSeconds);
  const flags = ['HttpOnly', 'Path=/', 'SameSite=Strict', `Max-Age=${config.adminSessionTtlSeconds}`];
  if (config.cookieSecure) flags.push('Secure');
  res.setHeader('Set-Cookie', `mgr_session=${encodeURIComponent(token)}; ${flags.join('; ')}`);
  return send(res, 200, { manager: profile, session: token });
}

// Verify Feishu/Lark webhook: HMAC-SHA256(secret, "<timestamp>.<rawBody>") in
// x-signature, with x-timestamp bound and freshness-checked to stop replay.
function verifyFeishu(req, rawBody) {
  const sig = req.headers['x-signature'] || '';
  const ts = req.headers['x-timestamp'] || '';
  if (!ts || !/^\d+$/.test(ts)) return false;
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (skew > config.webhookMaxSkewSeconds) return false; // stale/replayed
  const expected = crypto.createHmac('sha256', config.feishuWebhookSecret).update(`${ts}.${rawBody}`).digest('hex');
  return safeEqual(sig, expected);
}

// Pull an employee email out of the (varied) Feishu event shapes, falling back
// to a bounded recursive search for the first email-looking string.
function extractEmail(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /email/i.test(k) && /@/.test(v)) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') { const f = extractEmail(v, depth + 1); if (f) return f; }
  }
  return null;
}
function extractStatus(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /status|state/i.test(k)) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') { const f = extractStatus(v, depth + 1); if (f) return f; }
  }
  return null;
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

    // 1) Client login: the client presents a signed SSO assertion (in prod, an
    //    OIDC id_token). We derive the identity from the VERIFIED assertion, not
    //    from an untrusted body field, so a bare email cannot mint a key.
    if (p === '/auth/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const { email } = verifySsoAssertion(body.assertion, config.ssoSharedSecret);
      return send(res, 200, provisionEmployee(email));
    }

    // 1b) Real Feishu / Lark OAuth. The desktop client opens /auth/feishu/start
    //     in the browser (PKCE link+poll); the manager console uses it directly.
    if (p === '/auth/feishu/start' && req.method === 'GET') {
      if (!feishuConfigured()) return send(res, 503, { error: 'Feishu SSO not configured (set FEISHU_APP_ID/FEISHU_APP_SECRET)' });
      const intent = url.searchParams.get('intent') === 'manager' ? 'manager' : 'employee';
      const stateObj = { intent, nonce: crypto.randomBytes(9).toString('base64url') };
      if (intent === 'employee') {
        const link = url.searchParams.get('link');
        const challenge = url.searchParams.get('challenge');
        if (!link || !challenge) return send(res, 400, { error: 'employee login requires link + challenge (PKCE)' });
        stateObj.link = link;
        stateObj.challenge = challenge; // HMAC-signed so it can't be rebound later
        createPending(link, challenge); // no-op if this link is already pending
      }
      // Demo only: forward the chosen account to mock-feishu so the flow is
      // non-interactive. Real Feishu shows its own login and ignores this.
      const extra = {};
      if (config.demoMode && url.searchParams.get('demo_email')) extra.email = url.searchParams.get('demo_email');
      res.writeHead(302, { Location: buildAuthorizeUrl(signState(stateObj), extra) });
      return res.end();
    }
    if (p === '/auth/feishu/callback' && req.method === 'GET') {
      if (!feishuConfigured()) return send(res, 503, { error: 'Feishu SSO not configured' });
      const st = verifyState(url.searchParams.get('state'));
      const code = url.searchParams.get('code');
      if (!code) return htmlPage(res, 400, 'Login failed', 'Missing authorization code.');
      const token = await exchangeCode(code);
      const { email } = await fetchUserInfo(token);
      const emp = store.getEmployee(email);

      if (st.intent === 'manager') {
        if (!emp || emp.status !== 'active' || !emp.isAdmin) return htmlPage(res, 403, 'Access denied', `${email} is not a manager.`);
        setManagerCookie(res, email, 'Lax'); // Lax: cookie must survive the OAuth top-level redirect
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      // employee intent -> stash the provisioning result for the desktop app to
      // poll. resolvePending binds to the HMAC-signed challenge from the state,
      // so a rogue callback for a known link can't rebind or clobber it.
      if (!emp || emp.status !== 'active') {
        resolvePending(st.link, { error: `${email} is not an active employee` }, st.challenge, 'error');
        return htmlPage(res, 403, 'Access denied', `${email} is not an active employee. Contact IT.`);
      }
      resolvePending(st.link, provisionEmployee(email), st.challenge, 'done');
      return htmlPage(res, 200, '登录成功 / Signed in', 'You can close this window and return to the Codex app.');
    }
    // Poll is POST so the PKCE verifier (the login secret) stays out of URLs/logs.
    if (p === '/auth/feishu/poll' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const link = body.link;
      const verifier = body.verifier;
      if (!link || !verifier) return send(res, 400, { error: 'link + verifier required' });
      const r = claimPending(link, verifier);
      if (r.status === 'pending') return send(res, 202, { status: 'pending' });
      if (r.status === 'unknown') return send(res, 404, { status: 'unknown' });
      if (r.status === 'error') return send(res, 400, { status: 'error', error: r.error || r.result?.error });
      return send(res, 200, { status: 'done', ...r.result });
    }

    // 2) Codex-facing proxy. Codex POSTs /v1/responses (wire_api=responses) and
    //    also GETs /v1/models etc. on startup, so forward the common methods.
    if (p.startsWith('/v1/') && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const identity = resolveKey(store, bearer(req));
      const bodyBuffer = await readBody(req);
      return await proxyRequest({
        pathSuffix: p.slice('/v1'.length), // e.g. /responses
        search: url.search,
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

    // 4) Manager backend login (Feishu SSO -> manager session cookie).
    //    Only employees with isAdmin=true (managers) may obtain a session.
    if (p === '/auth/admin-login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const { email } = verifySsoAssertion(body.assertion, config.ssoSharedSecret);
      return issueManagerSession(res, email);
    }
    // Demo convenience: stands in for the real Feishu OAuth callback. Disabled
    // when DEMO_MODE=false. Still enforces the manager-role check.
    if (p === '/auth/admin-login/mock' && req.method === 'POST') {
      if (!config.demoMode) return send(res, 404, { error: 'not found' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.email) return send(res, 400, { error: 'email required' });
      const assertion = signSsoAssertion(body.email, config.ssoSharedSecret, config.ssoAssertionTtlSeconds);
      const { email } = verifySsoAssertion(assertion, config.ssoSharedSecret);
      return issueManagerSession(res, email);
    }
    if (p === '/auth/admin/me' && req.method === 'GET') {
      return send(res, 200, { manager: requireManager(req) });
    }
    if (p === '/auth/admin-logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'mgr_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
      return send(res, 200, { ok: true });
    }

    // 4b) Manager-only data: usage, leaderboard, manual revoke.
    if (p === '/admin/usage' && req.method === 'GET') {
      requireManager(req);
      return send(res, 200, { employees: store.listEmployees(), usage: store.usageByEmployee() });
    }
    if (p === '/admin/leaderboard' && req.method === 'GET') {
      requireManager(req);
      const rows = store.usageByEmployee().sort((a, b) => b.totalTokens - a.totalTokens);
      return send(res, 200, { leaderboard: rows });
    }
    if (p === '/admin/revoke' && req.method === 'POST') {
      const who = requireManager(req); // audit who performed the offboarding
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const r = offboardEmployee(store, body.email);
      return send(res, 200, { email: body.email, by: who.email, ...r });
    }

    // 5) Feishu/Lark offboarding webhook: 离职 status -> instant cutoff.
    //    Fails CLOSED: only reports success when an employee was actually found
    //    and offboarded, so a shape mismatch is loud, not a silent no-op.
    if (p === '/webhooks/feishu/offboarding' && req.method === 'POST') {
      const raw = await readBody(req);
      if (!verifyFeishu(req, raw)) return send(res, 401, { error: 'bad or replayed signature' });
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const email = body.email || body.employee?.email || body.event?.object?.email || extractEmail(body);
      const status = body.status || body.employee?.status || body.event?.object?.status || extractStatus(body);
      const OFFBOARD = ['离职', '已离职', 'resigned', 'terminated', 'offboarded', 'inactive'];
      if (status && !OFFBOARD.includes(status)) return send(res, 200, { ignored: true, status });
      if (!email) return send(res, 422, { error: 'could not resolve employee email from payload' });
      const r = offboardEmployee(store, email);
      if (!r.found) return send(res, 404, { error: 'unknown employee', email, offboarded: false });
      return send(res, 200, { email, offboarded: true, revoked: r.revoked });
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
    // If a streaming response already sent headers, we can't write a JSON error.
    if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return; }
    return send(res, err.status || 500, { error: { message: err.message } });
  }
});

// Refuse to boot on default secrets outside demo mode (clean exit, not a crash).
try { assertSecureConfig(); } catch (e) { console.error(`[gateway] ${e.message}`); process.exit(1); }

server.listen(config.port, config.host, () => {
  console.log(`[gateway] listening on http://${config.host}:${config.port}`);
  console.log(`[gateway] upstream -> ${config.upstreamBaseUrl}`);
  console.log(`[gateway] employees seeded: ${store.listEmployees().length}`);
});
