// Enterprise Codex client (Plane B) CLI — the employee-side flow from the video.
// One command: SSO login -> gateway issues a scoped key -> write managed Codex
// config -> sync company skills -> launch the bundled Codex.
//
//   node client/launcher.js --provider feishu  --gateway https://gw.corp.com
//   node client/launcher.js --provider mock --email you@corp.com   # offline
//
// The Electron desktop app (../desktop) reuses the same core (./core.js).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { feishuLogin, mockLogin, setupCodex, launchCodex, proveWiring } from './core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, '..'); // enterprise-codex/

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);
const log = (m) => console.log(m);

// Open a URL in the user's default browser (per-OS), or drive the redirect
// chain via fetch when --headless-open is set (tests / offline demo).
function makeOpener() {
  if (flag('headless-open')) return async (url) => { await fetch(url).catch(() => {}); };
  return async (url) => {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  };
}

async function main() {
  const gatewayUrl = arg('gateway', process.env.GATEWAY_URL || 'http://127.0.0.1:8080');
  const provider = arg('provider', 'feishu');
  const codexHome = arg('codex-home', process.env.CODEX_HOME || path.join(os.homedir(), '.codex-managed'));
  const codexBin = arg('codex-bin', process.env.CODEX_BIN);

  log(`\n== Enterprise Codex client ==`);
  log(`gateway=${gatewayUrl} provider=${provider} CODEX_HOME=${codexHome}`);

  // 1) Authenticate
  let prov;
  if (provider === 'feishu') {
    prov = await feishuLogin({ gatewayUrl, openBrowser: makeOpener(), onStatus: (s) => log(`[1/4] ${s}`), demoEmail: arg('demo-email', undefined) });
  } else if (provider === 'mock') {
    prov = await mockLogin({ gatewayUrl, email: arg('email', process.env.EMPLOYEE_EMAIL) });
  } else {
    throw new Error(`unknown provider: ${provider} (use feishu or mock)`);
  }
  log(`[1/4] signed in as ${prov.employee?.email} (${prov.employee?.name || ''})`);

  // 2) provisioned key
  log(`[2/4] key ${prov.api_key.slice(0, 16)}… base_url=${prov.base_url} model=${prov.model}`);

  // 3) skills + config
  const { skills, paths } = await setupCodex({ prov, gatewayUrl, codexHome, clientDir, onStatus: (s) => log(`[3/4] ${s}`) });
  log(`[3/4] skills v${skills.version}: ${skills.written.join(', ')} + MCP [${Object.keys(skills.mcpServers).join(',')}]`);
  log(`      wrote ${paths.configPath} and ${paths.authPath}`);

  // 4) launch Codex, or prove the wiring when there is no bundled binary
  if (codexBin && fs.existsSync(codexBin) && !flag('simulate')) {
    log(`[4/4] launching bundled Codex: ${codexBin}`);
    const sep = process.argv.indexOf('--');
    const passthrough = sep >= 0 ? process.argv.slice(sep + 1) : [];
    const child = launchCodex({ codexBin, codexHome, envKey: paths.envKey, apiKey: prov.api_key, extraArgs: passthrough });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  log(`[4/4] no bundled binary (or --simulate): making a proof request through the gateway…`);
  const proof = await proveWiring({ prov, envKey: paths.envKey });
  log(`      gateway responded ${proof.status}: ${proof.text.slice(0, 160)}${proof.text.length > 160 ? '…' : ''}`);
  if (!proof.ok) process.exit(1);
  log(`\nCodex is wired to the company gateway. Access is controlled by the issued key.`);
}

main().catch((e) => { console.error('client error:', e.message); process.exit(1); });
