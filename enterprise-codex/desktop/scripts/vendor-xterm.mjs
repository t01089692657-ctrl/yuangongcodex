// Copy xterm's static assets from node_modules into renderer/vendor/ so the
// renderer can load them under a strict CSP (script-src 'self'). The files are
// also committed to the repo, so this just refreshes them; if @xterm isn't
// installed (e.g. --production), it warns and keeps the committed copies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const vendor = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(vendor, { recursive: true });

const copies = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/xterm/LICENSE', 'XTERM-LICENSE'],
];

let copied = 0;
for (const [from, to] of copies) {
  const src = path.join(root, 'node_modules', from);
  const dest = path.join(vendor, to);
  if (fs.existsSync(src)) { fs.copyFileSync(src, dest); copied++; }
  else if (!fs.existsSync(dest)) console.warn(`[vendor-xterm] missing ${from} and no committed copy at ${to}`);
}
console.log(`[vendor-xterm] refreshed ${copied}/${copies.length} asset(s) into renderer/vendor/`);
