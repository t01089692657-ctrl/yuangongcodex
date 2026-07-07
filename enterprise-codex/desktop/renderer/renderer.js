// Renderer: talks to the main process only through the preload `api` bridge.
const $ = (id) => document.getElementById(id);
const logEl = $('log');
function log(m) { logEl.textContent += (logEl.textContent ? '\n' : '') + m; logEl.scrollTop = logEl.scrollHeight; }
window.api.onLog(log);

function show(view) {
  $('signin').classList.toggle('hidden', view !== 'signin');
  $('app').classList.toggle('hidden', view !== 'app');
}

async function init() {
  const cfg = await window.api.getConfig();
  $('gatewayUrl').value = cfg.gatewayUrl || '';
  $('codexBin').value = cfg.codexBin || '';
}
$('settingsToggle').onclick = () => $('settings').classList.toggle('hidden');
$('saveSettings').onclick = async () => {
  const cfg = await window.api.getConfig();
  await window.api.saveConfig({ ...cfg, gatewayUrl: $('gatewayUrl').value.trim(), codexBin: $('codexBin').value.trim() });
  log('settings saved');
  $('settings').classList.add('hidden');
};

$('loginBtn').onclick = async () => {
  $('loginBtn').disabled = true;
  try {
    const r = await window.api.login();
    $('empName').textContent = r.employee.name || r.employee.email;
    $('empEmail').textContent = r.employee.email;
    $('avatar').textContent = (r.employee.name || r.employee.email).trim()[0].toUpperCase();
    $('empSkills').textContent = `model ${r.model} · skills: ${r.skills.join(', ')} · MCP: ${r.mcp.join(', ') || 'none'}`;
    show('app');
  } catch (e) {
    log('login failed: ' + e.message);
  } finally {
    $('loginBtn').disabled = false;
  }
};

$('launchBtn').onclick = async () => {
  $('launchBtn').disabled = true;
  try {
    const r = await window.api.launch();
    log(r.launched ? 'Codex launched in a terminal.' : `wiring verified (gateway ${r.proof.status}). Set a Codex binary in Settings to launch.`);
  } catch (e) {
    log('launch failed: ' + e.message);
  } finally {
    $('launchBtn').disabled = false;
  }
};

$('logoutBtn').onclick = () => { show('signin'); logEl.textContent = ''; };

init();
