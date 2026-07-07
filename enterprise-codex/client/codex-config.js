// Writes the employee's Codex configuration into a managed CODEX_HOME.
// This is the "auto-inject config" step from the video: config.toml carries
// the gateway base_url + provider; the issued key is supplied via the env var
// named by env_key (and mirrored into auth.json for parity/fallback).
import fs from 'node:fs';
import path from 'node:path';

function toml(obj) {
  // Tiny TOML emitter for the small, flat structures we write.
  const lines = [];
  const scalar = (v) =>
    typeof v === 'string' ? JSON.stringify(v)
    : Array.isArray(v) ? '[' + v.map(scalar).join(', ') + ']'
    : String(v);
  const topKeys = Object.keys(obj).filter((k) => typeof obj[k] !== 'object' || Array.isArray(obj[k]));
  for (const k of topKeys) lines.push(`${k} = ${scalar(obj[k])}`);
  for (const [section, val] of Object.entries(obj)) {
    if (typeof val !== 'object' || Array.isArray(val)) continue;
    for (const [name, tbl] of Object.entries(val)) {
      lines.push('', `[${section}.${name}]`);
      for (const [kk, vv] of Object.entries(tbl)) lines.push(`${kk} = ${scalar(vv)}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function writeCodexConfig({ codexHome, baseUrl, apiKey, model, envKey = 'MYCOMPANY_CODEX_KEY', mcpServers = {} }) {
  fs.mkdirSync(codexHome, { recursive: true });

  const cfg = {
    model,
    model_provider: 'mycompany',
    model_providers: {
      mycompany: {
        name: 'MyCompany Gateway',
        base_url: baseUrl,          // https://gateway.mycompany.com/v1
        wire_api: 'responses',      // Codex speaks the Responses API
        env_key: envKey,            // key comes from this env var at launch
      },
    },
    mcp_servers: mcpServers,        // push-type company skills/tools
  };

  const configPath = path.join(codexHome, 'config.toml');
  fs.writeFileSync(configPath, toml(cfg));

  // Parity with the video ("auth.json holds your key"). The custom provider
  // reads env_key from the environment; auth.json is the default-provider path.
  const authPath = path.join(codexHome, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2));
  fs.chmodSync(authPath, 0o600);

  return { configPath, authPath, envKey };
}
