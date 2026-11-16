// Free Web Push backend (Cloudflare Workers free plan + KV). No payload is sent, so no encryption is needed:
// the service worker shows a generic notification. Only due-dates are stored (no names, no amounts).
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = 'Africa/Algiers';

export function nextDate(s, freq) {
  const d = new Date(s + 'T00:00:00Z');
  if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (freq === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
const diff = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 864e5);

export function isDue(rec, today) {
  const debt = (rec.debts || []).some((d) => { const k = diff(d, today); return k <= 1 && k >= -30; });
  const recur = (rec.rec || []).some((r) => {
    let n = nextDate(r.l, r.f), g = 0;
    while (n < today && g++ < 40) n = nextDate(n, r.f);
    const k = diff(n, today); return k >= 0 && k <= 1;
  });
  return debt || recur;
}

const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

let keyCache;
async function vapidAuth(endpoint, env) {
  keyCache ||= crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await keyCache, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
}

async function sendPush(endpoint, env) {
  return fetch(endpoint, { method: 'POST', headers: { Authorization: await vapidAuth(endpoint, env), TTL: '86400', Urgency: 'high', 'Content-Length': '0' } });
}

// ======================= Pro (Chargily one-time payment) =======================
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const dec = (s) => new TextDecoder().decode(b64uToBytes(s));
const json = (o, h, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...h, 'Content-Type': 'application/json' } });

// Chargily signs the raw body with HMAC-SHA256 (hex) using the API secret key; it arrives in the `signature` header.
export async function verifyChargilySignature(raw, signature, secret) {
  if (!signature || !secret || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(signature.match(/../g).map((x) => parseInt(x, 16))), enc.encode(raw));
}

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwksCache;
const defaultJwks = async () => {
  if (jwksCache && jwksCache.exp > Date.now()) return jwksCache.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error('jwks ' + r.status);
  jwksCache = { keys: await r.json(), exp: Date.now() + 3600e3 };
  return jwksCache.keys;
};

// Verifies a Firebase Auth ID token (RS256) -> { uid, email } or null.
export async function verifyIdToken(token, projectId, getJwks = defaultJwks) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let head, body;
  try { head = JSON.parse(dec(parts[0])); body = JSON.parse(dec(parts[1])); } catch { return null; }
  if (head.alg !== 'RS256' || !head.kid) return null;
  const jwk = ((await getJwks()).keys || []).find((k) => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), enc.encode(parts[0] + '.' + parts[1])))) return null;
  const now = Math.floor(Date.now() / 1000);
  if (body.aud !== projectId || body.iss !== 'https://securetoken.google.com/' + projectId || !body.sub || !(body.exp > now) || body.iat > now + 300) return null;
  return { uid: body.sub, email: body.email };
}

// Service-account OAuth token (scope: datastore) so the Worker can write entitlements/{uid} through the Firestore REST API.
let saTok;
async function googleAccessToken(env) {
  if (saTok && saTok.exp > Date.now() + 60e3) return saTok.token;
  const sa = JSON.parse(env.FIREBASE_SA);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(Date.now() / 1000);
  const head = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64u(enc.encode(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })));
  const sig = b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + claim)));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + sig });
  if (!r.ok) throw new Error('google token ' + r.status);
  const j = await r.json();
  saTok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return saTok.token;
}

async function grantPro(env, uid, checkoutId, amount) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/entitlements/${encodeURIComponent(uid)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + (await googleAccessToken(env)), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { pro: { booleanValue: true }, checkoutId: { stringValue: String(checkoutId) }, amount: { integerValue: String(Math.round(amount)) }, paidAt: { integerValue: String(Date.now()) } } })
  });
  if (!r.ok) throw new Error('firestore ' + r.status + ' ' + (await r.text()));
}

async function createCheckout(req, env, h) {
  const price = Number(env.PRO_PRICE_DZD);
  if (!Number.isInteger(price) || price <= 0) return new Response('price not configured', { status: 500, headers: h });
  const user = await verifyIdToken((req.headers.get('Authorization') || '').replace(/^Bearer /, ''), env.FIREBASE_PROJECT_ID);
  if (!user) return new Response('unauthorized', { status: 401, headers: h });
  let b = {}; try { b = await req.json(); } catch {}
  const r = await fetch(env.CHARGILY_API_BASE + '/checkouts', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.CHARGILY_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: price, currency: 'dzd',
      success_url: env.ALLOWED_ORIGIN + '/?pro=success', failure_url: env.ALLOWED_ORIGIN + '/?pro=failed',
      webhook_endpoint: env.WORKER_URL + '/chargily-webhook',
      description: 'Daftari Pro (lifetime)',
      locale: ['ar', 'en', 'fr'].includes(b.locale) ? b.locale : 'ar'
    })
  });
  if (!r.ok) { console.log('chargily checkout failed', r.status, await r.text()); return new Response('payment provider error', { status: 502, headers: h }); }
  const co = await r.json();
  if (!co.id || !co.checkout_url) return new Response('payment provider error', { status: 502, headers: h });
  await env.SUBS.put('co:' + co.id, user.uid, { expirationTtl: 7 * 86400 }); // checkout id -> uid (we do not rely on metadata)
  return json({ url: co.checkout_url }, h);
}

