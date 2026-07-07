// Gateway configuration, all env-driven with demo-safe defaults.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load a project-root .env (KEY=VALUE) if present, without overriding anything
// already set in the real environment. Zero-dep so `node gateway/server.js`
// just works after `scripts/setup.sh` writes .env.
function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1); // quoted: keep verbatim (may contain '#')
    } else {
      const h = v.search(/\s#/); // unquoted: strip a trailing " # comment"
      if (h >= 0) v = v.slice(0, h).trim();
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvFile();

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  host: env('GATEWAY_HOST', '127.0.0.1'),
  port: Number(env('GATEWAY_PORT', '8080')),

  // The base_url the client writes into the employee's Codex config.
  // In production this is your public HTTPS gateway URL.
  publicUrl: env('GATEWAY_PUBLIC_URL', 'http://127.0.0.1:8080'),

  // Upstream model provider. COMPLIANT default = your company's own
  // OpenAI Platform / Azure OpenAI endpoint + key. In the demo we point
  // at the bundled mock-upstream so nothing real is called or billed.
  upstreamBaseUrl: env('UPSTREAM_BASE_URL', 'http://127.0.0.1:8091/v1'),
  upstreamApiKey: env('UPSTREAM_API_KEY', 'mock-upstream-key'),

  // Static admin bearer token for automation/CI (not for humans).
  adminToken: env('ADMIN_TOKEN', 'admin-dev-token'),

  // Manager backend: humans log in via Feishu SSO and get a signed session.
  // Only employees with isAdmin=true (managers) may hold a manager session.
  adminSessionSecret: env('ADMIN_SESSION_SECRET', 'admin-session-dev-secret'),
  adminSessionTtlSeconds: Number(env('ADMIN_SESSION_TTL_SECONDS', '3600')),
  // DEMO_MODE enables /auth/admin-login/mock (stands in for the Feishu OAuth
  // callback). Fail-closed: OFF unless explicitly DEMO_MODE=true, so a real
  // deploy never ships the anonymous mock-login backdoor by accident.
  demoMode: env('DEMO_MODE', 'false') === 'true',
  // Send the Secure cookie flag. Secure-by-default; opt out only for local
  // http dev (the demo sets COOKIE_SECURE=false for http://127.0.0.1).
  cookieSecure: env('COOKIE_SECURE', 'true') !== 'false',

  // Shared secret to verify the Feishu/Lark offboarding webhook.
  feishuWebhookSecret: env('FEISHU_WEBHOOK_SECRET', 'feishu-dev-secret'),
  webhookMaxSkewSeconds: Number(env('WEBHOOK_MAX_SKEW_SECONDS', '300')),

  // Shared secret used to sign/verify the SSO assertion presented at login.
  // In production this is replaced by verifying a real OIDC id_token via the
  // IdP's JWKS (no shared secret); the demo HMAC-signs a short-lived assertion
  // that the trusted first-party SSO frontend produces after real auth.
  ssoSharedSecret: env('SSO_SHARED_SECRET', 'sso-dev-secret'),
  ssoAssertionTtlSeconds: Number(env('SSO_ASSERTION_TTL_SECONDS', '120')),

  // Issued key format + optional expiry (0 = non-expiring opaque key,
  // revoked instantly by flipping active=false in the store).
  keyPrefix: env('KEY_PREFIX', 'sk-comp-'),
  keyTtlSeconds: Number(env('KEY_TTL_SECONDS', '0')),

  // Default model the client pins in Codex config.toml.
  defaultModel: env('CODEX_MODEL', 'gpt-5-codex'),

  dataDir: env('DATA_DIR', path.join(__dirname, 'data')),
  seedFile: env('SEED_FILE', path.join(__dirname, 'data', 'employees.seed.json')),
  skillsDir: env('SKILLS_DIR', path.join(__dirname, '..', 'skills')),
  adminDir: env('ADMIN_DIR', path.join(__dirname, '..', 'admin')),
};

// Built-in dev defaults that MUST be overridden in production.
const DEV_DEFAULTS = {
  adminToken: 'admin-dev-token',
  adminSessionSecret: 'admin-session-dev-secret',
  ssoSharedSecret: 'sso-dev-secret',
  feishuWebhookSecret: 'feishu-dev-secret',
};

// Refuse to boot a production gateway with source-visible default secrets (a
// default secret lets anyone forge a manager session / SSO assertion). In demo
// mode we only warn, loudly.
export function assertSecureConfig() {
  // Flag a secret as weak if it's a built-in default, a known placeholder
  // (e.g. from a hand-edited .env.example), or too short to be real.
  const weak = Object.keys(DEV_DEFAULTS).filter((k) => {
    const v = String(config[k] || '');
    return v === DEV_DEFAULTS[k] || /change-?me|replace|example|dev-secret|dev-token/i.test(v) || v.length < 16;
  });
  if (config.demoMode) {
    console.warn('[gateway] DEMO_MODE=true — anonymous /auth/admin-login/mock is ENABLED. Never use in production.');
    if (weak.length) console.warn(`[gateway] weak/placeholder secrets: ${weak.join(', ')}`);
    return;
  }
  if (weak.length) {
    throw new Error(
      `Refusing to start: weak or placeholder secrets: ${weak.join(', ')}. ` +
      `Run scripts/setup.sh to generate strong values (or set them via 'openssl rand -hex 32'), ` +
      `or run with DEMO_MODE=true for local demos.`,
    );
  }
}
