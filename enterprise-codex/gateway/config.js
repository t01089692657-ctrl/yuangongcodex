// Gateway configuration, all env-driven with demo-safe defaults.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  // Admin API bearer token (used by dashboard + admin CLI).
  adminToken: env('ADMIN_TOKEN', 'admin-dev-token'),

  // Shared secret to verify the Feishu/Lark offboarding webhook.
  feishuWebhookSecret: env('FEISHU_WEBHOOK_SECRET', 'feishu-dev-secret'),

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
