// Mock Feishu/Lark OAuth IdP for offline testing. Stands in for the three real
// endpoints the gateway calls, so the entire Feishu code path runs with no real
// credentials. Point the gateway at it with:
//   FEISHU_AUTHORIZE_URL=http://127.0.0.1:8092/authorize
//   FEISHU_TOKEN_URL=http://127.0.0.1:8092/oauth/token
//   FEISHU_USERINFO_URL=http://127.0.0.1:8092/user_info
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.MOCK_FEISHU_PORT || 8092);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedPath = process.env.SEED_FILE || path.join(__dirname, '..', 'gateway', 'data', 'employees.seed.json');
const employees = (() => {
  try { return JSON.parse(fs.readFileSync(seedPath, 'utf8')).employees || []; } catch { return []; }
})();
const known = new Map(employees.map((e) => [e.email.toLowerCase(), e]));

const codeToEmail = new Map(); // auth code -> email
const tokenToEmail = new Map(); // user access token -> email

function readBody(req) {
  return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // 1) Authorize: real Feishu shows a login page; here we accept ?email= for
  //    automation, else render a clickable account picker of seeded employees.
  if (p === '/authorize' && req.method === 'GET') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const email = (url.searchParams.get('email') || '').toLowerCase();
    if (!redirectUri) { res.writeHead(400); return res.end('missing redirect_uri'); }
    if (email) {
      const code = crypto.randomBytes(12).toString('hex');
      codeToEmail.set(code, email);
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      if (state) back.searchParams.set('state', state);
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    // account picker
    const links = employees.map((e) => {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      u.searchParams.set('email', e.email);
      return `<a style="display:block;padding:10px;margin:6px;border:1px solid #ccc;border-radius:8px;text-decoration:none;color:#222" href="${u.pathname}${u.search}">${e.name} &lt;${e.email}&gt; ${e.isAdmin ? '· manager' : ''}</a>`;
    }).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset=utf-8><title>Mock Feishu 登录</title><div style="font:15px system-ui;max-width:420px;margin:10vh auto"><h3>Mock Feishu — pick an account</h3>${links}</div>`);
  }

  // 2) Token exchange (Feishu OAuth v2 shape).
  if (p === '/oauth/token' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* ignore */ }
    const email = codeToEmail.get(body.code);
    if (!email) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: 20007, msg: 'invalid or expired code' })); }
    codeToEmail.delete(body.code);
    const token = 'mock-uat-' + crypto.randomBytes(12).toString('hex');
    tokenToEmail.set(token, email);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ code: 0, access_token: token, token_type: 'Bearer', expires_in: 7200, refresh_token: 'mock-rt', scope: 'contact:user.email:readonly' }));
  }

  // 3) User info (Feishu shape: { code:0, data:{...} }).
  if (p === '/user_info' && req.method === 'GET') {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const email = tokenToEmail.get(token);
    if (!email) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: 99991663, msg: 'invalid access token' })); }
    const e = known.get(email) || {};
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ code: 0, msg: 'success', data: { name: e.name || email, en_name: e.name || email, email, enterprise_email: email, open_id: 'ou_' + crypto.createHash('md5').update(email).digest('hex').slice(0, 16) } }));
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', path: p }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-feishu] listening on http://127.0.0.1:${PORT}`));
