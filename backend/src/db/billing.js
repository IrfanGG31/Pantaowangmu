// Plans, activation codes, payments and expiry notices. Money is stored as integer rupiah.
import crypto from 'node:crypto';
import db from './connection.js';
import { getUser } from './users.js';
import { getPlan } from './subscriptions.js';
import { toDate, toSqlDateTime } from '../utils/formatter.js';

const DAY_MS = 86400000;
const MAX_MONEY = 999999999;

// ── Plans ────────────────────────────────────────────────────────────────

export function listPlans({ includeInactive = false } = {}) {
  const rows = db.prepare('SELECT * FROM plans ORDER BY created_at ASC, id ASC').all();
  return includeInactive ? rows : rows.filter((p) => p.active);
}

const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/**
 * Creates (when `create`) or updates a plan. Only the given fields change on update.
 * @returns {{ plan: Object } | { error: string }}
 */
export function savePlan(input, { create = false } = {}) {
  const id = String(input.id || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,20}$/.test(id) || id === 'trial' || id === 'free') return { error: 'ID paket 2–20 huruf kecil/angka, bukan "trial" atau "free"' };
  const existing = getPlan(id);
  if (create && existing) return { error: 'ID paket sudah dipakai' };
  if (!create && !existing) return { error: 'Paket tidak ditemukan' };

  const next = { ...(existing || { name: '', price: null, period_days: 30, ai_daily_limit: 100, receipt_monthly_limit: 100, active: 1 }) };
  if (input.name !== undefined) {
    const name = String(input.name).trim().slice(0, 40);
    if (!name) return { error: 'Nama paket wajib diisi' };
    next.name = name;
  }
  if (input.price !== undefined) {
    if (input.price !== null && !intIn(input.price, 0, MAX_MONEY)) return { error: 'Harga harus bilangan bulat 0–999.999.999' };
    next.price = input.price;
  }
  if (input.period_days !== undefined) {
    if (!intIn(input.period_days, 1, 3650)) return { error: 'Periode 1–3650 hari' };
    next.period_days = input.period_days;
  }
  if (input.ai_daily_limit !== undefined) {
    if (!intIn(input.ai_daily_limit, 0, 10000)) return { error: 'Kuota AI 0–10000 per hari' };
    next.ai_daily_limit = input.ai_daily_limit;
  }
  if (input.receipt_monthly_limit !== undefined) {
    if (!intIn(input.receipt_monthly_limit, 0, 10000)) return { error: 'Kuota foto nota 0–10000 per bulan' };
    next.receipt_monthly_limit = input.receipt_monthly_limit;
  }
  if (input.active !== undefined) next.active = input.active ? 1 : 0;
  if (!next.name) return { error: 'Nama paket wajib diisi' };

  if (create) {
    db.prepare('INSERT INTO plans (id, name, price, period_days, ai_daily_limit, receipt_monthly_limit, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, next.name, next.price, next.period_days, next.ai_daily_limit, next.receipt_monthly_limit, next.active);
  } else {
    db.prepare('UPDATE plans SET name = ?, price = ?, period_days = ?, ai_daily_limit = ?, receipt_monthly_limit = ?, active = ? WHERE id = ?')
      .run(next.name, next.price, next.period_days, next.ai_daily_limit, next.receipt_monthly_limit, next.active, id);
  }
  return { plan: getPlan(id) };
}

// ── Settings ─────────────────────────────────────────────────────────────

export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value === null ? null : String(value));
}

// ── Activation ───────────────────────────────────────────────────────────

/**
 * Puts the user on `planId` for `days` more days, stacking on any time they still have left,
 * and records the payment. Users with no expiry (granted "unlimited" by an admin) keep no expiry.
 * @returns {{ user: Object, payment: Object } | { error: string }}
 */
