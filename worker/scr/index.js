// Free Web Push backend (Cloudflare Workers free plan + KV). No payload is sent, so no encryption is needed:
// the service worker shows a generic notification. Only due-dates are stored (no names, no amounts).
// OPTIONAL bank-SMS inbox (/sms, /inbox, /ack): when the user enables it, the parsed type, amount and date of a bank SMS
// are kept in KV for up to 30 days (the SMS text itself and the balance are NOT stored) until the app fetches and acknowledges them.
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
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
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

const cors = (env) => ({ 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Token', Vary: 'Origin' });


/* ---------------- Bank SMS inbox (optional) ---------------- */
const SMS_TTL = 30 * 86400;   // seconds
export function parseSms(txt) {
  const s = String(txt || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const m = s.match(/\b(debite|credite)\s+de\s*(-?\s*\d+(?:[.,]\d+)?)\s*DA\b/i);
  if (!m) return null;
  const amount = Math.abs(parseFloat(m[2].replace(/\s+/g, '').replace(',', '.')));
  if (!isFinite(amount) || amount <= 0 || amount > 1e9) return null;
  return { type: /^debite$/i.test(m[1]) ? 'expense' : 'income', amount };
}
async function smsRoutes(req, env, h, path) {
  const url = new URL(req.url);
  const token = req.headers.get('X-Token') || url.searchParams.get('t') || '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return new Response('bad token', { status: 401, headers: h });
  const prefix = 'm:' + (await sha('daftari-sms:' + token)).slice(0, 32) + ':';
  if (path === '/sms') {
    if (req.method !== 'POST') return new Response('not found', { status: 404, headers: h });
    let text = (await req.text()).slice(0, 2000);
    if (text.trim()[0] === '{') { try { const j = JSON.parse(text); if (typeof j.sms === 'string') text = j.sms; } catch { /* keep raw text */ } }
    text = text.replace(/\s+/g, ' ').trim();
    const p = parseSms(text);
    if (!p) return new Response('unrecognized', { status: 422, headers: h });
    const id = 'sms_' + (await sha(text)).slice(0, 16);
    if (await env.SUBS.get(prefix + id)) return new Response('duplicate', { headers: h });
    const w = (url.searchParams.get('w') || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff _-]/g, '').slice(0, 32);
    await env.SUBS.put(prefix + id, JSON.stringify({ id, type: p.type, amount: p.amount, date: localParts(TZ, new Date()).date, w }), { expirationTtl: SMS_TTL });
    return new Response('ok', { headers: h });
  }
  if (path === '/inbox') {
    if (req.method !== 'GET') return new Response('not found', { status: 404, headers: h });
    const page = await env.SUBS.list({ prefix, limit: 100 });
    const items = [];
    for (const k of page.keys) { const v = JSON.parse((await env.SUBS.get(k.name)) || 'null'); if (v) items.push(v); }
    return new Response(JSON.stringify({ items }), { headers: { ...h, 'Content-Type': 'application/json' } });
  }
  if (path === '/ack') {
    if (req.method !== 'POST') return new Response('not found', { status: 404, headers: h });
    let b; try { b = await req.json(); } catch { return new Response('bad json', { status: 400, headers: h }); }
    for (const id of (Array.isArray(b.ids) ? b.ids : []).slice(0, 100)) if (/^sms_[0-9a-f]{16}$/.test(id)) await env.SUBS.delete(prefix + id);
    return new Response('ok', { headers: h });
  }
  return new Response('not found', { status: 404, headers: h });
}

async function handle(req, env) {
  const h = cors(env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const path = new URL(req.url).pathname;
  if (path === '/sms' || path === '/inbox' || path === '/ack') return smsRoutes(req, env, h, path);
  if (new URL(req.url).pathname !== '/sync' || !['POST', 'DELETE'].includes(req.method)) return new Response('not found', { status: 404, headers: h });
  let b; try { b = await req.json(); } catch { return new Response('bad json', { status: 400, headers: h }); }
  let host; try { const u = new URL(b.endpoint); if (u.protocol !== 'https:') throw 0; host = u.hostname; } catch { return new Response('bad endpoint', { status: 400, headers: h }); }
  if (!PUSH_HOSTS.test(host) || b.endpoint.length > 1200) return new Response('endpoint not allowed', { status: 400, headers: h });
  const key = 's:' + (await sha(b.endpoint));
  if (req.method === 'DELETE') { await env.SUBS.delete(key); return new Response('ok', { headers: h }); }
  const rec = {
    endpoint: b.endpoint, t: Date.now(),
    hr: Number.isInteger(b.hr) && b.hr >= 0 && b.hr <= 23 ? b.hr : 9,   // reminder time chosen in the app (device-local)
    mn: Number.isInteger(b.mn) && b.mn >= 0 && b.mn <= 59 ? Math.floor(b.mn / 5) * 5 : 0,   // minutes, in 5-minute steps (the cron runs every 5 minutes)
    tz: validTz(b.tz) ? b.tz : TZ,
    debts: (Array.isArray(b.debts) ? b.debts : []).filter((d) => DATE.test(d)).slice(0, 200),
    rec: (Array.isArray(b.rec) ? b.rec : []).filter((r) => r && DATE.test(r.l) && ['weekly', 'monthly', 'yearly'].includes(r.f)).map((r) => ({ l: r.l, f: r.f })).slice(0, 200)
  };
  await env.SUBS.put(key, JSON.stringify(rec));
  return new Response('ok', { headers: h });
}

// Runs every 5 minutes (cron "*/5 * * * *"): a device gets its reminder in the 5-minute slot that contains the time it chose (local time).
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
      const wantMin = (Number.isInteger(rec.hr) ? rec.hr : 9) * 60 + (Number.isInteger(rec.mn) ? Math.floor(rec.mn / 5) * 5 : 0);
      const nowMin = lp.hour * 60 + lp.minute;
      if (nowMin - (nowMin % 5) !== wantMin - (wantMin % 5)) { console.log(`skip: local ${lp.hour}:${String(lp.minute).padStart(2, '0')} (${rec.tz || TZ}) is not the chosen slot ${Math.floor(wantMin / 60)}:${String(wantMin % 60).padStart(2, '0')}`); continue; }
      if (!isDue(rec, lp.date)) { console.log(`skip: nothing due on ${lp.date} (debts ${(rec.debts || []).length}, recurring ${(rec.rec || []).length})`); continue; }
      try {
        const r = await sendPush(rec.endpoint, env);
        if (r.status === 404 || r.status === 410) { await env.SUBS.delete(k.name); console.log('push: subscription gone, deleted', r.status); }
        else if (r.ok) { sent++; console.log('push accepted', r.status); }
        else console.log('push REJECTED', r.status, (await r.text()).slice(0, 200));
      } catch (e) { console.log('push failed', e.message); }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  console.log(`run: ${total} devices, ${sent} pushes`);
}

export default {
  fetch: async (req, env) => {
    try { return await handle(req, env); }
    catch (e) { return new Response('worker error: ' + e.message, { status: 500, headers: cors(env) }); }
  },
  scheduled: (_e, env, ctx) => ctx.waitUntil(hourly(env))
};
