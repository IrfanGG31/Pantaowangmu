// /reset: removes a user's financial data in one go, keeping a copy for UNDO_DAYS so it can be restored.
// Account, subscription, nickname, preferences, custom categories and learned keywords are never touched.
import db from './connection.js';
import { getMonthRange, getMonthStr, toSqlDateTime } from '../utils/formatter.js';

export const UNDO_DAYS = 7;
const DAY_MS = 86400000;

export const RESET_SCOPES = {
  month: 'Transaksi bulan ini',
  transactions: 'Semua transaksi',
  everything: 'Semua data keuangan'
};

// Tables cleared by "everything". Order matters for restore only cosmetically (no foreign keys between them).
const FINANCE_TABLES = ['wallets', 'wallet_transfers', 'transactions', 'budgets', 'recurring_bills', 'debts', 'challenges', 'user_goals'];
export const TABLE_LABELS = {
  transactions: 'transaksi', budgets: 'budget', wallets: 'dompet', wallet_transfers: 'transfer antar-dompet',
  recurring_bills: 'tagihan rutin', debts: 'catatan utang-piutang', challenges: 'tantangan', user_goals: 'target tabungan'
};

/** @returns {Array<{ table: string, where: string, params: unknown[] }>} */
function selection(userId, scope, now) {
  const uid = String(userId);
  if (scope === 'month') {
    const { start, end } = getMonthRange(getMonthStr(now));
    return [{ table: 'transactions', where: 'user_id = ? AND created_at >= ? AND created_at < ?', params: [uid, start, end] }];
  }
  if (scope === 'transactions') return [{ table: 'transactions', where: 'user_id = ?', params: [uid] }];
  if (scope === 'everything') return FINANCE_TABLES.map((table) => ({ table, where: 'user_id = ?', params: [uid] }));
  return [];
}

/** What a reset would remove. @returns {{ scope, label, counts: Record<string, number>, total: number } | null} */
export function previewReset(userId, scope, now = new Date()) {
  if (!RESET_SCOPES[scope]) return null;
  const counts = {};
  for (const s of selection(userId, scope, now)) {
    const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${s.table} WHERE ${s.where}`).get(...s.params).n);
    if (n) counts[s.table] = n;
  }
  return { scope, label: RESET_SCOPES[scope], counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

/**
 * Removes the data and keeps a copy of every row for UNDO_DAYS. Runs in one SQLite transaction.
 * @returns {{ id: number, counts: Record<string, number>, total: number, undo_until: string } | null}
 */
export function performReset(userId, scope, now = new Date()) {
  if (!RESET_SCOPES[scope]) return null;
  const undoUntil = toSqlDateTime(new Date(now.getTime() + UNDO_DAYS * DAY_MS));
  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO resets (user_id, scope, created_at, undo_until) VALUES (?, ?, ?, ?)')
      .run(String(userId), scope, toSqlDateTime(now), undoUntil);
    const id = Number(lastInsertRowid);
    const keep = db.prepare('INSERT INTO reset_backups (reset_id, table_name, row_json) VALUES (?, ?, ?)');
    const counts = {};
    for (const s of selection(userId, scope, now)) {
      const rows = db.prepare(`SELECT * FROM ${s.table} WHERE ${s.where}`).all(...s.params);
      if (!rows.length) continue;
      for (const row of rows) keep.run(id, s.table, JSON.stringify(row));
      db.prepare(`DELETE FROM ${s.table} WHERE ${s.where}`).run(...s.params);
      counts[s.table] = rows.length;
    }
    db.prepare('UPDATE resets SET counts = ? WHERE id = ?').run(JSON.stringify(counts), id);
    db.exec('COMMIT');
    return { id, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), undo_until: undoUntil };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** The user's most recent reset that can still be undone. */
export function latestUndoableReset(userId, now = new Date()) {
  const row = db.prepare(`
    SELECT id, scope, counts, created_at, undo_until FROM resets
    WHERE user_id = ? AND undone_at IS NULL AND purged_at IS NULL AND undo_until > ?
    ORDER BY id DESC LIMIT 1
  `).get(String(userId), toSqlDateTime(now));
  return row ? { ...row, counts: JSON.parse(row.counts || '{}') } : null;
}

/**
 * Puts the rows of the latest reset back (same ids). Rows whose id is taken again are skipped.
 * @returns {{ scope: string, restored: Record<string, number>, total: number } | null}
 */
export function undoLastReset(userId, now = new Date()) {
  const reset = latestUndoableReset(userId, now);
  if (!reset) return null;
  const restored = {};
  const uid = String(userId);
  // A wallet made again after the reset (same name) takes the old one's place, so restored rows point to it.
  const walletIds = new Map();
  const remap = (id) => (id == null ? id : walletIds.get(Number(id)) ?? id);
  db.exec('BEGIN');
  try {
    // Backups are stored in FINANCE_TABLES order, so wallets come back before the rows that refer to them.
    for (const { table_name: table, row_json: json } of db.prepare('SELECT table_name, row_json FROM reset_backups WHERE reset_id = ? ORDER BY id').all(reset.id)) {
      if (!FINANCE_TABLES.includes(table)) continue;
      const row = JSON.parse(json);
      if (table === 'wallets') {
        const same = db.prepare('SELECT id FROM wallets WHERE user_id = ? AND lower(name) = lower(?)').get(uid, row.name);
        if (same) {
          walletIds.set(Number(row.id), Number(same.id));
          continue;
        }
        if (row.is_default && db.prepare('SELECT 1 FROM wallets WHERE user_id = ? AND is_default = 1').get(uid)) row.is_default = 0;
      }
      if ('wallet_id' in row) row.wallet_id = remap(row.wallet_id);
      if ('from_wallet_id' in row) row.from_wallet_id = remap(row.from_wallet_id);
      if ('to_wallet_id' in row) row.to_wallet_id = remap(row.to_wallet_id);
      const cols = Object.keys(row);
      const result = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
      if (result.changes) restored[table] = (restored[table] || 0) + 1;
    }
    db.prepare('DELETE FROM reset_backups WHERE reset_id = ?').run(reset.id);
    db.prepare('UPDATE resets SET undone_at = ? WHERE id = ?').run(toSqlDateTime(now), reset.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { scope: reset.scope, restored, total: Object.values(restored).reduce((a, b) => a + b, 0) };
}

/** Deletes the kept copies once the undo window has passed. @returns {number} resets purged */
export function purgeExpiredResets(now = new Date()) {
  const expired = db.prepare('SELECT id FROM resets WHERE purged_at IS NULL AND undone_at IS NULL AND undo_until <= ?').all(toSqlDateTime(now));
  for (const { id } of expired) {
    db.prepare('DELETE FROM reset_backups WHERE reset_id = ?').run(id);
    db.prepare('UPDATE resets SET purged_at = ? WHERE id = ?').run(toSqlDateTime(now), id);
  }
  return expired.length;
}

/** Anonymous counts for the admin dashboard. */
export function resetStats(now = new Date()) {
  const since = (days) => toSqlDateTime(new Date(now.getTime() - days * DAY_MS));
  const count = (days) => Number(db.prepare('SELECT COUNT(*) AS n FROM resets WHERE created_at >= ?').get(since(days)).n);
  const undone = Number(db.prepare('SELECT COUNT(*) AS n FROM resets WHERE created_at >= ? AND undone_at IS NOT NULL').get(since(30)).n);
  return { last_7_days: count(7), last_30_days: count(30), undone_30_days: undone };
}

export const formatResetCounts = (counts) => Object.entries(counts).map(([t, n]) => `${n} ${TABLE_LABELS[t] || t}`).join(', ');
