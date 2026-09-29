import db from './connection.js';

/**
 * Records a reminder sent to a user on a specific date.
 * @param {string|number} userId
 * @param {string} date YYYY-MM-DD
 * @returns {boolean}
 */
export function markReminded(userId, date) {
  const uid = String(userId);
  const targetDate = date || new Date().toISOString().slice(0, 10);

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
  const targetDate = date || new Date().toISOString().slice(0, 10);

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
  const targetDate = date || new Date().toISOString().slice(0, 10);

  const stmt = db.prepare(`
    SELECT u.user_id, u.first_name, u.username, u.timezone
    FROM users u
    LEFT JOIN transactions t ON u.user_id = t.user_id AND strftime('%Y-%m-%d', t.created_at) = ?
    LEFT JOIN reminder_log r ON u.user_id = r.user_id AND r.reminder_date = ?
    WHERE t.id IS NULL AND r.id IS NULL
  `);

  return stmt.all(targetDate, targetDate) || [];
}
