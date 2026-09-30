import db from './connection.js';
import { getDateStr, getDayRange, getMonthRange, getMonthStr } from '../utils/formatter.js';

// created_at is UTC; local day/month ranges are converted to UTC bounds before comparing.
const IN_RANGE = 'datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)';

/**
 * Creates a new transaction.
 * @param {string|number} userId
 * @param {'income'|'expense'} type
 * @param {number} amount
 * @param {string} category
 * @param {string} [note='']
 * @returns {Object} Created transaction
 */
export function createTransaction(userId, type, amount, category, note = '', walletId = null) {
  const uid = String(userId);
  const cleanCat = String(category).toLowerCase().trim();
  const cleanNote = String(note || '').trim();
  const cleanAmount = parseInt(amount, 10);
  const wallet = Number.isInteger(walletId) && walletId > 0 ? walletId : null;

  const stmt = db.prepare(`
    INSERT INTO transactions (user_id, type, amount, category, note, wallet_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const result = stmt.run(uid, type, cleanAmount, cleanCat, cleanNote, wallet);
  return getTransactionById(uid, result.lastInsertRowid);
}

/**
 * Retrieves transactions for a user with pagination and optional filters.
 * @param {string|number} userId
 * @param {number} [limit=20]
 * @param {number} [offset=0]
 * @param {Object} [filters={}]
 * @param {string} [filters.type]
 * @param {string} [filters.month] YYYY-MM
 * @param {string} [filters.date] YYYY-MM-DD
 * @returns {{ data: Array<Object>, total: number }}
 */
export function getTransactionsByUser(userId, limit = 20, offset = 0, filters = {}) {
  const uid = String(userId);
  const params = [uid];
  let whereClauses = ['user_id = ?'];

  if (filters.type && ['income', 'expense'].includes(filters.type)) {
    whereClauses.push('type = ?');
    params.push(filters.type);
  }

  if (filters.month && /^\d{4}-\d{2}$/.test(filters.month)) {
    const { start, end } = getMonthRange(filters.month);
    whereClauses.push(IN_RANGE);
    params.push(start, end);
  }

  if (filters.date && /^\d{4}-\d{2}-\d{2}$/.test(filters.date)) {
    const { start, end } = getDayRange(filters.date);
    whereClauses.push(IN_RANGE);
    params.push(start, end);
  }

  const whereSql = whereClauses.join(' AND ');

  const countStmt = db.prepare(`SELECT COUNT(*) as count FROM transactions WHERE ${whereSql}`);
  const countRow = countStmt.get(...params);
  const total = countRow ? countRow.count : 0;

  const dataStmt = db.prepare(`
    SELECT t.id, t.user_id, t.type, t.amount, t.category, t.note, t.wallet_id, w.name AS wallet_name, t.created_at
    FROM transactions t LEFT JOIN wallets w ON w.id = t.wallet_id
    WHERE ${whereSql.replace(/\b(user_id|type|created_at)\b/g, 't.$1')}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ? OFFSET ?
  `);

  const data = dataStmt.all(...params, limit, offset) || [];
  return { data, total };
}

/**
 * Retrieves a single transaction by ID and user ID.
 * @param {string|number} userId
 * @param {number} id
 * @returns {Object|null}
 */
export function getTransactionById(userId, id) {
  const uid = String(userId);
  const stmt = db.prepare(`
    SELECT t.id, t.user_id, t.type, t.amount, t.category, t.note, t.wallet_id, w.name AS wallet_name, t.created_at
    FROM transactions t LEFT JOIN wallets w ON w.id = t.wallet_id
    WHERE t.id = ? AND t.user_id = ?
  `);
  const row = stmt.get(parseInt(id, 10), uid);
  return row || null;
}

/**
 * Gets the most recent transaction for a user.
 * @param {string|number} userId
 * @returns {Object|null}
 */
export function getLastTransaction(userId) {
  const uid = String(userId);
  const stmt = db.prepare(`
    SELECT id, user_id, type, amount, category, note, created_at
    FROM transactions
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 1
  `);
  const row = stmt.get(uid);
  return row || null;
}

/**
 * Deletes a transaction by ID and user ID.
 * @param {string|number} userId
 * @param {number} id
 * @returns {boolean} True if deleted, false if not found
 */
export function deleteTransaction(userId, id) {
  const uid = String(userId);
  const stmt = db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?');
  const result = stmt.run(parseInt(id, 10), uid);
  return result.changes > 0;
}

/**
 * Gets today's summary for a user.
 * @param {string|number} userId
 * @returns {{ date: string, income: number, expense: number, balance: number, count: number, by_category: Array<Object> }}
 */
export function getTodaySummary(userId) {
  const uid = String(userId);
  const todayDate = getDateStr();
  const { start, end } = getDayRange(todayDate);

  const aggStmt = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense,
      COUNT(*) as count
    FROM transactions
    WHERE user_id = ? AND ${IN_RANGE}
  `);
  const agg = aggStmt.get(uid, start, end) || { income: 0, expense: 0, count: 0 };

  const catStmt = db.prepare(`
    SELECT type, category, SUM(amount) as total, COUNT(*) as count
    FROM transactions
    WHERE user_id = ? AND ${IN_RANGE}
    GROUP BY type, category
    ORDER BY total DESC
  `);
  const by_category = catStmt.all(uid, start, end) || [];

  return {
    date: todayDate,
    income: Number(agg.income || 0),
    expense: Number(agg.expense || 0),
    balance: Number(agg.income || 0) - Number(agg.expense || 0),
    count: Number(agg.count || 0),
    by_category
  };
}

