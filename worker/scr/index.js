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
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), day: Number(p.day), weekday: new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay() };
}
function cleanDebt(x) {
  if (typeof x === 'string') return DATE.test(x) ? x : null;
  if (!x || typeof x !== 'object' || typeof x.d !== 'string' || !DATE.test(x.d)) return null;
  if (!Number.isInteger(x.h) || x.h < 0 || x.h > 23) return x.d;
  return { d: x.d, h: x.h, m: Number.isInteger(x.m) && x.m >= 0 && x.m <= 59 ? Math.floor(x.m / 5) * 5 : 0 };
}
// Is any due-date reminder (debt with its own time, or general-time debts/recurring) scheduled for this 5-minute slot?
export function dueNow(rec, lp, nowMin, generalMin) {
  const tick = nowMin - (nowMin % 5);
  const hit = (w) => tick === w - (w % 5);
  for (const d of rec.debts || []) {
    const k = diff(debtDate(d), lp.date);
    if (k > 1 || k < -LATE_DAYS) continue;
    const w = typeof d === 'object' && Number.isInteger(d.h) ? d.h * 60 + (d.m || 0) : generalMin;
    if (hit(w)) return true;
  }
  return hit(generalMin) && (rec.rec || []).some((r) => {
    let n = nextDate(r.l, r.f), g = 0;
    while (n < lp.date && g++ < 40) n = nextDate(n, r.f);
    const k = diff(n, lp.date); return k >= 0 && k <= 1;
  });
}
// Extra reminders config sent by the app: time, weekday (-1 = off), daily/monthly flags, backup {last date, interval}.
function cleanEv(e) {
  if (!e || typeof e !== 'object') return null;
  const bk = e.bk && typeof e.bk === 'object'
    ? { last: DATE.test(e.bk.last || '') ? e.bk.last : '', ivl: Number.isInteger(e.bk.ivl) && e.bk.ivl >= 1 && e.bk.ivl <= 365 ? e.bk.ivl : 7 } : null;
  return {
    h: Number.isInteger(e.h) && e.h >= 0 && e.h <= 23 ? e.h : 20,
    m: Number.isInteger(e.m) && e.m >= 0 && e.m <= 59 ? Math.floor(e.m / 5) * 5 : 0,
    wd: Number.isInteger(e.wd) && e.wd >= -1 && e.wd <= 6 ? e.wd : -1,
    dl: e.dl === true, mo: e.mo === true, bk
  };
}
export function evActive(ev, lp) {
  return ev.wd === lp.weekday || ev.dl || (ev.mo && lp.day === 1) || !!(ev.bk && (!ev.bk.last || diff(lp.date, ev.bk.last) >= ev.bk.ivl));
}
const validTz = (s) => { if (typeof s !== 'string' || !s || s.length > 64) return false; try { new Intl.DateTimeFormat('en-CA', { timeZone: s }); return true; } catch { return false; } };

const LATE_DAYS = 7;   // overdue debts are reminded for 7 days after the due date, then the reminders stop
// A debt entry is either a date string (general reminder time) or { d, h, m } (its own reminder time).
const debtDate = (d) => (typeof d === 'string' ? d : d.d);
export function isDue(rec, today) {
  const debt = (rec.debts || []).some((d) => { const k = diff(debtDate(d), today); return k <= 1 && k >= -LATE_DAYS; });
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
  const path = new URL(req.url).pathname;
  if ((path !== '/sync' && path !== '/test') || !['POST', 'DELETE'].includes(req.method) || (path === '/test' && req.method !== 'POST')) return new Response('not found', { status: 404, headers: h });
  let b; try { b = await req.json(); } catch { return new Response('bad json', { status: 400, headers: h }); }
  let host; try { const u = new URL(b.endpoint); if (u.protocol !== 'https:') throw 0; host = u.hostname; } catch { return new Response('bad endpoint', { status: 400, headers: h }); }
  if (!PUSH_HOSTS.test(host) || b.endpoint.length > 1200) return new Response('endpoint not allowed', { status: 400, headers: h });
  const key = 's:' + (await sha(b.endpoint));
  if (path === '/test') {   // immediate test push to a REGISTERED device (max once a minute) - shows the push service's answer
    const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...h, 'Content-Type': 'application/json' } });
    if (!(await env.SUBS.get(key))) return j({ ok: false, error: 'not registered' }, 404);
    if (await env.SUBS.get('rl:' + key)) return j({ ok: false, error: 'too fast' }, 429);
    await env.SUBS.put('rl:' + key, '1', { expirationTtl: 60 });
    const r = await sendPush(b.endpoint, env);
    return j({ ok: r.ok, status: r.status, detail: r.ok ? '' : (await r.text()).slice(0, 200) });
  }
  if (req.method === 'DELETE') { await env.SUBS.delete(key); return new Response('ok', { headers: h }); }
  const rec = {
    endpoint: b.endpoint, t: Date.now(),
    hr: Number.isInteger(b.hr) && b.hr >= 0 && b.hr <= 23 ? b.hr : 9,   // reminder time chosen in the app (device-local)
    mn: Number.isInteger(b.mn) && b.mn >= 0 && b.mn <= 59 ? Math.floor(b.mn / 5) * 5 : 0,   // minutes, in 5-minute steps (the cron runs every 5 minutes)
    tz: validTz(b.tz) ? b.tz : TZ,
    ev: cleanEv(b.ev),
    debts: (Array.isArray(b.debts) ? b.debts : []).map(cleanDebt).filter(Boolean).slice(0, 200),
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
      const slotOf = (h, m) => { const w = h * 60 + m; return nowMin - (nowMin % 5) === w - (w % 5); };
      const dueHit = dueNow(rec, lp, nowMin, wantMin);
      const evNow = !!(rec.ev && slotOf(rec.ev.h, rec.ev.m) && evActive(rec.ev, lp));
      if (!dueHit && !evNow) { console.log(`skip: local ${lp.hour}:${String(lp.minute).padStart(2, '0')} (${rec.tz || TZ}) - nothing scheduled now (due slot ${Math.floor(wantMin / 60)}:${String(wantMin % 60).padStart(2, '0')})`); continue; }
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
