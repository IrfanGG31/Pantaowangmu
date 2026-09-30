import db from './connection.js';
import { toSqlDateTime } from '../utils/formatter.js';

const USER_COLUMNS = 'user_id, first_name, username, timezone, created_at, plan, status, plan_expires_at, ai_daily_limit, last_active_at';

/**
 * Trial length for newly seen users. TRIAL_DAYS=0 means new users stay blocked until an admin activates them.
 * @returns {number}
 */
export function getTrialDays() {
  const raw = process.env.TRIAL_DAYS;
  const days = raw === undefined || raw === '' ? 7 : Number(raw);
  return Number.isFinite(days) && days >= 0 ? days : 7;
}

/**
 * Upserts a user in the database. New users start on the trial plan; existing plans are never touched here.
 * @param {Object} user
 * @param {string|number} user.user_id - Telegram user ID
 * @param {string} [user.first_name] - User's first name
 * @param {string} [user.username] - Telegram username
 * @param {string} [user.timezone='Asia/Jakarta'] - Preferred timezone
 * @returns {Object} Upserted user record
 */
export function upsertUser({ user_id, first_name = '', username = '', timezone = 'Asia/Jakarta' }) {
  const uid = String(user_id);
  const trialEnds = toSqlDateTime(new Date(Date.now() + getTrialDays() * 86400000));
  const stmt = db.prepare(`
    INSERT INTO users (user_id, first_name, username, timezone, plan, status, plan_expires_at)
    VALUES (?, ?, ?, ?, 'trial', 'active', ?)
    ON CONFLICT(user_id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username,
      timezone = excluded.timezone
  `);
  stmt.run(uid, first_name || '', username || '', timezone || 'Asia/Jakarta', trialEnds);
  return getUser(uid);
}

/**
 * Retrieves a user by user_id.
 * @param {string|number} userId
 * @returns {Object|null} User record or null
 */
export function getUser(userId) {
  const uid = String(userId);
  const stmt = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE user_id = ?`);
  const row = stmt.get(uid);
  return row || null;
}

/**
 * Retrieves all registered users.
 * @returns {Array<Object>} List of all users
 */
export function getAllUsers() {
  const stmt = db.prepare(`SELECT ${USER_COLUMNS} FROM users`);
  return stmt.all() || [];
}