/**
 * Aggregates stats by category between startDate and endDate.
 * @param {string|number} userId
 * @param {string} startDate YYYY-MM-DD or full timestamp
 * @param {string} endDate YYYY-MM-DD or full timestamp
 * @returns {Array<Object>}
 */
export function getStatsByCategory(userId, startDate, endDate) {
  const uid = String(userId);
  const stmt = db.prepare(`
    SELECT type, category, SUM(amount) as total, COUNT(*) as count
    FROM transactions
    WHERE user_id = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?)
    GROUP BY type, category
    ORDER BY total DESC
  `);
  return stmt.all(uid, startDate, endDate) || [];
}

/**
 * Gets today's total expenses grouped by category for budget checking.
 * @param {string|number} userId
 * @returns {Array<Object>}
 */
export function getTodayExpenseByCategory(userId) {
  const uid = String(userId);
  const { start, end } = getDayRange(getDateStr());
  const stmt = db.prepare(`
    SELECT category, SUM(amount) as total
    FROM transactions
    WHERE user_id = ? AND type = 'expense' AND ${IN_RANGE}
    GROUP BY category
  `);
  return stmt.all(uid, start, end) || [];
}

/**
 * Calculates user's total expense in a specific category for the current month.
 * @param {string|number} userId
 * @param {string} category
 * @param {string} [month] YYYY-MM (defaults to current month)
 * @returns {number}
 */
export function getUserExpenseThisMonth(userId, category, month) {
  const uid = String(userId);
  const cleanCat = String(category).toLowerCase().trim();
  const { start, end } = getMonthRange(month || getMonthStr());

  const stmt = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM transactions
    WHERE user_id = ?
      AND type = 'expense'
      AND category = ?
      AND ${IN_RANGE}
  `);
  const row = stmt.get(uid, cleanCat, start, end);
  return Number(row?.total || 0);
}

/**
 * Retrieves all transactions for a user (for CSV export).
 * @param {string|number} userId
 * @returns {Array<Object>}
 */
export function getAllTransactions(userId) {
  const uid = String(userId);
  const stmt = db.prepare(`
    SELECT t.id, t.user_id, t.type, t.amount, t.category, t.note, t.wallet_id, w.name AS wallet_name, t.created_at
    FROM transactions t LEFT JOIN wallets w ON w.id = t.wallet_id
    WHERE t.user_id = ?
    ORDER BY t.created_at DESC, t.id DESC
  `);
  return stmt.all(uid) || [];
}

/**
 * All-time recorded balance: wallets' opening balances plus every income minus every expense the user has logged.
 * @param {string|number} userId
 * @returns {{ income: number, expense: number, opening: number, net: number }}
 */
export function getBalance(userId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS expense
    FROM transactions WHERE user_id = ?
  `).get(String(userId));
  const income = Number(row?.income || 0);
  const expense = Number(row?.expense || 0);
  const opening = Number(db.prepare('SELECT COALESCE(SUM(opening_balance), 0) AS n FROM wallets WHERE user_id = ?').get(String(userId)).n);
  return { income, expense, opening, net: opening + income - expense };
}
