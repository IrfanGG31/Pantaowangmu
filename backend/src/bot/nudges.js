// Personal nudges run by the scheduler: the daily reminder at the user's own time, the optional "smart" nudge at the
// hour the user usually spends, and recurring-bill reminders (H-1, due day with "paid" buttons, 3 days late).
// Each nudge is recorded before sending, so a user gets it at most once.
import db from '../db/connection.js';
import { getAllUsers, getUser } from '../db/users.js';
import { getAccess } from '../db/subscriptions.js';
import { getMemory, DEFAULT_REMINDER_TIME } from '../db/memory.js';
import { getUsersWithoutTransactionToday, markReminded } from '../db/reminders.js';
import { listBills, claimNudge } from '../db/bills.js';
import { formatRupiah, getDateStr, getDayRange, getTimeZone, toDate, toSqlDateTime } from '../utils/formatter.js';
import { safeSendMessage } from '../utils/telegram.js';

export const TICK_MINUTES = 5;
const DAY_MS = 86400000;

/** Minutes since local midnight in TIMEZONE. */
export function localMinutes(now = new Date()) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: getTimeZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(now).split(':').map(Number);
  return h * 60 + m;
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** True when `target` minutes fall in the tick window that ends now: (now − TICK_MINUTES, now]. */
export function inWindow(target, nowMinutes, width = TICK_MINUTES) {
  return nowMinutes >= target && nowMinutes - target < width;
}

/**
 * The local hour the user most often records spending (last 30 days), or null without a clear habit
 * (fewer than 8 expenses, or no hour with at least a quarter of them).
 */
export function habitHour(userId, now = new Date()) {
  const rows = db.prepare(`
    SELECT created_at FROM transactions
    WHERE user_id = ? AND type = 'expense' AND datetime(created_at) >= datetime(?)
  `).all(String(userId), toSqlDateTime(new Date(now.getTime() - 30 * DAY_MS)));
  if (rows.length < 8) return null;
  const counts = new Array(24).fill(0);
  for (const r of rows) counts[Math.floor(localMinutes(toDate(r.created_at)) / 60)] += 1;
  const max = Math.max(...counts);
  return max / rows.length >= 0.25 ? counts.indexOf(max) : null;
}

function spentSince(userId, fromUtc) {
  return Boolean(db.prepare(`
    SELECT 1 FROM transactions WHERE user_id = ? AND type = 'expense' AND datetime(created_at) >= datetime(?) LIMIT 1
  `).get(String(userId), fromUtc));
}

const REMINDER_TEXT = (name) => `🔔 *Pengingat Keuangan Harian*

Halo ${name}! Kamu belum mencatat transaksi keuangan hari ini.

Yuk catat pengeluaran atau pemasukanmu hari ini agar keuangan tetap terkontrol:
• Ketik saja, misalnya \`makan siang 25rb\`
• Atau buka Mini App di menu bawah 📱

_Ubah jam atau matikan: /pengingat_`;

/**
 * Daily reminder (at each user's reminder_time, default 21:00) and smart habit nudges. Run every TICK_MINUTES.
 * @returns {Promise<{ reminders: number, nudges: number }>}
 */
export async function runReminderTick(bot, now = new Date()) {
  const today = getDateStr(now);
  const minutes = localMinutes(now);
  const inactive = new Set(getUsersWithoutTransactionToday(today).map((u) => u.user_id));
  let reminders = 0;
  let nudges = 0;

  for (const user of getAllUsers()) {
    if (!getAccess(user, now).allowed) continue;
    const { profile, nickname } = getMemory(user.user_id);
    const name = String(nickname || user.first_name || 'Kak').replace(/([_*`\[])/g, '\\$1');

    const time = profile.reminder_time || DEFAULT_REMINDER_TIME;
    if (time !== 'off' && inactive.has(user.user_id) && inWindow(toMinutes(time), minutes) && markReminded(user.user_id, today)) {
      await safeSendMessage(bot, user.user_id, REMINDER_TEXT(name), { parse_mode: 'Markdown' });
      reminders += 1;
    }

    if (profile.smart_nudge) {
      const hour = habitHour(user.user_id, now);
      if (hour !== null && hour < 23 && inWindow((hour + 1) * 60, minutes)) {
        const habitStart = toSqlDateTime(new Date(toDate(getDayRange(today).start).getTime() + hour * 3600000));
        if (!spentSince(user.user_id, habitStart) && claimNudge(user.user_id, today, 'habit')) {
          await safeSendMessage(bot, user.user_id,
            `👋 Biasanya sekitar jam ${String(hour).padStart(2, '0')}.00 kamu ada pengeluaran. Tadi beli apa? Ketik saja, misalnya "makan siang 25rb".\n\nMatikan: /pengingat`);
          nudges += 1;
        }
      }
    }
  }
  return { reminders, nudges };
}

/**
 * Bill reminders, run once a day: H-1, the due day (with "paid"/"skip" buttons) and 3 days late.
 * @returns {Promise<number>} messages sent
 */
export async function runBillTick(bot, now = new Date()) {
  const today = getDateStr(now);
  let sent = 0;
  const users = db.prepare('SELECT DISTINCT user_id FROM recurring_bills WHERE active = 1').all().map((r) => r.user_id);
  for (const userId of users) {
    const user = getUser(userId);
    if (!user || !getAccess(user, now).allowed) continue;
    for (const bill of listBills(userId, today)) {
      if (bill.paid_this_month) continue;
      const verb = bill.type === 'income' ? 'diterima' : 'dibayar';
      let text = null;
      let kind = null;
      if (bill.days_until === 1) {
        kind = 'h1';
        text = `📅 Besok ${bill.name} ${formatRupiah(bill.amount)} jatuh tempo.`;
      } else if (bill.days_until === 0) {
        kind = 'h0';
        text = `📅 Hari ini ${bill.name} ${formatRupiah(bill.amount)} jatuh tempo. Sudah ${verb}?`;
      } else if (bill.days_until === -3) {
        kind = 'late';
        text = `⚠️ ${bill.name} ${formatRupiah(bill.amount)} (tgl ${bill.day_of_month}) belum ditandai. Sudah ${verb}?`;
      }
      if (!kind || !claimNudge(userId, today, `bill-${kind}:${bill.id}:${bill.month}`)) continue;
      const keyboard = kind === 'h1' ? undefined : {
        inline_keyboard: [[
          { text: `✅ Sudah ${verb}`, callback_data: `bp:${bill.id}:${bill.month}` },
          { text: '⏭️ Lewati bulan ini', callback_data: `bs:${bill.id}:${bill.month}` }
        ]]
      };
      await safeSendMessage(bot, userId, text, keyboard ? { reply_markup: keyboard } : {});
      sent += 1;
    }
  }
  return sent;
}
