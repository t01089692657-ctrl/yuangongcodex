// Renderer: talks to main only through the preload `api` bridge. After Feishu
// sign-in it mounts an xterm terminal wired to the Codex pty in the main process.
const $ = (id) => document.getElementById(id);
function loginLog(m) { const el = $('loginLog'); el.textContent += (el.textContent ? '\n' : '') + m; el.scrollTop = el.scrollHeight; }
function fbLog(m) { const el = $('fallbackLog'); el.textContent += (el.textContent ? '\n' : '') + m; el.scrollTop = el.scrollHeight; }
window.api.onLog(loginLog);

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
  loginLog('settings saved');
  $('settings').classList.add('hidden');
};

let term = null, fit = null, resizeHandler = null;

$('loginBtn').onclick = async () => {
  $('loginBtn').disabled = true;
  try {
    const r = await window.api.login();
    $('empName').textContent = r.employee.name || r.employee.email;
    $('empEmail').textContent = '· ' + r.employee.email;
    $('avatar').textContent = (r.employee.name || r.employee.email).trim()[0].toUpperCase();
    $('empSkills').textContent = `model ${r.model} · skills synced`;
    show('app');
    startTerminal();
  } catch (e) {
    loginLog('login failed: ' + e.message);
  } finally {
    $('loginBtn').disabled = false;
  }
};

async function startTerminal() {
  // Mount xterm, size it, then ask main to spawn the Codex pty at that size.
  term = new window.Terminal({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, cursorBlink: true, theme: { background: '#000000' } });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('term'));
  fit.fit();

  const res = await window.api.startTerminal({ cols: term.cols, rows: term.rows });
  if (res.mode !== 'embedded') {
    // No pty/binary — dispose the terminal and fall back.
    term.dispose(); term = null;
    $('termWrap').classList.add('hidden');
    $('statusPill').textContent = 'wiring only';
    fbLog(`Embedded Codex unavailable (${res.reason}).`);
    const r = await window.api.launchExternal();
    fbLog(r.launched ? 'Codex launched in an external terminal.' : `Gateway wiring verified (${r.proof.status}). Set a Codex binary in Settings to run Codex in-app.`);
    return;
  }

  $('statusPill').textContent = 'Codex running';
  term.onData((d) => window.api.ptyInput(d));
  window.api.onPtyData((d) => term.write(d));
  window.api.onPtyExit((code) => { term?.write(`\r\n\x1b[90m[Codex exited: ${code}]\x1b[0m\r\n`); $('statusPill').textContent = 'exited'; });
  term.focus();

  resizeHandler = () => { try { fit.fit(); window.api.ptyResize({ cols: term.cols, rows: term.rows }); } catch { /* not mounted */ } };
  window.addEventListener('resize', resizeHandler);
}

$('logoutBtn').onclick = async () => {
  await window.api.stopTerminal();
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
  if (term) { term.dispose(); term = null; }
  $('termWrap').classList.remove('hidden');
  $('fallbackLog').textContent = ''; $('loginLog').textContent = '';
  $('statusPill').textContent = 'provisioned';
  show('signin');
};

init();
