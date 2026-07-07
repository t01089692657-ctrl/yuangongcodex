// Shared client logic used by BOTH the CLI launcher and the Electron desktop
// app: authenticate (real Feishu OAuth or offline mock), provision a scoped key,
// write the managed Codex config, sync skills, and launch/verify Codex.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeCodexConfig } from './codex-config.js';
import { syncSkills } from './skills-sync.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');

// --- Auth: real Feishu OAuth via the gateway (PKCE link+poll) ---------
// openBrowser(url) navigates the user's browser to `url`. In the desktop app
// that's shell.openExternal; in tests it's a fetch that follows the redirects.
export async function feishuLogin({ gatewayUrl, openBrowser, onStatus = () => {}, demoEmail, pollTimeoutMs = 180000 }) {
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const link = b64u(crypto.randomBytes(24));

  const start = new URL(`${gatewayUrl}/auth/feishu/start`);
  start.searchParams.set('intent', 'employee');
  start.searchParams.set('link', link);
  start.searchParams.set('challenge', challenge);
  if (demoEmail) start.searchParams.set('demo_email', demoEmail);

  onStatus('opening browser for Feishu sign-in…');
  await openBrowser(start.toString());

  const pollUrl = `${gatewayUrl}/auth/feishu/poll?link=${encodeURIComponent(link)}&verifier=${encodeURIComponent(verifier)}`;
  const deadline = Date.now() + pollTimeoutMs;
  onStatus('waiting for you to finish sign-in…');
  while (Date.now() < deadline) {
    let r;
    try { r = await fetch(pollUrl); } catch { await sleep(1500); continue; }
    if (r.status === 202 || r.status === 404) { await sleep(1500); continue; }
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.status === 'done') return j;              // provisioning result
    if (j.status === 'error') throw new Error(j.error || 'sign-in was rejected');
    throw new Error(`sign-in failed (${r.status}): ${j.error || ''}`);
  }
  throw new Error('Feishu sign-in timed out');
}

// --- Auth: offline mock (HMAC assertion), for demos without Feishu -----
export async function mockLogin({ gatewayUrl, email, ssoSecret = process.env.SSO_SHARED_SECRET || 'sso-dev-secret' }) {
  if (!email) throw new Error('mock login needs an email');
  const payload = b64u(JSON.stringify({ email: email.toLowerCase(), exp: Math.floor(Date.now() / 1000) + 120 }));
  const sig = crypto.createHmac('sha256', ssoSecret).update(payload).digest('hex');
  const r = await fetch(`${gatewayUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion: `${payload}.${sig}`, provider: 'mock' }),
  });
  if (!r.ok) throw new Error(`login failed ${r.status}: ${await r.text()}`);
  return r.json();
}

// --- Provision Codex: write config + sync skills ----------------------
export async function setupCodex({ prov, gatewayUrl, codexHome, clientDir, onStatus = () => {} }) {
  onStatus('syncing company skills…');
  const skills = await syncSkills({ gatewayUrl, apiKey: prov.api_key, codexHome, clientDir });
  const paths = writeCodexConfig({
    codexHome,
    baseUrl: prov.base_url,
    apiKey: prov.api_key,
    model: prov.model,
    envKey: prov.env_key || 'MYCOMPANY_CODEX_KEY',
    mcpServers: skills.mcpServers,
  });
  return { skills, paths };
}

// --- Launch Codex (or verify wiring when no binary is present) ---------
export function launchCodex({ codexBin, codexHome, envKey, apiKey, extraArgs = [], stdio = 'inherit' }) {
  if (!codexBin || !fs.existsSync(codexBin)) throw new Error('bundled Codex binary not found (set CODEX_BIN)');
  const env = { ...process.env, CODEX_HOME: codexHome, [envKey]: apiKey };
  return spawn(codexBin, extraArgs, { env, stdio });
}

export async function proveWiring({ prov, envKey }) {
  const r = await fetch(`${prov.base_url}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${prov.api_key}` },
    body: JSON.stringify({ model: prov.model, input: 'Say hello from the managed Codex client.' }),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}
