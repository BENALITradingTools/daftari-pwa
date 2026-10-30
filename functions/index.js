const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { buildNotifications } = require('./reminders');

admin.initializeApp();
const db = admin.firestore();

const TZ = 'Africa/Algiers';
const DEAD = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];

exports.dailyReminders = onSchedule(
  { schedule: '0 9 * * *', timeZone: TZ, region: 'europe-west1', memory: '256MiB' },
  async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD

    // Only users who registered at least one device.
    const devices = await db.collectionGroup('devices').get();
    const byUser = new Map();
    devices.forEach((d) => {
      const uid = d.ref.parent.parent.id;
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push(d);
    });

    let sent = 0;
    for (const [uid, devs] of byUser) {
      const snap = await db.doc(`users/${uid}`).get();
      if (!snap.exists) continue;
      const messages = buildNotifications(snap.data(), today);
      if (!messages.length) continue;

      for (const m of messages) {
        const tokens = devs.map((d) => d.get('token')).filter(Boolean);
        if (!tokens.length) continue;
        const res = await admin.messaging().sendEachForMulticast({
          tokens,
          data: { title: m.title, body: m.body, tab: m.tab, tag: m.tag, lang: m.lang }, // data-only → handled by sw.js
          webpush: { headers: { Urgency: 'high', TTL: '86400' } }
        });
        sent += res.successCount;
        // drop dead tokens
        await Promise.all(res.responses.map((r, i) =>
          !r.success && r.error && DEAD.includes(r.error.code) ? devs[i].ref.delete() : null));
      }
    }
    logger.info(`dailyReminders: ${byUser.size} users, ${sent} notifications sent`);
  }
);
