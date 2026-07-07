// Key issuance, hashing, resolution, and revocation.
// Keys are opaque bearer tokens; only their SHA-256 hash is stored, so the
// plaintext is shown to the client exactly once. Revocation is instant:
// flip active=false and the very next Codex request 401s.
import crypto from 'node:crypto';

export function generateKey(prefix) {
  return prefix + crypto.randomBytes(24).toString('base64url');
}

export function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// Issue a fresh key for an active employee. We rotate on each login:
// deactivate old keys so a departed/rotated session can't linger.
export function issueKeyForEmployee(store, email, config, { label = 'client-login' } = {}) {
  const employee = store.getEmployee(email);
  if (!employee) throw httpError(404, 'unknown employee');
  if (employee.status !== 'active') throw httpError(403, 'employee is not active');

  store.deactivateKeysForEmployee(email);

  const key = generateKey(config.keyPrefix);
  const now = Date.now();
  store.addKey(hashKey(key), {
    email: String(email).toLowerCase(),
    label,
    active: true,
    createdAt: new Date(now).toISOString(),
    expiresAt: config.keyTtlSeconds > 0 ? new Date(now + config.keyTtlSeconds * 1000).toISOString() : null,
  });
  return { key, expiresAt: config.keyTtlSeconds > 0 ? new Date(now + config.keyTtlSeconds * 1000).toISOString() : null };
}

// Validate a presented bearer key. Returns {email, employee} or throws 401/403.
export function resolveKey(store, presentedKey) {
  if (!presentedKey) throw httpError(401, 'missing bearer key');
  const rec = store.getKey(hashKey(presentedKey));
  if (!rec || !rec.active) throw httpError(401, 'invalid or revoked key');
  if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) throw httpError(401, 'key expired');
  const employee = store.getEmployee(rec.email);
  if (!employee || employee.status !== 'active') throw httpError(403, 'employee offboarded');
  return { email: rec.email, employee };
}

// Offboarding: mark employee inactive and kill every live key.
export function offboardEmployee(store, email) {
  const employee = store.getEmployee(email);
  if (!employee) return { found: false, revoked: 0 };
  store.upsertEmployee(email, { status: 'offboarded', offboardedAt: new Date().toISOString() });
  const revoked = store.deactivateKeysForEmployee(email);
  return { found: true, revoked };
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Constant-time string compare (avoids leaking match length/prefix via timing).
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// --- SSO assertion ----------------------------------------------------
// Demo assertion: base64url(JSON{email,exp}) + '.' + HMAC-SHA256(secret, payload).
// Only a holder of the shared secret (the trusted SSO frontend) can mint one,
// so /auth/login cannot be driven by an anonymous client with a bare email.
// In production, replace with OIDC id_token verification (JWKS signature check).
export function signSsoAssertion(email, secret, ttlSeconds) {
  const payload = Buffer.from(JSON.stringify({ email: String(email).toLowerCase(), exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

// --- manager session --------------------------------------------------
// Signed session token for the manager backend (same HMAC scheme). The role is
// re-checked against the live store on every request, so a demoted/offboarded
// manager's session stops working immediately regardless of TTL.
export function signSession(profile, secret, ttlSeconds) {
  const payload = Buffer.from(JSON.stringify({ ...profile, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifySession(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) throw httpError(401, 'missing manager session');
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (!safeEqual(sig, expected)) throw httpError(401, 'invalid manager session');
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw httpError(401, 'unreadable session'); }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) throw httpError(401, 'session expired');
  return claims;
}

export function verifySsoAssertion(assertion, secret) {
  if (typeof assertion !== 'string' || !assertion.includes('.')) throw httpError(401, 'missing or malformed SSO assertion');
  const [payload, sig] = assertion.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (!safeEqual(sig, expected)) throw httpError(401, 'invalid SSO assertion signature');
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw httpError(401, 'unreadable SSO assertion'); }
  if (!claims.email) throw httpError(401, 'SSO assertion has no email');
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) throw httpError(401, 'SSO assertion expired');
  return { email: String(claims.email).toLowerCase() };
}
