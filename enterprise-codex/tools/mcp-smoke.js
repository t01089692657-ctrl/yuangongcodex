// Smoke test for the company MCP server: initialize -> tools/list -> tools/call.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'skills', 'mcp', 'company-mcp.js');

const child = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const rpc = (id, method, params) =>
  new Promise((resolve) => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
assert(init.result?.serverInfo?.name === 'company-mcp', 'initialize returns serverInfo');

const list = await rpc(2, 'tools/list', {});
const names = (list.result?.tools || []).map((t) => t.name);
assert(names.includes('get_coding_standard') && names.includes('scaffold_service'), `tools/list = [${names}]`);

const call = await rpc(3, 'tools/call', { name: 'get_coding_standard', arguments: { topic: 'secrets' } });
const text = call.result?.content?.[0]?.text || '';
assert(/No secrets/.test(text), `tools/call get_coding_standard -> "${text.slice(0, 48)}…"`);

child.kill();
console.log(process.exitCode ? '\nMCP smoke: FAILED' : '\nMCP smoke: OK');
