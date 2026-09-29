import db from './connection.js';

/**
 * Upserts a user in the database.
 * @param {Object} user
 * @param {string|number} user.user_id - Telegram user ID
 * @param {string} [user.first_name] - User's first name
 * @param {string} [user.username] - Telegram username
 * @param {string} [user.timezone='Asia/Jakarta'] - Preferred timezone
 * @returns {Object} Upserted user record
 */
export function upsertUser({ user_id, first_name = '', username = '', timezone = 'Asia/Jakarta' }) {
  const uid = String(user_id);
  const stmt = db.prepare(`
    INSERT INTO users (user_id, first_name, username, timezone)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username,
      timezone = excluded.timezone
  `);
  stmt.run(uid, first_name || '', username || '', timezone || 'Asia/Jakarta');
  return getUser(uid);
}

/**
 * Retrieves a user by user_id.
 * @param {string|number} userId
 * @returns {Object|null} User record or null
 */
export function getUser(userId) {
  const uid = String(userId);
  const stmt = db.prepare('SELECT user_id, first_name, username, timezone, created_at FROM users WHERE user_id = ?');
  const row = stmt.get(uid);
  return row || null;
}

/**
 * Retrieves all registered users.
 * @returns {Array<Object>} List of all users
 */
export function getAllUsers() {
  const stmt = db.prepare('SELECT user_id, first_name, username, timezone, created_at FROM users');
  return stmt.all() || [];
}
