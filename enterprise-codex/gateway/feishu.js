// Real Feishu / Lark OAuth (authorization-code flow). The app secret lives only
// here; the desktop client never sees it. Flow:
//   /auth/feishu/start  -> 302 to Feishu authorize (signed state)
//   Feishu -> /auth/feishu/callback?code&state -> exchange code -> user_info
//   manager intent: set session cookie + redirect to console
//   employee intent: stash the issued key under a PKCE-bound link; the desktop
//                    app claims it via /auth/feishu/poll (proving code_verifier)
import crypto from 'node:crypto';
import { config } from './config.js';
import { httpError, safeEqual } from './auth.js';

export function feishuConfigured() {
  return !!(config.feishu.appId && config.feishu.appSecret);
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

// --- signed OAuth state (stateless CSRF token) ------------------------
export function signState(obj) {
  const payload = b64u(JSON.stringify({ ...obj, exp: Math.floor(Date.now() / 1000) + config.oauthStateTtlSeconds }));
  const sig = crypto.createHmac('sha256', config.ssoSharedSecret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
export function verifyState(state) {
  if (typeof state !== 'string' || !state.includes('.')) throw httpError(400, 'bad oauth state');
  const [payload, sig] = state.split('.');
  const expected = crypto.createHmac('sha256', config.ssoSharedSecret).update(payload).digest('hex');
  if (!safeEqual(sig, expected)) throw httpError(400, 'oauth state signature mismatch');
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!obj.exp || obj.exp < Math.floor(Date.now() / 1000)) throw httpError(400, 'oauth state expired');
  return obj;
}

export function buildAuthorizeUrl(state, extra = {}) {
  const u = new URL(config.feishu.authorizeUrl);
  u.searchParams.set('client_id', config.feishu.appId);
  u.searchParams.set('redirect_uri', config.feishu.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', config.feishu.scope);
  u.searchParams.set('state', state);
  for (const [k, v] of Object.entries(extra)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

// Exchange the authorization code for a user access_token (Feishu OAuth v2).
export async function exchangeCode(code) {
  const r = await fetch(config.feishu.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.feishu.appId,
      client_secret: config.feishu.appSecret,
      code,
      redirect_uri: config.feishu.redirectUri,
    }),
  });
  const j = await r.json().catch(() => ({}));
  // Feishu returns code:0 on success; the access_token may sit at the top level
  // (v2) or under data (older shapes) — accept both.
  const token = j.access_token || j.data?.access_token;
  if (!r.ok || (j.code !== undefined && j.code !== 0) || !token) {
    throw httpError(502, `Feishu token exchange failed: ${j.msg || j.error || r.status}`);
  }
  return token;
}

// Fetch the authenticated user's profile and return the verified email.
export async function fetchUserInfo(userAccessToken) {
  const r = await fetch(config.feishu.userInfoUrl, { headers: { authorization: `Bearer ${userAccessToken}` } });
  const j = await r.json().catch(() => ({}));
  const data = j.data || j;
  if (!r.ok || (j.code !== undefined && j.code !== 0)) {
    throw httpError(502, `Feishu user_info failed: ${j.msg || r.status}`);
  }
  // Identity comes from the corporate mailbox (enterprise_email) by DEFAULT,
  // because data.email can be a user-set personal address on some tenants —
  // trusting it would let a user match themselves to a colleague's identity.
  // Set FEISHU_REQUIRE_ENTERPRISE_EMAIL=false to also accept data.email.
  const allowPersonal = process.env.FEISHU_REQUIRE_ENTERPRISE_EMAIL === 'false';
  const email = data.enterprise_email || (allowPersonal ? data.email : '');
  if (!email) throw httpError(403, 'Feishu account has no enterprise email — grant the email scope (or set FEISHU_REQUIRE_ENTERPRISE_EMAIL=false to allow personal email)');
  return { email: String(email).toLowerCase(), name: data.name || data.en_name || email };
}

// --- PKCE-bound pending-login store (for the desktop link+poll handoff) ---
const pending = new Map(); // link -> { status, result, challenge, exp }

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
}

// REFUSE TO OVERWRITE: the client-chosen `link` is not secret (it rides in the
// decodable OAuth state), so a second /start for the same link must NOT be able
// to rebind the PKCE challenge. The victim registers first with a random link;
// any later call for that link is a no-op, so the attacker can never swap in
// their own challenge to claim the victim's key. Returns false if not created.
export function createPending(link, challenge) {
  sweep();
  if (pending.has(link)) return false;
  pending.set(link, { status: 'pending', result: null, challenge, exp: Date.now() + config.oauthStateTtlSeconds * 1000 });
  return true;
}
// Only resolve a still-pending entry, and only when the callback's (HMAC-signed)
// state challenge matches the one registered at /start — so a rogue callback for
// someone else's link cannot clobber it or rebind the challenge.
export function resolvePending(link, result, stateChallenge, status = 'done') {
  const e = pending.get(link);
  if (!e || e.status !== 'pending') return false;
  if (!stateChallenge || stateChallenge !== e.challenge) return false;
  e.status = status;
  e.result = result;
  return true;
}
// Claim the result once, proving knowledge of the PKCE verifier.
export function claimPending(link, verifier) {
  sweep();
  const e = pending.get(link);
  if (!e) return { status: 'unknown' };
  if (e.status === 'pending') return { status: 'pending' };
  // challenge = base64url(sha256(verifier)) — PKCE S256
  if (!e.challenge || b64u(sha256(String(verifier || ''))) !== e.challenge) {
    return { status: 'error', error: 'pkce verifier mismatch' };
  }
  pending.delete(link); // single use
  return { status: e.status, result: e.result };
}
