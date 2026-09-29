'use strict';

const cron = require('node-cron');
const db = require('../api/db/connection');

let botInstance = null;

function formatRupiah(n) {
  return 'Rp ' + n.toLocaleString('id-ID');
}

// Reminder harian jam 21:00 WIB
function scheduleDailyReminder() {
  cron.schedule('0 21 * * *', async () => {
    if (!botInstance) return;
    const users = db.getAllUsers();

    for (const user of users) {
      const hasTx = db.getTransactions(user.user_id, { date: db.todayStr(), limit: 1 }).total > 0;
      if (!hasTx) {
        try {
          await botInstance.sendMessage(user.user_id,
            `⏰ *Reminder Malam*\n\nHei${user.first_name ? ' ' + user.first_name : ''}! Belum ada catatan transaksi hari ini.\n\nJangan lupa catat: \`/catat 25000 makan\``,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          console.error(`[SCHED] reminder gagal ke ${user.user_id}:`, err.message);
        }
      }
    }
    console.log('[SCHED] Daily reminder sent');
  }, { timezone: 'Asia/Jakarta' });
}

// Weekly summary setiap Senin 09:00 WIB
function scheduleWeeklySummary() {
  cron.schedule('0 9 * * 1', async () => {
    if (!botInstance) return;
    const users = db.getAllUsers();

    for (const user of users) {
      const summary = db.getSummary(user.user_id, 'week');
      if (!summary.by_category.length) continue;

      let msg = `📊 *Ringkasan Mingguan*\n\n` +
        `💚 Pemasukan: *${formatRupiah(summary.income)}*\n` +
        `🔴 Pengeluaran: *${formatRupiah(summary.expense)}*\n` +
        `${summary.balance >= 0 ? '✅' : '⚠️'} Saldo: *${formatRupiah(summary.balance)}*`;

      const top3 = summary.by_category.filter(r => r.type === 'expense').slice(0, 3);
      if (top3.length) {
        msg += `\n\n🏆 *Top Pengeluaran:*\n`;
        top3.forEach((r, i) => { msg += `${i + 1}. ${r.category}: ${formatRupiah(r.total)}\n`; });
      }
      msg += `\nSelamat minggu baru! 🌅`;

      try {
        await botInstance.sendMessage(user.user_id, msg, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`[SCHED] weekly summary gagal ke ${user.user_id}:`, err.message);
      }
    }
    console.log('[SCHED] Weekly summary sent');
  }, { timezone: 'Asia/Jakarta' });
}

// Budget alerts jam 20:00 WIB setiap hari
function scheduleBudgetAlerts() {
  cron.schedule('0 20 * * *', async () => {
    if (!botInstance) return;
    const month = db.currentMonth();
    const budgets = db.getAllBudgetsByMonth(month);

    const alerts = {};
    for (const b of budgets) {
      const spent = db.getSpentInCategory(b.user_id, b.category, month);
      const pct = (spent / b.amount) * 100;
      if (pct >= 80) {
        if (!alerts[b.user_id]) alerts[b.user_id] = [];
        alerts[b.user_id].push({ ...b, spent, pct: Math.round(pct) });
      }
    }

    for (const [userId, items] of Object.entries(alerts)) {
      const lines = items.map(i =>
        `• ${i.category}: ${i.pct}% (${formatRupiah(i.spent)}/${formatRupiah(i.amount)})`
      ).join('\n');

      try {
        await botInstance.sendMessage(userId,
          `⚠️ *Budget Alert!*\n\nKategori berikut mendekati/melebihi budget:\n${lines}`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error(`[SCHED] budget alert gagal ke ${userId}:`, err.message);
      }
    }
  }, { timezone: 'Asia/Jakarta' });
}

function initScheduler(bot) {
  botInstance = bot;
  scheduleDailyReminder();
  scheduleWeeklySummary();
  scheduleBudgetAlerts();
  console.log('[SCHED] All cron jobs initialized');
}

module.exports = { initScheduler };
