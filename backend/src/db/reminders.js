import db from './connection.js';
import { getDateStr, getDayRange } from '../utils/formatter.js';

/**
 * Records a reminder sent to a user on a specific date.
 * @param {string|number} userId
 * @param {string} date YYYY-MM-DD
 * @returns {boolean}
 */
export function markReminded(userId, date) {
  const uid = String(userId);
  const targetDate = date || getDateStr();

  const stmt = db.prepare(`
    INSERT INTO reminder_log (user_id, reminder_date, created_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id, reminder_date) DO NOTHING
  `);
  const result = stmt.run(uid, targetDate);
  return result.changes > 0;
}

/**
 * Checks if a user was already reminded on a given date.
 * @param {string|number} userId
 * @param {string} date YYYY-MM-DD
 * @returns {boolean}
 */
export function wasRemindedToday(userId, date) {
  const uid = String(userId);
  const targetDate = date || getDateStr();

  const stmt = db.prepare(`
    SELECT id FROM reminder_log
    WHERE user_id = ? AND reminder_date = ?
  `);
  const row = stmt.get(uid, targetDate);
  return !!row;
}

/**
 * Retrieves all registered users who haven't created a transaction today and haven't been reminded yet.
 * @param {string} date YYYY-MM-DD
 * @returns {Array<Object>}
 */
export function getUsersWithoutTransactionToday(date) {
  const targetDate = date || getDateStr();
  const { start, end } = getDayRange(targetDate);

  const stmt = db.prepare(`
    SELECT u.user_id, u.first_name, u.username, u.timezone
    FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.user_id = u.user_id
        AND datetime(t.created_at) >= datetime(?) AND datetime(t.created_at) < datetime(?)
    )
    AND NOT EXISTS (
      SELECT 1 FROM reminder_log r WHERE r.user_id = u.user_id AND r.reminder_date = ?
    )
  `);

  return stmt.all(start, end, targetDate) || [];
}
