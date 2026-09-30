// Monthly recurring bills (kos, Netflix, cicilan) and fixed income. A bill is "paid" for a month once the user
// confirms it; confirming records the transaction. Due dates clamp to short months (31 → 28/29/30).
import db from './connection.js';
import { createTransaction } from './transactions.js';
import { isValidCategory, normalizeCategoryName } from './categories.js';
import { getWallet, defaultWallet } from './wallets.js';
import { getDateStr } from '../utils/formatter.js';

export const MAX_BILLS = 30;

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of the bill's due date in a month "YYYY-MM". */
export function dueDateIn(month, day) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(Math.min(day, daysInMonth(y, m)))}`;
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * The bill's next unpaid due date on or after the start of the current month, and days until then (negative = overdue).
 * @returns {{ due_date: string, month: string, days_until: number, paid_this_month: boolean }}
 */
export function nextDue(bill, today = getDateStr()) {
  const month = today.slice(0, 7);
  const paid = Boolean(bill.last_paid_month && bill.last_paid_month >= month);
  // Next unpaid month: after the latest month marked (which can be ahead when months were skipped or paid early).
  const target = paid ? shiftMonth(bill.last_paid_month > month ? bill.last_paid_month : month, 1) : month;
  const due = dueDateIn(target, bill.day_of_month);
  return { due_date: due, month: target, days_until: dayDiff(today, due), paid_this_month: paid };
}

const shape = (b, today) => b && ({ ...b, active: Boolean(b.active), ...nextDue(b, today) });

/** Active bills with their next due date, soonest first. */
export function listBills(userId, today = getDateStr()) {
  return db.prepare('SELECT * FROM recurring_bills WHERE user_id = ? AND active = 1 ORDER BY id').all(String(userId))
    .map((b) => shape(b, today))
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id);
}

export function getBill(userId, id, today = getDateStr()) {
  return shape(db.prepare('SELECT * FROM recurring_bills WHERE user_id = ? AND id = ?').get(String(userId), Number(id)), today) || null;
}

export function findBillByName(userId, name) {
  const clean = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const rows = listBills(userId);
  return rows.find((b) => b.name.toLowerCase() === clean) || rows.find((b) => b.name.toLowerCase().includes(clean)) || null;
}

/**
 * @param {{ name: string, amount: number, day_of_month: number, type?: 'expense'|'income', category?: string, wallet_id?: number|null }} input
 * @returns {{ bill: Object } | { error: string }}
 */
export function createBill(userId, { name, amount, day_of_month, type = 'expense', category = null, wallet_id = null }) {
  const uid = String(userId);
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!cleanName) return { error: 'Nama tagihan wajib diisi' };
  if (!Number.isInteger(amount) || amount < 1 || amount > 999999999) return { error: 'Nominal tagihan tidak valid' };
  if (!Number.isInteger(day_of_month) || day_of_month < 1 || day_of_month > 31) return { error: 'Tanggal harus 1–31' };
  const txType = type === 'income' ? 'income' : 'expense';
  const cat = normalizeCategoryName(category) && isValidCategory(uid, txType, normalizeCategoryName(category))
    ? normalizeCategoryName(category)
    : txType === 'income' ? 'gaji' : 'tagihan';
  const wallet = wallet_id && getWallet(uid, wallet_id) ? wallet_id : null;
  const count = db.prepare('SELECT COUNT(*) AS n FROM recurring_bills WHERE user_id = ? AND active = 1').get(uid).n;
  if (count >= MAX_BILLS) return { error: `Maksimal ${MAX_BILLS} tagihan rutin` };
  const existing = db.prepare('SELECT id FROM recurring_bills WHERE user_id = ? AND active = 1 AND lower(name) = lower(?)').get(uid, cleanName);
  if (existing) {
    db.prepare('UPDATE recurring_bills SET amount = ?, day_of_month = ?, type = ?, category = ?, wallet_id = ? WHERE id = ?')
      .run(amount, day_of_month, txType, cat, wallet, existing.id);
    return { bill: getBill(uid, existing.id), updated: true };
  }
  // A due date already past this month is assumed handled, so a new bill doesn't start out "overdue".
  const today = getDateStr();
  const month = today.slice(0, 7);
  const lastPaid = dueDateIn(month, day_of_month) < today ? month : null;
  const result = db.prepare(`
    INSERT INTO recurring_bills (user_id, name, amount, type, category, day_of_month, wallet_id, last_paid_month) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uid, cleanName, amount, txType, cat, day_of_month, wallet, lastPaid);
  return { bill: getBill(uid, Number(result.lastInsertRowid)) };
}

