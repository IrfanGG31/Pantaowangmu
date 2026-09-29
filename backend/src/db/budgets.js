import db from './connection.js';
import { getUserExpenseThisMonth } from './transactions.js';

/**
 * Creates or updates a budget for a given user, category, and month.
 * @param {string|number} userId
 * @param {string} category
 * @param {number} amount
 * @param {string} [month] YYYY-MM
 * @returns {Object}
 */
export function setBudget(userId, category, amount, month) {
  const uid = String(userId);
  const cleanCat = String(category).toLowerCase().trim();
  const cleanAmount = parseInt(amount, 10);
  const targetMonth = month || new Date().toISOString().slice(0, 7);

  const stmt = db.prepare(`
    INSERT INTO budgets (user_id, category, amount, month, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, category, month) DO UPDATE SET
      amount = excluded.amount
  `);
  stmt.run(uid, cleanCat, cleanAmount, targetMonth);
  return getBudget(uid, cleanCat, targetMonth);
}

/**
 * Gets a single budget with calculated spent, remaining, and percentage.
 * @param {string|number} userId
 * @param {string} category
 * @param {string} [month] YYYY-MM
 * @returns {Object|null}
 */
export function getBudget(userId, category, month) {
  const uid = String(userId);
  const cleanCat = String(category).toLowerCase().trim();
  const targetMonth = month || new Date().toISOString().slice(0, 7);

  const stmt = db.prepare(`
    SELECT id, user_id, category, amount, month, created_at
    FROM budgets
    WHERE user_id = ? AND category = ? AND month = ?
  `);
  const budget = stmt.get(uid, cleanCat, targetMonth);
  if (!budget) return null;

  const spent = getUserExpenseThisMonth(uid, cleanCat, targetMonth);
  const percentage = Math.round((spent / budget.amount) * 100);
  const remaining = budget.amount - spent;

  return {
    ...budget,
    spent,
    percentage,
    remaining
  };
}

/**
 * Gets all budgets for a user in a given month with calculated metrics.
 * @param {string|number} userId
 * @param {string} [month] YYYY-MM
 * @returns {Array<Object>}
 */
export function getBudgetsByUser(userId, month) {
  const uid = String(userId);
  const targetMonth = month || new Date().toISOString().slice(0, 7);

  const stmt = db.prepare(`
    SELECT id, user_id, category, amount, month, created_at
    FROM budgets
    WHERE user_id = ? AND month = ?
    ORDER BY id ASC
  `);
  const rows = stmt.all(uid, targetMonth) || [];

  return rows.map((b) => {
    const spent = getUserExpenseThisMonth(uid, b.category, targetMonth);
    const percentage = Math.round((spent / b.amount) * 100);
    const remaining = b.amount - spent;
    return {
      ...b,
      spent,
      percentage,
      remaining
    };
  });
}

/**
 * Deletes a budget by category and month.
 * @param {string|number} userId
 * @param {string} category
 * @param {string} [month]
 * @returns {boolean}
 */
export function deleteBudget(userId, category, month) {
  const uid = String(userId);
  const cleanCat = String(category).toLowerCase().trim();
  const targetMonth = month || new Date().toISOString().slice(0, 7);

  const stmt = db.prepare('DELETE FROM budgets WHERE user_id = ? AND category = ? AND month = ?');
  const result = stmt.run(uid, cleanCat, targetMonth);
  return result.changes > 0;
}

/**
 * Deletes a budget by its primary ID.
 * @param {string|number} userId
 * @param {number} id
 * @returns {boolean}
 */
export function deleteBudgetById(userId, id) {
  const uid = String(userId);
  const stmt = db.prepare('DELETE FROM budgets WHERE id = ? AND user_id = ?');
  const result = stmt.run(parseInt(id, 10), uid);
  return result.changes > 0;
}

/**
 * Gets a budget by its primary ID.
 * @param {string|number} userId
 * @param {number} id
 * @returns {Object|null}
 */
export function getBudgetById(userId, id) {
  const uid = String(userId);
  const stmt = db.prepare('SELECT id, user_id, category, amount, month, created_at FROM budgets WHERE id = ? AND user_id = ?');
  const row = stmt.get(parseInt(id, 10), uid);
  if (!row) return null;

  const spent = getUserExpenseThisMonth(uid, row.category, row.month);
  const percentage = Math.round((spent / row.amount) * 100);
  const remaining = row.amount - spent;

  return {
    ...row,
    spent,
    percentage,
    remaining
  };
}
