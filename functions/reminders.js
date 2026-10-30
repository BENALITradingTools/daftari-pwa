// Pure logic: decides which notifications a user should get today.
// No names or amounts are ever put in the message (lock-screen privacy).

function nextDate(dateStr, freq) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (freq === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

const dayDiff = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);

const TXT = {
  ar: {
    title: 'دفتري',
    debts: (n) => (n === 1 ? 'لديك دين مستحق أو متأخر' : `لديك ${n} ديون مستحقة أو متأخرة`),
    rec: (n) => (n === 1 ? 'معاملة متكررة ستُسجَّل قريبًا' : `${n} معاملات متكررة ستُسجَّل قريبًا`)
  },
  en: {
    title: 'Daftari',
    debts: (n) => (n === 1 ? 'A debt is due or overdue' : `${n} debts are due or overdue`),
    rec: (n) => (n === 1 ? 'A recurring transaction is coming up' : `${n} recurring transactions are coming up`)
  }
};

// userDoc = the synced document users/{uid}; today = 'YYYY-MM-DD' in the target timezone.
function buildNotifications(userDoc, today) {
  const lang = userDoc && userDoc.settings && userDoc.settings.lang === 'en' ? 'en' : 'ar';
  const T = TXT[lang];
  const out = [];

  const dueDebts = (userDoc.debts || []).filter((d) => {
    if (!d || !d.dueDate) return false;
    if ((Number(d.paid) || 0) >= (Number(d.amount) || 0)) return false; // settled
    return dayDiff(d.dueDate, today) <= 1; // overdue, today or tomorrow
  });
  if (dueDebts.length) out.push({ title: T.title, body: T.debts(dueDebts.length), tab: 'tabDebts', tag: 'daftari-debts', lang });

  const dueRec = (userDoc.recurring || []).filter((r) => {
    if (!r || !r.lastDate) return false;
    const diff = dayDiff(nextDate(r.lastDate, r.freq), today);
    return diff >= 0 && diff <= 1;
  });
  if (dueRec.length) out.push({ title: T.title, body: T.rec(dueRec.length), tab: 'tabHome', tag: 'daftari-recurring', lang });

  return out;
}

module.exports = { buildNotifications, nextDate };