/** @returns {{ bill: Object } | { error: string }} */
export function updateBill(userId, id, changes = {}) {
  const uid = String(userId);
  const bill = getBill(uid, id);
  if (!bill || !bill.active) return { error: 'Tagihan tidak ditemukan' };
  const next = { ...bill };
  if ('name' in changes) {
    const n = String(changes.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!n) return { error: 'Nama tagihan wajib diisi' };
    next.name = n;
  }
  if ('amount' in changes) {
    if (!Number.isInteger(changes.amount) || changes.amount < 1 || changes.amount > 999999999) return { error: 'Nominal tagihan tidak valid' };
    next.amount = changes.amount;
  }
  if ('day_of_month' in changes) {
    if (!Number.isInteger(changes.day_of_month) || changes.day_of_month < 1 || changes.day_of_month > 31) return { error: 'Tanggal harus 1–31' };
    next.day_of_month = changes.day_of_month;
  }
  if ('wallet_id' in changes) next.wallet_id = changes.wallet_id && getWallet(uid, changes.wallet_id) ? changes.wallet_id : null;
  db.prepare('UPDATE recurring_bills SET name = ?, amount = ?, day_of_month = ?, wallet_id = ? WHERE id = ? AND user_id = ?')
    .run(next.name, next.amount, next.day_of_month, next.wallet_id, bill.id, uid);
  return { bill: getBill(uid, bill.id) };
}

export function deleteBill(userId, id) {
  return db.prepare('UPDATE recurring_bills SET active = 0 WHERE id = ? AND user_id = ? AND active = 1').run(Number(id), String(userId)).changes > 0;
}

/**
 * Confirms a bill for a month: records the transaction (unless `record` is false) and marks it paid.
 * Paying the same month twice is refused, so a double tap never records twice.
 * @returns {{ bill: Object, tx: Object|null } | { error: string }}
 */
export function payBill(userId, id, month, { record = true } = {}) {
  const uid = String(userId);
  const bill = getBill(uid, id);
  if (!bill || !bill.active) return { error: 'Tagihan tidak ditemukan' };
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'Bulan tidak valid' };
  const claimed = db.prepare(`
    UPDATE recurring_bills SET last_paid_month = ? WHERE id = ? AND user_id = ? AND (last_paid_month IS NULL OR last_paid_month < ?)
  `).run(month, bill.id, uid, month).changes > 0;
  if (!claimed) return { error: `${bill.name} bulan ini sudah ditandai` };
  let tx = null;
  if (record) {
    const category = isValidCategory(uid, bill.type, bill.category) ? bill.category : bill.type === 'income' ? 'lainnya' : 'tagihan';
    const wallet = bill.wallet_id && getWallet(uid, bill.wallet_id) ? bill.wallet_id : defaultWallet(uid)?.id ?? null;
    tx = createTransaction(uid, bill.type, bill.amount, category, bill.name, wallet);
  }
  return { bill: getBill(uid, bill.id), tx };
}

/**
 * Unpaid expense bills due before `untilDate` (overdue ones included) — money to set aside before payday.
 * @returns {{ total: number, bills: Array<Object> }}
 */
export function upcomingUnpaid(userId, untilDate, today = getDateStr()) {
  const bills = listBills(userId, today).filter((b) => b.type === 'expense' && !b.paid_this_month && b.due_date < untilDate);
  return { total: bills.reduce((s, b) => s + b.amount, 0), bills };
}

/** Marks a nudge as sent; false when it was already sent (so callers send each nudge once). */
export function claimNudge(userId, date, kind) {
  return db.prepare('INSERT OR IGNORE INTO nudge_log (user_id, date, kind) VALUES (?, ?, ?)').run(String(userId), date, kind).changes > 0;
}
