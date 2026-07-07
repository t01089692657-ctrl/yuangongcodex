// Minimal JSON-file-backed store (zero deps). Atomic writes via temp+rename.
// In production swap this for Postgres/Redis; the interface stays the same.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dataDir, seedFile) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    this.seedFile = seedFile;
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this._load();
  }

  _load() {
    if (fs.existsSync(this.file)) {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    }
    // First run: seed the employee directory (normally synced from HR/IdP).
    const data = { employees: {}, keys: {}, usage: [] };
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
    this._persist(data);
    return data;
  }

  _persist(data = this.data) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }

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
    this._persist();
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
}
