// Minimal JSON-file-backed store (zero deps). Atomic writes via temp+rename.
// In production swap this for Postgres/Redis; the interface stays the same.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Store {
  constructor(dataDir, seedFile) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    this.seedFile = seedFile;
    this._flushTimer = null;
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this._load();
    // Flush any pending debounced write before the process goes away.
    const flush = () => this.flush();
    process.once('exit', flush);
    process.once('SIGINT', () => { flush(); process.exit(130); });
    process.once('SIGTERM', () => { flush(); process.exit(143); });
  }

  _load() {
    let data;
    if (fs.existsSync(this.file)) {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      // First run: seed the employee directory (normally synced from HR/IdP).
      data = { employees: {}, keys: {}, usage: [] };
      if (this.seedFile && fs.existsSync(this.seedFile)) {
        const seed = JSON.parse(fs.readFileSync(this.seedFile, 'utf8'));
        for (const e of seed.employees || []) {
          data.employees[e.email.toLowerCase()] = {
            name: e.name,
            role: e.role || 'engineer',
            status: e.status || 'active',
            isAdmin: !!e.isAdmin,
          };
        }
      }
    }
    data.employees ||= {}; data.keys ||= {}; data.usage ||= [];
    data.upstreams ||= []; // pool of admin-added relay/account upstreams
    this._persistNow(data);
    return data;
  }

  // Synchronous atomic write (temp + rename).
  _persistNow(data = this.data) {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  // Config-shaped mutations persist immediately; high-frequency usage writes are
  // debounced so we don't re-serialize the whole store on every proxied request.
  _persist(data = this.data) { this._persistNow(data); }
  _persistDebounced() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => { this._flushTimer = null; this._persistNow(); }, 750);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }
  flush() { if (this._flushTimer) this._persistNow(); }

  // --- employees -------------------------------------------------------
  getEmployee(email) {
    return this.data.employees[String(email).toLowerCase()] || null;
  }
  upsertEmployee(email, patch) {
    const key = String(email).toLowerCase();
    this.data.employees[key] = { ...(this.data.employees[key] || {}), ...patch };
    this._persist();
    return this.data.employees[key];
  }
  listEmployees() {
    return Object.entries(this.data.employees).map(([email, e]) => ({ email, ...e }));
  }

  // --- keys ------------------------------------------------------------
  addKey(keyHash, record) {
    this.data.keys[keyHash] = record;
    this._persist();
  }
  getKey(keyHash) {
    return this.data.keys[keyHash] || null;
  }
  keysForEmployee(email) {
    const e = String(email).toLowerCase();
    return Object.entries(this.data.keys)
      .filter(([, r]) => r.email === e)
      .map(([hash, r]) => ({ hash, ...r }));
  }
  deactivateKeysForEmployee(email) {
    const e = String(email).toLowerCase();
    let n = 0;
    for (const [hash, r] of Object.entries(this.data.keys)) {
      if (r.email === e && r.active) {
        this.data.keys[hash].active = false;
        this.data.keys[hash].revokedAt = new Date().toISOString();
        n++;
      }
    }
    this._persist();
    return n;
  }

  // --- usage -----------------------------------------------------------
  recordUsage(event) {
    this.data.usage.push(event);
    // Keep the demo file bounded.
    if (this.data.usage.length > 50000) this.data.usage.splice(0, 10000);
    this._persistDebounced(); // coalesce high-frequency writes off the hot path
  }
  usageByEmployee() {
    const agg = {};
    for (const u of this.data.usage) {
      const a = (agg[u.email] ||= { email: u.email, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, lastActive: null });
      a.requests++;
      a.promptTokens += u.promptTokens || 0;
      a.completionTokens += u.completionTokens || 0;
      a.totalTokens += u.totalTokens || 0;
      if (!a.lastActive || u.ts > a.lastActive) a.lastActive = u.ts;
    }
    return Object.values(agg);
  }

  // Activity feed: what employees have been asking Codex (newest first).
  recentActivity({ email = null, limit = 50 } = {}) {
    const out = [];
    for (let i = this.data.usage.length - 1; i >= 0 && out.length < limit; i--) {
      const u = this.data.usage[i];
      if (email && u.email !== String(email).toLowerCase()) continue;
      out.push({ ts: u.ts, email: u.email, model: u.model, prompt: u.prompt || null, totalTokens: u.totalTokens || 0 });
    }
    return out;
  }

  // --- upstream pool (admin-added relay / account upstreams) ------------
  // Each: { id, name, baseUrl, apiKey, weight, enabled, addedBy, createdAt,
  //         health: { status, lastError, lastUsed, failures } }
  addUpstream(u) {
    const rec = {
      id: 'up_' + crypto.randomBytes(6).toString('hex'),
      name: u.name || u.baseUrl,
      baseUrl: String(u.baseUrl).replace(/\/$/, ''),
      apiKey: u.apiKey || '',
      weight: Math.max(1, Number(u.weight) || 1),
      enabled: u.enabled !== false,
      addedBy: u.addedBy || 'admin',
      createdAt: new Date().toISOString(),
      health: { status: 'unknown', lastError: null, lastUsed: null, failures: 0 },
    };
    this.data.upstreams.push(rec);
    this._persist();
    return rec;
  }
  listUpstreams() { return this.data.upstreams.slice(); }
  getUpstream(id) { return this.data.upstreams.find((u) => u.id === id) || null; }
  updateUpstream(id, patch) {
    const u = this.getUpstream(id);
    if (!u) return null;
    if (patch.name !== undefined) u.name = patch.name;
    if (patch.weight !== undefined) u.weight = Math.max(1, Number(patch.weight) || 1);
    if (patch.enabled !== undefined) u.enabled = !!patch.enabled;
    if (patch.baseUrl !== undefined) u.baseUrl = String(patch.baseUrl).replace(/\/$/, '');
    if (patch.apiKey) u.apiKey = patch.apiKey; // only overwrite when a new key is given
    this._persist();
    return u;
  }
  removeUpstream(id) {
    const before = this.data.upstreams.length;
    this.data.upstreams = this.data.upstreams.filter((u) => u.id !== id);
    const removed = this.data.upstreams.length < before;
    if (removed) this._persist();
    return removed;
  }
  // Record health after a proxied request; brief cooldown after repeated errors.
  markUpstreamHealth(id, ok, errorMsg) {
    const u = this.getUpstream(id);
    if (!u) return;
    u.health.lastUsed = new Date().toISOString();
    if (ok) { u.health.status = 'ok'; u.health.failures = 0; u.health.lastError = null; }
    else { u.health.failures = (u.health.failures || 0) + 1; u.health.lastError = errorMsg || 'error'; u.health.status = u.health.failures >= 3 ? 'down' : 'degraded'; }
    this._persistDebounced();
  }
}