export function grantPlan(userId, planId, days, { method, amount = 0, reference = null, by = null } = {}, now = new Date()) {
  const user = getUser(userId);
  if (!user) return { error: 'User tidak ditemukan' };
  const plan = getPlan(planId);
  if (!plan) return { error: 'Paket tidak ditemukan' };
  if (!intIn(days, 1, 3650)) return { error: 'Durasi 1–3650 hari' };
  if (!intIn(amount, 0, MAX_MONEY)) return { error: 'Nominal tidak valid' };
  if (!['voucher', 'manual'].includes(method)) return { error: 'Metode tidak valid' };

  let periodEnd = null;
  if (user.plan_expires_at) {
    const current = toDate(user.plan_expires_at);
    const base = current > now ? current : now;
    periodEnd = toSqlDateTime(new Date(base.getTime() + days * DAY_MS));
  }

  db.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE user_id = ?').run(plan.id, periodEnd, user.user_id);
  const result = db.prepare(`
    INSERT INTO payments (user_id, plan_id, amount, method, reference, days, period_end, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user.user_id, plan.id, amount, method, reference, days, periodEnd, by);

  return {
    user: getUser(user.user_id),
    payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(result.lastInsertRowid))
  };
}

// ── Vouchers ─────────────────────────────────────────────────────────────

// No 0/O, 1/I/L: codes are read aloud and typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `PANTA-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

/**
 * Creates `count` codes for a plan.
 * @returns {{ codes: string[] } | { error: string }}
 */
export function createVouchers({ plan_id, days, price, max_uses = 1, count = 1, expires_in_days = null, note = '' }, by, now = new Date()) {
  const plan = getPlan(plan_id);
  if (!plan) return { error: 'Paket tidak ditemukan' };
  const d = days === undefined || days === null ? plan.period_days : days;
  const p = price === undefined || price === null ? (plan.price ?? 0) : price;
  if (!intIn(d, 1, 3650)) return { error: 'Durasi 1–3650 hari' };
  if (!intIn(p, 0, MAX_MONEY)) return { error: 'Harga tidak valid' };
  if (!intIn(max_uses, 1, 10000)) return { error: 'Maksimal pemakaian 1–10000' };
  if (!intIn(count, 1, 100)) return { error: 'Jumlah kode 1–100' };
  if (expires_in_days !== null && !intIn(expires_in_days, 1, 3650)) return { error: 'Masa berlaku kode 1–3650 hari' };

  const expiresAt = expires_in_days ? toSqlDateTime(new Date(now.getTime() + expires_in_days * DAY_MS)) : null;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO vouchers (code, plan_id, days, price, max_uses, expires_at, note, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const codes = [];
  while (codes.length < count) {
    const code = randomCode();
    if (insert.run(code, plan.id, d, p, max_uses, expiresAt, String(note || '').slice(0, 100), by).changes) codes.push(code);
  }
  return { codes };
}

export function listVouchers({ limit = 100 } = {}) {
  return db.prepare(`
    SELECT v.*, p.name AS plan_name FROM vouchers v LEFT JOIN plans p ON p.id = v.plan_id
    ORDER BY v.created_at DESC, v.code ASC LIMIT ?
  `).all(limit);
}

export function setVoucherDisabled(code, disabled) {
  return db.prepare('UPDATE vouchers SET disabled = ? WHERE code = ?').run(disabled ? 1 : 0, normalizeCode(code)).changes > 0;
}

/**
 * Redeems an activation code for the user.
 * @returns {{ user: Object, payment: Object, plan: Object } | { error: string }}
 */
export function redeemVoucher(userId, rawCode, now = new Date()) {
  const code = normalizeCode(rawCode);
  const v = code ? db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code) : null;
  if (!v || v.disabled) return { error: 'Kode tidak ditemukan. Periksa lagi penulisannya.' };
  if (v.expires_at && toDate(v.expires_at) <= now) return { error: 'Kode ini sudah kedaluwarsa.' };
  if (v.used_count >= v.max_uses) return { error: 'Kode ini sudah habis dipakai.' };
  if (db.prepare('SELECT 1 FROM voucher_redemptions WHERE code = ? AND user_id = ?').get(code, String(userId))) {
    return { error: 'Kode ini sudah pernah kamu pakai.' };
  }

  const granted = grantPlan(userId, v.plan_id, v.days, { method: 'voucher', amount: v.price, reference: code, by: 'user' }, now);
  if (granted.error) return granted;
  db.prepare('UPDATE vouchers SET used_count = used_count + 1 WHERE code = ?').run(code);
  db.prepare('INSERT INTO voucher_redemptions (code, user_id) VALUES (?, ?)').run(code, String(userId));
  return { ...granted, plan: getPlan(v.plan_id) };
}

// ── Payments ─────────────────────────────────────────────────────────────

export function listPayments({ limit = 50 } = {}) {
  return db.prepare(`
    SELECT pay.*, u.first_name, u.username, p.name AS plan_name
    FROM payments pay LEFT JOIN users u ON u.user_id = pay.user_id LEFT JOIN plans p ON p.id = pay.plan_id
    ORDER BY pay.id DESC LIMIT ?
  `).all(limit);
}

/**
 * @returns {{ amount: number, count: number }}
 */
export function revenueBetween(start, end) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count FROM payments
    WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
  `).get(start, end);
  return { amount: Number(row.amount), count: Number(row.count) };
}

// ── Expiry notices ───────────────────────────────────────────────────────

/**
 * Users who should get an expiry reminder now: 3 days before ('h3'), 1 day before ('h1'),
 * and just after expiring ('expired', only within 3 days so old accounts aren't spammed).
 * Each (user, kind, expiry) is returned once: calling this marks it as sent.
 * @returns {Array<{ user: Object, kind: 'h3'|'h1'|'expired' }>}
 */
export function takeDueNotices(now = new Date()) {
  const rows = db.prepare(`
    SELECT * FROM users WHERE status = 'active' AND plan_expires_at IS NOT NULL
      AND datetime(plan_expires_at) > datetime(?) AND datetime(plan_expires_at) <= datetime(?)
  `).all(toSqlDateTime(new Date(now.getTime() - 3 * DAY_MS)), toSqlDateTime(new Date(now.getTime() + 3 * DAY_MS)));

  const mark = db.prepare('INSERT OR IGNORE INTO subscription_notices (user_id, kind, expires_at) VALUES (?, ?, ?)');
  const due = [];
  for (const user of rows) {
    const left = toDate(user.plan_expires_at).getTime() - now.getTime();
    const kind = left <= 0 ? 'expired' : left <= DAY_MS ? 'h1' : 'h3';
    if (mark.run(user.user_id, kind, user.plan_expires_at).changes) due.push({ user, kind });
  }
  return due;
}