async function chargilyWebhook(req, env) {
  const raw = await req.text();
  if (!(await verifyChargilySignature(raw, req.headers.get('signature'), env.CHARGILY_SECRET_KEY))) return new Response('bad signature', { status: 403 });
  let evt; try { evt = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  if (evt.type !== 'checkout.paid') return new Response('ignored');
  const co = evt.data || {};
  const uid = co.id ? await env.SUBS.get('co:' + co.id) : null;
  const liveOk = String(co.livemode) === String(env.CHARGILY_LIVE === 'true');   // never let a test payment unlock Pro in live mode
  if (!uid || !liveOk || String(co.currency).toLowerCase() !== 'dzd' || (co.status && co.status !== 'paid') || !(Number(co.amount) >= Number(env.PRO_PRICE_DZD))) {
    console.log('webhook ignored', co.id, !!uid, liveOk, co.currency, co.status, co.amount);
    return new Response('ignored');
  }
  await grantPro(env, uid, co.id, Number(co.amount));   // throws -> 500 so the provider can retry
  return new Response('ok');
}

const cors = (env) => ({ 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', Vary: 'Origin' });

async function handle(req, env) {
  const h = cors(env);
  const path = new URL(req.url).pathname;
  if (path === '/chargily-webhook') return req.method === 'POST' ? chargilyWebhook(req, env) : new Response('method not allowed', { status: 405 });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (path === '/checkout' && req.method === 'POST') return createCheckout(req, env, h);
  if (path !== '/sync' || !['POST', 'DELETE'].includes(req.method)) return new Response('not found', { status: 404, headers: h });
  let b; try { b = await req.json(); } catch { return new Response('bad json', { status: 400, headers: h }); }
  let host; try { const u = new URL(b.endpoint); if (u.protocol !== 'https:') throw 0; host = u.hostname; } catch { return new Response('bad endpoint', { status: 400, headers: h }); }
  if (!PUSH_HOSTS.test(host) || b.endpoint.length > 1200) return new Response('endpoint not allowed', { status: 400, headers: h });
  const key = 's:' + (await sha(b.endpoint));
  if (req.method === 'DELETE') { await env.SUBS.delete(key); return new Response('ok', { headers: h }); }
  const rec = {
    endpoint: b.endpoint, t: Date.now(),
    debts: (Array.isArray(b.debts) ? b.debts : []).filter((d) => DATE.test(d)).slice(0, 200),
    rec: (Array.isArray(b.rec) ? b.rec : []).filter((r) => r && DATE.test(r.l) && ['weekly', 'monthly', 'yearly'].includes(r.f)).map((r) => ({ l: r.l, f: r.f })).slice(0, 200)
  };
  await env.SUBS.put(key, JSON.stringify(rec));
  return new Response('ok', { headers: h });
}

async function daily(env) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  let cursor, sent = 0, total = 0;
  do {
    const page = await env.SUBS.list({ prefix: 's:', cursor });
    for (const k of page.keys) {
      const rec = JSON.parse((await env.SUBS.get(k.name)) || 'null'); if (!rec) continue;
      total++;
      if (Date.now() - rec.t > 120 * 864e5) { await env.SUBS.delete(k.name); continue; } // abandoned device
      if (!isDue(rec, today)) continue;
      try {
        const r = await sendPush(rec.endpoint, env);
        if (r.status === 404 || r.status === 410) await env.SUBS.delete(k.name); else if (r.ok) sent++;
      } catch (e) { console.log('push failed', e.message); }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  console.log(`daily: ${total} devices, ${sent} pushes`);
}

export default {
  fetch: async (req, env) => {
    try { return await handle(req, env); }
    catch (e) { return new Response('worker error: ' + e.message, { status: 500, headers: cors(env) }); }
  },
  scheduled: (_e, env, ctx) => ctx.waitUntil(daily(env))
};
