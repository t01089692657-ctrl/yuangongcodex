// Enterprise Codex client (Plane B) — the desktop-app logic from the video,
// as a runnable launcher. One command reproduces every employee-side effect:
//
//   SSO login -> gateway issues a scoped key -> write managed Codex config
//   -> sync company skills (AGENTS.md + prompts + MCP) -> launch bundled Codex
//
// Codex is assumed already bundled in the client; we set CODEX_HOME + the key
// env var and spawn it. With --simulate (or no bundled binary) we instead make
// one real request through the gateway to prove the wiring end-to-end.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeCodexConfig } from './codex-config.js';
import { syncSkills } from './skills-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, '..'); // enterprise-codex/

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

// --- SSO -------------------------------------------------------------
// In production, drive the IdP's OIDC/authorization-code flow (Feishu/Lark,
// WeCom, Okta...), then hand the gateway the resulting id_token as the
// `assertion`. Here 'mock' HMAC-signs a short-lived assertion the same way a
// trusted first-party SSO frontend would after real auth, so the whole pipeline
// is testable offline AND the gateway still verifies a signature (no bare-email
// impersonation). The signing secret would NOT live in a real client — this
// stands in for the SSO frontend that mints the token server-side.
function mockSsoAssertion(email) {
  const secret = process.env.SSO_SHARED_SECRET || 'sso-dev-secret';
  const payload = Buffer.from(JSON.stringify({ email: email.toLowerCase(), exp: Math.floor(Date.now() / 1000) + 120 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
async function ssoAuthenticate(provider) {
  if (provider === 'mock') {
    const email = arg('email', process.env.EMPLOYEE_EMAIL);
    if (!email) throw new Error('mock SSO needs --email <addr> (stands in for the verified OIDC claim)');
    return { email, assertion: mockSsoAssertion(email) };
  }
  if (provider === 'feishu') {
    // TODO: open browser to Feishu authorize URL, exchange code, obtain the
    // id_token, and pass it as `assertion` (gateway verifies it via JWKS).
    throw new Error('feishu SSO not wired in this demo — use --provider mock, or implement the OIDC exchange here');
  }
  throw new Error(`unknown SSO provider: ${provider}`);
}

async function main() {
  const gatewayUrl = arg('gateway', process.env.GATEWAY_URL || 'http://127.0.0.1:8080');
  const provider = arg('provider', 'mock');
  const codexHome = arg('codex-home', process.env.CODEX_HOME || path.join(os.homedir(), '.codex-managed'));
  const codexBin = arg('codex-bin', process.env.CODEX_BIN); // bundled binary in the real client

  console.log(`\n== Enterprise Codex client ==`);
  console.log(`gateway=${gatewayUrl} provider=${provider} CODEX_HOME=${codexHome}`);

  // 1) SSO
  const { email, assertion } = await ssoAuthenticate(provider);
  console.log(`[1/4] SSO ok: ${email}`);

  // 2) Provision a scoped key from the gateway (present the signed assertion,
  //    NOT a bare email — the gateway derives identity from the verified token)
  const loginRes = await fetch(`${gatewayUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion, provider }),
  });
  if (!loginRes.ok) throw new Error(`login failed ${loginRes.status}: ${await loginRes.text()}`);
  const prov = await loginRes.json();
  console.log(`[2/4] provisioned key ${prov.api_key.slice(0, 16)}… base_url=${prov.base_url} model=${prov.model}`);

  // 3) Sync company skills, then write Codex config (incl. MCP servers)
  const skills = await syncSkills({ gatewayUrl, apiKey: prov.api_key, codexHome, clientDir });
  const paths = writeCodexConfig({
    codexHome,
    baseUrl: prov.base_url,
    apiKey: prov.api_key,
    model: prov.model,
    envKey: prov.env_key || 'MYCOMPANY_CODEX_KEY',
    mcpServers: skills.mcpServers,
  });
  console.log(`[3/4] skills v${skills.version}: ${skills.written.join(', ')} + MCP [${Object.keys(skills.mcpServers).join(',')}]`);
  console.log(`      wrote ${paths.configPath} and ${paths.authPath}`);

  // 4) Launch Codex (bundled). Inject the key via env_key + CODEX_HOME.
  const childEnv = { ...process.env, CODEX_HOME: codexHome, [paths.envKey]: prov.api_key };

  if (codexBin && fs.existsSync(codexBin) && !flag('simulate')) {
    console.log(`[4/4] launching bundled Codex: ${codexBin}`);
    // Forward only args placed after an explicit `--`; none if absent.
    const sep = process.argv.indexOf('--');
    const passthrough = sep >= 0 ? process.argv.slice(sep + 1) : [];
    const child = spawn(codexBin, passthrough, { env: childEnv, stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  // --simulate: prove the wiring by doing what Codex would do on its first turn.
  console.log(`[4/4] no bundled binary (or --simulate): making a proof request through the gateway…`);
  const r = await fetch(`${prov.base_url}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${childEnv[paths.envKey]}` },
    body: JSON.stringify({ model: prov.model, input: 'Say hello from the managed Codex client.' }),
  });
  const text = await r.text();
  console.log(`      gateway responded ${r.status}: ${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`);
  if (!r.ok) process.exit(1);
  console.log(`\nCodex is wired to the company gateway. Access is controlled by the issued key.`);
}

main().catch((e) => {
  console.error('client error:', e.message);
  process.exit(1);
});
