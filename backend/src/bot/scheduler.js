import cron from 'node-cron';
import { getAllUsers } from '../db/users.js';
import { getAccess, hasAccess, aiDailyLimit, countAiCallsToday, recordAiUsage } from '../db/subscriptions.js';
import { getMemory } from '../db/memory.js';
import { getAiConfig, writeWeeklyReport } from '../ai/interpreter.js';
import { buildUserContext } from '../ai/context.js';
import { getUsersWithoutTransactionToday, markReminded } from '../db/reminders.js';
import { getBudgetsByUser } from '../db/budgets.js';
import { getStartOfWeek, formatRupiah, getMonthStr, getDateStr } from '../utils/formatter.js';
import { getStatsByCategory } from '../db/transactions.js';
import { safeSendMessage } from '../utils/telegram.js';
import { logger } from '../api/server.js';

const TIMEZONE = process.env.TIMEZONE || 'Asia/Jakarta';

/**
 * Initializes and starts all background cron tasks.
 * @param {any} bot
 */
export function startScheduler(bot) {
  logger.info(`[Scheduler] Initializing cron jobs with timezone ${TIMEZONE}`);

  // ── 1. Daily Reminder: Every day at 21:00 WIB ───────────────────────────
  cron.schedule(
    '0 21 * * *',
    async () => {
      logger.info('[Scheduler] Running daily reminder job (21:00 WIB)...');
      try {
        const todayStr = getDateStr();
        const inactiveUsers = getUsersWithoutTransactionToday(todayStr);

        for (const user of inactiveUsers) {
          if (!hasAccess(user.user_id)) continue;
          const name = user.first_name || 'Kak';
          const text = `🔔 *Pengingat Keuangan Harian*

Halo ${name}! Kamu belum mencatat transaksi keuangan hari ini.

Yuk catat pengeluaran atau pemasukanmu hari ini agar keuangan tetap terkontrol:
• Ketik \`/catat <jumlah> <kategori> [catatan]\`
• Atau buka Mini App di menu bawah 📱`;

          try {
            await safeSendMessage(bot, user.user_id, text, { parse_mode: 'Markdown' });
            markReminded(user.user_id, todayStr);
          } catch (err) {
            logger.warn({ userId: user.user_id, err: err.message }, 'Failed to send daily reminder');
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, 'Daily reminder job error');
      }
    },
    { timezone: TIMEZONE }
  );

  // ── 2. Weekly Summary: Every Monday at 09:00 WIB ─────────────────────────
  cron.schedule(
    '0 9 * * 1',
    async () => {
      logger.info('[Scheduler] Running weekly summary job (Monday 09:00 WIB)...');
      try {
        const users = getAllUsers().filter((u) => getAccess(u).allowed);
        const now = new Date();
        for (const user of users) {
          const report = await buildWeeklyReport(user, now);
          if (!report) continue; // No activity last week
          try {
            await safeSendMessage(bot, user.user_id, report.text, report.options);
          } catch (err) {
            logger.warn({ userId: user.user_id, err: err.message }, 'Failed to send weekly report');
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, 'Weekly summary job error');
      }
    },
    { timezone: TIMEZONE }
  );

  // ── 3. Daily Budget Alert: Every day at 20:00 WIB ────────────────────────
  cron.schedule(
    '0 20 * * *',
    async () => {
      logger.info('[Scheduler] Running budget alert check (20:00 WIB)...');
      try {
        const users = getAllUsers().filter((u) => getAccess(u).allowed);
        const currentMonth = getMonthStr();

        for (const user of users) {
          const budgets = getBudgetsByUser(user.user_id, currentMonth);

          for (const b of budgets) {
            const pct = b.percentage || 0;
            if (pct >= 80) {
              const catName = b.category.charAt(0).toUpperCase() + b.category.slice(1);
              const statusIcon = pct >= 100 ? '🚨 *BUDGET MELEBIHI BATAS!*' : '⚠️ *PERINGATAN BUDGET (≥80%)*';

              const text = `${statusIcon}

Kategori: *${catName}*
Batas Budget: ${formatRupiah(b.amount)}
Terpakai: ${formatRupiah(b.spent)} (*${pct}%*)
Sisa: ${formatRupiah(b.remaining)}

Mohon kurangi pengeluaran kategori ini agar target keuangan tetap aman.`;

              try {
                await safeSendMessage(bot, user.user_id, text, { parse_mode: 'Markdown' });
              } catch (err) {
                logger.warn({ userId: user.user_id, err: err.message }, 'Failed to send budget alert');
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, 'Budget alert job error');
      }
    },
    { timezone: TIMEZONE }
  );
}

/**
 * Weekly report for one user: written by the assistant (personal, with insights) when AI is available and the
 * user has quota left, otherwise the fixed template. Returns null when the user had no transactions last week.
 * @returns {Promise<{ text: string, options: Object } | null>}
 */
export async function buildWeeklyReport(user, now = new Date(), { fetchImpl } = {}) {
  const startStr = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const endStr = now.toISOString().slice(0, 19).replace('T', ' ');
  const stats = getStatsByCategory(user.user_id, startStr, endStr);
  if (stats.length === 0) return null;

  let income = 0;
  let expense = 0;
  let count = 0;
  for (const s of stats) {
    if (s.type === 'income') income += Number(s.total);
    if (s.type === 'expense') expense += Number(s.total);
    count += Number(s.count);
  }
  const topCategories = stats
    .slice(0, 3)
    .map((c) => `• ${c.category.charAt(0).toUpperCase() + c.category.slice(1)}: ${formatRupiah(c.total)}`)
    .join('\n');

  if (getAiConfig() && countAiCallsToday(user.user_id) < aiDailyLimit(user)) {
    const week = [
      `Pemasukan ${formatRupiah(income)}, pengeluaran ${formatRupiah(expense)}, saldo ${income - expense < 0 ? '-' : ''}${formatRupiah(income - expense)}, ${count} transaksi`,
      `Per kategori: ${stats.map((c) => `${c.type === 'income' ? 'masuk' : 'keluar'} ${c.category} ${formatRupiah(c.total)}`).join('; ')}`
    ].join('\n');
    const text = await writeWeeklyReport(
      { context: buildUserContext(user.user_id, { first_name: user.first_name }, now), week },
      { fetchImpl, logger, onUsage: (usage) => recordAiUsage({ user_id: user.user_id, ...usage }) }
    );
    if (text) return { text: `📊 Laporan Mingguan\n\n${text}`, options: {} };
  }

  // Escape legacy-Markdown characters so names like "budi_s" don't break the message.
  const name = String(getMemory(user.user_id).nickname || user.first_name || 'Kak').replace(/([_*`\[])/g, '\\$1');
  const text = `📊 *Laporan Keuangan Mingguan*

Selamat pagi, ${name}! Berikut ringkasan transaksi 7 hari terakhir:

💰 Pemasukan: ${formatRupiah(income)}
💸 Pengeluaran: ${formatRupiah(expense)}
⚖️ Saldo Bersih: ${income - expense < 0 ? '-' : ''}${formatRupiah(income - expense)}
📝 Total Transaksi: ${count}

*Top Kategori:*
${topCategories}

Ketik /minggu atau buka Mini App untuk detail lebih lengkap! ✨`;
  return { text, options: { parse_mode: 'Markdown' } };
}
