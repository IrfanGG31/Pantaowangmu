import cron from 'node-cron';
import { getAllUsers } from '../db/users.js';
import { getAccess, getEntitlement, countAiCallsToday, recordAiUsage, TRIAL_PLAN } from '../db/subscriptions.js';
import { takeDueNotices, listPlans } from '../db/billing.js';
import { getMemory } from '../db/memory.js';
import { getAiConfig, writeWeeklyReport } from '../ai/interpreter.js';
import { buildUserContext } from '../ai/context.js';
import { runReminderTick, runBillTick, runDailyTick, TICK_MINUTES } from './nudges.js';
import { getBudgetsByUser } from '../db/budgets.js';
import { getStartOfWeek, formatRupiah, getMonthStr, getDateStr, formatDateShort } from '../utils/formatter.js';
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

  // ── 1. Daily reminder at each user's own time (default 21:00), smart habit nudges ──
  cron.schedule(
    `*/${TICK_MINUTES} * * * *`,
    async () => {
      try {
        const { reminders, nudges } = await runReminderTick(bot);
        if (reminders || nudges) logger.info({ reminders, nudges }, '[Scheduler] Reminders sent');
      } catch (err) {
        logger.error({ err: err.message }, 'Reminder tick error');
      }
    },
    { timezone: TIMEZONE }
  );

  // ── 1c. Challenge results and monthly budget suggestions: every day at 09:00 ──
  cron.schedule(
    '0 9 * * *',
    async () => {
      try {
        const result = await runDailyTick(bot);
        logger.info(result, '[Scheduler] Daily personal nudges');
      } catch (err) {
        logger.error({ err: err.message }, 'Daily nudge job error');
      }
    },
    { timezone: TIMEZONE }
  );

  // ── 1b. Recurring bill reminders: every day at 08:00 ──
  cron.schedule(
    '0 8 * * *',
    async () => {
      try {
        const sent = await runBillTick(bot);
        logger.info({ sent }, '[Scheduler] Bill reminders');
      } catch (err) {
        logger.error({ err: err.message }, 'Bill reminder job error');
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

  // ── Subscription reminders: every day at 10:00 WIB ────────────────────
  cron.schedule(
    '0 10 * * *',
    async () => {
      logger.info('[Scheduler] Running subscription reminders (10:00 WIB)...');
      try {
        await sendSubscriptionNotices(bot);
      } catch (err) {
        logger.error({ err: err.message }, 'Subscription reminder job error');
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

  const entitlement = getEntitlement(user, now);
  if (getAiConfig() && entitlement.ai && countAiCallsToday(user.user_id) < entitlement.ai_daily_limit) {
    const week = [
      `Pemasukan ${formatRupiah(income)}, pengeluaran ${formatRupiah(expense)}, saldo ${income - expense < 0 ? '-' : ''}${formatRupiah(income - expense)}, ${count} transaksi`,
      `Per kategori: ${stats.map((c) => `${c.type === 'income' ? 'masuk' : 'keluar'} ${c.category} ${formatRupiah(c.total)}`).join('; ')}`
    ].join('\n');
    const text = await writeWeeklyReport(
      { context: buildUserContext(user.user_id, { first_name: user.first_name }, now), week },
      { fetchImpl, logger, onUsage: (usage) => recordAiUsage({ user_id: user.user_id, kind: 'weekly', ...usage }) }
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

/**
 * Text for an expiry reminder ('h3' | 'h1') or the notice after a plan ended ('expired').
 */
export function subscriptionNoticeText(user, kind) {
  const plan = user.plan === TRIAL_PLAN ? 'Trial' : listPlans({ includeInactive: true }).find((p) => p.id === user.plan)?.name || user.plan;
  const date = formatDateShort(user.plan_expires_at);
  if (kind === 'expired') {
    return `ℹ️ Paket ${plan} kamu sudah berakhir (${date}).\n\nKamu sekarang di paket Gratis: tetap bisa mencatat transaksi, budget, ringkasan, dan export. Asisten AI dan baca foto nota nonaktif.\n\nAktifkan lagi kapan saja: /langganan`;
  }
  const when = kind === 'h1' ? 'besok' : 'dalam 3 hari';
  return `⏰ Paket ${plan} kamu berakhir ${when} (${date}).\n\nPerpanjang supaya asisten AI dan baca foto nota tetap aktif: /langganan`;
}

/**
 * Sends due expiry reminders once each. Returns how many were sent.
 */
export async function sendSubscriptionNotices(bot, now = new Date()) {
  let sent = 0;
  for (const { user, kind } of takeDueNotices(now)) {
    try {
      await safeSendMessage(bot, user.user_id, subscriptionNoticeText(user, kind));
      sent++;
    } catch (err) {
      logger.warn({ userId: user.user_id, err: err.message }, 'Failed to send subscription reminder');
    }
  }
  return sent;
}
