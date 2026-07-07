// Pulls company skills from the gateway into the managed CODEX_HOME:
//   - AGENTS.md            -> global agent instructions (behavioral "skills")
//   - prompts/*.md         -> Codex slash-command prompts
//   - mcp_servers manifest -> merged into config.toml by the launcher
// Run on every client launch so updates propagate (pull-type). For push-type,
// point the MCP server at a remote URL and edit it once server-side.
import fs from 'node:fs';
import path from 'node:path';

async function getJson(url, token) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`skills fetch ${r.status}: ${await r.text()}`);
  return r.json();
}
async function getText(url, token) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`skills file ${r.status}`);
  return r.text();
}

export async function syncSkills({ gatewayUrl, apiKey, codexHome, clientDir }) {
  const manifest = await getJson(`${gatewayUrl}/skills/manifest`, apiKey);
  const written = [];
  for (const f of manifest.files) {
    const text = await getText(`${gatewayUrl}/skills/file?path=${encodeURIComponent(f.path)}`, apiKey);
    const dest = path.join(codexHome, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    written.push(f.path);
  }

  // Resolve the bundled MCP server path (<CLIENT_DIR> placeholder from server).
  const mcpServers = {};
  for (const [name, spec] of Object.entries(manifest.mcpServers || {})) {
    if (spec.transport === 'stdio') {
      mcpServers[name] = {
        command: spec.command,
        args: spec.args.map((a) => a.replace('<CLIENT_DIR>', clientDir)),
      };
    } else if (spec.url) {
      mcpServers[name] = { url: spec.url };
    }
  }

  return { version: manifest.version, written, mcpServers };
}
