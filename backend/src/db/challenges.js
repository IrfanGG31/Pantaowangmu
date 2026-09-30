// Personal challenges: no_spend (nothing spent in a category, or at all), limit (spend at most X), streak (log
// something every day). Progress is computed from transactions; the stored status is updated as it resolves.
import db from './connection.js';
import { isValidCategory } from './categories.js';
import { getDateStr, getDayRange, toSqlDateTime } from '../utils/formatter.js';

export const KINDS = ['no_spend', 'limit', 'streak'];
export const MAX_ACTIVE = 3;

const DAY_MS = 86400000;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * @param {{ kind: string, category?: string|null, days?: number, target_amount?: number|null }} input
 * @returns {{ challenge: Object } | { error: string }}
 */
export function startChallenge(userId, { kind, category = null, days = 7, target_amount = null }, now = new Date()) {
  const uid = String(userId);
  if (!KINDS.includes(kind)) return { error: 'Jenis tantangan tidak dikenal' };
  if (!Number.isInteger(days) || days < 1 || days > 90) return { error: 'Lama tantangan 1–90 hari' };
  const cat = kind === 'streak' ? null : category ? String(category).toLowerCase().trim() : null;
  if (cat && !isValidCategory(uid, 'expense', cat)) return { error: `Kategori "${cat}" belum ada` };
  if (kind === 'limit' && !(Number.isInteger(target_amount) && target_amount > 0 && target_amount <= 999999999)) {
    return { error: 'Tantangan hemat butuh batas nominal' };
  }
  const active = listChallenges(uid, {}, now).filter((c) => c.status === 'active');
  if (active.length >= MAX_ACTIVE) return { error: `Maksimal ${MAX_ACTIVE} tantangan aktif sekaligus` };
  const start = getDateStr(now);
  const result = db.prepare(`
    INSERT INTO challenges (user_id, kind, category, target_amount, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)
  `).run(uid, kind, cat, kind === 'limit' ? target_amount : null, start, addDays(start, days - 1));
  return { challenge: getChallenge(uid, Number(result.lastInsertRowid), now) };
}

function spentIn(uid, category, startDate, now) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, MIN(created_at) AS first FROM transactions
    WHERE user_id = ? AND type = 'expense' ${category ? 'AND category = ?' : ''}
      AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?)
  `).get(uid, ...(category ? [category] : []), getDayRange(startDate).start, toSqlDateTime(now));
  return { total: Number(row.total), first: row.first };
}

function loggedDays(uid, startDate, now) {
  const rows = db.prepare(`
    SELECT created_at FROM transactions WHERE user_id = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?)
  `).all(uid, getDayRange(startDate).start, toSqlDateTime(now));
  return new Set(rows.map((r) => getDateStr(r.created_at)));
}

/** Progress for one challenge row: { days_total, days_elapsed, spent, logged_days, status, ok } */
export function challengeProgress(c, now = new Date()) {
  const today = getDateStr(now);
  const daysTotal = dayDiff(c.start_date, c.end_date) + 1;
  const daysElapsed = Math.max(0, Math.min(daysTotal, dayDiff(c.start_date, today) + 1));
  const ended = today > c.end_date;
  let status = c.status;
  let spent = 0;
  let logged = 0;
  if (status === 'active' || status === 'done' || status === 'failed') {
    if (c.kind === 'streak') {
      const days = loggedDays(c.user_id, c.start_date, now);
      logged = [...days].filter((d) => d <= c.end_date).length;
      // Every finished day must have an entry; today can still be filled in.
      const lastToCheck = ended ? c.end_date : addDays(today, -1);
      let missed = false;
      for (let d = c.start_date; d <= lastToCheck; d = addDays(d, 1)) if (!days.has(d)) { missed = true; break; }
      if (status === 'active') status = missed ? 'failed' : ended ? 'done' : 'active';
    } else {
      const s = spentIn(c.user_id, c.category, c.start_date, ended ? new Date(Date.parse(getDayRange(c.end_date).end.replace(' ', 'T') + 'Z') - 1000) : now);
      spent = s.total;
      const broken = c.kind === 'no_spend' ? spent > 0 : spent > c.target_amount;
      if (status === 'active') status = broken ? 'failed' : ended ? 'done' : 'active';
    }
  }
  return { days_total: daysTotal, days_elapsed: daysElapsed, spent, logged_days: logged, status };
}

function withProgress(row, now) {
  if (!row) return null;
  const p = challengeProgress(row, now);
  if (p.status !== row.status && row.status === 'active') {
    db.prepare('UPDATE challenges SET status = ? WHERE id = ?').run(p.status, row.id);
  }
  return { ...row, ...p };
}

export function getChallenge(userId, id, now = new Date()) {
  return withProgress(db.prepare('SELECT * FROM challenges WHERE user_id = ? AND id = ?').get(String(userId), Number(id)), now);
}

/** Active challenges plus those that ended in the last 7 days (newest first), with progress. */
export function listChallenges(userId, { includeOld = false } = {}, now = new Date()) {
  const since = addDays(getDateStr(now), -7);
  return db.prepare(`
    SELECT * FROM challenges WHERE user_id = ? AND status != 'cancelled' ${includeOld ? '' : "AND (status = 'active' OR end_date >= ?)"}
    ORDER BY id DESC
  `).all(String(userId), ...(includeOld ? [] : [since])).map((r) => withProgress(r, now));
}

export function cancelChallenge(userId, id) {
  return db.prepare("UPDATE challenges SET status = 'cancelled' WHERE user_id = ? AND id = ? AND status = 'active'").run(String(userId), Number(id)).changes > 0;
}

/**
 * After an expense is saved: active no_spend/limit challenges it touches, with their new status.
 * @returns {Array<Object>}
 */
export function challengesHitBy(userId, tx, now = new Date()) {
  if (!tx || tx.type !== 'expense') return [];
  const rows = db.prepare(`
    SELECT * FROM challenges WHERE user_id = ? AND status = 'active' AND kind IN ('no_spend', 'limit') AND (category IS NULL OR category = ?)
  `).all(String(userId), tx.category);
  return rows.map((r) => withProgress(r, now));
}

/** Short label: "🚫 Tanpa makan 7 hari", "💰 Hemat belanja maks Rp 500.000 14 hari", "🔥 Catat tiap hari 30 hari". */
export function challengeTitle(c, formatRupiah) {
  const days = (c.days_total ?? dayDiff(c.start_date, c.end_date) + 1);
  if (c.kind === 'no_spend') return `🚫 Tanpa jajan ${c.category || 'apa pun'} ${days} hari`;
  if (c.kind === 'limit') return `💰 Hemat ${c.category || 'semua'} maks ${formatRupiah(c.target_amount)} dalam ${days} hari`;
  return `🔥 Catat tiap hari selama ${days} hari`;
}
