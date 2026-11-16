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

// Local date + hour (0-23) in a given IANA time zone (handles DST).
export function localParts(tz, now) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
const validTz = (s) => { if (typeof s !== 'string' || !s || s.length > 64) return false; try { new Intl.DateTimeFormat('en-CA', { timeZone: s }); return true; } catch { return false; } };

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

const cors = (env) => ({ 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' });

async function handle(req, env) {
  const h = cors(env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (new URL(req.url).pathname !== '/sync' || !['POST', 'DELETE'].includes(req.method)) return new Response('not found', { status: 404, headers: h });
  let b; try { b = await req.json(); } catch { return new Response('bad json', { status: 400, headers: h }); }
  let host; try { const u = new URL(b.endpoint); if (u.protocol !== 'https:') throw 0; host = u.hostname; } catch { return new Response('bad endpoint', { status: 400, headers: h }); }
  if (!PUSH_HOSTS.test(host) || b.endpoint.length > 1200) return new Response('endpoint not allowed', { status: 400, headers: h });
  const key = 's:' + (await sha(b.endpoint));
  if (req.method === 'DELETE') { await env.SUBS.delete(key); return new Response('ok', { headers: h }); }
  const rec = {
    endpoint: b.endpoint, t: Date.now(),
    hr: Number.isInteger(b.hr) && b.hr >= 0 && b.hr <= 23 ? b.hr : 9,   // reminder hour chosen in the app (device-local)
    tz: validTz(b.tz) ? b.tz : TZ,
    debts: (Array.isArray(b.debts) ? b.debts : []).filter((d) => DATE.test(d)).slice(0, 200),
    rec: (Array.isArray(b.rec) ? b.rec : []).filter((r) => r && DATE.test(r.l) && ['weekly', 'monthly', 'yearly'].includes(r.f)).map((r) => ({ l: r.l, f: r.f })).slice(0, 200)
  };
  await env.SUBS.put(key, JSON.stringify(rec));
  return new Response('ok', { headers: h });
}

// Runs every hour (cron "0 * * * *"): a device gets its reminder only when ITS local hour equals the hour it chose.
async function hourly(env) {
  const now = new Date();
  let cursor, sent = 0, total = 0;
  do {
    const page = await env.SUBS.list({ prefix: 's:', cursor });
    for (const k of page.keys) {
      const rec = JSON.parse((await env.SUBS.get(k.name)) || 'null'); if (!rec) continue;
      total++;
      if (Date.now() - rec.t > 120 * 864e5) { await env.SUBS.delete(k.name); continue; } // abandoned device
      const lp = localParts(rec.tz || TZ, now);               // records saved before this feature: 09:00 Algiers
      if (lp.hour !== (Number.isInteger(rec.hr) ? rec.hr : 9)) continue;
      if (!isDue(rec, lp.date)) continue;
      try {
        const r = await sendPush(rec.endpoint, env);
        if (r.status === 404 || r.status === 410) await env.SUBS.delete(k.name); else if (r.ok) sent++;
      } catch (e) { console.log('push failed', e.message); }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  console.log(`hourly: ${total} devices, ${sent} pushes`);
}

export default {
  fetch: async (req, env) => {
    try { return await handle(req, env); }
    catch (e) { return new Response('worker error: ' + e.message, { status: 500, headers: cors(env) }); }
  },
  scheduled: (_e, env, ctx) => ctx.waitUntil(hourly(env))
};
